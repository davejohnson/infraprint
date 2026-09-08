import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { defaultDeployEnvFilePath, loadDeployEnvFile, valueLooksLocal } from '../deploy-env-file.js';

function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function initRepo(root: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: root, env: isolatedGitEnv() });
}

function isIgnored(root: string, file: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', file], {
      cwd: root,
      stdio: 'ignore',
      env: isolatedGitEnv(),
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

describe('deploy-env-file', () => {
  it('loads repo .env by default and skips provider credentials', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, [
      'SENDGRID_API_KEY=SG.runtime',
      'RECAPTCHA_SITE_KEY=site-key',
      'RECAPTCHA_SECRET_KEY=secret-key',
      'SESSION_SECRET=session-runtime',
      'SENTRY_DSN=https://public@example.ingest.sentry.io/1',
      'WEBHOOK_URL=http://localhost:4040/webhook',
      'REDIS_URL=redis://127.0.0.1:6379',
      'PRIVATE_DATABASE_URL=postgres://app:pw@db.railway.internal:5432/app',
      'SEARCH_URL=search.internal:9200',
      'LOCAL_DEBUG_FLAG=1',
      'RAILWAY_API_TOKEN=provider-token',
      'GITHUB_TOKEN=github-provider-token',
      'SENTRY_AUTH_TOKEN=sentry-provider-token',
      'NPM_TOKEN=npm-provider-token',
      'VERCEL_TOKEN=vercel-provider-token',
      '',
    ].join('\n'), { mode: 0o600 });

    expect(defaultDeployEnvFilePath(path.join(root, 'app'))).toBe(envPath);
    expect(loadDeployEnvFile({ startDir: path.join(root, 'app') })).toEqual({
      path: envPath,
      vars: {
        RECAPTCHA_SECRET_KEY: 'secret-key',
        RECAPTCHA_SITE_KEY: 'site-key',
        SENDGRID_API_KEY: 'SG.runtime',
        SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
        SESSION_SECRET: 'session-runtime',
      },
      ignoredKeys: ['LOCAL_DEBUG_FLAG'],
      skippedKeys: ['GITHUB_TOKEN', 'NPM_TOKEN', 'RAILWAY_API_TOKEN', 'SENTRY_AUTH_TOKEN', 'VERCEL_TOKEN'],
      excludedKeys: [],
      localValueKeys: ['PRIVATE_DATABASE_URL', 'REDIS_URL', 'SEARCH_URL', 'WEBHOOK_URL'],
      emptyKeys: [],
    });
  });

  it('prefers environment-specific env files over the base .env', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-specific-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const prodPath = path.join(root, '.env.production');
    writeFileSync(basePath, 'SENDGRID_API_KEY=SG.base\n', { mode: 0o600 });
    writeFileSync(prodPath, 'SENDGRID_API_KEY=SG.prod\n', { mode: 0o600 });

    expect(defaultDeployEnvFilePath(path.join(root, 'app'), 'production')).toBe(prodPath);
    expect(loadDeployEnvFile({ startDir: path.join(root, 'app'), envName: 'production' })).toEqual({
      path: prodPath,
      vars: {
        SENDGRID_API_KEY: 'SG.prod',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
      emptyKeys: [],
    });
    expect(defaultDeployEnvFilePath(path.join(root, 'app'), 'bad/env')).toBe(basePath);
  });

  it('removes group and world access from existing base and environment-specific files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-permissions-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const productionPath = path.join(root, '.env.production');
    writeFileSync(basePath, 'SENDGRID_API_KEY=SG.base\n', { mode: 0o600 });
    writeFileSync(productionPath, 'SENDGRID_API_KEY=SG.prod\n');
    chmodSync(basePath, 0o644);
    chmodSync(productionPath, 0o644);

    expect(loadDeployEnvFile({
      startDir: path.join(root, 'app'),
      envName: 'production',
    })).toEqual({
      path: productionPath,
      permissionsUpdated: true,
      vars: {
        SENDGRID_API_KEY: 'SG.prod',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
      emptyKeys: [],
    });
    expect(statSync(basePath).mode & 0o777).toBe(0o600);
    expect(statSync(productionPath).mode & 0o777).toBe(0o600);

    const second = loadDeployEnvFile({
      startDir: path.join(root, 'app'),
      envName: 'production',
    });
    expect(second).not.toHaveProperty('permissionsUpdated');
    expect(statSync(basePath).mode & 0o777).toBe(0o600);
    expect(statSync(productionPath).mode & 0o777).toBe(0o600);
  });

  it('does not change permissions for an explicit arbitrary env file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-explicit-permissions-'));
    initRepo(root);
    const explicitPath = path.join(root, 'private.env');
    writeFileSync(explicitPath, 'SENDGRID_API_KEY=SG.explicit\n');
    chmodSync(explicitPath, 0o644);

    const result = loadDeployEnvFile({
      startDir: root,
      envFile: 'private.env',
    });

    expect(result).not.toHaveProperty('permissionsUpdated');
    expect(statSync(explicitPath).mode & 0o777).toBe(0o644);
  });

  it('creates an environment-specific env file from base .env when it is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-fallback-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const stagingPath = path.join(root, '.env.staging');
    writeFileSync(basePath, 'SENDGRID_API_KEY=SG.base\n', { mode: 0o600 });

    expect(defaultDeployEnvFilePath(path.join(root, 'app'), 'staging')).toBe(basePath);
    expect(loadDeployEnvFile({ startDir: path.join(root, 'app'), envName: 'staging' })).toEqual({
      path: stagingPath,
      baseEnvPath: basePath,
      createdEnvSpecificPath: stagingPath,
      syncedFromBaseKeys: ['SENDGRID_API_KEY'],
      vars: {
        SENDGRID_API_KEY: 'SG.base',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
      emptyKeys: [],
    });
    expect(existsSync(stagingPath)).toBe(true);
    expect(readFileSync(stagingPath, 'utf-8')).toBe('SENDGRID_API_KEY=SG.base\n');
    expect(statSync(stagingPath).mode & 0o777).toBe(0o600);
    expect(isIgnored(root, '.env')).toBe(true);
    expect(isIgnored(root, '.env.staging')).toBe(true);
    expect(isIgnored(root, '.env.example')).toBe(false);
    expect(isIgnored(root, '.env.test.example')).toBe(false);
    expect(isIgnored(root, '.env.defaults')).toBe(false);
  });

  it('refuses a symlinked environment-specific env file without changing its external target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-symlink-repo-'));
    const externalRoot = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-symlink-target-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    writeFileSync(path.join(root, '.gitignore'), '/.env\n/.env.production\n');
    writeFileSync(path.join(root, '.env'), 'SENDGRID_API_KEY=SG.base\n');
    const externalPath = path.join(externalRoot, 'outside.production');
    const original = 'SENDGRID_API_KEY=SG.external\n';
    writeFileSync(externalPath, original);
    symlinkSync(externalPath, path.join(root, '.env.production'));

    try {
      expect(() => loadDeployEnvFile({
        startDir: path.join(root, 'app'),
        envName: 'production',
      })).toThrow(/\.env\.production because it is not a regular file/i);
      expect(readFileSync(externalPath, 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('copies newly added base .env keys into an existing environment-specific file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-sync-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const stagingPath = path.join(root, '.env.staging');
    writeFileSync(basePath, [
      'SENDGRID_API_KEY=SG.base',
      'SESSION_SECRET=session-base',
      'STRIPE_SECRET_KEY=stripe-base',
      '',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(stagingPath, [
      'SENDGRID_API_KEY=SG.staging',
      'SESSION_SECRET=session-base',
      '',
    ].join('\n'), { mode: 0o600 });

    expect(loadDeployEnvFile({ startDir: path.join(root, 'app'), envName: 'staging' })).toEqual({
      path: stagingPath,
      baseEnvPath: basePath,
      syncedFromBaseKeys: ['STRIPE_SECRET_KEY'],
      divergentFromBaseKeys: ['SENDGRID_API_KEY'],
      vars: {
        SENDGRID_API_KEY: 'SG.staging',
        SESSION_SECRET: 'session-base',
        STRIPE_SECRET_KEY: 'stripe-base',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
      emptyKeys: [],
    });
    expect(readFileSync(stagingPath, 'utf-8')).toContain('STRIPE_SECRET_KEY=stripe-base');
    expect(readFileSync(stagingPath, 'utf-8')).toContain('Copied from .env by Hypervibe');
  });

  it('recognizes common local-only values', () => {
    expect(valueLooksLocal('redis://localhost:6379')).toBe(true);
    expect(valueLooksLocal('https://api.service.internal/hook')).toBe(true);
    expect(valueLooksLocal('db.internal:5432')).toBe(true);
    expect(valueLooksLocal('callback.local/path')).toBe(true);
    expect(valueLooksLocal('postgres://app:pw@db.example.com:5432/app')).toBe(false);
  });

  it('supports all and explicit mode with include/exclude lists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-policy-'));
    initRepo(root);
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, [
      'CUSTOM_WORKER_FLAG=true',
      'LOCAL_DEBUG_FLAG=1',
      'SESSION_SECRET=session-runtime',
      '',
    ].join('\n'), { mode: 0o600 });

    expect(loadDeployEnvFile({
      startDir: root,
      mode: 'all',
      excludeKeys: ['LOCAL_DEBUG_FLAG'],
    })).toEqual({
      path: envPath,
      vars: {
        CUSTOM_WORKER_FLAG: 'true',
        SESSION_SECRET: 'session-runtime',
      },
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: ['LOCAL_DEBUG_FLAG'],
      localValueKeys: [],
      emptyKeys: [],
    });

    expect(loadDeployEnvFile({
      startDir: root,
      mode: 'explicit',
      includeKeys: ['CUSTOM_WORKER_FLAG'],
    })).toEqual({
      path: envPath,
      vars: {
        CUSTOM_WORKER_FLAG: 'true',
      },
      ignoredKeys: ['LOCAL_DEBUG_FLAG', 'SESSION_SECRET'],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
      emptyKeys: [],
    });
  });

  it('does not copy excluded delegated keys into a new environment-specific env file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-delegated-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    writeFileSync(path.join(root, '.env'), [
      'ANTHROPIC_API_KEY=owner-key',
      'SENDGRID_API_KEY=sendgrid-key',
      '',
    ].join('\n'));

    const result = loadDeployEnvFile({
      startDir: path.join(root, 'app'),
      envName: 'production',
      excludeKeys: ['ANTHROPIC_API_KEY'],
    })!;
    const productionFile = readFileSync(path.join(root, '.env.production'), 'utf8');

    expect(productionFile).not.toContain('owner-key');
    expect(productionFile).toContain('SENDGRID_API_KEY=sendgrid-key');
    expect(result.vars).toEqual({ SENDGRID_API_KEY: 'sendgrid-key' });
    expect(result.syncedFromBaseKeys).toEqual(['SENDGRID_API_KEY']);
    expect(result.emptyKeys).toEqual([]);
  });

  it('does not deploy or copy blank placeholders and provider-only Hypervibe credentials', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-placeholders-'));
    initRepo(root);
    mkdirSync(path.join(root, 'app'));
    const basePath = path.join(root, '.env');
    const productionPath = path.join(root, '.env.production');
    writeFileSync(basePath, [
      '# Hypervibe: required application secret.',
      'SESSION_SECRET=',
      '# Hypervibe: GitHub API connection.',
      'HYPERVIBE_GITHUB_TOKEN=github-api-token',
      '# Hypervibe: Railway connection.',
      'HYPERVIBE_RAILWAY_TOKEN=',
      '# Hypervibe: GitHub package connection.',
      'NODE_AUTH_TOKEN=github-package-token',
      'SENDGRID_API_KEY=SG.runtime',
      '',
    ].join('\n'));

    const result = loadDeployEnvFile({
      startDir: path.join(root, 'app'),
      envName: 'production',
    })!;
    const production = readFileSync(productionPath, 'utf8');

    expect(result.vars).toEqual({ SENDGRID_API_KEY: 'SG.runtime' });
    expect(result.syncedFromBaseKeys).toEqual(['SENDGRID_API_KEY']);
    expect(result.emptyKeys).toEqual(['SESSION_SECRET']);
    expect(result.skippedKeys).toEqual([
      'HYPERVIBE_GITHUB_TOKEN',
      'HYPERVIBE_RAILWAY_TOKEN',
      'NODE_AUTH_TOKEN',
    ]);
    expect(production).toContain('SENDGRID_API_KEY=SG.runtime');
    expect(production).not.toContain('SESSION_SECRET=');
    expect(production).not.toContain('HYPERVIBE_');
    expect(production).not.toContain('NODE_AUTH_TOKEN');
    expect(production).not.toContain('GitHub API connection');
    expect(production).not.toContain('Railway connection');
    expect(statSync(productionPath).mode & 0o777).toBe(0o600);
  });

  it('reports a selected blank value as missing instead of deploying it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-env-empty-'));
    initRepo(root);
    writeFileSync(path.join(root, '.env'), 'SESSION_SECRET=\n', { mode: 0o600 });

    expect(loadDeployEnvFile({
      startDir: root,
      mode: 'explicit',
      includeKeys: ['SESSION_SECRET'],
    })).toEqual({
      path: path.join(root, '.env'),
      vars: {},
      ignoredKeys: [],
      skippedKeys: [],
      excludedKeys: [],
      localValueKeys: [],
      emptyKeys: ['SESSION_SECRET'],
    });
  });
});
