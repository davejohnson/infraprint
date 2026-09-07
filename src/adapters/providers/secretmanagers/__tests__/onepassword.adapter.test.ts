import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.fn();
vi.mock('@1password/sdk', () => ({ createClient }));

import { OnePasswordAdapter } from '../onepassword.adapter.js';

describe('OnePasswordAdapter', () => {
  beforeEach(() => {
    createClient.mockReset();
  });

  it('resolves a secret via op:// reference with explicit field', async () => {
    const resolve = vi.fn().mockResolvedValue('s3cret');
    createClient.mockResolvedValue({ secrets: { resolve } });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const result = await adapter.getSecret('Production/stripe', 'secret-key');

    expect(result.value).toBe('s3cret');
    expect(resolve).toHaveBeenCalledWith('op://Production/stripe/secret-key');
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'ops_token' })
    );
  });

  it('defaults to the password field when no key is given', async () => {
    const resolve = vi.fn().mockResolvedValue('hunter2');
    createClient.mockResolvedValue({ secrets: { resolve } });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    await adapter.getSecret('Production/db');

    expect(resolve).toHaveBeenCalledWith('op://Production/db/password');
  });

  it('rejects historical versions instead of silently reading the latest value', async () => {
    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });

    await expect(adapter.getSecret('Production/db', undefined, '2')).rejects.toThrow(
      'historical version'
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it('verify reports failure when the client cannot authenticate', async () => {
    createClient.mockRejectedValue(new Error('invalid service account token'));

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'bad' });
    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid service account token');
  });

  it('verify succeeds when the service account can see at least one vault', async () => {
    createClient.mockResolvedValue({
      secrets: { resolve: vi.fn() },
      vaults: { list: vi.fn().mockResolvedValue([{ id: 'v1', title: 'Production' }]) },
      items: { list: vi.fn() },
    });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.identity).toBe('1Password service account');
  });

  it('verify fails with a clear message when the token has no vault access', async () => {
    createClient.mockResolvedValue({
      secrets: { resolve: vi.fn() },
      vaults: { list: vi.fn().mockResolvedValue([]) },
      items: { list: vi.fn() },
    });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });
    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('no vaults');
  });

  it('lists secrets as vault/item paths, filtered by prefix', async () => {
    const itemsList = vi.fn(async (vaultId: string) => {
      if (vaultId === 'v1') {
        return [{ id: 'i1', title: 'stripe' }, { id: 'i2', title: 'db' }];
      }
      return [{ id: 'i3', title: 'stripe' }];
    });
    createClient.mockResolvedValue({
      secrets: { resolve: vi.fn() },
      vaults: {
        list: vi.fn().mockResolvedValue([
          { id: 'v1', title: 'Production' },
          { id: 'v2', title: 'Staging' },
        ]),
      },
      items: { list: itemsList },
    });

    const adapter = new OnePasswordAdapter();
    await adapter.connect({ serviceAccountToken: 'ops_token' });

    const all = await adapter.listSecrets();
    expect(all.map((item) => item.path).sort()).toEqual([
      'Production/db',
      'Production/stripe',
      'Staging/stripe',
    ]);

    const filtered = await adapter.listSecrets('Production/');
    expect(filtered.map((item) => item.path).sort()).toEqual([
      'Production/db',
      'Production/stripe',
    ]);
  });

  it('does not expose secret mutation methods', async () => {
    const adapter = new OnePasswordAdapter();
    expect('setSecret' in adapter).toBe(false);
    expect('deleteSecret' in adapter).toBe(false);
  });
});
