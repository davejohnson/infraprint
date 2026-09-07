import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
// Importing adapters registers providers in the registry.
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { S3StorageAdapter } from '../../adapters/providers/aws/s3.adapter.js';
import '../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../adapters/providers/secretmanagers/onepassword.adapter.js';
import { StripeProjectsAdapter } from '../../adapters/providers/secretmanagers/stripe-projects.adapter.js';
import { registerConnectionsTools } from '../connections.tools.js';
import { createToolContext } from '../../application/context.js';

let tempDir: string;
const githubTokenEnvironmentNames = [
  'NODE_AUTH_TOKEN',
  'HYPERVIBE_GITHUB_TOKEN',
  'HYPERVIBE_GITHUB_PACKAGES_TOKEN',
] as const;
const originalGitHubTokenEnvironment = Object.fromEntries(
  githubTokenEnvironmentNames.map((name) => [name, process.env[name]])
);

beforeEach(() => {
  for (const name of githubTokenEnvironmentNames) {
    delete process.env[name];
  }
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-connections-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HV_TEST_RAILWAY_TOKEN;
  for (const name of githubTokenEnvironmentNames) {
    const original = originalGitHubTokenEnvironment[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'connections-tools-test', version: '0.0.0' });
  registerConnectionsTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'connections-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
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

describe('hv_connections', () => {
  it('adds a Stripe Projects credential source without storing a credential value', async () => {
    vi.spyOn(StripeProjectsAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      identity: 'Stripe Projects environment production',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', { provider: 'stripe-projects' });

    expect(result.ok).toBe(true);
    expect(result.data.credentialsSource).toBe('native-cli');
    expect(result.data.identity).toBe('Stripe Projects environment production');
    const connection = new ConnectionRepository().findByProvider('stripe-projects')!;
    expect(getSecretStore().decryptObject(connection.credentialsEncrypted)).toEqual({
      authMode: 'default',
    });
    await t.close();
  });

  it('maps a Stripe Projects service into provider credentials without a saved source connection', async () => {
    const stripeSecret = 'cfat_from_stripe_projects';
    vi.spyOn(StripeProjectsAdapter.prototype, 'getSecret').mockResolvedValue({
      value: JSON.stringify({
        CLOUDFLARE_API_TOKEN: stripeSecret,
        CLOUDFLARE_WORKERS_ACCOUNT_ID: 'account_from_stripe_projects',
      }),
    });
    vi.spyOn(CloudflareAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      tokenKind: 'account',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'cloudflare',
      credentialsRef: 'stripe-projects://production/cloudflare/workers',
      credentialsMap: {
        apiToken: 'CLOUDFLARE_API_TOKEN',
        accountId: 'CLOUDFLARE_WORKERS_ACCOUNT_ID',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data.credentialsSource).toBe('stripe-projects');
    expect(new ConnectionRepository().findByProvider('stripe-projects')).toBeNull();
    expect(JSON.stringify(result)).not.toContain(stripeSecret);
    const connection = new ConnectionRepository().findByProvider('cloudflare')!;
    expect(getSecretStore().decryptObject(connection.credentialsEncrypted)).toMatchObject({
      apiToken: stripeSecret,
      accountId: 'account_from_stripe_projects',
      apiTokenKind: 'account',
    });
    await t.close();
  });

  it('rejects fields for a different connection action before any mutation', async () => {
    const t = await makeClient();
    const cases = [
      { provider: 'railway', action: 'verify', credentials: { apiToken: 'do-not-save' } },
      { provider: 'railway', action: 'remove', adminAccessTokenRef: 'env:ADMIN_TOKEN' },
      { provider: 'railway', action: 'add', gcpProjectId: 'wrong-mode' },
      { provider: 'railway', action: 'add', gcsAccess: 'inspect' },
      { provider: 'railway', action: 'add', memorystoreAccess: 'inspect' },
      { provider: 'railway', action: 'add', queueAccess: 'lifecycle' },
      { provider: 'railway', action: 'add', adminAuth: 'default' },
      { provider: 'railway', action: 'prepare', credentialsRef: 'env:RAILWAY_TOKEN' },
    ];

    for (const input of cases) {
      const result = await t.call('hv_connections', input);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.message).toContain('options for another connection action');
    }
    expect(new ConnectionRepository().findAll()).toEqual([]);
    await t.close();
  });

  it('allows staged GCP capabilities only through Cloud Run preparation', async () => {
    const t = await makeClient();
    for (const capability of [
      { gcsAccess: 'inspect' },
      { memorystoreAccess: 'inspect' },
      { queueAccess: 'lifecycle' },
    ]) {
      const result = await t.call('hv_connections', {
        provider: 'railway',
        action: 'prepare',
        ...capability,
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.message).toContain('only when preparing the shared cloudrun connection');
    }
    const mixedRemoval = await t.call('hv_connections', {
      provider: 'cloudrun',
      action: 'prepare',
      queueAccess: 'remove',
      memorystoreAccess: 'inspect',
    });
    expect(mixedRemoval.ok).toBe(false);
    expect(mixedRemoval.error.code).toBe('VALIDATION');
    expect(mixedRemoval.error.message).toContain('exact removal-only operation');
    await t.close();
  });

  it('rejects ambiguous or unused credential inputs before resolving secrets', async () => {
    const t = await makeClient();
    const cases = [
      {
        provider: 'railway',
        action: 'add',
        credentialsRef: 'env:HV_TEST_RAILWAY_TOKEN',
        credentialsKey: 'apiToken',
        credentialsMap: { apiToken: 'HV_TEST_RAILWAY_TOKEN' },
      },
      {
        provider: 'railway',
        action: 'prepare',
        confirm: true,
        adminCredentialsJsonRef: 'env:ADMIN_JSON',
        adminAccessTokenRef: 'env:ADMIN_TOKEN',
      },
      {
        provider: 'railway',
        action: 'prepare',
        confirm: true,
        adminAuth: 'default',
        adminAccessTokenRef: 'env:ADMIN_TOKEN',
      },
      {
        provider: 'railway',
        action: 'prepare',
        adminAccessTokenRef: 'env:ADMIN_TOKEN',
      },
      {
        provider: 'railway',
        action: 'prepare',
        adminAuth: 'default',
      },
      {
        provider: 'railway',
        action: 'prepare',
        confirm: true,
      },
    ];

    for (const input of cases) {
      const result = await t.call('hv_connections', input);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(new ConnectionRepository().findAll()).toEqual([]);
    await t.close();
  });

  it('adds a native-CLI storage connection without asking for a credential value', async () => {
    vi.spyOn(S3StorageAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      email: 'AWS account 123456789012',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', { provider: 's3' });

    expect(result.ok).toBe(true);
    expect(result.data.credentialsSource).toBe('native-cli');
    const connection = new ConnectionRepository().findByProvider('s3')!;
    expect(getSecretStore().decryptObject(connection.credentialsEncrypted)).toEqual({
      authMode: 'default',
    });
    await t.close();
  });

  it('still requires credentials for providers without a native CLI credential chain', async () => {
    const t = await makeClient();
    const result = await t.call('hv_connections', { provider: 'railway' });

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('credentials are required');
    await t.close();
  });

  it('accepts explicit project context for add and returns it without changing provider scope', async () => {
    const project = new ProjectRepository().create({ name: 'connection-app', defaultPlatform: 'railway' });
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      project: project.name,
      provider: 'railway',
      credentials: { apiToken: 'token-123' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.project).toEqual({ id: project.id, name: project.name });
    expect(result.data.scope).toBe('global');
    await t.close();
  });

  it('add stores credentials and auto-verifies in one call', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      email: 'dev@example.com',
      workspaceId: 'ws-1',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'railway',
      credentials: { apiToken: 'token-123' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.email).toBe('dev@example.com');

    const connection = new ConnectionRepository().findByProvider('railway');
    expect(connection?.status).toBe('verified');
    await t.close();
  });

  it('add can resolve a token from a local env ref without echoing it', async () => {
    process.env.HV_TEST_RAILWAY_TOKEN = 'token-from-env-ref';
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'railway',
      credentialsRef: 'env:HV_TEST_RAILWAY_TOKEN',
      credentialsKey: 'apiToken',
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.credentialsSource).toBe('env');
    expect(JSON.stringify(result)).not.toContain('token-from-env-ref');

    const connection = new ConnectionRepository().findByProvider('railway')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('token-from-env-ref');
    expect(new AuditRepository().findByAction('connection.created')[0]?.details).toEqual({
      provider: 'railway',
      scope: null,
      credentialsSource: 'env',
    });
    await t.close();
  });

  it('add can resolve a token directly from an existing .env file', async () => {
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, [
      '# local provider tokens',
      'export HYPERVIBE_RAILWAY_TOKEN=token-from-dotenv-ref',
      '',
    ].join('\n'));
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'railway',
      credentialsRef: `dotenv:${envPath}#HYPERVIBE_RAILWAY_TOKEN`,
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.credentialsSource).toBe('dotenv');
    expect(JSON.stringify(result)).not.toContain('token-from-dotenv-ref');

    const connection = new ConnectionRepository().findByProvider('railway')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('token-from-dotenv-ref');
    await t.close();
  });

  it('add can map multiple provider credential fields from an existing .env file', async () => {
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, [
      'HYPERVIBE_GITHUB_TOKEN=gh-api-token',
      'HYPERVIBE_GITHUB_PACKAGES_TOKEN=gh-package-token',
    ].join('\n'));
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      credentialsRef: `dotenv:${envPath}`,
      credentialsMap: {
        apiToken: 'HYPERVIBE_GITHUB_TOKEN',
        packageReadToken: 'HYPERVIBE_GITHUB_PACKAGES_TOKEN',
      },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('gh-api-token');
    expect(JSON.stringify(result)).not.toContain('gh-package-token');

    const connection = new ConnectionRepository().findByProvider('github')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string; packageReadToken?: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('gh-api-token');
    expect(decrypted.packageReadToken).toBe('gh-package-token');
    await t.close();
  });

  it('accepts NODE_AUTH_TOKEN when a GitHub credentials ref names another supported alias', async () => {
    process.env.NODE_AUTH_TOKEN = 'gh-combined-token';
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      credentialsRef: 'env:HYPERVIBE_GITHUB_TOKEN',
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('gh-combined-token');
    const connection = new ConnectionRepository().findByProvider('github')!;
    const decrypted = getSecretStore().decryptObject<{
      apiToken: string;
      packageReadToken?: string;
    }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('gh-combined-token');
    expect(decrypted.packageReadToken).toBe('gh-combined-token');
    await t.close();
  });

  it('maps both GitHub credential roles from one supported dotenv alias', async () => {
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, 'NODE_AUTH_TOKEN=gh-combined-dotenv-token\n');
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      credentialsRef: `dotenv:${envPath}`,
      credentialsMap: {
        apiToken: 'HYPERVIBE_GITHUB_TOKEN',
        packageReadToken: 'HYPERVIBE_GITHUB_PACKAGES_TOKEN',
      },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('gh-combined-dotenv-token');
    const connection = new ConnectionRepository().findByProvider('github')!;
    const decrypted = getSecretStore().decryptObject<{
      apiToken: string;
      packageReadToken?: string;
    }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('gh-combined-dotenv-token');
    expect(decrypted.packageReadToken).toBe('gh-combined-dotenv-token');
    await t.close();
  });

  it('blocks ambiguous GitHub alias fallback without exposing either token', async () => {
    process.env.HYPERVIBE_GITHUB_TOKEN = 'gh-api-token';
    process.env.HYPERVIBE_GITHUB_PACKAGES_TOKEN = 'gh-package-token';

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      credentialsRef: 'env:NODE_AUTH_TOKEN',
    });

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('accepted aliases');
    expect(result.error.message).toContain('Set NODE_AUTH_TOKEN explicitly');
    expect(JSON.stringify(result)).not.toContain('gh-api-token');
    expect(JSON.stringify(result)).not.toContain('gh-package-token');
    expect(new ConnectionRepository().findByProvider('github')).toBeNull();
    await t.close();
  });

  it('stores the verified GitHub login for package pull credential sync', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      credentials: { apiToken: 'gh-token' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.data.login).toBe('davejohnson');

    const connection = new ConnectionRepository().findByProvider('github')!;
    const decrypted = getSecretStore().decryptObject<{ apiToken: string; login?: string; packageReadToken?: string }>(connection.credentialsEncrypted);
    expect(decrypted.apiToken).toBe('gh-token');
    expect(decrypted.login).toBe('davejohnson');
    expect(decrypted.packageReadToken).toBe('gh-token');
    await t.close();
  });

  it('warns when a verified GitHub token only has package-read scope', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['read:packages'],
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      scope: 'davejohnson/apreskeys.com',
      credentials: { apiToken: 'gh-package-only-token' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.warnings).toContainEqual(expect.stringContaining('missing classic PAT scope(s): repo, workflow'));
    expect(result.warnings).toContainEqual(expect.stringContaining('read:packages-only token is only enough for GHCR image pulls'));
    await t.close();
  });

  it('rejects the non-canonical GitHub packagesToken credential key', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      login: 'davejohnson',
      scopes: ['repo', 'workflow', 'read:packages'],
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'github',
      scope: 'davejohnson/apreskeys.com',
      credentials: {
        apiToken: 'gh-api-token',
        packagesToken: 'package-token',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('packagesToken');
    expect(new ConnectionRepository().findByProviderAndScope('github', 'davejohnson/apreskeys.com')).toBeNull();
    await t.close();
  });

  it('surfaces provider verification warnings without failing the connection', async () => {
    vi.spyOn(CloudflareAdapter.prototype, 'verify').mockResolvedValue({
      success: true,
      tokenKind: 'account',
      warning: 'Token is valid, but zone access was not confirmed.',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'cloudflare',
      scope: 'apreskeys.com',
      credentials: { apiToken: 'cf-token' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('verified');
    expect(result.warnings).toEqual(['Token is valid, but zone access was not confirmed.']);

    const connection = new ConnectionRepository().findByProviderAndScope('cloudflare', 'apreskeys.com');
    expect(connection?.status).toBe('verified');
    const decrypted = getSecretStore().decryptObject<{ apiTokenKind?: string }>(connection!.credentialsEncrypted);
    expect(decrypted.apiTokenKind).toBe('account');
    await t.close();
  });

  it('add keeps the connection but returns PROVIDER_ERROR when verification fails', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({
      success: false,
      error: 'invalid token',
    });

    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'railway',
      credentials: { apiToken: 'bad-token' },
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.message).toContain('invalid token');
    expect(result.hint).toContain('saved');
    expect(result.hint).toContain('Railway Account API token');
    expect(result.hint).toContain('https://railway.com/account/tokens');

    const connection = new ConnectionRepository().findByProvider('railway');
    expect(connection).not.toBeNull();
    expect(connection?.status).toBe('failed');
    await t.close();
  });

  it('rejects add without credentials and rejects invalid credential shapes', async () => {
    const t = await makeClient();

    const missing = await t.call('hv_connections', { provider: 'railway' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('VALIDATION');
    expect(missing.hint).toContain('Railway Account API token');
    expect(missing.hint).toContain('https://railway.com/account/tokens');

    const invalid = await t.call('hv_connections', { provider: 'railway', credentials: { nope: true } });
    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe('VALIDATION');
    expect(invalid.hint).toContain('Railway Account API token');
    await t.close();
  });

  it('verify returns NOT_FOUND when no connection exists', async () => {
    const t = await makeClient();
    const result = await t.call('hv_connections', { provider: 'railway', action: 'verify' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.hint).toContain('Railway Account API token');
    expect(result.hint).toContain('https://railway.com/account/tokens');
    await t.close();
  });

  it('verify returns structured Cloudflare setup details when the scoped connection is missing', async () => {
    const t = await makeClient();
    const result = await t.call('hv_connections', {
      provider: 'cloudflare',
      scope: 'hlspropertycare.com',
      action: 'verify',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toBe('No connection found for provider: cloudflare (hlspropertycare.com).');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'cloudflare',
      scope: 'hlspropertycare.com',
    });
    expect(result.agentInstruction.message).toContain('exact clickable setup link');
    expect(result.agentInstruction.message).toContain('offer to open');
    expect(result.agentInstruction.message).toContain('complete credentialExample');
    await t.close();
  });

  it('remove deletes the connection', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const t = await makeClient();
    await t.call('hv_connections', { provider: 'railway', credentials: { apiToken: 'token-123' } });

    const removed = await t.call('hv_connections', { provider: 'railway', action: 'remove' });
    expect(removed.ok).toBe(true);
    expect(removed.data.removed).toBe(true);
    expect(new ConnectionRepository().findByProvider('railway')).toBeNull();

    const again = await t.call('hv_connections', { provider: 'railway', action: 'remove' });
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('NOT_FOUND');
    await t.close();
  });
});

describe('hv_connections', () => {
  it('lists in explicit project context and rejects an unknown project', async () => {
    const project = new ProjectRepository().create({ name: 'connection-list-app', defaultPlatform: 'railway' });
    const t = await makeClient();

    const listed = await t.call('hv_connections', { project: project.name });
    expect(listed.ok).toBe(true);
    expect(listed.data.project).toEqual({ id: project.id, name: project.name });

    const unknown = await t.call('hv_connections', { project: 'does-not-exist' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe('NOT_FOUND');
    expect(unknown.error.message).toContain('does-not-exist');
    expect(unknown.hint).toContain('hv_spec');
    expect(unknown.error.details).toMatchObject({
      requestedProject: 'does-not-exist',
      registeredProjectCount: 1,
    });
    expect(unknown.agentInstruction.action).toBe('continue');
    await t.close();
  });

  it('lists only when no operation parameters are supplied', async () => {
    const t = await makeClient();
    const result = await t.call('hv_connections', { action: 'verify' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('provider is required');
    expect(result.hint).toContain('hv_connections({project})');
    await t.close();
  });

  it('returns connections without credentials plus providers grouped by category', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'verify').mockResolvedValue({ success: true, email: 'dev@example.com' });

    const t = await makeClient();
    await t.call('hv_connections', { provider: 'railway', credentials: { apiToken: 'token-123' } });

    const result = await t.call('hv_connections', {});
    expect(result.ok).toBe(true);
    expect(result.hint).toContain('credential discovery only');
    expect(result.hint).toContain('credentials the user already controls');
    expect(result.hint).toContain('value-free handoff');
    expect(result.hint).toContain('Do not assume provider membership');
    expect(result.hint).toContain('run hv_plan');
    expect(result.data.connections).toHaveLength(1);
    expect(result.data.connections[0]).toMatchObject({
      provider: 'railway',
      scope: 'global',
      status: 'verified',
    });
    expect(result.data.connections[0].lastVerifiedAt).toBeTruthy();
    // Never leak credentials
    expect(JSON.stringify(result.data)).not.toContain('token-123');
    expect(result.data.connections[0].credentialsEncrypted).toBeUndefined();

    expect(result.data.availableProviders.deployment).toContainEqual(
      expect.objectContaining({
        name: 'railway',
        displayName: 'Railway',
        tokenType: expect.stringContaining('Railway Account API token'),
        setupHelpUrl: 'https://railway.com/account/tokens',
        defaultScalarKey: 'apiToken',
        maturity: {
          lifecycle: {
            hosting: { status: 'ready-for-live' },
            database: { status: 'ready-for-live' },
            cache: { status: 'ready-for-live' },
            storage: { status: 'ready-for-live' },
            queue: {
              status: 'ready-for-live',
              reason: expect.any(String),
            },
          },
        },
        lifecycle: expect.objectContaining({
          queue: { backend: 'postgres', resources: 'application-managed' },
        }),
        credentialFields: [
          {
            name: 'apiToken',
            label: 'API Token',
            required: true,
            sensitive: true,
            inputKind: 'secret',
          },
          {
            name: 'workspaceId',
            label: 'Workspace ID',
            required: false,
            sensitive: false,
            inputKind: 'text',
          },
          {
            name: 'teamId',
            label: 'Team ID',
            required: false,
            sensitive: false,
            inputKind: 'text',
          },
        ],
        requiredPermissions: expect.arrayContaining([
          expect.stringContaining('create projects, services, environments, variables, databases, domains, and deployments'),
        ]),
      })
    );
    expect(result.data.availableProviders.secrets).toContainEqual(
      expect.objectContaining({
        name: '1password',
        defaultScalarKey: 'serviceAccountToken',
        credentialFields: [
          {
            name: 'serviceAccountToken',
            label: 'Service Account Token',
            required: true,
            sensitive: true,
            inputKind: 'secret',
          },
        ],
      })
    );
    expect(result.data.availableProviders.dns).toContainEqual(
      expect.objectContaining({
        name: 'cloudflare',
        displayName: 'Cloudflare',
        setupHelpUrl: expect.stringContaining(
          'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys='
        ),
        setupHelpUrls: expect.arrayContaining([
          expect.objectContaining({
            label: expect.stringContaining('Account API Token'),
            url: expect.stringContaining(
              'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys='
            ),
          }),
          expect.objectContaining({
            label: expect.stringContaining('User API Token'),
            url: expect.stringContaining(
              'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys='
            ),
          }),
        ]),
        tokenType: expect.stringContaining('Cloudflare Account API Token'),
        requiredPermissions: expect.arrayContaining([
          expect.stringContaining('Zone -> Zone -> Read'),
          expect.stringContaining('Zone -> DNS -> Edit.'),
          expect.stringContaining('Zone Resources must be Include -> Specific zone'),
          expect.stringContaining('Registrar write permissions'),
        ]),
        notes: expect.arrayContaining([
          expect.stringContaining('Both links pre-fill the token name'),
          expect.stringContaining('narrow resources to the intended account and zone'),
          expect.stringContaining('cfut_'),
        ]),
      })
    );
    await t.close();
  });
});
