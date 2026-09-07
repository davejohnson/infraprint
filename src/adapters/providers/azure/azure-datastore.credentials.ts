import { z } from 'zod';

const AzureDatastoreAuthenticationSchema = z.object({
  tenantId: z.string().uuid('Azure tenant ID must be a UUID'),
  subscriptionId: z.string().uuid('Azure subscription ID must be a UUID'),
  clientId: z.string().uuid('Azure service principal client ID must be a UUID'),
  clientSecret: z.string().min(8, 'Azure service principal client secret is required'),
}).strict();

const LEGACY_PLACEMENT_FIELDS = new Set([
  'resourceGroup',
  'location',
  'postgresSkuName',
  'postgresSkuTier',
  'postgresVersion',
  'postgresStorageSizeGb',
  'redisSkuName',
]);

/**
 * Old connections may still contain placement and SKU fields. Strip only
 * those known legacy keys during decryption/verification; unknown keys remain
 * rejected by the strict authentication schema and nothing placement-shaped
 * is persisted by new connections.
 */
function withoutLegacyPlacement(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([key]) => !LEGACY_PLACEMENT_FIELDS.has(key))
  );
}

export const AzureDatastoreCredentialsSchema = z.preprocess(
  withoutLegacyPlacement,
  AzureDatastoreAuthenticationSchema
);

export const AzurePostgresCredentialsSchema = AzureDatastoreCredentialsSchema;

export const AzureManagedRedisCredentialsSchema = AzureDatastoreCredentialsSchema;

export type AzureDatastoreCredentials = z.infer<
  typeof AzureDatastoreCredentialsSchema
>;

export type AzurePostgresCredentials = z.infer<
  typeof AzurePostgresCredentialsSchema
>;

export type AzureManagedRedisCredentials = z.infer<
  typeof AzureManagedRedisCredentialsSchema
>;
