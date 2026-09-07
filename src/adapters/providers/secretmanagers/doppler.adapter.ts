import {
  type ISecretManagerAdapter,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretListItem,
  type DopplerCredentials,
  DopplerCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

const DOPPLER_API_URL = 'https://api.doppler.com/v3';

interface DopplerSecret {
  name: string;
  value: {
    raw: string;
    computed: string;
  };
}

interface DopplerSecretsResponse {
  secrets: Record<string, DopplerSecret>;
}

export class DopplerAdapter implements ISecretManagerAdapter {
  readonly name = 'doppler' as const;

  private credentials: DopplerCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as DopplerCredentials;

    if (!this.credentials.token) {
      throw new Error('Doppler service token is required');
    }

    // Parse project and config from token if service token
    // Service tokens are scoped to project/config, so we may not need these
    // But they can be overridden in credentials
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      // Verify token by fetching secrets (will fail if invalid)
      await this.request<DopplerSecretsResponse>('GET', '/configs/config/secrets');
      return {
        success: true,
        identity: `Doppler (${this.credentials?.project || 'service token'})`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, key?: string, version?: string): Promise<ResolvedSecret> {
    if (key !== undefined) {
      throw new Error('Doppler secrets are scalar values; select the secret by path instead of key.');
    }
    if (version !== undefined) {
      throw new Error('Doppler secret reads do not support selecting a historical version.');
    }
    // In Doppler, "path" is just the secret name
    // Optionally with project/config prefix: project/config/SECRET_NAME
    const { project, config, secretName } = this.parsePath(path);

    const endpoint = this.buildEndpoint('/configs/config/secret', project, config, { name: secretName });
    const response = await this.request<{ secret: DopplerSecret }>(
      'GET',
      endpoint
    );
    if (response.secret?.name !== secretName) {
      throw new Error(
        `Doppler returned secret ${response.secret?.name ?? '(missing)'}, not requested secret ${secretName}.`
      );
    }

    return {
      value: response.secret.value.computed,
    };
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    const parsed = pathPrefix ? this.parsePath(pathPrefix) : { project: undefined, config: undefined, secretName: '' };
    const { project, config, secretName } = parsed;

    const endpoint = this.buildEndpoint('/configs/config/secrets', project, config);
    const response = await this.request<DopplerSecretsResponse>('GET', endpoint);

    return Object.keys(response.secrets)
      .filter((name) => !secretName || name.startsWith(secretName))
      .map((name) => ({ path: name }));
  }

  /**
   * Parse a Doppler path which can be:
   * - SECRET_NAME (uses token's default project/config)
   * - project/config/SECRET_NAME
   */
  private parsePath(path: string): { project?: string; config?: string; secretName: string } {
    const parts = path.split('/');

    if (parts.length >= 3) {
      return {
        project: parts[0],
        config: parts[1],
        secretName: parts.slice(2).join('/'),
      };
    }

    // Just a secret name
    return {
      project: this.credentials?.project,
      config: this.credentials?.config,
      secretName: path,
    };
  }

  private buildEndpoint(
    base: string,
    project?: string,
    config?: string,
    extra: Record<string, string> = {}
  ): string {
    const params = new URLSearchParams();
    if (project) params.append('project', project);
    if (config) params.append('config', config);
    for (const [key, value] of Object.entries(extra)) params.append(key, value);

    const queryString = params.toString();
    return queryString ? `${base}?${queryString}` : base;
  }

  private async request<T>(
    method: 'GET',
    endpoint: string
  ): Promise<T> {
    if (!this.credentials?.token) {
      throw new Error('Not connected. Call connect() first.');
    }

    const url = endpoint.startsWith('http') ? endpoint : `${DOPPLER_API_URL}${endpoint}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.credentials.token}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = `Doppler API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.messages) {
          errorMessage = errorJson.messages.join(', ');
        } else if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        if (responseText) {
          errorMessage = responseText;
        }
      }
      throw new Error(errorMessage);
    }

    return responseText ? (JSON.parse(responseText) as T) : ({} as T);
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: 'doppler',
    displayName: 'Doppler',
    credentialsSchema: DopplerCredentialsSchema,
    setupHelpUrl: 'https://docs.doppler.com/docs/service-tokens',
    credentials: {
      defaultScalarKey: 'token',
    },
  },
  factory: (_credentials) => {
    const adapter = new DopplerAdapter();
    return adapter;
  },
});
