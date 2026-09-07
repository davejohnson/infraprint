import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import type { RailwayAdapter, RailwayProjectDetails } from './railway.adapter.js';

export interface ImportCandidate {
  name: string;
  railwayId: string;
  environmentCount: number;
  serviceCount: number;
}

export interface ImportServiceSummary {
  name: string;
  railwayId: string;
  repo: string | null;
  branch: string | null;
  hasGitHubDeploy: boolean;
  datastoreEngine?: 'postgres' | 'redis';
  instancesByEnv: Record<string, {
    domains: string[];
    customDomains: string[];
    startCommand?: string;
    releaseCommand?: string;
    healthcheckPath?: string;
    cronSchedule?: string;
    numReplicas?: number;
    sleepApplication?: boolean;
    sourceImage?: string;
  }>;
}

export interface ImportComponentSummary {
  type: ComponentType;
  railwayId: string;
  name: string;
}

export interface RailwayProjectInspection {
  details: RailwayProjectDetails;
  environments: Array<{ name: string; railwayId: string }>;
  services: ImportServiceSummary[];
  components: ImportComponentSummary[];
  storage: Array<{ name: string; railwayId: string; environments: Array<{ name: string; region?: string }> }>;
  envVarNames: string[];
  autoDetected: Record<string, string>;
  needsMapping: string[];
}

function mapPluginToComponentType(pluginName: string): ComponentType {
  const normalized = pluginName.toLowerCase();
  if (normalized.includes('postgres')) return 'postgres';
  if (normalized.includes('redis') || normalized.includes('valkey')) return 'redis';
  return pluginName;
}

function classifyRailwayDatastoreEngine(name: string): 'postgres' | 'redis' | undefined {
  const normalized = name.toLowerCase();
  if (normalized.includes('postgres')) return 'postgres';
  if (normalized.includes('redis') || normalized.includes('valkey')) return 'redis';
  return undefined;
}

function normalizeRailwayPreDeployCommand(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const commands = value.filter(
    (command): command is string => typeof command === 'string' && command.trim().length > 0
  );
  return commands.length > 0 ? commands.join(' && ') : undefined;
}

async function railwayImportCandidatePage(
  adapter: RailwayAdapter,
  limit: number
): Promise<{ projects: ImportCandidate[]; truncated: boolean }> {
  const allProjects = await adapter.listProjects();
  const projects = await Promise.all(allProjects.slice(0, limit).map(async (project) => {
    const details = await adapter.getProjectDetails(project.id);
    return {
      name: project.name,
      railwayId: project.id,
      environmentCount: details?.environments.edges.length ?? 0,
      serviceCount: details?.services.edges.length ?? 0,
    };
  }));
  return { projects, truncated: allProjects.length > limit };
}

