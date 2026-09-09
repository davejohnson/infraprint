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
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { CACHE_OPERATIONS } from '../../domain/services/cache-plan.service.js';

const databaseTarget = {
  provider: 'cloudsql',
  externalId: 'shared-production-database',
  name: 'shared-production-database',
  providerScope: { projectId: 'gcp-project', region: 'us-west1' },
};

const cacheTarget = {
  provider: 'memorystore',
  externalId: 'shared-production-cache',
  name: 'shared-production-cache',
  providerScope: { projectId: 'gcp-project', region: 'us-west1' },
};

function retainedAction(kind: 'database' | 'cache'): PlanAction {
  if (kind === 'database') {
    return {
      id: `database:${databaseTarget.provider}:retained-destroy`,
      type: 'destroy',
      resource: { kind: 'database', name: 'postgres', provider: databaseTarget.provider },
      verified: true,
      reason: 'Retained database cleanup safety regression fixture',
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: 'retainedDatabaseDestroy',
        externalId: databaseTarget.externalId,
        providerScope: databaseTarget.providerScope,
      },
    };
  }
  return {
    id: `cache:${cacheTarget.provider}:retained-destroy`,
    type: 'destroy',
    resource: { kind: 'cache', name: 'redis', provider: cacheTarget.provider },
    verified: true,
    reason: 'Retained cache cleanup safety regression fixture',
    dataBearing: true,
    requiresConfirm: true,
    metadata: {
      operation: CACHE_OPERATIONS.retainedDestroy,
      externalId: cacheTarget.externalId,
      name: cacheTarget.name,
      engine: 'redis',
      providerEngine: 'redis',
      providerScope: cacheTarget.providerScope,
    },
  };
}

