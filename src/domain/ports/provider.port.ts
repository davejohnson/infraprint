import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { Component, ComponentType } from '../entities/component.entity.js';

export interface Receipt {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface DeploymentMutationOptions {
  /**
   * Apply service configuration and environment changes without independently
   * sourcing or building new application code. A later exact-SHA CI deploy is
   * the code release boundary; providers may still reconcile configuration
   * against the currently deployed image.
   */
  deferDeployment?: boolean;
}

/** Exact provider context authorized for deleting one hosting service. */
export type HostingServiceDeleteScope = Readonly<
  | {
      scope: 'environment';
      projectId: string;
      environmentId: string;
    }
  | {
      scope: 'project';
      projectId: string;
    }
>;

export interface HostingServiceDeleteOptions {
  /** False requires an observation-only idempotency check and forbids mutation. */
  allowMutation: boolean;
}

/** Non-secret desired hosting placement selected by the spec, not credentials. */
export interface HostingTargetOptions {
  region?: string;
}

/**
 * Capabilities that a deployment provider supports.
 * Used to determine what features are available and how to configure deployments.
 */
export interface ProviderCapabilities {
  /** Build methods the platform supports */
  supportedBuilders: Array<'nixpacks' | 'dockerfile' | 'buildpack' | 'static'>;

  /** Component types the platform can provision (databases, caches) */
  supportedComponents: ComponentType[];

  /** Whether the platform can auto-wire database connections */
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

  /** Whether the adapter can read back live state via observe() */
  supportsObserve: boolean;

  /** Queue backend this hosting provider implements, when it supports queues. */
  queues?: { backend: 'pubsub' | 'postgres' };

  /** Whether one-off in-environment tasks (runJob) are supported. */
  supportsOneOffTasks?: boolean;

  /** Whether config can converge while exact-SHA CI remains the code release boundary. */
  supportsDeferredDeploy?: boolean;

  /** Whether bounded operations can temporarily expose an internal database. */
  supportsTemporaryDatabaseAccess?: boolean;

  /** Whether the adapter can provider-verify reversible workload suspension. */
  supportsMaintenance?: boolean;
}

export interface ComponentResult {
  component: Component;
  receipt: Receipt;
}

export interface DeployResult {
  serviceId: string;
  externalId?: string;
  url?: string;
  status: 'configured' | 'deploying' | 'deployed' | 'failed';
  receipt: Receipt;
}

export interface JobResult {
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  /** Log tail from the task container. */
  output?: string;
  /** Railway: parsed from the exit sentinel; Cloud Run: not reported. */
  exitCode?: number;
  durationMs?: number;
  runner?: 'cloudrun-job' | 'railway-temp-service';
  /** Set when the temp task service could not be deleted (manual cleanup). */
  cleanupWarning?: string;
  receipt: Receipt;
}

/**
 * An externally reachable database endpoint acquired for one bounded
 * operation. Providers may reuse an endpoint that already exists; only
 * endpoints marked temporary are released after the operation.
 */
export interface TemporaryDatabaseAccess {
  connectionUrl: string;
  source: 'direct' | 'private_connector' | 'existing_proxy' | 'created_proxy' | 'temporary_firewall';
  endpoint?: string;
  temporary: boolean;
  /** Opaque provider resource id used only for cleanup. */
  releaseToken?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  environments?: Array<{ id: string; name: string }>;
}

export interface VerifyResult {
  success: boolean;
  error?: string;
  email?: string;
  warning?: string;
}

export interface IProviderAdapter {
  readonly name: string;

  /** Platform capabilities - describes what features this provider supports */
  readonly capabilities: ProviderCapabilities;

  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;

  /** Configure non-secret desired placement before observation or mutation. */
  configureTarget?(target: HostingTargetOptions): void | Promise<void>;

  ensureProject(
    projectName: string,
    environment: Environment
  ): Promise<Receipt>;

  /**
   * Ensure a distinct provider environment exists inside an already-bound
   * provider project. This method must never create or replace the project.
   */
  ensureEnvironment?(environment: Environment): Promise<Receipt>;

  ensureComponent(
    type: ComponentType,
    environment: Environment
  ): Promise<ComponentResult>;

  deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options?: DeploymentMutationOptions
  ): Promise<DeployResult>;

  setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options?: DeploymentMutationOptions
  ): Promise<Receipt>;

  /** Delete only explicitly retired environment variable names. */
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
   * Acquire an externally reachable database endpoint for one bounded
   * operation. Implementations must distinguish reused access from a newly
   * created temporary resource so callers never remove user-managed access.
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

  /**
   * Delete a provider project/app that was created by Hypervibe.
   * Optional because not all providers expose this operation.
   */
  deleteProject?(projectId: string): Promise<{ success: boolean; error?: string }>;

  /** Delete one provider-native environment without deleting its shared project. */
  deleteEnvironment?(
    projectId: string,
    environmentId: string
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;

  /** Delete one exact provider service target that was created by Hypervibe. */
  deleteService?(
    serviceId: string,
    target: HostingServiceDeleteScope,
    options: HostingServiceDeleteOptions
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;

  /**
   * Read back live state for an environment (services, config, env var
   * hashes, databases). Implemented when capabilities.supportsObserve is true.
   */
  observe?(environment: Environment): Promise<import('./observe.port.js').ObservedState>;
}
