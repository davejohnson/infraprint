import type { CommandRegistrar } from '../application/commands.js';
import { readFileSync } from 'fs';
import { z } from 'zod';
import {
  providerRegistry,
  type ProviderMetadata,
} from '../domain/registry/provider.registry.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { runCloudPrepare } from '../domain/services/cloud-prepare.execute.js';
import { saveConnection, verifyConnection, deleteConnection } from '../domain/services/connection-ops.service.js';
import { SecretResolver } from '../domain/services/secret.resolver.js';
import { parseSecretRef } from '../domain/ports/secretmanager.port.js';
import { parseEnvFile } from '../utils/env-parser.js';
import {
  credentialFieldsFromSchema,
  connectionSetupDetails,
  formatConnectionGuidance,
  getConnectionGuidance,
} from '../domain/services/connection-guidance.js';
import type { CredentialFieldDescriptor } from '../domain/services/connection-guidance.js';
import type { CommandContext } from '../application/context.js';
import { projectField, confirmField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler } from '../application/results.js';
import { suppliedOptionNames } from '../application/command-options.js';
import { splitFragment } from '../utils/split-fragment.js';
import type { Project } from '../domain/entities/project.entity.js';

function resolveEnvironmentCredential(
  provider: string,
  requestedName: string,
  values: Record<string, string | undefined>
): string | undefined {
  if (values[requestedName] !== undefined) {
    return values[requestedName];
  }

  const aliasGroup = providerRegistry
    .getMetadata(provider)
    ?.credentials
    ?.environmentVariableAliases
    ?.find((aliases) => aliases.includes(requestedName));
  if (!aliasGroup) {
    return undefined;
  }

  const candidates = aliasGroup
    .filter((name) => values[name] !== undefined)
    .map((name) => ({ name, value: values[name]! }));
  if (candidates.length === 0) {
    return undefined;
  }
  if (new Set(candidates.map((candidate) => candidate.value)).size > 1) {
    throw new Error(
      `Environment variable ${requestedName} is not set and its accepted aliases `
      + `(${aliasGroup.join(', ')}) contain different values. Set ${requestedName} explicitly.`
    );
  }
  return candidates[0].value;
}

function resolveLocalSecretRef(ref: string, provider?: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice('env:'.length).trim();
    if (!name) {
      throw new Error('credentialsRef env: reference is missing the environment variable name.');
    }
    const value = provider
      ? resolveEnvironmentCredential(provider, name, process.env)
      : process.env[name];
    if (value === undefined) {
      throw new Error(`Environment variable ${name} is not set.`);
    }
    return value;
  }
  if (trimmed.startsWith('file:')) {
    const filePath = trimmed.slice('file:'.length).trim();
    if (!filePath) {
      throw new Error('credentialsRef file: reference is missing the file path.');
    }
    return readFileSync(filePath, 'utf8').trim();
  }
  throw new Error('Unsupported credentialsRef. Use env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path, or a secret-manager ref like 1password://vault/item#field.');
}

function defaultScalarCredentialKey(provider: string): string | undefined {
  return providerRegistry.getMetadata(provider)?.credentials?.defaultScalarKey
    ?? secretManagerRegistry.getMetadata(provider)?.credentials?.defaultScalarKey;
}

function scalarCredentialObject(provider: string, value: string, credentialsKey: string | undefined, source: string): Record<string, unknown> {
  const key = credentialsKey ?? defaultScalarCredentialKey(provider);
  if (!key) {
    throw new Error(`${source} resolved to a scalar value. Pass credentialsKey to map it into the provider credentials object.`);
  }
  return { [key]: value };
}

