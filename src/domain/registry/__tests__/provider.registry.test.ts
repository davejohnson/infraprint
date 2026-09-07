import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry, type RegisteredProvider } from '../provider.registry.js';

function provider(
  name: string,
  category: RegisteredProvider['metadata']['category'],
  derivedAdapters?: RegisteredProvider['derivedAdapters']
): RegisteredProvider {
  const supportsDatabase = category === 'database' || Boolean(derivedAdapters?.database);
  const supportsCache = category === 'cache' || Boolean(derivedAdapters?.cache);
  const supportsStorage = category === 'storage' || Boolean(derivedAdapters?.storage);
  const supportsHosting = category === 'deployment';
  const resources = [
    ...(supportsHosting ? ['environment' as const] : []),
    ...(supportsDatabase ? ['database' as const] : []),
    ...(supportsCache ? ['cache' as const] : []),
    ...(supportsStorage ? ['storage' as const] : []),
  ];
  const selectors = Object.fromEntries(resources.map((resource) => [resource, resource === 'environment'
    ? {
        mode: 'environment-forensics' as const,
        required: ['project', 'env'] as const,
        optional: ['limit'] as const,
        list: true,
      }
    : {
        mode: 'provider-resource' as const,
        optional: ['id', 'name', 'limit'] as const,
        mutuallyExclusive: [['id', 'name']] as const,
        list: true,
        scopeKeys: ['accountId'],
      }]));
  return {
    metadata: {
      name,
      displayName: name,
      category,
      credentialsSchema: z.object({ token: z.string() }),
      maturity: {
        lifecycle: {
          ...(supportsHosting ? { hosting: { status: 'ready-for-live' as const } } : {}),
          ...(supportsDatabase ? { database: { status: 'ready-for-live' as const } } : {}),
          ...(supportsCache ? { cache: { status: 'ready-for-live' as const } } : {}),
          ...(supportsStorage ? { storage: { status: 'ready-for-live' as const } } : {}),
        },
      },
      lifecycle: {
        ...(category === 'deployment'
          ? {
              hosting: {
                workloadKinds: ['web'] as const,
                customDomains: 'unsupported' as const,
                teardownBoundary: 'services' as const,
              },
            }
          : {}),
        ...(supportsDatabase
          ? { databaseEngines: ['postgres'] }
          : {}),
        ...(supportsCache
          ? { cacheEngines: ['redis'] }
          : {}),
      },
    },
    factory: () => ({}),
    ...(resources.length > 0 ? {
      inspection: {
        resources,
        defaultResource: resources[0],
        selectors,
        inspect: async () => ({ observation: 'present', resource: resources[0] }),
      },
    } : {}),
    ...(derivedAdapters ? { derivedAdapters } : {}),
  };
}

