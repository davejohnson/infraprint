import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import {
  supportsCustomDomainAttach,
  supportsCustomDomainDetach,
} from '../../../domain/services/domain-attach-policy.js';
import { supportsWorkloadMaintenance } from '../../../domain/ports/maintenance.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { EcsExpressAdapter } from '../aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../azure/azure-container-apps.adapter.js';
import { DigitalOceanAdapter } from '../digitalocean/digitalocean.adapter.js';
import { FlyAdapter } from '../fly/fly.adapter.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { VercelAdapter } from '../vercel/vercel.adapter.js';

const adapters = new Map<string, object>([
  ['railway', new RailwayAdapter()],
  ['cloudrun', new CloudRunAdapter()],
  ['ecs', new EcsExpressAdapter()],
  ['azure-container-apps', new AzureContainerAppsAdapter()],
  ['digitalocean', new DigitalOceanAdapter()],
  ['vercel', new VercelAdapter()],
  ['fly', new FlyAdapter()],
]);

const workloadKinds = new Map<string, Array<'web' | 'worker' | 'cron'>>([
  ['railway', ['web', 'worker', 'cron']],
  ['cloudrun', ['web', 'worker', 'cron']],
  ['ecs', ['web']],
  ['azure-container-apps', ['web']],
  ['digitalocean', ['web', 'worker', 'cron']],
  ['vercel', ['web']],
  ['fly', ['web', 'worker']],
]);

describe('production hosting capability truth', () => {
  it('has an explicit adapter for every advertised hosting lifecycle', () => {
    expect([...adapters.keys()].sort()).toEqual(providerRegistry.namesFor('hosting').sort());
  });

  it('keeps observation, maintenance, and custom-domain metadata aligned with ports', () => {
    for (const [provider, rawAdapter] of adapters) {
      const adapter = rawAdapter as Record<string, unknown> & {
        capabilities: {
          supportsObserve: boolean;
          supportsCronSchedule: boolean;
          supportsMaintenance?: boolean;
        };
      };
      const lifecycle = providerRegistry.getMetadata(provider)!.lifecycle!.hosting!;

      expect(lifecycle.workloadKinds, `${provider} workload kinds`)
        .toEqual(workloadKinds.get(provider));
      expect(adapter.capabilities.supportsCronSchedule, `${provider} cron capability`)
        .toBe(lifecycle.workloadKinds.includes('cron'));
      expect(typeof adapter.observe === 'function', `${provider} observation`)
        .toBe(adapter.capabilities.supportsObserve);
      expect(supportsWorkloadMaintenance(adapter), `${provider} maintenance port`)
        .toBe(lifecycle.maintenance === 'managed');
      expect(adapter.capabilities.supportsMaintenance === true, `${provider} maintenance flag`)
        .toBe(lifecycle.maintenance === 'managed');
      expect(supportsCustomDomainAttach(adapter), `${provider} attach-domain port`)
        .toBe(lifecycle.customDomains === 'managed');
      expect(supportsCustomDomainDetach(adapter), `${provider} detach-domain port`)
        .toBe(lifecycle.customDomains === 'managed');
    }
  });

  it('implements the deletion method promised by each teardown boundary', () => {
    for (const [provider, rawAdapter] of adapters) {
      const adapter = rawAdapter as Record<string, unknown>;
      const boundary = providerRegistry.getMetadata(provider)!.lifecycle!.hosting!.teardownBoundary;
      const method = boundary === 'project'
        ? 'deleteProject'
        : boundary === 'environment'
          ? 'deleteEnvironment'
          : 'deleteService';
      expect(typeof adapter[method], `${provider} ${boundary} teardown`).toBe('function');
    }
  });
});
