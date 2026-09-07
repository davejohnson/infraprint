import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import '../../adapters/providers/railway/railway.adapter.js';
import '../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../adapters/providers/gcp/cloudsql.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CLOUD_PREPARE_PROFILES } from '../../domain/services/cloud-prepare.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import {
  buildBranchDeployWorkflow,
  resolveBranchDeployTargets,
} from '../../domain/services/github-ops.service.js';
import { createToolContext } from '../../application/context.js';
import { registerHvDeployTools } from '../hv-deploy.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-deploy-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedVerifiedConnection(provider: string): void {
  const repo = new ConnectionRepository();
  const connection = repo.create({
    provider,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'test-token' }),
  });
  repo.updateStatus(connection.id, 'verified');
}

function seedManagedCiRollbackProject(name: string) {
  const project = new ProjectRepository().create({
    name,
    defaultPlatform: 'railway',
    gitRemoteUrl: `https://github.com/davejohnson/${name}`,
    policies: { protectedEnvironments: ['production'] },
  });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-project',
      environmentId: 'rail-production',
      services: { web: { serviceId: 'rail-web' } },
    },
  });
  new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    gitRemoteUrl: project.gitRemoteUrl,
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: { workloadKind: 'web' } },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false },
      },
    },
  });
  seedVerifiedConnection('github');
  const resolved = resolveBranchDeployTargets(project);
  const target = resolved.targets.find((candidate) => candidate.environmentName === 'production')!;
  const workflow = buildBranchDeployWorkflow('railway', target, resolved.migration);
  return { project, environment, workflow };
}

function workflowRun(
  id: number,
  status: string,
  conclusion: string | null,
  createdAt: string
) {
  return {
    id,
    name: 'Deploy Railway (production)',
    status,
    conclusion,
    created_at: createdAt,
    updated_at: createdAt,
    head_sha: 'f'.repeat(40),
    head_branch: 'main',
    event: 'workflow_dispatch',
    html_url: `https://github.com/davejohnson/app/actions/runs/${id}`,
  };
}

function releaseArtifact(runId: number, sha: string, artifactId = runId * 10) {
  return {
    id: artifactId,
    name: `hypervibe-server-release-production-${sha}`,
    expired: false,
    created_at: `2026-07-${String(runId).padStart(2, '0')}T00:05:00Z`,
    updated_at: `2026-07-${String(runId).padStart(2, '0')}T00:05:00Z`,
    workflow_run: {
      id: runId,
      repository_id: 1,
      head_repository_id: 1,
      head_branch: 'main',
      head_sha: 'f'.repeat(40),
    },
  };
}

