import { createHash } from 'crypto';

// Binding metadata is useful for stale-plan checks, but connection material
// must never enter a persisted plan — not even as a guessable password hash.
// Normalize key spelling before applying the same broad secret categories used
// by repository binding exports, plus URL/URI/DSN credentials.
const SENSITIVE_BINDING_KEY_PATTERN = /(?:secret|token|password|passphrase|privatekey|apikey|accesskey|credential|connectionstring|connectionurl|databaseurl|databaseprivateurl|privateurl|pooledurl|directurl|dsn$|uri$|url$)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalSanitizedValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .map(canonicalSanitizedValue)
      .filter((item) => item !== undefined);
  }
  const record = asRecord(value);
  if (!record) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '');
    if (SENSITIVE_BINDING_KEY_PATTERN.test(normalizedKey)) continue;
    const sanitizedChild = canonicalSanitizedValue(child);
    if (sanitizedChild !== undefined) sanitized[key] = sanitizedChild;
  }
  return sanitized;
}

/**
 * Stable, secret-free fingerprint of all provider binding metadata that an
 * adapter may use while destroying a resource. This intentionally includes
 * secondary ids and ownership flags (for example volumeId or
 * securityGroupManagedByHypervibe), while omitting credentials and URLs.
 */
export function bindingIdentityFingerprint(bindings: unknown): string {
  const sanitized = canonicalSanitizedValue(bindings) ?? {};
  return createHash('sha256').update(JSON.stringify(sanitized), 'utf8').digest('hex');
}
