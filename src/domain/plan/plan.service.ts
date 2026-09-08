import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { adapterFactory } from '../services/adapter.factory.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { firstProviderSpecValidationFailure } from '../services/provider-spec-validation.js';
import { SpecStore, type SpecResult } from '../spec/spec.store.js';
import {
  EMAIL_MANAGED_ENV_KEYS,
  MESSAGING_MANAGED_ENV_KEYS,
  type ProjectSpec,
  type EnvironmentSpec,
} from '../spec/spec.schema.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import {
  detectGitRemoteUrl,
  normalizeGitRemoteIdentity,
  parseGitHubRepoFromRemote,
} from '../../lib/git-remote.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { resolveGitDeploySource } from '../services/deploy-source.js';
import { diffEnvironment, diffRetainedHostingCleanup } from './diff.engine.js';
import type { DiffResult, LocalSnapshot, PlanAction } from './plan.types.js';
import {
  fingerprintObservedState,
  orderActions,
  type PlanRunDocument,
} from './converge.executor.js';
import {
  buildManagedDatabaseEnvVars,
  DATABASE_ENV_KEYS,
} from '../services/database-env.js';
import { buildCacheEnvVarsFromComponent, CACHE_ENV_KEYS } from '../services/cache-env.js';
import { CACHE_OPERATIONS, planCache } from '../services/cache-plan.service.js';
import { planDatabaseResilience, DATABASE_RESILIENCE_OPERATIONS } from '../services/database-resilience-plan.service.js';
import {
  addDomainRegistrationDependency,
  cloudflareRegistrarCredentialRequirement,
  planCloudflareDomainRegistration,
} from '../services/domain-registration.service.js';
import {
  environmentUsesGitHubActionsDeploy,
  planGitHubActionsRelease,
} from '../services/ci-deploy.service.js';
import {
  planManagedCiAppliedSpecHash,
  planManagedCiDeploy,
} from '../services/managed-ci.service.js';
import { CI_CONFIGURATION_SYNC_OPERATION } from '../services/managed-ci.contract.js';
import { planManagedCodeRepository } from '../services/managed-code-repository.service.js';
import { environmentUsesManagedCi, resolveDevOpsSelection } from '../spec/devops-selection.js';
import { devOpsProviderRegistry } from '../registry/devops.registry.js';
import { planIos } from '../services/appstore-plan.service.js';
import { planQueues } from '../services/queue-plan.service.js';
import { queueEnvVarSuffix, resolveQueueEnvVars } from '../services/queue-env.js';
import {
  parseStorageBindings,
  parseStorageProviderContexts,
  planStorage,
  storageEnvKeys,
} from '../services/storage-plan.service.js';
import { credentialFieldsFromSchema, formatConnectionGuidance } from '../services/connection-guidance.js';
import { defaultDeployEnvFilePath, loadDeployEnvFile } from '../services/deploy-env-file.js';
import { cloudflareScopeHintsForDomain } from '../services/domain-scope.js';
import {
  delegatedSecretInputsForEnvironment,
  planDelegatedSecrets,
  type DelegatedSecretInputRequirement,
} from '../services/delegated-secret.service.js';
import { resolveSecretValueRef } from '../services/secret-value-ref.js';
import {
  githubCollaborationConnectionBlock,
  planGitHubCollaboration,
} from '../services/repo-collaboration.service.js';
import {
  GITHUB_INFRASTRUCTURE_OPERATION,
  githubInfrastructureConnectionBlock,
  shouldPlanGitHubInfrastructure,
  planGitHubInfrastructure,
} from '../services/github-infrastructure.service.js';
import {
  planStripeEnvironmentSync,
  stripeEnvironmentName,
  stripeManagedEnvKeys,
} from '../services/stripe-env.service.js';
import { planEmail } from '../services/email-plan.service.js';
import { planTwilioMessaging } from '../services/twilio-messaging.service.js';
import {
  isProviderNativeDeploySourceAction,
  planProviderNativeDeploySources,
} from '../services/provider-native-deploy-source.service.js';
import {
  LOAD_BALANCER_OPERATIONS,
  planLoadBalancer,
} from '../services/load-balancer-plan.service.js';
import { planDataMigration } from '../services/data-migration-plan.service.js';
import { planMaintenance } from '../services/maintenance-plan.service.js';
import {
  observeEnvironmentMaintenance,
  parseEnvironmentMaintenanceBinding,
} from '../services/environment-maintenance.service.js';

export interface PlanOptions {
  /** Restrict the plan to one lifecycle stage. Omission preserves full-plan behavior. */
  scope?: 'full' | 'retained-cleanup';
  /** Restrict the plan to these spec services (partial deploy); must be a subset of the spec. */
  serviceFilter?: string[];
  /** One-off env var overrides merged over spec.envVars, frozen (encrypted) into the plan. */
  envVarOverrides?: Record<string, string>;
  /** Local env file to treat as deploy input. Defaults to .env.<env> then repo .env when present. */
  envFile?: string;
  /** Set false to skip loading the local deploy env file. */
  includeEnvFile?: boolean;
  /** Explicit chat-safe references for delegated secret slots declared in the spec. */
  secretRefs?: Record<string, string>;
}

export interface EnvironmentPlan {
  planRunId: string;
  scope: 'full' | 'retained-cleanup';
  specRevision: number;
  specSource?: { kind: 'repo'; path: string } | { kind: 'local' };
  environmentName: string;
  /** True when the plan was diffed against live provider state. */
  verified: boolean;
  observed: ObservedState | null;
  actions: PlanAction[];
  unmanaged: DiffResult['unmanaged'];
  warnings: string[];
  /** Delegated values that must be supplied in a new hv_plan call before apply. */
  inputRequired: DelegatedSecretInputRequirement[];
  /** Missing/unverified provider connections that block apply. */
  blocked: Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions'; actionIds?: string[]; requiredCredentialKeys?: string[] }>;
}

export const HOSTING_ENVIRONMENT_ENSURE_OPERATION = 'hostingEnvironmentEnsure';

function providerRequiredCredentialKeys(provider: string): string[] {
  const metadata = providerRegistry.getMetadata(provider);
  return metadata
    ? credentialFieldsFromSchema(metadata.credentialsSchema)
      ?.filter((field) => field.required)
      .map((field) => field.name) ?? []
    : [];
}

function projectWithSpecGitRemoteUrl(project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  return gitRemoteUrl && gitRemoteUrl !== project.gitRemoteUrl
    ? { ...project, gitRemoteUrl }
    : project;
}

function recordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordMapValue(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function componentProviderId(component: Component | null | undefined): string | undefined {
  return component?.externalId
    ?? recordValue(component?.bindings, 'instanceId')
    ?? recordValue(component?.bindings, 'serviceId');
}

function componentProjectId(component: Component | null | undefined): string | undefined {
  if (!component) return undefined;
  return recordValue(recordMapValue(component.bindings, 'providerScope'), 'projectId')
    ?? recordValue(component.bindings, 'projectId');
}

function hasProviderResourceBindings(bindings: Record<string, unknown> | undefined): boolean {
  if (recordValue(bindings, 'environmentId')) return true;
  const services = recordMapValue(bindings, 'services');
  return Object.values(services ?? {}).some((value) => {
    const service = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    return Boolean(recordValue(service, 'serviceId') ?? recordValue(service, 'jobName'));
  });
}

function nonEmptyStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0
    || entries.some(([, item]) => typeof item !== 'string' || item.length === 0)
  ) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function scopedStorageIdentityKey(value: {
  provider: string;
  externalId: string;
  instanceScope?: Record<string, string>;
}): string {
  return JSON.stringify([
    value.provider,
    value.externalId,
    Object.entries(value.instanceScope ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function storageContextKey(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Builds an environment plan: load spec → observe live state (when the
 * provider supports it) → pure diff → persist as a 'plan' run whose id is
 * the handshake token for hv_apply.
 */
export class PlanService {
  private envRepo = new EnvironmentRepository();
  private serviceRepo = new ServiceRepository();
  private componentRepo = new ComponentRepository();
  private connectionRepo = new ConnectionRepository();
  private runRepo = new RunRepository();
  private specStore = new SpecStore();

  getSpec(project: Project): { spec: ProjectSpec; revision: number } | null {
    return this.specStore.get(project);
  }

  async observeEnvironment(
    project: Project,
    environment: Environment | null,
    environmentSpec: EnvironmentSpec,
    options: { hostingOnly?: boolean } = {}
  ): Promise<{ observed: ObservedState | null; warnings: string[] }> {
    const warnings: string[] = [];
    if (!environment) {
      return { observed: null, warnings };
    }

    const provider = environmentSpec.hosting.provider;
    const storageBindings = parseStorageBindings(environment);
    const storageProviders = Array.from(new Set([
      ...Object.values(environmentSpec.storage ?? {}).map((storage) => storage.provider),
      ...Object.values(storageBindings).map((binding) => binding.provider),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
    const unknownObservation = (message: string): { observed: ObservedState; warnings: string[] } => {
      const bindings = parseHostingBindings(environment);
      return {
        observed: {
          provider,
          observedAt: new Date().toISOString(),
          projectExists: Boolean(bindings.projectId),
          ...(bindings.projectId ? { projectId: bindings.projectId } : {}),
          ...(bindings.environmentId ? { environmentId: bindings.environmentId } : {}),
          services: [],
          databases: [],
          caches: [],
          storage: [],
          completeness: {
            project: 'unknown',
            environment: 'unknown',
            services: 'unknown',
            databases: 'unknown',
            caches: 'unknown',
            storage: 'unknown',
            storageByProvider: Object.fromEntries(
              storageProviders.map((storageProvider) => [storageProvider, 'unknown' as const])
            ),
          },
          partial: true,
          warnings: [message],
        },
        warnings: [message],
      };
    };
    const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
    if (!adapterResult.success || !adapterResult.adapter) {
      return unknownObservation(
        `Cannot observe ${provider}: ${adapterResult.error ?? 'no adapter'}. Mutations that require live state are blocked.`
      );
    }

    const adapter = adapterResult.adapter as IProviderAdapter;
    try {
      await adapter.configureTarget?.({ region: environmentSpec.hosting.region });
    } catch (error) {
      return unknownObservation(
        `Cannot configure ${provider} hosting target: ${error instanceof Error ? error.message : String(error)}. Mutations are blocked.`
      );
    }
    if (!adapter.capabilities.supportsObserve || typeof adapter.observe !== 'function') {
      return unknownObservation(
        `${provider} does not support live observation. Existing local bindings are preserved and mutations that require proof of absence are blocked.`
      );
    }

    try {
      const observed = await adapter.observe(environment);
      const reportedCompleteness = observed.completeness;
      const providerHasSeparateEnvironment = providerRegistry
        .getMetadata(provider)
        ?.orchestration
        ?.environment
        ?.separateResource === true;
      observed.completeness = {
        project: observed.completeness?.project ?? 'complete',
        environment: observed.completeness?.environment
          ?? (providerHasSeparateEnvironment
            ? observed.environmentId
              ? 'complete'
              : 'unknown'
            : 'complete'),
        services: observed.completeness?.services ?? (observed.partial ? 'unknown' : 'complete'),
        databases: observed.completeness?.databases ?? 'complete',
        caches: observed.completeness?.caches ?? 'complete',
        storage: observed.completeness?.storage ?? 'complete',
        storageByProvider: {
          ...(reportedCompleteness?.storageByProvider ?? {}),
          ...(storageProviders.includes(provider)
            ? { [provider]: reportedCompleteness?.storage ?? 'complete' }
            : {}),
        },
      };

      if (options.hostingOnly) {
        return { observed, warnings };
      }

      // Observe declared databases through their lifecycle adapter even when
      // hosting and database share one provider connection. Hosting adapters
      // must not duplicate provider-owned database lifecycle logic.
      const localComponents = this.componentRepo.findByEnvironmentId(
        environment.id
      );
      const localDatabase = localComponents.find((component) =>
        component.type === 'postgres'
      );
      const localDatabaseProvider =
        typeof localDatabase?.bindings.provider === 'string'
          ? localDatabase.bindings.provider
          : undefined;
      const dbProvider =
        environmentSpec.database?.provider ?? localDatabaseProvider;
      const localDatabaseExternalId = componentProviderId(localDatabase);
      const databaseHostingBindings = parseHostingBindings(environment);
      const localDatabaseProjectId = componentProjectId(localDatabase);
      const databaseSharesHostingScope =
        localDatabaseProvider === provider
        && Boolean(localDatabaseProjectId)
        && Boolean(databaseHostingBindings.projectId)
        && localDatabaseProjectId === databaseHostingBindings.projectId;
      const databaseServiceBindingNames = databaseSharesHostingScope
        ? Object.entries(databaseHostingBindings.services ?? {})
          .filter(([, binding]) => (
            typeof binding.serviceId === 'string'
            && binding.serviceId === localDatabaseExternalId
          ))
          .map(([name]) => name)
        : [];
      const observedBoundDatabaseServices =
        databaseSharesHostingScope && localDatabaseExternalId
          ? observed.services.filter((service) => service.externalId === localDatabaseExternalId)
          : [];
      if (databaseServiceBindingNames.length > 0) {
        observed.completeness.databases = 'unknown';
        observed.partial = true;
        observed.warnings.push(
          `Provider id ${localDatabaseExternalId} is bound as both the database and application service ${databaseServiceBindingNames.join(', ')}; database reconciliation is blocked.`
        );
      } else if (observedBoundDatabaseServices.length > 1) {
        observed.completeness.databases = 'unknown';
        observed.partial = true;
        observed.warnings.push(
          `Multiple hosting services matched durable database id ${localDatabaseExternalId}; database reconciliation is blocked.`
        );
      } else if (
        dbProvider
        && (
          dbProvider !== provider
          || observed.completeness.databases !== 'complete'
          || observedBoundDatabaseServices.length === 1
          || (
            databaseSharesHostingScope
            && Boolean(localDatabaseExternalId)
            && observed.completeness.services !== 'complete'
          )
        )
      ) {
        observed.completeness.databases = 'unknown';
        const dbResult = await adapterFactory.getDatabaseAdapter(dbProvider, project);
        const dbAdapter = dbResult.adapter;
        if (dbResult.success && dbAdapter) {
          try {
            await dbAdapter.configureTarget?.({
              projectName: project.name,
              region: environmentSpec.hosting.region,
            });
            const engine =
              environmentSpec.database?.engine
              ?? localDatabase?.type
              ?? 'postgres';
            const component =
              localDatabase?.type === engine
                ? localDatabase
                : this.componentRepo.findByEnvironmentAndType(
                    environment.id,
                    engine
                  );
            const observationComponent =
              component
              && localDatabaseExternalId
              && !component.externalId
                ? { ...component, externalId: localDatabaseExternalId }
                : component;
            const db = await dbAdapter.observeDatabase(environment, observationComponent, {
              resourceName: `${project.name}-${environment.name}-${engine}`,
            });
            if (
              observedBoundDatabaseServices.length === 1
              && (
                !db
                || db.provider !== dbProvider
                || dbProvider !== provider
                || db.externalId !== localDatabaseExternalId
              )
            ) {
              throw new Error(
                `The database lifecycle adapter did not confirm hosting service ${localDatabaseExternalId} as the bound database.`
              );
            }
            if (
              db
              && db.provider === dbProvider
              && dbProvider === provider
              && db.externalId === localDatabaseExternalId
              && observedBoundDatabaseServices.length === 1
            ) {
              const [databaseService] = observedBoundDatabaseServices;
              observed.services = observed.services.filter((service) => service !== databaseService);
            }
            observed.databases = [
              ...observed.databases.filter((item) =>
                item.provider !== dbProvider
                || !db
                || item.externalId !== db.externalId
              ),
              ...(db ? [db] : []),
            ];
            observed.completeness.databases = 'complete';
          } catch (error) {
            observed.partial = true;
            observed.warnings.push(`Database observation failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          observed.partial = true;
          observed.warnings.push(
            `Database observation unavailable (${dbProvider}): ${dbResult.error ?? 'adapter does not implement observeDatabase'}`
          );
        }
      }

      const localCache = localComponents.find(
        (component) => component.type === 'redis'
      );
      const localCacheProvider =
        typeof localCache?.bindings.provider === 'string'
          ? localCache.bindings.provider
          : undefined;
      const cacheProvider =
        environmentSpec.cache?.provider ?? localCacheProvider;
      if (
        cacheProvider
        && (
          cacheProvider !== provider
          || observed.completeness.caches !== 'complete'
        )
      ) {
        observed.completeness.caches = 'unknown';
        const cacheResult = await adapterFactory.getCacheAdapter(cacheProvider, project);
        if (cacheResult.success && cacheResult.adapter) {
          try {
            const cacheBindings = localCache?.bindings as Record<string, unknown> | undefined;
            const cacheScope = cacheBindings?.providerScope && typeof cacheBindings.providerScope === 'object'
              && !Array.isArray(cacheBindings.providerScope)
              ? cacheBindings.providerScope as Record<string, unknown>
              : undefined;
            const target = {
              projectName: project.name,
              region: environmentSpec.cache?.region
                ?? (typeof cacheBindings?.region === 'string' ? cacheBindings.region : undefined)
                ?? (typeof cacheScope?.region === 'string' ? cacheScope.region : undefined),
              network: environmentSpec.cache?.network
                ?? (typeof cacheBindings?.network === 'string' ? cacheBindings.network : undefined)
                ?? (typeof cacheBindings?.authorizedNetwork === 'string' ? cacheBindings.authorizedNetwork : undefined),
              subnetwork: environmentSpec.cache?.subnetwork
                ?? (typeof cacheBindings?.subnetwork === 'string' ? cacheBindings.subnetwork : undefined),
              tier: environmentSpec.cache?.tier
                ?? (typeof cacheBindings?.tier === 'string' ? cacheBindings.tier : undefined),
              size: environmentSpec.cache?.size
                ?? (typeof cacheBindings?.size === 'string' ? cacheBindings.size : undefined),
            };
            await cacheResult.adapter.configureTarget?.(target);
            const cache = await cacheResult.adapter.observeCache(environment, localCache, {
              resourceName: `${project.name}-${environment.name}-redis`,
              ...target,
            });
            observed.caches = [
              ...(observed.caches ?? []).filter((item) =>
                item.provider !== cacheProvider
                && (!cache || item.externalId !== cache.externalId)
              ),
              ...(cache ? [cache] : []),
            ];
            observed.completeness.caches = 'complete';
          } catch (error) {
            observed.partial = true;
            observed.warnings.push(`Cache observation failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          observed.partial = true;
          observed.warnings.push(
            `Cache observation unavailable (${cacheProvider}): ${cacheResult.error ?? 'adapter does not implement observeCache'}`
          );
        }
      }

      const contexts = parseStorageProviderContexts(environment);
      const hostingBindings = parseHostingBindings(environment);
      for (const storageProvider of storageProviders) {
        const providerBindings = Object.values(storageBindings).filter(
          (binding) => binding.provider === storageProvider
        );
        const bindingContexts = providerBindings.flatMap((binding) => {
          const context = nonEmptyStringRecord(binding.instanceScope);
          return context ? [context] : [];
        });
        const hostingContext = storageProvider === provider
          && hostingBindings.projectId
          && hostingBindings.environmentId
          ? {
              projectId: hostingBindings.projectId,
              environmentId: hostingBindings.environmentId,
            }
          : undefined;
        const hostingContextKey = hostingContext ? storageContextKey(hostingContext) : undefined;
        const hostingObservationCoversBindings = bindingContexts.every(
          (context) => storageContextKey(context) === hostingContextKey
        );
        if (
          storageProvider === provider
          && observed.completeness.storageByProvider?.[storageProvider] === 'complete'
          && hostingObservationCoversBindings
        ) {
          continue;
        }
        observed.completeness.storageByProvider![storageProvider] = 'unknown';
        if (
          storageProvider === provider
          && providerBindings.length === 0
          && !nonEmptyStringRecord(contexts[storageProvider])
          && (
            observed.completeness.environment !== 'complete'
            || typeof observed.environmentId !== 'string'
            || observed.environmentId.length === 0
          )
        ) {
          observed.partial = true;
          observed.warnings.push(
            `Storage observation unavailable (${storageProvider}): the provider environment identity is not confirmed`
          );
          continue;
        }
        const storageResult = await adapterFactory.getStorageAdapter(storageProvider, project);
        if (!storageResult.success || !storageResult.adapter) {
          observed.partial = true;
          observed.warnings.push(`Storage observation failed (${storageProvider}): ${storageResult.error ?? 'adapter unavailable'}`);
          continue;
        }
        const candidateContexts = [
          ...bindingContexts,
          nonEmptyStringRecord(contexts[storageProvider]),
          hostingContext,
        ].filter((context): context is Record<string, string> => context !== undefined);
        let observationContexts = Array.from(
          new Map(candidateContexts.map((context) => [storageContextKey(context), context])).values()
        );
        if (observationContexts.length === 0) {
          const regions = [...new Set(Object.values(environmentSpec.storage ?? {})
            .filter((storage) => storage.provider === storageProvider)
            .map((storage) => storage.region))];
          if (regions.length !== 1 || !storageResult.adapter.resolveObservationContext) {
            observed.partial = true;
            observed.warnings.push(
              `Storage observation unavailable (${storageProvider}): provider context is missing and cannot be resolved read-only${providerBindings.length > 0 ? '; the persisted binding cannot prove its provider scope' : ''}`
            );
            continue;
          }
          const contextResult = await storageResult.adapter.resolveObservationContext(
            project.name,
            environment,
            regions[0]
          );
          if (!contextResult.receipt.success || !contextResult.context) {
            observed.partial = true;
            observed.warnings.push(`Storage observation unavailable (${storageProvider}): ${contextResult.receipt.error ?? contextResult.receipt.message}`);
            continue;
          }
          observationContexts = [contextResult.context];
        }
        let providerComplete = true;
        for (const context of observationContexts) {
          try {
            const items = await storageResult.adapter.observe(environment, context);
            if (items.some((item) => item.provider !== storageProvider)) {
              throw new Error(`adapter returned an identity for a different provider`);
            }
            const knownIdentities = new Set(
              (observed.storage ?? []).map((item) => scopedStorageIdentityKey(item))
            );
            const additions = items.filter((item) => {
              const identity = scopedStorageIdentityKey(item);
              if (knownIdentities.has(identity)) return false;
              knownIdentities.add(identity);
              return true;
            });
            observed.storage = [...(observed.storage ?? []), ...additions];
          } catch (error) {
            providerComplete = false;
            observed.partial = true;
            observed.warnings.push(`Storage observation failed (${storageProvider}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        observed.completeness.storageByProvider![storageProvider] = providerComplete
          ? 'complete'
          : 'unknown';
      }
      observed.completeness.storage = storageProviders.every(
        (storageProvider) => observed.completeness?.storageByProvider?.[storageProvider] === 'complete'
      )
        ? 'complete'
        : storageProviders.length > 0
          ? 'unknown'
          : observed.completeness.storage;

      if (
        environmentSpec.maintenance
        || parseEnvironmentMaintenanceBinding(environment)
      ) {
        observed.maintenance = await observeEnvironmentMaintenance({
          project,
          environment,
          environmentSpec,
          hostingAdapter: adapter,
        });
        if (observed.maintenance.state === 'unknown') {
          observed.partial = true;
          observed.warnings.push(
            'Environment maintenance observation is incomplete; transition actions are blocked fail-closed.'
          );
        }
      }

      return { observed, warnings };
    } catch (error) {
      const message = `Observation failed (${provider}): ${error instanceof Error ? error.message : String(error)}. Mutations that require proof of absence are blocked.`;
      return unknownObservation(message);
    }
  }

  buildLocalSnapshot(
    project: Project,
    environment: Environment | null,
    effectiveBindings?: Record<string, unknown>
  ): LocalSnapshot {
    const bindings = (effectiveBindings ?? environment?.platformBindings) as LocalSnapshot['bindings'] | undefined;
    return {
      projectExists: true,
      environmentExists: Boolean(environment),
      services: this.serviceRepo.findByProjectId(project.id),
      components: environment ? this.componentRepo.findByEnvironmentId(environment.id) : [],
      bindings,
    };
  }

  sharedProjectBindingForEnvironment(
    project: Project,
    environmentName: string,
    environment: Environment | null,
    provider: string
  ): { bindings?: Record<string, unknown>; warnings: string[] } | { error: string } {
    const metadata = providerRegistry.getMetadata(provider);
    if (!metadata?.orchestration?.project?.shareAcrossEnvironments) {
      return { warnings: [] };
    }

    const candidates = new Map<string, string[]>();
    for (const sibling of this.envRepo.findByProjectId(project.id)) {
      if (sibling.name === environmentName) continue;
      const siblingBindings = sibling.platformBindings as Record<string, unknown>;
      if (recordValue(siblingBindings, 'provider') !== provider) continue;
      const siblingProjectId = recordValue(siblingBindings, 'projectId');
      if (!siblingProjectId) continue;
      const names = candidates.get(siblingProjectId) ?? [];
      names.push(sibling.name);
      candidates.set(siblingProjectId, names);
    }

    const currentBindings = environment?.platformBindings as Record<string, unknown> | undefined;
    const currentProvider = recordValue(currentBindings, 'provider');
    if (currentProvider && currentProvider !== provider) {
      return { warnings: [] };
    }

    const currentProjectId = recordValue(currentBindings, 'projectId');
    if (currentProjectId) {
      if (candidates.size === 1 && !candidates.has(currentProjectId)) {
        const [[projectId, envs]] = [...candidates.entries()];
        if (hasProviderResourceBindings(currentBindings)) {
          return {
            error: `${metadata.displayName} is configured to share one provider project across environments, but environment "${environmentName}" is bound to ${currentProjectId} while environment "${envs[0]}" is bound to ${projectId}. Hypervibe will not guess because "${environmentName}" still has provider environment/service bindings. Import the intended project or destroy/reset the stale local environment binding first.`,
          };
        }
        return {
          bindings: { ...(currentBindings ?? {}), provider, projectId },
          warnings: [`Replaced stale ${metadata.displayName} project binding ${currentProjectId} with shared project binding ${projectId} from environment "${envs[0]}" for environment "${environmentName}".`],
        };
      }
      if (candidates.size > 1 && !candidates.has(currentProjectId)) {
        const options = [...candidates.entries()]
          .map(([projectId, envs]) => `${projectId} (${envs.join(', ')})`)
          .join('; ');
        return {
          error: `${metadata.displayName} is configured to share one provider project across environments, but environment "${environmentName}" is bound to ${currentProjectId} and Hypervibe found multiple other ${provider} project bindings: ${options}. Import or set the intended project binding before planning.`,
        };
      }
      if (currentProvider === provider) return { warnings: [] };
      return {
        bindings: { ...(currentBindings ?? {}), provider, projectId: currentProjectId },
        warnings: [`Recorded ${metadata.displayName} as the provider for existing project binding ${currentProjectId} in environment "${environmentName}".`],
      };
    }

    if (candidates.size === 0) {
      return { warnings: [] };
    }
    if (candidates.size > 1) {
      const options = [...candidates.entries()]
        .map(([projectId, envs]) => `${projectId} (${envs.join(', ')})`)
        .join('; ');
      return {
        error: `${metadata.displayName} is configured to share one provider project across environments, but Hypervibe found multiple existing ${provider} project bindings: ${options}. Import or set the intended project binding for "${environmentName}" before planning so Hypervibe does not create or target the wrong project.`,
      };
    }

    const [[projectId, envs]] = [...candidates.entries()];
    return {
      bindings: { ...(currentBindings ?? {}), provider, projectId },
      warnings: [`Reusing ${metadata.displayName} project binding ${projectId} from environment "${envs[0]}" for environment "${environmentName}".`],
    };
  }

  /** Connections that must exist+verify before apply can run. */
  preflight(environmentSpec: EnvironmentSpec, environmentName?: string, projectSpec?: ProjectSpec): Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions'; requiredCredentialKeys?: string[] }> {
    const blocked: Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions'; requiredCredentialKeys?: string[] }> = [];
    const required: Array<{ provider: string; scopeHints?: string[] }> = [
      { provider: environmentSpec.hosting.provider },
    ];
    if (environmentSpec.database) required.push({ provider: environmentSpec.database.provider });
    if (environmentSpec.cache) required.push({ provider: environmentSpec.cache.provider });
    for (const storage of Object.values(environmentSpec.storage ?? {})) required.push({ provider: storage.provider });
    if (environmentSpec.loadBalancer) required.push({ provider: environmentSpec.loadBalancer.provider });
    if (environmentSpec.domain) {
      required.push({ provider: 'cloudflare', scopeHints: cloudflareScopeHintsForDomain(environmentSpec.domain) });
    }
    if (environmentSpec.email.enabled) required.push({ provider: 'sendgrid' });
    if (environmentSpec.messaging) required.push({ provider: 'twilio' });
    if (environmentSpec.deploy?.strategy === 'branch' && environmentSpec.deploy.trigger !== 'native') {
      const selection = projectSpec ? resolveDevOpsSelection(projectSpec) : null;
      if (selection?.ci) {
        const registration = devOpsProviderRegistry.ciProvider(selection.ci.provider);
        required.push({
          provider: registration?.connectionProvider ?? selection.ci.provider,
          scopeHints: [selection.code.scope],
        });
      } else if (environmentUsesGitHubActionsDeploy(environmentSpec)) {
        required.push({ provider: 'github' });
      }
    }
    if (environmentSpec.ios) {
      required.push({
        provider: 'appstoreconnect',
        scopeHints: [environmentSpec.ios.bundleId],
      });
    }
    if (environmentSpec.payments?.stripe) {
      required.push({
        provider: 'stripe',
        scopeHints: [
          stripeEnvironmentName(
            environmentName ?? environmentSpec.payments.stripe.environment ?? 'sandbox',
            environmentSpec.payments.stripe
          ),
        ],
      });
    }
    const seen = new Set<string>();
    for (const requirement of required) {
      const key = `${requirement.provider}:${requirement.scopeHints?.join('|') ?? '*'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const connectionProviders = providerRegistry.connectionProviders(requirement.provider);
      const scoped = requirement.scopeHints?.length
        ? connectionProviders
          .map((connectionProvider) => this.connectionRepo.findBestVerifiedMatchFromHints(connectionProvider, requirement.scopeHints!))
          .find((candidate) => candidate !== null)
        : null;
      const verified = requirement.scopeHints?.length
        ? Boolean(scoped)
        : connectionProviders.some((connectionProvider) =>
          this.connectionRepo.findAllByProvider(connectionProvider).some((connection) => connection.status === 'verified')
        );
      if (!verified) {
        const scope = requirement.scopeHints?.[0];
        blocked.push({
          provider: requirement.provider,
          requiredCredentialKeys: providerRequiredCredentialKeys(requirement.provider),
          reason: `No verified ${requirement.provider}${scope ? ` connection for ${scope}` : ' connection'}. ${formatConnectionGuidance(requirement.provider, { scope })}`,
          policy: providerRegistry.getMetadata(requirement.provider)?.orchestration?.connections?.missingConnectionPolicy ?? 'hard',
          ...(scope ? { scope } : {}),
        });
      }
    }
    if (environmentSpec.domainRegistration?.register && environmentSpec.domain) {
      const registrarRequirement = cloudflareRegistrarCredentialRequirement(environmentSpec.domain);
      if (registrarRequirement) {
        const scope = cloudflareScopeHintsForDomain(environmentSpec.domain)[0];
        blocked.push({
          provider: 'cloudflare',
          requiredCredentialKeys: registrarRequirement.requiredCredentialKeys,
          reason: registrarRequirement.reason,
          policy: 'hard',
          ...(scope ? { scope } : {}),
        });
      }
    }
    return blocked;
  }

  /** Provider connections needed by an isolated cross-environment data copy.
   * Unrelated hosting, email, DNS, and CI connections cannot block this stage. */
  providerPreflight(providers: string[]): Array<{ provider: string; reason: string; policy: 'hard'; requiredCredentialKeys?: string[] }> {
    const blocked: Array<{ provider: string; reason: string; policy: 'hard'; requiredCredentialKeys?: string[] }> = [];
    for (const provider of [...new Set(providers)].sort()) {
      const verified = providerRegistry.connectionProviders(provider).some((connectionProvider) =>
        this.connectionRepo.findAllByProvider(connectionProvider).some((connection) => connection.status === 'verified')
      );
      if (!verified) {
        blocked.push({
          provider,
          requiredCredentialKeys: providerRequiredCredentialKeys(provider),
          reason: `No verified ${provider} connection. ${formatConnectionGuidance(provider)}`,
          policy: 'hard',
        });
      }
    }
    return blocked;
  }

  /** Connections required by project-level desired state planned in one canonical environment. */
  projectPreflight(
    project: Project,
    spec: ProjectSpec,
    environmentName: string
  ): Array<{ provider: string; reason: string; scope?: string; policy?: 'hard' | 'action-scoped-if-independent-actions'; actionIds?: string[] }> {
    const collaboration = githubCollaborationConnectionBlock({ project, spec, environmentName, connectionRepo: this.connectionRepo });
    const github = githubInfrastructureConnectionBlock({ project, spec, environmentName, connectionRepo: this.connectionRepo });
    return [collaboration, github].filter((block): block is NonNullable<typeof block> => block !== null);
  }

  /**
   * Repo/branch each service should be linked to under native branch deploys
   * — used by the diff to flag missing/mismatched deploy sources.
   */
  expectedDeploySource(
    project: Project,
    environmentName: string,
    environmentSpec: EnvironmentSpec
  ): { repo: string; branch: string } | undefined {
    if (environmentSpec.deploy?.strategy !== 'branch') return undefined;
    if (environmentSpec.deploy.trigger !== 'native') return undefined;
    const resolved = resolveGitDeploySource(project, environmentName, {
      strategy: 'branch',
      ...(environmentSpec.deploy.branch ? { branch: environmentSpec.deploy.branch } : {}),
    });
    return resolved.source ?? undefined;
  }

  /**
   * For native repo-linked branch deploys, let providers verify any external
   * GitHub app visibility they need before apply records a source as connected.
   */
  async checkBranchDeploySource(
    project: Project,
    environmentSpec: EnvironmentSpec
  ): Promise<string[]> {
    const provider = environmentSpec.hosting.provider;
    const providerMetadata = providerRegistry.getMetadata(provider);
    const branchDeployMetadata = providerMetadata?.orchestration?.nativeBranchDeploy;
    if (
      environmentSpec.deploy?.strategy !== 'branch'
      || environmentSpec.deploy.trigger !== 'native'
      || !branchDeployMetadata?.needsGitHubAppAccess
    ) {
      return [];
    }

    const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
    if (!repo) {
      return [
        'deploy.strategy is "branch" but the project has no GitHub remote (gitRemoteUrl), so the repo-linked deploy source cannot be configured. Set the project git remote or use a different strategy.',
      ];
    }

    const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
    const adapter = adapterResult.adapter as {
      isGitHubRepoAccessible?: (repo: string) => Promise<boolean | null>;
    } | undefined;
    if (!adapterResult.success || typeof adapter?.isGitHubRepoAccessible !== 'function') {
      return [];
    }

    const accessible = await adapter.isGitHubRepoAccessible(repo);
    if (accessible === false) {
      const providerName = providerMetadata?.displayName ?? provider;
      const installUrl = branchDeployMetadata.githubAppInstallUrl
        ?? 'the provider GitHub App installation page';
      return [
        `${providerName}'s GitHub App cannot access ${repo}. Hypervibe can connect the repo via ${providerName}'s API for native deploys, but pushes to GitHub will NOT auto-deploy until ${providerName} can see the repo.`,
        `User action required: install/open the ${providerName} GitHub App at ${installUrl} and grant it access to ${repo}. If the app uses "Only select repositories", add ${repo} to that list.`,
        `User action required: make sure at least one ${providerName} project member has connected GitHub and has contributor access to the repository.`,
        `User action required: accept any pending ${providerName} GitHub App permission updates in GitHub. After changes, wait a few minutes for provider caches to refresh, then rerun hv_status or hv_plan.`,
      ];
    }
    return [];
  }

  private async planRepositoryInfrastructure(
    project: Project,
    environmentName: string,
    specResult: SpecResult,
    options?: PlanOptions
  ): Promise<EnvironmentPlan | { error: string }> {
    if (
      options?.serviceFilter?.length
      || Object.keys(options?.envVarOverrides ?? {}).length > 0
      || options?.envFile
    ) {
      return {
        error: 'The repository project plan does not accept service, environment-variable, or env-file inputs.',
      };
    }

    const delegatedSecretSlots = new Map(
      delegatedSecretInputsForEnvironment(specResult.spec, environmentName)
    );
    const requestedSecretRefs = options?.secretRefs && Object.keys(options.secretRefs).length > 0
      ? options.secretRefs
      : undefined;
    const unknownSecretRefs = Object.keys(requestedSecretRefs ?? {})
      .filter((key) => !delegatedSecretSlots.has(key));
    if (unknownSecretRefs.length > 0) {
      return {
        error: `secretRefs contains keys that are not delegated secret slots for environment "${environmentName}": ${unknownSecretRefs.join(', ')}.`,
      };
    }
    const delegatedSecretValues: Record<string, string> = {};
    try {
      for (const [key, ref] of Object.entries(requestedSecretRefs ?? {})) {
        const value = await resolveSecretValueRef(ref, {
          projectId: project.id,
          environmentName,
        });
        if (!value) {
          return { error: `secretRefs["${key}"] resolved to an empty value.` };
        }
        delegatedSecretValues[key] = value;
      }
    } catch (error) {
      return {
        error: `Failed to resolve delegated secret input: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const projectForPlan = projectWithSpecGitRemoteUrl(project, specResult.spec);
    const github = await planGitHubInfrastructure({
      project: projectForPlan,
      spec: specResult.spec,
      environmentName,
      suppliedSecretValues: delegatedSecretValues,
    });
    const actions = github.actions;
    try {
      orderActions(actions);
    } catch (error) {
      return {
        error: `Hypervibe generated an invalid repository action graph. No plan was saved or provider mutation authorized. ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const specWarnings = specResult.adopted && specResult.source?.kind === 'repo'
      ? [`${specResult.source.path} changed outside hypervibe; recorded as revision ${specResult.revision}.`]
      : [];
    const document: PlanRunDocument = {
      kind: 'hv_plan',
      scope: 'full',
      environmentName,
      specRevision: specResult.revision,
      observedFingerprint: null,
      actions,
      unmanaged: [],
      warnings: [...specWarnings, ...github.warnings],
      ...(github.inputRequired.length > 0 ? { inputRequired: github.inputRequired } : {}),
      ...(Object.keys(delegatedSecretValues).length > 0
        ? {
            overrides: {
              delegatedSecretKeys: Object.keys(delegatedSecretValues).sort(),
              delegatedSecretVarsEncrypted: getSecretStore().encryptObject(delegatedSecretValues),
            },
          }
        : {}),
    };
    const environment = this.envRepo.findByProjectAndName(project.id, environmentName)
      ?? this.envRepo.create({ projectId: project.id, name: environmentName });
    const run = this.runRepo.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: document as unknown as Record<string, unknown>,
    });
    this.runRepo.updateStatus(run.id, 'succeeded');

    return {
      planRunId: run.id,
      scope: 'full',
      specRevision: specResult.revision,
      specSource: specResult.source ?? { kind: 'local' },
      environmentName,
      verified: actions.every((action) => action.verified),
      observed: null,
      actions,
      unmanaged: [],
      warnings: document.warnings ?? [],
      inputRequired: github.inputRequired,
      blocked: [
        ...this.projectPreflight(projectForPlan, specResult.spec, environmentName),
        ...github.blocked,
      ],
    };
  }

  private async planRetainedHostingCleanup(
    project: Project,
    environmentName: string,
    specResult: SpecResult,
    environmentSpec: EnvironmentSpec
  ): Promise<EnvironmentPlan | { error: string }> {
    const projectForPlan = projectWithSpecGitRemoteUrl(project, specResult.spec);
    const environment = this.envRepo.findByProjectAndName(project.id, environmentName);
    if (!environment) {
      return {
        error: `Environment "${environmentName}" has no retained hosting binding to clean up.`,
      };
    }

    const local = this.buildLocalSnapshot(projectForPlan, environment);
    const boundHostingProvider = local.bindings?.provider;
    const previousHosting = local.bindings?.previousHosting;
    const previousProvider = previousHosting?.provider;
    const previousDatabase = local.bindings?.previousDatabase;
    const previousDatabaseProvider = previousDatabase?.provider;
    const previousCache = local.bindings?.previousCache;
    const previousCacheProvider = previousCache?.provider;
    const previousResource = local.bindings?.previousResource;
    const previousResourceProvider = previousResource?.provider;
    if ((!previousProvider || previousProvider === environmentSpec.hosting.provider) && !previousDatabaseProvider && !previousCacheProvider && !previousResourceProvider) {
      return {
        error: `Environment "${environmentName}" has no abandoned hosting provider retained for cleanup and no retained database, cache, or provider-resource target.`,
      };
    }
    if (previousProvider && boundHostingProvider && boundHostingProvider !== environmentSpec.hosting.provider) {
      return {
        error: `The current hosting binding is ${boundHostingProvider}, but the spec selects ${environmentSpec.hosting.provider}. Reconcile that provider switch with a full plan before cleaning up ${previousProvider}.`,
      };
    }

    const { observed, warnings: observeWarnings } = await this.observeEnvironment(
      projectForPlan,
      environment,
      environmentSpec,
      { hostingOnly: true }
    );
    const actions: PlanAction[] = [];
    const cleanupWarnings: string[] = [];
    if (previousProvider && previousHosting && previousProvider !== environmentSpec.hosting.provider) {
      const teardownBoundary = providerRegistry.getMetadata(previousProvider)
        ?.lifecycle?.hosting?.teardownBoundary;
      if (!teardownBoundary) {
        return {
          error: `Cannot plan cleanup for retained hosting provider ${previousProvider} because it does not declare a complete teardown boundary. Hypervibe will not guess which provider resource is safe to delete.`,
        };
      }
      const retainedServices = Object.entries(previousHosting.services ?? {});
      const incompleteServices = retainedServices
        .filter(([, binding]) => !binding?.serviceId && !binding?.jobName)
        .map(([name]) => name);
      if (
        (teardownBoundary === 'services' && retainedServices.length === 0)
        || ((teardownBoundary === 'services' || teardownBoundary === 'project') && incompleteServices.length > 0)
        || ((teardownBoundary === 'environment' || teardownBoundary === 'project') && !previousHosting.projectId)
        || (teardownBoundary === 'environment' && !previousHosting.environmentId)
      ) {
        return {
          error: `The retained ${previousProvider} binding is incomplete for its ${teardownBoundary} cleanup boundary. Re-import the exact provider identity before planning deletion${incompleteServices.length > 0 ? ` (services missing an id: ${incompleteServices.join(', ')})` : ''}.`,
        };
      }
      const cleanup = diffRetainedHostingCleanup({
        envName: environmentName,
        currentProvider: environmentSpec.hosting.provider,
        previousHosting,
        teardownBoundary,
      });
      if (cleanup.actions.length === 0) {
        return {
          error: `The retained ${previousProvider} binding contains no complete ${teardownBoundary} cleanup target. Re-import the exact retained cleanup identity before planning deletion.`,
        };
      }
      actions.push(...cleanup.actions);
      cleanupWarnings.push(...cleanup.warnings);
    }

    let retainedDatabaseVerified = true;
    if (previousDatabaseProvider) {
      const externalId = previousDatabase?.externalId;
      const engine = previousDatabase?.engine;
      const providerScope = previousDatabase?.providerScope;
      if (
        !externalId
        || engine !== 'postgres'
        || !providerScope
        || Object.keys(providerScope).length === 0
        || Object.entries(providerScope).some(([key, value]) => (
          !key.trim() || typeof value !== 'string' || !value.trim()
        ))
      ) {
        return {
          error: `The retained ${previousDatabaseProvider} database binding is incomplete. Re-import one exact database id and provider scope before planning deletion.`,
        };
      }
      let blockedReason: string | undefined;
      const adapterResult = await adapterFactory.getDatabaseAdapter(previousDatabaseProvider, projectForPlan);
      if (!adapterResult.success || !adapterResult.adapter) {
        retainedDatabaseVerified = false;
        blockedReason = 'retained_database_connection_unavailable';
        cleanupWarnings.push(`Retained database ${externalId} could not be re-observed: ${adapterResult.error ?? 'database adapter unavailable'}.`);
      } else {
        const retainedComponent: Component = {
          id: `retained:${externalId}`,
          environmentId: environment.id,
          type: engine,
          externalId,
          bindings: {
            provider: previousDatabaseProvider,
            instanceId: externalId,
            providerScope,
            retainedCleanup: true,
          },
          createdAt: environment.createdAt,
          updatedAt: environment.updatedAt,
        };
        try {
          const retainedObserved = await adapterResult.adapter.observeDatabase(environment, retainedComponent);
          if (retainedObserved && retainedObserved.externalId !== externalId) {
            throw new Error(`provider returned ${retainedObserved.externalId} for retained id ${externalId}`);
          }
          if (retainedObserved && !retainedObserved.providerScope) {
            throw new Error(`provider omitted the durable scope for retained id ${externalId}`);
          }
          if (retainedObserved?.providerScope) {
            const expectedScope = JSON.stringify(Object.entries(providerScope).sort());
            const observedScope = JSON.stringify(Object.entries(retainedObserved.providerScope).sort());
            if (expectedScope !== observedScope) {
              throw new Error(`provider scope changed from ${expectedScope} to ${observedScope}`);
            }
          }
        } catch (error) {
          retainedDatabaseVerified = false;
          blockedReason = 'retained_database_observation_unknown';
          cleanupWarnings.push(`Retained database ${externalId} observation is unknown: ${error instanceof Error ? error.message : String(error)}.`);
        } finally {
          await adapterResult.adapter.disconnect?.();
        }
      }
      actions.push({
        id: `database:${previousDatabaseProvider}:retained-destroy`,
        type: 'destroy',
        resource: { kind: 'database', name: engine, provider: previousDatabaseProvider },
        verified: retainedDatabaseVerified,
        reason: `Delete exact retained ${previousDatabaseProvider} database ${externalId} in its recorded provider scope`,
        dataBearing: true,
        requiresConfirm: true,
        metadata: {
          operation: 'retainedDatabaseDestroy',
          externalId,
          providerScope,
          ...(blockedReason ? { blockedReason } : {}),
        },
      });
    }
    let retainedCacheVerified = true;
    if (previousCacheProvider) {
      const externalId = previousCache?.externalId;
      const engine = previousCache?.engine;
      const providerEngine = previousCache?.providerEngine;
      const name = previousCache?.name;
      const resourceKind = previousCache?.resourceKind;
      const providerScope = previousCache?.providerScope;
      if (
        !externalId
        || engine !== 'redis'
        || !name
        || !providerScope
        || Object.keys(providerScope).length === 0
        || Object.entries(providerScope).some(([key, value]) => (
          !key.trim() || typeof value !== 'string' || !value.trim()
        ))
      ) {
        return {
          error: `The retained ${previousCacheProvider} cache binding is incomplete. Re-import one exact cache id, name, engine, and provider scope before planning deletion.`,
        };
      }
      let blockedReason: string | undefined;
      const adapterResult = await adapterFactory.getCacheAdapter(previousCacheProvider, projectForPlan);
      if (!adapterResult.success || !adapterResult.adapter) {
        retainedCacheVerified = false;
        blockedReason = 'retained_cache_connection_unavailable';
        cleanupWarnings.push(`Retained cache ${externalId} could not be re-observed: ${adapterResult.error ?? 'cache adapter unavailable'}.`);
      } else {
        const retainedComponent: Component = {
          id: `retained:${externalId}`,
          environmentId: environment.id,
          type: 'redis',
          externalId,
          bindings: {
            provider: previousCacheProvider,
            instanceId: externalId,
            providerScope,
            retainedCleanup: true,
            ...(resourceKind ? { resourceKind } : {}),
          },
          createdAt: environment.createdAt,
          updatedAt: environment.updatedAt,
        };
        try {
          const retainedObserved = await adapterResult.adapter.observeCache(environment, retainedComponent);
          if (retainedObserved) {
            if (retainedObserved.provider !== previousCacheProvider) {
              throw new Error(`provider returned ${retainedObserved.provider} for retained ${previousCacheProvider} cache`);
            }
            if (retainedObserved.engine !== engine) {
              throw new Error(`provider returned engine ${retainedObserved.engine} for retained ${engine} cache`);
            }
            if (retainedObserved.externalId !== externalId) {
              throw new Error(`provider returned ${retainedObserved.externalId} for retained id ${externalId}`);
            }
            if (retainedObserved.name !== name) {
              throw new Error(`provider returned name ${retainedObserved.name ?? '(missing)'} for retained cache ${name}`);
            }
            if (!retainedObserved.providerScope) {
              throw new Error(`provider omitted the durable scope for retained id ${externalId}`);
            }
            const expectedScope = JSON.stringify(Object.entries(providerScope).sort());
            const observedScope = JSON.stringify(Object.entries(retainedObserved.providerScope).sort());
            if (expectedScope !== observedScope) {
              throw new Error(`provider scope changed from ${expectedScope} to ${observedScope}`);
            }
          }
        } catch (error) {
          retainedCacheVerified = false;
          blockedReason = 'retained_cache_observation_unknown';
          cleanupWarnings.push(`Retained cache ${externalId} observation is unknown: ${error instanceof Error ? error.message : String(error)}.`);
        } finally {
          await adapterResult.adapter.disconnect?.();
        }
      }
      actions.push({
        id: `cache:${previousCacheProvider}:retained-destroy`,
        type: 'destroy',
        resource: { kind: 'cache', name: engine, provider: previousCacheProvider },
        verified: retainedCacheVerified,
        reason: `Delete exact retained ${previousCacheProvider} cache ${externalId} in its recorded provider scope`,
        dataBearing: true,
        requiresConfirm: true,
        metadata: {
          operation: CACHE_OPERATIONS.retainedDestroy,
          externalId,
          name,
          engine,
          providerScope,
          ...(providerEngine ? { providerEngine } : {}),
          ...(resourceKind ? { resourceKind } : {}),
          ...(blockedReason ? { blockedReason } : {}),
        },
      });
    }
    let retainedResourceVerified = true;
    if (previousResourceProvider) {
      const resource = previousResource?.resource;
      const externalId = previousResource?.externalId;
      const name = previousResource?.name;
      const providerScope = previousResource?.providerScope;
      const registration = providerRegistry.get(previousResourceProvider);
      const contract = resource ? registration?.inspection?.selectors[resource] : undefined;
      if (
        !resource
        || !externalId
        || !name
        || !providerScope
        || Object.keys(providerScope).length === 0
        || Object.values(providerScope).some((value) => typeof value !== 'string' || !value)
        || !registration?.retainedCleanup?.resources.includes(resource)
        || !contract?.collectionKey
      ) {
        return {
          error: `The retained ${previousResourceProvider} provider-resource binding is incomplete or no longer supported. Re-import one exact resource id and provider scope before planning deletion.`,
        };
      }
      let blockedReason: string | undefined;
      const adapterResult = await adapterFactory.getProviderAdapter(previousResourceProvider, projectForPlan);
      if (!adapterResult.success || !adapterResult.adapter) {
        retainedResourceVerified = false;
        blockedReason = 'retained_resource_connection_unavailable';
        cleanupWarnings.push(`Retained ${resource} ${externalId} could not be re-observed: ${adapterResult.error ?? 'provider adapter unavailable'}.`);
      } else {
        try {
          const inspected = await registration.inspection!.inspect(adapterResult.adapter, {
            resource,
            id: externalId,
            region: providerScope.region ?? providerScope.location,
            limit: 1,
            project: { id: project.id, name: project.name },
          });
          const items = Array.isArray(inspected[contract.collectionKey])
            ? inspected[contract.collectionKey] as unknown[]
            : [];
          const exact = items.filter((item) => {
            const candidate = item && typeof item === 'object' && !Array.isArray(item)
              ? item as Record<string, unknown>
              : undefined;
            return candidate?.id === externalId;
          });
          if (
            inspected.resource !== resource
            || inspected.partial !== false
            || inspected.truncated !== false
            || !['present', 'absent'].includes(String(inspected.observation))
          ) {
            throw new Error('provider returned an incomplete or unknown observation');
          }
          if (inspected.observation === 'present') {
            if (exact.length !== 1) throw new Error(`provider did not return exactly one retained id ${externalId}`);
            const liveScope = exact[0] && typeof exact[0] === 'object' && !Array.isArray(exact[0])
              ? (exact[0] as Record<string, unknown>).providerScope
              : undefined;
            if (!liveScope || typeof liveScope !== 'object' || Array.isArray(liveScope)) {
              throw new Error(`provider omitted durable scope for retained id ${externalId}`);
            }
            const expectedScope = JSON.stringify(Object.entries(providerScope).sort());
            const observedScope = JSON.stringify(Object.entries(liveScope as Record<string, unknown>).sort());
            if (expectedScope !== observedScope) {
              throw new Error(`provider scope changed from ${expectedScope} to ${observedScope}`);
            }
          } else if (items.length > 0) {
            throw new Error('provider reported absence with a non-empty resource collection');
          }
        } catch (error) {
          retainedResourceVerified = false;
          blockedReason = 'retained_resource_observation_unknown';
          cleanupWarnings.push(`Retained ${resource} ${externalId} observation is unknown: ${error instanceof Error ? error.message : String(error)}.`);
        } finally {
          await adapterResult.adapter.disconnect?.();
        }
      }
      actions.push({
        id: `retained-resource:${previousResourceProvider}:${resource}:destroy`,
        type: 'destroy',
        resource: { kind: 'retained-resource', name: resource, provider: previousResourceProvider },
        verified: retainedResourceVerified,
        reason: `Delete exact retained ${previousResourceProvider} ${resource} ${externalId} in its recorded provider scope`,
        dataBearing: true,
        requiresConfirm: true,
        metadata: {
          operation: 'retainedResourceDestroy',
          resource,
          externalId,
          name,
          providerScope,
          ...(blockedReason ? { blockedReason } : {}),
        },
      });
    }
    const retainedDependentCleanupIds = actions
      .filter((action) => (
        action.metadata?.operation === 'retainedDatabaseDestroy'
        || action.metadata?.operation === CACHE_OPERATIONS.retainedDestroy
        || action.metadata?.operation === 'retainedResourceDestroy'
      ))
      .map((action) => action.id);
    if (retainedDependentCleanupIds.length > 0) {
      for (const action of actions) {
        if (action.metadata?.operation !== 'previousHostingDestroy') continue;
        action.dependsOn = Array.from(new Set([
          ...(action.dependsOn ?? []),
          ...retainedDependentCleanupIds,
        ]));
      }
    }
    try {
      orderActions(actions);
    } catch (error) {
      return {
        error: `Hypervibe generated an invalid retained-cleanup action graph. No plan was saved or provider mutation authorized. ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const specWarnings = specResult.adopted && specResult.source?.kind === 'repo'
      ? [`${specResult.source.path} changed outside hypervibe; recorded as revision ${specResult.revision}.`]
      : [];
    const warnings = Array.from(new Set([
      ...specWarnings,
      ...observeWarnings,
      ...(observed?.warnings ?? []),
      ...cleanupWarnings,
    ]));
    const document: PlanRunDocument = {
      kind: 'hv_plan',
      scope: 'retained-cleanup',
      environmentName,
      specRevision: specResult.revision,
      observedFingerprint: observed ? fingerprintObservedState(observed) : null,
      actions,
      unmanaged: [],
      warnings,
    };
    const run = this.runRepo.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: document as unknown as Record<string, unknown>,
    });
    this.runRepo.updateStatus(run.id, 'succeeded');

    return {
      planRunId: run.id,
      scope: 'retained-cleanup',
      specRevision: specResult.revision,
      specSource: specResult.source ?? { kind: 'local' },
      environmentName,
      verified: observed !== null && !observed.partial && retainedDatabaseVerified && retainedCacheVerified && retainedResourceVerified,
      observed,
      actions,
      unmanaged: [],
      warnings,
      inputRequired: [],
      blocked: this.providerPreflight([
        environmentSpec.hosting.provider,
        ...(previousProvider ? [previousProvider] : []),
        ...(previousDatabaseProvider ? [previousDatabaseProvider] : []),
        ...(previousCacheProvider ? [previousCacheProvider] : []),
        ...(previousResourceProvider ? [previousResourceProvider] : []),
      ]),
    };
  }

  async plan(
    project: Project,
    environmentName: string,
    options?: PlanOptions
  ): Promise<EnvironmentPlan | { error: string }> {
    const specResult = this.specStore.get(project);
    if (!specResult) {
      return { error: `Project "${project.name}" has no spec. Set one with hv_spec.` };
    }
    const providerValidation = firstProviderSpecValidationFailure(specResult.spec);
    if (providerValidation) {
      return { error: providerValidation.message };
    }
    const scope = options?.scope ?? 'full';
    if (scope === 'retained-cleanup') {
      const incompatibleInputs = [
        options && Object.prototype.hasOwnProperty.call(options, 'serviceFilter') ? 'services' : null,
        options && Object.prototype.hasOwnProperty.call(options, 'envVarOverrides') ? 'envVars' : null,
        options && Object.prototype.hasOwnProperty.call(options, 'envFile') ? 'envFile' : null,
        options && Object.prototype.hasOwnProperty.call(options, 'includeEnvFile') ? 'includeEnvFile' : null,
        options && Object.prototype.hasOwnProperty.call(options, 'secretRefs') ? 'secretRefs' : null,
      ].filter((name): name is string => Boolean(name));
      if (incompatibleInputs.length > 0) {
        return {
          error: `scope="retained-cleanup" does not accept deploy inputs: ${incompatibleInputs.join(', ')}. Remove them so the plan can authorize only retained infrastructure teardown actions.`,
        };
      }
    }
    const projectForPlan = projectWithSpecGitRemoteUrl(project, specResult.spec);
    if (scope !== 'retained-cleanup') {
      const codeRepository = await planManagedCodeRepository({
        project: projectForPlan,
        spec: specResult.spec,
        environmentName,
      });
      if (codeRepository.error) return { error: codeRepository.error };
      if (codeRepository.stageRequired && codeRepository.action) {
        const incompatibleInputs = [
          options?.serviceFilter?.length ? 'services' : null,
          Object.keys(options?.envVarOverrides ?? {}).length > 0 ? 'envVars' : null,
          options?.envFile ? 'envFile' : null,
          options?.includeEnvFile === false ? 'includeEnvFile' : null,
          Object.keys(options?.secretRefs ?? {}).length > 0 ? 'secretRefs' : null,
        ].filter((name): name is string => Boolean(name));
        if (incompatibleInputs.length > 0) {
          return {
            error: `Repository lifecycle is an isolated plan stage and does not accept deploy inputs: ${incompatibleInputs.join(', ')}.`,
          };
        }
        const actions = [codeRepository.action];
        const warnings = [
          ...(specResult.adopted && specResult.source?.kind === 'repo'
            ? [`${specResult.source.path} changed outside hypervibe; recorded as revision ${specResult.revision}.`]
            : []),
          ...(codeRepository.warning ? [codeRepository.warning] : []),
        ];
        const document: PlanRunDocument = {
          kind: 'hv_plan',
          scope: 'full',
          environmentName,
          specRevision: specResult.revision,
          observedFingerprint: null,
          actions,
          unmanaged: [],
          warnings,
        };
        const lifecycleEnvironment = this.envRepo.findByProjectAndName(project.id, environmentName)
          ?? this.envRepo.create({ projectId: project.id, name: environmentName });
        const run = this.runRepo.create({
          projectId: project.id,
          environmentId: lifecycleEnvironment.id,
          type: 'plan',
          plan: document as unknown as Record<string, unknown>,
        });
        this.runRepo.updateStatus(run.id, 'succeeded');
        return {
          planRunId: run.id,
          scope: 'full',
          specRevision: specResult.revision,
          specSource: specResult.source ?? { kind: 'local' },
          environmentName,
          verified: codeRepository.action.verified,
          observed: null,
          actions,
          unmanaged: [],
          warnings,
          inputRequired: [],
          blocked: [],
        };
      }
    }
    const environmentSpec = specResult.spec.environments[environmentName];
    if (!environmentSpec) {
      if (scope === 'retained-cleanup') {
        return {
          error: `scope="retained-cleanup" requires a declared environment; spec has no environment "${environmentName}".`,
        };
      }
      if (shouldPlanGitHubInfrastructure(specResult.spec, environmentName)) {
        return this.planRepositoryInfrastructure(project, environmentName, specResult, options);
      }
      const available = Object.keys(specResult.spec.environments);
      return {
        error: `Spec has no environment "${environmentName}". Available: ${available.join(', ') || '(none)'}.`,
      };
    }
    if (scope === 'retained-cleanup') {
      return this.planRetainedHostingCleanup(project, environmentName, specResult, environmentSpec);
    }
    const serviceFilter = options?.serviceFilter?.length ? options.serviceFilter : undefined;
    if (serviceFilter) {
      const unknown = serviceFilter.filter((name) => !environmentSpec.services[name]);
      if (unknown.length > 0) {
        return {
          error: `services filter names not in the spec: ${unknown.join(', ')}. Available: ${Object.keys(environmentSpec.services).join(', ') || '(none)'}.`,
        };
      }
    }
    const delegatedSecretSlots = new Map(delegatedSecretInputsForEnvironment(specResult.spec, environmentName));
    const requestedSecretRefs = options?.secretRefs && Object.keys(options.secretRefs).length > 0
      ? options.secretRefs
      : undefined;
    if (serviceFilter && requestedSecretRefs) {
      return {
        error: 'Delegated secret inputs require a full environment plan; remove services= and re-run hv_plan with secretRefs.',
      };
    }
    const envVarOverrides = options?.envVarOverrides && Object.keys(options.envVarOverrides).length > 0
      ? options.envVarOverrides
      : undefined;
    const retiredEnvKeys = new Set(environmentSpec.removeEnvVars ?? []);
    const retiredOverrideCollisions = Object.keys(envVarOverrides ?? {})
      .filter((key) => retiredEnvKeys.has(key));
    if (retiredOverrideCollisions.length > 0) {
      return {
        error: `envVars cannot supply explicitly retired keys: ${retiredOverrideCollisions.join(', ')}. Remove the override or remove the key from removeEnvVars.`,
      };
    }
    const stripeOverrideCollisions = Object.keys(envVarOverrides ?? {})
      .filter((key) => stripeManagedEnvKeys(environmentSpec).includes(key));
    if (stripeOverrideCollisions.length > 0) {
      return {
        error: `Stripe-managed keys cannot be passed through envVars: ${stripeOverrideCollisions.join(', ')}. Configure environments.${environmentName}.payments.stripe instead.`,
      };
    }
    const emailOverrideCollisions = environmentSpec.email.enabled
      ? Object.keys(envVarOverrides ?? {})
        .filter((key) => (EMAIL_MANAGED_ENV_KEYS as readonly string[]).includes(key))
      : [];
    if (emailOverrideCollisions.length > 0) {
      return {
        error: `Email-managed keys cannot be passed through envVars: ${emailOverrideCollisions.join(', ')}. Configure environments.${environmentName}.email instead.`,
      };
    }
    const messagingOverrideCollisions = environmentSpec.messaging
      ? Object.keys(envVarOverrides ?? {})
        .filter((key) => (MESSAGING_MANAGED_ENV_KEYS as readonly string[]).includes(key))
      : [];
    if (messagingOverrideCollisions.length > 0) {
      return {
        error: `Messaging-managed keys cannot be passed through envVars: ${messagingOverrideCollisions.join(', ')}. Configure environments.${environmentName}.messaging instead.`,
      };
    }
    const delegatedOverrideCollisions = Object.keys(envVarOverrides ?? {}).filter((key) => delegatedSecretSlots.has(key));
    if (delegatedOverrideCollisions.length > 0) {
      return {
        error: `Delegated secret keys cannot be passed through envVars: ${delegatedOverrideCollisions.join(', ')}. Use secretRefs with env:, dotenv:, file:, or a secret-manager reference.`,
      };
    }
    const unknownSecretRefs = Object.keys(requestedSecretRefs ?? {}).filter((key) => !delegatedSecretSlots.has(key));
    if (unknownSecretRefs.length > 0) {
      return {
        error: `secretRefs contains keys that are not delegated secret slots for environment "${environmentName}": ${unknownSecretRefs.join(', ')}.`,
      };
    }
    const delegatedSecretValues: Record<string, string> = {};
    try {
      for (const [key, ref] of Object.entries(requestedSecretRefs ?? {})) {
        const value = await resolveSecretValueRef(ref, {
          projectId: project.id,
          environmentName,
        });
        if (!value) {
          return { error: `secretRefs["${key}"] resolved to an empty value.` };
        }
        delegatedSecretValues[key] = value;
      }
    } catch (error) {
      return {
        error: `Failed to resolve delegated secret input: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let envFile: ReturnType<typeof loadDeployEnvFile> = null;
    try {
      const envFilePolicy = environmentSpec.envFile;
      const implicitEnvFileDisabled = !options?.envFile
        && options?.includeEnvFile === undefined
        && process.env.HYPERVIBE_DISABLE_IMPLICIT_DEPLOY_ENV_FILE === '1';
      const implicitEnvFilePath = !options?.envFile
        && options?.includeEnvFile !== false
        && !implicitEnvFileDisabled
        && envFilePolicy?.mode !== 'off'
        ? defaultDeployEnvFilePath(undefined, environmentName)
        : null;
      const selectedRepository = normalizeGitRemoteIdentity(projectForPlan.gitRemoteUrl);
      if (implicitEnvFilePath) {
        const currentRepository = normalizeGitRemoteIdentity(detectGitRemoteUrl() ?? undefined);
        if (!currentRepository || !selectedRepository || currentRepository !== selectedRepository) {
          return {
            error: `Refusing implicit deploy env-file access to ${implicitEnvFilePath}: current repository "${currentRepository ?? 'unknown'}" does not match selected project "${project.name}" repository "${selectedRepository ?? 'unknown'}". Run Hypervibe from the selected project's checkout, pass an explicit envFile, set includeEnvFile=false, or configure envFile.mode="off". No env file was loaded or created.`,
          };
        }
      }
      const excludedEnvKeys = Array.from(new Set([
        ...(envFilePolicy?.exclude ?? []),
        ...delegatedSecretSlots.keys(),
        ...retiredEnvKeys,
      ]));
      envFile = loadDeployEnvFile({
        envFile: options?.envFile,
        includeEnvFile: options?.includeEnvFile === false || implicitEnvFileDisabled
          ? false
          : envFilePolicy?.mode !== 'off',
        mode: envFilePolicy?.mode,
        includeKeys: envFilePolicy?.include,
        excludeKeys: excludedEnvKeys,
        envName: environmentName,
      });
    } catch (error) {
      return {
        error: `Failed to load deploy env file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const specWarnings = specResult.adopted && specResult.source?.kind === 'repo'
      ? [`${specResult.source.path} changed outside hypervibe; recorded as revision ${specResult.revision}.`]
      : [];

    const environment = this.envRepo.findByProjectAndName(project.id, environmentName);
    const sharedProjectBinding = this.sharedProjectBindingForEnvironment(
      projectForPlan,
      environmentName,
      environment,
      environmentSpec.hosting.provider
    );
    if ('error' in sharedProjectBinding) {
      return { error: sharedProjectBinding.error };
    }
    const effectiveBindings = sharedProjectBinding.bindings
      ? {
        ...(environment?.platformBindings ?? {}),
        ...sharedProjectBinding.bindings,
      }
      : environment?.platformBindings;
    const effectiveBindingRecord = effectiveBindings ?? {};
    const boundHostingProvider = recordValue(effectiveBindingRecord, 'provider');
    const retainedPreviousHosting = recordMapValue(effectiveBindingRecord, 'previousHosting');
    const retainedPreviousProvider = recordValue(retainedPreviousHosting, 'provider');
    const previousHostingTeardownBoundary = retainedPreviousProvider
      ? providerRegistry.getMetadata(retainedPreviousProvider)?.lifecycle?.hosting?.teardownBoundary
      : undefined;
    if (retainedPreviousProvider && !previousHostingTeardownBoundary) {
      return {
        error: `Cannot plan cleanup for retained hosting provider ${retainedPreviousProvider} because it does not declare a complete teardown boundary. Hypervibe will not guess which provider resource is safe to delete.`,
      };
    }
    if (
      boundHostingProvider
      && boundHostingProvider !== environmentSpec.hosting.provider
      && retainedPreviousProvider
    ) {
      return {
        error: `Cannot switch hosting from ${boundHostingProvider} to ${environmentSpec.hosting.provider} while cleanup from ${retainedPreviousProvider} is still retained. Finish or explicitly resolve the previous-provider teardown first so Hypervibe does not lose its only cleanup binding.`,
      };
    }
    let environmentForObserve = environment;
    if (sharedProjectBinding.bindings) {
      if (environment) {
        environmentForObserve = this.envRepo.updatePlatformBindings(environment.id, sharedProjectBinding.bindings) ?? {
          ...environment,
          platformBindings: effectiveBindingRecord,
        };
      } else {
        environmentForObserve = {
          id: `untracked:${environmentName}`,
          projectId: project.id,
          name: environmentName,
          platformBindings: effectiveBindingRecord,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
    }
    const { observed, warnings: observeWarnings } = await this.observeEnvironment(projectForPlan, environmentForObserve, environmentSpec);
    const maintenance = observed && environmentForObserve
      ? planMaintenance({
          environmentName,
          environmentSpec,
          environment: environmentForObserve,
          observed,
        })
      : {
          actions: [],
          pending: Boolean(environmentSpec.maintenance?.enabled),
          providers: [],
          warnings: [],
        };
    if (maintenance.pending && serviceFilter) {
      return {
        error: 'Environment maintenance must use a full environment plan. Remove services= and re-run hv_plan.',
      };
    }
    const delegatedSecrets = serviceFilter
      ? { actions: [], desiredEnvVars: {}, inputRequired: [], warnings: [] }
      : planDelegatedSecrets({
        spec: specResult.spec,
        environmentName,
        hostingProvider: environmentSpec.hosting.provider,
        environment: environmentForObserve,
        observed,
        suppliedValues: delegatedSecretValues,
      });
    const local = this.buildLocalSnapshot(projectForPlan, environment, effectiveBindings);
    const localDatabase = local.components.find((component) => component.type === 'postgres');
    const localDatabaseProvider = recordValue(localDatabase?.bindings, 'provider');
    const localDatabaseProjectId = componentProjectId(localDatabase);
    const localHostingProjectId = recordValue(local.bindings, 'projectId');
    const localDatabaseProviderId = componentProviderId(localDatabase);
    const databaseSharesHostingScope =
      localDatabaseProvider === environmentSpec.hosting.provider
      && Boolean(localDatabaseProjectId)
      && Boolean(localHostingProjectId)
      && localDatabaseProjectId === localHostingProjectId;
    const conflictingServiceBinding = databaseSharesHostingScope && localDatabaseProviderId
      ? Object.entries(local.bindings?.services ?? {}).find(
        ([, binding]) => binding.serviceId === localDatabaseProviderId
      )
      : undefined;
    if (conflictingServiceBinding) {
      const [serviceName, binding] = conflictingServiceBinding;
      return {
        error: `Provider id ${binding.serviceId} is bound as both the database and application service ${serviceName}. Repair the conflicting durable bindings before reconciliation.`,
      };
    }
    const sourceEnvironmentName = environmentSpec.dataMigration?.fromEnvironment;
    const sourceEnvironmentSpec = sourceEnvironmentName
      ? specResult.spec.environments[sourceEnvironmentName]
      : undefined;
    const sourceEnvironment = sourceEnvironmentName
      ? this.envRepo.findByProjectAndName(project.id, sourceEnvironmentName)
      : null;
    const sourceObservation = sourceEnvironmentSpec && sourceEnvironment
      ? await this.observeEnvironment(projectForPlan, sourceEnvironment, sourceEnvironmentSpec)
      : null;
    const sourceMaintenanceWarnings = sourceObservation?.warnings ?? [];
    const dataMigration = sourceEnvironmentSpec
      ? planDataMigration({
          targetEnvironmentName: environmentName,
          targetSpec: environmentSpec,
          targetEnvironment: environment,
          targetComponents: local.components,
          sourceSpec: sourceEnvironmentSpec,
          sourceEnvironment,
          sourceComponents: sourceEnvironment
            ? this.componentRepo.findByEnvironmentId(sourceEnvironment.id)
            : [],
          sourceMaintenance: sourceObservation?.observed?.maintenance,
          targetMaintenance: observed?.maintenance,
        })
      : { actions: [], pending: false, providers: [], warnings: [] };
    if (dataMigration.pending && serviceFilter) {
      return {
        error: `Data migration "${environmentSpec.dataMigration?.id}" must use a full environment plan. Remove services= and re-run hv_plan.`,
      };
    }
    const managedDatabaseEnvVars = buildManagedDatabaseEnvVars(
      environmentSpec.database,
      local.components
    );
    const localCache = local.components.find((component) => component.type === 'redis');
    const localCacheProvider = localCache
      ? String((localCache.bindings as Record<string, unknown>).provider ?? '') || undefined
      : undefined;
    const managedCacheEnvVars = environmentSpec.cache && localCache && localCacheProvider === environmentSpec.cache.provider
      ? buildCacheEnvVarsFromComponent(localCache).envVars
      : undefined;
    const managedQueueEnvVars = await resolveQueueEnvVars(projectForPlan, environmentSpec, environment);
    const managedEnvKeys = new Set([
      ...Object.keys(managedDatabaseEnvVars ?? {}),
      ...Object.values(environmentSpec.services)
        .flatMap((service) => Object.keys(service.databaseEnvAliases ?? {})),
      ...Object.keys(managedCacheEnvVars ?? {}),
      ...Object.keys(managedQueueEnvVars ?? {}),
      ...delegatedSecretSlots.keys(),
      ...stripeManagedEnvKeys(environmentSpec),
      ...(environmentSpec.email.enabled ? EMAIL_MANAGED_ENV_KEYS : []),
      ...(environmentSpec.messaging ? MESSAGING_MANAGED_ENV_KEYS : []),
      ...(environmentSpec.database ? DATABASE_ENV_KEYS : []),
      ...(environmentSpec.cache ? CACHE_ENV_KEYS : []),
      ...(environmentSpec.queues && Object.keys(environmentSpec.queues).length > 0
        ? [
          'QUEUE_BACKEND',
          'QUEUE_NAMES',
          ...Object.keys(environmentSpec.queues).flatMap((name) => {
            const suffix = queueEnvVarSuffix(name);
            return [`QUEUE_TOPIC_${suffix}`, `QUEUE_SUBSCRIPTION_${suffix}`];
          }),
        ]
        : []),
      ...(environmentSpec.storage && Object.keys(environmentSpec.storage).length > 0
        ? storageEnvKeys(Object.keys(environmentSpec.storage)[0])
        : []),
      ...(projectForPlan.gitRemoteUrl
        ? ['HYPERVIBE_SOURCE_REPO_URL', 'HYPERVIBE_SOURCE_REVISION', 'HYPERVIBE_GITHUB_TOKEN']
        : []),
    ]);
    const retiredManagedKeys = (environmentSpec.removeEnvVars ?? [])
      .filter((key) => managedEnvKeys.has(key));
    if (retiredManagedKeys.length > 0) {
      return {
        error: `removeEnvVars cannot retire Hypervibe-managed infrastructure keys: ${retiredManagedKeys.join(', ')}. Remove or reconfigure the owning database, cache, queue, storage, delegated secret, or source integration instead.`,
      };
    }
    const envFileVars = envFile && Object.keys(envFile.vars).length > 0
      ? Object.fromEntries(Object.entries(envFile.vars).filter(([key]) => !managedEnvKeys.has(key)))
      : undefined;
    // Env sources feed the diff so env drift reflects what apply will sync;
    // the base spec is untouched (preflight, CI, and domain planning see the
    // declared state). Precedence at apply is: .env < generated infra vars
    // < spec envVars < explicit envVars overrides.
    const specForDiff = envFileVars || envVarOverrides || Object.keys(delegatedSecrets.desiredEnvVars).length > 0
      ? {
        ...environmentSpec,
        envVars: {
          ...(envFileVars ?? {}),
          ...environmentSpec.envVars,
          ...(envVarOverrides ?? {}),
          ...delegatedSecrets.desiredEnvVars,
        },
      }
      : environmentSpec;

    const hostingMetadata = providerRegistry.getMetadata(environmentSpec.hosting.provider);
    const databaseConnectivity = environmentSpec.database
      ? providerRegistry.getMetadata(environmentSpec.database.provider)
        ?.lifecycle?.databaseConnectivity
      : undefined;
    const cacheConnectivity = environmentSpec.cache
      ? providerRegistry.getMetadata(environmentSpec.cache.provider)
        ?.lifecycle?.cacheConnectivity
      : undefined;
    const diff = diffEnvironment({
      spec: specForDiff,
      envName: environmentName,
      observed,
      local,
      providerBehavior: hostingMetadata?.orchestration?.diff,
      previousHostingTeardownBoundary,
      customDomainManagement: hostingMetadata?.lifecycle?.hosting?.customDomains,
      customDomainTrafficProxy: hostingMetadata?.lifecycle?.hosting?.domainTrafficProxy,
      expectedSource: this.expectedDeploySource(projectForPlan, environmentName, environmentSpec),
      managedDatabaseEnvVars,
      managedCacheEnvVars,
      managedQueueEnvVars,
      projectRuntime: specResult.spec.runtime,
      databaseDependsOnHostingProject: Boolean(
        databaseConnectivity?.compatibleHostingProviders.includes(
          environmentSpec.hosting.provider
        )
      ),
    });
    const cache = planCache({
      environmentSpec,
      observed,
      local,
      projectDependency: diff.actions.some((action) =>
        action.id === `project:${environmentSpec.hosting.provider}`
      ) && Boolean(
        environmentSpec.cache
        && (
          environmentSpec.cache.provider === environmentSpec.hosting.provider
          || cacheConnectivity?.compatibleHostingProviders.includes(
            environmentSpec.hosting.provider
          )
        )
      )
        ? [`project:${environmentSpec.hosting.provider}`]
        : undefined,
    });
    const databaseResilience = planDatabaseResilience({
      environmentSpec,
      observed,
      local,
      capabilities: providerRegistry.getMetadata(environmentSpec.database?.provider ?? '')
        ?.lifecycle?.databaseResilience,
    });
    const nativeDeploySources = planProviderNativeDeploySources({
      environmentSpec,
      observed,
      providerDisplayName: hostingMetadata?.displayName ?? environmentSpec.hosting.provider,
      nonNativeSourcePolicy: hostingMetadata?.orchestration?.nativeBranchDeploy?.nonNativeSourcePolicy,
    });
    const blocked: EnvironmentPlan['blocked'] = maintenance.pending
      ? this.providerPreflight(maintenance.providers)
      : dataMigration.pending
      ? this.providerPreflight(dataMigration.providers)
      : [
          ...this.preflight(environmentSpec, environmentName, specResult.spec),
          ...this.projectPreflight(projectForPlan, specResult.spec, environmentName),
        ];
    const sourceWarnings = await this.checkBranchDeploySource(projectForPlan, environmentSpec);
    const domainRegistration = await planCloudflareDomainRegistration({ environmentSpec, environment });

    let actions: PlanAction[] = [
      ...(domainRegistration.action ? [domainRegistration.action] : []),
      ...nativeDeploySources.actions,
      ...diff.actions,
      ...maintenance.actions,
    ];
    if (databaseResilience.actions.length > 0) {
      const firstServiceIndex = actions.findIndex((action) => action.resource.kind === 'service');
      if (firstServiceIndex === -1) actions.push(...databaseResilience.actions);
      else actions.splice(firstServiceIndex, 0, ...databaseResilience.actions);
    }
    if (cache.actions.length > 0) {
      const firstServiceIndex = actions.findIndex((action) => action.resource.kind === 'service');
      if (firstServiceIndex === -1) actions.push(...cache.actions);
      else actions.splice(firstServiceIndex, 0, ...cache.actions);
    }
    if (cache.serviceDependency) {
      const dependencyAction = actions.find((action) => action.id === cache.serviceDependency);
      const dependencyBlocked = typeof dependencyAction?.metadata?.blockedReason === 'string';
      for (const serviceAction of actions.filter((action) =>
        action.resource.kind === 'service'
        && action.type !== 'destroy'
        && !action.id.includes(':env-remove')
      )) {
        if (serviceAction.type === 'noop' && !dependencyBlocked) {
          serviceAction.type = 'update';
          serviceAction.reason = `${serviceAction.reason}; wire the newly created ${environmentSpec.cache?.provider} Redis cache`;
        }
        serviceAction.dependsOn = Array.from(new Set([
          ...(serviceAction.dependsOn ?? []),
          cache.serviceDependency,
        ]));
      }
    }
    if (databaseResilience.serviceDependencies.length > 0) {
      for (const serviceAction of actions.filter((action) =>
        action.resource.kind === 'service'
        && action.type !== 'destroy'
        && action.metadata?.operation !== 'hostingEnvRemove'
      )) {
        if (serviceAction.type === 'noop') {
          serviceAction.type = 'update';
          serviceAction.reason = `${serviceAction.reason}; wire the newly created database read replica`;
        }
        serviceAction.dependsOn = Array.from(new Set([
          ...(serviceAction.dependsOn ?? []),
          ...databaseResilience.serviceDependencies,
        ]));
      }
    }
    if (domainRegistration.action) {
      actions = addDomainRegistrationDependency(actions, domainRegistration.action.id);
    }
    const providerHasSeparateEnvironment = hostingMetadata
      ?.orchestration
      ?.environment
      ?.separateResource === true;
    const environmentActionId = `environment:${environmentName}`;
    const projectActionId = `project:${environmentSpec.hosting.provider}`;
    const projectAction = actions.find((action) =>
      action.id === projectActionId && action.type !== 'noop'
    );
    const boundEnvironmentId = recordValue(effectiveBindingRecord, 'environmentId');
    const observedEnvironmentId = observed?.environmentId;
    const environmentObservationKnown = observed !== null
      && observed.completeness?.environment !== 'unknown';
    if (providerHasSeparateEnvironment) {
      const needsBindingReconciliation = Boolean(
        observedEnvironmentId
        && (
          !environment
          || boundEnvironmentId !== observedEnvironmentId
        )
      );
      const needsEnvironmentCreate = !observedEnvironmentId
        && environmentObservationKnown;
      const environmentObservationBlocked = !observedEnvironmentId
        && !environmentObservationKnown
        && !boundEnvironmentId;
      if (
        needsBindingReconciliation
        || needsEnvironmentCreate
        || environmentObservationBlocked
      ) {
        actions.unshift({
          id: environmentActionId,
          type: needsEnvironmentCreate ? 'create' : 'update',
          resource: {
            kind: 'environment',
            name: environmentName,
            provider: environmentSpec.hosting.provider,
          },
          verified: Boolean(observed && environmentObservationKnown),
          reason: needsBindingReconciliation
            ? `Bind the existing ${hostingMetadata?.displayName ?? environmentSpec.hosting.provider} environment "${environmentName}"`
            : needsEnvironmentCreate
              ? `Create the ${hostingMetadata?.displayName ?? environmentSpec.hosting.provider} environment "${environmentName}" inside the bound project`
              : `Cannot verify whether the ${hostingMetadata?.displayName ?? environmentSpec.hosting.provider} environment "${environmentName}" exists`,
          ...(projectAction ? { dependsOn: [projectAction.id] } : {}),
          metadata: {
            operation: HOSTING_ENVIRONMENT_ENSURE_OPERATION,
            ...(observedEnvironmentId ? { expectedEnvironmentId: observedEnvironmentId } : {}),
            ...(environmentObservationBlocked
              ? { blockedReason: 'environment_observation_unknown' }
              : {}),
          },
        });
      }
    } else if (!environment) {
      actions.unshift({
        id: environmentActionId,
        type: 'create',
        resource: { kind: 'environment', name: environmentName, provider: environmentSpec.hosting.provider },
        verified: observed !== null && !observed.partial,
        reason: `Environment "${environmentName}" is not tracked locally`,
        ...(domainRegistration.action ? { dependsOn: [domainRegistration.action.id] } : {}),
      });
    }
    const email = serviceFilter
      ? { actions: [], warnings: [], fingerprint: undefined }
      : await planEmail({
        project: projectForPlan,
        environmentName,
        environmentSpec,
        environment,
        observed,
        serviceDependencies: [
          ...actions
            .filter((action) => action.resource.kind === 'service' && action.type !== 'noop' && action.type !== 'destroy')
            .map((action) => action.id),
        ],
        domainDependencies: domainRegistration.action ? [domainRegistration.action.id] : [],
      });
    actions.push(...email.actions);
    const messaging = serviceFilter
      ? { actions: [], warnings: [], fingerprint: undefined }
      : await planTwilioMessaging({
        project: projectForPlan,
        environmentName,
        environmentSpec,
        environment,
        observed,
        serviceDependencies: actions
          .filter((action) => action.resource.kind === 'service' && action.type !== 'noop' && action.type !== 'destroy')
          .map((action) => action.id),
      });
    actions.push(...messaging.actions);
    const queues = await planQueues({ project: projectForPlan, environmentSpec, environment });
    if (queues.actions.length > 0) {
      const firstServiceIndex = actions.findIndex((action) => action.resource.kind === 'service');
      if (firstServiceIndex === -1) {
        actions.push(...queues.actions);
      } else {
        actions.splice(firstServiceIndex, 0, ...queues.actions);
      }
    }
    const storage = planStorage({ environmentSpec, environment, observed });
    if (storage.actions.length > 0) {
      const ensureActions = storage.actions.filter((action) => action.metadata?.operation === 'storageEnsure');
      const followupActions = storage.actions.filter((action) => action.metadata?.operation !== 'storageEnsure');
      actions.unshift(...ensureActions);
      const firstServiceIndex = actions.findIndex((action) => action.resource.kind === 'service');
      if (firstServiceIndex === -1) actions.push(...followupActions);
      else actions.splice(firstServiceIndex, 0, ...followupActions);
    }
    const loadBalancer = serviceFilter
      ? { actions: [], warnings: [], unmanaged: [] }
      : await planLoadBalancer({
        project: projectForPlan,
        environmentName,
        environmentSpec,
        environment,
        observed,
        serviceActions: actions.filter((action) => action.resource.kind === 'service'),
      });
    actions.push(...loadBalancer.actions);
    if (domainRegistration.action) {
      const publicLoadBalancer = actions.find((action) =>
        action.metadata?.operation === LOAD_BALANCER_OPERATIONS.ensure
      );
      if (publicLoadBalancer && publicLoadBalancer.type !== 'noop') {
        publicLoadBalancer.dependsOn = Array.from(new Set([
          ...(publicLoadBalancer.dependsOn ?? []),
          domainRegistration.action.id,
        ]));
      }
    }
    if (!environmentSpec.loadBalancer) {
      const publicDestroy = actions.find((action) =>
        action.metadata?.operation === LOAD_BALANCER_OPERATIONS.destroy
      );
      const domainAction = environmentSpec.domain
        ? actions.find((action) => action.id === `domain:${environmentSpec.domain}`)
        : undefined;
      if (publicDestroy && domainAction && domainAction.type !== 'noop') {
        domainAction.dependsOn = Array.from(new Set([
          ...(domainAction.dependsOn ?? []),
          publicDestroy.id,
        ]));
      }
    }
    const providerEnvironmentAction = actions.find((action) =>
      action.id === environmentActionId
      && action.metadata?.operation === HOSTING_ENVIRONMENT_ENSURE_OPERATION
      && action.type !== 'noop'
    );
    if (providerEnvironmentAction) {
      for (const action of actions) {
        if (
          action.id === providerEnvironmentAction.id
          || action.type === 'noop'
          || action.type === 'destroy'
          || action.resource.provider !== environmentSpec.hosting.provider
          || action.resource.kind === 'project'
          || action.resource.kind === 'environment'
        ) {
          continue;
        }
        action.dependsOn = Array.from(new Set([
          ...(action.dependsOn ?? []),
          providerEnvironmentAction.id,
        ]));
      }
    }
    actions.push(...delegatedSecrets.actions);
    const stripeSync = serviceFilter
      ? { actions: [], warnings: [], blocked: [], fingerprint: undefined }
      : await planStripeEnvironmentSync({
        projectName: projectForPlan.name,
        environmentName,
        environmentSpec,
        environment,
        observed,
      });
    for (const stripeAction of stripeSync.actions) {
      const serviceAction = actions.find((action) =>
        action.id === `service:${stripeAction.resource.name}`
      );
      if (serviceAction && serviceAction.type !== 'noop') {
        stripeAction.dependsOn = [
          ...(stripeAction.dependsOn ?? []),
          serviceAction.id,
        ];
      }
    }
    for (const stripeAction of stripeSync.actions) {
      if (
        stripeAction.type !== 'destroy'
        || stripeAction.metadata?.operation !== 'stripeWebhookDestroy'
        || typeof stripeAction.metadata.service !== 'string'
      ) {
        continue;
      }
      const serviceDestroy = actions.find((action) =>
        action.resource.kind === 'service'
        && action.resource.name === stripeAction.metadata?.service
        && action.type === 'destroy'
      );
      if (serviceDestroy) {
        serviceDestroy.dependsOn = [
          ...(serviceDestroy.dependsOn ?? []),
          stripeAction.id,
        ];
      }
    }
    actions.push(...stripeSync.actions);
    const databaseSeedAction = actions.find((action) =>
      action.type !== 'noop'
      && action.metadata?.operation === 'databaseSeed'
    );
    if (databaseSeedAction) {
      const stripeSeedPrerequisites = stripeSync.actions
        .filter((action) => action.type !== 'noop' && action.type !== 'destroy')
        .map((action) => action.id);
      if (stripeSeedPrerequisites.length > 0) {
        databaseSeedAction.dependsOn = Array.from(new Set([
          ...(databaseSeedAction.dependsOn ?? []),
          ...stripeSeedPrerequisites,
        ]));
      }

    }
    for (const stripeBlock of stripeSync.blocked) {
      if (!blocked.some((entry) => entry.provider === 'stripe' && entry.scope === stripeBlock.scope)) {
        blocked.push(stripeBlock);
      }
    }

    const removalRolloutConflicts = actions.some((action) =>
      action.metadata?.operation === 'hostingEnvRemove'
    )
      ? actions.filter((action) =>
        action.type !== 'noop'
        && action.metadata?.operation !== 'hostingEnvRemove'
        && action.metadata?.operation !== DATABASE_RESILIENCE_OPERATIONS.replicaDestroy
        && ['project', 'environment', 'service', 'database', 'cache', 'storage', 'load-balancer', 'queue', 'secret', 'payment', 'email', 'messaging']
          .includes(action.resource.kind)
      )
      : [];
    if (removalRolloutConflicts.length > 0) {
      return {
        error: `removeEnvVars requires a two-release rollout. First apply and verify compatible code/infrastructure without any removals, then add removeEnvVars in a later spec change. Work not yet converged: ${removalRolloutConflicts.map((action) => action.id).join(', ')}.`,
      };
    }

    // Destroys (including confirm-gated previous-provider cleanup) are never
    // prerequisites for CI setup — an unconfirmed destroy must not block the
    // workflow sync.
    const ciDependsOn = actions
      .filter((action) => action.type !== 'noop' && action.type !== 'destroy' && ['project', 'environment', 'service', 'payment', 'email', 'messaging'].includes(action.resource.kind))
      .map((action) => action.id);
    const ciBindingsWillChange = actions.some((action) =>
      action.resource.kind === 'service' && (action.type === 'create' || action.type === 'replace')
    );
    const ciDeploy = await planManagedCiDeploy({
      project: projectForPlan,
      spec: specResult.spec,
      environmentName,
      environmentSpec,
      environment,
      dependsOn: ciDependsOn,
      bindingsWillChange: ciBindingsWillChange,
    });
    if (ciDeploy.error) return { error: ciDeploy.error };
    if (ciDeploy.actions.length > 0) {
      const firstDomainIndex = actions.findIndex((action) => action.resource.kind === 'domain');
      if (firstDomainIndex === -1) {
        actions.push(...ciDeploy.actions);
      } else {
        actions.splice(firstDomainIndex, 0, ...ciDeploy.actions);
      }
    }

    const repoCollaboration = await planGitHubCollaboration({
      project: projectForPlan,
      spec: specResult.spec,
      environmentName,
    });
    if (repoCollaboration.action) {
      actions.push(repoCollaboration.action);
    }
    const githubInfrastructure = await planGitHubInfrastructure({
      project: projectForPlan,
      spec: specResult.spec,
      environmentName,
      suppliedSecretValues: delegatedSecretValues,
    });
    const secretInputRequired = [
      ...delegatedSecrets.inputRequired,
      ...githubInfrastructure.inputRequired,
    ];
    if (environmentSpec.database?.resilience?.restoreDrill) {
      const restorePrerequisites = actions
        .filter((action) =>
          action.type !== 'noop'
          && action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure
        )
        .map((action) => action.id);
      for (const action of githubInfrastructure.actions) {
        if (
          action.type !== 'noop'
          && action.metadata?.operation === GITHUB_INFRASTRUCTURE_OPERATION
          && restorePrerequisites.length > 0
        ) {
          action.dependsOn = Array.from(new Set([
            ...(action.dependsOn ?? []),
            ...restorePrerequisites,
          ]));
        }
      }
    }
    const githubConfirmationActions = githubInfrastructure.actions.filter((action) => action.requiresConfirm);
    actions.push(...githubInfrastructure.actions.filter((action) => !action.requiresConfirm));
    blocked.push(...githubInfrastructure.blocked);

    // iOS actions go last: the executor aborts remaining actions after a
    // failure, and an Apple-side failure must never block hosting convergence.
    const ios = await planIos({ project: projectForPlan, environmentSpec, environment });
    actions.push(...ios.actions);
    actions.push(...githubConfirmationActions);

    // A CI-managed seed must run only after the exact desired commit is
    // deployed. Exclude it from the applied-contract marker to avoid a cycle;
    // the explicit release action below bridges marker -> deploy -> seed.
    const managedCiSeedAction = actions.find((action) =>
      action.type !== 'noop'
      && action.metadata?.operation === 'databaseSeed'
      && environmentUsesManagedCi(specResult.spec, environmentName)
    );
    const appliedSpecHashDependsOn = actions
      .filter((action) => action.type !== 'noop' && action.id !== managedCiSeedAction?.id)
      .map((action) => action.id);
    const ciConfigurationPending = ciDeploy.actions.some((action) => (
      action.type !== 'noop' && action.metadata?.operation === CI_CONFIGURATION_SYNC_OPERATION
    ));
    const appliedSpecHash = ciConfigurationPending
      ? {
          actions: [] as PlanAction[],
          warnings: ['Applied deployment-contract sync is deferred until the reviewed CI configuration is merged and re-observed.'],
        }
      : await planManagedCiAppliedSpecHash({
          project: projectForPlan,
          spec: specResult.spec,
          environmentName,
          environmentSpec,
          environment,
          dependsOn: appliedSpecHashDependsOn,
        });
    if (appliedSpecHash.error) return { error: appliedSpecHash.error };
    if (appliedSpecHash.actions.length > 0) {
      actions.push(...appliedSpecHash.actions);
    }
    const appliedSpecHashChanges = appliedSpecHash.actions.filter((action) => action.type !== 'noop');
    const releaseDependsOn = appliedSpecHashChanges.length > 0
      ? appliedSpecHashChanges.map((action) => action.id)
      : appliedSpecHashDependsOn;
    const managedSeedRelease = managedCiSeedAction
      && resolveDevOpsSelection(specResult.spec)?.ci?.provider === 'github-actions'
      ? await planGitHubActionsRelease({
        project: projectForPlan,
        environmentName,
        environmentSpec,
        dependsOn: releaseDependsOn,
      })
      : { warnings: [] };
    if (managedSeedRelease.action && managedCiSeedAction) {
      actions.push(managedSeedRelease.action);
      managedCiSeedAction.dependsOn = Array.from(new Set([
        ...(managedCiSeedAction.dependsOn ?? []),
        managedSeedRelease.action.id,
      ]));
    } else if (managedCiSeedAction) {
      managedCiSeedAction.metadata = {
        ...(managedCiSeedAction.metadata ?? {}),
        blockedReason: 'managed_ci_release_unavailable',
      };
    }

    // Data copy is a safety stage of its own. Do not provision the ordinary
    // desired database/bucket or deploy services in the same apply: each copy
    // handler owns a fresh unreachable candidate, verifies it, and only then
    // records it as active for a later plan.
    if (maintenance.pending) {
      const scaffolding = actions.filter((action) =>
        (action.resource.kind === 'project' || action.resource.kind === 'environment')
        && action.type !== 'destroy'
      );
      const scaffoldDependencies = scaffolding
        .filter((action) => action.type !== 'noop')
        .map((action) => action.id);
      actions = [
        ...scaffolding,
        ...maintenance.actions.map((action) => action.type === 'noop' || scaffoldDependencies.length === 0
          ? action
          : {
              ...action,
              dependsOn: Array.from(new Set([...(action.dependsOn ?? []), ...scaffoldDependencies])),
            }),
      ];
    } else if (dataMigration.pending) {
      const scaffolding = actions.filter((action) =>
        (action.resource.kind === 'project' || action.resource.kind === 'environment')
        && action.type !== 'destroy'
      );
      const scaffoldDependencies = scaffolding
        .filter((action) => action.type !== 'noop')
        .map((action) => action.id);
      actions = [
        ...scaffolding,
        ...dataMigration.actions
          .filter((action) => action.type !== 'destroy')
          .map((action) => action.type === 'noop' || scaffoldDependencies.length === 0
          ? action
          : {
              ...action,
              dependsOn: Array.from(new Set([...(action.dependsOn ?? []), ...scaffoldDependencies])),
            }),
      ];
    } else {
      const cleanupActions = dataMigration.actions.filter((candidate) =>
        candidate.metadata?.operation === 'dataMigrationDatabasePreviousDestroy'
        || candidate.metadata?.operation === 'dataMigrationStoragePreviousDestroy'
      );
      const cutoverPending = actions.some((action) => action.type !== 'noop');
      if (cleanupActions.length > 0 && !cutoverPending) {
        actions.push(...cleanupActions);
      } else if (cleanupActions.length > 0) {
        dataMigration.warnings.push(
          `Previous migration target cleanup is deferred until the cutover plan has fully converged. Re-run hv_plan after deployment verification to review the retained data-bearing targets.`
        );
      }
    }

    // Deployment ownership is a safety stage of its own. A stale native
    // source must be removed (or explicitly blocked) before a plan asks for
    // unrelated billable resources, environment changes, or releases. This
    // also lets operators repair the trigger without confirming later work.
    if (!dataMigration.pending && nativeDeploySources.actions.length > 0) {
      const sourceActionIds = new Set(nativeDeploySources.actions.map((action) => action.id));
      actions = actions
        .filter(isProviderNativeDeploySourceAction)
        .map((action) => {
          const dependencies = action.dependsOn?.filter((dependency) => sourceActionIds.has(dependency));
          return dependencies?.length
            ? { ...action, dependsOn: dependencies }
            : { ...action, dependsOn: undefined };
        });
      nativeDeploySources.warnings.push(
        'This plan is limited to provider-native deploy-source reconciliation. Re-run hv_plan after it converges to review remaining infrastructure drift.'
      );
    }

    const filterWarnings: string[] = [];
    if (serviceFilter) {
      // A filtered plan is an honest "deploy these services" plan: keep the
      // scaffolding (project/environment) and database creates the deploy
      // depends on, keep the selected services, and never destroy anything.
      const keep = new Set(serviceFilter);
      const unfilteredActionIds = new Set(actions.map((action) => action.id));
      actions = actions.filter((action) => {
        if (action.type === 'destroy') return false;
        if (action.metadata?.operation === 'hostingEnvRemove') return false;
        if (action.resource.kind === 'project' || action.resource.kind === 'environment') return true;
        if (action.resource.kind === 'database' || action.resource.kind === 'cache') {
          return action.type === 'create' || action.type === 'noop';
        }
        if (action.resource.kind === 'service') {
          // Deployment ownership is environment-wide. A partial service
          // deploy must not leave another desired service's native trigger
          // connected while proceeding with selected-service mutations.
          if (isProviderNativeDeploySourceAction(action)) return true;
          return keep.has(action.resource.name);
        }
        return false;
      });
      const retainedActionIds = new Set(actions.map((action) => action.id));
      actions = actions.map((action) => {
        const retainedDependencies = action.dependsOn?.filter((dependency) => (
          retainedActionIds.has(dependency)
          || !unfilteredActionIds.has(dependency)
        ));
        return retainedDependencies?.length
          ? { ...action, dependsOn: retainedDependencies }
          : { ...action, dependsOn: undefined };
      });
      filterWarnings.push(
        `Partial plan (services: ${serviceFilter.join(', ')}): delegated secrets, domain, load balancer, CI, collaboration, iOS, queue, storage, and destroy convergence was excluded; run hv_plan without services for full convergence.`
      );
    }

    const plannedCleanupProviders = actions
      .filter((action) =>
        action.type === 'destroy'
        && (
          action.metadata?.operation === 'dataMigrationDatabasePreviousDestroy'
          || action.metadata?.operation === 'dataMigrationStoragePreviousDestroy'
          || action.metadata?.operation === 'previousHostingDestroy'
          || action.metadata?.operation === 'retainedDatabaseDestroy'
          || action.metadata?.operation === CACHE_OPERATIONS.retainedDestroy
          || action.metadata?.operation === 'retainedResourceDestroy'
        )
      )
      .map((action) => action.resource.provider);
    for (const block of this.providerPreflight(plannedCleanupProviders)) {
      if (!blocked.some((existing) => existing.provider === block.provider && existing.reason === block.reason)) {
        blocked.push(block);
      }
    }

    const envFileWarnings: string[] = [];
    if (envFile) {
      const loadedKeys = Object.keys(envFileVars ?? {}).sort();
      const shadowedByManaged = Object.keys(envFile.vars)
        .filter((key) => managedEnvKeys.has(key))
        .sort();
      if (envFile.createdEnvSpecificPath && envFile.baseEnvPath) {
        envFileWarnings.push(`Created environment-specific deploy env file at ${envFile.createdEnvSpecificPath} from base ${envFile.baseEnvPath} for environment "${environmentName}". Review it if these values should differ before apply.`);
      } else if (envFile.syncedFromBaseKeys && envFile.syncedFromBaseKeys.length > 0 && envFile.baseEnvPath) {
        envFileWarnings.push(`Updated environment-specific deploy env file ${envFile.path} with ${envFile.syncedFromBaseKeys.length} key(s) copied from base ${envFile.baseEnvPath}: ${envFile.syncedFromBaseKeys.join(', ')}.`);
      }
      if (envFile.divergentFromBaseKeys && envFile.divergentFromBaseKeys.length > 0 && envFile.baseEnvPath) {
        envFileWarnings.push(`Preserved ${envFile.divergentFromBaseKeys.length} environment-specific .env key(s) in ${envFile.path} that differ from base ${envFile.baseEnvPath}: ${envFile.divergentFromBaseKeys.join(', ')}.`);
      }
      if (envFile.usedBaseEnvFallback && envFile.missingEnvSpecificPath) {
        envFileWarnings.push(`No environment-specific deploy env file found at ${envFile.missingEnvSpecificPath}; using base ${envFile.path} for environment "${environmentName}" and copying selected runtime keys into the plan. Create ${envFile.missingEnvSpecificPath} or adjust envFile.mode/include/exclude if these values should differ.`);
      }
      if (loadedKeys.length > 0) {
        envFileWarnings.push(`Loaded ${loadedKeys.length} deploy env var(s) from ${envFile.path}.`);
      }
      if (envFile.ignoredKeys.length > 0) {
        envFileWarnings.push(`Ignored ${envFile.ignoredKeys.length} .env key(s) that do not match envFile policy: ${envFile.ignoredKeys.join(', ')}.`);
      }
      if (envFile.excludedKeys.length > 0) {
        envFileWarnings.push(`Excluded ${envFile.excludedKeys.length} .env key(s) by envFile.exclude: ${envFile.excludedKeys.join(', ')}.`);
      }
      if (envFile.localValueKeys.length > 0) {
        envFileWarnings.push(`Skipped ${envFile.localValueKeys.length} .env key(s) with local-only values in runtime mode: ${envFile.localValueKeys.join(', ')}.`);
      }
      if (envFile.emptyKeys.length > 0) {
        envFileWarnings.push(`Missing values for ${envFile.emptyKeys.length} selected .env key(s): ${envFile.emptyKeys.join(', ')}. Fill them before apply.`);
      }
      if (shadowedByManaged.length > 0) {
        envFileWarnings.push(`Ignored ${shadowedByManaged.length} .env key(s) because Hypervibe manages them from infrastructure: ${shadowedByManaged.join(', ')}.`);
      }
      if (envFile.skippedKeys.length > 0) {
        envFileWarnings.push(`Skipped ${envFile.skippedKeys.length} provider-only .env key(s): ${envFile.skippedKeys.join(', ')}.`);
      }
    }

    const overrides = serviceFilter
      || envVarOverrides
      || Object.keys(delegatedSecretValues).length > 0
      || (envFileVars && Object.keys(envFileVars).length > 0)
      ? {
        ...(serviceFilter ? { services: serviceFilter } : {}),
        ...(envFileVars && Object.keys(envFileVars).length > 0
          ? {
            envFilePath: envFile?.path,
            envFileKeys: Object.keys(envFileVars).sort(),
            envFileVarsEncrypted: getSecretStore().encryptObject(envFileVars),
          }
          : {}),
        ...(envVarOverrides
          ? {
            envVarKeys: Object.keys(envVarOverrides).sort(),
            envVarsEncrypted: getSecretStore().encryptObject(envVarOverrides),
          }
          : {}),
        ...(Object.keys(delegatedSecretValues).length > 0
          ? {
            delegatedSecretKeys: Object.keys(delegatedSecretValues).sort(),
            delegatedSecretVarsEncrypted: getSecretStore().encryptObject(delegatedSecretValues),
          }
          : {}),
      }
      : undefined;

    try {
      orderActions(actions);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        error: `Hypervibe generated an invalid action graph. No plan was saved or provider mutation authorized. ${detail}`,
      };
    }

    const document: PlanRunDocument = {
      kind: 'hv_plan',
      scope: 'full',
      environmentName,
      specRevision: specResult.revision,
      observedFingerprint: observed ? fingerprintObservedState(observed) : null,
      ...(dataMigration.pending && sourceEnvironment
        ? { lockEnvironmentIds: [sourceEnvironment.id] }
        : {}),
      ...((stripeSync.fingerprint || email.fingerprint || messaging.fingerprint)
        ? {
          integrationFingerprints: {
            ...(stripeSync.fingerprint ? { stripe: stripeSync.fingerprint } : {}),
            ...(email.fingerprint ? { email: email.fingerprint } : {}),
            ...(messaging.fingerprint ? { messaging: messaging.fingerprint } : {}),
          },
        }
        : {}),
      actions,
      unmanaged: [...diff.unmanaged, ...cache.unmanaged, ...databaseResilience.unmanaged, ...storage.unmanaged, ...loadBalancer.unmanaged],
      warnings: [...specWarnings, ...sharedProjectBinding.warnings, ...observeWarnings, ...sourceMaintenanceWarnings, ...envFileWarnings, ...diff.warnings, ...cache.warnings, ...databaseResilience.warnings, ...maintenance.warnings, ...dataMigration.warnings, ...nativeDeploySources.warnings, ...sourceWarnings, ...domainRegistration.warnings, ...loadBalancer.warnings, ...ciDeploy.warnings, ...appliedSpecHash.warnings, ...managedSeedRelease.warnings, ...repoCollaboration.warnings, ...githubInfrastructure.warnings, ...ios.warnings, ...queues.warnings, ...storage.warnings, ...delegatedSecrets.warnings, ...stripeSync.warnings, ...email.warnings, ...messaging.warnings, ...filterWarnings],
      ...(secretInputRequired.length > 0 ? { inputRequired: secretInputRequired } : {}),
      ...(overrides ? { overrides } : {}),
    };

    // Plans for untracked environments can't reference an environment row;
    // create the local record now so runs can attach to it.
    const environmentRecord = environment
      ?? this.envRepo.create({ projectId: project.id, name: environmentName, platformBindings: effectiveBindingRecord });

    const run = this.runRepo.create({
      projectId: project.id,
      environmentId: environmentRecord.id,
      type: 'plan',
      plan: document as unknown as Record<string, unknown>,
    });
    this.runRepo.updateStatus(run.id, 'succeeded');

    return {
      planRunId: run.id,
      scope: 'full',
      specRevision: specResult.revision,
      specSource: specResult.source ?? { kind: 'local' },
      environmentName,
      verified: observed !== null && !observed.partial,
      observed,
      actions,
      unmanaged: [...diff.unmanaged, ...cache.unmanaged, ...databaseResilience.unmanaged, ...storage.unmanaged],
      warnings: document.warnings ?? [],
      inputRequired: secretInputRequired,
      blocked,
    };
  }
}
