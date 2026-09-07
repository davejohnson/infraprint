import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type {
  Receipt,
  DeployResult,
  VerifyResult,
  JobResult,
  DeploymentMutationOptions,
  HostingTargetOptions,
} from './provider.port.js';

/**
 * Capabilities that a hosting platform supports.
 * Used to determine what features are available for a given platform.
 */
export interface HostingCapabilities {
  /** Build methods the platform supports */
  supportedBuilders: Array<'nixpacks' | 'dockerfile' | 'buildpack' | 'static'>;

  /** Whether the platform can auto-wire database connections from components */
  supportsAutoWiring: boolean;

  /** Whether health check endpoints are configurable */
  supportsHealthChecks: boolean;

  /** Whether cron/scheduled jobs are supported */
  supportsCronSchedule: boolean;

  /** Whether release commands (run before deploy) are supported */
  supportsReleaseCommand: boolean;

  /** Whether multiple environments per project are supported natively */
  supportsMultiEnvironment: boolean;

  /** Whether the platform manages TLS certificates automatically */
  managedTls: boolean;

  /** Whether auto-scaling is available */
  supportsAutoScaling: boolean;

  /** Whether the adapter can read back live state via observe() */
  supportsObserve: boolean;

  /** Whether config can converge while exact-SHA CI remains the code release boundary. */
  supportsDeferredDeploy?: boolean;

  /** Whether the adapter can provider-verify reversible workload suspension. */
  supportsMaintenance?: boolean;
}

/**
 * Standard binding keys used in platformBindings for hosting providers.
 * Each hosting adapter uses these keys to store its identifiers.
 */
export interface HostingBindings {
  /** Provider name (e.g., 'railway', 'cloudrun') */
  provider: string;

  /** External project/app ID on the hosting platform */
  projectId: string;

  /** External environment ID (if platform supports multi-env) */
  environmentId?: string;

  /** Map of service names to their external IDs */
  services: Record<string, {
    serviceId: string;
    url?: string;
    customDomains?: string[];
    imageUri?: string;
    workloadKind?: string;
    resourceType?: string;
    jobName?: string;
    schedulerJobName?: string;
    source?: {
      repo?: string;
      branch?: string;
    };
  }>;

  /**
   * Durable, non-secret blockers for service creates whose provider outcome
   * was not fully reconciled. These are recovery hints, never normal service
   * bindings or deletion authority.
   */
  serviceCreateRecovery?: Record<string, HostingServiceCreateRecovery>;
}

export interface HostingServiceCreateRecovery {
  provider: string;
  operation: 'create';
  resourceName: string;
  providerScope: Record<string, string>;
  state: 'unresolved' | 'identified' | 'mismatched';
  serviceId?: string;
  returnedName?: string;
}

const nonEmptyHostingBindingString = z.string().trim().min(1);
const hostingProviderScopeSchema = z.record(nonEmptyHostingBindingString)
  .refine(
    (scope) => Object.keys(scope).length > 0
      && Object.keys(scope).every((key) => key.trim().length > 0),
    'Provider scope must contain at least one non-empty key and value.'
  );

export function createHostingServiceCreateRecovery(input: {
  provider: string;
  resourceName: string;
  providerScope: Record<string, string>;
  state: HostingServiceCreateRecovery['state'];
  serviceId?: string;
  returnedName?: string;
}): HostingServiceCreateRecovery {
  const provider = input.provider.trim();
  const resourceName = input.resourceName.trim();
  const providerScope = Object.fromEntries(
    Object.entries(input.providerScope)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const serviceId = input.serviceId?.trim();
  const returnedName = input.returnedName?.trim();
  if (!provider || !resourceName || Object.keys(providerScope).length === 0
    || Object.entries(providerScope).some(([key, value]) => !key || !value)
    || (input.state === 'unresolved' && serviceId)
    || (input.state !== 'unresolved' && !serviceId)
    || (input.state === 'identified' && returnedName !== resourceName)
    || (input.state === 'mismatched' && returnedName === resourceName)) {
    throw new Error('A hosting service-create recovery marker requires a consistent provider, name, scope, state, and optional provider id.');
  }
  return {
    provider,
    operation: 'create',
    resourceName,
    providerScope,
    state: input.state,
    ...(serviceId ? { serviceId } : {}),
    ...(returnedName ? { returnedName } : {}),
  };
}

export const hostingServiceCreateRecoverySchema = z.object({
  provider: nonEmptyHostingBindingString,
  operation: z.literal('create'),
  resourceName: nonEmptyHostingBindingString,
  providerScope: hostingProviderScopeSchema,
  state: z.enum(['unresolved', 'identified', 'mismatched']),
  serviceId: nonEmptyHostingBindingString.optional(),
  returnedName: nonEmptyHostingBindingString.optional(),
}).strict().superRefine((marker, ctx) => {
  if (marker.state === 'unresolved' && marker.serviceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An unresolved service create cannot claim a provider service ID.',
      path: ['serviceId'],
    });
  }
  if (marker.state !== 'unresolved' && !marker.serviceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An identified or mismatched service create requires a provider service ID.',
      path: ['serviceId'],
    });
  }
  if (marker.state === 'identified' && marker.returnedName !== marker.resourceName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An identified service create must return the exact requested resource name.',
      path: ['returnedName'],
    });
  }
  if (marker.state === 'mismatched' && marker.returnedName === marker.resourceName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A mismatched service create cannot return the exact requested resource name.',
      path: ['returnedName'],
    });
  }
});

