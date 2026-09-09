import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { environmentVariableCoverage } from '../environment-variable-coverage.service.js';

function spec(input: Record<string, unknown>) {
  return projectSpecSchema.parse({ version: 1, project: 'coverage-app', ...input });
}

const web = { web: { startCommand: 'npm start' } };

describe('environmentVariableCoverage', () => {
  it('requires new ordinary keys in every non-local environment with matching services', () => {
    const report = environmentVariableCoverage(spec({
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVars: {} },
        production: {
          hosting: { provider: 'railway' }, services: web,
          envVars: { RECAPTCHA_SITE_KEY: 'production-site-id' },
        },
      },
    }));

    expect(report).toMatchObject({
      complete: false,
      issues: [{
        reason: 'missing_environment',
        key: 'RECAPTCHA_SITE_KEY',
        environment: 'staging',
        declaredIn: ['production'],
        requiredEnvironments: ['production', 'staging'],
      }],
    });
    expect(JSON.stringify(report)).not.toContain('production-site-id');
  });

  it('accepts separately chosen ordinary values and explicit exceptions', () => {
    const complete = environmentVariableCoverage(spec({
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVars: { SITE_KEY: 'staging-id' } },
        production: { hosting: { provider: 'railway' }, services: web, envVars: { SITE_KEY: 'production-id' } },
      },
    }));
    const excepted = environmentVariableCoverage(spec({
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVarExceptions: ['PRODUCTION_ONLY'] },
        production: { hosting: { provider: 'railway' }, services: web, envVars: { PRODUCTION_ONLY: 'enabled' } },
      },
    }));

    expect(complete).toEqual({ complete: true, issues: [] });
    expect(excepted).toEqual({ complete: true, issues: [] });
  });

  it('requires managed secret slots across matching release environments without values', () => {
    const report = environmentVariableCoverage(spec({
      secrets: {
        RECAPTCHA_SECRET_KEY: { principal: 'github:dave', environments: ['production'] },
      },
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web },
        production: { hosting: { provider: 'railway' }, services: web },
      },
    }));

    expect(report.issues).toEqual([
      expect.objectContaining({ key: 'RECAPTCHA_SECRET_KEY', environment: 'staging' }),
    ]);
  });

  it('rejects mixing managed secrets and ordinary configuration across environments', () => {
    const report = environmentVariableCoverage(spec({
      secrets: {
        API_KEY: { principal: 'github:dave', environments: ['production'] },
      },
      environments: {
        staging: { hosting: { provider: 'railway' }, services: web, envVars: { API_KEY: 'not-a-secret-here' } },
        production: { hosting: { provider: 'railway' }, services: web },
      },
    }));

    expect(report.issues).toEqual([
      expect.objectContaining({ reason: 'mixed_secret_boundary', key: 'API_KEY' }),
    ]);
  });

  it('does not couple local or unrelated-service environments', () => {
    const report = environmentVariableCoverage(spec({
      environments: {
        local: { hosting: { provider: 'railway' }, services: web, envVars: {} },
        production: { hosting: { provider: 'railway' }, services: web, envVars: { WEB_ONLY: 'yes' } },
        jobs: {
          hosting: { provider: 'railway' },
          services: { worker: { workloadKind: 'worker', startCommand: 'npm run worker' } },
          envVars: {},
        },
      },
    }));

    expect(report).toEqual({ complete: true, issues: [] });
  });
});
