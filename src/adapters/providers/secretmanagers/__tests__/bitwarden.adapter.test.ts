import { beforeEach, describe, expect, it, vi } from 'vitest';

const loginAccessToken = vi.fn();
const secretsGet = vi.fn();
const secretsList = vi.fn();
const BitwardenClient = vi.fn(function (this: unknown) {
  return {
    auth: () => ({ loginAccessToken }),
    secrets: () => ({ get: secretsGet, list: secretsList }),
  };
});
vi.mock('@bitwarden/sdk-napi', () => ({ BitwardenClient }));

import { BitwardenAdapter } from '../bitwarden.adapter.js';

const CREDS = { accessToken: '0.token', organizationId: 'org-1' };
const SECRET_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('BitwardenAdapter', () => {
  beforeEach(() => {
    loginAccessToken.mockReset().mockResolvedValue(undefined);
    secretsGet.mockReset();
    secretsList.mockReset();
    BitwardenClient.mockClear();
  });

  it('logs in with the machine account access token', async () => {
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'DATABASE_URL', value: 'postgres://x' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    await adapter.getSecret(SECRET_ID);

    expect(loginAccessToken).toHaveBeenCalledWith('0.token');
  });

  it('fetches a secret directly by uuid', async () => {
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'DATABASE_URL', value: 'postgres://x' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const result = await adapter.getSecret(SECRET_ID);

    expect(result.value).toBe('postgres://x');
    expect(secretsGet).toHaveBeenCalledWith(SECRET_ID);
    expect(secretsList).not.toHaveBeenCalled();
  });

  it('resolves a secret by key name via the org list', async () => {
    secretsList.mockResolvedValue({ data: [{ id: SECRET_ID, key: 'STRIPE_KEY' }] });
    secretsGet.mockResolvedValue({ id: SECRET_ID, key: 'STRIPE_KEY', value: 'sk_live_x' });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const result = await adapter.getSecret('STRIPE_KEY');

    expect(result.value).toBe('sk_live_x');
    expect(secretsList).toHaveBeenCalledWith('org-1');
    expect(secretsGet).toHaveBeenCalledWith(SECRET_ID);
  });

  it('rejects key and version selectors instead of ignoring them', async () => {
    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);

    await expect(adapter.getSecret(SECRET_ID, 'field')).rejects.toThrow('values are scalar');
    await expect(adapter.getSecret(SECRET_ID, undefined, '2')).rejects.toThrow('historical version');
    expect(BitwardenClient).not.toHaveBeenCalled();
  });

  it('blocks duplicate secret names instead of selecting the first match', async () => {
    secretsList.mockResolvedValue({
      data: [
        { id: SECRET_ID, key: 'STRIPE_KEY' },
        { id: '9c96b34d-6e5f-41dc-9eef-24e819b8cf48', key: 'STRIPE_KEY' },
      ],
    });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);

    await expect(adapter.getSecret('STRIPE_KEY')).rejects.toThrow('Multiple Bitwarden secrets');
    expect(secretsGet).not.toHaveBeenCalled();
  });

  it('enforces prefixes after listing Bitwarden secrets', async () => {
    secretsList.mockResolvedValue({
      data: [
        { id: SECRET_ID, key: 'production/DATABASE_URL' },
        { id: '9c96b34d-6e5f-41dc-9eef-24e819b8cf48', key: 'staging/DATABASE_URL' },
      ],
    });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);

    await expect(adapter.listSecrets('production/')).resolves.toEqual([
      { path: 'production/DATABASE_URL' },
    ]);
  });

  it('rejects a fetched Bitwarden secret with a different identity', async () => {
    secretsGet.mockResolvedValue({
      id: '9c96b34d-6e5f-41dc-9eef-24e819b8cf48',
      key: 'DATABASE_URL',
      value: 'postgres://x',
    });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);

    await expect(adapter.getSecret(SECRET_ID)).rejects.toThrow('not the requested identity');
  });

  it('verify lists org secrets and reports identity', async () => {
    secretsList.mockResolvedValue({ data: [] });

    const adapter = new BitwardenAdapter();
    await adapter.connect(CREDS);
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.identity).toContain('org-1');
  });

  it('does not expose secret mutation methods', async () => {
    const adapter = new BitwardenAdapter();
    expect('setSecret' in adapter).toBe(false);
    expect('deleteSecret' in adapter).toBe(false);
  });
});
