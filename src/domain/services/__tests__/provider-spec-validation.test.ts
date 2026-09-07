import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  firstProviderSpecValidationFailure,
  validateProjectSpecProviders,
} from '../provider-spec-validation.js';

function spec(hosting: string, database?: string, cache?: string) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-contract',
    environments: {
      staging: {
        hosting: { provider: hosting },
        services: {},
        ...(database ? { database: { provider: database } } : {}),
        ...(cache ? { cache: { provider: cache } } : {}),
      },
    },
  });
}

function storageSpec(provider: string) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-storage-contract',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: {},
        storage: {
          uploads: {
            provider,
            type: 'bucket',
            region: provider === 'railway' ? 'iad' : 'us-east-1',
            injectInto: [],
          },
        },
      },
    },
  });
}

function infrastructureSpec(params: { hosting: string; loadBalancer?: string; queues?: boolean }) {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-infrastructure-contract',
    environments: {
      staging: {
        hosting: { provider: params.hosting },
        services: {
          api: { workloadKind: 'web', public: true },
          fallback: { workloadKind: 'web', public: true },
        },
        ...(params.queues && params.hosting === 'railway'
          ? { database: { provider: 'railway' } }
          : {}),
        ...(params.queues ? { queues: { jobs: {} } } : {}),
        ...(params.loadBalancer
          ? {
              domain: 'api.example.com',
              loadBalancer: {
                provider: params.loadBalancer,
                services: ['api', 'fallback'],
              },
            }
          : {}),
      },
    },
  });
}

function workloadSpec(provider: string, workloadKind: 'web' | 'worker' | 'cron') {
  return projectSpecSchema.parse({
    version: 1,
    project: 'provider-workload-contract',
    environments: {
      staging: {
        hosting: { provider },
        services: {
          processor: {
            workloadKind,
            ...(workloadKind === 'cron'
              ? { startCommand: 'npm run scheduled', cronSchedule: '0 * * * *' }
              : {}),
          },
        },
      },
    },
  });
}

