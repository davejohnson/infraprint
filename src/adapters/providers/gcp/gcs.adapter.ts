import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ObservedStorage } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IStorageAdapter,
  StorageContext,
  StorageEnsureResult,
  StorageObjectClient,
  StorageObjectPayload,
} from '../../../domain/ports/storage.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

const STORAGE_API = 'https://storage.googleapis.com';
const ENVIRONMENT_LABEL = 'hypervibe_environment_id';
const STORAGE_NAME_LABEL = 'hypervibe_storage_name';
const PROJECT_LABEL = 'hypervibe_project';

const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().min(1),
}).passthrough();

const GcsStorageAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'serviceAccount']).default('serviceAccount'),
  credentials: z.string().min(1, 'GCP service account JSON is required').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'default' || value.credentials) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentials'], message: 'GCP service account JSON is required' });
});

export const GcsStorageCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.type === 'service_account') return { authMode: 'serviceAccount', credentials: JSON.stringify(record) };
  if (!record.authMode && record.credentials) record.authMode = 'serviceAccount';
  return { authMode: record.authMode, credentials: record.credentials };
}, GcsStorageAuthenticationSchema);

export type GcsStorageCredentials = z.infer<typeof GcsStorageCredentialsSchema>;
type ServiceAccount = z.infer<typeof ServiceAccountSchema>;
type TokenProvider = (credentials: GcsStorageCredentials, serviceAccount: ServiceAccount | null) => Promise<{
  token: string;
  email: string;
  expiresAt?: number;
}>;

export interface GcsStorageAdapterOptions {
  fetch?: typeof fetch;
  tokenProvider?: TokenProvider;
  defaultProjectProvider?: () => Promise<string>;
}

interface GcsBucket {
  name?: string;
  location?: string;
  labels?: Record<string, string>;
}

interface GcsObject {
  name?: string;
  size?: string;
}

async function defaultTokenProvider(_credentials: GcsStorageCredentials, serviceAccount: ServiceAccount | null) {
  const auth = new GoogleAuth({
    ...(serviceAccount ? { credentials: serviceAccount, projectId: serviceAccount.project_id } : {}),
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === 'string' ? result : result.token;
  if (!token) throw new Error('Google authentication did not return an access token.');
  return {
    token,
    email: serviceAccount?.client_email ?? 'Google Application Default Credentials',
    expiresAt: client.credentials.expiry_date ?? Date.now() + 50 * 60 * 1_000,
  };
}

function slug(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function bucketName(context: StorageContext, environment: Environment, name: string): string {
  const base = slug(`hv-${context.projectName ?? environment.projectId}-${environment.name}-${name}`);
  const suffix = createHash('sha256')
    .update(`${context.projectId}\0${environment.id}\0${name}`)
    .digest('hex')
    .slice(0, 10);
  return `${base.slice(0, 52)}-${suffix}`.replace(/-+$/g, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  const detail = `Google Cloud Storage API ${response.status}: ${text.slice(0, 1_000)}`;
  if (response.status === 403) {
    return new Error(
      `${detail}. When GCS reuses the Cloud Run connection, preview hv_connections provider="cloudrun" action="prepare" gcsAccess="inspect" for read-only inventory; `
      + 'for GCS create, transfer, or teardown, preview it with gcsAccess="lifecycle". Both paths require explicit confirmation and may use existing Google Application Default Credentials through adminAuth="default". A standalone GCS connection must grant the equivalent role to its own identity.'
    );
  }
  return new Error(detail);
}

function requestBody(payload: StorageObjectPayload): RequestInit['body'] {
  if (payload.body instanceof Blob) return payload.body;
  if (payload.body instanceof Readable) return Readable.toWeb(payload.body) as ReadableStream;
  return payload.body;
}

class GcsObjectClient implements StorageObjectClient {
  constructor(
    private readonly bucket: string,
    private readonly request: typeof fetch,
    private readonly getToken: () => Promise<string>
  ) {}

  async list() {
    const objects: Array<{ key: string; size: number }> = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams();
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params}`);
      if (!response.ok) throw await responseError(response);
      const body = await response.json() as { items?: GcsObject[]; nextPageToken?: string };
      for (const object of body.items ?? []) {
        if (object.name) objects.push({ key: object.name, size: Number(object.size ?? 0) });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return objects;
  }

  async get(key: string): Promise<StorageObjectPayload> {
    const response = await this.authorized(
      `${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?alt=media`
    );
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error(`Google Cloud Storage object ${key} returned no body.`);
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, header) => {
      if (header.startsWith('x-goog-meta-')) metadata[header.slice('x-goog-meta-'.length)] = value;
    });
    return {
      body: response.body,
      size: Number(response.headers.get('content-length') ?? 0),
      contentType: response.headers.get('content-type') ?? undefined,
      contentEncoding: response.headers.get('content-encoding') ?? undefined,
      cacheControl: response.headers.get('cache-control') ?? undefined,
      contentDisposition: response.headers.get('content-disposition') ?? undefined,
      metadata,
    };
  }

  async put(key: string, payload: StorageObjectPayload): Promise<void> {
    const params = new URLSearchParams({ uploadType: 'media', name: key });
    const headers: Record<string, string> = {};
    if (payload.contentType) headers['content-type'] = payload.contentType;
    const response = await this.authorized(
      `${STORAGE_API}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params}`,
      { method: 'POST', body: requestBody(payload), headers, duplex: 'half' } as RequestInit
    );
    if (!response.ok) throw await responseError(response);
    if (
      payload.contentType
      || payload.contentEncoding
      || payload.cacheControl
      || payload.contentDisposition
      || Object.keys(payload.metadata ?? {}).length > 0
    ) {
      const metadataResponse = await this.authorized(
        `${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(payload.contentType ? { contentType: payload.contentType } : {}),
            ...(payload.contentEncoding ? { contentEncoding: payload.contentEncoding } : {}),
            ...(payload.cacheControl ? { cacheControl: payload.cacheControl } : {}),
            ...(payload.contentDisposition ? { contentDisposition: payload.contentDisposition } : {}),
            ...(payload.metadata ? { metadata: payload.metadata } : {}),
          }),
        }
      );
      if (!metadataResponse.ok) throw await responseError(metadataResponse);
    }
  }

  destroy(): void {}

  private async authorized(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    return this.request(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
  }
}

