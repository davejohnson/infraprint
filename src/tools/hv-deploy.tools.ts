import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import { PlanService } from '../domain/plan/plan.service.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { requiresProductionConfirm } from '../domain/services/policy.service.js';
import { executeRollback } from '../domain/services/rollback.service.js';
import { CI_ROLLBACK_NOTE } from '../domain/services/ci-rollback.service.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { isProviderNativeDeploySourceAction } from '../domain/services/provider-native-deploy-source.service.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { CommandContext } from '../application/context.js';
import {
  connectionProviders,
  connectionRecoveryDetails,
  connectionRecoveryHint,
  executePlanApply,
} from '../application/apply-plan.js';
import { projectField, envField, confirmField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';
import { resolveDevOpsSelection } from '../domain/spec/devops-selection.js';
import { firstProviderSpecValidationFailure } from '../domain/services/provider-spec-validation.js';

function assertConfirmed(project: Project, environment: Environment, confirm: boolean | undefined, action: string): void {
  if (requiresProductionConfirm(project, environment.name) && !confirm) {
    throw new HvError(
      'CONFIRM_REQUIRED',
      `Environment "${environment.name}" is protected by project policy.`,
      { hint: `Re-run ${action} with confirm=true to proceed.` }
    );
  }
}

function defaultBranchForEnvironment(envName: string): string {
  return envName.toLowerCase().includes('prod') ? 'main' : 'staging';
}

function ciBranchDeployGuidance(project: Project, envName: string): {
  branch: string;
  ciProvider: string;
  providerName: string;
  legacyGitHubWorkflow?: string;
} | null {
  const specResult = new SpecStore().get(project);
  const envSpec = specResult?.spec.environments[envName];
  if (
    !envSpec
    || envSpec.deploy?.strategy !== 'branch'
    || (envSpec.deploy.trigger ?? 'ci') !== 'ci'
    || !providerRegistry.getMetadata(envSpec.hosting.provider)?.orchestration?.ci
  ) {
    return null;
  }

  const branch = envSpec.deploy.branch ?? defaultBranchForEnvironment(envName);
  const selection = resolveDevOpsSelection(specResult.spec);
  const ciProvider = selection?.ci?.provider;
  if (!ciProvider) return null;
  return {
    branch,
    ciProvider,
    providerName: ciProvider,
    ...(selection?.source === 'legacy-github'
      ? { legacyGitHubWorkflow: `deploy-${envSpec.hosting.provider}-${envName}.yml` }
      : {}),
  };
}

export function registerHvDeployTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_deploy',
    'Deploy services to an environment (staging, production, etc.). Plan-gated direct/manual deploys build and immediately apply a plan; managed-CI environments must dispatch only through hv_ci_trigger after selecting the reviewed definition with hv_ci_status, never through gh or a direct CI/provider API. The planId and applyRunId are returned for the audit trail. Hypervibe-owned application secrets are generated and installed automatically. Externally owned secret slots accept values only through secretRefs={KEY:"env:NAME"|"dotenv:/absolute/path/.env#KEY"|"file:/absolute/path"|"<manager>://..."}; values are resolved locally and encrypted into the plan. Ordinary envVars and env files cannot override managed keys. By default, .env.<env> then repo .env are considered as deploy input in envFile.mode="runtime". Requires a spec (hv_spec). Protected environments require confirm=true.',
    {
      project: projectField,
      env: envField,
      services: z.array(z.string()).optional().describe('Specific services to deploy (default: all)'),
      envVars: z.record(z.string()).optional().describe('Additional one-off environment variables; values are encrypted in the stored plan and win over .env and spec envVars.'),
      envFile: z.string().optional().describe('Local .env file to consider as deploy input. Defaults to .env.<env>, creating it from repo .env when missing and syncing newly added base keys when present. Selection follows spec envFile policy; values are encrypted in the stored plan and never returned.'),
      includeEnvFile: z.boolean().optional().describe('Set false to skip the default repo .env deploy input.'),
      secretRefs: z.record(z.string()).optional().describe('Chat-safe local/secret-manager references for delegated secret slots, keyed by declared env var name. Never pass raw secret values.'),
      confirm: confirmField,
    },
    wrapCommandHandler(async ({ project: projectRef, env, services, envVars, envFile, includeEnvFile, secretRefs, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      // Deploys are plan-gated: the spec is the source of truth for what runs.
      const specResult = new SpecStore().get(project);
      if (!specResult) {
        return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, {
          hint: 'Define one with hv_spec, or inspect existing provider infrastructure with hv_inspect and adopt it with hv_import, then hv_deploy.',
          next: ['hv_spec', 'hv_inspect', 'hv_import'],
        });
      }
      const providerValidation = firstProviderSpecValidationFailure(specResult.spec);
      if (providerValidation) {
        return commandError('VALIDATION', providerValidation.message, {
          hint: providerValidation.hint,
          details: providerValidation.details,
          next: ['hv_spec', 'hv_plan'],
        });
      }
      const envName = env?.trim() || 'staging';
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        return commandError('VALIDATION', `Spec has no environment "${envName}".`, {
          details: { available: Object.keys(specResult.spec.environments) },
          next: ['hv_spec'],
        });
      }
      if (Object.keys(envSpec.services).length === 0) {
        return commandError('NOT_FOUND', 'No services found to deploy.', {
          hint: 'Create services first (hv_spec) or check service names.',
        });
      }

      // Resolve environment, auto-creating it if missing (same as legacy deploy).
      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName)
        ?? ctx.repos.environments.create({ projectId: project.id, name: envName });

      assertConfirmed(project, environment, confirm, 'hv_deploy');

      const ciDeploy = ciBranchDeployGuidance(project, envName);
      if (ciDeploy) {
        return commandError(
          'VALIDATION',
          `Environment "${envName}" uses ${ciDeploy.providerName} managed branch deploys. hv_deploy does not build or push the image for this mode.`,
          {
            hint: ciDeploy.legacyGitHubWorkflow
              ? `Run hv_plan/hv_apply to sync ${ciDeploy.legacyGitHubWorkflow}, then push to ${ciDeploy.branch}; for a manual run use hv_ci_trigger workflow="${ciDeploy.legacyGitHubWorkflow}" ref="${ciDeploy.branch}". Check progress only with hv_ci_status, then hv_health. Never dispatch or monitor this workflow with gh or a direct GitHub API.`
              : `Run hv_plan/hv_apply to sync the reviewed CI configuration, then push to ${ciDeploy.branch}; for a manual run, list definitions with hv_ci_status and pass the selected id to hv_ci_trigger definition=<id> ref="${ciDeploy.branch}". Check progress only with hv_ci_status, then hv_health. Never dispatch or monitor this definition with a provider CLI or direct CI API.`,
            next: ['hv_plan', 'hv_apply', 'hv_ci_trigger', 'hv_ci_status'],
          }
        );
      }

      const planService = new PlanService();
      const planned = await planService.plan(project, envName, {
        ...(services?.length ? { serviceFilter: services } : {}),
        ...(envVars && Object.keys(envVars).length > 0 ? { envVarOverrides: envVars } : {}),
        ...(envFile ? { envFile } : {}),
        ...(includeEnvFile !== undefined ? { includeEnvFile } : {}),
        ...(secretRefs && Object.keys(secretRefs).length > 0 ? { secretRefs } : {}),
      });
      if ('error' in planned) {
        return commandError('VALIDATION', planned.error, { next: ['hv_spec'] });
      }
      const deploySourceStage = planned.actions.length > 0
        && planned.actions.every(isProviderNativeDeploySourceAction);

      const outcome = await executePlanApply(ctx, {
        project,
        spec: specResult.spec,
        specRevision: specResult.revision,
        planId: planned.planRunId,
        confirmActions: [],
        verifyHttpHealth: !deploySourceStage,
        alwaysRunBootstrap: !deploySourceStage,
      });
      if (outcome.kind === 'invalid_spec') {
        return commandError('VALIDATION', outcome.message, {
          hint: outcome.hint,
          details: outcome.details,
          next: ['hv_spec', 'hv_plan'],
        });
      }
      if (outcome.kind === 'plan_not_found' || outcome.kind === 'env_missing') {
        return commandError('INTERNAL', 'Deploy plan could not be applied immediately after planning.', {
          details: outcome,
        });
      }
      if (outcome.kind === 'input_required') {
        return commandError('VALIDATION', 'Deployment needs delegated secret inputs before it can apply.', {
          details: { environment: outcome.envName, inputRequired: outcome.requirements },
          hint: 'Use safe local secretRefs for values available on this Mac. Otherwise prepare a value-free handoff naming each delegated key, environment, and principal for the project owner. Do not paste raw secrets into chat.',
          next: ['hv_deploy'],
          agentInstruction: {
            action: 'ask_user',
            message: 'Stop before deploy. Use safe local secret references when available, or prepare a value-free owner handoff for the delegated-secret slots.',
          },
        });
      }
      if (outcome.kind === 'blocked') {
        return commandError('MISSING_CONNECTION', `Missing verified connections: ${connectionProviders(outcome.applyBlocked).join(', ')}.`, {
          details: {
            blocked: outcome.applyBlocked,
            ...connectionRecoveryDetails(outcome.applyBlocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl }),
          },
          hint: connectionRecoveryHint(outcome.applyBlocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl, after: 'Then re-run hv_deploy.' }),
          next: ['hv_connections', 'hv_deploy'],
        });
      }
      if (!outcome.result.success && !outcome.result.applyRunId) {
        const conflict = outcome.result.conflict;
        return commandError('VALIDATION', outcome.result.error ?? 'Deploy apply was rejected.', {
          ...(conflict ? { details: { applyConflict: conflict } } : {}),
          hint: conflict && conflict.kind !== 'already_applied'
            ? `Inspect apply run "${conflict.runId}" with hv_runs action="get". Do not start another deploy until that run is no longer running.`
            : 'Create and inspect a fresh plan before retrying the deployment.',
          next: conflict && conflict.kind !== 'already_applied' ? ['hv_runs'] : ['hv_plan'],
        });
      }

      if (deploySourceStage && outcome.result.success) {
        return commandSuccess(
          {
            planId: planned.planRunId,
            applyRunId: outcome.result.applyRunId,
            status: 'pending',
            environment: envName,
            receipts: outcome.result.receipts,
            message: 'Provider-native deploy sources were reconciled; application deployment has not started.',
          },
          {
            hint: 'Re-run hv_deploy. The fresh plan will verify that every native source is disconnected before authorizing application or infrastructure mutations.',
            warnings: outcome.actionScopedWarnings,
            next: ['hv_deploy'],
          }
        );
      }

      const summary = outcome.bootstrapSummary ?? {};
      const data = {
        planId: planned.planRunId,
        applyRunId: outcome.result.applyRunId,
        runId: summary.deploymentRunId,
        status: outcome.result.success ? 'succeeded' : 'failed',
        environment: envName,
        urls: summary.urls ?? [],
        serviceUrls: summary.serviceUrls ?? {},
        primaryUrl: summary.primaryUrl,
        errors: outcome.result.success
          ? undefined
          : [String(summary.error ?? outcome.result.error ?? 'Deploy failed')],
        createdResources: summary.deploymentCreatedResources ?? [],
        rollback: summary.deploymentRollback,
        receipts: outcome.result.receipts,
      };

      if (!outcome.result.success) {
        return commandError('PROVIDER_ERROR', 'Deployment had errors', {
          details: data,
          hint: 'Inspect errors, then retry hv_deploy or roll back with hv_rollback.',
        });
      }

      const deployedCount = services?.length ?? Object.keys(envSpec.services).length;
      return commandSuccess(
        { ...data, message: `Deployment completed for ${deployedCount} service(s)` },
        { warnings: outcome.actionScopedWarnings, next: ['hv_health'] }
      );
    })
  );

  commands.register(
    'hv_rollback',
    'Rollback a managed-CI environment through one plan-authorized command. Providers with a verified release-evidence implementation restore the previous exact-SHA release (or toSha) and return pending until verified with hv_ci_status; unsupported CI providers and direct-provider deployments fail closed without deploying current source. Database migrations and provider-side manual configuration are never reversed implicitly. Protected environments require confirm=true.',
    {
      project: projectField,
      env: envField,
      toRunId: z.string().uuid().optional().describe('Legacy compatibility selector. Direct-provider runs lack verified immutable release evidence, so this input fails closed; managed CI uses toSha. Mutually exclusive with toSha.'),
      toSha: z.string().regex(/^[0-9a-f]{40}$/i).optional().describe('Specific previously verified exact Git SHA for a managed CI rollback. Mutually exclusive with toRunId.'),
      services: z.array(z.string()).optional().describe('Legacy direct-provider selector. Managed CI restores the complete verified release and rejects per-service rollback; direct-provider rollback is unsupported.'),
      confirm: confirmField,
    },
    wrapCommandHandler(async ({ project: projectRef, env, toRunId, toSha, services, confirm }) => {
      if (toRunId && toSha) {
        throw new HvError('VALIDATION', 'Pass either toRunId or toSha, not both.', {
          hint: 'Use toSha for a managed-CI release. toRunId is retained only for compatibility and cannot authorize a direct-provider rollback.',
        });
      }
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);

      assertConfirmed(project, environment, confirm, 'hv_rollback');

      const result = await executeRollback({
        project,
        environment,
        ...(toRunId ? { toRunId } : {}),
        ...(toSha ? { toSha } : {}),
        ...(services ? { services } : {}),
      });
      if (!result.ok) {
        const code = result.reason === 'unsupported' ? 'UNSUPPORTED'
          : result.reason === 'no_adapter' ? 'MISSING_CONNECTION'
          : ['invalid_run', 'invalid_target', 'workflow_drift', 'workflow_inactive', 'rollback_in_progress'].includes(result.reason)
            ? 'VALIDATION'
            : result.reason === 'observation_failed' ? 'PROVIDER_ERROR'
            : 'NOT_FOUND';
        return commandError(code, result.error, {
          ...(code === 'MISSING_CONNECTION'
            ? { details: connectionRecoveryDetails([{ provider: 'provider' in result && result.provider ? result.provider : project.defaultPlatform }], { project: project.name, gitRemoteUrl: project.gitRemoteUrl }) }
            : {}),
          ...('hint' in result && result.hint ? { hint: result.hint } : {}),
          ...(result.reason === 'workflow_drift' ? { next: ['hv_plan', 'hv_apply'] } : {}),
        });
      }

      const { ok: _ok, ...payload } = result;
      if (!result.pending) {
        return commandError('PROVIDER_ERROR', 'Rollback workflow was not dispatched.', {
          details: { ...payload, note: CI_ROLLBACK_NOTE },
          hint: 'Inspect the rollback plan/apply receipts and start a fresh hv_rollback only after resolving the blocker.',
          next: ['hv_runs'],
        });
      }
      return commandSuccess(
        { ...payload, note: CI_ROLLBACK_NOTE },
        {
          hint: 'Rollback was dispatched but is not yet proven. Inspect the managed workflow with hv_ci_status; after success, verify the public endpoint with hv_health.',
          warnings: [CI_ROLLBACK_NOTE],
          next: ['hv_ci_status'],
          agentInstruction: {
            action: 'stop_and_report',
            message: 'Stop here. Report the exact rollback SHA and pending workflow, then inspect it only through hv_ci_status before running hv_health after success.',
          },
        }
      );
    })
  );
}
