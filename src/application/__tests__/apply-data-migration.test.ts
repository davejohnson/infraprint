import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { createCommandContext } from '../context.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { DatabaseAccessLease } from '../../domain/services/database-access.service.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import type { IStorageAdapter, StorageContext, StorageObjectClient } from '../../domain/ports/storage.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import * as environmentMaintenanceService from '../../domain/services/environment-maintenance.service.js';

vi.mock('../../domain/services/database-access.service.js', async (original) => {
  const actual = await original<typeof import('../../domain/services/database-access.service.js')>();
  return {
    ...actual,
    acquireManagedDatabaseAccess: vi.fn(),
    acquireDatabaseComponentAccess: vi.fn(),
  };
});

vi.mock('../../domain/services/postgres-transfer.service.js', async (original) => {
  const actual = await original<typeof import('../../domain/services/postgres-transfer.service.js')>();
  return { ...actual, transferPostgresDatabase: vi.fn() };
});

import {
  acquireDatabaseComponentAccess,
  acquireManagedDatabaseAccess,
} from '../../domain/services/database-access.service.js';
import { transferPostgresDatabase } from '../../domain/services/postgres-transfer.service.js';
import { applyDataMigrationAction } from '../apply-data-migration.js';

function lease(url: string): DatabaseAccessLease {
  return {
    id: `lease:${url}`,
    provider: 'database',
    mode: 'existing',
    createdByInvocation: false,
    withConnection: (operation) => operation(url),
    release: vi.fn(async () => ({ status: 'no_op' as const })),
  };
}

function activeMaintenance(environmentName: string) {
  return {
    state: 'active' as const,
    stage: 'verified' as const,
    edge: {
      state: 'active' as const,
      hostname: `${environmentName}.example.com`,
      markerVerified: true,
    },
    workloads: {},
    database: { state: 'fenced' as const },
  };
}

function maintenanceFingerprint(environmentName: string): string {
  return createHash('sha256')
    .update(JSON.stringify(activeMaintenance(environmentName)))
    .digest('hex');
}

