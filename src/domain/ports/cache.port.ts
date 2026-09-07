import type { Environment } from '../entities/environment.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { ObservedCache } from './observe.port.js';
import type { Receipt, VerifyResult } from './provider.port.js';

export type CacheEngine = 'redis';

export interface CacheCapabilities {
  supportedCaches: CacheEngine[];
  supportsTls: boolean;
  supportsHighAvailability: boolean;
  supportsPersistence: boolean;
  serverlessOptimized: boolean;
  /** Successful provisioning must return a validated runtimeNetwork binding. */
  requiresRuntimeNetwork?: boolean;
}

export interface CacheProvisionResult {
  component: Component;
  receipt: Receipt;
  connectionUrl?: string;
  envVars?: Record<string, string>;
}

/** Non-secret desired cache placement/capacity passed through reconciliation. */
export interface CacheTargetOptions {
  /** Operational naming context; not provider placement and not persisted in credentials. */
  projectName?: string;
  region?: string;
  network?: string;
  subnetwork?: string;
  tier?: string;
  size?: string;
}

/**
 * Non-secret recovery identity for an ancillary cache-network create whose
 * provider response was lost. This is a retry blocker/reconciliation target,
 * never deletion authority and never a cache identity.
 */
export interface UnresolvedCacheNetworkCreateMutation {
  resourceKind: 'cache-network';
  operation: 'create';
  resourceName: string;
  cacheName: string;
  providerScope: Record<string, string>;
  networkScope: Record<string, string>;
  ownership: Record<string, string>;
}

function normalizedNonEmptyStringRecord(
  value: Record<string, string>
): Record<string, string> {
  const normalized = Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key.trim(), item.trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  if (Object.keys(normalized).length === 0
    || Object.entries(normalized).some(([key, item]) => !key || !item)) {
    throw new Error('Cache-network recovery scope must contain non-empty keys and values.');
  }
  return normalized;
}

export function createUnresolvedCacheNetworkMutation(params: {
  resourceName: string;
  cacheName: string;
  providerScope: Record<string, string>;
  networkScope: Record<string, string>;
  ownership: Record<string, string>;
}): UnresolvedCacheNetworkCreateMutation {
  const resourceName = params.resourceName.trim();
  const cacheName = params.cacheName.trim();
  if (!resourceName || !cacheName) {
    throw new Error('Cache-network recovery requires exact resource and cache names.');
  }
  return {
    resourceKind: 'cache-network',
    operation: 'create',
    resourceName,
    cacheName,
    providerScope: normalizedNonEmptyStringRecord(params.providerScope),
    networkScope: normalizedNonEmptyStringRecord(params.networkScope),
    ownership: normalizedNonEmptyStringRecord(params.ownership),
  };
}

export function parseUnresolvedCacheNetworkMutation(
  bindings: unknown
): UnresolvedCacheNetworkCreateMutation | null {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const raw = (bindings as Record<string, unknown>).unresolvedNetworkMutation;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (Object.keys(marker).some((key) => ![
    'resourceKind', 'operation', 'resourceName', 'cacheName',
    'providerScope', 'networkScope', 'ownership',
  ].includes(key))) return null;
  if (marker.resourceKind !== 'cache-network' || marker.operation !== 'create'
    || typeof marker.resourceName !== 'string' || !marker.resourceName.trim()
    || typeof marker.cacheName !== 'string' || !marker.cacheName.trim()) return null;
  const parseRecord = (value: unknown): Record<string, string> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || entries.some(([key, item]) => (
      !key.trim() || typeof item !== 'string' || !item.trim()
    ))) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const providerScope = parseRecord(marker.providerScope);
  const networkScope = parseRecord(marker.networkScope);
  const ownership = parseRecord(marker.ownership);
  if (!providerScope || !networkScope || !ownership) return null;
  return createUnresolvedCacheNetworkMutation({
    resourceName: marker.resourceName,
    cacheName: marker.cacheName,
    providerScope,
    networkScope,
    ownership,
  });
}

/**
 * Cache lifecycle is deliberately separate from databases: Redis has its own
 * runtime contract and bounded verification, and SQL migration commands do
 * not apply to it.
 */
export interface ICacheAdapter {
  readonly name: string;
  readonly capabilities: CacheCapabilities;

  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;

  /** Configure read scope before observation. This must not mutate the provider. */
  configureTarget?(target: CacheTargetOptions): void | Promise<void>;

  provision(
    engine: CacheEngine,
    environment: Environment,
    options?: CacheTargetOptions & {
      resourceName?: string;
      /** Exact durable binding when reconciling an existing cache. */
      component?: Component | null;
    }
  ): Promise<CacheProvisionResult>;

  getConnectionUrl(component: Component): Promise<string | null>;
  destroy(component: Component): Promise<Receipt>;
  getStatus?(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }>;
  observeCache(
    environment: Environment,
    component?: Component | null,
    options?: CacheTargetOptions & { resourceName?: string }
  ): Promise<ObservedCache | null>;
}

/** Runtime proof for every method required by the cache lifecycle contract. */
export function supportsCacheLifecycle(value: unknown): value is ICacheAdapter {
  if (!value || typeof value !== 'object') return false;
  const adapter = value as Partial<ICacheAdapter>;
  return typeof adapter.name === 'string'
    && Boolean(adapter.capabilities)
    && Array.isArray(adapter.capabilities?.supportedCaches)
    && typeof adapter.connect === 'function'
    && typeof adapter.verify === 'function'
    && typeof adapter.provision === 'function'
    && typeof adapter.observeCache === 'function'
    && typeof adapter.getConnectionUrl === 'function'
    && typeof adapter.destroy === 'function';
}
