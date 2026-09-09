import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import { inspectRailwayResources } from '../railway-inspection.driver.js';

function boundedInspectionAdapter(): RailwayAdapter {
  const details = {
    id: 'railway-project',
    name: 'app',
    environments: {
      edges: [
        {
          node: {
            id: 'railway-production',
            name: 'production',
            config: {
              buckets: {
                'bucket-1': { region: 'iad' },
                'bucket-2': { region: 'sjc' },
              },
            },
          },
        },
        {
          node: {
            id: 'railway-preview',
            name: 'preview',
            config: { buckets: { 'bucket-1': { region: 'iad' } } },
          },
        },
      ],
    },
    services: {
      edges: ['web', 'worker'].map((name) => ({
        node: {
          id: `railway-${name}`,
          name,
          repoTriggers: { edges: [] },
          serviceInstances: {
            edges: [
              {
                node: {
                  environmentId: 'railway-production',
                  domains: { serviceDomains: [], customDomains: [] },
                },
              },
              {
                node: {
                  environmentId: 'railway-preview',
                  domains: { serviceDomains: [], customDomains: [] },
                },
              },
            ],
          },
        },
      })),
    },
    plugins: {
      edges: [
        { node: { id: 'plugin-postgres', name: 'PostgreSQL' } },
        { node: { id: 'plugin-redis', name: 'Redis' } },
      ],
    },
    buckets: {
      edges: [
        { node: { id: 'bucket-1', name: 'uploads' } },
        { node: { id: 'bucket-2', name: 'documents' } },
      ],
    },
  };
  return {
    findProjectsByName: vi.fn(async () => [{ id: details.id, name: details.name }]),
    getProjectDetails: vi.fn(async () => details),
    getServiceVariables: vi.fn(async () => ({ DATABASE_URL: 'secret', REDIS_URL: 'secret' })),
  } as unknown as RailwayAdapter;
}

