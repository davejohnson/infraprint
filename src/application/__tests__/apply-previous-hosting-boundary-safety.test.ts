import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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

const environmentTarget = {
  provider: 'railway',
  projectId: 'railway-shared-project',
  environmentId: 'railway-production',
};

const projectTarget = {
  provider: 'ecs',
  projectId: 'ecs-shared-project',
};

type Boundary = 'environment' | 'project';
type BoundaryTarget = typeof environmentTarget | typeof projectTarget;

function projectSpec(): ProjectSpec {
  return projectSpecSchema.parse({
    version: 1,
    project: 'previous-hosting-boundary-safety',
    environments: {
      production: {
        hosting: { provider: 'cloudrun' },
        services: {},
      },
    },
  });
}

function boundaryAction(boundary: Boundary, target: BoundaryTarget): PlanAction {
  return {
    id: boundary === 'environment'
      ? `environment:production:${target.provider}:previous-destroy`
      : `project:${target.provider}:previous-destroy`,
    type: 'destroy',
    resource: {
      kind: boundary,
      name: 'production',
      provider: target.provider,
    },
    verified: true,
    reason: `Delete the retained ${target.provider} ${boundary}`,
    requiresConfirm: true,
    metadata: {
      operation: 'previousHostingDestroy',
      cleanupBoundary: boundary,
      previousProvider: target.provider,
      projectId: target.projectId,
      ...(boundary === 'environment'
        ? { environmentId: (target as typeof environmentTarget).environmentId }
        : {}),
    },
  };
}

