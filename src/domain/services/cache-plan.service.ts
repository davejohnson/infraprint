import type { LocalSnapshot, PlanAction } from '../plan/plan.types.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { bindingIdentityFingerprint } from './binding-identity.js';
import { parseUnresolvedDatastoreMutation } from '../ports/database.port.js';
import { parseUnresolvedCacheNetworkMutation } from '../ports/cache.port.js';

export const CACHE_OPERATIONS = {
  ensure: 'cacheEnsure',
  unwire: 'cacheUnwire',
  destroy: 'cacheDestroy',
  retainedDestroy: 'retainedCacheDestroy',
} as const;

const CACHE_OPERATION_SET = new Set<string>(Object.values(CACHE_OPERATIONS));

const CACHE_CONFIG_FIELDS = ['region', 'network', 'subnetwork', 'tier', 'size'] as const;

function desiredCacheMetadata(
  desired: NonNullable<EnvironmentSpec['cache']>
): Record<(typeof CACHE_CONFIG_FIELDS)[number], string | null> {
  return Object.fromEntries(
    CACHE_CONFIG_FIELDS.map((field) => [field, desired[field] ?? null])
  ) as Record<(typeof CACHE_CONFIG_FIELDS)[number], string | null>;
}

function cacheConfigValueMatches(field: (typeof CACHE_CONFIG_FIELDS)[number], wanted: string, actual?: string): boolean {
  if (actual === wanted) return true;
  // Some APIs observe a full provider resource name after accepting a short
  // provider-native network/subnet name in desired state.
  return (field === 'network' || field === 'subnetwork')
    && Boolean(actual?.endsWith(`/${wanted}`));
}

