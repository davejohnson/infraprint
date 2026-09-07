import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { diffEnvironment, confirmGatedActionIds } from '../diff.engine.js';
import { hashEnvValue, type ObservedState, type ObservedService } from '../../ports/observe.port.js';
import { environmentSpecSchema, type EnvironmentSpec } from '../../spec/spec.schema.js';
import type { LocalSnapshot } from '../plan.types.js';
import type { Service } from '../../entities/service.entity.js';
import type { Component } from '../../entities/component.entity.js';
import { bindingIdentityFingerprint } from '../../services/binding-identity.js';

function spec(overrides: Record<string, unknown> = {}): EnvironmentSpec {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { web: { startCommand: 'npm start', healthCheckPath: '/health', public: true } },
    database: { provider: 'railway' },
    envVars: { NODE_ENV: 'production' },
    ...overrides,
  });
}

function observedWeb(overrides: Partial<ObservedService> = {}): ObservedService {
  return {
    name: 'web',
    externalId: 'svc-1',
    workloadKind: 'web',
    url: 'https://web.up.railway.app',
    customDomains: [],
    config: { startCommand: 'npm start', healthCheckPath: '/health', public: true },
    envVarKeys: ['NODE_ENV'],
    envVarHashes: { NODE_ENV: hashEnvValue('production') },
    status: 'running',
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rail-proj-1',
    environmentId: 'rail-env-1',
    services: [observedWeb()],
    databases: [{ provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running' }],
    partial: false,
    warnings: [],
    ...overrides,
  };
}

function localService(name: string): Service {
  return {
    id: `local-${name}`,
    projectId: 'p1',
    name,
    buildConfig: {},
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function localComponent(bindings: Record<string, unknown> = {}): Component {
  return {
    id: 'local-postgres',
    environmentId: 'env-1',
    type: 'postgres',
    bindings,
    externalId: 'db-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function local(overrides: Partial<LocalSnapshot> = {}): LocalSnapshot {
  return {
    projectExists: true,
    environmentExists: true,
    services: [localService('web')],
    components: [localComponent({ provider: 'railway' })],
    bindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
      services: { web: { serviceId: 'svc-1' } },
    },
    ...overrides,
  };
}

function localWithDomain(params: {
  provider?: string;
  proxied?: boolean;
  recreateRevision?: string;
  withDnsRecords?: boolean;
} = {}): LocalSnapshot {
  return local({
    bindings: {
      provider: params.provider ?? 'railway',
      projectId: params.provider === 'cloudrun' ? 'gcp-project' : 'rail-proj-1',
      environmentId: params.provider === 'cloudrun' ? 'us-central1' : 'rail-env-1',
      services: { web: { serviceId: 'svc-1', customDomains: ['myapp.dev'] } },
      domainDns: {
        name: 'myapp.dev',
        proxied: params.proxied ?? true,
        providerDomainId: 'provider-domain-1',
        serviceName: 'web',
        serviceId: 'svc-1',
        environmentId: params.provider === 'cloudrun' ? 'us-central1' : 'rail-env-1',
        zoneId: 'zone-1',
        records: params.withDnsRecords === false
          ? []
          : [{
              id: 'dns-1',
              name: 'myapp.dev',
              type: 'CNAME',
              target: 'provider.example',
            }],
        ...(params.recreateRevision
          ? { recreateRevision: params.recreateRevision }
          : {}),
      },
    },
  });
}

describe('diffEnvironment — in sync', () => {
  it('returns noops when everything matches', () => {
    const result = diffEnvironment({ spec: spec(), envName: 'production', observed: observed(), local: local() });
    expect(result.actions.every((a) => a.type === 'noop')).toBe(true);
    expect(result.actions.every((a) => a.verified)).toBe(true);
    expect(result.unmanaged).toEqual([]);
  });
});

describe('diffEnvironment — incomplete database provisioning', () => {
  const incompleteBindings = {
    provider: 'railway',
    instanceId: 'db-1',
    providerScope: { projectId: 'rail-proj-1' },
    provisioningIncomplete: true,
    previousProvider: 'cloudsql',
    previousExternalId: 'projects/old/instances/postgres',
    previousBindings: {
      provider: 'cloudsql',
      instanceId: 'projects/old/instances/postgres',
      providerScope: { projectId: 'old', region: 'us-central1' },
      connectionUrl: 'postgres://previous-local-secret',
    },
  };

  it('never promotes a retained failed create to noop or old-provider cleanup', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          providerScope: { projectId: 'rail-proj-1' },
          status: 'running',
        }],
      }),
      local: local({ components: [localComponent(incompleteBindings)] }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'database_provision_incomplete', externalId: 'db-1' },
    });
    expect(result.actions.some((action) => action.id === 'database:cloudsql:destroy')).toBe(false);
    expect(result.actions.some((action) => action.type === 'noop' && action.resource.kind === 'database')).toBe(false);
    expect(result.actions.find((action) => action.id === 'service:web')?.dependsOn)
      .toContain('database:railway');
  });

  it('blocks another billable create while a provider-assigned database identity remains unresolved', () => {
    const unresolved = localComponent({
      provider: 'neon',
      providerScope: { organizationId: 'neon-org' },
      provisioningIncomplete: true,
      unresolvedMutation: {
        resourceKind: 'database',
        operation: 'create',
        resourceName: 'invoice-perfect-production-postgres',
        providerScope: { organizationId: 'neon-org' },
      },
    });
    unresolved.externalId = null;
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'neon' } }),
      envName: 'production',
      observed: observed({ databases: [] }),
      local: local({ components: [unresolved] }),
    });

    expect(result.actions.find((action) => action.id === 'database:neon')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: {
        blockedReason: 'database_unresolved_create_unknown',
        resourceName: 'invoice-perfect-production-postgres',
        providerScope: { organizationId: 'neon-org' },
      },
    });
    expect(result.actions.some((action) => (
      action.resource.kind === 'database' && action.type === 'create'
    ))).toBe(false);
    expect(result.actions.find((action) => action.id === 'service:web')?.dependsOn)
      .toContain('database:neon');
    expect(result.warnings).toContainEqual(expect.stringContaining(
      'hv_import mode="retained-database-cleanup"'
    ));
  });

  it('offers only exact confirm-gated cleanup when the incomplete database is removed from desired state', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          providerScope: { projectId: 'rail-proj-1' },
          status: 'provisioning',
        }],
      }),
      local: local({ components: [localComponent(incompleteBindings)] }),
    });

    const databaseActions = result.actions.filter((action) => action.resource.kind === 'database');
    expect(databaseActions).toHaveLength(1);
    expect(databaseActions[0]).toMatchObject({
      id: 'database:railway:destroy',
      type: 'destroy',
      requiresConfirm: true,
      dataBearing: true,
      metadata: {
        externalId: 'db-1',
        providerScope: { projectId: 'rail-proj-1' },
        incompleteProvision: true,
      },
    });
  });
});

