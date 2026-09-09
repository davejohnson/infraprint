import type { PlanAction, PlanResourceKind } from './plan.types.js';
import { HOSTING_ENVIRONMENT_ENSURE_OPERATION } from './plan.service.js';
import {
  isCloudflareDomainRegistrationAction,
} from '../services/domain-registration.service.js';
import {
  isGitHubActionsAppliedSpecHashAction,
  isGitHubActionsDeployAction,
  isGitHubActionsReleaseAction,
} from '../services/ci-deploy.service.js';
import { isGitHubCollaborationAction } from '../services/repo-collaboration.service.js';
import {
  isGitHubInfrastructureAction,
  isGitHubDelegatedSecretAction,
  GITHUB_DELEGATED_SECRET_DESTROY_OPERATION,
  GITHUB_DELEGATED_SECRET_OPERATION,
  isGitHubNativeSettingAction,
  isGitHubOpenAISecretAction,
  OPENAI_ACTIONS_SECRET,
} from '../services/github-infrastructure.service.js';
import {
  isGitHubPagesAction,
  isGitHubPagesBindingCleanupAction,
  isGitHubPagesDnsAction,
} from '../services/github-pages.service.js';
import { IOS_OPERATIONS, isIosAction } from '../services/appstore-plan.service.js';
import { QUEUE_OPERATIONS, isQueueAction } from '../services/queue-plan.service.js';
import { STORAGE_OPERATIONS, isStorageAction } from '../services/storage-plan.service.js';
import {
  delegatedSecretActionId,
  isDelegatedSecretAction,
} from '../services/delegated-secret.service.js';
import {
  STRIPE_CATALOG_OPERATIONS,
  STRIPE_HOSTING_ENV_SYNC_OPERATION,
  STRIPE_WEBHOOK_OPERATIONS,
  isStripeCatalogAction,
  isStripeHostingEnvSyncAction,
  isStripeWebhookAction,
} from '../services/stripe-env.service.js';
import { isHostingEnvRemovalAction } from '../services/hosting-env.service.js';
import { isProviderNativeDeploySourceAction } from '../services/provider-native-deploy-source.service.js';
import { CACHE_OPERATIONS, isCacheAction } from '../services/cache-plan.service.js';
import {
  GITHUB_ACTIONS_ROLLBACK_OPERATION,
  GITLAB_CI_ROLLBACK_OPERATION,
  GITLAB_ROLLBACK_REF_ENSURE_OPERATION,
} from '../services/ci-rollback.contract.js';
import {
  DATABASE_RESILIENCE_OPERATIONS,
  isDatabaseResilienceAction,
} from '../services/database-resilience-plan.service.js';
import {
  isLoadBalancerAction,
  LOAD_BALANCER_OPERATIONS,
} from '../services/load-balancer-plan.service.js';
import { EMAIL_OPERATIONS } from '../services/email-plan.service.js';
import { MESSAGING_OPERATIONS } from '../services/twilio-messaging.service.js';
import {
  DOMAIN_ADOPT_OPERATION,
  DOMAIN_DETACH_OPERATION,
} from '../services/domain-attach-policy.js';
import {
  DATA_MIGRATION_OPERATIONS,
  isDataMigrationAction,
} from '../services/data-migration-plan.service.js';
import {
  MAINTENANCE_OPERATIONS,
  isMaintenanceAction,
} from '../services/maintenance-plan.service.js';
import {
  CI_APPLIED_SPEC_SYNC_OPERATION,
  CI_BINDING_REMOVE_OPERATION,
  CI_CONFIGURATION_SYNC_OPERATION,
  CI_VARIABLE_DELETE_OPERATION,
  CI_VARIABLE_SYNC_OPERATION,
} from '../services/managed-ci.contract.js';
import {
  CODE_REPOSITORY_BINDING_REMOVE_OPERATION,
  CODE_REPOSITORY_CREATE_OPERATION,
  CODE_REPOSITORY_DESTROY_OPERATION,
} from '../services/managed-code-repository.contract.js';

export type PlanMutationCapability =
  | 'hosting.environment.ensure'
  | 'domain.registration.mutate'
  | 'github.ci.sync'
  | 'github.ci.rollback'
  | 'gitlab.rollback-ref.ensure'
  | 'gitlab.ci.rollback'
  | 'github.ci.release'
  | 'github.applied-spec-hash.sync'
  | 'ci.configuration.sync'
  | 'ci.variable.sync'
  | 'ci.variable.delete'
  | 'ci.binding.remove'
  | 'ci.applied-spec-hash.sync'
  | 'code.repository.create'
  | 'code.repository.destroy'
  | 'code.repository.binding.remove'
  | 'github.collaboration.sync'
  | 'github.infrastructure.sync'
  | 'github.openai-secret.sync'
  | 'github.delegated-secret.sync'
  | 'github.setting.sync'
  | 'github.pages.sync'
  | 'github.pages-binding.cleanup'
  | 'github.pages-dns.sync'
  | 'appstore.mutate'
  | 'queue.mutate'
  | 'storage.mutate'
  | 'load-balancer.monitor.mutate'
  | 'load-balancer.pool.mutate'
  | 'load-balancer.mutate'
  | 'hosting.delegated-secret.sync'
  | 'stripe.hosting-env.sync'
  | 'stripe.catalog.mutate'
  | 'stripe.webhook.mutate'
  | 'hosting.env.remove'
  | 'hosting.deploy-source.disconnect'
  | 'cache.provision'
  | 'cache.env.remove'
  | 'cache.destroy'
  | 'cache.retained.destroy'
  | 'database.provision'
  | 'database.availability.configure'
  | 'database.backup-policy.configure'
  | 'database.replica.provision'
  | 'database.replica.destroy'
  | 'database.seed'
  | 'database.destroy'
  | 'database.retained.destroy'
  | 'provider-resource.retained.destroy'
  | 'database.migrate'
  | 'storage.migrate'
  | 'database.migration-target.destroy'
  | 'storage.migration-target.destroy'
  | 'maintenance.edge.mutate'
  | 'maintenance.workload.mutate'
  | 'maintenance.database-fence.mutate'
  | 'maintenance.verify'
  | 'hosting.task-service.destroy'
  | 'hosting.previous-service.destroy'
  | 'hosting.previous-environment.destroy'
  | 'hosting.previous-project.destroy'
  | 'hosting.service.destroy'
  | 'domain.configure'
  | 'email.runtime.sync'
  | 'email.authorization.mutate'
  | 'email.dns.sync'
  | 'email.inbound.mutate'
  | 'email.delivery-events.mutate'
  | 'email.forwarding.mutate'
  | 'messaging.service.mutate'
  | 'messaging.sender.mutate'
  | 'messaging.runtime.sync'
  | 'local.environment.record'
  | 'hosting.project.ensure'
  | 'hosting.service.converge'
  | 'hosting.service.rollback';

