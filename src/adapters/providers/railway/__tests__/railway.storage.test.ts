import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RailwayAdapter } from '../railway.adapter.js';
import { createRailwayStorageAdapter } from '../railway-storage.factory.js';

function environment(): Environment {
  return { id: 'local', projectId: 'project', name: 'staging', platformBindings: { projectId: 'rp', environmentId: 're' }, createdAt: new Date(), updatedAt: new Date() };
}

function bucketState(options: {
  buckets?: Array<{ id: string; name: string }>;
  config?: Record<string, { region?: string; isCreated?: boolean; isDeleted?: boolean }>;
  unmergedChangesCount?: number;
  projectId?: string;
  environmentId?: string;
} = {}) {
  const projectId = options.projectId ?? 'rp';
  const environmentId = options.environmentId ?? 're';
  return {
    project: {
      id: projectId,
      buckets: { edges: (options.buckets ?? []).map((node) => ({ node })) },
      environments: {
        edges: [{ node: { id: environmentId, unmergedChangesCount: options.unmergedChangesCount ?? 0 } }],
      },
    },
    environment: { id: environmentId, config: { buckets: options.config ?? {} } },
  };
}

describe('Railway storage buckets', () => {
  beforeEach(() => {
    vi.stubEnv('HYPERVIBE_RAILWAY_STORAGE_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RAILWAY_STORAGE_VERIFY_DELAY_MS', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to create provider scaffolding from a storage action', async () => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const withoutEnvironment = {
      ...environment(),
      platformBindings: { projectId: 'rp' },
    };

    const receipt = await adapter.ensureStorageContext('app', withoutEnvironment);

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Apply project/environment scaffolding first');
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks standalone first-use observation without guessing or creating Railway scope', async () => {
    const request = vi.fn();
    const railway = new RailwayAdapter();
    (railway as unknown as { client: { request: typeof request } }).client = { request };
    const adapter = createRailwayStorageAdapter(railway);
    const standaloneEnvironment = {
      ...environment(),
      platformBindings: { provider: 'fly', appId: 'fly-app' },
    };

    const result = await adapter.resolveObservationContext!(
      'app',
      standaloneEnvironment,
      'sjc'
    );

    expect(result).toMatchObject({
      receipt: {
        success: false,
        error: expect.stringContaining('exact persisted Railway projectId/environmentId'),
      },
    });
    expect(result.receipt.error).toContain('hv_import');
    expect(result.receipt.error).toContain('hosted on fly');
    expect(request).not.toHaveBeenCalled();
  });

  it('observes only bucket instances attached to the bound environment', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: {
        id: 'rp', name: 'app',
        environments: { edges: [
          { node: { id: 're', name: 'staging', config: { buckets: { 'bucket-docs': { region: 'sjc', isCreated: true } } } } },
          { node: { id: 're-prod', name: 'production', config: { buckets: { 'bucket-docs': { region: 'iad', isCreated: true } } } } },
        ] },
        buckets: { edges: [{ node: { id: 'bucket-docs', name: 'documents' } }] },
        services: { edges: [] }, plugins: { edges: [] },
      } })
      .mockResolvedValueOnce({ bucketInstanceDetails: { objectCount: 3, sizeBytes: 42 } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const result = await adapter.observe(environment());

    expect(result.storage).toEqual([{
      provider: 'railway',
      kind: 'object',
      externalId: 'bucket-docs',
      instanceScope: { projectId: 'rp', environmentId: 're' },
      name: 'documents',
      region: 'sjc',
      status: 'ready',
      objectCount: 3,
      sizeBytes: 42,
    }]);
  });

  it('does not report storage observation complete when bucket usage cannot be read', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: {
        id: 'rp', name: 'app',
        environments: { edges: [
          { node: { id: 're', name: 'staging', config: { buckets: { 'bucket-docs': { region: 'sjc', isCreated: true } } } } },
        ] },
        buckets: { edges: [{ node: { id: 'bucket-docs', name: 'documents' } }] },
        services: { edges: [] }, plugins: { edges: [] },
      } })
      .mockRejectedValueOnce(new Error('bucket usage permission denied'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    await expect(adapter.observe(environment())).rejects.toThrow('bucket usage permission denied');
  });

  it('creates a project bucket and commits its environment instance', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-1', name: 'uploads', projectId: 'rp' } })
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-1', name: 'uploads' }] }))
      .mockResolvedValueOnce({ environmentPatchCommit: true })
      .mockResolvedValueOnce(bucketState({
        buckets: [{ id: 'bucket-1', name: 'uploads' }],
        config: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: false } },
      }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({ success: true, data: { externalId: 'bucket-1', region: 'sjc' } });
    expect(request.mock.calls[1]?.[1]).toEqual({ input: { projectId: 'rp', name: 'uploads' } });
    expect(request.mock.calls[3]?.[1]).toMatchObject({ environmentId: 're', patch: { buckets: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: false } } } });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('reports an unbound same-name bucket as an adoption candidate without attaching it', async () => {
    const request = vi.fn().mockResolvedValueOnce(bucketState({
      buckets: [{ id: 'bucket-1', name: 'documents' }],
    }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const receipt = await adapter.ensureStorage(environment(), 'documents', { region: 'sjc' });
    expect(receipt).toMatchObject({
      success: false,
      data: { adoptionCandidateExternalId: 'bucket-1' },
    });
    expect(receipt.error).toContain('hv_import');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses to mutate around unrelated staged changes', async () => {
    const request = vi.fn().mockResolvedValueOnce(bucketState({ unmergedChangesCount: 2 }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('staged');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing project', { environment: bucketState().environment }],
    ['missing environment', { project: bucketState().project }],
    ['missing bucket inventory', {
      project: { id: 'rp', environments: bucketState().project.environments },
      environment: bucketState().environment,
    }],
    ['missing exact environment identity', {
      project: { ...bucketState().project, environments: { edges: [] } },
      environment: bucketState().environment,
    }],
    ['missing environment config', {
      project: bucketState().project,
      environment: { id: 're' },
    }],
    ['missing bucket config', {
      project: bucketState().project,
      environment: { id: 're', config: {} },
    }],
    ['missing staged-change count', {
      project: {
        ...bucketState().project,
        environments: { edges: [{ node: { id: 're' } }] },
      },
      environment: bucketState().environment,
    }],
  ])('treats %s as unknown and performs no mutation', async (_label, response) => {
    const request = vi.fn().mockResolvedValueOnce(response);
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt.success).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['id', [
      { id: 'bucket-1', name: 'uploads' },
      { id: 'bucket-1', name: 'documents' },
    ]],
    ['name', [
      { id: 'bucket-1', name: 'uploads' },
      { id: 'bucket-2', name: 'UPLOADS' },
    ]],
  ])('blocks duplicate bucket %s values', async (_label, buckets) => {
    const request = vi.fn().mockResolvedValueOnce(bucketState({ buckets }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt.success).toBe(false);
    expect(receipt.error).toMatch(/duplicate|multiple/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed create acknowledgement without submitting a bucket patch', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-1', name: 'uploads' } })
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-1', name: 'uploads' }] }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: {
        externalId: 'bucket-1',
        mutationAttempted: true,
        storageCreateRecovery: {
          provider: 'railway',
          operation: 'create',
          resourceName: 'uploads',
          providerScope: { projectId: 'rp', environmentId: 're' },
          state: 'identified',
          externalId: 'bucket-1',
          returnedName: 'uploads',
        },
      },
    });
    expect(receipt.error).toContain('acknowledgement');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([query]) => String(query).includes('environmentPatchCommit'))).toBe(false);
  });

  it('retains a wrong-name create id only as mismatched recovery evidence', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-wrong', name: 'other', projectId: 'rp' } })
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-wrong', name: 'other' }] }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: {
        externalId: 'bucket-wrong',
        storageCreateRecovery: {
          state: 'mismatched',
          externalId: 'bucket-wrong',
          returnedName: 'other',
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([query]) => String(query).includes('environmentPatchCommit'))).toBe(false);
  });

  it('recovers an exact bucket after transport loss without repeating or attaching the create', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockRejectedValueOnce(new Error('socket closed after write'))
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-1', name: 'uploads' }] }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: {
        externalId: 'bucket-1',
        mutationAttempted: true,
        storageCreateRecovery: { state: 'identified', externalId: 'bucket-1' },
      },
    });
    expect(request.mock.calls.filter(([query]) => String(query).includes('bucketCreate'))).toHaveLength(1);
    expect(request.mock.calls.some(([query]) => String(query).includes('environmentPatchCommit'))).toBe(false);
  });

  it('retains unresolved scoped recovery after transport loss with no observed identity', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockRejectedValueOnce(new Error('socket closed after write'))
      .mockResolvedValueOnce(bucketState());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: {
        mutationAttempted: true,
        storageCreateRecovery: {
          provider: 'railway',
          resourceName: 'uploads',
          providerScope: { projectId: 'rp', environmentId: 're' },
          state: 'unresolved',
        },
      },
    });
    expect(receipt.data).not.toHaveProperty('externalId');
    expect(request.mock.calls.filter(([query]) => String(query).includes('bucketCreate'))).toHaveLength(1);
  });

  it('blocks a retained create marker before any Railway request', async () => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const withRecovery: Environment = {
      ...environment(),
      platformBindings: {
        ...environment().platformBindings,
        storageCreateRecovery: {
          uploads: {
            provider: 'railway', operation: 'create', resourceName: 'uploads',
            providerScope: { projectId: 'rp', environmentId: 're' },
            state: 'unresolved',
          },
        },
      },
    };

    const receipt = await adapter.ensureStorage(withRecovery, 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: { mutationAttempted: false, storageCreateRecovery: { state: 'unresolved' } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('retains the created bucket identity when creation cannot be re-observed', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-1', name: 'uploads', projectId: 'rp' } })
      .mockResolvedValueOnce(bucketState());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: { externalId: 'bucket-1', created: true, verification: 'absent' },
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects an unacknowledged environment patch and retains the created identity', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-1', name: 'uploads', projectId: 'rp' } })
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-1', name: 'uploads' }] }))
      .mockResolvedValueOnce({ environmentPatchCommit: false });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: { externalId: 'bucket-1', created: true, patchSubmitted: true, verification: 'unknown' },
    });
    expect(receipt.error).toContain('did not acknowledge');
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not report success until the environment bucket patch converges', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState())
      .mockResolvedValueOnce({ bucketCreate: { id: 'bucket-1', name: 'uploads', projectId: 'rp' } })
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-1', name: 'uploads' }] }))
      .mockResolvedValueOnce({ environmentPatchCommit: true })
      .mockResolvedValueOnce(bucketState({ buckets: [{ id: 'bucket-1', name: 'uploads' }] }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.ensureStorage(environment(), 'uploads', { region: 'sjc' });

    expect(receipt).toMatchObject({
      success: false,
      data: { externalId: 'bucket-1', patchSubmitted: true, verification: 'pending' },
    });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('verifies terminal environment absence after deleting a bucket instance', async () => {
    const active = bucketState({
      buckets: [{ id: 'bucket-1', name: 'uploads' }],
      config: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: false } },
    });
    const request = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ environmentPatchCommit: true })
      .mockResolvedValueOnce(bucketState({
        buckets: [{ id: 'bucket-1', name: 'uploads' }],
        config: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: true } },
      }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.destroyStorage(environment(), 'bucket-1');

    expect(receipt).toMatchObject({ success: true, data: { externalId: 'bucket-1', deleted: true } });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects an unacknowledged deletion patch', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(bucketState({
        buckets: [{ id: 'bucket-1', name: 'uploads' }],
        config: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: false } },
      }))
      .mockResolvedValueOnce({ environmentPatchCommit: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.destroyStorage(environment(), 'bucket-1');

    expect(receipt).toMatchObject({
      success: false,
      data: { externalId: 'bucket-1', patchSubmitted: true, verification: 'unknown' },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not report deletion success while the exact bucket instance remains active', async () => {
    const active = bucketState({
      buckets: [{ id: 'bucket-1', name: 'uploads' }],
      config: { 'bucket-1': { region: 'sjc', isCreated: true, isDeleted: false } },
    });
    const request = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ environmentPatchCommit: true })
      .mockResolvedValueOnce(active);
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.destroyStorage(environment(), 'bucket-1');

    expect(receipt).toMatchObject({
      success: false,
      data: { externalId: 'bucket-1', patchSubmitted: true, verification: 'pending' },
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('treats a complete environment config without the bound bucket instance as already absent', async () => {
    const request = vi.fn().mockResolvedValueOnce(bucketState({
      buckets: [{ id: 'bucket-1', name: 'uploads' }],
    }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };

    const receipt = await adapter.destroyStorage(environment(), 'bucket-1');

    expect(receipt).toMatchObject({ success: true, data: { externalId: 'bucket-1', deleted: false } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retrieves S3 credentials internally without putting them in a receipt', async () => {
    const request = vi.fn().mockResolvedValueOnce({ bucketS3Credentials: [{
      endpoint: 'https://storage.railway.app', accessKeyId: 'key', secretAccessKey: 'secret',
      bucketName: 'uploads-hash', region: 'auto', urlStyle: 'virtual',
    }] });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    await expect(adapter.getStorageCredentials(environment(), 'bucket-1')).resolves.toEqual({
      endpoint: 'https://storage.railway.app', accessKeyId: 'key', secretAccessKey: 'secret',
      bucket: 'uploads-hash', region: 'auto', urlStyle: 'virtual',
    });
  });
});
