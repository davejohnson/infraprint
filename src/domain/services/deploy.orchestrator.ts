import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../entities/service.entity.js';
import type { Run, RunPlan, RunStep, RunReceipt } from '../entities/run.entity.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import {
  createHostingServiceCreateRecovery,
  parseHostingServiceCreateRecovery,
  type HostingBindings,
  type HostingServiceCreateRecovery,
  type IHostingAdapter,
} from '../ports/hosting.port.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { InfraTransaction, type InfraTransactionRollbackResult } from './infra.transaction.js';
import { snapshotEnvironmentBindings } from './local-state.transaction.js';

export interface DeployOptions {
  project: Project;
  environment: Environment;
  services?: Service[];
  envVars?: Record<string, string>;
  envVarsByService?: Record<string, Record<string, string>>;
  verifyHttpHealth?: boolean;
  /**
   * Configure provider resources without sourcing/building new application
   * code. Used when CI will deploy the exact commit after hv_apply succeeds.
   */
  deferProviderDeployment?: boolean;
  /** Project creation is a separate reviewed plan action during hv_apply. */
  ensureProject?: boolean;
  /** The hosting adapter to use for deployment (can be IProviderAdapter or IHostingAdapter) */
  adapter: IProviderAdapter | IHostingAdapter;
}

export interface DeployResult {
  run: Run;
  success: boolean;
  urls: string[];
  serviceUrls: Record<string, string>;
  primaryUrl?: string;
  errors: string[];
  createdResources?: Array<{ provider: string; type: string; id?: string; name?: string; metadata?: Record<string, unknown> }>;
  rollback?: InfraTransactionRollbackResult;
}

interface HttpHealthResult {
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
}

/**
 * Imperative deploy engine. This is the escape hatch OUTSIDE the
 * spec -> plan -> apply loop: hv_deploy and hv_rollback drive it directly,
 * and executeBootstrap (the hv_apply converge pass) delegates the actual
 * service deploys to it. It builds its own RunPlan and does not consult
 * spec revisions — model durable infrastructure changes in the spec and
 * reconcile via hv_plan/hv_apply instead of adding steps here.
 */
export class DeployOrchestrator {
  private runRepo = new RunRepository();
  private envRepo = new EnvironmentRepository();
  private serviceRepo = new ServiceRepository();
  private auditRepo = new AuditRepository();

  buildPlan(options: DeployOptions): RunPlan {
    const steps: RunStep[] = [];

    // Project creation is explicit in plan/apply. Direct deploy callers retain
    // the historical default so their existing contract remains intact.
    if (options.ensureProject !== false) {
      steps.push({
        name: 'ensure_project',
        action: 'ensureProject',
        target: options.project.name,
        params: { projectId: options.project.id },
      });
    }

    // Set environment variables if provided. Only key NAMES go into
    // the persisted plan — runs.plan is returned verbatim by hv_runs, so
    // values (which include DATABASE_URL and resolved secrets) must never
    // be stored. The step reads the live options.envVars at execution time.
    if ((options.envVars && Object.keys(options.envVars).length > 0) || (options.envVarsByService && Object.keys(options.envVarsByService).length > 0)) {
      steps.push({
        name: 'set_env_vars',
        action: 'setEnvVars',
        params: {
          envVarKeys: Object.keys(options.envVars ?? {}).sort(),
          ...(options.envVarsByService && Object.keys(options.envVarsByService).length > 0
            ? { serviceEnvVarKeys: Object.fromEntries(Object.entries(options.envVarsByService).map(([name, vars]) => [name, Object.keys(vars).sort()])) }
            : {}),
        },
      });
    }

    // Deploy each workload. Services remain the storage primitive, but
    // workloadKind drives provider behavior and plan semantics.
    const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);
    for (const service of services) {
      const workloadKind = serviceWorkloadKind(service);
      const isCron = workloadKind === 'cron';
      steps.push({
        name: `${isCron ? 'deploy_cron' : 'deploy'}_${service.name}`,
        action: isCron ? 'deployCron' : 'deploy',
        target: service.name,
        params: { serviceId: service.id, workloadKind },
      });
    }

