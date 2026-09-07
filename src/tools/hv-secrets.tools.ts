import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import type { CommandRegistrar } from '../application/commands.js';
import { commandError, commandSuccess, HvError, wrapCommandHandler } from '../application/results.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Service } from '../domain/entities/service.entity.js';
import {
  SECRET_MANAGER_PROVIDERS,
} from '../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { connectionSetupOptions } from '../domain/services/connection-guidance.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { readHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { envField, projectField } from './schemas.js';
import { suppliedOptionNames } from '../application/command-options.js';

const REDACTED = '[redacted]';

async function managerAdapter(
  ctx: CommandContext,
  provider: (typeof SECRET_MANAGER_PROVIDERS)[number],
  project?: string
) {
  const connection = ctx.repos.connections.findByProvider(provider);
  if (!connection || connection.status !== 'verified') {
    throw new HvError('MISSING_CONNECTION', `No verified connection for ${provider}.`, {
      ...connectionSetupOptions(provider, { project }),
    });
  }
  const credentials = ctx.secretStore.decryptObject(connection.credentialsEncrypted);
  const adapter = secretManagerRegistry.createAdapter(provider, credentials);
  await adapter.connect(credentials);
  return adapter;
}

function githubRepoForProject(project: Project | null, repoArg?: string): { owner: string; repo: string } {
  const full = repoArg ?? (project ? parseGitHubRepoFromRemote(project.gitRemoteUrl) : null) ?? undefined;
  if (!full || !full.includes('/')) {
    throw new HvError('VALIDATION', 'Could not determine the GitHub repository.', {
      hint: 'Pass repo="owner/name" or set the project gitRemoteUrl.',
    });
  }
  const [owner, repo] = full.split('/');
  return { owner, repo };
}

function resolveHostingService(
  ctx: CommandContext,
  project: Project,
  environmentName: string,
  requestedService?: string
): Service {
  const requested = requestedService?.trim();
  const stored = ctx.repos.services.findByProjectId(project.id)
    .find((candidate, index) => requested ? candidate.name === requested : index === 0);
  if (stored) return stored;

  const environmentSpec = new SpecStore().get(project)?.spec.environments[environmentName];
  const serviceName = requested || Object.keys(environmentSpec?.services ?? {})[0];
  const serviceSpec = serviceName ? environmentSpec?.services[serviceName] : undefined;
  if (!serviceName || !serviceSpec) {
    throw new HvError('NOT_FOUND', requested ? `Service not found: ${requested}` : 'No services found.');
  }

  const timestamp = new Date(0);
  return {
    id: `desired:${project.id}:${serviceName}`,
    projectId: project.id,
    name: serviceName,
    buildConfig: { ...serviceSpec },
    envVarSpec: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function registerHvSecretsTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_secrets',
    'Secret read modes: {} or {project} lists sources; {provider,pathPrefix?} lists one manager; {provider,path,key?,version?} checks one manager value; {include:["github"],project?,repo?} lists GitHub Actions names; {project?,env,service?,key?} inspects masked hosting variables. Hosting mode requires explicit env. Values are never returned.',
    {
      project: projectField.describe('Optional Hypervibe project name/id for validated context. Project-only still lists sources. Omit to use no project context for source/manager lists or auto-detect only in GitHub/hosting modes.'),
      env: envField.describe('Exact environment for hosting-variable inspection. Required in hosting mode; never inferred from project alone.'),
      key: z.string().min(1).optional().describe('Hosting variable name or key within a manager secret'),
      provider: z.enum(SECRET_MANAGER_PROVIDERS).optional(),
      path: z.string().min(1).optional().describe('Secret-manager path'),
      version: z.string().min(1).optional().describe('Secret-manager version'),
      service: z.string().min(1).optional().describe('Hosting service name'),
      pathPrefix: z.string().min(1).optional().describe('With provider and no path: restrict listed manager paths'),
      include: z.array(z.literal('github')).optional().describe('Also list GitHub Actions secret names'),
      repo: z.string().min(1).optional().describe('GitHub owner/name; defaults to the project git remote'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, key, provider, path, version, service, pathPrefix, include, repo }) => {
      const selectedProject = projectRef
        ? ctx.resolveProjectOrThrow({ project: projectRef })
        : null;
      const managerLookup = path !== undefined || version !== undefined || (provider !== undefined && key !== undefined);
      if (managerLookup) {
        const incompatible = suppliedOptionNames({ env, service, pathPrefix, include, repo });
        if (incompatible.length > 0) {
          throw new HvError('VALIDATION', `Manager value lookup received options for another secret mode: ${incompatible.join(', ')}.`);
        }
        if (!provider || !path) throw new HvError('VALIDATION', 'provider and path must be passed together.');
        const secret = await (await managerAdapter(ctx, provider, selectedProject?.name)).getSecret(path, key, version);
        return commandSuccess({
          secretRef: `${provider}://${path}${key ? `#${key}` : ''}${version ? `@${version}` : ''}`,
          value: REDACTED,
          present: secret.value.length > 0,
          version: secret.version,
        });
      }

      if (provider || pathPrefix !== undefined || include !== undefined || repo !== undefined) {
        const incompatible = suppliedOptionNames({ env, service, key });
        if (incompatible.length > 0) {
          throw new HvError('VALIDATION', `Secret listing received hosting lookup options: ${incompatible.join(', ')}.`, {
            hint: 'Remove the listed options to enumerate names, or remove provider/include/repo/pathPrefix and pass env for masked hosting-variable inspection.',
          });
        }
        return listSecrets({ selectedProject, provider, pathPrefix, include, repo });
      }

      const hostingLookup = env !== undefined || key !== undefined || service !== undefined;
      if (!hostingLookup) {
        const sources = [...SECRET_MANAGER_PROVIDERS, 'github'].map((source) => {
          const connections = ctx.repos.connections.findAllByProvider(source);
          return {
            source,
            status: connections.some((connection) => connection.status === 'verified')
              ? 'verified'
              : connections.length > 0 ? 'unverified' : 'missing',
          };
        });
        return commandSuccess({
          ...(selectedProject ? { project: { id: selectedProject.id, name: selectedProject.name } } : {}),
          sources,
        }, {
          hint: 'Pass provider to list manager paths, include=["github"] plus project/repo to list GitHub names, or project/env/service to inspect masked hosting variables.',
        });
      }

      if (!env) {
        throw new HvError('VALIDATION', 'env is required for hosting-variable inspection.', {
          hint: 'Pass project (optional), env (required), and optional service/key. Use project alone to list secret sources.',
        });
      }

      const project = selectedProject ?? ctx.resolveProjectOrThrow();
      const environment = ctx.resolveEnvironmentOrThrow(project, env);
      const targetService = resolveHostingService(ctx, project, environment.name, service);
      const result = await readHostingEnvVars({ project, environment, service: targetService });
      if (!result.success) {
        if (result.connectionUnavailable) {
          const scope = getProjectScopeHints(project)
            .find((hint) => !hint.includes('://') && !hint.includes('github.com/'));
          return commandError('MISSING_CONNECTION', result.error, {
            ...connectionSetupOptions(result.provider, { project: project.name, scope }),
          });
        }
        return commandError('PROVIDER_ERROR', result.error);
      }
      if (key && !(key in result.variables)) {
        return commandError('NOT_FOUND', `Variable ${key} not set in ${environment.name}.`, {
          details: { available: Object.keys(result.variables) },
        });
      }
      const names = key ? [key] : Object.keys(result.variables);
      return commandSuccess({
        environment: environment.name,
        service: targetService.name,
        vars: Object.fromEntries(names.map((name) => [name, REDACTED])),
      });
    })
  );

  async function listSecrets({
    selectedProject,
    provider,
    pathPrefix,
    include,
    repo,
  }: {
    selectedProject: Project | null;
    provider?: (typeof SECRET_MANAGER_PROVIDERS)[number];
    pathPrefix?: string;
    include?: 'github'[];
    repo?: string;
  }) {
      if (!provider && !include?.includes('github')) {
        throw new HvError('VALIDATION', 'Pass provider to list manager paths or include=["github"].');
      }
      const sections: Record<string, unknown> = {};
      if (provider) {
        const secrets = await (await managerAdapter(ctx, provider, selectedProject?.name)).listSecrets(pathPrefix);
        sections.manager = {
          provider,
          count: secrets.length,
          secrets: secrets.map(({ path, keys }) => ({ path, keys })),
        };
      }
      if (include?.includes('github')) {
        const project = selectedProject ?? (repo ? null : ctx.resolveProjectOrThrow());
        const { owner, repo: repoName } = githubRepoForProject(project, repo);
        const gh = getGitHubAdapter(`${owner}/${repoName}`);
        if ('error' in gh) {
          return commandError('MISSING_CONNECTION', gh.error, {
            ...connectionSetupOptions('github', {
              project: project?.name,
              scope: `${owner}/${repoName}`,
            }),
          });
        }
        const secrets = await gh.adapter.listSecrets(owner, repoName);
        sections.github = {
          repository: `${owner}/${repoName}`,
          secrets: secrets.secrets.map((secret) => secret.name),
        };
      }
      return commandSuccess(sections);
  }
}
