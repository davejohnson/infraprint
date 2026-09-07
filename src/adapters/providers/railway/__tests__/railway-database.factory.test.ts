import { describe, expect, it, vi } from 'vitest';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function environment(projectId = 'rail-project-1'): Environment {
  const now = new Date();
  return {
    id: 'environment-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId,
      environmentId: 'rail-environment-1',
    },
    createdAt: now,
    updatedAt: now,
  };
}

function databaseComponent(providerScope?: { projectId: string }): Component {
  const now = new Date();
  return {
    id: 'component-1',
    environmentId: 'environment-1',
    type: 'postgres',
    externalId: 'svc-db-1',
    bindings: {
      provider: 'railway',
      resourceKind: 'service',
      ...(providerScope ? { providerScope } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('Railway database adapter', () => {
  it('uses the refreshed project binding for provisioning and persisted scope', async () => {
    const staleEnvironment = environment('stale-project');
    const refreshedEnvironment = environment('rail-project-refreshed');
    const observe = vi.fn(async () => ({
      databases: [],
      completeness: { databases: 'complete' },
      warnings: [],
    }));
    const ensureComponent = vi.fn(async () => ({
      component: {
        ...databaseComponent({ projectId: 'rail-project-refreshed' }),
        bindings: {
          provider: 'railway',
          providerScope: { projectId: 'rail-project-refreshed' },
          resourceKind: 'service',
          pluginName: 'postgres-db',
        },
      },
      receipt: { success: true, message: 'created' },
    }));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { observe, ensureComponent } as never,
      envRepo: { findById: vi.fn(() => refreshedEnvironment) } as never,
    });

    const result = await adapter.provision('postgres', staleEnvironment);

    expect(result.receipt.success).toBe(true);
    expect(observe).toHaveBeenCalledWith(refreshedEnvironment);
    expect(ensureComponent).toHaveBeenCalledWith('postgres', refreshedEnvironment);
    expect(result.component.bindings).toMatchObject({
      projectId: 'rail-project-refreshed',
      providerScope: { projectId: 'rail-project-refreshed' },
    });
    expect(result.receipt.data).toMatchObject({
      providerProjectId: 'rail-project-refreshed',
    });
  });

  it.each([
    ['missing', undefined],
    ['different', { projectId: 'other-project' }],
  ])('blocks ordinary bound observation when durable project scope is %s', async (_label, providerScope) => {
    const observe = vi.fn();
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { observe } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });

    await expect(adapter.observeDatabase(
      environment(),
      databaseComponent(providerScope)
    )).rejects.toThrow('durable project scope');
    expect(observe).not.toHaveBeenCalled();
  });

  it('rejects a durable-id observation returned in a different project scope', async () => {
    const observe = vi.fn(async () => ({
      databases: [{
        provider: 'railway',
        engine: 'postgres',
        externalId: 'svc-db-1',
        providerScope: { projectId: 'other-project' },
        name: 'postgres-db',
        status: 'running',
      }],
      completeness: { databases: 'complete' },
      warnings: [],
    }));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { observe } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });

    await expect(adapter.observeDatabase(
      environment(),
      databaseComponent({ projectId: 'rail-project-1' })
    )).rejects.toThrow('outside the current environment project scope');
  });

  it('observes a retained database through its recorded project after a project rebind', async () => {
    const getProjectDetails = vi.fn(async () => ({
      services: {
        edges: [{
          node: {
            id: 'svc-db-1',
            name: 'postgres-db',
            serviceInstances: {
              edges: [{ node: { source: { image: 'postgres:16' } } }],
            },
          },
        }],
      },
      plugins: { edges: [] },
    }));
    const observe = vi.fn();
    const findById = vi.fn(() => environment('current-project'));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { getProjectDetails, observe } as never,
      envRepo: { findById } as never,
    });
    const component = databaseComponent({ projectId: 'retained-project' });
    component.bindings.retainedCleanup = true;

    const result = await adapter.observeDatabase(environment('current-project'), component);

    expect(result).toMatchObject({
      externalId: 'svc-db-1',
      providerScope: { projectId: 'retained-project' },
    });
    expect(getProjectDetails).toHaveBeenCalledWith('retained-project');
    expect(findById).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('deletes service-backed database volumes with the service', async () => {
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const resolveServiceVolume = vi.fn(async () => ({
      success: true as const,
      state: 'present' as const,
      volumeId: 'vol-1',
      pendingDeletion: false,
    }));
    const hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => {
        throw new Error('not used');
      },
      deploy: async () => {
        throw new Error('not used');
      },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      getDeployStatus: async () => ({ status: 'deployed' }),
      deleteService,
      deleteVolume,
      resolveServiceVolume,
    };
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: hostingAdapter as unknown as Parameters<typeof createRailwayDatabaseAdapter>[0]['hostingAdapter'],
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });

    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        volumeId: 'vol-1',
        providerScope: { projectId: 'rail-project-1' },
      },
      externalId: 'svc-db-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('svc-db-1');
    expect(resolveServiceVolume).toHaveBeenCalledWith({
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      serviceId: 'svc-db-1',
      mountPath: '/var/lib/postgresql/data',
    }, 'vol-1');
    expect(deleteVolume).toHaveBeenCalledWith('vol-1', {
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      serviceId: 'svc-db-1',
      mountPath: '/var/lib/postgresql/data',
    });
  });

  it('preserves the volume when database service deletion is not confirmed', async () => {
    const deleteService = vi.fn(async () => ({
      success: false,
      error: 'service absence is unknown',
    }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const resolveServiceVolume = vi.fn(async () => ({
      success: true as const,
      state: 'present' as const,
      volumeId: 'vol-db-1',
      pendingDeletion: false,
    }));
    const hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: [],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: false,
      },
      deleteService,
      deleteVolume,
      resolveServiceVolume,
    };
    const envRepo = {
      findById: vi.fn(() => environment()),
    };
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: hostingAdapter as never,
      envRepo: envRepo as never,
    });
    const component = {
      id: 'component-1',
      environmentId: 'environment-1',
      type: 'postgres',
      externalId: 'svc-db-1',
      bindings: {
        provider: 'railway',
        resourceKind: 'service',
        volumeId: 'vol-db-1',
        providerScope: { projectId: 'rail-project-1' },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.message).toContain('persistent volume was preserved');
    expect(deleteService).toHaveBeenCalledWith('svc-db-1');
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it('resolves an uncertain volume marker before deleting its database service', async () => {
    const resolveServiceVolume = vi.fn(async () => ({
      success: true as const,
      state: 'present' as const,
      volumeId: 'recovered-volume',
      pendingDeletion: false,
    }));
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { resolveServiceVolume, deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component = databaseComponent({ projectId: 'rail-project-1' });
    component.bindings.volumeTarget = {
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      serviceId: 'svc-db-1',
      mountPath: '/var/lib/postgresql/data',
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(resolveServiceVolume).toHaveBeenCalledWith(component.bindings.volumeTarget, undefined);
    expect(deleteService).toHaveBeenCalledWith('svc-db-1');
    expect(deleteVolume).toHaveBeenCalledWith('recovered-volume', component.bindings.volumeTarget);
  });

  it('blocks before service deletion when an uncertain volume marker cannot be observed', async () => {
    const resolveServiceVolume = vi.fn(async () => ({
      success: false as const,
      error: 'volume inventory unavailable',
    }));
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { resolveServiceVolume, deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component = databaseComponent({ projectId: 'rail-project-1' });
    component.bindings.volumeTarget = {
      projectId: 'rail-project-1',
      environmentId: 'rail-environment-1',
      serviceId: 'svc-db-1',
      mountPath: '/var/lib/postgresql/data',
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('volume inventory unavailable');
    expect(deleteService).not.toHaveBeenCalled();
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it.each(['plugin', 'legacy-plugin', undefined])(
    'never sends a %s database id to the Railway service deletion API',
    async (resourceKind) => {
      const deleteService = vi.fn(async () => ({ success: true, alreadyAbsent: true }));
      const deleteVolume = vi.fn(async () => ({ success: true }));
      const adapter = createRailwayDatabaseAdapter({
        hostingAdapter: { deleteService, deleteVolume } as never,
        envRepo: { findById: vi.fn(() => environment()) } as never,
      });
      const component = databaseComponent({ projectId: 'rail-project-1' });
      if (resourceKind === undefined) delete component.bindings.resourceKind;
      else component.bindings.resourceKind = resourceKind;
      component.bindings.volumeId = 'vol-db-1';

      const result = await adapter.destroy(component);

      expect(result.success).toBe(false);
      expect(result.error).toContain(resourceKind ? 'teardown contract' : 'does not prove');
      expect(deleteService).not.toHaveBeenCalled();
      expect(deleteVolume).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing', undefined],
    ['different', { projectId: 'other-project' }],
  ])('blocks ordinary deletion when durable project scope is %s', async (_label, providerScope) => {
    const deleteService = vi.fn(async () => ({ success: true }));
    const deleteVolume = vi.fn(async () => ({ success: true }));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { deleteService, deleteVolume } as never,
      envRepo: { findById: vi.fn(() => environment()) } as never,
    });
    const component = databaseComponent(providerScope);
    component.bindings.volumeId = 'vol-db-1';

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('durable project scope');
    expect(deleteService).not.toHaveBeenCalled();
    expect(deleteVolume).not.toHaveBeenCalled();
  });

  it('provider-verifies and deletes a retained service database even when generic cleanup omitted resourceKind', async () => {
    const deleteService = vi.fn(async () => ({ success: true }));
    const getProjectDetails = vi.fn(async () => ({
      services: {
        edges: [{
          node: {
            id: 'svc-db-1',
            name: 'postgres-db',
            serviceInstances: { edges: [{ node: { source: { image: 'postgres:16' } } }] },
          },
        }],
      },
      plugins: { edges: [] },
    }));
    const findById = vi.fn(() => environment('current-project'));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { deleteService, getProjectDetails } as never,
      envRepo: { findById } as never,
    });
    const component = databaseComponent({ projectId: 'retained-project' });
    component.bindings.retainedCleanup = true;
    delete component.bindings.resourceKind;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(getProjectDetails).toHaveBeenCalledWith('retained-project');
    expect(deleteService).toHaveBeenCalledWith('svc-db-1');
    expect(findById).not.toHaveBeenCalled();
  });

  it('never sends a retained legacy-plugin database id to service deletion', async () => {
    const deleteService = vi.fn(async () => ({ success: true }));
    const getProjectDetails = vi.fn(async () => ({
      services: { edges: [] },
      plugins: { edges: [{ node: { id: 'svc-db-1', name: 'postgres-plugin' } }] },
    }));
    const adapter = createRailwayDatabaseAdapter({
      hostingAdapter: { deleteService, getProjectDetails } as never,
      envRepo: { findById: vi.fn(() => environment('current-project')) } as never,
    });
    const component = databaseComponent({ projectId: 'retained-project' });
    component.bindings.retainedCleanup = true;
    delete component.bindings.resourceKind;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('legacy plugin');
    expect(deleteService).not.toHaveBeenCalled();
  });
});
