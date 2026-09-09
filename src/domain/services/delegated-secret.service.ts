import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { ActionReceipt } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import type {
  DelegatedSecretSpec,
  HypervibeSecretSpec,
  ProjectSecretSpec,
  ProjectSpec,
} from '../spec/spec.schema.js';

export const DELEGATED_SECRET_OPERATION = 'delegatedSecretSync';

interface RuntimeSecretBindingBase {
  name: string;
  principal: string;
  valueHash: string;
  syncedAt: string;
  applyRunId: string;
  actionId: string;
}

export type DelegatedSecretBinding = RuntimeSecretBindingBase & (
  | { source: 'delegated-plan-input' }
  | {
      source: 'hypervibe-generated';
      generator: HypervibeSecretSpec['generator'];
      generation: number;
    }
);

export interface DelegatedSecretInputRequirement {
  key: string;
  principal: string;
  reason: string;
}

export interface ManagedSecretBlocker {
  key: string;
  reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function delegatedSecretActionId(key: string): string {
  return `secret:${key}`;
}

export function managedSecretsForEnvironment(
  spec: ProjectSpec,
  environmentName: string
): Array<[string, ProjectSecretSpec]> {
  return Object.entries(spec.secrets)
    .filter(([, secret]) => secret.environments.includes(environmentName))
    .sort(([left], [right]) => left.localeCompare(right));
}

export function delegatedSecretsForEnvironment(
  spec: ProjectSpec,
  environmentName: string
): Array<[string, DelegatedSecretSpec]> {
  return managedSecretsForEnvironment(spec, environmentName)
    .filter((entry): entry is [string, DelegatedSecretSpec] => entry[1].ownership === 'delegated');
}

function githubCanonicalEnvironment(spec: ProjectSpec): string | undefined {
  if (!spec.github || spec.github.enabled === false) return undefined;
  return spec.github.canonicalEnvironment
    ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0]);
}

