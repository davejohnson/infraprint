import { describe, expect, it } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  MAINTENANCE_OPERATIONS,
  planMaintenance,
} from '../maintenance-plan.service.js';
import { maintenanceWorkloadsRestored } from '../environment-maintenance.service.js';

const now = new Date('2026-08-15T00:00:00.000Z');

function environment(platformBindings: Record<string, unknown> = {}): Environment {
  return {
    id: 'environment-id',
    projectId: 'project-id',
    name: 'production',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

function desired(enabled: boolean) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'maintenance-plan',
    environments: {
      production: {
        hosting: { provider: 'railway' },
        domain: 'app.example.com',
        services: {
          web: { workloadKind: 'web' },
          worker: { workloadKind: 'worker' },
          cron: { workloadKind: 'cron', cronSchedule: '0 * * * *', startCommand: 'npm run cron' },
        },
        database: { provider: 'railway', engine: 'postgres' },
        maintenance: { enabled },
      },
    },
  }).environments.production;
}

function observed(state: 'inactive' | 'active' | 'partial' = 'inactive'): ObservedState {
  const active = state === 'active';
  return {
    provider: 'railway',
    observedAt: now.toISOString(),
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-environment',
    services: ['web', 'worker', 'cron'].map((name) => ({
      name,
      externalId: `${name}-id`,
      workloadKind: name as 'web' | 'worker' | 'cron',
      customDomains: [],
      config: name === 'cron' ? { cronSchedule: active ? undefined : '0 * * * *' } : {},
      envVarKeys: [],
      envVarHashes: {},
      status: active ? 'empty' : 'running',
      maintenance: {
        state: active ? 'suspended' : 'running',
        deploymentId: `${name}-deployment`,
        deploymentStatus: active ? 'REMOVED' : 'SUCCESS',
      },
    })),
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'database-id', status: 'running' }],
    partial: state === 'partial',
    warnings: [],
    maintenance: {
      state,
      stage: active ? 'verified' : 'edge',
      edge: {
        state: active ? 'active' : 'inactive',
        hostname: 'app.example.com',
        markerVerified: active,
      },
      workloads: Object.fromEntries(['web', 'worker', 'cron'].map((name) => [name, {
        state: active ? 'suspended' : 'running',
        serviceId: `${name}-id`,
        workloadKind: name,
      }])),
      database: { state: active ? 'fenced' : 'unfenced', componentId: 'component-id' },
    },
  };
}

describe('planMaintenance', () => {
  it('verifies restoration against each captured pre-maintenance state', () => {
    expect(maintenanceWorkloadsRestored({
      web: { state: 'suspended', serviceId: 'web-id', workloadKind: 'web' },
      worker: { state: 'running', serviceId: 'worker-id', workloadKind: 'worker' },
    }, {
      workloads: {
        web: { serviceId: 'web-id', workloadKind: 'web', wasRunning: false },
        worker: { serviceId: 'worker-id', workloadKind: 'worker', wasRunning: true },
      },
    })).toBe(true);
  });

  it('orders entry edge -> non-web workloads -> web -> database -> verify', () => {
    const result = planMaintenance({
      environmentName: 'production',
      environmentSpec: desired(true),
      environment: environment(),
      observed: observed('inactive'),
    });

    expect(result.pending).toBe(true);
    const operations = result.actions.map((action) => action.metadata?.operation);
    expect(operations).toEqual([
      MAINTENANCE_OPERATIONS.edgeEnable,
      MAINTENANCE_OPERATIONS.workloadSuspend,
      MAINTENANCE_OPERATIONS.workloadSuspend,
      MAINTENANCE_OPERATIONS.workloadSuspend,
      MAINTENANCE_OPERATIONS.databaseFence,
      MAINTENANCE_OPERATIONS.verifyEnter,
    ]);
    expect(result.actions.find((action) => action.id === 'maintenance:production:workload:web')?.dependsOn)
      .toContain('maintenance:production:workload:worker');
    expect(result.actions.at(-1)?.dependsOn).toEqual(['maintenance:production:database-fence']);
  });

  it('is entirely noop after provider verification', () => {
    const result = planMaintenance({
      environmentName: 'production',
      environmentSpec: desired(true),
      environment: environment({ maintenance: { state: 'active' } }),
      observed: observed('active'),
    });
    expect(result.pending).toBe(false);
    expect(result.actions.every((action) => action.type === 'noop')).toBe(true);
  });

  it('blocks unknown observations instead of calling them inactive', () => {
    const partial = observed('partial');
    partial.maintenance = {
      ...partial.maintenance!,
      edge: { state: 'unknown', hostname: 'app.example.com', markerVerified: false, reason: 'permission denied' },
    };
    const result = planMaintenance({
      environmentName: 'production',
      environmentSpec: desired(true),
      environment: environment(),
      observed: partial,
    });
    expect(result.actions[0]).toMatchObject({
      verified: false,
      metadata: { blockedReason: 'maintenance_edge_unknown' },
    });
  });

  it('reverses exit ordering and removes the edge last', () => {
    const binding = {
      state: 'active',
      edge: { routeId: 'route-id', scriptName: 'script', hostname: 'app.example.com' },
      workloads: Object.fromEntries(['web', 'worker', 'cron'].map((name) => [name, {
        serviceId: `${name}-id`,
        workloadKind: name,
        wasRunning: true,
        deploymentId: `${name}-deployment`,
        ...(name === 'cron' ? { cronSchedule: '0 * * * *' } : {}),
      }])),
      database: { componentId: 'component-id', fenced: true },
    };
    const result = planMaintenance({
      environmentName: 'production',
      environmentSpec: desired(false),
      environment: environment({ maintenance: binding }),
      observed: observed('active'),
    });
    expect(result.actions[0]?.metadata?.operation).toBe(MAINTENANCE_OPERATIONS.databaseUnfence);
    expect(result.actions.at(-2)?.metadata?.operation).toBe(MAINTENANCE_OPERATIONS.edgeDisable);
    expect(result.actions.at(-1)?.metadata?.operation).toBe(MAINTENANCE_OPERATIONS.verifyExit);
  });

  it('preserves a workload that was stopped before maintenance', () => {
    const live = observed('active');
    live.maintenance!.workloads.web!.state = 'suspended';
    const binding = {
      state: 'active',
      edge: { routeId: 'route-id', scriptName: 'script', hostname: 'app.example.com' },
      workloads: Object.fromEntries(['web', 'worker', 'cron'].map((name) => [name, {
        serviceId: `${name}-id`,
        workloadKind: name,
        wasRunning: name !== 'web',
      }])),
      database: { componentId: 'component-id', fenced: true },
    };
    const result = planMaintenance({
      environmentName: 'production',
      environmentSpec: desired(false),
      environment: environment({ maintenance: binding }),
      observed: live,
    });

    expect(result.actions.find((action) => action.id === 'maintenance:production:workload:web'))
      .toMatchObject({ type: 'noop' });
  });

  it('finalizes an interrupted exit even when provider state is already inactive', () => {
    const binding = {
      state: 'exiting',
      workloads: Object.fromEntries(['web', 'worker', 'cron'].map((name) => [name, {
        serviceId: `${name}-id`,
        workloadKind: name,
        wasRunning: true,
      }])),
    };
    const result = planMaintenance({
      environmentName: 'production',
      environmentSpec: desired(false),
      environment: environment({ maintenance: binding }),
      observed: observed('inactive'),
    });

    expect(result.actions.at(-1)).toMatchObject({
      type: 'update',
      metadata: { operation: MAINTENANCE_OPERATIONS.verifyExit },
    });
    expect(result.pending).toBe(true);
  });
});
