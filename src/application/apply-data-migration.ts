import { createHash } from 'node:crypto';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { DatabaseAccessAcquireResult } from '../domain/services/database-access.service.js';
import {
  acquireDatabaseComponentAccess,
  acquireManagedDatabaseAccess,
} from '../domain/services/database-access.service.js';
import { transferPostgresDatabase } from '../domain/services/postgres-transfer.service.js';
import {
  createS3ObjectClient,
  transferObjectStorageClients,
} from '../domain/services/object-storage-transfer.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import {
  DATA_MIGRATION_OPERATIONS,
} from '../domain/services/data-migration-plan.service.js';
import {
  parseStorageBindings,
  parseStorageProviderContexts,
  type StorageBinding,
} from '../domain/services/storage-plan.service.js';
import type { StorageContext } from '../domain/ports/storage.port.js';
import type { CommandContext } from './context.js';
import { observeEnvironmentMaintenance } from '../domain/services/environment-maintenance.service.js';
import type { IProviderAdapter } from '../domain/ports/provider.port.js';

interface StorageCandidate {
  migrationId: string;
  provider: string;
  externalId: string;
  region: string;
  context: StorageContext;
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

function exactStringRecord(left: unknown, right: unknown): boolean {
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftEntries = Object.entries(leftRecord).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(rightRecord).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => (
      typeof value === 'string'
      && value.length > 0
      && rightEntries[index]?.[0] === key
      && rightEntries[index]?.[1] === value
    ));
}

