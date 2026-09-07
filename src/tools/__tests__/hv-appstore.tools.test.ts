import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { createToolContext } from '../../application/context.js';
import { registerHvAppstoreTools } from '../hv-appstore.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-appstore-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedConnection() {
  const appStore = new ConnectionRepository().create({
    provider: 'appstoreconnect',
    credentialsEncrypted: getSecretStore().encryptObject({
      keyId: 'KEY1',
      issuerId: 'ISSUER1',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    }),
  });
  new ConnectionRepository().updateStatus(appStore.id, 'verified');
  const github = new ConnectionRepository().create({
    provider: 'github',
    scope: 'davejohnson/example',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'github-token' }),
  });
  new ConnectionRepository().updateStatus(github.id, 'verified');
  const project = new ProjectRepository().create({
    name: 'example',
    defaultPlatform: 'railway',
    gitRemoteUrl: 'https://github.com/davejohnson/example',
  });
  new SpecStore().replace(project, {
    version: 1,
    project: 'example',
    gitRemoteUrl: 'https://github.com/davejohnson/example',
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        deploy: { strategy: 'branch', trigger: 'ci' },
        ios: {
          bundleId: 'com.example.app',
          testflight: { groups: { beta: {} } },
          release: {
            services: ['web'],
            build: { command: 'make ipa', ipaPath: 'Example.ipa' },
            testflight: { groups: ['beta'] },
          },
        },
      },
    },
  } as never);
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
    total_count: 1,
    workflow_runs: [{
      id: 101,
      name: 'release',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:10:00Z',
      head_sha: 'a'.repeat(40),
      head_branch: 'main',
      event: 'workflow_run',
      html_url: 'https://github.com/davejohnson/example/actions/runs/101',
    }],
  });
  vi.spyOn(GitHubAdapter.prototype, 'listArtifacts').mockResolvedValue({
    total_count: 2,
    artifacts: [
      {
        id: 201,
        name: `hypervibe-server-release-production-${'a'.repeat(40)}`,
        expired: false,
        created_at: '2026-07-01T00:05:00Z',
        updated_at: '2026-07-01T00:05:00Z',
        workflow_run: {
          id: 101,
          repository_id: 1,
          head_repository_id: 1,
          head_branch: 'main',
          head_sha: 'b'.repeat(40),
        },
      },
      {
        id: 202,
        name: `hypervibe-ios-release-production-${'a'.repeat(40)}`,
        expired: false,
        created_at: '2026-07-01T00:10:00Z',
        updated_at: '2026-07-01T00:10:00Z',
        workflow_run: {
          id: 101,
          repository_id: 1,
          head_repository_id: 1,
          head_branch: 'main',
          head_sha: 'c'.repeat(40),
        },
      },
    ],
  });
}

async function makeClient() {
  const server = new McpServer({ name: 'hv-appstore-test', version: '1.0.0' });
  registerHvAppstoreTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-appstore-test-client', version: '1.0.0' });
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

const APP = { id: 'app-1', bundleId: 'com.example.app', name: 'Example App' };
const BUILD = {
  id: 'build-1',
  version: '1.2.0',
  buildNumber: '42',
  processingState: 'VALID',
  usesNonExemptEncryption: false,
  uploadedDate: '2026-06-01T00:00:00Z',
  appId: 'app-1',
};
const GROUP = { id: 'group-1', name: 'External Testers', isInternal: false };

describe('hv_appstore_status', () => {
  it('aggregates builds and groups for an app (happy path)', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBuilds').mockResolvedValue([BUILD]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([GROUP]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['builds', 'groups'],
    });
    expect(status.ok).toBe(true);
    expect(status.data.app).toEqual(APP);
    expect(status.data.builds).toHaveLength(1);
    expect(status.data.builds[0]).toMatchObject({ id: 'build-1', buildNumber: '42', processingState: 'VALID' });
    expect(status.data.groups).toEqual([GROUP]);
    expect(status.data.testers).toBeUndefined();
    expect(status.data.readiness).toBeUndefined();
    await t.close();
  });

  it('hard-bounds build and tester sections when the adapter over-returns', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    const listBuilds = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBuilds')
      .mockResolvedValue([
        BUILD,
        { ...BUILD, id: 'build-2', buildNumber: '43' },
      ]);
    const listBetaTesters = vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters')
      .mockResolvedValue([
        { id: 'tester-1', email: 'one@example.com' },
        { id: 'tester-2', email: 'two@example.com' },
      ]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['builds', 'testers'],
      limit: 1,
    });

    expect(status.ok).toBe(true);
    expect(status.data.builds).toHaveLength(1);
    expect(status.data.testers).toHaveLength(1);
    expect(listBuilds).toHaveBeenCalledWith({ appId: APP.id, limit: 1 });
    expect(listBetaTesters).toHaveBeenCalledWith({ appId: APP.id, limit: 1 });
    await t.close();
  });

  it('warns when readiness and pagination options do not apply to selected sections', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([GROUP]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['groups'],
      locale: 'fr-CA',
      screenshotDisplayType: 'APP_IPHONE_67',
      limit: 5,
    });

    expect(status.ok).toBe(true);
    expect(status.warnings).toEqual([
      'Ignored options for hv_appstore_status include=["groups"]: locale, screenshotDisplayType, limit. The requested read still completed.',
    ]);
    await t.close();
  });

  it('uses iOS as the default readiness platform', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    const getEditableVersion = vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion')
      .mockResolvedValue(null);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['readiness'],
    });

    expect(status.ok).toBe(true);
    expect(getEditableVersion).toHaveBeenCalledWith('app-1', 'IOS');
    await t.close();
  });

  it('returns MISSING_CONNECTION with setup guidance when no connection exists', async () => {
    const t = await makeClient();
    const status = await t.call('hv_appstore_status', { appIdentifier: 'com.example.app' });
    expect(status.ok).toBe(false);
    expect(status.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(status.error.details.connectionSetup, {
      provider: 'appstoreconnect',
      scope: 'com.example.app',
    });
    expect(status.hint).toContain('appstoreconnect.apple.com/access/integrations/api');
    await t.close();
  });
});

