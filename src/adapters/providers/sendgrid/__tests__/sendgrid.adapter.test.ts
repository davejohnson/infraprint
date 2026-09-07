import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendGridAdapter } from '../sendgrid.adapter.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function connectedAdapter(): SendGridAdapter {
  const adapter = new SendGridAdapter();
  adapter.connect({ apiKey: 'SG.test.key' });
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SendGridAdapter observations', () => {
  it('returns absence only for a provider-confirmed not-found domain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ errors: [{ message: 'not found' }] }, 404)
    );

    await expect(connectedAdapter().getDomainAuthentication(42)).resolves.toBeNull();
  });

  it('preserves a non-not-found domain observation failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ errors: [{ message: 'forbidden' }] }, 403)
    );

    await expect(connectedAdapter().getDomainAuthentication(42))
      .rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['domain authentications', '/whitelabel/domains', (adapter: SendGridAdapter) => adapter.listDomainAuthentications()],
    ['verified senders', '/verified_senders', (adapter: SendGridAdapter) => adapter.listVerifiedSenders()],
    ['Inbound Parse routes', '/user/webhooks/parse/settings', (adapter: SendGridAdapter) => adapter.listInboundParseWebhooks()],
  ])('does not interpret an incomplete %s payload as an empty list', async (_label, path, observe) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}));

    await expect(observe(connectedAdapter())).rejects.toThrow(/invalid list/);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.sendgrid.com/v3${path}`,
      expect.objectContaining({ method: 'GET' })
    );
  });
});
