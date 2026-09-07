import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { buildDeploySourceEnvVars, resolveGitDeploySource, classifyDeployEnvironment } from '../deploy-source.js';

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-deploy-source-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
});

describe('buildDeploySourceEnvVars', () => {
  it('passes git source metadata and a scoped GitHub token for Cloud Run deploys', () => {
    const project = new ProjectRepository().create({
      name: 'hls-property-care',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
    });
    new ConnectionRepository().create({
      provider: 'github',
      scope: 'davejohnson/hls-property-care',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-scoped-token' }),
    });

    const vars = buildDeploySourceEnvVars(project, 'cloudrun');
    expect(vars).toMatchObject({
      HYPERVIBE_SOURCE_REPO_URL: 'https://github.com/davejohnson/hls-property-care.git',
      HYPERVIBE_SOURCE_REVISION: 'main',
      HYPERVIBE_GITHUB_TOKEN: 'gh-scoped-token',
    });
  });

  it('returns no vars without a git remote and no token for non-cloudrun providers', () => {
    const bare = new ProjectRepository().create({ name: 'no-remote' });
    expect(buildDeploySourceEnvVars(bare, 'cloudrun')).toEqual({});

    const withRemote = new ProjectRepository().create({
      name: 'railway-app',
      gitRemoteUrl: 'https://github.com/davejohnson/railway-app.git',
    });
    const vars = buildDeploySourceEnvVars(withRemote, 'railway');
    expect(vars.HYPERVIBE_SOURCE_REPO_URL).toBe('https://github.com/davejohnson/railway-app.git');
    expect(vars.HYPERVIBE_GITHUB_TOKEN).toBeUndefined();
  });
});

describe('resolveGitDeploySource', () => {
  it('maps environments to branch deploy sources', () => {
    const project = { gitRemoteUrl: 'git@github.com:davejohnson/billforge.git' };
    const result = resolveGitDeploySource(project, 'production', {
      strategy: 'branch',
      branches: { production: 'main', staging: 'develop' },
    });
    expect(result.source).toEqual({ repo: 'davejohnson/billforge', branch: 'main' });
  });

  it('uses an explicit branch for arbitrary environment names', () => {
    expect(classifyDeployEnvironment('qa-7')).toBeNull();
    const explicit = resolveGitDeploySource(
      { gitRemoteUrl: 'git@github.com:a/b.git' },
      'qa-7',
      { strategy: 'branch', branch: 'release/qa-7' }
    );
    expect(explicit.source).toEqual({ repo: 'a/b', branch: 'release/qa-7' });

    const defaulted = resolveGitDeploySource(
      { gitRemoteUrl: 'git@github.com:a/b.git' },
      'qa-7',
      { strategy: 'branch' }
    );
    expect(defaulted.source).toEqual({ repo: 'a/b', branch: 'main' });
  });

  it('rejects ambiguous legacy branch maps and non-GitHub remotes', () => {
    const legacy = resolveGitDeploySource(
      { gitRemoteUrl: 'git@github.com:a/b.git' },
      'qa-7',
      { strategy: 'branch', branches: { production: 'main', staging: 'develop' } }
    );
    expect(legacy.source).toBeNull();
    expect(legacy.error).toContain('Set deploy.branch explicitly');

    const gitlab = resolveGitDeploySource({ gitRemoteUrl: 'https://gitlab.com/a/b.git' }, 'production', { strategy: 'branch' });
    expect(gitlab.source).toBeNull();
  });
});
