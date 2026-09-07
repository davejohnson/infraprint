import { describe, expect, it } from 'vitest';
import type { PlanAction, PlanActionType, PlanResourceKind } from '../../domain/plan/plan.types.js';
import { HOSTING_ENVIRONMENT_ENSURE_OPERATION } from '../../domain/plan/plan.service.js';
import { APPLIED_SPEC_HASH_OPERATION } from '../../domain/services/deployment-contract.service.js';
import {
  GITHUB_INFRASTRUCTURE_ACTION_ID,
  GITHUB_INFRASTRUCTURE_OPERATION,
  GITHUB_OPENAI_SECRET_ACTION_ID,
  OPENAI_ACTIONS_SECRET,
} from '../../domain/services/github-infrastructure.service.js';
import {
  GITHUB_PAGES_ACTION_ID,
  GITHUB_PAGES_BINDING_CLEANUP_OPERATION,
  GITHUB_PAGES_DNS_OPERATION,
  GITHUB_PAGES_OPERATION,
} from '../../domain/services/github-pages.service.js';
import { IOS_OPERATIONS } from '../../domain/services/appstore-plan.service.js';
import { QUEUE_OPERATIONS } from '../../domain/services/queue-plan.service.js';
import { STORAGE_OPERATIONS } from '../../domain/services/storage-plan.service.js';
import {
  DELEGATED_SECRET_OPERATION,
  delegatedSecretActionId,
} from '../../domain/services/delegated-secret.service.js';
import {
  STRIPE_CATALOG_OPERATIONS,
  STRIPE_HOSTING_ENV_SYNC_OPERATION,
  STRIPE_WEBHOOK_OPERATIONS,
} from '../../domain/services/stripe-env.service.js';
import { HOSTING_ENV_REMOVE_OPERATION } from '../../domain/services/hosting-env.service.js';
import { PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION } from '../../domain/services/provider-native-deploy-source.service.js';
import { CACHE_OPERATIONS } from '../../domain/services/cache-plan.service.js';
import {
  GITHUB_ACTIONS_ROLLBACK_OPERATION,
  GITLAB_CI_ROLLBACK_OPERATION,
  GITLAB_ROLLBACK_REF_ENSURE_OPERATION,
} from '../../domain/services/ci-rollback.contract.js';
import { DATABASE_RESILIENCE_OPERATIONS } from '../../domain/services/database-resilience-plan.service.js';
import { LOAD_BALANCER_OPERATIONS } from '../../domain/services/load-balancer-plan.service.js';
import { MAINTENANCE_OPERATIONS } from '../../domain/services/maintenance-plan.service.js';
import { MESSAGING_OPERATIONS } from '../../domain/services/twilio-messaging.service.js';
import { DOMAIN_DETACH_OPERATION } from '../../domain/services/domain-attach-policy.js';
import {
  resolvePlanActionAuthority,
  type PlanMutationCapability,
} from '../../domain/plan/action-authority.js';
import {
  CI_APPLIED_SPEC_SYNC_OPERATION,
  CI_BINDING_REMOVE_OPERATION,
  CI_CONFIGURATION_SYNC_OPERATION,
  CI_VARIABLE_DELETE_OPERATION,
  CI_VARIABLE_SYNC_OPERATION,
} from '../../domain/services/managed-ci.contract.js';
import {
  CODE_REPOSITORY_BINDING_REMOVE_OPERATION,
  CODE_REPOSITORY_CREATE_OPERATION,
  CODE_REPOSITORY_DESTROY_OPERATION,
} from '../../domain/services/managed-code-repository.contract.js';

