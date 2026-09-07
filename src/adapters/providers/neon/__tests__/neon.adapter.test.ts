import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import {
  runMockDatabaseLifecycleContract,
} from '../../__tests__/database-lifecycle.contract.js';
import { NeonAdapter } from '../neon.adapter.js';

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

function makeComponent(externalId = 'neon-project-1'): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: {
      provider: 'neon',
      instanceId: externalId,
      providerScope: {
        projectId: externalId,
        organizationId: 'org-hypervibe',
        regionId: 'aws-us-west-2',
      },
      database: 'app',
      roleName: 'app_owner',
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

async function connectedAdapter(): Promise<NeonAdapter> {
  const adapter = new NeonAdapter();
  await adapter.connect({
    apiKey: 'neon-api-key',
    organizationId: 'org-hypervibe',
    regionId: 'aws-us-west-2',
  });
  return adapter;
}

runMockDatabaseLifecycleContract({
  displayName: 'Neon',
  externalIds: ['neon-project-1', 'neon-project-2'],
  resourceName: 'invoice-perfect-production-postgres',
  createAdapter: connectedAdapter,
  makeEnvironment,
  makeComponent,
  isListRequest: (url, init) =>
    url.pathname === '/api/v2/projects' && (init?.method ?? 'GET') === 'GET',
  isItemRequest: (url, externalId, init) =>
    url.pathname === `/api/v2/projects/${externalId}` && (init?.method ?? 'GET') === 'GET',
  listResponse: (projects) => ({ projects, pagination: {} }),
});

describe('NeonAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('inventories bounded projects with durable organization scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      projects: [
        { id: 'neon-1', name: 'customer-primary', org_id: 'org-hypervibe', region_id: 'aws-us-west-2', pg_version: 17 },
        { id: 'neon-2', name: 'analytics', org_id: 'org-hypervibe', region_id: 'aws-us-east-1', pg_version: 16 },
      ],
      pagination: {},
    })));
    const adapter = await connectedAdapter();

    const result = await adapter.inspectDatabaseResources({ resource: 'database', limit: 1 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'neon-1',
        engine: 'postgres',
        providerScope: { projectId: 'neon-1', organizationId: 'org-hypervibe', regionId: 'aws-us-west-2' },
      }],
      truncated: true,
      partial: false,
    });
  });

  it('validates credentials instead of accepting an unchecked cast', async () => {
    const adapter = new NeonAdapter();

    await expect(adapter.connect({ organizationId: 'org-hypervibe' })).rejects.toThrow(
      /api key/i
    );
  });

  it('verifies bearer credentials in the selected organization', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
        projects: [],
        pagination: {},
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.verify()).resolves.toEqual({ success: true });

    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe('/api/v2/projects');
    expect(url.searchParams.get('org_id')).toBe('org-hypervibe');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer neon-api-key',
    });
  });

  it('creates only after complete absence, waits for operations, then retrieves both URIs', async () => {
    vi.stubEnv('HYPERVIBE_NEON_OPERATION_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_NEON_OPERATION_ATTEMPTS', '4');
    let operationRead = 0;
    const directUri = 'postgresql://app_owner:direct-secret@ep-neon.us-west-2.aws.neon.tech/app?sslmode=require';
    const pooledUri = 'postgresql://app_owner:pooled-secret@ep-neon-pooler.us-west-2.aws.neon.tech/app?sslmode=require';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';

      if (url.pathname === '/api/v2/projects' && method === 'GET') {
        return jsonResponse({ projects: [], pagination: {} });
      }
      if (url.pathname === '/api/v2/projects' && method === 'POST') {
        return jsonResponse({
          project: {
            id: 'neon-created',
            name: 'invoice-perfect-production-postgres',
            region_id: 'aws-us-west-2',
          },
          branch: { id: 'br-main', name: 'main' },
          databases: [{ name: 'app', owner_name: 'app_owner' }],
          roles: [
            { name: 'protected_role', protected: true },
            { name: 'app_owner', protected: false },
          ],
          endpoints: [{ id: 'ep-primary', host: 'ep-neon.us-west-2.aws.neon.tech' }],
          operations: [{ id: 'op-create', project_id: 'neon-created', status: 'running' }],
        }, 201);
      }
      if (
        url.pathname === '/api/v2/projects/neon-created/operations/op-create'
        && method === 'GET'
      ) {
        operationRead += 1;
        return jsonResponse({
          operation: {
            id: 'op-create',
            project_id: 'neon-created',
            status: operationRead === 1 ? 'running' : 'finished',
          },
        });
      }
      if (
        url.pathname === '/api/v2/projects/neon-created/connection_uri'
        && method === 'GET'
      ) {
        return jsonResponse({
          uri: url.searchParams.get('pooled') === 'true' ? pooledUri : directUri,
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-postgres',
      databaseName: 'app',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('neon-created');
    expect(result.connectionUrl).toBe(directUri);
    expect(result.component.bindings).toMatchObject({
      provider: 'neon',
      instanceId: 'neon-created',
      providerScope: {
        projectId: 'neon-created',
        organizationId: 'org-hypervibe',
        regionId: 'aws-us-west-2',
      },
      connectionString: directUri,
      pooledUrl: pooledUri,
      database: 'app',
      roleName: 'app_owner',
      branchId: 'br-main',
      endpointId: 'ep-primary',
    });
    expect(result.envVars).toMatchObject({
      DATABASE_URL: pooledUri,
      DIRECT_URL: directUri,
    });
    expect(JSON.stringify(result.receipt)).not.toContain('direct-secret');
    expect(JSON.stringify(result.receipt)).not.toContain('pooled-secret');
    expect(operationRead).toBe(2);

    const createCall = fetchMock.mock.calls.find((call) => {
      const [rawUrl, init] = call as [string, RequestInit];
      return new URL(rawUrl).pathname === '/api/v2/projects' && init.method === 'POST';
    }) as [string, RequestInit] | undefined;
    expect(createCall).toBeDefined();
    expect(new URL(createCall![0]).searchParams.get('org_id')).toBe('org-hypervibe');
    expect(JSON.parse(String(createCall![1].body))).toEqual({
      project: {
        name: 'invoice-perfect-production-postgres',
        region_id: 'aws-us-west-2',
        branch: {
          name: 'main',
          database_name: 'app',
        },
      },
    });
  });

  it('preserves the created project identity when readiness cannot be proven', async () => {
    vi.stubEnv('HYPERVIBE_NEON_OPERATION_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_NEON_OPERATION_ATTEMPTS', '2');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/v2/projects' && method === 'GET') {
        return jsonResponse({ projects: [], pagination: {} });
      }
      if (url.pathname === '/api/v2/projects' && method === 'POST') {
        return jsonResponse({
          project: { id: 'neon-pending', name: 'production-db', region_id: 'aws-us-west-2' },
          branch: { id: 'br-main', name: 'main' },
          databases: [{ name: 'app' }],
          roles: [{ name: 'app_owner' }],
          endpoints: [{ id: 'ep-primary' }],
          operations: [{ id: 'op-create', project_id: 'neon-pending', status: 'failed' }],
        }, 201);
      }
      if (url.pathname.endsWith('/operations/op-create') && method === 'GET') {
        return jsonResponse({
          operation: {
            id: 'op-create',
            project_id: 'neon-pending',
            status: 'failed',
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment());

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('neon-pending');
    expect(result.component.bindings).toMatchObject({
      provider: 'neon',
      instanceId: 'neon-pending',
      providerScope: {
        projectId: 'neon-pending',
        organizationId: 'org-hypervibe',
        regionId: 'aws-us-west-2',
      },
    });
    expect(result.receipt.data).toMatchObject({
      projectId: 'neon-pending',
      operationId: 'op-create',
      operationStatus: 'failed',
    });
    expect(result.connectionUrl).toBeUndefined();
  });

  it('recovers a unique project when the create transport loses its response', async () => {
    vi.stubEnv('HYPERVIBE_NEON_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_NEON_CREATE_RECOVERY_DELAY_MS', '0');
    let listReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/v2/projects' && method === 'GET') {
        listReads += 1;
        return jsonResponse({
          projects: listReads < 3 ? [] : [{
            id: 'neon-recovered',
            name: 'production-db',
            org_id: 'org-hypervibe',
            region_id: 'aws-us-west-2',
          }],
          pagination: {},
        });
      }
      if (url.pathname === '/api/v2/projects' && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'production-db',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: { projectId: 'neon-recovered', regionId: 'aws-us-west-2' },
    });
    expect(result.component).toMatchObject({
      externalId: 'neon-recovered',
      bindings: {
        provider: 'neon',
        providerScope: {
          projectId: 'neon-recovered',
          organizationId: 'org-hypervibe',
          regionId: 'aws-us-west-2',
        },
      },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('retains an unresolved scoped create marker when transport recovery stays empty', async () => {
    vi.stubEnv('HYPERVIBE_NEON_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_NEON_CREATE_RECOVERY_DELAY_MS', '0');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/v2/projects' && method === 'GET') {
        return jsonResponse({ projects: [], pagination: {} });
      }
      if (url.pathname === '/api/v2/projects' && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'production-db',
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
        provider: 'neon',
        providerScope: { organizationId: 'org-hypervibe' },
        unresolvedMutation: {
          resourceKind: 'database',
          operation: 'create',
          resourceName: 'production-db',
          providerScope: { organizationId: 'org-hypervibe' },
        },
      },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not retain an unresolved marker after a definitive 4xx create rejection', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/v2/projects' && method === 'GET') {
        return jsonResponse({ projects: [], pagination: {} });
      }
      if (url.pathname === '/api/v2/projects' && method === 'POST') {
        return jsonResponse({ message: 'invalid region' }, 422);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'production-db',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.bindings).not.toHaveProperty('unresolvedMutation');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
  });

  it('retains a provider-acknowledged project ID when create metadata is mismatched', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/v2/projects' && method === 'GET') {
        return jsonResponse({ projects: [], pagination: {} });
      }
      if (url.pathname === '/api/v2/projects' && method === 'POST') {
        return jsonResponse({
          project: {
            id: 'neon-acknowledged',
            name: 'wrong-name',
            org_id: 'org-hypervibe',
            region_id: 'aws-us-west-2',
          },
        }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'production-db',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('without the exact expected');
    expect(result.component).toMatchObject({
      externalId: 'neon-acknowledged',
      bindings: {
        provider: 'neon',
        instanceId: 'neon-acknowledged',
        providerScope: {
          projectId: 'neon-acknowledged',
          organizationId: 'org-hypervibe',
          regionId: 'aws-us-west-2',
        },
      },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('observes a bound project by durable ID and propagates non-404 failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        project: {
          id: 'neon-project-1',
          name: 'invoice-perfect-production-postgres',
          region_id: 'aws-us-west-2',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeDatabase(makeEnvironment(), makeComponent())
    ).resolves.toMatchObject({
      provider: 'neon',
      engine: 'postgres',
      externalId: 'neon-project-1',
      name: 'invoice-perfect-production-postgres',
      status: 'running',
    });
    await expect(
      adapter.observeDatabase(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/503/);
  });

  it('does not turn a malformed exact project response into absence', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(
      adapter.observeDatabase(makeEnvironment(), makeComponent())
    ).rejects.toThrow(/invalid project response.*absence was not confirmed/i);
    await expect(adapter.destroy(makeComponent())).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('absence was not confirmed'),
    });
    expect(fetchMock.mock.calls.every((call) =>
      ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET'
    )).toBe(true);
  });

  it('does not infer not-found from an arbitrary transport error message', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('socket closed after Neon API error: 404 from an intermediary');
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    await expect(adapter.destroy(makeComponent())).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('socket closed'),
    });
  });

  it('blocks a bound project before lookup when the selected organization changed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();
    const component = makeComponent();
    component.bindings.providerScope = {
      projectId: component.externalId,
      organizationId: 'org-other',
      regionId: 'aws-us-west-2',
    };

    await expect(
      adapter.observeDatabase(makeEnvironment(), component)
    ).rejects.toThrow(
      /scope organization org-other does not match connected organization org-hypervibe/
    );
    await expect(adapter.destroy(component)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(
        'scope organization org-other does not match connected organization org-hypervibe'
      ),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks an incomplete project list instead of treating it as absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      projects: [],
      unavailable_project_ids: ['neon-unavailable'],
      pagination: {},
    })));
    const adapter = await connectedAdapter();

    await expect(adapter.observeDatabase(makeEnvironment())).rejects.toThrow(
      /incomplete/i
    );
  });

  it('blocks project inventories with missing durable identities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      projects: [{ name: 'some-other-project' }],
      pagination: {},
    })));
    const adapter = await connectedAdapter();

    const result = await adapter.provision('postgres', makeEnvironment(), {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({ success: false });
    expect(result.receipt.error).toContain('without a durable ID and name');
  });

  it('waits until a deleted project is terminally absent', async () => {
    vi.stubEnv('HYPERVIBE_NEON_DELETE_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_NEON_DELETE_ATTEMPTS', '4');
    let projectRead = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/v2/projects/neon-project-1' && method === 'GET') {
        projectRead += 1;
        return projectRead < 3
          ? jsonResponse({
              project: {
                id: 'neon-project-1',
                name: 'invoice-perfect-production-postgres',
                region_id: 'aws-us-west-2',
              },
            })
          : jsonResponse({ message: 'not found' }, 404);
      }
      if (url.pathname === '/api/v2/projects/neon-project-1' && method === 'DELETE') {
        return jsonResponse({
          project: {
            id: 'neon-project-1',
            name: 'invoice-perfect-production-postgres',
          },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connectedAdapter();

    const receipt = await adapter.destroy(makeComponent());

    expect(receipt.success).toBe(true);
    expect(receipt.message).toContain('Deleted Neon project');
    expect(projectRead).toBe(3);
  });
});