export async function inspectRailwayProject(
  adapter: RailwayAdapter,
  railwayProjectId: string,
  options: { includeEnvVarNames?: boolean } = {}
): Promise<RailwayProjectInspection | null> {
  const details = await adapter.getProjectDetails(railwayProjectId);
  if (!details) return null;

  const environments = details.environments.edges.map((environment) => ({
    name: environment.node.name,
    railwayId: environment.node.id,
  }));
  const services: ImportServiceSummary[] = details.services.edges.map((serviceEdge) => {
    const instancesByEnv: ImportServiceSummary['instancesByEnv'] = {};
    for (const instanceEdge of serviceEdge.node.serviceInstances?.edges ?? []) {
      const instance = instanceEdge.node;
      instancesByEnv[instance.environmentId] = {
        domains: instance.domains?.serviceDomains?.map((domain) => domain.domain) ?? [],
        customDomains: instance.domains?.customDomains?.map((domain) => domain.domain) ?? [],
        startCommand: instance.startCommand,
        releaseCommand: normalizeRailwayPreDeployCommand(instance.preDeployCommand),
        healthcheckPath: instance.healthcheckPath,
        cronSchedule: instance.cronSchedule,
        numReplicas: instance.numReplicas,
        sleepApplication: instance.sleepApplication,
        ...(instance.source?.image ? { sourceImage: instance.source.image } : {}),
      };
    }
    const sourceImages = Object.values(instancesByEnv)
      .map((instance) => instance.sourceImage)
      .filter((image): image is string => Boolean(image));
    const datastoreEngine = classifyRailwayDatastoreEngine([
      serviceEdge.node.name,
      ...sourceImages,
    ].join(' '));
    return {
      name: serviceEdge.node.name,
      railwayId: serviceEdge.node.id,
      repo: serviceEdge.node.repoTriggers.edges[0]?.node.repository ?? null,
      branch: serviceEdge.node.repoTriggers.edges[0]?.node.branch ?? null,
      hasGitHubDeploy: serviceEdge.node.repoTriggers.edges.length > 0,
      ...(datastoreEngine ? { datastoreEngine } : {}),
      instancesByEnv,
    };
  });
  const components: ImportComponentSummary[] = details.plugins.edges.map((plugin) => ({
    type: mapPluginToComponentType(plugin.node.name),
    railwayId: plugin.node.id,
    name: plugin.node.name,
  }));
  const storage = (details.buckets?.edges ?? []).map((bucket) => ({
    name: bucket.node.name,
    railwayId: bucket.node.id,
    environments: details.environments.edges.flatMap((environment) => {
      const instance = environment.node.config?.buckets?.[bucket.node.id];
      return instance && instance.isDeleted !== true
        ? [{ name: environment.node.name, region: instance.region }]
        : [];
    }),
  }));

  let envVarNames: string[] = [];
  if (options.includeEnvVarNames !== false && environments[0] && services[0]) {
    const variables = await adapter.getServiceVariables(
      details.id,
      services[0].railwayId,
      environments[0].railwayId
    );
    envVarNames = Object.keys(variables);
  }

  const autoDetected: Record<string, string> = {};
  const needsMapping: string[] = [];
  for (const environment of environments) {
    const normalized = environment.name.toLowerCase();
    if (['production', 'staging', 'development'].includes(normalized)) {
      autoDetected[environment.name] = normalized;
    } else {
      needsMapping.push(environment.name);
    }
  }

  return { details, environments, services, components, storage, envVarNames, autoDetected, needsMapping };
}

