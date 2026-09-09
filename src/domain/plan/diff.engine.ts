import type { EnvironmentSpec, ProjectRuntimeSpec, ServiceSpec } from '../spec/spec.schema.js';
import { createHash } from 'crypto';
import { migrationReleaseCommandWarning, withMigrationReleaseCommand } from '../spec/spec-bootstrap.js';
import type { ObservedState, ObservedService } from '../ports/observe.port.js';
import { hashEnvValue } from '../ports/observe.port.js';
import type { PlanAction, PlanFieldDiff, DiffResult, LocalSnapshot } from './plan.types.js';
import { buildDatabaseAliasEnvVars } from '../services/database-env.js';
import {
  DOMAIN_ADOPT_OPERATION,
  DOMAIN_DETACH_OPERATION,
} from '../services/domain-attach-policy.js';
import { bindingIdentityFingerprint } from '../services/binding-identity.js';
import { parseUnresolvedDatabaseMutation } from '../ports/database.port.js';
import { parseHostingServiceCreateRecovery } from '../ports/hosting.port.js';

type PreviousHostingBinding = NonNullable<NonNullable<LocalSnapshot['bindings']>['previousHosting']>;

function serviceDeleteMetadata(input: {
  serviceId: string;
  provider?: string;
  projectId?: string;
  environmentId?: string;
  serviceName?: string;
  scope?: 'environment' | 'project';
  operation?: 'hostingServiceDestroy' | 'taskServiceCleanup' | 'previousHostingDestroy';
}): Record<string, unknown> {
  const deleteScope = input.scope;
  const providerScope = input.projectId && deleteScope
    ? {
        projectId: input.projectId,
        ...(deleteScope === 'environment' && input.environmentId
          ? { environmentId: input.environmentId }
          : {}),
      }
    : undefined;
  const bindingIdentity = input.provider && providerScope && input.serviceName
    ? {
        provider: input.provider,
        projectId: input.projectId,
        ...(deleteScope === 'environment' && input.environmentId
          ? { environmentId: input.environmentId }
          : {}),
        serviceName: input.serviceName,
        serviceId: input.serviceId,
      }
    : undefined;
  return {
    ...(input.operation ? { operation: input.operation } : {}),
    externalId: input.serviceId,
    ...(deleteScope ? { deleteScope } : {}),
    ...(providerScope ? { providerScope } : {}),
    ...(bindingIdentity ? { bindingsFingerprint: bindingIdentityFingerprint(bindingIdentity) } : {}),
  };
}

function runtimeDescription(runtime: ProjectRuntimeSpec | undefined): string {
  if (!runtime) return 'undeclared';
  return [
    `${runtime.kind}:${runtime.version}`,
    runtime.installCommand ? `install=${JSON.stringify(runtime.installCommand)}` : 'install=undeclared',
    runtime.buildCommand ? `build=${JSON.stringify(runtime.buildCommand)}` : 'build=none',
  ].join(' ');
}

export function diffRetainedHostingCleanup(input: {
  envName: string;
  currentProvider: string;
  previousHosting?: PreviousHostingBinding;
  teardownBoundary?: 'services' | 'environment' | 'project';
}): Pick<DiffResult, 'actions' | 'warnings'> {
  const { envName, currentProvider, previousHosting } = input;
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  if (!previousHosting?.provider || previousHosting.provider === currentProvider) {
    return { actions, warnings };
  }

  const previousServices = Object.entries(previousHosting.services ?? {});
  const cleanupBoundary = input.teardownBoundary ?? 'services';
  if (previousServices.length === 0 && cleanupBoundary === 'services') {
    return { actions, warnings };
  }

  warnings.push(
    `${previousServices.length} service binding(s) are still running on ${previousHosting.provider}, with the ${cleanupBoundary} cleanup boundary retained from before the switch to ${currentProvider} — they may keep billing until destroyed. Confirm the previous-provider destroy actions when the ${currentProvider} deployment is verified.`
  );
  const serviceDestroyIds: string[] = [];
  if (cleanupBoundary !== 'environment') {
    for (const [name, binding] of previousServices) {
      const serviceId = binding?.serviceId ?? binding?.jobName;
      const actionId = `service:${name}:previous-destroy`;
      serviceDestroyIds.push(actionId);
      actions.push({
        id: actionId,
        type: 'destroy',
        resource: { kind: 'service', name, provider: previousHosting.provider },
        verified: false,
        reason: `Service "${name}" is still running on ${previousHosting.provider} (abandoned by the switch to ${currentProvider}). Confirm to delete it there.`,
        requiresConfirm: true,
        metadata: {
          operation: 'previousHostingDestroy',
          previousProvider: previousHosting.provider,
          cleanupBoundary,
          ...(serviceId ? { serviceId } : {}),
          ...(serviceId ? serviceDeleteMetadata({
            serviceId,
            projectId: previousHosting.projectId,
            scope: 'project',
          }) : {}),
        },
      });
    }
  }
  if (cleanupBoundary === 'environment') {
    actions.push({
      id: `environment:${envName}:${previousHosting.provider}:previous-destroy`,
      type: 'destroy',
      resource: { kind: 'environment', name: envName, provider: previousHosting.provider },
      verified: false,
      reason: `Environment "${envName}" is still present on ${previousHosting.provider}. Confirm to delete that exact abandoned environment without deleting shared project services.`,
      requiresConfirm: true,
      metadata: {
        operation: 'previousHostingDestroy',
        previousProvider: previousHosting.provider,
        cleanupBoundary,
        ...(previousHosting.projectId ? { projectId: previousHosting.projectId } : {}),
        ...(previousHosting.environmentId ? { environmentId: previousHosting.environmentId } : {}),
      },
    });
  } else if (cleanupBoundary === 'project') {
    actions.push({
      id: `project:${previousHosting.provider}:previous-destroy`,
      type: 'destroy',
      resource: { kind: 'project', name: envName, provider: previousHosting.provider },
      verified: false,
      reason: `Provider-owned project boundary for "${envName}" is still present on ${previousHosting.provider}. Confirm to delete it after its services are absent.`,
      requiresConfirm: true,
      ...(serviceDestroyIds.length > 0 ? { dependsOn: serviceDestroyIds } : {}),
      metadata: {
        operation: 'previousHostingDestroy',
        previousProvider: previousHosting.provider,
        cleanupBoundary,
        ...(previousHosting.projectId ? { projectId: previousHosting.projectId } : {}),
      },
    });
  }

  return { actions, warnings };
}

function certificateStatusIsReady(status?: string): boolean {
  if (!status) return false;
  const normalized = status.trim().toUpperCase();
  return !/(PENDING|WAITING|FAILED|FAILURE|ERROR|INVALID|UNVERIFIED)/.test(normalized)
    && /(VALID|VERIFIED|ISSUED|ACTIVE|READY|SUCCESS|SUCCEEDED)/.test(normalized);
}

/**
 * Pure diff: desired spec vs observed live state (or local state when the
 * provider is not observable). No repository or adapter imports — everything
 * arrives as input, which makes this the most heavily tested module in the
 * convergence engine.
 *
 * Rules:
 * - `observed === null` → fall back to local entities; all actions verified: false.
 * - Provider change on the database → create new + destroy old, destroy is
 *   confirm-gated (dataBearing) and depends on the create.
 * - Hosting provider change → replace services (create on new provider before
 *   destroying old, handled by the converge executor).
 * - Live resources absent from the spec are destroyed only when local bindings
 *   prove Hypervibe manages them. Otherwise they are reported as unmanaged.
 * - Email/SendGrid is not part of the diff (not observable here); hv_plan
 *   appends provider-precondition items separately.
 */
