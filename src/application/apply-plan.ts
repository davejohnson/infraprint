import { PlanService } from '../domain/plan/plan.service.js';
import {
  ConvergeExecutor,
  fingerprintObservedState,
  type ActionExecutionContext,
  type ActionResult,
  type ConvergeResult,
} from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ProjectSpec, EnvironmentSpec } from '../domain/spec/spec.schema.js';
import {
  applyEnvFileVarsToBootstrapParams,
  applyOverridesToBootstrapParams,
  scopeBootstrapParamsToService,
  specToBootstrapParams,
} from '../domain/spec/spec-bootstrap.js';
import { executeBootstrap } from '../domain/services/bootstrap.service.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import {
  applyCloudflareDomainRegistration,
  isCloudflareDomainRegistrationAction,
} from '../domain/services/domain-registration.service.js';
import { applyIosAction } from '../domain/services/appstore-plan.service.js';
import { applyQueueAction } from '../domain/services/queue-plan.service.js';
import { resolveQueueEnvVars } from '../domain/services/queue-env.js';
import { applyStorageAction, resolveStorageServiceEnvVars } from '../domain/services/storage-plan.service.js';
import {
  liveHashesForSecret,
  parseDelegatedSecretBindings,
  recordDelegatedSecretBinding,
  type DelegatedSecretInputRequirement,
} from '../domain/services/delegated-secret.service.js';
import { recordRuntimeRolloutRequirements } from '../domain/services/runtime-rollout.service.js';
import {
  applyGitHubActionsAppliedSpecHash,
  applyGitHubActionsDeploy,
  applyGitHubActionsRelease,
  isGitHubActionsDeployAction,
} from '../domain/services/ci-deploy.service.js';
import { applyManagedCiAction } from '../domain/services/managed-ci.service.js';
import { applyManagedCodeRepositoryAction } from '../domain/services/managed-code-repository.service.js';
import {
  CI_APPLIED_SPEC_SYNC_OPERATION,
  CI_BINDING_REMOVE_OPERATION,
  CI_CONFIGURATION_SYNC_OPERATION,
  CI_VARIABLE_DELETE_OPERATION,
  CI_VARIABLE_SYNC_OPERATION,
} from '../domain/services/managed-ci.contract.js';
import {
  applyGitHubCollaboration,
  resolveCollaborationRepository,
} from '../domain/services/repo-collaboration.service.js';
import {
  applyGitHubInfrastructure,
  applyGitHubDelegatedSecret,
  applyGitHubNativeSetting,
  applyGitHubOpenAISecret,
  resolveGitHubInfrastructureRepository,
  shouldPlanGitHubInfrastructure,
} from '../domain/services/github-infrastructure.service.js';
import {
  applyGitHubPages,
  applyGitHubPagesBindingCleanup,
  applyGitHubPagesDns,
} from '../domain/services/github-pages.service.js';
import { setupCustomDomain, teardownCustomDomain } from '../domain/services/domain.service.js';
import {
  DOMAIN_ADOPT_OPERATION,
  DOMAIN_DETACH_OPERATION,
} from '../domain/services/domain-attach-policy.js';
import {
  credentialFieldsFromSchema,
  connectionSetupDetails,
  GITHUB_TOKEN_URLS,
} from '../domain/services/connection-guidance.js';
import { removeServiceBinding, serviceBindingFor } from '../domain/services/spec.service.js';
import { removeHostingEnvVars, syncHostingEnvVars } from '../domain/services/hosting-env.service.js';
import {
  applyStripeCatalogAction,
  applyStripeHostingEnvSync,
  applyStripeWebhookAction,
  resolveStripeIntegrationState,
  stripeIntegrationFingerprint,
} from '../domain/services/stripe-env.service.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';
import { hashEnvValue } from '../domain/ports/observe.port.js';
import type { IProviderAdapter } from '../domain/ports/provider.port.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { runEnvironmentTask } from '../domain/services/environment-task.service.js';
import {
  buildDatabaseAliasEnvVars,
  buildDatabaseEnvVarsFromComponent,
} from '../domain/services/database-env.js';
import { buildCacheEnvVarsFromComponent } from '../domain/services/cache-env.js';
import {
  parseUnresolvedCacheNetworkMutation,
  type CacheEngine,
} from '../domain/ports/cache.port.js';
import {
  parseUnresolvedDatabaseMutation,
  parseUnresolvedDatastoreMutation,
  type DatabaseType,
} from '../domain/ports/database.port.js';
import { applyEmailAction } from '../domain/services/email-apply.service.js';
import {
  emailIntegrationFingerprint,
  resolveEmailIntegrationState,
} from '../domain/services/email-plan.service.js';
import {
  applyTwilioMessagingAction,
  resolveTwilioMessagingState,
  twilioMessagingFingerprint,
} from '../domain/services/twilio-messaging.service.js';
import {
  applyProviderNativeDeploySourceAction,
} from '../domain/services/provider-native-deploy-source.service.js';
import { applyLoadBalancerAction } from '../domain/services/load-balancer-plan.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { CommandContext } from './context.js';
import {
  hasExactPlanActionConfirmationAuthority,
  resolvePlanActionAuthority,
} from '../domain/plan/action-authority.js';
import { applyDatabaseResilienceAction } from './apply-database-resilience.js';
import { applyDataMigrationAction } from './apply-data-migration.js';
import { applyMaintenanceAction } from './apply-maintenance.js';
import { bindingIdentityFingerprint } from '../domain/services/binding-identity.js';
import { firstProviderSpecValidationFailure } from '../domain/services/provider-spec-validation.js';

/**
 * The shared plan-apply pipeline: connection gating, TOCTOU re-observe,
 * the per-action handler chain, and the memoized one-pass bootstrap
 * converge. hv_apply, hv_deploy, and hv_rollback all execute plans
 * through here so converge semantics and audit shape stay identical.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Preserve the exact identity returned after an uncertain provider mutation.
 * A failed provision normally needs both a concrete provider id and complete
 * durable scope. The sole exception is a strictly shaped unresolved-create
 * marker: it is retained without an external id only to block another create,
 * and can never authorize deletion.
 */
function retainFailedProvisionIdentity(params: {
  ctx: CommandContext;
  environment: Environment;
  provider: string;
  capability: 'database' | 'cache';
  component: Component;
  existing: Component | null;
}): boolean {
  const { ctx, environment, provider, capability, component, existing } = params;
  const externalId = typeof component.externalId === 'string'
    && component.externalId.trim().length > 0
    ? component.externalId
    : undefined;
  const newBindings = asRecord(component.bindings);
  const providerScope = asRecord(newBindings?.providerScope);
  const unresolvedCreate = !externalId
    ? parseUnresolvedDatastoreMutation(newBindings, capability)
    : null;
  const unresolvedNetworkCreate = capability === 'cache' && !externalId
    ? parseUnresolvedCacheNetworkMutation(newBindings)
    : null;
  if (unresolvedCreate && unresolvedNetworkCreate) {
    return false;
  }
  const unresolvedMutation = unresolvedCreate ?? unresolvedNetworkCreate;
  const requiredScopeKeys = providerRegistry.get(provider)
    ?.inspection?.selectors[capability]?.scopeKeys ?? [];
  const completeProviderScope = requiredScopeKeys.length > 0
    && providerScope
    && Object.entries(providerScope).every(([key, value]) => (
      key.trim().length > 0
      && typeof value === 'string'
      && value.trim().length > 0
    ))
    && requiredScopeKeys.every((key) => Boolean(stringField(providerScope, key)));
  const unresolvedScopeMatches = unresolvedMutation !== null
    && providerScope !== null
    && sortedRecordJson(providerScope) === sortedRecordJson(unresolvedMutation.providerScope);
  if (
    (!externalId && !unresolvedScopeMatches)
    || component.environmentId !== environment.id
    || stringField(newBindings, 'provider') !== provider
    || (externalId ? !completeProviderScope : !unresolvedScopeMatches)
  ) {
    return false;
  }

  const existingBindings = asRecord(existing?.bindings);
  const existingProvider = stringField(existingBindings, 'provider');
  const existingExternalId = existing?.externalId
    ?? stringField(existingBindings, 'instanceId')
    ?? stringField(existingBindings, 'serviceId');
  const existingProviderScope = asRecord(existingBindings?.providerScope);
  const isUncertainInPlaceCacheReconcile = capability === 'cache'
    && existingProvider === provider
    && Boolean(externalId)
    && existingExternalId === externalId
    && existingProviderScope !== null
    && providerScope !== null
    && sortedRecordJson(existingProviderScope) === sortedRecordJson(providerScope);
  const existingUnresolvedMutation = capability === 'cache' && !existingExternalId
    ? parseUnresolvedDatastoreMutation(existingBindings, 'cache')
      ?? parseUnresolvedCacheNetworkMutation(existingBindings)
    : null;
  const isUnresolvedInPlaceCacheRecovery = capability === 'cache'
    && existingProvider === provider
    && !existingExternalId
    && !externalId
    && existingUnresolvedMutation !== null
    && unresolvedMutation !== null
    && JSON.stringify(existingUnresolvedMutation) === JSON.stringify(unresolvedMutation)
    && existingProviderScope !== null
    && providerScope !== null
    && sortedRecordJson(existingProviderScope) === sortedRecordJson(providerScope);
  // A cache update is authorized only for the exact durable identity already
  // bound when the plan was created. Never let an adapter's failed response
  // retarget local state (and a future deletion) to another same-provider
  // cache or scope.
  if (capability === 'cache'
    && existingProvider === provider
    && !isUncertainInPlaceCacheReconcile
    && !isUnresolvedInPlaceCacheRecovery) {
    return false;
  }
  if (unresolvedMutation && existingProvider === provider && Boolean(existingExternalId)) {
    return false;
  }
  const bindingsToStore: Record<string, unknown> = existing && existingProvider && existingProvider !== provider
    ? {
        ...newBindings,
        providerScope: { ...providerScope },
        previousProvider: existingProvider,
        previousExternalId: existing.externalId ?? undefined,
        previousBindings: existing.bindings,
      }
    : {
        ...(existing?.bindings ?? {}),
        ...newBindings,
        providerScope: { ...providerScope },
      };
  delete bindingsToStore.provisioningIncomplete;
  delete bindingsToStore.reconciliationIncomplete;
  bindingsToStore[
    isUncertainInPlaceCacheReconcile
      ? 'reconciliationIncomplete'
      : 'provisioningIncomplete'
  ] = true;

  if (existing) {
    ctx.repos.components.update(existing.id, {
      bindings: bindingsToStore,
      externalId: externalId ?? null,
    });
  } else {
    ctx.repos.components.create({
      environmentId: environment.id,
      type: component.type,
      bindings: bindingsToStore,
      externalId: externalId ?? null,
    });
  }
  return true;
}

function blockedActionIdentity(
  action: PlanAction,
  expected: string
): ActionResult {
  return {
    success: false,
    status: 'blocked',
    message: `Action ${action.id} does not match its current mutation target`,
    error: `${expected} Re-run hv_plan to review one current action with an exact resource identity.`,
  };
}

export type ConnectionBlock = {
  provider: string;
  reason?: string;
  scope?: string;
  policy?: 'hard' | 'action-scoped-if-independent-actions';
  actionIds?: string[];
  /** Exact provider credential roles required by this block. */
  requiredCredentialKeys?: string[];
};