describe('diffEnvironment — creates', () => {
  it('creates project and services when nothing exists', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: observed({ projectExists: false, services: [], databases: [] }),
      local: local({ bindings: undefined, services: [], components: [] }),
    });
    const byId = new Map(result.actions.map((a) => [a.id, a]));
    expect(byId.get('project:railway')?.type).toBe('create');
    expect(byId.get('service:web')?.type).toBe('create');
    expect(byId.get('service:web')?.dependsOn).toEqual(['project:railway', 'database:railway']);
    expect(byId.get('database:railway')?.type).toBe('create');
    expect(result.warnings).toContainEqual(expect.stringContaining(
      'cannot prove application code consumes it'
    ));
  });

  it('orders a same-cloud database behind a differently named hosting project', () => {
    const result = diffEnvironment({
      spec: spec({
        hosting: { provider: 'azure-container-apps' },
        database: { provider: 'azure-postgres' },
      }),
      envName: 'production',
      observed: observed({
        provider: 'azure-container-apps',
        projectExists: false,
        projectId: undefined,
        environmentId: undefined,
        services: [],
        databases: [],
      }),
      local: local({ bindings: undefined, services: [], components: [] }),
      databaseDependsOnHostingProject: true,
    });

    const database = result.actions.find((action) => action.id === 'database:azure-postgres');
    expect(database).toMatchObject({
      type: 'create',
      dependsOn: ['project:azure-container-apps'],
    });
  });

  it('confirmation-gates service creation when provider metadata marks it billable', () => {
    const result = diffEnvironment({
      spec: spec({
        hosting: { provider: 'billable-host' },
        database: undefined,
      }),
      envName: 'production',
      observed: observed({
        provider: 'billable-host',
        projectExists: true,
        projectId: 'tea-owner-1',
        services: [],
        databases: [],
      }),
      local: local({
        services: [],
        components: [],
        bindings: {
          provider: 'billable-host',
          projectId: 'tea-owner-1',
          services: {},
        },
      }),
      providerBehavior: { serviceCreatesBillable: true },
    });

    expect(result.actions.find((action) => action.id === 'service:web'))
      .toMatchObject({
        type: 'create',
        billable: true,
        requiresConfirm: true,
      });
    expect(confirmGatedActionIds(result.actions)).toContain('service:web');
  });

  it('recreates an absent stateless service but blocks replacement of an absent bound database', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: observed({ services: [], databases: [] }),
      local: local({
        services: [localService('web')],
        components: [localComponent({ provider: 'railway', resourceKind: 'service', pluginName: 'postgres-db' })],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-staging',
          services: { web: { serviceId: 'svc-web' } },
        },
      }),
    });

    const byId = new Map(result.actions.map((a) => [a.id, a]));
    expect(byId.get('service:web')?.type).toBe('create');
    expect(byId.get('database:railway')).toMatchObject({
      type: 'update',
      metadata: { blockedReason: 'database_binding_absent', boundExternalId: 'db-1' },
    });
  });
});

describe('diffEnvironment — private cache networking', () => {
  it('plans service drift when live Direct VPC egress differs from the durable cache binding', () => {
    const cacheNetwork = {
      provider: 'cloudrun',
      projectId: 'gcp-project',
      region: 'us-central1',
      network: 'projects/gcp-project/global/networks/default',
      subnetwork: 'projects/gcp-project/regions/us-central1/subnetworks/default',
      egress: 'PRIVATE_RANGES_ONLY',
    };
    const currentLocal = local();
    const result = diffEnvironment({
      spec: spec({ cache: { provider: 'memorystore' } }),
      envName: 'production',
      observed: observed({ services: [observedWeb()] }),
      local: {
        ...currentLocal,
        bindings: { ...currentLocal.bindings!, cacheNetwork },
      },
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      diff: expect.arrayContaining([{ field: 'cacheNetwork' }]),
    });
  });
});

describe('diffEnvironment — config drift', () => {
  it('plans explicit project runtime drift without claiming provider verification', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed(),
      local: local(),
      projectRuntime: { kind: 'node', version: '24' },
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      verified: false,
      diff: [{ field: 'runtime', from: 'undeclared', to: 'node:24 install=undeclared build=none' }],
    });
  });

  it('detects changed startCommand and missing env var', () => {
    const live = observedWeb({
      config: { startCommand: 'node old.js', healthCheckPath: '/health', public: true },
      envVarKeys: [],
      envVarHashes: {},
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.verified).toBe(true);
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });
    expect(web.diff).toContainEqual({ field: 'env:NODE_ENV' });
  });

  it('detects env var drift by hash without exposing values', () => {
    const live = observedWeb({ envVarHashes: { NODE_ENV: hashEnvValue('staging') } });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    const envDiff = web.diff!.find((d) => d.field === 'env:NODE_ENV')!;
    expect(envDiff.from).toBeUndefined();
    expect(envDiff.to).toBeUndefined();
  });

  it('detects managed database env var drift after a database component exists', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'DATABASE_URL'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        DATABASE_URL: hashEnvValue('postgres://old'),
      },
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
      managedDatabaseEnvVars: {
        DATABASE_URL: 'postgres://new',
        DATABASE_SSL: 'true',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'env:DATABASE_URL' });
    expect(web.diff).toContainEqual({ field: 'env:DATABASE_SSL' });
  });

  it('treats Railway managed database references as converged when the env var exists', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'DATABASE_URL', 'DIRECT_URL'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        // Railway may return resolved values for variables Hypervibe set as
        // ${{postgres-db.*}} references, so the exact hash is not stable.
        DATABASE_URL: hashEnvValue('postgres://resolved-internal-url'),
        DIRECT_URL: hashEnvValue('postgres://resolved-private-url'),
      },
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
      providerBehavior: {
        presenceOnlyManagedEnvVar: ({ value }) => /^\$\{\{[^}]+\}\}$/.test(value),
      },
      managedDatabaseEnvVars: {
        DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
        DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect((web.diff ?? []).some((entry) => entry.field === 'env:DATABASE_URL')).toBe(false);
    expect((web.diff ?? []).some((entry) => entry.field === 'env:DIRECT_URL')).toBe(false);
  });

  it('still detects missing Railway managed database references', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'DATABASE_URL'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        DATABASE_URL: hashEnvValue('postgres://resolved-internal-url'),
      },
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
      providerBehavior: {
        presenceOnlyManagedEnvVar: ({ value }) => /^\$\{\{[^}]+\}\}$/.test(value),
      },
      managedDatabaseEnvVars: {
        DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
        DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect((web.diff ?? []).some((entry) => entry.field === 'env:DATABASE_URL')).toBe(false);
    expect(web.diff).toContainEqual({ field: 'env:DIRECT_URL' });
  });

  it('verifies per-service database aliases by presence for Railway references', () => {
    const environment = spec({
      services: {
        web: {
          workloadKind: 'web',
          startCommand: 'npm start',
          healthCheckPath: '/health',
          public: true,
          databaseEnvAliases: {
            POSTGRES_DB_URL: 'DATABASE_URL',
          },
        },
      },
    });
    const baseLive = observedWeb({
      envVarKeys: ['NODE_ENV', 'DATABASE_URL', 'DIRECT_URL'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        DATABASE_URL: hashEnvValue('postgres://resolved-internal-url'),
        DIRECT_URL: hashEnvValue('postgres://resolved-private-url'),
      },
    });
    const inputs = {
      spec: environment,
      envName: 'production',
      local: local(),
      providerBehavior: {
        presenceOnlyManagedEnvVar: ({ value }: { value: string }) => /^\$\{\{[^}]+\}\}$/.test(value),
      },
      managedDatabaseEnvVars: {
        DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
        DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
      },
    };

    const missing = diffEnvironment({
      ...inputs,
      observed: observed({ services: [baseLive] }),
    });
    expect(missing.actions.find((action) => action.id === 'service:web')?.diff)
      .toContainEqual({ field: 'env:POSTGRES_DB_URL' });

    const attached = diffEnvironment({
      ...inputs,
      observed: observed({
        services: [{
          ...baseLive,
          envVarKeys: [...baseLive.envVarKeys, 'POSTGRES_DB_URL'],
          envVarHashes: {
            ...baseLive.envVarHashes,
            POSTGRES_DB_URL: hashEnvValue('postgres://resolved-internal-url'),
          },
        }],
      }),
    });
    expect(attached.actions.find((action) => action.id === 'service:web')?.type).toBe('noop');
  });

  it('compares Railway-style references exactly for non-Railway hosts', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'DATABASE_URL'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        DATABASE_URL: hashEnvValue('postgres://resolved-internal-url'),
      },
    });
    const result = diffEnvironment({
      spec: spec({ hosting: { provider: 'cloudrun' } }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local({
        bindings: {
          provider: 'cloudrun',
          services: { web: { serviceId: 'svc-1' } },
        },
      }),
      managedDatabaseEnvVars: {
        DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.diff).toContainEqual({ field: 'env:DATABASE_URL' });
  });

  it('merges managed queue env vars into the desired env, with spec.envVars winning on conflict', () => {
    const live = observedWeb({
      envVarKeys: ['NODE_ENV', 'QUEUE_BACKEND', 'QUEUE_NAMES'],
      envVarHashes: {
        NODE_ENV: hashEnvValue('production'),
        QUEUE_BACKEND: hashEnvValue('pubsub'),
        // Live matches the spec override, not the managed queue value.
        QUEUE_NAMES: hashEnvValue('spec-wins'),
      },
    });
    const result = diffEnvironment({
      spec: spec({ envVars: { NODE_ENV: 'production', QUEUE_NAMES: 'spec-wins' } }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
      managedQueueEnvVars: {
        QUEUE_BACKEND: 'pubsub',
        QUEUE_NAMES: 'email-jobs',
        QUEUE_TOPIC_EMAIL_JOBS: 'projects/gcp-project/topics/gcp-project-email-jobs',
      },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    // Queue-only var missing live → drift.
    expect(web.diff).toContainEqual({ field: 'env:QUEUE_TOPIC_EMAIL_JOBS' });
    // spec.envVars wins over managedQueueEnvVars, so QUEUE_NAMES is in sync.
    expect(web.diff).not.toContainEqual({ field: 'env:QUEUE_NAMES' });
    expect(web.diff).not.toContainEqual({ field: 'env:QUEUE_BACKEND' });
  });

  it('ignores config fields the spec does not manage', () => {
    const minimal = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { web: {} },
    });
    const live = observedWeb({ config: { startCommand: 'whatever', public: false } });
    const result = diffEnvironment({
      spec: minimal,
      envName: 'production',
      observed: observed({ services: [live], databases: [] }),
      local: local(),
    });
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
  });
});

