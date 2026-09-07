import type { EnvironmentSpec, ProjectRuntimeSpec } from './spec.schema.js';
import type { DesiredState } from '../services/spec.service.js';

export interface BootstrapParams {
  projectName: string;
  environmentName: string;
  /** Non-secret hosting placement declared in environments.<name>.hosting.region. */
  hostingRegion?: string;
  services: string[];
  crons?: DesiredState['crons'];
  domain?: string;
  databaseProvider?: string;
  serviceConfig?: DesiredState['serviceConfig'];
  envVars?: DesiredState['envVars'];
  deploy?: DesiredState['deploy'];
  /** Poll web services' healthCheckPath over HTTP after deploy (hv_deploy). */
  verifyHttpHealth?: boolean;
  /** Managed queue env vars resolved by the caller (see queue-env.ts). */
  queueEnvVars?: Record<string, string>;
  /** Managed runtime variables that apply only to one service. */
  envVarsByService?: Record<string, Record<string, string>>;
  /**
   * Service actions depend on an explicit project action, so they must not
   * silently re-run project creation while deploying one workload.
   */
  ensureHostingProject?: boolean;
  /** Explicit project runtime projected into service build configuration. */
  runtime?: ProjectRuntimeSpec;
}

/**
 * Env-level migrations.mode="releaseCommand" is carried by a web service:
 * derive its releaseCommand so both diff and bootstrap converge the
 * provider's pre-deploy hook. An explicit releaseCommand on any web service
 * means the user manages it themselves — derive nothing. With several web
 * services, only the first (alphabetical) carries it: migrations run once.
 */
export function withMigrationReleaseCommand(env: EnvironmentSpec): EnvironmentSpec {
  const command = env.migrations?.mode === 'releaseCommand' ? env.migrations.command : undefined;
  if (!command) return env;
  const webNames = Object.keys(env.services)
    .filter((name) => env.services[name].workloadKind === 'web')
    .sort();
  const carrier = webNames[0];
  if (!carrier || webNames.some((name) => env.services[name].releaseCommand !== undefined)) return env;
  return {
    ...env,
    services: {
      ...env.services,
      [carrier]: { ...env.services[carrier], releaseCommand: command },
    },
  };
}

export function migrationReleaseCommandWarning(env: EnvironmentSpec): string | undefined {
  const command = env.migrations?.mode === 'releaseCommand' ? env.migrations.command : undefined;
  if (!command) return undefined;
  const webServices = Object.entries(env.services)
    .filter(([, service]) => service.workloadKind === 'web')
    .sort(([a], [b]) => a.localeCompare(b));
  if (webServices.length === 0) {
    return `migrations.mode="releaseCommand" is set but no web service exists to carry the release command, so "${command}" will never run. Add a web service or set releaseCommand on a service explicitly.`;
  }
  const explicit = webServices.filter(([, service]) => service.releaseCommand !== undefined);
  if (explicit.length === 0 || explicit.some(([, service]) => service.releaseCommand === command)) {
    return undefined;
  }
  const serviceNames = explicit.map(([name]) => name).join(', ');
  return `migrations.mode="releaseCommand" is set to "${command}", but web service releaseCommand is already set on ${serviceNames}. Hypervibe will not overwrite explicit service releaseCommand values, so the migration command will not run unless one of those commands includes it.`;
}

/**
 * Convert one environment section of a ProjectSpec into the parameter shape
 * executeBootstrap expects (the legacy DesiredState layout).
 */
