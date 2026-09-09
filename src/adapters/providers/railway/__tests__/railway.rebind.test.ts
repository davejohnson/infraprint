import { describe, expect, it, vi } from 'vitest';
import { ClientError } from 'graphql-request';
import { GraphQLError } from 'graphql';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

function makeEnv(bindings: Record<string, unknown>): Environment {
  return {
    id: 'env-local',
    projectId: 'proj-local',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeService(name: string): Service {
  return {
    id: `svc-${name}`,
    projectId: 'proj-local',
    name,
    buildConfig: {},
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter stale binding recovery', () => {
  it('refuses to re-resolve a stale environment binding by name before variableCollectionUpsert', async () => {
    const request = vi.fn()
      // listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-new', name: 'staging' } }],
          },
        },
      })
      // listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-new', name: 'web' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment verifies the candidate.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-new' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-new' } }],
          },
        },
      })
      // variableCollectionUpsert
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const env = makeEnv({
      projectId: 'proj-railway',
      environmentId: 'env-stale',
      services: {
        web: { serviceId: 'svc-stale' },
      },
    });

    const receipt = await adapter.setEnvVars(env, makeService('web'), { DATABASE_URL: 'postgres://x' });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Bound Railway environment env-stale is absent');
    expect(receipt.error).toContain('will not silently rebind');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([query]) => String(query).includes('variableCollectionUpsert'))).toBe(false);
  });

  it('marks a bound project-level service as stale when it has no instance in the target environment', async () => {
    const request = vi.fn()
      // listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      // listProjectServices includes the bound service, but it is not usable in staging.
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-prod-web', name: 'web' } }],
          },
        },
      })
      // resolveServiceIdForEnvironment rejects the production-only service.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-production' } }],
          },
        },
      })
      // ensureServiceInstanceForEnvironment confirms it is still absent in staging.
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-production' } }],
          },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const env = makeEnv({
      projectId: 'proj-railway',
      environmentId: 'env-staging',
      services: {
        web: { serviceId: 'svc-prod-web' },
      },
    });

    const receipt = await adapter.setEnvVars(env, makeService('web'), { DATABASE_URL: 'postgres://x' });

    expect(receipt.success).toBe(false);
    expect(receipt.message).toContain('missing an instance in environment staging');
    expect(receipt.data).toMatchObject({
      phase: 'ensureServiceInstance',
      serviceId: 'svc-prod-web',
      environmentId: 'env-staging',
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some(([query]) => String(query).includes('variableCollectionUpsert'))).toBe(false);
  });

  it('stages variable updates without triggering a deployment when requested', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({ variableCollectionUpsert: true })
      .mockResolvedValueOnce({
        serviceInstance: {
          latestDeployment: { id: 'deployment-before-config', status: 'SUCCESS' },
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.setEnvVars(
      makeEnv({
        projectId: 'proj-railway',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
      }),
      makeService('web'),
      { NEW_API_TOKEN: 'secret-value' },
      { deferDeployment: true }
    );

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      deploymentDeferred: true,
      runtimeRolloutRequired: true,
      rolloutBaseline: { state: 'present', deploymentId: 'deployment-before-config' },
    });
    const upsertCall = request.mock.calls.find(([query]) => String(query).includes('variableCollectionUpsert'))!;
    expect(String(upsertCall[0])).toContain('skipDeploys');
    expect(upsertCall[1]).toMatchObject({ skipDeploys: true });
  });

  it('scrubs exact environment values from GraphQL failures returned to direct callers', async () => {
    const suppliedValue = 'generated-session-secret-graphql-sentinel';
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockRejectedValueOnce(new ClientError(
        {
          errors: [new GraphQLError(`Railway rejected ${suppliedValue}`, {
            path: ['variableCollectionUpsert'],
            extensions: { code: 'BAD_USER_INPUT' },
          })],
          status: 400,
          headers: new Headers(),
          body: '',
        },
        {
          query: 'mutation UpsertVariables',
          variables: { variables: { SESSION_SECRET: suppliedValue } },
        }
      ));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const receipt = await adapter.setEnvVars(
      makeEnv({
        projectId: 'proj-railway',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
      }),
      makeService('web'),
      { SESSION_SECRET: suppliedValue },
      { deferDeployment: true }
    );

    expect(receipt).toMatchObject({
      success: false,
      message: 'Failed to set environment variables',
      error: 'Railway rejected [redacted] (code: BAD_USER_INPUT, path: variableCollectionUpsert)',
    });
    expect(JSON.stringify(receipt)).not.toContain(suppliedValue);
  });

  it('deletes only explicitly named variables and never returns their values', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-staging', name: 'staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-web', name: 'web' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        service: {
          serviceInstances: {
            edges: [{ node: { environmentId: 'env-staging' } }],
          },
        },
      })
      .mockResolvedValueOnce({
        serviceInstance: {
          latestDeployment: { id: 'deployment-before-delete', status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variableDelete: true })
      .mockResolvedValueOnce({ variableDelete: true });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
    const receipt = await adapter.deleteEnvVars!(
      makeEnv({
        projectId: 'proj-railway',
        environmentId: 'env-staging',
        services: { web: { serviceId: 'svc-web' } },
      }),
      makeService('web'),
      ['OLD_API_TOKEN', 'LEGACY_FEATURE_FLAG', 'OLD_API_TOKEN']
    );

    expect(receipt).toMatchObject({
      success: true,
      data: {
        deletedKeys: ['LEGACY_FEATURE_FLAG', 'OLD_API_TOKEN'],
        variableCount: 2,
        redeployMayBeTriggered: true,
        runtimeRolloutRequired: true,
        rolloutBaseline: {
          state: 'present',
          deploymentId: 'deployment-before-delete',
        },
      },
    });
    const deleteCalls = request.mock.calls.filter(([query]) => String(query).includes('variableDelete'));
    expect(deleteCalls.map(([, variables]) => variables)).toEqual([
      {
        input: {
          projectId: 'proj-railway',
          serviceId: 'svc-web',
          environmentId: 'env-staging',
          name: 'LEGACY_FEATURE_FLAG',
        },
      },
      {
        input: {
          projectId: 'proj-railway',
          serviceId: 'svc-web',
          environmentId: 'env-staging',
          name: 'OLD_API_TOKEN',
        },
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain('secret-value');
  });
});
