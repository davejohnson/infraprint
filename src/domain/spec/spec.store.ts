import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import type { Project } from '../entities/project.entity.js';
import { projectSpecSchema, type ProjectSpec, type EnvironmentSpec, type ServiceSpec } from './spec.schema.js';
import { readRepoSpecFile, writeRepoSpecFile } from './repo-spec-file.js';

/** Shape of the legacy policies.desiredState blob (pre-spec). */
interface LegacyDesiredState {
  environmentName?: string;
  services?: string[];
  serviceName?: string;
  crons?: Record<string, { schedule: string; command?: string; timeZone?: string }>;
  domain?: string;
  databaseProvider?: string;
  setupEmail?: boolean;
  serviceConfig?: Record<string, {
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
    branch?: string;
    branches?: { staging?: string; production?: string };
  };
  migrations?: { mode?: 'none' | 'releaseCommand' | 'tool'; runInDeploy?: boolean; command?: string };
}

function classifyEnvironmentName(name: string): 'staging' | 'production' | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.includes('prod')) return 'production';
  if (normalized.includes('stag')) return 'staging';
  return null;
}

/**
 * Convert a legacy policies.desiredState blob into a v1 ProjectSpec.
 * Returns null when the project has no legacy desired state.
 */
export function desiredStateToSpec(project: Project): ProjectSpec | null {
  const desired = (project.policies as { desiredState?: LegacyDesiredState })?.desiredState;
  if (!desired || typeof desired !== 'object') return null;

  const envName = desired.environmentName?.trim() || 'staging';

  const services: Record<string, ServiceSpec> = {};
  const serviceNames = new Set<string>(desired.services ?? []);
  if (desired.serviceName) serviceNames.add(desired.serviceName);
  for (const name of Object.keys(desired.serviceConfig ?? {})) serviceNames.add(name);

  for (const name of serviceNames) {
    const config = desired.serviceConfig?.[name] ?? {};
    services[name] = {
      workloadKind: config.cronSchedule ? 'cron' : 'web',
      ...(config.startCommand ? { startCommand: config.startCommand } : {}),
      ...(config.releaseCommand ? { releaseCommand: config.releaseCommand } : {}),
      ...(config.healthCheckPath ? { healthCheckPath: config.healthCheckPath } : {}),
      ...(config.cronSchedule ? { cronSchedule: config.cronSchedule } : {}),
      ...(config.public !== undefined ? { public: config.public } : {}),
    };
  }
  for (const [name, cron] of Object.entries(desired.crons ?? {})) {
    services[name] = {
      ...(services[name] ?? {}),
      workloadKind: 'cron',
      cronSchedule: cron.schedule,
      ...(cron.command ? { startCommand: cron.command } : {}),
      ...(cron.timeZone ? { timeZone: cron.timeZone } : {}),
    };
  }

  const branchKind = classifyEnvironmentName(envName);
  const branch = desired.deploy?.strategy === 'branch'
    ? desired.deploy.branch
      ?? (branchKind === 'production' ? desired.deploy.branches?.production : undefined)
      ?? (branchKind === 'staging' ? desired.deploy.branches?.staging : undefined)
      ?? 'main'
    : undefined;

  const environment: EnvironmentSpec = {
    hosting: { provider: project.defaultPlatform },
    services,
    ...(desired.databaseProvider ? { database: { provider: desired.databaseProvider, engine: 'postgres' as const } } : {}),
    ...(desired.domain ? { domain: desired.domain } : {}),
    email: { enabled: Boolean(desired.setupEmail) },
    envVars: desired.envVars ?? {},
    ...(desired.deploy?.strategy
      ? {
        deploy: {
          strategy: desired.deploy.strategy,
          ...(desired.deploy.trigger ? { trigger: desired.deploy.trigger } : {}),
          ...(branch ? { branch } : {}),
        },
      }
      : {}),
    ...(desired.migrations?.mode
      ? {
        migrations: {
          mode: desired.migrations.mode,
          ...(desired.migrations.runInDeploy !== undefined ? { runInDeploy: desired.migrations.runInDeploy } : {}),
          ...(desired.migrations.command ? { command: desired.migrations.command } : {}),
        },
      }
      : {}),
  };

  return projectSpecSchema.parse({
    version: 1,
    project: project.name,
    ...(project.gitRemoteUrl ? { gitRemoteUrl: project.gitRemoteUrl } : {}),
    environments: { [envName]: environment },
  });
}

/**
 * Deep-merge a patch into a base document.
 * Objects merge recursively; arrays and scalars replace; `null` deletes a key
 * (used to remove a service or environment from the spec).
 */
export function deepMergeSpec(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === undefined) {
    return patch === undefined ? base : patch;
  }
  const baseObject = (typeof base === 'object' && base !== null && !Array.isArray(base))
    ? base as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = { ...baseObject };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = deepMergeSpec(baseObject[key], value);
    }
  }
  return result;
}

/** Old documents remain readable; the next explicit spec update writes the canonical GitHub shape. */
export function canonicalizeLegacyGitHubSpec(document: unknown): unknown {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const source = document as Record<string, unknown>;
  if (source.github || !source.collaboration || typeof source.collaboration !== 'object' || Array.isArray(source.collaboration)) {
    return document;
  }
  const legacy = source.collaboration as Record<string, unknown>;
  const { collaboration: _legacy, ...rest } = source;
  return {
    ...rest,
    github: {
      ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
      ...(legacy.repository !== undefined ? { repository: legacy.repository } : {}),
      ...(legacy.canonicalEnvironment !== undefined ? { canonicalEnvironment: legacy.canonicalEnvironment } : {}),
      collaboration: {
        ...(legacy.issues !== undefined ? { issues: legacy.issues } : {}),
        ...(legacy.pullRequests !== undefined ? { pullRequests: legacy.pullRequests } : {}),
        ...(legacy.collaborators !== undefined ? { collaborators: legacy.collaborators } : {}),
      },
    },
  };
}

