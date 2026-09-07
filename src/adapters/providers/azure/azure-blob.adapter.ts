import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
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
  StorageObjectRecord,
} from '../../../domain/ports/storage.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  AzureResourceManagerClient,
  resolveAzureDefaultSubscription,
  type AzureResourceManagerCredentials,
} from './azure-resource-manager.client.js';

const ACCOUNT_API_VERSION = '2025-06-01';
const CONTAINER_API_VERSION = '2025-08-01';
const ENVIRONMENT_TAG = 'hypervibe-environment-id';
const STORAGE_NAME_TAG = 'hypervibe-storage-name';
const PROJECT_TAG = 'hypervibe-project';

const AzureBlobStorageAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'servicePrincipal']).default('servicePrincipal'),
  tenantId: z.string().uuid('Azure tenant ID must be a UUID').optional(),
  subscriptionId: z.string().uuid('Azure subscription ID must be a UUID').optional(),
  clientId: z.string().uuid('Azure service principal client ID must be a UUID').optional(),
  clientSecret: z.string().min(8, 'Azure service principal client secret is required').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'default') return;
  for (const field of ['tenantId', 'subscriptionId', 'clientId', 'clientSecret'] as const) {
    if (!value[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `Azure ${field} is required` });
  }
});

export const AzureBlobStorageCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { resourceGroup: _legacyResourceGroup, location: _legacyLocation, ...authentication } = input as Record<string, unknown>;
  if (!authentication.authMode && (authentication.tenantId || authentication.clientId || authentication.clientSecret)) {
    authentication.authMode = 'servicePrincipal';
  }
  return authentication;
}, AzureBlobStorageAuthenticationSchema);

export type AzureBlobStorageCredentials = z.infer<typeof AzureBlobStorageCredentialsSchema>;
export type ConnectedAzureBlobStorageCredentials = AzureResourceManagerCredentials;

export interface AzureStorageAccount {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
}

export interface AzureBlobContainer {
  id: string;
  name: string;
}

export interface AzureStorageControlPlane {
  verifySubscription(): Promise<void>;
  ensureScope(location: string, tags: Record<string, string>): Promise<{ created: boolean }>;
  listAccounts(): Promise<AzureStorageAccount[]>;
  listContainers(account: AzureStorageAccount): Promise<AzureBlobContainer[]>;
  getAccount(name: string): Promise<AzureStorageAccount | null>;
  createAccount(name: string, location: string, tags: Record<string, string>): Promise<AzureStorageAccount>;
  getContainer(account: AzureStorageAccount, container: string): Promise<AzureBlobContainer | null>;
  createContainer(account: AzureStorageAccount, container: string): Promise<AzureBlobContainer>;
  listKeys(account: AzureStorageAccount): Promise<string>;
  deleteAccount(account: AzureStorageAccount): Promise<boolean>;
}

export interface AzureBlobDataPlane extends StorageObjectClient {
  deleteAll(): Promise<void>;
}

export interface AzureBlobStorageAdapterOptions {
  controlPlaneFactory?: (credentials: ConnectedAzureBlobStorageCredentials, resourceGroup?: string) => AzureStorageControlPlane;
  dataPlaneFactory?: (account: string, key: string, container: string) => AzureBlobDataPlane;
  defaultCredentialProvider?: (preferredSubscriptionId?: string) => Promise<{ authMode: 'default'; subscriptionId: string }>;
}

interface AzureStorageKeys {
  keys?: Array<{ value?: string; permissions?: string }>;
}

class ArmStorageControlPlane implements AzureStorageControlPlane {
  private readonly arm: AzureResourceManagerClient;

  constructor(credentials: ConnectedAzureBlobStorageCredentials, resourceGroup?: string) {
    this.arm = new AzureResourceManagerClient({ ...credentials, ...(resourceGroup ? { resourceGroup } : {}) });
  }

