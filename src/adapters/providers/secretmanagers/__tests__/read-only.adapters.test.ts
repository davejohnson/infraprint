import { afterEach, describe, expect, it, vi } from 'vitest';
import { DopplerAdapter } from '../doppler.adapter.js';
import { VaultAdapter } from '../vault.adapter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('read-only secret manager requests', () => {
  it('builds a valid Vault KV v2 read URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { data: { API_KEY: 'secret' }, metadata: { version: 2 } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VaultAdapter();
    await adapter.connect({ address: 'https://vault.example', token: 'token' });

    const result = await adapter.getSecret('secret/apps/prod', 'API_KEY');

    expect(result).toMatchObject({ value: 'secret', version: '2' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example/v1/secret/data/apps/prod',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('requests and verifies the exact Vault KV v2 version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { data: { API_KEY: 'secret' }, metadata: { version: 3 } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VaultAdapter();
    await adapter.connect({ address: 'https://vault.example', token: 'token' });

    await expect(adapter.getSecret('secret/apps/prod', 'API_KEY', '2')).rejects.toThrow(
      'returned version 3, not requested version 2'
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example/v1/secret/data/apps/prod?version=2',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('requires a Vault path prefix so listing cannot target an unknown mount', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VaultAdapter();
    await adapter.connect({ address: 'https://vault.example', token: 'token' });

    await expect(adapter.listSecrets()).rejects.toThrow('requires pathPrefix');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a query delimiter for a Doppler service-token read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      secret: { name: 'API_KEY', value: { raw: 'secret', computed: 'secret' } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new DopplerAdapter();
    await adapter.connect({ token: 'dp.st.token' });

    const result = await adapter.getSecret('API_KEY');

    expect(result).toEqual({ value: 'secret' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.doppler.com/v3/configs/config/secret?name=API_KEY',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('rejects selectors Doppler cannot honor instead of ignoring them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new DopplerAdapter();
    await adapter.connect({ token: 'dp.st.token' });

    await expect(adapter.getSecret('API_KEY', 'nested')).rejects.toThrow('scalar values');
    await expect(adapter.getSecret('API_KEY', undefined, '2')).rejects.toThrow('historical version');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces Doppler name prefixes after the provider response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      secrets: {
        API_KEY: { name: 'API_KEY', value: { raw: 'secret', computed: 'secret' } },
        DATABASE_URL: { name: 'DATABASE_URL', value: { raw: 'secret', computed: 'secret' } },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new DopplerAdapter();
    await adapter.connect({ token: 'dp.st.token', project: 'project', config: 'production' });

    const result = await adapter.listSecrets('project/production/API');

    expect(result).toEqual([{ path: 'API_KEY' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.doppler.com/v3/configs/config/secrets?project=project&config=production',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('rejects a Doppler response for a different secret identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      secret: { name: 'OTHER_KEY', value: { raw: 'secret', computed: 'secret' } },
    }), { status: 200 })));
    const adapter = new DopplerAdapter();
    await adapter.connect({ token: 'dp.st.token' });

    await expect(adapter.getSecret('API_KEY')).rejects.toThrow(
      'returned secret OTHER_KEY, not requested secret API_KEY'
    );
  });
});
