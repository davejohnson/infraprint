import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import type { Project } from '../domain/entities/project.entity.js';
import { UNCONFIGURED_HOSTING_PROVIDER } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { resolveProject } from '../domain/services/resolve-project.js';
import { detectGitRemoteUrl, parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { mergeRepoPlatformBindings, readRepoBindingsFile } from '../domain/spec/repo-bindings-file.js';
import { HvError } from './results.js';
import { currentWorkspaceDirectories, selectWorkspaceDirectory } from '../lib/workspace-context.js';

export interface Repos {
  projects: ProjectRepository;
  environments: EnvironmentRepository;
  services: ServiceRepository;
  components: ComponentRepository;
  connections: ConnectionRepository;
  runs: RunRepository;
  audit: AuditRepository;
}

/**
 * Shared context for command handlers: repositories constructed once, plus
 * the standard project/environment resolvers. Every interface uses this same
 * state and provider boundary.
 */
export interface CommandContext {
  repos: Repos;
  secretStore: ReturnType<typeof getSecretStore>;
  adapterFactory: typeof adapterFactory;

  /** Resolve by name/id, repository identity of the active interface workspace, or CLI single-project fallback. */
  resolveProject(opts?: { project?: string }): Project | null;

  /** Like resolveProject but throws HvError(NOT_FOUND | AMBIGUOUS_PROJECT). */
  resolveProjectOrThrow(opts?: { project?: string }): Project;

  /** Resolve environment by name (default "staging"); throws HvError(NOT_FOUND). */
  resolveEnvironmentOrThrow(project: Project, envName?: string): Environment;
}

export function createCommandContext(): CommandContext {
  const repos: Repos = {
    projects: new ProjectRepository(),
    environments: new EnvironmentRepository(),
    services: new ServiceRepository(),
    components: new ComponentRepository(),
    connections: new ConnectionRepository(),
    runs: new RunRepository(),
    audit: new AuditRepository(),
  };

  const firstHostingProvider = (spec: import('../domain/spec/spec.schema.js').ProjectSpec): string => {
    return Object.values(spec.environments)[0]?.hosting.provider ?? UNCONFIGURED_HOSTING_PROVIDER;
  };

  const workspaceDirectories = (): readonly string[] => currentWorkspaceDirectories() ?? [process.cwd()];

  const readRepoBindingsOrThrow = (
    projectName: string,
    startDir?: string
  ): ReturnType<typeof readRepoBindingsFile> => {
    let bindings;
    try {
      bindings = readRepoBindingsFile(projectName, startDir);
    } catch (error) {
      throw new HvError(
        'VALIDATION',
        error instanceof Error ? error.message : 'Repository bindings could not be read safely.',
        { hint: 'Repair the existing .hypervibe/bindings.json file before retrying. Hypervibe will not use stale local identities as a fallback.' }
      );
    }
    return bindings;
  };

  const hydrateRepoBindings = (
    project: Project,
    bindings: NonNullable<ReturnType<typeof readRepoBindingsFile>> | null
  ): void => {
    if (!bindings) return;

    for (const [envName, entry] of Object.entries(bindings.document.environments)) {
      const existing = repos.environments.findByProjectAndName(project.id, envName);
      const platformBindings = entry.platformBindings;
      if (!existing) {
        repos.environments.create({ projectId: project.id, name: envName, platformBindings });
        continue;
      }
      if (JSON.stringify(existing.platformBindings) !== JSON.stringify(platformBindings)) {
        repos.environments.update(existing.id, {
          platformBindings: mergeRepoPlatformBindings(existing.platformBindings, platformBindings),
        });
      }
    }
  };

  const resolveRepoBackedProject = (ref?: string, startDir?: string): Project | null => {
    let repoSpec;
    try {
      repoSpec = readRepoSpecFile(startDir);
    } catch (error) {
      throw new HvError(
        'VALIDATION',
        error instanceof Error ? error.message : 'Repository desired state could not be read safely.',
        { hint: 'Repair the existing .hypervibe/spec.json file before retrying. Hypervibe will not treat unreadable desired state as an uninitialized repository.' }
      );
    }
    if (!repoSpec) return null;
    if (ref && ref !== repoSpec.spec.project) return null;
    // Validate repository identity state before creating or updating local
    // project records. Corrupt bindings must not leave a partial resolution
    // side effect behind when the command ultimately fails closed.
    const repoBindings = readRepoBindingsOrThrow(repoSpec.spec.project, startDir);

    const existing = repos.projects.findByName(repoSpec.spec.project);
    const gitRemoteUrl = repoSpec.spec.gitRemoteUrl ?? detectGitRemoteUrl(startDir) ?? undefined;
    if (existing) {
      const project = gitRemoteUrl && existing.gitRemoteUrl !== gitRemoteUrl
        ? repos.projects.update(existing.id, { gitRemoteUrl }) ?? existing
        : existing;
      hydrateRepoBindings(project, repoBindings);
      return project;
    }

    const project = repos.projects.create({
      name: repoSpec.spec.project,
      defaultPlatform: firstHostingProvider(repoSpec.spec),
      ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    });
    hydrateRepoBindings(project, repoBindings);
    return project;
  };

  const hydrateAndReturn = (project: Project | null, startDir?: string): Project | null => {
    if (project) {
      if (startDir) selectWorkspaceDirectory(startDir);
      hydrateRepoBindings(project, readRepoBindingsOrThrow(project.name, startDir));
    }
    return project;
  };

  const workspaceMatchesProject = (project: Project, startDir: string): boolean => {
    try {
      if (readRepoSpecFile(startDir)?.spec.project === project.name) return true;
    } catch (error) {
      throw new HvError(
        'VALIDATION',
        error instanceof Error ? error.message : 'Repository desired state could not be read safely.',
        { hint: 'Repair the existing .hypervibe/spec.json file before retrying. Hypervibe will not treat unreadable desired state as an uninitialized repository.' }
      );
    }
    const remoteUrl = detectGitRemoteUrl(startDir);
    return Boolean(remoteUrl && repos.projects.findByGitRemoteUrl(remoteUrl)?.id === project.id);
  };

  const resolve = (opts?: { project?: string }): Project | null => {
    const ref = opts?.project?.trim();
    if (!ref) {
      const resolved = new Map<string, { project: Project; startDir: string }>();
      let repositoryIdentityFound = false;
      for (const startDir of workspaceDirectories()) {
        const remoteUrl = detectGitRemoteUrl(startDir);
        if (remoteUrl) {
          repositoryIdentityFound = true;
          const remoteProject = repos.projects.findByGitRemoteUrl(remoteUrl);
          if (remoteProject) {
            resolved.set(remoteProject.id, { project: remoteProject, startDir });
            continue;
          }
        }
        const repoBacked = resolveRepoBackedProject(undefined, startDir);
        if (repoBacked) {
          repositoryIdentityFound = true;
          resolved.set(repoBacked.id, { project: repoBacked, startDir });
        }
      }
      if (resolved.size === 1) {
        const selection = [...resolved.values()][0]!;
        return hydrateAndReturn(selection.project, selection.startDir);
      }
      if (resolved.size > 1 || repositoryIdentityFound || currentWorkspaceDirectories() !== undefined) {
        // Client workspace roots and repository identities are stronger than
        // the legacy single-project fallback. Never select unrelated state.
        return null;
      }
      return hydrateAndReturn(resolveProject({}));
    }
    // Accept either a project id or name in one field.
    const stored = repos.projects.findById(ref) ?? repos.projects.findByName(ref);
    if (stored) {
      const matchingDirectory = workspaceDirectories()
        .find((startDir) => workspaceMatchesProject(stored, startDir));
      return hydrateAndReturn(stored, matchingDirectory);
    }
    for (const startDir of workspaceDirectories()) {
      const repoBacked = resolveRepoBackedProject(ref, startDir);
      if (repoBacked) {
        selectWorkspaceDirectory(startDir);
        return repoBacked;
      }
    }
    return null;
  };

  return {
    repos,
    get secretStore() {
      return getSecretStore();
    },
    adapterFactory,
    resolveProject: resolve,
    resolveProjectOrThrow(opts) {
      const project = resolve(opts);
      if (project) return project;

      const requestedProject = opts?.project?.trim();
      if (requestedProject) {
        const startDir = workspaceDirectories()[0];
        const remoteUrl = startDir ? detectGitRemoteUrl(startDir) : null;
        const repositoryProject = parseGitHubRepoFromRemote(remoteUrl ?? undefined)?.split('/').at(-1)
          ?? (startDir ? findRepoRoot(startDir)?.split(/[\\/]/).filter(Boolean).at(-1) : undefined)
          ?? null;
        const registered = repos.projects.findAll()
          .sort((a, b) => a.name.localeCompare(b.name));
        const registeredProjects = registered
          .slice(0, 10)
          .map(({ id, name }) => ({ id, name }));
        const repositoryMatches = repositoryProject?.toLowerCase() === requestedProject.toLowerCase();
        const registeredSummary = registeredProjects.length > 0
          ? ` Registered projects: ${registeredProjects.map(({ name }) => name).join(', ')}${registered.length > registeredProjects.length ? ', …' : ''}.`
          : ' No projects are registered yet.';
        throw new HvError('NOT_FOUND', `Project "${requestedProject}" was not found in Hypervibe.`, {
          details: {
            requestedProject,
            repositoryProject,
            registeredProjects,
            registeredProjectCount: registered.length,
          },
          hint: repositoryMatches
            ? `The name matches the current repository, but it has not been initialized. Run hv_spec({}) (CLI: hypervibe spec) to inspect its bootstrap contract, then submit the initial spec.${registeredSummary}`
            : `Check the project name before creating anything.${repositoryProject ? ` The current repository suggests "${repositoryProject}", not "${requestedProject}".` : ''}${registeredSummary} Run hv_spec({}) (CLI: hypervibe spec) from the intended repository to see the selected project or fresh-project bootstrap contract.`,
          agentInstruction: {
            action: 'continue',
            message: 'Compare requestedProject with repositoryProject and registeredProjects. If the correction is unambiguous, retry once with the corrected project name. Otherwise ask the user; do not initialize the possibly misspelled name.',
          },
        });
      }

      const startDir = workspaceDirectories()[0];
      const remoteUrl = startDir ? detectGitRemoteUrl(startDir) : null;
      if (remoteUrl) {
        throw new HvError('NOT_FOUND', `No Hypervibe project is initialized for git remote "${remoteUrl}".`, {
          hint: 'Call hv_spec from this repository. A fresh-repository read returns the initialization contract, then hv_spec with spec input creates the project.',
        });
      }

      const all = repos.projects.findAll();
      if (all.length === 0) {
        throw new HvError('NOT_FOUND', 'No projects found.', {
          hint: 'Call hv_spec from a git repository to begin initialization, or inspect existing provider infrastructure with hv_inspect and adopt it with hv_import.',
        });
      }
      throw new HvError('AMBIGUOUS_PROJECT', 'Could not resolve a project from this directory.', {
        hint: 'Pass project explicitly.',
        details: { projects: all.map((p) => ({ id: p.id, name: p.name })) },
      });
    },
    resolveEnvironmentOrThrow(project, envName) {
      const name = envName?.trim() || 'staging';
      const environment = repos.environments.findByProjectAndName(project.id, name);
      if (environment) return environment;

      const existing = repos.environments.findByProjectId(project.id).map((e) => e.name);
      throw new HvError('NOT_FOUND', `Environment "${name}" not found in project "${project.name}".`, {
        hint: existing.length
          ? `Available environments: ${existing.join(', ')}.`
          : 'No environments exist yet — define one in the spec and run hv_apply.',
      });
    },
  };
}

/** Compatibility names while command modules move out of src/tools. */
export type ToolContext = CommandContext;
export const createToolContext = createCommandContext;
