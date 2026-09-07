import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  CacheCapabilities,
  CacheEngine,
  CacheProvisionResult,
  CacheTargetOptions,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

const MemorystoreAuthenticationSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
}).strict();

/**
 * Placement used to live in connection credentials. Strip those legacy keys
 * so existing encrypted connections continue to authenticate, while desired
 * state is now the sole authority for region/network/tier/size.
 */
export const MemorystoreCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const {
    region: _legacyRegion,
    authorizedNetwork: _legacyNetwork,
    connectMode: _legacyConnectMode,
    tier: _legacyTier,
    memorySizeGb: _legacyMemorySize,
    ...authentication
  } = input as Record<string, unknown>;
  return authentication;
}, MemorystoreAuthenticationSchema);

export type MemorystoreCredentials = z.infer<typeof MemorystoreCredentialsSchema>;

interface ServiceAccountCredentials {
  type: string;
  project_id?: string;
  private_key: string;
  client_email: string;
}

interface MemorystoreInstance {
  name: string;
  displayName?: string;
  locationId?: string;
  alternativeLocationId?: string;
  state?: string;
  host?: string;
  port?: number;
  currentLocationId?: string;
  tier?: string;
  memorySizeGb?: number;
  redisVersion?: string;
  authorizedNetwork?: string;
  connectMode?: string;
  authEnabled?: boolean;
  transitEncryptionMode?: string;
}

interface MemorystoreListResponse {
  instances?: MemorystoreInstance[];
  nextPageToken?: string;
}

interface GoogleOperation {
  name?: string;
  done?: boolean;
  error?: {
    code?: number;
    message?: string;
  };
}

interface AuthStringResponse {
  authString?: string;
}

interface ComputeNetwork {
  name?: string;
  selfLink?: string;
}

interface ComputeSubnetwork {
  name?: string;
  selfLink?: string;
  network?: string;
  region?: string;
}

interface ResolvedNetworkPlacement {
  network: string;
  subnetwork: string;
}

class MemorystoreApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'MemorystoreApiError';
  }
}

const API_ROOT = 'https://redis.googleapis.com/v1';
const COMPUTE_API_ROOT = 'https://compute.googleapis.com/compute/v1';
const DEFAULT_REGION = 'us-central1';
const DEFAULT_ATTEMPTS = 120;
const DEFAULT_DELAY_MS = 5_000;

