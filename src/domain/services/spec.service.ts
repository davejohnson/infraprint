import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { buildDatabaseEnvVarsFromComponent } from './database-env.js';
import type { Component } from '../entities/component.entity.js';
import type { BuildConfig, WorkloadKind } from '../entities/service.entity.js';

const envRepo = new EnvironmentRepository();
const componentRepo = new ComponentRepository();

export interface DesiredState {
  environmentName: string;
  services: string[];
  serviceName?: string;
  crons?: Record<string, {
    schedule: string;
    command?: string;
    timeZone?: string;
  }>;
  domain?: string;
  databaseProvider: string;
  setupEmail: boolean;
  serviceConfig?: Record<string, {
    workloadKind?: WorkloadKind;
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    public?: boolean;
  }>;
  envVars?: Record<string, string>;
  deploy?: {
    strategy?: 'branch' | 'manual';
    trigger?: 'ci' | 'native';
    /** Explicit branch for the current environment. */
    branch?: string;
    /** Legacy staging/production branch mapping. */
    branches?: {
      staging?: string;
      production?: string;
    };
  };
  migrations?: {
    mode?: 'none' | 'releaseCommand' | 'tool';
    runInDeploy?: boolean;
    command?: string;
  };
}

export type DesiredCronConfig = NonNullable<DesiredState['crons']>[string];

export interface ExistingDatabaseState {
  status: 'missing' | 'match' | 'mismatch';
  component?: Component;
  provider?: string;
  envVars?: Record<string, string>;
  connectionUrl?: string;
}

export function normalizeServices(services: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const service of services) {
    if (typeof service !== 'string') continue;
    const trimmed = service.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : ['web'];
}

export function explicitServicesOrNull(services: unknown): string[] | null {
  if (!Array.isArray(services)) return null;

  const normalized = services
    .filter((service): service is string => typeof service === 'string')
    .map((service) => service.trim())
    .filter((service) => service.length > 0);

  if (normalized.length === 0) return null;
  return normalizeServices(normalized);
}