describe('retained datastore cleanup active-binding safety', () => {
  let ctx: CommandContext;
  let project: Project;
  let environment: Environment;
  let spec: ProjectSpec;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-retained-datastore-cleanup-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'retained-datastore-cleanup-safety',
      defaultPlatform: 'railway',
    });
    environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway' },
    });
    spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: { hosting: { provider: 'railway' }, services: {} },
      },
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

  async function applyAction(action: PlanAction) {
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        scope: 'retained-cleanup',
        environmentName: environment.name,
        specRevision: 1,
        observedFingerprint: null,
        actions: [action],
      },
    });
    return executePlanApply(ctx, {
      project,
      spec,
      specRevision: 1,
      planId: plan.id,
      confirmActions: [action.id],
    });
  }

  function retainTarget(kind: 'database' | 'cache') {
    ctx.repos.environments.updatePlatformBindings(environment.id, kind === 'database'
      ? {
          previousDatabase: {
            ...databaseTarget,
            engine: 'postgres',
          },
        }
      : {
          previousCache: {
            ...cacheTarget,
            engine: 'redis',
            providerEngine: 'redis',
          },
        });
  }

  it.each([
    { kind: 'database' as const, scopeState: 'exact', activeScope: databaseTarget.providerScope },
    { kind: 'database' as const, scopeState: 'missing', activeScope: undefined },
    {
      kind: 'database' as const,
      scopeState: 'mismatched',
      activeScope: { ...databaseTarget.providerScope, region: 'us-central1' },
    },
    { kind: 'cache' as const, scopeState: 'exact', activeScope: cacheTarget.providerScope },
    { kind: 'cache' as const, scopeState: 'missing', activeScope: undefined },
    {
      kind: 'cache' as const,
      scopeState: 'mismatched',
      activeScope: { ...cacheTarget.providerScope, region: 'us-central1' },
    },
  ])(
    'blocks retained $kind cleanup when another environment binds the provider id with $scopeState scope',
    async ({ kind, activeScope }) => {
      retainTarget(kind);
      const activeProject = kind === 'database'
        ? ctx.repos.projects.create({ name: 'other-local-project', defaultPlatform: 'cloudrun' })
        : project;
      const sibling = ctx.repos.environments.create({
        projectId: activeProject.id,
        name: 'production',
        platformBindings: { provider: 'railway' },
      });
      const target = kind === 'database' ? databaseTarget : cacheTarget;
      const active = ctx.repos.components.create({
        environmentId: sibling.id,
        type: kind === 'database' ? 'postgres' : 'redis',
        externalId: target.externalId,
        bindings: {
          provider: target.provider,
          instanceId: target.externalId,
          ...(activeScope ? { providerScope: activeScope } : {}),
        },
      });
      const destroy = vi.fn(async () => ({ success: true, message: 'deleted' }));

      if (kind === 'database') {
        const observeDatabase = vi.fn()
          .mockResolvedValueOnce({
            provider: databaseTarget.provider,
            engine: 'postgres',
            externalId: databaseTarget.externalId,
            name: databaseTarget.name,
            providerScope: databaseTarget.providerScope,
            status: 'running',
          })
          .mockResolvedValueOnce(null);
        vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
          success: true,
          adapter: { observeDatabase, destroy } as never,
        });
      } else {
        const observeCache = vi.fn()
          .mockResolvedValueOnce({
            provider: cacheTarget.provider,
            engine: 'redis',
            externalId: cacheTarget.externalId,
            name: cacheTarget.name,
            providerScope: cacheTarget.providerScope,
            status: 'running',
          })
          .mockResolvedValueOnce(null);
        vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
          success: true,
          adapter: { observeCache, destroy } as never,
        });
      }

      const action = retainedAction(kind);
      const outcome = await applyAction(action);

      expect(outcome).toMatchObject({
        kind: 'executed',
        result: {
          success: false,
          receipts: [{ actionId: action.id, status: 'blocked' }],
        },
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(ctx.repos.components.findById(active.id)).toMatchObject({
        externalId: target.externalId,
        bindings: expect.objectContaining({ provider: target.provider }),
      });
      expect(ctx.repos.components.findById(active.id)?.bindings.providerScope).toEqual(activeScope);
      const retainedKey = kind === 'database' ? 'previousDatabase' : 'previousCache';
      expect(ctx.repos.environments.findById(environment.id)?.platformBindings[retainedKey])
        .toMatchObject({ externalId: target.externalId, providerScope: target.providerScope });
    }
  );

  it('invokes idempotent retained database teardown when pre-observation is absent', async () => {
    retainTarget('database');
    const observeDatabase = vi.fn(async () => null);
    const destroy = vi.fn(async () => ({ success: true, message: 'dependent cleanup complete' }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { observeDatabase, destroy } as never,
    });

    const action = retainedAction('database');
    const outcome = await applyAction(action);

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: true, receipts: [{ actionId: action.id, status: 'succeeded' }] },
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({
      externalId: databaseTarget.externalId,
      bindings: expect.objectContaining({
        retainedCleanup: true,
        providerScope: databaseTarget.providerScope,
      }),
    }));
    expect(observeDatabase).toHaveBeenCalledTimes(2);
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.previousDatabase)
      .toBeUndefined();
  });

  it.each(['instanceId', 'serviceId'] as const)(
    'blocks apply when stale externalId conflicts with a matching bindings.%s',
    async (bindingKey) => {
      retainTarget('database');
      const sibling = ctx.repos.environments.create({
        projectId: project.id,
        name: 'production',
        platformBindings: { provider: 'railway' },
      });
      const active = ctx.repos.components.create({
        environmentId: sibling.id,
        type: 'postgres',
        externalId: 'stale-local-database-id',
        bindings: {
          provider: databaseTarget.provider,
          [bindingKey]: databaseTarget.externalId,
          providerScope: databaseTarget.providerScope,
        },
      });
      const destroy = vi.fn(async () => ({ success: true, message: 'deleted' }));
      const observeDatabase = vi.fn()
        .mockResolvedValueOnce({
          provider: databaseTarget.provider,
          engine: 'postgres',
          externalId: databaseTarget.externalId,
          name: databaseTarget.name,
          providerScope: databaseTarget.providerScope,
          status: 'running',
        })
        .mockResolvedValueOnce(null);
      vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
        success: true,
        adapter: { observeDatabase, destroy } as never,
      });

      const action = retainedAction('database');
      const outcome = await applyAction(action);

      expect(outcome).toMatchObject({
        kind: 'executed',
        result: {
          success: false,
          receipts: [{ actionId: action.id, status: 'blocked' }],
        },
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(ctx.repos.components.findById(active.id)).toMatchObject({
        externalId: 'stale-local-database-id',
        bindings: expect.objectContaining({ [bindingKey]: databaseTarget.externalId }),
      });
      expect(ctx.repos.environments.findById(environment.id)?.platformBindings.previousDatabase)
        .toMatchObject({ externalId: databaseTarget.externalId });
    }
  );
});