const VERSION = { id: 'ver-1', versionString: '1.2.0', appStoreState: 'PREPARE_FOR_SUBMISSION', platform: 'IOS' };
const SUBMIT_INPUT = {
  project: 'example',
  environment: 'production',
  appIdentifier: 'com.example.app',
};

describe('hv_appstore_submit', () => {
  function stubSubmittableVersion() {
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    const getEditableVersion = vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion').mockResolvedValue(VERSION);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getAppStoreVersionBuild').mockResolvedValue({ id: 'build-1', version: '42' });
    return getEditableVersion;
  }

  it('returns project-scoped GitHub setup when release evidence cannot be read', async () => {
    seedConnection();
    const connections = new ConnectionRepository();
    connections.delete(connections.findByProviderAndScope('github', 'davejohnson/example')!.id);
    const t = await makeClient();

    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'github',
      project: 'example',
      scope: 'davejohnson/example',
    });
    await t.close();
  });

  it('returns project-scoped App Store setup after release evidence succeeds', async () => {
    seedConnection();
    const connections = new ConnectionRepository();
    connections.delete(connections.findByProvider('appstoreconnect')!.id);
    const t = await makeClient();

    const result = await t.call('hv_appstore_submit', SUBMIT_INPUT);

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'appstoreconnect',
      project: 'example',
      scope: 'com.example.app',
    });
    await t.close();
  });

  it('creates a review submission, adds the version as an item, and submits it', async () => {
    seedConnection();
    const getEditableVersion = stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions').mockResolvedValue([]);
    const create = vi.spyOn(AppStoreConnectAdapter.prototype, 'createReviewSubmission')
      .mockResolvedValue({ id: 'rs-1', state: 'READY_FOR_REVIEW', platform: 'IOS' });
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem').mockResolvedValue(undefined);
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission')
      .mockResolvedValue({ id: 'rs-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' });
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(getEditableVersion).toHaveBeenCalledWith('app-1', 'IOS');
    expect(create).toHaveBeenCalledWith('app-1', 'IOS');
    expect(addItem).toHaveBeenCalledWith('rs-1', 'ver-1');
    expect(submit).toHaveBeenCalledWith('rs-1');
    expect(res.data.version).toMatchObject({ id: 'ver-1', versionString: '1.2.0' });
    expect(res.data.reviewSubmission).toEqual({ id: 'rs-1', state: 'WAITING_FOR_REVIEW', reusedExistingSubmission: false });

    const audit = new AuditRepository().findByAction('appstore.submit');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ reviewSubmissionId: 'rs-1' });
    await t.close();
  });

  it('reuses an existing READY_FOR_REVIEW submission instead of creating one', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'READY_FOR_REVIEW', platform: 'IOS' }]);
    const create = vi.spyOn(AppStoreConnectAdapter.prototype, 'createReviewSubmission');
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem').mockResolvedValue(undefined);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission')
      .mockResolvedValue({ id: 'rs-9', state: 'WAITING_FOR_REVIEW', platform: 'IOS' });
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(res.ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith('rs-9', 'ver-1');
    expect(res.data.reviewSubmission).toEqual({ id: 'rs-9', state: 'WAITING_FOR_REVIEW', reusedExistingSubmission: true });
    await t.close();
  });

  it('fails clearly when a review submission is already in flight', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }]);
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem');
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('already WAITING_FOR_REVIEW');
    expect(res.error.message).toContain('rs-9');
    expect(addItem).not.toHaveBeenCalled();
    await t.close();
  });

  it('surfaces the provider error detail when adding the version item fails', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'READY_FOR_REVIEW', platform: 'IOS' }]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem')
      .mockRejectedValue(new Error('App Store Connect API: This version is already added to another submission.'));
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission');
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('Could not add version ver-1 to review submission rs-9');
    expect(res.error.message).toContain('already added to another submission');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('returns VALIDATION when no version is ready for submission', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion').mockResolvedValue(null);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listAppStoreVersions')
      .mockResolvedValue([{ id: 'ver-0', versionString: '1.1.0', appStoreState: 'READY_FOR_SALE', platform: 'IOS' }]);
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', SUBMIT_INPUT);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    expect(res.error.message).toContain('No version ready for submission');
    expect(res.error.details.currentVersions).toEqual([{ version: '1.1.0', state: 'READY_FOR_SALE', platform: 'IOS' }]);
    await t.close();
  });
});
