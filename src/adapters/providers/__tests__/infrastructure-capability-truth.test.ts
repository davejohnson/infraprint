import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { CloudflareAdapter } from '../cloudflare/cloudflare.adapter.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { supportsLoadBalancer } from '../../../domain/ports/load-balancer.port.js';
import { supportsManagedQueues } from '../../../domain/ports/queue.port.js';
import { supportsStorageLifecycle } from '../../../domain/ports/storage.port.js';
import { supportsCacheLifecycle } from '../../../domain/ports/cache.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { S3StorageAdapter } from '../aws/s3.adapter.js';
import { AzureBlobStorageAdapter } from '../azure/azure-blob.adapter.js';
import { GcsStorageAdapter } from '../gcp/gcs.adapter.js';
import { createRailwayStorageAdapter } from '../railway/railway-storage.factory.js';
import { createRailwayCacheAdapter } from '../railway/railway-cache.factory.js';
import { ElastiCacheAdapter } from '../aws/elasticache.adapter.js';
import { AzureManagedRedisAdapter } from '../azure/azure-managed-redis.adapter.js';
import { DigitalOceanCacheAdapter } from '../digitalocean/digitalocean-cache.adapter.js';
import { MemorystoreAdapter } from '../gcp/memorystore.adapter.js';

describe('production infrastructure capability truth', () => {
  it('keeps queue metadata aligned with provider behavior', () => {
    const cloudRun = new CloudRunAdapter();
    const railway = new RailwayAdapter();

    expect(providerRegistry.namesFor('queue').sort()).toEqual(['cloudrun', 'railway']);
    expect(providerRegistry.namesForMutation('queue').sort()).toEqual(['cloudrun', 'railway']);

    expect(providerRegistry.getMetadata('cloudrun')?.lifecycle?.queue).toEqual({
      backend: cloudRun.capabilities.queues?.backend,
      resources: 'managed',
    });
    expect(supportsManagedQueues(cloudRun)).toBe(true);

    expect(providerRegistry.getMetadata('railway')?.lifecycle?.queue).toEqual({
      backend: railway.capabilities.queues?.backend,
      resources: 'application-managed',
    });
    // Railway queues ride the declared PostgreSQL database. There is no
    // provider queue resource for an adapter to create or delete.
    expect(supportsManagedQueues(railway)).toBe(false);
  });

  it('advertises load balancing only when the provider implements the full port', () => {
    const providers = providerRegistry.namesFor('load-balancer');
    expect(providers).toEqual(['cloudflare']);
    expect(providerRegistry.namesForMutation('load-balancer')).toEqual(['cloudflare']);
    expect(supportsLoadBalancer(new CloudflareAdapter())).toBe(true);
    expect(providerRegistry.getMetadata('cloudflare')?.lifecycle?.loadBalancer).toEqual({
      topology: 'monitor-pool-balancer',
      minimumOrigins: 2,
    });
  });

  it('advertises storage only for adapters with lifecycle and data-plane coverage', () => {
    const adapters = new Map<string, unknown>([
      ['s3', new S3StorageAdapter()],
      ['azureblob', new AzureBlobStorageAdapter()],
      ['gcs', new GcsStorageAdapter()],
      ['railway', createRailwayStorageAdapter(new RailwayAdapter())],
    ]);
    expect([...adapters.keys()].sort()).toEqual(providerRegistry.namesFor('storage').sort());
    for (const [provider, adapter] of adapters) {
      expect(supportsStorageLifecycle(adapter), provider).toBe(true);
    }
  });

  it('advertises cache only for adapters with the complete lifecycle port', () => {
    const railway = new RailwayAdapter();
    const adapters = new Map<string, unknown>([
      ['railway', createRailwayCacheAdapter({ hostingAdapter: railway, envRepo: {} as never })],
      ['memorystore', new MemorystoreAdapter()],
      ['elasticache', new ElastiCacheAdapter()],
      ['azure-managed-redis', new AzureManagedRedisAdapter()],
      ['digitalocean', new DigitalOceanCacheAdapter()],
    ]);

    expect([...adapters.keys()].sort()).toEqual(providerRegistry.namesFor('cache').sort());
    expect(providerRegistry.namesForMutation('cache').sort())
      .toEqual(providerRegistry.namesFor('cache').sort());
    for (const [provider, adapter] of adapters) {
      expect(supportsCacheLifecycle(adapter), provider).toBe(true);
    }
  });

  it('declares every provider-specific cache network boundary explicitly', () => {
    const expected = new Map<string, string[] | undefined>([
      ['railway', ['railway']],
      ['memorystore', ['cloudrun']],
      ['elasticache', ['ecs']],
      ['azure-managed-redis', ['azure-container-apps']],
      ['digitalocean', undefined],
    ]);

    expect([...expected.keys()].sort()).toEqual(providerRegistry.namesFor('cache').sort());
    for (const [provider, compatibleHostingProviders] of expected) {
      expect(
        providerRegistry.getMetadata(provider)?.lifecycle?.cacheConnectivity
          ?.compatibleHostingProviders,
        provider
      ).toEqual(compatibleHostingProviders);
    }
  });
});
