import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { runMockDatabaseLifecycleContract } from '../../__tests__/database-lifecycle.contract.js';
import { FlyClient } from '../fly.client.js';
import { FlyDatabaseAdapter } from '../fly-database.adapter.js';
import type {
  FlyWireGuardConnectorConfig,
  FlyWireGuardTunnel,
  IFlyWireGuardConnector,
} from '../fly-wireguard.connector.js';

function environment(name = 'production'): Environment {
  const now = new Date();
  return {
    id: 'env-1',
    projectId: 'project-1',
    name,
    platformBindings: {},
    createdAt: now,
    updatedAt: now,
  };
}

function component(externalId = 'pg-cluster-1'): Component {
  const now = new Date();
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: {
      provider: 'fly',
      instanceId: externalId,
      database: 'app',
      organizationSlug: 'hypervibe-test',
    },
    createdAt: now,
    updatedAt: now,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function connected(): Promise<FlyDatabaseAdapter> {
  const adapter = new FlyDatabaseAdapter();
  await adapter.connect({
    apiToken: 'flyv1-test-token',
    organizationSlug: 'hypervibe-test',
  });
  return adapter;
}

function wireGuardPeerPrefix(): string {
  const identity = 'hypervibe-test:pg-cluster-1';
  return `hv-db-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}-`;
}

function fakeConnector(options: {
  verifyError?: Error;
  stop?: () => Promise<void>;
} = {}): {
  connector: IFlyWireGuardConnector;
  start: IFlyWireGuardConnector['start'];
  verify: IFlyWireGuardConnector['verify'];
  stop: () => Promise<void>;
} {
  const stop = options.stop ?? vi.fn(async () => undefined);
  const tunnel: FlyWireGuardTunnel = { port: 15_432, stop };
  const start = vi.fn(async (_config: FlyWireGuardConnectorConfig) => tunnel);
  const verify = options.verifyError
    ? vi.fn(async () => { throw options.verifyError; })
    : vi.fn(async () => undefined);
  return {
    connector: { start, verify },
    start,
    verify,
    stop,
  };
}

function installWireGuardApi(options: {
  initialPeers?: Array<{
    id: string;
    name: string;
    pubkey: string;
    region: string;
    peerip: string;
  }>;
  incompletePeerObservation?: boolean;
} = {}) {
  const peers = [...(options.initialPeers ?? [])];
  const mutations: string[] = [];
  const remotePublicKey = Buffer.alloc(32, 2).toString('base64');
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'GET') {
      return json({
        data: {
          id: 'pg-cluster-1',
          name: 'production-postgres',
          organization: { slug: 'hypervibe-test' },
          region: 'iad',
          plan: 'basic',
          status: 'ready',
          endpoints: {
            primary: {
              direct: { host: 'pg-cluster-1.internal', port: 5432 },
              pooler: { host: 'pooler.internal', port: 5432 },
            },
          },
        },
      });
    }
    if (
      url.pathname === '/v1/postgres/pg-cluster-1/users/hypervibe_app/credentials'
      && method === 'GET'
    ) {
      return json({
        data: { username: 'hypervibe_app', password: 'database-secret' },
      });
    }
    if (url.href === 'https://api.fly.io/graphql' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, any>;
      };
      if (body.query.includes('HypervibeFlyOrganization')) {
        return json({
          data: { organization: { id: 'org-1', slug: 'hypervibe-test' } },
        });
      }
      if (body.query.includes('HypervibeFlyWireGuardPeers')) {
        if (options.incompletePeerObservation) {
          return json({ data: { organization: { slug: 'hypervibe-test' } } });
        }
        return json({
          data: {
            organization: {
              slug: 'hypervibe-test',
              wireGuardPeers: { nodes: peers },
            },
          },
        });
      }
      if (body.query.includes('HypervibeAddFlyWireGuardPeer')) {
        mutations.push('add');
        const peer = {
          id: 'peer-1',
          name: body.variables.input.name,
          pubkey: body.variables.input.pubkey,
          region: body.variables.input.region,
          peerip: 'fdaa:1:2:a7b:1234:5678:9abc:deff',
        };
        peers.push(peer);
        return json({
          data: {
            addWireGuardPeer: {
              peerip: peer.peerip,
              endpointip: 'fly-wireguard.example.com',
              pubkey: remotePublicKey,
            },
          },
        });
      }
      if (body.query.includes('HypervibeRemoveFlyWireGuardPeer')) {
        mutations.push('remove');
        const name = body.variables.input.name;
        const index = peers.findIndex((peer) => peer.name === name);
        if (index >= 0) peers.splice(index, 1);
        return json({ data: { removeWireGuardPeer: { organization: { id: 'org-1' } } } });
      }
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, mutations, peers, remotePublicKey };
}