function uniqueConnectionBlocks(blocks: ConnectionBlock[]): ConnectionBlock[] {
  const seen = new Set<string>();
  const output: ConnectionBlock[] = [];
  for (const block of blocks) {
    const key = `${block.provider}:${block.scope ?? ''}:${block.reason ?? ''}:${[...(block.requiredCredentialKeys ?? [])].sort().join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(block);
  }
  return output;
}

export function connectionProviders(blocks: ConnectionBlock[]): string[] {
  return Array.from(new Set(blocks.map((block) => block.provider))).sort();
}

export interface ConnectionLocalEnvInput {
  envKey: string;
  credentialKeys: string[];
  comment: string;
}

function requiredCredentialKeys(block: ConnectionBlock): string[] {
  if (block.requiredCredentialKeys) return block.requiredCredentialKeys;
  const metadata = providerRegistry.getMetadata(block.provider);
  return metadata
    ? credentialFieldsFromSchema(metadata.credentialsSchema)
      ?.filter((field) => field.required)
      .map((field) => field.name) ?? []
    : [];
}

/** Select only dotenv inputs relevant to the exact missing credential roles. */
export function connectionLocalEnvInputs(
  blocks: ConnectionBlock[]
): ConnectionLocalEnvInput[] {
  const byKey = new Map<string, ConnectionLocalEnvInput>();
  for (const block of uniqueConnectionBlocks(blocks)) {
    const required = new Set(requiredCredentialKeys(block));
    if (required.size === 0) continue;
    for (const provider of providerRegistry.connectionProviders(block.provider)) {
      for (const input of providerRegistry.getMetadata(provider)?.credentials?.localEnvInputs ?? []) {
        if (!input.credentialKeys.some((key) => required.has(key))) continue;
        if (!byKey.has(input.envKey)) {
          byKey.set(input.envKey, {
            envKey: input.envKey,
            credentialKeys: [...input.credentialKeys],
            comment: input.comment,
          });
        }
      }
    }
  }
  return [...byKey.values()].sort((left, right) => left.envKey.localeCompare(right.envKey));
}

function providerConnectionSetup(
  block: ConnectionBlock,
  options: { project?: string; gitRemoteUrl?: string } = {}
) {
  const scope = block.scope
    ?? (block.provider === 'github' ? parseGitHubRepoFromRemote(options.gitRemoteUrl) ?? undefined : undefined);
  const details = connectionSetupDetails(block.provider, {
    scope,
    project: options.project,
    requiredCredentialKeys: requiredCredentialKeys(block),
  });
  const localEnvInputs = connectionLocalEnvInputs([block]);
  return {
    ...details,
    ...(localEnvInputs.length > 0 ? { localEnvInputs } : {}),
  };
}

export function connectionRecoveryHint(
  blocks: ConnectionBlock[],
  options: { after?: string; includePackageRead?: boolean; project?: string; gitRemoteUrl?: string } = {}
): string {
  const uniqueBlocks = uniqueConnectionBlocks(blocks);
  const providers = connectionProviders(uniqueBlocks).join(', ');
  const setup = uniqueBlocks.map((block) => providerConnectionSetup(block, options));
  const setupPages = setup
    .filter((entry) => entry.recommendedSetupUrl)
    .map((entry) => `${entry.provider}: ${entry.recommendedSetupUrl}`)
    .join('; ');
  const commands = setup.map((entry) => entry.credentialExample).join('; ');
  const packageReadNeeded = options.includePackageRead
    || uniqueBlocks.some((block) => requiredCredentialKeys(block).includes('packageReadToken'));
  const packageReadHint = packageReadNeeded
    ? ' For GitHub Actions image deploys, the recommended combined classic PAT link preselects repo, workflow, and read:packages. A read:packages-only token cannot manage repository workflows.'
    : '';
  const after = options.after ? ` ${options.after}` : '';
  return `This task needs provider access that is not connected on this Mac (${providers}).${setupPages ? ` Recommended credential page(s): ${setupPages}.` : ''} Save the credential outside chat in an exported environment variable, a gitignored dotenv file, or a local JSON file, then use the exact connection command shown in connectionSetup: ${commands}.${packageReadHint} Replace /absolute/path with the real local path. Do not call this an abstract "Hypervibe credential flow"; show these concrete links and commands. If the credential is not controlled by this user, prepare a value-free handoff naming the provider, scope, and blocked task. Do not bypass Hypervibe with provider CLIs or rerun plan/apply/deploy before the connection verifies.${after}`;
}

export function connectionRecoveryDetails(
  blocks: ConnectionBlock[],
  options: { project?: string; gitRemoteUrl?: string } = {}
): {
  connectionSetup: ReturnType<typeof providerConnectionSetup>[];
} {
  return {
    connectionSetup: uniqueConnectionBlocks(blocks)
      .map((block) => providerConnectionSetup(block, options)),
  };
}


export function syncProjectGitRemoteUrl(ctx: CommandContext, project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  if (!gitRemoteUrl || gitRemoteUrl === project.gitRemoteUrl) {
    return project;
  }
  return ctx.repos.projects.update(project.id, { gitRemoteUrl }) ?? { ...project, gitRemoteUrl };
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function bootstrapGeneralError(summary: Record<string, unknown>): string {
  const messages = [
    stringField(summary, 'error'),
    stringField(summary, 'sendgridApiKeySyncError'),
    stringField(summary, 'sendgridDnsError'),
    stringField(summary, 'customDomainError'),
    stringField(summary, 'domainDnsError'),
  ].filter((message): message is string => Boolean(message));

  return Array.from(new Set(messages)).join('; ') || 'bootstrap failed';
}

function bootstrapDomainError(summary: Record<string, unknown>): string | undefined {
  const messages: string[] = [];
  if (booleanField(summary, 'customDomainAttached') === false || stringField(summary, 'customDomainError')) {
    messages.push(stringField(summary, 'customDomainError') ?? 'Custom domain was not attached by the hosting provider.');
  }
  if (booleanField(summary, 'domainDnsConfigured') === false || stringField(summary, 'domainDnsError')) {
    messages.push(stringField(summary, 'domainDnsError') ?? 'Domain DNS was not configured.');
  }
  return messages.length > 0 ? Array.from(new Set(messages)).join('; ') : undefined;
}

function bootstrapSuccessData(summary: Record<string, unknown>): Record<string, unknown> | undefined {
  if (booleanField(summary, 'appDeploymentPending') !== true) {
    return undefined;
  }
  const data: Record<string, unknown> = {
    appDeploymentPending: true,
    ...(booleanField(summary, 'deploymentDeferralRequested') === true
      ? { deploymentDeferred: true }
      : {}),
    ...(booleanField(summary, 'runtimeRolloutRequired') === true
      ? { runtimeRolloutRequired: true }
      : {}),
  };
  for (const key of ['deploymentMode', 'appDeployment', 'deploySource', 'rolloutBaselines'] as const) {
    if (summary[key] !== undefined) {
      data[key] = summary[key];
    }
  }
  return data;
}

export function splitActionScopedConnectionBlocks(
  blocked: ConnectionBlock[],
  actions: PlanAction[]
): {
  hardBlocked: ConnectionBlock[];
  actionScopedBlocked: ConnectionBlock[];
} {
  const hasIndependentPendingAction = actions.some((action) =>
    action.type !== 'noop'
    && action.resource.kind !== 'domain'
    && !isCloudflareDomainRegistrationAction(action)
  );
  const actionScopedBlocked = blocked.filter((entry) =>
    entry.policy === 'action-scoped-if-independent-actions'
    && (entry.actionIds?.some((id) => actions.some((action) => action.id === id && action.type !== 'noop')) ?? hasIndependentPendingAction)
  );
  const actionScopedProviders = new Set(actionScopedBlocked.map((entry) => entry.provider));
  const ciCredentialBlocks = actions.flatMap((action) => {
    const missing = Array.isArray(action.metadata?.missingProviderSecrets)
      ? action.metadata.missingProviderSecrets.filter((value): value is string => typeof value === 'string')
      : [];
    if (missing.length === 0 || !isGitHubActionsDeployAction(action)) {
      return [];
    }
    const hasImageRegistrySecret = missing.some((name) => name.startsWith('IMAGE_REGISTRY_'));
    return [{
      provider: hasImageRegistrySecret ? 'github' : String(action.metadata?.provider ?? action.resource.provider),
      ...(hasImageRegistrySecret
        ? { requiredCredentialKeys: ['apiToken', 'packageReadToken'] }
        : {}),
      reason: hasImageRegistrySecret
        ? `GitHub Actions deploy ${action.resource.name} is missing GHCR image pull credentials (${missing.join(', ')}). Connect GitHub with apiToken for repo/workflow API access plus packageReadToken for read:packages (create: ${GITHUB_TOKEN_URLS.packageRead}) before relying on push-to-deploy.`
        : `GitHub Actions deploy ${action.resource.name} is missing provider secrets (${missing.join(', ')}). Connect and verify ${String(action.metadata?.provider ?? action.resource.provider)} before relying on push-to-deploy.`,
    }];
  });
  return {
    hardBlocked: blocked.filter((entry) => !actionScopedProviders.has(entry.provider)),
    actionScopedBlocked: [...actionScopedBlocked, ...ciCredentialBlocks],
  };
}

export function actionScopedBlocksRequiringConnectBeforeApply(
  actionScopedBlocked: ConnectionBlock[]
): ConnectionBlock[] {
  return actionScopedBlocked.filter((entry) => entry.policy !== 'action-scoped-if-independent-actions');
}

export function actionScopedBlocksAllowedDuringApply(
  actionScopedBlocked: ConnectionBlock[]
): ConnectionBlock[] {
  return actionScopedBlocked.filter((entry) => entry.policy === 'action-scoped-if-independent-actions');
}

export function bootstrapActionResultFromSummary(
  action: Pick<PlanAction, 'id' | 'resource'>,
  result: { success: boolean; summary: Record<string, unknown> }
): ActionResult {
  const actionError = action.resource.kind === 'domain'
    ? bootstrapDomainError(result.summary)
    : undefined;

  if (!actionError && result.success) {
    const data = bootstrapSuccessData(result.summary);
    return {
      success: true,
      message: `Converged (${action.id})`,
      ...(data ? { data } : {}),
    };
  }

  const error = actionError ?? bootstrapGeneralError(result.summary);
  return {
    success: false,
    message: `Apply failed while converging ${action.id}`,
    error,
    data: result.summary,
  };
}


export type PlanApplyOutcome =
  | {
    kind: 'invalid_spec';
    message: string;
    hint: string;
    details: Record<string, unknown>;
  }
  | { kind: 'plan_not_found'; error: string }
  | { kind: 'env_missing'; envName: string }
  | { kind: 'input_required'; envName: string; requirements: DelegatedSecretInputRequirement[] }
  | { kind: 'blocked'; applyBlocked: ConnectionBlock[] }
  | {
    kind: 'executed';
    envName: string;
    result: ConvergeResult;
    bootstrapSummary?: Record<string, unknown>;
    actionScopedWarnings: string[];
  };

async function executeRepositoryPlanApply(
  ctx: CommandContext,
  params: {
    project: Project;
    spec: ProjectSpec;
    specRevision: number;
    planId: string;
    confirmActions: string[];
    envName: string;
    actions: PlanAction[];
    delegatedSecretValues?: Record<string, string>;
  }
): Promise<PlanApplyOutcome> {
  const projectForApply = syncProjectGitRemoteUrl(ctx, params.project, params.spec);
  const planService = new PlanService();
  const blocked = planService.projectPreflight(projectForApply, params.spec, params.envName);
  const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(blocked, params.actions);
  const applyBlocked = [
    ...hardBlocked,
    ...actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked),
  ];
  if (applyBlocked.length > 0) return { kind: 'blocked', applyBlocked };

  const expectedRepository = resolveGitHubInfrastructureRepository(projectForApply, params.spec);
  const handler = async (action: PlanAction): Promise<ActionResult> => {
    const authority = resolvePlanActionAuthority(action);
    if (!authority) {
      return {
        success: false,
        status: 'blocked',
        message: `Action ${action.id} has no valid mutation authority`,
        error: 'Re-run hv_plan.',
      };
    }
    if (
      authority.capability === 'code.repository.create'
      || authority.capability === 'code.repository.destroy'
      || authority.capability === 'code.repository.binding.remove'
    ) {
      return applyManagedCodeRepositoryAction({
        project: projectForApply,
        spec: params.spec,
        environmentName: params.envName,
        action,
      });
    }
    if (
      action.resource.name !== expectedRepository
      && authority.capability !== 'github.pages-dns.sync'
      && authority.capability !== 'github.openai-secret.sync'
      && authority.capability !== 'github.delegated-secret.sync'
    ) {
      return blockedActionIdentity(
        action,
        `Reviewed repository is ${action.resource.name}; desired state currently targets ${expectedRepository ?? 'no repository'}.`
      );
    }
    switch (authority.capability) {
      case 'github.infrastructure.sync':
        return applyGitHubInfrastructure({ action });
      case 'github.collaboration.sync':
        return applyGitHubCollaboration({
          project: projectForApply,
          spec: params.spec,
          environmentName: params.envName,
        });
      case 'github.setting.sync':
        return applyGitHubNativeSetting({ action });
      case 'github.pages.sync':
        return applyGitHubPages({
          spec: params.spec,
          action,
          project: projectForApply,
          environmentName: params.envName,
        });
      case 'github.pages-binding.cleanup':
        return applyGitHubPagesBindingCleanup({
          spec: params.spec,
          action,
          project: projectForApply,
          environmentName: params.envName,
        });
      case 'github.pages-dns.sync':
        if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
          return blockedActionIdentity(action, `Reviewed DNS action must belong to ${expectedRepository ?? 'a configured repository'}.`);
        }
        return applyGitHubPagesDns({
          spec: params.spec,
          action,
        });
      case 'github.openai-secret.sync':
        if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
          return blockedActionIdentity(
            action,
            `The reviewed secret destination must be ${expectedRepository ?? 'a configured GitHub repository'}.`
          );
        }
        return applyGitHubOpenAISecret({
          project: projectForApply,
          environmentName: params.envName,
          action,
        });
      case 'github.delegated-secret.sync':
        if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
          return blockedActionIdentity(
            action,
            `The reviewed secret destination must be ${expectedRepository ?? 'a configured GitHub repository'}.`
          );
        }
        return applyGitHubDelegatedSecret({
          project: projectForApply,
          spec: params.spec,
          environmentName: params.envName,
          action,
          value: params.delegatedSecretValues?.[action.resource.name],
        });
      default:
        return {
          success: false,
          status: 'blocked',
          message: `Action ${action.id} is not valid for a repository-only plan`,
          error: 'Re-run hv_plan.',
        };
    }
  };

  const result = await new ConvergeExecutor().execute({
    planRunId: params.planId,
    confirmActions: params.confirmActions,
    currentSpecRevision: params.specRevision,
    handler,
  });
  return {
    kind: 'executed',
    envName: params.envName,
    result,
    actionScopedWarnings: actionScopedBlocksAllowedDuringApply(actionScopedBlocked).map((entry) => entry.reason ?? ''),
  };
}

export async function executePlanApply(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  planId: string;
  confirmActions: string[];
  /** Poll web services' healthCheckPath over HTTP during the bootstrap pass (hv_deploy). */
  verifyHttpHealth?: boolean;
  /**
   * Run the bootstrap converge pass even when every action is a noop —
   * hv_deploy's contract is "deploy current code now", not "converge drift".
   */
  alwaysRunBootstrap?: boolean;
}): Promise<PlanApplyOutcome> {
  const { project, spec, planId } = params;
  const providerValidation = firstProviderSpecValidationFailure(spec);
  if (providerValidation) {
    return {
      kind: 'invalid_spec',
      message: providerValidation.message,
      hint: providerValidation.hint,
      details: providerValidation.details,
    };
  }
  const planService = new PlanService();

  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(planId);
  if ('error' in loaded) {
    return { kind: 'plan_not_found', error: loaded.error };
  }
  const envName = loaded.document.environmentName;
  const planScope = loaded.document.scope ?? 'full';
  const retainedCleanupOnly = planScope === 'retained-cleanup';
  if (loaded.document.inputRequired?.length) {
    return {
      kind: 'input_required',
      envName,
      requirements: loaded.document.inputRequired,
    };
  }
  const envSpec = spec.environments[envName];
  if (!envSpec) {
    const repositoryLifecycleOnly = loaded.document.actions.length > 0
      && loaded.document.actions.every((action) => {
        const capability = resolvePlanActionAuthority(action)?.capability;
        return capability === 'code.repository.create'
          || capability === 'code.repository.destroy'
          || capability === 'code.repository.binding.remove';
      });
    return shouldPlanGitHubInfrastructure(spec, envName) || repositoryLifecycleOnly
      ? executeRepositoryPlanApply(ctx, {
          project,
          spec,
          specRevision: params.specRevision,
          planId,
          confirmActions: params.confirmActions,
          envName,
          actions: loaded.document.actions,
          delegatedSecretValues: loaded.document.overrides?.delegatedSecretVarsEncrypted
            ? getSecretStore().decryptObject<Record<string, string>>(
                loaded.document.overrides.delegatedSecretVarsEncrypted
              )
            : undefined,
        })
      : { kind: 'env_missing', envName };
  }

  const projectForPreflight = spec.gitRemoteUrl
    ? { ...project, gitRemoteUrl: spec.gitRemoteUrl }
    : project;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  const migrationActions = loaded.document.actions.filter((action) =>
    action.type === 'update'
    && (
      action.metadata?.operation === 'dataMigrationDatabaseCopy'
      || action.metadata?.operation === 'dataMigrationStorageCopy'
    )
  );
  const migrationProviders = migrationActions.flatMap((action) => [
    stringField(asRecord(action.metadata), 'sourceProvider'),
    stringField(asRecord(action.metadata), 'targetProvider'),
    action.resource.provider,
  ]).filter((provider): provider is string => Boolean(provider));
  const cleanupProviders = loaded.document.actions
    .filter((action) =>
      action.type === 'destroy'
      && (
        action.metadata?.operation === 'dataMigrationDatabasePreviousDestroy'
        || action.metadata?.operation === 'dataMigrationStoragePreviousDestroy'
        || action.metadata?.operation === 'previousHostingDestroy'
        || action.metadata?.operation === 'retainedDatabaseDestroy'
        || action.metadata?.operation === 'retainedCacheDestroy'
        || action.metadata?.operation === 'retainedResourceDestroy'
      )
    )
    .map((action) => action.resource.provider);
  const blocked = retainedCleanupOnly
    ? planService.providerPreflight([
        envSpec.hosting.provider,
        ...cleanupProviders,
      ])
    : migrationActions.length > 0
    ? planService.providerPreflight(migrationProviders)
    : [
        ...planService.preflight(envSpec, envName, spec),
        ...planService.projectPreflight(projectForPreflight, spec, envName),
        ...planService.providerPreflight(cleanupProviders),
      ];
  const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(blocked, loaded.document.actions);
  const connectBeforeApply = actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked);
  const applyBlocked = [...hardBlocked, ...connectBeforeApply];
  if (applyBlocked.length > 0) {
    return { kind: 'blocked', applyBlocked };
  }
  let freshIntegrationFingerprints: Record<string, string> | undefined;
  const stripeSpec = envSpec.payments?.stripe;
  if (!retainedCleanupOnly && (stripeSpec || loaded.document.integrationFingerprints?.stripe)) {
    const stripeResolution = await resolveStripeIntegrationState({
      environmentName: envName,
      spec: stripeSpec,
      environment,
      verifiedConnection: true,
    });
    if (!stripeResolution.success) {
      return {
        kind: 'blocked',
        applyBlocked: [{
          provider: 'stripe',
          scope: stripeResolution.stripeEnvironment,
          reason: stripeResolution.error,
          policy: 'hard',
        }],
      };
    }
    freshIntegrationFingerprints = {
      stripe: stripeIntegrationFingerprint(stripeResolution),
    };
  }
  if (!retainedCleanupOnly && (envSpec.email.enabled || loaded.document.integrationFingerprints?.email)) {
    const emailState = await resolveEmailIntegrationState({
      project: projectForPreflight,
      environmentSpec: envSpec,
    });
    freshIntegrationFingerprints = {
      ...(freshIntegrationFingerprints ?? {}),
      email: emailIntegrationFingerprint(emailState),
    };
  }
  if (!retainedCleanupOnly && (envSpec.messaging || loaded.document.integrationFingerprints?.messaging)) {
    if (!envSpec.messaging) {
      return {
        kind: 'blocked',
        applyBlocked: [{ provider: 'twilio', reason: 'Twilio messaging desired state changed after planning.', policy: 'hard' }],
      };
    }
    const messagingState = await resolveTwilioMessagingState({
      project: projectForPreflight,
      spec: envSpec.messaging,
    });
    freshIntegrationFingerprints = {
      ...(freshIntegrationFingerprints ?? {}),
      messaging: twilioMessagingFingerprint(messagingState),
    };
  }
  const softActionScopedBlocked = actionScopedBlocksAllowedDuringApply(actionScopedBlocked);
  const actionScopedWarnings = softActionScopedBlocked.map((entry) =>
    `${entry.reason} This blocks only the related action; independent service and CI actions will still be applied.`
  );

  const projectForApply = retainedCleanupOnly
    ? project
    : syncProjectGitRemoteUrl(ctx, project, spec);

  // Re-observe for the TOCTOU fingerprint check.
  const { observed } = await planService.observeEnvironment(
    projectForApply,
    environment,
    envSpec,
    { hostingOnly: retainedCleanupOnly }
  );
  const freshFingerprint = observed ? fingerprintObservedState(observed) : null;

  // The bootstrap path derives the hosting adapter from project.defaultPlatform.
  let applyProject: Project = projectForApply;
  if (!retainedCleanupOnly && projectForApply.defaultPlatform !== envSpec.hosting.provider) {
    applyProject = ctx.repos.projects.update(projectForApply.id, { defaultPlatform: envSpec.hosting.provider }) ?? projectForApply;
  }

  // Each handler below is constrained to the exact authority of one reviewed
  // action. The legacy bootstrap remains an implementation detail for a
  // service deployment, never a whole-environment fallback.
  const overrides = loaded.document.overrides;
  const envFileEnvVars = overrides?.envFileVarsEncrypted
    ? getSecretStore().decryptObject<Record<string, string>>(overrides.envFileVarsEncrypted)
    : undefined;
  const overrideEnvVars = overrides?.envVarsEncrypted
    ? getSecretStore().decryptObject<Record<string, string>>(overrides.envVarsEncrypted)
    : undefined;
  const delegatedSecretEnvVars = overrides?.delegatedSecretVarsEncrypted
    ? getSecretStore().decryptObject<Record<string, string>>(overrides.delegatedSecretVarsEncrypted)
    : undefined;
  const confirmedActionIds = new Set(params.confirmActions);
  const buildDeployBootstrapParams = async () => {
    let bootstrapParams = specToBootstrapParams(applyProject.name, envName, envSpec, spec.runtime);
    bootstrapParams = applyEnvFileVarsToBootstrapParams(bootstrapParams, envFileEnvVars);
    bootstrapParams = applyOverridesToBootstrapParams(bootstrapParams, {
      envVars: overrideEnvVars,
    });
    if (params.verifyHttpHealth) {
      bootstrapParams = { ...bootstrapParams, verifyHttpHealth: true };
    }
    const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
    const queueEnvVars = await resolveQueueEnvVars(applyProject, envSpec, latestEnvironment);
    if (queueEnvVars) {
      bootstrapParams = { ...bootstrapParams, queueEnvVars };
    }
    const storageServiceEnvVars = await resolveStorageServiceEnvVars(applyProject, envSpec, latestEnvironment);
    if (storageServiceEnvVars) {
      bootstrapParams = { ...bootstrapParams, envVarsByService: storageServiceEnvVars };
    }
    const database = latestEnvironment && envSpec.database
      ? ctx.repos.components.findByEnvironmentAndType(latestEnvironment.id, envSpec.database.engine)
      : null;
    if (database) {
      const databaseEnvVars = buildDatabaseEnvVarsFromComponent(database).envVars;
      const databaseAliasEnvVars = Object.fromEntries(
        Object.entries(envSpec.services)
          .map(([serviceName, serviceSpec]) => [
            serviceName,
            buildDatabaseAliasEnvVars(databaseEnvVars, serviceSpec.databaseEnvAliases),
          ])
          .filter(([, aliases]) => Object.keys(aliases as Record<string, string>).length > 0)
      ) as Record<string, Record<string, string>>;
      bootstrapParams = {
        ...bootstrapParams,
        envVars: {
          ...databaseEnvVars,
          ...(bootstrapParams.envVars ?? {}),
        },
        ...(Object.keys(databaseAliasEnvVars).length > 0
          ? {
            envVarsByService: Object.fromEntries(
              Array.from(new Set([
                ...Object.keys(bootstrapParams.envVarsByService ?? {}),
                ...Object.keys(databaseAliasEnvVars),
              ])).map((serviceName) => [
                serviceName,
                {
                  ...(bootstrapParams.envVarsByService?.[serviceName] ?? {}),
                  ...(databaseAliasEnvVars[serviceName] ?? {}),
                },
              ])
            ),
          }
          : {}),
      };
    }
    const cache = latestEnvironment
      ? ctx.repos.components.findByEnvironmentAndType(latestEnvironment.id, 'redis')
      : null;
    if (cache) {
      bootstrapParams = {
        ...bootstrapParams,
        envVars: {
          ...buildCacheEnvVarsFromComponent(cache).envVars,
          ...(bootstrapParams.envVars ?? {}),
        },
      };
    }
    return bootstrapParams;
  };

  let deployBootstrap: { success: boolean; summary: Record<string, unknown> } | null = null;
  const serviceBootstraps = new Map<string, { success: boolean; summary: Record<string, unknown> }>();

  const ensureServiceBootstrap = async (serviceName: string) => {
    const existing = serviceBootstraps.get(serviceName);
    if (existing) return existing;
    const base = await buildDeployBootstrapParams();
    const result = await executeBootstrap(scopeBootstrapParamsToService(base, serviceName));
    serviceBootstraps.set(serviceName, result);
    return result;
  };

  const ensureDeployBootstrap = async () => {
    if (!deployBootstrap) {
      let bootstrapParams = await buildDeployBootstrapParams();
      bootstrapParams = applyOverridesToBootstrapParams(bootstrapParams, {
        services: overrides?.services,
      });
      deployBootstrap = await executeBootstrap({
        ...bootstrapParams,
        domain: undefined,
        ensureHostingProject: false,
      });
    }
    return deployBootstrap;
  };

  const handler = async (
    action: PlanAction,
    executionContext: ActionExecutionContext
  ): Promise<ActionResult> => {
    const blockedReason = stringField(asRecord(action.metadata), 'blockedReason');
    if (blockedReason) {
      return {
        success: false,
        status: 'blocked',
        message: action.reason,
        error: blockedReason,
      };
    }
    const authority = resolvePlanActionAuthority(action);
    if (!authority) {
      return {
        success: false,
        status: 'blocked',
        message: `No mutation authority exists for ${action.id}`,
        error: 'The persisted action kind, provider, type, and operation do not map to one supported mutation capability.',
      };
    }
    const capability = authority.capability;

    if (
      capability === 'code.repository.create'
      || capability === 'code.repository.destroy'
      || capability === 'code.repository.binding.remove'
    ) {
      return applyManagedCodeRepositoryAction({
        project: applyProject,
        spec,
        environmentName: envName,
        action,
      });
    }

    if (capability.startsWith('maintenance.')) {
      return await applyMaintenanceAction({
        ctx,
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      }) ?? {
        success: false,
        status: 'blocked',
        message: `Maintenance action ${action.id} was not recognized`,
        error: 'Re-run hv_plan with the current Hypervibe version.',
      };
    }
    if (capability === 'hosting.environment.ensure') {
      return ensureHostingEnvironment(ctx, applyProject, envName, action);
    }
    if (
      capability === 'load-balancer.monitor.mutate'
      || capability === 'load-balancer.pool.mutate'
      || capability === 'load-balancer.mutate'
    ) {
      return applyLoadBalancerAction({
        project: applyProject,
        envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'domain.registration.mutate') {
      const expectedDomain = envSpec.domain?.trim().replace(/\.$/, '').toLowerCase();
      if (!expectedDomain || action.resource.name !== expectedDomain) {
        return blockedActionIdentity(
          action,
          `Reviewed domain is ${action.resource.name}; the current registration target is ${expectedDomain ?? 'unset'}.`
        );
      }
      return applyCloudflareDomainRegistration({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'github.ci.sync') {
      const expectedRepository = parseGitHubRepoFromRemote(applyProject.gitRemoteUrl);
      if (
        action.resource.name !== `deploy-branch:${envName}`
        || stringField(asRecord(action.metadata), 'repository') !== expectedRepository
        || stringField(asRecord(action.metadata), 'provider') !== envSpec.hosting.provider
      ) {
        return blockedActionIdentity(
          action,
          `The GitHub deploy target must be ${expectedRepository ?? 'an unset repository'}/${envName} for ${envSpec.hosting.provider}.`
        );
      }
      return applyGitHubActionsDeploy({
        project: applyProject,
        spec,
        environmentName: envName,
        environmentSpec: envSpec,
      });
    }
    if (
      capability === 'ci.configuration.sync'
      || capability === 'ci.variable.sync'
      || capability === 'ci.variable.delete'
      || capability === 'ci.binding.remove'
    ) {
      const expectedOperation = capability === 'ci.configuration.sync'
        ? CI_CONFIGURATION_SYNC_OPERATION
        : capability === 'ci.variable.sync'
          ? CI_VARIABLE_SYNC_OPERATION
          : capability === 'ci.variable.delete'
            ? CI_VARIABLE_DELETE_OPERATION
            : CI_BINDING_REMOVE_OPERATION;
      if (
        action.metadata?.operation !== expectedOperation
        || action.metadata?.ciProvider !== action.resource.provider
      ) {
        return blockedActionIdentity(action, 'The reviewed CI provider, operation, or resource identity no longer matches.');
      }
      return applyManagedCiAction({
        project: applyProject,
        spec,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
        appliedSpecHash: false,
      });
    }
    if (capability === 'github.applied-spec-hash.sync') {
      const desiredHash = stringField(asRecord(action.metadata), 'desiredHash');
      const expectedRepository = parseGitHubRepoFromRemote(applyProject.gitRemoteUrl);
      if (
        !desiredHash
        || action.resource.name !== `applied-spec-hash:${envName}`
        || stringField(asRecord(action.metadata), 'repository') !== expectedRepository
        || stringField(asRecord(action.metadata), 'environmentName') !== envName
      ) {
        return {
          success: false,
          status: 'blocked',
          message: 'Applied deployment contract action has stale mutation authority',
          error: 'The reviewed repository, environment, resource name, or desired hash no longer matches. Re-run hv_plan.',
        };
      }
      return applyGitHubActionsAppliedSpecHash({
        project: applyProject,
        environmentName: envName,
        desiredHash,
      });
    }
    if (capability === 'ci.applied-spec-hash.sync') {
      if (
        action.metadata?.operation !== CI_APPLIED_SPEC_SYNC_OPERATION
        || action.metadata?.ciProvider !== action.resource.provider
        || action.metadata?.environmentName !== envName
      ) {
        return blockedActionIdentity(action, 'The reviewed applied-spec CI action no longer matches the environment or provider.');
      }
      return applyManagedCiAction({
        project: applyProject,
        spec,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
        appliedSpecHash: true,
      });
    }
    if (capability === 'github.ci.release') {
      const expectedRepository = parseGitHubRepoFromRemote(applyProject.gitRemoteUrl);
      const repository = stringField(asRecord(action.metadata), 'repository');
      const environmentName = stringField(asRecord(action.metadata), 'environmentName');
      const workflow = stringField(asRecord(action.metadata), 'workflow');
      const ref = stringField(asRecord(action.metadata), 'ref');
      const targetSha = stringField(asRecord(action.metadata), 'targetSha');
      const forceRelease = asRecord(action.metadata)?.forceRelease === true;
      if (
        repository !== expectedRepository
        || environmentName !== envName
        || action.resource.name !== `release:${envName}`
        || !workflow
        || !ref
        || !targetSha
      ) {
        return blockedActionIdentity(action, 'The reviewed repository, environment, workflow, ref, or exact commit no longer matches.');
      }
      return applyGitHubActionsRelease({
        project: applyProject,
        environmentName: envName,
        workflow,
        ref,
        targetSha,
        forceRelease,
      });
    }
    if (capability === 'github.collaboration.sync') {
      const expectedRepository = resolveCollaborationRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; collaboration currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubCollaboration({ project: applyProject, spec, environmentName: envName });
    }
    if (capability === 'github.infrastructure.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub infrastructure currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubInfrastructure({ action });
    }
    if (capability === 'github.pages.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub Pages currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubPages({ spec, action, project: applyProject, environmentName: envName });
    }
    if (capability === 'github.pages-binding.cleanup') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub Pages binding cleanup currently targets ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubPagesBindingCleanup({
        spec,
        action,
        project: applyProject,
        environmentName: envName,
      });
    }
    if (capability === 'github.pages-dns.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed DNS action must belong to ${expectedRepository ?? 'a configured repository'}.`
        );
      }
      return applyGitHubPagesDns({ spec, action });
    }
    if (capability === 'github.openai-secret.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `The reviewed secret destination must be ${expectedRepository ?? 'a configured GitHub repository'}.`
        );
      }
      return applyGitHubOpenAISecret({ project: applyProject, environmentName: envName, action });
    }
    if (capability === 'github.delegated-secret.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (stringField(asRecord(action.metadata), 'repository') !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `The reviewed secret destination must be ${expectedRepository ?? 'a configured GitHub repository'}.`
        );
      }
      return applyGitHubDelegatedSecret({
        project: applyProject,
        spec,
        environmentName: envName,
        action,
        value: delegatedSecretEnvVars?.[action.resource.name],
      });
    }
    if (capability === 'github.setting.sync') {
      const expectedRepository = resolveGitHubInfrastructureRepository(applyProject, spec);
      if (action.resource.name !== expectedRepository) {
        return blockedActionIdentity(
          action,
          `Reviewed repository is ${action.resource.name}; GitHub settings currently target ${expectedRepository ?? 'no repository'}.`
        );
      }
      return applyGitHubNativeSetting({ action });
    }
    if (capability === 'appstore.mutate') {
      return applyIosAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'queue.mutate') {
      return applyQueueAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'storage.mutate') {
      return applyStorageAction({ project: applyProject, envName, environmentSpec: envSpec, action });
    }
    if (capability === 'hosting.delegated-secret.sync') {
      const key = action.resource.name;
      const value = delegatedSecretEnvVars?.[key];
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const metadata = asRecord(action.metadata);
      const destinationServices = stringArrayField(metadata, 'services');
      const expectedServices = Object.keys(envSpec.services).sort();
      const declaredSecret = spec.secrets[key];
      const plannedOwnership = stringField(metadata, 'ownership') ?? 'delegated';
      const destinationsMatch = destinationServices.length === expectedServices.length
        && new Set(destinationServices).size === destinationServices.length
        && [...destinationServices].sort().every((serviceName, index) => serviceName === expectedServices[index]);

      if (value === undefined || !latestEnvironment) {
        return {
          success: false,
          message: `Cannot sync managed application secret ${key}`,
          error: value === undefined
            ? 'The reviewed plan does not contain the encrypted secret value.'
            : `Environment "${envName}" is not tracked locally.`,
        };
      }
      if (
        action.resource.provider !== envSpec.hosting.provider
        || !declaredSecret
        || !declaredSecret.environments.includes(envName)
        || plannedOwnership !== declaredSecret.ownership
        || !destinationsMatch
      ) {
        return blockedActionIdentity(
          action,
          action.resource.provider !== envSpec.hosting.provider
            ? `Plan targets ${action.resource.provider}, but ${envName} uses ${envSpec.hosting.provider}.`
            : !declaredSecret || !declaredSecret.environments.includes(envName)
              ? `${key} is not a managed runtime secret for ${envName}.`
              : plannedOwnership !== declaredSecret.ownership
                ? `${key} ownership changed after planning.`
                : `The reviewed destinations must be exactly: ${expectedServices.join(', ')}.`
        );
      }

      const hypervibeOwned = declaredSecret.ownership === 'hypervibe';
      let bindingOnly = false;
      if (declaredSecret.ownership === 'delegated') {
        if (
          stringField(metadata, 'principal') !== declaredSecret.principal
          || metadata?.bindingOnly === true
        ) {
          return blockedActionIdentity(
            action,
            `The delegated owner for ${key} must remain ${declaredSecret.principal}.`
          );
        }
      } else {
        const generation = metadata?.generation;
        const expectedValueHash = hashEnvValue(value);
        if (
          stringField(metadata, 'principal') !== 'hypervibe'
          || stringField(metadata, 'generator') !== declaredSecret.generator
          || generation !== declaredSecret.generation
          || stringField(metadata, 'expectedValueHash') !== expectedValueHash
        ) {
          return blockedActionIdentity(
            action,
            `The reviewed Hypervibe generator, generation, or value fingerprint for ${key} no longer matches.`
          );
        }

        const binding = parseDelegatedSecretBindings(latestEnvironment)
          .find((candidate) => candidate.name === key);
        const bindingIdentityMatches = binding?.source === 'hypervibe-generated'
          && binding.principal === 'hypervibe'
          && binding.generator === declaredSecret.generator
          && binding.generation === declaredSecret.generation;
        const bindingMatches = bindingIdentityMatches && binding.valueHash === expectedValueHash;
        if (bindingIdentityMatches && !bindingMatches) {
          return blockedActionIdentity(
            action,
            `The accepted ${key} fingerprint cannot be reproduced with the current Hypervibe encryption key.`
          );
        }

        const liveState = liveHashesForSecret(observed, destinationServices, key);
        if (liveState.hasUnknownDestination) {
          return blockedActionIdentity(
            action,
            `The current live value for ${key} is not observable, so this action cannot install or replace it.`
          );
        }

        bindingOnly = liveState.state === 'consistent'
          && liveState.hash === expectedValueHash;
        if ((metadata?.bindingOnly === true) !== bindingOnly) {
          return blockedActionIdentity(
            action,
            bindingOnly
              ? `${key} already matches and authorizes only value-free binding reconciliation.`
              : `${key} does not match the value required for binding-only reconciliation.`
          );
        }

        const changingAcceptedGeneration = Boolean(binding && !bindingMatches);
        const hasConflictingLiveValue = liveState.hashes
          .some((liveHash) => liveHash !== expectedValueHash);
        const replacingLiveValue = !bindingOnly
          && (changingAcceptedGeneration || hasConflictingLiveValue);
        if (!hasExactPlanActionConfirmationAuthority(
          action,
          replacingLiveValue,
          confirmedActionIds
        )) {
          return blockedActionIdentity(
            action,
            `Replacing ${key} requires the persisted confirmation marker and explicit confirmation of action ${action.id}.`
          );
        }
      }

      if (bindingOnly) {
        try {
          recordDelegatedSecretBinding({
            environment: latestEnvironment,
            spec,
            environmentName: envName,
            key,
            value,
            applyRunId: executionContext.applyRunId,
            actionId: action.id,
          });
        } catch (error) {
          return {
            success: false,
            message: `Failed to record managed application secret ${key}`,
            error: error instanceof Error ? error.message : String(error),
            data: {
              requestedCount: destinationServices.length,
              appliedCount: 0,
              failedCount: 0,
              skippedCount: destinationServices.length,
              bindingRecorded: false,
              failureStage: 'binding',
            },
          };
        }
        return {
          success: true,
          message: `Recorded existing Hypervibe-managed application secret ${key} without changing its live value`,
          data: {
            requestedCount: destinationServices.length,
            appliedCount: 0,
            failedCount: 0,
            skippedCount: destinationServices.length,
            bindingRecorded: true,
          },
        };
      }

      const failures: string[] = [];
      let appliedCount = 0;
      let deploymentDeferred = false;
      let runtimeRolloutRequired = false;
      const rolloutBaselines: Record<string, unknown> = {};
      for (const serviceName of destinationServices) {
        const service = ctx.repos.services.findByProjectAndName(project.id, serviceName);
        if (!service) {
          failures.push(`${serviceName}: service is not tracked locally`);
          continue;
        }
        const receipt = await syncHostingEnvVars({
          project: applyProject,
          environment: latestEnvironment,
          service,
          vars: { [action.resource.name]: value },
          deferDeployment: envSpec.deploy?.strategy === 'branch' && envSpec.deploy.trigger !== 'native',
        });
        if (!receipt.success) {
          failures.push(`${serviceName}: ${receipt.error ?? receipt.message}`);
        } else {
          appliedCount += 1;
          const receiptData = asRecord(receipt.data);
          if (receiptData?.deploymentDeferred === true) {
            deploymentDeferred = true;
          }
          if (receiptData?.runtimeRolloutRequired !== true) continue;
          runtimeRolloutRequired = true;
          const rolloutBaseline = receiptData.rolloutBaseline;
          if (rolloutBaseline) {
            rolloutBaselines[serviceName] = rolloutBaseline;
          }
        }
      }
      const counts = {
        requestedCount: destinationServices.length,
        appliedCount,
        failedCount: failures.length,
        skippedCount: 0,
      };
      if (failures.length > 0) {
        return {
          success: false,
          message: `Failed to sync managed application secret ${key}`,
          error: failures.join('; '),
          data: { ...counts, bindingRecorded: false, failureStage: 'provider' },
        };
      }

      try {
        recordDelegatedSecretBinding({
          environment: latestEnvironment,
          spec,
          environmentName: envName,
          key,
          value,
          applyRunId: executionContext.applyRunId,
          actionId: action.id,
        });
      } catch (error) {
        return {
          success: false,
          message: `Synced ${key}, but failed to record its accepted fingerprint`,
          error: error instanceof Error ? error.message : String(error),
          data: { ...counts, bindingRecorded: false, failureStage: 'binding' },
        };
      }

      return {
        success: true,
        message: hypervibeOwned
          ? `Installed Hypervibe-managed application secret ${key} on ${appliedCount} service(s)`
          : `Synced delegated secret ${key} to ${appliedCount} service(s)`,
        data: {
          ...counts,
          bindingRecorded: true,
          ...(deploymentDeferred ? { deploymentDeferred: true } : {}),
          ...(runtimeRolloutRequired ? { runtimeRolloutRequired: true } : {}),
          services: destinationServices,
          ...(Object.keys(rolloutBaselines).length > 0 ? { rolloutBaselines } : {}),
        },
      };
    }
    if (capability === 'stripe.hosting-env.sync') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
      if (!latestEnvironment || !service) {
        return {
          success: false,
          message: `Cannot sync Stripe runtime variables to ${action.resource.name}`,
          error: !latestEnvironment
            ? `Environment "${envName}" is not tracked locally`
            : `Service "${action.resource.name}" is not tracked locally`,
        };
      }
      return applyStripeHostingEnvSync({
        project: applyProject,
        environment: latestEnvironment,
        environmentSpec: envSpec,
        service,
        action,
      });
    }
    if (capability === 'stripe.catalog.mutate') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (!latestEnvironment) {
        return {
          success: false,
          message: `Cannot converge Stripe catalog resource ${action.resource.name}`,
          error: `Environment "${envName}" is not tracked locally`,
        };
      }
      return applyStripeCatalogAction({
        environment: latestEnvironment,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'stripe.webhook.mutate') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (!latestEnvironment) {
        return {
          success: false,
          message: `Cannot converge Stripe webhook ${action.resource.name}`,
          error: `Environment "${envName}" is not tracked locally`,
        };
      }
      return applyStripeWebhookAction({
        project: applyProject,
        environment: latestEnvironment,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'hosting.env.remove') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
      if (
        action.resource.provider !== envSpec.hosting.provider
        || !envSpec.services[action.resource.name]
      ) {
        return blockedActionIdentity(
          action,
          `Environment ${envName} allows env removal only from a declared ${envSpec.hosting.provider} service.`
        );
      }
      if (!latestEnvironment || !service) {
        return {
          success: false,
          message: `Cannot remove environment variables from ${action.resource.name}`,
          error: !latestEnvironment
            ? `Environment "${envName}" is not tracked locally`
            : `Service "${action.resource.name}" is not tracked locally`,
        };
      }
      return removeHostingEnvVars({
        project: applyProject,
        environment: latestEnvironment,
        service,
        keys: stringArrayField(asRecord(action.metadata), 'keys'),
      });
    }
    if (capability === 'hosting.deploy-source.disconnect') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      if (!latestEnvironment) {
        return {
          success: false,
          status: 'blocked',
          message: `Cannot disconnect the provider-native deploy source for ${action.resource.name}`,
          error: `Environment "${envName}" is not tracked locally.`,
        };
      }
      return applyProviderNativeDeploySourceAction({
        project: applyProject,
        environment: latestEnvironment,
        action,
      });
    }
    if (capability === 'cache.provision') {
      return createCache(ctx, applyProject, envName, envSpec, action);
    }
    if (capability === 'cache.env.remove') {
      return unwireCache(ctx, applyProject, envName, envSpec, action);
    }
    if (capability === 'cache.destroy') {
      return destroyCache(ctx, applyProject, envName, action);
    }
    if (capability === 'cache.retained.destroy') {
      return destroyRetainedCache(ctx, applyProject, envName, action);
    }
    if (capability === 'database.provision') {
      return createDatabase(ctx, applyProject, envName, envSpec, action);
    }
    if (
      capability === 'database.migrate'
      || capability === 'storage.migrate'
      || capability === 'database.migration-target.destroy'
      || capability === 'storage.migration-target.destroy'
    ) {
      return applyDataMigrationAction({
        ctx,
        project: applyProject,
        spec,
        targetEnvironmentName: envName,
        action,
      });
    }
    if (
      capability === 'database.availability.configure'
      || capability === 'database.backup-policy.configure'
      || capability === 'database.replica.provision'
      || capability === 'database.replica.destroy'
    ) {
      return applyDatabaseResilienceAction({
        ctx,
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'database.seed') {
      return applyDatabaseSeed(ctx, applyProject, envName, action);
    }
    if (capability === 'database.destroy') {
      return destroyDatabase(ctx, applyProject, envName, action);
    }
    if (capability === 'database.retained.destroy') {
      return destroyRetainedDatabase(ctx, applyProject, envName, action);
    }
    if (capability === 'provider-resource.retained.destroy') {
      return destroyRetainedResource(ctx, applyProject, envName, action);
    }
    if (capability === 'hosting.task-service.destroy') {
      return destroyTaskService(applyProject, action);
    }
    if (capability === 'hosting.previous-service.destroy') {
      return destroyPreviousHostingService(ctx, applyProject, envName, action);
    }
    if (capability === 'hosting.previous-environment.destroy') {
      return destroyPreviousHostingBoundary(ctx, applyProject, envName, action, 'environment');
    }
    if (capability === 'hosting.previous-project.destroy') {
      return destroyPreviousHostingBoundary(ctx, applyProject, envName, action, 'project');
    }
    if (capability === 'hosting.service.destroy') {
      return destroyService(ctx, applyProject, spec, envName, action);
    }
    if (capability === 'domain.configure') {
      return applyDomain(ctx, applyProject, envName, envSpec, action);
    }
    if (
      capability === 'email.runtime.sync'
      || capability === 'email.authorization.mutate'
      || capability === 'email.dns.sync'
      || capability === 'email.inbound.mutate'
      || capability === 'email.delivery-events.mutate'
      || capability === 'email.forwarding.mutate'
    ) {
      return applyEmailAction({
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (
      capability === 'messaging.service.mutate'
      || capability === 'messaging.sender.mutate'
      || capability === 'messaging.runtime.sync'
    ) {
      return applyTwilioMessagingAction({
        project: applyProject,
        environmentName: envName,
        environmentSpec: envSpec,
        action,
      });
    }
    if (capability === 'local.environment.record') {
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      return latestEnvironment
        ? { success: true, message: `Environment "${envName}" is recorded locally` }
        : {
            success: false,
            message: `Environment "${envName}" is not recorded locally`,
            error: 'Re-run hv_plan to create the local environment record.',
          };
    }
    if (capability === 'hosting.project.ensure') {
      return ensureHostingProject(ctx, applyProject, envName, envSpec.hosting.provider, action);
    }
    if (capability === 'hosting.service.converge') {
      if (
        action.resource.provider !== envSpec.hosting.provider
        || !envSpec.services[action.resource.name]
      ) {
        return {
          success: false,
          status: 'blocked',
          message: `Service action ${action.id} does not match the current environment spec`,
          error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected provider ${envSpec.hosting.provider} and a declared service name.`,
        };
      }
      const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const rawRecoveryMap = asRecord(latestEnvironment?.platformBindings)?.serviceCreateRecovery;
      const recoveryMap = asRecord(rawRecoveryMap);
      if (rawRecoveryMap !== undefined && (
        !recoveryMap
        || Object.prototype.hasOwnProperty.call(recoveryMap, action.resource.name)
      )) {
        return {
          success: false,
          status: 'blocked',
          message: `Service ${action.resource.name} has retained create-recovery state`,
          error: 'Resolve or explicitly clean up the retained provider service identity before applying another service create. No hosting mutation was attempted.',
        };
      }
      const result = await ensureServiceBootstrap(action.resource.name);
      return bootstrapActionResultFromSummary(action, result);
    }
    return {
      success: false,
      status: 'blocked',
      message: `No action-scoped handler exists for ${action.id}`,
      error: 'Refusing to route an unrecognized plan action through a broader mutation path.',
    };
  };

  let result = await executor.execute({
    planRunId: planId,
    confirmActions: params.confirmActions,
    currentSpecRevision: params.specRevision,
    freshObservedFingerprint: freshFingerprint,
    freshIntegrationFingerprints,
    handler,
  });

  // An all-noop plan never reaches the bootstrap fallback; hv_deploy still
  // means "deploy current code now", so force the pass when asked.
  const planIsAllNoop = loaded.document.actions.every((action) => action.type === 'noop');
  if (
    params.alwaysRunBootstrap
    && planIsAllNoop
    && !deployBootstrap
    && result.success
    && result.applyRunId
  ) {
    const forced = await ensureDeployBootstrap();
    if (!forced.success) {
      result = {
        ...result,
        success: false,
        error: String(forced.summary.error ?? 'Deploy failed'),
      };
    }
  }

  if (result.applyRunId) {
    const latestEnvironment = ctx.repos.environments.findByProjectAndName(project.id, envName);
    if (latestEnvironment) {
      recordRuntimeRolloutRequirements({
        environment: latestEnvironment,
        provider: envSpec.hosting.provider,
        observed,
        actions: loaded.document.actions,
        receipts: result.receipts,
        applyRunId: result.applyRunId,
      });
    }
  }

  return {
    kind: 'executed',
    envName,
    result,
    ...(deployBootstrap
      ? { bootstrapSummary: (deployBootstrap as { summary: Record<string, unknown> }).summary }
      : {}),
    actionScopedWarnings,
  };
}

function projectSpecReferencesService(spec: ProjectSpec, serviceName: string): boolean {
  return Object.values(spec.environments).some((environmentSpec) => Boolean(environmentSpec.services[serviceName]));
}

function environmentHasBinding(environment: Environment, serviceName: string): boolean {
  return Boolean(serviceBindingFor(environment, serviceName));
}

async function ensureHostingProject(
  ctx: CommandContext,
  project: Project,
  envName: string,
  provider: string,
  action: PlanAction
): Promise<ActionResult> {
  let environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return {
      success: false,
      message: 'Environment not found locally',
      error: `No local environment "${envName}"`,
    };
  }
  if (
    action.resource.provider !== provider
    || action.resource.name !== envName
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Project action ${action.id} does not match the current hosting target`,
      error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected ${provider}/${envName}.`,
    };
  }

  const currentBindings = parseHostingBindings(environment);
  const rawBindings = environment.platformBindings as Record<string, unknown>;
  if (currentBindings.provider && currentBindings.provider !== provider) {
    const retainedPreviousHosting = asRecord(rawBindings.previousHosting);
    if (stringField(retainedPreviousHosting, 'provider')) {
      return {
        success: false,
        status: 'blocked',
        message: 'A prior hosting-provider migration still requires cleanup',
        error: `Cannot switch hosting from ${currentBindings.provider} to ${provider} while cleanup from ${stringField(retainedPreviousHosting, 'provider')} is still retained. Re-run hv_plan after resolving that teardown.`,
      };
    }
    const cleanupBoundary = providerRegistry.getMetadata(currentBindings.provider)
      ?.lifecycle?.hosting?.teardownBoundary;
    if (!cleanupBoundary) {
      return {
        success: false,
        status: 'blocked',
        message: 'The abandoned hosting provider has no safe teardown contract',
        error: `${currentBindings.provider} does not declare whether cleanup owns services, an environment, or a project. Hypervibe will not discard or reinterpret its bindings.`,
      };
    }
    const hasRetainedCleanupIdentity = Object.keys(currentBindings.services ?? {}).length > 0
      || (cleanupBoundary === 'environment' && Boolean(currentBindings.projectId && currentBindings.environmentId))
      || (cleanupBoundary === 'project' && Boolean(currentBindings.projectId));
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      ...(!rawBindings.previousHosting && hasRetainedCleanupIdentity
        ? {
            previousHosting: {
              provider: currentBindings.provider,
              ...(currentBindings.projectId ? { projectId: currentBindings.projectId } : {}),
              ...(currentBindings.environmentId ? { environmentId: currentBindings.environmentId } : {}),
              services: currentBindings.services ?? {},
            },
          }
        : {}),
      provider,
      projectId: undefined,
      environmentId: undefined,
      services: {},
    });
    environment = ctx.repos.environments.findById(environment.id) ?? environment;
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      message: `Cannot ensure ${provider} project`,
      error: adapterResult.error ?? `${provider} hosting adapter is unavailable`,
    };
  }
  if (adapterResult.adapter.name !== action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: 'Hosting adapter does not match the reviewed project action',
      error: `Plan targets ${action.resource.provider}, but resolved ${adapterResult.adapter.name}.`,
    };
  }
  const receipt = await adapterResult.adapter.ensureProject(project.name, environment);
  if (!receipt.success) {
    return {
      success: false,
      message: receipt.message,
      error: receipt.error,
      data: receipt.data,
    };
  }

  const refreshedBindings = parseHostingBindings(
    ctx.repos.environments.findById(environment.id) ?? environment
  );
  const projectId = stringField(asRecord(receipt.data), 'projectId') ?? refreshedBindings.projectId;
  const environmentId = stringField(asRecord(receipt.data), 'environmentId') ?? refreshedBindings.environmentId;
  const providerBindings = asRecord(asRecord(receipt.data)?.providerBindings) ?? {};
  const reservedProviderBindingKeys = [
    'provider',
    'projectId',
    'environmentId',
    'services',
    'previousHosting',
  ];
  const reservedProviderBinding = reservedProviderBindingKeys.find((key) => key in providerBindings);
  if (reservedProviderBinding) {
    return {
      success: false,
      status: 'blocked',
      message: `${provider} returned an invalid provider binding`,
      error: `Provider-owned project binding data cannot replace reserved hosting key ${reservedProviderBinding}.`,
      data: receipt.data,
    };
  }
  if (!projectId) {
    return {
      success: false,
      message: receipt.message,
      error: `${provider} reported success without a project ID and no existing project binding could be verified.`,
      data: receipt.data,
    };
  }
  ctx.repos.environments.updatePlatformBindings(environment.id, {
    ...providerBindings,
    provider,
    projectId,
    ...(environmentId ? { environmentId } : {}),
    ...(receipt.data?.created === true ? { services: {} } : {}),
  });
  return {
    success: true,
    message: receipt.message,
    data: {
      provider,
      projectId,
      ...(environmentId ? { environmentId } : {}),
      created: receipt.data?.created === true,
      ...(Object.keys(providerBindings).length > 0 ? { providerBindings } : {}),
    },
  };
}

async function ensureHostingEnvironment(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return {
      success: false,
      message: 'Environment not found locally',
      error: `No local environment "${envName}"`,
    };
  }
  if (
    action.resource.name !== envName
    || action.resource.provider !== project.defaultPlatform
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Environment action ${action.id} does not match the current hosting target`,
      error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected ${project.defaultPlatform}/${envName}.`,
    };
  }

  const currentBindings = parseHostingBindings(environment);
  if (!currentBindings.projectId) {
    return {
      success: false,
      message: `Cannot ensure provider environment "${envName}"`,
      error: 'Provider project binding is missing. The explicit project action must complete first.',
    };
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (
    !adapterResult.success
    || !adapterResult.adapter
    || typeof adapterResult.adapter.ensureEnvironment !== 'function'
  ) {
    return {
      success: false,
      message: `Cannot ensure provider environment "${envName}"`,
      error: adapterResult.error
        ?? `${action.resource.provider} does not implement explicit environment lifecycle`,
    };
  }
  if (adapterResult.adapter.name !== action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: 'Hosting adapter does not match the reviewed environment action',
      error: `Plan targets ${action.resource.provider}, but resolved ${adapterResult.adapter.name}.`,
    };
  }

  const receipt = await adapterResult.adapter.ensureEnvironment(environment);
  if (!receipt.success) {
    return {
      success: false,
      message: receipt.message,
      error: receipt.error,
      data: receipt.data,
    };
  }

  const receiptData = asRecord(receipt.data);
  const projectId = stringField(receiptData, 'projectId') ?? currentBindings.projectId;
  const environmentId = stringField(receiptData, 'environmentId');
  const expectedEnvironmentId = stringField(asRecord(action.metadata), 'expectedEnvironmentId');
  if (projectId !== currentBindings.projectId) {
    return {
      success: false,
      message: receipt.message,
      error: `${action.resource.provider} returned project ${projectId}, but the reviewed action targets bound project ${currentBindings.projectId}.`,
      data: receipt.data,
    };
  }
  if (!environmentId) {
    return {
      success: false,
      message: receipt.message,
      error: `${action.resource.provider} reported success without an environment ID.`,
      data: receipt.data,
    };
  }
  if (expectedEnvironmentId && environmentId !== expectedEnvironmentId) {
    return {
      success: false,
      message: receipt.message,
      error: `${action.resource.provider} returned environment ${environmentId}, but the reviewed action observed ${expectedEnvironmentId}.`,
      data: receipt.data,
    };
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, {
    provider: action.resource.provider,
    projectId,
    environmentId,
  });
  const created = receiptData?.created === true;
  const data = {
    provider: action.resource.provider,
    projectId,
    environmentId,
    created,
  };
  if (created) {
    return {
      success: false,
      status: 'pending',
      message: `${receipt.message}. The provider environment is now bound; re-run hv_plan so storage, databases, and services are planned from fresh live observation.`,
      data,
    };
  }
  return {
    success: true,
    message: receipt.message,
    data,
  };
}

async function applyDomain(
  ctx: CommandContext,
  project: Project,
  envName: string,
  environmentSpec: EnvironmentSpec,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return {
      success: false,
      message: 'Environment not found locally',
      error: `No local environment "${envName}"`,
    };
  }
  if (action.type === 'destroy') {
    const metadata = asRecord(action.metadata);
    const bindings = parseHostingBindings(environment);
    const domainBinding = bindings.domainDns;
    const reviewedRecordIds = stringArrayField(metadata, 'dnsRecordIds').sort();
    const currentRecordIds = (domainBinding?.records ?? []).map((record) => record.id).sort();
    const bindingMatches = action.metadata?.operation === DOMAIN_DETACH_OPERATION
      && action.resource.provider === environmentSpec.hosting.provider
      && !environmentSpec.domain
      && domainBinding?.name === action.resource.name
      && stringField(metadata, 'projectId') === bindings.projectId
      && stringField(metadata, 'serviceName') === domainBinding.serviceName
      && stringField(metadata, 'serviceId') === domainBinding.serviceId
      && stringField(metadata, 'environmentId') === domainBinding.environmentId
      && stringField(metadata, 'providerDomainId') === domainBinding.providerDomainId
      && stringField(metadata, 'zoneId') === domainBinding.zoneId
      && JSON.stringify(reviewedRecordIds) === JSON.stringify(currentRecordIds);
    if (!bindingMatches) {
      return {
        success: false,
        status: 'blocked',
        message: `Domain teardown ${action.id} no longer matches desired state`,
        error: 'The reviewed provider or DNS identities changed, the domain was re-declared, or the environment binding is incomplete. Re-run hv_plan.',
      };
    }

    const result = await teardownCustomDomain({
      project,
      environment,
      domain: action.resource.name,
    });
    if (!result.success) {
      return {
        success: false,
        message: `Domain teardown failed for ${action.resource.name}`,
        error: result.error ?? 'Domain teardown failed',
        data: result as unknown as Record<string, unknown>,
      };
    }

    const serviceName = domainBinding.serviceName!;
    const services = { ...(bindings.services ?? {}) };
    const serviceBinding = services[serviceName];
    if (serviceBinding) {
      services[serviceName] = {
        ...serviceBinding,
        customDomains: (serviceBinding.customDomains ?? [])
          .filter((domain) => domain !== action.resource.name),
      };
    }
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      services,
      domainDns: undefined,
    });
    return {
      success: true,
      message: `Detached domain ${action.resource.name} and removed its managed DNS records`,
      data: result as unknown as Record<string, unknown>,
    };
  }
  if (
    action.resource.provider !== environmentSpec.hosting.provider
    || action.resource.name !== environmentSpec.domain
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Domain action ${action.id} does not match the current environment spec`,
      error: `Reviewed target is ${action.resource.provider}/${action.resource.name}; expected ${environmentSpec.hosting.provider}/${environmentSpec.domain ?? 'no domain'}.`,
    };
  }
  const metadata = asRecord(action.metadata);
  if (metadata?.operation === DOMAIN_ADOPT_OPERATION) {
    const providerDomainId = stringField(metadata, 'providerDomainId');
    const projectId = stringField(metadata, 'projectId');
    const serviceName = stringField(metadata, 'serviceName');
    const serviceId = stringField(metadata, 'serviceId');
    const environmentId = stringField(metadata, 'environmentId');
    const bindings = parseHostingBindings(environment);
    const serviceBinding = serviceName ? bindings.services?.[serviceName] : undefined;
    const exactLegacyBinding = Boolean(
      providerDomainId
      && projectId
      && serviceName
      && serviceId
      && environmentId
      && bindings.provider === action.resource.provider
      && bindings.projectId === projectId
      && bindings.environmentId === environmentId
      && (!bindings.domainDns?.name || bindings.domainDns.name === action.resource.name)
      && serviceBinding?.serviceId === serviceId
    );
    if (!exactLegacyBinding) {
      return {
        success: false,
        status: 'blocked',
        message: `Legacy domain adoption ${action.id} no longer matches local state`,
        error: 'The reviewed provider, environment, service, or legacy hostname binding changed. Re-run hv_plan.',
      };
    }

    const adapterResult = await ctx.adapterFactory.getProviderAdapter(
      action.resource.provider,
      project
    );
    if (!adapterResult.success || !adapterResult.adapter) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot re-observe ${action.resource.name} for adoption`,
        error: adapterResult.error ?? `No ${action.resource.provider} adapter is available.`,
      };
    }
    const adapter = adapterResult.adapter as IProviderAdapter;
    try {
      await adapter.configureTarget?.({ region: environmentSpec.hosting.region });
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot configure ${action.resource.provider} observation for domain adoption`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!adapter.capabilities.supportsObserve || typeof adapter.observe !== 'function') {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot verify ${action.resource.name} for adoption`,
        error: `${action.resource.provider} does not support the live observation required for local-only domain adoption.`,
      };
    }

    let observed;
    try {
      observed = await adapter.observe(environment);
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot re-observe ${action.resource.name} for adoption`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      observed.partial
      || observed.completeness?.services === 'unknown'
      || observed.projectId !== projectId
      || observed.environmentId !== environmentId
    ) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot prove the exact provider identity for ${action.resource.name}`,
        error: 'Provider service observation is partial, unknown, or no longer targets the reviewed environment. No binding was changed.',
      };
    }
    const normalizedDomain = action.resource.name.toLowerCase();
    const matches = observed.services.filter((service) => (
      service.name === serviceName
      && service.externalId === serviceId
      && service.customDomains.some((domain) => domain.toLowerCase() === normalizedDomain)
    ));
    const observedDomainStatus = matches.length === 1
      ? Object.entries(matches[0]!.customDomainStatus ?? {})
          .find(([domain]) => domain.toLowerCase() === normalizedDomain)?.[1]
      : undefined;
    if (
      matches.length !== 1
      || observedDomainStatus?.providerDomainId !== providerDomainId
    ) {
      return {
        success: false,
        status: 'blocked',
        message: `Provider identity for ${action.resource.name} changed before adoption`,
        error: 'The exact reviewed domain, service, or provider-domain identity was not re-observed. No binding was changed; re-run hv_plan.',
      };
    }

    const existingDomainBinding = bindings.domainDns?.name === action.resource.name
      ? bindings.domainDns
      : {};
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      services: {
        ...(bindings.services ?? {}),
        [serviceName!]: {
          ...serviceBinding!,
          customDomains: Array.from(new Set([
            ...(serviceBinding!.customDomains ?? []),
            action.resource.name,
          ])),
        },
      },
      domainDns: {
        ...existingDomainBinding,
        name: action.resource.name,
        proxied: booleanField(metadata, 'domainProxy') ?? environmentSpec.domainProxy ?? true,
        providerDomainId,
        serviceName,
        serviceId,
        environmentId,
      },
    });
    return {
      success: true,
      message: `Adopted the existing ${action.resource.provider} domain identity without changing provider or DNS resources`,
      data: {
        applied: 1,
        skipped: 0,
        providerMutations: 0,
        providerDomainId,
        projectId,
        serviceName,
        serviceId,
        environmentId,
      },
    };
  }
  const recreateRequested = action.type === 'replace';
  const reviewedRecreateRevision = stringField(asRecord(action.metadata), 'domainRecreateRevision');
  if (
    recreateRequested
    && (
      !environmentSpec.domainRecreateRevision
      || reviewedRecreateRevision !== environmentSpec.domainRecreateRevision
    )
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Domain replacement ${action.id} no longer matches desired state`,
      error: 'The reviewed domain recreate revision changed or was removed. Re-run hv_plan.',
    };
  }

  const effectiveDomainProxy = booleanField(
    asRecord(action.metadata) ?? {},
    'domainProxy'
  ) ?? environmentSpec.domainProxy ?? true;
  const result = await setupCustomDomain({
    project,
    environment,
    domain: action.resource.name,
    trafficProxied: effectiveDomainProxy,
    recreate: recreateRequested,
  });
  if (
    result.customDomainAttached
    && result.customDomainId
  ) {
    const bindings = parseHostingBindings(environment);
    const serviceName = result.service;
    const serviceBinding = serviceName ? bindings.services?.[serviceName] : undefined;
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      ...(serviceName && serviceBinding
        ? {
          services: {
            ...(bindings.services ?? {}),
            [serviceName]: {
              ...serviceBinding,
              customDomains: Array.from(new Set([
                ...(serviceBinding.customDomains ?? []),
                action.resource.name,
              ])),
            },
          },
        }
        : {}),
      domainDns: {
        name: action.resource.name,
        proxied: effectiveDomainProxy,
        ...(result.customDomainId ? { providerDomainId: result.customDomainId } : {}),
        ...(serviceName ? { serviceName } : {}),
        ...(serviceBinding?.serviceId ? { serviceId: serviceBinding.serviceId } : {}),
        ...(bindings.environmentId ? { environmentId: bindings.environmentId } : {}),
        ...(result.zone?.id ? { zoneId: result.zone.id } : {}),
        records: (result.dnsRecords ?? []).map((record) => ({
          id: record.id,
          name: record.name,
          type: record.type,
          target: record.target,
        })),
        ...(environmentSpec.domainRecreateRevision
          ? { recreateRevision: environmentSpec.domainRecreateRevision }
          : {}),
      },
    });
  }
  if (result.pending) {
    return {
      success: true,
      status: 'pending',
      message: `Configured DNS for ${action.resource.name}; ${action.resource.provider} domain verification is pending`,
      data: result as unknown as Record<string, unknown>,
    };
  }
  if (result.success) {
    return {
      success: true,
      message: `Configured domain ${action.resource.name}`,
      data: result as unknown as Record<string, unknown>,
    };
  }
  return {
    success: false,
    message: `Domain setup failed for ${action.resource.name}`,
    error: result.error ?? result.dnsError ?? result.customDomainError ?? 'Domain setup failed',
    data: result as unknown as Record<string, unknown>,
  };
}

async function destroyTaskService(
  project: Project,
  action: PlanAction
): Promise<ActionResult> {
  const serviceId = stringField(asRecord(action.metadata), 'externalId');
  if (!serviceId) {
    return {
      success: false,
      message: 'Task service cleanup target is missing provider id',
      error: `No externalId recorded for ${action.resource.name}. Re-run hv_plan.`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: `${action.resource.provider} adapter unavailable`, error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as { deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; message?: string }> };
  if (typeof adapter.deleteService !== 'function') {
    return {
      success: false,
      message: `${action.resource.provider} does not support service deletion via Hypervibe`,
      error: `Manual cleanup required: ${action.resource.provider} service ${serviceId}`,
    };
  }

  const deleted = await adapter.deleteService(serviceId);
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete leftover task service ${action.resource.name}`,
      error: deleted.error,
    };
  }

  return {
    success: true,
    message: `Deleted leftover task service ${action.resource.name}${deleted.message ? ` (${deleted.message})` : ''}`,
    data: { serviceId },
  };
}

/**
 * Delete a service left running on the hosting provider abandoned by a
 * provider switch. Resolves the OLD provider's adapter (not the current
 * hosting adapter) and prunes the previousHosting stash as services go.
 */
async function destroyPreviousHostingService(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const previousHosting = asRecord((environment.platformBindings as Record<string, unknown>).previousHosting);
  const services = asRecord(previousHosting?.services) ?? {};
  const binding = asRecord(services[action.resource.name]);
  const serviceId = stringField(binding, 'serviceId') ?? stringField(binding, 'jobName');
  const cleanupBoundary = stringField(asRecord(action.metadata), 'cleanupBoundary');
  const reviewedServiceId = stringField(asRecord(action.metadata), 'serviceId');
  if (
    !previousHosting
    || stringField(previousHosting, 'provider') !== action.resource.provider
    || !['services', 'project'].includes(cleanupBoundary ?? '')
    || !serviceId
    || reviewedServiceId !== serviceId
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Previous-provider service binding does not match the reviewed target',
      error: `The retained ${action.resource.provider} binding for "${action.resource.name}" changed or is absent. Re-run hv_plan before cleanup.`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: `${action.resource.provider} adapter unavailable`, error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as { name: string; deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; message?: string }> };
  if (typeof adapter.deleteService !== 'function') {
    return {
      success: false,
      message: `${action.resource.provider} does not support service deletion via Hypervibe`,
      error: `Manual cleanup required: ${action.resource.provider} service ${serviceId}`,
    };
  }

  const deleted = await adapter.deleteService(serviceId);
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete ${action.resource.provider} service ${action.resource.name}`,
      error: deleted.error,
    };
  }

  // Prune the stash; drop it entirely when the last service is gone.
  const remaining = Object.fromEntries(Object.entries(services).filter(([name]) => name !== action.resource.name));
  ctx.repos.environments.updatePlatformBindings(environment.id, {
    previousHosting: Object.keys(remaining).length > 0 || cleanupBoundary === 'project'
      ? { ...previousHosting, services: remaining }
      : null,
  });

  return {
    success: true,
    message: `Deleted ${action.resource.provider} service ${action.resource.name}${deleted.message ? ` (${deleted.message})` : ''}`,
  };
}

