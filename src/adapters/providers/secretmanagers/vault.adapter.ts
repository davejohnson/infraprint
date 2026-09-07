import {
  type ISecretManagerAdapter,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretListItem,
  type VaultCredentials,
  VaultCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

const VAULT_API_VERSION = 'v1';

interface VaultAuthResponse {
  auth: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
    policies: string[];
  };
}

interface VaultSecretResponse {
  data: {
    data: Record<string, string>;
    metadata?: {
      created_time: string;
      version: number;
      destroyed: boolean;
      deletion_time: string;
    };
  };
  lease_id?: string;
  lease_duration?: number;
  renewable?: boolean;
}

interface VaultListResponse {
  data: {
    keys: string[];
  };
}

export class VaultAdapter implements ISecretManagerAdapter {
  readonly name = 'vault' as const;

  private credentials: VaultCredentials | null = null;
  private token: string | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as VaultCredentials;

    if (this.credentials.token) {
      this.token = this.credentials.token;
    } else if (this.credentials.roleId && this.credentials.secretId) {
      // AppRole authentication
      const response = await this.request<VaultAuthResponse>(
        'POST',
        '/auth/approle/login',
        {
          role_id: this.credentials.roleId,
          secret_id: this.credentials.secretId,
        },
        true // Skip auth header for login
      );
      this.token = response.auth.client_token;
    } else {
      throw new Error('Either token or roleId+secretId is required');
    }
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      const response = await this.request<{ data: { id: string; display_name: string } }>(
        'GET',
        '/auth/token/lookup-self'
      );
      return {
        success: true,
        identity: response.data.display_name || response.data.id,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, key?: string, version?: string): Promise<ResolvedSecret> {
    if (version !== undefined && !/^[1-9]\d*$/.test(version)) {
      throw new Error('Vault KV v2 version must be a positive integer.');
    }
    // Vault KV v2 paths need /data/ inserted
    const apiPath = this.toKv2Path(path, 'data');
    const endpoint = version ? `${apiPath}?version=${encodeURIComponent(version)}` : apiPath;

    const response = await this.request<VaultSecretResponse>('GET', endpoint);
    const data = response.data.data;
    const observedVersion = response.data.metadata?.version?.toString();
    if (version !== undefined && observedVersion !== version) {
      throw new Error(`Vault returned version ${observedVersion ?? 'unknown'}, not requested version ${version}.`);
    }

    if (key) {
      if (!(key in data)) {
        throw new Error(`Key '${key}' not found in secret at ${path}`);
      }
      return {
        value: data[key],
        version: response.data.metadata?.version?.toString(),
        createdAt: response.data.metadata?.created_time
          ? new Date(response.data.metadata.created_time)
          : undefined,
      };
    }

    // If no key specified and there's only one key, return it
    const keys = Object.keys(data);
    if (keys.length === 1) {
      return {
        value: data[keys[0]],
        version: response.data.metadata?.version?.toString(),
        createdAt: response.data.metadata?.created_time
          ? new Date(response.data.metadata.created_time)
          : undefined,
      };
    }

    // Multiple keys - return as JSON
    return {
      value: JSON.stringify(data),
      version: response.data.metadata?.version?.toString(),
      createdAt: response.data.metadata?.created_time
        ? new Date(response.data.metadata.created_time)
        : undefined,
      metadata: { _multiKey: 'true', keys: keys.join(',') },
    };
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    if (!pathPrefix) {
      throw new Error('Vault KV v2 listing requires pathPrefix to identify the mount, for example "secret".');
    }
    try {
      const basePath = pathPrefix.replace(/\/+$/, '');
      const apiPath = this.toKv2Path(basePath, 'metadata');

      const response = await this.request<VaultListResponse>('LIST', apiPath);
      const keys = response.data.keys || [];

      return keys.map((key) => ({
        path: basePath ? `${basePath}/${key}` : key,
        // Keys ending in / are directories
        keys: key.endsWith('/') ? undefined : [],
      }));
    } catch (error) {
      // 404 means empty list
      if (error instanceof Error && error.message.includes('404')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Convert a secret path to KV v2 API path.
   * Vault KV v2 requires inserting 'data', 'metadata', or 'delete' after the mount.
   * Example: secret/myapp/db -> secret/data/myapp/db
   */
  private toKv2Path(path: string, operation: 'data' | 'metadata' | 'delete'): string {
    const parts = path.split('/');
    if (parts.length < 2) {
      return `${path}/${operation}`;
    }
    // Insert operation after mount point
    const mount = parts[0];
    const secretPath = parts.slice(1).join('/');
    return `${mount}/${operation}/${secretPath}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'LIST',
    path: string,
    body?: Record<string, unknown>,
    skipAuth = false
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const url = `${this.credentials.address}/${VAULT_API_VERSION}/${path.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (!skipAuth && this.token) {
      headers['X-Vault-Token'] = this.token;
    }

    if (this.credentials.namespace) {
      headers['X-Vault-Namespace'] = this.credentials.namespace;
    }

    // LIST is a GET with a special header
    const actualMethod = method === 'LIST' ? 'GET' : method;
    if (method === 'LIST') {
      headers['X-Http-Method-Override'] = 'LIST';
    }

    const options: RequestInit = {
      method: actualMethod,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Vault API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.errors) {
          errorMessage = errorJson.errors.join(', ');
        }
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }
      throw new Error(errorMessage);
    }

    return response.json() as Promise<T>;
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: 'vault',
    displayName: 'HashiCorp Vault',
    credentialsSchema: VaultCredentialsSchema,
    setupHelpUrl: 'https://developer.hashicorp.com/vault/docs',
  },
  factory: (_credentials) => {
    const adapter = new VaultAdapter();
    // connect() is async, will be called separately
    return adapter;
  },
});