export interface SpecResult {
  spec: ProjectSpec;
  revision: number;
  source?: { kind: 'repo'; path: string } | { kind: 'local' };
  envTemplate?: { path: string; addedKeys: string[] };
  /**
   * True when `.hypervibe/spec.json` changed outside hypervibe (or was seen
   * for the first time) and was just recorded as a new revision. Callers
   * should surface this so out-of-band edits are visible, not silent.
   */
  adopted?: boolean;
}

function sameSpec(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function repoSpecMatchesProject(spec: ProjectSpec, project: Project): boolean {
  return spec.project === project.name;
}

function parseStoredSpec(document: unknown, projectId: string, revision: number): ProjectSpec {
  const parsed = projectSpecSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || '(root)';
    throw new Error(
      `Cannot read stored desired state for project ${projectId} at revision ${revision}: `
      + `persisted JSON has an invalid shape (${path}: ${issue?.message ?? 'unknown'}). `
      + 'Hypervibe refuses to treat unreadable desired state as empty.'
    );
  }
  return parsed.data;
}

function writeMatchingRepoSpec(project: Project, spec: ProjectSpec) {
  const existing = readRepoSpecFile();
  if (existing && !repoSpecMatchesProject(existing.spec, project)) {
    return null;
  }
  return writeRepoSpecFile(spec);
}

/**
 * Revisioned storage for project specs. Every write creates a new revision —
 * hv_plan records the revision it planned against, and hv_apply rejects
 * plans whose revision has been superseded.
 *
 * Source-of-truth contract: the repo file `.hypervibe/spec.json` is the
 * desired state when it exists and names this project; the `project_specs`
 * table is the revision journal behind it (stale-plan rejection, history).
 * When the repo file diverges from the latest revision, the repo file wins
 * and is recorded as a new revision with `adopted: true` on the result.
 * Bindings are the inverse: `environments.platform_bindings` (DB) is
 * authoritative and `.hypervibe/bindings.json` is a sanitized export — see
 * repo-bindings-file.ts.
 */
export class SpecStore {
  private repo = new ProjectSpecRepository();

  /**
   * Latest spec for a project. Lazily converts a legacy policies.desiredState
   * blob into revision 1 the first time a project is read.
   */
  get(project: Project): SpecResult | null {
    const repoSpec = readRepoSpecFile();
    if (repoSpec && repoSpecMatchesProject(repoSpec.spec, project)) {
      const latest = this.repo.findLatest(project.id);
      if (latest) {
        const parsed = parseStoredSpec(latest.document, project.id, latest.revision);
        if (sameSpec(parsed, repoSpec.spec)) {
          return { spec: repoSpec.spec, revision: latest.revision, source: { kind: 'repo', path: repoSpec.path } };
        }
      }

      const row = this.repo.insert(project.id, (latest?.revision ?? 0) + 1, repoSpec.spec);
      return { spec: repoSpec.spec, revision: row.revision, source: { kind: 'repo', path: repoSpec.path }, adopted: true };
    }

    const latest = this.repo.findLatest(project.id);
    if (latest) {
      return {
        spec: parseStoredSpec(latest.document, project.id, latest.revision),
        revision: latest.revision,
        source: { kind: 'local' },
      };
    }

    const converted = desiredStateToSpec(project);
    if (!converted) return null;
    const row = this.repo.insert(project.id, 1, converted);
    const written = writeMatchingRepoSpec(project, converted);
    return {
      spec: converted,
      revision: row.revision,
      source: written ? { kind: 'repo', path: written.path } : { kind: 'local' },
      ...(written ? { envTemplate: written.envTemplate } : {}),
    };
  }

  getRevision(projectId: string, revision: number): ProjectSpec | null {
    const row = this.repo.findByRevision(projectId, revision);
    if (!row) return null;
    return parseStoredSpec(row.document, projectId, revision);
  }

  /** Replace the spec wholesale. Returns the new revision. */
  replace(project: Project, spec: unknown): SpecResult {
    const parsed = projectSpecSchema.parse(spec);
    if (parsed.project !== project.name) {
      throw new Error(`Spec project "${parsed.project}" does not match target project "${project.name}".`);
    }
    // Validate any repository source of truth before appending a local
    // revision. Otherwise a corrupt repo file could make the write fail only
    // after the journal had already accepted a divergent desired state.
    const repoSpec = readRepoSpecFile();
    const shouldWriteRepoSpec = !repoSpec || repoSpecMatchesProject(repoSpec.spec, project);
    const latest = this.repo.findLatest(project.id);
    const row = this.repo.insert(project.id, (latest?.revision ?? 0) + 1, parsed);
    const written = shouldWriteRepoSpec ? writeRepoSpecFile(parsed) : null;
    return {
      spec: parsed,
      revision: row.revision,
      source: written ? { kind: 'repo', path: written.path } : { kind: 'local' },
      ...(written ? { envTemplate: written.envTemplate } : {}),
    };
  }

  /** Deep-merge a patch into the latest spec (or a fresh skeleton). */
  merge(project: Project, patch: unknown): SpecResult {
    const current = this.get(project)?.spec
      ?? { version: 1 as const, project: project.name, environments: {} };
    const merged = deepMergeSpec(current, patch);
    return this.replace(project, merged);
  }
}