export function normalizeServiceConfig(
  serviceConfig: unknown
): DesiredState['serviceConfig'] | undefined {
  if (!serviceConfig || typeof serviceConfig !== 'object' || Array.isArray(serviceConfig)) {
    return undefined;
  }

  const normalized: NonNullable<DesiredState['serviceConfig']> = {};
  for (const [serviceName, rawConfig] of Object.entries(serviceConfig as Record<string, unknown>)) {
    if (!serviceName.trim() || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;
    const configRecord = rawConfig as Record<string, unknown>;
    const nextConfig: NonNullable<DesiredState['serviceConfig']>[string] = {};

    if (configRecord.workloadKind === 'web' || configRecord.workloadKind === 'worker' || configRecord.workloadKind === 'cron') {
      nextConfig.workloadKind = configRecord.workloadKind;
    }
    if (typeof configRecord.startCommand === 'string' && configRecord.startCommand.trim().length > 0) {
      nextConfig.startCommand = configRecord.startCommand.trim();
    }
    if (typeof configRecord.releaseCommand === 'string' && configRecord.releaseCommand.trim().length > 0) {
      nextConfig.releaseCommand = configRecord.releaseCommand.trim();
    }
    if (typeof configRecord.healthCheckPath === 'string' && configRecord.healthCheckPath.trim().length > 0) {
      nextConfig.healthCheckPath = configRecord.healthCheckPath.trim();
    }
    if (typeof configRecord.cronSchedule === 'string' && configRecord.cronSchedule.trim().length > 0) {
      nextConfig.cronSchedule = configRecord.cronSchedule.trim();
    }
    if (typeof configRecord.public === 'boolean') {
      nextConfig.public = configRecord.public;
    }

    if (Object.keys(nextConfig).length > 0) {
      normalized[serviceName.trim()] = nextConfig;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeCrons(crons: unknown): DesiredState['crons'] | undefined {
  if (!crons || typeof crons !== 'object' || Array.isArray(crons)) {
    return undefined;
  }

  const normalized: NonNullable<DesiredState['crons']> = {};
  for (const [cronName, rawConfig] of Object.entries(crons as Record<string, unknown>)) {
    const name = cronName.trim();
    if (!name || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;
    const config = rawConfig as Record<string, unknown>;
    const schedule = typeof config.schedule === 'string' && config.schedule.trim().length > 0
      ? config.schedule.trim()
      : typeof config.cronSchedule === 'string' && config.cronSchedule.trim().length > 0
        ? config.cronSchedule.trim()
        : undefined;
    if (!schedule) continue;

    normalized[name] = {
      schedule,
      ...(typeof config.command === 'string' && config.command.trim().length > 0
        ? { command: config.command.trim() }
        : {}),
      ...(typeof config.startCommand === 'string' && config.startCommand.trim().length > 0
        ? { command: config.startCommand.trim() }
        : {}),
      ...(typeof config.timeZone === 'string' && config.timeZone.trim().length > 0
        ? { timeZone: config.timeZone.trim() }
        : {}),
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function splitDesiredWorkloads(params: {
  services: string[];
  serviceConfig?: DesiredState['serviceConfig'];
  crons?: DesiredState['crons'];
}): {
  services: string[];
  serviceConfig?: DesiredState['serviceConfig'];
  crons?: DesiredState['crons'];
} {
  const crons: NonNullable<DesiredState['crons']> = { ...(params.crons ?? {}) };
  const serviceConfig: NonNullable<DesiredState['serviceConfig']> = {};

  for (const [name, config] of Object.entries(params.serviceConfig ?? {})) {
    if (config.cronSchedule) {
      crons[name] = {
        schedule: config.cronSchedule,
        ...(config.startCommand ? { command: config.startCommand } : {}),
      };
      continue;
    }

    serviceConfig[name] = config;
  }

  const cronNames = new Set(Object.keys(crons));
  const services = params.services.filter((serviceName) => !cronNames.has(serviceName));

  return {
    services,
    serviceConfig: Object.keys(serviceConfig).length > 0 ? serviceConfig : undefined,
    crons: Object.keys(crons).length > 0 ? crons : undefined,
  };
}

export function workloadKindForServiceName(serviceName: string, index: number): WorkloadKind {
  const normalized = serviceName.toLowerCase();
  if (/worker|queue|consumer|processor/.test(normalized)) return 'worker';
  return index === 0 ? 'web' : 'worker';
}

export function normalizeEnvVars(envVars: unknown): Record<string, string> | undefined {
  if (!envVars || typeof envVars !== 'object' || Array.isArray(envVars)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(envVars as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || typeof rawValue !== 'string') continue;
    normalized[key] = rawValue;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getComponentProvider(component: Component | null): string | undefined {
  if (!component) return undefined;
  const bindings = component.bindings as Record<string, unknown>;
  return typeof bindings.provider === 'string' && bindings.provider.length > 0 ? bindings.provider : undefined;
}

function buildEnvVarsFromComponent(component: Component): { envVars: Record<string, string>; connectionUrl?: string } {
  return buildDatabaseEnvVarsFromComponent(component);
}

export function resolveExistingDatabaseState(
  environmentId: string,
  desiredProvider: string
): ExistingDatabaseState {
  const component = componentRepo.findByEnvironmentAndType(environmentId, 'postgres');
  if (!component) {
    return { status: 'missing' };
  }

  const provider = getComponentProvider(component);
  if (provider === desiredProvider) {
    const { envVars, connectionUrl } = buildEnvVarsFromComponent(component);
    return {
      status: 'match',
      component,
      provider,
      envVars,
      connectionUrl,
    };
  }

  return {
    status: 'mismatch',
    component,
    provider,
  };
}

export function inferExistingDatabaseProvider(
  projectId: string,
  environmentName: string
): string | undefined {
  const environment = envRepo.findByProjectAndName(projectId, environmentName);
  if (!environment) {
    return undefined;
  }

  const component = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
  const provider = getComponentProvider(component);
  if (!provider) {
    return undefined;
  }

  return provider;
}

export function resolveDatabaseProviderForProject(
  project: { id: string },
  policyState: Partial<DesiredState> | undefined,
  overrides: { environmentName?: string; databaseProvider?: string }
): string {
  return overrides.databaseProvider
    ?? policyState?.databaseProvider
    ?? inferExistingDatabaseProvider(project.id, overrides.environmentName ?? policyState?.environmentName ?? 'staging')
    ?? 'supabase';
}

export function resolveDesiredState(
  policyState: Partial<DesiredState> | undefined,
  overrides: Partial<DesiredState>
): DesiredState {
  const overrideServices = explicitServicesOrNull(overrides.services);
  const policyServices = explicitServicesOrNull(policyState?.services);
  const normalizedCrons = normalizeCrons(overrides.crons) ?? normalizeCrons(policyState?.crons);
  const normalizedServiceConfig = normalizeServiceConfig(overrides.serviceConfig) ?? normalizeServiceConfig(policyState?.serviceConfig);
  const fallbackPrimaryService =
    (typeof overrides.serviceName === 'string' && overrides.serviceName.trim().length > 0
      ? overrides.serviceName.trim()
      : undefined)
    ?? (typeof policyState?.serviceName === 'string' && policyState.serviceName.trim().length > 0
      ? policyState.serviceName.trim()
      : undefined)
    ?? 'web';
  const hasExplicitServiceIntent = Boolean(overrideServices ?? policyServices ?? overrides.serviceName ?? policyState?.serviceName);
  const fallbackServices = overrideServices
    ?? policyServices
    ?? (normalizedCrons && !hasExplicitServiceIntent ? [] : undefined)
    ?? [fallbackPrimaryService];
  const workloads = splitDesiredWorkloads({
    services: fallbackServices,
    serviceConfig: normalizedServiceConfig,
    crons: normalizedCrons,
  });

  return {
    environmentName: overrides.environmentName ?? policyState?.environmentName ?? 'staging',
    services: workloads.services,
    serviceName: workloads.services[0] ?? Object.keys(workloads.crons ?? {})[0] ?? fallbackPrimaryService,
    crons: workloads.crons,
    domain: overrides.domain ?? policyState?.domain,
    databaseProvider: overrides.databaseProvider ?? policyState?.databaseProvider ?? 'supabase',
    setupEmail: overrides.setupEmail ?? policyState?.setupEmail ?? true,
    serviceConfig: workloads.serviceConfig,
    envVars: normalizeEnvVars(overrides.envVars) ?? normalizeEnvVars(policyState?.envVars),
    deploy: overrides.deploy ?? policyState?.deploy,
    migrations: overrides.migrations ?? policyState?.migrations,
  };
}

export function removeServiceFromDesiredState(
  desiredState: Record<string, unknown> | undefined,
  serviceName: string
): Record<string, unknown> | undefined {
  if (!desiredState) return undefined;
  const next = { ...desiredState };
  if (Array.isArray(next.services)) {
    next.services = next.services.filter((name) => name !== serviceName);
  }
  for (const key of ['serviceConfig', 'crons'] as const) {
    const value = next[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = { ...(value as Record<string, unknown>) };
      delete record[serviceName];
      next[key] = record;
    }
  }
  return next;
}

export function updateServiceInDesiredState(
  desiredState: Record<string, unknown> | undefined,
  previousName: string,
  nextName: string,
  buildConfig: BuildConfig
): Record<string, unknown> | undefined {
  if (!desiredState) return undefined;
  const next = { ...desiredState };
  if (Array.isArray(next.services)) {
    next.services = next.services.map((name) => name === previousName ? nextName : name);
  }

  const serviceConfig = next.serviceConfig && typeof next.serviceConfig === 'object' && !Array.isArray(next.serviceConfig)
    ? { ...(next.serviceConfig as Record<string, unknown>) }
    : {};
  const existingConfig = serviceConfig[previousName] && typeof serviceConfig[previousName] === 'object'
    ? { ...(serviceConfig[previousName] as Record<string, unknown>) }
    : {};
  delete serviceConfig[previousName];
  serviceConfig[nextName] = {
    ...existingConfig,
    ...(buildConfig.startCommand ? { startCommand: buildConfig.startCommand } : {}),
    ...(buildConfig.releaseCommand ? { releaseCommand: buildConfig.releaseCommand } : {}),
    ...(buildConfig.healthCheckPath ? { healthCheckPath: buildConfig.healthCheckPath } : {}),
    ...(typeof buildConfig.public === 'boolean' ? { public: buildConfig.public } : {}),
  };
  if (Object.keys(serviceConfig[nextName] as Record<string, unknown>).length > 0) {
    next.serviceConfig = serviceConfig;
  }

  const crons = next.crons && typeof next.crons === 'object' && !Array.isArray(next.crons)
    ? { ...(next.crons as Record<string, unknown>) }
    : {};
  if (buildConfig.workloadKind === 'cron' || buildConfig.cronSchedule) {
    delete crons[previousName];
    crons[nextName] = {
      schedule: buildConfig.cronSchedule,
      ...(buildConfig.startCommand ? { command: buildConfig.startCommand } : {}),
    };
    next.crons = crons;
  } else if (crons[previousName]) {
    delete crons[previousName];
    next.crons = crons;
  }

  return next;
}

export function serviceBindingFor(
  environment: { platformBindings: Record<string, unknown> },
  serviceName: string
): Record<string, unknown> | undefined {
  const bindings = environment.platformBindings;
  const services = bindings.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return undefined;
  const serviceBinding = (services as Record<string, unknown>)[serviceName];
  return serviceBinding && typeof serviceBinding === 'object' && !Array.isArray(serviceBinding)
    ? serviceBinding as Record<string, unknown>
    : undefined;
}

export function removeServiceBinding(environmentId: string, environment: { platformBindings: Record<string, unknown> }, serviceName: string) {
  const services = environment.platformBindings.services && typeof environment.platformBindings.services === 'object' && !Array.isArray(environment.platformBindings.services)
    ? { ...(environment.platformBindings.services as Record<string, unknown>) }
    : {};
  delete services[serviceName];
  envRepo.updatePlatformBindings(environmentId, { services });
}
