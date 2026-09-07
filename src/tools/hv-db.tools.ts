import type { CommandRegistrar } from '../application/commands.js';
import { createHash } from 'crypto';
import { z } from 'zod';
import {
  supportsDatabaseQuery,
  type DatabaseQueryCredentials,
  type DatabaseQueryResult,
} from '../domain/ports/database-query.port.js';
import {
  analyzeSqlQuery,
  stripSqlLiteralsAndComments,
} from '../domain/services/sql-query-analysis.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import {
  isExternallyUsableDatabaseUrl,
  isPostgresDatabaseUrl,
} from '../domain/services/database-ops.service.js';
import {
  acquireExistingDatabaseAccess,
  acquireManagedDatabaseAccess,
  type DatabaseAccessCleanup,
  type DatabaseAccessLease,
} from '../domain/services/database-access.service.js';
import type { CommandContext } from '../application/context.js';
import type { Project } from '../domain/entities/project.entity.js';
import { connectionSetupOptions } from '../domain/services/connection-guidance.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { projectField, envField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';
import { suppliedOptionNames } from '../application/command-options.js';

type ResolvedDatabaseTarget = {
  url: string;
  source: string;
  project?: Project;
};

type ResolvedDatabaseAccessTarget = {
  source: string;
  project?: Project;
  environment?: string;
  databaseAccess: DatabaseAccessLease;
};

function assertManagedEnvironmentUsesPostgres(
  ctx: CommandContext,
  environment: { id: string; name: string }
): void {
  const postgres = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres');
  const mongodb = ctx.repos.components.findByEnvironmentAndType(environment.id, 'mongodb');
  if (!postgres && mongodb) {
    throw new HvError(
      'VALIDATION',
      `Environment "${environment.name}" uses MongoDB; hv_db_query supports PostgreSQL only.`,
      {
        details: { engine: 'mongodb' },
        hint: 'Use an engine-aware MongoDB operation through the application or provider until Hypervibe exposes a bounded MongoDB command contract.',
      }
    );
  }
}

