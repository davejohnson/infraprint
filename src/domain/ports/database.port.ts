import type { Environment } from '../entities/environment.entity.js';
import type { Component } from '../entities/component.entity.js';
import type { Receipt, TemporaryDatabaseAccess, VerifyResult } from './provider.port.js';
import type { ObservedDatabase } from './observe.port.js';

/**
 * Supported database types that can be provisioned
 */
export type DatabaseType = 'postgres';

/**
 * All provisionable component types
 */
export type ProvisionableType = DatabaseType;

/**
 * Capabilities that a database provider supports.
 */
export interface DatabaseCapabilities {
  /** Database types the provider supports */
  supportedDatabases: DatabaseType[];

  /** Whether the provider supports connection pooling (important for serverless) */
  supportsPooling: boolean;

  /** Whether this adapter implements declarative read-replica lifecycle. */
  supportsReadReplicas: boolean;

  /** Whether this adapter implements declarative point-in-time recovery policy. */
  supportsPointInTimeRecovery: boolean;

  /** Whether the provider is optimized for serverless workloads */
  serverlessOptimized: boolean;

  /** Whether bounded operations can acquire and release provider-owned access. */
  supportsTemporaryDatabaseAccess?: boolean;

  /** Prefer provider-owned access even when a stored public-looking URL exists. */
  prefersTemporaryDatabaseAccess?: boolean;
}

/**
 * Result of provisioning a database
 */
export interface ProvisionResult {
  /** The provisioned component with bindings populated */
  component: Component;

  /** Standard receipt with success/failure info */
  receipt: Receipt;

  /** Connection URL ready for injection into hosting environment */
  connectionUrl?: string;

  /** Additional environment variables to set (e.g., individual host/port/user/pass) */
  envVars?: Record<string, string>;
}

/** Non-secret logical placement used to scope database observation/mutation. */
export interface DatabaseTargetOptions {
  /** Logical Hypervibe project name used only for provider-owned deterministic naming. */
  projectName?: string;
  /** Hosting placement inherited by same-cloud database providers. */
  region?: string;
}

/**
 * Durable blocker for a datastore create request whose provider-assigned resource ID was
 * not returned and whose outcome could not be resolved by bounded observation.
 * The marker is deliberately not a provider identity and must never be used as
 * a destroy target. It preserves only the exact deterministic lookup name and
 * non-secret provider scope needed to prevent another create.
 */
export interface UnresolvedDatastoreCreateMutation {
  resourceKind: 'database' | 'cache';
  operation: 'create';
  resourceName: string;
  providerScope: Record<string, string>;
}

export function createUnresolvedDatastoreMutation(
  resourceKind: 'database' | 'cache',
  resourceName: string,
  providerScope: Record<string, string>
): UnresolvedDatastoreCreateMutation {
  const normalizedName = resourceName.trim();
  const scope = Object.fromEntries(
    Object.entries(providerScope)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  if (!normalizedName || Object.keys(scope).length === 0
    || Object.entries(scope).some(([key, value]) => !key || !value)) {
    throw new Error('An unresolved datastore create requires an exact resource name and complete provider scope.');
  }
  return {
    resourceKind,
    operation: 'create',
    resourceName: normalizedName,
    providerScope: scope,
  };
}

export function createUnresolvedDatabaseMutation(
  resourceName: string,
  providerScope: Record<string, string>
): UnresolvedDatastoreCreateMutation & { resourceKind: 'database' } {
  return createUnresolvedDatastoreMutation(
    'database',
    resourceName,
    providerScope
  ) as UnresolvedDatastoreCreateMutation & { resourceKind: 'database' };
}

export function parseUnresolvedDatastoreMutation(
  bindings: unknown,
  expectedKind?: 'database' | 'cache'
): UnresolvedDatastoreCreateMutation | null {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const raw = (bindings as Record<string, unknown>).unresolvedMutation;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (!['database', 'cache'].includes(String(marker.resourceKind))
    || (expectedKind && marker.resourceKind !== expectedKind)
    || marker.operation !== 'create') return null;
  if (Object.keys(marker).some((key) => (
    !['resourceKind', 'operation', 'resourceName', 'providerScope'].includes(key)
  ))) return null;
  if (typeof marker.resourceName !== 'string' || !marker.resourceName.trim()) return null;
  if (!marker.providerScope || typeof marker.providerScope !== 'object'
    || Array.isArray(marker.providerScope)) return null;
  const entries = Object.entries(marker.providerScope as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([key, value]) => (
    !key.trim() || typeof value !== 'string' || !value.trim()
  ))) return null;
  return createUnresolvedDatastoreMutation(
    marker.resourceKind as 'database' | 'cache',
    marker.resourceName,
    Object.fromEntries(entries) as Record<string, string>
  );
}

