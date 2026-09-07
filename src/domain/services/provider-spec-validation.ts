import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import type { WorkloadKind } from '../entities/service.entity.js';
import {
  providerRegistry,
  type ProviderImplementationStatus,
  type ProviderLifecycleCapability,
} from '../registry/provider.registry.js';
import { devOpsProviderRegistry } from '../registry/devops.registry.js';

export interface ProviderSpecIssue {
  environment: string;
  field: 'hosting.provider' | 'services.workloadKind' | 'database.provider' | 'database.engine' | 'cache.provider' | 'cache.engine' | 'storage.provider' | 'queues' | 'loadBalancer.provider' | 'devops.code.provider' | 'devops.ci.provider';
  provider: string;
  service?: string;
  workloadKind?: WorkloadKind;
  engine?: string;
  capability: ProviderLifecycleCapability | 'code-host' | 'ci';
  status?: ProviderImplementationStatus;
  reason?: string;
  /** Present when a lifecycle exists but its network contract cannot serve the selected host. */
  incompatibleHostingProvider?: string;
  /** Provider-owned declarative constraint that failed after structural spec parsing. */
  configuration?: {
    path: string;
    message: string;
    hint: string;
  };
  available: string[];
}

/**
 * Safe, interface-agnostic rendering of a provider validation failure.
 * Keeping this beside the validator lets every lifecycle entry point report
 * the same error without duplicating provider/maturity/connectivity logic.
 */
export interface ProviderSpecValidationFailure {
  issue: ProviderSpecIssue;
  message: string;
  hint: string;
  details: Record<string, unknown>;
}

function hostingCompatibilityIssue(params: {
  environment: string;
  field: 'database.provider' | 'cache.provider';
  provider: string;
  capability: 'database' | 'cache';
  hostingProvider: string;
}): ProviderSpecIssue | undefined {
  const lifecycle = providerRegistry.getMetadata(params.provider)?.lifecycle;
  const compatible = params.capability === 'database'
    ? lifecycle?.databaseConnectivity?.compatibleHostingProviders
    : lifecycle?.cacheConnectivity?.compatibleHostingProviders;
  if (!compatible || compatible.includes(params.hostingProvider)) return undefined;
  return {
    environment: params.environment,
    field: params.field,
    provider: params.provider,
    capability: params.capability,
    incompatibleHostingProvider: params.hostingProvider,
    reason: `${params.provider} ${params.capability} connectivity is implemented only for workloads hosted by ${compatible.join(', ')}.`,
    available: compatible,
  };
}

function mutationMaturityIssue(params: {
  environment: string;
  field: Extract<ProviderSpecIssue['field'], 'hosting.provider' | 'database.provider' | 'cache.provider' | 'storage.provider' | 'queues' | 'loadBalancer.provider'>;
  provider: string;
  capability: ProviderLifecycleCapability;
}): ProviderSpecIssue | undefined {
  if (!providerRegistry.supports(params.provider, params.capability)) return undefined;
  if (providerRegistry.supportsMutation(params.provider, params.capability)) return undefined;
  const maturity = providerRegistry.lifecycleMaturity(params.provider, params.capability);
  return {
    ...params,
    ...(maturity?.status ? { status: maturity.status } : {}),
    ...(maturity?.reason ? { reason: maturity.reason } : {}),
    available: providerRegistry.namesForMutation(params.capability),
  };
}

