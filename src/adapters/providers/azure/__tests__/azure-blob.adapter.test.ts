import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type {
  AzureBlobDataPlane,
  AzureStorageAccount,
  AzureStorageControlPlane,
} from '../azure-blob.adapter.js';
import { AzureBlobStorageAdapter } from '../azure-blob.adapter.js';

const credentials = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: 'secret-value',
};

function environment(): Environment {
  return {
    id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {},
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function account(overrides: Partial<AzureStorageAccount> = {}): AzureStorageAccount {
  return {
    id: `/subscriptions/${credentials.subscriptionId}/resourceGroups/friend-app-production/providers/Microsoft.Storage/storageAccounts/hvfriendapp1234567890`,
    name: 'hvfriendapp1234567890',
    location: 'westus2',
    tags: { 'hypervibe-environment-id': 'environment-1', 'hypervibe-storage-name': 'documents' },
    ...overrides,
  };
}

function controlPlane(overrides: Partial<AzureStorageControlPlane> = {}): AzureStorageControlPlane {
  return {
    verifySubscription: vi.fn(async () => {}),
    ensureScope: vi.fn(async () => ({ created: false })),
    listAccounts: vi.fn(async () => []),
    listContainers: vi.fn(async () => []),
    getAccount: vi.fn(async () => null),
    createAccount: vi.fn(async (_name, _location, tags) => account({ tags })),
    getContainer: vi.fn(async () => null),
    createContainer: vi.fn(async (storageAccount, container) => ({
      id: `${storageAccount.id}/blobServices/default/containers/${container}`,
      name: container,
    })),
    listKeys: vi.fn(async () => 'account-key'),
    deleteAccount: vi.fn(async () => true),
    ...overrides,
  };
}

function dataPlane(overrides: Partial<AzureBlobDataPlane> = {}): AzureBlobDataPlane {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ body: Readable.from(['pdf']), size: 3, contentType: 'application/pdf' })),
    put: vi.fn(async () => {}),
    deleteAll: vi.fn(async () => {}),
    destroy: vi.fn(),
    ...overrides,
  };
}

