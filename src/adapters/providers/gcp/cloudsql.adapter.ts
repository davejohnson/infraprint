import { z } from 'zod';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Receipt, TemporaryDatabaseAccess, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IDatabaseAdapter,
  DatabaseCapabilities,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import { databaseCreateMayHaveCommitted } from '../../../domain/ports/database.port.js';
import type { IObservableDatabase, ObservedDatabase } from '../../../domain/ports/observe.port.js';
import type {
  DatabaseAvailability,
  DatabaseBackupPolicy,
  DatabaseReplicaBinding,
  DatabaseReplicaConfig,
  DatabaseReplicaProvisionResult,
  IDatabaseResilienceAdapter,
} from '../../../domain/ports/database-resilience.port.js';
import {
  providerRegistry,
  type DatabaseRuntimeProjection,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  buildDatabaseEnvVarsFromComponent,
  databaseReplicaEnvKey,
} from '../../../domain/services/database-env.js';
import { buildCloudSqlRestoreDrillWorkflow } from './cloudsql-restore-drill.workflow.js';

// Credentials schema for self-registration
export const CloudSqlCredentialsSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  region: z.string().default('us-central1'),
});

export type CloudSqlCredentials = z.infer<typeof CloudSqlCredentialsSchema>;

interface CloudSqlInstance {
  name: string;
  state: string;
  databaseVersion: string;
  ipAddresses?: Array<{
    type: string;
    ipAddress: string;
  }>;
  serverCaCert?: {
    cert: string;
    commonName: string;
    expirationTime: string;
  };
  region?: string;
  connectionName?: string;
  masterInstanceName?: string;
  replicaNames?: string[];
  settings?: {
    tier?: string;
    availabilityType?: string;
    edition?: string;
    userLabels?: Record<string, string>;
    backupConfiguration?: {
      startTime?: string;
      enabled?: boolean;
      pointInTimeRecoveryEnabled?: boolean;
      transactionLogRetentionDays?: number;
      backupRetentionSettings?: {
        retentionUnit?: string;
        retainedBackups?: number;
      };
    };
  };
}

interface CloudSqlOperation {
  name?: string;
  status?: string;
  error?: {
    errors?: Array<{ code?: string; message?: string }>;
  };
}

interface CloudSqlInstanceList {
  items?: CloudSqlInstance[];
  nextPageToken?: string;
}

interface CloudSqlBackup {
  name: string;
  description?: string;
  sourceInstance?: string;
  type?: string;
  backupKind?: string;
  state?: string;
  databaseVersion?: string;
  location?: string;
  instanceDeletionTime?: string;
  expiryTime?: string;
  ttlDays?: string | number;
  maxChargeableBytes?: string;
}

interface CloudSqlBackupList {
  backups?: CloudSqlBackup[];
  nextPageToken?: string;
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
}

