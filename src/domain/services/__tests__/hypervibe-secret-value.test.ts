import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SecretStore,
  getSecretStore,
} from '../../../adapters/secrets/secret-store.js';
import {
  projectSpecSchema,
  type HypervibeSecretSpec,
} from '../../spec/spec.schema.js';
import {
  deriveHypervibeSecretValue,
  deriveHypervibeSecretValues,
} from '../hypervibe-secret-value.js';

const originalSecretKey = process.env.HYPERVIBE_SECRET_KEY;

function randomSecretSpec(generation = 1): HypervibeSecretSpec {
  return {
    ownership: 'hypervibe',
    generator: 'random-base64url-32-v1',
    generation,
    environments: ['production', 'staging'],
  };
}

beforeEach(() => {
  SecretStore.resetInstance();
  process.env.HYPERVIBE_SECRET_KEY = '33'.repeat(32);
});

afterEach(() => {
  vi.restoreAllMocks();
  SecretStore.resetInstance();
  if (originalSecretKey === undefined) {
    delete process.env.HYPERVIBE_SECRET_KEY;
  } else {
    process.env.HYPERVIBE_SECRET_KEY = originalSecretKey;
  }
});

describe('deriveHypervibeSecretValue', () => {
  it('returns the same canonical 32-byte base64url value for the same identity', () => {
    const first = deriveHypervibeSecretValue(
      'hypervibe',
      'production',
      'SESSION_SECRET',
      randomSecretSpec()
    );
    const second = deriveHypervibeSecretValue(
      'hypervibe',
      'production',
      'SESSION_SECRET',
      randomSecretSpec()
    );
    const decoded = Buffer.from(first, 'base64url');

    try {
      expect(second).toBe(first);
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decoded).toHaveLength(32);
      expect(decoded.toString('base64url')).toBe(first);
    } finally {
      decoded.fill(0);
    }
  });

  it('separates project, environment, key, and generation identities', () => {
    const values = [
      deriveHypervibeSecretValue('hypervibe', 'production', 'SESSION_SECRET', randomSecretSpec(1)),
      deriveHypervibeSecretValue('other-project', 'production', 'SESSION_SECRET', randomSecretSpec(1)),
      deriveHypervibeSecretValue('hypervibe', 'staging', 'SESSION_SECRET', randomSecretSpec(1)),
      deriveHypervibeSecretValue('hypervibe', 'production', 'OTHER_SECRET', randomSecretSpec(1)),
      deriveHypervibeSecretValue('hypervibe', 'production', 'SESSION_SECRET', randomSecretSpec(2)),
    ];

    expect(new Set(values).size).toBe(values.length);
  });

  it('zeroes derived buffers after encoding', () => {
    const randomMaterial = Buffer.alloc(32, 0x41);
    vi.spyOn(getSecretStore(), 'deriveSecret')
      .mockReturnValueOnce(randomMaterial);

    deriveHypervibeSecretValue(
      'hypervibe',
      'production',
      'SESSION_SECRET',
      randomSecretSpec()
    );
    expect(randomMaterial.equals(Buffer.alloc(32))).toBe(true);
  });

  it('does not log secret material or identity context', () => {
    const spies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    deriveHypervibeSecretValue(
      'hypervibe',
      'production',
      'SESSION_SECRET',
      randomSecretSpec()
    );

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('derives only applicable Hypervibe-owned slots without exposing identity context', () => {
    const spec = projectSpecSchema.parse({
      version: 1,
      project: 'project-identity-not-output',
      secrets: {
        SESSION_SECRET: {
          ownership: 'hypervibe',
          generator: 'random-base64url-32-v1',
          generation: 1,
          environments: ['production'],
        },
        APP_SIGNING_SECRET: {
          ownership: 'hypervibe',
          generator: 'random-base64url-32-v1',
          generation: 1,
          environments: ['production'],
        },
        STAGING_ONLY_SECRET: {
          ownership: 'hypervibe',
          generator: 'random-base64url-32-v1',
          generation: 1,
          environments: ['staging'],
        },
        OWNER_SUPPLIED_SECRET: {
          ownership: 'delegated',
          principal: 'github:owner',
          environments: ['production'],
        },
      },
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: {} },
        },
        staging: {
          hosting: { provider: 'railway' },
          services: { web: {} },
        },
      },
    });

    const values = deriveHypervibeSecretValues(spec, 'production');

    expect(Object.keys(values)).toEqual(['APP_SIGNING_SECRET', 'SESSION_SECRET']);
    for (const value of Object.values(values)) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value).not.toContain(spec.project);
      expect(value).not.toContain('production');
    }
  });
});
