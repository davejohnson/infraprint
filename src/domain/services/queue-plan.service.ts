import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { adapterFactory } from './adapter.factory.js';
import { isCloudPreparedForQueues } from './cloud-prepare.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec, QueueSpec } from '../spec/spec.schema.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import { supportsManagedQueues, type IQueueAdapter } from '../ports/queue.port.js';
import type { PlanAction, PlanFieldDiff } from '../plan/plan.types.js';

/**
 * Planner + apply handlers for the `queues` spec section, following the
 * two-function contract of appstore-plan.service.ts. The backend follows
 * the hosting provider: Cloud Run environments converge real Pub/Sub
 * topics + subscriptions (observed, verified); Railway environments are
 * postgres-backed (pg-boss model) — hypervibe wires env vars and records
 * bindings, apps own the tables, so nothing is provisioned or destroyed.
 */

export const QUEUE_OPERATIONS = {
  ensure: 'queueEnsure',
  destroy: 'queueDestroy',
} as const;

const QUEUE_OPERATION_SET = new Set<string>(Object.values(QUEUE_OPERATIONS));

const envRepo = new EnvironmentRepository();

export interface QueueBinding {
  backend: 'pubsub' | 'postgres';
  topicName?: string;
  subscriptionName?: string;
  providerScope?: Record<string, string>;
  updatedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseQueueBindings(environment: Environment | null): Record<string, QueueBinding> {
  const queues = asRecord(environment?.platformBindings?.queues);
  return (queues ?? {}) as Record<string, QueueBinding>;
}

function persistQueueBindings(
  environmentId: string,
  patch: (current: Record<string, QueueBinding>) => Record<string, QueueBinding>
): void {
  const environment = envRepo.findById(environmentId);
  if (!environment) return;
  const next = patch(parseQueueBindings(environment));
  envRepo.updatePlatformBindings(environmentId, {
    queues: next as unknown as Record<string, unknown>,
  });
}

type QueueCapableAdapter = IProviderAdapter & IQueueAdapter;

function exactStringRecord(left: unknown, right: unknown): boolean {
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  if (
    Object.values(leftRecord).some((value) => typeof value !== 'string' || !value)
    || Object.values(rightRecord).some((value) => typeof value !== 'string' || !value)
  ) return false;
  return JSON.stringify(Object.entries(leftRecord).sort()) === JSON.stringify(Object.entries(rightRecord).sort());
}

function pubsubResourceProjectId(value: string, collection: 'topics' | 'subscriptions'): string | undefined {
  const parts = value.split('/');
  return parts.length === 4
    && parts[0] === 'projects'
    && Boolean(parts[1])
    && parts[2] === collection
    && Boolean(parts[3])
    ? parts[1]
    : undefined;
}

function queueBackend(adapter: IProviderAdapter): 'pubsub' | 'postgres' | undefined {
  return adapter.capabilities.queues?.backend;
}

function queueAction(params: {
  id: string;
  type: PlanAction['type'];
  name: string;
  provider: string;
  operation: string;
  reason: string;
  verified: boolean;
  diff?: PlanFieldDiff[];
  dataBearing?: boolean;
  requiresConfirm?: boolean;
  metadata?: Record<string, unknown>;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'queue', name: params.name, provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.diff && params.diff.length > 0 ? { diff: params.diff } : {}),
    ...(params.dataBearing ? { dataBearing: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    metadata: { operation: params.operation, ...(params.metadata ?? {}) },
  };
}

function unconvergeableQueueActions(params: {
  declared: Record<string, QueueSpec>;
  bindings: Record<string, QueueBinding>;
  provider: string;
  reason: string;
}): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const name of Object.keys(params.declared)) {
    actions.push(queueAction({
      id: `queue:${name}`,
      type: 'update',
      name,
      provider: params.provider,
      operation: QUEUE_OPERATIONS.ensure,
      reason: `${params.reason}; queue "${name}" cannot be converged`,
      verified: false,
      metadata: { queueName: name, unsupported: true, blockedReason: 'queue_observation_unavailable' },
    }));
  }
  for (const [name, binding] of Object.entries(params.bindings)) {
    if (params.declared[name]) continue;
    actions.push(queueAction({
      id: `queue:${name}:destroy`,
      type: 'update',
      name,
      provider: params.provider,
      operation: QUEUE_OPERATIONS.destroy,
      reason: `${params.reason}; queue binding "${name}" cannot be reconciled`,
      verified: false,
      metadata: { queueName: name, backend: binding.backend, unsupported: true, blockedReason: 'queue_observation_unavailable' },
    }));
  }
  return actions;
}

