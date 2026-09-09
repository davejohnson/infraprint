#!/usr/bin/env node

const sourceBase = 'https://raw.githubusercontent.com/railwayapp/cli/master';
const sourceUrls = {
  schema: `${sourceBase}/src/gql/schema.json`,
  environmentConfig: `${sourceBase}/src/controllers/config/environment.rs`,
  bucketCommand: `${sourceBase}/src/commands/bucket.rs`,
};

async function fetchOfficialSource(label, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'hypervibe-provider-contract-check' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw new Error(`Could not fetch Railway ${label} from ${url}: ${String(lastError)}`);
}

function renderType(type) {
  if (!type || typeof type !== 'object') return '<missing>';
  if (type.kind === 'NON_NULL') return `${renderType(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${renderType(type.ofType)}]`;
  return typeof type.name === 'string' ? type.name : '<missing>';
}

function schemaFields(schema, typeName) {
  const types = schema?.data?.__schema?.types;
  if (!Array.isArray(types)) return undefined;
  const type = types.find((candidate) => candidate?.name === typeName);
  return Array.isArray(type?.fields) ? type.fields : undefined;
}

function fieldType(schema, typeName, fieldName) {
  const field = schemaFields(schema, typeName)?.find((candidate) => candidate?.name === fieldName);
  return renderType(field?.type);
}

const expectedSchemaFields = {
  'Environment.config': 'EnvironmentConfig!',
  'Environment.unmergedChangesCount': 'Int',
  'Environment.volumeInstances': 'EnvironmentVolumeInstancesConnection!',
  'Project.buckets': 'ProjectBucketsConnection!',
  'ProjectBucketsConnection.edges': '[ProjectBucketsConnectionEdge!]!',
  'ProjectBucketsConnectionEdge.node': 'Bucket!',
  'Bucket.id': 'ID!',
  'Bucket.name': 'String!',
  'Bucket.projectId': 'String!',
  'Mutation.projectCreate': 'Project!',
  'Mutation.serviceCreate': 'Service!',
  'Mutation.volumeCreate': 'Volume!',
  'Mutation.volumeDelete': 'Boolean!',
  'Mutation.serviceInstanceRedeploy': 'Boolean!',
  'Mutation.variableCollectionUpsert': 'Boolean!',
  'Mutation.environmentCreate': 'Environment!',
  'Mutation.projectDelete': 'Boolean!',
  'Mutation.environmentDelete': 'Boolean!',
  'Mutation.serviceDelete': 'Boolean!',
  'Mutation.variableDelete': 'Boolean!',
  'Mutation.serviceInstanceUpdate': 'Boolean!',
  'Mutation.serviceConnect': 'Service!',
  'Mutation.serviceDisconnect': 'Service!',
  'Mutation.customDomainCreate': 'CustomDomain!',
  'Mutation.customDomainUpdate': 'Boolean!',
  'Mutation.customDomainDelete': 'Boolean!',
  'Mutation.serviceDomainCreate': 'ServiceDomain!',
  'Mutation.tcpProxyCreate': 'TCPProxy!',
  'Mutation.tcpProxyDelete': 'Boolean!',
  'Mutation.deploymentRemove': 'Boolean!',
  'Mutation.bucketCreate': 'Bucket!',
  'Mutation.environmentPatchCommit': 'String!',
  'Query.me': 'User!',
  'Query.project': 'Project!',
  'Query.environment': 'Environment!',
  'Query.service': 'Service!',
  'Query.serviceInstance': 'ServiceInstance!',
  'Query.deployment': 'Deployment!',
  'Query.deployments': 'QueryDeploymentsConnection!',
  'Query.variables': 'EnvironmentVariables!',
  'Query.tcpProxies': '[TCPProxy!]!',
  'Query.customDomain': 'CustomDomain!',
  'Query.deploymentLogs': '[Log!]!',
  'Query.buildLogs': '[Log!]!',
  'Query.gitHubRepoAccessAvailable': 'GitHubAccess!',
  'Query.bucketS3Credentials': '[BucketS3CompatibleCredentials!]!',
  'Query.bucketInstanceDetails': 'BucketInstanceDetails',
  'BucketS3CompatibleCredentials.endpoint': 'String!',
  'BucketS3CompatibleCredentials.accessKeyId': 'String!',
  'BucketS3CompatibleCredentials.secretAccessKey': 'String!',
  'BucketS3CompatibleCredentials.bucketName': 'String!',
  'BucketS3CompatibleCredentials.region': 'String!',
  'BucketS3CompatibleCredentials.urlStyle': 'String!',
  'BucketInstanceDetails.objectCount': 'BigInt!',
  'BucketInstanceDetails.sizeBytes': 'BigInt!',
  'EnvironmentVolumeInstancesConnection.edges': '[EnvironmentVolumeInstancesConnectionEdge!]!',
  'EnvironmentVolumeInstancesConnection.pageInfo': 'PageInfo!',
  'EnvironmentVolumeInstancesConnectionEdge.node': 'VolumeInstance!',
  'VolumeInstance.id': 'ID!',
  'VolumeInstance.serviceId': 'String',
  'VolumeInstance.environmentId': 'String!',
  'VolumeInstance.mountPath': 'String!',
  'VolumeInstance.deletedAt': 'DateTime',
  'VolumeInstance.isPendingDeletion': 'Boolean!',
  'VolumeInstance.volume': 'Volume!',
  'Volume.id': 'ID!',
  'Volume.projectId': 'String!',
  'PageInfo.hasNextPage': 'Boolean!',
  'PageInfo.endCursor': 'String',
};