export interface PlanActionAuthority {
  actionId: string;
  capability: PlanMutationCapability;
  operation?: string;
  resource: {
    kind: PlanResourceKind;
    name: string;
    provider: string;
  };
}

function authority(
  action: PlanAction,
  capability: PlanMutationCapability
): PlanActionAuthority {
  const operation = typeof action.metadata?.operation === 'string'
    ? action.metadata.operation
    : undefined;
  return {
    actionId: action.id,
    capability,
    ...(operation ? { operation } : {}),
    resource: { ...action.resource },
  };
}

function exactResource(
  action: PlanAction,
  kind: PlanResourceKind,
  provider?: string
): boolean {
  return action.resource.kind === kind
    && (!provider || action.resource.provider === provider);
}

function hasType(action: PlanAction, ...types: PlanAction['type'][]): boolean {
  return types.includes(action.type);
}

function metadataString(action: PlanAction, key: string): string | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadataStringArray(action: PlanAction, key: string): string[] | undefined {
  const value = action.metadata?.[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return undefined;
  }
  return value;
}

function metadataStringRecord(action: PlanAction, key: string): Record<string, string> | undefined {
  const value = action.metadata?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key, item]) => !key.trim() || typeof item !== 'string' || item.trim().length === 0)) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function hasServiceDeleteTarget(action: PlanAction): boolean {
  const scope = metadataString(action, 'deleteScope');
  const providerScope = metadataStringRecord(action, 'providerScope');
  if (!metadataString(action, 'externalId') || !providerScope?.projectId) return false;
  return scope === 'project'
    || (scope === 'environment' && Boolean(providerScope.environmentId));
}

function githubInfrastructureIncludesRestoreDrill(action: PlanAction): boolean {
  const files = action.metadata?.desiredFiles;
  return Array.isArray(files) && files.some((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
    const path = (file as Record<string, unknown>).path;
    return typeof path === 'string' && path.includes('restore-drill');
  });
}

function metadataBoolean(action: PlanAction, key: string): boolean | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function metadataPositiveInteger(action: PlanAction, key: string): number | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function metadataPositiveIntegerString(action: PlanAction, key: string): string | undefined {
  const value = metadataString(action, key);
  return value && /^[1-9]\d*$/.test(value) ? value : undefined;
}

function metadataSha256(action: PlanAction, key: string): string | undefined {
  const value = metadataString(action, key);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function cacheDesiredConfigIsPinned(action: PlanAction): boolean {
  return ['region', 'network', 'subnetwork', 'tier', 'size'].every((key) => {
    if (!Object.prototype.hasOwnProperty.call(action.metadata ?? {}, key)) return false;
    const value = action.metadata?.[key];
    return value === null || (typeof value === 'string' && value.length > 0);
  });
}

function loadBalancerOriginsArePinned(action: PlanAction): boolean {
  const origins = action.metadata?.origins;
  if (!Array.isArray(origins) || origins.length < 2 || !metadataSha256(action, 'originsHash')) {
    return false;
  }
  const names = new Set<string>();
  for (const value of origins) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const origin = value as Record<string, unknown>;
    if (
      typeof origin.name !== 'string'
      || !origin.name
      || names.has(origin.name)
      || typeof origin.address !== 'string'
      || !origin.address
      || typeof origin.hostHeader !== 'string'
      || !origin.hostHeader
      || origin.enabled !== true
    ) return false;
    names.add(origin.name);
  }
  return true;
}

function operationTypeIsValid(action: PlanAction): boolean {
  const operation = metadataString(action, 'operation');
  switch (operation) {
    case IOS_OPERATIONS.bundleIdRegister:
    case IOS_OPERATIONS.appRecord:
      return action.type === 'create';
    case IOS_OPERATIONS.capabilitiesEnable:
    case IOS_OPERATIONS.groupTestersEnsure:
      return action.type === 'update';
    case IOS_OPERATIONS.betaGroupEnsure:
      return hasType(action, 'create', 'update');
    case QUEUE_OPERATIONS.ensure:
      return hasType(action, 'create', 'update')
        && !metadataString(action, 'blockedReason')
        && (
          metadataString(action, 'backend') === 'postgres'
          || (
            metadataString(action, 'backend') === 'pubsub'
            && Boolean(metadataStringRecord(action, 'providerScope'))
          )
        );
    case QUEUE_OPERATIONS.destroy:
      return action.type === 'destroy' && Boolean(
        metadataString(action, 'backend') === 'postgres'
        || (
          metadataString(action, 'backend') === 'pubsub'
          && action.dataBearing === true
          && action.requiresConfirm === true
          && metadataString(action, 'topicName')
          && metadataString(action, 'subscriptionName')
          && metadataStringRecord(action, 'providerScope')
        )
      );
    case STORAGE_OPERATIONS.ensure:
      return (action.type === 'update' && Boolean(metadataString(action, 'blockedReason')))
        || (action.type === 'create' && action.billable === true);
    case STORAGE_OPERATIONS.wire:
    case STORAGE_OPERATIONS.unwire:
      return action.type === 'update';
    case STORAGE_OPERATIONS.destroy:
      return action.type === 'destroy'
        && action.dataBearing === true
        && action.requiresConfirm === true;
    case STRIPE_HOSTING_ENV_SYNC_OPERATION:
      return action.type === 'update';
    case STRIPE_CATALOG_OPERATIONS.productEnsure:
    case STRIPE_CATALOG_OPERATIONS.priceEnsure:
      return hasType(action, 'create', 'update', 'replace');
    case STRIPE_CATALOG_OPERATIONS.productAdopt:
    case STRIPE_CATALOG_OPERATIONS.priceAdopt:
      return action.type === 'update';
    case STRIPE_CATALOG_OPERATIONS.productArchive:
    case STRIPE_CATALOG_OPERATIONS.priceArchive:
      return action.type === 'destroy';
    case STRIPE_WEBHOOK_OPERATIONS.ensure:
      return hasType(action, 'create', 'update', 'replace');
    case STRIPE_WEBHOOK_OPERATIONS.adopt:
      return action.type === 'update';
    case STRIPE_WEBHOOK_OPERATIONS.destroy:
      return action.type === 'destroy';
    default:
      return true;
  }
}

