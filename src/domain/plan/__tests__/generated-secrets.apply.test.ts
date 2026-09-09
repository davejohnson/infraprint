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
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Service } from '../../entities/service.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { hashEnvValue } from '../../ports/observe.port.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { parseDelegatedSecretBindings } from '../../services/delegated-secret.service.js';
import { deriveHypervibeSecretValues } from '../../services/hypervibe-secret-value.js';
import { createToolContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { runWithWorkspaceDirectories } from '../../../lib/workspace-context.js';
import { PlanService } from '../plan.service.js';
import type { PlanAction } from '../plan.types.js';

const SECRET_KEY = 'SESSION_SECRET';
const SERVICE_NAMES = ['web', 'worker'];

function observed(liveHashes: Map<string, string>): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-environment',
    services: SERVICE_NAMES.map((name) => {
      const hash = liveHashes.get(name);
      const envVarHashes: Record<string, string> = hash ? { [SECRET_KEY]: hash } : {};
      return {
        name,
        externalId: `rail-${name}`,
        workloadKind: name === 'worker' ? 'worker' as const : 'web' as const,
        customDomains: [],
        config: {},
        sourceState: 'disconnected' as const,
        envVarKeys: hash ? [SECRET_KEY] : [],
        envVarHashes,
        status: 'running' as const,
      };
    }),
    databases: [],
    partial: false,
    warnings: [],
  };
}

