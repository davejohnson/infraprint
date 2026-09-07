import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import { detectProviderName } from '../domain/services/provider-logs.service.js';
import {
  fetchProviderLogs,
  fetchProviderDeployments,
  fetchProviderBuildLogs,
  supportsLogsDeploymentsProvider,
  supportsLogsBuildProvider,
  logsDeploymentsUnsupportedMessage,
  logsBuildUnsupportedMessage,
  ProviderLogsConnectionError,
  ProviderLogsReadError,
} from '../domain/services/provider-logs.service.js';
import { fetchStripeWebhookStatuses } from '../domain/services/stripe-ops.service.js';
import { stripeEnvironmentName } from '../domain/services/stripe-env.service.js';
import {
  resolveHealthEnvironment,
  resolveHealthService,
  normalizeBaseUrl,
  joinUrl,
  resolveServiceBaseUrl,
  runHttpCheck,
  collectProjectDeploymentHealth,
} from '../domain/services/health.service.js';
import type { CommandContext } from '../application/context.js';
import { projectField, envField } from './schemas.js';
import { commandSuccess, wrapCommandHandler, HvError } from '../application/results.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { connectionSetupOptions } from '../domain/services/connection-guidance.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { parseEnvironmentMaintenanceBinding } from '../domain/services/environment-maintenance.service.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { ignoredOptionWarnings } from '../application/command-options.js';

function resolveEnvOrThrow(ctx: CommandContext, projectRef: string | undefined, envName: string | undefined) {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const environment = ctx.resolveEnvironmentOrThrow(project, envName);
  const bindings = environment.platformBindings as { provider?: string; services?: Record<string, { serviceId: string }> };
  const provider = detectProviderName(project.defaultPlatform, bindings.provider);
  return { project, environment, bindings, provider };
}

function tailBuildLog(buildLogs: string, requestedLines: number | undefined) {
  const normalized = buildLogs.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  // A terminal newline terminates the preceding line; it is not an extra
  // empty log line. Counting it made `limit: 1` return an empty string for
  // the overwhelmingly common `"last line\n"` response shape.
  if (lines.at(-1) === '') lines.pop();
  const tail = requestedLines === undefined ? lines : lines.slice(-requestedLines);
  return {
    buildLogs: tail.join('\n'),
    lineCount: lines.length,
    returnedLines: tail.length,
    truncated: lines.length > tail.length,
  };
}

async function readProviderLogs<T>(
  provider: string,
  project: ReturnType<CommandContext['resolveProjectOrThrow']>,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ProviderLogsConnectionError) {
      const scopeHints = getProjectScopeHints(project);
      const scope = scopeHints.find((hint) => !hint.includes('://') && !hint.includes('github.com/'));
      throw new HvError('MISSING_CONNECTION', error.message, {
        ...connectionSetupOptions(provider, { project: project.name, scope }),
      });
    }
    if (error instanceof ProviderLogsReadError) {
      throw new HvError('PROVIDER_ERROR', error.message, {
        details: {
          provider: error.provider,
          operation: error.operation,
          ...error.details,
        },
        hint: 'Retry the same bounded hv_logs request once. If it fails again, use the returned provider operation and network/HTTP details to repair connectivity or permissions; do not bypass Hypervibe.',
      });
    }
    throw error;
  }
}

