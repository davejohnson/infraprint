const DIGITALOCEAN_API_URL = 'https://api.digitalocean.com';

export type DigitalOceanDatabaseEngine = 'pg' | 'valkey';

export interface DigitalOceanConnection {
  protocol?: string;
  uri?: string;
  database?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface DigitalOceanDatabaseCluster {
  id: string;
  name: string;
  engine: string;
  version?: string;
  num_nodes?: number;
  region?: string;
  status?: string;
  size?: string;
  connection?: DigitalOceanConnection;
  private_connection?: DigitalOceanConnection;
  db_names?: string[];
  tags?: string[];
}

export interface DigitalOceanAppEnv {
  key: string;
  value?: string;
  scope?: 'RUN_TIME' | 'BUILD_TIME' | 'RUN_AND_BUILD_TIME' | string;
  type?: 'GENERAL' | 'SECRET' | string;
}

export interface DigitalOceanAppImage {
  registry_type: 'DOCR' | 'GHCR' | 'DOCKER_HUB' | string;
  registry?: string;
  repository: string;
  tag?: string;
  digest?: string;
  deploy_on_push?: { enabled?: boolean };
}

export interface DigitalOceanAppComponent {
  name: string;
  image?: DigitalOceanAppImage;
  github?: {
    repo?: string;
    branch?: string;
    deploy_on_push?: boolean;
  };
  git?: {
    repo_clone_url?: string;
    branch?: string;
  };
  envs?: DigitalOceanAppEnv[];
  run_command?: string;
  dockerfile_path?: string;
  source_dir?: string;
  http_port?: number;
  instance_size_slug?: string;
  instance_count?: number;
  routes?: Array<{ path: string }>;
  health_check?: {
    http_path?: string;
    initial_delay_seconds?: number;
    period_seconds?: number;
    timeout_seconds?: number;
    success_threshold?: number;
    failure_threshold?: number;
  };
  kind?: string;
  schedule?: { cron?: string };
}

export interface DigitalOceanAppDomainSpec {
  domain: string;
  type?: 'UNSPECIFIED' | 'DEFAULT' | 'PRIMARY' | 'ALIAS' | string;
  wildcard?: boolean;
  zone?: string;
  minimum_tls_version?: '1.2' | '1.3' | string;
}

export interface DigitalOceanAppDomain {
  id: string;
  phase?: 'UNKNOWN' | 'PENDING' | 'CONFIGURING' | 'ACTIVE' | 'ERROR' | string;
  certificate_expires_at?: string;
  spec: DigitalOceanAppDomainSpec & {
    validations?: Array<{
      txt_name?: string;
      txt_value?: string;
    }>;
  };
}

export interface DigitalOceanAppMaintenance {
  archive?: boolean;
  enabled?: boolean;
  offline_page_url?: string;
}

export interface DigitalOceanAppSpec {
  name: string;
  region?: string;
  domains?: DigitalOceanAppDomainSpec[];
  services?: DigitalOceanAppComponent[];
  workers?: DigitalOceanAppComponent[];
  jobs?: DigitalOceanAppComponent[];
  envs?: DigitalOceanAppEnv[];
  maintenance?: DigitalOceanAppMaintenance;
  [key: string]: unknown;
}

export interface DigitalOceanAppInstance {
  component_name?: string;
  component_type?: 'SERVICE' | 'WORKER' | 'JOB' | string;
  instance_alias?: string;
  instance_name?: string;
}

export interface DigitalOceanApp {
  id: string;
  spec: DigitalOceanAppSpec;
  domains?: DigitalOceanAppDomain[];
  live_url?: string;
  default_ingress?: string;
  active_deployment?: {
    id?: string;
    phase?: string;
    cause?: string;
  };
  in_progress_deployment?: {
    id?: string;
    phase?: string;
  };
}

export interface DigitalOceanContainerRegistry {
  name: string;
  region?: string;
  storage_usage_bytes?: number;
  storage_usage_bytes_updated_at?: string;
  subscription?: {
    tier?: { name?: string; slug?: string };
    created_at?: string;
    updated_at?: string;
  };
}

interface ListClustersResponse {
  databases: DigitalOceanDatabaseCluster[];
  links?: { pages?: { next?: string } };
  meta?: { total?: number };
}

interface ClusterResponse {
  database: DigitalOceanDatabaseCluster;
}

interface DatabaseListResponse {
  dbs: Array<{ name: string }>;
}

interface ListAppsResponse {
  apps: DigitalOceanApp[];
  links?: { pages?: { next?: string } };
  meta?: { total?: number };
}

interface AppResponse {
  app: DigitalOceanApp;
}

interface AppInstancesResponse {
  instances?: DigitalOceanAppInstance[];
}

interface ContainerRegistryResponse {
  registry: DigitalOceanContainerRegistry;
}

interface ListContainerRegistriesResponse {
  registries: DigitalOceanContainerRegistry[];
  links?: { pages?: { next?: string } };
}

interface AccountResponse {
  account: { uuid?: string };
}

export class DigitalOceanApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(`DigitalOcean API error: ${status}${message ? ` ${message}` : ''}`);
    this.name = 'DigitalOceanApiError';
  }
}