describe('previous hosting boundary destroy safety', () => {
  let ctx: CommandContext;
  let project: Project;
  let environment: Environment;
  let directory: string;
  let deleteEnvironment: ReturnType<typeof vi.fn>;
  let deleteProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-previous-boundary-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'previous-hosting-boundary-safety',
      defaultPlatform: 'cloudrun',
    });
    environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'cloudrun-project',
        environmentId: 'us-central1',
        services: {},
        previousHosting: {
          ...environmentTarget,
          services: {},
        },
      },
    });

    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({
      observed: null,
      warnings: [],
    });
    deleteEnvironment = vi.fn(async () => ({ success: true }));
    deleteProject = vi.fn(async () => ({ success: true }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: environmentTarget.provider,
        deleteEnvironment,
        deleteProject,
      } as never,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  function createSibling(platformBindings: Record<string, unknown>): Environment {
    const siblingProject = ctx.repos.projects.create({
      name: `sibling-${ctx.repos.projects.findAll().length}`,
      defaultPlatform: 'cloudrun',
    });
    return ctx.repos.environments.create({
      projectId: siblingProject.id,
      name: 'staging',
      platformBindings,
    });
  }

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
    return {
      action,
      outcome: await executePlanApply(ctx, {
        project,
        spec: projectSpec(),
        specRevision: 1,
        planId: plan.id,
        confirmActions: [action.id],
      }),
    };
  }

  async function applyBoundary(boundary: Boundary) {
    const target = boundary === 'environment' ? environmentTarget : projectTarget;
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      previousHosting: { ...target, services: {} },
    });
    return applyAction(boundaryAction(boundary, target));
  }

  function expectBlockedAndPreserved(
    action: PlanAction,
    outcome: Awaited<ReturnType<typeof executePlanApply>>
  ): void {
    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ actionId: action.id, status: 'blocked' }],
      },
    });
    expect(deleteEnvironment).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toMatchObject({
      previousHosting: {
        provider: action.resource.provider,
        projectId: action.metadata?.projectId,
      },
    });
  }

  it.each(['current', 'previous'] as const)(
    'blocks environment deletion when another project has a %s hosting alias',
    async (source) => {
      createSibling(source === 'current'
        ? { ...environmentTarget, services: {} }
        : {
            provider: 'cloudrun',
            projectId: 'other-cloudrun-project',
            environmentId: 'us-east1',
            services: {},
            previousHosting: { ...environmentTarget, services: {} },
          });

      const { action, outcome } = await applyBoundary('environment');

      expectBlockedAndPreserved(action, outcome);
    }
  );

  it.each([
    ['current database', 'postgres', 'component'],
    ['current cache', 'redis', 'component'],
    ['current provider-native component', 'bucket', 'component'],
    ['previous database', 'postgres', 'previous'],
    ['previous cache', 'redis', 'previous'],
  ] as const)(
    'blocks environment deletion when an exact %s binding remains',
    async (_label, type, source) => {
      const sibling = createSibling({
        provider: 'cloudrun',
        projectId: 'other-cloudrun-project',
        environmentId: 'us-east1',
        services: {},
        ...(source === 'previous' && type === 'postgres'
          ? {
              previousDatabase: {
                provider: environmentTarget.provider,
                externalId: 'retained-database',
                engine: 'postgres',
                name: 'retained-database',
                providerScope: {
                  projectId: environmentTarget.projectId,
                  environmentId: environmentTarget.environmentId,
                },
              },
            }
          : {}),
        ...(source === 'previous' && type === 'redis'
          ? {
              previousCache: {
                provider: environmentTarget.provider,
                externalId: 'retained-cache',
                engine: 'redis',
                providerEngine: 'redis',
                name: 'retained-cache',
                providerScope: {
                  projectId: environmentTarget.projectId,
                  environmentId: environmentTarget.environmentId,
                },
              },
            }
          : {}),
      });
      if (source === 'component') {
        ctx.repos.components.create({
          environmentId: sibling.id,
          type,
          externalId: `retained-${type}`,
          bindings: {
            provider: environmentTarget.provider,
            providerScope: {
              projectId: environmentTarget.projectId,
              environmentId: environmentTarget.environmentId,
            },
          },
        });
      }

      const { action, outcome } = await applyBoundary('environment');

      expectBlockedAndPreserved(action, outcome);
    }
  );

  it.each([
    ['environment', 'postgres'],
    ['environment', 'redis'],
    ['project', 'postgres'],
    ['project', 'redis'],
  ] as const)(
    'blocks %s deletion when an exact nested previous %s binding remains',
    async (boundary, type) => {
      const target = boundary === 'environment' ? environmentTarget : projectTarget;
      const sibling = createSibling({
        provider: 'cloudrun',
        projectId: 'other-cloudrun-project',
        environmentId: 'us-east1',
        services: {},
      });
      ctx.repos.components.create({
        environmentId: sibling.id,
        type,
        externalId: `active-${type}`,
        bindings: {
          provider: type === 'postgres' ? 'cloudsql' : 'memorystore',
          previousProvider: target.provider,
          previousExternalId: `previous-${type}`,
          previousBindings: {
            provider: target.provider,
            providerScope: {
              projectId: target.projectId,
              environmentId: boundary === 'environment'
                ? environmentTarget.environmentId
                : 'ecs-staging',
            },
          },
        },
      });

      const { action, outcome } = await applyBoundary(boundary);

      expectBlockedAndPreserved(action, outcome);
    }
  );

  it.each([
    ['environment', 'postgres'],
    ['environment', 'redis'],
    ['project', 'postgres'],
    ['project', 'redis'],
  ] as const)(
    'fails closed for %s deletion when a nested previous %s binding has incomplete scope',
    async (boundary, type) => {
      const target = boundary === 'environment' ? environmentTarget : projectTarget;
      const sibling = createSibling({
        provider: 'cloudrun',
        projectId: 'other-cloudrun-project',
        environmentId: 'us-east1',
        services: {},
      });
      ctx.repos.components.create({
        environmentId: sibling.id,
        type,
        externalId: `active-${type}`,
        bindings: {
          provider: type === 'postgres' ? 'cloudsql' : 'memorystore',
          previousProvider: target.provider,
          previousExternalId: `previous-${type}`,
          previousBindings: {
            provider: target.provider,
          },
        },
      });

      const { action, outcome } = await applyBoundary(boundary);

      expectBlockedAndPreserved(action, outcome);
    }
  );

  it('blocks environment deletion when an identified service-create recovery retains it', async () => {
    createSibling({
      provider: 'cloudrun',
      projectId: 'other-cloudrun-project',
      environmentId: 'us-east1',
      services: {},
      serviceCreateRecovery: {
        worker: {
          provider: environmentTarget.provider,
          operation: 'create',
          resourceName: 'worker',
          providerScope: {
            projectId: environmentTarget.projectId,
            environmentId: environmentTarget.environmentId,
          },
          state: 'identified',
          serviceId: 'railway-worker',
          returnedName: 'worker',
        },
      },
    });

    const { action, outcome } = await applyBoundary('environment');

    expectBlockedAndPreserved(action, outcome);
  });

  it('blocks project deletion when another environment uses any scope in the retained provider project', async () => {
    createSibling({
      provider: projectTarget.provider,
      projectId: projectTarget.projectId,
      environmentId: 'ecs-staging',
      services: {},
    });

    const { action, outcome } = await applyBoundary('project');

    expectBlockedAndPreserved(action, outcome);
  });

  it('blocks project deletion when a retained provider resource uses the same project', async () => {
    createSibling({
      provider: 'cloudrun',
      projectId: 'other-cloudrun-project',
      environmentId: 'us-east1',
      services: {},
      previousResource: {
        provider: projectTarget.provider,
        resource: 'backup',
        externalId: 'railway-backup',
        name: 'railway-backup',
        providerScope: {
          projectId: projectTarget.projectId,
          environmentId: 'ecs-staging',
        },
      },
    });

    const { action, outcome } = await applyBoundary('project');

    expectBlockedAndPreserved(action, outcome);
  });

  it.each(['hosting', 'component'] as const)(
    'fails closed when a same-provider %s use has missing durable scope',
    async (source) => {
      const sibling = createSibling(source === 'hosting'
        ? {
            provider: environmentTarget.provider,
            environmentId: environmentTarget.environmentId,
            services: {},
          }
        : {
            provider: 'cloudrun',
            projectId: 'other-cloudrun-project',
            environmentId: 'us-east1',
            services: {},
          });
      if (source === 'component') {
        ctx.repos.components.create({
          environmentId: sibling.id,
          type: 'postgres',
          externalId: 'unknown-scope-database',
          bindings: { provider: environmentTarget.provider },
        });
      }

      const { action, outcome } = await applyBoundary('environment');

      expectBlockedAndPreserved(action, outcome);
    }
  );

  it('allows exact environment cleanup when another local use is scoped to a different provider environment', async () => {
    createSibling({
      provider: environmentTarget.provider,
      projectId: environmentTarget.projectId,
      environmentId: 'railway-staging',
      services: {},
    });

    const { action, outcome } = await applyBoundary('environment');

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: [{ actionId: action.id, status: 'succeeded' }],
      },
    });
    expect(deleteEnvironment).toHaveBeenCalledWith(
      environmentTarget.projectId,
      environmentTarget.environmentId
    );
    expect(deleteProject).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.previousHosting ?? null)
      .toBeNull();
  });

  it('blocks a reviewed boundary that no longer matches the provider teardown contract', async () => {
    const action = boundaryAction('project', environmentTarget);

    const { outcome } = await applyAction(action);

    expectBlockedAndPreserved(action, outcome);
    expect(adapterFactory.getProviderAdapter).not.toHaveBeenCalled();
  });
});
