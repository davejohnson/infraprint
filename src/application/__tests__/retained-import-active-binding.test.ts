import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { MemorystoreAdapter } from '../../adapters/providers/gcp/memorystore.adapter.js';
import '../providers.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { importProvider } from '../import-provider.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';

describe('retained datastore import active-binding safety', () => {
  let ctx: CommandContext;
  let project: Project;
  let targetEnvironment: Environment;
  let siblingEnvironment: Environment;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-retained-import-binding-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'retained-import-binding-safety',
      defaultPlatform: 'railway',
    });
    targetEnvironment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway' },
    });
    siblingEnvironment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
  });

  function createVerifiedConnection(provider: string) {
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider,
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: '{}',
      }),
    });
    connections.updateStatus(connection.id, 'verified');
  }

  it('rejects a retained database identity actively bound in another project environment', async () => {
    const externalId = 'shared-production-database';
    const providerScope = { projectId: 'gcp-project', region: 'us-west1' };
    const otherProject = ctx.repos.projects.create({
      name: 'other-local-project',
      defaultPlatform: 'cloudrun',
    });
    const activeEnvironment = ctx.repos.environments.create({
      projectId: otherProject.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun' },
    });
    ctx.repos.components.create({
      environmentId: activeEnvironment.id,
      type: 'postgres',
      externalId,
      bindings: { provider: 'cloudsql', instanceId: externalId, providerScope },
    });
    createVerifiedConnection('cloudsql');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: externalId,
        name: externalId,
        engine: 'postgres',
        providerScope,
      }],
      truncated: false,
      partial: false,
    });

    const result = await importProvider(ctx, {
      provider: 'cloudsql',
      mode: 'retained-database-cleanup',
      project: project.name,
      env: targetEnvironment.name,
      id: externalId,
      confirm: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(ctx.repos.environments.findById(targetEnvironment.id)?.platformBindings.previousDatabase)
      .toBeUndefined();
    expect(ctx.repos.components.findByEnvironmentId(activeEnvironment.id)).toEqual([
      expect.objectContaining({ externalId, bindings: expect.objectContaining({ providerScope }) }),
    ]);
  });

  it('rejects a retained cache identity actively bound in another project environment', async () => {
    const externalId = 'projects/gcp-project/locations/us-west1/instances/shared-cache';
    const providerScope = { projectId: 'gcp-project', region: 'us-west1' };
    ctx.repos.components.create({
      environmentId: siblingEnvironment.id,
      type: 'redis',
      externalId,
      bindings: { provider: 'memorystore', instanceId: externalId, providerScope },
    });
    createVerifiedConnection('memorystore');
    vi.spyOn(MemorystoreAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(MemorystoreAdapter.prototype, 'inspectCacheResources').mockResolvedValue({
      observation: 'present',
      resource: 'cache',
      caches: [{
        id: externalId,
        name: 'shared-cache',
        engine: 'redis',
        providerScope,
      }],
      truncated: false,
      partial: false,
    });

    const result = await importProvider(ctx, {
      provider: 'memorystore',
      mode: 'retained-cache-cleanup',
      project: project.name,
      env: targetEnvironment.name,
      id: externalId,
      confirm: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(ctx.repos.environments.findById(targetEnvironment.id)?.platformBindings.previousCache)
      .toBeUndefined();
    expect(ctx.repos.components.findByEnvironmentId(siblingEnvironment.id)).toEqual([
      expect.objectContaining({ externalId, bindings: expect.objectContaining({ providerScope }) }),
    ]);
  });

  it.each(['instanceId', 'serviceId'] as const)(
    'rejects a retained database when stale externalId conflicts with a matching bindings.%s',
    async (bindingKey) => {
      const externalId = 'shared-production-database';
      const providerScope = { projectId: 'gcp-project', region: 'us-west1' };
      const active = ctx.repos.components.create({
        environmentId: siblingEnvironment.id,
        type: 'postgres',
        externalId: 'stale-local-database-id',
        bindings: {
          provider: 'cloudsql',
          [bindingKey]: externalId,
          providerScope,
        },
      });
      createVerifiedConnection('cloudsql');
      vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
      vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
      vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
        observation: 'present',
        resource: 'database',
        databases: [{
          id: externalId,
          name: externalId,
          engine: 'postgres',
          providerScope,
        }],
        truncated: false,
        partial: false,
      });

      const result = await importProvider(ctx, {
        provider: 'cloudsql',
        mode: 'retained-database-cleanup',
        project: project.name,
        env: targetEnvironment.name,
        id: externalId,
        confirm: true,
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(ctx.repos.environments.findById(targetEnvironment.id)?.platformBindings.previousDatabase)
        .toBeUndefined();
      expect(ctx.repos.components.findById(active.id)).toMatchObject({
        externalId: 'stale-local-database-id',
        bindings: expect.objectContaining({ [bindingKey]: externalId, providerScope }),
      });
    }
  );
});
