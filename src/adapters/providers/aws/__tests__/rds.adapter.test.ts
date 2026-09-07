import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RdsAdapter } from '../rds.adapter.js';

const now = new Date();
const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const VPC_ID = 'vpc-1';
const WORKLOAD_SECURITY_GROUP_ID = 'sg-workload';
const CLUSTER_NAME = 'hv-invoice-perfect-production-0123456789';
const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}`;
const environment = {
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
  createdAt: now,
  updatedAt: now,
} as Environment;
const component = {
  id: 'component-1',
  environmentId: environment.id,
  type: 'postgres',
  externalId: 'production-postgres',
  bindings: {
    provider: 'rds',
    username: 'hypervibe_admin',
    password: 'db-secret',
    database: 'app',
    securityGroupId: 'sg-database',
    securityGroupVpcId: VPC_ID,
    securityGroupName: 'production-postgres-hypervibe-db',
    securityGroupManagedByHypervibe: true,
    securityGroupRuntimeIngressManaged: true,
    workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
    subnetIds: ['subnet-a', 'subnet-b'],
    providerScope: { accountId: '123456789012', region: 'us-west-2' },
  },
  createdAt: now,
  updatedAt: now,
} as Component;

function managedSecurityGroup(
  identifier: string,
  groupId = 'sg-database',
  withRuntimeIngress = true
) {
  return {
    GroupId: groupId,
    GroupName: `${identifier}-hypervibe-db`,
    VpcId: 'vpc-1',
    Tags: [
      { Key: 'ManagedBy', Value: 'Hypervibe' },
      { Key: 'Database', Value: identifier },
    ],
    IpPermissions: withRuntimeIngress ? [{
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      UserIdGroupPairs: [{ GroupId: WORKLOAD_SECURITY_GROUP_ID }],
    }] : [],
  };
}

function workloadSecurityGroup() {
  return {
    GroupId: WORKLOAD_SECURITY_GROUP_ID,
    GroupName: `${CLUSTER_NAME}-hypervibe-workloads`,
    VpcId: VPC_ID,
    Tags: [
      { Key: 'managed-by', Value: 'hypervibe' },
      { Key: 'hypervibe-environment-id', Value: environment.id },
      { Key: 'hypervibe-ecs-cluster-arn', Value: CLUSTER_ARN },
    ],
  };
}

function workloadNetworkResponse(command: unknown): Record<string, unknown> | undefined {
  if (command instanceof DescribeVpcsCommand) {
    return { Vpcs: [{ VpcId: VPC_ID, IsDefault: true }] };
  }
  if (command instanceof DescribeSubnetsCommand) {
    return {
      Subnets: [
        { SubnetId: 'subnet-a', VpcId: VPC_ID, AvailabilityZone: `${REGION}a`, DefaultForAz: true },
        { SubnetId: 'subnet-b', VpcId: VPC_ID, AvailabilityZone: `${REGION}b`, DefaultForAz: true },
      ],
    };
  }
  if (command instanceof DescribeSecurityGroupsCommand
    && command.input.GroupIds?.[0] === WORKLOAD_SECURITY_GROUP_ID) {
    return { SecurityGroups: [workloadSecurityGroup()] };
  }
  return undefined;
}

async function connectedAdapter(params?: { publiclyAccessible?: boolean; rules?: Array<Record<string, unknown>> }) {
  const adapter = new RdsAdapter();
  await adapter.connect({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-west-2',
  });
  const instance = {
    DBInstanceIdentifier: component.externalId!,
    DBInstanceArn: `arn:aws:rds:us-west-2:123456789012:db:${component.externalId}`,
    DBInstanceStatus: 'available',
    PubliclyAccessible: params?.publiclyAccessible ?? true,
    Endpoint: { Address: 'production.example.rds.amazonaws.com', Port: 5432 },
    VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
  };
  const rdsSend = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeDBInstancesCommand) return { DBInstances: [instance] };
    throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  const ec2Send = vi.fn(async (command: unknown) => {
    const networkResponse = workloadNetworkResponse(command);
    if (networkResponse) return networkResponse;
    if (command instanceof DescribeSecurityGroupsCommand
      && command.input.GroupIds?.[0] === 'sg-database') {
      return { SecurityGroups: [managedSecurityGroup(component.externalId!)] };
    }
    if (command instanceof DescribeSecurityGroupRulesCommand) {
      return { SecurityGroupRules: params?.rules ?? [] };
    }
    if (command instanceof AuthorizeSecurityGroupIngressCommand) {
      return { SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-temporary' }] };
    }
    if (command instanceof RevokeSecurityGroupIngressCommand) return {};
    throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  (adapter as unknown as { rds: { send: typeof rdsSend } }).rds = { send: rdsSend };
  (adapter as unknown as { ec2: { send: typeof ec2Send } }).ec2 = { send: ec2Send };
  const stsSend = vi.fn(async (command: unknown) => {
    if (command instanceof GetCallerIdentityCommand) return { Account: '123456789012' };
    throw new Error(`Unexpected STS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  (adapter as unknown as { sts: { send: typeof stsSend } }).sts = { send: stsSend };
  return { adapter, rdsSend, ec2Send };
}