async function destroyPreviousHostingBoundary(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction,
  boundary: 'environment' | 'project'
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const previousHosting = asRecord((environment.platformBindings as Record<string, unknown>).previousHosting);
  const metadata = asRecord(action.metadata);
  const retainedProvider = stringField(previousHosting, 'provider');
  const retainedProjectId = stringField(previousHosting, 'projectId');
  const retainedEnvironmentId = stringField(previousHosting, 'environmentId');
  if (
    retainedProvider !== action.resource.provider
    || !retainedProjectId
    || (boundary === 'environment' && !retainedEnvironmentId)
    || stringField(metadata, 'previousProvider') !== retainedProvider
    || stringField(metadata, 'cleanupBoundary') !== boundary
    || stringField(metadata, 'projectId') !== retainedProjectId
    || (boundary === 'environment' && stringField(metadata, 'environmentId') !== retainedEnvironmentId)
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Previous-provider ${boundary} binding does not match the reviewed target`,
      error: 'The retained cleanup identity changed or is incomplete. Re-run hv_plan before deleting provider infrastructure.',
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: `${action.resource.provider} adapter unavailable`, error: adapterResult.error };
  }
  const adapter = adapterResult.adapter as {
    deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
    deleteEnvironment?: (
      projectId: string,
      environmentId: string
    ) => Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;
  };
  const deleted = boundary === 'environment'
    ? typeof adapter.deleteEnvironment === 'function'
      ? await adapter.deleteEnvironment(retainedProjectId, retainedEnvironmentId!)
      : { success: false, error: `${action.resource.provider} does not support exact environment deletion` }
    : typeof adapter.deleteProject === 'function'
      ? await adapter.deleteProject(retainedProjectId)
      : { success: false, error: `${action.resource.provider} does not support owned-project deletion` };
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete abandoned ${action.resource.provider} ${boundary}`,
      error: deleted.error,
    };
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, { previousHosting: null });
  return {
    success: true,
    message: `Deleted abandoned ${action.resource.provider} ${boundary} for ${envName}`,
  };
}

