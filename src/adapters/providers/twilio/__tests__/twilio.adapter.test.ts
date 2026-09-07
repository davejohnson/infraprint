import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwilioAdapter } from '../twilio.adapter.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const API_KEY_SID = `SK${'b'.repeat(32)}`;
const SERVICE_SID = `MG${'c'.repeat(32)}`;
const PHONE_SID = `PN${'d'.repeat(32)}`;

function messagingService() {
  return {
    sid: SERVICE_SID,
    account_sid: ACCOUNT_SID,
    friendly_name: 'example-production',
    inbound_request_url: 'https://api.example.com/webhooks/twilio/messages',
    inbound_method: 'POST',
    fallback_url: null,
    fallback_method: 'POST',
    status_callback: 'https://api.example.com/webhooks/twilio/status',
    use_inbound_webhook_on_number: false,
  };
}

function messagingPhone() {
  return {
    sid: PHONE_SID,
    account_sid: ACCOUNT_SID,
    service_sid: SERVICE_SID,
    phone_number: '+15555550100',
    country_code: 'US',
    capabilities: ['SMS'],
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

function adapter(): TwilioAdapter {
  const instance = new TwilioAdapter();
  instance.connect({
    accountSid: ACCOUNT_SID,
    apiKeySid: API_KEY_SID,
    apiKeySecret: 'api-key-secret',
    authToken: 'account-auth-token',
  });
  return instance;
}

afterEach(() => vi.restoreAllMocks());

describe('TwilioAdapter', () => {
  it('verifies both the restricted API key and webhook-validation auth token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ services: [] }))
      .mockResolvedValueOnce(response({ sid: ACCOUNT_SID }));

    await expect(adapter().verify()).resolves.toEqual({ success: true, accountId: ACCOUNT_SID });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://messaging.twilio.com/v1/Services?PageSize=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(`${API_KEY_SID}:api-key-secret`).toString('base64')}`,
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}.json`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:account-auth-token`).toString('base64')}`,
        }),
      })
    );
  });

  it('creates a Messaging Service and attaches an existing number with form bodies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(messagingService()))
      .mockResolvedValueOnce(response(messagingPhone()));
    const instance = adapter();

    await instance.createMessagingService({
      friendlyName: 'example-production',
      inboundRequestUrl: 'https://api.example.com/webhooks/twilio/messages',
      statusCallback: 'https://api.example.com/webhooks/twilio/status',
    });
    await instance.attachMessagingPhoneNumber(SERVICE_SID, PHONE_SID);

    const serviceBody = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(serviceBody)).toMatchObject({
      FriendlyName: 'example-production',
      InboundRequestUrl: 'https://api.example.com/webhooks/twilio/messages',
      InboundMethod: 'POST',
      StatusCallback: 'https://api.example.com/webhooks/twilio/status',
      UseInboundWebhookOnNumber: 'false',
    });
    const senderBody = new URLSearchParams(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(Object.fromEntries(senderBody)).toEqual({ PhoneNumberSid: PHONE_SID });
  });

  it('distinguishes provider-confirmed absence from other failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ message: 'Not Found', code: 20404 }, 404));

    await expect(adapter().getMessagingService(SERVICE_SID)).resolves.toBeNull();
  });

  it('treats a malformed list response as unknown instead of absence', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ services: [{ sid: SERVICE_SID }] }));

    await expect(adapter().listMessagingServices()).rejects.toThrow();
  });

  it('reports an exact missing friendly name as absent with a validated empty collection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ services: [messagingService()] }));
    const inspection = providerRegistry.get('twilio')!.inspection!;

    await expect(inspection.inspect(adapter(), {
      resource: 'messaging-service',
      name: 'missing-service',
      limit: 25,
    })).resolves.toMatchObject({
      observation: 'absent',
      name: 'missing-service',
      services: [],
      truncated: false,
      partial: false,
    });
    expect(inspection.selectors['messaging-service']?.collectionKey).toBe('services');
  });
});