function databaseRuntimeString(
  bindings: Record<string, unknown>,
  key: string
): string | undefined {
  const value = bindings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cloudSqlSocketDatabaseUrl(params: {
  username?: string;
  password?: string;
  database?: string;
  socketHost: string;
}): string | undefined {
  if (!params.username || !params.password || !params.database) return undefined;
  return `postgresql://${encodeURIComponent(params.username)}:${encodeURIComponent(params.password)}@/${encodeURIComponent(params.database)}?host=${encodeURIComponent(params.socketHost)}`;
}

function cloudSqlReplicaBindings(
  bindings: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const resilience = bindings.resilience;
  if (!resilience || typeof resilience !== 'object' || Array.isArray(resilience)) return {};
  const replicas = (resilience as Record<string, unknown>).replicas;
  if (!replicas || typeof replicas !== 'object' || Array.isArray(replicas)) return {};
  return replicas as Record<string, Record<string, unknown>>;
}

function projectCloudSqlDatabaseRuntime(
  component: Component,
  standard: DatabaseRuntimeProjection
): DatabaseRuntimeProjection {
  const bindings = component.bindings as Record<string, unknown>;
  const envVars = { ...standard.envVars };
  const username = databaseRuntimeString(bindings, 'username');
  const password = databaseRuntimeString(bindings, 'password');
  const database = databaseRuntimeString(bindings, 'database');
  const connectionName = databaseRuntimeString(bindings, 'connectionName');
  const socketHost = connectionName
    ? `/cloudsql/${connectionName}`
    : databaseRuntimeString(bindings, 'host');
  const socketUrl = socketHost
    ? cloudSqlSocketDatabaseUrl({ username, password, database, socketHost })
    : undefined;

  if (socketUrl) {
    envVars.DATABASE_URL = socketUrl;
    envVars.DIRECT_URL = socketUrl;
  }

  const replicas = Object.entries(cloudSqlReplicaBindings(bindings))
    .sort(([left], [right]) => left.localeCompare(right));
  const replicaConnectionNames = replicas
    .map(([, replica]) => databaseRuntimeString(replica, 'connectionName'))
    .filter((value): value is string => Boolean(value));
  if (connectionName) {
    const connectionNames = [connectionName, ...replicaConnectionNames].join(',');
    envVars.CLOUD_SQL_CONNECTION_NAME = connectionNames;
    envVars.INSTANCE_CONNECTION_NAME = connectionNames;
  }
  if (socketHost) {
    envVars.DATABASE_HOST = socketHost;
    envVars.DB_HOST = socketHost;
    envVars.PGHOST = socketHost;
  }
  for (const [name, replica] of replicas) {
    const replicaConnectionName = databaseRuntimeString(replica, 'connectionName');
    const replicaUrl = replicaConnectionName
      ? cloudSqlSocketDatabaseUrl({
        username,
        password,
        database,
        socketHost: `/cloudsql/${replicaConnectionName}`,
      })
      : databaseRuntimeString(replica, 'connectionUrl');
    if (replicaUrl) {
      envVars[databaseReplicaEnvKey(name)] = replicaUrl;
      if (replicas.length === 1) envVars.DATABASE_READ_URL = replicaUrl;
    }
  }

  return { envVars, connectionUrl: standard.connectionUrl };
}

export class CloudSqlAdapter implements IDatabaseAdapter, IObservableDatabase, IDatabaseResilienceAdapter {
  readonly name = 'cloudsql';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false, // Cloud SQL Auth Proxy recommended
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: CloudSqlCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private temporaryConnectors = new Map<string, { connector: Connector; directory: string }>();

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as CloudSqlCredentials;
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId } = this.credentials;

      // A token exchange succeeds even for a service account with zero roles;
      // probe the SQL Admin API so verification proves real access.
      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances?maxResults=1`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 403) {
          return {
            success: false,
            error: [
              'Cloud SQL Admin API probe failed with 403.',
              `Grant roles/cloudsql.viewer and roles/cloudsql.client to serviceAccount:${this.serviceAccountCreds.client_email} on project ${projectId};`,
              'also grant roles/cloudsql.admin if Hypervibe should provision or delete databases,',
              'and make sure the sqladmin.googleapis.com API is enabled (hv_connections provider="cloudrun" action="prepare" enables it).',
              `Original error: ${text}`,
            ].join(' '),
          };
        }
        return {
          success: false,
          error: `Cloud SQL Admin API probe failed: ${response.status} ${text}`,
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
    for (const temporary of this.temporaryConnectors.values()) {
      temporary.connector.close();
      await rm(temporary.directory, { recursive: true, force: true }).catch(() => {});
    }
    this.temporaryConnectors.clear();
    this.credentials = null;
    this.serviceAccountCreds = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      databaseName?: string;
      resourceName?: string;
    }
  ): Promise<ProvisionResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (type !== 'postgres') {
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
          message: `Cloud SQL supports postgres. Requested type: ${type}`,
        },
      };
    }

    let requestedInstanceName: string | undefined;
    let requestedRegion: string | undefined;
    let createAcknowledged = false;
    let createMutationAttempted = false;
    let createMayHaveCommitted = false;
    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;
      const targetRegion = options?.region?.trim() || region;

      const instanceName = this.sanitizeName(options?.resourceName || `${environment.name}-${type}`);
      requestedInstanceName = instanceName;
      requestedRegion = targetRegion;
      const existing = await this.getInstance(instanceName);
      if (existing) {
        throw new Error(
          `Cloud SQL instance "${instanceName}" already exists. Hypervibe will not silently adopt or replace it; use hv_import for that exact provider identity.`
        );
      }
      const rootPassword = this.generatePassword();
      const dbName = options?.databaseName?.trim() || 'app';

      // Map type to Cloud SQL database version
      const versionMap: Record<string, string> = {
        postgres: 'POSTGRES_15',
      };

      const databaseVersion = versionMap[type];
      const defaultPort = 5432;

      // Create Cloud SQL instance
      createMutationAttempted = true;
      createMayHaveCommitted = true;
      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: instanceName,
            region: targetRegion,
            databaseVersion,
            settings: {
              tier: options?.size || 'db-f1-micro',
              ipConfiguration: {
                ipv4Enabled: true,
              },
              backupConfiguration: {
                enabled: true,
                pointInTimeRecoveryEnabled: true,
              },
            },
            rootPassword,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        const apiError = Object.assign(
          new Error(`Cloud SQL API error: ${response.status} ${text}`),
          { status: response.status }
        );
        createMayHaveCommitted = databaseCreateMayHaveCommitted(apiError);
        throw apiError;
      }
      createAcknowledged = true;

      // Wait for operation to start (instance creation is async)
      const operation = (await response.json()) as CloudSqlOperation;
      if (operation.name) {
        await this.waitForOperation(token, operation.name, 'instance create');
      }

      const instance = await this.getInstance(instanceName);
      if (
        !instance
        || instance.region !== targetRegion
        || instance.databaseVersion !== databaseVersion
        || instance.state !== 'RUNNABLE'
      ) {
        throw new Error(
          `Cloud SQL instance ${instanceName} did not converge to RUNNABLE ${databaseVersion} in ${targetRegion}.`
        );
      }

      // Get the instance details (may not have IP yet)
      // For now, construct connection string with placeholder
      const host = `${instanceName}.${targetRegion}.${projectId}`;
      const rootUser = 'postgres';
      await this.ensureDatabaseByName({
        token,
        instanceName,
        databaseName: dbName,
      });

      const connectionUrl = `postgresql://${encodeURIComponent(rootUser)}:${encodeURIComponent(rootPassword)}@${host}:${defaultPort}/${encodeURIComponent(dbName)}`;

      // Cloud SQL connection name format for Cloud SQL Auth Proxy
      const expectedConnectionName = `${projectId}:${targetRegion}:${instanceName}`;
      if (instance.connectionName && instance.connectionName !== expectedConnectionName) {
        throw new Error(
          `Cloud SQL instance ${instanceName} returned connection identity ${instance.connectionName}, not ${expectedConnectionName}.`
        );
      }
      const connectionName = instance.connectionName ?? expectedConnectionName;

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          connectionString: connectionUrl,
          host,
          port: defaultPort,
          username: rootUser,
          password: rootPassword,
          database: dbName,
          provider: 'cloudsql',
          instanceId: instanceName,
          connectionName,
          providerScope: { projectId, region: targetRegion },
        },
        externalId: instanceName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created Cloud SQL ${type} instance: ${instanceName} (provisioning may take 5-10 minutes)`,
          data: {
            instanceName,
            operationId: operation.name,
            connectionName,
          },
        },
        connectionUrl,
        envVars: buildDatabaseEnvVarsFromComponent(component).envVars,
      };
    } catch (error) {
      let recovered: CloudSqlInstance | null | undefined;
      let recoveryError: string | undefined;
      if (
        createMutationAttempted
        && requestedInstanceName
        && (createAcknowledged || createMayHaveCommitted)
      ) {
        try {
          recovered = await this.recoverInstanceAfterCreateAttempt(requestedInstanceName);
        } catch (recoveryFailure) {
          recoveryError = recoveryFailure instanceof Error
            ? recoveryFailure.message
            : String(recoveryFailure);
        }
      }
      const retainIdentity = Boolean(
        requestedInstanceName
        && requestedRegion
        && (createAcknowledged || createMayHaveCommitted)
      );
      const retainedRegion = typeof recovered?.region === 'string' && recovered.region.trim()
        ? recovered.region.trim()
        : requestedRegion;
      const emptyComponent: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: retainIdentity && requestedInstanceName && retainedRegion
          ? {
              provider: 'cloudsql',
              instanceId: requestedInstanceName,
              providerScope: {
                projectId: this.credentials.projectId,
                region: retainedRegion,
              },
              cleanupRequired: true,
            }
          : {},
        externalId: retainIdentity ? requestedInstanceName ?? null : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component: emptyComponent,
        receipt: {
          success: false,
          message: 'Failed to provision Cloud SQL instance',
          error: `${String(error)}${recoveryError
            ? ` Exact-id recovery also failed: ${recoveryError}`
            : ''}`,
          ...(retainIdentity && requestedInstanceName ? {
            data: {
              instanceName: requestedInstanceName,
              projectId: this.credentials.projectId,
              region: retainedRegion,
              resourceCreated: recovered ? true : 'unknown',
              cleanupRequired: true,
              mutationAttempted: createMutationAttempted,
              ...(recoveryError ? { recoveryError } : {}),
            },
          } : {}),
        },
      };
    }
  }

  async ensureDatabase(component: Component, databaseName?: string): Promise<Receipt> {
    if (!this.credentials) {
      return { success: false, message: 'Not connected' };
    }

    const bindings = component.bindings as Record<string, unknown>;
    const instanceName =
      component.externalId
      ?? (typeof bindings.instanceId === 'string' ? bindings.instanceId : undefined);
    const targetDatabase =
      databaseName?.trim()
      || (typeof bindings.database === 'string' && bindings.database.trim().length > 0 ? bindings.database.trim() : undefined)
      || 'app';

    if (!instanceName) {
      return {
        success: false,
        message: 'Cloud SQL component is missing an instance ID',
      };
    }

    try {
      this.assertComponentScope(component);
      const token = await this.getAccessToken();
      const instance = await this.getInstance(instanceName);
      if (!instance) {
        throw new Error(`Primary Cloud SQL instance ${instanceName} is absent.`);
      }
      this.assertComponentScope(component, instance);
      const created = await this.ensureDatabaseByName({
        token,
        instanceName,
        databaseName: targetDatabase,
      });
      return {
        success: true,
        message: created
          ? `Created Cloud SQL database ${targetDatabase} on ${instanceName}`
          : `Cloud SQL database ${targetDatabase} already exists on ${instanceName}`,
        data: {
          instanceName,
          databaseName: targetDatabase,
          created,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to ensure Cloud SQL database ${targetDatabase}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.credentials) {
      return null;
    }
    this.assertComponentScope(component);

    const bindings = component.bindings as {
      connectionUrl?: string;
      connectionString?: string;
      username?: string;
      password?: string;
      database?: string;
      port?: number | string;
    };

    // Prefer a live public IP lookup. Early Cloud SQL bindings stored a
    // provider-internal placeholder host that is useful inside Cloud Run but
    // not directly reachable by local Hypervibe db_query.
    let liveInstance: CloudSqlInstance | null | undefined;
    if (component.externalId) {
      try {
        liveInstance = await this.getInstance(component.externalId);
      } catch {
        // A stored URL can remain usable while the control-plane read is
        // temporarily unavailable. Scope checks still happen outside this
        // fallback so another project/region can never be selected silently.
      }
      if (liveInstance) {
        this.assertComponentScope(component, liveInstance);
        if (liveInstance.ipAddresses) {
          const publicIp = liveInstance.ipAddresses.find((ip) => ip.type === 'PRIMARY');
          if (publicIp) {
            const port = Number(bindings.port ?? (component.type === 'postgres' ? 5432 : 3306));
            const username = bindings.username;
            const password = bindings.password;
            const database = bindings.database;
            if (username && password && database) {
              return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${publicIp.ipAddress}:${port}/${encodeURIComponent(database)}`;
            }
          }
        }
      }
    }

    return bindings.connectionUrl ?? bindings.connectionString ?? null;
  }

  async acquireTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.credentials || !this.serviceAccountCreds) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (applicationPort !== 5432) {
      throw new Error(`Cloud SQL PostgreSQL access requires application port 5432, received ${applicationPort}.`);
    }
    this.assertComponentScope(component);

    const bindings = component.bindings as Record<string, unknown>;
    const instanceName = component.externalId
      ?? (typeof bindings.instanceId === 'string' ? bindings.instanceId : undefined);
    const providerScope = bindings.providerScope && typeof bindings.providerScope === 'object' && !Array.isArray(bindings.providerScope)
      ? bindings.providerScope as Record<string, unknown>
      : undefined;
    const connectionRegion = typeof providerScope?.region === 'string'
      ? providerScope.region
      : this.credentials.region;
    const connectionName = typeof bindings.connectionName === 'string'
      ? bindings.connectionName
      : instanceName ? `${this.credentials.projectId}:${connectionRegion}:${instanceName}` : undefined;
    if (!connectionName) {
      throw new Error('Cloud SQL component is missing its instance connection name.');
    }
    this.assertConnectionNameScope(connectionName, instanceName, component);

    const storedUrl = typeof bindings.connectionUrl === 'string'
      ? bindings.connectionUrl
      : typeof bindings.connectionString === 'string' ? bindings.connectionString : undefined;
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = storedUrl ? new URL(storedUrl) : undefined;
    } catch {
      parsedUrl = undefined;
    }
    const username = typeof bindings.username === 'string' ? bindings.username : parsedUrl?.username;
    const password = typeof bindings.password === 'string' ? bindings.password : parsedUrl?.password;
    const database = typeof bindings.database === 'string'
      ? bindings.database
      : parsedUrl?.pathname.replace(/^\//, '');
    if (!username || !password || !database) {
      throw new Error('Cloud SQL bindings are missing the database username, password, or database name.');
    }

    const auth = new GoogleAuth({
      credentials: this.serviceAccountCreds,
      scopes: ['https://www.googleapis.com/auth/sqlservice.admin'],
    });
    const connector = new Connector({ auth });
    const directory = await mkdtemp(path.join(tmpdir(), 'hv-cloudsql-'));
    const socketPath = path.join(directory, '.s.PGSQL.5432');
    try {
      await connector.startLocalProxy({
        instanceConnectionName: connectionName,
        ipType: IpAddressTypes.PUBLIC,
        listenOptions: { path: socketPath },
      });
      const releaseToken = randomUUID();
      this.temporaryConnectors.set(releaseToken, { connector, directory });
      const authPart = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
      return {
        connectionUrl: `postgresql://${authPart}@localhost/${encodeURIComponent(database)}?host=${encodeURIComponent(directory)}`,
        source: 'private_connector',
        temporary: true,
        releaseToken,
      };
    } catch (error) {
      connector.close();
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async releaseTemporaryDatabaseAccess(
    _environment: Environment,
    _component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    if (!access.releaseToken) {
      throw new Error('Temporary Cloud SQL access is missing its cleanup token.');
    }
    const temporary = this.temporaryConnectors.get(access.releaseToken);
    if (!temporary) return;
    temporary.connector.close();
    await rm(temporary.directory, { recursive: true, force: true });
    this.temporaryConnectors.delete(access.releaseToken);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials) {
      return { success: false, message: 'Not connected' };
    }

    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }

    try {
      this.assertComponentScope(component);
      const token = await this.getAccessToken();
      const { projectId } = this.credentials;
      const current = await this.getInstance(component.externalId);
      if (!current) {
        return {
          success: true,
          message: `Cloud SQL instance is already absent: ${component.externalId}`,
        };
      }
      this.assertComponentScope(component, current);

      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${component.externalId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.status === 404) {
        return {
          success: true,
          message: `Cloud SQL instance is already absent: ${component.externalId}`,
        };
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud SQL API error: ${response.status} ${text}`);
      }

      const operation = await response.json() as CloudSqlOperation;
      if (operation.name) {
        await this.waitForOperation(token, operation.name, 'instance delete');
      }
      const attempts = Number(process.env.HYPERVIBE_CLOUDSQL_DELETE_ATTEMPTS ?? 60);
      const delayMs = Number(process.env.HYPERVIBE_CLOUDSQL_DELETE_DELAY_MS ?? 1000);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!await this.getInstance(component.externalId)) {
          return {
            success: true,
            message: `Deleted Cloud SQL instance: ${component.externalId}`,
          };
        }
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      return {
        success: false,
        message: 'Cloud SQL accepted deletion but the instance is still present',
        error: `Instance ${component.externalId} was still observable after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Cloud SQL instance',
        error: String(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.credentials || !component.externalId) {
      return { status: 'unknown' };
    }

    try {
      this.assertComponentScope(component);
      const instance = await this.getInstance(component.externalId);
      if (!instance) {
        return { status: 'unknown', message: 'Instance not found' };
      }
      this.assertComponentScope(component, instance);

      const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error'> = {
        RUNNABLE: 'running',
        PENDING_CREATE: 'provisioning',
        MAINTENANCE: 'running',
        FAILED: 'error',
        SUSPENDED: 'stopped',
        PENDING_DELETE: 'stopped',
        UNKNOWN_STATE: 'unknown' as 'running',
      };

      return {
        status: statusMap[instance.state] || 'unknown',
        message: instance.state,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (component?.externalId) {
      this.assertComponentScope(component);
      const instance = await this.getInstance(component.externalId);
      if (!instance) return null;
      this.assertComponentScope(component, instance);
      return {
        provider: this.name,
        engine: 'postgres',
        externalId: instance.name || component.externalId,
        providerScope: this.instanceProviderScope(instance),
        name: instance.name || component.externalId,
        status: this.normalizedInstanceStatus(instance.state),
        resilience: await this.observeResilience(instance, component),
      };
    }

    // Backward-compatible discovery for components created before resourceName.
    for (const type of ['postgres'] as const) {
      const instanceName = this.sanitizeName(options?.resourceName || `${environment.name}-${type}`);
      const instance = await this.getInstance(instanceName);
      if (!instance) {
        continue;
      }

      return {
        provider: this.name,
        engine: type,
        externalId: instance.name || instanceName,
        providerScope: this.instanceProviderScope(instance),
        name: instance.name || instanceName,
        status: this.normalizedInstanceStatus(instance.state),
        resilience: await this.observeResilience(instance, component),
      };
    }

    return null;
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const selected = request.id ?? request.name;
    if (selected) {
      const instance = await this.getInstance(selected);
      return {
        observation: instance ? 'present' : 'absent',
        resource: 'database',
        project: { id: this.credentials.projectId },
        databases: instance ? [this.inspectedDatabase(instance)] : [],
        ...(instance ? {} : { [request.id ? 'id' : 'name']: selected }),
        truncated: false,
        partial: false,
      };
    }

    const token = await this.getAccessToken();
    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/instances?maxResults=${request.limit}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL instance inventory failed: ${response.status} ${body}`);
    }
    const page = await response.json() as CloudSqlInstanceList;
    const databases = (page.items ?? [])
      .slice(0, request.limit)
      .map((instance) => this.inspectedDatabase(instance));
    return {
      observation: databases.length > 0 ? 'present' : 'absent',
      resource: 'database',
      project: { id: this.credentials.projectId },
      databases,
      truncated: Boolean(page.nextPageToken) || (page.items?.length ?? 0) > request.limit,
      partial: false,
    };
  }

  async inspectBackupResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const selectedId = request.id?.trim();
    if (selectedId) {
      const backup = await this.getBackup(selectedId);
      return {
        observation: backup ? 'present' : 'absent',
        resource: 'backup',
        project: { id: this.credentials.projectId },
        backups: backup ? [this.inspectedBackup(backup)] : [],
        ...(backup ? {} : { id: selectedId }),
        truncated: false,
        partial: false,
      };
    }

    const token = await this.getAccessToken();
    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/backups?pageSize=${request.limit}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL backup inventory failed: ${response.status} ${body}`);
    }
    const page = await response.json() as CloudSqlBackupList;
    const candidates = (page.backups ?? []).filter((backup) => (
      !request.name || backup.name === request.name || this.lastPathSegment(backup.name) === request.name
    ));
    const backups = candidates.slice(0, request.limit).map((backup) => this.inspectedBackup(backup));
    const incompleteNameSearch = Boolean(request.name && page.nextPageToken);
    return {
      observation: incompleteNameSearch
        ? 'unknown'
        : request.name && backups.length > 1
        ? 'ambiguous'
        : backups.length > 0 ? 'present' : 'absent',
      resource: 'backup',
      project: { id: this.credentials.projectId },
      backups,
      ...(request.name ? { name: request.name } : {}),
      truncated: Boolean(page.nextPageToken) || candidates.length > request.limit,
      partial: incompleteNameSearch,
    };
  }

  async destroyRetainedBackup(target: {
    resource: string;
    id: string;
    providerScope: Record<string, string>;
  }): Promise<Receipt> {
    if (!this.credentials) return { success: false, message: 'Not connected' };
    if (
      target.resource !== 'backup'
      || target.providerScope.projectId !== this.credentials.projectId
      || !this.isBackupResourceName(target.id)
    ) {
      return {
        success: false,
        message: 'Cloud SQL backup deletion target is invalid',
        error: 'The exact backup id or project scope does not match the connected project.',
      };
    }
    try {
      const before = await this.getBackup(target.id);
      if (!before) return { success: true, message: `Cloud SQL backup is already absent: ${target.id}` };
      if (before.name !== target.id) {
        return { success: false, message: 'Cloud SQL returned a different backup identity', error: 'No deletion was attempted.' };
      }
      if (!before.instanceDeletionTime) {
        return {
          success: false,
          message: 'Cloud SQL backup belongs to a live instance',
          error: 'Retained-resource cleanup will not delete a backup for a live instance; the source instance deletion time must be present.',
        };
      }
      const token = await this.getAccessToken();
      const response = await fetch(`https://sqladmin.googleapis.com/v1/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 404) return { success: true, message: `Cloud SQL backup is already absent: ${target.id}` };
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Cloud SQL backup delete failed: ${response.status} ${body}`);
      }
      const operation = await response.json() as CloudSqlOperation;
      if (operation.name) await this.waitForOperation(token, operation.name, 'backup delete');
      const attempts = Math.max(1, Number(process.env.HYPERVIBE_CLOUDSQL_DELETE_ATTEMPTS ?? 60));
      const delayMs = Math.max(0, Number(process.env.HYPERVIBE_CLOUDSQL_DELETE_DELAY_MS ?? 1000));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!await this.getBackup(target.id)) {
          return { success: true, message: `Deleted Cloud SQL retained backup: ${target.id}` };
        }
        if (attempt < attempts - 1 && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      return {
        success: false,
        message: 'Cloud SQL accepted backup deletion but it remains present',
        error: `${target.id} remained observable after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Cloud SQL retained backup',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async configureAvailability(
    _environment: Environment,
    component: Component,
    availability: DatabaseAvailability
  ): Promise<Receipt> {
    const instanceName = this.componentInstanceName(component);
    if (!this.credentials || !instanceName) {
      return { success: false, message: 'Cannot configure Cloud SQL availability', error: 'Connection or primary instance identity is missing.' };
    }
    try {
      this.assertComponentScope(component);
      const token = await this.getAccessToken();
      const desired = availability === 'regional' ? 'REGIONAL' : 'ZONAL';
      const current = await this.getInstance(instanceName);
      if (!current) throw new Error(`Primary Cloud SQL instance ${instanceName} is absent.`);
      this.assertComponentScope(component, current);
      if (availability === 'regional') {
        const backup = current?.settings?.backupConfiguration;
        if (!backup?.enabled || !backup.pointInTimeRecoveryEnabled) {
          throw new Error('Regional Cloud SQL availability requires backups and PITR. Declare database.resilience.backups and apply that action first.');
        }
      }
      await this.patchInstance({
        token,
        instanceName,
        body: { settings: { availabilityType: desired } },
        description: 'availability update',
      });
      const observed = await this.getInstance(instanceName);
      if (observed?.settings?.availabilityType !== desired) {
        throw new Error(`Cloud SQL returned ${observed?.settings?.availabilityType ?? 'unknown'} after requesting ${desired}.`);
      }
      return {
        success: true,
        message: `Configured Cloud SQL availability as ${availability}`,
        data: { instanceName, availability },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to configure Cloud SQL availability',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async configureBackupPolicy(
    _environment: Environment,
    component: Component,
    policy: DatabaseBackupPolicy
  ): Promise<Receipt> {
    const instanceName = this.componentInstanceName(component);
    if (!this.credentials || !instanceName) {
      return { success: false, message: 'Cannot configure Cloud SQL backup policy', error: 'Connection or primary instance identity is missing.' };
    }
    if (policy.pitrRetentionDays > 7) {
      return {
        success: false,
        message: 'Cloud SQL PITR retention is not supported by the current database class',
        error: 'Hypervibe currently provisions Cloud SQL Enterprise instances, which support at most 7 PITR days.',
      };
    }
    try {
      this.assertComponentScope(component);
      const token = await this.getAccessToken();
      const current = await this.getInstance(instanceName);
      if (!current) throw new Error(`Primary Cloud SQL instance ${instanceName} is absent.`);
      this.assertComponentScope(component, current);
      await this.patchInstance({
        token,
        instanceName,
        body: {
          settings: {
            backupConfiguration: {
              startTime: current.settings?.backupConfiguration?.startTime ?? '03:00',
              enabled: true,
              pointInTimeRecoveryEnabled: true,
              transactionLogRetentionDays: policy.pitrRetentionDays,
              backupRetentionSettings: {
                retentionUnit: 'COUNT',
                retainedBackups: policy.retainedBackups,
              },
            },
          },
        },
        description: 'backup policy update',
      });
      const observed = (await this.getInstance(instanceName))?.settings?.backupConfiguration;
      if (
        !observed?.enabled
        || !observed.pointInTimeRecoveryEnabled
        || observed.transactionLogRetentionDays !== policy.pitrRetentionDays
        || observed.backupRetentionSettings?.retainedBackups !== policy.retainedBackups
      ) {
        throw new Error('Cloud SQL did not report the requested backup/PITR policy after the update completed.');
      }
      return {
        success: true,
        message: `Configured ${policy.retainedBackups} retained backups and ${policy.pitrRetentionDays} PITR days`,
        data: { instanceName, ...policy },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to configure Cloud SQL backup policy',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async provisionReadReplica(
    _environment: Environment,
    component: Component,
    name: string,
    config: DatabaseReplicaConfig
  ): Promise<DatabaseReplicaProvisionResult> {
    const primaryName = this.componentInstanceName(component);
    if (!this.credentials || !primaryName) {
      return {
        receipt: { success: false, message: 'Cannot provision Cloud SQL read replica', error: 'Connection or primary instance identity is missing.' },
      };
    }
    try {
      this.assertComponentScope(component);
      const token = await this.getAccessToken();
      const primary = await this.getInstance(primaryName);
      if (!primary) throw new Error(`Primary Cloud SQL instance ${primaryName} is absent.`);
      this.assertComponentScope(component, primary);
      const instanceName = this.sanitizeName(`${primaryName}-rr-${name}`);
      let replica = await this.getInstance(instanceName);
      if (replica) {
        if (!this.isReplicaOf(replica, primaryName) || replica.settings?.userLabels?.['hypervibe-replica'] !== name) {
          throw new Error(`Cloud SQL instance "${instanceName}" already exists and is not the reviewed Hypervibe replica. Use hv_import or choose another replica name.`);
        }
      } else {
        const region = config.region ?? primary.region ?? this.credentials.region;
        const tier = config.tier ?? primary.settings?.tier ?? 'db-f1-micro';
        const response = await fetch(
          `https://sqladmin.googleapis.com/v1/projects/${this.credentials.projectId}/instances`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: instanceName,
              region,
              databaseVersion: primary.databaseVersion,
              masterInstanceName: primaryName,
              settings: {
                tier,
                ipConfiguration: { ipv4Enabled: true },
                userLabels: {
                  'hypervibe-managed': 'true',
                  'hypervibe-replica': name,
                },
              },
            }),
          }
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Cloud SQL replica create failed: ${response.status} ${body}`);
        }
        const operation = await response.json() as CloudSqlOperation;
        if (operation.name) await this.waitForOperation(token, operation.name, 'read replica create');
        replica = await this.getInstance(instanceName);
      }
      if (!replica || !this.isReplicaOf(replica, primaryName) || replica.state !== 'RUNNABLE') {
        throw new Error(`Cloud SQL replica ${instanceName} was not RUNNABLE with primary ${primaryName} after creation.`);
      }
      const binding = this.replicaBinding(component, replica);
      return {
        replica: binding,
        receipt: {
          success: true,
          message: `Provisioned Cloud SQL read replica "${name}" (${replica.name})`,
          data: { replicaName: name, externalId: replica.name, region: binding.region, tier: binding.tier },
        },
      };
    } catch (error) {
      return {
        receipt: {
          success: false,
          message: `Failed to provision Cloud SQL read replica "${name}"`,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async destroyReadReplica(
    _environment: Environment,
    component: Component,
    name: string,
    replicaBinding: DatabaseReplicaBinding
  ): Promise<Receipt> {
    const primaryName = this.componentInstanceName(component);
    if (!this.credentials || !primaryName) {
      return { success: false, message: 'Cannot delete Cloud SQL read replica', error: 'Connection or primary instance identity is missing.' };
    }
    try {
      this.assertComponentScope(component);
      const token = await this.getAccessToken();
      const replica = await this.getInstance(replicaBinding.externalId);
      if (!replica) {
        return { success: true, message: `Cloud SQL read replica is already absent: ${replicaBinding.externalId}` };
      }
      if (!this.isReplicaOf(replica, primaryName) || replica.settings?.userLabels?.['hypervibe-replica'] !== name) {
        throw new Error(`Refusing to delete ${replicaBinding.externalId}: its primary or Hypervibe ownership label does not match the reviewed replica.`);
      }
      if (replicaBinding.region && replica.region !== replicaBinding.region) {
        throw new Error(`Refusing to delete ${replicaBinding.externalId}: it is in region ${replica.region ?? 'unknown'}, not bound region ${replicaBinding.region}.`);
      }
      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${this.credentials.projectId}/instances/${encodeURIComponent(replicaBinding.externalId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.status !== 404) {
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Cloud SQL replica delete failed: ${response.status} ${body}`);
        }
        const operation = await response.json() as CloudSqlOperation;
        if (operation.name) await this.waitForOperation(token, operation.name, 'read replica delete');
      }
      const attempts = Number(process.env.HYPERVIBE_CLOUDSQL_DELETE_ATTEMPTS ?? 60);
      const delayMs = Number(process.env.HYPERVIBE_CLOUDSQL_DELETE_DELAY_MS ?? 1000);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!await this.getInstance(replicaBinding.externalId)) {
          return { success: true, message: `Deleted Cloud SQL read replica "${name}" (${replicaBinding.externalId})` };
        }
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        success: false,
        message: `Cloud SQL accepted deletion of read replica "${name}" but it is still present`,
        error: `Replica ${replicaBinding.externalId} remained observable after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete Cloud SQL read replica "${name}"`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Helper methods

  private componentInstanceName(component: Component): string | undefined {
    const bindings = component.bindings as Record<string, unknown>;
    return component.externalId
      ?? (typeof bindings.instanceId === 'string' && bindings.instanceId.length > 0
        ? bindings.instanceId
        : undefined);
  }

  private instanceProviderScope(instance: CloudSqlInstance): Record<string, string> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return {
      projectId: this.credentials.projectId,
      ...(instance.region ? { region: instance.region } : {}),
    };
  }

  private inspectedDatabase(instance: CloudSqlInstance): Record<string, unknown> {
    return {
      id: instance.name,
      name: instance.name,
      engine: instance.databaseVersion.startsWith('POSTGRES')
        ? 'postgres'
        : instance.databaseVersion.toLowerCase(),
      databaseVersion: instance.databaseVersion,
      status: this.normalizedInstanceStatus(instance.state),
      state: instance.state,
      ...(instance.region ? { region: instance.region } : {}),
      ...(instance.connectionName ? { connectionName: instance.connectionName } : {}),
      ...(instance.masterInstanceName ? { primaryId: instance.masterInstanceName } : {}),
      providerScope: this.instanceProviderScope(instance),
    };
  }

  private assertComponentScope(component: Component, instance?: CloudSqlInstance): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    const instanceName = this.componentInstanceName(component);
    const projectId = typeof scope?.projectId === 'string' && scope.projectId.trim().length > 0
      ? scope.projectId
      : undefined;
    if (instanceName && !projectId) {
      throw new Error(
        `Cloud SQL binding ${instanceName} is missing its durable GCP project scope; re-import or re-plan the database before using it.`
      );
    }
    if (projectId && projectId !== this.credentials.projectId) {
      throw new Error(`Cloud SQL binding belongs to project ${projectId}, not connected project ${this.credentials.projectId}.`);
    }
    if (instance && typeof scope?.region === 'string' && instance.region !== scope.region) {
      throw new Error(`Cloud SQL instance ${instance.name} is in region ${instance.region ?? 'unknown'}, not bound region ${scope.region}.`);
    }
  }

  private assertConnectionNameScope(
    connectionName: string,
    instanceName: string | undefined,
    component: Component
  ): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const parts = connectionName.split(':');
    if (
      parts.length !== 3
      || parts[0] !== this.credentials.projectId
      || (instanceName !== undefined && parts[2] !== instanceName)
    ) {
      throw new Error(
        `Cloud SQL connection name ${connectionName} does not match connected project ${this.credentials.projectId}${instanceName ? ` and bound instance ${instanceName}` : ''}.`
      );
    }
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    if (typeof scope?.region === 'string' && parts[1] !== scope.region) {
      throw new Error(
        `Cloud SQL connection name ${connectionName} is in region ${parts[1]}, not bound region ${scope.region}.`
      );
    }
  }

  private async observeResilience(
    primary: CloudSqlInstance,
    component?: Component | null
  ): Promise<NonNullable<ObservedDatabase['resilience']>> {
    const bindings = component?.bindings as Record<string, unknown> | undefined;
    const resilience = bindings?.resilience && typeof bindings.resilience === 'object' && !Array.isArray(bindings.resilience)
      ? bindings.resilience as Record<string, unknown>
      : {};
    const boundReplicas = resilience.replicas && typeof resilience.replicas === 'object' && !Array.isArray(resilience.replicas)
      ? resilience.replicas as Record<string, Record<string, unknown>>
      : {};
    const boundNameByExternalId = new Map(
      Object.entries(boundReplicas).flatMap(([name, binding]) =>
        typeof binding.externalId === 'string' ? [[binding.externalId, name] as const] : []
      )
    );
    const replicas = [] as NonNullable<NonNullable<ObservedDatabase['resilience']>['replicas']>;
    for (const replicaName of primary.replicaNames ?? []) {
      const replica = await this.getInstance(replicaName);
      if (!replica) {
        throw new Error(`Cloud SQL listed read replica ${replicaName}, but its exact identity could not be observed.`);
      }
      const logicalName = replica.settings?.userLabels?.['hypervibe-replica']
        ?? boundNameByExternalId.get(replica.name);
      replicas.push({
        ...(logicalName ? { name: logicalName } : {}),
        externalId: replica.name,
        status: this.normalizedInstanceStatus(replica.state),
        ...(replica.region ? { region: replica.region } : {}),
        ...(replica.settings?.tier ? { tier: replica.settings.tier } : {}),
        ...(this.instanceConnectionName(replica) ? { connectionName: this.instanceConnectionName(replica) } : {}),
      });
    }
    const backup = primary.settings?.backupConfiguration;
    const availability = primary.settings?.availabilityType === 'REGIONAL'
      ? 'regional'
      : primary.settings?.availabilityType === 'ZONAL'
        ? 'zonal'
        : 'unknown';
    return {
      availability,
      backupPolicy: {
        enabled: backup?.enabled === true,
        pitrEnabled: backup?.pointInTimeRecoveryEnabled === true,
        ...(typeof backup?.backupRetentionSettings?.retainedBackups === 'number'
          ? { retainedBackups: backup.backupRetentionSettings.retainedBackups }
          : {}),
        ...(typeof backup?.transactionLogRetentionDays === 'number'
          ? { pitrRetentionDays: backup.transactionLogRetentionDays }
          : {}),
      },
      replicas,
    };
  }

  private async patchInstance(params: {
    token: string;
    instanceName: string;
    body: Record<string, unknown>;
    description: string;
  }): Promise<void> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${this.credentials.projectId}/instances/${encodeURIComponent(params.instanceName)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params.body),
      }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL ${params.description} failed: ${response.status} ${body}`);
    }
    const operation = await response.json() as CloudSqlOperation;
    if (operation.name) await this.waitForOperation(params.token, operation.name, params.description);
  }

  private isReplicaOf(instance: CloudSqlInstance, primaryName: string): boolean {
    const master = instance.masterInstanceName ?? '';
    return master === primaryName || master.endsWith(`:${primaryName}`) || master.endsWith(`/instances/${primaryName}`);
  }

  private instanceConnectionName(instance: CloudSqlInstance): string | undefined {
    if (instance.connectionName) return instance.connectionName;
    if (!this.credentials || !instance.region || !instance.name) return undefined;
    return `${this.credentials.projectId}:${instance.region}:${instance.name}`;
  }

  private replicaBinding(component: Component, instance: CloudSqlInstance): DatabaseReplicaBinding {
    const bindings = component.bindings as Record<string, unknown>;
    const username = typeof bindings.username === 'string' ? bindings.username : undefined;
    const password = typeof bindings.password === 'string' ? bindings.password : undefined;
    const database = typeof bindings.database === 'string' ? bindings.database : undefined;
    const port = typeof bindings.port === 'number' || typeof bindings.port === 'string'
      ? String(bindings.port)
      : '5432';
    const publicIp = instance.ipAddresses?.find((address) => address.type === 'PRIMARY')?.ipAddress;
    const connectionUrl = username && password && database && publicIp
      ? `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${publicIp}:${port}/${encodeURIComponent(database)}`
      : undefined;
    return {
      externalId: instance.name,
      ...(instance.region ? { region: instance.region } : {}),
      ...(instance.settings?.tier ? { tier: instance.settings.tier } : {}),
      ...(this.instanceConnectionName(instance) ? { connectionName: this.instanceConnectionName(instance) } : {}),
      ...(connectionUrl ? { connectionUrl } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountCreds) {
      throw new Error('No service account credentials');
    }

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

  private async getInstance(instanceName: string): Promise<CloudSqlInstance | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const token = await this.getAccessToken();
    const { projectId } = this.credentials;

    const response = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(instanceName)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cloud SQL API error: ${response.status} ${text}`);
    }

    const instance = (await response.json()) as CloudSqlInstance;
    if (!instance.name || instance.name !== instanceName) {
      throw new Error(
        `Cloud SQL exact lookup for ${instanceName} returned ${instance.name || 'an instance without an identity'}.`
      );
    }
    return instance;
  }

  private async recoverInstanceAfterCreateAttempt(
    instanceName: string
  ): Promise<CloudSqlInstance | null> {
    const attempts = Math.max(
      1,
      Number(process.env.HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_ATTEMPTS ?? 3) || 3
    );
    const delayMs = Math.max(
      0,
      Number(process.env.HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_DELAY_MS ?? 1000) || 0
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const instance = await this.getInstance(instanceName);
      if (instance) return instance;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private isBackupResourceName(name: string): boolean {
    if (!this.credentials) return false;
    const prefix = `projects/${this.credentials.projectId}/backups/`;
    return name.startsWith(prefix) && name.length > prefix.length && !name.slice(prefix.length).includes('/');
  }

  private async getBackup(name: string): Promise<CloudSqlBackup | null> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (!this.isBackupResourceName(name)) {
      throw new Error(`Cloud SQL backup id must be scoped as projects/${this.credentials.projectId}/backups/{backup}.`);
    }
    const token = await this.getAccessToken();
    const response = await fetch(`https://sqladmin.googleapis.com/v1/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud SQL backup lookup failed: ${response.status} ${body}`);
    }
    return await response.json() as CloudSqlBackup;
  }

  private inspectedBackup(backup: CloudSqlBackup): Record<string, unknown> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return {
      id: backup.name,
      name: this.lastPathSegment(backup.name),
      providerScope: { projectId: this.credentials.projectId },
      sourceInstance: backup.sourceInstance ?? null,
      type: backup.type ?? null,
      backupKind: backup.backupKind ?? null,
      state: backup.state ?? null,
      databaseVersion: backup.databaseVersion ?? null,
      location: backup.location ?? null,
      instanceDeletionTime: backup.instanceDeletionTime ?? null,
      expiryTime: backup.expiryTime ?? null,
      ttlDays: backup.ttlDays ?? null,
      maxChargeableBytes: backup.maxChargeableBytes ?? null,
      cleanupSupported: Boolean(backup.instanceDeletionTime),
    };
  }

  private lastPathSegment(value: string): string {
    return value.split('/').filter(Boolean).at(-1) ?? value;
  }

  private normalizedInstanceStatus(
    state?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown'> = {
      RUNNABLE: 'running',
      PENDING_CREATE: 'provisioning',
      MAINTENANCE: 'running',
      FAILED: 'error',
      SUSPENDED: 'stopped',
      PENDING_DELETE: 'stopped',
    };
    return statusMap[state ?? ''] ?? 'unknown';
  }

  private async ensureDatabaseByName(params: {
    token: string;
    instanceName: string;
    databaseName: string;
  }): Promise<boolean> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    const encodedInstance = encodeURIComponent(params.instanceName);
    const encodedDatabase = encodeURIComponent(params.databaseName);
    const existing = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${encodedInstance}/databases/${encodedDatabase}`,
      {
        headers: { Authorization: `Bearer ${params.token}` },
      }
    );

    if (existing.ok) {
      return false;
    }
    if (existing.status !== 404) {
      const text = await existing.text();
      throw new Error(`Cloud SQL database lookup failed: ${existing.status} ${text}`);
    }

    const created = await fetch(
      `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${encodedInstance}/databases`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: params.databaseName }),
      }
    );

    if (!created.ok) {
      const text = await created.text();
      if (created.status === 409 || /alreadyExists|already exists/i.test(text)) {
        return false;
      }
      throw new Error(`Cloud SQL database creation failed: ${created.status} ${text}`);
    }

    const operation = await created.json() as CloudSqlOperation;
    if (operation.name) {
      await this.waitForOperation(params.token, operation.name, 'database create');
    }
    return true;
  }

  private async waitForOperation(token: string, operationName: string, description: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const { projectId } = this.credentials;
    const operationUrl = operationName.includes('/operations/')
      ? `https://sqladmin.googleapis.com/v1/${operationName}`
      : `https://sqladmin.googleapis.com/v1/projects/${projectId}/operations/${encodeURIComponent(operationName)}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(
        operationUrl,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud SQL ${description} operation lookup failed: ${response.status} ${text}`);
      }

      const operation = await response.json() as CloudSqlOperation;
      const status = (operation.status ?? '').toUpperCase();
      if (status === 'DONE') {
        if (operation.error?.errors?.length) {
          throw new Error(`Cloud SQL ${description} operation failed: ${operation.error.errors.map((entry) => entry.message ?? entry.code ?? 'unknown').join('; ')}`);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Cloud SQL ${description} operation did not finish before timeout`);
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-=?';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudsql',
    displayName: 'GCP Cloud SQL',
    category: 'database',
    credentialsSchema: CloudSqlCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    maturity: {
      lifecycle: {
        database: { status: 'ready-for-live' },
      },
    },
    lifecycle: {
      databaseEngines: ['postgres'],
      databaseConnectivity: { compatibleHostingProviders: ['cloudrun'] },
      databaseResilience: {
        availabilityModes: ['zonal', 'regional'],
        backups: { maxRetainedBackups: 365, maxPitrRetentionDays: 7 },
        readReplicas: true,
        restoreDrills: true,
      },
    },
    orchestration: {
      databaseRestoreDrill: {
        buildWorkflow: buildCloudSqlRestoreDrillWorkflow,
      },
    },
  },
  inspection: {
    resources: ['database', 'backup'],
    defaultResource: 'database',
    selectors: {
      database: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['projectId'],
      },
      backup: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['projectId'],
        collectionKey: 'backups',
      },
    },
    inspect: (adapter, request) => request.resource === 'backup'
      ? (adapter as CloudSqlAdapter).inspectBackupResources(request)
      : (adapter as CloudSqlAdapter).inspectDatabaseResources(request),
  },
  retainedCleanup: {
    resources: ['backup'],
    destroy: (adapter, target) => (adapter as CloudSqlAdapter).destroyRetainedBackup(target),
  },
  databaseRuntime: {
    project: projectCloudSqlDatabaseRuntime,
  },
  factory: async (credentials) => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
});