export async function planQueues(params: {
  project: Project;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
}): Promise<{ actions: PlanAction[]; warnings: string[] }> {
  const declared = params.environmentSpec.queues ?? {};
  const declaredNames = Object.keys(declared);
  const bindings = parseQueueBindings(params.environment);
  const boundNames = Object.keys(bindings);
  if (declaredNames.length === 0 && boundNames.length === 0) {
    return { actions: [], warnings: [] };
  }

  const provider = params.environmentSpec.hosting.provider;
  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    const reason = `Cannot plan queues: ${adapterResult.error ?? `no ${provider} adapter`}`;
    return {
      actions: unconvergeableQueueActions({ declared, bindings, provider, reason }),
      warnings: [reason],
    };
  }
  const adapter = adapterResult.adapter as IProviderAdapter;
  const backend = queueBackend(adapter);
  if (!backend) {
    const reason = `Hosting provider ${provider} does not support queues`;
    return {
      actions: unconvergeableQueueActions({ declared, bindings, provider, reason }),
      warnings: [`${reason}.`],
    };
  }

  const warnings: string[] = [];
  const hasWorker = Object.values(params.environmentSpec.services)
    .some((service) => service.workloadKind === 'worker');
  if (declaredNames.length > 0 && !hasWorker) {
    warnings.push('queues are declared but no service has workloadKind "worker"; nothing will consume them unless a web service does.');
  }

  if (backend === 'postgres') {
    return { actions: planPostgresQueues(declared, bindings, provider), warnings };
  }

  // Pub/Sub backend.
  if (!isCloudPreparedForQueues(params.project, provider)) {
    warnings.push(
      'Pub/Sub queues need cloud preparation: preview hv_connections provider="cloudrun" action="prepare" queueAccess="lifecycle", then explicitly confirm that same preparation (adds pubsub.googleapis.com and roles/pubsub.editor). Queue actions will fail until then.'
    );
  }

  if (!supportsManagedQueues(adapter)) {
    const reason = `Hosting provider ${provider} advertises a managed queue backend without implementing the queue lifecycle port`;
    return {
      actions: unconvergeableQueueActions({ declared, bindings, provider, reason }),
      warnings: [...warnings, `${reason}.`],
    };
  }
  const queueAdapter: QueueCapableAdapter = adapter;
  const actions: PlanAction[] = [];
  let currentProviderScope: Record<string, string>;
  try {
    currentProviderScope = queueAdapter.queueProviderScope();
    if (!currentProviderScope.projectId) throw new Error('connected Pub/Sub project id is missing');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Cannot resolve the current Pub/Sub provider scope: ${message}`;
    return {
      actions: unconvergeableQueueActions({ declared, bindings, provider, reason }),
      warnings: [...warnings, reason],
    };
  }

  if (!params.environment) {
    // No local environment yet: plan the full desired set unverified.
    for (const [name, spec] of Object.entries(declared)) {
      actions.push(pubsubEnsureAction(name, spec, provider, {
        verified: false,
        reason: `Queue "${name}" is not provisioned`,
        providerScope: currentProviderScope,
      }));
    }
    return { actions, warnings };
  }

  try {
    for (const [name, spec] of Object.entries(declared)) {
      const subscription = await queueAdapter.getQueueSubscription(params.environment, name);
      const binding = bindings[name];
      if (!subscription) {
        if (binding) {
          actions.push(queueAction({
            id: `queue:${name}`,
            type: 'update',
            name,
            provider,
            operation: QUEUE_OPERATIONS.ensure,
            verified: true,
            reason: `Queue "${name}" has a durable ${binding.backend} binding, but its bound Pub/Sub identity is absent; Hypervibe will not create a replacement`,
            metadata: {
              queueName: name,
              blockedReason: 'queue_binding_identity_missing',
              backend: binding.backend,
              topicName: binding.topicName,
              subscriptionName: binding.subscriptionName,
              providerScope: binding.providerScope,
            },
          }));
          warnings.push(`Queue "${name}" has a local binding whose Pub/Sub resource is absent. Restore or explicitly reconcile that binding before re-planning.`);
        } else {
          actions.push(pubsubEnsureAction(name, spec, provider, {
            verified: true,
            reason: `Pub/Sub topic/subscription for "${name}" does not exist`,
            providerScope: currentProviderScope,
          }));
        }
        continue;
      }

      const currentProjectId = currentProviderScope.projectId;
      const { topicId, subscriptionId } = queueAdapter.queueResourceNames(params.environment, name);
      const expectedTopicName = currentProjectId
        ? `projects/${currentProjectId}/topics/${topicId}`
        : undefined;
      const expectedSubscriptionName = currentProjectId
        ? `projects/${currentProjectId}/subscriptions/${subscriptionId}`
        : undefined;
      const identityMatches = binding?.backend === 'pubsub'
        && exactStringRecord(binding.providerScope, currentProviderScope)
        && binding.topicName === expectedTopicName
        && binding.subscriptionName === expectedSubscriptionName
        && subscription.topic === expectedTopicName
        && subscription.name === expectedSubscriptionName;
      if (!identityMatches) {
        const blockedReason = binding
          ? 'queue_binding_identity_mismatch'
          : 'queue_binding_missing';
        actions.push(queueAction({
          id: `queue:${name}`,
          type: 'update',
          name,
          provider,
          operation: QUEUE_OPERATIONS.ensure,
          verified: true,
          reason: binding
            ? `Queue "${name}" no longer matches its durable Pub/Sub binding; Hypervibe will not retarget it`
            : `Pub/Sub resources for "${name}" exist without a local binding; explicit reconciliation is required`,
          metadata: {
            queueName: name,
            backend: 'pubsub',
            blockedReason,
            topicName: subscription.topic,
            subscriptionName: subscription.name,
            providerScope: currentProviderScope,
          },
        }));
        warnings.push(binding
          ? `Queue "${name}" does not match its persisted Pub/Sub topic, subscription, and project scope. Reconcile the binding before re-planning.`
          : `Queue "${name}" already exists without a local binding. Explicitly reconcile it before re-planning; Hypervibe will not silently adopt it.`);
        continue;
      }
      const diff: PlanFieldDiff[] = [];
      if (spec.ackDeadlineSeconds !== undefined && subscription.ackDeadlineSeconds !== spec.ackDeadlineSeconds) {
        diff.push({
          field: 'ackDeadlineSeconds',
          from: String(subscription.ackDeadlineSeconds ?? 'default'),
          to: String(spec.ackDeadlineSeconds),
        });
      }
      actions.push(queueAction({
        id: `queue:${name}`,
        type: diff.length > 0 ? 'update' : 'noop',
        name,
        provider,
        operation: QUEUE_OPERATIONS.ensure,
        reason: diff.length > 0
          ? `Queue "${name}" config drifted (${diff.map((entry) => entry.field).join(', ')})`
          : `Queue "${name}" is in sync`,
        verified: true,
        diff,
        metadata: {
          queueName: name,
          backend: 'pubsub',
          providerScope: currentProviderScope,
          ...(spec.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: spec.ackDeadlineSeconds } : {}),
        },
      }));
    }

    // Bindings for queues no longer in the spec: destroy (undelivered
    // messages are data) — confirm-gated like database destroys.
    for (const name of boundNames) {
      if (declared[name] || bindings[name].backend !== 'pubsub') continue;
      const binding = bindings[name];
      const { topicId, subscriptionId } = queueAdapter.queueResourceNames(params.environment, name);
      const expectedTopicName = `projects/${currentProviderScope.projectId}/topics/${topicId}`;
      const expectedSubscriptionName = `projects/${currentProviderScope.projectId}/subscriptions/${subscriptionId}`;
      if (
        !exactStringRecord(binding.providerScope, currentProviderScope)
        || binding.topicName !== expectedTopicName
        || binding.subscriptionName !== expectedSubscriptionName
      ) {
        actions.push(queueAction({
          id: `queue:${name}:destroy`,
          type: 'update',
          name,
          provider,
          operation: QUEUE_OPERATIONS.destroy,
          reason: `Queue "${name}" binding does not match the connected Pub/Sub project and exact deterministic identity; destruction is blocked`,
          verified: false,
          metadata: {
            queueName: name,
            backend: 'pubsub',
            blockedReason: 'queue_binding_identity_mismatch',
            topicName: binding.topicName,
            subscriptionName: binding.subscriptionName,
            providerScope: binding.providerScope,
          },
        }));
        warnings.push(`Queue "${name}" cannot be destroyed because its durable Pub/Sub identity or project scope does not match the current connection.`);
        continue;
      }
      actions.push(queueAction({
        id: `queue:${name}:destroy`,
        type: 'destroy',
        name,
        provider,
        operation: QUEUE_OPERATIONS.destroy,
        reason: `Queue "${name}" was removed from the spec; undelivered messages will be lost`,
        verified: true,
        dataBearing: true,
        requiresConfirm: true,
        metadata: {
          queueName: name,
          backend: 'pubsub',
          topicName: bindings[name].topicName,
          subscriptionName: bindings[name].subscriptionName,
          providerScope: bindings[name].providerScope,
        },
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not observe Pub/Sub for queues: ${message}. Queue actions are unverified.`);
    return {
      actions: unconvergeableQueueActions({
        declared,
        bindings,
        provider,
        reason: `Queue state could not be observed: ${message}`,
      }),
      warnings,
    };
  }

  return { actions, warnings };
}