function parseRawCredentialValue(provider: string, raw: string, credentialsKey: string | undefined, source: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${source} JSON must resolve to an object.`);
    }
    return parsed as Record<string, unknown>;
  }
  return scalarCredentialObject(provider, trimmed, credentialsKey, source);
}

function mapStructuredCredentialValue(
  raw: string,
  credentialsMap: Record<string, string>,
  source: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} must resolve to a JSON object when credentialsMap is used.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must resolve to a JSON object when credentialsMap is used.`);
  }

  const values = parsed as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [providerKey, sourceKey] of Object.entries(credentialsMap)) {
    const value = values[sourceKey];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`credentialsMap key "${providerKey}" references missing source field "${sourceKey}".`);
    }
    output[providerKey] = value;
  }
  return output;
}

function parseDotenvCredentialRef(
  provider: string,
  ref: string,
  credentialsKey?: string,
  credentialsMap?: Record<string, string>
): Record<string, unknown> {
  const raw = ref.slice('dotenv:'.length).trim();
  const { target: filePath, fragment } = splitFragment(raw);
  if (!filePath) {
    throw new Error('credentialsRef dotenv: reference is missing the .env file path.');
  }
  if (credentialsMap && fragment) {
    throw new Error('Pass either credentialsMap or a dotenv #KEY fragment, not both.');
  }

  const values = parseEnvFile(filePath);
  if (credentialsMap) {
    const output: Record<string, unknown> = {};
    for (const [providerKey, envKey] of Object.entries(credentialsMap)) {
      const value = resolveEnvironmentCredential(provider, envKey, values);
      if (value === undefined) {
        throw new Error(`credentialsMap key "${providerKey}" references missing .env variable "${envKey}".`);
      }
      output[providerKey] = value;
    }
    return output;
  }

  if (!fragment) {
    throw new Error('credentialsRef dotenv: references must include #ENV_VAR, or pass credentialsMap for multiple values.');
  }
  const value = resolveEnvironmentCredential(provider, fragment, values);
  if (value === undefined) {
    throw new Error(`.env variable "${fragment}" was not found.`);
  }
  return scalarCredentialObject(provider, value, credentialsKey, `dotenv:${filePath}#${fragment}`);
}

async function parseCredentialRef(
  provider: string,
  ref: string,
  credentialsKey?: string,
  credentialsMap?: Record<string, string>,
  context?: { projectId?: string }
): Promise<Record<string, unknown>> {
  if (ref.trim().startsWith('dotenv:')) {
    return parseDotenvCredentialRef(provider, ref, credentialsKey, credentialsMap);
  }

  const secretRef = parseSecretRef(ref.trim());
  if (secretRef) {
    const resolved = await new SecretResolver().resolveSecret(secretRef.raw, context);
    if ('error' in resolved) {
      throw new Error(`Failed to resolve credentialsRef secret: ${resolved.error}`);
    }
    if (credentialsMap) {
      return mapStructuredCredentialValue(resolved.value, credentialsMap, 'credentialsRef secret');
    }
    return parseRawCredentialValue(provider, resolved.value, credentialsKey, 'credentialsRef secret');
  }

  if (credentialsMap) {
    throw new Error('credentialsMap is supported with dotenv references or structured secret-manager references.');
  }

  const raw = resolveLocalSecretRef(ref, provider);
  return parseRawCredentialValue(provider, raw, credentialsKey, 'credentialsRef');
}

function refKind(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('file:')) return 'file';
  if (trimmed.startsWith('env:')) return 'env';
  if (trimmed.startsWith('dotenv:')) return 'dotenv';
  const secretRef = parseSecretRef(trimmed);
  if (secretRef?.provider === 'stripe-projects') return 'stripe-projects';
  if (secretRef) return 'secret-manager';
  return 'unknown';
}

function warningExtras(data: Record<string, unknown>): { warnings: string[] } | undefined {
  return typeof data.warning === 'string' && data.warning.trim()
    ? { warnings: [data.warning] }
    : undefined;
}

function setupDetails(provider: string, scope?: string, project?: string) {
  return { connectionSetup: connectionSetupDetails(provider, { scope, project }) };
}

