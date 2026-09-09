import type { Environment } from '../entities/environment.entity.js';
import type { Run } from '../entities/run.entity.js';

export interface ManagedSecretBindingRunLookup {
  findById(id: string): Run | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A repository-exported binding can legitimately name an apply run that does
 * not exist on this machine. When the run does exist locally, however, its
 * exact action receipt is the acceptance boundary. SQLite is written before
 * the sanitized repository export, so a failed export can leave provisional
 * binding metadata behind even though the action itself failed.
 */
export function withReceiptValidatedManagedSecretBindings<
  T extends Pick<Environment, 'id' | 'projectId' | 'platformBindings'>,
>(environment: T | null, runs: ManagedSecretBindingRunLookup): T | null {
  if (!environment) return null;
  const rawBindings = environment.platformBindings.delegatedEnvBindings;
  if (!Array.isArray(rawBindings)) return environment;

  let removed = false;
  const accepted = rawBindings.filter((value) => {
    const binding = asRecord(value);
    if (!binding) return true;
    const applyRunId = nonEmptyString(binding, 'applyRunId');
    const actionId = nonEmptyString(binding, 'actionId');
    if (!applyRunId || !actionId) return true;

    const run = runs.findById(applyRunId);
    if (!run) return true;
    const hasAcceptedReceipt = run.type === 'apply'
      && run.projectId === environment.projectId
      && run.environmentId === environment.id
      && run.receipts.some((receipt) => receipt.step === actionId && receipt.status === 'success');
    if (!hasAcceptedReceipt) removed = true;
    return hasAcceptedReceipt;
  });

  if (!removed) return environment;
  return {
    ...environment,
    platformBindings: {
      ...environment.platformBindings,
      delegatedEnvBindings: accepted,
    },
  };
}
