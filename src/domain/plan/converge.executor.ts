import { createHash } from 'crypto';
import { z } from 'zod';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import type { Run, RunReceipt } from '../entities/run.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from './plan.types.js';

/**
 * Converge executor: applies a previously persisted plan (terraform
 * `plan -out` style). hv_plan stores its actions as a run of type 'plan';
 * hv_apply hands the planId here, and we reject stale plans instead of
 * applying against a world that has moved.
 */

const planActionSchema: z.ZodType<PlanAction> = z.object({
  id: z.string().min(1),
  type: z.enum(['create', 'update', 'replace', 'destroy', 'noop']),
  resource: z.object({
    kind: z.enum(['project', 'environment', 'service', 'database', 'cache', 'storage', 'retained-resource', 'load-balancer', 'domain', 'email', 'messaging', 'ci', 'repo', 'ios', 'queue', 'secret', 'payment', 'maintenance']),
    name: z.string().min(1),
    provider: z.string().min(1),
  }),
  verified: z.boolean(),
  reason: z.string(),
  diff: z.array(z.object({ field: z.string().min(1), from: z.string().optional(), to: z.string().optional() })).optional(),
  dataBearing: z.boolean().optional(),
  billable: z.boolean().optional(),
  requiresConfirm: z.boolean().optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough().superRefine((action, ctx) => {
  const billableDataResource = ['database', 'cache', 'storage'].includes(action.resource.kind);
  const destructiveDataResource = ['database', 'cache', 'storage'].includes(action.resource.kind)
    || (
      action.resource.kind === 'queue'
      && action.metadata?.operation === 'queueDestroy'
      && action.metadata?.backend === 'pubsub'
    );
  if (billableDataResource && action.type === 'create' && action.billable !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['billable'],
      message: `${action.resource.kind} creation must be marked billable`,
    });
  }
  if (
    destructiveDataResource
    && action.type === 'destroy'
    && (action.dataBearing !== true || action.requiresConfirm !== true)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['requiresConfirm'],
      message: `${action.resource.kind} destruction must be marked data-bearing and confirmation-gated`,
    });
  }
  if (
    action.resource.kind === 'domain'
    && action.type === 'create'
    && action.metadata?.operation === 'cloudflareRegistrarRegistration'
    && (action.billable !== true || action.requiresConfirm !== true)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['requiresConfirm'],
      message: 'domain registration must be marked billable and confirmation-gated',
    });
  }
  if (
    action.resource.kind === 'maintenance'
    && action.type === 'update'
    && action.metadata?.operation === 'maintenanceEdgeEnable'
    && (action.billable !== true || action.requiresConfirm !== true)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['requiresConfirm'],
      message: 'maintenance edge enablement must be marked billable and confirmation-gated',
    });
  }
  if (
    action.resource.kind === 'load-balancer'
    && action.metadata?.operation === 'loadBalancerPoolEnsure'
    && !action.metadata?.blockedReason
    && ['create', 'update'].includes(action.type)
    && action.billable !== true
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['billable'],
      message: 'load-balancer pool mutation must be marked billable',
    });
  }
  if (
    action.resource.kind === 'load-balancer'
    && action.metadata?.operation === 'loadBalancerEnsure'
    && action.type === 'create'
    && action.billable !== true
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['billable'],
      message: 'load-balancer creation must be marked billable',
    });
  }
  if (
    action.resource.kind === 'repo'
    && action.type === 'update'
    && action.metadata?.operation === 'githubCodeScanning'
    && action.metadata?.privateRepository !== false
    && (action.billable !== true || action.requiresConfirm !== true)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['requiresConfirm'],
      message: 'private-repository code scanning must be marked billable and confirmation-gated',
    });
  }
  if (
    action.resource.kind === 'repo'
    && action.type === 'update'
    && action.metadata?.operation === 'githubInfrastructurePullRequest'
    && Array.isArray(action.metadata?.desiredFiles)
    && action.metadata.desiredFiles.some((file) => (
      file
      && typeof file === 'object'
      && !Array.isArray(file)
      && typeof (file as Record<string, unknown>).path === 'string'
      && ((file as Record<string, unknown>).path as string).includes('restore-drill')
    ))
    && action.billable !== true
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['billable'],
      message: 'restore-drill infrastructure mutation must be marked billable',
    });
  }
});