describe('RdsAdapter temporary database access', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds the caller IPv4 as a temporary /32 rule and revokes exactly that rule', async () => {
    const { adapter, ec2Send } = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.42\n')));

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);

    expect(access).toEqual({
      connectionUrl: 'postgresql://hypervibe_admin:db-secret@production.example.rds.amazonaws.com:5432/app?sslmode=require',
      source: 'temporary_firewall',
      temporary: true,
      releaseToken: 'sgr-temporary',
    });
    const authorize = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof AuthorizeSecurityGroupIngressCommand) as AuthorizeSecurityGroupIngressCommand;
    expect(authorize.input).toMatchObject({
      GroupId: 'sg-database',
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        IpRanges: [{
          CidrIp: '203.0.113.42/32',
          Description: 'Hypervibe operation-scoped database query',
        }],
      }],
    });

    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);
    const revoke = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof RevokeSecurityGroupIngressCommand) as RevokeSecurityGroupIngressCommand;
    expect(revoke.input).toEqual({ GroupId: 'sg-database', SecurityGroupRuleIds: ['sgr-temporary'] });
  });

  it('adopts and later removes a stale Hypervibe rule from an interrupted process', async () => {
    const { adapter, ec2Send } = await connectedAdapter({
      rules: [{
        GroupId: 'sg-database',
        SecurityGroupRuleId: 'sgr-stale',
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        CidrIpv4: '203.0.113.42/32',
        Description: 'Hypervibe operation-scoped database query',
      }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.42\n')));

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);
    expect(access).toMatchObject({ source: 'temporary_firewall', temporary: true, releaseToken: 'sgr-stale' });
    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);

    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);
    const revoke = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof RevokeSecurityGroupIngressCommand) as RevokeSecurityGroupIngressCommand;
    expect(revoke.input.SecurityGroupRuleIds).toEqual(['sgr-stale']);
  });

  it('preserves matching user-managed ingress instead of claiming it as temporary', async () => {
    const { adapter, ec2Send } = await connectedAdapter({
      rules: [{
        GroupId: 'sg-database',
        SecurityGroupRuleId: 'sgr-user',
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        CidrIpv4: '203.0.113.0/24',
        Description: 'Office network',
      }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.42\n')));

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);
    expect(access).toMatchObject({ source: 'direct', temporary: false });
    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);

    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof RevokeSecurityGroupIngressCommand)).toBe(false);
  });

  it('refuses to create implicit infrastructure for a private-only RDS instance', async () => {
    const { adapter, ec2Send } = await connectedAdapter({ publiclyAccessible: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432))
      .rejects.toThrow('durable VPC/SSM network path');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ec2Send).not.toHaveBeenCalled();
  });
});

