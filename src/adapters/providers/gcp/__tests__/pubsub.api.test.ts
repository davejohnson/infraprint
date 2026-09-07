import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSubscription,
  deleteTopic,
  ensureSubscription,
  ensureTopic,
  getTopic,
  getSubscription,
  listTopics,
  patchSubscriptionAckDeadline,
} from '../pubsub.api.js';

const TOKEN = 'token';
const PROJECT = 'gcp-project';

describe('pubsub.api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('listTopics follows nextPageToken across pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        topics: [{ name: `projects/${PROJECT}/topics/a` }],
        nextPageToken: 'page-2',
      }))
      .mockResolvedValueOnce(Response.json({
        topics: [{ name: `projects/${PROJECT}/topics/b` }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const topics = await listTopics(TOKEN, PROJECT);
    expect(topics.map((topic) => topic.name)).toEqual([
      `projects/${PROJECT}/topics/a`,
      `projects/${PROJECT}/topics/b`,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('pageToken');
    expect(String(fetchMock.mock.calls[1][0])).toContain('pageToken=page-2');
  });

  it('fails closed on malformed topic pages and repeated continuation tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ topics: {} })));
    await expect(listTopics(TOKEN, PROJECT)).rejects.toThrow(/invalid topic list/);

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      topics: [],
      nextPageToken: 'same-page',
    })));
    await expect(listTopics(TOKEN, PROJECT)).rejects.toThrow(/repeated continuation token/);
  });

  it('getTopic returns null only on 404 and validates the exact returned identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(getTopic(TOKEN, PROJECT, 'topic-1')).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      name: `projects/${PROJECT}/topics/different`,
    })));
    await expect(getTopic(TOKEN, PROJECT, 'topic-1')).rejects.toThrow(/exact topic lookup/);
  });

  it('ensureTopic PUTs labels and reports created on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ name: 'topic' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureTopic(TOKEN, PROJECT, 'my-topic', { env: 'prod' });
    expect(result).toEqual({ created: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://pubsub.googleapis.com/v1/projects/${PROJECT}/topics/my-topic`);
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ labels: { env: 'prod' } });
  });

  it('ensureTopic treats 409 ALREADY_EXISTS as created:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('already exists', { status: 409 })));
    await expect(ensureTopic(TOKEN, PROJECT, 'my-topic', {})).resolves.toEqual({ created: false });
  });

  it('ensureTopic throws with status and body on other errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(ensureTopic(TOKEN, PROJECT, 'my-topic', {}))
      .rejects.toThrow('Pub/Sub ensureTopic failed: 500 boom');
  });

  it('getSubscription returns null on 404 and the body otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    await expect(getSubscription(TOKEN, PROJECT, 'sub-1')).resolves.toBeNull();

    const subscription = {
      name: `projects/${PROJECT}/subscriptions/sub-1`,
      topic: `projects/${PROJECT}/topics/t`,
      ackDeadlineSeconds: 42,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(subscription)));
    await expect(getSubscription(TOKEN, PROJECT, 'sub-1')).resolves.toEqual(subscription);
  });

  it('getSubscription rejects a mismatched successful identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      name: `projects/${PROJECT}/subscriptions/different`,
      topic: `projects/${PROJECT}/topics/t`,
    })));
    await expect(getSubscription(TOKEN, PROJECT, 'sub-1')).rejects.toThrow(/exact subscription lookup/);
  });

  it('ensureSubscription sends the fully-qualified topic path and ackDeadlineSeconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    await ensureSubscription(TOKEN, PROJECT, 'sub-1', 'topic-1', { ackDeadlineSeconds: 120 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://pubsub.googleapis.com/v1/projects/${PROJECT}/subscriptions/sub-1`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      topic: `projects/${PROJECT}/topics/topic-1`,
      ackDeadlineSeconds: 120,
    });
  });

  it('patchSubscriptionAckDeadline PATCHes with updateMask=ackDeadlineSeconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    await patchSubscriptionAckDeadline(TOKEN, PROJECT, 'sub-1', 300);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('updateMask=ackDeadlineSeconds');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ subscription: { ackDeadlineSeconds: 300 } });
  });

  it('deleteTopic and deleteSubscription tolerate 404 and throw otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    await expect(deleteTopic(TOKEN, PROJECT, 't')).resolves.toBeUndefined();
    await expect(deleteSubscription(TOKEN, PROJECT, 's')).resolves.toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    await expect(deleteTopic(TOKEN, PROJECT, 't')).rejects.toThrow('Pub/Sub deleteTopic failed: 403 denied');
    await expect(deleteSubscription(TOKEN, PROJECT, 's')).rejects.toThrow('Pub/Sub deleteSubscription failed: 403 denied');
  });
});
