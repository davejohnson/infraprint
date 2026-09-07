import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { GcsStorageAdapter } from '../gcs.adapter.js';

const serviceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'cloud-project',
  client_email: 'hypervibe@cloud-project.iam.gserviceaccount.com',
  private_key: 'private-key',
});

function environment(): Environment {
  return {
    id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {},
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GcsStorageAdapter', () => {
  it('inventories bounded buckets with durable project scope', async () => {
    const request = vi.fn(async () => json({ items: [
      { name: 'customer-documents', location: 'US-CENTRAL1' },
      { name: 'archive', location: 'US' },
    ] }));
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });

    await expect(adapter.inspectStorageResources({ resource: 'storage', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'storage',
        storage: [{
          id: 'customer-documents',
          name: 'customer-documents',
          providerScope: { projectId: 'cloud-project' },
        }],
        truncated: true,
        partial: false,
      });
  });

  it('uses Google Application Default Credentials and the configured gcloud project', async () => {
    const tokenProvider = vi.fn(async () => ({ token: 'token', email: 'gcloud-user' }));
    const adapter = new GcsStorageAdapter({
      fetch: vi.fn() as typeof fetch,
      tokenProvider,
      defaultProjectProvider: async () => 'gcloud-project',
    });
    await adapter.connect({ authMode: 'default' });

    await expect(adapter.resolveObservationContext(
      'friend-app', environment(), 'us-central1'
    )).resolves.toMatchObject({
      receipt: { success: true },
      context: { projectId: 'gcloud-project' },
    });
    expect(tokenProvider).toHaveBeenCalledWith(
      { authMode: 'default' },
      null
    );

    await expect(adapter.getRuntimeEnv(
      environment(),
      { projectId: 'gcloud-project' },
      'managed-bucket',
      'documents'
    )).rejects.toThrow(/will not copy a local gcloud user session/);
  });

  it('accepts a service-account key file directly and derives its project', async () => {
    const adapter = new GcsStorageAdapter({
      fetch: vi.fn() as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect(JSON.parse(serviceAccount));

    await expect(adapter.resolveObservationContext(
      'friend-app', environment(), 'us-central1'
    )).resolves.toMatchObject({
      receipt: { success: true },
      context: { projectId: 'cloud-project' },
    });
  });

  it('creates a private labeled bucket and returns composite project scope', async () => {
    let createdName: string | undefined;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/storage/v1/b/') && (!init?.method || init.method === 'GET')) {
        return createdName
          ? json({
              name: createdName,
              location: 'us-central1',
              labels: {
                hypervibe_environment_id: 'environment-1',
                hypervibe_storage_name: 'documents',
              },
            })
          : json({ error: { message: 'missing' } }, 404);
      }
      if (url.includes('/storage/v1/b?') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        createdName = body.name;
        expect(body).toMatchObject({
          location: 'us-central1',
          labels: {
            hypervibe_environment_id: 'environment-1',
            hypervibe_storage_name: 'documents',
          },
          iamConfiguration: {
            publicAccessPrevention: 'enforced',
            uniformBucketLevelAccess: { enabled: true },
          },
        });
        return json({ name: body.name });
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'hypervibe@cloud-project.iam.gserviceaccount.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });

    const contextResult = await adapter.ensureContext('friend-app', environment());
    const result = await adapter.ensureBucket(environment(), contextResult.context!, 'documents', 'us-central1');

    expect(contextResult.context).toMatchObject({ projectId: 'cloud-project' });
    expect(result.receipt.success).toBe(true);
    expect(result.externalId).toMatch(/^hv-friend-app-production-documents-[0-9a-f]{10}$/);
  });

  it('observes only buckets labeled for the selected environment with usage', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/storage/v1/b?')) return json({ items: [
        { name: 'managed', location: 'US-CENTRAL1', labels: { hypervibe_environment_id: 'environment-1', hypervibe_storage_name: 'documents' } },
        { name: 'unmanaged', labels: { owner: 'someone-else' } },
      ] });
      if (url.includes('/storage/v1/b/managed/o?')) return json({ items: [{ name: 'a.pdf', size: '42' }] });
      throw new Error(`unexpected request ${url}`);
    });
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });
    const context = (await adapter.ensureContext('friend-app', environment())).context!;

    await expect(adapter.observe(environment(), context)).resolves.toEqual([expect.objectContaining({
      provider: 'gcs', externalId: 'managed', name: 'documents', region: 'us-central1',
      instanceScope: expect.objectContaining({ projectId: 'cloud-project' }),
      objectCount: 1, sizeBytes: 42,
    })]);
  });

  it('turns inventory permission failures into explicit staged prepare guidance', async () => {
    const adapter = new GcsStorageAdapter({
      fetch: vi.fn(async () => json({ error: { message: 'storage.buckets.list denied' } }, 403)) as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });

    await expect(adapter.inspectStorageResources({
      resource: 'storage',
      limit: 25,
    })).rejects.toThrow('adminAuth="default"');
  });

  it('refuses to adopt an existing deterministic bucket without ownership labels', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);
      return json({ name, labels: {} });
    });
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });
    const context = (await adapter.ensureContext('friend-app', environment())).context!;

    const result = await adapter.ensureBucket(environment(), context, 'documents', 'us-central1');

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('not owned');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not report creation success until the exact bucket is observable', async () => {
    let reads = 0;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/storage/v1/b/') && (!init?.method || init.method === 'GET')) {
        reads += 1;
        return json({ error: { message: 'missing' } }, 404);
      }
      if (url.includes('/storage/v1/b?') && init?.method === 'POST') {
        return json({});
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });
    const context = (await adapter.ensureContext('friend-app', environment())).context!;

    const result = await adapter.ensureBucket(environment(), context, 'documents', 'us-central1');

    expect(result.receipt).toMatchObject({ success: false });
    expect(result.receipt.error).toContain('did not become observable after creation');
    expect(reads).toBe(2);
  });

  it('does not treat a malformed successful exact lookup as absence or delete the bucket', async () => {
    const request = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => json({}));
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });

    const result = await adapter.destroyBucket(
      environment(),
      { projectId: 'cloud-project', environmentId: 'environment-1' },
      'managed'
    );

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('absence was not confirmed');
    expect(request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('provides GCS-native runtime and object transfer contracts', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/o?') && !init?.method) return json({ items: [{ name: 'folder/a.pdf', size: '3' }] });
      if (url.includes('alt=media')) return new Response('pdf', { headers: { 'content-type': 'application/pdf', 'content-length': '3' } });
      if (url.includes('/upload/storage/v1/') && init?.method === 'POST') return json({ name: 'folder/a.pdf' });
      if (url.includes('/storage/v1/') && init?.method === 'PATCH') return json({ name: 'folder/a.pdf' });
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });
    const context = { projectId: 'cloud-project', environmentId: 'environment-1' };

    expect(adapter.runtimeEnvKeys('documents')).toEqual([
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_STORAGE_BUCKET', 'GOOGLE_CLOUD_CREDENTIALS_JSON',
    ]);
    await expect(adapter.getRuntimeEnv(environment(), context, 'managed', 'documents')).resolves.toMatchObject({
      OBJECT_STORAGE_PROVIDER: 'gcs', GOOGLE_CLOUD_STORAGE_BUCKET: 'managed', GOOGLE_CLOUD_PROJECT: 'cloud-project',
    });
    const transfer = await adapter.openObjectTransfer(environment(), context, 'managed');
    await expect(transfer.list()).resolves.toEqual([{ key: 'folder/a.pdf', size: 3 }]);
    await expect(transfer.get('folder/a.pdf')).resolves.toMatchObject({ size: 3, contentType: 'application/pdf' });
    await transfer.put('folder/a.pdf', {
      body: new Blob(['pdf']), size: 3, contentType: 'application/pdf', metadata: { source: 'migration' },
    });
    expect(request.mock.calls.some(([, init]) => init?.method === 'PATCH'
      && String(init.body).includes('"metadata":{"source":"migration"}'))).toBe(true);
  });

  it('empties an owned bucket before confirmed deletion', async () => {
    let bucketReads = 0;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/storage/v1/b/managed') && !init?.method) {
        bucketReads += 1;
        return bucketReads === 1
          ? json({ name: 'managed', labels: { hypervibe_environment_id: 'environment-1' } })
          : json({ error: { message: 'missing' } }, 404);
      }
      if (url.includes('/storage/v1/b/managed/o?') && !init?.method) {
        return json({ items: [{ name: 'a.pdf', size: '3' }] });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    const adapter = new GcsStorageAdapter({
      fetch: request as typeof fetch,
      tokenProvider: async () => ({ token: 'token', email: 'service@example.com' }),
    });
    await adapter.connect({ projectId: 'cloud-project', credentials: serviceAccount });

    await expect(adapter.destroyBucket(
      environment(), { projectId: 'cloud-project', environmentId: 'environment-1' }, 'managed'
    )).resolves.toMatchObject({ success: true });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
  });
});
