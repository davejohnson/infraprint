import { createHash } from 'crypto';
import { z } from 'zod';
import { parse as parseDomain } from 'tldts';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type {
  ILoadBalancerAdapter,
  LoadBalancerMonitor,
  LoadBalancerOrigin,
  LoadBalancerPool,
  LoadBalancerScope,
  ManagedLoadBalancer,
} from '../ports/load-balancer.port.js';
import { supportsLoadBalancer } from '../ports/load-balancer.port.js';
import type { ObservedState } from '../ports/observe.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { dnsZoneScopeForDomain } from './domain-scope.js';
import { getProjectScopeHints } from './project-scope.js';

export const LOAD_BALANCER_OPERATIONS = {
  monitorEnsure: 'loadBalancerMonitorEnsure',
  poolEnsure: 'loadBalancerPoolEnsure',
  ensure: 'loadBalancerEnsure',
  destroy: 'loadBalancerDestroy',
  poolDestroy: 'loadBalancerPoolDestroy',
  monitorDestroy: 'loadBalancerMonitorDestroy',
} as const;

const LOAD_BALANCER_OPERATION_SET = new Set<string>(Object.values(LOAD_BALANCER_OPERATIONS));
const envRepo = new EnvironmentRepository();

export interface LoadBalancerBinding {
  provider: string;
  hostname: string;
  accountId: string;
  zoneId: string;
  configHash: string;
  monitor?: { id: string; name: string };
  pool?: { id: string; name: string };
  loadBalancer?: { id: string };
  updatedAt?: string;
}

const loadBalancerBindingSchema = z.object({
  provider: z.string().min(1),
  hostname: z.string().min(1),
  accountId: z.string().min(1),
  zoneId: z.string().min(1),
  configHash: z.string().min(1),
  monitor: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict().optional(),
  pool: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict().optional(),
  loadBalancer: z.object({ id: z.string().min(1) }).strict().optional(),
  updatedAt: z.string().optional(),
}).strict().refine(
  (binding) => Boolean(binding.monitor || binding.pool || binding.loadBalancer),
  'a load-balancer binding must contain at least one durable provider id'
);

