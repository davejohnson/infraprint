import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, SqliteAdapter } from '../../sqlite.adapter.js';
import { EnvironmentRepository } from '../environment.repository.js';
import { ProjectRepository } from '../project.repository.js';

let root: string;
let oldCwd: string;
let oldDisable: string | undefined;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  root = mkdtempSync(path.join(tmpdir(), 'hypervibe-environment-repo-state-'));
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, '.hypervibe'));
  SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
  oldCwd = process.cwd();
  oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
  process.chdir(root);
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
  else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
  SqliteAdapter.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

describe('EnvironmentRepository repository binding safety', () => {
  it.each([
    ['provider identity', { provider: 42, projectId: 'railway-project' }],
    ['service identity', {
      provider: 'railway',
      projectId: 'railway-project',
      services: { web: { serviceId: [] } },
    }],
    ['service-create recovery', {
      provider: 'railway',
      projectId: 'railway-project',
      serviceCreateRecovery: {
        web: {
          provider: 'railway',
          operation: 'create',
          resourceName: 'web-production',
          providerScope: { projectId: 'railway-project', environmentId: 'railway-production' },
          state: 'identified',
        },
      },
    }],
  ])('fails closed when persisted SQLite bindings contain a malformed %s', (_label, malformed) => {
    const project = new ProjectRepository().create({ name: 'safe-app', defaultPlatform: 'railway' });
    const environments = new EnvironmentRepository();
    const environment = environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        services: {},
      },
    });
    getDb().prepare('UPDATE environments SET platform_bindings = ? WHERE id = ?')
      .run(JSON.stringify(malformed), environment.id);

    expect(() => environments.findById(environment.id)).toThrow(
      /persisted JSON has an invalid shape.*refuses to treat unreadable state as empty/i
    );
  });

  it('retains the SQLite identity and fails when a corrupt export cannot be updated', () => {
    const project = new ProjectRepository().create({ name: 'safe-app', defaultPlatform: 'railway' });
    const file = path.join(root, '.hypervibe', 'bindings.json');
    const malformed = '{"secret":"must-not-be-overwritten",';
    writeFileSync(file, malformed, 'utf8');

    const environments = new EnvironmentRepository();
    expect(() => environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
      },
    })).toThrow(/is not valid JSON/);

    expect(environments.findByProjectAndName(project.id, 'production')?.platformBindings).toMatchObject({
      projectId: 'railway-project',
      environmentId: 'railway-environment',
    });
    expect(readFileSync(file, 'utf8')).toBe(malformed);
  });

  it('removes stale repository bindings when local bindings are cleared or an environment is deleted', () => {
    const project = new ProjectRepository().create({ name: 'safe-app', defaultPlatform: 'railway' });
    const environments = new EnvironmentRepository();
    const first = environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', environmentId: 'railway-production' },
    });
    const file = path.join(root, '.hypervibe', 'bindings.json');
    expect(existsSync(file)).toBe(true);

    environments.update(first.id, { platformBindings: {} });
    expect(existsSync(file)).toBe(false);

    const second = environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', environmentId: 'railway-staging' },
    });
    expect(existsSync(file)).toBe(true);
    expect(environments.delete(second.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