export function delegatedSecretInputsForEnvironment(
  spec: ProjectSpec,
  environmentName: string
): Array<[string, DelegatedSecretSpec]> {
  const canonical = githubCanonicalEnvironment(spec);
  return Object.entries(spec.secrets)
    .filter((entry): entry is [string, DelegatedSecretSpec] => entry[1].ownership === 'delegated')
    .filter(([, secret]) =>
      secret.environments.includes(environmentName)
      || (canonical === environmentName && Boolean(
        secret.githubActions?.repository || secret.githubActions?.environments.length
      ))
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

export function delegatedGitHubSecretsForEnvironment(
  spec: ProjectSpec,
  environmentName: string
): Array<[string, DelegatedSecretSpec]> {
  if (githubCanonicalEnvironment(spec) !== environmentName) return [];
  return Object.entries(spec.secrets)
    .filter((entry): entry is [string, DelegatedSecretSpec] => entry[1].ownership === 'delegated')
    .filter(([, secret]) => secret.githubActions?.repository || secret.githubActions?.environments.length)
    .sort(([left], [right]) => left.localeCompare(right));
}

export function parseDelegatedSecretBindings(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): DelegatedSecretBinding[] {
  // Avoid "secret" in the binding key: repo-bindings-file intentionally strips
  // any key that looks secret-bearing, while this array contains metadata only.
  const raw = environment?.platformBindings.delegatedEnvBindings;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap<DelegatedSecretBinding>((value): DelegatedSecretBinding[] => {
    const record = asRecord(value);
    const name = stringField(record, 'name');
    const principal = stringField(record, 'principal');
    const valueHash = stringField(record, 'valueHash');
    const syncedAt = stringField(record, 'syncedAt');
    const applyRunId = stringField(record, 'applyRunId');
    const actionId = stringField(record, 'actionId');
    if (!name || !principal || !valueHash || !syncedAt || !applyRunId || !actionId) {
      return [];
    }
    const source = stringField(record, 'source');
    if (source === 'hypervibe-generated') {
      const generator = stringField(record, 'generator');
      const generation = record?.generation;
      if (
        generator !== 'random-base64url-32-v1'
        || typeof generation !== 'number'
        || !Number.isInteger(generation)
        || generation < 1
      ) {
        return [];
      }
      return [{
        name,
        principal,
        valueHash,
        source,
        generator,
        generation,
        syncedAt,
        applyRunId,
        actionId,
      }];
    }
    if (source !== undefined && source !== 'delegated-plan-input') return [];
    return [{
      name,
      principal,
      valueHash,
      source: 'delegated-plan-input',
      syncedAt,
      applyRunId,
      actionId,
    }];
  });
}

export interface LiveSecretHashes {
  state: 'unknown' | 'missing' | 'consistent' | 'inconsistent';
  hash?: string;
  hashes: string[];
  hasUnknownDestination: boolean;
  hasMissingDestination: boolean;
}

export function liveHashesForSecret(
  observed: ObservedState | null,
  serviceNames: string[],
  key: string
): LiveSecretHashes {
  if (!observed) {
    return {
      state: 'unknown',
      hashes: [],
      hasUnknownDestination: true,
      hasMissingDestination: false,
    };
  }
  const byName = new Map(observed.services.map((service) => [service.name, service]));
  const servicesAreComplete = observed.completeness?.services === 'complete'
    || (observed.completeness?.services === undefined && observed.partial !== true);
  let missing = false;
  let unknown = false;
  const hashes: string[] = [];

  for (const serviceName of serviceNames) {
    const service = byName.get(serviceName);
    if (!service) {
      if (servicesAreComplete) missing = true;
      else unknown = true;
      continue;
    }
    const hash = service.envVarHashes[key];
    if (hash !== undefined) {
      hashes.push(hash);
    } else if (service.envVarKeys.includes(key)) {
      // Some providers expose secret names but deliberately mask their values.
      unknown = true;
    } else if (servicesAreComplete) {
      missing = true;
    } else {
      unknown = true;
    }
  }

  const distinct = [...new Set(hashes)].sort();
  if (unknown && !missing && distinct.length === 0) {
    return {
      state: 'unknown',
      hashes: [],
      hasUnknownDestination: true,
      hasMissingDestination: false,
    };
  }
  if (!unknown && distinct.length === 0) {
    return {
      state: 'missing',
      hashes: [],
      hasUnknownDestination: false,
      hasMissingDestination: true,
    };
  }
  if (!unknown && !missing && distinct.length === 1) {
    return {
      state: 'consistent',
      hash: distinct[0],
      hashes: distinct,
      hasUnknownDestination: false,
      hasMissingDestination: false,
    };
  }
  return {
    state: 'inconsistent',
    hashes: distinct,
    hasUnknownDestination: unknown,
    hasMissingDestination: missing,
  };
}

function generatedBindingMatchesSlot(
  binding: DelegatedSecretBinding | undefined,
  slot: HypervibeSecretSpec
): boolean {
  return binding?.source === 'hypervibe-generated'
    && binding.principal === 'hypervibe'
    && binding.generator === slot.generator
    && binding.generation === slot.generation;
}

function generatedSecretAction(params: {
  key: string;
  slot: HypervibeSecretSpec;
  hostingProvider: string;
  serviceNames: string[];
  type: PlanAction['type'];
  verified: boolean;
  reason: string;
  expectedValueHash: string;
  requiresConfirm?: boolean;
  bindingOnly?: boolean;
  blockedReason?: string;
}): PlanAction {
  return {
    id: delegatedSecretActionId(params.key),
    type: params.type,
    resource: { kind: 'secret', name: params.key, provider: params.hostingProvider },
    verified: params.verified,
    reason: params.reason,
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    metadata: {
      operation: DELEGATED_SECRET_OPERATION,
      ownership: 'hypervibe',
      principal: 'hypervibe',
      generator: params.slot.generator,
      generation: params.slot.generation,
      expectedValueHash: params.expectedValueHash,
      inputProvided: false,
      valuePrepared: true,
      services: params.serviceNames,
      ...(params.bindingOnly ? { bindingOnly: true } : {}),
      ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    },
  };
}

export function planDelegatedSecrets(params: {
  spec: ProjectSpec;
  environmentName: string;
  hostingProvider: string;
  environment: Pick<Environment, 'platformBindings'> | null;
  observed: ObservedState | null;
  suppliedValues?: Record<string, string>;
  generatedValues?: Record<string, string>;
}): {
  actions: PlanAction[];
  desiredEnvVars: Record<string, string>;
  inputRequired: DelegatedSecretInputRequirement[];
  warnings: string[];
  blockers: ManagedSecretBlocker[];
} {
  const slots = managedSecretsForEnvironment(params.spec, params.environmentName);
  const serviceNames = Object.keys(params.spec.environments[params.environmentName]?.services ?? {}).sort();
  const bindings = new Map(parseDelegatedSecretBindings(params.environment).map((binding) => [binding.name, binding]));
  const suppliedValues = params.suppliedValues ?? {};
  const actions: PlanAction[] = [];
  const desiredEnvVars: Record<string, string> = {};
  const inputRequired: DelegatedSecretInputRequirement[] = [];
  const warnings: string[] = [];
  const blockers: ManagedSecretBlocker[] = [];

  for (const [key, slot] of slots) {
    const binding = bindings.get(key);
    const suppliedValue = suppliedValues[key];
    const live = liveHashesForSecret(params.observed, serviceNames, key);
    const actionId = delegatedSecretActionId(key);

    if (slot.ownership === 'hypervibe') {
      const generatedValue = params.generatedValues?.[key];
      if (generatedValue === undefined) {
        const reason = `Hypervibe could not prepare its managed value for ${key}`;
        blockers.push({ key, reason });
        actions.push(generatedSecretAction({
          key,
          slot,
          hostingProvider: params.hostingProvider,
          serviceNames,
          type: 'update',
          verified: false,
          reason,
          expectedValueHash: 'unavailable',
          blockedReason: 'hypervibe_secret_value_unavailable',
        }));
        warnings.push(`${reason}. No live value was changed.`);
        continue;
      }

      const expectedValueHash = hashEnvValue(generatedValue);
      const bindingIdentityMatches = generatedBindingMatchesSlot(binding, slot);
      const bindingMatches = bindingIdentityMatches && binding?.valueHash === expectedValueHash;
      if (bindingIdentityMatches && !bindingMatches) {
        const reason = `Hypervibe cannot reproduce its accepted ${key} value with the current local encryption key`;
        blockers.push({ key, reason });
        actions.push(generatedSecretAction({
          key,
          slot,
          hostingProvider: params.hostingProvider,
          serviceNames,
          type: 'update',
          verified: !live.hasUnknownDestination,
          reason,
          expectedValueHash,
          blockedReason: 'hypervibe_secret_key_mismatch',
        }));
        warnings.push(`${reason}. Restore the original Hypervibe secret key; do not replace the live value implicitly.`);
        continue;
      }

      if (live.hasUnknownDestination) {
        const everyKnownDestinationMatches = live.hashes.every((hash) => hash === expectedValueHash);
        if (bindingMatches && !live.hasMissingDestination && everyKnownDestinationMatches) {
          actions.push(generatedSecretAction({
            key,
            slot,
            hostingProvider: params.hostingProvider,
            serviceNames,
            type: 'noop',
            verified: false,
            reason: `Preserve Hypervibe-managed ${key}; its live value could not be observed`,
            expectedValueHash,
          }));
          warnings.push(`Could not verify Hypervibe-managed ${key}; Hypervibe preserved it.`);
        } else {
          const reason = `Hypervibe cannot safely initialize or rotate ${key} because one or more live destinations could not be observed or verified against its accepted value`;
          blockers.push({ key, reason });
          actions.push(generatedSecretAction({
            key,
            slot,
            hostingProvider: params.hostingProvider,
            serviceNames,
            type: 'update',
            verified: false,
            reason,
            expectedValueHash,
            blockedReason: 'hypervibe_secret_observation_unknown',
          }));
          warnings.push(`${reason}. No live value was changed.`);
        }
        continue;
      }

      const liveMatches = live.state === 'consistent' && live.hash === expectedValueHash;
      if (liveMatches && bindingMatches) {
        actions.push(generatedSecretAction({
          key,
          slot,
          hostingProvider: params.hostingProvider,
          serviceNames,
          type: 'noop',
          verified: true,
          reason: `Hypervibe-managed ${key} matches generation ${slot.generation}`,
          expectedValueHash,
        }));
        continue;
      }

      if (liveMatches) {
        actions.push(generatedSecretAction({
          key,
          slot,
          hostingProvider: params.hostingProvider,
          serviceNames,
          type: 'update',
          verified: true,
          reason: `Record the existing Hypervibe-managed ${key} generation without changing its live value`,
          expectedValueHash,
          bindingOnly: true,
        }));
        continue;
      }

      const partialGeneratedValue = live.state === 'inconsistent'
        && !live.hasUnknownDestination
        && live.hashes.length > 0
        && live.hashes.every((hash) => hash === expectedValueHash);
      const changingAcceptedGeneration = Boolean(binding && !bindingMatches);
      const conflictingLiveValue = live.state === 'consistent'
        || (live.state === 'inconsistent' && !partialGeneratedValue);

      const requiresConfirm = changingAcceptedGeneration || conflictingLiveValue;
      desiredEnvVars[key] = generatedValue;
      actions.push(generatedSecretAction({
        key,
        slot,
        hostingProvider: params.hostingProvider,
        serviceNames,
        type: 'update',
        verified: !live.hasUnknownDestination,
        reason: requiresConfirm
          ? `Rotate ${key} to Hypervibe-managed generation ${slot.generation}`
          : `Generate and sync Hypervibe-managed ${key}`,
        expectedValueHash,
        requiresConfirm,
      }));
      if (requiresConfirm) {
        warnings.push(`Replacing ${key} is confirmation-gated because it can invalidate active sessions or encrypted application state.`);
      }
      continue;
    }

    if (suppliedValue !== undefined) {
      const suppliedHash = hashEnvValue(suppliedValue);
      desiredEnvVars[key] = suppliedValue;
      const liveMatches = live.state === 'consistent' && live.hash === suppliedHash;
      const bindingMatches = binding?.source === 'delegated-plan-input'
        && binding.valueHash === suppliedHash
        && binding.principal === slot.principal;
      const inSync = liveMatches && bindingMatches;
      actions.push({
        id: actionId,
        type: inSync ? 'noop' : 'update',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: params.observed !== null,
        reason: inSync
          ? `Delegated secret ${key} is accepted for ${slot.principal} and matches every service`
          : `Converge delegated secret ${key} from an explicit plan input owned by ${slot.principal}`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: true,
          driftPolicy: slot.driftPolicy,
          services: serviceNames,
        },
      });
      continue;
    }

    if (
      binding
      && binding.source === 'delegated-plan-input'
      && binding.principal === slot.principal
      && live.state === 'consistent'
      && live.hash === binding.valueHash
    ) {
      actions.push({
        id: actionId,
        type: 'noop',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: true,
        reason: `Delegated secret ${key} matches the accepted value owned by ${slot.principal}`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: false,
          driftPolicy: slot.driftPolicy,
          services: serviceNames,
        },
      });
      continue;
    }

    if (binding?.source === 'delegated-plan-input' && binding.principal === slot.principal && live.state === 'unknown') {
      actions.push({
        id: actionId,
        type: 'noop',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: false,
        reason: `Preserving accepted delegated secret ${key}; live value could not be observed`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: false,
          driftPolicy: slot.driftPolicy,
          services: serviceNames,
        },
      });
      warnings.push(`Could not verify delegated secret ${key} for ${slot.principal}; Hypervibe preserved it and did not use local env input.`);
      continue;
    }

    if (!slot.required && !binding && live.state === 'missing') {
      actions.push({
        id: actionId,
        type: 'noop',
        resource: { kind: 'secret', name: key, provider: params.hostingProvider },
        verified: true,
        reason: `Optional delegated secret ${key} has not been supplied`,
        metadata: {
          operation: DELEGATED_SECRET_OPERATION,
          principal: slot.principal,
          inputProvided: false,
          driftPolicy: slot.driftPolicy,
          services: serviceNames,
        },
      });
      continue;
    }

    const reason = binding
      ? binding.principal !== slot.principal
        ? `Delegated secret ${key} was accepted for ${binding.principal} and must be re-accepted for ${slot.principal}`
        : live.state === 'missing'
        ? `Accepted delegated secret ${key} is missing from one or more services`
        : `Live delegated secret ${key} differs from the accepted value`
      : live.state === 'consistent' || live.state === 'inconsistent'
        ? `Live delegated secret ${key} has not been accepted for ${slot.principal}`
        : `Delegated secret ${key} has not been supplied by ${slot.principal}`;
    inputRequired.push({ key, principal: slot.principal, reason });
    warnings.push(`${reason}. Hypervibe preserved the live value and requires an explicit secretRefs["${key}"] input before apply.`);
    actions.push({
      id: actionId,
      type: 'update',
      resource: { kind: 'secret', name: key, provider: params.hostingProvider },
      verified: params.observed !== null,
      reason,
      metadata: {
        operation: DELEGATED_SECRET_OPERATION,
        principal: slot.principal,
        inputProvided: false,
        inputRequired: true,
        driftPolicy: slot.driftPolicy,
        services: serviceNames,
      },
    });
  }

  return { actions, desiredEnvVars, inputRequired, warnings, blockers };
}

