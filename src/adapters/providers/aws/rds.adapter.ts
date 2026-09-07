import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  RDSClient,
  type DBInstance,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RevokeSecurityGroupIngressCommand,
  type SecurityGroup,
  type SecurityGroupRule,
  type Subnet,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type {
  DatabaseCapabilities,
  DatabaseTargetOptions,
  IDatabaseAdapter,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import { databaseCreateMayHaveCommitted } from '../../../domain/ports/database.port.js';
import type { Receipt, TemporaryDatabaseAccess, VerifyResult } from '../../../domain/ports/provider.port.js';
import type { IObservableDatabase, ObservedDatabase } from '../../../domain/ports/observe.port.js';
import {
  providerRegistry,
  standardDatabaseRuntimeProjection,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import { buildDatabaseEnvVarsFromComponent } from '../../../domain/services/database-env.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import {
  type AwsWorkloadNetwork,
  hasWorkloadSecurityGroupTags,
  parseAwsWorkloadNetworkBinding,
  parseEcsClusterArn,
  workloadNetworksMatch,
  workloadSecurityGroupName,
} from './aws-workload-network.js';

export const RdsCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, 'Access key ID is required').describe('AWS IAM access key ID'),
  secretAccessKey: z.string().min(1, 'Secret access key is required').describe('AWS IAM secret access key'),
  sessionToken: z.string().optional().describe('Required when using temporary AWS STS credentials'),
  region: z.string().default('us-east-1').describe('AWS region containing the RDS instance'),
  vpcId: z.string().optional().describe('VPC for new RDS instances; defaults to the region default VPC'),
  dbSubnetGroupName: z.string().optional().describe('Existing DB subnet group for new RDS instances'),
});

export type RdsCredentials = z.infer<typeof RdsCredentialsSchema>;

type TemporaryIngress = {
  groupId: string;
  ruleId?: string;
  cidr: string;
  port: number;
};

class RdsSecurityGroupProvisionError extends Error {
  constructor(
    message: string,
    readonly groupId: string | undefined,
    readonly vpcId: string,
    readonly groupName: string
  ) {
    super(message);
    this.name = 'RdsSecurityGroupProvisionError';
  }
}

