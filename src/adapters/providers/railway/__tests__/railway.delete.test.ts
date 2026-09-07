import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { RailwayVolumeTarget } from '../railway.adapter.js';

function graphqlNotFound(rootField: string, message: string): Error {
  const error = new Error(message) as Error & {
    response: {
      status: number;
      errors: Array<{
        message: string;
        path: string[];
        extensions: { code: string };
      }>;
    };
  };
  error.response = {
    status: 200,
    errors: [{
      message,
      path: [rootField],
      extensions: { code: 'NOT_FOUND' },
    }],
  };
  return error;
}

const volumeTarget: RailwayVolumeTarget = {
  projectId: 'project-1',
  environmentId: 'environment-1',
  serviceId: 'service-1',
  mountPath: '/data',
};

function volumeInventory(
  volumes: Array<{
    volumeId: string;
    instanceId?: string;
    serviceId?: string;
    environmentId?: string;
    projectId?: string;
    mountPath?: string;
    deletedAt?: string | null;
    pending?: boolean;
  }> = []
) {
  return {
    environment: {
      id: volumeTarget.environmentId,
      volumeInstances: {
        edges: volumes.map((volume) => ({
          node: {
            id: volume.instanceId ?? `${volume.volumeId}-instance`,
            serviceId: volume.serviceId ?? volumeTarget.serviceId,
            environmentId: volume.environmentId ?? volumeTarget.environmentId,
            mountPath: volume.mountPath ?? volumeTarget.mountPath,
            deletedAt: volume.deletedAt ?? null,
            isPendingDeletion: volume.pending ?? false,
            volume: {
              id: volume.volumeId,
              projectId: volume.projectId ?? volumeTarget.projectId,
            },
          },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

describe('RailwayAdapter delete verification', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('treats falsy projectDelete payload as failure', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { id: 'proj-1' } })
      .mockResolvedValueOnce({ projectDelete: false });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteProject('proj-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('unsuccessful payload');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('verifies service deletion before reporting success', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-1' } })
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(graphqlNotFound('service', 'Service not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1');

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[1]?.[0])).toContain('serviceDelete(id: $id)');
    expect(String(request.mock.calls[1]?.[0])).not.toContain('serviceDelete(input:');
  });

  it('treats deletion of an already absent service as idempotent success', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      graphqlNotFound('service', 'Service not found')
    );
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-missing')).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });
  });

  it('treats deletion of an already absent project as idempotent success', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      graphqlNotFound('project', 'Project not found')
    );
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteProject('project-missing')).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unstructured not-found message as confirmed service absence', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Service not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-unknown');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(result.error).toContain('Service not found');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deletes one exact environment and verifies absence without deleting shared services', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { id: 'project-1', environments: { edges: [{ node: { id: 'environment-1' } }] } } })
      .mockResolvedValueOnce({ environmentDelete: true })
      .mockResolvedValueOnce({ project: { id: 'project-1', environments: { edges: [] } } });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteEnvironment('project-1', 'environment-1')).resolves.toEqual({ success: true });

    expect(String(request.mock.calls[1]?.[0])).toContain('environmentDelete(id: $id)');
    expect(String(request.mock.calls[1]?.[0])).not.toContain('serviceDelete');
    expect(request.mock.calls[1]?.[1]).toEqual({ id: 'environment-1' });
  });

  it('preserves an environment binding when post-delete absence is unknown', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { id: 'project-1', environments: { edges: [{ node: { id: 'environment-1' } }] } } })
      .mockResolvedValueOnce({ environmentDelete: true })
      .mockRejectedValueOnce(new Error('Railway API unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteEnvironment('project-1', 'environment-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
  });

  it('keeps polling beyond the old three-second verification window', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '12');
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: { id: 'svc-slow-delete' } })
      .mockResolvedValueOnce({ service: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-slow-delete')).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(9);
  });

  it('keeps polling when service deletion becomes visible after twenty observations', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-eventually-deleted' } })
      .mockResolvedValueOnce({ serviceDelete: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      request.mockResolvedValueOnce({ service: { id: 'svc-eventually-deleted' } });
    }
    request.mockResolvedValueOnce({ service: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-eventually-deleted')).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(23);
  });

  it('does not mistake an observation failure for successful deletion', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ service: { id: 'svc-unknown' } })
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(new Error('Railway API unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-unknown');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(result.error).toContain('Railway API unavailable');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('deletes an exact scoped volume and verifies terminal absence', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(volumeInventory([{ volumeId: 'vol-1' }]))
      .mockResolvedValueOnce({ volumeDelete: true })
      .mockResolvedValueOnce(volumeInventory());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteVolume('vol-1', volumeTarget);

    expect(result.success).toBe(true);
    expect(String(request.mock.calls[1]?.[0])).toContain('volumeDelete(volumeId: $volumeId)');
    expect(request.mock.calls[1]?.[1]).toEqual({ volumeId: 'vol-1' });
  });

  it('treats a provider-confirmed absent scoped volume as idempotent success', async () => {
    const request = vi.fn().mockResolvedValueOnce(volumeInventory());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteVolume('vol-missing', volumeTarget)).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });
    expect(request.mock.calls.some(([query]) => String(query).includes('volumeDelete'))).toBe(false);
  });

  it('refuses to delete a volume id attached outside the recorded target', async () => {
    const request = vi.fn().mockResolvedValueOnce(volumeInventory([{
      volumeId: 'vol-1',
      serviceId: 'different-service',
    }]));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteVolume('vol-1', volumeTarget);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not the recorded target');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not treat a failed post-delete volume observation as terminal absence', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(volumeInventory([{ volumeId: 'vol-1' }]))
      .mockResolvedValueOnce({ volumeDelete: true })
      .mockRejectedValueOnce(new Error('Railway volume inventory unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteVolume('vol-1', volumeTarget);

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be verified');
    expect(result.error).toContain('inventory unavailable');
  });
});
