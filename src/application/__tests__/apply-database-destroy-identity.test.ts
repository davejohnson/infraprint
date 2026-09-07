import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import '../providers.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Component } from '../../domain/entities/component.entity.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { bindingIdentityFingerprint } from '../../domain/services/binding-identity.js';

function projectSpec(databaseProvider?: string): ProjectSpec {
  return projectSpecSchema.parse({
    version: 1,
    project: 'database-destroy-identity',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: {},
        ...(databaseProvider ? { database: { provider: databaseProvider } } : {}),
      },
    },
  });
}

function destroyAction(params: {
  provider: string;
  externalId: string;
  providerScope: Record<string, string>;
  bindings: Record<string, unknown>;
  dependsOn?: string[];
  verified?: boolean;
}): PlanAction {
  return {
    id: `database:${params.provider}:destroy`,
    type: 'destroy',
    resource: { kind: 'database', name: 'postgres', provider: params.provider },
    verified: params.verified ?? true,
    reason: 'Database destroy identity regression fixture',
    dataBearing: true,
    requiresConfirm: true,
    dependsOn: params.dependsOn,
    metadata: {
      externalId: params.externalId,
      providerScope: params.providerScope,
      bindingsFingerprint: bindingIdentityFingerprint(params.bindings),
    },
  };
}

async function applyActions(params: {
  ctx: CommandContext;
  project: Project;
  environment: Environment;
  spec: ProjectSpec;
  actions: PlanAction[];
}) {
  const plan = params.ctx.repos.runs.create({
    projectId: params.project.id,
    environmentId: params.environment.id,
    type: 'plan',
    plan: {
      kind: 'hv_plan',
      environmentName: params.environment.name,
      specRevision: 1,
      observedFingerprint: null,
      actions: params.actions,
    },
  });
  return executePlanApply(params.ctx, {
    project: params.project,
    spec: params.spec,
    specRevision: 1,
    planId: plan.id,
    confirmActions: params.actions.filter((action) => action.requiresConfirm).map((action) => action.id),
  });
}

async function applyAction(params: {
  ctx: CommandContext;
  project: Project;
  environment: Environment;
  spec: ProjectSpec;
  action: PlanAction;
}) {
  return applyActions({ ...params, actions: [params.action] });
}