type ProviderDiscoveryEntry = {
  name: string;
  displayName: string;
  setupHelpUrl?: string;
  setupHelpUrls?: Array<{ label: string; url: string }>;
  tokenType?: string;
  requiredPermissions?: string[];
  credentialExample?: string;
  notes?: string[];
  credentialFields?: CredentialFieldDescriptor[];
  defaultScalarKey?: string;
  environmentVariableAliases?: string[][];
  maturity?: ProviderMetadata['maturity'];
  lifecycle?: ProviderMetadata['lifecycle'];
};

function providerDiscoveryEntry(metadata: Pick<
  ProviderMetadata,
  'name' | 'displayName' | 'setupHelpUrl' | 'credentialsSchema' | 'credentials' | 'maturity' | 'lifecycle'
>): ProviderDiscoveryEntry {
  const guidance = getConnectionGuidance(metadata.name);
  const credentialFields = credentialFieldsFromSchema(metadata.credentialsSchema);
  return {
    name: metadata.name,
    displayName: metadata.displayName,
    ...(metadata.maturity ? { maturity: metadata.maturity } : {}),
    ...(metadata.lifecycle ? { lifecycle: metadata.lifecycle } : {}),
    ...(credentialFields !== undefined ? { credentialFields } : {}),
    ...(metadata.credentials?.defaultScalarKey ? { defaultScalarKey: metadata.credentials.defaultScalarKey } : {}),
    ...(metadata.credentials?.environmentVariableAliases?.length
      ? { environmentVariableAliases: metadata.credentials.environmentVariableAliases }
      : {}),
    ...(guidance?.setupUrl || metadata.setupHelpUrl ? { setupHelpUrl: guidance?.setupUrl ?? metadata.setupHelpUrl } : {}),
    ...(guidance?.setupUrls?.length ? { setupHelpUrls: guidance.setupUrls } : {}),
    ...(guidance ? {
      tokenType: guidance.tokenType,
      requiredPermissions: guidance.permissions,
      credentialExample: guidance.credentialExample,
      ...(guidance.notes?.length ? { notes: guidance.notes } : {}),
    } : {}),
  };
}

