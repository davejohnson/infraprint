import type { CommandContext } from './context.js';
import { commandError, commandSuccess, type CommandEnvelope } from './results.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { inspectProvider } from './inspect-provider.js';
import { suppliedOptionNames } from './command-options.js';
import {
  parseUnresolvedDatabaseMutation,
  parseUnresolvedDatastoreMutation,
} from '../domain/ports/database.port.js';

export interface ImportProviderInput {
  provider: string;
  mode?: 'adopt' | 'retained-cleanup' | 'retained-database-cleanup' | 'retained-cache-cleanup' | 'retained-resource-cleanup';
  resource?: string;
  project?: string;
  env?: string;
  region?: string;
  name?: string;
  id?: string;
  force?: boolean;
  environmentMappings?: Record<string, string>;
  storageMappings?: Record<string, string>;
  databaseMappings?: Record<string, 'postgres'>;
  cacheMappings?: Record<string, 'redis'>;
  confirm?: boolean;
}

async function retainResourceCleanup(
  ctx: CommandContext,
  input: ImportProviderInput,
  provider: string
): Promise<CommandEnvelope> {
  const resource = input.resource?.trim();
  const externalId = input.id?.trim();
  if (!input.project || !input.env || !resource || !externalId) {
    return commandError('VALIDATION', 'retained-resource-cleanup requires project, env, resource, and the exact id returned by hv_inspect.', {
      hint: `Run hv_inspect provider="${provider}" to discover cleanup-capable resources, inspect one resource class, then pass one exact returned id.`,
      next: ['hv_inspect', 'hv_import'],
    });
  }
  const registration = providerRegistry.get(provider);
  const contract = registration?.inspection?.selectors[resource];
  if (!registration?.retainedCleanup?.resources.includes(resource) || !contract?.collectionKey) {
    return commandError('UNSUPPORTED', `${registration?.metadata.displayName ?? provider} does not declare retained cleanup for resource "${resource}".`, {
      details: { resources: registration?.retainedCleanup?.resources ?? [] },
      hint: 'Use a cleanup-capable resource advertised by provider discovery.',
      next: ['hv_inspect'],
    });
  }

  const project = ctx.resolveProjectOrThrow({ project: input.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, input.env);
  const currentBindings = record(environment.platformBindings) ?? {};
  if (record(currentBindings.previousResource)) {
    return commandError('VALIDATION', 'A retained provider-resource cleanup target already exists for this environment.', {
      details: { previousResource: currentBindings.previousResource },
      hint: 'Finish the existing retained cleanup plan before recording another data-bearing target.',
      next: ['hv_plan'],
    });
  }

  const forensic = await inspectProvider(ctx, {
    provider,
    project: project.name,
    resource,
    id: externalId,
    region: input.region,
  });
  const items = Array.isArray(forensic[contract.collectionKey]) ? forensic[contract.collectionKey] as unknown[] : [];
  const exact = items
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => stringValue(item.id) === externalId);
  if (forensic.partial !== false) {
    return commandError('PROVIDER_ERROR', `${registration.metadata.displayName} returned a partial ${resource} inventory; cleanup identity was not retained.`, {
      details: forensic,
      hint: 'Resolve the provider read failure and refresh hv_inspect before retaining a data-bearing deletion target.',
      next: ['hv_inspect'],
    });
  }
  if (forensic.observation !== 'present' || exact.length === 0) {
    return commandError('NOT_FOUND', `${registration.metadata.displayName} did not confirm ${resource} ${externalId} is present.`, {
      details: forensic,
      hint: 'Refresh hv_inspect inventory. Hypervibe will not retain or delete an unverified identity.',
      next: ['hv_inspect'],
    });
  }
  if (exact.length !== 1) {
    return commandError('VALIDATION', `${registration.metadata.displayName} did not return one unambiguous ${resource} for id ${externalId}.`, {
      details: forensic,
      hint: 'Use the exact durable provider id from a fresh inventory; Hypervibe will not choose between candidates.',
      next: ['hv_inspect'],
    });
  }
  if (exact[0].cleanupSupported === false) {
    return commandError('UNSUPPORTED', `${registration.metadata.displayName} can inventory ${resource} ${externalId}, but reported that it cannot safely delete it.`, {
      details: { resource: exact[0] },
      next: ['hv_inspect'],
    });
  }
  const providerScope = record(exact[0].providerScope);
  const requiredScopeKeys = contract.scopeKeys ?? [];
  if (
    requiredScopeKeys.length === 0
    || !providerScope
    || Object.values(providerScope).some((value) => typeof value !== 'string' || !value)
    || requiredScopeKeys.some((key) => typeof providerScope[key] !== 'string' || !providerScope[key])
  ) {
    return commandError('PROVIDER_ERROR', `${registration.metadata.displayName} did not return the durable provider scope for ${resource} ${externalId}.`, {
      details: { resource: exact[0], requiredScopeKeys },
      next: ['hv_inspect'],
    });
  }
  const previousResource = {
    provider,
    resource,
    externalId,
    name: stringValue(exact[0].name) ?? externalId,
    providerScope,
  };

  if (!input.confirm) {
    return commandError('CONFIRM_REQUIRED', `This will retain ${provider} ${resource} ${externalId} as the exact data-bearing deletion target for ${project.name}/${environment.name}. No provider resource will be changed yet.`, {
      details: { previousResource },
      hint: 'Re-run hv_import with confirm=true, then use hv_plan scope="retained-cleanup" and explicitly confirm its destroy action.',
      next: ['hv_import'],
    });
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, { previousResource });
  ctx.repos.audit.create({
    action: 'provider-resource.previous.retained',
    resourceType: 'environment',
    resourceId: environment.id,
    details: { project: project.name, environment: environment.name, provider, resource, externalId, providerScope },
  });
  return commandSuccess({
    retainedResourceCleanup: {
      provider,
      resource,
      project: project.name,
      environment: environment.name,
      externalId,
      providerScope,
    },
  }, {
    hint: 'Run hv_plan with scope="retained-cleanup" and confirm only the exact retained resource destroy action after reviewing the identity and scope.',
    next: ['hv_plan'],
  });
}

