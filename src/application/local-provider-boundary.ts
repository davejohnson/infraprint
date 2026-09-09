import type { CommandContext } from './context.js';
import { parseHostingServiceCreateRecovery } from '../domain/ports/hosting.port.js';

export type ProviderBoundaryTarget = {
  boundary: 'project';
  provider: string;
  projectId: string;
} | {
  boundary: 'environment';
  provider: string;
  projectId: string;
  environmentId: string;
};

export interface LocalProviderBoundaryUse {
  projectName: string;
  environmentName: string;
  source: string;
  scopeState: 'exact' | 'unknown';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function matchingScope(
  value: unknown,
  target: ProviderBoundaryTarget
): 'exact' | 'unknown' | null {
  const scope = record(value);
  const projectId = nonEmptyString(scope?.projectId);
  if (!scope || !projectId) return 'unknown';
  if (projectId !== target.projectId) return null;
  if (target.boundary === 'project') return 'exact';
  const environmentId = nonEmptyString(scope.environmentId);
  if (!environmentId) return 'unknown';
  return environmentId === target.environmentId ? 'exact' : null;
}

/**
 * Find any other durable local record that still uses, or may use, the
 * provider boundary reviewed for deletion. Scope ambiguity is destructive,
 * so same-provider records without the required scope fail closed.
 */
export function findLocalProviderBoundaryUse(
  ctx: CommandContext,
  target: ProviderBoundaryTarget,
  exclude: { localEnvironmentId: string }
): LocalProviderBoundaryUse | null {
  for (const project of ctx.repos.projects.findAll()) {
    for (const environment of ctx.repos.environments.findByProjectId(project.id)) {
      const platform = record(environment.platformBindings) ?? {};
      const previousHosting = record(platform.previousHosting);
      const hostingSources = [
        { name: 'current hosting', value: platform, excluded: false },
        {
          name: 'previous hosting',
          value: previousHosting,
          excluded: environment.id === exclude.localEnvironmentId,
        },
      ];

      for (const source of hostingSources) {
        if (!source.value || source.excluded) continue;
        if (nonEmptyString(source.value.provider) === target.provider) {
          const scopeState = matchingScope(source.value, target);
          if (scopeState) {
            return {
              projectName: project.name,
              environmentName: environment.name,
              source: source.name,
              scopeState,
            };
          }
        }

        const rawRecoveries = source.value.serviceCreateRecovery;
        if (rawRecoveries === undefined) continue;
        const recoveries = record(rawRecoveries);
        if (!recoveries) {
          return {
            projectName: project.name,
            environmentName: environment.name,
            source: `${source.name} service recovery`,
            scopeState: 'unknown',
          };
        }
        for (const rawRecovery of Object.values(recoveries)) {
          const recoveryRecord = record(rawRecovery);
          if (nonEmptyString(recoveryRecord?.provider) !== target.provider) continue;
          const recovery = parseHostingServiceCreateRecovery(rawRecovery);
          const scopeState = recovery
            ? matchingScope(recovery.providerScope, target)
            : 'unknown';
          if (scopeState) {
            return {
              projectName: project.name,
              environmentName: environment.name,
              source: `${source.name} service recovery`,
              scopeState,
            };
          }
        }
      }

      for (const component of ctx.repos.components.findByEnvironmentId(environment.id)) {
        const bindings = record(component.bindings);
        if (nonEmptyString(bindings?.provider) === target.provider) {
          const scopeState = matchingScope(bindings?.providerScope, target);
          if (scopeState) {
            return {
              projectName: project.name,
              environmentName: environment.name,
              source: `${component.type} component`,
              scopeState,
            };
          }
        }

        const previousProvider = nonEmptyString(bindings?.previousProvider);
        const previousBindings = record(bindings?.previousBindings);
        const nestedProvider = nonEmptyString(previousBindings?.provider);
        if (previousProvider !== target.provider && nestedProvider !== target.provider) continue;
        const scopeState = previousProvider === target.provider
          && previousBindings
          && nestedProvider === target.provider
          ? matchingScope(previousBindings.providerScope, target)
          : 'unknown';
        if (scopeState) {
          return {
            projectName: project.name,
            environmentName: environment.name,
            source: `previous ${component.type} component`,
            scopeState,
          };
        }
      }

      for (const [key, label] of [
        ['previousDatabase', 'previous database'],
        ['previousCache', 'previous cache'],
        ['previousResource', 'previous provider resource'],
      ] as const) {
        const retained = record(platform[key]);
        if (!retained || nonEmptyString(retained.provider) !== target.provider) continue;
        const scopeState = matchingScope(retained.providerScope, target);
        if (scopeState) {
          return {
            projectName: project.name,
            environmentName: environment.name,
            source: label,
            scopeState,
          };
        }
      }
    }
  }
  return null;
}