runMockDatabaseLifecycleContract({
  displayName: 'Fly Managed Postgres',
  externalIds: ['pg-cluster-1', 'pg-cluster-2'],
  resourceName: 'invoice-perfect-production-postgres',
  createAdapter: connected,
  makeEnvironment: environment,
  makeComponent: component,
  isListRequest: (url, init) =>
    url.pathname === '/v1/postgres' && (init?.method ?? 'GET') === 'GET',
  isItemRequest: (url, externalId, init) =>
    url.pathname === `/v1/postgres/${externalId}`
    && (init?.method ?? 'GET') === 'GET',
  listResponse: (clusters) => ({
    data: clusters.map((cluster) => ({
      ...cluster,
      organization: { slug: 'hypervibe-test' },
      region: 'iad',
      plan: 'basic',
      status: 'ready',
    })),
  }),
});

describe('FlyDatabaseAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('requires an organization-scoped token and organization slug', async () => {
    const adapter = new FlyDatabaseAdapter();
    await expect(adapter.connect({ apiToken: 'token' })).rejects.toThrow(
      /organizationSlug|organization slug/i
    );
  });

  it('rejects credentials returned for a different PostgreSQL user identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      data: { username: 'some_other_user', password: 'database-secret' },
    })));
    const client = new FlyClient('flyv1-test-token', 'hypervibe-test');

    await expect(client.getPostgresUserCredentials('pg-cluster-1', 'hypervibe_app'))
      .rejects.toThrow('exact PostgreSQL user hypervibe_app');
  });

  it('provisions a ready cluster, logical database, and dedicated user without leaking credentials in receipts', async () => {
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_READY_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_READY_DELAY_MS', '0');
    let clusterReads = 0;
    let databaseReads = 0;
    let userReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return json({ data: [] });
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          name: 'invoice-perfect-production-postgres',
          org_slug: 'hypervibe-test',
          region: 'yyz',
          plan: 'basic',
          disk_size_gb: 10,
          pg_major_version: '17',
          pool_mode: 'transaction',
        });
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'invoice-perfect-production-postgres',
            organization: { slug: 'hypervibe-test' },
            region: 'yyz',
            plan: 'basic',
            status: 'creating',
          },
        }, 201);
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'GET') {
        clusterReads += 1;
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'invoice-perfect-production-postgres',
            organization: { slug: 'hypervibe-test' },
            region: 'yyz',
            plan: 'basic',
            status: 'ready',
            endpoints: {
              primary: {
                direct: { host: 'direct.internal', port: 5432 },
                pooler: { host: 'pooler.internal', port: 5432 },
              },
            },
          },
        });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1/databases' && method === 'GET') {
        databaseReads += 1;
        return json({ data: databaseReads === 1 ? [] : [{ name: 'app' }] });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1/databases' && method === 'POST') {
        return json({ data: { name: 'app' } }, 201);
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1/users' && method === 'GET') {
        userReads += 1;
        return json({
          data: userReads === 1
            ? []
            : [{ username: 'hypervibe_app', role: 'schema_admin' }],
        });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1/users' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          username: 'hypervibe_app',
          role: 'schema_admin',
        });
        return json({ data: { username: 'hypervibe_app', role: 'schema_admin' } }, 201);
      }
      if (
        url.pathname === '/v1/postgres/pg-cluster-1/users/hypervibe_app/credentials'
        && method === 'GET'
      ) {
        return json({ data: { username: 'hypervibe_app', password: 'database-secret' } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'invoice-perfect-production-postgres',
      databaseName: 'app',
      region: 'yyz',
    });

    expect(result.receipt.success).toBe(true);
    expect(clusterReads).toBeGreaterThan(0);
    expect(result.component.externalId).toBe('pg-cluster-1');
    expect(result.component.bindings.organizationSlug).toBe('hypervibe-test');
    expect(result.component.bindings.providerScope).toEqual({
      organizationSlug: 'hypervibe-test',
    });
    expect(result.receipt.data).toMatchObject({
      clusterId: 'pg-cluster-1',
      organizationSlug: 'hypervibe-test',
    });
    expect(result.connectionUrl).toBe(
      'postgresql://hypervibe_app:database-secret@pooler.internal:5432/app?sslmode=require'
    );
    expect(result.envVars).toMatchObject({
      PGHOST: 'direct.internal',
      PGUSER: 'hypervibe_app',
      PGPASSWORD: 'database-secret',
      PGDATABASE: 'app',
    });
    expect(JSON.stringify(result.receipt)).not.toContain('database-secret');
    expect(JSON.stringify(result.receipt)).not.toContain('postgresql://');
  });

  it('blocks an unscoped cluster binding before provider observation or mutation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();
    const unscoped = component();
    delete unscoped.bindings.organizationSlug;

    const receipt = await adapter.destroy(unscoped);

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('missing its durable organization scope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains the requested organization scope when the scoped list omits it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      data: [{
        id: 'pg-cluster-1',
        name: 'production-postgres',
        region: 'iad',
        plan: 'basic',
        status: 'ready',
      }],
    })));
    const adapter = await connected();

    await expect(adapter.observeDatabase(environment(), null, {
      resourceName: 'production-postgres',
    })).resolves.toMatchObject({
      externalId: 'pg-cluster-1',
      providerScope: { organizationSlug: 'hypervibe-test' },
    });
  });

  it('retains but does not delete a provider-acknowledged ID with a mismatched name', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return json({ data: [] });
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        return json({
          data: {
            id: 'unrelated-cluster-id',
            name: 'unrelated-cluster',
            organization: { slug: 'hypervibe-test' },
            region: 'iad',
            plan: 'basic',
            status: 'ready',
          },
        }, 201);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('different cluster identity');
    expect(result.component).toMatchObject({
      externalId: 'unrelated-cluster-id',
      bindings: {
        provider: 'fly',
        instanceId: 'unrelated-cluster-id',
        providerScope: { organizationSlug: 'hypervibe-test' },
      },
    });
    expect(result.receipt.data).toMatchObject({
      clusterId: 'unrelated-cluster-id',
      cleanupRequired: true,
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('rolls back a created cluster whose observed region does not match the request', async () => {
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_DELETE_DELAY_MS', '0');
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return json({ data: [] });
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'production-postgres',
            organization: { slug: 'hypervibe-test' },
            region: 'yyz',
            plan: 'basic',
            status: 'creating',
          },
        }, 201);
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'GET') {
        if (deleted) return json({ error: 'not found' }, 404);
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'production-postgres',
            organization: { slug: 'hypervibe-test' },
            region: 'iad',
            plan: 'basic',
            status: 'ready',
          },
        });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'DELETE') {
        deleted = true;
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'production-postgres',
      region: 'yyz',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('did not converge');
    expect(result.receipt.data).toMatchObject({ rolledBack: true, cleanupRequired: false });
    expect(deleted).toBe(true);
  });

  it('accepts the documented capitalized Performance plan identifier', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return json({ data: [] });
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        expect(JSON.parse(String(init?.body)).plan).toBe('Performance');
        return json({ error: 'capacity unavailable' }, 503);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'production-postgres',
      size: 'Performance',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('503');
    expect(result.receipt.error).not.toContain('plan "Performance" is invalid');
  });

  it('rolls back and verifies absence when a downstream provisioning step fails', async () => {
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_DELETE_DELAY_MS', '0');
    let clusterReads = 0;
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        return json({ data: [] });
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'invoice-perfect-production-postgres',
            organization: { slug: 'hypervibe-test' },
            region: 'iad',
            plan: 'basic',
            status: 'creating',
          },
        }, 201);
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'GET') {
        clusterReads += 1;
        if (deleted) return json({ error: 'not found' }, 404);
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'invoice-perfect-production-postgres',
            organization: { slug: 'hypervibe-test' },
            region: 'iad',
            plan: 'basic',
            status: 'ready',
          },
        });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1/databases' && method === 'GET') {
        return json({ error: 'temporary database control-plane failure' }, 503);
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'DELETE') {
        deleted = true;
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      message: expect.stringContaining('partial cluster was removed'),
      data: {
        clusterId: 'pg-cluster-1',
        rolledBack: true,
        cleanupRequired: false,
      },
    });
    expect(result.component.externalId).toBeNull();
    expect(deleted).toBe(true);
    expect(clusterReads).toBeGreaterThanOrEqual(3);
  });

  it('recovers a unique created cluster after the create transport loses its response', async () => {
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_CREATE_RECOVERY_DELAY_MS', '0');
    let listReads = 0;
    const recovered = {
      id: 'pg-cluster-recovered',
      name: 'production-postgres',
      organization: { slug: 'hypervibe-test' },
      region: 'iad',
      plan: 'basic',
      status: 'creating',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') {
        listReads += 1;
        return json({ data: listReads < 3 ? [] : [recovered] });
      }
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      if (url.pathname === '/v1/postgres/pg-cluster-recovered' && method === 'GET') {
        return json({ data: recovered });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-recovered' && method === 'DELETE') {
        return json({ error: 'control plane unavailable' }, 503);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: { clusterId: 'pg-cluster-recovered', cleanupRequired: true },
    });
    expect(result.component).toMatchObject({
      externalId: 'pg-cluster-recovered',
      bindings: {
        provider: 'fly',
        providerScope: { organizationSlug: 'hypervibe-test' },
      },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['transport loss', () => { throw new Error('connection closed after request transmission'); }],
    ['HTTP 408', () => json({ error: 'request timeout' }, 408)],
  ])('retains an unresolved exact-name blocker when %s stays invisible', async (_label, createResult) => {
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_CREATE_RECOVERY_DELAY_MS', '0');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') return json({ data: [] });
      if (url.pathname === '/v1/postgres' && method === 'POST') return createResult();
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'production-postgres',
      region: 'iad',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        mutationAttempted: true,
        resourceCreated: 'unknown',
        unresolvedCreateRetained: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'fly',
        providerScope: { organizationSlug: 'hypervibe-test' },
        unresolvedMutation: {
          resourceKind: 'database',
          operation: 'create',
          resourceName: 'production-postgres',
          providerScope: { organizationSlug: 'hypervibe-test' },
        },
      },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not retain an unresolved blocker after a definitive create rejection', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres' && method === 'GET') return json({ data: [] });
      if (url.pathname === '/v1/postgres' && method === 'POST') {
        return json({ error: 'invalid plan' }, 422);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('postgres', environment(), {
      resourceName: 'production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBeNull();
    expect(result.component.bindings).not.toHaveProperty('unresolvedMutation');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
  });

  it('waits for provider-confirmed terminal absence before reporting deletion success', async () => {
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_DELETE_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_FLY_DATABASE_DELETE_DELAY_MS', '0');
    let reads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'GET') {
        reads += 1;
        if (reads >= 3) return json({ error: 'not found' }, 404);
        return json({
          data: {
            id: 'pg-cluster-1',
            name: 'production-postgres',
            organization: { slug: 'hypervibe-test' },
            status: reads === 1 ? 'ready' : 'deleting',
          },
        });
      }
      if (url.pathname === '/v1/postgres/pg-cluster-1' && method === 'DELETE') {
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(true);
    expect(reads).toBe(3);
    expect(fetchMock.mock.calls.filter((call) => (
      (call[1] as RequestInit | undefined)?.method === 'DELETE'
    ))).toHaveLength(1);
  });

  it('opens, verifies, and removes an exact operation-scoped private connector', async () => {
    const api = installWireGuardApi();
    const fake = fakeConnector();
    const adapter = new FlyDatabaseAdapter(fake.connector);
    await adapter.connect({
      apiToken: 'flyv1-test-token',
      organizationSlug: 'hypervibe-test',
    });

    const access = await adapter.acquireTemporaryDatabaseAccess(
      environment(),
      component(),
      5432
    );

    expect(access).toMatchObject({
      source: 'private_connector',
      endpoint: '127.0.0.1:15432',
      temporary: true,
    });
    expect(access.connectionUrl).toBe(
      'postgresql://hypervibe_app:database-secret@127.0.0.1:15432/app?sslmode=require'
    );
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({
      endpointIp: 'fly-wireguard.example.com',
      remoteHost: 'pg-cluster-1.internal',
      remotePort: 5432,
      remotePublicKey: api.remotePublicKey,
    }));
    expect(fake.verify).toHaveBeenCalledWith(access.connectionUrl);
    expect(api.mutations).toEqual(['add']);
    expect(JSON.stringify(api.fetchMock.mock.calls)).not.toContain('database-secret');

    await adapter.releaseTemporaryDatabaseAccess(environment(), component(), access);

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(api.mutations).toEqual(['add', 'remove']);
    expect(api.peers).toHaveLength(0);
  });

  it('does not create a connector when WireGuard peer observation is unknown', async () => {
    const api = installWireGuardApi({ incompletePeerObservation: true });
    const fake = fakeConnector();
    const adapter = new FlyDatabaseAdapter(fake.connector);
    await adapter.connect({
      apiToken: 'flyv1-test-token',
      organizationSlug: 'hypervibe-test',
    });

    await expect(adapter.acquireTemporaryDatabaseAccess(
      environment(),
      component(),
      5432
    )).rejects.toThrow('WireGuard peer observation was incomplete');

    expect(api.mutations).toEqual([]);
    expect(fake.start).not.toHaveBeenCalled();
  });

  it('blocks a possibly active matching connector without deleting it', async () => {
    const api = installWireGuardApi({
      initialPeers: [{
        id: 'stale-peer-1',
        name: `${wireGuardPeerPrefix()}existing`,
        pubkey: Buffer.alloc(32, 3).toString('base64'),
        region: 'iad',
        peerip: 'fdaa:1:2:a7b:1234:5678:9abc:deff',
      }],
    });
    const fake = fakeConnector();
    const adapter = new FlyDatabaseAdapter(fake.connector);
    await adapter.connect({
      apiToken: 'flyv1-test-token',
      organizationSlug: 'hypervibe-test',
    });

    await expect(adapter.acquireTemporaryDatabaseAccess(
      environment(),
      component(),
      5432
    )).rejects.toThrow('possibly active connector');

    expect(api.mutations).toEqual([]);
    expect(api.peers).toHaveLength(1);
  });

  it('removes the exact Fly peer when database verification fails', async () => {
    const api = installWireGuardApi();
    const fake = fakeConnector({ verifyError: new Error('database was unreachable') });
    const adapter = new FlyDatabaseAdapter(fake.connector);
    await adapter.connect({
      apiToken: 'flyv1-test-token',
      organizationSlug: 'hypervibe-test',
    });

    await expect(adapter.acquireTemporaryDatabaseAccess(
      environment(),
      component(),
      5432
    )).rejects.toThrow('database was unreachable');

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(api.mutations).toEqual(['add', 'remove']);
    expect(api.peers).toHaveLength(0);
  });

  it('retains cleanup identity so a failed local shutdown can be retried safely', async () => {
    const api = installWireGuardApi();
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('still stopping'))
      .mockResolvedValueOnce(undefined);
    const fake = fakeConnector({ stop });
    const adapter = new FlyDatabaseAdapter(fake.connector);
    await adapter.connect({
      apiToken: 'flyv1-test-token',
      organizationSlug: 'hypervibe-test',
    });
    const access = await adapter.acquireTemporaryDatabaseAccess(
      environment(),
      component(),
      5432
    );

    await expect(adapter.releaseTemporaryDatabaseAccess(
      environment(), component(), access
    )).rejects.toThrow('local connector');
    await expect(adapter.releaseTemporaryDatabaseAccess(
      environment(), component(), access
    )).resolves.toBeUndefined();
    await expect(adapter.releaseTemporaryDatabaseAccess(
      environment(), component(), access
    )).rejects.toThrow('not active');

    expect(stop).toHaveBeenCalledTimes(2);
    expect(api.mutations).toEqual(['add', 'remove']);
  });

  it('refuses to remove a WireGuard peer whose durable identity changed', async () => {
    const api = installWireGuardApi();
    const fake = fakeConnector();
    const adapter = new FlyDatabaseAdapter(fake.connector);
    await adapter.connect({
      apiToken: 'flyv1-test-token',
      organizationSlug: 'hypervibe-test',
    });
    const access = await adapter.acquireTemporaryDatabaseAccess(
      environment(),
      component(),
      5432
    );
    api.peers[0]!.id = 'replacement-peer';

    await expect(adapter.releaseTemporaryDatabaseAccess(
      environment(), component(), access
    )).rejects.toThrow('Fly.io peer');

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(api.mutations).toEqual(['add']);
    expect(api.peers).toHaveLength(1);
  });
});
