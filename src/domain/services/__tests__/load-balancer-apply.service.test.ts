import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import type { ILoadBalancerAdapter } from '../../ports/load-balancer.port.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import {
  applyLoadBalancerAction,
  parseLoadBalancerBinding,
  planLoadBalancer,
} from '../load-balancer-plan.service.js';

function fakeAdapter() {
  const calls: string[] = [];
  const adapter: ILoadBalancerAdapter = {
    name: 'cloudflare',
    resolveLoadBalancerScope: vi.fn(async () => ({ accountId: 'account-1', zoneId: 'zone-1' })),
    findMonitorsByName: vi.fn(async () => []),
    getMonitor: vi.fn(async () => null),
    ensureMonitor: vi.fn(async (_accountId, desired, id) => {
      calls.push('monitor');
      return { resource: { id: id ?? 'monitor-1', ...desired }, created: !id, verified: true };
    }),
    deleteMonitor: vi.fn(async () => { calls.push('monitor:destroy'); }),
    findPoolsByName: vi.fn(async () => []),
    getPool: vi.fn(async () => null),
    ensurePool: vi.fn(async (_accountId, desired, id) => {
      calls.push('pool');
      return { resource: { id: id ?? 'pool-1', ...desired }, created: !id, verified: true };
    }),
    deletePool: vi.fn(async () => { calls.push('pool:destroy'); }),
    findLoadBalancersByHostname: vi.fn(async () => []),
    getLoadBalancer: vi.fn(async () => null),
    ensureLoadBalancer: vi.fn(async (_zoneId, desired, id) => {
      calls.push('load-balancer');
      return { resource: { id: id ?? 'lb-1', ...desired }, created: !id, verified: true };
    }),
    deleteLoadBalancer: vi.fn(async () => { calls.push('load-balancer:destroy'); }),
  };
  return { adapter, calls };
}

