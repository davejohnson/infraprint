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
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { StripeAdapter } from '../../adapters/providers/stripe/stripe.adapter.js';
import { createToolContext } from '../../application/context.js';
import { registerHvObservabilityTools } from '../hv-observability.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import '../../adapters/providers/railway/railway.adapter.js';

let tempDir: string;

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-obs-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-obs-test', version: '1.0.0' });
  registerHvObservabilityTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-obs-test-client', version: '1.0.0' });
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

describe('hv_logs', () => {
  it('returns project-scoped hosting setup before reading provider logs', async () => {
    const project = new ProjectRepository().create({
      name: 'provider-logs-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/provider-logs-app',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', services: { web: { serviceId: 'svc-web' } } },
    });
    const t = await makeClient();
    const result = await t.call('hv_logs', { project: project.name, env: 'staging', source: 'service' });

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'railway',
      project: project.name,
      scope: 'davejohnson/provider-logs-app',
    });
    await t.close();
  });

  it('returns a provider error with the failed operation and network cause', async () => {
    const project = new ProjectRepository().create({
      name: 'provider-error-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
        services: { worker: { serviceId: 'service-1' } },
      },
    });
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND backboard.railway.app'), {
      code: 'ENOTFOUND',
    });
    const fetchError = Object.assign(new TypeError('fetch failed'), { cause });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        getDeployments: vi.fn(async () => { throw fetchError; }),
        getDeploymentLogs: vi.fn(),
      } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      service: 'worker',
      source: 'service',
      errorsOnly: true,
      limit: 50,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PROVIDER_ERROR',
        details: {
          provider: 'railway',
          operation: 'latest deployment lookup',
          message: 'fetch failed',
          cause: 'getaddrinfo ENOTFOUND backboard.railway.app',
          causeCode: 'ENOTFOUND',
        },
      },
    });
    expect(result.error.message).toContain('railway latest deployment lookup failed');
    await t.close();
  });

  it('returns environment-scoped Stripe setup before reading webhook status', async () => {
    const project = new ProjectRepository().create({ name: 'stripe-setup-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', services: {} },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          payments: {
            stripe: {
              services: ['web'],
              credentials: { secretKeyEnvVar: 'STRIPE_SECRET_KEY' },
            },
          },
        },
      },
    }));
    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
    });

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'stripe',
      project: project.name,
      scope: 'staging',
    });
    await t.close();
  });

  it('errors when the environment is missing', async () => {
    new ProjectRepository().create({ name: 'obs-app' });
    const t = await makeClient();
    const result = await t.call('hv_logs', { project: 'obs-app', env: 'staging', source: 'service' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });

  it('hints at hv_apply when no services are bound', async () => {
    const project = new ProjectRepository().create({ name: 'obs-empty-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: {} },
    });
    const t = await makeClient();
    const result = await t.call('hv_logs', { project: 'obs-empty-app', env: 'staging', source: 'service' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.hint).toContain('hv_apply');
    await t.close();
  });

  it('reports stripe-webhooks errors as structured envelopes', async () => {
    const t = await makeClient();
    const result = await t.call('hv_logs', { source: 'stripe-webhooks' });
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('Stripe');
    await t.close();
  });

  it('reads Stripe webhooks through the selected environment-scoped connection', async () => {
    const project = new ProjectRepository().create({ name: 'stripe-observability-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', services: {} },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          payments: {
            stripe: {
              environment: 'production',
              services: ['web'],
              credentials: { secretKeyEnvVar: 'STRIPE_SECRET_KEY' },
            },
          },
        },
      },
    }));

    const connections = new ConnectionRepository();
    const global = connections.create({
      provider: 'stripe',
      credentialsEncrypted: getSecretStore().encryptObject({ secretKey: 'sk_test_global' }),
    });
    connections.updateStatus(global.id, 'verified');
    const production = connections.create({
      provider: 'stripe',
      scope: 'production',
      credentialsEncrypted: getSecretStore().encryptObject({ secretKey: 'sk_live_production' }),
    });
    connections.updateStatus(production.id, 'verified');
    const listWebhooks = vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([{
      id: 'we_live',
      url: 'https://example.com/stripe',
      status: 'enabled',
      enabled_events: ['invoice.paid'],
      created: 1,
      description: 'Production webhook',
      metadata: {},
    }]);

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
      mode: 'live',
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      project: project.name,
      environment: 'staging',
      stripeEnvironment: 'production',
      mode: 'live',
      webhooks: [{ id: 'we_live', enabledEvents: 1 }],
    });
    expect(listWebhooks).toHaveBeenCalledWith('live');

    const mismatch = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
      mode: 'sandbox',
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error.code).toBe('VALIDATION');

    const foreignSelector = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
      service: 'web',
    });
    expect(foreignSelector.ok).toBe(true);
    expect(foreignSelector.warnings).toEqual([
      'Ignored option for hv_logs source="stripe-webhooks": service. The requested read still completed.',
    ]);
    await t.close();
  });

  it('uses limit as a build-log tail and warns instead of failing on harmless extra selectors', async () => {
    const project = new ProjectRepository().create({
      name: 'build-log-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
        services: { web: { serviceId: 'service-1' } },
      },
    });
    const readProviderBuildLogs = vi.fn(async () => ({
      deploymentId: 'deployment-1',
      buildLogs: 'install\nbuild\ntest\ndeploy',
    }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { readProviderBuildLogs } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      service: 'web',
      source: 'build',
      deploymentId: 'deployment-1',
      limit: 2,
      errorsOnly: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      source: 'build',
      deploymentId: 'deployment-1',
      buildLogs: 'test\ndeploy',
      lineCount: 4,
      returnedLines: 2,
      truncated: true,
    });
    expect(result.warnings).toEqual([
      'Ignored option for hv_logs source="build": errorsOnly. The requested read still completed.',
    ]);
    expect(readProviderBuildLogs).toHaveBeenCalledWith(expect.objectContaining({
      serviceName: 'web',
      deploymentId: 'deployment-1',
    }));
    await t.close();
  });

  it('does not count a build log terminal newline as an empty tail line', async () => {
    const project = new ProjectRepository().create({
      name: 'newline-build-log-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
        services: { web: { serviceId: 'service-1' } },
      },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        readProviderBuildLogs: vi.fn(async () => ({
          deploymentId: 'deployment-1',
          buildLogs: 'install\nbuild\n',
        })),
      } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'build',
      limit: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      buildLogs: 'build',
      lineCount: 2,
      returnedLines: 1,
      truncated: true,
    });
    await t.close();
  });

  it('applies errorsOnly to Railway service logs and forwards limit', async () => {
    const project = new ProjectRepository().create({
      name: 'filtered-service-log-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
        services: { web: { serviceId: 'service-1' } },
      },
    });
    const readProviderLogs = vi.fn(async () => ({
      deploymentId: 'deployment-1',
      deploymentStatus: 'SUCCESS',
      logs: [
        { timestamp: '2026-09-03T00:00:00.000Z', severity: 'info', message: 'listening' },
        { timestamp: '2026-09-03T00:00:01.000Z', severity: 'error', message: 'request failed' },
        { timestamp: '2026-09-03T00:00:02.000Z', severity: 'warn', message: 'retry failed' },
        { timestamp: '2026-09-03T00:00:03.000Z', severity: 'error', message: 'provider over-returned' },
      ],
    }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { readProviderLogs } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      service: 'web',
      source: 'service',
      limit: 2,
      errorsOnly: true,
    });

    expect(result.ok).toBe(true);
    expect(readProviderLogs).toHaveBeenCalledWith(expect.objectContaining({
      serviceName: 'web',
      limit: 2,
      errorsOnly: true,
    }));
    expect(result.data.logs).toEqual([
      { timestamp: '2026-09-03T00:00:01.000Z', severity: 'error', message: 'request failed' },
      { timestamp: '2026-09-03T00:00:02.000Z', severity: 'warn', message: 'retry failed' },
    ]);
    await t.close();
  });

  it('does not broaden an unknown service selector to all deployments', async () => {
    const project = new ProjectRepository().create({
      name: 'deployment-service-selector-app',
      defaultPlatform: 'railway',
    });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'project-1',
        environmentId: 'environment-1',
        services: { web: { serviceId: 'service-1' } },
      },
    });
    const listProviderDeployments = vi.fn(async () => []);
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { listProviderDeployments } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      service: 'typo',
      source: 'deployments',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'NOT_FOUND',
      details: { available: ['web'] },
    });
    expect(listProviderDeployments).not.toHaveBeenCalled();
    await t.close();
  });
});