export function registerConnectionsTools(commands: CommandRegistrar, ctx: CommandContext): void {
  const providerNames = [...new Set([...providerRegistry.names(), ...secretManagerRegistry.names()])];
  if (providerNames.length === 0) {
    throw new Error('No providers registered. Ensure adapters are imported before registering tools.');
  }

  commands.register(
    'hv_connections',
    'Connection modes: {} lists every connection/provider; {project} lists in validated project context; {provider,...} manages one connection. With provider, action="add" is the default, while "verify", "remove", and "prepare" are explicit. Project context never changes provider scope. Credentials are encrypted at rest and never returned; credentialsRef is preferred. Providers and credential sources that declare native CLI authentication may omit credentials to use the active local/default credential chain.',
    {
      provider: z.string().optional().describe(`Omit to list. Otherwise select a provider (available: ${providerNames.join(', ')}). action="remove" also accepts unregistered providers so stale connections can be deleted.`),
      action: z.enum(['add', 'verify', 'remove', 'prepare']).optional().describe('With provider: operation to perform (default: "add")'),
      credentials: z.record(z.unknown()).optional().describe('action="add": provider-specific credentials object. Omit for providers supporting native CLI/default authentication. credentialsRef is recommended for explicit credentials, but raw credentials are accepted when intentional.'),
      credentialsRef: z.string().optional().describe('action="add": recommended credential reference resolved by Hypervibe. Supports env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path for token/JSON files, secret-manager refs like 1password://vault/item#field, or an already-pulled active Stripe Projects environment with stripe-projects://<environment>/<provider>/<service>. The resolved value may be a JSON credentials object or a scalar.'),
      credentialsKey: z.string().optional().describe('action="add": wraps a scalar credentialsRef value under this provider credential key, e.g. apiToken or accessToken. Optional for common single-token providers.'),
      credentialsMap: z.record(z.string()).optional().describe('action="add": for dotenv or structured secret-manager references, maps provider credential keys to source fields, e.g. {"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}.'),
      scope: z.string().optional().describe('Optional scope for fine-grained tokens (e.g., "owner/repo" for GitHub, "example.com" for Cloudflare). Use "org/*" for wildcard matching. Leave empty for global.'),
      project: projectField.describe('Optional Hypervibe project name/id for validated context. With no provider, project-only still lists. Omit for an unscoped list. This never changes provider credential scope.'),
      gcpProjectId: z.string().optional().describe('action="prepare": GCP project ID (defaults to the Cloud Run connection projectId)'),
      deployServiceAccountEmail: z.string().optional().describe('action="prepare": deploy service account email (defaults to the Cloud Run connection service account)'),
      gcsAccess: z.enum(['inspect', 'lifecycle']).optional().describe('action="prepare" for cloudrun: explicitly add GCS access to the reused service account. "inspect" grants roles/storage.viewer; "lifecycle" grants roles/storage.admin.'),
      memorystoreAccess: z.enum(['inspect', 'lifecycle']).optional().describe('action="prepare" for cloudrun: explicitly add Memorystore access to the reused service account. "inspect" grants roles/redis.viewer; "lifecycle" grants roles/redis.admin.'),
      queueAccess: z.enum(['lifecycle', 'remove']).optional().describe('action="prepare" for cloudrun: explicitly grant Pub/Sub queue lifecycle access or remove that exact role from the reused service account.'),
      adminAuth: z.literal('default').optional().describe('action="prepare" with confirm=true: use existing Google Application Default Credentials for the one-time admin operation. Not stored.'),
      adminCredentialsJson: z.string().optional().describe('action="prepare": one-time admin service account JSON. Not stored.'),
      adminCredentialsJsonRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time admin service account JSON. Not stored.'),
      adminAccessToken: z.string().optional().describe('action="prepare": one-time OAuth admin access token. Not stored.'),
      adminAccessTokenRef: z.string().optional().describe('action="prepare": env:NAME or file:/absolute/path resolving to one-time OAuth admin access token. Not stored.'),
      confirm: confirmField,
    },
    wrapCommandHandler(async ({
      provider,
      action,
      credentials,
      credentialsRef,
      credentialsKey,
      credentialsMap,
      scope,
      project: projectRef,
      gcpProjectId,
      deployServiceAccountEmail,
      gcsAccess,
      memorystoreAccess,
      queueAccess,
      adminAuth,
      adminCredentialsJson,
      adminCredentialsJsonRef,
      adminAccessToken,
      adminAccessTokenRef,
      confirm,
    }) => {
      if (!provider) {
        const mutationInput = action !== undefined
          || credentials !== undefined
          || credentialsRef !== undefined
          || credentialsKey !== undefined
          || credentialsMap !== undefined
          || scope !== undefined
          || gcpProjectId !== undefined
          || deployServiceAccountEmail !== undefined
          || gcsAccess !== undefined
          || memorystoreAccess !== undefined
          || queueAccess !== undefined
          || adminAuth !== undefined
          || adminCredentialsJson !== undefined
          || adminCredentialsJsonRef !== undefined
          || adminAccessToken !== undefined
          || adminAccessTokenRef !== undefined
          || confirm !== undefined;
        if (mutationInput) {
          return commandError('VALIDATION', 'provider is required when connection operation parameters are supplied.', {
            hint: 'Use hv_connections({}) to list globally, hv_connections({project}) to list in validated project context, or pass provider to add, verify, remove, or prepare one.',
          });
        }
        const project = projectRef
          ? ctx.resolveProjectOrThrow({ project: projectRef })
          : null;
        return listConnections(project);
      }

      const requestedAction = action ?? 'add';
      // Stale connections for unregistered providers must stay removable.
      if (requestedAction !== 'remove' && !providerNames.includes(provider)) {
        return commandError('VALIDATION', `Unknown provider: ${provider}.`, {
          hint: `Available providers: ${providerNames.join(', ')}`,
        });
      }
      const prepareFields = {
        gcpProjectId,
        deployServiceAccountEmail,
        gcsAccess,
        memorystoreAccess,
        queueAccess,
        adminAuth,
        adminCredentialsJson,
        adminCredentialsJsonRef,
        adminAccessToken,
        adminAccessTokenRef,
      };
      const credentialFields = { credentials, credentialsRef, credentialsKey, credentialsMap };
      const incompatible = suppliedOptionNames(requestedAction === 'prepare'
        ? { ...credentialFields, scope }
        : requestedAction === 'remove' || requestedAction === 'verify'
          ? { ...credentialFields, ...prepareFields, confirm }
          : { ...prepareFields, confirm });
      if (incompatible.length > 0) {
        return commandError(
          'VALIDATION',
          `action="${requestedAction}" received options for another connection action: ${incompatible.join(', ')}.`,
          { hint: `Remove the listed options and pass only fields documented for action="${requestedAction}".` }
        );
      }
      if (requestedAction === 'add' && !credentialsRef && (credentialsKey !== undefined || credentialsMap !== undefined)) {
        return commandError('VALIDATION', 'credentialsKey and credentialsMap require credentialsRef for action="add".');
      }
      if (requestedAction === 'add' && credentialsKey !== undefined && credentialsMap !== undefined) {
        return commandError('VALIDATION', 'Pass either credentialsKey or credentialsMap for action="add", not both.');
      }
      if (requestedAction === 'prepare' && adminCredentialsJson && adminCredentialsJsonRef) {
        return commandError('VALIDATION', 'Pass either adminCredentialsJson or adminCredentialsJsonRef, not both.');
      }
      if (requestedAction === 'prepare' && adminAccessToken && adminAccessTokenRef) {
        return commandError('VALIDATION', 'Pass either adminAccessToken or adminAccessTokenRef, not both.');
      }
      if (requestedAction === 'prepare' && gcsAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'gcsAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && memorystoreAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'memorystoreAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && queueAccess && provider !== 'cloudrun') {
        return commandError('VALIDATION', 'queueAccess is supported only when preparing the shared cloudrun connection.');
      }
      if (requestedAction === 'prepare' && queueAccess === 'remove' && (gcsAccess || memorystoreAccess)) {
        return commandError(
          'VALIDATION',
          'queueAccess="remove" is an exact removal-only operation and cannot be combined with GCS or Memorystore grants.'
        );
      }
      const adminJsonSupplied = adminCredentialsJson !== undefined || adminCredentialsJsonRef !== undefined;
      const adminTokenSupplied = adminAccessToken !== undefined || adminAccessTokenRef !== undefined;
      const adminDefaultSupplied = adminAuth === 'default';
      if (requestedAction === 'prepare' && [adminJsonSupplied, adminTokenSupplied, adminDefaultSupplied].filter(Boolean).length > 1) {
        return commandError('VALIDATION', 'Pass one admin authentication method for action="prepare": default Google credentials, service-account JSON, or an access token.');
      }
      if (requestedAction === 'prepare' && !confirm && (adminJsonSupplied || adminTokenSupplied || adminDefaultSupplied)) {
        return commandError('VALIDATION', 'Admin credentials are accepted only with confirm=true for action="prepare".', {
          hint: 'Run the credential-free preview first, then pass adminAuth="default" or exactly one admin credential reference with confirm=true.',
        });
      }
      if (requestedAction === 'prepare' && confirm && !adminJsonSupplied && !adminTokenSupplied && !adminDefaultSupplied) {
        return commandError('VALIDATION', 'confirm=true requires one admin authentication method for action="prepare".', {
          hint: 'Prefer adminAuth="default" to use existing Google Application Default Credentials. Explicit adminCredentialsJsonRef or adminAccessTokenRef remain available when intentional.',
        });
      }
      const project = projectRef
        ? ctx.resolveProjectOrThrow({ project: projectRef })
        : null;
      const projectContext = project
        ? { project: { id: project.id, name: project.name } }
        : {};

      if (requestedAction === 'prepare') {
        const targetProject = project ?? ctx.resolveProjectOrThrow();
        const resolvedAdminCredentialsJson = adminCredentialsJsonRef
          ? resolveLocalSecretRef(adminCredentialsJsonRef)
          : adminCredentialsJson;
        const resolvedAdminAccessToken = adminAccessTokenRef
          ? resolveLocalSecretRef(adminAccessTokenRef)
          : adminAccessToken;
        const payload = await runCloudPrepare({
          project: targetProject,
          provider,
          gcpProjectId,
          deployServiceAccountEmail,
          gcsAccess,
          memorystoreAccess,
          queueAccess,
          adminAuth,
          adminCredentialsJson: resolvedAdminCredentialsJson,
          adminAccessToken: resolvedAdminAccessToken,
          adminCredentialSource: adminAuth === 'default'
            ? 'application-default'
            : adminCredentialsJsonRef
              ? `service-account-${refKind(adminCredentialsJsonRef)}`
              : adminCredentialsJson
                ? 'service-account-inline'
                : adminAccessTokenRef
                  ? `access-token-${refKind(adminAccessTokenRef)}`
                  : adminAccessToken
                    ? 'access-token-inline'
                    : undefined,
          confirm,
        });
        if (!payload.success) {
          return commandError('PROVIDER_ERROR', String(payload.error ?? 'Cloud preparation failed'), { details: payload });
        }
        return commandSuccess({ ...projectContext, ...payload }, payload.mode === 'preview'
          ? { hint: 'Recommended: re-run with confirm=true and adminAuth="default" to use existing Google Application Default Credentials. Explicit adminCredentialsJsonRef or adminAccessTokenRef remain available when intentional.' }
          : { next: ['hv_plan'] });
      }

      if (requestedAction === 'remove') {
        const result = deleteConnection(provider, scope);
        if (!result.success) {
          return commandError('NOT_FOUND', result.error!);
        }
        return commandSuccess({ ...projectContext, provider, scope: scope || 'global', removed: true });
      }

      if (requestedAction === 'add') {
        if (credentials && credentialsRef) {
          return commandError('VALIDATION', 'Pass either credentials or credentialsRef, not both.');
        }
        const nativeCliAuth = providerRegistry.getMetadata(provider)?.credentials?.supportsNativeCliAuth === true
          || secretManagerRegistry.getMetadata(provider)?.credentials?.supportsNativeCliAuth === true;
        if (!credentials && !credentialsRef && !nativeCliAuth) {
          return commandError('VALIDATION', 'credentials are required for action="add".', {
            details: setupDetails(provider, scope, project?.name),
            hint: `Recommended: use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        let credentialsToSave: Record<string, unknown>;
        try {
          const projectForSecretRef = project ?? ctx.resolveProject({});
          credentialsToSave = credentialsRef
            ? await parseCredentialRef(provider, credentialsRef, credentialsKey, credentialsMap, {
              ...(projectForSecretRef ? { projectId: projectForSecretRef.id } : {}),
            })
            : credentials ?? { authMode: 'default' };
        } catch (error) {
          return commandError('VALIDATION', error instanceof Error ? error.message : String(error), {
            details: setupDetails(provider, scope, project?.name),
            hint: `Use credentialsRef="env:NAME" for exported tokens, credentialsRef="dotenv:/absolute/path/.env#KEY" for existing .env files, credentialsRef="file:/absolute/path" for JSON credentials, a secret-manager ref like 1password://vault/item#field, or stripe-projects://<environment>/<provider>/<service> for an already-pulled active Stripe Projects environment. Raw credentials={...} is still accepted if intentional. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        const credentialsSource = credentialsRef
          ? refKind(credentialsRef)
          : !credentials && nativeCliAuth
            ? 'native-cli'
            : 'inline';
        const saved = await saveConnection(provider, credentialsToSave, scope, { credentialsSource });
        if (!saved.success) {
          return commandError('VALIDATION', saved.error!, {
            details: setupDetails(provider, scope, project?.name),
            hint: `Fix the credentials object to match the provider schema and retry. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        // Auto-verify so one call does add + verify.
        const verified = await verifyConnection(provider, scope);
        if (verified.kind !== 'verified') {
          return commandError('PROVIDER_ERROR', verified.error ?? 'Verification failed.', {
            details: { connection: saved.connection, ...setupDetails(provider, scope, project?.name) },
            hint: `The connection was saved but failed verification. Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="verify" or action="add" with corrected credentials. ${formatConnectionGuidance(provider, { scope })}`,
          });
        }

        const data = {
          ...projectContext,
          provider,
          scope: scope || 'global',
          status: 'verified',
          message: verified.message,
          credentialsSource,
          ...verified.data,
          ...(saved.dependenciesInstalled ? { dependenciesInstalled: saved.dependenciesInstalled } : {}),
          ...(saved.dependencyErrors ? { dependencyErrors: saved.dependencyErrors } : {}),
        };
        return commandSuccess(data, warningExtras(data));
      }

      // action === 'verify'
      const verified = await verifyConnection(provider, scope);
      switch (verified.kind) {
        case 'verified':
        {
          const data = {
            ...projectContext,
            provider,
            scope: scope || 'global',
            status: 'verified',
            message: verified.message,
            ...verified.data,
          };
          return commandSuccess(data, warningExtras(data));
        }
        case 'not_found':
          return commandError('NOT_FOUND', verified.error, {
            details: setupDetails(provider, scope, project?.name),
            hint: `Add the connection first with hv_connections provider="${provider}" action="add". ${formatConnectionGuidance(provider, { scope })}`,
          });
        case 'unknown_provider':
          return commandError('UNSUPPORTED', verified.error);
        default:
          return commandError('PROVIDER_ERROR', verified.error, {
            details: setupDetails(provider, scope, project?.name),
            hint: `Confirm the token type and permissions, then re-run hv_connections provider="${provider}" action="add" with corrected credentials. ${formatConnectionGuidance(provider, { scope })}`,
          });
      }
    })
  );

  async function listConnections(project: Project | null) {
      const connections = ctx.repos.connections.findAll().map((c) => ({
        provider: c.provider,
        scope: c.scope ?? 'global',
        status: c.status,
        lastVerifiedAt: c.lastVerifiedAt,
      }));

      const availableProviders: Record<string, ProviderDiscoveryEntry[]> = {};
      for (const p of providerRegistry.all()) {
        const category = p.metadata.category;
        availableProviders[category] = availableProviders[category] ?? [];
        availableProviders[category].push(providerDiscoveryEntry(p.metadata));
      }
      for (const p of secretManagerRegistry.all()) {
        availableProviders['secrets'] = availableProviders['secrets'] ?? [];
        availableProviders['secrets'].push(providerDiscoveryEntry(p.metadata));
      }

      const discoveryHint = 'This list is credential discovery only. If a concrete task is blocked, use hv_connections with provider only when a safe credentialsRef is already available. Otherwise offer to help connect credentials the user already controls or prepare a value-free handoff naming the provider, scope, and blocked task for the person who manages that access. Do not assume provider membership or run hv_plan, hv_apply, or hv_deploy to bypass the missing connection.';
      return commandSuccess(
        {
          ...(project ? { project: { id: project.id, name: project.name } } : {}),
          connections,
          availableProviders,
        },
        {
          hint: connections.length === 0
            ? `No connections yet. Recommended: hv_connections provider="<name>" credentialsRef="env:NAME", credentialsRef="dotenv:/absolute/path/.env#KEY", or credentialsRef="file:/absolute/path" for JSON credentials. Raw credentials={...} is still accepted if the user intentionally wants chat entry. ${discoveryHint}`
            : discoveryHint,
        }
      );
  }
}
