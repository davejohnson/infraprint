import pg from 'pg';
import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import type {
  DatabaseQueryOptions,
  DatabaseQueryResult,
  IDatabaseQueryAdapter,
} from '../../../domain/ports/database-query.port.js';
import {
  analyzeSqlQuery,
  isMultiStatementQuery,
  isMutationQuery,
} from '../../../domain/services/sql-query-analysis.js';

export { stripSqlLiteralsAndComments } from '../../../domain/services/sql-query-analysis.js';

const { Client } = pg;

// Credentials schema for database connections
export const DatabaseCredentialsSchema = z.object({
  connectionUrl: z.string().min(1, 'Connection URL is required'),
  type: z.enum(['postgres']).optional().describe('Database type (auto-detected from URL if not specified)'),
});

export type DatabaseCredentials = z.infer<typeof DatabaseCredentialsSchema>;

/** Compatibility aliases for existing adapter consumers. */
export type QueryResult = DatabaseQueryResult;
export type QueryOptions = DatabaseQueryOptions;

export const DEFAULT_MAX_QUERY_ROWS = 500;
export const DEFAULT_MAX_QUERY_RESPONSE_BYTES = 512 * 1024;
export const MAX_QUERY_STATEMENT_TIMEOUT_MS = 30_000;

export class DatabaseAdapter implements IDatabaseQueryAdapter {
  private credentials: DatabaseCredentials | null = null;

  connect(credentials: DatabaseCredentials): void {
    this.credentials = credentials;
  }

  /**
   * Detect database type from connection URL
   */
  getDbType(): 'postgres' | 'unknown' {
    if (!this.credentials) return 'unknown';

    if (this.credentials.type) {
      return this.credentials.type;
    }

    const url = this.credentials.connectionUrl.toLowerCase();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      return 'postgres';
    }
    return 'unknown';
  }

  /**
   * Check if a query is a mutation (INSERT, UPDATE, DELETE, etc.)
   * Comments and string literals are stripped first so keywords cannot be
   * hidden behind a leading comment or inside a data-modifying CTE.
   */
  isMutationQuery(sql: string): boolean {
    return isMutationQuery(sql);
  }

  /**
   * Check if SQL contains more than one statement (e.g. "SELECT 1; DROP TABLE x").
   */
  isMultiStatement(sql: string): boolean {
    return isMultiStatementQuery(sql);
  }

  /**
   * Analyze a query and return warnings
   */
  analyzeQuery(sql: string): { isMutation: boolean; multiStatement: boolean; warnings: string[] } {
    return analyzeSqlQuery(sql);
  }

  /**
   * Execute a SQL query against Postgres
   */
  async queryPostgres(sql: string, params?: unknown[], options: QueryOptions = {}): Promise<QueryResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const statementTimeoutMs = Math.min(
      MAX_QUERY_STATEMENT_TIMEOUT_MS,
      Math.max(1, options.statementTimeoutMs ?? MAX_QUERY_STATEMENT_TIMEOUT_MS)
    );
    const client = new Client({
      connectionString: this.credentials.connectionUrl,
      connectionTimeoutMillis: 10000,
      statement_timeout: statementTimeoutMs,
      query_timeout: statementTimeoutMs,
    });

    let transactionStarted = false;
    try {
      await client.connect();
      if (options.readOnly) {
        await client.query('BEGIN READ ONLY');
        transactionStarted = true;
      }
      const result = await client.query(sql, params);

      const maxRows = options.maxRows ?? DEFAULT_MAX_QUERY_ROWS;
      if (result.rows.length > maxRows) {
        if (transactionStarted) await client.query('ROLLBACK');
        transactionStarted = false;
        return {
          success: false,
          rowCount: result.rowCount ?? result.rows.length,
          error: `Query result exceeded the ${maxRows}-row diagnostic limit. Add a narrower WHERE clause or LIMIT.`,
        };
      }

      const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_QUERY_RESPONSE_BYTES;
      const responseBytes = Buffer.byteLength(JSON.stringify(result.rows), 'utf8');
      if (responseBytes > maxResponseBytes) {
        if (transactionStarted) await client.query('ROLLBACK');
        transactionStarted = false;
        return {
          success: false,
          rowCount: result.rowCount ?? result.rows.length,
          error: `Query result exceeded the ${maxResponseBytes}-byte diagnostic response limit. Select fewer or smaller columns.`,
        };
      }

      if (transactionStarted) {
        await client.query('COMMIT');
        transactionStarted = false;
      }

      return {
        success: true,
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
        fields: result.fields?.map(f => ({
          name: f.name,
          dataType: String(f.dataTypeID),
        })),
      };
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch(() => {});
        transactionStarted = false;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Execute a query (routes to appropriate database type)
   */
  async query(sql: string, params?: unknown[], options: QueryOptions = {}): Promise<QueryResult> {
    const dbType = this.getDbType();

    switch (dbType) {
      case 'postgres':
        return this.queryPostgres(sql, params, options);
      default:
        return { success: false, error: `Unknown database type. URL should start with postgres://` };
    }
  }

  /**
   * Verify the connection works
   */
  async verify(): Promise<{ success: boolean; error?: string; version?: string }> {
    const dbType = this.getDbType();

    if (dbType === 'postgres') {
      const result = await this.queryPostgres('SELECT version()');
      if (result.success && result.rows?.[0]) {
        return { success: true, version: String(result.rows[0].version) };
      }
      return { success: false, error: result.error };
    }

    return { success: false, error: `Unsupported database type: ${dbType}` };
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'database',
    displayName: 'Database',
    category: 'database',
    credentialsSchema: DatabaseCredentialsSchema,
    setupHelpUrl: undefined,
    credentials: {
      defaultScalarKey: 'connectionUrl',
    },
  },
  factory: (credentials) => {
    const adapter = new DatabaseAdapter();
    adapter.connect(credentials as DatabaseCredentials);
    return adapter;
  },
});
