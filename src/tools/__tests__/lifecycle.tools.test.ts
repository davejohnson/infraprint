import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter, type RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { MemorystoreAdapter } from '../../adapters/providers/gcp/memorystore.adapter.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { NeonAdapter } from '../../adapters/providers/neon/neon.adapter.js';
import { AzurePostgresAdapter } from '../../adapters/providers/azure/azure-postgres.adapter.js';
import type { ObservedService, ObservedState } from '../../domain/ports/observe.port.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { registerLifecycleTools } from '../lifecycle.tools.js';
import { createToolContext } from '../../application/context.js';
import '../../application/providers.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-lifecycle-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'lifecycle-tools-test', version: '0.0.0' });
  registerLifecycleTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'lifecycle-tools-test', version: '1.0.0' });
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

async function makeFullClient() {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client({ name: 'lifecycle-roundtrip-test', version: '1.0.0' });
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

describe('hv_destroy', () => {
  it('rejects selectors for another destroy scope before confirmation or deletion', async () => {
    new ProjectRepository().create({ name: 'scope-safe-app' });
    const t = await makeClient();

    const result = await t.call('hv_destroy', {
      project: 'scope-safe-app',
      scope: 'project',
      env: 'staging',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(new ProjectRepository().findByName('scope-safe-app')).not.toBeNull();
    await t.close();
  });

  it('gates project deletion behind confirm and then deletes local records', async () => {
    const t = await makeClient();
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'doomed-app' });
    envRepo.create({ projectId: project.id, name: 'staging', platformBindings: {} });
    serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {} });

    const preview = await t.call('hv_destroy', { project: 'doomed-app', scope: 'project' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(preview.error.details.environments).toEqual(['staging']);
    expect(preview.error.details.services).toEqual(['web']);
    expect(projectRepo.findByName('doomed-app')).not.toBeNull();

    const destroyed = await t.call('hv_destroy', { project: 'doomed-app', scope: 'project', confirm: true });
    expect(destroyed.ok).toBe(true);
    expect(destroyed.data.deleted.scope).toBe('project');
    expect(destroyed.data.deleted.services).toEqual(['web']);
    expect(projectRepo.findByName('doomed-app')).toBeNull();
    await t.close();
  });

  it('deletes a local environment record with confirm', async () => {
    const t = await makeClient();
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({ name: 'env-app' });
    envRepo.create({ projectId: project.id, name: 'staging', platformBindings: {} });

    const preview = await t.call('hv_destroy', { project: 'env-app', scope: 'environment', env: 'staging' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');

    const destroyed = await t.call('hv_destroy', { project: 'env-app', scope: 'environment', env: 'staging', confirm: true });
    expect(destroyed.ok).toBe(true);
    expect(destroyed.data.deleted.environment).toBe('staging');
    expect(envRepo.findByProjectAndName(project.id, 'staging')).toBeNull();
    await t.close();
  });

  it('requires name for service scope and removes the service plus its binding', async () => {
    const t = await makeClient();
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'svc-app' });
    const env = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {} });

    const missingName = await t.call('hv_destroy', { project: 'svc-app', scope: 'service' });
    expect(missingName.ok).toBe(false);
    expect(missingName.error.code).toBe('VALIDATION');

    const preview = await t.call('hv_destroy', { project: 'svc-app', scope: 'service', name: 'web' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(preview.error.details.bindingsRemovedFrom).toEqual(['staging']);

    const destroyed = await t.call('hv_destroy', { project: 'svc-app', scope: 'service', name: 'web', confirm: true });
    expect(destroyed.ok).toBe(true);
    expect(destroyed.data.deleted.bindingsRemovedFrom).toEqual(['staging']);
    expect(serviceRepo.findByProjectAndName(project.id, 'web')).toBeNull();

    const bindings = envRepo.findById(env.id)!.platformBindings as { services?: Record<string, unknown> };
    expect(bindings.services?.web).toBeUndefined();
    await t.close();
  });
});

describe('hv_inspect / hv_import', () => {
  it('rejects fields for the other import mode before inspecting or writing state', async () => {
    const t = await makeClient();

    const retained = await t.call('hv_import', {
      provider: 'railway',
      mode: 'retained-cleanup',
      project: 'app',
      env: 'production',
      name: 'wrong-mode-project',
    });
    expect(retained.ok).toBe(false);
    expect(retained.error.code).toBe('VALIDATION');
    expect(retained.error.message).toContain('other import mode');

    const adopt = await t.call('hv_import', {
      provider: 'railway',
      mode: 'adopt',
      name: 'provider-project',
      project: 'wrong-mode-project',
    });
    expect(adopt.ok).toBe(false);
    expect(adopt.error.code).toBe('VALIDATION');
    expect(adopt.error.message).toContain('other import mode');
    await t.close();
  });

  const details: RailwayProjectDetails = {
    id: 'rp-1',
    name: 'demo-app',
    environments: {
      edges: [{ node: { id: 'env-prod', name: 'production' } }],
    },
    services: {
      edges: [{
        node: {
          id: 'svc-web',
          name: 'web',
          repoTriggers: { edges: [{ node: { repository: 'acme/demo-app', branch: 'main' } }] },
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: {
                  serviceDomains: [{ domain: 'web-production.up.railway.app' }],
                  customDomains: [{ domain: 'demo-app.example.com' }],
                },
                startCommand: 'npm start',
                healthcheckPath: undefined,
                numReplicas: 1,
                sleepApplication: false,
              },
            }],
          },
        },
      }],
    },
    plugins: { edges: [] },
  };

  function createRailwayConnection(verified = false) {
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'token' }),
    });
    return verified ? repository.updateStatus(connection.id, 'verified')! : connection;
  }

  function mockAdapter(projectDetails: RailwayProjectDetails = details) {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'listProjects').mockResolvedValue([{ id: projectDetails.id, name: projectDetails.name }]);
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(projectDetails);
    vi.spyOn(RailwayAdapter.prototype, 'findProjectsByName').mockResolvedValue([{ id: projectDetails.id, name: projectDetails.name }]);
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({ DATABASE_URL: 'postgres://x' });
  }

  function railwayService(input: {
    id: string;
    name: string;
    domain?: string;
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
  }): RailwayProjectDetails['services']['edges'][number] {
    return {
      node: {
        id: input.id,
        name: input.name,
        repoTriggers: { edges: [] },
        serviceInstances: {
          edges: [{
            node: {
              environmentId: 'env-prod',
              domains: {
                serviceDomains: input.domain ? [{ domain: input.domain }] : [],
                customDomains: [],
              },
              startCommand: input.startCommand,
              preDeployCommand: input.releaseCommand ? [input.releaseCommand] : undefined,
              healthcheckPath: input.healthCheckPath,
              cronSchedule: input.cronSchedule,
            },
          }],
        },
      },
    };
  }

  function observedService(input: {
    id: string;
    name: string;
    workloadKind?: ObservedService['workloadKind'];
    url?: string;
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    envVarKeys?: string[];
    customDomains?: string[];
    customDomainStatus?: ObservedService['customDomainStatus'];
  }): ObservedService {
    const envVarKeys = input.envVarKeys ?? [];
    return {
      name: input.name,
      externalId: input.id,
      workloadKind: input.workloadKind ?? 'web',
      ...(input.url ? { url: input.url } : {}),
      customDomains: input.customDomains ?? [],
      ...(input.customDomainStatus ? { customDomainStatus: input.customDomainStatus } : {}),
      config: {
        ...(input.startCommand ? { startCommand: input.startCommand } : {}),
        ...(input.releaseCommand ? { releaseCommand: input.releaseCommand } : {}),
        ...(input.healthCheckPath ? { healthCheckPath: input.healthCheckPath } : {}),
        ...(input.cronSchedule ? { cronSchedule: input.cronSchedule } : {}),
        public: Boolean(input.url),
      },
      sourceState: 'disconnected',
      envVarKeys,
      envVarHashes: Object.fromEntries(envVarKeys.map((key) => [key, `hash:${key}`])),
      status: 'running',
    };
  }

  it('hv_inspect returns MISSING_CONNECTION when no Railway connection exists', async () => {
    new ProjectRepository().create({
      name: 'inspect-app',
      gitRemoteUrl: 'https://github.com/davejohnson/inspect-app',
    });
    const t = await makeClient();
    const result = await t.call('hv_inspect', { provider: 'railway', project: 'inspect-app' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'railway',
      project: 'inspect-app',
      scope: 'davejohnson/inspect-app',
    });
    expect(result.next).toContain('hv_connections');
    await t.close();
  });

  it('hv_inspect lists every registered provider and its read capabilities without opening connections', async () => {
    const t = await makeClient();
    const result = await t.call('hv_inspect', {});

    expect(result.ok).toBe(true);
    expect(result.data.providers.map((provider: { provider: string }) => provider.provider).sort())
      .toEqual(providerRegistry.names().sort());
    expect(result.data.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', resources: expect.arrayContaining(['repository', 'ref', 'pages']) }),
      expect.objectContaining({ provider: 'cloudflare', resources: expect.arrayContaining(['zone', 'dns']) }),
      expect.objectContaining({ provider: 'railway', resources: expect.arrayContaining(['project', 'environment']) }),
      expect.objectContaining({ provider: 'fly', resources: expect.arrayContaining(['environment', 'database']) }),
      expect.objectContaining({
        provider: 'cloudsql',
        resources: expect.arrayContaining(['connection', 'database']),
        inspectionModes: expect.arrayContaining([
          expect.objectContaining({ resource: 'connection', acceptsLimit: false }),
          expect.objectContaining({ resource: 'database', mode: 'provider-resource', acceptsLimit: true }),
        ]),
      }),
      expect.objectContaining({
        provider: 'cloudrun',
        inspectionModes: expect.arrayContaining([
          expect.objectContaining({ resource: 'environment', mode: 'environment-forensics', acceptsLimit: true }),
          expect.objectContaining({ resource: 'environment', mode: 'environment', acceptsLimit: false }),
        ]),
      }),
    ]));
    expect(result.data.providers.find((entry: { provider: string }) => entry.provider === 'railway'))
      .toMatchObject({
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
      });
    expect(result.data.providers.find((entry: { provider: string }) => entry.provider === 'memorystore'))
      .toMatchObject({
        maturity: {
          lifecycle: {
            cache: { status: 'ready-for-live', reason: expect.any(String) },
          },
        },
      });
    const vercel = result.data.providers.find((entry: { provider: string }) => entry.provider === 'vercel');
    expect(vercel.inspectionModes
      .filter((mode: { resource: string }) => mode.resource === 'environment')
      .every((mode: { optional: string[] }) => !mode.optional.includes('region'))).toBe(true);
    expect(providerRegistry.namesFor('storage').sort()).toEqual(['azureblob', 'gcs', 'railway', 's3']);
    for (const provider of providerRegistry.namesFor('hosting')) {
      expect(providerRegistry.get(provider)?.inspection?.resources, provider)
        .toContain('environment');
      expect(
        providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.teardownBoundary,
        provider
      ).toMatch(/^(services|environment|project)$/);
    }
    for (const resource of ['database', 'cache', 'storage'] as const) {
      for (const provider of providerRegistry.namesFor(resource)) {
        const contract = providerRegistry.get(provider)?.inspection?.selectors[resource];
        expect(providerRegistry.get(provider)?.inspection?.resources, `${provider}/${resource}`)
          .toContain(resource);
        expect(contract, `${provider}/${resource}`).toMatchObject({
          mode: 'provider-resource',
          list: true,
        });
        expect(contract?.scopeKeys?.length, `${provider}/${resource}`).toBeGreaterThan(0);
        expect(contract?.optional, `${provider}/${resource}`)
          .toEqual(expect.arrayContaining(['id', 'name', 'limit']));
      }
    }
    for (const registered of providerRegistry.all().filter((provider) => provider.inspection)) {
      const inspection = registered.inspection!;
      expect(Object.keys(inspection.selectors).sort(), registered.metadata.name)
        .toEqual([...inspection.resources].sort());
      expect(inspection.resources, registered.metadata.name)
        .toContain(inspection.defaultResource ?? inspection.resources[0]);
      for (const resource of inspection.resources) {
        const selectors = inspection.selectors[resource]!;
        const accepted = [
          ...(selectors.required ?? []),
          ...(selectors.optional ?? []),
          ...(selectors.oneOf?.flat() ?? []),
        ];
        expect(accepted.includes('limit'), `${registered.metadata.name}/${resource}`)
          .toBe(selectors.list === true);
      }
    }
    await t.close();
  });

  it('hv_inspect uses Cloud SQL database inventory as its provider-only default and accepts its advertised limit', async () => {
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudsql',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    const inspect = vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      project: { id: 'gcp-project' },
      databases: [{
        id: 'customer-facing-primary',
        name: 'customer-facing-primary',
        engine: 'postgres',
        providerScope: { projectId: 'gcp-project', region: 'northamerica-northeast1' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'cloudsql', limit: 10 });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      mode: 'provider-resource',
      resource: 'database',
      databases: [{ id: 'customer-facing-primary' }],
    });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ resource: 'database', limit: 10 }));
    await t.close();
  });

  it('hv_inspect rejects stateful inventory that violates its declared durable scope contract', async () => {
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudsql',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      databases: [{ id: 'db-1', name: 'db-1', engine: 'postgres', providerScope: {} }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'cloudsql', resource: 'database' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { resource: 'database', missingScopeKeys: ['projectId'] },
    });
    await t.close();
  });

  it('hv_inspect accepts region when the provider-owned resource contract advertises it', async () => {
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'memorystore',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: '{}',
      }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(MemorystoreAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'disconnect').mockResolvedValue();
    const inspect = vi.spyOn(MemorystoreAdapter.prototype, 'inspectCacheResources').mockResolvedValue({
      observation: 'present',
      resource: 'cache',
      caches: [{
        id: 'projects/gcp-project/locations/europe-west1/instances/sessions',
        name: 'sessions',
        engine: 'redis',
        providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'memorystore',
      resource: 'cache',
      region: 'europe-west1',
      limit: 5,
    });

    expect(result.ok).toBe(true);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'cache',
      region: 'europe-west1',
      limit: 5,
    }));
    await t.close();
  });

  it('hv_inspect reuses a verified Cloud Run connection for Memorystore inventory', async () => {
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'gcp-project',
          client_email: 'hypervibe@gcp-project.iam.gserviceaccount.com',
          private_key: 'private-key',
        }),
      }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(MemorystoreAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'disconnect').mockResolvedValue();
    const inspect = vi.spyOn(MemorystoreAdapter.prototype, 'inspectCacheResources').mockResolvedValue({
      observation: 'absent',
      resource: 'cache',
      caches: [],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'memorystore',
      resource: 'cache',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      provider: 'memorystore',
      observation: 'absent',
      resource: 'cache',
      caches: [],
    });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ resource: 'cache' }));
    await t.close();
  });

  it('hv_inspect rejects limit when a provider-only call falls back to connection verification', async () => {
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'cloudrun', limit: 10 });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details.suggestedCall).toEqual({
      command: 'hv_inspect',
      input: { provider: 'cloudrun' },
    });
    expect(result.agentInstruction).toMatchObject({ action: 'continue' });
    await t.close();
  });

  it('hv_inspect selects the resource-specific component in mixed database/cache environments regardless of insertion order', async () => {
    const project = new ProjectRepository().create({ name: 'mixed-datastore-inspection' });
    const first = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'database-first',
      platformBindings: { provider: 'digitalocean', projectId: 'app-1' },
    });
    const second = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'cache-first',
      platformBindings: { provider: 'digitalocean', projectId: 'app-2' },
    });
    const components = new ComponentRepository();
    const firstDatabase = components.create({
      environmentId: first.id,
      type: 'postgres',
      externalId: 'db-first',
      bindings: { provider: 'digitalocean' },
    });
    const firstCache = components.create({
      environmentId: first.id,
      type: 'redis',
      externalId: 'cache-second',
      bindings: { provider: 'digitalocean' },
    });
    const secondCache = components.create({
      environmentId: second.id,
      type: 'redis',
      externalId: 'cache-first',
      bindings: { provider: 'digitalocean' },
    });
    const secondDatabase = components.create({
      environmentId: second.id,
      type: 'postgres',
      externalId: 'db-second',
      bindings: { provider: 'digitalocean' },
    });
    const observeDatabase = vi.fn(async (_environment, component) => ({
      provider: 'digitalocean', engine: 'postgres', externalId: component.externalId,
      providerScope: { accountUuid: 'account-1' }, status: 'running',
    }));
    const observeCache = vi.fn(async (_environment, component) => ({
      provider: 'digitalocean', engine: 'redis', externalId: component.externalId,
      providerScope: { accountUuid: 'account-1' }, status: 'running',
    }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'digitalocean',
        observeDatabase,
        observeCache,
        disconnect: async () => {},
      },
    } as never);
    const t = await makeClient();

    await t.call('hv_inspect', {
      provider: 'digitalocean', project: project.name, env: first.name, resource: 'cache',
    });
    await t.call('hv_inspect', {
      provider: 'digitalocean', project: project.name, env: second.name, resource: 'database',
    });

    expect(observeCache).toHaveBeenCalledWith(first, expect.objectContaining({ id: firstCache.id }), expect.anything());
    expect(observeDatabase).toHaveBeenCalledWith(second, expect.objectContaining({ id: secondDatabase.id }), expect.anything());
    expect(observeCache).not.toHaveBeenCalledWith(first, expect.objectContaining({ id: firstDatabase.id }), expect.anything());
    expect(observeDatabase).not.toHaveBeenCalledWith(second, expect.objectContaining({ id: secondCache.id }), expect.anything());
    await t.close();
  });

  it('hv_import confirmation-gates one exact scoped retained database cleanup identity', async () => {
    const project = new ProjectRepository().create({ name: 'retained-database-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
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
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudsql',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      project: { id: 'gcp-project' },
      databases: [{
        id: 'legacy-production-db',
        name: 'legacy-production-db',
        engine: 'postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();
    const input = {
      provider: 'cloudsql',
      mode: 'retained-database-cleanup',
      project: project.name,
      env: environment.name,
      id: 'legacy-production-db',
    };

    const preview = await t.call('hv_import', input);
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousDatabase).toBeUndefined();

    const retained = await t.call('hv_import', { ...input, confirm: true });
    expect(retained.ok).toBe(true);
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousDatabase).toEqual({
      provider: 'cloudsql',
      externalId: 'legacy-production-db',
      engine: 'postgres',
      name: 'legacy-production-db',
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
    });
    expect(new ComponentRepository().findById(unresolved.id)).toMatchObject({
      externalId: null,
      bindings: { provisioningIncomplete: true },
    });
    await t.close();
  });

  it('hv_import refuses to retarget an unresolved database marker to a different inspected scope', async () => {
    const project = new ProjectRepository().create({ name: 'unresolved-database-scope-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: null,
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        provisioningIncomplete: true,
        unresolvedMutation: {
          resourceKind: 'database',
          operation: 'create',
          resourceName: 'production-postgres',
          providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudsql',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      project: { id: 'gcp-project' },
      databases: [{
        id: 'candidate-db',
        name: 'production-postgres',
        engine: 'postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'cloudsql',
      mode: 'retained-database-cleanup',
      project: project.name,
      env: environment.name,
      id: 'candidate-db',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('does not exactly match the unresolved');
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousDatabase)
      .toBeUndefined();
    await t.close();
  });

  it('hv_import confirmation-gates one exact scoped retained cache cleanup identity', async () => {
    const project = new ProjectRepository().create({ name: 'retained-cache-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun' },
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
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'memorystore',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(MemorystoreAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'inspectCacheResources').mockResolvedValue({
      observation: 'present',
      resource: 'cache',
      caches: [{
        id: 'legacy-production-cache-id',
        name: 'legacy-production-cache',
        engine: 'redis',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();
    const input = {
      provider: 'memorystore',
      mode: 'retained-cache-cleanup',
      project: project.name,
      env: environment.name,
      id: 'legacy-production-cache-id',
    };

    const preview = await t.call('hv_import', input);
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousCache).toBeUndefined();

    const retained = await t.call('hv_import', { ...input, confirm: true });
    expect(retained.ok).toBe(true);
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousCache).toEqual({
      provider: 'memorystore',
      externalId: 'legacy-production-cache-id',
      engine: 'redis',
      providerEngine: 'redis',
      name: 'legacy-production-cache',
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
    });
    expect(new ComponentRepository().findById(unresolved.id)).toMatchObject({
      externalId: null,
      bindings: { provisioningIncomplete: true },
    });
    await t.close();
  });

  it('hv_import refuses to retarget an unresolved cache marker to a different inspected scope', async () => {
    const project = new ProjectRepository().create({ name: 'unresolved-cache-scope-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun' },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'redis',
      externalId: null,
      bindings: {
        provider: 'memorystore',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        provisioningIncomplete: true,
        unresolvedMutation: {
          resourceKind: 'cache',
          operation: 'create',
          resourceName: 'production-cache',
          providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'memorystore',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(MemorystoreAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'inspectCacheResources').mockResolvedValue({
      observation: 'present',
      resource: 'cache',
      caches: [{
        id: 'candidate-cache',
        name: 'production-cache',
        engine: 'redis',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'memorystore',
      mode: 'retained-cache-cleanup',
      project: project.name,
      env: environment.name,
      id: 'candidate-cache',
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(['NOT_FOUND', 'VALIDATION']).toContain(result.error.code);
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousCache).toBeUndefined();
    await t.close();
  });

  it('hv_import confirmation-gates one exact provider-declared retained resource', async () => {
    const project = new ProjectRepository().create({ name: 'retained-backup-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudsql',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectBackupResources').mockResolvedValue({
      observation: 'present',
      resource: 'backup',
      backups: [{
        id: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        providerScope: { projectId: 'gcp-project' },
        cleanupSupported: true,
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();
    const input = {
      provider: 'cloudsql',
      mode: 'retained-resource-cleanup',
      resource: 'backup',
      project: project.name,
      env: environment.name,
      id: 'projects/gcp-project/backups/backup-123',
    };

    const preview = await t.call('hv_import', input);
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousResource).toBeUndefined();

    const retained = await t.call('hv_import', { ...input, confirm: true });
    expect(retained.ok).toBe(true);
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.previousResource).toEqual({
      provider: 'cloudsql',
      resource: 'backup',
      externalId: 'projects/gcp-project/backups/backup-123',
      name: 'backup-123',
      providerScope: { projectId: 'gcp-project' },
    });
    await t.close();
  });

  it('hv_inspect returns Cloud SQL inventory candidates instead of a false null for an unbound environment', async () => {
    const project = new ProjectRepository().create({ name: 'cloudsql-inventory-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudsql',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'differently-named-primary',
        name: 'differently-named-primary',
        engine: 'postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      }],
      truncated: false,
      partial: false,
    });
    const observe = vi.spyOn(CloudSqlAdapter.prototype, 'observeDatabase');
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'cloudsql',
      project: project.name,
      env: 'production',
      resource: 'database',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      mode: 'database',
      observed: null,
      binding: 'missing',
      inventory: {
        observation: 'present',
        databases: [{ id: 'differently-named-primary' }],
      },
    });
    expect(result.data.warning).toContain('not environment attribution');
    expect(observe).not.toHaveBeenCalled();
    await t.close();
  });

  it('hv_inspect passes only a sanitized compatible hosting scope to Azure database inventory', async () => {
    const subscriptionId = '22222222-2222-4222-8222-222222222222';
    const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/hv-inspect-production`;
    const environmentId = `${resourceGroupId}/providers/Microsoft.App/managedEnvironments/hv-inspect`;
    const project = new ProjectRepository().create({ name: 'azure-database-inventory-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'azure-container-apps',
        projectId: resourceGroupId,
        environmentId,
        services: {
          web: {
            serviceId: 'azure-web-id',
            injectedSecret: 'must-never-cross-the-provider-boundary',
          },
        },
        componentSecret: 'must-never-cross-the-provider-boundary',
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'azure-container-apps',
      credentialsEncrypted: getSecretStore().encryptObject({
        tenantId: '11111111-1111-4111-8111-111111111111',
        subscriptionId,
        clientId: '33333333-3333-4333-8333-333333333333',
        clientSecret: 'azure-secret-never-output',
      }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(AzurePostgresAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(AzurePostgresAdapter.prototype, 'disconnect').mockResolvedValue();
    const inspect = vi.spyOn(
      AzurePostgresAdapter.prototype,
      'inspectDatabaseResources'
    ).mockResolvedValue({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: `${resourceGroupId}/providers/Microsoft.DBforPostgreSQL/flexibleServers/selected-db`,
        name: 'selected-db',
        engine: 'postgres',
        providerScope: { subscriptionId, resourceGroup: 'hv-inspect-production' },
      }],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'azure-postgres',
      project: project.name,
      env: 'production',
      resource: 'database',
      name: 'selected-db',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      provider: 'azure-postgres',
      mode: 'database',
      binding: 'missing',
      inventory: { databases: [{ name: 'selected-db' }] },
    });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'database',
      name: 'selected-db',
      binding: {
        provider: 'azure-container-apps',
        projectId: resourceGroupId,
        environmentId,
      },
    }));
    const forwardedRequest = inspect.mock.calls[0]![0];
    expect(JSON.stringify(forwardedRequest)).not.toContain('must-never-cross-the-provider-boundary');
    expect(forwardedRequest.binding).not.toHaveProperty('services');

    const defaultResult = await t.call('hv_inspect', {
      provider: 'azure-postgres',
      project: project.name,
      env: 'production',
    });
    expect(defaultResult.ok).toBe(true);
    expect(inspect).toHaveBeenLastCalledWith(expect.objectContaining({
      resource: 'database',
      binding: {
        provider: 'azure-container-apps',
        projectId: resourceGroupId,
        environmentId,
      },
    }));
    await t.close();
  });

  it('hv_inspect does not pass an incompatible hosting binding to a datastore provider', async () => {
    const project = new ProjectRepository().create({ name: 'incompatible-database-inventory-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'azure-container-apps',
        projectId: '/subscriptions/sub/resourceGroups/unrelated',
        environmentId: '/subscriptions/sub/resourceGroups/unrelated/providers/Microsoft.App/managedEnvironments/app',
        services: { web: { serviceId: 'azure-web-id' } },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'neon',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'neon-token' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(NeonAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(NeonAdapter.prototype, 'disconnect').mockResolvedValue();
    const inspect = vi.spyOn(NeonAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'absent',
      resource: 'database',
      databases: [],
      truncated: false,
      partial: false,
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'neon',
      project: project.name,
      env: 'production',
      resource: 'database',
      name: 'selected-db',
    });

    expect(result.ok).toBe(true);
    expect(inspect).toHaveBeenCalledWith(expect.not.objectContaining({
      binding: expect.anything(),
    }));
    await t.close();
  });

  it('hv_inspect uses provider-scoped forensics instead of passing a current-provider binding to an abandoned provider', async () => {
    const project = new ProjectRepository().create({ name: 'migrated-inspect-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment-uuid',
        services: { web: { serviceId: 'railway-web' } },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: '{}',
      }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudRunAdapter.prototype, 'disconnect').mockResolvedValue();
    const configureTarget = vi.spyOn(CloudRunAdapter.prototype, 'configureTarget')
      .mockImplementation(() => undefined);
    const inspectEnvironmentResources = vi.spyOn(
      CloudRunAdapter.prototype as any,
      'inspectEnvironmentResources'
    ).mockResolvedValue({
      observation: 'present',
      resource: 'environment',
      project: { id: 'gcp-project' },
      environment: { name: 'production', region: 'us-central1' },
      services: [{ id: 'legacy-web', name: 'web', workloadKind: 'web' }],
    });
    const observe = vi.spyOn(CloudRunAdapter.prototype, 'observe')
      .mockRejectedValue(new Error('current Railway bindings must not reach Cloud Run observe'));
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'cloudrun',
      project: project.name,
      env: 'production',
      region: 'europe-west1',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      provider: 'cloudrun',
      mode: 'environment-forensics',
      project: project.name,
      environment: 'production',
      currentHostingProvider: 'railway',
      inspected: {
        observation: 'present',
        resource: 'environment',
        services: [{ id: 'legacy-web', name: 'web' }],
      },
    });
    expect(inspectEnvironmentResources).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({ id: project.id, name: project.name }),
      environment: expect.objectContaining({ name: 'production' }),
      binding: undefined,
    }));
    expect(observe).not.toHaveBeenCalled();
    expect(configureTarget).toHaveBeenCalledWith({ region: 'europe-west1' });
    await t.close();
  });

  it('hv_inspect rejects an over-limit environment-forensics collection', async () => {
    const project = new ProjectRepository().create({ name: 'bounded-forensics-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });
    const connection = new ConnectionRepository().create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: '{}',
      }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudRunAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudRunAdapter.prototype as any, 'inspectEnvironmentResources').mockResolvedValue({
      observation: 'present',
      resource: 'environment',
      services: [
        { id: 'service-1', name: 'one' },
        { id: 'service-2', name: 'two' },
      ],
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'cloudrun',
      project: project.name,
      env: 'production',
      limit: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { resource: 'environment', collectionKey: 'services' },
    });
    expect(result.error.message).toContain('above limit 1');
    await t.close();
  });

  it('hv_import can confirmation-gate and retain provider-neutral forensic results for cleanup', async () => {
    const project = new ProjectRepository().create({ name: 'migrated-cleanup-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { web: { serviceId: 'railway-web' } },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudRunAdapter.prototype, 'disconnect').mockResolvedValue();
    const configureTarget = vi.spyOn(CloudRunAdapter.prototype, 'configureTarget')
      .mockImplementation(() => undefined);
    vi.spyOn(CloudRunAdapter.prototype, 'inspectEnvironmentResources').mockResolvedValue({
      observation: 'present',
      resource: 'environment',
      project: { id: 'gcp-project' },
      environment: { name: 'production', region: 'us-central1' },
      services: [
        { id: 'legacy-web', name: 'web', workloadKind: 'web', resourceType: 'service', managedByHypervibe: true },
        {
          id: 'legacy-daily-schedule', name: 'daily', workloadKind: 'cron', resourceType: 'scheduledJob',
          jobName: 'legacy-daily', schedulerJobName: 'legacy-daily-schedule', managedByHypervibe: true,
        },
      ],
      partial: false,
    });
    const t = await makeClient();
    const input = {
      provider: 'cloudrun',
      mode: 'retained-cleanup',
      project: project.name,
      env: environment.name,
      region: 'europe-west1',
    };

    const preview = await t.call('hv_import', input);
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect((new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, unknown>)
      .previousHosting).toBeUndefined();

    const retained = await t.call('hv_import', { ...input, confirm: true });
    expect(retained.ok).toBe(true);
    expect(retained.data).toMatchObject({
      retainedCleanup: { provider: 'cloudrun', project: project.name, environment: 'production' },
    });
    expect((new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, unknown>)
      .previousHosting).toMatchObject({
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'legacy-web', resourceType: 'service' },
          daily: {
            serviceId: 'legacy-daily-schedule',
            jobName: 'legacy-daily',
            schedulerJobName: 'legacy-daily-schedule',
            resourceType: 'scheduledJob',
          },
        },
      });
    expect(configureTarget).toHaveBeenCalledWith({ region: 'europe-west1' });
    await t.close();
  });

  it('hv_inspect resolves an exact Cloudflare DNS record id within the selected zone', async () => {
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'cloudflare',
      scope: 'example.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cf-token' }),
    });
    repository.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => undefined);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([
      {
        id: 'record-1',
        zone_id: 'zone-1',
        zone_name: 'example.com',
        name: 'example.com',
        type: 'CNAME',
        content: 'app.example.net',
        proxiable: true,
        proxied: true,
        ttl: 1,
        created_on: '2026-08-08T00:00:00.000Z',
        modified_on: '2026-08-08T00:00:00.000Z',
      },
      {
        id: 'record-2',
        zone_id: 'zone-1',
        zone_name: 'example.com',
        name: '_verify.example.com',
        type: 'TXT',
        content: 'verify-token',
        proxiable: false,
        proxied: false,
        ttl: 1,
        created_on: '2026-08-08T00:00:00.000Z',
        modified_on: '2026-08-08T00:00:00.000Z',
      },
    ]);
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'cloudflare',
      scope: 'example.com',
      resource: 'dns',
      id: 'record-2',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      resource: 'dns',
      observation: 'present',
      zone: { id: 'zone-1', name: 'example.com' },
      records: [{ id: 'record-2', name: '_verify.example.com', type: 'TXT' }],
    });
    await t.close();
  });

  it('hv_inspect rejects selectors that would otherwise be silently ignored', async () => {
    const project = new ProjectRepository().create({ name: 'inspect-selector-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const t = await makeClient();

    const missingProvider = await t.call('hv_inspect', { project: project.name });
    expect(missingProvider.ok).toBe(false);
    expect(missingProvider.error.code).toBe('VALIDATION');
    expect(missingProvider.error.details.selectors).toEqual(['project']);
    expect(missingProvider.hint).toContain('hv_inspect({}) with no parameters');
    expect(missingProvider.hint).toContain('provider, project, and env');

    const untypedSelector = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      id: 'provider-id',
    });
    expect(untypedSelector.ok).toBe(false);
    expect(untypedSelector.error.code).toBe('VALIDATION');
    expect(untypedSelector.error.details.invalid).toEqual(['id']);
    expect(untypedSelector.hint).toContain('provider, project, and env');

    const ignoredDatabaseRegion = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      resource: 'database',
      region: 'us-west1',
    });
    expect(ignoredDatabaseRegion.ok).toBe(false);
    expect(ignoredDatabaseRegion.error.code).toBe('VALIDATION');
    expect(ignoredDatabaseRegion.error.details).toMatchObject({
      invalid: ['region'],
      suggestedCall: {
        command: 'hv_inspect',
        input: {
          provider: 'railway',
          project: project.name,
          env: 'staging',
          resource: 'database',
        },
      },
    });

    const mixedModes = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      resource: 'project',
    });
    expect(mixedModes.ok).toBe(false);
    expect(mixedModes.error.code).toBe('VALIDATION');

    const connectionWithEnv = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      resource: 'connection',
    });
    expect(connectionWithEnv.ok).toBe(false);
    expect(connectionWithEnv.error.code).toBe('VALIDATION');
    expect(connectionWithEnv.error.details.invalid).toEqual(['env']);

    const connectionWithLimit = await t.call('hv_inspect', {
      provider: 'openai',
      limit: 5,
    });
    expect(connectionWithLimit.ok).toBe(false);
    expect(connectionWithLimit.error.code).toBe('VALIDATION');
    expect(connectionWithLimit.error.details.suggestedCall).toEqual({
      command: 'hv_inspect',
      input: { provider: 'openai' },
    });
    expect(connectionWithLimit.agentInstruction).toMatchObject({ action: 'continue' });

    const neonConnection = new ConnectionRepository().create({
      provider: 'neon',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'neon-token' }),
    });
    new ConnectionRepository().updateStatus(neonConnection.id, 'verified');
    vi.spyOn(NeonAdapter.prototype, 'connect').mockResolvedValue();
    const inspectDatabase = vi.spyOn(NeonAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'neon-project-1',
        engine: 'postgres',
        name: 'selected-db',
        status: 'ready',
        providerScope: { projectId: 'neon-project-1', organizationId: 'org-1' },
      }],
      truncated: false,
      partial: false,
    });
    const selectedDatabase = await t.call('hv_inspect', {
      provider: 'neon',
      project: project.name,
      env: 'staging',
      resource: 'database',
      name: 'selected-db',
    });
    expect(selectedDatabase.ok).toBe(true);
    expect(selectedDatabase.data).toMatchObject({
      provider: 'neon',
      mode: 'database',
      project: project.name,
      environment: 'staging',
      observed: null,
      binding: 'missing',
      inventory: { databases: [{ id: 'neon-project-1', name: 'selected-db' }] },
    });
    expect(inspectDatabase).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'database',
      name: 'selected-db',
    }));
    await t.close();
  });

  it('hv_inspect exposes bounded provider domain verification for a selected environment', async () => {
    const project = new ProjectRepository().create({ name: 'inspect-domain-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 'env-prod' },
    });
    createRailwayConnection(true);
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'observe').mockResolvedValue({
      provider: 'railway',
      observedAt: '2026-08-07T00:00:00.000Z',
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'env-prod',
      services: [observedService({
        id: 'svc-web',
        name: 'web',
        url: 'https://web-production.up.railway.app',
        customDomains: ['example.com'],
        customDomainStatus: {
          'example.com': {
            providerVerified: false,
            dnsConfigured: false,
            dnsRecords: [{
              name: '_railway-verify',
              type: 'TXT',
              value: 'railway-verify=public-token',
              purpose: 'verification',
            }],
          },
        },
      })],
      databases: [],
      partial: false,
      warnings: [],
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'production',
    });

    expect(result.ok).toBe(true);
    expect(result.data.observed.services[0]).toMatchObject({
      customDomains: ['example.com'],
      customDomainStatus: {
        'example.com': {
          providerVerified: false,
          dnsConfigured: false,
          dnsRecords: [expect.objectContaining({ type: 'TXT', purpose: 'verification' })],
        },
      },
    });
    await t.close();
  });

  it('hv_inspect routes GitHub branch reads through the registered provider inspector', async () => {
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'github',
      scope: 'davejohnson/hypervibe',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'token' }),
    });
    repository.updateStatus(connection.id, 'verified');
    vi.spyOn(GitHubAdapter.prototype, 'connect').mockImplementation(() => undefined);
    vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
      ref: 'refs/heads/hypervibe/github-infrastructure',
      object: { sha: 'abc123' },
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'github',
      scope: 'davejohnson/hypervibe',
      resource: 'branch',
      name: 'hypervibe/github-infrastructure',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      provider: 'github',
      mode: 'provider-resource',
      observation: 'present',
      ref: { name: 'refs/heads/hypervibe/github-infrastructure', sha: 'abc123' },
    });
    await t.close();
  });

  it('hv_import without an adoption target points agents to hv_inspect without opening a provider connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_import', { provider: 'railway' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.hint).toContain('hv_inspect');
    expect(result.next).toContain('hv_inspect');
    await t.close();
  });

  it('hv_inspect lists importable Railway projects when no name is given', async () => {
    createRailwayConnection(true);
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'railway' });
    expect(result.ok).toBe(true);
    expect(result.data.projects).toEqual([
      { id: 'rp-1', name: 'demo-app', railwayId: 'rp-1', environmentCount: 1, serviceCount: 1 },
    ]);
    await t.close();
  });

  it('hv_inspect returns raw inspection data with auto-detected mappings without writing local state', async () => {
    createRailwayConnection(true);
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'railway', name: 'demo-app' });
    expect(result.ok).toBe(true);
    expect(result.data.inspected).toBe(true);
    expect(result.data.imported).toBe(false);
    expect(result.data.autoDetected).toEqual({ production: 'production' });
    expect(result.data.needsMapping).toEqual([]);
    expect(result.data.envVarNames).toEqual(['DATABASE_URL']);
    expect(result.data.components).toEqual([]);
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('hv_import without mappings fails and points to hv_inspect', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', { provider: 'railway', name: 'demo-app' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('environmentMappings');
    expect(result.hint).toContain('hv_inspect');
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('hv_import requires confirmation before writing adoption bindings', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(result.error.details.project).toEqual({ name: 'demo-app', id: 'rp-1' });
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('refuses to adopt legacy Railway plugins without a verified teardown contract', async () => {
    createRailwayConnection();
    mockAdapter({
      ...details,
      plugins: {
        edges: [
          { node: { id: 'plugin-postgres', name: 'Postgres' } },
          { node: { id: 'plugin-redis', name: 'Redis' } },
        ],
      },
    });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNSUPPORTED');
    expect(result.error.details.components).toEqual([
      { id: 'plugin-postgres', name: 'Postgres', type: 'postgres' },
      { id: 'plugin-redis', name: 'Redis', type: 'redis' },
    ]);
    expect(result.hint).toContain('service-backed');
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('hv_import performs the import when mappings are provided and confirmed', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data.imported).toBe(true);

    const project = new ProjectRepository().findByName('demo-app');
    expect(project).not.toBeNull();
    expect(project!.defaultPlatform).toBe('railway');

    const env = new EnvironmentRepository().findByProjectAndName(project!.id, 'production');
    expect(env).not.toBeNull();
    const bindings = env!.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId: string; url?: string; customDomains?: string[] }>;
    };
    expect(bindings.projectId).toBe('rp-1');
    expect(bindings.services?.web).toEqual({
      serviceId: 'svc-web',
      url: 'https://web-production.up.railway.app',
      customDomains: ['demo-app.example.com'],
    });

    expect(new ServiceRepository().findByProjectAndName(project!.id, 'web')).not.toBeNull();
    expect(new ComponentRepository().findByEnvironmentAndType(env!.id, 'postgres')).toBeNull();
    await t.close();
  });

  it('validates the complete imported spec before writing any local records', async () => {
    createRailwayConnection();
    const invalidStorageDetails: RailwayProjectDetails = {
      ...details,
      environments: {
        edges: [{
          node: {
            id: 'env-prod',
            name: 'production',
            config: {
              buckets: {
                'bucket-unsupported-region': {
                  region: 'moon-1',
                  isDeleted: false,
                },
              },
            },
          },
        }],
      },
      buckets: {
        edges: [{
          node: {
            id: 'bucket-unsupported-region',
            name: 'uploads',
          },
        }],
      },
    };
    mockAdapter(invalidStorageDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      id: invalidStorageDetails.id,
      environmentMappings: { production: 'production' },
      storageMappings: { 'bucket-unsupported-region': 'uploads' },
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details.reason).toContain('region');
    expect(new ProjectRepository().findByName(details.name)).toBeNull();
    await t.close();
  });

  it('keeps unmapped Railway datastore candidates unmanaged instead of importing them as app services', async () => {
    createRailwayConnection();
    const serviceBackedDetails: RailwayProjectDetails = {
      ...details,
      plugins: { edges: [] },
      services: {
        edges: [
          ...details.services.edges,
          railwayService({ id: 'svc-postgres-unmanaged', name: 'Postgres reporting' }),
        ],
      },
    };
    mockAdapter(serviceBackedDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      id: serviceBackedDetails.id,
      environmentMappings: { production: 'production' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    const project = new ProjectRepository().findByName(details.name)!;
    expect(new ServiceRepository().findByProjectAndName(project.id, 'Postgres reporting')).toBeNull();
    expect(result.data.spec.environments.production.services['Postgres reporting']).toBeUndefined();
    expect(result.data.spec.environments.production.database).toBeUndefined();
    await t.close();
  });

  it('explicitly adopts a service-backed Railway Postgres as a component, not an app service', async () => {
    createRailwayConnection();
    mockAdapter();
    const serviceBackedDetails: RailwayProjectDetails = {
      ...details,
      plugins: { edges: [] },
      services: {
        edges: [
          ...details.services.edges,
          {
            node: {
              id: 'svc-postgres',
              name: 'Postgres',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'env-prod',
                    domains: { serviceDomains: [], customDomains: [] },
                  },
                }],
              },
            },
          },
        ],
      },
    };
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(serviceBackedDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      databaseMappings: { 'svc-postgres': 'postgres' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    const project = new ProjectRepository().findByName('demo-app')!;
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(new ServiceRepository().findByProjectAndName(project.id, 'Postgres')).toBeNull();
    expect(new ComponentRepository().findByEnvironmentAndType(environment.id, 'postgres')).toMatchObject({
      externalId: 'svc-postgres',
      bindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'env-prod',
        providerScope: { projectId: 'rp-1' },
        resourceKind: 'service',
        serviceId: 'svc-postgres',
        pluginName: 'Postgres',
      },
    });
    await t.close();
  });

  it('round-trips explicit Railway Redis adoption as a cache component', async () => {
    createRailwayConnection();
    mockAdapter();
    const serviceBackedDetails: RailwayProjectDetails = {
      ...details,
      plugins: { edges: [] },
      services: {
        edges: [
          ...details.services.edges,
          {
            node: {
              id: 'svc-redis',
              name: 'redis-cache',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'env-prod',
                    domains: { serviceDomains: [], customDomains: [] },
                  },
                }],
              },
            },
          },
        ],
      },
    };
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(serviceBackedDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      cacheMappings: { 'svc-redis': 'redis' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    const project = new ProjectRepository().findByName('demo-app')!;
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(new ServiceRepository().findByProjectAndName(project.id, 'redis-cache')).toBeNull();
    expect(new ComponentRepository().findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      externalId: 'svc-redis',
      bindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'env-prod',
        resourceKind: 'service',
        serviceId: 'svc-redis',
        pluginName: 'redis-cache',
        connectionUrl: '${{redis-cache.REDIS_URL}}',
      },
    });
    await t.close();
  });

  it.each([
    {
      label: 'legacy plugin databases, caches, and each service workload shape',
      projectDetails: {
        id: 'rp-legacy',
        name: 'legacy-shapes',
        environments: {
          edges: [{ node: { id: 'env-prod', name: 'production' } }],
        },
        services: {
          edges: [
            railwayService({
              id: 'svc-web',
              name: 'web',
              domain: 'legacy-shapes.up.railway.app',
              startCommand: 'npm start',
              releaseCommand: 'npm run migrate',
              healthCheckPath: '/health',
            }),
            railwayService({
              id: 'svc-worker',
              name: 'worker',
              startCommand: 'npm run worker',
            }),
            railwayService({
              id: 'svc-cron',
              name: 'cron',
              startCommand: 'npm run cron',
              cronSchedule: '*/5 * * * *',
            }),
          ],
        },
        plugins: {
          edges: [
            { node: { id: 'plugin-postgres', name: 'Postgres' } },
            { node: { id: 'plugin-redis', name: 'Redis' } },
          ],
        },
      } satisfies RailwayProjectDetails,
      importArgs: {},
      observed: {
        provider: 'railway',
        observedAt: '2026-07-30T00:00:00.000Z',
        projectExists: true,
        projectId: 'rp-legacy',
        environmentId: 'env-prod',
        services: [
          observedService({
            id: 'svc-web',
            name: 'web',
            url: 'https://legacy-shapes.up.railway.app',
            startCommand: 'npm start',
            releaseCommand: 'npm run migrate',
            healthCheckPath: '/health',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
          observedService({
            id: 'svc-worker',
            name: 'worker',
            startCommand: 'npm run worker',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
          observedService({
            id: 'svc-cron',
            name: 'cron',
            workloadKind: 'cron',
            startCommand: 'npm run cron',
            cronSchedule: '*/5 * * * *',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
        ],
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'plugin-postgres',
          providerScope: { projectId: 'rp-legacy' },
          name: 'Postgres',
          status: 'unknown',
        }],
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'plugin-redis',
          providerScope: { projectId: 'rp-legacy' },
          name: 'Redis',
          status: 'unknown',
        }],
        storage: [],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'complete',
          databases: 'complete',
          caches: 'complete',
          storage: 'complete',
        },
        partial: false,
        warnings: [],
      } satisfies ObservedState,
      expectedServices: ['cron', 'web', 'worker'],
      expectedStorage: [],
      expectedUnsupported: true,
    },
    {
      label: 'service-backed datastores and explicitly mapped object storage',
      projectDetails: {
        id: 'rp-service-backed',
        name: 'service-backed-shapes',
        environments: {
          edges: [{
            node: {
              id: 'env-prod',
              name: 'production',
              config: { buckets: { 'bucket-uploads': { region: 'sjc', isDeleted: false } } },
            },
          }],
        },
        services: {
          edges: [
            railwayService({
              id: 'svc-web',
              name: 'web',
              domain: 'service-backed-shapes.up.railway.app',
              startCommand: 'npm start',
            }),
            railwayService({ id: 'svc-postgres', name: 'Postgres' }),
            railwayService({ id: 'svc-redis', name: 'redis-cache' }),
          ],
        },
        plugins: { edges: [] },
        buckets: {
          edges: [{ node: { id: 'bucket-uploads', name: 'provider-upload-bucket' } }],
        },
      } satisfies RailwayProjectDetails,
      importArgs: {
        databaseMappings: { 'svc-postgres': 'postgres' },
        cacheMappings: { 'svc-redis': 'redis' },
        storageMappings: { 'bucket-uploads': 'uploads' },
      },
      observed: {
        provider: 'railway',
        observedAt: '2026-07-30T00:00:00.000Z',
        projectExists: true,
        projectId: 'rp-service-backed',
        environmentId: 'env-prod',
        services: [
          observedService({
            id: 'svc-web',
            name: 'web',
            url: 'https://service-backed-shapes.up.railway.app',
            startCommand: 'npm start',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
        ],
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'svc-postgres',
          providerScope: { projectId: 'rp-service-backed' },
          name: 'Postgres',
          status: 'running',
        }],
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'svc-redis',
          providerScope: { projectId: 'rp-service-backed', environmentId: 'env-prod' },
          name: 'redis-cache',
          status: 'running',
        }],
        storage: [{
          provider: 'railway',
          kind: 'object',
          externalId: 'bucket-uploads',
          instanceScope: { projectId: 'rp-service-backed', environmentId: 'env-prod' },
          name: 'provider-upload-bucket',
          region: 'sjc',
          status: 'ready',
        }],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'complete',
          databases: 'complete',
          caches: 'complete',
          storage: 'complete',
        },
        partial: false,
        warnings: [],
      } satisfies ObservedState,
      expectedServices: ['web'],
      expectedStorage: ['uploads'],
      expectedUnsupported: false,
    },
  ])('inspect → import → status is mutation-safe for $label', async ({
    projectDetails,
    importArgs,
    observed,
    expectedServices,
    expectedStorage,
    expectedUnsupported,
  }) => {
    createRailwayConnection(true);
    mockAdapter(projectDetails);
    const observe = vi.spyOn(RailwayAdapter.prototype, 'observe').mockResolvedValue(observed);
    const t = await makeFullClient();

    const inspection = await t.call('hv_inspect', {
      provider: 'railway',
      id: projectDetails.id,
    });
    expect(inspection.ok).toBe(true);
    expect(inspection.data.project.id).toBe(projectDetails.id);

    const imported = await t.call('hv_import', {
      provider: 'railway',
      id: projectDetails.id,
      environmentMappings: { production: 'production' },
      ...importArgs,
      confirm: true,
    });
    if (expectedUnsupported) {
      expect(imported.ok).toBe(false);
      expect(imported.error.code).toBe('UNSUPPORTED');
      expect(new ProjectRepository().findByName(projectDetails.name)).toBeNull();
      expect(observe).not.toHaveBeenCalled();
      await t.close();
      return;
    }
    expect(imported.ok).toBe(true);
    expect(imported.data.specRevision).toBe(1);
    expect(Object.keys(imported.data.spec.environments.production.services).sort()).toEqual(expectedServices);
    expect(Object.keys(imported.data.spec.environments.production.storage ?? {}).sort()).toEqual(expectedStorage);

    const status = await t.call('hv_status', {
      project: projectDetails.name,
      env: 'production',
    });
    expect(status.ok).toBe(true);
    expect(status.data.drift.filter((action: { type: string }) =>
      action.type === 'create' || action.type === 'destroy'
    )).toEqual([]);
    expect(status.data.drift).toEqual([]);
    expect(status.data.inSync).toBe(true);

    observe.mockResolvedValue({ ...observed, caches: [] });
    const missingCacheStatus = await t.call('hv_status', {
      project: projectDetails.name,
      env: 'production',
    });
    expect(missingCacheStatus.data.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'update',
        resource: expect.objectContaining({ kind: 'cache', provider: 'railway' }),
        metadata: expect.objectContaining({ blockedReason: 'cache_binding_identity_mismatch' }),
      }),
    ]));

    await t.close();
  });

  it('blocks re-import of an existing Hypervibe project without force', async () => {
    createRailwayConnection();
    mockAdapter();
    new ProjectRepository().create({ name: 'demo-app' });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      confirm: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('already exists');
    await t.close();
  });

  it('hv_inspect does not guess when multiple Railway projects share an import name', async () => {
    createRailwayConnection(true);
    mockAdapter();
    vi.spyOn(RailwayAdapter.prototype, 'findProjectsByName').mockResolvedValue([
      { id: 'rp-1', name: 'demo-app' },
      { id: 'rp-2', name: 'demo-app' },
    ]);
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'railway', name: 'demo-app' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('Multiple Railway resources matched');
    expect(result.error.details.projects).toEqual([
      { name: 'demo-app', id: 'rp-1' },
      { name: 'demo-app', id: 'rp-2' },
    ]);
    expect(result.hint).toContain('id');
    await t.close();
  });

  it('force re-adopts a selected Railway project into an existing Hypervibe project', async () => {
    createRailwayConnection();
    mockAdapter();
    const existing = new ProjectRepository().create({ name: 'demo-app', defaultPlatform: 'cloudrun' });
    new EnvironmentRepository().create({
      projectId: existing.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'old-rp' },
    });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      id: 'rp-1',
      force: true,
      environmentMappings: { production: 'production' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data.imported).toBe(true);
    expect(result.data.project.id).toBe(existing.id);
    const project = new ProjectRepository().findById(existing.id);
    expect(project?.defaultPlatform).toBe('railway');
    const env = new EnvironmentRepository().findByProjectAndName(existing.id, 'production');
    expect(env?.platformBindings).toMatchObject({
      provider: 'railway',
      projectId: 'rp-1',
      environmentId: 'env-prod',
      services: { web: { serviceId: 'svc-web' } },
    });
    expect(new ServiceRepository().findByProjectAndName(existing.id, 'web')).not.toBeNull();
    await t.close();
  });
});