describe('diffEnvironment — explicit environment variable retirement', () => {
  it('confirm-gates deletion only when an explicitly retired key is live', () => {
    const result = diffEnvironment({
      spec: spec({ removeEnvVars: ['OLD_API_TOKEN'] }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          envVarKeys: ['NODE_ENV', 'OLD_API_TOKEN'],
          envVarHashes: {
            NODE_ENV: hashEnvValue('production'),
            OLD_API_TOKEN: hashEnvValue('secret-value'),
          },
        })],
      }),
      local: local(),
    });

    const removal = result.actions.find((action) => action.id === 'service:web:env-remove');
    expect(removal).toMatchObject({
      type: 'update',
      requiresConfirm: true,
      verified: true,
      metadata: {
        operation: 'hostingEnvRemove',
        keys: ['OLD_API_TOKEN'],
      },
      diff: [{ field: 'env:OLD_API_TOKEN', from: 'present', to: 'absent' }],
    });
    expect(removal?.reason).toContain('previously deployed revision');
    expect(confirmGatedActionIds(result.actions)).toContain('service:web:env-remove');
  });

  it('does not delete omitted variables or emit work for an absent tombstone', () => {
    const result = diffEnvironment({
      spec: spec({ removeEnvVars: ['ALREADY_GONE'] }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          envVarKeys: ['NODE_ENV', 'UNMANAGED_TOKEN'],
          envVarHashes: {
            NODE_ENV: hashEnvValue('production'),
            UNMANAGED_TOKEN: hashEnvValue('preserve-me'),
          },
        })],
      }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id.endsWith(':env-remove'))).toBeUndefined();
    expect(result.actions.find((action) => action.id === 'service:web')?.type).toBe('noop');
  });

  it('orders retirement after service configuration updates', () => {
    const result = diffEnvironment({
      spec: spec({
        envVars: { NODE_ENV: 'production', NEW_FEATURE_FLAG: 'enabled' },
        removeEnvVars: ['OLD_FEATURE_FLAG'],
      }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          envVarKeys: ['NODE_ENV', 'OLD_FEATURE_FLAG'],
          envVarHashes: {
            NODE_ENV: hashEnvValue('production'),
            OLD_FEATURE_FLAG: hashEnvValue('enabled'),
          },
        })],
      }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id === 'service:web')?.type).toBe('update');
    expect(result.actions.find((action) => action.id === 'service:web:env-remove')?.dependsOn)
      .toEqual(['service:web']);
  });
});

describe('diffEnvironment — provider switches', () => {
  it('creates the new database without destroying the old one in the initial provider change plan', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    const create = result.actions.find((a) => a.id === 'database:cloudsql')!;
    expect(create.type).toBe('create');
    expect(create.reason).toContain('Create the new database first');
    expect(result.actions.find((a) => a.id === 'database:railway:destroy')).toBeUndefined();
    expect(confirmGatedActionIds(result.actions)).toEqual([]);
  });

  it('blocks provider-change creation when an unbound desired-provider database already exists', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: observed({
        databases: [
          { provider: 'railway', engine: 'postgres', externalId: 'db-1', status: 'running' },
          {
            provider: 'cloudsql',
            engine: 'postgres',
            externalId: 'cloudsql-existing',
            name: 'existing-target',
            providerScope: { projectId: 'gcp-project', region: 'us-west1' },
            status: 'running',
          },
        ],
      }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id === 'database:cloudsql')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'database_adoption_required',
        externalId: 'cloudsql-existing',
      },
    });
    expect(result.actions.find((action) => (
      action.id === 'database:cloudsql' && action.type === 'create'
    ))).toBeUndefined();
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'database',
      detail: expect.stringContaining('cloudsql-existing'),
    }));
  });

  it('emits confirm-gated destroy for the previous database after cutover is recorded', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'supabase' } }),
      envName: 'production',
      observed: observed({
        databases: [{ provider: 'supabase', engine: 'postgres', externalId: 'supabase-1', status: 'running' }],
      }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: {
            provider: 'supabase',
            previousProvider: 'cloudsql',
            previousExternalId: 'cloudsql-legacy-1',
            previousBindings: {
              provider: 'cloudsql',
              instanceId: 'cloudsql-legacy-1',
              providerScope: { projectId: 'gcp-project', region: 'us-west1' },
            },
          },
          externalId: 'supabase-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });
    const create = result.actions.find((a) => a.id === 'database:supabase')!;
    const destroy = result.actions.find((a) => a.id === 'database:cloudsql:destroy')!;
    expect(create.type).toBe('noop');
    expect(destroy.type).toBe('destroy');
    expect(destroy.dataBearing).toBe(true);
    expect(destroy.requiresConfirm).toBe(true);
    expect(destroy.metadata).toEqual({
      externalId: 'cloudsql-legacy-1',
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      bindingsFingerprint: bindingIdentityFingerprint({
        provider: 'cloudsql',
        instanceId: 'cloudsql-legacy-1',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      }),
    });
    expect(destroy.verified).toBe(false);
    expect(destroy.reason).toContain('confirm only after cutover is verified');
    expect(confirmGatedActionIds(result.actions)).toEqual(['database:cloudsql:destroy']);
  });

  it('blocks retained database cleanup when its provider scope is missing', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'supabase' } }),
      envName: 'production',
      observed: observed({
        databases: [{ provider: 'supabase', engine: 'postgres', externalId: 'supabase-1', status: 'running' }],
      }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: {
            provider: 'supabase',
            previousProvider: 'cloudsql',
            previousExternalId: 'cloudsql-legacy-1',
            previousBindings: {
              provider: 'cloudsql',
              instanceId: 'cloudsql-legacy-1',
            },
          },
          externalId: 'supabase-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:cloudsql:destroy')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'database_previous_binding_incomplete' },
    });
    expect(confirmGatedActionIds(result.actions)).not.toContain('database:cloudsql:destroy');
  });

  it('replaces services when the hosting provider changes', () => {
    const result = diffEnvironment({
      spec: spec({ hosting: { provider: 'cloudrun' }, database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: null,
      local: local(),
    });
    const byId = new Map(result.actions.map((a) => [a.id, a]));
    expect(byId.get('project:cloudrun')?.type).toBe('create');
    const web = byId.get('service:web')!;
    expect(web.type).toBe('replace');
    expect(web.reason).toContain('railway');
    expect(web.dependsOn).toEqual(['project:cloudrun']);
  });

  it('confirm-gates destroy when the database is removed from the spec', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
          status: 'running',
        }],
      }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: {
            provider: 'railway',
            providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
          },
          externalId: 'db-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });
    const destroy = result.actions.find((a) => a.id === 'database:railway:destroy')!;
    expect(destroy.requiresConfirm).toBe(true);
    expect(destroy.dataBearing).toBe(true);
    expect(destroy.metadata).toEqual({
      externalId: 'db-1',
      providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
      bindingsFingerprint: bindingIdentityFingerprint({
        provider: 'railway',
        providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
      }),
    });
  });

  it('blocks database removal when the durable provider scope is missing', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          status: 'running',
        }],
      }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: { provider: 'railway' },
          externalId: 'db-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway:destroy')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'database_binding_incomplete' },
    });
    expect(confirmGatedActionIds(result.actions)).not.toContain('database:railway:destroy');
  });

  it('destroys a retained previous database before the current database when both are removed', () => {
    const previousBindings = {
      provider: 'cloudsql',
      instanceId: 'cloudsql-legacy-1',
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
    };
    const currentBindings = {
      provider: 'supabase',
      instanceId: 'supabase-current-1',
      resourceKind: 'postgres',
      providerScope: { organizationId: 'supabase-org', projectRef: 'supabase-project' },
      previousProvider: 'cloudsql',
      previousExternalId: 'cloudsql-legacy-1',
      previousBindings,
    };
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'supabase',
          engine: 'postgres',
          externalId: 'supabase-current-1',
          providerScope: { organizationId: 'supabase-org', projectRef: 'supabase-project' },
          status: 'running',
        }],
      }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: currentBindings,
          externalId: 'supabase-current-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });

    const previousDestroy = result.actions.find((action) => action.id === 'database:cloudsql:destroy')!;
    const currentDestroy = result.actions.find((action) => action.id === 'database:supabase:destroy')!;
    expect(previousDestroy).toMatchObject({
      type: 'destroy',
      verified: false,
      dataBearing: true,
      requiresConfirm: true,
      metadata: {
        externalId: 'cloudsql-legacy-1',
        providerScope: { projectId: 'gcp-project', region: 'us-west1' },
        bindingsFingerprint: bindingIdentityFingerprint(previousBindings),
      },
    });
    expect(currentDestroy.dependsOn).toContain(previousDestroy.id);
    expect(currentDestroy.metadata).toEqual({
      externalId: 'supabase-current-1',
      providerScope: { organizationId: 'supabase-org', projectRef: 'supabase-project' },
      bindingsFingerprint: bindingIdentityFingerprint({
        provider: 'supabase',
        instanceId: 'supabase-current-1',
        resourceKind: 'postgres',
        providerScope: { organizationId: 'supabase-org', projectRef: 'supabase-project' },
      }),
    });
    expect(confirmGatedActionIds(result.actions)).toEqual([
      'database:cloudsql:destroy',
      'database:supabase:destroy',
    ]);
  });

  it('plans idempotent teardown for an exact local binding when observation confirms absence', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({ databases: [] }),
      local: local({
        components: [{
          id: 'c1', environmentId: 'e1', type: 'postgres',
          bindings: {
            provider: 'railway',
            providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
          },
          externalId: 'db-1',
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
    });
    expect(result.actions.find((action) => action.id === 'database:railway:destroy')).toMatchObject({
      type: 'destroy',
      verified: true,
      requiresConfirm: true,
      metadata: {
        externalId: 'db-1',
        providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
      },
    });
  });
});

