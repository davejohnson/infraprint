import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';
import { HYPERVIBE_MANAGED_NPM_PACKAGES } from '../../../domain/services/managed-runtime.js';

export const ECS_EXPRESS_PORTABLE_RUNTIME_PATH = '.gitlab/hypervibe/ecs-express-deploy.cjs';

export function buildEcsExpressPortableRuntime(): string {
  return `const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { ECRClient, DescribeImagesCommand, DescribeRepositoriesCommand, GetAuthorizationTokenCommand } = require('@aws-sdk/client-ecr');
const { DescribeExpressGatewayServiceCommand, ECSClient, UpdateExpressGatewayServiceCommand } = require('@aws-sdk/client-ecs');

const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ECS_CLUSTER_ARN', 'AWS_ECS_EXPRESS_SERVICE_ARNS_JSON', 'CI_REGISTRY', 'CI_REGISTRY_USER', 'CI_REGISTRY_PASSWORD', 'CI_PROJECT_PATH', 'HYPERVIBE_REPOSITORY', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_PROGRAM_FINGERPRINT'];
for (const key of required) if (!process.env[key]) throw new Error(key + ' is required');
const clusterArn = process.env.AWS_ECS_CLUSTER_ARN.trim();
const match = clusterArn.match(/^arn:aws(?:-[a-z]+)?:ecs:([^:]+):(\\d{12}):cluster\\/(.+)$/);
if (!match || !/^[A-Za-z0-9_-]+$/.test(match[3])) throw new Error('AWS ECS cluster binding is invalid');
const [, region, account, cluster] = match;
let serviceArns;
try { serviceArns = JSON.parse(process.env.AWS_ECS_EXPRESS_SERVICE_ARNS_JSON); } catch { throw new Error('AWS service bindings must be JSON'); }
if (!Array.isArray(serviceArns) || serviceArns.length === 0 || serviceArns.some((value) => typeof value !== 'string')) throw new Error('AWS service bindings are invalid');
serviceArns = [...new Set(serviceArns.map((value) => value.trim()))];
for (const arn of serviceArns) if (!arn.startsWith(clusterArn.replace(':cluster/', ':service/') + '/')) throw new Error('ECS Express service is outside the bound cluster');
const sha = readFileSync('.hypervibe-deploy-sha', 'utf8').trim().toLowerCase();
const sourceImage = readFileSync('.hypervibe-image-uri', 'utf8').trim();
if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9._/:@-]+$/.test(sourceImage)) throw new Error('Build artifacts are invalid');
const repositoryName = 'hypervibe/' + cluster.toLowerCase();
const ecr = new ECRClient({ region });
const repositories = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
if (repositories.repositories?.length !== 1 || repositories.repositories[0].repositoryName !== repositoryName || repositories.repositories[0].registryId !== account) throw new Error('ECR repository identity did not match the applied ECS cluster binding');
const authResult = await ecr.send(new GetAuthorizationTokenCommand({ registryIds: [account] }));
const authorization = authResult.authorizationData?.[0];
if (!authorization?.authorizationToken || !authorization.proxyEndpoint) throw new Error('ECR returned no exact registry authorization');
const [username, password] = Buffer.from(authorization.authorizationToken, 'base64').toString('utf8').split(':', 2);
if (!username || !password) throw new Error('ECR authorization was malformed');
const registry = authorization.proxyEndpoint.replace(/^https?:\\/\\//, '');
const expectedRegistry = account + '.dkr.ecr.' + region + '.amazonaws.com';
if (registry !== expectedRegistry) throw new Error('ECR authorization returned a different account or region');
const imageTag = registry + '/' + repositoryName + ':' + sha;
const docker = './.hypervibe-docker';
function dockerInput(args, input) { execFileSync(docker, args, { input, stdio: ['pipe', 'inherit', 'inherit'] }); }
dockerInput(['login', process.env.CI_REGISTRY, '--username', process.env.CI_REGISTRY_USER, '--password-stdin'], process.env.CI_REGISTRY_PASSWORD);
execFileSync(docker, ['pull', sourceImage], { stdio: 'inherit' });
dockerInput(['login', registry, '--username', username, '--password-stdin'], password);
execFileSync(docker, ['tag', sourceImage, imageTag], { stdio: 'inherit' });
execFileSync(docker, ['push', imageTag], { stdio: 'inherit' });
execFileSync(docker, ['logout', process.env.CI_REGISTRY], { stdio: 'ignore' });
execFileSync(docker, ['logout', registry], { stdio: 'ignore' });
let detail;
for (let attempt = 0; attempt < 20; attempt++) {
  const observed = await ecr.send(new DescribeImagesCommand({ repositoryName, imageIds: [{ imageTag: sha }] }));
  detail = observed.imageDetails?.find((candidate) => candidate.imageTags?.includes(sha));
  if (detail?.imageDigest) break;
  if (attempt === 19) throw new Error('ECR did not expose the exact pushed image tag');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const digest = detail.imageDigest.toLowerCase();
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('ECR returned an invalid image digest');
const exactImage = registry + '/' + repositoryName + '@' + digest;
const ecs = new ECSClient({ region });
const currentConfig = (service) => {
  const configs = service?.activeConfigurations || [];
  return configs.find((item) => item.serviceRevisionArn === service.currentDeployment) || [...configs].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0];
};
const deployments = [];
for (const serviceArn of serviceArns) {
  const before = (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn }))).service;
  if (!before || before.serviceArn !== serviceArn || before.cluster !== clusterArn) throw new Error('ECS returned a different service identity');
  const config = currentConfig(before);
  if (!config?.primaryContainer) throw new Error('ECS returned no active primary container');
  const environment = [...(config.primaryContainer.environment || [])].filter((entry) => !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(entry.name));
  const marker = (name) => environment.find((entry) => entry.name === name)?.value;
  environment.push({ name: 'HYPERVIBE_DEPLOY_SHA', value: sha }, { name: 'HYPERVIBE_IMAGE_DIGEST', value: digest });
  const startCommand = marker('HYPERVIBE_START_COMMAND');
  const healthPath = marker('HYPERVIBE_HEALTH_CHECK_PATH') || '/';
  if (!Array.isArray(config.networkConfiguration?.subnets) || config.networkConfiguration.subnets.length < 2 || !Array.isArray(config.networkConfiguration?.securityGroups) || config.networkConfiguration.securityGroups.length !== 1) throw new Error('ECS Express workload-network configuration is missing or malformed');
  await ecs.send(new UpdateExpressGatewayServiceCommand({ serviceArn, executionRoleArn: config.executionRoleArn, cpu: config.cpu, memory: config.memory, healthCheckPath: healthPath, primaryContainer: { ...config.primaryContainer, image: exactImage, environment, command: startCommand ? ['sh', '-lc', startCommand] : undefined }, networkConfiguration: config.networkConfiguration, scalingTarget: config.scalingTarget }));
  let endpoint;
  let revision;
  for (let attempt = 0; attempt < 120; attempt++) {
    const observed = (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn }))).service;
    const active = currentConfig(observed);
    const activeEnv = active?.primaryContainer?.environment || [];
    const value = (name) => activeEnv.find((entry) => entry.name === name)?.value;
    if (observed?.status?.statusCode === 'ACTIVE' && active?.primaryContainer?.image === exactImage && value('HYPERVIBE_DEPLOY_SHA') === sha && value('HYPERVIBE_IMAGE_DIGEST') === digest) {
      endpoint = active.ingressPaths?.find((entry) => entry.accessType === 'PUBLIC')?.endpoint || active.ingressPaths?.[0]?.endpoint;
      revision = active.serviceRevisionArn;
      break;
    }
    if (attempt === 119) throw new Error('ECS Express did not converge to the exact digest');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!endpoint) throw new Error('ECS Express returned no public endpoint');
  const health = await fetch(new URL(healthPath, endpoint.startsWith('http') ? endpoint : 'https://' + endpoint), { redirect: 'follow' });
  if (!health.ok) throw new Error('ECS Express health check failed with HTTP ' + health.status);
  deployments.push({ serviceArn, revision, url: endpoint });
}
writeFileSync('.hypervibe-release.json', JSON.stringify({ version: 1, provider: 'ecs', repository: process.env.HYPERVIBE_REPOSITORY, environment: process.env.HYPERVIBE_ENVIRONMENT, sha, programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT, deployments }) + '\\n', { mode: 0o600 });
`;
}