function queueConfigurationIssues(params: {
  environment: string;
  environmentSpec: EnvironmentSpec;
  provider: string;
}): ProviderSpecIssue[] {
  const queueLifecycle = providerRegistry.getMetadata(params.provider)?.lifecycle?.queue;
  if (
    queueLifecycle?.backend !== 'postgres'
    || queueLifecycle.resources !== 'application-managed'
  ) {
    return [];
  }

  const issues: ProviderSpecIssue[] = [];
  const available = providerRegistry.namesForMutation('queue');
  if (params.environmentSpec.database?.engine !== 'postgres') {
    issues.push({
      environment: params.environment,
      field: 'queues',
      provider: params.provider,
      capability: 'queue',
      configuration: {
        path: `environments.${params.environment}.queues`,
        message: `${params.provider} application-managed PostgreSQL queues require a declared PostgreSQL database in environment "${params.environment}".`,
        hint: `Declare environments.${params.environment}.database with engine "postgres", or remove environments.${params.environment}.queues.`,
      },
      available,
    });
  }

  for (const [queueName, queue] of Object.entries(params.environmentSpec.queues ?? {})) {
    if (queue.ackDeadlineSeconds === undefined) continue;
    const path = `environments.${params.environment}.queues.${queueName}.ackDeadlineSeconds`;
    issues.push({
      environment: params.environment,
      field: 'queues',
      provider: params.provider,
      capability: 'queue',
      configuration: {
        path,
        message: `${params.provider} application-managed PostgreSQL queues do not support ackDeadlineSeconds for queue "${queueName}" in environment "${params.environment}".`,
        hint: `Remove ${path}. ackDeadlineSeconds is available only for provider-managed Pub/Sub queues.`,
      },
      available,
    });
  }
  return issues;
}

/**
 * Validate installed provider capabilities after structural Zod parsing.
 * Keeping registry lookup out of the schema lets vendor modules self-register
 * without editing a central enum while still rejecting specs that cannot be
 * executed by this Hypervibe installation.
 */
