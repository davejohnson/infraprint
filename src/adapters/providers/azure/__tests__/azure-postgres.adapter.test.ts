import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { AzurePostgresAdapter } from '../azure-postgres.adapter.js';

const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE_GROUP = 'hypervibe-test';
const SERVER_NAME = 'invoice-perfect-production-postgres';
const SERVER_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`
  + `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${SERVER_NAME}`;
const CLIENT_SECRET = 'azure-client-secret-never-output';

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

function server(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: SERVER_ID,
    name: SERVER_NAME,
    location: 'canadacentral',
    sku: { name: 'Standard_B1ms', tier: 'Burstable' },
    properties: {
      state: 'Ready',
      fullyQualifiedDomainName: `${SERVER_NAME}.postgres.database.azure.com`,
      administratorLogin: 'hypervibeadmin',
      version: '16',
      network: { publicNetworkAccess: 'Enabled' },
    },
    ...overrides,
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

async function connected(): Promise<AzurePostgresAdapter> {
  const adapter = new AzurePostgresAdapter();
  await adapter.connect(credentials);
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AzurePostgresAdapter', () => {
  it('inspects an exact ARM id without a credential resource-group scope', async () => {
    const paths: string[] = [];
    installAzureFetch((url, method) => {
      paths.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)) {
        return jsonResponse(server());
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.inspectDatabaseResources({
      resource: 'database',
      id: SERVER_ID,
      limit: 1,
    })).resolves.toMatchObject({
      observation: 'present',
      databases: [{ id: SERVER_ID }],
    });
    expect(paths).toEqual([`GET ${SERVER_ID}`]);
  });

  it('rejects a malformed successful exact database observation', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith('/databases/app')) {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect((adapter as any).client.getDatabase(SERVER_ID, 'app'))
      .rejects.toThrow('without an ID');
  });

  it('inventories bounded servers with subscription and resource-group scope', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({ id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}` });
      }
      if (method === 'GET' && url.pathname.endsWith('/flexibleServers')) {
        return jsonResponse({
          value: [
            server(),
            server({
              id: SERVER_ID.replace(SERVER_NAME, 'analytics'),
              name: 'analytics',
              location: 'eastus',
            }),
          ],
        });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.inspectDatabaseResources({
      resource: 'database',
      scope: RESOURCE_GROUP,
      limit: 1,
    });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: SERVER_ID,
        engine: 'postgres',
        providerScope: {
          subscriptionId: SUBSCRIPTION_ID,
          resourceGroup: RESOURCE_GROUP,
        },
      }],
      truncated: true,
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
      if (method === 'GET' && url.pathname.endsWith('/flexibleServers')) {
        return jsonResponse({ value: [server()] });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.inspectDatabaseResources({
      resource: 'database',
      name: SERVER_NAME,
      binding: {
        provider: 'azure-container-apps',
        projectId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
        environmentId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/hv-production`,
      },
      limit: 1,
    })).resolves.toMatchObject({
      observation: 'present',
      databases: [{ id: SERVER_ID }],
    });
    expect(paths).toEqual([
      `GET /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
      `GET /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.DBforPostgreSQL/flexibleServers`,
    ]);
  });

  it('does not derive list scope from an undeclared hosting binding', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.inspectDatabaseResources({
      resource: 'database',
      binding: {
        provider: 'railway',
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

    await expect(adapter.observeDatabase(unbound, null, {
      resourceName: SERVER_NAME,
    })).resolves.toBeNull();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^GET \/subscriptions\/.*\/resourceGroups\/hv-invoice-perfect-production-[0-9a-f]{8}$/);
  });

  it('creates a server and logical database while keeping receipts secret-safe', async () => {
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
      if (method === 'GET' && url.pathname.endsWith('/flexibleServers')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT' && url.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)) {
        return jsonResponse(server());
      }
      if (method === 'PUT' && url.pathname.endsWith('/firewallRules/hypervibe-azure-services')) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith('/firewallRules/hypervibe-azure-services')) {
        return jsonResponse({
          id: `${SERVER_ID}/firewallRules/hypervibe-azure-services`,
          name: 'hypervibe-azure-services',
          properties: {
            startIpAddress: '0.0.0.0',
            endIpAddress: '0.0.0.0',
          },
        });
      }
      if (method === 'PUT' && url.pathname.endsWith('/databases/app')) {
        return accepted();
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/app')) {
        return jsonResponse({
          id: `${SERVER_ID}/databases/app`,
          name: 'app',
          properties: { charset: 'UTF8', collation: 'en_US.utf8' },
        });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'Invoice Perfect Production Postgres',
      databaseName: 'app',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(SERVER_ID);
    expect(result.connectionUrl).toMatch(
      /^postgresql:\/\/hypervibeadmin:.*@invoice-perfect-production-postgres\.postgres\.database\.azure\.com:5432\/app\?sslmode=require$/
    );
    const create = requests.find((request) =>
      request.method === 'PUT'
      && request.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)
    );
    expect(create?.body).toMatchObject({
      location: 'canadacentral',
      sku: { name: 'Standard_B1ms', tier: 'Burstable' },
      properties: {
        administratorLogin: 'hypervibeadmin',
        network: { publicNetworkAccess: 'Enabled' },
      },
    });
    const password =
      create?.body?.properties?.administratorLoginPassword as string;
    expect(password.length).toBeGreaterThan(20);
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'PUT',
      pathname: expect.stringContaining(
        '/firewallRules/hypervibe-azure-services'
      ),
      body: {
        properties: {
          startIpAddress: '0.0.0.0',
          endIpAddress: '0.0.0.0',
        },
      },
    }));
    expect(JSON.stringify(result.receipt)).not.toContain(password);
    expect(JSON.stringify(result.receipt)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('postgresql://');
  });

  it('blocks name-match adoption and never issues a create', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/flexibleServers')) {
        return jsonResponse({ value: [server()] });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: SERVER_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('will not choose or silently adopt');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'))
      .toBe(false);
  });

  it('preserves the reviewed resource id after an unknown create outcome', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/resourceGroups/${RESOURCE_GROUP}`)) {
        return jsonResponse({
          id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`,
          tags: { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'env-local' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/flexibleServers')) {
        return jsonResponse({ value: [] });
      }
      if (method === 'PUT') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: SERVER_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe(SERVER_ID);
    expect(result.receipt.data).toMatchObject({
      serverId: SERVER_ID,
      mutationAttempted: true,
    });
  });

  it('opens and removes an operation-scoped firewall rule for portable data access', async () => {
    const requests: Array<{ method: string; pathname: string; body: any }> = [];
    let deleted = false;
    installAzureFetch((url, method, body) => {
      if (url.hostname === 'checkip.amazonaws.com') {
        return new Response('203.0.113.24\n');
      }
      requests.push({ method, pathname: url.pathname, body });
      if (url.pathname.includes('/firewallRules/hypervibe-operation-')) {
        if (method === 'PUT') return accepted();
        if (method === 'GET' && deleted) return jsonResponse({ error: 'gone' }, 404);
        if (method === 'GET') return jsonResponse({
          id: url.pathname,
          name: url.pathname.split('/').at(-1),
          properties: { startIpAddress: '203.0.113.24', endIpAddress: '203.0.113.24' },
        });
        if (method === 'DELETE') {
          deleted = true;
          return accepted();
        }
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const component = {
      id: 'component',
      environmentId: 'env-local',
      type: 'postgres',
      bindings: {
        provider: 'azure-postgres',
        instanceId: SERVER_ID,
        providerScope: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: RESOURCE_GROUP },
        connectionString: 'postgresql://user:password@server.example.com/app?sslmode=require',
      },
      externalId: SERVER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const access = await adapter.acquireTemporaryDatabaseAccess(environment(), component, 5432);
    expect(access).toMatchObject({ source: 'temporary_firewall', temporary: true });
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'PUT',
      body: { properties: { startIpAddress: '203.0.113.24', endIpAddress: '203.0.113.24' } },
    }));

    await adapter.releaseTemporaryDatabaseAccess(environment(), component, access);
    expect(requests.some((request) => request.method === 'DELETE' && request.pathname.includes('/firewallRules/hypervibe-operation-'))).toBe(true);
  });

  it('refuses temporary firewall mutation for an unscoped legacy binding', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.acquireTemporaryDatabaseAccess(environment(), {
      id: 'component',
      environmentId: 'env-local',
      type: 'postgres',
      bindings: {
        provider: 'azure-postgres',
        instanceId: SERVER_ID,
        connectionString: 'postgresql://user:password@server.example.com/app?sslmode=require',
      },
      externalId: SERVER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, 5432)).rejects.toThrow(/missing its durable subscription\/resource-group provider scope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves durable ids before names and treats only 404 as absence', async () => {
    let listCalled = false;
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)) {
        return jsonResponse(server());
      }
      if (method === 'GET' && url.pathname.endsWith('/firewallRules/hypervibe-azure-services')) {
        return jsonResponse({
          id: `${SERVER_ID}/firewallRules/hypervibe-azure-services`,
          name: 'hypervibe-azure-services',
          properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' },
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/databases/app')) {
        return jsonResponse({
          id: `${SERVER_ID}/databases/app`,
          name: 'app',
          properties: { charset: 'UTF8', collation: 'en_US.utf8' },
        });
      }
      if (url.pathname.endsWith('/flexibleServers')) listCalled = true;
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();

    await expect(adapter.observeDatabase(
      environment(),
      {
        id: 'component',
        environmentId: 'env-local',
        type: 'postgres',
        bindings: {
          provider: 'azure-postgres',
          providerScope: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: RESOURCE_GROUP },
        },
        externalId: SERVER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    )).resolves.toMatchObject({
      externalId: SERVER_ID,
      status: 'running',
    });
    expect(listCalled).toBe(false);

    installAzureFetch((_url, _method) =>
      jsonResponse({ error: 'forbidden' }, 403)
    );
    const unknown = await connected();
    await expect(unknown.observeDatabase(
      environment(),
      {
        id: 'component',
        environmentId: 'env-local',
        type: 'postgres',
        bindings: {
          provider: 'azure-postgres',
          providerScope: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: RESOURCE_GROUP },
        },
        externalId: SERVER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    )).rejects.toMatchObject({ status: 403 });
  });

  it('rejects legacy exact-id bindings without durable provider scope', async () => {
    const fetchMock = installAzureFetch((url, method) => {
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const legacy = {
      id: 'component',
      environmentId: 'env-local',
      type: 'postgres' as const,
      bindings: { provider: 'azure-postgres', instanceId: SERVER_ID },
      externalId: SERVER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.observeDatabase(environment(), legacy))
      .rejects.toThrow(/missing its durable subscription\/resource-group provider scope/);
    await expect(adapter.destroy(legacy)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/missing its durable subscription\/resource-group provider scope/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks observation when the public ACA connectivity contract drifts', async () => {
    installAzureFetch((url, method) => {
      if (method === 'GET' && url.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)) {
        return jsonResponse(server({
          properties: {
            ...(server().properties as Record<string, unknown>),
            network: { publicNetworkAccess: 'Disabled' },
          },
        }));
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    adapter.configureTarget({ projectName: 'invoice-perfect' });

    await expect(adapter.observeDatabase(environment(), {
      id: 'component',
      environmentId: 'env-local',
      type: 'postgres',
      bindings: {
        provider: 'azure-postgres',
        instanceId: SERVER_ID,
        providerScope: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: RESOURCE_GROUP },
        database: 'app',
      },
      externalId: SERVER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    })).rejects.toThrow(/publicNetworkAccess Enabled/);
  });

  it('makes deletion idempotent and verifies terminal absence', async () => {
    let getCount = 0;
    let deleted = false;
    installAzureFetch((url, method) => {
      if (url.pathname.endsWith(`/flexibleServers/${SERVER_NAME}`)) {
        if (method === 'DELETE') {
          deleted = true;
          return accepted();
        }
        getCount += 1;
        return deleted
          ? jsonResponse({ error: 'gone' }, 404)
          : jsonResponse(server());
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    });
    const adapter = await connected();
    const component = {
      id: 'component',
      environmentId: 'env-local',
      type: 'postgres' as const,
      bindings: {
        provider: 'azure-postgres',
        instanceId: SERVER_ID,
        providerScope: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: RESOURCE_GROUP },
      },
      externalId: SERVER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

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
        return jsonResponse(server());
      }
      return jsonResponse({ error: 'gone' }, 404);
    });
    const raced = await connected();
    await expect(raced.destroy(component)).resolves.toMatchObject({
      success: true,
    });
  });
});
