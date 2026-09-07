import { describe, expect, it } from 'vitest';
import {
  AzureManagedRedisCredentialsSchema,
  AzurePostgresCredentialsSchema,
} from '../azure-datastore.credentials.js';

const authentication = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: 'azure-client-secret',
};

describe('Azure datastore credentials', () => {
  it.each([
    ['PostgreSQL', AzurePostgresCredentialsSchema],
    ['Managed Redis', AzureManagedRedisCredentialsSchema],
  ])('keeps %s authentication-only while migrating known legacy placement keys', (_name, schema) => {
    expect(schema.parse({
      ...authentication,
      resourceGroup: 'legacy-group',
      location: 'eastus',
      postgresSkuName: 'LegacySku',
      postgresSkuTier: 'LegacyTier',
      postgresVersion: '15',
      postgresStorageSizeGb: 64,
      redisSkuName: 'LegacyRedisSku',
    })).toEqual(authentication);
  });

  it('continues to reject unknown credential fields', () => {
    expect(() => AzurePostgresCredentialsSchema.parse({
      ...authentication,
      arbitraryScope: 'must-not-be-silently-discarded',
    })).toThrow();
  });
});
