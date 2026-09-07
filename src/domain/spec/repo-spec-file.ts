import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { projectSpecSchema, type ProjectSpec } from './spec.schema.js';
import { primaryWorkspaceDirectory } from '../../lib/workspace-context.js';

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
  envTemplate: RepoEnvTemplateWrite;
}

export interface RepoEnvTemplateWrite {
  path: string;
  addedKeys: string[];
}

const HYPERVIBE_DIR = '.hypervibe';
const SPEC_FILE = 'spec.json';
const ENV_TEMPLATE_FILE = '.env.example';
const RECAPTCHA_ENV_KEYS = ['RECAPTCHA_SITE_KEY', 'RECAPTCHA_SECRET_KEY'] as const;

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

function envTemplateKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

/**
 * Keep product-wide, value-free runtime slots in the conventional repo
 * template. `.env.example` is never a deploy input; real values remain in
 * `.env.<environment>` and enter provider state only through plan/apply.
 */
export function ensureRepoEnvTemplate(root: string): RepoEnvTemplateWrite {
  const templatePath = path.join(root, ENV_TEMPLATE_FILE);
  const existing = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '';
  const existingKeys = envTemplateKeys(existing);
  const addedKeys = RECAPTCHA_ENV_KEYS.filter((key) => !existingKeys.has(key));

  if (addedKeys.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
    const separator = prefix.trim().length > 0 ? '\n' : '';
    const block = [
      '# reCAPTCHA',
      '# The site key is public; keep the secret key server-side.',
      ...addedKeys.map((key) => `${key}=`),
      '',
    ].join('\n');
    writeFileSync(templatePath, `${prefix}${separator}${block}`, 'utf8');
  }

  return { path: templatePath, addedKeys };
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

export function writeRepoSpecFile(spec: ProjectSpec, startDir = primaryWorkspaceDirectory()): RepoSpecWrite | null {
  if (!repoSpecEnabled()) {
    return null;
  }

  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  // A writer must distinguish a missing file from corrupt/conflicting desired
  // state just as strictly as a reader. Repair or intentionally delete a bad
  // file first; never make a lifecycle write silently erase the evidence.
  const existing = readRepoSpecFile(root);
  if (existing && existing.spec.project !== spec.project) {
    return null;
  }

  const dir = path.join(root, HYPERVIBE_DIR);
  mkdirSync(dir, { recursive: true });
  const specPath = repoSpecPath(root);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return { root, path: specPath, envTemplate: ensureRepoEnvTemplate(root) };
}
