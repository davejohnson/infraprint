import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

const PROJECT = 'gcp-project';
const TOKEN = 'token';

const environment: Environment = {
  id: 'env-1',
  projectId: 'project-1',
  name: 'production',
  platformBindings: {
    provider: 'cloudrun',
    projectId: PROJECT,
    queues: {
      'email-jobs': {
        backend: 'pubsub',
        topicName: 'projects/gcp-project/topics/gcp-project-email-jobs',
        subscriptionName: 'projects/gcp-project/subscriptions/gcp-project-email-jobs-sub',
        providerScope: { projectId: PROJECT },
      },
    },
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

async function connectedAdapter(): Promise<CloudRunAdapter> {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: PROJECT, credentials: '{}' });
  vi.spyOn(
    adapter as unknown as { getAccessToken(): Promise<string> },
    'getAccessToken'
  ).mockResolvedValue(TOKEN);
  return adapter;
}

function queueResources(adapter: CloudRunAdapter) {
  const ids = adapter.queueResourceNames(environment, 'email-jobs');
  return {
    ...ids,
    topicName: `projects/${PROJECT}/topics/${ids.topicId}`,
    subscriptionName: `projects/${PROJECT}/subscriptions/${ids.subscriptionId}`,
    labels: {
      'infraprint-environment': 'production',
      'infraprint-queue': 'email-jobs',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CloudRunAdapter Pub/Sub queue identity safety', () => {
  it.each([
    ['subscription observation', (adapter: CloudRunAdapter, target: Environment) => adapter.getQueueSubscription(target, 'email-jobs')],
    ['ensure', (adapter: CloudRunAdapter, target: Environment) => adapter.ensureQueue(target, 'email-jobs')],
    ['destroy', (adapter: CloudRunAdapter, target: Environment) => adapter.destroyQueue(target, 'email-jobs')],
  ])('blocks %s before provider access when the queue binding is scoped to another project', async (_label, invoke) => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wrongProjectEnvironment: Environment = {
      ...environment,
      platformBindings: {
        ...environment.platformBindings,
        queues: {
          'email-jobs': {
            backend: 'pubsub',
            topicName: 'projects/other-project/topics/gcp-project-email-jobs',
            subscriptionName: 'projects/other-project/subscriptions/gcp-project-email-jobs-sub',
            providerScope: { projectId: 'other-project' },
          },
        },
      },
    };

    await expect(invoke(adapter, wrongProjectEnvironment)).rejects.toThrow(/different project/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((adapter as unknown as { getAccessToken: ReturnType<typeof vi.fn> }).getAccessToken)
      .not.toHaveBeenCalled();
  });

  it('uses connected provider scope when the environment project id is only a logical namespace', async () => {
    const adapter = await connectedAdapter();
    const logicalEnvironment: Environment = {
      ...environment,
      platformBindings: { provider: 'cloudrun', projectId: 'logical-production' },
    };
    const ids = adapter.queueResourceNames(logicalEnvironment, 'email-jobs');
    const topicName = `projects/${PROJECT}/topics/${ids.topicId}`;
    const subscriptionName = `projects/${PROJECT}/subscriptions/${ids.subscriptionId}`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/topics/${ids.topicId}`)) {
        return Response.json({
          name: topicName,
          labels: { 'infraprint-environment': 'production', 'infraprint-queue': 'email-jobs' },
        });
      }
      if (url.endsWith(`/subscriptions/${ids.subscriptionId}`)) {
        return Response.json({
          name: subscriptionName,
          topic: topicName,
          labels: { 'infraprint-environment': 'production', 'infraprint-queue': 'email-jobs' },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await expect(adapter.getQueueSubscription(logicalEnvironment, 'email-jobs'))
      .resolves.toMatchObject({ name: subscriptionName, topic: topicName });
    expect(adapter.queueProviderScope()).toEqual({ projectId: PROJECT });
  });

  it('refuses to adopt an unmanaged topic after a create race returns 409', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    let topicReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/topics/${resource.topicId}`) && (init?.method ?? 'GET') === 'GET') {
        topicReads += 1;
        return topicReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({ name: resource.topicName, labels: { owner: 'someone-else' } });
      }
      if (url.endsWith(`/topics/${resource.topicId}`) && init?.method === 'PUT') {
        return new Response('already exists', { status: 409 });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.ensureQueue(environment, 'email-jobs')).rejects.toThrow(/not owned by Hypervibe/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/subscriptions/'))).toBe(false);
  });

  it('treats a subscription attached to another topic as unknown, not in sync', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/topics/${resource.topicId}`)) {
        return Response.json({ name: resource.topicName, labels: resource.labels });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`)) {
        return Response.json({
          name: resource.subscriptionName,
          topic: `projects/${PROJECT}/topics/unmanaged`,
          labels: resource.labels,
          ackDeadlineSeconds: 120,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await expect(adapter.getQueueSubscription(environment, 'email-jobs'))
      .rejects.toThrow(/does not match exact queue subscription/);
  });

  it('validates all destroy targets before issuing the first delete', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith(`/topics/${resource.topicId}`)) {
        return Response.json({ name: resource.topicName, labels: { owner: 'someone-else' } });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`)) {
        return new Response('missing', { status: 404 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.destroyQueue(environment, 'email-jobs')).rejects.toThrow(/not owned by Hypervibe/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('does not report destroy success while an acknowledged topic remains observable', async () => {
    vi.stubEnv('HYPERVIBE_PUBSUB_DELETE_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_PUBSUB_POLL_INTERVAL_MS', '0');
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`)) {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith(`/topics/${resource.topicId}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith(`/topics/${resource.topicId}`)) {
        return Response.json({ name: resource.topicName, labels: resource.labels });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.destroyQueue(environment, 'email-jobs'))
      .rejects.toThrow(/remained observable after its delete acknowledgement/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });

  it('re-observes exact owned resources before reporting create convergence', async () => {
    const adapter = await connectedAdapter();
    const resource = queueResources(adapter);
    let topicReads = 0;
    let subscriptionReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/topics/${resource.topicId}`) && (init?.method ?? 'GET') === 'GET') {
        topicReads += 1;
        return topicReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({ name: resource.topicName, labels: resource.labels });
      }
      if (url.endsWith(`/topics/${resource.topicId}`) && init?.method === 'PUT') {
        return Response.json({ name: resource.topicName });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`) && (init?.method ?? 'GET') === 'GET') {
        subscriptionReads += 1;
        return subscriptionReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({
              name: resource.subscriptionName,
              topic: resource.topicName,
              labels: resource.labels,
              ackDeadlineSeconds: 120,
            });
      }
      if (url.endsWith(`/subscriptions/${resource.subscriptionId}`) && init?.method === 'PUT') {
        return Response.json({ name: resource.subscriptionName });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.ensureQueue(environment, 'email-jobs', { ackDeadlineSeconds: 120 }))
      .resolves.toMatchObject({ createdTopic: true, createdSubscription: true });
    expect(topicReads).toBe(2);
    expect(subscriptionReads).toBe(2);
  });
});
