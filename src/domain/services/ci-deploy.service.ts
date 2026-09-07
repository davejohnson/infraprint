import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { githubPackagePullCredentials } from '../../adapters/providers/github/package-pull.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import type { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import {
  buildBranchDeployWorkflow,
  getGitHubAdapter,
  resolveBranchDeployTargets,
  type BranchDeployWorkflow,
} from './github-ops.service.js';
import {
  IOS_RELEASE_REQUIRED_SECRETS,
  MATCH_SIGNING_REQUIRED_SECRETS,
} from './ios-release-workflow.service.js';
import { getVerifiedAppStoreConnectCredentials } from './appstore-ops.service.js';
import {
  compileManagedGitHubFiles,
  proposeGitHubInfrastructureFiles,
  resolveGitHubInfrastructureRepository,
  shouldPlanGitHubInfrastructure,
} from './github-infrastructure.service.js';
import { formatConnectionGuidance, GITHUB_TOKEN_URLS } from './connection-guidance.js';
import { resolveExternalDatabaseUrl } from './database-ops.service.js';
import {
  APPLIED_SPEC_HASH_OPERATION,
  APPLIED_SPEC_HASH_VARIABLE,
  environmentDeploymentContractHashForApply,
} from './deployment-contract.service.js';

const OPERATION = 'githubActionsDeployBranch';
export const GITHUB_ACTIONS_RELEASE_OPERATION = 'githubActionsRelease';
const GITHUB_CI_REQUIRED_CLASSIC_SCOPES = ['repo', 'workflow'];
const RELEASE_WAIT_TIMEOUT_MS = 30 * 60_000;
const RELEASE_POLL_INTERVAL_MS = 3_000;

export function requiredProviderSecretNamesForGitHubActions(provider: string): string[] {
  const ci = providerRegistry.getMetadata(provider)?.orchestration?.ci;
  const names = [...(ci?.requiredSecrets ?? [])];
  if (ci?.requiresGitHubPackagePull) {
    names.push('IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN');
  }
  return Array.from(new Set(names));
}

export function missingProviderSecretsMessage(provider: string, missingProviderSecrets: string[]): string {
  const parts = [`Missing provider secrets: ${missingProviderSecrets.join(', ')}.`];
  const missingImageRegistrySecrets = missingProviderSecrets.some((name) => name.startsWith('IMAGE_REGISTRY_'));
  const missingProviderApiSecrets = missingProviderSecrets.some((name) => !name.startsWith('IMAGE_REGISTRY_'));
  if (missingProviderApiSecrets) {
    parts.push(`Connect and verify ${provider} so Hypervibe can sync its API credentials into GitHub Actions. ${formatConnectionGuidance(provider)}`);
  }
  if (missingImageRegistrySecrets) {
    const displayName = providerRegistry.getMetadata(provider)?.displayName ?? provider;
    parts.push(`For ${displayName} GHCR image pulls, reconnect GitHub with both GitHub API and package-read credentials (create the read:packages PAT here: ${GITHUB_TOKEN_URLS.packageRead}). The GitHub apiToken needs repo + workflow for workflow/secrets management; packageReadToken needs read:packages for durable package/image pulls. ${formatConnectionGuidance('github', { intro: 'Confirm the GitHub token type and CI deploy permissions.' })}`);
  }
  return parts.join(' ');
}

export function githubCiDeployPermissionProblem(
  verification: { scopes?: string[] },
  options: { repo?: string } = {}
): { missingScopes: string[]; hint: string } | null {
  // GitHub exposes x-oauth-scopes for classic PATs. Fine-grained PATs may not
  // report classic scopes here, so only enforce when the scope header exists.
  if (!verification.scopes?.length) {
    return null;
  }
  const scopes = new Set(verification.scopes);
  const missingScopes = GITHUB_CI_REQUIRED_CLASSIC_SCOPES.filter((scope) => !scopes.has(scope));
  if (missingScopes.length === 0) {
    return null;
  }
  return {
    missingScopes,
    hint: [
      `The GitHub apiToken is verified but missing classic PAT scope(s): ${missingScopes.join(', ')}.`,
      'A read:packages-only token is only enough for GHCR image pulls; it cannot create/update deploy workflows or repository secrets.',
      formatConnectionGuidance('github', {
        scope: options.repo,
        intro: 'Reconnect GitHub with CI deploy permissions.',
      }),
    ].join(' '),
  };
}

const connectionRepo = new ConnectionRepository();

