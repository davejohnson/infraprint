import type { ProviderImportDriver } from '../import-provider.js';
import { commandError, commandSuccess } from '../results.js';
import {
  buildImportedRailwaySpec,
  connectRailwayForImport,
  importRailwayProject,
  inspectRailwayProject,
  validateRailwayStorageCreateRecoveryResolution,
} from '../../domain/services/import.service.js';
import { connectionSetupOptions } from '../../domain/services/connection-guidance.js';

export const importRailwayProvider: ProviderImportDriver = async (ctx, input) => {
  const {
    name,
    id,
    force = false,
    environmentMappings,
    storageMappings,
    databaseMappings,
    cacheMappings,
    confirm,
  } = input;
  if (!environmentMappings) {
    return commandError('VALIDATION', 'hv_import requires environmentMappings because it writes Hypervibe adoption bindings.', {
      hint: 'Use hv_inspect first to read environments/services/components, then call hv_import with environmentMappings and confirm=true when you want to adopt.',
      next: ['hv_inspect'],
    });
  }

  const adapter = await connectRailwayForImport();
  if (!adapter) {
    return commandError('MISSING_CONNECTION', 'No Railway connection configured.', {
      ...connectionSetupOptions('railway'),
    });
  }

  try {
    let selectedProjectId = id;
    let selectedProjectName = name;
    if (!selectedProjectId) {
      const matches = await adapter.findProjectsByName(name!);
      if (matches.length === 0) {
        return commandError('NOT_FOUND', `Railway project "${name}" not found.`, {
          hint: 'Use hv_inspect to inspect existing provider infrastructure. For new infrastructure use hv_spec, hv_plan, and hv_apply.',
        });
      }
      if (matches.length > 1) {
        return commandError('VALIDATION', `Multiple Railway projects named "${name}" are visible.`, {
          details: { projects: matches.map((project) => ({ name: project.name, id: project.id })) },
          hint: 'Re-run hv_import with id set to the exact provider project id. Hypervibe will not guess between duplicate provider projects.',
          next: ['hv_inspect', 'hv_import'],
        });
      }
      selectedProjectId = matches[0].id;
      selectedProjectName = matches[0].name;
    }

    const inspection = await inspectRailwayProject(adapter, selectedProjectId!);
    if (!inspection) {
      return commandError('PROVIDER_ERROR', `Could not fetch details for Railway project "${selectedProjectName ?? selectedProjectId}".`, {
        hint: 'Use hv_inspect to inspect existing provider infrastructure. For new infrastructure use hv_spec, hv_plan, and hv_apply.',
      });
    }

    const { details, environments, services, components } = inspection;
    if (components.length > 0) {
      return commandError(
        'UNSUPPORTED',
        'Railway legacy plugin databases/caches cannot be adopted safely because their provider resource kind has no verified lifecycle teardown contract.',
        {
          details: {
            components: components.map((component) => ({
              id: component.railwayId,
              name: component.name,
              type: component.type,
            })),
          },
          hint: 'Migrate the datastore to a Railway service-backed Postgres/Redis resource, then map that exact service id with databaseMappings or cacheMappings. Hypervibe leaves legacy plugins unmanaged.',
          next: ['hv_inspect', 'hv_import'],
        }
      );
    }
    const providerEnvironmentNames = new Set(environments.map((environment) => environment.name));
    const unknownEnvironmentMappings = Object.keys(environmentMappings)
      .filter((environmentName) => !providerEnvironmentNames.has(environmentName));
    if (unknownEnvironmentMappings.length > 0) {
      return commandError('VALIDATION', `environmentMappings references unknown Railway environment(s): ${unknownEnvironmentMappings.join(', ')}`, {
        hint: 'Use the exact provider environment names returned by hv_inspect.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const normalizedEnvironmentTargets = Object.values(environmentMappings)
      .map((environmentName) => environmentName.trim().toLowerCase());
    const duplicateEnvironmentTargets = normalizedEnvironmentTargets.filter(
      (environmentName, index) => normalizedEnvironmentTargets.indexOf(environmentName) !== index
    );
    if (duplicateEnvironmentTargets.length > 0) {
      return commandError('VALIDATION', `Multiple Railway environments cannot map to the same Hypervibe environment: ${Array.from(new Set(duplicateEnvironmentTargets)).join(', ')}`, {
        hint: 'Give every adopted provider environment one distinct Hypervibe environment name.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const unknownDatabaseMappings = Object.keys(databaseMappings ?? {})
      .filter((serviceId) => !services.some((service) => service.railwayId === serviceId));
    if (unknownDatabaseMappings.length > 0) {
      return commandError('VALIDATION', `databaseMappings references unknown Railway service id(s): ${unknownDatabaseMappings.join(', ')}`, {
        hint: 'Use the datastore candidates returned by hv_inspect and map the exact provider service id.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    if (Object.keys(databaseMappings ?? {}).length > 1) {
      return commandError('VALIDATION', 'Only one Railway service can be adopted as the PostgreSQL component for an environment.', {
        hint: 'Select the intended datastore explicitly. Leave additional PostgreSQL services unmanaged until they are deliberately cleaned up.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const unknownCacheMappings = Object.keys(cacheMappings ?? {})
      .filter((serviceId) => !services.some((service) => service.railwayId === serviceId));
    if (unknownCacheMappings.length > 0) {
      return commandError('VALIDATION', `cacheMappings references unknown Railway service id(s): ${unknownCacheMappings.join(', ')}`, {
        hint: 'Use the datastore candidates returned by hv_inspect and map the exact provider service id.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    if (Object.keys(cacheMappings ?? {}).length > 1) {
      return commandError('VALIDATION', 'Only one Railway service can be adopted as the Redis cache component for an environment.', {
        hint: 'Select the intended cache explicitly. Leave additional Redis/Valkey services unmanaged until they are deliberately cleaned up.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const overlappingDatastoreMappings = Object.keys(databaseMappings ?? {})
      .filter((serviceId) => serviceId in (cacheMappings ?? {}));
    if (overlappingDatastoreMappings.length > 0) {
      return commandError('VALIDATION', `A Railway service cannot be adopted as both database and cache: ${overlappingDatastoreMappings.join(', ')}`, {
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const selectedProviderEnvironmentIds = new Set(
      details.environments.edges
        .filter((environment) => Object.prototype.hasOwnProperty.call(environmentMappings, environment.node.name))
        .map((environment) => environment.node.id)
    );
    const inactiveDatastoreMappings = [
      ...Object.keys(databaseMappings ?? {}),
      ...Object.keys(cacheMappings ?? {}),
    ].filter((serviceId) => {
      const service = services.find((candidate) => candidate.railwayId === serviceId);
      return !Object.keys(service?.instancesByEnv ?? {}).some((environmentId) =>
        selectedProviderEnvironmentIds.has(environmentId)
      );
    });
    if (inactiveDatastoreMappings.length > 0) {
      return commandError('VALIDATION', `Datastore mapping(s) have no active instance in the selected environments: ${inactiveDatastoreMappings.join(', ')}`, {
        hint: 'Map an environment where each selected datastore service has an instance, or omit that datastore from this import.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const storageById = new Map(inspection.storage.map((bucket) => [bucket.railwayId, bucket]));
    const unknownStorageMappings = Object.keys(storageMappings ?? {})
      .filter((bucketId) => !storageById.has(bucketId));
    if (unknownStorageMappings.length > 0) {
      return commandError('VALIDATION', `storageMappings references unknown Railway bucket id(s): ${unknownStorageMappings.join(', ')}`, {
        hint: 'Use the exact bucket ids returned by hv_inspect.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const duplicateStorageNames = Object.values(storageMappings ?? {})
      .map((storageName) => storageName.toLowerCase())
      .filter((storageName, index, names) => names.indexOf(storageName) !== index);
    if (duplicateStorageNames.length > 0) {
      return commandError('VALIDATION', `Multiple Railway buckets cannot map to the same desired storage name: ${Array.from(new Set(duplicateStorageNames)).join(', ')}`, {
        hint: 'Give every adopted bucket one distinct desired storage name.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    const selectedProviderEnvironments = new Set(Object.keys(environmentMappings));
    const inactiveStorageMappings = Object.keys(storageMappings ?? {}).filter((bucketId) =>
      !(storageById.get(bucketId)?.environments.some((environment) =>
        selectedProviderEnvironments.has(environment.name) && Boolean(environment.region)
      ))
    );
    if (inactiveStorageMappings.length > 0) {
      return commandError('VALIDATION', `storageMappings references bucket(s) with no active instance in the selected environments: ${inactiveStorageMappings.join(', ')}`, {
        hint: 'Map an environment where each bucket is active, or omit that bucket from this import.',
        next: ['hv_inspect', 'hv_import'],
      });
    }
    try {
      validateRailwayStorageCreateRecoveryResolution(details, environmentMappings, {
        force,
        storageMappings,
        databaseMappings,
        cacheMappings,
      });
      buildImportedRailwaySpec(details, environmentMappings, services, components, {
        force,
        storageMappings,
        databaseMappings,
        cacheMappings,
      });
    } catch (error) {
      return commandError('VALIDATION', 'The selected Railway resources cannot be represented safely in a Hypervibe spec.', {
        details: { reason: error instanceof Error ? error.message : String(error) },
        hint: 'Review the exact environment and resource mappings returned by hv_inspect.',
        next: ['hv_inspect', 'hv_import'],
      });
    }

    const existing = ctx.repos.projects.findByName(details.name);
    if (existing && !force) {
      return commandError('VALIDATION', `Hypervibe project "${details.name}" already exists. hv_import is adoption-only.`, {
        hint: 'Use hv_plan/hv_apply for setup or retries. Re-run hv_import with force=true only to intentionally re-adopt this live Railway project and update local bindings.',
      });
    }

    if (!confirm) {
      return commandError('CONFIRM_REQUIRED', `This will adopt Railway project "${details.name}" into Hypervibe local state. Provider resources are not changed.`, {
        details: {
          project: { name: details.name, id: details.id },
          environmentMappings,
          environments: environments.map((environment) => ({ name: environment.name, id: environment.railwayId })),
          services: services.map((service) => ({ name: service.name, id: service.railwayId })),
          components: components.map((component) => ({ name: component.name, id: component.railwayId, type: component.type })),
          storage: inspection.storage.map((bucket) => ({ name: bucket.name, id: bucket.railwayId, environments: bucket.environments })),
          storageMappings: storageMappings ?? {},
          databaseMappings: databaseMappings ?? {},
          cacheMappings: cacheMappings ?? {},
        },
        hint: 'Re-run hv_import with the same provider, name/id, environmentMappings, and confirm=true to write local Hypervibe adoption bindings.',
        next: ['hv_import'],
      });
    }

    const result = await importRailwayProject(details, environmentMappings, services, components, {
      force,
      storageMappings,
      databaseMappings,
      cacheMappings,
    });
    if (result.status === 'already_exists') {
      return commandError('VALIDATION', `Project "${details.name}" already exists in Hypervibe.`);
    }
    return commandSuccess(
      {
        imported: true,
        project: result.project,
        environments: result.environments,
        services: result.services,
        components: result.components,
        spec: result.spec,
        specRevision: result.specRevision,
      },
      {
        hint: `Imported "${details.name}" from Railway with matching desired state. Review it with hv_spec, then use hv_status to verify the adoption round trip.`,
        next: ['hv_status'],
      }
    );
  } finally {
    await adapter.disconnect();
  }
};