type ActionResult = {
  success: boolean;
  status?: 'blocked' | 'pending';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseLoadBalancerBinding(
  environment: Pick<Environment, 'platformBindings'> | null
): LoadBalancerBinding | undefined {
  const value = asRecord(environment?.platformBindings.loadBalancer);
  if (!value) return undefined;
  const parsed = loadBalancerBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function loadBalancerConfigHash(environmentSpec: EnvironmentSpec): string | undefined {
  const spec = environmentSpec.loadBalancer;
  const hostname = environmentSpec.domain?.trim().replace(/\.$/, '').toLowerCase();
  if (!spec || !hostname) return undefined;
  return createHash('sha256').update(JSON.stringify({
    provider: spec.provider,
    hostname,
    services: [...spec.services].sort(),
    healthCheckPath: spec.healthCheckPath,
  })).digest('hex');
}

function externalResourceName(environmentName: string, hostname: string, suffix: 'monitor' | 'pool'): string {
  const hash = createHash('sha256').update(`${environmentName}:${hostname}`).digest('hex').slice(0, 8);
  const slug = `${environmentName}-${hostname}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const tail = `-${hash}-${suffix}`;
  return `hv-${slug}`.slice(0, Math.max(3, 50 - tail.length)).replace(/-+$/g, '') + tail;
}

function loadBalancerScopeHints(hostname: string, project: Project): string[] {
  return Array.from(new Set([
    dnsZoneScopeForDomain(hostname),
    hostname,
    ...getProjectScopeHints(project),
  ].filter(Boolean)));
}

function desiredMonitor(name: string, path: string): Omit<LoadBalancerMonitor, 'id'> {
  return {
    name,
    type: 'https',
    path,
    intervalSeconds: 60,
    timeoutSeconds: 5,
    expectedCodes: '200-399',
    followRedirects: true,
  };
}

function monitorMatches(actual: LoadBalancerMonitor, desired: Omit<LoadBalancerMonitor, 'id'>): boolean {
  return actual.name === desired.name
    && actual.type === desired.type
    && actual.path === desired.path
    && actual.intervalSeconds === desired.intervalSeconds
    && actual.timeoutSeconds === desired.timeoutSeconds
    && actual.expectedCodes === desired.expectedCodes
    && actual.followRedirects === desired.followRedirects;
}

function normalizedOrigins(origins: LoadBalancerOrigin[]): LoadBalancerOrigin[] {
  return [...origins].sort((left, right) => left.name.localeCompare(right.name));
}

function originsConfigHash(origins: LoadBalancerOrigin[]): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizedOrigins(origins)))
    .digest('hex');
}

function publicOriginHostname(value: string): string | undefined {
  const hostname = value.trim().toLowerCase().replace(/\.+$/, '');
  const domain = parseDomain(hostname, {
    allowPrivateDomains: true,
    detectSpecialUse: true,
  });
  return hostname
    && value === hostname
    && domain.hostname === hostname
    && !domain.isIp
    && !domain.isSpecialUse
    && (domain.isIcann === true || domain.isPrivate === true)
    ? hostname
    : undefined;
}

function parseReviewedOrigins(value: unknown): LoadBalancerOrigin[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const origins: LoadBalancerOrigin[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (
      !record
      || typeof record.name !== 'string'
      || typeof record.address !== 'string'
      || typeof record.hostHeader !== 'string'
      || record.enabled !== true
    ) return null;
    const address = publicOriginHostname(record.address);
    const hostHeader = publicOriginHostname(record.hostHeader);
    if (!record.name || !address || hostHeader !== address) return null;
    origins.push({
      name: record.name,
      address,
      hostHeader,
      enabled: true,
    });
  }
  if (
    new Set(origins.map((origin) => origin.name)).size !== origins.length
    || new Set(origins.map((origin) => origin.address)).size !== origins.length
  ) return null;
  return normalizedOrigins(origins);
}

function poolMatches(actual: LoadBalancerPool, desired: Omit<LoadBalancerPool, 'id'>): boolean {
  return actual.name === desired.name
    && actual.monitorId === desired.monitorId
    && actual.enabled === desired.enabled
    && actual.steering === desired.steering
    && JSON.stringify(normalizedOrigins(actual.origins)) === JSON.stringify(normalizedOrigins(desired.origins));
}

function loadBalancerMatches(actual: ManagedLoadBalancer, desired: Omit<ManagedLoadBalancer, 'id'>): boolean {
  return actual.hostname.toLowerCase() === desired.hostname.toLowerCase()
    && actual.poolId === desired.poolId
    && actual.fallbackPoolId === desired.fallbackPoolId
    && actual.enabled === desired.enabled
    && actual.proxied === desired.proxied
    && actual.steering === desired.steering;
}

function action(params: {
  id: string;
  type: PlanAction['type'];
  hostname: string;
  provider: string;
  operation: string;
  reason: string;
  verified: boolean;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  billable?: boolean;
  requiresConfirm?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'load-balancer', name: params.hostname, provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    ...(params.billable ? { billable: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    metadata: {
      operation: params.operation,
      hostname: params.hostname,
      ...(params.metadata ?? {}),
    },
  };
}

function blockedAction(params: {
  hostname: string;
  provider: string;
  reason: string;
  blockedReason: string;
  metadata?: Record<string, unknown>;
}): PlanAction {
  return action({
    id: `load-balancer:${params.hostname}`,
    type: 'update',
    hostname: params.hostname,
    provider: params.provider,
    operation: LOAD_BALANCER_OPERATIONS.ensure,
    reason: params.reason,
    verified: false,
    metadata: { blockedReason: params.blockedReason, ...(params.metadata ?? {}) },
  });
}

function originFromUrl(serviceName: string, url: string | undefined): LoadBalancerOrigin | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (
      parsed.protocol !== 'https:'
      || !publicOriginHostname(hostname)
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== '443')
      || (parsed.pathname && parsed.pathname !== '/')
      || parsed.search
      || parsed.hash
    ) return undefined;
    return {
      name: serviceName,
      address: hostname,
      hostHeader: hostname,
      enabled: true,
    };
  } catch {
    return undefined;
  }
}

function desiredOrigins(
  environmentSpec: EnvironmentSpec,
  environment: Environment | null,
  observed: ObservedState | null
): { origins: LoadBalancerOrigin[]; missing: string[]; duplicates: string[] } {
  const bindings = parseHostingBindings(environment);
  const origins: LoadBalancerOrigin[] = [];
  const missing: string[] = [];
  for (const serviceName of environmentSpec.loadBalancer?.services ?? []) {
    const observedUrl = observed?.services.find((service) => service.name === serviceName)?.url;
    const origin = originFromUrl(serviceName, observedUrl ?? bindings.services?.[serviceName]?.url);
    if (origin) origins.push(origin);
    else missing.push(serviceName);
  }
  const servicesByAddress = new Map<string, string[]>();
  for (const origin of origins) {
    const services = servicesByAddress.get(origin.address) ?? [];
    services.push(origin.name);
    servicesByAddress.set(origin.address, services);
  }
  const duplicates = [...servicesByAddress.values()]
    .filter((services) => services.length > 1)
    .flat()
    .sort();
  return { origins, missing, duplicates };
}

async function observeByIdentity<T>(params: {
  externalId?: string;
  get: (id: string) => Promise<T | null>;
  find: () => Promise<T[]>;
}): Promise<{ resource: T | null; candidates: T[] }> {
  if (params.externalId) {
    return { resource: await params.get(params.externalId), candidates: [] };
  }
  const candidates = await params.find();
  return { resource: null, candidates };
}

export async function planLoadBalancer(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
  serviceActions: PlanAction[];
}): Promise<{
  actions: PlanAction[];
  warnings: string[];
  unmanaged: Array<{ kind: 'load-balancer'; name: string; detail?: string }>;
}> {
  const { project, environmentName, environmentSpec, environment, observed } = params;
  const desired = environmentSpec.loadBalancer;
  const binding = parseLoadBalancerBinding(environment);
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const unmanaged: Array<{ kind: 'load-balancer'; name: string; detail?: string }> = [];
  const rawBinding = asRecord(environment?.platformBindings.loadBalancer);
  if (rawBinding && !binding) {
    const invalidHostname = (environmentSpec.domain
      ?? (typeof rawBinding.hostname === 'string' ? rawBinding.hostname : 'unknown-load-balancer'))
      .trim().replace(/\.$/, '').toLowerCase();
    const invalidProvider = desired?.provider
      ?? (typeof rawBinding.provider === 'string' && rawBinding.provider ? rawBinding.provider : 'unknown');
    return {
      actions: [blockedAction({
        hostname: invalidHostname,
        provider: invalidProvider,
        reason: 'The durable load-balancer binding is malformed; refusing provider mutations',
        blockedReason: 'load_balancer_binding_invalid',
      })],
      warnings,
      unmanaged,
    };
  }
  const hostname = (environmentSpec.domain ?? binding?.hostname ?? '').trim().replace(/\.$/, '').toLowerCase();
  const provider = desired?.provider ?? binding?.provider;
  if (!provider || !hostname) return { actions, warnings, unmanaged };

  if (desired && binding && (binding.provider !== desired.provider || binding.hostname !== hostname)) {
    actions.push(blockedAction({
      hostname,
      provider: desired.provider,
      reason: 'Changing a managed load balancer provider or hostname requires explicit teardown first',
      blockedReason: 'load_balancer_replacement_required',
    }));
    return { actions, warnings, unmanaged };
  }

  const adapterResult = await adapterFactory.getLoadBalancerAdapter(
    provider,
    project,
    loadBalancerScopeHints(hostname, project)
  );
  if (!adapterResult.success) {
    actions.push(blockedAction({
      hostname,
      provider,
      reason: `Cannot resolve the ${provider} load-balancer adapter: ${adapterResult.error ?? 'adapter unavailable'}`,
      blockedReason: 'load_balancer_adapter_unavailable',
    }));
    return { actions, warnings, unmanaged };
  }
  if (!supportsLoadBalancer(adapterResult.adapter)) {
    actions.push(blockedAction({
      hostname,
      provider,
      reason: `${provider} does not expose load-balancer lifecycle operations`,
      blockedReason: 'load_balancer_unsupported',
    }));
    return { actions, warnings, unmanaged };
  }
  const adapter = adapterResult.adapter;

  if (!desired && binding) {
    return planLoadBalancerDestroy({ adapter, binding, hostname });
  }
  if (!desired) return { actions, warnings, unmanaged };

  // A monitor is harmless in isolation, but it is still a provider mutation
  // authorized by this load-balancer declaration. Validate the entire origin
  // boundary before planning any part of the topology so an invalid/private
  // or not-yet-observed origin cannot create a monitor and leave partial,
  // potentially billable infrastructure behind.
  const originResolution = desiredOrigins(environmentSpec, environment, observed);
  const serviceActionByName = new Map(params.serviceActions.map((serviceAction) => [serviceAction.resource.name, serviceAction]));
  const unstableOrigins = desired.services.filter((serviceName) => {
    const serviceAction = serviceActionByName.get(serviceName);
    return serviceAction?.type === 'create' || serviceAction?.type === 'replace';
  });
  const unavailableOrigins = Array.from(new Set([
    ...originResolution.missing,
    ...originResolution.duplicates,
    ...unstableOrigins,
  ])).sort();
  if (unavailableOrigins.length > 0) {
    const duplicateOrigins = originResolution.duplicates.length > 0;
    return {
      actions: [blockedAction({
        hostname,
        provider,
        reason: duplicateOrigins
          ? `Load-balancer services must resolve to distinct public HTTPS origins: ${originResolution.duplicates.join(', ')}`
          : `Cannot resolve stable public HTTPS origin URLs for services: ${unavailableOrigins.join(', ')}`,
        blockedReason: duplicateOrigins
          ? 'load_balancer_origin_url_duplicate'
          : 'load_balancer_origin_url_missing_or_invalid',
      })],
      warnings,
      unmanaged,
    };
  }

  const configHash = loadBalancerConfigHash(environmentSpec)!;
  const monitorName = externalResourceName(environmentName, hostname, 'monitor');
  const poolName = externalResourceName(environmentName, hostname, 'pool');
  let scope: LoadBalancerScope;
  let monitorObservation: { resource: LoadBalancerMonitor | null; candidates: LoadBalancerMonitor[] };
  let poolObservation: { resource: LoadBalancerPool | null; candidates: LoadBalancerPool[] };
  let loadBalancerObservation: { resource: ManagedLoadBalancer | null; candidates: ManagedLoadBalancer[] };
  try {
    scope = await adapter.resolveLoadBalancerScope(hostname);
    if (binding && (binding.accountId !== scope.accountId || binding.zoneId !== scope.zoneId)) {
      actions.push(blockedAction({
        hostname,
        provider,
        reason: `The live ${provider} scope no longer matches the durable load-balancer binding`,
        blockedReason: 'load_balancer_scope_mismatch',
      }));
      return { actions, warnings, unmanaged };
    }
    monitorObservation = await observeByIdentity({
      externalId: binding?.monitor?.id,
      get: (id) => adapter.getMonitor(scope.accountId, id),
      find: () => adapter.findMonitorsByName(scope.accountId, monitorName),
    });
    poolObservation = await observeByIdentity({
      externalId: binding?.pool?.id,
      get: (id) => adapter.getPool(scope.accountId, id),
      find: () => adapter.findPoolsByName(scope.accountId, poolName),
    });
    loadBalancerObservation = await observeByIdentity({
      externalId: binding?.loadBalancer?.id,
      get: (id) => adapter.getLoadBalancer(scope.zoneId, id),
      find: () => adapter.findLoadBalancersByHostname(scope.zoneId, hostname),
    });
  } catch (error) {
    actions.push(blockedAction({
      hostname,
      provider,
      reason: `Cannot safely observe ${provider} load-balancer resources`,
      blockedReason: 'load_balancer_observation_unknown',
      metadata: { observationError: error instanceof Error ? error.message : String(error) },
    }));
    return { actions, warnings, unmanaged };
  }

  const conflicts = [
    { label: 'monitor', candidates: monitorObservation.candidates },
    { label: 'pool', candidates: poolObservation.candidates },
    { label: 'load balancer', candidates: loadBalancerObservation.candidates },
  ].filter((entry) => entry.candidates.length > 0);
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      unmanaged.push({
        kind: 'load-balancer',
        name: hostname,
        detail: `${conflict.candidates.length} matching ${provider} ${conflict.label} resource(s) conflict with desired state; V1 load-balancer adoption is not supported`,
      });
    }
    actions.push(blockedAction({
      hostname,
      provider,
      reason: `Matching ${provider} load-balancer resources exist without durable Hypervibe bindings`,
      blockedReason: conflicts.some((entry) => entry.candidates.length > 1)
        ? 'ambiguous_load_balancer_identity'
        : 'load_balancer_adoption_required',
    }));
    return { actions, warnings, unmanaged };
  }

  const metadata = {
    configHash,
    accountId: scope.accountId,
    zoneId: scope.zoneId,
  };
  const wantedMonitor = desiredMonitor(monitorName, desired.healthCheckPath);
  const actualMonitor = monitorObservation.resource;
  const monitorType: PlanAction['type'] = actualMonitor
    ? monitorMatches(actualMonitor, wantedMonitor) ? 'noop' : 'update'
    : 'create';
  const monitorId = 'load-balancer:monitor';
  actions.push(action({
    id: monitorId,
    type: monitorType,
    hostname,
    provider,
    operation: LOAD_BALANCER_OPERATIONS.monitorEnsure,
    verified: true,
    reason: monitorType === 'noop'
      ? 'Load-balancer health monitor is in sync'
      : monitorType === 'create'
        ? 'Create the load-balancer health monitor'
        : 'Update the load-balancer health monitor',
    metadata: {
      ...metadata,
      externalName: monitorName,
      ...(binding?.monitor?.id ? { externalId: binding.monitor.id } : {}),
    },
  }));

  const actualPool = poolObservation.resource;
  const desiredMonitorId = actualMonitor?.id ?? binding?.monitor?.id ?? '';
  const wantedPool: Omit<LoadBalancerPool, 'id'> = {
    name: poolName,
    monitorId: desiredMonitorId,
    origins: originResolution.origins,
    enabled: true,
    steering: 'random',
  };
  const poolType: PlanAction['type'] = actualPool
    ? monitorType !== 'create'
      && poolMatches(actualPool, wantedPool)
      ? 'noop'
      : 'update'
    : 'create';
  const poolId = 'load-balancer:pool';
  actions.push(action({
    id: poolId,
    type: poolType,
    hostname,
    provider,
    operation: LOAD_BALANCER_OPERATIONS.poolEnsure,
    verified: true,
    reason: poolType === 'noop'
        ? 'Load-balancer origin pool is in sync'
        : poolType === 'create'
          ? 'Create the load-balancer origin pool'
          : 'Update the load-balancer origin pool',
    dependsOn: [monitorId, ...desired.services.map((serviceName) => `service:${serviceName}`)],
    billable: poolType !== 'noop',
    metadata: {
      ...metadata,
      externalName: poolName,
      services: desired.services,
      origins: normalizedOrigins(originResolution.origins),
      originsHash: originsConfigHash(originResolution.origins),
      ...(binding?.pool?.id ? { externalId: binding.pool.id } : {}),
    },
  }));

  const actualLoadBalancer = loadBalancerObservation.resource;
  const desiredPoolId = actualPool?.id ?? binding?.pool?.id ?? '';
  const wantedLoadBalancer: Omit<ManagedLoadBalancer, 'id'> = {
    hostname,
    poolId: desiredPoolId,
    fallbackPoolId: desiredPoolId,
    enabled: true,
    proxied: true,
    steering: 'off',
  };
  const loadBalancerType: PlanAction['type'] = actualLoadBalancer
    ? poolType !== 'create' && loadBalancerMatches(actualLoadBalancer, wantedLoadBalancer)
      ? 'noop'
      : 'update'
    : 'create';
  actions.push(action({
    id: `load-balancer:${hostname}`,
    type: loadBalancerType,
    hostname,
    provider,
    operation: LOAD_BALANCER_OPERATIONS.ensure,
    verified: true,
    reason: loadBalancerType === 'noop'
      ? `Load balancer ${hostname} is in sync`
      : loadBalancerType === 'create'
        ? `Create the public load balancer for ${hostname}`
        : `Update the public load balancer for ${hostname}`,
    dependsOn: [poolId],
    billable: loadBalancerType === 'create',
    metadata: {
      ...metadata,
      services: desired.services,
      ...(binding?.loadBalancer?.id ? { externalId: binding.loadBalancer.id } : {}),
    },
  }));

  if (actions.some((candidate) => candidate.billable)) {
    warnings.push(`${provider} load balancing can incur charges; billable actions require exact confirmation.`);
  }
  return { actions, warnings, unmanaged };
}

async function planLoadBalancerDestroy(params: {
  adapter: ILoadBalancerAdapter;
  binding: LoadBalancerBinding;
  hostname: string;
}): Promise<{
  actions: PlanAction[];
  warnings: string[];
  unmanaged: Array<{ kind: 'load-balancer'; name: string; detail?: string }>;
}> {
  const { adapter, binding, hostname } = params;
  const actions: PlanAction[] = [];
  try {
    if (binding.loadBalancer?.id) await adapter.getLoadBalancer(binding.zoneId, binding.loadBalancer.id);
    if (binding.pool?.id) await adapter.getPool(binding.accountId, binding.pool.id);
    if (binding.monitor?.id) await adapter.getMonitor(binding.accountId, binding.monitor.id);
  } catch (error) {
    return {
      actions: [blockedAction({
        hostname,
        provider: binding.provider,
        reason: 'Load balancer was removed from the spec, but live observation is unknown; refusing teardown',
        blockedReason: 'load_balancer_observation_unknown',
        metadata: { observationError: error instanceof Error ? error.message : String(error) },
      })],
      warnings: [],
      unmanaged: [],
    };
  }

  let previousId: string | undefined;
  if (binding.loadBalancer?.id) {
    previousId = `load-balancer:${hostname}:destroy`;
    actions.push(action({
      id: previousId,
      type: 'destroy',
      hostname,
      provider: binding.provider,
      operation: LOAD_BALANCER_OPERATIONS.destroy,
      verified: true,
      reason: `Load balancer ${hostname} was removed from the spec; deleting it stops public traffic`,
      requiresConfirm: true,
      metadata: {
        externalId: binding.loadBalancer.id,
        accountId: binding.accountId,
        zoneId: binding.zoneId,
        configHash: binding.configHash,
      },
    }));
  }
  if (binding.pool?.id) {
    const id = 'load-balancer:pool:destroy';
    actions.push(action({
      id,
      type: 'destroy',
      hostname,
      provider: binding.provider,
      operation: LOAD_BALANCER_OPERATIONS.poolDestroy,
      verified: true,
      reason: `Delete the retired origin pool for ${hostname}`,
      dependsOn: previousId ? [previousId] : undefined,
      metadata: {
        externalId: binding.pool.id,
        accountId: binding.accountId,
        zoneId: binding.zoneId,
        configHash: binding.configHash,
      },
    }));
    previousId = id;
  }
  if (binding.monitor?.id) {
    actions.push(action({
      id: 'load-balancer:monitor:destroy',
      type: 'destroy',
      hostname,
      provider: binding.provider,
      operation: LOAD_BALANCER_OPERATIONS.monitorDestroy,
      verified: true,
      reason: `Delete the retired health monitor for ${hostname}`,
      dependsOn: previousId ? [previousId] : undefined,
      metadata: {
        externalId: binding.monitor.id,
        accountId: binding.accountId,
        zoneId: binding.zoneId,
        configHash: binding.configHash,
      },
    }));
  }
  return { actions, warnings: [], unmanaged: [] };
}

export function isLoadBalancerAction(planAction: PlanAction): boolean {
  return typeof planAction.metadata?.operation === 'string'
    && LOAD_BALANCER_OPERATION_SET.has(planAction.metadata.operation);
}

function persistBinding(environment: Environment, binding: LoadBalancerBinding | undefined): void {
  envRepo.updatePlatformBindings(environment.id, { loadBalancer: binding });
}

function currentOrigins(environmentSpec: EnvironmentSpec, environment: Environment): LoadBalancerOrigin[] | null {
  const resolved = desiredOrigins(environmentSpec, environment, null);
  return resolved.missing.length === 0 && resolved.duplicates.length === 0
    ? resolved.origins
    : null;
}

export async function applyLoadBalancerAction(params: {
  project: Project;
  envName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const environment = envRepo.findByProjectAndName(params.project.id, params.envName);
  if (!environment) {
    return { success: false, message: 'Environment not found locally', error: `No local environment "${params.envName}"` };
  }
  const binding = parseLoadBalancerBinding(environment);
  const operation = String(params.action.metadata?.operation ?? '');
  const hostname = String(params.action.metadata?.hostname ?? '');
  const desired = params.environmentSpec.loadBalancer;
  const desiredHostname = params.environmentSpec.domain?.trim().replace(/\.$/, '').toLowerCase();
  const configHash = loadBalancerConfigHash(params.environmentSpec);
  const accountId = typeof params.action.metadata?.accountId === 'string'
    ? params.action.metadata.accountId
    : '';
  const zoneId = typeof params.action.metadata?.zoneId === 'string'
    ? params.action.metadata.zoneId
    : '';
  const ensureOperation = new Set<string>([
    LOAD_BALANCER_OPERATIONS.monitorEnsure,
    LOAD_BALANCER_OPERATIONS.poolEnsure,
    LOAD_BALANCER_OPERATIONS.ensure,
  ]).has(operation);
  const currentEnsureExternalId = operation === LOAD_BALANCER_OPERATIONS.monitorEnsure
    ? binding?.monitor?.id
    : operation === LOAD_BALANCER_OPERATIONS.poolEnsure
      ? binding?.pool?.id
      : operation === LOAD_BALANCER_OPERATIONS.ensure
        ? binding?.loadBalancer?.id
        : undefined;
  const reviewedExternalId = typeof params.action.metadata?.externalId === 'string'
    ? params.action.metadata.externalId
    : undefined;
  const ensureExternalIdMatches = params.action.type === 'create'
    ? currentEnsureExternalId
      ? reviewedExternalId === currentEnsureExternalId
      : reviewedExternalId === undefined
    : params.action.type === 'update'
      ? Boolean(currentEnsureExternalId && reviewedExternalId === currentEnsureExternalId)
      : false;
  const expectedExternalName = operation === LOAD_BALANCER_OPERATIONS.monitorEnsure
    ? externalResourceName(params.envName, hostname, 'monitor')
    : operation === LOAD_BALANCER_OPERATIONS.poolEnsure
      ? externalResourceName(params.envName, hostname, 'pool')
      : undefined;
  const ensureExternalNameMatches = expectedExternalName === undefined
    || params.action.metadata?.externalName === expectedExternalName;
  const reviewedOrigins = operation === LOAD_BALANCER_OPERATIONS.poolEnsure
    ? parseReviewedOrigins(params.action.metadata?.origins)
    : null;
  const liveOrigins = operation === LOAD_BALANCER_OPERATIONS.poolEnsure
    ? currentOrigins(params.environmentSpec, environment)
    : null;
  const poolOriginsMatch = operation !== LOAD_BALANCER_OPERATIONS.poolEnsure
    || Boolean(
      reviewedOrigins
      && liveOrigins
      && params.action.metadata?.originsHash === originsConfigHash(reviewedOrigins)
      && JSON.stringify(reviewedOrigins) === JSON.stringify(normalizedOrigins(liveOrigins))
    );
  const identityMatches = params.action.resource.kind === 'load-balancer'
    && params.action.resource.name === hostname
    && (ensureOperation
      ? Boolean(desired && desiredHostname === hostname
        && desired.provider === params.action.resource.provider
        && configHash === params.action.metadata?.configHash
        && ensureExternalIdMatches
        && ensureExternalNameMatches
        && poolOriginsMatch)
      : Boolean(!desired && binding
        && binding.hostname === hostname
        && binding.provider === params.action.resource.provider
        && binding.accountId === accountId
        && binding.zoneId === zoneId
        && binding.configHash === params.action.metadata?.configHash
        && params.action.metadata?.externalId));
  if (!identityMatches) {
    return {
      success: false,
      status: 'blocked',
      message: `Load-balancer action "${params.action.id}" has stale mutation authority`,
      error: 'The reviewed provider, hostname, configuration, operation, or durable provider id no longer matches. Re-run hv_plan.',
    };
  }

  const adapterResult = await adapterFactory.getLoadBalancerAdapter(
    params.action.resource.provider,
    params.project,
    loadBalancerScopeHints(hostname, params.project)
  );
  if (!adapterResult.success || !supportsLoadBalancer(adapterResult.adapter)) {
    return { success: false, status: 'blocked', message: 'Load-balancer adapter unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter;
  if (adapter.name !== params.action.resource.provider) {
    return {
      success: false,
      status: 'blocked',
      message: `Load-balancer action "${params.action.id}" resolved the wrong provider adapter`,
      error: `Plan targets ${params.action.resource.provider}, but the resolved adapter is ${adapter.name}.`,
    };
  }
  if (!accountId || !zoneId) {
    return { success: false, status: 'blocked', message: 'Load-balancer scope is missing', error: 'Re-run hv_plan.' };
  }

  if (ensureOperation) {
    const liveScope = await adapter.resolveLoadBalancerScope(hostname);
    if (liveScope.accountId !== accountId || liveScope.zoneId !== zoneId) {
      return { success: false, status: 'blocked', message: 'Load-balancer scope changed after plan', error: 'Re-run hv_plan.' };
    }
  }

  try {
    if (operation === LOAD_BALANCER_OPERATIONS.monitorEnsure) {
      const externalName = String(params.action.metadata?.externalName ?? '');
      const plannedReplacementId = params.action.type === 'create' ? binding?.monitor?.id : undefined;
      if (plannedReplacementId && await adapter.getMonitor(accountId, plannedReplacementId)) {
        return { success: false, status: 'blocked', message: 'Load-balancer monitor changed after plan', error: 'Re-run hv_plan.' };
      }
      const existingId = params.action.type === 'create' ? undefined : binding?.monitor?.id;
      if (!existingId) {
        const candidates = await adapter.findMonitorsByName(accountId, externalName);
        if (candidates.length > 0) {
          return { success: false, status: 'blocked', message: `Matching ${adapter.name} monitor conflicts with desired state`, error: 'V1 cannot adopt load-balancer resources. Remove or rename the unmanaged monitor, then re-run hv_plan.' };
        }
      }
      const result = await adapter.ensureMonitor(
        accountId,
        desiredMonitor(externalName, desired!.healthCheckPath),
        existingId
      );
      const next: LoadBalancerBinding = {
        ...binding,
        provider: desired!.provider,
        hostname,
        accountId,
        zoneId,
        configHash: configHash!,
        monitor: { id: result.resource.id, name: externalName },
        updatedAt: new Date().toISOString(),
      };
      persistBinding(environment, next);
      if (!result.verified) {
        return {
          success: false,
          status: 'pending',
          message: 'Cloud provider acknowledged the load-balancer monitor write, but exact convergence is not yet verified',
          error: result.verificationError,
          data: { externalId: result.resource.id, recoverableBindingRetained: true },
        };
      }
      return { success: true, message: `${result.created ? 'Created' : 'Updated'} load-balancer health monitor`, data: { externalId: result.resource.id } };
    }

    if (operation === LOAD_BALANCER_OPERATIONS.poolEnsure) {
      if (!binding?.monitor?.id) {
        return { success: false, status: 'blocked', message: 'Load-balancer monitor binding is missing', error: 'Re-run hv_plan.' };
      }
      const origins = liveOrigins;
      if (!origins || !reviewedOrigins) {
        return { success: false, status: 'blocked', message: 'One or more load-balancer origins lack an HTTPS service URL', error: 'Deploy every declared public web service, then re-run hv_plan.' };
      }
      const externalName = String(params.action.metadata?.externalName ?? '');
      const plannedReplacementId = params.action.type === 'create' ? binding.pool?.id : undefined;
      if (plannedReplacementId && await adapter.getPool(accountId, plannedReplacementId)) {
        return { success: false, status: 'blocked', message: 'Load-balancer pool changed after plan', error: 'Re-run hv_plan.' };
      }
      const existingId = params.action.type === 'create' ? undefined : binding.pool?.id;
      if (!existingId) {
        const candidates = await adapter.findPoolsByName(accountId, externalName);
        if (candidates.length > 0) {
          return { success: false, status: 'blocked', message: `Matching ${adapter.name} pool conflicts with desired state`, error: 'V1 cannot adopt load-balancer resources. Remove or rename the unmanaged pool, then re-run hv_plan.' };
        }
      }
      const result = await adapter.ensurePool(accountId, {
        name: externalName,
        monitorId: binding.monitor.id,
        origins: reviewedOrigins,
        enabled: true,
        steering: 'random',
      }, existingId);
      persistBinding(environment, {
        ...binding,
        configHash: configHash!,
        pool: { id: result.resource.id, name: externalName },
        updatedAt: new Date().toISOString(),
      });
      if (!result.verified) {
        return {
          success: false,
          status: 'pending',
          message: 'Cloud provider acknowledged the load-balancer pool write, but exact convergence is not yet verified',
          error: result.verificationError,
          data: { externalId: result.resource.id, recoverableBindingRetained: true },
        };
      }
      return { success: true, message: `${result.created ? 'Created' : 'Updated'} load-balancer origin pool`, data: { externalId: result.resource.id, origins: reviewedOrigins.map((origin) => origin.name) } };
    }

    if (operation === LOAD_BALANCER_OPERATIONS.ensure) {
      if (!binding?.pool?.id) {
        return { success: false, status: 'blocked', message: 'Load-balancer pool binding is missing', error: 'Re-run hv_plan.' };
      }
      const plannedReplacementId = params.action.type === 'create' ? binding.loadBalancer?.id : undefined;
      if (plannedReplacementId && await adapter.getLoadBalancer(zoneId, plannedReplacementId)) {
        return { success: false, status: 'blocked', message: 'Load balancer changed after plan', error: 'Re-run hv_plan.' };
      }
      const existingId = params.action.type === 'create' ? undefined : binding.loadBalancer?.id;
      if (!existingId) {
        const candidates = await adapter.findLoadBalancersByHostname(zoneId, hostname);
        if (candidates.length > 0) {
          return { success: false, status: 'blocked', message: `Matching ${adapter.name} load balancer conflicts with desired state`, error: 'V1 cannot adopt load-balancer resources. Remove the unmanaged hostname load balancer or choose another domain, then re-run hv_plan.' };
        }
      }
      const result = await adapter.ensureLoadBalancer(zoneId, {
        hostname,
        poolId: binding.pool.id,
        fallbackPoolId: binding.pool.id,
        enabled: true,
        proxied: true,
        steering: 'off',
      }, existingId);
      persistBinding(environment, {
        ...binding,
        configHash: configHash!,
        loadBalancer: { id: result.resource.id },
        updatedAt: new Date().toISOString(),
      });
      if (!result.verified) {
        return {
          success: false,
          status: 'pending',
          message: 'Cloud provider acknowledged the public load-balancer write, but exact convergence is not yet verified',
          error: result.verificationError,
          data: { externalId: result.resource.id, recoverableBindingRetained: true },
        };
      }
      return { success: true, message: `${result.created ? 'Created' : 'Updated'} public load balancer ${hostname}`, data: { externalId: result.resource.id, hostname } };
    }

    if (!binding || params.action.metadata?.externalId !== (
      operation === LOAD_BALANCER_OPERATIONS.destroy
        ? binding.loadBalancer?.id
        : operation === LOAD_BALANCER_OPERATIONS.poolDestroy
          ? binding.pool?.id
          : binding.monitor?.id
    )) {
      return { success: false, status: 'blocked', message: 'Load-balancer deletion target changed after plan', error: 'Re-run hv_plan.' };
    }
    if (operation === LOAD_BALANCER_OPERATIONS.destroy) {
      await adapter.deleteLoadBalancer(zoneId, binding.loadBalancer!.id);
      const next = { ...binding, loadBalancer: undefined, updatedAt: new Date().toISOString() };
      persistBinding(environment, next);
      return { success: true, message: `Deleted public load balancer ${hostname}` };
    }
    if (operation === LOAD_BALANCER_OPERATIONS.poolDestroy) {
      await adapter.deletePool(accountId, binding.pool!.id);
      const next = { ...binding, pool: undefined, updatedAt: new Date().toISOString() };
      persistBinding(environment, next);
      return { success: true, message: `Deleted load-balancer origin pool for ${hostname}` };
    }
    if (operation === LOAD_BALANCER_OPERATIONS.monitorDestroy) {
      await adapter.deleteMonitor(accountId, binding.monitor!.id);
      persistBinding(environment, undefined);
      return { success: true, message: `Deleted load-balancer health monitor for ${hostname}` };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to apply load-balancer action ${params.action.id}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { success: false, status: 'blocked', message: 'Unknown load-balancer operation', error: operation };
}
