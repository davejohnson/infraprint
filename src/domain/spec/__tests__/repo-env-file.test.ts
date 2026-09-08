import { execFileSync } from 'child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';
import {
  ensureRepoEnvFilesIgnored,
  ensureRepoEnvTemplate,
  ensureRepoLocalEnv,
  specLocalEnvRequirements,
} from '../repo-env-file.js';

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

function mode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('repo local env file', () => {
  it('activates only empty commented placeholders, preserves values, and removes broad file access', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-managed-env-'));
    initRepo(root);
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, [
      '# SESSION_SECRET=',
      '# API_TOKEN=example-token',
      '',
    ].join('\n'));
    chmodSync(envPath, 0o640);

    try {
      const result = ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
        { key: 'API_TOKEN', comment: 'Application API token' },
      ]);
      const content = readFileSync(envPath, 'utf8');

      expect(result).toMatchObject({
        addedKeys: ['API_TOKEN'],
        activatedKeys: ['SESSION_SECRET'],
        commentedKeys: ['SESSION_SECRET'],
        permissionsUpdated: true,
      });
      expect(content).toMatch(/# Hypervibe: Application session secret\nSESSION_SECRET=/);
      expect(content).toContain('# API_TOKEN=example-token');
      expect(content).toMatch(/# Hypervibe: Application API token\nAPI_TOKEN=/);
      expect(mode(envPath)).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a private env file without changing an already-safe ignore policy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-private-env-'));
    initRepo(root);
    const gitignorePath = path.join(root, '.gitignore');
    const ignorePolicy = 'node_modules/\n/.env\n';
    writeFileSync(gitignorePath, ignorePolicy);

    try {
      const result = ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
      ]);

      expect(result.gitignoreUpdated).toBe(false);
      expect(readFileSync(gitignorePath, 'utf8')).toBe(ignorePolicy);
      expect(mode(path.join(root, '.env'))).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds an adjacent explanation without replacing a value or owner comment', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-preserved-env-'));
    initRepo(root);
    writeFileSync(path.join(root, '.gitignore'), '/.env\n');
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, '# Keep this owner note.\nSESSION_SECRET=owner-value\n');

    try {
      const requirement = [{
        key: 'SESSION_SECRET',
        comment: 'Application session secret',
      }];
      const first = ensureRepoLocalEnv(root, requirement);
      const firstContent = readFileSync(envPath, 'utf8');
      const second = ensureRepoLocalEnv(root, requirement);

      expect(first).toMatchObject({
        addedKeys: [],
        commentedKeys: ['SESSION_SECRET'],
      });
      expect(firstContent).toBe([
        '# Keep this owner note.',
        '# Hypervibe: Application session secret',
        'SESSION_SECRET=owner-value',
        '',
      ].join('\n'));
      expect(second).toMatchObject({ addedKeys: [], commentedKeys: [] });
      expect(readFileSync(envPath, 'utf8')).toBe(firstContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes stale managed guidance and keeps tracked templates value-free after a spec update', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-updated-template-comment-'));
    initRepo(root);
    const baseDocument = {
      version: 1,
      project: 'updated-template-comment',
      environments: {
        staging: { hosting: { provider: 'railway' }, services: { web: {} } },
        production: { hosting: { provider: 'railway' }, services: { web: {} } },
      },
    };
    const firstSpec = projectSpecSchema.parse({
      ...baseDocument,
      secrets: {
        SESSION_SECRET: {
          principal: 'owner',
          environments: ['staging'],
          required: true,
        },
      },
    });
    const updatedSpec = projectSpecSchema.parse({
      ...baseDocument,
      secrets: {
        SESSION_SECRET: {
          principal: 'owner',
          environments: ['production'],
          required: false,
        },
      },
    });
    writeFileSync(path.join(root, '.gitignore'), '/.env\n');
    writeFileSync(path.join(root, '.env'), 'SESSION_SECRET=owner-value\n');

    try {
      const firstRequirements = specLocalEnvRequirements(firstSpec);
      const updatedRequirements = specLocalEnvRequirements(updatedSpec);
      ensureRepoEnvTemplate(root, firstRequirements);
      ensureRepoLocalEnv(root, firstRequirements);
      const result = ensureRepoEnvTemplate(root, updatedRequirements);
      const localResult = ensureRepoLocalEnv(root, updatedRequirements);
      const content = readFileSync(path.join(root, '.env.example'), 'utf8');
      const localContent = readFileSync(path.join(root, '.env'), 'utf8');

      expect(result).toMatchObject({
        addedKeys: [],
        commentedKeys: ['SESSION_SECRET'],
      });
      expect(content).toContain(
        '# Hypervibe: Optional delegated secret for production runtime; keep this template empty and place the value only in the gitignored .env before passing this key to hv_plan through secretRefs.\nSESSION_SECRET='
      );
      expect(content).not.toContain('Required delegated secret for staging runtime');
      expect(content).not.toContain('add the value locally');
      expect(content.match(/^# Hypervibe:/gm)).toHaveLength(1);
      expect(localResult.commentedKeys).toEqual(['SESSION_SECRET']);
      expect(localContent).toContain(
        '# Hypervibe: Optional delegated secret for production runtime; add the value locally, then pass this key to hv_plan through secretRefs.\nSESSION_SECRET=owner-value'
      );
      expect(localContent).not.toContain('Required delegated secret for staging runtime');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed instead of adding ignore rules around an already-tracked env file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-tracked-env-'));
    initRepo(root);
    const envPath = path.join(root, '.env');
    writeFileSync(envPath, 'SESSION_SECRET=owner-value\n');
    execFileSync('git', ['add', '--force', '.env'], { cwd: root, env: isolatedGitEnv() });

    try {
      expect(() => ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
      ])).toThrow(/git already tracks \.env/i);
      expect(readFileSync(envPath, 'utf8')).toBe('SESSION_SECRET=owner-value\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores only the exact generated secret files and leaves env support files trackable', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-exact-env-ignore-'));
    initRepo(root);

    try {
      const result = ensureRepoEnvFilesIgnored(root, ['.env', '.env.production']);
      const policy = readFileSync(path.join(root, '.gitignore'), 'utf8');

      expect(result.updated).toBe(true);
      expect(policy).toContain('/.env\n');
      expect(policy).toContain('/.env.production\n');
      expect(policy).not.toContain('/.env.*');
      expect(isIgnored(root, '.env')).toBe(true);
      expect(isIgnored(root, '.env.production')).toBe(true);
      expect(isIgnored(root, '.env.example')).toBe(false);
      expect(isIgnored(root, '.env.test.example')).toBe(false);
      expect(isIgnored(root, '.env.defaults')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a value-free .env.example trackable when an existing broad owner rule ignores it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-env-example-ignore-'));
    initRepo(root);
    const gitignorePath = path.join(root, '.gitignore');
    writeFileSync(gitignorePath, '.env*\n');
    const templatePath = path.join(root, '.env.example');
    const template = [
      '# Hypervibe: keep this template empty.',
      'SESSION_SECRET=',
      '# OPTIONAL_TOKEN=""',
      '',
    ].join('\n');
    writeFileSync(templatePath, template);

    try {
      const result = ensureRepoEnvFilesIgnored(root, ['.env']);

      expect(result.updated).toBe(true);
      expect(readFileSync(gitignorePath, 'utf8')).toContain('!/.env.example\n');
      expect(readFileSync(templatePath, 'utf8')).toBe(template);
      expect(isIgnored(root, '.env')).toBe(true);
      expect(isIgnored(root, '.env.example')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to unignore a secret-bearing .env.example and preserves both files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-secret-template-ignore-'));
    initRepo(root);
    const gitignorePath = path.join(root, '.gitignore');
    const originalPolicy = '.env*\n';
    writeFileSync(gitignorePath, originalPolicy);
    const templatePath = path.join(root, '.env.example');
    const originalTemplate = [
      'SESSION_SECRET=',
      '# API_TOKEN=owner-secret',
      'OTHER_TOKEN=another-secret',
      '',
    ].join('\n');
    writeFileSync(templatePath, originalTemplate);

    try {
      expect(() => ensureRepoEnvFilesIgnored(root, ['.env'])).toThrow(
        /Refusing to make \.env\.example trackable because it contains non-empty assignment\(s\) for API_TOKEN, OTHER_TOKEN.*Move every value into the gitignored \.env/i
      );
      expect(readFileSync(gitignorePath, 'utf8')).toBe(originalPolicy);
      expect(readFileSync(templatePath, 'utf8')).toBe(originalTemplate);
      expect(isIgnored(root, '.env.example')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without writing when git cannot verify the repository', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-not-a-repo-'));

    try {
      expect(() => ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
      ])).toThrow(/could not verify the git repository/i);
      expect(() => readFileSync(path.join(root, '.env'), 'utf8')).toThrow();
      expect(() => readFileSync(path.join(root, '.gitignore'), 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses repository-local safety checks when inherited global git config is unreadable', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-isolated-git-config-'));
    initRepo(root);
    const invalidConfigPath = path.join(root, 'invalid-global-git-config');
    writeFileSync(invalidConfigPath, '[invalid\n');
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = invalidConfigPath;

    try {
      const result = ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
      ]);

      expect(result.gitignoreUpdated).toBe(true);
      expect(isIgnored(root, '.env')).toBe(true);
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('SESSION_SECRET=');
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked .env without changing its external target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-symlink-env-repo-'));
    const externalRoot = mkdtempSync(path.join(tmpdir(), 'hypervibe-symlink-env-target-'));
    initRepo(root);
    writeFileSync(path.join(root, '.gitignore'), '/.env\n');
    const externalPath = path.join(externalRoot, 'outside.env');
    const original = 'SESSION_SECRET=external-value\n';
    writeFileSync(externalPath, original);
    symlinkSync(externalPath, path.join(root, '.env'));

    try {
      expect(() => ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
      ])).toThrow(/\.env because it is not a regular file/i);
      expect(readFileSync(externalPath, 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked .env.example without changing its external target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-symlink-template-repo-'));
    const externalRoot = mkdtempSync(path.join(tmpdir(), 'hypervibe-symlink-template-target-'));
    initRepo(root);
    const externalPath = path.join(externalRoot, 'outside.example');
    const original = '# Owner template\nSESSION_SECRET=owner-example\n';
    writeFileSync(externalPath, original);
    symlinkSync(externalPath, path.join(root, '.env.example'));

    try {
      expect(() => ensureRepoEnvTemplate(root, [{
        key: 'SESSION_SECRET',
        comment: 'Application session secret',
      }])).toThrow(/\.env\.example because it is not a regular file/i);
      expect(readFileSync(externalPath, 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked .gitignore without changing its external target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hypervibe-symlink-ignore-repo-'));
    const externalRoot = mkdtempSync(path.join(tmpdir(), 'hypervibe-symlink-ignore-target-'));
    initRepo(root);
    const externalPath = path.join(externalRoot, 'outside-gitignore');
    const original = 'owner-rule/\n';
    writeFileSync(externalPath, original);
    symlinkSync(externalPath, path.join(root, '.gitignore'));

    try {
      expect(() => ensureRepoLocalEnv(root, [
        { key: 'SESSION_SECRET', comment: 'Application session secret' },
      ])).toThrow(/\.gitignore because it is not a regular file/i);
      expect(readFileSync(externalPath, 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});
