import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import {
  runMockCacheLifecycleContract,
} from '../../__tests__/cache-lifecycle.contract.js';
import { MemorystoreAdapter, MemorystoreCredentialsSchema } from '../memorystore.adapter.js';

const PROJECT_ID = 'gcp-project';
const REGION = 'us-central1';
const INSTANCE_ID = 'invoice-perfect-production-redis';
const RESOURCE_NAME =
  `projects/${PROJECT_ID}/locations/${REGION}/instances/${INSTANCE_ID}`;
const SERVICE_ACCOUNT_SECRET = 'service-account-private-key-never-output';
const REDIS_AUTH = 'memorystore-auth-string-never-output';
const NETWORK = `projects/${PROJECT_ID}/global/networks/default`;
const SUBNETWORK = `projects/${PROJECT_ID}/regions/${REGION}/subnetworks/default`;

function environment(): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function component(externalId = RESOURCE_NAME): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: {
      provider: 'memorystore',
      instanceId: externalId,
      providerScope: { projectId: PROJECT_ID, region: REGION },
      network: NETWORK,
      authorizedNetwork: NETWORK,
      subnetwork: SUBNETWORK,
      privateNetworkOnly: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function instance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: RESOURCE_NAME,
    displayName: 'Invoice Perfect Production Redis',
    state: 'READY',
    host: '10.10.0.3',
    port: 6379,
    tier: 'BASIC',
    memorySizeGb: 1,
    redisVersion: 'REDIS_7_2',
    authorizedNetwork: NETWORK,
    connectMode: 'DIRECT_PEERING',
    authEnabled: true,
    transitEncryptionMode: 'DISABLED',
    ...overrides,
  };
}

async function connected(): Promise<MemorystoreAdapter> {
  const adapter = new MemorystoreAdapter();
  await adapter.connect({
    projectId: PROJECT_ID,
    region: REGION,
    credentials: JSON.stringify({
      type: 'service_account',
      project_id: PROJECT_ID,
      private_key: SERVICE_ACCOUNT_SECRET,
      client_email: `deploy@${PROJECT_ID}.iam.gserviceaccount.com`,
    }),
  });
  (adapter as unknown as {
    accessToken: string;
    tokenExpiresAt: number;
  }).accessToken = 'safe-access-token';
  (adapter as unknown as {
    accessToken: string;
    tokenExpiresAt: number;
  }).tokenExpiresAt = Date.now() + 60_000;
  return adapter;
}

runMockCacheLifecycleContract({
  displayName: 'Google Cloud Memorystore',
  externalIds: [
    `projects/${PROJECT_ID}/locations/${REGION}/instances/cache-1`,
    `projects/${PROJECT_ID}/locations/${REGION}/instances/cache-2`,
  ],
  resourceName: 'Invoice Perfect Production Redis',
  createAdapter: connected,
  makeEnvironment: environment,
  makeComponent: component,
  isListRequest: (url, init) =>
    url.pathname === `/v1/projects/${PROJECT_ID}/locations/${REGION}/instances`
    && (init?.method ?? 'GET') === 'GET',
  isItemRequest: (url, externalId, init) =>
    url.pathname === `/v1/${externalId}`
    && (init?.method ?? 'GET') === 'GET',
  listResponse: (resources) => ({
    instances: resources.map((resource) => ({
      name: resource.id,
      displayName: resource.name,
      state: 'READY',
    })),
  }),
});

