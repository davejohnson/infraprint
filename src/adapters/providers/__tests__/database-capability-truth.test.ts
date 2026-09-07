import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { RdsAdapter } from '../aws/rds.adapter.js';
import { AzurePostgresAdapter } from '../azure/azure-postgres.adapter.js';
import { DigitalOceanDatabaseAdapter } from '../digitalocean/digitalocean-database.adapter.js';
import { FlyDatabaseAdapter } from '../fly/fly-database.adapter.js';
import { CloudSqlAdapter } from '../gcp/cloudsql.adapter.js';
import { NeonAdapter } from '../neon/neon.adapter.js';
import { SupabaseAdapter } from '../supabase/supabase.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../railway/railway-database.factory.js';
import { supportsDatabaseLifecycle } from '../../../domain/ports/database.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

describe('database capability truth', () => {
  it('keeps every registered database provider aligned with the complete runtime port', () => {
    const railway = new RailwayAdapter();
    const adapters = new Map<string, unknown>([
      ['railway', createRailwayDatabaseAdapter({ hostingAdapter: railway, envRepo: {} as never })],
      ['supabase', new SupabaseAdapter()],
      ['cloudsql', new CloudSqlAdapter()],
      ['rds', new RdsAdapter()],
      ['azure-postgres', new AzurePostgresAdapter()],
      ['neon', new NeonAdapter()],
      ['fly', new FlyDatabaseAdapter()],
      ['digitalocean', new DigitalOceanDatabaseAdapter()],
    ]);

    expect([...adapters.keys()].sort()).toEqual(providerRegistry.namesFor('database').sort());
    expect(providerRegistry.namesForMutation('database').sort())
      .toEqual(providerRegistry.namesFor('database').sort());
    for (const [provider, adapter] of adapters) {
      expect(supportsDatabaseLifecycle(adapter), provider).toBe(true);
      expect(providerRegistry.get(provider)?.databaseRuntime, provider).toBeDefined();
    }
    expect(
      providerRegistry.all()
        .filter((provider) => provider.databaseRuntime)
        .map((provider) => provider.metadata.name)
        .sort()
    ).toEqual(providerRegistry.namesFor('database').sort());
  });

  it('advertises declarative resilience only where the lifecycle is implemented', () => {
    const cloudSql = new CloudSqlAdapter();
    expect(cloudSql.capabilities.supportsReadReplicas).toBe(true);
    expect(cloudSql.capabilities.supportsPointInTimeRecovery).toBe(true);

    const adapters = [
      new RdsAdapter(),
      new AzurePostgresAdapter(),
      new DigitalOceanDatabaseAdapter(),
      new FlyDatabaseAdapter(),
      new NeonAdapter(),
      new SupabaseAdapter(),
    ];
    for (const adapter of adapters) {
      expect(adapter.capabilities.supportsReadReplicas, adapter.name).toBe(false);
      expect(adapter.capabilities.supportsPointInTimeRecovery, adapter.name).toBe(false);
    }
  });

  it('declares every provider-specific database network boundary explicitly', () => {
    const expected = new Map<string, string[] | undefined>([
      ['railway', ['railway']],
      ['supabase', undefined],
      ['cloudsql', ['cloudrun']],
      ['rds', ['ecs']],
      ['azure-postgres', ['azure-container-apps']],
      ['neon', undefined],
      ['fly', ['fly']],
      ['digitalocean', undefined],
    ]);

    expect([...expected.keys()].sort()).toEqual(providerRegistry.namesFor('database').sort());
    for (const [provider, compatibleHostingProviders] of expected) {
      expect(
        providerRegistry.getMetadata(provider)?.lifecycle?.databaseConnectivity
          ?.compatibleHostingProviders,
        provider
      ).toEqual(compatibleHostingProviders);
    }
  });
});