async function makeClient() {
  const server = new McpServer({ name: 'hv-deploy-test', version: '1.0.0' });
  registerHvDeployTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-deploy-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_deploy', () => {
  it('returns a structured error for unknown projects', async () => {
    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.hint).toContain('hv_spec');
    expect(result.error.details.requestedProject).toBe('nope');
    expect(result.agentInstruction.action).toBe('continue');
    await t.close();
  });

  it('confirm-gates deploys to protected environments', async () => {
    const project = new ProjectRepository().create({
      name: 'gate-app',
      policies: { protectedEnvironments: ['production'] },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: { hosting: { provider: 'railway' }, services: { web: {} } },
      },
    });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'gate-app', env: 'production' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });

  it('requires a spec: deploys are plan-gated', async () => {
    const project = new ProjectRepository().create({ name: 'specless-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'specless-app', env: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.hint).toContain('hv_spec');
    await t.close();
  });

  it('does not direct-deploy Railway GitHub Actions branch deploy environments', async () => {
    const project = new ProjectRepository().create({
      name: 'rail-ci-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/rail-ci-app',
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const adapterSpy = vi.spyOn(adapterFactory, 'getHostingAdapter');

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'rail-ci-app', env: 'production' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('does not build or push the image');
    expect(result.hint).toContain('hv_ci_trigger');
    expect(result.hint).toContain('deploy-railway-production.yml');
    expect(result.hint).toContain('Never dispatch or monitor this workflow with gh');
    expect(adapterSpy).not.toHaveBeenCalled();
    await t.close();
  });

  it('reconciles manual-mode native sources without implicitly deploying application code', async () => {
    const project = new ProjectRepository().create({
      name: 'manual-source-deploy-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-production',
        services: {
          web: {
            serviceId: 'rail-web',
            source: { repo: 'dave/billforge', branch: 'main' },
          },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web' },
      envVarSpec: {},
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          deploy: { strategy: 'manual' },
        },
      },
    });
    seedVerifiedConnection('railway');

    const observed = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rail-project',
      environmentId: 'rail-production',
      services: [{
        name: 'web',
        externalId: 'rail-web',
        workloadKind: 'web' as const,
        customDomains: [],
        config: {},
        source: { repo: 'dave/billforge', branch: 'main' },
        sourceState: 'connected' as const,
        envVarKeys: [],
        envVarHashes: {},
        status: 'running' as const,
      }],
      databases: [],
      completeness: {
        project: 'complete' as const,
        environment: 'complete' as const,
        services: 'complete' as const,
        databases: 'complete' as const,
        storage: 'complete' as const,
      },
      partial: false,
      warnings: [],
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsObserve: true },
        observe: async () => observed,
      } as never,
    });
    const disconnectDeploySource = vi.fn(async () => ({
      success: true,
      message: 'disconnected',
      data: { serviceId: 'rail-web' },
    }));
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        disconnectDeploySource,
      } as never,
    });
    const deploy = vi.fn();
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', deploy } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_deploy', {
      project: project.name,
      env: 'production',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'pending',
      environment: 'production',
      message: expect.stringContaining('application deployment has not started'),
    });
    expect(result.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:web:deploy-source',
      status: 'succeeded',
    }));
    expect(disconnectDeploySource).toHaveBeenCalledWith({ serviceId: 'rail-web' });
    expect(deploy).not.toHaveBeenCalled();
    expect(result.next).toEqual(['hv_deploy']);
    await t.close();
  });

  it('fails when provider status is deployed but the configured web health endpoint is not serving', async () => {
    const project = new ProjectRepository().create({ name: 'rail-health-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-env',
        services: { web: { serviceId: 'rail-web' } },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web', healthCheckPath: '/health' },
      envVarSpec: {},
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web', healthCheckPath: '/health' } },
        },
      },
    });
    seedVerifiedConnection('railway');

    const fakeAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: true,
      },
      async connect() {},
      async verify() { return { success: true }; },
      async ensureProject() { return { success: true, message: 'ok', data: { projectId: 'rail-project', environmentId: 'rail-env' } }; },
      async deploy() {
        return {
          serviceId: 'web',
          externalId: 'rail-web',
          url: 'https://web-production-e5e09.up.railway.app',
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars() { return { success: true, message: 'ok' }; },
      async getDeployStatus() {
        return { status: 'deployed', url: 'https://web-production-e5e09.up.railway.app' };
      },
      async observe() {
        return {
          provider: 'railway',
          observedAt: new Date().toISOString(),
          projectExists: true,
          projectId: 'rail-project',
          environmentId: 'rail-env',
          services: [{
            name: 'web',
            externalId: 'rail-web',
            workloadKind: 'web',
            customDomains: [],
            config: { healthCheckPath: '/health' },
            envVarKeys: [],
            envVarHashes: {},
            status: 'running',
            sourceState: 'disconnected',
          }],
          databases: [],
          storage: [],
          completeness: {
            project: 'complete',
            environment: 'complete',
            services: 'complete',
            databases: 'complete',
            storage: 'complete',
          },
          partial: false,
          warnings: [],
        };
      },
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeAdapter });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: fakeAdapter as never,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Application not found', { status: 404 }) as any
    );

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'rail-health-app', env: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.details.status).toBe('failed');
    expect(result.error.details.errors.join('\n')).toContain('web: HTTP 404 at https://web-production-e5e09.up.railway.app/health');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://web-production-e5e09.up.railway.app/health',
      expect.objectContaining({ method: 'GET' })
    );
    await t.close();
  });
});

