import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function graphqlError(
  message: string,
  code: string,
  path?: Array<string | number>
): Error {
  const error = new Error(message) as Error & {
    response: {
      status: number;
      errors: Array<{
        message: string;
        path?: Array<string | number>;
        extensions: { code: string };
      }>;
    };
  };
  error.response = {
    status: 200,
    errors: [{ message, ...(path ? { path } : {}), extensions: { code } }],
  };
  return error;
}

function schemaError(message = 'Unknown argument "workspaceId" on projectCreate'): Error {
  return graphqlError(message, 'GRAPHQL_VALIDATION_FAILED');
}

function makeEnv(bindings: Record<string, unknown> = {}): Environment {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter.ensureProject', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks an unbound same-name project as an explicit adoption candidate', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([{ id: 'railway-1', name: 'billforge' }]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('will not silently adopt');
    expect(receipt.error).toContain('hv_import');
    expect(receipt.data?.adoptionCandidateProjectId).toBe('railway-1');
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).not.toHaveBeenCalled();
  });

  it('does not replace a bound project when exact observation is unknown', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Railway request timed out'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const findProjects = vi.spyOn(adapter, 'findProjectsByName');

    const receipt = await adapter.ensureProject(
      'billforge',
      makeEnv({ projectId: 'railway-bound' })
    );

    expect(receipt).toMatchObject({
      success: false,
      data: { projectId: 'railway-bound', verification: 'unknown' },
    });
    expect(receipt.error).toContain('refused to replace or rebind');
    expect(findProjects).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).not.toContain('mutation');
  });

  it('does not replace or name-adopt a provider-confirmed absent bound project', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      graphqlError('Project not found', 'NOT_FOUND', ['project'])
    );
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const findProjects = vi.spyOn(adapter, 'findProjectsByName');

    const receipt = await adapter.ensureProject(
      'billforge',
      makeEnv({ projectId: 'railway-gone' })
    );

    expect(receipt).toMatchObject({
      success: false,
      data: { projectId: 'railway-gone', verification: 'absent' },
    });
    expect(receipt.error).toContain('will not silently create a replacement');
    expect(findProjects).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).not.toContain('mutation');
  });

  it('refuses to guess when multiple same-name projects are visible', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([
      { id: 'railway-1', name: 'billforge' },
      { id: 'railway-2', name: 'billforge' },
    ]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Multiple Railway projects named "billforge" are visible');
    expect(receipt.error).toContain('railway-1');
    expect(receipt.error).toContain('railway-2');
    expect(receipt.data?.duplicateProjectIds).toEqual(['railway-1', 'railway-2']);
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).not.toHaveBeenCalled();
  });

  it('refuses to create when existing-project lookup fails', async () => {
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = {
      request: vi.fn(),
    };
    vi.spyOn(adapter, 'findProjectsByName').mockRejectedValue(new Error('list unavailable'));

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('refused to create a new project');
    expect(receipt.error).toContain('list unavailable');
    expect((adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client.request).not.toHaveBeenCalled();
  });

  it('falls back to an alternate create shape only after structured schema validation', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(schemaError())
      .mockResolvedValueOnce({
        projectCreate: { id: 'railway-2', name: 'billforge' },
      })
      .mockResolvedValueOnce({
        project: { id: 'railway-2', name: 'billforge' },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    (adapter as unknown as { credentials: { workspaceId?: string } }).credentials = { workspaceId: 'ws-1' };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(true);
    expect(receipt.data?.projectId).toBe('railway-2');
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[0]?.[0])).toContain('workspaceId: $workspaceId');
    expect(String(request.mock.calls[1]?.[0])).toContain('teamId: $teamId');
    expect(String(request.mock.calls[2]?.[0])).toContain('query GetProjectIdentity');
  });

  it('does not retry project creation after a transport error', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('socket timed out after write'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    (adapter as unknown as { credentials: { workspaceId?: string } }).credentials = { workspaceId: 'ws-1' };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('socket timed out after write');
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain('mutation CreateProject');
  });

  it('does not retry project creation after a malformed acknowledgement', async () => {
    const request = vi.fn().mockResolvedValueOnce({ projectCreate: { name: 'billforge' } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    (adapter as unknown as { credentials: { workspaceId?: string } }).credentials = { workspaceId: 'ws-1' };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('without an id');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('waits for exact post-create project convergence without issuing another mutation', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({ projectCreate: { id: 'railway-eventual', name: 'billforge' } })
      .mockResolvedValueOnce({ project: null })
      .mockResolvedValueOnce({ project: { id: 'railway-eventual', name: 'billforge' } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    (adapter as unknown as { credentials: { workspaceId?: string } }).credentials = { workspaceId: 'ws-1' };
    vi.spyOn(adapter, 'findProjectsByName').mockResolvedValue([]);

    const receipt = await adapter.ensureProject('billforge', makeEnv());

    expect(receipt).toMatchObject({
      success: true,
      data: { projectId: 'railway-eventual', created: true },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.filter(([query]) => String(query).includes('mutation CreateProject'))).toHaveLength(1);
  });
});

describe('RailwayAdapter.ensureEnvironment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks an unbound same-name environment as an explicit adoption candidate', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      project: {
        id: 'railway-1',
        name: 'billforge',
        environments: {
          edges: [{ node: { id: 'rail-env-staging', name: 'staging' } }],
        },
        buckets: { edges: [] },
        services: { edges: [] },
        plugins: { edges: [] },
      },
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureEnvironment(makeEnv({ projectId: 'railway-1' }));

    expect(receipt).toMatchObject({
      success: false,
      data: {
        projectId: 'railway-1',
        adoptionCandidateEnvironmentId: 'rail-env-staging',
      },
    });
    expect(receipt.error).toContain('will not silently adopt');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('creates and verifies a missing environment in an already-bound project', async () => {
    const projectWithoutStaging = {
      id: 'railway-1',
      name: 'billforge',
      environments: { edges: [{ node: { id: 'rail-env-production', name: 'production' } }] },
      buckets: { edges: [] },
      services: { edges: [] },
      plugins: { edges: [] },
    };
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({ project: projectWithoutStaging })
      .mockResolvedValueOnce({
        environmentCreate: { id: 'rail-env-staging', name: 'staging' },
      })
      .mockResolvedValueOnce({ project: projectWithoutStaging })
      .mockResolvedValueOnce({
        project: {
          ...projectWithoutStaging,
          environments: {
            edges: [
              ...projectWithoutStaging.environments.edges,
              { node: { id: 'rail-env-staging', name: 'staging' } },
            ],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureEnvironment(makeEnv({ projectId: 'railway-1' }));

    expect(receipt).toMatchObject({
      success: true,
      data: {
        projectId: 'railway-1',
        environmentId: 'rail-env-staging',
        created: true,
      },
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.filter(([query]) => String(query).includes('mutation CreateEnvironment'))).toHaveLength(1);
  });

  it('does not retry environment creation after a transport error', async () => {
    const projectWithoutStaging = {
      id: 'railway-1',
      name: 'billforge',
      environments: { edges: [] },
      buckets: { edges: [] },
      services: { edges: [] },
      plugins: { edges: [] },
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ project: projectWithoutStaging })
      .mockRejectedValueOnce(new Error('connection reset after write'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureEnvironment(makeEnv({ projectId: 'railway-1' }));

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('connection reset after write');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([query]) => String(query).includes('mutation CreateEnvironment'))).toHaveLength(1);
  });

  it('does not retry environment creation after a malformed acknowledgement', async () => {
    const projectWithoutStaging = {
      id: 'railway-1',
      name: 'billforge',
      environments: { edges: [] },
      buckets: { edges: [] },
      services: { edges: [] },
      plugins: { edges: [] },
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ project: projectWithoutStaging })
      .mockResolvedValueOnce({ environmentCreate: { name: 'staging' } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureEnvironment(makeEnv({ projectId: 'railway-1' }));

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('without an id');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('falls back to the alternate environment create shape only after schema validation', async () => {
    const projectWithoutStaging = {
      id: 'railway-1',
      name: 'billforge',
      environments: { edges: [] },
      buckets: { edges: [] },
      services: { edges: [] },
      plugins: { edges: [] },
    };
    const projectWithStaging = {
      ...projectWithoutStaging,
      environments: { edges: [{ node: { id: 'rail-env-staging', name: 'staging' } }] },
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ project: projectWithoutStaging })
      .mockRejectedValueOnce(schemaError('Unknown argument "input" on environmentCreate'))
      .mockResolvedValueOnce({ environmentCreate: { id: 'rail-env-staging', name: 'staging' } })
      .mockResolvedValueOnce({ project: projectWithStaging });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureEnvironment(makeEnv({ projectId: 'railway-1' }));

    expect(receipt).toMatchObject({
      success: true,
      data: { environmentId: 'rail-env-staging', created: true },
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(String(request.mock.calls[1]?.[0])).toContain('environmentCreate(input:');
    expect(String(request.mock.calls[2]?.[0])).toContain('environmentCreate(projectId:');
  });

  it('does not create when environment observation fails', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Railway unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureEnvironment(makeEnv({ projectId: 'railway-1' }));

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Railway unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
