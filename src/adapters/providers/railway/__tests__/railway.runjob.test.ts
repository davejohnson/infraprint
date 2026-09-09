import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { buildTaskStartCommand, RailwayAdapter, TASK_EXIT_SENTINEL } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

vi.mock('../../github/package-pull.js', () => ({
  githubPackagePullCredentials: vi.fn(() => ({ username: 'dave', token: 'ghp_read' })),
}));

import { githubPackagePullCredentials } from '../../github/package-pull.js';

const environment = {
  id: 'env-1',
  name: 'production',
  platformBindings: {
    provider: 'railway',
    projectId: 'proj-1',
    environmentId: 'railenv-1',
    services: { web: { serviceId: 'src-svc-1' } },
  },
} as unknown as Environment;

const webService = { id: 'svc-local', name: 'web', buildConfig: {} } as unknown as Service;

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Fake GraphQL client dispatching on operation name. Overrides let each test
 * replace individual operations (e.g. sentinel logs, crash status).
 */
function fakeClient(overrides: Record<string, (variables: Record<string, unknown>, call: number) => unknown> = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const deletedServiceInstances = new Set<string>();
  const serviceInstanceKey = (serviceId: unknown, environmentId: unknown) =>
    `${String(serviceId)}:${String(environmentId)}`;
  const defaults: Record<string, (variables: Record<string, unknown>, call: number) => unknown> = {
    GetProjectServicesConnection: () => ({ project: { services: { edges: [{ node: { id: 'src-svc-1', name: 'web' } }] } } }),
    GetServiceEnvironmentInstance: (variables) => ({
      serviceInstance: deletedServiceInstances.has(serviceInstanceKey(variables.serviceId, variables.environmentId))
        ? null
        : {
            id: `instance-${String(variables.serviceId)}`,
            serviceId: variables.serviceId,
            environmentId: variables.environmentId,
          },
    }),
    GetServiceInstanceInventory: (variables) => ({
      service: deletedServiceInstances.has(serviceInstanceKey(variables.serviceId, 'railenv-1'))
        ? null
        : {
            id: variables.serviceId,
            projectId: 'proj-1',
            serviceInstances: {
              edges: [{ node: { id: `instance-${String(variables.serviceId)}`, environmentId: 'railenv-1' } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
    }),
    TaskSourceInstance: () => ({ serviceInstance: { source: { image: 'ghcr.io/dave/app:sha1' } } }),
    GetVariables: () => ({ variables: { DATABASE_URL: 'postgresql://internal', RAILWAY_TOKEN_INJECTED: 'x', SESSION_SECRET: 's' } }),
    CreateTaskService: () => ({ serviceCreate: { id: 'task-svc-1', name: 'hv-task-x' } }),
    ConfigureTaskService: () => ({ serviceInstanceUpdate: true }),
    DeployTaskService: () => ({ serviceInstanceDeployV2: 'dep-1' }),
    TaskDeploymentStatus: () => ({ deployment: { status: 'SUCCESS' } }),
    GetLogs: () => ({ deploymentLogs: [
      { timestamp: 't', message: 'seeding...', severity: 'info' },
      { timestamp: 't', message: '__HYPERVIBE_TASK_EXIT:0__', severity: 'info' },
    ] }),
    serviceDelete: (variables) => {
      if (variables.environmentId !== 'railenv-1') {
        throw new Error('Expected environment-scoped service deletion');
      }
      return { serviceDelete: true };
    },
  };
  const request = vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
    const text = String(query);
    const key = Object.keys({ ...defaults, ...overrides }).find((name) => text.includes(name));
    if (!key) throw new Error(`Unexpected query in test: ${text.slice(0, 120)}`);
    calls.push({ query: key, variables });
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const handler = overrides[key] ?? defaults[key];
    const result = await handler(variables, n);
    if (
      key === 'serviceDelete'
      && result
      && typeof result === 'object'
      && (result as { serviceDelete?: unknown }).serviceDelete
    ) {
      deletedServiceInstances.add(serviceInstanceKey(variables.id, variables.environmentId));
    }
    return result;
  });
  return { request, calls };
}

function adapterWith(client: { request: ReturnType<typeof vi.fn> }): RailwayAdapter {
  const adapter = new RailwayAdapter();
  (adapter as unknown as { client: unknown }).client = client;
  return adapter;
}

const fastOptions = { timeoutMs: 2000, pollIntervalMs: 1 };

describe('buildTaskStartCommand', () => {
  function run(command: string) {
    return spawnSync('/bin/sh', ['-c', buildTaskStartCommand(command)], { encoding: 'utf8' });
  }

  it('emits a parseable zero exit sentinel', () => {
    const result = run('node -e "process.exit(0)"');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(TASK_EXIT_SENTINEL);
    expect(result.stdout.match(TASK_EXIT_SENTINEL)?.[1]).toBe('0');
  });

  it('round-trips a non-zero exit code through the sentinel', () => {
    const result = run('node -e "process.exit(3)"');

    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(TASK_EXIT_SENTINEL);
    expect(result.stdout.match(TASK_EXIT_SENTINEL)?.[1]).toBe('3');
  });

  it('handles commands containing single quotes', () => {
    const result = run('node -e "console.log(\'single quote ok\')"');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('single quote ok');
    expect(result.stdout.match(TASK_EXIT_SENTINEL)?.[1]).toBe('0');
  });
});

describe('RailwayAdapter.runJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the command in a temp service and cleans it up', async () => {
    const client = fakeClient();
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.runner).toBe('railway-temp-service');
    expect(result.jobId).toBe('dep-1');
    expect(result.output).toContain('seeding...');
    expect(result.output).not.toContain('__HYPERVIBE_TASK_EXIT');
    expect(result.cleanupWarning).toBeUndefined();

    const sequence = client.calls.map((call) => call.query);
    expect(sequence.slice(0, 6)).toEqual([
      'GetProjectServicesConnection', 'GetServiceEnvironmentInstance',
      'TaskSourceInstance', 'GetVariables', 'CreateTaskService', 'ConfigureTaskService',
    ]);
    expect(sequence).toContain('DeployTaskService');
    expect(sequence).toContain('serviceDelete');

    const create = client.calls.find((call) => call.query === 'CreateTaskService')!;
    const createInput = create.variables.input as Record<string, unknown>;
    expect(createInput.name).toMatch(/^hv-task-/);
    // RAILWAY_* provider-injected vars are not copied to the temp service.
    expect(createInput.variables).toEqual({ DATABASE_URL: 'postgresql://internal', SESSION_SECRET: 's' });

    const configure = client.calls.find((call) => call.query === 'ConfigureTaskService')!;
    const configureInput = configure.variables.input as Record<string, unknown>;
    expect(configureInput.restartPolicyType).toBe('NEVER');
    expect(configureInput.restartPolicyMaxRetries).toBe(0);
    expect(configureInput.source).toEqual({ image: 'ghcr.io/dave/app:sha1' });
    // ghcr image → pull credentials from the GitHub connection.
    expect(configureInput.registryCredentials).toEqual({ username: 'dave', password: 'ghp_read' });
    expect(String(configureInput.startCommand)).toContain('npm run db:seed');
    expect(String(configureInput.startCommand)).toContain('__HYPERVIBE_TASK_EXIT:');
    expect(githubPackagePullCredentials).toHaveBeenCalled();
  });

  it('deletes leftover hv-task services before starting a new task', async () => {
    const client = fakeClient({
      GetProjectServicesConnection: () => ({
        project: {
          services: {
            edges: [
              { node: { id: 'src-svc-1', name: 'web' } },
              { node: { id: 'old-task-1', name: 'hv-task-123' } },
            ],
          },
        },
      }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('completed');
    const deleteCalls = client.calls.filter((call) => call.query === 'serviceDelete');
    expect(deleteCalls.map((call) => call.variables)).toEqual([
      { id: 'old-task-1', environmentId: 'railenv-1' },
      { id: 'task-svc-1', environmentId: 'railenv-1' },
    ]);
  });

  it('returns a warning when the pre-run hv-task sweep cannot delete an orphan', async () => {
    const client = fakeClient({
      GetProjectServicesConnection: () => ({
        project: { services: { edges: [{ node: { id: 'old-task-1', name: 'hv-task-123' } }] } },
      }),
      serviceDelete: (variables) => {
        if (variables.id === 'old-task-1') {
          return { serviceDelete: false };
        }
        return { serviceDelete: true };
      },
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('completed');
    expect(result.cleanupWarning).toContain('Could not delete leftover Railway task service');
    expect(result.cleanupWarning).toContain('old-task-1');
  });

  it('fails immediately when logs contain a malformed sentinel', async () => {
    const client = fakeClient({
      TaskDeploymentStatus: () => ({ deployment: { status: 'SUCCESS' } }),
      GetLogs: () => ({ deploymentLogs: [{ timestamp: 't', message: '__HYPERVIBE_TASK_EXIT:', severity: 'error' }] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(String(result.receipt.message)).toContain('malformed exit sentinel');
    expect(String(result.receipt.error)).toContain('no parseable exit code');
    expect(client.calls.filter((call) => call.query === 'TaskDeploymentStatus')).toHaveLength(1);
    expect(client.calls.map((call) => call.query)).toContain('serviceDelete');
  });

  it('reports a non-zero exit sentinel as failed with the exit code', async () => {
    const client = fakeClient({
      GetLogs: () => ({ deploymentLogs: [{ timestamp: 't', message: '__HYPERVIBE_TASK_EXIT:3__', severity: 'error' }] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.receipt.success).toBe(false);
    expect(client.calls.map((call) => call.query)).toContain('serviceDelete');
  });

  it('reports timeout when no sentinel appears, still deleting the temp service', async () => {
    const client = fakeClient({
      TaskDeploymentStatus: () => ({ deployment: { status: 'DEPLOYING' } }),
      GetLogs: () => ({ deploymentLogs: [{ timestamp: 't', message: 'still building', severity: 'info' }] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', { timeoutMs: 20, pollIntervalMs: 1 });

    expect(result.status).toBe('timeout');
    expect(result.receipt.success).toBe(false);
    expect(client.calls.map((call) => call.query)).toContain('serviceDelete');
  });

  it('treats CRASHED before any sentinel as a container start failure', async () => {
    const client = fakeClient({
      TaskDeploymentStatus: () => ({ deployment: { status: 'CRASHED' } }),
      GetLogs: () => ({ deploymentLogs: [] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeUndefined();
    expect(String(result.receipt.error)).toContain('failed to start');
  });

  it('surfaces a cleanup warning when the temp service cannot be deleted', async () => {
    const client = fakeClient({
      serviceDelete: () => { throw new Error('boom'); },
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    // Task result is preserved; cleanup failure is a warning, not an error.
    expect(result.status).toBe('completed');
    expect(result.cleanupWarning).toContain('task-svc-1');
  });

  it('fails fast with deploy-first guidance when the source service has no image', async () => {
    const client = fakeClient({
      TaskSourceInstance: () => ({ serviceInstance: { source: null } }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(String(result.receipt.error)).toContain('Deploy it first');
    expect(client.calls.map((call) => call.query)).not.toContain('CreateTaskService');
  });
});
