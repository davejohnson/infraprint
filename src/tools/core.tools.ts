import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { canonicalizeLegacyGitHubSpec, deepMergeSpec, SpecStore } from '../domain/spec/spec.store.js';
import {
  projectSpecSchema,
  type EnvironmentSpec,
  type ProjectSpec,
} from '../domain/spec/spec.schema.js';
import { PlanService } from '../domain/plan/plan.service.js';
import { diffEnvironment } from '../domain/plan/diff.engine.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { planIos } from '../domain/services/appstore-plan.service.js';
import { planCache } from '../domain/services/cache-plan.service.js';
import { planDatabaseResilience } from '../domain/services/database-resilience-plan.service.js';
import { planQueues } from '../domain/services/queue-plan.service.js';
import { planStorage } from '../domain/services/storage-plan.service.js';
import { planDelegatedSecrets } from '../domain/services/delegated-secret.service.js';
import { deriveHypervibeSecretValues } from '../domain/services/hypervibe-secret-value.js';
import { withReceiptValidatedManagedSecretBindings } from '../domain/services/managed-secret-binding-receipts.js';
import { runtimeRolloutRequirements } from '../domain/services/runtime-rollout.service.js';
import { planManagedCiDeploy } from '../domain/services/managed-ci.service.js';
import { resolveDevOpsSelection } from '../domain/spec/devops-selection.js';
import { devOpsProviderRegistry } from '../domain/registry/devops.registry.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { CommandContext } from '../application/context.js';
import { projectField, envField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';
import {
  actionScopedBlocksAllowedDuringApply,
  actionScopedBlocksRequiringConnectBeforeApply,
  connectionLocalEnvInputs,
  connectionProviders,
  connectionRecoveryDetails,
  connectionRecoveryHint,
  executePlanApply,
  splitActionScopedConnectionBlocks,
  syncProjectGitRemoteUrl,
  type ConnectionBlock,
} from '../application/apply-plan.js';
import { cloudflareScopeHintsForDomain } from '../domain/services/domain-scope.js';
import {
  githubCanonicalEnvironment,
  githubSpecNeedsOpenAI,
  planGitHubInfrastructure,
  shouldPlanGitHubInfrastructure,
  unresolvedGitHubCheckRuntimeIssues,
} from '../domain/services/github-infrastructure.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import {
  findRepoRoot,
  readRepoSpecFile,
  repositoryMatchesProjectIdentity,
  repositoryProjectIdentity,
} from '../domain/spec/repo-spec-file.js';
import {
  ensureRepoLocalEnv,
  specLocalEnvRequirements,
  type LocalEnvRequirement,
  type RepoEnvFileWrite,
} from '../domain/spec/repo-env-file.js';
import {
  analyzeRepositoryRuntime,
  reviewRepositoryRuntime,
} from '../domain/spec/repository-runtime.js';
import { planStripeEnvironmentSync } from '../domain/services/stripe-env.service.js';
import { planEmail } from '../domain/services/email-plan.service.js';
import { planTwilioMessaging } from '../domain/services/twilio-messaging.service.js';
import { firstProviderSpecValidationFailure } from '../domain/services/provider-spec-validation.js';
import { buildManagedDatabaseEnvVars } from '../domain/services/database-env.js';
import { buildCacheEnvVarsFromComponent } from '../domain/services/cache-env.js';
import type { ObservedState } from '../domain/ports/observe.port.js';
import {
  environmentVariableCoverage,
  environmentVariableCoverageIssueId,
  type EnvironmentVariableCoverageReport,
} from '../domain/services/environment-variable-coverage.service.js';
import { planProviderNativeDeploySources } from '../domain/services/provider-native-deploy-source.service.js';
import { planMaintenance } from '../domain/services/maintenance-plan.service.js';
import { parseEnvironmentMaintenanceBinding } from '../domain/services/environment-maintenance.service.js';

// Re-exported for existing test imports; implementation lives in apply-plan.ts.
export { bootstrapActionResultFromSummary } from '../application/apply-plan.js';

function validateInstalledProviders(spec: ProjectSpec): void {
  const failure = firstProviderSpecValidationFailure(spec);
  if (!failure) return;
  throw new HvError(
    'VALIDATION',
    failure.message,
    {
      hint: failure.hint,
      details: failure.details,
    }
  );
}

function providerNativeDeployChanges(
  nextSpec: ProjectSpec,
  previousSpec: ProjectSpec | null
): Array<{ environment: string; provider: string; branch?: string }> {
  const changes: Array<{ environment: string; provider: string; branch?: string }> = [];
  for (const [environmentName, environment] of Object.entries(nextSpec.environments)) {
    if (environment.deploy?.strategy !== 'branch' || environment.deploy.trigger !== 'native') {
      continue;
    }
    const previousEnvironment = previousSpec?.environments[environmentName];
    const alreadyNative =
      previousEnvironment?.hosting.provider === environment.hosting.provider
      && previousEnvironment.deploy?.strategy === 'branch'
      && previousEnvironment.deploy.trigger === 'native';
    if (!alreadyNative) {
      changes.push({
        environment: environmentName,
        provider: environment.hosting.provider,
        ...(environment.deploy.branch ? { branch: environment.deploy.branch } : {}),
      });
    }
  }
  return changes;
}

function nativeDeployConfirmationHint(changes: Array<{ environment: string; provider: string; branch?: string }>): string {
  const providerDetails = Array.from(new Set(
    changes
      .map((change) => {
        const metadata = providerRegistry.getMetadata(change.provider);
        if (!metadata?.orchestration?.nativeBranchDeploy?.needsGitHubAppAccess) return null;
        return `${metadata.displayName} native deploys require the ${metadata.displayName} GitHub App and project-member GitHub access.`;
      })
      .filter((value): value is string => Boolean(value))
  ));
  const providerDetail = providerDetails.length ? ` ${providerDetails.join(' ')}` : '';
  return `Provider-native branch deploys are provider-specific and are not Hypervibe's portable default. Do not switch from trigger="ci" to trigger="native" to avoid GitHub package-read/image credentials.${providerDetail} If the user explicitly wants provider-native deploys, rerun hv_spec with confirmNativeDeploy=true.`;
}

function summarizeActions(actions: PlanAction[]) {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    counts[action.type] = (counts[action.type] ?? 0) + 1;
  }
  return counts;
}

function managedDatabaseContract(environment: EnvironmentSpec) {
  if (!environment.database) return undefined;
  return {
    provider: environment.database.provider,
    engine: environment.database.engine,
    canonicalEnvVars: ['DATABASE_URL', 'DIRECT_URL'],
    services: Object.fromEntries(
      Object.entries(environment.services).map(([serviceName, service]) => [
        serviceName,
        {
          aliases: service.databaseEnvAliases ?? {},
        },
      ])
    ),
  };
}

function runtimeHealthSummary(observed: ObservedState | null) {
  const failed = observed?.services
    .filter((service) => service.status === 'failed')
    .map((service) => service.name) ?? [];
  if (failed.length > 0) {
    return {
      status: 'failed',
      services: failed,
      reason: 'The provider reports a failed deployment. Inspect deployment/build logs with hv_logs before treating the environment as healthy.',
    };
  }
  return {
    status: 'unverified',
    reason: 'hv_status verifies desired infrastructure and managed variable attachment, not application behavior. Use hv_health for HTTP services and hv_logs source="service" errorsOnly=true for workers.',
  };
}

function normalizeGitSourceRepo(repo?: string): string | undefined {
  if (!repo) {
    return undefined;
  }

  return repo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

/** Normalize an observed service endpoint to a public http(s) origin. */
function sanitizeServiceUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return undefined;
  }
  return url.origin;
}