function sqlFingerprint(sql: string): string {
  const normalized = stripSqlLiteralsAndComments(sql).trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

function assertPostgresTarget(url: string, source: string): void {
  if (!isPostgresDatabaseUrl(url)) {
    throw new HvError('VALIDATION', `Database target ${source} is not a supported Postgres URL.`, {
      hint: 'Hypervibe database tools currently support postgres:// and postgresql:// URLs. Provider template refs and private runtime URLs must be resolved before querying.',
    });
  }
  if (!isExternallyUsableDatabaseUrl(url)) {
    throw new HvError('VALIDATION', `Database target ${source} is not externally reachable from Hypervibe.`, {
      hint: 'Use a public/provider-supported database URL, or select the managed environment with hv_db_query so Hypervibe can acquire operation-scoped access.',
    });
  }
}

async function resolveConfiguredTarget(
  ctx: CommandContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseTarget | null> {
  if (opts.connectionUrl) {
    assertPostgresTarget(opts.connectionUrl, 'direct URL');
    return { url: opts.connectionUrl, source: 'direct URL' };
  }
  if (opts.connectionName) {
    const connection = ctx.repos.connections.findBestMatch('database', opts.connectionName);
    if (!connection) {
      throw new HvError('NOT_FOUND', `No database connection found for: ${opts.connectionName}.`, {
        ...connectionSetupOptions('database', { project: opts.project, scope: opts.connectionName }),
      });
    }
    const creds = ctx.secretStore.decryptObject<DatabaseQueryCredentials>(connection.credentialsEncrypted);
    assertPostgresTarget(creds.connectionUrl, `connection: ${opts.connectionName}`);
    return { url: creds.connectionUrl, source: `connection: ${opts.connectionName}` };
  }
  return null;
}

async function resolveTemporaryExternalTarget(
  ctx: CommandContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseAccessTarget> {
  const configured = await resolveConfiguredTarget(ctx, opts);
  if (configured) {
    return {
      source: configured.source,
      project: configured.project,
      databaseAccess: acquireExistingDatabaseAccess(configured.url),
    };
  }

  const project = ctx.resolveProjectOrThrow({ project: opts.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, opts.env);
  assertManagedEnvironmentUsesPostgres(ctx, environment);
  const result = await acquireManagedDatabaseAccess(project, environment, opts.service);
  if (!result.ok) {
    const missingConnection = result.code === 'provider_error'
      && result.connectionUnavailable
      && result.provider;
    const code = missingConnection ? 'MISSING_CONNECTION'
      : result.code === 'provider_error' ? 'PROVIDER_ERROR'
      : 'NOT_FOUND';
    const scope = getProjectScopeHints(project)
      .find((hint) => !hint.includes('://') && !hint.includes('github.com/'));
    const setup = missingConnection
      ? connectionSetupOptions(result.provider!, { project: project.name, scope })
      : undefined;
    throw new HvError(code, result.error, {
      details: {
        provider: result.provider,
        resourceCreated: result.resourceCreated,
        cleanup: result.cleanup,
        ...(setup?.details ?? {}),
      },
      hint: setup?.hint ?? result.hint,
      next: setup?.next,
    });
  }
  return {
    source: `${project.name}/${environment.name}${opts.service ? `/${opts.service}` : ''}`,
    project,
    environment: environment.name,
    databaseAccess: result.lease,
  };
}

export function registerHvDbTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_db_query',
    'Run one bounded SQL statement against a database. Hypervibe uses an existing reachable endpoint or acquires provider-owned operation-scoped access (such as a connector, TCP proxy, or temporary firewall rule), then releases only access it created and reports cleanup status. SELECT is database-enforced read-only by default; allowMutations=true enables INSERT/UPDATE/DELETE/DDL. Multi-statement SQL is always rejected.',
    {
      project: projectField,
      env: envField,
      sql: z.string().describe('One SQL statement'),
      params: z.array(z.unknown()).optional().describe('Positional query parameters ($1, $2, ...)'),
      allowMutations: z.boolean().optional().describe('Allow mutating statements (default false)'),
      connectionUrl: z.string().optional().describe('Direct postgres:// URL. Mutually exclusive with connectionName and with env/service selectors; project remains optional audit context.'),
      connectionName: z.string().optional().describe('Named database connection. Mutually exclusive with connectionUrl and with env/service selectors; project remains optional audit context.'),
      service: z.string().optional().describe('Service name when resolving a managed database from project/environment bindings'),
    },
    wrapCommandHandler(async ({ project, env, sql, params, allowMutations, connectionUrl, connectionName, service }) => {
      if (connectionUrl && connectionName) {
        return commandError('VALIDATION', 'Pass either connectionUrl or connectionName, not both.', {
          hint: 'Choose one exact database target before running the query.',
        });
      }
      if (connectionUrl || connectionName) {
        const incompatible = suppliedOptionNames({ env, service });
        if (incompatible.length > 0) {
          return commandError('VALIDATION', `Explicit database target received managed-environment selectors: ${incompatible.join(', ')}.`, {
            hint: 'Use connectionUrl/connectionName for the exact explicit target, or remove it and use project/env/service for a managed database.',
          });
        }
      }
      const analysis = analyzeSqlQuery(sql);

      if (analysis.multiStatement) {
        return commandError('VALIDATION', 'Multi-statement SQL is not allowed.', {
          hint: 'Run one statement per hv_db_query call.',
        });
      }
      if (analysis.isMutation && !allowMutations) {
        const requestedSource = connectionName
          ? `connection: ${connectionName}`
          : connectionUrl
            ? 'direct URL'
            : `${project ?? 'auto-detected project'}/${env ?? 'staging'}${service ? `/${service}` : ''}`;
        return commandError('CONFIRM_REQUIRED', 'Mutation query blocked for safety.', {
          details: { source: requestedSource, warnings: analysis.warnings },
          hint: 'Re-run with allowMutations=true to execute INSERT/UPDATE/DELETE/DDL.',
        });
      }

      const target = await resolveTemporaryExternalTarget(ctx, { connectionUrl, connectionName, project, env, service });
      const lease = target.databaseAccess;
      const startedAt = Date.now();
      let result: DatabaseQueryResult | undefined;
      let queryError: unknown;
      let cleanup: DatabaseAccessCleanup = { status: 'no_op' };
      try {
        result = await lease.withConnection(async (resolvedUrl) => {
          const adapter = await providerRegistry.createAdapter('database', {
            connectionUrl: resolvedUrl,
          });
          if (!supportsDatabaseQuery(adapter)) {
            throw new Error('The registered operational database adapter does not implement bounded query execution.');
          }
          return adapter.query(sql, params, { readOnly: !analysis.isMutation });
        });
      } catch (error) {
        queryError = error;
      } finally {
        try {
          cleanup = await lease.release();
        } catch {
          cleanup = {
            status: 'failed',
            safeResourceId: lease.safeResourceId,
            warning: 'Temporary database access cleanup failed unexpectedly and could not be verified.',
          };
        }
      }

      const durationMs = Date.now() - startedAt;
      const access = {
        mode: lease.mode,
        provider: lease.provider,
        leaseId: lease.id,
        leaseCreated: lease.createdByInvocation,
        cleanup: cleanup.status,
        ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
        ...(cleanup.safeResourceId ? { resourceId: cleanup.safeResourceId } : {}),
      };
      let auditWarning: string | undefined;
      try {
        ctx.repos.audit.create({
          action: result?.success === true && !queryError ? 'db_query.succeeded' : 'db_query.failed',
          resourceType: 'database',
          resourceId: target.source,
          details: {
            project: target.project?.name ?? project ?? null,
            environment: target.environment ?? env ?? null,
            provider: lease.provider,
            queryType: analysis.isMutation ? 'mutation' : 'select',
            sqlFingerprint: sqlFingerprint(sql),
            durationMs,
            rowCount: result?.rowCount,
            accessMode: lease.mode,
            leaseId: lease.id,
            leaseCreated: lease.createdByInvocation,
            cleanup: cleanup.status,
            cleanupResourceId: cleanup.safeResourceId,
          },
        });
      } catch {
        auditWarning = 'The query completed, but Hypervibe could not record its local diagnostic audit event.';
      }

      const responseWarnings = [cleanup.warning, auditWarning].filter((value): value is string => Boolean(value));
      if (queryError) {
        return commandError('PROVIDER_ERROR', queryError instanceof Error ? queryError.message : String(queryError), {
          details: { source: target.source, durationMs, access },
          warnings: responseWarnings,
          hint: cleanup.status === 'failed'
            ? 'The query and cleanup both failed. Inspect the managed database with hv_inspect before retrying.'
            : 'Check the database connection and SQL, then retry the diagnostic query.',
        });
      }
      if (!result) {
        throw new Error('Database query returned no result.');
      }
      if (!result.success) {
        return commandError('PROVIDER_ERROR', result.error ?? 'Query failed', {
          details: { source: target.source, durationMs, access },
          warnings: responseWarnings,
          hint: cleanup.status === 'failed'
            ? 'The query failed and temporary access cleanup is pending. Inspect with hv_inspect before retrying.'
            : undefined,
        });
      }

      return commandSuccess(
        {
          source: target.source,
          queryType: analysis.isMutation ? 'mutation' : 'select',
          rowCount: result.rowCount,
          durationMs,
          access,
          ...(analysis.isMutation
            ? { warnings: analysis.warnings.length ? analysis.warnings : undefined }
            : { rows: result.rows, fields: result.fields?.map((f) => f.name) }),
        },
        {
          warnings: responseWarnings,
          ...(cleanup.status === 'failed'
            ? {
              agentInstruction: {
                action: 'stop_and_report' as const,
                message: 'The query result is valid, but temporary database access cleanup failed. Report the safe resource id and inspect it with hv_inspect before another query.',
              },
              hint: 'The query succeeded, but public access may remain until the registered cleanup retry succeeds. Inspect with hv_inspect.',
            }
            : {}),
        }
      );
    })
  );

}