export class GcsStorageAdapter implements IStorageAdapter {
  readonly name = 'gcs';
  readonly capabilities = {
    kind: 'object' as const,
    regions: [],
    privateOnly: true,
    supportsUsageObservation: true,
    supportsObjectTransfer: true,
  };

  private credentials: GcsStorageCredentials | null = null;
  private serviceAccount: ServiceAccount | null = null;
  private projectId: string | null = null;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private readonly request: typeof fetch;
  private readonly tokenProvider: TokenProvider;
  private readonly defaultProjectProvider: () => Promise<string>;

  constructor(options: GcsStorageAdapterOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider;
    this.defaultProjectProvider = options.defaultProjectProvider ?? (() => new GoogleAuth().getProjectId());
  }

  runtimeEnvKeys(_name: string): string[] {
    return [
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_STORAGE_BUCKET', 'GOOGLE_CLOUD_CREDENTIALS_JSON',
    ];
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = GcsStorageCredentialsSchema.parse(credentials);
    this.projectId = null;
    if (this.credentials.authMode === 'default') {
      this.serviceAccount = null;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.credentials.credentials!);
    } catch {
      throw new Error('GCP service account credentials must be valid JSON.');
    }
    this.serviceAccount = ServiceAccountSchema.parse(parsed);
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccount = null;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.projectId = null;
  }

  async verify(): Promise<VerifyResult> {
    try {
      this.connectedCredentials();
      const projectId = await this.connectedProjectId();
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b?project=${encodeURIComponent(projectId)}&maxResults=1`);
      if (!response.ok) return { success: false, error: (await responseError(response)).message };
      return { success: true, email: this.serviceAccount?.client_email ?? `Google ADC (${projectId})` };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async ensureContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext> = {}
  ): Promise<StorageEnsureResult> {
    return this.resolveGcsContext(projectName, environment, context);
  }

  async resolveObservationContext(
    projectName: string,
    environment: Environment,
    _desiredRegion: string
  ): Promise<StorageEnsureResult> {
    return this.resolveGcsContext(projectName, environment, {});
  }

  private async resolveGcsContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext>
  ): Promise<StorageEnsureResult> {
    try {
      this.connectedCredentials();
      const projectId = await this.connectedProjectId();
      if (context.projectId && context.projectId !== projectId) {
        throw new Error(`Bound GCP project ${context.projectId} does not match connected project ${projectId}.`);
      }
      await this.accessToken();
      const resolved = {
        projectId,
        projectName,
        environmentName: environment.name,
        environmentId: environment.id,
      };
      return {
        receipt: { success: true, message: `Google Cloud Storage context is ready in ${projectId}` },
        context: resolved,
      };
    } catch (error) {
      return { receipt: { success: false, message: 'Failed to resolve Google Cloud Storage context', error: errorMessage(error) } };
    }
  }

  async observe(environment: Environment, context: StorageContext): Promise<ObservedStorage[]> {
    await this.assertContext(context);
    const observed: ObservedStorage[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ project: context.projectId });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b?${params}`);
      if (!response.ok) throw await responseError(response);
      const body = await response.json() as { items?: GcsBucket[]; nextPageToken?: string };
      for (const bucket of body.items ?? []) {
        if (!bucket.name || bucket.labels?.[ENVIRONMENT_LABEL] !== environment.id) continue;
        const name = bucket.labels[STORAGE_NAME_LABEL];
        if (!name) continue;
        const usage = await this.usage(bucket.name);
        observed.push({
          provider: this.name,
          kind: 'object',
          externalId: bucket.name,
          instanceScope: { ...context },
          name,
          region: bucket.location?.toLowerCase(),
          status: 'ready',
          ...usage,
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return observed.sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectStorageResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const projectId = await this.connectedProjectId();
    let buckets: GcsBucket[];
    if (request.id) {
      const bucket = await this.getBucket(request.id);
      buckets = bucket ? [bucket] : [];
    } else {
      buckets = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ project: projectId });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await this.authorized(`${STORAGE_API}/storage/v1/b?${params}`);
        if (!response.ok) throw await responseError(response);
        const body = await response.json() as { items?: GcsBucket[]; nextPageToken?: string };
        buckets.push(...(body.items ?? []));
        pageToken = body.nextPageToken;
      } while (pageToken);
    }
    const matched = buckets
      .filter((bucket) => typeof bucket.name === 'string')
      .filter((bucket) => !request.name || bucket.name?.toLowerCase() === request.name.toLowerCase());
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'storage',
      storage: matched.slice(0, request.limit).map((bucket) => ({
        id: bucket.name!,
        name: bucket.name!,
        kind: 'object',
        status: 'ready',
        ...(bucket.location ? { region: bucket.location.toLowerCase() } : {}),
        ...(bucket.labels?.[STORAGE_NAME_LABEL]
          ? { logicalName: bucket.labels[STORAGE_NAME_LABEL] }
          : {}),
        providerScope: { projectId },
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
      await this.assertContext(context);
      const externalId = bucketName(context, environment, name);
      const existing = await this.getBucket(externalId);
      if (existing) {
        if (existing.labels?.[ENVIRONMENT_LABEL] !== environment.id || existing.labels?.[STORAGE_NAME_LABEL] !== name) {
          throw new Error(`Google Cloud Storage bucket ${externalId} exists but is not owned by this Hypervibe storage binding.`);
        }
        if (existing.location?.toLowerCase() !== region.toLowerCase()) {
          throw new Error(`Google Cloud Storage bucket ${externalId} exists in immutable location ${existing.location}, not ${region}.`);
        }
        return {
          receipt: { success: true, message: `Using existing Google Cloud Storage bucket "${externalId}"`, data: { created: false } },
          externalId,
          context,
        };
      }

      const response = await this.authorized(
        `${STORAGE_API}/storage/v1/b?project=${encodeURIComponent(context.projectId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: externalId,
            location: region,
            labels: {
              [ENVIRONMENT_LABEL]: environment.id,
              [STORAGE_NAME_LABEL]: name,
              [PROJECT_LABEL]: slug(context.projectName ?? environment.projectId).slice(0, 63),
            },
            iamConfiguration: {
              uniformBucketLevelAccess: { enabled: true },
              publicAccessPrevention: 'enforced',
            },
          }),
        }
      );
      if (!response.ok) throw await responseError(response);
      const created = await this.getBucket(externalId);
      if (!created) {
        throw new Error(`Google Cloud Storage bucket ${externalId} did not become observable after creation.`);
      }
      if (
        created.labels?.[ENVIRONMENT_LABEL] !== environment.id
        || created.labels?.[STORAGE_NAME_LABEL] !== name
        || created.location?.toLowerCase() !== region.toLowerCase()
      ) {
        throw new Error(`Google Cloud Storage bucket ${externalId} did not converge to the reviewed labels and location.`);
      }
      return {
        receipt: { success: true, message: `Created private Google Cloud Storage bucket "${externalId}"`, data: { created: true } },
        externalId,
        context,
      };
    } catch (error) {
      return { receipt: { success: false, message: `Failed to ensure Google Cloud Storage bucket "${name}"`, error: errorMessage(error) } };
    }
  }

  async getRuntimeEnv(
    _environment: Environment,
    context: StorageContext,
    externalId: string,
    _name: string
  ): Promise<Record<string, string>> {
    await this.assertContext(context);
    if (!this.serviceAccount) {
      throw new Error(
        'Google Application Default Credentials can manage and migrate storage, but Hypervibe will not copy a local gcloud user session into a deployed service. Reuse the verified Cloud Run connection/workload identity or connect a service-account JSON for cross-cloud runtime access.'
      );
    }
    return {
      OBJECT_STORAGE_PROVIDER: 'gcs',
      OBJECT_STORAGE_BUCKET: externalId,
      GOOGLE_CLOUD_PROJECT: context.projectId,
      GOOGLE_CLOUD_STORAGE_BUCKET: externalId,
      GOOGLE_CLOUD_CREDENTIALS_JSON: this.connectedCredentials().credentials!,
    };
  }

  async openObjectTransfer(
    _environment: Environment,
    context: StorageContext,
    externalId: string
  ): Promise<StorageObjectClient> {
    await this.assertContext(context);
    return new GcsObjectClient(externalId, this.request, () => this.accessToken());
  }

  async destroyBucket(environment: Environment, context: StorageContext, externalId: string): Promise<Receipt> {
    try {
      await this.assertContext(context);
      const bucket = await this.getBucket(externalId);
      if (!bucket) return { success: true, message: `Google Cloud Storage bucket "${externalId}" is already absent` };
      if (bucket.labels?.[ENVIRONMENT_LABEL] !== environment.id) {
        throw new Error(`Google Cloud Storage bucket ${externalId} is not owned by this Hypervibe environment.`);
      }
      const transfer = await this.openObjectTransfer(environment, context, externalId);
      try {
        for (const object of await transfer.list()) {
          const response = await this.authorized(
            `${STORAGE_API}/storage/v1/b/${encodeURIComponent(externalId)}/o/${encodeURIComponent(object.key)}`,
            { method: 'DELETE' }
          );
          if (!response.ok && response.status !== 404) throw await responseError(response);
        }
      } finally {
        transfer.destroy();
      }
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(externalId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw await responseError(response);
      if (await this.getBucket(externalId)) throw new Error(`Google Cloud Storage bucket ${externalId} deletion is not yet observable.`);
      return { success: true, message: `Deleted Google Cloud Storage bucket "${externalId}" and all objects` };
    } catch (error) {
      return { success: false, message: `Failed to delete Google Cloud Storage bucket "${externalId}"`, error: errorMessage(error) };
    }
  }

  private connectedCredentials(): GcsStorageCredentials {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return this.credentials;
  }

  private async connectedProjectId(): Promise<string> {
    this.connectedCredentials();
    if (this.projectId) return this.projectId;
    const projectId = this.serviceAccount?.project_id ?? await this.defaultProjectProvider();
    if (!projectId?.trim()) {
      throw new Error('Google Application Default Credentials did not resolve a project. Select one with gcloud config set project <project-id>.');
    }
    this.projectId = projectId;
    return projectId;
  }

  private async assertContext(context: StorageContext): Promise<void> {
    if (!context.projectId) throw new Error('Google Cloud Storage project context is missing.');
    if (context.projectId !== await this.connectedProjectId()) throw new Error('Google Cloud Storage context does not match the connected project.');
  }

  private async accessToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiresAt - 60_000) {
      const result = await this.tokenProvider(this.connectedCredentials(), this.serviceAccount);
      this.token = result.token;
      this.tokenExpiresAt = result.expiresAt ?? Date.now() + 50 * 60 * 1_000;
    }
    return this.token;
  }

  private async authorized(url: string, init: RequestInit = {}): Promise<Response> {
    return this.request(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
  }

  private async getBucket(name: string): Promise<GcsBucket | null> {
    const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    const bucket = await response.json() as GcsBucket;
    if (!bucket.name) {
      throw new Error(`Google Cloud Storage returned an invalid bucket response for ${name}; absence was not confirmed.`);
    }
    if (bucket.name !== name) {
      throw new Error(`Google Cloud Storage returned bucket ${bucket.name} for exact bucket lookup ${name}.`);
    }
    return bucket;
  }

  private async usage(bucket: string): Promise<{ objectCount: number; sizeBytes: number }> {
    const transfer = new GcsObjectClient(bucket, this.request, () => this.accessToken());
    const objects = await transfer.list();
    return {
      objectCount: objects.length,
      sizeBytes: objects.reduce((total, object) => total + object.size, 0),
    };
  }
}

providerRegistry.register({
  metadata: {
    name: 'gcs',
    displayName: 'Google Cloud Storage',
    category: 'storage',
    credentialsSchema: GcsStorageCredentialsSchema,
    setupHelpUrl: 'https://cloud.google.com/iam/docs/keys-create-delete',
    credentials: {
      defaultScalarKey: 'credentials',
      supportsNativeCliAuth: true,
      environmentVariableAliases: [
        ['HYPERVIBE_GCP_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON'],
      ],
    },
    connectionAliases: ['cloudrun'],
    maturity: {
      lifecycle: {
        storage: { status: 'ready-for-live' },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new GcsStorageAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['storage'],
    defaultResource: 'storage',
    selectors: {
      storage: { mode: 'provider-resource', optional: ['id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId'] },
    },
    inspect: (adapter, request) => (
      adapter as GcsStorageAdapter
    ).inspectStorageResources(request),
  },
});