function bindingProvider(component: LocalSnapshot['components'][number] | undefined): string | undefined {
  const provider = (component?.bindings as Record<string, unknown> | undefined)?.provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([, item]) => typeof item !== 'string' || item.length === 0)) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function scopesMatch(
  localScope: Record<string, string> | undefined,
  liveScope: Record<string, string> | undefined
): boolean {
  const localEntries = Object.entries(localScope ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const liveEntries = Object.entries(liveScope ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return localEntries.length === liveEntries.length
    && localEntries.every(([key, value], index) => (
      liveEntries[index]?.[0] === key && liveEntries[index]?.[1] === value
    ));
}

function withoutPreviousProviderBinding(
  bindings: Record<string, unknown> | undefined
): Record<string, unknown> {
  const current = { ...(bindings ?? {}) };
  delete current.previousProvider;
  delete current.previousExternalId;
  delete current.previousBindings;
  return current;
}

function cacheAction(params: {
  id: string;
  type: PlanAction['type'];
  provider: string;
  operation: string;
  reason: string;
  verified: boolean;
  diff?: PlanAction['diff'];
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  billable?: boolean;
  requiresConfirm?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'cache', name: 'redis', provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.diff ? { diff: params.diff } : {}),
    ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    ...(params.billable ? { billable: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true, dataBearing: true } : {}),
    metadata: { operation: params.operation, ...(params.metadata ?? {}) },
  };
}

export interface CachePlanResult {
  actions: PlanAction[];
  warnings: string[];
  unmanaged: Array<{ kind: 'cache'; name: string; detail?: string }>;
  /** A new cache must exist before service bootstrap can inject REDIS_URL. */
  serviceDependency?: string;
}

export function planCache(params: {
  environmentSpec: EnvironmentSpec;
  observed: ObservedState | null;
  local: LocalSnapshot;
  projectDependency?: string[];
}): CachePlanResult {
  const desired = params.environmentSpec.cache;
  const local = params.local.components.find((component) => component.type === 'redis');
  const localProvider = bindingProvider(local);
  const localBindings = local?.bindings as Record<string, unknown> | undefined;
  const localProviderScope = stringRecord(localBindings?.providerScope);
  const previousProvider = typeof (local?.bindings as Record<string, unknown> | undefined)?.previousProvider === 'string'
    ? String((local?.bindings as Record<string, unknown>).previousProvider)
    : undefined;
  const previousBindings = localBindings?.previousBindings
    && typeof localBindings.previousBindings === 'object'
    && !Array.isArray(localBindings.previousBindings)
    ? localBindings.previousBindings as Record<string, unknown>
    : undefined;
  const previousExternalId = typeof localBindings?.previousExternalId === 'string'
    ? localBindings.previousExternalId
    : typeof previousBindings?.instanceId === 'string'
      ? previousBindings.instanceId
      : typeof previousBindings?.serviceId === 'string'
        ? previousBindings.serviceId
        : undefined;
  const previousProviderScope = stringRecord(previousBindings?.providerScope);
  const observationKnown = params.observed === null
    || params.observed.completeness?.caches !== 'unknown';
  const observedCaches = observationKnown
    ? (params.observed?.caches ?? []).filter((cache) => cache.engine === 'redis')
    : [];
  const boundObservedCandidates = local?.externalId
    ? observedCaches.filter((cache) => (
      cache.externalId === local.externalId
      && (!localProvider || cache.provider === localProvider)
      && scopesMatch(localProviderScope, cache.providerScope)
    ))
    : [];
  const boundObserved = boundObservedCandidates.length === 1 ? boundObservedCandidates[0] : undefined;
  const observed = boundObserved ?? (!local && observedCaches.length === 1 ? observedCaches[0] : undefined);
  const bindingIdentityMismatch = Boolean(
    local
    && localProvider === params.environmentSpec.cache?.provider
    && params.observed
    && observationKnown
    && !boundObserved
    && boundObservedCandidates.length < 2
  );
  const currentProvider = boundObserved?.provider ?? localProvider ?? observed?.provider;
  const verified = Boolean(params.observed && observationKnown);
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const unmanaged: CachePlanResult['unmanaged'] = [];
  const cacheProvisioningIncomplete = localBindings?.provisioningIncomplete === true;
  const cacheReconciliationIncomplete = localBindings?.reconciliationIncomplete === true;
  const unresolvedCacheCreate = parseUnresolvedDatastoreMutation(localBindings, 'cache');
  const unresolvedCacheNetworkCreate = parseUnresolvedCacheNetworkMutation(localBindings);
  const unresolvedCreateCandidates = unresolvedCacheCreate && observationKnown
    ? observedCaches.filter((cache) => (
        cache.provider === localProvider
        && cache.name === unresolvedCacheCreate.resourceName
        && Object.entries(unresolvedCacheCreate.providerScope).every(([key, value]) => (
          cache.providerScope?.[key] === value
        ))
      ))
    : [];

  if (cacheProvisioningIncomplete) {
    const retainedProvider = localProvider ?? desired?.provider ?? 'unknown';
    const externalId = local?.externalId
      ?? (typeof localBindings?.instanceId === 'string' ? localBindings.instanceId : undefined)
      ?? (typeof localBindings?.serviceId === 'string' ? localBindings.serviceId : undefined);
    const providerCaches = observedCaches.filter((cache) => cache.provider === localProvider);
    if (
      unresolvedCacheNetworkCreate
      && !unresolvedCacheCreate
      && local
      && localProvider
      && desired?.provider === localProvider
      && localProviderScope
      && observationKnown
      && providerCaches.length === 0
    ) {
      actions.push(cacheAction({
        id: `cache:${retainedProvider}`,
        type: 'update',
        provider: retainedProvider,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: `Resume the exact unresolved ${retainedProvider} cache-network create before provisioning Redis`,
        billable: true,
        metadata: {
          ...desiredCacheMetadata(desired ?? {
            provider: retainedProvider,
            engine: 'redis',
          }),
          recoveryResourceName: unresolvedCacheNetworkCreate.resourceName,
          providerScope: unresolvedCacheNetworkCreate.providerScope,
          recoveryMarker: unresolvedCacheNetworkCreate,
        },
      }));
      warnings.push(`Cache network create ${unresolvedCacheNetworkCreate.resourceName} is unresolved. Apply may resume only after the provider returns exactly one matching scoped, owned network resource; it will never issue another network-resource create from this marker.`);
    } else if (unresolvedCacheCreate && local && localProvider && localProviderScope) {
      const observedCandidate = unresolvedCreateCandidates.length === 1
        ? unresolvedCreateCandidates[0]
        : undefined;
      actions.push(cacheAction({
        id: `cache:${retainedProvider}`,
        type: 'update',
        provider: retainedProvider,
        operation: CACHE_OPERATIONS.ensure,
        verified: Boolean(observationKnown && observedCandidate),
        reason: observedCandidate
          ? `The previously unresolved ${retainedProvider} cache create is now visible as ${observedCandidate.externalId}, but explicit reconciliation is required`
          : unresolvedCreateCandidates.length > 1
            ? `Multiple ${retainedProvider} caches now match the unresolved create name; no identity can be selected`
            : `The outcome of the previous ${retainedProvider} cache create remains unresolved`,
        metadata: {
          ...desiredCacheMetadata(desired ?? {
            provider: retainedProvider,
            engine: 'redis',
          }),
          blockedReason: observedCandidate
            ? 'cache_unresolved_create_observed'
            : unresolvedCreateCandidates.length > 1
              ? 'cache_unresolved_create_ambiguous'
              : 'cache_unresolved_create_unknown',
          resourceName: unresolvedCacheCreate.resourceName,
          providerScope: unresolvedCacheCreate.providerScope,
          ...(observedCandidate ? {
            externalId: observedCandidate.externalId,
            observedProviderScope: observedCandidate.providerScope,
          } : {}),
          ...(unresolvedCreateCandidates.length > 1 ? {
            externalIds: unresolvedCreateCandidates.map((candidate) => candidate.externalId).sort(),
          } : {}),
        },
      }));
      warnings.push(observedCandidate
        ? `Cache create ${unresolvedCacheCreate.resourceName} is now visible as ${observedCandidate.externalId}. Inspect that exact ID, then use hv_import mode="retained-cache-cleanup" and the isolated retained-cleanup plan to delete it; Hypervibe will clear the matching unresolved marker only after terminal absence.`
        : `Cache create ${unresolvedCacheCreate.resourceName} has no safely reconciled provider ID. Hypervibe will not retry the billable create; re-observe its exact scope and, if it appears, use hv_import mode="retained-cache-cleanup" for that exact ID.`);
    } else if (!local || !localProvider || !externalId || !localProviderScope) {
      actions.push(cacheAction({
        id: `cache:${retainedProvider}`,
        type: 'update',
        provider: retainedProvider,
        operation: CACHE_OPERATIONS.ensure,
        verified: false,
        reason: 'A failed cache provision was retained without a complete cleanup identity',
        metadata: {
          ...desiredCacheMetadata(desired ?? {
            provider: retainedProvider,
            engine: 'redis',
          }),
          blockedReason: 'cache_incomplete_provision_identity_missing',
        },
      }));
      warnings.push('Cache reconciliation is blocked because the retained failed provision lacks a complete provider id and scope. Inspect the provider and repair the exact binding before any retry or deletion.');
    } else if (desired) {
      actions.push(cacheAction({
        id: `cache:${localProvider}`,
        type: 'update',
        provider: localProvider,
        operation: CACHE_OPERATIONS.ensure,
        verified: false,
        reason: `The ${localProvider} cache create was acknowledged, but readiness or runtime wiring was not fully proven`,
        metadata: {
          ...desiredCacheMetadata(desired),
          blockedReason: 'cache_provision_incomplete',
          externalId,
          providerScope: localProviderScope,
        },
      }));
      warnings.push(`Cache ${externalId} is retained for recovery and will not be treated as active. Inspect it with hv_inspect; to recreate safely, remove the cache from desired state, confirm its exact cleanup, then add it again.`);
    } else {
      actions.push(cacheAction({
        id: `cache:${localProvider}:destroy`,
        type: 'destroy',
        provider: localProvider,
        operation: CACHE_OPERATIONS.destroy,
        verified: Boolean(boundObserved),
        reason: `Delete the incomplete ${localProvider} cache provision before clearing or restoring any previous cache binding`,
        requiresConfirm: true,
        metadata: {
          externalId,
          providerScope: localProviderScope,
          bindingsFingerprint: bindingIdentityFingerprint(localBindings),
          incompleteProvision: true,
        },
      }));
    }
    return {
      actions,
      warnings,
      unmanaged,
      ...(desired ? { serviceDependency: `cache:${retainedProvider}` } : {}),
    };
  }

  if (desired) {
    const wanted = desired.provider;
    const ensureId = `cache:${wanted}`;
    const desiredMetadata = desiredCacheMetadata(desired);
    if (observedCaches.length > 1 && !boundObserved) {
      const externalIds = observedCaches.map((cache) => cache.externalId).sort();
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: 'Multiple Redis caches were observed; Hypervibe cannot safely select one',
        metadata: { ...desiredMetadata, blockedReason: 'ambiguous_cache_identity', externalIds },
      }));
      warnings.push(`Multiple Redis caches were observed (${externalIds.join(', ')}). Cache mutations are blocked; remove the unmanaged candidates because generic cache adoption is not implemented.`);
      for (const cache of observedCaches) {
        if (cache.externalId === local?.externalId) continue;
        unmanaged.push({
          kind: 'cache',
          name: cache.name ?? cache.engine,
          detail: `${cache.provider} cache ${cache.externalId} is an additional Redis candidate`,
        });
      }
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }
    for (const cache of observedCaches) {
      if (cache.externalId === boundObserved?.externalId) continue;
      unmanaged.push({
        kind: 'cache',
        name: cache.name ?? cache.engine,
        detail: `${cache.provider} Redis cache ${cache.externalId} is not bound to this environment`,
      });
    }

    if (params.observed && !observationKnown) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: false,
        reason: localProvider === wanted && cacheReconciliationIncomplete
          ? 'A prior exact cache reconciliation was acknowledged but live state is currently unknown'
          : localProvider === wanted
          ? 'Preserving the locally bound Redis cache, but blocking dependent mutations because live cache observation is unknown'
          : `Cannot verify whether the desired ${wanted} Redis cache exists`,
        metadata: {
          ...desiredMetadata,
          blockedReason: localProvider === wanted && cacheReconciliationIncomplete
            ? 'cache_reconciliation_observation_unknown'
            : 'cache_observation_unknown',
        },
      }));
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (local && !localProviderScope) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified,
        reason: 'The locally bound Redis cache is missing its provider-native scope',
        metadata: {
          ...desiredMetadata,
          blockedReason: 'cache_binding_scope_missing',
          boundExternalId: local.externalId,
        },
      }));
      warnings.push('The Redis binding predates provider-scope tracking. Re-observe or explicitly import the exact cache before reconciling it.');
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (bindingIdentityMismatch) {
      const externalIds = observedCaches.map((cache) => cache.externalId).sort();
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: 'The locally bound Redis identity is absent or has a different provider scope',
        metadata: {
          ...desiredMetadata,
          blockedReason: 'cache_binding_identity_mismatch',
          boundExternalId: local?.externalId,
          externalIds,
        },
      }));
      for (const cache of observedCaches) {
        unmanaged.push({
          kind: 'cache',
          name: cache.name ?? cache.engine,
          detail: `${cache.provider} Redis cache ${cache.externalId} does not match the durable local binding`,
        });
      }
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    const desiredProviderCandidates = observedCaches.filter((cache) => cache.provider === wanted);
    if (localProvider && localProvider !== wanted && desiredProviderCandidates.length > 0) {
      const externalIds = desiredProviderCandidates.map((cache) => cache.externalId).sort();
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: desiredProviderCandidates.length === 1
          ? `A live ${wanted} Redis cache already exists but is not the durable local binding`
          : `Multiple ${wanted} Redis caches already exist; Hypervibe cannot safely select one`,
        metadata: {
          ...desiredMetadata,
          blockedReason: desiredProviderCandidates.length === 1
            ? 'cache_adoption_required'
            : 'ambiguous_cache_identity',
          externalIds,
        },
      }));
      for (const cache of desiredProviderCandidates) {
        unmanaged.push({
          kind: 'cache',
          name: cache.name ?? cache.engine,
          detail: `${cache.provider} cache ${cache.externalId} is unbound; generic cache adoption is not implemented`,
        });
      }
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (!currentProvider) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'create',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified,
        reason: 'No Redis cache exists',
        billable: true,
        dependsOn: params.projectDependency,
        metadata: desiredMetadata,
      }));
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (currentProvider !== wanted) {
      warnings.push(
        `Cache provider change from ${currentProvider} to ${wanted} is staged: this plan creates the new Redis cache and rewires services before a later confirm-gated old-cache deletion.`
      );
      actions.push(cacheAction({
        id: ensureId,
        type: 'create',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified,
        reason: `Redis provider changes from ${currentProvider} to ${wanted}`,
        billable: true,
        dependsOn: params.projectDependency,
        metadata: desiredMetadata,
      }));
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (observed && !local) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: `A live ${wanted} Redis cache exists without a durable Hypervibe binding`,
        metadata: {
          ...desiredMetadata,
          blockedReason: 'cache_adoption_required',
          externalId: observed.externalId,
          observedName: observed.name,
        },
      }));
      unmanaged.push({
        kind: 'cache',
        name: observed.name ?? observed.engine,
        detail: `${observed.provider} cache ${observed.externalId} is unbound; generic cache adoption is not implemented`,
      });
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (
      boundObserved
      && currentProvider === wanted
      && boundObserved.status !== 'running'
    ) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: `The bound Redis cache is ${boundObserved.status}, not running`,
        metadata: {
          ...desiredMetadata,
          blockedReason: 'cache_not_running',
          observedStatus: boundObserved.status,
          externalId: boundObserved.externalId,
          ...(boundObserved.providerScope ? { providerScope: boundObserved.providerScope } : {}),
        },
      }));
      warnings.push(
        `Redis cache ${boundObserved.externalId} is ${boundObserved.status}; dependent service mutations are blocked until live observation reports running.`
      );
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    const configDiff = CACHE_CONFIG_FIELDS.flatMap((field) => {
      const wantedValue = desired[field];
      if (wantedValue === undefined || cacheConfigValueMatches(field, wantedValue, boundObserved?.config?.[field])) {
        return [];
      }
      return [{
        field,
        from: boundObserved?.config?.[field],
        to: wantedValue,
      }];
    });
    if (configDiff.length > 0 || cacheReconciliationIncomplete) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified,
        reason: cacheReconciliationIncomplete
          ? configDiff.length > 0
            ? `A prior Redis reconciliation is unverified and configuration still differs on ${configDiff.map((entry) => entry.field).join(', ')}`
            : 'A prior Redis reconciliation was acknowledged but not verified; re-observe and converge the exact bound cache'
          : `Redis configuration drift on ${configDiff.map((entry) => entry.field).join(', ')}`,
        ...(configDiff.length > 0 ? { diff: configDiff } : {}),
        billable: true,
        metadata: desiredMetadata,
      }));
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    actions.push(cacheAction({
      id: ensureId,
      type: 'noop',
      provider: wanted,
      operation: CACHE_OPERATIONS.ensure,
      verified,
      reason: 'Redis cache in sync',
      metadata: desiredMetadata,
    }));
    if (previousProvider && previousProvider !== wanted) {
      if (!previousExternalId || !previousProviderScope) {
        actions.push(cacheAction({
          id: `cache:${previousProvider}:destroy`,
          type: 'update',
          provider: previousProvider,
          operation: CACHE_OPERATIONS.destroy,
          verified,
          reason: `Previous ${previousProvider} Redis cache cannot be destroyed without its exact provider id and provider-native scope`,
          metadata: {
            blockedReason: 'cache_destroy_identity_missing',
            ...(previousExternalId ? { externalId: previousExternalId } : {}),
          },
        }));
        return { actions, warnings, unmanaged };
      }
      actions.push(cacheAction({
        id: `cache:${previousProvider}:destroy`,
        type: 'destroy',
        provider: previousProvider,
        operation: CACHE_OPERATIONS.destroy,
        verified,
        reason: `Previous ${previousProvider} Redis cache is no longer active`,
        requiresConfirm: true,
        metadata: {
          externalId: previousExternalId,
          providerScope: previousProviderScope,
          bindingsFingerprint: bindingIdentityFingerprint(previousBindings ?? {}),
        },
      }));
    }
    return { actions, warnings, unmanaged };
  }

  if (params.observed && !observationKnown && local) {
    actions.push(cacheAction({
      id: `cache:${localProvider ?? 'redis'}:observation-blocked`,
      type: 'update',
      provider: localProvider ?? 'unknown',
      operation: CACHE_OPERATIONS.destroy,
      verified: false,
      reason: 'Redis was removed from the spec, but live cache observation is unknown; refusing to destroy it',
      metadata: { blockedReason: 'cache_observation_unknown' },
    }));
    return { actions, warnings, unmanaged };
  }

  const destroyProvider = currentProvider ?? localProvider;
  if (local && destroyProvider) {
    const destroyExternalId = local.externalId
      ?? (typeof localBindings?.instanceId === 'string' ? localBindings.instanceId : undefined)
      ?? (typeof localBindings?.serviceId === 'string' ? localBindings.serviceId : undefined);
    if (!destroyExternalId || !localProviderScope) {
      actions.push(cacheAction({
        id: `cache:${destroyProvider}:destroy`,
        type: 'update',
        provider: destroyProvider,
        operation: CACHE_OPERATIONS.destroy,
        verified,
        reason: 'Redis was removed from the spec, but its exact provider id and provider-native scope are not both recorded',
        metadata: {
          blockedReason: 'cache_destroy_identity_missing',
          ...(destroyExternalId ? { externalId: destroyExternalId } : {}),
        },
      }));
      warnings.push('Redis deletion is blocked until the durable provider identity and scope are reconciled.');
      return { actions, warnings, unmanaged };
    }
    let previousDestroyId: string | undefined;
    if (previousProvider && previousProvider !== destroyProvider) {
      previousDestroyId = `cache:${previousProvider}:destroy`;
      if (!previousExternalId || !previousProviderScope) {
        actions.push(cacheAction({
          id: previousDestroyId,
          type: 'update',
          provider: previousProvider,
          operation: CACHE_OPERATIONS.destroy,
          verified: false,
          reason: `Retained ${previousProvider} Redis cache cannot be destroyed without its exact provider id and provider-native scope`,
          metadata: {
            blockedReason: 'cache_destroy_identity_missing',
            ...(previousExternalId ? { externalId: previousExternalId } : {}),
          },
        }));
        warnings.push('Redis removal is blocked because the retained previous-provider cache lacks a complete durable identity.');
        return { actions, warnings, unmanaged };
      }
      actions.push(cacheAction({
        id: previousDestroyId,
        type: 'destroy',
        provider: previousProvider,
        operation: CACHE_OPERATIONS.destroy,
        verified: false,
        reason: `Destroy retained ${previousProvider} Redis before removing the active cache binding`,
        requiresConfirm: true,
        metadata: {
          externalId: previousExternalId,
          providerScope: previousProviderScope,
          bindingsFingerprint: bindingIdentityFingerprint(previousBindings ?? {}),
        },
      }));
    }
    const boundServiceNames = Object.keys(params.local.bindings?.services ?? {});
    const serviceNames = boundServiceNames.length > 0
      ? boundServiceNames
      : Object.keys(params.environmentSpec.services);
    const destroyDependencies: string[] = previousDestroyId ? [previousDestroyId] : [];
    for (const serviceName of serviceNames) {
      if (!params.environmentSpec.services[serviceName]) {
        destroyDependencies.push(`service:${serviceName}:destroy`);
        continue;
      }
      const id = `cache:redis:unwire:${serviceName}`;
      actions.push(cacheAction({
        id,
        type: 'update',
        provider: destroyProvider,
        operation: CACHE_OPERATIONS.unwire,
        verified,
        reason: `Remove REDIS_URL from service "${serviceName}" before deleting Redis`,
        metadata: { serviceName, envKeys: ['REDIS_URL'] },
      }));
      destroyDependencies.push(id);
    }
    actions.push(cacheAction({
      id: `cache:${destroyProvider}:destroy`,
      type: 'destroy',
      provider: destroyProvider,
      operation: CACHE_OPERATIONS.destroy,
      verified,
      reason: 'Redis was removed from the spec. Cached or persisted data may be lost — confirm to destroy.',
      dependsOn: destroyDependencies,
      requiresConfirm: true,
      metadata: {
        externalId: destroyExternalId,
        providerScope: localProviderScope,
        bindingsFingerprint: bindingIdentityFingerprint(
          previousDestroyId ? withoutPreviousProviderBinding(localBindings) : localBindings ?? {}
        ),
      },
    }));
  } else if (observed) {
    unmanaged.push({
      kind: 'cache',
      name: observed.name ?? observed.engine,
      detail: `${observed.provider} Redis cache exists but is not managed by the spec`,
    });
  }

  return { actions, warnings, unmanaged };
}

export function isCacheAction(action: PlanAction): boolean {
  return action.resource.kind === 'cache'
    && typeof action.metadata?.operation === 'string'
    && CACHE_OPERATION_SET.has(action.metadata.operation);
}
