import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { SpecStore, desiredStateToSpec, deepMergeSpec } from '../spec.store.js';
import { projectSpecSchema } from '../spec.schema.js';
import { writeRepoSpecFile } from '../repo-spec-file.js';
import type { Project } from '../../entities/project.entity.js';

function freshDb() {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-spec-'));
  const adapter = SqliteAdapter.getInstance(path.join(dir, 'test.db'));
  adapter.migrate();
}

function makeProject(policies: Record<string, unknown> = {}): Project {
  return new ProjectRepository().create({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    defaultPlatform: 'railway',
    policies,
  });
}

describe('desiredStateToSpec', () => {
  it('returns null when no legacy desired state exists', () => {
    expect(desiredStateToSpec({ policies: {} } as unknown as Project)).toBeNull();
  });

  it('converts a legacy desired state into a v1 spec', () => {
    const project = {
      name: 'myapp',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'git@github.com:davejohnson/myapp.git',
      policies: {
        desiredState: {
          environmentName: 'production',
          services: ['api'],
          crons: { nightly: { schedule: '0 3 * * *', command: 'npm run nightly' } },
          domain: 'myapp.dev',
          databaseProvider: 'supabase',
          setupEmail: true,
          serviceConfig: { api: { startCommand: 'npm start', healthCheckPath: '/health', public: true } },
          envVars: { NODE_ENV: 'production' },
          deploy: { strategy: 'branch', branches: { production: 'main', staging: 'develop' } },
          migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
        },
      },
    } as unknown as Project;

    const spec = desiredStateToSpec(project)!;
    expect(spec.version).toBe(1);
    expect(spec.gitRemoteUrl).toBe('git@github.com:davejohnson/myapp.git');
    const env = spec.environments.production;
    expect(env.hosting.provider).toBe('railway');
    expect(env.services.api).toMatchObject({ workloadKind: 'web', startCommand: 'npm start', public: true });
    expect(env.services.nightly).toMatchObject({ workloadKind: 'cron', cronSchedule: '0 3 * * *', startCommand: 'npm run nightly' });
    expect(env.database).toEqual({ provider: 'supabase', engine: 'postgres' });
    expect(env.domain).toBe('myapp.dev');
    expect(env.email.enabled).toBe(true);
    expect(env.deploy).toEqual({ strategy: 'branch', branch: 'main' });
    expect(env.migrations).toMatchObject({ mode: 'releaseCommand', command: 'npm run migrate' });
  });

  it('preserves an explicit legacy desired-state branch for a custom environment', () => {
    const project = {
      name: 'preview-app',
      defaultPlatform: 'railway',
      policies: {
        desiredState: {
          environmentName: 'qa-7',
          services: ['web'],
          databaseProvider: 'railway',
          setupEmail: false,
          deploy: { strategy: 'branch', branch: 'release/qa-7' },
        },
      },
    } as unknown as Project;

    expect(desiredStateToSpec(project)?.environments['qa-7'].deploy).toEqual({
      strategy: 'branch',
      branch: 'release/qa-7',
    });
  });
});

describe('deepMergeSpec', () => {
  it('merges objects recursively and replaces scalars', () => {
    const merged = deepMergeSpec(
      { a: { x: 1, y: 2 }, keep: true },
      { a: { y: 3 } }
    ) as Record<string, unknown>;
    expect(merged).toEqual({ a: { x: 1, y: 3 }, keep: true });
  });

  it('deletes keys set to null', () => {
    const merged = deepMergeSpec(
      { services: { api: { startCommand: 'x' }, worker: {} } },
      { services: { worker: null } }
    ) as { services: Record<string, unknown> };
    expect(Object.keys(merged.services)).toEqual(['api']);
  });
});

describe('serviceSpecSchema workloadKind', () => {
  it("rejects the removed 'job' kind with a migration message", () => {
    const result = projectSpecSchema.safeParse({
      version: 1,
      project: 'app',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { migrate: { workloadKind: 'job' } },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? '' : result.error.issues)).toContain("workloadKind 'job' was removed");
  });
});

