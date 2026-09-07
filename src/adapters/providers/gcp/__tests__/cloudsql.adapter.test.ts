import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

describe('CloudSqlAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function connectedAdapter(): Promise<CloudSqlAdapter> {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    return adapter;
  }

  it('verifies successfully when the SQL Admin API probe succeeds', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=1' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ items: [] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.email).toBe('deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification with an actionable error when the SQL Admin API probe is denied', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=1' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          error: {
            code: 403,
            message: 'The caller does not have permission',
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('roles/cloudsql.viewer');
    expect(result.error).toContain('roles/cloudsql.client');
    expect(result.error).toContain('roles/cloudsql.admin');
    expect(result.error).toContain('sqladmin.googleapis.com');
    expect(result.error).toContain('serviceAccount:deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification with status and body on non-403 SQL Admin API errors', async () => {
    const adapter = await connectedAdapter();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=1' && (init?.method ?? 'GET') === 'GET') {
        return new Response('backend unavailable', { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
    expect(result.error).toContain('backend unavailable');
  });

  it('lists differently named Cloud SQL instances with scoped provider identities', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/instances?maxResults=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          items: [{
            name: 'customer-facing-primary',
            state: 'RUNNABLE',
            databaseVersion: 'POSTGRES_15',
            region: 'northamerica-northeast1',
            connectionName: 'gcp-project:northamerica-northeast1:customer-facing-primary',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectDatabaseResources({ resource: 'database', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      project: { id: 'gcp-project' },
      databases: [{
        id: 'customer-facing-primary',
        engine: 'postgres',
        status: 'running',
        providerScope: { projectId: 'gcp-project', region: 'northamerica-northeast1' },
      }],
      truncated: false,
      partial: false,
    });
  });

  it('uses exact Cloud SQL identity lookup and preserves non-not-found errors', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/instances/legacy-db')) {
        return new Response('permission denied', { status: 403 });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.inspectDatabaseResources({ resource: 'database', id: 'legacy-db', limit: 1 }))
      .rejects.toThrow('403 permission denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an exact Cloud SQL lookup that returns a different instance identity', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      name: 'different-instance',
      state: 'RUNNABLE',
      databaseVersion: 'POSTGRES_15',
      region: 'us-central1',
    })));

    await expect(adapter.inspectDatabaseResources({
      resource: 'database',
      id: 'expected-instance',
      limit: 1,
    })).rejects.toThrow('exact lookup for expected-instance returned different-instance');
  });

  it('inventories project-level retained backups with exact scoped identities', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://sqladmin.googleapis.com/v1/projects/gcp-project/backups?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          backups: [{
            name: 'projects/gcp-project/backups/backup-123',
            sourceInstance: 'projects/gcp-project/instances/legacy-db',
            type: 'FINAL',
            state: 'SUCCESSFUL',
            instanceDeletionTime: '2026-08-17T12:00:00Z',
            maxChargeableBytes: '4294967296',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectBackupResources({ resource: 'backup', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'backup',
      backups: [{
        id: 'projects/gcp-project/backups/backup-123',
        name: 'backup-123',
        type: 'FINAL',
        providerScope: { projectId: 'gcp-project' },
        cleanupSupported: true,
      }],
      truncated: false,
      partial: false,
    });
  });

  it('refuses retained cleanup for a backup whose source instance is still live', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/projects/gcp-project/backups/backup-live') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/backups/backup-live',
          sourceInstance: 'projects/gcp-project/instances/live-db',
          type: 'ON_DEMAND',
          state: 'SUCCESSFUL',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await adapter.destroyRetainedBackup({
      resource: 'backup',
      id: 'projects/gcp-project/backups/backup-live',
      providerScope: { projectId: 'gcp-project' },
    });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toMatch(/live instance/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes an exact retained backup and verifies terminal absence', async () => {
    const adapter = await connectedAdapter();
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/projects/gcp-project/backups/backup-old') && method === 'GET') {
        return deleted
          ? new Response('missing', { status: 404 })
          : Response.json({
              name: 'projects/gcp-project/backups/backup-old',
              instanceDeletionTime: '2026-08-17T12:00:00Z',
              type: 'FINAL',
            });
      }
      if (url.endsWith('/v1/projects/gcp-project/backups/backup-old') && method === 'DELETE') {
        deleted = true;
        return Response.json({ name: 'backup-delete-op', status: 'DONE' });
      }
      if (url.endsWith('/operations/backup-delete-op') && method === 'GET') {
        return Response.json({ name: 'backup-delete-op', status: 'DONE' });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await adapter.destroyRetainedBackup({
      resource: 'backup',
      id: 'projects/gcp-project/backups/backup-old',
      providerScope: { projectId: 'gcp-project' },
    });

    expect(receipt.success).toBe(true);
    expect(deleted).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('treats an already-absent retained backup as success without a delete mutation', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/projects/gcp-project/backups/backup-gone') && (init?.method ?? 'GET') === 'GET') {
        return new Response('missing', { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await adapter.destroyRetainedBackup({
      resource: 'backup',
      id: 'projects/gcp-project/backups/backup-gone',
      providerScope: { projectId: 'gcp-project' },
    });

    expect(receipt.success).toBe(true);
    expect(receipt.message).toMatch(/already absent/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('carries an explicit provision region into every durable Cloud SQL connection identity', async () => {
    const adapter = await connectedAdapter();
    let instanceReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceReads += 1;
        return instanceReads === 1
          ? new Response('missing', { status: 404 })
          : Response.json({
              name: 'production-postgres',
              state: 'RUNNABLE',
              databaseVersion: 'POSTGRES_15',
              region: 'europe-west1',
              connectionName: 'gcp-project:europe-west1:production-postgres',
            });
      }
      if (url.endsWith('/instances') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          name: 'production-postgres',
          region: 'europe-west1',
        });
        return Response.json({ name: 'instance-create-op' });
      }
      if (url.endsWith('/operations/instance-create-op') && method === 'GET') {
        return Response.json({ name: 'instance-create-op', status: 'DONE' });
      }
      if (url.endsWith('/instances/production-postgres/databases/app') && method === 'GET') {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/instances/production-postgres/databases') && method === 'POST') {
        return Response.json({ name: 'database-create-op' });
      }
      if (url.endsWith('/operations/database-create-op') && method === 'GET') {
        return Response.json({ name: 'database-create-op', status: 'DONE' });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'production-postgres',
      databaseName: 'app',
      region: 'europe-west1',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.bindings).toMatchObject({
      host: 'production-postgres.europe-west1.gcp-project',
      connectionName: 'gcp-project:europe-west1:production-postgres',
      providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
    });
    expect(instanceReads).toBe(2);
  });

  it('retains cleanup identity when Cloud SQL acknowledges create but read-back is unknown', async () => {
    const adapter = await connectedAdapter();
    let instanceReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceReads += 1;
        return instanceReads === 1
          ? new Response('missing', { status: 404 })
          : new Response('observation unavailable', { status: 503 });
      }
      if (url.endsWith('/instances') && method === 'POST') {
        return Response.json({ name: 'instance-create-op' });
      }
      if (url.endsWith('/operations/instance-create-op') && method === 'GET') {
        return Response.json({ name: 'instance-create-op', status: 'DONE' });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'production-postgres',
      region: 'europe-west1',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceName: 'production-postgres',
        projectId: 'gcp-project',
        region: 'europe-west1',
        resourceCreated: 'unknown',
        cleanupRequired: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'production-postgres',
        providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
        cleanupRequired: true,
      },
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('recovers the deterministic instance after the create transport loses its response', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_DELAY_MS', '0');
    const adapter = await connectedAdapter();
    let instanceReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceReads += 1;
        if (instanceReads < 3) return new Response('missing', { status: 404 });
        return Response.json({
          name: 'production-postgres',
          region: 'europe-west1',
          databaseVersion: 'POSTGRES_15',
          state: 'PENDING_CREATE',
        });
      }
      if (url.endsWith('/instances') && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'production-postgres',
      region: 'europe-west1',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceName: 'production-postgres',
        projectId: 'gcp-project',
        region: 'europe-west1',
        resourceCreated: true,
        cleanupRequired: true,
        mutationAttempted: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
      },
    });
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
      .toHaveLength(1);
  });

  it('retains deterministic scope after an acknowledged create returns malformed JSON', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_DELAY_MS', '0');
    const adapter = await connectedAdapter();
    let instanceReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceReads += 1;
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/instances') && method === 'POST') {
        return new Response('{not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'production-postgres',
      region: 'europe-west1',
    });

    expect(instanceReads).toBe(2);
    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceName: 'production-postgres',
        projectId: 'gcp-project',
        region: 'europe-west1',
        resourceCreated: 'unknown',
        cleanupRequired: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'production-postgres',
      bindings: {
        providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
      },
    });
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
      .toHaveLength(1);
  });

  it('retains deterministic scope when a lost create response remains eventually absent', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_DELAY_MS', '0');
    const adapter = await connectedAdapter();
    let instanceReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceReads += 1;
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/instances') && method === 'POST') {
        throw new Error('connection closed after request transmission');
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'production-postgres',
      region: 'europe-west1',
    });

    expect(instanceReads).toBe(2);
    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceName: 'production-postgres',
        projectId: 'gcp-project',
        region: 'europe-west1',
        resourceCreated: 'unknown',
        cleanupRequired: true,
        mutationAttempted: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
      },
    });
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
      .toHaveLength(1);
  });

  it.each([408, 503])(
    'retains deterministic scope when the create request returns ambiguous HTTP %s',
    async (createStatus) => {
      vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_ATTEMPTS', '1');
      vi.stubEnv('HYPERVIBE_CLOUDSQL_CREATE_RECOVERY_DELAY_MS', '0');
      const adapter = await connectedAdapter();
      let instanceReads = 0;
      const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/instances/production-postgres') && method === 'GET') {
          instanceReads += 1;
          return new Response('missing', { status: 404 });
        }
        if (url.endsWith('/instances') && method === 'POST') {
          return new Response('ambiguous create failure', { status: createStatus });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const now = new Date();
      const environment: Environment = {
        id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
      };

      const result = await adapter.provision('postgres', environment, {
        resourceName: 'production-postgres',
        region: 'europe-west1',
      });

      expect(result.receipt).toMatchObject({
        success: false,
        data: {
          instanceName: 'production-postgres',
          projectId: 'gcp-project',
          region: 'europe-west1',
          resourceCreated: 'unknown',
          cleanupRequired: true,
          mutationAttempted: true,
        },
      });
      expect(result.component).toMatchObject({
        externalId: 'production-postgres',
        bindings: {
          provider: 'cloudsql',
          instanceId: 'production-postgres',
          providerScope: { projectId: 'gcp-project', region: 'europe-west1' },
        },
      });
      expect(instanceReads).toBe(2);
      expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
        .toHaveLength(1);
    }
  );

  it('does not retain deterministic identity or retry observation after a definitive create rejection', async () => {
    const adapter = await connectedAdapter();
    let instanceReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceReads += 1;
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/instances') && method === 'POST') {
        return new Response('invalid request', { status: 422 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'production-postgres',
      region: 'europe-west1',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toBeUndefined();
    expect(result.component.externalId).toBeNull();
    expect(result.component.bindings).toEqual({});
    expect(instanceReads).toBe(1);
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST'))
      .toHaveLength(1);
  });

  it('blocks ordinary database mutations when the component belongs to another GCP project', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        database: 'app',
        providerScope: { projectId: 'different-project', region: 'us-central1' },
      },
      createdAt: now,
      updatedAt: now,
    };

    const database = await adapter.ensureDatabase(component);
    const availability = await adapter.configureAvailability(
      { id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now },
      component,
      'zonal'
    );
    const destroyed = await adapter.destroy(component);

    expect(database.success).toBe(false);
    expect(database.error).toContain('different-project');
    expect(availability.success).toBe(false);
    expect(availability.error).toContain('different-project');
    expect(destroyed.success).toBe(false);
    expect(destroyed.error).toContain('different-project');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks an external-ID-bound component whose durable GCP project scope is missing', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: { provider: 'cloudsql' },
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing its durable GCP project scope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not mutate or delete a logical database when the live instance moved outside its bound region', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        return Response.json({
          name: 'production-postgres',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-east1',
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        database: 'app',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: now,
      updatedAt: now,
    };

    const result = await adapter.ensureDatabase(component);
    const destroyed = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not bound region us-central1');
    expect(destroyed.success).toBe(false);
    expect(destroyed.error).toContain('not bound region us-central1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/databases'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('creates a missing logical database on an existing Cloud SQL instance', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/app-postgres') && method === 'GET') {
        return Response.json({
          name: 'app-postgres',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-central1',
        });
      }
      if (url.endsWith('/instances/app-postgres/databases/app') && method === 'GET') {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/instances/app-postgres/databases') && method === 'POST') {
        return Response.json({ name: 'db-create-op' });
      }
      if (url.endsWith('/operations/db-create-op') && method === 'GET') {
        return Response.json({ name: 'db-create-op', status: 'DONE' });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'app-postgres',
      bindings: {
        provider: 'cloudsql',
        database: 'app',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: now,
      updatedAt: now,
    };

    const receipt = await adapter.ensureDatabase(component);

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      instanceName: 'app-postgres',
      databaseName: 'app',
      created: true,
    });

    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith('/instances/app-postgres/databases') && init?.method === 'POST'
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: 'app' });
  });

  it('treats an existing logical database as successful reuse', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/app-postgres') && method === 'GET') {
        return Response.json({
          name: 'app-postgres',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-central1',
        });
      }
      if (url.endsWith('/instances/app-postgres/databases/app') && method === 'GET') {
        return Response.json({ name: 'app' });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'app-postgres',
      bindings: {
        provider: 'cloudsql',
        database: 'app',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: now,
      updatedAt: now,
    };

    const receipt = await adapter.ensureDatabase(component);

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      instanceName: 'app-postgres',
      databaseName: 'app',
      created: false,
    });
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('observes a provisioned Cloud SQL instance for an environment', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        return Response.json({
          name: 'production-postgres',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-central1',
          replicaNames: ['production-postgres-rr-analytics'],
          settings: {
            availabilityType: 'REGIONAL',
            backupConfiguration: {
              enabled: true,
              pointInTimeRecoveryEnabled: true,
              transactionLogRetentionDays: 7,
              backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 8 },
            },
          },
        });
      }
      if (url.endsWith('/instances/production-postgres-rr-analytics') && method === 'GET') {
        return Response.json({
          name: 'production-postgres-rr-analytics',
          state: 'RUNNABLE',
          databaseVersion: 'POSTGRES_15',
          region: 'us-west1',
          connectionName: 'gcp-project:us-west1:production-postgres-rr-analytics',
          masterInstanceName: 'production-postgres',
          settings: {
            tier: 'db-custom-2-7680',
            userLabels: { 'hypervibe-replica': 'analytics' },
          },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };

    const observed = await adapter.observeDatabase(environment);

    expect(observed).toEqual({
      provider: 'cloudsql',
      engine: 'postgres',
      externalId: 'production-postgres',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      name: 'production-postgres',
      status: 'running',
      resilience: {
        availability: 'regional',
        backupPolicy: {
          enabled: true,
          pitrEnabled: true,
          retainedBackups: 8,
          pitrRetentionDays: 7,
        },
        replicas: [{
          name: 'analytics',
          externalId: 'production-postgres-rr-analytics',
          status: 'running',
          region: 'us-west1',
          tier: 'db-custom-2-7680',
          connectionName: 'gcp-project:us-west1:production-postgres-rr-analytics',
        }],
      },
    });
  });

  it('returns null from observeDatabase when no instance exists for the environment', async () => {
    const adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
      createdAt: now,
      updatedAt: now,
    };

    await expect(adapter.observeDatabase(environment)).resolves.toBeNull();
  });

  it('patches and verifies the provider-managed backup policy', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/primary-1') && method === 'PATCH') {
        return Response.json({ name: 'backup-op' });
      }
      if (url.endsWith('/operations/backup-op') && method === 'GET') {
        return Response.json({ name: 'backup-op', status: 'DONE' });
      }
      if (url.endsWith('/instances/primary-1') && method === 'GET') {
        return Response.json({
          name: 'primary-1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-central1',
          settings: {
            backupConfiguration: {
              enabled: true,
              pointInTimeRecoveryEnabled: true,
              transactionLogRetentionDays: 7,
              backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 8 },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'primary-1',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: now, updatedAt: now,
    };
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const receipt = await adapter.configureBackupPolicy(environment, component, {
      retainedBackups: 8,
      pitrRetentionDays: 7,
    });

    expect(receipt.success).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      settings: {
        backupConfiguration: {
          enabled: true,
          pointInTimeRecoveryEnabled: true,
          transactionLogRetentionDays: 7,
          backupRetentionSettings: { retainedBackups: 8 },
        },
      },
    });
  });

  it('provisions a labelled read replica and returns only its durable binding', async () => {
    const adapter = await connectedAdapter();
    let targetReads = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/primary-1') && method === 'GET') {
        return Response.json({
          name: 'primary-1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-central1', settings: { tier: 'db-custom-1-3840' },
        });
      }
      if (url.endsWith('/instances/primary-1-rr-analytics') && method === 'GET') {
        targetReads += 1;
        if (targetReads === 1) return new Response('missing', { status: 404 });
        return Response.json({
          name: 'primary-1-rr-analytics', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-west1',
          connectionName: 'gcp-project:us-west1:primary-1-rr-analytics', masterInstanceName: 'primary-1',
          ipAddresses: [{ type: 'PRIMARY', ipAddress: '203.0.113.10' }],
          settings: { tier: 'db-custom-2-7680', userLabels: { 'hypervibe-managed': 'true', 'hypervibe-replica': 'analytics' } },
        });
      }
      if (url.endsWith('/instances') && method === 'POST') return Response.json({ name: 'replica-op' });
      if (url.endsWith('/operations/replica-op') && method === 'GET') return Response.json({ name: 'replica-op', status: 'DONE' });
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'primary-1',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        username: 'app',
        password: 'secret',
        database: 'app',
        port: 5432,
      },
      createdAt: now, updatedAt: now,
    };
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const result = await adapter.provisionReadReplica(environment, component, 'analytics', {
      region: 'us-west1', tier: 'db-custom-2-7680',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.replica).toMatchObject({
      externalId: 'primary-1-rr-analytics', region: 'us-west1', tier: 'db-custom-2-7680',
      connectionName: 'gcp-project:us-west1:primary-1-rr-analytics',
    });
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: 'primary-1-rr-analytics',
      masterInstanceName: 'primary-1',
      settings: { userLabels: { 'hypervibe-managed': 'true', 'hypervibe-replica': 'analytics' } },
    });
  });

  it('refuses to delete a replica when provider ownership identity does not match', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/replica-1') && method === 'GET') {
        return Response.json({
          name: 'replica-1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', masterInstanceName: 'different-primary',
          settings: { userLabels: { 'hypervibe-replica': 'analytics' } },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1',
      bindings: {
        provider: 'cloudsql',
        instanceId: 'primary-1',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: now, updatedAt: now,
    };
    const environment: Environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    };

    const receipt = await adapter.destroyReadReplica(environment, component, 'analytics', { externalId: 'replica-1' });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Refusing to delete');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('propagates Cloud SQL observation errors instead of treating them as absence', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('backend unavailable', { status: 503 })
    ));
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(adapter.observeDatabase(environment)).rejects.toThrow(/503.*backend unavailable/);
  });

  it('opens and releases a local authenticated connector for one database operation', async () => {
    const adapter = await connectedAdapter();
    const startLocalProxy = vi.spyOn(Connector.prototype, 'startLocalProxy').mockResolvedValue();
    const close = vi.spyOn(Connector.prototype, 'close').mockImplementation(() => {});
    const now = new Date();
    const environment: Environment = {
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {},
      createdAt: now,
      updatedAt: now,
    };
    const component: Component = {
      id: 'component-1',
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        connectionName: 'gcp-project:us-central1:production-postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        username: 'postgres',
        password: 'db-secret',
        database: 'app',
      },
      createdAt: now,
      updatedAt: now,
    };

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);

    expect(access).toMatchObject({
      source: 'private_connector',
      temporary: true,
    });
    expect(access.releaseToken).toEqual(expect.any(String));
    expect(access.connectionUrl).toMatch(/^postgresql:\/\/postgres:db-secret@localhost\/app\?host=/);
    expect(startLocalProxy).toHaveBeenCalledWith({
      instanceConnectionName: 'gcp-project:us-central1:production-postgres',
      ipType: IpAddressTypes.PUBLIC,
      listenOptions: { path: expect.stringMatching(/hv-cloudsql-.*\.s\.PGSQL\.5432$/) },
    });

    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);
    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a failed connector acquisition before surfacing the error', async () => {
    const adapter = await connectedAdapter();
    vi.spyOn(Connector.prototype, 'startLocalProxy').mockRejectedValue(new Error('connector denied'));
    const close = vi.spyOn(Connector.prototype, 'close').mockImplementation(() => {});
    const now = new Date();
    const environment = {
      id: 'env-1', projectId: 'project-1', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
    } as Environment;
    const component = {
      id: 'component-1', environmentId: environment.id, type: 'postgres', externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql', connectionName: 'gcp-project:us-central1:production-postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        username: 'postgres', password: 'db-secret', database: 'app',
      },
      createdAt: now, updatedAt: now,
    } as Component;

    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432))
      .rejects.toThrow('connector denied');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('waits for terminal absence after Cloud SQL accepts deletion', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDSQL_DELETE_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_CLOUDSQL_DELETE_DELAY_MS', '0');
    const adapter = await connectedAdapter();
    let instanceRead = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/instances/production-postgres') && method === 'GET') {
        instanceRead += 1;
        return instanceRead < 3
          ? Response.json({
              name: 'production-postgres',
              state: instanceRead === 1 ? 'RUNNABLE' : 'PENDING_DELETE',
              region: 'us-central1',
            })
          : new Response('not found', { status: 404 });
      }
      if (url.endsWith('/instances/production-postgres') && method === 'DELETE') {
        return Response.json({ name: 'delete-instance-op' });
      }
      if (url.endsWith('/operations/delete-instance-op') && method === 'GET') {
        return Response.json({ name: 'delete-instance-op', status: 'DONE' });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Deleted Cloud SQL instance');
    expect(instanceRead).toBe(3);
  });

  it('treats an already-absent Cloud SQL instance as idempotent success', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('not found', { status: 404 });
      throw new Error(`Unexpected request: ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('does not mistake a failed Cloud SQL deletion preflight for absence', async () => {
    const adapter = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('backend unavailable', { status: 503 })));
    const component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'production-postgres',
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('503 backend unavailable');
  });

  it('refuses retained cleanup when the recorded GCP project scope differs from the connection', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const component = {
      id: 'retained:legacy-db',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'legacy-db',
      bindings: {
        provider: 'cloudsql',
        providerScope: { projectId: 'different-project', region: 'us-central1' },
        retainedCleanup: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Component;

    const result = await adapter.destroy(component);

    expect(result.success).toBe(false);
    expect(result.error).toContain('different-project');
    expect(result.error).toContain('gcp-project');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
