import type { CommandContext } from './context.js';

type DatastoreComponentType = 'postgres' | 'redis';

export interface ActiveDatastoreBindingConflict {
  projectName: string;
  environmentName: string;
  componentId: string;
  scopeState: 'exact' | 'missing' | 'mismatched';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function exactScope(left: Record<string, unknown>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/**
 * Find any concrete datastore binding that could refer to a retained cleanup
 * target. Provider ids are not globally unique, so a same-id binding with
 * missing or contradictory scope is an ambiguity and must fail closed.
 */
export function findActiveDatastoreBindingConflict(
  ctx: CommandContext,
  target: {
    componentType: DatastoreComponentType;
    provider: string;
    externalId: string;
    providerScope: Record<string, string>;
  }
): ActiveDatastoreBindingConflict | null {
  for (const project of ctx.repos.projects.findAll()) {
    for (const environment of ctx.repos.environments.findByProjectId(project.id)) {
      for (const component of ctx.repos.components.findByEnvironmentId(environment.id)) {
        if (component.type !== target.componentType) continue;
        const bindings = record(component.bindings);
        if (nonEmptyString(bindings?.provider) !== target.provider) continue;
        const boundExternalIds = [
          component.externalId,
          nonEmptyString(bindings?.instanceId),
          nonEmptyString(bindings?.serviceId),
        ].filter((value): value is string => Boolean(value));
        if (!boundExternalIds.includes(target.externalId)) continue;
        const providerScope = record(bindings?.providerScope);
        return {
          projectName: project.name,
          environmentName: environment.name,
          componentId: component.id,
          scopeState: !providerScope
            ? 'missing'
            : exactScope(providerScope, target.providerScope)
              ? 'exact'
              : 'mismatched',
        };
      }
    }
  }
  return null;
}
