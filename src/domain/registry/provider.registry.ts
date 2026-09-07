import { z } from 'zod';
import type { ProviderCiDeployMetadata } from '../ports/ci-deploy.port.js';
import type { ProviderDatabaseRestoreDrillMetadata } from '../ports/database-restore-drill.port.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { WorkloadKind } from '../entities/service.entity.js';
import type { Receipt } from '../ports/provider.port.js';

export type ProviderCategory = 'deployment' | 'dns' | 'email' | 'messaging' | 'payment' | 'database' | 'cache' | 'storage' | 'appstore' | 'ai';
export type ProviderLifecycleCapability =
  | 'hosting'
  | 'database'
  | 'cache'
  | 'storage'
  | 'queue'
  | 'load-balancer';
export type ProviderImplementationStatus = 'supported' | 'ready-for-live' | 'planned';

export interface ProviderLiveEvidence {
  /** ISO-8601 time at which the live lifecycle contract last passed. */
  verifiedAt: string;
  /** Non-secret repository path or HTTPS URL containing the live evidence. */
  reference: string;
}

export interface ProviderCapabilityMaturity {
  status: ProviderImplementationStatus;
  /** Required for supported capabilities and omitted until live evidence exists. */
  liveEvidence?: ProviderLiveEvidence;
  /** Optional promotion blocker or other actionable maturity context. */
  reason?: string;
}

export interface ProviderInspectionRequest {
  /** Provider connection/account/repository/domain scope. */
  scope?: string;
  /** Provider-owned resource class, such as project, ref, pages, zone, or dns. */
  resource?: string;
  /** Durable provider id when one is known. */
  id?: string;
  /** Exact provider resource name when an id is not known. */
  name?: string;
  /** Explicit non-secret provider placement selector for regional environment forensics. */
  region?: string;
  /** Hard output bound for list operations. */
  limit: number;
  /** Logical Hypervibe project context for provider-scoped environment forensics. */
  project?: Pick<Project, 'id' | 'name'>;
  /** Logical Hypervibe environment context; never carries another provider's bindings. */
  environment?: Pick<Environment, 'id' | 'projectId' | 'name'>;
  /** Sanitized selected-provider or explicitly compatible hosting binding. */
  binding?: Record<string, unknown>;
  /** Logical services used only to recognize deterministic legacy resource names. */
  serviceNames?: string[];
}

export type ProviderInspectionSelector =
  | 'project'
  | 'env'
  | 'scope'
  | 'id'
  | 'name'
  | 'region'
  | 'limit';

export interface ProviderInspectionSelectorContract {
  /** Whether this is an account/resource read or a Hypervibe environment read. */
  mode: 'provider-resource' | 'environment-forensics' | 'environment';
  /** Selectors which must all be present. `provider` and `resource` are implicit. */
  required?: readonly ProviderInspectionSelector[];
  /** Selectors accepted in addition to the required selectors. */
  optional?: readonly ProviderInspectionSelector[];
  /** At least one selector from every group must be present. */
  oneOf?: readonly (readonly ProviderInspectionSelector[])[];
  /** Selector groups which cannot be combined in one call. */
  mutuallyExclusive?: readonly (readonly ProviderInspectionSelector[])[];
  /** True when this resource can return a bounded collection and accepts `limit`. */
  list?: boolean;
  /** Durable non-secret scope keys every returned identity must carry. */
  scopeKeys?: readonly string[];
  /** Result field containing the bounded resource collection. */
  collectionKey?: string;
}

export interface ProviderInspectionCapability {
  /** Bounded resource classes accepted by this provider inspector. */
  resources: readonly string[];
  /** Resource selected when a provider-only call omits `resource`. Defaults to the first resource. */
  defaultResource?: string;
  /** Provider-owned selector contract exposed by parameterless hv_inspect discovery. */
  selectors: Readonly<Record<string, ProviderInspectionSelectorContract>>;
  inspect(adapter: unknown, request: ProviderInspectionRequest): Promise<Record<string, unknown>>;
}

export interface ProviderRetainedResourceTarget {
  resource: string;
  id: string;
  name: string;
  providerScope: Record<string, string>;
}

export interface ProviderRetainedCleanupCapability {
  /** Extra provider-owned resource classes eligible for exact, confirmation-gated cleanup. */
  resources: readonly string[];
  destroy(adapter: unknown, target: ProviderRetainedResourceTarget): Promise<Receipt>;
}

