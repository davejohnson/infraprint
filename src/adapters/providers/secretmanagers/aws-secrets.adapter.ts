import {
  type ISecretManagerAdapter,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretListItem,
  type AwsSecretsCredentials,
  AwsSecretsCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

interface AwsResolvedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// AWS Signature V4 signing helper
async function signRequest(
  method: string,
  url: URL,
  body: string,
  credentials: AwsSecretsCredentials,
  service: string
): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = credentials.region || 'us-east-1';

  // Create canonical request
  const host = url.host;
  const canonicalUri = url.pathname;
  const canonicalQuerystring = '';
  const payloadHash = await sha256(body);

  const canonicalHeaders = [
    `content-type:application/x-amz-json-1.1`,
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    // Canonical headers must stay sorted; x-amz-security-token sorts after x-amz-date.
    ...(credentials.sessionToken ? [`x-amz-security-token:${credentials.sessionToken}`] : []),
  ].join('\n') + '\n';

  const signedHeaders = credentials.sessionToken
    ? 'content-type;host;x-amz-date;x-amz-security-token'
    : 'content-type;host;x-amz-date';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  // Calculate signature
  const kDate = await hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256Bytes(kDate, region);
  const kService = await hmacSha256Bytes(kRegion, service);
  const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
  const signature = await hmacSha256Hex(kSigning, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Date': amzDate,
    ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
    'Authorization': authorizationHeader,
  };
}

async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacSha256Bytes(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const encoder = new TextEncoder();
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
  const result = await hmacSha256Bytes(key, message);
  return Array.from(new Uint8Array(result))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface AwsSecretValue {
  ARN: string;
  Name: string;
  VersionId: string;
  SecretString?: string;
  SecretBinary?: string;
  VersionStages: string[];
  CreatedDate: number;
}

interface AwsSecretList {
  SecretList: Array<{
    ARN: string;
    Name: string;
    LastChangedDate?: number;
    LastAccessedDate?: number;
    Tags?: Array<{ Key: string; Value: string }>;
  }>;
  NextToken?: string;
}

export class AwsSecretsAdapter implements ISecretManagerAdapter {
  readonly name = 'aws-secrets' as const;

  private credentials: AwsSecretsCredentials | null = null;

  constructor(
    private readonly resolveDefaultCredentials: () => Promise<AwsResolvedCredentials> = defaultProvider()
  ) {}

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AwsSecretsCredentialsSchema.parse(credentials ?? {});

    if (!this.credentials.accessKeyId || !this.credentials.secretAccessKey) {
      try {
        const resolved = await this.resolveDefaultCredentials();
        this.credentials = {
          ...this.credentials,
          accessKeyId: resolved.accessKeyId,
          secretAccessKey: resolved.secretAccessKey,
          ...(resolved.sessionToken ? { sessionToken: resolved.sessionToken } : {}),
        };
      } catch (error) {
        throw new Error(
          'Unable to resolve AWS credentials. Pass accessKeyId + secretAccessKey '
          + 'or configure the AWS SDK default provider chain (environment, shared profile/SSO, web identity, ECS, or EC2 role). '
          + `Resolver error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      // Try to list secrets with max 1 result to verify credentials
      await this.request('ListSecrets', { MaxResults: 1 });
      return {
        success: true,
        identity: `AWS (${this.credentials?.region || 'us-east-1'})`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, key?: string, version?: string): Promise<ResolvedSecret> {
    const params: Record<string, unknown> = { SecretId: path };
    if (version) {
      params.VersionId = version;
    }

    const response = await this.request<AwsSecretValue>('GetSecretValue', params);
    if (version !== undefined && response.VersionId !== version) {
      throw new Error(`AWS Secrets Manager returned version ${response.VersionId}, not requested version ${version}.`);
    }

    let value: string;
    let secretData: Record<string, string> | null = null;

    if (response.SecretString) {
      // Try to parse as JSON
      try {
        secretData = JSON.parse(response.SecretString);
      } catch {
        // Not JSON, use as-is
        value = response.SecretString;
      }

      if (secretData) {
        if (key) {
          if (!(key in secretData)) {
            throw new Error(`Key '${key}' not found in secret at ${path}`);
          }
          value = secretData[key];
        } else {
          // Single key = return value, multiple = return JSON
          const keys = Object.keys(secretData);
          if (keys.length === 1) {
            value = secretData[keys[0]];
          } else {
            value = response.SecretString;
          }
        }
      }
    } else if (response.SecretBinary) {
      if (key !== undefined) {
        throw new Error(`Cannot select key '${key}' from binary secret at ${path}`);
      }
      value = Buffer.from(response.SecretBinary, 'base64').toString('utf-8');
    } else {
      throw new Error(`Secret ${path} has no value`);
    }

    return {
      value: value!,
      version: response.VersionId,
      createdAt: new Date(response.CreatedDate * 1000),
      metadata: secretData ? { keys: Object.keys(secretData).join(',') } : undefined,
    };
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    const secrets: SecretListItem[] = [];
    let nextToken: string | undefined;

    do {
      const params: Record<string, unknown> = { MaxResults: 100 };
      if (nextToken) {
        params.NextToken = nextToken;
      }
      if (pathPrefix) {
        params.Filters = [{ Key: 'name', Values: [pathPrefix] }];
      }

      const response = await this.request<AwsSecretList>('ListSecrets', params);

      for (const secret of response.SecretList) {
        if (pathPrefix && !secret.Name.startsWith(pathPrefix)) continue;
        secrets.push({
          path: secret.Name,
          updatedAt: secret.LastChangedDate
            ? new Date(secret.LastChangedDate * 1000)
            : undefined,
        });
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return secrets;
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.credentials || !this.credentials.accessKeyId) {
      throw new Error('Not connected. Call connect() first.');
    }

    const region = this.credentials.region || 'us-east-1';
    const url = new URL(`https://secretsmanager.${region}.amazonaws.com/`);
    const body = JSON.stringify(params);

    const headers = await signRequest('POST', url, body, this.credentials, 'secretsmanager');
    headers['X-Amz-Target'] = `secretsmanager.${action}`;

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });

    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = `AWS Secrets Manager error: ${response.status}`;
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.message || errorJson.Message) {
          errorMessage = errorJson.message || errorJson.Message;
        }
      } catch {
        if (responseText) {
          errorMessage = responseText;
        }
      }
      throw new Error(errorMessage);
    }

    return JSON.parse(responseText) as T;
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: 'aws-secrets',
    displayName: 'AWS Secrets Manager',
    credentialsSchema: AwsSecretsCredentialsSchema,
    setupHelpUrl: 'https://docs.aws.amazon.com/secretsmanager/',
    credentials: {
      supportsNativeCliAuth: true,
    },
  },
  factory: (_credentials) => {
    const adapter = new AwsSecretsAdapter();
    return adapter;
  },
});
