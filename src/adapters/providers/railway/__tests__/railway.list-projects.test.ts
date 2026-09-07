import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

function graphqlSchemaError(message = 'Cannot query field "projects" on type "Query"'): Error {
  const error = new Error(message) as Error & {
    response: {
      status: number;
      errors: Array<{
        message: string;
        extensions: { code: string };
      }>;
    };
  };
  error.response = {
    status: 200,
    errors: [{ message, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
  };
  return error;
}

function adapterWith(request: ReturnType<typeof vi.fn>): RailwayAdapter {
  const adapter = new RailwayAdapter();
  (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
  return adapter;
}

describe('RailwayAdapter.listProjects', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the top-level projects query so workspace projects are included', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      projects: {
        edges: [
          { node: { id: 'p-personal', name: 'personal-app' } },
          { node: { id: 'p-workspace', name: 'workspace-app' } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const projects = await adapterWith(request).listProjects();

    expect(projects.map((p) => p.name)).toEqual(['personal-app', 'workspace-app']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toContain('projects(first: 100');
  });

  it('paginates through all pages', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-1', name: 'one' } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      })
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-2', name: 'two' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const projects = await adapterWith(request).listProjects();

    expect(projects.map((p) => p.id)).toEqual(['p-1', 'p-2']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ after: 'cursor-1' });
  });

  it('fails closed when a successful project page omits its continuation cursor', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      projects: {
        edges: [{ node: { id: 'p-1', name: 'one' } }],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    });

    await expect(adapterWith(request).listProjects()).rejects.toThrow(
      'reported another page without an end cursor'
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed when project pagination repeats a cursor', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-1', name: 'one' } }],
          pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
        },
      })
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-2', name: 'two' } }],
          pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
        },
      });

    await expect(adapterWith(request).listProjects()).rejects.toThrow(
      'repeated cursor "same-cursor"'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('falls back to paginated me.projects only when the first top-level query fails schema validation', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(graphqlSchemaError())
      .mockResolvedValueOnce({
        me: {
          projects: {
            edges: [{ node: { id: 'p-personal', name: 'personal-app' } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

    const projects = await adapterWith(request).listProjects();

    expect(projects.map((p) => p.id)).toEqual(['p-personal']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain('query ListPersonalProjects');
    expect(String(request.mock.calls[1]?.[0])).toContain('projects(first: 100, after: $after)');
  });

  it('does not fall back to a narrower inventory after authorization or transport failure', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Not authorized to query projects'));

    await expect(adapterWith(request).listProjects()).rejects.toThrow(
      'Not authorized to query projects'
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain('query ListProjects');
  });

  it('does not fall back when schema validation fails after a successful top-level page', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-1', name: 'one' } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      })
      .mockRejectedValueOnce(graphqlSchemaError('Unknown argument "after" on field "projects"'));

    await expect(adapterWith(request).listProjects()).rejects.toThrow(
      'failed schema validation after 1 successful page'
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([query]) => !String(query).includes('ListPersonalProjects'))).toBe(true);
  });

  it('bounds project pagination even when every page returns a fresh cursor', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_PROJECT_PAGE_LIMIT', '2');
    const request = vi.fn()
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-1', name: 'one' } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      })
      .mockResolvedValueOnce({
        projects: {
          edges: [{ node: { id: 'p-2', name: 'two' } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
        },
      });

    await expect(adapterWith(request).listProjects()).rejects.toThrow(
      'pagination exceeded 2 pages'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws when not connected', async () => {
    const adapter = new RailwayAdapter();
    await expect(adapter.listProjects()).rejects.toThrow('Not connected');
  });
});

describe('RailwayAdapter.isGitHubRepoAccessible', () => {
  it('returns hasAccess from gitHubRepoAccessAvailable', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      gitHubRepoAccessAvailable: { hasAccess: false, isPublic: false },
    });

    const accessible = await adapterWith(request).isGitHubRepoAccessible('dave/seq-planner');

    expect(accessible).toBe(false);
    expect(request.mock.calls[0]?.[1]).toEqual({ fullRepoName: 'dave/seq-planner' });
  });

  it('returns null when the query fails or the adapter is not connected', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Cannot query field'));
    expect(await adapterWith(request).isGitHubRepoAccessible('dave/seq-planner')).toBeNull();

    const adapter = new RailwayAdapter();
    expect(await adapter.isGitHubRepoAccessible('dave/seq-planner')).toBeNull();
  });
});