describe('validateProjectSpecProviders', () => {
  it('accepts installed primary and derived lifecycle adapters', () => {
    expect(validateProjectSpecProviders(spec('railway', 'railway'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('cloudrun', 'cloudsql'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', undefined, 'railway'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('ecs', undefined, 'elasticache'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', undefined, 'elasticache'))).toContainEqual(
      expect.objectContaining({
        field: 'cache.provider',
        provider: 'elasticache',
        incompatibleHostingProvider: 'railway',
        available: ['ecs'],
      })
    );
  });

  it('enforces each hosting adapter\'s complete workload-kind lifecycle before planning', () => {
    const expectedKinds = new Map<string, Array<'web' | 'worker' | 'cron'>>([
      ['railway', ['web', 'worker', 'cron']],
      ['cloudrun', ['web', 'worker', 'cron']],
      ['digitalocean', ['web', 'worker', 'cron']],
      ['fly', ['web', 'worker']],
      ['ecs', ['web']],
      ['azure-container-apps', ['web']],
      ['vercel', ['web']],
    ]);

    for (const [provider, supportedKinds] of expectedKinds) {
      for (const workloadKind of ['web', 'worker', 'cron'] as const) {
        const workloadIssues = validateProjectSpecProviders(workloadSpec(provider, workloadKind))
          .filter((issue) => issue.field === 'services.workloadKind');
        if (supportedKinds.includes(workloadKind)) {
          expect(workloadIssues, `${provider} ${workloadKind}`).toEqual([]);
        } else {
          expect(workloadIssues, `${provider} ${workloadKind}`).toEqual([
            expect.objectContaining({
              environment: 'staging',
              provider,
              service: 'processor',
              workloadKind,
              available: supportedKinds,
            }),
          ]);
        }
      }
    }
  });

  it('returns an exact actionable path for an unsupported hosting workload kind', () => {
    expect(firstProviderSpecValidationFailure(workloadSpec('ecs', 'worker'))).toMatchObject({
      message: 'ecs hosting does not support workload kind "worker" for service "processor" in environment "staging".',
      hint: expect.stringContaining('Supported workload kinds for ecs: web.'),
      details: {
        path: 'environments.staging.services.processor.workloadKind',
        capability: 'hosting',
        service: 'processor',
        workloadKind: 'worker',
      },
    });
  });

  it('reports unknown capabilities with the exact spec path and available providers', () => {
    const issues = validateProjectSpecProviders(spec('missing-host', 'missing-db', 'missing-cache'));
    expect(issues).toEqual([
      expect.objectContaining({
        field: 'hosting.provider',
        provider: 'missing-host',
        capability: 'hosting',
      }),
      expect.objectContaining({
        field: 'database.provider',
        provider: 'missing-db',
        capability: 'database',
      }),
      expect.objectContaining({
        field: 'cache.provider',
        provider: 'missing-cache',
        capability: 'cache',
      }),
    ]);
    expect(issues[0].available).toContain('railway');
    expect(issues[1].available).toContain('supabase');
    expect(issues[2].available).toContain('railway');
  });

  it('enforces each datastore provider\'s implemented hosting-network contract', () => {
    expect(validateProjectSpecProviders(spec('cloudrun', 'railway'))).toContainEqual(
      expect.objectContaining({
        field: 'database.provider',
        provider: 'railway',
        capability: 'database',
        incompatibleHostingProvider: 'cloudrun',
        available: ['railway'],
      })
    );
    expect(validateProjectSpecProviders(spec('railway', 'railway'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('cloudrun', undefined, 'railway'))).toContainEqual(
      expect.objectContaining({
        field: 'cache.provider',
        provider: 'railway',
        capability: 'cache',
        incompatibleHostingProvider: 'cloudrun',
        available: ['railway'],
      })
    );
    expect(validateProjectSpecProviders(spec('railway', undefined, 'railway'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', 'fly'))).toContainEqual(
      expect.objectContaining({
        field: 'database.provider',
        provider: 'fly',
        capability: 'database',
        incompatibleHostingProvider: 'railway',
        available: ['fly'],
      })
    );
    expect(validateProjectSpecProviders(spec('fly', 'fly'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', 'cloudsql'))).toContainEqual(
      expect.objectContaining({
        field: 'database.provider',
        provider: 'cloudsql',
        capability: 'database',
        incompatibleHostingProvider: 'railway',
        available: ['cloudrun'],
      })
    );
    expect(validateProjectSpecProviders(spec('cloudrun', 'cloudsql'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', 'rds'))).toContainEqual(
      expect.objectContaining({
        field: 'database.provider',
        provider: 'rds',
        capability: 'database',
        incompatibleHostingProvider: 'railway',
        available: ['ecs'],
      })
    );
    expect(validateProjectSpecProviders(spec('ecs', 'rds'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', 'azure-postgres'))).toContainEqual(
      expect.objectContaining({
        field: 'database.provider',
        provider: 'azure-postgres',
        capability: 'database',
        incompatibleHostingProvider: 'railway',
        available: ['azure-container-apps'],
      })
    );
    expect(validateProjectSpecProviders(spec('azure-container-apps', 'azure-postgres'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', undefined, 'memorystore'))).toContainEqual(
      expect.objectContaining({
        field: 'cache.provider',
        provider: 'memorystore',
        capability: 'cache',
        incompatibleHostingProvider: 'railway',
        available: ['cloudrun'],
      })
    );
    expect(validateProjectSpecProviders(spec('cloudrun', undefined, 'memorystore'))).toEqual([]);
    expect(validateProjectSpecProviders(spec('railway', undefined, 'azure-managed-redis'))).toContainEqual(
      expect.objectContaining({
        field: 'cache.provider',
        provider: 'azure-managed-redis',
        capability: 'cache',
        incompatibleHostingProvider: 'railway',
        available: ['azure-container-apps'],
      })
    );
    expect(validateProjectSpecProviders(spec('azure-container-apps', undefined, 'azure-managed-redis'))).toEqual([]);
  });

  it('validates storage provider lifecycle maturity', () => {
    expect(validateProjectSpecProviders(storageSpec('s3'))).toEqual([]);
    expect(validateProjectSpecProviders(storageSpec('missing-storage'))).toContainEqual(
      expect.objectContaining({
        field: 'storage.provider',
        provider: 'missing-storage',
        capability: 'storage',
      })
    );
  });

  it('validates queue lifecycle through hosting-provider metadata', () => {
    expect(validateProjectSpecProviders(infrastructureSpec({ hosting: 'cloudrun', queues: true }))).toEqual([]);
    expect(validateProjectSpecProviders(infrastructureSpec({ hosting: 'railway', queues: true }))).toEqual([]);
    expect(validateProjectSpecProviders(infrastructureSpec({ hosting: 'fly', queues: true }))).toContainEqual(
      expect.objectContaining({ field: 'queues', provider: 'fly', capability: 'queue' })
    );
  });

  it('enforces application-managed PostgreSQL queue constraints through lifecycle metadata', () => {
    const withoutDatabase = projectSpecSchema.parse({
      version: 1,
      project: 'postgres-queue-without-database',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          queues: { jobs: {} },
        },
      },
    });
    expect(firstProviderSpecValidationFailure(withoutDatabase)).toMatchObject({
      message: expect.stringContaining('require a declared PostgreSQL database'),
      details: {
        path: 'environments.staging.queues',
        capability: 'queue',
      },
    });

    const unsupportedOption = projectSpecSchema.parse({
      version: 1,
      project: 'postgres-queue-ack-deadline',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          database: { provider: 'railway' },
          services: {},
          queues: { jobs: { ackDeadlineSeconds: 120 } },
        },
      },
    });
    expect(firstProviderSpecValidationFailure(unsupportedOption)).toMatchObject({
      message: expect.stringContaining('do not support ackDeadlineSeconds'),
      hint: expect.stringContaining('available only for provider-managed Pub/Sub queues'),
      details: {
        path: 'environments.staging.queues.jobs.ackDeadlineSeconds',
        capability: 'queue',
      },
    });

    const managedPubSub = projectSpecSchema.parse({
      version: 1,
      project: 'managed-pubsub-ack-deadline',
      environments: {
        staging: {
          hosting: { provider: 'cloudrun' },
          services: {},
          queues: { jobs: { ackDeadlineSeconds: 120 } },
        },
      },
    });
    expect(validateProjectSpecProviders(managedPubSub)).toEqual([]);
  });

  it('validates provider-managed load-balancer lifecycle independently of hosting', () => {
    expect(validateProjectSpecProviders(infrastructureSpec({
      hosting: 'railway',
      loadBalancer: 'cloudflare',
    }))).toEqual([]);
    expect(validateProjectSpecProviders(infrastructureSpec({
      hosting: 'railway',
      loadBalancer: 'missing-edge',
    }))).toContainEqual(expect.objectContaining({
      field: 'loadBalancer.provider',
      provider: 'missing-edge',
      capability: 'load-balancer',
    }));
  });

  it('validates open DevOps provider ids and code-host compatibility through the separate registry', () => {
    const base = {
      version: 1 as const,
      project: 'devops-provider-contract',
      gitRemoteUrl: 'https://gitlab.com/acme/app.git',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          deploy: { strategy: 'branch' as const, trigger: 'ci' as const },
        },
      },
    };
    const gitlab = projectSpecSchema.parse({
      ...base,
      devops: {
        code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/app' },
        ci: { provider: 'gitlab-ci' },
      },
    });
    expect(validateProjectSpecProviders(gitlab)).toEqual([]);

    const incompatible = projectSpecSchema.parse({
      ...base,
      devops: {
        code: { provider: 'gitlab', scope: 'https://gitlab.com/acme/app' },
        ci: { provider: 'github-actions' },
      },
    });
    expect(validateProjectSpecProviders(incompatible)).toContainEqual(expect.objectContaining({
      field: 'devops.ci.provider',
      provider: 'github-actions',
      capability: 'ci',
    }));
  });

});
