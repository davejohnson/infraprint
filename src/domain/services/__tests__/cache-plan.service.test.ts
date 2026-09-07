import { describe, expect, it } from 'vitest';
import type { Component } from '../../entities/component.entity.js';
import type { LocalSnapshot } from '../../plan/plan.types.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { createUnresolvedCacheNetworkMutation } from '../../ports/cache.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { CACHE_OPERATIONS, planCache } from '../cache-plan.service.js';

function spec(cache: {
  provider: string;
  region?: string;
  network?: string;
  subnetwork?: string;
  tier?: string;
  size?: string;
} | null = { provider: 'railway' }) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { web: {} },
    ...(cache ? { cache } : {}),
  });
}

function component(
  provider = 'railway',
  providerScope: Record<string, string> = { projectId: 'railway-project' }
): Component {
  return {
    id: 'component-1',
    environmentId: 'environment-1',
    type: 'redis',
    bindings: { provider, connectionUrl: 'redis://example.invalid', providerScope },
    externalId: 'redis-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function local(components: Component[] = []): LocalSnapshot {
  return {
    projectExists: true,
    environmentExists: true,
    services: [],
    components,
  };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    services: [],
    databases: [],
    caches: [],
    partial: false,
    warnings: [],
    ...overrides,
  };
}

