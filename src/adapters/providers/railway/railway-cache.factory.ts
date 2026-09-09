import type { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type {
  HostingServiceDeleteOptions,
  HostingServiceDeleteScope,
  IProviderAdapter,
} from '../../../domain/ports/provider.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type {
  CacheEngine,
  CacheProvisionResult,
  CacheTargetOptions,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import type {
  RailwayProjectDetails,
  RailwayVolumeResolution,
  RailwayVolumeTarget,
} from './railway.adapter.js';

interface RailwayCacheOps {
  ensureComponent(type: ComponentType, environment: Environment): Promise<{
    component: Component;
    receipt: {
      success: boolean;
      message: string;
      error?: string;
      data?: Record<string, unknown>;
    };
  }>;
  deleteService?(serviceId: string, target: HostingServiceDeleteScope, options: HostingServiceDeleteOptions): Promise<{ success: boolean; error?: string }>;
  resolveServiceVolume?(
    target: RailwayVolumeTarget,
    expectedVolumeId?: string
  ): Promise<RailwayVolumeResolution>;
  deleteVolume?(
    volumeId: string,
    target: RailwayVolumeTarget
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;
  getProjectDetails?(projectId: string): Promise<RailwayProjectDetails | null>;
}

function failedComponent(environment: Environment, engine: CacheEngine): Component {
  return {
    id: '',
    environmentId: environment.id,
    type: engine,
    bindings: {},
    externalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function assertRailwayCacheTarget(target: CacheTargetOptions | undefined): void {
  const supplied = (['region', 'network', 'subnetwork', 'tier', 'size'] as const)
    .filter((field) => target?.[field] !== undefined);
  if (supplied.length > 0) {
    throw new Error(
      `Railway Redis does not support declarative cache ${supplied.join(', ')}; remove those fields or choose a cache provider that implements them.`
    );
  }
}

function resolveRedisVolumeTarget(
  component: Component,
  environment: Environment | null,
  scopedProjectId: string,
  volumeId: string | undefined
): { target?: RailwayVolumeTarget; error?: string } {
  if (!environment) {
    return { error: 'The Railway Redis environment binding is missing.' };
  }
  const bindings = component.bindings as Record<string, unknown>;
  const rawTarget = bindings.volumeTarget;
  const expectedMountPath = '/bitnami/redis/data';
  if (rawTarget !== undefined) {
    if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
      return { error: 'The Railway Redis volume target marker is malformed.' };
    }
    const record = rawTarget as Record<string, unknown>;
    if (typeof record.projectId !== 'string' || record.projectId.trim().length === 0
      || typeof record.environmentId !== 'string' || record.environmentId.trim().length === 0
      || typeof record.serviceId !== 'string' || record.serviceId.trim().length === 0
      || typeof record.mountPath !== 'string' || record.mountPath.trim().length === 0) {
      return { error: 'The Railway Redis volume target marker is incomplete.' };
    }
    const target: RailwayVolumeTarget = {
      projectId: record.projectId,
      environmentId: record.environmentId,
      serviceId: record.serviceId,
      mountPath: record.mountPath,
    };
    const environmentId = (environment.platformBindings as Record<string, unknown>).environmentId;
    if (target.projectId !== scopedProjectId
      || target.serviceId !== component.externalId
      || target.mountPath !== expectedMountPath
      || (typeof environmentId === 'string' && target.environmentId !== environmentId)) {
      return {
        error: 'The Railway Redis volume target marker does not match the durable project, environment, service, and mount identities.',
      };
    }
    return { target };
  }

  if (bindings.retainedCleanup === true) {
    const rawScope = bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    const scopedEnvironmentId = typeof scope?.environmentId === 'string'
      ? scope.environmentId
      : undefined;
    if (
      !component.externalId
      || !scopedEnvironmentId
    ) {
      return {
        error: 'The retained Railway Redis identity is missing its exact matching environment scope, so attached-volume observation is unsafe.',
      };
    }
    return {
      target: {
        projectId: scopedProjectId,
        environmentId: scopedEnvironmentId,
        serviceId: component.externalId,
        mountPath: expectedMountPath,
      },
    };
  }

  if (!volumeId) return {};
  const environmentId = (environment.platformBindings as Record<string, unknown>).environmentId;
  if (typeof environmentId !== 'string' || environmentId.trim().length === 0
    || !component.externalId) {
    return {
      error: 'The legacy Railway Redis volume binding cannot be scoped to an exact environment and service; re-import or repair the volume target before deletion.',
    };
  }
  return {
    target: {
      projectId: scopedProjectId,
      environmentId,
      serviceId: component.externalId,
      mountPath: expectedMountPath,
    },
  };
}

/**
 * Railway Redis is a service-backed datastore inside the already-reviewed
 * Railway project. The cache action cannot create or adopt a project.
 */
export function createRailwayCacheAdapter(params: {
  hostingAdapter: IProviderAdapter;
  envRepo: EnvironmentRepository;
  project?: Project;
}): ICacheAdapter {
  const { hostingAdapter, envRepo, project } = params;
  const railway = hostingAdapter as unknown as RailwayCacheOps;

  const observeRetainedCache = async (component: Component): Promise<ObservedCache | null> => {
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    const projectId = typeof scope?.projectId === 'string' ? scope.projectId : undefined;
    const environmentId = typeof scope?.environmentId === 'string' ? scope.environmentId : undefined;
    if (!component.externalId || !projectId || !environmentId) {
      throw new Error('Railway retained Redis observation requires an exact service id and durable project/environment scope.');
    }
    if (typeof railway.getProjectDetails !== 'function') {
      throw new Error('Railway hosting adapter does not expose retained Redis observation.');
    }
    const details = await railway.getProjectDetails(projectId);
    if (!details) return null;
    const services = details.services.edges
      .map((edge) => edge.node)
      .filter((service) => service.id === component.externalId);
    if (services.length > 1) {
      throw new Error(`Railway returned multiple services for retained Redis id ${component.externalId}.`);
    }
    const service = services[0];
    if (!service) return null;
    const instances = (service.serviceInstances?.edges ?? [])
      .map((edge) => edge.node)
      .filter((instance) => instance.environmentId === environmentId);
    if (instances.length !== 1) {
      throw new Error(`Railway did not return exactly one ${environmentId} instance for retained Redis service ${component.externalId}.`);
    }
    const image = instances[0]!.source?.image?.trim().toLowerCase();
    if (!image || !/(^|\/)(redis|valkey)(?::|@|$)/.test(image)) {
      throw new Error(`Railway service ${component.externalId} is not provider-verified as a Redis-compatible image in environment ${environmentId}.`);
    }
    return {
      provider: 'railway',
      engine: 'redis',
      externalId: service.id,
      providerScope: { projectId, environmentId },
      name: service.name,
      status: 'unknown',
    };
  };

  return {
    name: 'railway',
    capabilities: {
      supportedCaches: ['redis'],
      supportsTls: false,
      supportsHighAvailability: false,
      supportsPersistence: true,
      serverlessOptimized: false,
    },
    async connect() {
      // The primary Railway adapter is already connected by AdapterFactory.
    },
    async verify() {
      return typeof hostingAdapter.verify === 'function'
        ? hostingAdapter.verify()
        : { success: true };
    },
    configureTarget(target) {
      assertRailwayCacheTarget(target);
    },
    async provision(engine, environment, options): Promise<CacheProvisionResult> {
      assertRailwayCacheTarget(options);
      if (engine !== 'redis') {
        return {
          component: failedComponent(environment, engine),
          receipt: {
            success: false,
            message: `Railway cache adapter supports only redis (requested: ${engine})`,
          },
        };
      }
      const refreshedEnvironment = envRepo.findById(environment.id) ?? environment;
      const projectId = (refreshedEnvironment.platformBindings as Record<string, unknown>).projectId;
      const environmentId = (refreshedEnvironment.platformBindings as Record<string, unknown>).environmentId;
      if (typeof projectId !== 'string' || projectId.length === 0
        || typeof environmentId !== 'string' || environmentId.length === 0) {
        return {
          component: failedComponent(environment, engine),
          receipt: {
            success: false,
            message: 'Railway project binding is missing',
            error: 'Apply the reviewed project/environment actions first, then re-run hv_plan. Cache provisioning will not create or rebind hosting scope implicitly.',
            data: {
              phase: 'requireProjectBinding',
              provider: 'railway',
              requestedProjectName: project?.name ?? `project-${environment.projectId}`,
            },
          },
        };
      }

      const result = await railway.ensureComponent('redis', refreshedEnvironment);
      if (!result.receipt.success) {
        return result;
      }
      const rawBindings = result.component.bindings as Record<string, unknown>;
      const pluginName = typeof rawBindings.pluginName === 'string'
        ? rawBindings.pluginName
        : 'redis-db';
      const connectionUrl = '${{' + pluginName + '.REDIS_URL}}';
      return {
        component: {
          ...result.component,
          bindings: {
            ...rawBindings,
            provider: 'railway',
            projectId,
            providerScope: { projectId, environmentId },
            connectionUrl,
            pluginName,
          },
        },
        receipt: {
          ...result.receipt,
          data: {
            ...(result.receipt.data ?? {}),
            phase: 'completed',
            provider: 'railway',
            providerProjectId: projectId,
          },
        },
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
      };
    },
    async getConnectionUrl(component) {
      const value = (component.bindings as Record<string, unknown>).connectionUrl;
      return typeof value === 'string' ? value : null;
    },
    async observeCache(environment, component, options) {
      assertRailwayCacheTarget(options);
      if (component?.bindings.retainedCleanup === true) {
        return observeRetainedCache(component);
      }
      if (typeof hostingAdapter.observe !== 'function') {
        throw new Error('Railway cache observation is unavailable');
      }
      const environmentProjectId = (environment.platformBindings as Record<string, unknown>).projectId;
      if (component) {
        const componentBindings = component.bindings as Record<string, unknown>;
        const providerScope = componentBindings.providerScope;
        const scopedProjectId = providerScope
          && typeof providerScope === 'object'
          && !Array.isArray(providerScope)
          ? (providerScope as Record<string, unknown>).projectId
          : undefined;
        if (
          typeof scopedProjectId !== 'string'
          || scopedProjectId.length === 0
          || typeof environmentProjectId !== 'string'
          || environmentProjectId.length === 0
          || scopedProjectId !== environmentProjectId
        ) {
          throw new Error('Railway Redis observation is blocked because its durable project scope is missing or differs from the current environment binding');
        }
      }
      const observed = await hostingAdapter.observe(environment);
      const caches = observed.caches ?? [];
      if (component?.externalId) {
        const componentBindings = component.bindings as Record<string, unknown>;
        const componentScope = componentBindings.providerScope;
        const scopedEnvironmentId = componentScope
          && typeof componentScope === 'object'
          && !Array.isArray(componentScope)
          ? (componentScope as Record<string, unknown>).environmentId
          : undefined;
        const environmentId = (environment.platformBindings as Record<string, unknown>).environmentId;
        if (typeof scopedEnvironmentId !== 'string' || scopedEnvironmentId.length === 0
          || typeof environmentId !== 'string' || environmentId.length === 0
          || scopedEnvironmentId !== environmentId) {
          throw new Error('Railway Redis observation is blocked because its durable environment scope is missing or differs from the current environment binding');
        }
        const matches = caches.filter((cache) => (
          cache.externalId === component.externalId
          && cache.providerScope?.projectId === environmentProjectId
          && cache.providerScope?.environmentId === environmentId
        ));
        if (matches.length > 1) {
          throw new Error(`Multiple Railway Redis caches match durable id ${component.externalId}`);
        }
        return matches[0] ?? null;
      }
      const resourceName = options?.resourceName?.toLowerCase();
      const matches = resourceName
        ? caches.filter((cache) => cache.name?.toLowerCase() === resourceName)
        : caches;
      if (matches.length > 1) {
        throw new Error(`Multiple Railway Redis caches match ${options?.resourceName ?? 'the requested environment'}`);
      }
      return matches[0] ?? null;
    },
    async destroy(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const resourceKind = bindings.resourceKind;
      const recordedVolumeId = typeof bindings.volumeId === 'string' && bindings.volumeId.trim().length > 0
        ? bindings.volumeId
        : undefined;
      const providerScope = bindings.providerScope;
      const scopedProjectId = providerScope
        && typeof providerScope === 'object'
        && !Array.isArray(providerScope)
        ? (providerScope as Record<string, unknown>).projectId
        : undefined;
      const boundEnvironment = envRepo.findById(component.environmentId);
      const boundProjectId = boundEnvironment
        ? (boundEnvironment.platformBindings as Record<string, unknown>).projectId
        : undefined;
      const retainedCleanup = bindings.retainedCleanup === true;
      const scopedEnvironmentId = providerScope
        && typeof providerScope === 'object'
        && !Array.isArray(providerScope)
        ? (providerScope as Record<string, unknown>).environmentId
        : undefined;
      if (
        bindings.provider !== 'railway'
        || typeof scopedProjectId !== 'string'
        || scopedProjectId.length === 0
        || (retainedCleanup
          ? typeof scopedEnvironmentId !== 'string' || scopedEnvironmentId.length === 0
          : typeof boundProjectId !== 'string'
            || boundProjectId.length === 0
            || scopedProjectId !== boundProjectId)
      ) {
        return {
          success: false,
          message: `Refusing to destroy Railway Redis component ${component.externalId ?? component.id}`,
          error: 'The durable Railway project scope is missing or differs from the current environment binding.',
        };
      }
      if (resourceKind !== 'service') {
        return {
          success: false,
          message: `Refusing to destroy Railway Redis component ${component.externalId ?? component.id}`,
          error: resourceKind === 'plugin' || resourceKind === 'legacy-plugin'
            ? 'Legacy Railway Redis plugins do not have a verified teardown contract. Migrate or clean up the exact plugin explicitly; Hypervibe will not send its id to the service deletion API.'
            : 'The Railway Redis binding does not prove that this id is a service-backed datastore. Re-observe or explicitly import the exact service before deletion.',
        };
      }
      if (bindings.volumeId !== undefined && !recordedVolumeId) {
        return {
          success: false,
          message: `Refusing to destroy Railway Redis component ${component.externalId ?? component.id}`,
          error: 'The Railway Redis volume id binding is malformed.',
        };
      }
      if (!component.externalId || typeof railway.deleteService !== 'function') {
        return {
          success: false,
          message: `Destroy is not implemented for Railway Redis component ${component.externalId ?? component.id}`,
        };
      }
      const volumeTargetResult = resolveRedisVolumeTarget(
        component,
        boundEnvironment,
        scopedProjectId,
        recordedVolumeId
      );
      if (volumeTargetResult.error) {
        return {
          success: false,
          message: `Refusing to destroy Railway Redis component ${component.externalId}`,
          error: volumeTargetResult.error,
        };
      }
      let volumeId = recordedVolumeId;
      const volumeTarget = volumeTargetResult.target;
      if (volumeTarget) {
        if (typeof railway.resolveServiceVolume !== 'function') {
          return {
            success: false,
            message: `Refusing to destroy Railway Redis component ${component.externalId}`,
            error: 'Railway volume observation is unavailable, so the persistent-volume identity is unknown.',
          };
        }
        const resolved = await railway.resolveServiceVolume(volumeTarget, recordedVolumeId);
        if (!resolved.success) {
          return {
            success: false,
            message: `Refusing to destroy Railway Redis component ${component.externalId}`,
            error: `Railway volume identity is unknown: ${resolved.error}`,
          };
        }
        volumeId = resolved.state === 'present' ? resolved.volumeId : undefined;
      }
      if (volumeId && (!volumeTarget || typeof railway.deleteVolume !== 'function')) {
        return {
          success: false,
          message: `Refusing to destroy Railway Redis component ${component.externalId}`,
          error: `Railway volume ${volumeId} cannot be safely deleted because scoped volume cleanup is unavailable.`,
        };
      }
      const boundEnvironmentId = boundEnvironment
        ? (boundEnvironment.platformBindings as Record<string, unknown>).environmentId
        : undefined;
      const targetEnvironmentId = retainedCleanup
        ? scopedEnvironmentId
        : boundEnvironmentId;
      if (typeof targetEnvironmentId !== 'string' || targetEnvironmentId.length === 0) {
        return {
          success: false,
          message: `Refusing to destroy Railway Redis service ${component.externalId}`,
          error: 'The durable Railway environment scope is missing; project-only service deletion is unsafe.',
        };
      }
      const deletedService = await railway.deleteService(component.externalId, {
        scope: 'environment',
        projectId: scopedProjectId,
        environmentId: targetEnvironmentId,
      }, { allowMutation: true });
      if (!deletedService.success) {
        return {
          success: false,
          message: `Failed to delete Railway Redis service ${component.externalId}; persistent volume was preserved`,
          error: deletedService.error,
        };
      }
      if (volumeId && volumeTarget) {
        const deletedVolume = await railway.deleteVolume!(volumeId, volumeTarget);
        if (!deletedVolume.success) {
          return {
            success: false,
            message: `Deleted Railway Redis service ${component.externalId}, but failed to delete its volume`,
            error: deletedVolume.error,
          };
        }
      }
      return {
        success: true,
        message: `Deleted Railway Redis service ${component.externalId}${volumeId ? ` and volume ${volumeId}` : ''}`,
      };
    },
  };
}