function action(params: {
  id?: string;
  type?: PlanActionType;
  kind?: PlanResourceKind;
  name?: string;
  provider?: string;
  operation?: string;
  metadata?: Record<string, unknown>;
  billable?: boolean;
  dataBearing?: boolean;
  requiresConfirm?: boolean;
} = {}): PlanAction {
  return {
    id: params.id ?? 'service:web',
    type: params.type ?? 'update',
    resource: {
      kind: params.kind ?? 'service',
      name: params.name ?? 'web',
      provider: params.provider ?? 'railway',
    },
    verified: true,
    reason: 'contract fixture',
    ...(params.billable ? { billable: true } : {}),
    ...(params.dataBearing ? { dataBearing: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    ...(
      params.operation || params.metadata
        ? {
            metadata: {
              ...(params.operation ? { operation: params.operation } : {}),
              ...(params.metadata ?? {}),
            },
          }
        : {}
    ),
  };
}

type AuthorizedCase = {
  label: string;
  capability: PlanMutationCapability;
  action: PlanAction;
};

const authorized: AuthorizedCase[] = [
  {
    label: 'hosting environment ensure',
    capability: 'hosting.environment.ensure',
    action: action({
      id: 'environment:production',
      type: 'create',
      kind: 'environment',
      name: 'production',
      operation: HOSTING_ENVIRONMENT_ENSURE_OPERATION,
    }),
  },
  {
    label: 'Cloudflare registration',
    capability: 'domain.registration.mutate',
    action: action({
      id: 'domain:example.com:register',
      type: 'create',
      kind: 'domain',
      name: 'example.com',
      provider: 'cloudflare',
      operation: 'cloudflareRegistrarRegistration',
      billable: true,
      requiresConfirm: true,
      metadata: { accountId: 'cf-account' },
    }),
  },
  {
    label: 'GitHub Actions deploy',
    capability: 'github.ci.sync',
    action: action({
      id: 'ci:github-actions:production:deploy-branch',
      type: 'update',
      kind: 'ci',
      name: 'deploy-branch:production',
      provider: 'github',
      operation: 'githubActionsDeployBranch',
      metadata: { repository: 'owner/repo' },
    }),
  },
  {
    label: 'GitHub Actions exact-SHA rollback',
    capability: 'github.ci.rollback',
    action: action({
      id: 'ci:github-actions:production:rollback',
      type: 'update',
      kind: 'ci',
      name: 'deploy-branch:production',
      provider: 'github',
      operation: GITHUB_ACTIONS_ROLLBACK_OPERATION,
      metadata: {
        repository: 'owner/repo',
        workflow: '.github/workflows/deploy-railway-production.yml',
        ref: 'main',
        targetSha: 'a'.repeat(40),
        targetArtifactId: 17,
        targetWorkflowRunId: 27,
        observedLatestWorkflowRunId: 37,
      },
    }),
  },
  {
    label: 'GitLab immutable rollback ref',
    capability: 'gitlab.rollback-ref.ensure',
    action: action({
      id: 'repo:gitlab:rollback-ref:hypervibe-rollback-production-aaaaaaaaaaaa-17',
      type: 'create',
      kind: 'repo',
      name: 'hypervibe-rollback-production-aaaaaaaaaaaa-17',
      provider: 'gitlab',
      operation: GITLAB_ROLLBACK_REF_ENSURE_OPERATION,
      metadata: {
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
        repositoryScope: 'https://gitlab.com/acme/app',
        rollbackRef: 'hypervibe-rollback-production-aaaaaaaaaaaa-17',
        targetSha: 'a'.repeat(40),
        targetArtifactId: '17:.hypervibe-release.json',
        targetJobId: '17',
        targetPipelineId: '27',
        observedLatestPipelineId: '37',
      },
    }),
  },
  {
    label: 'GitLab exact-SHA rollback dispatch',
    capability: 'gitlab.ci.rollback',
    action: action({
      id: 'ci:gitlab-ci:production:rollback',
      type: 'update',
      kind: 'ci',
      name: 'deploy-branch:production',
      provider: 'gitlab-ci',
      operation: GITLAB_CI_ROLLBACK_OPERATION,
      metadata: {
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
        repositoryScope: 'https://gitlab.com/acme/app',
        definition: '.gitlab-ci.yml',
        environmentName: 'production',
        rollbackRef: 'hypervibe-rollback-production-aaaaaaaaaaaa-17',
        targetSha: 'a'.repeat(40),
        targetArtifactId: '17:.hypervibe-release.json',
        targetJobId: '17',
        targetPipelineId: '27',
        observedLatestPipelineId: '37',
        programHash: 'b'.repeat(64),
      },
    }),
  },
  {
    label: 'GitHub Actions exact-SHA release',
    capability: 'github.ci.release',
    action: action({
      id: 'ci:github-actions:production:release',
      type: 'update',
      kind: 'ci',
      name: 'release:production',
      provider: 'github',
      operation: 'githubActionsRelease',
      metadata: {
        repository: 'owner/repo',
        environmentName: 'production',
        workflow: '.github/workflows/deploy-railway-production.yml',
        ref: 'main',
        targetSha: 'a'.repeat(40),
      },
    }),
  },
  {
    label: 'GitHub applied spec hash',
    capability: 'github.applied-spec-hash.sync',
    action: action({
      id: 'ci:github-actions:production:applied-spec-hash',
      type: 'update',
      kind: 'ci',
      name: 'applied-spec-hash:production',
      provider: 'github',
      operation: APPLIED_SPEC_HASH_OPERATION,
      metadata: { repository: 'owner/repo', environmentName: 'production', desiredHash: 'spec-hash' },
    }),
  },
  {
    label: 'provider-neutral CI configuration sync',
    capability: 'ci.configuration.sync',
    action: action({
      id: 'ci:gitlab-ci:configuration',
      type: 'update',
      kind: 'ci',
      name: 'configuration',
      provider: 'gitlab-ci',
      operation: CI_CONFIGURATION_SYNC_OPERATION,
      metadata: {
        ciProvider: 'gitlab-ci',
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
        repositoryScope: 'https://gitlab.com/acme/app',
        baseSha: 'a'.repeat(40),
        programHash: 'b'.repeat(64),
      },
    }),
  },
  {
    label: 'provider-neutral CI variable sync',
    capability: 'ci.variable.sync',
    action: action({
      id: 'ci:gitlab-ci:production:variable:RAILWAY_API_TOKEN',
      type: 'create',
      kind: 'secret',
      name: 'production:RAILWAY_API_TOKEN',
      provider: 'gitlab-ci',
      operation: CI_VARIABLE_SYNC_OPERATION,
      metadata: {
        ciProvider: 'gitlab-ci',
        repositoryId: '42',
        environmentName: 'production',
        environmentScope: 'production',
        variableKey: 'RAILWAY_API_TOKEN',
        valueHash: 'b'.repeat(64),
        valueSource: 'connection:railway.apiToken',
      },
    }),
  },
  {
    label: 'provider-neutral CI variable delete',
    capability: 'ci.variable.delete',
    action: action({
      id: 'ci:gitlab-ci:production:variable:HYPERVIBE_ABC_TOKEN:destroy',
      type: 'destroy',
      kind: 'secret',
      name: 'production:HYPERVIBE_ABC_TOKEN',
      provider: 'gitlab-ci',
      operation: CI_VARIABLE_DELETE_OPERATION,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        ciProvider: 'gitlab-ci',
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
        repositoryScope: 'https://gitlab.com/acme/app',
        environmentName: 'production',
        environmentScope: 'production',
        variableKey: 'HYPERVIBE_ABC_TOKEN',
        valueHash: 'b'.repeat(64),
        programHash: 'c'.repeat(64),
      },
    }),
  },
  {
    label: 'provider-neutral CI binding removal',
    capability: 'ci.binding.remove',
    action: action({
      id: 'ci:gitlab-ci:production:binding:remove',
      type: 'update',
      kind: 'ci',
      name: 'binding:production',
      provider: 'gitlab-ci',
      operation: CI_BINDING_REMOVE_OPERATION,
      metadata: {
        ciProvider: 'gitlab-ci',
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
        repositoryScope: 'https://gitlab.com/acme/app',
        environmentName: 'production',
        programHash: 'c'.repeat(64),
      },
    }),
  },
  {
    label: 'provider-neutral applied-spec variable sync',
    capability: 'ci.applied-spec-hash.sync',
    action: action({
      id: 'ci:gitlab-ci:production:variable:HYPERVIBE_ABC_APPLIED_SPEC_HASH',
      type: 'update',
      kind: 'secret',
      name: 'production:HYPERVIBE_ABC_APPLIED_SPEC_HASH',
      provider: 'gitlab-ci',
      operation: CI_APPLIED_SPEC_SYNC_OPERATION,
      metadata: {
        ciProvider: 'gitlab-ci',
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
        repositoryScope: 'https://gitlab.com/acme/app',
        environmentName: 'production',
        environmentScope: '*',
        variableKey: 'HYPERVIBE_ABC_APPLIED_SPEC_HASH',
        valueHash: 'b'.repeat(64),
        valueSource: 'desired:deployment-contract',
        programHash: 'c'.repeat(64),
      },
    }),
  },
  {
    label: 'GitHub collaboration',
    capability: 'github.collaboration.sync',
    action: action({
      id: 'repo:github-collaboration',
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation: 'githubCollaboration',
      metadata: { repository: 'owner/repo' },
    }),
  },
  {
    label: 'managed code repository create',
    capability: 'code.repository.create',
    action: action({
      id: 'repo:gitlab:create',
      type: 'create',
      kind: 'repo',
      name: 'https://gitlab.com/acme/app',
      provider: 'gitlab',
      operation: CODE_REPOSITORY_CREATE_OPERATION,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        codeProvider: 'gitlab',
        repositoryScope: 'https://gitlab.com/acme/app',
        repositoryConfigHash: 'a'.repeat(64),
        desiredState: 'present',
        management: 'managed',
      },
    }),
  },
  {
    label: 'managed code repository destroy',
    capability: 'code.repository.destroy',
    action: action({
      id: 'repo:gitlab:destroy',
      type: 'destroy',
      kind: 'repo',
      name: 'https://gitlab.com/acme/app',
      provider: 'gitlab',
      operation: CODE_REPOSITORY_DESTROY_OPERATION,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        codeProvider: 'gitlab',
        repositoryScope: 'https://gitlab.com/acme/app',
        repositoryConfigHash: 'a'.repeat(64),
        desiredState: 'absent',
        management: 'managed',
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
      },
    }),
  },
  {
    label: 'managed code repository binding removal',
    capability: 'code.repository.binding.remove',
    action: action({
      id: 'repo:gitlab:binding-remove',
      type: 'update',
      kind: 'repo',
      name: 'https://gitlab.com/acme/app',
      provider: 'gitlab',
      operation: CODE_REPOSITORY_BINDING_REMOVE_OPERATION,
      metadata: {
        codeProvider: 'gitlab',
        repositoryScope: 'https://gitlab.com/acme/app',
        repositoryConfigHash: 'a'.repeat(64),
        desiredState: 'absent',
        repositoryId: '42',
        instanceScope: 'https://gitlab.com',
      },
    }),
  },
  {
    label: 'GitHub infrastructure',
    capability: 'github.infrastructure.sync',
    action: action({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation: GITHUB_INFRASTRUCTURE_OPERATION,
      metadata: { repository: 'owner/repo' },
    }),
  },
  {
    label: 'GitHub Pages',
    capability: 'github.pages.sync',
    action: action({
      id: GITHUB_PAGES_ACTION_ID,
      type: 'create',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation: GITHUB_PAGES_OPERATION,
      metadata: { repository: 'owner/repo', enabled: true },
    }),
  },
  {
    label: 'GitHub Pages DNS',
    capability: 'github.pages-dns.sync',
    action: action({
      id: 'domain:example.com:github-pages-dns',
      type: 'update',
      kind: 'domain',
      name: 'example.com',
      provider: 'cloudflare',
      operation: GITHUB_PAGES_DNS_OPERATION,
      metadata: { repository: 'owner/repo', enabled: true, desiredRecords: [] },
    }),
  },
  {
    label: 'GitHub Pages local binding cleanup',
    capability: 'github.pages-binding.cleanup',
    action: action({
      id: GITHUB_PAGES_ACTION_ID,
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation: GITHUB_PAGES_BINDING_CLEANUP_OPERATION,
      metadata: {
        repository: 'owner/repo',
        observedCertificateAttempt: {
          domain: 'example.com',
          attemptedAt: '2026-08-08T00:00:00.000Z',
          mode: 'reattach',
        },
      },
    }),
  },
  {
    label: 'GitHub OpenAI secret',
    capability: 'github.openai-secret.sync',
    action: action({
      id: GITHUB_OPENAI_SECRET_ACTION_ID,
      type: 'update',
      kind: 'secret',
      name: OPENAI_ACTIONS_SECRET,
      provider: 'github',
      operation: 'githubOpenAIActionsSecret',
      metadata: { repository: 'owner/repo', secretName: OPENAI_ACTIONS_SECRET },
    }),
  },
  ...[
    ['githubSecuritySettings', 'repo:github-security-settings'],
    ['githubCodeScanning', 'repo:github-code-scanning'],
    ['githubActionsPullRequestPermission', 'repo:github-actions-pr-permission'],
    ['githubCollaborationSettings', 'repo:github-collaboration-settings'],
  ].map(([operation, id]): AuthorizedCase => ({
    label: operation,
    capability: 'github.setting.sync',
    action: action({
      id,
      type: 'update',
      kind: 'repo',
      name: 'owner/repo',
      provider: 'github',
      operation,
      billable: operation === 'githubCodeScanning',
      requiresConfirm: operation === 'githubCodeScanning',
      metadata: {
        repository: 'owner/repo',
        ...(operation === 'githubCodeScanning' ? { privateRepository: true } : {}),
      },
    }),
  })),
  ...Object.values(IOS_OPERATIONS).map((operation): AuthorizedCase => {
    const groupOperation = operation === IOS_OPERATIONS.betaGroupEnsure
      || operation === IOS_OPERATIONS.groupTestersEnsure;
    const type: PlanActionType = operation === IOS_OPERATIONS.bundleIdRegister
      || operation === IOS_OPERATIONS.appRecord
      || operation === IOS_OPERATIONS.betaGroupEnsure
      ? 'create'
      : 'update';
    return {
      label: operation,
      capability: 'appstore.mutate',
      action: action({
        id: `ios:${operation}`,
        type,
        kind: 'ios',
        name: groupOperation ? 'beta' : 'com.example.app',
        provider: 'appstoreconnect',
        operation,
        metadata: {
          bundleId: 'com.example.app',
          ...(groupOperation ? { groupName: 'beta' } : {}),
        },
      }),
    };
  }),
  {
    label: MAINTENANCE_OPERATIONS.edgeEnable,
    capability: 'maintenance.edge.mutate',
    action: action({
      id: 'maintenance:production:edge',
      type: 'update',
      kind: 'maintenance',
      name: 'app.example.com',
      provider: 'cloudflare',
      operation: MAINTENANCE_OPERATIONS.edgeEnable,
      billable: true,
      requiresConfirm: true,
      metadata: {
        environmentName: 'production',
        hostname: 'app.example.com',
      },
    }),
  },
  ...Object.values(QUEUE_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: 'queue.mutate',
    action: action({
      id: `queue:jobs${operation === QUEUE_OPERATIONS.destroy ? ':destroy' : ''}`,
      type: operation === QUEUE_OPERATIONS.destroy ? 'destroy' : 'create',
      kind: 'queue',
      name: 'jobs',
      provider: 'cloudrun',
      operation,
      dataBearing: operation === QUEUE_OPERATIONS.destroy,
      requiresConfirm: operation === QUEUE_OPERATIONS.destroy,
      metadata: {
        queueName: 'jobs',
        backend: 'pubsub',
        providerScope: { projectId: 'gcp-project' },
        ...(operation === QUEUE_OPERATIONS.destroy
          ? {
              backend: 'pubsub',
              topicName: 'projects/gcp-project/topics/jobs',
              subscriptionName: 'projects/gcp-project/subscriptions/jobs',
              providerScope: { projectId: 'gcp-project' },
            }
          : {}),
      },
    }),
  })),
  ...Object.values(STORAGE_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: 'storage.mutate',
    action: action({
      id: `storage:documents:${operation}`,
      type: operation === STORAGE_OPERATIONS.ensure
        ? 'create'
        : operation === STORAGE_OPERATIONS.destroy
          ? 'destroy'
          : 'update',
      kind: 'storage',
      name: 'documents',
      provider: 'railway',
      operation,
      billable: operation === STORAGE_OPERATIONS.ensure,
      dataBearing: operation === STORAGE_OPERATIONS.destroy,
      requiresConfirm: operation === STORAGE_OPERATIONS.destroy,
      metadata: {
        storageName: 'documents',
        ...(operation === STORAGE_OPERATIONS.destroy
          ? {
              externalId: 'bucket-1',
              instanceScope: { projectId: 'railway-project', environmentId: 'railway-environment' },
            }
          : {}),
        ...(
          operation === STORAGE_OPERATIONS.wire || operation === STORAGE_OPERATIONS.unwire
            ? { serviceName: 'web', serviceId: 'service-1' }
            : {}
        ),
      },
    }),
  })),
  ...Object.values(LOAD_BALANCER_OPERATIONS).map((operation): AuthorizedCase => {
    const monitor = operation === LOAD_BALANCER_OPERATIONS.monitorEnsure
      || operation === LOAD_BALANCER_OPERATIONS.monitorDestroy;
    const pool = operation === LOAD_BALANCER_OPERATIONS.poolEnsure
      || operation === LOAD_BALANCER_OPERATIONS.poolDestroy;
    const destroy = operation === LOAD_BALANCER_OPERATIONS.destroy
      || operation === LOAD_BALANCER_OPERATIONS.poolDestroy
      || operation === LOAD_BALANCER_OPERATIONS.monitorDestroy;
    const id = operation === LOAD_BALANCER_OPERATIONS.monitorEnsure
      ? 'load-balancer:monitor'
      : operation === LOAD_BALANCER_OPERATIONS.poolEnsure
        ? 'load-balancer:pool'
        : operation === LOAD_BALANCER_OPERATIONS.ensure
          ? 'load-balancer:app.example.com'
          : operation === LOAD_BALANCER_OPERATIONS.destroy
            ? 'load-balancer:app.example.com:destroy'
            : operation === LOAD_BALANCER_OPERATIONS.poolDestroy
              ? 'load-balancer:pool:destroy'
              : 'load-balancer:monitor:destroy';
    return {
      label: operation,
      capability: monitor
        ? 'load-balancer.monitor.mutate'
        : pool
          ? 'load-balancer.pool.mutate'
          : 'load-balancer.mutate',
      action: action({
        id,
        type: destroy ? 'destroy' : 'create',
        kind: 'load-balancer',
        name: 'app.example.com',
        provider: 'cloudflare',
        operation,
        billable: operation === LOAD_BALANCER_OPERATIONS.poolEnsure
          || operation === LOAD_BALANCER_OPERATIONS.ensure,
        metadata: {
          hostname: 'app.example.com',
          accountId: 'account-1',
          zoneId: 'zone-1',
          configHash: 'config-hash',
          ...(!destroy && monitor ? { externalName: 'monitor-name' } : {}),
          ...(!destroy && pool ? {
            externalName: 'pool-name',
            services: ['web-a', 'web-b'],
            origins: [
              { name: 'web-a', address: 'a.example', hostHeader: 'a.example', enabled: true },
              { name: 'web-b', address: 'b.example', hostHeader: 'b.example', enabled: true },
            ],
            originsHash: 'a'.repeat(64),
          } : {}),
          ...(!destroy && !monitor && !pool ? { services: ['web-a', 'web-b'] } : {}),
          ...(destroy ? { externalId: 'external-1' } : {}),
        },
      }),
    };
  }),
  {
    label: 'delegated secret sync',
    capability: 'hosting.delegated-secret.sync',
    action: action({
      id: delegatedSecretActionId('ANTHROPIC_API_KEY'),
      type: 'update',
      kind: 'secret',
      name: 'ANTHROPIC_API_KEY',
      operation: DELEGATED_SECRET_OPERATION,
      metadata: { principal: 'github:alice', services: ['web'] },
    }),
  },
  {
    label: 'GitHub delegated secret sync',
    capability: 'github.delegated-secret.sync',
    action: action({
      id: 'secret:github:repository:CI_TOKEN',
      type: 'update',
      kind: 'secret',
      name: 'CI_TOKEN',
      provider: 'github',
      operation: 'githubDelegatedSecretSync',
      metadata: { repository: 'owner/repo', targetScope: 'repository' },
    }),
  },
  {
    label: 'Stripe hosting env sync',
    capability: 'stripe.hosting-env.sync',
    action: action({
      id: 'payment:stripe:test:hosting-env:web',
      type: 'update',
      kind: 'payment',
      name: 'web',
      provider: 'stripe',
      operation: STRIPE_HOSTING_ENV_SYNC_OPERATION,
      metadata: { service: 'web' },
    }),
  },
  ...Object.values(STRIPE_CATALOG_OPERATIONS).map((operation): AuthorizedCase => {
    const price = operation.toLowerCase().includes('price');
    const adopt = operation.toLowerCase().includes('adopt');
    const archive = operation.toLowerCase().includes('archive');
    return {
      label: operation,
      capability: 'stripe.catalog.mutate',
      action: action({
        id: `payment:stripe:test:catalog:${operation}`,
        type: archive ? 'destroy' : adopt ? 'update' : 'create',
        kind: 'payment',
        name: price ? 'pro.monthly' : 'pro',
        provider: 'stripe',
        operation,
        metadata: { productKey: 'pro', ...(price ? { priceKey: 'monthly' } : {}) },
      }),
    };
  }),
  ...Object.values(STRIPE_WEBHOOK_OPERATIONS).map((operation): AuthorizedCase => ({
    label: operation,
    capability: 'stripe.webhook.mutate',
    action: action({
      id: `payment:stripe:test:webhook:billing`,
      type: operation === STRIPE_WEBHOOK_OPERATIONS.destroy
        ? 'destroy'
        : operation === STRIPE_WEBHOOK_OPERATIONS.adopt
          ? 'update'
          : 'create',
      kind: 'payment',
      name: 'billing',
      provider: 'stripe',
      operation,
      metadata: { webhookName: 'billing' },
    }),
  })),
  {
    label: 'hosting env removal',
    capability: 'hosting.env.remove',
    action: action({ operation: HOSTING_ENV_REMOVE_OPERATION, metadata: { keys: ['OLD_KEY'] } }),
  },
  {
    label: 'provider-native deploy source disconnect',
    capability: 'hosting.deploy-source.disconnect',
    action: action({ operation: PROVIDER_NATIVE_SOURCE_DISCONNECT_OPERATION, metadata: { serviceId: 'svc-1' } }),
  },
  ...Object.values(CACHE_OPERATIONS)
    .filter((operation) => operation !== CACHE_OPERATIONS.retainedDestroy)
    .map((operation): AuthorizedCase => ({
    label: operation,
    capability: operation === CACHE_OPERATIONS.ensure
      ? 'cache.provision'
      : operation === CACHE_OPERATIONS.unwire
        ? 'cache.env.remove'
        : 'cache.destroy',
    action: action({
      id: `cache:redis:${operation}`,
      type: operation === CACHE_OPERATIONS.ensure
        ? 'create'
        : operation === CACHE_OPERATIONS.unwire
          ? 'update'
          : 'destroy',
      kind: 'cache',
      name: 'redis',
      operation,
      billable: operation === CACHE_OPERATIONS.ensure,
      dataBearing: operation === CACHE_OPERATIONS.destroy,
      requiresConfirm: operation === CACHE_OPERATIONS.destroy,
      metadata: operation === CACHE_OPERATIONS.unwire
        ? { serviceName: 'web' }
        : operation === CACHE_OPERATIONS.destroy
          ? {
              externalId: 'cache-1',
              providerScope: { projectId: 'railway-project' },
              bindingsFingerprint: 'b'.repeat(64),
            }
          : {
              region: null,
              network: null,
              subnetwork: null,
              tier: null,
              size: null,
            },
    }),
  })),
  {
    label: 'retained cache destroy',
    capability: 'cache.retained.destroy',
    action: action({
      id: 'cache:memorystore:retained-destroy',
      type: 'destroy',
      kind: 'cache',
      name: 'redis',
      provider: 'memorystore',
      operation: CACHE_OPERATIONS.retainedDestroy,
      metadata: {
        externalId: 'legacy-cache',
        name: 'legacy-cache-name',
        engine: 'redis',
        providerEngine: 'redis',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      },
      dataBearing: true,
      requiresConfirm: true,
    }),
  },
  {
    label: 'database provision',
    capability: 'database.provision',
    action: action({ id: 'database:railway', type: 'create', kind: 'database', name: 'postgres', billable: true }),
  },
  {
    label: 'database availability configure',
    capability: 'database.availability.configure',
    action: action({
      id: 'database:cloudsql:availability', type: 'update', kind: 'database', name: 'postgres', provider: 'cloudsql',
      operation: DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure,
      metadata: { primaryExternalId: 'primary-1', availability: 'regional' },
    }),
  },
  {
    label: 'database backup policy configure',
    capability: 'database.backup-policy.configure',
    action: action({
      id: 'database:cloudsql:backup-policy', type: 'update', kind: 'database', name: 'postgres', provider: 'cloudsql',
      operation: DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure,
      metadata: { primaryExternalId: 'primary-1', retainedBackups: 8, pitrRetentionDays: 7 },
    }),
  },
  {
    label: 'database replica provision',
    capability: 'database.replica.provision',
    action: action({
      id: 'database:cloudsql:replica:analytics', type: 'create', kind: 'database', name: 'analytics', provider: 'cloudsql',
      operation: DATABASE_RESILIENCE_OPERATIONS.replicaProvision,
      billable: true,
      metadata: { primaryExternalId: 'primary-1', replicaName: 'analytics' },
    }),
  },
  {
    label: 'database replica destroy',
    capability: 'database.replica.destroy',
    action: action({
      id: 'database:cloudsql:replica:analytics:destroy', type: 'destroy', kind: 'database', name: 'analytics', provider: 'cloudsql',
      operation: DATABASE_RESILIENCE_OPERATIONS.replicaDestroy,
      dataBearing: true,
      requiresConfirm: true,
      metadata: { primaryExternalId: 'primary-1', replicaName: 'analytics', replicaExternalId: 'replica-1' },
    }),
  },
  {
    label: 'database seed',
    capability: 'database.seed',
    action: action({
      id: 'database:railway:seed',
      type: 'update',
      kind: 'database',
      name: 'seed',
      operation: 'databaseSeed',
      metadata: { engine: 'postgres', command: 'npm run seed', commandHash: 'command-hash' },
    }),
  },
  {
    label: 'database destroy',
    capability: 'database.destroy',
    action: action({
      id: 'database:railway:destroy', type: 'destroy', kind: 'database', name: 'postgres',
      dataBearing: true, requiresConfirm: true,
      metadata: {
        externalId: 'database-1',
        providerScope: { projectId: 'railway-project', environmentId: 'railway-environment' },
        bindingsFingerprint: 'a'.repeat(64),
      },
    }),
  },
  {
    label: 'retained database destroy',
    capability: 'database.retained.destroy',
    action: action({
      id: 'database:cloudsql:retained-destroy',
      type: 'destroy',
      kind: 'database',
      name: 'postgres',
      provider: 'cloudsql',
      operation: 'retainedDatabaseDestroy',
      metadata: { externalId: 'legacy-db', providerScope: { projectId: 'gcp-project', region: 'us-west1' } },
      dataBearing: true,
      requiresConfirm: true,
    }),
  },
  {
    label: 'retained provider resource destroy',
    capability: 'provider-resource.retained.destroy',
    action: action({
      id: 'retained-resource:cloudsql:backup:destroy',
      type: 'destroy',
      kind: 'retained-resource',
      name: 'backup',
      provider: 'cloudsql',
      operation: 'retainedResourceDestroy',
      metadata: {
        resource: 'backup',
        externalId: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        providerScope: { projectId: 'gcp-project' },
      },
      dataBearing: true,
      requiresConfirm: true,
    }),
  },
  {
    label: 'task service destroy',
    capability: 'hosting.task-service.destroy',
    action: action({ type: 'destroy', operation: 'taskServiceCleanup', metadata: { externalId: 'task-1' } }),
  },
  {
    label: 'previous provider service destroy',
    capability: 'hosting.previous-service.destroy',
    action: action({ type: 'destroy', operation: 'previousHostingDestroy', metadata: { cleanupBoundary: 'services', previousProvider: 'railway' } }),
  },
  {
    label: 'previous provider environment destroy',
    capability: 'hosting.previous-environment.destroy',
    action: action({
      id: 'environment:production:railway:previous-destroy',
      type: 'destroy',
      kind: 'environment',
      name: 'production',
      operation: 'previousHostingDestroy',
      metadata: { cleanupBoundary: 'environment', previousProvider: 'railway', projectId: 'project-1', environmentId: 'environment-1' },
    }),
  },
  {
    label: 'previous provider project destroy',
    capability: 'hosting.previous-project.destroy',
    action: action({
      id: 'project:ecs:previous-destroy',
      type: 'destroy',
      kind: 'project',
      name: 'production',
      provider: 'ecs',
      operation: 'previousHostingDestroy',
      metadata: { cleanupBoundary: 'project', previousProvider: 'ecs', projectId: 'project-1' },
    }),
  },
  {
    label: 'hosting service destroy',
    capability: 'hosting.service.destroy',
    action: action({ type: 'destroy', metadata: { externalId: 'service-1' } }),
  },
  {
    label: 'custom domain configure',
    capability: 'domain.configure',
    action: action({ id: 'domain:example.com', kind: 'domain', name: 'example.com' }),
  },
  {
    label: 'custom domain adopt',
    capability: 'domain.configure',
    action: action({
      id: 'domain:example.com',
      kind: 'domain',
      name: 'example.com',
      operation: 'customDomainAdopt',
      metadata: {
        providerDomainId: 'domain-1',
        projectId: 'project-1',
        serviceName: 'web',
        serviceId: 'service-1',
        environmentId: 'environment-1',
      },
    }),
  },
  {
    label: 'custom domain detach',
    capability: 'domain.configure',
    action: action({
      id: 'domain:example.com',
      type: 'destroy',
      kind: 'domain',
      name: 'example.com',
      operation: DOMAIN_DETACH_OPERATION,
      metadata: {
        projectId: 'project-1',
        serviceName: 'web',
        serviceId: 'service-1',
        environmentId: 'environment-1',
        providerDomainId: 'domain-1',
        zoneId: 'zone-1',
        dnsRecordIds: ['record-1'],
      },
    }),
  },
  {
    label: 'email runtime sync',
    capability: 'email.runtime.sync',
    action: action({
      id: 'email:runtime',
      kind: 'email',
      name: 'production',
      provider: 'railway',
      operation: 'emailRuntimeSync',
      metadata: { services: ['web'] },
    }),
  },
  {
    label: 'email authorization mutate',
    capability: 'email.authorization.mutate',
    action: action({
      id: 'email:sendgrid:authorization',
      kind: 'email',
      name: 'example.com',
      provider: 'sendgrid',
      operation: 'emailAuthorizationEnsure',
    }),
  },
  {
    label: 'email dns sync',
    capability: 'email.dns.sync',
    action: action({
      id: 'email:cloudflare:dns',
      kind: 'domain',
      name: 'example.com',
      provider: 'cloudflare',
      operation: 'emailDnsSync',
    }),
  },
  {
    label: 'email inbound mutate',
    capability: 'email.inbound.mutate',
    action: action({
      id: 'email:sendgrid:inbound:inbound.example.com',
      type: 'create',
      kind: 'email',
      name: 'inbound.example.com',
      provider: 'sendgrid',
      operation: 'emailInboundEnsure',
    }),
  },
  {
    label: 'email delivery events mutate',
    capability: 'email.delivery-events.mutate',
    action: action({
      id: 'email:sendgrid:delivery-events',
      kind: 'email',
      name: 'delivery-events',
      provider: 'sendgrid',
      operation: 'emailDeliveryEventsEnsure',
    }),
  },
  {
    label: 'email forwarding mutate',
    capability: 'email.forwarding.mutate',
    action: action({
      id: 'email:cloudflare:destination:owner@example.net',
      type: 'create',
      kind: 'email',
      name: 'owner@example.net',
      provider: 'cloudflare',
      operation: 'emailForwardingDestinationEnsure',
    }),
  },
  {
    label: 'Twilio Messaging Service mutate',
    capability: 'messaging.service.mutate',
    action: action({
      id: 'messaging:twilio:service',
      type: 'create',
      kind: 'messaging',
      name: 'app-production',
      provider: 'twilio',
      operation: MESSAGING_OPERATIONS.serviceEnsure,
      metadata: { configHash: 'service-config' },
    }),
  },
  {
    label: 'Twilio sender mutate',
    capability: 'messaging.sender.mutate',
    action: action({
      id: `messaging:twilio:sender:PN${'a'.repeat(32)}`,
      type: 'create',
      kind: 'messaging',
      name: `PN${'a'.repeat(32)}`,
      provider: 'twilio',
      operation: MESSAGING_OPERATIONS.senderAttach,
      metadata: {
        configHash: 'service-config',
        phoneNumberSid: `PN${'a'.repeat(32)}`,
        serviceName: 'app-production',
      },
    }),
  },
  {
    label: 'Twilio runtime sync',
    capability: 'messaging.runtime.sync',
    action: action({
      id: 'messaging:twilio:runtime',
      kind: 'messaging',
      name: 'production',
      provider: 'railway',
      operation: MESSAGING_OPERATIONS.runtimeSync,
      metadata: { configHash: 'runtime-config', services: ['web'] },
    }),
  },
  {
    label: 'local environment record',
    capability: 'local.environment.record',
    action: action({ id: 'environment:production', type: 'create', kind: 'environment', name: 'production' }),
  },
  {
    label: 'hosting project ensure',
    capability: 'hosting.project.ensure',
    action: action({ id: 'project:railway', type: 'create', kind: 'project', name: 'production' }),
  },
  {
    label: 'hosting service converge',
    capability: 'hosting.service.converge',
    action: action({ type: 'replace' }),
  },
  {
    label: 'hosting service rollback',
    capability: 'hosting.service.rollback',
    action: action({
      id: 'service:web:rollback',
      type: 'update',
      operation: 'rollbackRedeploy',
      metadata: { fromRunId: 'deploy-run-1' },
    }),
  },
];