describe('hv_deploy database env injection', () => {
  it('injects the managed database env vars into every deploy', async () => {
    const cloudrunPrepared = {
      cloudPreparation: {
        cloudrun: {
          provider: 'cloudrun',
          version: CLOUD_PREPARE_PROFILES.cloudrun.version,
          preparedAt: new Date().toISOString(),
          requiredApis: CLOUD_PREPARE_PROFILES.cloudrun.requiredApis,
          requiredRoles: CLOUD_PREPARE_PROFILES.cloudrun.requiredRoles,
        },
      },
    };
    const project = new ProjectRepository().create({ name: 'dbenv-app', defaultPlatform: 'cloudrun', policies: cloudrunPrepared });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
          'events-worker': { serviceId: 'gcp-project-events-worker' },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'events-worker',
      buildConfig: { workloadKind: 'worker' },
      envVarSpec: {},
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'cloudsql',
        connectionUrl: 'postgresql://app:pw@34.44.202.227:5432/app',
      },
      externalId: 'production-postgres',
    });

    const deployCalls: Array<{ service: string; envVars: Record<string, string> }> = [];
    const fakeAdapter: IHostingAdapter = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: false,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: false,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: true,
      },
      async connect() {},
      async verify() { return { success: true }; },
      async ensureProject() { return { success: true, message: 'ok', data: { projectId: 'gcp-project' } }; },
      async deploy(service, _environment, envVars) {
        deployCalls.push({ service: service.name, envVars: { ...envVars } });
        return {
          serviceId: service.id,
          externalId: `gcp-project-${service.name}`,
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars() { return { success: true, message: 'ok' }; },
      async getDeployStatus() { return { status: 'deployed' }; },
      async observe() {
        return {
          provider: 'cloudrun',
          observedAt: new Date().toISOString(),
          projectExists: true,
          projectId: 'gcp-project',
          services: [
            {
              name: 'web',
              externalId: 'gcp-project-web',
              workloadKind: 'web' as const,
              customDomains: [],
              config: {},
              envVarKeys: [],
              envVarHashes: {},
              status: 'running' as const,
              sourceState: 'disconnected' as const,
            },
            {
              name: 'events-worker',
              externalId: 'gcp-project-events-worker',
              workloadKind: 'worker' as const,
              customDomains: [],
              config: {},
              envVarKeys: [],
              envVarHashes: {},
              status: 'running' as const,
              sourceState: 'disconnected' as const,
            },
          ],
          databases: [],
          caches: [],
          storage: [],
          completeness: {
            project: 'complete' as const,
            environment: 'complete' as const,
            services: 'complete' as const,
            databases: 'unknown' as const,
            caches: 'complete' as const,
            storage: 'complete' as const,
          },
          partial: false,
          warnings: [],
        };
      },
    };
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'cloudrun' },
          services: {
            web: {},
            'events-worker': {
              workloadKind: 'worker',
              databaseEnvAliases: {
                POSTGRES_DB_URL: 'DATABASE_URL',
              },
            },
          },
          database: { provider: 'cloudsql' },
        },
      },
    });
    seedVerifiedConnection('cloudrun');
    seedVerifiedConnection('cloudsql');
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeAdapter });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: fakeAdapter as never,
    });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudsql',
        observeDatabase: async () => ({
          provider: 'cloudsql',
          engine: 'postgres',
          externalId: 'production-postgres',
          name: 'dbenv-app-production-postgres',
          status: 'running',
        }),
      } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'dbenv-app', env: 'production' });
    expect(result.ok).toBe(true);

    expect(deployCalls).toHaveLength(2);
    // The managed database URL is injected even though the caller passed no envVars.
    expect(deployCalls.find((call) => call.service === 'web')?.envVars.DATABASE_URL)
      .toBe('postgresql://app:pw@34.44.202.227:5432/app');
    expect(deployCalls.find((call) => call.service === 'web')?.envVars.POSTGRES_DB_URL)
      .toBeUndefined();
    expect(deployCalls.find((call) => call.service === 'events-worker')?.envVars)
      .toMatchObject({
        DATABASE_URL: 'postgresql://app:pw@34.44.202.227:5432/app',
        POSTGRES_DB_URL: 'postgresql://app:pw@34.44.202.227:5432/app',
      });

    // Sugar path: the deploy is recorded as a plan + apply run pair.
    expect(typeof result.data.planId).toBe('string');
    expect(typeof result.data.applyRunId).toBe('string');
    await t.close();
  });
});

