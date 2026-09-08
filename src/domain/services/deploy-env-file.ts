import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { parseEnvFile } from '../../utils/env-parser.js';
import { findRepoRoot } from '../spec/repo-spec-file.js';
import { ensureRepoEnvFilesIgnored } from '../spec/repo-env-file.js';
import { primaryWorkspaceDirectory } from '../../lib/workspace-context.js';

export interface DeployEnvFileResult {
  path: string;
  baseEnvPath?: string;
  createdEnvSpecificPath?: string;
  syncedFromBaseKeys?: string[];
  divergentFromBaseKeys?: string[];
  missingEnvSpecificPath?: string;
  usedBaseEnvFallback?: boolean;
  /** True when Hypervibe removed group/world access from its existing default private file. */
  permissionsUpdated?: boolean;
  vars: Record<string, string>;
  skippedKeys: string[];
  ignoredKeys: string[];
  excludedKeys: string[];
  localValueKeys: string[];
  /** Selected keys whose assignment exists but has no usable value. */
  emptyKeys: string[];
}

export type DeployEnvFileMode = 'runtime' | 'all' | 'explicit' | 'off';

const PROVIDER_ONLY_EXACT_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'BITWARDEN_ACCESS_TOKEN',
  'BITWARDEN_ORGANIZATION_ID',
  'BWS_ACCESS_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_REGISTRAR_API_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  'CODECOV_TOKEN',
  'DOPPLER_TOKEN',
  'FLY_API_TOKEN',
  'FLY_ACCESS_TOKEN',
  'GCP_ARTIFACT_REPOSITORY',
  'GCP_PROJECT_ID',
  'GCP_REGION',
  'GCP_SERVICE_ACCOUNT_JSON',
  'GCLOUD_PROJECT',
  'GH_TOKEN',
  'GHCR_TOKEN',
  'GHCR_USERNAME',
  'GITHUB_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'HEROKU_API_KEY',
  'HEROKU_API_TOKEN',
  'IMAGE_REGISTRY_TOKEN',
  'IMAGE_REGISTRY_USERNAME',
  'NETLIFY_AUTH_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_CONFIG_TOKEN',
  'NPM_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'RAILWAY_API_TOKEN',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_IDS',
  'RAILWAY_TOKEN',
  'RENDER_API_KEY',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'VAULT_ADDR',
  'VAULT_ROLE_ID',
  'VAULT_SECRET_ID',
  'VAULT_TOKEN',
  'VERCEL_TOKEN',
]);

const PROVIDER_ONLY_PREFIXES = [
  'HYPERVIBE_',
  'RAILWAY_',
];

const RUNTIME_EXACT_KEYS = new Set([
  'APP_BASE_URL',
  'AUTH_SECRET',
  'BASE_URL',
  'COOKIE_SECRET',
  'CSRF_SECRET',
  'ENCRYPTION_KEY',
  'JWT_SECRET',
  'NEXTAUTH_SECRET',
  'SENDGRID_API_KEY',
  'SESSION_SECRET',
  'SITE_URL',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
]);

const RUNTIME_PREFIXES = [
  'APP_',
  'NEXT_PUBLIC_',
  'PUBLIC_',
  'REACT_APP_',
  'VITE_',
];

const RUNTIME_SUFFIXES = [
  '_API_KEY',
  '_DSN',
  '_KEY',
  '_PRIVATE_KEY',
  '_PUBLIC_KEY',
  '_SECRET',
  '_TOKEN',
  '_URL',
];

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function isProviderOnlyDeployEnvKey(key: string): boolean {
  return PROVIDER_ONLY_EXACT_KEYS.has(key)
    || PROVIDER_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isRuntimeDeployEnvKey(key: string): boolean {
  return RUNTIME_EXACT_KEYS.has(key)
    || RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix))
    || RUNTIME_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function envFileSuffix(envName: string | undefined): string | null {
  const trimmed = envName?.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function assignmentKeyFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const assignment = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trim()
    : trimmed;
  const eqIndex = assignment.indexOf('=');
  if (eqIndex === -1) return null;
  const key = assignment.slice(0, eqIndex).trim();
  return isValidEnvKey(key) ? key : null;
}

function ensureTrailingNewline(content: string): string {
  if (!content) return '';
  return content.endsWith('\n') ? content : `${content}\n`;
}

