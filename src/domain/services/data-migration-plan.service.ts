import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { EnvironmentMaintenanceObservation } from '../ports/observe.port.js';
import { createHash } from 'node:crypto';
import { parseStorageBindings } from './storage-plan.service.js';

export const DATA_MIGRATION_OPERATIONS = {
  databaseCopy: 'dataMigrationDatabaseCopy',
  storageCopy: 'dataMigrationStorageCopy',
  databasePreviousDestroy: 'dataMigrationDatabasePreviousDestroy',
  storagePreviousDestroy: 'dataMigrationStoragePreviousDestroy',
} as const;

const DATA_MIGRATION_OPERATION_SET = new Set<string>(Object.values(DATA_MIGRATION_OPERATIONS));

export interface DataMigrationPlanResult {
  actions: PlanAction[];
  pending: boolean;
  providers: string[];
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function completed(
  marker: Record<string, unknown> | undefined,
  migrationId: string,
  sourceEnvironment: string
): boolean {
  return stringField(marker, 'id') === migrationId
    && stringField(marker, 'fromEnvironment') === sourceEnvironment
    && typeof marker?.completedAt === 'string';
}

function migrationAction(params: {
  id: string;
  resourceName: string;
  provider: string;
  operation: string;
  reason: string;
  metadata: Record<string, unknown>;
  complete: boolean;
  blockedReason?: string;
}): PlanAction {
  return {
    id: params.id,
    type: params.complete ? 'noop' : 'update',
    resource: {
      kind: params.operation === DATA_MIGRATION_OPERATIONS.databaseCopy ? 'database' : 'storage',
      name: params.resourceName,
      provider: params.provider,
    },
    verified: !params.blockedReason,
    reason: params.reason,
    ...(!params.complete
      ? {
          dataBearing: true,
          billable: true,
          requiresConfirm: true,
        }
      : {}),
    metadata: {
      operation: params.operation,
      ...params.metadata,
      ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    },
  };
}

function previousTargetDestroyAction(params: {
  id: string;
  resourceName: string;
  provider: string;
  operation: string;
  migrationId: string;
  sourceEnvironment: string;
  targetEnvironment: string;
  sourceProvider: string;
  targetProvider: string;
  externalId: string;
}): PlanAction {
  return {
    id: params.id,
    type: 'destroy',
    resource: {
      kind: params.operation === DATA_MIGRATION_OPERATIONS.databasePreviousDestroy ? 'database' : 'storage',
      name: params.resourceName,
      provider: params.provider,
    },
    verified: true,
    reason: `Delete the previous ${params.provider} target retained for rollback after migration "${params.migrationId}"`,
    dataBearing: true,
    requiresConfirm: true,
    metadata: {
      operation: params.operation,
      migrationId: params.migrationId,
      sourceEnvironment: params.sourceEnvironment,
      targetEnvironment: params.targetEnvironment,
      sourceProvider: params.sourceProvider,
      targetProvider: params.targetProvider,
      previousExternalId: params.externalId,
    },
  };
}

/**
 * Plan one explicit, whole-resource environment data copy. A migration id is
 * a one-use event: changing providers does not implicitly copy data and reusing
 * an already completed id does not copy a moving source again.
 */
export function planDataMigration(params: {
  targetEnvironmentName: string;
  targetSpec: EnvironmentSpec;
  targetEnvironment: Environment | null;
  targetComponents: Component[];
  sourceSpec: EnvironmentSpec;
  sourceEnvironment: Environment | null;
  sourceComponents: Component[];
  sourceMaintenance?: EnvironmentMaintenanceObservation;
  targetMaintenance?: EnvironmentMaintenanceObservation;
}): DataMigrationPlanResult {
  const migration = params.targetSpec.dataMigration;
  if (!migration) return { actions: [], pending: false, providers: [], warnings: [] };

  const actions: PlanAction[] = [];
  const sourceName = migration.fromEnvironment;
  const maintenanceBlockedReason = params.sourceSpec.maintenance?.enabled !== true
    ? 'source_maintenance_not_desired'
    : params.targetSpec.maintenance?.enabled !== true
      ? 'target_maintenance_not_desired'
      : params.sourceMaintenance?.state !== 'active'
        ? 'source_maintenance_not_verified'
        : params.targetMaintenance?.state !== 'active'
          ? 'target_maintenance_not_verified'
          : undefined;
  const maintenanceFingerprint = (value: EnvironmentMaintenanceObservation | undefined): string | undefined =>
    value ? createHash('sha256').update(JSON.stringify(value)).digest('hex') : undefined;

  if (migration.include.database) {
    const sourceDatabaseSpec = params.sourceSpec.database!;
    const targetDatabaseSpec = params.targetSpec.database!;
    const source = params.sourceComponents.find((component) => component.type === sourceDatabaseSpec.engine);
    const target = params.targetComponents.find((component) => component.type === targetDatabaseSpec.engine);
    const sourceBindings = asRecord(source?.bindings);
    const sourceProvider = stringField(sourceBindings, 'provider');
    const marker = asRecord(asRecord(target?.bindings)?.dataMigration);
    const previousTarget = asRecord(asRecord(target?.bindings)?.dataMigrationPreviousTarget);
    const isComplete = completed(marker, migration.id, sourceName);
    const blockedReason = maintenanceBlockedReason
      ?? (!params.sourceEnvironment
      ? 'source_environment_not_tracked'
      : !source
        ? 'source_database_not_tracked'
        : sourceProvider !== sourceDatabaseSpec.provider
          ? 'source_database_binding_stale'
          : undefined);
    actions.push(migrationAction({
      id: `data-migration:${migration.id}:database`,
      resourceName: targetDatabaseSpec.engine,
      provider: targetDatabaseSpec.provider,
      operation: DATA_MIGRATION_OPERATIONS.databaseCopy,
      complete: isComplete,
      blockedReason: isComplete ? undefined : blockedReason,
      reason: isComplete
        ? `Database migration "${migration.id}" from "${sourceName}" is complete`
        : blockedReason
          ? `Database migration "${migration.id}" cannot resolve its tracked source`
          : `Copy one consistent ${sourceDatabaseSpec.engine} snapshot from "${sourceName}" into a fresh ${targetDatabaseSpec.provider} database`,
      metadata: {
        migrationId: migration.id,
        sourceEnvironment: sourceName,
        targetEnvironment: params.targetEnvironmentName,
        sourceProvider: sourceDatabaseSpec.provider,
        targetProvider: targetDatabaseSpec.provider,
        engine: targetDatabaseSpec.engine,
        sourceWritesMustBeStopped: true,
        sourceMaintenanceFingerprint: maintenanceFingerprint(params.sourceMaintenance),
        targetMaintenanceFingerprint: maintenanceFingerprint(params.targetMaintenance),
        ...(source
          ? {
              sourceComponentId: source.id,
              sourceExternalId: source.externalId ?? undefined,
            }
          : {}),
      },
    }));
    const previousProvider = stringField(previousTarget, 'provider');
    const previousExternalId = stringField(previousTarget, 'externalId');
    if (isComplete && previousProvider && previousExternalId) {
      actions.push(previousTargetDestroyAction({
        id: `data-migration:${migration.id}:database:previous-destroy`,
        resourceName: targetDatabaseSpec.engine,
        provider: previousProvider,
        operation: DATA_MIGRATION_OPERATIONS.databasePreviousDestroy,
        migrationId: migration.id,
        sourceEnvironment: sourceName,
        targetEnvironment: params.targetEnvironmentName,
        sourceProvider: sourceDatabaseSpec.provider,
        targetProvider: targetDatabaseSpec.provider,
        externalId: previousExternalId,
      }));
    }
  }

  const sourceStorageBindings = parseStorageBindings(params.sourceEnvironment);
  const targetStorageBindings = parseStorageBindings(params.targetEnvironment);
  for (const storageName of migration.include.storage) {
    const sourceStorageSpec = params.sourceSpec.storage![storageName];
    const targetStorageSpec = params.targetSpec.storage![storageName];
    const sourceBinding = sourceStorageBindings[storageName];
    const marker = asRecord(targetStorageBindings[storageName]?.dataMigration);
    const isComplete = completed(marker, migration.id, sourceName);
    const blockedReason = maintenanceBlockedReason
      ?? (!params.sourceEnvironment
      ? 'source_environment_not_tracked'
      : !sourceBinding
        ? 'source_storage_not_tracked'
        : sourceBinding.provider !== sourceStorageSpec.provider
          ? 'source_storage_binding_stale'
          : !sourceBinding.instanceScope
            ? 'source_storage_context_missing'
            : undefined);
    actions.push(migrationAction({
      id: `data-migration:${migration.id}:storage:${storageName}`,
      resourceName: storageName,
      provider: targetStorageSpec.provider,
      operation: DATA_MIGRATION_OPERATIONS.storageCopy,
      complete: isComplete,
      blockedReason: isComplete ? undefined : blockedReason,
      reason: isComplete
        ? `Storage migration "${migration.id}" for "${storageName}" is complete`
        : blockedReason
          ? `Storage migration "${migration.id}" cannot resolve tracked source "${storageName}"`
          : `Stream every object in "${storageName}" from "${sourceName}" into a fresh ${targetStorageSpec.provider} bucket`,
      metadata: {
        migrationId: migration.id,
        storageName,
        sourceEnvironment: sourceName,
        targetEnvironment: params.targetEnvironmentName,
        sourceProvider: sourceStorageSpec.provider,
        targetProvider: targetStorageSpec.provider,
        sourceExternalId: sourceBinding?.externalId,
        sourceInstanceScope: sourceBinding?.instanceScope,
        sourceWritesMustBeStopped: true,
        sourceMaintenanceFingerprint: maintenanceFingerprint(params.sourceMaintenance),
        targetMaintenanceFingerprint: maintenanceFingerprint(params.targetMaintenance),
      },
    }));
    if (isComplete && targetStorageBindings[storageName]?.previousTarget) {
      const previous = targetStorageBindings[storageName].previousTarget!;
      actions.push(previousTargetDestroyAction({
        id: `data-migration:${migration.id}:storage:${storageName}:previous-destroy`,
        resourceName: storageName,
        provider: previous.provider,
        operation: DATA_MIGRATION_OPERATIONS.storagePreviousDestroy,
        migrationId: migration.id,
        sourceEnvironment: sourceName,
        targetEnvironment: params.targetEnvironmentName,
        sourceProvider: sourceStorageSpec.provider,
        targetProvider: targetStorageSpec.provider,
        externalId: previous.externalId,
      }));
    }
  }

  const pending = actions.some((action) =>
    action.type === 'update'
    && (
      action.metadata?.operation === DATA_MIGRATION_OPERATIONS.databaseCopy
      || action.metadata?.operation === DATA_MIGRATION_OPERATIONS.storageCopy
    )
  );
  const pendingProviders = new Set<string>();
  for (const action of actions.filter((candidate) => candidate.type === 'update')) {
    const sourceProvider = stringField(action.metadata, 'sourceProvider');
    const targetProvider = stringField(action.metadata, 'targetProvider');
    if (sourceProvider) pendingProviders.add(sourceProvider);
    if (targetProvider) pendingProviders.add(targetProvider);
  }
  if (pending) {
    pendingProviders.add(params.sourceSpec.hosting.provider);
    pendingProviders.add(params.targetSpec.hosting.provider);
    pendingProviders.add('cloudflare');
  }
  return {
    actions,
    pending,
    providers: [...pendingProviders].sort(),
    warnings: pending
      ? [
          `Data migration "${migration.id}" is an isolated apply stage and remains blocked until maintenance is provider-verified in both "${sourceName}" and "${params.targetEnvironmentName}". After verified copies complete, run hv_plan again to rewire and deploy the target.`,
        ]
      : [],
  };
}

export function isDataMigrationAction(action: PlanAction): boolean {
  return typeof action.metadata?.operation === 'string'
    && DATA_MIGRATION_OPERATION_SET.has(action.metadata.operation);
}