export function diffEnvironment(input: {
  spec: EnvironmentSpec;
  envName: string;
  observed: ObservedState | null;
  local: LocalSnapshot;
  providerBehavior?: {
    requiresBranchDeployForCode?: boolean;
    serviceCreatesBillable?: boolean;
    workloadKindObservation?: 'exact' | 'cron-only';
    presenceOnlyManagedEnvVar?: (params: { key: string; value: string }) => boolean;
  };
  /** Provider-declared ownership boundary for the retained, abandoned host. */
  previousHostingTeardownBoundary?: 'services' | 'environment' | 'project';
  /** Provider-declared context required to delete one bound service. */
  hostingServiceDeleteScope?: 'environment' | 'project';
  /** Provider-declared environment custom-domain lifecycle. Omission fails closed. */
  customDomainManagement?: 'managed' | 'unsupported';
  customDomainTrafficProxy?: 'supported' | 'dns-only';
  /** Repo/branch services should be linked to when spec.deploy.strategy is "branch". */
  expectedSource?: { repo: string; branch: string };
  /** Managed database env vars derived from the currently desired database component. */
  managedDatabaseEnvVars?: Record<string, string>;
  managedCacheEnvVars?: Record<string, string>;
  managedQueueEnvVars?: Record<string, string>;
  /** The database consumes infrastructure owned by this hosting project. */
  databaseDependsOnHostingProject?: boolean;
  /** Explicit project build runtime; omission preserves legacy local state. */
  projectRuntime?: ProjectRuntimeSpec;
}): DiffResult {
  const { envName, observed, local, expectedSource, managedDatabaseEnvVars, managedCacheEnvVars, managedQueueEnvVars } = input;
  const providerBehavior = input.providerBehavior ?? {};
  const spec = withMigrationReleaseCommand(input.spec);
  const verified = observed !== null;
  const projectObservationKnown = observed === null || observed.completeness?.project !== 'unknown';
  const serviceObservationKnown = observed === null || observed.completeness?.services !== 'unknown';
  const databaseObservationKnown = observed === null || observed.completeness?.databases !== 'unknown';
  const actions: PlanAction[] = [];
  const unmanaged: DiffResult['unmanaged'] = [];
  const warnings: string[] = [...(observed?.warnings ?? [])];
  const migrationWarning = migrationReleaseCommandWarning(input.spec);
  if (migrationWarning) {
    warnings.push(migrationWarning);
  }
  const provider = spec.hosting.provider;
  if (observed?.partial) {
    warnings.push('Observation was partial; some diffs may be incomplete.');
  }

  // Without a branch deploy strategy, apply creates source-less services that
  // only receive code later if the user runs an out-of-band deploy.
  if (providerBehavior.requiresBranchDeployForCode && Object.keys(spec.services).length > 0 && spec.deploy?.strategy !== 'branch') {
    warnings.push(
      `deploy.strategy is "${spec.deploy?.strategy ?? 'unset'}": ${provider} apply will create services without a source, `
      + 'so NO CODE WILL BE DEPLOYED. '
      + 'Set deploy: { strategy: "branch", trigger: "ci" } so hv_plan/hv_apply can manage the GitHub Actions deploy workflow unless infrastructure-only is intended.'
    );
  }

  // ---- project / environment ------------------------------------------------
  const boundProvider = local.bindings?.provider;
  const providerChanged = Boolean(boundProvider && boundProvider !== provider);
  const rawServiceCreateRecoveries = local.bindings?.serviceCreateRecovery;
  const recoveryMapIsMalformed = rawServiceCreateRecoveries !== undefined
    && (!rawServiceCreateRecoveries
      || typeof rawServiceCreateRecoveries !== 'object'
      || Array.isArray(rawServiceCreateRecoveries));
  const hasRetainedServiceCreateState = recoveryMapIsMalformed
    || Object.keys(rawServiceCreateRecoveries ?? {}).length > 0;

  const projectExists = observed && projectObservationKnown
    ? observed.projectExists
    : Boolean(local.bindings?.projectId);
  const projectActionId = `project:${provider}`;
  if (!projectExists || providerChanged) {
    actions.push({
      id: projectActionId,
      type: !projectObservationKnown && !providerChanged ? 'update' : 'create',
      resource: { kind: 'project', name: envName, provider },
      verified: verified && projectObservationKnown,
      reason: !projectObservationKnown && !providerChanged
        ? `Cannot verify whether the ${provider} project exists`
        : providerChanged
        ? `Hosting provider changes from ${boundProvider} to ${provider}`
        : `No ${provider} project exists for this environment`,
      ...(hasRetainedServiceCreateState || (!projectObservationKnown && !providerChanged)
        ? {
            metadata: {
              blockedReason: hasRetainedServiceCreateState
                ? 'service_create_recovery_requires_project_resolution'
                : 'project_observation_unknown',
            },
          }
        : {}),
    });
  }
  const projectDep = actions.some((a) => a.id === projectActionId) ? [projectActionId] : undefined;

  // ---- services -------------------------------------------------------------
  const observedServiceGroups = new Map<string, ObservedService[]>();
  for (const service of serviceObservationKnown ? observed?.services ?? [] : []) {
    observedServiceGroups.set(service.name, [
      ...(observedServiceGroups.get(service.name) ?? []),
      service,
    ]);
  }
  const localServices = new Map(local.services.map((s) => [s.name, s]));
  const localServiceBindings = local.bindings?.services ?? {};
  const observedServices = new Map<string, ObservedService>();
  const serviceIdentityBlocks = new Map<string, {
    reason: string;
    blockedReason: string;
    externalIds: string[];
  }>();

  // A provider name/label is not a durable identity. Resolve an existing local
  // binding first and treat every unbound name match as an adoption candidate.
  // This also lets one exact bound id disambiguate duplicate logical names
  // without silently claiming the other provider resources.
  for (const name of Object.keys(spec.services)) {
    const nameCandidates = observedServiceGroups.get(name) ?? [];
    const boundServiceId = localServiceBindings[name]?.serviceId;
    const boundCandidates = boundServiceId
      ? (serviceObservationKnown ? observed?.services ?? [] : [])
        .filter((candidate) => candidate.externalId === boundServiceId)
      : [];

    if (boundServiceId && boundCandidates.length === 1) {
      const exact = boundCandidates[0]!;
      observedServices.set(name, exact);
      for (const candidate of nameCandidates) {
        if (candidate.externalId === exact.externalId) continue;
        unmanaged.push({
          kind: 'service',
          name: candidate.name,
          detail: `Service ${candidate.externalId} matches logical name "${name}" but is not the bound service ${boundServiceId}`,
        });
      }
      continue;
    }

    if (boundCandidates.length > 1) {
      serviceIdentityBlocks.set(name, {
        reason: `Multiple live services report the exact bound id for logical service "${name}"`,
        blockedReason: 'ambiguous_service_identity',
        externalIds: boundCandidates.map((candidate) => candidate.externalId).sort(),
      });
      continue;
    }

    if (boundServiceId && nameCandidates.length > 0) {
      const externalIds = nameCandidates.map((candidate) => candidate.externalId).sort();
      serviceIdentityBlocks.set(name, {
        reason: `The bound service id ${boundServiceId} is absent, while different live service identities match logical name "${name}"`,
        blockedReason: 'service_binding_identity_mismatch',
        externalIds,
      });
      for (const candidate of nameCandidates) {
        unmanaged.push({
          kind: 'service',
          name: candidate.name,
          detail: `Service ${candidate.externalId} is an adoption candidate; the current binding points to ${boundServiceId}`,
        });
      }
      continue;
    }

    if (!boundServiceId && nameCandidates.length > 0) {
      const externalIds = nameCandidates.map((candidate) => candidate.externalId).sort();
      serviceIdentityBlocks.set(name, {
        reason: nameCandidates.length > 1
          ? `Multiple live services map to logical service "${name}"; explicit adoption or cleanup is required`
          : `A live service named "${name}" exists without a durable Hypervibe binding; explicit adoption is required`,
        blockedReason: nameCandidates.length > 1
          ? 'ambiguous_service_identity'
          : 'service_adoption_required',
        externalIds,
      });
      for (const candidate of nameCandidates) {
        unmanaged.push({
          kind: 'service',
          name: candidate.name,
          detail: `${provider} service ${candidate.externalId} requires explicit adoption`,
        });
      }
    }
  }

  for (const [name, serviceSpec] of Object.entries(spec.services)) {
    const id = `service:${name}`;
    const resource = { kind: 'service' as const, name, provider };

    const hasRecoveryEntry = recoveryMapIsMalformed
      || Boolean(rawServiceCreateRecoveries
        && Object.prototype.hasOwnProperty.call(rawServiceCreateRecoveries, name));
    if (hasRecoveryEntry) {
      const recovery = recoveryMapIsMalformed
        ? null
        : parseHostingServiceCreateRecovery(rawServiceCreateRecoveries?.[name]);
      const boundProjectId = local.bindings?.projectId;
      const boundEnvironmentId = local.bindings?.environmentId;
      const markerMatchesBindings = Boolean(
        recovery
        && recovery.provider === provider
        && (!boundProjectId || recovery.providerScope.projectId === boundProjectId)
        && (!boundEnvironmentId || recovery.providerScope.environmentId === boundEnvironmentId)
      );
      const markerDescription = recovery
        ? `${recovery.state} create for provider resource "${recovery.resourceName}"${recovery.serviceId ? ` (${recovery.serviceId})` : ''}`
        : 'malformed service-create recovery state';
      actions.unshift({
        id,
        type: 'update',
        resource,
        verified: false,
        reason: markerMatchesBindings
          ? `Service "${name}" has an ${markerDescription}; inspect and explicitly recover or clean it up before another create`
          : `Service "${name}" has ${markerDescription} that does not exactly match its current provider scope; Hypervibe will not guess or create a replacement`,
        metadata: {
          blockedReason: markerMatchesBindings
            ? 'service_create_recovery_required'
            : 'service_create_recovery_invalid',
          ...(recovery ? { serviceCreateRecovery: recovery } : {}),
        },
      });
      warnings.push(
        `Service "${name}" is blocked by retained service-create recovery state. Resolve that exact provider identity before planning another create.`
      );
      continue;
    }

    if (providerChanged) {
      actions.push({
        id,
        type: 'replace',
        resource,
        verified,
        reason: `Service moves from ${boundProvider} to ${provider} (create new, verify health, then remove old)`,
        dependsOn: projectDep,
        ...(providerBehavior.serviceCreatesBillable
          ? { billable: true, requiresConfirm: true }
          : {}),
      });
      continue;
    }

    const identityBlock = serviceIdentityBlocks.get(name);
    if (identityBlock) {
      actions.push({
        id,
        type: 'update',
        resource,
        verified: true,
        reason: identityBlock.reason,
        metadata: {
          blockedReason: identityBlock.blockedReason,
          externalIds: identityBlock.externalIds,
        },
      });
      warnings.push(
        `Unresolved service identity for "${name}": ${identityBlock.externalIds.join(', ')}. Hypervibe will not mutate or silently adopt any candidate.`
      );
      continue;
    }

    if (observed && serviceObservationKnown) {
      const live = observedServices.get(name);
      if (!live) {
        actions.push({
          id,
          type: 'create',
          resource,
          verified: true,
          reason: `Service "${name}" is not deployed on ${provider}`,
          dependsOn: projectDep,
          ...(providerBehavior.serviceCreatesBillable
            ? { billable: true, requiresConfirm: true }
            : {}),
        });
        continue;
      }

      if (live.status === 'failed' || live.status === 'unknown') {
        actions.push({
          id,
          type: 'update',
          resource,
          verified: true,
          reason: `Service "${name}" live status is ${live.status}; refusing to report configuration convergence`,
          metadata: {
            blockedReason: `service_status_${live.status}`,
            observedStatus: live.status,
            externalId: live.externalId,
          },
        });
        warnings.push(
          `Service "${name}" is ${live.status}; diagnose its deployment before applying further service mutations.`
        );
        continue;
      }

      // Only cron-ness is structural for providers that model scheduled jobs
      // as a different resource; web<->worker converges via service config.
      if ((live.workloadKind === 'cron') !== (serviceSpec.workloadKind === 'cron')) {
        actions.push({
          id,
          type: 'replace',
          resource,
          verified: true,
          reason: `Workload kind changes from ${live.workloadKind} to ${serviceSpec.workloadKind}`,
          diff: [{ field: 'workloadKind', from: live.workloadKind, to: serviceSpec.workloadKind }],
          dependsOn: projectDep,
          ...(providerBehavior.serviceCreatesBillable
            ? { billable: true, requiresConfirm: true }
            : {}),
        });
        continue;
      }

      const presenceOnlyManagedEnvVars = providerBehavior.presenceOnlyManagedEnvVar
        ? new Set(Object.entries({
          ...(managedDatabaseEnvVars ?? {}),
          ...buildDatabaseAliasEnvVars(managedDatabaseEnvVars ?? {}, serviceSpec.databaseEnvAliases),
          ...(managedCacheEnvVars ?? {}),
          ...(managedQueueEnvVars ?? {}),
        })
          .filter(([key, value]) => providerBehavior.presenceOnlyManagedEnvVar?.({ key, value }))
          .map(([key]) => key))
        : undefined;
      const desiredServiceEnvVars = {
        ...(managedDatabaseEnvVars ?? {}),
        ...buildDatabaseAliasEnvVars(managedDatabaseEnvVars ?? {}, serviceSpec.databaseEnvAliases),
        ...(managedCacheEnvVars ?? {}),
        ...(managedQueueEnvVars ?? {}),
        ...spec.envVars,
      };
      const diff = diffServiceConfig(serviceSpec, live, desiredServiceEnvVars, {
        presenceOnlyEnvVars: presenceOnlyManagedEnvVars,
        cacheNetwork: spec.cache && local.bindings?.cacheNetwork
          ? local.bindings.cacheNetwork
          : undefined,
      });
      const localRuntime = localServices.get(name)?.buildConfig.runtime;
      const runtimeDrift = Boolean(input.projectRuntime)
        && JSON.stringify(localRuntime) !== JSON.stringify(input.projectRuntime);
      if (runtimeDrift) {
        diff.push({
          field: 'runtime',
          from: runtimeDescription(localRuntime),
          to: runtimeDescription(input.projectRuntime),
        });
      }
      const workloadKindObservable = providerBehavior.workloadKindObservation !== 'cron-only';
      if (live.workloadKind !== serviceSpec.workloadKind && workloadKindObservable) {
        diff.push({ field: 'workloadKind', from: live.workloadKind, to: serviceSpec.workloadKind });
      }
      const noCode = live.status === 'empty';
      const sourceIssue = spec.deploy?.strategy === 'branch' && expectedSource
        ? diffDeploySource(expectedSource, live)
        : undefined;
      if (noCode || sourceIssue || diff.length > 0) {
        const reasons: string[] = [];
        if (noCode) {
          reasons.push(spec.deploy?.strategy === 'branch'
            ? `Service "${name}" has no image deployed yet — expected until the first CI deploy succeeds (push to the deploy branch or hv_ci_trigger)`
            : `Service "${name}" exists on ${provider} but has no code deployed (no source connected)`);
        }
        if (sourceIssue) {
          reasons.push(sourceIssue);
        }
        if (diff.length > 0) {
          reasons.push(`Configuration drift on ${diff.map((d) => d.field).join(', ')}`);
        }
        actions.push({
          id,
          type: 'update',
          resource,
          verified: !runtimeDrift,
          reason: reasons.join('; '),
          ...(diff.length > 0 ? { diff } : {}),
        });
      } else {
        actions.push({ id, type: 'noop', resource, verified: true, reason: 'In sync' });
      }
      continue;
    }

    // Local fallback (unverified). Unknown observation can preserve a proven
    // binding, but it cannot prove absence and therefore cannot authorize a
    // create.
    const known = localServices.has(name);
    const bound = Boolean(localServiceBindings[name]?.serviceId);
    const localRuntime = localServices.get(name)?.buildConfig.runtime;
    const runtimeDrift = Boolean(input.projectRuntime)
      && JSON.stringify(localRuntime) !== JSON.stringify(input.projectRuntime);
    if (known && bound) {
      actions.push({
        id,
        type: runtimeDrift ? 'update' : 'noop',
        resource,
        verified: false,
        reason: runtimeDrift
          ? `Project runtime changes from ${runtimeDescription(localRuntime)} to ${runtimeDescription(input.projectRuntime)}`
          : 'Bound in local state; provider does not support observation',
        ...(runtimeDrift
          ? {
            diff: [{
              field: 'runtime',
              from: runtimeDescription(localRuntime),
              to: runtimeDescription(input.projectRuntime),
            }],
          }
          : {}),
      });
    } else {
      actions.push({
        id,
        type: observed && !serviceObservationKnown ? 'update' : 'create',
        resource,
        verified: false,
        reason: observed && !serviceObservationKnown
          ? `Cannot verify whether service "${name}" exists on ${provider}`
          : known
          ? `Service "${name}" has no provider binding in local state`
          : `Service "${name}" is not tracked locally`,
        dependsOn: projectDep,
        ...(observed && !serviceObservationKnown
          ? { metadata: { blockedReason: 'service_observation_unknown' } }
          : {}),
        ...(!observed || serviceObservationKnown
          ? providerBehavior.serviceCreatesBillable
            ? { billable: true, requiresConfirm: true }
            : {}
          : {}),
      });
    }
  }

  // A recovery marker is not deletion authority. If its logical service has
  // been removed from the spec, surface an explicit blocker rather than
  // silently reporting convergence and abandoning a possibly billable
  // provider resource.
  if (recoveryMapIsMalformed && Object.keys(spec.services).length === 0) {
    actions.unshift({
      id: 'service:recovery-state',
      type: 'update',
      resource: { kind: 'service', name: 'service-create-recovery', provider: boundProvider ?? provider },
      verified: false,
      reason: 'Hosting bindings contain malformed service-create recovery state; inspect and repair the binding before any service lifecycle operation',
      metadata: { blockedReason: 'service_create_recovery_invalid' },
    });
    warnings.push('Malformed service-create recovery state may refer to a provider resource that is absent from the desired spec. Hypervibe will not discard it or infer deletion authority.');
  } else {
    for (const [name, rawRecovery] of Object.entries(rawServiceCreateRecoveries ?? {})) {
      if (spec.services[name]) continue;
      const recovery = parseHostingServiceCreateRecovery(rawRecovery);
      actions.unshift({
        id: `service:${name}:recovery`,
        type: 'update',
        resource: {
          kind: 'service',
          name,
          provider: recovery?.provider ?? boundProvider ?? provider,
        },
        verified: false,
        reason: recovery
          ? `Retained ${recovery.state} create identity for removed service "${name}" is not deletion authority; inspect and explicitly recover or clean up provider resource "${recovery.resourceName}" before removing the marker`
          : `Removed service "${name}" has malformed retained create recovery state; Hypervibe will not discard it or guess which provider resource to delete`,
        metadata: {
          blockedReason: recovery
            ? 'orphaned_service_create_recovery'
            : 'service_create_recovery_invalid',
          ...(recovery ? { serviceCreateRecovery: recovery } : {}),
        },
      });
      warnings.push(
        `Service "${name}" is absent from the spec but still has service-create recovery state. Explicit provider inspection and cleanup/adoption are required.`
      );
    }
  }

  // Variable omission is preserve-only. Deletion is modeled separately from
  // service configuration so it is visible, confirm-gated, and can never be
  // inferred from a partial desired map.
  if (!providerChanged && (spec.removeEnvVars?.length ?? 0) > 0) {
    const retiredKeys = [...new Set(spec.removeEnvVars ?? [])].sort();
    for (const name of Object.keys(spec.services)) {
      const mainAction = actions.find((action) => action.id === `service:${name}`);
      const live = observedServices.get(name);
      const keys = observed
        ? retiredKeys.filter((key) => live?.envVarKeys.includes(key))
        : Boolean(localServiceBindings[name]?.serviceId)
          ? retiredKeys
          : [];
      if (keys.length === 0) continue;

      actions.push({
        id: `service:${name}:env-remove`,
        type: 'update',
        resource: { kind: 'service', name, provider },
        verified,
        reason: `Remove explicitly retired environment variables from "${name}". Confirm only after a previously deployed revision no longer depends on: ${keys.join(', ')}`,
        diff: keys.map((key) => ({ field: `env:${key}`, from: 'present', to: 'absent' })),
        requiresConfirm: true,
        ...(mainAction && mainAction.type !== 'noop' ? { dependsOn: [mainAction.id] } : {}),
        metadata: {
          operation: 'hostingEnvRemove',
          keys,
        },
      });
    }
  }

  const serviceDestroyAction = (
    name: string,
    verifiedDestroy: boolean,
    reason: string,
    metadata?: Record<string, unknown>,
    requiresConfirm = true
  ): PlanAction => ({
    id: `service:${name}:destroy`,
    type: 'destroy',
    resource: { kind: 'service', name, provider },
    verified: verifiedDestroy,
    reason,
    ...(requiresConfirm ? { requiresConfirm: true } : {}),
    ...(metadata ? { metadata } : {}),
  });

  // Services absent from the spec: destroy previously managed bindings, but
  // only report truly unknown live resources as unmanaged.
  const plannedServiceDestroys = new Set<string>();
  const ambiguousTaskServicesReported = new Set<string>();
  for (const live of serviceObservationKnown ? observed?.services ?? [] : []) {
    if (spec.services[live.name]) continue;
    if (live.name.startsWith('hv-task-')) {
      const taskCandidates = observedServiceGroups.get(live.name) ?? [];
      const taskExternalIds = Array.from(new Set(taskCandidates.map((candidate) => candidate.externalId)));
      if (taskExternalIds.length > 1) {
        unmanaged.push({
          kind: 'service',
          name: live.name,
          detail: `Multiple leftover task services share this name (${taskExternalIds.sort().join(', ')}); automatic deletion is blocked`,
        });
        if (!ambiguousTaskServicesReported.has(live.name)) {
          warnings.push(`Multiple leftover task services named "${live.name}" were observed. Cleanup is blocked until their exact identities are inspected.`);
          ambiguousTaskServicesReported.add(live.name);
        }
        continue;
      }
      if (plannedServiceDestroys.has(live.name)) continue;
      actions.push(serviceDestroyAction(
        live.name,
        true,
        'Leftover Hypervibe one-off task service',
        serviceDeleteMetadata({
          operation: 'taskServiceCleanup',
          serviceId: live.externalId,
          provider,
          projectId: local.bindings?.projectId,
          environmentId: local.bindings?.environmentId,
          serviceName: live.name,
          scope: input.hostingServiceDeleteScope,
        }),
        false
      ));
      plannedServiceDestroys.add(live.name);
      continue;
    }

    // A logical name is not proof of ownership. Only the exact durable id in
    // a removed local binding authorizes deletion; same-name replacements and
    // duplicates remain unmanaged.
    const boundEntry = Object.entries(localServiceBindings).find(([boundName, binding]) => (
      !spec.services[boundName]
      && typeof binding?.serviceId === 'string'
      && binding.serviceId === live.externalId
    ));
    if (boundEntry) {
      const [boundName, binding] = boundEntry;
      if (plannedServiceDestroys.has(boundName)) continue;
      actions.push(serviceDestroyAction(
        boundName,
        true,
        `Service "${boundName}" was removed from the spec and is managed by Hypervibe`,
        serviceDeleteMetadata({
          operation: 'hostingServiceDestroy',
          serviceId: binding!.serviceId!,
          provider,
          projectId: local.bindings?.projectId,
          environmentId: local.bindings?.environmentId,
          serviceName: boundName,
          scope: input.hostingServiceDeleteScope,
        })
      ));
      plannedServiceDestroys.add(boundName);
    } else {
      unmanaged.push({ kind: 'service', name: live.name, detail: `Running on ${provider} but absent from spec` });
    }
  }

  for (const [name, binding] of Object.entries(localServiceBindings)) {
    if (spec.services[name] || plannedServiceDestroys.has(name) || !binding?.serviceId) continue;
    const liveIdentityMatches = serviceObservationKnown
      ? (observed?.services ?? []).filter((service) => service.externalId === binding.serviceId)
      : [];
    if (liveIdentityMatches.length > 0) {
      warnings.push(
        `Removed service binding "${name}" points to provider id ${binding.serviceId}, which is still observed as ${liveIdentityMatches.map((service) => `"${service.name}"`).join(', ')}. Automatic deletion is blocked until the identity conflict is resolved.`
      );
      continue;
    }
    const absenceVerified = Boolean(observed && serviceObservationKnown);
    actions.push(serviceDestroyAction(
      name,
      absenceVerified,
      absenceVerified
        ? `Service "${name}" was removed from the spec and its bound service is absent from the target provider scope`
        : `Service "${name}" was removed from the spec and has a local ${provider} binding`,
      serviceDeleteMetadata({
        operation: 'hostingServiceDestroy',
        serviceId: binding.serviceId,
        provider,
        projectId: local.bindings?.projectId,
        environmentId: local.bindings?.environmentId,
        serviceName: name,
        scope: input.hostingServiceDeleteScope,
      })
    ));
    plannedServiceDestroys.add(name);
  }

  // ---- abandoned hosting provider teardown ----------------------------------
  // A provider switch stashes the old provider's bindings as previousHosting;
  // offer confirm-gated deletion of each service still running there.
  const retainedCleanup = diffRetainedHostingCleanup({
    envName,
    currentProvider: provider,
    previousHosting: local.bindings?.previousHosting,
    teardownBoundary: input.previousHostingTeardownBoundary,
  });
  actions.push(...retainedCleanup.actions);
  warnings.push(...retainedCleanup.warnings);

  // ---- database -------------------------------------------------------------
  const desiredDatabaseEngine = spec.database?.engine;
  const localDb = local.components.find((component) => (
    desiredDatabaseEngine
      ? component.type === desiredDatabaseEngine
      : component.type === 'postgres'
  ));
  const localDbBindings = localDb?.bindings as Record<string, unknown> | undefined;
  const localDbProvider = localDb
    ? String(localDbBindings?.provider ?? '') || undefined
    : undefined;
  const previousDbProvider = localDb
    ? String(localDbBindings?.previousProvider ?? '') || undefined
    : undefined;
  const previousDbBindings = localDbBindings?.previousBindings
    && typeof localDbBindings.previousBindings === 'object'
    && !Array.isArray(localDbBindings.previousBindings)
    ? localDbBindings.previousBindings as Record<string, unknown>
    : undefined;
  const previousDbExternalId = typeof localDbBindings?.previousExternalId === 'string'
    && localDbBindings.previousExternalId.length > 0
    ? localDbBindings.previousExternalId
    : typeof previousDbBindings?.instanceId === 'string' && previousDbBindings.instanceId.length > 0
      ? previousDbBindings.instanceId
      : typeof previousDbBindings?.serviceId === 'string' && previousDbBindings.serviceId.length > 0
        ? previousDbBindings.serviceId
        : undefined;
  const observedDatabases = databaseObservationKnown
    ? (observed?.databases ?? []).filter((database) => (
      desiredDatabaseEngine
        ? database.engine === desiredDatabaseEngine
        : database.engine === 'postgres'
    ))
    : [];
  const localDbExternalId = localDb?.externalId
    ?? (typeof localDbBindings?.instanceId === 'string' ? localDbBindings.instanceId : undefined)
    ?? (typeof localDbBindings?.serviceId === 'string' ? localDbBindings.serviceId : undefined);
  const localDbScope = localDbBindings?.providerScope
    && typeof localDbBindings.providerScope === 'object'
    && !Array.isArray(localDbBindings.providerScope)
    ? localDbBindings.providerScope as Record<string, unknown>
    : undefined;
  const destroyProviderScope = (value: unknown): Record<string, string> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.some(([, item]) => typeof item !== 'string' || item.length === 0)) {
      return null;
    }
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const localDbDestroyScope = destroyProviderScope(localDbBindings?.providerScope);
  const previousDbDestroyScope = destroyProviderScope(previousDbBindings?.providerScope);
  const databaseMatchesLocalBinding = (database: NonNullable<ObservedState['databases']>[number]): boolean => {
    if (!localDbExternalId || database.externalId !== localDbExternalId) return false;
    if (localDbProvider && database.provider !== localDbProvider) return false;
    const localScopeEntries = Object.entries(localDbScope ?? {});
    const liveScopeEntries = Object.entries(database.providerScope ?? {});

    // Scope is part of a durable provider identity. If persisted state knows a
    // scope, an unscoped or partially scoped observation cannot prove that the
    // matching bare id belongs to this environment.
    if (localScopeEntries.length > 0) {
      if (liveScopeEntries.length !== localScopeEntries.length) return false;
      return localScopeEntries.every(([key, value]) => (
        typeof value === 'string'
        && value.length > 0
        && database.providerScope?.[key] === value
      ));
    }
    if (liveScopeEntries.length === 0) return true;

    // Scoped provider ids are identities only together with their provider
    // scope. Read legacy flattened scope fields when present, but never accept
    // an unscoped id as proof that a scoped live datastore is the same one.
    return liveScopeEntries.every(([key, value]) => {
      const localValue = localDbScope?.[key] ?? localDbBindings?.[key];
      return typeof localValue === 'string' && localValue === value;
    });
  };
  const boundObservedDatabases = localDb
    ? observedDatabases.filter(databaseMatchesLocalBinding)
    : [];
  const observedDb = boundObservedDatabases.length === 1
    ? boundObservedDatabases[0]
    : !localDb && observedDatabases.length === 1
      ? observedDatabases[0]
      : undefined;
  const databaseAmbiguous = boundObservedDatabases.length > 1
    || (!observedDb && observedDatabases.length > 1);
  const databaseIdentityMismatch = Boolean(
    localDb
    && observed
    && databaseObservationKnown
    && observedDatabases.length > 0
    && !observedDb
    && !databaseAmbiguous
  );
  const desiredDatabaseBindingAbsent = Boolean(
    localDb
    && localDbProvider
    && localDbProvider === spec.database?.provider
    && observed
    && databaseObservationKnown
    && observedDatabases.length === 0
  );
  const currentDbProvider = observed && databaseObservationKnown ? observedDb?.provider : localDbProvider;
  const dbVerified = Boolean(observed && databaseObservationKnown);
  const databaseProvisioningIncomplete = localDbBindings?.provisioningIncomplete === true;
  const unresolvedDatabaseCreate = parseUnresolvedDatabaseMutation(localDbBindings);
  const unresolvedCreateCandidates = unresolvedDatabaseCreate && databaseObservationKnown
    ? observedDatabases.filter((database) => (
        database.provider === localDbProvider
        && database.name === unresolvedDatabaseCreate.resourceName
        && Object.entries(unresolvedDatabaseCreate.providerScope).every(([key, value]) => (
          database.providerScope?.[key] === value
        ))
      ))
    : [];
  let activeDatabaseActionId: string | undefined;

  if (observedDb && localDb) {
    for (const database of observedDatabases) {
      if (database === observedDb) continue;
      unmanaged.push({
        kind: 'database',
        name: database.name ?? database.engine,
        detail: `${database.provider} datastore ${database.externalId} is not the bound ${database.engine} datastore`,
      });
    }
  }

  if (databaseProvisioningIncomplete) {
    const retainedProvider = localDbProvider ?? spec.database?.provider ?? 'unknown';
    const retainedId = `database:${retainedProvider}`;
    activeDatabaseActionId = spec.database ? retainedId : undefined;
    if (unresolvedDatabaseCreate && localDbProvider && localDbBindings) {
      const observedCandidate = unresolvedCreateCandidates.length === 1
        ? unresolvedCreateCandidates[0]
        : undefined;
      actions.push({
        id: retainedId,
        type: 'update',
        resource: {
          kind: 'database',
          name: localDb?.type ?? spec.database?.engine ?? 'postgres',
          provider: retainedProvider,
        },
        verified: Boolean(databaseObservationKnown && observedCandidate),
        reason: observedCandidate
          ? `The previously unresolved ${retainedProvider} database create is now visible as ${observedCandidate.externalId}, but explicit reconciliation is required`
          : unresolvedCreateCandidates.length > 1
            ? `Multiple ${retainedProvider} databases now match the unresolved create name; no identity can be selected`
            : `The outcome of the previous ${retainedProvider} database create remains unresolved`,
        metadata: {
          blockedReason: observedCandidate
            ? 'database_unresolved_create_observed'
            : unresolvedCreateCandidates.length > 1
              ? 'database_unresolved_create_ambiguous'
              : 'database_unresolved_create_unknown',
          resourceName: unresolvedDatabaseCreate.resourceName,
          providerScope: unresolvedDatabaseCreate.providerScope,
          ...(observedCandidate ? {
            externalId: observedCandidate.externalId,
            observedProviderScope: observedCandidate.providerScope,
          } : {}),
          ...(unresolvedCreateCandidates.length > 1 ? {
            externalIds: unresolvedCreateCandidates.map((candidate) => candidate.externalId).sort(),
          } : {}),
        },
      });
      warnings.push(observedCandidate
        ? `Database create ${unresolvedDatabaseCreate.resourceName} is now visible as ${observedCandidate.externalId}. Inspect that exact ID, then use hv_import mode="retained-database-cleanup" and the isolated retained-cleanup plan to delete it; Hypervibe will clear the matching unresolved marker only after terminal absence.`
        : `Database create ${unresolvedDatabaseCreate.resourceName} has no safely reconciled provider ID. Hypervibe will not retry the billable create; re-observe its exact scope and, if it appears, use hv_import mode="retained-database-cleanup" for that exact ID.`);
    } else if (!localDbProvider || !localDbExternalId || !localDbDestroyScope || !localDbBindings) {
      actions.push({
        id: retainedId,
        type: 'update',
        resource: {
          kind: 'database',
          name: localDb?.type ?? spec.database?.engine ?? 'postgres',
          provider: retainedProvider,
        },
        verified: false,
        reason: 'A failed database provision was retained without a complete cleanup identity',
        metadata: { blockedReason: 'database_incomplete_provision_identity_missing' },
      });
      warnings.push('Database reconciliation is blocked because the retained failed provision lacks a complete provider id and scope. Inspect the provider and repair the exact binding before any retry or deletion.');
    } else if (spec.database) {
      actions.push({
        id: retainedId,
        type: 'update',
        resource: { kind: 'database', name: localDb!.type, provider: localDbProvider },
        verified: false,
        reason: `The ${localDbProvider} database create was acknowledged, but readiness and runtime credentials were not fully proven`,
        metadata: {
          blockedReason: 'database_provision_incomplete',
          externalId: localDbExternalId,
          providerScope: localDbDestroyScope,
        },
      });
      warnings.push(`Database ${localDbExternalId} is retained for recovery and will not be treated as active. Inspect it with hv_inspect; to recreate safely, remove the database from desired state, confirm its exact cleanup, then add it again.`);
    } else {
      actions.push({
        id: `${retainedId}:destroy`,
        type: 'destroy',
        resource: { kind: 'database', name: localDb!.type, provider: localDbProvider },
        verified: Boolean(observedDb),
        reason: `Delete the incomplete ${localDbProvider} database provision before clearing or restoring any previous database binding`,
        dataBearing: true,
        requiresConfirm: true,
        metadata: {
          externalId: localDbExternalId,
          providerScope: localDbDestroyScope,
          bindingsFingerprint: bindingIdentityFingerprint(localDbBindings),
          incompleteProvision: true,
        },
      });
    }
  } else if (spec.database) {
    const wanted = spec.database.provider;
    const databaseEngineLabel = 'PostgreSQL';
    const createId = `database:${wanted}`;
    activeDatabaseActionId = createId;
    if (databaseAmbiguous) {
      const candidateIds = observedDatabases.map((database) => database.externalId).sort();
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `Multiple ${databaseEngineLabel} datastores were observed; Hypervibe cannot safely select one`,
        metadata: {
          blockedReason: 'ambiguous_database_identity',
          externalIds: candidateIds,
        },
      });
      warnings.push(`Multiple ${databaseEngineLabel} datastores were observed (${candidateIds.join(', ')}). Database mutations are blocked; remove the unmanaged candidates because generic database adoption is not implemented.`);
      for (const database of observedDatabases) {
        if (database.externalId === localDb?.externalId) continue;
        unmanaged.push({
          kind: 'database',
          name: database.name ?? database.engine,
          detail: `${database.provider} datastore ${database.externalId} is an additional ${databaseEngineLabel} candidate`,
        });
      }
    } else if (observed && !databaseObservationKnown) {
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: false,
        reason: localDbProvider === wanted
          ? 'Preserving the locally bound database, but blocking dependent mutations because live database observation is unknown'
          : `Cannot verify whether the desired ${wanted} database exists`,
        metadata: { blockedReason: 'database_observation_unknown' },
      });
    } else if (desiredDatabaseBindingAbsent) {
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `The locally bound ${databaseEngineLabel} datastore is absent; refusing to silently create a replacement`,
        metadata: {
          blockedReason: 'database_binding_absent',
          boundExternalId: localDbExternalId,
        },
      });
      warnings.push(
        `The durable ${wanted} database binding ${localDbExternalId ?? '(missing id)'} was not found. Resolve the missing data resource explicitly before planning a replacement.`
      );
    } else if (databaseIdentityMismatch) {
      const candidateIds = observedDatabases.map((database) => database.externalId).sort();
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `The locally bound ${databaseEngineLabel} identity is absent, while a different live datastore is an adoption candidate`,
        metadata: {
          blockedReason: 'database_binding_identity_mismatch',
          boundExternalId: localDbExternalId,
          externalIds: candidateIds,
        },
      });
      for (const database of observedDatabases) {
        unmanaged.push({
          kind: 'database',
          name: database.name ?? database.engine,
          detail: `${database.provider} datastore ${database.externalId} does not match the durable local binding ${localDbExternalId ?? '(missing)'}`,
        });
      }
    } else if (
      observedDb
      && currentDbProvider === wanted
      && observedDb.status !== 'running'
    ) {
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `The bound ${databaseEngineLabel} datastore is ${observedDb.status}, not running`,
        metadata: {
          blockedReason: 'database_not_running',
          observedStatus: observedDb.status,
          externalId: observedDb.externalId,
          ...(observedDb.providerScope ? { providerScope: observedDb.providerScope } : {}),
        },
      });
      warnings.push(
        `Database ${observedDb.externalId} is ${observedDb.status}; dependent service mutations are blocked until live observation reports running.`
      );
    } else if (!currentDbProvider) {
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified,
        reason: `No ${spec.database.engine} database exists`,
        billable: true,
        dependsOn: wanted === provider || input.databaseDependsOnHostingProject
          ? projectDep
          : undefined,
      });
    } else if (
      currentDbProvider !== wanted
      && observedDatabases.some((database) => database.provider === wanted)
    ) {
      const candidates = observedDatabases
        .filter((database) => database.provider === wanted)
        .sort((left, right) => left.externalId.localeCompare(right.externalId));
      const candidateIds = candidates.map((database) => database.externalId);
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: candidates.length === 1
          ? `A live ${wanted} ${databaseEngineLabel} datastore already exists but is not the durable local binding; refusing to create a duplicate during provider change`
          : `Multiple live ${wanted} ${databaseEngineLabel} datastores already exist; refusing to create another during provider change`,
        metadata: candidates.length === 1
          ? {
              blockedReason: 'database_adoption_required',
              externalId: candidates[0].externalId,
              observedName: candidates[0].name,
            }
          : {
              blockedReason: 'ambiguous_database_identity',
              externalIds: candidateIds,
            },
      });
      warnings.push(
        candidates.length === 1
          ? `The existing ${wanted} database ${candidateIds[0]} must be removed before Hypervibe can continue the provider change; generic database adoption is not implemented.`
          : `Multiple unbound ${wanted} databases were observed (${candidateIds.join(', ')}). Database mutations are blocked; generic database adoption is not implemented.`,
      );
      for (const database of candidates) {
        unmanaged.push({
          kind: 'database',
          name: database.name ?? database.engine,
          detail: `${database.provider} datastore ${database.externalId} is an unbound provider-change candidate`,
        });
      }
    } else if (currentDbProvider !== wanted) {
      warnings.push(
        `Database provider change from ${currentDbProvider} to ${wanted} is staged: this plan creates the new database only. Hypervibe does not migrate data automatically and will not delete the old database in this plan.`
      );
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: `Database provider changes from ${currentDbProvider} to ${wanted}. Create the new database first; services and old database deletion are planned after the new database is recorded locally.`,
        billable: true,
        dependsOn: wanted === provider || input.databaseDependsOnHostingProject
          ? projectDep
          : undefined,
      });
    } else if (observedDb && !localDb) {
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `A live ${wanted} ${spec.database.engine} datastore exists without a durable Hypervibe binding`,
        metadata: {
          blockedReason: 'database_adoption_required',
          externalId: observedDb.externalId,
          observedName: observedDb.name,
        },
      });
      unmanaged.push({
        kind: 'database',
        name: observedDb.name ?? observedDb.engine,
        detail: `${observedDb.provider} datastore ${observedDb.externalId} is unbound; generic database adoption is not implemented`,
      });
    } else {
      actions.push({
        id: createId,
        type: 'noop',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: 'Database in sync',
      });
      if (previousDbProvider && previousDbProvider !== wanted) {
        warnings.push(
          `Database cutover from ${previousDbProvider} to ${wanted} is pending: restore data into ${wanted}, apply the service env updates, verify health, then confirm the old ${previousDbProvider} destroy.`
        );
        if (previousDbExternalId && previousDbDestroyScope && previousDbBindings) {
          actions.push({
            id: `database:${previousDbProvider}:destroy`,
            type: 'destroy',
            resource: { kind: 'database', name: spec.database.engine, provider: previousDbProvider },
            // The active provider observation cannot verify a retained database
            // that belongs to a different provider connection.
            verified: false,
            reason: `Previous ${previousDbProvider} database is no longer active. Data is NOT migrated automatically — confirm only after cutover is verified.`,
            dataBearing: true,
            requiresConfirm: true,
            metadata: {
              externalId: previousDbExternalId,
              providerScope: previousDbDestroyScope,
              bindingsFingerprint: bindingIdentityFingerprint(previousDbBindings),
            },
          });
        } else {
          actions.push({
            id: `database:${previousDbProvider}:destroy`,
            type: 'update',
            resource: { kind: 'database', name: spec.database.engine, provider: previousDbProvider },
            verified: false,
            reason: `The retained ${previousDbProvider} database binding lacks an exact provider id or scope; refusing to authorize its destruction`,
            metadata: { blockedReason: 'database_previous_binding_incomplete' },
          });
          warnings.push(
            `Repair or explicitly resolve the retained ${previousDbProvider} database provider id and scope before cleanup.`
          );
        }
      }
    }

    if (spec.database.seedCommand) {
      const commandHash = seedCommandHash(spec.database.seedCommand);
      const seedRecord = localDbBindings?.seed && typeof localDbBindings.seed === 'object' && !Array.isArray(localDbBindings.seed)
        ? localDbBindings.seed as Record<string, unknown>
        : {};
      const seeded = currentDbProvider === wanted
        && seedRecord.commandHash === commandHash
        && typeof seedRecord.seededAt === 'string';
      const serviceDeps = actions
        .filter((action) => action.resource.kind === 'service' && !action.id.includes(':destroy'))
        .map((action) => action.id);
      actions.push({
        id: `database:${wanted}:seed`,
        type: seeded ? 'noop' : 'update',
        resource: { kind: 'database', name: 'seed', provider: wanted },
        verified: dbVerified,
        reason: seeded
          ? 'Database seed command has already completed for this database'
          : currentDbProvider && currentDbProvider !== wanted
            ? `Seed command will run after the new ${wanted} database is created`
            : 'Database seed command has not completed for this database',
        dependsOn: [createId, ...serviceDeps],
        metadata: {
          operation: 'databaseSeed',
          engine: spec.database.engine,
          command: spec.database.seedCommand,
          commandHash,
          mode: 'once',
        },
      });
    }
  } else if (observed && !databaseObservationKnown && localDb) {
    actions.push({
      id: `database:${localDbProvider ?? 'postgres'}:observation-blocked`,
      type: 'update',
      resource: { kind: 'database', name: localDb.type, provider: localDbProvider ?? 'unknown' },
      verified: false,
      reason: 'Database was removed from the spec, but live observation is unknown; refusing to destroy it',
      metadata: { blockedReason: 'database_observation_unknown' },
    });
  } else if (localDb && (currentDbProvider ?? localDbProvider)) {
    const destroyDbProvider = currentDbProvider ?? localDbProvider!;
    // A completed provider cutover can leave two managed data-bearing resources
    // in one component. Retire the retained provider first so deleting the
    // current component cannot discard the only durable identity for the old
    // database. The current action fingerprints the binding shape that will
    // remain after the retained cleanup succeeds.
    const serviceDestroyDependencies = actions
      .filter((action) => action.resource.kind === 'service' && action.type === 'destroy')
      .map((action) => action.id);
    const currentDestroyId = `database:${destroyDbProvider}:destroy`;
    const currentBindingComplete = Boolean(
      localDbProvider === destroyDbProvider
      && localDbExternalId
      && localDbDestroyScope
      && localDbBindings
    );

    if (!currentBindingComplete) {
      actions.push({
        id: currentDestroyId,
        type: 'update',
        resource: { kind: 'database', name: localDb.type, provider: destroyDbProvider },
        verified: false,
        reason: `Database was removed from the spec, but its durable ${destroyDbProvider} binding lacks an exact provider id, provider name, or scope; refusing to authorize destruction`,
        metadata: { blockedReason: 'database_binding_incomplete' },
      });
      warnings.push(
        `Repair or explicitly resolve the ${destroyDbProvider} database provider id and scope before cleanup.`
      );
    } else {
      const retainedPreviousDestroyId = previousDbProvider && previousDbProvider !== destroyDbProvider
        ? `database:${previousDbProvider}:destroy`
        : undefined;
      let currentBindingsForDestroy = localDbBindings!;

      if (retainedPreviousDestroyId) {
        if (previousDbExternalId && previousDbDestroyScope && previousDbBindings) {
          actions.push({
            id: retainedPreviousDestroyId,
            type: 'destroy',
            resource: { kind: 'database', name: localDb.type, provider: previousDbProvider! },
            verified: false,
            reason: `Database was removed from the spec. Destroy the retained ${previousDbProvider} database before the active ${destroyDbProvider} database so neither durable identity is lost.`,
            dataBearing: true,
            requiresConfirm: true,
            metadata: {
              externalId: previousDbExternalId,
              providerScope: previousDbDestroyScope,
              bindingsFingerprint: bindingIdentityFingerprint(previousDbBindings),
            },
          });
        } else {
          actions.push({
            id: retainedPreviousDestroyId,
            type: 'update',
            resource: { kind: 'database', name: localDb.type, provider: previousDbProvider! },
            verified: false,
            reason: `Database was removed from the spec, but the retained ${previousDbProvider} database binding lacks an exact provider id or scope; refusing to discard it while destroying the active database`,
            metadata: { blockedReason: 'database_previous_binding_incomplete' },
          });
          warnings.push(
            `The retained ${previousDbProvider} database binding is incomplete. Repair or explicitly resolve its durable provider identity before destroying the active ${destroyDbProvider} database.`
          );
        }

        currentBindingsForDestroy = { ...currentBindingsForDestroy };
        delete currentBindingsForDestroy.previousProvider;
        delete currentBindingsForDestroy.previousExternalId;
        delete currentBindingsForDestroy.previousBindings;
      }

      // Spec no longer declares a database but we manage one: confirm-gated destroy.
      actions.push({
        id: currentDestroyId,
        type: 'destroy',
        resource: { kind: 'database', name: localDb.type, provider: destroyDbProvider },
        verified: dbVerified,
        reason: observedDb
          ? 'Database removed from spec. Data will be lost — confirm to destroy.'
          : 'Database removed from spec and its exact bound provider identity is already absent. Confirm the idempotent teardown to clear the durable local binding.',
        dataBearing: true,
        requiresConfirm: true,
        metadata: {
          externalId: localDbExternalId,
          providerScope: localDbDestroyScope,
          bindingsFingerprint: bindingIdentityFingerprint(currentBindingsForDestroy),
        },
        dependsOn: [
          ...(retainedPreviousDestroyId ? [retainedPreviousDestroyId] : []),
          ...serviceDestroyDependencies,
        ],
      });
    }
  } else if (observedDb && !localDb) {
    unmanaged.push({
      kind: 'database',
      name: observedDb.engine,
      detail: `${observedDb.provider} database exists but is not managed by the spec`,
    });
  }

  const activeDatabaseAction = activeDatabaseActionId
    ? actions.find((action) => action.id === activeDatabaseActionId)
    : undefined;
  const activeDatabaseBlocked = typeof activeDatabaseAction?.metadata?.blockedReason === 'string';
  if (
    activeDatabaseAction
    && activeDatabaseAction.type !== 'noop'
    && (!currentDbProvider || activeDatabaseBlocked)
  ) {
    for (const serviceAction of actions.filter((action) =>
      action.resource.kind === 'service'
      && action.type !== 'destroy'
      && !action.id.includes(':env-remove')
    )) {
      if (serviceAction.type === 'noop' && !activeDatabaseBlocked) {
        serviceAction.type = 'update';
        serviceAction.reason = `${serviceAction.reason}; wire the newly created ${activeDatabaseAction.resource.provider} database`;
      }
      serviceAction.dependsOn = Array.from(new Set([
        ...(serviceAction.dependsOn ?? []),
        activeDatabaseAction.id,
      ]));
    }
  }

  if (spec.database) {
    const canonicalKey = 'DATABASE_URL';
    for (const serviceAction of actions.filter((action) =>
      action.resource.kind === 'service'
      && (action.type === 'create' || action.type === 'replace')
    )) {
      const serviceSpec = spec.services[serviceAction.resource.name];
      if (!serviceSpec || Object.keys(serviceSpec.databaseEnvAliases ?? {}).length > 0) continue;
      warnings.push(
        `New service "${serviceAction.resource.name}" will receive the managed database contract through ${canonicalKey}. `
        + `Hypervibe can verify variable attachment but cannot prove application code consumes it; declare service.databaseEnvAliases for legacy runtime names.`
      );
    }
  }

  // ---- domain ---------------------------------------------------------------
  const boundDomainDns = local.bindings?.domainDns;
  if (spec.domain && !spec.loadBalancer) {
    const id = `domain:${spec.domain}`;
    const attachedServices = observed
      ? observed.services.filter((service) => service.customDomains.includes(spec.domain!))
      : [];
    const attachedService = attachedServices.length === 1 ? attachedServices[0] : undefined;
    const attached = observed
      ? attachedServices.length > 0
      : Object.values(localServiceBindings).some((b) => b.customDomains?.includes(spec.domain!));
    const domainStatus = attachedService?.customDomainStatus?.[spec.domain];
    const domainBindingPresent = boundDomainDns?.name === spec.domain
      && Boolean(
        boundDomainDns.providerDomainId
        && boundDomainDns.serviceId
        && boundDomainDns.environmentId
      );
    const legacyServiceBinding = attachedService
      ? localServiceBindings[attachedService.name]
      : undefined;
    const boundServiceDomainAdoption = Boolean(
      observed
      && attachedServices.length === 1
      && !domainBindingPresent
      && (!boundDomainDns?.name || boundDomainDns.name === spec.domain)
      && domainStatus?.providerDomainId
      && domainStatus.providerVerified === true
      && local.bindings?.projectId === observed.projectId
      && observed.environmentId
      && local.bindings?.environmentId === observed.environmentId
      && legacyServiceBinding?.serviceId === attachedService?.externalId
    );
    const ambiguousDomainAttachment = attachedServices.length > 1;
    const dnsConfigured = domainStatus?.dnsConfigured;
    const desiredDomainProxy = input.customDomainTrafficProxy === 'dns-only'
      ? false
      : spec.domainProxy ?? true;
    const appliedDomainProxy = boundDomainDns?.name === spec.domain
      ? boundDomainDns.proxied
      : undefined;
    const appliedDomainRecreateRevision = boundDomainDns?.name === spec.domain
      ? boundDomainDns.recreateRevision
      : undefined;
    const domainRecreateNeeded = Boolean(
      spec.domainRecreateRevision
      && spec.domainRecreateRevision !== appliedDomainRecreateRevision
    );
    const domainProxyDrift = appliedDomainProxy !== undefined
      && appliedDomainProxy !== desiredDomainProxy;
    const providerDnsIsProxyOpaque = desiredDomainProxy
      && appliedDomainProxy === true
      && domainStatus?.providerVerified === true
      && certificateStatusIsReady(domainStatus.certificateStatus);
    const domainDnsConfigured = dnsConfigured !== false || providerDnsIsProxyOpaque;
    const customDomainsManaged = input.customDomainManagement === 'managed';
    const configured = customDomainsManaged
      && attached
      && domainBindingPresent
      && domainDnsConfigured
      && (domainStatus?.providerVerified === true
        || (domainStatus?.providerVerified === undefined && dnsConfigured === true))
      && !domainProxyDrift;
    actions.push({
      id,
      type: !customDomainsManaged
        ? 'update'
        : domainRecreateNeeded
          ? 'replace'
          : configured
            ? 'noop'
            : 'update',
      resource: { kind: 'domain', name: spec.domain, provider },
      verified: customDomainsManaged && verified,
      reason: !customDomainsManaged
        ? `${provider} does not implement managed environment custom domains; DNS will not be changed for ${spec.domain}`
        : domainRecreateNeeded
        ? `Domain ${spec.domain} has an unapplied recreate revision`
        : ambiguousDomainAttachment
          ? `Multiple provider services have a custom-domain attachment matching ${spec.domain}; Hypervibe will not choose one`
        : boundServiceDomainAdoption
          ? `Domain ${spec.domain} is verified on the exact bound ${attachedService!.name} service; adopt the provider identity without changing the provider attachment`
        : attached
        ? !domainBindingPresent
          ? `Domain ${spec.domain} exists on ${provider}, but its durable provider identity is not bound locally; use hv_import or remove the unmanaged attachment before applying`
          : !domainDnsConfigured
          ? `Domain ${spec.domain} is attached on ${provider}, but required DNS records are not configured`
          : domainStatus?.providerVerified === false
            ? `Domain ${spec.domain} DNS is configured, but ${provider} ownership verification is still pending`
            : domainProxyDrift
              ? `Domain ${spec.domain} traffic proxy does not match desired state`
              : dnsConfigured === undefined
                ? `Domain ${spec.domain} is attached on ${provider}, but provider verification status was not observed`
                : 'Domain attached'
        : `Domain ${spec.domain} is not attached to any service`,
      dependsOn: !customDomainsManaged || configured ? undefined : projectDep,
      ...(customDomainsManaged && domainRecreateNeeded ? { requiresConfirm: true } : {}),
      ...(domainProxyDrift
        ? { diff: [{ field: 'dns:proxied', from: String(appliedDomainProxy), to: String(desiredDomainProxy) }] }
        : {}),
      metadata: {
        ...(!customDomainsManaged ? { blockedReason: 'custom_domain_unsupported' } : {}),
        ...(customDomainsManaged && ambiguousDomainAttachment
          ? { blockedReason: 'ambiguous_domain_identity' }
          : {}),
        ...(customDomainsManaged && boundServiceDomainAdoption
          ? {
            operation: DOMAIN_ADOPT_OPERATION,
            providerDomainId: domainStatus!.providerDomainId,
            projectId: observed!.projectId,
            serviceName: attachedService!.name,
            serviceId: attachedService!.externalId,
            environmentId: observed!.environmentId,
          }
          : {}),
        ...(customDomainsManaged && attached && !domainBindingPresent && !boundServiceDomainAdoption && !ambiguousDomainAttachment
          ? { blockedReason: 'domain_binding_missing' }
          : {}),
        ...(domainStatus?.dnsRecords ? { dnsRecords: domainStatus.dnsRecords } : {}),
        domainProxy: desiredDomainProxy,
        ...(input.customDomainTrafficProxy === 'dns-only'
          ? { domainTrafficProxy: 'dns-only' }
          : {}),
        ...(spec.domainRecreateRevision
          ? { domainRecreateRevision: spec.domainRecreateRevision }
          : {}),
      },
    });
  } else if (!spec.domain && !spec.loadBalancer && boundDomainDns?.name) {
    const domain = boundDomainDns.name;
    const id = `domain:${domain}`;
    const attachedService = observed && serviceObservationKnown
      ? observed.services.find((service) => service.customDomains.includes(domain))
      : undefined;
    const serviceName = boundDomainDns.serviceName ?? attachedService?.name;
    const serviceId = boundDomainDns.serviceId
      ?? attachedService?.externalId
      ?? (serviceName ? localServiceBindings[serviceName]?.serviceId : undefined);
    const environmentId = boundDomainDns.environmentId ?? local.bindings?.environmentId;
    const projectId = local.bindings?.projectId;
    const providerDomainId = boundDomainDns.providerDomainId;
    const zoneId = boundDomainDns.zoneId;
    const dnsRecordIds = (boundDomainDns.records ?? []).map((record) => record.id);
    const customDomainsManaged = input.customDomainManagement === 'managed';
    const observationKnown = observed !== null && serviceObservationKnown;
    const bindingComplete = Boolean(
      projectId
      && serviceName
      && serviceId
      && environmentId
      && providerDomainId
      && zoneId
      && Array.isArray(boundDomainDns.records)
    );
    const blockedReason = !customDomainsManaged
      ? 'custom_domain_unsupported'
      : !observationKnown
        ? 'domain_observation_unknown'
        : !bindingComplete
          ? 'domain_detach_binding_incomplete'
          : undefined;
    actions.push({
      id,
      type: 'destroy',
      resource: { kind: 'domain', name: domain, provider: boundProvider ?? provider },
      verified: verified && serviceObservationKnown,
      requiresConfirm: true,
      reason: blockedReason === 'custom_domain_unsupported'
        ? `${boundProvider ?? provider} does not implement managed custom-domain teardown`
        : blockedReason === 'domain_observation_unknown'
          ? `Cannot safely detach ${domain} because provider domain observation is unknown`
          : blockedReason === 'domain_detach_binding_incomplete'
            ? `Cannot safely detach ${domain} because its durable provider or DNS identities are incomplete`
            : attachedService
              ? `Domain ${domain} is no longer desired and remains attached to ${attachedService.name}`
              : `Domain ${domain} is no longer desired; remove its verified provider attachment and managed DNS records`,
      metadata: {
        operation: DOMAIN_DETACH_OPERATION,
        ...(projectId ? { projectId } : {}),
        ...(serviceName ? { serviceName } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(providerDomainId ? { providerDomainId } : {}),
        ...(zoneId ? { zoneId } : {}),
        dnsRecordIds,
        ...(blockedReason ? { blockedReason } : {}),
      },
    });
    for (const serviceAction of actions.filter((action) => (
      action.resource.kind === 'service'
      && action.type === 'destroy'
      && (!serviceName || action.resource.name === serviceName)
    ))) {
      serviceAction.dependsOn = Array.from(new Set([...(serviceAction.dependsOn ?? []), id]));
    }
  }

  return { actions, unmanaged, warnings };
}

