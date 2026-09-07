import { createHash, randomBytes } from 'crypto';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  DatabaseCapabilities,
  DatabaseTargetOptions,
  IDatabaseAdapter,
  ProvisionableType,
  ProvisionResult,
} from '../../../domain/ports/database.port.js';
import { databaseCreateMayHaveCommitted } from '../../../domain/ports/database.port.js';
import type { ObservedDatabase } from '../../../domain/ports/observe.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { Receipt, TemporaryDatabaseAccess, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  providerRegistry,
  standardDatabaseRuntimeProjection,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  AzurePostgresCredentialsSchema,
  type AzurePostgresCredentials,
} from './azure-datastore.credentials.js';
import {
  AzurePostgresClient,
  type AzurePostgresServer,
} from './azure-postgres.client.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';
import {
  azureContainerAppsResourceGroupScopeFromBinding,
  azureEnvironmentResourceGroupScope,
  explicitAzureResourceGroupScope,
  parseAzureResourceGroupScope,
  type AzureEnvironmentResourceGroupScope,
} from './azure-environment-scope.js';

const PROVIDER = 'azure-postgres';
const ADMIN_USERNAME = 'hypervibeadmin';
const PUBLIC_IP_ENDPOINT = 'https://checkip.amazonaws.com/';
const RESOURCE_GROUP_API_VERSION = '2024-11-01';
const DEFAULT_LOCATION = 'canadacentral';
const POSTGRES_SKU_NAME = 'Standard_B1ms';
const POSTGRES_SKU_TIER = 'Burstable';
const POSTGRES_VERSION = '16';
const POSTGRES_STORAGE_SIZE_GB = 32;

interface AzureResourceGroup {
  id: string;
  tags?: Record<string, string>;
}