export function validateProjectSpecProviders(spec: ProjectSpec): ProviderSpecIssue[] {
  const issues: ProviderSpecIssue[] = [];
  if (spec.devops && !devOpsProviderRegistry.codeHost(spec.devops.code.provider)) {
    issues.push({
      environment: 'project',
      field: 'devops.code.provider',
      provider: spec.devops.code.provider,
      capability: 'code-host',
      available: devOpsProviderRegistry.codeHostIds(),
    });
  }
  if (spec.devops?.ci && !devOpsProviderRegistry.ciProvider(spec.devops.ci.provider)) {
    issues.push({
      environment: 'project',
      field: 'devops.ci.provider',
      provider: spec.devops.ci.provider,
      capability: 'ci',
      available: devOpsProviderRegistry.ciProviderIds(),
    });
  } else if (
    spec.devops?.ci
    && !devOpsProviderRegistry.compatible(spec.devops.code.provider, spec.devops.ci.provider)
  ) {
    issues.push({
      environment: 'project',
      field: 'devops.ci.provider',
      provider: spec.devops.ci.provider,
      capability: 'ci',
      available: devOpsProviderRegistry.ciProviderIds()
        .filter((provider) => devOpsProviderRegistry.compatible(spec.devops!.code.provider, provider)),
    });
  }
  for (const [environment, environmentSpec] of Object.entries(spec.environments)) {
    if (!providerRegistry.supports(environmentSpec.hosting.provider, 'hosting')) {
      issues.push({
        environment,
        field: 'hosting.provider',
        provider: environmentSpec.hosting.provider,
        capability: 'hosting',
        available: providerRegistry.namesForMutation('hosting'),
      });
    } else {
      const maturityIssue = mutationMaturityIssue({
        environment,
        field: 'hosting.provider',
        provider: environmentSpec.hosting.provider,
        capability: 'hosting',
      });
      if (maturityIssue) issues.push(maturityIssue);
      const supportedWorkloadKinds = environmentSpec.hosting.provider
        ? providerRegistry.getMetadata(environmentSpec.hosting.provider)
          ?.lifecycle?.hosting?.workloadKinds ?? []
        : [];
      for (const [service, serviceSpec] of Object.entries(environmentSpec.services)) {
        if (providerRegistry.supportsWorkloadKind(
          environmentSpec.hosting.provider,
          serviceSpec.workloadKind
        )) {
          continue;
        }
        issues.push({
          environment,
          field: 'services.workloadKind',
          provider: environmentSpec.hosting.provider,
          service,
          workloadKind: serviceSpec.workloadKind,
          capability: 'hosting',
          reason: `${environmentSpec.hosting.provider} does not implement the ${serviceSpec.workloadKind} workload lifecycle.`,
          available: [...supportedWorkloadKinds],
        });
      }
    }
    if (
      environmentSpec.database
      && !providerRegistry.supports(environmentSpec.database.provider, 'database')
    ) {
      issues.push({
        environment,
        field: 'database.provider',
        provider: environmentSpec.database.provider,
        capability: 'database',
        available: providerRegistry.namesForMutation('database'),
      });
    } else if (
      environmentSpec.database
      && !providerRegistry.supportsMutation(environmentSpec.database.provider, 'database')
    ) {
      issues.push(mutationMaturityIssue({
        environment,
        field: 'database.provider',
        provider: environmentSpec.database.provider,
        capability: 'database',
      })!);
    } else if (
      environmentSpec.database
      && !providerRegistry.supportsEngine(
        environmentSpec.database.provider,
        'database',
        environmentSpec.database.engine
      )
    ) {
      issues.push({
        environment,
        field: 'database.engine',
        provider: environmentSpec.database.provider,
        engine: environmentSpec.database.engine,
        capability: 'database',
        available: providerRegistry.getMetadata(environmentSpec.database.provider)
          ?.lifecycle?.databaseEngines ?? [],
      });
    } else if (environmentSpec.database) {
      const compatibilityIssue = hostingCompatibilityIssue({
        environment,
        field: 'database.provider',
        provider: environmentSpec.database.provider,
        capability: 'database',
        hostingProvider: environmentSpec.hosting.provider,
      });
      if (compatibilityIssue) issues.push(compatibilityIssue);
    }
    if (
      environmentSpec.cache
      && !providerRegistry.supports(environmentSpec.cache.provider, 'cache')
    ) {
      issues.push({
        environment,
        field: 'cache.provider',
        provider: environmentSpec.cache.provider,
        capability: 'cache',
        available: providerRegistry.namesForMutation('cache'),
      });
    } else if (
      environmentSpec.cache
      && !providerRegistry.supportsMutation(environmentSpec.cache.provider, 'cache')
    ) {
      issues.push(mutationMaturityIssue({
        environment,
        field: 'cache.provider',
        provider: environmentSpec.cache.provider,
        capability: 'cache',
      })!);
    } else if (
      environmentSpec.cache
      && !providerRegistry.supportsEngine(
        environmentSpec.cache.provider,
        'cache',
        environmentSpec.cache.engine
      )
    ) {
      issues.push({
        environment,
        field: 'cache.engine',
        provider: environmentSpec.cache.provider,
        engine: environmentSpec.cache.engine,
        capability: 'cache',
        available: providerRegistry.getMetadata(environmentSpec.cache.provider)
          ?.lifecycle?.cacheEngines ?? [],
      });
    } else if (environmentSpec.cache) {
      const compatibilityIssue = hostingCompatibilityIssue({
        environment,
        field: 'cache.provider',
        provider: environmentSpec.cache.provider,
        capability: 'cache',
        hostingProvider: environmentSpec.hosting.provider,
      });
      if (compatibilityIssue) issues.push(compatibilityIssue);
    }
    for (const storage of Object.values(environmentSpec.storage ?? {})) {
      if (!providerRegistry.supports(storage.provider, 'storage')) {
        issues.push({
          environment,
          field: 'storage.provider',
          provider: storage.provider,
          capability: 'storage',
          available: providerRegistry.namesForMutation('storage'),
        });
        continue;
      }
      const maturityIssue = mutationMaturityIssue({
        environment,
        field: 'storage.provider',
        provider: storage.provider,
        capability: 'storage',
      });
      if (maturityIssue) issues.push(maturityIssue);
    }
    if (Object.keys(environmentSpec.queues ?? {}).length > 0) {
      const queueProvider = environmentSpec.hosting.provider;
      if (!providerRegistry.supports(queueProvider, 'queue')) {
        issues.push({
          environment,
          field: 'queues',
          provider: queueProvider,
          capability: 'queue',
          available: providerRegistry.namesForMutation('queue'),
        });
      } else {
        const maturityIssue = mutationMaturityIssue({
          environment,
          field: 'queues',
          provider: queueProvider,
          capability: 'queue',
        });
        if (maturityIssue) issues.push(maturityIssue);
        issues.push(...queueConfigurationIssues({
          environment,
          environmentSpec,
          provider: queueProvider,
        }));
      }
    }
    if (environmentSpec.loadBalancer) {
      const loadBalancerProvider = environmentSpec.loadBalancer.provider;
      if (!providerRegistry.supports(loadBalancerProvider, 'load-balancer')) {
        issues.push({
          environment,
          field: 'loadBalancer.provider',
          provider: loadBalancerProvider,
          capability: 'load-balancer',
          available: providerRegistry.namesForMutation('load-balancer'),
        });
      } else {
        const maturityIssue = mutationMaturityIssue({
          environment,
          field: 'loadBalancer.provider',
          provider: loadBalancerProvider,
          capability: 'load-balancer',
        });
        if (maturityIssue) issues.push(maturityIssue);
      }
    }
  }
  return issues;
}

