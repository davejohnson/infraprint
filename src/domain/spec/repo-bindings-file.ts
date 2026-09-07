import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { findRepoRoot, repoSpecEnabled } from './repo-spec-file.js';
import { withStorageInstanceScopes } from '../services/storage-instance-identity.js';
import { primaryWorkspaceDirectory } from '../../lib/workspace-context.js';

// Bindings are the inverse of the spec's source-of-truth contract: the DB
// column `environments.platform_bindings` is authoritative (it holds data the
// sanitizer strips), and `.hypervibe/bindings.json` is a sanitized export so
// teammates can converge the same provider resources.

export interface RepoBindingsEnvironment {
  platformBindings: Record<string, unknown>;
}

export interface RepoBindingsFile {
  version: 1;
  project: string;
  environments: Record<string, RepoBindingsEnvironment>;
}

const HYPERVIBE_DIR = '.hypervibe';
const BINDINGS_FILE = 'bindings.json';
const SENSITIVE_KEY_PATTERN = /(^|_)?(secret|token|password|connectionstring|connectionurl|databaseurl|databaseprivateurl|privateurl|privatekey|apikey)($|_)?/i;
const repoBindingsFileSchema = z.object({
  version: z.literal(1),
  project: z.string().trim().min(1),
  environments: z.record(
    z.string().min(1),
    z.object({
      platformBindings: z.record(z.unknown()),
    }).strict()
  ),
}).strict();

function bindingsPath(root: string): string {
  return path.join(root, HYPERVIBE_DIR, BINDINGS_FILE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mergeSanitizedBindingObject(
  existing: Record<string, unknown>,
  repoBindings: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...repoBindings };
  for (const [key, existingValue] of Object.entries(existing)) {
    if (!(key in repoBindings)) {
      if (SENSITIVE_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, ''))) {
        merged[key] = existingValue;
      }
      continue;
    }
    const existingRecord = asRecord(existingValue);
    const repoRecord = asRecord(repoBindings[key]);
    if (existingRecord && repoRecord) {
      merged[key] = mergeSanitizedBindingObject(existingRecord, repoRecord);
    }
  }
  return merged;
}

/**
 * Overlay the sanitized repository export onto authoritative local bindings.
 * Top-level bindings absent from the export retain the historical merge
 * behavior. Within a shared binding, only fields omitted by the sanitizer are
 * retained so ordinary public metadata can still be removed by the export.
 */
export function mergeRepoPlatformBindings(
  existing: Record<string, unknown>,
  repoBindings: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...repoBindings };
  for (const [key, repoValue] of Object.entries(repoBindings)) {
    const existingRecord = asRecord(existing[key]);
    const repoRecord = asRecord(repoValue);
    if (existingRecord && repoRecord) {
      merged[key] = mergeSanitizedBindingObject(existingRecord, repoRecord);
    }
  }
  return merged;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, ''))) {
      continue;
    }
    const sanitizedChild = sanitize(child);
    const sanitizedRecord = asRecord(sanitizedChild);
    if (sanitizedRecord && Object.keys(sanitizedRecord).length === 0) {
      continue;
    }
    sanitized[key] = sanitizedChild;
  }
  return sanitized;
}

function presentStorageInstanceScopes(platformBindings: Record<string, unknown>): Record<string, unknown> {
  const storage = asRecord(platformBindings.storage);
  const providerContexts = asRecord(platformBindings.storageProviders);
  if (!storage || !providerContexts) return platformBindings;
  return {
    ...platformBindings,
    storage: withStorageInstanceScopes(storage, providerContexts),
  };
}

function parseDocument(raw: unknown, file: string, projectName?: string): RepoBindingsFile {
  const parsed = repoBindingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `${file} does not match the repository bindings schema: ${issues}. `
      + 'Fix the file (or intentionally delete it when no shared bindings should remain) and retry.'
    );
  }
  if (projectName && parsed.data.project !== projectName) {
    throw new Error(
      `${file} belongs to project "${parsed.data.project}", not resolved project "${projectName}". `
      + 'Use the matching checkout or repair the repository bindings project identity before retrying.'
    );
  }

  const normalized: RepoBindingsFile['environments'] = {};
  for (const [envName, value] of Object.entries(parsed.data.environments)) {
    normalized[envName] = {
      platformBindings: sanitize(value.platformBindings) as Record<string, unknown>,
    };
  }
  return {
    version: 1,
    project: parsed.data.project,
    environments: normalized,
  };
}

function readExistingBindingsFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`${file} could not be read${code ? ` (${code})` : ''}. Fix the file permissions and retry.`);
  }
}

function parseBindingsJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `${file} is not valid JSON. Fix the file (or intentionally delete it when no shared bindings should remain) and retry.`
    );
  }
}

export function readRepoBindingsFile(projectName?: string, startDir = primaryWorkspaceDirectory()): { path: string; document: RepoBindingsFile } | null {
  if (!repoSpecEnabled()) {
    return null;
  }
  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }
  const file = bindingsPath(root);
  const raw = readExistingBindingsFile(file);
  if (raw === null) return null;
  const document = parseDocument(parseBindingsJson(raw, file), file, projectName);
  return { path: file, document };
}

export function writeRepoBindingsForEnvironment(project: Project, environment: Environment, startDir = primaryWorkspaceDirectory()): string | null {
  if (!repoSpecEnabled()) {
    return null;
  }
  const root = findRepoRoot(startDir);
  if (!root) {
    return null;
  }

  const file = bindingsPath(root);
  const raw = readExistingBindingsFile(file);
  const current = raw === null
    ? { version: 1 as const, project: project.name, environments: {} }
    : parseDocument(parseBindingsJson(raw, file), file, project.name);

  const platformBindings = presentStorageInstanceScopes(
    sanitize(environment.platformBindings) as Record<string, unknown>
  );
  if (Object.keys(platformBindings).length === 0) {
    delete current.environments[environment.name];
  } else {
    current.environments[environment.name] = { platformBindings };
  }
  if (Object.keys(current.environments).length === 0) {
    if (raw !== null) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return file;
}
