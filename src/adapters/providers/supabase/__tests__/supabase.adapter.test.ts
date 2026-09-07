import { describe, expect, it, vi, afterEach } from 'vitest';
import { SupabaseAdapter } from '../supabase.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(name = 'production'): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name,
    platformBindings: {},
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

const DEFAULT_PROVIDER_SCOPE = {
  organizationId: 'org-1',
  region: 'us-east-1',
};

function organizationsResponse(
  organizations: Array<{ id: string; name?: string }> = [{ id: 'org-1', name: 'Primary' }]
): Response {
  return jsonResponse(organizations);
}

function isOrganizationList(url: string | URL | Request, init?: RequestInit): boolean {
  return String(url).endsWith('/organizations') && (init?.method ?? 'GET') === 'GET';
}

function makeComponent(
  externalId: string,
  bindings: Record<string, unknown> = {}
): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: {
      provider: 'supabase',
      providerScope: DEFAULT_PROVIDER_SCOPE,
      ...bindings,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('SupabaseAdapter.provision', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('inventories bounded databases with organization and region scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse([
          { id: 'db-1', name: 'customer-primary', organization_id: 'org-1', region: 'ca-central-1', status: 'ACTIVE_HEALTHY' },
          { id: 'db-2', name: 'analytics', organization_id: 'org-1', region: 'us-east-1', status: 'PAUSED' },
          { id: 'other-org', name: 'hidden', organization_id: 'org-2', region: 'us-west-1', status: 'ACTIVE_HEALTHY' },
        ]);
      }
      throw new Error(`unexpected request: ${init?.method} ${url}`);
    }));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.inspectDatabaseResources({ resource: 'database', limit: 1 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'db-1',
        engine: 'postgres',
        providerScope: { organizationId: 'org-1', region: 'ca-central-1' },
      }],
      truncated: true,
      partial: false,
    });
  });

  it('refuses to create a same-name project when one already exists', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse([
          { id: 'supabase-1', name: 'production-db', organization_id: 'org-1', region: 'us-east-1', status: 'ACTIVE_HEALTHY' },
        ]);
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('Supabase project "production-db" already exists');
    expect(result.receipt.error).toContain('supabase-1');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('refuses to create when existing-project lookup fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse({ message: 'forbidden' }, 403);
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('refused to create a new project');
    expect(result.receipt.error).toContain('Supabase API error: 403');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('refuses to create when the project inventory is malformed', async () => {
    const fetchMock = vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit
    ) => isOrganizationList(url, init)
      ? organizationsResponse()
      : jsonResponse({ projects: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('invalid project list');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('does not choose the first organization when a token can access multiple organizations', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (isOrganizationList(url, init)) {
        return organizationsResponse([
          { id: 'org-2', name: 'Secondary' },
          { id: 'org-1', name: 'Primary' },
        ]);
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('multiple organizations (org-1, org-2)');
    expect(result.receipt.error).toContain('set organizationId explicitly');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('creates a project only after proving no same-name project exists', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_READY_ATTEMPTS', '0');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') {
        return jsonResponse([]);
      }
      if (href.endsWith('/projects') && init?.method === 'POST') {
        return jsonResponse({
          id: 'supabase-new',
          name: 'production-db',
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'COMING_UP',
          database: {
            host: 'db.supabase-new.supabase.co',
            port: 5432,
            name: 'postgres',
            user: 'postgres',
            password: 'generated',
          },
        });
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe('supabase-new');
    expect(result.component.bindings.providerScope).toEqual({
      organizationId: 'org-1',
      region: 'us-east-1',
    });
    expect(result.receipt.error).toContain('did not become reachable');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/projects$/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('uses resourceName for provider identity instead of the logical database name', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_READY_ATTEMPTS', '0');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') return jsonResponse([]);
      if (href.endsWith('/projects') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string };
        return jsonResponse({
          id: 'supabase-scoped',
          name: body.name,
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'COMING_UP',
        });
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'), {
      databaseName: 'app',
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: 'supabase-scoped',
      bindings: {
        provider: 'supabase',
        providerScope: { organizationId: 'org-1', region: 'us-east-1' },
      },
    });
    const create = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      name: 'invoice-perfect-production-postgres',
    });
  });

  it('recovers a unique project when the create transport loses its response', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_SUPABASE_CREATE_RECOVERY_DELAY_MS', '0');
    let projectReads = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') {
        projectReads += 1;
        return jsonResponse(projectReads < 3 ? [] : [{
          id: 'supabase-recovered',
          name: 'production-db',
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'COMING_UP',
        }]);
      }
      if (href.endsWith('/projects') && init?.method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        projectId: 'supabase-recovered',
        organizationId: 'org-1',
        region: 'us-east-1',
        mutationAttempted: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'supabase-recovered',
      bindings: {
        provider: 'supabase',
        providerScope: { organizationId: 'org-1', region: 'us-east-1' },
      },
    });
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
      .toHaveLength(1);
  });

  it('retains an unresolved scoped marker when a lost create stays invisible', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_SUPABASE_CREATE_RECOVERY_DELAY_MS', '0');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') return jsonResponse([]);
      if (href.endsWith('/projects') && init?.method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

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
        provider: 'supabase',
        providerScope: { organizationId: 'org-1', region: 'us-east-1' },
        unresolvedMutation: {
          resourceKind: 'database',
          operation: 'create',
          resourceName: 'production-db',
          providerScope: { organizationId: 'org-1', region: 'us-east-1' },
        },
      },
    });
  });

  it('does not retain an unresolved marker after a definitive 4xx create rejection', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') return jsonResponse([]);
      if (href.endsWith('/projects') && init?.method === 'POST') {
        return jsonResponse({ message: 'invalid region' }, 422);
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.component.bindings).not.toHaveProperty('unresolvedMutation');
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'GET')).toHaveLength(2);
  });

  it('retains a provider-acknowledged project ID when create metadata is mismatched', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects') && init?.method === 'GET') return jsonResponse([]);
      if (href.endsWith('/projects') && init?.method === 'POST') {
        return jsonResponse({
          id: 'supabase-acknowledged',
          name: 'wrong-name',
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'COMING_UP',
        }, 201);
      }
      throw new Error(`unexpected request: ${init?.method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });

    const result = await adapter.provision('postgres', makeEnv('production'));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('without the exact expected');
    expect(result.component).toMatchObject({
      externalId: 'supabase-acknowledged',
      bindings: {
        provider: 'supabase',
        instanceId: 'supabase-acknowledged',
        providerScope: { organizationId: 'org-1', region: 'us-east-1' },
      },
    });
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
      .toHaveLength(1);
  });

  it('observes a bound project by external id and propagates non-404 read failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(organizationsResponse())
      .mockResolvedValueOnce(jsonResponse({
        id: 'supabase-1',
        name: 'invoice-perfect-production-postgres',
        organization_id: 'org-1',
        region: 'us-east-1',
        status: 'ACTIVE_HEALTHY',
      }))
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-1');

    await expect(adapter.observeDatabase(makeEnv(), component)).resolves.toMatchObject({
      externalId: 'supabase-1',
      status: 'running',
    });
    await expect(adapter.observeDatabase(makeEnv(), component)).rejects.toThrow(/503/);
  });

  it('does not turn a connection-detail observation failure into a missing URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      isOrganizationList(url, init)
        ? organizationsResponse()
        : jsonResponse({ message: 'unavailable' }, 503)));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-1');

    await expect(adapter.getConnectionUrl(component)).rejects.toThrow(/503/);
  });

  it('returns a missing connection URL only when Supabase confirms project absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      isOrganizationList(url, init)
        ? organizationsResponse()
        : jsonResponse({ message: 'not found' }, 404)));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-missing');

    await expect(adapter.getConnectionUrl(component)).resolves.toBeNull();
  });

  it('waits for terminal absence after Supabase accepts deletion', async () => {
    vi.stubEnv('HYPERVIBE_SUPABASE_DELETE_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_SUPABASE_DELETE_DELAY_MS', '0');
    let projectRead = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (href.endsWith('/projects/supabase-1') && method === 'GET') {
        projectRead += 1;
        return projectRead < 3
          ? jsonResponse({
              id: 'supabase-1',
              name: 'invoice-perfect-production-postgres',
              organization_id: 'org-1',
              region: 'us-east-1',
              status: projectRead === 1 ? 'ACTIVE_HEALTHY' : 'GOING_DOWN',
            })
          : jsonResponse({ message: 'not found' }, 404);
      }
      if (href.endsWith('/projects/supabase-1') && method === 'DELETE') {
        return jsonResponse({});
      }
      throw new Error(`unexpected request: ${method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-1');

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Deleted Supabase project');
    expect(projectRead).toBe(3);
  });

  it('treats an already-absent Supabase project as idempotent success', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (isOrganizationList(url, init)) return organizationsResponse();
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ message: 'not found' }, 404);
      throw new Error(`unexpected request: ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-missing');

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('treats a not-found race during Supabase deletion as idempotent success', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (isOrganizationList(url, init)) return organizationsResponse();
      if (method === 'GET') {
        return jsonResponse({
          id: 'supabase-race',
          name: 'invoice-perfect-production-postgres',
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'GOING_DOWN',
        });
      }
      if (method === 'DELETE') return jsonResponse({ message: 'not found' }, 404);
      throw new Error(`unexpected request: ${method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-race');

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
  });

  it('does not mistake a failed Supabase deletion preflight for absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      isOrganizationList(url, init)
        ? organizationsResponse()
        : jsonResponse({ message: 'unavailable' }, 503)));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-unknown');

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
  });

  it('does not delete after a malformed successful exact-project lookup', async () => {
    const fetchMock = vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit
    ) => isOrganizationList(url, init) ? organizationsResponse() : jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
    const component = makeComponent('supabase-unknown');

    const result = await adapter.destroy(component);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('absence was not confirmed');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });
});
