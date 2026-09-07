import { z } from 'zod';
import {
  CreateServerlessCacheCommand,
  DeleteServerlessCacheCommand,
  DescribeServerlessCachesCommand,
  ElastiCacheClient,
  ModifyServerlessCacheCommand,
  type ServerlessCache,
} from '@aws-sdk/client-elasticache';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type SecurityGroup,
  type Subnet,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  CacheCapabilities,
  CacheEngine,
  CacheProvisionResult,
  CacheTargetOptions,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import {
  createUnresolvedCacheNetworkMutation,
  parseUnresolvedCacheNetworkMutation,
  type UnresolvedCacheNetworkCreateMutation,
} from '../../../domain/ports/cache.port.js';
import { databaseCreateMayHaveCommitted } from '../../../domain/ports/database.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  type AwsWorkloadNetwork,
  hasWorkloadSecurityGroupTags,
  parseAwsWorkloadNetworkBinding,
  parseEcsClusterArn,
  workloadNetworksMatch,
  workloadSecurityGroupName,
} from './aws-workload-network.js';

export const ElastiCacheCredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(16, 'AWS access key ID is required'),
  secretAccessKey: z.string().min(32, 'AWS secret access key is required'),
}).strict();

export type ElastiCacheCredentials = z.infer<typeof ElastiCacheCredentialsSchema>;
type ConnectedElastiCacheCredentials = ElastiCacheCredentials & { region: string };

const DEFAULT_ATTEMPTS = 120;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_REGION = 'us-west-2';
const DEFAULT_DATA_STORAGE_GB = 5;
const DEFAULT_ECPU_PER_SECOND = 1000;
const DEFAULT_SNAPSHOT_RETENTION_DAYS = 1;
const CACHE_PORT = 6379;
const AwsRegionSchema = z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, 'AWS region is invalid');

class ElastiCacheNetworkSetupError extends Error {
  constructor(
    message: string,
    readonly groupName: string,
    readonly groupId?: string,
    readonly unresolvedMutation?: UnresolvedCacheNetworkCreateMutation
  ) {
    super(message);
    this.name = 'ElastiCacheNetworkSetupError';
  }
}