function pubsubEnsureAction(
  name: string,
  spec: QueueSpec,
  provider: string,
  options: { verified: boolean; reason: string; providerScope: Record<string, string> }
): PlanAction {
  return queueAction({
    id: `queue:${name}`,
    type: 'create',
    name,
    provider,
    operation: QUEUE_OPERATIONS.ensure,
    reason: options.reason,
    verified: options.verified,
    metadata: {
      queueName: name,
      backend: 'pubsub',
      providerScope: options.providerScope,
      ...(spec.ackDeadlineSeconds !== undefined ? { ackDeadlineSeconds: spec.ackDeadlineSeconds } : {}),
    },
  });
}

function planPostgresQueues(
  declared: Record<string, QueueSpec>,
  bindings: Record<string, QueueBinding>,
  provider: string
): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const name of Object.keys(declared)) {
    const bound = bindings[name]?.backend === 'postgres';
    actions.push(queueAction({
      id: `queue:${name}`,
      type: bound ? 'noop' : 'create',
      name,
      provider,
      operation: QUEUE_OPERATIONS.ensure,
      reason: bound
        ? `Queue "${name}" is wired (postgres-backed)`
        : `Queue "${name}" is postgres-backed: hypervibe wires env vars only; tables are app-managed (pg-boss/graphile-worker ride DATABASE_URL)`,
      verified: false,
      metadata: { queueName: name, backend: 'postgres' },
    }));
  }
  for (const [name, binding] of Object.entries(bindings)) {
    if (declared[name] || binding.backend !== 'postgres') continue;
    actions.push(queueAction({
      id: `queue:${name}:destroy`,
      type: 'destroy',
      name,
      provider,
      operation: QUEUE_OPERATIONS.destroy,
      reason: `Queue "${name}" was removed from the spec; clearing the binding (postgres tables are app-managed and untouched)`,
      verified: false,
      metadata: { queueName: name, backend: 'postgres' },
    }));
  }
  return actions;
}

