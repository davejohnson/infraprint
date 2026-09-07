import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import {
  serviceBindingFor,
  removeServiceBinding,
  removeServiceFromDesiredState,
} from '../domain/services/spec.service.js';
import { parseQueueBindings } from '../domain/services/queue-plan.service.js';
import type { CommandContext } from '../application/context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler } from '../application/results.js';
import { inspectProvider } from '../application/inspect-provider.js';
import { importProvider } from '../application/import-provider.js';
import { suppliedOptionNames } from '../application/command-options.js';

export function registerLifecycleTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_inspect',
    'Read-only provider forensics. Modes: {} lists providers plus each resource selector contract; {provider,...} inspects a provider account/resource; {provider,project,env} performs full live environment inspection. Project/env without provider is invalid, and limit is accepted only by modes advertising acceptsLimit=true. Never writes Hypervibe local state or provider resources.',
    {
      provider: z.string().trim().min(1).optional().describe('Registered provider name. Required whenever any selector is supplied. Use hv_inspect({})—no parameters—for provider discovery.'),
      project: z.string().optional().describe('Hypervibe project name or id. Requires provider. Required with env; without env it may help choose the project-scoped provider connection.'),
      env: z.string().optional().describe('Exact environment name. Live environment inspection requires provider, project, and env; this command does not default to staging.'),
      scope: z.string().trim().min(1).optional().describe('Provider connection/account/repository/domain scope, such as owner/repo or example.com.'),
      resource: z.string().trim().min(1).optional().describe('Provider-owned resource class returned by the provider listing, such as project, ref, pages, zone, or dns.'),
      id: z.string().trim().min(1).optional().describe('Exact durable provider resource id.'),
      name: z.string().trim().min(1).optional().describe('Exact provider resource name when an id is not known.'),
      region: z.string().trim().min(1).optional().describe('Explicit provider region only for inspection modes whose discovery contract accepts region (including hosting environment forensics).'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results only for inspection modes whose discovery entry has acceptsLimit=true (default 25, hard maximum 100). Omit it for connection and single-resource modes.'),
    },
    wrapCommandHandler(async (input) => commandSuccess(await inspectProvider(ctx, input)))
  );

  commands.register(
    'hv_import',
    'Import provider identity into Hypervibe. mode="adopt" adopts an existing provider project through a provider-declared driver. Cleanup modes retain an exact inventoried hosting boundary, database, cache, or provider-declared resource so isolated plan/apply can delete only that identity. Never creates provider infrastructure.',
    {
      provider: z.string().trim().min(1).describe('Registered source provider. Providers without a tested adoption driver return UNSUPPORTED.'),
      mode: z.enum(['adopt', 'retained-cleanup', 'retained-database-cleanup', 'retained-cache-cleanup', 'retained-resource-cleanup']).optional().describe('Default adopt. Cleanup modes retain an exact abandoned hosting, database, cache, or provider-declared resource identity for later confirmation-gated plan/apply.'),
      resource: z.string().trim().min(1).optional().describe('Exact provider-declared resource class for retained-resource-cleanup, as advertised by hv_inspect discovery.'),
      project: projectField.optional().describe('Current Hypervibe project; required for every retained cleanup mode.'),
      env: envField.optional().describe('Current Hypervibe environment; required for every retained cleanup mode.'),
      region: z.string().trim().min(1).optional().describe('Explicit provider region when the selected cleanup inspection contract requires it.'),
      name: z.string().optional().describe('Existing provider project name to adopt. Use hv_inspect first if you only need to read provider state.'),
      id: z.string().optional().describe('Exact durable provider id for adoption or cleanup, copied from hv_inspect.'),
      force: z.boolean().optional().describe('Set true to override the safety check when a Hypervibe project with the same name already exists.'),
      environmentMappings: z
        .record(z.string(), z.string().trim().min(1))
        .refine((mappings) => Object.keys(mappings).length > 0, 'environmentMappings must contain at least one mapping')
        .optional()
        .describe('Map provider environment names to Hypervibe environments (e.g., {"prod-us-east": "production", "blue": "staging"})'),
      storageMappings: z.record(
        z.string(),
        z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'storage names: lowercase alphanumeric and dashes, starting with a letter')
      ).optional().describe('Map provider storage ids to desired storage names (e.g. {"bucket-id":"uploads"}).'),
      databaseMappings: z.record(z.string(), z.enum(['postgres'])).optional().describe('Map provider service ids to PostgreSQL components. Datastore candidates are shown by hv_inspect.'),
      cacheMappings: z.record(z.string(), z.enum(['redis'])).optional().describe('Map provider service ids to Redis components. Datastore candidates are shown by hv_inspect.'),
      confirm: confirmField,
    },
    wrapCommandHandler(async (input) => importProvider(ctx, input))
  );

  commands.register(
    'hv_destroy',
    'Delete LOCAL Hypervibe records only: a project (cascade), an environment, or a service (including its platform binding). Never touches provider resources — to destroy live infrastructure, remove it from the spec with hv_spec, then run hv_plan and hv_apply with the exact confirmActions ids. Without confirm=true this returns CONFIRM_REQUIRED listing exactly what local records would be deleted.',
    {
      project: projectField,
      env: envField.describe('Environment name; required only for scope="environment". Do not pass it for project or service scope.'),
      scope: z.enum(['project', 'environment', 'service']).describe('What to delete: the whole project record, one environment record, or one service record'),
      name: z.string().optional().describe('Service name (required when scope="service")'),
      confirm: confirmField,
    },
    wrapCommandHandler(async ({ project: projectRef, env, scope, name, confirm }) => {
      const incompatible = suppliedOptionNames(scope === 'project'
        ? { env, name }
        : scope === 'environment'
          ? { name }
          : { env });
      if (incompatible.length > 0) {
        return commandError('VALIDATION', `scope="${scope}" received options for another destroy scope: ${incompatible.join(', ')}.`, {
          hint: `Remove the listed options before confirming scope="${scope}".`,
        });
      }
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const providerNote = 'Provider resources were not touched — destroy live infrastructure via hv_spec + hv_plan + hv_apply with exact confirmActions ids.';

      if (scope === 'project') {
        const environments = ctx.repos.environments.findByProjectId(project.id);
        const services = ctx.repos.services.findByProjectId(project.id);
        const summary = {
          project: { id: project.id, name: project.name },
          environments: environments.map((e) => e.name),
          services: services.map((s) => s.name),
        };

        if (!confirm) {
          return commandError('CONFIRM_REQUIRED', `This would delete the local project "${project.name}" with ${environments.length} environment(s) and ${services.length} service(s). No provider resources are affected.`, {
            details: summary,
            hint: 'Re-run hv_destroy with confirm=true to delete these local records.',
          });
        }

        ctx.repos.projects.delete(project.id);
        ctx.repos.audit.create({
          action: 'project.deleted',
          resourceType: 'project',
          resourceId: project.id,
          details: { name: project.name },
        });

        return commandSuccess({ deleted: { scope: 'project', ...summary } }, { hint: providerNote });
      }

      if (scope === 'environment') {
        const environment = ctx.resolveEnvironmentOrThrow(project, env);

        if (!confirm) {
          return commandError('CONFIRM_REQUIRED', `This would delete the local environment "${environment.name}" of project "${project.name}" (including its platform bindings). No provider resources are affected.`, {
            details: { environment: { id: environment.id, name: environment.name } },
            hint: 'Re-run hv_destroy with confirm=true to delete this local record.',
          });
        }

        const queueBindings = Object.entries(parseQueueBindings(environment))
          .filter(([, binding]) => binding.backend === 'pubsub')
          .map(([queueName]) => queueName);

        ctx.repos.environments.delete(environment.id);
        ctx.repos.audit.create({
          action: 'environment.deleted',
          resourceType: 'environment',
          resourceId: environment.id,
          details: { project: project.name, name: environment.name },
        });

        return commandSuccess(
          { deleted: { scope: 'environment', project: project.name, environment: environment.name } },
          {
            hint: providerNote,
            ...(queueBindings.length > 0
              ? { warnings: [`Pub/Sub topics for queue(s) ${queueBindings.join(', ')} were not deleted; remove queues from the spec and apply first if you want them gone.`] }
              : {}),
          }
        );
      }

      // scope === 'service'
      if (!name?.trim()) {
        return commandError('VALIDATION', 'name is required when scope="service".', {
          hint: 'Pass the service name to delete, e.g. name="web".',
        });
      }

      const service = ctx.repos.services.findByProjectAndName(project.id, name.trim());
      if (!service) {
        const available = ctx.repos.services.findByProjectId(project.id).map((s) => s.name);
        return commandError('NOT_FOUND', `Service "${name}" not found in project "${project.name}".`, {
          details: { available },
        });
      }

      const boundEnvironments = ctx.repos.environments
        .findByProjectId(project.id)
        .filter((environment) => serviceBindingFor(environment, service.name));

      if (!confirm) {
        return commandError('CONFIRM_REQUIRED', `This would delete the local service "${service.name}" from project "${project.name}" and remove its binding from ${boundEnvironments.length} environment(s). No provider resources are affected.`, {
          details: {
            service: { id: service.id, name: service.name },
            bindingsRemovedFrom: boundEnvironments.map((e) => e.name),
          },
          hint: 'Re-run hv_destroy with confirm=true to delete these local records.',
        });
      }

      for (const environment of boundEnvironments) {
        removeServiceBinding(environment.id, environment, service.name);
      }
      ctx.repos.services.delete(service.id);

      // Mirror legacy service_delete: drop the service from any legacy
      // desired-state policy so old apply flows don't recreate it.
      const desiredState = project.policies?.desiredState && typeof project.policies.desiredState === 'object' && !Array.isArray(project.policies.desiredState)
        ? project.policies.desiredState as Record<string, unknown>
        : undefined;
      const nextDesiredState = removeServiceFromDesiredState(desiredState, service.name);
      if (nextDesiredState) {
        ctx.repos.projects.update(project.id, {
          policies: { ...(project.policies ?? {}), desiredState: nextDesiredState },
        });
      }

      ctx.repos.audit.create({
        action: 'service.deleted',
        resourceType: 'service',
        resourceId: service.id,
        details: { project: project.name, name: service.name },
      });

      return commandSuccess(
        {
          deleted: {
            scope: 'service',
            project: project.name,
            service: service.name,
            bindingsRemovedFrom: boundEnvironments.map((e) => e.name),
          },
        },
        { hint: `${providerNote} If the spec still declares "${service.name}", remove it with hv_spec too.` }
      );
    })
  );
}
