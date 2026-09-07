import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  CacheCapabilities,
  CacheEngine,
  CacheProvisionResult,
  CacheTargetOptions,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  AzureManagedRedisCredentialsSchema,
  type AzureManagedRedisCredentials,
} from './azure-datastore.credentials.js';
import {
  AzureManagedRedisClient,
  type AzureManagedRedisCluster,
  type AzureManagedRedisDatabase,
} from './azure-managed-redis.client.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';
import {
  azureContainerAppsResourceGroupScopeFromBinding,
  azureEnvironmentResourceGroupScope,
  explicitAzureResourceGroupScope,
  parseAzureResourceGroupScope,
  type AzureEnvironmentResourceGroupScope,
} from './azure-environment-scope.js';

const PROVIDER = 'azure-managed-redis';
const RESOURCE_GROUP_API_VERSION = '2024-11-01';
const DEFAULT_LOCATION = 'canadacentral';
const DEFAULT_SKU = 'Balanced_B0';

interface AzureResourceGroup {
  id: string;
  tags?: Record<string, string>;
}

export class AzureManagedRedisAdapter implements ICacheAdapter {
  readonly name = PROVIDER;

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
  };

  private credentials: AzureManagedRedisCredentials | null = null;
  private arm: AzureResourceManagerClient | null = null;
  private client: AzureManagedRedisClient | null = null;
  private target: CacheTargetOptions | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzureManagedRedisCredentialsSchema.parse(credentials);
    this.arm = new AzureResourceManagerClient(this.credentials);
    this.client = new AzureManagedRedisClient(this.arm);
  }

  configureTarget(target: CacheTargetOptions): void {
    const unsupported = [
      target.network ? 'network' : undefined,
      target.subnetwork ? 'subnetwork' : undefined,
      target.tier ? 'tier' : undefined,
    ].filter((value): value is string => Boolean(value));
    if (unsupported.length > 0) {
      throw new Error(
        `Azure Managed Redis public ACA connectivity does not support desired ${unsupported.join(', ')}. Remove those fields; use region and size only.`
      );
    }
    if (target.projectName !== undefined && target.projectName.trim().length === 0) {
      throw new Error('Azure Managed Redis target projectName cannot be empty.');
    }
    if (target.region !== undefined && !/^[a-z0-9]+$/.test(target.region)) {
      throw new Error('Azure Managed Redis region must be an Azure location slug.');
    }
    if (target.size !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(target.size)) {
      throw new Error('Azure Managed Redis size must be a provider SKU such as Balanced_B0.');
    }
    this.target = {
      ...(target.projectName ? { projectName: target.projectName } : {}),
      ...(target.region ? { region: target.region } : {}),
      ...(target.size ? { size: target.size } : {}),
    };
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.verifyScope();
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.arm = null;
    this.client = null;
    this.target = null;
  }

  async provision(
    engine: CacheEngine,
    environment: Environment,
    options?: CacheTargetOptions & {
      resourceName?: string;
      component?: Component | null;
    }
  ): Promise<CacheProvisionResult> {
    if (!this.client || !this.credentials || !this.arm) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return {
        component: this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: `Azure Managed Redis supports Redis only. Requested engine: ${engine}`,
        },
      };
    }

    let resourceId: string | null = null;
    const resourceName = this.resourceName(options?.resourceName ?? `${environment.name}-redis`);
    let mutationAttempted = false;

    try {
      this.configureTarget({ ...(this.target ?? {}), ...(options ?? {}) });
      const scope = this.environmentScope(environment, true);
      await this.requireOwnedResourceGroup(scope, environment);
      const client = this.scopedClient(scope.resourceGroup);
      const bound = options?.component ?? null;
      if (bound) {
        if (!bound.externalId) {
          throw new Error(
            'The bound Azure Managed Redis component has no exact external ID; inspect and explicitly import the intended cluster before reconciling it.'
          );
        }
        resourceId = bound.externalId;
        this.assertComponentScope(bound, resourceId);
        const existing = await client.getCluster(resourceId);
        if (!existing) {
          throw new Error(
            `The bound Azure Managed Redis cluster ${resourceId} is absent. Hypervibe will not create a replacement under an existing durable binding; re-run hv_plan.`
          );
        }
        const location = this.target?.region ?? existing.location;
        if (existing.location.toLowerCase() !== location.toLowerCase()) {
          throw new Error(
            `Azure Managed Redis cluster ${resourceId} is in ${existing.location}, but desired state selects ${location}. Region is immutable; choose the observed region or explicitly replace the cache.`
          );
        }
        const sku = this.target?.size ?? existing.sku?.name;
        if (!sku) {
          throw new Error(
            `Azure Managed Redis cluster ${resourceId} returned no SKU; refusing an unverified size reconciliation.`
          );
        }
        const sizeChanged = existing.sku?.name !== sku;
        if (sizeChanged) {
          mutationAttempted = true;
          await client.updateCluster(resourceId, { sku: { name: sku } });
        }
        const readyState = (
          existing.properties?.resourceState
          ?? existing.properties?.provisioningState
        )?.toLowerCase();
        const ready = !sizeChanged && ['running', 'succeeded'].includes(readyState ?? '')
          ? existing
          : await this.waitForCluster(client, resourceId, { location, sku });
        const database = await this.assertRuntimeContract(client, ready, { location, sku });
        const host = ready.properties?.hostName!;
        const port = database.properties?.port ?? 10000;
        const storedPassword = typeof bound.bindings.password === 'string'
          && bound.bindings.password.length > 0
          ? bound.bindings.password
          : undefined;
        const storedConnection = await this.getConnectionUrl(bound);
        let password = storedPassword;
        let connectionUrl = storedPassword
          ? this.connectionUrl(host, port, storedPassword)
          : this.validStoredConnectionUrl(storedConnection, host, port)
            ? storedConnection!
            : null;
        if (!connectionUrl) {
          password = await client.listKeys(ready.id);
          connectionUrl = this.connectionUrl(host, port, password);
        }
        const component = this.cacheComponent(
          environment,
          ready,
          database,
          connectionUrl,
          password,
          bound.bindings
        );
        return {
          component,
          connectionUrl,
          envVars: { REDIS_URL: connectionUrl },
          receipt: {
            success: true,
            message: `${sizeChanged ? 'Updated' : 'Verified'} Azure Managed Redis cluster: ${ready.name}`,
            data: {
              clusterId: ready.id,
              location: ready.location,
              state: ready.properties?.resourceState,
              databaseState: database.properties?.resourceState,
              publicNetworkAccess: ready.properties?.publicNetworkAccess,
              clientProtocol: database.properties?.clientProtocol,
              sizeChanged,
              ready: true,
            },
          },
        };
      }

      resourceId = client.clusterResourceId(resourceName);
      let matches: AzureManagedRedisCluster[];
      try {
        matches = await client.findClustersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether Azure Managed Redis cluster "${resourceName}" already exists, so Hypervibe refused to create a cluster that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `Azure Managed Redis cluster "${resourceName}" already exists: ${matches
            .map((cluster) => `${cluster.name} (${cluster.id})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Use hv_import for the intended cluster or remove the conflict, then run hv_plan again.',
        ].join(' '));
      }

      const location = options?.region ?? this.target?.region ?? DEFAULT_LOCATION;
      const sku = options?.size ?? this.target?.size ?? DEFAULT_SKU;
      mutationAttempted = true;
      await client.createCluster(resourceName, {
        location,
        sku: {
          name: sku,
        },
        properties: {
          minimumTlsVersion: '1.2',
          highAvailability: 'Enabled',
          publicNetworkAccess: 'Enabled',
        },
        tags: this.tags(environment),
      });
      const ready = await this.waitForCluster(client, resourceId, { location, sku });
      await client.createDatabase(ready.id);
      const database = await this.waitForDatabase(client, ready.id);
      const key = await client.listKeys(ready.id);
      const host = ready.properties?.hostName;
      const port = database.properties?.port ?? 10000;
      if (!host) {
        throw new Error(
          'Azure Managed Redis did not return a cluster hostname.'
        );
      }
      const connectionUrl = this.connectionUrl(host, port, key);
      const component = this.cacheComponent(
        environment,
        ready,
        database,
        connectionUrl,
        key
      );
      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created Azure Managed Redis cluster: ${ready.name}`,
          data: {
            clusterId: ready.id,
            location: ready.location,
            state: ready.properties?.resourceState,
            databaseState: database.properties?.resourceState,
            publicNetworkAccess: ready.properties?.publicNetworkAccess,
            clientProtocol: database.properties?.clientProtocol,
            ready: true,
          },
        },
      };
    } catch (error) {
      return {
        component: mutationAttempted
          && resourceId
          ? this.partialComponent(environment, resourceId)
          : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: mutationAttempted
            ? 'Azure created or accepted the Managed Redis cluster, but provisioning did not complete'
            : 'Failed to provision Azure Managed Redis cluster',
          error: this.formatError(error),
          ...(mutationAttempted && resourceId
            ? {
                data: {
                  clusterId: resourceId,
                  mutationAttempted: true,
                },
              }
            : {}),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    return typeof stored === 'string' ? stored : null;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    try {
      this.assertComponentScope(component, component.externalId);
      const existing = await this.client.getCluster(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Azure Managed Redis cluster is already absent: ${component.externalId}`,
        };
      }
      await this.client.deleteCluster(component.externalId);
      await this.waitForAbsence(component.externalId);
      return {
        success: true,
        message: `Deleted Azure Managed Redis cluster: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Azure Managed Redis cluster',
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
      const cluster = await this.client.getCluster(component.externalId);
      if (!cluster) {
        return { status: 'stopped', message: 'Cluster is absent' };
      }
      return {
        status: this.normalizedStatus(
          cluster.properties?.resourceState
            ?? cluster.properties?.provisioningState
        ),
        message: cluster.properties?.resourceState
          ?? cluster.properties?.provisioningState,
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
    if (!this.client || !this.arm) {
      throw new Error('Not connected. Call connect() first.');
    }
    this.configureTarget({ ...(this.target ?? {}), ...(options ?? {}) });
    let cluster: AzureManagedRedisCluster | null;
    let client: AzureManagedRedisClient;
    if (component?.externalId) {
      this.assertComponentScope(component, component.externalId);
      client = this.client;
      cluster = await client.getCluster(component.externalId);
    } else {
      const scope = this.environmentScope(environment, false);
      if (!(await this.resourceGroupExists(scope, environment))) return null;
      client = this.scopedClient(scope.resourceGroup);
      const name = this.resourceName(
        options?.resourceName ?? `${environment.name}-redis`
      );
      const matches = await client.findClustersByName(name);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Azure Managed Redis clusters match "${name}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      cluster = matches[0] ?? null;
    }
    if (!cluster) return null;
    // Observation must report configurable drift so the cache planner can
    // authorize the exact update. Only the non-negotiable runtime security
    // contract blocks observation here; provision verifies desired shape.
    await this.assertRuntimeContract(client, cluster, {});
    return {
      provider: PROVIDER,
      engine: 'redis',
      externalId: cluster.id,
      providerScope: this.providerScope(cluster),
      name: cluster.name,
      status: this.normalizedStatus(
        cluster.properties?.resourceState
          ?? cluster.properties?.provisioningState
      ),
      config: {
        region: cluster.location,
        ...(cluster.sku?.name ? { size: cluster.sku.name } : {}),
      },
    };
  }

  async inspectCacheResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.client || !this.credentials || !this.arm) {
      throw new Error('Not connected. Call connect() first.');
    }
    let candidates: AzureManagedRedisCluster[];
    if (request.id) {
      candidates = [await this.client.getCluster(request.id)].filter(
        (cluster): cluster is AzureManagedRedisCluster => Boolean(cluster)
      );
    } else {
      const scope = request.scope
        ? explicitAzureResourceGroupScope(request.scope, this.credentials.subscriptionId)
        : azureContainerAppsResourceGroupScopeFromBinding(
          request.binding,
          this.credentials.subscriptionId
        );
      if (!scope) {
        throw new Error('Azure Managed Redis list/name inspection requires an explicit Azure resource-group scope or compatible Azure Container Apps environment binding.');
      }
      const exists = await this.arm.getNullable<AzureResourceGroup>(
        scope.resourceGroupId,
        RESOURCE_GROUP_API_VERSION
      );
      candidates = exists ? await this.scopedClient(scope.resourceGroup).listClusters() : [];
    }
    const matched = candidates.filter((cluster) => !request.name
      || cluster.name.toLowerCase() === request.name.toLowerCase());
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'cache',
      caches: matched.slice(0, request.limit).map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        engine: 'redis',
        status: cluster.properties?.resourceState
          ?? cluster.properties?.provisioningState
          ?? 'unknown',
        region: cluster.location,
        size: cluster.sku?.name ?? null,
        network: {
          publicNetworkAccess: cluster.properties?.publicNetworkAccess ?? 'unknown',
          minimumTlsVersion: cluster.properties?.minimumTlsVersion ?? 'unknown',
        },
        providerScope: this.providerScope(cluster),
      })),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  private scopedClient(resourceGroup: string): AzureManagedRedisClient {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return new AzureManagedRedisClient(new AzureResourceManagerClient({
      ...this.credentials,
      resourceGroup,
    }));
  }

  private environmentScope(
    environment: Environment,
    requireBound: boolean
  ): AzureEnvironmentResourceGroupScope {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const bindings = parseHostingBindings(environment);
    const boundScope = azureContainerAppsResourceGroupScopeFromBinding(
      bindings,
      this.credentials.subscriptionId
    );
    if (boundScope) return boundScope;
    if (requireBound) {
      throw new Error(
        'Azure Managed Redis provisioning requires the same environment to have a durable Azure Container Apps project binding. Apply the hosting project action, then re-run hv_plan.'
      );
    }
    if (!this.target?.projectName) {
      throw new Error(
        'Azure Managed Redis observation requires an Azure Container Apps project binding or configured logical projectName.'
      );
    }
    return azureEnvironmentResourceGroupScope({
      subscriptionId: this.credentials.subscriptionId,
      projectName: this.target.projectName,
      environmentId: environment.projectId,
      environmentName: environment.name,
    });
  }

  private async resourceGroupExists(
    scope: AzureEnvironmentResourceGroupScope,
    environment: Environment
  ): Promise<boolean> {
    if (!this.arm) throw new Error('Not connected. Call connect() first.');
    const group = await this.arm.getNullable<AzureResourceGroup>(
      scope.resourceGroupId,
      RESOURCE_GROUP_API_VERSION
    );
    if (!group) return false;
    const observed = parseAzureResourceGroupScope(group.id, scope.subscriptionId);
    if (observed.resourceGroup.toLowerCase() !== scope.resourceGroup.toLowerCase()) {
      throw new Error(`Azure returned resource group ${group.id} for ${scope.resourceGroupId}.`);
    }
    if (
      group.tags?.['managed-by'] !== 'hypervibe'
      || group.tags?.['hypervibe-environment-id'] !== environment.id
    ) {
      throw new Error(
        `Azure resource group ${scope.resourceGroupId} exists but is not owned by this Hypervibe environment.`
      );
    }
    return true;
  }

  private async requireOwnedResourceGroup(
    scope: AzureEnvironmentResourceGroupScope,
    environment: Environment
  ): Promise<void> {
    if (!(await this.resourceGroupExists(scope, environment))) {
      throw new Error(
        `Bound Azure Container Apps resource group ${scope.resourceGroupId} is absent; Hypervibe will not create a cache in a replacement scope.`
      );
    }
  }

  private assertComponentScope(component: Component, externalId: string): void {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    if (component.bindings.provider !== PROVIDER) {
      throw new Error('Azure Managed Redis component provider does not match this adapter.');
    }
    const identity = this.client.parseClusterId(externalId);
    const instanceId = component.bindings.instanceId;
    if (typeof instanceId === 'string' && instanceId !== externalId) {
      throw new Error('Azure Managed Redis component instanceId does not match its externalId.');
    }
    const scope = component.bindings.providerScope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      throw new Error(
        'Azure Managed Redis binding is missing its durable subscription/resource-group provider scope; inspect and explicitly import the exact cluster before using it.'
      );
    }
    const record = scope as Record<string, unknown>;
    if (
      typeof record.subscriptionId !== 'string'
      || record.subscriptionId.toLowerCase() !== identity.subscriptionId.toLowerCase()
      || typeof record.resourceGroup !== 'string'
      || record.resourceGroup.toLowerCase() !== identity.resourceGroup.toLowerCase()
    ) {
      throw new Error('Azure Managed Redis durable provider scope does not match its ARM resource ID.');
    }
  }

  private async waitForCluster(
    client: AzureManagedRedisClient,
    resourceId: string,
    desired: { location: string; sku: string }
  ): Promise<AzureManagedRedisCluster> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const cluster = await client.getCluster(resourceId);
      const state = (
        cluster?.properties?.resourceState
        ?? cluster?.properties?.provisioningState
      )?.toLowerCase();
      if (
        cluster
        && ['running', 'succeeded'].includes(state ?? '')
      ) {
        this.assertClusterShape(cluster, desired);
        return cluster;
      }
      if (
        ['failed', 'createfailed', 'deletefailed'].includes(state ?? '')
      ) {
        throw new Error(
          `Azure Managed Redis cluster ${resourceId} entered state ${state}.`
        );
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Managed Redis cluster ${resourceId} did not become ready.`
    );
  }

  private async waitForDatabase(
    client: AzureManagedRedisClient,
    resourceId: string
  ): Promise<AzureManagedRedisDatabase> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const database = await client.getDatabase(resourceId);
      const state = (
        database?.properties?.resourceState
        ?? database?.properties?.provisioningState
      )?.toLowerCase();
      if (
        database
        && ['running', 'succeeded'].includes(state ?? '')
      ) {
        this.assertDatabaseShape(database);
        return database;
      }
      if (
        ['failed', 'createfailed', 'deletefailed'].includes(state ?? '')
      ) {
        throw new Error(
          `Azure Managed Redis database entered state ${state}.`
        );
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Managed Redis database for ${resourceId} did not become ready.`
    );
  }

  private async assertRuntimeContract(
    client: AzureManagedRedisClient,
    cluster: AzureManagedRedisCluster,
    desired: { location?: string; sku?: string }
  ): Promise<AzureManagedRedisDatabase> {
    const state = (
      cluster.properties?.resourceState
      ?? cluster.properties?.provisioningState
    )?.toLowerCase();
    if (!['running', 'succeeded'].includes(state ?? '')) {
      throw new Error(`Azure Managed Redis cluster ${cluster.id} is not Running.`);
    }
    this.assertClusterShape(cluster, desired);
    const database = await client.getDatabase(cluster.id);
    if (!database) {
      throw new Error(`Azure Managed Redis database for ${cluster.id} is absent.`);
    }
    const databaseState = (
      database.properties?.resourceState
      ?? database.properties?.provisioningState
    )?.toLowerCase();
    if (!['running', 'succeeded'].includes(databaseState ?? '')) {
      throw new Error(`Azure Managed Redis database for ${cluster.id} is not Running.`);
    }
    this.assertDatabaseShape(database);
    return database;
  }

  private assertClusterShape(
    cluster: AzureManagedRedisCluster,
    desired: { location?: string; sku?: string }
  ): void {
    if (cluster.properties?.publicNetworkAccess?.toLowerCase() !== 'enabled') {
      throw new Error(
        `Azure Managed Redis cluster ${cluster.id} no longer has publicNetworkAccess Enabled; Hypervibe will not report ACA runtime connectivity as converged.`
      );
    }
    if (cluster.properties?.minimumTlsVersion !== '1.2') {
      throw new Error(
        `Azure Managed Redis cluster ${cluster.id} minimum TLS version is ${cluster.properties?.minimumTlsVersion ?? 'unknown'}, expected 1.2.`
      );
    }
    if (!cluster.properties.hostName) {
      throw new Error(`Azure Managed Redis cluster ${cluster.id} has no observed runtime hostname.`);
    }
    if (desired.sku && cluster.sku?.name !== desired.sku) {
      throw new Error(
        `Azure Managed Redis cluster ${cluster.id} size is ${cluster.sku?.name ?? 'unknown'}, expected ${desired.sku}.`
      );
    }
    if (desired.location && cluster.location.toLowerCase() !== desired.location.toLowerCase()) {
      throw new Error(
        `Azure Managed Redis cluster ${cluster.id} is in ${cluster.location}, expected ${desired.location}.`
      );
    }
  }

  private assertDatabaseShape(database: AzureManagedRedisDatabase): void {
    if (database.properties?.clientProtocol?.toLowerCase() !== 'encrypted') {
      throw new Error('Azure Managed Redis client protocol drifted from Encrypted.');
    }
    if (database.properties.accessKeysAuthentication?.toLowerCase() !== 'enabled') {
      throw new Error('Azure Managed Redis access-key authentication drifted from Enabled.');
    }
    if (database.properties.port !== 10000) {
      throw new Error(
        `Azure Managed Redis encrypted client port is ${database.properties.port ?? 'unknown'}, expected 10000.`
      );
    }
  }

  private async waitForAbsence(resourceId: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_DELETE_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!(await this.client!.getCluster(resourceId))) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Managed Redis cluster ${resourceId} still exists after deletion.`
    );
  }

  private cacheComponent(
    environment: Environment,
    cluster: AzureManagedRedisCluster,
    database: AzureManagedRedisDatabase,
    connectionUrl: string,
    password?: string,
    existingBindings: Record<string, unknown> = {}
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        ...existingBindings,
        provider: PROVIDER,
        instanceId: cluster.id,
        providerScope: this.providerScope(cluster),
        connectionString: connectionUrl,
        connectionUrl,
        host: cluster.properties?.hostName,
        port: database.properties?.port ?? 10000,
        ...(password ? { password } : {}),
        database: 'default',
        region: cluster.location,
        size: cluster.sku?.name,
        publicNetworkAccess: cluster.properties?.publicNetworkAccess,
        minimumTlsVersion: cluster.properties?.minimumTlsVersion,
        clientProtocol: database.properties?.clientProtocol,
        accessKeysAuthentication: database.properties?.accessKeysAuthentication,
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private connectionUrl(host: string, port: number, password: string): string {
    return `rediss://:${encodeURIComponent(password)}@${host}:${port}`;
  }

  private validStoredConnectionUrl(
    value: string | null,
    host: string,
    port: number
  ): boolean {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'rediss:'
        && parsed.hostname.toLowerCase() === host.toLowerCase()
        && Number(parsed.port || 6379) === port;
    } catch {
      return false;
    }
  }

  private partialComponent(
    environment: Environment,
    resourceId: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        provider: PROVIDER,
        instanceId: resourceId,
        providerScope: this.providerScope(resourceId),
        region: this.target?.region ?? DEFAULT_LOCATION,
        size: this.target?.size ?? DEFAULT_SKU,
        publicNetworkAccess: 'Enabled',
        minimumTlsVersion: '1.2',
        clientProtocol: 'Encrypted',
        accessKeysAuthentication: 'Enabled',
      },
      externalId: resourceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
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

  private resourceName(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      .replace(/-$/g, '');
    return normalized || 'hypervibe-redis';
  }

  private providerScope(
    cluster: AzureManagedRedisCluster | string
  ): Record<string, string> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const identity = this.client.parseClusterId(
      typeof cluster === 'string' ? cluster : cluster.id
    );
    return {
      subscriptionId: identity.subscriptionId,
      resourceGroup: identity.resourceGroup,
    };
  }

  private tags(environment: Environment): Record<string, string> {
    return {
      'managed-by': 'hypervibe',
      'hypervibe-environment-id': environment.id,
      'hypervibe-managed': 'true',
      'hypervibe-environment': environment.name.slice(0, 256),
    };
  }

  private normalizedStatus(
    value?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const state = value?.toLowerCase();
    if (['running', 'succeeded'].includes(state ?? '')) return 'running';
    if (['disabled', 'stopped'].includes(state ?? '')) return 'stopped';
    if (
      ['failed', 'createfailed', 'updatefailed', 'deletefailed'].includes(
        state ?? ''
      )
    ) {
      return 'error';
    }
    if (state) return 'provisioning';
    return 'unknown';
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
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: PROVIDER,
    displayName: 'Azure Managed Redis',
    category: 'cache',
    credentialsSchema: AzureManagedRedisCredentialsSchema,
    setupHelpUrl:
      'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    credentials: {
      environmentVariableAliases: [
        ['AZURE_TENANT_ID', 'HYPERVIBE_AZURE_TENANT_ID'],
        ['AZURE_SUBSCRIPTION_ID', 'HYPERVIBE_AZURE_SUBSCRIPTION_ID'],
        ['AZURE_CLIENT_ID', 'HYPERVIBE_AZURE_CLIENT_ID'],
        ['AZURE_CLIENT_SECRET', 'HYPERVIBE_AZURE_CLIENT_SECRET'],
      ],
    },
    connectionAliases: ['azure-container-apps'],
    maturity: {
      lifecycle: {
        cache: {
          status: 'ready-for-live',
          reason: 'Mocked lifecycle contracts pass; promotion requires recent Azure Container Apps plus Managed Redis live evidence.',
        },
      },
    },
    lifecycle: {
      cacheEngines: ['redis'],
      cacheConnectivity: {
        compatibleHostingProviders: ['azure-container-apps'],
      },
    },
  },
  factory: async (credentials) => {
    const validated = AzureManagedRedisCredentialsSchema.parse(credentials);
    const adapter = new AzureManagedRedisAdapter();
    await adapter.connect(validated);
    return adapter;
  },
  inspection: {
    resources: ['cache'],
    defaultResource: 'cache',
    selectors: {
      cache: {
        mode: 'provider-resource',
        optional: ['project', 'id', 'name', 'limit'],
        oneOf: [['id', 'scope']],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['subscriptionId', 'resourceGroup'],
      },
    },
    inspect: (adapter, request) => (
      adapter as AzureManagedRedisAdapter
    ).inspectCacheResources(request),
  },
});