export class AzurePostgresAdapter implements IDatabaseAdapter {
  readonly name = PROVIDER;

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: false,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: AzurePostgresCredentials | null = null;
  private arm: AzureResourceManagerClient | null = null;
  private client: AzurePostgresClient | null = null;
  private target: DatabaseTargetOptions | null = null;
  private temporaryFirewallRules = new Map<string, { resourceId: string; ruleName: string }>();

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzurePostgresCredentialsSchema.parse(credentials);
    this.arm = new AzureResourceManagerClient(this.credentials);
    this.client = new AzurePostgresClient(this.arm);
  }

  configureTarget(target: DatabaseTargetOptions): void {
    if (target.projectName !== undefined && target.projectName.trim().length === 0) {
      throw new Error('Azure PostgreSQL target projectName cannot be empty.');
    }
    if (target.region !== undefined && !/^[a-z0-9]+$/.test(target.region)) {
      throw new Error('Azure PostgreSQL region must be an Azure location slug.');
    }
    this.target = {
      ...(target.projectName ? { projectName: target.projectName } : {}),
      ...(target.region ? { region: target.region } : {}),
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
    type: ProvisionableType,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      databaseName?: string;
      resourceName?: string;
    }
  ): Promise<ProvisionResult> {
    if (!this.client || !this.credentials || !this.arm) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (type !== 'postgres') {
      return {
        component: this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: `Azure PostgreSQL supports PostgreSQL only. Requested type: ${type}`,
        },
      };
    }

    let resourceId: string | null = null;
    const resourceName = this.resourceName(options?.resourceName ?? `${environment.name}-postgres`);
    const databaseName = options?.databaseName?.trim() || 'app';
    let createMayHaveCommitted = false;

    try {
      const scope = this.environmentScope(environment, true);
      await this.requireOwnedResourceGroup(scope, environment);
      const client = this.scopedClient(scope.resourceGroup);
      resourceId = client.serverResourceId(resourceName);
      let matches: AzurePostgresServer[];
      try {
        matches = await client.findServersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether Azure PostgreSQL server "${resourceName}" already exists, so Hypervibe refused to create a server that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `Azure PostgreSQL server "${resourceName}" already exists: ${matches
            .map((server) => `${server.name} (${server.id})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Use hv_import for the intended server or remove the conflict, then run hv_plan again.',
        ].join(' '));
      }

      const location = options?.region ?? this.target?.region ?? DEFAULT_LOCATION;
      if (!/^[a-z0-9]+$/.test(location)) {
        throw new Error('Azure PostgreSQL region must be an Azure location slug.');
      }
      const password = this.generatePassword();
      try {
        await client.createServer(resourceName, {
          location,
          sku: {
            name: options?.size ?? POSTGRES_SKU_NAME,
            tier: POSTGRES_SKU_TIER,
          },
          properties: {
            administratorLogin: ADMIN_USERNAME,
            administratorLoginPassword: password,
            version: POSTGRES_VERSION,
            createMode: 'Create',
            storage: {
              storageSizeGB: POSTGRES_STORAGE_SIZE_GB,
              autoGrow: 'Enabled',
            },
            backup: {
              backupRetentionDays: 7,
              geoRedundantBackup: 'Disabled',
            },
            highAvailability: { mode: 'Disabled' },
            network: { publicNetworkAccess: 'Enabled' },
            authConfig: {
              activeDirectoryAuth: 'Disabled',
              passwordAuth: 'Enabled',
            },
          },
          tags: this.tags(environment),
        });
        createMayHaveCommitted = true;
      } catch (error) {
        createMayHaveCommitted = databaseCreateMayHaveCommitted(error);
        throw error;
      }
      const ready = await this.waitForReady(client, resourceId, {
        location,
        skuName: options?.size ?? POSTGRES_SKU_NAME,
      });
      await client.createAzureServicesFirewallRule(ready.id);
      await this.waitForFirewallRule(client, ready.id);
      await client.createDatabase(ready.id, databaseName);
      await this.waitForDatabase(client, ready.id, databaseName);

      const host = ready.properties?.fullyQualifiedDomainName;
      if (!host) {
        throw new Error(
          'Azure PostgreSQL did not return a fully qualified domain name.'
        );
      }
      const connectionUrl = this.connectionUrl(
        host,
        ADMIN_USERNAME,
        password,
        databaseName
      );
      const component = this.component(
        environment,
        ready,
        databaseName,
        connectionUrl,
        password
      );
      return {
        component,
        connectionUrl,
        envVars: {
          DATABASE_URL: connectionUrl,
          DIRECT_URL: connectionUrl,
          DATABASE_SSL: 'true',
          PGHOST: host,
          PGPORT: '5432',
          PGUSER: ADMIN_USERNAME,
          PGPASSWORD: password,
          PGDATABASE: databaseName,
        },
        receipt: {
          success: true,
          message: `Created Azure PostgreSQL Flexible Server: ${ready.name}`,
          data: {
            serverId: ready.id,
            location: ready.location,
            state: ready.properties?.state,
            databaseName,
            azureServicesFirewall: true,
            ready: true,
          },
        },
      };
    } catch (error) {
      return {
        component: createMayHaveCommitted
          && resourceId
          ? this.partialComponent(environment, resourceId, databaseName)
          : this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: createMayHaveCommitted
            ? 'Azure created or accepted the PostgreSQL server, but provisioning did not complete'
            : 'Failed to provision Azure PostgreSQL server',
          error: this.formatError(error),
          ...(createMayHaveCommitted && resourceId
            ? {
                data: {
                  serverId: resourceId,
                  mutationAttempted: true,
                },
              }
            : {}),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString;
    return typeof stored === 'string' ? stored : null;
  }

  async acquireTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    _applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.client || !component.externalId) {
      throw new Error('Azure PostgreSQL access requires a connected adapter and a tracked server.');
    }
    this.assertComponentScope(component, component.externalId);
    const connectionUrl = await this.getConnectionUrl(component);
    if (!connectionUrl) throw new Error('Azure PostgreSQL bindings are missing database credentials.');
    const address = await this.resolvePublicIpv4();
    const ruleName = `hypervibe-operation-${createHash('sha256').update(address).digest('hex').slice(0, 16)}`;
    await this.client.upsertFirewallRule(component.externalId, ruleName, address);
    const releaseToken = `${component.externalId}:${ruleName}`;
    this.temporaryFirewallRules.set(releaseToken, { resourceId: component.externalId, ruleName });
    try {
      await this.waitForOperationFirewallRule(component.externalId, ruleName, address);
    } catch (error) {
      await this.client.deleteFirewallRule(component.externalId, ruleName).catch(() => undefined);
      this.temporaryFirewallRules.delete(releaseToken);
      throw error;
    }
    return {
      connectionUrl,
      source: 'temporary_firewall',
      temporary: true,
      releaseToken,
    };
  }

  async releaseTemporaryDatabaseAccess(
    _environment: Environment,
    _component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    if (!this.client || !access.releaseToken) {
      throw new Error('Temporary Azure PostgreSQL access is missing its cleanup identity.');
    }
    const rule = this.temporaryFirewallRules.get(access.releaseToken);
    if (!rule) return;
    await this.client.deleteFirewallRule(rule.resourceId, rule.ruleName);
    await this.waitForFirewallAbsence(rule.resourceId, rule.ruleName);
    this.temporaryFirewallRules.delete(access.releaseToken);
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
      const existing = await this.client.getServer(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Azure PostgreSQL server is already absent: ${component.externalId}`,
        };
      }
      await this.client.deleteServer(component.externalId);
      await this.waitForAbsence(component.externalId);
      return {
        success: true,
        message: `Deleted Azure PostgreSQL server: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Azure PostgreSQL server',
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
      const server = await this.client.getServer(component.externalId);
      if (!server) {
        return { status: 'stopped', message: 'Server is absent' };
      }
      return {
        status: this.normalizedStatus(server.properties?.state),
        message: server.properties?.state,
      };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (!this.client || !this.arm) {
      throw new Error('Not connected. Call connect() first.');
    }
    let server: AzurePostgresServer | null;
    let client: AzurePostgresClient;
    if (component?.externalId) {
      this.assertComponentScope(component, component.externalId);
      client = this.client;
      server = await client.getServer(component.externalId);
    } else {
      const scope = this.environmentScope(environment, false);
      if (!(await this.resourceGroupExists(scope, environment))) return null;
      client = this.scopedClient(scope.resourceGroup);
      const name = this.resourceName(
        options?.resourceName ?? `${environment.name}-postgres`
      );
      const matches = await client.findServersByName(name);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Azure PostgreSQL servers match "${name}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      server = matches[0] ?? null;
    }
    if (!server) return null;
    const databaseName = typeof component?.bindings.database === 'string'
      ? component.bindings.database
      : 'app';
    await this.assertRuntimeContract(client, server, databaseName, {
      ...(this.target ? { location: this.target.region ?? DEFAULT_LOCATION } : {}),
      skuName: POSTGRES_SKU_NAME,
    });
    return {
      provider: PROVIDER,
      engine: 'postgres',
      externalId: server.id,
      providerScope: this.serverScope(server),
      name: server.name,
      status: this.normalizedStatus(server.properties?.state),
    };
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.client || !this.credentials || !this.arm) {
      throw new Error('Not connected. Call connect() first.');
    }
    let servers: AzurePostgresServer[];
    if (request.id) {
      servers = [await this.client.getServer(request.id)]
        .filter((server): server is AzurePostgresServer => Boolean(server));
    } else {
      const scope = request.scope
        ? explicitAzureResourceGroupScope(request.scope, this.credentials.subscriptionId)
        : azureContainerAppsResourceGroupScopeFromBinding(
          request.binding,
          this.credentials.subscriptionId
        );
      if (!scope) {
        throw new Error('Azure PostgreSQL list/name inspection requires an explicit Azure resource-group scope or compatible Azure Container Apps environment binding.');
      }
      const exists = await this.arm.getNullable<AzureResourceGroup>(
        scope.resourceGroupId,
        RESOURCE_GROUP_API_VERSION
      );
      servers = exists ? await this.scopedClient(scope.resourceGroup).listServers() : [];
    }
    servers = servers.filter((server) => (
        !request.name || server.name.toLowerCase() === request.name.toLowerCase()
      ));
    const databases = servers.slice(0, request.limit).map((server) => ({
      id: server.id,
      name: server.name,
      engine: 'postgres',
      status: this.normalizedStatus(server.properties?.state),
      region: server.location,
      ...(server.properties?.version ? { databaseVersion: server.properties.version } : {}),
      network: {
        publicNetworkAccess: server.properties?.network?.publicNetworkAccess ?? 'unknown',
      },
      providerScope: this.serverScope(server),
    }));
    const ambiguous = Boolean(request.name && servers.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : servers.length > 0 ? 'present' : 'absent',
      resource: 'database',
      databases,
      ...(servers.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: servers.length > request.limit,
      partial: false,
    };
  }

  private scopedClient(resourceGroup: string): AzurePostgresClient {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return new AzurePostgresClient(new AzureResourceManagerClient({
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
        'Azure PostgreSQL provisioning requires the same environment to have a durable Azure Container Apps project binding. Apply the hosting project action, then re-run hv_plan.'
      );
    }
    if (!this.target?.projectName) {
      throw new Error(
        'Azure PostgreSQL observation requires an Azure Container Apps project binding or configured logical projectName.'
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
        `Bound Azure Container Apps resource group ${scope.resourceGroupId} is absent; Hypervibe will not create a datastore in a replacement scope.`
      );
    }
  }

  private assertComponentScope(component: Component, externalId: string): void {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    if (component.bindings.provider !== PROVIDER) {
      throw new Error('Azure PostgreSQL component provider does not match this adapter.');
    }
    const identity = this.client.parseServerId(externalId);
    const instanceId = component.bindings.instanceId;
    if (typeof instanceId === 'string' && instanceId !== externalId) {
      throw new Error('Azure PostgreSQL component instanceId does not match its externalId.');
    }
    const scope = component.bindings.providerScope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      throw new Error(
        'Azure PostgreSQL binding is missing its durable subscription/resource-group provider scope; inspect and explicitly import the exact server before using it.'
      );
    }
    const record = scope as Record<string, unknown>;
    if (
      typeof record.subscriptionId !== 'string'
      || record.subscriptionId.toLowerCase() !== identity.subscriptionId.toLowerCase()
      || typeof record.resourceGroup !== 'string'
      || record.resourceGroup.toLowerCase() !== identity.resourceGroup.toLowerCase()
    ) {
      throw new Error('Azure PostgreSQL durable provider scope does not match its ARM resource ID.');
    }
  }

  private async waitForReady(
    client: AzurePostgresClient,
    resourceId: string,
    desired: { location: string; skuName: string }
  ): Promise<AzurePostgresServer> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const server = await client.getServer(resourceId);
      const state = server?.properties?.state?.toLowerCase();
      if (server && state === 'ready') {
        this.assertServerShape(server, desired);
        return server;
      }
      if (['failed', 'disabled'].includes(state ?? '')) {
        throw new Error(
          `Azure PostgreSQL server ${resourceId} entered state ${state}.`
        );
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL server ${resourceId} did not become Ready.`
    );
  }

  private async waitForDatabase(
    client: AzurePostgresClient,
    resourceId: string,
    databaseName: string
  ): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const database = await client.getDatabase(resourceId, databaseName);
      if (
        database
        && database.properties?.charset?.toUpperCase() === 'UTF8'
        && database.properties?.collation === 'en_US.utf8'
      ) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL database ${databaseName} did not become observable.`
    );
  }

  private async waitForFirewallRule(
    client: AzurePostgresClient,
    resourceId: string
  ): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const rule =
        await client.getAzureServicesFirewallRule(resourceId);
      if (
        rule?.properties?.startIpAddress === '0.0.0.0'
        && rule.properties.endIpAddress === '0.0.0.0'
      ) {
        return;
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL firewall rule for ${resourceId} did not become observable.`
    );
  }

  private async waitForOperationFirewallRule(
    resourceId: string,
    ruleName: string,
    address: string
  ): Promise<void> {
    const attempts = this.positiveIntegerEnv('HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS', 180);
    const interval = this.nonNegativeIntegerEnv('HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS', 5000);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const rule = await this.client!.getFirewallRule(resourceId, ruleName);
      if (rule?.properties?.startIpAddress === address && rule.properties.endIpAddress === address) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(`Azure PostgreSQL operation-scoped firewall rule for ${resourceId} did not become observable.`);
  }

  private async waitForFirewallAbsence(
    resourceId: string,
    ruleName: string
  ): Promise<void> {
    const attempts = this.positiveIntegerEnv('HYPERVIBE_AZURE_POSTGRES_DELETE_ATTEMPTS', 180);
    const interval = this.nonNegativeIntegerEnv('HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS', 5000);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!(await this.client!.getFirewallRule(resourceId, ruleName))) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(`Azure PostgreSQL firewall rule ${ruleName} still exists after deletion.`);
  }

  private async assertRuntimeContract(
    client: AzurePostgresClient,
    server: AzurePostgresServer,
    databaseName: string,
    desired: { location?: string; skuName: string }
  ): Promise<void> {
    if (server.properties?.state?.toLowerCase() !== 'ready') {
      throw new Error(`Azure PostgreSQL server ${server.id} is not Ready.`);
    }
    this.assertServerShape(server, desired);
    const [firewall, database] = await Promise.all([
      client.getAzureServicesFirewallRule(server.id),
      client.getDatabase(server.id, databaseName),
    ]);
    if (
      firewall?.properties?.startIpAddress !== '0.0.0.0'
      || firewall.properties.endIpAddress !== '0.0.0.0'
    ) {
      throw new Error(
        `Azure PostgreSQL server ${server.id} is missing the exact Azure Container Apps connectivity firewall rule.`
      );
    }
    if (
      !database
      || database.properties?.charset?.toUpperCase() !== 'UTF8'
      || database.properties?.collation !== 'en_US.utf8'
    ) {
      throw new Error(
        `Azure PostgreSQL logical database ${databaseName} is absent or has unsupported encoding drift.`
      );
    }
  }

  private assertServerShape(
    server: AzurePostgresServer,
    desired: { location?: string; skuName: string }
  ): void {
    if (server.properties?.network?.publicNetworkAccess?.toLowerCase() !== 'enabled') {
      throw new Error(
        `Azure PostgreSQL server ${server.id} no longer has publicNetworkAccess Enabled; Hypervibe will not report ACA runtime connectivity as converged.`
      );
    }
    if (!server.properties.fullyQualifiedDomainName) {
      throw new Error(`Azure PostgreSQL server ${server.id} has no observed runtime hostname.`);
    }
    if (server.properties.version !== POSTGRES_VERSION) {
      throw new Error(
        `Azure PostgreSQL server ${server.id} version is ${server.properties.version ?? 'unknown'}, expected ${POSTGRES_VERSION}.`
      );
    }
    if (
      server.sku?.name !== desired.skuName
      || server.sku?.tier !== POSTGRES_SKU_TIER
    ) {
      throw new Error(
        `Azure PostgreSQL server ${server.id} SKU drifted from ${POSTGRES_SKU_TIER}/${desired.skuName}.`
      );
    }
    if (desired.location && server.location.toLowerCase() !== desired.location.toLowerCase()) {
      throw new Error(
        `Azure PostgreSQL server ${server.id} is in ${server.location}, expected ${desired.location}.`
      );
    }
  }

  private async resolvePublicIpv4(): Promise<string> {
    const response = await fetch(PUBLIC_IP_ENDPOINT, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Could not resolve operation source address (${response.status}).`);
    const address = (await response.text()).trim();
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new Error('Operation source address was not a valid IPv4 address.');
    }
    return address;
  }

  private async waitForAbsence(resourceId: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_DELETE_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!(await this.client!.getServer(resourceId))) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL server ${resourceId} still exists after deletion.`
    );
  }

  private component(
    environment: Environment,
    server: AzurePostgresServer,
    database: string,
    connectionUrl: string,
    password: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: PROVIDER,
        instanceId: server.id,
        providerScope: this.serverScope(server),
        connectionString: connectionUrl,
        host: server.properties?.fullyQualifiedDomainName,
        port: 5432,
        username: ADMIN_USERNAME,
        password,
        database,
        region: server.location,
      },
      externalId: server.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    resourceId: string,
    database: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: PROVIDER,
        instanceId: resourceId,
        providerScope: this.resourceScope(resourceId),
        database,
        region: this.target?.region ?? DEFAULT_LOCATION,
      },
      externalId: resourceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private emptyComponent(
    environment: Environment,
    type: ProvisionableType
  ): Component {
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

  private connectionUrl(
    host: string,
    username: string,
    password: string,
    database: string
  ): string {
    return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/${encodeURIComponent(database)}?sslmode=require`;
  }

  private serverScope(server: AzurePostgresServer): Record<string, string> {
    return this.resourceScope(server.id);
  }

  private resourceScope(resourceId: string): Record<string, string> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const identity = this.client.parseServerId(resourceId);
    return {
      subscriptionId: identity.subscriptionId,
      resourceGroup: identity.resourceGroup,
    };
  }

  private resourceName(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63)
      .replace(/-$/g, '');
    return normalized.length >= 3 ? normalized : `hv-${normalized || 'db'}`;
  }

  private tags(environment: Environment): Record<string, string> {
    return {
      'managed-by': 'hypervibe',
      'hypervibe-environment-id': environment.id,
      'hypervibe-managed': 'true',
      'hypervibe-environment': environment.name.slice(0, 256),
    };
  }

  private generatePassword(): string {
    return `Hv1!${randomBytes(24).toString('base64url')}`;
  }

  private normalizedStatus(
    value?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const state = value?.toLowerCase();
    if (state === 'ready') return 'running';
    if (['stopped', 'disabled'].includes(state ?? '')) return 'stopped';
    if (['failed', 'inaccessible'].includes(state ?? '')) return 'error';
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
    displayName: 'Azure Database for PostgreSQL',
    category: 'database',
    credentialsSchema: AzurePostgresCredentialsSchema,
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
        database: {
          status: 'ready-for-live',
          reason: 'Mocked lifecycle contracts pass; promotion requires recent Azure Container Apps plus PostgreSQL live evidence.',
        },
      },
    },
    lifecycle: {
      databaseEngines: ['postgres'],
      databaseConnectivity: {
        compatibleHostingProviders: ['azure-container-apps'],
      },
    },
  },
  inspection: {
    resources: ['database'],
    defaultResource: 'database',
    selectors: {
      database: {
        mode: 'provider-resource',
        optional: ['id', 'name', 'limit'],
        oneOf: [['id', 'scope']],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['subscriptionId', 'resourceGroup'],
      },
    },
    inspect: (adapter, request) => (
      adapter as AzurePostgresAdapter
    ).inspectDatabaseResources(request),
  },
  databaseRuntime: standardDatabaseRuntimeProjection,
  factory: async (credentials) => {
    const validated = AzurePostgresCredentialsSchema.parse(credentials);
    const adapter = new AzurePostgresAdapter();
    await adapter.connect(validated);
    return adapter;
  },
});
