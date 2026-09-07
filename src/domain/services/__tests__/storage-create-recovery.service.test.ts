import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { importRailwayProject } from '../import.service.js';
import {
  applyStorageAction,
  planStorage,
  STORAGE_OPERATIONS,
} from '../storage-plan.service.js';

const environmentSpec = environmentSpecSchema.parse({
  hosting: { provider: 'railway' },
  services: { api: {} },
  storage: {
    uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api'] },
  },
});

const recovery = {
  provider: 'railway',
  operation: 'create' as const,
  resourceName: 'uploads',
  providerScope: { projectId: 'rp', environmentId: 're' },
  state: 'unresolved' as const,
};

function directEnvironment(platformBindings: Record<string, unknown>): Environment {
  return {
    id: 'env-local', projectId: 'project-local', name: 'staging',
    platformBindings,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function ensureAction(): PlanAction {
  return {
    id: 'storage:uploads',
    type: 'create',
    resource: { kind: 'storage', name: 'uploads', provider: 'railway' },
    verified: true,
    billable: true,
    reason: 'Create uploads bucket',
    metadata: { operation: STORAGE_OPERATIONS.ensure, storageName: 'uploads' },
  };
}

describe('storage create-recovery planning', () => {
  it('turns a retained exact marker into a non-billable blocker', () => {
    const result = planStorage({
      environmentSpec,
      environment: directEnvironment({
        provider: 'railway', projectId: 'rp', environmentId: 're',
        storageCreateRecovery: { uploads: recovery },
      }),
      observed: null,
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'storage:uploads',
        type: 'update',
        metadata: expect.objectContaining({
          operation: STORAGE_OPERATIONS.ensure,
          blockedReason: 'storage_create_recovery_required',
        }),
      }),
    ]);
    expect(result.actions[0]?.billable).toBeUndefined();
  });

  it('fails closed on malformed recovery state', () => {
    const result = planStorage({
      environmentSpec,
      environment: directEnvironment({
        provider: 'railway', projectId: 'rp', environmentId: 're',
        storageCreateRecovery: { uploads: { state: 'unresolved' } },
      }),
      observed: null,
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'storage:uploads',
        type: 'update',
        metadata: expect.objectContaining({ blockedReason: 'malformed_storage_create_recovery' }),
      }),
    ]);
    expect(result.actions.some((item) => item.type === 'create')).toBe(false);
  });

  it('surfaces a removed desired bucket marker without treating it as deletion authority', () => {
    const withoutStorage = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, services: { api: {} },
    });
    const result = planStorage({
      environmentSpec: withoutStorage,
      environment: directEnvironment({
        provider: 'railway', projectId: 'rp', environmentId: 're',
        storageCreateRecovery: { uploads: recovery },
        storage: {
          uploads: {
            provider: 'railway', externalId: 'older-bound-bucket', region: 'sjc',
            services: [], envKeys: [],
          },
        },
      }),
      observed: null,
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        id: 'storage:uploads:create-recovery',
        type: 'update',
        metadata: expect.objectContaining({ blockedReason: 'orphaned_storage_create_recovery' }),
      }),
    ]);
    expect(result.actions.some((item) => item.type === 'destroy')).toBe(false);
  });
});