describe('plan action mutation-authority contract', () => {
  it.each(authorized)('authorizes exactly one capability for $label', ({ action: candidate, capability }) => {
    expect(resolvePlanActionAuthority(candidate)).toEqual({
      actionId: candidate.id,
      capability,
      ...(candidate.metadata?.operation ? { operation: candidate.metadata.operation } : {}),
      resource: candidate.resource,
    });
  });

  it.each(authorized.filter(({ capability, action: candidate }) =>
    candidate.metadata?.operation && !capability.startsWith('database.')
  ))(
    'rejects $label when its operation is attached to a database resource',
    ({ action: candidate }) => {
      expect(resolvePlanActionAuthority({
        ...candidate,
        resource: { kind: 'database', name: 'postgres', provider: candidate.resource.provider },
      })).toBeNull();
    }
  );

  it.each([
    ['queue metadata name', authorized.find((entry) => entry.label === QUEUE_OPERATIONS.ensure)!.action, { queueName: 'other' }],
    ['storage metadata name', authorized.find((entry) => entry.label === STORAGE_OPERATIONS.ensure)!.action, { storageName: 'other' }],
    ['load-balancer hostname', authorized.find((entry) => entry.label === LOAD_BALANCER_OPERATIONS.ensure)!.action, { hostname: 'other.example.com' }],
    ['GitHub repository', authorized.find((entry) => entry.label === 'GitHub infrastructure')!.action, { repository: 'other/repo' }],
    ['Stripe service', authorized.find((entry) => entry.label === 'Stripe hosting env sync')!.action, { service: 'worker' }],
    ['iOS bundle id', authorized.find((entry) => entry.label === IOS_OPERATIONS.bundleIdRegister)!.action, { bundleId: 'com.other.app' }],
  ])('rejects mismatched %s identity metadata', (_label, candidate, metadataPatch) => {
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, ...metadataPatch },
    })).toBeNull();
  });

  it.each(authorized.filter(({ action: candidate }) => candidate.metadata?.operation))(
    'rejects an incompatible action type for $label',
    ({ action: candidate }) => {
      const invalidType: PlanActionType = candidate.type === 'destroy' ? 'create' : 'destroy';
      expect(resolvePlanActionAuthority({ ...candidate, type: invalidType })).toBeNull();
    }
  );

  it('rejects a load-balancer operation under a different action id', () => {
    const candidate = authorized.find((entry) => entry.label === LOAD_BALANCER_OPERATIONS.ensure)!.action;
    expect(resolvePlanActionAuthority({ ...candidate, id: 'load-balancer:other.example.com' })).toBeNull();
  });

  it('rejects retained database deletion without a complete non-empty provider scope', () => {
    const candidate = authorized.find((entry) => entry.label === 'retained database destroy')!.action;
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: {} },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: { projectId: '' } },
    })).toBeNull();
  });

  it('rejects retained cache deletion without its exact identity and complete non-empty provider scope', () => {
    const candidate = authorized.find((entry) => entry.label === 'retained cache destroy')!.action;
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, name: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: {} },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: { projectId: '   ' } },
    })).toBeNull();
  });

  it('rejects database deletion without its exact provider id and non-empty provider scope', () => {
    const candidate = authorized.find((entry) => entry.label === 'database destroy')!.action;
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, externalId: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: null },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: { projectId: '' } },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, bindingsFingerprint: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, bindingsFingerprint: 'not-a-sha256' },
    })).toBeNull();
  });

  it('rejects hosting service deletion without an exact provider target', () => {
    const candidate = authorized.find((entry) => entry.label === 'hosting service destroy')!.action;
    expect(resolvePlanActionAuthority({ ...candidate, metadata: undefined })).toBeNull();
    expect(resolvePlanActionAuthority({ ...candidate, metadata: { externalId: '' } })).toBeNull();
  });

  it('rejects storage deletion without its exact provider id and instance scope', () => {
    const candidate = authorized.find((entry) => entry.label === STORAGE_OPERATIONS.destroy)!.action;
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, externalId: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, instanceScope: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, instanceScope: { projectId: '' } },
    })).toBeNull();
  });

  it.each([STORAGE_OPERATIONS.wire, STORAGE_OPERATIONS.unwire])(
    'rejects stale storage service mutation without a pinned service id for %s',
    (label) => {
      const candidate = authorized.find((entry) => entry.label === label)!.action;
      expect(resolvePlanActionAuthority({
        ...candidate,
        metadata: { ...candidate.metadata, serviceId: undefined },
      })).toBeNull();
    }
  );

  it('allows create-then-wire only with an explicit service dependency', () => {
    const candidate = authorized.find((entry) => entry.label === STORAGE_OPERATIONS.wire)!.action;
    const pending: PlanAction = {
      ...candidate,
      dependsOn: ['storage:documents', 'service:web'],
      metadata: { ...candidate.metadata, serviceId: undefined, serviceIdPending: true },
    };
    expect(resolvePlanActionAuthority(pending)).toMatchObject({ capability: 'storage.mutate' });
    expect(resolvePlanActionAuthority({ ...pending, dependsOn: ['storage:documents'] })).toBeNull();
  });

  it('rejects cache deletion without its exact provider id and non-empty provider scope', () => {
    const candidate = authorized.find((entry) => entry.label === CACHE_OPERATIONS.destroy)!.action;
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, externalId: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, providerScope: null },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, bindingsFingerprint: undefined },
    })).toBeNull();
    expect(resolvePlanActionAuthority({
      ...candidate,
      metadata: { ...candidate.metadata, bindingsFingerprint: 'not-a-sha256' },
    })).toBeNull();
  });

  it('pins Pub/Sub queue deletion identity while allowing local postgres binding cleanup', () => {
    const candidate = authorized.find((entry) => entry.label === QUEUE_OPERATIONS.destroy)!.action;
    for (const key of ['topicName', 'subscriptionName', 'providerScope'] as const) {
      expect(resolvePlanActionAuthority({
        ...candidate,
        metadata: { ...candidate.metadata, [key]: undefined },
      })).toBeNull();
    }
    expect(resolvePlanActionAuthority({
      ...candidate,
      dataBearing: undefined,
      requiresConfirm: undefined,
      metadata: { queueName: 'jobs', backend: 'postgres', operation: QUEUE_OPERATIONS.destroy },
    })).toMatchObject({ capability: 'queue.mutate' });
  });

  it('rejects a queue ensure action that the planner marked blocked', () => {
    const candidate = authorized.find((entry) => entry.label === QUEUE_OPERATIONS.ensure)!.action;
    expect(resolvePlanActionAuthority({
      ...candidate,
      type: 'update',
      metadata: { ...candidate.metadata, blockedReason: 'queue_observation_unknown' },
    })).toBeNull();
  });

  it('authorizes exact desired cache reconciliation and rejects unpinned config', () => {
    const create = authorized.find((entry) => entry.label === CACHE_OPERATIONS.ensure)!.action;
    const update: PlanAction = { ...create, type: 'update', billable: true };
    expect(resolvePlanActionAuthority(update)).toMatchObject({ capability: 'cache.provision' });

    const metadata = { ...update.metadata };
    delete metadata.size;
    expect(resolvePlanActionAuthority({ ...update, metadata })).toBeNull();
  });

  it('rejects a domain purchase whose billing confirmation flags were stripped', () => {
    const candidate = authorized.find((entry) => entry.label === 'Cloudflare registration')!.action;
    expect(resolvePlanActionAuthority({ ...candidate, billable: undefined })).toBeNull();
    expect(resolvePlanActionAuthority({ ...candidate, requiresConfirm: undefined })).toBeNull();
  });

  it('rejects maintenance edge enablement whose billing confirmation flags were stripped', () => {
    const candidate = authorized.find((entry) => entry.label === MAINTENANCE_OPERATIONS.edgeEnable)!.action;
    expect(resolvePlanActionAuthority({ ...candidate, billable: undefined })).toBeNull();
    expect(resolvePlanActionAuthority({ ...candidate, requiresConfirm: undefined })).toBeNull();
  });

  it.each([
    LOAD_BALANCER_OPERATIONS.poolEnsure,
    LOAD_BALANCER_OPERATIONS.ensure,
  ])('rejects billable load-balancer mutation with a stripped billing flag for %s', (label) => {
    const candidate = authorized.find((entry) => entry.label === label)!.action;
    expect(resolvePlanActionAuthority({ ...candidate, billable: undefined })).toBeNull();
  });

  it('rejects private GitHub code scanning when billing confirmation is stripped', () => {
    const candidate = authorized.find((entry) => entry.label === 'githubCodeScanning')!.action;
    expect(resolvePlanActionAuthority({ ...candidate, billable: undefined })).toBeNull();
    expect(resolvePlanActionAuthority({ ...candidate, requiresConfirm: undefined })).toBeNull();
  });

  it('rejects restore-drill infrastructure changes when billing metadata is stripped', () => {
    const candidate = authorized.find((entry) => entry.label === 'GitHub infrastructure')!.action;
    const restoreDrillAction: PlanAction = {
      ...candidate,
      billable: true,
      diff: [{ field: 'file:.github/workflows/hypervibe-db-restore-drill-production.yml' }],
      metadata: {
        ...candidate.metadata,
        desiredFiles: [{ path: '.github/workflows/hypervibe-db-restore-drill-production.yml' }],
      },
    };
    expect(resolvePlanActionAuthority(restoreDrillAction)).not.toBeNull();
    expect(resolvePlanActionAuthority({ ...restoreDrillAction, billable: undefined })).toBeNull();
  });

  it.each([
    'database provision',
    CACHE_OPERATIONS.ensure,
    STORAGE_OPERATIONS.ensure,
    'database replica provision',
  ])('rejects billable data-resource creation when its safety flag is stripped from %s', (label) => {
    const candidate = authorized.find((entry) => entry.label === label)!.action;
    expect(resolvePlanActionAuthority({ ...candidate, billable: undefined })).toBeNull();
  });

  it.each([
    'database destroy',
    CACHE_OPERATIONS.destroy,
    'retained cache destroy',
    STORAGE_OPERATIONS.destroy,
    'database replica destroy',
    QUEUE_OPERATIONS.destroy,
  ])('rejects data-resource destruction when confirmation metadata is stripped from %s', (label) => {
    const candidate = authorized.find((entry) => entry.label === label)!.action;
    expect(resolvePlanActionAuthority({ ...candidate, dataBearing: undefined })).toBeNull();
    expect(resolvePlanActionAuthority({ ...candidate, requiresConfirm: undefined })).toBeNull();
  });

  it('grants no mutation authority to noop or unknown actions', () => {
    expect(resolvePlanActionAuthority(action({ type: 'noop' }))).toBeNull();
    expect(resolvePlanActionAuthority(action({ operation: 'unknownMutation' }))).toBeNull();
  });
});