describe('diffEnvironment — unverified fallback', () => {
  it('marks all actions unverified when observe is unavailable', () => {
    const result = diffEnvironment({ spec: spec(), envName: 'staging', observed: null, local: local() });
    expect(result.actions.every((a) => a.verified === false)).toBe(true);
    expect(result.actions.find((a) => a.id === 'service:web')?.type).toBe('noop');
  });

  it('creates unbound services from local state', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: null,
      local: local({ bindings: { provider: 'railway', projectId: 'rail-proj-1', services: {} } }),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('create');
    expect(web.verified).toBe(false);
  });

  it('updates a locally bound service when explicit runtime state changes', () => {
    const existing = localService('web');
    existing.buildConfig.runtime = { kind: 'node', version: '20' };
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: null,
      local: local({ services: [existing] }),
      projectRuntime: { kind: 'python', version: '3.13' },
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      verified: false,
      diff: [{
        field: 'runtime',
        from: 'node:20 install=undeclared build=none',
        to: 'python:3.13 install=undeclared build=none',
      }],
    });
  });

  it('makes reviewed install and build command drift visible even when the language version is unchanged', () => {
    const existing = localService('web');
    existing.buildConfig.runtime = { kind: 'node', version: '24', installCommand: 'npm ci' };
    const result = diffEnvironment({
      spec: spec(),
      envName: 'staging',
      observed: null,
      local: local({ services: [existing] }),
      projectRuntime: {
        kind: 'node',
        version: '24',
        installCommand: 'pnpm install --frozen-lockfile',
        buildCommand: 'pnpm run build',
      },
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      diff: [{
        field: 'runtime',
        from: 'node:24 install="npm ci" build=none',
        to: 'node:24 install="pnpm install --frozen-lockfile" build="pnpm run build"',
      }],
    });
  });
});

describe('diffEnvironment — unmanaged resources', () => {
  it('reports live services and databases absent from the spec, never destroys them', () => {
    const rogue = observedWeb({ name: 'legacy-worker', externalId: 'svc-9' });
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({ services: [observedWeb(), rogue] }),
      local: local({ components: [] }),
    });
    expect(result.unmanaged).toContainEqual(
      expect.objectContaining({ kind: 'service', name: 'legacy-worker' })
    );
    // observed db exists but no local component → unmanaged, not destroy
    expect(result.unmanaged).toContainEqual(expect.objectContaining({ kind: 'database', name: 'postgres' }));
    expect(result.actions.filter((a) => a.type === 'destroy')).toEqual([]);
  });

  it('plans destroy for services removed from the spec when local bindings prove ownership', () => {
    const removed = observedWeb({ name: 'daily', externalId: 'svc-daily', workloadKind: 'cron' });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb(), removed] }),
      local: local({
        services: [localService('web'), localService('daily')],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' }, daily: { serviceId: 'svc-daily' } },
        },
      }),
    });

    expect(result.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'daily' }));
    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
      resource: expect.objectContaining({ kind: 'service', name: 'daily', provider: 'railway' }),
      verified: true,
      metadata: { externalId: 'svc-daily' },
    }));
  });

  it('plans one exact-target destroy and leaves a same-name duplicate unmanaged', () => {
    const removed = observedWeb({ name: 'daily', externalId: 'svc-daily', workloadKind: 'cron' });
    const duplicate = observedWeb({ name: 'daily', externalId: 'svc-replacement', workloadKind: 'cron' });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb(), removed, duplicate] }),
      local: local({
        services: [localService('web'), localService('daily')],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' }, daily: { serviceId: 'svc-daily' } },
        },
      }),
    });

    expect(result.actions.filter((action) => action.id === 'service:daily:destroy')).toEqual([
      expect.objectContaining({
        type: 'destroy',
        metadata: { externalId: 'svc-daily' },
      }),
    ]);
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'service',
      name: 'daily',
      detail: expect.stringContaining('absent from spec'),
    }));
  });

  it('does not authorize deleting a same-name replacement for a removed bound service', () => {
    const replacement = observedWeb({ name: 'daily', externalId: 'svc-replacement', workloadKind: 'cron' });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb(), replacement] }),
      local: local({
        services: [localService('web'), localService('daily')],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' }, daily: { serviceId: 'svc-original' } },
        },
      }),
    });

    expect(result.actions.filter((action) => action.id === 'service:daily:destroy')).toEqual([
      expect.objectContaining({
        type: 'destroy',
        verified: true,
        metadata: { externalId: 'svc-original' },
      }),
    ]);
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'service',
      name: 'daily',
    }));
  });

  it('plans unverified destroy for locally bound services removed from the spec when observation is unavailable', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: null,
      local: local({
        services: [localService('web'), localService('daily')],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' }, daily: { serviceId: 'svc-daily' } },
        },
      }),
    });

    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'service:daily:destroy',
      type: 'destroy',
      verified: false,
    }));
  });

  it('plans cleanup for leftover Hypervibe task services without reporting them unmanaged', () => {
    const task = observedWeb({ name: 'hv-task-123', externalId: 'task-svc-1' });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb(), task] }),
      local: local(),
    });

    expect(result.unmanaged).not.toContainEqual(expect.objectContaining({ kind: 'service', name: 'hv-task-123' }));
    expect(result.actions).toContainEqual(expect.objectContaining({
      id: 'service:hv-task-123:destroy',
      type: 'destroy',
      reason: 'Leftover Hypervibe one-off task service',
      metadata: {
        operation: 'taskServiceCleanup',
        externalId: 'task-svc-1',
      },
    }));
  });

  it('blocks ambiguous leftover task cleanup without emitting duplicate action ids', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        services: [
          observedWeb(),
          observedWeb({ name: 'hv-task-123', externalId: 'task-svc-1' }),
          observedWeb({ name: 'hv-task-123', externalId: 'task-svc-2' }),
        ],
      }),
      local: local(),
    });

    expect(result.actions.filter((action) => action.id.includes('hv-task-123'))).toEqual([]);
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'service',
      name: 'hv-task-123',
      detail: expect.stringContaining('automatic deletion is blocked'),
    }));
    expect(result.warnings).toContainEqual(expect.stringContaining('Multiple leftover task services'));
  });
});

