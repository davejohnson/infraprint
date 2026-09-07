import { createHash } from 'node:crypto';
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
  type CertificateDetail,
} from '@aws-sdk/client-acm';
import {
  CreateDefaultVpcCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type SecurityGroup,
  type Subnet,
  type Vpc,
} from '@aws-sdk/client-ec2';
import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  ListTagsForResourceCommand as ListEcrTagsCommand,
} from '@aws-sdk/client-ecr';
import {
  CreateClusterCommand,
  CreateExpressGatewayServiceCommand,
  DeleteClusterCommand,
  DeleteExpressGatewayServiceCommand,
  DescribeClustersCommand,
  DescribeExpressGatewayServiceCommand,
  DescribeServicesCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  UpdateExpressGatewayServiceCommand,
  type ECSExpressGatewayService,
  type ExpressGatewayServiceConfiguration,
  type KeyValuePair,
} from '@aws-sdk/client-ecs';
import {
  AddListenerCertificatesCommand,
  DescribeListenersCommand,
  DescribeListenerCertificatesCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  ModifyRuleCommand,
  RemoveListenerCertificatesCommand,
  type Rule,
  type RuleCondition,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  TagRoleCommand,
} from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  serviceWorkloadKind,
  type Service,
} from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import type {
  ComponentResult,
  DeploymentMutationOptions,
  DeployResult,
  IProviderAdapter,
  ProviderCapabilities,
  Receipt,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { providerRegistry, type ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from '../../../domain/services/managed-runtime.js';
import { environmentForInspection } from '../../../domain/registry/provider-inspection.js';
import {
  buildEcsExpressGitHubActionsSteps,
  ECS_EXPRESS_CI_REQUIRED_SECRETS,
} from './ecs-express-ci.workflow.js';
import { buildEcsExpressPortableRecipe } from './ecs-express-ci.recipe.js';
import {
  AWS_WORKLOAD_NETWORK_BINDING,
  type AwsWorkloadNetwork,
  hasWorkloadSecurityGroupTags,
  parseAwsWorkloadNetworkBinding,
  workloadNetworksMatch,
  workloadSecurityGroupName,
  workloadSecurityGroupTags,
} from './aws-workload-network.js';

const BOOTSTRAP_IMAGE = `public.ecr.aws/docker/library/node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`;
const BOOTSTRAP_COMMAND = [
  'node',
  '-e',
  "require('http').createServer((_,res)=>{res.writeHead(200);res.end('hypervibe bootstrap')}).listen(8080)",
];
const EXECUTION_POLICY = 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy';
const INFRASTRUCTURE_POLICY = 'arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices';
const START_COMMAND_KEY = 'HYPERVIBE_START_COMMAND';
const HEALTH_CHECK_PATH_KEY = 'HYPERVIBE_HEALTH_CHECK_PATH';
const DEPLOY_SHA_KEY = 'HYPERVIBE_DEPLOY_SHA';
const IMAGE_DIGEST_KEY = 'HYPERVIBE_IMAGE_DIGEST';
const INTERNAL_ENV_KEYS = new Set([
  START_COMMAND_KEY,
  HEALTH_CHECK_PATH_KEY,
  DEPLOY_SHA_KEY,
  IMAGE_DIGEST_KEY,
]);

const EcsExpressAuthenticationSchema = z.object({
  accessKeyId: z.string().trim().min(16, 'AWS access key ID is required'),
  secretAccessKey: z.string().min(32, 'AWS secret access key is required'),
}).strict();

export const EcsExpressCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { region: _legacyRegion, ...authentication } = input as Record<string, unknown>;
  return authentication;
}, EcsExpressAuthenticationSchema);

export type EcsExpressCredentials = z.infer<typeof EcsExpressCredentialsSchema>;

const DEFAULT_ECS_REGION = 'us-west-2';
const EcsRegionSchema = z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, 'AWS region is invalid');
type ConnectedEcsExpressCredentials = EcsExpressCredentials & { region: string };

type AwsClients = {
  acm: ACMClient;
  ec2: EC2Client;
  ecr: ECRClient;
  ecs: ECSClient;
  elb: ElasticLoadBalancingV2Client;
  iam: IAMClient;
  sts: STSClient;
};

type ProjectResources = {
  accountId: string;
  clusterArn: string;
  clusterName: string;
  executionRoleArn: string;
  executionRoleName: string;
  infrastructureRoleArn: string;
  infrastructureRoleName: string;
  repositoryArn: string;
  repositoryName: string;
  repositoryUri: string;
  workloadSecurityGroupName: string;
};

type ManagedDomainCertificate = CertificateDetail & { created: boolean };

type ExpressRouting = {
  certificateArns: string[];
  hostnames: string[];
  listenerArn: string;
  loadBalancerDnsName: string;
  rule: Rule;
  ruleArn: string;
};

