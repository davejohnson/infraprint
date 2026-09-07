import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { ISecretManagerAdapter } from '../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../domain/registry/secretmanager.registry.js';
import * as hostingEnv from '../../domain/services/hosting-env.service.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { createToolContext } from '../../application/context.js';
import { registerHvSecretsTools } from '../hv-secrets.tools.js';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-secrets-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-secrets-test', version: '1.0.0' });
  registerHvSecretsTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-secrets-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      return parseToolEnvelope(await client.callTool({ name, arguments: args })) as Record<string, any>;
    },
    async rawCall(name: string, args: Record<string, unknown> = {}) {
      return client.callTool({ name, arguments: args });
    },
    async names() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('reduced secret command surface', () => {
  it('lists sources by default and keeps secret managers read-only', async () => {
    const client = await makeClient();
    expect(await client.names()).toEqual(['hv_secrets']);
    const result = await client.call('hv_secrets');
    expect(result.ok).toBe(true);
    expect(result.data.sources).toContainEqual({ source: 'vault', status: 'missing' });
    expect(result.data.sources).toContainEqual({ source: 'github', status: 'missing' });
    expect(await client.names()).not.toContain('hv_secrets_sync');
    expect(await client.names()).not.toContain('hv_secrets_set');
    await client.close();
  });

  it('keeps project-only calls in source-list mode', async () => {
    const project = new ProjectRepository().create({ name: 'secret-list-app', defaultPlatform: 'railway' });
    const hostingRead = vi.spyOn(hostingEnv, 'readHostingEnvVars');
    const client = await makeClient();

    const result = await client.call('hv_secrets', { project: project.name });

    expect(result.ok).toBe(true);
    expect(result.data.project).toEqual({ id: project.id, name: project.name });
    expect(result.data.sources).toEqual(expect.any(Array));
    expect(hostingRead).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('secret reads', () => {
  it('rejects cross-mode selectors instead of silently broadening a secret read', async () => {
    const t = await makeClient();

    const managerLookup = await t.call('hv_secrets', {
      provider: '1password',
      path: 'vault/item',
      env: 'production',
    });
    expect(managerLookup.ok).toBe(false);
    expect(managerLookup.error.code).toBe('VALIDATION');
    expect(managerLookup.error.message).toContain('another secret mode');

    const list = await t.call('hv_secrets', {
      include: ['github'],
      env: 'production',
      service: 'web',
    });
    expect(list.ok).toBe(false);
    expect(list.error.code).toBe('VALIDATION');
    expect(list.error.message).toContain('hosting lookup options');
    await t.close();
  });

  it('returns project-scoped setup for missing manager and GitHub connections', async () => {
    const project = new ProjectRepository().create({
      name: 'secret-setup-app',
      gitRemoteUrl: 'https://github.com/davejohnson/secret-setup-app',
    });
    const client = await makeClient();

    const manager = await client.call('hv_secrets', {
      project: project.name,
      provider: 'vault',
      path: 'apps/production',
    });
    expect(manager.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(manager.error.details.connectionSetup, {
      provider: 'vault',
      project: project.name,
    });

    const github = await client.call('hv_secrets', { project: project.name, include: ['github'] });
    expect(github.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(github.error.details.connectionSetup, {
      provider: 'github',
      project: project.name,
      scope: 'davejohnson/secret-setup-app',
    });
    await client.close();
  });

  it('validates explicit project context for manager reads', async () => {
    new ProjectRepository().create({ name: 'known-project', defaultPlatform: 'railway' });
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      project: 'does-not-exist',
      provider: 'vault',
      path: 'apps/prod',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('does-not-exist');
    expect(result.error.details.requestedProject).toBe('does-not-exist');
    expect(result.agentInstruction.action).toBe('continue');
    await client.close();
  });

  it('returns project-scoped hosting setup when its provider connection is unavailable', async () => {
    const project = new ProjectRepository().create({
      name: 'hosting-setup-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/hosting-setup-app',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { web: { serviceId: 'railway-service' } },
      },
    });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: {},
      envVarSpec: {},
    });
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'railway',
      project: project.name,
      scope: 'davejohnson/hosting-setup-app',
    });
    await client.close();
  });

  it('fully redacts hosting values', async () => {
    const project = new ProjectRepository().create({ name: 'hosting-read-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    vi.spyOn(hostingEnv, 'readHostingEnvVars').mockResolvedValue({
      success: true,
      provider: 'railway',
      variables: { API_KEY: 'provider-secret-value' },
    });
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.data.vars).toEqual({ API_KEY: '[redacted]' });
    expect(JSON.stringify(result)).not.toContain('provider-secret-value');
    await client.close();
  });

  it('requires explicit env before hosting-variable selectors', async () => {
    const project = new ProjectRepository().create({ name: 'hosting-selector-app', defaultPlatform: 'railway' });
    const hostingRead = vi.spyOn(hostingEnv, 'readHostingEnvVars');
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      project: project.name,
      service: 'web',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'VALIDATION',
      message: 'env is required for hosting-variable inspection.',
    });
    expect(result.hint).toContain('Use project alone to list secret sources');
    expect(hostingRead).not.toHaveBeenCalled();
    await client.close();
  });

  it('fully redacts manager values and never exposes mutation methods', async () => {
    const repo = new ConnectionRepository();
    const connection = repo.create({
      provider: 'vault',
      credentialsEncrypted: getSecretStore().encryptObject({ address: 'https://vault.example', token: 'token' }),
    });
    repo.updateStatus(connection.id, 'verified');
    const getSecret = vi.fn(async () => ({ value: 'manager-secret-value', version: '3' }));
    const adapter: ISecretManagerAdapter = {
      name: 'vault',
      async connect() {},
      async verify() { return { success: true }; },
      getSecret,
      async listSecrets() { return []; },
    };
    vi.spyOn(secretManagerRegistry, 'createAdapter').mockReturnValue(adapter);
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      provider: 'vault',
      path: 'apps/prod',
      key: 'API_KEY',
      version: '3',
    });

    expect(result.data).toEqual({
      secretRef: 'vault://apps/prod#API_KEY@3',
      value: '[redacted]',
      present: true,
      version: '3',
    });
    expect(getSecret).toHaveBeenCalledWith('apps/prod', 'API_KEY', '3');
    expect(JSON.stringify(result)).not.toContain('manager-secret-value');
    expect('setSecret' in adapter).toBe(false);
    await client.close();
  });

  it('rejects empty manager selectors instead of treating them as omitted', async () => {
    const client = await makeClient();

    const result = await client.rawCall('hv_secrets', {
      provider: 'vault',
      path: '',
    });

    expect(result.isError).toBe(true);
    await client.close();
  });
});