describe('diffEnvironment — reconciliation safety', () => {
  it('blocks database creation when live database observation is unknown', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [],
        partial: true,
        completeness: { databases: 'unknown' },
      }),
      local: local({ components: [] }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'database_observation_unknown' },
    });
    expect(result.actions.some((action) => action.resource.kind === 'database' && action.type === 'create')).toBe(false);
  });

  it('preserves a bound database and blocks dependent services when observation is unknown', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [],
        partial: true,
        completeness: { databases: 'unknown' },
      }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'database_observation_unknown' },
    });
    expect(result.actions.find((action) => action.id === 'service:web')?.dependsOn)
      .toContain('database:railway');
  });

  it('blocks dependent services while the bound database is not running', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          status: 'error',
        }],
      }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'database_not_running',
        observedStatus: 'error',
        externalId: 'db-1',
      },
    });
    expect(result.actions.find((action) => action.id === 'service:web')?.dependsOn)
      .toContain('database:railway');
  });

  it.each(['failed', 'unknown'] as const)('does not report a %s service as in sync', (status) => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb({ status })] }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      verified: true,
      metadata: {
        blockedReason: `service_status_${status}`,
        observedStatus: status,
      },
    });
  });

  it('blocks replacement when complete observation says the still-desired bound database vanished', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ databases: [] }),
      local: local({
        components: [localComponent({
          provider: 'railway',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        })],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      verified: true,
      metadata: {
        blockedReason: 'database_binding_absent',
        boundExternalId: 'db-1',
      },
    });
    expect(result.actions.some((action) => (
      action.resource.kind === 'database' && action.type === 'create'
    ))).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('was not found'));
  });

  it('still stages a new provider when the old provider binding is absent from current observation', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'cloudsql' } }),
      envName: 'production',
      observed: observed({ databases: [] }),
      local: local({
        components: [localComponent({
          provider: 'railway',
          providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
        })],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:cloudsql')).toMatchObject({
      type: 'create',
      resource: { provider: 'cloudsql' },
    });
  });

  it('resolves the durable database id before reporting same-engine extras as unmanaged', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [
          { provider: 'railway', engine: 'postgres', externalId: 'db-1', name: 'Postgres', status: 'running' },
          { provider: 'railway', engine: 'postgres', externalId: 'db-duplicate', name: 'postgres-db-production', status: 'running' },
        ],
      }),
      local: local({
        components: [localComponent({ provider: 'railway' })],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'noop',
    });
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'database',
      detail: expect.stringContaining('db-duplicate'),
    }));
  });

  it('includes provider scope when resolving a durable database id', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          providerScope: { projectId: 'other-project' },
          status: 'running',
        }],
      }),
      local: local({
        components: [localComponent({
          provider: 'railway',
          providerScope: { projectId: 'rail-proj-1' },
        })],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'database_binding_identity_mismatch',
        boundExternalId: 'db-1',
        externalIds: ['db-1'],
      },
    });
    expect(result.actions.some((action) => action.resource.kind === 'database' && action.type === 'create')).toBe(false);
  });

  it('does not match a scoped local database binding to an unscoped observation', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'db-1',
          status: 'running',
        }],
      }),
      local: local({
        components: [localComponent({
          provider: 'railway',
          providerScope: { projectId: 'rail-proj-1' },
        })],
      }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'database_binding_identity_mismatch',
        boundExternalId: 'db-1',
        externalIds: ['db-1'],
      },
    });
    expect(result.actions.some((action) => action.resource.kind === 'database' && action.type === 'create')).toBe(false);
  });

  it('resolves the durable service id before reporting same-name extras as unmanaged', () => {
    const duplicate = observedWeb({ externalId: 'svc-duplicate' });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb(), duplicate] }),
      local: local(),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({ type: 'noop' });
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'service',
      detail: expect.stringContaining('svc-duplicate'),
    }));
  });

  it('blocks an unbound same-name service instead of silently adopting it', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({ databases: [] }),
      local: local({
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {},
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'service_adoption_required',
        externalIds: ['svc-1'],
      },
    });
    expect(result.unmanaged).toContainEqual(expect.objectContaining({
      kind: 'service',
      detail: expect.stringContaining('requires explicit adoption'),
    }));
  });

  it('blocks a same-name replacement whose id differs from the durable service binding', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({
        databases: [],
        services: [observedWeb({ externalId: 'svc-replacement' })],
      }),
      local: local({
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-original' } },
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'service_binding_identity_mismatch',
        externalIds: ['svc-replacement'],
      },
    });
  });

  it('blocks multiple same-name services when no durable service binding disambiguates them', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'production',
      observed: observed({
        databases: [],
        services: [
          observedWeb(),
          observedWeb({ externalId: 'svc-duplicate' }),
        ],
      }),
      local: local({
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {},
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'ambiguous_service_identity',
        externalIds: ['svc-1', 'svc-duplicate'],
      },
    });
  });

  it('blocks a service create when exact unresolved create recovery state is retained', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'staging',
      observed: observed({ environmentId: 'rail-env-1', services: [], databases: [] }),
      local: local({
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {},
          serviceCreateRecovery: {
            web: {
              provider: 'railway',
              operation: 'create',
              resourceName: 'web-staging',
              providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
              state: 'unresolved',
            },
          },
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: {
        blockedReason: 'service_create_recovery_required',
        serviceCreateRecovery: { state: 'unresolved', resourceName: 'web-staging' },
      },
    });
    expect(result.actions[0]?.id).toBe('service:web');
    expect(result.actions.some((action) => action.resource.kind === 'service' && action.type === 'create')).toBe(false);
  });

  it('blocks a service create when its retained recovery marker is malformed', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'staging',
      observed: observed({ services: [], databases: [] }),
      local: local({
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {},
          serviceCreateRecovery: { web: { provider: 'railway', state: 'identified' } },
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      metadata: { blockedReason: 'service_create_recovery_invalid' },
    });
    expect(result.actions.some((action) => action.resource.kind === 'service' && action.type === 'create')).toBe(false);
  });

  it('blocks rather than re-scoping a retained service-create identity', () => {
    const result = diffEnvironment({
      spec: spec({ database: undefined }),
      envName: 'staging',
      observed: observed({ services: [], databases: [] }),
      local: local({
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {},
          serviceCreateRecovery: {
            web: {
              provider: 'railway',
              operation: 'create',
              resourceName: 'web-staging',
              providerScope: { projectId: 'different-project', environmentId: 'rail-env-1' },
              state: 'identified',
              serviceId: 'svc-partial',
              returnedName: 'web-staging',
            },
          },
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:web')).toMatchObject({
      type: 'update',
      metadata: { blockedReason: 'service_create_recovery_invalid' },
    });
  });

  it('surfaces retained create recovery for a service removed from the spec without treating it as delete authority', () => {
    const result = diffEnvironment({
      spec: spec({ services: {}, database: undefined }),
      envName: 'staging',
      observed: observed({ services: [], databases: [] }),
      local: local({
        services: [],
        components: [],
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {},
          serviceCreateRecovery: {
            removed: {
              provider: 'railway',
              operation: 'create',
              resourceName: 'removed-staging',
              providerScope: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
              state: 'identified',
              serviceId: 'svc-possible-orphan',
              returnedName: 'removed-staging',
            },
          },
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'service:removed:recovery')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: {
        blockedReason: 'orphaned_service_create_recovery',
        serviceCreateRecovery: { serviceId: 'svc-possible-orphan' },
      },
    });
    expect(result.actions[0]?.id).toBe('service:removed:recovery');
    expect(result.actions.some((action) => action.id === 'service:removed:destroy')).toBe(false);
  });

  it('requires explicit adoption for an observed database missing from component state', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed(),
      local: local({ components: [] }),
    });

    expect(result.actions.find((action) => action.id === 'database:railway')).toMatchObject({
      type: 'update',
      metadata: {
        blockedReason: 'database_adoption_required',
        externalId: 'db-1',
      },
    });
    expect(result.actions.some((action) => action.resource.kind === 'database' && action.type === 'create')).toBe(false);
  });
});

