import type { Project } from '../../../domain/entities/project.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type { IProviderAdapter, TemporaryDatabaseAccess } from '../../../domain/ports/provider.port.js';
import type { IDatabaseAdapter, ProvisionResult, ProvisionableType } from '../../../domain/ports/database.port.js';
import type { ObservedDatabase, ObservedState } from '../../../domain/ports/observe.port.js';
import type { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import type { RailwayVolumeResolution, RailwayVolumeTarget } from './railway.adapter.js';

interface RailwayHostingOps {
  ensureProject: (projectName: string, environment: Environment) => Promise<{
    success: boolean;
    data?: Record<string, unknown>;
    message: string;
    error?: string;
  }>;
  ensureComponent: (type: ComponentType, environment: Environment) => Promise<{
    component: Component;
    receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
  }>;
  listPlugins: (projectId: string) => Promise<Array<{ id: string; name: string; type: string }>>;
  getProjectDetails?: (projectId: string) => Promise<{
    services: { edges: Array<{ node: {
      id: string;
      name: string;
      serviceInstances?: { edges?: Array<{ node?: { source?: { image?: string | null } | null } }> };
    } }> };
    plugins: { edges: Array<{ node: { id: string; name: string } }> };
  } | null>;
  observe?: (environment: Environment) => Promise<ObservedState>;
  deleteProject?: (projectId: string) => Promise<{ success: boolean; error?: string }>;
  deleteService?: (serviceId: string) => Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;
  resolveServiceVolume?: (
    target: RailwayVolumeTarget,
    expectedVolumeId?: string
  ) => Promise<RailwayVolumeResolution>;
  deleteVolume?: (
    volumeId: string,
    target: RailwayVolumeTarget
  ) => Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }>;
  acquireTemporaryDatabaseAccess?: (
    environment: Environment,
    component: Component,
    applicationPort: number
  ) => Promise<TemporaryDatabaseAccess>;
  releaseTemporaryDatabaseAccess?: (
    environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ) => Promise<void>;
}

/**
 * Railway has no standalone database product: databases are services inside a
 * Railway hosting project. This factory wraps a connected Railway hosting
 * adapter in the IDatabaseAdapter port, including auth-recovery retry and
 * cleanup of projects it created itself.
 */