describe('Railway abandoned-environment inspection', () => {
  it('inventories one differently named PostgreSQL candidate per environment scope', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [{ id: 'railway-project', name: 'customer-platform' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'customer-platform',
        environments: {
          edges: [
            { node: { id: 'railway-production', name: 'production' } },
            { node: { id: 'railway-staging', name: 'staging' } },
          ],
        },
        services: {
          edges: [{
            node: {
              id: 'railway-db-service',
              name: 'primary-data',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [
                  {
                    node: {
                      environmentId: 'railway-production',
                      domains: { serviceDomains: [], customDomains: [] },
                      source: { image: 'postgres:17' },
                    },
                  },
                  {
                    node: {
                      environmentId: 'railway-staging',
                      domains: { serviceDomains: [], customDomains: [] },
                      source: { image: 'postgres:17' },
                    },
                  },
                ],
              },
            },
          }],
        },
        plugins: { edges: [] },
        buckets: { edges: [] },
      })),
      getServiceVariables: vi.fn(async () => {
        throw new Error('database inventory must not read variables');
      }),
    } as unknown as RailwayAdapter;

    const inspected = await inspectRailwayResources(adapter, {
      resource: 'database',
      limit: 25,
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [
        {
          id: 'railway-db-service',
          name: 'primary-data',
          engine: 'postgres',
          providerScope: {
            projectId: 'railway-project',
            environmentId: 'railway-production',
          },
        },
        {
          id: 'railway-db-service',
          name: 'primary-data',
          engine: 'postgres',
          providerScope: {
            projectId: 'railway-project',
            environmentId: 'railway-staging',
          },
        },
      ],
      partial: false,
    });
  });

  it('inventories Redis services and object storage without reading variables', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [{ id: 'railway-project', name: 'customer-platform' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'customer-platform',
        environments: {
          edges: [{
            node: {
              id: 'railway-production',
              name: 'production',
              config: { buckets: { 'bucket-1': { region: 'iad' } } },
            },
          }],
        },
        services: {
          edges: [{
            node: {
              id: 'railway-cache-service',
              name: 'customer-sessions',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'railway-production',
                    domains: { serviceDomains: [], customDomains: [] },
                    source: { image: 'redis:8' },
                  },
                }],
              },
            },
          }],
        },
        plugins: { edges: [] },
        buckets: { edges: [{ node: { id: 'bucket-1', name: 'documents' } }] },
      })),
      getServiceVariables: vi.fn(async () => {
        throw new Error('stateful inventory must not read variables');
      }),
    } as unknown as RailwayAdapter;

    await expect(inspectRailwayResources(adapter, { resource: 'cache', limit: 25 }))
      .resolves.toMatchObject({
        resource: 'cache',
        caches: [{
          id: 'railway-cache-service',
          name: 'customer-sessions',
          providerScope: { projectId: 'railway-project' },
        }],
      });
    await expect(inspectRailwayResources(adapter, { resource: 'storage', limit: 25 }))
      .resolves.toMatchObject({
        resource: 'storage',
        storage: [{
          id: 'bucket-1',
          name: 'documents',
          providerScope: { projectId: 'railway-project' },
        }],
      });
    expect((adapter as unknown as { getServiceVariables: ReturnType<typeof vi.fn> }).getServiceVariables)
      .not.toHaveBeenCalled();
  });

  it('keeps legacy plugins visible but marks their undocumented teardown path unsupported', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [{ id: 'railway-project', name: 'legacy-platform' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'legacy-platform',
        environments: { edges: [] },
        services: { edges: [] },
        plugins: { edges: [{ node: { id: 'plugin-postgres', name: 'PostgreSQL' } }] },
        buckets: { edges: [] },
      })),
      getServiceVariables: vi.fn(),
    } as unknown as RailwayAdapter;

    await expect(inspectRailwayResources(adapter, { resource: 'database', limit: 25 }))
      .resolves.toMatchObject({
        observation: 'present',
        databases: [{
          id: 'plugin-postgres',
          resourceKind: 'legacy-plugin',
          cleanupSupported: false,
          providerScope: { projectId: 'railway-project' },
        }],
      });
  });

  it('selects the exact named environment without mutating shared project services', async () => {
    const adapter = {
      findProjectsByName: vi.fn(async () => [{ id: 'railway-project', name: 'app' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'app',
        environments: {
          edges: [{ node: { id: 'railway-production', name: 'production', config: { buckets: {} } } }],
        },
        services: {
          edges: [{
            node: {
              id: 'railway-web',
              name: 'web',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'railway-production',
                    domains: { serviceDomains: [], customDomains: [] },
                  },
                }],
              },
            },
          }],
        },
        plugins: { edges: [] },
        buckets: { edges: [] },
      })),
      getServiceVariables: vi.fn(async () => ({})),
    } as unknown as RailwayAdapter;

    const inspected = await inspectRailwayResources(adapter, {
      resource: 'environment',
      limit: 25,
      project: { id: 'project-local', name: 'app' },
      environment: { id: 'environment-local', projectId: 'project-local', name: 'production' },
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'environment',
      project: { id: 'railway-project', name: 'app' },
      environment: { id: 'railway-production', name: 'production' },
      services: [{ id: 'railway-web', name: 'web' }],
    });
  });

  it('bounds every collection returned for an exact project inspection', async () => {
    const inspected = await inspectRailwayResources(boundedInspectionAdapter(), {
      resource: 'project',
      id: 'railway-project',
      limit: 1,
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'project',
      environments: [{ id: 'railway-production', name: 'production' }],
      services: [{ id: 'railway-web', name: 'web' }],
      components: [{ id: 'plugin-postgres', name: 'PostgreSQL' }],
      storage: [{ id: 'bucket-1', name: 'uploads' }],
      envVarNames: ['DATABASE_URL'],
      autoDetected: { production: 'production' },
      needsMapping: [],
      truncated: true,
      partial: true,
    });
    expect((inspected.environments as unknown[])).toHaveLength(1);
    expect((inspected.services as unknown[])).toHaveLength(1);
    expect((inspected.components as unknown[])).toHaveLength(1);
    expect((inspected.storage as unknown[])).toHaveLength(1);
    expect(Object.keys((inspected.services as Array<{ instancesByEnvironmentId: object }>)[0]!.instancesByEnvironmentId))
      .toEqual(['railway-production']);
    expect((inspected.storage as Array<{ environments: unknown[] }>)[0]!.environments).toHaveLength(1);
  });

  it('bounds environment inventories and marks the observation partial when truncated', async () => {
    const inspected = await inspectRailwayResources(boundedInspectionAdapter(), {
      resource: 'environment',
      limit: 1,
      project: { id: 'project-local', name: 'app' },
      environment: { id: 'environment-local', projectId: 'project-local', name: 'production' },
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'environment',
      environment: { id: 'railway-production', name: 'production' },
      services: [{ id: 'railway-web', name: 'web' }],
      components: [{ id: 'plugin-postgres', name: 'PostgreSQL' }],
      storage: [{ id: 'bucket-1', name: 'uploads' }],
      truncated: true,
      partial: true,
    });
    expect((inspected.services as unknown[])).toHaveLength(1);
    expect((inspected.components as unknown[])).toHaveLength(1);
    expect((inspected.storage as unknown[])).toHaveLength(1);
  });

  it('reports truncation when the account-level project listing reaches its limit', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [
        { id: 'railway-project-1', name: 'one' },
        { id: 'railway-project-2', name: 'two' },
      ]),
      getProjectDetails: vi.fn(async (id: string) => ({
        id,
        name: id,
        environments: { edges: [] },
        services: { edges: [] },
      })),
    } as unknown as RailwayAdapter;

    const inspected = await inspectRailwayResources(adapter, {
      resource: 'project',
      limit: 1,
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'project',
      projects: [{ railwayId: 'railway-project-1', name: 'one' }],
      truncated: true,
      partial: true,
    });
    expect((adapter as unknown as { getProjectDetails: ReturnType<typeof vi.fn> }).getProjectDetails)
      .toHaveBeenCalledTimes(1);
  });
});

describe('Railway exact service-instance inspection', () => {
  it.each([
    ['missing root field', {}],
    ['mismatched identity', {
      serviceInstance: {
        id: 'instance-1',
        serviceId: 'different-service',
        environmentId: 'railway-production',
        source: { image: 'postgres:17' },
      },
    }],
    ['malformed image', {
      serviceInstance: {
        id: 'instance-1',
        serviceId: 'railway-db-service',
        environmentId: 'railway-production',
        source: { image: 17 },
      },
    }],
  ])('treats %s as unknown rather than absence', async (_label, response) => {
    const adapter = new RailwayAdapter();
    const request = vi.fn(async () => response);
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    await expect(adapter.inspectServiceInstance(
      'railway-db-service',
      'railway-production'
    )).resolves.toMatchObject({ state: 'unknown' });
  });

  it('returns the exact instance image and scope when present', async () => {
    const adapter = new RailwayAdapter();
    const request = vi.fn(async () => ({
      serviceInstance: {
        id: 'instance-1',
        serviceId: 'railway-db-service',
        environmentId: 'railway-production',
        source: { image: 'postgres:17' },
      },
    }));
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    await expect(adapter.inspectServiceInstance(
      'railway-db-service',
      'railway-production'
    )).resolves.toEqual({
      state: 'present',
      instanceId: 'instance-1',
      serviceId: 'railway-db-service',
      environmentId: 'railway-production',
      sourceImage: 'postgres:17',
    });
  });
});
