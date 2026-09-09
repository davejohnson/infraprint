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

function serviceScope(environmentId = 'env-staging') {
  return { scope: 'environment' as const, projectId: 'project-1', environmentId };
}

const allowMutation = { allowMutation: true } as const;

function serviceInstance(serviceId = 'svc-1', environmentId = 'env-staging') {
  return {
    serviceInstance: {
      id: `${serviceId}:${environmentId}`,
      serviceId,
      environmentId,
    },
  };
}

function environmentIdentity(environmentId = 'environment-1') {
  return { environment: { id: environmentId } };
}

function serviceInventory(
  environmentIds: string[],
  options: { serviceId?: string; projectId?: string; hasNextPage?: boolean; endCursor?: string | null } = {}
) {
  const serviceId = options.serviceId ?? 'svc-1';
  return {
    service: {
      id: serviceId,
      projectId: options.projectId ?? 'project-1',
      serviceInstances: {
        edges: environmentIds.map((environmentId) => ({
          node: { id: `${serviceId}:${environmentId}`, environmentId },
        })),
        pageInfo: {
          hasNextPage: options.hasNextPage ?? false,
          endCursor: options.endCursor ?? null,
        },
      },
    },
  };
}

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
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging']))
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(graphqlNotFound('serviceInstance', 'Service instance not found'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
    expect(String(request.mock.calls[2]?.[0])).toContain('serviceDelete(id: $id, environmentId: $environmentId)');
    expect(request.mock.calls[2]?.[1]).toEqual({ id: 'svc-1', environmentId: 'env-staging' });
  });

  it('treats deletion of an already absent service as idempotent success', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      graphqlNotFound('serviceInstance', 'Service instance not found')
    );
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-missing', serviceScope(), allowMutation)).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });
  });

  it('refuses an unscoped Railway service deletion without making a provider request', async () => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect((adapter.deleteService as unknown as (serviceId: string) => Promise<unknown>)('svc-1'))
      .resolves.toEqual(expect.objectContaining({ success: false }));
    await expect(adapter.deleteService(' ', serviceScope(), allowMutation))
      .resolves.toEqual(expect.objectContaining({ success: false }));
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a Railway service deletion without an explicit mutation decision', async () => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect((adapter.deleteService as unknown as (
      serviceId: string,
      scope: ReturnType<typeof serviceScope>
    ) => Promise<unknown>)('svc-1', serviceScope()))
      .resolves.toEqual(expect.objectContaining({ success: false }));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a project-wide target',
      { scope: 'project', projectId: 'project-1' },
      allowMutation,
    ],
    [
      'a blank project id',
      { scope: 'environment', projectId: ' ', environmentId: 'env-staging' },
      allowMutation,
    ],
    [
      'a blank environment id',
      { scope: 'environment', projectId: 'project-1', environmentId: ' ' },
      allowMutation,
    ],
    [
      'a non-boolean mutation decision',
      serviceScope(),
      { allowMutation: 'yes' },
    ],
  ])('refuses %s without making a provider request', async (_label, target, options) => {
    const request = vi.fn();
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const deleteService = adapter.deleteService as unknown as (
      serviceId: string,
      target: unknown,
      options: unknown
    ) => Promise<unknown>;
    await expect(deleteService.call(adapter, 'svc-1', target, options))
      .resolves.toEqual(expect.objectContaining({ success: false }));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing response root', {}],
    ['a mismatched service id', serviceInstance('other-service')],
    ['a mismatched environment id', serviceInstance('svc-1', 'env-production')],
    ['a missing instance id', {
      serviceInstance: { serviceId: 'svc-1', environmentId: 'env-staging' },
    }],
  ])('blocks deletion when exact preflight returns %s', async (_label, preflight) => {
    const request = vi.fn().mockResolvedValueOnce(preflight);
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceDelete'))).toBe(false);
  });

  it('deletes a sole exact environment service instance and verifies scoped absence', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging']))
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockResolvedValueOnce({ serviceInstance: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-1', serviceScope(), allowMutation)).resolves.toEqual({ success: true });

    expect(String(request.mock.calls[2]?.[0])).toContain('serviceDelete(id: $id, environmentId: $environmentId)');
    expect(request.mock.calls[2]?.[1]).toEqual({ id: 'svc-1', environmentId: 'env-staging' });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('exactly verifies absence after a serviceDelete not-found acknowledgement race', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging']))
      .mockRejectedValueOnce(graphqlNotFound('serviceDelete', 'Service disappeared'))
      .mockResolvedValueOnce({ serviceInstance: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-1', serviceScope(), allowMutation)).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('rejects a serviceDelete not-found acknowledgement when the exact instance remains present', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging']))
      .mockRejectedValueOnce(graphqlNotFound('serviceDelete', 'Service disappeared'))
      .mockResolvedValueOnce(serviceInstance());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.alreadyAbsent).not.toBe(true);
    expect(result.error).toContain('still-present service instance');
  });

  it('rejects a serviceDelete not-found acknowledgement when exact absence is unknown', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging']))
      .mockRejectedValueOnce(graphqlNotFound('serviceDelete', 'Service disappeared'))
      .mockRejectedValueOnce(new Error('exact recheck unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.alreadyAbsent).not.toBe(true);
    expect(result.error).toContain('exact recheck unavailable');
  });

  it('does not mutate Railway when the exact target is absent even if the service may remain in a sibling environment', async () => {
    const request = vi.fn().mockResolvedValueOnce({ serviceInstance: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-1', serviceScope(), { allowMutation: false })).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceDelete'))).toBe(false);
  });

  it('does not mutate Railway when the exact target remains present but local sharing forbids mutation', async () => {
    const request = vi.fn().mockResolvedValueOnce(serviceInstance());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), { allowMutation: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('forbids provider mutation');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([query]) => String(query).includes('serviceDelete'))).toBe(false);
  });

  it('blocks deletion when the provider service has a sibling environment instance', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging', 'env-production']));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-1', serviceScope(), allowMutation)).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('env-production'),
    }));
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
  });

  it('blocks deletion when exact presence conflicts with an absent service inventory', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce({ service: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('conflicting');
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
  });

  it('blocks deletion when the complete inventory belongs to another project', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { projectId: 'other-project' }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('inventory is unknown');
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
  });

  it('paginates the complete sibling inventory and blocks a sibling found on page two', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { hasNextPage: true, endCursor: 'page-2' }))
      .mockResolvedValueOnce(serviceInventory(['env-production']));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('env-production');
    expect(request.mock.calls[1]?.[1]).toEqual({ serviceId: 'svc-1', after: null });
    expect(request.mock.calls[2]?.[1]).toEqual({ serviceId: 'svc-1', after: 'page-2' });
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
  });

  it('blocks deletion when the sibling inventory omits pagination completeness', async () => {
    const inventory = serviceInventory(['env-staging']);
    delete (inventory.service.serviceInstances as { pageInfo?: unknown }).pageInfo;
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(inventory);
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('inventory is unknown');
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
  });

  it('blocks deletion on a repeated sibling-inventory cursor', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { hasNextPage: true, endCursor: 'repeat' }))
      .mockResolvedValueOnce(serviceInventory([], { hasNextPage: true, endCursor: 'repeat' }));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('repeated');
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
  });

  it('blocks deletion when a later sibling-inventory page fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance())
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { hasNextPage: true, endCursor: 'page-2' }))
      .mockRejectedValueOnce(new Error('inventory page unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-1', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('inventory page unavailable');
    expect(request.mock.calls.some(([query]) => String(query).includes('mutation DeleteEnvironmentService'))).toBe(false);
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

    const result = await adapter.deleteService('svc-unknown', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(result.error).toContain('Service not found');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deletes one exact environment and verifies absence without deleting shared services', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(environmentIdentity())
      .mockResolvedValueOnce({ environmentDelete: true })
      .mockResolvedValueOnce({ environment: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteEnvironment('project-1', 'environment-1')).resolves.toEqual({ success: true });

    expect(String(request.mock.calls[0]?.[0])).toContain('environment(id: $environmentId, projectId: $projectId)');
    expect(request.mock.calls[0]?.[1]).toEqual({ environmentId: 'environment-1', projectId: 'project-1' });
    expect(String(request.mock.calls[1]?.[0])).toContain('environmentDelete(id: $id)');
    expect(String(request.mock.calls[1]?.[0])).not.toContain('serviceDelete');
    expect(request.mock.calls[1]?.[1]).toEqual({ id: 'environment-1' });
    expect(String(request.mock.calls[2]?.[0])).toContain('environment(id: $environmentId, projectId: $projectId)');
    expect(request.mock.calls[2]?.[1]).toEqual({ environmentId: 'environment-1', projectId: 'project-1' });
  });

  it('treats exact preflight absence as idempotent success without mutation', async () => {
    const request = vi.fn().mockResolvedValueOnce({ environment: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteEnvironment('project-1', 'environment-1')).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([query]) => String(query).includes('environmentDelete'))).toBe(false);
  });

  it.each([
    ['a missing response root', {}],
    ['a mismatched environment id', environmentIdentity('other-environment')],
    ['a partial environment identity', { environment: {} }],
  ])('blocks environment deletion when exact preflight returns %s', async (_label, response) => {
    const request = vi.fn().mockResolvedValueOnce(response);
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteEnvironment('project-1', 'environment-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([query]) => String(query).includes('environmentDelete'))).toBe(false);
  });

  it('blocks environment deletion when exact preflight fails', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('exact environment read unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteEnvironment('project-1', 'environment-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('exact environment read unavailable');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([query]) => String(query).includes('environmentDelete'))).toBe(false);
  });

  it('preserves an environment binding when post-delete absence is unknown', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(environmentIdentity())
      .mockResolvedValueOnce({ environmentDelete: true })
      .mockRejectedValueOnce(new Error('Railway API unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteEnvironment('project-1', 'environment-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('exactly verifies absence after an environmentDelete not-found acknowledgement race', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(environmentIdentity())
      .mockRejectedValueOnce(graphqlNotFound('environmentDelete', 'Environment disappeared'))
      .mockResolvedValueOnce({ environment: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteEnvironment('project-1', 'environment-1')).resolves.toEqual({
      success: true,
      alreadyAbsent: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[2]?.[0])).toContain('environment(id: $environmentId, projectId: $projectId)');
  });

  it('rejects an environmentDelete not-found acknowledgement while the exact environment remains present', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(environmentIdentity())
      .mockRejectedValueOnce(graphqlNotFound('environmentDelete', 'Environment disappeared'))
      .mockResolvedValueOnce(environmentIdentity());
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteEnvironment('project-1', 'environment-1');

    expect(result.success).toBe(false);
    expect(result.alreadyAbsent).not.toBe(true);
    expect(result.error).toContain('still-present environment');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps polling beyond the old three-second verification window', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '12');
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance('svc-slow-delete'))
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { serviceId: 'svc-slow-delete' }))
      .mockResolvedValueOnce({ serviceDelete: true });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      request.mockResolvedValueOnce(serviceInstance('svc-slow-delete'));
    }
    request.mockResolvedValueOnce({ serviceInstance: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-slow-delete', serviceScope(), allowMutation)).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(10);
  });

  it('keeps polling when service deletion becomes visible after twenty observations', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance('svc-eventually-deleted'))
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { serviceId: 'svc-eventually-deleted' }))
      .mockResolvedValueOnce({ serviceDelete: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      request.mockResolvedValueOnce(serviceInstance('svc-eventually-deleted'));
    }
    request.mockResolvedValueOnce({ serviceInstance: null });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    await expect(adapter.deleteService('svc-eventually-deleted', serviceScope(), allowMutation)).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledTimes(24);
  });

  it('does not mistake an observation failure for successful deletion', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance('svc-unknown'))
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { serviceId: 'svc-unknown' }))
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockRejectedValueOnce(new Error('Railway API unavailable'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-unknown', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('absence is unknown');
    expect(result.error).toContain('Railway API unavailable');
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not report success while the exact service instance remains present', async () => {
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
    const request = vi.fn()
      .mockResolvedValueOnce(serviceInstance('svc-still-present'))
      .mockResolvedValueOnce(serviceInventory(['env-staging'], { serviceId: 'svc-still-present' }))
      .mockResolvedValueOnce({ serviceDelete: true })
      .mockResolvedValueOnce(serviceInstance('svc-still-present'))
      .mockResolvedValueOnce(serviceInstance('svc-still-present'));
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.deleteService('svc-still-present', serviceScope(), allowMutation);

    expect(result.success).toBe(false);
    expect(result.error).toContain('still exists');
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