async function destroyService(
  ctx: CommandContext,
  project: Project,
  spec: ProjectSpec,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }

  const binding = serviceBindingFor(environment, action.resource.name);
  const serviceId = stringField(binding ?? null, 'serviceId');
  if (!serviceId) {
    return {
      success: false,
      message: 'Service destroy target is missing a local provider binding',
      error: `No local serviceId binding for "${action.resource.name}" in ${envName}.`,
    };
  }
  const plannedServiceId = stringField(action.metadata ?? null, 'externalId');
  if (!plannedServiceId || plannedServiceId !== serviceId) {
    return {
      success: false,
      status: 'blocked',
      message: 'Service destroy target changed after planning',
      error: `The reviewed destroy targets ${plannedServiceId ?? '(missing id)'}, but the current local binding is ${serviceId}. Re-run hv_plan before deleting provider infrastructure.`,
    };
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Hosting adapter unavailable', error: adapterResult.error };
  }
  if (adapterResult.adapter.name !== action.resource.provider) {
    return {
      success: false,
      message: 'Hosting adapter does not match the planned service destroy',
      error: `Plan targets ${action.resource.provider}, but the resolved hosting adapter is ${adapterResult.adapter.name}.`,
    };
  }
  if (typeof adapterResult.adapter.deleteService !== 'function') {
    return {
      success: false,
      message: 'Provider does not support service deletion via Hypervibe',
      error: `Manual cleanup required: ${action.resource.provider} service ${serviceId}`,
    };
  }

  const deleted = await adapterResult.adapter.deleteService(serviceId);
  if (!deleted.success) {
    return {
      success: false,
      message: `Failed to delete ${action.resource.provider} service ${action.resource.name}`,
      error: deleted.error,
    };
  }

  removeServiceBinding(environment.id, environment, action.resource.name);
  const stillBound = ctx.repos.environments
    .findByProjectId(project.id)
    .some((candidate) => environmentHasBinding(candidate, action.resource.name));
  const stillDesired = projectSpecReferencesService(spec, action.resource.name);
  if (!stillBound && !stillDesired) {
    const service = ctx.repos.services.findByProjectAndName(project.id, action.resource.name);
    if (service) {
      ctx.repos.services.delete(service.id);
    }
  }

  return {
    success: true,
    message: `Destroyed ${action.resource.provider} service ${action.resource.name} and removed the ${envName} binding`,
  };
}