export function isQueueAction(action: PlanAction): boolean {
  const operation = action.metadata?.operation;
  return typeof operation === 'string' && QUEUE_OPERATION_SET.has(operation);
}

export async function applyQueueAction(params: {
  project: Project;
  envName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const queueName = typeof params.action.metadata?.queueName === 'string'
    ? params.action.metadata.queueName
    : '';
  const operation = String(params.action.metadata?.operation ?? '');
  const provider = params.environmentSpec.hosting.provider;
  if (
    !queueName
    || queueName !== params.action.resource.name
    || params.action.resource.provider !== provider
    || (
      operation === QUEUE_OPERATIONS.ensure
        ? !params.environmentSpec.queues?.[queueName]
        : operation === QUEUE_OPERATIONS.destroy
          ? Boolean(params.environmentSpec.queues?.[queueName])
          : true
    )
  ) {
    return {
      success: false,
      message: `Queue action "${params.action.id}" has stale mutation authority`,
      error: `The reviewed queue name, operation, or provider does not match environment "${params.envName}". Re-run hv_plan.`,
    };
  }
  if (typeof params.action.metadata?.blockedReason === 'string') {
    return {
      success: false,
      message: `Queue action "${params.action.id}" is blocked`,
      error: `${params.action.reason}. Resolve the queue identity or observation problem, then re-run hv_plan.`,
    };
  }
  const environment = envRepo.findByProjectAndName(params.project.id, params.envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${params.envName}"` };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Hosting adapter unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as IProviderAdapter;
  if (adapter.name !== params.action.resource.provider) {
    return {
      success: false,
      message: `Queue action "${params.action.id}" resolved the wrong provider adapter`,
      error: `Plan targets ${params.action.resource.provider}, but the resolved adapter is ${adapter.name}.`,
    };
  }
  const backend = queueBackend(adapter);
  if (!backend) {
    return { success: false, message: `${provider} does not support queues`, error: `Hosting provider ${provider} has no queue backend.` };
  }
  if (params.action.metadata?.backend !== backend) {
    return {
      success: false,
      message: `Queue action "${params.action.id}" has stale mutation authority`,
      error: `The reviewed queue backend does not match the current ${backend} backend. Re-run hv_plan.`,
    };
  }

  if (backend === 'postgres') {
    if (operation === QUEUE_OPERATIONS.destroy) {
      const binding = parseQueueBindings(environment)[queueName];
      if (params.action.metadata?.backend !== 'postgres' || binding?.backend !== 'postgres') {
        return {
          success: false,
          message: `Queue action "${params.action.id}" has stale mutation authority`,
          error: `The reviewed postgres queue binding no longer matches "${queueName}". Re-run hv_plan.`,
        };
      }
      persistQueueBindings(environment.id, (current) => {
        const next = { ...current };
        delete next[queueName];
        return next;
      });
      return { success: true, message: `Cleared queue binding "${queueName}" (postgres tables untouched)` };
    }
    persistQueueBindings(environment.id, (current) => ({
      ...current,
      [queueName]: { backend: 'postgres', updatedAt: new Date().toISOString() },
    }));
    return { success: true, message: `Queue "${queueName}" wired (postgres-backed via DATABASE_URL)` };
  }

  // Pub/Sub backend.
  if (!isCloudPreparedForQueues(params.project, provider)) {
    return {
      success: false,
      message: 'Pub/Sub is not prepared for queues',
      error: 'Re-run hv_connections provider="cloudrun" action="prepare" confirm=true (adds pubsub.googleapis.com and roles/pubsub.editor), then re-run hv_plan and hv_apply.',
    };
  }
  if (!supportsManagedQueues(adapter)) {
    return {
      success: false,
      message: `${provider} queue adapter is incomplete`,
      error: `Hosting provider ${provider} advertises a managed queue backend without implementing the queue lifecycle port.`,
    };
  }
  const queueAdapter: QueueCapableAdapter = adapter;

  try {
    const currentProviderScope = queueAdapter.queueProviderScope();
    const plannedScope = asRecord(params.action.metadata?.providerScope);
    if (!exactStringRecord(plannedScope, currentProviderScope)) {
      return {
        success: false,
        message: `Queue action "${params.action.id}" has stale mutation authority`,
        error: `The connected Pub/Sub project scope changed after planning. Re-run hv_plan.`,
      };
    }
    if (operation === QUEUE_OPERATIONS.destroy) {
      const binding = parseQueueBindings(environment)[queueName];
      const metadata = asRecord(params.action.metadata);
      const bindingScope = asRecord(binding?.providerScope);
      const boundProjectId = typeof bindingScope?.projectId === 'string'
        ? bindingScope.projectId
        : undefined;
      const { topicId, subscriptionId } = queueAdapter.queueResourceNames(environment, queueName);
      const expectedTopicName = boundProjectId
        ? `projects/${boundProjectId}/topics/${topicId}`
        : undefined;
      const expectedSubscriptionName = boundProjectId
        ? `projects/${boundProjectId}/subscriptions/${subscriptionId}`
        : undefined;
      if (
        params.action.metadata?.backend !== 'pubsub'
        || binding?.backend !== 'pubsub'
        || metadata?.topicName !== binding.topicName
        || metadata?.subscriptionName !== binding.subscriptionName
        || !exactStringRecord(plannedScope, bindingScope)
        || !exactStringRecord(bindingScope, currentProviderScope)
        || !boundProjectId
        || binding.topicName !== expectedTopicName
        || binding.subscriptionName !== expectedSubscriptionName
      ) {
        return {
          success: false,
          message: `Queue action "${params.action.id}" has stale mutation authority`,
          error: `The reviewed Pub/Sub topic, subscription, or project scope no longer matches "${queueName}". Re-run hv_plan.`,
        };
      }
      await queueAdapter.destroyQueue(environment, queueName);
      persistQueueBindings(environment.id, (current) => {
        const next = { ...current };
        delete next[queueName];
        return next;
      });
      return { success: true, message: `Destroyed Pub/Sub topic and subscription for "${queueName}"` };
    }

    const ackDeadlineSeconds = typeof params.action.metadata?.ackDeadlineSeconds === 'number'
      ? params.action.metadata.ackDeadlineSeconds
      : params.environmentSpec.queues?.[queueName]?.ackDeadlineSeconds;
    const result = await queueAdapter.ensureQueue(environment, queueName, { ackDeadlineSeconds });
    const { topicId, subscriptionId } = queueAdapter.queueResourceNames(environment, queueName);
    const expectedTopicName = `projects/${currentProviderScope.projectId}/topics/${topicId}`;
    const expectedSubscriptionName = `projects/${currentProviderScope.projectId}/subscriptions/${subscriptionId}`;
    const topicProjectId = pubsubResourceProjectId(result.topicName, 'topics');
    const subscriptionProjectId = pubsubResourceProjectId(result.subscriptionName, 'subscriptions');
    if (
      !topicProjectId
      || topicProjectId !== subscriptionProjectId
      || topicProjectId !== currentProviderScope.projectId
      || result.topicName !== expectedTopicName
      || result.subscriptionName !== expectedSubscriptionName
    ) {
      return {
        success: false,
        message: `Queue ${operation} returned an unexpected provider identity for "${queueName}"`,
        error: 'The Pub/Sub topic or subscription did not converge to the reviewed project-scoped identity. The local binding was not changed; re-run hv_plan.',
      };
    }
    persistQueueBindings(environment.id, (current) => ({
      ...current,
      [queueName]: {
        backend: 'pubsub',
        topicName: result.topicName,
        subscriptionName: result.subscriptionName,
        providerScope: { projectId: topicProjectId },
        updatedAt: new Date().toISOString(),
      },
    }));
    return {
      success: true,
      message: result.createdTopic || result.createdSubscription
        ? `Created Pub/Sub queue "${queueName}"`
        : `Pub/Sub queue "${queueName}" configured`,
      data: { topicName: result.topicName, subscriptionName: result.subscriptionName },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Queue ${operation} failed for "${queueName}"`, error: message };
  }
}