describe('MemorystoreAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('accepts legacy stored placement keys but exposes an auth-only credential schema', () => {
    const credentials = JSON.stringify({ client_email: 'deploy@example.test', private_key: 'secret' });
    expect(MemorystoreCredentialsSchema.parse({
      projectId: PROJECT_ID,
      credentials,
      region: 'europe-west1',
      authorizedNetwork: 'legacy-network',
      connectMode: 'PRIVATE_SERVICE_ACCESS',
      tier: 'STANDARD_HA',
      memorySizeGb: 9,
    })).toEqual({ projectId: PROJECT_ID, credentials });
  });

  it('inventories differently named caches across the connected project', async () => {
    const adapter = await connected();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/v1/projects/${PROJECT_ID}/locations/-/instances`);
      return response({ instances: [instance({ displayName: 'customer-sessions' })] });
    }));

    await expect(adapter.inspectCacheResources({ resource: 'cache', limit: 25 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'cache',
        caches: [{
          id: RESOURCE_NAME,
          name: 'customer-sessions',
          providerScope: { projectId: PROJECT_ID, region: REGION },
        }],
        partial: false,
      });
  });

  it('creates private-IP Redis with AUTH and keeps the auth string out of receipts', async () => {
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS', '3');
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });
      if (url.pathname.endsWith(`/locations/${REGION}/instances`) && method === 'GET') {
        return response({ instances: [] });
      }
      if (url.pathname.endsWith(`/locations/${REGION}/instances`) && method === 'POST') {
        expect(url.searchParams.get('instanceId')).toBe(INSTANCE_ID);
        return response({
          name: `projects/${PROJECT_ID}/locations/${REGION}/operations/create-1`,
        });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith('/global/networks/default')) {
        return response({ selfLink: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith(`/regions/${REGION}/subnetworks/default`)) {
        return response({
          selfLink: `https://www.googleapis.com/compute/v1/${SUBNETWORK}`,
          network: `https://www.googleapis.com/compute/v1/${NETWORK}`,
        });
      }
      if (url.pathname.endsWith('/operations/create-1') && method === 'GET') {
        return response({ name: 'create-1', done: true });
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        return response(instance());
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}/authString` && method === 'GET') {
        return response({ authString: REDIS_AUTH });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(RESOURCE_NAME);
    expect(result.connectionUrl).toBe(`redis://:${REDIS_AUTH}@10.10.0.3:6379`);
    expect(result.envVars).toEqual({ REDIS_URL: result.connectionUrl });
    const create = requests.find((request) =>
      request.method === 'POST' && request.path.endsWith('/instances')
    );
    expect(create?.body).toMatchObject({
      displayName: 'Invoice Perfect Production Redis',
      tier: 'BASIC',
      memorySizeGb: 1,
      redisVersion: 'REDIS_7_2',
      authorizedNetwork: NETWORK,
      connectMode: 'DIRECT_PEERING',
      authEnabled: true,
      transitEncryptionMode: 'DISABLED',
    });
    expect(JSON.stringify(result.receipt)).not.toContain(REDIS_AUTH);
    expect(JSON.stringify(result.receipt)).not.toContain(SERVICE_ACCOUNT_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('redis://');
  });

  it('preserves the deterministic resource id when create outcome is unknown', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/instances') && method === 'GET') {
        return response({ instances: [] });
      }
      if (url.pathname.endsWith('/instances') && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith('/global/networks/default')) {
        return response({ selfLink: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith(`/regions/${REGION}/subnetworks/default`)) {
        return response({ network: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        return response({ error: 'temporarily unavailable' }, 503);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe(RESOURCE_NAME);
    expect(result.receipt.data).toMatchObject({
      instanceId: RESOURCE_NAME,
      mutationAttempted: true,
      resourceCreated: 'unknown',
    });
  });

  it('does not let a mismatched recovery response replace the deterministic create identity', async () => {
    const mismatchedName =
      `projects/${PROJECT_ID}/locations/europe-west1/instances/other-cache`;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/instances') && method === 'GET') {
        return response({ instances: [] });
      }
      if (url.pathname.endsWith('/instances') && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith('/global/networks/default')) {
        return response({ selfLink: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith(`/regions/${REGION}/subnetworks/default`)) {
        return response({ network: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        return response(instance({ name: mismatchedName }));
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceId: RESOURCE_NAME,
        mutationAttempted: true,
        resourceCreated: 'unknown',
        observationError: expect.stringContaining('returned mismatched identity'),
      },
    });
    expect(result.component).toMatchObject({
      externalId: RESOURCE_NAME,
      bindings: {
        instanceId: RESOURCE_NAME,
        providerScope: { projectId: PROJECT_ID, region: REGION },
      },
    });
    expect(result.component.externalId).not.toBe(mismatchedName);
  });

  it.each([
    ['project', `projects/other-project/locations/${REGION}/instances/${INSTANCE_ID}`],
    ['region', `projects/${PROJECT_ID}/locations/europe-west1/instances/${INSTANCE_ID}`],
    ['instance', `projects/${PROJECT_ID}/locations/${REGION}/instances/other-cache`],
    ['malformed', undefined],
  ])('rejects an exact GET whose returned %s identity does not match the request', async (
    _case,
    returnedName
  ) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/${RESOURCE_NAME}`) {
        return response(instance({ name: returnedName }));
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    await expect(
      adapter.observeCache(environment(), component())
    ).rejects.toThrow(
      `Memorystore exact GET for ${RESOURCE_NAME} returned mismatched identity`
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits for terminal absence after deletion', async () => {
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS', '4');
    let deleted = false;
    let readsAfterDelete = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        if (!deleted) return response(instance());
        readsAfterDelete += 1;
        return readsAfterDelete === 1
          ? response(instance({ state: 'DELETING' }))
          : response({ error: 'not found' }, 404);
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'DELETE') {
        deleted = true;
        return response({
          name: `projects/${PROJECT_ID}/locations/${REGION}/operations/delete-1`,
        });
      }
      if (url.pathname.endsWith('/operations/delete-1') && method === 'GET') {
        return response({ done: true });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(true);
    expect(readsAfterDelete).toBe(2);
  });

  it('observes the durable full resource name before fallback display names', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/${RESOURCE_NAME}`) {
        return response(instance({ displayName: 'Renamed outside Hypervibe' }));
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith('/global/networks/default')) {
        return response({ selfLink: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith(`/regions/${REGION}/subnetworks/default`)) {
        return response({ network: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const observed = await adapter.observeCache(environment(), component());

    expect(observed).toMatchObject({
      externalId: RESOURCE_NAME,
      name: 'Renamed outside Hypervibe',
      status: 'running',
      config: {
        region: REGION,
        network: NETWORK,
        subnetwork: SUBNETWORK,
        tier: 'BASIC',
        size: '1gb',
      },
    });
  });

  it('blocks a create when the selected existing default VPC cannot be verified', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.hostname === 'redis.googleapis.com' && url.pathname.endsWith('/instances') && method === 'GET') {
        return response({ instances: [] });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith('/global/networks/default')) {
        return response({ error: 'not found' }, 404);
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith(`/subnetworks/default`)) {
        return response({ network: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: { mutationAttempted: false, resourceCreated: false },
    });
    expect(result.receipt.error).toContain('will not create a VPC or subnet implicitly');
    expect(fetchMock.mock.calls.some(([, init]) => (init?.method ?? 'GET') === 'POST')).toBe(false);
  });

  it('updates only the exact bound instance and records its runtime Direct VPC placement', async () => {
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS', '3');
    let updated = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith('/global/networks/default')) {
        return response({ selfLink: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.hostname === 'compute.googleapis.com' && url.pathname.endsWith(`/subnetworks/default`)) {
        return response({ network: `https://www.googleapis.com/compute/v1/${NETWORK}` });
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'GET') {
        return response(instance(updated ? { tier: 'STANDARD_HA', memorySizeGb: 5 } : {}));
      }
      if (url.pathname === `/v1/${RESOURCE_NAME}` && method === 'PATCH') {
        expect(url.searchParams.get('updateMask')).toBe('tier,memorySizeGb');
        expect(JSON.parse(String(init?.body))).toEqual({ tier: 'STANDARD_HA', memorySizeGb: 5 });
        updated = true;
        return response({ name: `projects/${PROJECT_ID}/locations/${REGION}/operations/update-1` });
      }
      if (url.pathname.endsWith('/operations/update-1')) return response({ done: true });
      if (url.pathname === `/v1/${RESOURCE_NAME}/authString`) return response({ authString: REDIS_AUTH });
      throw new Error(`Unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = await connected();
    adapter.configureTarget({ region: REGION, network: 'default', subnetwork: 'default', tier: 'STANDARD_HA', size: '5gb' });

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
      component: component(),
      region: REGION,
      network: 'default',
      subnetwork: 'default',
      tier: 'STANDARD_HA',
      size: '5gb',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings.runtimeNetwork).toEqual({
      provider: 'cloudrun',
      projectId: PROJECT_ID,
      region: REGION,
      network: NETWORK,
      subnetwork: SUBNETWORK,
      egress: 'PRIVATE_RANGES_ONLY',
    });
    expect(fetchMock.mock.calls.some(([, init]) => (init?.method ?? 'GET') === 'POST')).toBe(false);
  });
});
