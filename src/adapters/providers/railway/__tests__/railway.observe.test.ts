import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter, type RailwayCustomDomain } from '../railway.adapter.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function graphqlNotFound(rootField: string, message: string): Error {
  const error = new Error(message) as Error & {
    response: {
      status: number;
      errors: Array<{
        message: string;
        path: string[];
        extensions: { code: string };
      }>;
    };
  };
  error.response = {
    status: 200,
    errors: [{
      message,
      path: [rootField],
      extensions: { code: 'NOT_FOUND' },
    }],
  };
  return error;
}

function makeEnvironment(platformBindings: Record<string, unknown>, name = 'production'): Environment {
  return {
    id: 'env-local',
    projectId: 'proj-local',
    name,
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const projectDetailsResponse = {
  project: {
    id: 'rail-project-1',
    name: 'billforge',
    environments: {
      edges: [
        { node: { id: 'env-prod', name: 'production' } },
        { node: { id: 'env-staging', name: 'staging' } },
      ],
    },
    services: {
      edges: [
        {
          node: {
            id: 'svc-web',
            name: 'web',
            repoTriggers: { edges: [] },
            serviceInstances: {
              edges: [
                {
                  node: {
                    environmentId: 'env-prod',
                    domains: {
                      serviceDomains: [{ domain: 'web-production.up.railway.app' }],
                      customDomains: [{ domain: 'usebillforge.com' }],
                    },
                    startCommand: 'npm start',
                    healthcheckPath: '/health',
                  },
                },
              ],
            },
          },
        },
        {
          node: {
            id: 'svc-pg',
            name: 'postgres-db',
            repoTriggers: { edges: [] },
            serviceInstances: {
              edges: [
                {
                  node: {
                    environmentId: 'env-prod',
                    source: { image: 'postgres:16' },
                    latestDeployment: { id: 'dep-pg', status: 'SUCCESS' },
                    domains: {
                      serviceDomains: [],
                      customDomains: [],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
    plugins: {
      edges: [{ node: { id: 'plugin-redis', name: 'Redis' } }],
    },
  },
};

describe('RailwayAdapter observe', () => {
  it('observes services, hashes env vars, and classifies databases', async () => {
    const request = vi.fn()
      // getProjectDetails
      .mockResolvedValueOnce(projectDetailsResponse)
      // getServiceInstanceDetails for web
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm run start:prod',
          healthcheckPath: '/healthz',
          cronSchedule: null,
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      // fetchServiceVariables for web
      .mockResolvedValueOnce({
        variables: {
          DATABASE_URL: 'postgres://user:hunter2@db.internal:5432/app',
          API_KEY: 'value',
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.provider).toBe('railway');
    expect(result.projectExists).toBe(true);
    expect(result.projectId).toBe('rail-project-1');
    expect(result.environmentId).toBe('env-prod');
    expect(result.partial).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining('legacy plugin inventory'),
    ]);
    expect(result.completeness).toMatchObject({
      services: 'complete',
      databases: 'complete',
      caches: 'unknown',
    });

    expect(result.services).toHaveLength(1);
    const web = result.services[0];
    expect(web).toMatchObject({
      name: 'web',
      externalId: 'svc-web',
      workloadKind: 'web',
      url: 'https://web-production.up.railway.app',
      customDomains: ['usebillforge.com'],
      config: {
        startCommand: 'npm run start:prod',
        healthCheckPath: '/healthz',
        public: true,
      },
      status: 'running',
    });
    expect(web.envVarKeys.sort()).toEqual(['API_KEY', 'DATABASE_URL']);

    expect(result.databases).toEqual([
      {
        provider: 'railway',
        engine: 'postgres',
        externalId: 'svc-pg',
        providerScope: { projectId: 'rail-project-1' },
        name: 'postgres-db',
        status: 'running',
      },
    ]);
    expect(result.caches).toEqual([
      {
        provider: 'railway',
        engine: 'redis',
        externalId: 'plugin-redis',
        providerScope: { projectId: 'rail-project-1' },
        name: 'Redis',
        status: 'unknown',
      },
    ]);
  });

  it('marks workloadKind cron when the service instance has a cron schedule', async () => {
    const privateCronProject = structuredClone(projectDetailsResponse);
    privateCronProject.project.services.edges[0].node.serviceInstances.edges[0].node.domains = {
      serviceDomains: [],
      customDomains: [],
    };
    const request = vi.fn()
      .mockResolvedValueOnce(privateCronProject)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm run report',
          cronSchedule: '0 * * * *',
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.workloadKind).toBe('cron');
    expect(result.services[0]?.config.cronSchedule).toBe('0 * * * *');
    expect(result.services[0]?.config.public).toBe(false);
  });

  it('observes Railway custom-domain DNS verification state', async () => {
    const pendingDomainProject = structuredClone(projectDetailsResponse);
    pendingDomainProject.project.services.edges[0].node.serviceInstances.edges[0].node.domains.customDomains = [
      {
        id: 'cd_123',
        domain: 'usebillforge.com',
        status: {
          verified: false,
          dnsRecords: [
            {
              fqdn: 'usebillforge.com',
              recordType: 'DNS_RECORD_TYPE_CNAME',
              requiredValue: 'web-production.up.railway.app.',
              status: 'DNS_RECORD_STATUS_PENDING',
            },
          ],
          verificationDnsHost: '_railway.usebillforge.com',
          verificationToken: 'verify-token',
        },
      },
    ] as RailwayCustomDomain[];
    const request = vi.fn()
      .mockResolvedValueOnce(pendingDomainProject)
      .mockResolvedValueOnce({
        serviceInstance: {
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.customDomainStatus?.['usebillforge.com']).toMatchObject({
      providerDomainId: 'cd_123',
      providerVerified: false,
      dnsConfigured: false,
      dnsRecords: [
        { name: 'usebillforge.com', type: 'CNAME', value: 'web-production.up.railway.app' },
        { name: '_railway.usebillforge.com', type: 'TXT', value: 'verify-token' },
      ],
    });
  });

  it('trusts Railway custom-domain verified status even when the verification token is still returned', async () => {
    const verifiedDomainProject = structuredClone(projectDetailsResponse);
    verifiedDomainProject.project.services.edges[0].node.serviceInstances.edges[0].node.domains.customDomains = [
      {
        id: 'cd_123',
        domain: 'usebillforge.com',
        status: {
          verified: true,
          dnsRecords: [
            {
              fqdn: 'usebillforge.com',
              recordType: 'DNS_RECORD_TYPE_CNAME',
              requiredValue: 'web-production.up.railway.app.',
              status: 'DNS_RECORD_STATUS_VALID',
            },
          ],
          verificationDnsHost: '_railway.usebillforge.com',
          verificationToken: 'verify-token',
        },
      },
    ] as RailwayCustomDomain[];
    const request = vi.fn()
      .mockResolvedValueOnce(verifiedDomainProject)
      .mockResolvedValueOnce({
        serviceInstance: {
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.customDomainStatus?.['usebillforge.com']).toMatchObject({
      providerDomainId: 'cd_123',
      providerVerified: true,
      dnsConfigured: true,
      dnsRecords: [
        { name: 'usebillforge.com', type: 'CNAME', value: 'web-production.up.railway.app' },
        { name: '_railway.usebillforge.com', type: 'TXT', value: 'verify-token' },
      ],
    });
  });

  it('separates propagated routing DNS from pending Railway ownership and certificate state', async () => {
    const pendingOwnershipProject = structuredClone(projectDetailsResponse);
    pendingOwnershipProject.project.services.edges[0].node.serviceInstances.edges[0].node.domains.customDomains = [
      {
        id: 'cd_123',
        domain: 'usebillforge.com',
        status: {
          verified: false,
          certificateStatus: 'PENDING',
          dnsRecords: [{
            fqdn: 'usebillforge.com',
            recordType: 'DNS_RECORD_TYPE_CNAME',
            requiredValue: 'web-production.up.railway.app.',
            status: 'DNS_RECORD_STATUS_PROPAGATED',
          }],
          verificationDnsHost: '_railway-verify.usebillforge.com',
          verificationToken: 'verify-token',
        },
      },
    ] as RailwayCustomDomain[];
    const request = vi.fn()
      .mockResolvedValueOnce(pendingOwnershipProject)
      .mockResolvedValueOnce({ serviceInstance: { latestDeployment: { status: 'SUCCESS' } } })
      .mockResolvedValueOnce({ variables: {} });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.customDomainStatus?.['usebillforge.com']).toMatchObject({
      providerVerified: false,
      certificateStatus: 'PENDING',
      dnsConfigured: true,
    });
  });

  it('does not turn a failed Railway custom-domain read into an absent domain', async () => {
    const adapter = new RailwayAdapter();
    const request = vi.fn().mockRejectedValue(new Error('Railway timed out'));
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.getCustomDomainStatus({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      domain: 'usebillforge.com',
    })).rejects.toThrow('Failed to observe Railway custom domain usebillforge.com');
  });

  it('surfaces the linked repo and branch as the service source', async () => {
    const withTrigger = structuredClone(projectDetailsResponse);
    (withTrigger.project.services.edges[0].node as { repoTriggers: unknown }).repoTriggers = {
      edges: [{ node: { repository: 'dave/seq-planner', branch: 'main' } }],
    };
    const request = vi.fn()
      .mockResolvedValueOnce(withTrigger)
      .mockResolvedValueOnce({
        serviceInstance: { startCommand: 'npm start', latestDeployment: { status: 'SUCCESS' } },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.source).toEqual({ repo: 'dave/seq-planner', branch: 'main' });
    expect(result.services[0]?.sourceState).toBe('connected');
  });

  it('uses ServiceInstance.source as primary and cached binding branch when repoTriggers are absent', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          source: { repo: 'dave/seq-planner' },
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: {
          web: {
            serviceId: 'svc-web',
            source: { repo: 'https://github.com/dave/seq-planner.git', branch: 'main' },
          },
        },
      })
    );

    expect(result.services[0]?.source).toEqual({ repo: 'dave/seq-planner', branch: 'main' });
    expect(result.services[0]?.sourceState).toBe('connected');
  });

  it('does not let a cached source binding mask a live disconnected source', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          source: null,
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: {
          web: {
            serviceId: 'svc-web',
            source: { repo: 'dave/old-source', branch: 'main' },
          },
        },
      })
    );

    expect(result.services[0]?.source).toBeUndefined();
    expect(result.services[0]?.sourceState).toBe('disconnected');
  });

  it('preserves unknown deploy-source observation when the service-instance read fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockRejectedValueOnce(new Error('service instance read denied'))
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.partial).toBe(true);
    expect(result.services[0]?.source).toBeUndefined();
    expect(result.services[0]?.sourceState).toBe('unknown');
  });

  it('marks a service with no deployments as status empty', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm start',
          healthcheckPath: '/health',
          cronSchedule: null,
          latestDeployment: null,
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.status).toBe('empty');
  });

  it('maps preDeployCommand back to config.releaseCommand', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm start',
          preDeployCommand: ['npx prisma migrate deploy'],
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.config.releaseCommand).toBe('npx prisma migrate deploy');
  });

  it('returns projectExists false without calling Railway when no project is bound', async () => {
    const request = vi.fn();

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(makeEnvironment({}));

    expect(result).toMatchObject({
      provider: 'railway',
      projectExists: false,
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('formats structured build logs from Railway', async () => {
    const request = vi.fn().mockResolvedValue({
      buildLogs: [
        { timestamp: '2026-06-16T21:00:00Z', severity: 'error', message: 'Failed to pull image from registry' },
        { timestamp: '2026-06-16T21:00:01Z', severity: 'info', message: 'Check image credentials' },
      ],
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const logs = await adapter.getBuildLogs('dep-1');

    expect(request.mock.calls[0][0]).toContain('buildLogs(deploymentId: $deploymentId)');
    expect(request.mock.calls[0][0]).toContain('message');
    expect(logs).toContain('2026-06-16T21:00:00Z error Failed to pull image from registry');
    expect(logs).toContain('2026-06-16T21:00:01Z info Check image credentials');
  });

  it('preserves Railway deployment-log errors instead of reporting an empty log set', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Railway logs permission denied'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.getDeploymentLogs('dep-1', 37))
      .rejects.toThrow('Railway logs permission denied');
    expect(request.mock.calls[0]?.[1]).toEqual({ deploymentId: 'dep-1', limit: 37 });
  });

  it('preserves Railway build-log errors instead of reporting an empty build', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Railway build logs unavailable'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.getBuildLogs('dep-1'))
      .rejects.toThrow('Railway build logs unavailable');
  });

  it('returns projectExists false only for provider-confirmed project absence', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      graphqlNotFound('project', 'Project not found')
    );

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(makeEnvironment({ projectId: 'rail-project-gone' }));

    expect(result.projectExists).toBe(false);
    expect(result.projectId).toBe('rail-project-gone');
    expect(result.services).toEqual([]);
  });

  it('propagates project observation errors that are not confirmed not-found responses', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Railway API unavailable'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.observe(makeEnvironment({ projectId: 'rail-project-unknown' })))
      .rejects.toThrow('Railway API unavailable');
  });

  it('does not observe production services when the target Railway environment is missing', async () => {
    const request = vi.fn().mockResolvedValueOnce(projectDetailsResponse);

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-deleted' }, 'preview')
    );

    expect(result.projectExists).toBe(true);
    expect(result.environmentId).toBeUndefined();
    expect(result.services).toEqual([]);
    expect(result.databases).toEqual([]);
    expect(result.warnings).toContain('Could not resolve Railway environment for "preview"');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores services that do not have an instance in the requested environment', async () => {
    const stagingProject = structuredClone(projectDetailsResponse);
    const request = vi.fn().mockResolvedValueOnce(stagingProject);

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-staging' })
    );

    expect(result.projectExists).toBe(true);
    expect(result.environmentId).toBe('env-staging');
    expect(result.services).toEqual([]);
    expect(result.databases.find((db) => db.engine === 'postgres')).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('treats exact bound application services as services even when their names or images resemble datastores', async () => {
    const ambiguousProject = structuredClone(projectDetailsResponse);
    ambiguousProject.project.plugins.edges = [];
    ambiguousProject.project.services.edges[0].node.name = 'postgres-exporter';
    ambiguousProject.project.services.edges[1].node.name = 'redis-worker';
    const request = vi.fn()
      .mockResolvedValueOnce(ambiguousProject)
      .mockResolvedValueOnce({ serviceInstance: { latestDeployment: { status: 'SUCCESS' } } })
      .mockResolvedValueOnce({ variables: {} })
      .mockResolvedValueOnce({ serviceInstance: { latestDeployment: { status: 'SUCCESS' } } })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(makeEnvironment({
      projectId: 'rail-project-1',
      environmentId: 'env-prod',
      services: {
        'postgres-exporter': { serviceId: 'svc-web' },
        'redis-worker': { serviceId: 'svc-pg' },
      },
    }));

    expect(result.services.map((service) => service.name).sort()).toEqual([
      'postgres-exporter',
      'redis-worker',
    ]);
    expect(result.databases).toEqual([]);
    expect(result.caches).toEqual([]);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('maps Hypervibe-created environment-suffixed Railway service names back to desired names', async () => {
    const stagingProject = structuredClone(projectDetailsResponse);
    stagingProject.project.services.edges.push({
      node: {
        id: 'svc-web-staging',
        name: 'web-staging',
        repoTriggers: { edges: [] },
        serviceInstances: {
          edges: [
            {
              node: {
                environmentId: 'env-staging',
                domains: {
                  serviceDomains: [{ domain: 'web-staging.up.railway.app' }],
                  customDomains: [],
                },
                startCommand: 'npm start',
                healthcheckPath: '/api/health',
              },
            },
          ],
        },
      },
    });
    const request = vi.fn()
      .mockResolvedValueOnce(stagingProject)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm start',
          healthcheckPath: '/api/health',
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-staging' }, 'staging')
    );

    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      name: 'web',
      externalId: 'svc-web-staging',
      url: 'https://web-staging.up.railway.app',
    });
  });

  it('sets partial true with warnings when a sub-query fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      // getServiceInstanceDetails fails
      .mockRejectedValueOnce(new Error('serviceInstance query exploded'))
      // fetchServiceVariables fails
      .mockRejectedValueOnce(new Error('variables query exploded'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.projectExists).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('web'),
      expect.stringContaining('legacy plugin inventory'),
    ]));
    // Service is still reported, falling back to project-level instance data.
    expect(result.services[0]).toMatchObject({
      name: 'web',
      status: 'unknown',
      config: {
        startCommand: 'npm start',
        healthCheckPath: '/health',
      },
      envVarKeys: [],
      envVarHashes: {},
    });
  });

  it('hashes env var values and never exposes raw values', async () => {
    const secret = 'postgres://user:hunter2@db.internal:5432/app';
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: { latestDeployment: { status: 'SUCCESS' } },
      })
      .mockResolvedValueOnce({
        variables: {
          DATABASE_URL: secret,
          API_KEY: 'value',
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    const web = result.services[0];
    expect(web?.envVarHashes['API_KEY']).toBe(hashEnvValue('value'));
    expect(web?.envVarHashes['DATABASE_URL']).toBe(hashEnvValue(secret));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('hunter2');
  });

  it('throws when not connected', async () => {
    const adapter = new RailwayAdapter();
    await expect(adapter.observe(makeEnvironment({ projectId: 'rail-project-1' }))).rejects.toThrow(
      'Not connected'
    );
  });
});
