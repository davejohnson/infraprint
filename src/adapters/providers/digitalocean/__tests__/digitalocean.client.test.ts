import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanClient } from '../digitalocean.client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DigitalOceanClient exact observation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['app', (client: DigitalOceanClient) => client.getApp('app-1')],
    ['database', (client: DigitalOceanClient) => client.getDatabaseCluster('database-1')],
  ])('does not convert a malformed successful %s lookup into absence', async (_resource, observe) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const client = new DigitalOceanClient('dop_v1_test-token');

    await expect(observe(client)).rejects.toThrow('absence was not confirmed');
  });

  it.each([
    ['app', (client: DigitalOceanClient) => client.getApp('app-1')],
    ['database', (client: DigitalOceanClient) => client.getDatabaseCluster('database-1')],
  ])('returns null only for a provider-confirmed missing %s', async (_resource, observe) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'not found' }, 404)));
    const client = new DigitalOceanClient('dop_v1_test-token');

    await expect(observe(client)).resolves.toBeNull();
  });

  it('rejects a container registry returned for the wrong exact name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      registry: { name: 'somebody-elses-registry' },
    })));
    const client = new DigitalOceanClient('dop_v1_test-token');

    await expect(client.getContainerRegistry('hypervibe-registry'))
      .rejects.toThrow('for exact registry lookup');
  });
});