describe('applyDataMigrationAction', () => {
  beforeEach(() => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-data-migration-')), 'test.db')).migrate();
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', configureTarget: vi.fn() },
    } as any);
    vi.spyOn(environmentMaintenanceService, 'observeEnvironmentMaintenance')
      .mockImplementation(async ({ environment }) => activeMaintenance(environment.name));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(acquireManagedDatabaseAccess).mockReset();
    vi.mocked(acquireDatabaseComponentAccess).mockReset();
    vi.mocked(transferPostgresDatabase).mockReset();
  });

  function setup() {
    const project = new ProjectRepository().create({ name: 'migration-apply', defaultPlatform: 'railway' });
    const sourceEnvironment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const targetEnvironment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const source = new ComponentRepository().create({
      environmentId: sourceEnvironment.id,
      type: 'postgres',
      bindings: { provider: 'railway', instanceId: 'source-db' },
      externalId: 'source-db',
    });
    const target = new ComponentRepository().create({
      environmentId: targetEnvironment.id,
      type: 'postgres',
      bindings: { provider: 'rds', instanceId: 'old-production-db', connectionString: 'postgres://old' },
      externalId: 'old-production-db',
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' }, services: { web: {} },
          database: { provider: 'railway', engine: 'postgres' },
          maintenance: { enabled: true },
        },
        production: {
          hosting: { provider: 'railway' }, services: { web: {} },
          database: { provider: 'rds', engine: 'postgres' },
          maintenance: { enabled: true },
          dataMigration: {
            id: 'initial-launch', fromEnvironment: 'staging',
            include: { database: true, storage: [] },
          },
        },
      },
    });
    const action: PlanAction = {
      id: 'data-migration:initial-launch:database',
      type: 'update',
      resource: { kind: 'database', name: 'postgres', provider: 'rds' },
      verified: true,
      reason: 'copy',
      dataBearing: true,
      billable: true,
      requiresConfirm: true,
      metadata: {
        operation: 'dataMigrationDatabaseCopy',
        migrationId: 'initial-launch',
        sourceEnvironment: 'staging',
        targetEnvironment: 'production',
        sourceProvider: 'railway',
        targetProvider: 'rds',
        sourceComponentId: source.id,
        sourceExternalId: source.externalId,
        sourceMaintenanceFingerprint: maintenanceFingerprint('staging'),
        targetMaintenanceFingerprint: maintenanceFingerprint('production'),
        engine: 'postgres',
      },
    };
    return { project, sourceEnvironment, targetEnvironment, source, target, spec, action };
  }

  function adapter() {
    return {
      name: 'rds',
      capabilities: {
        supportedDatabases: ['postgres'], supportsPooling: false, supportsReadReplicas: true,
        supportsPointInTimeRecovery: true, serverlessOptimized: false,
      },
      connect: vi.fn(),
      verify: vi.fn(),
      provision: vi.fn(async (_type, environment) => ({
        component: {
          id: 'provider-candidate', environmentId: environment.id, type: 'postgres',
          bindings: { provider: 'rds', instanceId: 'new-production-db', connectionString: 'postgres://new' },
          externalId: 'new-production-db', createdAt: new Date(), updatedAt: new Date(),
        },
        receipt: { success: true, message: 'provisioned' },
      })),
      observeDatabase: vi.fn(),
      getConnectionUrl: vi.fn(),
      destroy: vi.fn(async () => ({ success: true, message: 'destroyed' })),
    } satisfies IDatabaseAdapter;
  }

  it('switches the binding only after verification and retains the old target', async () => {
    const fixture = setup();
    const targetAdapter = adapter();
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: targetAdapter });
    vi.mocked(acquireManagedDatabaseAccess).mockResolvedValue({ ok: true, lease: lease('postgres://source') });
    vi.mocked(acquireDatabaseComponentAccess).mockResolvedValue({ ok: true, lease: lease('postgres://target') });
    vi.mocked(transferPostgresDatabase).mockResolvedValue({
      manifest: { sourceVersion: '160004', extensions: ['plpgsql'], tables: [{ schema: 'public', table: 'users', rows: '12' }], totalRows: '12', dumpBytes: 4096 },
      targetVersion: '160004',
    });

    const result = await applyDataMigrationAction({
      ctx: createCommandContext(), project: fixture.project, spec: fixture.spec,
      targetEnvironmentName: 'production', action: fixture.action,
    });

    expect(result).toMatchObject({ success: true, data: { tableCount: 1, totalRows: '12', dumpBytes: 4096 } });
    const active = new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'postgres')!;
    expect(active.externalId).toBe('new-production-db');
    expect(active.bindings).toMatchObject({
      dataMigration: { id: 'initial-launch', fromEnvironment: 'staging', totalRows: '12' },
      dataMigrationPreviousTarget: { provider: 'rds', externalId: 'old-production-db' },
    });
    expect(new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'data-migration:initial-launch:postgres')).toBeNull();
    expect(targetAdapter.destroy).not.toHaveBeenCalled();
  });

  it('keeps the old binding active and removes a failed fresh target', async () => {
    const fixture = setup();
    const targetAdapter = adapter();
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: targetAdapter });
    vi.mocked(acquireManagedDatabaseAccess).mockResolvedValue({ ok: true, lease: lease('postgres://source') });
    vi.mocked(acquireDatabaseComponentAccess).mockResolvedValue({ ok: true, lease: lease('postgres://target') });
    vi.mocked(transferPostgresDatabase).mockRejectedValue(new Error('verification mismatch'));

    const result = await applyDataMigrationAction({
      ctx: createCommandContext(), project: fixture.project, spec: fixture.spec,
      targetEnvironmentName: 'production', action: fixture.action,
    });

    expect(result).toMatchObject({ success: false, message: 'Database snapshot transfer or verification failed' });
    const active = new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'postgres')!;
    expect(active.externalId).toBe('old-production-db');
    expect(active.bindings.dataMigration).toBeUndefined();
    expect(targetAdapter.destroy).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'new-production-db' }));
    expect(new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'data-migration:initial-launch:postgres')).toBeNull();
  });

  it('passes opaque provider scopes through a cross-provider storage migration', async () => {
    const project = new ProjectRepository().create({ name: 'storage-migration-apply', defaultPlatform: 'railway' });
    const sourceContext = { projectId: 'gcp-project', location: 'northamerica-northeast1' };
    const targetContext = { accountId: 'aws-account', region: 'us-west-2' };
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        storageProviders: { gcs: { projectId: 'new-gcp-project', location: 'us-east1' } },
        storage: {
          documents: {
            provider: 'gcs', externalId: 'gcp-documents', region: sourceContext.location,
            instanceScope: sourceContext,
            services: ['web'], envKeys: [], updatedAt: '2026-08-13T00:00:00.000Z',
          },
        },
      },
    });
    const targetEnvironment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        storageProviders: { s3: targetContext },
        storage: {
          documents: {
            provider: 's3', externalId: 'old-aws-documents', region: targetContext.region,
            services: [], envKeys: [], updatedAt: '2026-08-13T00:00:00.000Z',
          },
        },
      },
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' }, services: { web: {} },
          maintenance: { enabled: true },
          storage: { documents: { provider: 'gcs', type: 'bucket', region: sourceContext.location, injectInto: ['web'] } },
        },
        production: {
          hosting: { provider: 'railway' }, services: { web: {} },
          maintenance: { enabled: true },
          storage: { documents: { provider: 's3', type: 'bucket', region: targetContext.region, injectInto: ['web'] } },
          dataMigration: {
            id: 'initial-launch', fromEnvironment: 'staging',
            include: { database: false, storage: ['documents'] },
          },
        },
      },
    });
    const action: PlanAction = {
      id: 'data-migration:initial-launch:storage:documents',
      type: 'update',
      resource: { kind: 'storage', name: 'documents', provider: 's3' },
      verified: true,
      reason: 'copy',
      dataBearing: true,
      billable: true,
      requiresConfirm: true,
      metadata: {
        operation: 'dataMigrationStorageCopy', migrationId: 'initial-launch', storageName: 'documents',
        sourceEnvironment: 'staging', targetEnvironment: 'production', sourceProvider: 'gcs', targetProvider: 's3',
        sourceExternalId: 'gcp-documents', sourceInstanceScope: sourceContext, sourceWritesMustBeStopped: true,
        sourceMaintenanceFingerprint: maintenanceFingerprint('staging'),
        targetMaintenanceFingerprint: maintenanceFingerprint('production'),
      },
    };
    const sourceClient = objectClient({ 'document.pdf': Buffer.from('provider-neutral') });
    const targetClient = objectClient({});
    const sourceAdapter = storageAdapter('gcs', sourceContext, sourceClient, 'unused');
    const targetAdapter = storageAdapter('s3', targetContext, targetClient, 'new-aws-documents');
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockImplementation(async (provider) => ({
      success: true,
      adapter: provider === 'gcs' ? sourceAdapter : targetAdapter,
    }));

    const result = await applyDataMigrationAction({
      ctx: createCommandContext(), project, spec, targetEnvironmentName: 'production', action,
    });

    expect(result).toMatchObject({ success: true, data: { objectCount: 1, totalBytes: '16' } });
    expect(sourceAdapter.openObjectTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'staging' }), sourceContext, 'gcp-documents'
    );
    expect(targetAdapter.ensureBucket).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'production' }), targetContext, expect.any(String), targetContext.region
    );
    expect(targetAdapter.openObjectTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'production' }), targetContext, 'new-aws-documents'
    );
    expect(targetClient.objects).toEqual(sourceClient.objects);
    expect(new EnvironmentRepository().findById(targetEnvironment.id)!.platformBindings).toMatchObject({
      storage: {
        documents: {
          provider: 's3',
          externalId: 'new-aws-documents',
          instanceScope: targetContext,
          envKeys: ['OBJECT_STORAGE_BUCKET'],
          previousTarget: { provider: 's3', externalId: 'old-aws-documents', instanceScope: targetContext },
        },
      },
    });
  });
});

