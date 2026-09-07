import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  isProviderBuildLogsAdapter,
  isProviderDeploymentsAdapter,
  isProviderRuntimeLogsAdapter,
} from '../../../domain/ports/provider-logs.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { EcsExpressAdapter } from '../aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../azure/azure-container-apps.adapter.js';
import { DigitalOceanAdapter } from '../digitalocean/digitalocean.adapter.js';
import { FlyAdapter } from '../fly/fly.adapter.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { GitHubAdapter } from '../github/github.adapter.js';
import { GitLabAdapter } from '../gitlab/gitlab.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { VercelAdapter } from '../vercel/vercel.adapter.js';

const deploymentAdapterPrototypes = new Map<string, unknown>([
  ['railway', RailwayAdapter.prototype],
  ['cloudrun', CloudRunAdapter.prototype],
  ['ecs', EcsExpressAdapter.prototype],
  ['azure-container-apps', AzureContainerAppsAdapter.prototype],
  ['digitalocean', DigitalOceanAdapter.prototype],
  ['vercel', VercelAdapter.prototype],
  ['fly', FlyAdapter.prototype],
  ['github', GitHubAdapter.prototype],
  ['gitlab', GitLabAdapter.prototype],
]);

function environment(platformBindings: Record<string, unknown>): Environment {
  const now = new Date('2026-09-04T00:00:00.000Z');
  return {
    id: 'environment-1',
    projectId: 'project-1',
    name: 'staging',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider log ports', () => {
  it('keeps every registered provider log advertisement consistent with its implemented port', () => {
    const registeredHostingProviders = providerRegistry.getByCategory('deployment')
      .map((provider) => provider.metadata.name)
      .sort();
    expect([...deploymentAdapterPrototypes.keys()].sort()).toEqual(registeredHostingProviders);

    for (const provider of providerRegistry.all()) {
      const adapter = deploymentAdapterPrototypes.get(provider.metadata.name);
      const advertised = provider.metadata.orchestration?.logs;
      expect({
        runtime: isProviderRuntimeLogsAdapter(adapter),
        deployments: isProviderDeploymentsAdapter(adapter),
        build: isProviderBuildLogsAdapter(adapter),
      }, provider.metadata.name).toEqual({
        runtime: advertised?.runtime === true,
        deployments: advertised?.deployments === true,
        build: advertised?.build === true,
      });
    }
  });

  it('adapts Railway deployment logs without losing the exact service or limit', async () => {
    const adapter = new RailwayAdapter();
    const getDeployments = vi.spyOn(adapter, 'getDeployments').mockResolvedValue([{
      id: 'deployment-1',
      status: 'SUCCESS',
      createdAt: '2026-09-04T00:00:00.000Z',
    }]);
    const getDeploymentLogs = vi.spyOn(adapter, 'getDeploymentLogs').mockResolvedValue([{
      timestamp: '2026-09-04T00:00:01.000Z',
      severity: 'error',
      message: 'failed',
    }]);
    const target = environment({
      provider: 'railway',
      projectId: 'railway-project',
      environmentId: 'railway-environment',
      services: { web: { serviceId: 'railway-service' } },
    });

    await expect(adapter.readProviderLogs({
      environment: target,
      serviceName: 'web',
      limit: 37,
      errorsOnly: true,
    })).resolves.toEqual({
      deploymentId: 'deployment-1',
      deploymentStatus: 'SUCCESS',
      logs: [{
        timestamp: '2026-09-04T00:00:01.000Z',
        severity: 'error',
        message: 'failed',
      }],
    });
    expect(getDeployments).toHaveBeenCalledWith(
      'railway-project',
      'railway-environment',
      'railway-service',
      1
    );
    expect(getDeploymentLogs).toHaveBeenCalledWith('deployment-1', 37);
  });

  it('adapts Cloud Run runtime logs and status through the same port', async () => {
    const adapter = new CloudRunAdapter();
    const getLogs = vi.spyOn(adapter, 'getLogs').mockResolvedValue([{
      timestamp: new Date('2026-09-04T00:00:01.000Z'),
      severity: 'warn',
      message: 'retrying',
      raw: 'retrying',
    }]);
    const getDeployStatus = vi.spyOn(adapter, 'getDeployStatus').mockResolvedValue({ status: 'deployed' });
    const target = environment({
      provider: 'cloudrun',
      projectId: 'cloudrun-project',
      environmentId: 'us-central1',
      services: { web: { serviceId: 'cloudrun-service' } },
    });

    await expect(adapter.readProviderLogs({
      environment: target,
      serviceName: 'web',
      limit: 23,
      errorsOnly: true,
    })).resolves.toEqual({
      deploymentId: 'cloudrun-service',
      deploymentStatus: 'deployed',
      logs: [{
        timestamp: '2026-09-04T00:00:01.000Z',
        severity: 'warn',
        message: 'retrying',
      }],
    });
    expect(getLogs).toHaveBeenCalledWith(target, 'web', { limit: 23, errorsOnly: true });
    expect(getDeployStatus).toHaveBeenCalledWith(target, 'cloudrun-service');
  });

  it('does not broaden an unknown Railway service to environment-wide deployments', async () => {
    const adapter = new RailwayAdapter();
    const getDeployments = vi.spyOn(adapter, 'getDeployments').mockResolvedValue([]);
    const target = environment({
      provider: 'railway',
      projectId: 'railway-project',
      environmentId: 'railway-environment',
      services: { web: { serviceId: 'railway-service' } },
    });

    await expect(adapter.listProviderDeployments({
      environment: target,
      serviceName: 'typo',
      limit: 10,
    })).rejects.toThrow('Environment/service not fully bound to railway');
    expect(getDeployments).not.toHaveBeenCalled();
  });
});
