import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type {
  ObservedDatabase,
  ObservedService,
  ObservedState,
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
import { dnsZoneScopeForDomain } from '../../../domain/services/domain-scope.js';
import {
  FlyClient,
  FlyAppCreationObservationError,
  type FlyApp,
  type FlyCertificate,
  type FlyMachine,
  type FlyMachineConfig,
} from './fly.client.js';
import {
  formatFlyEnvironmentBinding,
  formatFlyOrganizationBinding,
  formatFlyServiceBinding,
  parseFlyEnvironmentBinding,
  parseFlyOrganizationBinding,
  parseFlyServiceBinding,
  type FlyServiceBinding,
} from './fly.binding.js';
import { FlyCredentialsSchema, type FlyCredentials } from './fly.credentials.js';
import { FlyDatabaseAdapter } from './fly-database.adapter.js';
import {
  buildFlyGitHubActionsSteps,
  FLY_CI_REQUIRED_SECRETS,
} from './fly-ci.workflow.js';
import { buildFlyPortableRecipe } from './fly-ci.recipe.js';

const BOOTSTRAP_IMAGE = 'flyio/hellofly:latest';
const DEFAULT_INTERNAL_PORT = 8080;
const META = {
  managed: 'hypervibe_managed',
  projectId: 'hypervibe_project_id',
  environmentId: 'hypervibe_environment_id',
  serviceName: 'hypervibe_service_name',
  workloadKind: 'hypervibe_workload_kind',
  startCommand: 'hypervibe_start_command',
  healthCheckPath: 'hypervibe_health_check_path',
  public: 'hypervibe_public',
} as const;
const ENV_HASH_PREFIX = 'hypervibe_env_';

interface ResolvedFlyService {
  binding: FlyServiceBinding;
  app: FlyApp;
  machine?: FlyMachine;
}

export class FlyAdapter implements IProviderAdapter {
  readonly name = 'fly';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    supportsDeferredDeploy: true,
  };

  private credentials: FlyCredentials | null = null;
  private client: FlyClient | null = null;
  private region = 'iad';

  async connect(credentials: unknown): Promise<void> {
    this.credentials = FlyCredentialsSchema.parse(credentials);
    this.client = new FlyClient(
      this.credentials.apiToken,
      this.credentials.organizationSlug
    );
  }

  configureTarget(target: { region?: string }): void {
    this.region = target.region?.trim() || 'iad';
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.verifyAccess();
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
  }

  async createDatabaseAdapter(): Promise<FlyDatabaseAdapter> {
    if (!this.credentials) throw new Error('Fly.io adapter is not connected.');
    const adapter = new FlyDatabaseAdapter();
    await adapter.connect(this.credentials);
    return adapter;
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    const adapter = await this.createDatabaseAdapter();
    try {
      return await adapter.observeDatabase(environment, component, options);
    } finally {
      await adapter.disconnect();
    }
  }

  async ensureProject(
    projectName: string,
    environment: Environment
  ): Promise<Receipt> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const expected = formatFlyOrganizationBinding(
        this.credentials.organizationSlug
      );
      const bound = parseHostingBindings(environment).projectId;
      if (bound && bound !== expected) {
        return {
          success: false,
          message: 'Failed to bind Fly.io organization scope',
          error: `The environment is bound to ${bound}, but the verified connection targets ${expected}. Hypervibe will not silently rebind it.`,
        };
      }
      const environmentId = formatFlyEnvironmentBinding({
        organizationSlug: this.credentials.organizationSlug,
        projectName,
        environmentName: environment.name,
      });
      const currentEnvironmentId = parseHostingBindings(environment).environmentId;
      if (currentEnvironmentId && currentEnvironmentId !== environmentId) {
        return {
          success: false,
          message: 'Failed to bind Fly.io logical environment identity',
          error: 'The environment has a different durable Fly.io logical identity. Hypervibe will not silently rebind it.',
        };
      }
      await this.client.listApps();
      return {
        success: true,
        message: `Using existing Fly.io organization: ${this.credentials.organizationSlug}`,
        data: {
          projectId: expected,
          projectName: this.credentials.organizationSlug,
          environmentId,
          created: false,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to verify Fly.io organization scope',
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
        message: 'Fly.io datastores use the derived Fly Managed Postgres lifecycle adapter.',
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    _options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const validation = this.validateService(service);
    if (validation) return this.failedDeploy(service, validation);

    let scope: string;
    try {
      scope = this.assertOrganizationBinding(
        parseHostingBindings(environment).projectId
      );
    } catch (error) {
      return this.failedDeploy(service, this.formatError(error));
    }

    const appName = this.serviceAppName(environment, service.name);
    const existingServiceId = parseHostingBindings(environment)
      .services?.[service.name]?.serviceId;
    let app: FlyApp | null = null;
    let createdService = false;
    let mutationAttempted = false;
    let binding: string | undefined;
    let boundIdentity: FlyServiceBinding | undefined;

    try {
      if (existingServiceId) {
        const parsed = parseFlyServiceBinding(existingServiceId);
        boundIdentity = parsed;
        this.assertBindingScope(parsed, scope);
        app = await this.client.getApp(parsed.appName);
        if (!app) {
          return this.failedDeploy(
            service,
            `Bound Fly.io app ${parsed.appName} (${parsed.appId}) was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertAppIdentity(app, parsed);
        binding = existingServiceId;
      } else {
        let matches: FlyApp[];
        try {
          matches = (await this.client.listApps())
            .filter((candidate) => candidate.name === appName);
        } catch (error) {
          throw new Error([
            `Could not check whether Fly.io app "${appName}" already exists, so Hypervibe refused to create an app that might be a duplicate.`,
            this.formatError(error),
          ].join(' '));
        }
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `Fly.io app name "${appName}" is already present: ${matches
                .map((candidate) => `${candidate.name} (${candidate.id})`)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Use hv_import when Fly adoption support is available or remove the conflict, then run hv_plan again.',
            ].join(' ')
          );
        }
        mutationAttempted = true;
        app = await this.client.createApp(appName);
        createdService = true;
        binding = formatFlyServiceBinding({
          organizationSlug: this.credentials.organizationSlug,
          appId: app.id,
          appName: app.name,
        });
        this.assertNewApp(app, appName);
      }

      const machine = await this.resolveOwnedMachine(
        app.name,
        service,
        environment,
        true,
        boundIdentity?.machineId
      );
      const runtimeVars = this.runtimeEnvVars(envVars);
      const secretVersion = Object.keys(runtimeVars).length > 0
        ? await this.client.updateSecrets(app.name, runtimeVars)
        : undefined;
      if (Object.keys(runtimeVars).length > 0) mutationAttempted = true;

      if (this.isPublicWeb(service)) {
        mutationAttempted = true;
        await this.ensurePublicIps(app.name);
      } else {
        mutationAttempted = true;
        await this.ensureNoPublicIps(app.name);
      }

      const config = this.machineConfig(
        service,
        environment,
        runtimeVars,
        machine?.config?.image ?? BOOTSTRAP_IMAGE,
        machine?.config
      );
      let appliedMachine: FlyMachine;
      if (machine) {
        mutationAttempted = true;
        appliedMachine = await this.client.updateMachine({
          appName: app.name,
          machine,
          config,
          minSecretsVersion: secretVersion,
          skipLaunch: machine.config?.image === BOOTSTRAP_IMAGE
            || machine.state !== 'started',
        });
      } else {
        mutationAttempted = true;
        appliedMachine = await this.client.createMachine({
          appName: app.name,
          name: this.machineName(service.name),
          region: this.region,
          config,
          minSecretsVersion: secretVersion,
          skipLaunch: true,
        });
      }
      this.assertMachineIdentity(appliedMachine, service, environment);
      const observedMachine = await this.client.getMachine(app.name, appliedMachine.id);
      if (!observedMachine) {
        throw new Error(
          `Fly.io acknowledged Machine ${appliedMachine.id}, but it was not observable afterward.`
        );
      }
      this.assertMachineIdentity(observedMachine, service, environment);
      binding = formatFlyServiceBinding({
        organizationSlug: this.credentials.organizationSlug,
        appId: app.id,
        appName: app.name,
        machineId: observedMachine.id,
      });

      const url = this.isPublicWeb(service)
        ? `https://${app.name}.fly.dev`
        : undefined;
      return {
        serviceId: service.id,
        externalId: binding,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: `Prepared Fly.io app for exact-SHA CI deployment: ${app.name}`,
          data: {
            serviceId: binding,
            flyAppId: app.id,
            flyAppName: app.name,
            organizationSlug: this.credentials.organizationSlug,
            machineId: observedMachine.id,
            environmentId: this.ownershipIdentity(environment).environmentId,
            resourceType: 'machine',
            createdService,
            deploymentDeferred: true,
            pendingDeployment: observedMachine.config?.image === BOOTSTRAP_IMAGE,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        error instanceof FlyAppCreationObservationError
          ? {
              externalId: formatFlyServiceBinding({
                organizationSlug: this.credentials.organizationSlug,
                appId: error.appId,
                appName: error.appName,
              }),
              createdService: true,
              mutationAttempted: true,
            }
          : binding
          ? { externalId: binding, createdService, mutationAttempted: true }
          : mutationAttempted
            ? { createdService, mutationAttempted: true }
            : undefined
      );
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    if (!this.client) {
      return {
        success: false,
        message: 'Failed to update Fly.io environment variables',
        error: 'Not connected. Call connect() first.',
      };
    }
    try {
      const resolved = await this.resolveBoundService(environment, service.name);
      if (!resolved) {
        return {
          success: false,
          message: 'Failed to update Fly.io environment variables',
          error: `No Fly.io service binding exists for ${service.name}.`,
          data: { staleBinding: true },
        };
      }
      if (!resolved.machine) {
        return {
          success: false,
          message: 'Failed to update Fly.io environment variables',
          error: `Bound Fly.io app ${resolved.app.name} has no exact Hypervibe-owned Machine.`,
          data: { staleBinding: true },
        };
      }
      const runtimeVars = this.runtimeEnvVars(vars);
      const version = Object.keys(runtimeVars).length > 0
        ? await this.client.updateSecrets(resolved.app.name, runtimeVars)
        : undefined;
      const metadata = {
        ...(resolved.machine.config?.metadata ?? {}),
        ...this.envHashMetadata(runtimeVars),
      };
      const updated = await this.client.updateMachine({
        appName: resolved.app.name,
        machine: resolved.machine,
        config: { ...(resolved.machine.config ?? {}), metadata },
        minSecretsVersion: version,
        skipLaunch: resolved.machine.state !== 'started',
      });
      const observed = await this.client.getMachine(resolved.app.name, updated.id);
      if (!observed) {
        throw new Error(`Fly.io Machine ${updated.id} was not observable after secret sync.`);
      }
      if (
        resolved.machine.instance_id
        && (!observed.instance_id || observed.instance_id === resolved.machine.instance_id)
      ) {
        throw new Error(`Fly.io Machine ${updated.id} did not advance to a new instance version after secret sync.`);
      }
      if (resolved.machine.state === 'started' && observed.state !== 'started') {
        throw new Error(`Fly.io Machine ${updated.id} is ${observed.state ?? 'unknown'} after secret sync.`);
      }
      return {
        success: true,
        message: `Updated Fly.io app secrets for ${service.name}`,
        data: {
          serviceId: formatFlyServiceBinding(resolved.binding),
          variableCount: Object.keys(runtimeVars).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Fly.io environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    if (!this.client) {
      return {
        success: false,
        message: 'Failed to delete Fly.io environment variables',
        error: 'Not connected. Call connect() first.',
      };
    }
    try {
      const resolved = await this.resolveBoundService(environment, service.name);
      if (!resolved?.machine) {
        return {
          success: false,
          message: 'Failed to delete Fly.io environment variables',
          error: `No exact Fly.io Machine binding exists for ${service.name}.`,
        };
      }
      const retired = Array.from(new Set(keys))
        .filter((key) => this.isRuntimeEnvKey(key))
        .sort();
      const values = Object.fromEntries(retired.map((key) => [key, null]));
      const version = retired.length > 0
        ? await this.client.updateSecrets(resolved.app.name, values)
        : undefined;
      const metadata = { ...(resolved.machine.config?.metadata ?? {}) };
      for (const key of retired) delete metadata[this.envHashKey(key)];
      const updated = await this.client.updateMachine({
        appName: resolved.app.name,
        machine: resolved.machine,
        config: { ...(resolved.machine.config ?? {}), metadata },
        minSecretsVersion: version,
        skipLaunch: resolved.machine.state !== 'started',
      });
      const observed = await this.client.getMachine(resolved.app.name, updated.id);
      if (!observed) {
        throw new Error(`Fly.io Machine ${updated.id} was not observable after secret deletion.`);
      }
      if (
        resolved.machine.instance_id
        && (!observed.instance_id || observed.instance_id === resolved.machine.instance_id)
      ) {
        throw new Error(`Fly.io Machine ${updated.id} did not advance to a new instance version after secret deletion.`);
      }
      if (resolved.machine.state === 'started' && observed.state !== 'started') {
        throw new Error(`Fly.io Machine ${updated.id} is ${observed.state ?? 'unknown'} after secret deletion.`);
      }
      const remaining = new Set(
        (await this.client.listSecrets(resolved.app.name))
          .flatMap((secret) => secret.name ? [secret.name] : [])
      );
      const undeleted = retired.filter((key) => remaining.has(key));
      if (undeleted.length > 0) {
        return {
          success: false,
          message: 'Fly.io secret deletion is not complete',
          error: `Fly.io still reports retired secret names: ${undeleted.join(', ')}.`,
        };
      }
      return {
        success: true,
        message: `Deleted explicitly retired Fly.io app secrets for ${service.name}`,
        data: { deletedKeys: retired },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Fly.io environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteService(serviceId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const binding = parseFlyServiceBinding(serviceId);
      this.assertBindingScope(
        binding,
        formatFlyOrganizationBinding(this.credentials.organizationSlug)
      );
      const app = await this.client.getApp(binding.appName);
      if (!app) return { success: true };
      this.assertAppIdentity(app, binding);
      await this.client.destroyApp(binding.appName, binding.appId);
      return { success: true };
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
      const scope = this.assertOrganizationBinding(params.projectId);
      const binding = parseFlyServiceBinding(params.serviceId);
      this.assertBindingScope(binding, scope);
      const app = await this.client.getApp(binding.appName);
      if (!app) {
        return {
          success: false,
          message: 'Failed to attach Fly.io custom domain',
          error: `Bound Fly.io app ${binding.appName} was not found.`,
        };
      }
      this.assertAppIdentity(app, binding);
      const domain = params.domain.trim().toLowerCase();
      const existing = await this.client.getCertificate(app.name, domain);
      const certificate = existing
        ?? await this.client.createCertificate(app.name, domain);
      return {
        success: true,
        message: existing
          ? 'Fly.io custom domain already attached'
          : 'Fly.io custom domain attached',
        data: {
          domain: certificate.hostname,
          customDomainId: this.certificateId(app.id, domain),
          organizationSlug: binding.organizationSlug,
          created: !existing,
          providerVerified: certificate.configured === true,
          certificateStatus: certificate.status,
          dnsRecords: this.certificateDnsRecords(certificate),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to attach Fly.io custom domain',
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
      const scope = this.assertOrganizationBinding(params.projectId);
      const binding = parseFlyServiceBinding(params.serviceId);
      this.assertBindingScope(binding, scope);
      const domain = params.domain.trim().toLowerCase();
      const expectedId = this.certificateId(binding.appId, domain);
      if (params.customDomainId && params.customDomainId !== expectedId) {
        return {
          success: false,
          message: 'Fly.io custom-domain identity changed',
          error: `Reviewed custom-domain identity ${params.customDomainId} does not match ${expectedId}.`,
        };
      }
      const app = await this.client.getApp(binding.appName);
      if (!app) {
        return {
          success: true,
          message: 'Fly.io custom domain is already absent with its owning app',
          data: {
            domain,
            customDomainId: expectedId,
            organizationSlug: binding.organizationSlug,
            alreadyAbsent: true,
          },
        };
      }
      this.assertAppIdentity(app, binding);
      if (!await this.client.getCertificate(app.name, domain)) {
        return {
          success: true,
          message: 'Fly.io custom domain is already absent',
          data: {
            domain,
            customDomainId: expectedId,
            organizationSlug: binding.organizationSlug,
            alreadyAbsent: true,
          },
        };
      }
      await this.client.deleteCertificate(app.name, domain);
      return {
        success: true,
        message: 'Fly.io custom domain detached',
        data: {
          domain,
          customDomainId: expectedId,
          organizationSlug: binding.organizationSlug,
          deleted: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to detach Fly.io custom domain',
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
        reason: 'Fly.io deployment observation requires a verified connection.',
      };
    }
    try {
      const scope = this.assertOrganizationBinding(
        parseHostingBindings(environment).projectId
      );
      const binding = parseFlyServiceBinding(serviceId);
      this.assertBindingScope(binding, scope);
      const app = await this.client.getApp(binding.appName);
      if (!app) return { status: 'absent' };
      this.assertAppIdentity(app, binding);
      const machines = await this.client.listMachines(app.name);
      if (!binding.machineId || machines.length !== 1) {
        return {
          status: machines.length === 0 ? 'empty' : 'unknown',
          ...(!binding.machineId
            ? { reason: `Fly.io service binding ${serviceId} has no durable Machine ID.` }
            : machines.length > 1
              ? { reason: `Fly.io App ${app.name} returned ${machines.length} Machines; expected exactly one.` }
              : {}),
        };
      }
      const machine = machines.find((candidate) => candidate.id === binding.machineId);
      if (!machine) {
        return {
          status: 'unknown',
          reason: `Fly.io App ${app.name} does not contain bound Machine ${binding.machineId}.`,
        };
      }
      const metadata = machine.config?.metadata;
      const ownership = this.ownershipIdentity(environment);
      if (
        metadata?.[META.managed] !== 'true'
        || metadata[META.projectId] !== ownership.projectName
        || metadata[META.environmentId] !== ownership.environmentId
      ) {
        return {
          status: 'unknown',
          reason: `Fly.io Machine ${machine.id} ownership metadata does not match environment ${environment.name}.`,
        };
      }
      const url = this.machineIsPublic(machine)
        ? `https://${app.name}.fly.dev`
        : undefined;
      return {
        status: this.machineStatus(machine),
        ...(url ? { url } : {}),
      };
    } catch (error) {
      return {
        status: 'unknown',
        reason: `Fly.io deployment observation failed for ${serviceId}: ${this.formatError(error)}`,
      };
    }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId || !bindings.environmentId) {
      if (Object.values(bindings.services ?? {}).some((binding) => binding.serviceId)) {
        throw new Error(
          'Fly.io service bindings exist without the durable logical environment identity. Hypervibe cannot safely reconstruct ownership from local UUIDs.'
        );
      }
      return this.emptyObservation(false);
    }
    const scope = this.assertOrganizationBinding(bindings.projectId);
    const apps = await this.client.listApps();
    for (const app of apps) this.assertObservedAppScope(app);

    const boundServices = Object.entries(bindings.services ?? {}).flatMap(
      ([logicalName, serviceBinding]) => {
        if (!serviceBinding.serviceId) return [];
        const parsed = parseFlyServiceBinding(serviceBinding.serviceId);
        this.assertBindingScope(parsed, scope);
        return [{ logicalName, externalId: serviceBinding.serviceId, binding: parsed }];
      }
    );
    const boundIds = new Set(boundServices.map(({ binding }) => binding.appId));
    const prefix = this.servicePrefix(environment);
    const unbound = apps.filter(
      (app) => app.name.startsWith(prefix) && !boundIds.has(app.id)
    );
    if (unbound.length > 0) {
      throw new Error([
        `Fly.io apps matching this environment exist without durable local bindings: ${unbound
          .map((app) => `${app.name} (${app.id})`)
          .join(', ')}.`,
        'Hypervibe will not silently bind name matches. Remove the conflict or wait for explicit Fly import support.',
      ].join(' '));
    }

    const byId = new Map(apps.map((app) => [app.id, app]));
    const services: ObservedService[] = [];
    const warnings: string[] = [];
    for (const target of boundServices) {
      const app = byId.get(target.binding.appId);
      if (!app) continue;
      this.assertAppIdentity(app, target.binding);
      const observed = await this.observedService(
        target.logicalName,
        target.externalId,
        target.binding,
        app,
        environment
      );
      services.push(observed.service);
      warnings.push(...observed.warnings);
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: scope,
      environmentId: this.ownershipIdentity(environment).environmentId,
      services,
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: warnings.length > 0 ? 'unknown' : 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: warnings.length > 0,
      warnings,
    };
  }

  async inspectEnvironmentResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (request.resource === 'database' && !request.environment) {
      return this.inspectDatabaseResources(request);
    }
    const environment = environmentForInspection(request);
    const bindings = parseHostingBindings(environment);
    const boundIds = new Set(Object.values(bindings.services ?? {}).flatMap((binding) => {
      if (!binding.serviceId) return [];
      return [parseFlyServiceBinding(binding.serviceId).appId];
    }));
    const prefix = this.servicePrefix(environment);
    const apps = (await this.client.listApps()).filter(
      (app) => boundIds.has(app.id) || app.name.startsWith(prefix)
    );
    const services = [];
    for (const app of apps.slice(0, request.limit)) {
      const machines = await this.client.listMachines(app.name);
      services.push({
        id: formatFlyServiceBinding({
          organizationSlug: this.credentials.organizationSlug,
          appId: app.id,
          appName: app.name,
        }),
        appId: app.id,
        name: app.name,
        resourceType: 'fly-app',
        machineIds: machines.map((machine) => machine.id),
        managedByHypervibe: app.name.startsWith(prefix),
        sourceState: 'disconnected',
      });
    }
    return {
      observation: apps.length > 0 ? 'present' : 'absent',
      resource: 'environment',
      project: {
        id: formatFlyOrganizationBinding(this.credentials.organizationSlug),
        name: this.credentials.organizationSlug,
      },
      environment: { name: environment.name },
      services,
      partial: apps.length > request.limit,
    };
  }

  private async observedService(
    logicalName: string,
    externalId: string,
    binding: FlyServiceBinding,
    app: FlyApp,
    environment: Environment
  ): Promise<{ service: ObservedService; warnings: string[] }> {
    const [machines, secrets, certificates, ipAssignments] = await Promise.all([
      this.client!.listMachines(app.name),
      this.client!.listSecrets(app.name),
      this.client!.listCertificates(app.name),
      this.client!.listIpAssignments(app.name),
    ]);
    const ownership = this.ownershipIdentity(environment);
    const owned = machines.filter((machine) => (
      machine.config?.metadata?.[META.managed] === 'true'
      && machine.config.metadata[META.projectId] === ownership.projectName
      && machine.config.metadata[META.environmentId] === ownership.environmentId
      && machine.config.metadata[META.serviceName] === logicalName
      && (!binding.machineId || machine.id === binding.machineId)
    ));
    if (machines.length !== owned.length || owned.length > 1) {
      throw new Error(
        `Fly.io app ${app.name} contains ${machines.length} Machines, but ${owned.length} match the exact Hypervibe service identity. Hypervibe will not choose or mutate an ambiguous Machine.`
      );
    }
    const machine = owned[0];
    const metadata = machine?.config?.metadata ?? {};
    const secretNames = secrets.flatMap((secret) => secret.name ? [secret.name] : []).sort();
    const envVarHashes: Record<string, string> = {};
    const unknown: string[] = [];
    for (const key of secretNames) {
      const hash = metadata[this.envHashKey(key)];
      if (/^[a-f0-9]{64}$/.test(hash ?? '')) envVarHashes[key] = hash!;
      else unknown.push(key);
    }
    const domainStatus = Object.fromEntries(certificates.map((certificate) => [
      certificate.hostname,
      {
        providerDomainId: this.certificateId(app.id, certificate.hostname),
        providerVerified: certificate.configured === true,
        certificateStatus: certificate.status,
        dnsConfigured: certificate.validation?.dns_configured === true,
        dnsRecords: this.certificateDnsRecords(certificate),
      },
    ]));
    const workloadKind = metadata[META.workloadKind] === 'worker' ? 'worker' : 'web';
    const startCommand = this.machineStartCommand(machine);
    const healthCheckPath = metadata[META.healthCheckPath];
    const hasIpv4 = ipAssignments.some((assignment) => assignment.ip?.includes('.'));
    const hasIpv6 = ipAssignments.some((assignment) => assignment.ip?.includes(':'));
    const machineIsPublic = machine
      ? this.machineIsPublic(machine)
      : metadata[META.public] === 'true';
    const isPublic = machineIsPublic ? hasIpv4 && hasIpv6 : hasIpv4 || hasIpv6;
    const url = isPublic ? `https://${app.name}.fly.dev` : undefined;
    return {
      service: {
        name: logicalName,
        externalId,
        workloadKind,
        ...(url ? { url } : {}),
        customDomains: certificates.map((certificate) => certificate.hostname).sort(),
        customDomainStatus: domainStatus,
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(healthCheckPath ? { healthCheckPath } : {}),
          public: isPublic,
        },
        sourceState: 'disconnected',
        envVarKeys: secretNames,
        envVarHashes,
        status: machine ? this.observedRuntimeStatus(machine) : 'empty',
      },
      warnings: unknown.length > 0
        ? [`Fly.io secret values remain encrypted and Machine hash metadata is missing for ${logicalName}: ${unknown.join(', ')}.`]
        : [],
    };
  }

  private async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const [clusters, peers] = await Promise.all([
      this.client!.listPostgresClusters(),
      this.client!.listWireGuardPeers(),
    ]);
    const matched = clusters
      .filter((cluster) => !request.id || cluster.id === request.id)
      .filter((cluster) => !request.name || cluster.name === request.name);
    const ambiguous = Boolean(request.name && matched.length > 1);
    const databases = matched.slice(0, request.limit).map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      engine: 'postgres',
      status: cluster.status ?? 'unknown',
      region: cluster.region ?? null,
      plan: cluster.plan ?? null,
      organizationSlug: this.credentials!.organizationSlug,
      providerScope: { organizationSlug: this.credentials!.organizationSlug },
    }));
    const temporaryAccessPeers = peers
      .filter((peer) => peer.name.startsWith('hv-db-'))
      .slice(0, request.limit)
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        region: peer.region,
        peerIp: peer.peerip,
        organizationSlug: this.credentials!.organizationSlug,
      }));
    return {
      resource: 'database',
      observation: ambiguous
        ? 'ambiguous'
        : matched.length > 0 ? 'present' : 'absent',
      project: {
        id: formatFlyOrganizationBinding(this.credentials!.organizationSlug),
        name: this.credentials!.organizationSlug,
      },
      databases,
      temporaryAccessPeers,
      truncated: matched.length > request.limit,
      temporaryAccessPeersTruncated:
        peers.filter((peer) => peer.name.startsWith('hv-db-')).length > request.limit,
      partial: false,
    };
  }

  private async resolveBoundService(
    environment: Environment,
    logicalName: string
  ): Promise<ResolvedFlyService | null> {
    const bindings = parseHostingBindings(environment);
    const serviceId = bindings.services?.[logicalName]?.serviceId;
    if (!serviceId) return null;
    const scope = this.assertOrganizationBinding(bindings.projectId);
    const binding = parseFlyServiceBinding(serviceId);
    this.assertBindingScope(binding, scope);
    const app = await this.client!.getApp(binding.appName);
    if (!app) return null;
    this.assertAppIdentity(app, binding);
    const placeholder: Service = {
      id: logicalName,
      projectId: environment.projectId,
      name: logicalName,
      buildConfig: {},
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const machine = await this.resolveOwnedMachine(
      app.name,
      placeholder,
      environment,
      false,
      binding.machineId
    );
    return { binding, app, ...(machine ? { machine } : {}) };
  }

  private async resolveOwnedMachine(
    appName: string,
    service: Service,
    environment: Environment,
    requireDesiredKind = true,
    expectedMachineId?: string
  ): Promise<FlyMachine | undefined> {
    const machines = await this.client!.listMachines(appName);
    const ownership = this.ownershipIdentity(environment);
    const owned = machines.filter((machine) => {
      const metadata = machine.config?.metadata;
      return metadata?.[META.managed] === 'true'
        && metadata[META.projectId] === ownership.projectName
        && metadata[META.environmentId] === ownership.environmentId
        && metadata[META.serviceName] === service.name
        && (!expectedMachineId || machine.id === expectedMachineId)
        && (!requireDesiredKind
          || metadata[META.workloadKind] === serviceWorkloadKind(service));
    });
    if (machines.length !== owned.length || owned.length > 1) {
      throw new Error(
        `Fly.io app ${appName} contains ${machines.length} Machines, but ${owned.length} match the reviewed Hypervibe service identity. Hypervibe refused an ambiguous mutation.`
      );
    }
    return owned[0];
  }

  private machineConfig(
    service: Service,
    environment: Environment,
    vars: Record<string, string>,
    image: string,
    current?: FlyMachineConfig
  ): FlyMachineConfig {
    const startCommand = service.buildConfig.startCommand?.trim();
    const healthPath = service.buildConfig.healthCheckPath?.trim();
    const isPublic = this.isPublicWeb(service);
    const internalPort = this.internalPort(vars.PORT, current);
    const ownership = this.ownershipIdentity(environment);
    const metadata = {
      ...(current?.metadata ?? {}),
      [META.managed]: 'true',
      [META.projectId]: ownership.projectName,
      [META.environmentId]: ownership.environmentId,
      [META.serviceName]: service.name,
      [META.workloadKind]: serviceWorkloadKind(service),
      [META.public]: String(isPublic),
      ...(startCommand ? { [META.startCommand]: startCommand } : {}),
      ...(healthPath ? { [META.healthCheckPath]: healthPath } : {}),
      ...this.envHashMetadata(vars),
    };
    if (!startCommand) delete metadata[META.startCommand];
    if (!healthPath) delete metadata[META.healthCheckPath];
    const checks = healthPath
      ? {
          hypervibe: {
            type: 'http',
            port: internalPort,
            protocol: 'http',
            method: 'GET',
            path: healthPath,
            interval: '15s',
            timeout: '5s',
            grace_period: '10s',
          },
        }
      : undefined;
    return {
      ...(current ?? {}),
      image,
      metadata,
      env: { ...(current?.env ?? {}), PORT: String(internalPort) },
      guest: current?.guest ?? { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
      restart: current?.restart ?? { policy: 'on-failure', max_retries: 10 },
      ...(startCommand ? { init: { cmd: ['/bin/sh', '-lc', startCommand] } } : { init: {} }),
      ...(checks ? { checks } : { checks: {} }),
      services: isPublic
        ? [{
            protocol: 'tcp',
            internal_port: internalPort,
            autostart: true,
            autostop: 'stop',
            min_machines_running: 0,
            ports: [
              { port: 80, handlers: ['http'], force_https: true },
              { port: 443, handlers: ['tls', 'http'] },
            ],
          }]
        : [],
    };
  }

  private async ensurePublicIps(appName: string): Promise<void> {
    let assignments = await this.client!.listIpAssignments(appName);
    if (!assignments.some((entry) => entry.ip?.includes(':'))) {
      await this.client!.assignIp(appName, 'v6');
    }
    assignments = await this.client!.listIpAssignments(appName);
    if (!assignments.some((entry) => entry.ip?.includes('.'))) {
      await this.client!.assignIp(appName, 'shared_v4');
    }
    assignments = await this.client!.listIpAssignments(appName);
    if (
      !assignments.some((entry) => entry.ip?.includes(':'))
      || !assignments.some((entry) => entry.ip?.includes('.'))
    ) {
      throw new Error(`Fly.io did not report both the expected IPv6 and shared IPv4 assignments for ${appName}.`);
    }
  }

  private async ensureNoPublicIps(appName: string): Promise<void> {
    const assignments = await this.client!.listIpAssignments(appName);
    for (const assignment of assignments) {
      if (!assignment.ip) {
        throw new Error(
          `Fly.io returned an IP assignment without a durable address for ${appName}.`
        );
      }
      await this.client!.releaseIp(appName, assignment.ip);
    }
    const remaining = await this.client!.listIpAssignments(appName);
    if (remaining.length > 0) {
      throw new Error(
        `Fly.io still reports ${remaining.length} IP assignment(s) for private app ${appName}.`
      );
    }
  }

  private assertOrganizationBinding(value?: string): string {
    if (!this.credentials) throw new Error('Fly.io adapter is not connected.');
    if (!value) throw new Error('No verified Fly.io organization binding exists for this environment.');
    const slug = parseFlyOrganizationBinding(value);
    if (slug !== this.credentials.organizationSlug) {
      throw new Error(
        `Bound Fly.io organization ${slug} does not match connected organization ${this.credentials.organizationSlug}.`
      );
    }
    return formatFlyOrganizationBinding(slug);
  }

  private assertBindingScope(binding: FlyServiceBinding, scope: string): void {
    if (formatFlyOrganizationBinding(binding.organizationSlug) !== scope) {
      throw new Error(
        `Bound Fly.io service organization ${binding.organizationSlug} does not match ${scope}.`
      );
    }
  }

  private assertObservedAppScope(app: FlyApp): void {
    const observed = app.organization?.slug;
    if (!observed) {
      throw new Error(
        `Fly.io app ${app.id} did not report its organization scope.`
      );
    }
    if (observed !== this.credentials?.organizationSlug) {
      throw new Error(
        `Fly.io app ${app.id} belongs to organization ${observed}, outside the connected scope.`
      );
    }
  }

  private assertNewApp(app: FlyApp, expectedName: string): void {
    if (!app.id || app.name !== expectedName) {
      throw new Error('Fly.io returned an app outside the reviewed name identity.');
    }
    this.assertObservedAppScope(app);
  }

  private assertAppIdentity(app: FlyApp, binding: FlyServiceBinding): void {
    if (app.id !== binding.appId || app.name !== binding.appName) {
      throw new Error(
        `Fly.io app identity changed: binding expects ${binding.appName} (${binding.appId}), observed ${app.name} (${app.id}).`
      );
    }
    this.assertObservedAppScope(app);
  }

  private assertMachineIdentity(
    machine: FlyMachine,
    service: Service,
    environment: Environment
  ): void {
    if (!machine.id) throw new Error('Fly.io returned a Machine without a durable ID.');
    const metadata = machine.config?.metadata;
    const ownership = this.ownershipIdentity(environment);
    if (
      metadata?.[META.managed] !== 'true'
      || metadata[META.projectId] !== ownership.projectName
      || metadata[META.environmentId] !== ownership.environmentId
      || metadata[META.serviceName] !== service.name
      || metadata[META.workloadKind] !== serviceWorkloadKind(service)
    ) {
      throw new Error(`Fly.io Machine ${machine.id} does not match the reviewed Hypervibe identity.`);
    }
  }

  private validateService(service: Service): string | undefined {
    const workloadKind = serviceWorkloadKind(service);
    if (workloadKind === 'cron') {
      return 'Fly.io Machine schedules support only coarse hourly/daily/weekly/monthly intervals, not Hypervibe cron expressions. Use a web or worker service.';
    }
    if (service.buildConfig.builder && service.buildConfig.builder !== 'dockerfile') {
      return 'Fly.io exact-SHA deployments require a Dockerfile build. Set builder to dockerfile or omit it so Hypervibe can generate the runtime Dockerfile.';
    }
    if (service.buildConfig.buildCommand?.trim()) {
      return 'Fly.io does not apply provider-side buildCommand overrides; encode the build in the Dockerfile.';
    }
    if ((service.buildConfig.watchPaths?.length ?? 0) > 0) {
      return 'Fly.io managed CI deploys the complete reviewed commit and does not support watchPaths.';
    }
    if (service.buildConfig.releaseCommand?.trim()) {
      return 'Fly.io release commands are not supported. Use declarative database.seedCommand for first seed/bootstrap data and run schema migrations during application startup.';
    }
    return undefined;
  }

  private runtimeEnvVars(vars: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(vars).filter(([key]) => this.isRuntimeEnvKey(key))
    );
  }

  private isRuntimeEnvKey(key: string): boolean {
    return key !== 'IMAGE_URI'
      && !key.startsWith('IMAGE_URI_')
      && !key.startsWith('HYPERVIBE_SOURCE_');
  }

  private envHashMetadata(vars: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(vars).map(([key, value]) => [
      this.envHashKey(key),
      createHash('sha256').update(value, 'utf8').digest('hex'),
    ]));
  }

  private envHashKey(key: string): string {
    return `${ENV_HASH_PREFIX}${Buffer.from(key, 'utf8').toString('base64url')}`;
  }

  private isPublicWeb(service: Service): boolean {
    return serviceWorkloadKind(service) === 'web'
      && service.buildConfig.public !== false;
  }

  private machineIsPublic(machine: FlyMachine): boolean {
    return (machine.config?.services?.length ?? 0) > 0;
  }

  private internalPort(
    desired: string | undefined,
    current: FlyMachineConfig | undefined
  ): number {
    const currentPort = current?.services?.[0]?.internal_port;
    const candidate = Number(desired ?? currentPort ?? DEFAULT_INTERNAL_PORT);
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
      throw new Error(
        `Fly.io service PORT must be an integer between 1 and 65535; received ${desired}.`
      );
    }
    return candidate;
  }

  private machineStartCommand(machine?: FlyMachine): string | undefined {
    const cmd = machine?.config?.init?.cmd;
    if (cmd?.length === 3 && cmd[0] === '/bin/sh' && cmd[1] === '-lc') {
      return cmd[2];
    }
    return machine?.config?.metadata?.[META.startCommand];
  }

  private observedRuntimeStatus(
    machine: FlyMachine
  ): 'running' | 'failed' | 'empty' | 'unknown' {
    if (machine.config?.image === BOOTSTRAP_IMAGE) return 'empty';
    if (machine.state === 'started') {
      const failing = (machine.checks ?? []).some(
        (check) => !['passing', 'warning'].includes(check.status ?? '')
      );
      return failing ? 'failed' : 'running';
    }
    if (['destroyed', 'failed'].includes(machine.state ?? '')) return 'failed';
    return 'unknown';
  }

  private machineStatus(machine: FlyMachine): string {
    if (machine.config?.image === BOOTSTRAP_IMAGE) return 'empty';
    if (machine.state === 'started') return 'deployed';
    if (['created', 'starting', 'replacing'].includes(machine.state ?? '')) return 'deploying';
    if (['destroyed', 'failed'].includes(machine.state ?? '')) return 'failed';
    return 'unknown';
  }

  private certificateId(appId: string, hostname: string): string {
    return `fly-certificate:${appId}:${hostname.toLowerCase()}`;
  }

  private certificateDnsRecords(certificate: FlyCertificate): Array<{
    name: string;
    type: string;
    value: string;
    purpose: string;
  }> {
    const hostname = certificate.hostname.toLowerCase();
    const requirements = certificate.dns_requirements;
    const records: Array<{ name: string; type: string; value: string; purpose: string }> = [];
    const useCname = Boolean(
      requirements?.cname
      && dnsZoneScopeForDomain(hostname) !== hostname
    );
    if (useCname) {
      records.push({
        name: hostname,
        type: 'CNAME',
        value: requirements!.cname!,
        purpose: 'traffic',
      });
    } else {
      for (const value of requirements?.a ?? []) {
        records.push({ name: hostname, type: 'A', value, purpose: 'traffic' });
      }
      for (const value of requirements?.aaaa ?? []) {
        records.push({ name: hostname, type: 'AAAA', value, purpose: 'traffic' });
      }
      if (
        records.length === 0
        && requirements?.cname
      ) {
        records.push({ name: hostname, type: 'CNAME', value: requirements.cname, purpose: 'traffic' });
      }
    }
    if (requirements?.acme_challenge?.name && requirements.acme_challenge.target) {
      records.push({
        name: requirements.acme_challenge.name,
        type: 'CNAME',
        value: requirements.acme_challenge.target,
        purpose: 'verification',
      });
    }
    if (requirements?.ownership?.name && requirements.ownership.app_value) {
      records.push({
        name: requirements.ownership.name,
        type: 'TXT',
        value: requirements.ownership.app_value,
        purpose: 'verification',
      });
    }
    return records;
  }

  private servicePrefix(environment: Environment): string {
    const ownership = this.ownershipIdentity(environment);
    const projectHash = createHash('sha256')
      .update(ownership.projectName)
      .digest('hex')
      .slice(0, 8);
    const environmentHash = createHash('sha256')
      .update(ownership.environmentId)
      .digest('hex')
      .slice(0, 6);
    return `hv-${projectHash}-${environmentHash}-`;
  }

  private serviceAppName(environment: Environment, logicalName: string): string {
    const serviceHash = createHash('sha256')
      .update(logicalName)
      .digest('hex')
      .slice(0, 8);
    return `${this.servicePrefix(environment)}${serviceHash}`;
  }

  private ownershipIdentity(environment: Environment): {
    projectName: string;
    environmentId: string;
  } {
    const bindings = parseHostingBindings(environment);
    if (!bindings.environmentId) {
      throw new Error('No durable Fly.io logical environment binding exists.');
    }
    const identity = parseFlyEnvironmentBinding(bindings.environmentId);
    if (identity.organizationSlug !== this.credentials?.organizationSlug) {
      throw new Error(
        `Bound Fly.io logical environment belongs to organization ${identity.organizationSlug}, not ${this.credentials?.organizationSlug}.`
      );
    }
    if (identity.environmentName !== environment.name) {
      throw new Error(
        `Bound Fly.io environment name ${identity.environmentName} does not match ${environment.name}.`
      );
    }
    return {
      projectName: identity.projectName,
      environmentId: bindings.environmentId,
    };
  }

  private machineName(logicalName: string): string {
    const normalized = logicalName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `hv-${normalized.slice(0, 40)}-${createHash('sha256').update(logicalName).digest('hex').slice(0, 6)}`;
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
      ...(mutation?.externalId ? { externalId: mutation.externalId } : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `Fly.io deployment configuration failed for ${service.name}`,
        error,
        ...(mutation ? {
          data: {
            createdService: mutation.createdService,
            mutationAttempted: mutation.mutationAttempted,
          },
        } : {}),
      },
    };
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: 'fly',
    displayName: 'Fly.io',
    category: 'deployment',
    credentialsSchema: FlyCredentialsSchema,
    setupHelpUrl: 'https://fly.io/dashboard',
    credentials: {
      environmentVariableAliases: [[
        'FLY_API_TOKEN',
        'HYPERVIBE_FLY_API_TOKEN',
      ], [
        'FLY_ORGANIZATION_SLUG',
        'HYPERVIBE_FLY_ORGANIZATION_SLUG',
      ]],
    },
    maturity: {
      lifecycle: {
        hosting: { status: 'ready-for-live' },
        database: { status: 'ready-for-live' },
      },
    },
    lifecycle: {
      hosting: {
        workloadKinds: ['web', 'worker'],
        customDomains: 'managed',
        domainTrafficProxy: 'supported',
        maintenance: 'unsupported',
        teardownBoundary: 'services',
      },
      databaseEngines: ['postgres'],
      databaseConnectivity: { compatibleHostingProviders: ['fly'] },
    },
    orchestration: {
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      logs: { runtime: false, deployments: false, build: false },
      ci: {
        displayName: 'Fly.io Machines',
        requiredSecrets: FLY_CI_REQUIRED_SECRETS,
        secretCredentialKeys: { FLY_API_TOKEN: 'apiToken' },
        buildGitHubActionsSteps: buildFlyGitHubActionsSteps,
        buildPortableRecipe: buildFlyPortableRecipe,
        portableRunnerCapabilities: ['linux-amd64', 'docker-privileged'],
      },
      nativeBranchDeploy: { nonNativeSourcePolicy: 'block' },
    },
  },
  factory: async (credentials) => {
    const validated = FlyCredentialsSchema.parse(credentials);
    const adapter = new FlyAdapter();
    await adapter.connect(validated);
    return adapter;
  },
  inspection: {
    resources: ['environment', 'database'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'limit'], list: true },
      database: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['organizationSlug'] },
    },
    inspect: (adapter, request) => (
      adapter as FlyAdapter
    ).inspectEnvironmentResources(request),
  },
  derivedAdapters: {
    database: (adapter) => (adapter as FlyAdapter).createDatabaseAdapter(),
  },
});
