import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareAdapter } from '../cloudflare.adapter.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';

function cfResponse<T>(result: T, init?: {
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  status?: number;
  resultInfo?: { page: number; per_page: number; total_count: number; total_pages: number };
}) {
  return Response.json({
    success: init?.success ?? true,
    errors: init?.errors ?? [],
    messages: [],
    result,
    ...(init?.resultInfo ? { result_info: init.resultInfo } : {}),
  }, { status: init?.status ?? 200 });
}

function cfDnsRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'record-1',
    zone_id: 'zone-1',
    zone_name: 'hlspropertycare.com',
    name: 'staging.hlspropertycare.com',
    type: 'CNAME',
    content: 'old-target.up.railway.app',
    proxied: false,
    proxiable: true,
    ttl: 1,
    created_on: '2026-07-07T00:00:00.000Z',
    modified_on: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('CloudflareAdapter.findZoneByName', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks ambiguous zone identities instead of selecting the first account match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse([
      { id: 'zone-1', name: 'example.com', account: { id: 'account-1' } },
      { id: 'zone-2', name: 'example.com', account: { id: 'account-2' } },
    ])));
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    await expect(adapter.findZoneByName('example.com'))
      .rejects.toThrow('Multiple Cloudflare zones match example.com');
  });
});

describe('Cloudflare provider inspection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an exact missing DNS name as absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/zones?name=')) {
        return cfResponse([{ id: 'zone-1', name: 'example.com' }]);
      }
      if (url.includes('/zones/zone-1/dns_records')) {
        return cfResponse([cfDnsRecord({ name: 'other.example.com' })]);
      }
      throw new Error(`unexpected url: ${url}`);
    }));
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    await expect(providerRegistry.get('cloudflare')!.inspection!.inspect(adapter, {
      resource: 'dns',
      scope: 'example.com',
      name: 'missing.example.com',
      limit: 25,
    })).resolves.toMatchObject({
      observation: 'absent',
      name: 'missing.example.com',
      records: [],
      truncated: false,
      partial: false,
    });
  });

  it('hard-bounds account inventory and reports truncation', async () => {
    const adapter = new CloudflareAdapter();
    vi.spyOn(adapter, 'listAccounts').mockResolvedValue([
      { id: 'account-1', name: 'One' },
      { id: 'account-2', name: 'Two' },
    ]);

    await expect(providerRegistry.get('cloudflare')!.inspection!.inspect(adapter, {
      resource: 'account',
      limit: 1,
    })).resolves.toMatchObject({
      observation: 'present',
      accounts: [{ id: 'account-1' }],
      truncated: true,
      partial: true,
    });
  });

  it('hard-bounds email-routing rules and reports truncation', async () => {
    const adapter = new CloudflareAdapter();
    vi.spyOn(adapter, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: [],
    });
    vi.spyOn(adapter, 'getEmailRoutingSettings').mockResolvedValue({
      id: 'settings-1',
      enabled: true,
      name: 'example.com',
    });
    vi.spyOn(adapter, 'getEmailRoutingDnsSettings').mockResolvedValue({ record: [] });
    vi.spyOn(adapter, 'listEmailRoutingRules').mockResolvedValue([
      { id: 'rule-1', name: 'One', enabled: true, actions: [], matchers: [] },
      { id: 'rule-2', name: 'Two', enabled: true, actions: [], matchers: [] },
    ]);

    await expect(providerRegistry.get('cloudflare')!.inspection!.inspect(adapter, {
      resource: 'email-routing',
      scope: 'example.com',
      limit: 1,
    })).resolves.toMatchObject({
      observation: 'present',
      rules: [{ id: 'rule-1' }],
      truncated: true,
      partial: true,
    });
  });
});