export class DigitalOceanClient {
  private accountUuid: string | null = null;

  constructor(private readonly apiToken: string) {}

  async verifyAppAccess(): Promise<void> {
    await this.request<ListAppsResponse>('GET', '/v2/apps', {
      query: { page: 1, per_page: 1 },
    });
  }

  async getContainerRegistry(
    registryName: string
  ): Promise<DigitalOceanContainerRegistry | null> {
    try {
      const response = await this.request<ContainerRegistryResponse>(
        'GET',
        `/v2/registries/${encodeURIComponent(registryName)}`
      );
      if (!response.registry?.name) {
        throw new Error(
          `DigitalOcean returned an invalid container registry response for ${registryName}.`
        );
      }
      if (response.registry.name !== registryName) {
        throw new Error(
          `DigitalOcean returned registry ${response.registry.name} for exact registry lookup ${registryName}.`
        );
      }
      return response.registry;
    } catch (error) {
      if (error instanceof DigitalOceanApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async listContainerRegistries(): Promise<DigitalOceanContainerRegistry[]> {
    const registries: DigitalOceanContainerRegistry[] = [];
    const visitedPages = new Set<number>();
    let page = 1;

    while (true) {
      if (visitedPages.has(page)) {
        throw new Error(`DigitalOcean registry pagination repeated page ${page}.`);
      }
      visitedPages.add(page);
      const response = await this.request<ListContainerRegistriesResponse>(
        'GET',
        '/v2/registries',
        { query: { page, per_page: 200 } }
      );
      if (!Array.isArray(response.registries)) {
        throw new Error('DigitalOcean registry observation returned an invalid registry list.');
      }
      registries.push(...response.registries);
      if (!response.links?.pages?.next) break;
      page += 1;
      if (page > 1000) {
        throw new Error('DigitalOcean registry pagination exceeded 1000 pages.');
      }
    }
    return registries;
  }

  async getAccountUuid(): Promise<string> {
    if (this.accountUuid) return this.accountUuid;
    const response = await this.request<AccountResponse>('GET', '/v2/account');
    const uuid = response.account?.uuid?.trim();
    if (!uuid) {
      throw new Error('DigitalOcean account observation returned no account UUID.');
    }
    this.accountUuid = uuid;
    return this.accountUuid;
  }

  async createContainerRegistry(input: {
    name: string;
    region: string;
  }): Promise<DigitalOceanContainerRegistry> {
    const response = await this.request<ContainerRegistryResponse>(
      'POST',
      '/v2/registries',
      {
        body: {
          name: input.name,
          region: input.region,
          subscription_tier_slug: 'starter',
        },
      }
    );
    if (!response.registry?.name) {
      throw new Error('DigitalOcean returned an invalid container registry create response.');
    }
    if (response.registry.name !== input.name) {
      throw new Error(
        `DigitalOcean created registry ${response.registry.name} instead of reviewed registry ${input.name}.`
      );
    }
    return response.registry;
  }

  async listApps(): Promise<DigitalOceanApp[]> {
    const apps: DigitalOceanApp[] = [];
    const visitedPages = new Set<number>();
    let page = 1;

    while (true) {
      if (visitedPages.has(page)) {
        throw new Error(`DigitalOcean app pagination repeated page ${page}.`);
      }
      visitedPages.add(page);
      const response = await this.request<ListAppsResponse>('GET', '/v2/apps', {
        query: { page, per_page: 200 },
      });
      if (!Array.isArray(response.apps)) {
        throw new Error('DigitalOcean app observation returned an invalid app list.');
      }
      apps.push(...response.apps);
      if (!response.links?.pages?.next) {
        break;
      }
      page += 1;
      if (page > 1000) {
        throw new Error('DigitalOcean app pagination exceeded 1000 pages.');
      }
    }
    return apps;
  }

  async getApp(appId: string): Promise<DigitalOceanApp | null> {
    try {
      const response = await this.request<AppResponse>(
        'GET',
        `/v2/apps/${encodeURIComponent(appId)}`
      );
      if (!response.app?.id) {
        throw new Error(
          `DigitalOcean returned an invalid app response for ${appId}; absence was not confirmed.`
        );
      }
      if (response.app.id !== appId) {
        throw new Error(
          `DigitalOcean returned app ${response.app.id} for exact app lookup ${appId}.`
        );
      }
      return response.app;
    } catch (error) {
      if (error instanceof DigitalOceanApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async findAppsByName(name: string): Promise<DigitalOceanApp[]> {
    const normalized = name.toLowerCase();
    return (await this.listApps()).filter(
      (app) => app.spec?.name?.toLowerCase() === normalized
    );
  }

  async listAppInstances(appId: string): Promise<DigitalOceanAppInstance[]> {
    const response = await this.request<AppInstancesResponse>(
      'GET',
      `/v2/apps/${encodeURIComponent(appId)}/instances`
    );
    if (!Array.isArray(response.instances)) {
      throw new Error(`DigitalOcean returned an invalid running-instance list for app ${appId}.`);
    }
    return response.instances;
  }

  async createApp(spec: DigitalOceanAppSpec): Promise<DigitalOceanApp> {
    const response = await this.request<AppResponse>('POST', '/v2/apps', {
      body: { spec },
    });
    return response.app;
  }

  async updateApp(
    appId: string,
    spec: DigitalOceanAppSpec
  ): Promise<DigitalOceanApp> {
    const response = await this.request<AppResponse>(
      'PUT',
      `/v2/apps/${encodeURIComponent(appId)}`,
      { body: { spec } }
    );
    return response.app;
  }

  async destroyApp(appId: string): Promise<{ alreadyAbsent: boolean }> {
    if (!await this.getApp(appId)) {
      return { alreadyAbsent: true };
    }
    try {
      await this.request('DELETE', `/v2/apps/${encodeURIComponent(appId)}`);
    } catch (error) {
      if (error instanceof DigitalOceanApiError && error.status === 404) {
        return { alreadyAbsent: true };
      }
      throw error;
    }

    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_APP_DELETE_ATTEMPTS',
      60
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_APP_DELETE_DELAY_MS',
      1000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!await this.getApp(appId)) {
        return { alreadyAbsent: false };
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }
    throw new Error(
      `DigitalOcean app ${appId} was still observable after ${attempts} deletion checks.`
    );
  }

  async verifyDatabaseAccess(): Promise<void> {
    await this.request<ListClustersResponse>('GET', '/v2/databases', {
      query: { page: 1, per_page: 1 },
    });
  }

  async listDatabaseClusters(): Promise<DigitalOceanDatabaseCluster[]> {
    const clusters: DigitalOceanDatabaseCluster[] = [];
    const visitedPages = new Set<number>();
    let page = 1;

    while (true) {
      if (visitedPages.has(page)) {
        throw new Error(`DigitalOcean database pagination repeated page ${page}.`);
      }
      visitedPages.add(page);
      const response = await this.request<ListClustersResponse>(
        'GET',
        '/v2/databases',
        { query: { page, per_page: 200 } }
      );
      if (!Array.isArray(response.databases)) {
        throw new Error('DigitalOcean database observation returned an invalid database list.');
      }
      clusters.push(...response.databases);
      if (!response.links?.pages?.next) {
        break;
      }
      page += 1;
      if (page > 1000) {
        throw new Error('DigitalOcean database pagination exceeded 1000 pages.');
      }
    }
    return clusters;
  }

  async getDatabaseCluster(
    clusterId: string
  ): Promise<DigitalOceanDatabaseCluster | null> {
    try {
      const response = await this.request<ClusterResponse>(
        'GET',
        `/v2/databases/${encodeURIComponent(clusterId)}`
      );
      if (!response.database?.id) {
        throw new Error(
          `DigitalOcean returned an invalid database response for ${clusterId}; absence was not confirmed.`
        );
      }
      if (response.database.id !== clusterId) {
        throw new Error(
          `DigitalOcean returned database ${response.database.id} for exact database lookup ${clusterId}.`
        );
      }
      return response.database;
    } catch (error) {
      if (error instanceof DigitalOceanApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async findDatabaseClustersByName(
    name: string
  ): Promise<DigitalOceanDatabaseCluster[]> {
    const normalized = name.toLowerCase();
    return (await this.listDatabaseClusters()).filter(
      (cluster) => cluster.name.toLowerCase() === normalized
    );
  }

  async createDatabaseCluster(input: {
    name: string;
    engine: DigitalOceanDatabaseEngine;
    version: string;
    region: string;
    size: string;
    numNodes?: number;
  }): Promise<DigitalOceanDatabaseCluster> {
    const response = await this.request<ClusterResponse>(
      'POST',
      '/v2/databases',
      {
        body: {
          name: input.name,
          engine: input.engine,
          version: input.version,
          region: input.region,
          size: input.size,
          num_nodes: input.numNodes ?? 1,
          tags: ['hypervibe'],
        },
      }
    );
    if (
      typeof response.database?.id !== 'string'
      || !response.database.id.trim()
      || response.database.id !== response.database.id.trim()
    ) {
      throw new Error(
        `DigitalOcean acknowledged database cluster create for ${input.name} without a durable cluster ID.`
      );
    }
    return response.database;
  }

  async resizeDatabaseCluster(
    clusterId: string,
    input: { size: string; numNodes: number }
  ): Promise<void> {
    await this.request(
      'PUT',
      `/v2/databases/${encodeURIComponent(clusterId)}/resize`,
      {
        body: {
          size: input.size,
          num_nodes: input.numNodes,
        },
      }
    );
  }

  async migrateDatabaseCluster(
    clusterId: string,
    region: string
  ): Promise<void> {
    await this.request(
      'PUT',
      `/v2/databases/${encodeURIComponent(clusterId)}/migrate`,
      { body: { region } }
    );
  }

  async waitForDatabaseConfiguration(
    clusterId: string,
    expected: { region?: string; size?: string }
  ): Promise<DigitalOceanDatabaseCluster> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS',
      60
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS',
      5000
    );
    let latest: DigitalOceanDatabaseCluster | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      latest = await this.getDatabaseCluster(clusterId);
      if (!latest) {
        throw new Error(
          `DigitalOcean database cluster ${clusterId} disappeared while reconciling its configuration.`
        );
      }
      const status = latest.status?.toLowerCase();
      if (status && ['error', 'failed', 'offline'].includes(status)) {
        throw new Error(
          `DigitalOcean database cluster ${clusterId} entered terminal status ${latest.status}.`
        );
      }
      const regionMatches = expected.region === undefined
        || latest.region === expected.region;
      const sizeMatches = expected.size === undefined
        || latest.size === expected.size;
      if (status === 'online' && regionMatches && sizeMatches) {
        return latest;
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }

    throw new Error(
      `DigitalOcean database cluster ${clusterId} did not converge to the reviewed configuration after ${attempts} checks (last status: ${latest?.status ?? 'unknown'}, region: ${latest?.region ?? 'unknown'}, size: ${latest?.size ?? 'unknown'}).`
    );
  }

  async waitForDatabaseOnline(
    clusterId: string
  ): Promise<DigitalOceanDatabaseCluster> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_DATABASE_READY_ATTEMPTS',
      60
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_DATABASE_READY_DELAY_MS',
      5000
    );
    let latest: DigitalOceanDatabaseCluster | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      latest = await this.getDatabaseCluster(clusterId);
      if (!latest) {
        throw new Error(
          `DigitalOcean database cluster ${clusterId} disappeared while provisioning.`
        );
      }
      const status = latest.status?.toLowerCase();
      if (status === 'online') {
        return latest;
      }
      if (status && ['error', 'failed', 'offline'].includes(status)) {
        throw new Error(
          `DigitalOcean database cluster ${clusterId} entered terminal status ${latest.status}.`
        );
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }

    throw new Error(
      `DigitalOcean database cluster ${clusterId} did not become online after ${attempts} checks (last status: ${latest?.status ?? 'unknown'}).`
    );
  }

  async ensurePostgresDatabase(
    clusterId: string,
    databaseName: string
  ): Promise<{ created: boolean }> {
    const path = `/v2/databases/${encodeURIComponent(clusterId)}/dbs`;
    const existing = await this.request<DatabaseListResponse>('GET', path);
    if (!Array.isArray(existing.dbs)) {
      throw new Error(
        `DigitalOcean returned an invalid logical database list for cluster ${clusterId}.`
      );
    }
    if (existing.dbs.some((database) => database.name === databaseName)) {
      return { created: false };
    }
    await this.request('POST', path, { body: { name: databaseName } });
    return { created: true };
  }

  async destroyDatabaseCluster(
    clusterId: string
  ): Promise<{ alreadyAbsent: boolean }> {
    if (!await this.getDatabaseCluster(clusterId)) {
      return { alreadyAbsent: true };
    }
    try {
      await this.request(
        'DELETE',
        `/v2/databases/${encodeURIComponent(clusterId)}`
      );
    } catch (error) {
      if (error instanceof DigitalOceanApiError && error.status === 404) {
        return { alreadyAbsent: true };
      }
      throw error;
    }

    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_DATABASE_DELETE_ATTEMPTS',
      60
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_DIGITALOCEAN_DATABASE_DELETE_DELAY_MS',
      1000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!await this.getDatabaseCluster(clusterId)) {
        return { alreadyAbsent: false };
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }
    throw new Error(
      `DigitalOcean database cluster ${clusterId} was still observable after ${attempts} deletion checks.`
    );
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const url = new URL(`${DIGITALOCEAN_API_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new DigitalOceanApiError(
        response.status,
        this.safeApiError(await response.text())
      );
    }
    if (response.status === 204) {
      return {} as T;
    }
    const text = await response.text();
    if (text.trim().length === 0) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  private safeApiError(text: string): string {
    return text
      .slice(0, 500)
      .replace(
        /(?:postgres(?:ql)?|rediss?):\/\/[^\s"']+/gi,
        '[REDACTED_CONNECTION_URL]'
      )
      .replace(
        /("(?:value|registry_credentials|password)"\s*:\s*")[^"]*(")/gi,
        '$1[REDACTED]$2'
      )
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}
