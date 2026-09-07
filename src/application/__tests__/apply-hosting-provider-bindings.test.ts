import { mkdtempSync } from 'node:fs';
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

describe('hosting project provider bindings', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-hosting-bindings-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
  });

  it('persists safe provider-owned project identity beside canonical hosting fields', async () => {
    const project = ctx.repos.projects.create({ name: 'aws-network-app', defaultPlatform: 'ecs' });
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {},
    });
    const clusterArn = 'arn:aws:ecs:us-west-2:123456789012:cluster/hv-aws-network-app-production';
    const awsNetwork = {
      accountId: '123456789012',
      region: 'us-west-2',
      vpcId: 'vpc-default',
      subnetIds: ['subnet-a', 'subnet-b'],
      workloadSecurityGroupId: 'sg-workloads',
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'ecs',
        ensureProject: vi.fn().mockResolvedValue({
          success: true,
          message: 'AWS project verified',
          data: {
            projectId: clusterArn,
            environmentId: clusterArn,
            created: true,
            providerBindings: { awsNetwork },
          },
        }),
      } as unknown as IHostingAdapter,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        production: { hosting: { provider: 'ecs', region: 'us-west-2' }, services: {} },
      },
    });
    const action: PlanAction = {
      id: 'project:ecs',
      type: 'create',
      resource: { kind: 'project', name: 'production', provider: 'ecs' },
      verified: true,
      reason: 'No ECS project exists',
    };
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'production',
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
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: true, receipts: [{ actionId: action.id, status: 'succeeded' }] },
    });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toMatchObject({
      provider: 'ecs',
      projectId: clusterArn,
      environmentId: clusterArn,
      services: {},
      awsNetwork,
    });
  });
});