function sanitizeHostname(raw: string): string | undefined {
  const hostname = raw.trim().toLowerCase();
  if (hostname.length === 0 || hostname.length > 253) return undefined;
  const labels = hostname.split('.');
  if (labels.length < 2) return undefined;
  if (labels.some((label) => (
    label.length === 0
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    return undefined;
  }
  return hostname;
}

function sanitizeCustomDomains(domains: string[]): string[] {
  return [...new Set(domains.flatMap((domain) => {
    const hostname = sanitizeHostname(domain);
    return hostname ? [hostname] : [];
  }))];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function booleanField(record: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | null, key: string): string[] | undefined {
  const value = record?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function gitRemoteUrlFromSpecInput(spec: Record<string, unknown>): string | undefined {
  const value = spec.gitRemoteUrl;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function freshProjectCandidate(projectRef?: string): {
  name: string;
  gitRemoteUrl?: string;
} | null {
  const repoRoot = findRepoRoot();
  if (!repoRoot) return null;
  const requestedProject = projectRef?.trim();
  const { gitRemoteUrl, projectName: repositoryProject } = repositoryProjectIdentity(repoRoot);
  if (
    requestedProject
    && repositoryProject
    && requestedProject.toLowerCase() !== repositoryProject.toLowerCase()
  ) {
    return null;
  }
  const name = requestedProject || repositoryProject;
  if (!name) return null;
  return {
    name,
    ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
  };
}

function repositoryRootForProject(projectName: string): string | null {
  return freshProjectCandidate(projectName)?.name === projectName
    ? findRepoRoot()
    : null;
}

function projectWithSpecGitRemoteUrl(project: Project, spec: ProjectSpec): Project {
  const gitRemoteUrl = spec.gitRemoteUrl?.trim();
  return gitRemoteUrl && gitRemoteUrl !== project.gitRemoteUrl
    ? { ...project, gitRemoteUrl }
    : project;
}

function commandEnvironment(spec: ProjectSpec, requested: string | undefined): string {
  const explicit = requested?.trim();
  if (explicit) return explicit;
  return Object.keys(spec.environments).length === 0
    ? githubCanonicalEnvironment(spec) ?? 'staging'
    : 'staging';
}

function mergeLocalEnvWrites(
  ...writes: Array<RepoEnvFileWrite | undefined>
): RepoEnvFileWrite | undefined {
  const present = writes.filter((write): write is RepoEnvFileWrite => Boolean(write));
  if (present.length === 0) return undefined;
  return {
    path: present[0].path,
    addedKeys: [...new Set(present.flatMap((write) => write.addedKeys))].sort(),
    commentedKeys: [...new Set(present.flatMap((write) => write.commentedKeys))].sort(),
    ...(present.some((write) => (write.activatedKeys?.length ?? 0) > 0)
      ? { activatedKeys: [...new Set(present.flatMap((write) => write.activatedKeys ?? []))].sort() }
      : {}),
    ...(present.some((write) => write.permissionsUpdated === true)
      ? { permissionsUpdated: true }
      : {}),
    ...(present.find((write) => write.gitignorePath)?.gitignorePath
      ? { gitignorePath: present.find((write) => write.gitignorePath)!.gitignorePath }
      : {}),
    ...(present.some((write) => write.gitignoreUpdated !== undefined)
      ? { gitignoreUpdated: present.some((write) => write.gitignoreUpdated === true) }
      : {}),
  };
}

function ensureProjectLocalEnv(params: {
  source?: { kind: 'repo'; path: string } | { kind: 'local' };
  projectName?: string;
  projectGitRemoteUrl?: string;
  spec?: ProjectSpec;
  connectionBlocks?: ConnectionBlock[];
  /** Validate the repository secret-file boundary even before any slots are known. */
  verifyRepoSafety?: boolean;
}): RepoEnvFileWrite | undefined {
  const candidateRoot = params.source?.kind === 'repo'
    ? findRepoRoot(params.source.path)
    : findRepoRoot();
  const root = candidateRoot && (
    params.source?.kind === 'repo'
    || (
      params.projectName
      && repositoryMatchesProjectIdentity(
        candidateRoot,
        params.projectName,
        params.projectGitRemoteUrl
      )
    )
  )
    ? candidateRoot
    : null;
  if (!root) return undefined;
  if (params.source?.kind !== 'repo' && params.projectName) {
    const checkoutSpec = readRepoSpecFile(root);
    if (checkoutSpec && checkoutSpec.spec.project !== params.projectName) {
      // Folder/remote matching is only a fallback for local-only projects. A
      // conflicting committed spec owns this checkout, so never add the
      // selected local project's credential slots to its dotenv files.
      return undefined;
    }
  }
  const requirements = [
    ...(params.spec ? specLocalEnvRequirements(params.spec) : []),
    ...connectionLocalEnvInputs(params.connectionBlocks ?? []).map((input): LocalEnvRequirement => ({
      key: input.envKey,
      comment: `${input.comment}; add the value locally, then reference this key with hv_connections.`,
    })),
  ];
  if (requirements.length === 0 && !params.verifyRepoSafety) return undefined;
  return ensureRepoLocalEnv(root, requirements);
}

function requiredConnectionChecklist(ctx: CommandContext, spec: ProjectSpec) {
  const required = new Map<string, { provider: string; environments: Set<string>; reasons: Set<string>; scopeHints: Set<string> }>();
  const add = (provider: string, environment: string, reason: string, scopeHints: string[] = []) => {
    const key = `${provider}:${scopeHints.length > 0 ? scopeHints.join('|') : '*'}`;
    const existing = required.get(key) ?? {
      provider,
      environments: new Set<string>(),
      reasons: new Set<string>(),
      scopeHints: new Set<string>(),
    };
    existing.environments.add(environment);
    existing.reasons.add(reason);
    scopeHints.forEach((scopeHint) => existing.scopeHints.add(scopeHint));
    required.set(key, existing);
  };

  const devops = resolveDevOpsSelection(spec);
  for (const [envName, envSpec] of Object.entries(spec.environments)) {
    add(envSpec.hosting.provider, envName, 'hosting');
    if (envSpec.database) add(envSpec.database.provider, envName, 'database');
    if (envSpec.cache) add(envSpec.cache.provider, envName, 'cache');
    if (envSpec.domain) {
      add('cloudflare', envName, envSpec.domainRegistration ? 'domain registration and DNS' : 'domain DNS', [
        ...cloudflareScopeHintsForDomain(envSpec.domain),
      ]);
    }
    if (envSpec.email.enabled) add('sendgrid', envName, 'transactional email');
    if (envSpec.messaging) add('twilio', envName, 'programmable messaging');
    if (envSpec.deploy?.strategy === 'branch' && envSpec.deploy.trigger !== 'native' && devops?.ci) {
      const registration = devOpsProviderRegistry.ciProvider(devops.ci.provider);
      add(
        registration?.connectionProvider ?? devops.ci.provider,
        envName,
        `${devops.ci.provider} deploy workflow`,
        [devops.code.scope]
      );
    }
    if (envSpec.ios) add('appstoreconnect', envName, 'iOS bundle ID / TestFlight', [envSpec.ios.bundleId]);
    if (envSpec.queues && Object.keys(envSpec.queues).length > 0) add(envSpec.hosting.provider, envName, 'queues');
    for (const storage of Object.values(envSpec.storage ?? {})) add(storage.provider, envName, 'object storage');
  }

  if (spec.github && spec.github.enabled !== false) {
    const repository = spec.github.repository ?? parseGitHubRepoFromRemote(spec.gitRemoteUrl);
    const environment = spec.github.canonicalEnvironment
      ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0] ?? 'repository');
    add('github', environment, 'GitHub repository infrastructure', repository ? [repository] : []);
    if (spec.github.pages?.customDomain) {
      add('cloudflare', environment, 'GitHub Pages custom-domain DNS', [
        ...cloudflareScopeHintsForDomain(spec.github.pages.customDomain),
      ]);
    }
    if (githubSpecNeedsOpenAI(spec.github)) {
      add('openai', environment, 'AI-backed GitHub automations', repository ? [repository] : []);
    }
  }

  const items = Array.from(required.values())
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((entry) => {
      const connectionProviders = providerRegistry.connectionProviders(entry.provider);
      const connections = connectionProviders.flatMap((connectionProvider) =>
        ctx.repos.connections.findAllByProvider(connectionProvider)
      );
      const scopeHints = Array.from(entry.scopeHints);
      const scopedConnection = scopeHints.length > 0
        ? connectionProviders
          .map((connectionProvider) => ctx.repos.connections.findBestMatchFromHints(connectionProvider, scopeHints))
          .find((candidate) => candidate !== null) ?? null
        : null;
      const verifiedScopedConnection = scopeHints.length > 0
        ? connectionProviders
          .map((connectionProvider) => ctx.repos.connections.findBestVerifiedMatchFromHints(connectionProvider, scopeHints))
          .find((candidate) => candidate !== null) ?? null
        : null;
      const verified = scopeHints.length > 0
        ? Boolean(verifiedScopedConnection)
        : connections.some((connection) => connection.status === 'verified');
      const scope = scopeHints[0];
      let status = 'missing';
      if (verified) {
        status = 'verified';
      } else if (scopeHints.length > 0 && scopedConnection) {
        status = 'unverified';
      } else if (scopeHints.length === 0 && connections.length > 0) {
        status = 'unverified';
      }
      const connectionBlock = {
        provider: entry.provider,
        reason: Array.from(entry.reasons).join(', '),
        ...(scope ? { scope } : {}),
      };
      return {
        provider: entry.provider,
        status,
        environments: Array.from(entry.environments).sort(),
        reasons: Array.from(entry.reasons).sort(),
        ...(scope ? { scope } : {}),
        ...(!verified ? {
          connectionSetup: connectionRecoveryDetails([connectionBlock], {
            project: spec.project,
            gitRemoteUrl: spec.gitRemoteUrl,
          }).connectionSetup[0],
        } : {}),
        hint: verified
          ? undefined
          : connectionRecoveryHint(
            [connectionBlock],
            { after: 'Then run hv_plan.' }
          ),
      };
    });

  return {
    required: items,
    missing: items.filter((item) => item.status !== 'verified'),
  };
}

export function registerCoreTools(commands: CommandRegistrar, ctx: CommandContext): void {
  const specStore = new SpecStore();
  const planService = new PlanService();

  commands.register(
    'hv_spec',
    'Read or update the desired-state ProjectSpec used by hv_plan. Omit spec to read. In a fresh git repository, that read returns a successful uninitialized contract with native runtime, lockfile/package-manager, build-script, and start-script evidence; one unambiguous concrete Node or Python selection plus reviewed install/build commands is persisted on initial write. Missing/conflicting commands, custom languages, and ambiguous projects require an explicit decision or repository Dockerfile. Later native drift is suggested for review, never applied silently. When spec is supplied, it merges by default; use replace=true for full replacement and null to delete a field. In a git worktree Hypervibe syncs .hypervibe/spec.json. Secret declarations contain ownership and targets, never values.',
    {
      project: projectField,
      spec: z.record(z.unknown()).optional().describe('Full ProjectSpec or partial patch. Omit to read the current spec. Main fields are project, runtime, github, secrets, and environments; environment resources include hosting, services, databases, caches, storage, queues, domains, email, deploy, migrations, and iOS.'),
      replace: z.boolean().optional().describe('Replace the entire spec instead of merging'),
      confirmNativeDeploy: z.boolean().optional().describe('Required when introducing deploy.trigger="native"; acknowledges provider-native deploys are provider-specific and may require external repository-app access.'),
    },
    wrapCommandHandler(async ({ project: projectRef, spec, replace, confirmNativeDeploy }) => {
      if (!spec) {
        if (replace !== undefined || confirmNativeDeploy !== undefined) {
          return commandError('VALIDATION', 'replace and confirmNativeDeploy require spec input.', {
            hint: 'Pass spec to update desired state, or omit mutation fields to read it.',
          });
        }
        const project = ctx.resolveProject({ project: projectRef });
        if (!project) {
          const candidate = freshProjectCandidate(projectRef);
          if (!candidate) {
            ctx.resolveProjectOrThrow({ project: projectRef });
            throw new Error('Project resolution unexpectedly returned no result.');
          }
          const repositoryRuntime = analyzeRepositoryRuntime(findRepoRoot());
          const example = `hv_spec project="${candidate.name}" spec={"project":"${candidate.name}","environments":{...}}`;
          return commandSuccess({
            initialized: false,
            project: {
              name: candidate.name,
              gitRemoteUrl: candidate.gitRemoteUrl ?? null,
            },
            revision: null,
            specSource: null,
            spec: null,
            repositoryRuntime,
            bootstrap: {
              required: true,
              nextCommand: 'hv_spec',
              requiredSpecFields: ['project', 'environments'],
              ...(repositoryRuntime.runtime
                ? { suggestedRuntime: repositoryRuntime.runtime }
                : {}),
            },
          }, {
            hint: `This is a normal fresh-project state. ${repositoryRuntime.guidance} Inspect the repository and choose its desired environments and providers, then initialize it with ${example}. Do not run hv_plan or hv_deploy before that write succeeds.`,
            next: ['hv_spec'],
            agentInstruction: {
              action: 'continue',
              message: 'This repository is not initialized yet. Continue by inspecting the repository and calling hv_spec with its complete initial desired state; do not stop merely because no prior Hypervibe project exists.',
            },
          });
        }
        const result = specStore.get(project);
        if (!result) {
          return commandError('NOT_FOUND', `Project "${project.name}" has no spec yet.`, {
            hint: 'Define one by calling hv_spec with spec input.',
          });
        }
        const gitRemoteUrl = project.gitRemoteUrl ?? result.spec.gitRemoteUrl ?? null;
        const repositoryRuntime = analyzeRepositoryRuntime(repositoryRootForProject(project.name));
        const runtimeReview = reviewRepositoryRuntime(result.spec.runtime, repositoryRuntime);
        const checkRuntimeIssues = result.spec.github
          ? unresolvedGitHubCheckRuntimeIssues(result.spec.github, result.spec.runtime)
          : [];
        const extras = result.adopted && result.source?.kind === 'repo'
          ? { warnings: [
            `${result.source.path} changed outside hypervibe; recorded as revision ${result.revision}.`,
            ...(runtimeReview.status === 'review-required' ? [runtimeReview.message] : []),
            ...checkRuntimeIssues,
          ] }
          : runtimeReview.status === 'review-required' || checkRuntimeIssues.length > 0
            ? { warnings: [
              ...(runtimeReview.status === 'review-required' ? [runtimeReview.message] : []),
              ...checkRuntimeIssues,
            ] }
            : undefined;
        return commandSuccess({
          project: { id: project.id, name: project.name, gitRemoteUrl },
          revision: result.revision,
          specSource: result.source ?? { kind: 'local' },
          spec: result.spec,
          repositoryRuntime,
          runtimeReview,
          connections: requiredConnectionChecklist(ctx, result.spec),
        }, extras);
      }

      const specProject = typeof spec.project === 'string' && spec.project.trim()
        ? spec.project.trim()
        : undefined;
      let project = ctx.resolveProject({ project: projectRef });
      let newProject: { name: string; gitRemoteUrl?: string } | null = null;
      if (project && specProject && specProject !== project.name) {
        throw new HvError('VALIDATION', `Spec project "${specProject}" does not match selected project "${project.name}".`, {
          details: { selectedProject: project.name, specProject },
          hint: 'Remove spec.project from the patch or make it match the selected Hypervibe project.',
        });
      }
      if (!project) {
        const requestedProject = projectRef?.trim();
        if (requestedProject && specProject && requestedProject !== specProject) {
          throw new HvError('VALIDATION', `Spec project "${specProject}" does not match selected project "${requestedProject}".`, {
            details: { selectedProject: requestedProject, specProject },
            hint: 'Use the same project name in project and spec.project.',
          });
        }
        const name = specProject || requestedProject;
        if (!name) {
          throw new HvError('NOT_FOUND', 'No project found and no name provided.', {
            hint: 'Pass project (or spec.project) to create a new project.',
          });
        }
        const localCandidate = freshProjectCandidate(name);
        const gitRemoteUrl = gitRemoteUrlFromSpecInput(spec)
          ?? (localCandidate?.name === name ? localCandidate.gitRemoteUrl : undefined);
        newProject = {
          name,
          ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
        };
      }

      let result;
      let coverageReport: EnvironmentVariableCoverageReport = { complete: true, issues: [] };
      try {
        const projectName = project?.name ?? newProject!.name;
        const previousSpec = project ? specStore.get(project)?.spec ?? null : null;
        const baseSpec = previousSpec ?? { version: 1 as const, project: projectName, environments: {} };
        const mergedInput = replace
          ? {
            version: 1,
            project: projectName,
            ...spec,
          }
          : deepMergeSpec(baseSpec, spec);
        const repositoryRuntime = analyzeRepositoryRuntime(repositoryRootForProject(projectName));
        const mergedRecord = asRecord(mergedInput);
        const repositoryMatchesProject = !project
          && freshProjectCandidate(projectName)?.name === projectName;
        const candidateInput = !previousSpec
          && repositoryMatchesProject
          && mergedRecord
          && !Object.prototype.hasOwnProperty.call(mergedRecord, 'runtime')
          && repositoryRuntime.runtime
          ? { ...mergedRecord, runtime: repositoryRuntime.runtime }
          : mergedInput;
        const candidateSpec = projectSpecSchema.parse(canonicalizeLegacyGitHubSpec(candidateInput));
        coverageReport = environmentVariableCoverage(candidateSpec);
        const previousIssueIds = new Set(
          previousSpec
            ? environmentVariableCoverage(previousSpec).issues.map(environmentVariableCoverageIssueId)
            : []
        );
        const introducedCoverageIssues = coverageReport.issues.filter(
          (issue) => !previousIssueIds.has(environmentVariableCoverageIssueId(issue))
        );
        if (introducedCoverageIssues.length > 0) {
          throw new HvError('VALIDATION', 'Environment-variable coverage is incomplete.', {
            details: introducedCoverageIssues,
            hint: 'Declare each key in every listed matching environment using a separately chosen envVars value, envFile include, or delegated-secret target. If a key intentionally does not apply, add it to that environment\'s envVarExceptions. Hypervibe never copies values between environments.',
          });
        }
        const nativeChanges = providerNativeDeployChanges(candidateSpec, previousSpec);
        if (nativeChanges.length > 0 && !confirmNativeDeploy) {
          throw new HvError('CONFIRM_REQUIRED', 'Provider-native branch deploys require explicit confirmation.', {
            details: nativeChanges,
            hint: nativeDeployConfirmationHint(nativeChanges),
          });
        }
        validateInstalledProviders(candidateSpec);
        if (!project) {
          const initialHostingProvider = Object.values(candidateSpec.environments)[0]?.hosting.provider;
          project = ctx.repos.projects.create({
            ...newProject!,
            ...(initialHostingProvider ? { defaultPlatform: initialHostingProvider } : {}),
          });
        }
        result = specStore.replace(project, candidateSpec);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new HvError('VALIDATION', 'Spec failed validation.', {
            details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            hint: 'Fix the listed fields and retry hv_spec.',
          });
        }
        throw error;
      }
      if (!project) {
        throw new Error('Project initialization completed without a project record.');
      }
      project = syncProjectGitRemoteUrl(ctx, project, result.spec);
      const connections = requiredConnectionChecklist(ctx, result.spec);
      const localEnv = mergeLocalEnvWrites(
        result.localEnv,
        ensureProjectLocalEnv({
          source: result.source,
          projectName: project.name,
          projectGitRemoteUrl: project.gitRemoteUrl,
          spec: result.spec,
          connectionBlocks: connections.missing,
        })
      );
      const repositoryRuntime = analyzeRepositoryRuntime(repositoryRootForProject(project.name));
      const runtimeReview = reviewRepositoryRuntime(result.spec.runtime, repositoryRuntime);
      const checkRuntimeIssues = result.spec.github
        ? unresolvedGitHubCheckRuntimeIssues(result.spec.github, result.spec.runtime)
        : [];
      const nativeDeploys = providerNativeDeployChanges(result.spec, null);
      const warnings = [
        ...(nativeDeploys.length > 0 ? [nativeDeployConfirmationHint(nativeDeploys)] : []),
        ...(runtimeReview.status === 'review-required' ? [runtimeReview.message] : []),
        ...checkRuntimeIssues,
        ...(coverageReport.issues.length > 0
          ? [`The spec still has ${coverageReport.issues.length} pre-existing environment-variable coverage gap(s). Unrelated changes remain allowed, but new gaps are blocked.`]
          : []),
      ];

      return commandSuccess(
        {
          project: { id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl ?? null },
          revision: result.revision,
          specSource: result.source ?? { kind: 'local' },
          envTemplate: result.envTemplate ?? null,
          localEnv: localEnv ?? null,
          spec: result.spec,
          repositoryRuntime,
          runtimeReview,
          environmentVariableCoverage: coverageReport,
          connections,
        },
        {
          hint: connections.missing.length > 0
            ? connectionRecoveryHint(connections.missing, { project: project.name, gitRemoteUrl: project.gitRemoteUrl, after: 'Then run hv_plan.' })
            : undefined,
          warnings,
          next: connections.missing.length > 0 ? ['hv_connections', 'hv_plan'] : ['hv_plan'],
        }
      );
    })
  );

  commands.register(
    'hv_plan',
    'Observe live infrastructure, diff it against the desired spec, and persist an executable plan. Returns planId plus a compact review of non-noop actions; hv_apply requires that planId. scope="retained-cleanup" isolates confirm-gated destruction of exact abandoned hosting, database, cache, and provider-declared resource identities retained through hv_import; it excludes ordinary deployment, integrations, domain, email, and repository work. Missing connections block unsafe work. Hypervibe-owned application secrets are generated automatically inside the encrypted plan boundary. Externally owned values are accepted only through secretRefs and are never returned. Optional services restricts a full plan to selected services.',
    {
      project: projectField,
      env: envField,
      scope: z.enum(['full', 'retained-cleanup']).optional().describe('Default full. Use retained-cleanup to persist only exact retained abandoned-host, database, cache, or provider-resource destroy actions.'),
      services: z.array(z.string().min(1)).optional().describe('Restrict the plan to these spec services (partial deploy). Must be a subset of the spec services.'),
      envVars: z.record(z.string()).optional().describe('One-off env var overrides for this plan only; values are encrypted in the stored plan and win over .env and spec envVars at apply. Durable non-secret values belong in the spec.'),
      envFile: z.string().optional().describe('Local .env file to consider as deploy input. Defaults to .env.<env>, creating it from repo .env when missing and syncing newly added base keys when present. Selection follows spec envFile policy; values are encrypted in the stored plan and never returned.'),
      includeEnvFile: z.boolean().optional().describe('Set false to skip the default repo .env deploy input. Ignored for repository-only plans, which never load deploy env files.'),
      secretRefs: z.record(z.string()).optional().describe('Chat-safe local/secret-manager references for delegated secret slots, keyed by declared env var name. Values are resolved locally and encrypted into this plan; never pass raw secrets here.'),
    },
    wrapCommandHandler(async ({ project: projectRef, env, scope, services, envVars, envFile, includeEnvFile, secretRefs }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      if (scope === 'retained-cleanup') {
        const incompatibleInputs = [
          services !== undefined ? 'services' : null,
          envVars !== undefined ? 'envVars' : null,
          envFile !== undefined ? 'envFile' : null,
          includeEnvFile !== undefined ? 'includeEnvFile' : null,
          secretRefs !== undefined ? 'secretRefs' : null,
        ].filter((name): name is string => Boolean(name));
        if (incompatibleInputs.length > 0) {
          return commandError(
            'VALIDATION',
            `scope="retained-cleanup" does not accept deploy inputs: ${incompatibleInputs.join(', ')}.`,
            {
              hint: 'Remove deploy inputs so the plan can authorize only retained infrastructure teardown actions.',
              next: ['hv_plan'],
            }
          );
        }
      }
      const currentSpecResult = specStore.get(project);
      const currentSpec = currentSpecResult?.spec;
      if (currentSpec) validateInstalledProviders(currentSpec);
      const plannedEnvironment = currentSpec ? commandEnvironment(currentSpec, env) : env?.trim() || 'staging';
      // Local dotenv preparation is part of the hv_plan contract. Establish
      // its git-safety and filesystem boundary before PlanService persists an
      // executable plan, so an unsafe tracked .env cannot leave an undisclosed
      // authorization record behind.
      const preparedLocalEnv = currentSpec
        ? ensureProjectLocalEnv({
          source: currentSpecResult?.source,
          projectName: project.name,
          projectGitRemoteUrl: project.gitRemoteUrl,
          ...(scope === 'retained-cleanup' ? {} : { spec: currentSpec }),
          verifyRepoSafety: true,
        })
        : undefined;
      const result = await planService.plan(project, plannedEnvironment, {
        ...(scope ? { scope } : {}),
        ...(services?.length ? { serviceFilter: services } : {}),
        ...(envVars && Object.keys(envVars).length > 0 ? { envVarOverrides: envVars } : {}),
        ...(envFile ? { envFile } : {}),
        ...(includeEnvFile !== undefined ? { includeEnvFile } : {}),
        ...(secretRefs && Object.keys(secretRefs).length > 0 ? { secretRefs } : {}),
      });
      if ('error' in result) {
        return commandError('VALIDATION', result.error, { next: ['hv_spec'] });
      }
      const plannedEnvironmentSpec = specStore.get(project)?.spec.environments[result.environmentName];

      const confirmIds = result.actions.filter((a) => a.requiresConfirm).map((a) => a.id);
      const pending = result.actions.filter((a) => a.type !== 'noop');
      const reviewActions = pending.map(({ metadata: _metadata, ...action }) => action);
      const { hardBlocked, actionScopedBlocked } = splitActionScopedConnectionBlocks(result.blocked, result.actions);
      const connectBeforeApply = actionScopedBlocksRequiringConnectBeforeApply(actionScopedBlocked);
      const softActionScopedBlocked = actionScopedBlocksAllowedDuringApply(actionScopedBlocked);
      let localEnv: RepoEnvFileWrite | undefined;
      try {
        localEnv = mergeLocalEnvWrites(
          preparedLocalEnv,
          ensureProjectLocalEnv({
            source: currentSpecResult?.source,
            projectName: project.name,
            projectGitRemoteUrl: project.gitRemoteUrl,
            spec: currentSpec,
            connectionBlocks: [...hardBlocked, ...actionScopedBlocked],
          })
        );
      } catch (error) {
        // The safety preflight above makes this a narrow race (for example,
        // the checkout changed while provider observation was running). Keep
        // the already-persisted authorization visible and explicitly unusable
        // instead of returning an error that hides the plan id.
        return commandError(
          'INTERNAL',
          `Plan "${result.planRunId}" was saved, but Hypervibe could not finish preparing the local .env file: ${error instanceof Error ? error.message : String(error)}`,
          {
            details: {
              planId: result.planRunId,
              environment: result.environmentName,
              scope: result.scope,
              persisted: true,
            },
            hint: 'Do not apply this plan. Fix the local .env tracking or filesystem problem, then rerun hv_plan to create a fresh disclosed plan.',
            next: ['hv_plan'],
          }
        );
      }
      const actionScopedWarnings = [
        ...connectBeforeApply.map((entry) =>
          `${entry.reason} Connect this provider before applying the plan.`
        ),
        ...softActionScopedBlocked.map((entry) =>
          `${entry.reason} This blocks only the related action; independent service and CI actions can still be applied from this plan.`
        ),
      ];
      let hint: string;
      let next: string[] | undefined;

      if (hardBlocked.length > 0) {
        hint = connectionRecoveryHint(hardBlocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl, after: 'Do not run hv_apply until these connections verify; then re-run hv_plan and hv_apply.' });
      } else if (connectBeforeApply.length > 0) {
        hint = connectionRecoveryHint(connectBeforeApply, {
          project: project.name,
          gitRemoteUrl: project.gitRemoteUrl,
          includePackageRead: true,
          after: 'Then re-run hv_plan and hv_apply. GitHub Actions push-to-deploy cannot converge until these credentials are available.',
        });
      } else if (result.inputRequired.length > 0) {
        hint = `Delegated secret input required: ${result.inputRequired.map((entry) => `${entry.key} (${entry.principal})`).join(', ')}. If the value and provider access are available on this Mac, re-run hv_plan with secretRefs mapping each key to env:, dotenv:, file:, or a secret-manager reference. Otherwise prepare a value-free handoff naming the key, environment, and principal for the project owner; the value can be transferred through their agreed external channel or shared secret manager. Do not paste raw values into chat.`;
      } else if (pending.length === 0) {
        hint = 'Everything is in sync — nothing to apply.';
      } else if (softActionScopedBlocked.length > 0) {
        hint = connectionRecoveryHint(softActionScopedBlocked, {
          project: project.name,
          gitRemoteUrl: project.gitRemoteUrl,
          after: 'Connect them for full convergence, or apply this plan to converge independent actions and fail only blocked actions.',
        });
      } else {
        hint = `Apply with hv_apply planId="${result.planRunId}"${confirmIds.length ? ` and confirmActions=${JSON.stringify(confirmIds)} for consequential actions that require explicit confirmation` : ''}.`;
      }

      if (hardBlocked.length > 0) {
        next = ['hv_connections', 'hv_plan'];
      } else if (result.inputRequired.length > 0) {
        next = ['hv_plan'];
      } else if (pending.length > 0) {
        next = connectBeforeApply.length > 0
          ? ['hv_connections', 'hv_plan']
          : softActionScopedBlocked.length > 0
            ? ['hv_connections', 'hv_apply']
            : ['hv_apply'];
      }

      return commandSuccess(
        {
          planId: result.planRunId,
          scope: result.scope,
          environment: result.environmentName,
          ...(plannedEnvironmentSpec && managedDatabaseContract(plannedEnvironmentSpec)
            ? { managedDatabase: managedDatabaseContract(plannedEnvironmentSpec) }
            : {}),
          specRevision: result.specRevision,
          specSource: result.specSource ?? { kind: 'local' },
          ...(localEnv ? { localEnv } : {}),
          verified: result.verified,
          summary: summarizeActions(result.actions),
          totalActionCount: result.actions.length,
          pendingActionCount: pending.length,
          noopActionCount: result.actions.length - pending.length,
          actions: reviewActions,
          unmanaged: result.unmanaged,
          inputRequired: result.inputRequired.length > 0 ? result.inputRequired : undefined,
          blocked: hardBlocked,
          actionScopedBlocked: actionScopedBlocked.length > 0 ? actionScopedBlocked : undefined,
          ...(result.blocked.length > 0 || actionScopedBlocked.length > 0
            ? connectionRecoveryDetails([...result.blocked, ...actionScopedBlocked], { project: project.name, gitRemoteUrl: project.gitRemoteUrl })
            : {}),
        },
        {
          hint,
          warnings: [...result.warnings, ...actionScopedWarnings],
          next,
          ...(result.inputRequired.length > 0
            ? {
              agentInstruction: {
                action: 'ask_user' as const,
                message: 'Stop before apply. Use a safe local secretRef when the value is available here; otherwise prepare a value-free owner handoff naming the delegated key, environment, and principal.',
              },
            }
            : {}),
        }
      );
    })
  );

  commands.register(
    'hv_status',
    'Show desired vs observed infrastructure state for an environment: drift, unmanaged resources, blocked connections, managed database-variable attachment, pending runtime rollouts, and observed service endpoints. inSync requires a provider-observed post-configuration deployment whenever the provider reports that activation is still pending; runtimeHealth remains unverified until hv_health or worker log/error evidence is checked. Uses repo-backed .hypervibe/spec.json/.hypervibe/bindings.json when present. Read-only; does not persist a plan.',
    { project: projectField, env: envField },
    wrapCommandHandler(async ({ project: projectRef, env }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = specStore.get(project);
      if (!specResult) {
        return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, { hint: 'Define one with hv_spec.' });
      }
      validateInstalledProviders(specResult.spec);
      const envName = commandEnvironment(specResult.spec, env);
      const envSpec = specResult.spec.environments[envName];
      if (!envSpec) {
        if (shouldPlanGitHubInfrastructure(specResult.spec, envName)) {
          const projectForStatus = projectWithSpecGitRemoteUrl(project, specResult.spec);
          const github = await planGitHubInfrastructure({
            project: projectForStatus,
            spec: specResult.spec,
            environmentName: envName,
          });
          const blocked = [
            ...planService.projectPreflight(projectForStatus, specResult.spec, envName),
            ...github.blocked,
          ];
          const drift = github.actions.filter((action) => action.type !== 'noop');
          return commandSuccess({
            environment: envName,
            specRevision: specResult.revision,
            specSource: specResult.source ?? { kind: 'local' },
            verified: github.actions.every((action) => action.verified),
            inSync: drift.length === 0,
            summary: summarizeActions(github.actions),
            drift: drift.map(({ metadata: _metadata, ...action }) => action),
            unmanaged: [],
            blocked,
            ...(blocked.length > 0 ? connectionRecoveryDetails(blocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl }) : {}),
          }, {
            warnings: github.warnings,
            hint: blocked.length > 0
              ? connectionRecoveryHint(blocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl, after: 'Then rerun hv_status or hv_plan.' })
              : drift.length > 0
                ? 'Run hv_plan to get an executable plan for this drift.'
                : 'Repository infrastructure is in sync.',
            next: blocked.length > 0 ? ['hv_connections'] : drift.length > 0 ? ['hv_plan'] : undefined,
          });
        }
        return commandError('NOT_FOUND', `Spec has no environment "${envName}".`, {
          details: { available: Object.keys(specResult.spec.environments) },
        });
      }

      const environment = ctx.repos.environments.findByProjectAndName(project.id, envName);
      const projectForStatus = projectWithSpecGitRemoteUrl(project, specResult.spec);
      const { observed, warnings } = await planService.observeEnvironment(projectForStatus, environment, envSpec);
      const local = planService.buildLocalSnapshot(projectForStatus, environment);
      const managedDatabaseEnvVars = buildManagedDatabaseEnvVars(
        envSpec.database,
        local.components
      );
      const localCache = local.components.find((component) => component.type === 'redis');
      const localCacheProvider = typeof localCache?.bindings.provider === 'string'
        ? localCache.bindings.provider
        : undefined;
      const managedCacheEnvVars = envSpec.cache
        && localCache
        && localCacheProvider === envSpec.cache.provider
        ? buildCacheEnvVarsFromComponent(localCache).envVars
        : undefined;
      const hostingMetadata = providerRegistry.getMetadata(envSpec.hosting.provider);
      const diff = diffEnvironment({
        spec: envSpec,
        envName,
        observed,
        local,
        providerBehavior: hostingMetadata?.orchestration?.diff,
        customDomainManagement: hostingMetadata?.lifecycle?.hosting?.customDomains,
        customDomainTrafficProxy: hostingMetadata?.lifecycle?.hosting?.domainTrafficProxy,
        expectedSource: planService.expectedDeploySource(projectForStatus, envName, envSpec),
        managedDatabaseEnvVars,
        managedCacheEnvVars,
      });
      const drift = diff.actions.filter((a) => a.type !== 'noop');
      const cache = planCache({
        environmentSpec: envSpec,
        observed,
        local,
      });
      const cacheDrift = cache.actions.filter((action) => action.type !== 'noop');
      const databaseResilience = planDatabaseResilience({
        environmentSpec: envSpec,
        observed,
        local,
        capabilities: providerRegistry.getMetadata(envSpec.database?.provider ?? '')
          ?.lifecycle?.databaseResilience,
      });
      const databaseResilienceDrift = databaseResilience.actions.filter((action) => action.type !== 'noop');
      const nativeDeploySources = planProviderNativeDeploySources({
        environmentSpec: envSpec,
        observed,
        providerDisplayName: hostingMetadata?.displayName ?? envSpec.hosting.provider,
        nonNativeSourcePolicy: hostingMetadata?.orchestration?.nativeBranchDeploy?.nonNativeSourcePolicy,
      });
      const nativeDeploySourceDrift = nativeDeploySources.actions.filter((action) => action.type !== 'noop');
      const maintenance = observed && environment
        ? planMaintenance({
            environmentName: envName,
            environmentSpec: envSpec,
            environment,
            observed,
          })
        : { actions: [] as PlanAction[], pending: false, providers: [] as string[], warnings: [] as string[] };
      const maintenanceDrift = maintenance.actions.filter((action) => action.type !== 'noop');

      const expectedSource = planService.expectedDeploySource(projectForStatus, envName, envSpec);
      const observedSources = Object.fromEntries(
        (observed?.services ?? [])
          .filter((s) => s.source?.repo)
          .map((s) => [s.name, `${s.source!.repo}${s.source!.branch ? `@${s.source!.branch}` : ''}`])
      );
      // Catches provider-native source links whose external repository app can
      // no longer see the repository, where pushes silently do not deploy.
      const sourceWarnings = await planService.checkBranchDeploySource(projectForStatus, envSpec);
      const observedServicesByName = new Map((observed?.services ?? []).map((service) => [service.name, service]));
      const expectedServiceNames = Object.keys(envSpec.services);
      const expectedRepo = normalizeGitSourceRepo(expectedSource?.repo);
      const allServicesLinkedToExpectedSource = Boolean(
        expectedSource
        && expectedServiceNames.length > 0
        && expectedServiceNames.every((serviceName) => {
          const source = observedServicesByName.get(serviceName)?.source;
          return normalizeGitSourceRepo(source?.repo) === expectedRepo
            && source?.branch === expectedSource.branch;
        })
      );

      const deployStrategy = envSpec.deploy?.strategy ?? 'manual';
      const deployTrigger = deployStrategy === 'branch' ? envSpec.deploy?.trigger ?? 'ci' : undefined;
      const ciDeploy = deployTrigger === 'ci'
        ? await planManagedCiDeploy({
          project: projectForStatus,
          spec: specResult.spec,
          environmentName: envName,
          environmentSpec: envSpec,
          environment,
        })
        : { actions: [] as PlanAction[], warnings: [] as string[] };
      const ciAction = ciDeploy.actions[0];
      const ciMetadata = asRecord(ciAction?.metadata);
      const ciWorkflow = asRecord(ciMetadata?.workflow);
      const ciNeedsSync = Boolean(ciAction && ciAction.type !== 'noop');
      const ciAutoDeployOnPush = booleanField(ciWorkflow, 'autoDeployOnPush')
        ?? (envSpec.deploy?.autoDeploy ?? !envName.toLowerCase().includes('prod'));
      const ciProvider = resolveDevOpsSelection(specResult.spec)?.ci?.provider;
      const ciDeploySource = deployStrategy === 'branch' && deployTrigger === 'ci'
        ? {
          provider: ciProvider ?? 'unavailable',
          setup: ciDeploy.error ? 'blocked' : ciNeedsSync ? 'needs-sync' : 'in-sync',
          ...(ciDeploy.error ? { error: ciDeploy.error } : {}),
          ...(ciWorkflow
            ? {
              workflow: {
                path: stringField(ciWorkflow, 'path'),
                branch: stringField(ciWorkflow, 'branch'),
                autoDeployOnPush: ciAutoDeployOnPush,
                ...(stringField(ciWorkflow, 'promoteFromEnvironment')
                  ? { promoteFromEnvironment: stringField(ciWorkflow, 'promoteFromEnvironment') }
                  : {}),
              },
            }
            : {}),
          ...(stringArrayField(ciMetadata, 'missingProviderSecrets')
            ? { missingProviderSecrets: stringArrayField(ciMetadata, 'missingProviderSecrets') }
            : {}),
          ...(stringArrayField(ciMetadata, 'staleProviderSecrets')
            ? { staleProviderSecrets: stringArrayField(ciMetadata, 'staleProviderSecrets') }
            : {}),
        }
        : undefined;
      const ciPushToDeploy = Boolean(deployStrategy === 'branch' && deployTrigger === 'ci' && !ciDeploy.error && !ciNeedsSync && ciAutoDeployOnPush);

      // iOS drift (identity + TestFlight) when the environment declares it.
      const ios = envSpec.ios
        ? await planIos({ project: projectForStatus, environmentSpec: envSpec, environment })
        : { actions: [] as PlanAction[], warnings: [] as string[] };
      const iosDrift = ios.actions.filter((action) => action.type !== 'noop');

      const queues = await planQueues({ project: projectForStatus, environmentSpec: envSpec, environment });
      const queueDrift = queues.actions.filter((action) => action.type !== 'noop');
      const storage = planStorage({ environmentSpec: envSpec, environment, observed });
      const storageDrift = storage.actions.filter((action) => action.type !== 'noop');
      const delegatedSecrets = planDelegatedSecrets({
        spec: specResult.spec,
        environmentName: envName,
        hostingProvider: envSpec.hosting.provider,
        environment: withReceiptValidatedManagedSecretBindings(environment, ctx.repos.runs),
        observed,
        generatedValues: deriveHypervibeSecretValues(specResult.spec, envName),
      });
      const delegatedSecretDrift = delegatedSecrets.actions.filter((action) => action.type !== 'noop');
      const stripeSync = await planStripeEnvironmentSync({
        environmentName: envName,
        environmentSpec: envSpec,
        environment,
        observed,
      });
      const stripeDrift = stripeSync.actions.filter((action) => action.type !== 'noop');
      const email = await planEmail({
        project: projectForStatus,
        environmentName: envName,
        environmentSpec: envSpec,
        environment,
        observed,
      });
      const emailDrift = email.actions.filter((action) => action.type !== 'noop');
      const messaging = await planTwilioMessaging({
        project: projectForStatus,
        environmentName: envName,
        environmentSpec: envSpec,
        environment,
        observed,
      });
      const messagingDrift = messaging.actions.filter((action) => action.type !== 'noop');
      const observationIncomplete = observed !== null && (
        observed.partial
        || Object.values(observed.completeness ?? {}).includes('unknown')
      );
      const restartRequirements = runtimeRolloutRequirements({
        environment,
        provider: envSpec.hosting.provider,
        observed,
      });
      const restartRequired = restartRequirements.length > 0;
      const hasConfigurationDrift = maintenanceDrift.length > 0
        || nativeDeploySourceDrift.length > 0
        || drift.length > 0
        || cacheDrift.length > 0
        || databaseResilienceDrift.length > 0
        || iosDrift.length > 0
        || queueDrift.length > 0
        || storageDrift.length > 0
        || delegatedSecretDrift.length > 0
        || stripeDrift.length > 0
        || emailDrift.length > 0
        || messagingDrift.length > 0;
      const blocked = planService.preflight(envSpec, envName, specResult.spec);
      for (const stripeBlock of stripeSync.blocked) {
        if (!blocked.some((entry) => entry.provider === 'stripe' && entry.scope === stripeBlock.scope)) {
          blocked.push(stripeBlock);
        }
      }
      const iosGroupActions = ios.actions.filter((action) => action.id.startsWith('ios:group:'));
      const iosStatus = envSpec.ios
        ? {
          bundleId: envSpec.ios.bundleId,
          bundleIdRegistered: ios.actions.some((action) => action.id.startsWith('ios:bundle-id:') && action.type === 'noop'),
          capabilitiesMissing: (ios.actions.find((action) => action.id.startsWith('ios:capabilities:'))?.metadata?.missingCapabilities as string[] | undefined) ?? [],
          appRecord: ios.actions.some((action) => action.id.startsWith('ios:app:'))
            ? (ios.actions.find((action) => action.id.startsWith('ios:app:'))!.type === 'noop' ? 'found' : 'missing')
            : 'unknown',
          groups: {
            inSync: iosGroupActions.filter((action) => action.type === 'noop').map((action) => action.resource.name),
            pending: iosGroupActions.filter((action) => action.type !== 'noop').map((action) => action.resource.name),
          },
        }
        : undefined;
      const nativePushToDeploy = Boolean(
        deployStrategy === 'branch'
        && deployTrigger === 'native'
        && expectedSource
        && allServicesLinkedToExpectedSource
        && sourceWarnings.length === 0
      );

      return commandSuccess(
        {
          environment: envName,
          ...(managedDatabaseContract(envSpec)
            ? { managedDatabase: managedDatabaseContract(envSpec) }
            : {}),
          specRevision: specResult.revision,
          specSource: specResult.source ?? { kind: 'local' },
          verified: observed !== null && !observed.partial,
          ...(observed
            ? {
              observedAt: observed.observedAt,
              services: observed.services.map((service) => {
                const url = sanitizeServiceUrl(service.url);
                const customDomains = sanitizeCustomDomains(service.customDomains);
                return {
                  name: service.name,
                  status: service.status,
                  ...(url ? { url } : {}),
                  ...(customDomains.length > 0 ? { customDomains } : {}),
                };
              }),
            }
            : {}),
          inSync: !observationIncomplete && !hasConfigurationDrift && !restartRequired,
          restartRequired,
          runtimeConfiguration: {
            status: restartRequired ? 'restart_required' : 'current',
            ...(restartRequired ? { services: restartRequirements } : {}),
          },
          runtimeHealth: runtimeHealthSummary(observed),
          ...(envSpec.maintenance || parseEnvironmentMaintenanceBinding(environment)
            ? {
                maintenance: {
                  desired: envSpec.maintenance?.enabled === true,
                  observed: observed?.maintenance?.state ?? 'unknown',
                  stage: observed?.maintenance?.stage ?? 'unknown',
                },
              }
            : {}),
          summary: summarizeActions([...maintenance.actions, ...nativeDeploySources.actions, ...diff.actions, ...cache.actions, ...databaseResilience.actions, ...ios.actions, ...queues.actions, ...storage.actions, ...delegatedSecrets.actions, ...stripeSync.actions, ...email.actions, ...messaging.actions]),
          drift: [...maintenanceDrift, ...nativeDeploySourceDrift, ...drift, ...cacheDrift, ...databaseResilienceDrift, ...iosDrift, ...queueDrift, ...storageDrift, ...delegatedSecretDrift, ...stripeDrift, ...emailDrift, ...messagingDrift],
          unmanaged: [...diff.unmanaged, ...cache.unmanaged, ...databaseResilience.unmanaged, ...storage.unmanaged],
          ...(envSpec.database?.resilience
            ? {
              databaseResilience: observed?.databases.find((database) => {
                const component = local.components.find((candidate) => candidate.type === envSpec.database?.engine);
                const boundExternalId = component?.externalId
                  ?? (typeof component?.bindings.instanceId === 'string' ? component.bindings.instanceId : undefined);
                return database.provider === envSpec.database?.provider
                  && (!boundExternalId || database.externalId === boundExternalId);
              })?.resilience ?? { status: 'unknown' },
            }
            : {}),
          inputRequired: delegatedSecrets.inputRequired.length > 0 ? delegatedSecrets.inputRequired : undefined,
          secretBlockers: delegatedSecrets.blockers.length > 0 ? delegatedSecrets.blockers : undefined,
          blocked,
          ...(blocked.length > 0 ? connectionRecoveryDetails(blocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl }) : {}),
          ...(iosStatus ? { ios: iosStatus } : {}),
          deploySource: {
            strategy: deployStrategy,
            ...(deployTrigger ? { trigger: deployTrigger } : {}),
            ...(expectedSource ? { expected: `${expectedSource.repo}@${expectedSource.branch}` } : {}),
            observed: observedSources,
            ...(deployStrategy === 'branch' && deployTrigger === 'ci'
              ? { ci: ciDeploySource }
              : {}),
            pushToDeploy: ciPushToDeploy || nativePushToDeploy,
          },
        },
        {
          warnings: [...warnings, ...maintenance.warnings, ...nativeDeploySources.warnings, ...diff.warnings, ...cache.warnings, ...databaseResilience.warnings, ...sourceWarnings, ...ciDeploy.warnings, ...ios.warnings, ...queues.warnings, ...storage.warnings, ...delegatedSecrets.warnings, ...stripeSync.warnings, ...email.warnings, ...messaging.warnings],
          hint: blocked.length > 0
            ? connectionRecoveryHint(blocked, {
              project: project.name,
              gitRemoteUrl: project.gitRemoteUrl,
              after: 'After the connection verifies, rerun hv_status or hv_plan. Do not ask to run hv_plan for DNS/domain drift until the required connection is verified.',
            })
            : sourceWarnings.length > 0
              ? `Fix ${hostingMetadata?.displayName ?? envSpec.hosting.provider} native repository access and contributor permissions, then rerun hv_status or hv_plan.`
              : deployStrategy === 'branch' && deployTrigger === 'ci' && (ciNeedsSync || ciDeploy.error)
                ? 'Run hv_plan and hv_apply to converge the selected managed CI provider; use hv_ci_status for runs after configuration is active.'
              : delegatedSecrets.inputRequired.length > 0
                ? 'Use a safe local secretRef if the value is available here; otherwise prepare a value-free handoff naming the delegated key, environment, and principal. Do not paste raw secret values into chat.'
              : delegatedSecrets.blockers.length > 0
                ? `Resolve the managed-secret safety block before planning: ${delegatedSecrets.blockers.map((entry) => entry.reason).join('; ')}.`
              : hasConfigurationDrift
                ? 'Run hv_plan to get an executable plan for this drift.'
                : restartRequired
                  ? deployStrategy === 'branch' && deployTrigger === 'ci'
                    ? `Runtime configuration is attached, but ${restartRequirements.map((entry) => entry.service).join(', ')} still ${restartRequirements.length === 1 ? 'runs' : 'run'} a deployment from before the change. Trigger the managed CI deployment${stringField(ciWorkflow, 'path') ? ` (${stringField(ciWorkflow, 'path')})` : ''} with hv_ci_trigger, inspect it with hv_ci_status, then rerun hv_status. Use hv_health for HTTP services and hv_logs source="service" errorsOnly=true for workers.`
                    : `Runtime configuration is attached, but ${restartRequirements.map((entry) => entry.service).join(', ')} still ${restartRequirements.length === 1 ? 'runs' : 'run'} a deployment from before the change. Complete a deployment through the configured release path, then rerun hv_status.`
                : 'Configuration is in sync, but runtime health is unverified. Use hv_health for HTTP services and hv_logs source="service" errorsOnly=true for workers.',
          next: blocked.length > 0
            ? ['hv_connections']
            : !hasConfigurationDrift && restartRequired && deployStrategy === 'branch' && deployTrigger === 'ci'
              ? ['hv_ci_trigger', 'hv_ci_status', 'hv_status']
              : undefined,
        }
      );
    })
  );

  commands.register(
    'hv_apply',
    'Apply a plan produced by hv_plan. Rejects stale plans (spec changed, infrastructure changed, plan expired, or already applied). Any consequential confirmation-gated action runs only when its exact action id is passed in confirmActions.',
    {
      project: projectField,
      planId: z.string().describe('Plan id returned by hv_plan'),
      confirmActions: z.array(z.string()).optional().describe('Exact action ids for consequential confirmation-gated changes such as purchases, deletion, or an application-secret rotation.'),
    },
    wrapCommandHandler(async ({ project: projectRef, planId, confirmActions }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const specResult = specStore.get(project);
      if (!specResult) {
        return commandError('NOT_FOUND', `Project "${project.name}" has no spec.`, { hint: 'hv_spec, then hv_plan.' });
      }
      validateInstalledProviders(specResult.spec);

      const outcome = await executePlanApply(ctx, {
        project,
        spec: specResult.spec,
        specRevision: specResult.revision,
        planId,
        confirmActions: confirmActions ?? [],
      });

      if (outcome.kind === 'invalid_spec') {
        return commandError('VALIDATION', outcome.message, {
          hint: outcome.hint,
          details: outcome.details,
          next: ['hv_spec', 'hv_plan'],
        });
      }
      if (outcome.kind === 'plan_not_found') {
        return commandError('NOT_FOUND', outcome.error, { next: ['hv_plan'] });
      }
      if (outcome.kind === 'env_missing') {
        return commandError('VALIDATION', `Spec no longer has environment "${outcome.envName}".`, { next: ['hv_plan'] });
      }
      if (outcome.kind === 'input_required') {
        return commandError('VALIDATION', 'This plan is missing required delegated secret inputs.', {
          details: { environment: outcome.envName, inputRequired: outcome.requirements },
          hint: 'Use safe local secretRefs for values available on this Mac. Otherwise prepare a value-free handoff naming each delegated key, environment, and principal for the project owner. Do not paste raw secrets into chat.',
          next: ['hv_plan'],
          agentInstruction: {
            action: 'ask_user',
            message: 'Stop before apply. Use safe local secret references when available, or prepare a value-free owner handoff for the delegated-secret slots.',
          },
        });
      }
      if (outcome.kind === 'blocked') {
        return commandError('MISSING_CONNECTION', `Missing verified connections: ${connectionProviders(outcome.applyBlocked).join(', ')}.`, {
          details: {
            blocked: outcome.applyBlocked,
            ...connectionRecoveryDetails(outcome.applyBlocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl }),
          },
          hint: connectionRecoveryHint(outcome.applyBlocked, { project: project.name, gitRemoteUrl: project.gitRemoteUrl, after: 'Then re-run hv_plan and hv_apply.' }),
          next: ['hv_connections', 'hv_plan', 'hv_apply'],
        });
      }

      const { result, envName } = outcome;
      const skipped = result.receipts.filter((r) => r.status === 'skipped_requires_confirm');
      const pending = result.receipts.filter((r) => r.status === 'pending');
      const blockedReceipts = result.receipts.filter((r) => r.status === 'blocked');
      if (!result.success && !result.applyRunId) {
        if (result.conflict) {
          const inProgress = result.conflict.kind !== 'already_applied';
          return commandError('VALIDATION', result.error ?? 'Apply rejected', {
            details: { applyConflict: result.conflict },
            hint: inProgress
              ? `Inspect apply run "${result.conflict.runId}" with hv_runs action="get". Do not start another apply until that run is no longer running.`
              : 'This persisted plan has already succeeded. Create a fresh plan from current observed state before applying again.',
            next: inProgress ? ['hv_runs'] : ['hv_plan'],
          });
        }
        // Rejected before execution (stale plan, superseded spec, etc.)
        return commandError('VALIDATION', result.error ?? 'Apply rejected', { next: ['hv_plan'] });
      }

      return commandSuccess(
        {
          applied: result.success,
          applyRunId: result.applyRunId,
          environment: envName,
          receipts: result.receipts,
          ...(outcome.bootstrapSummary ? { bootstrapSummary: outcome.bootstrapSummary } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        {
          hint: skipped.length > 0
            ? `Skipped confirm-gated actions: ${skipped.map((r) => r.actionId).join(', ')}. Re-run hv_plan, then hv_apply with confirmActions to execute them.`
            : blockedReceipts.length > 0
              ? `Apply is blocked by actions that need user/provider intervention: ${blockedReceipts.map((r) => r.actionId).join(', ')}. Inspect receipts, complete the required action, then re-run hv_plan and hv_apply.`
              : pending.length > 0
                ? `Apply has pending provider workflows: ${pending.map((r) => r.actionId).join(', ')}. Re-run hv_plan and hv_apply after they progress.`
            : result.success
              ? 'Apply complete. Check hv_status to verify convergence.'
              : 'Apply failed; compensations ran where registered. Inspect receipts and re-run hv_plan.',
          warnings: outcome.actionScopedWarnings,
          next: ['hv_status'],
        }
      );
    })
  );
}
