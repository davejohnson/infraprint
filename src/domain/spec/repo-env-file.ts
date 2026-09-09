import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { ProjectSpec } from './spec.schema.js';

export interface LocalEnvRequirement {
  key: string;
  /** One concise sentence without the leading comment marker. */
  comment: string;
  /** Value-free guidance for the tracked .env.example template. */
  templateComment?: string;
}

export interface RepoEnvFileWrite {
  path: string;
  addedKeys: string[];
  commentedKeys: string[];
  activatedKeys?: string[];
  /** True when an existing private file had group/world access removed. */
  permissionsUpdated?: boolean;
  /** Present for the local secret-bearing .env, never for the value-free template. */
  gitignorePath?: string;
  gitignoreUpdated?: boolean;
}

const ENV_ASSIGNMENT = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Repository-local ignore state is the deploy safety boundary. Do not let
    // an unreadable or owner-specific global config make these probes flaky,
    // and do not rely on a global excludes file to protect project secrets.
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function assignment(line: string): { key: string; commented: boolean; empty: boolean } | undefined {
  const match = line.match(ENV_ASSIGNMENT);
  if (!match) return undefined;
  const rawValue = (match[3] ?? '').trim();
  return {
    key: match[2],
    commented: Boolean(match[1]),
    empty: rawValue === '' || rawValue === '""' || rawValue === "''",
  };
}

function hasImmediateComment(lines: string[], index: number): boolean {
  return index > 0 && /^\s*#\s*Hypervibe:\s*\S/.test(lines[index - 1] ?? '');
}

function normalizedRequirements(requirements: LocalEnvRequirement[]): LocalEnvRequirement[] {
  const byKey = new Map<string, LocalEnvRequirement>();
  for (const requirement of requirements) {
    const key = requirement.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || byKey.has(key)) continue;
    const comment = requirement.comment.replace(/[\r\n]+/g, ' ').trim();
    if (!comment) continue;
    byKey.set(key, { key, comment });
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function regularFileExists(filePath: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `Refusing to prepare ${filePath} because Hypervibe could not verify that it is a regular file${code ? ` (${code})` : ''}.`
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Refusing to prepare ${filePath} because it is not a regular file. Remove the symlink or other special file and retry Hypervibe.`
    );
  }
  return true;
}

function restrictExistingFileMode(filePath: string, maximumMode: number | undefined): boolean {
  if (maximumMode === undefined || process.platform === 'win32') return false;
  const stat = lstatSync(filePath);
  const currentMode = stat.mode & 0o777;
  const restrictedMode = currentMode & maximumMode;
  if (restrictedMode === currentMode) return false;
  chmodSync(filePath, restrictedMode);
  return true;
}

/**
 * Non-destructively make local configuration requirements fill-in-place.
 * Existing assignments, values, comments, and ordering are retained. Only a
 * missing or stale per-key comment or a missing empty assignment is changed.
 */
export function ensureCommentedEnvFile(
  filePath: string,
  requirements: LocalEnvRequirement[],
  options: { activateEmptyCommentedAssignments?: boolean; createMode?: number } = {}
): RepoEnvFileWrite {
  const normalized = normalizedRequirements(requirements);
  const existed = regularFileExists(filePath);
  const permissionsUpdated = existed
    ? restrictExistingFileMode(filePath, options.createMode)
    : false;
  const existing = existed ? readFileSync(filePath, 'utf8') : '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const hadTrailingNewline = existing.endsWith('\n');
  if (hadTrailingNewline) lines.pop();

  const addedKeys: string[] = [];
  const commentedKeys: string[] = [];
  const activatedKeys: string[] = [];

  for (const requirement of normalized) {
    let index = lines.findIndex((line) => {
      const parsed = assignment(line);
      return parsed?.key === requirement.key && !parsed.commented;
    });
    const comment = `# Hypervibe: ${requirement.comment}`;
    if (index < 0 && options.activateEmptyCommentedAssignments) {
      index = lines.findIndex((line) => {
        const parsed = assignment(line);
        return parsed?.key === requirement.key && parsed.commented && parsed.empty;
      });
      if (index >= 0) {
        lines[index] = lines[index].replace(/^(\s*)#\s*/, '$1');
        activatedKeys.push(requirement.key);
      }
    }
    if (index < 0 && !options.activateEmptyCommentedAssignments) {
      index = lines.findIndex((line) => assignment(line)?.key === requirement.key);
    }
    if (index >= 0) {
      if (hasImmediateComment(lines, index)) {
        if (lines[index - 1] !== comment) {
          lines[index - 1] = comment;
          commentedKeys.push(requirement.key);
        }
      } else {
        lines.splice(index, 0, comment);
        commentedKeys.push(requirement.key);
      }
      continue;
    }

    if (lines.length > 0 && lines.at(-1)?.trim() !== '') {
      lines.push('');
    }
    lines.push(comment, `${requirement.key}=`);
    addedKeys.push(requirement.key);
  }

  if (addedKeys.length > 0 || commentedKeys.length > 0 || activatedKeys.length > 0) {
    regularFileExists(filePath);
    writeFileSync(filePath, `${lines.join(eol)}${eol}`, {
      encoding: 'utf8',
      ...(options.createMode === undefined ? {} : { mode: options.createMode }),
    });
  }

  return {
    path: filePath,
    addedKeys,
    commentedKeys,
    ...(activatedKeys.length > 0 ? { activatedKeys } : {}),
    ...(permissionsUpdated ? { permissionsUpdated: true } : {}),
  };
}

export function assertRepoEnvFilesUntracked(
  root: string,
  fileNames: string[] = ['.env']
): void {
  const protectedNames = protectedRepoEnvFileNames(fileNames);
  assertGitRepositoryRoot(root);
  const tracked = spawnSync('git', ['ls-files', '--', ...protectedNames], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedGitEnvironment(),
  });
  if (tracked.error || tracked.status !== 0) {
    throw new Error(
      'Refusing to prepare local env files because Hypervibe could not verify their git tracking state.'
    );
  }
  const trackedSecretFiles = tracked.stdout
    .split(/\r?\n/)
    .filter(Boolean);
  if (trackedSecretFiles.length > 0) {
    throw new Error(
      `Refusing to prepare local env files because git already tracks ${trackedSecretFiles.join(', ')}. Remove the file from the index without deleting its local value, then retry Hypervibe.`
    );
  }
}

