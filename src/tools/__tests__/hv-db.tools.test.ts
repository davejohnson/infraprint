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
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { RdsAdapter } from '../../adapters/providers/aws/rds.adapter.js';
import { DatabaseAdapter } from '../../adapters/providers/database/database.adapter.js';
import { createToolContext } from '../../application/context.js';
import { registerHvDbTools } from '../hv-db.tools.js';
import { databaseAccessLeaseCoordinator } from '../../domain/services/database-access.service.js';

let tempDir: string;

beforeEach(() => {
  databaseAccessLeaseCoordinator.resetForTests();
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-db-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  databaseAccessLeaseCoordinator.resetForTests();
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-db-test', version: '1.0.0' });
  registerHvDbTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-db-test-client', version: '1.0.0' });
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

function seedDbProject() {
  const project = new ProjectRepository().create({ name: 'db-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    bindings: { provider: 'supabase', connectionString: 'postgres://user:secretpw@db.example.com:5432/app' },
    externalId: 'db-1',
  });
  return { project, environment };
}

function seedInternalRailwayDbProject() {
  const project = new ProjectRepository().create({ name: 'rail-db-app', defaultPlatform: 'railway' });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
    },
  });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    externalId: 'rail-db-svc-1',
    bindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      connectionUrl: '${{Postgres.DATABASE_URL}}',
    },
  });
  return { project, environment };
}

function seedVerifiedRailwayConnection() {
  const connection = new ConnectionRepository().create({
    provider: 'railway',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
  });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
}

function seedCloudSqlDbProject() {
  const project = new ProjectRepository().create({ name: 'cloudsql-db-app', defaultPlatform: 'cloudrun' });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
  });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    externalId: 'production-postgres',
    bindings: {
      provider: 'cloudsql',
      connectionName: 'gcp-project:us-central1:production-postgres',
      username: 'postgres',
      password: 'db-secret',
      database: 'app',
    },
  });
  const connection = new ConnectionRepository().create({
    provider: 'cloudsql',
    credentialsEncrypted: getSecretStore().encryptObject({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'hypervibe@gcp-project.iam.gserviceaccount.com',
      }),
    }),
  });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  return { project, environment };
}

function seedRdsDbProject() {
  const project = new ProjectRepository().create({ name: 'rds-db-app', defaultPlatform: 'cloudrun' });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
  });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    externalId: 'production-postgres',
    bindings: {
      provider: 'rds',
      username: 'hypervibe_admin',
      password: 'db-secret',
      database: 'app',
      securityGroupId: 'sg-database',
    },
  });
  const connection = new ConnectionRepository().create({
    provider: 'rds',
    credentialsEncrypted: getSecretStore().encryptObject({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'aws-secret',
      region: 'us-west-2',
    }),
  });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  return { project, environment };
}

