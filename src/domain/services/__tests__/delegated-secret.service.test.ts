import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  parseDelegatedSecretBindings,
  planDelegatedSecrets,
  recordDelegatedSecretBindings,
} from '../delegated-secret.service.js';

const FRIEND_KEY = 'sk-ant-api03-friend-value';
const GENERATED_KEY = 'SESSION_SECRET';
const GENERATED_VALUE = 'generated-session-secret-test-value';

function spec() {
  return projectSpecSchema.parse({
    version: 1,
    project: 'friend-app',
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
      },
    },
  });
}

function generatedSpec() {
  return projectSpecSchema.parse({
    version: 1,
    project: 'generated-secret-app',
    secrets: {
      [GENERATED_KEY]: {
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1' as const,
        generation: 1,
        environments: ['production'],
      },
    },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
      },
    },
  });
}

function observedSecret(params: {
  key: string;
  hash?: string;
  presentWithoutHash?: boolean;
}): ObservedState {
  const present = params.hash !== undefined || params.presentWithoutHash === true;
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    services: [{
      name: 'web',
      externalId: 'service-1',
      workloadKind: 'web',
      customDomains: [],
      config: {},
      envVarKeys: present ? [params.key] : [],
      envVarHashes: params.hash ? { [params.key]: params.hash } : {},
      status: 'running',
    }],
    databases: [],
    partial: false,
    warnings: [],
  };
}

function observed(hash?: string): ObservedState {
  return observedSecret({ key: 'ANTHROPIC_API_KEY', ...(hash ? { hash } : {}) });
}