function protectedRepoEnvFileNames(fileNames: string[]): string[] {
  const protectedNames = [...new Set(fileNames)];
  for (const file of protectedNames) {
    if (
      (file !== '.env' && !/^\.env\.[A-Za-z0-9_-]+$/.test(file))
      || file === '.env.example'
    ) {
      throw new Error(
        `Refusing to prepare local env file "${file}" because it is not an exact Hypervibe-generated secret path.`
      );
    }
  }
  return protectedNames;
}

function assertGitRepositoryRoot(root: string): void {
  const repository = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedGitEnvironment(),
  });
  if (repository.error || repository.status !== 0) {
    throw new Error(
      'Refusing to prepare local env files because Hypervibe could not verify the git repository.'
    );
  }

  const reportedRoot = repository.stdout.trim();
  try {
    if (!reportedRoot || realpathSync(reportedRoot) !== realpathSync(root)) {
      throw new Error('repository root mismatch');
    }
  } catch {
    throw new Error(
      'Refusing to prepare local env files because Hypervibe could not verify the git repository root.'
    );
  }
}

function repoPathIsIgnored(root: string, file: string): boolean {
  const ignored = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', '--', file],
    { cwd: root, stdio: 'ignore', env: isolatedGitEnvironment() }
  );
  if (ignored.error || (ignored.status !== 0 && ignored.status !== 1)) {
    throw new Error(
      `Refusing to prepare local env files because Hypervibe could not verify whether ${file} is ignored by git.`
    );
  }
  return ignored.status === 0;
}

function assertEnvExampleValueFree(root: string): void {
  const envExamplePath = path.join(root, '.env.example');
  if (!regularFileExists(envExamplePath)) return;
  const nonEmptyKeys = readFileSync(envExamplePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => assignment(line))
    .filter((entry): entry is Exclude<ReturnType<typeof assignment>, undefined> => (
      entry !== undefined && !entry.empty
    ))
    .map((entry) => entry.key);
  if (nonEmptyKeys.length === 0) return;

  throw new Error(
    `Refusing to make .env.example trackable because it contains non-empty assignment(s) for ${[...new Set(nonEmptyKeys)].sort().join(', ')}. Move every value into the gitignored .env, leave the matching .env.example assignments empty, and retry Hypervibe.`
  );
}