export function firstProviderSpecValidationFailure(
  spec: ProjectSpec
): ProviderSpecValidationFailure | undefined {
  const issue = validateProjectSpecProviders(spec)[0];
  if (!issue) return undefined;

  const label = issue.capability;
  const engineIssue = issue.field.endsWith('.engine');
  const workloadKindIssue = issue.field === 'services.workloadKind';
  const plannedCapability = issue.status === 'planned';
  const hostingCompatibilityIssue = Boolean(issue.incompatibleHostingProvider);
  const configurationIssue = issue.configuration;
  return {
    issue,
    message: plannedCapability
      ? `${issue.provider} ${label} is planned and is not enabled for lifecycle mutation in environment "${issue.environment}".`
      : configurationIssue
        ? configurationIssue.message
      : workloadKindIssue
        ? `${issue.provider} hosting does not support workload kind "${issue.workloadKind}" for service "${issue.service}" in environment "${issue.environment}".`
      : hostingCompatibilityIssue
        ? `${issue.provider} ${label} cannot serve workloads hosted by "${issue.incompatibleHostingProvider}" in environment "${issue.environment}".`
        : engineIssue
          ? `${issue.provider} does not support ${label} engine "${issue.engine}" in environment "${issue.environment}".`
          : issue.field.startsWith('devops.')
            ? `Unknown or incompatible ${label} provider "${issue.provider}".`
            : `Unknown ${label} provider "${issue.provider}" in environment "${issue.environment}".`,
    hint: plannedCapability
      ? `${issue.reason ?? 'This capability has not completed its live-readiness prerequisites.'} Ready lifecycle providers: ${issue.available.join(', ') || 'none'}. You may still connect the provider and use hv_inspect for read-only forensics.`
      : configurationIssue
        ? configurationIssue.hint
      : workloadKindIssue
        ? `Supported workload kinds for ${issue.provider}: ${issue.available.join(', ') || 'none'}. Choose one of those kinds or select a hosting provider that implements ${issue.workloadKind}.`
      : hostingCompatibilityIssue
        ? `${issue.reason} Compatible hosting providers: ${issue.available.join(', ') || 'none'}.`
        : engineIssue
          ? `Supported ${label} engines for ${issue.provider}: ${issue.available.join(', ') || 'none'}.`
          : `Available ${label} providers: ${issue.available.join(', ')}.`,
    details: {
      path: configurationIssue
        ? configurationIssue.path
        : issue.field.startsWith('devops.')
        ? issue.field
        : workloadKindIssue
          ? `environments.${issue.environment}.services.${issue.service}.workloadKind`
        : `environments.${issue.environment}.${issue.field}`,
      capability: issue.capability,
      ...(issue.status ? { maturityStatus: issue.status } : {}),
      ...(issue.reason && issue.status ? { maturityReason: issue.reason } : {}),
      ...(issue.reason && !issue.status ? { reason: issue.reason } : {}),
      ...(issue.incompatibleHostingProvider
        ? { incompatibleHostingProvider: issue.incompatibleHostingProvider }
        : {}),
      ...(issue.engine ? { engine: issue.engine } : {}),
      ...(issue.service ? { service: issue.service } : {}),
      ...(issue.workloadKind ? { workloadKind: issue.workloadKind } : {}),
    },
  };
}
