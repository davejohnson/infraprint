import { describe, expect, it } from 'vitest';
import { parseHostingBindings } from '../hosting.port.js';

describe('parseHostingBindings', () => {
  it('parses a production-shaped bindings blob and keeps provider extras', () => {
    const bindings = parseHostingBindings({
      platformBindings: {
        provider: 'railway',
        projectId: 'proj-123',
        environmentId: 'env-456',
        ci: { workflows: { production: { path: '.github/workflows/deploy.yml' } } },
        services: {
          web: {
            serviceId: 'svc-1',
            url: 'https://web-production.up.railway.app',
            customDomains: ['app.example.com'],
            source: { repo: 'davejohnson/app', branch: 'main' },
            railwayRebind: { previousServiceId: 'svc-0' },
          },
          nightly: {
            serviceId: 'svc-2',
            workloadKind: 'cron',
            schedulerJobName: 'nightly-job',
          },
        },
      },
    });

    expect(bindings.provider).toBe('railway');
    expect(bindings.projectId).toBe('proj-123');
    expect(bindings.services?.web?.serviceId).toBe('svc-1');
    expect(bindings.services?.web?.source?.branch).toBe('main');
    expect(bindings.services?.nightly?.schedulerJobName).toBe('nightly-job');
    // Passthrough: unknown keys survive at both levels.
    expect((bindings as Record<string, unknown>).ci).toBeDefined();
    expect((bindings.services?.web as Record<string, unknown>).railwayRebind).toEqual({ previousServiceId: 'svc-0' });
  });

  it('treats only missing legacy bindings as empty', () => {
    expect(parseHostingBindings(null)).toEqual({});
    expect(parseHostingBindings(undefined)).toEqual({});
    expect(parseHostingBindings({ platformBindings: {} })).toEqual({});
  });

  it.each([
    ['provider', { provider: 42 }],
    ['project ID', { projectId: {} }],
    ['environment ID', { environmentId: '' }],
    ['services map', { services: 'nope' }],
    ['service ID', { services: { web: { serviceId: '' } } }],
    ['service recovery map', { serviceCreateRecovery: [] }],
    ['service recovery marker', {
      serviceCreateRecovery: {
        web: {
          provider: 'railway',
          operation: 'create',
          resourceName: 'web-production',
          providerScope: { projectId: 'project-1', environmentId: 'environment-1' },
          state: 'identified',
        },
      },
    }],
    ['retained database', {
      previousDatabase: {
        provider: 'cloudsql', externalId: '', engine: 'postgres', name: 'database',
        providerScope: { projectId: 'gcp-project' },
      },
    }],
    ['retained cache engine', {
      previousCache: {
        provider: 'memorystore', externalId: 'cache-1', engine: 'memcached',
        providerEngine: 'redis', name: 'cache', providerScope: { projectId: 'gcp-project' },
      },
    }],
    ['retained cache scope', {
      previousCache: {
        provider: 'memorystore', externalId: 'cache-1', engine: 'redis',
        providerEngine: 'redis', name: 'cache', providerScope: { projectId: '   ' },
      },
    }],
  ])('fails closed on a malformed known %s binding', (_label, platformBindings) => {
    expect(() => parseHostingBindings({
      platformBindings: platformBindings as unknown as Record<string, unknown>,
    })).toThrow();
  });

  it('validates service-create recovery while preserving provider-specific passthrough fields', () => {
    const parsed = parseHostingBindings({
      platformBindings: {
        provider: 'railway',
        projectId: 'project-1',
        railwayEnvironmentName: 'production',
        serviceCreateRecovery: {
          web: {
            provider: 'railway',
            operation: 'create',
            resourceName: 'web-production',
            providerScope: { projectId: 'project-1', environmentId: 'environment-1' },
            state: 'unresolved',
          },
        },
      },
    });

    expect(parsed.serviceCreateRecovery?.web).toMatchObject({
      provider: 'railway',
      resourceName: 'web-production',
      state: 'unresolved',
    });
    expect((parsed as Record<string, unknown>).railwayEnvironmentName).toBe('production');
  });

  it('validates retained datastore identities while preserving provider-specific passthrough fields', () => {
    const parsed = parseHostingBindings({
      platformBindings: {
        previousDatabase: {
          provider: 'cloudsql',
          externalId: 'database-1',
          engine: 'postgres',
          name: 'database',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
          providerReceipt: { operation: 'insert' },
        },
        previousCache: {
          provider: 'memorystore',
          externalId: 'cache-1',
          engine: 'redis',
          providerEngine: 'redis',
          name: 'cache',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
          providerReceipt: { operation: 'create' },
        },
      },
    });

    expect(parsed.previousDatabase?.externalId).toBe('database-1');
    expect(parsed.previousCache?.externalId).toBe('cache-1');
    expect((parsed.previousCache as Record<string, unknown>).providerReceipt).toEqual({ operation: 'create' });
  });
});