export class ElastiCacheAdapter implements ICacheAdapter {
  readonly name = 'elasticache';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: true,
  };

  private credentials: ConnectedElastiCacheCredentials | null = null;
  private elasticache: ElastiCacheClient | null = null;
  private ec2: EC2Client | null = null;
  private sts: STSClient | null = null;
  private accountId: string | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = {
      ...ElastiCacheCredentialsSchema.parse(credentials),
      region: DEFAULT_REGION,
    };
    this.replaceClients();
  }

  configureTarget(target: CacheTargetOptions): void {
    for (const field of ['network', 'subnetwork', 'tier'] as const) {
      if (target[field]) {
        throw new Error(`Amazon ElastiCache uses the exact ECS default-VPC workload network and does not accept cache.${field}.`);
      }
    }
    if (target.size) this.dataStorageGb(target.size);
    const region = target.region ? AwsRegionSchema.parse(target.region) : DEFAULT_REGION;
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (region === this.credentials.region) return;
    this.credentials = { ...this.credentials, region };
    this.accountId = null;
    this.replaceClients();
  }

  private replaceClients(): void {
    if (!this.credentials) return;
    this.elasticache?.destroy();
    this.ec2?.destroy();
    this.sts?.destroy();
    const awsCredentials = {
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
    };
    this.elasticache = new ElastiCacheClient({
      region: this.credentials.region,
      credentials: awsCredentials,
    });
    this.ec2 = new EC2Client({
      region: this.credentials.region,
      credentials: awsCredentials,
    });
    this.sts = new STSClient({
      region: this.credentials.region,
      credentials: awsCredentials,
    });
    this.accountId = null;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials || !this.elasticache || !this.ec2 || !this.sts) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const [caches, subnets, securityGroups, vpcs] = await Promise.all([
        this.elasticache.send(new DescribeServerlessCachesCommand({ MaxResults: 20 })),
        this.ec2.send(new DescribeSubnetsCommand({
          Filters: [{ Name: 'default-for-az', Values: ['true'] }],
        })),
        this.ec2.send(new DescribeSecurityGroupsCommand({
          Filters: [{ Name: 'tag:managed-by', Values: ['hypervibe'] }],
        })),
        this.ec2.send(new DescribeVpcsCommand({
          Filters: [{ Name: 'is-default', Values: ['true'] }],
        })),
        this.resolveAccountId(),
      ]);
      if (!Array.isArray(caches.ServerlessCaches)
        || !Array.isArray(subnets.Subnets)
        || !Array.isArray(securityGroups.SecurityGroups)
        || !Array.isArray(vpcs.Vpcs)) {
        throw new Error('AWS returned a malformed ElastiCache workload-network verification response.');
      }
      if (vpcs.Vpcs.length > 1) {
        throw new Error('AWS returned multiple default VPCs during ElastiCache connection verification.');
      }
      return {
        success: true,
        email: `AWS ElastiCache (${this.credentials.region})`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.elasticache?.destroy();
    this.ec2?.destroy();
    this.sts?.destroy();
    this.elasticache = null;
    this.ec2 = null;
    this.sts = null;
    this.credentials = null;
    this.accountId = null;
  }

  async provision(
    engine: CacheEngine,
    environment: Environment,
    options?: CacheTargetOptions & {
      resourceName?: string;
      component?: Component | null;
    }
  ): Promise<CacheProvisionResult> {
    if (!this.credentials || !this.elasticache || !this.ec2) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return this.failedProvision(
        environment,
        engine,
        `Amazon ElastiCache supports Redis-compatible Valkey. Requested engine: ${engine}`
      );
    }
    const hosting = parseHostingBindings(environment);
    if (hosting.provider !== 'ecs' || !hosting.projectId) {
      return this.failedProvision(
        environment,
        engine,
        'Amazon ElastiCache requires an applied AWS ECS Express project binding before cache provisioning.'
      );
    }
    let hostingRegion: string;
    let hostingAccountId: string;
    try {
      const hostingIdentity = parseEcsClusterArn(hosting.projectId);
      hostingRegion = hostingIdentity.region;
      hostingAccountId = hostingIdentity.accountId;
      if (options?.region && options.region !== hostingRegion) {
        throw new Error(`Amazon ElastiCache cache.region ${options.region} must match the bound ECS workload region ${hostingRegion}.`);
      }
      this.configureTarget({ ...options, region: options?.region ?? hostingRegion });
    } catch (error) {
      return this.failedProvision(environment, engine, this.formatError(error));
    }
    const dataStorageGb = this.dataStorageGb(options?.size);

    const cacheName = this.sanitizeName(
      options?.resourceName ?? `${environment.name}-redis`
    );
    const arnPartition = hosting.projectId.split(':')[1]!;
    const expectedCacheArn = `arn:${arnPartition}:elasticache:${hostingRegion}:${hostingAccountId}:serverlesscache:${cacheName}`;
    let securityGroupId: string | undefined;
    let cacheMutationAttempted = false;
    let created: ServerlessCache | undefined;
    let workloadNetwork: AwsWorkloadNetwork | undefined;

    try {
      const observedCaches = await this.listServerlessCaches();
      if (options?.component?.externalId) {
        return await this.reconcileBoundCache({
          environment,
          component: options.component,
          cacheName,
          dataStorageGb,
          observedCaches,
        });
      }
      const matches = observedCaches.filter(
        (cache) => cache.ServerlessCacheName === cacheName
      );
      if (matches.length > 0) {
        throw new Error([
          `Amazon ElastiCache serverless cache "${cacheName}" already exists: ${matches
            .map((cache) => `${cache.ServerlessCacheName} (${cache.ARN ?? 'ARN unavailable'})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended cache or remove the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      workloadNetwork = await this.resolveWorkloadNetwork(environment);
      const unresolvedNetworkMutation = parseUnresolvedCacheNetworkMutation(
        options?.component?.bindings
      );
      if (options?.component && !options.component.externalId && !unresolvedNetworkMutation) {
        throw new Error(
          'The retained ElastiCache component has no durable cache identity or valid unresolved network-create marker. Hypervibe will not issue another security-group create.'
        );
      }
      if (unresolvedNetworkMutation) {
        this.assertUnresolvedNetworkMutation(
          unresolvedNetworkMutation,
          cacheName,
          workloadNetwork
        );
        let recovered: SecurityGroup | null;
        try {
          recovered = await this.recoverCacheSecurityGroupAfterCreate(
            cacheName,
            workloadNetwork.vpcId
          );
        } catch (recoveryError) {
          throw new ElastiCacheNetworkSetupError(
            `ElastiCache security-group recovery remains unknown: ${this.formatError(recoveryError)}`,
            unresolvedNetworkMutation.resourceName,
            undefined,
            unresolvedNetworkMutation
          );
        }
        if (!recovered?.GroupId) {
          throw new ElastiCacheNetworkSetupError(
            'ElastiCache security-group recovery remains unresolved; Hypervibe will not issue a second create.',
            unresolvedNetworkMutation.resourceName,
            undefined,
            unresolvedNetworkMutation
          );
        }
        securityGroupId = await this.configureCacheSecurityGroup(
          recovered.GroupId,
          cacheName,
          workloadNetwork,
          unresolvedNetworkMutation
        );
      } else {
        securityGroupId = await this.createCacheSecurityGroup(cacheName, workloadNetwork);
      }
      cacheMutationAttempted = true;
      const response = await this.elasticache.send(
        new CreateServerlessCacheCommand({
          ServerlessCacheName: cacheName,
          Description: `Hypervibe managed Valkey cache for ${environment.name}`,
          Engine: 'valkey',
          SecurityGroupIds: [securityGroupId],
          SubnetIds: workloadNetwork.subnetIds,
          CacheUsageLimits: {
            DataStorage: {
              Maximum: dataStorageGb,
              Unit: 'GB',
            },
            ECPUPerSecond: {
              Maximum: DEFAULT_ECPU_PER_SECOND,
            },
          },
          SnapshotRetentionLimit: DEFAULT_SNAPSHOT_RETENTION_DAYS,
          Tags: [
            { Key: 'ManagedBy', Value: 'Hypervibe' },
            { Key: 'Environment', Value: environment.name },
          ],
        })
      );
      created = response.ServerlessCache;
      const ready = await this.waitForCache(
        created?.ARN ?? cacheName,
        cacheName,
        'available'
      );
      if (!ready.ARN) {
        throw new Error(
          `ElastiCache serverless cache ${cacheName} became available without an ARN.`
        );
      }
      if (!ready.Endpoint?.Address || !ready.Endpoint.Port) {
        throw new Error(
          `ElastiCache serverless cache ${cacheName} became available without an endpoint.`
        );
      }
      const connectionUrl = this.connectionUrl(
        ready.Endpoint.Address,
        ready.Endpoint.Port
      );
      const component = this.component(
        environment,
        ready,
        securityGroupId,
        connectionUrl,
        workloadNetwork,
        String(dataStorageGb)
      );
      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created and verified Amazon ElastiCache serverless Valkey cache ${cacheName}`,
          data: {
            cacheArn: ready.ARN,
            cacheName: ready.ServerlessCacheName,
            status: ready.Status,
            engine: ready.Engine,
            securityGroupId,
            region: this.credentials.region,
            size: String(dataStorageGb),
          },
        },
      };
    } catch (error) {
      if (error instanceof ElastiCacheNetworkSetupError) {
        securityGroupId = error.groupId;
      }
      let unresolvedNetworkMutation = error instanceof ElastiCacheNetworkSetupError
        ? error.unresolvedMutation
        : undefined;
      let live = created;
      let liveObservationError: string | undefined;
      let absenceConfirmed = false;
      if (cacheMutationAttempted) {
        try {
          live = await this.recoverCacheIdentityAfterCreate(cacheName) ?? live;
        } catch (observeError) {
          liveObservationError = this.formatError(observeError);
        }
      } else {
        absenceConfirmed = true;
      }

      let liveIdentityProven = false;
      if (live?.ARN && workloadNetwork) {
        try {
          const scope = this.providerScope(live);
          liveIdentityProven = live.ARN === expectedCacheArn
            && live.ServerlessCacheName === cacheName
            && scope.accountId === workloadNetwork.accountId
            && scope.region === workloadNetwork.region;
          if (!liveIdentityProven) {
            liveObservationError = [
              liveObservationError,
              `ElastiCache returned a cache identity that did not match expected ARN ${expectedCacheArn}.`,
            ].filter(Boolean).join(' ');
          }
        } catch (identityError) {
          liveObservationError = [
            liveObservationError,
            `ElastiCache returned malformed cache identity metadata: ${this.formatError(identityError)}`,
          ].filter(Boolean).join(' ');
        }
      }

      if (
        absenceConfirmed
        && securityGroupId
        && workloadNetwork
        && !unresolvedNetworkMutation
      ) {
        try {
          await this.deleteCacheSecurityGroupById(
            securityGroupId,
            cacheName,
            workloadNetwork.vpcId
          );
          securityGroupId = undefined;
          // Exact-id teardown verified terminal absence, so the uncertain
          // network create has been safely reconciled and must not leave a
          // stale marker that blocks all future creates.
          unresolvedNetworkMutation = undefined;
        } catch (cleanupError) {
          liveObservationError = [
            liveObservationError,
            `Security-group cleanup failed: ${this.formatError(cleanupError)}`,
          ].filter(Boolean).join(' ');
        }
      }

      return {
        component: unresolvedNetworkMutation && workloadNetwork
          ? this.unresolvedNetworkComponent(
              environment,
              unresolvedNetworkMutation,
              workloadNetwork
            )
          : liveIdentityProven && live
          ? this.partialComponent(environment, live, securityGroupId, workloadNetwork)
          : (cacheMutationAttempted && !absenceConfirmed) || securityGroupId
            ? this.uncertainComponent(
                environment,
                expectedCacheArn,
                cacheName,
                securityGroupId,
                workloadNetwork
              )
            : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: cacheMutationAttempted
            ? 'ElastiCache creation was attempted, but readiness could not be proven'
            : 'Failed to provision Amazon ElastiCache serverless cache',
          error: this.formatError(error),
          data: {
            cacheName,
            cacheArn: liveIdentityProven ? live?.ARN : cacheMutationAttempted ? expectedCacheArn : undefined,
            cacheMutationAttempted,
            resourceCreated: liveIdentityProven
              ? true
              : cacheMutationAttempted && !absenceConfirmed
                ? 'unknown'
                : false,
            securityGroupId,
            ...(unresolvedNetworkMutation ? {
              networkResourceCreated: 'unknown',
              unresolvedNetworkResource: unresolvedNetworkMutation.resourceName,
            } : {}),
            ...(error instanceof ElastiCacheNetworkSetupError
              ? { securityGroupName: error.groupName }
              : {}),
            ...(liveObservationError ? { liveObservationError } : {}),
          },
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.elasticache || !component.externalId) {
      return null;
    }
    await this.assertComponentScope(component);
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    if (typeof stored === 'string') {
      return stored;
    }
    const cache = await this.cacheForComponent(component);
    if (!cache?.Endpoint?.Address || !cache.Endpoint.Port) {
      return null;
    }
    return this.connectionUrl(cache.Endpoint.Address, cache.Endpoint.Port);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.elasticache || !this.ec2 || !component.externalId) {
      return {
        success: false,
        message: 'ElastiCache adapter is not connected or the component has no cache ARN',
      };
    }
    try {
      await this.assertComponentScope(component);
      const existing = await this.cacheForComponent(component);
      if (existing) {
        if (!existing.ServerlessCacheName) {
          throw new Error(
            `ElastiCache resource ${component.externalId} has no serverless cache name.`
          );
        }
        await this.elasticache.send(new DeleteServerlessCacheCommand({
          ServerlessCacheName: existing.ServerlessCacheName,
        }));
        await this.waitForCache(
          existing.ARN ?? component.externalId,
          existing.ServerlessCacheName,
          'deleted'
        );
      }

      await this.deleteManagedSecurityGroup(component);
      return {
        success: true,
        message: existing
          ? `Deleted Amazon ElastiCache serverless cache ${existing.ServerlessCacheName}`
          : `Amazon ElastiCache serverless cache is already absent: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete Amazon ElastiCache serverless cache ${component.externalId}`,
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
      await this.assertComponentScope(component);
      const cache = await this.cacheForComponent(component);
      if (!cache) {
        return { status: 'stopped', message: 'Cache is absent' };
      }
      return {
        status: this.normalizedStatus(cache.Status),
        message: cache.Status,
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
    const hosting = parseHostingBindings(environment);
    const hostingRegion = hosting.provider === 'ecs' && hosting.projectId
      ? parseEcsClusterArn(hosting.projectId).region
      : undefined;
    if (options?.region && hostingRegion && options.region !== hostingRegion) {
      throw new Error(`Amazon ElastiCache cache.region ${options.region} must match the bound ECS workload region ${hostingRegion}.`);
    }
    this.configureTarget({ ...options, region: options?.region ?? hostingRegion });
    if (component) await this.assertComponentScope(component);
    let cache: ServerlessCache | null;
    if (component?.externalId) {
      cache = await this.cacheByDurableId(component.externalId);
    } else {
      const cacheName = this.sanitizeName(
        options?.resourceName ?? `${environment.name}-redis`
      );
      const matches = (await this.listServerlessCaches()).filter(
        (candidate) => candidate.ServerlessCacheName === cacheName
      );
      if (matches.length > 1) {
        throw new Error(
          `Multiple Amazon ElastiCache serverless caches match "${cacheName}": ${matches
            .map((candidate) => candidate.ARN ?? candidate.ServerlessCacheName)
            .join(', ')}`
        );
      }
      cache = matches[0] ?? null;
    }
    if (!cache) {
      return null;
    }
    if (!cache.ARN) {
      throw new Error(
        `Amazon ElastiCache serverless cache ${cache.ServerlessCacheName ?? '(unnamed)'} has no durable ARN.`
      );
    }
    return {
      provider: 'elasticache',
      engine: 'redis',
      externalId: cache.ARN,
      providerScope: this.providerScope(cache),
      name: cache.ServerlessCacheName,
      status: this.normalizedStatus(cache.Status),
      config: {
        region: this.providerScope(cache).region,
        ...(cache.CacheUsageLimits?.DataStorage?.Maximum
          ? { size: String(cache.CacheUsageLimits.DataStorage.Maximum) }
          : {}),
      },
    };
  }

  async inspectCacheResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    this.configureTarget({ region: request.region });
    const caches = await this.listServerlessCaches();
    const matched = caches
      .filter((cache) => !request.id || cache.ARN === request.id)
      .filter((cache) => !request.name
        || cache.ServerlessCacheName?.toLowerCase() === request.name.toLowerCase());
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'cache',
      caches: matched.slice(0, request.limit).map((cache) => {
        if (!cache.ARN || !cache.ServerlessCacheName) {
          throw new Error('Amazon ElastiCache returned a serverless cache without its durable ARN and name.');
        }
        return {
          id: cache.ARN,
          name: cache.ServerlessCacheName,
          engine: cache.Engine ?? 'valkey',
          status: cache.Status ?? 'unknown',
          providerScope: this.providerScope(cache),
          cleanupSupported: false,
          cleanupUnsupportedReason: 'ElastiCache cache inventory does not include the exact Hypervibe-managed security-group identity required for complete teardown.',
        };
      }),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  private async reconcileBoundCache(params: {
    environment: Environment;
    component: Component;
    cacheName: string;
    dataStorageGb: number;
    observedCaches: ServerlessCache[];
  }): Promise<CacheProvisionResult> {
    if (!this.elasticache) throw new Error('Not connected. Call connect() first.');
    await this.assertComponentScope(params.component);
    const matches = params.observedCaches.filter(
      (cache) => cache.ARN === params.component.externalId
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Bound ElastiCache cache ${params.component.externalId} was not found. Hypervibe will not create a replacement from a stale binding.`
          : `Amazon ElastiCache returned duplicate durable cache identity ${params.component.externalId}.`
      );
    }
    let cache = matches[0]!;
    const boundCacheName = typeof params.component.bindings.cacheName === 'string'
      ? params.component.bindings.cacheName
      : undefined;
    if (!boundCacheName
      || cache.ServerlessCacheName !== boundCacheName
      || cache.ServerlessCacheName !== params.cacheName) {
      throw new Error(`Bound ElastiCache cache ${params.component.externalId} does not match the reviewed cache name ${params.cacheName}.`);
    }
    const network = await this.resolveWorkloadNetwork(params.environment);
    const securityGroupId = typeof params.component.bindings.securityGroupId === 'string'
      ? params.component.bindings.securityGroupId
      : undefined;
    if (!securityGroupId || params.component.bindings.securityGroupManagedByHypervibe !== true) {
      throw new Error(`Bound ElastiCache cache ${params.component.externalId} is missing its managed security-group identity.`);
    }
    this.assertBoundNetworkMetadata(params.component, cache, network, securityGroupId);
    const securityGroup = await this.securityGroupById(securityGroupId);
    if (!securityGroup) {
      throw new Error(`Bound ElastiCache security group ${securityGroupId} is absent; Hypervibe will not replace it implicitly.`);
    }
    this.assertCacheSecurityGroup(securityGroup, params.cacheName, network, true);

    const observedSize = cache.CacheUsageLimits?.DataStorage?.Maximum;
    let updated = false;
    if (observedSize !== params.dataStorageGb) {
      await this.elasticache.send(new ModifyServerlessCacheCommand({
        ServerlessCacheName: params.cacheName,
        CacheUsageLimits: {
          DataStorage: { Maximum: params.dataStorageGb, Unit: 'GB' },
          ECPUPerSecond: {
            Maximum: cache.CacheUsageLimits?.ECPUPerSecond?.Maximum ?? DEFAULT_ECPU_PER_SECOND,
          },
        },
      }));
      cache = await this.waitForCache(
        params.component.externalId!,
        params.cacheName,
        'available',
        params.dataStorageGb
      );
      updated = true;
    }
    if (!cache.Endpoint?.Address || !cache.Endpoint.Port || !cache.ARN) {
      throw new Error(`Bound ElastiCache cache ${params.component.externalId} has no verified endpoint or ARN.`);
    }
    const connectionUrl = this.connectionUrl(cache.Endpoint.Address, cache.Endpoint.Port);
    return {
      component: this.component(
        params.environment,
        cache,
        securityGroupId,
        connectionUrl,
        network,
        String(params.dataStorageGb)
      ),
      connectionUrl,
      envVars: { REDIS_URL: connectionUrl },
      receipt: {
        success: true,
        message: updated
          ? `Updated and verified Amazon ElastiCache serverless Valkey cache ${params.cacheName}`
          : `Verified Amazon ElastiCache serverless Valkey cache ${params.cacheName}`,
        data: {
          cacheArn: cache.ARN,
          cacheName: params.cacheName,
          status: cache.Status,
          engine: cache.Engine,
          securityGroupId,
          region: network.region,
          size: String(params.dataStorageGb),
          updated,
        },
      },
    };
  }

  private assertBoundNetworkMetadata(
    component: Component,
    cache: ServerlessCache,
    network: AwsWorkloadNetwork,
    securityGroupId: string
  ): void {
    const boundSubnets = Array.isArray(component.bindings.subnetIds)
      ? component.bindings.subnetIds.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const observedSubnets = Array.isArray(cache.SubnetIds) ? [...cache.SubnetIds].sort() : [];
    const observedGroups = Array.isArray(cache.SecurityGroupIds) ? [...cache.SecurityGroupIds].sort() : [];
    if (component.bindings.vpcId !== network.vpcId
      || component.bindings.workloadSecurityGroupId !== network.workloadSecurityGroupId
      || !workloadNetworksMatch(network, { ...network, subnetIds: boundSubnets })
      || JSON.stringify(observedSubnets) !== JSON.stringify(network.subnetIds)
      || observedGroups.length !== 1
      || observedGroups[0] !== securityGroupId) {
      throw new Error(`Bound ElastiCache cache ${component.externalId} network identity changed after planning; re-run hv_plan before mutation.`);
    }
  }

  private async resolveWorkloadNetwork(environment: Environment): Promise<AwsWorkloadNetwork> {
    if (!this.credentials || !this.ec2) {
      throw new Error('Not connected. Call connect() first.');
    }
    const hosting = parseHostingBindings(environment);
    if (hosting.provider !== 'ecs' || !hosting.projectId) {
      throw new Error('Amazon ElastiCache requires this environment to be bound to AWS ECS Express before cache provisioning.');
    }
    const cluster = parseEcsClusterArn(hosting.projectId);
    const accountId = await this.resolveAccountId();
    if (cluster.accountId !== accountId || cluster.region !== this.credentials.region) {
      throw new Error(`Bound ECS cluster ${hosting.projectId} is outside the connected AWS account or desired cache region ${this.credentials.region}.`);
    }
    const persisted = parseAwsWorkloadNetworkBinding(environment);
    if (!persisted) {
      throw new Error('The ECS project has no reviewed AWS workload-network binding. Apply the ECS project action before provisioning ElastiCache.');
    }
    if (persisted.accountId !== accountId || persisted.region !== this.credentials.region) {
      throw new Error('The persisted AWS workload-network binding is outside the connected account or desired cache region.');
    }

    const vpcs = await this.ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }));
    if (!Array.isArray(vpcs.Vpcs)) {
      throw new Error('AWS default-VPC observation returned an invalid VPC list.');
    }
    if (vpcs.Vpcs.length !== 1 || !vpcs.Vpcs[0]?.VpcId || vpcs.Vpcs[0].IsDefault !== true) {
      throw new Error('AWS did not return exactly one complete default VPC for the desired ElastiCache region.');
    }
    const vpcId = vpcs.Vpcs[0].VpcId;
    if (vpcId !== persisted.vpcId) {
      throw new Error(`Persisted AWS workload VPC ${persisted.vpcId} is not the exact default VPC ${vpcId}.`);
    }
    const subnetIds = await this.defaultVpcSubnetIds(vpcId);
    const workloadGroup = await this.securityGroupById(persisted.workloadSecurityGroupId);
    if (!workloadGroup) {
      throw new Error(`Bound AWS workload security group ${persisted.workloadSecurityGroupId} is absent; ElastiCache will not create or select a replacement.`);
    }
    if (workloadGroup.GroupName !== workloadSecurityGroupName(cluster.clusterName)
      || workloadGroup.VpcId !== vpcId
      || !hasWorkloadSecurityGroupTags(workloadGroup.Tags, hosting.projectId, environment.id)) {
      throw new Error(`AWS workload security group ${persisted.workloadSecurityGroupId} is outside the reviewed ECS project identity.`);
    }
    const observed: AwsWorkloadNetwork = {
      accountId,
      region: this.credentials.region,
      vpcId,
      subnetIds,
      workloadSecurityGroupId: persisted.workloadSecurityGroupId,
    };
    if (!workloadNetworksMatch(persisted, observed)) {
      throw new Error('The AWS workload-network identity changed after project reconciliation; re-run hv_plan before provisioning ElastiCache.');
    }
    return observed;
  }

  private async defaultVpcSubnetIds(vpcId: string): Promise<string[]> {
    if (!this.ec2) throw new Error('Not connected. Call connect() first.');
    const output = await this.ec2.send(new DescribeSubnetsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'default-for-az', Values: ['true'] },
      ],
    }));
    if (!Array.isArray(output.Subnets)) {
      throw new Error(`AWS returned an invalid default-subnet list for VPC ${vpcId}.`);
    }
    const zones = new Set<string>();
    const subnetIds = output.Subnets.map((subnet: Subnet) => {
      if (!subnet.SubnetId || subnet.VpcId !== vpcId || subnet.DefaultForAz !== true || !subnet.AvailabilityZone) {
        throw new Error(`AWS returned an incomplete or cross-VPC default subnet for ${vpcId}.`);
      }
      zones.add(subnet.AvailabilityZone);
      return subnet.SubnetId;
    });
    if (new Set(subnetIds).size !== subnetIds.length) {
      throw new Error(`AWS returned duplicate default-subnet identities for VPC ${vpcId}.`);
    }
    if (subnetIds.length < 2 || zones.size < 2) {
      throw new Error(`ElastiCache Serverless requires default subnets in at least two availability zones of VPC ${vpcId}.`);
    }
    return subnetIds.sort();
  }

  private async securityGroupById(groupId: string): Promise<SecurityGroup | null> {
    if (!this.ec2) throw new Error('Not connected. Call connect() first.');
    try {
      const output = await this.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
      if (!Array.isArray(output.SecurityGroups)) {
        throw new Error(`AWS returned an invalid security-group collection for ${groupId}.`);
      }
      if (output.SecurityGroups.length !== 1) {
        throw new Error(`AWS returned no exact security group and no InvalidGroup.NotFound response for ${groupId}.`);
      }
      const group = output.SecurityGroups[0]!;
      if (group.GroupId !== groupId) {
        throw new Error(`AWS returned security group ${group.GroupId ?? 'without an ID'} when ${groupId} was requested.`);
      }
      return group;
    } catch (error) {
      if (this.hasErrorName(error, 'InvalidGroup.NotFound')) return null;
      throw error;
    }
  }

  private async cacheSecurityGroupsByName(cacheName: string, vpcId: string): Promise<SecurityGroup[]> {
    if (!this.ec2) throw new Error('Not connected. Call connect() first.');
    const output = await this.ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [this.cacheSecurityGroupName(cacheName)] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }));
    if (!Array.isArray(output.SecurityGroups)) {
      throw new Error(`AWS returned an invalid security-group list for ElastiCache ${cacheName}.`);
    }
    const ids = output.SecurityGroups.map((group) => {
      if (!group.GroupId) throw new Error(`AWS returned an ElastiCache security group without an ID for ${cacheName}.`);
      return group.GroupId;
    });
    if (output.SecurityGroups.length > 1 || new Set(ids).size !== ids.length) {
      throw new Error(`AWS returned duplicate ElastiCache security groups for ${cacheName}.`);
    }
    return output.SecurityGroups;
  }

  private assertCacheSecurityGroup(
    group: SecurityGroup,
    cacheName: string,
    network: AwsWorkloadNetwork,
    requireIngress: boolean
  ): void {
    this.assertCacheSecurityGroupIdentity(group, cacheName, network.vpcId);
    if (!requireIngress) return;
    if (!Array.isArray(group.IpPermissions) || group.IpPermissions.length !== 1) {
      throw new Error(`ElastiCache security group ${group.GroupId} does not have exactly one workload-only ingress rule.`);
    }
    const permission = group.IpPermissions[0]!;
    const pairs = permission.UserIdGroupPairs ?? [];
    if (permission.IpProtocol !== 'tcp'
      || permission.FromPort !== CACHE_PORT
      || permission.ToPort !== CACHE_PORT
      || pairs.length !== 1
      || pairs[0]?.GroupId !== network.workloadSecurityGroupId
      || (permission.IpRanges?.length ?? 0) > 0
      || (permission.Ipv6Ranges?.length ?? 0) > 0
      || (permission.PrefixListIds?.length ?? 0) > 0) {
      throw new Error(`ElastiCache security group ${group.GroupId} ingress is not limited to workload security group ${network.workloadSecurityGroupId} on port ${CACHE_PORT}.`);
    }
  }

  private assertCacheSecurityGroupIdentity(
    group: SecurityGroup,
    cacheName: string,
    vpcId: string
  ): void {
    const tags = new Map((group.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
    if (group.GroupName !== this.cacheSecurityGroupName(cacheName)
      || group.VpcId !== vpcId
      || tags.get('ManagedBy') !== 'Hypervibe'
      || tags.get('Cache') !== cacheName) {
      throw new Error(`ElastiCache security group ${group.GroupId ?? 'without an ID'} is outside the reviewed cache/VPC identity.`);
    }
  }

  private async createCacheSecurityGroup(
    cacheName: string,
    network: AwsWorkloadNetwork
  ): Promise<string> {
    if (!this.ec2) throw new Error('Not connected. Call connect() first.');

    const groupName = this.cacheSecurityGroupName(cacheName);
    const existing = await this.cacheSecurityGroupsByName(cacheName, network.vpcId);
    if (existing.length > 0) {
      throw new Error([
        `An ElastiCache security group already exists for "${cacheName}": ${existing
          .map((group) => group.GroupId)
          .filter(Boolean)
          .join(', ')}.`,
        'Hypervibe will not silently adopt a name match. Import/bind the intended cache state or remove the stale security group.',
      ].join(' '));
    }

    const unresolvedMutation = this.cacheSecurityGroupRecoveryMarker(cacheName, network);
    let groupId: string | undefined;
    let createError: unknown;
    let createMayHaveCommitted = false;
    try {
      const created = await this.ec2.send(new CreateSecurityGroupCommand({
        GroupName: groupName,
        Description: `Valkey access for Hypervibe cache ${cacheName}`,
        VpcId: network.vpcId,
        TagSpecifications: [{
          ResourceType: 'security-group',
          Tags: [
            { Key: 'ManagedBy', Value: 'Hypervibe' },
            { Key: 'Cache', Value: cacheName },
          ],
        }],
      }));
      groupId = created.GroupId;
      if (!groupId) {
        createError = new Error('AWS acknowledged the ElastiCache security-group create without returning its ID.');
        createMayHaveCommitted = true;
      }
    } catch (error) {
      createError = error;
      createMayHaveCommitted = databaseCreateMayHaveCommitted(error);
      if (!createMayHaveCommitted) {
        throw new ElastiCacheNetworkSetupError(
          `AWS definitively rejected the ElastiCache security-group create: ${this.formatError(error)}`,
          groupName
        );
      }
    }
    if (!groupId) {
      try {
        const recovered = await this.recoverCacheSecurityGroupAfterCreate(
          cacheName,
          network.vpcId
        );
        groupId = recovered?.GroupId;
      } catch (recoveryError) {
        throw new ElastiCacheNetworkSetupError(
          `ElastiCache security-group creation outcome is unknown: ${this.formatError(createError)} Recovery failed: ${this.formatError(recoveryError)}`,
          groupName,
          undefined,
          unresolvedMutation
        );
      }
      if (!groupId) {
        throw new ElastiCacheNetworkSetupError(
          `ElastiCache security-group creation outcome is unknown: ${this.formatError(createError)}`,
          groupName,
          undefined,
          unresolvedMutation
        );
      }
    }

    return this.configureCacheSecurityGroup(
      groupId,
      cacheName,
      network,
      createMayHaveCommitted ? unresolvedMutation : undefined
    );
  }

  private async configureCacheSecurityGroup(
    groupId: string,
    cacheName: string,
    network: AwsWorkloadNetwork,
    unresolvedMutation?: UnresolvedCacheNetworkCreateMutation
  ): Promise<string> {
    if (!this.ec2) throw new Error('Not connected. Call connect() first.');
    const groupName = this.cacheSecurityGroupName(cacheName);
    try {
      const createdGroup = await this.recoverCacheSecurityGroupById(groupId);
      if (!createdGroup) {
        throw new Error(
          `ElastiCache security group ${groupId} was not observable after bounded create recovery.`
        );
      }
      this.assertCacheSecurityGroup(createdGroup, cacheName, network, false);
      if ((createdGroup.IpPermissions?.length ?? 0) > 0) {
        this.assertCacheSecurityGroup(createdGroup, cacheName, network, true);
        return groupId;
      }

      await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: CACHE_PORT,
          ToPort: CACHE_PORT,
          UserIdGroupPairs: [{
            GroupId: network.workloadSecurityGroupId,
            Description: 'Hypervibe workload access to ElastiCache',
          }],
        }],
      }));
      const verified = await this.securityGroupById(groupId);
      if (!verified) throw new Error(`ElastiCache security group ${groupId} disappeared after ingress reconciliation.`);
      this.assertCacheSecurityGroup(verified, cacheName, network, true);
      return groupId;
    } catch (error) {
      let ingressConfirmed = false;
      let observationUnknown = false;
      try {
        const observed = await this.securityGroupById(groupId);
        if (observed) {
          this.assertCacheSecurityGroup(observed, cacheName, network, true);
          ingressConfirmed = true;
        }
      } catch {
        observationUnknown = true;
      }
      if (ingressConfirmed) {
        return groupId;
      }
      // A name/scope/ownership recovery marker authorizes exact observation
      // and ingress reconciliation, never deletion. Only an acknowledged
      // provider GroupId from this operation may drive compensating teardown.
      if (unresolvedMutation) {
        throw new ElastiCacheNetworkSetupError(
          `ElastiCache recovered security-group setup remains incomplete: ${this.formatError(error)}`,
          groupName,
          groupId,
          unresolvedMutation
        );
      }
      if (!observationUnknown) {
        try {
          await this.deleteCacheSecurityGroupById(groupId, cacheName, network.vpcId);
        } catch (cleanupError) {
          throw new ElastiCacheNetworkSetupError(
            `ElastiCache ingress failed and security-group cleanup failed: ${this.formatError(cleanupError)}`,
            groupName,
            groupId,
            unresolvedMutation
          );
        }
        throw error;
      }
      throw new ElastiCacheNetworkSetupError(
        `ElastiCache ingress outcome is unknown: ${this.formatError(error)}`,
        groupName,
        groupId,
        unresolvedMutation
      );
    }
  }

  private cacheSecurityGroupRecoveryMarker(
    cacheName: string,
    network: AwsWorkloadNetwork
  ): UnresolvedCacheNetworkCreateMutation {
    return createUnresolvedCacheNetworkMutation({
      resourceName: this.cacheSecurityGroupName(cacheName),
      cacheName,
      providerScope: {
        accountId: network.accountId,
        region: network.region,
      },
      networkScope: {
        vpcId: network.vpcId,
        workloadSecurityGroupId: network.workloadSecurityGroupId,
      },
      ownership: {
        ManagedBy: 'Hypervibe',
        Cache: cacheName,
      },
    });
  }

  private assertUnresolvedNetworkMutation(
    marker: UnresolvedCacheNetworkCreateMutation,
    cacheName: string,
    network: AwsWorkloadNetwork
  ): void {
    const expected = this.cacheSecurityGroupRecoveryMarker(cacheName, network);
    const sameRecord = (
      left: Record<string, string>,
      right: Record<string, string>
    ): boolean => {
      const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
      const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
      return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value], index) => (
          rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value
        ));
    };
    if (
      marker.resourceName !== expected.resourceName
      || marker.cacheName !== expected.cacheName
      || !sameRecord(marker.providerScope, expected.providerScope)
      || !sameRecord(marker.networkScope, expected.networkScope)
      || !sameRecord(marker.ownership, expected.ownership)
    ) {
      throw new ElastiCacheNetworkSetupError(
        'The unresolved ElastiCache security-group marker does not match the current cache name, AWS account/region, VPC, workload security group, and ownership tags. Hypervibe will not retarget or recreate it.',
        marker.resourceName,
        undefined,
        marker
      );
    }
  }

  private async recoverCacheSecurityGroupAfterCreate(
    cacheName: string,
    vpcId: string
  ): Promise<SecurityGroup | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS',
      3
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.cacheSecurityGroupsByName(cacheName, vpcId);
      if (observed.length === 1) {
        this.assertCacheSecurityGroupIdentity(observed[0]!, cacheName, vpcId);
        return observed[0]!;
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    return null;
  }

  private async recoverCacheSecurityGroupById(
    groupId: string
  ): Promise<SecurityGroup | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS',
      3
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.securityGroupById(groupId);
      if (observed) return observed;
      if (attempt < attempts) await this.delay(delayMs);
    }
    return null;
  }

  private async listServerlessCaches(): Promise<ServerlessCache[]> {
    if (!this.elasticache) {
      throw new Error('Not connected. Call connect() first.');
    }
    const caches: ServerlessCache[] = [];
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      const response = await this.elasticache.send(
        new DescribeServerlessCachesCommand({
          MaxResults: 100,
          NextToken: nextToken,
        })
      );
      if (!Array.isArray(response.ServerlessCaches)) {
        throw new Error('Amazon ElastiCache observation returned an invalid serverless-cache list.');
      }
      caches.push(...response.ServerlessCaches);
      nextToken = response.NextToken;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`Amazon ElastiCache pagination repeated token ${nextToken}; cache observation is incomplete.`);
      }
      if (nextToken) seenTokens.add(nextToken);
    } while (nextToken);
    const durableIds = caches.map((cache) => cache.ARN).filter((arn): arn is string => Boolean(arn));
    if (new Set(durableIds).size !== durableIds.length) {
      throw new Error('Amazon ElastiCache observation returned duplicate durable cache identities.');
    }
    return caches;
  }

  private async cacheForComponent(
    component: Component
  ): Promise<ServerlessCache | null> {
    if (!component.externalId) {
      return null;
    }
    return this.cacheByDurableId(component.externalId);
  }

  private async cacheByDurableId(
    externalId: string
  ): Promise<ServerlessCache | null> {
    const caches = await this.listServerlessCaches();
    const matches = caches.filter((cache) => cache.ARN === externalId);
    if (matches.length > 1) {
      throw new Error(`Amazon ElastiCache returned duplicate durable cache identity ${externalId}.`);
    }
    return matches[0] ?? null;
  }

  private async waitForCache(
    durableId: string,
    cacheName: string,
    target: 'available' | 'deleted',
    dataStorageGb?: number
  ): Promise<ServerlessCache> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_READY_ATTEMPTS',
      DEFAULT_ATTEMPTS
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_READY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const caches = await this.listServerlessCaches();
      const cache = caches.find((candidate) =>
        candidate.ARN === durableId
        || (
          !durableId.startsWith('arn:')
          && candidate.ServerlessCacheName === cacheName
        )
      );
      if (target === 'deleted' && !cache) {
        return {
          ARN: durableId,
          ServerlessCacheName: cacheName,
          Status: 'deleted',
        };
      }
      if (target === 'available'
        && cache?.Status?.toLowerCase() === 'available'
        && (dataStorageGb === undefined
          || cache.CacheUsageLimits?.DataStorage?.Maximum === dataStorageGb)) {
        return cache;
      }
      if (cache && /create-failed|failed/i.test(cache.Status ?? '')) {
        throw new Error(
          `ElastiCache serverless cache ${cacheName} entered terminal status ${cache.Status}.`
        );
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    throw new Error(
      `ElastiCache serverless cache ${cacheName} did not become ${target} before timeout.`
    );
  }

  /**
   * ElastiCache inventory is eventually consistent after create. A single
   * empty read cannot prove that a request which lost its response did not
   * commit, so poll only for identity recovery and otherwise retain the
   * deterministic ARN plus its managed network for explicit cleanup.
   */
  private async recoverCacheIdentityAfterCreate(
    cacheName: string
  ): Promise<ServerlessCache | undefined> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_ATTEMPTS',
      6
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_DELAY_MS',
      1000
    );
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const matches = (await this.listServerlessCaches()).filter(
          (cache) => cache.ServerlessCacheName === cacheName
        );
        if (matches.length > 1) {
          throw new Error(
            `Multiple ElastiCache serverless caches named "${cacheName}" appeared after create: ${matches.map((cache) => cache.ARN ?? '(ARN unavailable)').join(', ')}.`
          );
        }
        if (matches.length === 1) return matches[0];
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }

    if (lastError) {
      throw new Error(
        `Could not recover ElastiCache identity after an uncertain create: ${this.formatError(lastError)}`
      );
    }
    return undefined;
  }

  private async deleteManagedSecurityGroup(component: Component): Promise<void> {
    const groupId = component.bindings.securityGroupId;
    if (
      component.bindings.securityGroupManagedByHypervibe === true
      && typeof groupId === 'string'
    ) {
      const cacheName = typeof component.bindings.cacheName === 'string'
        ? component.bindings.cacheName
        : undefined;
      const vpcId = typeof component.bindings.vpcId === 'string'
        ? component.bindings.vpcId
        : undefined;
      if (!cacheName || !vpcId) {
        throw new Error(`ElastiCache security-group binding ${groupId} is missing its exact cacheName/VPC identity; re-import before teardown.`);
      }
      await this.deleteCacheSecurityGroupById(groupId, cacheName, vpcId);
    }
  }

  private async deleteCacheSecurityGroupById(
    groupId: string,
    cacheName: string,
    vpcId: string
  ): Promise<void> {
    if (!this.ec2) {
      throw new Error('Not connected. Call connect() first.');
    }
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_NETWORK_DELETE_ATTEMPTS',
      30
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_NETWORK_DELETE_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const group = await this.securityGroupById(groupId);
      if (!group) return;
      this.assertCacheSecurityGroupIdentity(group, cacheName, vpcId);
      try {
        await this.ec2.send(new DeleteSecurityGroupCommand({
          GroupId: groupId,
        }));
      } catch (error) {
        if (this.hasErrorName(error, 'InvalidGroup.NotFound')) return;
        if (
          this.hasErrorName(error, 'DependencyViolation')
          && attempt < attempts - 1
        ) {
          await this.delay(delayMs);
          continue;
        }
        throw error;
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    const remaining = await this.securityGroupById(groupId);
    if (remaining) {
      this.assertCacheSecurityGroupIdentity(remaining, cacheName, vpcId);
      throw new Error(`ElastiCache security group ${groupId} remained observable after deletion.`);
    }
  }

  private component(
    environment: Environment,
    cache: ServerlessCache,
    securityGroupId: string,
    connectionUrl: string,
    workloadNetwork: AwsWorkloadNetwork,
    size: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: cache.ARN!,
      bindings: {
        provider: 'elasticache',
        instanceId: cache.ARN!,
        providerScope: this.providerScope(cache),
        cacheName: cache.ServerlessCacheName,
        connectionString: connectionUrl,
        connectionUrl,
        host: cache.Endpoint?.Address,
        port: cache.Endpoint?.Port,
        securityGroupId,
        securityGroupManagedByHypervibe: true,
        vpcId: workloadNetwork.vpcId,
        workloadSecurityGroupId: workloadNetwork.workloadSecurityGroupId,
        subnetIds: workloadNetwork.subnetIds,
        size,
        tls: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    cache: ServerlessCache,
    securityGroupId?: string,
    workloadNetwork?: AwsWorkloadNetwork
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: cache.ARN ?? null,
      bindings: {
        provider: 'elasticache',
        instanceId: cache.ARN,
        ...(cache.ARN ? { providerScope: this.providerScope(cache) } : {}),
        cacheName: cache.ServerlessCacheName,
        securityGroupId,
        securityGroupManagedByHypervibe: Boolean(securityGroupId),
        ...(workloadNetwork ? {
          vpcId: workloadNetwork.vpcId,
          workloadSecurityGroupId: workloadNetwork.workloadSecurityGroupId,
          subnetIds: workloadNetwork.subnetIds,
        } : {}),
        tls: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private uncertainComponent(
    environment: Environment,
    expectedCacheArn: string,
    cacheName: string,
    securityGroupId?: string,
    workloadNetwork?: AwsWorkloadNetwork
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: expectedCacheArn,
      bindings: {
        provider: 'elasticache',
        instanceId: expectedCacheArn,
        cacheName,
        securityGroupId,
        securityGroupManagedByHypervibe: Boolean(securityGroupId),
        ...(workloadNetwork ? {
          providerScope: {
            accountId: workloadNetwork.accountId,
            region: workloadNetwork.region,
          },
          vpcId: workloadNetwork.vpcId,
          workloadSecurityGroupId: workloadNetwork.workloadSecurityGroupId,
          subnetIds: workloadNetwork.subnetIds,
        } : {}),
        mutationAttempted: true,
        tls: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private unresolvedNetworkComponent(
    environment: Environment,
    marker: UnresolvedCacheNetworkCreateMutation,
    workloadNetwork: AwsWorkloadNetwork
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: null,
      bindings: {
        provider: 'elasticache',
        providerScope: marker.providerScope,
        cacheName: marker.cacheName,
        vpcId: workloadNetwork.vpcId,
        workloadSecurityGroupId: workloadNetwork.workloadSecurityGroupId,
        subnetIds: workloadNetwork.subnetIds,
        unresolvedNetworkMutation: marker,
        provisioningIncomplete: true,
        tls: true,
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
        message: 'Failed to provision Amazon ElastiCache serverless cache',
        error,
      },
    };
  }

  private connectionUrl(host: string, port: number): string {
    return `rediss://${host}:${port}`;
  }

  private providerScope(cache: ServerlessCache): Record<string, string> {
    const parts = cache.ARN?.split(':') ?? [];
    const region = parts[3] || this.credentials?.region;
    const accountId = parts[4];
    if (!region || !accountId) {
      throw new Error(
        `Amazon ElastiCache cache ${cache.ServerlessCacheName ?? '(unnamed)'} returned an invalid durable ARN.`
      );
    }
    return { accountId, region };
  }

  private async assertComponentScope(component: Component): Promise<void> {
    if (!this.credentials) {
      throw new Error('Amazon ElastiCache adapter is not connected.');
    }
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const accountId = typeof scope?.accountId === 'string'
      ? scope.accountId
      : undefined;
    const region = typeof scope?.region === 'string' ? scope.region : undefined;
    if (!accountId || !region) {
      throw new Error(
        `Amazon ElastiCache binding ${component.externalId ?? component.id} is missing its durable accountId/region provider scope; re-import or re-plan the cache before using it.`
      );
    }
    if (region !== this.credentials.region) {
      throw new Error(
        `Amazon ElastiCache binding scope region ${region} does not match connected region ${this.credentials.region}.`
      );
    }
    const connectedAccountId = await this.resolveAccountId();
    if (accountId !== connectedAccountId) {
      throw new Error(
        `Amazon ElastiCache binding scope account ${accountId} does not match connected account ${connectedAccountId}.`
      );
    }
    const externalId = component.externalId;
    if (externalId?.startsWith('arn:')) {
      const parts = externalId.split(':');
      if (parts[3] !== region || parts[4] !== accountId) {
        throw new Error(
          `Amazon ElastiCache binding ${externalId} does not match its persisted accountId/region provider scope.`
        );
      }
    }
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    if (!this.sts) throw new Error('Amazon STS adapter is not connected.');
    const identity = await this.sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
      throw new Error(
        'AWS did not return a valid account identity for the ElastiCache connection.'
      );
    }
    this.accountId = identity.Account;
    return this.accountId;
  }

  private sanitizeName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/g, '')
      .slice(0, 40) || 'hypervibe-cache';
  }

  private cacheSecurityGroupName(cacheName: string): string {
    return `${cacheName}-hypervibe-cache`;
  }

  private dataStorageGb(value?: string): number {
    if (value === undefined) return DEFAULT_DATA_STORAGE_GB;
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error('Amazon ElastiCache cache.size must be a positive integer number of GB.');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error('Amazon ElastiCache cache.size is outside the supported integer GB range.');
    }
    return parsed;
  }

  private hasErrorName(error: unknown, ...names: string[]): boolean {
    const candidate = error as { name?: string; code?: string };
    return names.includes(candidate?.name ?? '') || names.includes(candidate?.code ?? '');
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const normalized = status?.toLowerCase();
    if (normalized === 'available') return 'running';
    if (normalized === 'deleting') return 'stopped';
    if (['creating', 'modifying'].includes(normalized ?? '')) return 'provisioning';
    if (normalized?.includes('failed')) return 'error';
    return 'unknown';
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
    name: 'elasticache',
    displayName: 'Amazon ElastiCache',
    category: 'cache',
    credentialsSchema: ElastiCacheCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    connectionAliases: ['ecs'],
    maturity: {
      lifecycle: {
        cache: {
          status: 'ready-for-live',
        },
      },
    },
    lifecycle: {
      cacheEngines: ['redis'],
      cacheConnectivity: { compatibleHostingProviders: ['ecs'] },
    },
  },
  factory: async (credentials) => {
    const adapter = new ElastiCacheAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['cache'],
    defaultResource: 'cache',
    selectors: {
      cache: { mode: 'provider-resource', optional: ['project', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['accountId', 'region'] },
    },
    inspect: (adapter, request) => (
      adapter as ElastiCacheAdapter
    ).inspectCacheResources(request),
  },
});