describe('CloudflareAdapter maintenance edge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a bound static 503 edge and verifies its public marker', async () => {
    const hostname = 'production.example.com';
    let routes: Array<{ id: string; pattern: string; script: string }> = [];
    let uploadedScript = '';
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_maintenance', accountId: 'account-1' });
    vi.spyOn(adapter, 'resolveLoadBalancerScope').mockResolvedValue({
      accountId: 'account-1',
      zoneId: 'zone-1',
    });
    const contentHash = adapter.maintenanceContentHash(hostname);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/workers/routes') && method === 'GET') return cfResponse(routes);
      if (url.includes('/workers/scripts/') && method === 'PUT') {
        uploadedScript = String(init?.body ?? '');
        return new Response('', { status: 200 });
      }
      if (url.includes('/workers/routes') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { pattern: string; script: string };
        routes = [{ id: 'route-1', ...body }];
        return cfResponse(routes[0]);
      }
      if (url.startsWith(`https://${hostname}/`)) {
        return new Response('Temporarily unavailable', {
          status: 503,
          headers: { 'X-Hypervibe-Maintenance': contentHash },
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const ensured = await adapter.ensureMaintenanceEdge(hostname, contentHash);
    const binding = ensured.data?.binding;

    expect(ensured).toMatchObject({ success: true, data: { applied: 1, skipped: 0 } });
    expect(uploadedScript).toContain('status:503');
    expect(uploadedScript).toContain(contentHash);
    expect(binding).toMatchObject({ hostname, routeId: 'route-1', contentHash });
    await expect(adapter.observeMaintenanceEdge(hostname, binding as never)).resolves.toMatchObject({
      state: 'active',
      markerVerified: true,
    });
  });

  it('does not replace an existing unrelated Worker route', async () => {
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_maintenance', accountId: 'account-1' });
    vi.spyOn(adapter, 'resolveLoadBalancerScope').mockResolvedValue({
      accountId: 'account-1',
      zoneId: 'zone-1',
    });
    const fetchMock = vi.fn(async () => cfResponse([
      { id: 'route-existing', pattern: 'production.example.com/*', script: 'customer-worker' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.ensureMaintenanceEdge(
      'production.example.com',
      adapter.maintenanceContentHash('production.example.com')
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('different Cloudflare Worker route'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('CloudflareAdapter.verify', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies a valid token even when the scoped zone is not found yet', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse({ id: 'token-1' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([]);
      }
      if (href.includes('/zones?page=')) {
        return cfResponse([]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'valid-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('could not find a Cloudflare zone');
  });

  it('normalizes copied Authorization header values before calling Cloudflare', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => cfResponse({ id: 'token-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: ' "Bearer cf-real-token" ' });

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cf-real-token');
  });

  it('verifies account API tokens through the account endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        return cfResponse({ id: 'token-1', status: 'active' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([{ id: 'zone-1', name: 'apreskeys.com', status: 'active', paused: false, type: 'full', name_servers: [] }]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_123456789012345678901234567890123456789012345678', accountId: 'account-1' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.zones).toEqual(['apreskeys.com']);
    expect(result.warning).toContain('Account API Token verified');
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/user/tokens/verify'), expect.anything());
  });

  it('verifies a separate user Registrar token when present', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        expect(auth).toBe('Bearer cfat_dns');
        return cfResponse({ id: 'dns-token', status: 'active' });
      }
      if (href.endsWith('/user/tokens/verify')) {
        expect(auth).toBe('Bearer cfut_registrar');
        return cfResponse({ id: 'registrar-token' });
      }
      if (href.includes('/zones?name=')) {
        expect(auth).toBe('Bearer cfat_dns');
        return cfResponse([{ id: 'zone-1', name: 'apreskeys.com', status: 'active', paused: false, type: 'full', name_servers: [] }]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1', registrarApiToken: 'cfut_registrar' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('Account API Token verified for DNS');
  });

  it('rejects account API tokens supplied as registrarApiToken', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        return cfResponse({ id: 'dns-token', status: 'active' });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1', registrarApiToken: 'cfat_registrar' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires a Cloudflare User API Token');
    expect(result.error).toContain('registrarApiToken');
    expect(result.error).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(result.error).toContain('permissionGroupKeys=');
  });

  it('falls back to account token verification for unprefixed tokens when accountId is present', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse(null, {
          success: false,
          status: 401,
          errors: [{ code: 1000, message: 'Invalid API Token' }],
        });
      }
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        return cfResponse({ id: 'token-1', status: 'active' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([]);
      }
      if (href.includes('/zones?page=')) {
        return cfResponse([]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'legacyAccountTokenValueWithoutPrefix', accountId: 'account-1' });

    const result = await adapter.verify('invoiceperfect.com');

    expect(result.success).toBe(true);
    expect(result.tokenKind).toBe('account');
    expect(result.warning).toContain('Account API Token verified');
  });

  it('explains that account API tokens need accountId', async () => {
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_123456789012345678901234567890123456789012345678' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Manage Account > Account API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(result.error).toContain('My Profile > API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(result.error).toContain('permissionGroupKeys=');
    expect(result.error).toContain('cfat_');
    expect(result.error).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(result.error).toContain('Zone > Zone > Read');
    expect(result.error).toContain('Zone > Zone Settings > Read or Edit');
    expect(result.error).toContain('Zone > DNS > Edit/Write');
  });

  it('verifies a valid token even when zone access cannot be confirmed', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse({ id: 'token-1' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([], {
          success: false,
          status: 403,
          errors: [{ code: 9109, message: 'Missing permission to list zones' }],
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'valid-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('could not confirm Cloudflare zone access');
  });

  it('still rejects invalid API tokens', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse(null, {
          success: false,
          status: 401,
          errors: [{ code: 10000, message: 'Authentication error' }],
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'bad-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Manage Account > Account API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(result.error).toContain('My Profile > API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(result.error).toContain('cfat_');
    expect(result.error).toContain('cfut_');
    expect(result.error).toContain('Zone > Zone > Read');
    expect(result.error).toContain('Zone > Zone Settings > Read or Edit');
    expect(result.error).toContain('Zone > DNS > Edit/Write');
  });
});

describe('CloudflareAdapter.upsertDnsRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates a stale existing record instead of creating a duplicate', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        return cfResponse([cfDnsRecord()]);
      }
      if (href.includes('/dns_records/record-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          content: 'binlu2a8.up.railway.app',
          proxied: false,
        });
        return cfResponse(cfDnsRecord({
          content: 'binlu2a8.up.railway.app',
          modified_on: '2026-07-07T00:01:00.000Z',
        }));
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      'staging.hlspropertycare.com',
      'CNAME',
      'binlu2a8.up.railway.app',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.content).toBe('binlu2a8.up.railway.app');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'PATCH']);
  });

  it('treats an equivalent existing CNAME as converged without writing', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        return cfResponse([cfDnsRecord({
          name: 'Staging.HLSPropertyCare.com.',
          content: 'BINLU2A8.UP.RAILWAY.APP.',
        })]);
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      'staging.hlspropertycare.com.',
      'CNAME',
      'binlu2a8.up.railway.app',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.id).toBe('record-1');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recognizes a relative desired name when Cloudflare omits zone_name', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        return cfResponse([cfDnsRecord({
          zone_name: undefined,
          name: '_railway-verify.apreskeys.com',
          type: 'TXT',
          content: 'railway-verify=token',
        })]);
      }
      if (href.endsWith('/zones/zone-1')) {
        return cfResponse({
          id: 'zone-1',
          name: 'apreskeys.com',
          status: 'active',
          paused: false,
          type: 'full',
          name_servers: [],
        });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      '_railway-verify',
      'TXT',
      'railway-verify=token',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.id).toBe('record-1');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'GET']);
  });

  it('recovers when a create races an existing DNS record', async () => {
    let listCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        listCount += 1;
        return cfResponse(listCount === 1 ? [] : [cfDnsRecord()]);
      }
      if (href.endsWith('/dns_records') && init?.method === 'POST') {
        return cfResponse(null, {
          success: false,
          status: 409,
          errors: [{ code: 81058, message: 'An identical record already exists.' }],
        });
      }
      if (href.includes('/dns_records/record-1') && init?.method === 'PATCH') {
        return cfResponse(cfDnsRecord({
          content: 'binlu2a8.up.railway.app',
          modified_on: '2026-07-07T00:01:00.000Z',
        }));
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      'staging',
      'CNAME',
      'binlu2a8.up.railway.app',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.content).toBe('binlu2a8.up.railway.app');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET', 'PATCH']);
  });

  it('blocks instead of updating an arbitrary duplicate DNS identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse([
      cfDnsRecord({ id: 'record-1' }),
      cfDnsRecord({ id: 'record-2', content: 'other-target.up.railway.app' }),
    ])));
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    await expect(adapter.upsertDnsRecord(
      'zone-1',
      'staging.hlspropertycare.com',
      'CNAME',
      'new-target.up.railway.app'
    )).rejects.toThrow('Multiple Cloudflare CNAME records match');
  });
});