/** Runtime-validated document stored in runs.plan for type 'plan' runs. */
export const planRunDocumentSchema = z.object({
  kind: z.literal('hv_plan'),
  /** Omitted by plans created before scoped planning; those remain full plans. */
  scope: z.enum(['full', 'retained-cleanup']).optional(),
  environmentName: z.string().min(1),
  specRevision: z.number().int().nonnegative(),
  observedFingerprint: z.string().nullable(),
  integrationFingerprints: z.record(z.string()).optional(),
  lockEnvironmentIds: z.array(z.string().min(1)).optional(),
  actions: z.array(planActionSchema),
  unmanaged: z.array(z.object({ kind: z.string(), name: z.string(), detail: z.string().optional() })).optional(),
  warnings: z.array(z.string()).optional(),
  inputRequired: z.array(z.object({ key: z.string(), principal: z.string(), reason: z.string() })).optional(),
  overrides: z.object({
    services: z.array(z.string()).optional(),
    envFilePath: z.string().optional(),
    envFileKeys: z.array(z.string()).optional(),
    envFileVarsEncrypted: z.string().optional(),
    envVarKeys: z.array(z.string()).optional(),
    envVarsEncrypted: z.string().optional(),
    delegatedSecretKeys: z.array(z.string()).optional(),
    delegatedSecretVarsEncrypted: z.string().optional(),
  }).passthrough().optional(),
}).passthrough().superRefine((document, ctx) => {
  if (document.scope !== 'retained-cleanup') return;

  const invalidAction = document.actions.find((action) =>
    action.type !== 'destroy'
    || !['previousHostingDestroy', 'retainedDatabaseDestroy', 'retainedCacheDestroy', 'retainedResourceDestroy'].includes(String(action.metadata?.operation ?? ''))
  );
  if (invalidAction) {
    ctx.addIssue({
      code: 'custom',
      path: ['actions'],
      message: `retained-cleanup plan contains unrelated action ${invalidAction.id}`,
    });
  }
  if (
    document.integrationFingerprints
    || document.overrides
    || document.inputRequired?.length
    || document.lockEnvironmentIds?.length
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'retained-cleanup plan contains unrelated integration, deploy-input, or environment-lock state',
    });
  }
});

export type PlanRunDocument = z.infer<typeof planRunDocumentSchema>;

