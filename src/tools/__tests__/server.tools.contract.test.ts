import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { HYPERVIBE_VERSION } from '../../version.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';
import { PRESENTED_COMMAND_IDS } from '../../application/presentation.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-server-contract-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.unstubAllEnvs();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

/** The pinned tool surface. Changing it is a deliberate, reviewed act. */
const EXPECTED_TOOLS = [
  // Core spec/plan/apply loop
  'hv_spec', 'hv_plan', 'hv_apply', 'hv_status', 'hv_inspect', 'hv_import', 'hv_destroy',
  // Connections
  'hv_connections',
  // Deploy + observability
  'hv_deploy', 'hv_rollback', 'hv_logs', 'hv_health',
  // Database
  'hv_db_query',
  // Secrets
  'hv_secrets',
  // CI
  'hv_ci_status', 'hv_ci_trigger',
  // App Store / iOS
  'hv_appstore_status', 'hv_appstore_submit',
  // DevX
  'hv_runs',
  // Hypervibe cloud
  'hv_cloud_pair',
].sort();

async function makeClient(workspaceRoot?: string) {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client(
    { name: 'server-contract-client', version: '1.0.0' },
    workspaceRoot ? { capabilities: { roots: {} } } : undefined
  );
  if (workspaceRoot) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(workspaceRoot).href, name: path.basename(workspaceRoot) }],
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('server tool surface', () => {
  it('identifies the MCP server with the package version', async () => {
    const { client, server } = await makeClient();
    expect(client.getServerVersion()).toEqual({
      name: 'hypervibe',
      version: HYPERVIBE_VERSION,
    });
    await client.close();
    await server.close();
  });

  it('registers exactly the 20 pinned hv_* tools', async () => {
    const { client, server } = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    expect(names).toHaveLength(20);
    expect(tools.find((tool) => tool.name === 'hv_ci_status')?.description).toContain(
      'Use this instead of gh, GitHub connectors/apps, browser/UI inspection, or direct CI/provider API calls.'
    );
    expect(tools.find((tool) => tool.name === 'hv_ci_trigger')?.description).toContain(
      'The only supported dispatch path'
    );
    expect(names).not.toContain('hv_db_migrate');
    expect(tools.find((tool) => tool.name === 'hv_logs')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'hv_apply')?.annotations?.readOnlyHint).toBe(false);
    await client.close();
    await server.close();
  });

  it('returns structured validation errors for unknown MCP arguments instead of dropping them', async () => {
    const { client, server } = await makeClient();
    const result = await client.callTool({
      name: 'hv_logs',
      arguments: { source: 'service', limti: 1 },
    });
    const body = parseToolEnvelope(result);

    expect(body).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(JSON.stringify(body.error?.details)).toContain('limti');
    expect(result.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it('keeps registry, MCP ids, and friendly CLI routes in one-to-one parity', async () => {
    const registry = createCommandRegistry(createCommandContext());
    const definitions = registry.list();
    const ids = definitions.map((definition) => definition.id).sort();
    const cliPaths = definitions.map((definition) => definition.cliPath.join(' '));

    expect(ids).toEqual(EXPECTED_TOOLS);
    expect([...PRESENTED_COMMAND_IDS].sort()).toEqual(ids);
    expect(new Set(cliPaths).size).toBe(20);
    expect(registry.get('hv_spec')?.cliPath).toEqual(['spec']);
    expect(registry.get('hv_connections')?.cliPath).toEqual(['connections']);
    expect(registry.get('hv_secrets')?.cliPath).toEqual(['secrets']);
    expect(registry.get('hv_connections')?.inputShape.project).toBeDefined();
    expect(registry.get('hv_connections')?.inputShape.adminAuth.description).toContain(
      'Google Application Default Credentials'
    );
    expect(registry.get('hv_connections')?.inputShape.memorystoreAccess.description).toContain(
      'roles/redis.viewer'
    );
    expect(registry.get('hv_connections')?.inputShape.queueAccess.description).toContain(
      'remove that exact role'
    );
    expect(registry.get('hv_secrets')?.inputShape.project).toBeDefined();
    expect(registry.get('hv_spec')?.inputShape.project.description).toContain('typos can be corrected safely');
    expect(registry.get('hv_connections')?.description).toContain('{} lists every connection/provider');
    expect(registry.get('hv_spec')?.description).toContain('fresh git repository');
    expect(registry.get('hv_connections')?.description).toContain('{project} lists');
    expect(registry.get('hv_secrets')?.description).toContain('{} or {project} lists sources');
    expect(registry.get('hv_secrets')?.description).toContain('Hosting mode requires explicit env');
    expect(registry.get('hv_inspect')?.description).toContain('{provider,project,env}');
    expect(registry.get('hv_secrets')?.access).toBe('read');
    expect(registry.get('hv_plan')?.cliPath).toEqual(['plan']);
    expect(registry.get('hv_plan')?.inputShape.scope).toBeDefined();
    expect(registry.get('hv_plan')?.description).toContain('scope="retained-cleanup"');
    expect(registry.get('hv_db_query')?.cliPath).toEqual(['db', 'query']);
    expect(registry.get('hv_cloud_pair')?.cliPath).toEqual(['cloud', 'pair']);
    expect(registry.get('hv_db_migrate')).toBeUndefined();
  });

  it('returns the same structured envelope through the registry and MCP', async () => {
    const registry = createCommandRegistry(createCommandContext());
    const direct = await registry.execute('hv_spec', { project: 'does-not-exist' });
    const { client, server } = await makeClient();
    const overMcp = parseToolEnvelope(await client.callTool({
      name: 'hv_spec',
      arguments: { project: 'does-not-exist' },
    }));

    expect(overMcp).toEqual(direct);
    await client.close();
    await server.close();
  });

  it('resolves omitted projects from the MCP client workspace root, not the server launch directory', async () => {
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
    new ProjectRepository().create({ name: 'hypervibe-domain-conformance' });
    const workspaceRoot = path.join(tempDir, 'invoice-perfect');
    mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });
    mkdirSync(path.join(workspaceRoot, '.hypervibe'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, '.hypervibe', 'spec.json'), `${JSON.stringify({
      version: 1,
      project: 'invoiceperfect.com',
      runtime: { kind: 'node', version: '24' },
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {
            worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
          },
        },
      },
    }, null, 2)}\n`);
    writeFileSync(path.join(workspaceRoot, '.hypervibe', 'bindings.json'), `${JSON.stringify({
      version: 1,
      project: 'invoiceperfect.com',
      environments: {
        staging: {
          platformBindings: {
            provider: 'railway',
            projectId: 'railway-project',
            environmentId: 'railway-staging',
            services: { worker: { serviceId: 'railway-worker' } },
          },
        },
      },
    }, null, 2)}\n`);

    const { client, server } = await makeClient(workspaceRoot);
    expect(server.server.getClientCapabilities()?.roots).toEqual({});
    await expect(server.server.listRoots()).resolves.toMatchObject({
      roots: [{ uri: pathToFileURL(workspaceRoot).href }],
    });
    const result = parseToolEnvelope(await client.callTool({ name: 'hv_spec', arguments: {} }));

    expect(result.ok).toBe(true);
    expect((result.data as { project?: { name?: string } }).project?.name).toBe('invoiceperfect.com');

    const logsResult = parseToolEnvelope(await client.callTool({
      name: 'hv_logs',
      arguments: {
        env: 'staging',
        service: 'worker',
        source: 'service',
        errorsOnly: true,
        limit: 50,
      },
    }));
    expect(logsResult.ok).toBe(false);
    expect(logsResult.error).toMatchObject({ code: 'MISSING_CONNECTION' });
    expect(logsResult.error?.details).toMatchObject({
      connectionSetup: expect.objectContaining({
        provider: 'railway',
        project: 'invoiceperfect.com',
      }),
    });
    await client.close();
    await server.close();
  });

  it('instructs agents to inspect managed deploys through Hypervibe', async () => {
    const { HYPERVIBE_SERVER_INSTRUCTIONS } = await import('../../server.js');
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'For every deploy or promotion request'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'use hv_ci_status to select the reviewed definition, hv_ci_trigger to dispatch it, hv_ci_status to monitor it'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'Never dispatch, monitor, or inspect a managed CI run with gh'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'follow or report its connection/error guidance and stop instead of bypassing Hypervibe'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'hv_connections({project?}) and hv_secrets({project?}) list by default'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'full environment inspection requires provider + project + env'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'Its successful initialized=false result is a normal bootstrap state'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'correct one unambiguous selector typo and retry once'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'offer to open it in the user\'s browser'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'call hv_cloud_pair with action=start'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'Never ask for a GitHub token, repository id, or environment name'
    );
    expect(HYPERVIBE_SERVER_INSTRUCTIONS).toContain(
      'Never refer vaguely to a "Hypervibe credential flow"'
    );
  });

  it('every tool responds with the structured envelope on error paths', async () => {
    const { client, server } = await makeClient();
    // Representative spread across files: each must return the ok/error envelope, not a protocol error.
    const probes: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'hv_spec', args: { project: 'does-not-exist' } },
      { name: 'hv_plan', args: { project: 'does-not-exist' } },
      { name: 'hv_deploy', args: { project: 'does-not-exist' } },
      { name: 'hv_db_query', args: { project: 'does-not-exist', sql: 'SELECT 1' } },
      { name: 'hv_secrets', args: { project: 'does-not-exist', env: 'production' } },
      { name: 'hv_runs', args: { project: 'does-not-exist' } },
    ];
    for (const probe of probes) {
      const result = await client.callTool({ name: probe.name, arguments: probe.args });
      const body = parseToolEnvelope(result);
      expect(body.ok, `${probe.name} should return ok:false`).toBe(false);
      expect(body.error?.code, `${probe.name} should carry an error code`).toBeTruthy();
      expect(body.error?.message, `${probe.name} should carry an error message`).toBeTruthy();
      expect((result.content as Array<{ text: string }>)[0].text.trim().startsWith('{')).toBe(false);
    }
    await client.close();
    await server.close();
  });
});