describe('generated secret plan/apply integration', () => {
  let tempDir: string;
  let project: ReturnType<ProjectRepository['create']>;
  let liveHashes: Map<string, string>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-generated-apply-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    liveHashes = new Map();

    project = new ProjectRepository().create({
      name: 'generated-secret-app',
      defaultPlatform: 'railway',
    });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      secrets: {
        [SECRET_KEY]: {
          ownership: 'hypervibe',
          generator: 'random-base64url-32-v1',
          generation: 1,
          environments: ['production'],
        },
      },
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: {
            web: {},
            worker: { workloadKind: 'worker' },
          },
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
        services: {
          web: { serviceId: 'rail-web' },
          worker: { serviceId: 'rail-worker' },
        },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web' },
      envVarSpec: {},
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'worker',
      buildConfig: { workloadKind: 'worker' },
      envVarSpec: {},
    });
    const connection = new ConnectionRepository().create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-account-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function installAdapter(options: { failOnceFor?: string } = {}) {
    let remainingFailure = options.failOnceFor;
    const setEnvVars = vi.fn(async (
      _environment: Environment,
      service: Service,
      vars: Record<string, string>
    ) => {
      const value = vars[SECRET_KEY];
      if (remainingFailure === service.name) {
        remainingFailure = undefined;
        return {
          success: false,
          message: `Rejected generated environment update for ${service.name}`,
          error: 'simulated provider failure',
        };
      }
      if (value) liveHashes.set(service.name, hashEnvValue(value));
      return { success: true, message: `Synced ${service.name}` };
    });
    const deploy = vi.fn(async (service: Service) => ({
      serviceId: service.id,
      externalId: `rail-${service.name}`,
      status: 'deployed' as const,
      receipt: { success: true, message: `Deployed ${service.name}` },
    }));
    const adapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: [],
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
      observe: vi.fn(async () => observed(liveHashes)),
      setEnvVars,
      deploy,
    };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter,
    } as never);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter,
    } as never);
    return { adapter, deploy, setEnvVars };
  }

  async function plan() {
    const result = await new PlanService().plan(project, 'production', {
      includeEnvFile: false,
    });
    if ('error' in result) throw new Error(result.error);
    return result;
  }

  async function apply(planRunId: string, confirmActions: string[] = []) {
    const currentSpec = new SpecStore().get(project)!;
    return executePlanApply(createToolContext(), {
      project,
      spec: currentSpec.spec,
      specRevision: currentSpec.revision,
      planId: planRunId,
      confirmActions,
    });
  }

  function generatedSecretCalls(
    setEnvVars: ReturnType<typeof installAdapter>['setEnvVars'],
    fromIndex = 0
  ) {
    return setEnvVars.mock.calls
      .slice(fromIndex)
      .filter(([, , vars]) => typeof vars[SECRET_KEY] === 'string');
  }

  it('installs one generated value on every service and persists only accepted provenance', async () => {
    const { setEnvVars } = installAdapter();
    const planned = await plan();
    const secretAction = planned.actions.find((action) => action.id === `secret:${SECRET_KEY}`);
    expect(planned.inputRequired).toEqual([]);
    expect(secretAction).toMatchObject({
      type: 'update',
      metadata: {
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1',
        generation: 1,
        inputProvided: false,
        valuePrepared: true,
        services: SERVICE_NAMES,
      },
    });
    expect(secretAction).not.toHaveProperty('requiresConfirm');

    const storedPlan = new RunRepository().findById(planned.planRunId)!;
    const storedPlanDocument = storedPlan.plan as Record<string, unknown>;
    expect(storedPlanDocument.overrides).toMatchObject({
      delegatedSecretKeys: [SECRET_KEY],
      delegatedSecretVarsEncrypted: expect.any(String),
    });

    const outcome = await apply(planned.planRunId);
    expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
    if (outcome.kind !== 'executed' || !outcome.result.applyRunId) {
      throw new Error('Expected a completed generated-secret apply run');
    }

    const secretCalls = generatedSecretCalls(setEnvVars);
    expect(secretCalls.map(([, service]) => service.name).sort()).toEqual(SERVICE_NAMES);
    expect(secretCalls).toHaveLength(2);
    const values = secretCalls.map(([, , vars]) => vars[SECRET_KEY]);
    expect(new Set(values).size).toBe(1);
    const generatedValue = values[0];
    expect(generatedValue).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const secretReceipt = outcome.result.receipts.find(
      (receipt) => receipt.actionId === `secret:${SECRET_KEY}`
    );
    expect(secretReceipt).toMatchObject({
      status: 'succeeded',
      data: {
        requestedCount: 2,
        appliedCount: 2,
        failedCount: 0,
        skippedCount: 0,
        bindingRecorded: true,
        services: SERVICE_NAMES,
      },
    });

    const updatedEnvironment = new EnvironmentRepository()
      .findByProjectAndName(project.id, 'production')!;
    const bindings = parseDelegatedSecretBindings(updatedEnvironment);
    expect(bindings).toEqual([{
      name: SECRET_KEY,
      principal: 'hypervibe',
      valueHash: hashEnvValue(generatedValue),
      source: 'hypervibe-generated',
      generator: 'random-base64url-32-v1',
      generation: 1,
      syncedAt: expect.any(String),
      applyRunId: outcome.result.applyRunId,
      actionId: `secret:${SECRET_KEY}`,
    }]);
    expect(Object.keys(bindings[0]).sort()).toEqual([
      'actionId',
      'applyRunId',
      'generation',
      'generator',
      'name',
      'principal',
      'source',
      'syncedAt',
      'valueHash',
    ]);

    const storedApply = new RunRepository().findById(outcome.result.applyRunId)!;
    for (const surface of [planned, storedPlan, outcome, updatedEnvironment.platformBindings, storedApply]) {
      expect(JSON.stringify(surface)).not.toContain(generatedValue);
    }
  });

  it('does not accept a partial provider write and derives the identical value for retry', async () => {
    const { setEnvVars } = installAdapter({ failOnceFor: 'worker' });
    const firstPlan = await plan();
    const firstStoredPlan = new RunRepository().findById(firstPlan.planRunId)!;
    const firstOutcome = await apply(firstPlan.planRunId);
    expect(firstOutcome).toMatchObject({ kind: 'executed', result: { success: false } });
    if (firstOutcome.kind !== 'executed' || !firstOutcome.result.applyRunId) {
      throw new Error('Expected a failed generated-secret apply run');
    }

    const firstCalls = generatedSecretCalls(setEnvVars);
    expect(firstCalls).toHaveLength(2);
    const firstValues = firstCalls.map(([, , vars]) => vars[SECRET_KEY]);
    expect(new Set(firstValues).size).toBe(1);
    const firstGeneratedValue = firstValues[0];
    const failedReceipt = firstOutcome.result.receipts.find(
      (receipt) => receipt.actionId === `secret:${SECRET_KEY}`
    );
    expect(failedReceipt).toMatchObject({
      status: 'failed',
      data: {
        requestedCount: 2,
        appliedCount: 1,
        failedCount: 1,
        skippedCount: 0,
        bindingRecorded: false,
        failureStage: 'provider',
      },
    });
    expect(parseDelegatedSecretBindings(
      new EnvironmentRepository().findByProjectAndName(project.id, 'production')!
    )).toEqual([]);
    for (const surface of [firstPlan, firstStoredPlan, firstOutcome]) {
      expect(JSON.stringify(surface)).not.toContain(firstGeneratedValue);
    }

    const callCountBeforeRetry = setEnvVars.mock.calls.length;
    const retryPlan = await plan();
    const retryAction = retryPlan.actions.find((action) => action.id === `secret:${SECRET_KEY}`);
    expect(retryAction).toMatchObject({ type: 'update' });
    expect(retryAction).not.toHaveProperty('requiresConfirm');
    expect(retryPlan.inputRequired).toEqual([]);
    expect(JSON.stringify(retryPlan)).not.toContain(firstGeneratedValue);

    const retryOutcome = await apply(retryPlan.planRunId);
    expect(retryOutcome).toMatchObject({ kind: 'executed', result: { success: true } });
    if (retryOutcome.kind !== 'executed' || !retryOutcome.result.applyRunId) {
      throw new Error('Expected a successful generated-secret retry run');
    }
    const retryCalls = generatedSecretCalls(setEnvVars, callCountBeforeRetry);
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls.map(([, , vars]) => vars[SECRET_KEY])).toEqual([
      firstGeneratedValue,
      firstGeneratedValue,
    ]);

    const updatedEnvironment = new EnvironmentRepository()
      .findByProjectAndName(project.id, 'production')!;
    expect(parseDelegatedSecretBindings(updatedEnvironment)).toEqual([
      expect.objectContaining({
        name: SECRET_KEY,
        valueHash: hashEnvValue(firstGeneratedValue),
        source: 'hypervibe-generated',
        applyRunId: retryOutcome.result.applyRunId,
      }),
    ]);
    expect(JSON.stringify(updatedEnvironment.platformBindings)).not.toContain(firstGeneratedValue);
    expect(JSON.stringify(retryOutcome)).not.toContain(firstGeneratedValue);
  });

  it('blocks a persisted generated-secret rotation when its confirmation marker is stripped', async () => {
    const { setEnvVars } = installAdapter();
    const initialPlan = await plan();
    const initialOutcome = await apply(initialPlan.planRunId);
    expect(initialOutcome).toMatchObject({ kind: 'executed', result: { success: true } });

    const currentSpec = new SpecStore().get(project)!.spec;
    new SpecStore().replace(project, {
      ...currentSpec,
      secrets: {
        ...currentSpec.secrets,
        [SECRET_KEY]: {
          ...currentSpec.secrets[SECRET_KEY],
          generation: 2,
        },
      },
    });

    const rotationPlan = await plan();
    expect(rotationPlan.actions.find((action) => action.id === `secret:${SECRET_KEY}`))
      .toMatchObject({ type: 'update', requiresConfirm: true });

    const runRepository = new RunRepository();
    const storedPlan = runRepository.findById(rotationPlan.planRunId)!;
    const storedDocument = storedPlan.plan as Record<string, unknown> & { actions: PlanAction[] };
    runRepository.updatePlan(rotationPlan.planRunId, {
      ...storedDocument,
      actions: storedDocument.actions.map((action) => {
        if (action.id !== `secret:${SECRET_KEY}`) return action;
        const tampered = { ...action };
        delete tampered.requiresConfirm;
        return tampered;
      }),
    });

    const callsBeforeTamperedApply = setEnvVars.mock.calls.length;
    const actionId = `secret:${SECRET_KEY}`;
    const outcome = await apply(rotationPlan.planRunId, [actionId]);

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: expect.arrayContaining([
          expect.objectContaining({
            actionId: `secret:${SECRET_KEY}`,
            status: 'blocked',
            error: expect.stringContaining('confirmation'),
          }),
        ]),
      },
    });
    expect(setEnvVars.mock.calls).toHaveLength(callsBeforeTamperedApply);

    runRepository.updatePlan(rotationPlan.planRunId, storedDocument);
    const confirmedOutcome = await apply(rotationPlan.planRunId, [actionId]);
    expect(confirmedOutcome).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(generatedSecretCalls(setEnvVars, callsBeforeTamperedApply)).toHaveLength(2);
  });

  it('records a matching live generated value without rewriting the provider', async () => {
    const { setEnvVars } = installAdapter();
    const currentSpec = new SpecStore().get(project)!.spec;
    const generatedValue = deriveHypervibeSecretValues(currentSpec, 'production')[SECRET_KEY];
    for (const serviceName of SERVICE_NAMES) {
      liveHashes.set(serviceName, hashEnvValue(generatedValue));
    }

    const planned = await plan();
    expect(planned.actions.find((action) => action.id === `secret:${SECRET_KEY}`)).toMatchObject({
      type: 'update',
      metadata: { bindingOnly: true },
    });

    const outcome = await apply(planned.planRunId);
    expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
    if (outcome.kind !== 'executed' || !outcome.result.applyRunId) {
      throw new Error('Expected a successful binding-only apply');
    }
    expect(generatedSecretCalls(setEnvVars)).toEqual([]);
    expect(outcome.result.receipts.find(
      (receipt) => receipt.actionId === `secret:${SECRET_KEY}`
    )).toMatchObject({
      status: 'succeeded',
      data: {
        requestedCount: 2,
        appliedCount: 0,
        failedCount: 0,
        skippedCount: 2,
        bindingRecorded: true,
      },
    });
    expect(parseDelegatedSecretBindings(
      new EnvironmentRepository().findByProjectAndName(project.id, 'production')!
    )).toEqual([
      expect.objectContaining({
        name: SECRET_KEY,
        valueHash: hashEnvValue(generatedValue),
        applyRunId: outcome.result.applyRunId,
      }),
    ]);
    expect(JSON.stringify(outcome)).not.toContain(generatedValue);
  });

  it('fails the action when provider sync succeeds but binding persistence fails', async () => {
    const { setEnvVars } = installAdapter();
    const planned = await plan();
    const updatePlatformBindings = EnvironmentRepository.prototype.updatePlatformBindings;
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (
      this: EnvironmentRepository,
      id: string,
      bindings: Record<string, unknown>
    ) {
      if (Object.prototype.hasOwnProperty.call(bindings, 'delegatedEnvBindings')) return null;
      return updatePlatformBindings.call(this, id, bindings);
    });

    const outcome = await apply(planned.planRunId);
    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    if (outcome.kind !== 'executed') throw new Error('Expected an executed apply result');
    expect(generatedSecretCalls(setEnvVars)).toHaveLength(2);
    expect(outcome.result.receipts.find(
      (receipt) => receipt.actionId === `secret:${SECRET_KEY}`
    )).toMatchObject({
      status: 'failed',
      message: `Synced ${SECRET_KEY}, but failed to record its accepted fingerprint`,
      data: {
        requestedCount: 2,
        appliedCount: 2,
        failedCount: 0,
        skippedCount: 0,
        bindingRecorded: false,
        failureStage: 'binding',
      },
    });
    expect(parseDelegatedSecretBindings(
      new EnvironmentRepository().findByProjectAndName(project.id, 'production')!
    )).toEqual([]);
  });

  it('replans a binding-only retry when repository export fails after SQLite persistence', async () => {
    const { setEnvVars } = installAdapter();
    const repoDir = path.join(tempDir, 'repo');
    const hypervibeDir = path.join(repoDir, '.hypervibe');
    const bindingsFile = path.join(hypervibeDir, 'bindings.json');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.mkdirSync(hypervibeDir, { recursive: true });
    const oldDisableRepoSpec = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';

    try {
      await runWithWorkspaceDirectories([repoDir], async () => {
        const planned = await plan();
        const malformed = '{"doNotOverwrite":"repository-owner-content",';
        setEnvVars.mockImplementation(async (
          _environment: Environment,
          service: Service,
          vars: Record<string, string>
        ) => {
          const value = vars[SECRET_KEY];
          if (value) {
            liveHashes.set(service.name, hashEnvValue(value));
            if (service.name === 'worker') {
              // Fail the derived repo export only after every provider secret
              // write has succeeded and the handler begins recording its
              // accepted local binding.
              fs.writeFileSync(bindingsFile, malformed, 'utf8');
            }
          }
          return { success: true, message: `Synced ${service.name}` };
        });

        const firstOutcome = await apply(planned.planRunId);
        expect(firstOutcome).toMatchObject({ kind: 'executed', result: { success: false } });
        if (firstOutcome.kind !== 'executed' || !firstOutcome.result.applyRunId) {
          throw new Error('Expected a failed generated-secret apply run');
        }
        expect(firstOutcome.result.receipts.find(
          (receipt) => receipt.actionId === `secret:${SECRET_KEY}`
        )).toMatchObject({
          status: 'failed',
          data: { bindingRecorded: false, failureStage: 'binding' },
        });
        expect(fs.readFileSync(bindingsFile, 'utf8')).toBe(malformed);

        const provisionalBinding = parseDelegatedSecretBindings(
          new EnvironmentRepository().findByProjectAndName(project.id, 'production')!
        );
        expect(provisionalBinding).toEqual([
          expect.objectContaining({
            name: SECRET_KEY,
            applyRunId: firstOutcome.result.applyRunId,
          }),
        ]);

        fs.rmSync(bindingsFile);
        const callsBeforeRetry = setEnvVars.mock.calls.length;
        const retryPlan = await plan();
        expect(retryPlan.actions.find((action) => action.id === `secret:${SECRET_KEY}`)).toMatchObject({
          type: 'update',
          metadata: { bindingOnly: true },
        });

        const retryOutcome = await apply(retryPlan.planRunId);
        expect(retryOutcome).toMatchObject({ kind: 'executed', result: { success: true } });
        expect(setEnvVars.mock.calls).toHaveLength(callsBeforeRetry);
        const exported = JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) as {
          environments: Record<string, { platformBindings: Record<string, unknown> }>;
        };
        expect(exported.environments.production.platformBindings.delegatedEnvBindings).toEqual([
          expect.objectContaining({ name: SECRET_KEY, source: 'hypervibe-generated' }),
        ]);
      });
    } finally {
      if (oldDisableRepoSpec === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisableRepoSpec;
    }
  });
});
