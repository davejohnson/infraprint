import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';

export const RAILWAY_DEPLOY_RUNTIME_PATH = '.gitlab/hypervibe/railway-deploy.mjs';

function shellSingleQuoted(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function buildRailwayDeployRuntime(): string {
  return `import { readFile, writeFile } from 'node:fs/promises';

const required = [
  'RAILWAY_API_TOKEN',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_IDS',
  'IMAGE_REGISTRY_USERNAME',
  'IMAGE_REGISTRY_TOKEN',
  'HYPERVIBE_REPOSITORY',
  'HYPERVIBE_ENVIRONMENT',
  'HYPERVIBE_PROGRAM_FINGERPRINT',
];
for (const key of required) {
  if (!process.env[key]) throw new Error(key + ' is required');
}
const deploySha = (await readFile('.hypervibe-deploy-sha', 'utf8')).trim();
const imageUri = (await readFile('.hypervibe-image-uri', 'utf8')).trim();
if (!/^[0-9a-f]{40}$/i.test(deploySha)) {
  throw new Error('HYPERVIBE_DEPLOY_SHA must be a full Git SHA');
}
if (!/^[A-Za-z0-9._/:@-]+$/.test(imageUri)) throw new Error('IMAGE_URI is invalid');

const endpoint = 'https://backboard.railway.app/graphql/v2';
const delays = [1000, 2000, 4000];
const secretValues = [
  process.env.RAILWAY_API_TOKEN,
  process.env.IMAGE_REGISTRY_TOKEN,
].filter(Boolean);

function sanitize(message) {
  let value = String(message);
  for (const secret of secretValues) value = value.split(secret).join('***');
  return value
    .replace(/(Authorization:\\s*(?:Bearer|Basic)\\s+)\\S+/gi, '$1***')
    .replace(/([?&](?:token|password|secret|credential)=)[^&\\s]+/gi, '$1***');
}

async function railway(query, variables, retry = false) {
  const attempts = retry ? delays.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.RAILWAY_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      if (attempt === attempts - 1) throw new Error('Railway network request failed: ' + sanitize(error));
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      continue;
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* fail below without returning the body */ }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        continue;
      }
      throw new Error('Railway API request failed with HTTP ' + response.status);
    }
    if (!payload || !payload.data || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
      const traceIds = (payload?.errors || []).map((entry) => entry?.traceId).filter(Boolean);
      throw new Error('Railway GraphQL request failed' + (traceIds.length ? ' traceId=' + traceIds.join(',') : ''));
    }
    return payload.data;
  }
  throw new Error('Railway request exhausted without a result');
}

const instanceQuery = 'query ServiceEnvironmentInstance($serviceId: String!) { service(id: $serviceId) { serviceInstances { edges { node { environmentId } } } } }';
const updateMutation = 'mutation UpdateServiceImage($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }';
const deployMutation = 'mutation DeployServiceImage($serviceId: String!, $environmentId: String!, $commitSha: String) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
const deploymentQuery = 'query DeploymentStatus($id: String!) { deployment(id: $id) { id status url staticUrl } }';
const failed = new Set(['CRASHED', 'FAILED', 'REMOVED', 'SKIPPED']);

async function waitForDeployment(id, serviceId) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const data = await railway(deploymentQuery, { id }, true);
    if (!data.deployment) throw new Error('Railway returned no deployment for ' + id);
    console.log('Railway deployment ' + id + ' for service ' + serviceId + ': ' + data.deployment.status);
    if (data.deployment.status === 'SUCCESS') return data.deployment;
    if (failed.has(data.deployment.status)) {
      throw new Error('Railway deployment ' + id + ' failed with status ' + data.deployment.status);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Timed out waiting for Railway deployment ' + id);
}

const serviceIds = process.env.RAILWAY_SERVICE_IDS.split(',').map((value) => value.trim()).filter(Boolean);
if (serviceIds.length === 0) throw new Error('RAILWAY_SERVICE_IDS is empty');
const deployments = [];
for (const serviceId of serviceIds) {
  const instance = await railway(instanceQuery, { serviceId }, true);
  const exists = (instance.service?.serviceInstances?.edges || [])
    .some((edge) => edge?.node?.environmentId === process.env.RAILWAY_ENVIRONMENT_ID);
  if (!exists) throw new Error('Railway service ' + serviceId + ' is not bound to the reviewed environment');
  await railway(updateMutation, {
    serviceId,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    input: {
      source: { image: imageUri },
      registryCredentials: {
        username: process.env.IMAGE_REGISTRY_USERNAME,
        password: process.env.IMAGE_REGISTRY_TOKEN,
      },
    },
  });
  const deployed = await railway(deployMutation, {
    serviceId,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    commitSha: deploySha,
  });
  const deploymentId = deployed.serviceInstanceDeployV2;
  if (typeof deploymentId !== 'string' || !deploymentId) throw new Error('Railway returned no deployment id');
  const observed = await waitForDeployment(deploymentId, serviceId);
  deployments.push({ serviceId, deploymentId, url: observed.url || observed.staticUrl || null });
}

const evidence = {
  version: 1,
  provider: 'railway',
  repository: process.env.HYPERVIBE_REPOSITORY,
  environment: process.env.HYPERVIBE_ENVIRONMENT,
  sha: deploySha.toLowerCase(),
  programFingerprint: process.env.HYPERVIBE_PROGRAM_FINGERPRINT,
  deployments,
};
await writeFile('.hypervibe-release.json', JSON.stringify(evidence) + '\\n', { mode: 0o600 });
`;
}

export function gitLabShellLiteral(value: string): string {
  return shellSingleQuoted(value);
}

export function buildRailwayPortableRecipe(target: BranchDeployTarget): PortableCiDeployRecipe {
  if (!target.providerEnvironmentId || target.providerServiceIds.length === 0) {
    throw new Error(`Railway bindings for ${target.environmentName} are incomplete; apply hosting first, then re-plan CI`);
  }
  return {
    version: 1,
    provider: 'railway',
    kind: 'container',
    runnerCapabilities: ['linux-amd64', 'docker-privileged'],
    values: [
      { name: 'RAILWAY_API_TOKEN', source: { kind: 'connection', provider: 'railway', credentialKey: 'apiToken' }, secret: true },
      { name: 'IMAGE_REGISTRY_USERNAME', source: { kind: 'connection', provider: 'gitlab', credentialKey: 'registryUsername' }, secret: false },
      { name: 'IMAGE_REGISTRY_TOKEN', source: { kind: 'connection', provider: 'gitlab', credentialKey: 'registryReadToken' }, secret: true },
      { name: 'RAILWAY_ENVIRONMENT_ID', source: { kind: 'literal', value: target.providerEnvironmentId }, secret: false },
      { name: 'RAILWAY_SERVICE_IDS', source: { kind: 'literal', value: [...target.providerServiceIds].sort().join(',') }, secret: false },
    ],
    runtime: {
      path: RAILWAY_DEPLOY_RUNTIME_PATH,
      content: buildRailwayDeployRuntime(),
    },
  };
}
