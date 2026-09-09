import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: 'friend-app',
    secrets: {
      ANTHROPIC_API_KEY: {
        principal: 'github:alice',
        environments: ['production'],
      },
    },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
      },
    },
    ...overrides,
  };
}

function hypervibeSecretSpec(secret: Record<string, unknown>) {
  return {
    version: 1,
    project: 'friend-app',
    secrets: { SESSION_SECRET: secret },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
      },
    },
  };
}

describe('project secret spec', () => {
  it('accepts a required preserve-only secret slot without a value', () => {
    const parsed = projectSpecSchema.parse(baseSpec());
    expect(parsed.secrets.ANTHROPIC_API_KEY).toEqual({
      ownership: 'delegated',
      principal: 'github:alice',
      environments: ['production'],
      required: true,
      driftPolicy: 'preserve',
    });
    expect(JSON.stringify(parsed)).not.toContain('sk-ant-');
  });

  it('accepts strict Hypervibe-owned runtime secret generators with safe generation defaults', () => {
    const random = projectSpecSchema.parse(hypervibeSecretSpec({
      ownership: 'hypervibe',
      generator: 'random-base64url-32-v1',
      environments: ['production'],
    }));
    expect(random.secrets.SESSION_SECRET).toEqual({
      ownership: 'hypervibe',
      generator: 'random-base64url-32-v1',
      generation: 1,
      environments: ['production'],
    });

    const rotated = projectSpecSchema.parse(hypervibeSecretSpec({
      ownership: 'hypervibe',
      generator: 'random-base64url-32-v1',
      generation: 2,
      environments: ['production'],
    }));
    expect(rotated.secrets.SESSION_SECRET).toMatchObject({ generation: 2 });

  });

  it('keeps Hypervibe-owned slots runtime-only and rejects delegated fields', () => {
    for (const forbidden of [
      { principal: 'github:alice' },
      { required: true },
      { driftPolicy: 'preserve' },
      { githubActions: { repository: true } },
    ]) {
      const result = projectSpecSchema.safeParse(hypervibeSecretSpec({
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1',
        environments: ['production'],
        ...forbidden,
      }));
      expect(result.success).toBe(false);
    }
  });

  it('validates generation contracts and runtime destinations', () => {
    const zeroGeneration = projectSpecSchema.safeParse(hypervibeSecretSpec({
      ownership: 'hypervibe',
      generator: 'random-base64url-32-v1',
      generation: 0,
      environments: ['production'],
    }));
    expect(zeroGeneration.success).toBe(false);

    const noEnvironment = projectSpecSchema.safeParse(hypervibeSecretSpec({
      ownership: 'hypervibe',
      generator: 'random-base64url-32-v1',
      environments: [],
    }));
    expect(noEnvironment.success).toBe(false);
    expect(noEnvironment.success ? '' : noEnvironment.error.message).toContain(
      'at least one runtime environment'
    );
  });

  it('applies environment collision and ownership validation to Hypervibe-owned slots', () => {
    const unknown = projectSpecSchema.safeParse({
      ...hypervibeSecretSpec({
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1',
        environments: ['production'],
      }),
      secrets: {
        SESSION_SECRET: {
          ownership: 'hypervibe',
          generator: 'random-base64url-32-v1',
          environments: ['missing'],
        },
      },
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues).toContainEqual(expect.objectContaining({
        message: 'Hypervibe-owned secret "SESSION_SECRET" targets unknown environment "missing"',
      }));
    }

    const collision = projectSpecSchema.safeParse({
      ...hypervibeSecretSpec({
        ownership: 'hypervibe',
        generator: 'random-base64url-32-v1',
        environments: ['production'],
      }),
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          envVars: { SESSION_SECRET: 'must-not-be-committed' },
        },
      },
    });
    expect(collision.success).toBe(false);
    if (!collision.success) {
      expect(collision.error.issues).toContainEqual(expect.objectContaining({
        message: 'Hypervibe-owned secret "SESSION_SECRET" cannot also be declared in environments.production.envVars',
      }));
    }
  });

  it('rejects values that are also managed through ordinary envVars', () => {
    const result = projectSpecSchema.safeParse(baseSpec({
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          envVars: { ANTHROPIC_API_KEY: 'must-not-be-committed' },
        },
      },
    }));
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('cannot also be declared');
  });

  it('rejects unknown environments and explicit env-file selection', () => {
    const unknown = projectSpecSchema.safeParse(baseSpec({
      secrets: {
        ANTHROPIC_API_KEY: {
          principal: 'github:alice',
          environments: ['missing'],
        },
      },
    }));
    expect(unknown.success).toBe(false);
    expect(unknown.success ? '' : unknown.error.message).toContain('unknown environment');

    const included = projectSpecSchema.safeParse(baseSpec({
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
          envFile: { include: ['ANTHROPIC_API_KEY'] },
        },
      },
    }));
    expect(included.success).toBe(false);
    expect(included.success ? '' : included.error.message).toContain('cannot be selected');
  });
});
