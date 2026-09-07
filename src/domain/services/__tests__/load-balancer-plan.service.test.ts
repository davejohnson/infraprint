import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import type { ILoadBalancerAdapter } from '../../ports/load-balancer.port.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { LOAD_BALANCER_OPERATIONS, planLoadBalancer } from '../load-balancer-plan.service.js';

const project: Project = {
  id: 'project-1',
  name: 'example',
  defaultPlatform: 'railway',
  gitRemoteUrl: 'https://github.com/example/app.git',
  policies: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const desiredSpec = environmentSpecSchema.parse({
  hosting: { provider: 'railway' },
  domain: 'app.example.com',
  services: { webA: {}, webB: {} },
  loadBalancer: { provider: 'cloudflare', services: ['webA', 'webB'] },
});

function environment(platformBindings: Record<string, unknown> = {}): Environment {
  return {
    id: 'environment-1', projectId: project.id, name: 'production', platformBindings,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function observed(): ObservedState {
  return {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    services: [
      { name: 'webA', externalId: 'svc-a', workloadKind: 'web', url: 'https://a.up.railway.app', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {}, status: 'running' },
      { name: 'webB', externalId: 'svc-b', workloadKind: 'web', url: 'https://b.up.railway.app', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {}, status: 'running' },
    ],
    databases: [], partial: false, warnings: [],
  };
}

function serviceActions(): PlanAction[] {
  return ['webA', 'webB'].map((name) => ({
    id: `service:${name}`, type: 'noop', resource: { kind: 'service', name, provider: 'railway' },
    verified: true, reason: 'in sync',
  }));
}

function fakeAdapter(overrides: Partial<ILoadBalancerAdapter> = {}): ILoadBalancerAdapter {
  return {
    name: 'cloudflare',
    resolveLoadBalancerScope: async () => ({ accountId: 'account-1', zoneId: 'zone-1' }),
    findMonitorsByName: async () => [],
    getMonitor: async () => null,
    ensureMonitor: async (_accountId, desired, id) => ({ resource: { id: id ?? 'monitor-1', ...desired }, created: !id, verified: true }),
    deleteMonitor: async () => {},
    findPoolsByName: async () => [],
    getPool: async () => null,
    ensurePool: async (_accountId, desired, id) => ({ resource: { id: id ?? 'pool-1', ...desired }, created: !id, verified: true }),
    deletePool: async () => {},
    findLoadBalancersByHostname: async () => [],
    getLoadBalancer: async () => null,
    ensureLoadBalancer: async (_zoneId, desired, id) => ({ resource: { id: id ?? 'load-balancer-1', ...desired }, created: !id, verified: true }),
    deleteLoadBalancer: async () => {},
    ...overrides,
  };
}

function useAdapter(adapter: ILoadBalancerAdapter): void {
  vi.spyOn(adapterFactory, 'getLoadBalancerAdapter').mockResolvedValue({ success: true, adapter });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('load-balancer plan contract', () => {
  it('plans explicit monitor, pool, and public-hostname creates in dependency order', async () => {
    useAdapter(fakeAdapter());
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment(), observed: observed(), serviceActions: serviceActions(),
    });

    expect(result.actions.map((candidate) => candidate.id)).toEqual([
      'load-balancer:monitor',
      'load-balancer:pool',
      'load-balancer:app.example.com',
    ]);
    expect(result.actions[0]).toMatchObject({ type: 'create', metadata: { operation: LOAD_BALANCER_OPERATIONS.monitorEnsure } });
    expect(result.actions[1]).toMatchObject({
      type: 'create', billable: true,
      dependsOn: ['load-balancer:monitor', 'service:webA', 'service:webB'],
      metadata: expect.objectContaining({
        operation: LOAD_BALANCER_OPERATIONS.poolEnsure,
        services: ['webA', 'webB'],
        origins: [
          { name: 'webA', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app', enabled: true },
          { name: 'webB', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app', enabled: true },
        ],
        originsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(result.actions[2]).toMatchObject({
      type: 'create', billable: true, dependsOn: ['load-balancer:pool'],
      metadata: expect.objectContaining({ operation: LOAD_BALANCER_OPERATIONS.ensure }),
    });
  });

  it('resolves durable ids first and plans noops only after live config matches', async () => {
    useAdapter(fakeAdapter({
      getMonitor: async () => ({
        id: 'monitor-1', name: 'monitor-name', type: 'https', path: '/health', intervalSeconds: 60,
        timeoutSeconds: 5, expectedCodes: '200-399', followRedirects: true,
      }),
      getPool: async () => ({
        id: 'pool-1', name: 'pool-name', monitorId: 'monitor-1', enabled: true, steering: 'random',
        origins: [
          { name: 'webA', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app', enabled: true },
          { name: 'webB', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app', enabled: true },
        ],
      }),
      getLoadBalancer: async () => ({
        id: 'lb-1', hostname: 'app.example.com', poolId: 'pool-1', fallbackPoolId: 'pool-1', enabled: true, proxied: true, steering: 'off',
      }),
    }));
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment({
        loadBalancer: {
          provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1', configHash: 'old',
          monitor: { id: 'monitor-1', name: 'monitor-name' }, pool: { id: 'pool-1', name: 'pool-name' }, loadBalancer: { id: 'lb-1' },
        },
      }),
      observed: observed(), serviceActions: serviceActions(),
    });

    // Binding names are part of the desired provider configuration. Replace
    // them with the deterministic names from the first plan before checking
    // the fully converged case.
    const monitorName = String(result.actions[0].metadata?.externalName);
    const poolName = String(result.actions[1].metadata?.externalName);
    const adapter = fakeAdapter({
      getMonitor: async () => ({
        id: 'monitor-1', name: monitorName, type: 'https', path: '/health', intervalSeconds: 60,
        timeoutSeconds: 5, expectedCodes: '200-399', followRedirects: true,
      }),
      getPool: async () => ({
        id: 'pool-1', name: poolName, monitorId: 'monitor-1', enabled: true, steering: 'random',
        origins: [
          { name: 'webA', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app', enabled: true },
          { name: 'webB', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app', enabled: true },
        ],
      }),
      getLoadBalancer: async () => ({ id: 'lb-1', hostname: 'app.example.com', poolId: 'pool-1', fallbackPoolId: 'pool-1', enabled: true, proxied: true, steering: 'off' }),
    });
    vi.restoreAllMocks();
    useAdapter(adapter);
    const converged = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment({
        loadBalancer: {
          provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1', configHash: 'old',
          monitor: { id: 'monitor-1', name: monitorName }, pool: { id: 'pool-1', name: poolName }, loadBalancer: { id: 'lb-1' },
        },
      }),
      observed: observed(), serviceActions: serviceActions(),
    });
    expect(converged.actions.map((candidate) => candidate.type)).toEqual(['noop', 'noop', 'noop']);

    const replacementActions = serviceActions().map((candidate) =>
      candidate.resource.name === 'webA' ? { ...candidate, type: 'replace' as const } : candidate
    );
    const serviceReplacement = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment({
        loadBalancer: {
          provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1', configHash: 'old',
          monitor: { id: 'monitor-1', name: monitorName }, pool: { id: 'pool-1', name: poolName }, loadBalancer: { id: 'lb-1' },
        },
      }),
      observed: observed(), serviceActions: replacementActions,
    });
    expect(serviceReplacement.actions).toEqual([
      expect.objectContaining({
        type: 'update',
        metadata: expect.objectContaining({
          blockedReason: 'load_balancer_origin_url_missing_or_invalid',
        }),
      }),
    ]);

    vi.restoreAllMocks();
    useAdapter(fakeAdapter({
      getMonitor: async () => ({
        id: 'monitor-1', name: monitorName, type: 'https', path: '/stale', intervalSeconds: 60,
        timeoutSeconds: 5, expectedCodes: '200-399', followRedirects: true,
      }),
      getPool: async () => ({
        id: 'pool-1', name: poolName, monitorId: 'monitor-1', enabled: true, steering: 'random',
        origins: [
          { name: 'webA', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app', enabled: true },
          { name: 'webB', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app', enabled: true },
        ],
      }),
      getLoadBalancer: async () => ({ id: 'lb-1', hostname: 'app.example.com', poolId: 'pool-1', fallbackPoolId: 'pool-1', enabled: true, proxied: true, steering: 'off' }),
    }));
    const monitorOnlyDrift = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment({
        loadBalancer: {
          provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1', configHash: 'old',
          monitor: { id: 'monitor-1', name: monitorName }, pool: { id: 'pool-1', name: poolName }, loadBalancer: { id: 'lb-1' },
        },
      }),
      observed: observed(), serviceActions: serviceActions(),
    });
    expect(monitorOnlyDrift.actions.map((candidate) => candidate.type)).toEqual(['update', 'noop', 'noop']);
  });

  it('blocks unknown observation and never turns it into creates', async () => {
    useAdapter(fakeAdapter({ resolveLoadBalancerScope: async () => { throw new Error('permission denied'); } }));
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment(), observed: observed(), serviceActions: serviceActions(),
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        type: 'update', verified: false,
        metadata: expect.objectContaining({ blockedReason: 'load_balancer_observation_unknown' }),
      }),
    ]);
  });

  it.each([
    ['a private hostname', 'https://web.internal'],
    ['localhost', 'https://localhost'],
    ['an IP literal', 'https://203.0.113.10'],
    ['embedded credentials', 'https://user:password@a.up.railway.app'],
    ['a nonstandard port', 'https://a.up.railway.app:8443'],
    ['a path-qualified URL', 'https://a.up.railway.app/application'],
  ])('blocks %s instead of sending an unusable origin to the provider', async (_label, url) => {
    useAdapter(fakeAdapter());
    const unsafe = observed();
    unsafe.services[0] = { ...unsafe.services[0]!, url };

    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment(), observed: unsafe, serviceActions: serviceActions(),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({
        blockedReason: 'load_balancer_origin_url_missing_or_invalid',
      }),
    });
    expect(result.actions[0]?.billable).toBeUndefined();
    expect(result.actions[0]?.metadata).not.toHaveProperty('origins');
  });

  it('requires distinct public origin addresses instead of counting aliases as redundancy', async () => {
    useAdapter(fakeAdapter());
    const aliased = observed();
    aliased.services[1] = {
      ...aliased.services[1]!,
      url: aliased.services[0]!.url,
    };

    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment(), observed: aliased, serviceActions: serviceActions(),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'update',
      reason: expect.stringContaining('distinct public HTTPS origins'),
      metadata: expect.objectContaining({
        blockedReason: 'load_balancer_origin_url_duplicate',
      }),
    });
    expect(result.actions[0]?.billable).toBeUndefined();
    expect(result.actions[0]?.metadata).not.toHaveProperty('origins');
  });

  it('plans an explicit unsupported action when the provider lacks the capability', async () => {
    vi.spyOn(adapterFactory, 'getLoadBalancerAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway' } as unknown as ILoadBalancerAdapter,
    });
    const unsupportedSpec = environmentSpecSchema.parse({
      ...desiredSpec,
      loadBalancer: { ...desiredSpec.loadBalancer!, provider: 'railway' },
    });
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: unsupportedSpec,
      environment: environment(), observed: observed(), serviceActions: serviceActions(),
    });
    expect(result.actions[0]).toMatchObject({
      resource: { kind: 'load-balancer', provider: 'railway' },
      metadata: expect.objectContaining({ blockedReason: 'load_balancer_unsupported' }),
    });
  });

  it('blocks malformed durable bindings before resolving a provider adapter', async () => {
    const adapterSpy = vi.spyOn(adapterFactory, 'getLoadBalancerAdapter');
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment({ loadBalancer: { provider: 'cloudflare', hostname: 'app.example.com', monitor: { id: 42 } } }),
      observed: observed(), serviceActions: serviceActions(),
    });
    expect(result.actions[0]).toMatchObject({
      metadata: expect.objectContaining({ blockedReason: 'load_balancer_binding_invalid' }),
    });
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it('blocks same-name resources for explicit adoption instead of selecting them', async () => {
    useAdapter(fakeAdapter({
      findMonitorsByName: async () => [{
        id: 'unmanaged-monitor', name: 'candidate', type: 'https', path: '/health', intervalSeconds: 60,
        timeoutSeconds: 5, expectedCodes: '200-399', followRedirects: true,
      }],
    }));
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: desiredSpec,
      environment: environment(), observed: observed(), serviceActions: serviceActions(),
    });
    expect(result.actions[0]).toMatchObject({ metadata: expect.objectContaining({ blockedReason: 'load_balancer_adoption_required' }) });
    expect(result.unmanaged).toHaveLength(1);
  });

  it('plans reverse-order teardown and confirmation-gates removal of public routing', async () => {
    useAdapter(fakeAdapter());
    const withoutLoadBalancer = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, domain: 'app.example.com', services: { webA: {}, webB: {} },
    });
    const result = await planLoadBalancer({
      project, environmentName: 'production', environmentSpec: withoutLoadBalancer,
      environment: environment({
        loadBalancer: {
          provider: 'cloudflare', hostname: 'app.example.com', accountId: 'account-1', zoneId: 'zone-1', configHash: 'hash',
          monitor: { id: 'monitor-1', name: 'monitor' }, pool: { id: 'pool-1', name: 'pool' }, loadBalancer: { id: 'lb-1' },
        },
      }),
      observed: observed(), serviceActions: serviceActions(),
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ id: 'load-balancer:app.example.com:destroy', type: 'destroy', requiresConfirm: true }),
      expect.objectContaining({ id: 'load-balancer:pool:destroy', type: 'destroy', dependsOn: ['load-balancer:app.example.com:destroy'] }),
      expect.objectContaining({ id: 'load-balancer:monitor:destroy', type: 'destroy', dependsOn: ['load-balancer:pool:destroy'] }),
    ]);
  });
});
