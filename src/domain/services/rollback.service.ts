import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { devOpsProviderRegistry } from '../registry/devops.registry.js';
import { resolveDevOpsSelection } from '../spec/devops-selection.js';
import { SpecStore } from '../spec/spec.store.js';
import {
  executeManagedCiRollback,
  type CiRollbackFailure,
  type CiRollbackResult,
} from './ci-rollback.service.js';

export const DIRECT_PROVIDER_ROLLBACK_UNSUPPORTED =
  'Direct-provider deploy runs do not retain verified immutable source, image, or provider-release evidence. Hypervibe cannot prove that a historical run can be restored, so it refuses to redeploy the current spec or checkout and call that a rollback.';

/**
 * Execute an evidence-bound managed-CI rollback.
 *
 * Direct-provider deploy history records operational receipts, not an
 * immutable release identity that every hosting adapter can restore. Until a
 * provider-neutral release-evidence port exists for that path, it must fail
 * before adapter resolution or plan creation. In particular, a historical
 * `toRunId` is never authority to deploy the current checkout.
 */
export async function executeRollback(params: {
  project: Project;
  environment: Environment;
  /** Legacy compatibility selector. Direct-provider rollback fails closed. */
  toRunId?: string;
  toSha?: string;
  /** Managed rollback is release-wide; direct-provider rollback is unsupported. */
  services?: string[];
}): Promise<CiRollbackFailure | CiRollbackResult> {
  const { project, environment } = params;
  const storedSpec = new SpecStore().get(project)?.spec;
  const environmentSpec = storedSpec?.environments[environment.name];
  const usesManagedCi = environmentSpec?.deploy?.strategy === 'branch'
    && (environmentSpec.deploy.trigger ?? 'ci') === 'ci';

  if (!usesManagedCi) {
    return {
      ok: false,
      reason: 'unsupported',
      provider: project.defaultPlatform,
      error: DIRECT_PROVIDER_ROLLBACK_UNSUPPORTED,
      hint: 'Use hv_deploy only when you intend to deploy the current desired state. Future rollbacks require managed CI release evidence or a provider adapter that persists and re-verifies an exact immutable release identity.',
    };
  }

  if (params.toRunId) {
    return {
      ok: false,
      reason: 'invalid_target',
      error: 'toRunId cannot identify a managed-CI release. Use an exact previously verified toSha, or omit it to select the previous verified release.',
    };
  }
  if (params.services?.length) {
    return {
      ok: false,
      reason: 'invalid_target',
      error: 'Managed CI rollback restores the complete verified release; per-service rollback is not supported.',
    };
  }

  const ciProvider = storedSpec ? resolveDevOpsSelection(storedSpec)?.ci?.provider : undefined;
  if (ciProvider !== 'github-actions') {
    const rollback = ciProvider
      ? devOpsProviderRegistry.ciProvider(ciProvider)?.rollback
      : undefined;
    if (rollback) {
      return rollback({ project, environment, toSha: params.toSha });
    }
    return {
      ok: false,
      reason: 'unsupported',
      error: `Managed rollback is not implemented for ${ciProvider ?? 'the selected CI provider'} yet. Inspect the exact release with hv_ci_status; Hypervibe will not dispatch an unverified rollback through a GitHub-specific path.`,
    };
  }

  return executeManagedCiRollback({ project, environment, toSha: params.toSha });
}
