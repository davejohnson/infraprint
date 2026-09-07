import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import type { Component } from '../../entities/component.entity.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { buildDatabaseEnvVarsFromComponent } from '../database-env.js';

function component(
  provider: string,
  bindings: Record<string, unknown> = {}
): Component {
  const now = new Date();
  return {
    id: `component-${provider}`,
    environmentId: 'env-1',
    type: 'postgres',
    externalId: `database-${provider}`,
    bindings: { provider, ...bindings },
    createdAt: now,
    updatedAt: now,
  };
}

describe('database runtime projection registry', () => {
  it('projects the shared PostgreSQL contract for every registered database provider', () => {
    const connectionUrl = 'postgresql://app:secret@db.internal:5433/app';
    const providers = providerRegistry.namesFor('database').sort();

    expect(providers).toEqual([
      'azure-postgres',
      'cloudsql',
      'digitalocean',
      'fly',
      'neon',
      'railway',
      'rds',
      'supabase',
    ]);
    for (const provider of providers) {
      const env = buildDatabaseEnvVarsFromComponent(component(provider, {
        connectionString: connectionUrl,
        pooledUrl: `${connectionUrl}?pool=true`,
        port: 5433,
        username: 'app',
        password: 'secret',
        database: 'app',
      })).envVars;

      expect(env, provider).toMatchObject({
        DATABASE_URL: connectionUrl,
        DIRECT_URL: connectionUrl,
        DATABASE_POOLER_URL: `${connectionUrl}?pool=true`,
        DATABASE_PORT: '5433',
        DB_PORT: '5433',
        PGPORT: '5433',
        DATABASE_USER: 'app',
        DB_USER: 'app',
        PGUSER: 'app',
        DATABASE_PASSWORD: 'secret',
        DB_PASSWORD: 'secret',
        PGPASSWORD: 'secret',
        DATABASE_NAME: 'app',
        DB_NAME: 'app',
        PGDATABASE: 'app',
      });
      expect(env.DATABASE_SSL, provider).toBe(provider === 'supabase' ? 'true' : undefined);
    }
  });

  it('keeps Railway legacy plugin references inside Railway runtime projection', () => {
    const projection = buildDatabaseEnvVarsFromComponent(component('railway', {
      pluginName: 'primary-postgres',
      connectionUrl: '${{primary-postgres.DATABASE_URL}}',
      username: 'ignored-for-legacy-reference',
    }));

    expect(projection).toEqual({
      envVars: {
        DATABASE_URL: '${{primary-postgres.DATABASE_URL}}',
        DIRECT_URL: '${{primary-postgres.DATABASE_PRIVATE_URL}}',
      },
      connectionUrl: '${{primary-postgres.DATABASE_URL}}',
    });
  });
});

describe('database read replica environment wiring', () => {
  it('projects named and single-replica read URLs without exposing them outside env sync', () => {
    const now = new Date();
    const component: Component = {
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'primary-1',
      bindings: {
        provider: 'cloudsql',
        connectionName: 'project:us-central1:primary-1',
        username: 'app',
        password: 'secret',
        database: 'app',
        resilience: {
          replicas: {
            analytics: { connectionName: 'project:us-west1:replica-1', externalId: 'replica-1' },
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    const env = buildDatabaseEnvVarsFromComponent(component).envVars;
    expect(env.CLOUD_SQL_CONNECTION_NAME).toBe('project:us-central1:primary-1,project:us-west1:replica-1');
    expect(env.DATABASE_READ_URL_ANALYTICS).toContain('%2Fcloudsql%2Fproject%3Aus-west1%3Areplica-1');
    expect(env.DATABASE_READ_URL).toBe(env.DATABASE_READ_URL_ANALYTICS);
    expect(env.DATABASE_URL).toContain('%2Fcloudsql%2Fproject%3Aus-central1%3Aprimary-1');
  });

  it('omits the ambiguous default read URL when multiple replicas are declared', () => {
    const now = new Date();
    const component: Component = {
      id: 'component-1', environmentId: 'env-1', type: 'postgres', externalId: 'primary-1', createdAt: now, updatedAt: now,
      bindings: {
        provider: 'cloudsql', connectionName: 'p:r:primary', username: 'app', password: 'secret', database: 'app',
        resilience: { replicas: { east: { connectionName: 'p:e:east' }, west: { connectionName: 'p:w:west' } } },
      },
    };
    const env = buildDatabaseEnvVarsFromComponent(component).envVars;
    expect(env.DATABASE_READ_URL).toBeUndefined();
    expect(env.DATABASE_READ_URL_EAST).toBeTruthy();
    expect(env.DATABASE_READ_URL_WEST).toBeTruthy();
  });
});
