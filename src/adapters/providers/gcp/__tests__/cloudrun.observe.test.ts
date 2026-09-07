import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

async function connectedAdapter(): Promise<CloudRunAdapter> {
  const adapter = new CloudRunAdapter();
  await adapter.connect({
    projectId: 'gcp-project',
    region: 'us-central1',
    credentials: JSON.stringify({
      type: 'service_account',
      project_id: 'gcp-project',
      private_key_id: 'key-id',
      private_key: 'dummy',
      client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      client_id: 'client-id',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  });
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
  return adapter;
}

function environmentWith(platformBindings: Record<string, unknown>): Environment {
  const now = new Date();
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

const webService = {
  name: 'projects/gcp-project/locations/us-central1/services/gcp-project-web',
  uid: 'uid-1',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  uri: 'https://gcp-project-web.run.app',
  labels: { 'infraprint-environment': 'production', 'infraprint-service': 'web' },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: {
    vpcAccess: {
      networkInterfaces: [{
        network: 'projects/gcp-project/global/networks/default',
        subnetwork: 'projects/gcp-project/regions/us-central1/subnetworks/default',
      }],
      egress: 'PRIVATE_RANGES_ONLY',
    },
    containers: [{
      image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
      env: [
        { name: 'DATABASE_URL', value: 'postgres://super-secret' },
        { name: 'SECRET_VALUE', valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } } },
      ],
      startupProbe: { httpGet: { path: '/healthz' } },
    }],
  },
};

const workerService = {
  name: 'projects/gcp-project/locations/us-central1/services/gcp-project-consumer',
  uid: 'uid-worker',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
  labels: { 'infraprint-environment': 'production', 'infraprint-service': 'consumer' },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: {
    containers: [{
      image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-consumer:main',
    }],
  },
};

const strayService = {
  name: 'projects/gcp-project/locations/us-central1/services/other-web',
  uid: 'uid-2',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  uri: 'https://other-web.run.app',
  labels: { 'infraprint-environment': 'staging', 'infraprint-service': 'web' },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: { containers: [{ image: 'other' }] },
};

const cronJob = {
  name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  labels: {
    'infraprint-environment': 'production',
    'infraprint-service': 'cron',
    'infraprint-resource': 'scheduled-job',
  },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: {
    template: {
      containers: [{
        image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
        command: ['/bin/sh'],
        args: ['-lc', 'npm run cron'],
        env: [{ name: 'DATABASE_URL', value: 'postgres://super-secret' }],
      }],
    },
  },
};

const batchJob = {
  name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-batch',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  labels: { 'infraprint-environment': 'production', 'infraprint-service': 'batch' },
  terminalCondition: {
    type: 'Ready',
    state: 'CONDITION_FAILED',
    reason: 'ContainerMissing',
    message: 'image not found',
  },
  template: {
    template: {
      containers: [{
        image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-batch:main',
        command: ['/bin/sh'],
        args: ['-lc', 'npm run batch'],
        env: [],
      }],
    },
  },
};

describe('CloudRunAdapter.observe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('observes live services, scheduled jobs, and plain jobs with hashed env vars', async () => {
    const adapter = await connectedAdapter();

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && method === 'GET') {
        return Response.json({ services: [webService, workerService, strayService] });
      }
      if (url.startsWith('https://us-central1-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/gcp-project/domainmappings?') && method === 'GET') {
        return Response.json({ items: [] });
      }
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?') && method === 'GET') {
        return Response.json({ jobs: [cronJob, batchJob] });
      }
      if (url.endsWith('/services/gcp-project-web:getIamPolicy') && method === 'GET') {
        return Response.json({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] });
      }
      if (url.endsWith('/services/gcp-project-consumer:getIamPolicy') && method === 'GET') {
        return Response.json({ bindings: [] });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs/gcp-project-cron-schedule') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          schedule: '*/5 * * * *',
          timeZone: 'Etc/UTC',
          state: 'ENABLED',
        });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs/gcp-project-batch-schedule') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      environmentId: 'us-central1',
      services: {
        web: { serviceId: 'gcp-project-web' },
        cron: {
          serviceId: 'gcp-project-cron-schedule',
          jobName: 'gcp-project-cron',
          resourceType: 'scheduledJob',
        },
      },
    }));

    expect(observed.provider).toBe('cloudrun');
    expect(observed.projectExists).toBe(true);
    expect(observed.projectId).toBe('gcp-project');
    expect(observed.environmentId).toBe('us-central1');
    expect(observed.databases).toEqual([]);
    expect(observed.partial).toBe(false);
    expect(observed.warnings).toEqual([]);
    expect(observed.services.map((service) => service.name).sort()).toEqual(['batch', 'consumer', 'cron', 'web']);

    const web = observed.services.find((service) => service.name === 'web');
    expect(web).toMatchObject({
      externalId: 'gcp-project-web',
      workloadKind: 'web',
      url: 'https://gcp-project-web.run.app',
      customDomains: [],
      config: {
        healthCheckPath: '/healthz',
        public: true,
        cacheNetwork: {
          network: 'projects/gcp-project/global/networks/default',
          subnetwork: 'projects/gcp-project/regions/us-central1/subnetworks/default',
          egress: 'PRIVATE_RANGES_ONLY',
        },
      },
      envVarKeys: ['DATABASE_URL', 'SECRET_VALUE'],
      status: 'running',
    });
    expect(web?.envVarHashes).toEqual({
      DATABASE_URL: hashEnvValue('postgres://super-secret'),
    });

    const cron = observed.services.find((service) => service.name === 'cron');
    expect(cron).toMatchObject({
      externalId: 'gcp-project-cron-schedule',
      workloadKind: 'cron',
      customDomains: [],
      config: {
        startCommand: 'npm run cron',
        cronSchedule: '*/5 * * * *',
      },
      envVarKeys: ['DATABASE_URL'],
      status: 'running',
    });

    const batch = observed.services.find((service) => service.name === 'batch');
    expect(batch).toMatchObject({
      externalId: 'gcp-project-batch',
      // A Job without a Cloud Scheduler trigger is a broken cron.
      workloadKind: 'cron',
      config: { startCommand: 'npm run batch' },
      status: 'failed',
    });

    // Internal-only ingress classifies live services as workers.
    const consumer = observed.services.find((svc) => svc.name === 'consumer');
    expect(consumer).toMatchObject({ workloadKind: 'worker' });

    // Raw env var values must never appear in the observed state.
    expect(JSON.stringify(observed)).not.toContain('postgres://super-secret');
  });

  it('returns partial results with warnings when a sub-query fails', async () => {
    const adapter = await connectedAdapter();

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && method === 'GET') {
        return new Response('internal error', { status: 500 });
      }
      if (url.startsWith('https://us-central1-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/gcp-project/domainmappings?') && method === 'GET') {
        return Response.json({ items: [] });
      }
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?') && method === 'GET') {
        return Response.json({ jobs: [cronJob] });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs/gcp-project-cron-schedule') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          schedule: '*/5 * * * *',
          state: 'ENABLED',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.projectExists).toBe(true);
    expect(observed.partial).toBe(true);
    expect(observed.warnings).toHaveLength(1);
    expect(observed.warnings[0]).toContain('Failed to list Cloud Run services');
    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services).toHaveLength(1);
    expect(observed.services[0]).toMatchObject({
      name: 'cron',
      workloadKind: 'cron',
      status: 'running',
    });
  });

  it('marks service observation unknown when the Cloud Run job list fails', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) return Response.json({ services: [] });
      if (url.includes('/jobs?')) return new Response('unavailable', { status: 503 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.partial).toBe(true);
    expect(observed.warnings).toEqual([
      expect.stringContaining('Failed to list Cloud Run jobs'),
    ]);
  });

  it('keeps IAM observation failures visible and marks services unknown', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) return Response.json({ services: [webService] });
      if (url.includes('/jobs?')) return Response.json({ jobs: [] });
      if (url.endsWith('/services/gcp-project-web:getIamPolicy')) {
        return new Response('permission denied', { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.partial).toBe(true);
    expect(observed.warnings).toEqual([
      expect.stringContaining('Failed to read Cloud Run IAM policy for gcp-project-web'),
    ]);
    expect(observed.services[0]?.config).not.toHaveProperty('public');
  });

  it('marks services unknown when a per-job Scheduler lookup fails', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) return Response.json({ services: [] });
      if (url.includes('/jobs?')) return Response.json({ jobs: [cronJob] });
      if (url.endsWith('/jobs/gcp-project-cron-schedule')) {
        return new Response('scheduler unavailable', { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.partial).toBe(true);
    expect(observed.warnings).toEqual([
      expect.stringContaining('Failed to read Cloud Scheduler job gcp-project-cron-schedule'),
    ]);
    expect(observed.services).toHaveLength(1);
  });

  it('rejects a defined non-array Cloud Run collection as incomplete observation', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) return Response.json({ services: { item: webService } });
      if (url.includes('/jobs?')) return Response.json({ jobs: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services).toEqual([]);
    expect(observed.warnings).toEqual([
      expect.stringContaining('non-array services collection'),
    ]);
  });

  it('rejects a repeated Cloud Run page token instead of completing a cyclic list', async () => {
    const adapter = await connectedAdapter();
    let servicePageCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) {
        servicePageCalls += 1;
        return Response.json({ services: [], nextPageToken: 'repeat-token' });
      }
      if (url.includes('/jobs?')) return Response.json({ jobs: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(servicePageCalls).toBe(2);
    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services).toEqual([]);
    expect(observed.warnings).toEqual([
      expect.stringContaining('repeated a nextPageToken'),
    ]);
  });

  it.each([
    'projects/other-project/locations/us-central1/services/gcp-project-web',
    'projects/gcp-project/locations/europe-west1/services/gcp-project-web',
    'projects/gcp-project/locations/us-central1/jobs/gcp-project-web',
  ])('rejects a Cloud Run service outside the exact collection scope: %s', async (name) => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) return Response.json({ services: [{ ...webService, name }] });
      if (url.includes('/jobs?')) return Response.json({ jobs: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services).toEqual([]);
    expect(observed.warnings).toEqual([
      expect.stringContaining('outside exact project gcp-project, region us-central1, or kind services'),
    ]);
  });

  it('rejects duplicate Cloud Run resource IDs across pages', async () => {
    const adapter = await connectedAdapter();
    let servicePageCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/domainmappings?')) return Response.json({ items: [] });
      if (url.includes('/services?')) {
        servicePageCalls += 1;
        return servicePageCalls === 1
          ? Response.json({ services: [webService], nextPageToken: 'page-2' })
          : Response.json({ services: [{ ...webService }] });
      }
      if (url.includes('/jobs?')) return Response.json({ jobs: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(servicePageCalls).toBe(2);
    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services).toEqual([]);
    expect(observed.warnings).toEqual([
      expect.stringContaining('duplicate services resource id gcp-project-web'),
    ]);
  });

  it('attaches, observes, and terminally detaches one exact Cloud Run domain mapping', async () => {
    const adapter = await connectedAdapter();
    const domain = 'cloudrun.domain-test.hypervibe.dev';
    let mappingExists = false;
    const mapping = {
      apiVersion: 'domains.cloudrun.com/v1',
      kind: 'DomainMapping',
      metadata: {
        name: domain,
        namespace: 'gcp-project',
        uid: 'mapping-uid-1',
      },
      spec: {
        routeName: 'gcp-project-web',
        certificateMode: 'AUTOMATIC',
      },
      status: {
        mappedRouteName: 'gcp-project-web',
        conditions: [
          { type: 'Ready', status: 'True' },
          { type: 'CertificateProvisioned', status: 'True', reason: 'CertificateReady' },
        ],
        resourceRecords: [{
          name: 'cloudrun',
          type: 'CNAME',
          rrdata: 'ghs.googlehosted.com',
        }],
      },
    };
    const mutations: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services/gcp-project-web') {
        return Response.json(webService);
      }
      if (url.includes('/domainmappings/') && method === 'GET') {
        return mappingExists
          ? Response.json(mapping)
          : new Response(null, { status: 404 });
      }
      if (url.endsWith('/domainmappings') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          metadata: { name: domain, namespace: 'gcp-project' },
          spec: {
            routeName: 'gcp-project-web',
            certificateMode: 'AUTOMATIC',
          },
        });
        mappingExists = true;
        mutations.push('create');
        return Response.json(mapping, { status: 201 });
      }
      if (url.includes('/domainmappings/') && method === 'DELETE') {
        mappingExists = false;
        mutations.push('delete');
        return Response.json({});
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const attached = await adapter.attachCustomDomain({
      projectId: 'gcp-project',
      serviceId: 'gcp-project-web',
      environmentId: 'us-central1',
      domain,
      dnsZone: 'hypervibe.dev',
    });
    expect(attached).toMatchObject({
      success: true,
      data: {
        customDomainId: 'mapping-uid-1',
        created: true,
        providerVerified: true,
        certificateStatus: 'CertificateReady',
        dnsRecords: [{
          name: domain,
          type: 'CNAME',
          value: 'ghs.googlehosted.com',
          purpose: 'traffic verification',
        }],
      },
    });

    vi.stubEnv('HYPERVIBE_CLOUDRUN_DOMAIN_DELETE_DELAY_MS', '0');
    const detached = await adapter.detachCustomDomain({
      projectId: 'gcp-project',
      serviceId: 'gcp-project-web',
      environmentId: 'us-central1',
      domain,
      customDomainId: 'mapping-uid-1',
    });
    expect(detached).toMatchObject({
      success: true,
      data: { customDomainId: 'mapping-uid-1', deleted: true },
    });
    expect(mutations).toEqual(['create', 'delete']);
  });

  it('attributes observed Cloud Run mapping and certificate state to its exact route', async () => {
    const adapter = await connectedAdapter();
    const domain = 'cloudrun.domain-test.hypervibe.dev';
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?')) {
        return Response.json({ services: [webService] });
      }
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?')) {
        return Response.json({ jobs: [] });
      }
      if (url.includes('/domainmappings?')) {
        return Response.json({
          items: [{
            metadata: { name: domain, namespace: 'gcp-project', uid: 'mapping-uid-1' },
            spec: { routeName: 'gcp-project-web' },
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              resourceRecords: [{ type: 'CNAME', rrdata: 'ghs.googlehosted.com' }],
            },
          }],
        });
      }
      if (url.endsWith('/services/gcp-project-web:getIamPolicy') && method === 'GET') {
        return Response.json({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      environmentId: 'us-central1',
      services: { web: { serviceId: 'gcp-project-web' } },
    }));

    expect(observed.services[0]).toMatchObject({
      customDomains: [domain],
      customDomainStatus: {
        [domain]: {
          providerVerified: true,
          certificateStatus: 'True',
          dnsConfigured: true,
        },
      },
    });
  });

  it('reports a missing project when no projectId binding exists', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async () => {
      throw new Error('observe should not call the API without bindings');
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({ provider: 'cloudrun' }));

    expect(observed).toMatchObject({
      provider: 'cloudrun',
      projectExists: false,
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the adapter is not connected', async () => {
    const adapter = new CloudRunAdapter();
    await expect(adapter.observe(environmentWith({ projectId: 'gcp-project' })))
      .rejects.toThrow('Not connected');
  });
});
