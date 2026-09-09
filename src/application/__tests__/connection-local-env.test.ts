import '../providers.js';
import { describe, expect, it } from 'vitest';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { isProviderOnlyDeployEnvKey } from '../../domain/services/deploy-env-file.js';
import {
  connectionLocalEnvInputs,
  connectionRecoveryDetails,
  connectionRecoveryHint,
  splitActionScopedConnectionBlocks,
} from '../apply-plan.js';

describe('connection local env inputs', () => {
  it('keeps every provider-declared local credential out of deploy env files', () => {
    const declared = providerRegistry.all().flatMap((provider) =>
      (provider.metadata.credentials?.localEnvInputs ?? []).map((input) => ({
        provider: provider.metadata.name,
        envKey: input.envKey,
      }))
    );

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((input) => !isProviderOnlyDeployEnvKey(input.envKey))).toEqual([]);
  });

  it('selects only slots matching the exact missing provider credential roles', () => {
    expect(connectionLocalEnvInputs([{
      provider: 'github',
      requiredCredentialKeys: ['apiToken'],
    }]).map((input) => input.envKey)).toEqual([
      'HYPERVIBE_GITHUB_TOKEN',
    ]);

    expect(connectionLocalEnvInputs([{
      provider: 'github',
      requiredCredentialKeys: ['packageReadToken'],
    }]).map((input) => input.envKey)).toEqual([
      'NODE_AUTH_TOKEN',
    ]);

    expect(connectionLocalEnvInputs([{
      provider: 'railway',
      requiredCredentialKeys: ['apiToken'],
    }]).map((input) => input.envKey)).toEqual([
      'HYPERVIBE_RAILWAY_TOKEN',
    ]);

    expect(connectionLocalEnvInputs([{
      provider: 'cloudflare',
      requiredCredentialKeys: ['registrarApiToken'],
    }]).map((input) => input.envKey)).toEqual([
      'CLOUDFLARE_REGISTRAR_API_TOKEN',
    ]);
  });

  it('exposes safe role-specific slots and connect commands in recovery details', () => {
    const [setup] = connectionRecoveryDetails([{
      provider: 'github',
      scope: 'owner/repository',
      requiredCredentialKeys: ['apiToken', 'packageReadToken'],
    }], { project: 'example' }).connectionSetup;

    expect(setup.localEnvInputs?.map((input) => input.envKey)).toEqual([
      'HYPERVIBE_GITHUB_TOKEN',
      'NODE_AUTH_TOKEN',
    ]);
    expect(setup.credentialExample).toContain(
      'credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"NODE_AUTH_TOKEN"}'
    );
    for (const envKey of ['HYPERVIBE_GITHUB_TOKEN', 'NODE_AUTH_TOKEN']) {
      expect(setup.credentialExample).toContain(envKey);
      expect(setup.localEnvInputs?.some((input) => input.envKey === envKey)).toBe(true);
    }
  });

  it('requires both saved GitHub roles when a CI image pull is missing', () => {
    const { actionScopedBlocked } = splitActionScopedConnectionBlocks([], [{
      id: 'ci:deploy',
      type: 'update',
      resource: { kind: 'ci', name: 'deploy', provider: 'github' },
      verified: true,
      reason: 'CI image credential is missing',
      metadata: {
        operation: 'githubActionsDeployBranch',
        missingProviderSecrets: ['IMAGE_REGISTRY_TOKEN'],
      },
    }]);

    expect(actionScopedBlocked).toContainEqual(expect.objectContaining({
      provider: 'github',
      requiredCredentialKeys: ['apiToken', 'packageReadToken'],
    }));
    expect(connectionLocalEnvInputs(actionScopedBlocked).map((input) => input.envKey)).toEqual([
      'HYPERVIBE_GITHUB_TOKEN',
      'NODE_AUTH_TOKEN',
    ]);
  });

  it('builds an executable value-free Cloudflare Registrar replacement command', () => {
    const [setup] = connectionRecoveryDetails([{
      provider: 'cloudflare',
      scope: 'example.com',
      requiredCredentialKeys: ['apiToken', 'accountId', 'registrarApiToken'],
    }], { project: 'example' }).connectionSetup;

    expect(setup.localEnvInputs?.map((input) => input.envKey)).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_REGISTRAR_API_TOKEN',
    ]);
    expect(setup.credentialExample).toBe(
      'hv_connections project="example" provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID","registrarApiToken":"CLOUDFLARE_REGISTRAR_API_TOKEN"}'
    );
  });

  it('uses structured credential roles rather than failure prose for package guidance', () => {
    const misleadingReason = connectionRecoveryHint([{
      provider: 'github',
      requiredCredentialKeys: ['apiToken'],
      reason: 'GHCR and IMAGE_REGISTRY_TOKEN appear in provider prose',
    }]);
    const packageRole = connectionRecoveryHint([{
      provider: 'github',
      requiredCredentialKeys: ['packageReadToken'],
      reason: 'Repository connection needs another credential',
    }]);

    expect(misleadingReason).not.toContain('For GitHub Actions image deploys');
    expect(packageRole).toContain('For GitHub Actions image deploys');
  });
});
