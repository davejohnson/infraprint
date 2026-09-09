import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import {
  ConvergeExecutor,
  fingerprintObservedState,
  orderActions,
  type PlanRunDocument,
} from '../converge.executor.js';
import type { PlanAction } from '../plan.types.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';

let projectId: string;
let environmentId: string;
const runRepo = () => new RunRepository();

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-converge-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  const project = new ProjectRepository().create({ name: 'converge-test' });
  projectId = project.id;
  environmentId = new EnvironmentRepository().create({ projectId, name: 'staging' }).id;
});

function action(partial: Partial<PlanAction> & { id: string }): PlanAction {
  return {
    type: 'create',
    resource: { kind: 'service', name: partial.id.split(':')[1] ?? partial.id, provider: 'railway' },
    verified: true,
    reason: 'test',
    ...partial,
  } as PlanAction;
}

function storePlan(actions: PlanAction[], overrides: Partial<PlanRunDocument> = {}): string {
  const document: PlanRunDocument = {
    kind: 'hv_plan',
    environmentName: 'staging',
    specRevision: 1,
    observedFingerprint: null,
    actions,
    ...overrides,
  };
  return runRepo().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
}

describe('orderActions', () => {
  it('orders by dependsOn', () => {
    const ordered = orderActions([
      action({ id: 'service:web', dependsOn: ['project:railway'] }),
      action({ id: 'project:railway', resource: { kind: 'project', name: 'p', provider: 'railway' } }),
    ]);
    expect(ordered.map((a) => a.id)).toEqual(['project:railway', 'service:web']);
  });

  it('throws on cycles', () => {
    expect(() => orderActions([
      action({ id: 'a', dependsOn: ['b'] }),
      action({ id: 'b', dependsOn: ['a'] }),
    ])).toThrow(/cycle/i);
  });

  it('throws on unknown dependencies instead of silently dropping the edge', () => {
    expect(() => orderActions([
      action({
        id: 'cache:redis:destroy',
        dependsOn: ['service:web'],
      }),
      action({ id: 'service:web:destroy', type: 'destroy' }),
    ])).toThrow(
      'Unknown dependency "service:web" referenced by action "cache:redis:destroy"'
    );
  });

  it('throws on duplicate action ids', () => {
    expect(() => orderActions([
      action({ id: 'service:web' }),
      action({ id: 'service:web', type: 'update' }),
    ])).toThrow('Duplicate plan action id "service:web"');
  });
});

