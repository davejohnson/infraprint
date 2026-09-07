import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

describe('CloudRunAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

  it('inventories Artifact Registry repositories in the explicitly selected region', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/us-west1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [{
          name: 'projects/gcp-project/locations/us-west1/repositories/infraprint',
          format: 'DOCKER',
          sizeBytes: '12884901888',
        }] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', region: 'us-west1', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'artifact',
      region: 'us-west1',
      artifacts: [{
        id: 'projects/gcp-project/locations/us-west1/repositories/infraprint',
        name: 'infraprint',
        format: 'DOCKER',
        sizeBytes: '12884901888',
        providerScope: { projectId: 'gcp-project', location: 'us-west1' },
      }],
      partial: false,
    });
  });

  it('discovers Artifact Registry repositories across all project locations by default', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations?pageSize=100' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ locations: [
          { name: 'projects/gcp-project/locations/us-central1' },
          { name: 'projects/gcp-project/locations/europe-west1' },
        ] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/us-central1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/europe-west1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [{
          name: 'projects/gcp-project/locations/europe-west1/repositories/legacy-images',
          format: 'DOCKER',
        }] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      region: 'all',
      artifacts: [{
        id: 'projects/gcp-project/locations/europe-west1/repositories/legacy-images',
        providerScope: { projectId: 'gcp-project', location: 'europe-west1' },
      }],
      partial: false,
    });
  });

  it('does not report Artifact Registry absence when one project location cannot be observed', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations?pageSize=100' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ locations: [
          { name: 'projects/gcp-project/locations/us-central1' },
          { name: 'projects/gcp-project/locations/europe-west1' },
        ] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/us-central1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/europe-west1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return new Response('permission denied', { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', limit: 25 });

    expect(result).toMatchObject({
      observation: 'unknown',
      artifacts: [],
      partial: true,
      warnings: [expect.stringContaining('europe-west1: 403 permission denied')],
    });
  });

  it('fails project-wide Artifact Registry inventory when locations cannot be enumerated', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));

    await expect(adapter.inspectArtifactResources({ resource: 'artifact', limit: 25 }))
      .rejects.toThrow('Artifact Registry location inventory failed: 403 forbidden');
  });

  it('derives Artifact Registry location from an exact durable id', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const id = 'projects/gcp-project/locations/europe-west1/repositories/legacy-images';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://artifactregistry.googleapis.com/v1/${id}` && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ name: id, format: 'DOCKER' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', id, limit: 1 });

    expect(result).toMatchObject({
      observation: 'present',
      artifacts: [{ id, providerScope: { projectId: 'gcp-project', location: 'europe-west1' } }],
      partial: false,
    });
  });

  it('deletes one exact Artifact Registry repository and verifies terminal absence', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    let deleted = false;
    const id = 'projects/gcp-project/locations/us-central1/repositories/infraprint';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `https://artifactregistry.googleapis.com/v1/${id}` && method === 'GET') {
        return deleted ? new Response('missing', { status: 404 }) : Response.json({ name: id, format: 'DOCKER' });
      }
      if (url === `https://artifactregistry.googleapis.com/v1/${id}` && method === 'DELETE') {
        deleted = true;
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/delete-repo',
          done: true,
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await adapter.destroyRetainedArtifactRepository({
      resource: 'artifact',
      id,
      providerScope: { projectId: 'gcp-project', location: 'us-central1' },
    });

    expect(receipt.success).toBe(true);
    expect(deleted).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('preserves provider errors in deployment-status observations', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json(
      { error: { message: 'permission denied' } },
      { status: 403 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.getDeployStatus({
      id: 'environment-local',
      projectId: 'project-local',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'northamerica-northeast1',
        services: { web: { serviceId: 'production-web' } },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }, 'production-web');

    expect(result).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/403.*permission denied/i),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/locations/northamerica-northeast1/'
    );
  });

  it('forensically lists a migrated environment without a retained binding or mutations', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      expect(init?.method ?? 'GET').toBe('GET');
      if (pathname.endsWith('/services')) {
        return Response.json({
          services: [{
            name: 'projects/gcp-project/locations/us-central1/services/hls-property-care-web',
            uri: 'https://hls-property-care-web.run.app',
            labels: {
              'infraprint-environment': 'production',
              'infraprint-service': 'web',
            },
          }],
        });
      }
      if (pathname.endsWith('/jobs')) return Response.json({ jobs: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: 'local-project', name: 'hls-property-care' },
      environment: { id: 'local-environment', projectId: 'local-project', name: 'production' },
    });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'environment',
      project: { id: 'gcp-project' },
      environment: { name: 'production', region: 'us-central1' },
      services: [{
        id: 'hls-property-care-web',
        name: 'web',
        managedByHypervibe: true,
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recognizes legacy unlabeled resources from deterministic service identities', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'hls-property-care',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'hls-property-care', private_key: 'dummy',
        client_email: 'deploy@hls-property-care.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/services')) {
        return Response.json({ services: [] });
      }
      if (pathname.endsWith('/jobs')) return Response.json({ jobs: [{
        name: 'projects/hls-property-care/locations/us-central1/jobs/hls-property-care-production-web-migration',
      }] });
      if (new URL(String(input)).hostname === 'cloudscheduler.googleapis.com') {
        return Response.json({}, { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));

    const result = await adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: 'local-project', name: 'hls-property-care' },
      environment: { id: 'local-environment', projectId: 'local-project', name: 'production' },
      serviceNames: ['web'],
    });

    expect(result).toMatchObject({
      observation: 'present',
      services: [{
        id: 'hls-property-care-production-web-migration',
        name: 'web-migration',
        resourceType: 'taskJob',
        managedByHypervibe: true,
      }],
    });
  });

