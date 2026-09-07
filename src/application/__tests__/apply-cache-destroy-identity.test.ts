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
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { CACHE_OPERATIONS } from '../../domain/services/cache-plan.service.js';
import { bindingIdentityFingerprint } from '../../domain/services/binding-identity.js';

describe('cache destroy apply identity', () => {
  let ctx: CommandContext;
  let project: Project;
  let environment: Environment;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-cache-destroy-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({ name: 'cache-destroy-identity', defaultPlatform: 'railway' });
    environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rail-project' },
    });
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
  });

  it('blocks when a secondary destructive binding changes after planning', async () => {
    const reviewedBindings = {
      provider: 'railway',
      providerScope: { projectId: 'rail-project' },
      resourceKind: 'service',
      volumeId: 'volume-reviewed',
      connectionUrl: '${{redis.REDIS_URL}}',
    };
    const component = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'redis',
      externalId: 'redis-reviewed',
      bindings: reviewedBindings,
    });
    const action: PlanAction = {
      id: 'cache:railway:destroy',
      type: 'destroy',
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
      verified: true,
      reason: 'Cache destroy identity regression fixture',
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: CACHE_OPERATIONS.destroy,
        externalId: 'redis-reviewed',
        providerScope: { projectId: 'rail-project' },
        bindingsFingerprint: bindingIdentityFingerprint(reviewedBindings),
      },
    };
    ctx.repos.components.updateBindings(component.id, { volumeId: 'volume-rebound' });
    const getCacheAdapter = vi.spyOn(adapterFactory, 'getCacheAdapter');
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: { staging: { hosting: { provider: 'railway' }, services: {} } },
    });
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

    const outcome = await executePlanApply(ctx, {
      project,
      spec,
      specRevision: 1,
      planId: plan.id,
      confirmActions: [action.id],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Cache destroy target changed after planning',
        }],
      },
    });
    expect(getCacheAdapter).not.toHaveBeenCalled();
  });

  it('blocks when the reviewed cache binding disappeared after planning', async () => {
    const reviewedBindings = {
      provider: 'railway',
      providerScope: { projectId: 'rail-project' },
      resourceKind: 'service',
      volumeId: 'volume-reviewed',
    };
    const action: PlanAction = {
      id: 'cache:railway:destroy',
      type: 'destroy',
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
      verified: true,
      reason: 'Cache destroy identity regression fixture',
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: CACHE_OPERATIONS.destroy,
        externalId: 'redis-reviewed',
        providerScope: { projectId: 'rail-project' },
        bindingsFingerprint: bindingIdentityFingerprint(reviewedBindings),
      },
    };
    const getCacheAdapter = vi.spyOn(adapterFactory, 'getCacheAdapter');
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: { staging: { hosting: { provider: 'railway' }, services: {} } },
    });
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

    const outcome = await executePlanApply(ctx, {
      project,
      spec,
      specRevision: 1,
      planId: plan.id,
      confirmActions: [action.id],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          message: 'Cache destroy target disappeared after planning',
        }],
      },
    });
    expect(getCacheAdapter).not.toHaveBeenCalled();
  });

  it('blocks cache provisioning when desired placement changed after planning', async () => {
    const action: PlanAction = {
      id: 'cache:memorystore',
      type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'memorystore' },
      verified: true,
      reason: 'Create cache',
      billable: true,
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: 'us-central1',
        network: 'default',
        subnetwork: 'default',
        tier: 'BASIC',
        size: '1gb',
      },
    };
    const getCacheAdapter = vi.spyOn(adapterFactory, 'getCacheAdapter');
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'cloudrun' },
          services: {},
          cache: {
            provider: 'memorystore', region: 'us-central1', network: 'default',
            subnetwork: 'default', tier: 'BASIC', size: '2gb',
          },
        },
      },
    });
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan', environmentName: environment.name, specRevision: 1,
        observedFingerprint: null, actions: [action],
      },
    });

    const outcome = await executePlanApply(ctx, {
      project, spec, specRevision: 1, planId: plan.id, confirmActions: [action.id],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { receipts: [{ actionId: action.id, status: 'blocked' }] },
    });
    expect(getCacheAdapter).not.toHaveBeenCalled();
  });

  it('passes exact cache placement to the adapter and persists verified runtime networking', async () => {
    const placement = {
      region: 'us-central1', network: 'default', subnetwork: 'default',
      tier: 'BASIC', size: '1gb',
    };
    const runtimeNetwork = {
      provider: 'cloudrun',
      projectId: 'gcp-project',
      region: 'us-central1',
      network: 'projects/gcp-project/global/networks/default',
      subnetwork: 'projects/gcp-project/regions/us-central1/subnetworks/default',
      egress: 'PRIVATE_RANGES_ONLY',
    };
    const action: PlanAction = {
      id: 'cache:memorystore', type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'memorystore' },
      verified: true, reason: 'Create cache', billable: true,
      metadata: { operation: CACHE_OPERATIONS.ensure, ...placement },
    };
    const configureTarget = vi.fn();
    const provision = vi.fn(async () => ({
      component: {
        id: '', environmentId: environment.id, type: 'redis' as const,
        externalId: 'projects/gcp-project/locations/us-central1/instances/cache',
        bindings: {
          provider: 'memorystore',
          providerScope: { projectId: 'gcp-project', region: 'us-central1' },
          runtimeNetwork,
        },
        createdAt: new Date(), updatedAt: new Date(),
      },
      receipt: { success: true, message: 'created' },
    }));
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'memorystore',
        capabilities: {
          supportedCaches: ['redis'], supportsTls: false, supportsHighAvailability: true,
          supportsPersistence: true, serverlessOptimized: false,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        configureTarget, provision,
        getConnectionUrl: async () => null, destroy: async () => ({ success: true, message: 'deleted' }),
        observeCache: async () => null,
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1, project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'cloudrun' }, services: {},
          cache: { provider: 'memorystore', ...placement },
        },
      },
    });
    const plan = ctx.repos.runs.create({
      projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: {
        kind: 'hv_plan', environmentName: environment.name, specRevision: 1,
        observedFingerprint: null, actions: [action],
      },
    });

    const outcome = await executePlanApply(ctx, {
      project, spec, specRevision: 1, planId: plan.id, confirmActions: [action.id],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { receipts: [{ actionId: action.id, status: 'succeeded' }] },
    });
    expect(configureTarget).toHaveBeenCalledWith({ projectName: project.name, ...placement });
    expect(provision).toHaveBeenCalledWith('redis', expect.objectContaining({ id: environment.id }), {
      projectName: project.name,
      resourceName: `${project.name}-staging-redis`,
      component: null,
      ...placement,
    });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.cacheNetwork)
      .toEqual(runtimeNetwork);
  });

  it('retains a recoverable component but fails when a network-required cache omits runtime metadata', async () => {
    const action: PlanAction = {
      id: 'cache:memorystore', type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'memorystore' },
      verified: true, reason: 'Create cache', billable: true,
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null, network: null, subnetwork: null, tier: null, size: null,
      },
    };
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'memorystore',
        capabilities: {
          supportedCaches: ['redis'], supportsTls: false, supportsHighAvailability: true,
          supportsPersistence: true, serverlessOptimized: false, requiresRuntimeNetwork: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        provision: async () => ({
          component: {
            id: '', environmentId: environment.id, type: 'redis' as const,
            externalId: 'projects/gcp-project/locations/us-central1/instances/recover-me',
            bindings: {
              provider: 'memorystore',
              providerScope: { projectId: 'gcp-project', region: 'us-central1' },
            },
            createdAt: new Date(), updatedAt: new Date(),
          },
          receipt: { success: true, message: 'provider accepted create' },
        }),
        getConnectionUrl: async () => null, destroy: async () => ({ success: true, message: 'deleted' }),
        observeCache: async () => null,
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1, project: project.name,
      environments: {
        staging: { hosting: { provider: 'cloudrun' }, services: {}, cache: { provider: 'memorystore' } },
      },
    });
    const plan = ctx.repos.runs.create({
      projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: {
        kind: 'hv_plan', environmentName: environment.name, specRevision: 1,
        observedFingerprint: null, actions: [action],
      },
    });

    const outcome = await executePlanApply(ctx, {
      project, spec, specRevision: 1, planId: plan.id, confirmActions: [action.id],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        receipts: [{
          actionId: action.id,
          status: 'failed',
          data: { recoverableComponentRetained: true },
        }],
      },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')?.externalId)
      .toContain('recover-me');
  });

  it('clears stale private-cache networking when provisioning a non-network cache', async () => {
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      cacheNetwork: {
        provider: 'cloudrun', projectId: 'gcp-project', region: 'us-central1',
        network: 'projects/gcp-project/global/networks/default',
        subnetwork: 'projects/gcp-project/regions/us-central1/subnetworks/default',
        egress: 'PRIVATE_RANGES_ONLY',
      },
    });
    const action: PlanAction = {
      id: 'cache:railway', type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
      verified: true, reason: 'Replace cache', billable: true,
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null, network: null, subnetwork: null, tier: null, size: null,
      },
    };
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedCaches: ['redis'], supportsTls: false, supportsHighAvailability: false,
          supportsPersistence: true, serverlessOptimized: false,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        provision: async () => ({
          component: {
            id: '', environmentId: environment.id, type: 'redis' as const,
            externalId: 'railway-cache',
            bindings: { provider: 'railway', providerScope: { projectId: 'rail-project' } },
            createdAt: new Date(), updatedAt: new Date(),
          },
          receipt: { success: true, message: 'created' },
        }),
        getConnectionUrl: async () => null, destroy: async () => ({ success: true, message: 'deleted' }),
        observeCache: async () => null,
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1, project: project.name,
      environments: {
        staging: { hosting: { provider: 'railway' }, services: {}, cache: { provider: 'railway' } },
      },
    });
    const plan = ctx.repos.runs.create({
      projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: {
        kind: 'hv_plan', environmentName: environment.name, specRevision: 1,
        observedFingerprint: null, actions: [action],
      },
    });

    await executePlanApply(ctx, {
      project, spec, specRevision: 1, planId: plan.id, confirmActions: [action.id],
    });

    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.cacheNetwork).toBeNull();
  });
});