describe('delegated-secret.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-delegated-secret-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans a first-time missing random secret without user input or confirmation', () => {
    const planned = planDelegatedSecrets({
      spec: generatedSpec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observedSecret({ key: GENERATED_KEY }),
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.inputRequired).toEqual([]);
    expect(planned.blockers).toEqual([]);
    expect(planned.warnings).toEqual([]);
    expect(planned.desiredEnvVars).toEqual({ [GENERATED_KEY]: GENERATED_VALUE });
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({
      id: `secret:${GENERATED_KEY}`,
      type: 'update',
      verified: true,
      metadata: {
        ownership: 'hypervibe',
        principal: 'hypervibe',
        generator: 'random-base64url-32-v1',
        generation: 1,
        expectedValueHash: hashEnvValue(GENERATED_VALUE),
        inputProvided: false,
        valuePrepared: true,
        services: ['web'],
      },
    });
    expect(planned.actions[0]).not.toHaveProperty('requiresConfirm');
    expect(JSON.stringify(planned.actions)).not.toContain(GENERATED_VALUE);
  });

  it('plans a verified noop when the generated binding and live hash match', () => {
    const expectedHash = hashEnvValue(GENERATED_VALUE);
    const planned = planDelegatedSecrets({
      spec: generatedSpec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: GENERATED_KEY,
            principal: 'hypervibe',
            valueHash: expectedHash,
            source: 'hypervibe-generated',
            generator: 'random-base64url-32-v1',
            generation: 1,
            syncedAt: '2026-09-08T00:00:00.000Z',
            applyRunId: 'apply-generated-1',
            actionId: `secret:${GENERATED_KEY}`,
          }],
        },
      },
      observed: observedSecret({ key: GENERATED_KEY, hash: expectedHash }),
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.inputRequired).toEqual([]);
    expect(planned.blockers).toEqual([]);
    expect(planned.desiredEnvVars).toEqual({});
    expect(planned.actions[0]).toMatchObject({
      type: 'noop',
      verified: true,
      metadata: {
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1',
        generation: 1,
        expectedValueHash: expectedHash,
      },
    });
    expect(planned.actions[0]).not.toHaveProperty('requiresConfirm');
  });

  it('blocks when a same-generation binding cannot be reproduced locally', () => {
    const acceptedHash = hashEnvValue('value-derived-by-original-local-key');
    const planned = planDelegatedSecrets({
      spec: generatedSpec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: GENERATED_KEY,
            principal: 'hypervibe',
            valueHash: acceptedHash,
            source: 'hypervibe-generated',
            generator: 'random-base64url-32-v1',
            generation: 1,
            syncedAt: '2026-09-08T00:00:00.000Z',
            applyRunId: 'apply-generated-1',
            actionId: `secret:${GENERATED_KEY}`,
          }],
        },
      },
      observed: observedSecret({ key: GENERATED_KEY, hash: acceptedHash }),
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.desiredEnvVars).toEqual({});
    expect(planned.inputRequired).toEqual([]);
    expect(planned.blockers).toEqual([
      expect.objectContaining({ key: GENERATED_KEY, reason: expect.stringContaining('cannot reproduce') }),
    ]);
    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      verified: true,
      metadata: {
        expectedValueHash: hashEnvValue(GENERATED_VALUE),
        blockedReason: 'hypervibe_secret_key_mismatch',
      },
    });
    expect(planned.actions[0]).not.toHaveProperty('requiresConfirm');
    expect(planned.warnings[0]).toContain('Restore the original Hypervibe secret key');
  });

  it('confirmation-gates replacing an existing conflicting random value', () => {
    const planned = planDelegatedSecrets({
      spec: generatedSpec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observedSecret({
        key: GENERATED_KEY,
        hash: hashEnvValue('existing-random-live-value'),
      }),
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.blockers).toEqual([]);
    expect(planned.inputRequired).toEqual([]);
    expect(planned.desiredEnvVars).toEqual({ [GENERATED_KEY]: GENERATED_VALUE });
    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      verified: true,
      requiresConfirm: true,
      metadata: {
        ownership: 'hypervibe',
        expectedValueHash: hashEnvValue(GENERATED_VALUE),
      },
    });
    expect(planned.warnings[0]).toContain('confirmation-gated');
  });

  it('blocks a masked live secret without an accepted generated binding', () => {
    const planned = planDelegatedSecrets({
      spec: generatedSpec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observedSecret({ key: GENERATED_KEY, presentWithoutHash: true }),
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.desiredEnvVars).toEqual({});
    expect(planned.blockers).toEqual([
      expect.objectContaining({ key: GENERATED_KEY, reason: expect.stringContaining('could not be observed') }),
    ]);
    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'hypervibe_secret_observation_unknown' },
    });
    expect(planned.actions[0]).not.toHaveProperty('requiresConfirm');
  });

  it('treats an absent key as unknown when service environment observation is incomplete', () => {
    const live = observedSecret({ key: GENERATED_KEY });
    live.partial = true;
    live.completeness = { services: 'unknown' };
    live.warnings = ['Failed to read variables for "web"'];

    const planned = planDelegatedSecrets({
      spec: generatedSpec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: live,
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.desiredEnvVars).toEqual({});
    expect(planned.blockers).toEqual([
      expect.objectContaining({ key: GENERATED_KEY, reason: expect.stringContaining('could not be observed') }),
    ]);
    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'hypervibe_secret_observation_unknown' },
    });
  });

  it.each([
    ['missing', { envVarKeys: [], envVarHashes: {} }],
    ['mismatched', {
      envVarKeys: [GENERATED_KEY],
      envVarHashes: { [GENERATED_KEY]: hashEnvValue('different-live-value') },
    }],
  ])('does not hide a proven %s destination behind a masked destination noop', (_condition, secondService) => {
    const expectedHash = hashEnvValue(GENERATED_VALUE);
    const twoServiceSpec = projectSpecSchema.parse({
      ...generatedSpec(),
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {}, worker: {} },
        },
      },
    });
    const live = observedSecret({ key: GENERATED_KEY, presentWithoutHash: true });
    live.services.push({
      ...live.services[0],
      name: 'worker',
      externalId: 'service-2',
      ...secondService,
    });
    live.completeness = { services: 'complete' };

    const planned = planDelegatedSecrets({
      spec: twoServiceSpec,
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: GENERATED_KEY,
            principal: 'hypervibe',
            valueHash: expectedHash,
            source: 'hypervibe-generated',
            generator: 'random-base64url-32-v1',
            generation: 1,
            syncedAt: '2026-09-08T00:00:00.000Z',
            applyRunId: 'apply-generated-1',
            actionId: `secret:${GENERATED_KEY}`,
          }],
        },
      },
      observed: live,
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'hypervibe_secret_observation_unknown' },
    });
    expect(planned.actions[0]).not.toHaveProperty('requiresConfirm');
    expect(planned.blockers).toEqual([
      expect.objectContaining({
        key: GENERATED_KEY,
        reason: expect.stringContaining('could not be observed'),
      }),
    ]);
    expect(planned.desiredEnvVars).toEqual({});
  });

  it('preserves an accepted value when masked destinations have no known absence or drift', () => {
    const expectedHash = hashEnvValue(GENERATED_VALUE);
    const twoServiceSpec = projectSpecSchema.parse({
      ...generatedSpec(),
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {}, worker: {} },
        },
      },
    });
    const live = observedSecret({ key: GENERATED_KEY, presentWithoutHash: true });
    live.services.push({
      ...live.services[0],
      name: 'worker',
      externalId: 'service-2',
      envVarKeys: [GENERATED_KEY],
      envVarHashes: { [GENERATED_KEY]: expectedHash },
    });
    live.completeness = { services: 'complete' };

    const planned = planDelegatedSecrets({
      spec: twoServiceSpec,
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: GENERATED_KEY,
            principal: 'hypervibe',
            valueHash: expectedHash,
            source: 'hypervibe-generated',
            generator: 'random-base64url-32-v1',
            generation: 1,
            syncedAt: '2026-09-08T00:00:00.000Z',
            applyRunId: 'apply-generated-1',
            actionId: `secret:${GENERATED_KEY}`,
          }],
        },
      },
      observed: live,
      generatedValues: { [GENERATED_KEY]: GENERATED_VALUE },
    });

    expect(planned.blockers).toEqual([]);
    expect(planned.desiredEnvVars).toEqual({});
    expect(planned.actions[0]).toMatchObject({ type: 'noop', verified: false });
  });

  it('records only generated-secret hash and provenance after a successful action', () => {
    const project = new ProjectRepository().create({
      name: 'generated-secret-app',
      defaultPlatform: 'railway',
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });

    const updated = recordDelegatedSecretBindings({
      environment,
      spec: generatedSpec(),
      environmentName: 'production',
      suppliedValues: { [GENERATED_KEY]: GENERATED_VALUE },
      applyRunId: 'apply-generated-1',
      receipts: [{ actionId: `secret:${GENERATED_KEY}`, status: 'succeeded' }],
      now: '2026-09-08T00:00:00.000Z',
    });

    const bindings = parseDelegatedSecretBindings(updated);
    expect(bindings).toEqual([{
      name: GENERATED_KEY,
      principal: 'hypervibe',
      valueHash: hashEnvValue(GENERATED_VALUE),
      source: 'hypervibe-generated',
      generator: 'random-base64url-32-v1',
      generation: 1,
      syncedAt: '2026-09-08T00:00:00.000Z',
      applyRunId: 'apply-generated-1',
      actionId: `secret:${GENERATED_KEY}`,
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
    expect(JSON.stringify(updated.platformBindings)).not.toContain(GENERATED_VALUE);
  });

  it('keeps delegated secrets on the explicit-input flow for missing or unaccepted live values', () => {
    const missing = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observed(),
      generatedValues: { ANTHROPIC_API_KEY: 'must-not-be-used-for-delegated-input' },
    });
    expect(missing.inputRequired).toEqual([
      expect.objectContaining({ key: 'ANTHROPIC_API_KEY', principal: 'github:alice' }),
    ]);
    expect(missing.actions[0]).toMatchObject({
      id: 'secret:ANTHROPIC_API_KEY',
      type: 'update',
      metadata: { inputRequired: true, inputProvided: false },
    });
    expect(missing.desiredEnvVars).toEqual({});

    const unaccepted = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observed(hashEnvValue('some-other-live-key')),
    });
    expect(unaccepted.inputRequired[0]?.reason).toContain('has not been accepted');
    expect(unaccepted.warnings[0]).toContain('preserved');
  });

  it('treats an accepted matching hash as in sync and preserves drift', () => {
    const acceptedHash = hashEnvValue(FRIEND_KEY);
    const environment = {
      platformBindings: {
        delegatedEnvBindings: [{
          name: 'ANTHROPIC_API_KEY',
          principal: 'github:alice',
          valueHash: acceptedHash,
          source: 'delegated-plan-input',
          syncedAt: '2026-07-17T00:00:00.000Z',
          applyRunId: 'apply-1',
          actionId: 'secret:ANTHROPIC_API_KEY',
        }],
      },
    };

    const matching = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment,
      observed: observed(acceptedHash),
    });
    expect(matching.inputRequired).toEqual([]);
    expect(matching.actions[0]).toMatchObject({ type: 'noop', verified: true });

    const drifted = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment,
      observed: observed(hashEnvValue('changed-out-of-band')),
    });
    expect(drifted.actions[0]).toMatchObject({
      type: 'update',
      metadata: { inputRequired: true, driftPolicy: 'preserve' },
    });
    expect(drifted.inputRequired[0]?.reason).toContain('differs');
    expect(drifted.desiredEnvVars).toEqual({});
  });

  it('requires re-acceptance when the declared principal changes', () => {
    const acceptedHash = hashEnvValue(FRIEND_KEY);
    const changedPrincipalSpec = projectSpecSchema.parse({
      ...spec(),
      secrets: {
        ANTHROPIC_API_KEY: {
          principal: 'github:bob',
          environments: ['production'],
        },
      },
    });
    const planned = planDelegatedSecrets({
      spec: changedPrincipalSpec,
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: 'ANTHROPIC_API_KEY',
            principal: 'github:alice',
            valueHash: acceptedHash,
            source: 'delegated-plan-input',
            syncedAt: '2026-07-17T00:00:00.000Z',
            applyRunId: 'apply-1',
            actionId: 'secret:ANTHROPIC_API_KEY',
          }],
        },
      },
      observed: observed(acceptedHash),
    });

    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      metadata: { inputRequired: true, principal: 'github:bob' },
    });
    expect(planned.inputRequired[0]?.reason).toContain('must be re-accepted');
    expect(planned.desiredEnvVars).toEqual({});

    const unobservable = planDelegatedSecrets({
      spec: changedPrincipalSpec,
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: 'ANTHROPIC_API_KEY',
            principal: 'github:alice',
            valueHash: acceptedHash,
            source: 'delegated-plan-input',
            syncedAt: '2026-07-17T00:00:00.000Z',
            applyRunId: 'apply-1',
            actionId: 'secret:ANTHROPIC_API_KEY',
          }],
        },
      },
      observed: null,
    });
    expect(unobservable.inputRequired[0]?.reason).toContain('must be re-accepted');
    expect(unobservable.actions[0]).toMatchObject({ type: 'update', verified: false });
  });

  it('uses a supplied value as desired input without exposing it in the action', () => {
    const planned = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observed(),
      suppliedValues: { ANTHROPIC_API_KEY: FRIEND_KEY },
    });
    expect(planned.inputRequired).toEqual([]);
    expect(planned.desiredEnvVars).toEqual({ ANTHROPIC_API_KEY: FRIEND_KEY });
    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      metadata: { inputProvided: true, principal: 'github:alice' },
    });
    expect(JSON.stringify(planned.actions)).not.toContain(FRIEND_KEY);
  });

  it('records only an accepted hash after a succeeded action receipt', () => {
    const project = new ProjectRepository().create({ name: 'friend-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });

    const updated = recordDelegatedSecretBindings({
      environment,
      spec: spec(),
      environmentName: 'production',
      suppliedValues: { ANTHROPIC_API_KEY: FRIEND_KEY },
      applyRunId: 'apply-1',
      receipts: [{ actionId: 'secret:ANTHROPIC_API_KEY', status: 'succeeded' }],
      now: '2026-07-17T00:00:00.000Z',
    });

    expect(parseDelegatedSecretBindings(updated)).toEqual([{
      name: 'ANTHROPIC_API_KEY',
      principal: 'github:alice',
      valueHash: hashEnvValue(FRIEND_KEY),
      source: 'delegated-plan-input',
      syncedAt: '2026-07-17T00:00:00.000Z',
      applyRunId: 'apply-1',
      actionId: 'secret:ANTHROPIC_API_KEY',
    }]);
    expect(JSON.stringify(updated.platformBindings)).not.toContain(FRIEND_KEY);
  });

  it('does not record a value when its action receipt did not succeed', () => {
    const project = new ProjectRepository().create({ name: 'friend-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });

    const unchanged = recordDelegatedSecretBindings({
      environment,
      spec: spec(),
      environmentName: 'production',
      suppliedValues: { ANTHROPIC_API_KEY: FRIEND_KEY },
      applyRunId: 'apply-1',
      receipts: [{ actionId: 'secret:ANTHROPIC_API_KEY', status: 'failed' }],
    });

    expect(parseDelegatedSecretBindings(unchanged)).toEqual([]);
    expect(JSON.stringify(unchanged.platformBindings)).not.toContain(FRIEND_KEY);
  });
});
