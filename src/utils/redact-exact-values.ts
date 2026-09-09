const REDACTED = '[redacted]';

function redactString(value: string, exactValues: string[]): string {
  return exactValues.reduce(
    (redacted, exactValue) => redacted.replaceAll(exactValue, REDACTED),
    value
  );
}

/**
 * Clone a provider result while scrubbing every occurrence of the exact values
 * supplied to the provider. Provider errors may echo request inputs in otherwise
 * innocuous message or metadata fields that key- or format-based redaction misses.
 */
export function redactExactValues<T>(value: T, values: Iterable<string>): T {
  const exactValues = [...new Set(values)]
    .filter((entry) => entry.length > 0 && entry !== REDACTED)
    .sort((left, right) => right.length - left.length);

  if (exactValues.length === 0) return value;

  const seen = new WeakSet<object>();
  const redact = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redactString(entry, exactValues);
    if (entry === null || typeof entry !== 'object') return entry;
    if (entry instanceof Date) return entry;
    if (seen.has(entry)) return REDACTED;
    seen.add(entry);

    if (Array.isArray(entry)) {
      const result = entry.map(redact);
      seen.delete(entry);
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      result[redactString(key, exactValues)] = redact(nested);
    }
    seen.delete(entry);
    return result;
  };

  return redact(value) as T;
}