async function destroyDatabase(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, action.resource.name);
  if (!component) {
    return {
      success: false,
      status: 'blocked',
      message: 'Database destroy target disappeared after planning',
      error: `The reviewed ${action.resource.name} binding is no longer present locally, so provider absence cannot be proven. Re-run hv_plan.`,
    };
  }

  const bindings = asRecord(component.bindings) ?? {};
  const componentProvider = stringField(bindings, 'provider');
  const previousProvider = stringField(bindings, 'previousProvider');
  const previousBindings = asRecord(bindings.previousBindings);
  const destroysPrevious = componentProvider !== action.resource.provider
    && previousProvider === action.resource.provider
    && previousBindings;
  let componentToDestroy: Component = component;

  if (componentProvider !== action.resource.provider) {
    if (!destroysPrevious) {
      return {
        success: false,
        message: 'Database destroy target does not match the locally tracked component',
        error: `Refusing to destroy ${action.resource.provider}; local ${action.resource.name} is tracked as ${componentProvider ?? 'unknown'}.`,
      };
    }
    componentToDestroy = {
      ...component,
      bindings: previousBindings,
      externalId: stringField(bindings, 'previousExternalId')
        ?? stringField(previousBindings, 'instanceId')
        ?? stringField(previousBindings, 'serviceId')
        ?? null,
    };
  }

  const targetBindings = asRecord(componentToDestroy.bindings) ?? {};
  const targetExternalId = componentToDestroy.externalId
    ?? stringField(targetBindings, 'instanceId')
    ?? stringField(targetBindings, 'serviceId');
  const targetProviderScope = asRecord(targetBindings.providerScope);
  const actionMetadata = asRecord(action.metadata);
  const plannedExternalId = stringField(actionMetadata, 'externalId');
  const plannedBindingsFingerprint = stringField(actionMetadata, 'bindingsFingerprint');
  const plannedProviderScope = asRecord(actionMetadata?.providerScope);
  const plannedScopeEntries = Object.entries(plannedProviderScope ?? {});
  const targetScopeEntries = Object.entries(targetProviderScope ?? {});
  const providerScopeMatches = plannedScopeEntries.length > 0
    && targetScopeEntries.length > 0
    && plannedScopeEntries.every(([, value]) => typeof value === 'string' && value.length > 0)
    && targetScopeEntries.every(([, value]) => typeof value === 'string' && value.length > 0)
    && sortedRecordJson(plannedProviderScope!) === sortedRecordJson(targetProviderScope!);
  if (
    !plannedExternalId
    || targetExternalId !== plannedExternalId
    || !providerScopeMatches
    || !plannedBindingsFingerprint
    || bindingIdentityFingerprint(targetBindings) !== plannedBindingsFingerprint
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Database destroy target changed after planning',
      error: 'The current database provider id or provider-native scope differs from the reviewed destroy action. Re-run hv_plan before deleting data.',
    };
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Database adapter unavailable', error: adapterResult.error };
  }

  const destroyed = await adapterResult.adapter.destroy(componentToDestroy);
  if (!destroyed.success) {
    return { success: false, message: destroyed.message, error: destroyed.error };
  }
  if (destroysPrevious) {
    const nextBindings = { ...bindings };
    delete nextBindings.previousProvider;
    delete nextBindings.previousExternalId;
    delete nextBindings.previousBindings;
    ctx.repos.components.update(component.id, {
      bindings: nextBindings,
      externalId: component.externalId ?? undefined,
    });
    return { success: true, message: `Destroyed previous ${action.resource.provider} ${action.resource.name}` };
  }
  if (
    bindings.provisioningIncomplete === true
    && previousProvider
    && previousBindings
  ) {
    const restoredExternalId = stringField(bindings, 'previousExternalId')
      ?? stringField(previousBindings, 'instanceId')
      ?? stringField(previousBindings, 'serviceId');
    const restoredScope = asRecord(previousBindings.providerScope);
    if (!restoredExternalId || !restoredScope || Object.keys(restoredScope).length === 0) {
      return {
        success: false,
        status: 'blocked',
        message: `Destroyed incomplete ${action.resource.provider} ${action.resource.name}, but the previous database binding is incomplete`,
        error: 'The exact previous provider id and scope must be repaired before Hypervibe can restore that binding safely.',
      };
    }
    ctx.repos.components.update(component.id, {
      bindings: previousBindings,
      externalId: restoredExternalId,
    });
    return {
      success: true,
      message: `Destroyed incomplete ${action.resource.provider} ${action.resource.name} and restored the previous ${previousProvider} database binding`,
    };
  }
  ctx.repos.components.delete(component.id);
  return { success: true, message: `Destroyed ${action.resource.provider} ${action.resource.name} and removed local component` };
}

