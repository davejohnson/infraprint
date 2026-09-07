import { DefaultAzureCredential } from '@azure/identity';

const AZURE_MANAGEMENT_URL = 'https://management.azure.com';
const AZURE_RESOURCE_API_VERSION = '2024-11-01';
const AZURE_SUBSCRIPTION_API_VERSION = '2022-12-01';
const PAGE_CAP = 1000;

export type AzureResourceManagerCredentials = {
  authMode?: 'servicePrincipal';
  tenantId: string;
  subscriptionId: string;
  clientId: string;
  clientSecret: string;
  resourceGroup?: string;
} | {
  authMode: 'default';
  subscriptionId: string;
  resourceGroup?: string;
};

type AzureDefaultTokenProvider = () => Promise<string>;

async function defaultAzureTokenProvider(): Promise<string> {
  const access = await new DefaultAzureCredential().getToken('https://management.azure.com/.default');
  if (!access?.token) throw new Error('Azure default credential chain did not return an ARM access token.');
  return access.token;
}

export async function resolveAzureDefaultSubscription(
  preferredSubscriptionId?: string,
  dependencies: { tokenProvider?: AzureDefaultTokenProvider; fetch?: typeof fetch } = {}
): Promise<{ authMode: 'default'; subscriptionId: string }> {
  if (preferredSubscriptionId) {
    if (!/^[0-9a-f-]{36}$/i.test(preferredSubscriptionId)) throw new Error('Azure subscription ID must be a UUID.');
    return { authMode: 'default', subscriptionId: preferredSubscriptionId };
  }
  const token = await (dependencies.tokenProvider ?? defaultAzureTokenProvider)();
  const response = await (dependencies.fetch ?? fetch)(
    `${AZURE_MANAGEMENT_URL}/subscriptions?api-version=2022-12-01`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new AzureResourceManagerError(response.status);
  const payload = await response.json() as { value?: Array<{ subscriptionId?: unknown; state?: unknown }> };
  const subscriptions = (payload.value ?? [])
    .filter((item) => String(item.state ?? '').toLowerCase() === 'enabled')
    .flatMap((item) => typeof item.subscriptionId === 'string' && /^[0-9a-f-]{36}$/i.test(item.subscriptionId)
      ? [item.subscriptionId]
      : []);
  if (subscriptions.length === 1) return { authMode: 'default', subscriptionId: subscriptions[0]! };
  if (subscriptions.length === 0) throw new Error('Azure default credential chain did not expose an enabled subscription.');
  throw new Error('Azure default credential chain can access multiple subscriptions. Reconnect with credentials={"authMode":"default","subscriptionId":"<id>"} to select one explicitly.');
}

interface AzureCollection<T> {
  value?: T[];
  nextLink?: string | null;
}

export class AzureResourceManagerError extends Error {
  constructor(
    readonly status: number,
    message?: string
  ) {
    super(message ?? `Azure Resource Manager API error: ${status}`);
    this.name = 'AzureResourceManagerError';
  }
}

export interface AzureArmResourceIdentity {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

export class AzureResourceManagerClient {
  private accessToken: string | null = null;
  private accessTokenPromise: Promise<string> | null = null;
  private readonly defaultCredential: DefaultAzureCredential | null;

  constructor(readonly credentials: AzureResourceManagerCredentials) {
    this.defaultCredential = credentials.authMode === 'default'
      ? new DefaultAzureCredential()
      : null;
  }

  async verifySubscription(): Promise<void> {
    await this.request(
      'GET',
      `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`,
      AZURE_SUBSCRIPTION_API_VERSION
    );
  }

  async verifyResourceGroup(): Promise<void> {
    const resourceGroup = this.configuredResourceGroup();
    await this.request(
      'GET',
      `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`
        + `/resourceGroups/${encodeURIComponent(resourceGroup)}`,
      AZURE_RESOURCE_API_VERSION
    );
  }

  async servicePrincipalId(): Promise<string> {
    const token = await this.getAccessToken();
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')
      ) as { oid?: unknown };
      if (typeof payload.oid === 'string' && /^[0-9a-f-]{36}$/i.test(payload.oid)) {
        return payload.oid;
      }
    } catch {
      // The stable error below is safe for every output boundary.
    }
    throw new Error(
      'The Azure access token did not identify the service principal object ID.'
    );
  }

  resourceGroupProviderPath(
    namespace: string,
    resourceType: string
  ): string {
    const resourceGroup = this.configuredResourceGroup();
    return `/subscriptions/${encodeURIComponent(this.credentials.subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(resourceGroup)}`
      + `/providers/${namespace}/${resourceType}`;
  }

  resourcePath(
    namespace: string,
    resourceType: string,
    name: string
  ): string {
    return `${this.resourceGroupProviderPath(namespace, resourceType)}/${encodeURIComponent(name)}`;
  }

  parseResourceId(
    value: string,
    namespace: string,
    resourceType: string
  ): AzureArmResourceIdentity {
    const segments = value.split('/').filter(Boolean);
    if (
      segments.length !== 8
      || segments[0]?.toLowerCase() !== 'subscriptions'
      || segments[2]?.toLowerCase() !== 'resourcegroups'
      || segments[4]?.toLowerCase() !== 'providers'
      || segments[5]?.toLowerCase() !== namespace.toLowerCase()
      || segments[6]?.toLowerCase() !== resourceType.toLowerCase()
    ) {
      throw new Error(
        `Invalid Azure ${namespace}/${resourceType} ARM resource ID.`
      );
    }
    const identity = {
      subscriptionId: decodeURIComponent(segments[1]!),
      resourceGroup: decodeURIComponent(segments[3]!),
      name: decodeURIComponent(segments[7]!),
    };
    this.assertConfiguredScope(identity);
    return identity;
  }

  assertConfiguredScope(identity: AzureArmResourceIdentity): void {
    if (
      identity.subscriptionId.toLowerCase()
        !== this.credentials.subscriptionId.toLowerCase()
      || (this.credentials.resourceGroup
        && identity.resourceGroup.toLowerCase()
          !== this.credentials.resourceGroup.toLowerCase())
    ) {
      throw new Error(
        'Azure resource is outside the configured subscription/resource group.'
      );
    }
  }

  async listAll<T>(
    path: string,
    apiVersion: string
  ): Promise<T[]> {
    const output: T[] = [];
    const resourceIds = new Set<string>();
    const visited = new Set<string>();
    let next: string | null = this.withApiVersion(path, apiVersion);
    for (let page = 1; page <= PAGE_CAP && next; page += 1) {
      if (visited.has(next)) {
        throw new Error(
          'Azure Resource Manager pagination returned a repeated nextLink.'
        );
      }
      visited.add(next);
      const body: AzureCollection<T> = await this.request<AzureCollection<T>>(
        'GET',
        next,
        apiVersion
      );
      if (!Array.isArray(body.value)) {
        throw new Error(
          'Azure Resource Manager list observation returned an invalid response.'
        );
      }
      for (const item of body.value) {
        const id = (
          typeof item === 'object'
          && item !== null
          && 'id' in item
          && typeof item.id === 'string'
        )
          ? item.id.toLowerCase()
          : null;
        if (id && resourceIds.has(id)) {
          throw new Error(
            `Azure Resource Manager returned duplicate resource identity ${id}.`
          );
        }
        if (id) resourceIds.add(id);
      }
      output.push(...body.value);
      next = body.nextLink ?? null;
      if (next) this.assertContinuationUrl(next, path);
    }
    if (next) {
      throw new Error(
        `Azure Resource Manager pagination exceeded ${PAGE_CAP} pages.`
      );
    }
    return output;
  }

  async getNullable<T>(
    path: string,
    apiVersion: string
  ): Promise<T | null> {
    try {
      return await this.request<T>('GET', path, apiVersion);
    } catch (error) {
      if (
        error instanceof AzureResourceManagerError
        && error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async deleteIfPresent(path: string, apiVersion: string): Promise<boolean> {
    try {
      await this.request('DELETE', path, apiVersion);
      return true;
    } catch (error) {
      if (error instanceof AzureResourceManagerError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async request<T = void>(
    method: string,
    pathOrUrl: string,
    apiVersion: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.getAccessToken();
    const versioned = this.withApiVersion(pathOrUrl, apiVersion);
    const url = versioned.startsWith('https://')
      ? versioned
      : `${AZURE_MANAGEMENT_URL}${versioned}`;
    this.assertManagementUrl(url);
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
    });
    const text = response.status === 204 ? '' : await response.text();
    if (!response.ok) {
      throw new AzureResourceManagerError(response.status);
    }
    const operation = response.headers.get('azure-asyncoperation')
      ?? response.headers.get('operation-location');
    if (operation) await this.waitForOperation(operation, apiVersion);
    if ((method === 'PUT' || method === 'PATCH') && operation) {
      return this.request<T>('GET', pathOrUrl, apiVersion);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Azure Resource Manager returned invalid JSON.');
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (this.accessTokenPromise) return this.accessTokenPromise;
    this.accessTokenPromise = this.requestAccessToken();
    try {
      this.accessToken = await this.accessTokenPromise;
      return this.accessToken;
    } finally {
      this.accessTokenPromise = null;
    }
  }

  private async requestAccessToken(): Promise<string> {
    if (this.credentials.authMode === 'default') {
      const access = await this.defaultCredential!.getToken('https://management.azure.com/.default');
      if (!access?.token) throw new Error('Azure default credential chain did not return an ARM access token.');
      return access.token;
    }
    const form = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://management.azure.com//.default',
    });
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.credentials.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );
    if (!response.ok) {
      throw new Error(
        `Microsoft Entra token request failed: ${response.status}`
      );
    }
    const text = await response.text();
    let payload: { access_token?: unknown };
    try {
      payload = JSON.parse(text) as { access_token?: unknown };
    } catch {
      throw new Error(
        'Microsoft Entra token endpoint returned invalid JSON.'
      );
    }
    if (
      typeof payload.access_token !== 'string'
      || payload.access_token.length === 0
    ) {
      throw new Error(
        'Microsoft Entra token response did not include an access token.'
      );
    }
    return payload.access_token;
  }

  private async waitForOperation(
    operationUrl: string,
    apiVersion: string
  ): Promise<void> {
    const url = this.withApiVersion(operationUrl, apiVersion);
    this.assertManagementUrl(url);
    for (let attempt = 1; attempt <= 180; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await this.getAccessToken()}`,
        },
      });
      const text = response.status === 204 ? '' : await response.text();
      if (!response.ok) throw new AzureResourceManagerError(response.status);
      let payload: { status?: unknown; properties?: { provisioningState?: unknown } } = {};
      if (text) {
        try {
          payload = JSON.parse(text) as typeof payload;
        } catch {
          throw new Error('Azure Resource Manager operation returned invalid JSON.');
        }
      }
      const status = String(
        payload.status ?? payload.properties?.provisioningState ?? ''
      ).toLowerCase();
      if (['succeeded', 'completed'].includes(status)) return;
      if (['failed', 'canceled', 'cancelled'].includes(status)) {
        throw new Error(`Azure Resource Manager operation ended in ${status}.`);
      }
      if (attempt < 180) await this.delay();
    }
    throw new Error('Azure Resource Manager operation did not reach a terminal state.');
  }

  private withApiVersion(pathOrUrl: string, apiVersion: string): string {
    const url = new URL(
      pathOrUrl,
      `${AZURE_MANAGEMENT_URL}/`
    );
    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', apiVersion);
    }
    return pathOrUrl.startsWith('https://')
      ? url.toString()
      : `${url.pathname}${url.search}`;
  }

  private assertManagementUrl(value: string): void {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== 'management.azure.com'
    ) {
      throw new Error(
        'Azure Resource Manager request URL left management.azure.com.'
      );
    }
  }

  private assertContinuationUrl(value: string, initialPath: string): void {
    this.assertManagementUrl(value);
    const url = new URL(value);
    const expectedPrefix = this.credentials.resourceGroup
      ? `/subscriptions/${this.credentials.subscriptionId}`
        + `/resourceGroups/${this.credentials.resourceGroup}/`
      : `/subscriptions/${this.credentials.subscriptionId}/`;
    if (
      !decodeURIComponent(url.pathname).toLowerCase()
        .startsWith(expectedPrefix.toLowerCase())
    ) {
      throw new Error(
        'Azure Resource Manager pagination left the configured resource group.'
      );
    }
    const expectedPath = new URL(
      initialPath,
      `${AZURE_MANAGEMENT_URL}/`
    ).pathname;
    if (
      decodeURIComponent(url.pathname).toLowerCase()
        !== decodeURIComponent(expectedPath).toLowerCase()
    ) {
      throw new Error(
        'Azure Resource Manager pagination left the observed collection.'
      );
    }
  }

  private configuredResourceGroup(): string {
    if (!this.credentials.resourceGroup) {
      throw new Error('Azure resource-group operation requires a configured resource group.');
    }
    return this.credentials.resourceGroup;
  }

  private async delay(): Promise<void> {
    const value = Number(process.env.HYPERVIBE_AZURE_WAIT_DELAY_MS ?? 1000);
    if (Number.isFinite(value) && value > 0) {
      await new Promise((resolve) => setTimeout(resolve, value));
    }
  }
}