function seedCommandHash(command: string): string {
  return createHash('sha256').update(command.trim(), 'utf8').digest('hex');
}

/** Strip URL prefixes/.git and lowercase so "owner/repo" forms compare equal. */
function normalizeRepo(repo?: string): string | undefined {
  if (!repo) return undefined;
  return repo
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

/** Returns a human-readable drift reason when the live deploy source diverges from the spec. */
function diffDeploySource(
  expected: { repo: string; branch: string },
  live: ObservedService
): string | undefined {
  const liveRepo = normalizeRepo(live.source?.repo);
  const wantedRepo = normalizeRepo(expected.repo);
  if (!liveRepo) {
    return `Deploy source is not connected (expected ${expected.repo}@${expected.branch}); pushes will not deploy`;
  }
  if (wantedRepo && liveRepo !== wantedRepo) {
    return `Deploy source repo is ${live.source?.repo}, expected ${expected.repo}`;
  }
  if (!live.source?.branch) {
    return `Deploy source branch is not recorded (expected ${expected.branch}); reconnect the deploy source`;
  }
  if (live.source?.branch && live.source.branch !== expected.branch) {
    return `Deploy source branch is ${live.source.branch}, expected ${expected.branch}`;
  }
  return undefined;
}

function diffServiceConfig(
  spec: ServiceSpec,
  live: ObservedService,
  envVars: Record<string, string>,
  options: {
    presenceOnlyEnvVars?: Set<string>;
    cacheNetwork?: NonNullable<NonNullable<LocalSnapshot['bindings']>['cacheNetwork']>;
  } = {}
): PlanFieldDiff[] {
  const diff: PlanFieldDiff[] = [];

  // Only fields the spec sets are managed; unset spec fields are ignored.
  const fields: Array<[keyof ServiceSpec & keyof ObservedService['config'], string]> = [
    ['startCommand', 'startCommand'],
    ['releaseCommand', 'releaseCommand'],
    ['healthCheckPath', 'healthCheckPath'],
    ['cronSchedule', 'cronSchedule'],
    ['public', 'public'],
  ];
  for (const [key, field] of fields) {
    const wanted = spec[key];
    if (wanted === undefined) continue;
    const actual = live.config[key];
    if (actual !== wanted) {
      diff.push({ field, from: actual === undefined ? undefined : String(actual), to: String(wanted) });
    }
  }

  for (const [key, value] of Object.entries(envVars)) {
    const liveHash = live.envVarHashes[key];
    if (liveHash === undefined) {
      diff.push({ field: `env:${key}` });
    } else if (options.presenceOnlyEnvVars?.has(key)) {
      continue;
    } else if (liveHash !== hashEnvValue(value)) {
      diff.push({ field: `env:${key}` });
    }
  }

  if (options.cacheNetwork?.network && options.cacheNetwork.subnetwork && options.cacheNetwork.egress) {
    const wanted = {
      network: options.cacheNetwork.network,
      subnetwork: options.cacheNetwork.subnetwork,
      egress: options.cacheNetwork.egress,
    };
    if (JSON.stringify(live.config.cacheNetwork) !== JSON.stringify(wanted)) {
      diff.push({ field: 'cacheNetwork' });
    }
  }

  return diff;
}

/** Re-exported for hv_apply's confirm flow and tests. */
export function confirmGatedActionIds(actions: PlanAction[]): string[] {
  return actions.filter((a) => a.requiresConfirm).map((a) => a.id);
}
