import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import '../../../adapters/providers/gcp/cloudsql.adapter.js';
import {
  GitHubAdapter,
  type GitHubPullRequestSummary,
} from '../../../adapters/providers/github/github.adapter.js';
import '../../../adapters/providers/openai/openai.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';
import type { Project } from '../../entities/project.entity.js';
import { PlanService } from '../../plan/plan.service.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import {
  applyGitHubInfrastructure,
  applyGitHubDelegatedSecret,
  compileManagedGitHubFiles,
  GITHUB_INFRASTRUCTURE_ACTION_ID,
  GITHUB_INFRASTRUCTURE_BRANCH,
  GITHUB_INFRASTRUCTURE_MANIFEST,
  GITHUB_INFRASTRUCTURE_PR_BODY_MARKER,
  GITHUB_INFRASTRUCTURE_PR_TITLE,
  GITHUB_OPENAI_SECRET_ACTION_ID,
  planGitHubInfrastructure,
} from '../github-infrastructure.service.js';

const REPOSITORY = 'owner/example';
const project = {
  id: 'project-1',
  name: 'example',
  defaultPlatform: 'railway',
  gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
} as Project;

function spec() {
  return projectSpecSchema.parse({
    version: 1,
    project: 'example',
    runtime: { kind: 'node', version: '22', installCommand: 'npm ci' },
    github: {
      actions: {
        tests: { kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'] },
        fix: { kind: 'autofix', sources: ['tests'] },
      },
      dependencies: { alerts: true, securityUpdates: true },
      security: { secretScanning: true, pushProtection: true, codeScanning: true },
    },
    environments: { production: { hosting: { provider: 'railway' }, services: {} } },
  });
}

function seedGitHub(): void {
  const repo = new ConnectionRepository();
  const connection = repo.create({
    provider: 'github',
    scope: REPOSITORY,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'github-token' }),
  });
  repo.updateStatus(connection.id, 'verified');
}

function infrastructureAction(): PlanAction {
  const desiredSpec = spec();
  return {
    id: GITHUB_INFRASTRUCTURE_ACTION_ID,
    type: 'update',
    resource: { kind: 'repo', name: REPOSITORY, provider: 'github' },
    verified: true,
    reason: 'drift',
    metadata: {
      operation: 'githubInfrastructurePullRequest',
      repository: REPOSITORY,
      desiredFiles: compileManagedGitHubFiles(desiredSpec.github!, desiredSpec.runtime),
    },
  };
}

function infrastructurePull(
  overrides: Partial<GitHubPullRequestSummary> = {}
): GitHubPullRequestSummary {
  return {
    number: 56,
    html_url: 'https://github.com/owner/example/pull/56',
    title: GITHUB_INFRASTRUCTURE_PR_TITLE,
    body: `${GITHUB_INFRASTRUCTURE_PR_BODY_MARKER}\n\nReview and merge it.`,
    state: 'closed',
    merged_at: '2026-07-28T01:42:56Z',
    head: {
      ref: GITHUB_INFRASTRUCTURE_BRANCH,
      sha: 'merged-head',
    },
    base: {
      ref: 'main',
      sha: 'base-at-open',
    },
    ...overrides,
  };
}