export interface ProviderMetadata {
  name: string;
  displayName: string;
  category: ProviderCategory;
  credentialsSchema: z.ZodTypeAny;
  setupHelpUrl?: string;
  credentials?: {
    defaultScalarKey?: string;
    /** The adapter can authenticate through the provider's native local CLI/default chain. */
    supportsNativeCliAuth?: boolean;
    /**
     * Environment-variable names which may resolve the same credential value.
     * Exact requested names win; aliases are only fallbacks.
     */
    environmentVariableAliases?: string[][];
  };
  /** Existing provider connections whose authentication shape this adapter can reuse. */
  connectionAliases?: string[];
  maturity?: {
    /** Evidence status for each lifecycle slice implemented by this registration. */
    lifecycle?: Partial<Record<ProviderLifecycleCapability, ProviderCapabilityMaturity>>;
  };
  orchestration?: ProviderOrchestrationMetadata;
  lifecycle?: {
    /** Hosting lifecycle exists only when the provider is valid in environments.*.hosting. */
    hosting?: {
      /** Workload kinds this adapter can reconcile through the complete hosting lifecycle. */
      workloadKinds: readonly WorkloadKind[];
      /** Environment custom domains are either fully managed or explicitly unsupported. */
      customDomains: 'managed' | 'unsupported';
      /** Whether traffic DNS may be proxied or must remain directly resolvable. */
      domainTrafficProxy?: 'supported' | 'dns-only';
      /** Provider-owned direct-origin and background-workload suspension. */
      maintenance?: 'managed' | 'unsupported';
      /** Smallest provider-owned boundary that completely removes one Hypervibe environment. */
      teardownBoundary: 'services' | 'environment' | 'project';
    };
    /** Engines this provider can reconcile through its database adapter. */
    databaseEngines?: string[];
    /**
     * Hosting providers whose workloads can reach this database through the
     * implemented networking contract. Omit only when connectivity is
     * intentionally provider-independent.
     */
    databaseConnectivity?: {
      compatibleHostingProviders: string[];
    };
    /** Engines this provider can reconcile through its cache adapter. */
    cacheEngines?: string[];
    /**
     * Hosting providers whose workloads can reach this cache through the
     * implemented networking contract. Omit only when connectivity is
     * intentionally provider-independent.
     */
    cacheConnectivity?: {
      compatibleHostingProviders: string[];
    };
    /** Queue backend reconciled through this provider's desired-state loop. */
    queue?: {
      backend: 'pubsub' | 'postgres';
      /** Whether the provider owns external queue resources or only wiring. */
      resources: 'managed' | 'application-managed';
    };
    /** Provider-managed edge load-balancer topology exposed by its adapter. */
    loadBalancer?: {
      topology: 'monitor-pool-balancer';
      minimumOrigins: number;
    };
    /** Declarative database resilience features implemented by the adapter. */
    databaseResilience?: {
      availabilityModes?: Array<'zonal' | 'regional'>;
      backups?: {
        maxRetainedBackups: number;
        maxPitrRetentionDays: number;
      };
      readReplicas?: boolean;
      /** Scheduled isolated restore verification can be compiled for this provider. */
      restoreDrills?: boolean;
    };
  };
}

export interface ProviderOrchestrationMetadata {
  project?: {
    /**
     * Provider projects contain multiple deploy environments. When a new
     * Hypervibe environment is added, reuse the existing project binding
     * instead of creating another provider project.
     */
    shareAcrossEnvironments?: boolean;
  };
  environment?: {
    /**
     * The provider models deploy environments as durable resources inside a
     * shared project. Planning must ensure and bind this resource explicitly
     * before any service, datastore, storage, or domain mutation can run.
     */
    separateResource?: boolean;
  };
  diff?: {
    /** Source-less services are expected unless branch deploys are configured. */
    requiresBranchDeployForCode?: boolean;
    /** Creating or replacing a service can charge the provider account. */
    serviceCreatesBillable?: boolean;
    /** Some providers cannot observe web vs worker, only cron vs non-cron. */
    workloadKindObservation?: 'exact' | 'cron-only';
    /**
     * Some providers report generated/reference env vars as resolved values.
     * Return true when Hypervibe should verify only that the key exists live.
     */
    presenceOnlyManagedEnvVar?: (params: { key: string; value: string }) => boolean;
  };
  connections?: {
    missingConnectionPolicy?: 'hard' | 'action-scoped-if-independent-actions';
  };
  logs?: {
    runtime?: boolean;
    deployments?: boolean;
    build?: boolean;
  };
  ci?: ProviderCiDeployMetadata;
  databaseRestoreDrill?: ProviderDatabaseRestoreDrillMetadata;
  nativeBranchDeploy?: {
    needsGitHubAppAccess?: boolean;
    githubAppInstallUrl?: string;
    /**
     * Reconciliation policy when desired deployment ownership is not native
     * (manual promotion or Hypervibe-managed CI) but a live provider-native
     * repository source is still connected.
     */
    nonNativeSourcePolicy?: 'disconnect' | 'block';
  };
}

