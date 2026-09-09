import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../domain/services/github-ops.service.js';
import { bootstrapActionResultFromSummary } from '../core.tools.js';
import { applyDatabaseSeed } from '../../application/apply-plan.js';
import { createToolContext } from '../../application/context.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { deriveHypervibeSecretValues } from '../../domain/services/hypervibe-secret-value.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-core-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client({ name: 'core-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const SPEC = {
  project: 'core-spec-app',
  environments: {
    staging: {
      hosting: { provider: 'railway' },
      services: { web: { startCommand: 'npm start' } },
      envVars: { NODE_ENV: 'staging' },
    },
  },
};

describe('bootstrap action receipt mapping', () => {
  it('fails domain actions when bootstrap records domain attachment or DNS errors', () => {
    const result = bootstrapActionResultFromSummary(
      {
        id: 'domain:apreskeys.com',
        resource: { kind: 'domain', name: 'apreskeys.com', provider: 'railway' },
      },
      {
        success: true,
        summary: {
          customDomainAttached: false,
          customDomainError: 'Problem processing request',
          domainDnsConfigured: false,
          domainDnsError: 'No Cloudflare connection available for apreskeys.com',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Problem processing request');
    expect(result.error).toContain('No Cloudflare connection available for apreskeys.com');
  });

  it('surfaces provider-specific bootstrap errors instead of generic bootstrap failed', () => {
    const result = bootstrapActionResultFromSummary(
      {
        id: 'service:web',
        resource: { kind: 'service', name: 'web', provider: 'railway' },
      },
      {
        success: false,
        summary: {
          sendgridApiKeySyncError: 'SendGrid API key is valid but cannot complete setupEmail. Missing domain-auth scopes.',
        },
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing domain-auth scopes');
    expect(result.error).not.toBe('bootstrap failed');
  });

  it('returns CI-pending bootstrap metadata on successful service actions', () => {
    const result = bootstrapActionResultFromSummary(
      {
        id: 'service:web',
        resource: { kind: 'service', name: 'web', provider: 'railway' },
      },
      {
        success: true,
        summary: {
          deploymentMode: 'provision',
          appDeploymentPending: true,
          deploymentDeferralRequested: true,
          runtimeRolloutRequired: true,
          rolloutBaselines: {
            web: { state: 'present', deploymentId: 'deployment-before-config' },
          },
          appDeployment: { status: 'pending_ci' },
          deploySource: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      deploymentMode: 'provision',
      appDeploymentPending: true,
      deploymentDeferred: true,
      runtimeRolloutRequired: true,
      rolloutBaselines: {
        web: { state: 'present', deploymentId: 'deployment-before-config' },
      },
      appDeployment: { status: 'pending_ci' },
      deploySource: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    });
  });
});

describe('hv_spec', () => {
  it('bootstraps the read-first MCP workflow in a completely new git repository', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-fresh-project-')));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', [
      'remote',
      'add',
      'origin',
      'git@github.com:davejohnson/fresh-agent-app.git',
    ], { cwd: repoDir });
    writeFileSync(path.join(repoDir, '.node-version'), '24\n', 'utf8');
    writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ engines: { node: '>=20' } }), 'utf8');

    let t: Awaited<ReturnType<typeof makeClient>> | null = null;
    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      new ProjectRepository().create({
        name: 'unrelated-existing-app',
        gitRemoteUrl: 'git@github.com:davejohnson/unrelated-existing-app.git',
      });
      t = await makeClient();

      const discovered = await t.call('hv_spec', {});
      expect(discovered).toMatchObject({
        ok: true,
        data: {
          initialized: false,
          project: {
            name: 'fresh-agent-app',
            gitRemoteUrl: 'git@github.com:davejohnson/fresh-agent-app.git',
          },
          revision: null,
          spec: null,
          repositoryRuntime: {
            status: 'detected',
            runtime: { kind: 'node', version: '24' },
          },
          bootstrap: {
            required: true,
            nextCommand: 'hv_spec',
            requiredSpecFields: ['project', 'environments'],
            suggestedRuntime: { kind: 'node', version: '24' },
          },
        },
        agentInstruction: { action: 'continue' },
        next: ['hv_spec'],
      });
      expect(discovered.hint).toContain('normal fresh-project state');
      expect(discovered.hint).toContain('Do not run hv_plan or hv_deploy');
      expect(new ProjectRepository().findByName('fresh-agent-app')).toBeNull();
      expect(new ProjectRepository().findByName('unrelated-existing-app')).toBeTruthy();

      const typo = await t.call('hv_spec', {
        project: 'fresh-agent-ap',
      });
      expect(typo).toMatchObject({
        ok: false,
        error: {
          code: 'NOT_FOUND',
          details: {
            requestedProject: 'fresh-agent-ap',
            repositoryProject: 'fresh-agent-app',
            registeredProjects: [
              expect.objectContaining({ name: 'unrelated-existing-app' }),
            ],
            registeredProjectCount: 1,
          },
        },
        agentInstruction: { action: 'continue' },
      });
      expect(typo.hint).toContain('Check the project name');
      expect(typo.hint).toContain('hv_spec({})');
      expect(new ProjectRepository().findByName('fresh-agent-ap')).toBeNull();

      const explicitDiscovery = await t.call('hv_spec', {
        project: 'fresh-agent-app',
      });
      expect(explicitDiscovery).toMatchObject({
        ok: true,
        data: {
          initialized: false,
          project: { name: 'fresh-agent-app' },
        },
        agentInstruction: { action: 'continue' },
      });
      expect(new ProjectRepository().findByName('fresh-agent-app')).toBeNull();

      const initialized = await t.call('hv_spec', {
        project: 'fresh-agent-app',
        spec: {
          project: 'fresh-agent-app',
          devops: {
            code: {
              provider: 'github',
              scope: 'davejohnson/fresh-agent-app',
              repository: { state: 'present', management: 'external', visibility: 'private', defaultBranch: 'main' },
            },
            ci: { provider: 'github-actions', runner: { mode: 'provider-hosted' } },
            canonicalEnvironment: 'staging',
          },
          environments: {
            staging: {
              hosting: { provider: 'railway' },
              services: { web: { startCommand: 'npm start' } },
              deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
            },
          },
        },
      });
      expect(initialized.ok).toBe(true);
      expect(initialized.data.revision).toBe(1);
      expect(initialized.data.spec.runtime).toEqual({ kind: 'node', version: '24' });
      expect(initialized.data.runtimeReview).toMatchObject({ status: 'review-required' });
      expect(initialized.data.project).toMatchObject({
        name: 'fresh-agent-app',
        gitRemoteUrl: 'git@github.com:davejohnson/fresh-agent-app.git',
      });
      expect(new ProjectRepository().findByName('fresh-agent-app')).toMatchObject({
        gitRemoteUrl: 'git@github.com:davejohnson/fresh-agent-app.git',
        defaultPlatform: 'railway',
      });
      expect(JSON.parse(
        readFileSync(path.join(repoDir, '.hypervibe', 'spec.json'), 'utf8')
      )).toMatchObject({
        project: 'fresh-agent-app',
        runtime: { kind: 'node', version: '24' },
      });
      const initializedLocalEnv = readFileSync(path.join(repoDir, '.env'), 'utf8');
      for (const key of ['HYPERVIBE_GITHUB_TOKEN', 'HYPERVIBE_RAILWAY_TOKEN']) {
        expect(initializedLocalEnv).toMatch(new RegExp(`# Hypervibe: [^\\n]+\\n${key}=`));
      }
      expect(initialized.data.localEnv.addedKeys).toEqual([
        'HYPERVIBE_GITHUB_TOKEN',
        'HYPERVIBE_RAILWAY_TOKEN',
      ]);
      expect(initializedLocalEnv).toContain('GitHub API token for repository and workflow management');
      expect(initializedLocalEnv).not.toContain('GitHub Packages read token');

      rmSync(path.join(repoDir, '.env'));

      const plan = await t.call('hv_plan', {
        project: 'fresh-agent-app',
        env: 'staging',
      });
      expect(plan.ok).toBe(true);
      expect(plan.data.blocked).toContainEqual(expect.objectContaining({
        provider: 'railway',
      }));
      expect(plan.data.blocked).toContainEqual(expect.objectContaining({
        provider: 'github',
      }));
      expect(plan.data.localEnv.addedKeys).toEqual([
        'HYPERVIBE_GITHUB_TOKEN',
        'HYPERVIBE_RAILWAY_TOKEN',
        'NODE_AUTH_TOKEN',
      ]);
      expect(readFileSync(path.join(repoDir, '.env'), 'utf8')).toContain('HYPERVIBE_GITHUB_TOKEN=');
    } finally {
      if (t) await t.close();
      process.chdir(oldCwd);
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refreshes local-spec env placeholders only from the matching project checkout', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-local-spec-')));
    const projectName = path.basename(repoDir);
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    process.env.HYPERVIBE_DISABLE_REPO_SPEC = '1';
    process.chdir(repoDir);
    let t: Awaited<ReturnType<typeof makeClient>> | undefined;

    try {
      t = await makeClient();
      const set = await t.call('hv_spec', {
        spec: {
          project: projectName,
          secrets: {
            SESSION_SECRET: {
              principal: 'github:owner',
              environments: ['staging'],
            },
          },
          environments: {
            staging: {
              hosting: { provider: 'railway' },
              services: { web: { startCommand: 'npm start' } },
            },
          },
        },
      });

      expect(set.ok).toBe(true);
      expect(set.data.specSource).toEqual({ kind: 'local' });
      expect(readFileSync(path.join(repoDir, '.env'), 'utf8'))
        .toMatch(/# Hypervibe: [^\n]+\nSESSION_SECRET=/);
      expect(readFileSync(path.join(repoDir, '.gitignore'), 'utf8')).toContain('/.env');
    } finally {
      if (t) await t.close();
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps hv_spec and hv_plan from writing local-project env slots into a checkout with a conflicting repo spec', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const parentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-conflicting-checkout-')));
    const repoDir = path.join(parentDir, 'selected-local-app');
    mkdirSync(repoDir);
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    execFileSync('git', [
      'remote',
      'add',
      'origin',
      'git@github.com:davejohnson/selected-local-app.git',
    ], { cwd: repoDir });
    process.chdir(repoDir);
    let t: Awaited<ReturnType<typeof makeClient>> | undefined;

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '1';
      const project = new ProjectRepository().create({
        name: 'selected-local-app',
        gitRemoteUrl: 'git@github.com:davejohnson/selected-local-app.git',
        defaultPlatform: 'railway',
        policies: {},
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        secrets: {
          SESSION_SECRET: {
            principal: 'github:owner',
            environments: ['production'],
          },
        },
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
          },
        },
      });

      const foreignSpec = projectSpecSchema.parse({
        version: 1,
        project: 'foreign-checkout-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
          },
        },
      });
      mkdirSync(path.join(repoDir, '.hypervibe'));
      const specPath = path.join(repoDir, '.hypervibe', 'spec.json');
      const foreignDocument = `${JSON.stringify(foreignSpec, null, 2)}\n`;
      writeFileSync(specPath, foreignDocument, 'utf8');
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      t = await makeClient();

      const updated = await t.call('hv_spec', {
        project: project.name,
        spec: {
          secrets: {
            SECOND_SECRET: {
              principal: 'github:owner',
              environments: ['production'],
            },
          },
        },
      });
      expect(updated.ok).toBe(true);
      expect(updated.data.specSource).toEqual({ kind: 'local' });
      expect(updated.data.localEnv).toBeNull();
      expect(updated.data.envTemplate).toBeNull();

      const plan = await t.call('hv_plan', {
        project: project.name,
        env: 'production',
      });
      expect(plan.ok).toBe(true);
      expect(plan.data.specSource).toEqual({ kind: 'local' });
      expect(plan.data.localEnv).toBeUndefined();
      expect(readFileSync(specPath, 'utf8')).toBe(foreignDocument);
      for (const fileName of ['.env', '.env.example', '.env.production', '.gitignore']) {
        expect(existsSync(path.join(repoDir, fileName))).toBe(false);
      }
    } finally {
      if (t) await t.close();
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'a different origin',
      origin: 'git@github.com:someone-else/selected-project-b.git',
    },
    { label: 'no readable origin', origin: undefined },
  ])('keeps hv_spec from claiming a same-named spec-less checkout with $label', async ({ origin }) => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const parentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-unrelated-checkout-')));
    const repoDir = path.join(parentDir, 'selected-project-b');
    mkdirSync(repoDir);
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    if (origin) {
      execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repoDir });
    }
    writeFileSync(path.join(repoDir, 'tracked.txt'), 'tracked-before\n', 'utf8');
    execFileSync('git', ['add', '--', 'tracked.txt'], { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'untracked.txt'), 'untracked-before\n', 'utf8');
    process.chdir(repoDir);
    let t: Awaited<ReturnType<typeof makeClient>> | undefined;

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '1';
      const project = new ProjectRepository().create({
        name: 'selected-project-b',
        gitRemoteUrl: 'git@github.com:davejohnson/selected-project-b.git',
        defaultPlatform: 'railway',
        policies: {},
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
          },
        },
      });
      const statusBefore = execFileSync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: repoDir, encoding: 'utf8' }
      );

      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      t = await makeClient();
      const updated = await t.call('hv_spec', {
        project: project.name,
        spec: {
          secrets: {
            SESSION_SECRET: {
              principal: 'github:owner',
              environments: ['production'],
            },
          },
        },
      });

      expect(updated.ok).toBe(true);
      expect(updated.data.specSource).toEqual({ kind: 'local' });
      expect(updated.data.localEnv).toBeNull();
      expect(updated.data.envTemplate).toBeNull();
      expect(readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe('tracked-before\n');
      expect(readFileSync(path.join(repoDir, 'untracked.txt'), 'utf8')).toBe('untracked-before\n');
      expect(execFileSync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: repoDir, encoding: 'utf8' }
      )).toBe(statusBefore);
      for (const fileName of ['.env', '.env.example', '.gitignore', '.hypervibe']) {
        expect(existsSync(path.join(repoDir, fileName))).toBe(false);
      }
    } finally {
      if (t) await t.close();
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('creates a project, stores the spec, and bumps revisions on merge', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec', { spec: SPEC });
    expect(set.ok).toBe(true);
    expect(set.data.revision).toBe(1);
    expect(set.next).toContain('hv_plan');

    const merge = await t.call('hv_spec', {
      project: 'core-spec-app',
      spec: { environments: { staging: { services: { worker: { workloadKind: 'worker' } } } } },
    });
    expect(merge.data.revision).toBe(2);

    const project = new ProjectRepository().findByName('core-spec-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        services: {
          web: {
            serviceId: 'svc-web',
            url: 'https://user:password@unsafe.example.com/private?token=secret',
            customDomains: ['app.example.com/path?ignored=1'],
          },
        },
      },
    });

    const get = await t.call('hv_spec', { project: 'core-spec-app' });
    expect(get.ok).toBe(true);
    expect(Object.keys(get.data.spec.environments.staging.services)).toEqual(['web', 'worker']);
    expect(get.data).not.toHaveProperty('environments');
    await t.close();
  });

  it('rejects a spec project that contradicts the selected project', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });

    const existingMismatch = await t.call('hv_spec', {
      project: 'core-spec-app',
      spec: { project: 'other-app' },
    });
    expect(existingMismatch.ok).toBe(false);
    expect(existingMismatch.error.code).toBe('VALIDATION');
    expect(existingMismatch.error.details).toEqual({
      selectedProject: 'core-spec-app',
      specProject: 'other-app',
    });
    expect(new SpecStore().get(new ProjectRepository().findByName('core-spec-app')!)?.revision).toBe(1);

    const newMismatch = await t.call('hv_spec', {
      project: 'new-selected-app',
      spec: { project: 'new-other-app', environments: {} },
    });
    expect(newMismatch.ok).toBe(false);
    expect(newMismatch.error.code).toBe('VALIDATION');
    expect(new ProjectRepository().findByName('new-selected-app')).toBeNull();
    expect(new ProjectRepository().findByName('new-other-app')).toBeNull();
    await t.close();
  });

  it('persists top-level gitRemoteUrl into project metadata', async () => {
    const t = await makeClient();
    const gitRemoteUrl = 'git@github.com:davejohnson/apreskeys.com.git';
    const set = await t.call('hv_spec', {
      spec: {
        ...SPEC,
        project: 'remote-spec-app',
        gitRemoteUrl,
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(new ProjectRepository().findByName('remote-spec-app')!.gitRemoteUrl).toBe(gitRemoteUrl);

    const get = await t.call('hv_spec', { project: 'remote-spec-app' });
    expect(get.ok).toBe(true);
    expect(get.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(get.data.spec.gitRemoteUrl).toBe(gitRemoteUrl);
    await t.close();
  });

  it('syncs gitRemoteUrl from a merge patch into an existing project', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    const gitRemoteUrl = 'https://github.com/davejohnson/apreskeys.com.git';

    const merge = await t.call('hv_spec', {
      project: 'core-spec-app',
      spec: { gitRemoteUrl },
    });
    expect(merge.ok).toBe(true);
    expect(merge.data.project.gitRemoteUrl).toBe(gitRemoteUrl);
    expect(new ProjectRepository().findByName('core-spec-app')!.gitRemoteUrl).toBe(gitRemoteUrl);
    await t.close();
  });

  it('rejects invalid specs with field-level details', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec', {
      spec: {
        project: 'bad-app',
        environments: { staging: { hosting: { provider: 'railway' }, services: { job: { workloadKind: 'cron' } } } },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('VALIDATION');
    expect(JSON.stringify(bad.error.details)).toContain('cronSchedule');
    expect(new ProjectRepository().findByName('bad-app')).toBeNull();
    await t.close();
  });

  it('blocks a new runtime key that is missing from a matching release environment', async () => {
    const t = await makeClient();
    const result = await t.call('hv_spec', {
      spec: {
        project: 'coverage-block-app',
        environments: {
          staging: { hosting: { provider: 'railway' }, services: { web: {} } },
          production: {
            hosting: { provider: 'railway' },
            services: { web: {} },
            envVars: { RECAPTCHA_SITE_KEY: 'production-site-id' },
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Environment-variable coverage is incomplete.' },
    });
    expect(result.error.details).toContainEqual(expect.objectContaining({
      key: 'RECAPTCHA_SITE_KEY',
      environment: 'staging',
      reason: 'missing_environment',
    }));
    expect(result.hint).toContain('separately chosen');
    expect(result.hint).toContain('envVarExceptions');
    expect(JSON.stringify(result)).not.toContain('production-site-id');
    expect(new ProjectRepository().findByName('coverage-block-app')).toBeNull();
    await t.close();
  });

  it('accepts separate values, delegated slots, and explicit environment exceptions', async () => {
    const t = await makeClient();
    const result = await t.call('hv_spec', {
      spec: {
        project: 'coverage-complete-app',
        secrets: {
          RECAPTCHA_SECRET_KEY: {
            principal: 'github:dave',
            environments: ['staging', 'production'],
          },
        },
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: {} },
            envVars: { RECAPTCHA_SITE_KEY: 'staging-site-id' },
            envVarExceptions: ['PRODUCTION_ONLY_FLAG'],
          },
          production: {
            hosting: { provider: 'railway' },
            services: { web: {} },
            envVars: {
              RECAPTCHA_SITE_KEY: 'production-site-id',
              PRODUCTION_ONLY_FLAG: 'enabled',
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data.environmentVariableCoverage).toEqual({ complete: true, issues: [] });
    expect(result.data.spec.secrets.RECAPTCHA_SECRET_KEY.environments).toEqual(['staging', 'production']);
    await t.close();
  });

  it('blocks adding a matching environment until existing runtime keys are covered', async () => {
    const t = await makeClient();
    const initial = await t.call('hv_spec', {
      spec: {
        project: 'coverage-expansion-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: {} },
            envVars: { SITE_KEY: 'production-id' },
          },
        },
      },
    });
    expect(initial.ok).toBe(true);

    const expanded = await t.call('hv_spec', {
      project: 'coverage-expansion-app',
      spec: {
        environments: {
          staging: { hosting: { provider: 'railway' }, services: { web: {} } },
        },
      },
    });

    expect(expanded).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(expanded.error.details).toContainEqual(expect.objectContaining({
      key: 'SITE_KEY', environment: 'staging',
    }));
    await t.close();
  });

  it('grandfathers pre-existing gaps without allowing new ones', async () => {
    const project = new ProjectRepository().create({ name: 'legacy-coverage-app' });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: { hosting: { provider: 'railway' }, services: { web: {} } },
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          envVars: { LEGACY_GAP: 'production-only' },
        },
      },
    }));
    const t = await makeClient();
    const unrelated = await t.call('hv_spec', {
      project: project.name,
      spec: { gitRemoteUrl: 'git@github.com:davejohnson/legacy-coverage-app.git' },
    });

    expect(unrelated.ok).toBe(true);
    expect(unrelated.data.environmentVariableCoverage.complete).toBe(false);
    expect(unrelated.warnings).toContainEqual(expect.stringContaining('pre-existing'));
    expect(JSON.stringify(unrelated.data.environmentVariableCoverage)).not.toContain('production-only');
    await t.close();
  });

  it('rejects unknown hosting providers with the available list', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec', {
      spec: {
        project: 'bad-provider-app',
        environments: { staging: { hosting: { provider: 'definitely-not-real' }, services: {} } },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('VALIDATION');
    expect(bad.hint).toContain('railway');
    expect(new ProjectRepository().findByName('bad-provider-app')).toBeNull();
    await t.close();
  });

  it('rejects unsupported hosting workload kinds before creating project state', async () => {
    const t = await makeClient();
    const bad = await t.call('hv_spec', {
      spec: {
        project: 'unsupported-workload-app',
        environments: {
          staging: {
            hosting: { provider: 'ecs' },
            services: {
              processor: { workloadKind: 'worker', startCommand: 'npm run worker' },
            },
          },
        },
      },
    });

    expect(bad).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        details: {
          path: 'environments.staging.services.processor.workloadKind',
          workloadKind: 'worker',
        },
      },
    });
    expect(bad.error.message).toContain('ecs hosting does not support workload kind "worker"');
    expect(bad.hint).toContain('Supported workload kinds for ecs: web');
    expect(new ProjectRepository().findByName('unsupported-workload-app')).toBeNull();
    await t.close();
  });

  it('rejects application-managed queue constraints before project or provider mutation', async () => {
    const t = await makeClient();
    const adapterSpy = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const missingDatabase = await t.call('hv_spec', {
      spec: {
        project: 'postgres-queue-database-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { jobs: { workloadKind: 'worker' } },
            queues: { jobs: {} },
          },
        },
      },
    });
    expect(missingDatabase).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        details: {
          path: 'environments.staging.queues',
          capability: 'queue',
        },
      },
    });
    expect(missingDatabase.error.message).toContain('require a declared PostgreSQL database');
    expect(new ProjectRepository().findByName('postgres-queue-database-app')).toBeNull();

    const bad = await t.call('hv_spec', {
      spec: {
        project: 'postgres-queue-option-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            database: { provider: 'railway' },
            services: { jobs: { workloadKind: 'worker' } },
            queues: { jobs: { ackDeadlineSeconds: 120 } },
          },
        },
      },
    });

    expect(bad).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        details: {
          path: 'environments.staging.queues.jobs.ackDeadlineSeconds',
          capability: 'queue',
        },
      },
    });
    expect(bad.error.message).toContain('do not support ackDeadlineSeconds');
    expect(bad.hint).toContain('provider-managed Pub/Sub queues');
    expect(new ProjectRepository().findByName('postgres-queue-option-app')).toBeNull();
    expect(adapterSpy).not.toHaveBeenCalled();
    await t.close();
  });

  it('requires confirmation before switching branch deploys to provider-native integrations', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'native-switch-app',
        gitRemoteUrl: 'git@github.com:davejohnson/native-switch-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });

    const bad = await t.call('hv_spec', {
      project: 'native-switch-app',
      spec: {
        environments: {
          production: {
            deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
          },
        },
      },
    });

    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('CONFIRM_REQUIRED');
    expect(bad.error.details).toContainEqual(expect.objectContaining({
      environment: 'production',
      provider: 'railway',
    }));
    expect(bad.hint).toContain('Do not switch from trigger="ci" to trigger="native"');

    const get = await t.call('hv_spec', { project: 'native-switch-app' });
    expect(get.data.spec.environments.production.deploy.trigger).toBe('ci');
    await t.close();
  });

  it('allows provider-native branch deploys when explicitly confirmed', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec', {
      confirmNativeDeploy: true,
      spec: {
        project: 'native-confirmed-app',
        gitRemoteUrl: 'git@github.com:davejohnson/native-confirmed-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'native', branch: 'main' },
          },
        },
      },
    });

    expect(set.ok).toBe(true);
    expect(set.data.spec.environments.production.deploy.trigger).toBe('native');
    expect(set.warnings).toContainEqual(expect.stringContaining('Railway native deploys require the Railway GitHub App'));
    await t.close();
  });

  it('returns required connection setup immediately from the desired spec', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec', {
      spec: {
        project: 'connection-check-app',
        gitRemoteUrl: 'git@github.com:davejohnson/connection-check-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'connection-check-app.com',
            domainRegistration: { provider: 'cloudflare' },
            email: { enabled: true },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.connections.missing.map((entry: { provider: string }) => entry.provider).sort()).toEqual([
      'cloudflare',
      'github',
      'railway',
      'sendgrid',
    ]);
    const cloudflare = set.data.connections.missing.find((entry: { provider: string }) => entry.provider === 'cloudflare');
    const github = set.data.connections.missing.find((entry: { provider: string }) => entry.provider === 'github');
    expectActionableConnectionSetup(cloudflare.connectionSetup, {
      provider: 'cloudflare',
      project: 'connection-check-app',
      scope: 'connection-check-app.com',
    });
    expectActionableConnectionSetup(github.connectionSetup, {
      provider: 'github',
      project: 'connection-check-app',
    });
    expect(github.connectionSetup.localEnvInputs.map((input: { envKey: string }) => input.envKey)).toEqual([
      'HYPERVIBE_GITHUB_TOKEN',
    ]);
    expect(cloudflare.connectionSetup.localEnvInputs.map((input: { envKey: string }) => input.envKey)).toEqual([
      'CLOUDFLARE_API_TOKEN',
    ]);
    expect(set.hint).toContain('This task needs provider access that is not connected on this Mac');
    expect(set.hint).toContain('connectionSetup');
    expect(set.next).toEqual(['hv_connections', 'hv_plan']);
    await t.close();
  });

  it('treats repository-only Pages as project desired state and defaults planning to repository', async () => {
    const t = await makeClient();
    const set = await t.call('hv_spec', {
      spec: {
        project: 'pages-only-app',
        gitRemoteUrl: 'git@github.com:davejohnson/pages-only-app.git',
        github: {
          canonicalEnvironment: 'repository',
          pages: { sourcePath: 'apps/website', customDomain: 'pages-only-app.dev' },
        },
        environments: {},
      },
    });

    expect(set.ok).toBe(true);
    expect(set.data.connections.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'cloudflare', scope: 'pages-only-app.dev', environments: ['repository'] }),
      expect.objectContaining({ provider: 'github', scope: 'davejohnson/pages-only-app', environments: ['repository'] }),
    ]));

    const plan = await t.call('hv_plan', { project: 'pages-only-app' });
    expect(plan.ok).toBe(true);
    expect(plan.data.environment).toBe('repository');
    expect(plan.data.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'repo:github-infrastructure-pr', type: 'update' }),
    ]));

    const withoutDeployEnvFile = await t.call('hv_plan', {
      project: 'pages-only-app',
      includeEnvFile: false,
    });
    expect(withoutDeployEnvFile.ok).toBe(true);
    expect(withoutDeployEnvFile.data.environment).toBe('repository');
    await t.close();
  });

  it('does not treat a verified Cloudflare connection for another zone as domain-ready', async () => {
    const repo = new ConnectionRepository();
    const otherZone = repo.create({
      provider: 'cloudflare',
      scope: 'other.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cf-token' }),
    });
    repo.updateStatus(otherZone.id, 'verified');

    const t = await makeClient();
    const set = await t.call('hv_spec', {
      spec: {
        project: 'wrong-zone-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'staging.apreskeys.com',
          },
        },
      },
    });
    expect(set.ok).toBe(true);
    expect(set.data.connections.missing).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      status: 'missing',
      scope: 'apreskeys.com',
    }));
    await t.close();
  });

  it('hydrates a local project from repo-backed desired state and sees teammate spec edits', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-team-spec-')));
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    mkdirSync(path.join(repoDir, '.hypervibe'));
    const specPath = path.join(repoDir, '.hypervibe', 'spec.json');
    const repoSpec = {
      version: 1,
      project: 'team-shared-app',
      gitRemoteUrl: 'git@github.com:davejohnson/team-shared-app.git',
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
          envVars: { NODE_ENV: 'production' },
        },
      },
    };
    writeFileSync(specPath, `${JSON.stringify(repoSpec, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(repoDir, '.hypervibe', 'bindings.json'), `${JSON.stringify({
      version: 1,
      project: 'team-shared-app',
      environments: {
        production: {
          platformBindings: {
            provider: 'railway',
            projectId: 'rp-shared',
            environmentId: 're-production',
            apiToken: 'should-not-hydrate',
            connectionString: 'postgres://user:secret@example.com/db',
            services: { web: { serviceId: 'svc-web', deployToken: 'should-not-hydrate' } },
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    let t: Awaited<ReturnType<typeof makeClient>> | null = null;
    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      t = await makeClient();

      const get = await t.call('hv_spec', {});
      expect(get.ok).toBe(true);
      expect(get.data.project.name).toBe('team-shared-app');
      expect(get.data.project.gitRemoteUrl).toBe('git@github.com:davejohnson/team-shared-app.git');
      expect(get.data.specSource).toEqual({ kind: 'repo', path: specPath });
      const project = new ProjectRepository().findByName('team-shared-app')!;
      expect(project).toBeTruthy();
      expect(new EnvironmentRepository().findByProjectAndName(project.id, 'production')!.platformBindings).toMatchObject({
        provider: 'railway',
        projectId: 'rp-shared',
        environmentId: 're-production',
        services: { web: { serviceId: 'svc-web' } },
      });
      const hydratedBindings = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!.platformBindings as {
        apiToken?: string;
        connectionString?: string;
        services?: { web?: { deployToken?: string } };
      };
      expect(hydratedBindings.apiToken).toBeUndefined();
      expect(hydratedBindings.connectionString).toBeUndefined();
      expect(hydratedBindings.services?.web?.deployToken).toBeUndefined();

      const envRepo = new EnvironmentRepository();
      const hydratedEnvironment = envRepo.findByProjectAndName(project.id, 'production')!;
      envRepo.updatePlatformBindings(hydratedEnvironment.id, {
        ci: {
          deployBranch: {
            '.github/workflows/deploy-railway-production.yml': {
              contentHash: 'workflow-hash',
              syncedSecrets: ['IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: { IMAGE_REGISTRY_TOKEN: 'local-secret-hash' },
            },
          },
        },
        github: {
          pagesCertificateAttempt: { domain: 'team-shared-app.example.com' },
          openAIActionsSecretName: 'OPENAI_API_KEY',
          openAIActionsSecretHash: 'local-openai-secret-hash',
          openAIActionsSecretSyncedAt: '2026-08-20T00:00:00.000Z',
        },
      });
      await t.close();
      t = await makeClient();
      await t.call('hv_spec', {});
      expect(
        new EnvironmentRepository()
          .findByProjectAndName(project.id, 'production')!
          .platformBindings
      ).toMatchObject({
        ci: {
          deployBranch: {
            '.github/workflows/deploy-railway-production.yml': {
              contentHash: 'workflow-hash',
              syncedSecrets: ['IMAGE_REGISTRY_TOKEN'],
              syncedSecretHashes: { IMAGE_REGISTRY_TOKEN: 'local-secret-hash' },
            },
          },
        },
        github: {
          pagesCertificateAttempt: { domain: 'team-shared-app.example.com' },
          openAIActionsSecretName: 'OPENAI_API_KEY',
          openAIActionsSecretHash: 'local-openai-secret-hash',
          openAIActionsSecretSyncedAt: '2026-08-20T00:00:00.000Z',
        },
      });

      writeFileSync(specPath, `${JSON.stringify({
        ...repoSpec,
        environments: {
          production: {
            ...repoSpec.environments.production,
            services: {
              ...repoSpec.environments.production.services,
              daily: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
            },
          },
        },
      }, null, 2)}\n`, 'utf8');

      const updated = await t.call('hv_spec', {});
      expect(updated.ok).toBe(true);
      expect(updated.data.revision).toBe(2);
      expect(Object.keys(updated.data.spec.environments.production.services)).toEqual(['web', 'daily']);
      expect(updated.data.spec.environments.production.services.daily).toMatchObject({
        workloadKind: 'cron',
        cronSchedule: '0 8 * * *',
      });
    } finally {
      if (t) await t.close();
      process.chdir(oldCwd);
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('hv_plan / hv_status / hv_apply', () => {
  function sha256(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  function storedPlanAction(planId: string, actionId: string): PlanAction | undefined {
    const plan = new RunRepository().findById(planId)?.plan as { actions?: PlanAction[] } | undefined;
    return plan?.actions?.find((action) => action.id === actionId);
  }

  function verifyConnection(provider: string, credentials: Record<string, unknown> = { apiToken: `${provider}-token` }) {
    const repo = new ConnectionRepository();
    const conn = repo.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    repo.updateStatus(conn.id, 'verified');
  }

  function verifyRailwayConnection() {
    verifyConnection('railway');
  }

  function mockObserved(observed: ObservedState | null) {
    const normalizedObserved = observed
      ? {
        ...observed,
        services: observed.services.map((service) => ({
          ...service,
          sourceState: service.sourceState ?? (service.source ? 'connected' : 'disconnected'),
        })),
      }
      : null;
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue(
      normalizedObserved
        ? {
          success: true,
          adapter: {
            name: 'railway',
            capabilities: {
              supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
              supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
              supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
              supportsObserve: true,
            },
            connect: async () => {}, verify: async () => ({ success: true }),
            ensureProject: async () => ({ success: true, message: 'ok' }),
            ensureComponent: async () => { throw new Error('unused'); },
            deploy: async () => { throw new Error('unused'); },
            setEnvVars: async () => ({ success: true, message: 'ok' }),
            observe: async () => normalizedObserved,
          },
        }
        : { success: false, error: 'no adapter' }
    );
  }

  it('rejects a stored unsupported workload spec before provider observation or planning', async () => {
    const project = new ProjectRepository().create({ name: 'stored-unsupported-workload-app' });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'vercel' },
          services: {
            scheduled: {
              workloadKind: 'cron',
              startCommand: 'npm run scheduled',
              cronSchedule: '0 * * * *',
            },
          },
        },
      },
    }));
    const adapterSpy = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const t = await makeClient();

    const plan = await t.call('hv_plan', {
      project: project.name,
      env: 'staging',
    });

    expect(plan).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION',
        details: {
          path: 'environments.staging.services.scheduled.workloadKind',
          workloadKind: 'cron',
        },
      },
    });
    expect(adapterSpy).not.toHaveBeenCalled();
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
    await t.close();
  });

  it('refuses an unsafe tracked .env before persisting a plan', async () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-plan-env-safety-')));
    const projectName = path.basename(repoDir);
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    process.chdir(repoDir);
    process.env.HYPERVIBE_DISABLE_REPO_SPEC = '1';
    const project = new ProjectRepository().create({ name: projectName });
    new SpecStore().replace(project, {
      version: 1,
      project: projectName,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
        },
      },
    });
    writeFileSync(path.join(repoDir, '.env'), 'LOCAL_VALUE=test-only\n', 'utf8');
    execFileSync('git', ['add', '--force', '.env'], { cwd: repoDir });
    process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
    let t: Awaited<ReturnType<typeof makeClient>> | undefined;

    try {
      t = await makeClient();
      const runsBefore = new RunRepository().findByProjectId(project.id);

      const plan = await t.call('hv_plan', { project: projectName, env: 'staging' });

      expect(plan).toMatchObject({
        ok: false,
        error: {
          code: 'INTERNAL',
          message: expect.stringContaining('git already tracks .env'),
        },
      });
      expect(new RunRepository().findByProjectId(project.id)).toEqual(runsBefore);
    } finally {
      if (t) await t.close();
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('plans creates for a fresh environment and blocks without connections', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.verified).toBe(false);
    expect(plan.data.summary.create).toBeGreaterThan(0);
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({ provider: 'railway' }));
    expect(plan.hint).toContain('hv_connections');
    await t.close();
  });

  it('adopts an exact Railway domain on a bound service even when the legacy binding omitted its hostname', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'legacy-domain-adoption-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: {
              web: {
                startCommand: 'npm start',
                public: true,
              },
            },
            domain: 'staging.example.com',
            envVars: { NODE_ENV: 'staging' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare');
    const project = new ProjectRepository().findByName('legacy-domain-adoption-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: {
          web: {
            serviceId: 'svc-1',
          },
        },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: ['staging.example.com'],
        customDomainStatus: {
          'staging.example.com': {
            providerDomainId: 'provider-domain-1',
            providerVerified: true,
            certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID',
            dnsConfigured: false,
          },
        },
        config: { startCommand: 'npm start', public: true },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
      },
      partial: false,
      warnings: [],
    });

    const before = await t.call('hv_status', {
      project: project.name,
      env: 'staging',
    });
    expect(before.ok).toBe(true);
    expect(before.data.drift).toContainEqual(expect.objectContaining({
      id: 'domain:staging.example.com',
      type: 'update',
      metadata: expect.objectContaining({
        operation: 'customDomainAdopt',
        providerDomainId: 'provider-domain-1',
        projectId: 'rp-1',
        serviceName: 'web',
        serviceId: 'svc-1',
        environmentId: 're-1',
      }),
    }));

    const plan = await t.call('hv_plan', {
      project: project.name,
      env: 'staging',
    });
    const domainAction = storedPlanAction(
      plan.data.planId,
      'domain:staging.example.com'
    );
    expect(domainAction).toMatchObject({
      type: 'update',
      metadata: { operation: 'customDomainAdopt' },
    });

    const apply = await t.call('hv_apply', {
      project: project.name,
      planId: plan.data.planId,
    });
    expect(apply.ok).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:staging.example.com',
      status: 'succeeded',
      data: expect.objectContaining({
        applied: 1,
        skipped: 0,
        providerMutations: 0,
        providerDomainId: 'provider-domain-1',
      }),
    }));
    expect(new EnvironmentRepository()
      .findByProjectAndName(project.id, 'staging')?.platformBindings)
      .toMatchObject({
        domainDns: {
          name: 'staging.example.com',
          proxied: true,
          providerDomainId: 'provider-domain-1',
          serviceName: 'web',
          serviceId: 'svc-1',
          environmentId: 're-1',
        },
      });

    const after = await t.call('hv_status', {
      project: project.name,
      env: 'staging',
    });
    expect(after.ok).toBe(true);
    expect(after.data.inSync).toBe(true);
    expect(after.data.drift).not.toContainEqual(expect.objectContaining({
      id: 'domain:staging.example.com',
    }));
    await t.close();
  });

  it('plans Cloudflare domain registration from desired state as a confirm-gated action', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-plan-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            domainRegistration: { provider: 'cloudflare', years: 1, autoRenew: false },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cfat_dns', accountId: 'acct-1', registrarApiToken: 'cfut_registrar' });
    mockObserved(null);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue(null);
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);

    const plan = await t.call('hv_plan', { project: 'domain-plan-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const register = plan.data.actions.find((action: { id: string }) => action.id === 'domain:apreskeys.com:register');
    expect(register).toMatchObject({
      type: 'create',
      resource: { kind: 'domain', name: 'apreskeys.com', provider: 'cloudflare' },
      requiresConfirm: true,
      billable: true,
    });
    expect(register.metadata).toBeUndefined();
    expect(JSON.stringify(storedPlanAction(plan.data.planId, register.id)?.metadata)).toContain('10.00');
    const attach = plan.data.actions.find((action: { id: string }) => action.id === 'domain:apreskeys.com');
    expect(attach.dependsOn).toContain('domain:apreskeys.com:register');
    expect(plan.hint).toContain('confirmActions');
    await t.close();
  });

  it('does not use a different Registrar search result to authorize a domain purchase', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-exact-candidate-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'requested-example.com',
            domainRegistration: { provider: 'cloudflare', years: 1 },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cfat_dns', accountId: 'acct-1', registrarApiToken: 'cfut_registrar' });
    mockObserved(null);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue(null);
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'different-example.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);

    const plan = await t.call('hv_plan', { project: 'domain-exact-candidate-app', env: 'production' });

    expect(plan.ok).toBe(true);
    expect(plan.data.actions).not.toContainEqual(expect.objectContaining({
      id: 'domain:requested-example.com:register',
    }));
    expect(plan.warnings).toContainEqual(expect.stringContaining(
      'did not return an availability result for requested-example.com'
    ));
    await t.close();
  });

  it('blocks Cloudflare domain registration early when only an account API token is connected', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-account-token-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            domainRegistration: { provider: 'cloudflare', years: 1 },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cfat_dns', accountId: 'acct-1' });
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'domain-account-token-app', env: 'production' });

    expect(plan.ok).toBe(true);
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      reason: expect.stringContaining('CLOUDFLARE_REGISTRAR_API_TOKEN'),
      requiredCredentialKeys: ['apiToken', 'accountId', 'registrarApiToken'],
    }));
    const cloudflareSetup = plan.data.connectionSetup.find(
      (entry: { provider: string }) => entry.provider === 'cloudflare'
    );
    expect(cloudflareSetup.localEnvInputs.map((input: { envKey: string }) => input.envKey)).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_REGISTRAR_API_TOKEN',
    ]);
    expect(cloudflareSetup.credentialExample).toContain(
      'credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID","registrarApiToken":"CLOUDFLARE_REGISTRAR_API_TOKEN"}'
    );
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining('https://dash.cloudflare.com/profile/api-tokens'),
    }));
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining('permissionGroupKeys='),
    }));
    await t.close();
  });

  it('applies Cloudflare domain registration only when the plan action is explicitly confirmed', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-apply-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            domainRegistration: { provider: 'cloudflare', years: 1, autoRenew: true },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cfat_dns', accountId: 'acct-1', registrarApiToken: 'cfut_registrar' });
    const project = new ProjectRepository().findByName('domain-apply-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: ['apreskeys.com'],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue(null);
    const checkRegistrarDomains = vi.spyOn(
      CloudflareAdapter.prototype,
      'checkRegistrarDomains'
    ).mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createRegistrarRegistration').mockResolvedValue({
      completed: true,
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:01.000Z',
      links: { self: '/status', resource: '/domain' },
      state: 'succeeded',
    });

    const plan = await t.call('hv_plan', { project: 'domain-apply-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const unconfirmed = await t.call('hv_apply', { project: 'domain-apply-app', planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:apreskeys.com:register',
      status: 'skipped_requires_confirm',
    }));
    expect(create).not.toHaveBeenCalled();

    const plan2 = await t.call('hv_plan', { project: 'domain-apply-app', env: 'production' });
    checkRegistrarDomains.mockResolvedValue([
      {
        name: 'apreskeys.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '11.00', renewal_cost: '10.00' },
      },
    ]);
    const staleTerms = await t.call('hv_apply', {
      project: 'domain-apply-app',
      planId: plan2.data.planId,
      confirmActions: ['domain:apreskeys.com:register'],
    });
    expect(staleTerms.ok).toBe(true);
    expect(staleTerms.data.applied).toBe(false);
    expect(staleTerms.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:apreskeys.com:register',
      status: 'blocked',
      message: expect.stringContaining('terms'),
    }));
    expect(create).not.toHaveBeenCalled();

    const plan3 = await t.call('hv_plan', { project: 'domain-apply-app', env: 'production' });
    const confirmed = await t.call('hv_apply', {
      project: 'domain-apply-app',
      planId: plan3.data.planId,
      confirmActions: ['domain:apreskeys.com:register'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:apreskeys.com:register',
      status: 'succeeded',
    }));
    expect(create).toHaveBeenCalledWith('acct-1', {
      domainName: 'apreskeys.com',
      autoRenew: true,
      years: 1,
    });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.domainRegistrations).toMatchObject({
      'apreskeys.com': { provider: 'cloudflare', accountId: 'acct-1', state: 'succeeded', completed: true },
    });
    await t.close();
  });

  it('keeps Cloudflare domain registration pending while the Registrar workflow is in progress', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-pending-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'pending-example.com',
            domainRegistration: { provider: 'cloudflare', years: 1, autoRenew: true },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cfat_dns', accountId: 'acct-1', registrarApiToken: 'cfut_registrar' });
    const project = new ProjectRepository().findByName('domain-pending-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'pending-example.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createRegistrarRegistration').mockResolvedValue({
      completed: false,
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:01.000Z',
      links: { self: '/status', resource: '/domain' },
      state: 'in_progress',
    });

    const plan = await t.call('hv_plan', { project: 'domain-pending-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const attach = plan.data.actions.find((action: { id: string }) => action.id === 'domain:pending-example.com');
    expect(attach.dependsOn).toContain('domain:pending-example.com:register');

    const apply = await t.call('hv_apply', {
      project: 'domain-pending-app',
      planId: plan.data.planId,
      confirmActions: ['domain:pending-example.com:register'],
    });

    expect(apply.ok).toBe(true);
    expect(apply.data.applied).toBe(false);
    expect(apply.data.error).toBeUndefined();
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:pending-example.com:register',
      status: 'pending',
      message: expect.stringContaining('in_progress'),
    }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'domain:pending-example.com',
      status: 'aborted',
      message: expect.stringContaining('earlier pending result'),
    }));
    expect(apply.hint).toContain('pending provider workflows');
    expect(create).toHaveBeenCalledWith('acct-1', {
      domainName: 'pending-example.com',
      autoRenew: true,
      years: 1,
    });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.domainRegistrations).toMatchObject({
      'pending-example.com': {
        provider: 'cloudflare',
        accountId: 'acct-1',
        state: 'in_progress',
        completed: false,
      },
    });
    await t.close();
  });

  it('does not treat an existing Cloudflare DNS zone as completed domain registration', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-zone-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'zone-example.com',
            domainRegistration: { provider: 'cloudflare', years: 1 },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('cloudflare', { apiToken: 'cfat_dns', accountId: 'acct-1', registrarApiToken: 'cfut_registrar' });
    mockObserved(null);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'zone-example.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: ['ns1.example.com', 'ns2.example.com'],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'checkRegistrarDomains').mockResolvedValue([
      {
        name: 'zone-example.com',
        registrable: true,
        tier: 'standard',
        pricing: { currency: 'USD', registration_cost: '10.00', renewal_cost: '10.00' },
      },
    ]);

    const plan = await t.call('hv_plan', { project: 'domain-zone-app', env: 'production' });

    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'domain:zone-example.com:register',
      type: 'create',
      requiresConfirm: true,
    }));
    await t.close();
  });

  it('plans and applies iOS bundle ID, capabilities, and TestFlight actions end to end', async () => {
    const BUNDLE = 'com.example.app';
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'ios-e2e-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            ios: {
              bundleId: BUNDLE,
              capabilities: ['PUSH_NOTIFICATIONS'],
              testflight: { groups: { Beta: { testers: ['a@example.com'] } } },
            },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('appstoreconnect', { keyId: 'K1', issuerId: 'I1', privateKey: 'pk' });
    const project = new ProjectRepository().findByName('ios-e2e-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    // Hosting is already converged so the only executable actions are ios:*.
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    // ASC reads: bundle ID missing, app record exists, no groups/testers yet.
    const findBundleId = vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockResolvedValue(null);
    const capabilities = vi.spyOn(AppStoreConnectAdapter.prototype, 'getBundleIdCapabilities').mockResolvedValue([]);
    const findApp = vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId')
      .mockResolvedValue({ id: 'app-1', bundleId: BUNDLE, name: 'Example' });
    const listGroups = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([]);
    const listTesters = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockResolvedValue([]);
    // ASC writes used at apply time.
    const registerBundleId = vi.spyOn(AppStoreConnectAdapter.prototype, 'registerBundleId')
      .mockResolvedValue({ id: 'bid-1', identifier: BUNDLE, name: 'ios-e2e-app', platform: 'IOS' });
    const enableCapabilities = vi.spyOn(AppStoreConnectAdapter.prototype, 'enableCapabilities')
      .mockResolvedValue({ enabled: ['PUSH_NOTIFICATIONS'], alreadyEnabled: [], errors: [] });
    const getOrCreateGroup = vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaGroup')
      .mockResolvedValue({ group: { id: 'grp-1', name: 'Beta', isInternal: false }, created: true });
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findBetaGroupByName')
      .mockResolvedValue({ id: 'grp-1', name: 'Beta', isInternal: false });
    const getOrCreateTester = vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaTester')
      .mockResolvedValue({ tester: { id: 'tester-1', email: 'a@example.com' }, created: true });

    const plan = await t.call('hv_plan', { project: 'ios-e2e-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const ids = plan.data.actions.map((action: { id: string }) => action.id);
    expect(ids).toEqual(expect.arrayContaining([
      `ios:bundle-id:${BUNDLE}`,
      `ios:capabilities:${BUNDLE}`,
      'ios:group:Beta',
      'ios:testers:Beta',
    ]));
    expect(plan.data.actions.find((action: { id: string }) => action.id === `ios:bundle-id:${BUNDLE}`)).toMatchObject({
      type: 'create',
      resource: { kind: 'ios', name: BUNDLE, provider: 'appstoreconnect' },
    });
    // The app record already exists, so its action is a noop.
    expect(plan.data.actions.find((action: { id: string }) => action.id === `ios:app:${BUNDLE}`)).toBeUndefined();
    expect(storedPlanAction(plan.data.planId, `ios:app:${BUNDLE}`)).toMatchObject({ type: 'noop' });
    expect(plan.data.totalActionCount).toBe(plan.data.pendingActionCount + plan.data.noopActionCount);
    expect(plan.data.noopActionCount).toBeGreaterThan(0);

    const apply = await t.call('hv_apply', { project: 'ios-e2e-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.applied).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: `ios:bundle-id:${BUNDLE}`, status: 'succeeded' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: `ios:capabilities:${BUNDLE}`, status: 'succeeded' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: `ios:app:${BUNDLE}`, status: 'skipped_noop' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: 'ios:group:Beta', status: 'succeeded' }));
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({ actionId: 'ios:testers:Beta', status: 'succeeded' }));
    expect(registerBundleId).toHaveBeenCalledWith(BUNDLE, 'ios-e2e-app', 'IOS');
    expect(enableCapabilities).toHaveBeenCalledWith('bid-1', ['PUSH_NOTIFICATIONS']);
    expect(getOrCreateGroup).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1', name: 'Beta' }));
    expect(getOrCreateTester).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@example.com', groupIds: ['grp-1'] }));

    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.ios).toMatchObject({
      bundleIdResourceId: 'bid-1',
      appId: 'app-1',
      testflight: { groups: { Beta: { groupId: 'grp-1' } } },
    });

    // Re-point the reads at the converged Apple-side state for hv_status.
    findBundleId.mockResolvedValue({ id: 'bid-1', identifier: BUNDLE, name: 'ios-e2e-app', platform: 'IOS' });
    capabilities.mockResolvedValue([{ id: 'cap-1', type: 'PUSH_NOTIFICATIONS' }]);
    findApp.mockResolvedValue({ id: 'app-1', bundleId: BUNDLE, name: 'Example' });
    listGroups.mockResolvedValue([{ id: 'grp-1', name: 'Beta', isInternal: false }]);
    listTesters.mockResolvedValue([{ id: 'tester-1', email: 'a@example.com' }]);

    const status = await t.call('hv_status', { project: 'ios-e2e-app', env: 'production' });
    expect(status.ok).toBe(true);
    expect(status.data.ios).toMatchObject({
      bundleId: BUNDLE,
      bundleIdRegistered: true,
      capabilitiesMissing: [],
      appRecord: 'found',
    });
    expect(status.data.ios.groups.inSync).toContain('Beta');
    expect(status.data.inSync).toBe(true);
    await t.close();
  });

  it('plans and applies GitHub Actions deploy workflow setup from deploy.trigger="ci"', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'ci-plan-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-plan-app.git',
        github: {
          collaboration: {
            issues: { enabled: false, templates: false },
            pullRequests: { requirePr: true },
          },
        },
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson', packageReadToken: 'gh-package-token' });
    const project = new ProjectRepository().findByName('ci-plan-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        sourceState: 'disconnected',
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ref: 'refs/heads/hypervibe/github-infrastructure',
        object: { sha: 'base-sha' },
      });
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/davejohnson/ci-plan-app/pull/42',
    });
    const writeWorkflow = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({
      created: true,
      updated: false,
    });
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const plan = await t.call('hv_plan', { project: 'ci-plan-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const ci = plan.data.actions.find((action: { id: string }) => action.id === 'ci:github-actions:production:deploy-branch');
    expect(ci).toMatchObject({
      type: 'create',
      resource: { kind: 'ci', name: 'deploy-branch:production', provider: 'github' },
    });
    expect(ci.metadata).toBeUndefined();
    expect(storedPlanAction(plan.data.planId, ci.id)?.metadata?.workflow).toMatchObject({
      path: '.github/workflows/deploy-railway-production.yml',
    });

    const apply = await t.call('hv_apply', { project: 'ci-plan-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(apply.data.applied).toBe(false);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'ci:github-actions:production:deploy-branch',
      status: 'pending',
      data: expect.objectContaining({
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/davejohnson/ci-plan-app/pull/42',
      }),
    }));
    expect(writeWorkflow).toHaveBeenCalledWith(
      'davejohnson',
      'ci-plan-app',
      '.github/workflows/deploy-railway-production.yml',
      expect.stringContaining('Deploy Railway (production)'),
      expect.any(String),
      'hypervibe/github-infrastructure'
    );
    expect(writeWorkflow).toHaveBeenCalledWith(
      'davejohnson',
      'ci-plan-app',
      '.github/pull_request_template.md',
      expect.stringContaining('## Summary'),
      expect.any(String),
      'hypervibe/github-infrastructure'
    );
    expect(writeWorkflow).toHaveBeenCalledWith(
      'davejohnson',
      'ci-plan-app',
      '.github/hypervibe/manifest.json',
      expect.stringContaining('.github/pull_request_template.md'),
      expect.any(String),
      'hypervibe/github-infrastructure'
    );
    expect(setSecret).not.toHaveBeenCalled();
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.ci).toBeUndefined();
    expect(apply.hint).toContain('pending provider workflows');
    await t.close();
  });

  it('fails CI workflow apply when Railway image pull credentials are missing', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'ci-missing-image-token-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-missing-image-token-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson' });
    const project = new ProjectRepository().findByName('ci-missing-image-token-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({
      created: true,
      updated: false,
    });
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const plan = await t.call('hv_plan', { project: 'ci-missing-image-token-app', env: 'production' });
    expect(plan.ok).toBe(true);
    const ci = plan.data.actions.find((action: { id: string }) => action.id === 'ci:github-actions:production:deploy-branch');
    expect(ci.metadata).toBeUndefined();
    expect(storedPlanAction(plan.data.planId, ci.id)?.metadata?.missingProviderSecrets).toEqual(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
    expect(plan.data.actionScopedBlocked).toContainEqual(expect.objectContaining({
      provider: 'github',
      reason: expect.stringContaining('repo/workflow API access plus packageReadToken'),
    }));
    expect(plan.warnings).toContainEqual(expect.stringContaining('GitHub apiToken needs repo + workflow'));
    expect(plan.next).toEqual(['hv_connections', 'hv_plan']);
    expectActionableConnectionSetup(plan.data.connectionSetup, {
      provider: 'github',
      project: 'ci-missing-image-token-app',
      scope: 'davejohnson/ci-missing-image-token-app',
    });
    expect(plan.agentInstruction).toMatchObject({ action: 'ask_user' });
    expect(plan.agentInstruction.message).toContain('exact clickable setup links');
    expect(plan.agentInstruction.message).toContain('offer to open');
    expect(plan.agentInstruction.message).toContain('real local path');
    expect(plan.agentInstruction.message).not.toContain('ask the user for an exported token');

    const apply = await t.call('hv_apply', { project: 'ci-missing-image-token-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.code).toBe('MISSING_CONNECTION');
    expect(apply.error.details.blocked).toContainEqual(expect.objectContaining({
      provider: 'github',
      reason: expect.stringContaining('repo/workflow API access plus packageReadToken'),
    }));
    expectActionableConnectionSetup(apply.error.details.connectionSetup, {
      provider: 'github',
      project: 'ci-missing-image-token-app',
      scope: 'davejohnson/ci-missing-image-token-app',
    });
    expect(apply.hint).toContain('combined classic PAT');
    expect(apply.hint).toContain('read:packages');
    expect(apply.hint).toContain('connectionSetup');
    expect(apply.next).toEqual(['hv_connections', 'hv_plan', 'hv_apply']);
    expect(setSecret).not.toHaveBeenCalledWith('davejohnson', 'ci-missing-image-token-app', 'RAILWAY_API_TOKEN', 'railway-token');
    expect(setSecret).not.toHaveBeenCalledWith('davejohnson', 'ci-missing-image-token-app', 'IMAGE_REGISTRY_TOKEN', expect.any(String));
    await t.close();
  });

  it('blocks apply before independent actions when a full plan is missing Cloudflare for domain convergence', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'ci-domain-soft-block-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-domain-soft-block-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'apreskeys.com',
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson', packageReadToken: 'gh-package-token' });
    const project = new ProjectRepository().findByName('ci-domain-soft-block-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1', url: 'https://web-production.up.railway.app' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({
      created: true,
      updated: false,
    });
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

    const plan = await t.call('hv_plan', { project: 'ci-domain-soft-block-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.blocked).toContainEqual(expect.objectContaining({ provider: 'cloudflare' }));
    expect(plan.data.actionScopedBlocked).toBeUndefined();
    expect(plan.next).toEqual(['hv_connections', 'hv_plan']);
    expect(plan.hint).toContain('Do not run hv_apply until these connections verify');

    const apply = await t.call('hv_apply', { project: 'ci-domain-soft-block-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.code).toBe('MISSING_CONNECTION');
    expect(apply.error.details.blocked).toContainEqual(expect.objectContaining({ provider: 'cloudflare' }));
    expectActionableConnectionSetup(apply.error.details.connectionSetup, {
      provider: 'cloudflare',
      project: 'ci-domain-soft-block-app',
      scope: 'apreskeys.com',
    });
    expect(apply.hint).toContain('connectionSetup');
    expect(setSecret).not.toHaveBeenCalled();
    await t.close();
  });

  it('reports drift via hv_status against observed state', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    verifyRailwayConnection();
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    mockObserved({
      provider: 'railway', observedAt: new Date().toISOString(),
      projectExists: true, projectId: 'rp-1',
      services: [{
        name: 'web', externalId: 's-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'node legacy.js' },
        envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [], partial: false, warnings: [],
    });

    const status = await t.call('hv_status', { project: 'core-spec-app', env: 'staging' });
    expect(status.ok).toBe(true);
    expect(status.data.verified).toBe(true);
    expect(status.data.inSync).toBe(false);
    const drift = status.data.drift.find((a: { id: string }) => a.id === 'service:web');
    expect(drift.type).toBe('update');
    await t.close();
  });

  it('reports binding-only drift when a local managed-secret binding has a failed receipt', async () => {
    const t = await makeClient();
    const project = new ProjectRepository().create({
      name: 'failed-secret-binding-status-app',
      defaultPlatform: 'railway',
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      secrets: {
        SESSION_SECRET: {
          ownership: 'hypervibe',
          generator: 'random-base64url-32-v1',
          generation: 1,
          environments: ['production'],
        },
      },
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { startCommand: 'npm start' } },
        },
      },
    });
    new SpecStore().replace(project, spec);
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web', startCommand: 'npm start' },
      envVarSpec: {},
    });
    const runs = new RunRepository();
    const plan = runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {},
    });
    const reservation = runs.reserveApply({
      projectId: project.id,
      environmentId: environment.id,
      planRunId: plan.id,
      environmentName: environment.name,
      specRevision: 1,
    });
    if (!reservation.reserved) throw new Error('Expected a local apply reservation');
    runs.addReceipt(reservation.run.id, {
      step: 'secret:SESSION_SECRET',
      status: 'failure',
      error: 'repository export failed',
      timestamp: new Date().toISOString(),
    });
    runs.updateStatus(reservation.run.id, 'failed', 'repository export failed');
    const generatedValue = deriveHypervibeSecretValues(spec, 'production').SESSION_SECRET;
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      delegatedEnvBindings: [{
        name: 'SESSION_SECRET',
        principal: 'hypervibe',
        valueHash: hashEnvValue(generatedValue),
        source: 'hypervibe-generated',
        generator: 'random-base64url-32-v1',
        generation: 1,
        syncedAt: new Date().toISOString(),
        applyRunId: reservation.run.id,
        actionId: 'secret:SESSION_SECRET',
      }],
    });
    verifyRailwayConnection();
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: ['SESSION_SECRET'],
        envVarHashes: { SESSION_SECRET: hashEnvValue(generatedValue) },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const status = await t.call('hv_status', { project: project.name, env: 'production' });

    expect(status.ok).toBe(true);
    expect(status.data.inSync).toBe(false);
    expect(status.data.drift).toContainEqual(expect.objectContaining({
      id: 'secret:SESSION_SECRET',
      type: 'update',
      metadata: expect.objectContaining({ bindingOnly: true }),
    }));
    await t.close();
  });

  it('reports a connected native source as drift for manual deployment ownership', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'manual-source-status-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: {},
            deploy: { strategy: 'manual' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('manual-source-status-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-production',
        services: {
          web: {
            serviceId: 'svc-web',
            source: { repo: 'dave/billforge', branch: 'main' },
          },
        },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-production',
      services: [{
        name: 'web',
        externalId: 'svc-web',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        source: { repo: 'dave/billforge', branch: 'main' },
        sourceState: 'connected',
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const status = await t.call('hv_status', {
      project: project.name,
      env: 'production',
    });

    expect(status.ok).toBe(true);
    expect(status.data.inSync).toBe(false);
    expect(status.data.drift).toContainEqual(expect.objectContaining({
      id: 'service:web:deploy-source',
      metadata: expect.objectContaining({
        operation: 'providerNativeDeploySourceDisconnect',
        desiredDeployMode: 'manual',
      }),
    }));
    await t.close();
  });

  it('does not report in sync when a declared managed database alias is missing', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'database-alias-status-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: {
              'events-worker': {
                workloadKind: 'worker',
                startCommand: 'npm run events:worker',
                public: false,
                databaseEnvAliases: {
                  POSTGRES_DB_URL: 'DATABASE_URL',
                },
              },
            },
            database: { provider: 'railway', engine: 'postgres' },
            envVars: { NODE_ENV: 'staging' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('database-alias-status-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { 'events-worker': { serviceId: 'svc-worker' } },
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'db-1',
      bindings: {
        provider: 'railway',
        pluginName: 'postgres-db',
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'events-worker',
        externalId: 'svc-worker',
        workloadKind: 'web',
        customDomains: [],
        config: {
          startCommand: 'npm run events:worker',
          public: false,
        },
        envVarKeys: ['NODE_ENV', 'DATABASE_URL', 'DIRECT_URL'],
        envVarHashes: {
          NODE_ENV: hashEnvValue('staging'),
          DATABASE_URL: hashEnvValue('postgresql://resolved-internal'),
          DIRECT_URL: hashEnvValue('postgresql://resolved-private'),
        },
        status: 'running',
      }],
      databases: [{
        provider: 'railway',
        engine: 'postgres',
        externalId: 'db-1',
        status: 'running',
      }],
      partial: false,
      warnings: [],
    });

    const status = await t.call('hv_status', {
      project: project.name,
      env: 'staging',
    });

    expect(status.ok).toBe(true);
    expect(status.data.inSync).toBe(false);
    expect(status.data.runtimeHealth.status).toBe('unverified');
    expect(status.data.managedDatabase.services['events-worker'].aliases)
      .toEqual({ POSTGRES_DB_URL: 'DATABASE_URL' });
    expect(status.data.drift.find((action: { id: string }) => action.id === 'service:events-worker')?.diff)
      .toContainEqual({ field: 'env:POSTGRES_DB_URL' });
    await t.close();
  });

  it('exposes sanitized observed service endpoints via hv_status', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    verifyRailwayConnection();
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    const observedAt = new Date().toISOString();
    mockObserved({
      provider: 'railway', observedAt,
      projectExists: true, projectId: 'rp-1',
      services: [{
        name: 'web', externalId: 's-1', workloadKind: 'web',
        url: 'https://web-staging-1234.up.railway.app/private/sentinel-path?token=sentinel-query#sentinel-fragment',
        customDomains: ['App.Example.com', 'app.example.com', 'not a domain', 'ftp://weird'],
        config: { startCommand: 'npm start' },
        envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }, {
        name: 'worker', externalId: 's-2', workloadKind: 'worker',
        url: 'https://sentinel-user:sentinel-password@worker.example.com',
        customDomains: ['a'.repeat(64) + '.example.com'],
        config: { startCommand: 'npm run worker' },
        envVarKeys: [], envVarHashes: {},
        status: 'failed',
      }],
      databases: [], partial: false, warnings: [],
    });

    const status = await t.call('hv_status', { project: 'core-spec-app', env: 'staging' });
    expect(status.ok).toBe(true);
    expect(status.data.observedAt).toBe(observedAt);
    expect(status.data.services).toEqual([{
      name: 'web',
      status: 'running',
      url: 'https://web-staging-1234.up.railway.app',
      customDomains: ['app.example.com'],
    }, {
      name: 'worker',
      status: 'failed',
    }]);
    expect(JSON.stringify(status.data.services)).not.toContain('sentinel');
    await t.close();
  });

  it('uses provider metadata in hv_status so Railway web and worker kinds do not drift permanently', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'railway-worker-status-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { worker: { workloadKind: 'worker', startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'production' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('railway-worker-status-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { worker: { serviceId: 's-worker' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'worker',
        externalId: 's-worker',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('production') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const status = await t.call('hv_status', { project: 'railway-worker-status-app', env: 'production' });

    expect(status.ok).toBe(true);
    expect(status.data.drift.find((a: { id: string }) => a.id === 'service:worker')).toBeUndefined();
    expect(status.data.inSync).toBe(true);
    await t.close();
  });

  it('tells agents to connect Cloudflare before planning domain DNS drift', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'domain-status-missing-connection-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'hlspropertycare.com',
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('domain-status-missing-connection-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1', url: 'https://web-production.up.railway.app' } },
      },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 'svc-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const status = await t.call('hv_status', { project: 'domain-status-missing-connection-app', env: 'production' });
    expect(status.ok).toBe(true);
    expect(status.data.blocked).toContainEqual(expect.objectContaining({
      provider: 'cloudflare',
      scope: 'hlspropertycare.com',
    }));
    expect(status.data.drift).toContainEqual(expect.objectContaining({
      id: 'domain:hlspropertycare.com',
      type: 'update',
    }));
    expectActionableConnectionSetup(status.data.connectionSetup, {
      provider: 'cloudflare',
      project: 'domain-status-missing-connection-app',
      scope: 'hlspropertycare.com',
    });
    expect(status.hint).toContain('connectionSetup');
    expect(status.next).toEqual(['hv_connections']);
    await t.close();
  });

  it('reports declared queues as drift when the provider cannot converge them', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'queue-status-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            database: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' }, jobs: { workloadKind: 'worker' } },
            queues: { 'email-jobs': {} },
            envVars: { NODE_ENV: 'staging' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('queue-status-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const status = await t.call('hv_status', { project: 'queue-status-app', env: 'staging' });
    expect(status.ok).toBe(true);
    expect(status.data.inSync).toBe(false);
    expect(status.data.drift).toContainEqual(expect.objectContaining({
      id: 'queue:email-jobs',
      type: 'update',
      verified: false,
      metadata: expect.objectContaining({
        unsupported: true,
        blockedReason: 'queue_observation_unavailable',
      }),
    }));
    expect(status.warnings).toContainEqual(expect.stringContaining('does not support queues'));
    await t.close();
  });

  it('reports restart_required when a synced CI service still runs its pre-configuration deployment', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'ci-status-app',
        gitRemoteUrl: 'git@github.com:davejohnson/ci-status-app.git',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: {},
            email: { enabled: false },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyConnection('railway', { apiToken: 'railway-token' });
    verifyConnection('github', { apiToken: 'gh-token', login: 'davejohnson', packageReadToken: 'gh-package-token' });
    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const project = new ProjectRepository().findByName('ci-status-app')!;
    const envRepo = new EnvironmentRepository();
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-web' } },
      },
    });
    const { targets, migration } = resolveBranchDeployTargets(project);
    const target = targets.find((candidate) => candidate.environmentName === 'production')!;
    const workflow = buildBranchDeployWorkflow('railway', target, migration);
    const environment = envRepo.findByProjectAndName(project.id, 'production')!;
    envRepo.updatePlatformBindings(environment.id, {
      ...(environment.platformBindings as Record<string, unknown>),
      ci: {
        deployBranch: {
          [workflow.path]: {
            contentHash: sha256(workflow.content),
            syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
            syncedSecretHashes: {
              RAILWAY_API_TOKEN: sha256('railway-token'),
              IMAGE_REGISTRY_USERNAME: sha256('davejohnson'),
              IMAGE_REGISTRY_TOKEN: sha256('gh-package-token'),
            },
          },
        },
      },
      runtimeRollouts: [{
        service: 'web',
        provider: 'railway',
        serviceExternalId: 'svc-web',
        baselineDeployment: { state: 'present', id: 'deployment-before-config' },
        requiredAt: '2026-08-20T20:25:00.000Z',
        applyRunId: 'apply-secret-sync',
        actionIds: ['secret:ANTHROPIC_API_KEY'],
      }],
    });
    mockObserved({
      provider: 'railway', observedAt: new Date().toISOString(),
      projectExists: true, projectId: 'rp-1', environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-web', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start', public: false },
        envVarKeys: [], envVarHashes: {},
        status: 'running',
        maintenance: {
          state: 'running',
          deploymentId: 'deployment-before-config',
          deploymentStatus: 'SUCCESS',
        },
      }],
      databases: [], partial: false, warnings: [],
    });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

    const status = await t.call('hv_status', { project: 'ci-status-app', env: 'production' });

    expect(status.ok).toBe(true);
    expect(status.data.deploySource.pushToDeploy).toBe(false);
    expect(status.data.deploySource.ci).toMatchObject({
      provider: 'github-actions',
      setup: 'in-sync',
      workflow: {
        path: '.github/workflows/deploy-railway-production.yml',
        branch: 'main',
        autoDeployOnPush: false,
        promoteFromEnvironment: 'staging',
      },
    });
    expect(status.data.inSync).toBe(false);
    expect(status.data.restartRequired).toBe(true);
    expect(status.data.runtimeConfiguration).toMatchObject({
      status: 'restart_required',
      services: [{
        service: 'web',
        provider: 'railway',
        actionIds: ['secret:ANTHROPIC_API_KEY'],
      }],
    });
    expect(status.hint).toContain('.github/workflows/deploy-railway-production.yml');
    expect(status.hint).toContain('hv_ci_trigger');
    expect(status.next).toEqual(['hv_ci_trigger', 'hv_ci_status', 'hv_status']);
    await t.close();
  });

  it('rejects hv_apply when the spec changed after planning', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    verifyRailwayConnection();
    mockObserved(null);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);

    // Supersede the spec
    await t.call('hv_spec', {
      project: 'core-spec-app',
      spec: { environments: { staging: { envVars: { EXTRA: '1' } } } },
    });

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.message).toContain('Re-run hv_plan');
    await t.close();
  });

  it('refuses to apply without verified connections', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    mockObserved(null);
    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });

    const apply = await t.call('hv_apply', { project: 'core-spec-app', planId: plan.data.planId });
    expect(apply.ok).toBe(false);
    expect(apply.error.code).toBe('MISSING_CONNECTION');
    expect(apply.hint).toContain('https://railway.com/account/tokens');
    expectActionableConnectionSetup(apply.error.details.connectionSetup, {
      provider: 'railway',
      project: 'core-spec-app',
    });
    expect(apply.agentInstruction.message).toContain('offer to open');
    expect(apply.agentInstruction.message).toContain('complete credentialExample');
    expect(apply.next).toEqual(['hv_connections', 'hv_plan', 'hv_apply']);
    await t.close();
  });

  it('applies an explicitly confirmed environment-variable tombstone through the hosting adapter', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'env-retirement-app',
        environments: {
          staging: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'staging' },
            removeEnvVars: ['OLD_API_TOKEN'],
          },
        },
      },
    });
    verifyRailwayConnection();

    const project = new ProjectRepository().findByName('env-retirement-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 's-web' } },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { startCommand: 'npm start' },
    });

    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web',
        externalId: 's-web',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        sourceState: 'disconnected',
        envVarKeys: ['NODE_ENV', 'OLD_API_TOKEN'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    };
    const deleteEnvVars = vi.fn(async () => ({
      success: true,
      message: 'removed',
      data: { deletedKeys: ['OLD_API_TOKEN'], variableCount: 1 },
    }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for env removal'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      deleteEnvVars,
      observe: async () => observedState,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter } as any);

    const plan = await t.call('hv_plan', { project: 'env-retirement-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:web:env-remove',
      requiresConfirm: true,
    }));

    const apply = await t.call('hv_apply', {
      project: 'env-retirement-app',
      planId: plan.data.planId,
      confirmActions: ['service:web:env-remove'],
    });
    expect(apply.ok).toBe(true);
    expect(deleteEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'staging' }),
      expect.objectContaining({ name: 'web' }),
      ['OLD_API_TOKEN']
    );
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:web:env-remove',
      status: 'succeeded',
    }));
    await t.close();
  });

  it('destroys a locally managed provider service that was removed from the spec', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: SPEC });
    verifyRailwayConnection();

    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const { ServiceRepository } = await import('../../adapters/db/repositories/service.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: {
          web: { serviceId: 's-web' },
          daily: { serviceId: 's-daily' },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'daily',
      buildConfig: { workloadKind: 'cron', cronSchedule: '0 8 * * *' },
    });

    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [
        {
          name: 'web', externalId: 's-web', workloadKind: 'web', customDomains: [],
          config: { startCommand: 'npm start' },
          sourceState: 'disconnected',
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        },
        {
          name: 'daily', externalId: 's-daily', workloadKind: 'cron', customDomains: [],
          config: { startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
          sourceState: 'disconnected',
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('staging') },
          status: 'running',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    };
    const deleteService = vi.fn(async () => ({ success: true }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for service destroy'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observedState,
      deleteService,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter } as any);

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'staging' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
      requiresConfirm: true,
    }));
    expect(storedPlanAction(plan.data.planId, 'service:daily:destroy')?.metadata)
      .toEqual({ externalId: 's-daily' });
    expect(plan.data.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'daily' }));

    const apply = await t.call('hv_apply', {
      project: 'core-spec-app',
      planId: plan.data.planId,
      confirmActions: ['service:daily:destroy'],
    });
    expect(apply.ok).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('s-daily');
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:daily:destroy',
      status: 'succeeded',
    }));

    const updatedEnvironment = new EnvironmentRepository().findById(environment.id)!;
    const services = updatedEnvironment.platformBindings.services as Record<string, unknown>;
    expect(services).toMatchObject({ web: { serviceId: 's-web' } });
    expect(services.daily).toBeUndefined();
    expect(new ServiceRepository().findByProjectAndName(project.id, 'daily')).toBeNull();
    await t.close();
  });

  it('deletes leftover Hypervibe task services without requiring a local binding', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'task-cleanup-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            envVars: { NODE_ENV: 'production' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('task-cleanup-app')!;
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: {
          web: { serviceId: 's-web' },
        },
      },
    });

    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [
        {
          name: 'web', externalId: 's-web', workloadKind: 'web', customDomains: [],
          config: { startCommand: 'npm start' },
          sourceState: 'disconnected',
          envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('production') },
          status: 'running',
        },
        {
          name: 'hv-task-123', externalId: 'task-svc-1', workloadKind: 'worker', customDomains: [],
          config: {},
          sourceState: 'disconnected',
          envVarKeys: [], envVarHashes: {},
          status: 'unknown',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    };
    const deleteService = vi.fn(async () => ({ success: true }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for task cleanup'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observedState,
      deleteService,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter } as any);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter } as any);

    const plan = await t.call('hv_plan', { project: 'task-cleanup-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'hv-task-123' }));
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:hv-task-123:destroy',
      type: 'destroy',
    }));
    expect(storedPlanAction(plan.data.planId, 'service:hv-task-123:destroy')?.metadata).toEqual({
      operation: 'taskServiceCleanup',
      externalId: 'task-svc-1',
    });

    const apply = await t.call('hv_apply', { project: 'task-cleanup-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('task-svc-1');
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:hv-task-123:destroy',
      status: 'succeeded',
    }));
    await t.close();
  });

  it('creates a replacement database without deploying or destroying the old database in the same apply', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'core-spec-app',
        environments: {
          production: {
            hosting: { provider: 'cloudrun' },
            services: { web: { startCommand: 'npm start' } },
            database: { provider: 'supabase' },
            envVars: { NODE_ENV: 'production' },
          },
        },
      },
    });
    verifyConnection('cloudrun');
    verifyConnection('supabase');

    const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
    const { ComponentRepository } = await import('../../adapters/db/repositories/component.repository.js');
    const project = new ProjectRepository().findByName('core-spec-app')!;
    const now = new Date();
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'cloudsql-1',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'cloudsql-1',
        connectionUrl: 'postgres://old-cloudsql',
        connectionName: 'gcp-project:us-central1:app',
      },
    });

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudrun',
        capabilities: {
          supportedBuilders: ['dockerfile'], supportedComponents: [],
          supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
          supportsReleaseCommand: false, supportsMultiEnvironment: false, managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        ensureProject: async () => ({ success: true, message: 'ok' }),
        ensureComponent: async () => { throw new Error('unused'); },
        deploy: async () => { throw new Error('hosting deploy should not run'); },
        observe: async () => ({
          provider: 'cloudrun',
          observedAt: new Date().toISOString(),
          projectExists: true,
          projectId: 'gcp-project',
          environmentId: 'production',
          services: [{
            name: 'web', externalId: 'gcp-project-web', workloadKind: 'web', customDomains: [],
            config: { startCommand: 'npm start' },
            envVarKeys: ['NODE_ENV'], envVarHashes: { NODE_ENV: hashEnvValue('production') },
            status: 'running',
          }],
          databases: [{ provider: 'cloudsql', engine: 'postgres', externalId: 'cloudsql-1', status: 'running' }],
          partial: false,
          warnings: [],
        }),
      },
    } as any);
    const provision = vi.fn(async (_type: string, env: { id: string }) => ({
      component: {
        id: 'supabase-component',
        environmentId: env.id,
        type: 'postgres',
        externalId: 'supabase-1',
        bindings: {
          provider: 'supabase',
          instanceId: 'supabase-1',
          connectionUrl: 'postgres://new-supabase',
          host: 'db.supabase.co',
          port: 5432,
          username: 'postgres',
          password: 'pw',
          database: 'postgres',
        },
        createdAt: now,
        updatedAt: now,
      },
      receipt: { success: true, message: 'Provisioned Supabase Postgres' },
      connectionUrl: 'postgres://new-supabase',
      envVars: { DATABASE_URL: 'postgres://new-supabase', DATABASE_SSL: 'true' },
    }));
    const destroy = vi.fn(async () => ({ success: true, message: 'destroyed' }));
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'supabase',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportsPooling: true, supportsReadReplicas: false,
          supportsPointInTimeRecovery: false, serverlessOptimized: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        provision,
        observeDatabase: async () => null,
        getConnectionUrl: async () => 'postgres://new-supabase',
        destroy,
      },
    } as any);
    const hostingSpy = vi.spyOn(adapterFactory, 'getHostingAdapter').mockRejectedValue(new Error('hosting should not run'));

    const plan = await t.call('hv_plan', { project: 'core-spec-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({ id: 'database:supabase', type: 'create' }));
    expect(plan.data.actions.find((action: { id: string }) => action.id === 'database:cloudsql:destroy')).toBeUndefined();

    const apply = await t.call('hv_apply', {
      project: 'core-spec-app',
      planId: plan.data.planId,
      confirmActions: ['database:supabase'],
    });
    expect(apply.ok).toBe(true);
    expect(apply.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'database:supabase',
      status: 'succeeded',
    }));
    expect(provision).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(hostingSpy).not.toHaveBeenCalled();

    const component = new ComponentRepository().findByEnvironmentAndType(environment.id, 'postgres')!;
    expect(component.bindings.provider).toBe('supabase');
    expect(component.bindings.previousProvider).toBe('cloudsql');
    expect(component.bindings.previousExternalId).toBe('cloudsql-1');
    expect(component.bindings.previousBindings).toMatchObject({
      provider: 'cloudsql',
      connectionUrl: 'postgres://old-cloudsql',
    });
    await t.close();
  });

  it('runs a declarative database seedCommand once through hv_apply and records completion', async () => {
    const t = await makeClient();
    const command = 'true';
    await t.call('hv_spec', {
      spec: {
        project: 'seed-apply-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
            database: { provider: 'railway', seedCommand: command },
            envVars: { NODE_ENV: 'production' },
          },
        },
      },
    });
    verifyRailwayConnection();

    const { ComponentRepository } = await import('../../adapters/db/repositories/component.repository.js');
    const project = new ProjectRepository().findByName('seed-apply-app')!;
    const service = new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web' },
      envVarSpec: {},
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'db-1',
      bindings: {
        provider: 'railway',
        serviceId: 'db-1',
        connectionString: 'postgres://seed:secret@db.example.com/app',
      },
    });
    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'npm start' },
        sourceState: 'disconnected',
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('production') },
        status: 'running',
      }],
      databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running' }],
      partial: false,
      warnings: [],
    };
    mockObserved(observedState);

    const plan = await t.call('hv_plan', { project: 'seed-apply-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'database:railway:seed',
      type: 'update',
    }));

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
          supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
          supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
          supportsObserve: true,
        },
        connect: async () => {}, verify: async () => ({ success: true }),
        observe: async () => ({
          ...observedState,
          services: observedState.services.map((entry) => ({
            ...entry,
            sourceState: entry.sourceState ?? 'disconnected',
          })),
        }),
        runJob: async (_environment: unknown, taskService: { name: string }, taskCommand: string) => ({
          jobId: 'job-1',
          status: 'completed',
          output: 'seeded',
          receipt: {
            success: true,
            message: 'seed completed',
            data: { service: taskService.name, command: taskCommand },
          },
        }),
      },
    } as any);
    const seedResult = await applyDatabaseSeed(createToolContext(), project, 'production', {
      id: 'database:railway:seed',
      type: 'update',
      resource: { kind: 'database', name: 'seed', provider: 'railway' },
      verified: true,
      reason: 'test',
      metadata: {
        operation: 'databaseSeed',
        command,
        commandHash: sha256(command),
      },
    });
    expect(seedResult.success).toBe(true);
    expect(seedResult.data).toMatchObject({
      service: service.name,
      status: 'completed',
    });

    const component = new ComponentRepository().findByEnvironmentAndType(environment.id, 'postgres')!;
    const seedRecord = component.bindings.seed as Record<string, unknown>;
    expect(seedRecord).toMatchObject({
      commandHash: sha256(command),
      source: 'hv_apply',
    });
    expect(seedRecord.seededAt).toEqual(expect.any(String));

    const nextPlan = await t.call('hv_plan', { project: 'seed-apply-app', env: 'production' });
    expect(nextPlan.data.actions).not.toContainEqual(expect.objectContaining({
      id: 'database:railway:seed',
    }));
    expect(storedPlanAction(nextPlan.data.planId, 'database:railway:seed')).toMatchObject({
      id: 'database:railway:seed',
      type: 'noop',
    });
    await t.close();
  });

  it('leaves the seedCommand pending (not failed) when no image is deployed yet', async () => {
    const { ComponentRepository } = await import('../../adapters/db/repositories/component.repository.js');
    const command = 'npm run db:seed';
    const project = new ProjectRepository().create({ name: 'seed-pending-app', defaultPlatform: 'railway' });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web' },
      envVarSpec: {},
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 're-1',
        services: { web: { serviceId: 's-1' } },
      },
    });
    const component = new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'db-1',
      bindings: { provider: 'railway' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        runJob: async () => ({
          jobId: '',
          status: 'failed',
          runner: 'railway-temp-service',
          receipt: {
            success: false,
            message: 'Railway environment task requires a deployed image for service web',
            error: 'The service has no image source yet.',
            data: { pendingDeploy: true },
          },
        }),
      },
    } as any);

    const result = await applyDatabaseSeed(createToolContext(), project, 'production', {
      id: 'database:railway:seed',
      type: 'update',
      resource: { kind: 'database', name: 'seed', provider: 'railway' },
      verified: true,
      reason: 'test',
      metadata: { operation: 'databaseSeed', command, commandHash: sha256(command) },
    });

    // The apply is not failed and seededAt is NOT stamped: the seed action
    // stays in the next plan until a deploy exists and it actually runs.
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ pendingDeploy: true });
    const after = new ComponentRepository().findById(component.id)!;
    expect(after.bindings.seed).toBeUndefined();
  });

  it('tears down abandoned-provider services only when confirmed and prunes the previousHosting stash', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'previous-teardown-app',
        gitRemoteUrl: 'https://github.com/davejohnson/previous-teardown-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            database: { provider: 'supabase' },
            services: { web: { startCommand: 'npm start' } },
            domain: 'previous-teardown.example.com',
            email: { enabled: true },
            messaging: {
              services: ['web'],
              service: { name: 'Previous teardown messages' },
            },
            payments: {
              stripe: {
                catalog: {
                  products: {
                    starter: {
                      name: 'Starter',
                      prices: {
                        monthly: {
                          unitAmount: 1000,
                          currency: 'usd',
                          interval: 'month',
                          envVar: 'STRIPE_STARTER_PRICE_ID',
                        },
                      },
                    },
                  },
                },
              },
            },
            deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
          },
        },
      },
    });
    verifyRailwayConnection();
    const cloudrunConnection = new ConnectionRepository().create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        region: 'us-central1',
        credentials: '{}',
      }),
    });
    new ConnectionRepository().updateStatus(cloudrunConnection.id, 'verified');
    const project = new ProjectRepository().findByName('previous-teardown-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'rail-env-1',
        services: { web: { serviceId: 'svc-1' } },
        previousHosting: {
          provider: 'cloudrun',
          projectId: 'gcp-project',
          services: { web: { serviceId: 'gcp-project-web' } },
        },
      },
    });
    // Deliberately leave the current Railway service drifted. A retained-cleanup
    // plan must still authorize only the abandoned Cloud Run teardown.
    const observedState: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'rail-env-1',
      services: [{
        name: 'web', externalId: 'svc-1', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm run stale-start' },
        sourceState: 'disconnected',
        envVarKeys: [], envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    };
    const railwayAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: ['postgres'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {}, verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('hosting deploy should not run for previous-provider teardown'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observedState,
    };
    const deleteService = vi.fn(async () => ({ success: true }));
    const cloudrunAdapter = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile'], supportedComponents: [],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: false, managedTls: true,
        supportsObserve: true,
      },
      deleteService,
    };
    // The teardown must resolve the PREVIOUS provider's adapter, so dispatch
    // on the provider name instead of returning a single adapter.
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async (provider: string) => (
      provider === 'cloudrun'
        ? { success: true, adapter: cloudrunAdapter }
        : { success: true, adapter: railwayAdapter }
    ) as any);

    const plan = await t.call('hv_plan', {
      project: 'previous-teardown-app',
      env: 'production',
      scope: 'retained-cleanup',
    });
    expect(plan.ok).toBe(true);
    expect(plan.data.scope).toBe('retained-cleanup');
    expect(plan.data.blocked).toEqual([]);
    expect(plan.data.actions).toEqual([expect.objectContaining({
      id: 'service:web:previous-destroy',
      type: 'destroy',
      requiresConfirm: true,
      resource: { kind: 'service', name: 'web', provider: 'cloudrun' },
    })]);
    const persistedPlan = new RunRepository().findById(plan.data.planId)?.plan;
    expect(persistedPlan).toMatchObject({ scope: 'retained-cleanup' });
    expect(persistedPlan).not.toHaveProperty('integrationFingerprints');
    expect(persistedPlan).not.toHaveProperty('overrides');

    const unconfirmed = await t.call('hv_apply', { project: 'previous-teardown-app', planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:web:previous-destroy',
      status: 'skipped_requires_confirm',
    }));
    expect(deleteService).not.toHaveBeenCalled();

    // Plans are single-use: re-plan before the confirmed apply.
    const plan2 = await t.call('hv_plan', {
      project: 'previous-teardown-app',
      env: 'production',
      scope: 'retained-cleanup',
    });
    expect(plan2.ok).toBe(true);
    observedState.services[0]!.config = { startCommand: 'npm run changed-after-cleanup-plan' };
    const stale = await t.call('hv_apply', {
      project: 'previous-teardown-app',
      planId: plan2.data.planId,
      confirmActions: ['service:web:previous-destroy'],
    });
    expect(stale.ok).toBe(false);
    expect(stale.error.message).toContain('Live infrastructure changed since this plan was created');
    expect(deleteService).not.toHaveBeenCalled();

    const plan3 = await t.call('hv_plan', {
      project: 'previous-teardown-app',
      env: 'production',
      scope: 'retained-cleanup',
    });
    expect(plan3.ok).toBe(true);
    const confirmed = await t.call('hv_apply', {
      project: 'previous-teardown-app',
      planId: plan3.data.planId,
      confirmActions: ['service:web:previous-destroy'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'service:web:previous-destroy',
      status: 'succeeded',
    }));
    expect(deleteService).toHaveBeenCalledWith('gcp-project-web');

    const updated = new EnvironmentRepository().findById(environment.id)!;
    expect((updated.platformBindings as Record<string, unknown>).previousHosting ?? null).toBeNull();
    await t.close();
  });

  it('deletes an exact retained database only through isolated confirmed plan/apply and clears the binding after absence', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: {
      project: 'retained-database-apply-app',
      environments: { production: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
      } },
    } });
    verifyRailwayConnection();
    verifyConnection('cloudsql', { projectId: 'gcp-project', credentials: '{}' });
    const project = new ProjectRepository().findByName('retained-database-apply-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { web: { serviceId: 'railway-web' } },
        previousDatabase: {
          provider: 'cloudsql',
          externalId: 'legacy-production-db',
          engine: 'postgres',
          name: 'legacy-production-db',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        },
      },
    });
    const unresolved = new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: null,
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        provisioningIncomplete: true,
        unresolvedMutation: {
          resourceKind: 'database',
          operation: 'create',
          resourceName: 'legacy-production-db',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const hostingObserved: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'railway-project',
      environmentId: 'railway-environment',
      services: [{
        name: 'web', externalId: 'railway-web', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' }, sourceState: 'disconnected',
        envVarKeys: [], envVarHashes: {}, status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['nixpacks'], supportedComponents: [], supportsAutoWiring: true,
          supportsHealthChecks: true, supportsCronSchedule: true, supportsReleaseCommand: false,
          supportsMultiEnvironment: true, managedTls: true, supportsObserve: true,
        },
        configureTarget: async () => {},
        observe: async () => hostingObserved,
      },
    } as any);
    let databasePresent = true;
    const destroy = vi.fn(async (component: { externalId: string | null; bindings: Record<string, unknown> }) => {
      expect(component.externalId).toBe('legacy-production-db');
      expect(component.bindings).toMatchObject({
        retainedCleanup: true,
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      });
      databasePresent = false;
      return { success: true, message: 'deleted' };
    });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudsql',
        capabilities: {
          supportedDatabases: ['postgres'], supportsPooling: false, supportsReadReplicas: false,
          supportsPointInTimeRecovery: false, serverlessOptimized: false,
        },
        connect: async () => {}, verify: async () => ({ success: true }), disconnect: async () => {},
        provision: async () => { throw new Error('unused'); }, getConnectionUrl: async () => null,
        observeDatabase: async () => databasePresent ? ({
          provider: 'cloudsql', engine: 'postgres', externalId: 'legacy-production-db', status: 'running',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        }) : null,
        destroy,
      },
    });

    const plan = await t.call('hv_plan', {
      project: project.name,
      env: environment.name,
      scope: 'retained-cleanup',
    });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toEqual([expect.objectContaining({
      id: 'database:cloudsql:retained-destroy',
      dataBearing: true,
      requiresConfirm: true,
    })]);

    const unconfirmed = await t.call('hv_apply', { project: project.name, planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'database:cloudsql:retained-destroy',
      status: 'skipped_requires_confirm',
    }));
    expect(destroy).not.toHaveBeenCalled();

    const confirmedPlan = await t.call('hv_plan', {
      project: project.name,
      env: environment.name,
      scope: 'retained-cleanup',
    });
    const confirmed = await t.call('hv_apply', {
      project: project.name,
      planId: confirmedPlan.data.planId,
      confirmActions: ['database:cloudsql:retained-destroy'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'database:cloudsql:retained-destroy',
      status: 'succeeded',
    }));
    expect(destroy).toHaveBeenCalledOnce();
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousDatabase).toBeUndefined();
    expect(new ComponentRepository().findById(unresolved.id)).toBeNull();
    await t.close();
  });

  it('deletes an exact retained cache only through isolated confirmed plan/apply and clears the matching unresolved marker', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: {
      project: 'retained-cache-apply-app',
      environments: { production: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
      } },
    } });
    verifyRailwayConnection();
    verifyConnection('memorystore', { projectId: 'gcp-project', credentials: '{}' });
    const project = new ProjectRepository().findByName('retained-cache-apply-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { web: { serviceId: 'railway-web' } },
        previousCache: {
          provider: 'memorystore',
          externalId: 'projects/gcp-project/locations/us-west1/instances/legacy-cache',
          engine: 'redis',
          providerEngine: 'redis',
          name: 'legacy-production-cache',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        },
      },
    });
    const unresolved = new ComponentRepository().create({
      environmentId: environment.id,
      type: 'redis',
      externalId: null,
      bindings: {
        provider: 'memorystore',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        provisioningIncomplete: true,
        unresolvedMutation: {
          resourceKind: 'cache',
          operation: 'create',
          resourceName: 'legacy-production-cache',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const hostingObserved: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'railway-project',
      environmentId: 'railway-environment',
      services: [{
        name: 'web', externalId: 'railway-web', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' }, sourceState: 'disconnected',
        envVarKeys: [], envVarHashes: {}, status: 'running',
      }],
      databases: [],
      caches: [],
      partial: false,
      warnings: [],
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedBuilders: ['nixpacks'], supportedComponents: [], supportsAutoWiring: true,
          supportsHealthChecks: true, supportsCronSchedule: true, supportsReleaseCommand: false,
          supportsMultiEnvironment: true, managedTls: true, supportsObserve: true,
        },
        configureTarget: async () => {},
        observe: async () => hostingObserved,
      },
    } as any);
    let cachePresent = true;
    const destroy = vi.fn(async (component: { externalId: string | null; bindings: Record<string, unknown> }) => {
      expect(component.externalId).toBe('projects/gcp-project/locations/us-west1/instances/legacy-cache');
      expect(component.bindings).toMatchObject({
        retainedCleanup: true,
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      });
      cachePresent = false;
      return { success: true, message: 'deleted' };
    });
    vi.spyOn(adapterFactory, 'getCacheAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'memorystore',
        capabilities: {
          supportedCaches: ['redis'], supportsTls: true, supportsHighAvailability: true,
          supportsPersistence: true, serverlessOptimized: false,
        },
        connect: async () => {}, verify: async () => ({ success: true }), disconnect: async () => {},
        provision: async () => { throw new Error('unused'); }, getConnectionUrl: async () => null,
        observeCache: async () => cachePresent ? ({
          provider: 'memorystore', engine: 'redis',
          externalId: 'projects/gcp-project/locations/us-west1/instances/legacy-cache',
          name: 'legacy-production-cache', status: 'running',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        }) : null,
        destroy,
      },
    });

    const plan = await t.call('hv_plan', {
      project: project.name,
      env: environment.name,
      scope: 'retained-cleanup',
    });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toEqual([expect.objectContaining({
      id: 'cache:memorystore:retained-destroy',
      dataBearing: true,
      requiresConfirm: true,
    })]);

    const unconfirmed = await t.call('hv_apply', { project: project.name, planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'cache:memorystore:retained-destroy',
      status: 'skipped_requires_confirm',
    }));
    expect(destroy).not.toHaveBeenCalled();

    const confirmedPlan = await t.call('hv_plan', {
      project: project.name,
      env: environment.name,
      scope: 'retained-cleanup',
    });
    const confirmed = await t.call('hv_apply', {
      project: project.name,
      planId: confirmedPlan.data.planId,
      confirmActions: ['cache:memorystore:retained-destroy'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'cache:memorystore:retained-destroy',
      status: 'succeeded',
    }));
    expect(destroy).toHaveBeenCalledOnce();
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousCache).toBeUndefined();
    expect(new ComponentRepository().findById(unresolved.id)).toBeNull();
    await t.close();
  });

  it('deletes an exact retained provider resource only through isolated confirmed plan/apply', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: {
      project: 'retained-backup-apply-app',
      environments: { production: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
      } },
    } });
    verifyRailwayConnection();
    verifyConnection('cloudsql', { projectId: 'gcp-project', credentials: '{}' });
    const project = new ProjectRepository().findByName('retained-backup-apply-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { web: { serviceId: 'railway-web' } },
        previousResource: {
          provider: 'cloudsql',
          resource: 'backup',
          externalId: 'projects/gcp-project/backups/backup-123',
          name: 'backup-123',
          providerScope: { projectId: 'gcp-project' },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const hostingObserved: ObservedState = {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'railway-project', environmentId: 'railway-environment',
      services: [{
        name: 'web', externalId: 'railway-web', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' }, sourceState: 'disconnected',
        envVarKeys: [], envVarHashes: {}, status: 'running',
      }],
      databases: [], partial: false, warnings: [],
    };
    let backupPresent = true;
    const destroy = vi.fn(async () => {
      backupPresent = false;
      return { success: true, message: 'deleted' };
    });
    const cleanupAdapter = {
      disconnect: async () => {},
      inspectBackupResources: async () => ({
        observation: backupPresent ? 'present' : 'absent',
        resource: 'backup',
        backups: backupPresent ? [{
          id: 'projects/gcp-project/backups/backup-123',
          name: 'backup-123',
          providerScope: { projectId: 'gcp-project' },
        }] : [],
        partial: false,
        truncated: false,
      }),
      destroyRetainedBackup: destroy,
    };
    const hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportedComponents: [], supportsAutoWiring: true,
        supportsHealthChecks: true, supportsCronSchedule: true, supportsReleaseCommand: false,
        supportsMultiEnvironment: true, managedTls: true, supportsObserve: true,
      },
      configureTarget: async () => {},
      observe: async () => hostingObserved,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async (provider) => ({
      success: true,
      adapter: provider === 'cloudsql' ? cleanupAdapter : hostingAdapter,
    } as any));

    const plan = await t.call('hv_plan', {
      project: project.name,
      env: environment.name,
      scope: 'retained-cleanup',
    });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toEqual([expect.objectContaining({
      id: 'retained-resource:cloudsql:backup:destroy',
      dataBearing: true,
      requiresConfirm: true,
    })]);

    const unconfirmed = await t.call('hv_apply', { project: project.name, planId: plan.data.planId });
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'retained-resource:cloudsql:backup:destroy',
      status: 'skipped_requires_confirm',
    }));
    expect(destroy).not.toHaveBeenCalled();

    const confirmedPlan = await t.call('hv_plan', {
      project: project.name,
      env: environment.name,
      scope: 'retained-cleanup',
    });
    const confirmed = await t.call('hv_apply', {
      project: project.name,
      planId: confirmedPlan.data.planId,
      confirmActions: ['retained-resource:cloudsql:backup:destroy'],
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data.receipts).toContainEqual(expect.objectContaining({
      actionId: 'retained-resource:cloudsql:backup:destroy',
      status: 'succeeded',
    }));
    expect(destroy).toHaveBeenCalledOnce();
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousResource).toBeUndefined();
    await t.close();
  });

  it('uses an exact environment boundary for abandoned shared-project hosting', async () => {
    const t = await makeClient();
    await t.call('hv_spec', { spec: {
      project: 'previous-railway-environment-app',
      environments: { production: {
        hosting: { provider: 'cloudrun' },
        services: { web: { startCommand: 'npm start' } },
      } },
    } });
    verifyConnection('cloudrun', { projectId: 'gcp-project', credentials: '{}' });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('previous-railway-environment-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-central1',
        services: { web: { serviceId: 'gcp-web' } },
        previousHosting: {
          provider: 'railway', projectId: 'railway-project', environmentId: 'railway-production',
          services: { web: { serviceId: 'shared-railway-web' }, postgres: { serviceId: 'shared-railway-postgres' } },
        },
      },
    });

    const observedState: ObservedState = {
      provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'gcp-project', environmentId: 'us-central1', databases: [], partial: false, warnings: [],
      services: [{
        name: 'web', externalId: 'gcp-web', workloadKind: 'web', customDomains: [],
        config: { startCommand: 'npm start' }, sourceState: 'disconnected',
        envVarKeys: [], envVarHashes: {}, status: 'running',
      }],
    };

    const deleteEnvironment = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'absence could not be verified' })
      .mockResolvedValueOnce({ success: true });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async (provider: string) => provider === 'railway'
      ? { success: true, adapter: { name: 'railway', deleteEnvironment } } as any
      : { success: true, adapter: { name: 'cloudrun', capabilities: { supportsObserve: true }, observe: async () => observedState } } as any);

    const plan = await t.call('hv_plan', { project: project.name, env: 'production' });
    const cleanupId = 'environment:production:railway:previous-destroy';
    expect(plan.data.actions.filter((action: PlanAction) => action.id.endsWith(':previous-destroy')))
      .toEqual([expect.objectContaining({ id: cleanupId, resource: { kind: 'environment', name: 'production', provider: 'railway' } })]);

    const failed = await t.call('hv_apply', { project: project.name, planId: plan.data.planId, confirmActions: [cleanupId] });
    expect(failed.data.receipts).toContainEqual(expect.objectContaining({ actionId: cleanupId, status: 'failed' }));
    expect((new EnvironmentRepository().findById(environment.id)!.platformBindings as any).previousHosting)
      .toMatchObject({ provider: 'railway', environmentId: 'railway-production' });

    const retryPlan = await t.call('hv_plan', { project: project.name, env: 'production' });
    await t.call('hv_apply', { project: project.name, planId: retryPlan.data.planId, confirmActions: [cleanupId] });
    expect(deleteEnvironment).toHaveBeenNthCalledWith(2, 'railway-project', 'railway-production');
    expect((new EnvironmentRepository().findById(environment.id)!.platformBindings as any).previousHosting ?? null).toBeNull();
    await t.close();
  });

  it('stashes the abandoned provider bindings as previousHosting when the hosting provider switches', async () => {
    const t = await makeClient();
    await t.call('hv_spec', {
      spec: {
        project: 'provider-switch-stash-app',
        environments: {
          production: {
            hosting: { provider: 'railway' },
            services: { web: { startCommand: 'npm start' } },
          },
        },
      },
    });
    verifyRailwayConnection();
    const project = new ProjectRepository().findByName('provider-switch-stash-app')!;
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
    });
    // Provider-confirmed target absence lets the plan emit the provider-switch
    // replace actions without guessing about an existing Railway service.
    mockObserved({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: false,
      services: [],
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    });
    const fakeRailway = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true, supportsHealthChecks: true, supportsCronSchedule: true,
        supportsReleaseCommand: false, supportsMultiEnvironment: true, managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok', data: { projectId: 'rail-project', environmentId: 'rail-env' } }),
      deploy: async () => ({
        serviceId: 'web',
        externalId: 'rail-web',
        url: 'https://web-production.up.railway.app',
        status: 'deployed',
        receipt: { success: true, message: 'deployed' },
      }),
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      getDeployStatus: async () => ({ status: 'deployed', url: 'https://web-production.up.railway.app' }),
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeRailway } as any);

    const plan = await t.call('hv_plan', { project: 'provider-switch-stash-app', env: 'production' });
    expect(plan.ok).toBe(true);
    expect(plan.data.actions).toContainEqual(expect.objectContaining({
      id: 'service:web',
      type: 'replace',
    }));

    const apply = await t.call('hv_apply', { project: 'provider-switch-stash-app', planId: plan.data.planId });
    expect(apply.ok).toBe(true);

    // The stash is written before the converge pass, so it must hold
    // regardless of how the bootstrap converge itself turned out (here the
    // bootstrap pass fails on the Cloud Run prepare gate, which is fine —
    // the contract under test is the pre-converge stash, not the converge).
    const updated = new EnvironmentRepository().findById(environment.id)!;
    expect((updated.platformBindings as Record<string, unknown>).previousHosting).toMatchObject({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      services: { web: { serviceId: 'gcp-project-web' } },
    });
    await t.close();
  });
});
