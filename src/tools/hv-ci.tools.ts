import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import {
  getGitHubAdapter,
} from '../domain/services/github-ops.service.js';
import {
  connectionSetupOptions,
} from '../domain/services/connection-guidance.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import type { CiWorkflowDiagnostic } from '../domain/ports/ci-deploy.port.js';
import type { CommandContext } from '../application/context.js';
import { projectField } from './schemas.js';
import { commandSuccess, wrapCommandHandler, HvError } from '../application/results.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { devOpsProviderRegistry } from '../domain/registry/devops.registry.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { normalizeGitRemoteIdentity } from '../lib/git-remote.js';
import type { CiOperationsPort, CodeRepositoryIdentity } from '../domain/ports/devops.port.js';
import { ignoredOptionWarnings } from '../application/command-options.js';

type ConnectedGitHubAdapter = Extract<
  ReturnType<typeof getGitHubAdapter>,
  { adapter: unknown }
>['adapter'];

const repoField = z
  .string()
  .optional()
  .describe('Deprecated repository override for legacy GitHub projects. Canonical devops projects use the reviewed devops.code.scope.');

const opaqueIdField = z.preprocess(
  (value) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    return value;
  },
  z.string().trim().min(1)
);

interface CanonicalCiContext {
  project: ReturnType<CommandContext['resolveProjectOrThrow']>;
  repository: CodeRepositoryIdentity;
  ci: CiOperationsPort;
  ciProvider: string;
}

async function canonicalCiContextOrNull(
  ctx: CommandContext,
  projectRef: string | undefined,
  repoOverride?: string
): Promise<CanonicalCiContext | null> {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const spec = new SpecStore().get(project)?.spec;
  if (!spec?.devops) return null;
  if (!spec.devops.ci) {
    throw new HvError('UNSUPPORTED', 'The project has no primary CI provider in devops.ci.');
  }
  if (repoOverride && repoOverride !== spec.devops.code.scope) {
    throw new HvError('VALIDATION', 'repo cannot override canonical devops.code.scope.', {
      hint: `Use the reviewed repository scope ${spec.devops.code.scope}.`,
    });
  }
  const codeRegistration = devOpsProviderRegistry.codeHost(spec.devops.code.provider);
  const ciRegistration = devOpsProviderRegistry.ciProvider(spec.devops.ci.provider);
  if (!codeRegistration) throw new HvError('UNSUPPORTED', `Code-host provider "${spec.devops.code.provider}" is not registered.`);
  if (!ciRegistration) throw new HvError('UNSUPPORTED', `CI provider "${spec.devops.ci.provider}" is not registered.`);
  if (!devOpsProviderRegistry.compatible(spec.devops.code.provider, spec.devops.ci.provider)) {
    throw new HvError('UNSUPPORTED', `${spec.devops.ci.provider} is not compatible with ${spec.devops.code.provider}.`);
  }
  const codeConnection = ctx.repos.connections.findBestVerifiedMatch(
    codeRegistration.connectionProvider,
    spec.devops.code.scope
  );
  if (!codeConnection) {
    throw new HvError('MISSING_CONNECTION', `No verified ${codeRegistration.connectionProvider} connection found.`, {
      ...connectionSetupOptions(codeRegistration.connectionProvider, {
        project: project.name,
        scope: spec.devops.code.scope,
      }),
    });
  }
  const codeCredentials = getSecretStore().decryptObject<unknown>(codeConnection.credentialsEncrypted);
  const code = codeRegistration.create(codeCredentials);
  const observed = await code.observeRepository(spec.devops.code.scope);
  if (observed.state !== 'present') {
    throw new HvError('PROVIDER_ERROR', observed.state === 'absent'
      ? `Repository ${spec.devops.code.scope} was not found.`
      : observed.reason);
  }
  const selectedRemote = normalizeGitRemoteIdentity(project.gitRemoteUrl);
  const cloneIdentities = observed.value.cloneUrls
    .map((value) => normalizeGitRemoteIdentity(value))
    .filter((value): value is string => Boolean(value));
  if (!selectedRemote || !cloneIdentities.includes(selectedRemote)) {
    throw new HvError('VALIDATION', 'The selected project remote does not match the provider-observed repository identity.');
  }
  const ciConnection = ctx.repos.connections.findBestVerifiedMatch(
    ciRegistration.connectionProvider,
    spec.devops.code.scope
  );
  if (!ciConnection) {
    throw new HvError('MISSING_CONNECTION', `No verified ${ciRegistration.connectionProvider} connection found.`, {
      ...connectionSetupOptions(ciRegistration.connectionProvider, {
        project: project.name,
        scope: spec.devops.code.scope,
      }),
    });
  }
  const ciCredentials = getSecretStore().decryptObject<unknown>(ciConnection.credentialsEncrypted);
  return {
    project,
    repository: observed.value,
    ci: ciRegistration.create(ciCredentials),
    ciProvider: spec.devops.ci.provider,
  };
}