export interface ActionResult {
  success: boolean;
  status?: 'pending' | 'blocked';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface ActionExecutionContext {
  /** Durable id of the apply run that will receive this action's receipt. */
  applyRunId: string;
}

export type ActionHandler = (
  action: PlanAction,
  context: ActionExecutionContext
) => Promise<ActionResult>;

export interface ConvergeParams {
  planRunId: string;
  /** Action ids (requiresConfirm) the caller explicitly confirmed. */
  confirmActions?: string[];
  /** Latest spec revision for the project (from SpecStore). */
  currentSpecRevision: number;
  /**
   * Fingerprint of a fresh observation taken just before apply.
   * Pass null when the provider is unobservable; undefined skips the check.
   */
  freshObservedFingerprint?: string | null;
  /** Fresh hash-only integration observations used in the same stale-plan gate. */
  freshIntegrationFingerprints?: Record<string, string>;
  /** Executes a single non-noop action. */
  handler: ActionHandler;
  /** Maximum plan age before it must be regenerated. Default 24h. */
  maxPlanAgeMs?: number;
}

export type ActionReceiptStatus =
  | 'succeeded'
  | 'failed'
  | 'pending'
  | 'blocked'
  | 'skipped_noop'
  | 'skipped_requires_confirm'
  | 'aborted';

export interface ActionReceipt {
  actionId: string;
  status: ActionReceiptStatus;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface ConvergeResult {
  success: boolean;
  applyRunId?: string;
  error?: string;
  conflict?: {
    kind: 'already_applied' | 'plan_in_progress' | 'environment_in_progress';
    runId: string;
  };
  receipts: ActionReceipt[];
}

const DEFAULT_MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Stable fingerprint of observed state, ignoring volatile fields
 * (observedAt, warnings) so two observations of an unchanged world match.
 */
export function fingerprintObservedState(observed: ObservedState): string {
  const essence = {
    provider: observed.provider,
    projectExists: observed.projectExists,
    projectId: observed.projectId ?? null,
    environmentId: observed.environmentId ?? null,
    services: [...observed.services]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        externalId: s.externalId,
        status: s.status,
        url: s.url ?? null,
        workloadKind: s.workloadKind,
        customDomains: [...s.customDomains].sort(),
        customDomainStatus: Object.fromEntries(
          Object.entries(s.customDomainStatus ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([domain, status]) => [domain, {
              providerDomainId: status.providerDomainId ?? null,
              providerVerified: status.providerVerified ?? null,
              certificateStatus: status.certificateStatus ?? null,
              dnsConfigured: status.dnsConfigured ?? null,
              dnsRecords: [...(status.dnsRecords ?? [])]
                .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            }])
        ),
        config: s.config,
        source: s.source ?? null,
        sourceState: s.sourceState ?? null,
        envVarKeys: [...s.envVarKeys].sort(),
        envVarHashes: Object.fromEntries(Object.entries(s.envVarHashes).sort(([a], [b]) => a.localeCompare(b))),
        deployment: s.deployment ?? null,
        maintenance: s.maintenance ?? null,
      })),
    databases: [...observed.databases]
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((d) => ({
        provider: d.provider,
        engine: d.engine,
        externalId: d.externalId,
        status: d.status,
        providerScope: d.providerScope
          ? Object.fromEntries(Object.entries(d.providerScope).sort(([a], [b]) => a.localeCompare(b)))
          : null,
      })),
    caches: [...(observed.caches ?? [])]
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((cache) => ({
        provider: cache.provider,
        engine: cache.engine,
        externalId: cache.externalId,
        status: cache.status,
        providerScope: cache.providerScope
          ? Object.fromEntries(Object.entries(cache.providerScope).sort(([a], [b]) => a.localeCompare(b)))
          : null,
        config: cache.config
          ? Object.fromEntries(Object.entries(cache.config).sort(([a], [b]) => a.localeCompare(b)))
          : null,
      })),
    storage: [...(observed.storage ?? [])]
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((item) => ({
        provider: item.provider,
        kind: item.kind,
        externalId: item.externalId,
        instanceScope: item.instanceScope
          ? Object.fromEntries(Object.entries(item.instanceScope).sort(([a], [b]) => a.localeCompare(b)))
          : null,
        name: item.name,
        region: item.region ?? null,
        status: item.status,
        objectCount: item.objectCount ?? null,
        sizeBytes: item.sizeBytes ?? null,
      })),
    completeness: observed.completeness
      ? {
          ...observed.completeness,
          ...(observed.completeness.storageByProvider
            ? {
                storageByProvider: Object.fromEntries(
                  Object.entries(observed.completeness.storageByProvider)
                    .sort(([left], [right]) => left.localeCompare(right))
                ),
              }
            : {}),
        }
      : null,
    maintenance: observed.maintenance ?? null,
  };
  return createHash('sha256').update(JSON.stringify(essence), 'utf8').digest('hex');
}

/** Topological order by dependsOn; throws on cycles or unknown dependencies. */
export function orderActions(actions: PlanAction[]): PlanAction[] {
  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.id)) {
      throw new Error(`Duplicate plan action id "${action.id}"`);
    }
    seen.add(action.id);
  }
  const byId = new Map(actions.map((a) => [a.id, a]));
  const ordered: PlanAction[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (action: PlanAction) => {
    const mark = state.get(action.id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Error(`Dependency cycle involving "${action.id}"`);
    }
    state.set(action.id, 'visiting');
    for (const dep of action.dependsOn ?? []) {
      const target = byId.get(dep);
      if (!target) {
        throw new Error(
          `Unknown dependency "${dep}" referenced by action "${action.id}"`
        );
      }
      visit(target);
    }
    state.set(action.id, 'done');
    ordered.push(action);
  };

  for (const action of actions) visit(action);
  return ordered;
}