describe('storage create-recovery apply boundary', () => {
  let tempDir: string;
  let project: ReturnType<ProjectRepository['create']>;
  let environment: Environment;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-storage-recovery-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'storage-recovery', defaultPlatform: 'railway' });
    environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp', environmentId: 're' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fakeStorageAdapter(ensureBucket: ReturnType<typeof vi.fn>) {
    return {
      name: 'railway',
      runtimeEnvKeys: () => [],
      ensureContext: vi.fn().mockResolvedValue({
        receipt: { success: true, message: 'context ready' },
        context: { projectId: 'rp', environmentId: 're' },
      }),
      ensureBucket,
    };
  }

  it('blocks a stale create before resolving or mutating a provider adapter', async () => {
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      storageCreateRecovery: { uploads: recovery },
    });
    const getStorageAdapter = vi.spyOn(adapterFactory, 'getStorageAdapter');

    const result = await applyStorageAction({
      project, envName: 'staging', environmentSpec, action: ensureAction(),
    });

    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(result.error).toContain('No storage provider mutation was attempted');
    expect(getStorageAdapter).not.toHaveBeenCalled();
  });

  it('durably retains a no-id failed create and prevents a second mutation', async () => {
    const ensureBucket = vi.fn().mockResolvedValue({
      receipt: {
        success: false,
        message: 'bucket outcome unknown',
        error: 'transport ended after write',
        data: { phase: 'bucketCreate', mutationAttempted: true },
      },
      context: { projectId: 'rp', environmentId: 're' },
    });
    const getStorageAdapter = vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({
      success: true,
      adapter: fakeStorageAdapter(ensureBucket),
    } as never);

    const first = await applyStorageAction({
      project, envName: 'staging', environmentSpec, action: ensureAction(),
    });
    const persisted = new EnvironmentRepository().findById(environment.id);
    const second = await applyStorageAction({
      project, envName: 'staging', environmentSpec, action: ensureAction(),
    });

    expect(first).toMatchObject({
      success: false,
      data: { storageCreateRecovery: recovery },
    });
    expect(persisted?.platformBindings).toMatchObject({
      storageCreateRecovery: { uploads: recovery },
    });
    expect(persisted?.platformBindings.storage).toBeUndefined();
    expect(second).toMatchObject({ success: false, status: 'blocked' });
    expect(ensureBucket).toHaveBeenCalledTimes(1);
    expect(getStorageAdapter).toHaveBeenCalledTimes(1);
  });

  it('replaces malformed provider recovery data with a strict conservative marker', async () => {
    const ensureBucket = vi.fn().mockResolvedValue({
      receipt: {
        success: false,
        message: 'bad recovery payload',
        data: {
          phase: 'bucketCreate', mutationAttempted: true,
          storageCreateRecovery: { provider: 'other', state: 'identified' },
        },
      },
      context: { projectId: 'rp', environmentId: 're' },
    });
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({
      success: true,
      adapter: fakeStorageAdapter(ensureBucket),
    } as never);

    const result = await applyStorageAction({
      project, envName: 'staging', environmentSpec, action: ensureAction(),
    });
    const persisted = new EnvironmentRepository().findById(environment.id);

    expect(result.error).toContain('malformed or inconsistent');
    expect(persisted?.platformBindings).toMatchObject({
      storageCreateRecovery: { uploads: recovery },
    });
  });

  it('clears a marker only when hv_import exactly adopts the inspected bucket and scope', async () => {
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      storageCreateRecovery: { uploads: recovery },
    });
    const details = {
      id: 'rp',
      name: 'storage-recovery',
      environments: {
        edges: [{
          node: {
            id: 're', name: 'staging',
            config: { buckets: { 'bucket-1': { region: 'sjc', isDeleted: false } } },
          },
        }],
      },
      services: { edges: [] },
      plugins: { edges: [] },
      buckets: { edges: [{ node: { id: 'bucket-1', name: 'uploads' } }] },
    };

    const imported = await importRailwayProject(details, { staging: 'staging' }, [], [], {
      force: true,
      storageMappings: { 'bucket-1': 'uploads' },
    });
    const persisted = new EnvironmentRepository().findById(environment.id);

    expect(imported.status).toBe('imported');
    expect(persisted?.platformBindings).toMatchObject({
      storage: {
        uploads: {
          provider: 'railway',
          externalId: 'bucket-1',
          instanceScope: { projectId: 'rp', environmentId: 're' },
        },
      },
    });
    expect(persisted?.platformBindings.storageCreateRecovery).toBeUndefined();
  });

  it('rejects a nonmatching hv_import bucket without clearing the marker', async () => {
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      storageCreateRecovery: {
        uploads: {
          ...recovery,
          state: 'identified',
          externalId: 'bucket-expected',
          returnedName: 'uploads',
        },
      },
    });
    const details = {
      id: 'rp',
      name: 'storage-recovery',
      environments: {
        edges: [{
          node: {
            id: 're', name: 'staging',
            config: { buckets: { 'bucket-other': { region: 'sjc', isDeleted: false } } },
          },
        }],
      },
      services: { edges: [] },
      plugins: { edges: [] },
      buckets: { edges: [{ node: { id: 'bucket-other', name: 'uploads' } }] },
    };

    await expect(importRailwayProject(details, { staging: 'staging' }, [], [], {
      force: true,
      storageMappings: { 'bucket-other': 'uploads' },
    })).rejects.toThrow('does not exactly resolve');

    const persisted = new EnvironmentRepository().findById(environment.id);
    expect(persisted?.platformBindings.storageCreateRecovery).toBeDefined();
    expect(persisted?.platformBindings.storage).toBeUndefined();
  });
});