export function specToBootstrapParams(
  projectName: string,
  environmentName: string,
  envInput: EnvironmentSpec,
  runtime?: ProjectRuntimeSpec
): BootstrapParams {
  const env = withMigrationReleaseCommand(envInput);
  const services: string[] = [];
  const crons: NonNullable<DesiredState['crons']> = {};
  const serviceConfig: NonNullable<DesiredState['serviceConfig']> = {};

  for (const [name, service] of Object.entries(env.services)) {
    if (service.workloadKind === 'cron') {
      crons[name] = {
        schedule: service.cronSchedule!,
        ...(service.startCommand ? { command: service.startCommand } : {}),
        ...(service.timeZone ? { timeZone: service.timeZone } : {}),
      };
    } else {
      services.push(name);
    }

    const config: Record<string, unknown> = {};
    config.workloadKind = service.workloadKind;
    if (service.startCommand !== undefined) config.startCommand = service.startCommand;
    if (service.releaseCommand !== undefined) config.releaseCommand = service.releaseCommand;
    if (service.healthCheckPath !== undefined) config.healthCheckPath = service.healthCheckPath;
    if (service.cronSchedule !== undefined) config.cronSchedule = service.cronSchedule;
    if (service.public !== undefined) config.public = service.public;
    if (Object.keys(config).length > 0) {
      serviceConfig[name] = config as NonNullable<DesiredState['serviceConfig']>[string];
    }
  }

  let deploy: DesiredState['deploy'];
  if (env.deploy?.strategy) {
    deploy = {
      strategy: env.deploy.strategy,
      ...(env.deploy.trigger ? { trigger: env.deploy.trigger } : {}),
      ...(env.deploy.branch ? { branch: env.deploy.branch } : {}),
    };
  }

  return {
    projectName,
    environmentName,
    ...(env.hosting.region ? { hostingRegion: env.hosting.region } : {}),
    services,
    ...(Object.keys(crons).length > 0 ? { crons } : {}),
    ...(env.domain ? { domain: env.domain } : {}),
    ...(env.database ? { databaseProvider: env.database.provider } : {}),
    ...(Object.keys(serviceConfig).length > 0 ? { serviceConfig } : {}),
    ...(Object.keys(env.envVars).length > 0 ? { envVars: env.envVars } : {}),
    ...(deploy ? { deploy } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

/**
 * Apply plan-frozen deploy overrides (hv_plan services=/envVars=) to
 * bootstrap params: restrict services/crons to the subset and merge one-off
 * env vars last so they win over spec and database-derived vars, matching
 * hv_deploy's historical behavior.
 */
export function applyOverridesToBootstrapParams(
  params: BootstrapParams,
  overrides: { services?: string[]; envVars?: Record<string, string> }
): BootstrapParams {
  const next: BootstrapParams = { ...params };
  if (overrides.services?.length) {
    const keep = new Set(overrides.services);
    next.services = params.services.filter((name) => keep.has(name));
    if (params.crons) {
      const crons = Object.fromEntries(Object.entries(params.crons).filter(([name]) => keep.has(name)));
      if (Object.keys(crons).length > 0) {
        next.crons = crons;
      } else {
        delete next.crons;
      }
    }
  }
  if (overrides.envVars && Object.keys(overrides.envVars).length > 0) {
    next.envVars = { ...(params.envVars ?? {}), ...overrides.envVars };
  }
  return next;
}

export function applyEnvFileVarsToBootstrapParams(
  params: BootstrapParams,
  envFileVars: Record<string, string> | undefined
): BootstrapParams {
  if (!envFileVars || Object.keys(envFileVars).length === 0) {
    return params;
  }
  return {
    ...params,
    envVars: {
      ...envFileVars,
      ...(params.envVars ?? {}),
    },
  };
}

/**
 * Restrict legacy bootstrap execution to the authority of one reviewed
 * service action. Infrastructure owned by separate plan resources is removed
 * even if it is present in the environment spec.
 */
export function scopeBootstrapParamsToService(
  params: BootstrapParams,
  serviceName: string
): BootstrapParams {
  const cron = params.crons?.[serviceName];
  const serviceConfig = params.serviceConfig?.[serviceName];
  const serviceEnvVars = params.envVarsByService?.[serviceName];
  return {
    ...params,
    services: params.services.includes(serviceName) ? [serviceName] : [],
    ...(cron ? { crons: { [serviceName]: cron } } : { crons: undefined }),
    ...(serviceConfig ? { serviceConfig: { [serviceName]: serviceConfig } } : { serviceConfig: undefined }),
    ...(serviceEnvVars
      ? { envVarsByService: { [serviceName]: serviceEnvVars } }
      : { envVarsByService: undefined }),
    databaseProvider: undefined,
    domain: undefined,
    ensureHostingProject: false,
  };
}
