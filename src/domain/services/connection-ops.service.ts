import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { secretManagerRegistry } from '../registry/secretmanager.registry.js';
import { githubCiDeployPermissionProblem } from './ci-deploy.service.js';
import { normalizeConnectionScope } from '../entities/connection.entity.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

export interface SaveConnectionOutcome {
  success: boolean;
  error?: string;
  connection?: {
    id: string;
    provider: string;
    scope: string | null;
    status: string;
    createdAt: Date;
  };
  dependenciesInstalled?: string[];
  dependencyErrors?: string[];
}

/**
 * Validate, encrypt, and upsert provider credentials for hv_connections.
 * Runs provider dependency
 * installation hooks and writes an audit entry.
 */
export async function saveConnection(
  provider: string,
  credentials: Record<string, unknown>,
  scope?: string,
  options: { credentialsSource?: string } = {}
): Promise<SaveConnectionOutcome> {
  scope = normalizeConnectionScope(scope) ?? undefined;
  const secretStore = getSecretStore();

  // Validate credentials using the provider's schema. Secret managers
  // (vault, doppler, 1password, bitwarden, ...) live in their own registry.
  const isSecretManager = !providerRegistry.get(provider) && secretManagerRegistry.has(provider);
  const validation = isSecretManager
    ? secretManagerRegistry.validateCredentials(provider, credentials)
    : providerRegistry.validateCredentials(provider, credentials);
  if (!validation.success) {
    return { success: false, error: validation.error! };
  }

  // Encrypt credentials
  const credentialsEncrypted = secretStore.encryptObject(validation.data);

  // Upsert connection
  const connection = connectionRepo.upsert({
    provider,
    scope: scope || null,
    credentialsEncrypted,
  });

  // Run provider dependency installation if needed
  const registeredProvider = providerRegistry.get(provider);
  let depsResult: { installed: string[]; errors: string[] } | undefined;
  if (registeredProvider?.ensureDependencies) {
    depsResult = await registeredProvider.ensureDependencies();
  }

  auditRepo.create({
    action: 'connection.created',
    resourceType: 'connection',
    resourceId: connection.id,
    details: {
      provider,
      scope: scope || null,
      ...(options.credentialsSource ? { credentialsSource: options.credentialsSource } : {}),
    },
  });

  return {
    success: true,
    connection: {
      id: connection.id,
      provider: connection.provider,
      scope: connection.scope,
      status: connection.status,
      createdAt: connection.createdAt,
    },
    ...(depsResult?.installed.length ? { dependenciesInstalled: depsResult.installed } : {}),
    ...(depsResult?.errors.length ? { dependencyErrors: depsResult.errors } : {}),
  };
}

export type VerifyConnectionOutcome =
  | { kind: 'not_found'; error: string }
  | { kind: 'unknown_provider'; error: string }
  | { kind: 'verified'; message: string; data: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'threw'; error: string };

/**
 * Verify a stored provider connection by instantiating its adapter and
 * calling verify() for hv_connections action="verify". Updates the
 * connection status and writes audit entries.
 */
