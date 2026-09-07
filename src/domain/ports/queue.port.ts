import type { Environment } from '../entities/environment.entity.js';

/** Durable, non-secret provider scope for one queue backend. */
export type QueueProviderScope = Record<string, string>;

export interface ManagedQueueTopic {
  /** Provider-native, fully scoped topic identity. */
  name: string;
  labels?: Record<string, string>;
}

export interface ManagedQueueSubscription {
  /** Provider-native, fully scoped subscription identity. */
  name: string;
  /** Provider-native, fully scoped topic identity. */
  topic: string;
  ackDeadlineSeconds?: number;
  labels?: Record<string, string>;
}

export interface QueueResourceNames {
  topicId: string;
  subscriptionId: string;
}

export interface QueueEnsureResult {
  topicName: string;
  subscriptionName: string;
  createdTopic: boolean;
  createdSubscription: boolean;
}

/**
 * Provider-neutral lifecycle boundary for externally managed message queues.
 *
 * A hosting adapter may also implement this port, but queue planning must not
 * import or branch on that concrete hosting implementation.
 */
export interface IQueueAdapter {
  queueResourceNames(environment: Environment, queueName: string): QueueResourceNames;
  queueProviderScope(): QueueProviderScope;
  getQueueSubscription(
    environment: Environment,
    queueName: string
  ): Promise<ManagedQueueSubscription | null>;
  ensureQueue(
    environment: Environment,
    queueName: string,
    options?: { ackDeadlineSeconds?: number }
  ): Promise<QueueEnsureResult>;
  destroyQueue(environment: Environment, queueName: string): Promise<void>;
}

export function supportsManagedQueues(adapter: unknown): adapter is IQueueAdapter {
  if (!adapter || typeof adapter !== 'object') return false;
  const candidate = adapter as Partial<IQueueAdapter>;
  return typeof candidate.queueResourceNames === 'function'
    && typeof candidate.queueProviderScope === 'function'
    && typeof candidate.getQueueSubscription === 'function'
    && typeof candidate.ensureQueue === 'function'
    && typeof candidate.destroyQueue === 'function';
}
