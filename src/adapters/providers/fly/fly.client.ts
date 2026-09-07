const FLY_API_URL = 'https://api.machines.dev';
const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';

export interface FlyOrganization {
  id?: string;
  slug?: string;
  name?: string;
}

export interface FlyApp {
  id: string;
  name: string;
  organization?: FlyOrganization;
  status?: string;
  machine_count?: number;
}

export interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  init?: { cmd?: string[]; entrypoint?: string[]; exec?: string[] };
  guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  metadata?: Record<string, string>;
  restart?: Record<string, unknown>;
  services?: Array<{
    internal_port?: number;
    protocol?: string;
    autostart?: boolean;
    autostop?: string | boolean;
    min_machines_running?: number;
    ports?: Array<{
      port?: number;
      handlers?: string[];
      force_https?: boolean;
    }>;
    checks?: Array<Record<string, unknown>>;
  }>;
  checks?: Record<string, Record<string, unknown>>;
  schedule?: string;
  [key: string]: unknown;
}

export interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  instance_id?: string;
  config?: FlyMachineConfig;
  image_ref?: { registry?: string; repository?: string; tag?: string; digest?: string };
  checks?: Array<{ name?: string; status?: string; output?: string }>;
}

export interface FlyIpAssignment {
  ip?: string;
  region?: string;
  service_name?: string;
  shared?: boolean;
}

export interface FlyAppSecret {
  name?: string;
  digest?: string;
  created_at?: string;
  updated_at?: string;
}

export interface FlyCertificate {
  hostname: string;
  status?: string;
  configured?: boolean;
  validation?: {
    alpn_configured?: boolean;
    dns_configured?: boolean;
    http_configured?: boolean;
    ownership_txt_configured?: boolean;
  };
  dns_requirements?: {
    a?: string[];
    aaaa?: string[];
    cname?: string;
    acme_challenge?: { name?: string; target?: string };
    ownership?: { name?: string; app_value?: string; org_value?: string };
  };
}

export interface FlyPostgresEndpoint {
  host?: string;
  port?: number;
}

export interface FlyPostgresCluster {
  id: string;
  name: string;
  status?: 'creating' | 'initializing' | 'ready' | 'deleting' | 'deleted' | 'failed' | string;
  region?: string;
  plan?: string;
  pg_major_version?: string;
  organization?: FlyOrganization;
  endpoints?: {
    primary?: {
      direct?: FlyPostgresEndpoint;
      pooler?: FlyPostgresEndpoint;
    };
  };
}

export interface FlyWireGuardPeer {
  id: string;
  name: string;
  pubkey: string;
  region: string;
  peerip: string;
}

export interface FlyCreatedWireGuardPeer {
  peerip: string;
  endpointip: string;
  pubkey: string;
}