export function ensureRepoEnvFilesIgnored(
  root: string,
  protectedFileNames: string[] = ['.env']
): { path: string; updated: boolean } {
  const gitignorePath = path.join(root, '.gitignore');
  regularFileExists(gitignorePath);
  const protectedNames = protectedRepoEnvFileNames(protectedFileNames);
  for (const file of protectedNames) {
    regularFileExists(path.join(root, file));
  }
  assertRepoEnvFilesUntracked(root, protectedNames);

  const missingIgnoreRules = protectedNames.filter((file) => !repoPathIsIgnored(root, file));
  const envExampleIgnored = repoPathIsIgnored(root, '.env.example');
  if (missingIgnoreRules.length === 0 && !envExampleIgnored) {
    return { path: gitignorePath, updated: false };
  }
  if (envExampleIgnored) {
    assertEnvExampleValueFree(root);
  }

  const existing = regularFileExists(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  let next = existing;
  if (next && !next.endsWith('\n')) next += '\n';
  if (next.trim() && !next.endsWith('\n\n')) next += '\n';
  next += [
    '# Hypervibe local secrets',
    ...missingIgnoreRules.map((file) => `/${file}`),
    ...(envExampleIgnored ? ['!/.env.example'] : []),
    '',
  ].join('\n');
  if (envExampleIgnored) {
    assertEnvExampleValueFree(root);
  }
  regularFileExists(gitignorePath);
  writeFileSync(gitignorePath, next, 'utf8');

  if (
    protectedNames.some((file) => !repoPathIsIgnored(root, file))
    || repoPathIsIgnored(root, '.env.example')
  ) {
    throw new Error(
      'Refusing to prepare local env files because Hypervibe could not establish a safe git ignore policy.'
    );
  }
  return { path: gitignorePath, updated: true };
}

function joinDestinations(values: string[]): string {
  return [...new Set(values)].sort().join(', ');
}

/**
 * Return only value-free inputs explicitly declared by this project spec.
 * Ordinary envVars already have reviewed values in the spec, while database,
 * queue, storage, email, messaging, and Stripe output slots are generated by
 * Hypervibe and must not become user-supplied placeholders. Hypervibe-owned
 * secrets are generated inside a reviewed plan and likewise never become
 * local input placeholders.
 */
export function specLocalEnvRequirements(spec: ProjectSpec): LocalEnvRequirement[] {
  const requirements: LocalEnvRequirement[] = [];

  for (const [key, secret] of Object.entries(spec.secrets)) {
    if (secret.ownership !== 'delegated') continue;
    const runtimeDestinations = secret.environments.map((environment) => `${environment} runtime`);
    const actionsDestinations = [
      ...(secret.githubActions?.repository ? ['repository GitHub Actions'] : []),
      ...(secret.githubActions?.environments ?? []).map((environment) => `${environment} GitHub Actions`),
    ];
    const destinations = joinDestinations([...runtimeDestinations, ...actionsDestinations]);
    requirements.push({
      key,
      comment: `${secret.required ? 'Required' : 'Optional'} delegated secret for ${destinations}; add the value locally, then pass this key to hv_plan through secretRefs.`,
      templateComment: `${secret.required ? 'Required' : 'Optional'} delegated secret for ${destinations}; keep this template empty and place the value only in the gitignored .env before passing this key to hv_plan through secretRefs.`,
    });
  }

  const envFileDestinations = new Map<string, string[]>();
  for (const [environmentName, environment] of Object.entries(spec.environments)) {
    if (!environment.envFile || environment.envFile.mode === 'off') continue;
    for (const key of environment.envFile.include) {
      if (environment.envFile.exclude.includes(key)) continue;
      const destinations = envFileDestinations.get(key) ?? [];
      destinations.push(environmentName);
      envFileDestinations.set(key, destinations);
    }
  }
  for (const [key, destinations] of envFileDestinations) {
    const environments = joinDestinations(destinations);
    requirements.push({
      key,
      comment: `Explicit deploy input for ${environments}; add the local value here or override it in .env.${destinations.sort()[0]}.`,
      templateComment: `Explicit deploy input for ${environments}; keep this template empty and place the value only in the gitignored .env or its private .env.${destinations.sort()[0]} override.`,
    });
  }

  return requirements;
}

export function ensureRepoLocalEnv(
  root: string,
  requirements: LocalEnvRequirement[]
): RepoEnvFileWrite {
  // Establish the repository safety boundary before creating or changing the
  // fill-in credential file, so a partial write cannot leave secrets trackable.
  const gitignore = ensureRepoEnvFilesIgnored(root);
  return {
    ...ensureCommentedEnvFile(path.join(root, '.env'), requirements, {
      activateEmptyCommentedAssignments: true,
      createMode: 0o600,
    }),
    gitignorePath: gitignore.path,
    gitignoreUpdated: gitignore.updated,
  };
}

export function ensureRepoEnvTemplate(
  root: string,
  requirements: LocalEnvRequirement[]
): RepoEnvFileWrite {
  const templateRequirements = requirements.map((requirement) => ({
    key: requirement.key,
    comment: requirement.templateComment
      ?? 'Required by Hypervibe; keep this template empty and place the value only in the gitignored .env.',
  }));
  return ensureCommentedEnvFile(path.join(root, '.env.example'), templateRequirements);
}
