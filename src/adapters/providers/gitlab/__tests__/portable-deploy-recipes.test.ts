import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../../domain/ports/ci-deploy.port.js';
import { buildEcsExpressPortableRecipe } from '../../aws/ecs-express-ci.recipe.js';
import { buildAzureContainerAppsPortableRecipe } from '../../azure/azure-container-apps-ci.recipe.js';
import { buildDigitalOceanPortableRecipe } from '../../digitalocean/digitalocean-ci.recipe.js';
import { buildCloudRunPortableRecipe } from '../../gcp/cloudrun-ci.recipe.js';
import { buildRailwayPortableRecipe } from '../../railway/railway-ci.recipe.js';
import { buildVercelPortableRecipe } from '../../vercel/vercel-ci.recipe.js';

function target(overrides: Partial<BranchDeployTarget> = {}): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web'],
    providerServiceIds: ['service-1'],
    providerJobNames: [],
    runtime: { kind: 'node', version: '22' },
    ...overrides,
  };
}

function expectSafeRecipe(recipe: PortableCiDeployRecipe): void {
  expect(recipe.version).toBe(1);
  expect(recipe.runtime.path).toMatch(/^\.gitlab\/hypervibe\//);
  expect(new Set(recipe.values.map((value) => value.name)).size).toBe(recipe.values.length);
  expect(recipe.values.every((value) => /^[A-Z][A-Z0-9_]+$/.test(value.name))).toBe(true);
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check', '-'], {
    input: recipe.runtime.content,
    encoding: 'utf8',
  });
  expect(checked.status, checked.stderr).toBe(0);
  expect(recipe.runtime.content).not.toContain('gh ');
  expect(recipe.runtime.content).not.toContain('gcloud ');
  expect(recipe.runtime.content).not.toContain('az ');
  expect(recipe.runtime.content).not.toContain('doctl ');
  expect(recipe.runtime.content).not.toContain('railway ');
}

describe('provider-neutral GitLab deploy recipes', () => {
  it('renders provider-owned runtimes for every non-native hosting adapter', () => {
    const recipes = [
      buildRailwayPortableRecipe(target({ providerEnvironmentId: 'env-1' })),
      buildCloudRunPortableRecipe(target({ providerProjectId: 'gcp-project', providerRegion: 'us-central1', providerServiceIds: ['web-service'] })),
      buildEcsExpressPortableRecipe(target({
        providerProjectId: 'arn:aws:ecs:us-east-1:123456789012:cluster/hv-prod',
        providerServiceIds: ['arn:aws:ecs:us-east-1:123456789012:service/hv-prod/web'],
      })),
      buildAzureContainerAppsPortableRecipe(target({
        providerProjectId: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod',
        providerServiceIds: ['/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod/providers/Microsoft.App/containerApps/web'],
      })),
      buildDigitalOceanPortableRecipe(target({
        providerProjectId: 'app-1',
        providerServiceIds: ['app-1:services:web'],
        providerImageUris: ['registry.digitalocean.com/hypervibe-account/acme/storefront:pending'],
      })),
      buildVercelPortableRecipe(target({
        providerProjectId: 'team:team_123',
        providerServiceIds: ['team:team_123:prj_123'],
      })),
    ];
    expect(recipes.map((recipe) => recipe.provider)).toEqual([
      'railway',
      'cloudrun',
      'ecs',
      'azure-container-apps',
      'digitalocean',
      'vercel',
    ]);
    for (const recipe of recipes) expectSafeRecipe(recipe);
    expect(recipes[2]!.runtime.content).toContain('networkConfiguration: config.networkConfiguration');
    expect(recipes[2]!.runtime.content).toContain('workload-network configuration is missing or malformed');
  });

  it('keeps cloud service-account JSON encoded across the GitLab variable boundary', () => {
    const recipe = buildCloudRunPortableRecipe(target({ providerProjectId: 'gcp-project', providerRegion: 'us-central1', providerServiceIds: ['web-service'] }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'GCP_SERVICE_ACCOUNT_JSON_B64',
      secret: true,
      transform: 'base64',
    }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'GCP_BOUND_PROJECT_ID',
      source: { kind: 'literal', value: 'gcp-project' },
    }));
  });

  it('deploys digest-pinned images where the hosting API supports exact digests', () => {
    const cloudRun = buildCloudRunPortableRecipe(target({ providerProjectId: 'gcp-project', providerRegion: 'us-central1', providerServiceIds: ['web-service'] }));
    const azure = buildAzureContainerAppsPortableRecipe(target({
      providerProjectId: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod',
      providerServiceIds: ['/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod/providers/Microsoft.App/containerApps/web'],
    }));
    for (const recipe of [cloudRun, azure]) {
      expect(recipe.runtime.content).toContain("'@' + digest");
      expect(recipe.runtime.content).toContain('sha256:[0-9a-f]{64}');
    }
  });

  it('refuses to guess a missing Cloud Run region from another binding', () => {
    expect(() => buildCloudRunPortableRecipe(target({
      providerProjectId: 'gcp-project',
      providerEnvironmentId: 'not-a-region',
      providerServiceIds: ['web-service'],
    }))).toThrow('bindings for production are incomplete');
  });

  it('refuses to choose a DigitalOcean registry that is absent from hosting bindings', () => {
    expect(() => buildDigitalOceanPortableRecipe(target({
      providerProjectId: 'app-1',
      providerServiceIds: ['app-1:services:web'],
    }))).toThrow('exact DOCR registry');
  });
});
