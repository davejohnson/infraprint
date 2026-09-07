import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  DatabaseCapabilities,
  IDatabaseAdapter,
  ProvisionableType,
  ProvisionResult,
} from '../../../domain/ports/database.port.js';
import {
  createUnresolvedDatabaseMutation,
  databaseCreateMayHaveCommitted,
  parseUnresolvedDatabaseMutation,
} from '../../../domain/ports/database.port.js';
import type { ObservedDatabase } from '../../../domain/ports/observe.port.js';
import type {
  Receipt,
  TemporaryDatabaseAccess,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { FlyClient, type FlyPostgresCluster } from './fly.client.js';
import { FlyCredentialsSchema, type FlyCredentials } from './fly.credentials.js';
import {
  FlyWireGuardConnector,
  type FlyWireGuardTunnel,
  type IFlyWireGuardConnector,
} from './fly-wireguard.connector.js';

const POSTGRES_PLANS = new Set(['basic', 'starter', 'launch', 'scale', 'Performance']);

export class FlyDatabaseAdapter implements IDatabaseAdapter {
  readonly name = 'fly';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: true,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: false,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: FlyCredentials | null = null;
  private client: FlyClient | null = null;
  private readonly activeAccess = new Map<string, {
    organizationId: string;
    peerId: string;
    peerName: string;
    peerPublicKey: string;
    tunnel: FlyWireGuardTunnel;
  }>();

  constructor(
    private readonly wireGuardConnector: IFlyWireGuardConnector = new FlyWireGuardConnector()
  ) {}

  async connect(credentials: unknown): Promise<void> {
    this.credentials = FlyCredentialsSchema.parse(credentials);
    this.client = new FlyClient(
      this.credentials.apiToken,
      this.credentials.organizationSlug
    );
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.listPostgresClusters();
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    const cleanupErrors: string[] = [];
    for (const [releaseToken, access] of this.activeAccess) {
      let accessCleanupFailed = false;
      try {
        await access.tunnel.stop();
      } catch {
        accessCleanupFailed = true;
        cleanupErrors.push(`local connector ${releaseToken}`);
      }
      try {
        await this.client?.removeWireGuardPeer(
          access.organizationId,
          access.peerName,
          { id: access.peerId, publicKey: access.peerPublicKey }
        );
      } catch {
        accessCleanupFailed = true;
        cleanupErrors.push(`Fly.io peer ${access.peerName}`);
      }
      if (!accessCleanupFailed) {
        this.activeAccess.delete(releaseToken);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Fly.io database access cleanup failed for: ${cleanupErrors.join(', ')}.`
      );
    }
    this.credentials = null;
    this.client = null;
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
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (type !== 'postgres') {
      return {
        component: this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: `Fly Managed Postgres supports PostgreSQL in this adapter. Requested type: ${type}`,
        },
      };
    }

    const resourceName = options?.resourceName ?? `${environment.name}-postgres`;
    const databaseName = this.postgresIdentifier(options?.databaseName?.trim() || 'app');
    const username = this.postgresIdentifier(`hypervibe_${databaseName}`);
    const plan = options?.size?.trim() || 'basic';
    const region = options?.region?.trim() || 'iad';
    if (!POSTGRES_PLANS.has(plan)) {
      return {
        component: this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: 'Failed to provision Fly Managed Postgres cluster',
          error: `Fly Managed Postgres plan "${plan}" is invalid. Expected one of: ${Array.from(POSTGRES_PLANS).join(', ')}.`,
        },
      };
    }

    let created: FlyPostgresCluster | undefined;
    let acknowledgedForRetention: FlyPostgresCluster | undefined;
    let createMutationAttempted = false;
    let unresolvedCreateOutcome = false;
    try {
      let matches: FlyPostgresCluster[];
      try {
        matches = (await this.client.listPostgresClusters())
          .filter((cluster) => cluster.name === resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether Fly Managed Postgres cluster "${resourceName}" already exists, so Hypervibe refused to create a cluster that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `Fly Managed Postgres cluster "${resourceName}" already exists: ${matches
            .map((cluster) => `${cluster.name} (${cluster.id}, ${cluster.region ?? 'unknown region'})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended cluster or remove the conflict, then run hv_plan again.',
        ].join(' '));
      }

      createMutationAttempted = true;
      let acknowledged: FlyPostgresCluster;
      try {
        acknowledged = await this.client.createPostgresCluster({
          name: resourceName,
          region,
          plan,
          diskSizeGb: 10,
        });
      } catch (error) {
        unresolvedCreateOutcome = databaseCreateMayHaveCommitted(error);
        throw error;
      }
      acknowledgedForRetention = acknowledged;
      unresolvedCreateOutcome = false;
      this.assertClusterScope(acknowledged);
      if (acknowledged.name !== resourceName) {
        throw new Error(
          `Fly.io acknowledged creation of ${resourceName} with a different cluster identity (${acknowledged.name || 'unnamed'} / ${acknowledged.id}); refusing to claim or delete it.`
        );
      }
      created = acknowledged;
      const ready = await this.client.waitForPostgresReady(created.id);
      this.assertClusterScope(ready);
      if (
        ready.name !== resourceName
        || ready.region !== region
        || ready.plan !== plan
      ) {
        throw new Error(
          `Fly.io Managed Postgres cluster ${ready.id} did not converge to the requested identity and placement (name ${resourceName}, region ${region}, plan ${plan}).`
        );
      }
      await this.client.ensurePostgresDatabase(ready.id, databaseName);
      await this.client.ensurePostgresUser(ready.id, username);
      const credentials = await this.client.getPostgresUserCredentials(
        ready.id,
        username
      );
      const directUrl = this.connectionUrl(
        ready.endpoints?.primary?.direct,
        credentials,
        databaseName
      );
      const pooledUrl = this.connectionUrl(
        ready.endpoints?.primary?.pooler,
        credentials,
        databaseName
      );
      const parsed = new URL(directUrl);
      const component = this.component(
        environment,
        ready,
        databaseName,
        directUrl,
        pooledUrl,
        credentials
      );

      return {
        component,
        connectionUrl: pooledUrl,
        envVars: {
          DATABASE_URL: pooledUrl,
          DIRECT_URL: directUrl,
          DATABASE_SSL: 'true',
          PGHOST: parsed.hostname,
          PGPORT: parsed.port || '5432',
          PGUSER: credentials.username,
          PGPASSWORD: credentials.password,
          PGDATABASE: databaseName,
        },
        receipt: {
          success: true,
          message: `Created Fly Managed Postgres cluster: ${ready.name}`,
          data: {
            clusterId: ready.id,
            organizationSlug: this.credentials.organizationSlug,
            region: ready.region,
            plan: ready.plan,
            status: ready.status,
            databaseName,
            ready: true,
          },
        },
      };
    } catch (error) {
      let recoveryError: string | undefined;
      if (!created && !acknowledgedForRetention && unresolvedCreateOutcome) {
        try {
          created = await this.recoverCreatedCluster(resourceName) ?? undefined;
        } catch (recoveryFailure) {
          recoveryError = this.formatError(recoveryFailure);
        }
      }
      let rolledBack = false;
      let rollbackError: string | undefined;
      if (created) {
        try {
          await this.client.destroyPostgresCluster(created.id);
          rolledBack = true;
        } catch (cleanupError) {
          rollbackError = this.formatError(cleanupError);
        }
      }
      const retained = created ?? acknowledgedForRetention;
      const unresolvedComponent = !retained && unresolvedCreateOutcome
        ? this.unresolvedCreateComponent(environment, resourceName, region, plan, databaseName)
        : undefined;
      return {
        component: retained && !rolledBack
          ? this.partialComponent(environment, retained, databaseName)
          : unresolvedComponent ?? this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: retained
            ? rolledBack
              ? 'Fly.io Managed Postgres provisioning failed and the partial cluster was removed'
              : 'Fly.io created the Managed Postgres cluster, but provisioning and rollback did not complete'
            : 'Failed to provision Fly Managed Postgres cluster',
          error: `${this.formatError(error)}${recoveryError
            ? ` Exact-name recovery also failed: ${recoveryError}`
            : ''}${rollbackError
            ? ` Cleanup also failed: ${rollbackError}`
            : ''}`,
          ...(retained ? {
            data: {
              clusterId: retained.id,
              organizationSlug: retained.organization?.slug
                ?? this.credentials.organizationSlug,
              region: retained.region,
              plan: retained.plan,
              status: retained.status,
              rolledBack,
              cleanupRequired: !rolledBack,
            },
          } : unresolvedComponent ? {
            data: {
              mutationAttempted: createMutationAttempted,
              resourceCreated: 'unknown',
              unresolvedCreateRetained: true,
            },
          } : {}),
        },
      };
    }
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    let cluster: FlyPostgresCluster | null;
    let observedByScopedList = false;
    if (component?.externalId) {
      this.assertComponentScope(component);
      cluster = await this.client.getPostgresCluster(component.externalId);
    } else {
      observedByScopedList = true;
      const unresolved = parseUnresolvedDatabaseMutation(component?.bindings);
      if (unresolved
        && unresolved.providerScope.organizationSlug !== this.credentials?.organizationSlug) {
        throw new Error(
          `Fly unresolved database create belongs to organization ${unresolved.providerScope.organizationSlug}, not connected organization ${this.credentials?.organizationSlug}.`
        );
      }
      const resourceName = unresolved?.resourceName
        ?? options?.resourceName
        ?? `${environment.name}-postgres`;
      const matches = (await this.client.listPostgresClusters())
        .filter((candidate) => candidate.name === resourceName);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Fly Managed Postgres clusters match "${resourceName}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      cluster = matches[0] ?? null;
    }
    if (!cluster) return null;
    if (!observedByScopedList) this.assertClusterScope(cluster);
    return {
      provider: this.name,
      engine: 'postgres',
      externalId: cluster.id,
      providerScope: { organizationSlug: this.credentials!.organizationSlug },
      name: cluster.name,
      status: this.normalizedStatus(cluster.status),
    };
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.client || !component.externalId) return null;
    this.assertComponentScope(component);
    const stored = component.bindings.connectionString;
    if (typeof stored === 'string' && stored) return stored;
    const cluster = await this.client.getPostgresCluster(component.externalId);
    if (!cluster) return null;
    this.assertClusterScope(cluster);
    const database = typeof component.bindings.database === 'string'
      ? component.bindings.database
      : 'app';
    const username = typeof component.bindings.username === 'string'
      ? component.bindings.username
      : this.postgresIdentifier(`hypervibe_${database}`);
    const credentials = await this.client.getPostgresUserCredentials(
      cluster.id,
      username
    );
    return this.connectionUrl(
      cluster.endpoints?.primary?.pooler ?? cluster.endpoints?.primary?.direct,
      credentials,
      database
    );
  }

  async acquireTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.client || !this.credentials || !component.externalId) {
      throw new Error(
        'Fly Managed Postgres access requires a connected adapter and a tracked cluster.'
      );
    }
    if (applicationPort !== 5432) {
      throw new Error(
        `Fly Managed Postgres access requires application port 5432, received ${applicationPort}.`
      );
    }
    this.assertComponentScope(component);
    const cluster = await this.client.getPostgresCluster(component.externalId);
    if (!cluster) {
      throw new Error(
        `Fly Managed Postgres cluster ${component.externalId} is absent.`
      );
    }
    this.assertClusterScope(cluster);
    if (cluster.status !== 'ready') {
      throw new Error(
        `Fly Managed Postgres cluster ${cluster.id} is not ready (status: ${cluster.status ?? 'unknown'}).`
      );
    }
    const remoteEndpoint = cluster.endpoints?.primary?.direct;
    if (!remoteEndpoint?.host || !remoteEndpoint.port) {
      throw new Error(
        `Fly Managed Postgres cluster ${cluster.id} did not report its private direct endpoint.`
      );
    }
    const database = typeof component.bindings.database === 'string'
      ? component.bindings.database
      : 'app';
    const username = typeof component.bindings.username === 'string'
      ? component.bindings.username
      : this.postgresIdentifier(`hypervibe_${database}`);
    const databaseCredentials = await this.client.getPostgresUserCredentials(
      cluster.id,
      username
    );
    const organization = await this.client.getOrganizationIdentity();
    const peerPrefix = this.wireGuardPeerPrefix(component);
    const conflictingPeers = (await this.client.listWireGuardPeers())
      .filter((peer) => peer.name.startsWith(peerPrefix));
    if (conflictingPeers.length > 0) {
      throw new Error([
        `Fly.io organization ${organization.slug} already contains Hypervibe database-access peer(s) for this component: ${conflictingPeers.map((peer) => peer.name).join(', ')}.`,
        'Hypervibe will not delete a possibly active connector or create a duplicate. Remove the stale peer in the Fly.io organization WireGuard dashboard after confirming no database operation is active, then retry.',
      ].join(' '));
    }

    const keyPair = nacl.box.keyPair();
    const localPrivateKey = Buffer.from(keyPair.secretKey).toString('base64');
    const localPublicKey = Buffer.from(keyPair.publicKey).toString('base64');
    const peerName = `${peerPrefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    let tunnel: FlyWireGuardTunnel | undefined;
    let peerCreated = false;
    let observedPeer: { id: string; pubkey: string } | undefined;
    try {
      const peer = await this.client.createWireGuardPeer({
        organizationId: organization.id,
        name: peerName,
        region: cluster.region ?? 'iad',
        publicKey: localPublicKey,
      });
      peerCreated = true;
      const observedPeers = await this.client.listWireGuardPeers();
      const observed = observedPeers.filter((candidate) => candidate.name === peerName);
      if (
        observed.length !== 1
        || observed[0]!.pubkey !== localPublicKey
        || observed[0]!.peerip !== peer.peerip
      ) {
        throw new Error(
          `Fly.io WireGuard peer ${peerName} did not converge to the exact requested identity.`
        );
      }
      observedPeer = observed[0]!;
      tunnel = await this.wireGuardConnector.start({
        localPrivateKey,
        peerIp: peer.peerip,
        endpointIp: peer.endpointip,
        remotePublicKey: peer.pubkey,
        remoteHost: remoteEndpoint.host,
        remotePort: remoteEndpoint.port,
      });
      const connectionUrl = this.connectionUrl(
        { host: '127.0.0.1', port: tunnel.port },
        databaseCredentials,
        database
      );
      await this.wireGuardConnector.verify(connectionUrl);
      const releaseToken = randomUUID();
      this.activeAccess.set(releaseToken, {
        organizationId: organization.id,
        peerId: observedPeer.id,
        peerName,
        peerPublicKey: observedPeer.pubkey,
        tunnel,
      });
      return {
        connectionUrl,
        source: 'private_connector',
        endpoint: `127.0.0.1:${tunnel.port}`,
        temporary: true,
        releaseToken,
      };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (tunnel) {
        try {
          await tunnel.stop();
        } catch {
          cleanupErrors.push('local connector');
        }
      }
      if (peerCreated) {
        try {
          await this.client.removeWireGuardPeer(
            organization.id,
            peerName,
            {
              id: observedPeer?.id,
              publicKey: localPublicKey,
            }
          );
        } catch {
          cleanupErrors.push(`Fly.io peer ${peerName}`);
        }
      }
      throw new Error(
        `${this.formatError(error)}${cleanupErrors.length > 0
          ? ` Cleanup also failed for ${cleanupErrors.join(' and ')}.`
          : ''}`
      );
    }
  }

  async releaseTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    if (!this.client || !access.releaseToken) {
      throw new Error(
        'Temporary Fly Managed Postgres access is missing its cleanup identity.'
      );
    }
    this.assertComponentScope(component);
    const active = this.activeAccess.get(access.releaseToken);
    if (!active) {
      throw new Error(
        'Temporary Fly Managed Postgres access is not active in this Hypervibe process; refusing an unscoped cleanup.'
      );
    }
    const cleanupErrors: string[] = [];
    try {
      await active.tunnel.stop();
    } catch {
      cleanupErrors.push('local connector');
    }
    try {
      await this.client.removeWireGuardPeer(
        active.organizationId,
        active.peerName,
        { id: active.peerId, publicKey: active.peerPublicKey }
      );
    } catch {
      cleanupErrors.push(`Fly.io peer ${active.peerName}`);
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Temporary Fly Managed Postgres cleanup failed for ${cleanupErrors.join(' and ')}.`
      );
    }
    this.activeAccess.delete(access.releaseToken);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) return { success: false, message: 'Not connected' };
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    try {
      this.assertComponentScope(component);
      const current = await this.client.getPostgresCluster(component.externalId);
      if (current) this.assertClusterScope(current);
      const result = await this.client.destroyPostgresCluster(component.externalId);
      return {
        success: true,
        message: result.alreadyAbsent
          ? `Fly Managed Postgres cluster is already absent: ${component.externalId}`
          : `Deleted Fly Managed Postgres cluster: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Fly Managed Postgres cluster',
        error: this.formatError(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.client || !component.externalId) return { status: 'unknown' };
    try {
      this.assertComponentScope(component);
      const cluster = await this.client.getPostgresCluster(component.externalId);
      if (!cluster) return { status: 'stopped', message: 'Cluster is absent' };
      this.assertClusterScope(cluster);
      return { status: this.normalizedStatus(cluster.status), message: cluster.status };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  private assertClusterScope(cluster: FlyPostgresCluster): void {
    const observed = cluster.organization?.slug;
    if (!observed) {
      throw new Error(
        `Fly Managed Postgres cluster ${cluster.id} did not report its organization scope.`
      );
    }
    if (observed !== this.credentials?.organizationSlug) {
      throw new Error(
        `Fly Managed Postgres cluster ${cluster.id} belongs to organization ${observed}, not connected organization ${this.credentials?.organizationSlug}.`
      );
    }
  }

  private assertComponentScope(component: Component): void {
    const bound = component.bindings.organizationSlug;
    if (typeof bound !== 'string' || !bound) {
      throw new Error(
        `Fly Managed Postgres binding ${component.externalId ?? component.id} is missing its durable organization scope.`
      );
    }
    if (bound !== this.credentials?.organizationSlug) {
      throw new Error(
        `Fly Managed Postgres binding belongs to organization ${bound}, not connected organization ${this.credentials?.organizationSlug}.`
      );
    }
  }

  private emptyComponent(environment: Environment, type: ProvisionableType): Component {
    return {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private unresolvedCreateComponent(
    environment: Environment,
    resourceName: string,
    region: string,
    plan: string,
    database: string
  ): Component {
    const providerScope = {
      organizationSlug: this.credentials!.organizationSlug,
    };
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: this.name,
        providerScope,
        unresolvedMutation: createUnresolvedDatabaseMutation(resourceName, providerScope),
        database,
        region,
        plan,
        organizationSlug: this.credentials!.organizationSlug,
      },
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    cluster: FlyPostgresCluster,
    database: string
  ): Component {
    const observedOrganization = cluster.organization?.slug;
    const organizationSlug = typeof observedOrganization === 'string'
      && observedOrganization.trim()
      ? observedOrganization.trim()
      : this.credentials!.organizationSlug;
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: this.name,
        instanceId: cluster.id,
        providerScope: {
          organizationSlug,
        },
        database,
        region: cluster.region,
        plan: cluster.plan,
        organizationSlug,
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private component(
    environment: Environment,
    cluster: FlyPostgresCluster,
    database: string,
    directUrl: string,
    pooledUrl: string,
    credentials: { username: string; password: string }
  ): Component {
    const parsed = new URL(directUrl);
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: this.name,
        instanceId: cluster.id,
        providerScope: {
          organizationSlug: cluster.organization?.slug
            ?? this.credentials!.organizationSlug,
        },
        connectionString: pooledUrl,
        directUrl,
        pooledUrl,
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        username: credentials.username,
        password: credentials.password,
        database,
        region: cluster.region,
        plan: cluster.plan,
        organizationSlug: this.credentials?.organizationSlug,
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private connectionUrl(
    endpoint: { host?: string; port?: number } | undefined,
    credentials: { username: string; password: string },
    database: string
  ): string {
    if (!endpoint?.host || !endpoint.port) {
      throw new Error('Fly Managed Postgres did not return a usable connection endpoint.');
    }
    return `postgresql://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${endpoint.host}:${endpoint.port}/${encodeURIComponent(database)}?sslmode=require`;
  }

  private async recoverCreatedCluster(
    resourceName: string
  ): Promise<FlyPostgresCluster | null> {
    if (!this.client) throw new Error('Fly.io database adapter is not connected.');
    const attempts = Math.max(
      1,
      Number(process.env.HYPERVIBE_FLY_DATABASE_CREATE_RECOVERY_ATTEMPTS ?? 3) || 3
    );
    const delayMs = Math.max(
      0,
      Number(process.env.HYPERVIBE_FLY_DATABASE_CREATE_RECOVERY_DELAY_MS ?? 1000) || 0
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const matches = (await this.client.listPostgresClusters())
        .filter((cluster) => cluster.name === resourceName);
      if (matches.length > 1) {
        throw new Error(
          `Fly.io returned multiple Managed Postgres clusters named ${resourceName} after an uncertain create; no identity was selected.`
        );
      }
      if (matches.length === 1) {
        this.assertClusterScope(matches[0]!);
        return matches[0]!;
      }
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private wireGuardPeerPrefix(
    component: Component
  ): string {
    const identity = `${this.credentials?.organizationSlug}:${component.externalId}`;
    return `hv-db-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}-`;
  }

  private postgresIdentifier(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
    if (!/^[a-z_][a-z0-9_]*$/.test(normalized)) {
      throw new Error(`Invalid PostgreSQL identifier derived from "${value}".`);
    }
    return normalized;
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    if (status === 'ready') return 'running';
    if (['deleted', 'deleting'].includes(status ?? '')) return 'stopped';
    if (status === 'failed') return 'error';
    if (status) return 'provisioning';
    return 'unknown';
  }

  private formatError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URL]')
      .replace(/("(?:password|token|localPrivateKey)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  }
}