export class MemorystoreAdapter implements ICacheAdapter {
  readonly name = 'memorystore';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    // The first lifecycle slice deliberately uses private-IP Redis AUTH.
    // Memorystore TLS requires distributing its CA certificate separately
    // from REDIS_URL, which Hypervibe does not yet model.
    supportsTls: false,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
    requiresRuntimeNetwork: true,
  };

  private credentials: MemorystoreCredentials | null = null;
  private serviceAccount: ServiceAccountCredentials | null = null;
  private auth: GoogleAuth | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private target: CacheTargetOptions = {};

  configureTarget(target: CacheTargetOptions): void {
    this.target = Object.fromEntries(
      Object.entries(target).filter(([, value]) => value !== undefined)
    ) as CacheTargetOptions;
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = MemorystoreCredentialsSchema.parse(credentials);
    try {
      this.serviceAccount = JSON.parse(
        this.credentials.credentials
      ) as ServiceAccountCredentials;
    } catch {
      throw new Error('Invalid GCP service account JSON');
    }
    if (!this.serviceAccount.client_email || !this.serviceAccount.private_key) {
      throw new Error('GCP service account JSON must include client_email and private_key');
    }
    this.auth = new GoogleAuth({
      credentials: this.serviceAccount,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials || !this.serviceAccount) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.listInstances(this.target.region ?? DEFAULT_REGION, 1);
      return {
        success: true,
        email: this.serviceAccount.client_email,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccount = null;
    this.auth = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.target = {};
  }

  async provision(
    engine: CacheEngine,
    environment: Environment,
    options?: CacheTargetOptions & {
      resourceName?: string;
      component?: Component | null;
    }
  ): Promise<CacheProvisionResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return this.failedProvision(
        environment,
        engine,
        `Google Cloud Memorystore supports Redis. Requested engine: ${engine}`
      );
    }

    const boundRegion = options?.component?.externalId
      ? this.instanceIdentity(options.component.externalId)?.region
      : undefined;
    const region = options?.region ?? this.target.region ?? boundRegion ?? DEFAULT_REGION;
    const resourceName = options?.resourceName ?? `${environment.name}-redis`;
    const instanceId = this.sanitizeId(resourceName);
    const externalId = options?.component?.externalId ?? this.instanceResourceName(region, instanceId);
    let mutationAttempted = false;
    let placement: ResolvedNetworkPlacement | undefined;

    try {
      let existing: MemorystoreInstance | null = null;
      if (options?.component?.externalId) {
        this.assertBoundComponentScope(options.component, region);
        existing = await this.getInstance(options.component.externalId);
        if (!existing) {
          throw new Error(
            `The bound Memorystore instance ${options.component.externalId} is absent. Refusing to create a replacement under an existing durable binding; re-run hv_plan.`
          );
        }
      } else {
        const matches = await this.findInstancesByName(region, resourceName, instanceId);
        if (matches.length > 0) {
          throw new Error([
            `Google Cloud Memorystore instance "${resourceName}" already exists: ${matches
              .map((instance) => `${instance.displayName ?? this.instanceId(instance.name)} (${instance.name})`)
              .join(', ')}.`,
            'Hypervibe will not choose or silently adopt a name match. Bind/import the intended instance or remove the duplicate, then run hv_plan again.',
          ].join(' '));
        }
      }

      placement = await this.resolveNetworkPlacement({
        region,
        network: options?.network ?? this.target.network,
        subnetwork: options?.subnetwork ?? this.target.subnetwork,
      });

      let ready: MemorystoreInstance;
      if (existing) {
        const liveNetwork = this.normalizeNetworkResource(existing.authorizedNetwork ?? 'default');
        if (liveNetwork !== placement.network) {
          throw new Error(
            `Memorystore authorized network is ${liveNetwork}, but desired state selects ${placement.network}. The instance network is immutable; declare the observed network or explicitly replace the cache.`
          );
        }
        const desiredTier = options?.tier ?? this.target.tier;
        const desiredSize = options?.size ?? this.target.size;
        const patch: Record<string, unknown> = {};
        const updateMask: string[] = [];
        if (desiredTier !== undefined) {
          const tier = this.cacheTier(desiredTier);
          if (existing.tier !== tier) {
            patch.tier = tier;
            updateMask.push('tier');
          }
        }
        if (desiredSize !== undefined) {
          const memorySizeGb = this.memorySize(desiredSize);
          if (existing.memorySizeGb !== memorySizeGb) {
            patch.memorySizeGb = memorySizeGb;
            updateMask.push('memorySizeGb');
          }
        }
        if (updateMask.length > 0) {
          mutationAttempted = true;
          const operation = await this.request<GoogleOperation>('PATCH', `/${existing.name}`, {
            query: { updateMask: updateMask.join(',') },
            body: patch,
          });
          if (!operation.name) {
            throw new Error('Memorystore update response did not include an operation name.');
          }
          await this.waitForOperation(operation.name, 'update');
          ready = await this.waitForInstance(existing.name, 'READY');
        } else {
          ready = existing.state === 'READY'
            ? existing
            : await this.waitForInstance(existing.name, 'READY');
        }
      } else {
        mutationAttempted = true;
        const operation = await this.request<GoogleOperation>(
          'POST',
          `/projects/${encodeURIComponent(this.credentials.projectId)}/locations/${encodeURIComponent(region)}/instances`,
          {
            query: { instanceId },
            body: {
              displayName: resourceName,
              tier: this.cacheTier(options?.tier ?? this.target.tier ?? 'BASIC'),
              memorySizeGb: this.memorySize(options?.size ?? this.target.size ?? '1gb'),
              redisVersion: 'REDIS_7_2',
              authorizedNetwork: placement.network,
              connectMode: 'DIRECT_PEERING',
              authEnabled: true,
              transitEncryptionMode: 'DISABLED',
              labels: {
                managed_by: 'hypervibe',
                environment: this.sanitizeLabel(environment.name),
              },
            },
          }
        );
        if (!operation.name) {
          throw new Error('Memorystore create response did not include an operation name.');
        }
        await this.waitForOperation(operation.name, 'create');
        ready = await this.waitForInstance(externalId, 'READY');
      }
      if (!ready.host || !ready.port) {
        throw new Error(
          `Memorystore instance ${ready.name} became READY without a host and port.`
        );
      }
      const authString = await this.getAuthString(ready.name);
      const connectionUrl = this.connectionUrl(ready.host, ready.port, authString);
      const component = this.component(environment, ready, connectionUrl, placement);

      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `${existing ? 'Reconciled' : 'Created'} and verified Google Cloud Memorystore instance ${this.instanceId(ready.name)}`,
          data: {
            instanceId: ready.name,
            displayName: ready.displayName,
            region,
            status: ready.state,
            tier: ready.tier,
            privateNetworkOnly: true,
          },
        },
      };
    } catch (error) {
      let live: MemorystoreInstance | null | undefined;
      let observationError: string | undefined;
      if (mutationAttempted) {
        try {
          live = await this.getInstance(externalId);
        } catch (observeError) {
          observationError = this.formatError(observeError);
        }
      }
      return {
        component: mutationAttempted
          ? this.partialComponent(environment, externalId, placement)
          : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: mutationAttempted
            ? 'Memorystore creation was attempted, but readiness could not be proven'
            : 'Failed to provision Google Cloud Memorystore',
          error: this.formatError(error),
          data: {
            instanceId: externalId,
            mutationAttempted,
            resourceCreated: live === undefined
              ? (mutationAttempted ? 'unknown' : false)
              : Boolean(live),
            ...(live?.state ? { status: live.state } : {}),
            ...(observationError ? { observationError } : {}),
          },
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    if (typeof stored === 'string') {
      return stored;
    }
    if (!component.externalId) {
      return null;
    }
    const identity = this.instanceIdentity(component.externalId);
    if (!identity) throw new Error(`Invalid Memorystore instance id: ${component.externalId}`);
    this.assertBoundComponentScope(component, identity.region);
    const instance = await this.getInstance(component.externalId);
    if (!instance?.host || !instance.port) {
      return null;
    }
    const authString = await this.getAuthString(instance.name);
    return this.connectionUrl(instance.host, instance.port, authString);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials || !component.externalId) {
      return {
        success: false,
        message: 'Memorystore adapter is not connected or the component has no instance ID',
      };
    }
    try {
      const identity = this.instanceIdentity(component.externalId);
      if (!identity) throw new Error(`Invalid Memorystore instance id: ${component.externalId}`);
      this.assertBoundComponentScope(component, identity.region);
      const existing = await this.getInstance(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Google Cloud Memorystore instance is already absent: ${component.externalId}`,
        };
      }
      const operation = await this.request<GoogleOperation>(
        'DELETE',
        `/${component.externalId}`
      );
      if (!operation.name) {
        throw new Error('Memorystore delete response did not include an operation name.');
      }
      await this.waitForOperation(operation.name, 'delete');
      await this.waitForInstance(component.externalId, 'DELETED');
      return {
        success: true,
        message: `Deleted Google Cloud Memorystore instance ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete Google Cloud Memorystore instance ${component.externalId}`,
        error: this.formatError(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!component.externalId) {
      return { status: 'unknown' };
    }
    try {
      const identity = this.instanceIdentity(component.externalId);
      if (!identity) throw new Error(`Invalid Memorystore instance id: ${component.externalId}`);
      this.assertBoundComponentScope(component, identity.region);
      const instance = await this.getInstance(component.externalId);
      if (!instance) {
        return { status: 'stopped', message: 'Instance is absent' };
      }
      return {
        status: this.normalizedStatus(instance.state),
        message: instance.state,
      };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  async observeCache(
    environment: Environment,
    component?: Component | null,
    options?: CacheTargetOptions & { resourceName?: string }
  ): Promise<ObservedCache | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const boundRegion = component?.externalId
      ? this.instanceIdentity(component.externalId)?.region
      : undefined;
    const region = options?.region ?? this.target.region ?? boundRegion ?? DEFAULT_REGION;
    let instance: MemorystoreInstance | null;
    if (component?.externalId) {
      this.assertBoundComponentScope(component, region);
      instance = await this.getInstance(component.externalId);
    } else {
      const resourceName = options?.resourceName ?? `${environment.name}-redis`;
      const instanceId = this.sanitizeId(resourceName);
      const matches = await this.findInstancesByName(
        region,
        resourceName,
        instanceId
      );
      if (matches.length > 1) {
        throw new Error(
          `Multiple Google Cloud Memorystore instances match "${resourceName}": ${matches
            .map((candidate) => candidate.name)
            .join(', ')}`
        );
      }
      instance = matches[0] ?? null;
    }
    if (!instance && component?.externalId) {
      return null;
    }
    const placement = await this.resolveNetworkPlacement({
      region,
      network: options?.network ?? this.target.network,
      subnetwork: options?.subnetwork ?? this.target.subnetwork,
    });
    if (!instance) return null;
    return {
      provider: 'memorystore',
      engine: 'redis',
      externalId: instance.name,
      providerScope: this.providerScope(instance),
      name: instance.displayName ?? this.instanceId(instance.name),
      status: this.normalizedStatus(instance.state),
      config: {
        region: this.providerScope(instance).region,
        network: this.normalizeNetworkResource(instance.authorizedNetwork ?? placement.network),
        subnetwork: placement.subnetwork,
        ...(instance.tier ? { tier: instance.tier } : {}),
        ...(instance.memorySizeGb ? { size: `${instance.memorySizeGb}gb` } : {}),
      },
    };
  }

  async inspectCacheResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const candidates = request.id
      ? [await this.getInstance(request.id)].filter(
        (instance): instance is MemorystoreInstance => Boolean(instance)
      )
      : await this.listInstances(request.region ?? '-');
    const matched = candidates.filter((instance) => {
      if (!request.name) return true;
      const expected = request.name.toLowerCase();
      return instance.name.toLowerCase() === expected
        || this.instanceId(instance.name).toLowerCase() === expected
        || instance.displayName?.toLowerCase() === expected;
    });
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'cache',
      caches: matched.slice(0, request.limit).map((instance) => ({
        id: instance.name,
        name: instance.displayName ?? this.instanceId(instance.name),
        engine: 'redis',
        status: instance.state ?? 'unknown',
        ...(instance.redisVersion ? { engineVersion: instance.redisVersion } : {}),
        providerScope: this.providerScope(instance),
      })),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  private async findInstancesByName(
    region: string,
    displayName: string,
    instanceId: string
  ): Promise<MemorystoreInstance[]> {
    const instances = await this.listInstances(region);
    return instances.filter((instance) =>
      instance.displayName === displayName || this.instanceId(instance.name) === instanceId
    );
  }

  private async listInstances(
    region: string,
    pageSize = 100
  ): Promise<MemorystoreInstance[]> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const instances: MemorystoreInstance[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.request<MemorystoreListResponse>(
        'GET',
        `/projects/${encodeURIComponent(this.credentials.projectId)}/locations/${encodeURIComponent(region)}/instances`,
        {
          query: {
            pageSize,
            pageToken,
          },
        }
      );
      instances.push(...(response.instances ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken);
    return instances;
  }

  private async getInstance(
    resourceName: string
  ): Promise<MemorystoreInstance | null> {
    const expected = this.instanceIdentity(resourceName);
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (!expected) {
      throw new Error(`Invalid Memorystore instance id: ${resourceName}`);
    }
    if (expected.projectId !== this.credentials.projectId) {
      throw new Error(
        `Memorystore instance ${resourceName} belongs to GCP project ${expected.projectId}, not connected project ${this.credentials.projectId}.`
      );
    }
    try {
      const instance = await this.request<MemorystoreInstance>('GET', `/${resourceName}`);
      const observed = this.instanceIdentity(instance?.name);
      if (
        !observed
        || observed.projectId !== expected.projectId
        || observed.region !== expected.region
        || observed.instanceId !== expected.instanceId
      ) {
        const observedName = typeof instance?.name === 'string' && instance.name.trim()
          ? instance.name
          : '<missing or malformed name>';
        throw new Error(
          `Memorystore exact GET for ${resourceName} returned mismatched identity ${observedName}; refusing to use or retain it.`
        );
      }
      return instance;
    } catch (error) {
      if (error instanceof MemorystoreApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async getAuthString(resourceName: string): Promise<string> {
    const response = await this.request<AuthStringResponse>(
      'GET',
      `/${resourceName}/authString`
    );
    if (!response.authString) {
      throw new Error(`Memorystore instance ${resourceName} did not return an auth string.`);
    }
    return response.authString;
  }

  private async waitForOperation(name: string, description: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS',
      DEFAULT_ATTEMPTS
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const operation = await this.request<GoogleOperation>('GET', `/${name}`);
      if (operation.done) {
        if (operation.error) {
          throw new Error(
            `Memorystore ${description} operation failed: ${operation.error.code ?? ''} ${operation.error.message ?? ''}`.trim()
          );
        }
        return;
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    throw new Error(`Memorystore ${description} operation did not finish before timeout.`);
  }

  private async waitForInstance(
    resourceName: string,
    target: 'READY' | 'DELETED'
  ): Promise<MemorystoreInstance> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS',
      DEFAULT_ATTEMPTS
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const instance = await this.getInstance(resourceName);
      if (target === 'DELETED' && !instance) {
        return { name: resourceName, state: 'DELETED' };
      }
      if (target === 'READY' && instance?.state === 'READY') {
        return instance;
      }
      if (instance && /FAILED|SUSPENDED/i.test(instance.state ?? '')) {
        throw new Error(
          `Memorystore instance ${resourceName} entered terminal status ${instance.state}.`
        );
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    throw new Error(
      `Memorystore instance ${resourceName} did not become ${target} before timeout.`
    );
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    }
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      const text = this.safeApiError(await response.text());
      throw new MemorystoreApiError(
        response.status,
        `Google Cloud Memorystore API error: ${response.status} ${text}`
      );
    }
    if (response.status === 204 || response.headers.get('Content-Length') === '0') {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.auth) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }
    const client = await this.auth.getClient();
    const result = await client.getAccessToken();
    const token = typeof result === 'string' ? result : result.token;
    if (!token) {
      throw new Error('Google authentication did not return an access token.');
    }
    this.accessToken = token;
    this.tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    return token;
  }

  private component(
    environment: Environment,
    instance: MemorystoreInstance,
    connectionUrl: string,
    placement: ResolvedNetworkPlacement
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: instance.name,
      bindings: {
        provider: 'memorystore',
        instanceId: instance.name,
        providerScope: this.providerScope(instance),
        connectionString: connectionUrl,
        connectionUrl,
        host: instance.host,
        port: instance.port,
        region: instance.currentLocationId ?? instance.locationId,
        network: placement.network,
        authorizedNetwork: placement.network,
        subnetwork: placement.subnetwork,
        tier: instance.tier,
        size: instance.memorySizeGb ? `${instance.memorySizeGb}gb` : undefined,
        runtimeNetwork: {
          provider: 'cloudrun',
          projectId: this.credentials!.projectId,
          region: this.providerScope(instance).region,
          network: placement.network,
          subnetwork: placement.subnetwork,
          egress: 'PRIVATE_RANGES_ONLY',
        },
        privateNetworkOnly: true,
        transitEncryptionMode: instance.transitEncryptionMode ?? 'DISABLED',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    resourceName: string,
    placement?: ResolvedNetworkPlacement
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: resourceName,
      bindings: {
        provider: 'memorystore',
        instanceId: resourceName,
        providerScope: this.providerScopeForResourceName(resourceName),
        ...(placement ? {
          network: placement.network,
          authorizedNetwork: placement.network,
          subnetwork: placement.subnetwork,
        } : {}),
        privateNetworkOnly: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private emptyComponent(
    environment: Environment,
    engine: CacheEngine
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: engine,
      externalId: null,
      bindings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private failedProvision(
    environment: Environment,
    engine: CacheEngine,
    error: string
  ): CacheProvisionResult {
    return {
      component: this.emptyComponent(environment, engine),
      receipt: {
        success: false,
        message: 'Failed to provision Google Cloud Memorystore',
        error,
      },
    };
  }

  private connectionUrl(host: string, port: number, authString: string): string {
    return `redis://:${encodeURIComponent(authString)}@${host}:${port}`;
  }

  private instanceResourceName(region: string, instanceId: string): string {
    return `projects/${this.credentials!.projectId}/locations/${region}/instances/${instanceId}`;
  }

  private instanceId(resourceName: string): string {
    return resourceName.split('/').at(-1) ?? resourceName;
  }

  private providerScope(instance: MemorystoreInstance): Record<string, string> {
    return this.providerScopeForResourceName(instance.name);
  }

  private providerScopeForResourceName(resourceName: string): Record<string, string> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const identity = this.instanceIdentity(resourceName);
    if (!identity) {
      throw new Error(`Invalid Memorystore instance id: ${resourceName}`);
    }
    if (identity.projectId !== this.credentials.projectId) {
      throw new Error(
        `Memorystore instance ${resourceName} belongs to GCP project ${identity.projectId}, not connected project ${this.credentials.projectId}.`
      );
    }
    return { projectId: identity.projectId, region: identity.region };
  }

  private instanceIdentity(resourceName: unknown): { projectId: string; region: string; instanceId: string } | null {
    if (typeof resourceName !== 'string') return null;
    const match = /^projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)$/.exec(resourceName);
    return match ? { projectId: match[1]!, region: match[2]!, instanceId: match[3]! } : null;
  }

  private assertBoundComponentScope(component: Component, desiredRegion: string): void {
    if (!this.credentials || !component.externalId) {
      throw new Error('Memorystore binding is missing its provider-native instance id.');
    }
    const identity = this.instanceIdentity(component.externalId);
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : undefined;
    if (!identity || typeof scope?.projectId !== 'string' || typeof scope.region !== 'string') {
      throw new Error(
        'Memorystore binding is missing its exact GCP project/region scope; re-observe or explicitly import it before mutation.'
      );
    }
    if (
      identity.projectId !== scope.projectId
      || identity.region !== scope.region
      || identity.projectId !== this.credentials.projectId
      || identity.region !== desiredRegion
    ) {
      throw new Error(
        `Memorystore binding scope ${scope.projectId}/${scope.region} does not match instance ${identity.projectId}/${identity.region} and connected target ${this.credentials.projectId}/${desiredRegion}; refusing cross-scope access.`
      );
    }
  }

  private normalizeNetworkResource(value: string): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const normalized = value.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, '');
    const match = /^projects\/([^/]+)\/global\/networks\/([^/]+)$/.exec(normalized);
    const networkName = match?.[2] ?? (/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(normalized) ? normalized : undefined);
    const projectId = match?.[1] ?? this.credentials.projectId;
    if (!networkName || projectId !== this.credentials.projectId) {
      throw new Error(
        `Cache network must name an existing VPC in connected GCP project ${this.credentials.projectId}; received ${value}.`
      );
    }
    return `projects/${projectId}/global/networks/${networkName}`;
  }

  private normalizeSubnetworkResource(value: string, region: string): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const normalized = value.replace(/^https:\/\/www\.googleapis\.com\/compute\/v1\//, '');
    const match = /^projects\/([^/]+)\/regions\/([^/]+)\/subnetworks\/([^/]+)$/.exec(normalized);
    const subnetworkName = match?.[3] ?? (/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(normalized) ? normalized : undefined);
    const projectId = match?.[1] ?? this.credentials.projectId;
    const subnetRegion = match?.[2] ?? region;
    if (!subnetworkName || projectId !== this.credentials.projectId || subnetRegion !== region) {
      throw new Error(
        `Cache subnetwork must name an existing subnet in ${this.credentials.projectId}/${region}; received ${value}.`
      );
    }
    return `projects/${projectId}/regions/${subnetRegion}/subnetworks/${subnetworkName}`;
  }

  private async resolveNetworkPlacement(target: {
    region: string;
    network?: string;
    subnetwork?: string;
  }): Promise<ResolvedNetworkPlacement> {
    const network = this.normalizeNetworkResource(target.network ?? 'default');
    const networkName = network.split('/').at(-1)!;
    if (networkName !== 'default' && !target.subnetwork) {
      throw new Error(
        `Cache network ${network} requires cache.subnetwork. Hypervibe only defaults the subnet for the existing default VPC and never creates networking implicitly.`
      );
    }
    const subnetwork = this.normalizeSubnetworkResource(
      target.subnetwork ?? 'default',
      target.region
    );
    const subnetworkName = subnetwork.split('/').at(-1)!;
    const [observedNetwork, observedSubnetwork] = await Promise.all([
      this.computeGet<ComputeNetwork>(
        `/projects/${encodeURIComponent(this.credentials!.projectId)}/global/networks/${encodeURIComponent(networkName)}`,
        `VPC network ${network}`
      ),
      this.computeGet<ComputeSubnetwork>(
        `/projects/${encodeURIComponent(this.credentials!.projectId)}/regions/${encodeURIComponent(target.region)}/subnetworks/${encodeURIComponent(subnetworkName)}`,
        `subnetwork ${subnetwork}`
      ),
    ]);
    const observedNetworkId = this.normalizeNetworkResource(observedNetwork.selfLink ?? network);
    const subnetNetwork = observedSubnetwork.network
      ? this.normalizeNetworkResource(observedSubnetwork.network)
      : undefined;
    if (observedNetworkId !== network || subnetNetwork !== network) {
      throw new Error(
        `GCP subnetwork ${subnetwork} is not attached to selected cache network ${network}; choose an existing subnet from that exact VPC.`
      );
    }
    return { network, subnetwork };
  }

  private async computeGet<T>(path: string, label: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${COMPUTE_API_ROOT}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      const detail = this.safeApiError(await response.text());
      if (response.status === 404) {
        throw new Error(
          `${label} does not exist or is not visible. Declare an existing cache.network/cache.subnetwork; Hypervibe will not create a VPC or subnet implicitly.`
        );
      }
      throw new Error(`Google Compute API could not verify ${label}: ${response.status} ${detail}`);
    }
    return await response.json() as T;
  }

  private sanitizeId(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/g, '')
      .slice(0, 40) || 'hypervibe-redis';
  }

  private sanitizeLabel(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 63) || 'environment';
  }

  private memorySize(value?: string): number {
    const parsed = Number((value ?? '').replace(/gb$/i, ''));
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Memorystore cache.size must be a positive whole number of GB (for example "1gb"); received ${value ?? 'empty'}.`);
    }
    return parsed;
  }

  private cacheTier(value: string): 'BASIC' | 'STANDARD_HA' {
    if (value === 'BASIC' || value === 'STANDARD_HA') return value;
    throw new Error(`Memorystore cache.tier must be BASIC or STANDARD_HA; received ${value}.`);
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    if (status === 'READY') return 'running';
    if (['DELETING', 'MAINTENANCE'].includes(status ?? '')) return 'stopped';
    if (['CREATING', 'UPDATING'].includes(status ?? '')) return 'provisioning';
    if (['FAILED', 'SUSPENDED'].includes(status ?? '')) return 'error';
    return 'unknown';
  }

  private safeApiError(text: string): string {
    return text
      .slice(0, 500)
      .replace(/redis(?:s)?:\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URL]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

providerRegistry.register({
  metadata: {
    name: 'memorystore',
    displayName: 'Google Cloud Memorystore',
    category: 'cache',
    credentialsSchema: MemorystoreCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    connectionAliases: ['cloudrun'],
    maturity: {
      lifecycle: {
        cache: {
          status: 'ready-for-live',
          reason: 'Mocked lifecycle and Cloud Run Direct VPC contracts pass; a recent complete live create/noop/update/destroy run is still required for supported status.',
        },
      },
    },
    lifecycle: {
      cacheEngines: ['redis'],
      cacheConnectivity: { compatibleHostingProviders: ['cloudrun'] },
    },
  },
  factory: async (credentials) => {
    const adapter = new MemorystoreAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['cache'],
    defaultResource: 'cache',
    selectors: {
      cache: { mode: 'provider-resource', optional: ['project', 'id', 'name', 'region', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId', 'region'] },
    },
    inspect: (adapter, request) => (
      adapter as MemorystoreAdapter
    ).inspectCacheResources(request),
  },
});