describe('database destroy apply identity', () => {
  let ctx: CommandContext;
  let project: Project;
  let environment: Environment;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-database-destroy-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'database-destroy-identity',
      defaultPlatform: 'railway',
    });
    environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway' },
    });

    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({
      observed: null,
      warnings: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
  });

  it('blocks when the reviewed database binding disappeared after planning', async () => {
    const scope = { projectId: 'rail-project', environmentId: 'rail-environment' };
    const bindings = { provider: 'railway', instanceId: 'database-reviewed', providerScope: scope };
    const action = destroyAction({
      provider: 'railway',
      externalId: 'database-reviewed',
      providerScope: scope,
      bindings,
    });
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const outcome = await applyAction({
      ctx,
      project,
      environment,
      spec: projectSpec(),
      action,
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Database destroy target disappeared after planning',
        }],
      },
    });
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('blocks a current database destroy when its provider id changed after planning', async () => {
    const scope = { projectId: 'rail-project', environmentId: 'rail-environment' };
    const bindings = { provider: 'railway', instanceId: 'database-reviewed', providerScope: scope };
    const component = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'database-reviewed',
      bindings,
    });
    const action = destroyAction({
      provider: 'railway',
      externalId: 'database-reviewed',
      providerScope: scope,
      bindings,
    });
    ctx.repos.components.update(component.id, { externalId: 'database-rebound' });
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const outcome = await applyAction({
      ctx,
      project,
      environment,
      spec: projectSpec(),
      action,
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Database destroy target changed after planning',
        }],
      },
    });
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('blocks a previous-provider destroy when its provider scope changed after planning', async () => {
    const reviewedScope = { projectId: 'gcp-project', region: 'us-west1' };
    const previousBindings = {
      provider: 'cloudsql',
      instanceId: 'database-reviewed',
      providerScope: reviewedScope,
    };
    const component = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'database-current',
      bindings: {
        provider: 'railway',
        instanceId: 'database-current',
        providerScope: { projectId: 'rail-project', environmentId: 'rail-environment' },
        previousProvider: 'cloudsql',
        previousExternalId: 'database-reviewed',
        previousBindings,
      },
    });
    const action = destroyAction({
      provider: 'cloudsql',
      externalId: 'database-reviewed',
      providerScope: reviewedScope,
      bindings: previousBindings,
    });
    ctx.repos.components.updateBindings(component.id, {
      previousBindings: {
        provider: 'cloudsql',
        instanceId: 'database-reviewed',
        providerScope: { ...reviewedScope, region: 'us-east1' },
      },
    });
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const outcome = await applyAction({
      ctx,
      project,
      environment,
      spec: projectSpec('railway'),
      action,
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Database destroy target changed after planning',
        }],
      },
    });
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('passes the exact reviewed previous database binding to the adapter', async () => {
    const reviewedScope = { projectId: 'gcp-project', region: 'us-west1' };
    const previousBindings = {
      provider: 'cloudsql',
      instanceId: 'database-reviewed',
      providerScope: reviewedScope,
    };
    const component = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'database-current',
      bindings: {
        provider: 'railway',
        instanceId: 'database-current',
        providerScope: { projectId: 'rail-project', environmentId: 'rail-environment' },
        previousProvider: 'cloudsql',
        previousExternalId: 'database-reviewed',
        previousBindings,
      },
    });
    const action = destroyAction({
      provider: 'cloudsql',
      externalId: 'database-reviewed',
      providerScope: reviewedScope,
      bindings: previousBindings,
    });
    const destroy = vi.fn(async (_component: Component) => ({ success: true, message: 'destroyed' }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { destroy } as never,
    });

    const outcome = await applyAction({
      ctx,
      project,
      environment,
      spec: projectSpec('railway'),
      action,
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: true },
    });
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({
      id: component.id,
      externalId: 'database-reviewed',
      bindings: expect.objectContaining({
        provider: 'cloudsql',
        instanceId: 'database-reviewed',
        providerScope: reviewedScope,
      }),
    }));
    expect(ctx.repos.components.findById(component.id)).toMatchObject({
      externalId: 'database-current',
      bindings: expect.not.objectContaining({ previousProvider: expect.anything() }),
    });
  });

  it('blocks when an adapter-consumed dependent id changed after planning', async () => {
    const scope = { projectId: 'rail-project', environmentId: 'rail-environment' };
    const bindings = {
      provider: 'railway',
      instanceId: 'database-reviewed',
      volumeId: 'volume-reviewed',
      resourceKind: 'postgres',
      providerScope: scope,
    };
    const component = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'database-reviewed',
      bindings,
    });
    const action = destroyAction({
      provider: 'railway',
      externalId: 'database-reviewed',
      providerScope: scope,
      bindings,
    });
    ctx.repos.components.updateBindings(component.id, { volumeId: 'volume-rebound' });
    const getDatabaseAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter');

    const outcome = await applyAction({
      ctx,
      project,
      environment,
      spec: projectSpec(),
      action,
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Database destroy target changed after planning',
        }],
      },
    });
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('destroys the retained provider first and then matches the post-cleanup current binding', async () => {
    const previousScope = { projectId: 'gcp-project', region: 'us-west1' };
    const previousBindings = {
      provider: 'cloudsql',
      instanceId: 'database-previous',
      providerScope: previousScope,
    };
    const currentScope = { projectId: 'rail-project', environmentId: 'rail-environment' };
    const currentBindings = {
      provider: 'railway',
      instanceId: 'database-current',
      volumeId: 'volume-current',
      resourceKind: 'postgres',
      providerScope: currentScope,
      previousProvider: 'cloudsql',
      previousExternalId: 'database-previous',
      previousBindings,
    };
    const currentBindingsAfterCleanup = {
      provider: 'railway',
      instanceId: 'database-current',
      volumeId: 'volume-current',
      resourceKind: 'postgres',
      providerScope: currentScope,
    };
    const component = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'database-current',
      bindings: currentBindings,
    });
    const previousAction = destroyAction({
      provider: 'cloudsql',
      externalId: 'database-previous',
      providerScope: previousScope,
      bindings: previousBindings,
      verified: false,
    });
    const currentAction = destroyAction({
      provider: 'railway',
      externalId: 'database-current',
      providerScope: currentScope,
      bindings: currentBindingsAfterCleanup,
      dependsOn: [previousAction.id],
    });
    const destroy = vi.fn(async (_component: Component) => ({ success: true, message: 'destroyed' }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { destroy } as never,
    });

    const outcome = await applyActions({
      ctx,
      project,
      environment,
      spec: projectSpec(),
      actions: [previousAction, currentAction],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: [
          { actionId: previousAction.id, status: 'succeeded' },
          { actionId: currentAction.id, status: 'succeeded' },
        ],
      },
    });
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(destroy.mock.calls[0]?.[0]).toMatchObject({
      externalId: 'database-previous',
      bindings: previousBindings,
    });
    expect(destroy.mock.calls[1]?.[0]).toMatchObject({
      externalId: 'database-current',
      bindings: currentBindingsAfterCleanup,
    });
    expect(ctx.repos.components.findById(component.id)).toBeNull();
  });
});