describe('CloudRunAdapter maintenance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function maintenanceAdapter(): Promise<CloudRunAdapter> {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    return adapter;
  }

  function maintenanceEnvironment(binding: Record<string, unknown>): Environment {
    const now = new Date();
    return {
      id: 'env-maintenance',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: { workload: binding },
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  it('sets service scaling to zero and restores the exact automatic scaling state', async () => {
    const adapter = await maintenanceAdapter();
    const environment = maintenanceEnvironment({ serviceId: 'gcp-project-web' });
    let scaling: Record<string, unknown> = {
      scalingMode: 'AUTOMATIC',
      minInstanceCount: 1,
      maxInstanceCount: 8,
    };
    const patchBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/services/gcp-project-web') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ name: 'gcp-project-web', scaling });
      }
      if (url.includes('/services/gcp-project-web') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { scaling: Record<string, unknown> };
        patchBodies.push(body);
        scaling = body.scaling;
        return Response.json({ name: 'operations/maintenance-scaling' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await adapter.observeMaintenanceWorkload(environment, 'gcp-project-web', 'web');
    await expect(adapter.suspendMaintenanceWorkload(environment, snapshot)).resolves.toMatchObject({ success: true });
    await expect(adapter.resumeMaintenanceWorkload(environment, snapshot)).resolves.toMatchObject({ success: true });

    expect(patchBodies[0]).toEqual({ scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 } });
    expect(patchBodies[1]).toEqual({
      launchStage: 'BETA',
      scaling: {
        scalingMode: 'AUTOMATIC',
        minInstanceCount: 1,
        maxInstanceCount: 8,
        manualInstanceCount: null,
      },
    });
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input).includes('/services/gcp-project-web') && init?.method === 'PATCH'
    ).every(([input]) => String(input).includes('updateMask='))).toBe(true);
  });

  it('pauses a cron trigger and cancels active executions before reporting suspension', async () => {
    vi.stubEnv('HYPERVIBE_GCP_WAIT_DELAY_MS', '0');
    const adapter = await maintenanceAdapter();
    const environment = maintenanceEnvironment({
      serviceId: 'gcp-project-cron-schedule',
      jobName: 'gcp-project-cron',
      schedulerJobName: 'gcp-project-cron-schedule',
    });
    let schedulerState = 'ENABLED';
    let executionTerminal = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('cloudscheduler.googleapis.com') && method === 'GET') {
        return Response.json({ state: schedulerState, schedule: '0 * * * *' });
      }
      if (url.endsWith(':pause') && method === 'POST') {
        schedulerState = 'PAUSED';
        return Response.json({ state: schedulerState });
      }
      if (url.endsWith(':resume') && method === 'POST') {
        schedulerState = 'ENABLED';
        return Response.json({ state: schedulerState });
      }
      if (url.includes('/executions?') && method === 'GET') {
        return Response.json({
          executions: [executionTerminal
            ? { name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron/executions/run-1', completionStatus: 'SUCCEEDED' }
            : { name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron/executions/run-1', reconciling: true }],
        });
      }
      if (url.endsWith('/executions/run-1:cancel') && method === 'POST') {
        executionTerminal = true;
        return Response.json({ name: 'operations/cancel-run-1' });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await adapter.observeMaintenanceWorkload(
      environment,
      'gcp-project-cron-schedule',
      'cron'
    );
    await expect(adapter.suspendMaintenanceWorkload(environment, snapshot)).resolves.toMatchObject({ success: true });
    await expect(adapter.resumeMaintenanceWorkload(environment, snapshot)).resolves.toMatchObject({ success: true });

    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith('/executions/run-1:cancel') && init?.method === 'POST'
    )).toBe(true);
  });
});

  it('preserves live revision env vars and Cloud SQL volumes on redeploy', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    let patchBody: Record<string, unknown> | undefined;
    const liveService = {
      name: 'gcp-project-web',
      uri: 'https://gcp-project-web.run.app',
      terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
      template: {
        containers: [{
          image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:old',
          env: [
            // Injected at database provision time — must survive a redeploy
            // that does not re-pass it.
            { name: 'DATABASE_URL', value: 'postgres://app:pw@34.44.202.227:5432/app' },
            { name: 'CLOUD_SQL_CONNECTION_NAME', value: 'gcp-project:us-central1:app' },
            { name: 'NODE_ENV', value: 'production' },
          ],
          volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
        }],
        volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: ['gcp-project:us-central1:app'] } }],
      },
    };

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith(':getIamPolicy')) {
        return Response.json({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] });
      }
      if (url.endsWith(':setIamPolicy')) {
        return Response.json(JSON.parse(String(init?.body)).policy);
      }
      if (url.includes('run.googleapis.com') && method === 'GET') {
        return Response.json(liveService);
      }
      if (url.includes('run.googleapis.com') && method === 'PATCH') {
        patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ name: 'operations/update-service', done: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile', startCommand: 'npm start' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    // Redeploy with a new image and only one explicit env var.
    const result = await adapter.deploy(service, environment, {
      IMAGE_URI: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:new',
      FEATURE_FLAG: 'on',
    });

    expect(result.receipt.success).toBe(true);
    expect(patchBody).toBeTruthy();
    const template = patchBody!.template as { containers: Array<{ env: Array<{ name: string; value?: string }>; volumeMounts?: unknown[] }>; volumes?: unknown[] };
    const env = Object.fromEntries(template.containers[0].env.map((e) => [e.name, e.value]));

    // The var injected at provision time survives the redeploy...
    expect(env.DATABASE_URL).toBe('postgres://app:pw@34.44.202.227:5432/app');
    expect(env.CLOUD_SQL_CONNECTION_NAME).toBe('gcp-project:us-central1:app');
    expect(env.NODE_ENV).toBe('production');
    // ...and explicitly passed vars are applied.
    expect(env.FEATURE_FLAG).toBe('on');

    // Cloud SQL wiring survives too.
    expect(template.containers[0].volumeMounts).toContainEqual({ name: 'cloudsql', mountPath: '/cloudsql' });
    expect(template.volumes).toContainEqual(expect.objectContaining({ name: 'cloudsql' }));
  });

  it('does not create a service when exact service observation fails', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response('permission denied', { status: 403 });
      }
      return new Response('unexpected mutation', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const result = await adapter.deploy({
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile', startCommand: 'npm start' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    }, {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
      createdAt: now,
      updatedAt: now,
    }, {
      IMAGE_URI: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:new',
    });

    expect(result).toMatchObject({
      status: 'failed',
      receipt: { success: false, error: expect.stringMatching(/403.*permission denied/i) },
    });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('does not create a scheduled job when its second existence observation fails', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    let jobReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/jobs/gcp-project-cron') && method === 'GET') {
        jobReads += 1;
        return jobReads === 1
          ? new Response('not found', { status: 404 })
          : new Response('rate limited', { status: 429 });
      }
      return new Response('unexpected mutation', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const result = await adapter.deploy({
      id: 'service-1',
      projectId: 'project-1',
      name: 'cron',
      buildConfig: {
        workloadKind: 'cron',
        builder: 'dockerfile',
        startCommand: 'npm run cron',
        cronSchedule: '*/5 * * * *',
      },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    }, {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    }, {
      IMAGE_URI_CRON: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:new',
    });

    expect(result).toMatchObject({
      status: 'failed',
      receipt: { success: false, error: expect.stringMatching(/429.*rate limited/i) },
    });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('keeps exact-SHA CI as the code release boundary for an existing service', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const currentImage = 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:previous-compatible-sha';
    const liveService = {
      name: 'gcp-project-web',
      uri: 'https://gcp-project-web.run.app',
      terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
      template: {
        containers: [{
          image: currentImage,
          env: [{ name: 'NODE_ENV', value: 'production' }],
        }],
      },
    };
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('run.googleapis.com') && method === 'GET') {
        return Response.json(liveService);
      }
      if (url.includes('run.googleapis.com') && method === 'PATCH') {
        patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        liveService.template = patchBody.template as typeof liveService.template;
        return Response.json({ name: 'operations/configure-service', done: true });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile', public: false },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const preSync = await adapter.setEnvVars(
      environment,
      service,
      { NEW_API_TOKEN: 'secret-value' },
      { deferDeployment: true }
    );
    expect(preSync.data).toMatchObject({ deploymentDeferred: true });
    expect(preSync.data?.runtimeRolloutRequired).toBeUndefined();
    expect(patchBody).toBeTruthy();

    const result = await adapter.deploy(
      service,
      environment,
      {
        IMAGE_URI: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:not-the-approved-sha',
        NEW_API_TOKEN: 'secret-value',
      },
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    expect(result.receipt.data).toMatchObject({ deploymentDeferred: true });
    expect(result.receipt.data?.runtimeRolloutRequired).toBeUndefined();
    const template = patchBody?.template as { containers: Array<{ image: string; env: Array<{ name: string; value?: string }> }> };
    expect(template.containers[0].image).toBe(currentImage);
    expect(template.containers[0].env).toContainEqual({ name: 'NEW_API_TOKEN', value: 'secret-value' });
  });

  it('explains missing source metadata when no image can be built', async () => {
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
    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.deploy(service, environment, {});

    expect(result.status).toBe('failed');
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.message).toBe('Cloud Run could not build an image for service web');
    expect(result.receipt.error).toContain('gitRemoteUrl');
    expect(result.receipt.data).toMatchObject({
      provider: 'cloudrun',
      phase: 'image_build',
      missing: ['HYPERVIBE_SOURCE_REPO_URL'],
    });
  });

  it('verifies with an actionable warning when Cloud Logging views are not readable', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ services: [] });
      }
      if (url === 'https://logging.googleapis.com/v2/entries:list' && init?.method === 'POST') {
        return Response.json({
          error: {
            code: 403,
            message: 'Permission denied for all log views',
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.email).toBe('deploy@gcp-project.iam.gserviceaccount.com');
    expect(result.warning).toContain('roles/logging.viewer');
    expect(result.warning).toContain('roles/logging.viewAccessor');
    expect(result.warning).toContain('serviceAccount:deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification when the Cloud Run Admin API probe is denied', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          error: {
            code: 403,
            message: "Permission 'run.services.list' denied on resource",
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('roles/run.admin');
    expect(result.error).toContain('serviceAccount:deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification with status and body on non-403 Cloud Run Admin API errors', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && (init?.method ?? 'GET') === 'GET') {
        return new Response('backend unavailable', { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
    expect(result.error).toContain('backend unavailable');
  });

  it('enables Cloud Resource Manager before repairing logging IAM when the API is disabled', async () => {
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

    let iamPolicyReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        iamPolicyReads += 1;
        if (iamPolicyReads === 1) {
          return Response.json({
            error: {
              code: 403,
              message: 'Cloud Resource Manager API has not been used in project gcp-project before or it is disabled. Enable it by visiting https://console.cloud.google.com/apis/api/cloudresourcemanager.googleapis.com/overview?project=gcp-project',
              status: 'PERMISSION_DENIED',
            },
          }, { status: 403 });
        }
        return Response.json({ bindings: [] });
      }
      if (url.endsWith('/services/cloudresourcemanager.googleapis.com:enable') && method === 'POST') {
        return Response.json({ name: 'operations/serviceusage-enable', done: true });
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        return Response.json(JSON.parse(String(init?.body)).policy);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.repairLoggingAccess();

    expect(result.success).toBe(true);
    expect(result.data?.updatedRoles).toEqual(['roles/logging.viewer', 'roles/logging.viewAccessor']);
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith('/services/cloudresourcemanager.googleapis.com:enable')
    )).toBe(true);

    const setIamCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(':setIamPolicy') && init?.method === 'POST'
    );
    expect(setIamCall).toBeTruthy();
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    expect(setIamBody.policy.bindings).toEqual([
      {
        role: 'roles/logging.viewer',
        members: ['serviceAccount:deploy@gcp-project.iam.gserviceaccount.com'],
      },
      {
        role: 'roles/logging.viewAccessor',
        members: ['serviceAccount:deploy@gcp-project.iam.gserviceaccount.com'],
      },
    ]);
  });

  it('attempts logging IAM repair during project convergence without blocking deploy', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        return Response.json({ bindings: [] });
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        return Response.json(JSON.parse(String(init?.body)).policy);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }));

    const now = new Date();
    const receipt = await adapter.ensureProject('demo', {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    });

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      projectId: 'gcp-project',
      gcpProjectId: 'gcp-project',
      environmentId: 'us-central1',
      loggingIamRepair: {
        success: true,
      },
    });
  });

  it('builds an image with Cloud Build before deploying when source metadata is available', async () => {
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

    let serviceCreated = false;
    let servicePublic = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('artifactregistry.googleapis.com') && method === 'GET') {
        return new Response('missing', { status: 404 });
      }
      if (url.includes('artifactregistry.googleapis.com') && method === 'POST') {
        return Response.json({ name: 'operations/create-repo' });
      }
      if (url.includes('cloudbuild.googleapis.com') && method === 'POST') {
        return Response.json({
          name: 'operations/build-1',
          done: false,
          metadata: {
            build: {
              id: 'build-1',
              status: 'SUCCESS',
              logUrl: 'https://console.cloud.google.com/cloud-build/builds/build-1',
            },
          },
        });
      }
      if (url.endsWith('/services/gcp-project-web:getIamPolicy') && method === 'GET') {
        return Response.json({
          bindings: servicePublic
            ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
            : [],
        });
      }
      if (url.endsWith('/services/gcp-project-web:setIamPolicy') && method === 'POST') {
        const policy = JSON.parse(String(init?.body)).policy;
        servicePublic = policy.bindings.some((binding: { role?: string; members?: string[] }) =>
          binding.role === 'roles/run.invoker' && binding.members?.includes('allUsers')
        );
        return Response.json(policy);
      }
      if (url.includes('run.googleapis.com') && method === 'GET') {
        if (!serviceCreated) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          name: 'gcp-project-web',
          uid: 'uid-1',
          generation: '1',
          observedGeneration: '1',
          reconciling: false,
          uri: 'https://gcp-project-web.run.app',
          terminalCondition: {
            type: 'Ready',
            state: 'CONDITION_SUCCEEDED',
          },
          template: {
            containers: [{
              image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
            }],
          },
        });
      }
      if (url.includes('run.googleapis.com') && method === 'POST') {
        serviceCreated = true;
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/create-service',
          done: true,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: {
        builder: 'dockerfile',
        startCommand: 'npm start',
        runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.deploy(service, environment, {
      HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/acme/demo.git',
      HYPERVIBE_SOURCE_REVISION: 'main',
      HYPERVIBE_GITHUB_TOKEN: 'ghp_private_repo_token',
      DATABASE_URL: 'postgres://example',
      CLOUD_SQL_CONNECTION_NAME: 'gcp-project:us-central1:app',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.status).toBe('deployed');
    expect(result.url).toBe('https://gcp-project-web.run.app');
    expect(result.receipt.data?.imageUri).toMatch(/^us-central1-docker\.pkg\.dev\/gcp-project\/infraprint\/production-web:main-/);
    expect(result.receipt.data?.build).toMatchObject({
      id: 'build-1',
      logsUrl: 'https://console.cloud.google.com/cloud-build/builds/build-1',
    });
    expect(result.receipt.data?.public).toBe(true);
    expect(result.receipt.data?.publicAccessConfigured).toBe(true);
    expect(result.receipt.data?.publicInvokerBindingUpdated).toBe(true);

    const buildCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('cloudbuild.googleapis.com') && init?.method === 'POST'
    );
    expect(buildCall).toBeTruthy();
    const buildBody = JSON.parse(String(buildCall?.[1]?.body));
    const buildScript = String(buildBody.steps[0].args[1]);
    const dockerfileBase64 = buildScript.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 --decode/)?.[1];
    expect(dockerfileBase64).toBeTruthy();
    expect(Buffer.from(dockerfileBase64!, 'base64').toString('utf8')).toContain('FROM node:24-slim');
    expect(buildBody.source.gitSource).toEqual({
      url: 'https://x-access-token:ghp_private_repo_token@github.com/acme/demo.git',
      revision: 'main',
    });
    expect(buildBody.images[0]).toBe(result.receipt.data?.imageUri);

    const deployCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('run.googleapis.com') && init?.method === 'POST'
    );
    expect(String(deployCall?.[0])).toContain('serviceId=gcp-project-web');
    const deployBody = JSON.parse(String(deployCall?.[1]?.body));
    expect(deployBody).not.toHaveProperty('apiVersion');
    expect(deployBody).not.toHaveProperty('kind');
    expect(deployBody).not.toHaveProperty('metadata');
    expect(deployBody).not.toHaveProperty('spec');
    expect(deployBody.labels).toEqual({
      'infraprint-environment': 'production',
      'infraprint-service': 'web',
    });
    expect(deployBody.ingress).toBe('INGRESS_TRAFFIC_ALL');
    expect(deployBody.template.serviceAccount).toBe('deploy@gcp-project.iam.gserviceaccount.com');
    expect(deployBody.template.containers[0].image).toBe(result.receipt.data?.imageUri);
    expect(deployBody.template.containers[0].env).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://example' },
      { name: 'CLOUD_SQL_CONNECTION_NAME', value: 'gcp-project:us-central1:app' },
    ]);
    expect(deployBody.template.containers[0].volumeMounts).toEqual([
      { name: 'cloudsql', mountPath: '/cloudsql' },
    ]);
    expect(deployBody.template.volumes).toEqual([
      {
        name: 'cloudsql',
        cloudSqlInstance: {
          instances: ['gcp-project:us-central1:app'],
        },
      },
    ]);

    const iamCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith('/services/gcp-project-web:setIamPolicy') && init?.method === 'POST'
    );
    expect(iamCall).toBeTruthy();
    const getIamCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/services/gcp-project-web:getIamPolicy')
    );
    expect(getIamCall?.[1]?.method ?? 'GET').toBe('GET');
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/services/gcp-project-web:getIamPolicy')
    )).toHaveLength(2);
    const iamBody = JSON.parse(String(iamCall?.[1]?.body));
    expect(iamBody.policy.bindings).toContainEqual({
      role: 'roles/run.invoker',
      members: ['allUsers'],
    });
  });

  it('does not grant public invocation for private non-web workloads', async () => {
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

    let serviceCreated = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes(':getIamPolicy') || url.includes(':setIamPolicy')) {
        throw new Error(`Unexpected IAM fetch: ${method} ${url}`);
      }
      if (url.includes('/services/gcp-project-worker') && method === 'GET') {
        if (!serviceCreated) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          name: 'gcp-project-worker',
          uid: 'uid-1',
          generation: '1',
          observedGeneration: '1',
          reconciling: false,
          uri: 'https://gcp-project-worker.run.app',
          terminalCondition: {
            type: 'Ready',
            state: 'CONDITION_SUCCEEDED',
          },
          template: {
            containers: [{
              image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-worker:main',
            }],
          },
        });
      }
      if (url.includes('run.googleapis.com') && method === 'POST') {
        serviceCreated = true;
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/create-service',
          done: true,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'worker',
      buildConfig: {
        workloadKind: 'worker',
        builder: 'dockerfile',
        startCommand: 'npm run worker',
        public: false,
      },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.deploy(service, environment, {
      IMAGE_URI_WORKER: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-worker:main',
    });

    expect(result.status).toBe('deployed');
    expect(result.receipt.data?.public).toBe(false);
    expect(result.receipt.data?.publicAccessConfigured).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(':setIamPolicy'))).toBe(false);

    // Workers must not scale to zero and must not receive external traffic.
    const deployCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('run.googleapis.com') && init?.method === 'POST'
    );
    const deployBody = JSON.parse(String(deployCall?.[1]?.body));
    expect(deployBody.ingress).toBe('INGRESS_TRAFFIC_INTERNAL_ONLY');
    expect(deployBody.template.scaling).toEqual({ minInstanceCount: 1 });
  });

  it('updates existing service env vars with the Cloud Run v2 service shape', async () => {
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

    let liveService: Record<string, any> = {
      name: 'gcp-project-web',
      uri: 'https://gcp-project-web.run.app',
      terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
      template: {
        containers: [{
          image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
          ports: [{ containerPort: 8080 }],
          env: [
            { name: 'DATABASE_URL', value: 'postgres://old' },
            { name: 'SECRET_VALUE', valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } } },
          ],
          resources: { limits: { cpu: '1', memory: '512Mi' } },
        }],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('run.googleapis.com') && method === 'GET') {
        return Response.json(liveService);
      }
      if (url.includes('run.googleapis.com') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        liveService = { ...liveService, template: body.template };
        return Response.json({ name: 'operations/env-update', done: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.setEnvVars(environment, service, {
      DATABASE_URL: 'postgres://new',
      HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/acme/demo.git',
    });

    expect(result.success).toBe(true);
    expect(result.data?.variableCount).toBe(1);

    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('run.googleapis.com') && init?.method === 'PATCH'
    );
    expect(String(patchCall?.[0])).toContain('updateMask=template.containers');
    const patchBody = JSON.parse(String(patchCall?.[1]?.body));
    expect(patchBody).not.toHaveProperty('spec');
    expect(patchBody.template.containers[0].image).toBe('us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main');
    expect(patchBody.template.containers[0].env).toContainEqual({ name: 'DATABASE_URL', value: 'postgres://new' });
    expect(patchBody.template.containers[0].env).toContainEqual({
      name: 'SECRET_VALUE',
      valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } },
    });
  });

  it('deletes only explicitly retired service env vars while preserving the current image and other values', async () => {
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

    let updated = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('run.googleapis.com') && method === 'GET') {
        return Response.json({
          name: 'gcp-project-web',
          uri: 'https://gcp-project-web.run.app',
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
              image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:compatible',
              env: updated
                ? [
                  { name: 'KEEP_ME', value: 'preserved' },
                  { name: 'SECRET_VALUE', valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } } },
                ]
                : [
                  { name: 'OLD_API_TOKEN', value: 'must-not-leak' },
                  { name: 'KEEP_ME', value: 'preserved' },
                  { name: 'SECRET_VALUE', valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } } },
                ],
              resources: { limits: { cpu: '1', memory: '512Mi' } },
            }],
          },
        });
      }
      if (url.includes('run.googleapis.com') && method === 'PATCH') {
        updated = true;
        return Response.json({ name: 'operations/remove-env', done: true });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.deleteEnvVars!(
      environment,
      service,
      ['OLD_API_TOKEN']
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        deletedKeys: ['OLD_API_TOKEN'],
        variableCount: 1,
        redeployMayBeTriggered: true,
      },
    });
    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('run.googleapis.com') && init?.method === 'PATCH'
    );
    const patchBody = JSON.parse(String(patchCall?.[1]?.body));
    expect(patchBody.template.containers[0].image)
      .toBe('us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:compatible');
    expect(patchBody.template.containers[0].env).toEqual([
      { name: 'KEEP_ME', value: 'preserved' },
      { name: 'SECRET_VALUE', valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } } },
    ]);
    expect(patchBody.template).not.toHaveProperty('vpcAccess');
    expect(String(patchCall?.[0])).not.toContain('template.vpcAccess');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('attaches the exact cache VPC during a service environment update', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const network = 'projects/gcp-project/global/networks/default';
    const subnetwork = 'projects/gcp-project/regions/us-central1/subnetworks/default';
    let liveTemplate: Record<string, unknown> = {
      containers: [{ image: 'image:current', env: [] }],
    };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('compute.googleapis.com') && url.endsWith('/global/networks/default')) {
        return Response.json({ selfLink: `https://www.googleapis.com/compute/v1/${network}` });
      }
      if (url.includes('compute.googleapis.com') && url.endsWith('/regions/us-central1/subnetworks/default')) {
        return Response.json({ network: `https://www.googleapis.com/compute/v1/${network}` });
      }
      if (url.includes('/services/gcp-project-web') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/services/gcp-project-web',
          uid: 'uid-web',
          generation: '2',
          observedGeneration: '2',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          template: liveTemplate,
        });
      }
      if (url.includes('/services/gcp-project-web') && method === 'PATCH') {
        liveTemplate = JSON.parse(String(init?.body)).template;
        return Response.json({ name: 'operations/vpc-env', done: true });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', createdAt: now, updatedAt: now,
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
        cacheNetwork: {
          provider: 'cloudrun', projectId: 'gcp-project', region: 'us-central1',
          network, subnetwork, egress: 'PRIVATE_RANGES_ONLY',
        },
      },
    };
    const service: Service = {
      id: 'service-1', projectId: 'project-1', name: 'web',
      buildConfig: { builder: 'dockerfile' }, envVarSpec: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.setEnvVars(environment, service, { REDIS_URL: 'redis://private' });

    expect(result.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/services/gcp-project-web') && init?.method === 'PATCH'
    );
    expect(String(patchCall?.[0])).toContain('template.vpcAccess');
    expect(JSON.parse(String(patchCall?.[1]?.body)).template.vpcAccess).toEqual({
      networkInterfaces: [{ network, subnetwork }],
      egress: 'PRIVATE_RANGES_ONLY',
    });
  });

  it('removes Direct VPC egress even when REDIS_URL is already absent', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const network = 'projects/gcp-project/global/networks/default';
    const subnetwork = 'projects/gcp-project/regions/us-central1/subnetworks/default';
    let liveTemplate: Record<string, unknown> = {
      containers: [{ image: 'image:current', env: [{ name: 'KEEP', value: 'yes' }] }],
      vpcAccess: {
        networkInterfaces: [{ network, subnetwork }],
        egress: 'PRIVATE_RANGES_ONLY',
      },
    };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/services/gcp-project-web') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/services/gcp-project-web',
          uid: 'uid-web', generation: '3', observedGeneration: '3',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          template: liveTemplate,
        });
      }
      if (url.includes('/services/gcp-project-web') && method === 'PATCH') {
        liveTemplate = JSON.parse(String(init?.body)).template;
        return Response.json({ name: 'operations/remove-vpc', done: true });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', createdAt: now, updatedAt: now,
      platformBindings: {
        provider: 'cloudrun', projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
        cacheNetwork: null,
      },
    };
    const service: Service = {
      id: 'service-1', projectId: 'project-1', name: 'web',
      buildConfig: { builder: 'dockerfile' }, envVarSpec: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.deleteEnvVars!(environment, service, ['REDIS_URL']);

    expect(result.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/services/gcp-project-web') && init?.method === 'PATCH'
    );
    expect(String(patchCall?.[0])).toContain('template.vpcAccess');
    expect(JSON.parse(String(patchCall?.[1]?.body)).template.vpcAccess).toEqual({});
  });

  it('removes stale Cloud SQL wiring when syncing Supabase database vars', async () => {
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

    let liveService: Record<string, any> = {
      name: 'gcp-project-web',
      terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
      template: {
        containers: [{
          image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
          env: [
            { name: 'DATABASE_URL', value: 'postgres://old-cloudsql' },
            { name: 'CLOUD_SQL_CONNECTION_NAME', value: 'gcp-project:us-central1:app' },
            { name: 'INSTANCE_CONNECTION_NAME', value: 'gcp-project:us-central1:app' },
            { name: 'NODE_ENV', value: 'production' },
          ],
          volumeMounts: [
            { name: 'cloudsql', mountPath: '/cloudsql' },
            { name: 'cache', mountPath: '/cache' },
          ],
          resources: { limits: { cpu: '1', memory: '512Mi' } },
        }],
        volumes: [
          { name: 'cloudsql', cloudSqlInstance: { instances: ['gcp-project:us-central1:app'] } },
          { name: 'cache', emptyDir: {} },
        ],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('run.googleapis.com') && method === 'GET') {
        return Response.json(liveService);
      }
      if (url.includes('run.googleapis.com') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        liveService = { ...liveService, template: body.template };
        return Response.json({ name: 'operations/env-update', done: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.setEnvVars(environment, service, {
      DATABASE_URL: 'postgresql://postgres:pw@db.supabase.co:5432/postgres',
      DIRECT_URL: 'postgresql://postgres:pw@db.supabase.co:5432/postgres',
      DATABASE_HOST: 'db.supabase.co',
      PGHOST: 'db.supabase.co',
      DATABASE_SSL: 'true',
    });

    expect(result.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('run.googleapis.com') && init?.method === 'PATCH'
    );
    expect(String(patchCall?.[0])).toContain('updateMask=template.containers,template.volumes');
    const patchBody = JSON.parse(String(patchCall?.[1]?.body));
    const container = patchBody.template.containers[0];
    const env = Object.fromEntries(container.env.map((entry: { name: string; value?: string }) => [entry.name, entry.value]));
    expect(env.DATABASE_URL).toBe('postgresql://postgres:pw@db.supabase.co:5432/postgres');
    expect(env.DATABASE_SSL).toBe('true');
    expect(env.CLOUD_SQL_CONNECTION_NAME).toBeUndefined();
    expect(env.INSTANCE_CONNECTION_NAME).toBeUndefined();
    expect(env.NODE_ENV).toBe('production');
    expect(container.volumeMounts).toEqual([{ name: 'cache', mountPath: '/cache' }]);
    expect(patchBody.template.volumes).toEqual([{ name: 'cache', emptyDir: {} }]);
  });

  it('removes stale Supabase SSL and pooler vars when syncing Cloud SQL database vars', async () => {
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

    let updatedTemplate: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('run.googleapis.com') && method === 'GET') {
        if (updatedTemplate) {
          return Response.json({
            name: 'gcp-project-web',
            terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
            template: updatedTemplate,
          });
        }
        return Response.json({
          name: 'gcp-project-web',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          template: {
            containers: [{
              image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
              env: [
                { name: 'DATABASE_URL', value: 'postgresql://postgres:pw@db.supabase.co:5432/postgres' },
                { name: 'DIRECT_URL', value: 'postgresql://postgres:pw@db.supabase.co:5432/postgres' },
                { name: 'DATABASE_POOLER_URL', value: 'postgresql://postgres:pw@db.supabase.co:6543/postgres?pgbouncer=true' },
                { name: 'DATABASE_SSL', value: 'true' },
                { name: 'NODE_ENV', value: 'production' },
              ],
              resources: { limits: { cpu: '1', memory: '512Mi' } },
            }],
          },
        });
      }
      if (url.includes('run.googleapis.com') && method === 'PATCH') {
        updatedTemplate = JSON.parse(String(init?.body)).template;
        return Response.json({ name: 'operations/env-update', done: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.setEnvVars(environment, service, {
      DATABASE_URL: 'postgresql://app:pw@/app?host=%2Fcloudsql%2Fgcp-project%3Aus-central1%3Aapp',
      DIRECT_URL: 'postgresql://app:pw@/app?host=%2Fcloudsql%2Fgcp-project%3Aus-central1%3Aapp',
      CLOUD_SQL_CONNECTION_NAME: 'gcp-project:us-central1:app',
      INSTANCE_CONNECTION_NAME: 'gcp-project:us-central1:app',
      DATABASE_HOST: '/cloudsql/gcp-project:us-central1:app',
      PGHOST: '/cloudsql/gcp-project:us-central1:app',
    });

    expect(result.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('run.googleapis.com') && init?.method === 'PATCH'
    );
    const patchBody = JSON.parse(String(patchCall?.[1]?.body));
    const container = patchBody.template.containers[0];
    const env = Object.fromEntries(container.env.map((entry: { name: string; value?: string }) => [entry.name, entry.value]));
    expect(env.DATABASE_URL).toContain('/app?host=%2Fcloudsql%2Fgcp-project%3Aus-central1%3Aapp');
    expect(env.DATABASE_SSL).toBeUndefined();
    expect(env.DATABASE_POOLER_URL).toBeUndefined();
    expect(env.CLOUD_SQL_CONNECTION_NAME).toBe('gcp-project:us-central1:app');
    expect(env.NODE_ENV).toBe('production');
    expect(container.volumeMounts).toContainEqual({ name: 'cloudsql', mountPath: '/cloudsql' });
    expect(patchBody.template.volumes).toContainEqual({
      name: 'cloudsql',
      cloudSqlInstance: { instances: ['gcp-project:us-central1:app'] },
    });
  });

  it('fails migration jobs clearly when no service image is recorded', async () => {
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.runJob(environment, service, 'npm run migrate');

    expect(result.status).toBe('failed');
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.message).toBe('Cloud Run environment task requires an image for service web');
    expect(result.receipt.error).toContain('Deploy the service first');
  });

  it('updates an existing migration job without updateMask before running it', async () => {
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

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('/services/gcp-project-web') && method === 'GET') {
        return Response.json({
          name: 'gcp-project-web',
          template: {
            serviceAccount: 'deploy@gcp-project.iam.gserviceaccount.com',
            containers: [{
              image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
              env: [{ name: 'DATABASE_URL', value: 'postgres://example' }],
              resources: { limits: { cpu: '1', memory: '512Mi' } },
            }],
          },
        });
      }
      if (url.includes('/jobs/gcp-project-web-migration/executions') && method === 'GET') {
        return Response.json({
          executions: [{
            name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-web-migration/executions/execution-1',
            completionStatus: 'EXECUTION_SUCCEEDED',
          }],
        });
      }
      if (url.includes('/jobs/gcp-project-web-migration:run') && method === 'POST') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/run-job',
          done: false,
        });
      }
      if (url.includes('/jobs/gcp-project-web-migration') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-web-migration',
          generation: '2',
          observedGeneration: '2',
          reconciling: false,
          terminalCondition: {
            type: 'Ready',
            state: 'CONDITION_SUCCEEDED',
          },
        });
      }
      if (url.includes('/jobs/gcp-project-web-migration') && method === 'PATCH') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/update-job',
          done: true,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: {
            serviceId: 'gcp-project-web',
            imageUri: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:stale',
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.runJob(environment, service, 'npm run db:setup');

    expect(result.status).toBe('completed');
    expect(result.receipt.success).toBe(true);

    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/jobs/gcp-project-web-migration') && init?.method === 'PATCH'
    );
    expect(String(patchCall?.[0])).not.toContain('updateMask');
    const patchBody = JSON.parse(String(patchCall?.[1]?.body));
    expect(patchBody.template.template.serviceAccount).toBe('deploy@gcp-project.iam.gserviceaccount.com');
    expect(patchBody.template.template.containers[0]).toMatchObject({
      image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
      command: ['/bin/sh'],
      args: ['-lc', 'npm run db:setup'],
      env: [{ name: 'DATABASE_URL', value: 'postgres://example' }],
    });

    const runCallIndex = fetchMock.mock.calls.findIndex(([url, init]) =>
      String(url).includes('/jobs/gcp-project-web-migration:run') && init?.method === 'POST'
    );
    const readyCheckIndex = fetchMock.mock.calls.findIndex(([url, init]) =>
      String(url).includes('/jobs/gcp-project-web-migration') && !String(url).includes(':run') && (init?.method ?? 'GET') === 'GET'
    );
    expect(readyCheckIndex).toBeGreaterThan(-1);
    expect(runCallIndex).toBeGreaterThan(readyCheckIndex);
  });

  it('deploys cron workloads as Cloud Run Jobs triggered by Cloud Scheduler', async () => {
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

    let jobCreated = false;
    let schedulerCreated = false;
    const network = 'projects/gcp-project/global/networks/default';
    const subnetwork = 'projects/gcp-project/regions/us-central1/subnetworks/default';
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('compute.googleapis.com') && url.endsWith('/global/networks/default')) {
        return Response.json({ selfLink: `https://www.googleapis.com/compute/v1/${network}` });
      }
      if (url.includes('compute.googleapis.com') && url.endsWith('/regions/us-central1/subnetworks/default')) {
        return Response.json({ network: `https://www.googleapis.com/compute/v1/${network}` });
      }

      if (url.includes('run.googleapis.com') && url.includes('/jobs/gcp-project-cron') && !url.includes(':run') && method === 'GET') {
        if (!jobCreated) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron',
          generation: '1',
          observedGeneration: '1',
          reconciling: false,
          terminalCondition: {
            type: 'Ready',
            state: 'CONDITION_SUCCEEDED',
          },
          template: {
            template: {
              vpcAccess: {
                networkInterfaces: [{ network, subnetwork }],
                egress: 'PRIVATE_RANGES_ONLY',
              },
              containers: [{
                image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
              }],
            },
          },
        });
      }
      if (url.includes('run.googleapis.com') && url.includes('/jobs?jobId=gcp-project-cron') && method === 'POST') {
        jobCreated = true;
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/create-job',
          done: true,
        });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.includes('/jobs/gcp-project-cron-schedule') && method === 'GET') {
        if (!schedulerCreated) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          state: 'ENABLED',
        });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs') && method === 'POST') {
        schedulerCreated = true;
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          state: 'ENABLED',
        });
      }
      if (url.includes('/services/gcp-project-cron') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        cacheNetwork: {
          provider: 'cloudrun',
          projectId: 'gcp-project',
          region: 'us-central1',
          network,
          subnetwork,
          egress: 'PRIVATE_RANGES_ONLY',
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    const service: Service = {
      id: 'service-1',
      projectId: 'project-1',
      name: 'cron',
      buildConfig: {
        workloadKind: 'cron',
        builder: 'dockerfile',
        startCommand: 'npm run cron',
        cronSchedule: '*/5 * * * *',
      },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.deploy(service, environment, {
      IMAGE_URI_CRON: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
      DATABASE_URL: 'postgres://example',
      HYPERVIBE_CRON_TIME_ZONE: 'America/Vancouver',
    });

    expect(result.status).toBe('deployed');
    expect(result.externalId).toBe('gcp-project-cron-schedule');
    expect(result.receipt.data).toMatchObject({
      resourceType: 'scheduledJob',
      jobName: 'gcp-project-cron',
      schedulerJobName: 'gcp-project-cron-schedule',
      schedule: '*/5 * * * *',
      imageUri: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
      createdJob: true,
      createdScheduler: true,
    });

    const jobCreateCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/jobs?jobId=gcp-project-cron') && init?.method === 'POST'
    );
    expect(jobCreateCall).toBeTruthy();
    const jobBody = JSON.parse(String(jobCreateCall?.[1]?.body));
    expect(jobBody.labels).toEqual({
      'infraprint-environment': 'production',
      'infraprint-service': 'cron',
      'infraprint-resource': 'scheduled-job',
    });
    expect(jobBody.template.template.serviceAccount).toBe('deploy@gcp-project.iam.gserviceaccount.com');
    expect(jobBody.template.template.vpcAccess).toEqual({
      networkInterfaces: [{ network, subnetwork }],
      egress: 'PRIVATE_RANGES_ONLY',
    });
    expect(jobBody.template.template).not.toHaveProperty('labels');
    expect(jobBody.template.template.containers[0]).toMatchObject({
      image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
      command: ['/bin/sh'],
      args: ['-lc', 'npm run cron'],
      env: [
        { name: 'DATABASE_URL', value: 'postgres://example' },
      ],
    });

    const schedulerCreateCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('cloudscheduler.googleapis.com') && String(url).endsWith('/jobs') && init?.method === 'POST'
    );
    expect(schedulerCreateCall).toBeTruthy();
    const schedulerBody = JSON.parse(String(schedulerCreateCall?.[1]?.body));
    expect(schedulerBody).toMatchObject({
      name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
      schedule: '*/5 * * * *',
      timeZone: 'America/Vancouver',
      httpTarget: {
        uri: 'https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs/gcp-project-cron:run',
        httpMethod: 'POST',
        oauthToken: {
          serviceAccountEmail: 'deploy@gcp-project.iam.gserviceaccount.com',
          scope: 'https://www.googleapis.com/auth/cloud-platform',
        },
      },
    });

    const serviceWriteCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/services') && ['POST', 'PATCH'].includes(init?.method ?? 'GET')
    );
    expect(serviceWriteCall).toBeUndefined();
  });

  it('enables Cloud Scheduler API and retries cron schedule creation when the API is disabled', async () => {
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

    let jobCreated = false;
    let schedulerCreateAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('run.googleapis.com') && url.includes('/jobs/gcp-project-cron') && !url.includes(':run') && method === 'GET') {
        if (!jobCreated) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron',
          generation: '1',
          observedGeneration: '1',
          reconciling: false,
          terminalCondition: {
            type: 'Ready',
            state: 'CONDITION_SUCCEEDED',
          },
          template: {
            template: {
              containers: [{
                image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
              }],
            },
          },
        });
      }
      if (url.includes('run.googleapis.com') && url.includes('/jobs?jobId=gcp-project-cron') && method === 'POST') {
        jobCreated = true;
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/operations/create-job',
          done: true,
        });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.includes('/jobs/gcp-project-cron-schedule') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs') && method === 'POST') {
        schedulerCreateAttempts += 1;
        if (schedulerCreateAttempts === 1) {
          return Response.json({
            error: {
              code: 403,
              message: 'Cloud Scheduler API has not been used in project gcp-project before or it is disabled. Enable it by visiting https://console.cloud.google.com/apis/api/cloudscheduler.googleapis.com/overview?project=gcp-project',
              status: 'PERMISSION_DENIED',
            },
          }, { status: 403 });
        }
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          state: 'ENABLED',
        });
      }
      if (url.endsWith('/services/cloudscheduler.googleapis.com:enable') && method === 'POST') {
        return Response.json({ name: 'operations/enable-scheduler', done: true });
      }
      if (url.includes('/services/gcp-project-cron') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const result = await adapter.deploy({
      id: 'service-1',
      projectId: 'project-1',
      name: 'cron',
      buildConfig: {
        workloadKind: 'cron',
        builder: 'dockerfile',
        startCommand: 'npm run cron',
        cronSchedule: '*/5 * * * *',
      },
      envVarSpec: {},
      createdAt: now,
      updatedAt: now,
    }, {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    }, {
      IMAGE_URI_CRON: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
    });

    expect(result.status).toBe('deployed');
    expect(schedulerCreateAttempts).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith('/services/cloudscheduler.googleapis.com:enable')
    )).toBe(true);
  });

  it('reads Cloud Run service logs from Cloud Logging', async () => {
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

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://logging.googleapis.com/v2/entries:list' && init?.method === 'POST') {
        return Response.json({
          entries: [{
            timestamp: '2026-06-03T18:00:00Z',
            severity: 'ERROR',
            textPayload: 'boom',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const logs = await adapter.getLogs({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, 'web', { limit: 25, errorsOnly: true });

    expect(logs).toEqual([{
      timestamp: new Date('2026-06-03T18:00:00Z'),
      severity: 'error',
      message: 'boom',
      raw: expect.any(String),
    }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.pageSize).toBe(25);
    expect(body.filter).toContain('resource.type="cloud_run_revision"');
    expect(body.filter).toContain('resource.labels.service_name="gcp-project-web"');
    expect(body.filter).toContain('severity>=WARNING');
  });

  it('explains the required IAM roles when Cloud Logging rejects log view access', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://logging.googleapis.com/v2/entries:list' && init?.method === 'POST') {
        return Response.json({
          error: {
            code: 403,
            message: 'Permission denied for all log views',
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const now = new Date();
    await expect(adapter.getLogs({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, 'web', { limit: 25 })).rejects.toThrow(/roles\/logging\.viewAccessor/);
  });

  it('lists Cloud Run revisions and scheduled job executions as deployments', async () => {
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

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/services/gcp-project-web') && !url.includes('/revisions') && method === 'GET') {
        return Response.json({
          name: 'gcp-project-web',
          uid: 'uid-1',
          generation: '1',
          observedGeneration: '1',
          reconciling: false,
          uri: 'https://gcp-project-web.run.app',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
        });
      }
      if (url.includes('/services/gcp-project-web/revisions') && method === 'GET') {
        return Response.json({
          revisions: [{
            name: 'projects/gcp-project/locations/us-central1/services/gcp-project-web/revisions/gcp-project-web-00001',
            createTime: '2026-06-03T18:00:00Z',
            terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          }],
        });
      }
      if (url.includes('/jobs/gcp-project-cron/executions') && method === 'GET') {
        return Response.json({
          executions: [{
            name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron/executions/gcp-project-cron-abc',
            startTime: '2026-06-03T18:05:00Z',
            completionTime: '2026-06-03T18:05:10Z',
            completionStatus: 'EXECUTION_SUCCEEDED',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const deployments = await adapter.listDeployments({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
          cron: {
            serviceId: 'gcp-project-cron-schedule',
            jobName: 'gcp-project-cron',
            resourceType: 'scheduledJob',
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, undefined, 10);

    expect(deployments).toEqual([
      {
        id: 'gcp-project-cron-abc',
        status: 'completed',
        createdAt: '2026-06-03T18:05:00Z',
        updatedAt: '2026-06-03T18:05:10Z',
        service: 'cron',
        type: 'jobExecution',
      },
      {
        id: 'gcp-project-web-00001',
        status: 'deployed',
        createdAt: '2026-06-03T18:00:00Z',
        updatedAt: undefined,
        url: 'https://gcp-project-web.run.app',
        service: 'web',
        type: 'revision',
        logUri: undefined,
      },
    ]);
    });
  });

  it('preserves deployment-history API errors instead of returning empty history', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/services/gcp-project-web/revisions')) {
        return new Response('revision access denied', { status: 403 });
      }
      if (url.includes('/services/gcp-project-web')) {
        return Response.json({
          name: 'gcp-project-web',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const now = new Date();
    await expect(adapter.listDeployments({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
      createdAt: now,
      updatedAt: now,
    }, 'web', 10)).rejects.toThrow(/403.*revision access denied/i);
  });

  it('deletes scheduled jobs from Cloud Scheduler and Cloud Run Jobs', async () => {
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

    let jobDeleted = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('cloudscheduler.googleapis.com') && url.includes('/jobs/gcp-project-cron-schedule') && method === 'DELETE') {
        return Response.json({});
      }
      if (url.includes('run.googleapis.com') && url.includes('/jobs/gcp-project-cron') && method === 'GET') {
        if (jobDeleted) return Response.json({}, { status: 404 });
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron',
          template: { template: { containers: [{ image: 'image' }] } },
          terminalCondition: { state: 'CONDITION_SUCCEEDED' },
        });
      }
      if (url.includes('run.googleapis.com') && url.includes('/jobs/gcp-project-cron') && method === 'DELETE') {
        jobDeleted = true;
        return Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/delete-job', done: true });
      }
      if (url.includes('run.googleapis.com') && url.includes('/services/gcp-project-cron-schedule') && method === 'GET') {
        return Response.json({}, { status: 404 });
      }
      if (url.includes('run.googleapis.com') && url.includes('/services/gcp-project-cron') && method === 'GET') {
        return Response.json({}, { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.deleteService('gcp-project-cron-schedule');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloudscheduler.googleapis.com/v1/projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs/gcp-project-cron',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('does not treat a failed service existence read as successful deletion', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('cloudscheduler.googleapis.com') && method === 'DELETE') {
        return Response.json({}, { status: 404 });
      }
      if (url.includes('/jobs/gcp-project-web') && method === 'GET') {
        return Response.json({}, { status: 404 });
      }
      if (url.includes('/services/gcp-project-web') && method === 'GET') {
        return new Response('backend unavailable', { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.deleteService('gcp-project-web');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not verify whether Cloud Run service');
    expect(result.error).toContain('503 backend unavailable');
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).includes('/services/') && init?.method === 'DELETE'
    )).toBe(false);
  });