  async verifySubscription(): Promise<void> {
    await this.arm.verifySubscription();
  }

  async ensureScope(location: string, tags: Record<string, string>): Promise<{ created: boolean }> {
    const resourceGroup = this.arm.credentials.resourceGroup;
    if (!resourceGroup) throw new Error('Azure Blob Storage resource-group context is missing.');
    await this.verifySubscription();
    await this.ensureStorageProviderRegistration();
    const path = `/subscriptions/${encodeURIComponent(this.arm.credentials.subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(resourceGroup)}`;
    const existing = await this.arm.getNullable<{ tags?: Record<string, string> }>(path, '2024-11-01');
    if (existing) {
      if (existing.tags?.['managed-by'] !== 'hypervibe' || existing.tags?.[ENVIRONMENT_TAG] !== tags[ENVIRONMENT_TAG]) {
        throw new Error(`Azure resource group ${resourceGroup} exists but is not owned by this Hypervibe environment.`);
      }
      return { created: false };
    }
    await this.arm.request('PUT', path, '2024-11-01', { location, tags });
    return { created: true };
  }

  async listAccounts(): Promise<AzureStorageAccount[]> {
    const resourceGroup = this.arm.credentials.resourceGroup;
    return this.arm.listAll<AzureStorageAccount>(
      resourceGroup
        ? this.arm.resourceGroupProviderPath('Microsoft.Storage', 'storageAccounts')
        : `/subscriptions/${encodeURIComponent(this.arm.credentials.subscriptionId)}/providers/Microsoft.Storage/storageAccounts`,
      ACCOUNT_API_VERSION
    );
  }

  async listContainers(account: AzureStorageAccount): Promise<AzureBlobContainer[]> {
    return this.arm.listAll<AzureBlobContainer>(
      `${account.id}/blobServices/default/containers`,
      CONTAINER_API_VERSION
    );
  }

  async getAccount(name: string): Promise<AzureStorageAccount | null> {
    return this.arm.getNullable<AzureStorageAccount>(
      this.arm.resourcePath('Microsoft.Storage', 'storageAccounts', name),
      ACCOUNT_API_VERSION
    );
  }

  async createAccount(name: string, location: string, tags: Record<string, string>): Promise<AzureStorageAccount> {
    return this.arm.request<AzureStorageAccount>(
      'PUT',
      this.arm.resourcePath('Microsoft.Storage', 'storageAccounts', name),
      ACCOUNT_API_VERSION,
      {
        location,
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        tags,
        properties: {
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
          allowBlobPublicAccess: false,
          allowSharedKeyAccess: true,
        },
      }
    );
  }

  async getContainer(account: AzureStorageAccount, container: string): Promise<AzureBlobContainer | null> {
    const result = await this.arm.getNullable<AzureBlobContainer>(
      this.containerPath(account, container),
      CONTAINER_API_VERSION
    );
    if (!result) return null;
    if (!result.id) throw new Error(`Azure Blob container ${container} returned no ARM resource ID.`);
    return { id: result.id, name: container };
  }

  async createContainer(account: AzureStorageAccount, container: string): Promise<AzureBlobContainer> {
    const result = await this.arm.request<AzureBlobContainer>('PUT', this.containerPath(account, container), CONTAINER_API_VERSION, {
      properties: { publicAccess: 'None' },
    });
    if (!result.id) throw new Error(`Azure Blob container ${container} returned no ARM resource ID.`);
    return { id: result.id, name: container };
  }

  async listKeys(account: AzureStorageAccount): Promise<string> {
    const response = await this.arm.request<AzureStorageKeys>('POST', `${account.id}/listKeys`, ACCOUNT_API_VERSION);
    const key = response.keys?.find((item) => item.permissions?.toLowerCase() === 'full')?.value
      ?? response.keys?.find((item) => item.value)?.value;
    if (!key) throw new Error(`Azure Storage account ${account.name} did not return an account key.`);
    return key;
  }