function restrictExistingEnvFileMode(filePath: string): boolean {
  if (process.platform === 'win32') return false;
  const stat = lstatSync(filePath);
  if (!stat.isFile()) {
    throw new Error(
      `Refusing to prepare ${filePath} because it is not a regular file. Remove the symlink or other special file and retry Hypervibe.`
    );
  }
  const currentMode = stat.mode & 0o777;
  const restrictedMode = currentMode & 0o600;
  if (restrictedMode === currentMode) return false;
  chmodSync(filePath, restrictedMode);
  return true;
}

function assignmentLinesByKey(content: string): Map<string, string> {
  const lines = content.split(/\r?\n/);
  const byKey = new Map<string, string>();
  for (const line of lines) {
    const key = assignmentKeyFromLine(line);
    if (key) {
      // parseEnvFile keeps the last duplicate assignment; mirror that here.
      byKey.set(key, line);
    }
  }
  return byKey;
}

function filteredBaseEnvContent(baseContent: string, copyableKeys: Set<string>): string {
  const eol = baseContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = baseContent.split(/\r?\n/);
  return lines
    .filter((line, index) => {
      const key = assignmentKeyFromLine(line);
      if (key) return copyableKeys.has(key);
      if (/^\s*#\s*Hypervibe:/.test(line)) {
        const nextKey = assignmentKeyFromLine(lines[index + 1] ?? '');
        if (nextKey && !copyableKeys.has(nextKey)) return false;
      }
      return true;
    })
    .join(eol);
}

function syncEnvSpecificFromBase(basePath: string, envSpecificPath: string, excludedKeys = new Set<string>()): {
  created: boolean;
  syncedKeys: string[];
  divergentKeys: string[];
  emptyKeys: string[];
  skippedProviderKeys: string[];
} {
  const baseContent = readFileSync(basePath, 'utf-8');
  const baseVars = parseEnvFile(basePath);
  const envSpecificExists = existsSync(envSpecificPath);
  const envSpecificVars = envSpecificExists ? parseEnvFile(envSpecificPath) : {};
  const absentBaseKeys = Object.keys(baseVars)
    .filter((key) => !excludedKeys.has(key) && !(key in envSpecificVars));
  const skippedProviderKeys = absentBaseKeys
    .filter((key) => isProviderOnlyDeployEnvKey(key))
    .sort();
  const emptyKeys = absentBaseKeys
    .filter((key) => !isProviderOnlyDeployEnvKey(key) && baseVars[key].trim() === '')
    .sort();
  const copyableKeys = absentBaseKeys
    .filter((key) => !isProviderOnlyDeployEnvKey(key) && baseVars[key].trim() !== '')
    .sort();

  if (!envSpecificExists) {
    writeFileSync(
      envSpecificPath,
      filteredBaseEnvContent(baseContent, new Set(copyableKeys)),
      { encoding: 'utf-8', mode: 0o600 }
    );
    return {
      created: true,
      syncedKeys: copyableKeys,
      divergentKeys: [],
      emptyKeys,
      skippedProviderKeys,
    };
  }

  const syncedKeys = copyableKeys;
  const divergentKeys = Object.keys(baseVars)
    .filter((key) =>
      !excludedKeys.has(key)
      && !isProviderOnlyDeployEnvKey(key)
      && baseVars[key].trim() !== ''
      && key in envSpecificVars
      && envSpecificVars[key] !== baseVars[key]
    )
    .sort();

  if (syncedKeys.length > 0) {
    const linesByKey = assignmentLinesByKey(baseContent);
    const linesToAppend = syncedKeys
      .map((key) => linesByKey.get(key))
      .filter((line): line is string => Boolean(line));
    if (linesToAppend.length > 0) {
      const envSpecificContent = readFileSync(envSpecificPath, 'utf-8');
      const block = [
        '# Copied from .env by Hypervibe. Review before deploying if values should differ.',
        ...linesToAppend,
      ].join('\n');
      writeFileSync(envSpecificPath, `${ensureTrailingNewline(envSpecificContent)}\n${block}\n`, 'utf-8');
    }
  }

  return { created: false, syncedKeys, divergentKeys, emptyKeys, skippedProviderKeys };
}

function hostLooksLocal(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '0.0.0.0'
    || normalized === 'host.docker.internal'
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal');
}