export function isDelegatedSecretAction(action: PlanAction): boolean {
  return action.resource.kind === 'secret' && action.metadata?.operation === DELEGATED_SECRET_OPERATION;
}

export function recordDelegatedSecretBindings(params: {
  environment: Environment;
  spec: ProjectSpec;
  environmentName: string;
  suppliedValues: Record<string, string>;
  applyRunId: string;
  receipts: ActionReceipt[];
  now?: string;
}): Environment {
  const succeeded = new Set(
    params.receipts
      .filter((receipt) => receipt.status === 'succeeded')
      .map((receipt) => receipt.actionId)
  );
  const slots = new Map(managedSecretsForEnvironment(params.spec, params.environmentName));
  const existing = parseDelegatedSecretBindings(params.environment);
  const byName = new Map(existing.map((binding) => [binding.name, binding]));
  const syncedAt = params.now ?? new Date().toISOString();

  for (const [key, value] of Object.entries(params.suppliedValues)) {
    const actionId = delegatedSecretActionId(key);
    const slot = slots.get(key);
    if (!slot || !succeeded.has(actionId)) continue;
    byName.set(key, slot.ownership === 'delegated' ? {
      name: key,
      principal: slot.principal,
      valueHash: hashEnvValue(value),
      source: 'delegated-plan-input',
      syncedAt,
      applyRunId: params.applyRunId,
      actionId,
    } : {
      name: key,
      principal: 'hypervibe',
      valueHash: hashEnvValue(value),
      source: 'hypervibe-generated',
      generator: slot.generator,
      generation: slot.generation,
      syncedAt,
      applyRunId: params.applyRunId,
      actionId,
    });
  }

  const delegatedEnvBindings = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(delegatedEnvBindings) === JSON.stringify(existing)) {
    return params.environment;
  }
  return new EnvironmentRepository().updatePlatformBindings(params.environment.id, {
    delegatedEnvBindings,
  }) ?? params.environment;
}

export function recordDelegatedSecretBinding(params: {
  environment: Environment;
  spec: ProjectSpec;
  environmentName: string;
  key: string;
  value: string;
  applyRunId: string;
  actionId: string;
  now?: string;
}): Environment {
  const updated = recordDelegatedSecretBindings({
    environment: params.environment,
    spec: params.spec,
    environmentName: params.environmentName,
    suppliedValues: { [params.key]: params.value },
    applyRunId: params.applyRunId,
    receipts: [{ actionId: params.actionId, status: 'succeeded' }],
    ...(params.now ? { now: params.now } : {}),
  });
  const binding = parseDelegatedSecretBindings(updated)
    .find((candidate) => candidate.name === params.key && candidate.actionId === params.actionId);
  if (!binding || binding.applyRunId !== params.applyRunId) {
    throw new Error(`Failed to persist accepted metadata for managed secret ${params.key}.`);
  }
  return updated;
}