export interface RegisteredProvider {
  metadata: ProviderMetadata;
  factory: (credentials: unknown) => unknown | Promise<unknown>;
  /** Optional hook to install CLI tools or other dependencies when a connection is created. */
  ensureDependencies?: () => Promise<{ installed: string[]; errors: string[] }>;
  /** Optional provider-owned raw forensic reads used by hv_inspect. */
  inspection?: ProviderInspectionCapability;
  /** Provider-owned deletion driver for explicitly retained non-lifecycle resources. */
  retainedCleanup?: ProviderRetainedCleanupCapability;
  /** Existing infrastructure can be adopted only when a provider declares and tests this capability. */
  adoption?: {
    project: true;
  };
  /** Provider-owned adapters derived from the connected primary adapter. */
  derivedAdapters?: {
    database?: (adapter: unknown, context: { project?: Project }) => Promise<unknown> | unknown;
    cache?: (adapter: unknown, context: { project?: Project }) => Promise<unknown> | unknown;
    storage?: (adapter: unknown, context: { project?: Project }) => Promise<unknown> | unknown;
  };
}

/**
 * Central registry for all provider adapters.
 * Providers self-register at module load time.
 */
export class ProviderRegistry {
  private providers = new Map<string, RegisteredProvider>();

  /**
   * Register a provider adapter
   */
  register(provider: RegisteredProvider): void {
    if (this.providers.has(provider.metadata.name)) {
      throw new Error(`Provider "${provider.metadata.name}" is already registered`);
    }
    this.assertCapabilityMaturity(provider);
    this.assertInspectionContract(provider);
    this.providers.set(provider.metadata.name, provider);
  }

  private declaredLifecycleCapabilities(provider: RegisteredProvider): ProviderLifecycleCapability[] {
    const capabilities: ProviderLifecycleCapability[] = [];
    if (
      provider.metadata.category === 'deployment'
      && provider.metadata.lifecycle?.hosting !== undefined
    ) {
      capabilities.push('hosting');
    }
    if (
      (provider.metadata.lifecycle?.databaseEngines?.length ?? 0) > 0
      && (
        provider.metadata.category === 'database'
        || typeof provider.derivedAdapters?.database === 'function'
      )
    ) {
      capabilities.push('database');
    }
    if (
      (provider.metadata.lifecycle?.cacheEngines?.length ?? 0) > 0
      && (
        provider.metadata.category === 'cache'
        || typeof provider.derivedAdapters?.cache === 'function'
      )
    ) {
      capabilities.push('cache');
    }
    if (
      provider.metadata.category === 'storage'
      || typeof provider.derivedAdapters?.storage === 'function'
    ) {
      capabilities.push('storage');
    }
    if (provider.metadata.lifecycle?.queue) {
      capabilities.push('queue');
    }
    if (provider.metadata.lifecycle?.loadBalancer) {
      capabilities.push('load-balancer');
    }
    return capabilities;
  }

