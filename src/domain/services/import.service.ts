import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import type { RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { RailwayCredentials } from '../entities/connection.entity.js';
import type { HostingBindings } from '../ports/hosting.port.js';
import { parseStorageCreateRecoveryMap } from '../ports/storage.port.js';
import { projectSpecSchema, type ProjectSpec, type ServiceSpec } from '../spec/spec.schema.js';
import { SpecStore } from '../spec/spec.store.js';
import { detectGitRemoteUrl } from '../../lib/git-remote.js';
import {
  type ImportComponentSummary,
  type ImportServiceSummary,
} from '../../adapters/providers/railway/railway-inspection.driver.js';

export { inspectRailwayProject } from '../../adapters/providers/railway/railway-inspection.driver.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export type ImportResult =
  | { status: 'already_exists' }
  | {
    status: 'imported';
    project: { id: string; name: string };
    environments: Array<{ name: string; id: string; railwayId: string }>;
    services: Array<{ name: string; id: string; railwayId: string }>;
    components: Array<{ type: string; environmentId: string; railwayId: string }>;
    spec: ProjectSpec;
    specRevision: number;
  };

export interface ImportRailwayProjectOptions {
  force?: boolean;
  storageMappings?: Record<string, string>;
  /** Explicit service-backed datastore adoption: Railway service id -> engine. */
  databaseMappings?: Record<string, 'postgres'>;
  /** Explicit service-backed cache adoption: Railway service id -> engine. */
  cacheMappings?: Record<string, 'redis'>;
}

/**
 * Validate an explicit Railway bucket adoption against every retained
 * storage-create marker before import writes local state. A marker is a
 * blocker/recovery hint, never sufficient identity or deletion authority.
 */
export function validateRailwayStorageCreateRecoveryResolution(
  details: RailwayProjectDetails,
  environmentMappings: Record<string, string>,
  options: ImportRailwayProjectOptions = {}
): Record<string, string[]> {
  const existingProject = projectRepo.findByName(details.name);
  if (!existingProject) return {};
  const resolvedByEnvironment: Record<string, string[]> = {};

  for (const [railwayEnvironmentName, environmentName] of Object.entries(environmentMappings)) {
    const existingEnvironment = envRepo.findByProjectAndName(existingProject.id, environmentName);
    if (!existingEnvironment) continue;
    const rawRecoveries = existingEnvironment.platformBindings.storageCreateRecovery;
    if (rawRecoveries === undefined) continue;
    const recoveries = parseStorageCreateRecoveryMap(rawRecoveries);
    if (!recoveries) {
      throw new Error(
        `Environment "${environmentName}" has malformed storage create-recovery state. Repair it before importing Railway storage.`
      );
    }
    const railwayEnvironment = details.environments.edges.find(
      (edge) => edge.node.name === railwayEnvironmentName
    )?.node;
    if (!railwayEnvironment) {
      throw new Error(`Railway environment "${railwayEnvironmentName}" was not found while resolving storage recovery state.`);
    }

    for (const [resourceName, recovery] of Object.entries(recoveries)) {
      const mappedBuckets = Object.entries(options.storageMappings ?? {})
        .filter(([, desiredName]) => desiredName === resourceName);
      if (mappedBuckets.length !== 1) {
        throw new Error(
          `Storage "${resourceName}" has retained create-recovery state. Map exactly one inspected Railway bucket id to "${resourceName}" with storageMappings.`
        );
      }
      const [bucketId] = mappedBuckets[0]!;
      const bucket = details.buckets?.edges.find((edge) => edge.node.id === bucketId)?.node;
      const instance = railwayEnvironment.config?.buckets?.[bucketId];
      const exactScope = recovery.provider === 'railway'
        && Object.keys(recovery.providerScope).length === 2
        && recovery.providerScope.projectId === details.id
        && recovery.providerScope.environmentId === railwayEnvironment.id;
      const exactIdentity = recovery.state === 'unresolved'
        ? bucket?.name === resourceName
        : recovery.externalId === bucketId
          && (recovery.state === 'identified'
            ? bucket?.name === resourceName
            : recovery.returnedName === undefined || bucket?.name === recovery.returnedName);
      if (!bucket || !instance || instance.isDeleted === true || !instance.region
        || !exactScope || !exactIdentity) {
        throw new Error(
          `storageMappings does not exactly resolve retained storage create state for "${resourceName}" in Railway project ${details.id}, environment ${railwayEnvironment.id}.`
        );
      }
      (resolvedByEnvironment[railwayEnvironment.id] ??= []).push(resourceName);
    }
  }
  return resolvedByEnvironment;
}

function importedGitRemoteUrl(services: ImportServiceSummary[]): string | undefined {
  const repo = services.find((service) => service.repo)?.repo;
  return repo ? `https://github.com/${repo}` : detectGitRemoteUrl() ?? undefined;
}

function importedServiceSpec(
  instance: ImportServiceSummary['instancesByEnv'][string]
): ServiceSpec {
  const cronSchedule = instance.cronSchedule?.trim() || undefined;
  const isPublic = instance.domains.length > 0 || instance.customDomains.length > 0;
  return {
    workloadKind: cronSchedule ? 'cron' : isPublic ? 'web' : 'worker',
    ...(instance.startCommand ? { startCommand: instance.startCommand } : {}),
    ...(instance.releaseCommand ? { releaseCommand: instance.releaseCommand } : {}),
    ...(instance.healthcheckPath ? { healthCheckPath: instance.healthcheckPath } : {}),
    ...(cronSchedule ? { cronSchedule } : {}),
    public: isPublic,
  };
}

/**
 * Freeze the imported provider shape into desired state before any local
 * records are written. Explicitly mapped resources become managed; unmapped
 * datastore candidates remain provider-side unmanaged resources.
 */
export function buildImportedRailwaySpec(
  details: RailwayProjectDetails,
  environmentMappings: Record<string, string>,
  services: ImportServiceSummary[],
  components: ImportComponentSummary[],
  options: ImportRailwayProjectOptions = {}
): ProjectSpec {
  if (components.length > 0) {
    throw new Error(
      'Railway legacy plugin datastore adoption is unsupported because Hypervibe cannot verify exact plugin teardown. Migrate it to a service-backed datastore before import.'
    );
  }
  const datastoreServiceIds = new Set([
    ...services
      .filter((service) => service.datastoreEngine !== undefined)
      .map((service) => service.railwayId),
    ...Object.keys(options.databaseMappings ?? {}),
    ...Object.keys(options.cacheMappings ?? {}),
  ]);
  const environments: Record<string, unknown> = {};

  for (const [railwayEnvironmentName, environmentName] of Object.entries(environmentMappings)) {
    const railwayEnvironment = details.environments.edges.find(
      (edge) => edge.node.name === railwayEnvironmentName
    )?.node;
    if (!railwayEnvironment) {
      throw new Error(`Railway environment "${railwayEnvironmentName}" was not found during import.`);
    }

    const importedServices = Object.fromEntries(
      services.flatMap((service) => {
        if (datastoreServiceIds.has(service.railwayId)) return [];
        const instance = service.instancesByEnv[railwayEnvironment.id];
        return instance ? [[service.name, importedServiceSpec(instance)] as const] : [];
      })
    );
    const hasMappedDatabase = Object.keys(options.databaseMappings ?? {}).some((serviceId) =>
      Boolean(services.find((service) => service.railwayId === serviceId)?.instancesByEnv[railwayEnvironment.id])
    );
    const hasMappedCache = Object.keys(options.cacheMappings ?? {}).some((serviceId) =>
      Boolean(services.find((service) => service.railwayId === serviceId)?.instancesByEnv[railwayEnvironment.id])
    );
    const storage = Object.fromEntries(
      Object.entries(options.storageMappings ?? {}).flatMap(([bucketId, desiredName]) => {
        const bucket = details.buckets?.edges.find((edge) => edge.node.id === bucketId)?.node;
        const instance = railwayEnvironment.config?.buckets?.[bucketId];
        if (!bucket || !instance || instance.isDeleted === true || !instance.region) return [];
        return [[desiredName, {
          provider: 'railway',
          type: 'bucket',
          region: instance.region,
          injectInto: [],
        }] as const];
      })
    );

    environments[environmentName] = {
      hosting: { provider: 'railway' },
      services: importedServices,
      ...(hasMappedDatabase
        ? { database: { provider: 'railway', engine: 'postgres' as const } }
        : {}),
      ...(hasMappedCache
        ? { cache: { provider: 'railway', engine: 'redis' as const } }
        : {}),
      ...(Object.keys(storage).length > 0 ? { storage } : {}),
      email: { enabled: false },
      envVars: {},
    };
  }

  const gitRemoteUrl = importedGitRemoteUrl(services);
  return projectSpecSchema.parse({
    version: 1,
    project: details.name,
    ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    environments,
  });
}

/**
 * Open a connected RailwayAdapter using the stored global Railway connection.
 * Returns null when no Railway connection is configured. Callers own
 * disconnect().
 */
export async function connectRailwayForImport(): Promise<RailwayAdapter | null> {
  const connection = connectionRepo.findByProvider('railway');
  if (!connection) return null;

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
  const adapter = new RailwayAdapter();
  await adapter.connect(credentials);
  return adapter;
}

/**
 * Perform the actual import: create the local project, environments (with
 * Railway platform bindings), services, and components.
 */
export async function importRailwayProject(
  details: RailwayProjectDetails,
  environmentMappings: Record<string, string>,
  services: ImportServiceSummary[],
  components: ImportComponentSummary[],
  options: ImportRailwayProjectOptions = {}
): Promise<ImportResult> {
  const existingProject = projectRepo.findByName(details.name);
  if (existingProject && !options.force) {
    return { status: 'already_exists' };
  }

  // Validate and freeze the complete adopted desired state before the first
  // local write. A malformed mapping must not leave a partially imported
  // project that a later plan could mistake for mutation authority.
  const importedSpec = buildImportedRailwaySpec(
    details,
    environmentMappings,
    services,
    components,
    options
  );
  const resolvedStorageRecoveries = validateRailwayStorageCreateRecoveryResolution(
    details,
    environmentMappings,
    options
  );
  const gitRemoteUrl = importedSpec.gitRemoteUrl;

  const project = existingProject
    ? projectRepo.update(existingProject.id, {
      defaultPlatform: 'railway',
      gitRemoteUrl: gitRemoteUrl ?? existingProject.gitRemoteUrl,
      policies: existingProject.policies,
    }) ?? existingProject
    : projectRepo.create({
      name: details.name,
      defaultPlatform: 'railway',
      gitRemoteUrl,
    });

  // Create environments with Railway bindings
  const createdEnvironments: Array<{ name: string; id: string; railwayId: string }> = [];

  for (const [railwayEnvName, infraType] of Object.entries(environmentMappings)) {
    const railwayEnv = details.environments.edges.find((e) => e.node.name === railwayEnvName);
    if (!railwayEnv) continue;

    const existingEnv = envRepo.findByProjectAndName(project.id, infraType);
    const env = existingEnv
      ? envRepo.update(existingEnv.id, {
        platformBindings: {
          ...existingEnv.platformBindings,
          provider: 'railway',
          projectId: details.id,
          environmentId: railwayEnv.node.id,
          services: (existingEnv.platformBindings as { services?: Record<string, unknown> }).services ?? {},
        },
      }) ?? existingEnv
      : envRepo.create({
        projectId: project.id,
        name: infraType,
        platformBindings: {
          provider: 'railway',
          projectId: details.id,
          environmentId: railwayEnv.node.id,
          services: {},
        },
      });

    const adoptedStorage = Object.entries(options.storageMappings ?? {}).flatMap(([bucketId, desiredName]) => {
      const bucket = details.buckets?.edges.find((edge) => edge.node.id === bucketId)?.node;
      const instance = railwayEnv.node.config?.buckets?.[bucketId];
      if (!bucket || !instance || instance.isDeleted === true || !instance.region) return [];
      return [[desiredName, {
        provider: 'railway', externalId: bucket.id, region: instance.region,
        instanceScope: { projectId: details.id, environmentId: railwayEnv.node.id },
        services: [], envKeys: [], updatedAt: new Date().toISOString(),
      }] as const];
    });
    if (adoptedStorage.length > 0) {
      const latestEnvironment = envRepo.findById(env.id) ?? env;
      const existingStorage = asRecord(latestEnvironment.platformBindings.storage) ?? {};
      const existingStorageProviders = asRecord(latestEnvironment.platformBindings.storageProviders) ?? {};
      const parsedRecoveries = latestEnvironment.platformBindings.storageCreateRecovery === undefined
        ? {}
        : parseStorageCreateRecoveryMap(latestEnvironment.platformBindings.storageCreateRecovery);
      if (!parsedRecoveries) {
        throw new Error(
          `Environment "${infraType}" storage create-recovery state changed during import. No recovery marker was cleared.`
        );
      }
      const remainingRecoveries = { ...parsedRecoveries };
      for (const resourceName of resolvedStorageRecoveries[railwayEnv.node.id] ?? []) {
        delete remainingRecoveries[resourceName];
      }
      envRepo.updatePlatformBindings(env.id, {
        storageProviders: {
          ...existingStorageProviders,
          railway: { projectId: details.id, environmentId: railwayEnv.node.id },
        },
        storage: { ...existingStorage, ...Object.fromEntries(adoptedStorage) },
        storageCreateRecovery: Object.keys(remainingRecoveries).length > 0
          ? remainingRecoveries
          : undefined,
      });
    }

    createdEnvironments.push({
      name: infraType,
      id: env.id,
      railwayId: railwayEnv.node.id,
    });
  }

  // Create services
  const createdServices: Array<{ name: string; id: string; railwayId: string }> = [];

  const adoptedDatastoreServiceIds = new Set([
    ...services
      .filter((service) => service.datastoreEngine !== undefined)
      .map((service) => service.railwayId),
    ...Object.keys(options.databaseMappings ?? {}),
    ...Object.keys(options.cacheMappings ?? {}),
  ]);
  for (const svc of services) {
    if (adoptedDatastoreServiceIds.has(svc.railwayId)) continue;
    const firstInstance = Object.values(svc.instancesByEnv)[0];
    const buildConfig = {
      ...(svc.repo ? { builder: 'nixpacks' as const } : {}),
      ...(firstInstance
        ? {
          workloadKind: firstInstance.cronSchedule
            ? 'cron' as const
            : firstInstance.domains.length > 0 || firstInstance.customDomains.length > 0
              ? 'web' as const
              : 'worker' as const,
          public: firstInstance.domains.length > 0 || firstInstance.customDomains.length > 0,
        }
        : {}),
      ...(firstInstance?.startCommand ? { startCommand: firstInstance.startCommand } : {}),
      ...(firstInstance?.releaseCommand ? { releaseCommand: firstInstance.releaseCommand } : {}),
      ...(firstInstance?.healthcheckPath ? { healthCheckPath: firstInstance.healthcheckPath } : {}),
      ...(firstInstance?.cronSchedule ? { cronSchedule: firstInstance.cronSchedule } : {}),
    };
    const existingService = serviceRepo.findByProjectAndName(project.id, svc.name);
    const service = existingService
      ? serviceRepo.update(existingService.id, {
        buildConfig: { ...existingService.buildConfig, ...buildConfig },
        envVarSpec: existingService.envVarSpec,
      }) ?? existingService
      : serviceRepo.create({
        projectId: project.id,
        name: svc.name,
        buildConfig,
        envVarSpec: {},
      });

    createdServices.push({
      name: svc.name,
      id: service.id,
      railwayId: svc.railwayId,
    });

    // Update environment bindings with service info
    for (const env of createdEnvironments) {
      if (!svc.instancesByEnv[env.railwayId]) continue;
      const existingEnv = envRepo.findById(env.id);
      if (existingEnv) {
        const bindings = existingEnv.platformBindings as {
          provider?: string;
          projectId?: string;
          environmentId?: string;
          services?: HostingBindings['services'];
        };
        const instance = svc.instancesByEnv[env.railwayId];
        bindings.services = bindings.services || {};
        bindings.services[svc.name] = {
          serviceId: svc.railwayId,
          ...(instance.domains[0] ? { url: `https://${instance.domains[0]}` } : {}),
          ...(instance.customDomains.length > 0 ? { customDomains: instance.customDomains } : {}),
        };
        envRepo.update(env.id, { platformBindings: bindings });
      }
    }
  }

  // Create components for each environment
  const createdComponents: Array<{ type: string; environmentId: string; railwayId: string }> = [];

  // Current Railway databases and caches are ordinary services. Adoption must be
  // explicit because a name alone is not enough evidence that a service is a
  // datastore; mapped services are components, never application services.
  const serviceDatastoreMappings: Record<string, 'postgres' | 'redis'> = {
    ...(options.databaseMappings ?? {}),
    ...(options.cacheMappings ?? {}),
  };
  for (const [serviceId, type] of Object.entries(serviceDatastoreMappings)) {
    const service = services.find((candidate) => candidate.railwayId === serviceId);
    if (!service) continue;
    for (const env of createdEnvironments) {
      if (!service.instancesByEnv[env.railwayId]) continue;
      const bindings = {
        provider: 'railway',
        projectId: details.id,
        environmentId: env.railwayId,
        providerScope: {
          projectId: details.id,
          ...(type === 'redis' ? { environmentId: env.railwayId } : {}),
        },
        resourceKind: 'service',
        serviceId,
        pluginName: service.name,
        ...(type === 'redis'
          ? { connectionUrl: '${{' + service.name + '.REDIS_URL}}' }
          : {}),
      };
      const existing = componentRepo.findByEnvironmentAndType(env.id, type);
      if (existing) {
        componentRepo.update(existing.id, { type, externalId: serviceId, bindings });
      } else {
        componentRepo.create({ environmentId: env.id, type, externalId: serviceId, bindings });
      }
      const prior = createdComponents.findIndex((component) =>
        component.environmentId === env.id && component.type === type
      );
      const adopted = { type, environmentId: env.id, railwayId: serviceId };
      if (prior >= 0) createdComponents[prior] = adopted;
      else createdComponents.push(adopted);
    }
  }

  // Audit log
  auditRepo.create({
    action: existingProject ? 'project.reimported' : 'project.imported',
    resourceType: 'project',
    resourceId: project.id,
    details: {
      name: project.name,
      source: 'railway',
      providerProjectId: details.id,
      environmentCount: createdEnvironments.length,
      serviceCount: createdServices.length,
      componentCount: createdComponents.length,
    },
  });
  const storedSpec = new SpecStore().replace(project, importedSpec);

  return {
    status: 'imported',
    project: { id: project.id, name: project.name },
    environments: createdEnvironments,
    services: createdServices,
    components: createdComponents,
    spec: storedSpec.spec,
    specRevision: storedSpec.revision,
  };
}