export function createRailwayDatabaseAdapter(params: {
  hostingAdapter: IProviderAdapter;
  envRepo: EnvironmentRepository;
  project?: Project;
}): IDatabaseAdapter {
  const { hostingAdapter, envRepo, project } = params;
  const railway = hostingAdapter as unknown as RailwayHostingOps;

  const makePluginVarRefs = (pluginName: string, type: ProvisionableType): Record<string, string> => {
    const ref = (varName: string) => '${{' + pluginName + '.' + varName + '}}';
    if (type === 'postgres') {
      return {
        DATABASE_URL: ref('DATABASE_URL'),
        DIRECT_URL: ref('DATABASE_PRIVATE_URL'),
      };
    }
    // Railway plugin provisioning currently supports postgres in DB flows.
    return {};
  };

  const componentProjectId = (component?: Component | null): string | undefined => {
    const providerScope = component?.bindings.providerScope;
    if (!providerScope || typeof providerScope !== 'object' || Array.isArray(providerScope)) {
      return undefined;
    }
    const projectId = (providerScope as Record<string, unknown>).projectId;
    return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
  };

  const environmentProjectId = (environment: Environment): string | undefined => {
    const projectId = (environment.platformBindings as Record<string, unknown>).projectId;
    return typeof projectId === 'string' && projectId.length > 0 ? projectId : undefined;
  };

  const resolveVolumeTarget = (
    component: Component,
    environment: Environment | undefined,
    scopedProjectId: string,
    volumeId: string | undefined
  ): { target?: RailwayVolumeTarget; error?: string } => {
    const bindings = component.bindings as Record<string, unknown>;
    const rawTarget = bindings.volumeTarget;
    const expectedMountPath = '/var/lib/postgresql/data';
    if (rawTarget !== undefined) {
      if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
        return { error: 'The Railway database volume target marker is malformed.' };
      }
      const record = rawTarget as Record<string, unknown>;
      if (typeof record.projectId !== 'string' || record.projectId.trim().length === 0
        || typeof record.environmentId !== 'string' || record.environmentId.trim().length === 0
        || typeof record.serviceId !== 'string' || record.serviceId.trim().length === 0
        || typeof record.mountPath !== 'string' || record.mountPath.trim().length === 0) {
        return { error: 'The Railway database volume target marker is incomplete.' };
      }
      const target: RailwayVolumeTarget = {
        projectId: record.projectId,
        environmentId: record.environmentId,
        serviceId: record.serviceId,
        mountPath: record.mountPath,
      };
      const boundEnvironmentId = environment
        ? (environment.platformBindings as Record<string, unknown>).environmentId
        : undefined;
      if (target.projectId !== scopedProjectId
        || target.serviceId !== component.externalId
        || target.mountPath !== expectedMountPath
        || (typeof boundEnvironmentId === 'string' && target.environmentId !== boundEnvironmentId)) {
        return {
          error: 'The Railway database volume target marker does not match the durable project, environment, service, and mount identities.',
        };
      }
      return { target };
    }

    if (!volumeId) return {};
    const environmentId = environment
      ? (environment.platformBindings as Record<string, unknown>).environmentId
      : undefined;
    if (typeof environmentId !== 'string' || environmentId.trim().length === 0
      || !component.externalId) {
      return {
        error: 'The legacy Railway database volume binding cannot be scoped to an exact environment and service; re-import or repair the volume target before deletion.',
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
  };

  const assertCurrentProjectScope = (
    environment: Environment,
    component: Component
  ): string => {
    const scopedProjectId = componentProjectId(component);
    const currentProjectId = environmentProjectId(environment);
    if (!scopedProjectId || !currentProjectId || scopedProjectId !== currentProjectId) {
      throw new Error(
        `Railway database binding ${component.externalId ?? component.id} has a missing or mismatched durable project scope; `
        + 're-import or re-plan the database against the current environment binding.'
      );
    }
    return currentProjectId;
  };

  const resolveRetainedDatabaseIdentity = async (
    component: Component
  ): Promise<{
    kind: 'service' | 'legacy-plugin';
    database: ObservedDatabase;
  } | null> => {
    const retainedProjectId = componentProjectId(component);
    if (!component.externalId || !retainedProjectId) {
      throw new Error('Railway retained database observation requires an exact database id and durable project scope.');
    }
    if (typeof railway.getProjectDetails !== 'function') {
      throw new Error('Railway hosting adapter does not expose retained database observation.');
    }
    const details = await railway.getProjectDetails(retainedProjectId);
    if (!details) return null;
    const services = details.services.edges
      .map((edge) => edge.node)
      .filter((node) => node.id === component.externalId);
    const plugins = details.plugins.edges
      .map((edge) => edge.node)
      .filter((node) => node.id === component.externalId);
    if (services.length + plugins.length > 1) {
      throw new Error(`Railway returned multiple resource identities for retained database id ${component.externalId}.`);
    }
    const service = services[0];
    const plugin = plugins[0];
    if (!service && !plugin) return null;

    const postgresImage = service?.serviceInstances?.edges?.some((edge) => {
      const image = edge.node?.source?.image?.trim().toLowerCase();
      return Boolean(image && /(^|\/)postgres(?::|@|$)/.test(image));
    }) ?? false;
    if (service && !postgresImage) {
      throw new Error(`Railway service ${service.id} is not provider-verified as a PostgreSQL database image.`);
    }
    if (plugin && !plugin.name.toLowerCase().includes('postgres')) {
      throw new Error(`Railway resource ${plugin.id} is not a PostgreSQL database.`);
    }
    const candidate = service ?? plugin!;
    return {
      kind: service ? 'service' : 'legacy-plugin',
      database: {
        provider: 'railway',
        engine: 'postgres',
        externalId: candidate.id,
        providerScope: { projectId: retainedProjectId },
        name: candidate.name,
        status: 'unknown',
      },
    };
  };

  const observeRailwayDatabase = async (
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> => {
    const retainedCleanup = component?.bindings.retainedCleanup === true;
    if (retainedCleanup) {
      if (!component) throw new Error('Railway retained database observation requires a component identity.');
      return (await resolveRetainedDatabaseIdentity(component))?.database ?? null;
    }
    const currentProjectId = component
      ? assertCurrentProjectScope(environment, component)
      : environmentProjectId(environment);
    if (typeof railway.observe !== 'function') {
      throw new Error('Railway hosting adapter does not expose database observation.');
    }
    const observed = await railway.observe(environment);
    if (observed.completeness?.databases !== 'complete') {
      throw new Error(
        `Railway database observation is unknown: ${observed.warnings.join('; ') || 'provider returned incomplete state'}`
      );
    }
    const postgres = observed.databases.filter((database) => database.engine === 'postgres');
    if (component?.externalId) {
      const matches = postgres.filter((database) => database.externalId === component.externalId);
      if (matches.length > 1) {
        throw new Error(`Multiple Railway PostgreSQL databases match durable id ${component.externalId}`);
      }
      const match = matches[0];
      if (match && match.providerScope?.projectId !== currentProjectId) {
        throw new Error(
          `Railway database ${component.externalId} was observed outside the current environment project scope.`
        );
      }
      return match ?? null;
    }
    const expectedName = options?.resourceName?.trim().toLowerCase();
    const named = expectedName
      ? postgres.filter((database) => database.name?.trim().toLowerCase() === expectedName)
      : postgres;
    const candidates = named.length > 0 ? named : postgres;
    if (candidates.length > 1) {
      throw new Error(
        `Multiple Railway PostgreSQL databases are visible: ${candidates.map((database) => database.externalId).join(', ')}`
      );
    }
    return candidates[0] ?? null;
  };

  return {
    name: 'railway',
    capabilities: {
      supportedDatabases: ['postgres'],
      supportsPooling: false,
      supportsReadReplicas: false,
      supportsPointInTimeRecovery: false,
      serverlessOptimized: false,
      supportsTemporaryDatabaseAccess: true,
    },
    async connect() {
      // Already connected via factory; no-op for compatibility.
    },
    async verify() {
      if (typeof hostingAdapter.verify === 'function') {
        return hostingAdapter.verify();
      }
      return { success: true };
    },
    async provision(type, environment, options): Promise<ProvisionResult> {
      if (type !== 'postgres') {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: `Railway database adapter supports only postgres (requested: ${type})`,
          },
        };
      }

      // Project creation is a separate reviewed plan action. A database action
      // may only provision inside the exact Railway project already bound to
      // this environment.
      const projectName = project?.name ?? `project-${environment.projectId}`;
      const refreshedEnvironment = envRepo.findById(environment.id) ?? environment;
      const projectId = environmentProjectId(refreshedEnvironment);
      if (!projectId) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: 'Railway project binding is missing',
            error: 'Apply the reviewed project action first, then re-run hv_plan. Database provisioning will not create or rebind a hosting project implicitly.',
            data: {
              phase: 'requireProjectBinding',
              provider: 'railway',
              requestedProjectName: projectName,
            },
          },
        };
      }

      let existingDatabase;
      try {
        existingDatabase = await observeRailwayDatabase(refreshedEnvironment, null, options);
      } catch (error) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: 'Failed to observe Railway databases before provisioning',
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (existingDatabase) {
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: `Railway PostgreSQL database ${existingDatabase.externalId} already exists`,
            error: 'Hypervibe will not silently adopt or replace it; use hv_import for that exact provider identity.',
          },
        };
      }
      const componentResult = await railway.ensureComponent(type, refreshedEnvironment);

      if (!componentResult.receipt.success) {
        componentResult.receipt.data = {
          ...(componentResult.receipt.data ?? {}),
          phase: 'ensureComponent',
          provider: 'railway',
          providerProjectId: projectId,
          requestedProjectName: projectName,
          ensureProjectCreated: false,
          authRecoveryRetried: false,
        };
        return {
          component: componentResult.component,
          receipt: componentResult.receipt,
        };
      }

      const componentBindings = componentResult.component.bindings as Record<string, unknown>;
      const resourceKind = componentBindings?.resourceKind;
      let pluginName: string = componentBindings?.pluginName as string || type;
      if (resourceKind !== 'service' && projectId && typeof railway.listPlugins === 'function') {
        const plugins = await railway.listPlugins(projectId);
        const matched =
          plugins.find((p) => p.id === componentResult.component.externalId) ||
          [...plugins].reverse().find((p) => p.type === type);
        if (matched?.name) {
          pluginName = matched.name;
        }
      }

      const envVars = makePluginVarRefs(pluginName, type);
      const connectionUrl = envVars.DATABASE_URL;

      return {
        component: {
          ...componentResult.component,
          bindings: {
            ...(componentResult.component.bindings ?? {}),
            provider: 'railway',
            projectId,
            providerScope: { projectId },
            connectionUrl,
            pluginName,
            resourceKind,
          },
        },
        receipt: {
          ...componentResult.receipt,
          data: {
            ...(componentResult.receipt.data ?? {}),
            phase: 'completed',
            provider: 'railway',
            providerProjectId: projectId,
            requestedProjectName: projectName,
            ensureProjectCreated: false,
            authRecoveryRetried: false,
          },
        },
        connectionUrl,
        envVars,
      };
    },
    async getConnectionUrl(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const value = bindings.connectionUrl;
      return typeof value === 'string' ? value : null;
    },
    async observeDatabase(environment, component, options) {
      const retainedCleanup = component?.bindings.retainedCleanup === true;
      const currentEnvironment = retainedCleanup
        ? environment
        : envRepo.findById(environment.id) ?? environment;
      return observeRailwayDatabase(currentEnvironment, component, options);
    },
    async acquireTemporaryDatabaseAccess(environment, component, applicationPort) {
      if (typeof railway.acquireTemporaryDatabaseAccess !== 'function') {
        throw new Error('Railway does not expose temporary database access.');
      }
      return railway.acquireTemporaryDatabaseAccess(environment, component, applicationPort);
    },
    async releaseTemporaryDatabaseAccess(environment, component, access) {
      if (typeof railway.releaseTemporaryDatabaseAccess !== 'function') {
        throw new Error('Railway does not expose temporary database access cleanup.');
      }
      await railway.releaseTemporaryDatabaseAccess(environment, component, access);
    },
    async destroy(component) {
      const bindings = component.bindings as Record<string, unknown>;
      const resourceKind = bindings.resourceKind;
      const recordedVolumeId = typeof bindings.volumeId === 'string' && bindings.volumeId.trim().length > 0
        ? bindings.volumeId
        : undefined;
      const retainedCleanup = bindings.retainedCleanup === true;
      const scopedProjectId = componentProjectId(component);
      let currentEnvironment: Environment | undefined;
      if (!retainedCleanup) {
        currentEnvironment = envRepo.findById(component.environmentId) ?? undefined;
        try {
          if (!currentEnvironment) {
            throw new Error(`environment ${component.environmentId} is not tracked locally`);
          }
          assertCurrentProjectScope(currentEnvironment, component);
        } catch (error) {
          return {
            success: false,
            message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } else if (!scopedProjectId) {
        return {
          success: false,
          message: `Refusing to destroy retained Railway database component ${component.externalId ?? component.id}`,
          error: 'The retained database binding is missing its durable project scope.',
        };
      }
      let verifiedResourceKind = resourceKind;
      if (retainedCleanup) {
        let retainedIdentity;
        try {
          retainedIdentity = await resolveRetainedDatabaseIdentity(component);
        } catch (error) {
          return {
            success: false,
            message: `Refusing to destroy retained Railway database component ${component.externalId ?? component.id}`,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (!retainedIdentity) {
          return {
            success: true,
            message: `Railway database service is already absent: ${component.externalId}`,
          };
        }
        if (retainedIdentity.kind !== 'service') {
          return {
            success: false,
            message: `Refusing to destroy retained Railway database component ${component.externalId ?? component.id}`,
            error: 'The exact retained Railway id is a legacy plugin, not a service-backed datastore. Hypervibe will not send it to the service deletion API.',
          };
        }
        verifiedResourceKind = 'service';
      }
      if (verifiedResourceKind !== 'service') {
        return {
          success: false,
          message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
          error: resourceKind === 'plugin' || resourceKind === 'legacy-plugin'
            ? 'Legacy Railway plugin databases do not have a verified teardown contract. Migrate or clean up the exact plugin explicitly; Hypervibe will not send its id to the service deletion API.'
            : 'The Railway database binding does not prove that this id is a service-backed datastore. Re-observe or explicitly import the exact service before deletion.',
        };
      }
      if (bindings.volumeId !== undefined && !recordedVolumeId) {
        return {
          success: false,
          message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
          error: 'The Railway database volume id binding is malformed.',
        };
      }
      if (!scopedProjectId) {
        return {
          success: false,
          message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
          error: 'The Railway database binding is missing its durable project scope.',
        };
      }
      const volumeTargetResult = resolveVolumeTarget(
        component,
        currentEnvironment,
        scopedProjectId,
        recordedVolumeId
      );
      if (volumeTargetResult.error) {
        return {
          success: false,
          message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
          error: volumeTargetResult.error,
        };
      }
      let volumeId = recordedVolumeId;
      const volumeTarget = volumeTargetResult.target;
      if (volumeTarget) {
        if (typeof railway.resolveServiceVolume !== 'function') {
          return {
            success: false,
            message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
            error: 'Railway volume observation is unavailable, so the persistent-volume identity is unknown.',
          };
        }
        const resolved = await railway.resolveServiceVolume(volumeTarget, recordedVolumeId);
        if (!resolved.success) {
          return {
            success: false,
            message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
            error: `Railway volume identity is unknown: ${resolved.error}`,
          };
        }
        volumeId = resolved.state === 'present' ? resolved.volumeId : undefined;
      }
      if (volumeId && (!volumeTarget || typeof railway.deleteVolume !== 'function')) {
        return {
          success: false,
          message: `Refusing to destroy Railway database component ${component.externalId ?? component.id}`,
          error: `Railway volume ${volumeId} cannot be safely deleted because scoped volume cleanup is unavailable.`,
        };
      }
      if (component.externalId && typeof railway.deleteService === 'function') {
        const deletedService = await railway.deleteService(component.externalId);
        if (!deletedService.success) {
          return {
            success: false,
            message: `Failed to delete Railway database service ${component.externalId}; persistent volume was preserved`,
            error: `service ${component.externalId}: ${deletedService.error ?? 'unknown error'}`,
          };
        }
        if (volumeId && volumeTarget && typeof railway.deleteVolume === 'function') {
          const deletedVolume = await railway.deleteVolume(volumeId, volumeTarget);
          if (!deletedVolume.success) {
            return {
              success: false,
              message: `Deleted Railway database service ${component.externalId}, but failed to delete its volume`,
              error: `volume ${volumeId}: ${deletedVolume.error ?? 'unknown error'}`,
            };
          }
        }
        return {
          success: true,
          message: deletedService.alreadyAbsent
            ? `Railway database service is already absent: ${component.externalId}${volumeId ? `; deleted volume ${volumeId}` : ''}`
            : `Deleted Railway service ${component.externalId}${volumeId ? ` and volume ${volumeId}` : ''}`,
        };
      }
      return {
        success: false,
        message: `Destroy is not implemented for Railway component ${component.externalId ?? component.id}${resourceKind ? ` (kind: ${String(resourceKind)})` : ''}`,
      };
    },
  };
}