async function retainDatabaseCleanup(
  ctx: CommandContext,
  input: ImportProviderInput,
  provider: string
): Promise<CommandEnvelope> {
  if (!input.project || !input.env || !input.id?.trim()) {
    return commandError('VALIDATION', 'retained-database-cleanup requires project, env, and the exact database id returned by hv_inspect.', {
      hint: `Run hv_inspect provider="${provider}" resource="database", then pass one exact returned id with the current Hypervibe project and environment.`,
      next: ['hv_inspect', 'hv_import'],
    });
  }
  const registration = providerRegistry.get(provider);
  if (!providerRegistry.supports(provider, 'database') || !registration?.inspection?.resources.includes('database')) {
    return commandError('UNSUPPORTED', `${registration?.metadata.displayName ?? provider} cannot inventory and retain an exact database cleanup target.`, {
      hint: 'A provider-owned database inspection contract is required before Hypervibe can authorize cleanup.',
      next: ['hv_inspect'],
    });
  }

  const project = ctx.resolveProjectOrThrow({ project: input.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, input.env);
  const currentBindings = record(environment.platformBindings) ?? {};
  if (record(currentBindings.previousDatabase)) {
    return commandError('VALIDATION', 'A retained database cleanup target already exists for this environment.', {
      details: { previousDatabase: currentBindings.previousDatabase },
      hint: 'Finish the existing retained cleanup plan before recording another data-bearing target.',
      next: ['hv_plan'],
    });
  }

  const externalId = input.id.trim();
  const activeComponent = ctx.repos.components.findByEnvironmentId(environment.id).find((component) => (
    component.type === 'postgres'
    && component.bindings.provider === provider
    && component.externalId === externalId
  ));
  if (activeComponent) {
    return commandError('VALIDATION', `Database ${externalId} is the active locally bound ${provider} component for ${project.name}/${environment.name}.`, {
      hint: 'Change desired state and use the ordinary hv_plan/hv_apply database destroy lifecycle; retained cleanup is only for an abandoned unbound identity.',
      next: ['hv_plan'],
    });
  }

  const forensic = await inspectProvider(ctx, {
    provider,
    project: project.name,
    resource: 'database',
    id: externalId,
  });
  const databases = Array.isArray(forensic.databases) ? forensic.databases : [];
  const exact = databases
    .map(record)
    .filter((database): database is Record<string, unknown> => Boolean(database))
    .filter((database) => stringValue(database.id) === externalId);
  if (forensic.partial !== false) {
    return commandError('PROVIDER_ERROR', `${registration.metadata.displayName} returned a partial database inventory; cleanup identity was not retained.`, {
      details: forensic,
      hint: 'Resolve the provider read failure and refresh hv_inspect before retaining a data-bearing deletion target.',
      next: ['hv_inspect'],
    });
  }
  if (forensic.observation !== 'present' || exact.length === 0) {
    return commandError('NOT_FOUND', `${registration.metadata.displayName} did not confirm database ${externalId} is present.`, {
      details: forensic,
      hint: 'Refresh hv_inspect inventory. Hypervibe will not retain or delete an unverified identity.',
      next: ['hv_inspect'],
    });
  }
  if (exact.length !== 1) {
    return commandError('VALIDATION', `${registration.metadata.displayName} did not return one unambiguous database for id ${externalId}.`, {
      details: forensic,
      hint: 'Use the exact durable provider id from a fresh inventory; Hypervibe will not choose between candidates.',
      next: ['hv_inspect'],
    });
  }
  if (exact[0].cleanupSupported === false) {
    return commandError('UNSUPPORTED', `${registration.metadata.displayName} can inventory database ${externalId}, but its provider resource kind cannot be deleted through the lifecycle adapter.`, {
      details: { database: exact[0] },
      hint: 'Keep the resource visible in hv_inspect; do not retain it as a deletion target until the provider exposes a supported teardown operation.',
      next: ['hv_inspect'],
    });
  }
  const providerScope = record(exact[0].providerScope);
  const requiredScopeKeys = registration.inspection.selectors.database?.scopeKeys ?? [];
  if (
    requiredScopeKeys.length === 0
    || !providerScope
    || Object.keys(providerScope).length === 0
    || Object.values(providerScope).some((value) => typeof value !== 'string' || !value)
    || requiredScopeKeys.some((key) => typeof providerScope[key] !== 'string' || !providerScope[key])
  ) {
    return commandError('PROVIDER_ERROR', `${registration.metadata.displayName} did not return the durable provider scope for database ${externalId}.`, {
      details: { database: exact[0], requiredScopeKeys },
      hint: 'The provider inspector must return a non-secret providerScope before this id can become a deletion target.',
      next: ['hv_inspect'],
    });
  }
  const engine = stringValue(exact[0].engine);
  if (engine !== 'postgres') {
    return commandError('UNSUPPORTED', `Retained cleanup supports PostgreSQL, but ${externalId} was reported as ${engine ?? 'an unknown engine'}.`);
  }
  const resourceName = stringValue(exact[0].name) ?? externalId;
  const unresolvedComponents = ctx.repos.components.findByEnvironmentId(environment.id)
    .filter((component) => (
      component.type === 'postgres'
      && component.externalId === null
      && component.bindings.provisioningIncomplete === true
      && component.bindings.provider === provider
    ));
  if (unresolvedComponents.length > 1) {
    return commandError('VALIDATION', `Multiple unresolved ${provider} database markers exist for ${project.name}/${environment.name}.`, {
      hint: 'Repair the duplicate local component state before selecting a data-bearing cleanup target.',
    });
  }
  if (unresolvedComponents.length === 1) {
    const marker = parseUnresolvedDatabaseMutation(unresolvedComponents[0]!.bindings);
    if (
      !marker
      || marker.resourceName !== resourceName
      || !sameRecord(marker.providerScope, providerScope)
    ) {
      return commandError('VALIDATION', `Database ${externalId} does not exactly match the unresolved ${provider} create marker.`, {
        details: {
          inspected: { externalId, name: resourceName, providerScope },
          unresolvedMarker: marker,
        },
        hint: 'Refresh hv_inspect for the marker’s exact provider name and full scope. Hypervibe will not retarget unresolved local state to a different database.',
        next: ['hv_inspect'],
      });
    }
  }
  const previousDatabase = {
    provider,
    externalId,
    engine,
    name: resourceName,
    providerScope,
  };

  if (!input.confirm) {
    return commandError('CONFIRM_REQUIRED', `This will retain ${provider} database ${externalId} as the exact data-bearing deletion target for ${project.name}/${environment.name}. No provider resource will be changed yet.`, {
      details: { previousDatabase },
      hint: 'Re-run hv_import with confirm=true, then use hv_plan scope="retained-cleanup" and explicitly confirm its database destroy action.',
      next: ['hv_import'],
    });
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, { previousDatabase });
  ctx.repos.audit.create({
    action: 'database.previous.retained',
    resourceType: 'environment',
    resourceId: environment.id,
    details: { project: project.name, environment: environment.name, provider, externalId, providerScope },
  });
  return commandSuccess({
    retainedDatabaseCleanup: {
      provider,
      project: project.name,
      environment: environment.name,
      externalId,
      providerScope,
    },
  }, {
    hint: 'Run hv_plan with scope="retained-cleanup" and confirm only the exact retained database destroy action after reviewing the identity and scope.',
    next: ['hv_plan'],
  });
}

async function retainCacheCleanup(
  ctx: CommandContext,
  input: ImportProviderInput,
  provider: string
): Promise<CommandEnvelope> {
  if (!input.project || !input.env || !input.id?.trim()) {
    return commandError('VALIDATION', 'retained-cache-cleanup requires project, env, and the exact cache id returned by hv_inspect.', {
      hint: `Run hv_inspect provider="${provider}" resource="cache", then pass one exact returned id with the current Hypervibe project and environment.`,
      next: ['hv_inspect', 'hv_import'],
    });
  }
  const registration = providerRegistry.get(provider);
  const contract = registration?.inspection?.selectors.cache;
  const acceptedSelectors = new Set([
    ...(contract?.required ?? []),
    ...(contract?.optional ?? []),
    ...(contract?.oneOf?.flat() ?? []),
  ]);
  if (
    !providerRegistry.supports(provider, 'cache')
    || !registration?.inspection?.resources.includes('cache')
    || contract?.mode !== 'provider-resource'
    || contract.list !== true
    || !acceptedSelectors.has('id')
    || !acceptedSelectors.has('limit')
    || (contract.scopeKeys?.length ?? 0) === 0
  ) {
    return commandError('UNSUPPORTED', `${registration?.metadata.displayName ?? provider} cannot inventory and retain an exact cache cleanup target.`, {
      hint: 'A provider-owned, bounded exact-id cache inspection contract with durable scope is required before Hypervibe can authorize cleanup.',
      next: ['hv_inspect'],
    });
  }

  const project = ctx.resolveProjectOrThrow({ project: input.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, input.env);
  const currentBindings = record(environment.platformBindings) ?? {};
  if (record(currentBindings.previousCache)) {
    return commandError('VALIDATION', 'A retained cache cleanup target already exists for this environment.', {
      details: { previousCache: currentBindings.previousCache },
      hint: 'Finish the existing retained cleanup plan before recording another data-bearing target.',
      next: ['hv_plan'],
    });
  }

  const externalId = input.id.trim();
  const activeComponent = ctx.repos.components.findByEnvironmentId(environment.id).find((component) => (
    component.type === 'redis'
    && component.bindings.provider === provider
    && (
      component.externalId
      ?? stringValue(component.bindings.instanceId)
      ?? stringValue(component.bindings.serviceId)
    ) === externalId
  ));
  if (activeComponent) {
    return commandError('VALIDATION', `Cache ${externalId} is the active locally bound ${provider} component for ${project.name}/${environment.name}.`, {
      hint: 'Change desired state and use the ordinary hv_plan/hv_apply cache destroy lifecycle; retained cleanup is only for an abandoned unbound identity.',
      next: ['hv_plan'],
    });
  }

  const unresolvedComponents = ctx.repos.components.findByEnvironmentId(environment.id)
    .filter((component) => (
      component.type === 'redis'
      && component.externalId === null
      && component.bindings.provisioningIncomplete === true
      && component.bindings.provider === provider
    ));
  if (unresolvedComponents.length > 1) {
    return commandError('VALIDATION', `Multiple unresolved ${provider} cache markers exist for ${project.name}/${environment.name}.`, {
      hint: 'Repair the duplicate local component state before selecting a data-bearing cleanup target.',
    });
  }
  const unresolvedMarker = unresolvedComponents.length === 1
    ? parseUnresolvedDatastoreMutation(unresolvedComponents[0]!.bindings, 'cache')
    : null;
  if (unresolvedComponents.length === 1 && !unresolvedMarker) {
    return commandError('VALIDATION', `The unresolved ${provider} cache marker is malformed.`, {
      hint: 'Repair the local marker before selecting any provider resource for deletion.',
    });
  }

  const forensic = await inspectProvider(ctx, {
    provider,
    project: project.name,
    resource: 'cache',
    id: externalId,
  });
  const caches = Array.isArray(forensic.caches) ? forensic.caches : [];
  const exactById = caches
    .map(record)
    .filter((cache): cache is Record<string, unknown> => Boolean(cache))
    .filter((cache) => stringValue(cache.id) === externalId);
  const exact = unresolvedMarker
    ? exactById.filter((cache) => {
        const scope = record(cache.providerScope);
        return scope && sameRecord(scope, unresolvedMarker.providerScope);
      })
    : exactById;
  if (forensic.partial !== false || forensic.truncated !== false) {
    return commandError('PROVIDER_ERROR', `${registration.metadata.displayName} returned an incomplete cache inventory; cleanup identity was not retained.`, {
      details: forensic,
      hint: 'Resolve the provider read failure and refresh hv_inspect before retaining a data-bearing deletion target.',
      next: ['hv_inspect'],
    });
  }
  if (forensic.observation !== 'present' || exact.length === 0) {
    return commandError('NOT_FOUND', `${registration.metadata.displayName} did not confirm cache ${externalId} is present.`, {
      details: forensic,
      hint: 'Refresh hv_inspect inventory. Hypervibe will not retain or delete an unverified identity.',
      next: ['hv_inspect'],
    });
  }
  if (exact.length !== 1) {
    return commandError('VALIDATION', `${registration.metadata.displayName} did not return one unambiguous cache for id ${externalId}.`, {
      details: forensic,
      hint: 'Use one exact durable provider id from a fresh inventory; Hypervibe will not choose between scoped candidates.',
      next: ['hv_inspect'],
    });
  }
  if (exact[0].cleanupSupported === false) {
    return commandError('UNSUPPORTED', `${registration.metadata.displayName} can inventory cache ${externalId}, but its provider resource kind cannot be deleted through the lifecycle adapter.`, {
      details: { cache: exact[0] },
      hint: 'Keep the resource visible in hv_inspect; do not retain it as a deletion target until the provider exposes a supported teardown operation.',
      next: ['hv_inspect'],
    });
  }
  const providerScope = record(exact[0].providerScope);
  const requiredScopeKeys = contract.scopeKeys ?? [];
  if (
    !providerScope
    || Object.keys(providerScope).length === 0
    || Object.entries(providerScope).some(([key, value]) => (
      !key.trim() || typeof value !== 'string' || !value.trim()
    ))
    || requiredScopeKeys.some((key) => typeof providerScope[key] !== 'string' || !providerScope[key])
  ) {
    return commandError('PROVIDER_ERROR', `${registration.metadata.displayName} did not return the durable provider scope for cache ${externalId}.`, {
      details: { cache: exact[0], requiredScopeKeys },
      hint: 'The provider inspector must return a complete, non-secret providerScope before this id can become a deletion target.',
      next: ['hv_inspect'],
    });
  }
  const providerEngine = stringValue(exact[0].engine);
  if (providerEngine !== 'redis' && providerEngine !== 'valkey') {
    return commandError('UNSUPPORTED', `Retained cache cleanup supports Redis-compatible caches, but ${externalId} was reported as ${providerEngine ?? 'an unknown engine'}.`);
  }
  const resourceName = stringValue(exact[0].name) ?? externalId;
  if (unresolvedMarker) {
    if (
      unresolvedMarker.resourceName !== resourceName
      || !sameRecord(unresolvedMarker.providerScope, providerScope)
    ) {
      return commandError('VALIDATION', `Cache ${externalId} does not exactly match the unresolved ${provider} create marker.`, {
        details: {
          inspected: { externalId, name: resourceName, engine: providerEngine, providerScope },
          unresolvedMarker,
        },
        hint: 'Refresh hv_inspect for the marker’s exact provider name and full scope. Hypervibe will not retarget unresolved local state to a different cache.',
        next: ['hv_inspect'],
      });
    }
  }
  const resourceKind = stringValue(exact[0].resourceKind);
  const previousCache = {
    provider,
    externalId,
    engine: 'redis',
    providerEngine,
    name: resourceName,
    providerScope,
    ...(resourceKind ? { resourceKind } : {}),
  };

  if (!input.confirm) {
    return commandError('CONFIRM_REQUIRED', `This will retain ${provider} cache ${externalId} as the exact data-bearing deletion target for ${project.name}/${environment.name}. No provider resource will be changed yet.`, {
      details: { previousCache },
      hint: 'Re-run hv_import with confirm=true, then use hv_plan scope="retained-cleanup" and explicitly confirm its cache destroy action.',
      next: ['hv_import'],
    });
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, { previousCache });
  ctx.repos.audit.create({
    action: 'cache.previous.retained',
    resourceType: 'environment',
    resourceId: environment.id,
    details: { project: project.name, environment: environment.name, provider, externalId, providerScope },
  });
  return commandSuccess({
    retainedCacheCleanup: {
      provider,
      project: project.name,
      environment: environment.name,
      externalId,
      providerScope,
    },
  }, {
    hint: 'Run hv_plan with scope="retained-cleanup" and confirm only the exact retained cache destroy action after reviewing the identity and scope.',
    next: ['hv_plan'],
  });
}

export type ProviderImportDriver = (
  ctx: CommandContext,
  input: ImportProviderInput
) => Promise<CommandEnvelope>;

const importDrivers = new Map<string, ProviderImportDriver>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const sorted = (value: Record<string, unknown>) => Object.fromEntries(
    Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  );
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

async function retainHostingCleanup(
  ctx: CommandContext,
  input: ImportProviderInput,
  provider: string
): Promise<CommandEnvelope> {
  if (!input.project || !input.env) {
    return commandError('VALIDATION', 'retained-cleanup requires the current Hypervibe project and environment.', {
      hint: 'Pass project and env exactly as used by hv_inspect.',
      next: ['hv_inspect', 'hv_import'],
    });
  }
  if (!providerRegistry.supports(provider, 'hosting')) {
    return commandError('UNSUPPORTED', `${provider} is not a hosting provider and cannot be retained for hosting cleanup.`);
  }
  const project = ctx.resolveProjectOrThrow({ project: input.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, input.env);
  const currentBindings = record(environment.platformBindings) ?? {};
  const currentProvider = stringValue(currentBindings.provider);
  if (!currentProvider || currentProvider === provider) {
    return commandError('VALIDATION', currentProvider
      ? `${provider} is the current hosting provider; use desired-state plan/apply instead of retained cleanup.`
      : `Environment "${environment.name}" has no current hosting-provider binding.`);
  }
  if (record(currentBindings.previousHosting)) {
    return commandError('VALIDATION', 'A previous hosting-provider cleanup binding is already retained.', {
      details: { previousHosting: currentBindings.previousHosting },
      hint: 'Finish or explicitly resolve the existing retained cleanup before recording another provider.',
      next: ['hv_plan'],
    });
  }

  const forensic = await inspectProvider(ctx, {
    provider,
    project: project.name,
    env: environment.name,
    resource: 'environment',
    region: input.region,
    limit: 100,
  });
  const inspected = record(forensic.inspected);
  if (!inspected || inspected.observation !== 'present') {
    return commandError('NOT_FOUND', `No abandoned ${provider} environment resources were verified for ${project.name}/${environment.name}.`, {
      details: forensic,
      next: ['hv_inspect'],
    });
  }
  if (inspected.partial === true) {
    return commandError('PROVIDER_ERROR', `${provider} returned a partial environment inventory; cleanup identity was not retained.`, {
      details: inspected,
      hint: 'Resolve the provider read failure and rerun hv_inspect before importing cleanup identity.',
      next: ['hv_inspect'],
    });
  }
  const cleanupBoundary = providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.teardownBoundary;
  if (!cleanupBoundary) {
    return commandError('UNSUPPORTED', `${provider} does not declare a complete hosting teardown boundary.`);
  }
  if (cleanupBoundary === 'project' && inspected.managedByHypervibe === false) {
    return commandError('VALIDATION', `${provider} reported that the matched project boundary is not Hypervibe-managed.`, {
      details: inspected,
      hint: 'Hypervibe will not retain an unowned project as a deletion target.',
    });
  }

  const inspectedProject = record(inspected.project);
  const inspectedEnvironment = record(inspected.environment);
  const projectId = stringValue(inspectedProject?.id);
  const environmentId = stringValue(inspectedEnvironment?.id) ?? stringValue(inspectedEnvironment?.region);
  if (!projectId || (cleanupBoundary === 'environment' && !environmentId)) {
    return commandError('PROVIDER_ERROR', `${provider} did not return the durable ${cleanupBoundary} identity required for cleanup.`, {
      details: inspected,
      next: ['hv_inspect'],
    });
  }

  const services: Record<string, Record<string, string>> = {};
  for (const rawService of Array.isArray(inspected.services) ? inspected.services : []) {
    const service = record(rawService);
    const name = stringValue(service?.name);
    const serviceId = stringValue(service?.id);
    if (!name || !serviceId) {
      return commandError('PROVIDER_ERROR', `${provider} returned a service without a durable name and id.`, {
        details: { service: rawService },
      });
    }
    if (services[name]) {
      return commandError('VALIDATION', `${provider} returned multiple cleanup resources named "${name}".`, {
        hint: 'Resolve the ambiguous provider identity before retaining cleanup state.',
        next: ['hv_inspect'],
      });
    }
    if (service?.managedByHypervibe === false) {
      return commandError('VALIDATION', `${provider} reported that service "${name}" is not Hypervibe-managed.`, {
        hint: 'Hypervibe will not retain an unowned service as a deletion target.',
      });
    }
    services[name] = {
      serviceId,
      ...(['jobName', 'schedulerJobName', 'resourceType'] as const).reduce<Record<string, string>>((fields, key) => {
        const value = stringValue(service?.[key]);
        return value ? { ...fields, [key]: value } : fields;
      }, {}),
    };
  }
  if (cleanupBoundary === 'services' && Object.keys(services).length === 0) {
    return commandError('NOT_FOUND', `${provider} returned no managed services to retain for cleanup.`, {
      details: inspected,
      next: ['hv_inspect'],
    });
  }

  const previousHosting = {
    provider,
    projectId,
    ...(environmentId ? { environmentId } : {}),
    services,
  };
  if (!input.confirm) {
    return commandError('CONFIRM_REQUIRED', `This will retain the inspected ${provider} ${cleanupBoundary} as the exact deletion target for ${project.name}/${environment.name}. No provider resource will be changed yet.`, {
      details: { previousHosting, cleanupBoundary },
      hint: 'Re-run hv_import with confirm=true, then review the confirm-gated destroy actions from hv_plan.',
      next: ['hv_import'],
    });
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, { previousHosting });
  ctx.repos.audit.create({
    action: 'hosting.previous.retained',
    resourceType: 'environment',
    resourceId: environment.id,
    details: { project: project.name, environment: environment.name, provider, cleanupBoundary },
  });
  return commandSuccess({
    retainedCleanup: {
      provider,
      project: project.name,
      environment: environment.name,
      cleanupBoundary,
      serviceCount: Object.keys(services).length,
    },
  }, {
    hint: 'Run hv_plan for this environment and explicitly confirm only the reviewed previous-provider destroy actions after the current deployment is healthy.',
    next: ['hv_plan'],
  });
}

export function registerProviderImport(provider: string, driver: ProviderImportDriver): void {
  if (importDrivers.has(provider)) throw new Error(`Provider import driver already registered: ${provider}`);
  importDrivers.set(provider, driver);
}

export async function importProvider(
  ctx: CommandContext,
  input: ImportProviderInput
): Promise<CommandEnvelope> {
  const provider = input.provider.trim().toLowerCase();
  const registered = providerRegistry.get(provider);
  if (!registered) {
    return commandError('VALIDATION', `Unknown provider "${input.provider}".`, {
      details: { providers: providerRegistry.names() },
      hint: 'Use hv_inspect without provider to list registered providers.',
      next: ['hv_inspect'],
    });
  }
  const mode = input.mode ?? 'adopt';
  const incompatible = suppliedOptionNames(mode === 'retained-cleanup'
    ? {
      resource: input.resource,
      name: input.name,
      id: input.id,
      force: input.force,
      environmentMappings: input.environmentMappings,
      storageMappings: input.storageMappings,
      databaseMappings: input.databaseMappings,
      cacheMappings: input.cacheMappings,
    }
    : mode === 'retained-database-cleanup' || mode === 'retained-cache-cleanup'
      ? {
        resource: input.resource,
        region: input.region,
        name: input.name,
        force: input.force,
        environmentMappings: input.environmentMappings,
        storageMappings: input.storageMappings,
        databaseMappings: input.databaseMappings,
        cacheMappings: input.cacheMappings,
      }
      : mode === 'retained-resource-cleanup'
        ? {
          name: input.name,
          force: input.force,
          environmentMappings: input.environmentMappings,
          storageMappings: input.storageMappings,
          databaseMappings: input.databaseMappings,
          cacheMappings: input.cacheMappings,
        }
        : { project: input.project, env: input.env, region: input.region, resource: input.resource });
  if (incompatible.length > 0) {
    return commandError('VALIDATION', `mode="${mode}" received options for the other import mode: ${incompatible.join(', ')}.`, {
      hint: `Remove the listed options before retrying mode="${mode}".`,
      next: ['hv_import'],
    });
  }
  if (mode === 'retained-cleanup') {
    return retainHostingCleanup(ctx, input, provider);
  }
  if (mode === 'retained-database-cleanup') {
    return retainDatabaseCleanup(ctx, input, provider);
  }
  if (mode === 'retained-cache-cleanup') {
    return retainCacheCleanup(ctx, input, provider);
  }
  if (mode === 'retained-resource-cleanup') {
    return retainResourceCleanup(ctx, input, provider);
  }
  const driver = importDrivers.get(provider);
  if (!registered.adoption?.project || !driver) {
    return commandError('UNSUPPORTED', `${registered.metadata.displayName} does not yet expose a tested project adoption driver.`, {
      details: { importProviders: [...importDrivers.keys()] },
      hint: 'Use hv_inspect for read-only provider state. Do not adopt by editing bindings manually.',
      next: ['hv_inspect'],
    });
  }
  if (!input.name && !input.id) {
    return commandError('VALIDATION', 'hv_import is adoption-only and requires name or id.', {
      hint: `Use hv_inspect provider="${provider}" to list/read provider projects. Use hv_import only when adopting a selected provider project into Hypervibe.`,
      next: ['hv_inspect'],
    });
  }
  return driver(ctx, { ...input, provider });
}