export function registerHvObservabilityTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_logs',
    'Fetch logs and delivery status: runtime service logs, build logs, recent deployments, or Stripe webhook endpoint status. Recognized read selectors that do not apply to the chosen source are ignored with a visible warning instead of failing the read.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name. Defaults to the first bound service for source=service/build.'),
      source: z.enum(['service', 'build', 'deployments', 'stripe-webhooks']).describe('What to fetch'),
      limit: z.number().int().min(1).max(500).optional().describe('Max entries for service/deployments, or tail lines for build logs (default 100 service logs, 10 deployments; build logs are unbounded when omitted)'),
      errorsOnly: z.boolean().optional().describe('source=service only: return only error-like lines'),
      deploymentId: z.string().optional().describe('source=build only: specific deployment (defaults to latest)'),
      mode: z.enum(['sandbox', 'live']).optional().describe('source=stripe-webhooks only: optional assertion against the selected environment-scoped connection mode'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, service, source, limit, errorsOnly, deploymentId, mode }) => {
      if (source === 'stripe-webhooks') {
        if (!projectRef || !env) {
          throw new HvError('VALIDATION', 'Stripe webhook inspection requires explicit project and env selectors.', {
            hint: 'Pass the Hypervibe project and environment whose payments.stripe connection should be inspected.',
          });
        }
        const warnings = ignoredOptionWarnings('hv_logs', `source="${source}"`, {
          service,
          limit,
          errorsOnly,
          deploymentId,
        });
        const { project, environment } = resolveEnvOrThrow(ctx, projectRef, env);
        const environmentSpec = new SpecStore().get(project)?.spec.environments[environment.name];
        const stripeEnvironment = environmentSpec?.payments?.stripe
          ? stripeEnvironmentName(environment.name, environmentSpec.payments.stripe)
          : environment.name;
        const result = await fetchStripeWebhookStatuses(stripeEnvironment, mode);
        if (!result.success) {
          throw new HvError(result.code, result.error, {
            ...(result.code === 'MISSING_CONNECTION'
              ? {
                ...connectionSetupOptions('stripe', {
                  project: project.name,
                  scope: stripeEnvironment,
                }),
              }
              : {}),
          });
        }
        return commandSuccess(
          {
            source,
            project: project.name,
            environment: environment.name,
            stripeEnvironment,
            mode: result.mode,
            webhooks: result.webhooks,
          },
          { warnings }
        );
      }

      const warnings = ignoredOptionWarnings('hv_logs', `source="${source}"`, source === 'service'
        ? { deploymentId, mode }
        : source === 'build'
          ? { errorsOnly, mode }
          : { errorsOnly, deploymentId, mode });

      const { project, environment, bindings, provider } = resolveEnvOrThrow(ctx, projectRef, env);
      const boundServices = Object.keys(bindings.services ?? {});
      if (service && !bindings.services?.[service]) {
        throw new HvError('NOT_FOUND', `Service "${service}" is not bound in ${environment.name}.`, {
          details: { available: boundServices },
          hint: 'Choose a bound service, or converge its desired-state binding with hv_plan and hv_apply first.',
        });
      }
      const serviceName = service ?? boundServices[0];

      if (source === 'deployments') {
        if (!supportsLogsDeploymentsProvider(provider)) {
          throw new HvError('UNSUPPORTED', logsDeploymentsUnsupportedMessage(provider));
        }
        const deployments = await readProviderLogs(
          provider,
          project,
          () => fetchProviderDeployments(provider, project, environment, service, limit ?? 10)
        );
        return commandSuccess(
          { source, provider, environment: environment.name, deployments },
          { warnings }
        );
      }

      if (!serviceName) {
        throw new HvError('NOT_FOUND', 'No services bound in this environment.', {
          hint: 'Deploy first with hv_apply, or pass service explicitly.',
        });
      }

      if (source === 'build') {
        if (!supportsLogsBuildProvider(provider)) {
          throw new HvError('UNSUPPORTED', logsBuildUnsupportedMessage(provider));
        }
        const result = await readProviderLogs(
          provider,
          project,
          () => fetchProviderBuildLogs(provider, project, environment, serviceName, deploymentId)
        );
        return commandSuccess(
          {
            source,
            provider,
            service: serviceName,
            deploymentId: result.deploymentId,
            ...tailBuildLog(result.buildLogs, limit),
          },
          { warnings }
        );
      }

      const { logs, deploymentStatus } = await readProviderLogs(
        provider,
        project,
        () => fetchProviderLogs(
          provider,
          project,
          environment,
          serviceName,
          limit ?? 100,
          { errorsOnly }
        )
      );
      return commandSuccess(
        {
          source,
          provider,
          environment: environment.name,
          service: serviceName,
          deploymentStatus,
          count: logs.length,
          logs,
        },
        { warnings }
      );
    })
  );

  commands.register(
    'hv_health',
    'HTTP health-check a deployed service or an explicit URL. Project-backed checks also surface latest deployment failures for every current desired service across declared environments when provider connections are available; unknown provider observations never count as healthy.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name (defaults to web or the first web service)'),
      url: z.string().url().optional().describe('Explicit URL to check instead of resolving project/env/service bindings; supplied binding selectors are ignored with a warning'),
      path: z.string().optional().describe('Path to check (defaults to the service healthCheckPath or /)'),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    },
    wrapCommandHandler(async ({ project: projectRef, env, service, url, path, timeoutMs = 20000 }) => {
      const optionWarnings = url
        ? ignoredOptionWarnings('hv_health', 'with explicit url', { project: projectRef, env, service })
        : undefined;
      let baseUrl: string;
      let healthPath = path;
      let resolvedService: string | undefined;
      let resolvedProject: ReturnType<CommandContext['resolveProjectOrThrow']> | undefined;
      let resolvedEnvironment: Environment | undefined;
      let resolvedEnvironmentSpec: EnvironmentSpec | undefined;

      if (url) {
        baseUrl = normalizeBaseUrl(url);
      } else {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        resolvedProject = project;
        const environment = env
          ? ctx.resolveEnvironmentOrThrow(project, env)
          : resolveHealthEnvironment(project.id);
        if (!environment) {
          throw new HvError('NOT_FOUND', 'No environment found to check.', { hint: 'Pass env explicitly.' });
        }
        resolvedEnvironment = environment;
        const storedService = resolveHealthService(project.id, service);
        const environmentSpec = new SpecStore().get(project)?.spec.environments[environment.name];
        resolvedEnvironmentSpec = environmentSpec;
        const desiredServiceName = service
          ?? Object.entries(environmentSpec?.services ?? {}).find(([, value]) => value.workloadKind === 'web')?.[0]
          ?? Object.keys(environmentSpec?.services ?? {})[0];
        const resolvedName = storedService?.name ?? desiredServiceName;
        if (!resolvedName) {
          throw new HvError('NOT_FOUND', service ? `Service not found: ${service}` : 'No services found.');
        }
        const desiredService = environmentSpec?.services[resolvedName];
        if (!storedService && !desiredService) {
          throw new HvError('NOT_FOUND', `Service not found: ${resolvedName}`);
        }
        resolvedService = resolvedName;
        const declaredDomain = desiredService?.workloadKind === 'web'
          ? environmentSpec?.domain
          : undefined;
        const resolved = resolveServiceBaseUrl(environment, resolvedName, declaredDomain);
        if (!resolved) {
          throw new HvError('NOT_FOUND', `Service "${resolvedName}" has no URL binding in ${environment.name}.`, {
            hint: 'Deploy it first with hv_apply or hv_deploy.',
          });
        }
        baseUrl = resolved;
        healthPath = healthPath
          ?? storedService?.buildConfig.healthCheckPath
          ?? desiredService?.healthCheckPath
          ?? '/';
      }

      if (
        resolvedProject
        && resolvedEnvironment
        && resolvedEnvironmentSpec
        && (
          resolvedEnvironmentSpec.maintenance
          || parseEnvironmentMaintenanceBinding(resolvedEnvironment)
        )
      ) {
        const observation = await new PlanService().observeEnvironment(
          resolvedProject,
          resolvedEnvironment,
          resolvedEnvironmentSpec
        );
        const maintenance = observation.observed?.maintenance;
        if (maintenance) {
          return commandSuccess({
            service: resolvedService,
            baseUrl,
            state: maintenance.state === 'active' ? 'maintenance' : 'unknown',
            maintenance: {
              desired: resolvedEnvironmentSpec.maintenance?.enabled === true,
              observed: maintenance.state,
              stage: maintenance.stage,
            },
          }, {
            hint: maintenance.state === 'active'
              ? 'The provider-verified maintenance boundary is active; normal HTTP health is intentionally suppressed.'
              : 'Maintenance is transitioning or could not be fully observed. Use hv_status before changing data.',
            warnings: observation.warnings.length > 0 ? observation.warnings : undefined,
          });
        }
      }

      const check = await runHttpCheck({
        name: 'health',
        url: joinUrl(baseUrl, healthPath ?? '/'),
        method: 'GET',
        timeoutMs,
        followRedirects: false,
        expectedStatusMin: 200,
        expectedStatusMax: 399,
        bodyPreviewBytes: 2048,
      });

      const projectSpec = resolvedProject
        ? new SpecStore().get(resolvedProject)?.spec
        : undefined;
      const specEnvironmentNames = Object.keys(projectSpec?.environments ?? {});
      const deploymentHealth = resolvedProject
        ? await collectProjectDeploymentHealth({
          project: resolvedProject,
          environments: ctx.repos.environments
            .findByProjectId(resolvedProject.id)
            .filter((environment) => specEnvironmentNames.includes(environment.name)),
          desiredServiceNamesByEnvironment: Object.fromEntries(
            Object.entries(projectSpec?.environments ?? {}).map(([environmentName, environmentSpec]) => [
              environmentName,
              Object.keys(environmentSpec.services),
            ])
          ),
        })
        : undefined;
      const deploymentFailure = deploymentHealth?.failures[0];
      const unknownEnvironments = deploymentHealth?.environments
        .filter((environment) => environment.state === 'unknown')
        .map((environment) => environment.reason
          ? `${environment.environment} (${environment.reason})`
          : environment.environment) ?? [];

      return commandSuccess(
        {
          service: resolvedService,
          baseUrl,
          check,
          ...(deploymentHealth ? { deploymentHealth } : {}),
        },
        {
          hint: !check.ok
            ? 'Check hv_logs source="service" errorsOnly=true for the failing service.'
            : deploymentFailure
              ? `Latest deployment failure: ${deploymentFailure.environment}/${deploymentFailure.service} on ${deploymentFailure.provider} (${deploymentFailure.status}). Inspect that environment with hv_logs source="deployments" and source="build" where supported.`
              : undefined,
          warnings: [
            ...(optionWarnings ?? []),
            ...(unknownEnvironments.length > 0
              ? [`Deployment status is unknown for: ${unknownEnvironments.join(', ')}.`]
              : []),
          ],
        }
      );
    })
  );
}
