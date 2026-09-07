import { z } from 'zod';
import type {
  IProviderAdapter,
  Receipt,
  ComponentResult,
  DeployResult,
  JobResult,
  ProviderCapabilities,
  DeploymentMutationOptions,
} from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { serviceWorkloadKind, type Service } from '../../../domain/entities/service.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { providerRegistry, type ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import { buildCloudRunGitHubActionsSteps, CLOUDRUN_CI_REQUIRED_SECRETS } from './cloudrun-ci.workflow.js';
import { buildCloudRunPortableRecipe } from './cloudrun-ci.recipe.js';
import { parseHostingBindings, type GetLogsOptions, type LogEntry } from '../../../domain/ports/hosting.port.js';
import * as pubsub from './pubsub.api.js';
import { pubsubQueueResourceIds } from '../../../domain/services/queue-env.js';
import { hashEnvValue, type ObservedService, type ObservedState } from '../../../domain/ports/observe.port.js';
import { generatedContainerDockerfile } from '../../../domain/services/generated-container.js';
import type {
  IWorkloadMaintenanceAdapter,
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../../domain/ports/maintenance.port.js';
import type { IQueueAdapter } from '../../../domain/ports/queue.port.js';
import type {
  IProviderDeploymentsAdapter,
  IProviderRuntimeLogsAdapter,
  ProviderDeployment,
  ProviderDeploymentsRequest,
  ProviderRuntimeLogsRequest,
  ProviderRuntimeLogsResult,
} from '../../../domain/ports/provider-logs.port.js';

// Credentials schema for self-registration
const CloudRunAuthenticationSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
}).strict();

export const CloudRunCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { region: _legacyRegion, ...authentication } = input as Record<string, unknown>;
  return authentication;
}, CloudRunAuthenticationSchema);

export type CloudRunCredentials = z.infer<typeof CloudRunCredentialsSchema>;
const DEFAULT_CLOUD_RUN_REGION = 'us-central1';
const CloudRunRegionSchema = z.string().trim().min(1, 'GCP region is required');
type ConnectedCloudRunCredentials = CloudRunCredentials & { region: string };

const MANAGED_DATABASE_ENV_KEYS = new Set([
  'DATABASE_URL',
  'DIRECT_URL',
  'DATABASE_POOLER_URL',
  'DATABASE_SSL',
  'CLOUD_SQL_CONNECTION_NAME',
  'INSTANCE_CONNECTION_NAME',
  'DATABASE_HOST',
  'DB_HOST',
  'PGHOST',
  'DATABASE_PORT',
  'DB_PORT',
  'PGPORT',
  'DATABASE_USER',
  'DB_USER',
  'PGUSER',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'PGPASSWORD',
  'DATABASE_NAME',
  'DB_NAME',
  'PGDATABASE',
]);

const MANAGED_DATABASE_SYNC_KEYS = new Set([
  'DATABASE_URL',
  'DIRECT_URL',
  'DATABASE_POOLER_URL',
  'DATABASE_HOST',
  'DB_HOST',
  'PGHOST',
  'CLOUD_SQL_CONNECTION_NAME',
  'INSTANCE_CONNECTION_NAME',
]);

