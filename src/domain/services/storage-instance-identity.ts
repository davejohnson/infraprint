import type { StorageContext } from '../ports/storage.port.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storageContext(value: unknown): StorageContext | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fields = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}

/**
 * Place the provider-native context beside each durable storage resource id.
 * Legacy bindings remain valid and are enriched when their provider context
 * is known.
 */
export function withStorageInstanceScopes(
  storage: Record<string, unknown>,
  providerContexts: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(storage).map(([name, value]) => {
    const binding = asRecord(value);
    const provider = typeof binding?.provider === 'string' ? binding.provider : undefined;
    // A stored scope is part of the resource identity. A later connection or
    // provider-context change must not silently retarget the same externalId.
    const instanceScope = storageContext(binding?.instanceScope)
      ?? (provider ? storageContext(providerContexts[provider]) : undefined);
    return [name, binding && instanceScope ? { ...binding, instanceScope } : value];
  }));
}
