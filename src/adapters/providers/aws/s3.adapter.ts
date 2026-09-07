import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ObservedStorage } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IStorageAdapter,
  StorageContext,
  StorageCredentials,
  StorageEnsureResult,
} from '../../../domain/ports/storage.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import { createS3ObjectClient } from '../../../domain/services/object-storage-transfer.service.js';
import {
  S3_STORAGE_RUNTIME_ENV_KEYS,
  s3StorageRuntimeEnv,
} from '../../../domain/services/storage-runtime-env.js';

const ENVIRONMENT_TAG = 'hypervibe-environment-id';
const STORAGE_NAME_TAG = 'hypervibe-storage-name';
const PROJECT_TAG = 'hypervibe-project';

const S3StorageAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'static']).default('static'),
  accessKeyId: z.string().trim().min(16, 'AWS access key ID is required').optional(),
  secretAccessKey: z.string().min(32, 'AWS secret access key is required').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'default') return;
  if (!value.accessKeyId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessKeyId'], message: 'AWS access key ID is required' });
  if (!value.secretAccessKey) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secretAccessKey'], message: 'AWS secret access key is required' });
});

export const S3StorageCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { region: _legacyRegion, ...authentication } = input as Record<string, unknown>;
  if (!authentication.authMode && (authentication.accessKeyId || authentication.secretAccessKey)) {
    authentication.authMode = 'static';
  }
  return authentication;
}, S3StorageAuthenticationSchema);

export type S3StorageCredentials = z.infer<typeof S3StorageCredentialsSchema>;

interface AwsCommandClient {
  send(command: unknown): Promise<any>;
  destroy(): void;
}

export type S3StorageClientFactory = (credentials: S3StorageCredentials, region: string) => {
  s3: AwsCommandClient;
  sts: AwsCommandClient;
};
type AwsCredentialProvider = ReturnType<typeof defaultProvider>;

function defaultClientFactory(credentials: S3StorageCredentials, region: string): ReturnType<S3StorageClientFactory> {
  const config = {
    region,
    ...(credentials.authMode === 'static'
      ? { credentials: { accessKeyId: credentials.accessKeyId!, secretAccessKey: credentials.secretAccessKey! } }
      : {}),
  };
  return { s3: new S3Client(config), sts: new STSClient(config) };
}

