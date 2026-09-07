import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwsSecretsAdapter } from '../aws-secrets.adapter.js';

function stubListSecretsFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => Response.json({ SecretList: [] }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('AwsSecretsAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('signs requests with X-Amz-Security-Token when a sessionToken is provided', async () => {
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      sessionToken: 'sts-session-token',
    });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    const headers = requestHeaders(fetchMock);
    expect(headers['X-Amz-Security-Token']).toBe('sts-session-token');
    expect(headers['Authorization']).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token'
    );
  });

  it('omits the security token header when no sessionToken is set', async () => {
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    const headers = requestHeaders(fetchMock);
    expect(headers['X-Amz-Security-Token']).toBeUndefined();
    expect(headers['Authorization']).toContain('SignedHeaders=content-type;host;x-amz-date,');
  });

  it('falls back to AWS_SESSION_TOKEN alongside the key environment variables', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA_ENV');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'env-session-token');
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter();
    await adapter.connect({ region: 'us-east-1' });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    const headers = requestHeaders(fetchMock);
    expect(headers['X-Amz-Security-Token']).toBe('env-session-token');
    expect(headers['Authorization']).toContain('Credential=AKIA_ENV/');
  });

  it('uses the AWS SDK default provider chain when explicit keys are omitted', async () => {
    const resolveDefaultCredentials = vi.fn(async () => ({
      accessKeyId: 'AKIA_PROFILE',
      secretAccessKey: 'profile-secret',
      sessionToken: 'profile-session',
    }));
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter(resolveDefaultCredentials);
    await adapter.connect({ region: 'us-west-2' });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(resolveDefaultCredentials).toHaveBeenCalledOnce();
    const headers = requestHeaders(fetchMock);
    expect(headers['Authorization']).toContain('Credential=AKIA_PROFILE/');
    expect(headers['X-Amz-Security-Token']).toBe('profile-session');
  });

  it('rejects a partial explicit key pair instead of mixing credential sources', async () => {
    const adapter = new AwsSecretsAdapter(vi.fn());

    await expect(adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_PARTIAL',
    })).rejects.toThrow('accessKeyId and secretAccessKey must be provided together');
  });

  it('sends and verifies the requested secret version', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app',
      Name: 'app',
      VersionId: 'version-2',
      SecretString: JSON.stringify({ API_KEY: 'secret' }),
      VersionStages: ['AWSCURRENT'],
      CreatedDate: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });

    await expect(adapter.getSecret('app', 'API_KEY', 'version-1')).rejects.toThrow(
      'returned version version-2, not requested version version-1'
    );
    const calls = fetchMock.mock.calls as unknown[][];
    const init = calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ SecretId: 'app', VersionId: 'version-1' });
  });

  it('rejects a key selector for a binary secret instead of ignoring it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:binary',
      Name: 'binary',
      VersionId: 'version-1',
      SecretBinary: Buffer.from('secret').toString('base64'),
      VersionStages: ['AWSCURRENT'],
      CreatedDate: 1,
    })));
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });

    await expect(adapter.getSecret('binary', 'API_KEY')).rejects.toThrow(
      "Cannot select key 'API_KEY' from binary secret"
    );
  });

  it('enforces name prefixes after AWS list responses', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      SecretList: [
        { ARN: 'arn:one', Name: 'production/api' },
        { ARN: 'arn:two', Name: 'staging/api' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });

    await expect(adapter.listSecrets('production/')).resolves.toEqual([
      { path: 'production/api', updatedAt: undefined },
    ]);
    const calls = fetchMock.mock.calls as unknown[][];
    const init = calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      Filters: [{ Key: 'name', Values: ['production/'] }],
    });
  });
});
