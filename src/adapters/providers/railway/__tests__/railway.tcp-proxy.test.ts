import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

function stubClient(adapter: RailwayAdapter, request: ReturnType<typeof vi.fn>): void {
  (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
}

describe('RailwayAdapter TCP proxy', () => {
  const environment = {
    id: 'env-local-1',
    projectId: 'project-local-1',
    name: 'production',
    platformBindings: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const component = {
    id: 'component-1',
    environmentId: 'env-local-1',
    type: 'postgres' as const,
    externalId: 'rail-svc-db-1',
    bindings: { provider: 'railway', projectId: 'rail-proj-1' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('creates a TCP proxy when none exists for the application port', async () => {
    const request = vi.fn()
      // tcpProxies lookup — nothing yet
      .mockResolvedValueOnce({ tcpProxies: [] })
      // tcpProxyCreate
      .mockResolvedValueOnce({
        tcpProxyCreate: { id: 'proxy-1', domain: 'tramway.proxy.rlwy.net', proxyPort: 12345, applicationPort: 5432 },
      });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const result = await adapter.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(result).toEqual({ id: 'proxy-1', domain: 'tramway.proxy.rlwy.net', proxyPort: 12345, created: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual({ environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1' });
    expect(request.mock.calls[1]?.[1]).toEqual({
      input: { environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1', applicationPort: 5432 },
    });
  });

  it('reuses an existing proxy for the same application port without mutating', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      tcpProxies: [
        { id: 'proxy-other', domain: 'other.proxy.rlwy.net', proxyPort: 11111, applicationPort: 6379 },
        { id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 22222, applicationPort: 5432 },
      ],
    });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const result = await adapter.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(result).toEqual({ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 22222, created: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('surfaces Railway errors when proxy creation fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ tcpProxies: [] })
      .mockRejectedValueOnce(new Error('Not Authorized'));

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await expect(adapter.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432)).rejects.toThrow('Not Authorized');
  });

  it('getTcpProxy returns the matching proxy and never mutates', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      tcpProxies: [{ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
    });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const proxy = await adapter.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(proxy).toEqual({ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('getTcpProxy returns null when no proxy matches the port', async () => {
    const adapter = new RailwayAdapter();
    stubClient(adapter, vi.fn().mockResolvedValueOnce({
      tcpProxies: [{ id: 'proxy-other', domain: 'other.proxy.rlwy.net', proxyPort: 11111, applicationPort: 6379 }],
    }));
    expect(await adapter.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432)).toBeNull();
  });

  it('preserves a failed proxy observation instead of authorizing a create', async () => {
    const failing = new RailwayAdapter();
    const request = vi.fn().mockRejectedValueOnce(new Error('proxy observation unavailable'));
    stubClient(failing, request);

    await expect(failing.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432))
      .rejects.toThrow('proxy observation unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deletes a TCP proxy and verifies that it is no longer active', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        tcpProxies: [{ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      })
      .mockResolvedValueOnce({ tcpProxyDelete: true })
      .mockResolvedValueOnce({ tcpProxies: [] });
    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg');

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[1]).toEqual({ environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1' });
    expect(request.mock.calls[1]?.[1]).toEqual({ id: 'proxy-pg' });
    expect(request.mock.calls[2]?.[1]).toEqual({ environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1' });
  });

  it('treats an already absent TCP proxy as successfully deleted', async () => {
    const request = vi.fn().mockResolvedValue({ tcpProxies: [] });
    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg');
    await adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[1]?.environmentId === 'rail-env-1')).toBe(true);
  });

  it('fails cleanup when Railway does not confirm TCP proxy deletion', async () => {
    const adapter = new RailwayAdapter();
    stubClient(adapter, vi.fn()
      .mockResolvedValueOnce({
        tcpProxies: [{ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      })
      .mockResolvedValueOnce({ tcpProxyDelete: false })
      .mockResolvedValueOnce({
        tcpProxies: [{ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      }));

    await expect(adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg'))
      .rejects.toThrow('did not confirm deletion');
  });

  it('ignores proxies already deleting during cleanup verification', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        tcpProxies: [{ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      })
      .mockResolvedValueOnce({ tcpProxyDelete: true })
      .mockResolvedValueOnce({
        tcpProxies: [{
          id: 'proxy-pg',
          domain: 'db.proxy.rlwy.net',
          proxyPort: 33333,
          applicationPort: 5432,
          syncStatus: 'DELETING',
        }],
      });
    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await expect(adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg')).resolves.toBeUndefined();
  });

  it('returns a releasable lease only for a newly created database proxy', async () => {
    const adapter = new RailwayAdapter();
    vi.spyOn(adapter, 'ensureTcpProxy').mockResolvedValue({
      id: 'proxy-temp', domain: 'db.proxy.rlwy.net.', proxyPort: 33333, created: true,
    });
    vi.spyOn(adapter, 'getServiceVariables').mockResolvedValue({
      PGUSER: 'postgres', POSTGRES_PASSWORD: 'secret', PGDATABASE: 'app',
    });

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);

    expect(access).toEqual({
      connectionUrl: 'postgresql://postgres:secret@db.proxy.rlwy.net:33333/app',
      source: 'created_proxy',
      endpoint: 'db.proxy.rlwy.net:33333',
      temporary: true,
      releaseToken: 'proxy-temp',
    });
  });

  it('removes a newly created proxy when acquiring database credentials fails', async () => {
    const adapter = new RailwayAdapter();
    vi.spyOn(adapter, 'ensureTcpProxy').mockResolvedValue({
      id: 'proxy-temp', domain: 'db.proxy.rlwy.net', proxyPort: 33333, created: true,
    });
    vi.spyOn(adapter, 'getServiceVariables').mockResolvedValue({});
    const deleteProxy = vi.spyOn(adapter, 'deleteTcpProxy').mockResolvedValue();

    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432))
      .rejects.toThrow('missing PGUSER or POSTGRES_PASSWORD');
    expect(deleteProxy).toHaveBeenCalledWith('rail-env-1', 'rail-svc-db-1', 'proxy-temp');
  });
});