describe('load-balancer apply contract', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-load-balancer-apply-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('mutates only the resource authorized by each action and persists partial progress', async () => {
    const project = new ProjectRepository().create({ name: 'example', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        services: {
          webA: { serviceId: 'svc-a', url: 'https://a.up.railway.app' },
          webB: { serviceId: 'svc-b', url: 'https://b.up.railway.app' },
        },
      },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, domain: 'app.example.com',
      services: { webA: {}, webB: {} },
      loadBalancer: { provider: 'cloudflare', services: ['webA', 'webB'] },
    });
    const observed: ObservedState = {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      services: [
        { name: 'webA', externalId: 'svc-a', workloadKind: 'web', url: 'https://a.up.railway.app', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {}, status: 'running' },
        { name: 'webB', externalId: 'svc-b', workloadKind: 'web', url: 'https://b.up.railway.app', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {}, status: 'running' },
      ],
      databases: [], partial: false, warnings: [],
    };
    const services = ['webA', 'webB'].map((name) => ({
      id: `service:${name}`, type: 'noop' as const,
      resource: { kind: 'service' as const, name, provider: 'railway' },
      verified: true, reason: 'in sync',
    }));
    const fake = fakeAdapter();
    vi.spyOn(adapterFactory, 'getLoadBalancerAdapter').mockResolvedValue({ success: true, adapter: fake.adapter });
    const plan = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec, environment, observed, serviceActions: services,
    });

    const renamedMonitorResult = await applyLoadBalancerAction({
      project,
      envName: 'production',
      environmentSpec,
      action: {
        ...plan.actions[0],
        metadata: { ...plan.actions[0].metadata, externalName: 'different-monitor' },
      },
    });
    expect(renamedMonitorResult).toMatchObject({ success: false, status: 'blocked' });
    expect(fake.calls).toEqual([]);

    const monitorResult = await applyLoadBalancerAction({
      project, envName: 'production', environmentSpec, action: plan.actions[0],
    });
    expect(monitorResult.success).toBe(true);
    expect(fake.calls).toEqual(['monitor']);
    expect(parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id))?.monitor?.id).toBe('monitor-1');
    expect(parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id))?.pool).toBeUndefined();

    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      services: {
        webA: { serviceId: 'svc-a', url: 'https://changed.up.railway.app' },
        webB: { serviceId: 'svc-b', url: 'https://b.up.railway.app' },
      },
    });
    const changedOriginResult = await applyLoadBalancerAction({
      project, envName: 'production', environmentSpec, action: plan.actions[1],
    });
    expect(changedOriginResult).toMatchObject({ success: false, status: 'blocked' });
    expect(fake.calls).toEqual(['monitor']);
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      services: {
        webA: { serviceId: 'svc-a', url: 'https://a.up.railway.app' },
        webB: { serviceId: 'svc-b', url: 'https://b.up.railway.app' },
      },
    });

    const poolResult = await applyLoadBalancerAction({
      project, envName: 'production', environmentSpec, action: plan.actions[1],
    });
    expect(poolResult.success).toBe(true);
    expect(fake.calls).toEqual(['monitor', 'pool']);
    expect(fake.adapter.ensurePool).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({
        monitorId: 'monitor-1',
        origins: expect.arrayContaining([
          expect.objectContaining({ name: 'webA', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app' }),
          expect.objectContaining({ name: 'webB', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app' }),
        ]),
      }),
      undefined
    );

    const publicResult = await applyLoadBalancerAction({
      project, envName: 'production', environmentSpec, action: plan.actions[2],
    });
    expect(publicResult.success).toBe(true);
    expect(fake.calls).toEqual(['monitor', 'pool', 'load-balancer']);
    expect(parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id))).toMatchObject({
      provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1',
      monitor: { id: 'monitor-1' }, pool: { id: 'pool-1' }, loadBalancer: { id: 'lb-1' },
    });

    const changedMonitorIdResult = await applyLoadBalancerAction({
      project,
      envName: 'production',
      environmentSpec,
      action: {
        ...plan.actions[0],
        type: 'update',
        metadata: { ...plan.actions[0].metadata, externalId: 'other-monitor' },
      },
    });
    expect(changedMonitorIdResult).toMatchObject({ success: false, status: 'blocked' });
    expect(fake.calls).toEqual(['monitor', 'pool', 'load-balancer']);

    const changedSpec = environmentSpecSchema.parse({
      ...environmentSpec,
      loadBalancer: { ...environmentSpec.loadBalancer!, healthCheckPath: '/ready' },
    });
    const staleResult = await applyLoadBalancerAction({
      project, envName: 'production', environmentSpec: changedSpec, action: plan.actions[0],
    });
    expect(staleResult).toMatchObject({ success: false, status: 'blocked' });
    expect(fake.calls).toEqual(['monitor', 'pool', 'load-balancer']);

    const persisted = parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id))!;
    vi.mocked(fake.adapter.getMonitor).mockResolvedValue({
      id: persisted.monitor!.id,
      name: persisted.monitor!.name,
      type: 'https',
      path: '/health',
      intervalSeconds: 60,
      timeoutSeconds: 5,
      expectedCodes: '200-399',
      followRedirects: true,
    });
    vi.mocked(fake.adapter.getPool).mockResolvedValue({
      id: persisted.pool!.id,
      name: persisted.pool!.name,
      monitorId: persisted.monitor!.id,
      origins: [
        { name: 'webA', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app', enabled: true },
        { name: 'webB', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app', enabled: true },
      ],
      enabled: true,
      steering: 'random',
    });
    vi.mocked(fake.adapter.getLoadBalancer).mockResolvedValue({
      id: persisted.loadBalancer!.id,
      hostname: 'app.example.com',
      poolId: persisted.pool!.id,
      fallbackPoolId: persisted.pool!.id,
      enabled: true,
      proxied: true,
      steering: 'off',
    });
    const changedPlan = await planLoadBalancer({
      project,
      environmentName: 'production',
      environmentSpec: changedSpec,
      environment: new EnvironmentRepository().findById(environment.id),
      observed,
      serviceActions: services,
    });
    expect(changedPlan.actions.map((candidate) => candidate.type)).toEqual(['update', 'noop', 'noop']);
    const updateResult = await applyLoadBalancerAction({
      project,
      envName: 'production',
      environmentSpec: changedSpec,
      action: changedPlan.actions[0],
    });
    expect(updateResult.success).toBe(true);
    expect(parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id))?.configHash)
      .toBe(changedPlan.actions[0].metadata?.configHash);
  });

  it('retains an acknowledged resource id but stops before dependencies when read-back is unverified', async () => {
    const project = new ProjectRepository().create({ name: 'example', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        services: {
          webA: { serviceId: 'svc-a', url: 'https://a.up.railway.app' },
          webB: { serviceId: 'svc-b', url: 'https://b.up.railway.app' },
        },
      },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      domain: 'app.example.com',
      services: { webA: {}, webB: {} },
      loadBalancer: { provider: 'cloudflare', services: ['webA', 'webB'] },
    });
    const observed: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [
        { name: 'webA', externalId: 'svc-a', workloadKind: 'web', url: 'https://a.up.railway.app', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {}, status: 'running' },
        { name: 'webB', externalId: 'svc-b', workloadKind: 'web', url: 'https://b.up.railway.app', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {}, status: 'running' },
      ],
      databases: [],
      partial: false,
      warnings: [],
    };
    const serviceActions = ['webA', 'webB'].map((name) => ({
      id: `service:${name}`,
      type: 'noop' as const,
      resource: { kind: 'service' as const, name, provider: 'railway' },
      verified: true,
      reason: 'in sync',
    }));
    const fake = fakeAdapter();
    vi.mocked(fake.adapter.ensureMonitor).mockImplementationOnce(async (_accountId, desired) => {
      fake.calls.push('monitor');
      return {
        resource: { id: 'monitor-acknowledged', ...desired },
        created: true,
        verified: false,
        verificationError: 'exact read remained unavailable',
      };
    });
    vi.spyOn(adapterFactory, 'getLoadBalancerAdapter').mockResolvedValue({ success: true, adapter: fake.adapter });
    const plan = await planLoadBalancer({
      project,
      environmentName: 'production',
      environmentSpec,
      environment,
      observed,
      serviceActions,
    });

    const result = await applyLoadBalancerAction({
      project,
      envName: 'production',
      environmentSpec,
      action: plan.actions[0],
    });

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      data: { externalId: 'monitor-acknowledged', recoverableBindingRetained: true },
    });
    expect(parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id)))
      .toMatchObject({ monitor: { id: 'monitor-acknowledged' } });
    expect(fake.calls).toEqual(['monitor']);
  });

  it('tears down in the planned reverse order and clears bindings only after terminal actions', async () => {
    const project = new ProjectRepository().create({ name: 'example', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id, name: 'production',
      platformBindings: {
        provider: 'railway',
        loadBalancer: {
          provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1', configHash: 'config-hash',
          monitor: { id: 'monitor-1', name: 'monitor' }, pool: { id: 'pool-1', name: 'pool' }, loadBalancer: { id: 'lb-1' },
        },
      },
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, domain: 'app.example.com', services: { webA: {}, webB: {} },
    });
    const fake = fakeAdapter();
    vi.spyOn(adapterFactory, 'getLoadBalancerAdapter').mockResolvedValue({ success: true, adapter: fake.adapter });
    const plan = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec, environment, observed: null, serviceActions: [],
    });

    const wrongScope = await applyLoadBalancerAction({
      project,
      envName: 'production',
      environmentSpec,
      action: {
        ...plan.actions[0],
        metadata: { ...plan.actions[0].metadata, zoneId: 'different-zone' },
      },
    });
    expect(wrongScope).toMatchObject({ success: false, status: 'blocked' });
    expect(fake.calls).toEqual([]);

    for (const candidate of plan.actions) {
      const result = await applyLoadBalancerAction({ project, envName: 'production', environmentSpec, action: candidate });
      expect(result.success).toBe(true);
    }
    expect(fake.calls).toEqual(['load-balancer:destroy', 'pool:destroy', 'monitor:destroy']);
    expect(parseLoadBalancerBinding(new EnvironmentRepository().findById(environment.id))).toBeUndefined();
  });
});