interface CloudRunService {
  name: string;
  uid: string;
  generation: number | string;
  observedGeneration?: number | string;
  reconciling?: boolean;
  labels?: Record<string, string>;
  uri?: string;
  ingress?: string;
  scaling?: {
    scalingMode?: string;
    manualInstanceCount?: number;
    minInstanceCount?: number;
    maxInstanceCount?: number;
  };
  template?: {
    containers?: CloudRunContainer[];
    volumes?: Array<Record<string, unknown>>;
    serviceAccount?: string;
    serviceAccountName?: string;
    vpcAccess?: CloudRunVpcAccess;
  };
  spec?: {
    template?: {
      spec?: {
        containers?: CloudRunContainer[];
        volumes?: Array<Record<string, unknown>>;
        serviceAccountName?: string;
        vpcAccess?: CloudRunVpcAccess;
      };
    };
  };
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudRunJob {
  name?: string;
  generation?: string;
  observedGeneration?: string;
  reconciling?: boolean;
  labels?: Record<string, string>;
  template?: {
    template?: {
      containers?: CloudRunContainer[];
      volumes?: Array<Record<string, unknown>>;
      serviceAccount?: string;
      serviceAccountName?: string;
      resources?: Record<string, unknown>;
      vpcAccess?: CloudRunVpcAccess;
    };
  };
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudRunVpcAccess {
  networkInterfaces?: Array<{
    network?: string;
    subnetwork?: string;
    tags?: string[];
  }>;
  egress?: string;
}

interface ResolvedCloudRunVpcAccess {
  /** True when cacheNetwork is explicitly set/null and this action owns convergence. */
  managed: boolean;
  /** Undefined means terminal absence; an object is the exact desired attachment. */
  desired?: {
    network: string;
    subnetwork: string;
    egress: string;
  };
  apiValue?: CloudRunVpcAccess;
}

interface CloudRunRevision {
  name?: string;
  createTime?: string;
  updateTime?: string;
  reconciling?: boolean;
  service?: string;
  logUri?: string;
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudRunExecution {
  name?: string;
  createTime?: string;
  startTime?: string;
  completionTime?: string;
  completionStatus?: string;
  reconciling?: boolean;
  terminalCondition?: CloudRunCondition;
  conditions?: CloudRunCondition[];
}

interface CloudSchedulerJob {
  name?: string;
  schedule?: string;
  timeZone?: string;
  state?: string;
  status?: {
    code?: number;
    message?: string;
  };
}

interface CloudRunCondition {
  type?: string;
  state?: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface CloudRunDomainMapping {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    routeName?: string;
    certificateMode?: string;
    forceOverride?: boolean;
  };
  status?: {
    mappedRouteName?: string;
    conditions?: CloudRunCondition[];
    resourceRecords?: Array<{
      name?: string;
      rrdata?: string;
      type?: string;
    }>;
  };
}

const CLOUD_RUN_DOMAIN_MAPPING_REGIONS = new Set([
  'asia-east1',
  'asia-northeast1',
  'asia-southeast1',
  'europe-north1',
  'europe-west1',
  'europe-west4',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-west1',
]);

interface CloudRunContainer {
  name?: string;
  image?: string;
  env?: Array<Record<string, unknown>>;
  ports?: Array<Record<string, unknown>>;
  command?: string[];
  args?: string[];
  volumeMounts?: Array<Record<string, unknown>>;
  resources?: Record<string, unknown>;
  startupProbe?: { httpGet?: { path?: string } };
  livenessProbe?: { httpGet?: { path?: string } };
}

interface CloudBuildResult {
  success: boolean;
  imageUri?: string;
  buildId?: string;
  logsUrl?: string;
  error?: string;
}

interface CloudBuildStatus {
  id?: string;
  status?: string;
  statusDetail?: string;
  logsUrl?: string;
  logUrl?: string;
  failureInfo?: {
    type?: string;
    detail?: string;
  };
  steps?: Array<{
    id?: string;
    name?: string;
    status?: string;
    exitCode?: number;
    args?: string[];
  }>;
}

interface CloudBuildOperation {
  name?: string;
  done?: boolean;
  metadata?: {
    build?: CloudBuildStatus;
    buildId?: string;
  };
  response?: CloudBuildStatus;
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

interface CloudRunOperation {
  name?: string;
  done?: boolean;
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

interface ArtifactRepository {
  name: string;
  format?: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
  sizeBytes?: string;
  mode?: string;
}

interface ArtifactRepositoryList {
  repositories?: ArtifactRepository[];
  nextPageToken?: string;
}

interface ArtifactLocation {
  name?: string;
}

interface ArtifactLocationList {
  locations?: ArtifactLocation[];
  nextPageToken?: string;
}

interface IamBinding {
  role?: string;
  members?: string[];
  condition?: Record<string, unknown>;
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
}

interface CloudLoggingEntry {
  timestamp?: string;
  receiveTimestamp?: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  protoPayload?: Record<string, unknown>;
  resource?: {
    type?: string;
    labels?: Record<string, string>;
  };
  labels?: Record<string, string>;
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

export class CloudRunAdapter implements
  IProviderAdapter,
  IWorkloadMaintenanceAdapter,
  IQueueAdapter,
  IProviderRuntimeLogsAdapter,
  IProviderDeploymentsAdapter {
  readonly name = 'cloudrun';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [], // Cloud SQL is separate
    supportsAutoWiring: false, // Manual connection needed
    supportsHealthChecks: true,
    supportsCronSchedule: true, // Cloud Scheduler
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate services per env
    managedTls: true,
    supportsObserve: true,
    queues: { backend: 'pubsub' },
    supportsOneOffTasks: true,
    supportsDeferredDeploy: true,
    supportsMaintenance: true,
  };

  private credentials: ConnectedCloudRunCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  async connect(credentials: unknown): Promise<void> {
    const parsed = CloudRunCredentialsSchema.parse(credentials);
    const legacyRegion = credentials && typeof credentials === 'object' && typeof (credentials as Record<string, unknown>).region === 'string'
      ? (credentials as Record<string, string>).region
      : DEFAULT_CLOUD_RUN_REGION;
    this.credentials = { ...parsed, region: CloudRunRegionSchema.parse(legacyRegion) };
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  configureTarget(target: { region?: string }): void {
    if (!target.region) return;
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.credentials = {
      ...this.credentials,
      region: CloudRunRegionSchema.parse(target.region),
    };
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string; warning?: string }> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();

      // A token exchange succeeds even for a service account with zero roles;
      // probe the Cloud Run Admin API since deploys are impossible without it.
      const { projectId, region } = this.credentials;
      const runResponse = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services?pageSize=1`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!runResponse.ok) {
        const text = await runResponse.text();
        if (runResponse.status === 403) {
          return {
            success: false,
            error: [
              'Cloud Run Admin API probe failed with 403.',
              `Grant roles/run.admin to serviceAccount:${this.serviceAccountCreds.client_email} on project ${projectId} — deploys are impossible without it.`,
              `Original error: ${text}`,
            ].join(' '),
          };
        }
        return {
          success: false,
          error: `Cloud Run Admin API probe failed: ${runResponse.status} ${text}`,
        };
      }

      const loggingAccess = await this.verifyCloudLoggingAccess(token);
      if (!loggingAccess.success) {
        return {
          success: true,
          email: this.serviceAccountCreds.client_email,
          warning: loggingAccess.error,
        };
      }
      return {
        success: true,
        email: this.serviceAccountCreds.client_email,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccountCreds = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async repairLoggingAccess(): Promise<Receipt> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, message: 'Not connected', error: 'Call connect() first.' };
    }

    const roles = ['roles/logging.viewer', 'roles/logging.viewAccessor'];
    const member = `serviceAccount:${this.serviceAccountCreds.client_email}`;
    try {
      const token = await this.getAccessToken();
      const updatedRoles = await this.ensureProjectIamBindings({
        token,
        member,
        roles,
      });
      return {
        success: true,
        message: updatedRoles.length > 0
          ? `Granted Cloud Logging read roles to ${member}`
          : `Cloud Logging read roles already present for ${member}`,
        data: {
          member,
          roles,
          updatedRoles,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to repair Cloud Logging IAM access',
        error: error instanceof Error ? error.message : String(error),
        data: {
          member,
          roles,
          requiredPermission: 'resourcemanager.projects.setIamPolicy',
        },
      };
    }
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Cloud Run doesn't have "projects" in the deployment sense
    // The GCP project is the container
    const bindings = environment.platformBindings as {
      projectId?: string;
      provider?: string;
    };

    const projectId = bindings.projectId || `${projectName}-${environment.name}`;
    const data: Record<string, unknown> = {
      projectId,
      gcpProjectId: this.credentials.projectId,
      region: this.credentials.region,
      environmentId: this.credentials.region,
    };
    const loggingRepair = await this.repairLoggingAccess();
    data.loggingIamRepair = {
      success: loggingRepair.success,
      message: loggingRepair.message,
      ...(loggingRepair.data ? { data: loggingRepair.data } : {}),
    };
    if (!loggingRepair.success) {
      data.loggingIamRepairWarning = loggingRepair.error || loggingRepair.message;
    }

    return {
      success: true,
      message: `Using GCP project: ${this.credentials.projectId}`,
      data,
    };
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    // Cloud Run doesn't provision databases
    // Users should use Cloud SQL separately
    const emptyComponent: Component = {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return {
      component: emptyComponent,
      receipt: {
        success: false,
        message: `Cloud Run does not provision databases. Use the Cloud SQL adapter separately, then pass DATABASE_URL as an env var.`,
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const deferredTarget = options.deferDeployment
      ? await this.currentImageForDeferredDeployment(service, environment)
      : undefined;
    if (deferredTarget?.expectedExisting && !deferredTarget.imageUri) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run could not preserve the current image for ${service.name}`,
          error: 'The service is bound but its current image could not be read. Refusing to build branch code during an exact-SHA CI-managed apply.',
          data: {
            provider: this.name,
            phase: 'defer_code_deployment',
          },
        },
      };
    }
    const deferredImageUri = deferredTarget?.imageUri;
    const deploymentDeferred = Boolean(deferredImageUri);
    const explicitImageUri = deferredImageUri ?? this.imageUriForService(service, envVars);
    const buildResult = explicitImageUri
      ? undefined
      : await this.buildImageForService(service, environment, envVars);
    const imageUri = explicitImageUri ?? buildResult?.imageUri;
    if (!imageUri) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run could not build an image for service ${service.name}`,
          error: buildResult?.error ?? 'Project gitRemoteUrl is required so Cloud Build can build and publish the service image automatically.',
          data: {
            provider: this.name,
            phase: 'image_build',
            missing: buildResult?.error?.includes('gitRemoteUrl') ? ['HYPERVIBE_SOURCE_REPO_URL'] : undefined,
          },
        },
      };
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };

    const prefix = bindings.projectId || 'hypervibe';
    const workloadKind = serviceWorkloadKind(service);
    const isCron = workloadKind === 'cron';
    const serviceName = isCron
      ? bindings.services?.[service.name]?.jobName ?? this.sanitizeName(`${prefix}-${service.name}`)
      : bindings.services?.[service.name]?.serviceId ?? this.sanitizeName(`${prefix}-${service.name}`);

    if (isCron) {
      return this.deployScheduledJob({
        service,
        environment,
        envVars,
        imageUri,
        buildResult,
        prefix,
        jobName: serviceName,
        deploymentDeferred,
      });
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      // Only a provider-confirmed 404 means the service does not exist.
      // Permission, transport, and server failures must not authorize a create.
      const cloudRunService = await this.getService(serviceName);
      const vpcAccess = await this.resolveVpcAccess(
        environment,
        this.serviceVpcAccess(cloudRunService),
        token
      );

      // Build environment variables config. Cloud Run env vars live on the
      // revision, so merge with the live container's env — a deploy that
      // doesn't re-pass every var (e.g. DATABASE_URL injected at database
      // provision time) must not silently wipe it. Passed vars always win.
      const runtimeVars = this.runtimeEnvVarsForService(service, envVars);
      const existingContainer = cloudRunService ? this.primaryContainer(cloudRunService) : undefined;
      const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
      const env = this.mergeEnvVars(existingContainer?.env, runtimeVars, { replaceManagedDatabaseVars });
      const cloudSqlNames = replaceManagedDatabaseVars
        ? this.cloudSqlConnectionNamesFromEnv(runtimeVars)
        : Array.from(new Set([
            ...this.cloudSqlConnectionNamesFromEnv(runtimeVars),
            ...this.cloudSqlConnectionNamesFromEnvVars(existingContainer?.env),
          ]));
      const cloudSql = this.cloudSqlVolumeConfig(cloudSqlNames);
      const volumeMounts = cloudSql
        ? this.mergeVolumeMounts(existingContainer?.volumeMounts, [cloudSql.volumeMount])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumeMounts(existingContainer?.volumeMounts)
          : existingContainer?.volumeMounts;
      const templateVolumes = cloudSql
        ? this.mergeVolumes(this.serviceVolumes(cloudRunService), [cloudSql.volume])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumes(this.serviceVolumes(cloudRunService))
          : this.serviceVolumes(cloudRunService);

      // Build container spec
      const containerSpec = {
        image: imageUri,
        ports: [{ containerPort: parseInt(envVars['PORT'] || '8080', 10) }],
        env,
        ...(volumeMounts && volumeMounts.length > 0 ? { volumeMounts } : {}),
        resources: {
          limits: {
            cpu: envVars['CPU'] || '1',
            memory: envVars['MEMORY'] || '512Mi',
          },
        },
      };

      const labels = {
        'infraprint-environment': this.labelValue(environment.name),
        'infraprint-service': this.labelValue(service.name),
      };

      // Cloud Run Admin API v2 Service shape. Workers get internal-only
      // ingress and min one instance: with no inbound traffic they would
      // otherwise scale to zero and never process work.
      const isWorker = workloadKind === 'worker';
      const serviceSpec = {
        labels,
        ingress: isWorker ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL',
        template: {
          labels,
          ...(isWorker ? { scaling: { minInstanceCount: 1 } } : {}),
          containers: [containerSpec],
          ...(templateVolumes && (templateVolumes.length > 0 || replaceManagedDatabaseVars)
            ? { volumes: templateVolumes }
            : {}),
          ...(this.serviceAccountCreds?.client_email
            ? { serviceAccount: this.serviceAccountCreds.client_email }
            : {}),
          ...(vpcAccess.apiValue !== undefined ? { vpcAccess: vpcAccess.apiValue } : {}),
        },
      };

      const baseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`;
      const creatingService = !cloudRunService;
      let serviceOperation: CloudRunOperation | undefined;

      if (cloudRunService) {
        // Update existing service
        const response = await fetch(`${baseUrl}/${serviceName}?updateMask=labels,ingress,template`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serviceSpec),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Run API error: ${response.status} ${text}`);
        }

        serviceOperation = await response.json() as CloudRunOperation;
      } else {
        // Create new service
        const response = await fetch(`${baseUrl}?serviceId=${encodeURIComponent(serviceName)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serviceSpec),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Run API error: ${response.status} ${text}`);
        }

        serviceOperation = await response.json() as CloudRunOperation;
      }

      if (serviceOperation) {
        await this.waitForCloudRunOperation(token, serviceOperation, `service ${creatingService ? 'create' : 'update'}`);
      }

      const publicAccess = this.shouldAllowUnauthenticated(service);
      const publicInvokerBindingUpdated = publicAccess
        ? await this.ensurePublicInvoker(serviceName, token)
        : false;

      // Get service URL
      const serviceInfo = await this.waitForCloudRunServiceReady(serviceName, token);
      this.assertVpcAccess(serviceInfo, vpcAccess, `Cloud Run service ${serviceName}`);
      const url = serviceInfo?.uri;

      return {
        serviceId: service.id,
        externalId: serviceName,
        url,
        status: deploymentDeferred ? 'configured' : 'deployed',
        receipt: {
          success: true,
          message: deploymentDeferred
            ? `Prepared ${serviceName} for exact-SHA CI deployment using its current image`
            : `Deployed ${serviceName} to Cloud Run`,
          data: {
            serviceName,
            url,
            imageUri,
            createdService: creatingService,
            public: publicAccess,
            publicAccessConfigured: publicAccess,
            publicInvokerBindingUpdated,
            environmentId: region,
            ...(deploymentDeferred ? { deploymentDeferred: true } : {}),
            ...(buildResult
              ? {
                  build: {
                    id: buildResult.buildId,
                    logsUrl: buildResult.logsUrl,
                  },
                }
              : {}),
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Deployment failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
  }

  private async deployScheduledJob(params: {
    service: Service;
    environment: Environment;
    envVars: Record<string, string>;
    imageUri: string;
    buildResult?: CloudBuildResult;
    prefix: string;
    jobName: string;
    deploymentDeferred?: boolean;
  }): Promise<DeployResult> {
    const {
      service,
      environment,
      envVars,
      imageUri,
      buildResult,
      jobName,
      deploymentDeferred,
    } = params;
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      if (!service.buildConfig.cronSchedule?.trim()) {
        return {
          serviceId: service.id,
          status: 'failed',
          receipt: {
            success: false,
            message: `Scheduled job ${service.name} is missing cronSchedule`,
            error: 'Cron workloads require buildConfig.cronSchedule.',
          },
        };
      }

      const token = await this.getAccessToken();
      const { region } = this.credentials;
      const runtimeVars = this.runtimeEnvVarsForService(service, envVars);
      // Merge with the live job container env so redeploys don't wipe vars
      // injected outside this call (e.g. DATABASE_URL at provision time).
      const currentJob = await this.getCloudRunJob(jobName, token);
      const vpcAccess = await this.resolveVpcAccess(
        environment,
        currentJob?.template?.template?.vpcAccess,
        token
      );
      const currentJobContainer = currentJob ? this.primaryJobContainer(currentJob) : undefined;
      const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
      const env = this.mergeEnvVars(currentJobContainer?.env, runtimeVars, { replaceManagedDatabaseVars });
      const labels = {
        'infraprint-environment': this.labelValue(environment.name),
        'infraprint-service': this.labelValue(service.name),
        'infraprint-resource': 'scheduled-job',
      };
      const command = this.requiredScheduledJobCommand(service);
      const cloudSqlConnectionNames = replaceManagedDatabaseVars
        ? this.cloudSqlConnectionNamesFromEnv(runtimeVars)
        : Array.from(new Set([
            ...this.cloudSqlConnectionNamesFromEnv(runtimeVars),
            ...this.cloudSqlConnectionNamesFromEnvVars(currentJobContainer?.env),
          ]));
      const jobSpec = this.cloudRunJobSpec({
        imageUri,
        command,
        env,
        resources: {
          limits: {
            cpu: envVars['CPU'] || '1',
            memory: envVars['MEMORY'] || '512Mi',
          },
        },
        serviceAccount: this.serviceAccountCreds?.client_email,
        labels,
        existingVolumes: currentJob?.template?.template?.volumes,
        existingVolumeMounts: currentJobContainer?.volumeMounts,
        cloudSqlConnectionNames,
        replaceManagedDatabaseVars,
        ...(vpcAccess.apiValue !== undefined ? { vpcAccess: vpcAccess.apiValue } : {}),
      });

      const { created: createdJob, job: readyJob } = await this.upsertCloudRunJob({
        token,
        jobName,
        jobSpec,
        description: 'scheduled job',
      });
      this.assertVpcAccess(
        readyJob,
        vpcAccess,
        `Cloud Run job ${jobName}`
      );

      const schedulerJobName = this.sanitizeName(`${jobName}-schedule`);
      const { created: createdScheduler } = await this.upsertCloudSchedulerJob({
        token,
        schedulerJobName,
        jobName,
        schedule: service.buildConfig.cronSchedule.trim(),
        timeZone: envVars['HYPERVIBE_CRON_TIME_ZONE']?.trim() || 'Etc/UTC',
      });

      const cleanupWarning = await this.deleteCloudRunServiceIfExists(jobName, token);

      return {
        serviceId: service.id,
        externalId: schedulerJobName,
        status: deploymentDeferred ? 'configured' : 'deployed',
        receipt: {
          success: true,
          message: deploymentDeferred
            ? `Prepared scheduled job ${jobName} for exact-SHA CI deployment using its current image`
            : `Deployed scheduled job ${jobName} to Cloud Run and Cloud Scheduler`,
          data: {
            resourceType: 'scheduledJob',
            jobName,
            schedulerJobName,
            schedule: service.buildConfig.cronSchedule.trim(),
            imageUri,
            environmentId: region,
            createdJob,
            createdScheduler,
            ...(deploymentDeferred ? { deploymentDeferred: true } : {}),
            ...(cleanupWarning ? { cleanupWarning } : {}),
            ...(buildResult
              ? {
                  build: {
                    id: buildResult.buildId,
                    logsUrl: buildResult.logsUrl,
                  },
                }
              : {}),
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Scheduled job deployment failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
  }

  async deleteService(serviceId: string): Promise<{ success: boolean; error?: string; message?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();
      const schedulerJobName = serviceId.endsWith('-schedule') ? serviceId : `${serviceId}-schedule`;
      const jobName = serviceId.endsWith('-schedule') ? serviceId.replace(/-schedule$/, '') : serviceId;
      const warnings = [
        await this.deleteCloudSchedulerJobIfExists(schedulerJobName, token),
        await this.deleteCloudRunJobIfExists(jobName, token),
        await this.deleteCloudRunServiceIfExists(serviceId, token),
        serviceId === jobName ? undefined : await this.deleteCloudRunServiceIfExists(jobName, token),
      ].filter((warning): warning is string => Boolean(warning));

      if (warnings.length > 0) {
        return {
          success: false,
          error: warnings.join('; '),
        };
      }

      return {
        success: true,
        message: `Deleted Cloud Run resources for ${serviceId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    dnsZone?: string;
  }): Promise<Receipt> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    try {
      this.assertDomainMappingScope(params);
      const token = await this.getAccessToken();
      const service = await this.getCloudRunServiceStrict(params.serviceId, token);
      if (!service) {
        throw new Error(`Bound Cloud Run service ${params.serviceId} was not found.`);
      }
      const readiness = this.cloudRunServiceReadiness(service);
      if (!readiness.ready) {
        throw new Error(`Cloud Run service ${params.serviceId} is not ready${readiness.error ? `: ${readiness.error}` : '.'}`);
      }

      const existing = await this.getCloudRunDomainMapping(params.domain, token);
      let mapping = existing;
      if (existing) {
        this.assertDomainMappingIdentity(existing, params.domain);
        const route = existing.spec?.routeName ?? existing.status?.mappedRouteName;
        if (route !== params.serviceId) {
          throw new Error(`Cloud Run domain ${params.domain} is already mapped to ${route ?? 'an unknown route'}; Hypervibe will not force-override it.`);
        }
      } else {
        mapping = await this.createCloudRunDomainMapping(
          params.domain,
          params.serviceId,
          token
        );
      }
      this.assertDomainMappingIdentity(mapping!, params.domain);
      const ready = this.domainMappingReady(mapping!);
      return {
        success: true,
        message: existing
          ? 'Cloud Run custom domain already mapped'
          : 'Cloud Run custom domain mapped',
        data: {
          domain: params.domain,
          customDomainId: mapping!.metadata!.uid,
          created: !existing,
          providerVerified: ready,
          certificateStatus: this.domainMappingCertificateStatus(mapping!),
          dnsRecords: this.domainMappingDnsRecords(mapping!, params.domain),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to attach Cloud Run custom domain',
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
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    try {
      this.assertDomainMappingScope(params);
      const token = await this.getAccessToken();
      const mapping = await this.getCloudRunDomainMapping(params.domain, token);
      if (!mapping) {
        return {
          success: true,
          message: 'Cloud Run custom domain is already absent',
          data: { domain: params.domain, customDomainId: params.customDomainId, alreadyAbsent: true },
        };
      }
      this.assertDomainMappingIdentity(mapping, params.domain);
      if (params.customDomainId && mapping.metadata!.uid !== params.customDomainId) {
        return {
          success: false,
          message: 'Cloud Run custom-domain identity changed',
          error: `Reviewed mapping uid ${params.customDomainId} does not match observed uid ${mapping.metadata!.uid}.`,
        };
      }
      const route = mapping.spec?.routeName ?? mapping.status?.mappedRouteName;
      if (route !== params.serviceId) {
        throw new Error(`Cloud Run domain ${params.domain} now maps to ${route ?? 'an unknown route'}, not reviewed service ${params.serviceId}.`);
      }
      await this.deleteCloudRunDomainMapping(params.domain, token);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_CLOUDRUN_DOMAIN_DELETE_ATTEMPTS',
        60
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_CLOUDRUN_DOMAIN_DELETE_DELAY_MS',
        1000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.getCloudRunDomainMapping(params.domain, token)) {
          return {
            success: true,
            message: 'Cloud Run custom domain detached',
            data: {
              domain: params.domain,
              customDomainId: mapping.metadata!.uid,
              deleted: true,
            },
          };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      throw new Error(`Cloud Run domain mapping ${params.domain} remained observable after ${attempts} deletion checks.`);
    } catch (error) {
      return {
        success: false,
        message: 'Failed to detach Cloud Run custom domain',
        error: this.formatError(error),
      };
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };

    const prefix = bindings.projectId || 'hypervibe';
    const workloadKind = serviceWorkloadKind(service);
    const isCron = workloadKind === 'cron';
    const serviceName = isCron
      ? bindings.services?.[service.name]?.jobName ?? this.sanitizeName(`${prefix}-${service.name}`)
      : bindings.services?.[service.name]?.serviceId ?? this.sanitizeName(`${prefix}-${service.name}`);

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      if (isCron) {
        const runtimeVars = this.runtimeEnvVarsForService(service, vars);
        if (Object.keys(runtimeVars).length === 0) {
          return {
            success: true,
            message: 'No runtime environment variables to set',
            data: { variableCount: 0 },
          };
        }

        const currentJob = await this.getCloudRunJob(serviceName, token);
        const vpcAccess = await this.resolveVpcAccess(
          environment,
          currentJob?.template?.template?.vpcAccess,
          token
        );
        const currentContainer = this.primaryJobContainer(currentJob);
        if (!currentContainer?.image) {
          return {
            success: true,
            message: `Skipped scheduled job env var pre-sync because ${serviceName} does not have an existing image; deploy will create/update the job`,
            data: {
              skipped: true,
              reason: 'missing_existing_job_image',
              variableCount: Object.keys(runtimeVars).length,
            },
          };
        }

        const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
        const jobSpec = this.cloudRunJobSpec({
          imageUri: currentContainer.image,
          command: this.requiredScheduledJobCommand(service),
          env: this.mergeEnvVars(currentContainer.env, runtimeVars, { replaceManagedDatabaseVars }),
          resources: currentContainer.resources,
          serviceAccount: currentJob?.template?.template?.serviceAccount
            ?? currentJob?.template?.template?.serviceAccountName
            ?? this.serviceAccountCreds?.client_email,
          existingVolumes: currentJob?.template?.template?.volumes,
          existingVolumeMounts: currentContainer.volumeMounts,
          cloudSqlConnectionNames: this.cloudSqlConnectionNamesFromEnv(runtimeVars),
          replaceManagedDatabaseVars,
          ...(vpcAccess.apiValue !== undefined ? { vpcAccess: vpcAccess.apiValue } : {}),
        });
        const { job: readyJob } = await this.upsertCloudRunJob({
          token,
          jobName: serviceName,
          jobSpec,
          description: 'scheduled job env update',
        });
        this.assertVpcAccess(
          readyJob,
          vpcAccess,
          `Cloud Run job ${serviceName}`
        );

        return {
          success: true,
          message: `Set ${Object.keys(runtimeVars).length} environment variables`,
          data: {
            variableCount: Object.keys(runtimeVars).length,
            ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
          },
        };
      }

      // Get current service
      const currentService = await this.getService(serviceName);
      if (!currentService) {
        return { success: false, message: `Service ${serviceName} not found` };
      }
      const vpcAccess = await this.resolveVpcAccess(
        environment,
        this.serviceVpcAccess(currentService),
        token
      );

      const runtimeVars = this.runtimeEnvVarsForService(service, vars);
      if (Object.keys(runtimeVars).length === 0) {
        return {
          success: true,
          message: 'No runtime environment variables to set',
          data: { variableCount: 0 },
        };
      }

      const currentContainer = this.primaryContainer(currentService);
      if (!currentContainer?.image) {
        return {
          success: false,
          message: `Service ${serviceName} does not have an image to preserve while updating environment variables`,
        };
      }

      const replaceManagedDatabaseVars = this.isManagedDatabaseEnvSync(runtimeVars);
      const cloudSqlNames = replaceManagedDatabaseVars
        ? this.cloudSqlConnectionNamesFromEnv(runtimeVars)
        : Array.from(new Set([
            ...this.cloudSqlConnectionNamesFromEnv(runtimeVars),
            ...this.cloudSqlConnectionNamesFromEnvVars(currentContainer.env),
          ]));
      const cloudSql = this.cloudSqlVolumeConfig(cloudSqlNames);
      const volumeMounts = cloudSql
        ? this.mergeVolumeMounts(currentContainer.volumeMounts, [cloudSql.volumeMount])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumeMounts(currentContainer.volumeMounts)
          : currentContainer.volumeMounts;
      const templateVolumes = cloudSql
        ? this.mergeVolumes(this.serviceVolumes(currentService), [cloudSql.volume])
        : replaceManagedDatabaseVars
          ? this.removeCloudSqlVolumes(this.serviceVolumes(currentService))
          : this.serviceVolumes(currentService);
      const containerSpec = {
        ...(currentContainer.name ? { name: currentContainer.name } : {}),
        image: currentContainer.image,
        ...(currentContainer.ports ? { ports: currentContainer.ports } : {}),
        ...(currentContainer.command ? { command: currentContainer.command } : {}),
        ...(currentContainer.args ? { args: currentContainer.args } : {}),
        ...(currentContainer.resources ? { resources: currentContainer.resources } : {}),
        ...(volumeMounts && volumeMounts.length > 0 ? { volumeMounts } : {}),
        env: this.mergeEnvVars(currentContainer.env, runtimeVars, { replaceManagedDatabaseVars }),
      };
      const templateUpdate: Record<string, unknown> = {
        containers: [containerSpec],
      };
      const updateMask = ['template.containers'];
      if (cloudSql || replaceManagedDatabaseVars) {
        templateUpdate.volumes = templateVolumes ?? [];
        updateMask.push('template.volumes');
      }
      if (vpcAccess.managed) {
        templateUpdate.vpcAccess = vpcAccess.apiValue ?? {};
        updateMask.push('template.vpcAccess');
      }

      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}?updateMask=${updateMask.join(',')}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template: templateUpdate,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run API error: ${response.status} ${text}`);
      }

      const operation = await response.json() as CloudRunOperation;
      await this.waitForCloudRunOperation(token, operation, 'service env update');
      const updatedService = await this.waitForCloudRunServiceReady(serviceName, token);
      this.assertVpcAccess(updatedService, vpcAccess, `Cloud Run service ${serviceName}`);
      const updatedEnv = new Map(
        (this.primaryContainer(updatedService)?.env ?? [])
          .filter((entry): entry is { name: string; value?: string } => typeof entry.name === 'string')
          .map((entry) => [entry.name, entry.value])
      );
      const unapplied = Object.entries(runtimeVars)
        .filter(([key, value]) => updatedEnv.get(key) !== value)
        .map(([key]) => key);
      if (unapplied.length > 0) {
        return {
          success: false,
          message: 'Cloud Run accepted the service update but runtime variables were not verified on the ready revision',
          error: `Failed to verify: ${unapplied.join(', ')}`,
        };
      }

      return {
        success: true,
        message: `Set ${Object.keys(runtimeVars).length} environment variables`,
        data: {
          variableCount: Object.keys(runtimeVars).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to set environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const uniqueKeys = [...new Set(keys)].sort();
    const invalidKey = uniqueKeys.find((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    if (invalidKey || uniqueKeys.length === 0) {
      return {
        success: false,
        message: 'Failed to delete environment variables',
        error: invalidKey
          ? `Invalid environment variable name: ${invalidKey}`
          : 'No environment variable names were supplied',
      };
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };
    const prefix = bindings.projectId || 'hypervibe';
    const isCron = serviceWorkloadKind(service) === 'cron';
    const serviceName = isCron
      ? bindings.services?.[service.name]?.jobName ?? this.sanitizeName(`${prefix}-${service.name}`)
      : bindings.services?.[service.name]?.serviceId ?? this.sanitizeName(`${prefix}-${service.name}`);

    try {
      const token = await this.getAccessToken();
      const retired = new Set(uniqueKeys);

      if (isCron) {
        const currentJob = await this.getCloudRunJob(serviceName, token);
        const currentContainer = this.primaryJobContainer(currentJob);
        if (!currentContainer?.image) {
          return {
            success: false,
            message: `Scheduled job ${serviceName} does not have an image to preserve while deleting environment variables`,
          };
        }
        const existingEnv = currentContainer.env ?? [];
        const vpcAccess = await this.resolveVpcAccess(
          environment,
          currentJob?.template?.template?.vpcAccess,
          token
        );
        const vpcNeedsChange = vpcAccess.managed
          && JSON.stringify(this.normalizedVpcAccess(currentJob?.template?.template?.vpcAccess))
            !== JSON.stringify(vpcAccess.desired);
        const deletedKeys = uniqueKeys.filter((key) =>
          existingEnv.some((entry) => entry.name === key)
        );
        if (deletedKeys.length === 0 && !vpcNeedsChange) {
          return {
            success: true,
            message: 'Explicitly retired environment variables are already absent',
            data: { deletedKeys: [], variableCount: 0, redeployMayBeTriggered: false },
          };
        }

        const jobSpec = this.cloudRunJobSpec({
          imageUri: currentContainer.image,
          command: this.requiredScheduledJobCommand(service),
          env: existingEnv.filter((entry) => typeof entry.name !== 'string' || !retired.has(entry.name)),
          resources: currentContainer.resources,
          serviceAccount: currentJob?.template?.template?.serviceAccount
            ?? currentJob?.template?.template?.serviceAccountName
            ?? this.serviceAccountCreds?.client_email,
          existingVolumes: currentJob?.template?.template?.volumes,
          existingVolumeMounts: currentContainer.volumeMounts,
          cloudSqlConnectionNames: this.cloudSqlConnectionNamesFromEnvVars(currentContainer.env),
          ...(vpcAccess.apiValue !== undefined ? { vpcAccess: vpcAccess.apiValue } : {}),
        });
        const { job: readyJob } = await this.upsertCloudRunJob({
          token,
          jobName: serviceName,
          jobSpec,
          description: 'scheduled job env removal',
        });
        const updatedJob = readyJob;
        this.assertVpcAccess(updatedJob, vpcAccess, `Cloud Run job ${serviceName}`);
        const remainingJobKeys = new Set(
          (this.primaryJobContainer(updatedJob)?.env ?? [])
            .map((entry) => entry.name)
            .filter((name): name is string => typeof name === 'string')
        );
        const failedJobKeys = deletedKeys.filter((key) => remainingJobKeys.has(key));
        if (failedJobKeys.length > 0) {
          return {
            success: false,
            message: 'Cloud Run accepted the scheduled job update but retired variables remain live',
            error: `Failed to remove: ${failedJobKeys.join(', ')}`,
          };
        }

        return {
          success: true,
          message: `Deleted ${deletedKeys.length} explicitly retired environment variables`,
          data: {
            deletedKeys,
            variableCount: deletedKeys.length,
            redeployMayBeTriggered: false,
            scheduledJobConfigUpdated: true,
          },
        };
      }

      const currentService = await this.getService(serviceName);
      const currentContainer = this.primaryContainer(currentService);
      if (!currentService || !currentContainer?.image) {
        return {
          success: false,
          message: `Service ${serviceName} does not have an image to preserve while deleting environment variables`,
        };
      }
      const existingEnv = currentContainer.env ?? [];
      const vpcAccess = await this.resolveVpcAccess(
        environment,
        this.serviceVpcAccess(currentService),
        token
      );
      const vpcNeedsChange = vpcAccess.managed
        && JSON.stringify(this.normalizedVpcAccess(this.serviceVpcAccess(currentService)))
          !== JSON.stringify(vpcAccess.desired);
      const deletedKeys = uniqueKeys.filter((key) =>
        existingEnv.some((entry) => entry.name === key)
      );
      if (deletedKeys.length === 0 && !vpcNeedsChange) {
        return {
          success: true,
          message: 'Explicitly retired environment variables are already absent',
          data: { deletedKeys: [], variableCount: 0, redeployMayBeTriggered: false },
        };
      }

      const containerSpec = {
        ...(currentContainer.name ? { name: currentContainer.name } : {}),
        image: currentContainer.image,
        ...(currentContainer.ports ? { ports: currentContainer.ports } : {}),
        ...(currentContainer.command ? { command: currentContainer.command } : {}),
        ...(currentContainer.args ? { args: currentContainer.args } : {}),
        ...(currentContainer.resources ? { resources: currentContainer.resources } : {}),
        ...(currentContainer.volumeMounts ? { volumeMounts: currentContainer.volumeMounts } : {}),
        env: existingEnv.filter((entry) => typeof entry.name !== 'string' || !retired.has(entry.name)),
      };
      const { projectId, region } = this.credentials;
      const updateMask = ['template.containers'];
      const template: Record<string, unknown> = { containers: [containerSpec] };
      if (vpcAccess.managed) {
        template.vpcAccess = vpcAccess.apiValue ?? {};
        updateMask.push('template.vpcAccess');
      }
      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}?updateMask=${updateMask.join(',')}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template,
          }),
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run API error: ${response.status} ${text}`);
      }
      const operation = await response.json() as CloudRunOperation;
      await this.waitForCloudRunOperation(token, operation, 'service env removal');
      const updatedService = await this.waitForCloudRunServiceReady(serviceName, token);
      this.assertVpcAccess(updatedService, vpcAccess, `Cloud Run service ${serviceName}`);
      const remainingKeys = new Set(
        (this.primaryContainer(updatedService)?.env ?? [])
          .map((entry) => entry.name)
          .filter((name): name is string => typeof name === 'string')
      );
      const failedKeys = deletedKeys.filter((key) => remainingKeys.has(key));
      if (failedKeys.length > 0) {
        return {
          success: false,
          message: 'Cloud Run accepted the service update but retired variables remain live',
          error: `Failed to remove: ${failedKeys.join(', ')}`,
        };
      }

      return {
        success: true,
        message: `Deleted ${deletedKeys.length} explicitly retired environment variables`,
        data: {
          deletedKeys,
          variableCount: deletedKeys.length,
          // Cloud Run service configuration is revision-scoped; this PATCH
          // necessarily creates a revision with the already-compatible image.
          redeployMayBeTriggered: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete environment variables',
        error: this.formatError(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string; reason?: string }> {
    if (!this.credentials) {
      return {
        status: 'unknown',
        reason: 'Cloud Run deployment observation requires a verified connection.',
      };
    }

    try {
      const bindings = parseHostingBindings(environment);
      const boundRegion = bindings.environmentId;
      if (boundRegion) {
        this.configureTarget({ region: boundRegion });
      }
      const token = await this.getAccessToken();
      const targetBinding = Object.values(bindings.services ?? {}).find((binding) => (
        binding.serviceId === deploymentId
        || binding.jobName === deploymentId
        || binding.schedulerJobName === deploymentId
      ));
      const resourceType = targetBinding?.resourceType;
      const workloadKind = targetBinding?.workloadKind;
      const scheduledTarget = resourceType === 'scheduledJob' || workloadKind === 'cron';
      const jobTarget = scheduledTarget || resourceType === 'taskJob';
      const serviceTarget = resourceType === 'service'
        || workloadKind === 'web'
        || workloadKind === 'worker';

      const schedulerStatus = (schedulerJob: CloudSchedulerJob, schedulerJobName: string) => {
        const state = (schedulerJob.state ?? '').toUpperCase();
        if (['ENABLED', 'PAUSED'].includes(state)) {
          return { status: 'deployed' };
        }
        if (state === 'UPDATE_FAILED') {
          return {
            status: 'failed',
            ...(schedulerJob.status?.message ? { reason: schedulerJob.status.message } : {}),
          };
        }
        return {
          status: state ? state.toLowerCase() : 'deploying',
          reason: state
            ? `Cloud Scheduler job ${schedulerJobName} is ${state.toLowerCase()}.`
            : `Cloud Scheduler job ${schedulerJobName} did not report a state.`,
        };
      };

      if (scheduledTarget) {
        const schedulerJobName = targetBinding?.schedulerJobName ?? deploymentId;
        const schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
        return schedulerJob
          ? schedulerStatus(schedulerJob, schedulerJobName)
          : {
            status: 'unknown',
            reason: `Cloud Scheduler job ${schedulerJobName} is absent in region ${this.credentials.region}.`,
          };
      }

      if (jobTarget) {
        const jobName = targetBinding?.jobName ?? deploymentId;
        const job = await this.getCloudRunJob(jobName, token);
        const readiness = this.cloudRunJobReadiness(job);
        if (readiness.ready) {
          return { status: 'deployed' };
        }
        if (readiness.error) {
          return { status: 'failed', reason: readiness.error };
        }
        return {
          status: 'unknown',
          reason: `Cloud Run job ${jobName} is absent in region ${this.credentials.region}.`,
        };
      }

      const service = await this.getService(deploymentId);
      if (service) {
        const readiness = this.cloudRunServiceReadiness(service);
        const status = readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'deploying';

        return {
          status,
          url: service.uri,
          ...(readiness.error ? { reason: readiness.error } : {}),
        };
      }
      if (serviceTarget) {
        return {
          status: 'unknown',
          reason: `Cloud Run service ${deploymentId} is absent in region ${this.credentials.region}.`,
        };
      }

      // Legacy bindings may not identify the resource type. Probe remaining
      // Cloud Run shapes only after the service lookup confirms absence.
      const job = await this.getCloudRunJob(deploymentId, token);
      const jobReadiness = this.cloudRunJobReadiness(job);
      if (jobReadiness.ready) return { status: 'deployed' };
      if (jobReadiness.error) return { status: 'failed', reason: jobReadiness.error };
      const schedulerJob = await this.getCloudSchedulerJob(deploymentId, token);
      if (schedulerJob) return schedulerStatus(schedulerJob, deploymentId);

      return {
        status: 'unknown',
        reason: `Cloud Run found no service, job, or scheduler named ${deploymentId} in region ${this.credentials.region}.`,
      };
    } catch (error) {
      return {
        status: 'unknown',
        reason: `Cloud Run deployment observation failed for ${deploymentId}: ${this.formatError(error)}`,
      };
    }
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const startedAt = Date.now();

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; imageUri?: string }>;
    };
    const prefix = bindings.projectId || 'hypervibe';
    const serviceName = bindings.services?.[service.name]?.serviceId
      ?? this.sanitizeName(`${prefix}-${service.name}`);
    const sourceService = await this.getService(serviceName);
    const sourceContainer = this.primaryContainer(sourceService);
    const imageUri = sourceContainer?.image ?? bindings.services?.[service.name]?.imageUri;

    if (!imageUri) {
      return {
        jobId: '',
        status: 'failed',
        receipt: {
          success: false,
          message: `Cloud Run environment task requires an image for service ${service.name}`,
          error: 'Deploy the service first so Hypervibe can build and record its Cloud Run image before running one-off environment tasks.',
          data: {
            provider: this.name,
            missing: ['services.' + service.name + '.imageUri'],
            pendingDeploy: true,
          },
        },
      };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const vpcAccess = await this.resolveVpcAccess(
        environment,
        this.serviceVpcAccess(sourceService),
        token
      );
      const jobBaseName = serviceName.length > 49 ? serviceName.slice(0, 49).replace(/-+$/g, '') : serviceName;
      const jobName = this.sanitizeName(`${jobBaseName}-migration`);
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      const jobsBaseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs`;
      const jobSpec = this.cloudRunJobSpec({
        imageUri,
        command,
        env: sourceContainer?.env ?? [],
        resources: sourceContainer?.resources,
        serviceAccount: sourceService?.template?.serviceAccount
          ?? sourceService?.template?.serviceAccountName
          ?? sourceService?.spec?.template?.spec?.serviceAccountName
          ?? this.serviceAccountCreds?.client_email,
        existingVolumes: this.serviceVolumes(sourceService),
        existingVolumeMounts: sourceContainer?.volumeMounts,
        cloudSqlConnectionNames: this.cloudSqlConnectionNamesFromEnvVars(sourceContainer?.env),
        ...(vpcAccess.apiValue !== undefined ? { vpcAccess: vpcAccess.apiValue } : {}),
      });

      const { job: readyJob } = await this.upsertCloudRunJob({
        token,
        jobName,
        jobSpec,
        description: 'environment task',
      });
      this.assertVpcAccess(
        readyJob,
        vpcAccess,
        `Cloud Run job ${jobName}`
      );

      const runResponse = await fetch(`${jobsBaseUrl}/${jobName}:run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      if (!runResponse.ok) {
        const text = await runResponse.text();
        throw new Error(`Cloud Run Jobs run error: ${runResponse.status} ${text}`);
      }

      const operation = await runResponse.json() as { name?: string };
      const execution = await this.waitForCloudRunJobExecution(jobName, token);
      const status = execution ? this.executionStatus(execution) : 'failed';
      const jobId = execution?.name ?? operation.name ?? jobName;
      if (status !== 'completed') {
        return {
          jobId,
          status: execution ? 'failed' : 'timeout',
          runner: 'cloudrun-job',
          durationMs: Date.now() - startedAt,
          receipt: {
            success: false,
            message: `Cloud Run environment task failed for ${service.name}`,
            error: execution
              ? `Cloud Run execution ${this.lastPathSegment(execution.name) ?? jobId} ended with status ${status}`
              : `Cloud Run execution for ${jobName} did not finish before timeout`,
            data: {
              jobName,
              operationName: operation.name,
              executionName: execution?.name,
              serviceName,
              imageUri,
            },
          },
        };
      }
      return {
        jobId,
        status: 'completed',
        runner: 'cloudrun-job',
        durationMs: Date.now() - startedAt,
        receipt: {
          success: true,
          message: `Completed Cloud Run environment task ${jobName}`,
          data: {
            jobName,
            operationName: operation.name,
            executionName: execution?.name,
            serviceName,
            imageUri,
          },
        },
      };
    } catch (error) {
      return {
        jobId: '',
        status: 'failed',
        runner: 'cloudrun-job',
        durationMs: Date.now() - startedAt,
        receipt: {
          success: false,
          message: `Cloud Run environment task failed for ${service.name}`,
          error: this.formatError(error),
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Queues (Pub/Sub) — the hosting provider owns its queue backend.
  // ---------------------------------------------------------------------------

  /** Deterministic Pub/Sub resource ids for a spec queue name (shared with queue-env). */
  queueResourceNames(environment: Environment, queueName: string): { topicId: string; subscriptionId: string } {
    return pubsubQueueResourceIds(environment, queueName);
  }

  /** Current provider-native Pub/Sub scope, for plan/apply stale checks. */
  queueProviderScope(): { projectId: string } {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return { projectId: this.credentials.projectId };
  }

  /** Hypervibe-owned topics for this environment (label-filtered). */
  async listQueueTopics(environment: Environment): Promise<pubsub.PubSubTopic[]> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const token = await this.getAccessToken();
    const topics = await pubsub.listTopics(token, this.credentials.projectId);
    const environmentLabel = this.labelValue(environment.name);
    return topics.filter((topic) => topic.labels?.['infraprint-environment'] === environmentLabel);
  }

  async getQueueSubscription(environment: Environment, queueName: string): Promise<pubsub.PubSubSubscription | null> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.assertQueueBindingScope(environment, queueName, false);
    const token = await this.getAccessToken();
    const { topicId, subscriptionId } = this.queueResourceNames(environment, queueName);
    const [topic, subscription] = await Promise.all([
      pubsub.getTopic(token, this.credentials.projectId, topicId),
      pubsub.getSubscription(token, this.credentials.projectId, subscriptionId),
    ]);
    if (topic) this.assertManagedQueueTopic(environment, queueName, topic);
    if (subscription) this.assertManagedQueueSubscription(environment, queueName, subscription);
    if (subscription && !topic) {
      throw new Error(
        `Pub/Sub subscription ${subscription.name} exists but its exact managed topic is absent; queue observation is incomplete.`
      );
    }
    return subscription;
  }

  async ensureQueue(
    environment: Environment,
    queueName: string,
    options: { ackDeadlineSeconds?: number } = {}
  ): Promise<{ topicName: string; subscriptionName: string; createdTopic: boolean; createdSubscription: boolean }> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.assertQueueBindingScope(environment, queueName, false);
    const token = await this.getAccessToken();
    const gcpProjectId = this.credentials.projectId;
    const { topicId, subscriptionId } = this.queueResourceNames(environment, queueName);
    const labels = {
      'infraprint-environment': this.labelValue(environment.name),
      'infraprint-queue': this.labelValue(queueName),
    };

    let existingTopic = await pubsub.getTopic(token, gcpProjectId, topicId);
    if (existingTopic) this.assertManagedQueueTopic(environment, queueName, existingTopic);
    let createdTopic = false;
    if (!existingTopic) {
      const result = await pubsub.ensureTopic(token, gcpProjectId, topicId, labels);
      createdTopic = result.created;
      existingTopic = await this.waitForQueueTopic(token, topicId);
      this.assertManagedQueueTopic(environment, queueName, existingTopic);
    }

    let existing = await pubsub.getSubscription(token, gcpProjectId, subscriptionId);
    if (existing) this.assertManagedQueueSubscription(environment, queueName, existing);
    let createdSubscription = false;
    if (!existing) {
      const result = await pubsub.ensureSubscription(token, gcpProjectId, subscriptionId, topicId, {
        ackDeadlineSeconds: options.ackDeadlineSeconds,
        labels,
      });
      createdSubscription = result.created;
      existing = await this.waitForQueueSubscription(token, subscriptionId);
      this.assertManagedQueueSubscription(environment, queueName, existing);
    } else if (
      options.ackDeadlineSeconds !== undefined
      && existing.ackDeadlineSeconds !== options.ackDeadlineSeconds
    ) {
      await pubsub.patchSubscriptionAckDeadline(token, gcpProjectId, subscriptionId, options.ackDeadlineSeconds);
      existing = await this.waitForQueueSubscription(token, subscriptionId, options.ackDeadlineSeconds);
      this.assertManagedQueueSubscription(environment, queueName, existing);
    }

    return {
      topicName: `projects/${gcpProjectId}/topics/${topicId}`,
      subscriptionName: `projects/${gcpProjectId}/subscriptions/${subscriptionId}`,
      createdTopic,
      createdSubscription,
    };
  }

  async destroyQueue(environment: Environment, queueName: string): Promise<void> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.assertQueueBindingScope(environment, queueName, true);
    const token = await this.getAccessToken();
    const { topicId, subscriptionId } = this.queueResourceNames(environment, queueName);
    const [topic, subscription] = await Promise.all([
      pubsub.getTopic(token, this.credentials.projectId, topicId),
      pubsub.getSubscription(token, this.credentials.projectId, subscriptionId),
    ]);
    // Resolve and validate every target before the first destructive request so
    // a same-name unmanaged resource can never be partially torn down.
    if (topic) this.assertManagedQueueTopic(environment, queueName, topic);
    if (subscription) this.assertManagedQueueSubscription(environment, queueName, subscription);
    if (subscription) {
      await pubsub.deleteSubscription(token, this.credentials.projectId, subscriptionId);
      await this.waitForQueueAbsence(
        `subscription ${subscription.name}`,
        () => pubsub.getSubscription(token, this.credentials!.projectId, subscriptionId)
      );
    }
    if (topic) {
      await pubsub.deleteTopic(token, this.credentials.projectId, topicId);
      await this.waitForQueueAbsence(
        `topic ${topic.name}`,
        () => pubsub.getTopic(token, this.credentials!.projectId, topicId)
      );
    }
  }

  private assertQueueBindingScope(
    environment: Environment,
    queueName: string,
    required: boolean
  ): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const rawQueues = environment.platformBindings.queues;
    const queues = rawQueues && typeof rawQueues === 'object' && !Array.isArray(rawQueues)
      ? rawQueues as Record<string, unknown>
      : {};
    const rawBinding = queues[queueName];
    const binding = rawBinding && typeof rawBinding === 'object' && !Array.isArray(rawBinding)
      ? rawBinding as Record<string, unknown>
      : null;
    if (!binding) {
      if (!required) return;
      throw new Error(
        `Pub/Sub queue ${queueName} is missing its durable binding; re-run hv_plan before destroying it.`
      );
    }
    if (binding.backend !== 'pubsub') {
      throw new Error(`Queue ${queueName} is not bound as a Pub/Sub queue; refusing Cloud Run queue access.`);
    }
    const rawScope = binding.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const boundProjectId = typeof scope?.projectId === 'string' ? scope.projectId : undefined;
    if (!boundProjectId) {
      throw new Error(`Pub/Sub queue ${queueName} binding is missing its durable GCP project scope; re-import or re-plan it.`);
    }
    if (boundProjectId !== this.credentials.projectId) {
      throw new Error(
        `Pub/Sub queue ${queueName} is bound to GCP project ${boundProjectId}, but the connected Cloud Run credentials target ${this.credentials.projectId}; refusing queue access in a different project.`
      );
    }
    const { topicId, subscriptionId } = this.queueResourceNames(environment, queueName);
    const expectedTopicName = `projects/${boundProjectId}/topics/${topicId}`;
    const expectedSubscriptionName = `projects/${boundProjectId}/subscriptions/${subscriptionId}`;
    if (
      binding.topicName !== expectedTopicName
      || binding.subscriptionName !== expectedSubscriptionName
    ) {
      throw new Error(
        `Pub/Sub queue ${queueName} binding does not match its exact project-scoped topic and subscription identities; re-import or re-plan it.`
      );
    }
  }

  async readProviderLogs(request: ProviderRuntimeLogsRequest): Promise<ProviderRuntimeLogsResult> {
    const bindings = parseHostingBindings(request.environment);
    const serviceBinding = bindings.services?.[request.serviceName];
    if (!serviceBinding) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }
    const logs = await this.getLogs(request.environment, request.serviceName, {
      limit: request.limit,
      errorsOnly: request.errorsOnly,
    });
    const deploymentId = serviceBinding.serviceId;
    const status = deploymentId
      ? await this.getDeployStatus(request.environment, deploymentId)
      : undefined;
    return {
      deploymentStatus: status?.status ?? 'unknown',
      deploymentId,
      logs: logs.map((log) => ({
        timestamp: log.timestamp.toISOString(),
        severity: log.severity || 'info',
        message: log.message,
      })),
    };
  }

  async listProviderDeployments(request: ProviderDeploymentsRequest): Promise<ProviderDeployment[]> {
    const bindings = parseHostingBindings(request.environment);
    if (request.serviceName && !bindings.services?.[request.serviceName]) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }
    return this.listDeployments(request.environment, request.serviceName, request.limit);
  }