function objectClient(initial: Record<string, Buffer>): StorageObjectClient & { objects: Record<string, Buffer> } {
  const objects = { ...initial };
  return {
    objects,
    list: async () => Object.entries(objects).map(([key, value]) => ({ key, size: value.byteLength })),
    get: async (key) => ({ body: Readable.from(objects[key]), size: objects[key].byteLength }),
    put: async (key, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload.body as Readable) chunks.push(Buffer.from(chunk));
      objects[key] = Buffer.concat(chunks);
    },
    destroy: vi.fn(),
  };
}

function storageAdapter(
  name: string,
  context: StorageContext,
  client: StorageObjectClient,
  externalId: string
): IStorageAdapter {
  return {
    name,
    capabilities: {
      kind: 'object', regions: [], privateOnly: true,
      supportsUsageObservation: true, supportsObjectTransfer: true,
    },
    runtimeEnvKeys: vi.fn(() => ['OBJECT_STORAGE_BUCKET']),
    connect: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ success: true })),
    ensureContext: vi.fn(async () => ({ receipt: { success: true, message: 'context ready' }, context })),
    observe: vi.fn(async () => []),
    ensureBucket: vi.fn(async () => ({ receipt: { success: true, message: 'bucket ready' }, externalId, context })),
    getRuntimeEnv: vi.fn(async () => ({ OBJECT_STORAGE_BUCKET: externalId })),
    getCredentials: vi.fn(async () => { throw new Error('native stream expected'); }),
    openObjectTransfer: vi.fn(async () => client),
    destroyBucket: vi.fn(async () => ({ success: true, message: 'destroyed' })),
  };
}