  private assertCapabilityMaturity(provider: RegisteredProvider): void {
    const declared = new Set(this.declaredLifecycleCapabilities(provider));
    const maturity = provider.metadata.maturity?.lifecycle ?? {};
    const hostingLifecycle = provider.metadata.lifecycle?.hosting;
    if (hostingLifecycle) {
      const workloadKinds = hostingLifecycle.workloadKinds;
      const validKinds = new Set<WorkloadKind>(['web', 'worker', 'cron']);
      if (
        !Array.isArray(workloadKinds)
        || workloadKinds.length === 0
        || new Set(workloadKinds).size !== workloadKinds.length
        || workloadKinds.some((kind) => !validKinds.has(kind))
      ) {
        throw new Error(
          `Provider "${provider.metadata.name}" hosting workloadKinds must contain one or more unique supported workload kinds.`
        );
      }
    }
    const connectivity = [
      ['database', provider.metadata.lifecycle?.databaseConnectivity],
      ['cache', provider.metadata.lifecycle?.cacheConnectivity],
    ] as const;
    for (const [capability, contract] of connectivity) {
      if (!contract) continue;
      if (!declared.has(capability)) {
        throw new Error(
          `Provider "${provider.metadata.name}" declares ${capability} connectivity without a ${capability} lifecycle.`
        );
      }
      const hosts = contract.compatibleHostingProviders;
      if (
        hosts.length === 0
        || new Set(hosts).size !== hosts.length
        || hosts.some((host) => !host.trim() || host !== host.trim())
      ) {
        throw new Error(
          `Provider "${provider.metadata.name}" ${capability} connectivity must name one or more unique hosting providers.`
        );
      }
    }
    for (const capability of declared) {
      const entry = maturity[capability];
      if (!entry) {
        throw new Error(
          `Provider "${provider.metadata.name}" declares ${capability} lifecycle support without production maturity metadata.`
        );
      }
      if (entry.reason !== undefined && !entry.reason.trim()) {
        throw new Error(
          `Provider "${provider.metadata.name}" has an empty maturity reason for ${capability}.`
        );
      }
      if (entry.status === 'supported') {
        const verifiedAt = entry.liveEvidence?.verifiedAt;
        const reference = entry.liveEvidence?.reference;
        if (
          !verifiedAt
          || !Number.isFinite(Date.parse(verifiedAt))
          || !reference?.trim()
        ) {
          throw new Error(
            `Provider "${provider.metadata.name}" cannot mark ${capability} supported without dated, non-secret liveEvidence.`
          );
        }
      }
    }
    for (const capability of Object.keys(maturity) as ProviderLifecycleCapability[]) {
      if (!declared.has(capability)) {
        throw new Error(
          `Provider "${provider.metadata.name}" declares ${capability} maturity without an implemented lifecycle capability.`
        );
      }
    }
  }