    // Health belongs to the later exact-SHA CI deployment when provider
    // deployment is intentionally deferred.
    if (!options.deferProviderDeployment) {
      steps.push({
        name: 'verify_health',
        action: 'verifyHealth',
      });
    }

    return {
      steps,
      metadata: {
        projectId: options.project.id,
        environmentId: options.environment.id,
        serviceCount: services.length,
        ...(options.deferProviderDeployment ? { deploymentDeferralRequested: true } : {}),
      },
    };
  }

  async execute(options: DeployOptions): Promise<DeployResult> {
    const plan = this.buildPlan(options);
    const urls: string[] = [];
    const serviceUrls: Record<string, string> = {};
    const errors: string[] = [];
    const tx = new InfraTransaction();
    const pendingServiceCreateRecoveries = new Map<string, HostingServiceCreateRecovery>();

    // Create run record
    const run = this.runRepo.create({
      projectId: options.project.id,
      environmentId: options.environment.id,
      type: 'deploy',
      plan,
    });

    // Start run
    this.runRepo.updateStatus(run.id, 'running');

    this.auditRepo.create({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: run.id,
      details: {
        projectId: options.project.id,
        environmentId: options.environment.id,
      },
    });

    try {
      for (const step of plan.steps) {
        const receipt = await this.executeStep(step, options, tx);
        if (receipt.status === 'failure' && typeof receipt.result?.service === 'string') {
          const recovery = parseHostingServiceCreateRecovery(receipt.result.serviceCreateRecovery);
          if (recovery) {
            pendingServiceCreateRecoveries.set(receipt.result.service, recovery);
          }
        }
        this.runRepo.addReceipt(run.id, receipt);

        if (receipt.status === 'failure') {
          errors.push(receipt.error ?? `Step ${step.name} failed`);
          break;
        }

        if (receipt.result?.url) {
          const url = receipt.result.url as string;
          urls.push(url);
          if (typeof receipt.result.service === 'string') {
            serviceUrls[receipt.result.service] = url;
          }
        }
      }

      const hasErrors = errors.length > 0;
      let rollback: InfraTransactionRollbackResult | undefined;
      if (hasErrors) {
        rollback = await tx.rollback();
        const recoveryPersistenceError = this.persistServiceCreateRecoveries(
          options.environment.id,
          pendingServiceCreateRecoveries
        );
        if (recoveryPersistenceError) errors.push(recoveryPersistenceError);
      }
      this.runRepo.updateStatus(
        run.id,
        hasErrors ? 'failed' : 'succeeded',
        hasErrors ? errors.join('; ') : undefined
      );

      this.auditRepo.create({
        action: hasErrors ? 'deploy.failed' : 'deploy.succeeded',
        resourceType: 'run',
        resourceId: run.id,
        details: { urls, errors },
      });

      return {
        run: this.runRepo.findById(run.id)!,
        success: !hasErrors,
        urls,
        serviceUrls,
        primaryUrl: urls[0],
        errors,
        createdResources: tx.listResources(),
        rollback,
      };
    } catch (error) {
      const rollback = await tx.rollback();
      const recoveryPersistenceError = this.persistServiceCreateRecoveries(
        options.environment.id,
        pendingServiceCreateRecoveries
      );
      const caughtErrors = [String(error), ...(recoveryPersistenceError ? [recoveryPersistenceError] : [])];
      this.runRepo.updateStatus(run.id, 'failed', caughtErrors.join('; '));

      this.auditRepo.create({
        action: 'deploy.failed',
        resourceType: 'run',
        resourceId: run.id,
        details: { error: caughtErrors.join('; ') },
      });

      return {
        run: this.runRepo.findById(run.id)!,
        success: false,
        urls,
        serviceUrls,
        primaryUrl: urls[0],
        errors: [...errors, ...caughtErrors],
        createdResources: tx.listResources(),
        rollback,
      };
    }
  }

  /**
   * Rollback restores the pre-run environment snapshot. A create whose result
   * is unresolved or only partially identified must survive that rollback so
   * a later deploy cannot issue a second create. Recovery markers are hints,
   * not normal service bindings or deletion authority.
   */
  private persistServiceCreateRecoveries(
    environmentId: string,
    recoveries: ReadonlyMap<string, HostingServiceCreateRecovery>
  ): string | undefined {
    if (recoveries.size === 0) return undefined;
    try {
      const environment = this.envRepo.findById(environmentId);
      if (!environment) {
        return `Failed to retain service-create recovery state: environment ${environmentId} is missing.`;
      }
      const rawRecovery = (environment.platformBindings as Record<string, unknown>).serviceCreateRecovery;
      const currentRecovery = rawRecovery && typeof rawRecovery === 'object' && !Array.isArray(rawRecovery)
        ? { ...(rawRecovery as Record<string, unknown>) }
        : {};
      for (const [serviceName, recovery] of recoveries) {
        currentRecovery[serviceName] = recovery;
      }
      const updated = this.envRepo.updatePlatformBindings(environmentId, {
        serviceCreateRecovery: currentRecovery,
      });
      return updated
        ? undefined
        : `Failed to retain service-create recovery state for environment ${environmentId}.`;
    } catch (error) {
      return `Failed to retain service-create recovery state for environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private validateServiceCreateRecovery(input: {
    value: unknown;
    adapterName: string;
    bindings: Partial<HostingBindings>;
    receiptEnvironmentId?: string;
    externalId?: string;
  }): { recovery?: HostingServiceCreateRecovery; error?: string } {
    if (input.value === undefined) return {};
    const recovery = parseHostingServiceCreateRecovery(input.value);
    if (!recovery) {
      return { error: 'Provider returned malformed service-create recovery state; it was not accepted as a binding.' };
    }
    if (recovery.provider !== input.adapterName) {
      return { error: `Provider returned service-create recovery state for ${recovery.provider}, not ${input.adapterName}; it was not accepted as a binding.` };
    }

    const expectedProjectId = typeof input.bindings.projectId === 'string'
      && input.bindings.projectId.trim().length > 0
      ? input.bindings.projectId
      : undefined;
    const expectedEnvironmentId = typeof input.receiptEnvironmentId === 'string'
      && input.receiptEnvironmentId.trim().length > 0
      ? input.receiptEnvironmentId
      : typeof input.bindings.environmentId === 'string'
        && input.bindings.environmentId.trim().length > 0
        ? input.bindings.environmentId
        : undefined;
    if ((expectedProjectId && recovery.providerScope.projectId !== expectedProjectId)
      || (expectedEnvironmentId && recovery.providerScope.environmentId !== expectedEnvironmentId)) {
      return { error: 'Provider returned service-create recovery state for a different project or environment; it was not accepted as a binding.' };
    }

    const externalId = typeof input.externalId === 'string' && input.externalId.trim().length > 0
      ? input.externalId
      : undefined;
    if (recovery.serviceId !== externalId) {
      return { error: 'Provider returned inconsistent service-create recovery identity; it was not accepted as a binding.' };
    }
    return { recovery };
  }

  private async executeStep(step: RunStep, options: DeployOptions, tx: InfraTransaction): Promise<RunReceipt> {
    const timestamp = new Date().toISOString();

    try {
      switch (step.action) {
        case 'ensureProject': {
          const receipt = await options.adapter.ensureProject(
            options.project.name,
            options.environment
          );

          // Update environment bindings if we got a project ID
          // Use platform-agnostic keys that work with any hosting provider
          if (receipt.success && receipt.data?.projectId) {
            const currentEnvironment = this.envRepo.findById(options.environment.id) ?? options.environment;
            const currentBindings = currentEnvironment.platformBindings as Partial<HostingBindings>;
            const nextProjectId = receipt.data.projectId as string;
            const projectChanged = Boolean(currentBindings.projectId && currentBindings.projectId !== nextProjectId);
            const bindings: Partial<HostingBindings> = {
              provider: options.adapter.name,
              projectId: nextProjectId,
            };

            // Also store environment ID if provided
            if (receipt.data.environmentId) {
              bindings.environmentId = receipt.data.environmentId as string;
            }
            // If provider project was recreated/switched, drop stale service/environment bindings.
            if (projectChanged || receipt.data?.created === true) {
              bindings.services = undefined;
              if (!receipt.data.environmentId) {
                bindings.environmentId = undefined;
              }
            }

            snapshotEnvironmentBindings({
              tx,
              envRepo: this.envRepo,
              environmentId: options.environment.id,
              label: 'environment_bindings_ensure_project',
            });
            this.envRepo.updatePlatformBindings(options.environment.id, bindings);
            const refreshed = this.envRepo.findById(options.environment.id);
            if (refreshed) {
              options.environment = refreshed;
            }

            if (receipt.data?.created === true) {
              const createdProjectId = receipt.data.projectId as string;
              tx.addStep({
                id: `provider-project:${createdProjectId}`,
                label: 'ensure_project',
                resource: {
                  provider: options.adapter.name,
                  type: 'project',
                  id: createdProjectId,
                  name: (receipt.data.projectName as string | undefined) ?? options.project.name,
                },
                compensate: async () => {
                  const adapterWithDelete = options.adapter as (IProviderAdapter | IHostingAdapter) & {
                    deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
                  };
                  if (typeof adapterWithDelete.deleteProject !== 'function') {
                    return {
                      success: false,
                      error: `Manual cleanup required: ${options.adapter.name} project ${createdProjectId}`,
                    };
                  }
                  const result = await adapterWithDelete.deleteProject(createdProjectId);
                  return {
                    success: result.success,
                    error: result.error,
                    message: result.success ? `Deleted provider project ${createdProjectId}` : undefined,
                  };
                },
              });
            }
          }

          return {
            step: step.name,
            status: receipt.success ? 'success' : 'failure',
            result: receipt.data,
            error: receipt.error,
            timestamp,
          };
        }

        case 'setEnvVars': {
          const vars = options.envVars ?? {};
          if (Object.keys(vars).length === 0 && Object.keys(options.envVarsByService ?? {}).length === 0) {
            return {
              step: step.name,
              status: 'skipped',
              timestamp,
            };
          }

          const environment = this.envRepo.findById(options.environment.id) ?? options.environment;
          const bindings = environment.platformBindings as Partial<HostingBindings>;
          const boundServices = bindings.services ?? {};
          const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);
          const alreadyDeployed = services.filter((s) => Boolean(boundServices[s.name]?.serviceId));

          if (alreadyDeployed.length === 0) {
            return {
              step: step.name,
              status: 'skipped',
              result: { reason: 'No existing deployed services to pre-sync env vars' },
              timestamp,
            };
          }

          const failures: string[] = [];
          const skippedStaleBindings: string[] = [];
          let runtimeRolloutRequired = false;
          const rolloutBaselines: Record<string, unknown> = {};
          for (const service of alreadyDeployed) {
            const serviceVars = { ...vars, ...(options.envVarsByService?.[service.name] ?? {}) };
            if (Object.keys(serviceVars).length === 0) continue;
            const receipt = options.deferProviderDeployment
              ? await options.adapter.setEnvVars(
                environment,
                service,
                serviceVars,
                { deferDeployment: true }
              )
              : await options.adapter.setEnvVars(environment, service, serviceVars);
            if (!receipt.success) {
              if ((receipt.data as Record<string, unknown> | undefined)?.staleBinding === true) {
                skippedStaleBindings.push(service.name);
                continue;
              }
              failures.push(`${service.name}: ${receipt.error ?? receipt.message}`);
            } else if (receipt.data?.runtimeRolloutRequired === true) {
              runtimeRolloutRequired = true;
              const rolloutBaseline = receipt.data.rolloutBaseline;
              if (rolloutBaseline && typeof rolloutBaseline === 'object' && !Array.isArray(rolloutBaseline)) {
                rolloutBaselines[service.name] = rolloutBaseline;
              }
            }
          }

          return {
            step: step.name,
            status: failures.length > 0 ? 'failure' : 'success',
            result: {
              serviceCount: alreadyDeployed.length,
              variableCount: Object.keys(vars).length,
              serviceVariableCount: Object.values(options.envVarsByService ?? {}).reduce((count, serviceVars) => count + Object.keys(serviceVars).length, 0),
              ...(options.deferProviderDeployment ? { deploymentDeferred: true } : {}),
              ...(runtimeRolloutRequired ? { runtimeRolloutRequired: true } : {}),
              ...(Object.keys(rolloutBaselines).length > 0 ? { rolloutBaselines } : {}),
              ...(skippedStaleBindings.length > 0 ? { skippedStaleBindings } : {}),
            },
            error: failures.length > 0 ? failures.join('; ') : undefined,
            timestamp,
          };
        }

        case 'deploy':
        case 'deployCron': {
          const service = this.serviceRepo.findById(step.params?.serviceId as string);
          if (!service) {
            return {
              step: step.name,
              status: 'failure',
              error: `Service not found: ${step.params?.serviceId}`,
              timestamp,
            };
          }

          const environment = this.envRepo.findById(options.environment.id) ?? options.environment;
          const serviceEnvVars = {
            ...(options.envVars ?? {}),
            ...(options.envVarsByService?.[service.name] ?? {}),
          };
          const result = options.deferProviderDeployment
            ? await options.adapter.deploy(
              service,
              environment,
              serviceEnvVars,
              { deferDeployment: true }
            )
            : await options.adapter.deploy(service, environment, serviceEnvVars);

          const externalId = typeof result.externalId === 'string'
            && result.externalId.trim().length > 0
            ? result.externalId
            : undefined;
          const deployData = (result.receipt.data ?? {}) as Record<string, unknown>;
          const receiptEnvironmentId = typeof deployData.environmentId === 'string'
            && deployData.environmentId.trim().length > 0
            ? deployData.environmentId
            : undefined;

          // A provider-reported success without an exact, non-empty identity
          // cannot become a successful deploy or a normal service binding.
          const deploySucceeded = result.receipt.success && Boolean(externalId);

          // Update environment bindings with service info using platform-agnostic structure.
          // Failed receipts may carry an id only as partial recovery evidence;
          // they never grant normal binding or rollback-deletion authority.
          if (deploySucceeded && externalId) {
            const latestEnvironment = this.envRepo.findById(options.environment.id) ?? environment;
            const currentBindings = latestEnvironment.platformBindings as Partial<HostingBindings>;
            const services = { ...(currentBindings.services ?? {}) };
            const existingServiceBinding = services[service.name] ?? {};
            services[service.name] = {
              ...existingServiceBinding,
              serviceId: externalId,
              url: result.url ?? existingServiceBinding.url,
              workloadKind: serviceWorkloadKind(service),
            };
            if (typeof deployData.imageUri === 'string') {
              services[service.name].imageUri = deployData.imageUri;
            }
            for (const key of ['resourceType', 'jobName', 'schedulerJobName'] as const) {
              if (typeof deployData[key] === 'string') {
                services[service.name][key] = deployData[key];
              }
            }
            const currentRecoveries = { ...(currentBindings.serviceCreateRecovery ?? {}) };
            delete currentRecoveries[service.name];
            const bindingUpdates: Partial<HostingBindings> = {
              provider: options.adapter.name,
              services,
              serviceCreateRecovery: Object.keys(currentRecoveries).length > 0
                ? currentRecoveries
                : undefined,
            };
            if (receiptEnvironmentId) {
              bindingUpdates.environmentId = receiptEnvironmentId;
            }
            snapshotEnvironmentBindings({
              tx,
              envRepo: this.envRepo,
              environmentId: options.environment.id,
              label: `environment_bindings_deploy_${service.name}`,
            });
            this.envRepo.updatePlatformBindings(options.environment.id, bindingUpdates);

            const createdService = result.receipt.data?.createdService === true || result.receipt.data?.created === true;
            if (createdService) {
              const createdServiceId = externalId;
              tx.addStep({
                id: `provider-service:${createdServiceId}`,
                label: `deploy_${service.name}`,
                resource: {
                  provider: options.adapter.name,
                  type: 'service',
                  id: createdServiceId,
                  name: service.name,
                },
                compensate: async () => {
                  const adapterWithDelete = options.adapter as (IProviderAdapter | IHostingAdapter) & {
                    deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string }>;
                  };
                  if (typeof adapterWithDelete.deleteService !== 'function') {
                    return {
                      success: false,
                      error: `Manual cleanup required: ${options.adapter.name} service ${createdServiceId}`,
                    };
                  }
                  const deleted = await adapterWithDelete.deleteService(createdServiceId);
                  return {
                    success: deleted.success,
                    error: deleted.error,
                    message: deleted.success ? `Deleted provider service ${createdServiceId}` : undefined,
                  };
                },
              });
            }
          }

          const currentBindings = (this.envRepo.findById(options.environment.id) ?? environment)
            .platformBindings as Partial<HostingBindings>;
          const recoveryValidation = result.receipt.success
            ? {}
            : this.validateServiceCreateRecovery({
                value: deployData.serviceCreateRecovery,
                adapterName: options.adapter.name,
                bindings: currentBindings,
                receiptEnvironmentId,
                externalId,
              });
          let serviceCreateRecovery = recoveryValidation.recovery;
          let recoveryValidationError = recoveryValidation.error;
          const serviceCreateMayHaveCommitted = (result.receipt.success && !externalId)
            || (!result.receipt.success && (
              (deployData.phase === 'serviceCreate' && deployData.mutationAttempted !== false)
              || deployData.createdService === true
              || deployData.created === true
            ));
          if (!serviceCreateRecovery && serviceCreateMayHaveCommitted) {
            const providerScope: Record<string, string> = {};
            if (typeof currentBindings.projectId === 'string' && currentBindings.projectId.trim()) {
              providerScope.projectId = currentBindings.projectId;
            }
            if (receiptEnvironmentId) {
              providerScope.environmentId = receiptEnvironmentId;
            } else if (typeof currentBindings.environmentId === 'string' && currentBindings.environmentId.trim()) {
              providerScope.environmentId = currentBindings.environmentId;
            }
            try {
              serviceCreateRecovery = createHostingServiceCreateRecovery({
                provider: options.adapter.name,
                resourceName: service.name,
                providerScope,
                state: externalId ? 'mismatched' : 'unresolved',
                ...(externalId ? { serviceId: externalId } : {}),
              });
              recoveryValidationError = [
                recoveryValidationError,
                'Hypervibe retained a conservative service-create blocker because the provider reported a possibly committed create without trustworthy recovery state.',
              ].filter(Boolean).join(' ');
            } catch {
              recoveryValidationError = [
                recoveryValidationError,
                'Provider reported a possibly committed service create, but Hypervibe could not derive complete provider scope for a durable recovery blocker.',
              ].filter(Boolean).join(' ');
            }
          }
          const missingSuccessIdentityError = result.receipt.success && !externalId
            ? `Provider ${options.adapter.name} reported a successful deploy for ${service.name} without a valid service id; Hypervibe refused to bind it.`
            : undefined;
          const receiptError = [
            result.receipt.error,
            recoveryValidationError,
            missingSuccessIdentityError,
          ].filter((value): value is string => Boolean(value)).join('; ') || undefined;

          return {
            step: step.name,
            status: deploySucceeded ? 'success' : 'failure',
            result: {
              service: service.name,
              url: result.url,
              publicUrl: result.url,
              externalId,
              ...(serviceCreateRecovery
                ? { serviceCreateRecovery }
                : {}),
              ...(result.receipt.data?.deploymentDeferred === true ? { deploymentDeferred: true } : {}),
              ...(result.receipt.data?.runtimeRolloutRequired === true
                ? { runtimeRolloutRequired: true }
                : {}),
              ...(result.receipt.data?.rolloutBaseline
                ? { rolloutBaseline: result.receipt.data.rolloutBaseline }
                : {}),
            },
            error: receiptError,
            timestamp,
          };
        }

        case 'verifyHealth': {
          if (typeof options.adapter.getDeployStatus !== 'function') {
            return {
              step: step.name,
              status: 'skipped',
              result: { reason: 'Provider does not support deploy status checks' },
              timestamp,
            };
          }

          const environment = this.envRepo.findById(options.environment.id) ?? options.environment;
          const bindings = environment.platformBindings as Partial<HostingBindings>;
          const services = options.services ?? this.serviceRepo.findByProjectId(options.project.id);

          const failures: string[] = [];
          const pending: string[] = [];
          const health: Array<{ service: string; status: string; url?: string; http?: HttpHealthResult }> = [];

          for (const service of services) {
            const serviceBinding = bindings.services?.[service.name];
            const deployTarget = serviceBinding?.serviceId;
            if (!deployTarget) {
              continue;
            }

            const check = await this.waitForHealthyDeployment(options, environment, deployTarget);
            const url = check.url ?? serviceBinding?.url;
            const entry: { service: string; status: string; url?: string; http?: HttpHealthResult } = {
              service: service.name,
              status: check.status,
              url,
            };

            if (check.status === 'failed' || check.status === 'canceled' || check.status === 'cancelled') {
              failures.push(`${service.name}: status=${check.status}`);
            } else if (check.status !== 'deployed') {
              pending.push(`${service.name}: status=${check.status}`);
            } else if (options.verifyHttpHealth === true && serviceWorkloadKind(service) === 'web' && service.buildConfig.healthCheckPath) {
              if (!url) {
                pending.push(`${service.name}: deployed but no URL is available for ${service.buildConfig.healthCheckPath}`);
              } else {
                const http = await this.checkHttpHealth(url, service.buildConfig.healthCheckPath);
                entry.http = http;
                if (!http.ok) {
                  const detail = http.status ? `HTTP ${http.status}` : http.error ?? 'request failed';
                  failures.push(`${service.name}: ${detail} at ${http.url}`);
                }
              }
            }
            health.push(entry);
          }

          const warning = pending.length > 0
            ? `Health check inconclusive for ${pending.join(', ')}`
            : undefined;

          return {
            step: step.name,
            status: failures.length > 0 ? 'failure' : 'success',
            result: { services: health, warning },
            error: failures.length > 0
              ? `Health check failed for ${failures.join(', ')}`
              : undefined,
            timestamp,
          };
        }

        default:
          return {
            step: step.name,
            status: 'skipped',
            error: `Unknown action: ${step.action}`,
            timestamp,
          };
      }
    } catch (error) {
      return {
        step: step.name,
        status: 'failure',
        error: String(error),
        timestamp,
      };
    }
  }

  private async waitForHealthyDeployment(
    options: DeployOptions,
    environment: Environment,
    deployTarget: string
  ): Promise<{ status: string; url?: string | undefined }> {
    if (typeof options.adapter.getDeployStatus !== 'function') {
      return { status: 'unknown' };
    }

    const maxAttempts = 8;
    const pollDelayMs = 2000;
    let last: { status: string; url?: string | undefined } = { status: 'unknown', url: undefined };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = await options.adapter.getDeployStatus(environment, deployTarget);

      if (last.status === 'deployed') {
        return last;
      }
      if (last.status === 'failed' || last.status === 'canceled' || last.status === 'cancelled') {
        return last;
      }

      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    }

    return last;
  }

  private buildHealthUrl(baseUrl: string, healthCheckPath: string): string {
    const path = healthCheckPath.trim() || '/';
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(path, normalizedBase).toString();
  }

  private async checkHttpHealth(baseUrl: string, healthCheckPath: string): Promise<HttpHealthResult> {
    let url: string;
    try {
      url = this.buildHealthUrl(baseUrl, healthCheckPath);
    } catch (error) {
      return {
        ok: false,
        url: `${baseUrl}${healthCheckPath}`,
        error: `Invalid health check URL: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (response.ok) {
        return { ok: true, url, status: response.status };
      }
      const body = await response.text().catch(() => '');
      const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 200);
      return {
        ok: false,
        url,
        status: response.status,
        ...(excerpt ? { error: excerpt } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        url,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