function sortedRecordJson(record: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))));
}

async function destroyRetainedDatabase(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, status: 'blocked', message: 'Retained database environment is missing', error: `No local environment "${envName}".` };
  }
  const retained = asRecord(environment.platformBindings.previousDatabase);
  const metadata = asRecord(action.metadata);
  const provider = stringField(retained, 'provider');
  const externalId = stringField(retained, 'externalId');
  const engine = stringField(retained, 'engine');
  const retainedName = stringField(retained, 'name');
  const providerScope = asRecord(retained?.providerScope);
  const plannedScope = asRecord(metadata?.providerScope);
  if (
    provider !== action.resource.provider
    || externalId !== stringField(metadata, 'externalId')
    || engine !== action.resource.name
    || !providerScope
    || !plannedScope
    || Object.keys(providerScope).length === 0
    || Object.keys(plannedScope).length === 0
    || Object.entries(providerScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
    || Object.entries(plannedScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
    || sortedRecordJson(providerScope) !== sortedRecordJson(plannedScope)
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained database cleanup identity changed after planning',
      error: 'Re-run hv_plan before deleting any data-bearing provider resource.',
    };
  }

  const matchingUnresolvedComponents = ctx.repos.components
    .findByEnvironmentId(environment.id)
    .filter((candidate) => {
      const bindings = asRecord(candidate.bindings);
      const marker = parseUnresolvedDatabaseMutation(bindings);
      return candidate.type === 'postgres'
        && candidate.externalId === null
        && bindings?.provisioningIncomplete === true
        && stringField(bindings, 'provider') === provider
        && marker !== null
        && marker.resourceName === retainedName
        && sortedRecordJson(marker.providerScope) === sortedRecordJson(providerScope);
    });
  if (matchingUnresolvedComponents.length > 1) {
    return {
      success: false,
      status: 'blocked',
      message: 'Multiple unresolved database markers match the retained cleanup target',
      error: 'Hypervibe cannot choose which local database state to clear after deletion. Repair the duplicate local components before retrying.',
    };
  }
  const unresolvedComponent = matchingUnresolvedComponents[0];
  let restorePrevious: { bindings: Record<string, unknown>; externalId: string } | undefined;
  if (unresolvedComponent) {
    const unresolvedBindings = asRecord(unresolvedComponent.bindings)!;
    const previousProvider = stringField(unresolvedBindings, 'previousProvider');
    if (previousProvider) {
      const previousBindings = asRecord(unresolvedBindings.previousBindings);
      const previousExternalId = stringField(unresolvedBindings, 'previousExternalId')
        ?? stringField(previousBindings, 'instanceId')
        ?? stringField(previousBindings, 'serviceId');
      const previousScope = asRecord(previousBindings?.providerScope);
      if (
        !previousBindings
        || stringField(previousBindings, 'provider') !== previousProvider
        || !previousExternalId
        || !previousScope
        || Object.keys(previousScope).length === 0
        || Object.entries(previousScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
      ) {
        return {
          success: false,
          status: 'blocked',
          message: 'The unresolved database marker has no complete previous binding to restore',
          error: 'Repair the exact previous provider id and provider scope before deleting the unresolved provider-switch target.',
        };
      }
      restorePrevious = { bindings: previousBindings, externalId: previousExternalId };
    }
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, status: 'blocked', message: 'Retained database adapter unavailable', error: adapterResult.error };
  }
  const component: Component = {
    id: `retained:${externalId}`,
    environmentId: environment.id,
    type: engine,
    externalId: externalId!,
    bindings: {
      provider,
      instanceId: externalId,
      providerScope,
      ...providerScope,
      retainedCleanup: true,
    },
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
  const clearBinding = (): void => {
    if (unresolvedComponent) {
      if (restorePrevious) {
        const restored = ctx.repos.components.update(unresolvedComponent.id, {
          bindings: restorePrevious.bindings,
          externalId: restorePrevious.externalId,
        });
        if (!restored) {
          throw new Error(`Could not restore previous database binding after deleting ${externalId}.`);
        }
      } else if (!ctx.repos.components.delete(unresolvedComponent.id)) {
        throw new Error(`Could not clear unresolved database marker after deleting ${externalId}.`);
      }
    }
    const nextBindings = { ...environment.platformBindings };
    delete nextBindings.previousDatabase;
    if (!ctx.repos.environments.update(environment.id, { platformBindings: nextBindings })) {
      throw new Error(`Could not clear retained database cleanup binding after deleting ${externalId}.`);
    }
  };

  try {
    const before = await adapterResult.adapter.observeDatabase(environment, component);
    if (before) {
      if (before.externalId !== externalId) {
        return {
          success: false,
          status: 'blocked',
          message: 'Retained database observation returned a different identity',
          error: `Expected ${externalId}, observed ${before.externalId}. No deletion was attempted.`,
        };
      }
      if (!before.providerScope) {
        return {
          success: false,
          status: 'blocked',
          message: 'Retained database observation omitted its provider scope',
          error: 'Hypervibe cannot authorize deletion by an unscoped provider id. No deletion was attempted.',
        };
      }
      if (sortedRecordJson(before.providerScope) !== sortedRecordJson(providerScope)) {
        return {
          success: false,
          status: 'blocked',
          message: 'Retained database provider scope changed',
          error: 'The live provider scope no longer matches the reviewed binding. No deletion was attempted.',
        };
      }
      const destroyed = await adapterResult.adapter.destroy(component);
      if (!destroyed.success) {
        return { success: false, message: destroyed.message, error: destroyed.error };
      }
      const after = await adapterResult.adapter.observeDatabase(environment, component);
      if (after) {
        return {
          success: false,
          status: 'blocked',
          message: 'Provider acknowledged deletion but the retained database is still present',
          error: `Database ${externalId} remains observable; its cleanup binding was preserved.`,
        };
      }
    }
    clearBinding();
    return {
      success: true,
      message: before
        ? `Deleted retained ${provider} database ${externalId} and cleared its cleanup binding${restorePrevious ? ' while restoring the previous database binding' : unresolvedComponent ? ' and unresolved create marker' : ''}`
        : `Retained ${provider} database ${externalId} was already absent; cleared its cleanup binding${restorePrevious ? ' and restored the previous database binding' : unresolvedComponent ? ' and unresolved create marker' : ''}`,
    };
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained database cleanup could not prove terminal absence',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await adapterResult.adapter.disconnect?.();
  }
}

async function destroyRetainedCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, status: 'blocked', message: 'Retained cache environment is missing', error: `No local environment "${envName}".` };
  }
  const retained = asRecord(environment.platformBindings.previousCache);
  const metadata = asRecord(action.metadata);
  const provider = stringField(retained, 'provider');
  const externalId = stringField(retained, 'externalId');
  const engine = stringField(retained, 'engine');
  const providerEngine = stringField(retained, 'providerEngine');
  const retainedName = stringField(retained, 'name');
  const resourceKind = stringField(retained, 'resourceKind');
  const providerScope = asRecord(retained?.providerScope);
  const plannedScope = asRecord(metadata?.providerScope);
  if (
    provider !== action.resource.provider
    || action.resource.kind !== 'cache'
    || action.resource.name !== 'redis'
    || externalId !== stringField(metadata, 'externalId')
    || engine !== 'redis'
    || stringField(metadata, 'engine') !== engine
    || !retainedName
    || stringField(metadata, 'name') !== retainedName
    || stringField(metadata, 'providerEngine') !== providerEngine
    || stringField(metadata, 'resourceKind') !== resourceKind
    || !providerScope
    || !plannedScope
    || Object.keys(providerScope).length === 0
    || Object.keys(plannedScope).length === 0
    || Object.entries(providerScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
    || Object.entries(plannedScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
    || sortedRecordJson(providerScope) !== sortedRecordJson(plannedScope)
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained cache cleanup identity changed after planning',
      error: 'Re-run hv_plan before deleting any data-bearing provider resource.',
    };
  }

  const localComponents = ctx.repos.components.findByEnvironmentId(environment.id);
  const activeMatches = localComponents.filter((candidate) => {
    const bindings = asRecord(candidate.bindings);
    return candidate.type === 'redis'
      && (
        candidate.externalId
        ?? stringField(bindings, 'instanceId')
        ?? stringField(bindings, 'serviceId')
      ) === externalId
      && stringField(bindings, 'provider') === provider;
  });
  if (activeMatches.length > 0) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained cache target became an active local binding after import',
      error: 'Use the ordinary desired-state cache destroy lifecycle; retained cleanup cannot delete an active component.',
    };
  }
  const matchingUnresolvedComponents = localComponents.filter((candidate) => {
    const bindings = asRecord(candidate.bindings);
    const marker = parseUnresolvedDatastoreMutation(bindings, 'cache');
    return candidate.type === 'redis'
      && candidate.externalId === null
      && bindings?.provisioningIncomplete === true
      && stringField(bindings, 'provider') === provider
      && marker !== null
      && marker.resourceName === retainedName
      && sortedRecordJson(marker.providerScope) === sortedRecordJson(providerScope);
  });
  if (matchingUnresolvedComponents.length > 1) {
    return {
      success: false,
      status: 'blocked',
      message: 'Multiple unresolved cache markers match the retained cleanup target',
      error: 'Hypervibe cannot choose which local cache state to clear after deletion. Repair the duplicate local components before retrying.',
    };
  }
  const unresolvedComponent = matchingUnresolvedComponents[0];
  let restorePrevious: { bindings: Record<string, unknown>; externalId: string } | undefined;
  if (unresolvedComponent) {
    const unresolvedBindings = asRecord(unresolvedComponent.bindings)!;
    const previousProvider = stringField(unresolvedBindings, 'previousProvider');
    if (previousProvider) {
      const previousBindings = asRecord(unresolvedBindings.previousBindings);
      const previousExternalId = stringField(unresolvedBindings, 'previousExternalId')
        ?? stringField(previousBindings, 'instanceId')
        ?? stringField(previousBindings, 'serviceId');
      const previousScope = asRecord(previousBindings?.providerScope);
      const nestedExternalId = stringField(previousBindings, 'instanceId')
        ?? stringField(previousBindings, 'serviceId');
      if (
        !previousBindings
        || stringField(previousBindings, 'provider') !== previousProvider
        || !previousExternalId
        || (nestedExternalId && nestedExternalId !== previousExternalId)
        || !previousScope
        || Object.keys(previousScope).length === 0
        || Object.entries(previousScope).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
      ) {
        return {
          success: false,
          status: 'blocked',
          message: 'The unresolved cache marker has no complete previous binding to restore',
          error: 'Repair the exact previous provider id and provider scope before deleting the unresolved provider-switch target.',
        };
      }
      restorePrevious = { bindings: previousBindings, externalId: previousExternalId };
    }
  }

  const adapterResult = await adapterFactory.getCacheAdapter(provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, status: 'blocked', message: 'Retained cache adapter unavailable', error: adapterResult.error };
  }
  const component: Component = {
    id: `retained:${externalId}`,
    environmentId: environment.id,
    type: 'redis',
    externalId: externalId!,
    bindings: {
      provider,
      instanceId: externalId,
      providerScope,
      retainedCleanup: true,
      ...(resourceKind ? { resourceKind } : {}),
    },
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
  const clearBinding = (): void => {
    if (unresolvedComponent) {
      if (restorePrevious) {
        const restored = ctx.repos.components.update(unresolvedComponent.id, {
          bindings: restorePrevious.bindings,
          externalId: restorePrevious.externalId,
        });
        if (!restored) {
          throw new Error(`Could not restore previous cache binding after deleting ${externalId}.`);
        }
      } else if (!ctx.repos.components.delete(unresolvedComponent.id)) {
        throw new Error(`Could not clear unresolved cache marker after deleting ${externalId}.`);
      }
    }
    const nextBindings = { ...environment.platformBindings };
    delete nextBindings.previousCache;
    if (!ctx.repos.environments.update(environment.id, { platformBindings: nextBindings })) {
      throw new Error(`Could not clear retained cache cleanup binding after deleting ${externalId}.`);
    }
  };

  try {
    const before = await adapterResult.adapter.observeCache(environment, component);
    if (before) {
      if (
        before.provider !== provider
        || before.engine !== engine
        || before.externalId !== externalId
        || before.name !== retainedName
      ) {
        return {
          success: false,
          status: 'blocked',
          message: 'Retained cache observation returned a different identity',
          error: `Expected ${provider}/${engine}/${retainedName}/${externalId}. No deletion was attempted.`,
        };
      }
      if (!before.providerScope) {
        return {
          success: false,
          status: 'blocked',
          message: 'Retained cache observation omitted its provider scope',
          error: 'Hypervibe cannot authorize deletion by an unscoped provider id. No deletion was attempted.',
        };
      }
      if (sortedRecordJson(before.providerScope) !== sortedRecordJson(providerScope)) {
        return {
          success: false,
          status: 'blocked',
          message: 'Retained cache provider scope changed',
          error: 'The live provider scope no longer matches the reviewed binding. No deletion was attempted.',
        };
      }
    }
    // Always invoke the idempotent cache teardown, even when the primary cache
    // is already absent. Provider-owned dependent resources (for example a
    // Railway persistent volume) may remain after a prior partial teardown.
    const destroyed = await adapterResult.adapter.destroy(component);
    if (!destroyed.success) {
      return { success: false, message: destroyed.message, error: destroyed.error };
    }
    const after = await adapterResult.adapter.observeCache(environment, component);
    if (after) {
      return {
        success: false,
        status: 'blocked',
        message: 'Provider acknowledged deletion but the retained cache is still present',
        error: `Cache ${externalId} remains observable; its cleanup binding was preserved.`,
      };
    }
    clearBinding();
    return {
      success: true,
      message: before
        ? `Deleted retained ${provider} cache ${externalId} and cleared its cleanup binding${restorePrevious ? ' while restoring the previous cache binding' : unresolvedComponent ? ' and unresolved create marker' : ''}`
        : `Retained ${provider} cache ${externalId} was already absent; cleared its cleanup binding${restorePrevious ? ' and restored the previous cache binding' : unresolvedComponent ? ' and unresolved create marker' : ''}`,
    };
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained cache cleanup could not prove terminal absence',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await adapterResult.adapter.disconnect?.();
  }
}