describe('RdsAdapter lifecycle reconciliation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function lifecycleAdapter(params: {
    rdsSend: (command: unknown) => Promise<unknown>;
    ec2Send?: (command: unknown) => Promise<unknown>;
  }) {
    const adapter = new RdsAdapter();
    await adapter.connect({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-west-2',
      vpcId: 'vpc-1',
    });
    const rdsSend = vi.fn(params.rdsSend);
    const providerEc2Send = params.ec2Send ?? (async (command: unknown) => {
      throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    });
    const ec2Send = vi.fn(async (command: unknown) => {
      const networkResponse = workloadNetworkResponse(command);
      if (networkResponse) return networkResponse;
      return providerEc2Send(command);
    });
    (adapter as unknown as { rds: { send: typeof rdsSend } }).rds = { send: rdsSend };
    (adapter as unknown as { ec2: { send: typeof ec2Send } }).ec2 = { send: ec2Send };
    const stsSend = vi.fn(async (command: unknown) => {
      if (command instanceof GetCallerIdentityCommand) return { Account: '123456789012' };
      throw new Error(`Unexpected STS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    });
    (adapter as unknown as { sts: { send: typeof stsSend } }).sts = { send: stsSend };
    return { adapter, rdsSend, ec2Send };
  }

  it('inventories bounded RDS instances with account and region scope', async () => {
    const { adapter } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (!(command instanceof DescribeDBInstancesCommand)) throw new Error('Unexpected RDS command');
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: 'customer-primary',
              DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:customer-primary',
              Engine: 'postgres',
              EngineVersion: '17.4',
              DBInstanceStatus: 'available',
              AvailabilityZone: 'us-west-2a',
            },
            {
              DBInstanceIdentifier: 'analytics',
              DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:analytics',
              Engine: 'postgres',
              DBInstanceStatus: 'stopped',
            },
          ],
        };
      },
    });

    const result = await adapter.inspectDatabaseResources({ resource: 'database', limit: 1 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'customer-primary',
        engine: 'postgres',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
      }],
      truncated: true,
      partial: false,
    });
  });

  it('blocks non-ECS hosting before any RDS or EC2 mutation', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async () => {
        throw new Error('No RDS call is allowed without an ECS workload binding');
      },
    });
    const railwayEnvironment = {
      ...environment,
      platformBindings: { provider: 'railway', projectId: 'railway-project' },
    } as Environment;

    const result = await adapter.provision('postgres', railwayEnvironment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({ success: false, data: { resourceCreated: false } });
    expect(result.receipt.error).toContain('bound to AWS ECS Express');
    expect(rdsSend).not.toHaveBeenCalled();
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('blocks a stale persisted ECS workload network before either create mutation', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('No RDS mutation is allowed for a stale workload network');
      },
    });
    const staleEnvironment = {
      ...environment,
      platformBindings: {
        ...environment.platformBindings,
        awsNetwork: {
          ...(environment.platformBindings.awsNetwork as Record<string, unknown>),
          vpcId: 'vpc-stale',
        },
      },
    } as Environment;

    const result = await adapter.provision('postgres', staleEnvironment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({ success: false, data: { resourceCreated: false } });
    expect(result.receipt.error).toContain('is not the exact default VPC');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof CreateDBInstanceCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
  });

  it('blocks a missing persisted ECS workload network before either create mutation', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('No RDS mutation is allowed without a reviewed workload network');
      },
    });
    const { awsNetwork: _missing, ...platformBindings } = environment.platformBindings as Record<string, unknown>;
    const missingNetworkEnvironment = { ...environment, platformBindings } as Environment;

    const result = await adapter.provision('postgres', missingNetworkEnvironment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({ success: false, data: { resourceCreated: false } });
    expect(result.receipt.error).toContain('no reviewed AWS workload-network binding');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof CreateDBInstanceCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
  });

  it('creates and proves one durable ECS-workload ingress rule before reporting success', async () => {
    let databaseReads = 0;
    let ingressAuthorized = false;
    const instance = {
      DBInstanceIdentifier: 'invoice-perfect-production-postgres',
      DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:invoice-perfect-production-postgres',
      DBInstanceStatus: 'available',
      PubliclyAccessible: true,
      Endpoint: { Address: 'invoice-perfect.example.rds.amazonaws.com', Port: 5432 },
      VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
    };
    const { adapter, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          databaseReads += 1;
          if (databaseReads === 1) {
            const error = new Error('DB instance not found');
            Object.assign(error, { name: 'DBInstanceNotFoundFault' });
            throw error;
          }
          return { DBInstances: [instance] };
        }
        if (command instanceof CreateDBInstanceCommand) return { DBInstance: instance };
        throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (!command.input.GroupIds) return { SecurityGroups: [] };
          return {
            SecurityGroups: [managedSecurityGroup(
              'invoice-perfect-production-postgres',
              'sg-database',
              ingressAuthorized
            )],
          };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-database' };
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          ingressAuthorized = true;
          return {};
        }
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(true);
    const authorize = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof AuthorizeSecurityGroupIngressCommand) as AuthorizeSecurityGroupIngressCommand;
    expect(authorize.input).toEqual({
      GroupId: 'sg-database',
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        UserIdGroupPairs: [{
          GroupId: WORKLOAD_SECURITY_GROUP_ID,
          Description: 'Hypervibe ECS workload access to RDS',
        }],
      }],
    });
    expect(result.component.bindings).toMatchObject({
      securityGroupId: 'sg-database',
      securityGroupVpcId: VPC_ID,
      workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
      subnetIds: ['subnet-a', 'subnet-b'],
    });
  });

  it('retains deterministic SG cleanup identity when an ambiguous create is not yet visible', async () => {
    vi.stubEnv('HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_RDS_NETWORK_DELETE_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RDS_NETWORK_DELETE_DELAY_MS', '0');
    let groupVisible = false;
    let groupDeleted = false;
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('The DB create must not run without a proven security group');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds?.[0] === 'sg-delayed') {
            if (groupDeleted) {
              const error = new Error('Security group not found');
              Object.assign(error, { name: 'InvalidGroup.NotFound' });
              throw error;
            }
            return { SecurityGroups: [managedSecurityGroup(
              'invoice-perfect-production-postgres',
              'sg-delayed'
            )] };
          }
          return {
            SecurityGroups: groupVisible
              ? [managedSecurityGroup('invoice-perfect-production-postgres', 'sg-delayed')]
              : [],
          };
        }
        if (command instanceof CreateSecurityGroupCommand) return {};
        if (command instanceof DeleteSecurityGroupCommand) {
          groupDeleted = true;
          return {};
        }
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const failed = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(failed.receipt.success).toBe(false);
    expect(failed.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        providerScope: { accountId: ACCOUNT_ID, region: REGION },
        securityGroupName: 'invoice-perfect-production-postgres-hypervibe-db',
        securityGroupVpcId: VPC_ID,
        securityGroupManagedByHypervibe: true,
        securityGroupCreatedDuringProvision: true,
      },
    });
    expect(failed.component.bindings).not.toHaveProperty('securityGroupId');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof CreateDBInstanceCommand)).toBe(false);

    groupVisible = true;
    const cleanup = await adapter.destroy(failed.component);

    expect(cleanup.success).toBe(true);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(true);
    expect(groupDeleted).toBe(true);
  });

  it('turns out-of-band RDS ingress drift into unknown observation instead of a noop', async () => {
    const drifted = {
      ...managedSecurityGroup(component.externalId!),
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      }],
    };
    const { adapter, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          return {
            DBInstances: [{
              DBInstanceIdentifier: component.externalId!,
              DBInstanceArn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:db:${component.externalId}`,
              DBInstanceStatus: 'available',
              VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
            }],
          };
        }
        throw new Error('No mutation is allowed during RDS observation');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [drifted] };
        }
        throw new Error('No mutation is allowed during RDS observation');
      },
    });

    await expect(adapter.observeDatabase(environment, component))
      .rejects.toThrow('ingress is not limited to ECS workload security group');
    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
  });

  it('provisions with the provider resource identity instead of the logical database name', async () => {
    let describeCount = 0;
    const instance = {
      DBInstanceIdentifier: 'invoice-perfect-production-postgres',
      DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:invoice-perfect-production-postgres',
      DBInstanceStatus: 'available',
      PubliclyAccessible: true,
      Endpoint: { Address: 'invoice-perfect.example.rds.amazonaws.com', Port: 5432 },
      VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-existing' }],
    };
    const { adapter, rdsSend } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) return { DBInstance: instance };
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          if (describeCount === 1) {
            const error = new Error('DB instance not found');
            Object.assign(error, { name: 'DBInstanceNotFoundFault' });
            throw error;
          }
          return { DBInstances: [instance] };
        }
        throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? { SecurityGroups: [managedSecurityGroup(
                'invoice-perfect-production-postgres',
                'sg-existing'
              )] }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-existing' };
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
      databaseName: 'invoice_perfect',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('invoice-perfect-production-postgres');
    const create = rdsSend.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof CreateDBInstanceCommand) as CreateDBInstanceCommand;
    expect(create.input).toMatchObject({
      DBInstanceIdentifier: 'invoice-perfect-production-postgres',
      DBName: 'invoice_perfect',
      VpcSecurityGroupIds: ['sg-existing'],
    });
  });

  it('propagates an observation failure instead of reporting the database absent', async () => {
    const { adapter } = await lifecycleAdapter({
      rdsSend: async () => {
        const error = new Error('AWS throttled the observation');
        Object.assign(error, { name: 'ThrottlingException' });
        throw error;
      },
    });

    await expect(adapter.observeDatabase(environment, component))
      .rejects.toThrow('AWS throttled the observation');
  });

  it('does not treat a successful but empty exact lookup as confirmed absence', async () => {
    const { adapter, rdsSend } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) return { DBInstances: [] };
        throw new Error('No mutation should follow an incomplete observation');
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: { resourceCreated: 'unknown' },
    });
    expect(result.receipt.error).toContain('absence was not confirmed');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof CreateDBInstanceCommand)).toBe(false);
  });

  it('does not create after an incomplete managed security-group lookup', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('No RDS mutation should follow an incomplete network observation');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) return {};
        throw new Error('No EC2 mutation should follow an incomplete network observation');
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({ success: false });
    expect(result.receipt.error).toContain('invalid security-group list');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof CreateDBInstanceCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof CreateSecurityGroupCommand)).toBe(false);
  });

  it('retains exact scoped identity when a security-group create is acknowledged but cannot be verified', async () => {
    const { adapter, rdsSend } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('The database create must not run without verified networking');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds ? {} : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-new' };
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceMutationAttempted: false,
        resourceCreated: false,
        securityGroupId: 'sg-new',
        securityGroupVpcId: 'vpc-1',
      },
    });
    expect(result.receipt.data).toHaveProperty('networkCleanupError');
    expect(result.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        provider: 'rds',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
        securityGroupId: 'sg-new',
        securityGroupVpcId: 'vpc-1',
        securityGroupManagedByHypervibe: true,
        securityGroupCreatedDuringProvision: true,
        mutationAttempted: false,
      },
    });
    expect(rdsSend.mock.calls.some(([command]) => command instanceof CreateDBInstanceCommand)).toBe(false);
  });

  it('does not tear down networking when failed provisioning leaves database existence unknown', async () => {
    let describeCount = 0;
    const { adapter, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) return {};
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          if (describeCount === 1) {
            const error = new Error('DB instance not found');
            Object.assign(error, { name: 'DBInstanceNotFoundFault' });
            throw error;
          }
          const error = new Error('RDS observation unavailable');
          Object.assign(error, { name: 'ServiceUnavailable' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? { SecurityGroups: [managedSecurityGroup('invoice-perfect-production-postgres', 'sg-new')] }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-new' };
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({
      resourceCreated: 'unknown',
      securityGroupId: 'sg-new',
      liveObservationError: 'RDS observation unavailable',
    });
    expect(result.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        provider: 'rds',
        instanceId: 'invoice-perfect-production-postgres',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
        securityGroupId: 'sg-new',
        securityGroupVpcId: 'vpc-1',
        securityGroupManagedByHypervibe: true,
        mutationAttempted: true,
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain('password');
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(false);
  });

  it('recovers a deterministic instance after the create transport loses its response', async () => {
    vi.stubEnv('HYPERVIBE_RDS_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RDS_CREATE_RECOVERY_DELAY_MS', '0');
    let describeCount = 0;
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) {
          throw new Error('connection closed after request transmission');
        }
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          if (describeCount < 3) {
            const error = new Error('DB instance not found');
            Object.assign(error, { name: 'DBInstanceNotFoundFault' });
            throw error;
          }
          return {
            DBInstances: [{
              DBInstanceIdentifier: 'invoice-perfect-production-postgres',
              DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:invoice-perfect-production-postgres',
              DBInstanceStatus: 'creating',
              VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-new' }],
            }],
          };
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? { SecurityGroups: [managedSecurityGroup('invoice-perfect-production-postgres', 'sg-new')] }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-new' };
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceId: 'invoice-perfect-production-postgres',
        resourceCreated: true,
        instanceMutationAttempted: true,
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        provider: 'rds',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
      },
    });
    expect(rdsSend.mock.calls.filter(([command]) => command instanceof CreateDBInstanceCommand))
      .toHaveLength(1);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand))
      .toBe(false);
  });

  it('retains deterministic instance and network identity when lost create stays unobservable', async () => {
    vi.stubEnv('HYPERVIBE_RDS_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RDS_CREATE_RECOVERY_DELAY_MS', '0');
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) {
          throw new Error('connection closed after request transmission');
        }
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? { SecurityGroups: [managedSecurityGroup('invoice-perfect-production-postgres', 'sg-new')] }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-new' };
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceId: 'invoice-perfect-production-postgres',
        resourceCreated: 'unknown',
        instanceMutationAttempted: true,
        securityGroupId: 'sg-new',
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        provider: 'rds',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
        securityGroupId: 'sg-new',
        securityGroupVpcId: 'vpc-1',
      },
    });
    expect(rdsSend.mock.calls.filter(([command]) => command instanceof CreateDBInstanceCommand))
      .toHaveLength(1);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand))
      .toBe(false);
  });

  it('recovers the exact managed security group after its create transport loses the response', async () => {
    vi.stubEnv('HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS', '2');
    vi.stubEnv('HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS', '0');
    let instanceDescribeCount = 0;
    let filteredSecurityGroupDescribeCount = 0;
    const instance = {
      DBInstanceIdentifier: 'invoice-perfect-production-postgres',
      DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:invoice-perfect-production-postgres',
      DBInstanceStatus: 'available',
      PubliclyAccessible: true,
      Endpoint: { Address: 'invoice-perfect.example.rds.amazonaws.com', Port: 5432 },
      VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-recovered' }],
    };
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          instanceDescribeCount += 1;
          if (instanceDescribeCount === 1) {
            const error = new Error('DB instance not found');
            Object.assign(error, { name: 'DBInstanceNotFoundFault' });
            throw error;
          }
          return { DBInstances: [instance] };
        }
        if (command instanceof CreateDBInstanceCommand) return { DBInstance: instance };
        throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
      ec2Send: async (command) => {
        if (command instanceof CreateSecurityGroupCommand) {
          throw new Error('connection closed after the security-group request was transmitted');
        }
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (command.input.GroupIds) {
            return { SecurityGroups: [managedSecurityGroup('invoice-perfect-production-postgres', 'sg-recovered')] };
          }
          filteredSecurityGroupDescribeCount += 1;
          return {
            SecurityGroups: filteredSecurityGroupDescribeCount < 3
              ? []
              : [managedSecurityGroup('invoice-perfect-production-postgres', 'sg-recovered')],
          };
        }
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: true,
      data: { securityGroupId: 'sg-recovered' },
    });
    expect(result.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
        securityGroupId: 'sg-recovered',
        securityGroupVpcId: 'vpc-1',
      },
    });
    expect(rdsSend.mock.calls.filter(([command]) => command instanceof CreateDBInstanceCommand))
      .toHaveLength(1);
    expect(ec2Send.mock.calls.filter(([command]) => command instanceof CreateSecurityGroupCommand))
      .toHaveLength(1);
  });

  it('retains deterministic scope when create is acknowledged without usable response metadata', async () => {
    vi.stubEnv('HYPERVIBE_RDS_READY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RDS_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_RDS_CREATE_RECOVERY_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RDS_CREATE_RECOVERY_DELAY_MS', '0');
    let preflight = true;
    const { adapter, rdsSend } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) return {};
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error(preflight ? 'DB instance not found before create' : 'DB instance not found after create');
          preflight = false;
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? { SecurityGroups: [managedSecurityGroup(
                'invoice-perfect-production-postgres',
                'sg-existing'
              )] }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-existing' };
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt).toMatchObject({
      success: false,
      data: {
        instanceId: 'invoice-perfect-production-postgres',
        instanceCreateAcknowledged: true,
        resourceCreated: 'unknown',
      },
    });
    expect(result.component).toMatchObject({
      externalId: 'invoice-perfect-production-postgres',
      bindings: {
        provider: 'rds',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
      },
    });
    expect(rdsSend.mock.calls.filter(([command]) => command instanceof CreateDBInstanceCommand))
      .toHaveLength(1);
  });

  it('observes an adopted external id before considering a deterministic fallback name', async () => {
    const observedIdentifiers: Array<string | undefined> = [];
    const { adapter } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (!(command instanceof DescribeDBInstancesCommand)) throw new Error('Unexpected RDS command');
        observedIdentifiers.push(command.input.DBInstanceIdentifier);
        return {
          DBInstances: [{
          DBInstanceIdentifier: 'adopted-rds-id',
          DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:adopted-rds-id',
          DBInstanceStatus: 'available',
          VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
          }],
        };
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [managedSecurityGroup('adopted-rds-id')] };
        }
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });
    const adopted = { ...component, externalId: 'adopted-rds-id' } as Component;

    const observed = await adapter.observeDatabase(environment, adopted, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(observedIdentifiers).toEqual(['adopted-rds-id']);
    expect(observed?.externalId).toBe('adopted-rds-id');
  });

  it('refuses to observe or mutate a binding through a different AWS account', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async () => {
        throw new Error('RDS must not be called for a mismatched binding scope');
      },
    });
    const wrongAccount = {
      ...component,
      bindings: {
        ...component.bindings,
        providerScope: { accountId: '999999999999', region: 'us-west-2' },
        securityGroupManagedByHypervibe: true,
      },
    } as Component;

    await expect(adapter.observeDatabase(environment, wrongAccount))
      .rejects.toThrow('does not match connected account');
    const result = await adapter.destroy(wrongAccount);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('does not match connected account');
    expect(rdsSend).not.toHaveBeenCalled();
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('waits for terminal absence before deleting its managed security group', async () => {
    vi.stubEnv('HYPERVIBE_RDS_READY_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_RDS_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_RDS_NETWORK_DELETE_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_RDS_NETWORK_DELETE_DELAY_MS', '0');
    let describeCount = 0;
    let securityGroupDeleted = false;
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DeleteDBInstanceCommand) return {};
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          if (describeCount < 3) {
            return {
              DBInstances: [{
                DBInstanceIdentifier: component.externalId!,
                DBInstanceStatus: describeCount === 1 ? 'available' : 'deleting',
              }],
            };
          }
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          if (securityGroupDeleted) {
            const error = new Error('Security group not found');
            Object.assign(error, { name: 'InvalidGroup.NotFound' });
            throw error;
          }
          return {
            SecurityGroups: [{
              ...managedSecurityGroup(component.externalId!),
              // RDS security groups created before the durable identity tag was
              // introduced are still pinned by ID, deterministic name, and owner.
              Tags: [{ Key: 'ManagedBy', Value: 'Hypervibe' }],
            }],
          };
        }
        if (command instanceof DeleteSecurityGroupCommand) {
          securityGroupDeleted = true;
          return {};
        }
        throw new Error('Unexpected EC2 command');
      },
    });
    const managed = {
      ...component,
      bindings: {
        ...component.bindings,
        securityGroupManagedByHypervibe: true,
      },
    } as Component;

    const result = await adapter.destroy(managed);

    expect(result.success).toBe(true);
    expect(describeCount).toBe(3);
    expect(rdsSend.mock.calls.some(([command]) => command instanceof DeleteDBInstanceCommand)).toBe(true);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(true);
  });

  it('treats an already-absent instance and security group as idempotent success', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          const error = new Error('Security group not found');
          Object.assign(error, { name: 'InvalidGroup.NotFound' });
          throw error;
        }
        throw new Error('Unexpected EC2 command');
      },
    });
    const managed = {
      ...component,
      bindings: {
        ...component.bindings,
        securityGroupManagedByHypervibe: true,
      },
    } as Component;

    const result = await adapter.destroy(managed);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof DeleteDBInstanceCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(false);
  });

  it('does not report success when a managed security group remains observable after delete acknowledgement', async () => {
    vi.stubEnv('HYPERVIBE_RDS_NETWORK_DELETE_ATTEMPTS', '1');
    vi.stubEnv('HYPERVIBE_RDS_NETWORK_DELETE_DELAY_MS', '0');
    const { adapter, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [managedSecurityGroup(component.externalId!)] };
        }
        if (command instanceof DeleteSecurityGroupCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });
    const managed = {
      ...component,
      bindings: {
        ...component.bindings,
        securityGroupVpcId: 'vpc-1',
        securityGroupManagedByHypervibe: true,
      },
    } as Component;

    const result = await adapter.destroy(managed);

    expect(result.success).toBe(false);
    expect(result.error).toContain('remained observable');
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(true);
  });
});