function iosIdentityIsValid(action: PlanAction): boolean {
  const operation = metadataString(action, 'operation');
  const bundleId = metadataString(action, 'bundleId');
  if (!bundleId) return false;
  if (
    operation === IOS_OPERATIONS.bundleIdRegister
    || operation === IOS_OPERATIONS.capabilitiesEnable
    || operation === IOS_OPERATIONS.appRecord
  ) {
    return action.resource.name === bundleId;
  }
  const groupName = metadataString(action, 'groupName');
  return Boolean(groupName && action.resource.name === groupName);
}

function stripeCatalogIdentityIsValid(action: PlanAction): boolean {
  const productKey = metadataString(action, 'productKey');
  if (!productKey) return false;
  const priceKey = metadataString(action, 'priceKey');
  return action.resource.name === (priceKey ? `${productKey}.${priceKey}` : productKey);
}

/**
 * Resolve the one mutation boundary authorized by a reviewed plan action.
 *
 * Operation classifiers alone are insufficient: persisted plan JSON can be
 * corrupt or crafted, so every special operation is paired with its expected
 * resource kind/provider before it can reach a mutation handler.
 */
export function resolvePlanActionAuthority(
  action: PlanAction
): PlanActionAuthority | null {
  if (action.type === 'noop') return null;
  if (!action.id.trim() || !action.resource.name.trim() || !action.resource.provider.trim()) {
    return null;
  }

  if (
    exactResource(action, 'retained-resource')
    && action.type === 'destroy'
    && action.metadata?.operation === 'retainedResourceDestroy'
    && metadataString(action, 'resource') === action.resource.name
    && metadataString(action, 'externalId')
    && metadataString(action, 'name')
    && metadataStringRecord(action, 'providerScope')
    && action.dataBearing === true
    && action.requiresConfirm === true
  ) {
    return authority(action, 'provider-resource.retained.destroy');
  }

  if (
    action.type === 'destroy'
    && action.metadata?.operation === 'previousHostingDestroy'
    && metadataString(action, 'previousProvider') === action.resource.provider
  ) {
    const boundary = metadataString(action, 'cleanupBoundary');
    if (
      boundary === 'environment'
      && exactResource(action, 'environment')
      && metadataString(action, 'projectId')
      && metadataString(action, 'environmentId')
    ) {
      return authority(action, 'hosting.previous-environment.destroy');
    }
    if (
      boundary === 'project'
      && exactResource(action, 'project')
      && metadataString(action, 'projectId')
    ) {
      return authority(action, 'hosting.previous-project.destroy');
    }
  }

  if (
    action.metadata?.operation === HOSTING_ENVIRONMENT_ENSURE_OPERATION
    && exactResource(action, 'environment')
    && hasType(action, 'create', 'update')
  ) {
    return authority(action, 'hosting.environment.ensure');
  }
  if (
    isCloudflareDomainRegistrationAction(action)
    && exactResource(action, 'domain', 'cloudflare')
    && hasType(action, 'create', 'update')
    && (action.type !== 'create' || (action.billable === true && action.requiresConfirm === true))
    && metadataString(action, 'accountId')
  ) {
    return authority(action, 'domain.registration.mutate');
  }
  if (
    isGitHubActionsDeployAction(action)
    && exactResource(action, 'ci', 'github')
    && hasType(action, 'create', 'update')
    && action.resource.name.startsWith('deploy-branch:')
    && metadataString(action, 'repository')
  ) {
    return authority(action, 'github.ci.sync');
  }
  if (
    action.metadata?.operation === CI_CONFIGURATION_SYNC_OPERATION
    && exactResource(action, 'ci')
    && action.resource.provider === metadataString(action, 'ciProvider')
    && action.resource.name === 'configuration'
    && action.type === 'update'
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryScope')
    && metadataString(action, 'baseSha')
    && metadataString(action, 'programHash')
  ) {
    return authority(action, 'ci.configuration.sync');
  }
  if (
    action.metadata?.operation === CODE_REPOSITORY_CREATE_OPERATION
    && exactResource(action, 'repo')
    && action.type === 'create'
    && action.dataBearing === true
    && action.requiresConfirm === true
    && action.resource.provider === metadataString(action, 'codeProvider')
    && action.resource.name === metadataString(action, 'repositoryScope')
    && metadataString(action, 'repositoryConfigHash')
    && metadataString(action, 'desiredState') === 'present'
    && metadataString(action, 'management') === 'managed'
  ) {
    return authority(action, 'code.repository.create');
  }
  if (
    action.metadata?.operation === CODE_REPOSITORY_DESTROY_OPERATION
    && exactResource(action, 'repo')
    && action.type === 'destroy'
    && action.dataBearing === true
    && action.requiresConfirm === true
    && action.resource.provider === metadataString(action, 'codeProvider')
    && action.resource.name === metadataString(action, 'repositoryScope')
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryConfigHash')
    && metadataString(action, 'desiredState') === 'absent'
    && metadataString(action, 'management') === 'managed'
  ) {
    return authority(action, 'code.repository.destroy');
  }
  if (
    action.metadata?.operation === CODE_REPOSITORY_BINDING_REMOVE_OPERATION
    && exactResource(action, 'repo')
    && action.type === 'update'
    && action.resource.provider === metadataString(action, 'codeProvider')
    && action.resource.name === metadataString(action, 'repositoryScope')
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryConfigHash')
    && metadataString(action, 'desiredState') === 'absent'
  ) {
    return authority(action, 'code.repository.binding.remove');
  }
  if (
    action.metadata?.operation === CI_VARIABLE_SYNC_OPERATION
    && exactResource(action, 'secret')
    && action.resource.provider === metadataString(action, 'ciProvider')
    && hasType(action, 'create', 'update')
    && action.resource.name === `${metadataString(action, 'environmentName') ?? ''}:${metadataString(action, 'variableKey') ?? ''}`
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'environmentScope') === metadataString(action, 'environmentName')
    && metadataString(action, 'valueHash')
    && metadataString(action, 'valueSource')
  ) {
    return authority(action, 'ci.variable.sync');
  }
  if (
    action.metadata?.operation === CI_VARIABLE_DELETE_OPERATION
    && exactResource(action, 'secret')
    && action.resource.provider === metadataString(action, 'ciProvider')
    && action.type === 'destroy'
    && action.dataBearing === true
    && action.requiresConfirm === true
    && action.resource.name === `${metadataString(action, 'environmentName') ?? ''}:${metadataString(action, 'variableKey') ?? ''}`
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryScope')
    && metadataString(action, 'environmentScope')
    && metadataString(action, 'valueHash')
    && metadataString(action, 'programHash')
  ) {
    return authority(action, 'ci.variable.delete');
  }
  if (
    action.metadata?.operation === CI_BINDING_REMOVE_OPERATION
    && exactResource(action, 'ci')
    && action.resource.provider === metadataString(action, 'ciProvider')
    && action.type === 'update'
    && action.resource.name === `binding:${metadataString(action, 'environmentName') ?? ''}`
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryScope')
    && metadataString(action, 'programHash')
  ) {
    return authority(action, 'ci.binding.remove');
  }
  if (
    action.metadata?.operation === CI_APPLIED_SPEC_SYNC_OPERATION
    && exactResource(action, 'secret')
    && action.resource.provider === metadataString(action, 'ciProvider')
    && hasType(action, 'create', 'update')
    && action.resource.name === `${metadataString(action, 'environmentName') ?? ''}:${metadataString(action, 'variableKey') ?? ''}`
    && metadataString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryScope')
    && metadataString(action, 'environmentScope')
    && metadataString(action, 'valueHash')
    && metadataString(action, 'valueSource') === 'desired:deployment-contract'
    && metadataString(action, 'programHash')
  ) {
    return authority(action, 'ci.applied-spec-hash.sync');
  }
  if (
    action.metadata?.operation === GITHUB_ACTIONS_ROLLBACK_OPERATION
    && exactResource(action, 'ci', 'github')
    && action.type === 'update'
    && action.resource.name.startsWith('deploy-branch:')
    && metadataString(action, 'repository')
    && metadataString(action, 'workflow')
    && metadataString(action, 'ref')
    && /^[0-9a-f]{40}$/i.test(metadataString(action, 'targetSha') ?? '')
    && metadataPositiveInteger(action, 'targetArtifactId')
    && metadataPositiveInteger(action, 'targetWorkflowRunId')
    && metadataPositiveInteger(action, 'observedLatestWorkflowRunId')
  ) {
    return authority(action, 'github.ci.rollback');
  }
  if (
    action.metadata?.operation === GITLAB_ROLLBACK_REF_ENSURE_OPERATION
    && exactResource(action, 'repo', 'gitlab')
    && action.type === 'create'
    && action.resource.name === metadataString(action, 'rollbackRef')
    && /^hypervibe-rollback-[a-z0-9-]+-[0-9a-f]{12}-[1-9]\d*$/.test(metadataString(action, 'rollbackRef') ?? '')
    && metadataPositiveIntegerString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryScope')
    && /^[0-9a-f]{40}$/i.test(metadataString(action, 'targetSha') ?? '')
    && metadataPositiveIntegerString(action, 'targetJobId')
    && metadataString(action, 'targetArtifactId') === `${metadataString(action, 'targetJobId')}:.hypervibe-release.json`
    && metadataPositiveIntegerString(action, 'targetPipelineId')
    && metadataPositiveIntegerString(action, 'observedLatestPipelineId')
  ) {
    return authority(action, 'gitlab.rollback-ref.ensure');
  }
  if (
    action.metadata?.operation === GITLAB_CI_ROLLBACK_OPERATION
    && exactResource(action, 'ci', 'gitlab-ci')
    && action.type === 'update'
    && action.resource.name === `deploy-branch:${metadataString(action, 'environmentName') ?? ''}`
    && metadataPositiveIntegerString(action, 'repositoryId')
    && metadataString(action, 'instanceScope')
    && metadataString(action, 'repositoryScope')
    && metadataString(action, 'definition')
    && /^hypervibe-rollback-[a-z0-9-]+-[0-9a-f]{12}-[1-9]\d*$/.test(metadataString(action, 'rollbackRef') ?? '')
    && /^[0-9a-f]{40}$/i.test(metadataString(action, 'targetSha') ?? '')
    && metadataPositiveIntegerString(action, 'targetJobId')
    && metadataString(action, 'targetArtifactId') === `${metadataString(action, 'targetJobId')}:.hypervibe-release.json`
    && metadataPositiveIntegerString(action, 'targetPipelineId')
    && metadataPositiveIntegerString(action, 'observedLatestPipelineId')
    && metadataString(action, 'programHash')
  ) {
    return authority(action, 'gitlab.ci.rollback');
  }
  if (
    isGitHubActionsAppliedSpecHashAction(action)
    && exactResource(action, 'ci', 'github')
    && action.type === 'update'
    && action.resource.name === `applied-spec-hash:${metadataString(action, 'environmentName') ?? ''}`
    && metadataString(action, 'repository')
    && metadataString(action, 'desiredHash')
  ) {
    return authority(action, 'github.applied-spec-hash.sync');
  }
  if (
    isGitHubActionsReleaseAction(action)
    && exactResource(action, 'ci', 'github')
    && action.type === 'update'
    && action.resource.name === `release:${metadataString(action, 'environmentName') ?? ''}`
    && metadataString(action, 'repository')
    && metadataString(action, 'workflow')
    && metadataString(action, 'ref')
    && /^[0-9a-f]{40}$/i.test(metadataString(action, 'targetSha') ?? '')
  ) {
    return authority(action, 'github.ci.release');
  }
  if (
    isGitHubCollaborationAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
  ) {
    return authority(action, 'github.collaboration.sync');
  }
  if (
    isGitHubInfrastructureAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
    && (
      !githubInfrastructureIncludesRestoreDrill(action)
      || action.billable === true
    )
  ) {
    return authority(action, 'github.infrastructure.sync');
  }
  if (
    isGitHubOpenAISecretAction(action)
    && exactResource(action, 'secret', 'github')
    && action.type === 'update'
    && action.resource.name === OPENAI_ACTIONS_SECRET
    && metadataString(action, 'secretName') === OPENAI_ACTIONS_SECRET
    && metadataString(action, 'repository')
  ) {
    return authority(action, 'github.openai-secret.sync');
  }
  if (
    isGitHubDelegatedSecretAction(action)
    && exactResource(action, 'secret', 'github')
    && (
      (action.metadata?.operation === GITHUB_DELEGATED_SECRET_OPERATION && action.type === 'update')
      || (action.metadata?.operation === GITHUB_DELEGATED_SECRET_DESTROY_OPERATION && action.type === 'destroy')
    )
    && metadataString(action, 'repository')
    && metadataString(action, 'targetScope')
  ) {
    return authority(action, 'github.delegated-secret.sync');
  }
  if (
    isGitHubNativeSettingAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
    && (
      action.metadata?.operation !== 'githubCodeScanning'
      || action.metadata?.privateRepository === false
      || (action.billable === true && action.requiresConfirm === true)
    )
  ) {
    return authority(action, 'github.setting.sync');
  }
  if (
    isGitHubPagesAction(action)
    && exactResource(action, 'repo', 'github')
    && (
      (metadataBoolean(action, 'enabled') === true && hasType(action, 'create', 'update'))
      || (metadataBoolean(action, 'enabled') === false && action.type === 'destroy')
    )
    && action.resource.name === metadataString(action, 'repository')
  ) {
    return authority(action, 'github.pages.sync');
  }
  if (
    isGitHubPagesBindingCleanupAction(action)
    && exactResource(action, 'repo', 'github')
    && action.type === 'update'
    && action.resource.name === metadataString(action, 'repository')
    && typeof action.metadata?.observedCertificateAttempt === 'object'
    && action.metadata.observedCertificateAttempt !== null
  ) {
    return authority(action, 'github.pages-binding.cleanup');
  }
  if (
    isGitHubPagesDnsAction(action)
    && exactResource(action, 'domain', 'cloudflare')
    && (
      (metadataBoolean(action, 'enabled') === true && action.type === 'update')
      || (metadataBoolean(action, 'enabled') === false && action.type === 'destroy')
    )
    && metadataString(action, 'repository')
    && Array.isArray(action.metadata?.desiredRecords)
  ) {
    return authority(action, 'github.pages-dns.sync');
  }
  if (
    isIosAction(action)
    && exactResource(action, 'ios', 'appstoreconnect')
    && operationTypeIsValid(action)
    && iosIdentityIsValid(action)
  ) {
    return authority(action, 'appstore.mutate');
  }
  if (
    isQueueAction(action)
    && exactResource(action, 'queue')
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'queueName')
  ) {
    return authority(action, 'queue.mutate');
  }
  if (
    isMaintenanceAction(action)
    && exactResource(action, 'maintenance')
    && action.type === 'update'
    && metadataString(action, 'environmentName')
  ) {
    const operation = action.metadata?.operation;
    if (
      (operation === MAINTENANCE_OPERATIONS.edgeEnable
        || operation === MAINTENANCE_OPERATIONS.edgeDisable)
      && action.resource.provider === 'cloudflare'
      && action.resource.name === metadataString(action, 'hostname')
      && (
        operation !== MAINTENANCE_OPERATIONS.edgeEnable
        || (action.billable === true && action.requiresConfirm === true)
      )
    ) {
      return authority(action, 'maintenance.edge.mutate');
    }
    if (
      (operation === MAINTENANCE_OPERATIONS.workloadSuspend
        || operation === MAINTENANCE_OPERATIONS.workloadResume)
      && action.resource.name === metadataString(action, 'serviceName')
      && metadataString(action, 'serviceId')
      && ['web', 'worker', 'cron'].includes(metadataString(action, 'workloadKind') ?? '')
    ) {
      return authority(action, 'maintenance.workload.mutate');
    }
    if (
      operation === MAINTENANCE_OPERATIONS.databaseFence
      || operation === MAINTENANCE_OPERATIONS.databaseUnfence
    ) {
      return authority(action, 'maintenance.database-fence.mutate');
    }
    if (
      (operation === MAINTENANCE_OPERATIONS.verifyEnter
        || operation === MAINTENANCE_OPERATIONS.verifyExit)
      && action.resource.provider === 'local'
    ) {
      return authority(action, 'maintenance.verify');
    }
    return null;
  }
  if (
    isDataMigrationAction(action)
    && metadataString(action, 'migrationId')
    && metadataString(action, 'sourceEnvironment')
    && metadataString(action, 'targetEnvironment')
  ) {
    if (
      action.metadata?.operation === DATA_MIGRATION_OPERATIONS.databaseCopy
      && action.type === 'update'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && exactResource(action, 'database')
      && metadataString(action, 'engine') === action.resource.name
      && metadataString(action, 'sourceComponentId')
      && metadataString(action, 'sourceProvider')
      && metadataString(action, 'targetProvider') === action.resource.provider
      && metadataString(action, 'sourceMaintenanceFingerprint')
      && metadataString(action, 'targetMaintenanceFingerprint')
    ) {
      return authority(action, 'database.migrate');
    }
    if (
      action.metadata?.operation === DATA_MIGRATION_OPERATIONS.storageCopy
      && action.type === 'update'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && exactResource(action, 'storage')
      && metadataString(action, 'storageName') === action.resource.name
      && metadataString(action, 'sourceExternalId')
      && metadataStringRecord(action, 'sourceInstanceScope')
      && metadataString(action, 'sourceProvider')
      && metadataString(action, 'targetProvider') === action.resource.provider
      && metadataString(action, 'sourceMaintenanceFingerprint')
      && metadataString(action, 'targetMaintenanceFingerprint')
    ) {
      return authority(action, 'storage.migrate');
    }
    if (
      action.metadata?.operation === DATA_MIGRATION_OPERATIONS.databasePreviousDestroy
      && action.type === 'destroy'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && exactResource(action, 'database')
      && metadataString(action, 'previousExternalId')
    ) {
      return authority(action, 'database.migration-target.destroy');
    }
    if (
      action.metadata?.operation === DATA_MIGRATION_OPERATIONS.storagePreviousDestroy
      && action.type === 'destroy'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && exactResource(action, 'storage')
      && metadataString(action, 'previousExternalId')
    ) {
      return authority(action, 'storage.migration-target.destroy');
    }
    return null;
  }
  if (
    isStorageAction(action)
    && exactResource(action, 'storage')
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'storageName')
    && (
      action.metadata?.operation === STORAGE_OPERATIONS.ensure
      || (
        action.metadata?.operation === STORAGE_OPERATIONS.destroy
        && metadataString(action, 'externalId')
        && metadataStringRecord(action, 'instanceScope')
      )
      || Boolean(
        metadataString(action, 'serviceName')
        && (
          metadataString(action, 'serviceId')
          || (
            action.metadata?.operation === STORAGE_OPERATIONS.wire
            && metadataBoolean(action, 'serviceIdPending') === true
            && action.dependsOn?.includes(`service:${metadataString(action, 'serviceName')}`)
          )
        )
      )
    )
  ) {
    return authority(action, 'storage.mutate');
  }
  if (
    isLoadBalancerAction(action)
    && exactResource(action, 'load-balancer')
    && action.resource.name === metadataString(action, 'hostname')
    && metadataString(action, 'accountId')
    && metadataString(action, 'zoneId')
    && metadataString(action, 'configHash')
  ) {
    const operation = action.metadata?.operation;
    if (
      operation === LOAD_BALANCER_OPERATIONS.monitorEnsure
      && hasType(action, 'create', 'update')
      && action.id === 'load-balancer:monitor'
      && metadataString(action, 'externalName')
    ) {
      return authority(action, 'load-balancer.monitor.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.poolEnsure
      && hasType(action, 'create', 'update')
      && action.id === 'load-balancer:pool'
      && metadataString(action, 'externalName')
      && (metadataStringArray(action, 'services')?.length ?? 0) >= 2
      && (Boolean(action.metadata?.blockedReason) || loadBalancerOriginsArePinned(action))
      && (Boolean(action.metadata?.blockedReason) || action.billable === true)
    ) {
      return authority(action, 'load-balancer.pool.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.ensure
      && hasType(action, 'create', 'update')
      && action.id === `load-balancer:${action.resource.name}`
      && (metadataStringArray(action, 'services')?.length ?? 0) >= 2
      && (action.type !== 'create' || action.billable === true)
    ) {
      return authority(action, 'load-balancer.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.destroy
      && action.type === 'destroy'
      && action.id === `load-balancer:${action.resource.name}:destroy`
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'load-balancer.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.poolDestroy
      && action.type === 'destroy'
      && action.id === 'load-balancer:pool:destroy'
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'load-balancer.pool.mutate');
    }
    if (
      operation === LOAD_BALANCER_OPERATIONS.monitorDestroy
      && action.type === 'destroy'
      && action.id === 'load-balancer:monitor:destroy'
      && metadataString(action, 'externalId')
    ) {
      return authority(action, 'load-balancer.monitor.mutate');
    }
    return null;
  }
  if (
    isDelegatedSecretAction(action)
    && exactResource(action, 'secret')
    && action.type === 'update'
    && action.id === delegatedSecretActionId(action.resource.name)
    && Boolean(metadataString(action, 'principal'))
    && (metadataStringArray(action, 'services')?.length ?? 0) > 0
  ) {
    return authority(action, 'hosting.delegated-secret.sync');
  }
  if (
    isStripeHostingEnvSyncAction(action)
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'service')
  ) {
    return authority(action, 'stripe.hosting-env.sync');
  }
  if (
    isStripeCatalogAction(action)
    && operationTypeIsValid(action)
    && stripeCatalogIdentityIsValid(action)
  ) {
    return authority(action, 'stripe.catalog.mutate');
  }
  if (
    isStripeWebhookAction(action)
    && operationTypeIsValid(action)
    && action.resource.name === metadataString(action, 'webhookName')
  ) {
    return authority(action, 'stripe.webhook.mutate');
  }
  if (
    isHostingEnvRemovalAction(action)
    && exactResource(action, 'service')
    && action.type === 'update'
    && (metadataStringArray(action, 'keys')?.length ?? 0) > 0
  ) {
    return authority(action, 'hosting.env.remove');
  }
  if (
    isProviderNativeDeploySourceAction(action)
    && exactResource(action, 'service')
    && action.type === 'update'
    && metadataString(action, 'serviceId')
  ) {
    return authority(action, 'hosting.deploy-source.disconnect');
  }
  if (
    isCacheAction(action)
    && exactResource(action, 'cache')
    && action.resource.name === 'redis'
  ) {
    if (
      action.metadata?.operation === CACHE_OPERATIONS.retainedDestroy
      && action.type === 'destroy'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && metadataString(action, 'externalId')
      && metadataString(action, 'name')
      && metadataString(action, 'engine') === 'redis'
      && metadataStringRecord(action, 'providerScope')
    ) {
      return authority(action, 'cache.retained.destroy');
    }
    if (
      action.metadata?.operation === CACHE_OPERATIONS.ensure
      && cacheDesiredConfigIsPinned(action)
      && (
        (action.type === 'create' && action.billable === true)
        || (
          action.type === 'update'
          && (
            action.billable === true
            || Boolean(metadataString(action, 'blockedReason'))
          )
        )
      )
    ) {
      return authority(action, 'cache.provision');
    }
    if (
      action.metadata?.operation === CACHE_OPERATIONS.unwire
      && action.type === 'update'
      && metadataString(action, 'serviceName')
    ) {
      return authority(action, 'cache.env.remove');
    }
    if (
      action.metadata?.operation === CACHE_OPERATIONS.destroy
      && action.type === 'destroy'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && metadataString(action, 'externalId')
      && metadataStringRecord(action, 'providerScope')
      && metadataSha256(action, 'bindingsFingerprint')
    ) {
      return authority(action, 'cache.destroy');
    }
    return null;
  }
  if (exactResource(action, 'database')) {
    if (isDatabaseResilienceAction(action) && metadataString(action, 'primaryExternalId')) {
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure
        && action.type === 'update'
        && ['zonal', 'regional'].includes(metadataString(action, 'availability') ?? '')
      ) {
        return authority(action, 'database.availability.configure');
      }
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure
        && action.type === 'update'
        && metadataPositiveInteger(action, 'retainedBackups')
        && metadataPositiveInteger(action, 'pitrRetentionDays')
      ) {
        return authority(action, 'database.backup-policy.configure');
      }
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.replicaProvision
        && action.type === 'create'
        && action.billable === true
        && metadataString(action, 'replicaName') === action.resource.name
      ) {
        return authority(action, 'database.replica.provision');
      }
      if (
        action.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.replicaDestroy
        && action.type === 'destroy'
        && action.dataBearing === true
        && action.requiresConfirm === true
        && metadataString(action, 'replicaName') === action.resource.name
        && metadataString(action, 'replicaExternalId')
      ) {
        return authority(action, 'database.replica.destroy');
      }
      return null;
    }
    if (
      action.metadata?.operation === 'databaseSeed'
      && action.type === 'update'
      && metadataString(action, 'engine')
      && metadataString(action, 'command')
      && metadataString(action, 'commandHash')
    ) {
      return authority(action, 'database.seed');
    }
    if (action.type === 'create' && action.billable === true && !action.metadata?.operation) {
      return authority(action, 'database.provision');
    }
    if (
      action.type === 'destroy'
      && action.dataBearing === true
      && action.requiresConfirm === true
      && !action.metadata?.operation
      && metadataString(action, 'externalId')
      && metadataStringRecord(action, 'providerScope')
      && metadataSha256(action, 'bindingsFingerprint')
    ) {
      return authority(action, 'database.destroy');
    }
    if (
      action.type === 'destroy'
      && action.metadata?.operation === 'retainedDatabaseDestroy'
      && metadataString(action, 'externalId')
      && metadataStringRecord(action, 'providerScope')
      && action.dataBearing === true
      && action.requiresConfirm === true
    ) {
      return authority(action, 'database.retained.destroy');
    }
    return null;
  }
  if (exactResource(action, 'service') && action.type === 'destroy') {
    if (
      action.metadata?.operation === 'taskServiceCleanup'
      && action.id === `service:${action.resource.name}:destroy`
      && action.resource.name.startsWith('hv-task-')
      && hasServiceDeleteTarget(action)
      && metadataSha256(action, 'bindingsFingerprint')
    ) {
      return authority(action, 'hosting.task-service.destroy');
    }
    if (
      action.metadata?.operation === 'previousHostingDestroy'
      && action.id === `service:${action.resource.name}:previous-destroy`
      && metadataString(action, 'previousProvider') === action.resource.provider
      && ['services', 'project'].includes(metadataString(action, 'cleanupBoundary') ?? '')
      && metadataString(action, 'serviceId') === metadataString(action, 'externalId')
      && action.requiresConfirm === true
      && hasServiceDeleteTarget(action)
    ) {
      return authority(action, 'hosting.previous-service.destroy');
    }
    if (
      action.metadata?.operation === 'hostingServiceDestroy'
      && action.id === `service:${action.resource.name}:destroy`
      && action.requiresConfirm === true
      && hasServiceDeleteTarget(action)
      && metadataSha256(action, 'bindingsFingerprint')
    ) {
      return authority(action, 'hosting.service.destroy');
    }
    return null;
  }
  if (
    exactResource(action, 'domain')
    && hasType(action, 'create', 'update', 'replace')
    && !action.metadata?.operation
  ) {
    return authority(action, 'domain.configure');
  }
  if (
    exactResource(action, 'domain')
    && action.type === 'update'
    && action.metadata?.operation === DOMAIN_ADOPT_OPERATION
    && metadataString(action, 'providerDomainId')
    && metadataString(action, 'projectId')
    && metadataString(action, 'serviceName')
    && metadataString(action, 'serviceId')
    && metadataString(action, 'environmentId')
  ) {
    return authority(action, 'domain.configure');
  }
  if (
    exactResource(action, 'domain')
    && action.type === 'destroy'
    && action.metadata?.operation === DOMAIN_DETACH_OPERATION
    && metadataString(action, 'projectId')
    && metadataString(action, 'serviceName')
    && metadataString(action, 'serviceId')
    && metadataString(action, 'environmentId')
    && metadataString(action, 'providerDomainId')
    && metadataString(action, 'zoneId')
    && metadataStringArray(action, 'dnsRecordIds')
  ) {
    return authority(action, 'domain.configure');
  }
  if (
    exactResource(action, 'email')
    && action.metadata?.operation === EMAIL_OPERATIONS.runtimeSync
    && action.type === 'update'
    && metadataStringArray(action, 'services')
  ) return authority(action, 'email.runtime.sync');
  if (
    exactResource(action, 'email', 'sendgrid')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.authorizationEnsure
      || action.metadata?.operation === EMAIL_OPERATIONS.authorizationAdopt
      || action.metadata?.operation === EMAIL_OPERATIONS.authorizationVerify
    )
    && hasType(action, 'create', 'update')
  ) return authority(action, 'email.authorization.mutate');
  if (
    exactResource(action, 'domain', 'cloudflare')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.dnsSync
      || action.metadata?.operation === EMAIL_OPERATIONS.dnsAdopt
    )
    && action.type === 'update'
  ) return authority(action, 'email.dns.sync');
  if (
    exactResource(action, 'email', 'sendgrid')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.inboundEnsure
      || action.metadata?.operation === EMAIL_OPERATIONS.inboundAdopt
      || action.metadata?.operation === EMAIL_OPERATIONS.inboundReplace
    )
    && hasType(action, 'create', 'update', 'replace')
  ) return authority(action, 'email.inbound.mutate');
  if (
    exactResource(action, 'email', 'sendgrid')
    && (
      action.metadata?.operation === EMAIL_OPERATIONS.deliveryEventsEnsure
      || action.metadata?.operation === EMAIL_OPERATIONS.deliveryEventsAdopt
    )
    && action.id === 'email:sendgrid:delivery-events'
    && hasType(action, 'update', 'replace')
  ) return authority(action, 'email.delivery-events.mutate');
  if (action.resource.provider === 'cloudflare') {
    const forwardingOperation = action.metadata?.operation;
    const forwardingTypeIsValid =
      ((forwardingOperation === EMAIL_OPERATIONS.forwardingDnsEnsure
        || forwardingOperation === EMAIL_OPERATIONS.forwardingDnsAdopt
        || forwardingOperation === EMAIL_OPERATIONS.forwardingDestinationAdopt
        || forwardingOperation === EMAIL_OPERATIONS.forwardingRuleAdopt
        || forwardingOperation === EMAIL_OPERATIONS.forwardingCatchAllEnsure
        || forwardingOperation === EMAIL_OPERATIONS.forwardingCatchAllAdopt)
        && action.type === 'update')
      || ((forwardingOperation === EMAIL_OPERATIONS.forwardingDestinationEnsure
        || forwardingOperation === EMAIL_OPERATIONS.forwardingRuleEnsure)
        && hasType(action, 'create', 'update'))
      || (forwardingOperation === EMAIL_OPERATIONS.forwardingRuleDestroy && action.type === 'destroy');
    if (forwardingTypeIsValid) return authority(action, 'email.forwarding.mutate');
  }
  if (
    exactResource(action, 'messaging', 'twilio')
    && (
      action.metadata?.operation === MESSAGING_OPERATIONS.serviceEnsure
      || action.metadata?.operation === MESSAGING_OPERATIONS.serviceAdopt
    )
    && hasType(action, 'create', 'update')
    && metadataString(action, 'configHash')
  ) return authority(action, 'messaging.service.mutate');
  if (
    exactResource(action, 'messaging', 'twilio')
    && (
      action.metadata?.operation === MESSAGING_OPERATIONS.senderAttach
      || action.metadata?.operation === MESSAGING_OPERATIONS.senderMove
    )
    && hasType(action, 'create', 'replace')
    && metadataString(action, 'phoneNumberSid') === action.resource.name
    && metadataString(action, 'serviceName')
    && metadataString(action, 'configHash')
  ) return authority(action, 'messaging.sender.mutate');
  if (
    exactResource(action, 'messaging')
    && action.metadata?.operation === MESSAGING_OPERATIONS.runtimeSync
    && action.type === 'update'
    && metadataString(action, 'configHash')
    && metadataStringArray(action, 'services')
  ) return authority(action, 'messaging.runtime.sync');
  if (
    exactResource(action, 'environment')
    && hasType(action, 'create', 'update')
    && !action.metadata?.operation
  ) {
    return authority(action, 'local.environment.record');
  }
  if (
    exactResource(action, 'project')
    && hasType(action, 'create', 'update')
    && !action.metadata?.operation
  ) {
    return authority(action, 'hosting.project.ensure');
  }
  if (
    exactResource(action, 'service')
    && ['create', 'update', 'replace'].includes(action.type)
    && !action.metadata?.operation
  ) {
    return authority(action, 'hosting.service.converge');
  }
  if (
    exactResource(action, 'service')
    && action.type === 'update'
    && action.metadata?.operation === 'rollbackRedeploy'
    && metadataString(action, 'fromRunId')
  ) {
    return authority(action, 'hosting.service.rollback');
  }
  return null;
}
