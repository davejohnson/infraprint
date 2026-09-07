import { createHash } from 'crypto';
import type { Environment } from '../entities/environment.entity.js';
import type { Component } from '../entities/component.entity.js';

/**
 * Live infrastructure state read back from a provider — the "observe" half of
 * the spec → observe → diff → converge loop.
 *
 * Adapters that support observation declare `supportsObserve: true` in their
 * capabilities and implement `observe()`. When a provider can't be observed,
 * the diff engine falls back to local state and marks actions `verified: false`.
 */

export interface ObservedService {
  name: string;
  externalId: string;
  workloadKind: 'web' | 'worker' | 'cron';
  url?: string;
  customDomains: string[];
  customDomainStatus?: Record<string, {
    /** Durable provider attachment identity, when exposed by the provider. */
    providerDomainId?: string;
    /** Provider-confirmed domain verification state, when exposed by the provider. */
    providerVerified?: boolean;
    certificateStatus?: string;
    dnsConfigured?: boolean;
    dnsRecords?: Array<{
      name: string;
      type: string;
      value: string;
      currentValue?: string;
      purpose?: string;
      status?: string;
    }>;
  }>;
  config: {
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    public?: boolean;
    /** Provider-observed runtime VPC attachment for a private cache. */
    cacheNetwork?: {
      network: string;
      subnetwork: string;
      egress: string;
    };
  };
  /** Repo-linked deploy source, when the provider links services to a git repo. */
  source?: { repo?: string; branch?: string };
  /**
   * Provider-native repo-link observation is tri-state. `disconnected` is the
   * only state that proves a CI-owned service cannot also auto-deploy pushes.
   */
  sourceState?: 'connected' | 'disconnected' | 'unknown';
  /** Env var names present on the live service. Values are never returned. */
  envVarKeys: string[];
  /** sha256 hex of each env var value, for drift comparison without exposure. */
  envVarHashes: Record<string, string>;
  /** 'empty' = the service exists but has never deployed (no source/code). */
  status: 'running' | 'failed' | 'empty' | 'unknown';
  /**
   * Provider-native identity of the deployment or revision currently selected
   * for this service. This is used to prove that runtime configuration changes
   * have reached a later deployment without exposing configuration values.
   */
  deployment?: {
    id: string;
    status?: string;
    createdAt?: string;
  };
  /** Provider-confirmed execution state used by environment maintenance. */
  maintenance?: {
    state: 'running' | 'suspended' | 'unknown';
    deploymentId?: string;
    deploymentStatus?: string;
    numReplicas?: number;
    sleepApplication?: boolean;
    providerState?: Record<string, unknown>;
  };
}

export interface ObservedMaintenanceEdge {
  state: 'active' | 'inactive' | 'unknown';
  hostname: string;
  markerVerified: boolean;
  accountId?: string;
  zoneId?: string;
  routeId?: string;
  scriptName?: string;
  contentHash?: string;
  reason?: string;
}

export interface ObservedMaintenanceWorkload {
  state: 'running' | 'suspended' | 'unknown';
  serviceId: string;
  workloadKind: string;
  deploymentId?: string;
  deploymentStatus?: string;
  numReplicas?: number;
  sleepApplication?: boolean;
  cronSchedule?: string;
  providerState?: Record<string, unknown>;
  reason?: string;
}

export interface ObservedMaintenanceDatabase {
  state: 'fenced' | 'unfenced' | 'not-applicable' | 'unknown';
  componentId?: string;
  externalId?: string;
  reason?: string;
}

export interface EnvironmentMaintenanceObservation {
  state: 'active' | 'inactive' | 'partial' | 'unknown';
  stage: 'edge' | 'workloads' | 'database' | 'verified' | 'exit' | 'unknown';
  edge: ObservedMaintenanceEdge;
  workloads: Record<string, ObservedMaintenanceWorkload>;
  database: ObservedMaintenanceDatabase;
}

export interface ObservedDatabase {
  provider: string;
  engine: string;
  externalId: string;
  /** Opaque, non-secret provider scope that disambiguates a provider-native id. */
  providerScope?: Record<string, string>;
  name?: string;
  status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
  resilience?: {
    availability?: 'zonal' | 'regional' | 'unknown';
    backupPolicy?: {
      enabled: boolean;
      pitrEnabled: boolean;
      retainedBackups?: number;
      pitrRetentionDays?: number;
    };
    replicas?: Array<{
      /** Stable spec key when the provider identity is Hypervibe-managed. */
      name?: string;
      externalId: string;
      status: string;
      region?: string;
      tier?: string;
      connectionName?: string;
    }>;
  };
}

export interface ObservedCache {
  provider: string;
  engine: 'redis';
  externalId: string;
  /** Opaque, non-secret provider scope that makes this resource id an instance identity. */
  providerScope?: Record<string, string>;
  name?: string;
  status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
  /** Provider-observed, non-secret declarative placement/capacity. */
  config?: {
    region?: string;
    network?: string;
    subnetwork?: string;
    tier?: string;
    size?: string;
  };
}

export interface ObservedStorage {
  provider: string;
  kind: 'object';
  externalId: string;
  /** Opaque, non-secret provider scope that makes this resource id an instance identity. */
  instanceScope?: Record<string, string>;
  name: string;
  region?: string;
  status: string;
  objectCount?: number;
  sizeBytes?: number;
}

export interface ObservedState {
  provider: string;
  observedAt: string;
  projectExists: boolean;
  projectId?: string;
  environmentId?: string;
  services: ObservedService[];
  databases: ObservedDatabase[];
  caches?: ObservedCache[];
  storage?: ObservedStorage[];
  /** Completeness is per resource class; unknown must never be treated as absent. */
  completeness?: {
    project?: 'complete' | 'unknown';
    environment?: 'complete' | 'unknown';
    services?: 'complete' | 'unknown';
    databases?: 'complete' | 'unknown';
    caches?: 'complete' | 'unknown';
    storage?: 'complete' | 'unknown';
    /**
     * Storage can be reconciled through several provider connections in one
     * environment. A provider is absent only when its own inventory completed;
     * the aggregate `storage` field remains for compatibility and is unknown
     * whenever any required provider is unknown.
     */
    storageByProvider?: Record<string, 'complete' | 'unknown'>;
  };
  /** True when one or more sub-queries failed; see warnings. */
  partial: boolean;
  warnings: string[];
  /** Multi-provider observation of the environment maintenance boundary. */
  maintenance?: EnvironmentMaintenanceObservation;
}

export interface IObservableHosting {
  observe(environment: Environment): Promise<ObservedState>;
}

export interface IObservableDatabase {
  observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null>;
}

/** Compute the sha256 hex digest used for env var drift comparison. */
export function hashEnvValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
