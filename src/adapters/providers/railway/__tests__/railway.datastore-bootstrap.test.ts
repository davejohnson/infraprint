import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(bindings: Record<string, unknown>): Environment {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function volumeInventory(
  environmentId: string,
  volumes: Array<{
    instanceId: string;
    volumeId: string;
    serviceId: string;
    mountPath: string;
    projectId?: string;
    deletedAt?: string | null;
    isPendingDeletion?: boolean;
  }> = [],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  }
) {
  return {
    environment: {
      id: environmentId,
      volumeInstances: {
        edges: volumes.map((volume) => ({
          node: {
            id: volume.instanceId,
            serviceId: volume.serviceId,
            environmentId,
            mountPath: volume.mountPath,
            deletedAt: volume.deletedAt ?? null,
            isPendingDeletion: volume.isPendingDeletion ?? false,
            volume: {
              id: volume.volumeId,
              projectId: volume.projectId ?? 'rail-proj-1',
            },
          },
        })),
        pageInfo,
      },
    },
  };
}

describe('RailwayAdapter datastore bootstrap vars', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('creates persistent Redis with a generated password and internal REDIS_URL', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-redis-1', name: 'redis-db-staging' },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockResolvedValueOnce({ volumeCreate: { id: 'redis-volume-1' } })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'redis-volume-instance-1',
        volumeId: 'redis-volume-1',
        serviceId: 'rail-svc-redis-1',
        mountPath: '/bitnami/redis/data',
      }]))
      .mockResolvedValueOnce({ serviceInstanceRedeploy: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('redis', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(true);
    expect(request.mock.calls[2]?.[1]).toEqual({
      input: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
        name: 'redis-db-staging',
        source: { image: 'bitnami/redis:7.4' },
      },
    });
    const variables = request.mock.calls[4]?.[1]?.variables as Record<string, string>;
    expect(variables.REDIS_PASSWORD).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(variables.ALLOW_EMPTY_PASSWORD).toBe('no');
    expect(variables.REDIS_URL).toContain('@redis-db-staging.railway.internal:6379');
    expect(request.mock.calls[6]?.[1]?.input).toMatchObject({
      serviceId: 'rail-svc-redis-1',
      mountPath: '/bitnami/redis/data',
    });
    expect(result.component.bindings).toMatchObject({
      providerScope: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
      },
      volumeId: 'redis-volume-1',
      volumeTarget: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
        serviceId: 'rail-svc-redis-1',
        mountPath: '/bitnami/redis/data',
      },
    });
  });

  it('sets bootstrap vars, attaches a volume, and redeploys after datastore creation', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices (none exists yet)
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [],
          },
        },
      })
      // serviceCreate
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db-staging' },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      // variableCollectionUpsert
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      // fully paginated volume preflight
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      // volumeCreate
      .mockResolvedValueOnce({
        volumeCreate: { id: 'vol-1' },
      })
      // read-after-write volume identity verification
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'volume-instance-1',
        volumeId: 'vol-1',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      }]))
      // serviceInstanceRedeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings).toMatchObject({ volumeId: 'vol-1' });
    const upsertVars = request.mock.calls[4]?.[1]?.variables as Record<string, string>;
    expect(upsertVars).toBeDefined();
    expect(typeof upsertVars.POSTGRES_PASSWORD).toBe('string');
    expect(upsertVars.POSTGRES_PASSWORD.length).toBeGreaterThan(0);
    expect(upsertVars.POSTGRES_USER).toBe('postgres');
    expect(upsertVars.POSTGRES_DB).toBe('postgres');
    // PGDATA must be a subdirectory of the mount (lost+found breaks initdb).
    expect(upsertVars.PGDATA).toBe('/var/lib/postgresql/data/pgdata');
    expect(typeof upsertVars.DATABASE_URL).toBe('string');

    // Volume attached at the postgres data dir.
    expect(request.mock.calls[6]?.[1]).toEqual({
      input: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      },
    });

    // Redeploy so the container boots with vars + volume (serviceCreate with
    // source.image already started a first deployment without them).
    expect(request.mock.calls[8]?.[1]).toEqual({
      serviceId: 'rail-svc-db-1',
      environmentId: 'rail-env-1',
    });
  });

  it('fails the provision when the volume cannot be attached', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({
        project: { services: { edges: [] } },
      })
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db-staging' },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockRejectedValueOnce(new Error('volume quota exceeded'))
      .mockResolvedValueOnce(volumeInventory('rail-env-1'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.message).toContain('failed to attach a volume');
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-db-1',
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1' },
        resourceKind: 'service',
        pluginName: 'postgres-db-staging',
        volumeTarget: {
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          serviceId: 'rail-svc-db-1',
          mountPath: '/var/lib/postgresql/data',
        },
      },
    });
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(1);
  });

  it('recovers one exact volume after a lost create response without retrying the mutation', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db-staging' } })
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'rail-env-1' } }] } },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockRejectedValueOnce(new Error('connection closed after volume request'))
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'volume-instance-recovered',
        volumeId: 'volume-recovered',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      }]))
      .mockResolvedValueOnce({ serviceInstanceRedeploy: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings).toMatchObject({
      volumeId: 'volume-recovered',
      volumeTarget: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      },
    });
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(1);
  });

  it('fails closed when a valid volume acknowledgement resolves to a different exact volume', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db-staging' } })
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'rail-env-1' } }] } },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockResolvedValueOnce({ volumeCreate: { id: 'acknowledged-volume' } })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'different-volume-instance',
        volumeId: 'different-volume',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      }]));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('acknowledged-volume');
    expect(result.component.bindings).toMatchObject({
      volumeId: 'different-volume',
      volumeTarget: { serviceId: 'rail-svc-db-1', mountPath: '/var/lib/postgresql/data' },
    });
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceInstanceRedeploy'))).toBe(false);
  });

  it('fully paginates the volume inventory before creating exactly one volume', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db-staging' } })
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'rail-env-1' } }] } },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'unrelated-instance',
        volumeId: 'unrelated-volume',
        serviceId: 'another-service',
        mountPath: '/data',
      }], { hasNextPage: true, endCursor: 'cursor-1' }))
      .mockResolvedValueOnce(volumeInventory('rail-env-1'))
      .mockResolvedValueOnce({ volumeCreate: { id: 'new-volume' } })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'new-volume-instance',
        volumeId: 'new-volume',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      }]))
      .mockResolvedValueOnce({ serviceInstanceRedeploy: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(true);
    const volumeReads = request.mock.calls.filter(([query]) => String(query).includes('EnvironmentVolumeInstances'));
    expect(volumeReads).toHaveLength(3);
    expect(volumeReads[0]?.[1]).toMatchObject({ after: null });
    expect(volumeReads[1]?.[1]).toMatchObject({ after: 'cursor-1' });
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(1);
  });

  it('does not create a volume when the exact target is already ambiguous', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db-staging' } })
      .mockResolvedValueOnce({
        service: { serviceInstances: { edges: [{ node: { environmentId: 'rail-env-1' } }] } },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce(volumeInventory('rail-env-1', [{
        instanceId: 'volume-instance-a',
        volumeId: 'volume-a',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      }, {
        instanceId: 'volume-instance-b',
        volumeId: 'volume-b',
        serviceId: 'rail-svc-db-1',
        mountPath: '/var/lib/postgresql/data',
      }]));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('Multiple active Railway volumes');
    expect(request.mock.calls.filter(([query]) => String(query).includes('volumeCreate'))).toHaveLength(0);
  });

  it('recovers and retains the exact service id when the create response is lost after commit', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(new Error('connection closed after request transmission'))
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-recovered', name: 'postgres-db-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-db-recovered',
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1' },
        resourceKind: 'service',
        pluginName: 'postgres-db-staging',
      },
    });
    expect(result.receipt.data).toMatchObject({
      mutationAttempted: true,
      recoveredServiceId: 'rail-svc-db-recovered',
    });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('retains a scoped unresolved marker when a transport failure cannot recover the service id', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(new Error('socket closed after request transmission'))
      .mockResolvedValueOnce({ project: { services: { edges: [] } } });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        unresolvedMutation: {
          resourceKind: 'database',
          operation: 'create',
          resourceName: 'postgres-db-staging',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        },
      },
    });
  });

  it('does not recover a same-name Redis service from a different Railway environment', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(new Error('socket closed after request transmission'))
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'redis-in-production', name: 'redis-db-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-production' } }],
          },
        },
      });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'redis',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        unresolvedMutation: {
          resourceKind: 'cache',
          resourceName: 'redis-db-staging',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        },
      },
    });
    expect(result.receipt.data).not.toHaveProperty('recoveredServiceId');
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('does not retain an unresolved marker for a definitive service-create HTTP 4xx', async () => {
    const definitiveError = Object.assign(new Error('invalid service input'), {
      response: { status: 400, errors: [] },
    });
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockRejectedValueOnce(definitiveError);

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({ resourceCreated: false });
    expect(result.component.externalId).toBeNull();
    expect(result.component.bindings).toEqual({});
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('recovers an exact service identity from a malformed create id and stops before follow-up mutations', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({ serviceCreate: { id: '', name: 'postgres-db-staging' } })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-recovered', name: 'postgres-db-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('stopped before');
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-db-recovered',
      bindings: {
        pluginName: 'postgres-db-staging',
        resourceKind: 'service',
      },
    });
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls.some(([query]) => (
      String(query).includes('serviceInstanceRedeploy')
      || String(query).includes('variableCollectionUpsert')
      || String(query).includes('volumeCreate')
    ))).toBe(false);
  });

  it('retains a valid wrong-name service id but never mutates that service', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: { environments: { edges: [{ node: { id: 'rail-env-1', name: 'staging' } }] } },
      })
      .mockResolvedValueOnce({ project: { services: { edges: [] } } })
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-unexpected', name: 'unrelated-service' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent(
      'postgres',
      makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' })
    );

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('unrelated-service');
    expect(result.component).toMatchObject({
      externalId: 'rail-svc-unexpected',
      bindings: { pluginName: 'unrelated-service', resourceKind: 'service' },
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('blocks an existing unbound postgres service without modifying it', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      // fetchServiceVariables — bootstrap vars are present
      .mockResolvedValueOnce({
        variables: { POSTGRES_PASSWORD: 'already-set', DATABASE_URL: 'postgres://...' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('hv_import');
    expect(result.receipt.data).toMatchObject({ adoptionCandidateServiceId: 'rail-svc-db-existing' });
    expect(result.component.externalId).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([query]) => String(query).includes('variableCollectionUpsert'))).toBe(false);
  });

  it('does not repair an unbound datastore from create authority', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // resolveServiceIdForProject -> listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-1' } }],
          },
        },
      })
      // fetchServiceVariables — POSTGRES_PASSWORD missing (crashlooping container)
      .mockResolvedValueOnce({
        variables: {},
      })
      // variableCollectionUpsert (repair)
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      // serviceInstanceRedeploy
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-1' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('will not mutate or adopt');
    expect(result.component.externalId).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([query]) => (
      String(query).includes('variableCollectionUpsert')
      || String(query).includes('serviceInstanceRedeploy')
    ))).toBe(false);
  });

  it('creates an environment-scoped datastore when the matching service only exists elsewhere', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment sees the matching service only in production.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        serviceCreate: {
          id: 'rail-svc-db-staging',
          name: 'postgres-db-staging',
        },
      })
      // ensureServiceInstanceForEnvironment verifies the newly created service.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      })
      .mockResolvedValueOnce(volumeInventory('rail-env-staging'))
      .mockResolvedValueOnce({
        volumeCreate: { id: 'vol-staging' },
      })
      .mockResolvedValueOnce(volumeInventory('rail-env-staging', [{
        instanceId: 'vol-instance-staging',
        volumeId: 'vol-staging',
        serviceId: 'rail-svc-db-staging',
        mountPath: '/var/lib/postgresql/data',
      }]))
      .mockResolvedValueOnce({
        serviceInstanceRedeploy: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-staging' }));

    expect(result.receipt.success).toBe(true);
    expect(result.receipt.message).toContain('Created postgres datastore');
    expect(result.component.externalId).toBe('rail-svc-db-staging');
    expect(result.component.bindings).toMatchObject({ volumeId: 'vol-staging' });
    expect(String(request.mock.calls[3]?.[0])).toContain('serviceCreate');
    expect(request.mock.calls[3]?.[1]).toEqual({
      input: {
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-staging',
        name: 'postgres-db-staging',
        source: {
          image: 'postgres:16',
        },
      },
    });
  });

  it('requires explicit adoption for an environment-scoped datastore after local bindings are missing', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [
              { node: { id: 'rail-svc-db-prod', name: 'postgres-db' } },
              { node: { id: 'rail-svc-db-staging', name: 'postgres-db-staging' } },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-prod' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'rail-env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        variables: { POSTGRES_PASSWORD: 'already-set', DATABASE_URL: 'postgres://...' },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-staging' }));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({ adoptionCandidateServiceId: 'rail-svc-db-staging' });
    expect(result.component.externalId).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceCreate'))).toBe(false);
  });

  it('does not create a duplicate datastore when environment-instance observation fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'rail-svc-db-existing', name: 'postgres-db-staging' } }],
          },
        },
      })
      .mockRejectedValueOnce(new Error('Railway service-instance read unavailable'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1', environmentId: 'rail-env-staging' })))
      .rejects.toThrow('Railway service-instance read unavailable');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceCreate'))).toBe(false);
  });
});