function plainHostCandidate(value: string): string | null {
  if (value.includes('://')) return null;
  const token = value.trim().split(/\s+/)[0] ?? '';
  if (!token || token.includes('=')) return null;
  const withoutCredentials = token.includes('@')
    ? token.slice(token.lastIndexOf('@') + 1)
    : token;
  const hostPort = withoutCredentials.split(/[/?#]/)[0] ?? '';
  if (!hostPort) return null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    return close > 0 ? hostPort.slice(1, close) : null;
  }
  return hostPort.split(':')[0] ?? null;
}

export function valueLooksLocal(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) return false;
  if (/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)\b/.test(lower)) {
    return true;
  }

  const candidates = lower.match(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`,)]+/g) ?? [];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (hostLooksLocal(host)) {
        return true;
      }
    } catch {
      // Keep checking the remaining candidates.
    }
  }
  const plainHost = plainHostCandidate(lower);
  if (plainHost && hostLooksLocal(plainHost)) return true;
  return false;
}

export function defaultDeployEnvFilePath(startDir = primaryWorkspaceDirectory(), envName?: string): string | null {
  return resolveDefaultDeployEnvFile(startDir, envName).path;
}

function resolveDefaultDeployEnvFile(startDir = primaryWorkspaceDirectory(), envName?: string, options: { syncEnvSpecific?: boolean; excludedKeys?: string[] } = {}): {
  path: string | null;
  baseEnvPath?: string;
  createdEnvSpecificPath?: string;
  syncedFromBaseKeys?: string[];
  divergentFromBaseKeys?: string[];
  missingEnvSpecificPath?: string;
  usedBaseEnvFallback?: boolean;
  permissionsUpdated?: boolean;
  emptyFromBaseKeys?: string[];
  skippedFromBaseKeys?: string[];
} {
  const root = findRepoRoot(startDir);
  if (!root) return { path: null };
  const suffix = envFileSuffix(envName);
  const basePath = path.join(root, '.env');
  const envSpecificPath = suffix ? path.join(root, `.env.${suffix}`) : null;
  if (
    options.syncEnvSpecific
    && (existsSync(basePath) || (envSpecificPath !== null && existsSync(envSpecificPath)))
  ) {
    ensureRepoEnvFilesIgnored(root, [
      '.env',
      ...(envSpecificPath ? [path.basename(envSpecificPath)] : []),
    ]);
  }
  const basePermissionsUpdated = options.syncEnvSpecific && existsSync(basePath)
    ? restrictExistingEnvFileMode(basePath)
    : false;
  if (envSpecificPath && existsSync(envSpecificPath)) {
    const envSpecificPermissionsUpdated = options.syncEnvSpecific
      ? restrictExistingEnvFileMode(envSpecificPath)
      : false;
    const permissionsUpdated = basePermissionsUpdated || envSpecificPermissionsUpdated;
    if (options.syncEnvSpecific && existsSync(basePath)) {
      const sync = syncEnvSpecificFromBase(basePath, envSpecificPath, new Set(options.excludedKeys ?? []));
      if (
        sync.syncedKeys.length === 0
        && sync.emptyKeys.length === 0
        && sync.skippedProviderKeys.length === 0
        && !permissionsUpdated
      ) {
        return { path: envSpecificPath };
      }
      return {
        path: envSpecificPath,
        ...(permissionsUpdated ? { permissionsUpdated: true } : {}),
        ...(sync.syncedKeys.length > 0
          ? {
              baseEnvPath: basePath,
              syncedFromBaseKeys: sync.syncedKeys,
              ...(sync.divergentKeys.length > 0 ? { divergentFromBaseKeys: sync.divergentKeys } : {}),
            }
          : {}),
        ...(sync.emptyKeys.length > 0 ? { emptyFromBaseKeys: sync.emptyKeys } : {}),
        ...(sync.skippedProviderKeys.length > 0 ? { skippedFromBaseKeys: sync.skippedProviderKeys } : {}),
      };
    }
    return {
      path: envSpecificPath,
      ...(permissionsUpdated ? { permissionsUpdated: true } : {}),
    };
  }
  if (existsSync(basePath)) {
    if (envSpecificPath && options.syncEnvSpecific) {
      const sync = syncEnvSpecificFromBase(basePath, envSpecificPath, new Set(options.excludedKeys ?? []));
      return {
        path: envSpecificPath,
        baseEnvPath: basePath,
        ...(basePermissionsUpdated ? { permissionsUpdated: true } : {}),
        ...(sync.created ? { createdEnvSpecificPath: envSpecificPath } : {}),
        ...(sync.syncedKeys.length > 0 ? { syncedFromBaseKeys: sync.syncedKeys } : {}),
        ...(sync.emptyKeys.length > 0 ? { emptyFromBaseKeys: sync.emptyKeys } : {}),
        ...(sync.skippedProviderKeys.length > 0 ? { skippedFromBaseKeys: sync.skippedProviderKeys } : {}),
      };
    }
    return {
      path: basePath,
      ...(basePermissionsUpdated ? { permissionsUpdated: true } : {}),
      ...(envSpecificPath ? { missingEnvSpecificPath: envSpecificPath, usedBaseEnvFallback: true } : {}),
    };
  }
  return {
    path: null,
    ...(envSpecificPath ? { missingEnvSpecificPath: envSpecificPath } : {}),
  };
}

export function loadDeployEnvFile(options: {
  envFile?: string;
  includeEnvFile?: boolean;
  mode?: DeployEnvFileMode;
  includeKeys?: string[];
  excludeKeys?: string[];
  envName?: string;
  startDir?: string;
  syncEnvSpecific?: boolean;
} = {}): DeployEnvFileResult | null {
  const mode = options.mode ?? 'runtime';
  if (options.includeEnvFile === false || mode === 'off') return null;
  const resolvedDefault = options.envFile
    ? { path: path.resolve(options.startDir ?? primaryWorkspaceDirectory(), options.envFile) }
    : resolveDefaultDeployEnvFile(options.startDir, options.envName, {
      syncEnvSpecific: options.syncEnvSpecific !== false,
      excludedKeys: options.excludeKeys,
    });
  const filePath = resolvedDefault.path;
  if (!filePath) return null;

  const parsed = parseEnvFile(filePath);
  const vars: Record<string, string> = {};
  const candidates = new Map(Object.entries(parsed));
  for (const key of resolvedDefault.emptyFromBaseKeys ?? []) {
    if (!candidates.has(key)) candidates.set(key, '');
  }
  for (const key of resolvedDefault.skippedFromBaseKeys ?? []) {
    if (!candidates.has(key)) candidates.set(key, '');
  }
  const skippedKeys = new Set<string>();
  const ignoredKeys = new Set<string>();
  const excludedKeys = new Set<string>();
  const localValueKeys = new Set<string>();
  const emptyKeys = new Set<string>();
  const includeKeys = new Set(options.includeKeys ?? []);
  const excludedKeySet = new Set(options.excludeKeys ?? []);
  for (const [key, value] of candidates) {
    if (!isValidEnvKey(key) || isProviderOnlyDeployEnvKey(key)) {
      skippedKeys.add(key);
      continue;
    }
    if (excludedKeySet.has(key)) {
      excludedKeys.add(key);
      continue;
    }
    const selected = includeKeys.has(key)
      || mode === 'all'
      || (mode === 'runtime' && isRuntimeDeployEnvKey(key));
    if (!selected) {
      ignoredKeys.add(key);
      continue;
    }
    if (value.trim() === '') {
      emptyKeys.add(key);
      continue;
    }
    if (mode === 'runtime' && !includeKeys.has(key) && valueLooksLocal(value)) {
      localValueKeys.add(key);
      continue;
    }
    vars[key] = value;
  }

  return {
    path: filePath,
    ...(resolvedDefault.baseEnvPath ? { baseEnvPath: resolvedDefault.baseEnvPath } : {}),
    ...(resolvedDefault.createdEnvSpecificPath ? { createdEnvSpecificPath: resolvedDefault.createdEnvSpecificPath } : {}),
    ...(resolvedDefault.syncedFromBaseKeys ? { syncedFromBaseKeys: resolvedDefault.syncedFromBaseKeys } : {}),
    ...(resolvedDefault.divergentFromBaseKeys ? { divergentFromBaseKeys: resolvedDefault.divergentFromBaseKeys } : {}),
    ...(resolvedDefault.missingEnvSpecificPath ? { missingEnvSpecificPath: resolvedDefault.missingEnvSpecificPath } : {}),
    ...(resolvedDefault.usedBaseEnvFallback ? { usedBaseEnvFallback: true } : {}),
    ...(resolvedDefault.permissionsUpdated ? { permissionsUpdated: true } : {}),
    vars,
    skippedKeys: [...skippedKeys].sort(),
    ignoredKeys: [...ignoredKeys].sort(),
    excludedKeys: [...excludedKeys].sort(),
    localValueKeys: [...localValueKeys].sort(),
    emptyKeys: [...emptyKeys].sort(),
  };
}