describe('hv_db_query', () => {
  it('rejects conflicting explicit database targets before connecting', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', {
      connectionUrl: URL,
      connectionName: 'analytics',
      sql: 'SELECT 1',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('either connectionUrl or connectionName');
    await t.close();
  });

  const URL = 'postgres://user:pw@localhost:5432/app';

  it('rejects managed-environment selectors alongside an explicit target', async () => {
    const connect = vi.spyOn(DatabaseAdapter.prototype, 'connect');
    const t = await makeClient();
    const result = await t.call('hv_db_query', {
      connectionUrl: URL,
      env: 'production',
      service: 'web',
      sql: 'SELECT 1',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('managed-environment selectors');
    expect(connect).not.toHaveBeenCalled();
    await t.close();
  });

  it('returns project-scoped setup for a missing named database connection', async () => {
    new ProjectRepository().create({ name: 'named-db-app' });
    const t = await makeClient();
    const result = await t.call('hv_db_query', {
      project: 'named-db-app',
      connectionName: 'analytics',
      sql: 'SELECT 1',
    });

    expect(result.error.code).toBe('NOT_FOUND');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'database',
      project: 'named-db-app',
      scope: 'analytics',
      setupUrl: false,
    });
    await t.close();
  });

  it('returns hosting-provider setup when managed database access lacks a connection', async () => {
    seedInternalRailwayDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_query', {
      project: 'rail-db-app',
      env: 'production',
      sql: 'SELECT 1',
    });

    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'railway',
      project: 'rail-db-app',
    });
    expect(result.next).toEqual(['hv_connections']);
    await t.close();
  });

  it('rejects provider template refs before reaching the database adapter', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: '${{Postgres.DATABASE_URL}}', sql: 'SELECT 1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('not a supported Postgres URL');
    await t.close();
  });

  it('rejects private provider hosts passed as direct query URLs', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', {
      connectionUrl: 'postgresql://user:pw@postgres.railway.internal:5432/app',
      sql: 'SELECT 1',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('not externally reachable');
    await t.close();
  });

  it('rejects multi-statement SQL before connecting', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: URL, sql: 'SELECT 1; DROP TABLE users' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('Multi-statement');
    await t.close();
  });

  it('blocks mutations without allowMutations', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: URL, sql: 'DELETE FROM users' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(result.hint).toContain('allowMutations');
    await t.close();
  });

  it('is not evaded by comment-prefixed mutations', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: URL, sql: '/* hi */ DROP TABLE users' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });

  it('creates a TCP proxy for an internal managed database and removes it after the query', async () => {
    seedInternalRailwayDbProject();
    seedVerifiedRailwayConnection();
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({
      PGUSER: 'postgres',
      POSTGRES_PASSWORD: 'secret',
      PGDATABASE: 'app',
      DATABASE_URL: 'postgresql://postgres:secret@postgres.railway.internal:5432/app',
    });
    vi.spyOn(RailwayAdapter.prototype, 'getTcpProxy').mockResolvedValue(null);
    const ensureProxy = vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy').mockResolvedValue({
      id: 'proxy-temp',
      domain: 'temp.proxy.rlwy.net',
      proxyPort: 33333,
      created: true,
    });
    const deleteProxy = vi.spyOn(RailwayAdapter.prototype, 'deleteTcpProxy').mockResolvedValue();
    vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({
      success: true,
      rowCount: 1,
      rows: [{ one: 1 }],
      fields: [{ name: 'one', dataType: '23' }],
    });
    const t = await makeClient();
    const result = await t.call('hv_db_query', { project: 'rail-db-app', env: 'production', sql: 'SELECT 1' });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      rows: [{ one: 1 }],
      access: {
        mode: 'ephemeral_proxy',
        provider: 'railway',
        leaseCreated: true,
        cleanup: 'completed',
        resourceId: 'proxy-temp',
      },
    });
    expect(JSON.stringify(result)).not.toContain('temp.proxy.rlwy.net');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(ensureProxy).toHaveBeenCalledWith('rail-env-1', 'rail-db-svc-1', 5432);
    expect(deleteProxy).toHaveBeenCalledWith('rail-env-1', 'rail-db-svc-1', 'proxy-temp');
    await t.close();
  });

  it('removes the temporary proxy when the database query fails', async () => {
    seedInternalRailwayDbProject();
    seedVerifiedRailwayConnection();
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({
      PGUSER: 'postgres', POSTGRES_PASSWORD: 'secret', PGDATABASE: 'app',
    });
    vi.spyOn(RailwayAdapter.prototype, 'getTcpProxy').mockResolvedValue(null);
    vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy').mockResolvedValue({
      id: 'proxy-temp', domain: 'temp.proxy.rlwy.net', proxyPort: 33333, created: true,
    });
    const deleteProxy = vi.spyOn(RailwayAdapter.prototype, 'deleteTcpProxy').mockResolvedValue();
    vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({ success: false, error: 'query exploded' });
    const t = await makeClient();

    const result = await t.call('hv_db_query', { project: 'rail-db-app', env: 'production', sql: 'SELECT 1' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.message).toContain('query exploded');
    expect(result.error.details.access).toMatchObject({
      mode: 'ephemeral_proxy',
      leaseCreated: true,
      cleanup: 'completed',
      resourceId: 'proxy-temp',
    });
    expect(deleteProxy).toHaveBeenCalledWith('rail-env-1', 'rail-db-svc-1', 'proxy-temp');
    await t.close();
  });

  it('preserves a successful query result but stops when temporary proxy cleanup fails', async () => {
    seedInternalRailwayDbProject();
    seedVerifiedRailwayConnection();
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({
      PGUSER: 'postgres', POSTGRES_PASSWORD: 'secret', PGDATABASE: 'app',
    });
    vi.spyOn(RailwayAdapter.prototype, 'getTcpProxy').mockResolvedValue(null);
    vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy').mockResolvedValue({
      id: 'proxy-temp', domain: 'temp.proxy.rlwy.net', proxyPort: 33333, created: true,
    });
    vi.spyOn(RailwayAdapter.prototype, 'deleteTcpProxy').mockRejectedValue(new Error('cleanup denied'));
    vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({ success: true, rowCount: 1, rows: [{ one: 1 }] });
    const t = await makeClient();

    const result = await t.call('hv_db_query', { project: 'rail-db-app', env: 'production', sql: 'SELECT 1' });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      rows: [{ one: 1 }],
      access: {
        mode: 'ephemeral_proxy',
        leaseCreated: true,
        cleanup: 'failed',
        resourceId: 'proxy-temp',
      },
    });
    expect(result.agentInstruction.action).toBe('stop_and_report');
    expect(result.warnings.join(' ')).toContain('cleanup failed');
    expect(result.hint).toContain('hv_inspect');
    await t.close();
  });

  it('rejects unsafe SQL before creating temporary database access', async () => {
    seedInternalRailwayDbProject();
    const ensureProxy = vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy');
    const t = await makeClient();

    const result = await t.call('hv_db_query', {
      project: 'rail-db-app', env: 'production', sql: 'SELECT 1; DROP TABLE users',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(ensureProxy).not.toHaveBeenCalled();
    await t.close();
  });

  it('uses and releases a Cloud SQL authenticated connector for the query', async () => {
    seedCloudSqlDbProject();
    vi.spyOn(CloudSqlAdapter.prototype, 'getConnectionUrl')
      .mockResolvedValue('postgresql://postgres:db-secret@34.1.2.3:5432/app');
    const acquire = vi.spyOn(CloudSqlAdapter.prototype, 'acquireTemporaryDatabaseAccess').mockResolvedValue({
      connectionUrl: 'postgresql://postgres:db-secret@localhost/app?host=%2Ftmp%2Fhv-cloudsql-test',
      source: 'private_connector',
      temporary: true,
      releaseToken: 'cloudsql-lease',
    });
    const release = vi.spyOn(CloudSqlAdapter.prototype, 'releaseTemporaryDatabaseAccess').mockResolvedValue();
    vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({
      success: true,
      rowCount: 1,
      rows: [{ provider: 'cloudsql' }],
    });
    const t = await makeClient();

    const result = await t.call('hv_db_query', {
      project: 'cloudsql-db-app', env: 'production', sql: 'SELECT current_database()',
    });

    expect(result.ok).toBe(true);
    expect(result.data.access).toMatchObject({
      provider: 'cloudsql',
      mode: 'private_connector',
      leaseCreated: true,
      cleanup: 'completed',
      resourceId: 'cloudsql-lease',
    });
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ name: 'production' }), expect.objectContaining({ externalId: 'production-postgres' }), 5432);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'production' }),
      expect.objectContaining({ externalId: 'production-postgres' }),
      expect.objectContaining({ releaseToken: 'cloudsql-lease' })
    );
    expect(JSON.stringify(result)).not.toContain('db-secret');
    await t.close();
  });

  it('uses and releases temporary Amazon RDS firewall ingress for the query', async () => {
    seedRdsDbProject();
    vi.spyOn(RdsAdapter.prototype, 'getConnectionUrl')
      .mockResolvedValue('postgresql://hypervibe_admin:db-secret@db.example.rds.amazonaws.com:5432/app');
    const acquire = vi.spyOn(RdsAdapter.prototype, 'acquireTemporaryDatabaseAccess').mockResolvedValue({
      connectionUrl: 'postgresql://hypervibe_admin:db-secret@db.example.rds.amazonaws.com:5432/app',
      source: 'temporary_firewall',
      temporary: true,
      releaseToken: 'sgr-query',
    });
    const release = vi.spyOn(RdsAdapter.prototype, 'releaseTemporaryDatabaseAccess').mockResolvedValue();
    vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({
      success: true,
      rowCount: 1,
      rows: [{ provider: 'rds' }],
    });
    const t = await makeClient();

    const result = await t.call('hv_db_query', {
      project: 'rds-db-app', env: 'production', sql: 'SELECT current_database()',
    });

    expect(result.ok).toBe(true);
    expect(result.data.access).toMatchObject({
      provider: 'rds',
      mode: 'temporary_firewall',
      leaseCreated: true,
      cleanup: 'completed',
      resourceId: 'sgr-query',
    });
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ name: 'production' }), expect.objectContaining({ externalId: 'production-postgres' }), 5432);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'production' }),
      expect.objectContaining({ externalId: 'production-postgres' }),
      expect.objectContaining({ releaseToken: 'sgr-query' })
    );
    expect(JSON.stringify(result)).not.toContain('db-secret');
    await t.close();
  });

  it('uses an already reachable managed database without creating provider access', async () => {
    seedDbProject();
    const ensureProxy = vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy');
    const query = vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({
      success: true,
      rowCount: 1,
      rows: [{ healthy: true }],
    });
    const t = await makeClient();

    const result = await t.call('hv_db_query', { project: 'db-app', env: 'staging', sql: 'SELECT true AS healthy' });

    expect(result.ok).toBe(true);
    expect(result.data.access).toMatchObject({
      provider: 'supabase',
      mode: 'existing',
      leaseCreated: false,
      cleanup: 'no_op',
    });
    expect(ensureProxy).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith('SELECT true AS healthy', undefined, { readOnly: true });
    await t.close();
  });

  it('records safe diagnostic audit metadata without SQL, parameters, rows, or credentials', async () => {
    vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({
      success: true,
      rowCount: 1,
      rows: [{ value: 'row-secret' }],
    });
    const t = await makeClient();

    const result = await t.call('hv_db_query', {
      connectionUrl: 'postgresql://audit-user:url-secret@database.example.com:5432/app',
      sql: 'SELECT $1::text AS value',
      params: ['param-secret'],
    });

    expect(result.ok).toBe(true);
    const [audit] = new AuditRepository().findByAction('db_query.succeeded');
    expect(audit).toBeDefined();
    expect(audit.details).toMatchObject({
      queryType: 'select',
      accessMode: 'existing',
      leaseCreated: false,
      cleanup: 'no_op',
      rowCount: 1,
    });
    expect(audit.details.sqlFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain('SELECT $1');
    expect(serializedAudit).not.toContain('param-secret');
    expect(serializedAudit).not.toContain('row-secret');
    expect(serializedAudit).not.toContain('url-secret');
    await t.close();
  });
});
