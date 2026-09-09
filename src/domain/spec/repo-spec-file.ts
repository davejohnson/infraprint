import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { projectSpecSchema, type ProjectSpec } from './spec.schema.js';
import { primaryWorkspaceDirectory } from '../../lib/workspace-context.js';
import {
  detectGitRemoteUrl,
  normalizeGitRemoteIdentity,
  parseRepositoryPathFromRemote,
} from '../../lib/git-remote.js';
import {
  ensureCommentedEnvFile,
  ensureRepoEnvTemplate,
  ensureRepoEnvFilesIgnored,
  specLocalEnvRequirements,
  type RepoEnvFileWrite,
} from './repo-env-file.js';

export interface RepoSpecFile {
  root: string;
  path: string;
  /** Original JSON document, retained for release-contract hashing. */
  document: unknown;
  spec: ProjectSpec;
}

export interface RepoSpecWrite {
  root: string;
  path: string;
  envTemplate: RepoEnvFileWrite;
  localEnv: RepoEnvFileWrite;
}

export interface RepoSpecWritePreflight {
  root: string;
  project: string;
  gitignore: { path: string; updated: boolean };
}

const HYPERVIBE_DIR = '.hypervibe';
const SPEC_FILE = 'spec.json';

export function repoSpecEnabled(): boolean {
  const disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC?.trim().toLowerCase();
  return disabled !== '1' && disabled !== 'true' && disabled !== 'yes';
}

export function findRepoRoot(startDir = primaryWorkspaceDirectory()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, '.git');
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory() || stat.isFile()) {
          return current;
        }
      } catch {
        // Keep walking if the marker cannot be read.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function repoSpecPath(root: string): string {
  return path.join(root, HYPERVIBE_DIR, SPEC_FILE);
}

export interface RepositoryProjectIdentity {
  projectName?: string;
  gitRemoteUrl?: string;
}

/**
 * Derive the repository identity used by both fresh-project selection and
 * repo-backed spec writes. A configured remote is stronger than the checkout
 * directory name; a remote-less repository falls back to its basename.
 */
export function repositoryProjectIdentity(root: string): RepositoryProjectIdentity {
  const gitRemoteUrl = detectGitRemoteUrl(root) ?? undefined;
  const repositoryPath = parseRepositoryPathFromRemote(gitRemoteUrl);
  const remoteProjectName = repositoryPath?.split('/').filter(Boolean).at(-1);
  const directoryName = path.basename(root) || undefined;
  return {
    ...(remoteProjectName || directoryName ? { projectName: remoteProjectName ?? directoryName } : {}),
    ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
  };
}

export function repositoryMatchesProjectIdentity(
  root: string,
  projectName: string,
  expectedGitRemoteUrl?: string
): boolean {
  const identity = repositoryProjectIdentity(root);
  const actualRemote = normalizeGitRemoteIdentity(identity.gitRemoteUrl);
  const expectedRemote = normalizeGitRemoteIdentity(expectedGitRemoteUrl);
  if (expectedGitRemoteUrl?.trim()) {
    // A stored remote is stronger identity evidence than a coincidental
    // checkout basename. If the current origin cannot be read or either side
    // cannot be normalized safely, fail closed instead of falling back.
    return Boolean(actualRemote && expectedRemote && actualRemote === expectedRemote);
  }
  return Boolean(
    identity.projectName
    && identity.projectName.toLowerCase() === projectName.trim().toLowerCase()
  );
}

/**
 * Validate the repository boundary before any durable desired-state write.
 * This is deliberately separate from writeRepoSpecFile so callers that also
 * journal a revision can fail before either the repo spec or journal changes.
 */
export function preflightRepoSpecWrite(
  spec: ProjectSpec,
  startDir = primaryWorkspaceDirectory(),
  projectGitRemoteUrl?: string
): RepoSpecWritePreflight | null {
  if (!repoSpecEnabled()) {
    return null;
  }

  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const existing = readRepoSpecFile(root);
  if (existing && existing.spec.project !== spec.project) {
    return null;
  }
  if (
    !existing
    && !repositoryMatchesProjectIdentity(
      root,
      spec.project,
      spec.gitRemoteUrl ?? projectGitRemoteUrl
    )
  ) {
    return null;
  }

  return {
    root,
    project: spec.project,
    gitignore: ensureRepoEnvFilesIgnored(root),
  };
}

export function readRepoSpecFile(startDir = primaryWorkspaceDirectory()): RepoSpecFile | null {
  if (!repoSpecEnabled()) {
    return null;
  }

  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const specPath = repoSpecPath(root);
  let raw: string;
  try {
    raw = readFileSync(specPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`${specPath} could not be read${code ? ` (${code})` : ''}. Fix the file permissions and retry.`);
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(`${specPath} is not valid JSON. Fix the file (or intentionally delete it to fall back to the local spec) and retry.`);
  }
  const parsed = projectSpecSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${specPath} does not match the project spec schema: ${issues}. Fix the file (or delete it to fall back to the local spec) and retry.`);
  }
  return { root, path: specPath, document, spec: parsed.data };
}

export function writePreflightedRepoSpecFile(
  spec: ProjectSpec,
  preflight: RepoSpecWritePreflight
): RepoSpecWrite {
  if (preflight.project !== spec.project) {
    throw new Error('Refusing to write a repo spec with a preflight prepared for another project.');
  }

  // Prepare the ancillary dotenv files before advancing the committed source
  // of truth. A failed local/template write may leave only safe, value-free
  // placeholder additions behind; it must not publish a spec that the revision
  // journal never records.
  const requirements = specLocalEnvRequirements(spec);
  const localEnv = ensureCommentedEnvFile(path.join(preflight.root, '.env'), requirements, {
    activateEmptyCommentedAssignments: true,
    createMode: 0o600,
  });
  const envTemplate = ensureRepoEnvTemplate(preflight.root, requirements);

  const dir = path.join(preflight.root, HYPERVIBE_DIR);
  mkdirSync(dir, { recursive: true });
  const specPath = repoSpecPath(preflight.root);
  const stagedSpecPath = path.join(dir, `.${SPEC_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(stagedSpecPath, `${JSON.stringify(spec, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    renameSync(stagedSpecPath, specPath);
  } finally {
    rmSync(stagedSpecPath, { force: true });
  }

  return {
    root: preflight.root,
    path: specPath,
    envTemplate,
    localEnv: {
      ...localEnv,
      gitignorePath: preflight.gitignore.path,
      gitignoreUpdated: preflight.gitignore.updated,
    },
  };
}

export function writeRepoSpecFile(spec: ProjectSpec, startDir = primaryWorkspaceDirectory()): RepoSpecWrite | null {
  // A writer must distinguish a missing file from corrupt/conflicting desired
  // state just as strictly as a reader. It must also establish the local-env
  // safety boundary before overwriting desired state.
  const preflight = preflightRepoSpecWrite(spec, startDir);
  return preflight ? writePreflightedRepoSpecFile(spec, preflight) : null;
}
