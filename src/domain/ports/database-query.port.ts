/**
 * Provider-neutral contract for the bounded operational SQL command.
 *
 * Managed database lifecycle adapters use `database.port.ts`; this smaller
 * port represents an already-resolved PostgreSQL endpoint and keeps command
 * declarations from constructing a concrete provider adapter directly.
 */
export interface DatabaseQueryCredentials {
  connectionUrl: string;
  type?: 'postgres';
}

export interface DatabaseQueryOptions {
  /** Enforce PostgreSQL transaction-level read-only mode. */
  readOnly?: boolean;
  /** Reject results larger than this row count. */
  maxRows?: number;
  /** Reject model-visible results larger than this many UTF-8 bytes. */
  maxResponseBytes?: number;
  /** PostgreSQL statement timeout. The adapter owns the hard cap. */
  statementTimeoutMs?: number;
}

export interface DatabaseQueryResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  fields?: Array<{ name: string; dataType: string }>;
  error?: string;
  warning?: string;
}

export interface IDatabaseQueryAdapter {
  query(
    sql: string,
    params?: unknown[],
    options?: DatabaseQueryOptions
  ): Promise<DatabaseQueryResult>;
}

export function supportsDatabaseQuery(value: unknown): value is IDatabaseQueryAdapter {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Partial<IDatabaseQueryAdapter>).query === 'function';
}