interface RepoRef {
  project: string;
  owner: string;
  repo: string;
}

interface WorkflowJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  steps: Array<{
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}

function resolveRepoOrThrow(ctx: CommandContext, projectRef: string | undefined, repoOverride: string | undefined) {
  const project = ctx.resolveProjectOrThrow({ project: projectRef });
  const slug = repoOverride?.trim() || parseGitHubRepoFromRemote(project.gitRemoteUrl);
  const parts = slug?.split('/') ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HvError('VALIDATION', 'Could not determine the GitHub repository.', {
      hint: 'Pass repo="owner/repo", or set the project gitRemoteUrl to a GitHub remote.',
    });
  }
  return { project: project.name, owner: parts[0], repo: parts[1] };
}

function githubAdapterOrThrow({ project, owner, repo }: RepoRef): ConnectedGitHubAdapter {
  const result = getGitHubAdapter(`${owner}/${repo}`);
  if ('error' in result) {
    throw new HvError('MISSING_CONNECTION', result.error, {
      ...connectionSetupOptions('github', { project, scope: `${owner}/${repo}` }),
    });
  }
  return result.adapter;
}

function summarizeWorkflowJob(job: {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  steps?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    started_at: string | null;
    completed_at: string | null;
  }>;
}): WorkflowJobSummary {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url,
    steps: (job.steps ?? []).map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
  };
}

function isUnsuccessfulJob(job: { status: string; conclusion: string | null }): boolean {
  if (job.conclusion) {
    return !['success', 'skipped'].includes(job.conclusion);
  }
  return job.status !== 'completed';
}

function tailLogText(text: string, requestedLines: number) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const tail = lines.slice(-requestedLines);
  return {
    text: tail.join('\n'),
    lineCount: lines.length,
    returnedLines: tail.length,
    truncated: lines.length > tail.length,
  };
}

function diagnoseGenericWorkflowLog(text: string): CiWorkflowDiagnostic[] {
  const diagnostics: CiWorkflowDiagnostic[] = [];

  if (/failed to read dockerfile|dockerfile.*no such file or directory/i.test(text)) {
    diagnostics.push({
      code: 'DOCKERFILE_MISSING',
      severity: 'error',
      summary: 'The Docker build step found neither a repository Dockerfile nor a complete reviewed runtime build contract.',
      evidence: 'failed to read dockerfile during the image build step.',
      next: [
        'Review repository runtime, package-manager, build-script, and start-script evidence with hv_spec, then persist any missing commands.',
        'For a custom or polyglot build, add a repository Dockerfile; it remains authoritative over generated containers.',
        'Re-sync the declarative deploy workflow with hv_plan + hv_apply after the desired build contract is complete.',
        'Re-run the workflow with hv_ci_trigger afterwards.',
      ],
    });
  }

  if (/ECONNREFUSED (127\.0\.0\.1|::1):5432/.test(text) && /db:setup|migrat|sequelize|prisma|knex/i.test(text)) {
    diagnostics.push({
      code: 'MIGRATION_DATABASE_URL_EMPTY',
      severity: 'error',
      summary: 'The migration step connected to localhost:5432 — DATABASE_URL is empty or unset in the workflow, so the database client fell back to local defaults.',
      evidence: 'ECONNREFUSED 127.0.0.1:5432 during the migration step.',
      next: [
        'Prefer in-environment migrations where the hosting provider supports them, so migrations run with the deployed service image and managed database env vars.',
        'If migrations must run in GitHub Actions, the managed database needs an externally reachable URL; re-run hv_plan/hv_apply after exposing one so DATABASE_URL can be synced into repository secrets.',
        'Re-run the workflow with hv_ci_trigger afterwards.',
      ],
    });
  }

  if (/Node 20 is being deprecated/i.test(text) && /actions\/github-script@v7/i.test(text)) {
    diagnostics.push({
      code: 'GITHUB_SCRIPT_NODE20_DEPRECATED',
      severity: 'warning',
      summary: 'This deploy workflow still uses actions/github-script@v7, which runs on the deprecated Node 20 action runtime. Current Hypervibe workflows use actions/github-script@v9.',
      evidence: 'GitHub Actions reported Node 20 deprecation for actions/github-script@v7.',
      next: [
        'Re-sync the declarative deploy workflow with hv_plan + hv_apply so it uses actions/github-script@v9.',
        'Re-run the workflow with hv_ci_trigger afterwards.',
      ],
    });
  }

  return diagnostics;
}