describe('hv_health', () => {
  it('checks an explicit URL with mocked fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const t = await makeClient();
    const result = await t.call('hv_health', { url: 'https://example.com/health' });
    expect(result.ok).toBe(true);
    expect(result.data.check.ok).toBe(true);
    expect(result.data.check.status).toBe(200);
    await t.close();
  });

  it('warns when project selectors are irrelevant to an explicit URL health check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const t = await makeClient();
    const result = await t.call('hv_health', {
      url: 'https://example.com/health',
      project: 'ignored-project',
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      'Ignored options for hv_health with explicit url: project, env, service. The requested read still completed.',
    ]);
    await t.close();
  });

  it('surfaces failing checks with a logs hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const t = await makeClient();
    const result = await t.call('hv_health', { url: 'https://example.com/health' });
    expect(result.ok).toBe(true);
    expect(result.data.check.ok).toBe(false);
    expect(result.hint).toContain('hv_logs');
    await t.close();
  });

  it('errors when the service has no URL binding', async () => {
    const project = new ProjectRepository().create({ name: 'health-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'railway', services: {} } });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const t = await makeClient();
    const result = await t.call('hv_health', { project: 'health-app', env: 'staging', service: 'web' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });

  it('checks a repo-backed service without a cached service row or provider connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const project = new ProjectRepository().create({ name: 'fresh-clone-health' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        services: {
          web: { serviceId: 'svc-web', url: 'https://web.example.com' },
        },
      },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {
            web: {
              workloadKind: 'web',
              public: true,
              healthCheckPath: '/healthz',
            },
          },
        },
      },
    }));

    const t = await makeClient();
    const result = await t.call('hv_health', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.service).toBe('web');
    expect(result.data.baseUrl).toBe('https://web.example.com');
    expect(result.data.check.url).toBe('https://web.example.com/healthz');
    expect(result.data.check.ok).toBe(true);
    await t.close();
  });

  it('checks a declared domain without a provider-specific URL binding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const project = new ProjectRepository().create({ name: 'domain-health' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'cloudrun',
        services: {
          web: { serviceId: 'cloudrun-web' },
        },
      },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'cloudrun' },
          services: {
            web: {
              workloadKind: 'web',
              public: true,
              healthCheckPath: '/healthz',
            },
          },
          domain: 'staging.example.com',
        },
      },
    }));

    const t = await makeClient();
    const result = await t.call('hv_health', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.baseUrl).toBe('https://staging.example.com');
    expect(result.data.check.url).toBe('https://staging.example.com/healthz');
    await t.close();
  });

  it('surfaces production deployment failures after a successful staging endpoint check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const project = new ProjectRepository().create({
      name: 'cross-environment-health',
      defaultPlatform: 'railway',
    });
    for (const environment of ['staging', 'production']) {
      new EnvironmentRepository().create({
        projectId: project.id,
        name: environment,
        platformBindings: {
          provider: 'railway',
          services: {
            web: {
              serviceId: `${environment}-web`,
              url: `https://${environment}.example.com`,
            },
            worker: { serviceId: `${environment}-worker` },
          },
        },
      });
    }
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: Object.fromEntries(['staging', 'production'].map((environment) => [
        environment,
        {
          hosting: { provider: 'railway' },
          services: {
            web: { workloadKind: 'web', public: true, healthCheckPath: '/health' },
            worker: { workloadKind: 'worker' },
          },
          deploy: environment === 'production'
            ? { strategy: 'manual' }
            : { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      ])),
    }));
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        getDeployStatus: async (_environment: unknown, serviceId: string) => ({
          status: serviceId.startsWith('production-') ? 'CRASHED' : 'deployed',
        }),
      } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_health', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.check.ok).toBe(true);
    expect(result.data.deploymentHealth.state).toBe('failed');
    expect(result.data.deploymentHealth.failures).toEqual([
      { environment: 'production', provider: 'railway', service: 'web', status: 'CRASHED' },
      { environment: 'production', provider: 'railway', service: 'worker', status: 'CRASHED' },
    ]);
    expect(result.hint).toContain('production/web');
    await t.close();
  });
});
