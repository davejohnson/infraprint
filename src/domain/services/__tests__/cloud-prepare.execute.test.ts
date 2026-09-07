import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { runCloudPrepare } from '../cloud-prepare.execute.js';

describe('runCloudPrepare', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-cloud-prepare-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedProject() {
    const projectRepo = new ProjectRepository();
    const connectionRepo = new ConnectionRepository();
    const project = projectRepo.create({
      name: 'hls-property-care',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
    });
    connectionRepo.create({
      provider: 'cloudrun',
      scope: 'davejohnson/hls-property-care',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'hls-property-care',
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'hls-property-care',
          private_key: 'not-used',
          client_email: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        }),
      }),
    });
    return project;
  }

  it('previews the bootstrap plan from the existing Cloud Run deploy connection', async () => {
    const project = seedProject();

    const payload = await runCloudPrepare({ project, provider: 'cloudrun' });

    expect(payload).toMatchObject({
      success: true,
      mode: 'preview',
      plan: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v1',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        member: 'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });
    const plan = payload.plan as { enableApis: string[]; grantRoles: string[] };
    expect(plan.enableApis).toContain('cloudscheduler.googleapis.com');
    expect(plan.grantRoles).toContain('roles/logging.viewAccessor');
    expect(plan.grantRoles).toContain('roles/cloudscheduler.admin');
    expect(plan.enableApis).not.toContain('storage.googleapis.com');
    expect(plan.enableApis).not.toContain('redis.googleapis.com');
    expect(plan.enableApis).not.toContain('pubsub.googleapis.com');
    expect(plan.grantRoles).not.toContain('roles/storage.viewer');
    expect(plan.grantRoles).not.toContain('roles/storage.admin');
    expect(plan.grantRoles).not.toContain('roles/redis.viewer');
    expect(plan.grantRoles).not.toContain('roles/redis.admin');
    expect(plan.grantRoles).not.toContain('roles/pubsub.editor');
  });

  it('previews least-privilege GCS inspection separately from lifecycle access', async () => {
    const project = seedProject();

    const inspected = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect' });
    const inspectPlan = inspected.plan as { enableApis: string[]; grantRoles: string[]; gcsAccess: string };
    expect(inspectPlan).toMatchObject({ gcsAccess: 'inspect' });
    expect(inspectPlan.enableApis).toEqual(['storage.googleapis.com']);
    expect(inspectPlan.grantRoles).toEqual(['roles/storage.viewer']);

    const lifecycle = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'lifecycle' });
    const lifecyclePlan = lifecycle.plan as { enableApis: string[]; grantRoles: string[]; gcsAccess: string };
    expect(lifecyclePlan).toMatchObject({ gcsAccess: 'lifecycle' });
    expect(lifecyclePlan.enableApis).toEqual(['storage.googleapis.com']);
    expect(lifecyclePlan.grantRoles).toEqual(['roles/storage.admin']);
  });

  it('keeps Memorystore and Pub/Sub preparation independently explicit', async () => {
    const project = seedProject();

    const inspected = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      memorystoreAccess: 'inspect',
    });
    const inspectPlan = inspected.plan as {
      enableApis: string[];
      grantRoles: string[];
      memorystoreAccess: string;
    };
    expect(inspectPlan).toMatchObject({ memorystoreAccess: 'inspect' });
    expect(inspectPlan.enableApis).toEqual(['compute.googleapis.com', 'redis.googleapis.com']);
    expect(inspectPlan.grantRoles).toEqual(['roles/compute.networkViewer', 'roles/redis.viewer']);

    const queue = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      queueAccess: 'lifecycle',
    });
    const queuePlan = queue.plan as {
      enableApis: string[];
      grantRoles: string[];
      queueAccess: string;
    };
    expect(queuePlan).toMatchObject({ queueAccess: 'lifecycle' });
    expect(queuePlan.enableApis).toEqual(['pubsub.googleapis.com']);
    expect(queuePlan.grantRoles).toEqual(['roles/pubsub.editor']);

    const removal = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      queueAccess: 'remove',
    });
    expect(removal.plan).toMatchObject({
      enableApis: [],
      grantRoles: [],
      revokeRoles: ['roles/pubsub.editor'],
      queueAccess: 'remove',
    });
  });

  it('uses existing Google default credentials to prepare only the reviewed staged access', async () => {
    const project = seedProject();
    let iamPolicy = {
      bindings: [{
        role: 'roles/run.admin',
        members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
      }],
    };

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('serviceusage.googleapis.com') && url.endsWith(':enable') && method === 'POST') {
        return Response.json({ name: 'operations/enable-api', done: true });
      }
      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        return Response.json(iamPolicy);
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        iamPolicy = JSON.parse(String(init?.body)).policy;
        return Response.json(iamPolicy);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const defaultAdminAccessTokenProvider = vi.fn(async () => 'admin-token');

    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      gcsAccess: 'inspect',
      adminAuth: 'default',
      defaultAdminAccessTokenProvider,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(defaultAdminAccessTokenProvider).toHaveBeenCalledOnce();
    expect(payload.enabledApis).toEqual([
      { service: 'storage.googleapis.com', status: 'enabled' },
    ]);
    expect(payload.grantedRoles).toEqual(['roles/storage.viewer']);
    expect(payload.existingRoles).toEqual([]);
    expect(payload).toMatchObject({ provider: 'cloudrun', version: 'gcp-cloudrun-v1' });

    const setIamCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(':setIamPolicy') && init?.method === 'POST'
    );
    expect(setIamCall).toBeTruthy();
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    const bindings = setIamBody.policy.bindings as Array<{ role: string; members: string[] }>;
    expect(bindings).toContainEqual({
      role: 'roles/storage.viewer',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });
    expect(bindings.map(({ role }) => role)).toEqual([
      'roles/run.admin',
      'roles/storage.viewer',
    ]);

    const updatedProject = new ProjectRepository().findById(project.id);
    expect(updatedProject?.policies.cloudPreparation).toMatchObject({
      cloudrun: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v1',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });
    expect(new AuditRepository().findByAction('cloud.prepare.succeeded')[0]?.details).toMatchObject({
      provider: 'cloudrun',
      gcpProjectId: 'hls-property-care',
      deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      gcsAccess: 'inspect',
      authenticationSource: 'application-default',
    });

    const refreshedProject = new ProjectRepository().findById(project.id)!;
    await runCloudPrepare({
      project: refreshedProject,
      provider: 'cloudrun',
      memorystoreAccess: 'inspect',
      adminAuth: 'default',
      defaultAdminAccessTokenProvider,
      confirm: true,
    });
    const cumulativelyPrepared = new ProjectRepository().findById(project.id);
    const preparation = cumulativelyPrepared?.policies.cloudPreparation as {
      cloudrun: { requiredApis: string[]; requiredRoles: string[] };
    };
    expect(preparation.cloudrun.requiredApis).toEqual(expect.arrayContaining([
      'compute.googleapis.com',
      'storage.googleapis.com',
      'redis.googleapis.com',
    ]));
    expect(preparation.cloudrun.requiredRoles).toEqual(expect.arrayContaining([
      'roles/compute.networkViewer',
      'roles/storage.viewer',
      'roles/redis.viewer',
    ]));
  });

  it('removes only Pub/Sub editor from the deploy identity and preserves other IAM and preparation state', async () => {
    const project = seedProject();
    new ProjectRepository().update(project.id, {
      policies: {
        ...project.policies,
        cloudPreparation: {
          cloudrun: {
            provider: 'cloudrun',
            version: 'gcp-cloudrun-v1',
            preparedAt: new Date().toISOString(),
            gcpProjectId: 'hls-property-care',
            deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
            requiredApis: ['storage.googleapis.com', 'pubsub.googleapis.com'],
            requiredRoles: ['roles/storage.viewer', 'roles/pubsub.editor'],
          },
        },
      },
    });
    const targetMember = 'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com';
    let iamPolicy = {
      bindings: [
        { role: 'roles/pubsub.editor', members: [targetMember, 'user:queue-owner@example.com'] },
        {
          role: 'roles/pubsub.editor',
          members: [targetMember, 'user:conditional-queue-owner@example.com'],
          condition: { title: 'temporary-access', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
        },
        { role: 'roles/storage.viewer', members: [targetMember] },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy')) {
        return Response.json(iamPolicy);
      }
      if (url.endsWith(':setIamPolicy') && init?.method === 'POST') {
        iamPolicy = JSON.parse(String(init.body)).policy;
        return Response.json(iamPolicy);
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await runCloudPrepare({
      project: new ProjectRepository().findById(project.id)!,
      provider: 'cloudrun',
      queueAccess: 'remove',
      adminAuth: 'default',
      defaultAdminAccessTokenProvider: async () => 'admin-token',
      confirm: true,
    });

    expect(payload).toMatchObject({
      success: true,
      enabledApis: [],
      grantedRoles: [],
      existingRoles: [],
      revokedRoles: ['roles/pubsub.editor'],
      alreadyAbsentRoles: [],
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('serviceusage.googleapis.com'))).toBe(false);
    const setIamCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(':setIamPolicy'));
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    expect(setIamBody.policy.bindings).toEqual([
      { role: 'roles/pubsub.editor', members: ['user:queue-owner@example.com'] },
      {
        role: 'roles/pubsub.editor',
        members: ['user:conditional-queue-owner@example.com'],
        condition: { title: 'temporary-access', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
      },
      { role: 'roles/storage.viewer', members: [targetMember] },
    ]);
    const updatedProject = new ProjectRepository().findById(project.id);
    const preparation = updatedProject?.policies.cloudPreparation as {
      cloudrun: { requiredApis: string[]; requiredRoles: string[] };
    };
    expect(preparation.cloudrun.requiredApis).toEqual([
      'storage.googleapis.com',
      'pubsub.googleapis.com',
    ]);
    expect(preparation.cloudrun.requiredRoles).toEqual(['roles/storage.viewer']);
    expect(new AuditRepository().findByAction('cloud.prepare.succeeded')[0]?.details).toMatchObject({
      queueAccess: 'remove',
      authenticationSource: 'application-default',
    });
  });

  it('returns exact ADC recovery guidance and audits only safe failure provenance', async () => {
    const project = seedProject();
    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      gcsAccess: 'inspect',
      adminAuth: 'default',
      adminCredentialSource: 'application-default',
      defaultAdminAccessTokenProvider: async () => {
        throw new Error('Could not load the default credentials.');
      },
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('stored deploy connection authenticates as hypervibe-hls-deploy@');
    expect(String(payload.error)).toContain('gcloud auth application-default login');
    expect(payload.adminCredentialSetup).toMatchObject({
      credentialType: 'Google user Application Default Credentials (ADC)',
      recommendedSetupUrl: 'https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment',
      gcloudCli: {
        requiredWhen: 'gcloud is not installed or not available on PATH',
        officialInstallUrl: 'https://cloud.google.com/sdk/docs/install',
        recommendedInstallation: 'Use Google\'s official platform installer or archive from officialInstallUrl.',
      },
      commands: ['gcloud auth application-default login'],
      optionalQuotaProjectCommand: 'gcloud auth application-default set-quota-project hls-property-care',
      requiredRoles: [
        'roles/serviceusage.serviceUsageAdmin',
        'roles/resourcemanager.projectIamAdmin',
      ],
      resourceScope: 'projects/hls-property-care',
      retryCall: {
        project: 'hls-property-care',
        provider: 'cloudrun',
        action: 'prepare',
        gcsAccess: 'inspect',
        adminAuth: 'default',
        confirm: true,
      },
    });
    expect(String((payload.adminCredentialSetup as Record<string, unknown>).credentialExample))
      .toContain('adminAuth="default"');

    const audit = new AuditRepository().findByAction('cloud.prepare.failed')[0];
    expect(audit?.details).toEqual({
      provider: 'cloudrun',
      version: 'gcp-cloudrun-v1',
      gcpProjectId: 'hls-property-care',
      deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      gcsAccess: 'inspect',
      authenticationSource: 'application-default',
      failureCategory: 'missing_application_default_credentials',
    });
    expect(JSON.stringify(audit)).not.toContain('Could not load the default credentials');
  });

  it('requires admin credentials when confirming', async () => {
    const project = seedProject();
    const payload = await runCloudPrepare({ project, provider: 'cloudrun', confirm: true });
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('adminAuth="default"');

    const cleanup = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      queueAccess: 'remove',
      confirm: true,
    });
    expect(cleanup.requiredAdminPermissions).toEqual([
      'resourcemanager.projects.getIamPolicy',
      'resourcemanager.projects.setIamPolicy',
    ]);
  });
});
