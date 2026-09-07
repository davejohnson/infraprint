import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateServerlessCacheCommand,
  DeleteServerlessCacheCommand,
  DescribeServerlessCachesCommand,
  ModifyServerlessCacheCommand,
} from '@aws-sdk/client-elasticache';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import {
  ElastiCacheAdapter,
  ElastiCacheCredentialsSchema,
} from '../elasticache.adapter.js';

const CACHE_NAME = 'invoice-perfect-production-redis';
const CACHE_ARN =
  `arn:aws:elasticache:us-west-2:123456789012:serverlesscache:${CACHE_NAME}`;
const AWS_SECRET = 'aws-secret-access-key-never-output';
const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const VPC_ID = 'vpc-1';
const WORKLOAD_SECURITY_GROUP_ID = 'sg-workload';
const CLUSTER_NAME = 'hv-invoice-perfect-production-0123456789';
const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}`;
const WORKLOAD_SECURITY_GROUP_NAME = `${CLUSTER_NAME}-hypervibe-workloads`;

function environment(): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {
      provider: 'ecs',
      projectId: CLUSTER_ARN,
      environmentId: CLUSTER_ARN,
      services: {},
      awsNetwork: {
        accountId: ACCOUNT_ID,
        region: REGION,
        vpcId: VPC_ID,
        subnetIds: ['subnet-a', 'subnet-b'],
        workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function component(externalId = CACHE_ARN): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: {
      provider: 'elasticache',
      instanceId: externalId,
      providerScope: { accountId: '123456789012', region: 'us-west-2' },
      cacheName: CACHE_NAME,
      securityGroupId: 'sg-cache',
      securityGroupManagedByHypervibe: true,
      vpcId: VPC_ID,
      workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
      subnetIds: ['subnet-a', 'subnet-b'],
      tls: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function unresolvedNetworkComponent(
  markerOverrides: Record<string, unknown> = {}
): Component {
  const marker = {
    resourceKind: 'cache-network',
    operation: 'create',
    resourceName: `${CACHE_NAME}-hypervibe-cache`,
    cacheName: CACHE_NAME,
    providerScope: { accountId: ACCOUNT_ID, region: REGION },
    networkScope: {
      vpcId: VPC_ID,
      workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
    },
    ownership: { ManagedBy: 'Hypervibe', Cache: CACHE_NAME },
    ...markerOverrides,
  };
  return {
    id: 'component-unresolved-network',
    environmentId: 'env-1',
    type: 'redis',
    externalId: null,
    bindings: {
      provider: 'elasticache',
      providerScope: { accountId: ACCOUNT_ID, region: REGION },
      cacheName: CACHE_NAME,
      unresolvedNetworkMutation: marker,
      provisioningIncomplete: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function defaultVpc() {
  return { VpcId: VPC_ID, IsDefault: true };
}

function defaultSubnets() {
  return [
    { SubnetId: 'subnet-a', VpcId: VPC_ID, AvailabilityZone: 'us-west-2a', DefaultForAz: true },
    { SubnetId: 'subnet-b', VpcId: VPC_ID, AvailabilityZone: 'us-west-2b', DefaultForAz: true },
  ];
}

function workloadSecurityGroup() {
  return {
    GroupId: WORKLOAD_SECURITY_GROUP_ID,
    GroupName: WORKLOAD_SECURITY_GROUP_NAME,
    VpcId: VPC_ID,
    Tags: [
      { Key: 'managed-by', Value: 'hypervibe' },
      { Key: 'hypervibe-environment-id', Value: 'env-1' },
      { Key: 'hypervibe-ecs-cluster-arn', Value: CLUSTER_ARN },
    ],
  };
}

function cacheSecurityGroup(withIngress = true) {
  return {
    GroupId: 'sg-cache',
    GroupName: `${CACHE_NAME}-hypervibe-cache`,
    VpcId: VPC_ID,
    Tags: [
      { Key: 'ManagedBy', Value: 'Hypervibe' },
      { Key: 'Cache', Value: CACHE_NAME },
    ],
    IpPermissions: withIngress ? [{
      IpProtocol: 'tcp',
      FromPort: 6379,
      ToPort: 6379,
      UserIdGroupPairs: [{ GroupId: WORKLOAD_SECURITY_GROUP_ID }],
    }] : [],
  };
}

function workloadNetworkResponse(command: unknown): Record<string, unknown> | undefined {
  if (command instanceof DescribeVpcsCommand) return { Vpcs: [defaultVpc()] };
  if (command instanceof DescribeSubnetsCommand) return { Subnets: defaultSubnets() };
  if (command instanceof DescribeSecurityGroupsCommand
    && command.input.GroupIds?.[0] === WORKLOAD_SECURITY_GROUP_ID) {
    return { SecurityGroups: [workloadSecurityGroup()] };
  }
  return undefined;
}

function cache(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ServerlessCacheName: CACHE_NAME,
    ARN: CACHE_ARN,
    Status: 'available',
    Engine: 'valkey',
    Endpoint: {
      Address: 'cache.serverless.usw2.cache.amazonaws.com',
      Port: 6379,
    },
    SecurityGroupIds: ['sg-cache'],
    SubnetIds: ['subnet-a', 'subnet-b'],
    ...overrides,
  };
}

async function connected(params?: {
  elasticacheSend?: (command: unknown) => Promise<unknown>;
  ec2Send?: (command: unknown) => Promise<unknown>;
  stsSend?: (command: unknown) => Promise<unknown>;
}) {
  const adapter = new ElastiCacheAdapter();
  await adapter.connect({
    accessKeyId: 'AKIAEXAMPLE12345678',
    secretAccessKey: AWS_SECRET,
  });
  adapter.configureTarget({ region: REGION });
  const elasticacheSend = vi.fn(params?.elasticacheSend ?? (async (command: unknown) => {
    throw new Error(
      `Unexpected ElastiCache command: ${(command as { constructor?: { name?: string } }).constructor?.name}`
    );
  }));
  const ec2Send = vi.fn(params?.ec2Send ?? (async (command: unknown) => {
    throw new Error(
      `Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`
    );
  }));
  const stsSend = vi.fn(params?.stsSend ?? (async (command: unknown) => {
    if (command instanceof GetCallerIdentityCommand) {
      return { Account: '123456789012' };
    }
    throw new Error(
      `Unexpected STS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`
    );
  }));
  (adapter as unknown as {
    elasticache: { send: typeof elasticacheSend };
  }).elasticache = { send: elasticacheSend };
  (adapter as unknown as {
    ec2: { send: typeof ec2Send };
  }).ec2 = { send: ec2Send };
  (adapter as unknown as {
    sts: { send: typeof stsSend };
  }).sts = { send: stsSend };
  return { adapter, elasticacheSend, ec2Send, stsSend };
}

describe('ElastiCacheAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('accepts only ECS-compatible AWS authentication credentials', () => {
    const auth = {
      accessKeyId: 'AKIAEXAMPLE12345678',
      secretAccessKey: AWS_SECRET,
    };
    expect(ElastiCacheCredentialsSchema.parse(auth)).toEqual(auth);
    expect(() => ElastiCacheCredentialsSchema.parse({
      ...auth,
      region: REGION,
      subnetIds: ['subnet-a', 'subnet-b'],
      securityGroupIds: [WORKLOAD_SECURITY_GROUP_ID],
    })).toThrow(/Unrecognized key/);
  });

  it('rejects custom network and tier placement instead of ignoring it', async () => {
    const { adapter } = await connected();
    expect(() => adapter.configureTarget({ network: 'vpc-custom' })).toThrow(/does not accept cache\.network/);
    expect(() => adapter.configureTarget({ subnetwork: 'subnet-custom' })).toThrow(/does not accept cache\.subnetwork/);
    expect(() => adapter.configureTarget({ tier: 'enterprise' })).toThrow(/does not accept cache\.tier/);
    expect(() => adapter.configureTarget({ size: '1.5' })).toThrow(/positive integer/);
  });

  it('inventories bounded serverless caches with account and region scope', async () => {
    const { adapter } = await connected({
      elasticacheSend: async (command) => {
        expect(command).toBeInstanceOf(DescribeServerlessCachesCommand);
        return {
          ServerlessCaches: [
            cache(),
            cache({
              ServerlessCacheName: 'analytics-cache',
              ARN: 'arn:aws:elasticache:us-east-1:123456789012:serverlesscache:analytics-cache',
            }),
          ],
        };
      },
    });

    await expect(adapter.inspectCacheResources({ resource: 'cache', limit: 1 }))
      .resolves.toMatchObject({
        observation: 'present',
        resource: 'cache',
        caches: [{
          id: CACHE_ARN,
          name: CACHE_NAME,
          providerScope: { accountId: '123456789012', region: 'us-west-2' },
          cleanupSupported: false,
        }],
        truncated: true,
        partial: false,
      });
  });

  it('does not mutate when complete cache observation fails', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          const error = new Error('AWS throttled cache observation');
          Object.assign(error, { name: 'ThrottlingException' });
          throw error;
        }
        throw new Error('Unexpected mutation');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('AWS throttled cache observation');
    expect(
      elasticacheSend.mock.calls.some(([command]) =>
        command instanceof CreateServerlessCacheCommand
      )
    ).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('does not treat a malformed cache inventory as known-empty', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return {};
        throw new Error('Unexpected mutation');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt).toMatchObject({ success: false });
    expect(result.receipt.error).toContain('invalid serverless-cache list');
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand)).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('does not create networking after an incomplete security-group lookup', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return { ServerlessCaches: [] };
        }
        throw new Error('Unexpected ElastiCache mutation');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeVpcsCommand) return { Vpcs: [defaultVpc()] };
        if (command instanceof DescribeSubnetsCommand) return { Subnets: defaultSubnets() };
        if (command instanceof DescribeSecurityGroupsCommand) return {};
        throw new Error('No mutation should follow an incomplete observation');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt).toMatchObject({ success: false });
    expect(result.receipt.error).toContain('invalid security-group collection');
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand)).toBe(false);
  });

  it('does not mutate when the reviewed ECS workload-network binding is stale', async () => {
    const staleEnvironment = environment();
    (staleEnvironment.platformBindings.awsNetwork as Record<string, unknown>).subnetIds = [
      'subnet-a',
      'subnet-stale',
    ];
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return { ServerlessCaches: [] };
        throw new Error('Unexpected ElastiCache mutation');
      },
      ec2Send: async (command) => {
        const response = workloadNetworkResponse(command);
        if (response) return response;
        throw new Error('No mutation may follow stale workload-network observation');
      },
    });

    const result = await adapter.provision('redis', staleEnvironment, { resourceName: CACHE_NAME });

    expect(result.receipt).toMatchObject({
      success: false,
      error: expect.stringContaining('identity changed after project reconciliation'),
    });
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand)).toBe(false);
  });

  it('does not mutate when default-VPC observation is malformed', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return { ServerlessCaches: [] };
        throw new Error('Unexpected ElastiCache mutation');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeVpcsCommand) return {};
        throw new Error('No mutation may follow malformed default-VPC observation');
      },
    });

    const result = await adapter.provision('redis', environment(), { resourceName: CACHE_NAME });

    expect(result.receipt).toMatchObject({
      success: false,
      error: expect.stringContaining('invalid VPC list'),
    });
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand)).toBe(false);
  });

  it('fails closed on a repeated ElastiCache page token', async () => {
    let reads = 0;
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          reads += 1;
          return { ServerlessCaches: [], NextToken: 'same-page' };
        }
        throw new Error('Unexpected mutation');
      },
    });

    const result = await adapter.provision('redis', environment(), { resourceName: CACHE_NAME });

    expect(reads).toBe(2);
    expect(result.receipt).toMatchObject({
      success: false,
      error: expect.stringContaining('repeated token'),
    });
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand)).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('blocks a cache name match without creating networking or a replacement', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return { ServerlessCaches: [cache()] };
        }
        throw new Error('Unexpected mutation');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain(CACHE_ARN);
    expect(result.receipt.error).toContain('will not choose or silently adopt');
    expect(
      elasticacheSend.mock.calls.some(([command]) =>
        command instanceof CreateServerlessCacheCommand
      )
    ).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('creates an isolated ingress group and a TLS serverless Valkey cache', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    let listCount = 0;
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          listCount += 1;
          return {
            ServerlessCaches: listCount === 1 ? [] : [cache()],
          };
        }
        if (command instanceof CreateServerlessCacheCommand) {
          return { ServerlessCache: cache({ Status: 'creating' }) };
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-cache') {
            return { SecurityGroups: [cacheSecurityGroup(command.input.GroupIds.length > 0 && ec2Send.mock.calls.some(([item]) => item instanceof AuthorizeSecurityGroupIngressCommand))] };
          }
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) {
          return { GroupId: 'sg-cache' };
        }
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return {};
        }
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(CACHE_ARN);
    expect(result.connectionUrl).toBe(
      'rediss://cache.serverless.usw2.cache.amazonaws.com:6379'
    );
    expect(result.envVars).toEqual({ REDIS_URL: result.connectionUrl });
    const authorize = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
      ) as AuthorizeSecurityGroupIngressCommand;
    expect(authorize.input).toMatchObject({
      GroupId: 'sg-cache',
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 6379,
        ToPort: 6379,
        UserIdGroupPairs: [{
          GroupId: 'sg-workload',
          Description: 'Hypervibe workload access to ElastiCache',
        }],
      }],
    });
    const create = elasticacheSend.mock.calls
      .map(([command]) => command)
      .find((command) =>
        command instanceof CreateServerlessCacheCommand
      ) as CreateServerlessCacheCommand;
    expect(create.input).toMatchObject({
      ServerlessCacheName: CACHE_NAME,
      Engine: 'valkey',
      SecurityGroupIds: ['sg-cache'],
      SubnetIds: ['subnet-a', 'subnet-b'],
      SnapshotRetentionLimit: 1,
      CacheUsageLimits: {
        DataStorage: { Maximum: 5, Unit: 'GB' },
        ECPUPerSecond: { Maximum: 1000 },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(AWS_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('rediss://');
  });

  it('recovers an exact tagged security group after a 2xx create omits its ID', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    let cacheReads = 0;
    let filteredGroupReads = 0;
    const { adapter, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          cacheReads += 1;
          return { ServerlessCaches: cacheReads === 1 ? [] : [cache()] };
        }
        if (command instanceof CreateServerlessCacheCommand) {
          return { ServerlessCache: cache({ Status: 'creating' }) };
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-cache') {
            return { SecurityGroups: [cacheSecurityGroup(
              ec2Send.mock.calls.some(([item]) => item instanceof AuthorizeSecurityGroupIngressCommand)
            )] };
          }
          filteredGroupReads += 1;
          return {
            SecurityGroups: filteredGroupReads < 3 ? [] : [cacheSecurityGroup(false)],
          };
        }
        if (command instanceof CreateSecurityGroupCommand) return {};
        if (command instanceof AuthorizeSecurityGroupIngressCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt).toMatchObject({
      success: true,
      data: { securityGroupId: 'sg-cache' },
    });
    expect(result.component.bindings).toMatchObject({
      securityGroupId: 'sg-cache',
      providerScope: { accountId: ACCOUNT_ID, region: REGION },
    });
    expect(filteredGroupReads).toBe(3);
    expect(ec2Send.mock.calls.filter(([command]) => command instanceof CreateSecurityGroupCommand))
      .toHaveLength(1);
  });

  it.each([
    {
      label: 'transport loss',
      create: async () => { throw new Error('connection closed after request transmission'); },
    },
    {
      label: 'HTTP 503',
      create: async () => {
        throw Object.assign(new Error('service unavailable'), {
          $metadata: { httpStatusCode: 503 },
        });
      },
    },
    {
      label: 'HTTP 408',
      create: async () => {
        throw Object.assign(new Error('request timeout'), {
          $metadata: { httpStatusCode: 408 },
        });
      },
    },
    {
      label: 'malformed success',
      create: async () => ({}),
    },
  ])('retains a strict unresolved network marker after $label and inconclusive recovery', async ({ create }) => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return { ServerlessCaches: [] };
        }
        throw new Error('Cache creation must not run while the network identity is unresolved');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return create();
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        cacheMutationAttempted: false,
        resourceCreated: false,
        networkResourceCreated: 'unknown',
        unresolvedNetworkResource: `${CACHE_NAME}-hypervibe-cache`,
      },
    });
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provider: 'elasticache',
        providerScope: { accountId: ACCOUNT_ID, region: REGION },
        cacheName: CACHE_NAME,
        provisioningIncomplete: true,
        unresolvedNetworkMutation: {
          resourceKind: 'cache-network',
          operation: 'create',
          resourceName: `${CACHE_NAME}-hypervibe-cache`,
          cacheName: CACHE_NAME,
          providerScope: { accountId: ACCOUNT_ID, region: REGION },
          networkScope: {
            vpcId: VPC_ID,
            workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
          },
          ownership: { ManagedBy: 'Hypervibe', Cache: CACHE_NAME },
        },
      },
    });
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand))
      .toBe(false);
    expect(ec2Send.mock.calls.filter(([command]) => command instanceof CreateSecurityGroupCommand))
      .toHaveLength(1);
  });

  it('treats a definitive security-group 4xx rejection as absent and does not recover', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    let filteredReads = 0;
    const rejected = Object.assign(new Error('not authorized'), {
      $metadata: { httpStatusCode: 403 },
    });
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return { ServerlessCaches: [] };
        throw new Error('Cache creation must not run after a definitive network-create rejection');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          filteredReads += 1;
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) throw rejected;
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), { resourceName: CACHE_NAME });

    expect(result.receipt).toMatchObject({
      success: false,
      data: { cacheMutationAttempted: false, resourceCreated: false },
    });
    expect(result.component).toMatchObject({ externalId: null, bindings: {} });
    expect(result.component.bindings).not.toHaveProperty('unresolvedNetworkMutation');
    expect(filteredReads).toBe(1);
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand))
      .toBe(false);
    expect(ec2Send.mock.calls.filter(([command]) => command instanceof CreateSecurityGroupCommand))
      .toHaveLength(1);
  });

  it('resumes exactly one scoped owned security group without issuing another create', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    let cacheReads = 0;
    let ingressAuthorized = false;
    const { adapter, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          cacheReads += 1;
          return { ServerlessCaches: cacheReads === 1 ? [] : [cache()] };
        }
        if (command instanceof CreateServerlessCacheCommand) {
          return { ServerlessCache: cache({ Status: 'creating' }) };
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [cacheSecurityGroup(ingressAuthorized)] };
        }
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          ingressAuthorized = true;
          return {};
        }
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
      component: unresolvedNetworkComponent(),
    });

    expect(result.receipt).toMatchObject({ success: true, data: { securityGroupId: 'sg-cache' } });
    expect(result.component.externalId).toBe(CACHE_ARN);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand))
      .toBe(false);
  });

  it.each([
    {
      label: 'remains absent',
      groups: [] as ReturnType<typeof cacheSecurityGroup>[],
    },
    {
      label: 'is duplicated',
      groups: [cacheSecurityGroup(false), { ...cacheSecurityGroup(false), GroupId: 'sg-cache-2' }],
    },
    {
      label: 'has mismatched ownership tags',
      groups: [{
        ...cacheSecurityGroup(false),
        Tags: [{ Key: 'ManagedBy', Value: 'SomeoneElse' }, { Key: 'Cache', Value: CACHE_NAME }],
      }],
    },
    {
      label: 'has unreviewed ingress',
      groups: [{
        ...cacheSecurityGroup(false),
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: 6379,
          ToPort: 6379,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          UserIdGroupPairs: [],
        }],
      }],
    },
  ])('keeps the marker and performs no create when the recovery candidate $label', async ({ groups }) => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return { ServerlessCaches: [] };
        throw new Error('Cache creation must not run without one exact network candidate');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) return { SecurityGroups: groups };
        throw new Error('No network mutation is allowed during unresolved recovery');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
      component: unresolvedNetworkComponent(),
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: null,
      bindings: {
        provisioningIncomplete: true,
        unresolvedNetworkMutation: {
          resourceName: `${CACHE_NAME}-hypervibe-cache`,
          providerScope: { accountId: ACCOUNT_ID, region: REGION },
        },
      },
    });
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand))
      .toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => (
      command instanceof CreateSecurityGroupCommand
      || command instanceof AuthorizeSecurityGroupIngressCommand
      || command instanceof DeleteSecurityGroupCommand
    ))).toBe(false);
  });

  it('refuses to retarget a network marker when its durable AWS scope changes', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return { ServerlessCaches: [] };
        throw new Error('Cache creation must not run after a marker mismatch');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        throw new Error('No security-group inventory or mutation is allowed after a marker mismatch');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
      component: unresolvedNetworkComponent({
        providerScope: { accountId: ACCOUNT_ID, region: 'us-east-1' },
      }),
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('does not match the current cache name');
    expect(result.component.bindings).toHaveProperty('unresolvedNetworkMutation');
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand))
      .toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand))
      .toBe(false);
  });

  it('retains a known security-group ID when post-create observation fails', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return { ServerlessCaches: [] };
        }
        throw new Error('Cache creation must not run without verified networking');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-cache') {
            throw new Error('EC2 security-group observation unavailable');
          }
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-cache' };
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        cacheMutationAttempted: false,
        resourceCreated: false,
        securityGroupId: 'sg-cache',
      },
    });
    expect(result.component).toMatchObject({
      externalId: CACHE_ARN,
      bindings: {
        provider: 'elasticache',
        providerScope: { accountId: ACCOUNT_ID, region: REGION },
        securityGroupId: 'sg-cache',
        vpcId: VPC_ID,
      },
    });
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand))
      .toBe(false);
    expect(ec2Send.mock.calls.filter(([command]) => command instanceof CreateSecurityGroupCommand))
      .toHaveLength(1);
  });

  it('falls back to deterministic cache identity when create returns a malformed ARN', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_DELAY_MS', '0');
    const { adapter, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return { ServerlessCaches: [] };
        }
        if (command instanceof CreateServerlessCacheCommand) {
          return {
            ServerlessCache: cache({ ARN: 'arn:malformed', Status: 'creating' }),
          };
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-cache') {
            return { SecurityGroups: [cacheSecurityGroup(
              ec2Send.mock.calls.some(([item]) => item instanceof AuthorizeSecurityGroupIngressCommand)
            )] };
          }
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-cache' };
        if (command instanceof AuthorizeSecurityGroupIngressCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        cacheArn: CACHE_ARN,
        cacheMutationAttempted: true,
        resourceCreated: 'unknown',
        liveObservationError: expect.stringContaining('malformed cache identity'),
      },
    });
    expect(result.component).toMatchObject({
      externalId: CACHE_ARN,
      bindings: {
        instanceId: CACHE_ARN,
        providerScope: { accountId: ACCOUNT_ID, region: REGION },
      },
    });
  });

  it('updates only the exact bound cache size while preserving its reviewed network', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    let modified = false;
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return {
            ServerlessCaches: [cache({
              CacheUsageLimits: {
                DataStorage: { Maximum: modified ? 10 : 5, Unit: 'GB' },
                ECPUPerSecond: { Maximum: 1000 },
              },
            })],
          };
        }
        if (command instanceof ModifyServerlessCacheCommand) {
          modified = true;
          return {};
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand
          && command.input.GroupIds?.[0] === 'sg-cache') {
          return { SecurityGroups: [cacheSecurityGroup()] };
        }
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
      component: component(),
      size: '10',
      region: REGION,
    });

    expect(result.receipt).toMatchObject({ success: true, data: { updated: true, size: '10' } });
    const modify = elasticacheSend.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof ModifyServerlessCacheCommand) as ModifyServerlessCacheCommand;
    expect(modify.input).toMatchObject({
      ServerlessCacheName: CACHE_NAME,
      CacheUsageLimits: { DataStorage: { Maximum: 10, Unit: 'GB' } },
    });
    expect(elasticacheSend.mock.calls.some(([command]) => command instanceof CreateServerlessCacheCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
  });

  it('preserves cache and network identity when create outcome is unknown', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_DELAY_MS', '0');
    let listCount = 0;
    const { adapter, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          listCount += 1;
          if (listCount === 1) return { ServerlessCaches: [] };
          const error = new Error('ElastiCache observation unavailable');
          Object.assign(error, { name: 'ServiceUnavailable' });
          throw error;
        }
        if (command instanceof CreateServerlessCacheCommand) {
          throw new Error('connection closed after request transmission');
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-cache') {
            return { SecurityGroups: [cacheSecurityGroup(ec2Send.mock.calls.some(([item]) => item instanceof AuthorizeSecurityGroupIngressCommand))] };
          }
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) {
          return { GroupId: 'sg-cache' };
        }
        if (command instanceof AuthorizeSecurityGroupIngressCommand) return {};
        if (command instanceof DeleteSecurityGroupCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBe(CACHE_ARN);
    expect(result.component.bindings).toMatchObject({
      instanceId: CACHE_ARN,
      providerScope: { accountId: '123456789012', region: 'us-west-2' },
      cacheName: CACHE_NAME,
      securityGroupId: 'sg-cache',
      securityGroupManagedByHypervibe: true,
      mutationAttempted: true,
    });
    expect(result.receipt.data).toMatchObject({
      cacheName: CACHE_NAME,
      cacheMutationAttempted: true,
      resourceCreated: 'unknown',
      securityGroupId: 'sg-cache',
      liveObservationError: expect.stringContaining('ElastiCache observation unavailable'),
    });
    expect(
      ec2Send.mock.calls.some(([command]) =>
        command instanceof DeleteSecurityGroupCommand
      )
    ).toBe(false);
  });

  it('polls through eventual consistency and recovers the cache ARN after a lost create response', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_CREATE_RECOVERY_DELAY_MS', '0');
    let listCount = 0;
    const { adapter, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          listCount += 1;
          return {
            ServerlessCaches: listCount < 3
              ? []
              : [cache({ Status: 'creating' })],
          };
        }
        if (command instanceof CreateServerlessCacheCommand) {
          throw new Error('connection closed after request transmission');
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        const networkResponse = workloadNetworkResponse(command);
        if (networkResponse) return networkResponse;
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-cache') {
            return { SecurityGroups: [cacheSecurityGroup(
              ec2Send.mock.calls.some(([item]) => item instanceof AuthorizeSecurityGroupIngressCommand)
            )] };
          }
          return { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-cache' };
        if (command instanceof AuthorizeSecurityGroupIngressCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component).toMatchObject({
      externalId: CACHE_ARN,
      bindings: {
        instanceId: CACHE_ARN,
        providerScope: { accountId: '123456789012', region: REGION },
        securityGroupId: 'sg-cache',
      },
    });
    expect(result.receipt.data).toMatchObject({
      resourceCreated: true,
      cacheArn: CACHE_ARN,
    });
    expect(listCount).toBe(3);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(false);
  });

  it('uses the durable ARN first when names disagree', async () => {
    const { adapter } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return {
            ServerlessCaches: [
              cache({ ServerlessCacheName: 'renamed-cache' }),
              cache({
                ARN: 'arn:aws:elasticache:us-west-2:123:serverlesscache:unrelated',
                ServerlessCacheName: CACHE_NAME,
              }),
            ],
          };
        }
        throw new Error('Unexpected ElastiCache command');
      },
    });

    const observed = await adapter.observeCache(environment(), component());

    expect(observed).toMatchObject({
      externalId: CACHE_ARN,
      name: 'renamed-cache',
      status: 'running',
    });
  });

  it('waits for cache absence before retrying and deleting the managed security group', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_NETWORK_DELETE_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_NETWORK_DELETE_DELAY_MS', '0');
    let deleted = false;
    let readsAfterDelete = 0;
    let groupDeleteAttempts = 0;
    const order: string[] = [];
    const { adapter } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          order.push('describe-cache');
          if (!deleted) return { ServerlessCaches: [cache()] };
          readsAfterDelete += 1;
          return {
            ServerlessCaches: readsAfterDelete === 1
              ? [cache({ Status: 'deleting' })]
              : [],
          };
        }
        if (command instanceof DeleteServerlessCacheCommand) {
          deleted = true;
          order.push('delete-cache');
          return {};
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand
          && command.input.GroupIds?.[0] === 'sg-cache') {
          if (groupDeleteAttempts >= 2) {
            const error = new Error('not found');
            Object.assign(error, { name: 'InvalidGroup.NotFound' });
            throw error;
          }
          return { SecurityGroups: [cacheSecurityGroup()] };
        }
        if (command instanceof DeleteSecurityGroupCommand) {
          groupDeleteAttempts += 1;
          order.push('delete-security-group');
          if (groupDeleteAttempts === 1) {
            const error = new Error('resource still in use');
            Object.assign(error, { name: 'DependencyViolation' });
            throw error;
          }
          return {};
        }
        throw new Error('Unexpected EC2 command');
      },
    });

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(true);
    expect(readsAfterDelete).toBe(2);
    expect(groupDeleteAttempts).toBe(2);
    expect(order.indexOf('delete-security-group')).toBeGreaterThan(
      order.lastIndexOf('describe-cache')
    );
  });

  it('does not report security-group teardown success from the delete acknowledgement alone', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_NETWORK_DELETE_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_NETWORK_DELETE_DELAY_MS', '0');
    const { adapter } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) return { ServerlessCaches: [] };
        throw new Error('Unexpected ElastiCache mutation');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [cacheSecurityGroup()] };
        }
        if (command instanceof DeleteSecurityGroupCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });

    await expect(adapter.destroy(component())).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('remained observable after deletion'),
    });
  });

  it('does not delete networking when cache observation is unknown', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          const error = new Error('Access denied');
          Object.assign(error, { name: 'AccessDeniedException' });
          throw error;
        }
        throw new Error('Unexpected ElastiCache mutation');
      },
    });

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Access denied');
    expect(
      elasticacheSend.mock.calls.some(([command]) =>
        command instanceof DeleteServerlessCacheCommand
      )
    ).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('blocks observation and deletion when the binding belongs to another AWS account', async () => {
    const { adapter, elasticacheSend, ec2Send, stsSend } = await connected({
      stsSend: async (command) => {
        expect(command).toBeInstanceOf(GetCallerIdentityCommand);
        return { Account: '999999999999' };
      },
    });

    await expect(adapter.observeCache(environment(), component())).rejects.toThrow(
      /scope account 123456789012 does not match connected account 999999999999/
    );
    await expect(adapter.destroy(component())).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(
        'scope account 123456789012 does not match connected account 999999999999'
      ),
    });
    expect(stsSend).toHaveBeenCalledTimes(1);
    expect(elasticacheSend).not.toHaveBeenCalled();
    expect(ec2Send).not.toHaveBeenCalled();
  });
});