  async deleteAccount(account: AzureStorageAccount): Promise<boolean> {
    return this.arm.deleteIfPresent(account.id, ACCOUNT_API_VERSION);
  }

  private containerPath(account: AzureStorageAccount, container: string): string {
    return `${account.id}/blobServices/default/containers/${encodeURIComponent(container)}`;
  }

  private async ensureStorageProviderRegistration(): Promise<void> {
    const path = `/subscriptions/${encodeURIComponent(this.arm.credentials.subscriptionId)}/providers/Microsoft.Storage`;
    const current = await this.arm.getNullable<{ registrationState?: string }>(path, '2021-04-01');
    if (current?.registrationState === 'Registered') return;
    await this.arm.request('POST', `${path}/register`, '2021-04-01');
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const observed = await this.arm.getNullable<{ registrationState?: string }>(path, '2021-04-01');
      if (observed?.registrationState === 'Registered') return;
      if (attempt < 120) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('Azure resource provider Microsoft.Storage did not become registered.');
  }
}

function readable(payload: StorageObjectPayload): Readable {
  if (payload.body instanceof Readable) return payload.body;
  if (payload.body instanceof Blob) {
    return Readable.fromWeb(payload.body.stream() as ReadableStream<Uint8Array>);
  }
  return Readable.fromWeb(payload.body as ReadableStream<Uint8Array>);
}

class AzureSdkBlobDataPlane implements AzureBlobDataPlane {
  private readonly service: BlobServiceClient;

  constructor(account: string, key: string, private readonly container: string) {
    const credential = new StorageSharedKeyCredential(account, key);
    this.service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
  }

  async list(): Promise<StorageObjectRecord[]> {
    const output: StorageObjectRecord[] = [];
    for await (const blob of this.containerClient().listBlobsFlat()) {
      output.push({ key: blob.name, size: blob.properties.contentLength ?? 0 });
    }
    return output;
  }

  async get(key: string): Promise<StorageObjectPayload> {
    const response = await this.containerClient().getBlobClient(key).download();
    if (!response.readableStreamBody) throw new Error(`Azure Blob object ${key} returned no body.`);
    return {
      body: response.readableStreamBody as Readable,
      size: response.contentLength ?? 0,
      contentType: response.contentType,
      contentEncoding: response.contentEncoding,
      cacheControl: response.cacheControl,
      contentDisposition: response.contentDisposition,
      metadata: response.metadata,
    };
  }

  async put(key: string, payload: StorageObjectPayload): Promise<void> {
    await this.containerClient().getBlockBlobClient(key).uploadStream(
      readable(payload),
      undefined,
      undefined,
      {
        blobHTTPHeaders: {
          blobContentType: payload.contentType,
          blobContentEncoding: payload.contentEncoding,
          blobCacheControl: payload.cacheControl,
          blobContentDisposition: payload.contentDisposition,
        },
        metadata: payload.metadata,
      }
    );
  }

  async deleteAll(): Promise<void> {
    for await (const blob of this.containerClient().listBlobsFlat()) {
      await this.containerClient().deleteBlob(blob.name, { deleteSnapshots: 'include' });
    }
  }

  destroy(): void {}

  private containerClient() {
    return this.service.getContainerClient(this.container);
  }
}

function accountName(context: StorageContext, environment: Environment, name: string): string {
  const prefix = `hv${String(context.projectName ?? environment.projectId)}${environment.name}${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12);
  const suffix = createHash('sha256')
    .update(`${context.subscriptionId}\0${context.resourceGroup}\0${environment.id}\0${name}`)
    .digest('hex')
    .slice(0, 10);
  return `${prefix}${suffix}`.slice(0, 24).padEnd(3, '0');
}

function deterministicResourceGroup(projectName: string, environment: Environment): string {
  const prefix = `hv-${projectName}-${environment.name}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54) || 'hypervibe';
  const suffix = createHash('sha256')
    .update(`${environment.projectId}:${environment.name}`)
    .digest('hex')
    .slice(0, 8);
  return `${prefix}-${suffix}`;
}

