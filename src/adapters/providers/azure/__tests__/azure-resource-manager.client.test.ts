import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { AzureDatastoreCredentialsSchema } from '../azure-datastore.credentials.js';
import {
  AzureResourceManagerClient,
  AzureResourceManagerError,
  resolveAzureDefaultSubscription,
} from '../azure-resource-manager.client.js';

const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE_GROUP = 'hypervibe-test';
const COLLECTION =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`
  + '/providers/Microsoft.Example/resources';

const credentials = AzureDatastoreCredentialsSchema.parse({
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: SUBSCRIPTION_ID,
  clientId: '33333333-3333-4333-8333-333333333333',
  clientSecret: 'azure-client-secret',
  resourceGroup: RESOURCE_GROUP,
  location: 'canadacentral',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: 'safe-access-token' });
}

function principalTokenResponse(): Response {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    oid: '44444444-4444-4444-8444-444444444444',
  })).toString('base64url');
  return jsonResponse({ access_token: `${header}.${payload}.signature` });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AzureResourceManagerClient', () => {
  it('derives an unambiguous subscription from the Azure default credential chain', async () => {
    const request = vi.fn(async () => jsonResponse({
      value: [{ subscriptionId: SUBSCRIPTION_ID, state: 'Enabled' }],
    }));

    await expect(resolveAzureDefaultSubscription(undefined, {
      tokenProvider: async () => 'default-chain-token',
      fetch: request as typeof fetch,
    })).resolves.toEqual({ authMode: 'default', subscriptionId: SUBSCRIPTION_ID });
    expect(request).toHaveBeenCalledWith(
      'https://management.azure.com/subscriptions?api-version=2022-12-01',
      { headers: { Accept: 'application/json', Authorization: 'Bearer default-chain-token' } }
    );
  });

  it('requires an explicit subscription when the default identity can access several', async () => {
    await expect(resolveAzureDefaultSubscription(undefined, {
      tokenProvider: async () => 'default-chain-token',
      fetch: (async () => jsonResponse({ value: [
        { subscriptionId: SUBSCRIPTION_ID, state: 'Enabled' },
        { subscriptionId: '55555555-5555-4555-8555-555555555555', state: 'Enabled' },
      ] })) as typeof fetch,
    })).rejects.toThrow(/multiple subscriptions/);
  });

  it('uses client credentials and follows every exact-collection page', async () => {
    const firstId = `${COLLECTION}/one`;
    const secondId = `${COLLECTION}/two`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [{ id: firstId }],
        nextLink:
          `https://management.azure.com${COLLECTION}`
          + '?api-version=2025-08-01&$skiptoken=next',
      }))
      .mockResolvedValueOnce(jsonResponse({
        value: [{ id: secondId }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AzureResourceManagerClient(credentials);
    await expect(
      client.listAll<{ id: string }>(COLLECTION, '2025-08-01')
    ).resolves.toEqual([{ id: firstId }, { id: secondId }]);
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain(
      'grant_type=client_credentials'
    );
    expect(fetchMock.mock.calls[2]![0]).toContain('$skiptoken=next');
  });

  it('rejects off-origin and same-resource-group collection escapes', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [],
        nextLink: 'https://example.invalid/steal-token',
      })));
    const offOrigin = new AzureResourceManagerClient(credentials);
    await expect(
      offOrigin.listAll(COLLECTION, '2025-08-01')
    ).rejects.toThrow(/left management\.azure\.com/);

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [],
        nextLink:
          `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}`
          + `/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Example/other`
          + '?api-version=2025-08-01',
      })));
    const otherCollection = new AzureResourceManagerClient(credentials);
    await expect(
      otherCollection.listAll(COLLECTION, '2025-08-01')
    ).rejects.toThrow(/left the observed collection/);
  });

  it('blocks duplicate durable identities across complete pagination', async () => {
    const duplicate = `${COLLECTION}/one`;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        value: [{ id: duplicate }, { id: duplicate.toUpperCase() }],
      })));

    const client = new AzureResourceManagerClient(credentials);
    await expect(
      client.listAll(COLLECTION, '2025-08-01')
    ).rejects.toThrow(/duplicate resource identity/);
  });

  it('treats only 404 as absence and never includes response bodies in errors', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'missing' }, 404)));
    const absent = new AzureResourceManagerClient(credentials);
    await expect(
      absent.getNullable(`${COLLECTION}/one`, '2025-08-01')
    ).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        error: 'provider-echoed-secret-never-output',
      }, 403)));
    const unknown = new AzureResourceManagerClient(credentials);
    const error = await unknown
      .getNullable(`${COLLECTION}/one`, '2025-08-01')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AzureResourceManagerError);
    expect(error).toMatchObject({ status: 403 });
    expect(String(error)).not.toContain(
      'provider-echoed-secret-never-output'
    );
  });

  it('rejects durable ids outside the configured scope before auth', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new AzureResourceManagerClient({ ...credentials, resourceGroup: RESOURCE_GROUP });

    expect(() => client.parseResourceId(
      `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/other`
        + '/providers/Microsoft.Example/resources/one',
      'Microsoft.Example',
      'resources'
    )).toThrow(/outside the configured subscription\/resource group/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies subscription-scoped clients and exposes the service-principal identity', async () => {
    const subscriptionCredentials = {
      tenantId: credentials.tenantId,
      subscriptionId: SUBSCRIPTION_ID,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(principalTokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: `/subscriptions/${SUBSCRIPTION_ID}` }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AzureResourceManagerClient(subscriptionCredentials);

    await expect(client.verifySubscription()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}?api-version=2022-12-01`
    );
    await expect(client.servicePrincipalId()).resolves.toBe(
      '44444444-4444-4444-8444-444444444444'
    );
  });

  it('waits for trusted long-running operations and re-observes updated resources', async () => {
    const resource = `${COLLECTION}/one`;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, {
        status: 202,
        headers: {
          'azure-asyncoperation': 'https://management.azure.com/operations/one',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'Succeeded' }))
      .mockResolvedValueOnce(jsonResponse({ id: resource, properties: { provisioningState: 'Succeeded' } })));
    const client = new AzureResourceManagerClient(credentials);

    await expect(client.request('PATCH', resource, '2025-08-01', { properties: {} }))
      .resolves.toMatchObject({ id: resource });
  });
});