export class EcsExpressAdapter implements IProviderAdapter {
  readonly name = 'ecs';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    supportsDeferredDeploy: true,
  };

  private credentials: ConnectedEcsExpressCredentials | null = null;
  private clients: AwsClients | null = null;
  private accountId: string | null = null;

  async connect(credentials: unknown): Promise<void> {
    const parsed = EcsExpressCredentialsSchema.parse(credentials);
    const legacyRegion = credentials && typeof credentials === 'object' && typeof (credentials as Record<string, unknown>).region === 'string'
      ? (credentials as Record<string, string>).region
      : DEFAULT_ECS_REGION;
    this.credentials = { ...parsed, region: EcsRegionSchema.parse(legacyRegion) };
    this.replaceClients();
  }

  configureTarget(target: { region?: string }): void {
    if (!target.region) return;
    const credentials = this.connected().credentials;
    const region = EcsRegionSchema.parse(target.region);
    if (region === credentials.region) return;
    this.credentials = { ...credentials, region };
    this.accountId = null;
    this.replaceClients();
  }

  private replaceClients(): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    for (const client of Object.values(this.clients ?? {})) client.destroy();
    const config = {
      region: this.credentials.region,
      credentials: {
        accessKeyId: this.credentials.accessKeyId,
        secretAccessKey: this.credentials.secretAccessKey,
      },
    };
    this.clients = {
      acm: new ACMClient(config),
      ec2: new EC2Client(config),
      ecr: new ECRClient(config),
      ecs: new ECSClient(config),
      elb: new ElasticLoadBalancingV2Client(config),
      iam: new IAMClient(config),
      sts: new STSClient(config),
    };
  }

  async verify(): Promise<VerifyResult> {
    try {
      const { clients, credentials } = this.connected();
      const [identity] = await Promise.all([
        clients.sts.send(new GetCallerIdentityCommand({})),
        clients.ecs.send(new ListClustersCommand({ maxResults: 1 })),
        clients.ecr.send(new DescribeRepositoriesCommand({ maxResults: 1 })),
      ]);
      if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
        return { success: false, error: 'AWS did not return a valid account identity.' };
      }
      this.accountId = identity.Account;
      return {
        success: true,
        email: `AWS account ${identity.Account} (${credentials.region})`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    for (const client of Object.values(this.clients ?? {})) client.destroy();
    this.clients = null;
    this.credentials = null;
    this.accountId = null;
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    const boundArn = parseHostingBindings(environment).projectId;
    try {
      const accountId = await this.resolveAccountId();
      const clusterName = boundArn
        ? this.parseClusterArn(boundArn).clusterName
        : this.clusterName(projectName, environment);
      const resources = this.projectResources(accountId, clusterName);

      if (boundArn && boundArn !== resources.clusterArn) {
        return this.failedReceipt(
          'Failed to ensure AWS ECS Express project',
          `Bound cluster ${boundArn} is outside AWS account ${accountId} and region ${this.connected().credentials.region}.`
        );
      }

      if (boundArn) {
        const cluster = await this.getCluster(boundArn);
        if (!cluster || cluster.status === 'INACTIVE') {
          return this.failedReceipt(
            'Failed to ensure AWS ECS Express project',
            `Bound ECS cluster ${boundArn} was not found. Hypervibe will not create a replacement from a stale binding.`
          );
        }
        if (!this.hasManagedTags(cluster.tags, environment.id)) {
          return this.failedReceipt(
            'Failed to ensure AWS ECS Express project',
            `Bound ECS cluster ${boundArn} is not owned by this Hypervibe environment.`
          );
        }
      } else {
        const exact = await this.findClusterArns(resources.clusterName);
        if (exact.length > 0) {
          return this.failedReceipt(
            'Failed to ensure AWS ECS Express project',
            `ECS cluster "${resources.clusterName}" already exists (${exact.join(', ')}). Hypervibe will not silently adopt a name match; remove it or add explicit import support.`,
            { duplicateProjectIds: exact }
          );
        }
      }

      const workloadNetwork = await this.ensureWorkloadNetwork(resources, environment);
      await this.ensureRepository(resources, environment);
      await this.ensureRole(
        resources.executionRoleName,
        resources.executionRoleArn,
        'ecs-tasks.amazonaws.com',
        EXECUTION_POLICY,
        environment
      );
      await this.ensureRole(
        resources.infrastructureRoleName,
        resources.infrastructureRoleArn,
        'ecs.amazonaws.com',
        INFRASTRUCTURE_POLICY,
        environment
      );

      let created = false;
      if (!boundArn) {
        const output = await this.connected().clients.ecs.send(new CreateClusterCommand({
          clusterName: resources.clusterName,
          tags: this.tags(environment),
        }));
        if (output.cluster?.clusterArn !== resources.clusterArn) {
          throw new Error(`AWS returned cluster ${output.cluster?.clusterArn ?? 'without an ARN'} outside the reviewed identity ${resources.clusterArn}.`);
        }
        created = true;
      }
      const cluster = await this.getCluster(resources.clusterArn);
      if (!cluster || cluster.status !== 'ACTIVE') {
        throw new Error(`ECS cluster ${resources.clusterArn} is not active after project reconciliation.`);
      }
      return {
        success: true,
        message: created
          ? `Created AWS ECS Express project: ${resources.clusterName}`
          : `Verified AWS ECS Express project: ${resources.clusterName}`,
        data: {
          projectId: resources.clusterArn,
          environmentId: resources.clusterArn,
          projectName: resources.clusterName,
          created,
          providerBindings: {
            [AWS_WORKLOAD_NETWORK_BINDING]: workloadNetwork,
          },
        },
      };
    } catch (error) {
      return this.failedReceipt(
        'Failed to ensure AWS ECS Express project',
        this.formatError(error)
      );
    }
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    return {
      component: {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: {
        success: false,
        message: 'AWS datastores use separate provider adapters and explicit plan actions.',
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (serviceWorkloadKind(service) !== 'web') {
      return this.failedDeploy(service, 'AWS ECS Express Mode currently supports public web services only.');
    }
    if (service.buildConfig.public === false) {
      return this.failedDeploy(service, 'Private ECS Express networking requires an explicit network resource and is not yet supported.');
    }
    const clusterArn = parseHostingBindings(environment).projectId;
    if (!clusterArn) {
      return this.failedDeploy(service, 'No bound AWS ECS project exists. The project action must complete first.');
    }

    let attemptedServiceId: string | undefined;
    let createdService = false;
    try {
      const resources = this.projectResources(
        this.parseClusterArn(clusterArn).accountId,
        this.parseClusterArn(clusterArn).clusterName
      );
      const workloadNetwork = await this.assertProjectResources(resources, environment);
      const binding = parseHostingBindings(environment).services?.[service.name]?.serviceId;
      const environmentValues = this.containerEnvironment(service, envVars);
      let express: ECSExpressGatewayService;

      if (binding) {
        const existing = await this.getExpressService(binding);
        if (!existing) {
          return this.failedDeploy(service, `Bound ECS Express service ${binding} was not found. Hypervibe will not create a replacement from a stale binding.`);
        }
        express = existing;
        this.assertExpressScope(express, clusterArn, binding, environment.id);
        attemptedServiceId = binding;
        const config = this.currentConfiguration(express);
        if (!config?.primaryContainer?.image) {
          throw new Error(`ECS Express service ${binding} has no observable active container configuration.`);
        }
        const usingBootstrap = config.primaryContainer.image === BOOTSTRAP_IMAGE;
        const output = await this.connected().clients.ecs.send(
          new UpdateExpressGatewayServiceCommand({
            serviceArn: binding,
            executionRoleArn: resources.executionRoleArn,
            cpu: config.cpu ?? '256',
            memory: config.memory ?? '512',
            healthCheckPath: usingBootstrap
              ? '/'
              : service.buildConfig.healthCheckPath ?? '/',
            primaryContainer: {
              ...config.primaryContainer,
              image: config.primaryContainer.image,
              containerPort: config.primaryContainer.containerPort ?? 8080,
              environment: environmentValues,
              ...(usingBootstrap || !service.buildConfig.startCommand
                ? { command: usingBootstrap ? BOOTSTRAP_COMMAND : undefined }
                : { command: ['sh', '-lc', service.buildConfig.startCommand] }),
            },
            networkConfiguration: this.expressNetworkConfiguration(workloadNetwork),
            scalingTarget: config.scalingTarget,
          })
        );
        express = await this.waitForExpress(
          binding,
          config.primaryContainer.image,
          existing.currentDeployment
        );
        if (output.service?.serviceArn !== binding) {
          throw new Error(`AWS update response did not preserve bound service ${binding}.`);
        }
      } else {
        const serviceName = this.serviceName(service);
        const duplicates = (await this.listServiceArns(clusterArn)).filter(
          (arn) => arn.split('/').at(-1) === serviceName
        );
        if (duplicates.length > 0) {
          return this.failedDeploy(
            service,
            `ECS service "${serviceName}" already exists (${duplicates.join(', ')}). Hypervibe will not silently adopt it.`
          );
        }
        const output = await this.connected().clients.ecs.send(
          new CreateExpressGatewayServiceCommand({
            cluster: clusterArn,
            serviceName,
            executionRoleArn: resources.executionRoleArn,
            infrastructureRoleArn: resources.infrastructureRoleArn,
            cpu: '256',
            memory: '512',
            healthCheckPath: '/',
            primaryContainer: {
              image: BOOTSTRAP_IMAGE,
              containerPort: 8080,
              command: BOOTSTRAP_COMMAND,
              environment: environmentValues,
            },
            networkConfiguration: this.expressNetworkConfiguration(workloadNetwork),
            scalingTarget: { minTaskCount: 1, maxTaskCount: 4 },
            tags: this.tags(environment),
          })
        );
        const serviceArn = output.service?.serviceArn;
        if (!serviceArn) throw new Error('AWS created an ECS Express service without returning its ARN.');
        attemptedServiceId = serviceArn;
        createdService = true;
        express = await this.waitForExpress(serviceArn, BOOTSTRAP_IMAGE);
        this.assertExpressScope(express, clusterArn, serviceArn, environment.id);
      }

      const serviceArn = express.serviceArn!;
      const url = this.expressUrl(express);
      return {
        serviceId: service.id,
        externalId: serviceArn,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared ECS Express service for exact-digest CI deployment: ${express.serviceName}`
            : `Configured ECS Express service; an exact-digest CI deployment is still required: ${express.serviceName}`,
          data: {
            serviceId: serviceArn,
            serviceName: express.serviceName,
            resourceType: 'web',
            createdService,
            deploymentDeferred: true,
            pendingImage: this.currentConfiguration(express)?.primaryContainer?.image === BOOTSTRAP_IMAGE,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(service, this.formatError(error), attemptedServiceId, createdService);
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    const deployed = await this.deploy(service, environment, vars, options);
    return deployed.receipt;
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    const bindings = parseHostingBindings(environment);
    const serviceArn = bindings.services?.[service.name]?.serviceId;
    if (!serviceArn) {
      return { success: true, message: 'ECS Express service has no retired environment variables to delete.' };
    }
    try {
      if (!bindings.projectId) {
        throw new Error('No bound AWS ECS project exists for environment-variable removal.');
      }
      const clusterIdentity = this.parseClusterArn(bindings.projectId);
      const resources = this.projectResources(clusterIdentity.accountId, clusterIdentity.clusterName);
      const workloadNetwork = await this.assertProjectResources(resources, environment);
      const express = await this.getExpressService(serviceArn);
      if (!express) {
        return this.failedReceipt('Failed to delete ECS Express environment variables', `Bound service ${serviceArn} was not found.`);
      }
      this.assertExpressScope(express, bindings.projectId, serviceArn, environment.id);
      const config = this.currentConfiguration(express);
      if (!config?.primaryContainer?.image) throw new Error('ECS Express returned no active container configuration.');
      const retired = new Set(keys);
      const environmentValues = (config.primaryContainer.environment ?? [])
        .filter((item) => item.name && !retired.has(item.name));
      await this.connected().clients.ecs.send(new UpdateExpressGatewayServiceCommand({
        serviceArn,
        executionRoleArn: config.executionRoleArn,
        cpu: config.cpu,
        memory: config.memory,
        healthCheckPath: config.healthCheckPath,
        primaryContainer: { ...config.primaryContainer, environment: environmentValues },
        networkConfiguration: this.expressNetworkConfiguration(workloadNetwork),
        scalingTarget: config.scalingTarget,
      }));
      await this.waitForExpress(
        serviceArn,
        config.primaryContainer.image,
        express.currentDeployment
      );
      return {
        success: true,
        message: `Deleted ${keys.length} retired environment variable${keys.length === 1 ? '' : 's'} from ECS Express`,
      };
    } catch (error) {
      return this.failedReceipt('Failed to delete ECS Express environment variables', this.formatError(error));
    }
  }

  async deleteService(serviceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = await this.getExpressService(serviceId);
      if (!existing) return { success: true };
      if (!this.hasManagedTag(existing.tags)) {
        return { success: false, error: `ECS Express service ${serviceId} is not Hypervibe-managed.` };
      }
      try {
        await this.connected().clients.ecs.send(new DeleteExpressGatewayServiceCommand({ serviceArn: serviceId }));
      } catch (error) {
        if (!this.hasErrorName(error, 'ResourceNotFoundException', 'ServiceNotFoundException', 'ClusterNotFoundException')) throw error;
      }
      for (let attempt = 1; attempt <= this.attempts('HYPERVIBE_ECS_DELETE_ATTEMPTS', 120); attempt += 1) {
        const observed = await this.getExpressService(serviceId);
        if (!observed || observed.status?.statusCode === 'INACTIVE') return { success: true };
        if (attempt < this.attempts('HYPERVIBE_ECS_DELETE_ATTEMPTS', 120)) await this.delay();
      }
      return { success: false, error: `ECS Express service ${serviceId} remained observable after deletion.` };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const identity = this.parseClusterArn(projectId);
      const resources = this.projectResources(identity.accountId, identity.clusterName);
      await this.assertProjectDeletionResourcesOwned(resources);
      const cluster = await this.getCluster(projectId);
      if (cluster) {
        const services = await this.listServiceArns(projectId);
        if (services.length > 0) {
          return { success: false, error: `ECS cluster ${projectId} still contains services: ${services.join(', ')}.` };
        }
        if (!this.hasManagedTag(cluster.tags)) {
          return { success: false, error: `ECS cluster ${projectId} is not Hypervibe-managed.` };
        }
        try {
          await this.connected().clients.ecs.send(new DeleteClusterCommand({ cluster: projectId }));
        } catch (error) {
          if (!this.hasErrorName(error, 'ClusterNotFoundException')) throw error;
        }
      }
      if (await this.getCluster(projectId)) {
        return { success: false, error: `ECS cluster ${projectId} remained observable after deletion.` };
      }
      await this.deleteWorkloadSecurityGroup(resources);
      await this.deleteRepository(resources.repositoryName);
      await this.deleteRole(resources.executionRoleName, EXECUTION_POLICY);
      await this.deleteRole(resources.infrastructureRoleName, INFRASTRUCTURE_POLICY);
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<Receipt> {
    try {
      if (!params.projectId || params.environmentId !== params.projectId) {
        throw new Error('AWS custom-domain attachment requires the exact bound ECS cluster identity.');
      }
      const service = await this.getExpressService(params.serviceId);
      if (!service) throw new Error(`Bound ECS Express service ${params.serviceId} was not found.`);
      this.assertExpressScope(service, params.projectId, params.serviceId);
      const routing = await this.expressRouting(params.projectId, params.serviceId);
      const certificate = await this.ensureDomainCertificate(params.domain, params.serviceId);
      const certificateArn = certificate.CertificateArn;
      if (!certificateArn) throw new Error(`ACM returned no certificate ARN for ${params.domain}.`);
      const validation = this.certificateValidationRecord(certificate, params.domain);
      const issued = certificate.Status === 'ISSUED';
      let routed = routing.hostnames.includes(params.domain);
      let certificateAttached = routing.certificateArns.includes(certificateArn);

      if (issued && !certificateAttached) {
        await this.connected().clients.elb.send(new AddListenerCertificatesCommand({
          ListenerArn: routing.listenerArn,
          Certificates: [{ CertificateArn: certificateArn }],
        }));
        certificateAttached = true;
      }
      if (issued && !routed) {
        const values = [...new Set([...routing.hostnames, params.domain])].sort();
        if (values.length > 5) {
          throw new Error(`The ECS Express listener rule already has ${routing.hostnames.length} hostnames; AWS allows at most five values per host-header condition.`);
        }
        await this.connected().clients.elb.send(new ModifyRuleCommand({
          RuleArn: routing.ruleArn,
          Conditions: this.ruleConditionsWithHostnames(routing.rule, values),
        }));
        routed = true;
      }

      return {
        success: true,
        message: issued && routed && certificateAttached
          ? 'AWS ECS Express custom domain attached with ACM TLS'
          : 'AWS ECS Express custom domain is waiting for ACM DNS validation',
        data: {
          domain: params.domain,
          customDomainId: certificateArn,
          created: certificate.created,
          providerVerified: issued && routed && certificateAttached,
          certificateStatus: certificate.Status ?? 'UNKNOWN',
          dnsRecords: [
            ...(validation ? [{
              name: validation.Name,
              type: validation.Type,
              value: validation.Value,
              purpose: 'certificate-validation',
              proxied: false,
            }] : []),
            {
              name: params.domain,
              type: 'CNAME',
              value: routing.loadBalancerDnsName,
              purpose: 'routing',
              proxied: false,
            },
          ],
        },
      };
    } catch (error) {
      return this.failedReceipt('Failed to attach AWS ECS Express custom domain', this.formatError(error));
    }
  }

  async detachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    customDomainId?: string;
  }): Promise<Receipt> {
    try {
      if (!params.projectId || params.environmentId !== params.projectId) {
        throw new Error('AWS custom-domain detachment requires the exact bound ECS cluster identity.');
      }
      const service = await this.getExpressService(params.serviceId);
      if (!service) {
        throw new Error(`Bound ECS Express service ${params.serviceId} was not found, so domain absence cannot be verified.`);
      }
      this.assertExpressScope(service, params.projectId, params.serviceId);
      const routing = await this.expressRouting(params.projectId, params.serviceId);
      const certificate = await this.findManagedDomainCertificate(params.domain, params.serviceId);
      const certificateArn = certificate?.CertificateArn;
      if (params.customDomainId && certificateArn && params.customDomainId !== certificateArn) {
        return this.failedReceipt(
          'AWS ECS Express custom-domain identity changed',
          `Reviewed certificate ${params.customDomainId} does not match observed certificate ${certificateArn}.`
        );
      }
      if (params.customDomainId && !certificateArn) {
        const reviewed = await this.getCertificate(params.customDomainId);
        if (reviewed) {
          return this.failedReceipt(
            'AWS ECS Express custom-domain identity changed',
            `Reviewed certificate ${params.customDomainId} still exists but is no longer the Hypervibe-managed certificate for ${params.domain}.`
          );
        }
      }

      if (routing.hostnames.includes(params.domain)) {
        const remaining = routing.hostnames.filter((domain) => domain !== params.domain);
        if (remaining.length === 0) {
          throw new Error(`Refusing to remove ${params.domain} because it is the final host-header value on the ECS Express listener rule.`);
        }
        await this.connected().clients.elb.send(new ModifyRuleCommand({
          RuleArn: routing.ruleArn,
          Conditions: this.ruleConditionsWithHostnames(routing.rule, remaining),
        }));
        const refreshed = await this.expressRouting(params.projectId, params.serviceId);
        if (refreshed.hostnames.includes(params.domain)) {
          throw new Error(`${params.domain} remains on ECS Express listener rule ${routing.ruleArn}.`);
        }
      }
      if (certificateArn && routing.certificateArns.includes(certificateArn)) {
        await this.connected().clients.elb.send(new RemoveListenerCertificatesCommand({
          ListenerArn: routing.listenerArn,
          Certificates: [{ CertificateArn: certificateArn }],
        }));
      }
      if (certificateArn) {
        try {
          await this.connected().clients.acm.send(new DeleteCertificateCommand({ CertificateArn: certificateArn }));
        } catch (error) {
          if (!this.hasErrorName(error, 'ResourceNotFoundException')) throw error;
        }
        if (await this.getCertificate(certificateArn)) {
          throw new Error(`ACM certificate ${certificateArn} remained observable after deletion.`);
        }
      }
      return {
        success: true,
        message: certificateArn || routing.hostnames.includes(params.domain)
          ? 'AWS ECS Express custom domain detached'
          : 'AWS ECS Express custom domain is already absent',
        data: {
          domain: params.domain,
          customDomainId: certificateArn ?? params.customDomainId,
          ...(certificateArn ? { deleted: true } : { alreadyAbsent: true }),
        },
      };
    } catch (error) {
      return this.failedReceipt('Failed to detach AWS ECS Express custom domain', this.formatError(error));
    }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId) return this.emptyObservation(false);
    const cluster = await this.getCluster(bindings.projectId);
    if (!cluster || cluster.status === 'INACTIVE') {
      return {
        ...this.emptyObservation(false),
        projectId: bindings.projectId,
        environmentId: bindings.environmentId,
      };
    }
    const identity = this.parseClusterArn(bindings.projectId);
    const resources = this.projectResources(identity.accountId, identity.clusterName);
    const projectReady = this.hasManagedTags(cluster.tags, environment.id)
      && await this.projectResourcesExist(resources, environment);
    const services: ObservedService[] = [];
    for (const [name, binding] of Object.entries(bindings.services ?? {})) {
      if (!binding.serviceId) continue;
      const express = await this.getExpressService(binding.serviceId);
      if (!express) continue;
      this.assertExpressScope(express, bindings.projectId, binding.serviceId, environment.id);
      const config = this.currentConfiguration(express);
      const environmentValues = config?.primaryContainer?.environment ?? [];
      const values = Object.fromEntries(
        environmentValues
          .filter((item): item is { name: string; value: string } => Boolean(item.name) && typeof item.value === 'string')
          .map((item) => [item.name, item.value])
      );
      const visible = Object.entries(values).filter(([key]) => !INTERNAL_ENV_KEYS.has(key));
      const customDomains = binding.customDomains ?? [];
      services.push({
        name,
        externalId: binding.serviceId,
        workloadKind: 'web',
        ...(this.expressUrl(express) ? { url: this.expressUrl(express) } : {}),
        customDomains,
        customDomainStatus: await this.observeDomains({
          clusterArn: bindings.projectId,
          serviceArn: binding.serviceId,
          domains: customDomains,
        }),
        config: {
          ...(values[START_COMMAND_KEY] ? { startCommand: values[START_COMMAND_KEY] } : {}),
          ...(values[HEALTH_CHECK_PATH_KEY] ? { healthCheckPath: values[HEALTH_CHECK_PATH_KEY] } : {}),
          public: true,
        },
        sourceState: 'disconnected',
        envVarKeys: visible.map(([key]) => key).sort(),
        envVarHashes: Object.fromEntries(visible.map(([key, value]) => [key, hashEnvValue(value)])),
        status: express.status?.statusCode === 'ACTIVE'
          ? (config?.primaryContainer?.image === BOOTSTRAP_IMAGE ? 'empty' : 'running')
          : express.status?.statusCode === 'INACTIVE' ? 'failed' : 'unknown',
      });
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: projectReady,
      projectId: bindings.projectId,
      environmentId: bindings.environmentId ?? bindings.projectId,
      services,
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
      },
      partial: false,
      warnings: projectReady ? [] : ['The bound ECS cluster exists, but its ECR repository, IAM roles, or default VPC is missing.'],
    };
  }

  async inspectEnvironmentResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const environment = environmentForInspection(request);
    const bindings = parseHostingBindings(environment);
    const accountId = await this.resolveAccountId();
    const clusterArn = bindings.projectId
      ?? this.projectResources(
        accountId,
        this.clusterName(request.project!.name, environment)
      ).clusterArn;
    const cluster = await this.getCluster(clusterArn);
    if (!cluster) {
      return {
        observation: 'absent',
        resource: 'environment',
        project: { id: clusterArn },
        environment: { name: environment.name, region: this.connected().credentials.region },
        services: [],
      };
    }
    const serviceArns = await this.listServiceArns(clusterArn);
    const services = (await Promise.all(serviceArns.slice(0, request.limit).map(async (serviceArn) => {
      const service = await this.getExpressService(serviceArn);
      return {
        id: serviceArn,
        name: serviceArn.split('/').pop() ?? serviceArn,
        workloadKind: 'web',
        resourceType: 'express-service',
        managedByHypervibe: Boolean(service && this.hasManagedTag(service.tags)),
        status: service?.status?.statusCode ?? null,
      };
    })));
    return {
      observation: 'present',
      resource: 'environment',
      project: { id: clusterArn },
      environment: { name: environment.name, region: this.connected().credentials.region },
      services,
      managedByHypervibe: this.hasManagedTag(cluster.tags),
      partial: serviceArns.length > request.limit,
    };
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    const identity = await this.connected().clients.sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
      throw new Error('AWS did not return a valid account identity.');
    }
    this.accountId = identity.Account;
    return identity.Account;
  }

  private connected(): { clients: AwsClients; credentials: ConnectedEcsExpressCredentials } {
    if (!this.clients || !this.credentials) throw new Error('Not connected. Call connect() first.');
    return { clients: this.clients, credentials: this.credentials };
  }

  private clusterName(projectName: string, environment: Environment): string {
    return this.safeName(`hv-${projectName}-${environment.name}`, 44, `${environment.projectId}:${environment.name}`);
  }

  private serviceName(service: Service): string {
    return this.safeName(`hv-${service.name}`, 52, service.id);
  }

  private safeName(value: string, prefixLength: number, salt: string): string {
    const prefix = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, prefixLength) || 'hypervibe';
    return `${prefix}-${this.hash(salt).slice(0, 10)}`;
  }

  private projectResources(accountId: string, clusterName: string): ProjectResources {
    const { region } = this.connected().credentials;
    const roleBase = clusterName.slice(0, 42);
    const repositoryName = `hypervibe/${clusterName.toLowerCase()}`;
    const executionRoleName = `${roleBase}-task-execution`;
    const infrastructureRoleName = `${roleBase}-infrastructure`;
    return {
      accountId,
      clusterName,
      clusterArn: `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}`,
      repositoryName,
      repositoryArn: `arn:aws:ecr:${region}:${accountId}:repository/${repositoryName}`,
      repositoryUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}`,
      executionRoleName,
      executionRoleArn: `arn:aws:iam::${accountId}:role/${executionRoleName}`,
      infrastructureRoleName,
      infrastructureRoleArn: `arn:aws:iam::${accountId}:role/${infrastructureRoleName}`,
      workloadSecurityGroupName: workloadSecurityGroupName(clusterName),
    };
  }

  private parseClusterArn(value: string): { accountId: string; clusterName: string } {
    const match = value.match(/^arn:aws(?:-[a-z]+)?:ecs:([^:]+):(\d{12}):cluster\/([A-Za-z0-9_-]+)$/);
    if (!match || match[1] !== this.connected().credentials.region) {
      throw new Error(`Invalid or cross-region ECS cluster ARN: ${value}`);
    }
    return { accountId: match[2]!, clusterName: match[3]! };
  }

  private tags(environment: Environment): Array<{ key: string; value: string }> {
    return [
      { key: 'managed-by', value: 'hypervibe' },
      { key: 'hypervibe-environment-id', value: environment.id },
    ];
  }

  private iamTags(environment: Environment): Array<{ Key: string; Value: string }> {
    return this.tags(environment).map(({ key, value }) => ({ Key: key, Value: value }));
  }

  private hasManagedTags(
    tags: Array<{ key?: string; value?: string; Key?: string; Value?: string }> | undefined,
    environmentId: string
  ): boolean {
    const values = new Map((tags ?? []).map((tag) => [tag.key ?? tag.Key, tag.value ?? tag.Value]));
    return values.get('managed-by') === 'hypervibe'
      && values.get('hypervibe-environment-id') === environmentId;
  }

  private hasManagedTag(
    tags: Array<{ key?: string; value?: string; Key?: string; Value?: string }> | undefined
  ): boolean {
    return (tags ?? []).some((tag) => (tag.key ?? tag.Key) === 'managed-by'
      && (tag.value ?? tag.Value) === 'hypervibe');
  }

  private async describeDefaultVpc(): Promise<Vpc | null> {
    const current = await this.connected().clients.ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }));
    if (!Array.isArray(current.Vpcs)) {
      throw new Error('AWS default-VPC observation returned an invalid VPC list.');
    }
    if (current.Vpcs.length > 1) throw new Error('AWS returned multiple default VPCs for one region.');
    const vpc = current.Vpcs[0];
    if (!vpc) return null;
    if (!vpc.VpcId || vpc.IsDefault !== true) {
      throw new Error('AWS default-VPC observation returned an incomplete or non-default VPC identity.');
    }
    return vpc;
  }

  private async ensureDefaultVpc(): Promise<Vpc> {
    const current = await this.describeDefaultVpc();
    if (current) return current;
    const created = await this.connected().clients.ec2.send(new CreateDefaultVpcCommand({}));
    if (!created.Vpc?.VpcId || !created.Vpc.IsDefault) {
      throw new Error('AWS did not confirm creation of the default VPC required by ECS Express Mode.');
    }
    const observed = await this.describeDefaultVpc();
    if (!observed || observed.VpcId !== created.Vpc.VpcId) {
      throw new Error(`AWS default VPC ${created.Vpc.VpcId} could not be verified after creation.`);
    }
    return observed;
  }

  private async defaultVpcSubnets(vpcId: string): Promise<string[]> {
    const output = await this.connected().clients.ec2.send(new DescribeSubnetsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'default-for-az', Values: ['true'] },
      ],
    }));
    if (!Array.isArray(output.Subnets)) {
      throw new Error(`AWS default-subnet observation returned an invalid subnet list for VPC ${vpcId}.`);
    }
    const availabilityZones = new Set<string>();
    const subnetIds = output.Subnets.map((subnet: Subnet) => {
      if (!subnet.SubnetId || subnet.VpcId !== vpcId || subnet.DefaultForAz !== true || !subnet.AvailabilityZone) {
        throw new Error(`AWS default-subnet observation returned an incomplete or cross-VPC subnet for ${vpcId}.`);
      }
      availabilityZones.add(subnet.AvailabilityZone);
      return subnet.SubnetId;
    });
    if (new Set(subnetIds).size !== subnetIds.length) {
      throw new Error(`AWS returned duplicate default subnet identities for VPC ${vpcId}.`);
    }
    if (subnetIds.length < 2 || availabilityZones.size < 2) {
      throw new Error(`AWS default VPC ${vpcId} needs default subnets in at least two availability zones for ECS Express and ElastiCache.`);
    }
    return subnetIds.sort();
  }

  private async findWorkloadSecurityGroups(
    resources: ProjectResources,
    vpcId: string
  ): Promise<SecurityGroup[]> {
    const output = await this.connected().clients.ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [resources.workloadSecurityGroupName] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }));
    if (!Array.isArray(output.SecurityGroups)) {
      throw new Error(`AWS workload security-group observation returned an invalid collection for ${resources.clusterArn}.`);
    }
    const groupIds = output.SecurityGroups.map((group) => {
      if (!group.GroupId) throw new Error(`AWS returned a workload security group without an ID for ${resources.clusterArn}.`);
      return group.GroupId;
    });
    if (new Set(groupIds).size !== groupIds.length || output.SecurityGroups.length > 1) {
      throw new Error(`AWS returned duplicate workload security groups for ${resources.clusterArn}.`);
    }
    return output.SecurityGroups;
  }

  private async getSecurityGroup(groupId: string): Promise<SecurityGroup | null> {
    try {
      const output = await this.connected().clients.ec2.send(new DescribeSecurityGroupsCommand({
        GroupIds: [groupId],
      }));
      if (!Array.isArray(output.SecurityGroups)) {
        throw new Error(`AWS security-group observation returned an invalid collection for ${groupId}.`);
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

  private assertWorkloadSecurityGroup(
    group: SecurityGroup,
    resources: ProjectResources,
    vpcId: string,
    environmentId?: string
  ): void {
    if (group.GroupName !== resources.workloadSecurityGroupName || group.VpcId !== vpcId) {
      throw new Error(`AWS workload security group ${group.GroupId ?? 'without an ID'} resolved outside VPC ${vpcId} or the reviewed project identity.`);
    }
    if (!hasWorkloadSecurityGroupTags(group.Tags, resources.clusterArn, environmentId)) {
      throw new Error(`AWS workload security group ${group.GroupId ?? 'without an ID'} is not owned by the reviewed Hypervibe project.`);
    }
  }

  private workloadNetwork(
    resources: ProjectResources,
    vpcId: string,
    subnetIds: string[],
    workloadSecurityGroupId: string
  ): AwsWorkloadNetwork {
    return {
      accountId: resources.accountId,
      region: this.connected().credentials.region,
      vpcId,
      subnetIds: [...subnetIds].sort(),
      workloadSecurityGroupId,
    };
  }

  private async ensureWorkloadNetwork(
    resources: ProjectResources,
    environment: Environment
  ): Promise<AwsWorkloadNetwork> {
    const persisted = parseAwsWorkloadNetworkBinding(environment);
    const vpc = await this.ensureDefaultVpc();
    const vpcId = vpc.VpcId!;
    const subnetIds = await this.defaultVpcSubnets(vpcId);

    if (persisted) {
      if (persisted.accountId !== resources.accountId
        || persisted.region !== this.connected().credentials.region
        || persisted.vpcId !== vpcId) {
        throw new Error('The persisted AWS workload-network binding is outside the connected account, region, or default VPC.');
      }
      const group = await this.getSecurityGroup(persisted.workloadSecurityGroupId);
      if (!group) {
        throw new Error(`Bound AWS workload security group ${persisted.workloadSecurityGroupId} was not found. Hypervibe will not create a replacement from a stale binding.`);
      }
      this.assertWorkloadSecurityGroup(group, resources, vpcId, environment.id);
      return this.workloadNetwork(resources, vpcId, subnetIds, persisted.workloadSecurityGroupId);
    }

    let matches = await this.findWorkloadSecurityGroups(resources, vpcId);
    if (matches.length === 0) {
      let returnedGroupId: string | undefined;
      try {
        const created = await this.connected().clients.ec2.send(new CreateSecurityGroupCommand({
          GroupName: resources.workloadSecurityGroupName,
          Description: `Hypervibe ECS workloads for ${resources.clusterArn}`,
          VpcId: vpcId,
          TagSpecifications: [{
            ResourceType: 'security-group',
            Tags: workloadSecurityGroupTags(environment.id, resources.clusterArn),
          }],
        }));
        returnedGroupId = created.GroupId;
      } catch (error) {
        matches = await this.findWorkloadSecurityGroups(resources, vpcId);
        if (matches.length === 0) throw error;
      }
      matches = await this.findWorkloadSecurityGroups(resources, vpcId);
      if (matches.length !== 1 || (returnedGroupId && matches[0]?.GroupId !== returnedGroupId)) {
        throw new Error(`AWS workload security group creation for ${resources.clusterArn} could not be verified exactly.`);
      }
    }
    const group = matches[0]!;
    this.assertWorkloadSecurityGroup(group, resources, vpcId, environment.id);
    return this.workloadNetwork(resources, vpcId, subnetIds, group.GroupId!);
  }

  private async resolveWorkloadNetwork(
    resources: ProjectResources,
    environment: Environment
  ): Promise<AwsWorkloadNetwork | null> {
    const persisted = parseAwsWorkloadNetworkBinding(environment);
    if (!persisted) return null;
    if (persisted.accountId !== resources.accountId
      || persisted.region !== this.connected().credentials.region) {
      throw new Error('The persisted AWS workload-network binding is outside the connected account or region.');
    }
    const vpc = await this.describeDefaultVpc();
    if (!vpc) return null;
    if (vpc.VpcId !== persisted.vpcId) {
      throw new Error(`The persisted AWS workload-network VPC ${persisted.vpcId} is not the connected region's exact default VPC.`);
    }
    const subnetIds = await this.defaultVpcSubnets(persisted.vpcId);
    const group = await this.getSecurityGroup(persisted.workloadSecurityGroupId);
    if (!group) return null;
    this.assertWorkloadSecurityGroup(group, resources, persisted.vpcId, environment.id);
    const observed = this.workloadNetwork(
      resources,
      persisted.vpcId,
      subnetIds,
      persisted.workloadSecurityGroupId
    );
    if (!workloadNetworksMatch(persisted, observed)) {
      throw new Error('The AWS workload-network binding changed since it was reviewed; re-run hv_plan before mutating services or caches.');
    }
    return observed;
  }

  private expressNetworkConfiguration(network: AwsWorkloadNetwork): {
    securityGroups: string[];
    subnets: string[];
  } {
    return {
      securityGroups: [network.workloadSecurityGroupId],
      subnets: [...network.subnetIds],
    };
  }

  private async ensureRepository(resources: ProjectResources, environment: Environment): Promise<void> {
    const existing = await this.getRepository(resources.repositoryName);
    if (existing) {
      if (existing.repositoryArn !== resources.repositoryArn || existing.repositoryUri !== resources.repositoryUri) {
        throw new Error(`ECR repository ${resources.repositoryName} resolved outside its reviewed identity.`);
      }
      const tags = await this.connected().clients.ecr.send(new ListEcrTagsCommand({ resourceArn: resources.repositoryArn }));
      if (!this.hasManagedTags(tags.tags, environment.id)) {
        throw new Error(`ECR repository ${resources.repositoryName} already exists but is not Hypervibe-managed.`);
      }
      return;
    }
    const created = await this.connected().clients.ecr.send(new CreateRepositoryCommand({
      repositoryName: resources.repositoryName,
      imageScanningConfiguration: { scanOnPush: true },
      imageTagMutability: 'MUTABLE',
      tags: this.iamTags(environment),
    }));
    if (created.repository?.repositoryArn !== resources.repositoryArn) {
      throw new Error(`AWS returned ECR repository ${created.repository?.repositoryArn ?? 'without an ARN'} outside ${resources.repositoryArn}.`);
    }
  }

  private async getRepository(name: string) {
    try {
      const output = await this.connected().clients.ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
      if ((output.repositories ?? []).length > 1) throw new Error(`AWS returned duplicate ECR repositories named ${name}.`);
      const repository = output.repositories?.[0];
      if (!repository) {
        throw new Error(
          `AWS returned no ECR repository and no RepositoryNotFoundException for ${name}.`
        );
      }
      if (repository.repositoryName !== name) {
        throw new Error(
          `AWS returned ECR repository ${repository.repositoryName ?? 'without a name'} when ${name} was requested.`
        );
      }
      return repository;
    } catch (error) {
      if (this.hasErrorName(error, 'RepositoryNotFoundException')) return null;
      throw error;
    }
  }

  private async ensureRole(
    roleName: string,
    roleArn: string,
    principal: string,
    policyArn: string,
    environment: Environment
  ): Promise<void> {
    let role = await this.getRole(roleName);
    if (role) {
      if (role.Arn !== roleArn) throw new Error(`IAM role ${roleName} resolved outside ${roleArn}.`);
      if (!this.hasManagedTags(role.Tags, environment.id)) {
        throw new Error(`IAM role ${roleName} already exists but is not Hypervibe-managed.`);
      }
    } else {
      const trust = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: principal }, Action: 'sts:AssumeRole' }],
      });
      const output = await this.connected().clients.iam.send(new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trust,
        Tags: this.iamTags(environment),
      }));
      role = output.Role ?? null;
      if (role?.Arn !== roleArn) throw new Error(`AWS returned IAM role ${role?.Arn ?? 'without an ARN'} outside ${roleArn}.`);
    }
    const policies = await this.connected().clients.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
    if (!Array.isArray(policies.AttachedPolicies)) {
      throw new Error(`AWS IAM returned an invalid attached-policy list for role ${roleName}.`);
    }
    if (!policies.AttachedPolicies.some((policy) => policy.PolicyArn === policyArn)) {
      await this.connected().clients.iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
    }
    await this.connected().clients.iam.send(new TagRoleCommand({ RoleName: roleName, Tags: this.iamTags(environment) }));
  }

  private async getRole(name: string) {
    try {
      const role = (await this.connected().clients.iam.send(
        new GetRoleCommand({ RoleName: name })
      )).Role;
      if (!role) {
        throw new Error(
          `AWS returned no IAM role and no NoSuchEntity error for ${name}.`
        );
      }
      if (role.RoleName !== name) {
        throw new Error(
          `AWS returned IAM role ${role.RoleName ?? 'without a name'} when ${name} was requested.`
        );
      }
      return role;
    } catch (error) {
      if (this.hasErrorName(error, 'NoSuchEntity', 'NoSuchEntityException')) return null;
      throw error;
    }
  }

  private async roleReady(name: string, arn: string, policyArn: string, environmentId: string): Promise<boolean> {
    const role = await this.getRole(name);
    if (!role) return false;
    if (role.Arn !== arn) throw new Error(`IAM role ${name} resolved outside ${arn}.`);
    if (!this.hasManagedTags(role.Tags, environmentId)) return false;
    const policies = await this.connected().clients.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name }));
    if (!Array.isArray(policies.AttachedPolicies)) {
      throw new Error(`AWS IAM returned an invalid attached-policy list for role ${name}.`);
    }
    return policies.AttachedPolicies.some((policy) => policy.PolicyArn === policyArn);
  }

  private async repositoryReady(resources: ProjectResources, environmentId: string): Promise<boolean> {
    const repository = await this.getRepository(resources.repositoryName);
    if (!repository) return false;
    if (repository.repositoryArn !== resources.repositoryArn || repository.repositoryUri !== resources.repositoryUri) {
      throw new Error(`ECR repository ${resources.repositoryName} resolved outside its reviewed identity.`);
    }
    const tags = await this.connected().clients.ecr.send(new ListEcrTagsCommand({ resourceArn: resources.repositoryArn }));
    return this.hasManagedTags(tags.tags, environmentId);
  }

  private async assertProjectResources(
    resources: ProjectResources,
    environment: Environment
  ): Promise<AwsWorkloadNetwork> {
    const workloadNetwork = await this.resolveWorkloadNetwork(resources, environment);
    const [repository, execution, infrastructure] = await Promise.all([
      this.repositoryReady(resources, environment.id),
      this.roleReady(resources.executionRoleName, resources.executionRoleArn, EXECUTION_POLICY, environment.id),
      this.roleReady(resources.infrastructureRoleName, resources.infrastructureRoleArn, INFRASTRUCTURE_POLICY, environment.id),
    ]);
    if (!repository || !execution || !infrastructure || !workloadNetwork) {
      throw new Error('The bound AWS project is missing its ECR repository, IAM roles, default VPC/subnets, or workload security group. Re-run hv_plan before deploying.');
    }
    return workloadNetwork;
  }

  private async projectResourcesExist(resources: ProjectResources, environment: Environment): Promise<boolean> {
    const [repository, execution, infrastructure, workloadNetwork] = await Promise.all([
      this.repositoryReady(resources, environment.id),
      this.roleReady(resources.executionRoleName, resources.executionRoleArn, EXECUTION_POLICY, environment.id),
      this.roleReady(resources.infrastructureRoleName, resources.infrastructureRoleArn, INFRASTRUCTURE_POLICY, environment.id),
      this.resolveWorkloadNetwork(resources, environment),
    ]);
    return repository && execution && infrastructure && Boolean(workloadNetwork);
  }

  private async getCluster(clusterArn: string) {
    const output = await this.connected().clients.ecs.send(new DescribeClustersCommand({ clusters: [clusterArn], include: ['TAGS'] }));
    const failures = (output.failures ?? []).filter(
      (failure) => failure.arn === clusterArn
    );
    if (failures.length > 1) {
      throw new Error(`AWS returned duplicate failures for ECS cluster ${clusterArn}.`);
    }
    if (failures.length === 1) {
      const failure = failures[0]!;
      if (failure.reason === 'MISSING') return null;
      throw new Error(
        `AWS ECS cluster observation failed for ${clusterArn}: ${failure.reason ?? 'unknown failure'}${failure.detail ? ` (${failure.detail})` : ''}.`
      );
    }
    const clusters = output.clusters ?? [];
    if (clusters.length > 1) {
      throw new Error(`AWS returned duplicate ECS cluster identity ${clusterArn}.`);
    }
    const cluster = clusters[0];
    if (!cluster) {
      throw new Error(
        `AWS returned neither ECS cluster ${clusterArn} nor a provider-confirmed MISSING failure.`
      );
    }
    if (cluster.clusterArn !== clusterArn) {
      throw new Error(
        `AWS returned ECS cluster ${cluster.clusterArn ?? 'without an ARN'} when ${clusterArn} was requested.`
      );
    }
    return cluster;
  }

  private async findClusterArns(name: string): Promise<string[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.connected().clients.ecs.send(new ListClustersCommand({ nextToken, maxResults: 100 }));
      if (!Array.isArray(output.clusterArns)) {
        throw new Error('AWS ECS cluster observation returned an invalid cluster list.');
      }
      arns.push(...output.clusterArns.filter((arn) => arn.split('/').at(-1) === name));
      nextToken = output.nextToken;
    } while (nextToken);
    return arns.sort();
  }

  private async listServiceArns(clusterArn: string): Promise<string[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.connected().clients.ecs.send(new ListServicesCommand({ cluster: clusterArn, nextToken, maxResults: 100 }));
      if (!Array.isArray(output.serviceArns)) {
        throw new Error(`AWS ECS service observation returned an invalid service list for ${clusterArn}.`);
      }
      arns.push(...output.serviceArns);
      nextToken = output.nextToken;
    } while (nextToken);
    return arns.sort();
  }

  private async getExpressService(serviceArn: string): Promise<ECSExpressGatewayService | null> {
    try {
      const service = (await this.connected().clients.ecs.send(
        new DescribeExpressGatewayServiceCommand({ serviceArn, include: ['TAGS'] })
      )).service;
      if (!service) {
        throw new Error(
          `AWS returned no ECS Express service and no not-found error for ${serviceArn}.`
        );
      }
      if (service.serviceArn !== serviceArn) {
        throw new Error(
          `AWS returned ECS Express service ${service.serviceArn ?? 'without an ARN'} when ${serviceArn} was requested.`
        );
      }
      return service;
    } catch (error) {
      if (this.hasErrorName(error, 'ResourceNotFoundException', 'ServiceNotFoundException', 'ClusterNotFoundException')) return null;
      throw error;
    }
  }

  private assertExpressScope(
    service: ECSExpressGatewayService,
    clusterArn: string,
    serviceArn: string,
    environmentId?: string
  ): void {
    if (service.serviceArn !== serviceArn || service.cluster !== clusterArn) {
      throw new Error(`ECS Express service ${serviceArn} resolved outside bound cluster ${clusterArn}.`);
    }
    if (!this.hasManagedTag(service.tags)
      || (environmentId && !this.hasManagedTags(service.tags, environmentId))) {
      throw new Error(`ECS Express service ${serviceArn} is not owned by this Hypervibe environment.`);
    }
  }

  private currentConfiguration(service: ECSExpressGatewayService): ExpressGatewayServiceConfiguration | undefined {
    return (service.activeConfigurations ?? []).find(
      (config) => config.serviceRevisionArn === service.currentDeployment
    ) ?? [...(service.activeConfigurations ?? [])].sort(
      (left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0)
    )[0];
  }

  private expressUrl(service: ECSExpressGatewayService): string | undefined {
    const endpoint = this.currentConfiguration(service)?.ingressPaths?.find(
      (path) => path.accessType === 'PUBLIC'
    )?.endpoint ?? this.currentConfiguration(service)?.ingressPaths?.[0]?.endpoint;
    if (!endpoint) return undefined;
    return endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
  }

  private async waitForExpress(
    serviceArn: string,
    image?: string,
    previousDeployment?: string
  ): Promise<ECSExpressGatewayService> {
    const attempts = this.attempts('HYPERVIBE_ECS_EXPRESS_WAIT_ATTEMPTS', 120);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const service = await this.getExpressService(serviceArn);
      if (!service) throw new Error(`ECS Express service ${serviceArn} disappeared during reconciliation.`);
      const config = this.currentConfiguration(service);
      if (service.status?.statusCode === 'ACTIVE'
        && (!image || config?.primaryContainer?.image === image)
        && (!previousDeployment || (
          Boolean(service.currentDeployment)
          && service.currentDeployment !== previousDeployment
        ))
        && this.expressUrl(service)) {
        return service;
      }
      if (service.status?.statusCode === 'INACTIVE') {
        throw new Error(`ECS Express service ${serviceArn} became inactive: ${service.status.statusReason ?? 'unknown reason'}.`);
      }
      if (attempt < attempts) await this.delay();
    }
    throw new Error(`ECS Express service ${serviceArn} did not become active.`);
  }

  private containerEnvironment(service: Service, vars: Record<string, string>): KeyValuePair[] {
    return Object.entries({
      ...vars,
      ...(service.buildConfig.startCommand ? { [START_COMMAND_KEY]: service.buildConfig.startCommand } : {}),
      [HEALTH_CHECK_PATH_KEY]: service.buildConfig.healthCheckPath ?? '/',
    }).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({ name, value }));
  }

  private async deleteRepository(name: string): Promise<void> {
    const repository = await this.getRepository(name);
    if (!repository) return;
    if (!repository.repositoryArn) throw new Error(`ECR repository ${name} returned no ARN.`);
    const tags = await this.connected().clients.ecr.send(new ListEcrTagsCommand({ resourceArn: repository.repositoryArn }));
    if (!this.hasManagedTag(tags.tags)) throw new Error(`ECR repository ${name} is not Hypervibe-managed.`);
    try {
      await this.connected().clients.ecr.send(new DeleteRepositoryCommand({ repositoryName: name, force: true }));
    } catch (error) {
      if (!this.hasErrorName(error, 'RepositoryNotFoundException')) throw error;
    }
    if (await this.getRepository(name)) throw new Error(`ECR repository ${name} remained observable after deletion.`);
  }

  private async assertProjectDeletionResourcesOwned(resources: ProjectResources): Promise<void> {
    const defaultVpc = await this.describeDefaultVpc();
    if (defaultVpc) {
      const groups = await this.findWorkloadSecurityGroups(resources, defaultVpc.VpcId!);
      if (groups[0]) this.assertWorkloadSecurityGroup(groups[0], resources, defaultVpc.VpcId!);
    }
    const repository = await this.getRepository(resources.repositoryName);
    if (repository) {
      if (repository.repositoryArn !== resources.repositoryArn) {
        throw new Error(`ECR repository ${resources.repositoryName} resolved outside its reviewed identity.`);
      }
      const tags = await this.connected().clients.ecr.send(new ListEcrTagsCommand({ resourceArn: resources.repositoryArn }));
      if (!this.hasManagedTag(tags.tags)) {
        throw new Error(`ECR repository ${resources.repositoryName} is not Hypervibe-managed.`);
      }
    }
    for (const [roleName, roleArn] of [
      [resources.executionRoleName, resources.executionRoleArn],
      [resources.infrastructureRoleName, resources.infrastructureRoleArn],
    ] as const) {
      const role = await this.getRole(roleName);
      if (role && (role.Arn !== roleArn || !this.hasManagedTag(role.Tags))) {
        throw new Error(`IAM role ${roleName} is outside its reviewed Hypervibe identity.`);
      }
    }
  }

  private async deleteWorkloadSecurityGroup(resources: ProjectResources): Promise<void> {
    const defaultVpc = await this.describeDefaultVpc();
    if (!defaultVpc) return;
    const matches = await this.findWorkloadSecurityGroups(resources, defaultVpc.VpcId!);
    const group = matches[0];
    if (!group) return;
    this.assertWorkloadSecurityGroup(group, resources, defaultVpc.VpcId!);
    const groupId = group.GroupId!;
    const attempts = this.attempts('HYPERVIBE_EC2_DELETE_ATTEMPTS', 60);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observed = await this.getSecurityGroup(groupId);
      if (!observed) return;
      this.assertWorkloadSecurityGroup(observed, resources, defaultVpc.VpcId!);
      try {
        await this.connected().clients.ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      } catch (error) {
        if (this.hasErrorName(error, 'InvalidGroup.NotFound')) return;
        if (!this.hasErrorName(error, 'DependencyViolation')) throw error;
      }
      if (attempt < attempts) await this.delay();
    }
    if (await this.getSecurityGroup(groupId)) {
      throw new Error(`AWS workload security group ${groupId} remained observable after deletion.`);
    }
  }

  private async deleteRole(name: string, policyArn: string): Promise<void> {
    const role = await this.getRole(name);
    if (!role) return;
    if (!this.hasManagedTag(role.Tags)) throw new Error(`IAM role ${name} is not Hypervibe-managed.`);
    try {
      await this.connected().clients.iam.send(new DetachRolePolicyCommand({ RoleName: name, PolicyArn: policyArn }));
      await this.connected().clients.iam.send(new DeleteRoleCommand({ RoleName: name }));
    } catch (error) {
      if (!this.hasErrorName(error, 'NoSuchEntity', 'NoSuchEntityException')) throw error;
    }
    if (await this.getRole(name)) throw new Error(`IAM role ${name} remained observable after deletion.`);
  }

  private async ensureDomainCertificate(domain: string, serviceArn: string): Promise<ManagedDomainCertificate> {
    const existing = await this.findManagedDomainCertificate(domain, serviceArn);
    if (existing) {
      this.assertUsableCertificateState(existing, domain);
      return { ...existing, created: false };
    }
    const output = await this.connected().clients.acm.send(new RequestCertificateCommand({
      DomainName: domain,
      ValidationMethod: 'DNS',
      IdempotencyToken: this.hash(`${serviceArn}:${domain}`).slice(0, 32),
      Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
      Tags: [
        { Key: 'managed-by', Value: 'hypervibe' },
        { Key: 'hypervibe-service', Value: this.hash(serviceArn) },
      ],
    }));
    if (!output.CertificateArn) throw new Error(`ACM did not return a certificate ARN for ${domain}.`);
    const created = await this.getCertificate(output.CertificateArn);
    if (!created || created.DomainName !== domain) {
      throw new Error(`ACM certificate ${output.CertificateArn} could not be verified after creation.`);
    }
    this.assertUsableCertificateState(created, domain);
    return { ...created, created: true };
  }

  private async findManagedDomainCertificate(
    domain: string,
    serviceArn: string
  ): Promise<CertificateDetail | null> {
    const summaries = [];
    let NextToken: string | undefined;
    do {
      const output = await this.connected().clients.acm.send(new ListCertificatesCommand({
        NextToken,
        MaxItems: 100,
        CertificateStatuses: [
          'PENDING_VALIDATION',
          'ISSUED',
          'INACTIVE',
          'EXPIRED',
          'VALIDATION_TIMED_OUT',
          'REVOKED',
          'FAILED',
        ],
      }));
      if (!Array.isArray(output.CertificateSummaryList)) {
        throw new Error('AWS ACM certificate observation returned an invalid certificate list.');
      }
      summaries.push(...output.CertificateSummaryList.filter((item) => item.DomainName === domain));
      NextToken = output.NextToken;
    } while (NextToken);

    const managed: CertificateDetail[] = [];
    const conflicting: string[] = [];
    for (const summary of summaries) {
      if (!summary.CertificateArn) continue;
      const tags = await this.connected().clients.acm.send(new ListTagsForCertificateCommand({
        CertificateArn: summary.CertificateArn,
      }));
      const owned = (tags.Tags ?? []).some((tag) => tag.Key === 'managed-by' && tag.Value === 'hypervibe')
        && (tags.Tags ?? []).some((tag) => tag.Key === 'hypervibe-service' && tag.Value === this.hash(serviceArn));
      if (!owned) {
        conflicting.push(summary.CertificateArn);
        continue;
      }
      const certificate = await this.getCertificate(summary.CertificateArn);
      if (certificate) managed.push(certificate);
    }
    if (managed.length > 1) {
      throw new Error(`Multiple Hypervibe-managed ACM certificates match ${domain}: ${managed.map((item) => item.CertificateArn).join(', ')}.`);
    }
    if (conflicting.length > 0) {
      throw new Error(`ACM already contains certificate(s) for ${domain} not owned by this Hypervibe service: ${conflicting.join(', ')}.`);
    }
    return managed[0] ?? null;
  }

  private async getCertificate(certificateArn: string): Promise<CertificateDetail | null> {
    try {
      const certificate = (await this.connected().clients.acm.send(new DescribeCertificateCommand({
        CertificateArn: certificateArn,
      }))).Certificate;
      if (!certificate) {
        throw new Error(
          `AWS returned no ACM certificate and no ResourceNotFoundException for ${certificateArn}.`
        );
      }
      if (certificate.CertificateArn !== certificateArn) {
        throw new Error(
          `AWS returned ACM certificate ${certificate.CertificateArn ?? 'without an ARN'} when ${certificateArn} was requested.`
        );
      }
      return certificate;
    } catch (error) {
      if (this.hasErrorName(error, 'ResourceNotFoundException')) return null;
      throw error;
    }
  }

  private assertUsableCertificateState(certificate: CertificateDetail, domain: string): void {
    if (['FAILED', 'REVOKED', 'EXPIRED', 'VALIDATION_TIMED_OUT'].includes(certificate.Status ?? '')) {
      throw new Error(`ACM certificate for ${domain} is ${certificate.Status}; declare a new domain or remove the failed certificate before retrying.`);
    }
  }

  private certificateValidationRecord(certificate: CertificateDetail, domain: string) {
    const option = (certificate.DomainValidationOptions ?? []).find(
      (item) => item.DomainName === domain
    );
    const record = option?.ResourceRecord;
    if (!record?.Name || !record.Type || !record.Value) return null;
    return record;
  }

  private async expressRouting(clusterArn: string, serviceArn: string): Promise<ExpressRouting> {
    const standard = await this.connected().clients.ecs.send(new DescribeServicesCommand({
      cluster: clusterArn,
      services: [serviceArn],
    }));
    if ((standard.failures ?? []).length > 0 || standard.services?.length !== 1) {
      throw new Error(`AWS could not resolve the load balancer for ECS Express service ${serviceArn}.`);
    }
    const service = standard.services[0]!;
    if (service.serviceArn !== serviceArn || service.clusterArn !== clusterArn) {
      throw new Error(`AWS returned a service outside the reviewed ECS Express identity ${serviceArn}.`);
    }
    const targetGroupArns = [...new Set(
      (service.loadBalancers ?? []).flatMap((item) => item.targetGroupArn ? [item.targetGroupArn] : [])
    )];
    if (targetGroupArns.length === 0) throw new Error(`ECS Express service ${serviceArn} has no observable target group.`);
    const targetGroups = await this.connected().clients.elb.send(new DescribeTargetGroupsCommand({
      TargetGroupArns: targetGroupArns,
    }));
    const loadBalancerArns = [...new Set(
      (targetGroups.TargetGroups ?? []).flatMap((item) => item.LoadBalancerArns ?? [])
    )];
    if (loadBalancerArns.length !== 1) {
      throw new Error(`ECS Express service ${serviceArn} resolved to ${loadBalancerArns.length} load balancers; expected exactly one.`);
    }
    const loadBalancers = await this.connected().clients.elb.send(new DescribeLoadBalancersCommand({
      LoadBalancerArns: loadBalancerArns,
    }));
    const loadBalancer = loadBalancers.LoadBalancers?.[0];
    if (!loadBalancer?.LoadBalancerArn || !loadBalancer.DNSName) {
      throw new Error(`AWS returned an incomplete load balancer for ECS Express service ${serviceArn}.`);
    }
    const listeners = await this.connected().clients.elb.send(new DescribeListenersCommand({
      LoadBalancerArn: loadBalancer.LoadBalancerArn,
    }));
    const httpsListeners = (listeners.Listeners ?? []).filter(
      (listener) => listener.Protocol === 'HTTPS' && listener.Port === 443 && listener.ListenerArn
    );
    if (httpsListeners.length !== 1) {
      throw new Error(`ECS Express load balancer ${loadBalancer.LoadBalancerArn} has ${httpsListeners.length} HTTPS listeners; expected exactly one.`);
    }
    const listenerArn = httpsListeners[0]!.ListenerArn!;
    const rules: Rule[] = [];
    let Marker: string | undefined;
    do {
      const output = await this.connected().clients.elb.send(new DescribeRulesCommand({
        ListenerArn: listenerArn,
        Marker,
        PageSize: 100,
      }));
      rules.push(...(output.Rules ?? []));
      Marker = output.NextMarker;
    } while (Marker);
    const express = await this.getExpressService(serviceArn);
    const expressUrl = express ? this.expressUrl(express) : undefined;
    if (!expressUrl) throw new Error(`ECS Express service ${serviceArn} returned no public endpoint.`);
    const generatedHost = new URL(expressUrl).hostname;
    const candidates = rules.filter((rule) => {
      const targets = (rule.Actions ?? []).flatMap((action) => [
        ...(action.TargetGroupArn ? [action.TargetGroupArn] : []),
        ...(action.ForwardConfig?.TargetGroups ?? []).flatMap((target) => target.TargetGroupArn ? [target.TargetGroupArn] : []),
      ]);
      const hostnames = this.ruleHostnames(rule);
      return targets.some((target) => targetGroupArns.includes(target))
        && (!generatedHost || hostnames.includes(generatedHost));
    });
    if (candidates.length !== 1 || !candidates[0]?.RuleArn) {
      throw new Error(`ECS Express service ${serviceArn} resolved to ${candidates.length} listener rules; expected exactly one.`);
    }
    const certificates = await this.connected().clients.elb.send(new DescribeListenerCertificatesCommand({
      ListenerArn: listenerArn,
      PageSize: 100,
    }));
    return {
      listenerArn,
      loadBalancerDnsName: loadBalancer.DNSName,
      rule: candidates[0],
      ruleArn: candidates[0].RuleArn,
      hostnames: this.ruleHostnames(candidates[0]),
      certificateArns: (certificates.Certificates ?? []).flatMap(
        (item) => item.CertificateArn ? [item.CertificateArn] : []
      ),
    };
  }

  private ruleHostnames(rule: Rule): string[] {
    return [...new Set(
      (rule.Conditions ?? []).filter((condition) => condition.Field === 'host-header').flatMap(
        (condition) => condition.HostHeaderConfig?.Values ?? condition.Values ?? []
      ).map((value) => value.toLowerCase())
    )].sort();
  }

  private ruleConditionsWithHostnames(rule: Rule, hostnames: string[]): RuleCondition[] {
    const existing = rule.Conditions ?? [];
    const hostConditions = existing.filter((condition) => condition.Field === 'host-header');
    if (hostConditions.length !== 1) {
      throw new Error(`ECS Express listener rule ${rule.RuleArn} has ${hostConditions.length} host-header conditions; expected exactly one.`);
    }
    return existing.map((condition) => condition.Field === 'host-header'
      ? { Field: 'host-header', HostHeaderConfig: { Values: hostnames } }
      : condition);
  }

  private emptyObservation(projectExists: boolean): ObservedState {
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists,
      services: [],
      databases: [],
      completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' },
      partial: false,
      warnings: [],
    };
  }

  private failedDeploy(
    service: Service,
    error: string,
    externalId?: string,
    createdService = false
  ): DeployResult {
    return {
      serviceId: service.id,
      ...(externalId ? { externalId } : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `AWS ECS Express deployment failed for ${service.name}`,
        error,
        ...(externalId ? {
          data: { serviceId: externalId, createdService, mutationAttempted: true },
        } : {}),
      },
    };
  }

  private failedReceipt(message: string, error: string, data?: Record<string, unknown>): Receipt {
    return { success: false, message, error, ...(data ? { data } : {}) };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private attempts(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async delay(): Promise<void> {
    const parsed = Number(process.env.HYPERVIBE_ECS_WAIT_DELAY_MS ?? 1000);
    if (Number.isFinite(parsed) && parsed > 0) await new Promise((resolve) => setTimeout(resolve, parsed));
  }

  private hasErrorName(error: unknown, ...names: string[]): boolean {
    return Boolean(error && typeof error === 'object' && names.includes(String((error as { name?: unknown }).name)));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async observeDomains(params: {
    clusterArn: string;
    serviceArn: string;
    domains: string[];
  }): Promise<ObservedService['customDomainStatus']> {
    if (params.domains.length === 0) return {};
    const routing = await this.expressRouting(params.clusterArn, params.serviceArn);
    const result: NonNullable<ObservedService['customDomainStatus']> = {};
    for (const domain of params.domains) {
      const certificate = await this.findManagedDomainCertificate(domain, params.serviceArn);
      const validation = certificate ? this.certificateValidationRecord(certificate, domain) : null;
      const attached = Boolean(certificate?.CertificateArn)
        && routing.certificateArns.includes(certificate!.CertificateArn!)
        && routing.hostnames.includes(domain);
      result[domain] = {
        providerVerified: certificate?.Status === 'ISSUED' && attached,
        certificateStatus: certificate?.Status ?? 'ABSENT',
        dnsConfigured: certificate?.Status === 'ISSUED',
        dnsRecords: [
          ...(validation ? [{
            name: validation.Name!,
            type: validation.Type!,
            value: validation.Value!,
            purpose: 'certificate-validation',
            status: certificate?.Status,
          }] : []),
          {
            name: domain,
            type: 'CNAME',
            value: routing.loadBalancerDnsName,
            purpose: 'routing',
            status: attached ? 'ready' : 'pending',
          },
        ],
      };
    }
    return result;
  }
}

providerRegistry.register({
  metadata: {
    name: 'ecs',
    displayName: 'AWS ECS Express Mode',
    category: 'deployment',
    credentialsSchema: EcsExpressCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    credentials: {
      environmentVariableAliases: [
        ['HYPERVIBE_AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
        ['HYPERVIBE_AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'],
      ],
    },
    maturity: {
      lifecycle: {
        hosting: { status: 'ready-for-live' },
      },
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: { workloadKindObservation: 'exact' },
      ci: {
        displayName: 'AWS ECS Express Mode',
        requiredSecrets: ECS_EXPRESS_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          AWS_ACCESS_KEY_ID: 'accessKeyId',
          AWS_SECRET_ACCESS_KEY: 'secretAccessKey',
        },
        buildGitHubActionsSteps: buildEcsExpressGitHubActionsSteps,
        buildPortableRecipe: buildEcsExpressPortableRecipe,
        portableRunnerCapabilities: ['linux-amd64', 'docker-privileged'],
      },
    },
    lifecycle: {
      hosting: {
        workloadKinds: ['web'],
        customDomains: 'managed',
        domainTrafficProxy: 'dns-only',
        maintenance: 'unsupported',
        teardownBoundary: 'project',
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new EcsExpressAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['environment'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'region', 'limit'], list: true },
    },
    inspect: (adapter, request) => (
      adapter as EcsExpressAdapter
    ).inspectEnvironmentResources(request),
  },
});
