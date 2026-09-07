import { describe, expect, it } from 'vitest';
import { resolvePlanActionAuthority } from '../action-authority.js';
import type { PlanAction } from '../plan.types.js';

function databaseCopy(overrides: Partial<PlanAction> = {}): PlanAction {
  return {
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
      sourceComponentId: 'source-component',
      engine: 'postgres',
      sourceMaintenanceFingerprint: 'source-maintenance-fingerprint',
      targetMaintenanceFingerprint: 'target-maintenance-fingerprint',
    },
    ...overrides,
  };
}

function storageCopy(overrides: Partial<PlanAction> = {}): PlanAction {
  return {
    id: 'data-migration:initial-launch:storage:documents',
    type: 'update',
    resource: { kind: 'storage', name: 'documents', provider: 's3' },
    verified: true,
    reason: 'copy',
    dataBearing: true,
    billable: true,
    requiresConfirm: true,
    metadata: {
      operation: 'dataMigrationStorageCopy',
      migrationId: 'initial-launch',
      storageName: 'documents',
      sourceEnvironment: 'staging',
      targetEnvironment: 'production',
      sourceProvider: 'gcs',
      targetProvider: 's3',
      sourceExternalId: 'source-bucket',
      sourceInstanceScope: { projectId: 'source-project', location: 'us-west1' },
      sourceMaintenanceFingerprint: 'source-maintenance-fingerprint',
      targetMaintenanceFingerprint: 'target-maintenance-fingerprint',
    },
    ...overrides,
  };
}

describe('data migration action authority', () => {
  it('authorizes an exact confirmed database copy', () => {
    expect(resolvePlanActionAuthority(databaseCopy())).toMatchObject({
      capability: 'database.migrate',
      operation: 'dataMigrationDatabaseCopy',
    });
  });

  it('rejects provider or confirmation drift in persisted plan JSON', () => {
    expect(resolvePlanActionAuthority(databaseCopy({ requiresConfirm: false }))).toBeNull();
    expect(resolvePlanActionAuthority(databaseCopy({
      resource: { kind: 'database', name: 'postgres', provider: 'cloudsql' },
    }))).toBeNull();
    expect(resolvePlanActionAuthority(databaseCopy({
      metadata: {
        ...databaseCopy().metadata,
        sourceMaintenanceFingerprint: undefined,
      },
    }))).toBeNull();
  });

  it('authorizes storage copy only with a pinned source provider scope', () => {
    expect(resolvePlanActionAuthority(storageCopy())).toMatchObject({ capability: 'storage.migrate' });
    expect(resolvePlanActionAuthority(storageCopy({
      metadata: { ...storageCopy().metadata, sourceInstanceScope: undefined },
    }))).toBeNull();
    expect(resolvePlanActionAuthority(storageCopy({
      metadata: { ...storageCopy().metadata, sourceInstanceScope: { projectId: '' } },
    }))).toBeNull();
  });

  it('separately authorizes deletion of the exact retained rollback target', () => {
    const action: PlanAction = {
      id: 'data-migration:initial-launch:database:previous-destroy',
      type: 'destroy',
      resource: { kind: 'database', name: 'postgres', provider: 'railway' },
      verified: true,
      reason: 'cleanup',
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        operation: 'dataMigrationDatabasePreviousDestroy',
        migrationId: 'initial-launch',
        sourceEnvironment: 'staging',
        targetEnvironment: 'production',
        sourceProvider: 'railway',
        targetProvider: 'rds',
        previousExternalId: 'old-production-db',
      },
    };
    expect(resolvePlanActionAuthority(action)).toMatchObject({
      capability: 'database.migration-target.destroy',
    });
  });
});
