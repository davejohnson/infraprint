import { describe, expect, it } from 'vitest';
import { cacheSpecSchema, projectSpecSchema } from '../spec.schema.js';

describe('cache spec schema', () => {
  it('defaults to the Redis engine and accepts extensible provider ids', () => {
    expect(cacheSpecSchema.parse({ provider: 'acme-cache' })).toEqual({
      provider: 'acme-cache',
      engine: 'redis',
    });
  });

  it('keeps Redis separate from database desired state', () => {
    const parsed = projectSpecSchema.parse({
      version: 1,
      project: 'redis-contract',
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {},
          cache: { provider: 'railway' },
        },
      },
    });
    expect(parsed.environments.staging.cache).toEqual({
      provider: 'railway',
      engine: 'redis',
    });
    expect(parsed.environments.staging.database).toBeUndefined();
  });

  it('keeps cache placement in desired state and trims provider-native options', () => {
    expect(cacheSpecSchema.parse({
      provider: 'memorystore',
      region: ' europe-west1 ',
      network: ' app-vpc ',
      subnetwork: ' app-subnet ',
      tier: ' STANDARD_HA ',
      size: ' 5gb ',
    })).toEqual({
      provider: 'memorystore',
      engine: 'redis',
      region: 'europe-west1',
      network: 'app-vpc',
      subnetwork: 'app-subnet',
      tier: 'STANDARD_HA',
      size: '5gb',
    });
  });
});
