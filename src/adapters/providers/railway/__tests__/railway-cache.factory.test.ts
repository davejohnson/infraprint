import { describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { createRailwayCacheAdapter } from '../railway-cache.factory.js';

function environment(platformBindings: Record<string, unknown> = {
  projectId: 'rail-project-1',
  environmentId: 'rail-environment-1',
}): Environment {
  return {
    id: 'environment-1',
    projectId: 'project-1',
    name: 'staging',
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Railway cache adapter', () => {
  it('requires an existing reviewed project binding', async () => {
    const ensureComponent = vi.fn();
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { ensureComponent } as never,
      envRepo: { findById: vi.fn() } as never,
    });

    const result = await adapter.provision('redis', environment({}));

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({ phase: 'requireProjectBinding' });
    expect(ensureComponent).not.toHaveBeenCalled();
  });

  it('rejects unsupported declarative placement before any provider mutation', async () => {
    const ensureComponent = vi.fn();
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { ensureComponent } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });

    expect(() => adapter.configureTarget?.({ region: 'us-west1' }))
      .toThrow('does not support declarative cache region');
    await expect(adapter.provision('redis', environment(), { size: '2gb' }))
      .rejects.toThrow('does not support declarative cache size');
    expect(ensureComponent).not.toHaveBeenCalled();
  });

  it('provisions Redis and exposes only the provider reference URL', async () => {
    const ensureComponent = vi.fn(async () => ({
      component: {
        id: '',
        environmentId: 'environment-1',
        type: 'redis',
        bindings: { pluginName: 'redis-db', resourceKind: 'service' },
        externalId: 'redis-service-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: { success: true, message: 'created' },
    }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { ensureComponent } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });

    const result = await adapter.provision('redis', environment());

    expect(result.receipt.success).toBe(true);
    expect(result.connectionUrl).toBe('${{redis-db.REDIS_URL}}');
    expect(result.envVars).toEqual({ REDIS_URL: '${{redis-db.REDIS_URL}}' });
    expect(result.component.bindings).toMatchObject({
      provider: 'railway',
      projectId: 'rail-project-1',
      providerScope: { projectId: 'rail-project-1' },
    });
  });

  it('uses the refreshed project binding as the mutation and persisted scope', async () => {
    const refreshed = environment({
      projectId: 'rail-project-refreshed',
      environmentId: 'rail-environment-refreshed',
    });
    const ensureComponent = vi.fn(async () => ({
      component: {
        id: '',
        environmentId: refreshed.id,
        type: 'redis',
        bindings: { pluginName: 'redis-db' },
        externalId: 'redis-service-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: { success: true, message: 'created' },
    }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { ensureComponent } as never,
      envRepo: { findById: vi.fn(() => refreshed) } as never,
    });

    const result = await adapter.provision('redis', environment({ projectId: 'stale-project' }));

    expect(ensureComponent).toHaveBeenCalledWith('redis', refreshed);
    expect(result.component.bindings).toMatchObject({
      providerScope: {
        projectId: 'rail-project-refreshed',
        environmentId: 'rail-environment-refreshed',
      },
    });
  });

  it('blocks bound-cache observation when its project scope differs from the environment', async () => {
    const observe = vi.fn();
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { observe } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component: Component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: {
        provider: 'railway',
        providerScope: { projectId: 'other-project' },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.observeCache(environment(), component)).rejects.toThrow('durable project scope');
    expect(observe).not.toHaveBeenCalled();
  });

  it('preserves a volume when service deletion is not provider-confirmed', async () => {
    const deleteService = vi.fn(async () => ({
      success: false,
      error: 'service absence is unknown',
    }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const resolveServiceVolume = vi.fn(async () => ({
      success: true as const,
      state: 'present' as const,
      volumeId: 'redis-volume-1',
      pendingDeletion: false,
    }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { deleteService, deleteVolume, resolveServiceVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component: Component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        volumeId: 'redis-volume-1',
        providerScope: { projectId: 'rail-project-1' },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.message).toContain('persistent volume was preserved');
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it('resolves an uncertain Redis volume marker before service deletion', async () => {
    const resolveServiceVolume = vi.fn(async () => ({
      success: true as const,
      state: 'present' as const,
      volumeId: 'redis-volume-recovered',
      pendingDeletion: false,
    }));
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { resolveServiceVolume, deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const volumeTarget = {
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      serviceId: 'redis-service-1',
      mountPath: '/bitnami/redis/data',
    };
    const component: Component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        providerScope: { projectId: 'rail-project-1' },
        volumeTarget,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(resolveServiceVolume).toHaveBeenCalledWith(volumeTarget, undefined);
    expect(deleteService).toHaveBeenCalledWith(
      'redis-service-1',
      {
        scope: 'environment',
        projectId: 'rail-project-1',
        environmentId: 'rail-environment-1',
      },
      { allowMutation: true }
    );
    expect(deleteVolume).toHaveBeenCalledWith('redis-volume-recovered', volumeTarget);
  });

  it('blocks Redis service deletion when volume marker observation is unknown', async () => {
    const resolveServiceVolume = vi.fn(async () => ({
      success: false as const,
      error: 'volume inventory unavailable',
    }));
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { resolveServiceVolume, deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component: Component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        providerScope: { projectId: 'rail-project-1' },
        volumeTarget: {
          projectId: 'rail-project-1',
          environmentId: 'rail-environment-1',
          serviceId: 'redis-service-1',
          mountPath: '/bitnami/redis/data',
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('volume inventory unavailable');
    expect(deleteService).not.toHaveBeenCalled();
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it('retries exact retained volume cleanup after the service was deleted on a prior attempt', async () => {
    const target = {
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      serviceId: 'redis-service-1',
      mountPath: '/bitnami/redis/data',
    };
    const resolveServiceVolume = vi.fn(async () => ({
      success: true as const,
      state: 'present' as const,
      volumeId: 'redis-volume-1',
      pendingDeletion: false,
    }));
    const deleteService = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, alreadyAbsent: true });
    const deleteVolume = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'volume deletion not yet verified' })
      .mockResolvedValueOnce({ success: true });
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { resolveServiceVolume, deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component: Component = {
      id: 'retained:redis-service-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        retainedCleanup: true,
        providerScope: {
          projectId: 'rail-project-1',
          environmentId: 'rail-environment-1',
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const first = await adapter.destroy(component);
    const second = await adapter.destroy(component);

    expect(first).toMatchObject({
      success: false,
      message: expect.stringContaining('failed to delete its volume'),
    });
    expect(second.success).toBe(true);
    expect(resolveServiceVolume).toHaveBeenNthCalledWith(1, target, undefined);
    expect(resolveServiceVolume).toHaveBeenNthCalledWith(2, target, undefined);
    expect(deleteService).toHaveBeenCalledTimes(2);
    expect(deleteVolume).toHaveBeenNthCalledWith(1, 'redis-volume-1', target);
    expect(deleteVolume).toHaveBeenNthCalledWith(2, 'redis-volume-1', target);
  });

  it.each(['plugin', 'legacy-plugin', undefined])(
    'never sends a %s Redis id to the Railway service deletion API',
    async (resourceKind) => {
      const deleteService = vi.fn(async () => ({ success: true }));
      const deleteVolume = vi.fn(async () => ({ success: true }));
      const adapter = createRailwayCacheAdapter({
        hostingAdapter: { deleteService, deleteVolume } as never,
        envRepo: { findById: vi.fn(() => environment()) } as never,
      });
      const component: Component = {
        id: 'component-1',
        environmentId: 'environment-1',
        type: 'redis',
        externalId: 'legacy-plugin-id',
        bindings: {
          provider: 'railway',
          providerScope: { projectId: 'rail-project-1' },
          volumeId: 'redis-volume-1',
          ...(resourceKind === undefined ? {} : { resourceKind }),
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await adapter.destroy(component);

      expect(result.success).toBe(false);
      expect(result.error).toContain(resourceKind ? 'teardown contract' : 'does not prove');
      expect(deleteService).not.toHaveBeenCalled();
      expect(deleteVolume).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing', undefined],
    ['wrong', { projectId: 'other-project' }],
  ])('blocks deletion when durable project scope is %s', async (_label, providerScope) => {
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayCacheAdapter({
      hostingAdapter: { deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component: Component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'redis',
      externalId: 'redis-service-1',
      bindings: {
        provider: 'railway',
        volumeId: 'redis-volume-1',
        ...(providerScope ? { providerScope } : {}),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('project scope');
    expect(deleteService).not.toHaveBeenCalled();
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});
