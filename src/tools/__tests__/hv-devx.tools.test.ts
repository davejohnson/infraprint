import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { createToolContext } from '../../application/context.js';
import { registerHvDevxTools } from '../hv-devx.tools.js';
import { CommandRegistry } from '../../application/commands.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-devx-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-devx-test', version: '1.0.0' });
  registerHvDevxTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-devx-test-client', version: '1.0.0' });
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

async function seedRuns() {
  const project = new ProjectRepository().create({ name: 'devx-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
  const runRepo = new RunRepository();
  const older = runRepo.create({ projectId: project.id, environmentId: environment.id, type: 'deploy', plan: { step: 'one' } });
  runRepo.updateStatus(older.id, 'succeeded');
  // created_at has millisecond precision; ensure a strict ordering between the two runs.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = runRepo.create({ projectId: project.id, environmentId: environment.id, type: 'deploy', plan: { step: 'two' } });
  runRepo.updateStatus(newer.id, 'failed', 'boom');
  return { project, environment, older, newer };
}

describe('hv_runs', () => {
  it('lists seeded runs with the latest run surfaced first', async () => {
    const { newer } = await seedRuns();
    const t = await makeClient();

    const list = await t.call('hv_runs', { project: 'devx-app' });
    expect(list.ok).toBe(true);
    expect(list.data.count).toBe(2);
    expect(list.data.latest.id).toBe(newer.id);
    expect(list.data.latest.status).toBe('failed');
    expect(list.data.runs[0]).toMatchObject({
      id: newer.id,
      type: 'deploy',
      status: 'failed',
      project: 'devx-app',
      environment: 'staging',
      error: 'boom',
    });
    expect(list.hint).toContain(newer.id);
    await t.close();
  });

  it('hard-bounds run and audit output when a repository over-returns', async () => {
    const { project, newer, older } = await seedRuns();
    const findByProjectId = vi.spyOn(RunRepository.prototype, 'findByProjectId')
      .mockReturnValue([newer, older]);
    const eventOne = new AuditRepository().create({
      action: 'one',
      resourceType: 'run',
      resourceId: newer.id,
    });
    const eventTwo = new AuditRepository().create({
      action: 'two',
      resourceType: 'run',
      resourceId: older.id,
    });
    const findRecent = vi.spyOn(AuditRepository.prototype, 'findRecent')
      .mockReturnValue([eventOne, eventTwo]);
    const t = await makeClient();

    const runs = await t.call('hv_runs', { project: project.name, limit: 1 });
    const audit = await t.call('hv_runs', { action: 'audit', limit: 1 });

    expect(runs.data.runs).toHaveLength(1);
    expect(runs.data.count).toBe(1);
    expect(audit.data.events).toHaveLength(1);
    expect(audit.data.count).toBe(1);
    expect(findByProjectId).toHaveBeenCalledWith(project.id, 1);
    expect(findRecent).toHaveBeenCalledWith(1);
    await t.close();
  });

  it('gets a single run with plan and receipts', async () => {
    const { older } = await seedRuns();
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: older.id });
    expect(get.ok).toBe(true);
    expect(get.data.run.id).toBe(older.id);
    expect(get.data.run.status).toBe('succeeded');
    expect(get.data.run.plan).toEqual({ step: 'one' });
    expect(get.data.run.receipts).toEqual([]);

    const missing = await t.call('hv_runs', { action: 'get', runId: '00000000-0000-0000-0000-000000000000' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('NOT_FOUND');

    const noId = await t.call('hv_runs', { action: 'get' });
    expect(noId.ok).toBe(false);
    expect(noId.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('warns instead of rejecting a harmless limit on one run lookup', async () => {
    const { older } = await seedRuns();
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: older.id, limit: 1 });

    expect(get.ok).toBe(true);
    expect(get.data.run.id).toBe(older.id);
    expect(get.warnings).toEqual([
      'Ignored option for hv_runs action="get": limit. The requested read still completed.',
    ]);
    await t.close();
  });

  it('constrains run detail to the requested project and environment', async () => {
    const { older } = await seedRuns();
    const otherProject = new ProjectRepository().create({ name: 'other-devx-app' });
    new EnvironmentRepository().create({ projectId: otherProject.id, name: 'production' });
    const t = await makeClient();

    const wrongProject = await t.call('hv_runs', {
      action: 'get',
      runId: older.id,
      project: otherProject.name,
    });
    expect(wrongProject.ok).toBe(false);
    expect(wrongProject.error.code).toBe('NOT_FOUND');

    const wrongEnvironment = await t.call('hv_runs', {
      action: 'get',
      runId: older.id,
      project: 'devx-app',
      env: 'production',
    });
    expect(wrongEnvironment.ok).toBe(false);
    expect(wrongEnvironment.error.code).toBe('NOT_FOUND');

    const constrained = await t.call('hv_runs', {
      action: 'get',
      runId: older.id,
      project: 'devx-app',
      env: 'staging',
    });
    expect(constrained.ok).toBe(true);
    expect(constrained.data.run.id).toBe(older.id);
    await t.close();
  });

  it('redacts secret-bearing run plan fields', async () => {
    const project = new ProjectRepository().create({ name: 'redacted-runs-app' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const run = new RunRepository().create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        overrides: {
          envVarKeys: ['DEBUG'],
          envVarsEncrypted: 'encrypted-debug-value',
          envFileKeys: ['SESSION_SECRET'],
          envFileVarsEncrypted: 'encrypted-env-file-value',
          delegatedSecretKeys: ['AI_API_KEY'],
          delegatedSecretVarsEncrypted: 'encrypted-delegated-value',
          futureCustomEncrypted: 'encrypted-future-value',
          safeMetadata: 'preserved',
        },
        steps: [
          { id: 'legacy', params: { vars: { SECRET_TOKEN: 'plaintext' }, keep: true } },
        ],
      },
    });
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: run.id });
    expect(get.ok).toBe(true);
    expect(get.data.run.plan.overrides).toEqual({
      envVarKeys: ['DEBUG'],
      envFileKeys: ['SESSION_SECRET'],
      delegatedSecretKeys: ['AI_API_KEY'],
      safeMetadata: 'preserved',
    });
    expect(get.data.run.plan.steps[0].params.vars).toEqual({ SECRET_TOKEN: '***' });
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-debug-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-env-file-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-delegated-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('encrypted-future-value');
    expect(JSON.stringify(get.data.run.plan)).not.toContain('plaintext');
    await t.close();
  });

  it('lists audit events via action="audit"', async () => {
    new AuditRepository().create({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: 'run-1',
      details: { foo: 'bar' },
    });
    const t = await makeClient();

    const audit = await t.call('hv_runs', { action: 'audit', auditAction: 'deploy.started' });
    expect(audit.ok).toBe(true);
    expect(audit.data.count).toBe(1);
    expect(audit.data.events[0]).toMatchObject({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: 'run-1',
      details: { foo: 'bar' },
    });

    const projectSelector = await t.call('hv_runs', {
      action: 'audit',
      project: 'devx-app',
    });
    expect(projectSelector.ok).toBe(false);
    expect(projectSelector.error.code).toBe('VALIDATION');

    const incompleteResource = await t.call('hv_runs', {
      action: 'audit',
      resourceType: 'run',
    });
    expect(incompleteResource.ok).toBe(false);
    expect(incompleteResource.error.code).toBe('VALIDATION');

    const conflictingFilters = await t.call('hv_runs', {
      action: 'audit',
      resourceType: 'run',
      resourceId: 'run-1',
      auditAction: 'deploy.started',
    });
    expect(conflictingFilters.ok).toBe(false);
    expect(conflictingFilters.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('rejects action-specific selectors and unbounded limits', async () => {
    const t = await makeClient();

    const runIdOnList = await t.call('hv_runs', { action: 'list', runId: 'run-1' });
    expect(runIdOnList.ok).toBe(false);
    expect(runIdOnList.error.code).toBe('VALIDATION');

    const environmentWithoutProject = await t.call('hv_runs', { action: 'list', env: 'staging' });
    expect(environmentWithoutProject.ok).toBe(false);
    expect(environmentWithoutProject.error.code).toBe('VALIDATION');

    const auditFilterOnGet = await t.call('hv_runs', {
      action: 'get',
      runId: 'run-1',
      auditAction: 'deploy.started',
    });
    expect(auditFilterOnGet.ok).toBe(false);
    expect(auditFilterOnGet.error.code).toBe('VALIDATION');

    const registry = new CommandRegistry();
    registerHvDevxTools(registry, createToolContext());
    const excessiveLimit = await registry.execute('hv_runs', { limit: 101 });
    expect(excessiveLimit.ok).toBe(false);
    expect(excessiveLimit.error?.code).toBe('VALIDATION');
    await t.close();
  });
});