describe('GitHub infrastructure plan/apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-github-infra-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    seedGitHub();
  });

  afterEach(() => {
    delete process.env.REPOSITORY_CI_TOKEN;
    vi.restoreAllMocks();
    vi.useRealTimers();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans one file PR first and defers the OpenAI secret stage', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    const result = await planGitHubInfrastructure({ project, spec: spec(), environmentName: 'production' });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      metadata: { branch: GITHUB_INFRASTRUCTURE_BRANCH },
    });
    expect(result.actions[0].metadata?.desiredFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.github/workflows/hypervibe-fix.yml' }),
    ]));
    expect(result.blocked.find((block) => block.provider === 'openai')).toBeUndefined();
  });

  it('blocks unsafe reconciliation until an external autofix source declares its artifact pattern', async () => {
    const legacySpec = projectSpecSchema.parse({
      version: 1,
      project: 'example',
      github: {
        actions: {
          fix: { kind: 'autofix', sources: ['staging-deploy'] },
        },
        externalWorkflows: {
          'staging-deploy': {
            workflowName: 'Deploy Railway (staging)',
            failureArtifacts: ['hypervibe-deploy-failure.log'],
          },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);

    const result = await planGitHubInfrastructure({
      project,
      spec: legacySpec,
      environmentName: 'production',
    });

    expect(result.actions[0]).toMatchObject({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      metadata: { blockedReason: 'github_autofix_artifact_contract_incomplete' },
    });
    expect(result.warnings).toContain(
      'GitHub autofix fix source staging-deploy must declare github.externalWorkflows.staging-deploy.failureArtifactPattern before reconciliation.'
    );
    const workflow = (result.actions[0].metadata?.desiredFiles as Array<{ path: string; content: string }>).find(
      (file) => file.path.endsWith('hypervibe-fix.yml')
    )?.content;
    expect(workflow).toContain('hypervibe-no-evidence-artifact-match');
  });

  it('blocks restore-drill workflow reconciliation until its named credential secret exists', async () => {
    const drillProject = new ProjectRepository().create({
      name: 'restore-drill-example',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    const environment = new EnvironmentRepository().create({
      projectId: drillProject.id,
      name: 'production',
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'production-postgres',
        connectionName: 'gcp-project:us-central1:production-postgres',
        database: 'app',
      },
    });
    const drillSpec = projectSpecSchema.parse({
      version: 1,
      project: 'restore-drill-example',
      github: {},
      environments: {
        production: {
          hosting: { provider: 'cloudrun' },
          services: { web: {} },
          database: {
            provider: 'cloudsql',
            resilience: {
              backups: { retainedBackups: 8, pitrRetentionDays: 7 },
              restoreDrill: { schedule: { cron: '0 4 * * 1' } },
            },
          },
        },
      },
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    const secrets = vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([]);

    const result = await planGitHubInfrastructure({
      project: drillProject,
      spec: drillSpec,
      environmentName: 'production',
    });

    expect(result.actions[0]).toMatchObject({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      metadata: { blockedReason: 'github_restore_drill_secret_missing' },
    });
    expect(result.actions[0].metadata?.desiredFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.github/hypervibe/cloudsql-restore-drill.mjs' }),
      expect.objectContaining({ path: '.github/workflows/hypervibe-db-restore-drill-production.yml' }),
    ]));
    expect(result.warnings).toContainEqual(expect.stringContaining(
      'githubActions.repository=true'
    ));

    secrets.mockResolvedValue(['HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS']);
    const ready = await planGitHubInfrastructure({
      project: drillProject,
      spec: drillSpec,
      environmentName: 'production',
    });
    expect(ready.actions[0]).toMatchObject({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      billable: true,
    });
    expect(ready.actions[0].metadata?.blockedReason).toBeUndefined();
  });

  it('plans action-scoped OpenAI and native settings only after files are merged', async () => {
    const desiredSpec = spec();
    const desired = new Map(compileManagedGitHubFiles(
      desiredSpec.github!,
      desiredSpec.runtime
    ).map((file) => [file.path, file.content]));
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, filePath) => desired.get(filePath) ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({
      default_branch: 'main', private: true,
      security_and_analysis: {
        dependabot_security_updates: { status: 'disabled' },
        secret_scanning: { status: 'disabled' },
        secret_scanning_push_protection: { status: 'disabled' },
      },
    });
    vi.spyOn(GitHubAdapter.prototype, 'getVulnerabilityAlertsEnabled').mockResolvedValue(false);
    vi.spyOn(GitHubAdapter.prototype, 'getCodeScanningDefaultSetup').mockResolvedValue({ state: 'not-configured' });
    vi.spyOn(GitHubAdapter.prototype, 'getWorkflowPermissions').mockResolvedValue({
      default_workflow_permissions: 'read', can_approve_pull_request_reviews: false,
    });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getBranchProtection').mockResolvedValue(null);

    const result = await planGitHubInfrastructure({ project, spec: spec(), environmentName: 'production' });
    expect(result.actions.find((action) => action.id === GITHUB_OPENAI_SECRET_ACTION_ID)?.type).toBe('update');
    expect(result.blocked.find((block) => block.provider === 'openai')).toMatchObject({
      policy: 'action-scoped-if-independent-actions',
      actionIds: [GITHUB_OPENAI_SECRET_ACTION_ID],
    });
    expect(result.actions.find((action) => action.id === 'repo:github-code-scanning')).toMatchObject({
      type: 'update', billable: true, requiresConfirm: true,
    });
    expect(result.actions.find((action) => action.id === 'repo:github-actions-pr-permission')?.type).toBe('update');
  });

  it('applies the OpenAI Actions secret from a repository-only plan using repository metadata authority', async () => {
    const repositoryProject = new ProjectRepository().create({
      name: 'repository-openai-secret',
      gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    const desiredSpec = projectSpecSchema.parse({
      version: 1,
      project: repositoryProject.name,
      gitRemoteUrl: repositoryProject.gitRemoteUrl,
      github: {
        repository: REPOSITORY,
        canonicalEnvironment: 'repository',
        collaboration: {
          issues: { enabled: false, templates: false },
          pullRequests: { requirePr: false },
        },
        actions: {
          audit: {
            kind: 'code-audit',
            schedule: { cron: '17 5 * * *', timezone: 'UTC' },
            instructions: 'Audit provider claims without modifying the repository.',
          },
        },
      },
      environments: {},
    });
    const stored = new SpecStore().replace(repositoryProject, desiredSpec);
    const openAI = new ConnectionRepository().create({
      provider: 'openai',
      scope: REPOSITORY,
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'openai-test-key' }),
    });
    new ConnectionRepository().updateStatus(openAI.id, 'verified');

    const desiredFiles = new Map(
      compileManagedGitHubFiles(desiredSpec.github!).map((file) => [file.path, file.content])
    );
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
      .mockImplementation(async (_owner, _repo, filePath) => desiredFiles.get(filePath) ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({
      default_branch: 'main',
      private: false,
    });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const planned = await new PlanService().plan(repositoryProject, 'repository');
    expect(planned).not.toHaveProperty('error');
    const plan = planned as Exclude<typeof planned, { error: string }>;
    expect(plan.actions.find((action) => action.id === GITHUB_OPENAI_SECRET_ACTION_ID)).toMatchObject({
      type: 'update',
      resource: { kind: 'secret', name: 'OPENAI_API_KEY', provider: 'github' },
      metadata: { repository: REPOSITORY },
    });

    const outcome = await executePlanApply(createToolContext(), {
      project: repositoryProject,
      spec: stored.spec,
      specRevision: stored.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: expect.arrayContaining([
          expect.objectContaining({ actionId: GITHUB_OPENAI_SECRET_ACTION_ID, status: 'succeeded' }),
        ]),
      },
    });
    expect(setSecret).toHaveBeenCalledWith('owner', 'example', 'OPENAI_API_KEY', 'openai-test-key');
  });

  it('plans and applies a declared Actions secret through the repository-only lifecycle', async () => {
    const secretValue = 'repository-plan-secret-value';
    process.env.REPOSITORY_CI_TOKEN = secretValue;
    const repositoryProject = new ProjectRepository().create({
      name: 'repository-delegated-secret',
      gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    const desiredSpec = projectSpecSchema.parse({
      version: 1,
      project: repositoryProject.name,
      gitRemoteUrl: repositoryProject.gitRemoteUrl,
      github: {
        repository: REPOSITORY,
        canonicalEnvironment: 'repository',
        collaboration: {
          issues: { enabled: false, templates: false },
          pullRequests: { requirePr: false },
        },
      },
      secrets: {
        CI_TOKEN: {
          principal: 'github:owner',
          githubActions: { repository: true },
        },
      },
      environments: {},
    });
    const stored = new SpecStore().replace(repositoryProject, desiredSpec);
    const desiredFiles = new Map(
      compileManagedGitHubFiles(desiredSpec.github!).map((file) => [file.path, file.content])
    );
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
      .mockImplementation(async (_owner, _repo, filePath) => desiredFiles.get(filePath) ?? null);
    let repositorySecrets: string[] = [];
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets')
      .mockImplementation(async () => repositorySecrets);
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret')
      .mockImplementation(async (_owner, _repo, name) => {
        repositorySecrets = [...new Set([...repositorySecrets, name])];
      });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({
      default_branch: 'main',
      private: false,
    });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);

    const planned = await new PlanService().plan(repositoryProject, 'repository', {
      secretRefs: { CI_TOKEN: 'env:REPOSITORY_CI_TOKEN' },
    });
    expect(planned).not.toHaveProperty('error');
    const plan = planned as Exclude<typeof planned, { error: string }>;
    expect(plan.inputRequired).toEqual([]);
    expect(plan.actions.find((action) => action.id === 'secret:github:repository:CI_TOKEN')).toMatchObject({
      type: 'update',
      resource: { kind: 'secret', name: 'CI_TOKEN', provider: 'github' },
      metadata: {
        operation: 'githubDelegatedSecretSync',
        repository: REPOSITORY,
        inputProvided: true,
      },
    });
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(JSON.stringify(document)).not.toContain(secretValue);
    expect(JSON.stringify(document)).not.toContain('REPOSITORY_CI_TOKEN');
    const overrides = document.overrides as Record<string, unknown>;
    expect(overrides.delegatedSecretKeys).toEqual(['CI_TOKEN']);
    expect(getSecretStore().decryptObject(overrides.delegatedSecretVarsEncrypted as string)).toEqual({
      CI_TOKEN: secretValue,
    });

    const outcome = await executePlanApply(createToolContext(), {
      project: repositoryProject,
      spec: stored.spec,
      specRevision: stored.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: true,
        receipts: expect.arrayContaining([
          expect.objectContaining({
            actionId: 'secret:github:repository:CI_TOKEN',
            status: 'succeeded',
          }),
        ]),
      },
    });
    expect(setSecret).toHaveBeenCalledWith('owner', 'example', 'CI_TOKEN', secretValue);
    expect(JSON.stringify(outcome)).not.toContain(secretValue);
    const environment = new EnvironmentRepository()
      .findByProjectAndName(repositoryProject.id, 'repository')!;
    expect(environment.platformBindings.github).toMatchObject({
      delegatedActionsBindings: [expect.objectContaining({
        name: 'CI_TOKEN',
        target: 'repository',
        principal: 'github:owner',
      })],
    });
    expect(JSON.stringify(environment.platformBindings)).not.toContain(secretValue);
  });

  it('plans and applies declared GitHub Actions secrets from encrypted plan input', async () => {
    const storedProject = new ProjectRepository().create({
      name: 'declared-secret-example',
      defaultPlatform: 'railway',
      gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    new EnvironmentRepository().create({ projectId: storedProject.id, name: 'production' });
    const declared = projectSpecSchema.parse({
      version: 1,
      project: storedProject.name,
      github: {},
      secrets: {
        CI_TOKEN: {
          principal: 'github:owner',
          githubActions: { repository: true },
        },
      },
      environments: {
        production: { hosting: { provider: 'railway' }, services: {} },
      },
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    const list = vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['CI_TOKEN']);
    const set = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const planned = await planGitHubInfrastructure({
      project: storedProject,
      spec: declared,
      environmentName: 'production',
      suppliedSecretValues: { CI_TOKEN: 'never-return-this-value' },
    });
    const action = planned.actions.find((candidate) => candidate.resource.name === 'CI_TOKEN')!;
    expect(action).toMatchObject({
      type: 'update',
      resource: { kind: 'secret', provider: 'github' },
      metadata: { operation: 'githubDelegatedSecretSync', inputProvided: true },
    });
    expect(planned.inputRequired).toEqual([]);

    const applied = await applyGitHubDelegatedSecret({
      project: storedProject,
      spec: declared,
      environmentName: 'production',
      action,
      value: 'never-return-this-value',
    });
    expect(applied.success).toBe(true);
    expect(set).toHaveBeenCalledWith('owner', 'example', 'CI_TOKEN', 'never-return-this-value');
    expect(JSON.stringify(applied)).not.toContain('never-return-this-value');
    expect(list).toHaveBeenCalledTimes(2);
    const environment = new EnvironmentRepository().findByProjectAndName(storedProject.id, 'production')!;
    expect(JSON.stringify(environment.platformBindings)).not.toContain('never-return-this-value');
    expect(environment.platformBindings.github).toMatchObject({
      delegatedActionsBindings: [expect.objectContaining({ name: 'CI_TOKEN', target: 'repository' })],
    });
  });

  it('creates a deterministic infrastructure branch and returns a pending PR receipt', async () => {
    const action = infrastructureAction();
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    const createRef = vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({ number: 42, html_url: 'https://github.com/owner/example/pull/42' });

    const result = await applyGitHubInfrastructure({ action });

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      data: { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/owner/example/pull/42' },
    });
    expect(createRef).toHaveBeenCalledWith('owner', 'example', `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, 'base-sha');
    expect(write).toHaveBeenCalledWith(
      'owner', 'example', expect.any(String), expect.any(String), expect.any(String), GITHUB_INFRASTRUCTURE_BRANCH
    );
  });

  it('retries branch observation when a newly created infrastructure branch is not immediately visible', async () => {
    vi.useFakeTimers();
    const action = infrastructureAction();
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 58,
      html_url: 'https://github.com/owner/example/pull/58',
    });

    const resultPromise = applyGitHubInfrastructure({ action });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      data: { pullRequestNumber: 58 },
    });
    expect(write).toHaveBeenCalled();
  });

  it('recycles a squash-merged managed branch and proposes the next infrastructure PR', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([infrastructurePull()]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 57,
      html_url: 'https://github.com/owner/example/pull/57',
    });

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      data: {
        pullRequestNumber: 57,
        branchRecycled: true,
        recycledPullRequestNumber: 56,
        recycledPullRequestUrl: 'https://github.com/owner/example/pull/56',
        recycledFromSha: 'merged-head',
        recycledToSha: 'base-sha',
      },
    });
    expect(updateRef).toHaveBeenCalledWith(
      'owner',
      'example',
      `heads/${GITHUB_INFRASTRUCTURE_BRANCH}`,
      'base-sha',
      { force: true }
    );
    expect(write).toHaveBeenCalled();
  });

  it('keeps merge-commit branch reuse on the non-forced fast-forward path', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'behind',
      ahead_by: 0,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 57,
      html_url: 'https://github.com/owner/example/pull/57',
    });

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({ success: false, status: 'pending' });
    expect(updateRef).toHaveBeenCalledWith(
      'owner',
      'example',
      `heads/${GITHUB_INFRASTRUCTURE_BRANCH}`,
      'base-sha'
    );
    expect(updateRef).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      { force: true }
    );
  });

  it.each([
    ['closed without merge', infrastructurePull({ merged_at: null })],
    ['wrong title', infrastructurePull({ title: 'Repository-owned change' })],
    ['wrong body', infrastructurePull({ body: 'Not generated by Hypervibe' })],
    ['different head commit', infrastructurePull({
      head: { ref: GITHUB_INFRASTRUCTURE_BRANCH, sha: 'different-head' },
    })],
    ['different base branch', infrastructurePull({
      base: { ref: 'release', sha: 'base-at-open' },
    })],
  ])('blocks a divergent branch with %s provenance without mutations', async (_label, closedPull) => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([closedPull]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');
    const createPullRequest = vi.spyOn(GitHubAdapter.prototype, 'createPullRequest');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'GitHub infrastructure branch has unowned work',
    });
    expect(updateRef).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('blocks duplicate open managed pull requests without branch mutations', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'managed-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([
      infrastructurePull({ number: 60, state: 'open', merged_at: null }),
      infrastructurePull({ number: 61, state: 'open', merged_at: null }),
    ]);
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'Multiple GitHub infrastructure pull requests are open',
    });
    expect(updateRef).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('continues the single canonical open infrastructure pull request', async () => {
    const openPull = infrastructurePull({
      state: 'open',
      merged_at: null,
      head: { ref: GITHUB_INFRASTRUCTURE_BRANCH, sha: 'open-head' },
    });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'open-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([openPull]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'ahead',
      ahead_by: 1,
      behind_by: 0,
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: true, updated: false });
    const createPullRequest = vi.spyOn(GitHubAdapter.prototype, 'createPullRequest');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      data: {
        pullRequestNumber: openPull.number,
        pullRequestUrl: openPull.html_url,
      },
    });
    expect(write).toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('blocks a diverged open pull request without resetting or writing its branch', async () => {
    const openPull = infrastructurePull({
      state: 'open',
      merged_at: null,
      head: { ref: GITHUB_INFRASTRUCTURE_BRANCH, sha: 'open-head' },
    });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'open-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([openPull]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'GitHub infrastructure branch diverged from its base',
      data: { pullRequestUrl: openPull.html_url },
    });
    expect(updateRef).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('blocks an open pull request whose canonical provenance was changed', async () => {
    const openPull = infrastructurePull({
      state: 'open',
      merged_at: null,
      title: 'Renamed infrastructure work',
      head: { ref: GITHUB_INFRASTRUCTURE_BRANCH, sha: 'open-head' },
    });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'open-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([openPull]);
    const compareCommits = vi.spyOn(GitHubAdapter.prototype, 'compareCommits');
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'Open GitHub infrastructure pull request has unexpected provenance',
      data: { pullRequestUrl: openPull.html_url },
    });
    expect(compareCommits).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('blocks when the managed branch changes after merged-PR provenance is verified', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'new-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([infrastructurePull()]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'GitHub infrastructure branch changed during apply',
    });
    expect(updateRef).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('stops before file writes when the provider rejects a forced recycle', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([infrastructurePull()]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    vi.spyOn(GitHubAdapter.prototype, 'updateRef')
      .mockRejectedValue(new Error('Protected branch update rejected'));
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'GitHub infrastructure branch reconciliation failed',
      error: 'Protected branch update rejected',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('stops before file writes when a forced recycle cannot be verified', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } })
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'new-base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([infrastructurePull()]);
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef').mockResolvedValue();
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'Recycled GitHub infrastructure branch could not be verified',
    });
    expect(updateRef).toHaveBeenCalledWith(
      'owner',
      'example',
      `heads/${GITHUB_INFRASTRUCTURE_BRANCH}`,
      'base-sha',
      { force: true }
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('retries safely after a recycle already moved the branch to the base head', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    const compareCommits = vi.spyOn(GitHubAdapter.prototype, 'compareCommits');
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 57,
      html_url: 'https://github.com/owner/example/pull/57',
    });

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({ success: false, status: 'pending' });
    expect(compareCommits).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
  });

  it('preserves the branch and stops when closed-PR observation fails', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'merged-head' } });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests')
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('GitHub rate limit'));
    vi.spyOn(GitHubAdapter.prototype, 'compareCommits').mockResolvedValue({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 1,
    });
    const updateRef = vi.spyOn(GitHubAdapter.prototype, 'updateRef');
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');

    const result = await applyGitHubInfrastructure({ action: infrastructureAction() });

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      message: 'GitHub infrastructure branch reconciliation failed',
      error: 'GitHub rate limit',
    });
    expect(updateRef).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('replaces the canonical pull-request template and removes the retired uppercase path', async () => {
    const github = projectSpecSchema.parse({
      version: 1,
      project: 'example',
      github: {
        collaboration: {
          issues: { enabled: false, templates: false },
          pullRequests: { requirePr: true },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;
    const action: PlanAction = {
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      resource: { kind: 'repo', name: REPOSITORY, provider: 'github' },
      verified: true,
      reason: 'release template ownership',
      metadata: {
        operation: 'githubInfrastructurePullRequest',
        repository: REPOSITORY,
        desiredFiles: compileManagedGitHubFiles(github),
      },
    };
    const oldManifest = JSON.stringify({
      version: 1,
      managedBy: 'hypervibe',
      files: ['.github/PULL_REQUEST_TEMPLATE.md'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockImplementation(async (_owner, _repo, filePath) => {
      if (filePath === GITHUB_INFRASTRUCTURE_MANIFEST) {
        return { sha: 'manifest-sha', content: oldManifest };
      }
      if (filePath === '.github/pull_request_template.md') {
        return { sha: 'lowercase-template-sha', content: 'repository-owned template' };
      }
      if (filePath === '.github/PULL_REQUEST_TEMPLATE.md') {
        return { sha: 'uppercase-template-sha', content: 'old Hypervibe template' };
      }
      return null;
    });
    const createOrUpdateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: false, updated: true });
    const deleteFile = vi.spyOn(GitHubAdapter.prototype, 'deleteFile').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 43,
      html_url: 'https://github.com/owner/example/pull/43',
    });

    const result = await applyGitHubInfrastructure({ action });

    expect(result).toMatchObject({ success: false, status: 'pending' });
    expect(createOrUpdateFile).toHaveBeenCalledWith(
      'owner',
      'example',
      '.github/pull_request_template.md',
      expect.stringContaining('## Summary'),
      expect.any(String),
      GITHUB_INFRASTRUCTURE_BRANCH
    );
    expect(deleteFile).toHaveBeenCalledWith(
      'owner',
      'example',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'uppercase-template-sha',
      expect.any(String),
      GITHUB_INFRASTRUCTURE_BRANCH
    );
  });
});