describe('AzureBlobStorageAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('inventories containers across the subscription with durable Azure scope', async () => {
    const storageAccount = account();
    const container = {
      id: `${storageAccount.id}/blobServices/default/containers/customer-documents`,
      name: 'customer-documents',
    };
    const control = controlPlane({
      listAccounts: vi.fn(async () => [storageAccount]),
      listContainers: vi.fn(async () => [container]),
    });
    const adapter = new AzureBlobStorageAdapter({
      controlPlaneFactory: () => control,
      dataPlaneFactory: () => dataPlane(),
    });
    await adapter.connect(credentials);

    await expect(adapter.inspectStorageResources({ resource: 'storage', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'storage',
        storage: [{
          id: container.id,
          name: 'customer-documents',
          providerScope: {
            subscriptionId: credentials.subscriptionId,
            resourceGroup: 'friend-app-production',
          },
        }],
        partial: false,
      });
  });

  it('uses the Azure default credential chain without requiring a service-principal key', async () => {
    const control = controlPlane();
    const defaultCredentialProvider = vi.fn(async () => ({
      authMode: 'default' as const,
      subscriptionId: credentials.subscriptionId,
    }));
    const controlPlaneFactory = vi.fn(() => control);
    const adapter = new AzureBlobStorageAdapter({
      defaultCredentialProvider,
      controlPlaneFactory,
      dataPlaneFactory: () => dataPlane(),
    });
    await adapter.connect({ authMode: 'default' });

    await expect(adapter.resolveObservationContext(
      'friend-app', environment(), 'westus2'
    )).resolves.toMatchObject({
      receipt: { success: true },
      context: { subscriptionId: credentials.subscriptionId },
    });
    expect(defaultCredentialProvider).toHaveBeenCalledOnce();
    expect(controlPlaneFactory).toHaveBeenCalledWith(
      { authMode: 'default', subscriptionId: credentials.subscriptionId },
      expect.stringMatching(/^hv-friend-app-production-/)
    );
  });

  it('resolves first-use observation scope without creating provider resources', async () => {
    const control = controlPlane();
    const adapter = new AzureBlobStorageAdapter({
      controlPlaneFactory: () => control,
      dataPlaneFactory: () => dataPlane(),
    });
    await adapter.connect(credentials);

    await expect(adapter.resolveObservationContext(
      'friend-app', environment(), 'westus2'
    )).resolves.toMatchObject({
      receipt: { success: true },
      context: { subscriptionId: credentials.subscriptionId, location: 'westus2' },
    });
    expect(control.verifySubscription).toHaveBeenCalledOnce();
    expect(control.ensureScope).not.toHaveBeenCalled();
    expect(control.createAccount).not.toHaveBeenCalled();
  });

  it('creates a private account and container and returns composite Azure scope', async () => {
    const control = controlPlane();
    const adapter = new AzureBlobStorageAdapter({
      controlPlaneFactory: () => control,
      dataPlaneFactory: () => dataPlane(),
    });
    await adapter.connect(credentials);

    const contextResult = await adapter.ensureContext('friend-app', environment(), {}, 'westus2');
    const result = await adapter.ensureBucket(environment(), contextResult.context!, 'documents', 'westus2');

    expect(contextResult.context).toMatchObject({
      subscriptionId: credentials.subscriptionId,
      resourceGroup: expect.stringMatching(/^hv-friend-app-production-[0-9a-f]{8}$/),
      location: 'westus2',
    });
    expect(result.receipt.success).toBe(true);
    expect(result.externalId).toMatch(/\/blobServices\/default\/containers\/documents$/);
    expect(control.createAccount).toHaveBeenCalledWith(expect.stringMatching(/^hv[a-z0-9]{10,22}$/), 'westus2', expect.objectContaining({
      'hypervibe-environment-id': 'environment-1',
      'hypervibe-storage-name': 'documents',
    }));
    expect(control.createContainer).toHaveBeenCalledWith(expect.anything(), 'documents');
  });

  it('observes only tagged environment accounts and includes usage', async () => {
    const managed = account();
    const control = controlPlane({
      listAccounts: vi.fn(async () => [managed, account({ name: 'unmanaged', tags: {} })]),
      getContainer: vi.fn(async (storageAccount, container) => storageAccount.name === managed.name
        ? { id: `${storageAccount.id}/blobServices/default/containers/${container}`, name: container }
        : null),
    });
    const plane = dataPlane({ list: vi.fn(async () => [{ key: 'a.pdf', size: 42 }]) });
    const adapter = new AzureBlobStorageAdapter({ controlPlaneFactory: () => control, dataPlaneFactory: () => plane });
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext(
      'friend-app', environment(), { resourceGroup: 'friend-app-production' }, 'westus2'
    )).context!;

    await expect(adapter.observe(environment(), context)).resolves.toEqual([expect.objectContaining({
      provider: 'azureblob', name: 'documents', region: 'westus2', objectCount: 1, sizeBytes: 42,
      instanceScope: expect.objectContaining({ subscriptionId: credentials.subscriptionId, resourceGroup: 'friend-app-production' }),
    })]);
  });

  it('refuses to adopt an existing deterministic account without ownership tags', async () => {
    const control = controlPlane({ getAccount: vi.fn(async () => account({ tags: {} })) });
    const adapter = new AzureBlobStorageAdapter({ controlPlaneFactory: () => control, dataPlaneFactory: () => dataPlane() });
    await adapter.connect(credentials);
    const context = (await adapter.ensureContext(
      'friend-app', environment(), { resourceGroup: 'friend-app-production' }, 'westus2'
    )).context!;

    const result = await adapter.ensureBucket(environment(), context, 'documents', 'westus2');

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('not owned');
    expect(control.createAccount).not.toHaveBeenCalled();
  });

  it('provides Azure-native runtime and object transfer contracts', async () => {
    const control = controlPlane({ getAccount: vi.fn(async () => account()) });
    const plane = dataPlane({ list: vi.fn(async () => [{ key: 'a.pdf', size: 3 }]) });
    const adapter = new AzureBlobStorageAdapter({ controlPlaneFactory: () => control, dataPlaneFactory: () => plane });
    await adapter.connect(credentials);
    const context = { subscriptionId: credentials.subscriptionId, resourceGroup: 'friend-app-production' };
    const externalId = `${account().id}/blobServices/default/containers/documents`;

    expect(adapter.runtimeEnvKeys('documents')).toEqual([
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'AZURE_STORAGE_ACCOUNT_NAME',
      'AZURE_STORAGE_CONTAINER_NAME', 'AZURE_STORAGE_CONNECTION_STRING',
    ]);
    await expect(adapter.getRuntimeEnv(environment(), context, externalId, 'documents')).resolves.toMatchObject({
      OBJECT_STORAGE_PROVIDER: 'azureblob', AZURE_STORAGE_CONTAINER_NAME: 'documents',
      AZURE_STORAGE_ACCOUNT_NAME: account().name,
    });
    const transfer = await adapter.openObjectTransfer(environment(), context, externalId);
    await expect(transfer.list()).resolves.toEqual([{ key: 'a.pdf', size: 3 }]);
  });

  it('empties the owned container before deleting its dedicated account', async () => {
    vi.stubEnv('HYPERVIBE_AZURE_BLOB_DELETE_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_AZURE_BLOB_POLL_INTERVAL_MS', '0');
    const managed = account();
    const control = controlPlane({
      getAccount: vi.fn()
        .mockResolvedValueOnce(managed)
        .mockResolvedValueOnce(managed)
        .mockResolvedValueOnce(null),
    });
    const plane = dataPlane();
    const adapter = new AzureBlobStorageAdapter({ controlPlaneFactory: () => control, dataPlaneFactory: () => plane });
    await adapter.connect(credentials);
    const context = { subscriptionId: credentials.subscriptionId, resourceGroup: 'friend-app-production' };

    await expect(adapter.destroyBucket(
      environment(), context, `${managed.id}/blobServices/default/containers/documents`
    )).resolves.toMatchObject({ success: true });
    expect(plane.deleteAll).toHaveBeenCalledOnce();
    expect(control.deleteAccount).toHaveBeenCalledWith(managed);
    expect(control.getAccount).toHaveBeenCalledTimes(3);
  });

  it('does not report deletion success while the storage account remains observable', async () => {
    vi.stubEnv('HYPERVIBE_AZURE_BLOB_DELETE_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_AZURE_BLOB_POLL_INTERVAL_MS', '0');
    const managed = account();
    const control = controlPlane({ getAccount: vi.fn(async () => managed) });
    const plane = dataPlane();
    const adapter = new AzureBlobStorageAdapter({
      controlPlaneFactory: () => control,
      dataPlaneFactory: () => plane,
    });
    await adapter.connect(credentials);
    const context = {
      subscriptionId: credentials.subscriptionId,
      resourceGroup: 'friend-app-production',
    };

    const result = await adapter.destroyBucket(
      environment(),
      context,
      `${managed.id}/blobServices/default/containers/documents`
    );

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('remained observable after 2 deletion checks');
    expect(control.deleteAccount).toHaveBeenCalledWith(managed);
    expect(control.getAccount).toHaveBeenCalledTimes(3);
  });
});
