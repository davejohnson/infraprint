import type { Service } from '../entities/service.entity.js';
import type { Component } from '../entities/component.entity.js';

export type PlanActionType = 'create' | 'update' | 'replace' | 'destroy' | 'noop';

export type PlanResourceKind = 'project' | 'environment' | 'service' | 'database' | 'cache' | 'storage' | 'retained-resource' | 'load-balancer' | 'domain' | 'email' | 'messaging' | 'ci' | 'repo' | 'ios' | 'queue' | 'secret' | 'payment' | 'maintenance';

export interface PlanFieldDiff {
  /** Field name; env vars appear as "env:KEY" with no values. */
  field: string;
  from?: string;
  to?: string;
}

export interface PlanAction {
  /** Stable id, e.g. "service:web", "database:postgres". */
  id: string;
  type: PlanActionType;
  resource: {
    kind: PlanResourceKind;
    name: string;
    provider: string;
  };
  /** False when derived from local state only (provider not observable). */
  verified: boolean;
  reason: string;
  diff?: PlanFieldDiff[];
  /** Destroying this resource loses data (databases). */
  dataBearing?: boolean;
  /** Creating/updating this resource can charge the provider account. */
  billable?: boolean;
  /** Action is skipped by apply unless explicitly confirmed. */
  requiresConfirm?: boolean;
  /** Ids of actions that must complete first. */
  dependsOn?: string[];
  /** Provider/action-specific non-secret context shown in plans and persisted with the plan. */
  metadata?: Record<string, unknown>;
}

/** Local (SQLite) view of an environment, input to the diff. */
export interface LocalSnapshot {
  projectExists: boolean;
  environmentExists: boolean;
  services: Service[];
  components: Component[];
  bindings?: {
    provider?: string;
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId?: string; url?: string; customDomains?: string[] }>;
    /** Durable blockers for hosting creates whose exact outcome is unresolved. */
    serviceCreateRecovery?: Record<string, unknown>;
    domainDns?: {
      name?: string;
      proxied?: boolean;
      recreateRevision?: string;
      providerDomainId?: string;
      serviceName?: string;
      serviceId?: string;
      environmentId?: string;
      zoneId?: string;
      records?: Array<{ id: string; name: string; type: string; target: string }>;
    };
    /** Bindings of the hosting provider abandoned by a provider switch; drives confirm-gated teardown. */
    previousHosting?: {
      provider?: string;
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };
    /** Exact abandoned datastore identity retained only for isolated, confirmation-gated cleanup. */
    previousDatabase?: {
      provider?: string;
      externalId?: string;
      engine?: string;
      name?: string;
      resourceKind?: string;
      providerScope?: Record<string, string>;
    };
    /** Exact abandoned cache identity retained only for isolated, confirmation-gated cleanup. */
    previousCache?: {
      provider?: string;
      externalId?: string;
      engine?: string;
      providerEngine?: string;
      name?: string;
      resourceKind?: string;
      providerScope?: Record<string, string>;
    };
    /** Exact extra provider identity retained only for isolated, confirmation-gated cleanup. */
    previousResource?: {
      provider?: string;
      resource?: string;
      externalId?: string;
      name?: string;
      providerScope?: Record<string, string>;
    };
    storage?: Record<string, { provider?: string; externalId?: string; region?: string }>;
    /** Runtime network selected by the active cache, consumed by hosting. */
    cacheNetwork?: {
      provider?: string;
      projectId?: string;
      region?: string;
      network?: string;
      subnetwork?: string;
      egress?: string;
    } | null;
    maintenance?: Record<string, unknown>;
  };
}

export interface DiffResult {
  actions: PlanAction[];
  /** Live resources absent from the spec with no local binding proving Hypervibe ownership. */
  unmanaged: Array<{ kind: PlanResourceKind | 'envVar'; name: string; detail?: string }>;
  warnings: string[];
}