describe('CloudflareAdapter.deleteDnsRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats an already-absent record as success and verifies absence', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return cfResponse(null, {
          success: false,
          status: 404,
          errors: [{ code: 81044, message: 'DNS record not found.' }],
        });
      }
      return cfResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    await expect(adapter.deleteDnsRecord('zone-1', 'missing-record'))
      .resolves.toEqual({ id: 'missing-record' });
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET'))
      .toEqual(['DELETE', 'GET']);
  });
});

describe('CloudflareAdapter Registrar token routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses registrarApiToken for Registrar calls and apiToken for DNS calls', async () => {
    const authorizations: Array<{ url: string; authorization?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      authorizations.push({
        url: href,
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (href.includes('/registrar/domain-check')) {
        return cfResponse({ domains: [{ name: 'apreskeys.com', registrable: true }] });
      }
      if (href.includes('/registrar/registrations') && init?.method === 'POST') {
        return cfResponse({
          completed: false,
          created_at: '2026-06-15T00:00:00.000Z',
          updated_at: '2026-06-15T00:00:01.000Z',
          links: { self: '/status' },
          state: 'in_progress',
        });
      }
      if (href.includes('/dns_records')) {
        return cfResponse({
          id: 'record-1',
          zone_id: 'zone-1',
          zone_name: 'apreskeys.com',
          name: 'apreskeys.com',
          type: 'CNAME',
          content: 'target.example.com',
          proxied: false,
          proxiable: true,
          ttl: 1,
          created_on: '2026-06-15T00:00:00.000Z',
          modified_on: '2026-06-15T00:00:00.000Z',
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1', registrarApiToken: 'cfut_registrar' });

    await adapter.checkRegistrarDomains('account-1', ['apreskeys.com']);
    await adapter.createRegistrarRegistration('account-1', { domainName: 'apreskeys.com', years: 1 });
    await adapter.createDnsRecord('zone-1', { type: 'CNAME', name: 'apreskeys.com', content: 'target.example.com' });

    expect(authorizations).toEqual([
      expect.objectContaining({ authorization: 'Bearer cfut_registrar' }),
      expect.objectContaining({ authorization: 'Bearer cfut_registrar' }),
      expect.objectContaining({ authorization: 'Bearer cfat_dns' }),
    ]);
  });

  it('uses a single user apiToken for Registrar calls when no registrarApiToken is configured', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer cfut_combined');
      if (href.includes('/registrar/domain-check')) {
        return cfResponse({ domains: [{ name: 'apreskeys.com', registrable: true }] });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_combined', accountId: 'account-1' });

    await adapter.checkRegistrarDomains('account-1', ['apreskeys.com']);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails Registrar calls before calling Cloudflare when only an account apiToken is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1' });

    await expect(adapter.checkRegistrarDomains('account-1', ['apreskeys.com']))
      .rejects.toThrow(/registrarApiToken\/CLOUDFLARE_REGISTRAR_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CloudflareAdapter load-balancer lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates an origin pool with HTTPS host-header overrides', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      expect(href).toContain('/accounts/account-1/load_balancers/pools');
      const method = init?.method ?? 'GET';
      const body = method === 'POST'
        ? JSON.parse(String(init?.body)) as Record<string, unknown>
        : {
            name: 'hv-production-pool',
            monitor: 'monitor-1',
            enabled: true,
            origin_steering: { policy: 'random' },
            origins: [
              { name: 'web-a', address: 'a.up.railway.app', enabled: true, header: { Host: ['a.up.railway.app'] } },
              { name: 'web-b', address: 'b.up.railway.app', enabled: true, header: { Host: ['b.up.railway.app'] } },
            ],
          };
      if (method === 'POST') {
        expect(body).toMatchObject({
          name: 'hv-production-pool',
          monitor: 'monitor-1',
          enabled: true,
          origin_steering: { policy: 'random' },
          origins: [
            {
              name: 'web-a', address: 'a.up.railway.app', enabled: true,
              header: { Host: ['a.up.railway.app'] },
            },
            {
              name: 'web-b', address: 'b.up.railway.app', enabled: true,
              header: { Host: ['b.up.railway.app'] },
            },
          ],
        });
      }
      return cfResponse({
        id: 'pool-1', name: 'hv-production-pool', monitor: 'monitor-1', enabled: true,
        origin_steering: { policy: 'random' }, origins: (body.origins as unknown[]),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    const result = await adapter.ensurePool('account-1', {
      name: 'hv-production-pool', monitorId: 'monitor-1', enabled: true, steering: 'random',
      origins: [
        { name: 'web-a', address: 'a.up.railway.app', hostHeader: 'a.up.railway.app', enabled: true },
        { name: 'web-b', address: 'b.up.railway.app', hostHeader: 'b.up.railway.app', enabled: true },
      ],
    });

    expect(result.created).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.resource).toMatchObject({ id: 'pool-1', monitorId: 'monitor-1', steering: 'random' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the acknowledged id without claiming success when exact read-back stays unknown', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDFLARE_LB_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_CLOUDFLARE_LB_VERIFY_INTERVAL_MS', '0');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(cfResponse({
        id: 'monitor-acknowledged',
        description: 'hv-production-monitor',
        type: 'https',
        path: '/health',
        interval: 60,
        timeout: 5,
        expected_codes: '200-399',
        follow_redirects: true,
      }))
      .mockResolvedValueOnce(cfResponse(null, {
        success: false,
        status: 503,
        errors: [{ code: 1001, message: 'temporarily unavailable' }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    await expect(adapter.ensureMonitor('account-1', {
      name: 'hv-production-monitor',
      type: 'https',
      path: '/health',
      intervalSeconds: 60,
      timeoutSeconds: 5,
      expectedCodes: '200-399',
      followRedirects: true,
    })).resolves.toMatchObject({
      created: true,
      verified: false,
      resource: { id: 'monitor-acknowledged' },
      verificationError: expect.stringContaining('temporarily unavailable'),
    });
  });

  it('recovers and verifies a monitor id when the create response is lost after commit', async () => {
    vi.stubEnv('HYPERVIBE_CLOUDFLARE_LB_VERIFY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_CLOUDFLARE_LB_VERIFY_INTERVAL_MS', '0');
    const monitor = {
      id: 'monitor-recovered',
      description: 'hv-production-monitor',
      type: 'https',
      path: '/health',
      interval: 60,
      timeout: 5,
      expected_codes: '200-399',
      follow_redirects: true,
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const pathname = new URL(href).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'POST') throw new Error('connection closed after request transmission');
      if (pathname.endsWith('/load_balancers/monitors')) return cfResponse([monitor]);
      if (pathname.endsWith('/load_balancers/monitors/monitor-recovered')) return cfResponse(monitor);
      throw new Error(`unexpected request: ${method} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    const result = await adapter.ensureMonitor('account-1', {
      name: 'hv-production-monitor',
      type: 'https',
      path: '/health',
      intervalSeconds: 60,
      timeoutSeconds: 5,
      expectedCodes: '200-399',
      followRedirects: true,
    });

    expect(result).toMatchObject({
      created: true,
      verified: true,
      resource: { id: 'monitor-recovered' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats only provider-confirmed 404 as absence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(cfResponse(null, {
        success: false, status: 404, errors: [{ code: 1000, message: 'not found' }],
      }))
      .mockResolvedValueOnce(cfResponse(null, {
        success: false, status: 403, errors: [{ code: 1001, message: 'forbidden' }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    await expect(adapter.getMonitor('account-1', 'missing')).resolves.toBeNull();
    await expect(adapter.getMonitor('account-1', 'unknown')).rejects.toThrow('forbidden');
  });

  it('reads every result page before deciding a named pool is absent', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const page = new URL(String(url)).searchParams.get('page');
      return page === '1'
        ? cfResponse([{ id: 'pool-other', name: 'other' }], {
          resultInfo: { page: 1, per_page: 100, total_count: 2, total_pages: 2 },
        })
        : cfResponse([{ id: 'pool-match', name: 'wanted' }], {
          resultInfo: { page: 2, per_page: 100, total_count: 2, total_pages: 2 },
        });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    await expect(adapter.findPoolsByName('account-1', 'wanted')).resolves.toEqual([
      expect.objectContaining({ id: 'pool-match', name: 'wanted' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not treat a full page without pagination metadata as complete', async () => {
    const fetchMock = vi.fn(async () => cfResponse(
      Array.from({ length: 100 }, (_, index) => ({
        id: `pool-${index}`,
        name: `unrelated-${index}`,
      }))
    ));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    await expect(adapter.findPoolsByName('account-1', 'wanted')).rejects.toThrow(
      /full page without pagination metadata/
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('honors HTTP failure status even if a malformed body claims success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => cfResponse({
      id: 'monitor-forbidden',
      description: 'forbidden',
    }, { status: 403, success: true })));
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    await expect(adapter.getMonitor('account-1', 'monitor-forbidden'))
      .rejects.toThrow(/HTTP 403/);
  });

  it('verifies terminal absence after deleting the public load balancer', async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') return cfResponse({ id: 'lb-1' });
      return cfResponse(null, {
        success: false, status: 404, errors: [{ code: 1000, message: 'not found' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_load_balancer', accountId: 'account-1' });

    await expect(adapter.deleteLoadBalancer('zone-1', 'lb-1')).resolves.toBeUndefined();
    expect(methods).toEqual(['DELETE', 'GET']);
  });
});
