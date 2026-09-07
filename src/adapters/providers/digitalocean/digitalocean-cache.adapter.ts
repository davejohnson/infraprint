import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  CacheCapabilities,
  CacheEngine,
  CacheProvisionResult,
  CacheTargetOptions,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  createUnresolvedDatastoreMutation,
  databaseCreateMayHaveCommitted,
  parseUnresolvedDatastoreMutation,
} from '../../../domain/ports/database.port.js';
import {
  DigitalOceanClient,
  type DigitalOceanConnection,
  type DigitalOceanDatabaseCluster,
} from './digitalocean.client.js';
import {
  parseDigitalOceanRuntimeCredentials,
  type DigitalOceanRuntimeCredentials,
} from './digitalocean.credentials.js';

export class DigitalOceanCacheAdapter implements ICacheAdapter {
  readonly name = 'digitalocean';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
  };

  private client: DigitalOceanClient | null;
  private credentials: DigitalOceanRuntimeCredentials | null;

  constructor(
    client?: DigitalOceanClient,
    credentials?: DigitalOceanRuntimeCredentials
  ) {
    this.client = client ?? null;
    this.credentials = credentials ?? null;
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = parseDigitalOceanRuntimeCredentials(credentials);
    this.client = new DigitalOceanClient(this.credentials.apiToken);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.verifyDatabaseAccess();
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.credentials = null;
  }

  configureTarget(target: CacheTargetOptions): void {
    this.assertSupportedTarget(target);
  }

  async provision(
    engine: CacheEngine,
    environment: Environment,
    options?: CacheTargetOptions & {
      resourceName?: string;
      component?: Component | null;
    }
  ): Promise<CacheProvisionResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    this.assertSupportedTarget(options);
    if (engine !== 'redis') {
      return {
        component: this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: `DigitalOcean cache adapter supports Redis-compatible Valkey. Requested engine: ${engine}`,
        },
      };
    }

    if (options?.component) {
      return this.reconcileBoundCache(environment, options.component, options);
    }

    const resourceName = options?.resourceName ?? `${environment.name}-redis`;
    const requestedRegion = this.nonEmptyString(options?.region) ?? this.credentials.region;
    let created: DigitalOceanDatabaseCluster | undefined;
    let accountUuid: string | undefined;
    let mutationAttempted = false;
    try {
      let matches: DigitalOceanDatabaseCluster[];
      try {
        matches = await this.client.findDatabaseClustersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether DigitalOcean Valkey cluster "${resourceName}" already exists, so Hypervibe refused to create a cluster that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `DigitalOcean database cluster "${resourceName}" already exists: ${matches
            .map((cluster) => `${cluster.name} (${cluster.id}, ${cluster.engine})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended cluster or remove the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      // Resolve account scope before the billable create so any recoverable
      // partial component has a durable, deletion-safe identity.
      accountUuid = await this.client.getAccountUuid();
      const desiredSize = options?.size ?? this.credentials.databaseSize;
      mutationAttempted = true;
      const acknowledged = await this.client.createDatabaseCluster({
        name: resourceName,
        engine: 'valkey',
        version: this.credentials.valkeyVersion,
        region: requestedRegion,
        size: desiredSize,
      });
      this.assertCreatedClusterIdentity(acknowledged, resourceName, requestedRegion);
      created = acknowledged;
      const online = await this.client.waitForDatabaseConfiguration(created.id, {
        region: requestedRegion,
        size: desiredSize,
      });
      this.assertCreatedClusterIdentity(online, resourceName, requestedRegion);
      const connectionUrl = this.connectionUrl(online.connection);
      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'redis',
        bindings: {
          provider: 'digitalocean',
          instanceId: online.id,
          providerScope: {
            accountUuid,
            ...(online.region ? { region: online.region } : {}),
          },
          engine: online.engine,
          connectionString: connectionUrl,
          connectionUrl,
          region: online.region,
          size: online.size,
        },
        externalId: online.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created DigitalOcean Valkey cluster: ${online.name}`,
          data: {
            clusterId: online.id,
            engine: online.engine,
            region: online.region,
            size: online.size,
            status: online.status,
            ready: true,
          },
        },
      };
    } catch (error) {
      let recoveryError: string | undefined;
      const mayHaveCommitted = mutationAttempted
        && !created
        && databaseCreateMayHaveCommitted(error);
      if (mayHaveCommitted) {
        try {
          created = await this.recoverCreatedClusterByName(resourceName, requestedRegion);
        } catch (recoveryFailure) {
          recoveryError = this.formatError(recoveryFailure);
        }
      }
      return {
        component: created
          ? this.partialComponent(environment, created, accountUuid, requestedRegion)
          : mayHaveCommitted && accountUuid
            ? this.unresolvedCreateComponent(
                environment,
                resourceName,
                accountUuid,
                requestedRegion
              )
            : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: created
            ? 'DigitalOcean created the Valkey cluster, but provisioning did not complete'
            : 'Failed to provision DigitalOcean Valkey cluster',
          error: this.formatError(error),
          data: {
            mutationAttempted,
            resourceCreated: created ? true : mayHaveCommitted ? 'unknown' : false,
            ...(created ? {
              clusterId: created.id,
              engine: created.engine,
              region: created.region,
              status: created.status,
            } : {}),
            ...(recoveryError ? { recoveryError } : {}),
          },
        },
      };
    }
  }

  /** Recover a durable id when the POST may have committed before its response was lost. */
  private async recoverCreatedClusterByName(
    resourceName: string,
    requestedRegion: string
  ): Promise<DigitalOceanDatabaseCluster | undefined> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const configuredAttempts = Number(
      process.env.HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS ?? 60
    );
    const configuredDelayMs = Number(
      process.env.HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS ?? 5000
    );
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
      ? Math.min(Math.floor(configuredAttempts), 10)
      : 10;
    const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
      ? configuredDelayMs
      : 5000;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const matches = await this.client.findDatabaseClustersByName(resourceName);
        if (matches.length > 1) {
          throw new Error(
            `Multiple DigitalOcean clusters named "${resourceName}" appeared after create: ${matches.map((cluster) => cluster.id).join(', ')}.`
          );
        }
        if (matches.length === 1) {
          const match = matches[0]!;
          this.assertCreatedClusterIdentity(match, resourceName, requestedRegion);
          return match;
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5000)));
      }
    }

    if (lastError) {
      throw new Error(
        `Could not recover the DigitalOcean cluster identity after an uncertain create: ${this.formatError(lastError)}`
      );
    }
    return undefined;
  }

  private async reconcileBoundCache(
    environment: Environment,
    component: Component,
    options: CacheTargetOptions & { resourceName?: string }
  ): Promise<CacheProvisionResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const clusterId = component.externalId?.trim();
    let accountUuid: string | undefined;
    let live: DigitalOceanDatabaseCluster | null = null;
    let mutationAttempted = false;
    const acknowledgedOperations: Array<'migrate' | 'resize'> = [];
    const partialRegion = this.nonEmptyString(options.region)
      ?? this.componentRegion(component)
      ?? this.credentials.region;

    try {
      if (!clusterId) {
        throw new Error(
          'The bound DigitalOcean cache component has no exact external ID; inspect and explicitly import the intended cluster before reconciling it.'
        );
      }
      await this.assertComponentScope(component);
      accountUuid = this.componentAccountUuid(component);
      live = await this.client.getDatabaseCluster(clusterId);
      if (!live) {
        throw new Error(
          `The bound DigitalOcean Valkey cluster ${clusterId} is absent. Hypervibe will not create a replacement under an existing durable binding; re-run hv_plan.`
        );
      }
      if (!['valkey', 'redis'].includes(live.engine)) {
        throw new Error(
          `DigitalOcean resource ${live.id} is engine ${live.engine}, not Redis-compatible Valkey.`
        );
      }

      const desiredRegion = options.region;
      const desiredSize = options.size;
      const regionChanged = desiredRegion !== undefined
        && live.region !== desiredRegion;
      const sizeChanged = desiredSize !== undefined
        && live.size !== desiredSize;
      const numNodes = live.num_nodes;
      if (
        sizeChanged
        && (!Number.isInteger(numNodes) || numNodes! < 1 || numNodes! > 3)
      ) {
        throw new Error(
          `DigitalOcean did not return the current node count for bound Valkey cluster ${clusterId}. Resize requires preserving that value, so Hypervibe refused to guess or mutate the cluster.`
        );
      }

      if (regionChanged) {
        mutationAttempted = true;
        await this.client.migrateDatabaseCluster(clusterId, desiredRegion);
        acknowledgedOperations.push('migrate');
        live = await this.client.waitForDatabaseConfiguration(clusterId, {
          region: desiredRegion,
        });
      }

      if (sizeChanged) {
        mutationAttempted = true;
        await this.client.resizeDatabaseCluster(clusterId, {
          size: desiredSize,
          numNodes: numNodes!,
        });
        acknowledgedOperations.push('resize');
        live = await this.client.waitForDatabaseConfiguration(clusterId, {
          ...(desiredRegion ? { region: desiredRegion } : {}),
          size: desiredSize,
        });
      }

      if (live.status?.toLowerCase() !== 'online') {
        live = await this.client.waitForDatabaseConfiguration(clusterId, {
          ...(desiredRegion ? { region: desiredRegion } : {}),
          ...(desiredSize ? { size: desiredSize } : {}),
        });
      }
      const connectionUrl = this.connectionUrl(live.connection);
      const reconciled = this.boundComponent(
        environment,
        component,
        live,
        accountUuid!,
        connectionUrl
      );
      return {
        component: reconciled,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `${acknowledgedOperations.length > 0 ? 'Updated' : 'Verified'} DigitalOcean Valkey cluster: ${live.name}`,
          data: {
            clusterId: live.id,
            engine: live.engine,
            region: live.region,
            size: live.size,
            status: live.status,
            regionChanged,
            sizeChanged,
            ready: true,
          },
        },
      };
    } catch (error) {
      let observationError: string | undefined;
      if (mutationAttempted && clusterId) {
        try {
          live = await this.client.getDatabaseCluster(clusterId);
        } catch (observeError) {
          observationError = this.formatError(observeError);
        }
      }
      return {
        component: mutationAttempted && clusterId
          ? this.partialComponent(
              environment,
              live ?? {
                id: clusterId,
                name: options.resourceName ?? clusterId,
                engine: 'valkey',
              },
              accountUuid,
              partialRegion,
              component.bindings
            )
          : this.emptyComponent(environment, 'redis'),
        receipt: {
          success: false,
          message: mutationAttempted
            ? 'DigitalOcean Valkey reconciliation was attempted, but the reviewed configuration was not proven'
            : 'Failed to reconcile the bound DigitalOcean Valkey cluster',
          error: this.formatError(error),
          data: {
            ...(clusterId ? { clusterId } : {}),
            mutationAttempted,
            acknowledgedOperations,
            ...(live?.status ? { status: live.status } : {}),
            ...(live?.region ? { observedRegion: live.region } : {}),
            ...(live?.size ? { observedSize: live.size } : {}),
            ...(observationError ? { observationError } : {}),
          },
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.client || !component.externalId) {
      return null;
    }
    await this.assertComponentScope(component);
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    if (typeof stored === 'string') {
      return stored;
    }
    const cluster = await this.client.getDatabaseCluster(component.externalId);
    return cluster ? this.connectionUrl(cluster.connection) : null;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    try {
      await this.assertComponentScope(component);
      const result = await this.client.destroyDatabaseCluster(component.externalId);
      return {
        success: true,
        message: result.alreadyAbsent
          ? `DigitalOcean Valkey cluster is already absent: ${component.externalId}`
          : `Deleted DigitalOcean Valkey cluster: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete DigitalOcean Valkey cluster',
        error: this.formatError(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.client || !component.externalId) {
      return { status: 'unknown' };
    }
    try {
      await this.assertComponentScope(component);
      const cluster = await this.client.getDatabaseCluster(component.externalId);
      if (!cluster) {
        return { status: 'stopped', message: 'Cluster is absent' };
      }
      return {
        status: this.normalizedStatus(cluster.status),
        message: cluster.status,
      };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  async observeCache(
    environment: Environment,
    component?: Component | null,
    options?: CacheTargetOptions & { resourceName?: string }
  ): Promise<ObservedCache | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    this.assertSupportedTarget(options);
    if (component) await this.assertComponentScope(component);
    const unresolvedMarker = parseUnresolvedDatastoreMutation(component?.bindings, 'cache');
    const markerRegion = unresolvedMarker?.providerScope.region;
    if (unresolvedMarker && options?.resourceName && options.resourceName !== unresolvedMarker.resourceName) {
      throw new Error('The requested DigitalOcean cache name differs from the unresolved create marker.');
    }
    if (markerRegion && options?.region && options.region !== markerRegion) {
      throw new Error('The requested DigitalOcean cache region differs from the unresolved create marker.');
    }
    let cluster: DigitalOceanDatabaseCluster | null;
    if (component?.externalId) {
      cluster = await this.client.getDatabaseCluster(component.externalId);
    } else {
      const resourceName = unresolvedMarker?.resourceName
        ?? options?.resourceName
        ?? `${environment.name}-redis`;
      const matches = (await this.client.findDatabaseClustersByName(resourceName))
        .filter((candidate) => !markerRegion || candidate.region === markerRegion);
      if (matches.length > 1) {
        throw new Error(
          `Multiple DigitalOcean database clusters match "${resourceName}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      cluster = matches[0] ?? null;
    }
    if (!cluster) {
      return null;
    }
    if (!['valkey', 'redis'].includes(cluster.engine)) {
      throw new Error(
        `DigitalOcean resource ${cluster.id} is engine ${cluster.engine}, not Redis-compatible Valkey.`
      );
    }
    return {
      provider: 'digitalocean',
      engine: 'redis',
      externalId: cluster.id,
      providerScope: {
        accountUuid: await this.client.getAccountUuid(),
        ...(cluster.region ? { region: cluster.region } : {}),
      },
      name: cluster.name,
      status: this.normalizedStatus(cluster.status),
      config: {
        ...(cluster.region ? { region: cluster.region } : {}),
        ...(cluster.size ? { size: cluster.size } : {}),
      },
    };
  }

  private assertSupportedTarget(target?: CacheTargetOptions): void {
    const supplied = (['network', 'subnetwork', 'tier'] as const)
      .filter((field) => target?.[field] !== undefined);
    if (supplied.length > 0) {
      throw new Error(
        `DigitalOcean managed Valkey does not implement declarative cache ${supplied.join(', ')}; remove those fields before planning or apply.`
      );
    }
  }

  private assertCreatedClusterIdentity(
    cluster: DigitalOceanDatabaseCluster,
    resourceName: string,
    requestedRegion: string
  ): void {
    if (!this.nonEmptyString(cluster.id)) {
      throw new Error('DigitalOcean acknowledged Valkey creation without a durable cluster id.');
    }
    if (cluster.name !== resourceName) {
      throw new Error(`DigitalOcean returned cache name ${cluster.name ?? '(missing)'} for requested name ${resourceName}.`);
    }
    if (!['valkey', 'redis'].includes(cluster.engine)) {
      throw new Error(`DigitalOcean resource ${cluster.id} appeared after Valkey create with unexpected engine ${cluster.engine}.`);
    }
    if (cluster.region !== requestedRegion) {
      throw new Error(`DigitalOcean returned cache region ${cluster.region ?? '(missing)'} for requested region ${requestedRegion}.`);
    }
  }

  private emptyComponent(
    environment: Environment,
    engine: CacheEngine
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: engine,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private unresolvedCreateComponent(
    environment: Environment,
    resourceName: string,
    accountUuid: string,
    region: string
  ): Component {
    const providerScope = { accountUuid, region };
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        provider: 'digitalocean',
        providerScope,
        region,
        engine: 'valkey',
        provisioningIncomplete: true,
        unresolvedMutation: createUnresolvedDatastoreMutation(
          'cache',
          resourceName,
          providerScope
        ),
      },
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    cluster: DigitalOceanDatabaseCluster,
    accountUuid?: string,
    fallbackRegion?: string,
    existingBindings?: Component['bindings']
  ): Component {
    const region = this.nonEmptyString(cluster.region)
      ?? this.nonEmptyString(fallbackRegion)
      ?? this.componentRegionFromBindings(existingBindings)
      ?? this.credentials?.region;
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        ...(existingBindings ?? {}),
        provider: 'digitalocean',
        instanceId: cluster.id,
        ...(accountUuid ? {
          providerScope: {
            accountUuid,
            ...(region ? { region } : {}),
          },
        } : {}),
        engine: cluster.engine,
        ...(region ? { region } : {}),
        ...(cluster.size ? { size: cluster.size } : {}),
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private boundComponent(
    environment: Environment,
    existing: Component,
    cluster: DigitalOceanDatabaseCluster,
    accountUuid: string,
    connectionUrl: string
  ): Component {
    const bindings = { ...existing.bindings };
    delete bindings.provisioningIncomplete;
    return {
      id: existing.id,
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        ...bindings,
        provider: 'digitalocean',
        instanceId: cluster.id,
        providerScope: {
          accountUuid,
          ...(cluster.region ? { region: cluster.region } : {}),
        },
        engine: cluster.engine,
        connectionString: connectionUrl,
        connectionUrl,
        ...(cluster.region ? { region: cluster.region } : {}),
        ...(cluster.size ? { size: cluster.size } : {}),
      },
      externalId: cluster.id,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };
  }

  private connectionUrl(connection: DigitalOceanConnection | undefined): string {
    if (connection?.uri) {
      return connection.uri;
    }
    if (
      connection?.host
      && connection.port
      && connection.user
      && connection.password
    ) {
      const protocol = connection.protocol || 'rediss';
      const auth = `${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}`;
      return `${protocol}://${auth}@${connection.host}:${connection.port}`;
    }
    throw new Error('DigitalOcean did not return Valkey connection credentials.');
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const normalized = status?.toLowerCase();
    if (normalized === 'online') return 'running';
    if (['offline', 'stopped'].includes(normalized ?? '')) return 'stopped';
    if (['error', 'failed'].includes(normalized ?? '')) return 'error';
    if (normalized) return 'provisioning';
    return 'unknown';
  }

  private async assertComponentScope(component: Component): Promise<void> {
    if (!this.client) {
      throw new Error('DigitalOcean adapter is not connected.');
    }
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const accountUuid = typeof scope?.accountUuid === 'string'
      ? scope.accountUuid
      : undefined;
    if (!accountUuid) {
      throw new Error(
        `DigitalOcean cache binding ${component.externalId ?? component.id} is missing its durable accountUuid provider scope; re-import or re-plan the cache before using it.`
      );
    }
    const connectedAccountUuid = await this.client.getAccountUuid();
    if (accountUuid !== connectedAccountUuid) {
      throw new Error(
        `DigitalOcean cache binding scope account ${accountUuid} does not match connected account ${connectedAccountUuid}.`
      );
    }
  }

  private componentAccountUuid(component: Component): string | undefined {
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    return typeof scope?.accountUuid === 'string'
      ? scope.accountUuid
      : undefined;
  }

  private componentRegion(component: Component): string | undefined {
    return this.componentRegionFromBindings(component.bindings);
  }

  private componentRegionFromBindings(
    bindings?: Component['bindings']
  ): string | undefined {
    const rawScope = bindings?.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    return this.nonEmptyString(scope?.region)
      ?? this.nonEmptyString(bindings?.region);
  }

  private nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim()
      ? value.trim()
      : undefined;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
