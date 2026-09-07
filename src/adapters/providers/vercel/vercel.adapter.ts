import { createHash } from 'crypto';
import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  serviceWorkloadKind,
  type Service,
} from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type {
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../../domain/ports/maintenance.port.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import type {
  ComponentResult,
  DeploymentMutationOptions,
  DeployResult,
  IProviderAdapter,
  ProviderCapabilities,
  Receipt,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { providerRegistry, type ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import { environmentForInspection } from '../../../domain/registry/provider-inspection.js';
import {
  VercelClient,
  type VercelDomainConfig,
  type VercelDeployment,
  type VercelEnvironmentVariable,
  type VercelProject,
  type VercelProjectDomain,
} from './vercel.client.js';
import {
  buildVercelGitHubActionsSteps,
  VERCEL_CI_REQUIRED_SECRETS,
} from './vercel-ci.workflow.js';
import { buildVercelPortableRecipe } from './vercel-ci.recipe.js';
import {
  VercelCredentialsSchema,
  type VercelCredentials,
} from './vercel.credentials.js';
import {
  formatVercelScopeBinding,
  formatVercelServiceBinding,
  parseVercelServiceBinding,
  type VercelServiceBinding,
} from './vercel.binding.js';

const START_COMMAND_KEY = 'HYPERVIBE_START_COMMAND';
const HEALTH_CHECK_PATH_KEY = 'HYPERVIBE_HEALTH_CHECK_PATH';
const INTERNAL_ENV_KEYS = new Set([
  HEALTH_CHECK_PATH_KEY,
]);
const RESERVED_ENV_KEYS = new Set([
  START_COMMAND_KEY,
  ...INTERNAL_ENV_KEYS,
]);
const ENV_COMMENT = 'Managed by Hypervibe';

interface VercelScope {
  kind: 'team' | 'user';
  id: string;
  binding: string;
  label: string;
  email?: string;
}

interface ObservedVercelService {
  service: ObservedService;
  unknownKeys: string[];
}

interface ResolvedVercelMaintenanceProject {
  binding: VercelServiceBinding;
  project: VercelProject;
  scope: VercelScope;
}

interface VercelMaintenanceUrl {
  kind: 'custom' | 'direct';
  url: string;
}

export class VercelAdapter implements IProviderAdapter {
  readonly name = 'vercel';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['buildpack', 'static'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    supportsDeferredDeploy: true,
    supportsMaintenance: true,
  };

  private credentials: VercelCredentials | null = null;
  private client: VercelClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = VercelCredentialsSchema.parse(credentials);
    this.client = new VercelClient(this.credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const [scope] = await Promise.all([
        this.scope(),
        this.client.listProjects(),
      ]);
      return {
        success: true,
        ...(scope.email ? { email: scope.email } : {}),
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
  }

  async ensureProject(
    _projectName: string,
    environment: Environment
  ): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const scope = await this.scope();
      const boundId = parseHostingBindings(environment).projectId;
      if (boundId && boundId !== scope.binding) {
        return {
          success: false,
          message: 'Failed to bind Vercel account scope',
          error: `The environment is bound to Vercel scope ${boundId}, but the verified token targets ${scope.binding}. Hypervibe will not silently rebind it.`,
        };
      }
      return {
        success: true,
        message: `Using existing Vercel ${scope.kind}: ${scope.label}`,
        data: {
          projectId: scope.binding,
          projectName: scope.label,
          created: false,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to verify Vercel account scope',
        error: this.formatError(error),
      };
    }
  }

  async ensureComponent(
    type: ComponentType,
    environment: Environment
  ): Promise<ComponentResult> {
    return {
      component: {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: {
        success: false,
        message: 'Vercel Marketplace datastores require their own lifecycle provider.',
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const serviceError = this.validateService(service);
    if (serviceError) return this.failedDeploy(service, serviceError);

    const bindings = parseHostingBindings(environment);
    let scope: VercelScope;
    try {
      scope = await this.assertScopeBinding(bindings.projectId);
    } catch (error) {
      return this.failedDeploy(service, this.formatError(error));
    }

    const expectedName = this.serviceProjectName(environment, service.name);
    const existingBinding = bindings.services?.[service.name]?.serviceId;
    let project: VercelProject | null = null;
    let createdService = false;
    let createAttempted = false;
    let attemptedProjectId: string | undefined;
    try {
      if (existingBinding) {
        const binding = parseVercelServiceBinding(existingBinding);
        this.assertServiceScopeBinding(binding.scope.binding, scope);
        project = await this.client.getProject(binding.projectId);
        if (!project) {
          return this.failedDeploy(
            service,
            `Bound Vercel project ${binding.projectId} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertProjectScope(project, scope);
      } else {
        const matches = (await this.client.listProjects())
          .filter((candidate) => candidate.name === expectedName);
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `Vercel project name "${expectedName}" is already present: ${matches
                .map((candidate) => candidate.id)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Use hv_import for the intended project or remove the conflict, then run hv_plan again.',
            ].join(' ')
          );
        }
        createAttempted = true;
        project = await this.client.createProject(expectedName);
        attemptedProjectId = project.id;
        createdService = true;
        this.assertProjectScope(project, scope);
        if (project.name !== expectedName) {
          throw new Error(
            `Vercel returned project ${project.id} outside the reviewed name identity.`
          );
        }
      }

      attemptedProjectId = project.id;
      if (project.link) {
        return this.failedDeploy(
          service,
          `Bound Vercel project ${project.id} has a native Git source. Disconnect it in Vercel and re-run hv_plan before Hypervibe manages exact-SHA CI deployments.`
        );
      }
      await this.syncProjectEnvironmentVariables(project, service, envVars);
      const latest = await this.latestDeployment(project.id);
      const url = latest?.url ? this.deploymentUrl(latest.url) : undefined;
      const serviceBinding = formatVercelServiceBinding(
        scope.binding,
        project.id
      );
      return {
        serviceId: service.id,
        externalId: serviceBinding,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared Vercel project for exact-SHA CI deployment: ${project.name}`
            : `Configured source-less Vercel project; an exact-SHA CI deployment is still required: ${project.name}`,
          data: {
            serviceId: serviceBinding,
            vercelProjectId: project.id,
            serviceName: project.name,
            resourceType: 'web',
            createdService,
            deploymentDeferred: true,
            runtimeRolloutRequired: true,
            rolloutBaseline: latest
              ? { state: 'present', deploymentId: latest.uid }
              : { state: 'absent' },
            pendingDeployment: !latest,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        createAttempted || attemptedProjectId
          ? {
              ...(attemptedProjectId
                ? {
                    externalId: formatVercelServiceBinding(
                      scope.binding,
                      attemptedProjectId
                    ),
                  }
                : {}),
              createdService,
              mutationAttempted: true,
            }
          : undefined
      );
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    _options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    const serviceId = parseHostingBindings(environment)
      .services?.[service.name]?.serviceId;
    if (!this.client || !serviceId) {
      return {
        success: false,
        message: 'Failed to update Vercel environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Vercel service binding exists for ${service.name}.`,
        data: { staleBinding: !serviceId },
      };
    }
    try {
      const scope = await this.assertScopeBinding(
        parseHostingBindings(environment).projectId
      );
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) {
        return {
          success: false,
          message: 'Failed to update Vercel environment variables',
          error: `Bound Vercel project ${binding.projectId} was not found.`,
          data: { staleBinding: true },
        };
      }
      this.assertProjectScope(project, scope);
      await this.syncProjectEnvironmentVariables(project, service, vars);
      const latest = await this.latestDeployment(project.id);
      return {
        success: true,
        message: `Updated production Vercel environment variables for ${service.name}`,
        data: {
          serviceId,
          variableCount: Object.keys(this.runtimeEnvVars(vars)).length,
          deploymentDeferred: true,
          runtimeRolloutRequired: true,
          rolloutBaseline: latest
            ? { state: 'present', deploymentId: latest.uid }
            : { state: 'absent' },
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Vercel environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    const bindings = parseHostingBindings(environment);
    const serviceId = bindings.services?.[service.name]?.serviceId;
    if (!this.client || !serviceId) {
      return {
        success: false,
        message: 'Failed to delete Vercel environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Vercel service binding exists for ${service.name}.`,
      };
    }
    const retired = Array.from(new Set(keys))
      .filter((key) => !RESERVED_ENV_KEYS.has(key))
      .sort();
    try {
      const scope = await this.assertScopeBinding(bindings.projectId);
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) {
        return {
          success: false,
          message: 'Failed to delete Vercel environment variables',
          error: `Bound Vercel project ${binding.projectId} was not found.`,
          data: { staleBinding: true },
        };
      }
      this.assertProjectScope(project, scope);
      let variables = await this.client.listProjectEnvironmentVariables(
        binding.projectId
      );
      const deletedKeys: string[] = [];
      let baselineDeployment: VercelDeployment | undefined;
      for (const key of retired) {
        const matches = this.productionVariables(variables, key);
        this.assertSingleVariableIdentity(key, matches);
        const match = matches[0];
        if (!match) continue;
        this.assertMutableVariable(key, match);
        if (!match.id) {
          throw new Error(
            `Vercel environment variable ${key} has no durable ID; Hypervibe refused an ambiguous deletion.`
          );
        }
        if (deletedKeys.length === 0) {
          baselineDeployment = await this.latestDeployment(project.id);
        }
        await this.client.deleteProjectEnvironmentVariable(
          binding.projectId,
          match.id
        );
        deletedKeys.push(key);
        variables = variables.filter((candidate) => candidate !== match);
      }

      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_VERCEL_ENV_DELETE_ATTEMPTS',
        30
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_VERCEL_ENV_DELETE_DELAY_MS',
        1000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const observed = await this.client.listProjectEnvironmentVariables(
          binding.projectId
        );
        const remaining = retired.filter(
          (key) => this.productionVariables(observed, key).length > 0
        );
        if (remaining.length === 0) {
          return {
            success: true,
            message: `Deleted explicitly retired production Vercel environment variables for ${service.name}`,
            data: {
              serviceId,
              deletedKeys,
              ...(deletedKeys.length > 0
                ? {
                    deploymentDeferred: true,
                    runtimeRolloutRequired: true,
                    rolloutBaseline: baselineDeployment
                      ? { state: 'present', deploymentId: baselineDeployment.uid }
                      : { state: 'absent' },
                  }
                : {}),
            },
          };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        message: 'Failed to delete Vercel environment variables',
        error: `Vercel project ${binding.projectId} still reports retired environment variable names after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Vercel environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteService(
    serviceId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const scope = await this.scope();
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) return { success: true };
      this.assertProjectScope(project, scope);
      await this.client.deleteProject(binding.projectId);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_VERCEL_PROJECT_DELETE_ATTEMPTS',
        120
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_VERCEL_PROJECT_DELETE_DELAY_MS',
        1000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.client.getProject(binding.projectId)) {
          return { success: true };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        error: `Vercel project ${binding.projectId} remained observable after ${attempts} deletion checks.`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    try {
      const scope = await this.assertScopeBinding(params.projectId);
      const binding = parseVercelServiceBinding(params.serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) {
        return {
          success: false,
          message: 'Failed to attach Vercel custom domain',
          error: `Bound Vercel project ${binding.projectId} was not found.`,
        };
      }
      this.assertProjectScope(project, scope);
      const existing = await this.client.getProjectDomain(binding.projectId, params.domain);
      const current = existing
        ?? await this.client.addProjectDomain(binding.projectId, params.domain);
      const config = await this.client.getDomainConfig(params.domain);
      return {
        success: true,
        message: existing
          ? 'Vercel custom domain already attached'
          : 'Vercel custom domain attached',
        data: {
          domain: current.name,
          customDomainId: this.projectDomainId(binding.projectId, current.name),
          created: !existing,
          providerVerified: current.verified && !config.misconfigured,
          dnsRecords: this.projectDomainDnsRecords(current),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to attach Vercel custom domain',
        error: this.formatError(error),
      };
    }
  }

  async detachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    customDomainId?: string;
  }): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    try {
      const scope = await this.assertScopeBinding(params.projectId);
      const binding = parseVercelServiceBinding(params.serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) {
        return {
          success: false,
          message: 'Failed to detach Vercel custom domain',
          error: `Bound Vercel project ${binding.projectId} was not found, so domain absence cannot be verified.`,
        };
      }
      this.assertProjectScope(project, scope);
      const expectedId = this.projectDomainId(binding.projectId, params.domain);
      if (params.customDomainId && params.customDomainId !== expectedId) {
        return {
          success: false,
          message: 'Vercel custom-domain identity changed',
          error: `Reviewed custom-domain identity ${params.customDomainId} does not match ${expectedId}.`,
        };
      }
      const existing = await this.client.getProjectDomain(binding.projectId, params.domain);
      if (!existing) {
        return {
          success: true,
          message: 'Vercel custom domain is already absent',
          data: { domain: params.domain, customDomainId: expectedId, alreadyAbsent: true },
        };
      }
      await this.client.removeProjectDomain(binding.projectId, params.domain);
      if (await this.client.getProjectDomain(binding.projectId, params.domain)) {
        return {
          success: false,
          message: 'Vercel custom-domain deletion is not complete',
          error: `${params.domain} remains attached to Vercel project ${binding.projectId}.`,
        };
      }
      return {
        success: true,
        message: 'Vercel custom domain detached',
        data: { domain: params.domain, customDomainId: expectedId, deleted: true },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to detach Vercel custom domain',
        error: this.formatError(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    serviceId: string
  ): Promise<{ status: string; url?: string; reason?: string }> {
    if (!this.client) {
      return {
        status: 'unknown',
        reason: 'Vercel deployment observation requires a verified connection.',
      };
    }
    try {
      const scope = await this.assertScopeBinding(
        parseHostingBindings(environment).projectId
      );
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) return { status: 'absent' };
      this.assertProjectScope(project, scope);
      const deployment = await this.latestDeployment(binding.projectId);
      if (!deployment) return { status: 'empty' };
      const url = deployment.url
        ? this.deploymentUrl(deployment.url)
        : undefined;
      return {
        status: this.deployStatus(deployment),
        ...(url ? { url } : {}),
      };
    } catch (error) {
      return {
        status: 'unknown',
        reason: `Vercel deployment observation failed for ${serviceId}: ${this.formatError(error)}`,
      };
    }
  }

  async observeMaintenanceWorkload(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<MaintenanceWorkloadObservation> {
    try {
      const resolved = await this.resolveMaintenanceProject(
        environment,
        serviceId,
        workloadKind
      );
      if ('reason' in resolved) {
        return {
          serviceId,
          workloadKind,
          wasRunning: false,
          state: 'unknown',
          reason: resolved.reason,
        };
      }
      if (typeof resolved.project.paused !== 'boolean') {
        return {
          serviceId,
          workloadKind,
          wasRunning: false,
          state: 'unknown',
          reason: 'maintenance_project_pause_state_unknown',
          providerState: this.maintenanceProviderState(resolved),
        };
      }
      if (
        resolved.project.paused
        && !await this.verifyResolvedMaintenanceUrls(resolved, 'suspended')
      ) {
        return {
          serviceId,
          workloadKind,
          wasRunning: false,
          state: 'unknown',
          reason: 'maintenance_origin_state_unverified',
          providerState: this.maintenanceProviderState(resolved),
        };
      }
      return {
        serviceId,
        workloadKind,
        wasRunning: !resolved.project.paused,
        state: resolved.project.paused ? 'suspended' : 'running',
        providerState: this.maintenanceProviderState(resolved),
      };
    } catch {
      return {
        serviceId,
        workloadKind,
        wasRunning: false,
        state: 'unknown',
        reason: 'maintenance_workload_identity_unknown',
      };
    }
  }

  async suspendMaintenanceWorkload(
    environment: Environment,
    expected: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    if (!this.client) {
      return this.maintenanceFailure(
        'Vercel workload was not suspended',
        'Not connected. Call connect() first.'
      );
    }
    const current = await this.observeMaintenanceWorkload(
      environment,
      expected.serviceId,
      expected.workloadKind
    );
    const identityError = this.maintenanceIdentityError(expected, current);
    if (identityError) {
      return this.maintenanceFailure('Vercel workload was not suspended', identityError);
    }
    try {
      if (
        current.reason === 'maintenance_origin_state_unverified'
        && current.providerState?.paused === true
      ) {
        const verified = await this.waitForMaintenanceState(
          environment,
          expected,
          'suspended'
        );
        return verified
          ? {
              success: true,
              message: `Vercel project ${String(current.providerState.projectId)} is already paused`,
              data: { applied: 0, skipped: 1 },
            }
          : this.maintenanceFailure(
              'Vercel suspension was not verified',
              'One or more production origins did not return a provider-verified maintenance response.'
            );
      }
      if (current.state === 'suspended') {
        return {
          success: true,
          message: `Vercel project ${String(current.providerState?.projectId)} is already paused`,
          data: { applied: 0, skipped: 1 },
        };
      }
      if (current.state !== 'running') {
        return this.maintenanceFailure(
          'Vercel workload was not suspended',
          'The exact bound Vercel project state is unknown.'
        );
      }
      await this.client.pauseProject(String(current.providerState!.projectId));
      const verified = await this.waitForMaintenanceState(
        environment,
        expected,
        'suspended'
      );
      return verified
        ? {
            success: true,
            message: `Paused Vercel project ${String(current.providerState!.projectId)}`,
            data: { applied: 1, skipped: 0 },
          }
        : this.maintenanceFailure(
            'Vercel suspension was not verified',
            'Vercel did not report the project paused with every production origin in maintenance before the verification deadline.'
          );
    } catch (error) {
      return this.maintenanceFailure(
        'Vercel workload was not suspended',
        this.formatError(error)
      );
    }
  }

  async resumeMaintenanceWorkload(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    if (!this.client) {
      return this.maintenanceFailure(
        'Vercel workload was not restored',
        'Not connected. Call connect() first.'
      );
    }
    const current = await this.observeMaintenanceWorkload(
      environment,
      snapshot.serviceId,
      snapshot.workloadKind
    );
    const identityError = this.maintenanceIdentityError(snapshot, current);
    if (identityError) {
      return this.maintenanceFailure('Vercel workload was not restored', identityError);
    }
    try {
      const currentlyPaused = current.state === 'suspended'
        || (
          current.reason === 'maintenance_origin_state_unverified'
          && current.providerState?.paused === true
        );
      if (!snapshot.wasRunning) {
        if (!currentlyPaused) {
          return this.maintenanceFailure(
            'Vercel restoration was blocked',
            'A Vercel project that was paused before maintenance is now running.'
          );
        }
        if (current.state !== 'suspended') {
          return this.maintenanceFailure(
            'Vercel restoration was blocked',
            'The previously paused Vercel project no longer has provider-verified maintenance origins.'
          );
        }
        return {
          success: true,
          message: `Vercel project ${String(current.providerState?.projectId)} was paused before maintenance`,
          data: { applied: 0, skipped: 1 },
        };
      }
      if (current.state === 'running') {
        const verified = await this.verifyMaintenanceUrls(
          environment,
          snapshot.serviceId,
          snapshot.workloadKind,
          'running'
        );
        return verified
          ? {
              success: true,
              message: `Vercel project ${String(current.providerState?.projectId)} is already running`,
              data: { applied: 0, skipped: 1 },
            }
          : this.maintenanceFailure(
              'Vercel restoration was not verified',
              'A direct Vercel production origin still reports DEPLOYMENT_PAUSED.'
            );
      }
      if (!currentlyPaused) {
        return this.maintenanceFailure(
          'Vercel workload was not restored',
          'The exact bound Vercel project state is unknown.'
        );
      }
      await this.client.unpauseProject(String(current.providerState!.projectId));
      const verified = await this.waitForMaintenanceState(
        environment,
        snapshot,
        'running'
      );
      return verified
        ? {
            success: true,
            message: `Unpaused Vercel project ${String(current.providerState!.projectId)}`,
            data: { applied: 1, skipped: 0 },
          }
        : this.maintenanceFailure(
            'Vercel restoration was not verified',
            'Vercel did not report the project and its direct production origins running before the verification deadline.'
          );
    } catch (error) {
      return this.maintenanceFailure(
        'Vercel workload was not restored',
        this.formatError(error)
      );
    }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId) {
      return this.emptyObservation(false);
    }
    const scope = await this.assertScopeBinding(bindings.projectId);
    const projects = await this.client.listProjects();
    for (const project of projects) {
      this.assertProjectScope(project, scope);
    }

    const boundServices = Object.entries(bindings.services ?? {})
      .flatMap(([logicalName, binding]) => {
        if (!binding.serviceId) return [];
        const parsed = parseVercelServiceBinding(binding.serviceId);
        this.assertServiceScopeBinding(parsed.scope.binding, scope);
        return [{
          logicalName,
          binding: parsed.binding,
          projectId: parsed.projectId,
        }];
      });
    const boundIds = new Set(
      boundServices.map((binding) => binding.projectId)
    );
    const prefix = this.servicePrefix(environment);
    const unbound = projects.filter(
      (project) =>
        project.name.startsWith(prefix)
        && !boundIds.has(project.id)
    );
    if (unbound.length > 0) {
      throw new Error([
        `Vercel projects matching this environment exist without durable local bindings: ${unbound
          .map((project) => `${project.name} (${project.id})`)
          .join(', ')}.`,
        'Use hv_import to adopt the intended projects; Hypervibe will not silently bind name matches.',
      ].join(' '));
    }

    const projectsById = new Map(
      projects.map((project) => [project.id, project])
    );
    const observed: ObservedVercelService[] = [];
    for (const binding of boundServices) {
      const project = projectsById.get(binding.projectId);
      if (!project) continue;
      observed.push(await this.observedService(
        binding.logicalName,
        binding.binding,
        project
      ));
    }
    const unknownKeys = observed.flatMap(
      (entry) => entry.unknownKeys.map(
        (key) => `${entry.service.name}:${key}`
      )
    );
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: scope.binding,
      services: observed.map((entry) => entry.service),
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: unknownKeys.length > 0 ? 'unknown' : 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: unknownKeys.length > 0,
      warnings: unknownKeys.length > 0
        ? [
            `Vercel did not return decrypted values for production environment variables, so service configuration is unknown for: ${unknownKeys.join(', ')}.`,
          ]
        : [],
    };
  }

  async inspectEnvironmentResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const environment = environmentForInspection(request);
    const bindings = parseHostingBindings(environment);
    const scope = await this.scope();
    const boundProjectIds = new Set(Object.values(bindings.services ?? {}).flatMap((binding) => {
      if (!binding.serviceId) return [];
      return [parseVercelServiceBinding(binding.serviceId).projectId];
    }));
    const prefix = this.servicePrefix(environment);
    const projects = (await this.client.listProjects()).filter((project) => (
      boundProjectIds.has(project.id) || project.name.startsWith(prefix)
    ));
    return {
      observation: projects.length > 0 ? 'present' : 'absent',
      resource: 'environment',
      project: { id: scope.binding, name: scope.label },
      environment: { name: environment.name },
      services: projects.slice(0, request.limit).map((project) => ({
        id: formatVercelServiceBinding(scope.binding, project.id),
        projectId: project.id,
        name: project.name,
        workloadKind: 'web',
        resourceType: 'vercel-project',
        managedByHypervibe: project.name.startsWith(prefix),
        sourceState: project.link ? 'connected' : 'disconnected',
      })),
      partial: projects.length > request.limit,
    };
  }

  private async observedService(
    logicalName: string,
    serviceBinding: string,
    project: VercelProject
  ): Promise<ObservedVercelService> {
    const [variables, deployments, domains] = await Promise.all([
      this.client!.listProjectEnvironmentVariables(project.id),
      this.client!.listDeployments(project.id),
      this.client!.listProjectDomains(project.id),
    ]);
    const domainConfigs = new Map<string, VercelDomainConfig>(await Promise.all(
      domains.map(async (domain) => [
        domain.name,
        await this.client!.getDomainConfig(domain.name),
      ] as const)
    ));
    const production = variables.filter(
      (variable) => this.targetsProduction(variable)
    );
    const byKey = new Map<string, VercelEnvironmentVariable[]>();
    for (const variable of production) {
      const entries = byKey.get(variable.key) ?? [];
      entries.push(variable);
      byKey.set(variable.key, entries);
    }
    for (const [key, entries] of byKey) {
      this.assertSingleVariableIdentity(key, entries);
      if (INTERNAL_ENV_KEYS.has(key)) {
        this.assertHypervibeInternalVariable(key, entries[0]!);
      }
    }

    const runtime = production.filter(
      (variable) => !RESERVED_ENV_KEYS.has(variable.key)
    );
    const unknownKeys = runtime
      .filter((variable) => !this.variableValueIsKnown(variable))
      .map((variable) => variable.key)
      .sort();
    const knownRuntime = runtime.filter(
      (variable) => this.variableValueIsKnown(variable)
    );
    const healthVariable = byKey.get(HEALTH_CHECK_PATH_KEY)?.[0];
    for (const internal of [healthVariable]) {
      if (internal && !this.variableValueIsKnown(internal)) {
        unknownKeys.push(internal.key);
      }
    }
    const latest = deployments[0];
    const url = latest?.url
      ? this.deploymentUrl(latest.url)
      : undefined;
    const source = this.projectSource(project);
    return {
      service: {
        name: logicalName,
        externalId: serviceBinding,
        workloadKind: 'web',
        ...(url ? { url } : {}),
        customDomains: domains.map((domain) => domain.name).sort(),
        customDomainStatus: this.customDomainStatus(domains, domainConfigs),
        config: {
          ...(healthVariable && this.variableValueIsKnown(healthVariable)
            ? { healthCheckPath: healthVariable.value }
            : {}),
          public: true,
        },
        ...(source ? { source } : {}),
        sourceState: project.link ? 'connected' : 'disconnected',
        envVarKeys: runtime.map((variable) => variable.key).sort(),
        envVarHashes: Object.fromEntries(
          knownRuntime.map((variable) => [
            variable.key,
            hashEnvValue(variable.value),
          ])
        ),
        status: latest
          ? this.observedRuntimeStatus(latest)
          : 'empty',
        ...(latest
          ? {
              deployment: {
                id: latest.uid,
                status: latest.readyState,
                createdAt: new Date(latest.createdAt).toISOString(),
              },
            }
          : {}),
      },
      unknownKeys: Array.from(new Set(unknownKeys)).sort(),
    };
  }

  private async resolveMaintenanceProject(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<ResolvedVercelMaintenanceProject | { reason: string }> {
    if (!this.client) return { reason: 'maintenance_provider_not_connected' };
    if (workloadKind !== 'web') {
      return { reason: 'maintenance_workload_kind_unsupported' };
    }
    const bindings = parseHostingBindings(environment);
    const exactBinding = Object.values(bindings.services ?? {})
      .find((candidate) => candidate.serviceId === serviceId);
    if (!exactBinding) return { reason: 'maintenance_workload_unbound' };
    const scope = await this.assertScopeBinding(bindings.projectId);
    const binding = parseVercelServiceBinding(serviceId);
    this.assertServiceScopeBinding(binding.scope.binding, scope);
    const project = await this.client.getProject(binding.projectId);
    if (!project) return { reason: 'maintenance_project_missing' };
    this.assertProjectScope(project, scope);
    return { binding, project, scope };
  }

  private maintenanceProviderState(
    resolved: ResolvedVercelMaintenanceProject
  ): Record<string, unknown> {
    return {
      scopeBinding: resolved.scope.binding,
      projectId: resolved.binding.projectId,
      accountId: resolved.project.accountId,
      ...(typeof resolved.project.paused === 'boolean'
        ? { paused: resolved.project.paused }
        : {}),
    };
  }

  private maintenanceIdentityError(
    expected: MaintenanceWorkloadSnapshot,
    current: MaintenanceWorkloadObservation
  ): string | undefined {
    if (
      current.state === 'unknown'
      && current.reason !== 'maintenance_origin_state_unverified'
    ) {
      return 'The exact bound Vercel project identity or pause state could not be verified.';
    }
    for (const key of ['scopeBinding', 'projectId', 'accountId'] as const) {
      const expectedValue = expected.providerState?.[key];
      const currentValue = current.providerState?.[key];
      if (
        typeof expectedValue !== 'string'
        || typeof currentValue !== 'string'
        || expectedValue !== currentValue
      ) {
        return `The reviewed Vercel maintenance ${key} no longer matches live state.`;
      }
    }
    return undefined;
  }

  private async waitForMaintenanceState(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot,
    expected: 'running' | 'suspended'
  ): Promise<boolean> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_VERCEL_MAINTENANCE_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_VERCEL_MAINTENANCE_DELAY_MS',
      1000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.observeMaintenanceWorkload(
        environment,
        snapshot.serviceId,
        snapshot.workloadKind
      );
      if (
        observed.reason !== 'maintenance_origin_state_unverified'
        && this.maintenanceIdentityError(snapshot, observed)
      ) return false;
      if (
        observed.state === expected
        && (
          expected === 'suspended'
          || await this.verifyMaintenanceUrls(
            environment,
            snapshot.serviceId,
            snapshot.workloadKind,
            expected
          )
        )
      ) {
        return true;
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    return false;
  }

  private async verifyMaintenanceUrls(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind'],
    expected: 'running' | 'suspended'
  ): Promise<boolean> {
    const resolved = await this.resolveMaintenanceProject(
      environment,
      serviceId,
      workloadKind
    );
    if ('reason' in resolved) return false;
    if (
      typeof resolved.project.paused !== 'boolean'
      || resolved.project.paused !== (expected === 'suspended')
    ) {
      return false;
    }
    return this.verifyResolvedMaintenanceUrls(resolved, expected);
  }

  private async verifyResolvedMaintenanceUrls(
    resolved: ResolvedVercelMaintenanceProject,
    expected: 'running' | 'suspended'
  ): Promise<boolean> {
    const timeoutMs = this.positiveIntegerEnv(
      'HYPERVIBE_VERCEL_MAINTENANCE_HTTP_TIMEOUT_MS',
      10_000
    );
    try {
      const urls = await this.maintenanceUrls(resolved.project);
      if (!urls.some(({ kind }) => kind === 'direct')) return false;
      const results = await Promise.all(urls.map(async (target) => {
        if (expected === 'running' && target.kind === 'custom') return true;
        const response = await fetch(target.url, {
          redirect: 'manual',
          headers: { 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const vercelMarker = await this.isVercelPausedResponse(response);
        if (expected === 'running') return !vercelMarker;
        if (target.kind === 'direct') return vercelMarker;
        return vercelMarker || (
          response.status === 503
          && Boolean(response.headers.get('x-hypervibe-maintenance'))
        );
      }));
      return results.every(Boolean);
    } catch {
      return false;
    }
  }

  private async maintenanceUrls(
    project: VercelProject
  ): Promise<VercelMaintenanceUrl[]> {
    const [domains, deployments] = await Promise.all([
      this.client!.listProjectDomains(project.id),
      this.client!.listDeployments(project.id),
    ]);
    const deployment = deployments.find(({ readyState }) => readyState === 'READY');
    const byUrl = new Map<string, VercelMaintenanceUrl>();
    const add = (domain: string, kind: VercelMaintenanceUrl['kind']) => {
      const normalized = domain
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
      if (!normalized || normalized.includes('/')) {
        throw new Error('Vercel returned an invalid production origin hostname.');
      }
      const url = `https://${normalized}/`;
      const existing = byUrl.get(url);
      if (!existing || kind === 'direct') byUrl.set(url, { kind, url });
    };
    for (const alias of project.alias ?? []) {
      if (
        alias.environment.toLowerCase() === 'production'
        || alias.target.toUpperCase() === 'PRODUCTION'
      ) {
        add(
          alias.domain,
          alias.domain.toLowerCase().endsWith('.vercel.app')
            ? 'direct'
            : 'custom'
        );
      }
    }
    for (const domain of domains) {
      if (domain.verified) add(domain.name, 'custom');
    }
    if (deployment?.url) add(deployment.url, 'direct');
    return Array.from(byUrl.values()).sort((left, right) => (
      left.url.localeCompare(right.url)
    ));
  }

  private async isVercelPausedResponse(response: Response): Promise<boolean> {
    if (response.status !== 503) return false;
    if (response.headers.get('x-vercel-error') === 'DEPLOYMENT_PAUSED') {
      return true;
    }
    return (await response.text()).includes('DEPLOYMENT_PAUSED');
  }

  private maintenanceFailure(message: string, error: string): Receipt {
    return { success: false, message, error };
  }

  private async syncProjectEnvironmentVariables(
    project: VercelProject,
    service: Service,
    vars: Record<string, string>
  ): Promise<void> {
    const current = await this.client!.listProjectEnvironmentVariables(
      project.id
    );
    const desired = this.desiredVariables(service, vars);
    const desiredKeys = new Set(desired.map((variable) => variable.key));
    for (const variable of desired) {
      const matches = this.productionVariables(current, variable.key);
      this.assertSingleVariableIdentity(variable.key, matches);
      const existing = matches[0];
      if (existing) {
        this.assertMutableVariable(variable.key, existing);
        if (INTERNAL_ENV_KEYS.has(variable.key)) {
          this.assertHypervibeInternalVariable(variable.key, existing);
        }
      }
    }

    for (const key of INTERNAL_ENV_KEYS) {
      if (desiredKeys.has(key)) continue;
      const matches = this.productionVariables(current, key);
      this.assertSingleVariableIdentity(key, matches);
      const existing = matches[0];
      if (!existing) continue;
      this.assertHypervibeInternalVariable(key, existing);
      if (!existing.id) {
        throw new Error(
          `Vercel internal environment marker ${key} has no durable ID; Hypervibe refused an ambiguous deletion.`
        );
      }
      await this.client!.deleteProjectEnvironmentVariable(
        project.id,
        existing.id
      );
    }
    await this.client!.upsertProjectEnvironmentVariables(project.id, desired);
  }

  private desiredVariables(
    service: Service,
    vars: Record<string, string>
  ): Array<{
    key: string;
    value: string;
    type: 'sensitive';
    target: ['production'];
    comment: string;
  }> {
    const healthCheckPath = service.buildConfig.healthCheckPath?.trim();
    const values = {
      ...this.runtimeEnvVars(vars),
      ...(healthCheckPath
        ? { [HEALTH_CHECK_PATH_KEY]: healthCheckPath }
        : {}),
    };
    return Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        value,
        type: 'sensitive' as const,
        target: ['production'] as ['production'],
        comment: ENV_COMMENT,
      }));
  }

  private runtimeEnvVars(
    vars: Record<string, string>
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(vars).filter(([key]) =>
        key !== 'IMAGE_URI'
        && !key.startsWith('IMAGE_URI_')
        && !key.startsWith('HYPERVIBE_SOURCE_')
        && !RESERVED_ENV_KEYS.has(key)
      )
    );
  }

  private validateService(service: Service): string | undefined {
    const workloadKind = serviceWorkloadKind(service);
    if (workloadKind !== 'web') {
      return 'Vercel Projects support web deployments in this adapter. Workers and cron jobs require a different provider lifecycle.';
    }
    if (service.buildConfig.public === false) {
      return 'Vercel web deployments are public unless separately protected. Hypervibe does not implicitly create deployment-protection policy.';
    }
    if (service.buildConfig.startCommand?.trim()) {
      return 'Vercel source deployments do not run an arbitrary long-lived startCommand. Omit startCommand and use a Vercel-supported framework or static build.';
    }
    if (
      service.buildConfig.buildCommand?.trim()
      || service.buildConfig.dockerfilePath?.trim()
      || service.buildConfig.builder === 'dockerfile'
    ) {
      return 'This Vercel adapter uses provider framework/static auto-detection and does not apply buildCommand or Dockerfile overrides.';
    }
    if ((service.buildConfig.watchPaths?.length ?? 0) > 0) {
      return 'Vercel watchPaths are not supported by the exact-SHA managed workflow, which deploys the complete reviewed commit.';
    }
    if (service.buildConfig.releaseCommand?.trim()) {
      return 'Vercel release commands are not supported. Use declarative database.seedCommand for first seed/bootstrap data, and run schema migrations during application startup.';
    }
    return undefined;
  }

  private async scope(): Promise<VercelScope> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const user = await this.client.getUser();
    if (!user?.id) {
      throw new Error('Vercel returned an incomplete user identity.');
    }
    const teamId = this.client.configuredTeamId;
    if (teamId) {
      const team = await this.client.getTeam(teamId);
      if (!team?.id || team.id !== teamId || !team.slug) {
        throw new Error(
          'Vercel returned a team identity outside the configured team scope.'
        );
      }
      return {
        kind: 'team',
        id: team.id,
        binding: formatVercelScopeBinding('team', team.id),
        label: team.slug,
        ...(user.email ? { email: user.email } : {}),
      };
    }
    return {
      kind: 'user',
      id: user.id,
      binding: formatVercelScopeBinding('user', user.id),
      label: user.username ?? user.email ?? user.id,
      ...(user.email ? { email: user.email } : {}),
    };
  }

  private async assertScopeBinding(
    boundScope?: string
  ): Promise<VercelScope> {
    if (!boundScope) {
      throw new Error(
        'No verified Vercel account-scope binding exists for this environment.'
      );
    }
    const scope = await this.scope();
    if (boundScope !== scope.binding) {
      throw new Error(
        `Bound Vercel scope ${boundScope} does not match the verified token scope ${scope.binding}.`
      );
    }
    return scope;
  }

  private assertProjectScope(
    project: VercelProject,
    scope: VercelScope
  ): void {
    this.assertProjectId(project.id);
    if (project.accountId !== scope.id) {
      throw new Error(
        `Vercel project ${project.id} belongs to account ${project.accountId}, not bound scope ${scope.id}.`
      );
    }
  }

  private assertServiceScopeBinding(
    boundScope: string,
    scope: VercelScope
  ): void {
    if (boundScope !== scope.binding) {
      throw new Error(
        `Bound Vercel service scope ${boundScope} does not match the verified token scope ${scope.binding}.`
      );
    }
  }

  private assertProjectId(value: string): void {
    if (!/^prj_[A-Za-z0-9]+$/.test(value)) {
      throw new Error(
        `Invalid Vercel project binding "${value}". Expected a durable prj_ project ID.`
      );
    }
  }

  private productionVariables(
    variables: VercelEnvironmentVariable[],
    key: string
  ): VercelEnvironmentVariable[] {
    return variables.filter(
      (variable) =>
        variable.key === key
        && this.targetsProduction(variable)
    );
  }

  private targetsProduction(variable: VercelEnvironmentVariable): boolean {
    if (variable.target === undefined) return true;
    return Array.isArray(variable.target)
      ? variable.target.includes('production')
      : variable.target === 'production';
  }

  private assertSingleVariableIdentity(
    key: string,
    variables: VercelEnvironmentVariable[]
  ): void {
    if (variables.length > 1) {
      throw new Error(
        `Vercel project contains multiple production environment variables named ${key}: ${variables
          .map((variable) => variable.id ?? 'missing-id')
          .join(', ')}. Hypervibe will not choose one implicitly.`
      );
    }
  }

  private assertMutableVariable(
    key: string,
    variable: VercelEnvironmentVariable
  ): void {
    if (variable.configurationId) {
      throw new Error(
        `Vercel environment variable ${key} is owned by integration configuration ${variable.configurationId}. Hypervibe refused to overwrite or delete it.`
      );
    }
  }

  private assertHypervibeInternalVariable(
    key: string,
    variable: VercelEnvironmentVariable
  ): void {
    this.assertMutableVariable(key, variable);
    if (variable.comment !== ENV_COMMENT) {
      throw new Error(
        `Reserved Vercel environment marker ${key} is not marked as Hypervibe-owned. Remove or rename the conflicting variable before retrying.`
      );
    }
  }

  private variableValueIsKnown(
    variable: VercelEnvironmentVariable
  ): boolean {
    return ['plain', 'system'].includes(variable.type)
      || variable.decrypted === true;
  }

  private async latestDeployment(
    projectId: string
  ): Promise<VercelDeployment | undefined> {
    return (await this.client!.listDeployments(projectId))[0];
  }

  private observedRuntimeStatus(
    deployment: VercelDeployment
  ): 'running' | 'failed' | 'unknown' {
    if (deployment.readyState === 'READY') return 'running';
    if (
      ['BLOCKED', 'CANCELED', 'ERROR'].includes(deployment.readyState)
    ) {
      return 'failed';
    }
    return 'unknown';
  }

  private deployStatus(deployment: VercelDeployment): string {
    if (deployment.readyState === 'READY') return 'deployed';
    if (
      ['BUILDING', 'INITIALIZING', 'QUEUED'].includes(
        deployment.readyState
      )
    ) {
      return 'deploying';
    }
    if (
      ['BLOCKED', 'CANCELED', 'ERROR'].includes(deployment.readyState)
    ) {
      return 'failed';
    }
    return 'unknown';
  }

  private deploymentUrl(url: string): string {
    return `https://${url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`;
  }

  private projectSource(
    project: VercelProject
  ): { repo?: string; branch?: string } | undefined {
    const link = project.link;
    if (!link) return undefined;
    const repo = link.org && link.repo
      ? `${link.org}/${link.repo}`
      : link.projectNameWithNamespace
        ?? link.projectName
        ?? link.projectUrl;
    const source = {
      ...(repo ? { repo } : {}),
      ...(link.productionBranch ? { branch: link.productionBranch } : {}),
    };
    return Object.keys(source).length > 0 ? source : undefined;
  }

  private customDomainStatus(
    domains: VercelProjectDomain[],
    configs: Map<string, VercelDomainConfig>
  ): Record<string, { providerVerified: boolean; dnsConfigured: boolean }> {
    return Object.fromEntries(
      domains.map((domain) => {
        const configured = configs.get(domain.name);
        if (!configured) {
          throw new Error(`Vercel domain configuration was not observed for ${domain.name}.`);
        }
        return [domain.name, {
          providerVerified: domain.verified && !configured.misconfigured,
          dnsConfigured: !configured.misconfigured,
        }];
      })
    );
  }

  private projectDomainId(projectId: string, domain: string): string {
    return `project-domain:${projectId}:${domain.toLowerCase()}`;
  }

  private projectDomainDnsRecords(domain: VercelProjectDomain): Array<{
    name: string;
    type: string;
    value: string;
    purpose: string;
  }> {
    const traffic = domain.name.toLowerCase() === domain.apexName?.toLowerCase()
      ? { name: domain.name, type: 'A', value: '76.76.21.21', purpose: 'traffic' }
      : { name: domain.name, type: 'CNAME', value: 'cname.vercel-dns-0.com', purpose: 'traffic' };
    const verification = (domain.verification ?? []).map((record) => ({
      name: record.domain,
      type: record.type,
      value: record.value,
      purpose: 'verification',
    }));
    return [traffic, ...verification];
  }

  private servicePrefix(environment: Environment): string {
    const projectHash = createHash('sha256')
      .update(environment.projectId)
      .digest('hex')
      .slice(0, 8);
    const environmentHash = createHash('sha256')
      .update(environment.name)
      .digest('hex')
      .slice(0, 6);
    return `hv-${projectHash}-${environmentHash}-`;
  }

  private serviceProjectName(
    environment: Environment,
    logicalName: string
  ): string {
    const serviceHash = createHash('sha256')
      .update(logicalName)
      .digest('hex')
      .slice(0, 8);
    return `${this.servicePrefix(environment)}${serviceHash}`;
  }

  private emptyObservation(projectExists: boolean): ObservedState {
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists,
      services: [],
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    };
  }

  private failedDeploy(
    service: Service,
    error: string,
    mutation?: {
      externalId?: string;
      createdService: boolean;
      mutationAttempted: true;
    }
  ): DeployResult {
    return {
      serviceId: service.id,
      ...(mutation?.externalId
        ? { externalId: mutation.externalId }
        : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `Vercel deployment configuration failed for ${service.name}`,
        error,
        ...(mutation
          ? {
              data: {
                createdService: mutation.createdService,
                mutationAttempted: mutation.mutationAttempted,
              },
            }
          : {}),
      },
    };
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: 'vercel',
    displayName: 'Vercel',
    category: 'deployment',
    credentialsSchema: VercelCredentialsSchema,
    setupHelpUrl: 'https://vercel.com/account/settings/tokens',
    credentials: {
      defaultScalarKey: 'accessToken',
      environmentVariableAliases: [
        [
          'VERCEL_ACCESS_TOKEN',
          'VERCEL_TOKEN',
          'HYPERVIBE_VERCEL_ACCESS_TOKEN',
        ],
      ],
    },
    maturity: {
      lifecycle: {
        hosting: { status: 'ready-for-live' },
      },
    },
    lifecycle: {
      hosting: { workloadKinds: ['web'], customDomains: 'managed', maintenance: 'managed', teardownBoundary: 'services' },
    },
    orchestration: {
      project: { shareAcrossEnvironments: true },
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      ci: {
        displayName: 'Vercel',
        requiredSecrets: VERCEL_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          VERCEL_ACCESS_TOKEN: 'accessToken',
        },
        buildGitHubActionsSteps: buildVercelGitHubActionsSteps,
        buildPortableRecipe: buildVercelPortableRecipe,
        portableRunnerCapabilities: ['linux-amd64'],
      },
      nativeBranchDeploy: {
        nonNativeSourcePolicy: 'block',
      },
    },
  },
  factory: async (credentials) => {
    const validated = VercelCredentialsSchema.parse(credentials);
    const adapter = new VercelAdapter();
    await adapter.connect(validated);
    return adapter;
  },
  inspection: {
    resources: ['environment'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'limit'], list: true },
    },
    inspect: (adapter, request) => (
      adapter as VercelAdapter
    ).inspectEnvironmentResources(request),
  },
});