function slug(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deterministicBucketName(context: StorageContext, environment: Environment, name: string): string {
  const base = slug(`hv-${context.projectName ?? environment.projectId}-${environment.name}-${name}`);
  const suffix = createHash('sha256')
    .update(`${context.accountId}\0${environment.id}\0${name}`)
    .digest('hex')
    .slice(0, 10);
  return `${base.slice(0, 52)}-${suffix}`.replace(/-+$/g, '');
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = '$metadata' in error && error.$metadata && typeof error.$metadata === 'object'
    ? error.$metadata as { httpStatusCode?: number }
    : undefined;
  return metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return statusCode(error) === 404 || name === 'NotFound' || name === 'NoSuchBucket';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class S3StorageAdapter implements IStorageAdapter {
  readonly name = 's3';
  readonly capabilities = {
    kind: 'object' as const,
    regions: [],
    privateOnly: true,
    supportsUsageObservation: true,
    supportsObjectTransfer: true,
  };

  private credentials: S3StorageCredentials | null = null;
  private s3: AwsCommandClient | null = null;
  private sts: AwsCommandClient | null = null;
  private region: string | null = null;

  constructor(
    private readonly clientFactory: S3StorageClientFactory = defaultClientFactory,
    private readonly defaultCredentialsProvider: AwsCredentialProvider = defaultProvider()
  ) {}

  runtimeEnvKeys(_name: string): string[] {
    return [...S3_STORAGE_RUNTIME_ENV_KEYS];
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = S3StorageCredentialsSchema.parse(credentials);
    this.configureRegion('us-east-1');
  }

  async disconnect(): Promise<void> {
    this.s3?.destroy();
    this.sts?.destroy();
    this.s3 = null;
    this.sts = null;
    this.credentials = null;
    this.region = null;
  }

  async verify(): Promise<VerifyResult> {
    try {
      const identity = await this.stsClient().send(new GetCallerIdentityCommand({}));
      return typeof identity.Account === 'string'
        ? { success: true, email: `AWS account ${identity.Account}` }
        : { success: false, error: 'AWS STS did not return an account identity.' };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async ensureContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext> = {},
    desiredRegion?: string
  ): Promise<StorageEnsureResult> {
    return this.resolveAwsContext(projectName, environment, context, desiredRegion);
  }

  async resolveObservationContext(
    projectName: string,
    environment: Environment,
    desiredRegion: string
  ): Promise<StorageEnsureResult> {
    return this.resolveAwsContext(projectName, environment, {}, desiredRegion);
  }

  private async resolveAwsContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext>,
    desiredRegion?: string
  ): Promise<StorageEnsureResult> {
    try {
      const region = context.region ?? desiredRegion;
      if (!region || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
        throw new Error('A valid desired AWS region is required in the storage spec.');
      }
      this.configureRegion(region);
      const identity = await this.stsClient().send(new GetCallerIdentityCommand({}));
      if (typeof identity.Account !== 'string') {
        throw new Error('AWS STS did not return an account identity.');
      }
      if (context.accountId && context.accountId !== identity.Account) {
        throw new Error(`Bound AWS account ${context.accountId} does not match connected account ${identity.Account}.`);
      }
      const resolved = {
        accountId: identity.Account,
        region,
        projectName,
        environmentName: environment.name,
        environmentId: environment.id,
      };
      return {
        receipt: { success: true, message: `AWS S3 context is ready in ${identity.Account}/${region}` },
        context: resolved,
      };
    } catch (error) {
      return { receipt: { success: false, message: 'Failed to resolve AWS S3 context', error: errorMessage(error) } };
    }
  }

  async observe(environment: Environment, context: StorageContext): Promise<ObservedStorage[]> {
    this.assertContext(context);
    const observed: ObservedStorage[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.s3Client().send(new ListBucketsCommand({
        Prefix: 'hv-',
        BucketRegion: context.region,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      for (const bucket of result.Buckets ?? []) {
        if (typeof bucket.Name !== 'string') continue;
        const tags = await this.bucketTags(bucket.Name);
        if (tags[ENVIRONMENT_TAG] !== environment.id || !tags[STORAGE_NAME_TAG]) continue;
        const usage = await this.usage(bucket.Name);
        observed.push({
          provider: this.name,
          kind: 'object',
          externalId: bucket.Name,
          instanceScope: { ...context },
          name: tags[STORAGE_NAME_TAG],
          region: context.region,
          status: 'ready',
          ...usage,
        });
      }
      continuationToken = result.ContinuationToken;
    } while (continuationToken);
    return observed.sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectStorageResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const identity = await this.stsClient().send(new GetCallerIdentityCommand({}));
    if (typeof identity.Account !== 'string' || identity.Account.length === 0) {
      throw new Error('AWS STS did not return an account identity.');
    }
    const buckets: Array<{ Name?: string; BucketRegion?: string }> = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.s3Client().send(new ListBucketsCommand({
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      buckets.push(...(result.Buckets ?? []));
      continuationToken = result.ContinuationToken;
    } while (continuationToken);
    const matched = buckets
      .filter((bucket) => typeof bucket.Name === 'string')
      .filter((bucket) => !request.id || bucket.Name === request.id)
      .filter((bucket) => !request.name || bucket.Name?.toLowerCase() === request.name.toLowerCase());
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'storage',
      storage: matched.slice(0, request.limit).map((bucket) => ({
        id: bucket.Name!,
        name: bucket.Name!,
        kind: 'object',
        status: 'ready',
        ...(bucket.BucketRegion ? { region: bucket.BucketRegion } : {}),
        providerScope: { accountId: identity.Account },
      })),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  async ensureBucket(
    environment: Environment,
    context: StorageContext,
    name: string,
    region: string
  ): Promise<StorageEnsureResult> {
    try {
      this.assertContext(context);
      if (region !== context.region) {
        throw new Error(`Desired S3 region ${region} does not match connected region ${context.region}.`);
      }
      const bucket = deterministicBucketName(context, environment, name);
      if (await this.bucketExists(bucket, context.accountId)) {
        const tags = await this.bucketTags(bucket);
        if (tags[ENVIRONMENT_TAG] !== environment.id || tags[STORAGE_NAME_TAG] !== name) {
          throw new Error(`S3 bucket ${bucket} exists but is not owned by this Hypervibe storage binding.`);
        }
        try {
          await this.configurePrivateBucket(bucket, environment, context, name, false);
        } catch (error) {
          return {
            receipt: {
              success: false,
              message: `Failed to repair AWS S3 bucket "${bucket}" configuration`,
              error: errorMessage(error),
              data: {
                externalId: bucket,
                created: false,
                configuration: 'unknown',
                recoveryRequired: true,
              },
            },
            externalId: bucket,
            context,
          };
        }
        return {
          receipt: { success: true, message: `Using existing AWS S3 bucket "${bucket}"`, data: { created: false } },
          externalId: bucket,
          context,
        };
      }

      await this.s3Client().send(new CreateBucketCommand({
        Bucket: bucket,
        ObjectOwnership: 'BucketOwnerEnforced',
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
      }));
      try {
        await this.configurePrivateBucket(bucket, environment, context, name);
      } catch (configurationError) {
        try {
          await this.s3Client().send(new DeleteBucketCommand({
            Bucket: bucket,
            ExpectedBucketOwner: context.accountId,
          }));
        } catch (rollbackError) {
          return {
            receipt: {
              success: false,
              message: `Failed to configure newly created AWS S3 bucket "${bucket}" and rollback failed`,
              error: `${errorMessage(configurationError)}; rollback failed: ${errorMessage(rollbackError)}`,
              data: {
                externalId: bucket,
                created: true,
                rollback: 'failed',
                recoveryRequired: true,
              },
            },
            externalId: bucket,
            context,
          };
        }
        try {
          if (await this.bucketExists(bucket, context.accountId)) {
            return {
              receipt: {
                success: false,
                message: `Failed to configure newly created AWS S3 bucket "${bucket}"; rollback is not yet confirmed`,
                error: `${errorMessage(configurationError)}; the exact bucket still exists after rollback acknowledgement`,
                data: {
                  externalId: bucket,
                  created: true,
                  rollback: 'pending',
                  recoveryRequired: true,
                },
              },
              externalId: bucket,
              context,
            };
          }
        } catch (rollbackObservationError) {
          return {
            receipt: {
              success: false,
              message: `Failed to configure newly created AWS S3 bucket "${bucket}"; rollback state is unknown`,
              error: `${errorMessage(configurationError)}; rollback observation failed: ${errorMessage(rollbackObservationError)}`,
              data: {
                externalId: bucket,
                created: true,
                rollback: 'unknown',
                recoveryRequired: true,
              },
            },
            externalId: bucket,
            context,
          };
        }
        return {
          receipt: {
            success: false,
            message: `Failed to configure newly created AWS S3 bucket "${bucket}"; rollback was confirmed`,
            error: errorMessage(configurationError),
            data: { created: true, rollback: 'confirmed', recoveryRequired: false },
          },
        };
      }
      return {
        receipt: { success: true, message: `Created private AWS S3 bucket "${bucket}"`, data: { created: true } },
        externalId: bucket,
        context,
      };
    } catch (error) {
      return { receipt: { success: false, message: `Failed to ensure AWS S3 bucket "${name}"`, error: errorMessage(error) } };
    }
  }

  async getCredentials(
    _environment: Environment,
    context: StorageContext,
    externalId: string
  ): Promise<StorageCredentials> {
    this.assertContext(context);
    const authentication = this.connectedCredentials();
    const credentials = authentication.authMode === 'static'
      ? {
        accessKeyId: authentication.accessKeyId!,
        secretAccessKey: authentication.secretAccessKey!,
      }
      : await this.defaultCredentialsProvider();
    return {
      bucket: externalId,
      endpoint: `https://s3.${context.region}.amazonaws.com`,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      ...(credentials.expiration ? { expiration: credentials.expiration } : {}),
      region: context.region,
      urlStyle: 'virtual',
    };
  }

  async getRuntimeEnv(
    environment: Environment,
    context: StorageContext,
    externalId: string,
    _name: string
  ): Promise<Record<string, string>> {
    const credentials = await this.getCredentials(environment, context, externalId);
    if (credentials.expiration) {
      throw new Error(
        'The native AWS credential chain returned a temporary session. Hypervibe can use it for storage lifecycle and migration, but will not copy an expiring CLI/SSO session into a deployed service. Use ECS workload identity or an explicit durable runtime credential.'
      );
    }
    return s3StorageRuntimeEnv(credentials);
  }

  async openObjectTransfer(environment: Environment, context: StorageContext, externalId: string) {
    return createS3ObjectClient(await this.getCredentials(environment, context, externalId));
  }

  async destroyBucket(environment: Environment, context: StorageContext, externalId: string): Promise<Receipt> {
    try {
      this.assertContext(context);
      if (!await this.bucketExists(externalId, context.accountId)) {
        return { success: true, message: `AWS S3 bucket "${externalId}" is already absent` };
      }
      const tags = await this.bucketTags(externalId);
      if (tags[ENVIRONMENT_TAG] !== environment.id) {
        throw new Error(`AWS S3 bucket ${externalId} is not owned by this Hypervibe environment.`);
      }
      await this.emptyBucket(externalId);
      await this.s3Client().send(new DeleteBucketCommand({ Bucket: externalId, ExpectedBucketOwner: context.accountId }));
      if (await this.bucketExists(externalId, context.accountId)) {
        throw new Error(`AWS S3 bucket ${externalId} deletion is not yet observable.`);
      }
      return { success: true, message: `Deleted AWS S3 bucket "${externalId}" and all objects` };
    } catch (error) {
      return { success: false, message: `Failed to delete AWS S3 bucket "${externalId}"`, error: errorMessage(error) };
    }
  }

  private connectedCredentials(): S3StorageCredentials {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return this.credentials;
  }

  private s3Client(): AwsCommandClient {
    if (!this.s3) throw new Error('Not connected. Call connect() first.');
    return this.s3;
  }

  private stsClient(): AwsCommandClient {
    if (!this.sts) throw new Error('Not connected. Call connect() first.');
    return this.sts;
  }

  private assertContext(context: StorageContext): void {
    this.connectedCredentials();
    if (!context.accountId || !context.region) throw new Error('AWS S3 account/region context is missing.');
    this.configureRegion(context.region);
  }

  private configureRegion(region: string): void {
    if (this.region === region && this.s3 && this.sts) return;
    const credentials = this.connectedCredentials();
    this.s3?.destroy();
    this.sts?.destroy();
    const clients = this.clientFactory(credentials, region);
    this.s3 = clients.s3;
    this.sts = clients.sts;
    this.region = region;
  }

  private async bucketExists(bucket: string, expectedOwner?: string): Promise<boolean> {
    try {
      await this.s3Client().send(new HeadBucketCommand({ Bucket: bucket, ...(expectedOwner ? { ExpectedBucketOwner: expectedOwner } : {}) }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async bucketTags(bucket: string): Promise<Record<string, string>> {
    try {
      const response = await this.s3Client().send(new GetBucketTaggingCommand({ Bucket: bucket }));
      return Object.fromEntries((response.TagSet ?? []).flatMap((tag: { Key?: string; Value?: string }) => (
        typeof tag.Key === 'string' && typeof tag.Value === 'string' ? [[tag.Key, tag.Value]] : []
      )));
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchTagSet') return {};
      throw error;
    }
  }

  private async configurePrivateBucket(
    bucket: string,
    environment: Environment,
    context: StorageContext,
    name: string,
    writeOwnershipTags = true
  ): Promise<void> {
    if (writeOwnershipTags) {
      await this.s3Client().send(new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: { TagSet: [
          { Key: ENVIRONMENT_TAG, Value: environment.id },
          { Key: STORAGE_NAME_TAG, Value: name },
          { Key: PROJECT_TAG, Value: context.projectName ?? environment.projectId },
        ] },
      }));
    }
    await this.s3Client().send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }));
    await this.s3Client().send(new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }));
  }

  private async usage(bucket: string): Promise<{ objectCount: number; sizeBytes: number }> {
    let continuationToken: string | undefined;
    let objectCount = 0;
    let sizeBytes = 0;
    do {
      const response = await this.s3Client().send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
      for (const object of response.Contents ?? []) {
        objectCount += 1;
        sizeBytes += object.Size ?? 0;
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return { objectCount, sizeBytes };
  }

  private async emptyBucket(bucket: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const response = await this.s3Client().send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
      const objects = [
        ...(response.Versions ?? []),
        ...(response.DeleteMarkers ?? []),
      ].flatMap((item: { Key?: string; VersionId?: string }) => (
        item.Key ? [{ Key: item.Key, ...(item.VersionId ? { VersionId: item.VersionId } : {}) }] : []
      ));
      if (objects.length > 0) {
        await this.s3Client().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      }
      keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
      versionIdMarker = response.IsTruncated ? response.NextVersionIdMarker : undefined;
    } while (keyMarker);

    let continuationToken: string | undefined;
    do {
      const response = await this.s3Client().send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
      const objects = (response.Contents ?? []).flatMap((item: { Key?: string }) => item.Key ? [{ Key: item.Key }] : []);
      if (objects.length > 0) {
        await this.s3Client().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

providerRegistry.register({
  metadata: {
    name: 's3',
    displayName: 'Amazon S3',
    category: 'storage',
    credentialsSchema: S3StorageCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    credentials: {
      supportsNativeCliAuth: true,
      environmentVariableAliases: [
        ['HYPERVIBE_AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
        ['HYPERVIBE_AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'],
      ],
    },
    connectionAliases: ['ecs'],
    maturity: {
      lifecycle: {
        storage: { status: 'ready-for-live' },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new S3StorageAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['storage'],
    defaultResource: 'storage',
    selectors: {
      storage: { mode: 'provider-resource', optional: ['id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['accountId'] },
    },
    inspect: (adapter, request) => (
      adapter as S3StorageAdapter
    ).inspectStorageResources(request),
  },
});
