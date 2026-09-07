import {
  type ISecretManagerAdapter,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretListItem,
  type OnePasswordCredentials,
  OnePasswordCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

/** Minimal surface of @1password/sdk used here (the SDK is dynamically imported). */
interface OpClient {
  secrets: {
    resolve(secretReference: string): Promise<string>;
  };
  vaults: {
    list(): Promise<Array<{ id: string; title: string }>>;
  };
  items: {
    list(vaultId: string): Promise<Array<{ id: string; title: string }>>;
  };
}

/**
 * 1Password adapter backed by a service account token (read/resolve only).
 *
 * Reference format: 1password://<vault>/<item>[/<section>]#<field>
 * which maps to 1Password's op://<vault>/<item>[/<section>]/<field>.
 * When no #field is given, the conventional "password" field is used.
 *
 * Guidance: create a dedicated vault per project and grant the service
 * account access to only that vault.
 */
export class OnePasswordAdapter implements ISecretManagerAdapter {
  readonly name = '1password' as const;

  private credentials: OnePasswordCredentials | null = null;
  private client: OpClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = OnePasswordCredentialsSchema.parse(credentials);
    this.client = null;
  }

  private async getClient(): Promise<OpClient> {
    if (this.client) return this.client;
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const { createClient } = await import('@1password/sdk');
    this.client = await createClient({
      auth: this.credentials.serviceAccountToken,
      integrationName: 'Hypervibe',
      integrationVersion: '1.0.0',
    });
    return this.client;
  }

  /** 1password ref path/key → op:// reference understood by the SDK. */
  private toOpReference(path: string, key?: string): string {
    return `op://${path}/${key ?? 'password'}`;
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      const client = await this.getClient();
      const vaults = await client.vaults.list();
      if (vaults.length === 0) {
        return {
          success: false,
          error: 'The 1Password service account token is valid but has access to no vaults. Grant the service account access to the vault(s) Hypervibe should read.',
        };
      }
      return {
        success: true,
        identity: '1Password service account',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, key?: string, version?: string): Promise<ResolvedSecret> {
    if (version !== undefined) {
      throw new Error('1Password secret reads do not support selecting a historical version.');
    }
    const client = await this.getClient();
    const value = await client.secrets.resolve(this.toOpReference(path, key));
    return { value };
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    const client = await this.getClient();
    const vaults = await client.vaults.list();
    const results: SecretListItem[] = [];

    for (const vault of vaults) {
      const items = await client.items.list(vault.id);
      for (const item of items) {
        const path = `${vault.title}/${item.title}`;
        if (pathPrefix && !path.startsWith(pathPrefix)) continue;
        results.push({ path });
      }
    }

    return results;
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: '1password',
    displayName: '1Password',
    credentialsSchema: OnePasswordCredentialsSchema,
    setupHelpUrl: 'https://www.1password.dev/service-accounts/',
    credentials: {
      defaultScalarKey: 'serviceAccountToken',
    },
  },
  factory: () => new OnePasswordAdapter(),
});