function containerName(name: string): string {
  const normalized = name.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 63).padEnd(3, '0');
}

function parseExternalId(externalId: string, context: StorageContext): { account: string; container: string } {
  const identity = parseStorageResourceIdentity(externalId);
  if (
    identity.subscriptionId.toLowerCase() !== context.subscriptionId?.toLowerCase()
    || identity.resourceGroup.toLowerCase() !== context.resourceGroup?.toLowerCase()
  ) {
    throw new Error('Azure Blob container is outside the configured subscription/resource group.');
  }
  return { account: identity.account, container: identity.container };
}

function parseStorageResourceIdentity(externalId: string): {
  subscriptionId: string;
  resourceGroup: string;
  account: string;
  container: string;
} {
  const segments = externalId.split('/').filter(Boolean).map(decodeURIComponent);
  if (
    segments.length !== 12
    || segments[0]?.toLowerCase() !== 'subscriptions'
    || segments[2]?.toLowerCase() !== 'resourcegroups'
    || segments[4]?.toLowerCase() !== 'providers'
    || segments[5]?.toLowerCase() !== 'microsoft.storage'
    || segments[6]?.toLowerCase() !== 'storageaccounts'
    || segments[8]?.toLowerCase() !== 'blobservices'
    || segments[9]?.toLowerCase() !== 'default'
    || segments[10]?.toLowerCase() !== 'containers'
  ) {
    throw new Error('Invalid Azure Blob container ARM resource ID.');
  }
  return {
    subscriptionId: segments[1]!,
    resourceGroup: segments[3]!,
    account: segments[7]!,
    container: segments[11]!,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AzureBlobStorageAdapter implements IStorageAdapter {
  readonly name = 'azureblob';
  readonly capabilities = {
    kind: 'object' as const,
    regions: [],
    privateOnly: true,
    supportsUsageObservation: true,
    supportsObjectTransfer: true,
  };

  private credentials: AzureBlobStorageCredentials | null = null;
  private resolvedCredentials: ConnectedAzureBlobStorageCredentials | null = null;
  private control: AzureStorageControlPlane | null = null;
  private readonly controlPlaneFactory: (credentials: ConnectedAzureBlobStorageCredentials, resourceGroup?: string) => AzureStorageControlPlane;
  private readonly dataPlaneFactory: (account: string, key: string, container: string) => AzureBlobDataPlane;
  private readonly defaultCredentialProvider: (preferredSubscriptionId?: string) => Promise<{ authMode: 'default'; subscriptionId: string }>;

  constructor(options: AzureBlobStorageAdapterOptions = {}) {
    this.controlPlaneFactory = options.controlPlaneFactory ?? ((credentials, resourceGroup) => new ArmStorageControlPlane(credentials, resourceGroup));
    this.dataPlaneFactory = options.dataPlaneFactory ?? ((account, key, container) => new AzureSdkBlobDataPlane(account, key, container));
    this.defaultCredentialProvider = options.defaultCredentialProvider ?? resolveAzureDefaultSubscription;
  }

  runtimeEnvKeys(_name: string): string[] {
    return [
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'AZURE_STORAGE_ACCOUNT_NAME',
      'AZURE_STORAGE_CONTAINER_NAME', 'AZURE_STORAGE_CONNECTION_STRING',
    ];
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzureBlobStorageCredentialsSchema.parse(credentials);
    this.resolvedCredentials = null;
    this.control = null;
  }

  async disconnect(): Promise<void> {
    this.control = null;
    this.credentials = null;
    this.resolvedCredentials = null;
  }

  async verify(): Promise<VerifyResult> {
    try {
      await this.controlPlaneFactory(await this.connectedCredentials()).verifySubscription();
      return { success: true };
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
    return this.resolveAzureContext(projectName, environment, context, desiredRegion);
  }

  async resolveObservationContext(
    projectName: string,
    environment: Environment,
    desiredRegion: string
  ): Promise<StorageEnsureResult> {
    return this.resolveAzureContext(projectName, environment, {}, desiredRegion);
  }

  private async resolveAzureContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext>,
    desiredRegion?: string
  ): Promise<StorageEnsureResult> {
    try {
      const credentials = await this.connectedCredentials();
      if (context.subscriptionId && context.subscriptionId.toLowerCase() !== credentials.subscriptionId.toLowerCase()) {
        throw new Error(`Bound Azure subscription ${context.subscriptionId} does not match the connected subscription.`);
      }
      const resourceGroup = context.resourceGroup ?? deterministicResourceGroup(projectName, environment);
      const location = context.location ?? desiredRegion;
      if (!location) throw new Error('A desired Azure location is required in the storage spec.');
      this.control = this.controlPlaneFactory(credentials, resourceGroup);
      await this.controlPlane().verifySubscription();
      return {
        receipt: { success: true, message: `Azure Blob Storage context is ready in ${credentials.subscriptionId}/${resourceGroup}` },
        context: {
          subscriptionId: credentials.subscriptionId,
          resourceGroup,
          location,
          projectName,
          environmentName: environment.name,
          environmentId: environment.id,
        },
      };
    } catch (error) {
      return { receipt: { success: false, message: 'Failed to resolve Azure Blob Storage context', error: errorMessage(error) } };
    }
  }

  async observe(environment: Environment, context: StorageContext): Promise<ObservedStorage[]> {
    await this.assertContext(context);
    const observed: ObservedStorage[] = [];
    for (const account of await this.controlPlane().listAccounts()) {
      if (account.tags?.[ENVIRONMENT_TAG] !== environment.id) continue;
      const name = account.tags[STORAGE_NAME_TAG];
      if (!name) continue;
      const container = await this.controlPlane().getContainer(account, containerName(name));
      if (!container) continue;
      const key = await this.controlPlane().listKeys(account);
      const plane = this.dataPlaneFactory(account.name, key, container.name);
      try {
        const objects = await plane.list();
        observed.push({
          provider: this.name,
          kind: 'object',
          externalId: container.id,
          instanceScope: { ...context },
          name,
          region: account.location,
          status: 'ready',
          objectCount: objects.length,
          sizeBytes: objects.reduce((total, object) => total + object.size, 0),
        });
      } finally {
        plane.destroy();
      }
    }
    return observed.sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectStorageResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const credentials = await this.connectedCredentials();
    this.control = this.controlPlaneFactory(credentials);
    const resources: Array<{
      account: AzureStorageAccount;
      container: AzureBlobContainer;
    }> = [];
    for (const account of await this.control.listAccounts()) {
      for (const container of await this.control.listContainers(account)) {
        if (request.id && container.id.toLowerCase() !== request.id.toLowerCase()) continue;
        if (request.name && container.name.toLowerCase() !== request.name.toLowerCase()) continue;
        resources.push({ account, container });
      }
    }
    const ambiguous = Boolean(request.name && resources.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : resources.length > 0 ? 'present' : 'absent',
      resource: 'storage',
      storage: resources.slice(0, request.limit).map(({ account, container }) => {
        const identity = parseStorageResourceIdentity(container.id);
        return {
          id: container.id,
          name: container.name,
          kind: 'object',
          status: 'ready',
          account: { id: account.id, name: account.name },
          region: account.location,
          ...(account.tags?.[STORAGE_NAME_TAG]
            ? { logicalName: account.tags[STORAGE_NAME_TAG] }
            : {}),
          providerScope: {
            subscriptionId: identity.subscriptionId,
            resourceGroup: identity.resourceGroup,
          },
        };
      }),
      ...(resources.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: resources.length > request.limit,
      partial: false,
    };
  }

  async ensureBucket(
    environment: Environment,
    context: StorageContext,
    name: string,
    region: string
  ): Promise<StorageEnsureResult> {
    let createdAccount: AzureStorageAccount | null = null;
    try {
      await this.assertContext(context);
      const scope = await this.controlPlane().ensureScope(context.location ?? region, {
        'managed-by': 'hypervibe',
        [ENVIRONMENT_TAG]: environment.id,
        [PROJECT_TAG]: context.projectName ?? environment.projectId,
      });
      const desiredAccountName = accountName(context, environment, name);
      let account = await this.controlPlane().getAccount(desiredAccountName);
      if (account) {
        if (account.tags?.[ENVIRONMENT_TAG] !== environment.id || account.tags?.[STORAGE_NAME_TAG] !== name) {
          throw new Error(`Azure Storage account ${desiredAccountName} exists but is not owned by this Hypervibe storage binding.`);
        }
        if (account.location.toLowerCase() !== region.toLowerCase()) {
          throw new Error(`Azure Storage account ${desiredAccountName} exists in immutable location ${account.location}, not ${region}.`);
        }
      } else {
        account = await this.controlPlane().createAccount(desiredAccountName, region, {
          [ENVIRONMENT_TAG]: environment.id,
          [STORAGE_NAME_TAG]: name,
          [PROJECT_TAG]: context.projectName ?? environment.projectId,
        });
        createdAccount = account;
      }
      const desiredContainer = containerName(name);
      const existing = await this.controlPlane().getContainer(account, desiredContainer);
      const container = existing ?? await this.controlPlane().createContainer(account, desiredContainer);
      return {
        receipt: {
          success: true,
          message: `${createdAccount ? 'Created' : 'Using'} private Azure Blob container "${container.name}" in account "${account.name}"`,
          data: {
            created: Boolean(createdAccount),
            resourceGroupCreated: scope.created,
            accountCreated: Boolean(createdAccount),
            containerCreated: !existing,
          },
        },
        externalId: container.id,
        context,
      };
    } catch (error) {
      if (createdAccount) {
        try {
          await this.controlPlane().deleteAccount(createdAccount);
        } catch {
          // The deterministic tagged account remains visible for operator cleanup.
        }
      }
      return { receipt: { success: false, message: `Failed to ensure Azure Blob storage "${name}"`, error: errorMessage(error) } };
    }
  }

  async getRuntimeEnv(
    _environment: Environment,
    context: StorageContext,
    externalId: string,
    _name: string
  ): Promise<Record<string, string>> {
    await this.assertContext(context);
    const identity = parseExternalId(externalId, context);
    const account = await this.requiredAccount(identity.account);
    const key = await this.controlPlane().listKeys(account);
    return {
      OBJECT_STORAGE_PROVIDER: 'azureblob',
      OBJECT_STORAGE_BUCKET: identity.container,
      AZURE_STORAGE_ACCOUNT_NAME: account.name,
      AZURE_STORAGE_CONTAINER_NAME: identity.container,
      AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=${account.name};AccountKey=${key};EndpointSuffix=core.windows.net`,
    };
  }

  async openObjectTransfer(
    _environment: Environment,
    context: StorageContext,
    externalId: string
  ): Promise<StorageObjectClient> {
    await this.assertContext(context);
    const identity = parseExternalId(externalId, context);
    const account = await this.requiredAccount(identity.account);
    return this.dataPlaneFactory(account.name, await this.controlPlane().listKeys(account), identity.container);
  }

  async destroyBucket(environment: Environment, context: StorageContext, externalId: string): Promise<Receipt> {
    try {
      await this.assertContext(context);
      const identity = parseExternalId(externalId, context);
      const account = await this.controlPlane().getAccount(identity.account);
      if (!account) return { success: true, message: `Azure Blob storage account "${identity.account}" is already absent` };
      if (account.tags?.[ENVIRONMENT_TAG] !== environment.id) {
        throw new Error(`Azure Storage account ${account.name} is not owned by this Hypervibe environment.`);
      }
      const key = await this.controlPlane().listKeys(account);
      const plane = this.dataPlaneFactory(account.name, key, identity.container);
      try {
        await plane.deleteAll();
      } finally {
        plane.destroy();
      }
      await this.controlPlane().deleteAccount(account);
      await this.waitForAccountAbsence(identity.account);
      return { success: true, message: `Deleted Azure Blob storage account "${account.name}" and all objects` };
    } catch (error) {
      return { success: false, message: `Failed to delete Azure Blob storage "${externalId}"`, error: errorMessage(error) };
    }
  }

  private async connectedCredentials(): Promise<ConnectedAzureBlobStorageCredentials> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (this.resolvedCredentials) return this.resolvedCredentials;
    if (this.credentials.authMode === 'default') {
      this.resolvedCredentials = await this.defaultCredentialProvider(this.credentials.subscriptionId);
      return this.resolvedCredentials;
    }
    this.resolvedCredentials = {
      authMode: 'servicePrincipal',
      tenantId: this.credentials.tenantId!,
      subscriptionId: this.credentials.subscriptionId!,
      clientId: this.credentials.clientId!,
      clientSecret: this.credentials.clientSecret!,
    };
    return this.resolvedCredentials;
  }

  private controlPlane(): AzureStorageControlPlane {
    if (!this.control) throw new Error('Not connected. Call connect() first.');
    return this.control;
  }

  private async assertContext(context: StorageContext): Promise<void> {
    const credentials = await this.connectedCredentials();
    if (!context.subscriptionId || !context.resourceGroup) throw new Error('Azure subscription/resource-group context is missing.');
    if (context.subscriptionId.toLowerCase() !== credentials.subscriptionId.toLowerCase()) {
      throw new Error('Azure Blob Storage context does not match the connected subscription.');
    }
    this.control = this.controlPlaneFactory(credentials, context.resourceGroup);
  }

  private async requiredAccount(name: string): Promise<AzureStorageAccount> {
    const account = await this.controlPlane().getAccount(name);
    if (!account) throw new Error(`Azure Storage account ${name} was not found.`);
    return account;
  }

  private async waitForAccountAbsence(name: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_BLOB_DELETE_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_BLOB_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!(await this.controlPlane().getAccount(name))) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Storage account ${name} remained observable after ${attempts} deletion checks.`
    );
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}

providerRegistry.register({
  metadata: {
    name: 'azureblob',
    displayName: 'Azure Blob Storage',
    category: 'storage',
    credentialsSchema: AzureBlobStorageCredentialsSchema,
    setupHelpUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    credentials: {
      supportsNativeCliAuth: true,
      environmentVariableAliases: [
        ['AZURE_TENANT_ID', 'HYPERVIBE_AZURE_TENANT_ID'],
        ['AZURE_SUBSCRIPTION_ID', 'HYPERVIBE_AZURE_SUBSCRIPTION_ID'],
        ['AZURE_CLIENT_ID', 'HYPERVIBE_AZURE_CLIENT_ID'],
        ['AZURE_CLIENT_SECRET', 'HYPERVIBE_AZURE_CLIENT_SECRET'],
      ],
    },
    connectionAliases: ['azure-container-apps'],
    maturity: {
      lifecycle: {
        storage: { status: 'ready-for-live' },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new AzureBlobStorageAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['storage'],
    defaultResource: 'storage',
    selectors: {
      storage: { mode: 'provider-resource', optional: ['id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['subscriptionId', 'resourceGroup'] },
    },
    inspect: (adapter, request) => (
      adapter as AzureBlobStorageAdapter
    ).inspectStorageResources(request),
  },
});
