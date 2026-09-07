import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { AzureManagedRedisAdapter } from '../azure-managed-redis.adapter.js';

const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE_GROUP = 'hypervibe-test';
const CLUSTER_NAME = 'invoice-perfect-production-redis';
const CLUSTER_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`
  + `/providers/Microsoft.Cache/redisEnterprise/${CLUSTER_NAME}`;
const CLIENT_SECRET = 'azure-client-secret-never-output';
const PRIMARY_KEY = 'redis-primary-key-never-output';

const credentials = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: SUBSCRIPTION_ID,
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: CLIENT_SECRET,
  resourceGroup: RESOURCE_GROUP,
  location: 'canadacentral',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

function cluster(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: CLUSTER_ID,
    name: CLUSTER_NAME,
    location: 'canadacentral',
    sku: { name: 'Balanced_B0' },
    properties: {
      provisioningState: 'Succeeded',
      resourceState: 'Running',
      hostName: `${CLUSTER_NAME}.canadacentral.redis.azure.net`,
      minimumTlsVersion: '1.2',
      publicNetworkAccess: 'Enabled',
    },
    ...overrides,
  };
}

function database(): Record<string, unknown> {
  return {
    id: `${CLUSTER_ID}/databases/default`,
    name: `${CLUSTER_NAME}/default`,
    properties: {
      provisioningState: 'Succeeded',
      resourceState: 'Running',
      clientProtocol: 'Encrypted',
      accessKeysAuthentication: 'Enabled',
      port: 10000,
      redisVersion: '7.4',
    },
  };
}

function environment(): Environment {
  return {
    id: 'env-local',
    projectId: 'project-local',
    name: 'production',
    platformBindings: {
      provider: 'azure-container-apps',
      projectId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
      environmentId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/hv-production`,
      services: {},
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function cacheComponent(
  bindings: Record<string, unknown> = {}
): Component {
  return {
    id: 'component',
    environmentId: 'env-local',
    type: 'redis',
    bindings: {
      provider: 'azure-managed-redis',
      instanceId: CLUSTER_ID,
      providerScope: {
        subscriptionId: SUBSCRIPTION_ID,
        resourceGroup: RESOURCE_GROUP,
      },
      connectionString: `rediss://:${PRIMARY_KEY}@${CLUSTER_NAME}.canadacentral.redis.azure.net:10000`,
      password: PRIMARY_KEY,
      ...bindings,
    },
    externalId: CLUSTER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function installAzureFetch(
  handler: (
    url: URL,
    method: string,
    body: unknown
  ) => Response | Promise<Response>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') {
      return jsonResponse({ access_token: 'safe-access-token' });
    }
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body)
      : undefined;
    return handler(url, init?.method ?? 'GET', body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connected(): Promise<AzureManagedRedisAdapter> {
  const adapter = new AzureManagedRedisAdapter();
  await adapter.connect(credentials);
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AzureManagedRedisAdapter', () => {
  it('inspects an exact ARM id without a credential resource-group scope', async () => {
    const paths: string[] = [];
    installAzureFetch((url, method) => {
      paths.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.inspectCacheResources({
      resource: 'cache',
      id: CLUSTER_ID,
      limit: 1,
    })).resolves.toMatchObject({
      observation: 'present',
      caches: [{ id: CLUSTER_ID }],
    });
    expect(paths).toEqual([`GET ${CLUSTER_ID}`]);
  });

  it('rejects a malformed successful exact database observation', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect((adapter as any).client.getDatabase(CLUSTER_ID))
      .rejects.toThrow('without an ID');
  });

  it('inventories bounded caches with their full Azure scope', async () => {
    installAzureFetch((url, method) => {
      expect(method).toBe('GET');
      if (url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({ id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}` });
      }
      expect(url.pathname).toContain('/providers/Microsoft.Cache/redisEnterprise');
      return jsonResponse({ value: [cluster()] });
    });
    const adapter = await connected();

    await expect(adapter.inspectCacheResources({
      resource: 'cache',
      scope: RESOURCE_GROUP,
      limit: 1,
    }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'cache',
        caches: [{
          id: CLUSTER_ID,
          name: CLUSTER_NAME,
          providerScope: {
            subscriptionId: SUBSCRIPTION_ID,
            resourceGroup: RESOURCE_GROUP,
          },
        }],
        partial: false,
      });
  });

  it('derives list scope from an exact Azure Container Apps binding', async () => {
    const paths: string[] = [];
    installAzureFetch((url, method) => {
      paths.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({ id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}` });
      }
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [cluster()] });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.inspectCacheResources({
      resource: 'cache',
      name: CLUSTER_NAME,
      binding: {
        provider: 'azure-container-apps',
        projectId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
        environmentId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/hv-production`,
      },
      limit: 1,
    })).resolves.toMatchObject({
      observation: 'present',
      caches: [{ id: CLUSTER_ID }],
    });
    expect(paths).toEqual([
      `GET /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
      `GET /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Cache/redisEnterprise`,
    ]);
  });

  it('does not derive list scope from an undeclared hosting binding', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.inspectCacheResources({
      resource: 'cache',
      binding: {
        provider: 'cloudrun',
        projectId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
      },
      limit: 1,
    })).rejects.toThrow(/explicit Azure resource-group scope or compatible Azure Container Apps/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proves initial absence only through the deterministic ACA resource group', async () => {
    const paths: string[] = [];
    installAzureFetch((url, method) => {
      paths.push(`${method} ${url.pathname}`);
      return jsonResponse({ error: 'absent' }, 404);
    });
    const adapter = await connected();
    adapter.configureTarget({ projectName: 'invoice-perfect' });
    const unbound = environment();
    unbound.platformBindings = {};

    await expect(adapter.observeCache(unbound, null, {
      projectName: 'invoice-perfect',
      resourceName: CLUSTER_NAME,
    })).resolves.toBeNull();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^GET \/subscriptions\/.*\/resourceGroups\/hv-invoice-perfect-production-[0-9a-f]{8}$/);
  });

  it('rejects unsupported network placement instead of ignoring it', async () => {
    const adapter = await connected();
    expect(() => adapter.configureTarget({ network: 'default' }))
      .toThrow(/does not support desired network/);
    expect(() => adapter.configureTarget({ subnetwork: 'apps', tier: 'premium' }))
      .toThrow(/subnetwork, tier/);
  });

  it('creates an encrypted Redis database and keeps access keys out of receipts', async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      body: any;
    }> = [];
    installAzureFetch((url, method, body) => {
      requests.push({ method, pathname: url.pathname, body });
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      if (method === 'PUT' && url.pathname.endsWith('/databases/default')) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse(database());
      }
      if (method === 'POST' && url.pathname.endsWith('/databases/default/listKeys')) {
        return jsonResponse({
          primaryKey: PRIMARY_KEY,
          secondaryKey: 'secondary-secret',
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(CLUSTER_ID);
    expect(result.connectionUrl).toBe(
      `rediss://:${PRIMARY_KEY}@${CLUSTER_NAME}.canadacentral.redis.azure.net:10000`
    );
    const createDatabase = requests.find((request) =>
      request.method === 'PUT'
      && request.pathname.endsWith('/databases/default')
    );
    expect(createDatabase?.body).toMatchObject({
      properties: {
        clientProtocol: 'Encrypted',
        clusteringPolicy: 'NoCluster',
        accessKeysAuthentication: 'Enabled',
        port: 10000,
      },
    });
    const createCluster = requests.find((request) =>
      request.method === 'PUT'
      && request.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)
    );
    expect(createCluster?.body).toMatchObject({
      location: 'canadacentral',
      sku: { name: 'Balanced_B0' },
      properties: {
        minimumTlsVersion: '1.2',
        publicNetworkAccess: 'Enabled',
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(PRIMARY_KEY);
    expect(JSON.stringify(result.receipt)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('rediss://');
  });

  it('updates only the exact bound cluster SKU and verifies the runtime contract', async () => {
    const requests: Array<{ method: string; pathname: string; body: any }> = [];
    let updated = false;
    installAzureFetch((url, method, body) => {
      requests.push({ method, pathname: url.pathname, body });
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster({ sku: { name: updated ? 'Balanced_B1' : 'Balanced_B0' } }));
      }
      if (method === 'PATCH' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        updated = true;
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse(database());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: CLUSTER_NAME,
      component: cacheComponent({ size: 'Balanced_B0', region: 'canadacentral' }),
      region: 'canadacentral',
      size: 'Balanced_B1',
    });

    expect(result.receipt).toMatchObject({ success: true, data: { sizeChanged: true } });
    expect(result.component.bindings.size).toBe('Balanced_B1');
    expect(requests.filter(({ method }) => method === 'PATCH')).toEqual([
      expect.objectContaining({ body: { sku: { name: 'Balanced_B1' } } }),
    ]);
    expect(requests.some(({ method }) => method === 'PUT' || method === 'DELETE')).toBe(false);
    expect(requests.some(({ pathname }) => pathname.endsWith('/redisEnterprise'))).toBe(false);
    expect(JSON.stringify(result.receipt)).not.toContain(PRIMARY_KEY);
  });

  it('verifies an unchanged bound cluster without provider mutations', async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    installAzureFetch((url, method) => {
      requests.push({ method, pathname: url.pathname });
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse(database());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: CLUSTER_NAME,
      component: cacheComponent({ size: 'Balanced_B0', region: 'canadacentral' }),
      region: 'canadacentral',
      size: 'Balanced_B0',
    });

    expect(result.receipt).toMatchObject({ success: true, data: { sizeChanged: false } });
    expect(requests.filter(({ method }) => ['PUT', 'PATCH', 'DELETE'].includes(method))).toEqual([]);
    expect(requests.some(({ pathname }) => pathname.endsWith('/databases/default/listKeys'))).toBe(false);
  });

  it('blocks immutable region drift without creating or updating a cluster', async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    installAzureFetch((url, method) => {
      requests.push({ method, pathname: url.pathname });
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      component: cacheComponent(),
      region: 'eastus',
      size: 'Balanced_B0',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      error: expect.stringContaining('Region is immutable'),
    });
    expect(requests.filter(({ method }) => ['PUT', 'PATCH', 'DELETE'].includes(method))).toEqual([]);
  });

  it('blocks duplicate-name adoption without a mutation', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [cluster()] });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: CLUSTER_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('will not choose or silently adopt');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'))
      .toBe(false);
  });

  it('preserves cluster identity after an unknown create result', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/redisEnterprise')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: CLUSTER_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe(CLUSTER_ID);
    expect(result.receipt.data).toMatchObject({
      clusterId: CLUSTER_ID,
      mutationAttempted: true,
    });
  });

  it('uses durable ids first and preserves permission errors as unknown', async () => {
    let listCalled = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster());
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse(database());
      }
      if (url.pathname.endsWith('/redisEnterprise')) listCalled = true;
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const component = cacheComponent();

    await expect(adapter.observeCache(
      environment(),
      component
    )).resolves.toMatchObject({
      externalId: CLUSTER_ID,
      status: 'running',
    });
    expect(listCalled).toBe(false);

    installAzureFetch(() => jsonResponse({ error: 'forbidden' }, 403));
    const unknown = await connected();
    await expect(unknown.observeCache(
      environment(),
      component
    )).rejects.toMatchObject({ status: 403 });
  });

  it('reports configurable placement drift so plan/apply can reconcile it', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster({ location: 'eastus', sku: { name: 'Balanced_B1' } }));
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/default')) {
        return jsonResponse(database());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    adapter.configureTarget({
      projectName: 'invoice-perfect',
      region: 'canadacentral',
      size: 'Balanced_B0',
    });

    await expect(adapter.observeCache(
      environment(),
      cacheComponent()
    )).resolves.toMatchObject({
      externalId: CLUSTER_ID,
      config: { region: 'eastus', size: 'Balanced_B1' },
    });
  });

  it('rejects legacy exact-id bindings without durable provider scope', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const legacy = cacheComponent({ providerScope: undefined });

    await expect(adapter.observeCache(environment(), legacy))
      .rejects.toThrow(/missing its durable subscription\/resource-group provider scope/);
    await expect(adapter.destroy(legacy)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/missing its durable subscription\/resource-group provider scope/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks observation when TLS or public ACA connectivity drifts', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        return jsonResponse(cluster({
          properties: {
            ...(cluster().properties as Record<string, unknown>),
            publicNetworkAccess: 'Disabled',
          },
        }));
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    adapter.configureTarget({ projectName: 'invoice-perfect' });

    await expect(adapter.observeCache(environment(), {
      id: 'component',
      environmentId: 'env-local',
      type: 'redis',
      bindings: {
        provider: 'azure-managed-redis',
        instanceId: CLUSTER_ID,
        providerScope: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: RESOURCE_GROUP },
      },
      externalId: CLUSTER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    })).rejects.toThrow(/publicNetworkAccess Enabled/);
  });

  it('makes deletion idempotent and verifies terminal absence', async () => {
    let getCount = 0;
    let deleted = false;
    installAzureFetch((url, method) => {
      if (url.pathname.endsWith(`/redisEnterprise/${CLUSTER_NAME}`)) {
        if (method === 'DELETE') {
          deleted = true;
          return accepted();
        }
        getCount += 1;
        return deleted
          ? jsonResponse({ error: 'gone' }, 404)
          : jsonResponse(cluster());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const component = cacheComponent();

    await expect(adapter.destroy(component)).resolves.toMatchObject({
      success: true,
    });
    expect(getCount).toBe(2);

    installAzureFetch(() => jsonResponse({ error: 'gone' }, 404));
    const absent = await connected();
    await expect(absent.destroy(component)).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining('already absent'),
    });

    let observed = false;
    installAzureFetch((_url, method) => {
      if (method === 'GET' && !observed) {
        observed = true;
        return jsonResponse(cluster());
      }
      return jsonResponse({ error: 'gone' }, 404);
    });
    const raced = await connected();
    await expect(raced.destroy(component)).resolves.toMatchObject({
      success: true,
    });
  });
});
