import { describe, expect, it } from 'vitest';
import {
  applyEnvFileVarsToBootstrapParams,
  applyOverridesToBootstrapParams,
  scopeBootstrapParamsToService,
  specToBootstrapParams,
} from '../spec-bootstrap.js';

describe('spec bootstrap env vars', () => {
  it('projects explicit project runtime into apply parameters', () => {
    const params = specToBootstrapParams('runtime-app', 'staging', {
      hosting: { provider: 'cloudrun' },
      services: { web: { workloadKind: 'web' } },
      email: { enabled: false },
      envVars: {},
    }, { kind: 'python', version: '3.13' });

    expect(params.runtime).toEqual({ kind: 'python', version: '3.13' });
  });

  it('projects optional hosting geography as non-secret deploy intent', () => {
    const params = specToBootstrapParams('regional-app', 'production', {
      hosting: { provider: 'ecs', region: 'us-east-1' },
      services: { web: { workloadKind: 'web' } },
      email: { enabled: false },
      envVars: {},
    });

    expect(params.hostingRegion).toBe('us-east-1');
  });

  it('preserves an explicit deploy branch for an arbitrary environment name', () => {
    const params = specToBootstrapParams('preview-app', 'qa-7', {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'native', branch: 'release/qa-7' },
      email: { enabled: false },
      envVars: {},
    });

    expect(params.deploy).toEqual({
      strategy: 'branch',
      trigger: 'native',
      branch: 'release/qa-7',
    });
  });

  it('merges deploy env files below spec envVars and explicit overrides above both', () => {
    const params = specToBootstrapParams('env-app', 'production', {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
      email: { enabled: false },
      envVars: {
        NODE_ENV: 'production',
        SENDGRID_API_KEY: 'spec-sendgrid',
      },
    });

    const withEnvFile = applyEnvFileVarsToBootstrapParams(params, {
      NODE_ENV: 'from-dotenv',
      SENDGRID_API_KEY: 'dotenv-sendgrid',
      APP_BASE_URL: 'https://example.com',
    });
    const withExplicit = applyOverridesToBootstrapParams(withEnvFile, {
      envVars: {
        SENDGRID_API_KEY: 'explicit-sendgrid',
      },
    });

    expect(withEnvFile.envVars).toEqual({
      NODE_ENV: 'production',
      SENDGRID_API_KEY: 'spec-sendgrid',
      APP_BASE_URL: 'https://example.com',
    });
    expect(withExplicit.envVars).toEqual({
      NODE_ENV: 'production',
      SENDGRID_API_KEY: 'explicit-sendgrid',
      APP_BASE_URL: 'https://example.com',
    });
  });
});

describe('service action bootstrap authority', () => {
  it('cannot provision databases, attach domains, or deploy sibling workloads', () => {
    const scoped = scopeBootstrapParamsToService({
      projectName: 'safe-app',
      environmentName: 'staging',
      services: ['web', 'worker'],
      crons: { cleanup: { schedule: '0 * * * *' } },
      serviceConfig: {
        web: { workloadKind: 'web' },
        worker: { workloadKind: 'worker' },
        cleanup: { workloadKind: 'cron', cronSchedule: '0 * * * *' },
      },
      databaseProvider: 'railway',
      domain: 'example.com',
      envVarsByService: {
        web: { BUCKET: 'web' },
        worker: { BUCKET: 'worker' },
      },
    }, 'worker');

    expect(scoped).toMatchObject({
      services: ['worker'],
      ensureHostingProject: false,
      serviceConfig: { worker: { workloadKind: 'worker' } },
      envVarsByService: { worker: { BUCKET: 'worker' } },
    });
    expect(scoped.databaseProvider).toBeUndefined();
    expect(scoped.domain).toBeUndefined();
    expect(scoped.crons).toBeUndefined();
  });
});
