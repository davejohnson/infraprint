import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { IProviderAdapter } from '../ports/provider.port.js';
import {
  createStorageCreateRecovery,
  parseStorageCreateRecovery,
  parseStorageCreateRecoveryMap,
  type StorageContext,
  type StorageCreateRecovery,
} from '../ports/storage.port.js';
import { withStorageInstanceScopes } from './storage-instance-identity.js';
import { S3_STORAGE_RUNTIME_ENV_KEYS } from './storage-runtime-env.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';

export const STORAGE_OPERATIONS = {
  ensure: 'storageEnsure',
  wire: 'storageWire',
  unwire: 'storageUnwire',
  destroy: 'storageDestroy',
} as const;

const STORAGE_OPERATION_SET = new Set<string>(Object.values(STORAGE_OPERATIONS));
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

export interface StorageBinding {
  provider: string;
  externalId: string;
  instanceScope?: StorageContext;
  region: string;
  services: string[];
  envKeys: string[];
  updatedAt?: string;
  dataMigration?: Record<string, unknown>;
  previousTarget?: {
    provider: string;
    externalId: string;
    instanceScope?: StorageContext;
    region: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type StorageCreateRecoveryState = {
  present: boolean;
  malformed: boolean;
  raw: Record<string, unknown>;
  parsed: Record<string, StorageCreateRecovery>;
};

function storageCreateRecoveryState(
  environment: Pick<Environment, 'platformBindings'> | null
): StorageCreateRecoveryState {
  const value = environment?.platformBindings.storageCreateRecovery;
  if (value === undefined) {
    return { present: false, malformed: false, raw: {}, parsed: {} };
  }
  const raw = asRecord(value);
  if (!raw) {
    return { present: true, malformed: true, raw: {}, parsed: {} };
  }
  const parsed = parseStorageCreateRecoveryMap(raw);
  return parsed
    ? { present: true, malformed: false, raw, parsed }
    : { present: true, malformed: true, raw, parsed: {} };
}

function storageContext(value: unknown): StorageContext | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length === 0 || entries.some(([, item]) => typeof item !== 'string' || item.length === 0)) {
    return undefined;
  }
  return Object.fromEntries(entries) as StorageContext;
}

function scopesMatch(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => (
      rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value
    ));
}

function currentStorageContext(
  environment: Pick<Environment, 'platformBindings'> | null,
  provider: string,
  hostingProvider: string
): StorageContext | undefined {
  const contexts = asRecord(environment?.platformBindings.storageProviders);
  const providerContext = storageContext(contexts?.[provider]);
  if (providerContext) return providerContext;
  if (provider !== hostingProvider) return undefined;
  const projectId = environment?.platformBindings.projectId;
  const environmentId = environment?.platformBindings.environmentId;
  return typeof projectId === 'string' && projectId.length > 0
    && typeof environmentId === 'string' && environmentId.length > 0
    ? { projectId, environmentId }
    : undefined;
}

function recoveryMatchesTarget(
  recovery: StorageCreateRecovery,
  name: string,
  provider: string,
  context: StorageContext | undefined
): boolean {
  return recovery.resourceName === name
    && recovery.provider === provider
    && (!context || scopesMatch(recovery.providerScope, context));
}

function storageRecoveryGuidance(): string {
  return 'Use hv_inspect to identify the exact bucket and provider scope, then use the provider\'s hv_import storage-adoption workflow to bind that exact resource. The recovery marker is not deletion authority.';
}

function storageIdentityMatches(binding: StorageBinding, item: NonNullable<ObservedState['storage']>[number]): boolean {
  return binding.externalId === item.externalId
    && binding.provider === item.provider
    && scopesMatch(binding.instanceScope, item.instanceScope);
}

function storageObservationKnown(observed: ObservedState | null, provider: string): boolean {
  if (!observed) return true;
  const byProvider = observed.completeness?.storageByProvider;
  return byProvider
    ? byProvider[provider] === 'complete'
    : observed.completeness?.storage !== 'unknown';
}

function boundServiceId(environment: Environment | null, serviceName: string): string | undefined {
  const services = asRecord(environment?.platformBindings.services);
  const binding = asRecord(services?.[serviceName]);
  return typeof binding?.serviceId === 'string' && binding.serviceId.length > 0
    ? binding.serviceId
    : undefined;
}