const PUBLIC_IP_ENDPOINT = 'https://checkip.amazonaws.com/';
const TEMPORARY_INGRESS_DESCRIPTION = 'Hypervibe operation-scoped database query';
const RUNTIME_INGRESS_DESCRIPTION = 'Hypervibe ECS workload access to RDS';
const DATABASE_PORT = 5432;
const DEFAULT_POLL_ATTEMPTS = 120;
const DEFAULT_POLL_DELAY_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeDatabaseUrl(params: {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  const auth = `${encodeURIComponent(params.username)}:${encodeURIComponent(params.password)}`;
  return `postgresql://${auth}@${params.host}:${params.port}/${encodeURIComponent(params.database)}?sslmode=require`;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function cidrContainsIpv4(cidr: string | undefined, address: string): boolean {
  if (!cidr) return false;
  const [networkText, prefixText] = cidr.split('/');
  const network = ipv4ToInt(networkText);
  const target = ipv4ToInt(address);
  const prefix = Number(prefixText);
  if (network === null || target === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (network & mask) === (target & mask);
}

function ruleAllows(rule: SecurityGroupRule, address: string, port: number): boolean {
  return rule.IsEgress !== true
    && rule.IpProtocol === 'tcp'
    && (rule.FromPort ?? -1) <= port
    && (rule.ToPort ?? -1) >= port
    && cidrContainsIpv4(rule.CidrIpv4, address);
}

function hypervibeTemporaryRule(
  rule: SecurityGroupRule,
  address: string,
  port: number
): TemporaryIngress | null {
  if (!ruleAllows(rule, address, port) || rule.Description !== TEMPORARY_INGRESS_DESCRIPTION) {
    return null;
  }
  if (!rule.GroupId || !rule.CidrIpv4) return null;
  return {
    groupId: rule.GroupId,
    ruleId: rule.SecurityGroupRuleId,
    cidr: rule.CidrIpv4,
    port,
  };
}

export class RdsAdapter implements IDatabaseAdapter, IObservableDatabase {
  readonly name = 'rds';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: false,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: RdsCredentials | null = null;
  private rds: RDSClient | null = null;
  private ec2: EC2Client | null = null;
  private sts: STSClient | null = null;
  private accountId: string | null = null;
  private temporaryIngress = new Map<string, TemporaryIngress>();

  async connect(credentials: unknown): Promise<void> {
    this.credentials = RdsCredentialsSchema.parse(credentials);
    this.replaceClients();
  }

  configureTarget(target: DatabaseTargetOptions): void {
    if (!target.region) return;
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const region = z.string().trim().regex(
      /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/,
      'AWS region is invalid'
    ).parse(target.region);
    if (region === this.credentials.region) return;
    this.credentials = { ...this.credentials, region };
    this.replaceClients();
  }

  private replaceClients(): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.rds?.destroy();
    this.ec2?.destroy();
    this.sts?.destroy();
    const awsCredentials = {
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      ...(this.credentials.sessionToken ? { sessionToken: this.credentials.sessionToken } : {}),
    };
    this.rds = new RDSClient({ region: this.credentials.region, credentials: awsCredentials });
    this.ec2 = new EC2Client({ region: this.credentials.region, credentials: awsCredentials });
    this.sts = new STSClient({ region: this.credentials.region, credentials: awsCredentials });
    this.accountId = null;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.rds || !this.ec2 || !this.sts || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const [, , accountId] = await Promise.all([
        this.rds.send(new DescribeDBInstancesCommand({ MaxRecords: 20 })),
        this.ec2.send(new DescribeVpcsCommand({ MaxResults: 5 })),
        this.resolveAccountId(),
      ]);
      return { success: true, email: `AWS account ${accountId} RDS (${this.credentials.region})` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async disconnect(): Promise<void> {
    for (const [token, ingress] of this.temporaryIngress) {
      await this.revokeIngress(ingress).catch(() => {});
      this.temporaryIngress.delete(token);
    }
    this.rds?.destroy();
    this.ec2?.destroy();
    this.sts?.destroy();
    this.rds = null;
    this.ec2 = null;
    this.sts = null;
    this.credentials = null;
    this.accountId = null;
  }

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: { size?: string; region?: string; databaseName?: string; resourceName?: string }
  ): Promise<ProvisionResult> {
    if (!this.rds || !this.ec2 || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (type !== 'postgres') {
      return this.failedProvision(environment, type, `Amazon RDS adapter supports postgres. Requested type: ${type}`);
    }

    const identifier = this.sanitizeIdentifier(options?.resourceName || `${environment.name}-postgres`);
    const database = this.sanitizeDatabaseName(options?.databaseName ?? 'app');
    const username = 'hypervibe_admin';
    const password = this.generatePassword();
    try {
      this.configureForEcsEnvironment(environment, options?.region);
    } catch (error) {
      return this.failedProvision(
        environment,
        type,
        `Amazon RDS requires the exact applied ECS workload network: ${error instanceof Error ? error.message : String(error)}`,
        { instanceId: identifier, resourceCreated: false }
      );
    }
    let securityGroupId: string | undefined;
    let securityGroupVpcId: string | undefined;
    let securityGroupName: string | undefined;
    let securityGroupCreated = false;
    let instanceMutationAttempted = false;
    let instanceCreateAcknowledged = false;
    let instanceCreateMayHaveCommitted = false;
    let existing: DBInstance | null;
    try {
      existing = await this.describeInstance(identifier);
    } catch (error) {
      return this.failedProvision(
        environment,
        type,
        `Could not observe Amazon RDS instance ${identifier}, so Hypervibe refused to create a database whose absence is unknown: ${error instanceof Error ? error.message : String(error)}`,
        {
          instanceId: identifier,
          resourceCreated: 'unknown',
          liveObservationError: error instanceof Error ? error.message : String(error),
        }
      );
    }
    if (existing) {
      return this.failedProvision(
        environment,
        type,
        `Amazon RDS instance ${identifier} already exists. Hypervibe will not silently adopt or replace it; use hv_import for that exact provider identity.`,
        {
          instanceId: existing.DBInstanceIdentifier ?? identifier,
          resourceCreated: true,
        }
      );
    }
    let workloadNetwork: AwsWorkloadNetwork;
    try {
      workloadNetwork = await this.resolveWorkloadNetwork(environment, options?.region);
    } catch (error) {
      return this.failedProvision(
        environment,
        type,
        `Amazon RDS requires the exact applied ECS workload network: ${error instanceof Error ? error.message : String(error)}`,
        { instanceId: identifier, resourceCreated: false }
      );
    }
    const providerScope: Record<string, string> = {
      accountId: workloadNetwork.accountId,
      region: workloadNetwork.region,
    };
    try {
      try {
        const securityGroup = await this.ensureSecurityGroup(identifier, workloadNetwork);
        securityGroupId = securityGroup.id;
        securityGroupVpcId = securityGroup.vpcId;
        securityGroupName = securityGroup.name;
        securityGroupCreated = securityGroup.created;
      } catch (error) {
        if (error instanceof RdsSecurityGroupProvisionError) {
          securityGroupId = error.groupId;
          securityGroupVpcId = error.vpcId;
          securityGroupName = error.groupName;
          securityGroupCreated = true;
        }
        throw error;
      }
      instanceMutationAttempted = true;
      try {
        await this.rds.send(new CreateDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          DBInstanceClass: options?.size ?? 'db.t4g.micro',
          Engine: 'postgres',
          MasterUsername: username,
          MasterUserPassword: password,
          AllocatedStorage: 20,
          DBName: database,
          Port: 5432,
          PubliclyAccessible: true,
          StorageEncrypted: true,
          BackupRetentionPeriod: 7,
          MultiAZ: false,
          StorageType: 'gp3',
          VpcSecurityGroupIds: [securityGroupId],
          ...(this.credentials.dbSubnetGroupName ? { DBSubnetGroupName: this.credentials.dbSubnetGroupName } : {}),
          Tags: [
            { Key: 'Environment', Value: environment.name },
            { Key: 'ManagedBy', Value: 'Hypervibe' },
          ],
        }));
      } catch (error) {
        instanceCreateMayHaveCommitted = databaseCreateMayHaveCommitted(error);
        throw error;
      }
      instanceCreateMayHaveCommitted = true;
      instanceCreateAcknowledged = true;

      const instance = await this.waitForInstance(identifier, 'available');
      if (!instance.Endpoint?.Address || !instance.Endpoint.Port) {
        throw new Error(`RDS instance ${identifier} became available without an endpoint.`);
      }
      await this.assertInstanceNetwork(instance, identifier, securityGroupId, workloadNetwork);
      const connectionUrl = encodeDatabaseUrl({
        username,
        password,
        host: instance.Endpoint.Address,
        port: instance.Endpoint.Port,
        database,
      });
      const liveScope = this.instanceScope(instance);
      if (liveScope.accountId !== providerScope.accountId || liveScope.region !== providerScope.region) {
        throw new Error(`RDS instance ${identifier} resolved outside the connected account or desired region.`);
      }
      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'postgres',
        bindings: {
          provider: 'rds',
          instanceId: identifier,
          instanceArn: instance.DBInstanceArn,
          providerScope: liveScope,
          connectionString: connectionUrl,
          host: instance.Endpoint.Address,
          port: instance.Endpoint.Port,
          username,
          password,
          database,
          securityGroupId,
          securityGroupVpcId,
          securityGroupName,
          securityGroupManagedByHypervibe: true,
          securityGroupRuntimeIngressManaged: true,
          workloadSecurityGroupId: workloadNetwork.workloadSecurityGroupId,
          subnetIds: workloadNetwork.subnetIds,
          publiclyAccessible: instance.PubliclyAccessible === true,
        },
        externalId: identifier,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component,
        connectionUrl,
        envVars: buildDatabaseEnvVarsFromComponent(component).envVars,
        receipt: {
          success: true,
          message: `Created and verified Amazon RDS PostgreSQL instance ${identifier}`,
          data: { instanceId: identifier, status: instance.DBInstanceStatus, securityGroupId },
        },
      };
    } catch (error) {
      let live: DBInstance | null | undefined;
      let liveObservationError: string | undefined;
      try {
        live = instanceCreateMayHaveCommitted
          ? await this.recoverInstanceAfterCreateAttempt(identifier)
          : await this.describeInstance(identifier);
      } catch (observationError) {
        liveObservationError = observationError instanceof Error
          ? observationError.message
          : String(observationError);
      }
      // Delete the network resource only after RDS positively confirms that
      // no database exists. An unreadable instance is unknown, not absent.
      let networkCleanupError: string | undefined;
      if (live === null && !instanceCreateMayHaveCommitted && securityGroupCreated && securityGroupId) {
        try {
          await this.deleteSecurityGroupById(
            securityGroupId,
            identifier,
            securityGroupVpcId
          );
          securityGroupId = undefined;
          securityGroupVpcId = undefined;
          securityGroupName = undefined;
          securityGroupCreated = false;
        } catch (cleanupError) {
          networkCleanupError = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        }
      }
      const retainIdentity = securityGroupCreated
        || Boolean(securityGroupId)
        || instanceCreateMayHaveCommitted;
      const partialComponent = retainIdentity
        ? this.partialProvisionComponent({
            environment,
            identifier,
            type,
            providerScope,
            username,
            password,
            database,
            live,
            securityGroupId,
            securityGroupVpcId,
            securityGroupName,
            securityGroupCreated,
            instanceMutationAttempted,
            workloadNetwork,
          })
        : undefined;
      return this.failedProvision(
        environment,
        type,
        `Failed to provision Amazon RDS PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
        {
          instanceId: identifier,
          providerScope,
          instanceMutationAttempted,
          instanceCreateAcknowledged,
          instanceCreateMayHaveCommitted,
          resourceCreated: live === undefined || (instanceCreateMayHaveCommitted && live === null)
            ? 'unknown'
            : Boolean(live),
          securityGroupId,
          securityGroupVpcId,
          securityGroupName,
          ...(liveObservationError ? { liveObservationError } : {}),
          ...(networkCleanupError ? { networkCleanupError } : {}),
        },
        partialComponent
      );
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.rds || !component.externalId) return null;
    await this.assertComponentScope(component);
    const bindings = component.bindings as Record<string, unknown>;
    const instance = await this.describeInstance(component.externalId);
    if (!instance?.Endpoint?.Address || !instance.Endpoint.Port) return null;
    const username = typeof bindings.username === 'string' ? bindings.username : undefined;
    const password = typeof bindings.password === 'string' ? bindings.password : undefined;
    const database = typeof bindings.database === 'string' ? bindings.database : undefined;
    if (!username || !password || !database) return null;
    return encodeDatabaseUrl({
      username,
      password,
      database,
      host: instance.Endpoint.Address,
      port: instance.Endpoint.Port,
    });
  }

  async acquireTemporaryDatabaseAccess(
    environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.rds || !this.ec2 || !component.externalId) {
      throw new Error('Amazon RDS access requires a connected adapter and a tracked DB instance.');
    }
    await this.assertComponentScope(component);
    const instance = await this.describeInstance(component.externalId);
    if (!instance?.Endpoint?.Address || !instance.Endpoint.Port) {
      throw new Error(`Amazon RDS instance ${component.externalId} has no available endpoint.`);
    }
    if (instance.PubliclyAccessible !== true) {
      throw new Error('The Amazon RDS instance is private. Configure a durable VPC/SSM network path in desired state or pass a reachable connectionName; hv_db_query will not create a billable proxy or bastion implicitly.');
    }
    const network = await this.resolveWorkloadNetwork(environment);
    const port = instance.Endpoint.Port || applicationPort;
    const groupId = this.securityGroupId(component, instance);
    if (!groupId) {
      throw new Error('Amazon RDS instance has no VPC security group available for operation-scoped access.');
    }
    await this.assertInstanceNetwork(instance, component.externalId, groupId, network);
    const address = await this.resolvePublicIpv4();
    const cidr = `${address}/32`;
    const rules = await this.ec2.send(new DescribeSecurityGroupRulesCommand({
      Filters: [{ Name: 'group-id', Values: [groupId] }],
    }));
    const connectionUrl = await this.getConnectionUrl(component);
    if (!connectionUrl) {
      throw new Error('Amazon RDS bindings are missing database credentials.');
    }
    const staleTemporaryRule = (rules.SecurityGroupRules ?? [])
      .map((rule) => hypervibeTemporaryRule(rule, address, port))
      .find((rule): rule is TemporaryIngress => Boolean(rule));
    if (staleTemporaryRule) {
      const releaseToken = staleTemporaryRule.ruleId ?? randomUUID();
      this.temporaryIngress.set(releaseToken, staleTemporaryRule);
      return {
        connectionUrl,
        source: 'temporary_firewall',
        temporary: true,
        releaseToken,
      };
    }
    if ((rules.SecurityGroupRules ?? []).some((rule) => ruleAllows(rule, address, port))) {
      return { connectionUrl, source: 'direct', temporary: false };
    }

    const authorized = await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: cidr, Description: TEMPORARY_INGRESS_DESCRIPTION }],
      }],
    }));
    const ruleId = authorized.SecurityGroupRules?.[0]?.SecurityGroupRuleId;
    const releaseToken = ruleId ?? randomUUID();
    this.temporaryIngress.set(releaseToken, { groupId, ruleId, cidr, port });
    return {
      connectionUrl,
      source: 'temporary_firewall',
      temporary: true,
      releaseToken,
    };
  }

  async releaseTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    await this.assertComponentScope(component);
    if (!access.releaseToken) throw new Error('Temporary Amazon RDS access is missing its cleanup token.');
    const ingress = this.temporaryIngress.get(access.releaseToken);
    if (!ingress) return;
    await this.revokeIngress(ingress);
    this.temporaryIngress.delete(access.releaseToken);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.rds || !this.ec2 || !component.externalId) {
      return { success: false, message: 'Amazon RDS adapter is not connected or the component has no instance ID' };
    }
    try {
      await this.assertComponentScope(component);
      const existing = await this.describeInstance(component.externalId);
      if (!existing) {
        await this.deleteManagedSecurityGroup(component);
        return { success: true, message: `Amazon RDS instance is already absent: ${component.externalId}` };
      }
      await this.rds.send(new DeleteDBInstanceCommand({
        DBInstanceIdentifier: component.externalId,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      }));
      await this.waitForInstance(component.externalId, 'deleted');
      await this.deleteManagedSecurityGroup(component);
      return { success: true, message: `Deleted Amazon RDS instance ${component.externalId}` };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'DBInstanceNotFound' || name === 'DBInstanceNotFoundFault') {
        try {
          await this.deleteManagedSecurityGroup(component);
          return { success: true, message: `Amazon RDS instance is already absent: ${component.externalId}` };
        } catch (cleanupError) {
          return {
            success: false,
            message: `Amazon RDS instance is absent but managed network cleanup failed`,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          };
        }
      }
      return {
        success: false,
        message: `Failed to delete Amazon RDS instance ${component.externalId}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!component.externalId) return { status: 'unknown' };
    let instance: DBInstance | null;
    try {
      await this.assertComponentScope(component);
      instance = await this.describeInstance(component.externalId);
    } catch (error) {
      return {
        status: 'unknown',
        message: `Failed to observe instance: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!instance) return { status: 'unknown', message: 'Instance not found' };
    return { status: this.normalizedStatus(instance.DBInstanceStatus), message: instance.DBInstanceStatus };
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (component) await this.assertComponentScope(component);
    const identifier = component?.externalId
      ?? this.sanitizeIdentifier(options?.resourceName || `${environment.name}-postgres`);
    const instance = await this.describeInstance(identifier);
    if (!instance) return null;
    if (component) {
      const network = await this.resolveWorkloadNetwork(environment);
      const bindings = component.bindings as Record<string, unknown>;
      const securityGroupId = typeof bindings.securityGroupId === 'string'
        ? bindings.securityGroupId
        : undefined;
      await this.assertInstanceNetwork(instance, identifier, securityGroupId, network);
    }
    return {
      provider: 'rds',
      engine: 'postgres',
      externalId: instance.DBInstanceIdentifier ?? identifier,
      providerScope: this.instanceScope(instance),
      name: instance.DBInstanceIdentifier ?? identifier,
      status: this.normalizedStatus(instance.DBInstanceStatus),
    };
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.rds || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const selected = request.id ?? request.name;
    let instances: DBInstance[];
    let truncated = false;
    if (selected) {
      const instance = await this.describeInstance(selected);
      instances = instance ? [instance] : [];
    } else {
      const response = await this.rds.send(new DescribeDBInstancesCommand({
        MaxRecords: Math.max(20, Math.min(request.limit, 100)),
      }));
      instances = response.DBInstances ?? [];
      truncated = Boolean(response.Marker) || instances.length > request.limit;
    }
    const databases = instances.slice(0, request.limit).map((instance) => ({
      id: instance.DBInstanceIdentifier,
      name: instance.DBInstanceIdentifier,
      engine: instance.Engine === 'postgres' ? 'postgres' : instance.Engine ?? 'unknown',
      ...(instance.EngineVersion ? { databaseVersion: instance.EngineVersion } : {}),
      status: this.normalizedStatus(instance.DBInstanceStatus),
      ...(instance.AvailabilityZone ? { availabilityZone: instance.AvailabilityZone } : {}),
      providerScope: this.instanceScope(instance),
    }));
    return {
      observation: instances.length > 0 ? 'present' : 'absent',
      resource: 'database',
      databases,
      ...(instances.length === 0 && selected
        ? { [request.id ? 'id' : 'name']: selected }
        : {}),
      truncated,
      partial: false,
    };
  }

  private instanceScope(instance: DBInstance): Record<string, string> {
    const arn = instance.DBInstanceArn?.split(':');
    const region = arn?.[3];
    const accountId = arn?.[4];
    if (!region || !accountId) {
      throw new Error(
        `Amazon RDS instance ${instance.DBInstanceIdentifier ?? 'without an identifier'} returned no durable account/region scope.`
      );
    }
    return { accountId, region };
  }

  private async assertComponentScope(component: Component): Promise<void> {
    if (!this.credentials) throw new Error('Amazon RDS adapter is not connected.');
    const bindings = component.bindings as Record<string, unknown>;
    const rawScope = bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const accountId = typeof scope?.accountId === 'string' ? scope.accountId : undefined;
    const region = typeof scope?.region === 'string' ? scope.region : undefined;
    if (!accountId || !region) {
      throw new Error(
        `Amazon RDS binding ${component.externalId ?? component.id} is missing its durable accountId/region provider scope; re-import or re-plan the database before using it.`
      );
    }
    this.configureTarget({ region });
    if (region !== this.credentials.region) {
      throw new Error(
        `Amazon RDS binding scope region ${region} does not match connected region ${this.credentials.region}.`
      );
    }
    const connectedAccountId = await this.resolveAccountId();
    if (accountId !== connectedAccountId) {
      throw new Error(
        `Amazon RDS binding scope account ${accountId} does not match connected account ${connectedAccountId}.`
      );
    }
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    if (!this.sts) throw new Error('Amazon STS adapter is not connected.');
    const identity = await this.sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
      throw new Error('AWS did not return a valid account identity for the RDS connection.');
    }
    this.accountId = identity.Account;
    return this.accountId;
  }

  private configureForEcsEnvironment(
    environment: Environment,
    requestedRegion?: string
  ): { projectId: string; accountId: string; region: string; clusterName: string } {
    const hosting = parseHostingBindings(environment);
    if (hosting.provider !== 'ecs' || !hosting.projectId) {
      throw new Error('Amazon RDS requires this environment to be bound to AWS ECS Express.');
    }
    const cluster = parseEcsClusterArn(hosting.projectId);
    if (requestedRegion && requestedRegion !== cluster.region) {
      throw new Error(
        `Amazon RDS region ${requestedRegion} must match the bound ECS workload region ${cluster.region}.`
      );
    }
    this.configureTarget({ region: cluster.region });
    return { projectId: hosting.projectId, ...cluster };
  }

  private async resolveWorkloadNetwork(
    environment: Environment,
    requestedRegion?: string
  ): Promise<AwsWorkloadNetwork> {
    if (!this.credentials || !this.ec2 || !this.rds) {
      throw new Error('Not connected. Call connect() first.');
    }
    const cluster = this.configureForEcsEnvironment(environment, requestedRegion);

    const accountId = await this.resolveAccountId();
    if (cluster.accountId !== accountId) {
      throw new Error(
        `Bound ECS cluster ${cluster.projectId} is outside the connected AWS account ${accountId}.`
      );
    }
    const persisted = parseAwsWorkloadNetworkBinding(environment);
    if (!persisted) {
      throw new Error(
        'The ECS project has no reviewed AWS workload-network binding. Apply the ECS project action before provisioning RDS.'
      );
    }
    if (persisted.accountId !== accountId || persisted.region !== cluster.region) {
      throw new Error(
        'The persisted AWS workload-network binding is outside the connected account or bound ECS region.'
      );
    }

    const vpcs = await this.ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }));
    if (!Array.isArray(vpcs.Vpcs)) {
      throw new Error('AWS default-VPC observation returned an invalid VPC list.');
    }
    if (vpcs.Vpcs.length !== 1 || !vpcs.Vpcs[0]?.VpcId || vpcs.Vpcs[0].IsDefault !== true) {
      throw new Error('AWS did not return exactly one complete default VPC for the bound ECS region.');
    }
    const vpcId = vpcs.Vpcs[0].VpcId;
    if (persisted.vpcId !== vpcId) {
      throw new Error(
        `Persisted AWS workload VPC ${persisted.vpcId} is not the exact default VPC ${vpcId}.`
      );
    }
    if (this.credentials.vpcId && this.credentials.vpcId !== vpcId) {
      throw new Error(
        `Legacy RDS connection VPC ${this.credentials.vpcId} does not match the reviewed ECS workload VPC ${vpcId}.`
      );
    }
    if (this.credentials.dbSubnetGroupName) {
      const subnetGroups = await this.rds.send(new DescribeDBSubnetGroupsCommand({
        DBSubnetGroupName: this.credentials.dbSubnetGroupName,
      }));
      const groups = subnetGroups.DBSubnetGroups;
      if (!Array.isArray(groups) || groups.length !== 1) {
        throw new Error(
          `AWS did not return exactly one RDS subnet group named ${this.credentials.dbSubnetGroupName}.`
        );
      }
      const subnetGroup = groups[0]!;
      if (subnetGroup.DBSubnetGroupName !== this.credentials.dbSubnetGroupName
        || subnetGroup.VpcId !== vpcId) {
        throw new Error(
          `RDS subnet group ${this.credentials.dbSubnetGroupName} is outside the reviewed ECS workload VPC ${vpcId}.`
        );
      }
    }

    const subnetIds = await this.defaultVpcSubnetIds(vpcId);
    const workloadGroup = await this.securityGroupById(persisted.workloadSecurityGroupId);
    if (!workloadGroup) {
      throw new Error(
        `Bound AWS workload security group ${persisted.workloadSecurityGroupId} is absent; RDS will not create or select a replacement.`
      );
    }
    if (workloadGroup.GroupName !== workloadSecurityGroupName(cluster.clusterName)
      || workloadGroup.VpcId !== vpcId
      || !hasWorkloadSecurityGroupTags(workloadGroup.Tags, cluster.projectId, environment.id)) {
      throw new Error(
        `AWS workload security group ${persisted.workloadSecurityGroupId} is outside the reviewed ECS project identity.`
      );
    }
    const observed: AwsWorkloadNetwork = {
      accountId,
      region: cluster.region,
      vpcId,
      subnetIds,
      workloadSecurityGroupId: persisted.workloadSecurityGroupId,
    };
    if (!workloadNetworksMatch(persisted, observed)) {
      throw new Error(
        'The AWS workload-network identity changed after ECS project reconciliation; re-run hv_plan before provisioning RDS.'
      );
    }
    return observed;
  }

  private async defaultVpcSubnetIds(vpcId: string): Promise<string[]> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
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
      if (!subnet.SubnetId
        || subnet.VpcId !== vpcId
        || subnet.DefaultForAz !== true
        || !subnet.AvailabilityZone) {
        throw new Error(`AWS returned an incomplete or cross-VPC default subnet for ${vpcId}.`);
      }
      zones.add(subnet.AvailabilityZone);
      return subnet.SubnetId;
    });
    if (new Set(subnetIds).size !== subnetIds.length) {
      throw new Error(`AWS returned duplicate default-subnet identities for VPC ${vpcId}.`);
    }
    if (subnetIds.length < 2 || zones.size < 2) {
      throw new Error(
        `Amazon RDS requires default subnets in at least two availability zones of VPC ${vpcId}.`
      );
    }
    return subnetIds.sort();
  }

  private async ensureSecurityGroup(
    identifier: string,
    network: AwsWorkloadNetwork
  ): Promise<{ id: string; vpcId: string; name: string; created: boolean }> {
    if (!this.ec2 || !this.credentials) throw new Error('Amazon EC2 adapter is not connected.');
    const vpcId = network.vpcId;
    const groupName = this.sanitizeIdentifier(`${identifier}-hypervibe-db`);
    const existing = await this.managedSecurityGroupByName(identifier, groupName, vpcId);
    if (existing) {
      throw new Error(
        `An RDS security group already exists for ${identifier} (${existing.GroupId}). Hypervibe will not silently adopt an unbound network resource; clean up or import the retained database binding first.`
      );
    }

    let groupId: string | undefined;
    let createError: unknown;
    try {
      const created = await this.ec2.send(new CreateSecurityGroupCommand({
        GroupName: groupName,
        Description: `ECS workload access to PostgreSQL for ${identifier}`,
        VpcId: vpcId,
        TagSpecifications: [{
          ResourceType: 'security-group',
          Tags: [{ Key: 'ManagedBy', Value: 'Hypervibe' }, { Key: 'Database', Value: identifier }],
        }],
      }));
      groupId = created.GroupId;
      if (!groupId) {
        createError = new Error('AWS acknowledged the RDS security-group create without returning its ID.');
      }
    } catch (error) {
      createError = error;
    }

    if (!groupId) {
      try {
        const recovered = await this.recoverSecurityGroupAfterCreateAttempt(identifier, groupName, vpcId);
        groupId = recovered?.GroupId;
      } catch (recoveryError) {
        const createMessage = createError instanceof Error ? createError.message : String(createError);
        const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new RdsSecurityGroupProvisionError(
          `Could not recover the exact RDS security group after its create response was ambiguous: ${createMessage}; recovery failed: ${recoveryMessage}`,
          undefined,
          vpcId,
          groupName
        );
      }
      if (!groupId) {
        const createMessage = createError instanceof Error ? createError.message : String(createError);
        throw new RdsSecurityGroupProvisionError(
          `Could not recover the exact RDS security group after its create response was ambiguous: ${createMessage}`,
          undefined,
          vpcId,
          groupName
        );
      }
    }

    try {
      const observed = await this.recoverSecurityGroupById(groupId);
      if (!observed) throw new Error(`RDS security group ${groupId} disappeared after creation.`);
      this.assertManagedSecurityGroup(observed, identifier, vpcId);
      await this.ensureRuntimeIngress(observed, identifier, network);
    } catch (error) {
      throw new RdsSecurityGroupProvisionError(
        `Could not verify newly created RDS security group ${groupId}: ${error instanceof Error ? error.message : String(error)}`,
        groupId,
        vpcId,
        groupName
      );
    }
    return { id: groupId, vpcId, name: groupName, created: true };
  }

  private async managedSecurityGroupByName(
    identifier: string,
    groupName: string,
    vpcId: string
  ): Promise<SecurityGroup | null> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    const output = await this.ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [groupName] },
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'tag:ManagedBy', Values: ['Hypervibe'] },
        { Name: 'tag:Database', Values: [identifier] },
      ],
    }));
    if (!Array.isArray(output.SecurityGroups)) {
      throw new Error(`AWS returned an invalid security-group list for RDS instance ${identifier}.`);
    }
    if (output.SecurityGroups.length > 1) {
      throw new Error(`AWS returned multiple managed security groups for RDS instance ${identifier}.`);
    }
    const group = output.SecurityGroups[0];
    if (!group) return null;
    if (!group.GroupId) {
      throw new Error(`AWS returned an RDS security group without an ID for ${identifier}.`);
    }
    this.assertManagedSecurityGroup(group, identifier, vpcId);
    return group;
  }

  private assertRuntimeIngress(
    group: SecurityGroup,
    network: AwsWorkloadNetwork
  ): void {
    if (!Array.isArray(group.IpPermissions) || group.IpPermissions.length !== 1) {
      throw new Error(
        `RDS security group ${group.GroupId ?? 'without an ID'} does not have exactly one ECS-workload ingress rule.`
      );
    }
    const permission = group.IpPermissions[0]!;
    const pairs = permission.UserIdGroupPairs ?? [];
    if (permission.IpProtocol !== 'tcp'
      || permission.FromPort !== DATABASE_PORT
      || permission.ToPort !== DATABASE_PORT
      || pairs.length !== 1
      || pairs[0]?.GroupId !== network.workloadSecurityGroupId
      || (permission.IpRanges?.length ?? 0) > 0
      || (permission.Ipv6Ranges?.length ?? 0) > 0
      || (permission.PrefixListIds?.length ?? 0) > 0) {
      throw new Error(
        `RDS security group ${group.GroupId ?? 'without an ID'} ingress is not limited to ECS workload security group ${network.workloadSecurityGroupId} on port ${DATABASE_PORT}.`
      );
    }
  }

  private async ensureRuntimeIngress(
    group: SecurityGroup,
    identifier: string,
    network: AwsWorkloadNetwork
  ): Promise<void> {
    if (!this.ec2 || !group.GroupId) {
      throw new Error('Amazon EC2 adapter or RDS security-group identity is unavailable.');
    }
    if ((group.IpPermissions?.length ?? 0) > 0) {
      this.assertRuntimeIngress(group, network);
      return;
    }

    let authorizeError: unknown;
    try {
      await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: group.GroupId,
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: DATABASE_PORT,
          ToPort: DATABASE_PORT,
          UserIdGroupPairs: [{
            GroupId: network.workloadSecurityGroupId,
            Description: RUNTIME_INGRESS_DESCRIPTION,
          }],
        }],
      }));
    } catch (error) {
      authorizeError = error;
    }

    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RDS_NETWORK_READY_ATTEMPTS',
      3
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RDS_NETWORK_READY_DELAY_MS',
      DEFAULT_POLL_DELAY_MS
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.securityGroupById(group.GroupId);
      if (observed) {
        this.assertManagedSecurityGroup(observed, identifier, network.vpcId);
        if ((observed.IpPermissions?.length ?? 0) > 0) {
          this.assertRuntimeIngress(observed, network);
          return;
        }
      }
      if (attempt < attempts) await delay(delayMs);
    }
    throw new Error(
      authorizeError
        ? `RDS workload ingress could not be proven after an ambiguous authorize response: ${authorizeError instanceof Error ? authorizeError.message : String(authorizeError)}`
        : `RDS workload ingress was not observable after authorization for security group ${group.GroupId}.`
    );
  }

  private async assertInstanceNetwork(
    instance: DBInstance,
    identifier: string,
    securityGroupId: string | undefined,
    network: AwsWorkloadNetwork
  ): Promise<void> {
    if (!securityGroupId) {
      throw new Error(`RDS instance ${identifier} is missing its reviewed database security-group identity.`);
    }
    const attached = (instance.VpcSecurityGroups ?? [])
      .map((item) => item.VpcSecurityGroupId)
      .filter((value): value is string => Boolean(value));
    if (attached.length !== 1 || attached[0] !== securityGroupId) {
      throw new Error(
        `RDS instance ${identifier} is not attached exclusively to reviewed security group ${securityGroupId}.`
      );
    }
    const group = await this.securityGroupById(securityGroupId);
    if (!group) {
      throw new Error(`RDS security group ${securityGroupId} is absent.`);
    }
    this.assertManagedSecurityGroup(group, identifier, network.vpcId);
    this.assertRuntimeIngress(group, network);
  }

  private async recoverSecurityGroupAfterCreateAttempt(
    identifier: string,
    groupName: string,
    vpcId: string
  ): Promise<SecurityGroup | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS',
      3
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS',
      DEFAULT_POLL_DELAY_MS
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const group = await this.managedSecurityGroupByName(identifier, groupName, vpcId);
      if (group) return group;
      if (attempt < attempts) await delay(delayMs);
    }
    return null;
  }

  private async recoverSecurityGroupById(groupId: string): Promise<SecurityGroup | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_ATTEMPTS',
      3
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RDS_SECURITY_GROUP_CREATE_RECOVERY_DELAY_MS',
      DEFAULT_POLL_DELAY_MS
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const group = await this.securityGroupById(groupId);
      if (group) return group;
      if (attempt < attempts) await delay(delayMs);
    }
    return null;
  }

  private async deleteManagedSecurityGroup(component: Component): Promise<void> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    const bindings = component.bindings as Record<string, unknown>;
    if (bindings.securityGroupManagedByHypervibe !== true) return;
    let groupId = typeof bindings.securityGroupId === 'string'
      ? bindings.securityGroupId
      : undefined;
    const vpcId = typeof bindings.securityGroupVpcId === 'string'
      ? bindings.securityGroupVpcId
      : undefined;
    if (!groupId && bindings.securityGroupCreatedDuringProvision === true) {
      const groupName = typeof bindings.securityGroupName === 'string'
        ? bindings.securityGroupName
        : undefined;
      if (!component.externalId || !vpcId || !groupName) {
        throw new Error(
          'The retained RDS security-group create has no exact ID and lacks its deterministic name/VPC cleanup identity.'
        );
      }
      const recovered = await this.recoverSecurityGroupAfterCreateAttempt(
        component.externalId,
        groupName,
        vpcId
      );
      groupId = recovered?.GroupId;
      if (!groupId) {
        throw new Error(
          `The outcome of the retained RDS security-group create (${groupName} in ${vpcId}) is still unknown; keep the cleanup binding and retry after provider visibility converges.`
        );
      }
    }
    if (groupId) {
      await this.deleteSecurityGroupById(groupId, component.externalId!, vpcId, true);
    }
  }

  private async securityGroupById(groupId: string): Promise<SecurityGroup | null> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    try {
      const output = await this.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
      if (!Array.isArray(output.SecurityGroups)) {
        throw new Error(`AWS returned an invalid exact security-group collection for ${groupId}.`);
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

  private assertManagedSecurityGroup(
    group: SecurityGroup,
    identifier: string,
    vpcId?: string,
    allowLegacyDatabaseTag = false
  ): void {
    const tags = new Map((group.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
    const expectedName = this.sanitizeIdentifier(`${identifier}-hypervibe-db`);
    const databaseTag = tags.get('Database');
    if (group.GroupName !== expectedName
      || !group.VpcId
      || (vpcId && group.VpcId !== vpcId)
      || tags.get('ManagedBy') !== 'Hypervibe'
      || (databaseTag !== identifier && !(allowLegacyDatabaseTag && databaseTag === undefined))) {
      throw new Error(`RDS security group ${group.GroupId ?? 'without an ID'} is outside the reviewed database/VPC identity.`);
    }
  }

  private async deleteSecurityGroupById(
    groupId: string,
    identifier: string,
    vpcId?: string,
    allowLegacyDatabaseTag = false
  ): Promise<void> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    const attempts = this.positiveIntegerEnv('HYPERVIBE_RDS_NETWORK_DELETE_ATTEMPTS', 30);
    const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_RDS_NETWORK_DELETE_DELAY_MS', DEFAULT_POLL_DELAY_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const group = await this.securityGroupById(groupId);
      if (!group) return;
      this.assertManagedSecurityGroup(group, identifier, vpcId, allowLegacyDatabaseTag);
      try {
        await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      } catch (error) {
        if (this.hasErrorName(error, 'InvalidGroup.NotFound')) return;
        if (!this.hasErrorName(error, 'DependencyViolation') || attempt === attempts - 1) throw error;
      }
      if (attempt < attempts - 1) await delay(delayMs);
    }
    const remaining = await this.securityGroupById(groupId);
    if (remaining) {
      this.assertManagedSecurityGroup(remaining, identifier, vpcId, allowLegacyDatabaseTag);
      throw new Error(`RDS security group ${groupId} remained observable after deletion.`);
    }
  }

  private async describeInstance(identifier: string): Promise<DBInstance | null> {
    if (!this.rds) throw new Error('Amazon RDS adapter is not connected.');
    try {
      const response = await this.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
      if (!Array.isArray(response.DBInstances) || response.DBInstances.length !== 1) {
        throw new Error(
          `Amazon RDS returned ${response.DBInstances?.length ?? 0} instances for exact identifier ${identifier}; absence was not confirmed by a not-found response.`
        );
      }
      const instance = response.DBInstances[0];
      if (
        !instance.DBInstanceIdentifier
        || instance.DBInstanceIdentifier.toLowerCase() !== identifier.toLowerCase()
      ) {
        throw new Error(
          `Amazon RDS returned an instance that did not match exact identifier ${identifier}.`
        );
      }
      return instance;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'DBInstanceNotFound' || name === 'DBInstanceNotFoundFault') return null;
      throw error;
    }
  }

  private async waitForInstance(identifier: string, target: 'available' | 'deleted'): Promise<DBInstance> {
    const attempts = Number(process.env.HYPERVIBE_RDS_READY_ATTEMPTS ?? DEFAULT_POLL_ATTEMPTS);
    const delayMs = Number(process.env.HYPERVIBE_RDS_READY_DELAY_MS ?? DEFAULT_POLL_DELAY_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const instance = await this.describeInstance(identifier);
      if (target === 'deleted' && !instance) return { DBInstanceIdentifier: identifier };
      if (target === 'available' && instance?.DBInstanceStatus === 'available') return instance;
      if (instance && /failed|incompatible|storage-full|restore-error/i.test(instance.DBInstanceStatus ?? '')) {
        throw new Error(`RDS instance ${identifier} entered terminal status ${instance.DBInstanceStatus}.`);
      }
      if (attempt < attempts - 1) await delay(delayMs);
    }
    throw new Error(`RDS instance ${identifier} did not become ${target} before timeout.`);
  }

  private async recoverInstanceAfterCreateAttempt(
    identifier: string
  ): Promise<DBInstance | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RDS_CREATE_RECOVERY_ATTEMPTS',
      3
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RDS_CREATE_RECOVERY_DELAY_MS',
      DEFAULT_POLL_DELAY_MS
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const instance = await this.describeInstance(identifier);
      if (instance) return instance;
      if (attempt < attempts) await delay(delayMs);
    }
    return null;
  }

  private securityGroupId(component: Component, instance: DBInstance): string | undefined {
    const bindings = component.bindings as Record<string, unknown>;
    return typeof bindings.securityGroupId === 'string'
      ? bindings.securityGroupId
      : instance.VpcSecurityGroups?.[0]?.VpcSecurityGroupId;
  }

  private async resolvePublicIpv4(): Promise<string> {
    const response = await fetch(PUBLIC_IP_ENDPOINT, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Could not determine the Hypervibe caller IP: ${response.status}.`);
    const address = (await response.text()).trim();
    if (ipv4ToInt(address) === null) throw new Error('AWS public-IP lookup did not return a valid IPv4 address.');
    return address;
  }

  private async revokeIngress(ingress: TemporaryIngress): Promise<void> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    await this.ec2.send(new RevokeSecurityGroupIngressCommand({
      GroupId: ingress.groupId,
      ...(ingress.ruleId
        ? { SecurityGroupRuleIds: [ingress.ruleId] }
        : {
          IpPermissions: [{
            IpProtocol: 'tcp',
            FromPort: ingress.port,
            ToPort: ingress.port,
            IpRanges: [{ CidrIp: ingress.cidr }],
          }],
        }),
    }));
  }

  private normalizedStatus(status?: string): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    if (!status) return 'unknown';
    if (['available', 'backing-up', 'maintenance', 'storage-optimization'].includes(status)) return 'running';
    if (['stopped', 'stopping', 'deleting'].includes(status)) return 'stopped';
    if (/failed|incompatible|storage-full|restore-error/.test(status)) return 'error';
    return 'provisioning';
  }

  private failedProvision(
    environment: Environment,
    type: ProvisionableType,
    error: string,
    data?: Record<string, unknown>,
    component?: Component
  ): ProvisionResult {
    return {
      component: component ?? {
        id: '', environmentId: environment.id, type, bindings: {}, externalId: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
      receipt: { success: false, message: 'Failed to provision Amazon RDS instance', error, data },
    };
  }

  private partialProvisionComponent(params: {
    environment: Environment;
    identifier: string;
    type: ProvisionableType;
    providerScope: Record<string, string>;
    username: string;
    password: string;
    database: string;
    live?: DBInstance | null;
    securityGroupId?: string;
    securityGroupVpcId?: string;
    securityGroupName?: string;
    securityGroupCreated: boolean;
    instanceMutationAttempted: boolean;
    workloadNetwork: AwsWorkloadNetwork;
  }): Component {
    const endpoint = params.live?.Endpoint;
    const connectionString = endpoint?.Address && endpoint.Port
      ? encodeDatabaseUrl({
          username: params.username,
          password: params.password,
          host: endpoint.Address,
          port: endpoint.Port,
          database: params.database,
        })
      : undefined;
    return {
      id: '',
      environmentId: params.environment.id,
      type: params.type,
      externalId: params.identifier,
      bindings: {
        provider: 'rds',
        instanceId: params.identifier,
        ...(params.live?.DBInstanceArn ? { instanceArn: params.live.DBInstanceArn } : {}),
        providerScope: params.providerScope,
        username: params.username,
        password: params.password,
        database: params.database,
        ...(connectionString ? { connectionString } : {}),
        ...(endpoint?.Address ? { host: endpoint.Address } : {}),
        ...(endpoint?.Port ? { port: endpoint.Port } : {}),
        ...(params.securityGroupId ? { securityGroupId: params.securityGroupId } : {}),
        ...(params.securityGroupVpcId ? { securityGroupVpcId: params.securityGroupVpcId } : {}),
        ...(params.securityGroupName ? { securityGroupName: params.securityGroupName } : {}),
        securityGroupManagedByHypervibe: Boolean(
          params.securityGroupId || params.securityGroupCreated
        ),
        securityGroupRuntimeIngressManaged: Boolean(params.securityGroupId),
        securityGroupCreatedDuringProvision: params.securityGroupCreated,
        workloadSecurityGroupId: params.workloadNetwork.workloadSecurityGroupId,
        subnetIds: params.workloadNetwork.subnetIds,
        mutationAttempted: params.instanceMutationAttempted,
        publiclyAccessible: params.live?.PubliclyAccessible === true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private hasErrorName(error: unknown, name: string): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { name?: unknown; code?: unknown };
    return candidate.name === name || candidate.code === name;
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private sanitizeIdentifier(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
  }

  private sanitizeDatabaseName(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
    return normalized.slice(0, 63) || 'app';
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-=?';
    let password = '';
    for (let index = 0; index < 32; index += 1) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

providerRegistry.register({
  metadata: {
    name: 'rds',
    displayName: 'Amazon RDS',
    category: 'database',
    credentialsSchema: RdsCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    connectionAliases: ['ecs'],
    maturity: {
      lifecycle: {
        database: { status: 'ready-for-live' },
      },
    },
    lifecycle: {
      databaseEngines: ['postgres'],
      databaseConnectivity: { compatibleHostingProviders: ['ecs'] },
    },
  },
  inspection: {
    resources: ['database'],
    defaultResource: 'database',
    selectors: {
      database: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['accountId', 'region'],
      },
    },
    inspect: (adapter, request) => (
      adapter as RdsAdapter
    ).inspectDatabaseResources(request),
  },
  databaseRuntime: standardDatabaseRuntimeProjection,
  factory: async (credentials) => {
    const adapter = new RdsAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
});
