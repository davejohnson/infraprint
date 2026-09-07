import type {
  BranchDeployStepResult,
  BranchDeployTarget,
} from '../../../domain/ports/ci-deploy.port.js';
import {
  buildDockerfileStep,
  providerValueOrVariable,
  yamlSingleQuoted,
} from '../../../domain/services/github-actions-workflow.js';
import { HYPERVIBE_MANAGED_NPM_PACKAGES } from '../../../domain/services/managed-runtime.js';

export const ECS_EXPRESS_CI_REQUIRED_SECRETS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

export function buildEcsExpressGitHubActionsSteps(
  target: BranchDeployTarget
): BranchDeployStepResult {
  const serviceArns = Array.from(new Set(
    target.providerServiceIds.map((value) => value.trim()).filter(Boolean)
  ));
  const clusterArn = providerValueOrVariable(
    target.providerProjectId,
    'AWS_ECS_CLUSTER_ARN'
  );
  const serviceArnsValue = serviceArns.length > 0
    ? yamlSingleQuoted(JSON.stringify(serviceArns))
    : '${{ vars.AWS_ECS_EXPRESS_SERVICE_ARNS_JSON }}';
  const requiredVariables = [
    ...(target.providerProjectId ? [] : ['AWS_ECS_CLUSTER_ARN']),
    ...(serviceArns.length > 0 ? [] : ['AWS_ECS_EXPRESS_SERVICE_ARNS_JSON']),
  ];

  return {
    displayName: 'AWS ECS Express Mode',
    requiredSecrets: [...ECS_EXPRESS_CI_REQUIRED_SECRETS],
    requiredVariables,
    permissions: `    permissions:
      actions: read
      contents: read
`,
    reviewDetails: [
      'Builds one linux/amd64 image tagged with the full checked-out Git SHA and pushes it to the Hypervibe-managed ECR repository.',
      'Updates only ECS Express services already planned, applied, and bound by ARN; CI never creates clusters, repositories, IAM roles, networking, load balancers, or domains.',
      'Deploys the registry-reported digest, waits for the Express service to report the exact image and SHA markers, then checks its HTTPS endpoint.',
    ],
    steps: `      - name: Resolve bound AWS target
        id: aws_target
        uses: actions/github-script@v9
        env:
          AWS_ECS_CLUSTER_ARN: ${clusterArn}
        with:
          script: |
            const value = (process.env.AWS_ECS_CLUSTER_ARN || '').trim();
            const match = value.match(
              /^arn:aws(?:-[a-z]+)?:ecs:([^:]+):(\\d{12}):cluster\\/(.+)$/
            );
            if (!match) throw new Error('AWS_ECS_CLUSTER_ARN must be a bound ECS cluster ARN');
            const [, region, account, cluster] = match;
            if (!/^[A-Za-z0-9_-]+$/.test(cluster)) {
              throw new Error('The bound ECS cluster name is invalid');
            }
            core.setOutput('region', region);
            core.setOutput('repository', 'hypervibe/' + cluster.toLowerCase());
            core.setOutput(
              'image',
              account + '.dkr.ecr.' + region + '.amazonaws.com/hypervibe/'
                + cluster.toLowerCase() + ':' + process.env.GITHUB_SHA.toLowerCase()
            );
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v5
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ steps.aws_target.outputs.region }}
      - name: Authenticate to Hypervibe-managed ECR
        uses: aws-actions/amazon-ecr-login@v2
${buildDockerfileStep(target)}      - uses: docker/setup-buildx-action@v3
      - name: Publish exact-SHA AWS image
        id: aws_publish
        uses: docker/build-push-action@v6
        with:
          context: .
          file: \${{ steps.dockerfile.outputs.path }}
          push: true
          tags: \${{ steps.aws_target.outputs.image }}
          platforms: linux/amd64
          secrets: |
            npm_token=\${{ secrets.NODE_AUTH_TOKEN }}
      - name: Install pinned ECS SDK
        run: npm install --no-save --ignore-scripts ${HYPERVIBE_MANAGED_NPM_PACKAGES.awsEcs}
      - name: Release exact digest to bound ECS Express services
        uses: actions/github-script@v9
        env:
          AWS_ECS_CLUSTER_ARN: ${clusterArn}
          AWS_ECS_EXPRESS_SERVICE_ARNS_JSON: ${serviceArnsValue}
          IMAGE_URI: \${{ steps.aws_target.outputs.image }}
          IMAGE_DIGEST: \${{ steps.aws_publish.outputs.digest }}
          DEPLOY_SHA: \${{ github.sha }}
        with:
          script: |
            const {
              DescribeExpressGatewayServiceCommand,
              ECSClient,
              UpdateExpressGatewayServiceCommand,
            } = require('@aws-sdk/client-ecs');
            const clusterArn = (process.env.AWS_ECS_CLUSTER_ARN || '').trim();
            const cluster = clusterArn.split('/').at(-1);
            const region = clusterArn.split(':')[3];
            if (!cluster || !region) throw new Error('Invalid bound ECS cluster ARN');
            let serviceArns;
            try {
              serviceArns = JSON.parse(process.env.AWS_ECS_EXPRESS_SERVICE_ARNS_JSON || '');
            } catch {
              throw new Error('AWS_ECS_EXPRESS_SERVICE_ARNS_JSON must be a JSON array');
            }
            if (!Array.isArray(serviceArns) || serviceArns.length === 0
              || serviceArns.some((value) => typeof value !== 'string')) {
              throw new Error('AWS_ECS_EXPRESS_SERVICE_ARNS_JSON must contain bound service ARNs');
            }
            serviceArns = [...new Set(serviceArns.map((value) => value.trim()))];
            for (const arn of serviceArns) {
              if (!arn.startsWith(clusterArn.replace(':cluster/', ':service/') + '/')) {
                throw new Error('ECS Express service ARN is outside the bound cluster: ' + arn);
              }
            }
            const digest = (process.env.IMAGE_DIGEST || '').trim().toLowerCase();
            const sha = (process.env.DEPLOY_SHA || '').trim().toLowerCase();
            if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
              throw new Error('AWS image publication did not return a digest');
            }
            if (!/^[0-9a-f]{40}$/.test(sha)) {
              throw new Error('DEPLOY_SHA must be a full Git SHA');
            }
            const exactImage = process.env.IMAGE_URI.replace(/:[^/:]+$/, '') + '@' + digest;
            const client = new ECSClient({ region });
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const currentConfig = (service) => {
              const configs = service?.activeConfigurations || [];
              return configs.find((item) => item.serviceRevisionArn === service.currentDeployment)
                || configs.toSorted((a, b) =>
                  new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
                )[0];
            };
            for (const serviceArn of serviceArns) {
              const before = (await client.send(
                new DescribeExpressGatewayServiceCommand({ serviceArn })
              )).service;
              if (!before || before.serviceArn !== serviceArn || before.cluster !== clusterArn) {
                throw new Error('Bound ECS Express service identity could not be verified: ' + serviceArn);
              }
              const config = currentConfig(before);
              if (!config?.primaryContainer) {
                throw new Error('ECS Express returned no active primary container for ' + serviceArn);
              }
              if (!Array.isArray(config.networkConfiguration?.subnets)
                || config.networkConfiguration.subnets.length < 2
                || !Array.isArray(config.networkConfiguration?.securityGroups)
                || config.networkConfiguration.securityGroups.length !== 1) {
                throw new Error('ECS Express workload-network configuration is missing or malformed for ' + serviceArn);
              }
              const environment = [...(config.primaryContainer.environment || [])]
                .filter((item) => !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(item.name));
              const marker = (name) => environment.find((item) => item.name === name)?.value;
              environment.push(
                { name: 'HYPERVIBE_DEPLOY_SHA', value: sha },
                { name: 'HYPERVIBE_IMAGE_DIGEST', value: digest }
              );
              const startCommand = marker('HYPERVIBE_START_COMMAND');
              const healthPath = marker('HYPERVIBE_HEALTH_CHECK_PATH') || '/';
              await client.send(new UpdateExpressGatewayServiceCommand({
                serviceArn,
                executionRoleArn: config.executionRoleArn,
                cpu: config.cpu,
                memory: config.memory,
                healthCheckPath: healthPath,
                primaryContainer: {
                  ...config.primaryContainer,
                  image: exactImage,
                  environment,
                  command: startCommand ? ['sh', '-lc', startCommand] : undefined,
                },
                networkConfiguration: config.networkConfiguration,
                scalingTarget: config.scalingTarget,
              }));
              let endpoint;
              for (let attempt = 1; attempt <= 120; attempt += 1) {
                const observed = (await client.send(
                  new DescribeExpressGatewayServiceCommand({ serviceArn })
                )).service;
                const active = currentConfig(observed);
                const activeEnv = active?.primaryContainer?.environment || [];
                const markerValue = (name) => activeEnv.find((item) => item.name === name)?.value;
                if (observed?.status?.statusCode === 'ACTIVE'
                  && active?.primaryContainer?.image === exactImage
                  && markerValue('HYPERVIBE_DEPLOY_SHA') === sha
                  && markerValue('HYPERVIBE_IMAGE_DIGEST') === digest) {
                  endpoint = active.ingressPaths?.find((item) => item.accessType === 'PUBLIC')?.endpoint
                    || active.ingressPaths?.[0]?.endpoint;
                  break;
                }
                if (attempt < 120) await sleep(5000);
              }
              if (!endpoint) {
                throw new Error('ECS Express did not verify the exact digest for ' + serviceArn);
              }
              const url = new URL(healthPath, endpoint.startsWith('http') ? endpoint : 'https://' + endpoint);
              const response = await fetch(url, { redirect: 'follow' });
              if (!response.ok) {
                throw new Error('ECS Express health check failed with HTTP ' + response.status);
              }
            }
`,
  };
}
