import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { createToolContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { parseDelegatedSecretBindings } from '../../services/delegated-secret.service.js';
import { hashEnvValue } from '../../ports/observe.port.js';
import { PlanService } from '../plan.service.js';

const FRIEND_KEY = 'sk-ant-api03-plan-secret';

function observed(): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-environment',
    services: [{
      name: 'web',
      externalId: 'rail-service',
      workloadKind: 'web',
      customDomains: [],
      config: {},
      sourceState: 'disconnected',
      envVarKeys: [],
      envVarHashes: {},
      status: 'running',
    }],
    databases: [{
      provider: 'railway',
      engine: 'postgres',
      externalId: 'rail-postgres',
      name: 'Postgres',
      status: 'running',
    }],
    partial: false,
    warnings: [],
  };
}

function replaceWithHypervibeManagedSecrets(
  project: ReturnType<ProjectRepository['create']>
): void {
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    secrets: {
      SESSION_SECRET: {
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1',
        environments: ['production'],
      },
    },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        database: { provider: 'railway' },
      },
    },
  });
}

describe('PlanService delegated secret inputs', () => {
  let tempDir: string;
  let project: ReturnType<ProjectRepository['create']>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-delegated-plan-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'friend-app', defaultPlatform: 'railway' });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      secrets: {
        ANTHROPIC_API_KEY: {
          principal: 'github:alice',
          environments: ['production'],
        },
      },
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          database: { provider: 'railway' },
        },
      },
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-environment',
        services: { web: { serviceId: 'rail-service' } },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'rail-postgres',
      bindings: { provider: 'railway', pluginName: 'Postgres', serviceId: 'rail-postgres' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsObserve: true },
        observe: vi.fn().mockResolvedValue(observed()),
      } as never,
    });
  });

  afterEach(() => {
    delete process.env.FRIEND_ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists an inspectable but non-executable plan when required input is absent', async () => {
    const envFile = path.join(tempDir, '.env');
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=\n', 'utf8');
    const result = await new PlanService().plan(project, 'production', { envFile });
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.inputRequired).toEqual([
      expect.objectContaining({ key: 'ANTHROPIC_API_KEY', principal: 'github:alice' }),
    ]);

    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(document.inputRequired).toEqual(plan.inputRequired);
    expect(document.overrides).toBeUndefined();

    const currentSpec = new SpecStore().get(project)!;
    const outcome = await executePlanApply(createToolContext(), {
      project,
      spec: currentSpec.spec,
      specRevision: currentSpec.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });
    expect(outcome).toEqual({
      kind: 'input_required',
      envName: 'production',
      requirements: plan.inputRequired,
    });
    expect(new RunRepository().findByEnvironmentId(
      new EnvironmentRepository().findByProjectAndName(project.id, 'production')!.id
    ).filter((run) => run.type === 'apply')).toEqual([]);
  });

  it('resolves a safe reference, encrypts the value, and includes it in env drift', async () => {
    process.env.FRIEND_ANTHROPIC_API_KEY = FRIEND_KEY;
    const result = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
      secretRefs: { ANTHROPIC_API_KEY: 'env:FRIEND_ANTHROPIC_API_KEY' },
    });
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.inputRequired).toEqual([]);
    expect(plan.actions.find((action) => action.id === 'secret:ANTHROPIC_API_KEY')).toMatchObject({
      type: 'update',
      metadata: { inputProvided: true, services: ['web'] },
    });
    expect(plan.actions.find((action) => action.id === 'service:web')?.diff).toContainEqual({
      field: 'env:ANTHROPIC_API_KEY',
    });

    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain(FRIEND_KEY);
    expect(serialized).not.toContain('FRIEND_ANTHROPIC_API_KEY');
    const overrides = document.overrides as Record<string, unknown>;
    expect(overrides.delegatedSecretKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(getSecretStore().decryptObject(overrides.delegatedSecretVarsEncrypted as string)).toEqual({
      ANTHROPIC_API_KEY: FRIEND_KEY,
    });
  });

  it('injects the resolved value at apply and records only its accepted hash', async () => {
    process.env.FRIEND_ANTHROPIC_API_KEY = FRIEND_KEY;
    const connection = new ConnectionRepository().create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-account-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    const setEnvVars = vi.fn(async () => ({ success: true, message: 'synced' }));
    const deploy = vi.fn(async () => ({
      serviceId: 'rail-service',
      externalId: 'rail-service',
      status: 'deployed' as const,
      receipt: { success: true, message: 'deployed' },
    }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({
        success: true,
        message: 'exists',
        data: { projectId: 'rail-project', environmentId: 'rail-environment' },
      }),
      observe: vi.fn().mockResolvedValue(observed()),
      setEnvVars,
      deploy,
    };
    vi.mocked(adapterFactory.getProviderAdapter).mockResolvedValue({ success: true, adapter } as never);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter } as never);
    const provision = vi.fn();
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { provision },
    } as never);

    const planned = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
      secretRefs: { ANTHROPIC_API_KEY: 'env:FRIEND_ANTHROPIC_API_KEY' },
    });
    expect(planned).not.toHaveProperty('error');
    const plan = planned as Exclude<typeof planned, { error: string }>;
    const currentSpec = new SpecStore().get(project)!;
    const outcome = await executePlanApply(createToolContext(), {
      project,
      spec: currentSpec.spec,
      specRevision: currentSpec.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'web' }),
      expect.objectContaining({ ANTHROPIC_API_KEY: FRIEND_KEY })
    );
    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'web' }),
      expect.anything(),
      expect.not.objectContaining({ ANTHROPIC_API_KEY: FRIEND_KEY })
    );
    expect(provision).not.toHaveBeenCalled();
    const updatedEnvironment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(parseDelegatedSecretBindings(updatedEnvironment)).toEqual([
      expect.objectContaining({
        name: 'ANTHROPIC_API_KEY',
        principal: 'github:alice',
        valueHash: hashEnvValue(FRIEND_KEY),
      }),
    ]);
    expect(JSON.stringify(updatedEnvironment.platformBindings)).not.toContain(FRIEND_KEY);
  });

  it('rejects attempts to supply a delegated value through ordinary envVars', async () => {
    const result = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
      envVarOverrides: { ANTHROPIC_API_KEY: FRIEND_KEY },
    });
    expect(result).toMatchObject({ error: expect.stringContaining('Use secretRefs') });
  });

  it('derives, plans, and encrypts Hypervibe-owned values without asking for input', async () => {
    replaceWithHypervibeManagedSecrets(project);

    const result = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
    });

    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.inputRequired).toEqual([]);
    expect(plan.actions.find((action) => action.id === 'secret:SESSION_SECRET')).toMatchObject({
      type: 'update',
      dependsOn: ['service:web'],
      metadata: {
        ownership: 'hypervibe',
        principal: 'hypervibe',
        generator: 'random-base64url-32-v1',
        generation: 1,
        inputProvided: false,
        valuePrepared: true,
        services: ['web'],
      },
    });
    expect(plan.actions.find((action) => action.id === 'service:web')?.diff?.map((entry) => entry.field))
      .toEqual(expect.arrayContaining(['env:SESSION_SECRET']));

    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    const overrides = document.overrides as Record<string, unknown>;
    expect(overrides.delegatedSecretKeys).toEqual(['SESSION_SECRET']);
    const decrypted = getSecretStore().decryptObject<Record<string, unknown>>(
      overrides.delegatedSecretVarsEncrypted as string
    );
    const sessionSecret = decrypted.SESSION_SECRET;
    const sessionContractIsValid = typeof sessionSecret === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(sessionSecret)
      && Buffer.from(sessionSecret, 'base64url').length === 32;
    expect(sessionContractIsValid).toBe(true);
    const serialized = JSON.stringify(document);
    const serializedContainsGeneratedValue = Object.values(decrypted)
      .some((value) => typeof value === 'string' && serialized.includes(value));
    expect(serializedContainsGeneratedValue).toBe(false);
  });

  it('rejects user input for Hypervibe-owned slots before resolving references or saving a plan', async () => {
    replaceWithHypervibeManagedSecrets(project);
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    const runsBefore = new RunRepository().findByEnvironmentId(environment.id).length;

    const result = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
      secretRefs: { SESSION_SECRET: 'env:THIS_REFERENCE_MUST_NOT_BE_READ' },
    });

    expect(result).toMatchObject({
      error: expect.stringContaining('secretRefs cannot supply Hypervibe-owned secret keys: SESSION_SECRET'),
    });
    expect(new RunRepository().findByEnvironmentId(environment.id)).toHaveLength(runsBefore);
  });

  it('reserves Hypervibe-owned slots from ordinary env overrides and env files', async () => {
    replaceWithHypervibeManagedSecrets(project);

    const overrideResult = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
      envVarOverrides: { SESSION_SECRET: 'caller-selected-value' },
    });
    expect(overrideResult).toMatchObject({
      error: expect.stringContaining('Managed secret keys cannot be passed through envVars: SESSION_SECRET'),
    });

    const envFile = path.join(tempDir, '.env.production');
    fs.writeFileSync(envFile, 'PUBLIC_LABEL=friend\nSESSION_SECRET=caller-selected-value\n', 'utf8');
    const fileResult = await new PlanService().plan(project, 'production', { envFile });
    expect(fileResult).not.toHaveProperty('error');
    const plan = fileResult as Exclude<typeof fileResult, { error: string }>;
    const document = new RunRepository().findById(plan.planRunId)!.plan as Record<string, unknown>;
    const overrides = document.overrides as Record<string, unknown>;
    expect(overrides.envFileKeys).toEqual(['PUBLIC_LABEL']);
    expect(overrides.delegatedSecretKeys).toEqual(['SESSION_SECRET']);
    expect(JSON.stringify(document).includes('caller-selected-value')).toBe(false);
  });

  it('returns a planning error without saving a run when generated-secret safety is unknown', async () => {
    replaceWithHypervibeManagedSecrets(project);
    vi.mocked(adapterFactory.getProviderAdapter).mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsObserve: false },
      } as never,
    });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    const runsBefore = new RunRepository().findByEnvironmentId(environment.id).length;

    const result = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
    });

    expect(result).toMatchObject({
      error: expect.stringContaining('Hypervibe cannot safely plan its managed secrets'),
    });
    expect((result as { error: string }).error).toContain('SESSION_SECRET');
    expect((result as { error: string }).error).toContain('No plan was saved or provider mutation authorized');
    expect(new RunRepository().findByEnvironmentId(environment.id)).toHaveLength(runsBefore);
  });
});