export class ConvergeExecutor {
  constructor(private runRepo = new RunRepository()) {}

  loadPlan(planRunId: string): { run: Run; document: PlanRunDocument } | { error: string } {
    const run = this.runRepo.findById(planRunId);
    if (!run) return { error: `Plan ${planRunId} not found. Run hv_plan first.` };
    const parsed = planRunDocumentSchema.safeParse(run.plan);
    if (run.type !== 'plan' || !parsed.success) {
      return { error: `Run ${planRunId} is not a valid persisted hv_plan. Re-run hv_plan.` };
    }
    return { run, document: parsed.data };
  }

  async execute(params: ConvergeParams): Promise<ConvergeResult> {
    const loaded = this.loadPlan(params.planRunId);
    if ('error' in loaded) {
      return { success: false, error: loaded.error, receipts: [] };
    }
    const { run: planRun, document } = loaded;

    // --- staleness checks (terraform plan -out handshake) ---
    const maxAge = params.maxPlanAgeMs ?? DEFAULT_MAX_PLAN_AGE_MS;
    if (Date.now() - planRun.createdAt.getTime() > maxAge) {
      return {
        success: false,
        error: `Plan ${params.planRunId} is older than ${Math.round(maxAge / 3600000)}h. Re-run hv_plan.`,
        receipts: [],
      };
    }
    if (document.specRevision !== params.currentSpecRevision) {
      return {
        success: false,
        error: `Spec has changed since this plan (plan revision ${document.specRevision}, current ${params.currentSpecRevision}). Re-run hv_plan.`,
        receipts: [],
      };
    }
    if (params.freshObservedFingerprint !== undefined
      && document.observedFingerprint !== null
      && params.freshObservedFingerprint !== null
      && params.freshObservedFingerprint !== document.observedFingerprint) {
      return {
        success: false,
        error: 'Live infrastructure changed since this plan was created. Re-run hv_plan.',
        receipts: [],
      };
    }
    if (document.integrationFingerprints) {
      const fresh = params.freshIntegrationFingerprints ?? {};
      const staleIntegration = Object.entries(document.integrationFingerprints)
        .find(([name, fingerprint]) => fresh[name] !== fingerprint);
      if (staleIntegration) {
        return {
          success: false,
          error: `${staleIntegration[0]} changed since this plan was created. Re-run hv_plan.`,
          receipts: [],
        };
      }
    }

    const confirmed = new Set(params.confirmActions ?? []);
    let ordered: PlanAction[];
    try {
      ordered = orderActions(document.actions);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), receipts: [] };
    }

    const reservation = this.runRepo.reserveApply({
      projectId: planRun.projectId,
      environmentId: planRun.environmentId,
      planRunId: params.planRunId,
      environmentName: document.environmentName,
      specRevision: document.specRevision,
      lockEnvironmentIds: document.lockEnvironmentIds,
    });
    if (!reservation.reserved) {
      const error = reservation.reason === 'already_applied'
        ? `Plan ${params.planRunId} was already applied (run ${reservation.conflictingRunId}). Re-run hv_plan.`
        : reservation.reason === 'plan_in_progress'
          ? `Plan ${params.planRunId} is already being applied (run ${reservation.conflictingRunId}). Wait for that apply to finish and inspect its receipts before retrying.`
          : `Environment ${document.environmentName} already has a running apply (run ${reservation.conflictingRunId}). Wait for it to finish and inspect its receipts before applying another plan.`;
      return {
        success: false,
        error,
        conflict: {
          kind: reservation.reason,
          runId: reservation.conflictingRunId,
        },
        receipts: [],
      };
    }
    const applyRun = reservation.run;

    const receipts: ActionReceipt[] = [];
    const unconfirmed = ordered.find((action) =>
      action.type !== 'noop'
      && (action.requiresConfirm === true || action.billable === true || action.dataBearing === true)
      && !confirmed.has(action.id)
    );
    if (unconfirmed) {
      const message = `Requires explicit confirmation: pass confirmActions: ["${unconfirmed.id}"]`;
      for (const action of ordered) {
        if (action.type === 'noop') {
          receipts.push({ actionId: action.id, status: 'skipped_noop' });
        } else if (action.id === unconfirmed.id) {
          receipts.push({ actionId: action.id, status: 'skipped_requires_confirm', message });
        } else {
          receipts.push({
            actionId: action.id,
            status: 'aborted',
            message: `Apply did not start because "${unconfirmed.id}" requires confirmation`,
          });
        }
      }
      this.runRepo.addReceipt(applyRun.id, {
        step: unconfirmed.id,
        status: 'blocked',
        result: { message },
        timestamp: new Date().toISOString(),
      } as RunReceipt);
      this.runRepo.updateStatus(applyRun.id, 'blocked', message);
      return { success: false, applyRunId: applyRun.id, receipts };
    }

    const completed = new Set<string>();
    let failed = false;
    let pending = false;
    let blocked = false;
    let firstError: string | undefined;

    for (const action of ordered) {
      if (failed || pending || blocked) {
        const state = failed ? 'failure' : pending ? 'pending result' : 'blocked result';
        receipts.push({ actionId: action.id, status: 'aborted', message: `Skipped after earlier ${state}` });
        continue;
      }
      if (action.type === 'noop') {
        receipts.push({ actionId: action.id, status: 'skipped_noop' });
        completed.add(action.id);
        continue;
      }
      // A dependency that was skipped (not completed) blocks dependents.
      const unmetDep = (action.dependsOn ?? []).find(
        (dep) => ordered.some((a) => a.id === dep) && !completed.has(dep)
      );
      if (unmetDep) {
        receipts.push({
          actionId: action.id,
          status: 'aborted',
          message: `Dependency "${unmetDep}" did not complete`,
        });
        continue;
      }

      const recordReceipt = (status: ActionReceiptStatus, message?: string, error?: string, data?: Record<string, unknown>) => {
        receipts.push({ actionId: action.id, status, message, error, data });
        this.runRepo.addReceipt(applyRun.id, {
          step: action.id,
          status: status === 'succeeded'
            ? 'success'
            : status === 'failed'
              ? 'failure'
              : status === 'pending'
                ? 'pending'
                : status === 'blocked'
                  ? 'blocked'
                  : 'skipped',
          error,
          result: message || data ? { ...(message ? { message } : {}), ...(data ?? {}) } : undefined,
          timestamp: new Date().toISOString(),
        } as RunReceipt);
      };

      try {
        const result = await params.handler(action, { applyRunId: applyRun.id });
        if (result.status === 'pending') {
          pending = true;
          recordReceipt('pending', result.message, result.error, result.data);
        } else if (result.status === 'blocked') {
          blocked = true;
          recordReceipt('blocked', result.message, result.error, result.data);
        } else if (result.success) {
          completed.add(action.id);
          recordReceipt('succeeded', result.message, undefined, result.data);
        } else {
          failed = true;
          firstError = result.error ?? result.message;
          recordReceipt('failed', result.message, result.error, result.data);
        }
      } catch (error) {
        failed = true;
        firstError = error instanceof Error ? error.message : String(error);
        recordReceipt('failed', undefined, firstError);
      }
    }

    const runStatus = failed ? 'failed' : blocked ? 'blocked' : pending ? 'pending' : 'succeeded';
    this.runRepo.updateStatus(applyRun.id, runStatus, firstError);
    return {
      success: !failed && !pending && !blocked,
      applyRunId: applyRun.id,
      ...(firstError ? { error: firstError } : {}),
      receipts,
    };
  }
}
