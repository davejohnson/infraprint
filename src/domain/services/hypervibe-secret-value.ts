import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { HypervibeSecretSpec, ProjectSpec } from '../spec/spec.schema.js';

const RANDOM_SECRET_DOMAIN = 'hypervibe.managed-secret.random-base64url-32-v1';

function deriveMaterial(
  domain: string,
  projectName: string,
  environmentName: string,
  key: string,
  generation: number
): Buffer {
  return getSecretStore().deriveSecret(domain, {
    environment: environmentName,
    generation: String(generation),
    key,
    project: projectName,
  });
}

/**
 * Produce the provider-ready value for a Hypervibe-owned secret slot. Secret
 * material exists outside SecretStore only long enough to encode the declared
 * stable format and is never logged or included in errors.
 */
export function deriveHypervibeSecretValue(
  projectName: string,
  environmentName: string,
  key: string,
  spec: HypervibeSecretSpec
): string {
  const material = deriveMaterial(
    RANDOM_SECRET_DOMAIN,
    projectName,
    environmentName,
    key,
    spec.generation
  );
  try {
    return material.toString('base64url');
  } finally {
    material.fill(0);
  }
}

/** Derive only the Hypervibe-owned runtime values applicable to one environment. */
export function deriveHypervibeSecretValues(
  spec: ProjectSpec,
  environmentName: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spec.secrets)
      .filter((entry): entry is [string, HypervibeSecretSpec] => (
        entry[1].ownership === 'hypervibe'
        && entry[1].environments.includes(environmentName)
      ))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, secret]) => [
        key,
        deriveHypervibeSecretValue(spec.project, environmentName, key, secret),
      ])
  );
}
