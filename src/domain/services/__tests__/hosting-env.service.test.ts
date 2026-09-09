import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../../../domain/services/adapter.factory.js';
import { assessSendGridScopes } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import type { IHostingAdapter } from '../../../domain/ports/hosting.port.js';
import type { IProviderEnvironmentVariablesAdapter } from '../../../domain/ports/provider-env-vars.port.js';
import { getSendGridAdapter, sendGridSetupReady, sendGridPermissionPayload } from '../sendgrid-ops.service.js';
import { getProjectScopeHints } from '../project-scope.js';
import {
  readHostingEnvVars,
  removeHostingEnvVars,
  syncHostingEnvVars,
} from '../hosting-env.service.js';

describe('hosting env var tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-hosting-env-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupCloudRunProject() {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({
      name: 'cloudrun-integrations',
      defaultPlatform: 'cloudrun',
    });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: {
        workloadKind: 'web',
        builder: 'dockerfile',
        startCommand: 'npm start',
      },
      envVarSpec: {},
    });
    connectionRepo.create({
      provider: 'sendgrid',
      credentialsEncrypted: secretStore.encryptObject({ apiKey: 'SG.test-key' }),
    });

    return { project, environment, service };
  }

  function stubCloudRunHostingAdapter(varsByService = new Map<string, Record<string, string>>()) {
    const setEnvCalls: Array<{ environment: Environment; service: Service; vars: Record<string, string> }> = [];
    const deleteEnvCalls: Array<{ environment: Environment; service: Service; keys: string[] }> = [];
    const adapter: IHostingAdapter & IProviderEnvironmentVariablesAdapter = {
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
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return { success: true, message: 'bound' };
      },
      async deploy(service) {
        return {
          serviceId: service.id,
          externalId: `${service.name}-cloudrun`,
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars(environment, service, vars) {
        setEnvCalls.push({ environment, service, vars });
        varsByService.set(service.name, {
          ...(varsByService.get(service.name) ?? {}),
          ...vars,
        });
        return { success: true, message: 'vars synced' };
      },
      async deleteEnvVars(environment, service, keys) {
        deleteEnvCalls.push({ environment, service, keys });
        const current = { ...(varsByService.get(service.name) ?? {}) };
        for (const key of keys) delete current[key];
        varsByService.set(service.name, current);
        return {
          success: true,
          message: 'vars removed',
          data: { deletedKeys: keys, variableCount: keys.length },
        };
      },
      async getDeployStatus() {
        return { status: 'deployed' };
      },
      async readProviderEnvironmentVariables({ service }) {
        return { success: true, variables: varsByService.get(service.name) ?? {} };
      },
    };

    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: adapter as never,
    });

    return { adapter, setEnvCalls, deleteEnvCalls, varsByService };
  }

  function stubSendGridScopes(scopes: string[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.sendgrid.com/v3/scopes') {
        return new Response(JSON.stringify({ scopes }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected SendGrid request: ${url}`);
    }));
  }

  const sendGridSetupScopes = [
    'mail.send',
    'whitelabel.read',
    'whitelabel.create',
    'whitelabel.update',
    'user.email.read',
    'user.email.create',
    'user.email.update',
  ];

  it('SendGrid setup syncs the API key through the Cloud Run hosting adapter when setup-ready', async () => {
    const { project, environment, service } = await setupCloudRunProject();
    const { setEnvCalls } = stubCloudRunHostingAdapter();
    stubSendGridScopes(sendGridSetupScopes);

    const sg = getSendGridAdapter(getProjectScopeHints(project));
    if ('error' in sg) throw new Error(sg.error);
    const permissions = assessSendGridScopes(await sg.adapter.getScopes());
    expect(sendGridSetupReady(permissions)).toBe(true);

    const connection = new ConnectionRepository().findByProvider('sendgrid')!;
    const credentials = getSecretStore().decryptObject<{ apiKey: string }>(connection.credentialsEncrypted);

    const result = await syncHostingEnvVars({
      project,
      environment,
      service,
      vars: { SENDGRID_API_KEY: credentials.apiKey },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cloudrun');
    expect(setEnvCalls).toHaveLength(1);
    expect(setEnvCalls[0].vars).toEqual({ SENDGRID_API_KEY: 'SG.test-key' });
  });

  it('scrubs exact supplied values from every nested hosting receipt field', async () => {
    const { project, environment, service } = await setupCloudRunProject();
    const { adapter } = stubCloudRunHostingAdapter();
    const suppliedValue = 'generated-session-secret-regression-sentinel';
    adapter.setEnvVars = vi.fn().mockResolvedValue({
      success: false,
      message: `Provider rejected ${suppliedValue}`,
      error: `GraphQL request variables included ${suppliedValue}`,
      data: {
        request: {
          variables: [{ value: suppliedValue }],
        },
      },
    });

    const result = await syncHostingEnvVars({
      project,
      environment,
      service,
      vars: { SESSION_SECRET: suppliedValue },
    });

    expect(result).toMatchObject({
      success: false,
      message: 'Provider rejected [redacted]',
      error: 'GraphQL request variables included [redacted]',
      data: {
        request: {
          variables: [{ value: '[redacted]' }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(suppliedValue);
  });

  it('SendGrid setup resolves the Cloud Run provider from generic bindings', async () => {
    const { project, environment, service } = await setupCloudRunProject();
    new EnvironmentRepository().update(environment.id, {
      platformBindings: {
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    const { setEnvCalls } = stubCloudRunHostingAdapter();
    stubSendGridScopes(sendGridSetupScopes);

    const sg = getSendGridAdapter(getProjectScopeHints(project));
    if ('error' in sg) throw new Error(sg.error);
    const permissions = assessSendGridScopes(await sg.adapter.getScopes());
    expect(sendGridSetupReady(permissions)).toBe(true);

    const updatedEnvironment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    const result = await syncHostingEnvVars({
      project,
      environment: updatedEnvironment,
      service,
      vars: { SENDGRID_API_KEY: 'SG.test-key' },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cloudrun');
    expect(String(result.error ?? '')).not.toContain('Railway');
    expect(setEnvCalls).toHaveLength(1);
  });

  it('routes explicit removals through the bound hosting adapter without values', async () => {
    const { project, environment, service } = await setupCloudRunProject();
    const varsByService = new Map([
      ['web', { OLD_API_TOKEN: 'must-not-leak', KEEP_ME: 'preserved' }],
    ]);
    const { deleteEnvCalls } = stubCloudRunHostingAdapter(varsByService);

    const result = await removeHostingEnvVars({
      project,
      environment,
      service,
      keys: ['OLD_API_TOKEN'],
    });

    expect(result.success).toBe(true);
    expect(deleteEnvCalls).toEqual([{
      environment,
      service,
      keys: ['OLD_API_TOKEN'],
    }]);
    expect(varsByService.get('web')).toEqual({ KEEP_ME: 'preserved' });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('SendGrid setup rejects keys that cannot authorize a sender email', async () => {
    const { project } = await setupCloudRunProject();
    const { setEnvCalls } = stubCloudRunHostingAdapter();
    stubSendGridScopes(['mail.send']);

    const sg = getSendGridAdapter(getProjectScopeHints(project));
    if ('error' in sg) throw new Error(sg.error);
    const permissions = assessSendGridScopes(await sg.adapter.getScopes());
    const payload = sendGridPermissionPayload(permissions);

    expect(sendGridSetupReady(permissions)).toBe(false);
    expect(payload.setupReady).toBe(false);
    expect(payload.canAuthorizeSenderEmail).toBe(false);
    expect(payload.missingScopes).toEqual({
      domainAuthentication: ['whitelabel.read', 'whitelabel.create', 'whitelabel.update'],
      senderVerification: ['user.email.read', 'user.email.create', 'user.email.update'],
    });
    // Setup is gated on sendGridSetupReady, so no hosting env sync happens.
    expect(setEnvCalls).toHaveLength(0);
  });

  it('SendGrid permission assessment reports setup-ready scoped keys', async () => {
    const { project } = await setupCloudRunProject();
    stubCloudRunHostingAdapter();
    stubSendGridScopes(['mail.send', 'user.email.read', 'user.email.create', 'user.email.update']);

    const sg = getSendGridAdapter(getProjectScopeHints(project));
    if ('error' in sg) throw new Error(sg.error);
    const permissions = assessSendGridScopes(await sg.adapter.getScopes());
    const payload = sendGridPermissionPayload(permissions);

    expect(sendGridSetupReady(permissions)).toBe(true);
    expect(payload.setupReady).toBe(true);
    expect(payload.canAuthorizeSenderEmail).toBe(true);
    expect(payload.canManageSenderVerification).toBe(true);
    expect(payload.canManageDomainAuthentication).toBe(false);
  });

  it('syncHostingEnvVars writes vars through the Cloud Run hosting adapter', async () => {
    await setupCloudRunProject();
    const { setEnvCalls } = stubCloudRunHostingAdapter();

    const project = new ProjectRepository().findByName('cloudrun-integrations')!;
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    const service = new ServiceRepository().findByProjectAndName(project.id, 'web')!;

    const result = await syncHostingEnvVars({
      project,
      environment,
      service,
      vars: {
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
      },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cloudrun');
    expect(setEnvCalls).toHaveLength(1);
    expect(setEnvCalls[0].vars).toEqual({
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
    });
  });

  it('readHostingEnvVars reads Cloud Run service variables through the hosting adapter', async () => {
    await setupCloudRunProject();
    stubCloudRunHostingAdapter(new Map([
      ['web', {
        STRIPE_SECRET_KEY: 'sk_test_secret',
        PUBLIC_VALUE: 'visible',
      }],
    ]));

    const project = new ProjectRepository().findByName('cloudrun-integrations')!;
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    const service = new ServiceRepository().findByProjectAndName(project.id, 'web')!;

    const result = await readHostingEnvVars({ project, environment, service });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cloudrun');
    if (result.success) {
      expect(result.variables).toEqual({
        STRIPE_SECRET_KEY: 'sk_test_secret',
        PUBLIC_VALUE: 'visible',
      });
    }
  });

  it('preserves a provider-owned binding failure as a value-free read result', async () => {
    const { project, environment, service } = await setupCloudRunProject();
    const { adapter } = stubCloudRunHostingAdapter();
    vi.spyOn(adapter, 'readProviderEnvironmentVariables').mockResolvedValue({
      success: false,
      error: 'The exact service binding is incomplete',
    });

    const result = await readHostingEnvVars({ project, environment, service });

    expect(result).toEqual({
      success: false,
      provider: 'cloudrun',
      error: 'The exact service binding is incomplete',
    });
  });
});