describe('diffEnvironment — domain and workload', () => {
  it('does not plan the single-service domain action when a load balancer owns the hostname', () => {
    const withLoadBalancer = spec({
      domain: 'myapp.dev',
      services: {
        web: { startCommand: 'npm start', healthCheckPath: '/health', public: true },
        'web-secondary': { startCommand: 'npm start', healthCheckPath: '/health', public: true },
      },
      loadBalancer: {
        provider: 'cloudflare',
        services: ['web', 'web-secondary'],
        healthCheckPath: '/health',
      },
    });
    const result = diffEnvironment({
      spec: withLoadBalancer,
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    expect(result.actions.some((candidate) => candidate.resource.kind === 'domain')).toBe(false);
  });

  it('updates when the domain is not attached and noops when it is', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const detached = diffEnvironment({ spec: withDomain, envName: 'production', observed: observed(), local: local(), customDomainManagement: 'managed' });
    expect(detached.actions.find((a) => a.id === 'domain:myapp.dev')!.type).toBe('update');

    const attached = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: { 'myapp.dev': { providerVerified: true, dnsConfigured: true } },
        })],
      }),
      local: localWithDomain(),
      customDomainManagement: 'managed',
    });
    expect(attached.actions.find((a) => a.id === 'domain:myapp.dev')!.type).toBe('noop');
  });

  it('plans local-only adoption for a verified provider domain on the exact bound service', () => {
    const result = diffEnvironment({
      spec: spec({ domain: 'myapp.dev' }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              providerDomainId: 'provider-domain-1',
              providerVerified: true,
              dnsConfigured: true,
            },
          },
        })],
      }),
      local: local({
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {
            web: {
              serviceId: 'svc-1',
            },
          },
        },
      }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'update',
      metadata: {
        operation: 'customDomainAdopt',
        providerDomainId: 'provider-domain-1',
        projectId: 'rail-proj-1',
        serviceName: 'web',
        serviceId: 'svc-1',
        environmentId: 'rail-env-1',
      },
      reason: expect.stringContaining('exact bound'),
    });
  });

  it('still requires explicit import when the attached domain service is not locally bound', () => {
    const result = diffEnvironment({
      spec: spec({ domain: 'myapp.dev' }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              providerDomainId: 'provider-domain-1',
              providerVerified: true,
              dnsConfigured: true,
            },
          },
        })],
      }),
      local: local({
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'different-service' } },
        },
      }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'update',
      metadata: { blockedReason: 'domain_binding_missing' },
      reason: expect.stringContaining('hv_import'),
    });
  });

  it('plans exact confirmation-gated domain teardown before its service is destroyed', () => {
    const result = diffEnvironment({
      spec: spec({ services: {}, envVars: {} }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({ customDomains: ['railway.domain-test.hypervibe.dev'] })],
      }),
      local: local({
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: {
            web: {
              serviceId: 'svc-1',
              customDomains: ['railway.domain-test.hypervibe.dev'],
            },
          },
          domainDns: {
            name: 'railway.domain-test.hypervibe.dev',
            proxied: false,
            providerDomainId: 'domain-1',
            serviceName: 'web',
            serviceId: 'svc-1',
            environmentId: 'rail-env-1',
            zoneId: 'zone-1',
            records: [{
              id: 'record-1',
              name: 'railway.domain-test.hypervibe.dev',
              type: 'CNAME',
              target: 'target.railway.app',
            }],
          },
        },
      }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:railway.domain-test.hypervibe.dev')).toMatchObject({
      type: 'destroy',
      verified: true,
      requiresConfirm: true,
      metadata: {
        operation: 'customDomainDetach',
        projectId: 'rail-proj-1',
        serviceName: 'web',
        serviceId: 'svc-1',
        environmentId: 'rail-env-1',
        providerDomainId: 'domain-1',
        zoneId: 'zone-1',
        dnsRecordIds: ['record-1'],
      },
    });
    expect(result.actions.find((action) => action.id === 'service:web:destroy')?.dependsOn)
      .toContain('domain:railway.domain-test.hypervibe.dev');
  });

  it('can detach a provider attachment recorded before DNS requirements became available', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({
        services: [observedWeb({ customDomains: ['myapp.dev'] })],
      }),
      local: localWithDomain({ proxied: false, withDnsRecords: false }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'destroy',
      requiresConfirm: true,
      metadata: {
        providerDomainId: 'provider-domain-1',
        zoneId: 'zone-1',
        dnsRecordIds: [],
      },
    });
  });

  it('blocks domain teardown when durable attachment and DNS identities are incomplete', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [observedWeb({ customDomains: ['legacy.example.com'] })] }),
      local: local({
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' } },
          domainDns: { name: 'legacy.example.com', proxied: false },
        },
      }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:legacy.example.com')).toMatchObject({
      type: 'destroy',
      requiresConfirm: true,
      metadata: { blockedReason: 'domain_detach_binding_incomplete' },
    });
  });

  it('blocks before DNS mutation when the hosting provider does not manage custom domains', () => {
    const result = diffEnvironment({
      spec: spec({
        hosting: { provider: 'vercel' },
        database: undefined,
        domain: 'myapp.dev',
      }),
      envName: 'production',
      observed: observed({
        provider: 'vercel',
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: { 'myapp.dev': { dnsConfigured: true } },
        })],
      }),
      local: local(),
      customDomainManagement: 'unsupported',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'update',
      verified: false,
      reason: expect.stringContaining('does not implement managed environment custom domains'),
      metadata: { blockedReason: 'custom_domain_unsupported' },
    });
  });

  it('updates a verified domain when the managed traffic proxy differs from desired state', () => {
    const withDomain = spec({ domain: 'myapp.dev', domainProxy: true });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: { 'myapp.dev': { providerVerified: true, dnsConfigured: true } },
        })],
      }),
      local: localWithDomain({ proxied: false }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'update',
      reason: 'Domain myapp.dev traffic proxy does not match desired state',
      diff: [{ field: 'dns:proxied', from: 'false', to: 'true' }],
      metadata: { domainProxy: true },
    });
  });

  it('noops a verified domain when the managed traffic proxy matches desired state', () => {
    const withDomain = spec({ domain: 'myapp.dev', domainProxy: false });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: { 'myapp.dev': { providerVerified: true, dnsConfigured: true } },
        })],
      }),
      local: localWithDomain({ proxied: false }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')!.type).toBe('noop');
  });

  it('uses DNS-only traffic as effective desired state when the provider requires it', () => {
    const result = diffEnvironment({
      spec: spec({ domain: 'myapp.dev', domainProxy: true }),
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': { providerVerified: true, dnsConfigured: true },
          },
        })],
      }),
      local: localWithDomain({ provider: 'cloudrun', proxied: false }),
      customDomainManagement: 'managed',
      customDomainTrafficProxy: 'dns-only',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'noop',
      metadata: {
        domainProxy: false,
        domainTrafficProxy: 'dns-only',
      },
    });
  });

  it('recognizes verified provider DNS as proxy-opaque when Hypervibe manages the proxied traffic record', () => {
    const withDomain = spec({ domain: 'myapp.dev', domainProxy: true });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              providerVerified: true,
              certificateStatus: 'VALID',
              dnsConfigured: false,
            },
          },
        })],
      }),
      local: localWithDomain(),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'noop',
      reason: 'Domain attached',
    });
  });

  it('does not hide proxied-domain drift while provider certificate verification is pending', () => {
    const withDomain = spec({ domain: 'myapp.dev', domainProxy: true });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              providerVerified: true,
              certificateStatus: 'PENDING',
              dnsConfigured: false,
            },
          },
        })],
      }),
      local: localWithDomain(),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'update',
      reason: 'Domain myapp.dev is attached on railway, but required DNS records are not configured',
    });
  });

  it('updates when a provider-attached domain has no observed verification status', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({ services: [observedWeb({ customDomains: ['myapp.dev'] })] }),
      local: localWithDomain(),
      customDomainManagement: 'managed',
    });

    const domain = result.actions.find((a) => a.id === 'domain:myapp.dev')!;
    expect(domain.type).toBe('update');
    expect(domain.reason).toContain('provider verification status was not observed');
  });

  it('updates when the domain is attached but provider DNS is not configured', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              dnsConfigured: false,
              dnsRecords: [
                {
                  name: '_railway.myapp.dev',
                  type: 'TXT',
                  value: 'verify-token',
                  status: 'DNS_RECORD_STATUS_PENDING',
                },
              ],
            },
          },
        })],
      }),
      local: localWithDomain(),
      customDomainManagement: 'managed',
    });

    const domain = result.actions.find((a) => a.id === 'domain:myapp.dev')!;
    expect(domain.type).toBe('update');
    expect(domain.reason).toContain('required DNS records are not configured');
    expect(domain.metadata?.dnsRecords).toEqual([
      expect.objectContaining({ name: '_railway.myapp.dev', type: 'TXT' }),
    ]);
  });

  it('keeps a provider-attached domain pending after DNS propagates until ownership is verified', () => {
    const withDomain = spec({ domain: 'myapp.dev' });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': {
              providerVerified: false,
              dnsConfigured: true,
            },
          },
        })],
      }),
      local: localWithDomain(),
      customDomainManagement: 'managed',
    });

    const domain = result.actions.find((action) => action.id === 'domain:myapp.dev')!;
    expect(domain.type).toBe('update');
    expect(domain.reason).toContain('DNS is configured');
    expect(domain.reason).toContain('ownership verification is still pending');
  });

  it('plans an unapplied domain recreation revision as a confirmation-gated replacement', () => {
    const withDomain = spec({
      domain: 'myapp.dev',
      domainProxy: false,
      domainRecreateRevision: 'repair-2026-08-08',
    });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': { providerVerified: false, dnsConfigured: true },
          },
        })],
      }),
      local: localWithDomain({ proxied: false, recreateRevision: 'repair-previous' }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'replace',
      requiresConfirm: true,
      reason: 'Domain myapp.dev has an unapplied recreate revision',
      metadata: {
        domainProxy: false,
        domainRecreateRevision: 'repair-2026-08-08',
      },
    });
  });

  it('does not repeat a consumed domain recreation revision', () => {
    const withDomain = spec({
      domain: 'myapp.dev',
      domainProxy: false,
      domainRecreateRevision: 'repair-2026-08-08',
    });
    const result = diffEnvironment({
      spec: withDomain,
      envName: 'production',
      observed: observed({
        services: [observedWeb({
          customDomains: ['myapp.dev'],
          customDomainStatus: {
            'myapp.dev': { providerVerified: false, dnsConfigured: true },
          },
        })],
      }),
      local: localWithDomain({
        proxied: false,
        recreateRevision: 'repair-2026-08-08',
      }),
      customDomainManagement: 'managed',
    });

    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')).toMatchObject({
      type: 'update',
      reason: expect.stringContaining('ownership verification is still pending'),
    });
    expect(result.actions.find((action) => action.id === 'domain:myapp.dev')?.requiresConfirm).toBeUndefined();
  });

  it('replaces a service whose cron-ness changed', () => {
    const cronSpec = spec({ services: { web: { workloadKind: 'cron', cronSchedule: '0 3 * * *', startCommand: 'npm run cron' } } });
    const result = diffEnvironment({ spec: cronSpec, envName: 'production', observed: observed(), local: local() });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('replace');
    expect(web.diff).toContainEqual({ field: 'workloadKind', from: 'web', to: 'cron' });
  });

  it('treats web<->worker as an update on providers that observe the kind', () => {
    const workerSpec = spec({
      hosting: { provider: 'cloudrun' },
      services: { web: { workloadKind: 'worker', startCommand: 'npm start', healthCheckPath: '/health', public: true } },
    });
    const result = diffEnvironment({
      spec: workerSpec,
      envName: 'production',
      observed: observed({ provider: 'cloudrun' }),
      local: local({
        bindings: {
          provider: 'cloudrun',
          projectId: 'gcp-proj-1',
          services: { web: { serviceId: 'svc-1' } },
        },
      }),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'workloadKind', from: 'web', to: 'worker' });
  });

  it('skips the web<->worker field diff when provider metadata says observe cannot distinguish them', () => {
    const workerSpec = spec({
      services: { web: { workloadKind: 'worker', startCommand: 'npm start', healthCheckPath: '/health', public: true } },
    });
    const result = diffEnvironment({
      spec: workerSpec,
      envName: 'production',
      observed: observed(),
      local: local(),
      providerBehavior: { workloadKindObservation: 'cron-only' },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('noop');
  });
});