  private assertInspectionContract(provider: RegisteredProvider): void {
    const inspection = provider.inspection;
    if (inspection) {
      const resources = new Set(inspection.resources);
      const selectorResources = Object.keys(inspection.selectors);
      if (resources.size !== inspection.resources.length) {
        throw new Error(`Provider "${provider.metadata.name}" inspection resources must be unique.`);
      }
      if (
        selectorResources.length !== resources.size
        || selectorResources.some((resource) => !resources.has(resource))
      ) {
        throw new Error(`Provider "${provider.metadata.name}" must declare exactly one selector contract for every inspection resource.`);
      }
      const defaultResource = inspection.defaultResource ?? inspection.resources[0];
      if (!defaultResource || !resources.has(defaultResource)) {
        throw new Error(`Provider "${provider.metadata.name}" inspection defaultResource must name a registered resource.`);
      }
      for (const resource of inspection.resources) {
        const contract = inspection.selectors[resource]!;
        const accepted = new Set([
          ...(contract.required ?? []),
          ...(contract.optional ?? []),
          ...(contract.oneOf?.flat() ?? []),
        ]);
        if (accepted.has('limit') !== (contract.list === true)) {
          throw new Error(`Provider "${provider.metadata.name}" inspection resource "${resource}" must accept limit exactly when list=true.`);
        }
        if ((contract.scopeKeys ?? []).some((key) => !key.trim())) {
          throw new Error(`Provider "${provider.metadata.name}" inspection resource "${resource}" has an invalid provider scope key.`);
        }
        if (new Set(contract.scopeKeys ?? []).size !== (contract.scopeKeys?.length ?? 0)) {
          throw new Error(`Provider "${provider.metadata.name}" inspection resource "${resource}" has duplicate provider scope keys.`);
        }
        if (contract.collectionKey !== undefined && (!contract.list || !contract.collectionKey.trim())) {
          throw new Error(`Provider "${provider.metadata.name}" inspection resource "${resource}" has a collection key without a valid list contract.`);
        }
        const idAndNameExclusive = contract.mutuallyExclusive?.some((group) => (
          group.includes('id') && group.includes('name')
        ));
        const canonicalCollection = ['database', 'cache', 'storage'].includes(resource);
        if (contract.mode === 'provider-resource' && contract.list && idAndNameExclusive
          && !canonicalCollection && !contract.collectionKey?.trim()) {
          throw new Error(
            `Provider "${provider.metadata.name}" inspection resource "${resource}" must declare a collection key so exact selector results can be validated.`
          );
        }
      }
    }

    const retainedCleanup = provider.retainedCleanup;
    if (retainedCleanup) {
      const resources = new Set(retainedCleanup.resources);
      if (resources.size !== retainedCleanup.resources.length || resources.size === 0) {
        throw new Error(`Provider "${provider.metadata.name}" retained cleanup resources must be non-empty and unique.`);
      }
      for (const resource of retainedCleanup.resources) {
        const contract = inspection?.selectors[resource];
        const accepted = new Set([
          ...(contract?.required ?? []),
          ...(contract?.optional ?? []),
          ...(contract?.oneOf?.flat() ?? []),
        ]);
        const idAndNameExclusive = contract?.mutuallyExclusive?.some((group) => (
          group.includes('id') && group.includes('name')
        ));
        if (
          !inspection?.resources.includes(resource)
          || contract?.mode !== 'provider-resource'
          || contract.list !== true
          || !accepted.has('id')
          || !accepted.has('name')
          || !accepted.has('limit')
          || !idAndNameExclusive
          || (contract.scopeKeys?.length ?? 0) === 0
          || !contract.collectionKey?.trim()
        ) {
          throw new Error(
            `Provider "${provider.metadata.name}" declares retained cleanup for "${resource}" without bounded exact-id/name inspection, durable scope, and a collection key.`
          );
        }
      }
    }

    if (provider.metadata.lifecycle?.hosting) {
      const environment = inspection?.selectors.environment;
      const accepted = new Set([
        ...(environment?.required ?? []),
        ...(environment?.optional ?? []),
        ...(environment?.oneOf?.flat() ?? []),
      ]);
      if (
        !inspection?.resources.includes('environment')
        || environment?.mode !== 'environment-forensics'
        || environment.list !== true
        || !accepted.has('project')
        || !accepted.has('env')
        || !accepted.has('limit')
      ) {
        throw new Error(
          `Provider "${provider.metadata.name}" declares hosting lifecycle support without bounded provider-owned environment inventory.`
        );
      }
    }

    const lifecycleInventories: Array<{
      resource: 'database' | 'cache' | 'storage';
      supported: boolean;
    }> = [
      {
        resource: 'database',
        supported: (provider.metadata.lifecycle?.databaseEngines?.length ?? 0) > 0
          && (provider.metadata.category === 'database' || typeof provider.derivedAdapters?.database === 'function'),
      },
      {
        resource: 'cache',
        supported: (provider.metadata.lifecycle?.cacheEngines?.length ?? 0) > 0
          && (provider.metadata.category === 'cache' || typeof provider.derivedAdapters?.cache === 'function'),
      },
      {
        resource: 'storage',
        supported: provider.metadata.category === 'storage'
          || typeof provider.derivedAdapters?.storage === 'function',
      },
    ];
    for (const { resource, supported } of lifecycleInventories) {
      if (!supported) continue;
      const contract = inspection?.selectors[resource];
      const accepted = new Set([
        ...(contract?.required ?? []),
        ...(contract?.optional ?? []),
        ...(contract?.oneOf?.flat() ?? []),
      ]);
      const idAndNameExclusive = contract?.mutuallyExclusive?.some((group) => (
        group.includes('id') && group.includes('name')
      ));
      if (
        !inspection?.resources.includes(resource)
        || contract?.mode !== 'provider-resource'
        || contract.list !== true
        || !accepted.has('id')
        || !accepted.has('name')
        || !accepted.has('limit')
        || !idAndNameExclusive
        || (contract.scopeKeys?.length ?? 0) === 0
      ) {
        throw new Error(
          `Provider "${provider.metadata.name}" declares ${resource} lifecycle support without a bounded, exact-id/name, durably scoped ${resource} inventory.`
        );
      }
    }
  }

  /**
   * Get a provider by name
   */
  get(name: string): RegisteredProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all providers in a category
   */
  getByCategory(category: ProviderCategory): RegisteredProvider[] {
    return [...this.providers.values()].filter((p) => p.metadata.category === category);
  }