describe('ProviderRegistry lifecycle capabilities', () => {
  it('derives lifecycle support from registered adapter capabilities', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('host', 'deployment'));
    registry.register(provider('db', 'database'));
    registry.register(provider('multi', 'deployment', {
      database: () => ({}),
      cache: () => ({}),
      storage: () => ({}),
    }));

    expect(registry.namesFor('hosting')).toEqual(['host', 'multi']);
    expect(registry.namesFor('database')).toEqual(['db', 'multi']);
    expect(registry.namesFor('cache')).toEqual(['multi']);
    expect(registry.namesFor('storage')).toEqual(['multi']);
    expect(registry.namesForMutation('hosting')).toEqual(['host', 'multi']);
    expect(registry.supportsWorkloadKind('host', 'web')).toBe(true);
    expect(registry.supportsWorkloadKind('host', 'worker')).toBe(false);
    expect(registry.supportsEngine('multi', 'database', 'postgres')).toBe(true);
    expect(registry.supportsEngine('multi', 'database', 'mysql')).toBe(false);
    expect(registry.supportsEngine('multi', 'cache', 'redis')).toBe(true);
  });

  it('keeps planned capabilities inspectable but excludes them from mutation support', () => {
    const registry = new ProviderRegistry();
    const planned = provider('planned-db', 'database');
    planned.metadata.maturity!.lifecycle!.database = {
      status: 'planned',
      reason: 'A live lifecycle prerequisite is still missing.',
    };
    registry.register(planned);

    expect(registry.supports('planned-db', 'database')).toBe(true);
    expect(registry.supportsMutation('planned-db', 'database')).toBe(false);
    expect(registry.namesFor('database')).toEqual(['planned-db']);
    expect(registry.namesForMutation('database')).toEqual([]);
  });

  it('rejects malformed datastore-to-host connectivity metadata', () => {
    const registry = new ProviderRegistry();
    const missingLifecycle = provider('connectivity-without-lifecycle', 'deployment');
    missingLifecycle.metadata.lifecycle!.databaseConnectivity = {
      compatibleHostingProviders: ['railway'],
    };
    expect(() => registry.register(missingLifecycle)).toThrow(/without a database lifecycle/i);

    const empty = provider('empty-connectivity', 'database');
    empty.metadata.lifecycle!.databaseConnectivity = {
      compatibleHostingProviders: [],
    };
    expect(() => registry.register(empty)).toThrow(/one or more unique hosting providers/i);

    const duplicates = provider('duplicate-connectivity', 'cache');
    duplicates.metadata.lifecycle!.cacheConnectivity = {
      compatibleHostingProviders: ['cloudrun', 'cloudrun'],
    };
    expect(() => registry.register(duplicates)).toThrow(/one or more unique hosting providers/i);
  });

  it('rejects empty, duplicate, or unknown hosting workload-kind claims', () => {
    const registry = new ProviderRegistry();
    const empty = provider('empty-workloads', 'deployment');
    empty.metadata.lifecycle!.hosting!.workloadKinds = [];
    expect(() => registry.register(empty)).toThrow(/one or more unique supported workload kinds/i);

    const duplicate = provider('duplicate-workloads', 'deployment');
    duplicate.metadata.lifecycle!.hosting!.workloadKinds = ['web', 'web'];
    expect(() => registry.register(duplicate)).toThrow(/one or more unique supported workload kinds/i);

    const unknown = provider('unknown-workload', 'deployment');
    unknown.metadata.lifecycle!.hosting!.workloadKinds = ['web', 'job' as 'web'];
    expect(() => registry.register(unknown)).toThrow(/one or more unique supported workload kinds/i);
  });

  it('requires dated live evidence before a capability can be called supported', () => {
    const registry = new ProviderRegistry();
    const unsupportedClaim = provider('unsupported-claim', 'database');
    unsupportedClaim.metadata.maturity!.lifecycle!.database = { status: 'supported' };

    expect(() => registry.register(unsupportedClaim)).toThrow(/liveEvidence/i);

    const proven = provider('proven', 'database');
    proven.metadata.maturity!.lifecycle!.database = {
      status: 'supported',
      liveEvidence: {
        verifiedAt: '2026-09-04T12:00:00.000Z',
        reference: 'docs/live-evidence/proven.json',
      },
    };
    expect(() => registry.register(proven)).not.toThrow();
    expect(registry.supportsMutation('proven', 'database')).toBe(true);
  });

  it('rejects duplicate ids instead of silently replacing an adapter', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('acme', 'deployment'));
    expect(() => registry.register(provider('acme', 'database')))
      .toThrow('already registered');
  });

  it('awaits asynchronous provider factories and propagates initialization failures', async () => {
    const registry = new ProviderRegistry();
    const asynchronous = provider('async-provider', 'ai');
    asynchronous.factory = async () => {
      await Promise.resolve();
      throw new Error('connection initialization failed');
    };
    registry.register(asynchronous);

    await expect(registry.createAdapter('async-provider', { token: 'test' }))
      .rejects.toThrow('connection initialization failed');
  });

  it('does not treat every deployment-category integration as a hosting lifecycle', () => {
    const registry = new ProviderRegistry();
    const repository = provider('repository', 'deployment');
    delete repository.metadata.lifecycle?.hosting;
    delete repository.metadata.maturity?.lifecycle?.hosting;
    registry.register(repository);

    expect(registry.supports('repository', 'hosting')).toBe(false);
    expect(registry.namesFor('hosting')).toEqual([]);
  });

  it('rejects database lifecycle support without complete provider-owned inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-db', 'database');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/database lifecycle support without/i);
  });

  it('rejects hosting lifecycle support without provider-owned environment inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-host', 'deployment');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/hosting lifecycle support without/i);
  });

  it('rejects list contracts that do not accept limit', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('bad-limit-db', 'database');
    incomplete.inspection!.selectors = {
      database: {
        ...incomplete.inspection!.selectors.database!,
        optional: ['id', 'name'],
      },
    };

    expect(() => registry.register(incomplete)).toThrow(/accept limit exactly when list=true/i);
  });

  it('rejects cache lifecycle support without complete provider-owned inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-cache', 'cache');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/cache lifecycle support without/i);
  });

  it('rejects storage lifecycle support without complete provider-owned inventory', () => {
    const registry = new ProviderRegistry();
    const incomplete = provider('incomplete-storage', 'storage');
    delete incomplete.inspection;

    expect(() => registry.register(incomplete)).toThrow(/storage lifecycle support without/i);
  });

  it('accepts retained cleanup only with bounded exact scoped inventory', () => {
    const registry = new ProviderRegistry();
    const cleanup = provider('cleanup', 'ai');
    cleanup.inspection = {
      resources: ['backup'],
      selectors: {
        backup: {
          mode: 'provider-resource',
          optional: ['id', 'name', 'limit'],
          mutuallyExclusive: [['id', 'name']],
          list: true,
          scopeKeys: ['projectId'],
          collectionKey: 'backups',
        },
      },
      inspect: async () => ({ resource: 'backup', observation: 'absent', backups: [], partial: false, truncated: false }),
    };
    cleanup.retainedCleanup = {
      resources: ['backup'],
      destroy: async () => ({ success: true, message: 'deleted' }),
    };

    expect(() => registry.register(cleanup)).not.toThrow();
  });

  it('rejects retained cleanup without an explicit inspection collection key', () => {
    const registry = new ProviderRegistry();
    const cleanup = provider('unsafe-cleanup', 'ai');
    cleanup.inspection = {
      resources: ['backup'],
      selectors: {
        backup: {
          mode: 'provider-resource',
          optional: ['id', 'name', 'limit'],
          mutuallyExclusive: [['id', 'name']],
          list: true,
          scopeKeys: ['projectId'],
        },
      },
      inspect: async () => ({ resource: 'backup' }),
    };
    cleanup.retainedCleanup = {
      resources: ['backup'],
      destroy: async () => ({ success: true, message: 'deleted' }),
    };

    expect(() => registry.register(cleanup)).toThrow(/collection key/i);
  });
});
