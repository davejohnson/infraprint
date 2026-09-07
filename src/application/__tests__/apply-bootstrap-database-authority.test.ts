import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { executePlanApply } from '../apply-plan.js';
import { createCommandContext, type CommandContext } from '../context.js';
import '../providers.js';

describe('apply bootstrap database authority', () => {
  let directory: string;
  let ctx: CommandContext;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-bootstrap-database-authority-'));
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
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { label: 'a reviewed service action', actionType: 'create' as const, alwaysRunBootstrap: false },
    { label: 'an all-noop forced deploy', actionType: 'noop' as const, alwaysRunBootstrap: true },
  ])('does not resolve a database adapter during $label', async ({ actionType, alwaysRunBootstrap }) => {
    const project = ctx.repos.projects.create({
      name: `bootstrap-database-authority-${actionType}`,
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
      },
    });
    ctx.repos.components.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'rail-database',
      bindings: {
        provider: 'railway',
        pluginName: 'postgres-db',
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          database: { provider: 'railway', engine: 'postgres' },
        },
      },
    });
    const action: PlanAction = {
      id: `service:web:${actionType}`,
      type: actionType,
      resource: { kind: 'service', name: 'web', provider: 'railway' },
      verified: true,
      reason: actionType === 'noop' ? 'Service is already converged' : 'Create the reviewed service',
    };
    const databaseAction: PlanAction = {
      id: 'database:postgres:noop',
      type: 'noop',
      resource: { kind: 'database', name: 'postgres', provider: 'railway' },
      verified: true,
      reason: 'The bound database is already converged',
    };
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'staging',
        specRevision: 1,
        observedFingerprint: null,
        actions: [databaseAction, action],
      },
    });
    const deploy = vi.fn<IHostingAdapter['deploy']>(async (service, _environment, envVars) => {
      expect(envVars).toMatchObject({
        DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
        DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
      });
      return {
        serviceId: `rail-${service.name}`,
        externalId: `rail-${service.name}`,
        url: `https://${service.name}.example.com`,
        status: 'deployed',
        receipt: {
          success: true,
          message: 'deployed',
          data: { environmentId: 'rail-environment' },
        },
      };
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['nixpacks'],
          supportsAutoWiring: true,
          supportsHealthChecks: true,
          supportsCronSchedule: true,
          supportsReleaseCommand: true,
          supportsMultiEnvironment: true,
          managedTls: true,
          supportsAutoScaling: false,
          supportsObserve: false,
        },
        async connect() {},
        async verify() {
          return { success: true };
        },
        async ensureProject() {
          throw new Error('service and forced-deploy bootstrap must not ensure a project');
        },
        deploy,
        async setEnvVars() {
          return { success: true, message: 'vars synced' };
        },
        async getDeployStatus() {
          return { status: 'deployed' };
        },
      } as IHostingAdapter,
    });
    const databaseAdapterSpy = vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockImplementation(async () => {
      throw new Error('database adapters may be resolved only by database actions');
    });

    const outcome = await executePlanApply(ctx, {
      project,
      spec,
      specRevision: 1,
      planId: plan.id,
      confirmActions: [],
      alwaysRunBootstrap,
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: true },
    });
    expect(deploy).toHaveBeenCalledOnce();
    expect(databaseAdapterSpy).not.toHaveBeenCalled();
  });
});
