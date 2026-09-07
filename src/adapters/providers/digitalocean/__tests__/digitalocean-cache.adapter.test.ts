import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { DigitalOceanCacheAdapter } from '../digitalocean-cache.adapter.js';

function makeEnvironment(name = 'production'): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name,
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeComponent(externalId = 'do-valkey-1'): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: {
      provider: 'digitalocean',
      instanceId: externalId,
      providerScope: { accountUuid: 'do-account-uuid' },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function connectedAdapter(): Promise<DigitalOceanCacheAdapter> {
  const adapter = new DigitalOceanCacheAdapter();
  await adapter.connect({
    apiToken: 'dop_v1_test-token',
    region: 'sfo3',
    databaseSize: 'db-s-1vcpu-1gb',
    postgresVersion: '17',
    valkeyVersion: '8',
  });
  return adapter;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return !['GET', 'HEAD'].includes(init?.method ?? 'GET');
  });
}

describe('DigitalOceanCacheAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates Redis-compatible Valkey only after complete absence', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '2');
    const connectionUrl =
      'rediss://default:cache-secret@private-valkey-do-user.db.ondigitalocean.com:25061';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({
          database: {
            id: 'do-valkey-created',
            name: 'invoice-perfect-production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          },
        }, 201);
      }
      if (
        url.pathname === '/v2/databases/do-valkey-created'
        && method === 'GET'
      ) {
        return jsonResponse({
          database: {
            id: 'do-valkey-created',
            name: 'invoice-perfect-production-redis',
            engine: 'valkey',
            status: 'online',
            region: 'sfo3',
            size: 'db-s-1vcpu-1gb',
            connection: { uri: connectionUrl },
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('do-valkey-created');
    expect(result.connectionUrl).toBe(connectionUrl);
    expect(result.envVars).toEqual({ REDIS_URL: connectionUrl });
    expect(result.component.bindings).toMatchObject({
      provider: 'digitalocean',
      instanceId: 'do-valkey-created',
      engine: 'valkey',
      region: 'sfo3',
    });
    expect(JSON.stringify(result.receipt)).not.toContain('cache-secret');

    const createCall = fetchMock.mock.calls.find((call) => {
      const [rawUrl, init] = call as [string, RequestInit];
      return new URL(rawUrl).pathname === '/v2/databases'
        && init.method === 'POST';
    }) as [string, RequestInit] | undefined;
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      name: 'invoice-perfect-production-redis',
      engine: 'valkey',
      version: '8',
      region: 'sfo3',
      size: 'db-s-1vcpu-1gb',
      num_nodes: 1,
      tags: ['hypervibe'],
    });
  });

  it('does not create when existing-resource observation is unknown', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: 'temporarily unavailable' }, 503)
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('503');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('rejects unsupported network and tier fields before any provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    expect(() => adapter.configureTarget({ network: 'private-vpc', tier: 'STANDARD_HA' }))
      .toThrow('does not implement declarative cache network, tier');
    await expect(adapter.provision('redis', makeEnvironment(), { subnetwork: 'private-subnet' }))
      .rejects.toThrow('does not implement declarative cache subnetwork');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks duplicate name matches instead of choosing or adopting one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      databases: [
        {
          id: 'do-valkey-1',
          name: 'invoice-perfect-production-redis',
          engine: 'valkey',
        },
        {
          id: 'do-valkey-2',
          name: 'invoice-perfect-production-redis',
          engine: 'valkey',
        },
      ],
      links: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('do-valkey-1');
    expect(result.receipt.error).toContain('do-valkey-2');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('preserves the created Valkey identity when readiness cannot be proven', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({
          database: {
            id: 'do-valkey-pending',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          },
        }, 201);
      }
      if (
        url.pathname === '/v2/databases/do-valkey-pending'
        && method === 'GET'
      ) {
        return jsonResponse({
          database: {
            id: 'do-valkey-pending',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('do-valkey-pending');
    expect(result.component.bindings.providerScope).toEqual({
      accountUuid: 'do-account-uuid',
      region: 'sfo3',
    });
    expect(result.receipt.data).toMatchObject({
      clusterId: 'do-valkey-pending',
      engine: 'valkey',
      status: 'creating',
    });
  });

  it('retains the requested region in an unresolved marker when a create returns a malformed region', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    const malformedRegion = { slug: 'nyc3' };
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({
          database: {
            id: 'do-valkey-malformed-region',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: malformedRegion,
          },
        }, 201);
      }
      if (url.pathname === '/v2/databases/do-valkey-malformed-region' && method === 'GET') {
        return jsonResponse({
          database: {
            id: 'do-valkey-malformed-region',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: malformedRegion,
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      region: 'nyc3',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'digitalocean',
        providerScope: { accountUuid: 'do-account-uuid', region: 'nyc3' },
        region: 'nyc3',
        provisioningIncomplete: true,
        unresolvedMutation: {
          resourceKind: 'cache',
          operation: 'create',
          resourceName: 'production-redis',
          providerScope: { accountUuid: 'do-account-uuid', region: 'nyc3' },
        },
      },
    });
    expect(typeof (
      result.component.bindings.providerScope as Record<string, unknown>
    ).region).toBe('string');
  });

  it('recovers and retains a Valkey id when the create response is lost after commit', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    let listReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        listReads += 1;
        return jsonResponse({
          databases: listReads === 1 ? [] : [{
            id: 'do-valkey-recovered',
            name: 'production-redis',
            engine: 'valkey',
            status: 'creating',
            region: 'sfo3',
          }],
          links: {},
        });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: 'do-valkey-recovered',
      bindings: {
        provider: 'digitalocean',
        instanceId: 'do-valkey-recovered',
        providerScope: { accountUuid: 'do-account-uuid', region: 'sfo3' },
      },
    });
    expect(result.receipt.data).toMatchObject({
      mutationAttempted: true,
      resourceCreated: true,
      clusterId: 'do-valkey-recovered',
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it.each([
    ['HTTP 503', () => jsonResponse({ message: 'temporarily unavailable' }, 503)],
    ['HTTP 408', () => jsonResponse({ message: 'request timed out' }, 408)],
    ['transport failure', () => { throw new Error('connection closed after request transmission'); }],
    ['malformed success', () => jsonResponse({
      database: {
        name: 'production-redis', engine: 'valkey', region: 'sfo3', status: 'creating',
      },
    }, 201)],
  ])('retains an unresolved cache marker after ambiguous %s with inconclusive recovery', async (_label, createOutcome) => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return createOutcome();
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.receipt).toMatchObject({
      success: false,
      data: { mutationAttempted: true, resourceCreated: 'unknown' },
    });
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'digitalocean',
        providerScope: { accountUuid: 'do-account-uuid', region: 'sfo3' },
        provisioningIncomplete: true,
        unresolvedMutation: {
          resourceKind: 'cache',
          operation: 'create',
          resourceName: 'production-redis',
          providerScope: { accountUuid: 'do-account-uuid', region: 'sfo3' },
        },
      },
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('does not retain an unresolved marker or retry recovery after a definitive HTTP 4xx rejection', async () => {
    let listReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        listReads += 1;
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({ message: 'invalid request' }, 422);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.receipt).toMatchObject({
      success: false,
      data: { mutationAttempted: true, resourceCreated: false },
    });
    expect(result.component.externalId).toBeNull();
    expect(result.component.bindings).toEqual({});
    expect(listReads).toBe(1);
  });

  it.each([
    ['name', { id: 'wrong-ack', name: 'another-cache', engine: 'valkey', region: 'sfo3' }],
    ['engine', { id: 'wrong-ack', name: 'production-redis', engine: 'pg', region: 'sfo3' }],
    ['region', { id: 'wrong-ack', name: 'production-redis', engine: 'valkey', region: 'nyc3' }],
  ])('does not trust a create acknowledgment with the wrong %s', async (_label, database) => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    let listReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        listReads += 1;
        return jsonResponse({ databases: [], links: {} });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        return jsonResponse({ database: { ...database, status: 'creating' } }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provisioningIncomplete: true,
        unresolvedMutation: { resourceName: 'production-redis' },
      },
    });
    expect(listReads).toBe(2);
  });

  it('keeps the marker unresolved when recovery finds the requested name in a different region', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    let listReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases' && method === 'GET') {
        listReads += 1;
        return jsonResponse({
          databases: listReads === 1 ? [] : [{
            id: 'wrong-region', name: 'production-redis', engine: 'valkey', region: 'nyc3',
          }],
          links: {},
        });
      }
      if (url.pathname === '/v2/databases' && method === 'POST') {
        throw new Error('response lost');
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment());

    expect(result.component).toMatchObject({
      externalId: null,
      bindings: { provisioningIncomplete: true },
    });
    expect(result.receipt.data?.recoveryError).toContain('requested region sfo3');
  });

  it('verifies an exact bound cache without issuing a mutation when configuration matches', async () => {
    const connectionUrl =
      'rediss://default:cache-secret@private-valkey.db.ondigitalocean.com:25061';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases/do-valkey-1') {
        return jsonResponse({
          database: {
            id: 'do-valkey-1',
            name: 'production-redis',
            engine: 'valkey',
            status: 'online',
            region: 'sfo3',
            size: 'db-s-1vcpu-1gb',
            num_nodes: 2,
            connection: { uri: connectionUrl },
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      region: 'sfo3',
      size: 'db-s-1vcpu-1gb',
    });

    expect(result.receipt).toMatchObject({
      success: true,
      data: { regionChanged: false, sizeChanged: false, ready: true },
    });
    expect(result.component.bindings).toMatchObject({
      instanceId: 'do-valkey-1',
      providerScope: { accountUuid: 'do-account-uuid', region: 'sfo3' },
      size: 'db-s-1vcpu-1gb',
    });
    expect(mutationCalls(fetchMock)).toEqual([]);
    expect(fetchMock.mock.calls.some((call) => (
      new URL(String(call[0])).pathname === '/v2/databases'
    ))).toBe(false);
  });

  it('resizes the exact bound cache while preserving its live node count and verifies read-back', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '2');
    let clusterReads = 0;
    const connectionUrl =
      'rediss://default:cache-secret@private-valkey.db.ondigitalocean.com:25061';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases/do-valkey-1' && method === 'GET') {
        clusterReads += 1;
        return jsonResponse({
          database: {
            id: 'do-valkey-1',
            name: 'production-redis',
            engine: 'valkey',
            status: 'online',
            region: 'sfo3',
            size: clusterReads === 1 ? 'db-s-1vcpu-1gb' : 'db-s-2vcpu-4gb',
            num_nodes: 2,
            connection: { uri: connectionUrl },
          },
        });
      }
      if (url.pathname === '/v2/databases/do-valkey-1/resize' && method === 'PUT') {
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      size: 'db-s-2vcpu-4gb',
    });

    expect(result.receipt).toMatchObject({
      success: true,
      data: { sizeChanged: true, size: 'db-s-2vcpu-4gb', ready: true },
    });
    const resizeCall = fetchMock.mock.calls.find((call) => (
      new URL(String(call[0])).pathname === '/v2/databases/do-valkey-1/resize'
    ));
    expect(resizeCall?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((resizeCall?.[1] as RequestInit).body))).toEqual({
      size: 'db-s-2vcpu-4gb',
      num_nodes: 2,
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('migrates the exact bound cache and verifies its new region before success', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '2');
    let clusterReads = 0;
    const connectionUrl =
      'rediss://default:cache-secret@private-valkey.db.ondigitalocean.com:25061';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases/do-valkey-1' && method === 'GET') {
        clusterReads += 1;
        return jsonResponse({
          database: {
            id: 'do-valkey-1',
            name: 'production-redis',
            engine: 'valkey',
            status: 'online',
            region: clusterReads === 1 ? 'sfo3' : 'nyc3',
            size: 'db-s-1vcpu-1gb',
            num_nodes: 1,
            connection: { uri: connectionUrl },
          },
        });
      }
      if (url.pathname === '/v2/databases/do-valkey-1/migrate' && method === 'PUT') {
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      region: 'nyc3',
    });

    expect(result.receipt).toMatchObject({
      success: true,
      data: { regionChanged: true, region: 'nyc3', ready: true },
    });
    const migrateCall = fetchMock.mock.calls.find((call) => (
      new URL(String(call[0])).pathname === '/v2/databases/do-valkey-1/migrate'
    ));
    expect(JSON.parse(String((migrateCall?.[1] as RequestInit).body))).toEqual({
      region: 'nyc3',
    });
    expect(result.component.bindings.providerScope).toEqual({
      accountUuid: 'do-account-uuid',
      region: 'nyc3',
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('does not fall back to create-by-name when a bound cache identity is missing or absent', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases/do-valkey-1') {
        return jsonResponse({ message: 'not found' }, 404);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const missingId = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(''),
      resourceName: 'production-redis',
    });
    expect(missingId.receipt.success).toBe(false);
    expect(missingId.receipt.error).toContain('no exact external ID');
    expect(fetchMock).not.toHaveBeenCalled();

    const absent = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      resourceName: 'production-redis',
    });
    expect(absent.receipt.success).toBe(false);
    expect(absent.receipt.error).toContain('is absent');
    expect(mutationCalls(fetchMock)).toEqual([]);
    expect(fetchMock.mock.calls.some((call) => (
      new URL(String(call[0])).pathname === '/v2/databases'
    ))).toBe(false);
  });

  it('preserves the bound cache without mutation when exact observation is unknown', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname === '/v2/account'
        ? jsonResponse({ account: { uuid: 'do-account-uuid' } })
        : jsonResponse({ message: 'temporarily unavailable' }, 503);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      size: 'db-s-2vcpu-4gb',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: { clusterId: 'do-valkey-1', mutationAttempted: false },
    });
    expect(result.receipt.error).toContain('503');
    expect(result.component.externalId).toBeNull();
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('retains the exact bound identity when an acknowledged update cannot be re-observed', async () => {
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS', '1');
    let clusterReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v2/account' && method === 'GET') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      if (url.pathname === '/v2/databases/do-valkey-1' && method === 'GET') {
        clusterReads += 1;
        return clusterReads === 1
          ? jsonResponse({
              database: {
                id: 'do-valkey-1',
                name: 'production-redis',
                engine: 'valkey',
                status: 'online',
                region: 'sfo3',
                size: 'db-s-1vcpu-1gb',
                num_nodes: 1,
              },
            })
          : jsonResponse({ message: 'temporarily unavailable' }, 503);
      }
      if (url.pathname === '/v2/databases/do-valkey-1/resize' && method === 'PUT') {
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      size: 'db-s-2vcpu-4gb',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        clusterId: 'do-valkey-1',
        mutationAttempted: true,
        acknowledgedOperations: ['resize'],
        observationError: expect.stringContaining('503'),
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'do-valkey-1',
      bindings: {
        provider: 'digitalocean',
        instanceId: 'do-valkey-1',
        providerScope: { accountUuid: 'do-account-uuid', region: 'sfo3' },
      },
    });
    expect(mutationCalls(fetchMock)).toHaveLength(1);
  });

  it('refuses to guess the current node count required by the resize API', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      return jsonResponse({
        database: {
          id: 'do-valkey-1',
          name: 'production-redis',
          engine: 'valkey',
          status: 'online',
          region: 'sfo3',
          size: 'db-s-1vcpu-1gb',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('redis', makeEnvironment(), {
      component: makeComponent(),
      size: 'db-s-2vcpu-4gb',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('refused to guess');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('observes a bound Valkey cluster by durable ID and propagates failures', async () => {
    let clusterReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      clusterReads += 1;
      return clusterReads === 1
        ? jsonResponse({
            database: {
              id: 'do-valkey-1',
              name: 'invoice-perfect-production-redis',
              engine: 'valkey',
              status: 'online',
            },
          })
        : jsonResponse({ message: 'forbidden' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).resolves.toMatchObject({
      provider: 'digitalocean',
      engine: 'redis',
      externalId: 'do-valkey-1',
      providerScope: { accountUuid: 'do-account-uuid' },
      status: 'running',
    });
    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/403/);
  });

  it('rejects a durable ID that resolves to a different engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'do-account-uuid' } });
      }
      return jsonResponse({
        database: {
          id: 'do-valkey-1',
          name: 'production-postgres',
          engine: 'pg',
          status: 'online',
        },
      });
    }));
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/not Redis-compatible Valkey/i);
  });

  it('treats provider-confirmed preflight absence as idempotent deletion', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname === '/v2/account'
        ? jsonResponse({ account: { uuid: 'do-account-uuid' } })
        : jsonResponse({ message: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.destroy(makeComponent());

    expect(receipt.success).toBe(true);
    expect(receipt.message).toContain('already absent');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('does not mistake a failed deletion preflight for absence', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname === '/v2/account'
        ? jsonResponse({ account: { uuid: 'do-account-uuid' } })
        : jsonResponse({ message: 'forbidden' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.destroy(makeComponent());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('403');
    expect(mutationCalls(fetchMock)).toEqual([]);
  });

  it('blocks observation and deletion when the binding belongs to another account', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return jsonResponse({ account: { uuid: 'another-do-account' } });
      }
      throw new Error(`resource request must not run: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeCache(makeEnvironment(), makeComponent())
    ).rejects.toThrow(
      /scope account do-account-uuid does not match connected account another-do-account/
    );
    await expect(adapter.destroy(makeComponent())).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(
        'scope account do-account-uuid does not match connected account another-do-account'
      ),
    });
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(mutationCalls(fetchMock)).toEqual([]);
  });
});
