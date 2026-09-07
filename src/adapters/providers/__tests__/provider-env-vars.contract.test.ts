import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import { isProviderEnvironmentVariablesAdapter } from '../../../domain/ports/provider-env-vars.port.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';

const now = new Date('2026-09-06T00:00:00.000Z');
const service: Service = {
  id: 'service-local',
  projectId: 'project-local',
  name: 'worker',
  buildConfig: { workloadKind: 'worker' },
  envVarSpec: {},
  createdAt: now,
  updatedAt: now,
};

function environment(provider: string): Environment {
  return {
    id: 'environment-local',
    projectId: 'project-local',
    name: 'staging',
    platformBindings: {
      provider,
      projectId: `${provider}-project`,
      environmentId: `${provider}-environment`,
      services: {
        worker: { serviceId: `${provider}-worker` },
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('provider environment-variable read port', () => {
  it('normalizes Cloud Run service-name reads behind the shared request', async () => {
    const adapter = new CloudRunAdapter();
    const target = environment('cloudrun');
    const read = vi.spyOn(adapter, 'getServiceVariables').mockResolvedValue({ KEY: 'cloudrun-value' });

    expect(isProviderEnvironmentVariablesAdapter(adapter)).toBe(true);
    await expect(adapter.readProviderEnvironmentVariables({ environment: target, service }))
      .resolves.toEqual({ success: true, variables: { KEY: 'cloudrun-value' } });
    expect(read).toHaveBeenCalledWith(target, 'worker');
  });

  it('normalizes Railway durable binding reads without broadening service identity', async () => {
    const adapter = new RailwayAdapter();
    const target = environment('railway');
    const read = vi.spyOn(adapter, 'getServiceVariables').mockResolvedValue({ KEY: 'railway-value' });

    expect(isProviderEnvironmentVariablesAdapter(adapter)).toBe(true);
    await expect(adapter.readProviderEnvironmentVariables({ environment: target, service }))
      .resolves.toEqual({ success: true, variables: { KEY: 'railway-value' } });
    expect(read).toHaveBeenCalledWith(
      'railway-project',
      'railway-worker',
      'railway-environment'
    );

    await expect(adapter.readProviderEnvironmentVariables({
      environment: target,
      service: { ...service, name: 'typo' },
    })).resolves.toEqual({
      success: false,
      error: 'Service typo is missing Railway bindings in staging',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
