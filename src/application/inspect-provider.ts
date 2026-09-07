import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
  type ProviderInspectionSelector,
  type ProviderInspectionSelectorContract,
} from '../domain/registry/provider.registry.js';
import { connectionSetupOptions } from '../domain/services/connection-guidance.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ObservedState } from '../domain/ports/observe.port.js';
import { parseHostingBindings } from '../domain/ports/hosting.port.js';

export interface InspectProviderInput {
  provider?: string;
  project?: string;
  env?: string;
  scope?: string;
  resource?: string;
  id?: string;
  name?: string;
  region?: string;
  limit?: number;
}

const ENVIRONMENT_INSPECTION_RESOURCES = new Set(['environment', 'database', 'cache', 'storage']);
const INSPECTION_SELECTORS = ['project', 'env', 'scope', 'id', 'name', 'region', 'limit'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hostingProvider(environment: Environment): string | undefined {
  const provider = environment.platformBindings.provider;
  return typeof provider === 'string' && provider ? provider : undefined;
}

function hostingBindingForProvider(
  environment: Environment,
  provider: string
): Record<string, unknown> | undefined {
  const current = asRecord(environment.platformBindings);
  if (current?.provider === provider) return current;
  const previous = asRecord(current?.previousHosting);
  return previous?.provider === provider ? previous : undefined;
}

function compatibleDatastoreHostingBinding(
  environment: Environment,
  datastoreProvider: string,
  resource: string | undefined
): Record<string, unknown> | undefined {
  if (resource !== 'database' && resource !== 'cache') return undefined;
  const hosting = parseHostingBindings(environment);
  if (!hosting.provider || !hosting.projectId) return undefined;
  const lifecycle = providerRegistry.getMetadata(datastoreProvider)?.lifecycle;
  const compatibleHostingProviders = resource === 'database'
    ? lifecycle?.databaseConnectivity?.compatibleHostingProviders
    : lifecycle?.cacheConnectivity?.compatibleHostingProviders;
  if (!compatibleHostingProviders?.includes(hosting.provider)) return undefined;
  return {
    provider: hosting.provider,
    projectId: hosting.projectId,
    ...(hosting.environmentId ? { environmentId: hosting.environmentId } : {}),
  };
}

function advertisedResources(providerName: string): string[] {
  const registered = providerRegistry.get(providerName);
  if (!registered) return [];
  const resources = new Set<string>(['connection']);
  for (const resource of registered.inspection?.resources ?? []) resources.add(resource);
  if (providerRegistry.supports(providerName, 'hosting')) resources.add('environment');
  if (providerRegistry.supports(providerName, 'database')) resources.add('database');
  if (providerRegistry.supports(providerName, 'cache')) resources.add('cache');
  if (providerRegistry.supports(providerName, 'storage')) resources.add('storage');
  return [...resources];
}

function selectorMode(
  resource: string,
  contract: ProviderInspectionSelectorContract,
  defaultResource?: string
): Record<string, unknown> {
  const isDefault = resource === defaultResource;
  const unqualifiedDefault = isDefault
    && (contract.required?.length ?? 0) === 0
    && (contract.oneOf?.length ?? 0) === 0;
  return {
    mode: contract.mode,
    resource,
    default: unqualifiedDefault,
    resourceOptionalWhenRequirementsMet: isDefault,
    required: ['provider', ...(!isDefault ? ['resource'] : []), ...(contract.required ?? [])],
    optional: [...(isDefault ? ['resource'] : []), ...(contract.optional ?? [])],
    ...(contract.oneOf?.length ? { oneOf: contract.oneOf } : {}),
    ...(contract.mutuallyExclusive?.length ? { mutuallyExclusive: contract.mutuallyExclusive } : {}),
    ...(contract.scopeKeys?.length ? { providerScopeRequired: contract.scopeKeys } : {}),
    list: contract.list === true,
    acceptsLimit: contract.list === true,
  };
}

function contractAcceptsSelector(
  contract: ProviderInspectionSelectorContract | undefined,
  selector: ProviderInspectionSelector
): boolean {
  return Boolean(contract && [
    ...(contract.required ?? []),
    ...(contract.optional ?? []),
    ...(contract.oneOf?.flat() ?? []),
  ].includes(selector));
}

function advertisedInspectionModes(providerName: string): Array<Record<string, unknown>> {
  const registered = providerRegistry.get(providerName);
  if (!registered) return [];
  const inspection = registered.inspection;
  const defaultResource = inspection?.defaultResource ?? inspection?.resources[0];
  const defaultContract = defaultResource ? inspection?.selectors[defaultResource] : undefined;
  const providerOnlyDefaultsToConnection = !defaultContract
    || (defaultContract.required?.length ?? 0) > 0
    || (defaultContract.oneOf?.length ?? 0) > 0;
  const modes: Array<Record<string, unknown>> = [{
    mode: 'connection',
    resource: 'connection',
    default: providerOnlyDefaultsToConnection,
    resourceOptionalWhenRequirementsMet: true,
    required: ['provider'],
    optional: ['resource', 'project', 'scope'],
    list: false,
    acceptsLimit: false,
  }];
  if (inspection) {
    for (const resource of inspection.resources) {
      const contract = inspection.selectors[resource];
      if (contract) modes.push(selectorMode(resource, contract, defaultResource));
    }
  }
  if (providerRegistry.supports(providerName, 'hosting')) {
    const supportsRegion = contractAcceptsSelector(
      inspection?.selectors.environment,
      'region'
    );
    modes.push(selectorMode('environment', {
      mode: 'environment',
      required: ['project', 'env'],
      optional: ['scope', ...(supportsRegion ? ['region' as const] : [])],
    }, 'environment'));
  }
  if (providerRegistry.supports(providerName, 'database')) {
    modes.push(selectorMode('database', {
      mode: 'environment',
      required: ['project', 'env'],
      optional: ['scope', 'name'],
    }, registered.metadata.category === 'database' ? 'database' : undefined));
  }
  if (providerRegistry.supports(providerName, 'cache')) {
    modes.push(selectorMode('cache', {
      mode: 'environment',
      required: ['project', 'env'],
      optional: ['scope', 'name'],
    }, registered.metadata.category === 'cache' ? 'cache' : undefined));
  }
  if (providerRegistry.supports(providerName, 'storage')) {
    modes.push(selectorMode('storage', {
      mode: 'environment',
      required: ['project', 'env'],
      optional: ['scope', 'id', 'name', 'limit'],
      list: true,
    }, registered.metadata.category === 'storage' ? 'storage' : undefined));
  }
  return modes;
}

function contractRequirementsSatisfied(
  contract: ProviderInspectionSelectorContract,
  input: InspectProviderInput
): boolean {
  return (contract.required ?? []).every((selector) => input[selector] !== undefined)
    && (contract.oneOf ?? []).every((group) => group.some((selector) => input[selector] !== undefined));
}

function listProviders(ctx: CommandContext): Record<string, unknown> {
  const connectionStatus = new Map(
    ctx.repos.connections.findAll().map((connection) => [
      `${connection.provider}\u0000${connection.scope ?? ''}`,
      connection.status,
    ])
  );
  return {
    providers: providerRegistry.all().map((registered) => {
      const connections = ctx.repos.connections.findAllByProvider(registered.metadata.name);
      return {
        provider: registered.metadata.name,
        displayName: registered.metadata.displayName,
        category: registered.metadata.category,
        maturity: registered.metadata.maturity ?? {},
        lifecycle: registered.metadata.lifecycle ?? {},
        resources: advertisedResources(registered.metadata.name),
        retainedCleanupResources: [...(registered.retainedCleanup?.resources ?? [])],
        inspectionModes: advertisedInspectionModes(registered.metadata.name),
        connections: connections.map((connection) => ({
          scope: connection.scope,
          status: connectionStatus.get(`${connection.provider}\u0000${connection.scope ?? ''}`),
        })),
      };
    }),
  };
}

function cleanInspectInput(input: InspectProviderInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function recoverableSelectorError(params: {
  message: string;
  input: InspectProviderInput;
  corrected: InspectProviderInput;
  details?: Record<string, unknown>;
  hint: string;
}): HvError {
  return new HvError('VALIDATION', params.message, {
    details: {
      ...(params.details ?? {}),
      suggestedCall: {
        command: 'hv_inspect',
        input: cleanInspectInput(params.corrected),
      },
    },
    hint: params.hint,
    next: ['hv_inspect'],
    agentInstruction: {
      action: 'continue',
      message: 'Retry hv_inspect once with exactly the safe suggestedCall input. If that corrected call fails, stop and report the new result.',
    },
  });
}

function suppliedSelectors(input: InspectProviderInput): ProviderInspectionSelector[] {
  return INSPECTION_SELECTORS.filter((selector) => input[selector] !== undefined);
}

function validateProviderSelectorContract(params: {
  input: InspectProviderInput;
  resource: string;
  contract: ProviderInspectionSelectorContract;
}): void {
  const accepted = new Set<ProviderInspectionSelector>([
    ...(params.contract.required ?? []),
    ...(params.contract.optional ?? []),
    ...(params.contract.oneOf?.flat() ?? []),
  ]);
  const supplied = suppliedSelectors(params.input);
  const invalid = supplied.filter((selector) => !accepted.has(selector));
  if (invalid.length > 0) {
    const corrected = { ...params.input };
    for (const selector of invalid) delete corrected[selector];
    throw recoverableSelectorError({
      message: `resource="${params.resource}" does not accept selector(s): ${invalid.join(', ')}.`,
      input: params.input,
      corrected,
      details: { invalid, accepted: [...accepted] },
      hint: `Use only the selectors advertised for ${params.resource}; the suggested call removes fields this mode cannot use.`,
    });
  }
  const missing = (params.contract.required ?? []).filter((selector) => params.input[selector] === undefined);
  const missingGroups = (params.contract.oneOf ?? []).filter((group) => (
    !group.some((selector) => params.input[selector] !== undefined)
  ));
  if (missing.length > 0 || missingGroups.length > 0) {
    throw new HvError('VALIDATION', `resource="${params.resource}" is missing required selectors.`, {
      details: {
        missing,
        oneOf: missingGroups,
        inspectionModes: advertisedInspectionModes(params.input.provider ?? ''),
      },
      hint: 'Call hv_inspect({}) to review the exact selector contract, then retry with the required provider scope or Hypervibe environment context.',
      next: ['hv_inspect'],
    });
  }
  for (const group of params.contract.mutuallyExclusive ?? []) {
    const conflicts = group.filter((selector) => params.input[selector] !== undefined);
    if (conflicts.length > 1) {
      throw new HvError('VALIDATION', `resource="${params.resource}" received mutually exclusive selectors: ${conflicts.join(', ')}.`, {
        details: { conflicts, inspectionModes: advertisedInspectionModes(params.input.provider ?? '') },
        hint: 'Choose one exact selector. Hypervibe will not guess which provider identity was intended.',
        next: ['hv_inspect'],
      });
    }
  }
}

function validateStatefulInspectionResult(params: {
  providerDisplayName: string;
  resource: string;
  contract: ProviderInspectionSelectorContract;
  result: Record<string, unknown>;
  limit: number;
}): void {
  if (params.contract.list !== true) return;
  const collectionKey = params.contract.collectionKey
    ?? (params.resource === 'database'
      ? 'databases'
      : params.resource === 'cache'
        ? 'caches'
        : params.resource === 'storage'
          ? 'storage'
          : undefined);
  const fail = (reason: string, details: Record<string, unknown> = {}): never => {
    throw new HvError(
      'PROVIDER_ERROR',
      `${params.providerDisplayName} returned an invalid ${params.resource} inventory: ${reason}`,
      {
        details: { resource: params.resource, ...details },
        hint: 'Treat this as a provider adapter contract failure. No provider state was changed.',
      }
    );
  };
  // Some provider-owned list modes (notably environment forensics) expose
  // more than one top-level collection and therefore have no single
  // collectionKey. Enforce the public limit on every returned collection so
  // an adapter/API over-return can never leak through hv_inspect.
  for (const [key, value] of Object.entries(params.result)) {
    if (key === 'warnings' || key === collectionKey || !Array.isArray(value)) continue;
    if (value.length > params.limit) {
      fail(`returned ${value.length} ${key} entries above limit ${params.limit}.`, { collectionKey: key });
    }
  }
  if (!collectionKey) return;
  const collection = params.result[collectionKey];
  if (!Array.isArray(collection)) {
    fail(`missing ${collectionKey} collection.`);
  }
  const resources = collection as unknown[];
  if (resources.length > params.limit) {
    fail(`returned ${resources.length} resources above limit ${params.limit}.`);
  }
  if (typeof params.result.truncated !== 'boolean' || typeof params.result.partial !== 'boolean') {
    fail('list completeness flags must be explicit booleans.');
  }
  if (!['present', 'absent', 'unknown', 'ambiguous'].includes(String(params.result.observation))) {
    fail('observation must be present, absent, unknown, or ambiguous.');
  }
  if (params.result.observation === 'unknown' && params.result.partial !== true) {
    fail('unknown observation must be marked partial.');
  }
  if (params.result.observation === 'present' && resources.length === 0) {
    fail('observation was present but the collection was empty.');
  }
  if (params.result.observation === 'absent' && resources.length > 0) {
    fail('observation was absent but the collection was non-empty.');
  }
  const scopeKeys = params.contract.scopeKeys ?? [];
  for (const [index, value] of resources.entries()) {
    const resource = asRecord(value);
    const scope = asRecord(resource?.providerScope);
    if (!resource || typeof resource.id !== 'string' || !resource.id.trim()) {
      fail('a resource omitted its durable provider id.', { index });
    }
    const checked = resource as Record<string, unknown>;
    if (typeof checked.name !== 'string' || !checked.name.trim()) {
      fail('a resource omitted its exact provider name.', { index, id: checked.id });
    }
    const missingScopeKeys = scopeKeys.filter((key) => (
      typeof scope?.[key] !== 'string' || !(scope[key] as string).trim()
    ));
    if (missingScopeKeys.length > 0) {
      fail('a resource omitted required durable provider scope.', {
        index,
        id: checked.id,
        missingScopeKeys,
      });
    }
  }
}

function componentForProvider(
  ctx: CommandContext,
  environment: Environment,
  providerName: string,
  resource: 'database' | 'cache' | undefined
): Component | null {
  const expectedType = resource === 'database'
    ? 'postgres'
    : resource === 'cache'
      ? 'redis'
      : undefined;
  const matches = ctx.repos.components.findByEnvironmentId(environment.id).filter((component) => (
    component.bindings.provider === providerName
    && (!expectedType || component.type === expectedType)
  ));
  if (matches.length > 1) {
    throw new HvError('VALIDATION', `Multiple ${providerName} ${resource ?? 'datastore'} components are bound to environment "${environment.name}".`, {
      hint: 'Repair the duplicate local component identities before provider inspection. Hypervibe will not choose the first match.',
    });
  }
  return matches[0] ?? null;
}

function boundedObservation(observed: ObservedState): Record<string, unknown> {
  return {
    provider: observed.provider,
    observedAt: observed.observedAt,
    projectExists: observed.projectExists,
    projectId: observed.projectId,
    environmentId: observed.environmentId,
    services: observed.services.map((service) => ({
      name: service.name,
      externalId: service.externalId,
      workloadKind: service.workloadKind,
      url: service.url,
      customDomains: service.customDomains,
      customDomainStatus: service.customDomainStatus,
      source: service.source,
      sourceState: service.sourceState,
      envVarKeys: service.envVarKeys,
      status: service.status,
      config: service.config,
    })),
    databases: observed.databases,
    caches: observed.caches ?? [],
    storage: observed.storage ?? [],
    completeness: observed.completeness,
    partial: observed.partial,
    warnings: observed.warnings,
  };
}

export async function inspectProvider(
  ctx: CommandContext,
  input: InspectProviderInput
): Promise<Record<string, unknown>> {
  if (!input.provider) {
    const selectors = Object.entries(input)
      .filter(([field, value]) => field !== 'provider' && value !== undefined)
      .map(([field]) => field);
    if (selectors.length > 0) {
      throw new HvError('VALIDATION', 'provider is required when inspection selectors are supplied.', {
        details: { selectors },
        hint: 'Use hv_inspect({}) with no parameters for provider discovery. Every bounded request requires provider; full live environment inspection requires provider, project, and env.',
      });
    }
    return listProviders(ctx);
  }

  const providerName = input.provider.trim().toLowerCase();
  const registered = providerRegistry.get(providerName);
  if (!registered) {
    throw new HvError('VALIDATION', `Unknown provider "${input.provider}".`, {
      details: { providers: providerRegistry.names() },
      hint: 'Call hv_inspect({}) with no parameters to list registered providers and their supported resource reads.',
    });
  }

  const resources = advertisedResources(providerName);
  if (input.resource && !resources.includes(input.resource)) {
    throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} does not support inspection resource "${input.resource}".`, {
      details: { resources },
      hint: `Call hv_inspect provider="${providerName}" without resource selectors to inspect its default resource, or choose one of the advertised resources.`,
    });
  }
  if (input.env && !input.project) {
    throw new HvError('VALIDATION', 'project is required when env is supplied.', {
      hint: 'Pass both project and env to inspect a Hypervibe environment.',
    });
  }

  const project = input.project
    ? ctx.repos.projects.findById(input.project) ?? ctx.repos.projects.findByName(input.project)
    : null;
  if (input.project && !project) {
    throw new HvError('NOT_FOUND', `Hypervibe project "${input.project}" not found.`, {
      hint: 'Omit project to inspect a provider account directly, or pass an existing Hypervibe project id/name.',
    });
  }
  const environment = input.env && project
    ? ctx.repos.environments.findByProjectAndName(project.id, input.env)
    : null;
  if (input.env && !environment) {
    throw new HvError('NOT_FOUND', `Environment "${input.env}" not found.`, {
      hint: 'Pass both project and an existing environment name.',
    });
  }
  const hostingForensics = Boolean(
    environment
    && providerRegistry.supports(providerName, 'hosting')
    && (!input.resource || input.resource === 'environment')
    && hostingProvider(environment) !== providerName
  );
  const hostingEnvironmentInspection = Boolean(
    environment
    && providerRegistry.supports(providerName, 'hosting')
    && (!input.resource || input.resource === 'environment')
  );
  const providerInspection = registered.inspection;
  const defaultInspectionResource = providerInspection?.defaultResource ?? providerInspection?.resources[0];
  const defaultInspectionContract = defaultInspectionResource
    ? providerInspection?.selectors[defaultInspectionResource]
    : undefined;
  const inspectionResource = hostingForensics
    ? 'environment'
    : input.resource
      ?? (!environment && defaultInspectionResource && defaultInspectionContract
        && contractRequirementsSatisfied(defaultInspectionContract, input)
        ? defaultInspectionResource
        : undefined);

  if (input.resource === 'connection') {
    const invalid = [
      input.env !== undefined ? 'env' : undefined,
      input.id !== undefined ? 'id' : undefined,
      input.name !== undefined ? 'name' : undefined,
      input.region !== undefined ? 'region' : undefined,
      input.limit !== undefined ? 'limit' : undefined,
    ].filter((field): field is string => Boolean(field));
    if (invalid.length > 0) {
      const corrected = { ...input };
      for (const field of invalid) delete corrected[field as keyof InspectProviderInput];
      throw recoverableSelectorError({
        message: 'Connection inspection does not accept resource selectors.',
        input,
        corrected,
        details: { invalid },
        hint: 'Use only provider, project, scope, and resource="connection"; the suggested call removes unsupported selectors.',
      });
    }
  }

  if (environment && input.resource && !ENVIRONMENT_INSPECTION_RESOURCES.has(input.resource)) {
    throw new HvError('VALIDATION', `env cannot be combined with provider resource "${input.resource}".`, {
      hint: 'Remove env for provider-owned resource inspection, or select environment, database, cache, or storage.',
    });
  }

  if (environment) {
    const supportsRegion = contractAcceptsSelector(
      providerInspection?.selectors.environment,
      'region'
    );
    const invalid = (input.resource === 'storage'
      ? [input.region !== undefined ? 'region' : undefined]
      : [
        input.id !== undefined ? 'id' : undefined,
        (!input.resource || input.resource === 'environment') && input.name !== undefined ? 'name' : undefined,
        input.limit !== undefined && !hostingForensics ? 'limit' : undefined,
        input.region !== undefined && (
          !hostingEnvironmentInspection
          || !supportsRegion
          || input.resource === 'database'
          || input.resource === 'cache'
        ) ? 'region' : undefined,
      ]).filter((field): field is string => Boolean(field));
    if (invalid.length > 0) {
      const corrected = { ...input };
      for (const field of invalid) delete corrected[field as keyof InspectProviderInput];
      throw recoverableSelectorError({
        message: 'Live environment inspection received unsupported selectors.',
        input,
        corrected,
        details: { invalid },
        hint: input.resource
          ? 'Use only selectors supported by the selected environment resource.'
          : 'Use provider, project, and env for a full environment observation, or add an explicit resource before filtering it.',
      });
    }
  }

  if (!environment && inspectionResource && inspectionResource !== 'connection' && providerInspection) {
    const contract = providerInspection.selectors[inspectionResource];
    if (!contract) {
      throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} did not declare selectors for inspection resource "${inspectionResource}".`, {
        details: { inspectionModes: advertisedInspectionModes(providerName) },
        hint: 'Treat this as an adapter contract failure; no provider state was changed.',
      });
    }
    validateProviderSelectorContract({ input, resource: inspectionResource, contract });
  }
  if (!environment && !inspectionResource && (!input.resource || input.resource === 'connection')) {
    const invalid = [
      input.id !== undefined ? 'id' : undefined,
      input.name !== undefined ? 'name' : undefined,
      input.limit !== undefined ? 'limit' : undefined,
    ].filter((field): field is string => Boolean(field));
    if (invalid.length > 0) {
      const corrected = { ...input };
      for (const field of invalid) delete corrected[field as keyof InspectProviderInput];
      throw recoverableSelectorError({
        message: 'Connection inspection does not accept provider resource selectors.',
        input,
        corrected,
        details: { invalid },
        hint: 'The suggested call removes id, name, and limit because this provider exposes connection verification only.',
      });
    }
  }

  const projectHints = project ? getProjectScopeHints(project) : [];
  const scopeHints = input.scope
    ? [input.scope, ...projectHints.filter((hint) => hint !== input.scope)]
    : projectHints;
  const requestedScope = input.scope
    ?? projectHints.find((hint) => !hint.includes('://') && !hint.includes('github.com/'));
  const resolved = await ctx.adapterFactory.getProviderAdapter(
    providerName,
    project ?? undefined,
    scopeHints
  );
  if (!resolved.success || !resolved.adapter) {
    throw new HvError('MISSING_CONNECTION', resolved.error ?? `No ${providerName} connection configured.`, {
      ...connectionSetupOptions(providerName, { project: project?.name, scope: requestedScope }),
    });
  }

  const adapter = resolved.adapter as unknown as Record<string, unknown>;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const currentHostingProvider = environment ? hostingProvider(environment) : undefined;
  const datastoreInspectionResource = inspectionResource
    ?? input.resource
    ?? (environment && registered.metadata.category === 'database'
      ? 'database'
      : environment && registered.metadata.category === 'cache'
        ? 'cache'
        : undefined);
  const datastoreInspection = datastoreInspectionResource === 'database'
    || datastoreInspectionResource === 'cache';
  const request: ProviderInspectionRequest = {
    scope: requestedScope,
    resource: inspectionResource,
    id: input.id,
    name: input.name,
    region: input.region,
    limit,
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
    ...(project ? { serviceNames: ctx.repos.services.findByProjectId(project.id).map((service) => service.name) } : {}),
    ...(environment
      ? {
          environment: {
            id: environment.id,
            projectId: environment.projectId,
            name: environment.name,
          },
          binding: datastoreInspection
            ? compatibleDatastoreHostingBinding(
              environment,
              providerName,
              datastoreInspectionResource
            )
            : hostingBindingForProvider(environment, providerName),
        }
      : {}),
  };

  try {
    if (input.region && hostingEnvironmentInspection) {
      const configureTarget = adapter.configureTarget;
      if (typeof configureTarget !== 'function') {
        throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} does not support explicit regional inspection.`, {
          hint: 'Remove region, or use a provider connection/binding already scoped to the intended location.',
        });
      }
      await (configureTarget as (target: { region: string }) => void | Promise<void>)
        .call(resolved.adapter, { region: input.region });
    }
    const useProviderInspection = input.resource !== 'connection'
      && Boolean(providerInspection)
      && Boolean(inspectionResource && providerInspection!.resources.includes(inspectionResource))
      && (!environment || hostingForensics);
    if (useProviderInspection && providerInspection) {
      const inspected = await providerInspection.inspect(resolved.adapter, request);
      if (inspectionResource && inspected.resource !== inspectionResource) {
        throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} returned the wrong inspection resource.`, {
          details: { requested: inspectionResource, returned: inspected.resource ?? null },
          hint: 'Treat this as an adapter contract failure; no provider state was changed.',
        });
      }
      if (inspectionResource) {
        validateStatefulInspectionResult({
          providerDisplayName: registered.metadata.displayName,
          resource: inspectionResource,
          contract: providerInspection.selectors[inspectionResource]!,
          result: inspected,
          limit: request.limit,
        });
      }
      if (inspected.observation === 'ambiguous') {
        throw new HvError('VALIDATION', `Multiple ${registered.metadata.displayName} resources matched "${input.name ?? input.id ?? 'the selector'}".`, {
          details: inspected,
          hint: 'Re-run hv_inspect with the exact durable provider id. Hypervibe will not guess between duplicate resources.',
          next: ['hv_inspect'],
        });
      }
      if (hostingForensics && environment) {
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'environment-forensics',
          project: project?.name,
          environment: environment.name,
          currentHostingProvider: currentHostingProvider ?? null,
          retainedBinding: Boolean(request.binding),
          inspected,
        };
      }
      return {
        provider: providerName,
        category: registered.metadata.category,
        mode: 'provider-resource',
        inspected: true,
        imported: false,
        ...inspected,
      };
    }

    if (hostingForensics && environment) {
      throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} cannot inspect an environment after a hosting-provider migration.`, {
        details: { resources, currentHostingProvider: currentHostingProvider ?? null },
        hint: 'The provider must implement provider-scoped environment forensics; Hypervibe will not pass another platform\'s bindings into its observe method.',
      });
    }

    if (environment) {
      const standardResource = input.resource;
      const observe = adapter.observe;
      if ((!standardResource || standardResource === 'environment') && typeof observe === 'function') {
        const observed = await (observe as (environment: Environment) => Promise<ObservedState>)
          .call(resolved.adapter, environment);
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'environment',
          project: project?.name,
          environment: environment.name,
          observed: boundedObservation(observed),
        };
      }

      const componentResource = input.resource === 'database' || input.resource === 'cache'
        ? input.resource
        : registered.metadata.category === 'database' || registered.metadata.category === 'cache'
          ? registered.metadata.category
          : undefined;
      const component = componentForProvider(ctx, environment, providerName, componentResource);
      const observeDatabase = adapter.observeDatabase;
      const databaseInventoryContract = providerInspection?.selectors.database;
      if (
        (standardResource === 'database' || !standardResource)
        && !component
        && databaseInventoryContract?.mode === 'provider-resource'
        && providerInspection?.resources.includes('database')
      ) {
        const inspected = await providerInspection.inspect(resolved.adapter, {
          scope: request.scope,
          resource: 'database',
          id: request.id,
          name: request.name,
          limit: request.limit,
          ...(request.project ? { project: request.project } : {}),
          ...(request.environment ? { environment: request.environment } : {}),
          ...(request.binding ? { binding: request.binding } : {}),
        });
        if (inspected.resource !== 'database') {
          throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} returned the wrong inspection resource.`, {
            details: { requested: 'database', returned: inspected.resource ?? null },
            hint: 'Treat this as an adapter contract failure; no provider state was changed.',
          });
        }
        validateStatefulInspectionResult({
          providerDisplayName: registered.metadata.displayName,
          resource: 'database',
          contract: databaseInventoryContract,
          result: inspected,
          limit: request.limit,
        });
        if (inspected.observation === 'ambiguous') {
          throw new HvError('VALIDATION', `Multiple ${registered.metadata.displayName} databases matched "${input.name ?? 'the selector'}".`, {
            details: inspected,
            hint: 'Re-run hv_inspect without env and with the exact durable provider id. Hypervibe will not guess or adopt a candidate.',
            next: ['hv_inspect'],
          });
        }
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'database',
          project: project?.name,
          environment: environment.name,
          observed: null,
          binding: 'missing',
          inventory: inspected,
          warning: 'These are provider-account candidates, not environment attribution. Generic database adoption is not implemented; hv_import mode="retained-database-cleanup" can retain one freshly inspected exact ID only for confirmation-gated deletion. Hypervibe did not select a database.',
        };
      }
      if ((standardResource === 'database' || !standardResource) && typeof observeDatabase === 'function') {
        const observed = await (observeDatabase as (
          environment: Environment,
          component?: Component | null,
          options?: { resourceName?: string }
        ) => Promise<unknown>).call(resolved.adapter, environment, component, { resourceName: input.name });
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'database',
          project: project?.name,
          environment: environment.name,
          observed,
        };
      }

      const observeCache = adapter.observeCache;
      if ((standardResource === 'cache' || !standardResource) && typeof observeCache === 'function') {
        const observed = await (observeCache as (
          environment: Environment,
          component?: Component | null,
          options?: { resourceName?: string }
        ) => Promise<unknown>).call(resolved.adapter, environment, component, { resourceName: input.name });
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'cache',
          project: project?.name,
          environment: environment.name,
          observed,
        };
      }

      if (standardResource === 'storage' && typeof observe === 'function') {
        const observed = await (observe as (environment: Environment) => Promise<ObservedState>)
          .call(resolved.adapter, environment);
        const storage = (observed.storage ?? [])
          .filter((item) => !input.id || item.externalId === input.id)
          .filter((item) => !input.name || item.name === input.name)
          .slice(0, limit);
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'storage',
          project: project?.name,
          environment: environment.name,
          observed: {
            storage,
            completeness: observed.completeness?.storage ?? 'unknown',
            partial: observed.partial,
            warnings: observed.warnings,
          },
        };
      }
      throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} cannot inspect a live Hypervibe environment.`, {
        details: { resources },
        hint: 'Use one of the advertised provider resources without env, or use hv_status for desired-state drift.',
      });
    }

    if (input.resource && input.resource !== 'connection') {
      throw new HvError('VALIDATION', `resource="${input.resource}" requires project and env for environment observation.`, {
        hint: 'Pass an existing Hypervibe project and environment, or choose a provider-owned resource advertised by hv_inspect.',
      });
    }

    if (!registered.inspection) {
      const invalid = [
        input.id !== undefined ? 'id' : undefined,
        input.name !== undefined ? 'name' : undefined,
        input.limit !== undefined ? 'limit' : undefined,
      ].filter((field): field is string => Boolean(field));
      if (invalid.length > 0) {
        const corrected = { ...input };
        for (const field of invalid) delete corrected[field as keyof InspectProviderInput];
        throw recoverableSelectorError({
          message: 'Connection inspection does not accept provider resource selectors.',
          input,
          corrected,
          details: { invalid },
          hint: 'The suggested call removes id, name, and limit because this provider exposes connection verification only.',
        });
      }
    }

    const verify = adapter.verify;
    if (typeof verify !== 'function') {
      throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} does not expose a read-only inspection contract.`, {
        details: { resources: advertisedResources(providerName) },
        hint: 'Use hv_status for desired-state drift, or add a provider-owned inspection capability before exposing provider-specific reads here.',
      });
    }
    const verification = await (verify as () => Promise<Record<string, unknown>>).call(resolved.adapter);
    if (verification.success === false) {
      throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} connection verification failed.`, {
        details: verification,
        hint: 'Check the recorded connection scope and provider read permissions before retrying.',
        next: ['hv_connections'],
      });
    }
    return {
      provider: providerName,
      category: registered.metadata.category,
      mode: 'connection',
      verification,
      resources: advertisedResources(providerName),
      inspectionModes: advertisedInspectionModes(providerName),
    };
  } catch (error) {
    if (error instanceof HvError) throw error;
    throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} inspection failed.`, {
      details: { reason: error instanceof Error ? error.message : String(error) },
      hint: 'Check the recorded connection scope and provider read permissions before retrying.',
    });
  } finally {
    const disconnect = adapter.disconnect;
    if (typeof disconnect === 'function') {
      await (disconnect as () => Promise<void>).call(resolved.adapter);
    }
  }
}