describe('SpecStore', () => {
  beforeEach(freshDb);

  it('returns null for a project with no spec or legacy state', () => {
    const store = new SpecStore();
    expect(store.get(makeProject())).toBeNull();
  });

  it('lazily converts legacy desiredState to revision 1', () => {
    const project = makeProject({
      desiredState: { environmentName: 'staging', services: ['api'], databaseProvider: 'railway' },
    });
    const store = new SpecStore();
    const result = store.get(project)!;
    expect(result.revision).toBe(1);
    expect(result.spec.environments.staging.database?.provider).toBe('railway');
    // Stable on re-read
    expect(store.get(project)!.revision).toBe(1);
  });

  it('bumps revision on replace and merge, and serves old revisions', () => {
    const project = makeProject();
    const store = new SpecStore();

    const v1 = store.replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: 'git@github.com:davejohnson/spec-one.git',
      environments: { staging: { hosting: { provider: 'railway' }, services: { api: {} } } },
    });
    expect(v1.revision).toBe(1);
    expect(v1.spec.gitRemoteUrl).toBe('git@github.com:davejohnson/spec-one.git');

    const v2 = store.merge(project, {
      gitRemoteUrl: 'https://github.com/davejohnson/spec-two.git',
      environments: { staging: { services: { worker: { workloadKind: 'worker' } } } },
    });
    expect(v2.revision).toBe(2);
    expect(v2.spec.gitRemoteUrl).toBe('https://github.com/davejohnson/spec-two.git');
    expect(Object.keys(v2.spec.environments.staging.services)).toEqual(['api', 'worker']);

    expect(store.getRevision(project.id, 1)!.environments.staging.services).not.toHaveProperty('worker');
    expect(store.getRevision(project.id, 1)!.gitRemoteUrl).toBe('git@github.com:davejohnson/spec-one.git');
  });

  it('refuses to store a spec under a different project identity', () => {
    const project = makeProject();
    const store = new SpecStore();

    expect(() => store.replace(project, {
      version: 1,
      project: 'different-project',
      environments: {},
    })).toThrow(`Spec project "different-project" does not match target project "${project.name}".`);
    expect(store.get(project)).toBeNull();
  });

  it('writes repo-backed specs and imports file edits as new local revisions', () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-repo-spec-')));
    mkdirSync(path.join(repoDir, '.git'));

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      const project = makeProject();
      const store = new SpecStore();

      const v1 = store.replace(project, {
        version: 1,
        project: project.name,
        environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} } } },
      });

      const specPath = path.join(repoDir, '.hypervibe', 'spec.json');
      const envTemplatePath = path.join(repoDir, '.env.example');
      expect(v1.source).toEqual({ kind: 'repo', path: specPath });
      expect(v1.envTemplate).toEqual({
        path: envTemplatePath,
        addedKeys: ['RECAPTCHA_SITE_KEY', 'RECAPTCHA_SECRET_KEY'],
      });
      expect(JSON.parse(readFileSync(specPath, 'utf8')).project).toBe(project.name);
      expect(readFileSync(envTemplatePath, 'utf8')).toContain('RECAPTCHA_SITE_KEY=');
      expect(readFileSync(envTemplatePath, 'utf8')).toContain('RECAPTCHA_SECRET_KEY=');

      const edited = {
        ...v1.spec,
        environments: {
          staging: {
            ...v1.spec.environments.staging,
            services: {
              ...v1.spec.environments.staging.services,
              daily: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
            },
          },
        },
      };
      writeFileSync(specPath, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');

      const v2 = store.get(project)!;
      expect(v2.revision).toBe(2);
      expect(v2.source).toEqual({ kind: 'repo', path: specPath });
      expect(v2.adopted).toBe(true);
      expect(v2.spec.environments.staging.services.daily).toMatchObject({
        workloadKind: 'cron',
        cronSchedule: '0 8 * * *',
      });

      // Re-reading the unchanged file is not another adoption.
      const v2Again = store.get(project)!;
      expect(v2Again.revision).toBe(2);
      expect(v2Again.adopted).toBeUndefined();

      // A repo file that fails schema validation surfaces a clear error
      // instead of silently falling back to the local revision.
      writeFileSync(specPath, JSON.stringify({ version: 1, project: project.name }), 'utf8');
      expect(() => store.get(project)).toThrow(/does not match the project spec schema/);

      // Invalid JSON gets its own clear error.
      writeFileSync(specPath, '{not json', 'utf8');
      expect(() => store.get(project)).toThrow(/is not valid JSON/);
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps a second project local when the checkout belongs to another project', () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-cross-project-spec-')));
    mkdirSync(path.join(repoDir, '.git'));

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      const checkoutSpec = projectSpecSchema.parse({
        version: 1,
        project: 'checkout-project',
        environments: {},
      });
      const specPath = writeRepoSpecFile(checkoutSpec)!.path;
      const secondProject = new ProjectRepository().create({
        name: 'domain-conformance-project',
        defaultPlatform: 'railway',
        policies: {},
      });

      const stored = new SpecStore().replace(secondProject, {
        version: 1,
        project: secondProject.name,
        environments: {
          railway: {
            hosting: { provider: 'railway' },
            services: { web: {} },
          },
        },
      });

      expect(stored.source).toEqual({ kind: 'local' });
      expect(JSON.parse(readFileSync(specPath, 'utf8'))).toEqual(checkoutSpec);
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a corrupt repo spec or append a divergent local revision', () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-corrupt-repo-spec-write-')));
    mkdirSync(path.join(repoDir, '.git'));
    mkdirSync(path.join(repoDir, '.hypervibe'));
    const specPath = path.join(repoDir, '.hypervibe', 'spec.json');
    const malformed = '{"apiToken":"must-not-be-overwritten",';

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      writeFileSync(specPath, malformed, 'utf8');
      const project = makeProject();
      const replacement = projectSpecSchema.parse({
        version: 1,
        project: project.name,
        environments: {},
      });

      expect(() => writeRepoSpecFile(replacement)).toThrow(/is not valid JSON/);
      expect(() => new SpecStore().replace(project, replacement)).toThrow(/is not valid JSON/);
      expect(readFileSync(specPath, 'utf8')).toBe(malformed);
      const count = SqliteAdapter.getInstance().getDb()
        .prepare('SELECT COUNT(*) AS count FROM project_specs WHERE project_id = ?')
        .get(project.id) as { count: number };
      expect(count.count).toBe(0);
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      else process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('preserves existing env template content and adds only missing reCAPTCHA slots', () => {
    const oldCwd = process.cwd();
    const oldDisable = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hypervibe-env-template-')));
    mkdirSync(path.join(repoDir, '.git'));
    const envTemplatePath = path.join(repoDir, '.env.example');
    writeFileSync(envTemplatePath, 'CUSTOM_RUNTIME_KEY=\n# RECAPTCHA_SITE_KEY=\n', 'utf8');

    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      process.chdir(repoDir);
      const spec = projectSpecSchema.parse({
        version: 1,
        project: 'env-template-app',
        environments: {},
      });
      const first = writeRepoSpecFile(spec)!;
      const afterFirst = readFileSync(envTemplatePath, 'utf8');

      expect(first.envTemplate).toEqual({
        path: envTemplatePath,
        addedKeys: ['RECAPTCHA_SECRET_KEY'],
      });
      expect(afterFirst).toContain('CUSTOM_RUNTIME_KEY=');
      expect(afterFirst.match(/RECAPTCHA_SITE_KEY=/g)).toHaveLength(1);
      expect(afterFirst).toContain('RECAPTCHA_SECRET_KEY=');

      const second = writeRepoSpecFile(spec)!;
      expect(second.envTemplate.addedKeys).toEqual([]);
      expect(readFileSync(envTemplatePath, 'utf8')).toBe(afterFirst);
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) {
        delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
      } else {
        process.env.HYPERVIBE_DISABLE_REPO_SPEC = oldDisable;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid specs', () => {
    const project = makeProject();
    const store = new SpecStore();
    expect(() => store.replace(project, { version: 1, project: project.name, environments: { staging: {} } })).toThrow();
  });

  it('fails closed on corrupt or schema-invalid stored desired state without appending a replacement revision', () => {
    const project = makeProject();
    const store = new SpecStore();
    store.replace(project, {
      version: 1,
      project: project.name,
      environments: {},
    });
    const db = SqliteAdapter.getInstance().getDb();

    db.prepare('UPDATE project_specs SET document = ? WHERE project_id = ?')
      .run('{"secret":"must-not-appear",', project.id);
    expect(() => store.get(project)).toThrow(/persisted JSON is corrupt/);
    expect(() => store.getRevision(project.id, 1)).toThrow(/persisted JSON is corrupt/);
    try {
      store.get(project);
    } catch (error) {
      expect(String(error)).not.toContain('must-not-appear');
    }

    db.prepare('UPDATE project_specs SET document = ? WHERE project_id = ?')
      .run(JSON.stringify({ version: 1, project: project.name }), project.id);
    expect(() => store.get(project)).toThrow(/persisted JSON has an invalid shape/);
    expect(() => store.getRevision(project.id, 1)).toThrow(/persisted JSON has an invalid shape/);
    expect(() => store.merge(project, { environments: {} })).toThrow(/persisted JSON has an invalid shape/);

    const count = db.prepare('SELECT COUNT(*) AS count FROM project_specs WHERE project_id = ?')
      .get(project.id) as { count: number };
    expect(count.count).toBe(1);
  });
});