const [schemaText, environmentConfigSource, bucketCommandSource] = await Promise.all([
  fetchOfficialSource('GraphQL schema', sourceUrls.schema),
  fetchOfficialSource('environment config model', sourceUrls.environmentConfig),
  fetchOfficialSource('bucket command', sourceUrls.bucketCommand),
]);

let schema;
try {
  schema = JSON.parse(schemaText);
} catch (error) {
  throw new Error(`Railway GraphQL schema was not valid JSON at ${sourceUrls.schema}: ${String(error)}`);
}

const failures = [];
for (const [path, expected] of Object.entries(expectedSchemaFields)) {
  const separator = path.lastIndexOf('.');
  const typeName = path.slice(0, separator);
  const fieldName = path.slice(separator + 1);
  const actual = fieldType(schema, typeName, fieldName);
  if (actual !== expected) {
    failures.push(`${path}: expected ${expected}, received ${actual}`);
  }
}

const semanticChecks = [
  {
    description: 'EnvironmentConfig defaults omitted maps and models buckets as a map',
    source: sourceUrls.environmentConfig,
    passed: /#\[serde\(default,\s*rename_all\s*=\s*"camelCase"\)\][\s\S]*?pub struct EnvironmentConfig[\s\S]*?pub buckets:\s*BTreeMap<String, BucketInstance>/.test(environmentConfigSource),
  },
  {
    description: 'bucket creation remains project-scoped before applying an environment patch',
    source: sourceUrls.bucketCommand,
    passed: /bucket_create::BucketCreateInput\s*\{[\s\S]*?environment_id:\s*None,[\s\S]*?project_id:/.test(bucketCommandSource),
  },
  {
    description: 'bucket patches use environmentPatchCommit when there are no staged changes',
    source: sourceUrls.bucketCommand,
    passed: /post_graphql::<mutations::EnvironmentPatchCommit[\s\S]*?unmerged_changes_count\.unwrap_or_default\(\)\s*>\s*0/.test(bucketCommandSource),
  },
  {
    description: 'missing bucket usage details remain unavailable rather than empty',
    source: sourceUrls.bucketCommand,
    passed: /bucket_instance_details\.ok_or_else[\s\S]*?Detailed bucket stats are unavailable/.test(bucketCommandSource),
  },
  {
    description: 'exactly one S3-compatible credential set is required',
    source: sourceUrls.bucketCommand,
    passed: /No S3-compatible credentials were returned[\s\S]*?Expected a single S3-compatible credential set/.test(bucketCommandSource),
  },
];

for (const check of semanticChecks) {
  if (!check.passed) failures.push(`${check.description} (${check.source})`);
}

if (failures.length > 0) {
  console.error('Railway upstream contract drift detected:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Official schema: ${sourceUrls.schema}`);
  process.exitCode = 1;
} else {
  console.log(`Railway upstream contract matches ${Object.keys(expectedSchemaFields).length} schema fields and ${semanticChecks.length} CLI behaviors.`);
  console.log(`Official schema: ${sourceUrls.schema}`);
}