export function buildEcsExpressPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  const clusterArn = target.providerProjectId?.trim();
  const serviceArns = [...new Set(target.providerServiceIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (!clusterArn || serviceArns.length === 0) throw new Error(`ECS Express bindings for ${target.environmentName} are incomplete; apply hosting first`);
  return {
    version: 1,
    provider: 'ecs',
    kind: 'container',
    runnerCapabilities: ['linux-amd64', 'docker-privileged'],
    values: [
      { name: 'AWS_ACCESS_KEY_ID', source: { kind: 'connection', provider: 'ecs', credentialKey: 'accessKeyId' }, secret: true },
      { name: 'AWS_SECRET_ACCESS_KEY', source: { kind: 'connection', provider: 'ecs', credentialKey: 'secretAccessKey' }, secret: true },
      { name: 'AWS_ECS_CLUSTER_ARN', source: { kind: 'literal', value: clusterArn }, secret: false },
      { name: 'AWS_ECS_EXPRESS_SERVICE_ARNS_JSON', source: { kind: 'literal', value: JSON.stringify(serviceArns) }, secret: false },
    ],
    runtime: {
      path: ECS_EXPRESS_PORTABLE_RUNTIME_PATH,
      content: buildEcsExpressPortableRuntime(),
      npmPackages: [HYPERVIBE_MANAGED_NPM_PACKAGES.awsEcr, HYPERVIBE_MANAGED_NPM_PACKAGES.awsEcs],
    },
  };
}