describe('Redis cache plan contract', () => {
  it('never promotes a retained failed cache create to noop or old-provider cleanup', () => {
    const retained = component('elasticache', { accountId: '123456789012', region: 'us-west-2' });
    retained.externalId = 'arn:aws:elasticache:us-west-2:123456789012:serverlesscache:failed-create';
    retained.bindings = {
      ...retained.bindings,
      instanceId: retained.externalId,
      provisioningIncomplete: true,
      previousProvider: 'railway',
      previousExternalId: 'railway-cache',
      previousBindings: {
        provider: 'railway',
        instanceId: 'railway-cache',
        providerScope: { projectId: 'railway-project' },
        connectionUrl: 'redis://previous-local-secret',
      },
    };
    const result = planCache({
      environmentSpec: spec({ provider: 'elasticache' }),
      observed: observed({
        caches: [{
          provider: 'elasticache',
          engine: 'redis',
          externalId: retained.externalId,
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          status: 'running',
        }],
      }),
      local: local([retained]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:elasticache',
        type: 'update',
        verified: false,
        metadata: expect.objectContaining({
          blockedReason: 'cache_provision_incomplete',
          externalId: retained.externalId,
        }),
      }),
    ]);
    expect(result.actions.some((action) => action.id === 'cache:railway:destroy')).toBe(false);
  });

  it('blocks another billable create while a provider-assigned cache identity remains unresolved', () => {
    const retained = component('railway', {
      projectId: 'railway-project',
      environmentId: 'railway-environment',
    });
    retained.externalId = null;
    retained.bindings = {
      provider: 'railway',
      providerScope: {
        projectId: 'railway-project',
        environmentId: 'railway-environment',
      },
      provisioningIncomplete: true,
      unresolvedMutation: {
        resourceKind: 'cache',
        operation: 'create',
        resourceName: 'production-redis',
        providerScope: {
          projectId: 'railway-project',
          environmentId: 'railway-environment',
        },
      },
    };
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({ caches: [] }),
      local: local([retained]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'update',
        verified: false,
        metadata: expect.objectContaining({
          blockedReason: 'cache_unresolved_create_unknown',
          resourceName: 'production-redis',
          providerScope: {
            projectId: 'railway-project',
            environmentId: 'railway-environment',
          },
        }),
      }),
    ]);
    expect(result.actions.some((action) => action.type === 'create')).toBe(false);
    expect(result.serviceDependency).toBe('cache:railway');
    expect(result.warnings).toContainEqual(expect.stringContaining(
      'hv_import mode="retained-cache-cleanup"'
    ));
  });

  it('plans only exact in-place recovery for an unresolved cache-network create', () => {
    const providerScope = { accountId: '123456789012', region: 'us-west-2' };
    const retained = component('elasticache', providerScope);
    retained.externalId = null;
    retained.bindings = {
      provider: 'elasticache',
      providerScope,
      provisioningIncomplete: true,
      unresolvedNetworkMutation: createUnresolvedCacheNetworkMutation({
        resourceName: 'production-redis-hypervibe-cache',
        cacheName: 'production-redis',
        providerScope,
        networkScope: { vpcId: 'vpc-1', workloadSecurityGroupId: 'sg-workload' },
        ownership: { ManagedBy: 'Hypervibe', Cache: 'production-redis' },
      }),
    };

    const result = planCache({
      environmentSpec: spec({ provider: 'elasticache' }),
      observed: observed({ caches: [] }),
      local: local([retained]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:elasticache',
        type: 'update',
        verified: true,
        billable: true,
        metadata: expect.objectContaining({
          operation: CACHE_OPERATIONS.ensure,
          recoveryResourceName: 'production-redis-hypervibe-cache',
          providerScope,
          recoveryMarker: {
            resourceKind: 'cache-network',
            operation: 'create',
            resourceName: 'production-redis-hypervibe-cache',
            cacheName: 'production-redis',
            providerScope,
            networkScope: { vpcId: 'vpc-1', workloadSecurityGroupId: 'sg-workload' },
            ownership: { ManagedBy: 'Hypervibe', Cache: 'production-redis' },
          },
        }),
      }),
    ]);
    expect(result.actions[0]?.metadata).not.toHaveProperty('blockedReason');
    expect(result.actions.some((action) => action.type === 'create')).toBe(false);
    expect(result.warnings.join(' ')).toContain('never issue another network-resource create');
  });

  it('offers only exact confirm-gated cleanup when an incomplete cache is removed from desired state', () => {
    const retained = component('elasticache', { accountId: '123456789012', region: 'us-west-2' });
    retained.externalId = 'arn:aws:elasticache:us-west-2:123456789012:serverlesscache:failed-create';
    retained.bindings = {
      ...retained.bindings,
      instanceId: retained.externalId,
      provisioningIncomplete: true,
      previousProvider: 'railway',
      previousExternalId: 'railway-cache',
      previousBindings: {
        provider: 'railway',
        instanceId: 'railway-cache',
        providerScope: { projectId: 'railway-project' },
      },
    };
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({
        caches: [{
          provider: 'elasticache',
          engine: 'redis',
          externalId: retained.externalId,
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          status: 'provisioning',
        }],
      }),
      local: local([retained]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:elasticache:destroy',
        type: 'destroy',
        requiresConfirm: true,
        dataBearing: true,
        metadata: expect.objectContaining({
          externalId: retained.externalId,
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          incompleteProvision: true,
        }),
      }),
    ]);
  });

  it('plans a billable create and makes service wiring depend on it', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed(),
      local: local(),
    });
    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'cache:railway',
      type: 'create',
      billable: true,
      resource: { kind: 'cache', name: 'redis', provider: 'railway' },
    }));
    expect(result.serviceDependency).toBe('cache:railway');
    expect(result.actions[0]?.metadata).toMatchObject({
      region: null,
      network: null,
      subnetwork: null,
      tier: null,
      size: null,
    });
  });

  it('pins cache placement in ensure metadata and plans observed configuration drift', () => {
    const desired = {
      provider: 'memorystore',
      region: 'europe-west1',
      network: 'app-vpc',
      subnetwork: 'app-subnet',
      tier: 'STANDARD_HA',
      size: '5gb',
    };
    const result = planCache({
      environmentSpec: spec(desired),
      observed: observed({
        caches: [{
          provider: 'memorystore',
          engine: 'redis',
          externalId: 'redis-1',
          providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
          status: 'running',
          config: {
            region: 'europe-west1',
            network: 'projects/gcp-project/global/networks/app-vpc',
            subnetwork: 'projects/gcp-project/regions/europe-west1/subnetworks/app-subnet',
            tier: 'BASIC',
            size: '1gb',
          },
        }],
      }),
      local: local([component('memorystore', { projectId: 'gcp-project', region: 'europe-west1' })]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:memorystore',
        type: 'update',
        diff: [
          { field: 'tier', from: 'BASIC', to: 'STANDARD_HA' },
          { field: 'size', from: '1gb', to: '5gb' },
        ],
        metadata: expect.objectContaining({
          region: desired.region,
          network: desired.network,
          subnetwork: desired.subnetwork,
          tier: desired.tier,
          size: desired.size,
        }),
      }),
    ]);
    expect(result.serviceDependency).toBe('cache:memorystore');
  });

  it('plans a verified noop for a bound live cache', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          providerScope: { projectId: 'railway-project' },
          status: 'running',
        }],
      }),
      local: local([component()]),
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ id: 'cache:railway', type: 'noop', verified: true }),
    ]);
  });

  it('retries exact reconciliation after an acknowledged cache update was not verified', () => {
    const retained = component();
    retained.bindings = { ...retained.bindings, reconciliationIncomplete: true };
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          providerScope: { projectId: 'railway-project' },
          status: 'running',
        }],
      }),
      local: local([retained]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'update',
        billable: true,
        metadata: expect.objectContaining({ operation: CACHE_OPERATIONS.ensure }),
      }),
    ]);
    expect(result.serviceDependency).toBe('cache:railway');
  });

  it('blocks dependent services while the bound cache is not running', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          providerScope: { projectId: 'railway-project' },
          status: 'error',
        }],
      }),
      local: local([component()]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'update',
        metadata: expect.objectContaining({
          blockedReason: 'cache_not_running',
          observedStatus: 'error',
        }),
      }),
    ]);
    expect(result.serviceDependency).toBe('cache:railway');
  });

  it('preserves a bound cache and blocks dependent services when observation is unknown', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({ completeness: { caches: 'unknown' }, partial: true }),
      local: local([component()]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'update',
        verified: false,
        metadata: expect.objectContaining({ blockedReason: 'cache_observation_unknown' }),
      }),
    ]);
    expect(result.serviceDependency).toBe('cache:railway');
  });

  it('blocks creates when cache observation is unknown', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({ completeness: { caches: 'unknown' }, partial: true }),
      local: local(),
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        type: 'update',
        verified: false,
        metadata: expect.objectContaining({ blockedReason: 'cache_observation_unknown' }),
      }),
    ]);
  });

  it('blocks duplicate live identities instead of choosing the first', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [
          { provider: 'railway', engine: 'redis', externalId: 'redis-1', providerScope: { projectId: 'railway-project' }, status: 'running' },
          { provider: 'railway', engine: 'redis', externalId: 'redis-2', providerScope: { projectId: 'railway-project' }, status: 'running' },
        ],
      }),
      local: local(),
    });
    expect(result.actions[0]).toEqual(expect.objectContaining({
      type: 'update',
      metadata: expect.objectContaining({
        blockedReason: 'ambiguous_cache_identity',
        externalIds: ['redis-1', 'redis-2'],
      }),
    }));
  });

  it('resolves a durable bound id before treating same-name caches as candidates', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [
          { provider: 'railway', engine: 'redis', externalId: 'redis-1', providerScope: { projectId: 'railway-project' }, status: 'running' },
          { provider: 'railway', engine: 'redis', externalId: 'redis-2', providerScope: { projectId: 'railway-project' }, status: 'running' },
        ],
      }),
      local: local([component()]),
    });
    expect(result.actions[0]).toEqual(expect.objectContaining({
      id: 'cache:railway',
      type: 'noop',
    }));
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'cache',
      detail: expect.stringContaining('redis-2'),
    }));
  });

  it.each([
    ['missing', undefined],
    ['different', { projectId: 'other-project' }],
  ])('blocks a bound cache whose live provider scope is %s', (_label, liveScope) => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          ...(liveScope ? { providerScope: liveScope } : {}),
          status: 'running',
        }],
      }),
      local: local([component('railway', { projectId: 'railway-project' })]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'update',
        metadata: expect.objectContaining({
          blockedReason: 'cache_binding_identity_mismatch',
          boundExternalId: 'redis-1',
        }),
      }),
    ]);
    expect(result.actions.some((action) => action.type === 'noop' || action.type === 'create')).toBe(false);
    expect(result.unmanaged).toContainEqual(expect.objectContaining({ kind: 'cache' }));
  });

  it('blocks a lone live replacement instead of silently accepting it as the bound cache', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-replacement',
          status: 'running',
        }],
      }),
      local: local([component()]),
    });

    expect(result.actions[0]).toMatchObject({
      type: 'update',
      metadata: { blockedReason: 'cache_binding_identity_mismatch' },
    });
    expect(result.actions.some((action) => action.type === 'noop' || action.type === 'create')).toBe(false);
  });

  it('unwires REDIS_URL before a confirm-gated destroy', () => {
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          providerScope: { projectId: 'railway-project' },
          status: 'running',
        }],
      }),
      local: local([component()]),
    });
    expect(result.actions.map((action) => action.id)).toEqual([
      'cache:redis:unwire:web',
      'cache:railway:destroy',
    ]);
    expect(result.actions[1]).toEqual(expect.objectContaining({
      type: 'destroy',
      dataBearing: true,
      requiresConfirm: true,
      dependsOn: ['cache:redis:unwire:web'],
      metadata: expect.objectContaining({
        externalId: 'redis-1',
        providerScope: { projectId: 'railway-project' },
        bindingsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it('destroys removed services before their bound cache', () => {
    const result = planCache({
      environmentSpec: {
        ...spec(null),
        services: {},
      },
      observed: observed({
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'redis-1',
          providerScope: { projectId: 'railway-project' },
          status: 'running',
        }],
      }),
      local: {
        ...local([component()]),
        bindings: {
          services: {
            web: { serviceId: 'service-web' },
          },
        },
      },
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway:destroy',
        dependsOn: ['service:web:destroy'],
      }),
    ]);
  });

  it('keeps provider-confirmed already-absent deletion retryable through apply', () => {
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({ caches: [] }),
      local: local([component()]),
    });
    expect(result.actions.at(-1)).toEqual(expect.objectContaining({
      id: 'cache:railway:destroy',
      type: 'destroy',
      verified: true,
      requiresConfirm: true,
      metadata: expect.objectContaining({
        externalId: 'redis-1',
        providerScope: { projectId: 'railway-project' },
        bindingsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it('blocks replacement when a complete observation cannot find the bound cache', () => {
    const result = planCache({
      environmentSpec: spec(),
      observed: observed({ caches: [] }),
      local: local([component()]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        type: 'update',
        metadata: expect.objectContaining({
          blockedReason: 'cache_binding_identity_mismatch',
          boundExternalId: 'redis-1',
        }),
      }),
    ]);
  });

  it('blocks removal before unwiring when the durable cache scope is missing', () => {
    const unscoped = component();
    unscoped.bindings = { provider: 'railway', connectionUrl: 'redis://example.invalid' };
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({ caches: [] }),
      local: local([unscoped]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:railway:destroy',
        type: 'update',
        metadata: expect.objectContaining({ blockedReason: 'cache_destroy_identity_missing' }),
      }),
    ]);
    expect(result.actions.some((action) => action.metadata?.operation === CACHE_OPERATIONS.unwire)).toBe(false);
  });

  it('plans a staged provider change when the desired provider is confirmed absent', () => {
    const result = planCache({
      environmentSpec: spec({ provider: 'elasticache' }),
      observed: observed({ caches: [] }),
      local: local([component()]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:elasticache',
        type: 'create',
        billable: true,
      }),
    ]);
    expect(result.warnings).toContainEqual(expect.stringContaining('provider change'));
  });

  it('blocks a provider change when an unbound desired-provider cache already exists', () => {
    const result = planCache({
      environmentSpec: spec({ provider: 'elasticache' }),
      observed: observed({
        caches: [
          {
            provider: 'railway',
            engine: 'redis',
            externalId: 'redis-1',
            providerScope: { projectId: 'railway-project' },
            status: 'running',
          },
          {
            provider: 'elasticache',
            engine: 'redis',
            externalId: 'cache-existing',
            providerScope: { accountId: '123456789012', region: 'us-west-2' },
            status: 'running',
          },
        ],
      }),
      local: local([component()]),
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'cache:elasticache',
        type: 'update',
        metadata: expect.objectContaining({
          blockedReason: 'cache_adoption_required',
          externalIds: ['cache-existing'],
        }),
      }),
    ]);
    expect(result.actions.some((action) => action.type === 'create')).toBe(false);
  });

  it('pins the retained provider cache identity in its destroy action', () => {
    const retained = component('elasticache', { accountId: '123456789012', region: 'us-west-2' });
    retained.externalId = 'cache-current';
    retained.bindings = {
      ...retained.bindings,
      previousProvider: 'railway',
      previousExternalId: 'cache-previous',
      previousBindings: {
        provider: 'railway',
        instanceId: 'cache-previous',
        providerScope: { projectId: 'railway-project' },
      },
    };
    const result = planCache({
      environmentSpec: spec({ provider: 'elasticache' }),
      observed: observed({
        caches: [{
          provider: 'elasticache',
          engine: 'redis',
          externalId: 'cache-current',
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          status: 'running',
        }],
      }),
      local: local([retained]),
    });

    expect(result.actions.find((action) => action.id === 'cache:railway:destroy')).toMatchObject({
      type: 'destroy',
      metadata: {
        operation: CACHE_OPERATIONS.destroy,
        externalId: 'cache-previous',
        providerScope: { projectId: 'railway-project' },
        bindingsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('blocks retained-provider deletion when its previous scope is missing', () => {
    const retained = component('elasticache', { accountId: '123456789012', region: 'us-west-2' });
    retained.externalId = 'cache-current';
    retained.bindings = {
      ...retained.bindings,
      previousProvider: 'railway',
      previousExternalId: 'cache-previous',
      previousBindings: {
        provider: 'railway',
        instanceId: 'cache-previous',
      },
    };
    const result = planCache({
      environmentSpec: spec({ provider: 'elasticache' }),
      observed: observed({
        caches: [{
          provider: 'elasticache',
          engine: 'redis',
          externalId: 'cache-current',
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          status: 'running',
        }],
      }),
      local: local([retained]),
    });

    expect(result.actions.find((action) => action.id === 'cache:railway:destroy')).toMatchObject({
      type: 'update',
      metadata: {
        operation: CACHE_OPERATIONS.destroy,
        blockedReason: 'cache_destroy_identity_missing',
        externalId: 'cache-previous',
      },
    });
  });

  it('destroys a retained old cache before deleting the active cache binding', () => {
    const current = component('elasticache', { accountId: '123456789012', region: 'us-west-2' });
    current.externalId = 'cache-current';
    current.bindings = {
      ...current.bindings,
      previousProvider: 'railway',
      previousExternalId: 'cache-previous',
      previousBindings: {
        provider: 'railway',
        instanceId: 'cache-previous',
        providerScope: { projectId: 'railway-project' },
        volumeId: 'volume-previous',
      },
    };
    const result = planCache({
      environmentSpec: spec(null),
      observed: observed({
        caches: [{
          provider: 'elasticache',
          engine: 'redis',
          externalId: 'cache-current',
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          status: 'running',
        }],
      }),
      local: local([current]),
    });

    expect(result.actions.map((action) => action.id)).toEqual([
      'cache:railway:destroy',
      'cache:redis:unwire:web',
      'cache:elasticache:destroy',
    ]);
    expect(result.actions[0]).toMatchObject({
      type: 'destroy',
      metadata: {
        operation: CACHE_OPERATIONS.destroy,
        externalId: 'cache-previous',
        providerScope: { projectId: 'railway-project' },
        bindingsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.actions[2]).toMatchObject({
      type: 'destroy',
      dependsOn: ['cache:railway:destroy', 'cache:redis:unwire:web'],
      metadata: {
        operation: CACHE_OPERATIONS.destroy,
        externalId: 'cache-current',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
        bindingsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
});