export class FlyApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Fly.io API error: ${status}${message ? ` ${message}` : ''}`);
    this.name = 'FlyApiError';
  }
}

export class FlyAppCreationObservationError extends Error {
  constructor(
    readonly appId: string,
    readonly appName: string,
    message: string
  ) {
    super(message);
    this.name = 'FlyAppCreationObservationError';
  }
}

export class FlyClient {
  constructor(
    private readonly apiToken: string,
    readonly organizationSlug: string
  ) {}

  async verifyAccess(): Promise<void> {
    await this.listApps();
  }

  async listApps(): Promise<FlyApp[]> {
    const response = await this.request<{ apps?: FlyApp[] }>('GET', '/v1/apps', {
      query: { org_slug: this.organizationSlug },
    });
    if (!Array.isArray(response.apps)) {
      throw new Error('Fly.io app observation returned an invalid app list.');
    }
    if (response.apps.some((app) => !app.id || !app.name)) {
      throw new Error('Fly.io app observation omitted a durable App identity.');
    }
    if (response.apps.some((app) => (
      app.organization?.slug !== undefined
      && app.organization.slug !== this.organizationSlug
    ))) {
      throw new Error('Fly.io app observation crossed the requested organization scope.');
    }
    return response.apps.map((app) => ({
      ...app,
      organization: {
        ...(app.organization ?? {}),
        slug: this.organizationSlug,
      },
    }));
  }

  async getApp(appName: string): Promise<FlyApp | null> {
    try {
      return await this.request<FlyApp>('GET', `/v1/apps/${encodeURIComponent(appName)}`);
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createApp(appName: string): Promise<FlyApp> {
    const created = await this.request<{ id?: string }>('POST', '/v1/apps', {
      body: { app_name: appName, org_slug: this.organizationSlug },
    });
    if (!created.id) {
      throw new Error(`Fly.io acknowledged app ${appName} without returning its durable ID.`);
    }
    const attempts = this.positiveIntegerEnv('HYPERVIBE_FLY_APP_READY_ATTEMPTS', 30);
    const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_FLY_APP_READY_DELAY_MS', 1000);
    let lastObservationError: string | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const app = await this.getApp(appName);
        if (app) {
          if (app.id !== created.id) {
            throw new Error(
              `Fly.io created app ${created.id}, but ${appName} now resolves to ${app.id}.`
            );
          }
          return app;
        }
      } catch (error) {
        lastObservationError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new FlyAppCreationObservationError(
      created.id,
      appName,
      `Fly.io acknowledged app ${appName} (${created.id}), but it did not converge after ${attempts} checks${lastObservationError ? `: ${lastObservationError}` : '.'}`
    );
  }

  async destroyApp(
    appName: string,
    expectedAppId: string
  ): Promise<{ alreadyAbsent: boolean }> {
    const current = await this.getApp(appName);
    if (!current) return { alreadyAbsent: true };
    if (current.id !== expectedAppId) {
      throw new Error(
        `Fly.io app ${appName} now has ID ${current.id}, not reviewed ID ${expectedAppId}.`
      );
    }
    if (current.organization?.slug !== this.organizationSlug) {
      throw new Error(
        `Fly.io app ${appName} is outside organization ${this.organizationSlug}.`
      );
    }
    try {
      await this.request('DELETE', `/v1/apps/${encodeURIComponent(appName)}`, {
        query: { force: true },
      });
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) {
        return { alreadyAbsent: true };
      }
      throw error;
    }
    const attempts = this.positiveIntegerEnv('HYPERVIBE_FLY_APP_DELETE_ATTEMPTS', 120);
    const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_FLY_APP_DELETE_DELAY_MS', 1000);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.getApp(appName);
      if (!observed) return { alreadyAbsent: false };
      if (observed.id !== expectedAppId) {
        throw new Error(
          `Fly.io app name ${appName} was reused by ${observed.id} while deleting ${expectedAppId}. Hypervibe will not delete the replacement.`
        );
      }
      if (observed.organization?.slug !== this.organizationSlug) {
        throw new Error(
          `Fly.io app ${appName} moved outside organization ${this.organizationSlug} during deletion.`
        );
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(`Fly.io app ${appName} remained observable after ${attempts} deletion checks.`);
  }

  async listMachines(appName: string): Promise<FlyMachine[]> {
    const response = await this.request<FlyMachine[]>(
      'GET',
      `/v1/apps/${encodeURIComponent(appName)}/machines`
    );
    if (!Array.isArray(response)) {
      throw new Error(`Fly.io returned an invalid Machine list for app ${appName}.`);
    }
    return response;
  }

  async getMachine(appName: string, machineId: string): Promise<FlyMachine | null> {
    try {
      const machine = await this.request<FlyMachine>(
        'GET',
        `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`
      );
      if (machine.id !== machineId) {
        throw new Error(
          `Fly.io returned Machine ${machine.id ?? 'without an ID'} when ${machineId} was requested.`
        );
      }
      return machine;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createMachine(input: {
    appName: string;
    name: string;
    region: string;
    config: FlyMachineConfig;
    minSecretsVersion?: number;
    skipLaunch?: boolean;
  }): Promise<FlyMachine> {
    return this.request<FlyMachine>(
      'POST',
      `/v1/apps/${encodeURIComponent(input.appName)}/machines`,
      {
        body: {
          name: input.name,
          region: input.region,
          config: input.config,
          skip_launch: input.skipLaunch ?? false,
          ...(input.minSecretsVersion === undefined
            ? {}
            : { min_secrets_version: input.minSecretsVersion }),
        },
      }
    );
  }

  async updateMachine(input: {
    appName: string;
    machine: FlyMachine;
    config: FlyMachineConfig;
    minSecretsVersion?: number;
    skipLaunch?: boolean;
  }): Promise<FlyMachine> {
    if (!input.machine.id || !input.machine.instance_id) {
      throw new Error('Fly.io Machine update requires a durable Machine ID and current instance version.');
    }
    const updated = await this.request<FlyMachine>(
      'POST',
      `/v1/apps/${encodeURIComponent(input.appName)}/machines/${encodeURIComponent(input.machine.id)}`,
      {
        body: {
          config: input.config,
          current_version: input.machine.instance_id,
          skip_launch: input.skipLaunch ?? false,
          ...(input.minSecretsVersion === undefined
            ? {}
            : { min_secrets_version: input.minSecretsVersion }),
        },
      }
    );
    if (updated.id !== input.machine.id) {
      throw new Error(
        `Fly.io updated Machine ${updated.id ?? 'without an ID'} instead of ${input.machine.id}.`
      );
    }
    return updated;
  }

  async listIpAssignments(appName: string): Promise<FlyIpAssignment[]> {
    const response = await this.request<{ ips?: FlyIpAssignment[] }>(
      'GET',
      `/v1/apps/${encodeURIComponent(appName)}/ip_assignments`
    );
    if (!Array.isArray(response.ips)) {
      throw new Error(`Fly.io returned an invalid IP assignment list for app ${appName}.`);
    }
    if (response.ips.some((assignment) => !assignment.ip)) {
      throw new Error(`Fly.io returned an IP assignment without a durable address for app ${appName}.`);
    }
    return response.ips;
  }

  async assignIp(appName: string, type: 'shared_v4' | 'v6'): Promise<FlyIpAssignment> {
    return this.request<FlyIpAssignment>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/ip_assignments`,
      { body: { type, org_slug: this.organizationSlug } }
    );
  }

  async releaseIp(appName: string, ip: string): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `/v1/apps/${encodeURIComponent(appName)}/ip_assignments/${encodeURIComponent(ip)}`
      );
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return;
      throw error;
    }
  }

  async listSecrets(appName: string): Promise<FlyAppSecret[]> {
    const response = await this.request<{ secrets?: FlyAppSecret[] }>(
      'GET',
      `/v1/apps/${encodeURIComponent(appName)}/secrets`,
      { query: { show_secrets: false } }
    );
    if (!Array.isArray(response.secrets)) {
      throw new Error(`Fly.io returned an invalid secret list for app ${appName}.`);
    }
    if (response.secrets.some((secret) => !secret.name)) {
      throw new Error(`Fly.io returned a secret without a name for app ${appName}.`);
    }
    return response.secrets;
  }

  async updateSecrets(
    appName: string,
    values: Record<string, string | null>
  ): Promise<number | undefined> {
    const response = await this.request<{ version?: number | string }>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/secrets`,
      { body: { values } }
    );
    const version = Number(response.version);
    const observed = new Set((await this.listSecrets(appName)).map((secret) => secret.name));
    const unconverged = Object.entries(values).flatMap(([name, value]) => (
      value === null ? observed.has(name) : !observed.has(name)
    ) ? [name] : []);
    if (unconverged.length > 0) {
      throw new Error(
        `Fly.io secret update did not converge for app ${appName}: ${unconverged.join(', ')}.`
      );
    }
    return Number.isInteger(version) && version >= 0 ? version : undefined;
  }

  async listCertificates(appName: string): Promise<FlyCertificate[]> {
    const certificates: FlyCertificate[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page += 1) {
      const response = await this.request<{
        certificates?: FlyCertificate[];
        next_cursor?: string;
      }>('GET', `/v1/apps/${encodeURIComponent(appName)}/certificates`, {
        query: { limit: 500, ...(cursor ? { cursor } : {}) },
      });
      if (!Array.isArray(response.certificates)) {
        throw new Error(`Fly.io returned an invalid certificate list for app ${appName}.`);
      }
      if (response.certificates.some((certificate) => !certificate.hostname)) {
        throw new Error(`Fly.io returned a certificate without a hostname for app ${appName}.`);
      }
      certificates.push(...response.certificates);
      const next = response.next_cursor?.trim();
      if (!next) return certificates;
      if (seen.has(next)) throw new Error('Fly.io certificate pagination repeated a cursor.');
      seen.add(next);
      cursor = next;
    }
    throw new Error('Fly.io certificate pagination exceeded 1000 pages.');
  }

  async getCertificate(appName: string, hostname: string): Promise<FlyCertificate | null> {
    try {
      const certificate = await this.request<FlyCertificate>(
        'GET',
        `/v1/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}`
      );
      if (certificate.hostname?.toLowerCase() !== hostname.toLowerCase()) {
        throw new Error(
          `Fly.io returned certificate ${certificate.hostname ?? 'without a hostname'} when ${hostname} was requested.`
        );
      }
      return certificate;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createCertificate(appName: string, hostname: string): Promise<FlyCertificate> {
    const created = await this.request<FlyCertificate>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/certificates/acme`,
      { body: { hostname } }
    );
    if (created.hostname?.toLowerCase() !== hostname.toLowerCase()) {
      throw new Error(
        `Fly.io acknowledged certificate ${created.hostname ?? 'without a hostname'} when ${hostname} was requested.`
      );
    }
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_FLY_CERTIFICATE_READY_ATTEMPTS',
      60
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_FLY_CERTIFICATE_READY_DELAY_MS',
      1000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.getCertificate(appName, hostname);
      if (observed) return observed;
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `Fly.io acknowledged certificate ${hostname}, but it remained unobservable after ${attempts} checks.`
    );
  }

  async deleteCertificate(
    appName: string,
    hostname: string
  ): Promise<{ alreadyAbsent: boolean }> {
    if (!await this.getCertificate(appName, hostname)) {
      return { alreadyAbsent: true };
    }
    try {
      await this.request(
        'DELETE',
        `/v1/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}`
      );
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) {
        return { alreadyAbsent: true };
      }
      throw error;
    }
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_FLY_CERTIFICATE_DELETE_ATTEMPTS',
      60
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_FLY_CERTIFICATE_DELETE_DELAY_MS',
      1000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!await this.getCertificate(appName, hostname)) {
        return { alreadyAbsent: false };
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `Fly.io certificate ${hostname} remained observable after ${attempts} deletion checks.`
    );
  }

  async listPostgresClusters(): Promise<FlyPostgresCluster[]> {
    const response = await this.request<{ data?: FlyPostgresCluster[] }>(
      'GET',
      '/v1/postgres',
      { query: { org_slug: this.organizationSlug, include_deleted: false } }
    );
    if (!Array.isArray(response.data)) {
      throw new Error('Fly.io Managed Postgres observation returned an invalid cluster list.');
    }
    if (response.data.some((cluster) => (
      typeof cluster?.id !== 'string'
      || !cluster.id.trim()
      || cluster.id !== cluster.id.trim()
      || typeof cluster.name !== 'string'
      || !cluster.name.trim()
    ))) {
      throw new Error('Fly.io Managed Postgres observation omitted a durable cluster identity.');
    }
    if (response.data.some((cluster) => (
      cluster.organization?.slug !== undefined
      && cluster.organization.slug !== this.organizationSlug
    ))) {
      throw new Error('Fly.io Managed Postgres observation crossed the requested organization scope.');
    }
    return response.data.map((cluster) => ({
      ...cluster,
      organization: {
        ...(cluster.organization ?? {}),
        slug: this.organizationSlug,
      },
    }));
  }

  async getPostgresCluster(clusterId: string): Promise<FlyPostgresCluster | null> {
    try {
      const response = await this.request<{ data?: FlyPostgresCluster }>(
        'GET',
        `/v1/postgres/${encodeURIComponent(clusterId)}`
      );
      if (!response.data?.id || response.data.id !== clusterId) {
        throw new Error(`Fly.io returned an invalid Managed Postgres cluster ${clusterId}.`);
      }
      if (!response.data.organization?.slug) {
        throw new Error(
          `Fly.io Managed Postgres cluster ${clusterId} omitted its organization scope.`
        );
      }
      if (response.data.organization.slug !== this.organizationSlug) {
        throw new Error(
          `Fly.io Managed Postgres cluster ${clusterId} belongs to organization ${response.data.organization.slug}, not ${this.organizationSlug}.`
        );
      }
      return response.data;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createPostgresCluster(input: {
    name: string;
    region: string;
    plan: string;
    diskSizeGb: number;
  }): Promise<FlyPostgresCluster> {
    const response = await this.request<{ data?: FlyPostgresCluster }>(
      'POST',
      '/v1/postgres',
      {
        body: {
          name: input.name,
          org_slug: this.organizationSlug,
          region: input.region,
          plan: input.plan,
          disk_size_gb: input.diskSizeGb,
          pg_major_version: '17',
          pool_mode: 'transaction',
        },
      }
    );
    if (
      typeof response.data?.id !== 'string'
      || !response.data.id.trim()
      || response.data.id !== response.data.id.trim()
    ) {
      throw new Error('Fly.io did not return a Managed Postgres cluster identity.');
    }
    return response.data;
  }

  async waitForPostgresReady(clusterId: string): Promise<FlyPostgresCluster> {
    const attempts = this.positiveIntegerEnv('HYPERVIBE_FLY_DATABASE_READY_ATTEMPTS', 120);
    const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_FLY_DATABASE_READY_DELAY_MS', 5000);
    let latest: FlyPostgresCluster | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      latest = await this.getPostgresCluster(clusterId);
      if (!latest) {
        throw new Error(`Fly.io Managed Postgres cluster ${clusterId} disappeared while provisioning.`);
      }
      if (latest.status === 'ready') return latest;
      if (['failed', 'deleting', 'deleted'].includes(latest.status ?? '')) {
        throw new Error(
          `Fly.io Managed Postgres cluster ${clusterId} entered terminal status ${latest.status}.`
        );
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `Fly.io Managed Postgres cluster ${clusterId} did not become ready after ${attempts} checks (last status: ${latest?.status ?? 'unknown'}).`
    );
  }

  async ensurePostgresDatabase(clusterId: string, name: string): Promise<{ created: boolean }> {
    const path = `/v1/postgres/${encodeURIComponent(clusterId)}/databases`;
    const current = await this.request<{ data?: Array<{ name?: string }> }>('GET', path);
    if (!Array.isArray(current.data)) {
      throw new Error(`Fly.io returned an invalid database list for cluster ${clusterId}.`);
    }
    if (current.data.some((database) => !database.name)) {
      throw new Error(`Fly.io returned a database without a name for cluster ${clusterId}.`);
    }
    if (current.data.some((database) => database.name === name)) return { created: false };
    await this.request('POST', path, { body: { name } });
    const observed = await this.request<{ data?: Array<{ name?: string }> }>('GET', path);
    if (
      !Array.isArray(observed.data)
      || observed.data.some((database) => !database.name)
      || !observed.data.some((database) => database.name === name)
    ) {
      throw new Error(`Fly.io acknowledged database ${name}, but it was not observable afterward.`);
    }
    return { created: true };
  }

  async ensurePostgresUser(
    clusterId: string,
    username: string
  ): Promise<{ created: boolean }> {
    const path = `/v1/postgres/${encodeURIComponent(clusterId)}/users`;
    const current = await this.request<{ data?: Array<{ username?: string; role?: string }> }>('GET', path);
    if (!Array.isArray(current.data)) {
      throw new Error(`Fly.io returned an invalid user list for cluster ${clusterId}.`);
    }
    if (current.data.some((user) => !user.username || !user.role)) {
      throw new Error(`Fly.io returned a user without a complete identity for cluster ${clusterId}.`);
    }
    const existing = current.data.filter((user) => user.username === username);
    if (existing.length > 1) {
      throw new Error(`Fly.io returned duplicate PostgreSQL users named ${username}.`);
    }
    if (existing[0]) {
      if (existing[0].role !== 'schema_admin') {
        throw new Error(`Fly.io PostgreSQL user ${username} has role ${existing[0].role}, not schema_admin.`);
      }
      return { created: false };
    }
    await this.request('POST', path, { body: { username, role: 'schema_admin' } });
    const observed = await this.request<{
      data?: Array<{ username?: string; role?: string }>;
    }>('GET', path);
    const matches = observed.data?.filter((user) => user.username === username);
    if (
      !Array.isArray(observed.data)
      || observed.data.some((user) => !user.username || !user.role)
      || matches?.length !== 1
      || matches[0]?.role !== 'schema_admin'
    ) {
      throw new Error(
        `Fly.io acknowledged PostgreSQL user ${username}, but its exact schema_admin identity was not observable afterward.`
      );
    }
    return { created: true };
  }

  async getPostgresUserCredentials(
    clusterId: string,
    username: string
  ): Promise<{ username: string; password: string }> {
    const response = await this.request<{ data?: { username?: string; password?: string } }>(
      'GET',
      `/v1/postgres/${encodeURIComponent(clusterId)}/users/${encodeURIComponent(username)}/credentials`
    );
    if (response.data?.username !== username || !response.data.password) {
      throw new Error(
        `Fly.io did not return credentials for the exact PostgreSQL user ${username}.`
      );
    }
    return { username: response.data.username, password: response.data.password };
  }

  async destroyPostgresCluster(clusterId: string): Promise<{ alreadyAbsent: boolean }> {
    if (!await this.getPostgresCluster(clusterId)) return { alreadyAbsent: true };
    try {
      await this.request('DELETE', `/v1/postgres/${encodeURIComponent(clusterId)}`);
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) {
        return { alreadyAbsent: true };
      }
      if (error instanceof FlyApiError && error.status === 410) {
        // A previous delete reached Fly.io. Continue observing the exact cluster
        // until the provider confirms terminal absence.
      } else {
        throw error;
      }
    }
    const attempts = this.positiveIntegerEnv('HYPERVIBE_FLY_DATABASE_DELETE_ATTEMPTS', 180);
    const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_FLY_DATABASE_DELETE_DELAY_MS', 5000);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!await this.getPostgresCluster(clusterId)) return { alreadyAbsent: false };
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `Fly.io Managed Postgres cluster ${clusterId} remained observable after ${attempts} deletion checks.`
    );
  }

  async getOrganizationIdentity(): Promise<{ id: string; slug: string }> {
    const response = await this.graphql<{
      organization?: { id?: string; slug?: string };
    }>(`
      query HypervibeFlyOrganization($slug: String!) {
        organization(slug: $slug) { id slug }
      }
    `, { slug: this.organizationSlug });
    const organization = response.organization;
    if (!organization?.id || organization.slug !== this.organizationSlug) {
      throw new Error(
        `Fly.io did not return the durable identity for organization ${this.organizationSlug}.`
      );
    }
    return { id: organization.id, slug: organization.slug };
  }

  async listWireGuardPeers(): Promise<FlyWireGuardPeer[]> {
    const response = await this.graphql<{
      organization?: {
        slug?: string;
        wireGuardPeers?: { nodes?: FlyWireGuardPeer[] };
      };
    }>(`
      query HypervibeFlyWireGuardPeers($slug: String!) {
        organization(slug: $slug) {
          slug
          wireGuardPeers { nodes { id name pubkey region peerip } }
        }
      }
    `, { slug: this.organizationSlug });
    const organization = response.organization;
    const peers = organization?.wireGuardPeers?.nodes;
    if (organization?.slug !== this.organizationSlug || !Array.isArray(peers)) {
      throw new Error('Fly.io WireGuard peer observation was incomplete.');
    }
    if (peers.some((peer) => (
      !peer.id || !peer.name || !peer.pubkey || !peer.region || !peer.peerip
    ))) {
      throw new Error('Fly.io WireGuard peer observation omitted a durable identity.');
    }
    return peers;
  }

  async createWireGuardPeer(input: {
    organizationId: string;
    name: string;
    region: string;
    publicKey: string;
  }): Promise<FlyCreatedWireGuardPeer> {
    const response = await this.graphql<{
      addWireGuardPeer?: Partial<FlyCreatedWireGuardPeer>;
    }>(`
      mutation HypervibeAddFlyWireGuardPeer($input: AddWireGuardPeerInput!) {
        addWireGuardPeer(input: $input) { peerip endpointip pubkey }
      }
    `, {
      input: {
        organizationId: input.organizationId,
        name: input.name,
        pubkey: input.publicKey,
        region: input.region,
        nats: false,
      },
    });
    const peer = response.addWireGuardPeer;
    if (!peer?.peerip || !peer.endpointip || !peer.pubkey) {
      throw new Error('Fly.io did not return a complete WireGuard peer configuration.');
    }
    return {
      peerip: peer.peerip,
      endpointip: peer.endpointip,
      pubkey: peer.pubkey,
    };
  }

  async removeWireGuardPeer(
    organizationId: string,
    peerName: string,
    expectedIdentity?: { id?: string; publicKey: string }
  ): Promise<{ alreadyAbsent: boolean }> {
    const before = await this.listWireGuardPeers();
    const matches = before.filter((peer) => peer.name === peerName);
    if (matches.length === 0) {
      return { alreadyAbsent: true };
    }
    if (matches.length > 1) {
      throw new Error(
        `Fly.io returned multiple WireGuard peers named ${peerName}; refusing ambiguous cleanup.`
      );
    }
    const observed = matches[0]!;
    if (
      expectedIdentity
      && (
        observed.pubkey !== expectedIdentity.publicKey
        || (expectedIdentity.id !== undefined && observed.id !== expectedIdentity.id)
      )
    ) {
      throw new Error(
        `Fly.io WireGuard peer ${peerName} no longer matches the expected durable identity; refusing cleanup.`
      );
    }
    await this.graphql(`
      mutation HypervibeRemoveFlyWireGuardPeer($input: RemoveWireGuardPeerInput!) {
        removeWireGuardPeer(input: $input) { organization { id } }
      }
    `, { input: { organizationId, name: peerName } });
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_FLY_WIREGUARD_DELETE_ATTEMPTS',
      20
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_FLY_WIREGUARD_DELETE_DELAY_MS',
      250
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = await this.listWireGuardPeers();
      if (!current.some((peer) => peer.name === peerName)) {
        return { alreadyAbsent: false };
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `Fly.io WireGuard peer ${peerName} remained observable after ${attempts} deletion checks.`
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
    const url = new URL(`${FLY_API_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url.toString(), {
      method,
      signal: AbortSignal.timeout(
        this.positiveIntegerEnv('HYPERVIBE_FLY_API_TIMEOUT_MS', 30_000)
      ),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new FlyApiError(response.status, this.safeApiError(text));
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Fly.io returned non-JSON for ${method} ${path}.`);
    }
  }

  private async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(FLY_GRAPHQL_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(
        this.positiveIntegerEnv('HYPERVIBE_FLY_API_TIMEOUT_MS', 30_000)
      ),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new FlyApiError(response.status, this.safeApiError(text));
    }
    let payload: {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new Error('Fly.io GraphQL API returned non-JSON.');
    }
    if (payload.errors?.length) {
      const message = payload.errors
        .map((error) => error.message ?? 'unknown GraphQL error')
        .join('; ');
      throw new Error(`Fly.io GraphQL error: ${this.safeApiError(message)}`);
    }
    if (!payload.data) {
      throw new Error('Fly.io GraphQL API returned no data.');
    }
    return payload.data;
  }

  private safeApiError(text: string): string {
    return text
      .slice(0, 500)
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URL]')
      .replace(/"values"\s*:\s*\{[^}]*\}/gi, '"values":"[REDACTED]"')
      .replace(/("(?:password|token|value)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
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
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