type ProviderSecret = { name: string; value: string };
type WorkflowCiBinding = {
  contentHash?: string;
  syncedSecrets?: string[];
  syncedSecretHashes?: Record<string, string>;
  syncedEnvironmentSecrets?: string[];
  syncedEnvironmentSecretHashes?: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function environmentUsesGitHubActionsDeploy(environmentSpec: EnvironmentSpec): boolean {
  return environmentSpec.deploy?.strategy === 'branch' && (environmentSpec.deploy.trigger ?? 'ci') === 'ci';
}

export function isGitHubActionsDeployAction(action: PlanAction): boolean {
  return action.metadata?.operation === OPERATION;
}

export function isGitHubActionsAppliedSpecHashAction(action: PlanAction): boolean {
  return action.metadata?.operation === APPLIED_SPEC_HASH_OPERATION;
}

export function providerSecretsForGitHubActions(
  provider: string,
  options: { githubLogin?: string; githubRepo?: string } = {}
): ProviderSecret[] {
  const secrets: ProviderSecret[] = [];
  const connection = connectionRepo.findBestVerifiedMatch(provider);
  const ci = providerRegistry.getMetadata(provider)?.orchestration?.ci;

  if (connection) {
    const credentials = getSecretStore().decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
    for (const name of ci?.requiredSecrets ?? []) {
      const credentialKey = ci?.secretCredentialKeys?.[name];
      if (!credentialKey) continue;
      const value = credentials[credentialKey];
      if (typeof value === 'string' && value.length > 0) {
        secrets.push({ name, value });
      }
    }
  }

  if (ci?.requiresGitHubPackagePull) {
    const pull = githubPackagePullCredentials({ githubRepo: options.githubRepo, githubLogin: options.githubLogin });
    if (pull) {
      secrets.push(
        { name: 'IMAGE_REGISTRY_USERNAME', value: pull.username },
        { name: 'IMAGE_REGISTRY_TOKEN', value: pull.token }
      );
    }
  }

  return secrets;
}

/**
 * The managed database's externally reachable URL as a GitHub Actions
 * secret, when the environment has one — lets the generated migration
 * step run without a manually configured DATABASE_URL.
 */
export async function databaseUrlSecretForGitHubActions(
  project: Project,
  environmentName: string
): Promise<ProviderSecret | null> {
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return null;
  const url = await resolveExternalDatabaseUrl(project, environment);
  return url ? { name: 'DATABASE_URL', value: url } : null;
}

function ciBindings(environment: Environment | null): Record<string, WorkflowCiBinding> {
  const ci = asRecord(environment?.platformBindings?.ci);
  return asRecord(ci?.deployBranch) as Record<string, WorkflowCiBinding> | null ?? {};
}

function secretHashes(secrets: ProviderSecret[]): Record<string, string> {
  return Object.fromEntries(secrets.map((secret) => [secret.name, sha256(secret.value)]));
}

function workflowFiles(workflow: BranchDeployWorkflow): Array<{ path: string; content: string }> {
  return [
    { path: workflow.path, content: workflow.content },
    ...(workflow.companionFiles ?? []),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function workflowContentHash(workflow: BranchDeployWorkflow): string {
  if (!workflow.companionFiles?.length) return sha256(workflow.content);
  return sha256(JSON.stringify(
    workflowFiles(workflow).map((file) => ({ path: file.path, hash: sha256(file.content) }))
  ));
}

function appStoreSecretsForGitHubActions(environmentSpec: EnvironmentSpec): {
  secrets: ProviderSecret[];
  error?: string;
} {
  if (!environmentSpec.ios?.release) return { secrets: [] };
  const resolved = getVerifiedAppStoreConnectCredentials(environmentSpec.ios.bundleId);
  if ('error' in resolved) return { secrets: [], error: resolved.error };
  return {
    secrets: [
      { name: 'APP_STORE_CONNECT_KEY_ID', value: resolved.credentials.keyId },
      { name: 'APP_STORE_CONNECT_ISSUER_ID', value: resolved.credentials.issuerId },
      { name: 'APP_STORE_CONNECT_PRIVATE_KEY', value: resolved.credentials.privateKey },
    ],
  };
}

function buildAction(params: {
  type: 'create' | 'update' | 'noop';
  provider: string;
  repo: string;
  workflow: BranchDeployWorkflow;
  reason: string;
  verified: boolean;
  availableSecretNames: string[];
  missingProviderSecrets?: string[];
  staleProviderSecrets?: string[];
  missingEnvironmentSecrets?: string[];
  staleEnvironmentSecrets?: string[];
  dependsOn?: string[];
}): PlanAction {
  return {
    id: `ci:github-actions:${params.workflow.environment}:deploy-branch`,
    type: params.type,
    resource: { kind: 'ci', name: `deploy-branch:${params.workflow.environment}`, provider: 'github' },
    verified: params.verified,
    reason: params.reason,
    ...(params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    metadata: {
      operation: OPERATION,
      repository: params.repo,
      provider: params.provider,
      workflow: {
        path: params.workflow.path,
        branch: params.workflow.branch,
        autoDeployOnPush: params.workflow.autoDeployOnPush,
        ...(params.workflow.promoteFromEnvironment
          ? { promoteFromEnvironment: params.workflow.promoteFromEnvironment }
          : {}),
        requiredSecrets: params.workflow.requiredSecrets,
        requiredVariables: params.workflow.requiredVariables,
        contentHash: sha256(params.workflow.content),
        aggregateContentHash: workflowContentHash(params.workflow),
        companionPaths: (params.workflow.companionFiles ?? []).map((file) => file.path),
      },
      availableProviderSecrets: params.availableSecretNames,
      ...(params.missingProviderSecrets?.length ? { missingProviderSecrets: params.missingProviderSecrets } : {}),
      ...(params.staleProviderSecrets?.length ? { staleProviderSecrets: params.staleProviderSecrets } : {}),
      ...(params.missingEnvironmentSecrets?.length
        ? { missingEnvironmentSecrets: params.missingEnvironmentSecrets }
        : {}),
      ...(params.staleEnvironmentSecrets?.length
        ? { staleEnvironmentSecrets: params.staleEnvironmentSecrets }
        : {}),
    },
  };
}

export async function planGitHubActionsDeploy(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
  /** Service create/replace actions will change provider ids before CI sync runs. */
  bindingsWillChange?: boolean;
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { project, environmentName, environmentSpec, environment } = params;
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(environmentSpec)) {
    return { warnings };
  }
  if (!providerRegistry.getMetadata(environmentSpec.hosting.provider)?.orchestration?.ci) {
    warnings.push(`GitHub Actions branch deploys are not supported for provider "${environmentSpec.hosting.provider}".`);
    return { warnings };
  }

  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    warnings.push('deploy.strategy is "branch" with trigger "ci", but the project has no GitHub remote (gitRemoteUrl), so the GitHub Actions deploy workflow cannot be configured.');
    return { warnings };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    warnings.push(`Could not parse GitHub repository from ${repo}.`);
    return { warnings };
  }

  const { targets, migration } = resolveBranchDeployTargets(project);
  const target = targets.find((candidate) => candidate.environmentName === environmentName);
  if (!target) {
    warnings.push(`No GitHub Actions deploy target found for environment "${environmentName}".`);
    return { warnings };
  }

  const workflow = buildBranchDeployWorkflow(
    environmentSpec.hosting.provider,
    target,
    migration,
    environmentSpec.ios
  );
  const requiredProviderSecrets = requiredProviderSecretNamesForGitHubActions(environmentSpec.hosting.provider)
    .filter((name) => workflow.requiredSecrets.includes(name));
  const availableSecrets = providerSecretsForGitHubActions(environmentSpec.hosting.provider, { githubRepo: repo })
    .filter((secret) => workflow.requiredSecrets.includes(secret.name));
  if (workflow.requiredSecrets.includes('DATABASE_URL') && !availableSecrets.some((secret) => secret.name === 'DATABASE_URL')) {
    const databaseUrlSecret = await databaseUrlSecretForGitHubActions(project, environmentName);
    if (databaseUrlSecret) {
      availableSecrets.push(databaseUrlSecret);
    }
  }
  if (
    workflow.requiredSecrets.includes('DATABASE_URL')
    && !availableSecrets.some((secret) => secret.name === 'DATABASE_URL')
    && environmentSpec.database
  ) {
    const providerName = providerRegistry.getMetadata(environmentSpec.hosting.provider)?.displayName ?? environmentSpec.hosting.provider;
    warnings.push(
      `Tool-mode migrations run in GitHub Actions, but the managed database for ${providerName} has no externally reachable URL, so DATABASE_URL cannot be synced and the migration step will fail. Prefer in-environment migrations where the provider supports them, or make the database externally reachable through a confirmed database operation before relying on CI migrations.`
    );
  }
  const availableSecretNames = availableSecrets.map((secret) => secret.name);
  const availableSecretHashes = secretHashes(availableSecrets);
  const missingProviderSecrets = requiredProviderSecrets.filter((name) => !availableSecretNames.includes(name));
  if (missingProviderSecrets.length > 0) {
    warnings.push(
      `GitHub Actions deploy workflow ${workflow.path} requires provider secrets that Hypervibe cannot sync: ${missingProviderSecrets.join(', ')}. `
      + missingProviderSecretsMessage(environmentSpec.hosting.provider, missingProviderSecrets)
    );
  }
  const appStoreSecretResolution = appStoreSecretsForGitHubActions(environmentSpec);
  if (appStoreSecretResolution.error) warnings.push(appStoreSecretResolution.error);
  const appStoreSecrets = appStoreSecretResolution.secrets;
  const appStoreSecretHashes = secretHashes(appStoreSecrets);
  const requiredBuildSecrets = [
    ...(environmentSpec.ios?.release?.build.requiredSecrets ?? []),
    ...(environmentSpec.ios?.release?.signing.provider === 'match'
      ? MATCH_SIGNING_REQUIRED_SECRETS
      : []),
  ];
  const contentHash = workflowContentHash(workflow);
  const binding = ciBindings(environment)[workflow.path];

  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe GitHub Actions workflow for ${repo}: ${adapterResult.error}`);
    const type = params.bindingsWillChange || binding?.contentHash !== contentHash ? 'update' : 'noop';
    return {
      action: buildAction({
        type,
        provider: environmentSpec.hosting.provider,
        repo,
        workflow,
        reason: params.bindingsWillChange
          ? 'Service bindings will change during apply; regenerate the GitHub Actions deploy workflow after service convergence'
          : binding?.contentHash === contentHash
            ? 'GitHub Actions deploy workflow was previously synced by Hypervibe'
            : `GitHub Actions deploy workflow ${workflow.path} needs to be synced`,
        verified: false,
        availableSecretNames,
        missingProviderSecrets,
        missingEnvironmentSecrets: appStoreSecretResolution.error
          ? [...IOS_RELEASE_REQUIRED_SECRETS]
          : undefined,
        dependsOn: params.dependsOn,
      }),
      warnings,
    };
  }

  let currentContent: string | null = null;
  let anyWorkflowFileMissing = false;
  let workflowReadVerified = false;
  try {
    const currentFiles = await Promise.all(workflowFiles(workflow).map(async (file) => ({
      desired: file,
      current: await adapterResult.adapter.getFileContent(owner, repoName, file.path),
    })));
    anyWorkflowFileMissing = currentFiles.some((file) => file.current === null);
    currentContent = currentFiles.every((file) => file.current === file.desired.content)
      ? workflow.content
      : '__drift__';
    workflowReadVerified = true;
  } catch (error) {
    warnings.push(`Cannot read GitHub Actions workflow ${workflow.path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const syncedSecrets = new Set(binding?.syncedSecrets ?? []);
  const syncedSecretHashes = asRecord(binding?.syncedSecretHashes) ?? {};
  const staleProviderSecrets = requiredProviderSecrets.filter((name) =>
    syncedSecrets.has(name)
    && availableSecretHashes[name] !== undefined
    && syncedSecretHashes[name] !== availableSecretHashes[name]
  );
  let environmentSecretNames: string[] = [];
  if (environmentSpec.ios?.release) {
    try {
      environmentSecretNames = await adapterResult.adapter.listEnvironmentSecrets(
        owner,
        repoName,
        environmentName
      );
    } catch (error) {
      workflowReadVerified = false;
      warnings.push(`Cannot observe GitHub environment secret names for ${environmentName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const syncedEnvironmentSecrets = new Set(binding?.syncedEnvironmentSecrets ?? []);
  const syncedEnvironmentSecretHashes = asRecord(binding?.syncedEnvironmentSecretHashes) ?? {};
  const staleEnvironmentSecrets = appStoreSecrets
    .filter((secret) =>
      syncedEnvironmentSecrets.has(secret.name)
      && syncedEnvironmentSecretHashes[secret.name] !== appStoreSecretHashes[secret.name]
    )
    .map((secret) => secret.name);
  const missingEnvironmentSecrets = [
    ...requiredBuildSecrets.filter((name) => !environmentSecretNames.includes(name)),
    ...(appStoreSecretResolution.error ? [...IOS_RELEASE_REQUIRED_SECRETS] : []),
  ];
  const missingManagedEnvironmentSecretSync = appStoreSecrets.some((secret) =>
    !environmentSecretNames.includes(secret.name)
    || !syncedEnvironmentSecrets.has(secret.name)
  ) || staleEnvironmentSecrets.length > 0;
  const missingSecretSync =
    missingProviderSecrets.length > 0
    || requiredProviderSecrets.some((name) => !syncedSecrets.has(name))
    || staleProviderSecrets.length > 0
    || missingManagedEnvironmentSecretSync
    || missingEnvironmentSecrets.length > 0;
  const type = anyWorkflowFileMissing
    ? 'create'
    : params.bindingsWillChange
      ? 'update'
      : currentContent === workflow.content && !missingSecretSync
        ? 'noop'
        : 'update';
  const reason = anyWorkflowFileMissing
    ? workflow.companionFiles?.length
      ? `One or more managed GitHub Actions release files are missing for ${environmentName}`
      : `GitHub Actions deploy workflow ${workflow.path} is missing`
    : params.bindingsWillChange
      ? 'Service bindings will change during apply; regenerate the GitHub Actions deploy workflow after service convergence'
      : type === 'noop'
        ? 'GitHub Actions deploy workflow is in sync'
        : missingSecretSync
          ? `GitHub Actions deploy workflow ${workflow.path} exists but provider secrets need syncing`
          : `GitHub Actions deploy workflow ${workflow.path} differs from desired content`;

  return {
    action: buildAction({
      type,
      provider: environmentSpec.hosting.provider,
      repo,
      workflow,
      reason,
      verified: workflowReadVerified,
      availableSecretNames,
      missingProviderSecrets,
      staleProviderSecrets,
      missingEnvironmentSecrets,
      staleEnvironmentSecrets,
      dependsOn: type === 'noop' ? undefined : params.dependsOn,
    }),
    warnings,
  };
}

export async function applyGitHubActionsDeploy(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const { project, spec, environmentName, environmentSpec } = params;
  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    return { success: false, message: 'GitHub repository is missing', error: 'Set project gitRemoteUrl to a GitHub remote.' };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    return { success: false, message: 'GitHub repository is invalid', error: `Could not parse ${repo}.` };
  }
  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    return { success: false, message: 'GitHub adapter unavailable', error: adapterResult.error };
  }
  const adapter: GitHubAdapter = adapterResult.adapter;
  const verification = await adapter.verify();
  if (!verification.success) {
    return {
      success: false,
      message: 'GitHub connection verification failed',
      error: verification.error ?? 'GitHub connection verification failed',
    };
  }
  const permissionProblem = githubCiDeployPermissionProblem(verification, { repo });
  if (permissionProblem) {
    return {
      success: false,
      message: 'GitHub connection is missing CI deploy permissions',
      error: permissionProblem.hint,
      data: {
        repository: repo,
        missingScopes: permissionProblem.missingScopes,
        currentScopes: verification.scopes,
      },
    };
  }

  const { targets, migration } = resolveBranchDeployTargets(project);
  const target = targets.find((candidate) => candidate.environmentName === environmentName);
  if (!target) {
    return { success: false, message: 'No GitHub Actions deploy target', error: `No deploy target found for ${environmentName}.` };
  }
  const workflow = buildBranchDeployWorkflow(
    environmentSpec.hosting.provider,
    target,
    migration,
    environmentSpec.ios
  );
  const requiredProviderSecrets = requiredProviderSecretNamesForGitHubActions(environmentSpec.hosting.provider)
    .filter((name) => workflow.requiredSecrets.includes(name));
  const availableSecrets = providerSecretsForGitHubActions(environmentSpec.hosting.provider, { githubRepo: repo })
    .filter((secret) => workflow.requiredSecrets.includes(secret.name));
  if (workflow.requiredSecrets.includes('DATABASE_URL') && !availableSecrets.some((secret) => secret.name === 'DATABASE_URL')) {
    const databaseUrlSecret = await databaseUrlSecretForGitHubActions(project, environmentName);
    if (databaseUrlSecret) {
      availableSecrets.push(databaseUrlSecret);
    }
  }
  const availableSecretNames = availableSecrets.map((secret) => secret.name);
  const missingProviderSecrets = requiredProviderSecrets.filter((name) => !availableSecretNames.includes(name));
  const appStoreSecretResolution = appStoreSecretsForGitHubActions(environmentSpec);
  const appStoreSecrets = appStoreSecretResolution.secrets;

  let currentWorkflowFiles: Array<{ path: string; content: string | null }>;
  try {
    currentWorkflowFiles = await Promise.all(workflowFiles(workflow).map(async (file) => ({
      path: file.path,
      content: await adapter.getFileContent(owner, repoName, file.path),
    })));
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot verify GitHub Actions deploy workflow ${workflow.path}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const desiredWorkflowFiles = workflowFiles(workflow);
  if (desiredWorkflowFiles.some((file) =>
    currentWorkflowFiles.find((current) => current.path === file.path)?.content !== file.content
  )) {
    const canBatchGitHubInfrastructure = shouldPlanGitHubInfrastructure(spec, environmentName)
      && spec.github
      && resolveGitHubInfrastructureRepository(project, spec) === repo;
    const repositoryFiles = canBatchGitHubInfrastructure
      ? compileManagedGitHubFiles(spec.github!, spec.runtime)
      : [];
    const desiredFiles = new Map(repositoryFiles.map((file) => [file.path, file]));
    for (const file of desiredWorkflowFiles) {
      const isPrimaryDeployWorkflow = file.path === workflow.path;
      desiredFiles.set(file.path, {
        path: file.path,
        content: file.content,
        hash: sha256(file.content),
        review: isPrimaryDeployWorkflow
          ? workflow.review
          : {
              title: `${environmentName} iOS release`,
              summary: `Updates the GitHub workflow that releases the iOS app after the ${environmentName} server deployment succeeds.`,
              details: [
                'Uses the exact server commit that was successfully deployed.',
                'Keeps the project build and Hypervibe-managed Apple release in isolated jobs.',
                'Installs existing Match assets read-only when managed signing is selected.',
                'Revalidates the IPA before sending it to the declared TestFlight groups.',
                'Does not submit the app to the App Store automatically.',
              ],
              mergeEffect: workflow.autoDeployOnPush
                ? `This release workflow waits for a successful ${environmentName} server deployment; merging it does not bypass that check.`
                : `Merging this PR only updates the release workflow; the ${environmentName} server deployment still has to be started manually.`,
            },
      });
    }
    const proposal = await proposeGitHubInfrastructureFiles({
      repository: repo,
      desiredFiles: [...desiredFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
      reconcileManifest: repositoryFiles.length > 0,
    });
    return {
      ...proposal,
      data: {
        workflow: workflow.path,
        companionFiles: (workflow.companionFiles ?? []).map((file) => file.path),
        ...(proposal.data ?? {}),
      },
    };
  }

  if (environmentSpec.ios?.release) {
    let environmentSecretNames: string[];
    try {
      environmentSecretNames = await adapter.listEnvironmentSecrets(owner, repoName, environmentName);
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot observe GitHub environment secrets for ${environmentName}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const requiredBuildSecrets = [
      ...environmentSpec.ios.release.build.requiredSecrets,
      ...(environmentSpec.ios.release.signing.provider === 'match'
        ? MATCH_SIGNING_REQUIRED_SECRETS
        : []),
    ];
    const missingBuildSecrets = requiredBuildSecrets
      .filter((name) => !environmentSecretNames.includes(name));
    if (missingBuildSecrets.length > 0) {
      return {
        success: false,
        status: 'blocked',
        message: `The iOS release workflow is missing signing/build secrets for ${environmentName}`,
        error: `Create these GitHub environment secrets, then re-run hv_plan: ${missingBuildSecrets.join(', ')}.`,
        data: { workflow: workflow.path, environmentName, missingEnvironmentSecrets: missingBuildSecrets },
      };
    }
    if (appStoreSecretResolution.error) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot sync App Store Connect credentials to ${environmentName}`,
        error: appStoreSecretResolution.error,
      };
    }
  }

  const syncedSecrets: ProviderSecret[] = [];
  const secretErrors: Array<{ name: string; error: string }> = [];
  for (const secret of availableSecrets) {
    try {
      await adapter.setRepositorySecret(owner, repoName, secret.name, secret.value);
      syncedSecrets.push(secret);
    } catch (error) {
      secretErrors.push({ name: secret.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const syncedEnvironmentSecrets: ProviderSecret[] = [];
  const environmentSecretErrors: Array<{ name: string; error: string }> = [];
  for (const secret of appStoreSecrets) {
    try {
      await adapter.setEnvironmentSecret(owner, repoName, environmentName, secret.name, secret.value);
      syncedEnvironmentSecrets.push(secret);
    } catch (error) {
      environmentSecretErrors.push({
        name: secret.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  persistWorkflowBinding(
    project,
    environmentName,
    workflow,
    syncedSecrets,
    syncedEnvironmentSecrets
  );
  const syncedSecretNames = syncedSecrets.map((secret) => secret.name);
  if (missingProviderSecrets.length > 0) {
    return {
      success: false,
      message: `Synced ${workflow.path}, but required provider secrets are missing`,
      error: missingProviderSecretsMessage(environmentSpec.hosting.provider, missingProviderSecrets),
      data: { workflow: workflow.path, syncedSecrets: syncedSecretNames, missingProviderSecrets },
    };
  }
  if (secretErrors.length > 0) {
    return {
      success: false,
      message: `Synced ${workflow.path}, but some GitHub secrets failed`,
      error: secretErrors.map((entry) => `${entry.name}: ${entry.error}`).join('; '),
      data: { workflow: workflow.path, syncedSecrets: syncedSecretNames, secretErrors },
    };
  }
  if (environmentSecretErrors.length > 0) {
    return {
      success: false,
      message: `Synced ${workflow.path}, but some GitHub environment secrets failed`,
      error: environmentSecretErrors.map((entry) => `${entry.name}: ${entry.error}`).join('; '),
      data: {
        workflow: workflow.path,
        syncedEnvironmentSecrets: syncedEnvironmentSecrets.map((secret) => secret.name),
        environmentSecretErrors,
      },
    };
  }
  return {
    success: true,
    message: `Synced GitHub Actions deploy and iOS release secrets for reviewed files`,
    data: {
      workflow: workflow.path,
      companionFiles: (workflow.companionFiles ?? []).map((file) => file.path),
      syncedSecrets: syncedSecretNames,
      syncedEnvironmentSecrets: syncedEnvironmentSecrets.map((secret) => secret.name),
    },
  };
}

export async function planGitHubActionsAppliedSpecHash(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { project, spec, environmentName, environmentSpec } = params;
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(environmentSpec)) {
    return { warnings };
  }

  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    warnings.push('Cannot record the applied deployment contract because the project has no GitHub remote.');
    return { warnings };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    warnings.push(`Cannot record the applied deployment contract because ${repo} is not a valid GitHub repository.`);
    return { warnings };
  }

  const desiredHash = environmentDeploymentContractHashForApply(spec, environmentName);
  const action = (type: 'update' | 'noop', verified: boolean, reason: string): PlanAction => ({
    id: `ci:github-actions:${environmentName}:applied-spec-hash`,
    type,
    resource: { kind: 'ci', name: `applied-spec-hash:${environmentName}`, provider: 'github' },
    verified,
    reason,
    ...(type === 'update' && params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    metadata: {
      operation: APPLIED_SPEC_HASH_OPERATION,
      repository: repo,
      environmentName,
      variableName: APPLIED_SPEC_HASH_VARIABLE,
      desiredHash,
    },
  });

  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe the applied deployment contract for ${repo}: ${adapterResult.error}`);
    return {
      action: action(
        'update',
        false,
        `Record the reconciled ${environmentName} deployment contract in GitHub Actions`
      ),
      warnings,
    };
  }

  try {
    const current = await adapterResult.adapter.getEnvironmentVariable(
      owner,
      repoName,
      environmentName,
      APPLIED_SPEC_HASH_VARIABLE
    );
    const matches = current?.value === desiredHash;
    return {
      action: action(
        matches ? 'noop' : 'update',
        true,
        matches
          ? 'GitHub Actions deployment contract is reconciled'
          : `Record the reconciled ${environmentName} deployment contract in GitHub Actions`
      ),
      warnings,
    };
  } catch (error) {
    warnings.push(
      `Cannot observe GitHub Actions environment variable ${APPLIED_SPEC_HASH_VARIABLE} for ${repo}/${environmentName}: `
      + (error instanceof Error ? error.message : String(error))
    );
    return {
      action: action(
        'update',
        false,
        `Record the reconciled ${environmentName} deployment contract in GitHub Actions`
      ),
      warnings,
    };
  }
}

export async function applyGitHubActionsAppliedSpecHash(params: {
  project: Project;
  environmentName: string;
  desiredHash: string;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const { project, environmentName, desiredHash } = params;
  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    return {
      success: false,
      message: 'GitHub repository is missing',
      error: 'Set project gitRemoteUrl to a GitHub remote.',
    };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    return { success: false, message: 'GitHub repository is invalid', error: `Could not parse ${repo}.` };
  }
  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    return { success: false, message: 'GitHub adapter unavailable', error: adapterResult.error };
  }
  const verification = await adapterResult.adapter.verify();
  if (!verification.success) {
    return {
      success: false,
      message: 'GitHub connection verification failed',
      error: verification.error ?? 'GitHub connection verification failed',
    };
  }
  const permissionProblem = githubCiDeployPermissionProblem(verification, { repo });
  if (permissionProblem) {
    return {
      success: false,
      message: 'GitHub connection is missing CI deploy permissions',
      error: permissionProblem.hint,
      data: {
        repository: repo,
        missingScopes: permissionProblem.missingScopes,
        currentScopes: verification.scopes,
      },
    };
  }

  try {
    await adapterResult.adapter.setEnvironmentVariable(
      owner,
      repoName,
      environmentName,
      APPLIED_SPEC_HASH_VARIABLE,
      desiredHash
    );
  } catch (error) {
    return {
      success: false,
      message: 'Failed to record the applied deployment contract',
      error: error instanceof Error ? error.message : String(error),
      data: { repository: repo, environmentName, variableName: APPLIED_SPEC_HASH_VARIABLE },
    };
  }

  persistAppliedSpecHashBinding(project, environmentName, desiredHash);
  return {
    success: true,
    message: `Recorded the reconciled ${environmentName} deployment contract in GitHub Actions`,
    data: {
      repository: repo,
      environmentName,
      variableName: APPLIED_SPEC_HASH_VARIABLE,
      desiredHash,
    },
  };
}

function releaseArtifactName(environmentName: string, targetSha: string): string {
  const safeEnvironment = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `hypervibe-server-release-${safeEnvironment}-${targetSha}`;
}

async function findVerifiedRelease(params: {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  workflow: string;
  environmentName: string;
  targetSha: string;
}): Promise<{ runId: number; url: string } | null> {
  const runs = await params.adapter.listWorkflowRuns(params.owner, params.repo, params.workflow, { per_page: 50 });
  const expectedArtifact = releaseArtifactName(params.environmentName, params.targetSha);
  const candidates = runs.workflow_runs.filter((run) =>
    run.status === 'completed'
    && run.conclusion === 'success'
    && (run.head_sha === params.targetSha || run.display_title?.includes(params.targetSha))
  );
  for (const run of candidates) {
    const artifacts = await params.adapter.listWorkflowRunArtifacts(params.owner, params.repo, run.id);
    if (artifacts.artifacts.some((artifact) =>
      artifact.name === expectedArtifact
      && artifact.expired === false
      && artifact.workflow_run?.id === run.id
    )) {
      return { runId: run.id, url: run.html_url };
    }
  }
  return null;
}

export async function planGitHubActionsRelease(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  dependsOn?: string[];
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(params.environmentSpec)) return { warnings };
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl);
  const [owner, repo] = repository?.split('/') ?? [];
  const deployTargets = resolveBranchDeployTargets(params.project);
  const target = deployTargets.targets
    .find((candidate) => candidate.environmentName === params.environmentName);
  if (!repository || !owner || !repo || !target) {
    warnings.push(`Cannot plan the ${params.environmentName} release required by database.seedCommand.`);
    return { warnings };
  }
  const workflow = buildBranchDeployWorkflow(
    params.environmentSpec.hosting.provider,
    target,
    deployTargets.migration,
    params.environmentSpec.ios
  );
  const action = (
    verified: boolean,
    reason: string,
    metadata: Record<string, unknown>,
    type: 'update' | 'noop' = 'update'
  ): PlanAction => ({
    id: `ci:github-actions:${params.environmentName}:release`,
    type,
    resource: { kind: 'ci', name: `release:${params.environmentName}`, provider: 'github' },
    verified,
    reason,
    ...(type === 'update' && params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    metadata: {
      operation: GITHUB_ACTIONS_RELEASE_OPERATION,
      repository,
      environmentName: params.environmentName,
      workflow: workflow.path,
      ref: workflow.branch,
      ...metadata,
    },
  });
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe the exact release required before database seeding: ${adapterResult.error}`);
    return {
      action: action(false, `Cannot verify the ${params.environmentName} release required before database seeding`, {
        blockedReason: 'github_release_observation_unknown',
      }),
      warnings,
    };
  }
  try {
    const ref = await adapterResult.adapter.getRef(owner, repo, `heads/${workflow.branch}`);
    const targetSha = ref?.object.sha;
    if (!targetSha || !/^[0-9a-f]{40}$/i.test(targetSha)) {
      return {
        action: action(true, `GitHub branch ${workflow.branch} has no exact commit to release`, {
          blockedReason: 'github_release_ref_absent',
        }),
        warnings,
      };
    }
    const existing = await findVerifiedRelease({
      adapter: adapterResult.adapter,
      owner,
      repo,
      workflow: workflow.path,
      environmentName: params.environmentName,
      targetSha,
    });
    const mustReleaseAfterPrerequisites = Boolean(params.dependsOn?.length);
    return {
      action: action(
        true,
        existing && !mustReleaseAfterPrerequisites
          ? `Exact commit ${targetSha} is already verified as deployed`
          : `Deploy and verify exact commit ${targetSha} before database seeding`,
        {
          targetSha,
          forceRelease: mustReleaseAfterPrerequisites,
          ...(existing ? { previousVerifiedRunId: existing.runId } : {}),
        },
        existing && !mustReleaseAfterPrerequisites ? 'noop' : 'update'
      ),
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Cannot observe the exact release required before database seeding: ${message}`);
    return {
      action: action(false, `Cannot verify the ${params.environmentName} release required before database seeding`, {
        blockedReason: 'github_release_observation_unknown',
      }),
      warnings,
    };
  }
}

export function isGitHubActionsReleaseAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_ACTIONS_RELEASE_OPERATION;
}

export async function applyGitHubActionsRelease(params: {
  project: Project;
  environmentName: string;
  workflow: string;
  ref: string;
  targetSha: string;
  forceRelease?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl);
  const [owner, repo] = repository?.split('/') ?? [];
  if (!repository || !owner || !repo) {
    return { success: false, status: 'blocked', message: 'GitHub repository is missing', error: 'Set project gitRemoteUrl to a GitHub remote.' };
  }
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    return { success: false, status: 'blocked', message: 'GitHub adapter unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter;
  const alreadyReleased = params.forceRelease
    ? null
    : await findVerifiedRelease({
      adapter,
      owner,
      repo,
      workflow: params.workflow,
      environmentName: params.environmentName,
      targetSha: params.targetSha,
    });
  if (alreadyReleased) {
    return {
      success: true,
      message: `Verified deployed commit ${params.targetSha}`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: alreadyReleased.runId, url: alreadyReleased.url },
    };
  }

  const before = await adapter.listWorkflowRuns(owner, repo, params.workflow, { per_page: 50 });
  const existingRunIds = new Set(before.workflow_runs.map((run) => run.id));
  await adapter.triggerWorkflow(owner, repo, params.workflow, params.ref, { commit_sha: params.targetSha });
  const deadline = Date.now() + (params.timeoutMs ?? RELEASE_WAIT_TIMEOUT_MS);
  let selectedRun: Awaited<ReturnType<GitHubAdapter['listWorkflowRuns']>>['workflow_runs'][number] | undefined;
  while (Date.now() < deadline) {
    const observed = await adapter.listWorkflowRuns(owner, repo, params.workflow, { per_page: 50 });
    selectedRun = selectedRun
      ? observed.workflow_runs.find((run) => run.id === selectedRun?.id)
      : observed.workflow_runs.find((run) =>
        !existingRunIds.has(run.id)
        && run.event === 'workflow_dispatch'
        && (run.head_sha === params.targetSha || run.display_title?.includes(params.targetSha))
      );
    if (selectedRun?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs ?? RELEASE_POLL_INTERVAL_MS));
  }
  if (!selectedRun || selectedRun.status !== 'completed') {
    return {
      success: true,
      status: 'pending',
      message: `The exact-SHA ${params.environmentName} release is still running`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, ...(selectedRun ? { runId: selectedRun.id, url: selectedRun.html_url } : {}) },
    };
  }
  if (selectedRun.conclusion !== 'success') {
    return {
      success: false,
      message: `The exact-SHA ${params.environmentName} release failed`,
      error: `GitHub Actions run ${selectedRun.id} concluded ${selectedRun.conclusion ?? 'without a conclusion'}.`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: selectedRun.id, url: selectedRun.html_url },
    };
  }
  const artifacts = await adapter.listWorkflowRunArtifacts(owner, repo, selectedRun.id);
  const expectedArtifact = releaseArtifactName(params.environmentName, params.targetSha);
  const releaseEvidence = artifacts.artifacts.find((artifact) =>
    artifact.name === expectedArtifact
    && artifact.expired === false
    && artifact.workflow_run?.id === selectedRun?.id
  );
  if (!releaseEvidence) {
    return {
      success: false,
      message: `The exact-SHA ${params.environmentName} release lacked verified release evidence`,
      error: `Successful run ${selectedRun.id} did not emit ${expectedArtifact}.`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: selectedRun.id, url: selectedRun.html_url },
    };
  }
  return {
    success: true,
    message: `Deployed and verified exact commit ${params.targetSha}`,
    data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: selectedRun.id, url: selectedRun.html_url, artifactId: releaseEvidence.id },
  };
}

function persistWorkflowBinding(
  project: Project,
  environmentName: string,
  workflow: BranchDeployWorkflow,
  syncedSecrets: ProviderSecret[],
  syncedEnvironmentSecrets: ProviderSecret[] = []
): void {
  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, environmentName)
    ?? envRepo.create({ projectId: project.id, name: environmentName });
  const ci = asRecord(environment.platformBindings.ci) ?? {};
  const deployBranch = asRecord(ci.deployBranch) ?? {};
  envRepo.updatePlatformBindings(environment.id, {
    ci: {
      ...ci,
      deployBranch: {
        ...deployBranch,
        [workflow.path]: {
          contentHash: workflowContentHash(workflow),
          syncedSecrets: syncedSecrets.map((secret) => secret.name),
          syncedSecretHashes: secretHashes(syncedSecrets),
          syncedEnvironmentSecrets: syncedEnvironmentSecrets.map((secret) => secret.name),
          syncedEnvironmentSecretHashes: secretHashes(syncedEnvironmentSecrets),
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });
}

function persistAppliedSpecHashBinding(
  project: Project,
  environmentName: string,
  desiredHash: string
): void {
  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, environmentName)
    ?? envRepo.create({ projectId: project.id, name: environmentName });
  const ci = asRecord(environment.platformBindings.ci) ?? {};
  envRepo.updatePlatformBindings(environment.id, {
    ci: {
      ...ci,
      appliedSpecHash: {
        hash: desiredHash,
        variableName: APPLIED_SPEC_HASH_VARIABLE,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}