async function destroyRetainedResource(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, status: 'blocked', message: 'Retained resource environment is missing', error: `No local environment "${envName}".` };
  }
  const retained = asRecord(environment.platformBindings.previousResource);
  const metadata = asRecord(action.metadata);
  const provider = stringField(retained, 'provider');
  const resource = stringField(retained, 'resource');
  const externalId = stringField(retained, 'externalId');
  const name = stringField(retained, 'name');
  const providerScope = asRecord(retained?.providerScope);
  const plannedScope = asRecord(metadata?.providerScope);
  if (
    provider !== action.resource.provider
    || resource !== action.resource.name
    || resource !== stringField(metadata, 'resource')
    || externalId !== stringField(metadata, 'externalId')
    || name !== stringField(metadata, 'name')
    || !providerScope
    || !plannedScope
    || Object.values(providerScope).some((value) => typeof value !== 'string' || !value)
    || Object.values(plannedScope).some((value) => typeof value !== 'string' || !value)
    || sortedRecordJson(providerScope) !== sortedRecordJson(plannedScope)
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained provider-resource cleanup identity changed after planning',
      error: 'Re-run hv_plan before deleting any data-bearing provider resource.',
    };
  }

  const registration = provider ? providerRegistry.get(provider) : undefined;
  const contract = resource ? registration?.inspection?.selectors[resource] : undefined;
  if (!resource || !externalId || !name || !registration?.retainedCleanup?.resources.includes(resource) || !contract?.collectionKey) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained provider-resource cleanup is no longer supported',
      error: 'The provider registration no longer exposes matching inspection and deletion capabilities. No deletion was attempted.',
    };
  }
  const collectionKey = contract.collectionKey;
  const adapterResult = await adapterFactory.getProviderAdapter(provider!, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, status: 'blocked', message: 'Retained provider adapter unavailable', error: adapterResult.error };
  }

  const inspectExact = async (): Promise<Record<string, unknown> | null> => {
    const inspected = await registration.inspection!.inspect(adapterResult.adapter, {
      resource,
      id: externalId,
      region: stringField(providerScope, 'region') ?? stringField(providerScope, 'location'),
      limit: 1,
      project: { id: project.id, name: project.name },
    });
    const items = Array.isArray(inspected[collectionKey])
      ? inspected[collectionKey] as unknown[]
      : [];
    if (
      inspected.resource !== resource
      || inspected.partial !== false
      || inspected.truncated !== false
      || !['present', 'absent'].includes(String(inspected.observation))
    ) {
      throw new Error('Provider returned an incomplete or unknown retained-resource observation.');
    }
    if (inspected.observation === 'absent') {
      if (items.length > 0) throw new Error('Provider reported absence with a non-empty resource collection.');
      return null;
    }
    const exact = items.filter((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
      && (item as Record<string, unknown>).id === externalId
    ));
    if (exact.length !== 1) throw new Error(`Provider did not return exactly one retained id ${externalId}.`);
    const item = exact[0] as Record<string, unknown>;
    const liveScope = asRecord(item.providerScope);
    if (!liveScope || sortedRecordJson(liveScope) !== sortedRecordJson(providerScope)) {
      throw new Error('The live provider scope no longer matches the reviewed binding.');
    }
    return item;
  };
  const clearBinding = (): void => {
    const nextBindings = { ...environment.platformBindings };
    delete nextBindings.previousResource;
    ctx.repos.environments.update(environment.id, { platformBindings: nextBindings });
  };

  try {
    const before = await inspectExact();
    if (before) {
      const destroyed = await registration.retainedCleanup.destroy(adapterResult.adapter, {
        resource,
        id: externalId,
        name,
        providerScope: providerScope as Record<string, string>,
      });
      if (!destroyed.success) {
        return { success: false, message: destroyed.message, error: destroyed.error, data: destroyed.data };
      }
      const attempts = Math.max(1, Number(process.env.HYPERVIBE_RETAINED_DELETE_ATTEMPTS ?? 10));
      const delayMs = Math.max(0, Number(process.env.HYPERVIBE_RETAINED_DELETE_DELAY_MS ?? 1000));
      let after: Record<string, unknown> | null = before;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        after = await inspectExact();
        if (!after) break;
        if (attempt < attempts - 1 && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (after) {
        return {
          success: false,
          status: 'blocked',
          message: 'Provider acknowledged deletion but the retained resource is still present',
          error: `${resource} ${externalId} remains observable; its cleanup binding was preserved.`,
        };
      }
    }
    clearBinding();
    return {
      success: true,
      message: before
        ? `Deleted retained ${provider} ${resource} ${externalId} and cleared its cleanup binding`
        : `Retained ${provider} ${resource} ${externalId} was already absent; cleared its cleanup binding`,
    };
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'Retained provider-resource cleanup could not prove terminal absence',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await adapterResult.adapter.disconnect?.();
  }
}