export async function verifyConnection(provider: string, scope?: string): Promise<VerifyConnectionOutcome> {
  scope = normalizeConnectionScope(scope) ?? undefined;
  const connection = connectionRepo.findByProviderAndScope(provider, scope || null);

  const scopeDisplay = scope || 'global';
  if (!connection) {
    return {
      kind: 'not_found',
      error: `No connection found for provider: ${provider} (${scopeDisplay}).`,
    };
  }

  const secretStore = getSecretStore();
  const registeredProvider = providerRegistry.get(provider);

  // Secret managers verify through their own registry/adapter interface.
  if (!registeredProvider && secretManagerRegistry.has(provider)) {
    try {
      const decryptedCreds = secretStore.decryptObject(connection.credentialsEncrypted);
      const adapter = secretManagerRegistry.createAdapter(provider, decryptedCreds);
      await adapter.connect(decryptedCreds);
      const result = await adapter.verify();
      if (result.success) {
        connectionRepo.updateStatus(connection.id, 'verified');
        auditRepo.create({
          action: 'connection.verified',
          resourceType: 'connection',
          resourceId: connection.id,
          details: { provider, scope: scope || null },
        });
        return {
          kind: 'verified',
          message: `${provider} connection (${scopeDisplay}) verified${result.identity ? ` as ${result.identity}` : ''}`,
          data: { ...(result.identity ? { identity: result.identity } : {}) },
        };
      }
      connectionRepo.updateStatus(connection.id, 'failed');
      return {
        kind: 'failed',
        error: result.error ?? 'Verification failed',
      };
    } catch (error) {
      connectionRepo.updateStatus(connection.id, 'failed');
      return {
        kind: 'threw',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!registeredProvider) {
    return { kind: 'unknown_provider', error: `Unknown provider: ${provider}` };
  }

  try {
    const decryptedCreds = secretStore.decryptObject(connection.credentialsEncrypted);
    const adapter = await registeredProvider.factory(decryptedCreds);

    // Check if adapter has a verify method
    if (typeof (adapter as { verify?: () => Promise<unknown> }).verify !== 'function') {
      // For providers without verify (like local, tunnel), just mark as verified
      connectionRepo.updateStatus(connection.id, 'verified');
      return {
        kind: 'verified',
        message: `${provider} connection (${scopeDisplay}) saved`,
        data: {},
      };
    }

    // Call verify on the adapter
    const result = await (adapter as {
      verify: (scope?: string) => Promise<{
        success: boolean;
        error?: string;
        email?: string;
        accountId?: string;
        zones?: string[];
        version?: string;
        warning?: string;
        login?: string;
        scopes?: string[];
        workspaceId?: string;
        workspaces?: Array<{ id: string; name?: string }>;
        tokenKind?: 'user' | 'account' | 'unknown';
      }>
    }).verify(scope || undefined);

    if (result.success) {
      // Persist discovered Railway workspaceId so future deploy/apply flows can create projects
      // without requiring manual workspace lookup.
      if (provider === 'railway' && result.workspaceId) {
        const creds = decryptedCreds as { apiToken?: string; workspaceId?: string; teamId?: string };
        if (!creds.workspaceId) {
          const nextCreds = { ...creds, workspaceId: result.workspaceId };
          const nextEncrypted = secretStore.encryptObject(nextCreds);
          connectionRepo.updateCredentials(connection.id, nextEncrypted);
        }
      }
      if (provider === 'github' && result.login) {
        const creds = decryptedCreds as {
          apiToken?: string;
          login?: string;
          packageReadToken?: string;
        };
        const tokenHasPackageRead =
          result.scopes?.includes('read:packages') === true
          || result.scopes?.includes('write:packages') === true;
        const nextCreds = {
          ...creds,
          ...(creds.login !== result.login ? { login: result.login } : {}),
          ...(tokenHasPackageRead && creds.apiToken && !creds.packageReadToken
            ? { packageReadToken: creds.apiToken }
            : {}),
        };
        if (JSON.stringify(nextCreds) !== JSON.stringify(creds)) {
          const nextEncrypted = secretStore.encryptObject(nextCreds);
          connectionRepo.updateCredentials(connection.id, nextEncrypted);
        }
      }
      if (provider === 'cloudflare' && result.tokenKind) {
        const creds = decryptedCreds as {
          apiToken?: string;
          accountId?: string;
          registrarApiToken?: string;
          apiTokenKind?: 'user' | 'account' | 'unknown';
        };
        if (creds.apiTokenKind !== result.tokenKind) {
          const nextCreds = { ...creds, apiTokenKind: result.tokenKind };
          const nextEncrypted = secretStore.encryptObject(nextCreds);
          connectionRepo.updateCredentials(connection.id, nextEncrypted);
        }
      }

      connectionRepo.updateStatus(connection.id, 'verified');
      auditRepo.create({
        action: 'connection.verified',
        resourceType: 'connection',
        resourceId: connection.id,
        details: { provider, scope: scope || null, email: result.email, accountId: result.accountId, version: result.version },
      });

      const displayName = registeredProvider.metadata.displayName;
      let message = `${displayName} connection (${scopeDisplay}) verified successfully`;
      if (result.email) {
        message += ` for ${result.email}`;
      }
      if (result.version) {
        message += ` (v${result.version})`;
      }
      const githubPermissionProblem = provider === 'github'
        ? githubCiDeployPermissionProblem({ scopes: result.scopes }, { repo: scope })
        : null;
      const warning = [
        result.warning,
        githubPermissionProblem?.hint,
      ].filter(Boolean).join(' ');

      return {
        kind: 'verified',
        message,
        data: {
          ...(result.email && { email: result.email }),
          ...(result.accountId && { accountId: result.accountId }),
          ...(result.version && { version: result.version }),
          ...(warning && { warning }),
          ...(result.login && { login: result.login }),
          ...(result.scopes && { scopes: result.scopes }),
          ...(result.workspaceId && { workspaceId: result.workspaceId }),
          ...(result.workspaces && result.workspaces.length > 0 && { workspaces: result.workspaces }),
        },
      };
    } else {
      connectionRepo.updateStatus(connection.id, 'failed');
      auditRepo.create({
        action: 'connection.failed',
        resourceType: 'connection',
        resourceId: connection.id,
        details: { provider, scope: scope || null, reason: result.error },
      });

      const errorMsg = `${registeredProvider.metadata.displayName} verification failed: ${result.error}.`;

      return { kind: 'failed', error: errorMsg };
    }
  } catch (error) {
    connectionRepo.updateStatus(connection.id, 'failed');
    auditRepo.create({
      action: 'connection.failed',
      resourceType: 'connection',
      resourceId: connection.id,
      details: { provider, scope: scope || null, error: String(error) },
    });

    return { kind: 'threw', error: `Verification failed: ${error}.` };
  }
}

export interface DeleteConnectionOutcome {
  success: boolean;
  error?: string;
}

/** Delete a stored provider connection (shared by connection_delete and hv_connections). */
export function deleteConnection(provider: string, scope?: string): DeleteConnectionOutcome {
  scope = normalizeConnectionScope(scope) ?? undefined;
  const connection = connectionRepo.findByProviderAndScope(provider, scope || null);

  const scopeDisplay = scope || 'global';
  if (!connection) {
    return { success: false, error: `No connection found for provider: ${provider} (${scopeDisplay})` };
  }

  connectionRepo.deleteByProviderAndScope(provider, scope || null);

  auditRepo.create({
    action: 'connection.deleted',
    resourceType: 'connection',
    resourceId: connection.id,
    details: { provider, scope: scope || null },
  });

  return { success: true };
}