  /**
   * Get all registered provider names
   */
  names(): string[] {
    return [...this.providers.keys()];
  }

  /** Exact connection provider first, followed by explicitly compatible aliases. */
  connectionProviders(name: string): string[] {
    const aliases = this.providers.get(name)?.metadata.connectionAliases ?? [];
    return [name, ...aliases.filter((alias) => alias !== name)];
  }

  /**
   * Get all registered providers
   */
  all(): RegisteredProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Check if a provider is registered
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Test whether a provider exposes a lifecycle adapter without teaching
   * generic orchestration about provider names. A deployment/database primary
   * adapter satisfies its matching capability; multi-product providers may
   * expose database or storage through derived adapters.
   */
  supports(name: string, capability: ProviderLifecycleCapability): boolean {
    const provider = this.providers.get(name);
    if (!provider) return false;
    if (capability === 'hosting') {
      return provider.metadata.category === 'deployment'
        && provider.metadata.lifecycle?.hosting !== undefined;
    }
    if (capability === 'database') {
      const exposesAdapter = provider.metadata.category === 'database'
        || typeof provider.derivedAdapters?.database === 'function';
      return exposesAdapter
        && (provider.metadata.lifecycle?.databaseEngines?.length ?? 0) > 0;
    }
    if (capability === 'cache') {
      const exposesAdapter = provider.metadata.category === 'cache'
        || typeof provider.derivedAdapters?.cache === 'function';
      return exposesAdapter
        && (provider.metadata.lifecycle?.cacheEngines?.length ?? 0) > 0;
    }
    if (capability === 'storage') {
      return provider.metadata.category === 'storage'
        || typeof provider.derivedAdapters?.storage === 'function';
    }
    if (capability === 'queue') {
      return provider.metadata.lifecycle?.queue !== undefined;
    }
    return provider.metadata.lifecycle?.loadBalancer !== undefined;
  }

  namesFor(capability: ProviderLifecycleCapability): string[] {
    return this.names().filter((name) => this.supports(name, capability));
  }

  lifecycleMaturity(
    name: string,
    capability: ProviderLifecycleCapability
  ): ProviderCapabilityMaturity | undefined {
    if (!this.supports(name, capability)) return undefined;
    return this.providers.get(name)?.metadata.maturity?.lifecycle?.[capability];
  }

  /** Planned capabilities remain discoverable/readable but cannot authorize mutation. */
  supportsMutation(name: string, capability: ProviderLifecycleCapability): boolean {
    const maturity = this.lifecycleMaturity(name, capability);
    return maturity?.status === 'ready-for-live' || maturity?.status === 'supported';
  }

  namesForMutation(capability: ProviderLifecycleCapability): string[] {
    return this.names().filter((name) => this.supportsMutation(name, capability));
  }

  supportsEngine(name: string, capability: 'database' | 'cache', engine: string): boolean {
    const provider = this.providers.get(name);
    if (!provider || !this.supports(name, capability)) return false;
    const engines = capability === 'database'
      ? provider.metadata.lifecycle?.databaseEngines
      : provider.metadata.lifecycle?.cacheEngines;
    return Array.isArray(engines) && engines.includes(engine);
  }

  supportsWorkloadKind(name: string, workloadKind: WorkloadKind): boolean {
    if (!this.supports(name, 'hosting')) return false;
    return this.providers.get(name)?.metadata.lifecycle?.hosting?.workloadKinds
      .includes(workloadKind) === true;
  }

  /**
   * Validate credentials against a provider's schema
   */
  validateCredentials(
    name: string,
    creds: unknown
  ): { success: boolean; error?: string; data?: unknown } {
    const provider = this.providers.get(name);
    if (!provider) {
      return { success: false, error: `Unknown provider: ${name}` };
    }
    const result = provider.metadata.credentialsSchema.safeParse(creds);
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }

  /**
   * Create an adapter instance for a provider
   */
  async createAdapter<T = unknown>(name: string, creds: unknown): Promise<T> {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Unknown provider: ${name}`);
    }
    return await provider.factory(creds) as T;
  }

  /**
   * Get provider metadata
   */
  getMetadata(name: string): ProviderMetadata | undefined {
    return this.providers.get(name)?.metadata;
  }
}

// Export singleton instance
export const providerRegistry = new ProviderRegistry();
