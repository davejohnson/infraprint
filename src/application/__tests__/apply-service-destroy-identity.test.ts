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
import type { Service } from '../../domain/entities/service.entity.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type {
  HostingServiceDeleteOptions,
  HostingServiceDeleteScope,
} from '../../domain/ports/provider.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { bindingIdentityFingerprint } from '../../domain/services/binding-identity.js';

const target = {
  provider: 'railway',
  projectId: 'rail-project',
  environmentId: 'rail-environment',
  serviceName: 'web',
  serviceId: 'rail-service-web',
};

type DestroyIdentity = typeof target;
type DeleteService = (
  serviceId: string,
  scope: HostingServiceDeleteScope,
  options: HostingServiceDeleteOptions
) => Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;

function projectSpec(): ProjectSpec {
  return projectSpecSchema.parse({
    version: 1,
    project: 'service-destroy-identity',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: {},
      },
    },
  });
}

function destroyAction(
  overrides: Partial<DestroyIdentity> & { bindingsFingerprint?: string } = {}
): PlanAction {
  const identity = { ...target, ...overrides };
  return {
    id: `service:${identity.serviceName}:destroy`,
    type: 'destroy',
    resource: {
      kind: 'service',
      name: identity.serviceName,
      provider: identity.provider,
    },
    verified: true,
    reason: 'Hosting service destroy identity regression fixture',
    requiresConfirm: true,
    metadata: {
      operation: 'hostingServiceDestroy',
      externalId: identity.serviceId,
      deleteScope: 'environment',
      providerScope: {
        projectId: identity.projectId,
        environmentId: identity.environmentId,
      },
      bindingsFingerprint: overrides.bindingsFingerprint ?? bindingIdentityFingerprint({
        provider: identity.provider,
        projectId: identity.projectId,
        environmentId: identity.environmentId,
        serviceName: identity.serviceName,
        serviceId: identity.serviceId,
      }),
    },
  };
}

function taskDestroyAction(
  overrides: Partial<DestroyIdentity> & { deleteScope?: 'environment' | 'project' } = {}
): PlanAction {
  const identity = { ...target, ...overrides };
  const deleteScope = overrides.deleteScope ?? 'environment';
  const serviceName = 'hv-task-cleanup';
  const serviceId = 'rail-task-cleanup';
  const providerScope = {
    projectId: identity.projectId,
    ...(deleteScope === 'environment' ? { environmentId: identity.environmentId } : {}),
  };
  return {
    id: `service:${serviceName}:destroy`,
    type: 'destroy',
    resource: {
      kind: 'service',
      name: serviceName,
      provider: identity.provider,
    },
    verified: true,
    reason: 'Leftover Hypervibe one-off task service',
    metadata: {
      operation: 'taskServiceCleanup',
      externalId: serviceId,
      deleteScope,
      providerScope,
      bindingsFingerprint: bindingIdentityFingerprint({
        provider: identity.provider,
        ...providerScope,
        serviceName,
        serviceId,
      }),
    },
  };
}

function observedState(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    provider: target.provider,
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: target.projectId,
    environmentId: target.environmentId,
    services: [{
      name: target.serviceName,
      externalId: target.serviceId,
      workloadKind: 'web',
      customDomains: [],
      config: {},
      envVarKeys: [],
      envVarHashes: {},
      status: 'running',
    }],
    databases: [],
    partial: false,
    warnings: [],
    completeness: {
      project: 'complete',
      environment: 'complete',
      services: 'complete',
      databases: 'complete',
    },
    ...overrides,
  };
}

