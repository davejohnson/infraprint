import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { IStorageAdapter, StorageContext, StorageEnsureResult } from '../../../domain/ports/storage.port.js';
import {
  railwayStorageRuntimeEnv,
  S3_STORAGE_RUNTIME_ENV_KEYS,
  s3StorageRuntimeEnv,
} from '../../../domain/services/storage-runtime-env.js';
import { RailwayAdapter } from './railway.adapter.js';

function virtualEnvironment(environment: Environment, context: StorageContext): Environment {
  return {
    ...environment,
    platformBindings: {
      ...environment.platformBindings,
      projectId: context.projectId,
      environmentId: context.environmentId,
      services: environment.platformBindings.services ?? {},
    },
  };
}

export function createRailwayStorageAdapter(railway: RailwayAdapter): IStorageAdapter {
  return {
    name: 'railway',
    capabilities: {
      kind: 'object',
      regions: ['sjc', 'iad', 'ams', 'sin'],
      privateOnly: true,
      supportsUsageObservation: true,
      supportsObjectTransfer: true,
    },
    runtimeEnvKeys: () => [...S3_STORAGE_RUNTIME_ENV_KEYS],
    connect: (credentials) => railway.connect(credentials),
    verify: () => railway.verify(),
    disconnect: () => railway.disconnect(),
    async resolveObservationContext(_projectName, environment): Promise<StorageEnsureResult> {
      const hostingProvider = typeof environment.platformBindings.provider === 'string'
        ? environment.platformBindings.provider
        : undefined;
      return {
        receipt: {
          success: false,
          message: 'Railway storage scope is not available for read-only observation',
          error: hostingProvider && hostingProvider !== 'railway'
            ? `Railway buckets require an exact persisted Railway projectId/environmentId. Environment "${environment.name}" is hosted on ${hostingProvider}, so Hypervibe will not guess a Railway project by name or create provider scaffolding during observation. Import an existing Railway storage binding with hv_import, or choose storage hosted by the connected primary cloud.`
            : `Railway buckets require an exact persisted Railway projectId/environmentId. Hypervibe will not guess a Railway project by name or create provider scaffolding during observation. Apply the Railway hosting environment first, or explicitly import an existing Railway storage binding with hv_import.`,
        },
      };
    },
    async ensureContext(projectName, environment, context): Promise<StorageEnsureResult> {
      const receipt = await railway.ensureStorageContext(projectName, environment, context);
      const projectId = typeof receipt.data?.projectId === 'string' ? receipt.data.projectId : undefined;
      const environmentId = typeof receipt.data?.environmentId === 'string' ? receipt.data.environmentId : undefined;
      return { receipt, ...(projectId && environmentId ? { context: { projectId, environmentId } } : {}) };
    },
    async ensureBucket(environment, context, name, region): Promise<StorageEnsureResult> {
      const receipt = await railway.ensureStorage(virtualEnvironment(environment, context), name, { region });
      const externalId = typeof receipt.data?.externalId === 'string' ? receipt.data.externalId : undefined;
      return { receipt, externalId, context };
    },
    async observe(environment, context) {
      const observed = await railway.observe(virtualEnvironment(environment, context));
      return observed.storage ?? [];
    },
    async getRuntimeEnv(environment, context, externalId, name) {
      const provider = typeof environment.platformBindings.provider === 'string'
        ? environment.platformBindings.provider
        : undefined;
      if (provider === 'railway') return railwayStorageRuntimeEnv(name);
      const credentials = await railway.getStorageCredentials(virtualEnvironment(environment, context), externalId);
      return s3StorageRuntimeEnv(credentials);
    },
    getCredentials: (environment, context, externalId) => railway.getStorageCredentials(virtualEnvironment(environment, context), externalId),
    destroyBucket: (environment, context, externalId) => railway.destroyStorage(virtualEnvironment(environment, context), externalId),
  };
}
