import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter, type RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';
import '../providers.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { importProvider } from '../import-provider.js';

const datastoreCases = [
  {
    kind: 'database' as const,
    id: 'shared-railway-postgres',
    name: 'primary-data',
    image: 'postgres:17',
    retainedKey: 'previousDatabase',
  },
  {
    kind: 'cache' as const,
    id: 'shared-railway-redis',
    name: 'primary-cache',
    image: 'redis:7',
    retainedKey: 'previousCache',
  },
];

function railwayDatastoreProject(
  datastore: (typeof datastoreCases)[number],
  projectId: string,
  environmentIds: string[]
): RailwayProjectDetails {
  return {
    id: projectId,
    name: `${projectId}-app`,
    environments: {
      edges: environmentIds.map((environmentId) => ({
        node: { id: environmentId, name: environmentId },
      })),
    },
    services: {
      edges: [{
        node: {
          id: datastore.id,
          name: datastore.name,
          repoTriggers: { edges: [] },
          serviceInstances: {
            edges: environmentIds.map((environmentId) => ({
              node: {
                environmentId,
                domains: { serviceDomains: [], customDomains: [] },
                source: { image: datastore.image },
              },
            })),
          },
        },
      }],
    },
    plugins: { edges: [] },
  };
}

describe('retained datastore import hosting scope', () => {
  let ctx: CommandContext;
  let directory: string;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-retained-import-scope-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();

    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'token' }),
    });
    connections.updateStatus(connection.id, 'verified');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  function mockInventory(datastore: (typeof datastoreCases)[number]) {
    const project = railwayDatastoreProject(datastore, 'railway-project', [
      'railway-production',
      'railway-staging',
    ]);
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'listProjects').mockResolvedValue([{ id: project.id, name: project.name }]);
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(project);
  }

  async function importRetained(
    datastore: (typeof datastoreCases)[number],
    platformBindings: Record<string, unknown>
  ) {
    const project = ctx.repos.projects.create({
      name: `railway-${datastore.kind}-scope-app`,
      defaultPlatform: 'railway',
    });
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings,
    });
    mockInventory(datastore);

    const result = await importProvider(ctx, {
      provider: 'railway',
      mode: datastore.kind === 'database'
        ? 'retained-database-cleanup'
        : 'retained-cache-cleanup',
      project: project.name,
      env: environment.name,
      id: datastore.id,
      confirm: true,
    });
    return { result, environment };
  }

  it.each(datastoreCases)(
    'selects the exact $kind candidate from the current compatible hosting scope',
    async (datastore) => {
      const { result, environment } = await importRetained(datastore, {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-staging',
      });

      expect(result).toMatchObject({ ok: true });
      expect(ctx.repos.environments.findById(environment.id)?.platformBindings[datastore.retainedKey])
        .toMatchObject({
          externalId: datastore.id,
          resourceKind: 'service',
          providerScope: {
            projectId: 'railway-project',
            environmentId: 'railway-staging',
          },
        });
    }
  );

  it.each(datastoreCases)(
    'selects the exact $kind candidate from retained compatible hosting scope after a provider switch',
    async (datastore) => {
      const { result, environment } = await importRetained(datastore, {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        previousHosting: {
          provider: 'railway',
          projectId: 'railway-project',
          environmentId: 'railway-staging',
          services: {},
        },
      });

      expect(result).toMatchObject({ ok: true });
      expect(ctx.repos.environments.findById(environment.id)?.platformBindings[datastore.retainedKey])
        .toMatchObject({
          externalId: datastore.id,
          resourceKind: 'service',
          providerScope: {
            projectId: 'railway-project',
            environmentId: 'railway-staging',
          },
        });
    }
  );

  it.each(datastoreCases)(
    'blocks ambiguous shared $kind ids when the compatible hosting scope is incomplete',
    async (datastore) => {
      const { result, environment } = await importRetained(datastore, {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        previousHosting: {
          provider: 'railway',
          projectId: 'railway-project',
          services: {},
        },
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(ctx.repos.environments.findById(environment.id)?.platformBindings[datastore.retainedKey])
        .toBeUndefined();
    }
  );
});