async function createDatabase(
  ctx: CommandContext,
  project: Project,
  envName: string,
  environmentSpec: EnvironmentSpec,
  action: PlanAction
): Promise<ActionResult> {
  if (typeof action.metadata?.blockedReason === 'string') {
    return {
      success: false,
      status: 'blocked',
      message: action.reason,
      error: 'The database action is blocked by unresolved observation or durable identity. Re-run hv_plan after resolving the reported state.',
    };
  }
  const desired = environmentSpec.database;
  if (
    !desired
    || desired.provider !== action.resource.provider
    || desired.engine !== action.resource.name
  ) {
    return blockedActionIdentity(
      action,
      'The reviewed database provider or engine no longer matches desired state.'
    );
  }
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const existing = ctx.repos.components.findByEnvironmentAndType(environment.id, action.resource.name);
  const unresolvedCreate = parseUnresolvedDatabaseMutation(existing?.bindings);
  if (unresolvedCreate) {
    return {
      success: false,
      status: 'blocked',
      message: 'The previous database create outcome is still unresolved',
      error: `Hypervibe will not issue another create for ${unresolvedCreate.resourceName} in ${JSON.stringify(unresolvedCreate.providerScope)}. Re-observe that exact name/scope and explicitly import or clean up the resulting provider identity first.`,
    };
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Database adapter unavailable', error: adapterResult.error };
  }

  try {
    await adapterResult.adapter.configureTarget?.({
      projectName: project.name,
      region: environmentSpec.hosting.region,
    });
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'Database placement is invalid or unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const engine = desired.engine as DatabaseType;
  const provisioned = await adapterResult.adapter.provision(engine, environment, {
    databaseName: 'app',
    resourceName: `${project.name}-${envName}-${engine}`,
  });
  if (!provisioned.receipt.success) {
    const recoverableComponentRetained = retainFailedProvisionIdentity({
      ctx,
      environment,
      provider: action.resource.provider,
      capability: 'database',
      component: provisioned.component,
      existing,
    });
    return {
      success: false,
      message: provisioned.receipt.message,
      error: provisioned.receipt.error,
      data: {
        ...(provisioned.receipt.data ?? {}),
        ...(recoverableComponentRetained ? { recoverableComponentRetained: true } : {}),
      },
    };
  }

  const newBindings = { ...(asRecord(provisioned.component.bindings) ?? {}) };
  delete newBindings.provisioningIncomplete;
  delete newBindings.reconciliationIncomplete;
  const existingBindings = asRecord(existing?.bindings) ?? null;
  const existingProvider = stringField(existingBindings, 'provider');
  const bindingsToStore = existing && existingProvider && existingProvider !== action.resource.provider
    ? {
        ...newBindings,
        previousProvider: existingProvider,
        previousExternalId: existing.externalId ?? undefined,
        previousBindings: existing.bindings,
      }
    : newBindings;

  if (existing) {
    ctx.repos.components.update(existing.id, {
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  } else {
    ctx.repos.components.create({
      environmentId: environment.id,
      type: action.resource.name,
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  }
  const primaryExternalId = provisioned.component.externalId
    ?? stringField(newBindings, 'instanceId');
  if (primaryExternalId) {
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      databaseTopology: {
        primary: { provider: action.resource.provider, externalId: primaryExternalId },
        replicas: {},
      },
    });
  }

  return {
    success: true,
    message: `${provisioned.receipt.message}. Database recorded locally; run hv_plan again after data restore to repoint services.`,
    data: {
      provider: action.resource.provider,
      componentId: provisioned.component.externalId ?? provisioned.component.id,
      previousProvider: existingProvider && existingProvider !== action.resource.provider ? existingProvider : undefined,
      receiptData: provisioned.receipt.data,
    },
  };
}

async function createCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  environmentSpec: EnvironmentSpec,
  action: PlanAction
): Promise<ActionResult> {
  if (typeof action.metadata?.blockedReason === 'string') {
    return {
      success: false,
      status: 'blocked',
      message: action.reason,
      error: 'The cache action is blocked by unresolved observation or durable identity. Re-run hv_plan after resolving the reported state.',
    };
  }
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }

  const desired = environmentSpec.cache;
  const metadata = asRecord(action.metadata) ?? {};
  const configFields = ['region', 'network', 'subnetwork', 'tier', 'size'] as const;
  const staleConfigField = configFields.find((field) => (
    metadata[field] !== (desired?.[field] ?? null)
  ));
  if (
    !desired
    || desired.provider !== action.resource.provider
    || desired.engine !== action.resource.name
    || staleConfigField
  ) {
    return blockedActionIdentity(
      action,
      staleConfigField
        ? `Cache ${staleConfigField} changed after planning; re-run hv_plan before provisioning.`
        : 'The reviewed cache provider or engine no longer matches desired state.'
    );
  }

  const engine = action.resource.name as CacheEngine;
  const existing = ctx.repos.components.findByEnvironmentAndType(environment.id, engine);
  const unresolvedCreate = parseUnresolvedDatastoreMutation(existing?.bindings, 'cache');
  if (unresolvedCreate) {
    return {
      success: false,
      status: 'blocked',
      message: 'The previous cache create outcome is still unresolved',
      error: `Hypervibe will not issue another create for ${unresolvedCreate.resourceName} in ${JSON.stringify(unresolvedCreate.providerScope)}. Re-observe that exact name/scope and explicitly import or clean up the resulting provider identity first.`,
    };
  }
  const unresolvedNetworkCreate = parseUnresolvedCacheNetworkMutation(existing?.bindings);
  const actionDeclaresNetworkRecovery = Object.prototype.hasOwnProperty.call(
    metadata,
    'recoveryMarker'
  );
  const plannedNetworkRecovery = actionDeclaresNetworkRecovery
    ? parseUnresolvedCacheNetworkMutation({
        unresolvedNetworkMutation: metadata.recoveryMarker,
      })
    : null;
  if (
    Boolean(unresolvedNetworkCreate) !== Boolean(plannedNetworkRecovery)
    || (actionDeclaresNetworkRecovery && !plannedNetworkRecovery)
    || (
      unresolvedNetworkCreate
      && plannedNetworkRecovery
      && JSON.stringify(unresolvedNetworkCreate) !== JSON.stringify(plannedNetworkRecovery)
    )
  ) {
    return blockedActionIdentity(
      action,
      'The unresolved cache-network create marker changed after planning; its exact resource name, cache name, provider scope, network scope, and ownership tags must all remain unchanged.'
    );
  }
  const adapterResult = await adapterFactory.getCacheAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Cache adapter unavailable', error: adapterResult.error };
  }
  const existingBindings = asRecord(existing?.bindings);
  const existingProvider = stringField(existingBindings, 'provider');
  const target = {
    projectName: project.name,
    region: desired.region,
    network: desired.network,
    subnetwork: desired.subnetwork,
    tier: desired.tier,
    size: desired.size,
  };
  try {
    await adapterResult.adapter.configureTarget?.(target);
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'Cache placement is invalid or unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const provisioned = await adapterResult.adapter.provision(engine, environment, {
    resourceName: `${project.name}-${envName}-${engine}`,
    ...target,
    component: existingProvider === action.resource.provider ? existing : null,
  });
  if (!provisioned.receipt.success) {
    const recoverableComponentRetained = retainFailedProvisionIdentity({
      ctx,
      environment,
      provider: action.resource.provider,
      capability: 'cache',
      component: provisioned.component,
      existing,
    });
    return {
      success: false,
      message: provisioned.receipt.message,
      error: provisioned.receipt.error,
      data: {
        ...(provisioned.receipt.data ?? {}),
        ...(recoverableComponentRetained ? { recoverableComponentRetained: true } : {}),
      },
    };
  }

  const newBindings = { ...(asRecord(provisioned.component.bindings) ?? {}) };
  delete newBindings.provisioningIncomplete;
  delete newBindings.reconciliationIncomplete;
  const runtimeNetwork = asRecord(newBindings.runtimeNetwork);
  const requiredNetworkFields = ['provider', 'projectId', 'region', 'network', 'subnetwork', 'egress'];
  const validRuntimeNetwork = runtimeNetwork
    && requiredNetworkFields.every((field) => (
      typeof runtimeNetwork[field] === 'string' && String(runtimeNetwork[field]).length > 0
    ));
  const bindingsToStore = existing && existingProvider && existingProvider !== action.resource.provider
    ? {
        ...newBindings,
        previousProvider: existingProvider,
        previousExternalId: existing.externalId ?? undefined,
        previousBindings: existing.bindings,
      }
    : newBindings;

  if (existing) {
    ctx.repos.components.update(existing.id, {
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  } else {
    ctx.repos.components.create({
      environmentId: environment.id,
      type: engine,
      bindings: bindingsToStore,
      externalId: provisioned.component.externalId ?? undefined,
    });
  }

  if (validRuntimeNetwork) {
    ctx.repos.environments.updatePlatformBindings(environment.id, {
      cacheNetwork: runtimeNetwork,
    });
  } else if (!adapterResult.adapter.capabilities.requiresRuntimeNetwork) {
    // A cache provider without private runtime networking replaces any stale
    // Memorystore attachment. The dependent service action owns its removal.
    ctx.repos.environments.updatePlatformBindings(environment.id, { cacheNetwork: null });
  }
  if (adapterResult.adapter.capabilities.requiresRuntimeNetwork && !validRuntimeNetwork) {
    return {
      success: false,
      message: 'Cache provider succeeded without a usable runtime network binding',
      error: 'The exact cache component was retained locally for recovery, but service wiring is blocked because provider/project/region/network/subnetwork/egress were not all verified.',
      data: {
        provider: action.resource.provider,
        componentId: provisioned.component.externalId ?? provisioned.component.id,
        recoverableComponentRetained: true,
      },
    };
  }

  return {
    success: true,
    message: `${provisioned.receipt.message}. Cache recorded locally; run hv_plan again to verify REDIS_URL wiring.`,
    data: {
      provider: action.resource.provider,
      componentId: provisioned.component.externalId ?? provisioned.component.id,
      previousProvider: existingProvider && existingProvider !== action.resource.provider
        ? existingProvider
        : undefined,
      receiptData: provisioned.receipt.data,
    },
  };
}

async function unwireCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  environmentSpec: EnvironmentSpec,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  const serviceName = stringField(asRecord(action.metadata), 'serviceName');
  const service = serviceName
    ? ctx.repos.services.findByProjectAndName(project.id, serviceName)
    : null;
  if (!environment || !service || !serviceName) {
    return {
      success: false,
      message: 'Cannot remove Redis environment variables',
      error: !environment
        ? `Environment "${envName}" is not tracked locally`
        : `Service "${serviceName ?? 'unknown'}" is not tracked locally`,
    };
  }
  if (environmentSpec.cache) {
    return blockedActionIdentity(
      action,
      `Redis is still desired through ${environmentSpec.cache.provider}; re-run hv_plan before removing its runtime wiring.`
    );
  }
  const environmentWithoutCacheNetwork: Environment = {
    ...environment,
    platformBindings: {
      ...environment.platformBindings,
      cacheNetwork: null,
    },
  };
  const result = await removeHostingEnvVars({
    project,
    environment: environmentWithoutCacheNetwork,
    service,
    keys: ['REDIS_URL'],
  });
  if (result.success) {
    ctx.repos.environments.updatePlatformBindings(environment.id, { cacheNetwork: null });
  }
  return result;
}

async function destroyCache(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, 'redis');
  if (!component) {
    return {
      success: false,
      status: 'blocked',
      message: 'Cache destroy target disappeared after planning',
      error: 'The reviewed Redis binding is no longer present locally, so Hypervibe cannot prove which provider resource the action authorized. Re-run hv_plan.',
    };
  }

  const bindings = asRecord(component.bindings) ?? {};
  const componentProvider = stringField(bindings, 'provider');
  const previousProvider = stringField(bindings, 'previousProvider');
  const previousBindings = asRecord(bindings.previousBindings);
  const destroysPrevious = componentProvider !== action.resource.provider
    && previousProvider === action.resource.provider
    && previousBindings;
  let componentToDestroy: Component = component;

  if (componentProvider !== action.resource.provider) {
    if (!destroysPrevious) {
      return {
        success: false,
        message: 'Cache destroy target does not match the locally tracked component',
        error: `Refusing to destroy ${action.resource.provider}; local Redis is tracked as ${componentProvider ?? 'unknown'}.`,
      };
    }
    componentToDestroy = {
      ...component,
      bindings: previousBindings,
      externalId: stringField(bindings, 'previousExternalId')
        ?? stringField(previousBindings, 'instanceId')
        ?? null,
    };
  }

  const targetBindings = asRecord(componentToDestroy.bindings) ?? {};
  const targetExternalId = componentToDestroy.externalId
    ?? stringField(targetBindings, 'instanceId')
    ?? stringField(targetBindings, 'serviceId');
  const targetProviderScope = asRecord(targetBindings.providerScope);
  const actionMetadata = asRecord(action.metadata);
  const plannedExternalId = stringField(actionMetadata, 'externalId');
  const plannedBindingsFingerprint = stringField(actionMetadata, 'bindingsFingerprint');
  const plannedProviderScope = asRecord(actionMetadata?.providerScope);
  const plannedScopeEntries = Object.entries(plannedProviderScope ?? {});
  const targetScopeEntries = Object.entries(targetProviderScope ?? {});
  const providerScopeMatches = plannedScopeEntries.length > 0
    && targetScopeEntries.length > 0
    && plannedScopeEntries.every(([, value]) => typeof value === 'string' && value.length > 0)
    && targetScopeEntries.every(([, value]) => typeof value === 'string' && value.length > 0)
    && sortedRecordJson(plannedProviderScope!) === sortedRecordJson(targetProviderScope!);
  if (
    !plannedExternalId
    || targetExternalId !== plannedExternalId
    || !providerScopeMatches
    || !plannedBindingsFingerprint
    || bindingIdentityFingerprint(targetBindings) !== plannedBindingsFingerprint
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Cache destroy target changed after planning',
      error: 'The current Redis provider id or provider-native scope differs from the reviewed destroy action. Re-run hv_plan before deleting data.',
    };
  }

  const adapterResult = await adapterFactory.getCacheAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Cache adapter unavailable', error: adapterResult.error };
  }
  const destroyed = await adapterResult.adapter.destroy(componentToDestroy);
  if (!destroyed.success) {
    return { success: false, message: destroyed.message, error: destroyed.error };
  }
  if (destroysPrevious) {
    const nextBindings = { ...bindings };
    delete nextBindings.previousProvider;
    delete nextBindings.previousExternalId;
    delete nextBindings.previousBindings;
    ctx.repos.components.update(component.id, {
      bindings: nextBindings,
      externalId: component.externalId ?? undefined,
    });
    return { success: true, message: `Destroyed previous ${action.resource.provider} Redis cache` };
  }
  if (
    bindings.provisioningIncomplete === true
    && previousProvider
    && previousBindings
  ) {
    const restoredExternalId = stringField(bindings, 'previousExternalId')
      ?? stringField(previousBindings, 'instanceId')
      ?? stringField(previousBindings, 'serviceId');
    const restoredScope = asRecord(previousBindings.providerScope);
    if (!restoredExternalId || !restoredScope || Object.keys(restoredScope).length === 0) {
      return {
        success: false,
        status: 'blocked',
        message: `Destroyed incomplete ${action.resource.provider} Redis cache, but the previous cache binding is incomplete`,
        error: 'The exact previous provider id and scope must be repaired before Hypervibe can restore that binding safely.',
      };
    }
    ctx.repos.components.update(component.id, {
      bindings: previousBindings,
      externalId: restoredExternalId,
    });
    return {
      success: true,
      message: `Destroyed incomplete ${action.resource.provider} Redis cache and restored the previous ${previousProvider} cache binding`,
    };
  }
  ctx.repos.components.delete(component.id);
  ctx.repos.environments.updatePlatformBindings(environment.id, { cacheNetwork: null });
  return { success: true, message: `Destroyed ${action.resource.provider} Redis cache and removed local component` };
}

export async function applyDatabaseSeed(
  ctx: CommandContext,
  project: Project,
  envName: string,
  action: PlanAction
): Promise<ActionResult> {
  const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${envName}"` };
  }
  const command = stringField(asRecord(action.metadata), 'command');
  const commandHash = stringField(asRecord(action.metadata), 'commandHash');
  if (!command || !commandHash) {
    return {
      success: false,
      message: 'Database seed action is missing command metadata',
      error: 'Re-run hv_plan so the seed action includes command and commandHash.',
    };
  }

  const engine = stringField(asRecord(action.metadata), 'engine') ?? 'postgres';
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, engine);
  if (!component) {
    return {
      success: false,
      message: 'Database component not found',
      error: `No ${engine} component is recorded for ${project.name}/${envName}. Re-run hv_plan/hv_apply to create the database first.`,
    };
  }

  const result = await runEnvironmentTask({
    project,
    environment,
    command,
    purpose: 'database seed command',
  });
  if (result.success === false) {
    const receiptData = asRecord(asRecord(result.receipt)?.data);
    if (receiptData?.pendingDeploy) {
      // Fresh environment: the database exists but CI has not deployed an
      // image yet. Not stamping seededAt keeps the seed action in the next
      // plan, so it runs once a deploy exists.
      return {
        success: true,
        message: `Database seed is pending the first deploy for ${project.name}/${envName}`,
        data: {
          pendingDeploy: true,
          hint: 'Deploy first (push to the deploy branch or hv_ci_trigger), then re-run hv_plan/hv_apply — the declarative seed action stays planned until it completes.',
        },
      };
    }
    return {
      success: false,
      message: 'Database seed command failed',
      error: result.error,
      data: result as unknown as Record<string, unknown>,
    };
  }

  const seededAt = new Date().toISOString();
  ctx.repos.components.updateBindings(component.id, {
    seed: {
      commandHash,
      seededAt,
      source: 'hv_apply',
    },
  });

  return {
    success: true,
    message: `Database seed command completed for ${project.name}/${envName}`,
    data: {
      ...result,
      seed: {
        commandHash,
        seededAt,
      },
    },
  };
}