function candidateResourceName(project: string, environment: string, resource: string, migrationId: string): string {
  const suffix = createHash('sha256').update(migrationId).digest('hex').slice(0, 8);
  return `${project}-${environment}-${resource}-migration-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function stale(action: PlanAction, detail: string): ActionResult {
  return {
    success: false,
    status: 'blocked',
    message: `Data migration action "${action.id}" is stale`,
    error: `${detail} Re-run hv_plan.`,
  };
}

function accessFailure(label: string, result: Extract<DatabaseAccessAcquireResult, { ok: false }>): ActionResult {
  return {
    success: false,
    status: 'blocked',
    message: `Could not acquire bounded ${label} database access`,
    error: `Provider access is unavailable (${result.code}); no database binding was changed.`,
  };
}

async function verifyMigrationMaintenance(params: {
  project: Project;
  sourceEnvironment: Environment;
  targetEnvironment: Environment;
  sourceSpec: ProjectSpec['environments'][string];
  targetSpec: ProjectSpec['environments'][string];
  action: PlanAction;
}): Promise<ActionResult | null> {
  if (
    params.sourceSpec.maintenance?.enabled !== true
    || params.targetSpec.maintenance?.enabled !== true
  ) {
    return stale(params.action, 'Source and target maintenance are no longer desired.');
  }
  const observations = await Promise.all([
    [params.sourceEnvironment, params.sourceSpec] as const,
    [params.targetEnvironment, params.targetSpec] as const,
  ].map(async ([environment, spec]) => {
    const adapterResult = await adapterFactory.getProviderAdapter(spec.hosting.provider, params.project);
    if (!adapterResult.success || !adapterResult.adapter) return null;
    const adapter = adapterResult.adapter as IProviderAdapter;
    await adapter.configureTarget?.({ region: spec.hosting.region });
    return observeEnvironmentMaintenance({
      project: params.project,
      environment,
      environmentSpec: spec,
      hostingAdapter: adapter,
    });
  }));
  const [source, target] = observations;
  if (!source || !target || source.state !== 'active' || target.state !== 'active') {
    return stale(params.action, 'Provider-verified maintenance is no longer active in both environments.');
  }
  const sourceFingerprint = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const targetFingerprint = createHash('sha256').update(JSON.stringify(target)).digest('hex');
  if (
    sourceFingerprint !== stringField(asRecord(params.action.metadata), 'sourceMaintenanceFingerprint')
    || targetFingerprint !== stringField(asRecord(params.action.metadata), 'targetMaintenanceFingerprint')
  ) {
    return stale(params.action, 'The source or target maintenance observation changed after planning.');
  }
  return null;
}

function migrationIdentity(params: {
  action: PlanAction;
  spec: ProjectSpec;
  targetEnvironmentName: string;
}): {
  migrationId: string;
  sourceEnvironmentName: string;
  sourceProvider: string;
  targetProvider: string;
} | null {
  const metadata = asRecord(params.action.metadata);
  const migrationId = stringField(metadata, 'migrationId');
  const sourceEnvironmentName = stringField(metadata, 'sourceEnvironment');
  const targetEnvironment = stringField(metadata, 'targetEnvironment');
  const sourceProvider = stringField(metadata, 'sourceProvider');
  const targetProvider = stringField(metadata, 'targetProvider');
  const desired = params.spec.environments[params.targetEnvironmentName]?.dataMigration;
  if (
    !migrationId
    || !sourceEnvironmentName
    || !sourceProvider
    || !targetProvider
    || targetEnvironment !== params.targetEnvironmentName
    || desired?.id !== migrationId
    || desired.fromEnvironment !== sourceEnvironmentName
  ) return null;
  return { migrationId, sourceEnvironmentName, sourceProvider, targetProvider };
}

async function destroyDatabaseCandidate(params: {
  ctx: CommandContext;
  project: Project;
  environment: Environment;
  candidate: Component;
  provider: string;
}): Promise<boolean> {
  const adapterResult = await adapterFactory.getDatabaseAdapter(params.provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) return false;
  const receipt = await adapterResult.adapter.destroy(params.candidate);
  if (!receipt.success) return false;
  params.ctx.repos.components.delete(params.candidate.id);
  return true;
}

async function applyDatabaseMigration(params: {
  ctx: CommandContext;
  project: Project;
  spec: ProjectSpec;
  targetEnvironmentName: string;
  action: PlanAction;
}): Promise<ActionResult> {
  const identity = migrationIdentity(params);
  if (!identity) return stale(params.action, 'The reviewed migration id or environment identity changed.');
  const targetSpec = params.spec.environments[params.targetEnvironmentName];
  const sourceSpec = params.spec.environments[identity.sourceEnvironmentName];
  if (
    !targetSpec?.database
    || !sourceSpec?.database
    || !targetSpec.dataMigration?.include.database
    || targetSpec.database.provider !== identity.targetProvider
    || sourceSpec.database.provider !== identity.sourceProvider
    || targetSpec.database.engine !== params.action.resource.name
    || sourceSpec.database.engine !== params.action.resource.name
  ) return stale(params.action, 'The source or target database declaration changed.');

  const targetEnvironment = params.ctx.repos.environments.findByProjectAndName(params.project.id, params.targetEnvironmentName);
  const sourceEnvironment = params.ctx.repos.environments.findByProjectAndName(params.project.id, identity.sourceEnvironmentName);
  if (!targetEnvironment || !sourceEnvironment) {
    return stale(params.action, 'The source or target environment is not tracked locally.');
  }
  const maintenanceFailure = await verifyMigrationMaintenance({
    project: params.project,
    sourceEnvironment,
    targetEnvironment,
    sourceSpec,
    targetSpec,
    action: params.action,
  });
  if (maintenanceFailure) return maintenanceFailure;
  const alreadyActive = params.ctx.repos.components.findByEnvironmentAndType(
    targetEnvironment.id,
    targetSpec.database.engine
  );
  const alreadyMarker = asRecord(asRecord(alreadyActive?.bindings)?.dataMigration);
  if (
    stringField(alreadyMarker, 'id') === identity.migrationId
    && stringField(alreadyMarker, 'fromEnvironment') === identity.sourceEnvironmentName
    && stringField(alreadyMarker, 'completedAt')
  ) {
    return {
      success: true,
      message: `Database migration "${identity.migrationId}" was already complete; applied 0, skipped 1.`,
      data: {
        migrationId: identity.migrationId,
        applied: 0,
        skipped: 1,
        tableCount: alreadyMarker?.tableCount,
        totalRows: alreadyMarker?.totalRows,
        dumpBytes: alreadyMarker?.dumpBytes,
      },
    };
  }
  const source = params.ctx.repos.components.findByEnvironmentAndType(sourceEnvironment.id, sourceSpec.database.engine);
  const sourceBindings = asRecord(source?.bindings);
  if (
    !source
    || source.id !== stringField(asRecord(params.action.metadata), 'sourceComponentId')
    || source.externalId !== (stringField(asRecord(params.action.metadata), 'sourceExternalId') ?? null)
    || stringField(sourceBindings, 'provider') !== identity.sourceProvider
  ) return stale(params.action, 'The tracked source database identity changed.');

  const reviewedTarget = params.ctx.repos.components.findByEnvironmentAndType(
    targetEnvironment.id,
    targetSpec.database.engine
  );
  const reviewedTargetBindings = asRecord(reviewedTarget?.bindings);
  const reviewedTargetProvider = stringField(reviewedTargetBindings, 'provider');
  const reviewedTargetExternalId = reviewedTarget?.externalId
    ?? stringField(reviewedTargetBindings, 'instanceId');
  if (reviewedTarget && (!reviewedTargetProvider || !reviewedTargetExternalId)) {
    return stale(params.action, 'The current target database lacks a durable rollback identity.');
  }

  const candidateType = `data-migration:${identity.migrationId}:${targetSpec.database.engine}`;
  const lingering = params.ctx.repos.components.findByEnvironmentAndType(targetEnvironment.id, candidateType);
  if (lingering) {
    const lingeringProvider = stringField(asRecord(lingering.bindings), 'provider');
    if (lingeringProvider !== identity.targetProvider) {
      return stale(params.action, 'A retained migration candidate belongs to a different provider.');
    }
    const removed = await destroyDatabaseCandidate({
      ctx: params.ctx,
      project: params.project,
      environment: targetEnvironment,
      candidate: lingering,
      provider: identity.targetProvider,
    });
    if (!removed) {
      return {
        success: false,
        status: 'blocked',
        message: 'A previous database migration candidate still requires cleanup',
        error: `Hypervibe retained candidate ${lingering.externalId ?? lingering.id} and will not provision another one.`,
      };
    }
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(identity.targetProvider, params.project);
  if (!adapterResult.success || !adapterResult.adapter || adapterResult.adapter.name !== identity.targetProvider) {
    return { success: false, status: 'blocked', message: 'Target database adapter is unavailable', error: 'No database binding was changed.' };
  }
  await adapterResult.adapter.configureTarget?.({
    projectName: params.project.name,
    region: targetSpec.hosting.region,
  });
  const provisioned = await adapterResult.adapter.provision(targetSpec.database.engine, targetEnvironment, {
    databaseName: 'app',
    resourceName: candidateResourceName(params.project.name, params.targetEnvironmentName, targetSpec.database.engine, identity.migrationId),
  });
  if (!provisioned.receipt.success) {
    const partialExternalId = provisioned.component.externalId
      ?? stringField(asRecord(provisioned.component.bindings), 'instanceId');
    if (!partialExternalId) {
      return { success: false, message: 'Could not provision a fresh migration target', error: 'No database binding was changed.' };
    }
    const partial = params.ctx.repos.components.create({
      environmentId: targetEnvironment.id,
      type: candidateType,
      bindings: provisioned.component.bindings,
      externalId: partialExternalId,
    });
    const removed = await destroyDatabaseCandidate({
      ctx: params.ctx,
      project: params.project,
      environment: targetEnvironment,
      candidate: partial,
      provider: identity.targetProvider,
    });
    return {
      success: false,
      status: removed ? undefined : 'blocked',
      message: 'Could not provision a fresh migration target',
      error: removed
        ? 'The partial target was removed and no active database binding changed.'
        : `Partial candidate ${partialExternalId} is retained for cleanup before retry.`,
    };
  }
  const candidate = params.ctx.repos.components.create({
    environmentId: targetEnvironment.id,
    type: candidateType,
    bindings: provisioned.component.bindings,
    externalId: provisioned.component.externalId ?? undefined,
  });

  const cleanupCandidate = async (): Promise<boolean> => destroyDatabaseCandidate({
    ctx: params.ctx,
    project: params.project,
    environment: targetEnvironment,
    candidate,
    provider: identity.targetProvider,
  });
  const sourceAccess = await acquireManagedDatabaseAccess(params.project, sourceEnvironment);
  if (!sourceAccess.ok) {
    const removed = await cleanupCandidate();
    if (!removed) {
      return {
        success: false,
        status: 'blocked',
        message: 'Source access failed and the fresh database target requires cleanup',
        error: `Candidate ${candidate.externalId ?? candidate.id} is retained; no active database binding changed.`,
      };
    }
    return accessFailure('source', sourceAccess);
  }
  const targetAccess = await acquireDatabaseComponentAccess(params.project, targetEnvironment, candidate, identity.targetProvider);
  if (!targetAccess.ok) {
    const sourceCleanup = await sourceAccess.lease.release();
    const removed = await cleanupCandidate();
    if (!removed || sourceCleanup.status === 'failed') {
      return {
        success: false,
        status: 'blocked',
        message: 'Target access failed and migration cleanup is incomplete',
        error: removed
          ? 'Temporary source access cleanup remains pending; no active database binding changed.'
          : `Candidate ${candidate.externalId ?? candidate.id} is retained; no active database binding changed.`,
      };
    }
    return accessFailure('target', targetAccess);
  }

  let transfer: Awaited<ReturnType<typeof transferPostgresDatabase>> | undefined;
  let transferFailed = false;
  try {
    transfer = await sourceAccess.lease.withConnection((sourceUrl) =>
      targetAccess.lease.withConnection((targetUrl) => transferPostgresDatabase(sourceUrl, targetUrl))
    );
  } catch {
    transferFailed = true;
  }
  const [sourceCleanup, targetCleanup] = await Promise.all([
    sourceAccess.lease.release(),
    targetAccess.lease.release(),
  ]);
  if (transferFailed || !transfer || sourceCleanup.status === 'failed' || targetCleanup.status === 'failed') {
    const removed = await cleanupCandidate();
    return {
      success: false,
      status: sourceCleanup.status === 'failed' || targetCleanup.status === 'failed' ? 'blocked' : undefined,
      message: transferFailed ? 'Database snapshot transfer or verification failed' : 'Temporary database access cleanup failed',
      error: removed
        ? 'The fresh target was removed and no active database binding changed.'
        : `The fresh target is retained as candidate ${candidate.externalId ?? candidate.id}; cleanup is required before retry.`,
    };
  }

  const existing = params.ctx.repos.components.findByEnvironmentAndType(targetEnvironment.id, targetSpec.database.engine);
  const currentSource = params.ctx.repos.components.findById(source.id);
  const targetChanged = reviewedTarget
    ? !existing
      || existing.id !== reviewedTarget.id
      || existing.updatedAt.getTime() !== reviewedTarget.updatedAt.getTime()
      || existing.externalId !== reviewedTarget.externalId
    : Boolean(existing);
  const sourceChanged = !currentSource
    || currentSource.updatedAt.getTime() !== source.updatedAt.getTime()
    || currentSource.externalId !== source.externalId;
  if (targetChanged || sourceChanged) {
    const removed = await cleanupCandidate();
    return {
      success: false,
      status: 'blocked',
      message: 'Database bindings changed during the migration',
      error: removed
        ? 'The fresh target was removed; re-run hv_plan against the current source and target identities.'
        : `Candidate ${candidate.externalId ?? candidate.id} is retained for cleanup before replanning.`,
    };
  }
  const existingBindings = asRecord(existing?.bindings);
  const existingProvider = stringField(existingBindings, 'provider');
  const marker = {
    id: identity.migrationId,
    fromEnvironment: identity.sourceEnvironmentName,
    completedAt: new Date().toISOString(),
    sourceComponentId: source.id,
    sourceExternalId: source.externalId ?? undefined,
    tableCount: transfer.manifest.tables.length,
    totalRows: transfer.manifest.totalRows,
    dumpBytes: transfer.manifest.dumpBytes,
    sourceVersion: transfer.manifest.sourceVersion,
    targetVersion: transfer.targetVersion,
  };
  const nextBindings = {
    ...candidate.bindings,
    dataMigration: marker,
    ...(existing
      ? {
          dataMigrationPreviousTarget: {
            provider: existingProvider ?? identity.targetProvider,
            externalId: reviewedTargetExternalId,
            bindings: existing.bindings,
          },
        }
      : {}),
  };
  if (existing) {
    params.ctx.repos.components.update(existing.id, {
      bindings: nextBindings,
      externalId: candidate.externalId ?? undefined,
    });
  } else {
    params.ctx.repos.components.create({
      environmentId: targetEnvironment.id,
      type: targetSpec.database.engine,
      bindings: nextBindings,
      externalId: candidate.externalId ?? undefined,
    });
  }
  params.ctx.repos.components.delete(candidate.id);
  const primaryExternalId = candidate.externalId ?? stringField(asRecord(candidate.bindings), 'instanceId');
  if (primaryExternalId) {
    params.ctx.repos.environments.updatePlatformBindings(targetEnvironment.id, {
      databaseTopology: {
        primary: { provider: identity.targetProvider, externalId: primaryExternalId },
        replicas: {},
      },
    });
  }
  return {
    success: true,
    message: `Copied and verified ${transfer.manifest.tables.length} table(s) and ${transfer.manifest.totalRows} row(s). Run hv_plan again to rewire and deploy ${params.targetEnvironmentName}.`,
    data: {
      migrationId: identity.migrationId,
      tableCount: transfer.manifest.tables.length,
      totalRows: transfer.manifest.totalRows,
      dumpBytes: transfer.manifest.dumpBytes,
      sourceVersion: transfer.manifest.sourceVersion,
      targetVersion: transfer.targetVersion,
    },
  };
}

function storageCandidates(environment: Environment): Record<string, StorageCandidate> {
  return (asRecord(asRecord(environment.platformBindings.dataMigrationCandidates)?.storage) ?? {}) as Record<string, StorageCandidate>;
}

function persistStorageState(params: {
  ctx: CommandContext;
  environment: Environment;
  bindings: Record<string, StorageBinding>;
  contexts: Record<string, StorageContext>;
  candidates: Record<string, StorageCandidate>;
}): void {
  params.ctx.repos.environments.updatePlatformBindings(params.environment.id, {
    storage: params.bindings,
    storageProviders: params.contexts,
    dataMigrationCandidates: Object.keys(params.candidates).length > 0
      ? { storage: params.candidates }
      : undefined,
  });
}

async function applyStorageMigration(params: {
  ctx: CommandContext;
  project: Project;
  spec: ProjectSpec;
  targetEnvironmentName: string;
  action: PlanAction;
}): Promise<ActionResult> {
  const identity = migrationIdentity(params);
  if (!identity) return stale(params.action, 'The reviewed migration id or environment identity changed.');
  const storageName = stringField(asRecord(params.action.metadata), 'storageName');
  const targetSpec = params.spec.environments[params.targetEnvironmentName];
  const sourceSpec = params.spec.environments[identity.sourceEnvironmentName];
  const targetStorageSpec = storageName ? targetSpec?.storage?.[storageName] : undefined;
  const sourceStorageSpec = storageName ? sourceSpec?.storage?.[storageName] : undefined;
  if (
    !storageName
    || !targetStorageSpec
    || !sourceStorageSpec
    || !targetSpec.dataMigration?.include.storage.includes(storageName)
    || targetStorageSpec.provider !== identity.targetProvider
    || sourceStorageSpec.provider !== identity.sourceProvider
  ) return stale(params.action, 'The source or target storage declaration changed.');

  const targetEnvironment = params.ctx.repos.environments.findByProjectAndName(params.project.id, params.targetEnvironmentName);
  const sourceEnvironment = params.ctx.repos.environments.findByProjectAndName(params.project.id, identity.sourceEnvironmentName);
  if (!targetEnvironment || !sourceEnvironment) return stale(params.action, 'The source or target environment is not tracked locally.');
  const maintenanceFailure = await verifyMigrationMaintenance({
    project: params.project,
    sourceEnvironment,
    targetEnvironment,
    sourceSpec,
    targetSpec,
    action: params.action,
  });
  if (maintenanceFailure) return maintenanceFailure;
  const reviewedTargetBindings = parseStorageBindings(targetEnvironment);
  const alreadyMarker = asRecord(reviewedTargetBindings[storageName]?.dataMigration);
  if (
    stringField(alreadyMarker, 'id') === identity.migrationId
    && stringField(alreadyMarker, 'fromEnvironment') === identity.sourceEnvironmentName
    && stringField(alreadyMarker, 'completedAt')
  ) {
    return {
      success: true,
      message: `Storage migration "${identity.migrationId}" for "${storageName}" was already complete; applied 0, skipped 1.`,
      data: {
        migrationId: identity.migrationId,
        applied: 0,
        skipped: 1,
        objectCount: alreadyMarker?.objectCount,
        totalBytes: alreadyMarker?.totalBytes,
        manifestHash: alreadyMarker?.manifestHash,
      },
    };
  }
  const sourceBindings = parseStorageBindings(sourceEnvironment);
  const sourceBinding = sourceBindings[storageName];
  const sourceContext = sourceBinding?.instanceScope;
  const plannedSourceScope = asRecord(params.action.metadata)?.sourceInstanceScope;
  if (
    !sourceBinding
    || !sourceContext
    || sourceBinding.provider !== identity.sourceProvider
    || sourceBinding.externalId !== stringField(asRecord(params.action.metadata), 'sourceExternalId')
    || !exactStringRecord(sourceContext, plannedSourceScope)
  ) return stale(params.action, 'The tracked source bucket identity changed.');

  const sourceAdapterResult = await adapterFactory.getStorageAdapter(identity.sourceProvider, params.project);
  const targetAdapterResult = await adapterFactory.getStorageAdapter(identity.targetProvider, params.project);
  if (
    !sourceAdapterResult.success
    || !sourceAdapterResult.adapter
    || sourceAdapterResult.adapter.name !== identity.sourceProvider
    || !targetAdapterResult.success
    || !targetAdapterResult.adapter
    || targetAdapterResult.adapter.name !== identity.targetProvider
  ) return { success: false, status: 'blocked', message: 'Source or target storage adapter is unavailable', error: 'No storage binding was changed.' };
  const sourceAdapter = sourceAdapterResult.adapter;
  const targetAdapter = targetAdapterResult.adapter;
  const bindings = reviewedTargetBindings;
  const contexts = parseStorageProviderContexts(targetEnvironment);
  const candidates = storageCandidates(targetEnvironment);
  const lingering = candidates[storageName];
  if (lingering) {
    if (lingering.migrationId !== identity.migrationId || lingering.provider !== identity.targetProvider) {
      return stale(params.action, 'A retained storage candidate belongs to another migration.');
    }
    const removed = await targetAdapter.destroyBucket(targetEnvironment, lingering.context, lingering.externalId);
    if (!removed.success) {
      return { success: false, status: 'blocked', message: 'A previous storage migration candidate still requires cleanup', error: `Candidate ${lingering.externalId} is retained.` };
    }
    delete candidates[storageName];
    persistStorageState({ ctx: params.ctx, environment: targetEnvironment, bindings, contexts, candidates });
  }

  let targetContext = contexts[identity.targetProvider];
  const contextResult = await targetAdapter.ensureContext(
    params.project.name,
    targetEnvironment,
    targetContext,
    targetStorageSpec.region
  );
  if (!contextResult.receipt.success || !contextResult.context) {
    return { success: false, message: 'Could not resolve target storage context', error: 'No storage binding was changed.' };
  }
  targetContext = contextResult.context;
  const ensured = await targetAdapter.ensureBucket(
    targetEnvironment,
    targetContext,
    candidateResourceName(params.project.name, params.targetEnvironmentName, storageName, identity.migrationId),
    targetStorageSpec.region
  );
  if (!ensured.receipt.success || !ensured.externalId) {
    return { success: false, message: 'Could not provision a fresh migration bucket', error: 'No storage binding was changed.' };
  }
  const candidate: StorageCandidate = {
    migrationId: identity.migrationId,
    provider: identity.targetProvider,
    externalId: ensured.externalId,
    region: targetStorageSpec.region,
    context: targetContext,
  };
  candidates[storageName] = candidate;
  persistStorageState({
    ctx: params.ctx,
    environment: targetEnvironment,
    bindings,
    contexts: { ...contexts, [identity.targetProvider]: targetContext },
    candidates,
  });

  let transfer: Awaited<ReturnType<typeof transferObjectStorageClients>> | undefined;
  try {
    const [sourceClient, targetClient] = await Promise.all([
      sourceAdapter.openObjectTransfer
        ? sourceAdapter.openObjectTransfer(sourceEnvironment, sourceContext, sourceBinding.externalId)
        : sourceAdapter.getCredentials
          ? sourceAdapter.getCredentials(sourceEnvironment, sourceContext, sourceBinding.externalId).then(createS3ObjectClient)
          : Promise.reject(new Error('Source storage adapter exposes no object transfer data plane.')),
      targetAdapter.openObjectTransfer
        ? targetAdapter.openObjectTransfer(targetEnvironment, targetContext, candidate.externalId)
        : targetAdapter.getCredentials
          ? targetAdapter.getCredentials(targetEnvironment, targetContext, candidate.externalId).then(createS3ObjectClient)
          : Promise.reject(new Error('Target storage adapter exposes no object transfer data plane.')),
    ]);
    transfer = await transferObjectStorageClients(sourceClient, targetClient);
  } catch {
    // A failed copy never changes the active binding. Clean the fresh target;
    // if provider cleanup fails its exact id remains tracked for the next run.
  }
  if (!transfer) {
    const removed = await targetAdapter.destroyBucket(targetEnvironment, targetContext, candidate.externalId);
    if (removed.success) delete candidates[storageName];
    persistStorageState({
      ctx: params.ctx,
      environment: targetEnvironment,
      bindings,
      contexts: { ...contexts, [identity.targetProvider]: targetContext },
      candidates,
    });
    return {
      success: false,
      status: removed.success ? undefined : 'blocked',
      message: 'Object storage transfer or verification failed',
      error: removed.success
        ? 'The fresh target was removed and no active storage binding changed.'
        : `Candidate ${candidate.externalId} is retained for cleanup before retry.`,
    };
  }

  const latestSourceEnvironment = params.ctx.repos.environments.findById(sourceEnvironment.id);
  const latestTargetEnvironment = params.ctx.repos.environments.findById(targetEnvironment.id);
  const latestSourceBinding = parseStorageBindings(latestSourceEnvironment)[storageName];
  const latestTargetBindings = parseStorageBindings(latestTargetEnvironment);
  const latestTargetBinding = latestTargetBindings[storageName];
  const reviewedTargetBinding = bindings[storageName];
  const sourceChanged = !latestSourceBinding
    || latestSourceBinding.provider !== sourceBinding.provider
    || latestSourceBinding.externalId !== sourceBinding.externalId
    || !exactStringRecord(latestSourceBinding.instanceScope, sourceBinding.instanceScope)
    || latestSourceBinding.updatedAt !== sourceBinding.updatedAt;
  const targetChanged = reviewedTargetBinding
    ? !latestTargetBinding
      || latestTargetBinding.provider !== reviewedTargetBinding.provider
      || latestTargetBinding.externalId !== reviewedTargetBinding.externalId
      || latestTargetBinding.updatedAt !== reviewedTargetBinding.updatedAt
    : Boolean(latestTargetBinding);
  if (sourceChanged || targetChanged || !latestTargetEnvironment) {
    const removed = await targetAdapter.destroyBucket(targetEnvironment, targetContext, candidate.externalId);
    if (latestTargetEnvironment) {
      const latestCandidates = storageCandidates(latestTargetEnvironment);
      if (removed.success) delete latestCandidates[storageName];
      persistStorageState({
        ctx: params.ctx,
        environment: latestTargetEnvironment,
        bindings: latestTargetBindings,
        contexts: parseStorageProviderContexts(latestTargetEnvironment),
        candidates: latestCandidates,
      });
    }
    return {
      success: false,
      status: 'blocked',
      message: 'Storage bindings changed during the migration',
      error: removed.success
        ? 'The fresh target was removed; re-run hv_plan against the current source and target identities.'
        : `Candidate ${candidate.externalId} is retained for cleanup before replanning.`,
    };
  }

  const existing = bindings[storageName];
  const nextBinding: StorageBinding = {
    provider: identity.targetProvider,
    externalId: candidate.externalId,
    instanceScope: targetContext,
    region: targetStorageSpec.region,
    services: [],
    envKeys: targetAdapter.runtimeEnvKeys(storageName),
    updatedAt: new Date().toISOString(),
    dataMigration: {
      id: identity.migrationId,
      fromEnvironment: identity.sourceEnvironmentName,
      completedAt: new Date().toISOString(),
      objectCount: transfer.objectCount,
      totalBytes: transfer.totalBytes,
      manifestHash: transfer.manifestHash,
    },
    ...(existing
      ? {
          previousTarget: {
            provider: existing.provider,
            externalId: existing.externalId,
            instanceScope: existing.instanceScope ?? contexts[existing.provider],
            region: existing.region,
          },
        }
      : {}),
  };
  delete candidates[storageName];
  persistStorageState({
    ctx: params.ctx,
    environment: targetEnvironment,
    bindings: { ...bindings, [storageName]: nextBinding },
    contexts: { ...contexts, [identity.targetProvider]: targetContext },
    candidates,
  });
  return {
    success: true,
    message: `Copied and verified ${transfer.objectCount} object(s) (${transfer.totalBytes} bytes). Run hv_plan again to rewire and deploy ${params.targetEnvironmentName}.`,
    data: {
      migrationId: identity.migrationId,
      objectCount: transfer.objectCount,
      totalBytes: transfer.totalBytes,
      manifestHash: transfer.manifestHash,
    },
  };
}

async function destroyPreviousDatabaseTarget(params: {
  ctx: CommandContext;
  project: Project;
  spec: ProjectSpec;
  targetEnvironmentName: string;
  action: PlanAction;
}): Promise<ActionResult> {
  const identity = migrationIdentity(params);
  if (!identity) return stale(params.action, 'The reviewed migration identity changed.');
  const targetSpec = params.spec.environments[params.targetEnvironmentName];
  if (!targetSpec?.database || targetSpec.dataMigration?.id !== identity.migrationId) {
    return stale(params.action, 'The target database migration declaration changed.');
  }
  const environment = params.ctx.repos.environments.findByProjectAndName(params.project.id, params.targetEnvironmentName);
  const component = environment
    ? params.ctx.repos.components.findByEnvironmentAndType(environment.id, targetSpec.database.engine)
    : null;
  const bindings = asRecord(component?.bindings);
  const marker = asRecord(bindings?.dataMigration);
  const previous = asRecord(bindings?.dataMigrationPreviousTarget);
  const previousBindings = asRecord(previous?.bindings);
  const previousExternalId = stringField(previous, 'externalId');
  if (
    component
    && stringField(marker, 'id') === identity.migrationId
    && stringField(marker, 'fromEnvironment') === identity.sourceEnvironmentName
    && !previous
  ) {
    return {
      success: true,
      message: `Previous database migration target was already removed; applied 0, skipped 1.`,
      data: { migrationId: identity.migrationId, applied: 0, skipped: 1 },
    };
  }
  if (
    !component
    || stringField(marker, 'id') !== identity.migrationId
    || stringField(marker, 'fromEnvironment') !== identity.sourceEnvironmentName
    || stringField(previous, 'provider') !== params.action.resource.provider
    || previousExternalId !== stringField(asRecord(params.action.metadata), 'previousExternalId')
    || !previousExternalId
    || !previousBindings
  ) return stale(params.action, 'The retained database rollback target changed.');

  const adapterResult = await adapterFactory.getDatabaseAdapter(params.action.resource.provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter || adapterResult.adapter.name !== params.action.resource.provider) {
    return { success: false, status: 'blocked', message: 'Previous database adapter is unavailable', error: 'The rollback target remains retained.' };
  }
  const receipt = await adapterResult.adapter.destroy({
    ...component,
    bindings: previousBindings,
    externalId: previousExternalId,
  });
  if (!receipt.success) {
    return { success: false, message: 'Could not delete the previous database target', error: 'The rollback target remains retained.' };
  }
  const nextBindings = { ...bindings };
  delete nextBindings.dataMigrationPreviousTarget;
  params.ctx.repos.components.update(component.id, {
    bindings: nextBindings,
    externalId: component.externalId ?? undefined,
  });
  return { success: true, message: `Deleted previous ${params.action.resource.provider} database target ${previousExternalId}` };
}

async function destroyPreviousStorageTarget(params: {
  ctx: CommandContext;
  project: Project;
  spec: ProjectSpec;
  targetEnvironmentName: string;
  action: PlanAction;
}): Promise<ActionResult> {
  const identity = migrationIdentity(params);
  if (!identity) return stale(params.action, 'The reviewed migration identity changed.');
  const storageName = params.action.resource.name;
  const targetSpec = params.spec.environments[params.targetEnvironmentName];
  if (!targetSpec?.storage?.[storageName] || targetSpec.dataMigration?.id !== identity.migrationId) {
    return stale(params.action, 'The target storage migration declaration changed.');
  }
  const environment = params.ctx.repos.environments.findByProjectAndName(params.project.id, params.targetEnvironmentName);
  if (!environment) return stale(params.action, 'The target environment is not tracked locally.');
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const binding = bindings[storageName];
  const marker = asRecord(binding?.dataMigration);
  const previous = binding?.previousTarget;
  const previousExternalId = stringField(asRecord(params.action.metadata), 'previousExternalId');
  const context = previous?.instanceScope ?? (previous ? contexts[previous.provider] : undefined);
  if (
    binding
    && stringField(marker, 'id') === identity.migrationId
    && stringField(marker, 'fromEnvironment') === identity.sourceEnvironmentName
    && !previous
  ) {
    return {
      success: true,
      message: `Previous storage migration target was already removed; applied 0, skipped 1.`,
      data: { migrationId: identity.migrationId, applied: 0, skipped: 1 },
    };
  }
  if (
    !binding
    || !previous
    || !context
    || stringField(marker, 'id') !== identity.migrationId
    || stringField(marker, 'fromEnvironment') !== identity.sourceEnvironmentName
    || previous.provider !== params.action.resource.provider
    || previous.externalId !== previousExternalId
  ) return stale(params.action, 'The retained storage rollback target changed.');

  const adapterResult = await adapterFactory.getStorageAdapter(previous.provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter || adapterResult.adapter.name !== previous.provider) {
    return { success: false, status: 'blocked', message: 'Previous storage adapter is unavailable', error: 'The rollback target remains retained.' };
  }
  const receipt = await adapterResult.adapter.destroyBucket(environment, context, previous.externalId);
  if (!receipt.success) {
    return { success: false, message: 'Could not delete the previous storage target', error: 'The rollback target remains retained.' };
  }
  const nextBinding = { ...binding };
  delete nextBinding.previousTarget;
  persistStorageState({
    ctx: params.ctx,
    environment,
    bindings: { ...bindings, [storageName]: nextBinding },
    contexts,
    candidates: storageCandidates(environment),
  });
  return { success: true, message: `Deleted previous ${previous.provider} storage target ${previous.externalId}` };
}

export async function applyDataMigrationAction(params: {
  ctx: CommandContext;
  project: Project;
  spec: ProjectSpec;
  targetEnvironmentName: string;
  action: PlanAction;
}): Promise<ActionResult> {
  if (params.action.metadata?.operation === DATA_MIGRATION_OPERATIONS.databaseCopy) {
    return applyDatabaseMigration(params);
  }
  if (params.action.metadata?.operation === DATA_MIGRATION_OPERATIONS.storageCopy) {
    return applyStorageMigration(params);
  }
  if (params.action.metadata?.operation === DATA_MIGRATION_OPERATIONS.databasePreviousDestroy) {
    return destroyPreviousDatabaseTarget(params);
  }
  if (params.action.metadata?.operation === DATA_MIGRATION_OPERATIONS.storagePreviousDestroy) {
    return destroyPreviousStorageTarget(params);
  }
  return stale(params.action, 'The migration operation is unsupported.');
}