export function parseUnresolvedDatabaseMutation(
  bindings: unknown
): (UnresolvedDatastoreCreateMutation & { resourceKind: 'database' }) | null {
  return parseUnresolvedDatastoreMutation(bindings, 'database') as
    | (UnresolvedDatastoreCreateMutation & { resourceKind: 'database' })
    | null;
}

/** A rejected 4xx create is definitive except request timeout; transport
 * failures, HTTP 408/5xx, and malformed successful responses remain possibly
 * committed. */
export function databaseCreateMayHaveCommitted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const status = [
    candidate.status,
    candidate.statusCode,
    candidate.$metadata?.httpStatusCode,
  ].find((value): value is number => typeof value === 'number' && Number.isInteger(value));
  return status === undefined || status === 408 || status < 400 || status >= 500;
}

/**
 * Standard binding keys used for database components
 */
export interface DatabaseBindings {
  /** Provider name (e.g., 'supabase', 'cloudsql', 'railway', 'rds') */
  provider: string;

  /** External database/instance ID */
  instanceId: string;

  /** Connection URL */
  connectionUrl: string;

  /** Pooled connection URL (if available) */
  pooledUrl?: string;

  /** Individual connection parameters */
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
}

/**
 * Interface for database provider adapters.
 * Database adapters provision and manage databases independently of hosting.
 * The connection URLs they produce are injected into hosting platforms.
 */
export interface IDatabaseAdapter {
  readonly name: string;

  /** Provider capabilities */
  readonly capabilities: DatabaseCapabilities;

  /**
   * Connect to the database provider with credentials
   */
  connect(credentials: unknown): Promise<void>;

  /**
   * Verify the connection and credentials are valid
   */
  verify(): Promise<VerifyResult>;

  /**
   * Disconnect and clean up
   */
  disconnect?(): Promise<void>;

  /** Configure read scope before observation. This method must not mutate. */
  configureTarget?(target: DatabaseTargetOptions): void | Promise<void>;

  /**
   * Provision a new database instance.
   * Returns the component with connection details ready for use.
   */
  provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      /** Instance size/tier */
      size?: string;
      /** Region for the instance */
      region?: string;
      /** Database name to create */
      databaseName?: string;
      /** Provider resource identity; distinct from the logical database name. */
      resourceName?: string;
    }
  ): Promise<ProvisionResult>;

  /**
   * Observe one durable provider database identity. Provider-confirmed
   * not-found returns null; every other read failure must throw.
   */
  observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null>;

  /**
   * Get the connection URL for an existing component.
   * Useful when the URL needs to be refreshed or retrieved.
   */
  getConnectionUrl(component: Component): Promise<string | null>;

  /**
   * Destroy a provisioned database instance.
   * Use with caution - this deletes data permanently.
   */
  destroy(component: Component): Promise<Receipt>;

  /**
   * Check the status of a database instance.
   */
  getStatus?(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }>;

  /**
   * Acquire an externally usable endpoint for one bounded operation.
   * Implementations must mark reused access temporary=false so callers never
   * remove user-managed access.
   */
  acquireTemporaryDatabaseAccess?(
    environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess>;

  /** Release only access returned with temporary=true by this adapter. */
  releaseTemporaryDatabaseAccess?(
    environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void>;
}

/** Runtime proof for every method required by the database lifecycle contract. */
export function supportsDatabaseLifecycle(value: unknown): value is IDatabaseAdapter {
  if (!value || typeof value !== 'object') return false;
  const adapter = value as Partial<IDatabaseAdapter>;
  return typeof adapter.name === 'string'
    && Boolean(adapter.capabilities)
    && Array.isArray(adapter.capabilities?.supportedDatabases)
    && typeof adapter.connect === 'function'
    && typeof adapter.verify === 'function'
    && typeof adapter.provision === 'function'
    && typeof adapter.observeDatabase === 'function'
    && typeof adapter.getConnectionUrl === 'function'
    && typeof adapter.destroy === 'function';
}