describe('diffEnvironment — deploy source', () => {
  it('warns when provider metadata requires branch deploys but deploy.strategy is not "branch"', () => {
    const providerBehavior = { requiresBranchDeployForCode: true };
    const result = diffEnvironment({ spec: spec(), envName: 'production', observed: observed(), local: local(), providerBehavior });
    expect(result.warnings.some((w) => w.includes('NO CODE WILL BE DEPLOYED'))).toBe(true);

    const manual = diffEnvironment({
      spec: spec({ deploy: { strategy: 'manual' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
      providerBehavior,
    });
    expect(manual.warnings.some((w) => w.includes('NO CODE WILL BE DEPLOYED'))).toBe(true);

    const branch = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
      providerBehavior,
    });
    expect(branch.warnings.some((w) => w.includes('NO CODE WILL BE DEPLOYED'))).toBe(false);
  });

  it('flags a live service that has never deployed as drift, not converged', () => {
    const live = observedWeb({ status: 'empty' });
    const result = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('no image deployed yet');
    expect(web.reason).toContain('first CI deploy');
  });

  it('flags a missing deploy source as drift when strategy is branch', () => {
    const result = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('Deploy source is not connected');
  });

  it('flags branch mismatch and accepts matching sources in any repo format', () => {
    const linked = observedWeb({ source: { repo: 'https://github.com/Dave/Seq-Planner.git', branch: 'main' } });
    const matching = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [linked] }),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    expect(matching.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');

    const wrongBranch = observedWeb({ source: { repo: 'dave/seq-planner', branch: 'develop' } });
    const mismatch = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [wrongBranch] }),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    const web = mismatch.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('branch is develop, expected main');
  });

  it('flags a linked source with an unknown branch so apply reconnects it', () => {
    const linkedWithoutBranch = observedWeb({ source: { repo: 'dave/seq-planner' } });
    const result = diffEnvironment({
      spec: spec({ deploy: { strategy: 'branch', branch: 'main' } }),
      envName: 'production',
      observed: observed({ services: [linkedWithoutBranch] }),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('branch is not recorded');
  });

  it('ignores deploy source when strategy is not branch', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed(),
      local: local(),
      expectedSource: { repo: 'dave/seq-planner', branch: 'main' },
    });
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
  });

  it('combines no-code drift with configuration drift in one update action', () => {
    const live = observedWeb({
      status: 'empty',
      config: { startCommand: 'node old.js', healthCheckPath: '/health', public: true },
    });
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.reason).toContain('no code deployed');
    expect(web.reason).toContain('Configuration drift');
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });
  });
});

describe('diffEnvironment — partial observation', () => {
  it('surfaces warnings when observation is partial', () => {
    const result = diffEnvironment({
      spec: spec(),
      envName: 'production',
      observed: observed({ partial: true, warnings: ['env var read failed for web'] }),
      local: local(),
    });
    expect(result.warnings).toContain('env var read failed for web');
    expect(result.warnings.some((w) => w.includes('partial'))).toBe(true);
  });
});

