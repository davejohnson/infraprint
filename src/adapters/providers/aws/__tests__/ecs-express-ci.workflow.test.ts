import { describe, expect, it } from 'vitest';
import {
  buildEcsExpressGitHubActionsSteps,
  ECS_EXPRESS_CI_REQUIRED_SECRETS,
} from '../ecs-express-ci.workflow.js';

describe('ECS Express managed CI workflow', () => {
  it('uses only the connection credentials and already-bound resource ARNs', () => {
    const result = buildEcsExpressGitHubActionsSteps({
      environmentName: 'production',
      kind: 'production',
      branch: 'main',
      autoDeployOnPush: false,
      serviceNames: ['web'],
      providerProjectId: 'arn:aws:ecs:us-west-2:123456789012:cluster/hv-app-production-a1b2c3d4e5',
      providerServiceIds: [
        'arn:aws:ecs:us-west-2:123456789012:service/hv-app-production-a1b2c3d4e5/hv-web-a1b2c3d4e5',
      ],
      containerStartCommand: 'node server.mjs',
    });

    expect(result.requiredSecrets).toEqual(ECS_EXPRESS_CI_REQUIRED_SECRETS);
    expect(result.requiredVariables).toEqual([]);
    expect(result.steps).toContain("'hypervibe/' + cluster.toLowerCase()");
    expect(result.steps).toContain('UpdateExpressGatewayServiceCommand');
    expect(result.steps).toContain('networkConfiguration: config.networkConfiguration');
    expect(result.steps).toContain('workload-network configuration is missing or malformed');
    expect(result.steps).toContain('IMAGE_DIGEST');
    expect(result.steps).not.toMatch(/CreateExpressGatewayServiceCommand|CreateClusterCommand|CreateRepositoryCommand|CreateRoleCommand/);
    expect(result.steps).not.toContain('aws ecs');
  });

  it('requires explicit variables when no applied binding is compiled', () => {
    const result = buildEcsExpressGitHubActionsSteps({
      environmentName: 'staging',
      kind: 'staging',
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web'],
      providerServiceIds: [],
    });
    expect(result.requiredVariables).toEqual([
      'AWS_ECS_CLUSTER_ARN',
      'AWS_ECS_EXPRESS_SERVICE_ARNS_JSON',
    ]);
  });
});
