import type { Component } from '../entities/component.entity.js';
import {
  providerRegistry,
  type DatabaseRuntimeProjection,
} from '../registry/provider.registry.js';
import type { DatabaseSpec, ServiceSpec } from '../spec/spec.schema.js';

/** Runtime keys owned by a declared database component. */
export const DATABASE_ENV_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'CLOUD_SQL_CONNECTION_NAME',
  'INSTANCE_CONNECTION_NAME',
  'DATABASE_HOST',
  'DB_HOST',
  'PGHOST',
  'DATABASE_SSL',
  'DATABASE_POOLER_URL',
  'DATABASE_PORT',
  'DB_PORT',
  'PGPORT',
  'DATABASE_USER',
  'DB_USER',
  'PGUSER',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'PGPASSWORD',
  'DATABASE_NAME',
  'DB_NAME',
  'PGDATABASE',
  'DATABASE_READ_URL',
] as const;

export type DatabaseEnvAliasSource = 'DATABASE_URL' | 'DIRECT_URL';

export function buildDatabaseAliasEnvVars(
  managedEnvVars: Record<string, string>,
  aliases: ServiceSpec['databaseEnvAliases']
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [alias, source] of Object.entries(aliases ?? {})) {
    const value = managedEnvVars[source as DatabaseEnvAliasSource];
    if (value !== undefined) {
      resolved[alias] = value;
    }
  }
  return resolved;
}

export function buildManagedDatabaseEnvVars(
  databaseSpec: DatabaseSpec | undefined,
  components: Component[]
): Record<string, string> | undefined {
  if (!databaseSpec) return undefined;
  const component = components.find((candidate) => candidate.type === databaseSpec.engine);
  if (!component) return undefined;
  const provider = stringBinding(component.bindings as Record<string, unknown>, 'provider');
  if (provider !== databaseSpec.provider) return undefined;
  return buildDatabaseEnvVarsFromComponent(component).envVars;
}

function stringBinding(bindings: Record<string, unknown>, key: string): string | undefined {
  const value = bindings[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function portBinding(bindings: Record<string, unknown>, fallback: number): string {
  const value = bindings.port;
  return typeof value === 'number' || typeof value === 'string' ? String(value) : String(fallback);
}

export function databaseReplicaEnvKey(name: string): string {
  return `DATABASE_READ_URL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function buildStandardDatabaseRuntimeProjection(component: Component): DatabaseRuntimeProjection {
  const bindings = component.bindings as Record<string, unknown>;
  const envVars: Record<string, string> = {};
  const connectionUrl = stringBinding(bindings, 'connectionUrl') ?? stringBinding(bindings, 'connectionString');
  const username = stringBinding(bindings, 'username');
  const password = stringBinding(bindings, 'password');
  const database = stringBinding(bindings, 'database');
  const port = portBinding(bindings, 5432);

  if (connectionUrl) {
    envVars.DATABASE_URL = connectionUrl;
    envVars.DIRECT_URL = connectionUrl;
  }
  const host = stringBinding(bindings, 'host');
  if (host) {
    envVars.DATABASE_HOST = host;
    envVars.DB_HOST = host;
    envVars.PGHOST = host;
  }

  if (stringBinding(bindings, 'pooledUrl')) {
    envVars.DATABASE_POOLER_URL = stringBinding(bindings, 'pooledUrl')!;
  }
  envVars.DATABASE_PORT = port;
  envVars.DB_PORT = port;
  envVars.PGPORT = port;
  if (username) {
    envVars.DATABASE_USER = username;
    envVars.DB_USER = username;
    envVars.PGUSER = username;
  }
  if (password) {
    envVars.DATABASE_PASSWORD = password;
    envVars.DB_PASSWORD = password;
    envVars.PGPASSWORD = password;
  }
  if (database) {
    envVars.DATABASE_NAME = database;
    envVars.DB_NAME = database;
    envVars.PGDATABASE = database;
  }

  return { envVars, connectionUrl };
}

export function buildDatabaseEnvVarsFromComponent(component: Component): DatabaseRuntimeProjection {
  const standard = buildStandardDatabaseRuntimeProjection(component);
  const bindings = component.bindings as Record<string, unknown>;
  const provider = stringBinding(bindings, 'provider');
  const projection = provider
    ? providerRegistry.get(provider)?.databaseRuntime
    : undefined;
  return projection?.project(component, standard) ?? standard;
}
