/**
 * Pure Pub/Sub REST request helpers used by CloudRunAdapter's queue
 * methods. Token + project in, fetch out — tests stub global fetch.
 * Topic/subscription create uses PUT and treats 409 ALREADY_EXISTS as
 * success so converge stays idempotent.
 */

const PUBSUB_API = 'https://pubsub.googleapis.com/v1';

export interface PubSubTopic {
  /** Fully-qualified: projects/<pid>/topics/<id> */
  name: string;
  labels?: Record<string, string>;
}

export interface PubSubSubscription {
  /** Fully-qualified: projects/<pid>/subscriptions/<id> */
  name: string;
  topic: string;
  ackDeadlineSeconds?: number;
  labels?: Record<string, string>;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseTopic(value: unknown, expectedName?: string): PubSubTopic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pub/Sub returned an invalid topic response.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name) {
    throw new Error('Pub/Sub returned a topic without an identity.');
  }
  if (expectedName && record.name !== expectedName) {
    throw new Error(`Pub/Sub exact topic lookup for ${expectedName} returned ${record.name}.`);
  }
  const labels = record.labels === undefined ? undefined : stringRecord(record.labels);
  if (record.labels !== undefined && !labels) {
    throw new Error(`Pub/Sub topic ${record.name} returned invalid labels.`);
  }
  return { name: record.name, ...(labels ? { labels } : {}) };
}

function parseSubscription(value: unknown, expectedName: string): PubSubSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pub/Sub returned an invalid subscription response.');
  }
  const record = value as Record<string, unknown>;
  if (record.name !== expectedName) {
    throw new Error(
      `Pub/Sub exact subscription lookup for ${expectedName} returned ${typeof record.name === 'string' ? record.name : 'a subscription without an identity'}.`
    );
  }
  if (typeof record.topic !== 'string' || !record.topic) {
    throw new Error(`Pub/Sub subscription ${expectedName} returned no topic identity.`);
  }
  const labels = record.labels === undefined ? undefined : stringRecord(record.labels);
  if (record.labels !== undefined && !labels) {
    throw new Error(`Pub/Sub subscription ${expectedName} returned invalid labels.`);
  }
  if (record.ackDeadlineSeconds !== undefined && typeof record.ackDeadlineSeconds !== 'number') {
    throw new Error(`Pub/Sub subscription ${expectedName} returned an invalid acknowledgement deadline.`);
  }
  return {
    name: record.name,
    topic: record.topic,
    ...(record.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: record.ackDeadlineSeconds } : {}),
    ...(labels ? { labels } : {}),
  };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function fail(operation: string, response: Response): Promise<never> {
  const text = await response.text();
  throw new Error(`Pub/Sub ${operation} failed: ${response.status} ${text}`);
}

export async function listTopics(token: string, gcpProjectId: string): Promise<PubSubTopic[]> {
  const topics: PubSubTopic[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/topics?${params}`, {
      headers: headers(token),
    });
    if (!response.ok) return fail('listTopics', response);
    const body = await response.json() as { topics?: unknown; nextPageToken?: unknown };
    if (body.topics !== undefined && !Array.isArray(body.topics)) {
      throw new Error('Pub/Sub topic inventory returned an invalid topic list.');
    }
    topics.push(...(body.topics ?? []).map((topic) => parseTopic(topic)));
    if (body.nextPageToken !== undefined && (typeof body.nextPageToken !== 'string' || !body.nextPageToken)) {
      throw new Error('Pub/Sub topic inventory returned an invalid continuation token.');
    }
    pageToken = body.nextPageToken as string | undefined;
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error(`Pub/Sub topic inventory repeated continuation token ${pageToken}.`);
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);
  return topics;
}

export async function getTopic(
  token: string,
  gcpProjectId: string,
  topicId: string
): Promise<PubSubTopic | null> {
  const expectedName = `projects/${gcpProjectId}/topics/${topicId}`;
  const response = await fetch(`${PUBSUB_API}/${expectedName}`, {
    headers: headers(token),
  });
  if (response.status === 404) return null;
  if (!response.ok) return fail('getTopic', response);
  return parseTopic(await response.json(), expectedName);
}

export async function ensureTopic(
  token: string,
  gcpProjectId: string,
  topicId: string,
  labels: Record<string, string>
): Promise<{ created: boolean }> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/topics/${topicId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ labels }),
  });
  if (response.ok) return { created: true };
  if (response.status === 409) return { created: false };
  return fail('ensureTopic', response);
}

export async function getSubscription(
  token: string,
  gcpProjectId: string,
  subscriptionId: string
): Promise<PubSubSubscription | null> {
  const expectedName = `projects/${gcpProjectId}/subscriptions/${subscriptionId}`;
  const response = await fetch(`${PUBSUB_API}/${expectedName}`, {
    headers: headers(token),
  });
  if (response.status === 404) return null;
  if (!response.ok) return fail('getSubscription', response);
  return parseSubscription(await response.json(), expectedName);
}

export async function ensureSubscription(
  token: string,
  gcpProjectId: string,
  subscriptionId: string,
  topicId: string,
  options: { ackDeadlineSeconds?: number; labels?: Record<string, string> }
): Promise<{ created: boolean }> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({
      topic: `projects/${gcpProjectId}/topics/${topicId}`,
      ...(options.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: options.ackDeadlineSeconds } : {}),
      ...(options.labels ? { labels: options.labels } : {}),
    }),
  });
  if (response.ok) return { created: true };
  if (response.status === 409) return { created: false };
  return fail('ensureSubscription', response);
}

export async function patchSubscriptionAckDeadline(
  token: string,
  gcpProjectId: string,
  subscriptionId: string,
  ackDeadlineSeconds: number
): Promise<void> {
  const response = await fetch(
    `${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}?updateMask=ackDeadlineSeconds`,
    {
      method: 'PATCH',
      headers: headers(token),
      body: JSON.stringify({ subscription: { ackDeadlineSeconds } }),
    }
  );
  if (!response.ok) return fail('patchSubscription', response);
}

export async function deleteTopic(token: string, gcpProjectId: string, topicId: string): Promise<void> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/topics/${topicId}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!response.ok && response.status !== 404) return fail('deleteTopic', response);
}

export async function deleteSubscription(token: string, gcpProjectId: string, subscriptionId: string): Promise<void> {
  const response = await fetch(`${PUBSUB_API}/projects/${gcpProjectId}/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!response.ok && response.status !== 404) return fail('deleteSubscription', response);
}