export function parseHostingServiceCreateRecovery(
  value: unknown
): HostingServiceCreateRecovery | null {
  const parsed = hostingServiceCreateRecoverySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Runtime schema for platformBindings blobs. Passthrough at every level keeps
 * provider-specific extras (CI sync metadata, Railway rebind data, scheduler
 * bindings), while malformed known identity and recovery keys fail closed.
 */
const hostingServiceBindingSchema = z.object({
  serviceId: nonEmptyHostingBindingString.optional(),
  url: z.string().optional(),
  customDomains: z.array(z.string()).optional(),
  imageUri: z.string().optional(),
  workloadKind: z.string().optional(),
  resourceType: z.string().optional(),
  jobName: nonEmptyHostingBindingString.optional(),
  schedulerJobName: nonEmptyHostingBindingString.optional(),
  source: z.object({
    repo: z.string().optional(),
    branch: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const hostingServicesSchema = z.record(hostingServiceBindingSchema)
  .refine(
    (services) => Object.keys(services).every((name) => name.trim().length > 0),
    'Service binding names must not be empty.'
  );

const serviceCreateRecoveryMapSchema = z.record(hostingServiceCreateRecoverySchema)
  .refine(
    (recoveries) => Object.keys(recoveries).every((name) => name.trim().length > 0),
    'Service-create recovery names must not be empty.'
  );

const retainedProviderScopeSchema = z.record(nonEmptyHostingBindingString)
  .refine(
    (scope) => Object.keys(scope).length > 0 && Object.keys(scope).every((key) => key.trim().length > 0),
    'Retained provider scope must contain non-empty keys and values.'
  );

const previousDatabaseSchema = z.object({
  provider: nonEmptyHostingBindingString,
  externalId: nonEmptyHostingBindingString,
  engine: z.literal('postgres'),
  name: nonEmptyHostingBindingString,
  providerScope: retainedProviderScopeSchema,
}).passthrough();

const previousCacheSchema = z.object({
  provider: nonEmptyHostingBindingString,
  externalId: nonEmptyHostingBindingString,
  engine: z.literal('redis'),
  providerEngine: z.enum(['redis', 'valkey']),
  name: nonEmptyHostingBindingString,
  resourceKind: nonEmptyHostingBindingString.optional(),
  providerScope: retainedProviderScopeSchema,
}).passthrough();

export const hostingBindingsSchema = z.object({
  provider: nonEmptyHostingBindingString.optional(),
  projectId: nonEmptyHostingBindingString.optional(),
  environmentId: nonEmptyHostingBindingString.optional(),
  services: hostingServicesSchema.optional(),
  serviceCreateRecovery: serviceCreateRecoveryMapSchema.optional(),
  previousDatabase: previousDatabaseSchema.optional(),
  previousCache: previousCacheSchema.optional(),
  domainDns: z.object({
    name: z.string().optional(),
    proxied: z.boolean().optional(),
    recreateRevision: z.string().optional(),
    providerDomainId: z.string().optional(),
    serviceName: z.string().optional(),
    serviceId: z.string().optional(),
    environmentId: z.string().optional(),
    zoneId: z.string().optional(),
    records: z.array(z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      target: z.string(),
    }).strict()).optional(),
  }).passthrough().optional(),
  maintenance: z.record(z.unknown()).optional(),
}).passthrough().default({});

export type ParsedHostingBindings = z.infer<typeof hostingBindingsSchema>;

/**
 * Read an environment's platformBindings as HostingBindings-shaped data.
 * Missing legacy state is empty; malformed known keys throw so callers cannot
 * reinterpret a corrupt identity or recovery marker as permission to create.
 */
export function parseHostingBindings(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): ParsedHostingBindings {
  return hostingBindingsSchema.parse(environment?.platformBindings ?? {});
}

/**
 * Interface for hosting platform adapters.
 * Hosting adapters handle deploying services to cloud platforms.
 */
export interface IHostingAdapter {
  readonly name: string;

  /** Platform capabilities */
  readonly capabilities: HostingCapabilities;

  /**
   * Connect to the hosting platform with credentials
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

  /** Configure non-secret desired placement before observation or mutation. */
  configureTarget?(target: HostingTargetOptions): void | Promise<void>;

  /**
   * Ensure a project/app exists on the hosting platform.
   * Creates one if it doesn't exist, or verifies the existing one.
   * Returns the external project ID in receipt.data.projectId
   */
  ensureProject(projectName: string, environment: Environment): Promise<Receipt>;

  /**
   * Ensure a distinct provider environment exists inside an already-bound
   * provider project. This method must never create or replace the project.
   */
  ensureEnvironment?(environment: Environment): Promise<Receipt>;

  /**
   * Deploy a service to the hosting platform.
   * Includes setting environment variables and triggering the deployment.
   */
  deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options?: DeploymentMutationOptions
  ): Promise<DeployResult>;

  /**
   * Update environment variables for a deployed service.
   */
  setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options?: DeploymentMutationOptions
  ): Promise<Receipt>;

  /**
   * Delete only explicitly retired environment variable names. Omitted
   * variables are not deletions.
   */
  deleteEnvVars?(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt>;

  /**
   * Disconnect a provider-native repository source so pushes cannot bypass
   * manual promotion or a Hypervibe-owned CI deployment workflow.
   */
  disconnectDeploySource?(params: { serviceId: string }): Promise<Receipt>;

  /**
   * Get the current deployment status.
   */
  getDeployStatus?(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string; reason?: string }>;

  /**
   * Run a one-off command in a deployed service environment. Implementations
   * must wait for terminal completion and return status="completed" only
   * after a zero/successful exit.
   */
  runJob?(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult>;

  /**
   * Delete a provider project/app that was created by Hypervibe.
   * Optional because not all hosting providers expose this operation.
   */
  deleteProject?(projectId: string): Promise<{ success: boolean; error?: string }>;

  /** Delete one provider-native environment without deleting its shared project. */
  deleteEnvironment?(
    projectId: string,
    environmentId: string
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;

  /**
   * Delete a provider service/resource that was created by Hypervibe.
   * Optional because not all hosting providers expose this operation.
   */
  deleteService?(serviceId: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Get connection URL for a database component.
   * Used when the hosting platform also provides databases.
   */
  getDatabaseUrl?(
    environment: Environment,
    componentType: string
  ): Promise<string | null>;

  /**
   * Get runtime logs for a service (for error monitoring).
   * Used by the auto-fix agent to detect and analyze errors.
   */
  getLogs?(
    environment: Environment,
    serviceName: string,
    options?: GetLogsOptions
  ): Promise<LogEntry[]>;

  /**
   * Read back live state for an environment (services, config, env var
   * hashes, databases). Implemented when capabilities.supportsObserve is true.
   */
  observe?(environment: Environment): Promise<import('./observe.port.js').ObservedState>;
}

/**
 * Options for fetching logs from a hosting platform.
 */
export interface GetLogsOptions {
  /** Maximum number of log entries to return */
  limit?: number;
  /** Only return logs after this timestamp */
  since?: Date;
  /** Only return errors/warnings */
  errorsOnly?: boolean;
}

/**
 * A normalized log entry from any hosting platform.
 */
export interface LogEntry {
  /** When the log was emitted */
  timestamp: Date;
  /** The log message content */
  message: string;
  /** Log severity level */
  severity: 'info' | 'warn' | 'error';
  /** Raw log line as returned by the platform */
  raw: string;
}