export async function inspectRailwayResources(
  adapter: RailwayAdapter,
  request: ProviderInspectionRequest
): Promise<Record<string, unknown>> {
  if (request.resource && !['project', 'environment', 'database', 'cache', 'storage'].includes(request.resource)) {
    throw new Error(`Unsupported Railway inspection resource "${request.resource}". Use project, environment, database, cache, or storage.`);
  }
  if (
    request.resource
    && ['database', 'cache', 'storage'].includes(request.resource)
    && !request.environment
  ) {
    const resource = request.resource as 'database' | 'cache' | 'storage';
    const projects = await adapter.listProjects();
    const resources: Array<Record<string, unknown>> = [];
    for (const project of projects) {
      const inspection = await inspectRailwayProject(adapter, project.id, { includeEnvVarNames: false });
      if (!inspection) continue;
      if (resource === 'storage') {
        for (const bucket of inspection.storage) {
          if (request.id && bucket.railwayId !== request.id) continue;
          if (request.name && bucket.name.toLowerCase() !== request.name.toLowerCase()) continue;
          resources.push({
            id: bucket.railwayId,
            name: bucket.name,
            kind: 'object',
            status: 'unknown',
            environments: bucket.environments,
            project: { id: project.id, name: project.name },
            providerScope: { projectId: project.id },
          });
        }
      } else {
        const expectedEngine = resource === 'database' ? 'postgres' : 'redis';
        for (const service of inspection.services) {
          if (service.datastoreEngine !== expectedEngine) continue;
          if (request.id && service.railwayId !== request.id) continue;
          if (request.name && service.name.toLowerCase() !== request.name.toLowerCase()) continue;
          const environmentIds = Object.keys(service.instancesByEnv);
          if (resource === 'cache') {
            for (const environmentId of environmentIds) {
              resources.push({
                id: service.railwayId,
                name: service.name,
                engine: expectedEngine,
                status: 'unknown',
                resourceKind: 'service',
                project: { id: project.id, name: project.name },
                providerScope: { projectId: project.id, environmentId },
              });
            }
          } else {
            resources.push({
              id: service.railwayId,
              name: service.name,
              engine: expectedEngine,
              status: 'unknown',
              resourceKind: 'service',
              project: { id: project.id, name: project.name },
              providerScope: { projectId: project.id },
            });
          }
        }
        for (const component of inspection.components) {
          if (component.type !== expectedEngine) continue;
          // Legacy Redis plugins have no exact environment-scoped lifecycle or
          // supported teardown port. They are not cache-lifecycle candidates.
          if (resource === 'cache') continue;
          if (request.id && component.railwayId !== request.id) continue;
          if (request.name && component.name.toLowerCase() !== request.name.toLowerCase()) continue;
          resources.push({
            id: component.railwayId,
            name: component.name,
            engine: expectedEngine,
            status: 'unknown',
            resourceKind: 'legacy-plugin',
            cleanupSupported: false,
            project: { id: project.id, name: project.name },
            providerScope: { projectId: project.id },
          });
        }
      }
    }
    const ambiguous = Boolean(request.name && resources.length > 1);
    const collection = resource === 'database' ? 'databases' : resource === 'cache' ? 'caches' : 'storage';
    return {
      observation: ambiguous ? 'ambiguous' : resources.length > 0 ? 'present' : 'absent',
      resource,
      [collection]: resources.slice(0, request.limit),
      ...(resources.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: resources.length > request.limit,
      partial: false,
    };
  }
  const bindingProjectId = typeof request.binding?.projectId === 'string'
    ? request.binding.projectId
    : undefined;
  const selectedId = request.id ?? bindingProjectId;
  const selectedName = request.name ?? request.project?.name;
  if (!selectedId && !selectedName) {
    const page = await railwayImportCandidatePage(adapter, request.limit);
    return {
      observation: page.projects.length > 0 ? 'present' : 'absent',
      resource: 'project',
      projects: page.projects.map((project) => ({
        ...project,
        id: project.railwayId,
      })),
      truncated: page.truncated,
      partial: page.truncated,
    };
  }

  let projectId = selectedId;
  let matches: Array<{ id: string; name: string }> = [];
  if (!projectId) {
    matches = await adapter.findProjectsByName(selectedName!);
    if (matches.length === 0) {
      return {
        observation: 'absent',
        resource: request.resource ?? 'project',
        name: selectedName,
        projects: [],
        truncated: false,
        partial: false,
      };
    }
    if (matches.length > 1) {
      const truncated = matches.length > request.limit;
      return {
        observation: 'ambiguous',
        resource: request.resource ?? 'project',
        name: selectedName,
        projects: matches.slice(0, request.limit).map((project) => ({ id: project.id, name: project.name })),
        truncated,
        partial: truncated,
      };
    }
    projectId = matches[0].id;
  }

  const inspection = await inspectRailwayProject(adapter, projectId);
  if (!inspection) {
    return {
      observation: 'absent',
      resource: request.resource ?? 'project',
      id: projectId,
      projects: [],
      truncated: false,
      partial: false,
    };
  }
  if (request.resource === 'environment') {
    const boundEnvironmentId = typeof request.binding?.environmentId === 'string'
      ? request.binding.environmentId
      : undefined;
    const candidates = inspection.environments.filter((environment) => (
      boundEnvironmentId
        ? environment.railwayId === boundEnvironmentId
        : environment.name === request.environment?.name
    ));
    if (candidates.length === 0) {
      return {
        observation: 'absent',
        resource: 'environment',
        project: { id: inspection.details.id, name: inspection.details.name },
        name: request.environment?.name,
      };
    }
    if (candidates.length > 1) {
      const truncated = candidates.length > request.limit;
      return {
        observation: 'ambiguous',
        resource: 'environment',
        project: { id: inspection.details.id, name: inspection.details.name },
        environments: candidates
          .slice(0, request.limit)
          .map((environment) => ({ id: environment.railwayId, name: environment.name })),
        truncated,
        partial: truncated,
      };
    }
    const selectedEnvironment = candidates[0]!;
    const services = inspection.services.filter((service) => (
      Boolean(service.instancesByEnv[selectedEnvironment.railwayId])
    ));
    const storage = inspection.storage.filter((bucket) => (
      bucket.environments.some((environment) => environment.name === selectedEnvironment.name)
    ));
    const truncated = services.length > request.limit
      || inspection.components.length > request.limit
      || storage.length > request.limit;
    return {
      observation: 'present',
      resource: 'environment',
      project: { id: inspection.details.id, name: inspection.details.name },
      environment: { id: selectedEnvironment.railwayId, name: selectedEnvironment.name },
      services: services
        .slice(0, request.limit)
        .map((service) => ({
          id: service.railwayId,
          name: service.name,
          instance: service.instancesByEnv[selectedEnvironment.railwayId],
          datastoreEngine: service.datastoreEngine,
        })),
      components: inspection.components
        .slice(0, request.limit)
        .map((component) => ({ id: component.railwayId, name: component.name, type: component.type })),
      storage: storage
        .slice(0, request.limit)
        .map((bucket) => ({ id: bucket.railwayId, name: bucket.name })),
      truncated,
      partial: truncated,
    };
  }
  const environments = inspection.environments.slice(0, request.limit);
  const returnedEnvironmentNames = new Set(environments.map((environment) => environment.name));
  const returnedEnvironmentIds = new Set(environments.map((environment) => environment.railwayId));
  const truncated = inspection.environments.length > request.limit
    || inspection.services.length > request.limit
    || inspection.components.length > request.limit
    || inspection.storage.length > request.limit
    || inspection.envVarNames.length > request.limit;
  return {
    observation: 'present',
    resource: 'project',
    project: { id: inspection.details.id, name: inspection.details.name },
    projects: [{ id: inspection.details.id, name: inspection.details.name }],
    environments: environments.map((environment) => ({ id: environment.railwayId, name: environment.name })),
    services: inspection.services.slice(0, request.limit).map((service) => ({
      id: service.railwayId,
      name: service.name,
      repo: service.repo,
      branch: service.branch,
      hasGitHubDeploy: service.hasGitHubDeploy,
      datastoreEngine: service.datastoreEngine,
      instancesByEnvironmentId: Object.fromEntries(
        Object.entries(service.instancesByEnv).filter(([environmentId]) => returnedEnvironmentIds.has(environmentId))
      ),
    })),
    components: inspection.components
      .slice(0, request.limit)
      .map((component) => ({ id: component.railwayId, name: component.name, type: component.type })),
    storage: inspection.storage
      .slice(0, request.limit)
      .map((bucket) => ({
        id: bucket.railwayId,
        name: bucket.name,
        environments: bucket.environments.filter((environment) => returnedEnvironmentNames.has(environment.name)),
      })),
    envVarNames: inspection.envVarNames.slice(0, request.limit),
    autoDetected: Object.fromEntries(
      Object.entries(inspection.autoDetected).filter(([name]) => returnedEnvironmentNames.has(name))
    ),
    needsMapping: inspection.needsMapping.filter((name) => returnedEnvironmentNames.has(name)),
    truncated,
    partial: truncated,
  };
}