describe('ConvergeExecutor staleness', () => {
  it('rejects unknown plan ids', async () => {
    const result = await new ConvergeExecutor().execute({
      planRunId: 'nope', currentSpecRevision: 1, handler: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects malformed persisted actions before reserving an apply', async () => {
    const plan = runRepo().create({
      projectId,
      environmentId,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'staging',
        specRevision: 1,
        observedFingerprint: null,
        actions: [{
          id: 'service:web',
          type: 'launch',
          resource: { kind: 'service', name: 'web', provider: 'railway' },
          verified: true,
          reason: 'malformed test action',
        }],
      },
    });
    const handler = vi.fn();

    const result = await new ConvergeExecutor().execute({
      planRunId: plan.id,
      currentSpecRevision: 1,
      handler,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('not a valid persisted hv_plan'),
    });
    expect(result.error).toContain('Re-run hv_plan');
    expect(handler).not.toHaveBeenCalled();
    expect(runRepo().findByEnvironmentId(environmentId).filter((run) => run.type === 'apply')).toEqual([]);
  });

  it('rejects persisted data-resource actions whose confirmation flags were stripped', async () => {
    const handler = vi.fn();
    const planId = storePlan([action({
      id: 'database:railway:destroy',
      type: 'destroy',
      resource: { kind: 'database', name: 'postgres', provider: 'railway' },
      dataBearing: true,
      requiresConfirm: false,
    })]);

    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      confirmActions: ['database:railway:destroy'],
      handler,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('not a valid persisted hv_plan'),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(runRepo().findByEnvironmentId(environmentId).filter((run) => run.type === 'apply')).toEqual([]);
  });

  it('rejects a persisted queue destroy whose data-loss flags were stripped', async () => {
    const handler = vi.fn();
    const planId = storePlan([action({
      id: 'queue:jobs:destroy',
      type: 'destroy',
      resource: { kind: 'queue', name: 'jobs', provider: 'cloudrun' },
      dataBearing: false,
      requiresConfirm: false,
      metadata: { operation: 'queueDestroy', queueName: 'jobs', backend: 'pubsub' },
    })]);

    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      confirmActions: ['queue:jobs:destroy'],
      handler,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('not a valid persisted hv_plan'),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a persisted domain purchase whose billing confirmation flags were stripped', async () => {
    const handler = vi.fn();
    const planId = storePlan([action({
      id: 'domain:example.com:register',
      type: 'create',
      resource: { kind: 'domain', name: 'example.com', provider: 'cloudflare' },
      billable: false,
      requiresConfirm: false,
      metadata: { operation: 'cloudflareRegistrarRegistration', accountId: 'account-1' },
    })]);

    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      confirmActions: ['domain:example.com:register'],
      handler,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('not a valid persisted hv_plan'),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'an unrelated action',
      actions: [action({ id: 'service:web', type: 'update' })],
      overrides: {},
    },
    {
      label: 'deploy overrides',
      actions: [action({
        id: 'service:web:previous-destroy',
        type: 'destroy',
        resource: { kind: 'service', name: 'web', provider: 'cloudrun' },
        requiresConfirm: true,
        metadata: {
          operation: 'previousHostingDestroy',
          previousProvider: 'cloudrun',
          cleanupBoundary: 'services',
          serviceId: 'old-cloudrun-web',
        },
      })],
      overrides: { overrides: { services: ['web'] } },
    },
  ])('rejects a persisted retained-cleanup plan containing $label', async ({ actions, overrides }) => {
    const handler = vi.fn();
    const planId = storePlan(actions, {
      scope: 'retained-cleanup',
      ...overrides,
    });

    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      handler,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('not a valid persisted hv_plan'),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(runRepo().findByEnvironmentId(environmentId).filter((run) => run.type === 'apply')).toEqual([]);
  });

  it('rejects plans against a superseded spec revision', async () => {
    const planId = storePlan([action({ id: 'service:web' })], { specRevision: 1 });
    const result = await new ConvergeExecutor().execute({
      planRunId: planId, currentSpecRevision: 2, handler: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Re-run hv_plan');
  });

  it('rejects plans older than the max age', async () => {
    const planId = storePlan([action({ id: 'service:web' })]);
    const result = await new ConvergeExecutor().execute({
      planRunId: planId, currentSpecRevision: 1, handler: vi.fn(), maxPlanAgeMs: -1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Re-run hv_plan');
  });

  it('rejects when live infrastructure changed since planning', async () => {
    const planId = storePlan([action({ id: 'service:web' })], { observedFingerprint: 'abc' });
    const result = await new ConvergeExecutor().execute({
      planRunId: planId, currentSpecRevision: 1, freshObservedFingerprint: 'def', handler: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('changed since this plan');
  });

  it('rejects when an observed integration changed since planning', async () => {
    const handler = vi.fn();
    const planId = storePlan(
      [action({ id: 'payment:stripe:staging', type: 'noop' })],
      { integrationFingerprints: { stripe: 'planned-hash' } }
    );
    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      freshIntegrationFingerprints: { stripe: 'fresh-hash' },
      handler,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('stripe changed since this plan');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects double-apply of the same plan', async () => {
    const planId = storePlan([action({ id: 'service:web' })]);
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const first = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(first.success).toBe(true);
    const second = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already applied');
  });

  it('atomically rejects a concurrent apply of the same plan', async () => {
    const planId = storePlan([action({ id: 'service:web' })]);
    let finishFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const handler = vi.fn(async () => {
      await firstCanFinish;
      return { success: true, message: 'ok' };
    });

    const firstPromise = new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      handler,
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    const second = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      handler,
    });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already being applied');
    expect(second.conflict).toMatchObject({
      kind: 'plan_in_progress',
      runId: expect.any(String),
    });
    expect(handler).toHaveBeenCalledOnce();

    finishFirst();
    await expect(firstPromise).resolves.toMatchObject({ success: true });
  });

  it('serializes different plans that target the same environment', async () => {
    const firstPlanId = storePlan([action({ id: 'service:web' })]);
    const secondPlanId = storePlan([action({ id: 'service:worker' })]);
    let finishFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstHandler = vi.fn(async () => {
      await firstCanFinish;
      return { success: true, message: 'ok' };
    });

    const firstPromise = new ConvergeExecutor().execute({
      planRunId: firstPlanId,
      currentSpecRevision: 1,
      handler: firstHandler,
    });
    await vi.waitFor(() => expect(firstHandler).toHaveBeenCalledOnce());

    const secondHandler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const second = await new ConvergeExecutor().execute({
      planRunId: secondPlanId,
      currentSpecRevision: 1,
      handler: secondHandler,
    });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already has a running apply');
    expect(second.conflict).toMatchObject({
      kind: 'environment_in_progress',
      runId: expect.any(String),
    });
    expect(secondHandler).not.toHaveBeenCalled();

    finishFirst();
    await expect(firstPromise).resolves.toMatchObject({ success: true });
  });
});

describe('ConvergeExecutor execution', () => {
  it('gives each action handler the durable apply-run identity', async () => {
    let handlerApplyRunId: string | undefined;
    const handler = vi.fn(async (_action: PlanAction, context: { applyRunId: string }) => {
      handlerApplyRunId = context.applyRunId;
      return { success: true, message: 'ok' };
    });
    const planId = storePlan([action({ id: 'service:web' })]);

    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      handler,
    });

    expect(result.success).toBe(true);
    expect(handlerApplyRunId).toBe(result.applyRunId);
    expect(runRepo().findById(handlerApplyRunId!)?.type).toBe('apply');
  });

  it('executes actions in dependency order, skipping noops', async () => {
    const executedIds: string[] = [];
    const handler = vi.fn(async (a: PlanAction) => {
      executedIds.push(a.id);
      return { success: true, message: 'ok' };
    });
    const planId = storePlan([
      action({ id: 'service:web', dependsOn: ['project:railway'] }),
      action({ id: 'database:railway', type: 'noop' }),
      action({ id: 'project:railway', resource: { kind: 'project', name: 'p', provider: 'railway' } }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(true);
    expect(executedIds).toEqual(['project:railway', 'service:web']);
    expect(result.receipts.find((r) => r.actionId === 'database:railway')!.status).toBe('skipped_noop');

    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.type).toBe('apply');
    expect(applyRun.status).toBe('succeeded');
    expect((applyRun.plan as Record<string, unknown>).planRunId).toBe(planId);
  });

  it('skips confirm-gated destroys unless confirmed, and blocks dependents of skipped actions', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const planId = storePlan([
      action({ id: 'database:railway:destroy', type: 'destroy', dataBearing: true, requiresConfirm: true }),
      action({ id: 'cleanup:after', dependsOn: ['database:railway:destroy'] }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    const statuses = new Map(result.receipts.map((r) => [r.actionId, r.status]));
    expect(statuses.get('database:railway:destroy')).toBe('skipped_requires_confirm');
    expect(statuses.get('cleanup:after')).toBe('aborted');
    expect(handler).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.status).toBe('blocked');
    expect(applyRun.receipts.find((receipt) => receipt.step === 'database:railway:destroy')).toMatchObject({
      status: 'blocked',
      result: { message: expect.stringContaining('confirmActions') },
    });
  });

  it('executes confirm-gated destroys when explicitly confirmed', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'destroyed' });
    const planId = storePlan([
      action({ id: 'database:railway:destroy', type: 'destroy', dataBearing: true, requiresConfirm: true }),
    ]);
    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      confirmActions: ['database:railway:destroy'],
      handler,
    });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not mutate a replacement action until its exact id is confirmed', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'replaced' });
    const replacement = action({
      id: 'domain:app.example.com',
      type: 'replace',
      resource: { kind: 'domain', name: 'app.example.com', provider: 'railway' },
      requiresConfirm: true,
    });

    const unconfirmedPlanId = storePlan([replacement]);
    const unconfirmed = await new ConvergeExecutor().execute({
      planRunId: unconfirmedPlanId,
      currentSpecRevision: 1,
      handler,
    });
    expect(unconfirmed.success).toBe(false);
    expect(unconfirmed.receipts[0]?.status).toBe('skipped_requires_confirm');
    expect(handler).not.toHaveBeenCalled();

    const confirmedPlanId = storePlan([replacement]);
    const confirmed = await new ConvergeExecutor().execute({
      planRunId: confirmedPlanId,
      currentSpecRevision: 1,
      confirmActions: ['domain:app.example.com'],
      handler,
    });
    expect(confirmed.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    { flag: 'billable', action: action({ id: 'database:railway', billable: true }) },
    { flag: 'data-bearing', action: action({ id: 'database:railway:destroy', type: 'destroy', dataBearing: true }) },
  ])('centrally confirmation-gates $flag actions even when requiresConfirm was omitted', async ({ action: guardedAction }) => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const planId = storePlan([guardedAction]);

    const result = await new ConvergeExecutor().execute({
      planRunId: planId,
      currentSpecRevision: 1,
      handler,
    });

    expect(result.success).toBe(false);
    expect(result.receipts[0]?.status).toBe('skipped_requires_confirm');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns and persists handler data on action receipts', async () => {
    const handlerData = {
      appDeploymentPending: true,
      appDeployment: { status: 'pending_ci' },
    };
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'ok', data: handlerData });
    const planId = storePlan([action({ id: 'service:web' })]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(true);
    expect(result.receipts.find((receipt) => receipt.actionId === 'service:web')).toMatchObject({
      status: 'succeeded',
      data: handlerData,
    });

    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.receipts.find((receipt) => receipt.step === 'service:web')?.result).toMatchObject({
      message: 'ok',
      ...handlerData,
    });
  });

  it('records pending actions without treating them as failed and blocks dependents', async () => {
    const handler = vi.fn(async (a: PlanAction) =>
      a.id === 'domain:example.com:register'
        ? { success: false, status: 'pending' as const, message: 'registration in progress', data: { state: 'in_progress' } }
        : { success: true, message: 'ok' });
    const planId = storePlan([
      action({
        id: 'domain:example.com:register',
        resource: { kind: 'domain', name: 'example.com', provider: 'cloudflare' },
      }),
      action({
        id: 'domain:example.com',
        resource: { kind: 'domain', name: 'example.com', provider: 'railway' },
        dependsOn: ['domain:example.com:register'],
      }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
    const statuses = new Map(result.receipts.map((r) => [r.actionId, r.status]));
    expect(statuses.get('domain:example.com:register')).toBe('pending');
    expect(statuses.get('domain:example.com')).toBe('aborted');

    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.status).toBe('pending');
    expect(applyRun.completedAt).toBeInstanceOf(Date);
    expect(applyRun.receipts.find((receipt) => receipt.step === 'domain:example.com:register')).toMatchObject({
      status: 'pending',
      result: { message: 'registration in progress', state: 'in_progress' },
    });
  });

  it('stops the stage after pending work even when a later action is independent', async () => {
    const handler = vi.fn(async (a: PlanAction) => a.id === 'repo:github-infrastructure-pr'
      ? { success: false, status: 'pending' as const, message: 'awaiting PR merge' }
      : { success: true, message: 'should not run' });
    const planId = storePlan([
      action({ id: 'repo:github-infrastructure-pr', resource: { kind: 'repo', name: 'owner/repo', provider: 'github' } }),
      action({ id: 'service:web' }),
    ]);
    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(['pending', 'aborted']);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('records blocked actions separately from provider failures', async () => {
    const handler = vi.fn(async () => ({
      success: false,
      status: 'blocked' as const,
      message: 'user action required',
      error: 'Verify registrant contact',
    }));
    const planId = storePlan([action({ id: 'domain:example.com:register' })]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.receipts[0]).toMatchObject({
      actionId: 'domain:example.com:register',
      status: 'blocked',
      message: 'user action required',
      error: 'Verify registrant contact',
    });
    const applyRun = runRepo().findById(result.applyRunId!)!;
    expect(applyRun.status).toBe('blocked');
    expect(applyRun.completedAt).toBeInstanceOf(Date);
  });

  it('aborts remaining actions after a failure and records a failed apply run', async () => {
    const handler = vi.fn(async (a: PlanAction) =>
      a.id === 'service:web'
        ? { success: false, message: 'deploy failed', error: 'boom' }
        : { success: true, message: 'ok' });
    const planId = storePlan([
      action({ id: 'service:web' }),
      action({ id: 'domain:myapp.dev', type: 'update', resource: { kind: 'domain', name: 'myapp.dev', provider: 'railway' } }),
    ]);

    const result = await new ConvergeExecutor().execute({ planRunId: planId, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    const statuses = new Map(result.receipts.map((r) => [r.actionId, r.status]));
    expect(statuses.get('service:web')).toBe('failed');
    expect(statuses.get('domain:myapp.dev')).toBe('aborted');
    expect(runRepo().findById(result.applyRunId!)!.status).toBe('failed');
  });

  it('releases the environment reservation after a failed apply', async () => {
    const firstPlanId = storePlan([action({ id: 'service:web' })]);
    const failed = await new ConvergeExecutor().execute({
      planRunId: firstPlanId,
      currentSpecRevision: 1,
      handler: vi.fn().mockResolvedValue({
        success: false,
        message: 'provider rejected the mutation',
        error: 'boom',
      }),
    });
    expect(failed.success).toBe(false);

    const secondPlanId = storePlan([action({ id: 'service:worker' })]);
    const secondHandler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const retried = await new ConvergeExecutor().execute({
      planRunId: secondPlanId,
      currentSpecRevision: 1,
      handler: secondHandler,
    });
    expect(retried.success).toBe(true);
    expect(secondHandler).toHaveBeenCalledOnce();
  });
});

describe('fingerprintObservedState', () => {
  const base: ObservedState = {
    provider: 'railway',
    observedAt: '2026-06-10T00:00:00Z',
    projectExists: true,
    projectId: 'p1',
    environmentId: 'e1',
    services: [{
      name: 'web', externalId: 's1', workloadKind: 'web', customDomains: ['b.com', 'a.com'],
      config: { startCommand: 'npm start' },
      envVarKeys: ['A', 'B'],
      envVarHashes: { B: hashEnvValue('2'), A: hashEnvValue('1') },
      status: 'running',
    }],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db1', status: 'running' }],
    partial: false,
    warnings: [],
  };

  it('is stable across volatile fields and ordering', () => {
    const reordered: ObservedState = {
      ...base,
      observedAt: '2026-06-11T12:00:00Z',
      warnings: ['transient'],
      services: [{
        ...base.services[0],
        customDomains: ['a.com', 'b.com'],
        envVarKeys: ['B', 'A'],
        envVarHashes: { A: hashEnvValue('1'), B: hashEnvValue('2') },
      }],
    };
    expect(fingerprintObservedState(reordered)).toBe(fingerprintObservedState(base));
  });

  it('changes when meaningful state changes', () => {
    const changed: ObservedState = {
      ...base,
      services: [{ ...base.services[0], envVarHashes: { A: hashEnvValue('1'), B: hashEnvValue('CHANGED') } }],
    };
    expect(fingerprintObservedState(changed)).not.toBe(fingerprintObservedState(base));
  });

  it('changes when a masked environment-variable name appears without a hash', () => {
    const before: ObservedState = {
      ...base,
      services: [{ ...base.services[0], envVarKeys: ['A'], envVarHashes: { A: hashEnvValue('1') } }],
    };
    const after: ObservedState = {
      ...before,
      services: [{ ...before.services[0], envVarKeys: ['A', 'SESSION_SECRET'] }],
    };

    expect(fingerprintObservedState(before)).not.toBe(fingerprintObservedState(after));
  });

  it('changes when service, database, or cache readiness changes', () => {
    const withCache: ObservedState = {
      ...base,
      caches: [{ provider: 'railway', engine: 'redis', externalId: 'cache-1', status: 'running' }],
    };
    expect(fingerprintObservedState({
      ...withCache,
      services: [{ ...withCache.services[0], status: 'failed' }],
    })).not.toBe(fingerprintObservedState(withCache));
    expect(fingerprintObservedState({
      ...withCache,
      databases: [{ ...withCache.databases[0], status: 'error' }],
    })).not.toBe(fingerprintObservedState(withCache));
    expect(fingerprintObservedState({
      ...withCache,
      caches: [{ ...withCache.caches![0], status: 'provisioning' }],
    })).not.toBe(fingerprintObservedState(withCache));
  });

  it('changes when a service origin URL changes', () => {
    const before: ObservedState = {
      ...base,
      services: [{ ...base.services[0], url: 'https://old.example' }],
    };
    const after: ObservedState = {
      ...base,
      services: [{ ...base.services[0], url: 'https://new.example' }],
    };
    expect(fingerprintObservedState(before)).not.toBe(fingerprintObservedState(after));
  });

  it('changes when deploy source changes', () => {
    const withSource: ObservedState = {
      ...base,
      services: [{ ...base.services[0], source: { repo: 'dave/app', branch: 'main' } }],
    };
    const withOtherBranch: ObservedState = {
      ...base,
      services: [{ ...base.services[0], source: { repo: 'dave/app', branch: 'staging' } }],
    };
    expect(fingerprintObservedState(withSource)).not.toBe(fingerprintObservedState(withOtherBranch));
  });

  it('changes when the active deployment identity changes', () => {
    const before: ObservedState = {
      ...base,
      services: [{ ...base.services[0], deployment: { id: 'deployment-before', status: 'READY' } }],
    };
    const after: ObservedState = {
      ...base,
      services: [{ ...base.services[0], deployment: { id: 'deployment-after', status: 'READY' } }],
    };
    expect(fingerprintObservedState(before)).not.toBe(fingerprintObservedState(after));
  });

  it('changes when provider domain verification changes', () => {
    const pending: ObservedState = {
      ...base,
      services: [{
        ...base.services[0],
        customDomainStatus: { 'a.com': { providerVerified: false, dnsConfigured: false } },
      }],
    };
    const verified: ObservedState = {
      ...pending,
      services: [{
        ...pending.services[0],
        customDomainStatus: { 'a.com': { providerVerified: true, dnsConfigured: true } },
      }],
    };
    expect(fingerprintObservedState(pending)).not.toBe(fingerprintObservedState(verified));
  });

  it('changes when deploy-source observation changes from unknown to disconnected', () => {
    const unknown: ObservedState = {
      ...base,
      services: [{ ...base.services[0], sourceState: 'unknown' }],
    };
    const disconnected: ObservedState = {
      ...base,
      services: [{ ...base.services[0], sourceState: 'disconnected' }],
    };
    expect(fingerprintObservedState(unknown)).not.toBe(fingerprintObservedState(disconnected));
  });

  it('includes provider-native database scope while remaining key-order stable', () => {
    const scoped: ObservedState = {
      ...base,
      databases: [{
        ...base.databases[0],
        providerScope: { organizationSlug: 'primary', region: 'iad' },
      }],
    };
    const reorderedScope: ObservedState = {
      ...base,
      databases: [{
        ...base.databases[0],
        providerScope: { region: 'iad', organizationSlug: 'primary' },
      }],
    };
    const otherOrganization: ObservedState = {
      ...scoped,
      databases: [{
        ...scoped.databases[0],
        providerScope: { organizationSlug: 'secondary', region: 'iad' },
      }],
    };

    expect(fingerprintObservedState(reorderedScope)).toBe(fingerprintObservedState(scoped));
    expect(fingerprintObservedState(otherOrganization)).not.toBe(fingerprintObservedState(scoped));
  });

  it('includes cache and storage scope while remaining key-order stable', () => {
    const scoped: ObservedState = {
      ...base,
      caches: [{
        provider: 'railway',
        engine: 'redis',
        externalId: 'cache-1',
        providerScope: { projectId: 'project-1', environmentId: 'environment-1' },
        status: 'running',
        config: { region: 'us-central1', tier: 'BASIC', size: '1gb' },
      }],
      storage: [{
        provider: 'railway',
        kind: 'object',
        externalId: 'bucket-1',
        instanceScope: { projectId: 'project-1', environmentId: 'environment-1' },
        name: 'uploads',
        status: 'ready',
      }],
    };
    const reordered: ObservedState = {
      ...scoped,
      caches: [{
        ...scoped.caches![0],
        providerScope: { environmentId: 'environment-1', projectId: 'project-1' },
        config: { size: '1gb', tier: 'BASIC', region: 'us-central1' },
      }],
      storage: [{
        ...scoped.storage![0],
        instanceScope: { environmentId: 'environment-1', projectId: 'project-1' },
      }],
    };
    const changedCacheScope: ObservedState = {
      ...scoped,
      caches: [{
        ...scoped.caches![0],
        providerScope: { projectId: 'project-2', environmentId: 'environment-1' },
      }],
    };
    const changedStorageScope: ObservedState = {
      ...scoped,
      storage: [{
        ...scoped.storage![0],
        instanceScope: { projectId: 'project-2', environmentId: 'environment-1' },
      }],
    };
    const changedCacheConfig: ObservedState = {
      ...scoped,
      caches: [{
        ...scoped.caches![0],
        config: { region: 'us-central1', tier: 'STANDARD_HA', size: '1gb' },
      }],
    };

    expect(fingerprintObservedState(reordered)).toBe(fingerprintObservedState(scoped));
    expect(fingerprintObservedState(changedCacheScope)).not.toBe(fingerprintObservedState(scoped));
    expect(fingerprintObservedState(changedStorageScope)).not.toBe(fingerprintObservedState(scoped));
    expect(fingerprintObservedState(changedCacheConfig)).not.toBe(fingerprintObservedState(scoped));
  });
});
