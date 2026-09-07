import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { formatFlyOrganizationBinding, formatFlyServiceBinding } from '../fly.binding.js';
import { buildFlyGitHubActionsSteps } from '../fly-ci.workflow.js';
import { buildFlyPortableRecipe } from '../fly-ci.recipe.js';
import '../fly.adapter.js';

function target(): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web'],
    providerProjectId: formatFlyOrganizationBinding('hypervibe-test'),
    providerEnvironmentId: 'env-1',
    providerRegion: 'yyz',
    providerServiceIds: [formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-web-app',
      machineId: 'machine-1',
    })],
    providerImageUris: [],
    containerStartCommand: 'node server.mjs',
    runtime: { kind: 'node', version: '24' },
  };
}

describe('Fly.io exact-SHA workflow', () => {
  it('updates only existing exact App and Machine identities to an immutable digest', () => {
    const result = buildFlyGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(['FLY_API_TOKEN']);
    expect(result.requiredVariables).toEqual([]);
    expect(result.releaseImageUri).toContain(
      'registry.fly.io/hv-web-app@${{ steps.fly_build.outputs.digest }}'
    );
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('registry.fly.io/hv-web-app:${{ steps.deploy.outputs.sha }}');
    expect(result.steps).toContain('current_version: machine.instance_id');
    expect(result.steps).toContain("const image = 'registry.fly.io/' + registryApp + '@' + digest");
    expect(result.steps).toContain('machines.length !== 1 || exact.length !== 1');
    expect(result.steps).toContain('hypervibe_git_sha: sha');
    expect(result.steps).toContain("observedDigest !== digest");
    expect(result.steps).not.toContain("'POST',\n                '/v1/apps',");
    expect(result.reviewDetails?.join(' ')).toContain('CI never creates infrastructure');
  });

  it('rejects service bindings outside the reviewed organization', () => {
    const invalid = target();
    invalid.providerServiceIds = [formatFlyServiceBinding({
      organizationSlug: 'other-org',
      appId: 'fly-app-2',
      appName: 'other-app',
      machineId: 'machine-2',
    })];

    expect(() => buildFlyGitHubActionsSteps(invalid)).toThrow(
      /does not belong to the target organization/i
    );
  });

  it('rejects an App binding without the reviewed Machine identity', () => {
    const invalid = target();
    invalid.providerServiceIds = [formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-web-app',
    })];

    expect(() => buildFlyGitHubActionsSteps(invalid)).toThrow(
      /missing a reviewed Machine identity/i
    );
  });

  it('builds the same exact-identity deployment contract for portable CI runners', () => {
    const recipe = buildFlyPortableRecipe(target());

    expect(recipe).toMatchObject({
      version: 1,
      provider: 'fly',
      kind: 'container',
      runnerCapabilities: ['linux-amd64', 'docker-privileged'],
      runtime: { path: '.gitlab/hypervibe/fly-deploy.mjs' },
    });
    expect(recipe.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'FLY_API_TOKEN',
        source: { kind: 'connection', provider: 'fly', credentialKey: 'apiToken' },
        secret: true,
      }),
      expect.objectContaining({
        name: 'FLY_ORGANIZATION_SLUG',
        source: { kind: 'literal', value: 'hypervibe-test' },
      }),
      expect.objectContaining({
        name: 'FLY_REGISTRY_APP',
        source: { kind: 'literal', value: 'hv-web-app' },
      }),
    ]));
    expect(recipe.runtime.content).toContain("current_version: machine.instance_id");
    expect(recipe.runtime.content).toContain("const image = prefix + digest");
    expect(recipe.runtime.content).toContain('machines.length !== 1 || exact.length !== 1');
    expect(recipe.runtime.content).toContain("provider: 'fly'");
    expect(recipe.runtime.content).not.toContain("fly('POST', '/v1/apps'");
  });

  it('registers hosting and derived Managed Postgres capabilities from one connection', () => {
    const metadata = providerRegistry.getMetadata('fly');
    expect(metadata).toMatchObject({
      displayName: 'Fly.io',
      category: 'deployment',
      lifecycle: {
        hosting: {
          workloadKinds: ['web', 'worker'],
          customDomains: 'managed',
          maintenance: 'unsupported',
          teardownBoundary: 'services',
        },
        databaseEngines: ['postgres'],
      },
      orchestration: {
        ci: {
          requiredSecrets: ['FLY_API_TOKEN'],
          buildPortableRecipe: expect.any(Function),
        },
      },
    });
    expect(providerRegistry.supports('fly', 'hosting')).toBe(true);
    expect(providerRegistry.supportsEngine('fly', 'database', 'postgres')).toBe(true);
  });
});
