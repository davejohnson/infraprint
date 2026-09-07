import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { CACHE_OPERATIONS } from '../../domain/services/cache-plan.service.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import type { Component } from '../../domain/entities/component.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Project } from '../../domain/entities/project.entity.js';
import { createUnresolvedDatastoreMutation } from '../../domain/ports/database.port.js';
import { createUnresolvedCacheNetworkMutation } from '../../domain/ports/cache.port.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import '../providers.js';

async function applyAction(params: {
  ctx: CommandContext;
  project: Project;
  environment: Environment;
  spec: ProjectSpec;
  action: PlanAction;
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
      actions: [params.action],
    },
  });
  return executePlanApply(params.ctx, {
    project: params.project,
    spec: params.spec,
    specRevision: 1,
    planId: plan.id,
    confirmActions: [params.action.id],
  });
}

function failedComponent(params: {
  environment: Environment;
  type: string;
  provider: string;
  externalId: string | null;
  providerScope?: Record<string, string>;
}): Component {
  return {
    id: '',
    environmentId: params.environment.id,
    type: params.type,
    externalId: params.externalId,
    bindings: {
      provider: params.provider,
      instanceId: params.externalId,
      ...(params.providerScope ? { providerScope: params.providerScope } : {}),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('failed datastore provisioning identity retention', () => {
  let ctx: CommandContext;
  let project: Project;
  let environment: Environment;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-failed-provision-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'failed-provision-identity',
      defaultPlatform: 'azure-container-apps',
    });
    environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'azure-container-apps' },
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

  it('keeps a failed database receipt failed while retaining its exact identity and previous provider', async () => {
    const previousBindings = {
      provider: 'cloudsql',
      instanceId: 'projects/old/instances/postgres',
      providerScope: { projectId: 'old', region: 'us-central1' },
      connectionUrl: 'postgres://stored-locally',
    };
    const previous = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'projects/old/instances/postgres',
      bindings: previousBindings,
    });
    const externalId = '/subscriptions/sub/resourceGroups/hv-app-staging/providers/Microsoft.DBforPostgreSQL/flexibleServers/app';
    const providerScope = {
      subscriptionId: 'sub',
      resourceGroup: 'hv-app-staging',
      scopeVersion: '1',
    };
    const provision = vi.fn(async () => ({
      component: failedComponent({
        environment,
        type: 'postgres',
        provider: 'azure-postgres',
        externalId,
        providerScope,
      }),
      receipt: {
        success: false,
        message: 'Azure accepted the create but readiness is unknown',
        error: 'readiness timed out',
        data: { mutationAttempted: true },
      },
    }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        configureTarget: vi.fn(),
        provision,
      } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps', region: 'canadacentral' },
          services: {},
          database: { provider: 'azure-postgres' },
        },
      },
    });
    const action: PlanAction = {
      id: 'database:azure-postgres',
      type: 'create',
      resource: { kind: 'database', name: 'postgres', provider: 'azure-postgres' },
      billable: true,
      verified: true,
      reason: 'Create Azure PostgreSQL',
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'failed',
          data: { mutationAttempted: true, recoverableComponentRetained: true },
        }],
      },
    });
    const retained = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres');
    expect(retained).toMatchObject({
      id: previous.id,
      externalId,
      bindings: {
        provider: 'azure-postgres',
        instanceId: externalId,
        providerScope,
        previousProvider: 'cloudsql',
        previousExternalId: previous.externalId,
        previousBindings,
        provisioningIncomplete: true,
      },
    });
  });

  it('retains an unresolved database create marker and blocks a stale retry before adapter resolution', async () => {
    const providerScope = { organizationId: 'org-hypervibe' };
    const unresolvedMutation = createUnresolvedDatastoreMutation(
      'database',
      'failed-provision-identity-staging-postgres',
      providerScope
    );
    const provision = vi.fn(async () => ({
      component: {
        id: '',
        environmentId: environment.id,
        type: 'postgres',
        externalId: null,
        bindings: { provider: 'neon', providerScope, unresolvedMutation },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Component,
      receipt: {
        success: false,
        message: 'Neon create response was lost',
        error: 'socket closed after request transmission',
        data: { mutationAttempted: true, resourceCreated: 'unknown' },
      },
    }));
    const getAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { configureTarget: vi.fn(), provision } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps' },
          services: {},
          database: { provider: 'neon' },
        },
      },
    });
    const action: PlanAction = {
      id: 'database:neon',
      type: 'create',
      resource: { kind: 'database', name: 'postgres', provider: 'neon' },
      billable: true,
      verified: true,
      reason: 'Create Neon PostgreSQL',
    };

    const first = await applyAction({ ctx, project, environment, spec, action });

    expect(first).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ data: { recoverableComponentRetained: true } }],
      },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres')).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'neon',
        providerScope,
        unresolvedMutation,
        provisioningIncomplete: true,
      },
    });

    const second = await applyAction({ ctx, project, environment, spec, action });

    expect(second).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ status: 'blocked' }],
      },
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(getAdapter).toHaveBeenCalledTimes(1);
  });

  it('retains a Railway unresolved cache create marker and blocks a stale retry', async () => {
    const providerScope = { projectId: 'rail-project', environmentId: 'rail-environment' };
    const unresolvedMutation = createUnresolvedDatastoreMutation(
      'cache',
      'failed-provision-identity-staging-redis',
      providerScope
    );
    const provision = vi.fn(async () => ({
      component: {
        id: '',
        environmentId: environment.id,
        type: 'redis',
        externalId: null,
        bindings: { provider: 'railway', providerScope, unresolvedMutation },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Component,
      receipt: {
        success: false,
        message: 'Railway Redis create response was lost',
        error: 'connection reset after mutation',
        data: { mutationAttempted: true, resourceCreated: 'unknown' },
      },
    }));
    const getAdapter = vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        configureTarget: vi.fn(),
        provision,
      } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          cache: { provider: 'railway' },
        },
      },
    });
    const action: PlanAction = {
      id: 'cache:railway',
      type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
      billable: true,
      verified: true,
      reason: 'Create Railway Redis',
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null,
        network: null,
        subnetwork: null,
        tier: null,
        size: null,
      },
    };

    const first = await applyAction({ ctx, project, environment, spec, action });

    expect(first).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ data: { recoverableComponentRetained: true } }],
      },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'railway',
        providerScope,
        unresolvedMutation,
        provisioningIncomplete: true,
      },
    });

    const second = await applyAction({ ctx, project, environment, spec, action });

    expect(second).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ status: 'blocked' }] },
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(getAdapter).toHaveBeenCalledTimes(1);
  });

  it('retains an unresolved cache-network marker across an exact in-place recovery retry', async () => {
    const providerScope = { accountId: '123456789012', region: 'us-west-2' };
    const unresolvedNetworkMutation = createUnresolvedCacheNetworkMutation({
      resourceName: 'failed-provision-identity-staging-redis-hypervibe-cache',
      cacheName: 'failed-provision-identity-staging-redis',
      providerScope,
      networkScope: { vpcId: 'vpc-1', workloadSecurityGroupId: 'sg-workload' },
      ownership: {
        ManagedBy: 'Hypervibe',
        Cache: 'failed-provision-identity-staging-redis',
      },
    });
    const provision = vi.fn(async () => ({
      component: {
        id: '',
        environmentId: environment.id,
        type: 'redis',
        externalId: null,
        bindings: {
          provider: 'elasticache',
          providerScope,
          unresolvedNetworkMutation,
          provisioningIncomplete: true,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Component,
      receipt: {
        success: false,
        message: 'ElastiCache security-group create outcome remains unknown',
        error: 'bounded exact-name recovery found no group',
        data: { networkResourceCreated: 'unknown' },
      },
    }));
    const getAdapter = vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: { configureTarget: vi.fn(), provision } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'ecs' },
          services: {},
          cache: { provider: 'elasticache' },
        },
      },
    });
    const initialAction: PlanAction = {
      id: 'cache:elasticache',
      type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'elasticache' },
      billable: true,
      verified: true,
      reason: 'Create ElastiCache Redis',
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null,
        network: null,
        subnetwork: null,
        tier: null,
        size: null,
      },
    };
    const recoveryAction: PlanAction = {
      ...initialAction,
      type: 'update',
      reason: 'Resume exact unresolved ElastiCache network setup',
      metadata: {
        ...initialAction.metadata,
        recoveryResourceName: unresolvedNetworkMutation.resourceName,
        providerScope,
        recoveryMarker: unresolvedNetworkMutation,
      },
    };

    const first = await applyAction({
      ctx,
      project,
      environment,
      spec,
      action: initialAction,
    });
    const second = await applyAction({
      ctx,
      project,
      environment,
      spec,
      action: recoveryAction,
    });

    expect(first).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ data: { recoverableComponentRetained: true } }] },
    });
    expect(second).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ data: { recoverableComponentRetained: true } }] },
    });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(getAdapter).toHaveBeenCalledTimes(2);
    const secondProvisionCall = provision.mock.calls[1] as unknown[] | undefined;
    expect(secondProvisionCall?.[2]).toMatchObject({
      component: {
        externalId: null,
        bindings: { provider: 'elasticache', unresolvedNetworkMutation },
      },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'elasticache',
        providerScope,
        unresolvedNetworkMutation,
        provisioningIncomplete: true,
      },
    });
  });

  it('blocks a stale cache-network recovery action before adapter resolution or mutation', async () => {
    const providerScope = { accountId: '123456789012', region: 'us-west-2' };
    const currentMarker = createUnresolvedCacheNetworkMutation({
      resourceName: 'failed-provision-identity-staging-redis-hypervibe-cache',
      cacheName: 'failed-provision-identity-staging-redis',
      providerScope,
      networkScope: { vpcId: 'vpc-current', workloadSecurityGroupId: 'sg-current' },
      ownership: {
        ManagedBy: 'Hypervibe',
        Cache: 'failed-provision-identity-staging-redis',
      },
    });
    const plannedMarker = createUnresolvedCacheNetworkMutation({
      ...currentMarker,
      networkScope: { vpcId: 'vpc-reviewed', workloadSecurityGroupId: 'sg-reviewed' },
    });
    ctx.repos.components.create({
      environmentId: environment.id,
      type: 'redis',
      externalId: null,
      bindings: {
        provider: 'elasticache',
        providerScope,
        unresolvedNetworkMutation: currentMarker,
        provisioningIncomplete: true,
      },
    });
    const getAdapter = vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: { configureTarget: vi.fn(), provision: vi.fn() } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'ecs' },
          services: {},
          cache: { provider: 'elasticache' },
        },
      },
    });
    const action: PlanAction = {
      id: 'cache:elasticache',
      type: 'update',
      resource: { kind: 'cache', name: 'redis', provider: 'elasticache' },
      billable: true,
      verified: true,
      reason: 'Resume exact unresolved ElastiCache network setup',
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null,
        network: null,
        subnetwork: null,
        tier: null,
        size: null,
        recoveryResourceName: plannedMarker.resourceName,
        providerScope,
        recoveryMarker: plannedMarker,
      },
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'blocked',
          error: expect.stringContaining('marker changed after planning'),
        }],
      },
    });
    expect(getAdapter).not.toHaveBeenCalled();
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      externalId: null,
      bindings: { unresolvedNetworkMutation: currentMarker, provisioningIncomplete: true },
    });
  });

  it('keeps a failed cache receipt failed while retaining its scoped provider identity', async () => {
    const previousBindings = {
      provider: 'railway',
      instanceId: 'railway-cache-old',
      providerScope: { projectId: 'rail-project', environmentId: 'rail-environment' },
      connectionUrl: 'redis://stored-locally',
    };
    const previous = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'redis',
      externalId: 'railway-cache-old',
      bindings: previousBindings,
    });
    const externalId = '/subscriptions/sub/resourceGroups/hv-app-staging/providers/Microsoft.Cache/redisEnterprise/app';
    const providerScope = {
      subscriptionId: 'sub',
      resourceGroup: 'hv-app-staging',
      scopeVersion: '1',
    };
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        capabilities: {
          supportedCaches: ['redis'],
          supportsTls: true,
          supportsHighAvailability: true,
          supportsPersistence: true,
          serverlessOptimized: false,
        },
        configureTarget: vi.fn(),
        provision: vi.fn(async () => ({
          component: failedComponent({
            environment,
            type: 'redis',
            provider: 'azure-managed-redis',
            externalId,
            providerScope,
          }),
          receipt: {
            success: false,
            message: 'Azure accepted the cache create but readiness is unknown',
            error: 'readiness timed out',
            data: { mutationAttempted: true },
          },
        })),
      } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps' },
          services: {},
          cache: { provider: 'azure-managed-redis' },
        },
      },
    });
    const action: PlanAction = {
      id: 'cache:azure-managed-redis',
      type: 'create',
      resource: { kind: 'cache', name: 'redis', provider: 'azure-managed-redis' },
      billable: true,
      verified: true,
      reason: 'Create Azure Managed Redis',
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null,
        network: null,
        subnetwork: null,
        tier: null,
        size: null,
      },
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{
          actionId: action.id,
          status: 'failed',
          data: { mutationAttempted: true, recoverableComponentRetained: true },
        }],
      },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      id: previous.id,
      externalId,
      bindings: {
        provider: 'azure-managed-redis',
        instanceId: externalId,
        providerScope,
        previousProvider: 'railway',
        previousExternalId: previous.externalId,
        previousBindings,
        provisioningIncomplete: true,
      },
    });
  });

  it('does not retain a failed provision result without full provider scope', async () => {
    const externalId = '/subscriptions/sub/resourceGroups/unscoped/providers/Microsoft.DBforPostgreSQL/flexibleServers/app';
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        provision: vi.fn(async () => ({
          component: failedComponent({
            environment,
            type: 'postgres',
            provider: 'azure-postgres',
            externalId,
            providerScope: { subscriptionId: 'sub' },
          }),
          receipt: { success: false, message: 'failed', error: 'scope unavailable' },
        })),
      } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps' },
          services: {},
          database: { provider: 'azure-postgres' },
        },
      },
    });
    const action: PlanAction = {
      id: 'database:azure-postgres',
      type: 'create',
      resource: { kind: 'database', name: 'postgres', provider: 'azure-postgres' },
      billable: true,
      verified: true,
      reason: 'Create Azure PostgreSQL',
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ status: 'failed' }] },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres')).toBeNull();
  });

  it('blocks a stale database create before resolving or mutating an adapter', async () => {
    const getAdapter = vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { provision: vi.fn() } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps' },
          services: {},
          database: { provider: 'azure-postgres' },
        },
      },
    });
    const action: PlanAction = {
      id: 'database:rds',
      type: 'create',
      resource: { kind: 'database', name: 'postgres', provider: 'rds' },
      billable: true,
      verified: true,
      reason: 'stale database action',
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ actionId: action.id, status: 'blocked' }] },
    });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('retains an uncertain exact in-place cache update for reconciliation instead of forced deletion', async () => {
    const externalId = '/subscriptions/sub/resourceGroups/hv-app-staging/providers/Microsoft.Cache/redisEnterprise/app';
    const providerScope = {
      subscriptionId: 'sub',
      resourceGroup: 'hv-app-staging',
      scopeVersion: '1',
    };
    ctx.repos.components.create({
      environmentId: environment.id,
      type: 'redis',
      externalId,
      bindings: {
        provider: 'azure-managed-redis',
        instanceId: externalId,
        providerScope,
        connectionUrl: 'rediss://stored-locally',
      },
    });
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        configureTarget: vi.fn(),
        provision: vi.fn(async () => ({
          component: failedComponent({
            environment,
            type: 'redis',
            provider: 'azure-managed-redis',
            externalId,
            providerScope,
          }),
          receipt: {
            success: false,
            message: 'Azure accepted the exact resize but read-back is unknown',
            error: 'readiness timed out',
            data: { mutationAttempted: true },
          },
        })),
      } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps' },
          services: {},
          cache: { provider: 'azure-managed-redis', size: '2gb' },
        },
      },
    });
    const action: PlanAction = {
      id: 'cache:azure-managed-redis',
      type: 'update',
      resource: { kind: 'cache', name: 'redis', provider: 'azure-managed-redis' },
      billable: true,
      verified: true,
      reason: 'Resize the exact Azure cache',
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null,
        network: null,
        subnetwork: null,
        tier: null,
        size: '2gb',
      },
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ status: 'failed' }] },
    });
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      externalId,
      bindings: {
        provider: 'azure-managed-redis',
        providerScope,
        connectionUrl: 'rediss://stored-locally',
        reconciliationIncomplete: true,
      },
    });
  });

  it.each([
    {
      label: 'different external id',
      returnedExternalId: '/subscriptions/sub/resourceGroups/hv-app-staging/providers/Microsoft.Cache/redisEnterprise/other',
      returnedScope: {
        subscriptionId: 'sub',
        resourceGroup: 'hv-app-staging',
        scopeVersion: '1',
      },
    },
    {
      label: 'different provider scope',
      returnedExternalId: '/subscriptions/sub/resourceGroups/hv-app-staging/providers/Microsoft.Cache/redisEnterprise/app',
      returnedScope: {
        subscriptionId: 'sub',
        resourceGroup: 'other-resource-group',
        scopeVersion: '1',
      },
    },
  ])('does not retarget an existing cache after a failed update returns a $label', async ({
    returnedExternalId,
    returnedScope,
  }) => {
    const externalId = '/subscriptions/sub/resourceGroups/hv-app-staging/providers/Microsoft.Cache/redisEnterprise/app';
    const providerScope = {
      subscriptionId: 'sub',
      resourceGroup: 'hv-app-staging',
      scopeVersion: '1',
    };
    const existing = ctx.repos.components.create({
      environmentId: environment.id,
      type: 'redis',
      externalId,
      bindings: {
        provider: 'azure-managed-redis',
        instanceId: externalId,
        providerScope,
        connectionUrl: 'rediss://stored-locally',
      },
    });
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        configureTarget: vi.fn(),
        provision: vi.fn(async () => ({
          component: failedComponent({
            environment,
            type: 'redis',
            provider: 'azure-managed-redis',
            externalId: returnedExternalId,
            providerScope: returnedScope,
          }),
          receipt: {
            success: false,
            message: 'update failed with an untrusted identity',
            error: 'provider response did not match the bound cache',
          },
        })),
      } as never,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'azure-container-apps' },
          services: {},
          cache: { provider: 'azure-managed-redis', size: '2gb' },
        },
      },
    });
    const action: PlanAction = {
      id: 'cache:azure-managed-redis',
      type: 'update',
      resource: { kind: 'cache', name: 'redis', provider: 'azure-managed-redis' },
      billable: true,
      verified: true,
      reason: 'Resize the exact Azure cache',
      metadata: {
        operation: CACHE_OPERATIONS.ensure,
        region: null,
        network: null,
        subnetwork: null,
        tier: null,
        size: '2gb',
      },
    };

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: false, receipts: [{ status: 'failed' }] },
    });
    const receipt = outcome.kind === 'executed' ? outcome.result.receipts[0] : undefined;
    expect(receipt?.data).not.toHaveProperty('recoverableComponentRetained');
    expect(ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis')).toEqual(existing);
  });
});

describe('retained hosting create recovery', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-hosting-create-recovery-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
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

  it('blocks a stale service-create action before resolving or mutating a hosting adapter', async () => {
    const project = ctx.repos.projects.create({
      name: 'hosting-create-recovery',
      defaultPlatform: 'railway',
    });
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-environment',
        services: {},
        serviceCreateRecovery: {
          web: {
            provider: 'railway',
            operation: 'create',
            resourceName: 'web-staging',
            providerScope: { projectId: 'rail-project', environmentId: 'rail-environment' },
            state: 'unresolved',
          },
        },
      },
    });
    ctx.repos.services.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
        },
      },
    });
    const action: PlanAction = {
      id: 'service:web',
      type: 'create',
      resource: { kind: 'service', name: 'web', provider: 'railway' },
      verified: true,
      reason: 'Stale plan says the service is absent',
    };
    const getProviderAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');

    const outcome = await applyAction({ ctx, project, environment, spec, action });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: [{ actionId: 'service:web', status: 'blocked' }],
      },
    });
    expect(getProviderAdapter).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toMatchObject({
      services: {},
      serviceCreateRecovery: { web: { state: 'unresolved' } },
    });
  });
});