describe('diffEnvironment — abandoned provider teardown', () => {
  it('emits confirm-gated destroys for services stashed in previousHosting', () => {
    const result = diffEnvironment({
      spec: spec({ hosting: { provider: 'railway' } }),
      envName: 'production',
      observed: observed(),
      local: local({
        bindings: {
          provider: 'railway',
          projectId: 'rail-proj-1',
          environmentId: 'rail-env-1',
          services: { web: { serviceId: 'svc-1' } },
          previousHosting: {
            provider: 'cloudrun',
            projectId: 'gcp-project',
            services: {
              web: { serviceId: 'gcp-project-web' },
              nightly: { serviceId: 'gcp-project-nightly-schedule', jobName: 'gcp-project-nightly', resourceType: 'scheduledJob' },
            },
          },
        },
      }),
    });

    const destroys = result.actions.filter((a) => a.metadata?.operation === 'previousHostingDestroy');
    expect(destroys).toHaveLength(2);
    for (const action of destroys) {
      expect(action.type).toBe('destroy');
      expect(action.requiresConfirm).toBe(true);
      expect(action.resource.provider).toBe('cloudrun');
    }
    expect(destroys.map((a) => a.id).sort()).toEqual([
      'service:nightly:previous-destroy',
      'service:web:previous-destroy',
    ]);
    expect(result.warnings.some((w) => w.includes('still running on cloudrun'))).toBe(true);
  });

  it('emits nothing without a previousHosting stash', () => {
    const result = diffEnvironment({ spec: spec(), envName: 'production', observed: observed(), local: local() });
    expect(result.actions.some((a) => a.metadata?.operation === 'previousHostingDestroy')).toBe(false);
  });

  it('uses one environment-boundary destroy for an abandoned shared-project provider', () => {
    const result = diffEnvironment({
      spec: spec({ hosting: { provider: 'cloudrun' } }),
      envName: 'production',
      observed: observed({ provider: 'cloudrun', services: [] }),
      previousHostingTeardownBoundary: 'environment',
      local: local({
        bindings: {
          provider: 'cloudrun',
          projectId: 'gcp-project',
          services: {},
          previousHosting: {
            provider: 'railway',
            projectId: 'railway-project',
            environmentId: 'railway-environment',
            services: {
              web: { serviceId: 'shared-railway-service' },
              postgres: { serviceId: 'shared-railway-postgres' },
            },
          },
        },
      }),
    });

    expect(result.actions.filter((action) => action.metadata?.operation === 'previousHostingDestroy')).toEqual([
      expect.objectContaining({
        id: 'environment:production:railway:previous-destroy',
        type: 'destroy',
        resource: { kind: 'environment', name: 'production', provider: 'railway' },
        requiresConfirm: true,
        metadata: expect.objectContaining({
          operation: 'previousHostingDestroy',
          cleanupBoundary: 'environment',
          projectId: 'railway-project',
          environmentId: 'railway-environment',
        }),
      }),
    ]);
  });

  it('deletes abandoned services before their provider-owned project boundary', () => {
    const result = diffEnvironment({
      spec: spec({ hosting: { provider: 'railway' } }),
      envName: 'production',
      observed: observed(),
      previousHostingTeardownBoundary: 'project',
      local: local({
        bindings: {
          provider: 'railway',
          projectId: 'railway-project',
          services: { web: { serviceId: 'railway-web' } },
          previousHosting: {
            provider: 'ecs',
            projectId: 'ecs-cluster',
            services: { web: { serviceId: 'ecs-web' } },
          },
        },
      }),
    });
    const cleanup = result.actions.filter((action) => action.metadata?.operation === 'previousHostingDestroy');

    expect(cleanup).toContainEqual(expect.objectContaining({
      id: 'service:web:previous-destroy',
      metadata: expect.objectContaining({ cleanupBoundary: 'project' }),
    }));
    expect(cleanup).toContainEqual(expect.objectContaining({
      id: 'project:ecs:previous-destroy',
      resource: { kind: 'project', name: 'production', provider: 'ecs' },
      dependsOn: ['service:web:previous-destroy'],
      metadata: expect.objectContaining({ projectId: 'ecs-cluster', cleanupBoundary: 'project' }),
    }));
  });
});

describe('diffEnvironment — release-command migrations', () => {
  it('carries migrations.mode=releaseCommand as web releaseCommand drift', () => {
    const result = diffEnvironment({
      spec: spec({ migrations: { mode: 'releaseCommand', command: 'npm run db:setup' } }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'releaseCommand', from: undefined, to: 'npm run db:setup' });
  });

  it('is a noop when the live service already runs the release command', () => {
    const live = observedWeb({
      config: { startCommand: 'npm start', healthCheckPath: '/health', public: true, releaseCommand: 'npm run db:setup' },
    });
    const result = diffEnvironment({
      spec: spec({ migrations: { mode: 'releaseCommand', command: 'npm run db:setup' } }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
  });

  it('an explicit service releaseCommand wins over migrations.command', () => {
    const result = diffEnvironment({
      spec: spec({
        services: { web: { startCommand: 'npm start', healthCheckPath: '/health', public: true, releaseCommand: 'npm run migrate' } },
        migrations: { mode: 'releaseCommand', command: 'npm run db:setup' },
      }),
      envName: 'production',
      observed: observed(),
      local: local(),
    });
    const web = result.actions.find((a) => a.id === 'service:web')!;
    expect(web.diff).toContainEqual({ field: 'releaseCommand', from: undefined, to: 'npm run migrate' });
    expect(result.warnings).toContainEqual(expect.stringContaining('already set on web'));
    expect(result.warnings).toContainEqual(expect.stringContaining('npm run db:setup'));
  });

  it('does not warn when an explicit service releaseCommand already matches migrations.command', () => {
    const live = observedWeb({
      config: { startCommand: 'npm start', healthCheckPath: '/health', public: true, releaseCommand: 'npm run db:setup' },
    });
    const result = diffEnvironment({
      spec: spec({
        services: { web: { startCommand: 'npm start', healthCheckPath: '/health', public: true, releaseCommand: 'npm run db:setup' } },
        migrations: { mode: 'releaseCommand', command: 'npm run db:setup' },
      }),
      envName: 'production',
      observed: observed({ services: [live] }),
      local: local(),
    });
    expect(result.actions.find((a) => a.id === 'service:web')!.type).toBe('noop');
    expect(result.warnings).not.toContainEqual(expect.stringContaining('already set on web'));
    expect(result.warnings).not.toContainEqual(expect.stringContaining('will never run'));
  });

  it('warns when no web service can carry the release command', () => {
    const result = diffEnvironment({
      spec: spec({
        services: { nightly: { workloadKind: 'cron', cronSchedule: '0 8 * * *', startCommand: 'npm run cron' } },
        migrations: { mode: 'releaseCommand', command: 'npm run db:setup' },
      }),
      envName: 'production',
      observed: observed({ services: [] }),
      local: local({ services: [localService('nightly')], bindings: { provider: 'railway', projectId: 'rail-proj-1', environmentId: 'rail-env-1', services: {} } }),
    });
    expect(result.warnings).toContainEqual(expect.stringContaining('will never run'));
  });
});

describe('diffEnvironment — database seed command', () => {
  it('plans a one-shot database seed action when seedCommand has not completed', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'railway', seedCommand: 'npm run db:seed' } }),
      envName: 'production',
      observed: observed(),
      local: local({ components: [localComponent({ provider: 'railway' })] }),
    });

    const seed = result.actions.find((a) => a.id === 'database:railway:seed')!;
    expect(seed).toMatchObject({
      type: 'update',
      resource: { kind: 'database', name: 'seed', provider: 'railway' },
      metadata: {
        operation: 'databaseSeed',
        command: 'npm run db:seed',
        commandHash: sha256('npm run db:seed'),
        mode: 'once',
      },
    });
    expect(seed.requiresConfirm).toBeUndefined();
    expect(seed.dependsOn).toEqual(expect.arrayContaining(['database:railway', 'service:web']));
  });

  it('noops the seed action after the command hash is recorded on the database component', () => {
    const command = 'npm run db:seed';
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'railway', seedCommand: command } }),
      envName: 'production',
      observed: observed(),
      local: local({
        components: [localComponent({
          provider: 'railway',
          seed: { commandHash: sha256(command), seededAt: '2026-07-05T12:00:00.000Z' },
        })],
      }),
    });

    const seed = result.actions.find((a) => a.id === 'database:railway:seed')!;
    expect(seed.type).toBe('noop');
    expect(seed.reason).toContain('already completed');
  });

  it('replans seeding when the desired command changes', () => {
    const result = diffEnvironment({
      spec: spec({ database: { provider: 'railway', seedCommand: 'npm run db:seed:v2' } }),
      envName: 'production',
      observed: observed(),
      local: local({
        components: [localComponent({
          provider: 'railway',
          seed: { commandHash: sha256('npm run db:seed'), seededAt: '2026-07-05T12:00:00.000Z' },
        })],
      }),
    });

    expect(result.actions.find((a) => a.id === 'database:railway:seed')?.type).toBe('update');
  });
});