describe('hosting service destroy apply identity', () => {
  let ctx: CommandContext;
  let project: Project;
  let environment: Environment;
  let service: Service;
  let freshObservation: ObservedState | null;
  let directory: string;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-service-destroy-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'service-destroy-identity',
      defaultPlatform: target.provider,
    });
    environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: target.provider,
        projectId: target.projectId,
        environmentId: target.environmentId,
        services: { [target.serviceName]: { serviceId: target.serviceId } },
      },
    });
    service = ctx.repos.services.create({
      projectId: project.id,
      name: target.serviceName,
    });
    freshObservation = observedState();

    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async () => ({
      observed: freshObservation,
      warnings: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  async function applyAction(action: PlanAction, afterPlan?: () => void) {
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: environment.name,
        specRevision: 1,
        observedFingerprint: null,
        actions: [action],
      },
    });
    afterPlan?.();
    return executePlanApply(ctx, {
      project,
      spec: projectSpec(),
      specRevision: 1,
      planId: plan.id,
      confirmActions: [action.id],
    });
  }

  function mockHostingDelete(implementation: DeleteService) {
    const deleteService = vi.fn(implementation);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: { name: target.provider, deleteService } as never,
    });
    return deleteService;
  }

  function expectTargetPreserved() {
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toMatchObject({
      services: { [target.serviceName]: { serviceId: target.serviceId } },
    });
    expect(ctx.repos.services.findById(service.id)).toMatchObject({
      id: service.id,
      name: target.serviceName,
    });
  }

  it('preserves the target binding and logical service when provider deletion fails', async () => {
    const action = destroyAction();
    const deleteService = mockHostingDelete(async () => ({
      success: false,
      error: 'provider deletion could not be verified',
    }));

    const outcome = await applyAction(action);

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ actionId: action.id, status: 'failed' }],
      },
    });
    expect(deleteService).toHaveBeenCalledWith(
      target.serviceId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: true }
    );
    expectTargetPreserved();
  });

  it.each(['current', 'previousHosting'] as const)(
    'does not authorize remote mutation when a %s sibling shares the service id',
    async (source) => {
      const siblingBindings = source === 'current'
        ? {
            provider: target.provider,
            projectId: target.projectId,
            environmentId: 'rail-production',
            services: { [target.serviceName]: { serviceId: target.serviceId } },
          }
        : {
            provider: 'vercel',
            projectId: 'vercel-project',
            services: {},
            previousHosting: {
              provider: target.provider,
              projectId: target.projectId,
              environmentId: 'rail-production',
              services: { [target.serviceName]: { serviceId: target.serviceId } },
            },
          };
      const sibling = ctx.repos.environments.create({
        projectId: project.id,
        name: 'production',
        platformBindings: siblingBindings,
      });
      let remoteMutations = 0;
      const deleteService = mockHostingDelete(async (_serviceId, _scope, options) => {
        if (options.allowMutation) remoteMutations += 1;
        return {
          success: false,
          error: 'exact target remains present while local sharing forbids deletion',
        };
      });

      const outcome = await applyAction(destroyAction());

      expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(deleteService).toHaveBeenCalledWith(
        target.serviceId,
        { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
        { allowMutation: false }
      );
      expect(remoteMutations).toBe(0);
      expectTargetPreserved();
      const persistedSibling = ctx.repos.environments.findById(sibling.id)?.platformBindings as Record<string, unknown>;
      const sharedSource = source === 'current'
        ? persistedSibling
        : persistedSibling.previousHosting as Record<string, unknown>;
      expect(sharedSource).toMatchObject({
        services: { [target.serviceName]: { serviceId: target.serviceId } },
      });
    }
  );

  it('does not authorize mutation when another Hypervibe project binds the same provider resource', async () => {
    const otherProject = ctx.repos.projects.create({
      name: 'other-service-destroy-project',
      defaultPlatform: target.provider,
    });
    const sibling = ctx.repos.environments.create({
      projectId: otherProject.id,
      name: 'production',
      platformBindings: {
        provider: target.provider,
        projectId: target.projectId,
        environmentId: 'rail-production',
        services: { api: { serviceId: target.serviceId } },
      },
    });
    let remoteMutations = 0;
    const deleteService = mockHostingDelete(async (_serviceId, _scope, options) => {
      if (options.allowMutation) remoteMutations += 1;
      return {
        success: false,
        error: 'exact target remains present while local sharing forbids deletion',
      };
    });

    const outcome = await applyAction(destroyAction());

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deleteService).toHaveBeenCalledWith(
      target.serviceId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: false }
    );
    expect(remoteMutations).toBe(0);
    expectTargetPreserved();
    expect(ctx.repos.environments.findById(sibling.id)?.platformBindings).toMatchObject({
      services: { api: { serviceId: target.serviceId } },
    });
  });

  it.each(['identified', 'mismatched'] as const)(
    'does not authorize mutation when a %s service-create recovery marker retains the same provider resource',
    async (state) => {
      const resourceName = 'recovered-web';
      const sibling = ctx.repos.environments.create({
        projectId: project.id,
        name: `recovery-${state}`,
        platformBindings: {
          provider: target.provider,
          projectId: target.projectId,
          environmentId: `rail-recovery-${state}`,
          services: {},
          serviceCreateRecovery: {
            recovered: {
              provider: target.provider,
              operation: 'create',
              resourceName,
              providerScope: {
                projectId: target.projectId,
                environmentId: `rail-recovery-${state}`,
              },
              state,
              serviceId: target.serviceId,
              returnedName: state === 'identified' ? resourceName : 'unexpected-web',
            },
          },
        },
      });
      let remoteMutations = 0;
      const deleteService = mockHostingDelete(async (_serviceId, _scope, options) => {
        if (options.allowMutation) remoteMutations += 1;
        return {
          success: false,
          error: 'exact target remains present while recovery state forbids deletion',
        };
      });

      const outcome = await applyAction(destroyAction());

      expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
      expect(deleteService).toHaveBeenCalledWith(
        target.serviceId,
        { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
        { allowMutation: false }
      );
      expect(remoteMutations).toBe(0);
      expectTargetPreserved();
      expect(ctx.repos.environments.findById(sibling.id)?.platformBindings).toMatchObject({
        serviceCreateRecovery: {
          recovered: { state, serviceId: target.serviceId },
        },
      });
    }
  );

  it.each([
    ['service binding', {
      provider: target.provider,
      projectId: target.projectId,
      environmentId: 'rail-malformed-binding',
      services: { orphan: { url: 'https://example.invalid' } },
    }],
    ['service-create recovery marker', {
      provider: 'vercel',
      projectId: 'other-provider-project',
      services: {},
      previousHosting: {
        provider: target.provider,
        projectId: target.projectId,
        services: {},
        serviceCreateRecovery: {
          orphan: {
            provider: target.provider,
            operation: 'create',
            resourceName: 'orphan',
            providerScope: { projectId: target.projectId },
            state: 'identified',
          },
        },
      },
    }],
  ])('fails closed for malformed same-provider %s state', async (_label, platformBindings) => {
    ctx.repos.environments.create({
      projectId: project.id,
      name: `malformed-${_label.replaceAll(' ', '-')}`,
      platformBindings,
    });
    let remoteMutations = 0;
    const deleteService = mockHostingDelete(async (_serviceId, _scope, options) => {
      if (options.allowMutation) remoteMutations += 1;
      return { success: false, error: 'local identity state is incomplete' };
    });

    const outcome = await applyAction(destroyAction());

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deleteService).toHaveBeenCalledWith(
      target.serviceId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: false }
    );
    expect(remoteMutations).toBe(0);
    expectTargetPreserved();
  });

  it.each([
    ['service binding', {
      provider: target.provider,
      projectId: 'contradictory-rail-project',
      environmentId: 'rail-contradictory-binding',
      services: { api: { serviceId: target.serviceId } },
    }],
    ['service-create recovery marker', {
      provider: target.provider,
      projectId: target.projectId,
      environmentId: 'rail-contradictory-recovery',
      services: {},
      serviceCreateRecovery: {
        recovered: {
          provider: target.provider,
          operation: 'create',
          resourceName: 'recovered-web',
          providerScope: {
            projectId: 'contradictory-rail-project',
            environmentId: 'rail-contradictory-recovery',
          },
          state: 'identified',
          serviceId: target.serviceId,
          returnedName: 'recovered-web',
        },
      },
    }],
  ])('does not authorize mutation when a same-provider %s has the same id under a contradictory project scope', async (_label, platformBindings) => {
    ctx.repos.environments.create({
      projectId: project.id,
      name: `contradictory-${_label.replaceAll(' ', '-')}`,
      platformBindings,
    });
    let remoteMutations = 0;
    const deleteService = mockHostingDelete(async (_serviceId, _scope, options) => {
      if (options.allowMutation) remoteMutations += 1;
      return { success: false, error: 'local provider identity scope is contradictory' };
    });

    const outcome = await applyAction(destroyAction());

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deleteService).toHaveBeenCalledWith(
      target.serviceId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: false }
    );
    expect(remoteMutations).toBe(0);
    expectTargetPreserved();
  });

  it('preserves local identity when aggregate absence conflicts with the adapter exact preflight', async () => {
    freshObservation = observedState({ services: [] });
    let remoteMutations = 0;
    const deleteService = mockHostingDelete(async (_serviceId, _scope, options) => {
      if (options.allowMutation) remoteMutations += 1;
      return { success: false, error: 'exact provider instance remains present' };
    });

    const outcome = await applyAction(destroyAction());

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(deleteService).toHaveBeenCalledWith(
      target.serviceId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: false }
    );
    expect(remoteMutations).toBe(0);
    expectTargetPreserved();
  });

  it('requires exact adapter-confirmed absence when aggregate observation omits a task service', async () => {
    freshObservation = observedState({ services: [] });
    const action = taskDestroyAction();
    const deleteService = vi.fn(async () => ({ success: true }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: target.provider, deleteService } as never,
    });

    const outcome = await applyAction(action);

    expect(deleteService).toHaveBeenCalledWith(
      action.metadata?.externalId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: false }
    );
    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ actionId: action.id, status: 'failed' }],
      },
    });
  });

  it('accepts exact adapter-confirmed absence for an omitted environment-scoped task service', async () => {
    freshObservation = observedState({ services: [] });
    const action = taskDestroyAction();
    const deleteService = vi.fn(async () => ({ success: true, alreadyAbsent: true }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: target.provider, deleteService } as never,
    });

    const outcome = await applyAction(action);

    expect(deleteService).toHaveBeenCalledWith(
      action.metadata?.externalId,
      { scope: 'environment', projectId: target.projectId, environmentId: target.environmentId },
      { allowMutation: false }
    );
    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: [{ actionId: action.id, status: 'succeeded' }],
      },
    });
  });

  it('blocks aggregate-absent project-scoped task cleanup before adapter resolution', async () => {
    const projectId = 'vercel-project';
    const action = taskDestroyAction({ provider: 'vercel', projectId, deleteScope: 'project' });
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      provider: 'vercel',
      projectId,
    });
    freshObservation = observedState({
      provider: 'vercel',
      projectId,
      environmentId: undefined,
      services: [],
    });
    const getProviderAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');

    const outcome = await applyAction(action);

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Project-scoped task service absence requires exact provider verification',
        }],
      },
    });
    expect(getProviderAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ['provider', { provider: 'vercel' }],
    ['project', { projectId: 'rail-project-rebound' }],
    ['environment', { environmentId: 'rail-environment-rebound' }],
    ['service id', { services: { [target.serviceName]: { serviceId: 'rail-service-rebound' } } }],
  ])('blocks before adapter resolution when the current %s binding changes after planning', async (_label, patch) => {
    const action = destroyAction();
    const getHostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');

    const outcome = await applyAction(action, () => {
      ctx.repos.environments.updatePlatformBindings(environment.id, patch);
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Service destroy target changed after planning',
        }],
      },
    });
    expect(getHostingAdapter).not.toHaveBeenCalled();
    expect(ctx.repos.services.findById(service.id)).not.toBeNull();
  });

  it.each([
    ['scope', destroyAction({ environmentId: 'forged-environment' })],
    ['fingerprint', destroyAction({ bindingsFingerprint: 'f'.repeat(64) })],
    ['service name', destroyAction({ serviceName: 'worker' })],
  ])('blocks a forged %s before adapter resolution', async (_label, action) => {
    const getHostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');

    const outcome = await applyAction(action);

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(getHostingAdapter).not.toHaveBeenCalled();
    expectTargetPreserved();
  });

  it.each([
    ['null', null],
    ['incomplete', observedState({
      partial: true,
      completeness: { services: 'unknown' },
    })],
    ['project mismatch', observedState({ projectId: 'other-project' })],
    ['environment mismatch', observedState({ environmentId: 'other-environment' })],
  ] as Array<[string, ObservedState | null]>)(
    'blocks when the fresh service observation is %s',
    async (_label, observation) => {
      freshObservation = observation;
      const action = destroyAction();
      const getHostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');

      const outcome = await applyAction(action);

      expect(outcome).toMatchObject({
        kind: 'executed',
        result: {
          success: false,
          receipts: [{
            actionId: action.id,
            status: 'blocked',
            message: 'Service destroy observation is incomplete',
          }],
        },
      });
      expect(getHostingAdapter).not.toHaveBeenCalled();
      expectTargetPreserved();
    }
  );
});