describe('hv_rollback', () => {
  it('rejects conflicting rollback target types before resolving the project', async () => {
    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: 'missing-project',
      env: 'production',
      toRunId: '00000000-0000-4000-8000-000000000000',
      toSha: 'a'.repeat(40),
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('either toRunId or toSha');
    await t.close();
  });

  it('dispatches the previous verified exact-SHA release for managed production CI', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-ci-app');
    const currentSha = 'b'.repeat(40);
    const previousSha = 'a'.repeat(40);
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{
        id: 7,
        name: workflow.templateName,
        path: workflow.path,
        state: 'active',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
      }],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
      total_count: 2,
      workflow_runs: [
        workflowRun(20, 'completed', 'success', '2026-07-20T00:00:00Z'),
        workflowRun(10, 'completed', 'success', '2026-07-10T00:00:00Z'),
      ],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockImplementation(async (_owner, _repo, runId) => ({
      total_count: 1,
      artifacts: [runId === 20 ? releaseArtifact(20, currentSha) : releaseArtifact(10, previousSha)],
    }));
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      strategy: 'managed-ci',
      status: 'pending',
      pending: true,
      repository: `davejohnson/${project.name}`,
      workflow: workflow.path,
      ref: 'main',
      rollbackToSha: previousSha,
      currentSha,
      sourceArtifactId: 100,
      sourceWorkflowRunId: 10,
      observedLatestWorkflowRunId: 20,
      selection: 'previous_successful',
    });
    expect(result.data.receipts).toEqual([
      expect.objectContaining({
        actionId: 'ci:github-actions:production:rollback',
        status: 'pending',
      }),
    ]);
    expect(result.agentInstruction.action).toBe('stop_and_report');
    expect(trigger).toHaveBeenCalledWith(
      'davejohnson',
      project.name,
      workflow.path,
      'main',
      {
        commit_sha: previousSha,
        rollback: 'true',
        expected_latest_run_id: '20',
        source_artifact_id: '100',
        source_workflow_run_id: '10',
      }
    );

    const runRepo = new RunRepository();
    const plan = runRepo.findById(result.data.planId)!;
    const action = (plan.plan as Record<string, any>).actions[0];
    expect(action.metadata).toMatchObject({
      operation: 'githubActionsRollback',
      repository: `davejohnson/${project.name}`,
      workflow: workflow.path,
      ref: 'main',
      targetSha: previousSha,
      targetArtifactId: 100,
      targetWorkflowRunId: 10,
      observedLatestWorkflowRunId: 20,
    });
    await t.close();
  });

  it('restores the latest known-good exact SHA after a failed production promotion', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-failed-promotion-app');
    const knownGoodSha = 'c'.repeat(40);
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: workflow.templateName, path: workflow.path, state: 'active' } as any],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
      total_count: 2,
      workflow_runs: [
        workflowRun(30, 'completed', 'failure', '2026-07-30T00:00:00Z'),
        workflowRun(20, 'completed', 'success', '2026-07-20T00:00:00Z'),
      ],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockResolvedValue({
      total_count: 1,
      artifacts: [releaseArtifact(20, knownGoodSha)],
    });
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'pending',
      rollbackToSha: knownGoodSha,
      selection: 'last_known_good',
      observedLatestWorkflowRunId: 30,
    });
    expect(result.data.currentSha).toBeUndefined();
    expect(trigger).toHaveBeenCalledWith(
      'davejohnson',
      project.name,
      workflow.path,
      'main',
      {
        commit_sha: knownGoodSha,
        rollback: 'true',
        expected_latest_run_id: '30',
        source_artifact_id: '200',
        source_workflow_run_id: '20',
      }
    );
    await t.close();
  });

  it('restores an explicitly requested previously verified exact SHA', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-explicit-sha-app');
    const currentSha = 'c'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const requestedSha = 'a'.repeat(40);
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: workflow.templateName, path: workflow.path, state: 'active' } as any],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
      total_count: 3,
      workflow_runs: [
        workflowRun(30, 'completed', 'success', '2026-07-30T00:00:00Z'),
        workflowRun(20, 'completed', 'success', '2026-07-20T00:00:00Z'),
        workflowRun(10, 'completed', 'success', '2026-07-10T00:00:00Z'),
      ],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockImplementation(async (_owner, _repo, runId) => ({
      total_count: 1,
      artifacts: [
        runId === 30
          ? releaseArtifact(30, currentSha)
          : runId === 20
            ? releaseArtifact(20, previousSha)
            : releaseArtifact(10, requestedSha),
      ],
    }));
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      toSha: requestedSha,
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'pending',
      rollbackToSha: requestedSha,
      selection: 'explicit',
      sourceArtifactId: 100,
      sourceWorkflowRunId: 10,
    });
    expect(trigger).toHaveBeenCalledWith(
      'davejohnson',
      project.name,
      workflow.path,
      'main',
      {
        commit_sha: requestedSha,
        rollback: 'true',
        expected_latest_run_id: '30',
        source_artifact_id: '100',
        source_workflow_run_id: '10',
      }
    );
    await t.close();
  });

  it('blocks managed rollback when the generated workflow has drifted', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-workflow-drift-app');
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue('name: user-modified-workflow\n');
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: workflow.templateName, path: workflow.path, state: 'active' } as any],
    });
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('missing or differs');
    expect(result.next).toEqual(['hv_plan', 'hv_apply']);
    expect(trigger).not.toHaveBeenCalled();
    await t.close();
  });

  it('blocks managed rollback when GitHub release observation is unknown', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-observation-error-app');
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: workflow.templateName, path: workflow.path, state: 'active' } as any],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockRejectedValue(
      new Error('GitHub API rate limit prevented observation')
    );
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.message).toContain('Could not verify managed rollback evidence');
    expect(result.error.message).toContain('rate limit');
    expect(trigger).not.toHaveBeenCalled();
    await t.close();
  });

  it('blocks managed rollback when one run has ambiguous release identities', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-ambiguous-evidence-app');
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: workflow.templateName, path: workflow.path, state: 'active' } as any],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
      total_count: 2,
      workflow_runs: [
        workflowRun(20, 'completed', 'success', '2026-07-20T00:00:00Z'),
        workflowRun(10, 'completed', 'success', '2026-07-10T00:00:00Z'),
      ],
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockResolvedValue({
      total_count: 2,
      artifacts: [
        releaseArtifact(20, 'a'.repeat(40), 201),
        releaseArtifact(20, 'b'.repeat(40), 202),
      ],
    });
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.message).toContain('ambiguous production release evidence');
    expect(trigger).not.toHaveBeenCalled();
    await t.close();
  });

  it('re-observes the latest production run before dispatch and blocks stale authority', async () => {
    const { project, workflow } = seedManagedCiRollbackProject('rollback-stale-run-app');
    const currentSha = 'e'.repeat(40);
    const previousSha = 'd'.repeat(40);
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflows').mockResolvedValue({
      total_count: 1,
      workflows: [{ id: 7, name: workflow.templateName, path: workflow.path, state: 'active' } as any],
    });
    let read = 0;
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockImplementation(async () => {
      read += 1;
      return {
        total_count: read === 1 ? 2 : 3,
        workflow_runs: read === 1
          ? [
              workflowRun(20, 'completed', 'success', '2026-07-20T00:00:00Z'),
              workflowRun(10, 'completed', 'success', '2026-07-10T00:00:00Z'),
            ]
          : [
              workflowRun(30, 'completed', 'failure', '2026-07-30T00:00:00Z'),
              workflowRun(20, 'completed', 'success', '2026-07-20T00:00:00Z'),
              workflowRun(10, 'completed', 'success', '2026-07-10T00:00:00Z'),
            ],
      };
    });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockImplementation(async (_owner, _repo, runId) => ({
      total_count: 1,
      artifacts: [runId === 20 ? releaseArtifact(20, currentSha) : releaseArtifact(10, previousSha)],
    }));
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: project.name,
      env: 'production',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.details.status).toBe('blocked');
    expect(result.error.details.errors.join('\n')).toContain('newer workflow run');
    expect(trigger).not.toHaveBeenCalled();
    await t.close();
  });

  it('fails closed for an old direct-provider run without immutable release evidence and performs no provider mutation', async () => {
    const project = new ProjectRepository().create({ name: 'rollback-pair-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });

    // A prior successful deploy run with a deploy_web receipt is the target.
    const runRepo = new RunRepository();
    const priorRun = runRepo.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'deploy',
      plan: { steps: [] },
    });
    runRepo.addReceipt(priorRun.id, { step: 'deploy_web', status: 'success', timestamp: new Date().toISOString() });
    runRepo.updateStatus(priorRun.id, 'succeeded');

    const ensureProject = vi.fn(async () => ({ success: true, message: 'ok', data: { projectId: 'rp', environmentId: 're' } }));
    const deploy = vi.fn(async (service: { id: string }) => ({
      serviceId: service.id,
      externalId: 'rail-web',
      url: 'https://web.up.railway.app',
      status: 'deployed' as const,
      receipt: { success: true, message: 'deployed' },
    }));
    const setEnvVars = vi.fn(async () => ({ success: true, message: 'ok' }));
    const fakeAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: true,
      },
      async connect() {},
      async verify() { return { success: true }; },
      ensureProject,
      deploy,
      setEnvVars,
      async getDeployStatus() { return { status: 'deployed', url: 'https://web.up.railway.app' }; },
    };
    const adapterLookup = vi.spyOn(adapterFactory, 'getHostingAdapter')
      .mockResolvedValue({ success: true, adapter: fakeAdapter });
    const runIdsBefore = runRepo.findByEnvironmentId(environment.id).map((run) => run.id);

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: 'rollback-pair-app',
      env: 'staging',
      toRunId: priorRun.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNSUPPORTED');
    expect(result.error.message).toContain('do not retain verified immutable');
    expect(result.error.message).toContain('refuses to redeploy the current spec or checkout');
    expect(result.hint).toContain('Use hv_deploy only when you intend to deploy the current desired state');
    expect(adapterLookup).not.toHaveBeenCalled();
    expect(ensureProject).not.toHaveBeenCalled();
    expect(setEnvVars).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(runRepo.findByEnvironmentId(environment.id).map((run) => run.id)).toEqual(runIdsBefore);
    await t.close();
  });

  it('does not treat an arbitrary direct-provider toRunId as rollback authority', async () => {
    const project = new ProjectRepository().create({ name: 'rollback-invalid-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const adapterLookup = vi.spyOn(adapterFactory, 'getHostingAdapter');

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: 'rollback-invalid-app',
      env: 'staging',
      toRunId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNSUPPORTED');
    expect(result.error.message).toContain('cannot prove that a historical run can be restored');
    expect(adapterLookup).not.toHaveBeenCalled();
    await t.close();
  });

  it('confirm-gates rollbacks of protected environments', async () => {
    const project = new ProjectRepository().create({
      name: 'rollback-gate-app',
      policies: { protectedEnvironments: ['production'] },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });

    const t = await makeClient();
    const result = await t.call('hv_rollback', { project: 'rollback-gate-app', env: 'production' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });
});
