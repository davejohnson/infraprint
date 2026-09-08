import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { CloudflareZone } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { CloudflareCredentials } from '../entities/connection.entity.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { dnsZoneScopeForDomain, normalizeDomainName } from './domain-scope.js';

const connectionRepo = new ConnectionRepository();

function adapterFromConnection(connection: NonNullable<ReturnType<ConnectionRepository['findById']>>): { adapter: CloudflareAdapter; scope: string | null } {
  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
  adapter.connect(credentials);

  return { adapter, scope: connection.scope };
}

/**
 * Get a Cloudflare adapter, using scoped connection if available.
 * @param scopeHint - Optional domain hint (e.g., "example.com") for finding scoped tokens
 */
export function getCloudflareAdapter(scopeHint?: string): { adapter: CloudflareAdapter; scope: string | null } | { error: string } {
  return getCloudflareAdapterFromHints(scopeHint ? [scopeHint] : []);
}

/** Resolve the first exact, wildcard, or global Cloudflare connection matching the ordered scope hints. */
export function getCloudflareAdapterFromHints(scopeHints: string[]): { adapter: CloudflareAdapter; scope: string | null } | { error: string } {
  const connection = connectionRepo.findBestMatchFromHints('cloudflare', scopeHints);
  if (!connection) {
    return { error: `No Cloudflare connection found. ${formatConnectionGuidance('cloudflare', { scope: scopeHints[0] })}` };
  }

  return adapterFromConnection(connection);
}

export async function findCloudflareZone(adapter: CloudflareAdapter, domain: string): Promise<CloudflareZone | null> {
  const normalizedDomain = normalizeDomainName(domain);
  const direct = await adapter.findZoneByName(normalizedDomain);
  const zoneScope = dnsZoneScopeForDomain(normalizedDomain);
  return direct ?? (zoneScope === normalizedDomain ? null : adapter.findZoneByName(zoneScope));
}

/**
 * Get any verified Cloudflare adapter. Useful for provider-level operations
 * like listing zones when the user only has scoped domain connections.
 */
export function getAnyVerifiedCloudflareAdapter(): { adapter: CloudflareAdapter; scope: string | null } | { error: string } {
  const connection = connectionRepo
    .findAllByProvider('cloudflare')
    .find((candidate) => candidate.status === 'verified');
  if (!connection) {
    return { error: `No verified Cloudflare connection found. Scoped domain connections are fine for listing zones visible to that token. ${formatConnectionGuidance('cloudflare')}` };
  }
  return adapterFromConnection(connection);
}