export function parseStorageBindings(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageBinding> {
  const storage = asRecord(environment?.platformBindings.storage) ?? {};
  const contexts = asRecord(environment?.platformBindings.storageProviders) ?? {};
  return withStorageInstanceScopes(storage, contexts) as Record<string, StorageBinding>;
}

export function parseStorageProviderContexts(environment: Pick<Environment, 'platformBindings'> | null): Record<string, StorageContext> {
  return (asRecord(environment?.platformBindings.storageProviders) ?? {}) as Record<string, StorageContext>;
}

export function storageEnvKeys(name: string): string[] {
  void name;
  return [...S3_STORAGE_RUNTIME_ENV_KEYS];
}

function action(params: {
  id: string; type: PlanAction['type']; name: string; provider: string; operation: string; reason: string;
  verified: boolean; metadata?: Record<string, unknown>; dependsOn?: string[]; requiresConfirm?: boolean; billable?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'storage', name: params.name, provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.operation === STORAGE_OPERATIONS.destroy ? { dataBearing: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    ...(params.billable ? { billable: true } : {}),
    ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    metadata: { operation: params.operation, storageName: params.name, ...(params.metadata ?? {}) },
  };
}

export function planStorage(params: {
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
}): { actions: PlanAction[]; warnings: string[]; unmanaged: Array<{ kind: 'storage'; name: string; detail?: string }> } {
  const desired = params.environmentSpec.storage ?? {};
  const bindings = parseStorageBindings(params.environment);
  const live = params.observed?.storage ?? [];
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const unmanaged: Array<{ kind: 'storage'; name: string; detail?: string }> = [];
  const recoveries = storageCreateRecoveryState(params.environment);

  if (recoveries.malformed) {
    const actionNames = new Set<string>([
      ...Object.keys(desired),
      ...Object.keys(recoveries.raw).filter((name) => name.trim().length > 0),
    ]);
    if (actionNames.size === 0) actionNames.add('storage-create-recovery');
    for (const name of actionNames) {
      const desiredSpec = desired[name];
      const rawMarker = asRecord(recoveries.raw[name]);
      const provider = desiredSpec?.provider
        ?? (typeof rawMarker?.provider === 'string' && rawMarker.provider.trim().length > 0
          ? rawMarker.provider
          : params.environmentSpec.hosting.provider);
      actions.push(action({
        id: desiredSpec ? `storage:${name}` : `storage:${name}:create-recovery`,
        type: 'update',
        name,
        provider,
        operation: STORAGE_OPERATIONS.ensure,
        verified: false,
        reason: `Storage create-recovery state for "${name}" is malformed; all mutations are blocked`,
        metadata: { blockedReason: 'malformed_storage_create_recovery' },
      }));
    }
    warnings.push('Malformed retained storage-create recovery state blocks storage reconciliation until it is explicitly repaired.');
    return { actions, warnings, unmanaged };
  }

  for (const [name, spec] of Object.entries(desired)) {
    const recovery = recoveries.parsed[name];
    if (recovery) {
      const context = currentStorageContext(
        params.environment,
        spec.provider,
        params.environmentSpec.hosting.provider
      );
      const exactTarget = recoveryMatchesTarget(recovery, name, spec.provider, context);
      actions.push(action({
        id: `storage:${name}`,
        type: 'update',
        name,
        provider: spec.provider,
        operation: STORAGE_OPERATIONS.ensure,
        verified: false,
        reason: exactTarget
          ? `Storage "${name}" has a retained create outcome that requires explicit resolution`
          : `Storage "${name}" has create-recovery state that does not match its current provider or scope`,
        metadata: {
          blockedReason: exactTarget
            ? 'storage_create_recovery_required'
            : 'storage_create_recovery_target_mismatch',
          storageCreateRecovery: recovery,
        },
      }));
      continue;
    }
    const binding = bindings[name];
    const observationKnown = storageObservationKnown(params.observed, spec.provider);
    if (params.observed && !observationKnown) {
      const ensureId = `storage:${name}`;
      actions.push(action({
        id: ensureId,
        type: binding ? 'noop' : 'update',
        name,
        provider: spec.provider,
        operation: STORAGE_OPERATIONS.ensure,
        verified: false,
        reason: binding
          ? `Preserving locally bound storage "${name}" because live observation is unknown`
          : `Cannot verify whether storage "${name}" exists`,
        ...(!binding ? { metadata: { blockedReason: 'storage_observation_unknown' } } : {}),
      }));
      for (const serviceName of spec.injectInto) {
        const wired = binding?.services.includes(serviceName) === true;
        actions.push(action({
          id: `storage:${name}:wiring:${serviceName}`,
          type: wired ? 'noop' : 'update',
          name,
          provider: spec.provider,
          operation: STORAGE_OPERATIONS.wire,
          verified: false,
          reason: wired
            ? `Preserving local storage wiring for "${serviceName}" because live observation is unknown`
            : `Cannot verify storage wiring for "${serviceName}"`,
          dependsOn: [ensureId, `service:${serviceName}`],
          ...(!wired ? { metadata: { serviceName, blockedReason: 'storage_observation_unknown' } } : {}),
        }));
      }
      continue;
    }
    const boundObserved = binding
      ? live.filter((item) => storageIdentityMatches(binding, item))
      : [];
    const nameCandidates = binding
      ? []
      : live.filter((item) => item.name.toLowerCase() === name.toLowerCase());
    const observed = binding
      ? boundObserved.length === 1 ? boundObserved[0] : undefined
      : nameCandidates.length === 1 ? nameCandidates[0] : undefined;
    const ensureId = `storage:${name}`;
    const conflict = !binding && nameCandidates.length > 0;
    const ambiguousConflict = nameCandidates.length > 1;
    const providerDrift = Boolean(binding && binding.provider !== spec.provider);
    const regionDrift = Boolean(binding && observed?.region && observed.region !== spec.region);
    const bindingIdentityMismatch = Boolean(
      binding
      && !providerDrift
      && params.observed
      && observationKnown
      && boundObserved.length !== 1
    );
    const locallyBoundWithoutObservation = Boolean(binding && !params.observed);
    actions.push(action({
      id: ensureId,
      type: conflict || providerDrift || regionDrift || bindingIdentityMismatch
        ? 'update'
        : observed && binding || locallyBoundWithoutObservation
          ? 'noop'
          : 'create',
      name,
      provider: spec.provider,
      operation: STORAGE_OPERATIONS.ensure,
      verified: Boolean(params.observed && observationKnown),
      billable: !binding && nameCandidates.length === 0,
      reason: providerDrift
        ? `Storage provider changed from ${binding?.provider} to ${spec.provider}; declare a one-use dataMigration before replacing durable data`
        : conflict
        ? ambiguousConflict
          ? `Multiple live buckets named "${name}" exist; explicit identity cleanup or adoption is required`
          : `A live bucket named "${name}" exists but is not managed by Hypervibe; explicit hv_import adoption is required`
        : bindingIdentityMismatch
          ? `The locally bound bucket "${name}" is absent or has a different provider scope; refusing to create a replacement`
        : regionDrift
          ? `Bucket region is immutable and drifted from ${observed?.region} to ${spec.region}; migrate data explicitly before replacement`
          : observed && binding || locallyBoundWithoutObservation
            ? `Object storage bucket "${name}" is in sync`
            : `Object storage bucket "${name}" is not deployed`,
      metadata: {
        region: spec.region,
        services: spec.injectInto,
        ...(providerDrift ? { blockedReason: 'provider_migration_required', externalId: binding?.externalId } : {}),
        ...(conflict ? ambiguousConflict
          ? {
              blockedReason: 'ambiguous_storage_identity',
              externalIds: nameCandidates.map((candidate) => candidate.externalId).sort(),
            }
          : { blockedReason: 'unmanaged_conflict', externalId: observed?.externalId } : {}),
        ...(bindingIdentityMismatch ? {
          blockedReason: 'storage_binding_identity_mismatch',
          externalId: binding?.externalId,
          instanceScope: binding?.instanceScope ?? null,
        } : {}),
        ...(regionDrift ? { blockedReason: 'immutable_region', externalId: observed?.externalId } : {}),
      },
    }));
    if (conflict) {
      for (const candidate of nameCandidates) {
        unmanaged.push({ kind: 'storage', name: candidate.name, detail: `${candidate.provider} bucket requires explicit hv_import adoption` });
      }
    }
    if (bindingIdentityMismatch) {
      for (const candidate of live.filter((item) => (
        item.externalId === binding?.externalId
        || item.name.toLowerCase() === name.toLowerCase()
      ))) {
        unmanaged.push({
          kind: 'storage',
          name: candidate.name,
          detail: `${candidate.provider} bucket ${candidate.externalId} does not match the durable local binding scope`,
        });
      }
    }

    for (const serviceName of spec.injectInto) {
      const serviceId = boundServiceId(params.environment, serviceName);
      const observedServiceCandidates = serviceId
        ? params.observed?.services.filter((service) => service.externalId === serviceId) ?? []
        : [];
      const observedService = observedServiceCandidates.length === 1
        ? observedServiceCandidates[0]
        : undefined;
      const sameNameCandidates = params.observed?.services.filter((service) => service.name === serviceName) ?? [];
      const serviceIdentityMismatch = Boolean(params.observed && (
        serviceId
          ? observedServiceCandidates.length !== 1
          : sameNameCandidates.length > 0
      ));
      const keys = binding?.envKeys ?? storageEnvKeys(name);
      const wired = !serviceIdentityMismatch
        && binding?.services.includes(serviceName)
        && keys.every((key) => observedService?.envVarKeys.includes(key));
      actions.push(action({
        id: `storage:${name}:wiring:${serviceName}`,
        type: wired ? 'noop' : 'update',
        name,
        provider: spec.provider,
        operation: STORAGE_OPERATIONS.wire,
        verified: params.observed !== null,
        reason: serviceIdentityMismatch
          ? `Cannot safely resolve the durable provider identity for service "${serviceName}"`
          : wired
            ? `Storage "${name}" is wired to service "${serviceName}"`
            : `Wire storage "${name}" to service "${serviceName}"`,
        dependsOn: [ensureId, `service:${serviceName}`],
        metadata: {
          serviceName,
          envKeys: keys,
          ...(serviceId ? { serviceId } : { serviceIdPending: true }),
          ...(serviceIdentityMismatch ? {
            blockedReason: 'service_binding_identity_mismatch',
          } : {}),
        },
      }));
    }
    for (const serviceName of binding?.services ?? []) {
      if (spec.injectInto.includes(serviceName)) continue;
      const serviceId = boundServiceId(params.environment, serviceName);
      actions.push(action({
        id: `storage:${name}:unwiring:${serviceName}`,
        type: 'update', name, provider: spec.provider, operation: STORAGE_OPERATIONS.unwire,
        verified: params.observed !== null,
        reason: `Remove storage "${name}" access from service "${serviceName}"`,
        metadata: {
          serviceName,
          envKeys: binding.envKeys,
          ...(serviceId
            ? { serviceId }
            : { blockedReason: 'service_binding_identity_mismatch' }),
        },
      }));
    }
  }

  for (const [name, recovery] of Object.entries(recoveries.parsed)) {
    if (desired[name]) continue;
    actions.push(action({
      id: `storage:${name}:create-recovery`,
      type: 'update',
      name,
      provider: recovery.provider,
      operation: STORAGE_OPERATIONS.ensure,
      verified: false,
      reason: `Storage "${name}" was removed from the spec, but a possibly committed create still requires explicit resolution`,
      metadata: {
        blockedReason: 'orphaned_storage_create_recovery',
        storageCreateRecovery: recovery,
      },
    }));
  }

  for (const [name, binding] of Object.entries(bindings)) {
    if (desired[name]) continue;
    if (recoveries.parsed[name]) continue;
    const observationKnown = storageObservationKnown(params.observed, binding.provider);
    if (params.observed && !observationKnown) {
      actions.push(action({
        id: `storage:${name}:observation-blocked`,
        type: 'update',
        name,
        provider: binding.provider,
        operation: STORAGE_OPERATIONS.destroy,
        verified: false,
        reason: `Storage "${name}" was removed from the spec, but observation is unknown; refusing to unwire or destroy it`,
        metadata: { blockedReason: 'storage_observation_unknown', externalId: binding.externalId },
      }));
      continue;
    }
    for (const serviceName of binding.services) {
      const serviceId = boundServiceId(params.environment, serviceName);
      actions.push(action({
        id: `storage:${name}:unwiring:${serviceName}`,
        type: 'update', name, provider: binding.provider, operation: STORAGE_OPERATIONS.unwire,
        verified: params.observed !== null, reason: `Remove storage "${name}" access from service "${serviceName}"`,
        metadata: {
          serviceName,
          envKeys: binding.envKeys,
          ...(serviceId
            ? { serviceId }
            : { blockedReason: 'service_binding_identity_mismatch' }),
        },
      }));
    }
    const observed = live.find((item) => storageIdentityMatches(binding, item));
    actions.push(action({
      id: `storage:${name}:destroy`, type: 'destroy', name, provider: binding.provider,
      operation: STORAGE_OPERATIONS.destroy, verified: Boolean(observed), requiresConfirm: true,
      reason: `Storage "${name}" was removed from the spec; deleting it loses all stored objects`,
      dependsOn: binding.services.map((serviceName) => `storage:${name}:unwiring:${serviceName}`),
      metadata: {
        externalId: binding.externalId,
        instanceScope: binding.instanceScope ?? null,
        region: binding.region,
        ...(observed?.objectCount !== undefined ? { objectCount: observed.objectCount } : {}),
        ...(observed?.sizeBytes !== undefined ? { sizeBytes: observed.sizeBytes } : {}),
      },
    }));
  }

  for (const item of live.filter((candidate) => storageObservationKnown(params.observed, candidate.provider))) {
    if (Object.values(bindings).some((binding) => storageIdentityMatches(binding, item)) || desired[item.name]) continue;
    unmanaged.push({ kind: 'storage', name: item.name, detail: `${item.provider} object bucket exists but is not managed by Hypervibe` });
  }
  return { actions, warnings, unmanaged };
}

export function isStorageAction(planAction: PlanAction): boolean {
  return typeof planAction.metadata?.operation === 'string' && STORAGE_OPERATION_SET.has(planAction.metadata.operation);
}

export async function resolveStorageServiceEnvVars(
  project: Project,
  environmentSpec: EnvironmentSpec,
  environment: Environment | null
): Promise<Record<string, Record<string, string>> | undefined> {
  if (!environment || !environmentSpec.storage) return undefined;
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const output: Record<string, Record<string, string>> = {};
  for (const [name, spec] of Object.entries(environmentSpec.storage)) {
    const binding = bindings[name];
    if (!binding) continue;
    const adapterResult = await adapterFactory.getStorageAdapter(spec.provider, project);
    if (!adapterResult.success || !adapterResult.adapter) continue;
    const root = environment.platformBindings as { projectId?: string; environmentId?: string };
    const context = binding.instanceScope ?? contexts[spec.provider] ?? (environmentSpec.hosting.provider === spec.provider && root.projectId && root.environmentId
      ? { projectId: root.projectId, environmentId: root.environmentId }
      : undefined);
    if (!context) continue;
    const vars = await adapterResult.adapter.getRuntimeEnv(environment, context, binding.externalId, name);
    for (const serviceName of spec.injectInto) output[serviceName] = { ...(output[serviceName] ?? {}), ...vars };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function persist(
  environment: Environment,
  storage: Record<string, StorageBinding>,
  storageProviders: Record<string, StorageContext>,
  storageCreateRecovery?: Record<string, StorageCreateRecovery> | null
): void {
  envRepo.updatePlatformBindings(environment.id, {
    storage,
    storageProviders,
    ...(storageCreateRecovery !== undefined ? {
      storageCreateRecovery: storageCreateRecovery && Object.keys(storageCreateRecovery).length > 0
        ? storageCreateRecovery
        : undefined,
    } : {}),
  });
}

function persistStorageCreateRecovery(
  environmentId: string,
  storageName: string,
  recovery: StorageCreateRecovery
): string | undefined {
  try {
    const latest = envRepo.findById(environmentId);
    if (!latest) return `Environment ${environmentId} is missing; storage create-recovery state could not be retained.`;
    const current = storageCreateRecoveryState(latest);
    if (current.malformed) {
      return 'Existing storage create-recovery state is malformed; Hypervibe refused to overwrite evidence of a possibly committed create.';
    }
    const updated = envRepo.updatePlatformBindings(environmentId, {
      storageCreateRecovery: { ...current.parsed, [storageName]: recovery },
    });
    return updated
      ? undefined
      : `Environment ${environmentId} disappeared before storage create-recovery state could be retained.`;
  } catch (error) {
    return `Storage create-recovery persistence reported an error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function validateReturnedStorageRecovery(input: {
  value: unknown;
  provider: string;
  resourceName: string;
  providerScope: StorageContext;
  externalId?: string;
}): StorageCreateRecovery | null {
  const recovery = parseStorageCreateRecovery(input.value);
  if (!recovery
    || recovery.provider !== input.provider
    || recovery.resourceName !== input.resourceName
    || !scopesMatch(recovery.providerScope, input.providerScope)
    || (input.externalId !== undefined && recovery.externalId !== input.externalId)) {
    return null;
  }
  return recovery;
}

function storageCreateMayHaveCommitted(input: {
  success: boolean;
  externalId?: string;
  data?: Record<string, unknown>;
}): boolean {
  if (input.success && !input.externalId) return true;
  if (input.success) return false;
  const phase = input.data?.phase;
  return input.data?.storageCreateRecovery !== undefined
    || input.data?.created === true
    || (
      (phase === 'bucketCreate' || phase === 'storageCreate')
      && input.data?.mutationAttempted !== false
    )
    // ensureBucket is the create mutation boundary. Unless the adapter gives
    // an explicit definitive-rejection signal, a failed receipt may have been
    // returned after the provider committed.
    || input.data?.mutationAttempted !== false;
}

function conservativeStorageRecovery(input: {
  provider: string;
  resourceName: string;
  providerScope: StorageContext;
  externalId?: string;
}): StorageCreateRecovery {
  return createStorageCreateRecovery({
    provider: input.provider,
    resourceName: input.resourceName,
    providerScope: input.providerScope,
    state: input.externalId ? 'mismatched' : 'unresolved',
    ...(input.externalId ? { externalId: input.externalId } : {}),
  });
}

export async function applyStorageAction(params: {
  project: Project; envName: string; environmentSpec: EnvironmentSpec; action: PlanAction;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const environment = envRepo.findByProjectAndName(params.project.id, params.envName);
  if (!environment) return { success: false, message: 'Environment not found locally', error: `No local environment "${params.envName}"` };
  const name = typeof params.action.metadata?.storageName === 'string'
    ? params.action.metadata.storageName
    : '';
  const operation = String(params.action.metadata?.operation ?? '');
  const recoveryState = storageCreateRecoveryState(environment);
  const retainedRecovery = recoveryState.parsed[name];
  if (recoveryState.malformed || retainedRecovery) {
    return {
      success: false,
      status: 'blocked',
      message: recoveryState.malformed
        ? `Storage create-recovery state is malformed for environment "${params.envName}"`
        : `Storage "${name}" has retained create-recovery state`,
      error: `${storageRecoveryGuidance()} No storage provider mutation was attempted.`,
      ...(retainedRecovery ? { data: { storageCreateRecovery: retainedRecovery } } : {}),
    };
  }
  const bindings = parseStorageBindings(environment);
  const contexts = parseStorageProviderContexts(environment);
  const desired = params.environmentSpec.storage?.[name];
  const plannedService = typeof params.action.metadata?.serviceName === 'string'
    ? params.action.metadata.serviceName
    : undefined;
  const binding = bindings[name];
  const currentServiceId = plannedService ? boundServiceId(environment, plannedService) : undefined;
  const plannedServiceId = typeof params.action.metadata?.serviceId === 'string'
    ? params.action.metadata.serviceId
    : undefined;
  const pendingServiceId = params.action.metadata?.serviceIdPending === true;
  const serviceTargetMatches = !plannedService
    || (plannedServiceId ? plannedServiceId === currentServiceId : false)
    || (
      operation === STORAGE_OPERATIONS.wire
      && pendingServiceId
      && Boolean(currentServiceId)
      && params.action.dependsOn?.includes(`service:${plannedService}`) === true
    );
  const hasPlannedInstanceScope = Object.prototype.hasOwnProperty.call(params.action.metadata ?? {}, 'instanceScope');
  const rawPlannedInstanceScope = params.action.metadata?.instanceScope;
  const plannedInstanceScope = storageContext(rawPlannedInstanceScope);
  const plannedInstanceScopeMatches = hasPlannedInstanceScope
    && (rawPlannedInstanceScope === null || plannedInstanceScope !== undefined)
    && scopesMatch(binding?.instanceScope, plannedInstanceScope);
  const identityMatches = Boolean(name)
    && name === params.action.resource.name
    && (
      operation === STORAGE_OPERATIONS.ensure
        ? desired?.provider === params.action.resource.provider
        : operation === STORAGE_OPERATIONS.wire
        ? desired?.provider === params.action.resource.provider
            && Boolean(plannedService && desired.injectInto.includes(plannedService))
            && serviceTargetMatches
          : operation === STORAGE_OPERATIONS.unwire
            ? binding?.provider === params.action.resource.provider
              && Boolean(plannedService)
              && serviceTargetMatches
            : operation === STORAGE_OPERATIONS.destroy
              ? !desired
                && binding?.provider === params.action.resource.provider
                && params.action.metadata?.externalId === binding.externalId
                && plannedInstanceScopeMatches
              : false
    );
  if (!identityMatches) {
    return {
      success: false,
      status: 'blocked',
      message: `Storage action "${params.action.id}" has stale mutation authority`,
      error: `The reviewed bucket, provider, service destination, or durable provider id no longer matches environment "${params.envName}". Re-run hv_plan.`,
    };
  }

  if (params.action.metadata?.blockedReason) {
    const blockedReason = params.action.metadata.blockedReason;
    const error = blockedReason === 'unmanaged_conflict'
      ? 'Use hv_inspect and hv_import to explicitly adopt the live bucket, or rename the desired bucket.'
      : blockedReason === 'provider_migration_required'
        ? 'Declare dataMigration on the target environment so Hypervibe copies and verifies the bucket before changing its provider binding.'
        : blockedReason === 'storage_binding_identity_mismatch'
          ? 'The provider id or provider-native scope differs from the persisted binding. Inspect the live resources and explicitly import the intended bucket.'
          : blockedReason === 'service_binding_identity_mismatch'
            ? 'The destination service could not be resolved by its durable provider id. Re-run hv_plan after restoring or explicitly adopting its binding.'
            : blockedReason === 'storage_create_recovery_required'
              || blockedReason === 'storage_create_recovery_target_mismatch'
              || blockedReason === 'orphaned_storage_create_recovery'
              || blockedReason === 'malformed_storage_create_recovery'
              ? storageRecoveryGuidance()
            : 'Object-storage locations are immutable. Migrate objects explicitly, then remove/destroy and recreate the bucket.';
    return { success: false, status: 'blocked', message: params.action.reason, error };
  }

  const storageResult = await adapterFactory.getStorageAdapter(params.action.resource.provider, params.project);
  if (!storageResult.success || !storageResult.adapter) return { success: false, message: 'Storage adapter unavailable', error: storageResult.error };
  const adapter = storageResult.adapter;
  if (adapter.name !== params.action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: `Storage action "${params.action.id}" resolved the wrong provider adapter`,
      error: `Plan targets ${params.action.resource.provider}, but the resolved adapter is ${adapter.name}.`,
    };
  }

  if (operation === STORAGE_OPERATIONS.ensure) {
    const spec = desired;
    if (!spec) return { success: false, message: `Storage "${name}" is absent from the current spec` };
    let context = contexts[adapter.name];
    if (!context && params.environmentSpec.hosting.provider === adapter.name) {
      const root = environment.platformBindings as { projectId?: string; environmentId?: string };
      if (root.projectId && root.environmentId) context = { projectId: root.projectId, environmentId: root.environmentId };
    }
    const contextResult = await adapter.ensureContext(params.project.name, environment, context, spec.region);
    const exactContext = storageContext(contextResult.context);
    if (!contextResult.receipt.success || !exactContext) {
      return {
        success: false,
        message: contextResult.receipt.message,
        error: contextResult.receipt.error
          ?? 'Storage provider returned a successful context receipt without a complete non-secret provider scope.',
      };
    }
    context = exactContext;
    let result: Awaited<ReturnType<typeof adapter.ensureBucket>>;
    try {
      result = await adapter.ensureBucket(environment, context, name, spec.region);
    } catch (error) {
      const recovery = conservativeStorageRecovery({
        provider: adapter.name,
        resourceName: name,
        providerScope: context,
      });
      const persistenceError = persistStorageCreateRecovery(environment.id, name, recovery);
      return {
        success: false,
        message: `Storage provider call for "${name}" ended with an unresolved create outcome`,
        error: [
          error instanceof Error ? error.message : String(error),
          persistenceError,
        ].filter((value): value is string => Boolean(value)).join('; '),
        data: { storageCreateRecovery: recovery, instanceScope: context },
      };
    }

    const externalId = typeof result.externalId === 'string' && result.externalId.trim().length > 0
      ? result.externalId.trim()
      : undefined;
    const returnedContext = result.context === undefined ? context : storageContext(result.context);
    const contextMatches = Boolean(returnedContext && scopesMatch(returnedContext, context));
    const returnedRecovery = validateReturnedStorageRecovery({
      value: result.receipt.data?.storageCreateRecovery,
      provider: adapter.name,
      resourceName: name,
      providerScope: context,
      externalId,
    });
    const hasRecoveryValue = result.receipt.data?.storageCreateRecovery !== undefined;
    const mayHaveCommitted = storageCreateMayHaveCommitted({
      success: result.receipt.success,
      externalId,
      data: result.receipt.data,
    }) || !contextMatches;

    if (!result.receipt.success || !externalId || !contextMatches || hasRecoveryValue) {
      const recovery = returnedRecovery ?? (mayHaveCommitted
        ? conservativeStorageRecovery({
            provider: adapter.name,
            resourceName: name,
            providerScope: context,
            ...(externalId ? { externalId } : {}),
          })
        : undefined);
      const persistenceError = recovery
        ? persistStorageCreateRecovery(environment.id, name, recovery)
        : undefined;
      return {
        success: false,
        message: result.receipt.success
          ? `Storage provider returned an incomplete or inconsistent success for "${name}"`
          : result.receipt.message,
        error: [
          result.receipt.error,
          hasRecoveryValue && !returnedRecovery
            ? 'Provider returned malformed or inconsistent storage create-recovery state; Hypervibe retained a conservative blocker.'
            : undefined,
          !contextMatches
            ? 'Provider returned a storage scope that does not match the exact reviewed context.'
            : undefined,
          result.receipt.success && !externalId
            ? 'Provider reported success without a valid bucket id; Hypervibe refused to create a normal storage binding.'
            : undefined,
          persistenceError,
        ].filter((value): value is string => Boolean(value)).join('; ') || undefined,
        data: {
          ...(result.receipt.data ?? {}),
          ...(externalId ? { externalId } : {}),
          instanceScope: context,
          ...(recovery ? { storageCreateRecovery: recovery } : {}),
        },
      };
    }

    const latestEnvironment = envRepo.findById(environment.id) ?? environment;
    const latestRecoveries = storageCreateRecoveryState(latestEnvironment);
    if (latestRecoveries.malformed || latestRecoveries.parsed[name]) {
      return {
        success: false,
        status: 'blocked',
        message: `Storage create-recovery state changed while ensuring "${name}"`,
        error: `${storageRecoveryGuidance()} Hypervibe preserved the new recovery state and did not replace it with a normal binding.`,
      };
    }
    const latestBindings = parseStorageBindings(latestEnvironment);
    const latestContexts = parseStorageProviderContexts(latestEnvironment);
    const next = {
      ...latestBindings,
      [name]: {
        provider: adapter.name,
        externalId,
        instanceScope: context,
        region: spec.region,
        services: latestBindings[name]?.services ?? [],
        envKeys: adapter.runtimeEnvKeys(name),
        updatedAt: new Date().toISOString(),
      },
    };
    persist(
      latestEnvironment,
      next,
      { ...latestContexts, [adapter.name]: context },
      latestRecoveries.parsed
    );
    return { success: true, message: result.receipt.message, data: { externalId, region: spec.region } };
  }

  const context = binding?.instanceScope ?? contexts[binding?.provider] ?? (params.environmentSpec.hosting.provider === binding?.provider
    ? (() => { const root = environment.platformBindings as { projectId?: string; environmentId?: string }; return root.projectId && root.environmentId ? { projectId: root.projectId, environmentId: root.environmentId } : undefined; })()
    : undefined);
  if (!binding || !context) return { success: false, message: `Storage binding/context missing for "${name}"` };

  if (operation === STORAGE_OPERATIONS.destroy) {
    const receipt = await adapter.destroyBucket(environment, context, binding.externalId);
    if (receipt.success) { const next = { ...bindings }; delete next[name]; persist(environment, next, contexts); }
    return { success: receipt.success, message: receipt.message, error: receipt.error, data: receipt.data };
  }

  const serviceName = String(params.action.metadata?.serviceName ?? '');
  const service = serviceRepo.findByProjectAndName(params.project.id, serviceName);
  if (!service) return { success: false, message: `Service "${serviceName}" not found locally` };
  const hostingResult = await adapterFactory.getProviderAdapter(params.environmentSpec.hosting.provider, params.project);
  const hosting = hostingResult.adapter as IProviderAdapter | undefined;
  if (!hostingResult.success || !hosting?.setEnvVars) return { success: false, message: 'Hosting adapter cannot sync storage variables', error: hostingResult.error };
  if (hosting.name !== params.environmentSpec.hosting.provider) {
    return {
      success: false,
      status: 'blocked',
      message: `Storage action "${params.action.id}" resolved the wrong hosting adapter`,
      error: `Environment uses ${params.environmentSpec.hosting.provider}, but the resolved adapter is ${hosting.name}.`,
    };
  }

  if (operation === STORAGE_OPERATIONS.unwire) {
    const cleared = Object.fromEntries((binding.envKeys ?? storageEnvKeys(name)).map((key) => [key, '']));
    const receipt = await hosting.setEnvVars(environment, service, cleared);
    if (receipt.success) {
      persist(environment, { ...bindings, [name]: { ...binding, services: binding.services.filter((item) => item !== serviceName) } }, contexts);
    }
    return { success: receipt.success, message: receipt.success ? `Removed storage "${name}" access from "${serviceName}"` : receipt.message, error: receipt.error };
  }

  const runtimeEnv = await adapter.getRuntimeEnv(environment, context, binding.externalId, name);
  const runtimeEnvKeys = Object.keys(runtimeEnv).sort();
  const receipt = await hosting.setEnvVars(environment, service, runtimeEnv);
  if (receipt.success) {
    persist(environment, { ...bindings, [name]: { ...binding, services: Array.from(new Set([...binding.services, serviceName])), envKeys: runtimeEnvKeys, updatedAt: new Date().toISOString() } }, contexts);
  }
  return {
    success: receipt.success,
    message: receipt.success ? `Wired storage "${name}" to service "${serviceName}"` : receipt.message,
    error: receipt.error,
    data: receipt.success ? { serviceName, envKeys: runtimeEnvKeys } : receipt.data,
  };
}
