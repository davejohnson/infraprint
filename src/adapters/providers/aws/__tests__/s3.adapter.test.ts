import { describe, expect, it, vi } from 'vitest';
import {
  CreateBucketCommand,
  GetBucketTaggingCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { S3StorageAdapter } from '../s3.adapter.js';

const credentials = {
  accessKeyId: 'A'.repeat(20),
  secretAccessKey: 's'.repeat(40),
};
const region = 'us-west-2';

function environment(): Environment {
  return {
    id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {},
    createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('S3StorageAdapter', () => {
  it('inventories bounded buckets with durable account scope', async () => {
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        expect(command).toBeInstanceOf(ListBucketsCommand);
        return { Buckets: [{ Name: 'customer-documents', BucketRegion: 'us-west-2' }, { Name: 'archive' }] };
      }),
      destroy: vi.fn(),
    };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);

    await expect(adapter.inspectStorageResources({ resource: 'storage', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'storage',
        storage: [{
          id: 'customer-documents',
          name: 'customer-documents',
          providerScope: { accountId: '123456789012' },
        }],
        truncated: true,
        partial: false,
      });
  });

  it('uses the native AWS credential chain without requiring access keys in Hypervibe', async () => {
    const seen: unknown[] = [];
    const s3 = { send: vi.fn(), destroy: vi.fn() };
    const sts = {
      send: vi.fn(async () => ({ Account: '123456789012' })),
      destroy: vi.fn(),
    };
    const adapter = new S3StorageAdapter((authentication) => {
      seen.push(authentication);
      return { s3, sts };
    });

    await adapter.connect({ authMode: 'default' });

    await expect(adapter.verify()).resolves.toMatchObject({ success: true });
    expect(seen).toEqual([{ authMode: 'default' }]);
  });

  it('does not copy an expiring AWS CLI or SSO session into a deployed service', async () => {
    const s3 = { send: vi.fn(), destroy: vi.fn() };
    const sts = { send: vi.fn(), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(
      () => ({ s3, sts }),
      async () => ({
        accessKeyId: 'A'.repeat(20),
        secretAccessKey: 's'.repeat(40),
        sessionToken: 'temporary-session',
        expiration: new Date(Date.now() + 60 * 60 * 1_000),
      })
    );
    await adapter.connect({ authMode: 'default' });

    await expect(adapter.getRuntimeEnv(
      environment(),
      { accountId: '123456789012', region: 'us-west-2' },
      'managed-bucket',
      'documents'
    )).rejects.toThrow(/will not copy an expiring CLI\/SSO session/);
  });

  it('creates a tagged, encrypted, private bucket and returns composite scope', async () => {
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) {
        throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      }
      return {};
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetCallerIdentityCommand);
      return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/hypervibe' };
    }), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);

    const contextResult = await adapter.ensureContext('friend-app', environment(), {}, region);
    const result = await adapter.ensureBucket(
      environment(), contextResult.context!, 'documents', region
    );

    expect(contextResult.context).toMatchObject({ accountId: '123456789012', region: 'us-west-2' });
    expect(result.receipt.success).toBe(true);
    expect(result.externalId).toMatch(/^hv-friend-app-production-documents-[0-9a-f]{10}$/);
    expect(s3.send.mock.calls.map(([command]) => (command as object).constructor)).toEqual([
      HeadBucketCommand,
      CreateBucketCommand,
      PutBucketTaggingCommand,
      PutPublicAccessBlockCommand,
      PutBucketEncryptionCommand,
    ]);
  });

  it('observes only buckets tagged for the selected Hypervibe environment', async () => {
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketTaggingCommand) {
        const bucket = (command.input as { Bucket: string }).Bucket;
        return bucket === 'managed-bucket'
          ? { TagSet: [{ Key: 'hypervibe-environment-id', Value: 'environment-1' }, { Key: 'hypervibe-storage-name', Value: 'documents' }] }
          : { TagSet: [{ Key: 'owner', Value: 'someone-else' }] };
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'a.pdf', Size: 42 }], IsTruncated: false };
      }
      if (command instanceof ListBucketsCommand) {
        expect(command.input).toMatchObject({ Prefix: 'hv-', BucketRegion: 'us-west-2' });
      }
      return { Buckets: [{ Name: 'managed-bucket' }, { Name: 'unmanaged-bucket' }] };
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext('friend-app', environment(), {}, region)).context!;

    await expect(adapter.observe(environment(), context)).resolves.toEqual([expect.objectContaining({
      provider: 's3', externalId: 'managed-bucket', name: 'documents', region: 'us-west-2',
      instanceScope: expect.objectContaining({ accountId: '123456789012', region: 'us-west-2' }),
      objectCount: 1, sizeBytes: 42,
    })]);
  });

  it('refuses to adopt an existing deterministic bucket without ownership tags', async () => {
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof GetBucketTaggingCommand) return { TagSet: [] };
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext('friend-app', environment(), {}, region)).context!;

    const result = await adapter.ensureBucket(environment(), context, 'documents', region);

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('not owned');
    expect(s3.send.mock.calls.some(([command]) => command instanceof CreateBucketCommand)).toBe(false);
  });

  it('retains the exact bucket id when post-create configuration and rollback both fail', async () => {
    let createCount = 0;
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) {
        if (createCount === 0) {
          throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        }
        return {};
      }
      if (command instanceof CreateBucketCommand) {
        createCount += 1;
        return {};
      }
      if (command instanceof PutBucketTaggingCommand) throw new Error('tagging denied');
      if (command instanceof DeleteBucketCommand) throw new Error('rollback denied');
      if (command instanceof GetBucketTaggingCommand) return { TagSet: [] };
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext('friend-app', environment(), {}, region)).context!;

    const first = await adapter.ensureBucket(environment(), context, 'documents', region);

    expect(first).toMatchObject({
      receipt: {
        success: false,
        error: expect.stringContaining('rollback failed: rollback denied'),
        data: {
          externalId: expect.stringMatching(/^hv-friend-app-production-documents-/),
          created: true,
          rollback: 'failed',
          recoveryRequired: true,
        },
      },
      externalId: expect.stringMatching(/^hv-friend-app-production-documents-/),
      context,
    });
    const rollback = s3.send.mock.calls.find(([command]) => command instanceof DeleteBucketCommand)?.[0] as DeleteBucketCommand;
    expect(rollback.input).toMatchObject({ ExpectedBucketOwner: '123456789012' });

    const retry = await adapter.ensureBucket(environment(), context, 'documents', region);

    expect(retry.receipt).toMatchObject({ success: false, error: expect.stringContaining('not owned') });
    expect(createCount).toBe(1);
  });

  it('reapplies private configuration when retrying an existing owned bucket', async () => {
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof GetBucketTaggingCommand) {
        return { TagSet: [
          { Key: 'hypervibe-environment-id', Value: 'environment-1' },
          { Key: 'hypervibe-storage-name', Value: 'documents' },
        ] };
      }
      return {};
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(async () => ({ Account: '123456789012' })), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext('friend-app', environment(), {}, region)).context!;

    const result = await adapter.ensureBucket(environment(), context, 'documents', region);

    expect(result.receipt).toMatchObject({ success: true, data: { created: false } });
    expect(s3.send.mock.calls.some(([command]) => command instanceof CreateBucketCommand)).toBe(false);
    expect(s3.send.mock.calls.some(([command]) => command instanceof PutBucketTaggingCommand)).toBe(false);
    expect(s3.send.mock.calls.some(([command]) => command instanceof PutPublicAccessBlockCommand)).toBe(true);
    expect(s3.send.mock.calls.some(([command]) => command instanceof PutBucketEncryptionCommand)).toBe(true);
  });

  it('returns the established S3 runtime contract without exposing it in receipts', async () => {
    const s3 = { send: vi.fn(), destroy: vi.fn() };
    const sts = { send: vi.fn(), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);

    expect(adapter.runtimeEnvKeys('documents')).toEqual([
      'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_S3_BUCKET_NAME', 'AWS_DEFAULT_REGION', 'AWS_S3_URL_STYLE',
    ]);
    await expect(adapter.getRuntimeEnv(environment(), { accountId: '123456789012', region: 'us-west-2' }, 'bucket', 'documents'))
      .resolves.toMatchObject({ AWS_S3_BUCKET_NAME: 'bucket', AWS_DEFAULT_REGION: 'us-west-2' });
  });

  it('empties owned object versions before confirmed bucket deletion', async () => {
    let headCount = 0;
    const s3 = { send: vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) {
        headCount += 1;
        if (headCount > 1) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return {};
      }
      if (command instanceof GetBucketTaggingCommand) {
        return { TagSet: [{ Key: 'hypervibe-environment-id', Value: 'environment-1' }] };
      }
      if (command instanceof ListObjectVersionsCommand) {
        return { Versions: [{ Key: 'a.pdf', VersionId: 'version-1' }], IsTruncated: false };
      }
      if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false };
      return {};
    }), destroy: vi.fn() };
    const sts = { send: vi.fn(), destroy: vi.fn() };
    const adapter = new S3StorageAdapter(() => ({ s3, sts }));
    await adapter.connect(credentials);

    await expect(adapter.destroyBucket(
      environment(), { accountId: '123456789012', region: 'us-west-2' }, 'managed-bucket'
    )).resolves.toMatchObject({ success: true });
    expect(s3.send.mock.calls.some(([command]) => command instanceof DeleteObjectsCommand)).toBe(true);
    expect(s3.send.mock.calls.some(([command]) => command instanceof DeleteBucketCommand)).toBe(true);
  });
});