function diagnoseWorkflowLog(text: string): CiWorkflowDiagnostic[] {
  return [
    ...diagnoseGenericWorkflowLog(text),
    ...providerRegistry
      .all()
      .flatMap((provider) => provider.metadata.orchestration?.ci?.diagnoseWorkflowLog?.(text) ?? []),
  ];
}

function ciStatusOptionWarnings(
  sections: string[],
  options: {
    definition?: string;
    workflow?: string;
    runId?: string;
    jobId?: string;
    logLines?: number;
    branch?: string;
  }
): string[] | undefined {
  const usesDefinition = sections.includes('runs');
  const usesRun = sections.some((section) => ['jobs', 'logs', 'artifacts'].includes(section));
  const usesLogs = sections.includes('logs');
  const usesBranch = sections.includes('branch-protection');
  return ignoredOptionWarnings('hv_ci_status', `include=${JSON.stringify(sections)}`, {
    definition: usesDefinition ? undefined : options.definition,
    workflow: usesDefinition ? undefined : options.workflow,
    runId: usesRun ? undefined : options.runId,
    jobId: usesLogs ? undefined : options.jobId,
    logLines: usesLogs ? undefined : options.logLines,
    branch: usesBranch ? undefined : options.branch,
  });
}

export function registerHvCiTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_ci_status',
    'Authoritative provider-neutral inspection path for Hypervibe-managed CI. Use this instead of gh, GitHub connectors/apps, browser/UI inspection, or direct CI/provider API calls. The same connection and audit boundary applies to GitLab. Returns definitions, recent runs, jobs, bounded job log tails, and artifact provenance through the project\'s reviewed code-host and CI bindings. GitHub Pages and branch protection remain feature-scoped GitHub observations.',
    {
      project: projectField,
      repo: repoField,
      include: z.array(z.enum(['definitions', 'workflows', 'runs', 'jobs', 'logs', 'artifacts', 'pages', 'branch-protection'])).optional().describe('Sections to include (default: ["definitions"] for canonical devops specs and ["workflows"] for legacy GitHub). jobs/logs require runId. artifacts exposes names/provenance but never artifact contents.'),
      definition: z.string().optional().describe('Provider-native definition id or path (required when include contains "runs"). Prefer this portable field; do not pass a different workflow alias.'),
      workflow: z.string().optional().describe('Deprecated alias for definition; retained for GitHub compatibility. Omit when definition is supplied.'),
      runId: opaqueIdField.optional().describe('Opaque provider-native run id, required for jobs/logs and optional as an artifacts filter.'),
      jobId: opaqueIdField.optional().describe('Optional opaque provider-native job id for include=["logs"]. Defaults to failed jobs, or the first job.'),
      logLines: z.number().int().positive().max(500).optional().describe('Number of log lines to return per job for include=["logs"] (default 120, max 500).'),
      branch: z.string().optional().describe('Branch for branch-protection (default "main")'),
    },
    wrapCommandHandler(async ({ project: projectRef, repo: repoOverride, include, definition, workflow, runId, jobId, logLines, branch }) => {
      if (definition && workflow && definition !== workflow) {
        throw new HvError('VALIDATION', 'definition and workflow select different CI definitions.', {
          details: { definition, workflow },
          hint: 'Pass definition only. workflow is a deprecated GitHub compatibility alias.',
        });
      }
      const canonical = await canonicalCiContextOrNull(ctx, projectRef, repoOverride);
      if (canonical) {
        const sections = include?.length ? include : ['definitions' as const];
        const warnings = ciStatusOptionWarnings(sections, { definition, workflow, runId, jobId, logLines, branch });
        const data: Record<string, unknown> = {
          codeProvider: canonical.repository.provider,
          ciProvider: canonical.ciProvider,
          repository: {
            id: canonical.repository.nativeId,
            scope: canonical.repository.canonicalScope,
            path: canonical.repository.path,
          },
        };
        for (const section of sections) {
          if (section === 'pages' || section === 'branch-protection') {
            throw new HvError('UNSUPPORTED', `${section} is a code-host feature, not a primary-CI section for ${canonical.ciProvider}.`);
          }
          try {
            if (section === 'definitions' || section === 'workflows') {
              const values = await canonical.ci.listDefinitions(canonical.repository);
              data[section] = values;
            } else if (section === 'runs') {
              const selected = definition ?? workflow;
              if (!selected) throw new HvError('VALIDATION', 'definition is required when include contains "runs".');
              data.runs = await canonical.ci.listRuns(canonical.repository, selected, 10);
            } else if (section === 'jobs') {
              if (!runId) throw new HvError('VALIDATION', 'runId is required when include contains "jobs".');
              data.jobs = await canonical.ci.listJobs(canonical.repository, runId, 100);
            } else if (section === 'logs') {
              if (!runId) throw new HvError('VALIDATION', 'runId is required when include contains "logs".');
              const jobs = await canonical.ci.listJobs(canonical.repository, runId, 100);
              const selectedJobs = jobId
                ? jobs.filter((job) => job.id === jobId)
                : jobs.filter((job) => ['failed', 'canceled', 'unknown'].includes(job.phase)).slice(0, 3);
              if (jobId && selectedJobs.length === 0) {
                throw new HvError('NOT_FOUND', `CI job ${jobId} was not found in run ${runId}.`, {
                  details: { available: jobs.map((job) => job.id) },
                  hint: 'List jobs for this run with hv_ci_status include=["jobs"], then pass an exact returned jobId.',
                });
              }
              const jobsForLogs = selectedJobs.length > 0 ? selectedJobs : jobs.slice(0, 1);
              const entries = await Promise.all(jobsForLogs.map(async (job) => {
                try {
                  const text = await canonical.ci.getJobLog(canonical.repository, job.id);
                  return { jobId: job.id, name: job.name, phase: job.phase, ...tailLogText(text, logLines ?? 120) };
                } catch (error) {
                  return { jobId: job.id, name: job.name, phase: job.phase, error: error instanceof Error ? error.message : String(error) };
                }
              }));
              data.logs = entries;
              const diagnostics = entries.flatMap((entry) => (
                'text' in entry && typeof entry.text === 'string'
                  ? diagnoseWorkflowLog(entry.text).map((diagnostic) => ({ ...diagnostic, jobId: entry.jobId, jobName: entry.name }))
                  : []
              ));
              if (diagnostics.length > 0) data.diagnostics = diagnostics;
            } else if (section === 'artifacts') {
              data.artifacts = await canonical.ci.listArtifacts(canonical.repository, runId, 100);
            }
          } catch (error) {
            if (error instanceof HvError) throw error;
            data[section === 'workflows' ? 'definitions' : section] = {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        return commandSuccess(data, { warnings });
      }
      const repoRef = resolveRepoOrThrow(ctx, projectRef, repoOverride);
      const { owner, repo } = repoRef;
      const adapter = githubAdapterOrThrow(repoRef);
      const sections = include?.length ? include : ['workflows' as const];
      const warnings = ciStatusOptionWarnings(sections, { definition, workflow, runId, jobId, logLines, branch });
      const data: Record<string, unknown> = { repository: `${owner}/${repo}` };

      for (const section of sections) {
        try {
          switch (section) {
            case 'definitions':
            case 'workflows': {
              const workflows = await adapter.listWorkflows(owner, repo);
              data[section] = workflows.workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
              break;
            }
            case 'runs': {
              const selected = definition ?? workflow;
              if (!selected) {
                throw new HvError('VALIDATION', 'definition is required when include contains "runs".', {
                  hint: 'Pass definition as a filename (e.g. "deploy.yml") or numeric id.',
                });
              }
              const runs = await adapter.listWorkflowRuns(owner, repo, selected, { per_page: 10 });
              data.runs = runs.workflow_runs.map((r) => ({
                id: r.id,
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                headSha: r.head_sha,
                branch: r.head_branch,
                event: r.event,
                createdAt: r.created_at,
                url: r.html_url,
              }));
              break;
            }
            case 'jobs': {
              if (!runId) {
                throw new HvError('VALIDATION', 'runId is required when include contains "jobs".', {
                  hint: 'Get the run id from hv_ci_status include=["runs"], then rerun with include=["jobs"] and runId=<id>.',
                });
              }
              const legacyRunId = /^\d+$/.test(runId) ? Number(runId) : runId;
              const jobs = await adapter.listWorkflowRunJobs(owner, repo, legacyRunId, { per_page: 100 });
              data.jobs = jobs.jobs.map(summarizeWorkflowJob);
              break;
            }
            case 'logs': {
              if (!runId) {
                throw new HvError('VALIDATION', 'runId is required when include contains "logs".', {
                  hint: 'Get the run id from hv_ci_status include=["runs"], then rerun with include=["logs"] and runId=<id>.',
                });
              }
              const legacyRunId = /^\d+$/.test(runId) ? Number(runId) : runId;
              const jobs = await adapter.listWorkflowRunJobs(owner, repo, legacyRunId, { per_page: 100 });
              const targetJobs = jobId
                ? jobs.jobs.filter((job) => String(job.id) === jobId)
                : jobs.jobs.filter(isUnsuccessfulJob).slice(0, 3);
              if (jobId && targetJobs.length === 0) {
                throw new HvError('NOT_FOUND', `GitHub Actions job ${jobId} was not found in run ${runId}.`, {
                  details: { available: jobs.jobs.map((job) => String(job.id)) },
                  hint: 'List jobs for this run with hv_ci_status include=["jobs"], then pass an exact returned jobId.',
                });
              }
              const jobsForLogs = targetJobs.length > 0
                ? targetJobs
                : jobs.jobs.slice(0, 1);
              const resolvedLogLines = logLines ?? 120;
              const logEntries = await Promise.all(jobsForLogs.map(async (job) => {
                try {
                  const text = await adapter.getWorkflowJobLogs(owner, repo, job.id);
                  const tail = tailLogText(text, resolvedLogLines);
                  return {
                    jobId: job.id,
                    name: job.name,
                    status: job.status,
                    conclusion: job.conclusion,
                    ...tail,
                  };
                } catch (error) {
                  return {
                    jobId: job.id,
                    name: job.name,
                    status: job.status,
                    conclusion: job.conclusion,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              }));
              data.logs = logEntries;
              const diagnostics = logEntries.flatMap((entry) => {
                if (!('text' in entry) || typeof entry.text !== 'string') {
                  return [];
                }
                return diagnoseWorkflowLog(entry.text).map((diagnostic) => ({
                  ...diagnostic,
                  jobId: entry.jobId,
                  jobName: entry.name,
                }));
              });
              if (diagnostics.length > 0) {
                data.diagnostics = diagnostics;
              }
              break;
            }
            case 'artifacts': {
              const artifacts = runId
                ? await adapter.listWorkflowRunArtifacts(owner, repo, runId)
                : await adapter.listArtifacts(owner, repo, 100);
              data.artifacts = artifacts.artifacts
                .map((artifact) => ({
                id: artifact.id,
                name: artifact.name,
                expired: artifact.expired,
                createdAt: artifact.created_at,
                workflowRun: artifact.workflow_run
                  ? {
                    id: artifact.workflow_run.id,
                    headSha: artifact.workflow_run.head_sha,
                    headBranch: artifact.workflow_run.head_branch,
                  }
                  : null,
                }));
              break;
            }
            case 'pages': {
              const pages = await adapter.getPagesConfig(owner, repo);
              data.pages = pages
                ? {
                    enabled: true,
                    url: pages.url,
                    status: pages.status,
                    customDomain: pages.cname,
                    httpsEnforced: pages.https_enforced,
                    certificateState: pages.https_certificate?.state,
                  }
                : { enabled: false };
              break;
            }
            case 'branch-protection': {
              const branchName = branch ?? 'main';
              const protection = await adapter.getBranchProtection(owner, repo, branchName);
              data.branchProtection = protection
                ? {
                    branch: branchName,
                    protected: true,
                    requireReviews: !!protection.required_pull_request_reviews,
                    requiredReviewers: protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
                    requireStatusChecks: !!protection.required_status_checks,
                    statusChecks: protection.required_status_checks?.contexts ?? [],
                    enforceAdmins: protection.enforce_admins?.enabled ?? false,
                  }
                : { branch: branchName, protected: false };
              break;
            }
          }
        } catch (error) {
          if (error instanceof HvError) throw error;
          data[section === 'branch-protection' ? 'branchProtection' : section] = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return commandSuccess(data, { warnings });
    })
  );

  commands.register(
    'hv_ci_trigger',
    'The only supported dispatch path for the project\'s reviewed primary CI definition. Use this for managed-CI deploy and promotion requests; never dispatch with gh, a code-host connector/app, or a direct CI/provider API. The provider must support dispatch; GitLab requires an exact reviewed SHA and verifies it before and after dispatch.',
    {
      project: projectField,
      repo: repoField,
      definition: z.string().optional().describe('Provider-native definition id or path. Prefer this portable field; do not pass a different workflow alias.'),
      workflow: z.string().optional().describe('Deprecated alias for definition; retained for GitHub compatibility. Omit when definition is supplied.'),
      ref: z.string().optional().describe('Git ref to run on (default: the observed repository default branch).'),
      sha: z.string().regex(/^[0-9a-f]{40}$/i).optional().describe('Exact reviewed commit SHA. Required by GitLab and supported only by canonical devops bindings; legacy GitHub workflow dispatch is ref-only.'),
      inputs: z.record(z.string()).optional().describe('Typed, non-secret CI inputs as key-value pairs. Values are not written to audit output.'),
    },
    wrapCommandHandler(async ({ project: projectRef, repo: repoOverride, definition, workflow, ref, sha, inputs }) => {
      if (definition && workflow && definition !== workflow) {
        throw new HvError('VALIDATION', 'definition and workflow select different CI definitions.', {
          details: { definition, workflow },
          hint: 'Pass definition only. workflow is a deprecated GitHub compatibility alias.',
        });
      }
      const selectedDefinition = definition ?? workflow;
      if (!selectedDefinition) throw new HvError('VALIDATION', 'definition is required.');
      const canonical = await canonicalCiContextOrNull(ctx, projectRef, repoOverride);
      if (canonical) {
        const selectedRef = ref ?? canonical.repository.defaultBranch;
        const run = await canonical.ci.dispatch(canonical.repository, {
          definition: selectedDefinition,
          ref: selectedRef,
          ...(sha ? { sha } : {}),
          ...(inputs ? { inputs } : {}),
        });
        ctx.repos.audit.create({
          action: 'hv.ci_trigger',
          resourceType: 'ci_definition',
          resourceId: `${canonical.ciProvider}/${canonical.repository.nativeId}/${selectedDefinition}`,
          details: {
            ciProvider: canonical.ciProvider,
            definition: selectedDefinition,
            ref: selectedRef,
            ...(sha ? { sha } : {}),
            inputNames: Object.keys(inputs ?? {}).sort(),
          },
        });
        return commandSuccess(
          {
            ciProvider: canonical.ciProvider,
            repository: canonical.repository.canonicalScope,
            definition: selectedDefinition,
            ref: selectedRef,
            run,
          },
          { hint: 'CI run dispatched. Check progress with hv_ci_status include=["runs"].', next: ['hv_ci_status'] }
        );
      }
      const repoRef = resolveRepoOrThrow(ctx, projectRef, repoOverride);
      const { owner, repo } = repoRef;
      const adapter = githubAdapterOrThrow(repoRef);

      if (sha) {
        throw new HvError('UNSUPPORTED', 'Exact-SHA dispatch is unavailable for legacy GitHub workflow bindings.', {
          hint: 'Omit sha to dispatch the reviewed branch/tag ref, or migrate the project to canonical devops bindings that verify exact-SHA dispatch.',
        });
      }

      const selectedRef = ref ?? (await adapter.getRepository(owner, repo)).default_branch;
      if (!selectedRef?.trim()) {
        throw new HvError('PROVIDER_ERROR', `GitHub did not return a default branch for ${owner}/${repo}.`, {
          hint: 'Pass ref explicitly, or verify the repository default branch before dispatching.',
        });
      }
      await adapter.triggerWorkflow(owner, repo, selectedDefinition, selectedRef, inputs);
      ctx.repos.audit.create({
        action: 'hv.ci_trigger',
        resourceType: 'github_workflow',
        resourceId: `${owner}/${repo}/${selectedDefinition}`,
        details: { workflow: selectedDefinition, ref: selectedRef, inputNames: Object.keys(inputs ?? {}).sort() },
      });

      return commandSuccess(
        { repository: `${owner}/${repo}`, workflow: selectedDefinition, ref: selectedRef },
        { hint: 'Workflow dispatched. Check progress with hv_ci_status include=["runs"].', next: ['hv_ci_status'] }
      );
    })
  );
}