  async getLogs(
    environment: Environment,
    serviceName: string,
    options?: GetLogsOptions
  ): Promise<LogEntry[]> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const bindings = parseHostingBindings(environment);
    const serviceBinding = bindings.services?.[serviceName];
    const targetName = serviceBinding?.jobName ?? serviceBinding?.serviceId ?? serviceName;
    const isJob = serviceBinding?.resourceType === 'scheduledJob' || Boolean(serviceBinding?.jobName);
    const logs = await this.queryCloudLogging({
      token,
      targetName,
      targetKind: isJob ? 'job' : 'service',
      limit: options?.limit ?? 100,
      since: options?.since,
      errorsOnly: options?.errorsOnly,
    });
    return logs.map((entry) => this.toLogEntry(entry));
  }

  async getServiceVariables(
    environment: Environment,
    serviceName: string
  ): Promise<Record<string, string>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const bindings = parseHostingBindings(environment);
    const serviceBinding = bindings.services?.[serviceName];
    const targetName = serviceBinding?.jobName ?? serviceBinding?.serviceId;
    if (!targetName) {
      throw new Error(`Service ${serviceName} is not bound to Cloud Run`);
    }

    const isJob = serviceBinding?.resourceType === 'scheduledJob' || Boolean(serviceBinding?.jobName);
    const container = isJob
      ? this.primaryJobContainer(await this.getCloudRunJob(targetName, token))
      : this.primaryContainer(await this.getCloudRunService(targetName, token));
    const vars: Record<string, string> = {};
    for (const entry of container?.env ?? []) {
      if (typeof entry.name === 'string' && typeof entry.value === 'string') {
        vars[entry.name] = entry.value;
      }
    }
    return vars;
  }

  async listDeployments(
    environment: Environment,
    serviceName?: string,
    limit = 10
  ): Promise<Array<{
    id: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
    url?: string;
    service?: string;
    type?: string;
    logUri?: string;
  }>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const bindings = environment.platformBindings as {
      services?: Record<string, { serviceId?: string; url?: string; jobName?: string; resourceType?: string }>;
    };
    const serviceBindings = bindings.services ?? {};
    const targets = serviceName
      ? [[serviceName, serviceBindings[serviceName]] as const]
      : Object.entries(serviceBindings);
    const deployments: Array<{
      id: string;
      status: string;
      createdAt?: string;
      updatedAt?: string;
      url?: string;
      service?: string;
      type?: string;
      logUri?: string;
    }> = [];

    for (const [name, binding] of targets) {
      if (!binding) continue;
      if (binding.resourceType === 'scheduledJob' || binding.jobName) {
        const jobName = binding.jobName ?? binding.serviceId;
        if (!jobName) continue;
        const executions = await this.listCloudRunJobExecutions(jobName, token, limit);
        for (const execution of executions) {
          deployments.push({
            id: this.lastPathSegment(execution.name) ?? jobName,
            status: this.executionStatus(execution),
            createdAt: execution.startTime ?? execution.createTime,
            updatedAt: execution.completionTime,
            service: name,
            type: 'jobExecution',
          });
        }
        continue;
      }

      const serviceId = binding.serviceId;
      if (!serviceId) continue;
      const service = await this.getCloudRunService(serviceId, token);
      const revisions = await this.listCloudRunRevisions(serviceId, token, limit);
      if (revisions.length === 0) {
        const readiness = this.cloudRunServiceReadiness(service);
        deployments.push({
          id: serviceId,
          status: readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'unknown',
          url: service?.uri ?? binding.url,
          service: name,
          type: 'service',
        });
        continue;
      }
      for (const revision of revisions) {
        const readiness = this.cloudRunServiceReadiness({
          name: revision.name ?? serviceId,
          uid: '',
          generation: '',
          terminalCondition: revision.terminalCondition,
          conditions: revision.conditions,
          reconciling: revision.reconciling,
        });
        deployments.push({
          id: this.lastPathSegment(revision.name) ?? serviceId,
          status: readiness.ready ? 'deployed' : readiness.error ? 'failed' : 'deploying',
          createdAt: revision.createTime,
          updatedAt: revision.updateTime,
          url: service?.uri ?? binding.url,
          service: name,
          type: 'revision',
          logUri: revision.logUri,
        });
      }
    }

    deployments.sort((a, b) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });
    return deployments.slice(0, limit);
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };
    const observedAt = new Date().toISOString();

    if (!bindings.projectId) {
      return {
        provider: this.name,
        observedAt,
        projectExists: false,
        services: [],
        databases: [],
        partial: false,
        warnings: [],
      };
    }
    if (bindings.environmentId && bindings.environmentId !== this.credentials.region) {
      throw new Error(
        `Bound Cloud Run environment is in ${bindings.environmentId}, but desired hosting.region is ${this.credentials.region}. Region changes require an explicit teardown and recreate; Hypervibe will not create a cross-region replacement over existing bindings.`
      );
    }

    const token = await this.getAccessToken();
    const prefix = bindings.projectId;
    const environmentLabel = this.labelValue(environment.name);
    const serviceBindings = bindings.services ?? {};
    const warnings: string[] = [];
    const services: ObservedService[] = [];
    let serviceObservationKnown = true;

    let domainMappings: CloudRunDomainMapping[] = [];
    let domainObservationKnown = true;
    if (this.domainMappingRegionSupported()) {
      try {
        domainMappings = await this.listCloudRunDomainMappings(token);
      } catch (error) {
        domainObservationKnown = false;
        warnings.push(`Failed to list Cloud Run domain mappings: ${this.formatError(error)}`);
      }
    }
    const mappingsByRoute = new Map<string, CloudRunDomainMapping[]>();
    for (const mapping of domainMappings) {
      const route = mapping.spec?.routeName ?? mapping.status?.mappedRouteName;
      if (!route) {
        throw new Error(`Cloud Run domain mapping ${mapping.metadata?.name ?? 'unknown'} did not expose its mapped route.`);
      }
      mappingsByRoute.set(route, [
        ...(mappingsByRoute.get(route) ?? []),
        mapping,
      ]);
    }

    let liveServices: CloudRunService[] = [];
    try {
      liveServices = await this.listCloudRunServices(token);
    } catch (error) {
      serviceObservationKnown = false;
      warnings.push(`Failed to list Cloud Run services: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const liveService of liveServices) {
      const externalId = this.lastPathSegment(liveService.name);
      if (!externalId) continue;
      const bindingKey = Object.entries(serviceBindings)
        .find(([, binding]) => binding?.serviceId === externalId)?.[0];
      if (liveService.labels?.['infraprint-environment'] !== environmentLabel && !bindingKey) {
        continue;
      }

      const container = this.primaryContainer(liveService);
      const readiness = this.cloudRunServiceReadiness(liveService);
      const startCommand = this.containerStartCommand(container);
      const healthCheckPath = container?.startupProbe?.httpGet?.path ?? container?.livenessProbe?.httpGet?.path;
      const cacheNetwork = this.normalizedVpcAccess(this.serviceVpcAccess(liveService));
      let publicAccess: boolean | undefined;
      try {
        publicAccess = await this.observePublicInvoker(externalId, token);
      } catch (error) {
        serviceObservationKnown = false;
        warnings.push(`Failed to read Cloud Run IAM policy for ${externalId}: ${this.formatError(error)}`);
      }
      const serviceMappings = mappingsByRoute.get(externalId) ?? [];
      services.push({
        name: this.observedServiceName(externalId, liveService.labels, bindingKey, prefix),
        externalId,
        // Workers deploy with internal-only ingress; classify by it so the
        // diff can converge a manually flipped ingress back to the spec.
        workloadKind: liveService.ingress === 'INGRESS_TRAFFIC_INTERNAL_ONLY' ? 'worker' : 'web',
        ...(liveService.uri ? { url: liveService.uri } : {}),
        customDomains: serviceMappings.map((mapping) => mapping.metadata!.name!).sort(),
        ...(serviceMappings.length > 0
          ? {
              customDomainStatus: Object.fromEntries(serviceMappings.map((mapping) => [
                mapping.metadata!.name!,
                {
                  providerVerified: this.domainMappingReady(mapping),
                  certificateStatus: this.domainMappingCertificateStatus(mapping),
                  dnsConfigured: this.domainMappingReady(mapping),
                  dnsRecords: this.domainMappingDnsRecords(mapping, mapping.metadata!.name!),
                },
              ])),
            }
          : {}),
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(healthCheckPath ? { healthCheckPath } : {}),
          ...(publicAccess === undefined ? {} : { public: publicAccess }),
          ...(cacheNetwork ? { cacheNetwork } : {}),
        },
        ...this.observedEnvFromContainer(container),
        status: readiness.ready ? 'running' : readiness.error ? 'failed' : 'unknown',
        maintenance: {
          state: liveService.scaling?.scalingMode === 'MANUAL'
            && liveService.scaling.manualInstanceCount === 0
            ? 'suspended'
            : readiness.ready ? 'running' : 'unknown',
          providerState: {
            scaling: liveService.scaling ?? { scalingMode: 'AUTOMATIC' },
          },
        },
      });
    }

    let liveJobs: CloudRunJob[] = [];
    try {
      liveJobs = await this.listCloudRunJobs(token);
    } catch (error) {
      serviceObservationKnown = false;
      warnings.push(`Failed to list Cloud Run jobs: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const liveJob of liveJobs) {
      const externalId = this.lastPathSegment(liveJob.name);
      if (!externalId) continue;
      const bindingKey = Object.entries(serviceBindings)
        .find(([, binding]) => binding?.jobName === externalId)?.[0];
      if (liveJob.labels?.['infraprint-environment'] !== environmentLabel && !bindingKey) {
        continue;
      }

      const schedulerJobName = this.sanitizeName(`${externalId}-schedule`);
      let schedulerJob: CloudSchedulerJob | null = null;
      try {
        schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
      } catch (error) {
        serviceObservationKnown = false;
        warnings.push(`Failed to read Cloud Scheduler job ${schedulerJobName}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const container = this.primaryJobContainer(liveJob);
      const readiness = this.cloudRunJobReadiness(liveJob);
      const startCommand = this.containerStartCommand(container);
      const cacheNetwork = this.normalizedVpcAccess(liveJob.template?.template?.vpcAccess);
      services.push({
        name: this.observedServiceName(externalId, liveJob.labels, bindingKey, prefix),
        externalId: schedulerJob ? schedulerJobName : externalId,
        // A Job without a Cloud Scheduler trigger is a broken cron: the
        // missing cronSchedule surfaces as config drift in the diff.
        workloadKind: 'cron',
        customDomains: [],
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(schedulerJob?.schedule ? { cronSchedule: schedulerJob.schedule } : {}),
          ...(cacheNetwork ? { cacheNetwork } : {}),
        },
        ...this.observedEnvFromContainer(container),
        status: readiness.ready ? 'running' : readiness.error ? 'failed' : 'unknown',
        maintenance: {
          state: schedulerJob?.state === 'PAUSED'
            ? 'suspended'
            : schedulerJob?.state === 'ENABLED' ? 'running' : 'unknown',
          providerState: { schedulerState: schedulerJob?.state ?? 'unknown' },
        },
      });
    }

    return {
      provider: this.name,
      observedAt,
      projectExists: true,
      projectId: bindings.projectId,
      environmentId: bindings.environmentId ?? this.credentials.region,
      services,
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: domainObservationKnown && serviceObservationKnown ? 'complete' : 'unknown',
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
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const boundRegion = typeof request.binding?.environmentId === 'string'
      ? request.binding.environmentId
      : undefined;
    if (boundRegion) this.configureTarget({ region: boundRegion });

    const token = await this.getAccessToken();
    const environmentLabel = request.environment
      ? this.labelValue(request.environment.name)
      : undefined;
    const rawServiceBindings = request.binding?.services;
    const serviceBindings = rawServiceBindings && typeof rawServiceBindings === 'object' && !Array.isArray(rawServiceBindings)
      ? rawServiceBindings as Record<string, Record<string, unknown>>
      : {};
    const boundIds = new Set(Object.values(serviceBindings).flatMap((binding) => [
      typeof binding.serviceId === 'string' ? binding.serviceId : undefined,
      typeof binding.jobName === 'string' ? binding.jobName : undefined,
      typeof binding.schedulerJobName === 'string' ? binding.schedulerJobName : undefined,
    ].filter((value): value is string => Boolean(value))));
    const deterministicNames = new Map<string, { name: string; resourceType: 'service' | 'scheduledJob' | 'taskJob' }>();
    const deterministicPrefixes = new Set([
      this.credentials.projectId,
      ...(request.project && request.environment
        ? [this.sanitizeName(`${request.project.name}-${request.environment.name}`)]
        : []),
    ]);
    for (const serviceName of request.serviceNames ?? []) {
      for (const prefix of deterministicPrefixes) {
        const providerName = this.sanitizeName(`${prefix}-${serviceName}`);
        deterministicNames.set(providerName, { name: serviceName, resourceType: 'service' });
        deterministicNames.set(this.sanitizeName(`${providerName}-schedule`), { name: serviceName, resourceType: 'scheduledJob' });
        deterministicNames.set(this.sanitizeName(`${providerName}-migration`), { name: `${serviceName}-migration`, resourceType: 'taskJob' });
      }
    }
    const [liveServices, liveJobs] = await Promise.all([
      this.listCloudRunServices(token),
      this.listCloudRunJobs(token),
    ]);
    const warnings: string[] = [];
    const resources: Array<Record<string, unknown>> = [];

    for (const liveService of liveServices) {
      const id = this.lastPathSegment(liveService.name);
      if (!id) continue;
      const managedEnvironment = liveService.labels?.['infraprint-environment'];
      const deterministicService = deterministicNames.get(id);
      resources.push({
        id,
        name: liveService.labels?.['infraprint-service'] ?? deterministicService?.name ?? id,
        workloadKind: liveService.ingress === 'INGRESS_TRAFFIC_INTERNAL_ONLY' ? 'worker' : 'web',
        resourceType: 'service',
        managedByHypervibe: Boolean(managedEnvironment || deterministicService),
        managedEnvironment: managedEnvironment ?? null,
        matchesEnvironment: Boolean(
          boundIds.has(id)
          || Boolean(deterministicService)
          || (environmentLabel && managedEnvironment === environmentLabel)
        ),
        ...(liveService.uri ? { url: liveService.uri } : {}),
      });
    }

    for (const liveJob of liveJobs) {
      const jobName = this.lastPathSegment(liveJob.name);
      if (!jobName) continue;
      const schedulerJobName = this.sanitizeName(`${jobName}-schedule`);
      let schedulerJob: CloudSchedulerJob | null = null;
      try {
        schedulerJob = await this.getCloudSchedulerJob(schedulerJobName, token);
      } catch (error) {
        warnings.push(`Failed to inspect Cloud Scheduler job ${schedulerJobName}: ${this.formatError(error)}`);
      }
      const managedEnvironment = liveJob.labels?.['infraprint-environment'];
      const deterministicService = deterministicNames.get(jobName)
        ?? deterministicNames.get(schedulerJobName);
      resources.push({
        id: schedulerJob ? schedulerJobName : jobName,
        name: liveJob.labels?.['infraprint-service'] ?? deterministicService?.name ?? jobName,
        workloadKind: 'cron',
        resourceType: deterministicService?.resourceType ?? 'scheduledJob',
        jobName,
        schedulerJobName: schedulerJob ? schedulerJobName : null,
        schedulerState: schedulerJob?.state ?? null,
        managedByHypervibe: Boolean(managedEnvironment || deterministicService),
        managedEnvironment: managedEnvironment ?? null,
        matchesEnvironment: Boolean(
          boundIds.has(jobName)
          || boundIds.has(schedulerJobName)
          || Boolean(deterministicService)
          || (environmentLabel && managedEnvironment === environmentLabel)
        ),
      });
    }

    const matched = resources.filter((resource) => resource.matchesEnvironment === true);
    const selected = matched.slice(0, request.limit);
    const otherResources = resources
      .filter((resource) => resource.matchesEnvironment !== true)
      .slice(0, request.limit)
      .map(({ matchesEnvironment: _matchesEnvironment, ...resource }) => resource);
    return {
      observation: selected.length > 0 ? 'present' : 'absent',
      resource: 'environment',
      project: { id: this.credentials.projectId },
      environment: {
        name: request.environment?.name,
        region: this.credentials.region,
      },
      services: selected,
      otherResources,
      completeness: {
        services: 'complete',
        scheduler: warnings.length > 0 ? 'unknown' : 'complete',
      },
      partial: selected.length < matched.length || otherResources.length < resources.length - matched.length || warnings.length > 0,
      warnings,
    };
  }

  async inspectArtifactResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (request.region) this.configureTarget({ region: request.region });
    const selectedId = request.id?.trim();
    if (selectedId) {
      const identity = this.artifactRepositoryIdentity(selectedId);
      if (!identity) {
        throw new Error(`Artifact Registry repository id must match projects/${this.credentials.projectId}/locations/{location}/repositories/{repository}.`);
      }
      this.configureTarget({ region: identity.location });
      const repository = await this.getArtifactRepository(selectedId);
      return {
        observation: repository ? 'present' : 'absent',
        resource: 'artifact',
        project: { id: this.credentials.projectId },
        artifacts: repository ? [this.inspectedArtifactRepository(repository)] : [],
        ...(repository ? {} : { id: selectedId }),
        truncated: false,
        partial: false,
      };
    }

    const token = await this.getAccessToken();
    const { projectId } = this.credentials;
    const locations = request.region
      ? [request.region]
      : await this.listArtifactRegistryLocations(token);
    const candidates: ArtifactRepository[] = [];
    const warnings: string[] = [];
    let truncated = false;

    for (let locationIndex = 0; locationIndex < locations.length; locationIndex++) {
      const location = locations[locationIndex]!;
      const locationCandidates: ArtifactRepository[] = [];
      let locationTruncated = false;
      try {
        let pageToken: string | undefined;
        const seenPageTokens = new Set<string>();
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const query = new URLSearchParams({ pageSize: String(Math.min(request.limit, 100)) });
          if (pageToken) query.set('pageToken', pageToken);
          const parent = `projects/${projectId}/locations/${location}`;
          const response = await fetch(
            `https://artifactregistry.googleapis.com/v1/${parent}/repositories?${query.toString()}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!response.ok) {
            const body = (await response.text()).slice(0, 500);
            throw new Error(`${response.status}${body ? ` ${body}` : ''}`);
          }
          const page = await response.json() as ArtifactRepositoryList;
          for (const repository of page.repositories ?? []) {
            const identity = this.artifactRepositoryIdentity(repository.name);
            if (!identity || identity.location !== location) {
              throw new Error(`returned an invalid repository identity: ${repository.name}`);
            }
            if (!request.name || repository.name === request.name || identity.repository === request.name) {
              locationCandidates.push(repository);
            }
          }

          if (!request.name && candidates.length + locationCandidates.length > request.limit) {
            locationTruncated = true;
            break;
          }
          if (request.name && candidates.length + locationCandidates.length > 1) {
            locationTruncated = Boolean(page.nextPageToken) || locationIndex < locations.length - 1;
            break;
          }

          pageToken = page.nextPageToken;
          if (!pageToken) break;
          if (seenPageTokens.has(pageToken)) {
            throw new Error('returned a repeated page token');
          }
          seenPageTokens.add(pageToken);
          if (pageNumber === 99) {
            throw new Error('exceeded the bounded repository inventory page limit');
          }
        }
        candidates.push(...locationCandidates);
        truncated = truncated || locationTruncated;
      } catch (error) {
        if (request.region) {
          throw new Error(`Artifact Registry repository inventory failed in ${location}: ${error instanceof Error ? error.message : String(error)}`);
        }
        warnings.push(`Artifact Registry repository inventory failed in ${location}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (truncated || (request.name && candidates.length > 1)) break;
    }

    const artifacts = candidates.slice(0, request.limit).map((repository) => this.inspectedArtifactRepository(repository));
    const incompleteNameSearch = Boolean(request.name && warnings.length > 0);
    return {
      observation: request.name && candidates.length > 1
        ? 'ambiguous'
        : incompleteNameSearch
        ? 'unknown'
        : artifacts.length > 0
        ? 'present'
        : warnings.length > 0
        ? 'unknown'
        : 'absent',
      resource: 'artifact',
      project: { id: projectId },
      region: request.region ?? 'all',
      artifacts,
      ...(request.name ? { name: request.name } : {}),
      truncated: truncated || candidates.length > request.limit,
      partial: warnings.length > 0,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async destroyRetainedArtifactRepository(target: {
    resource: string;
    id: string;
    providerScope: Record<string, string>;
  }): Promise<Receipt> {
    if (!this.credentials) return { success: false, message: 'Not connected' };
    const location = target.providerScope.location;
    if (location) this.configureTarget({ region: location });
    if (
      target.resource !== 'artifact'
      || target.providerScope.projectId !== this.credentials.projectId
      || target.providerScope.location !== this.credentials.region
      || !this.isArtifactRepositoryName(target.id)
    ) {
      return {
        success: false,
        message: 'Artifact Registry deletion target is invalid',
        error: 'The exact repository id, project, or location does not match the connected provider scope.',
      };
    }
    try {
      const before = await this.getArtifactRepository(target.id);
      if (!before) return { success: true, message: `Artifact Registry repository is already absent: ${target.id}` };
      if (before.name !== target.id) {
        return { success: false, message: 'Artifact Registry returned a different repository identity', error: 'No deletion was attempted.' };
      }
      const token = await this.getAccessToken();
      const response = await fetch(`https://artifactregistry.googleapis.com/v1/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 404) return { success: true, message: `Artifact Registry repository is already absent: ${target.id}` };
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Artifact Registry repository delete failed: ${response.status} ${body}`);
      }
      const operation = await response.json() as CloudRunOperation;
      await this.waitForArtifactRegistryOperation(token, operation, 'repository delete');
      const attempts = Math.max(1, Number(process.env.HYPERVIBE_ARTIFACT_DELETE_ATTEMPTS ?? 60));
      const delayMs = Math.max(0, Number(process.env.HYPERVIBE_ARTIFACT_DELETE_DELAY_MS ?? 1000));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!await this.getArtifactRepository(target.id)) {
          return { success: true, message: `Deleted Artifact Registry repository: ${target.id}` };
        }
        if (attempt < attempts - 1 && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      return {
        success: false,
        message: 'Artifact Registry accepted repository deletion but it remains present',
        error: `${target.id} remained observable after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Artifact Registry repository',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async observeMaintenanceWorkload(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<MaintenanceWorkloadObservation> {
    const token = await this.getAccessToken();
    const binding = Object.values(parseHostingBindings(environment).services ?? {})
      .find((candidate) => candidate.serviceId === serviceId
        || candidate.jobName === serviceId
        || candidate.schedulerJobName === serviceId);
    if (!binding) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_unbound' };
    }
    if (workloadKind === 'cron') {
      const schedulerJobName = binding.schedulerJobName
        ?? this.sanitizeName(`${binding.jobName ?? binding.serviceId ?? serviceId}-schedule`);
      const scheduler = await this.getCloudSchedulerJob(schedulerJobName, token);
      if (!scheduler) {
        return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_scheduler_missing' };
      }
      return {
        serviceId,
        workloadKind,
        wasRunning: scheduler.state === 'ENABLED',
        cronSchedule: scheduler.schedule,
        state: scheduler.state === 'PAUSED' ? 'suspended'
          : scheduler.state === 'ENABLED' ? 'running' : 'unknown',
        providerState: {
          schedulerJobName,
          schedulerState: scheduler.state ?? 'unknown',
          jobName: binding.jobName,
        },
      };
    }
    const serviceName = binding.serviceId ?? serviceId;
    const service = await this.getCloudRunService(serviceName, token);
    if (!service) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_service_missing' };
    }
    const scaling = service.scaling ?? { scalingMode: 'AUTOMATIC' };
    const suspended = scaling.scalingMode === 'MANUAL' && scaling.manualInstanceCount === 0;
    return {
      serviceId,
      workloadKind,
      wasRunning: !suspended,
      state: suspended ? 'suspended' : 'running',
      numReplicas: scaling.manualInstanceCount,
      providerState: { scaling },
    };
  }

  async suspendMaintenanceWorkload(
    environment: Environment,
    expected: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    const current = await this.observeMaintenanceWorkload(environment, expected.serviceId, expected.workloadKind);
    if (current.state === 'suspended') {
      return { success: true, message: `Cloud Run workload ${expected.serviceId} is already suspended`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'running') {
      return { success: false, message: 'Cloud Run workload was not suspended', error: 'The bound workload state is unknown.' };
    }
    const token = await this.getAccessToken();
    if (expected.workloadKind === 'cron') {
      await this.mutateSchedulerState(String(current.providerState?.schedulerJobName ?? ''), 'pause', token);
      await this.quiesceCloudRunJob(String(current.providerState?.jobName ?? ''), token);
    } else {
      await this.updateMaintenanceScaling(expected.serviceId, { scalingMode: 'MANUAL', manualInstanceCount: 0 }, token);
    }
    const verified = await this.waitForMaintenanceState(environment, expected, 'suspended');
    return verified
      ? { success: true, message: `Suspended Cloud Run workload ${expected.serviceId}`, data: { applied: 1, skipped: 0 } }
      : { success: false, message: 'Cloud Run suspension was not verified', error: 'The provider did not report a suspended workload before the verification deadline.' };
  }

  async resumeMaintenanceWorkload(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    const current = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
    if (!snapshot.wasRunning) {
      return current.state === 'suspended'
        ? { success: true, message: `Cloud Run workload ${snapshot.serviceId} was stopped before maintenance`, data: { applied: 0, skipped: 1 } }
        : { success: false, message: 'Cloud Run restoration was blocked', error: 'A workload that was previously stopped is now running.' };
    }
    if (current.state === 'running') {
      return { success: true, message: `Cloud Run workload ${snapshot.serviceId} is already running`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'suspended') {
      return { success: false, message: 'Cloud Run workload was not restored', error: 'The bound workload state is unknown.' };
    }
    const token = await this.getAccessToken();
    if (snapshot.workloadKind === 'cron') {
      await this.mutateSchedulerState(String(snapshot.providerState?.schedulerJobName ?? ''), 'resume', token);
    } else {
      const prior = snapshot.providerState?.scaling;
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) {
        return { success: false, message: 'Cloud Run workload was not restored', error: 'The exact pre-maintenance scaling configuration is missing.' };
      }
      await this.updateMaintenanceScaling(snapshot.serviceId, prior as Record<string, unknown>, token);
    }
    const verified = await this.waitForMaintenanceState(environment, snapshot, 'running');
    return verified
      ? { success: true, message: `Restored Cloud Run workload ${snapshot.serviceId}`, data: { applied: 1, skipped: 0 } }
      : { success: false, message: 'Cloud Run restoration was not verified', error: 'The provider did not report a running workload before the verification deadline.' };
  }

  private async updateMaintenanceScaling(
    serviceName: string,
    scaling: Record<string, unknown>,
    token: string
  ): Promise<void> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const automatic = scaling.scalingMode === 'AUTOMATIC' || scaling.scalingMode === undefined;
    const body = automatic
      ? { launchStage: 'BETA', scaling: { ...scaling, scalingMode: 'AUTOMATIC', manualInstanceCount: null } }
      : { scaling };
    const updateMask = automatic
      ? 'launchStage,scaling.scalingMode,scaling.manualInstanceCount,scaling.minInstanceCount,scaling.maxInstanceCount'
      : 'scaling.scalingMode,scaling.manualInstanceCount,scaling.minInstanceCount,scaling.maxInstanceCount';
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${this.credentials.projectId}/locations/${this.credentials.region}/services/${encodeURIComponent(serviceName)}?updateMask=${encodeURIComponent(updateMask)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!response.ok) throw new Error(`Cloud Run maintenance scaling failed (${response.status}).`);
  }

  private async mutateSchedulerState(
    schedulerJobName: string,
    operation: 'pause' | 'resume',
    token: string
  ): Promise<void> {
    if (!this.credentials || !schedulerJobName) throw new Error('Cloud Scheduler identity is missing.');
    const response = await fetch(
      `https://cloudscheduler.googleapis.com/v1/projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${encodeURIComponent(schedulerJobName)}:${operation}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }
    );
    if (!response.ok) throw new Error(`Cloud Scheduler ${operation} failed (${response.status}).`);
  }

  private async listCloudRunJobExecutionsStrict(
    jobName: string,
    token: string
  ): Promise<CloudRunExecution[]> {
    if (!this.credentials || !jobName) throw new Error('Cloud Run job identity is missing.');
    const executions: CloudRunExecution[] = [];
    let pageToken: string | undefined;
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${encodeURIComponent(jobName)}/executions?${query.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        throw new Error(`Cloud Run execution observation failed (${response.status}).`);
      }
      const body = await response.json() as {
        executions?: CloudRunExecution[];
        nextPageToken?: string;
      };
      executions.push(...(body.executions ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) return executions;
    }
    throw new Error('Cloud Run execution observation exceeded the safe pagination bound.');
  }

  private async quiesceCloudRunJob(jobName: string, token: string): Promise<void> {
    if (!this.credentials || !jobName) throw new Error('Cloud Run job identity is missing.');
    const cancelled = new Set<string>();
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const executions = await this.listCloudRunJobExecutionsStrict(jobName, token);
      const running = executions.filter((execution) => this.executionStatus(execution) === 'running');
      if (running.length === 0) return;
      for (const execution of running) {
        const executionName = this.lastPathSegment(execution.name);
        if (!executionName || cancelled.has(executionName)) continue;
        const response = await fetch(
          `https://run.googleapis.com/v2/projects/${this.credentials.projectId}/locations/${this.credentials.region}/jobs/${encodeURIComponent(jobName)}/executions/${encodeURIComponent(executionName)}:cancel`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          }
        );
        if (!response.ok && response.status !== 409) {
          throw new Error(`Cloud Run execution cancellation failed (${response.status}).`);
        }
        cancelled.add(executionName);
      }
      if (attempt < 120) {
        await this.delay(Number(process.env.HYPERVIBE_GCP_WAIT_DELAY_MS ?? 1000));
      }
    }
    throw new Error('Cloud Run job executions did not reach terminal state before the verification deadline.');
  }

  private async waitForMaintenanceState(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot,
    expected: 'running' | 'suspended'
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const observed = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
      if (observed.state === expected) return true;
      if (observed.state === 'unknown') return false;
      if (attempt < 120) await this.delay(Number(process.env.HYPERVIBE_GCP_WAIT_DELAY_MS ?? 1000));
    }
    return false;
  }

  // Helper methods

  private domainMappingBaseUrl(): string {
    const { projectId, region } = this.credentials!;
    return `https://${region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${encodeURIComponent(projectId)}/domainmappings`;
  }

  private domainMappingRegionSupported(): boolean {
    return CLOUD_RUN_DOMAIN_MAPPING_REGIONS.has(this.credentials!.region);
  }

  private assertDomainMappingScope(params: {
    environmentId: string;
    serviceId: string;
    domain: string;
  }): void {
    if (!this.domainMappingRegionSupported()) {
      throw new Error(`Cloud Run native domain mappings are unavailable in ${this.credentials!.region}. Use a declarative external Application Load Balancer instead; DNS was not changed for ${params.domain}.`);
    }
    if (params.environmentId !== this.credentials!.region) {
      throw new Error(`Cloud Run environment binding ${params.environmentId} does not match configured region ${this.credentials!.region}.`);
    }
    if (!params.serviceId || params.serviceId.includes('/')) {
      throw new Error(`Cloud Run service binding ${params.serviceId} is invalid.`);
    }
  }

  private async getCloudRunServiceStrict(
    serviceName: string,
    token: string
  ): Promise<CloudRunService | null> {
    const { projectId, region } = this.credentials!;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/services/${encodeURIComponent(serviceName)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Cloud Run service observation failed with HTTP ${response.status}.`);
    }
    return await response.json() as CloudRunService;
  }

  private async getCloudRunDomainMapping(
    domain: string,
    token: string
  ): Promise<CloudRunDomainMapping | null> {
    const response = await fetch(
      `${this.domainMappingBaseUrl()}/${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Cloud Run domain-mapping observation failed with HTTP ${response.status}.`);
    }
    return await response.json() as CloudRunDomainMapping;
  }

  private async listCloudRunDomainMappings(
    token: string
  ): Promise<CloudRunDomainMapping[]> {
    const mappings: CloudRunDomainMapping[] = [];
    const seenNames = new Set<string>();
    let continuation: string | undefined;
    do {
      const response = await fetch(
        `${this.domainMappingBaseUrl()}?limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ''}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        throw new Error(`Cloud Run domain-mapping list failed with HTTP ${response.status}.`);
      }
      const body = await response.json() as {
        items?: CloudRunDomainMapping[];
        metadata?: { continue?: string };
        unreachable?: string[];
      };
      if (!Array.isArray(body.items)) {
        throw new Error('Cloud Run domain-mapping list returned an invalid items collection.');
      }
      if ((body.unreachable?.length ?? 0) > 0) {
        throw new Error(`Cloud Run domain-mapping observation was incomplete for: ${body.unreachable!.join(', ')}.`);
      }
      for (const mapping of body.items) {
        this.assertDomainMappingIdentity(mapping);
        const name = mapping.metadata!.name!.toLowerCase();
        if (seenNames.has(name)) {
          throw new Error(`Cloud Run returned duplicate domain mapping ${mapping.metadata!.name}.`);
        }
        seenNames.add(name);
        mappings.push(mapping);
      }
      continuation = body.metadata?.continue || undefined;
    } while (continuation);
    return mappings;
  }

  private async createCloudRunDomainMapping(
    domain: string,
    serviceId: string,
    token: string
  ): Promise<CloudRunDomainMapping> {
    const response = await fetch(this.domainMappingBaseUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiVersion: 'domains.cloudrun.com/v1',
        kind: 'DomainMapping',
        metadata: {
          name: domain,
          namespace: this.credentials!.projectId,
        },
        spec: {
          routeName: serviceId,
          certificateMode: 'AUTOMATIC',
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Cloud Run domain-mapping create failed with HTTP ${response.status}. Verify base-domain ownership and run.domainmappings.create permission.`);
    }
    return await response.json() as CloudRunDomainMapping;
  }

  private async deleteCloudRunDomainMapping(
    domain: string,
    token: string
  ): Promise<void> {
    const response = await fetch(
      `${this.domainMappingBaseUrl()}/${encodeURIComponent(domain)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`Cloud Run domain-mapping delete failed with HTTP ${response.status}.`);
    }
  }

  private assertDomainMappingIdentity(
    mapping: CloudRunDomainMapping,
    expectedDomain?: string
  ): void {
    const name = mapping.metadata?.name;
    const uid = mapping.metadata?.uid;
    const namespace = mapping.metadata?.namespace;
    if (!name || !uid || !namespace) {
      throw new Error('Cloud Run returned an incomplete domain-mapping identity.');
    }
    if (namespace !== this.credentials!.projectId) {
      throw new Error(`Cloud Run domain mapping ${name} belongs to namespace ${namespace}, not ${this.credentials!.projectId}.`);
    }
    if (expectedDomain && name.toLowerCase() !== expectedDomain.toLowerCase()) {
      throw new Error(`Cloud Run domain mapping identity ${name} does not match ${expectedDomain}.`);
    }
  }

  private domainMappingReady(mapping: CloudRunDomainMapping): boolean {
    const ready = mapping.status?.conditions?.find((condition) => condition.type === 'Ready');
    return ['True', 'CONDITION_SUCCEEDED'].includes(ready?.status ?? ready?.state ?? '');
  }

  private domainMappingCertificateStatus(mapping: CloudRunDomainMapping): string {
    const certificate = mapping.status?.conditions?.find((condition) =>
      /certificate/i.test(condition.type ?? '')
    );
    const ready = mapping.status?.conditions?.find((condition) => condition.type === 'Ready');
    const condition = certificate ?? ready;
    return condition?.reason
      ?? condition?.status
      ?? condition?.state
      ?? 'PENDING';
  }

  private domainMappingDnsRecords(
    mapping: CloudRunDomainMapping,
    domain: string
  ): Array<{ name: string; type: string; value: string; purpose: string }> {
    return (mapping.status?.resourceRecords ?? []).map((record) => {
      if (!record.type || !record.rrdata) {
        throw new Error(`Cloud Run returned an incomplete DNS record for ${domain}.`);
      }
      return {
        name: domain,
        type: record.type,
        value: record.rrdata,
        purpose: 'traffic verification',
      };
    });
  }

  private async queryCloudLogging(params: {
    token: string;
    targetName: string;
    targetKind: 'service' | 'job';
    limit: number;
    since?: Date;
    errorsOnly?: boolean;
  }): Promise<CloudLoggingEntry[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    const resourceFilter = params.targetKind === 'job'
      ? `resource.type="cloud_run_job" AND resource.labels.job_name="${this.escapeLoggingValue(params.targetName)}"`
      : `resource.type="cloud_run_revision" AND resource.labels.service_name="${this.escapeLoggingValue(params.targetName)}"`;
    const filterParts = [
      `resource.labels.project_id="${this.escapeLoggingValue(projectId)}"`,
      `resource.labels.location="${this.escapeLoggingValue(region)}"`,
      resourceFilter,
      params.since ? `timestamp >= "${params.since.toISOString()}"` : undefined,
      params.errorsOnly ? 'severity>=WARNING' : undefined,
    ].filter((entry): entry is string => Boolean(entry));

    const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceNames: [`projects/${projectId}`],
        filter: filterParts.join(' AND '),
        orderBy: 'timestamp desc',
        pageSize: params.limit,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(this.cloudLoggingErrorMessage(response.status, text));
    }

    const body = await response.json() as { entries?: CloudLoggingEntry[] };
    return body.entries ?? [];
  }

  private async verifyCloudLoggingAccess(token: string): Promise<{ success: true } | { success: false; error: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const { projectId } = this.credentials;
    const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceNames: [`projects/${projectId}`],
        filter: 'resource.type="cloud_run_revision"',
        pageSize: 1,
      }),
    });

    if (response.ok) {
      return { success: true };
    }

    const text = await response.text();
    return { success: false, error: this.cloudLoggingErrorMessage(response.status, text) };
  }

  private cloudLoggingErrorMessage(status: number, text: string): string {
    const denied = status === 403 && /PERMISSION_DENIED|Permission denied for all log views|logging\.views\.access/i.test(text);
    if (!denied) {
      return `Cloud Logging API error: ${status} ${text}`;
    }

    const email = this.serviceAccountCreds?.client_email;
    const member = email ? `serviceAccount:${email}` : '<cloudrun-service-account>';
    const projectId = this.credentials?.projectId ?? '<gcp-project-id>';
    return [
      'Cloud Logging API error: 403 Permission denied for all log views.',
      'Cloud Run deploys can continue, but logs_service will fail until the Cloud Run connection service account has Cloud Logging read access.',
      'Required roles: roles/logging.viewer and roles/logging.viewAccessor.',
      `Commands: gcloud projects add-iam-policy-binding ${projectId} --member="${member}" --role="roles/logging.viewer"; gcloud projects add-iam-policy-binding ${projectId} --member="${member}" --role="roles/logging.viewAccessor"`,
      `Original error: ${text}`,
    ].join(' ');
  }

  private async listCloudRunRevisions(serviceName: string, token: string, limit: number): Promise<CloudRunRevision[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}/revisions?pageSize=${Math.max(1, limit)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return [];
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run revision observation failed: ${response.status}${text ? ` ${text}` : ''}`);
    }

    const body = await response.json() as { revisions?: CloudRunRevision[] };
    return body.revisions ?? [];
  }

  private async listCloudRunJobExecutions(jobName: string, token: string, limit: number): Promise<CloudRunExecution[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}/executions?pageSize=${Math.max(1, limit)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return [];
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run execution observation failed: ${response.status}${text ? ` ${text}` : ''}`);
    }

    const body = await response.json() as { executions?: CloudRunExecution[] };
    return body.executions ?? [];
  }

  private async listCloudRunServices(token: string): Promise<CloudRunService[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    return this.listCloudRunResources<CloudRunService>(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`,
      'services',
      token
    );
  }

  private async listCloudRunJobs(token: string): Promise<CloudRunJob[]> {
    if (!this.credentials) {
      return [];
    }

    const { projectId, region } = this.credentials;
    return this.listCloudRunResources<CloudRunJob>(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs`,
      'jobs',
      token
    );
  }

  private async listCloudRunResources<T>(baseUrl: string, key: string, token: string): Promise<T[]> {
    const resources: T[] = [];
    const resourceIds = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = `${baseUrl}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run list API error: ${response.status} ${text}`);
      }

      const rawBody = await response.json() as unknown;
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        throw new Error('Cloud Run list API returned a malformed response body.');
      }
      const body = rawBody as Record<string, unknown>;
      const collection = body[key];
      if (collection !== undefined && !Array.isArray(collection)) {
        throw new Error(`Cloud Run list API returned a non-array ${key} collection.`);
      }

      const { projectId, region } = this.credentials!;
      const expectedNamePrefix = `projects/${projectId}/locations/${region}/${key}/`;
      for (const rawResource of collection ?? []) {
        if (!rawResource || typeof rawResource !== 'object' || Array.isArray(rawResource)) {
          throw new Error(`Cloud Run list API returned a malformed ${key} resource.`);
        }
        const name = (rawResource as Record<string, unknown>).name;
        if (typeof name !== 'string' || !name.startsWith(expectedNamePrefix)) {
          throw new Error(
            `Cloud Run list API returned a ${key} resource outside exact project ${projectId}, region ${region}, or kind ${key}.`
          );
        }
        const resourceId = name.slice(expectedNamePrefix.length);
        if (!resourceId || resourceId.includes('/')) {
          throw new Error(`Cloud Run list API returned a malformed ${key} resource name.`);
        }
        if (resourceIds.has(resourceId)) {
          throw new Error(`Cloud Run list API returned duplicate ${key} resource id ${resourceId}.`);
        }
        resourceIds.add(resourceId);
        resources.push(rawResource as T);
      }

      const nextPageToken = body.nextPageToken;
      if (nextPageToken !== undefined && typeof nextPageToken !== 'string') {
        throw new Error('Cloud Run list API returned a malformed nextPageToken.');
      }
      pageToken = nextPageToken || undefined;
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) {
          throw new Error('Cloud Run list API repeated a nextPageToken.');
        }
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);
    return resources;
  }

  private observedServiceName(
    externalId: string,
    labels: Record<string, string> | undefined,
    bindingKey: string | undefined,
    prefix: string
  ): string {
    if (bindingKey) {
      return bindingKey;
    }
    const labeled = labels?.['infraprint-service'];
    if (labeled) {
      return labeled;
    }
    return externalId.startsWith(`${prefix}-`) ? externalId.slice(prefix.length + 1) : externalId;
  }

  private requiredScheduledJobCommand(service: Service): string {
    const command = service.buildConfig.startCommand?.trim();
    if (command) return command;
    throw new Error(
      `Scheduled job ${service.name} has no explicit startCommand. `
      + 'Hypervibe will not substitute an application-language command.'
    );
  }

  private containerStartCommand(container: CloudRunContainer | undefined): string | undefined {
    if (!container) {
      return undefined;
    }
    if (
      container.command?.length === 1
      && container.command[0] === '/bin/sh'
      && container.args?.[0] === '-lc'
      && typeof container.args[1] === 'string'
    ) {
      return container.args[1];
    }
    const parts = [...(container.command ?? []), ...(container.args ?? [])];
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  private observedEnvFromContainer(container: CloudRunContainer | undefined): {
    envVarKeys: string[];
    envVarHashes: Record<string, string>;
  } {
    const envVarKeys: string[] = [];
    const envVarHashes: Record<string, string> = {};
    for (const entry of container?.env ?? []) {
      if (typeof entry.name !== 'string') continue;
      envVarKeys.push(entry.name);
      if (typeof entry.value === 'string') {
        envVarHashes[entry.name] = hashEnvValue(entry.value);
      }
    }
    return { envVarKeys, envVarHashes };
  }

  private async observePublicInvoker(serviceName: string, token: string): Promise<boolean> {
    const policy = await this.getServiceIamPolicy(this.cloudRunServiceResource(serviceName), token);
    return this.hasIamBinding(policy.bindings ?? [], 'roles/run.invoker', 'allUsers');
  }

  private toLogEntry(entry: CloudLoggingEntry): LogEntry {
    const timestamp = entry.timestamp ?? entry.receiveTimestamp ?? new Date().toISOString();
    return {
      timestamp: new Date(timestamp),
      severity: this.logSeverity(entry.severity),
      message: this.logMessage(entry),
      raw: JSON.stringify(entry),
    };
  }

  private logSeverity(severity?: string): LogEntry['severity'] {
    const normalized = (severity ?? '').toLowerCase();
    if (['emergency', 'alert', 'critical', 'error'].includes(normalized)) return 'error';
    if (['warning', 'warn'].includes(normalized)) return 'warn';
    return 'info';
  }

  private logMessage(entry: CloudLoggingEntry): string {
    if (entry.textPayload) return entry.textPayload;
    if (entry.jsonPayload) {
      if (typeof entry.jsonPayload.message === 'string') return entry.jsonPayload.message;
      if (typeof entry.jsonPayload.msg === 'string') return entry.jsonPayload.msg;
      return JSON.stringify(entry.jsonPayload);
    }
    if (entry.protoPayload) {
      if (typeof entry.protoPayload.methodName === 'string') return entry.protoPayload.methodName;
      return JSON.stringify(entry.protoPayload);
    }
    return '';
  }

  private executionStatus(execution: CloudRunExecution): string {
    const completion = execution.completionStatus?.toLowerCase();
    if (completion) {
      if (completion.includes('succeed')) return 'completed';
      if (completion.includes('fail') || completion.includes('cancel') || completion.includes('timeout')) return 'failed';
      return completion;
    }
    const readiness = this.cloudRunJobReadiness({
      name: execution.name,
      generation: '',
      observedGeneration: '',
      terminalCondition: execution.terminalCondition,
      conditions: execution.conditions,
      reconciling: execution.reconciling,
    });
    if (readiness.ready) return 'completed';
    if (readiness.error) return 'failed';
    return 'running';
  }

  private async waitForCloudRunJobExecution(
    jobName: string,
    token: string,
    timeoutMs = 10 * 60 * 1000
  ): Promise<CloudRunExecution | null> {
    const deadline = Date.now() + timeoutMs;
    let latest: CloudRunExecution | null = null;
    while (Date.now() < deadline) {
      const executions = await this.listCloudRunJobExecutions(jobName, token, 5);
      latest = executions[0] ?? latest;
      if (latest) {
        const status = this.executionStatus(latest);
        if (status === 'completed' || status === 'failed') {
          return latest;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return latest;
  }

  private lastPathSegment(value?: string): string | undefined {
    if (!value) return undefined;
    const parts = value.split('/').filter(Boolean);
    return parts[parts.length - 1];
  }

  private isArtifactRepositoryName(name: string): boolean {
    const identity = this.artifactRepositoryIdentity(name);
    return Boolean(identity && this.credentials && identity.location === this.credentials.region);
  }

  private artifactRepositoryIdentity(name: string): { location: string; repository: string } | null {
    if (!this.credentials) return null;
    const match = /^projects\/([^/]+)\/locations\/([^/]+)\/repositories\/([^/]+)$/.exec(name);
    if (!match || match[1] !== this.credentials.projectId) return null;
    return { location: match[2]!, repository: match[3]! };
  }

  private async listArtifactRegistryLocations(token: string): Promise<string[]> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { projectId } = this.credentials;
    const locations: string[] = [];
    const seenLocations = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = new URLSearchParams({ pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await fetch(
        `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations?${query.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new Error(`Artifact Registry location inventory failed: ${response.status}${body ? ` ${body}` : ''}`);
      }
      const page = await response.json() as ArtifactLocationList;
      for (const location of page.locations ?? []) {
        const match = /^projects\/([^/]+)\/locations\/([^/]+)$/.exec(location.name ?? '');
        if (!match || match[1] !== projectId) {
          throw new Error(`Artifact Registry returned an invalid location identity: ${location.name ?? '(missing)'}`);
        }
        const locationId = match[2]!;
        if (!seenLocations.has(locationId)) {
          seenLocations.add(locationId);
          locations.push(locationId);
        }
      }

      pageToken = page.nextPageToken;
      if (!pageToken) return locations;
      if (seenPageTokens.has(pageToken)) {
        throw new Error('Artifact Registry location inventory returned a repeated page token');
      }
      seenPageTokens.add(pageToken);
      if (pageNumber === 99) {
        throw new Error('Artifact Registry location inventory exceeded the bounded page limit');
      }
    }

    throw new Error('Artifact Registry location inventory did not converge');
  }

  private async getArtifactRepository(name: string): Promise<ArtifactRepository | null> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (!this.isArtifactRepositoryName(name)) {
      throw new Error(`Artifact Registry repository id must match projects/${this.credentials.projectId}/locations/${this.credentials.region}/repositories/{repository}.`);
    }
    const token = await this.getAccessToken();
    const response = await fetch(`https://artifactregistry.googleapis.com/v1/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Artifact Registry repository lookup failed: ${response.status} ${body}`);
    }
    return await response.json() as ArtifactRepository;
  }

  private inspectedArtifactRepository(repository: ArtifactRepository): Record<string, unknown> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const identity = this.artifactRepositoryIdentity(repository.name);
    if (!identity) throw new Error(`Artifact Registry returned an invalid repository identity: ${repository.name}`);
    return {
      id: repository.name,
      name: this.lastPathSegment(repository.name) ?? repository.name,
      providerScope: {
        projectId: this.credentials.projectId,
        location: identity.location,
      },
      format: repository.format ?? null,
      mode: repository.mode ?? null,
      description: repository.description ?? null,
      createTime: repository.createTime ?? null,
      updateTime: repository.updateTime ?? null,
      sizeBytes: repository.sizeBytes ?? null,
      cleanupSupported: true,
    };
  }

  private async waitForArtifactRegistryOperation(
    token: string,
    operation: CloudRunOperation,
    description: string
  ): Promise<void> {
    if (!operation.name || !operation.name.includes('/operations/')) return;
    let current = operation;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (current.done) {
        if (current.error) {
          throw new Error(`Artifact Registry ${description} failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim());
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch(`https://artifactregistry.googleapis.com/v1/${current.name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Artifact Registry ${description} operation lookup failed: ${response.status} ${body}`);
      }
      current = await response.json() as CloudRunOperation;
    }
    throw new Error(`Artifact Registry ${description} did not finish before timeout`);
  }

  private escapeLoggingValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private shouldAllowUnauthenticated(service: Service): boolean {
    if (typeof service.buildConfig.public === 'boolean') {
      return service.buildConfig.public;
    }
    return serviceWorkloadKind(service) === 'web';
  }

  private async ensurePublicInvoker(serviceName: string, token: string): Promise<boolean> {
    const role = 'roles/run.invoker';
    const member = 'allUsers';
    const resource = this.cloudRunServiceResource(serviceName);
    const policy = await this.getServiceIamPolicy(resource, token);
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));

    const alreadyPublic = this.hasIamBinding(bindings, role, member);
    if (alreadyPublic) {
      return false;
    }

    const invokerBinding = bindings.find((binding) => binding.role === role && !binding.condition);
    if (invokerBinding) {
      invokerBinding.members = Array.from(new Set([...(invokerBinding.members ?? []), member]));
    } else {
      bindings.push({ role, members: [member] });
    }

    await this.setServiceIamPolicy(resource, { ...policy, bindings }, token);
    const updatedPolicy = await this.getServiceIamPolicy(resource, token);
    if (!this.hasIamBinding(updatedPolicy.bindings ?? [], role, member)) {
      throw new Error(`Cloud Run IAM policy update for ${serviceName} completed but ${member} is still missing ${role}`);
    }
    return true;
  }

  private hasIamBinding(bindings: IamBinding[], role: string, member: string): boolean {
    return bindings.some((binding) =>
      binding.role === role
      && !binding.condition
      && (binding.members ?? []).includes(member)
    );
  }

  private async ensureProjectIamBindings(params: {
    token: string;
    member: string;
    roles: string[];
  }): Promise<string[]> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    let policy: IamPolicy;
    try {
      policy = await this.getProjectIamPolicy(params.token);
    } catch (error) {
      if (!this.isDisabledApiError(error, 'cloudresourcemanager.googleapis.com')) {
        throw error;
      }
      await this.enableGoogleService(params.token, 'cloudresourcemanager.googleapis.com');
      policy = await this.getProjectIamPolicy(params.token);
    }
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));
    const updatedRoles: string[] = [];

    for (const role of params.roles) {
      const existing = bindings.find((binding) => binding.role === role && !binding.condition);
      if (existing?.members?.includes(params.member)) {
        continue;
      }
      if (existing) {
        existing.members = Array.from(new Set([...(existing.members ?? []), params.member]));
      } else {
        bindings.push({ role, members: [params.member] });
      }
      updatedRoles.push(role);
    }

    if (updatedRoles.length > 0) {
      await this.setProjectIamPolicy({ ...policy, bindings }, params.token);
    }

    return updatedRoles;
  }

  private async getProjectIamPolicy(token: string): Promise<IamPolicy> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${this.credentials.projectId}:getIamPolicy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GCP project IAM policy lookup failed: ${response.status} ${text}`);
    }

    return await response.json() as IamPolicy;
  }

  private async enableGoogleService(token: string, serviceName: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(
      `https://serviceusage.googleapis.com/v1/projects/${this.credentials.projectId}/services/${serviceName}:enable`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Cloud Resource Manager API is disabled and Hypervibe could not enable ${serviceName}: ${response.status} ${text}. ` +
        'Grant the connection service account serviceusage.services.enable permission or enable the API once in GCP.'
      );
    }

    const operation = await response.json() as CloudRunOperation;
    if (operation.name) {
      await this.waitForServiceUsageOperation(token, operation, `enable ${serviceName}`);
    }
  }

  private async waitForServiceUsageOperation(
    token: string,
    operation: CloudRunOperation,
    description: string
  ): Promise<void> {
    if (!operation.name || !operation.name.includes('/')) {
      return;
    }

    let current = operation;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (current.done) {
        if (current.error) {
          throw new Error(
            `Service Usage ${description} operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
          );
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`https://serviceusage.googleapis.com/v1/${operation.name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Service Usage ${description} operation status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudRunOperation;
    }

    throw new Error(`Service Usage ${description} operation did not finish before timeout`);
  }

  private isDisabledApiError(error: unknown, serviceName: string): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return this.isDisabledApiMessage(message, serviceName);
  }

  private isDisabledApiMessage(message: string, serviceName: string): boolean {
    return message.includes(serviceName) && /disabled|has not been used/i.test(message);
  }

  private async setProjectIamPolicy(policy: IamPolicy, token: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${this.credentials.projectId}:setIamPolicy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policy }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GCP project IAM policy update failed: ${response.status} ${text}`);
    }
  }

  private async getServiceIamPolicy(resource: string, token: string): Promise<IamPolicy> {
    const response = await fetch(`https://run.googleapis.com/v2/${resource}:getIamPolicy`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Run IAM policy lookup failed: ${response.status} ${text}`);
    }

    return await response.json() as IamPolicy;
  }

  private async setServiceIamPolicy(resource: string, policy: IamPolicy, token: string): Promise<void> {
    const response = await fetch(`https://run.googleapis.com/v2/${resource}:setIamPolicy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policy }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Run IAM policy update failed: ${response.status} ${text}`);
    }
  }

  private cloudRunServiceResource(serviceName: string): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const { projectId, region } = this.credentials;
    return `projects/${projectId}/locations/${region}/services/${serviceName}`;
  }

  private async buildImageForService(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>
  ): Promise<CloudBuildResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const sourceRepoUrl = envVars['HYPERVIBE_SOURCE_REPO_URL']?.trim();
    if (!sourceRepoUrl) {
      return {
        success: false,
        error: 'Cloud Run builds are automatic, but this project has no gitRemoteUrl. Set the project gitRemoteUrl so Cloud Build can build from source.',
      };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const repository = this.sanitizeName(envVars['HYPERVIBE_ARTIFACT_REPOSITORY']?.trim() || 'infraprint');
      const imageName = this.sanitizeName(`${environment.name}-${service.name}`);
      const revision = envVars['HYPERVIBE_SOURCE_REVISION']?.trim() || 'main';
      const tag = this.sanitizeName(
        `${revision.replace(/^refs\/heads\//, '')}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
      );
      const imageUri = `${region}-docker.pkg.dev/${projectId}/${repository}/${imageName}:${tag}`;

      await this.ensureArtifactRepository(repository, token);
      const build = await this.submitCloudBuild({
        token,
        service,
        sourceRepoUrl,
        revision,
        imageUri,
        githubToken: envVars['HYPERVIBE_GITHUB_TOKEN']?.trim(),
      });

      return {
        success: true,
        imageUri,
        buildId: build.id,
        logsUrl: build.logsUrl,
      };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  private async ensureArtifactRepository(repository: string, token: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId, region } = this.credentials;
    const baseUrl = `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations/${region}/repositories`;
    const existing = await fetch(`${baseUrl}/${repository}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (existing.ok) {
      return;
    }

    if (existing.status !== 404) {
      const text = await existing.text();
      throw new Error(`Artifact Registry lookup failed: ${existing.status} ${text}`);
    }

    const created = await fetch(`${baseUrl}?repositoryId=${encodeURIComponent(repository)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        format: 'DOCKER',
        description: 'Container images built by Infraprint',
      }),
    });

    if (!created.ok) {
      const text = await created.text();
      throw new Error(`Artifact Registry repository creation failed: ${created.status} ${text}`);
    }
  }

  private async submitCloudBuild(params: {
    token: string;
    service: Service;
    sourceRepoUrl: string;
    revision: string;
    imageUri: string;
    githubToken?: string;
  }): Promise<{ id?: string; logsUrl?: string }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    const response = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: {
          gitSource: {
            url: this.cloudBuildGitSourceUrl(params.sourceRepoUrl, params.githubToken),
            revision: params.revision,
          },
        },
        steps: [{
          name: 'gcr.io/cloud-builders/docker',
          entrypoint: 'bash',
          args: ['-lc', this.cloudBuildScript(params.service, params.imageUri)],
        }],
        images: [params.imageUri],
        timeout: '1200s',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud Build submission failed: ${response.status} ${text}`);
    }

    const build = await response.json() as CloudBuildStatus | CloudBuildOperation;
    return this.waitForCloudBuild(params.token, build);
  }

  private async waitForCloudBuild(
    token: string,
    buildOrOperation: CloudBuildStatus | CloudBuildOperation
  ): Promise<{ id?: string; logsUrl?: string }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    let current = this.cloudBuildStatusFromResponse(buildOrOperation);
    let buildId = current?.id ?? this.cloudBuildIdFromOperation(buildOrOperation);
    let operation = this.isCloudBuildOperation(buildOrOperation) ? buildOrOperation : undefined;

    for (let attempt = 0; attempt < 120; attempt++) {
      if (!buildId && operation?.name) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const operationResponse = await fetch(`https://cloudbuild.googleapis.com/v1/${operation.name}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!operationResponse.ok) {
          const text = await operationResponse.text();
          throw new Error(`Cloud Build operation status check failed: ${operationResponse.status} ${text}`);
        }
        operation = await operationResponse.json() as CloudBuildOperation;
        current = this.cloudBuildStatusFromResponse(operation);
        buildId = current?.id ?? this.cloudBuildIdFromOperation(operation);
        if (operation.done && operation.error) {
          throw new Error(
            `Cloud Build operation failed: ${operation.error.status ?? operation.error.code ?? 'unknown'} ${operation.error.message ?? ''}`.trim()
          );
        }
        continue;
      }

      if (!buildId) {
        throw new Error('Cloud Build response did not include a build ID');
      }

      if (!current || current.id !== buildId) {
        const response = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Build status check failed: ${response.status} ${text}`);
        }
        current = await response.json() as CloudBuildStatus;
      }

      const status = (current.status ?? '').toUpperCase();
      if (status === 'SUCCESS') {
        return { id: current.id, logsUrl: current.logsUrl ?? current.logUrl };
      }
      if (['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED'].includes(status)) {
        throw new Error(this.cloudBuildFailureMessage(current, status));
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
      const response = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${projectId}/builds/${buildId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Build status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudBuildStatus;
    }

    const logsUrl = current?.logsUrl ?? current?.logUrl;
    throw new Error(`Cloud Build did not finish before timeout${logsUrl ? ` (${logsUrl})` : ''}`);
  }

  private cloudBuildScript(service: Service, imageUri: string): string {
    const dockerfilePath = service.buildConfig.dockerfilePath?.trim() || 'Dockerfile';
    const runtime = service.buildConfig.runtime;
    let generatedDockerfile = '';
    let generationError = 'No explicit project runtime was found. Run hv_spec to review repository evidence.';
    if (runtime) {
      try {
        generatedDockerfile = generatedContainerDockerfile(runtime, service.buildConfig.startCommand);
      } catch (error) {
        generationError = error instanceof Error ? error.message : String(error);
      }
    }
    const generatedDockerfileBase64 = Buffer.from(generatedDockerfile, 'utf8').toString('base64');
    const writeGeneratedDockerfile = generatedDockerfile
      ? `  printf '%s' '${generatedDockerfileBase64}' | base64 --decode > Dockerfile.infraprint`
      : `  echo ${JSON.stringify(generationError)} >&2\n  exit 1`;
    const manifestCondition = runtime?.kind === 'node'
      ? '[ -f package.json ]'
      : runtime?.kind === 'python'
        ? '[ -f requirements.txt ] || [ -f pyproject.toml ]'
        : 'false';

    return [
      'set -euo pipefail',
      `if [ -f ${JSON.stringify(dockerfilePath)} ]; then`,
      `  docker build --pull -t ${JSON.stringify(imageUri)} -f ${JSON.stringify(dockerfilePath)} .`,
      `elif ${manifestCondition}; then`,
      writeGeneratedDockerfile,
      `  docker build --pull -t ${JSON.stringify(imageUri)} -f Dockerfile.infraprint .`,
      'else',
      '  echo "No repository Dockerfile or manifest for an explicit project runtime was found. Run hv_spec to review runtime evidence; custom languages require a Dockerfile." >&2',
      '  exit 1',
      'fi',
    ].join('\n');
  }

  private cloudBuildGitSourceUrl(sourceRepoUrl: string, githubToken?: string): string {
    if (!githubToken) {
      return sourceRepoUrl;
    }

    try {
      const url = new URL(sourceRepoUrl);
      if (url.hostname.toLowerCase() !== 'github.com') {
        return sourceRepoUrl;
      }
      url.username = 'x-access-token';
      url.password = githubToken;
      return url.toString();
    } catch {
      return sourceRepoUrl;
    }
  }

  private cloudBuildFailureMessage(build: CloudBuildStatus, status: string): string {
    const logsUrl = build.logsUrl ?? build.logUrl;
    const details = [
      build.statusDetail,
      build.failureInfo?.type,
      build.failureInfo?.detail,
      ...((build.steps ?? [])
        .filter((step) => {
          const stepStatus = (step.status ?? '').toUpperCase();
          return ['FAILURE', 'CANCELLED', 'TIMEOUT'].includes(stepStatus) || typeof step.exitCode === 'number';
        })
        .map((step) => {
          const label = step.id ?? step.name ?? 'unnamed step';
          const exitCode = typeof step.exitCode === 'number' ? ` exit=${step.exitCode}` : '';
          return `${label}: status=${step.status ?? 'unknown'}${exitCode}`;
        })),
    ].filter((entry): entry is string => Boolean(entry));

    return [
      `Cloud Build failed with status ${status}`,
      details.length > 0 ? `: ${details.join('; ')}` : '',
      logsUrl ? ` (${logsUrl})` : '',
    ].join('');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountCreds) {
      throw new Error('No service account credentials');
    }

    // Create JWT
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.serviceAccountCreds.client_email,
      sub: this.serviceAccountCreds.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    };

    const jwt = await this.createJwt(header, payload, this.serviceAccountCreds.private_key);

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 60) * 1000);

    return this.accessToken!;
  }

  private async createJwt(
    header: Record<string, string>,
    payload: Record<string, unknown>,
    privateKey: string
  ): Promise<string> {
    const encoder = new TextEncoder();

    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${headerB64}.${payloadB64}`;

    // Import private key
    const pemContents = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\n/g, '');
    const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(unsignedToken)
    );

    const signatureB64 = this.base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );

    return `${unsignedToken}.${signatureB64}`;
  }

  private base64UrlEncode(str: string): string {
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private async getService(
    serviceName: string
  ): Promise<CloudRunService | null> {
    if (!this.credentials) {
      return null;
    }

    const token = await this.getAccessToken();
    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run API error: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return (await response.json()) as CloudRunService;
  }

  private async currentImageForDeferredDeployment(
    service: Service,
    environment: Environment
  ): Promise<{ expectedExisting: boolean; imageUri?: string }> {
    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId?: string; jobName?: string; resourceType?: string }>;
    };
    const serviceBinding = bindings.services?.[service.name];
    const prefix = bindings.projectId || 'hypervibe';
    if (serviceWorkloadKind(service) === 'cron') {
      const expectedExisting = Boolean(serviceBinding?.jobName);
      const jobName = serviceBinding?.jobName ?? this.sanitizeName(`${prefix}-${service.name}`);
      const token = await this.getAccessToken();
      const job = await this.getCloudRunJob(jobName, token);
      const imageUri = this.primaryJobContainer(job)?.image;
      return {
        expectedExisting,
        ...(imageUri ? { imageUri } : {}),
      };
    }

    const expectedExisting = Boolean(serviceBinding?.serviceId);
    const serviceName = serviceBinding?.serviceId ?? this.sanitizeName(`${prefix}-${service.name}`);
    const current = await this.getService(serviceName);
    const imageUri = this.primaryContainer(current)?.image;
    return {
      expectedExisting,
      ...(imageUri ? { imageUri } : {}),
    };
  }

  private primaryContainer(service: CloudRunService | null): CloudRunContainer | undefined {
    return service?.template?.containers?.[0] ?? service?.spec?.template?.spec?.containers?.[0];
  }

  private primaryJobContainer(job: CloudRunJob | null): CloudRunContainer | undefined {
    return job?.template?.template?.containers?.[0];
  }

  private serviceVolumes(service: CloudRunService | null): Array<Record<string, unknown>> | undefined {
    return service?.template?.volumes ?? service?.spec?.template?.spec?.volumes;
  }

  private serviceVpcAccess(service: CloudRunService | null): CloudRunVpcAccess | undefined {
    return service?.template?.vpcAccess ?? service?.spec?.template?.spec?.vpcAccess;
  }

  private normalizeCloudRunNetwork(value: string): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const normalized = value.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, '');
    const match = /^projects\/([^/]+)\/global\/networks\/([^/]+)$/.exec(normalized);
    const name = match?.[2] ?? (/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(normalized) ? normalized : undefined);
    const projectId = match?.[1] ?? this.credentials.projectId;
    if (!name || projectId !== this.credentials.projectId) {
      throw new Error(`Cloud Run cache network must belong to connected GCP project ${this.credentials.projectId}; received ${value}.`);
    }
    return `projects/${projectId}/global/networks/${name}`;
  }

  private normalizeCloudRunSubnetwork(value: string): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const normalized = value.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, '');
    const match = /^projects\/([^/]+)\/regions\/([^/]+)\/subnetworks\/([^/]+)$/.exec(normalized);
    const name = match?.[3] ?? (/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(normalized) ? normalized : undefined);
    const projectId = match?.[1] ?? this.credentials.projectId;
    const region = match?.[2] ?? this.credentials.region;
    if (!name || projectId !== this.credentials.projectId || region !== this.credentials.region) {
      throw new Error(`Cloud Run cache subnetwork must belong to ${this.credentials.projectId}/${this.credentials.region}; received ${value}.`);
    }
    return `projects/${projectId}/regions/${region}/subnetworks/${name}`;
  }

  private normalizedVpcAccess(value?: CloudRunVpcAccess): ResolvedCloudRunVpcAccess['desired'] {
    const interfaces = value?.networkInterfaces ?? [];
    if (interfaces.length === 0) return undefined;
    if (interfaces.length !== 1 || !interfaces[0]?.network || !interfaces[0].subnetwork) {
      throw new Error('Cloud Run returned an incomplete or ambiguous Direct VPC egress attachment.');
    }
    return {
      network: this.normalizeCloudRunNetwork(interfaces[0].network),
      subnetwork: this.normalizeCloudRunSubnetwork(interfaces[0].subnetwork),
      egress: value?.egress ?? 'PRIVATE_RANGES_ONLY',
    };
  }

  private async resolveVpcAccess(
    environment: Environment,
    current: CloudRunVpcAccess | undefined,
    token: string
  ): Promise<ResolvedCloudRunVpcAccess> {
    const bindings = environment.platformBindings as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(bindings, 'cacheNetwork')) {
      return {
        managed: false,
        desired: this.normalizedVpcAccess(current),
        ...(current ? { apiValue: current } : {}),
      };
    }
    if (bindings.cacheNetwork === null) {
      return { managed: true, apiValue: {} };
    }
    const raw = bindings.cacheNetwork;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Cloud Run cacheNetwork binding is invalid; re-run hv_plan before mutating a service.');
    }
    const binding = raw as Record<string, unknown>;
    if (
      binding.provider !== 'cloudrun'
      || binding.projectId !== this.credentials!.projectId
      || binding.region !== this.credentials!.region
      || typeof binding.network !== 'string'
      || typeof binding.subnetwork !== 'string'
      || binding.egress !== 'PRIVATE_RANGES_ONLY'
    ) {
      throw new Error(
        `Cloud Run cacheNetwork must identify cloudrun/${this.credentials!.projectId}/${this.credentials!.region} with exact network, subnetwork, and PRIVATE_RANGES_ONLY egress.`
      );
    }
    const desired = {
      network: this.normalizeCloudRunNetwork(binding.network),
      subnetwork: this.normalizeCloudRunSubnetwork(binding.subnetwork),
      egress: 'PRIVATE_RANGES_ONLY',
    };
    await this.verifyVpcResources(desired, token);
    return {
      managed: true,
      desired,
      apiValue: {
        networkInterfaces: [{ network: desired.network, subnetwork: desired.subnetwork }],
        egress: desired.egress,
      },
    };
  }

  private async verifyVpcResources(
    desired: NonNullable<ResolvedCloudRunVpcAccess['desired']>,
    token: string
  ): Promise<void> {
    const networkName = desired.network.split('/').at(-1)!;
    const subnetworkName = desired.subnetwork.split('/').at(-1)!;
    const base = `https://compute.googleapis.com/compute/v1/projects/${this.credentials!.projectId}`;
    const [networkResponse, subnetworkResponse] = await Promise.all([
      fetch(`${base}/global/networks/${encodeURIComponent(networkName)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(`${base}/regions/${encodeURIComponent(this.credentials!.region)}/subnetworks/${encodeURIComponent(subnetworkName)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    for (const [label, response] of [
      [`VPC network ${desired.network}`, networkResponse],
      [`subnetwork ${desired.subnetwork}`, subnetworkResponse],
    ] as const) {
      if (response.ok) continue;
      const detail = (await response.text()).slice(0, 500);
      if (response.status === 404) {
        throw new Error(`${label} does not exist or is not visible. Hypervibe will not create networking implicitly.`);
      }
      throw new Error(`Google Compute API could not verify ${label}: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    const subnet = await subnetworkResponse.json() as { network?: string };
    if (!subnet.network || this.normalizeCloudRunNetwork(subnet.network) !== desired.network) {
      throw new Error(`Subnetwork ${desired.subnetwork} is not attached to exact VPC ${desired.network}.`);
    }
  }

  private assertVpcAccess(
    resource: CloudRunService | CloudRunJob | null,
    expected: ResolvedCloudRunVpcAccess,
    description: string
  ): void {
    const nestedJobTemplate = (resource as CloudRunJob | null)?.template?.template;
    const actual = nestedJobTemplate
      ? this.normalizedVpcAccess(nestedJobTemplate.vpcAccess)
      : this.normalizedVpcAccess(this.serviceVpcAccess(resource as CloudRunService | null));
    if (JSON.stringify(actual) !== JSON.stringify(expected.desired)) {
      throw new Error(`${description} became ready without the reviewed Direct VPC egress configuration.`);
    }
  }

  private cloudRunJobSpec(params: {
    imageUri: string;
    command: string;
    env: Array<Record<string, unknown>>;
    resources?: Record<string, unknown>;
    serviceAccount?: string;
    labels?: Record<string, string>;
    existingVolumes?: Array<Record<string, unknown>>;
    existingVolumeMounts?: Array<Record<string, unknown>>;
    cloudSqlConnectionNames?: string[];
    replaceManagedDatabaseVars?: boolean;
    vpcAccess?: CloudRunVpcAccess;
  }): Record<string, unknown> {
    const cloudSql = this.cloudSqlVolumeConfig(params.cloudSqlConnectionNames);
    const volumeMounts = cloudSql
      ? this.mergeVolumeMounts(params.existingVolumeMounts, [cloudSql.volumeMount])
      : params.replaceManagedDatabaseVars
        ? this.removeCloudSqlVolumeMounts(params.existingVolumeMounts)
        : params.existingVolumeMounts;
    const container = {
      image: params.imageUri,
      command: ['/bin/sh'],
      args: ['-lc', params.command],
      env: params.env,
      ...(params.resources ? { resources: params.resources } : {}),
      ...(volumeMounts && volumeMounts.length > 0 ? { volumeMounts } : {}),
    };
    const volumes = cloudSql
      ? this.mergeVolumes(params.existingVolumes, [cloudSql.volume])
      : params.replaceManagedDatabaseVars
        ? this.removeCloudSqlVolumes(params.existingVolumes)
        : params.existingVolumes;

    return {
      ...(params.labels ? { labels: params.labels } : {}),
      template: {
        ...(params.labels ? { labels: params.labels } : {}),
        template: {
          containers: [container],
          ...(volumes && (volumes.length > 0 || params.replaceManagedDatabaseVars) ? { volumes } : {}),
          ...(params.serviceAccount ? { serviceAccount: params.serviceAccount } : {}),
          ...(params.vpcAccess !== undefined ? { vpcAccess: params.vpcAccess } : {}),
          maxRetries: 1,
          timeout: '3600s',
        },
      },
    };
  }

  private async upsertCloudRunJob(params: {
    token: string;
    jobName: string;
    jobSpec: Record<string, unknown>;
    description: string;
  }): Promise<{ created: boolean; job: CloudRunJob }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId, region } = this.credentials;
    const headers = {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    };
    const jobsBaseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs`;
    const existingJob = await fetch(`${jobsBaseUrl}/${params.jobName}`, {
      headers: { Authorization: `Bearer ${params.token}` },
    });
    const creatingJob = existingJob.status === 404;
    if (!existingJob.ok && !creatingJob) {
      const text = (await existingJob.text()).slice(0, 500);
      throw new Error(`Cloud Run job observation failed: ${existingJob.status}${text ? ` ${text}` : ''}`);
    }
    const upsertResponse = !creatingJob
      ? await fetch(`${jobsBaseUrl}/${params.jobName}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(params.jobSpec),
        })
      : await fetch(`${jobsBaseUrl}?jobId=${encodeURIComponent(params.jobName)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(params.jobSpec),
        });

    if (!upsertResponse.ok) {
      const text = await upsertResponse.text();
      throw new Error(`Cloud Run Jobs API error: ${upsertResponse.status} ${text}`);
    }

    const operation = await upsertResponse.json() as CloudRunOperation;
    await this.waitForCloudRunOperation(params.token, operation, `${params.description} ${creatingJob ? 'create' : 'update'}`);
    const job = await this.waitForCloudRunJobReady(params.jobName, params.token);

    return { created: creatingJob, job };
  }

  private async getCloudSchedulerJob(
    schedulerJobName: string,
    token: string
  ): Promise<CloudSchedulerJob | null> {
    if (!this.credentials) {
      return null;
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${region}/jobs/${schedulerJobName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Scheduler API error: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return await response.json() as CloudSchedulerJob;
  }

  private async upsertCloudSchedulerJob(params: {
    token: string;
    schedulerJobName: string;
    jobName: string;
    schedule: string;
    timeZone: string;
  }): Promise<{ created: boolean }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId, region } = this.credentials;
    const baseUrl = `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${region}/jobs`;
    const jobPath = `projects/${projectId}/locations/${region}/jobs/${params.schedulerJobName}`;
    const runUri = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${params.jobName}:run`;
    const schedulerSpec = {
      name: jobPath,
      description: `Run Cloud Run job ${params.jobName}`,
      schedule: params.schedule,
      timeZone: params.timeZone,
      httpTarget: {
        uri: runUri,
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: btoa('{}'),
        ...(this.serviceAccountCreds?.client_email
          ? {
              oauthToken: {
                serviceAccountEmail: this.serviceAccountCreds.client_email,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
              },
            }
          : {}),
      },
    };
    return this.upsertCloudSchedulerJobOnce({
      ...params,
      baseUrl,
      schedulerSpec,
      retriedAfterEnable: false,
    });
  }

  private async upsertCloudSchedulerJobOnce(params: {
    token: string;
    schedulerJobName: string;
    baseUrl: string;
    schedulerSpec: Record<string, unknown>;
    retriedAfterEnable: boolean;
  }): Promise<{ created: boolean }> {
    const existing = await this.getCloudSchedulerJob(params.schedulerJobName, params.token);
    const headers = {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    };
    const response = existing
      ? await fetch(`${params.baseUrl}/${params.schedulerJobName}?updateMask=description,schedule,timeZone,httpTarget`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(params.schedulerSpec),
        })
      : await fetch(params.baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(params.schedulerSpec),
        });

    if (!response.ok) {
      const text = await response.text();
      if (
        !params.retriedAfterEnable
        && this.isDisabledApiMessage(text, 'cloudscheduler.googleapis.com')
      ) {
        await this.enableGoogleService(params.token, 'cloudscheduler.googleapis.com');
        return this.upsertCloudSchedulerJobOnce({
          ...params,
          retriedAfterEnable: true,
        });
      }
      throw new Error(`Cloud Scheduler API error: ${response.status} ${text}`);
    }

    return { created: !existing };
  }

  private async deleteCloudRunServiceIfExists(serviceName: string, token: string): Promise<string | undefined> {
    if (!this.credentials) {
      return undefined;
    }

    const { projectId, region } = this.credentials;
    const headers = { Authorization: `Bearer ${token}` };
    const serviceUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`;
    const existing = await fetch(serviceUrl, { headers });
    if (existing.status === 404) {
      return undefined;
    }
    if (!existing.ok) {
      const text = await existing.text();
      return `Could not verify whether Cloud Run service ${serviceName} exists: ${existing.status} ${text}`;
    }

    const deleted = await fetch(serviceUrl, { method: 'DELETE', headers });
    if (deleted.status === 404) {
      return undefined;
    }
    if (!deleted.ok) {
      const text = await deleted.text();
      return `Skipped stale Cloud Run service cleanup for ${serviceName}: ${deleted.status} ${text}`;
    }

    try {
      const operation = await deleted.json() as CloudRunOperation;
      await this.waitForCloudRunOperation(token, operation, 'stale service delete');
    } catch (error) {
      return `Stale Cloud Run service cleanup for ${serviceName} may still be in progress: ${error instanceof Error ? error.message : String(error)}`;
    }

    return this.verifyCloudRunResourceDeleted(serviceUrl, headers, `Cloud Run service ${serviceName}`);
  }

  private async deleteCloudRunJobIfExists(jobName: string, token: string): Promise<string | undefined> {
    if (!this.credentials) {
      return undefined;
    }

    const { projectId, region } = this.credentials;
    const headers = { Authorization: `Bearer ${token}` };
    const jobUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}`;
    const existing = await fetch(jobUrl, { headers });
    if (existing.status === 404) {
      return undefined;
    }
    if (!existing.ok) {
      const text = await existing.text();
      return `Could not verify whether Cloud Run job ${jobName} exists: ${existing.status} ${text}`;
    }

    const deleted = await fetch(jobUrl, { method: 'DELETE', headers });
    if (deleted.status === 404) {
      return undefined;
    }
    if (!deleted.ok) {
      const text = await deleted.text();
      return `Skipped Cloud Run job cleanup for ${jobName}: ${deleted.status} ${text}`;
    }

    try {
      const operation = await deleted.json() as CloudRunOperation;
      await this.waitForCloudRunOperation(token, operation, 'job delete');
    } catch (error) {
      return `Cloud Run job cleanup for ${jobName} may still be in progress: ${error instanceof Error ? error.message : String(error)}`;
    }

    return this.verifyCloudRunResourceDeleted(jobUrl, headers, `Cloud Run job ${jobName}`);
  }

  private async verifyCloudRunResourceDeleted(
    url: string,
    headers: Record<string, string>,
    label: string
  ): Promise<string | undefined> {
    const attempts = Number(process.env.HYPERVIBE_CLOUDRUN_DELETE_ATTEMPTS ?? 20);
    const delayMs = Number(process.env.HYPERVIBE_CLOUDRUN_DELETE_DELAY_MS ?? 500);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetch(url, { headers });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        const text = await response.text();
        return `Could not verify deletion of ${label}: ${response.status} ${text}`;
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return `${label} is still present after ${attempts} deletion checks`;
  }

  private async deleteCloudSchedulerJobIfExists(schedulerJobName: string, token: string): Promise<string | undefined> {
    if (!this.credentials) {
      return undefined;
    }

    const { projectId, region } = this.credentials;
    const headers = { Authorization: `Bearer ${token}` };
    const schedulerUrl = `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${region}/jobs/${schedulerJobName}`;
    const deleted = await fetch(schedulerUrl, { method: 'DELETE', headers });
    if (deleted.status === 404) {
      return undefined;
    }
    if (!deleted.ok) {
      const text = await deleted.text();
      return `Skipped Cloud Scheduler cleanup for ${schedulerJobName}: ${deleted.status} ${text}`;
    }

    return undefined;
  }

  private cloudBuildStatusFromResponse(response: CloudBuildStatus | CloudBuildOperation): CloudBuildStatus | undefined {
    if ('status' in response || 'id' in response) {
      return response as CloudBuildStatus;
    }
    if (!this.isCloudBuildOperation(response)) {
      return undefined;
    }
    return response.response ?? response.metadata?.build;
  }

  private cloudBuildIdFromOperation(response: CloudBuildStatus | CloudBuildOperation): string | undefined {
    if (!this.isCloudBuildOperation(response)) {
      return undefined;
    }
    return response.metadata?.build?.id ?? response.metadata?.buildId ?? response.response?.id;
  }

  private isCloudBuildOperation(response: CloudBuildStatus | CloudBuildOperation): response is CloudBuildOperation {
    return 'done' in response || 'metadata' in response || 'response' in response || 'error' in response;
  }

  private async waitForCloudRunServiceReady(serviceName: string, token: string): Promise<CloudRunService | null> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const service = await this.getCloudRunService(serviceName, token);
      const readiness = this.cloudRunServiceReadiness(service);
      if (readiness.ready) {
        return service;
      }
      if (readiness.error) {
        throw new Error(`Cloud Run service ${serviceName} is not ready: ${readiness.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Cloud Run service ${serviceName} was not ready before timeout`);
  }

  private async getCloudRunService(serviceName: string, token: string): Promise<CloudRunService | null> {
    if (!this.credentials) {
      return null;
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run service observation failed: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return await response.json() as CloudRunService;
  }

  private cloudRunServiceReadiness(service: CloudRunService | null): { ready: boolean; error?: string } {
    if (!service) {
      return { ready: false };
    }

    const condition = service.terminalCondition ?? service.conditions?.find((entry) => entry.type === 'Ready');
    const state = condition?.state ?? condition?.status;
    const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
    const failed = state === 'CONDITION_FAILED' || state === 'False';
    const generationsMatch = !service.generation || !service.observedGeneration || String(service.generation) === String(service.observedGeneration);

    if (succeeded && generationsMatch && service.reconciling !== true) {
      return { ready: true };
    }

    if (failed && service.reconciling !== true) {
      const reason = condition?.reason ? `${condition.reason}: ` : '';
      return { ready: false, error: `${reason}${condition?.message ?? 'Ready condition failed'}` };
    }

    if (!condition && service.uri) {
      return { ready: true };
    }

    return { ready: false };
  }

  private async waitForCloudRunOperation(
    token: string,
    operation: CloudRunOperation,
    description: string
  ): Promise<void> {
    if (!operation.name || !operation.name.includes('/operations/')) {
      return;
    }

    let current = operation;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (current.done) {
        if (current.error) {
          throw new Error(
            `Cloud Run ${description} operation failed: ${current.error.status ?? current.error.code ?? 'unknown'} ${current.error.message ?? ''}`.trim()
          );
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch(`https://run.googleapis.com/v2/${current.name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run ${description} operation status check failed: ${response.status} ${text}`);
      }
      current = await response.json() as CloudRunOperation;
    }

    throw new Error(`Cloud Run ${description} operation did not finish before timeout`);
  }

  private async waitForCloudRunJobReady(jobName: string, token: string): Promise<CloudRunJob> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = await this.getCloudRunJob(jobName, token);
      const readiness = this.cloudRunJobReadiness(job);
      if (readiness.ready) {
        return job!;
      }
      if (readiness.error) {
        throw new Error(`Cloud Run job ${jobName} is not ready: ${readiness.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Cloud Run job ${jobName} was not ready before timeout`);
  }

  private async getCloudRunJob(
    jobName: string,
    token: string
  ): Promise<CloudRunJob | null> {
    if (!this.credentials) {
      return null;
    }

    const { projectId, region } = this.credentials;
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`Cloud Run Jobs API error: ${response.status}${text ? ` ${text}` : ''}`);
    }

    return await response.json() as CloudRunJob;
  }

  private cloudRunJobReadiness(job: CloudRunJob | null): { ready: boolean; error?: string } {
    if (!job) {
      return { ready: false };
    }

    const condition = job.terminalCondition ?? job.conditions?.find((entry) => entry.type === 'Ready');
    const state = condition?.state ?? condition?.status;
    const succeeded = state === 'CONDITION_SUCCEEDED' || state === 'True';
    const failed = state === 'CONDITION_FAILED' || state === 'False';
    const generationsMatch = !job.generation || !job.observedGeneration || job.generation === job.observedGeneration;

    if (succeeded && generationsMatch && job.reconciling !== true) {
      return { ready: true };
    }

    if (failed && job.reconciling !== true) {
      const reason = condition?.reason ? `${condition.reason}: ` : '';
      return { ready: false, error: `${reason}${condition?.message ?? 'Ready condition failed'}` };
    }

    return { ready: false };
  }

  private cloudSqlConnectionNamesFromEnv(envVars: Record<string, string>): string[] {
    const raw = envVars.CLOUD_SQL_CONNECTION_NAME ?? envVars.INSTANCE_CONNECTION_NAME;
    return this.parseCloudSqlConnectionNames(raw);
  }

  private cloudSqlConnectionNamesFromEnvVars(env: Array<Record<string, unknown>> | undefined): string[] {
    const byName = new Map<string, string>();
    for (const entry of env ?? []) {
      if (typeof entry.name === 'string' && typeof entry.value === 'string') {
        byName.set(entry.name, entry.value);
      }
    }
    return this.parseCloudSqlConnectionNames(byName.get('CLOUD_SQL_CONNECTION_NAME') ?? byName.get('INSTANCE_CONNECTION_NAME'));
  }

  private parseCloudSqlConnectionNames(raw: string | undefined): string[] {
    if (!raw) return [];
    return Array.from(new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => /^[^:]+:[^:]+:[^:]+$/.test(entry))
    ));
  }

  private cloudSqlVolumeConfig(connectionNames: string[] | undefined): { volume: Record<string, unknown>; volumeMount: Record<string, unknown> } | undefined {
    if (!connectionNames || connectionNames.length === 0) {
      return undefined;
    }
    return {
      volume: {
        name: 'cloudsql',
        cloudSqlInstance: {
          instances: connectionNames,
        },
      },
      volumeMount: {
        name: 'cloudsql',
        mountPath: '/cloudsql',
      },
    };
  }

  private mergeVolumes(
    existing: Array<Record<string, unknown>> | undefined,
    updates: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of existing ?? []) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    for (const entry of updates) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    return [...byName.values()];
  }

  private mergeVolumeMounts(
    existing: Array<Record<string, unknown>> | undefined,
    updates: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of existing ?? []) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    for (const entry of updates) {
      if (typeof entry.name === 'string') {
        byName.set(entry.name, { ...entry });
      }
    }
    return [...byName.values()];
  }

  private removeCloudSqlVolumeMounts(
    existing: Array<Record<string, unknown>> | undefined
  ): Array<Record<string, unknown>> {
    return (existing ?? []).filter((entry) => entry.name !== 'cloudsql');
  }

  private removeCloudSqlVolumes(
    existing: Array<Record<string, unknown>> | undefined
  ): Array<Record<string, unknown>> {
    return (existing ?? []).filter((entry) => entry.name !== 'cloudsql');
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
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private queueLabels(environment: Environment, queueName: string): Record<string, string> {
    return {
      'infraprint-environment': this.labelValue(environment.name),
      'infraprint-queue': this.labelValue(queueName),
    };
  }

  private assertQueueLabels(
    resource: string,
    labels: Record<string, string> | undefined,
    environment: Environment,
    queueName: string
  ): void {
    const expected = this.queueLabels(environment, queueName);
    if (Object.entries(expected).some(([key, value]) => labels?.[key] !== value)) {
      throw new Error(
        `${resource} is not owned by Hypervibe queue "${queueName}" in environment "${environment.name}"; explicit adoption or cleanup is required.`
      );
    }
  }

  private assertManagedQueueTopic(
    environment: Environment,
    queueName: string,
    topic: pubsub.PubSubTopic
  ): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { topicId } = this.queueResourceNames(environment, queueName);
    const expectedName = `projects/${this.credentials.projectId}/topics/${topicId}`;
    if (topic.name !== expectedName) {
      throw new Error(`Pub/Sub returned topic ${topic.name}, not exact queue topic ${expectedName}.`);
    }
    this.assertQueueLabels(`Pub/Sub topic ${topic.name}`, topic.labels, environment, queueName);
  }

  private assertManagedQueueSubscription(
    environment: Environment,
    queueName: string,
    subscription: pubsub.PubSubSubscription
  ): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const { topicId, subscriptionId } = this.queueResourceNames(environment, queueName);
    const expectedName = `projects/${this.credentials.projectId}/subscriptions/${subscriptionId}`;
    const expectedTopic = `projects/${this.credentials.projectId}/topics/${topicId}`;
    if (subscription.name !== expectedName || subscription.topic !== expectedTopic) {
      throw new Error(
        `Pub/Sub subscription ${subscription.name} does not match exact queue subscription ${expectedName} and topic ${expectedTopic}.`
      );
    }
    this.assertQueueLabels(
      `Pub/Sub subscription ${subscription.name}`,
      subscription.labels,
      environment,
      queueName
    );
  }

  private async waitForQueueTopic(token: string, topicId: string): Promise<pubsub.PubSubTopic> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const attempts = this.positiveIntegerEnv('HYPERVIBE_PUBSUB_CONVERGE_ATTEMPTS', 20);
    const intervalMs = this.nonNegativeIntegerEnv('HYPERVIBE_PUBSUB_POLL_INTERVAL_MS', 500);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const topic = await pubsub.getTopic(token, this.credentials.projectId, topicId);
      if (topic) return topic;
      if (attempt < attempts) await this.delay(intervalMs);
    }
    throw new Error(`Pub/Sub topic ${topicId} remained absent after its create acknowledgement.`);
  }

  private async waitForQueueSubscription(
    token: string,
    subscriptionId: string,
    ackDeadlineSeconds?: number
  ): Promise<pubsub.PubSubSubscription> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const attempts = this.positiveIntegerEnv('HYPERVIBE_PUBSUB_CONVERGE_ATTEMPTS', 20);
    const intervalMs = this.nonNegativeIntegerEnv('HYPERVIBE_PUBSUB_POLL_INTERVAL_MS', 500);
    let last: pubsub.PubSubSubscription | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await pubsub.getSubscription(token, this.credentials.projectId, subscriptionId);
      if (last && (ackDeadlineSeconds === undefined || last.ackDeadlineSeconds === ackDeadlineSeconds)) {
        return last;
      }
      if (attempt < attempts) await this.delay(intervalMs);
    }
    throw new Error(
      last
        ? `Pub/Sub subscription ${subscriptionId} did not converge to acknowledgement deadline ${ackDeadlineSeconds}.`
        : `Pub/Sub subscription ${subscriptionId} remained absent after its create acknowledgement.`
    );
  }

  private async waitForQueueAbsence(
    resource: string,
    observe: () => Promise<unknown | null>
  ): Promise<void> {
    const attempts = this.positiveIntegerEnv('HYPERVIBE_PUBSUB_DELETE_ATTEMPTS', 20);
    const intervalMs = this.nonNegativeIntegerEnv('HYPERVIBE_PUBSUB_POLL_INTERVAL_MS', 500);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if ((await observe()) === null) return;
      if (attempt < attempts) await this.delay(intervalMs);
    }
    throw new Error(`${resource} remained observable after its delete acknowledgement.`);
  }

  private mergeEnvVars(
    existing: Array<Record<string, unknown>> | undefined,
    updates: Record<string, string>,
    options: { replaceManagedDatabaseVars?: boolean } = {}
  ): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of existing ?? []) {
      if (typeof entry.name === 'string') {
        if (options.replaceManagedDatabaseVars && MANAGED_DATABASE_ENV_KEYS.has(entry.name)) {
          continue;
        }
        byName.set(entry.name, { ...entry });
      }
    }
    for (const [name, value] of Object.entries(updates)) {
      byName.set(name, { name, value });
    }
    return [...byName.values()];
  }

  private isManagedDatabaseEnvSync(updates: Record<string, string>): boolean {
    return Object.keys(updates).some((key) => MANAGED_DATABASE_SYNC_KEYS.has(key));
  }

  private formatError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
    if (!cause || typeof cause !== 'object') {
      return message;
    }

    const causeRecord = cause as Record<string, unknown>;
    const fields = ['code', 'errno', 'syscall', 'hostname', 'host', 'address', 'port']
      .map((field) => {
        const value = causeRecord[field];
        return typeof value === 'string' || typeof value === 'number' ? `${field}=${value}` : undefined;
      })
      .filter((value): value is string => Boolean(value));
    const causeMessage = cause instanceof Error && cause.message !== message ? cause.message : undefined;
    const details = [causeMessage, ...fields].filter((value): value is string => Boolean(value));
    return details.length > 0 ? `${message} (${details.join(', ')})` : message;
  }

  private imageUriForService(service: Service, envVars: Record<string, string>): string | undefined {
    return envVars[this.imageEnvKey(service)]?.trim() || envVars['IMAGE_URI']?.trim() || undefined;
  }

  private runtimeEnvVarsForService(service: Service, envVars: Record<string, string>): Record<string, string> {
    const internalKeys = new Set([
      'IMAGE_URI',
      this.imageEnvKey(service),
      'HYPERVIBE_SOURCE_REPO_URL',
      'HYPERVIBE_SOURCE_REVISION',
      'HYPERVIBE_ARTIFACT_REPOSITORY',
      'HYPERVIBE_GITHUB_TOKEN',
      'HYPERVIBE_CRON_TIME_ZONE',
    ]);
    return Object.fromEntries(
      Object.entries(envVars).filter(([key]) => !internalKeys.has(key))
    );
  }

  private imageEnvKey(service: Service): string {
    const serviceKey = service.name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return `IMAGE_URI_${serviceKey}`;
  }

  private sanitizeName(name: string): string {
    // Cloud Run service names must be lowercase, alphanumeric with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }

  private labelValue(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
    return normalized || 'unknown';
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudrun',
    displayName: 'GCP Cloud Run',
    category: 'deployment',
    credentialsSchema: CloudRunCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    maturity: {
      lifecycle: {
        hosting: { status: 'ready-for-live' },
        queue: {
          status: 'ready-for-live',
          reason: 'Mocked Pub/Sub lifecycle is complete; live promotion evidence has not been recorded.',
        },
      },
    },
    lifecycle: {
      hosting: {
        workloadKinds: ['web', 'worker', 'cron'],
        customDomains: 'managed',
        domainTrafficProxy: 'dns-only',
        maintenance: 'managed',
        teardownBoundary: 'services',
      },
      queue: { backend: 'pubsub', resources: 'managed' },
    },
    orchestration: {
      diff: {
        workloadKindObservation: 'exact',
      },
      logs: {
        runtime: true,
        deployments: true,
      },
      ci: {
        displayName: 'Cloud Run',
        requiredSecrets: CLOUDRUN_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          GCP_SERVICE_ACCOUNT_JSON: 'credentials',
          GCP_PROJECT_ID: 'projectId',
        },
        buildGitHubActionsSteps: buildCloudRunGitHubActionsSteps,
        buildPortableRecipe: buildCloudRunPortableRecipe,
        portableRunnerCapabilities: ['linux-amd64', 'docker-privileged'],
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new CloudRunAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['environment', 'artifact'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'region', 'limit'], list: true },
      artifact: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'region', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['projectId', 'location'],
        collectionKey: 'artifacts',
      },
    },
    inspect: (adapter, request) => request.resource === 'artifact'
      ? (adapter as CloudRunAdapter).inspectArtifactResources(request)
      : (adapter as CloudRunAdapter).inspectEnvironmentResources(request),
  },
  retainedCleanup: {
    resources: ['artifact'],
    destroy: (adapter, target) => (adapter as CloudRunAdapter).destroyRetainedArtifactRepository(target),
  },
});
