import { z } from 'zod';
import { parse as parseDomain } from 'tldts';

/**
 * The canonical desired-state document ("spec") for a project — the single
 * source of truth that hv_plan diffs against observed infrastructure and
 * hv_apply converges toward.
 *
 * One spec per project, with a section per environment. Apply runs against
 * one environment at a time.
 */

const environmentVariableNameSchema = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  'environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores'
);

/**
 * A concrete Node release usable by both actions/setup-node and the official
 * Docker image tags Hypervibe generates. Ranges and expressions are rejected
 * because desired state must resolve to one reviewable runtime.
 */
export const nodeVersionSchema = z.string().regex(
  /^[1-9]\d*(?:\.\d+){0,2}$/,
  'Node versions must be a concrete major, major.minor, or major.minor.patch release such as 22 or 22.17.1'
);

export const pythonVersionSchema = z.string().regex(
  /^[1-9]\d*(?:\.\d+){0,2}$/,
  'Python versions must be a concrete major, major.minor, or major.minor.patch release such as 3.13 or 3.13.5'
);

export const projectRuntimeSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('node'),
    version: nodeVersionSchema,
    installCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('python'),
    version: pythonVersionSchema,
    installCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
  }).strict(),
]);

const DATABASE_ENV_ALIAS_SOURCES = [
  'DATABASE_URL',
  'DIRECT_URL',
] as const;

export const databaseEnvAliasSourceSchema = z.enum(DATABASE_ENV_ALIAS_SOURCES);

export const serviceSpecSchema = z.object({
  workloadKind: z.enum(['web', 'worker', 'cron'], {
    errorMap: () => ({ message: "workloadKind 'job' was removed; use 'worker' (always-on) or 'cron' (scheduled, requires cronSchedule). See README migration notes." }),
  }).default('web'),
  startCommand: z.string().min(1).optional(),
  releaseCommand: z.string().min(1).optional(),
  healthCheckPath: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
  timeZone: z.string().min(1).optional(),
  public: z.boolean().optional(),
  /**
   * Per-service compatibility aliases for Hypervibe-managed database URLs.
   * Only names and canonical sources are persisted; resolved values remain
   * inside the encrypted plan/provider boundary.
   */
  databaseEnvAliases: z.record(
    environmentVariableNameSchema,
    databaseEnvAliasSourceSchema
  ).optional(),
}).strict().superRefine((service, ctx) => {
  if (service.workloadKind === 'cron' && !service.cronSchedule) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cron services require cronSchedule',
      path: ['cronSchedule'],
    });
  }
  if (service.workloadKind === 'cron' && !service.startCommand) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cron services require an explicit startCommand; Hypervibe never guesses which application task to run',
      path: ['startCommand'],
    });
  }
});

export const providerIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]*$/,
  'provider ids must be lowercase slugs starting with a letter'
);

const fiveFieldCronSchema = z.string().superRefine((value, ctx) => {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule.cron must use five-field POSIX cron: minute hour day-of-month month day-of-week',
    });
    return;
  }
  const allowed = /^[0-9A-Za-z*?,\/-]+$/;
  if (fields.some((field) => !allowed.test(field)) || fields.some((field) => /[?]/.test(field))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule.cron contains syntax GitHub Actions does not support; use POSIX numbers/names with *, comma, dash, and slash',
    });
  }
  if (/^@(yearly|monthly|weekly|daily|hourly|reboot)$/i.test(value.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GitHub Actions does not support cron aliases such as @daily; use five fields',
    });
  }
});

const ianaTimezoneSchema = z.string().min(1).superRefine((value, ctx) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'schedule.timezone must be a valid IANA timezone such as UTC or America/Vancouver',
    });
  }
});

export const githubScheduleSpecSchema = z.object({
  /** GitHub Actions uses five-field POSIX cron. */
  cron: fiveFieldCronSchema,
  /** GitHub Actions evaluates this IANA timezone natively. Defaults to UTC. */
  timezone: ianaTimezoneSchema.default('UTC'),
}).strict();

const databaseReplicaNameSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,30}$/,
  'replica names must be lowercase slugs starting with a letter (maximum 31 characters)'
);

const databaseBackupPolicySchema = z.object({
  retainedBackups: z.number().int().min(1).max(365).default(8),
  pitrRetentionDays: z.number().int().min(1).max(35).default(7),
}).strict().superRefine((policy, ctx) => {
  if (policy.retainedBackups <= policy.pitrRetentionDays) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'retainedBackups must be greater than pitrRetentionDays so a daily backup remains outside the PITR window',
      path: ['retainedBackups'],
    });
  }
});

const databaseRestoreDrillSchema = z.object({
  /** Managed GitHub Actions schedule for the isolated restore verification. */
  schedule: githubScheduleSpecSchema,
  /** Existing repository secret containing a minimal-role GCP service-account JSON key. */
  credentialsSecret: z.string().regex(
    /^[A-Z_][A-Z0-9_]*$/,
    'restore-drill credentialsSecret must be a valid uppercase GitHub Actions secret name'
  ).default('HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS'),
  /** One read-only SQL statement executed against the restored temporary instance. */
  verificationQuery: z.string().min(1).max(4096)
    .refine((value) => !value.includes('${{'), 'verificationQuery cannot contain GitHub expression interpolation')
    .refine((value) => /^(select|with)\b/i.test(value.trim()), 'verificationQuery must begin with SELECT or WITH')
    .refine((value) => !value.trim().replace(/;\s*$/, '').includes(';'), 'verificationQuery must contain one SQL statement')
    .default('SELECT 1'),
  /** Restore far enough behind now that the PITR log has reached durable storage. */
  restoreLagMinutes: z.number().int().min(5).max(1440).default(5),
  /** Failed labeled drill instances remain inspectable until a later run collects them. */
  retainFailedInstanceDays: z.number().int().min(1).max(14).default(3),
}).strict();

const databaseResilienceSchema = z.object({
  /** Zonal uses one zone; regional provisions a synchronous standby. */
  availability: z.enum(['zonal', 'regional']).optional(),
  /** Provider-managed backups and point-in-time recovery retention. */
  backups: databaseBackupPolicySchema.optional(),
  /** Provider-managed asynchronous read replicas keyed by stable logical name. */
  replicas: z.record(
    databaseReplicaNameSchema,
    z.object({
      region: z.string().min(1).optional(),
      tier: z.string().min(1).optional(),
    }).strict()
  ).optional(),
  /** Scheduled restore into an isolated temporary instance, followed by SQL verification. */
  restoreDrill: databaseRestoreDrillSchema.optional(),
}).strict().superRefine((resilience, ctx) => {
  if (resilience.restoreDrill && !resilience.backups) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'restoreDrill requires a declared backups policy with point-in-time recovery',
      path: ['restoreDrill'],
    });
  }
});

export const databaseSpecSchema = z.object({
  provider: providerIdSchema,
  engine: z.literal('postgres').default('postgres'),
  /**
   * Optional one-shot bootstrap/seed command. hv_plan emits a visible database
   * seed action. hv_apply runs it inside the deployed service environment and
   * records the successful command hash in the database component bindings so
   * it does not run again unless changed.
   */
  seedCommand: z.string().min(1).optional(),
  resilience: databaseResilienceSchema.optional(),
}).strict();

export const cacheSpecSchema = z.object({
  provider: providerIdSchema,
  engine: z.literal('redis').default('redis'),
  /** Provider-native placement. Omitted values preserve an existing cache. */
  region: z.string().trim().min(1).optional(),
  /** Existing provider-native network name or full resource id. */
  network: z.string().trim().min(1).optional(),
  /** Existing provider-native subnet name or full resource id. */
  subnetwork: z.string().trim().min(1).optional(),
  /** Provider-native service tier, for example BASIC or STANDARD_HA. */
  tier: z.string().trim().min(1).optional(),
  /** Provider-native capacity string, for example 1gb. */
  size: z.string().trim().min(1).optional(),
}).strict();

/**
 * Provider-managed traffic distribution in front of deployed web services.
 * The schema is provider-neutral; capability support is resolved during plan.
 */
export const loadBalancerSpecSchema = z.object({
  provider: providerIdSchema,
  /** Two or more equivalent public web services that can receive traffic. */
  services: z.array(z.string().min(1)).min(2),
  /** HTTPS endpoint used by the provider's active health monitor. */
  healthCheckPath: z.string().regex(/^\/[\S]*$/, 'healthCheckPath must be an absolute path beginning with /').default('/health'),
}).strict();

export const deploySpecSchema = z.object({
  strategy: z.enum(['branch', 'manual']).default('manual'),
  trigger: z.enum(['ci', 'native']).optional(),
  /** Git branch used as the source ref. Defaults to main for staging and production. */
  branch: z.string().min(1).optional(),
  /** CI branch deploys default to true for staging and false for production. */
  autoDeploy: z.boolean().optional(),
  /** Production promotion source label, usually staging. Used for workflow guidance. */
  promoteFrom: z.string().min(1).optional(),
}).strict();

export const collaborationLabelSpecSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/, 'label color must be a 6-character hex value without #').optional(),
  description: z.string().max(100).optional(),
}).strict();

export const collaborationSpecSchema = z.object({
  provider: z.literal('github').default('github'),
  enabled: z.boolean().default(true),
  /** GitHub repository owner/name. Defaults to the project gitRemoteUrl. */
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository must be owner/name').optional(),
  /** Environment whose hv_plan should include project-level repo collaboration actions. */
  canonicalEnvironment: z.string().min(1).optional(),
  issues: z.object({
    enabled: z.boolean().default(true),
    labels: z.array(collaborationLabelSpecSchema).default([]),
    templates: z.boolean().default(true),
  }).strict().default({}),
  pullRequests: z.object({
    targetBranch: z.string().min(1).default('main'),
    requirePr: z.boolean().default(true),
    requireReview: z.boolean().default(true),
    requiredReviewers: z.number().int().min(1).max(6).default(1),
    dismissStaleReviews: z.boolean().default(false),
    requireCodeOwnerReviews: z.boolean().default(false),
    requireStatusChecks: z.boolean().default(false),
    statusChecks: z.array(z.string().min(1)).default([]),
    strictStatusChecks: z.boolean().default(true),
    enforceAdmins: z.boolean().default(false),
  }).strict().default({}),
  collaborators: z.array(z.object({
    username: z.string().min(1),
    permission: z.enum(['pull', 'triage', 'push', 'maintain', 'admin']).default('push'),
  }).strict()).default([]),
}).strict().default({});

const automationIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,62}$/,
  'automation ids must be lowercase slugs starting with a letter'
);

const githubAutomationTriggersSchema = z.object({
  pullRequest: z.boolean().default(false),
  push: z.array(z.string().min(1)).default([]),
  schedule: githubScheduleSpecSchema.optional(),
  manual: z.boolean().default(true),
}).strict().default({});

const githubAutomationRuntimeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('node'),
    /** Explicit check override; otherwise the project Node runtime is used. */
    version: z.string().min(1).optional(),
    /** Explicit check install command; otherwise a matching project runtime installCommand is inherited. */
    installCommand: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('python'),
    version: z.string().min(1).optional(),
    /** Explicit check install command; otherwise a matching project runtime installCommand is inherited. */
    installCommand: z.string().min(1).optional(),
  }).strict(),
]);

const githubFailureArtifactPathSchema = z.string().min(1).superRefine((value, ctx) => {
  const unsafe = value.trim() !== value
    || /[\r\n\0]/.test(value)
    || value.startsWith('/')
    || value.split('/').includes('..')
    || /(^|\/)\.git(?:\/|$)/i.test(value)
    || /(^|\/)\.env(?:\.|\/|$)/i.test(value)
    || /(^|\/)(?:secret|secrets|credentials)(?:\.|\/|$)/i.test(value)
    || ['.', '*', '**', '**/*'].includes(value);
  if (unsafe) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'failure artifact paths must be narrow relative result paths and cannot target credentials, .env, .git, or the whole workspace',
    });
  }
});

const githubFailureArtifactPatternSchema = z.string().min(1).superRefine((value, ctx) => {
  const literalPrefix = value.endsWith('*') ? value.slice(0, -1) : value;
  const unsafe = value.trim() !== value
    || /[\r\n\0/\\]/.test(value)
    || value.includes('${{')
    || literalPrefix.length < 3
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\*)?$/.test(value);
  if (unsafe) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'failure artifact patterns must be a narrow artifact name or identifier-shaped prefix ending in *',
    });
  }
});

const githubAiAgentSchema = z.object({
  provider: z.literal('openai').default('openai'),
  model: z.literal('gpt-5.6-sol').default('gpt-5.6-sol'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
}).strict().default({});

const githubAuditInstructionsSchema = z.string().min(1).max(12_000).superRefine((value, ctx) => {
  if (value.includes('${{') || /[\0]/.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'code-audit instructions cannot contain GitHub expressions or null bytes',
    });
  }
});

const githubAuditDocumentationDomainSchema = z.string().min(1).max(253).superRefine((value, ctx) => {
  const labels = value.split('.');
  const parsed = parseDomain(value, { detectSpecialUse: true });
  const unsafe = value !== value.trim().toLowerCase()
    || value.includes('${{')
    || value.includes('*')
    || labels.length < 2
    || labels.some((label) => (
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
    || parsed.hostname !== value
    || parsed.isIp
    || parsed.isSpecialUse
    || parsed.isIcann !== true;
  if (unsafe) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'code-audit documentationDomains must contain exact lowercase public hostnames without schemes, paths, credentials, expressions, wildcards, or local/private suffixes',
    });
  }
});

const githubAuditDocumentationDomainsSchema = z.array(githubAuditDocumentationDomainSchema)
  .max(32)
  .superRefine((domains, ctx) => {
    if (new Set(domains).size !== domains.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'code-audit documentationDomains cannot contain duplicate hostnames',
      });
    }
  });

const githubAuditShardsSchema = z.array(z.object({
  id: automationIdSchema,
  /** The complete, non-overlapping audit scope assigned to this shard. */
  instructions: githubAuditInstructionsSchema,
}).strict())
  .max(8)
  .superRefine((shards, ctx) => {
    if (shards.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'code-audit shards must contain at least two scopes when configured',
      });
    }
    const ids = shards.map((shard) => shard.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'code-audit shard ids must be unique',
      });
    }
  });

export const githubCheckAutomationSpecSchema = z.object({
  kind: z.literal('check'),
  enabled: z.boolean().default(true),
  category: z.enum([
    'test',
    'lint',
    'typecheck',
    'build',
    'dependency-audit',
    'performance',
    'accessibility',
  ]),
  triggers: githubAutomationTriggersSchema,
  runtime: githubAutomationRuntimeSchema,
  /**
   * Application checks skip expensive steps for Hypervibe-only PRs while
   * retaining a successful required check. Use "all" for infrastructure
   * validators that intentionally inspect those files.
   */
  changeScope: z.enum(['application', 'all']).default('application'),
  commands: z.array(z.string().min(1)).min(1),
  failureArtifacts: z.array(githubFailureArtifactPathSchema).default([]),
}).strict();

export const githubAutofixAutomationSpecSchema = z.object({
  kind: z.literal('autofix'),
  enabled: z.boolean().default(true),
  /** Check automation ids whose completed failed runs may produce a patch. */
  sources: z.array(automationIdSchema).min(1),
  agent: githubAiAgentSchema,
  draftPullRequest: z.literal(true).default(true),
}).strict();

export const githubPullRequestReviewAutomationSpecSchema = z.object({
  kind: z.literal('pull-request-review'),
  enabled: z.boolean().default(true),
  agent: githubAiAgentSchema,
}).strict();

export const githubCodeAuditAutomationSpecSchema = z.object({
  kind: z.literal('code-audit'),
  enabled: z.boolean().default(true),
  schedule: githubScheduleSpecSchema,
  agent: githubAiAgentSchema,
  /** Additional reviewed audit rules. Repository and fetched content remain untrusted evidence. */
  instructions: githubAuditInstructionsSchema.optional(),
  /** Independent bounded scopes that run in parallel and combine only after every report exists. */
  shards: githubAuditShardsSchema.default([]),
  /** Exact public documentation hosts available to the read-only Codex network profile. */
  documentationDomains: githubAuditDocumentationDomainsSchema.default([]),
  /** Stable issue-per-finding lifecycle; line numbers are deliberately excluded from fingerprints. */
  findings: z.object({
    createIssues: z.literal(true).default(true),
    closeAfterCleanRuns: z.literal(1).default(1),
  }).strict().default({}),
}).strict();

export const githubAutomationSpecSchema = z.discriminatedUnion('kind', [
  githubCheckAutomationSpecSchema,
  githubAutofixAutomationSpecSchema,
  githubPullRequestReviewAutomationSpecSchema,
  githubCodeAuditAutomationSpecSchema,
]);

const githubCollaborationSpecSchema = z.object({
  issues: z.object({
    enabled: z.boolean().default(true),
    labels: z.array(collaborationLabelSpecSchema).default([]),
    templates: z.boolean().default(true),
  }).strict().default({}),
  pullRequests: z.object({
    targetBranch: z.string().min(1).default('main'),
    requirePr: z.boolean().default(true),
    requireReview: z.boolean().default(true),
    requiredReviewers: z.number().int().min(1).max(6).default(1),
    dismissStaleReviews: z.boolean().default(false),
    requireCodeOwnerReviews: z.boolean().default(false),
    requireStatusChecks: z.boolean().default(false),
    statusChecks: z.array(z.string().min(1)).default([]),
    strictStatusChecks: z.boolean().default(true),
    enforceAdmins: z.boolean().default(false),
  }).strict().default({}),
  collaborators: z.array(z.object({
    username: z.string().min(1),
    permission: z.enum(['pull', 'triage', 'push', 'maintain', 'admin']).default('push'),
  }).strict()).default([]),
}).strict().default({});

const githubPagesSourcePathSchema = z.string().min(1).superRefine((value, ctx) => {
  if (
    value.trim() !== value
    || value.startsWith('/')
    || value.startsWith('\\')
    || value.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')
    || /[\r\n\0]/.test(value)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pages.sourcePath must be a normalized repository-relative directory without empty, current, or parent segments',
    });
  }
});

const githubPagesDomainSchema = z.string().min(1).max(253).superRefine((value, ctx) => {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  const labels = normalized.split('.');
  if (
    value !== normalized
    || labels.length < 2
    || labels.some((label) => (
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pages.customDomain must be a lowercase hostname without a scheme, path, port, or trailing dot',
    });
  }
});

export const githubPagesSpecSchema = z.object({
  enabled: z.boolean().default(true),
  /** Repository directory uploaded as the static Pages artifact. */
  sourcePath: githubPagesSourcePathSchema,
  /** Branch whose pushes publish the site. */
  branch: z.string().min(1).default('main'),
  /** Optional custom hostname. DNS is managed through Cloudflare as a separate plan action. */
  customDomain: githubPagesDomainSchema.optional(),
  dnsProvider: z.literal('cloudflare').default('cloudflare'),
}).strict();

export const githubSpecSchema = z.object({
  enabled: z.boolean().default(true),
  /** GitHub repository owner/name. Defaults to the project gitRemoteUrl. */
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository must be owner/name').optional(),
  /** Environment whose hv_plan owns project-level GitHub infrastructure. */
  canonicalEnvironment: z.string().min(1).optional(),
  collaboration: githubCollaborationSpecSchema,
  /** Static GitHub Pages publishing as project-level desired state. */
  pages: githubPagesSpecSchema.optional(),
  actions: z.record(automationIdSchema, githubAutomationSpecSchema).default({}),
  /** Existing workflow names that autofix may consume but Hypervibe does not own. */
  externalWorkflows: z.record(automationIdSchema, z.object({
    workflowName: z.string().min(1),
    /** Exact artifact name or narrow trailing-wildcard pattern. Optional only for legacy spec readability. */
    failureArtifactPattern: githubFailureArtifactPatternSchema.optional(),
    failureArtifacts: z.array(githubFailureArtifactPathSchema).default([]),
  }).strict()).default({}),
  dependencies: z.object({
    alerts: z.boolean().default(false),
    securityUpdates: z.boolean().default(false),
    versionUpdates: z.array(z.object({
      ecosystem: z.string().min(1),
      directory: z.string().startsWith('/').default('/'),
      interval: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
      targetBranch: z.string().min(1).optional(),
    }).strict()).default([]),
  }).strict().default({}),
  security: z.object({
    codeScanning: z.boolean().default(false),
    secretScanning: z.boolean().default(false),
    pushProtection: z.boolean().default(false),
  }).strict().default({}),
}).strict().superRefine((github, ctx) => {
  for (const [id, automation] of Object.entries(github.actions)) {
    if (automation.kind === 'check') {
      const triggers = automation.triggers;
      if (!triggers.manual && !triggers.pullRequest && triggers.push.length === 0 && !triggers.schedule) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'check automation requires at least one trigger',
          path: ['actions', id, 'triggers'],
        });
      }
    }
    if (automation.kind !== 'autofix') continue;
    const seen = new Set<string>();
    for (const source of automation.sources) {
      if (seen.has(source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `autofix source "${source}" is listed more than once`,
          path: ['actions', id, 'sources'],
        });
      }
      seen.add(source);
      const managed = github.actions[source];
      const external = github.externalWorkflows[source];
      if (!managed && !external) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `autofix source "${source}" is not a managed check or external workflow`,
          path: ['actions', id, 'sources'],
        });
      } else if (managed && managed.kind !== 'check') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `autofix source "${source}" must reference a check automation`,
          path: ['actions', id, 'sources'],
        });
      } else if (automation.enabled && managed?.kind === 'check' && !managed.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `enabled autofix source "${source}" references a disabled check`,
          path: ['actions', id, 'sources'],
        });
      } else if (automation.enabled && external && external.failureArtifacts.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `external workflow "${source}" must declare at least one failure artifact before autofix can consume it`,
          path: ['externalWorkflows', source, 'failureArtifacts'],
        });
      }
    }
  }
  if (github.security.pushProtection && !github.security.secretScanning) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pushProtection requires secretScanning',
      path: ['security', 'pushProtection'],
    });
  }
});

/**
 * Provider-neutral repository and primary application-CI selection.
 * Project-level GitHub feature desired state remains on the legacy `github`
 * block during the compatibility slice; new providers must not introduce a
 * parallel top-level block.
 */
const devopsScopeSchema = z.string().trim().min(1).max(2_048).superRefine((scope, ctx) => {
  if (/[\0\r\n]/.test(scope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'devops.code.scope cannot contain control characters' });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(scope)) {
    try {
      const url = new URL(scope);
      if (url.username || url.password || url.search || url.hash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'devops.code.scope cannot contain credentials, query parameters, or fragments',
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'devops.code.scope URL is invalid' });
    }
  }
});

export const devopsSpecSchema = z.object({
  code: z.object({
    provider: providerIdSchema,
    /** Provider-owned canonical repository scope (URL for GitLab, owner/repo for GitHub). */
    scope: devopsScopeSchema,
    /**
     * Repository lifecycle is explicit. The default preserves the existing
     * repository contract; managed creation and deletion are never inferred
     * from a missing project or from repository file writes.
     */
    repository: z.object({
      state: z.enum(['present', 'absent']).default('present'),
      management: z.enum(['external', 'managed']).default('external'),
      visibility: z.enum(['private', 'internal', 'public']).default('private'),
      defaultBranch: z.string().min(1).max(255).superRefine((branch, ctx) => {
        const components = branch.split('/');
        if (
          branch === '@'
          || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
          || branch.includes('..')
          || branch.includes('@{')
          || components.some((component) => (
            component.length === 0
            || component.startsWith('.')
            || component.endsWith('.')
            || component.endsWith('.lock')
          ))
        ) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'defaultBranch must be a safe Git ref name' });
        }
      })
        .default('main'),
    }).strict().default({}),
  }).strict(),
  ci: z.object({
    provider: providerIdSchema,
    runner: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('provider-hosted'),
      }).strict(),
      z.object({
        mode: z.literal('self-managed'),
        /** Exact GitLab runner id; never select a runner by tag alone. */
        runnerId: z.string().regex(/^[1-9]\d*$/, 'runnerId must be a positive numeric provider id'),
        /** Exact manager machine identity observed through the provider API. */
        managerSystemId: z.string().min(1).max(255),
        /** Dedicated tag that no other runner assigned to the project may claim. */
        tag: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/, 'runner tag contains unsupported characters'),
        /** Operator-owned, provider-observed execution-capability attestation. */
        capabilities: z.array(z.enum(['linux-amd64', 'docker-privileged'])).min(1),
      }).strict(),
    ]).default({ mode: 'provider-hosted' }),
  }).strict().optional(),
  /** Environment that owns project-level DevOps lifecycle actions. */
  canonicalEnvironment: z.string().min(1).optional(),
}).strict();

export const envFileSpecSchema = z.object({
  /**
   * runtime: include high-confidence app runtime keys from .env (default).
   * all: include every non-provider key from .env.
   * explicit: include only keys listed in include.
   * off: never load .env for deploy planning/apply.
   */
  mode: z.enum(['runtime', 'all', 'explicit', 'off']).default('runtime'),
  /** Exact .env keys to include in addition to the mode's defaults. */
  include: z.array(z.string().min(1)).default([]),
  /** Exact .env keys to omit even if the mode or include list would select them. */
  exclude: z.array(z.string().min(1)).default([]),
}).strict().default({});

export const delegatedSecretSpecSchema = z.object({
  /** Delegated values are supplied explicitly at plan time and never stored in the spec. */
  ownership: z.literal('delegated').default('delegated'),
  /** Non-secret identity that documents who is responsible for supplying and rotating the value. */
  principal: z.string().min(1),
  /** Runtime environments in which this secret must be injected. */
  environments: z.array(z.string().min(1)).default([]),
  /** Optional GitHub Actions destinations managed by the canonical GitHub environment plan. */
  githubActions: z.object({
    repository: z.boolean().default(false),
    environments: z.array(z.string().min(1)).default([]),
  }).strict().optional(),
  /** Missing or unaccepted values block convergence until the principal supplies a secretRef. */
  required: z.boolean().default(true),
  /** Never replace an accepted live value from a local env file or ordinary envVars input. */
  driftPolicy: z.literal('preserve').default('preserve'),
}).strict().superRefine((secret, ctx) => {
  if (
    secret.environments.length === 0
    && !secret.githubActions?.repository
    && (secret.githubActions?.environments.length ?? 0) === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'delegated secrets require at least one runtime or GitHub Actions destination',
      path: ['environments'],
    });
  }
  const githubEnvironments = secret.githubActions?.environments ?? [];
  if (new Set(githubEnvironments).size !== githubEnvironments.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GitHub Actions environment destinations cannot contain duplicates',
      path: ['githubActions', 'environments'],
    });
  }
});

export const migrationsSpecSchema = z.object({
  mode: z.enum(['none', 'releaseCommand', 'tool']),
  runInDeploy: z.boolean().optional(),
  command: z.string().min(1).optional(),
}).strict();

export const domainRegistrationSpecSchema = z.object({
  provider: z.literal('cloudflare').default('cloudflare'),
  register: z.boolean().default(true),
  accountId: z.string().min(1).optional(),
  years: z.number().int().min(1).max(10).optional(),
  autoRenew: z.boolean().optional(),
  privacyMode: z.enum(['redaction', 'off']).optional(),
}).strict();

export const iosTestflightGroupSpecSchema = z.object({
  internal: z.boolean().default(false),
  publicLinkEnabled: z.boolean().optional(),
  publicLinkLimit: z.number().int().min(1).max(10000).optional(),
  feedbackEnabled: z.boolean().optional(),
  hasAccessToAllBuilds: z.boolean().optional(),
  testers: z.array(z.string().email()).default([]),
}).strict();

const runtimeEnvVarNameSchema = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  'runtime environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores'
);

const repositoryRelativePathSchema = z.string().min(1).refine(
  (value) => (
    !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.split(/[\\/]/).includes('..')
  ),
  'must be a repository-relative path without parent-directory traversal'
);

export const iosReleaseSigningSpecSchema = z.discriminatedUnion('provider', [
  z.object({
    /** The project build command owns signing and explicitly names any secrets it needs. */
    provider: z.literal('project'),
  }).strict(),
  z.object({
    /** Hypervibe installs existing Match assets read-only before invoking the project build. */
    provider: z.literal('match'),
    gitBranch: z.string().min(1).regex(
      /^[A-Za-z0-9._/-]+$/,
      'gitBranch contains unsupported characters'
    ).default('main'),
  }).strict(),
]);

const appStoreReleaseSecretNames = [
  'APP_STORE_CONNECT_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_PRIVATE_KEY',
];

const matchSigningSecretNames = [
  'MATCH_GIT_URL',
  'MATCH_PASSWORD',
  'MATCH_GIT_BASIC_AUTHORIZATION',
];

export const iosReleaseSpecSchema = z.object({
  /** Server services whose successful deployment evidence gates this mobile release. */
  services: z.array(z.string().min(1)).min(1),
  trigger: z.enum(['manual', 'after-server-deploy']).default('after-server-deploy'),
  build: z.object({
    workingDirectory: repositoryRelativePathSchema.default('.'),
    command: z.string().min(1).refine(
      (value) => !value.includes('${{'),
      'build command cannot contain GitHub expression interpolation'
    ),
    ipaPath: repositoryRelativePathSchema.refine(
      (value) => value.toLowerCase().endsWith('.ipa'),
      'ipaPath must end in .ipa'
    ),
    /** Existing GitHub environment secret names needed only by the project build command. */
    requiredSecrets: z.array(runtimeEnvVarNameSchema).default([]),
  }).strict(),
  signing: iosReleaseSigningSpecSchema.default({ provider: 'project' }),
  testflight: z.object({
    /** Names declared under ios.testflight.groups. */
    groups: z.array(z.string().min(1)).min(1),
    usesNonExemptEncryption: z.boolean().default(false),
    submitForBetaReview: z.boolean().default(false),
    /** Accepted only while existing specs migrate to Hypervibe's managed release runtime. */
    scriptPath: repositoryRelativePathSchema.refine(
      (value) => value === 'scripts/hypervibe-ios-release.mjs',
      'TestFlight submission is managed by Hypervibe; custom scriptPath values are not supported'
    ).optional(),
  }).strict(),
}).strict();

/**
 * iOS identity + TestFlight desired state. Capabilities and tester
 * membership converge additively (never disabled/removed); extras on the
 * live side are reported as unmanaged. Release builds/uploads/distribution
 * run in isolated build/release jobs tied to server deploy evidence.
 * Hypervibe owns signing preparation and TestFlight submission when their
 * managed providers are selected; projects retain build commands and metadata.
 * Final App Store review remains an explicit, release-gated Hypervibe command.
 */
export const iosSpecSchema = z.object({
  bundleId: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'bundleId must be a reverse-DNS identifier'),
  /** Name used when registering the bundle ID; defaults to the project name at plan time. */
  appName: z.string().min(1).optional(),
  platform: z.enum(['IOS', 'MAC_OS']).default('IOS'),
  /** ASC capability types, e.g. PUSH_NOTIFICATIONS, ICLOUD, SIGN_IN_WITH_APPLE. */
  capabilities: z.array(z.string().min(1)).default([]),
  testflight: z.object({
    groups: z.record(z.string().min(1), iosTestflightGroupSpecSchema).default({}),
  }).strict().optional(),
  release: iosReleaseSpecSchema.optional(),
}).strict().superRefine((ios, ctx) => {
  for (const [name, group] of Object.entries(ios.testflight?.groups ?? {})) {
    if (group.publicLinkLimit !== undefined && !group.publicLinkEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publicLinkLimit requires publicLinkEnabled',
        path: ['testflight', 'groups', name, 'publicLinkLimit'],
      });
    }
    if (group.internal && group.publicLinkEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'internal groups cannot have a public link',
        path: ['testflight', 'groups', name, 'publicLinkEnabled'],
      });
    }
  }
  for (const [index, groupName] of (ios.release?.testflight.groups ?? []).entries()) {
    if (!ios.testflight?.groups[groupName]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `release TestFlight group "${groupName}" is not declared under ios.testflight.groups`,
        path: ['release', 'testflight', 'groups', index],
      });
    }
  }

  const buildSecretNames = new Set(ios.release?.build.requiredSecrets ?? []);
  const reservedSecretNames = [
    ...appStoreReleaseSecretNames,
    ...(ios.release?.signing.provider === 'match' ? matchSigningSecretNames : []),
  ];
  for (const name of reservedSecretNames) {
    if (!buildSecretNames.has(name)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${name} is reserved for the Hypervibe-managed release boundary`,
      path: ['release', 'build', 'requiredSecrets'],
    });
  }
});

/**
 * A named message queue. Backend follows the hosting provider: Cloud Run
 * environments get real Pub/Sub topics + subscriptions; Railway environments
 * are postgres-backed (pg-boss model — queues ride the declared database,
 * hypervibe wires env vars and apps own the tables).
 */
export const queueSpecSchema = z.object({
  /** Subscriber ack deadline in seconds. Provider capability validation limits this to managed Pub/Sub queues. */
  ackDeadlineSeconds: z.number().int().min(10).max(600).optional(),
}).strict();

/**
 * Named, durable object storage. Provider adapters own provisioning and data
 * plane translation; services receive the selected provider's explicit native
 * runtime contract, plus provider-neutral bucket/provider identifiers.
 */
export const storageSpecSchema = z.object({
  provider: providerIdSchema,
  type: z.literal('bucket'),
  /** Provider-native region identifier. Bucket regions are treated as immutable. */
  region: z.string().min(1),
  /** Services that receive this bucket's generated runtime variables. */
  injectInto: z.array(z.string().min(1)),
}).strict().superRefine((storage, ctx) => {
  const railwayRegions = ['sjc', 'iad', 'ams', 'sin'];
  if (storage.provider === 'railway' && !railwayRegions.includes(storage.region)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Railway bucket region must be one of: ${railwayRegions.join(', ')}`,
      path: ['region'],
    });
  }
});

/**
 * One reviewed, one-use copy of durable environment data. The target database
 * and storage providers remain declared on the target environment; the source
 * providers are resolved from fromEnvironment. V1 deliberately supports only
 * whole-resource replacement, never application-specific row merging.
 */
export const dataMigrationSpecSchema = z.object({
  id: z.string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/, 'data migration ids must be lowercase slugs starting with a letter'),
  fromEnvironment: z.string().min(1),
  include: z.object({
    database: z.boolean().default(false),
    storage: z.array(
      z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'storage names: lowercase alphanumeric and dashes, starting with a letter')
    ).default([]),
  }).strict().superRefine((include, ctx) => {
    if (!include.database && include.storage.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dataMigration.include must select the database or at least one storage resource',
        path: [],
      });
    }
    const duplicates = include.storage.filter((name, index) => include.storage.indexOf(name) !== index);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dataMigration.include.storage contains duplicate names: ${[...new Set(duplicates)].join(', ')}`,
        path: ['storage'],
      });
    }
  }),
}).strict();

/**
 * Provider-owned whole-environment maintenance. V1 deliberately exposes one
 * safe switch instead of application-specific read-only or bypass behavior.
 */
export const maintenanceSpecSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const stripePriceEnvBindingSpecSchema = z.object({
  /**
   * Stripe product id (prod_...) or product name. Name matching is exact
   * unless match="contains" is explicitly selected for legacy catalogs.
   */
  product: z.string().min(1),
  match: z.enum(['exact', 'contains']).default('exact'),
  interval: z.enum(['day', 'week', 'month', 'year']),
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'currency must be a three-letter code').transform((value) => value.toLowerCase()).optional(),
  nickname: z.string().min(1).optional(),
  lookupKey: z.string().min(1).optional(),
}).strict();

const stripeCatalogIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,62}$/,
  'Stripe catalog ids must be lowercase slugs starting with a letter'
);

export const stripeCatalogPriceSpecSchema = z.object({
  /** Integer amount in the currency's minor unit (for example cents). */
  unitAmount: z.number().int().nonnegative(),
  currency: z.string()
    .regex(/^[A-Za-z]{3}$/, 'currency must be a three-letter code')
    .transform((value) => value.toLowerCase())
    .default('usd'),
  interval: z.enum(['month', 'year']),
  /** Hosting variable receiving this environment's provider price id. */
  envVar: runtimeEnvVarNameSchema,
}).strict();

export const stripeCatalogProductSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  /** Stripe Tax Code id used to classify this product for tax calculation. */
  taxCode: z.string()
    .regex(
      /^txcd_[0-9]{8}$/,
      'taxCode must be a Stripe tax code id such as txcd_10103001'
    )
    .optional(),
  prices: z.record(stripeCatalogIdSchema, stripeCatalogPriceSpecSchema),
}).strict().superRefine((product, ctx) => {
  if (Object.keys(product.prices).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe catalog products require at least one recurring price',
      path: ['prices'],
    });
  }
});

export const stripeCatalogSpecSchema = z.object({
  products: z.record(stripeCatalogIdSchema, stripeCatalogProductSpecSchema),
}).strict().superRefine((catalog, ctx) => {
  if (Object.keys(catalog.products).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe catalog requires at least one product',
      path: ['products'],
    });
  }
  const envVars = new Map<string, string>();
  for (const [productId, product] of Object.entries(catalog.products)) {
    for (const [priceId, price] of Object.entries(product.prices)) {
      const owner = `${productId}.${priceId}`;
      const existing = envVars.get(price.envVar);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe catalog prices "${existing}" and "${owner}" both manage ${price.envVar}`,
          path: ['products', productId, 'prices', priceId, 'envVar'],
        });
      } else {
        envVars.set(price.envVar, owner);
      }
    }
  }
});

export const STRIPE_DEFAULT_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.created',
  'customer.updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
] as const;

export const stripeWebhookSpecSchema = z.object({
  /** Public HTTPS endpoint that receives Stripe events. */
  url: z.string().url().refine(
    (value) => value.toLowerCase().startsWith('https://'),
    'Stripe webhook URLs must use HTTPS'
  ),
  /** Exactly one service receives this endpoint's signing value. */
  service: z.string().min(1),
  /** Hosting variable that receives the signing value returned at endpoint creation. */
  envVar: runtimeEnvVarNameSchema.default('STRIPE_WEBHOOK_SECRET'),
  /** Stripe events delivered to this endpoint. */
  events: z.array(z.string().min(1)).min(1).default([...STRIPE_DEFAULT_WEBHOOK_EVENTS]),
}).strict().superRefine((webhook, ctx) => {
  const seen = new Set<string>();
  for (const [index, event] of webhook.events.entries()) {
    if (seen.has(event)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stripe webhook event "${event}" is listed more than once`,
        path: ['events', index],
      });
    }
    seen.add(event);
  }
});

export const stripeEnvironmentSyncSpecSchema = z.object({
  /**
   * Stripe connection scope. Defaults to this Hypervibe environment name,
   * allowing development/staging/production to use isolated Stripe sandboxes.
   */
  environment: z.string().min(1).optional(),
  /** Services receiving the managed Stripe variables. Defaults to every service. */
  services: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Opt-in runtime credential projection. Values come from the encrypted
   * scoped Stripe connection and never enter the committed spec or plan.
   */
  credentials: z.object({
    secretKeyEnvVar: runtimeEnvVarNameSchema.default('STRIPE_SECRET_KEY'),
    publishableKeyEnvVar: runtimeEnvVarNameSchema.optional(),
  }).strict().optional(),
  /** Hypervibe-owned SaaS product and recurring-price catalog for this environment. */
  catalog: stripeCatalogSpecSchema.optional(),
  /**
   * Removed compatibility field. It remains in the parser only so old specs
   * receive an actionable migration error instead of an unknown-key message.
   */
  prices: z.record(runtimeEnvVarNameSchema, stripePriceEnvBindingSpecSchema).optional(),
  /**
   * Named Stripe webhook endpoints. Hypervibe owns each endpoint lifecycle,
   * projects its creation-only signing value to one service, and records only
   * provider identity plus a value hash in bindings.
   */
  webhooks: z.record(z.string().min(1), stripeWebhookSpecSchema).default({}),
}).strict().superRefine((stripe, ctx) => {
  if (
    !stripe.credentials
    && !stripe.catalog
    && Object.keys(stripe.webhooks).length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe environment sync requires credentials, a price binding, and/or a webhook',
    });
  }
  if (stripe.prices !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'payments.stripe.prices selectors have been removed. Declare owned recurring prices under payments.stripe.catalog.products and put envVar on each price.',
      path: ['prices'],
    });
  }
  if (
    stripe.credentials?.publishableKeyEnvVar
    && stripe.credentials.publishableKeyEnvVar === stripe.credentials.secretKeyEnvVar
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stripe secret and publishable keys must use different runtime environment variable names',
      path: ['credentials'],
    });
  }
  if (stripe.credentials) {
    for (const key of [
      stripe.credentials.secretKeyEnvVar,
      ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
    ]) {
      const catalogEnvVars = new Set(
        Object.values(stripe.catalog?.products ?? {})
          .flatMap((product) => Object.values(product.prices).map((price) => price.envVar))
      );
      if (catalogEnvVars.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe runtime credential variable "${key}" cannot also be a catalog price binding`,
          path: ['catalog'],
        });
      }
    }
  }

  const webhookUrls = new Map<string, string>();
  const webhookSlots = new Map<string, string>();
  for (const [name, webhook] of Object.entries(stripe.webhooks)) {
    const existingUrl = webhookUrls.get(webhook.url);
    if (existingUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stripe webhooks "${existingUrl}" and "${name}" use the same URL`,
        path: ['webhooks', name, 'url'],
      });
    } else {
      webhookUrls.set(webhook.url, name);
    }

    const slot = `${webhook.service}\0${webhook.envVar}`;
    const existingSlot = webhookSlots.get(slot);
    if (existingSlot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Stripe webhooks "${existingSlot}" and "${name}" both manage ${webhook.envVar} on service "${webhook.service}"`,
        path: ['webhooks', name, 'envVar'],
      });
    } else {
      webhookSlots.set(slot, name);
    }
  }
});

export const paymentsSpecSchema = z.object({
  stripe: stripeEnvironmentSyncSpecSchema.optional(),
}).strict();

const emailAddressSchema = z.string().email('email addresses must be valid RFC-style addresses');

const emailHostnameSchema = z.string().regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
  'email hostnames must be fully-qualified DNS names such as inbound.example.com'
);

const emailAliasSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,62}[a-z0-9])?$/i,
  'email aliases must be local parts such as support or replies'
);

export const emailSenderSpecSchema = z.object({
  address: emailAddressSchema,
  name: z.string().trim().min(1).max(128).optional(),
  replyTo: emailAddressSchema.optional(),
}).strict();

export const emailInboundSpecSchema = z.object({
  hostname: emailHostnameSchema,
  service: z.string().min(1),
  path: z.string()
    .regex(/^\/(?!\/)[^?#\s]*$/, 'inbound email paths must begin with one slash and cannot contain a query or fragment')
    .default('/webhooks/sendgrid/inbound'),
  aliases: z.array(emailAliasSchema).default([]),
  spamCheck: z.boolean().default(true),
  sendRaw: z.boolean().default(false),
}).strict();

export const SENDGRID_DELIVERY_EVENTS = [
  'bounce',
  'click',
  'deferred',
  'delivered',
  'dropped',
  'group_resubscribe',
  'group_unsubscribe',
  'open',
  'processed',
  'spam_report',
  'unsubscribe',
] as const;

export const emailDeliveryEventsSpecSchema = z.object({
  service: z.string().min(1),
  path: z.string()
    .regex(/^\/(?!\/)[^?#\s]*$/, 'delivery-event paths must begin with one slash and cannot contain a query or fragment')
    .default('/webhooks/sendgrid/events'),
  events: z.array(z.enum(SENDGRID_DELIVERY_EVENTS)).min(1).default([...SENDGRID_DELIVERY_EVENTS]),
}).strict();

export const emailForwardingSpecSchema = z.object({
  /** Local-part to destination mailbox, for example { support: "owner@example.net" }. */
  aliases: z.record(emailAliasSchema, emailAddressSchema).default({}),
  catchAll: z.discriminatedUnion('action', [
    z.object({ action: z.literal('forward'), destination: emailAddressSchema }).strict(),
    z.object({ action: z.literal('drop') }).strict(),
  ]).default({ action: 'drop' }),
}).strict();

export const emailSpecSchema = z.object({
  enabled: z.boolean(),
  sender: emailSenderSpecSchema.optional(),
  inbound: emailInboundSpecSchema.optional(),
  deliveryEvents: emailDeliveryEventsSpecSchema.optional(),
  forwarding: emailForwardingSpecSchema.optional(),
}).strict().superRefine((email, ctx) => {
  if (!email.enabled && (email.sender || email.inbound || email.deliveryEvents || email.forwarding)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'email sender, inbound, delivery-event, and forwarding settings require email.enabled=true',
      path: ['enabled'],
    });
  }
  const seenAliases = new Set<string>();
  for (const [index, alias] of (email.inbound?.aliases ?? []).entries()) {
    const normalized = alias.toLowerCase();
    if (seenAliases.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inbound email alias "${alias}" is declared more than once`,
        path: ['inbound', 'aliases', index],
      });
    }
    seenAliases.add(normalized);
  }
});

export const EMAIL_MANAGED_ENV_KEYS = [
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_FROM_NAME',
  'SENDGRID_REPLY_TO',
  'SENDGRID_INBOUND_HOSTNAME',
  'SENDGRID_INBOUND_ALIASES',
] as const;

const messagingWebhookTargetSchema = z.object({
  service: z.string().min(1),
  path: z.string()
    .regex(/^\/(?!\/)[^?#\s]*$/, 'messaging webhook paths must begin with one slash and cannot contain a query or fragment'),
}).strict();

export const twilioMessagingSpecSchema = z.object({
  provider: z.literal('twilio').default('twilio'),
  /** Application services that receive the Twilio runtime contract. */
  services: z.array(z.string().min(1)).min(1),
  service: z.object({
    name: z.string().trim().min(1).max(64),
    inbound: messagingWebhookTargetSchema.extend({
      path: messagingWebhookTargetSchema.shape.path.default('/webhooks/twilio/messages'),
    }).optional(),
    deliveryStatus: messagingWebhookTargetSchema.extend({
      path: messagingWebhookTargetSchema.shape.path.default('/webhooks/twilio/status'),
    }).optional(),
  }).strict(),
  /** Existing Twilio phone number to attach. Hypervibe never purchases numbers. */
  sender: z.object({
    phoneNumberSid: z.string()
      .regex(/^PN[0-9a-fA-F]{32}$/, 'Twilio phone number SID must start with PN and contain 32 hexadecimal characters')
      .describe('Existing SMS-capable Phone Number SID (PN...) from Twilio Console -> Numbers & Senders -> Phone Numbers; use the SID, not the +E.164 number'),
  }).strict().optional(),
}).strict();

export const MESSAGING_MANAGED_ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_PHONE_NUMBER_SID',
] as const;

export const environmentSpecSchema = z.object({
  hosting: z.object({
    /** Hosting provider name; validated against the adapter registry at spec_set time. */
    provider: z.string().min(1),
    /** Optional desired placement. Omit to use the provider's sensible default. */
    region: z.string().trim().min(1).optional(),
  }).strict(),
  services: z.record(z.string().min(1), serviceSpecSchema).default({}),
  database: databaseSpecSchema.optional(),
  cache: cacheSpecSchema.optional(),
  domain: z.string().min(1).optional(),
  /** Whether Cloudflare proxies the custom-domain traffic record. Disable temporarily when origin certificate validation is stuck. */
  domainProxy: z.boolean().optional(),
  /** One-time custom-domain replacement revision. A new value plans a confirmation-gated provider delete/recreate. */
  domainRecreateRevision: z.string().min(1).max(100).optional(),
  loadBalancer: loadBalancerSpecSchema.optional(),
  domainRegistration: domainRegistrationSpecSchema.optional(),
  email: emailSpecSchema.default({ enabled: false }),
  messaging: twilioMessagingSpecSchema.optional(),
  envVars: z.record(z.string()).default({}),
  /** Explicitly documents that a shared runtime key does not apply here. */
  envVarExceptions: z.array(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'exception keys must be valid environment variable names')
  ).optional(),
  /**
   * Durable, explicit tombstones for provider variables that Hypervibe should
   * delete. Variables merely omitted from envVars remain untouched.
   */
  removeEnvVars: z.array(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'retired keys must be valid environment variable names')
  ).optional(),
  envFile: envFileSpecSchema.optional(),
  deploy: deploySpecSchema.optional(),
  migrations: migrationsSpecSchema.optional(),
  ios: iosSpecSchema.optional(),
  queues: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'queue names: lowercase alphanumeric and dashes, starting with a letter'),
    queueSpecSchema
  ).optional(),
  storage: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,60}$/, 'storage names: lowercase alphanumeric and dashes, starting with a letter'),
    storageSpecSchema
  ).optional(),
  dataMigration: dataMigrationSpecSchema.optional(),
  maintenance: maintenanceSpecSchema.optional(),
  payments: paymentsSpecSchema.optional(),
  /** Kept only to produce an actionable migration error for old specs. */
  autofix: z.unknown().optional(),
}).strict().superRefine((environment, ctx) => {
  if (environment.autofix !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'environments.*.autofix has been removed. Use hv_logs source="service" errorsOnly=true for live runtime errors; use github.actions.<id> kind="autofix" to repair failed GitHub workflow checks.',
      path: ['autofix'],
    });
  }
  if (environment.domainRegistration && !environment.domain) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'domainRegistration requires domain',
      path: ['domainRegistration'],
    });
  }
  if (environment.email.inbound) {
    const inbound = environment.email.inbound;
    const service = environment.services[inbound.service];
    if (!service) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inbound email targets unknown service "${inbound.service}"`,
        path: ['email', 'inbound', 'service'],
      });
    } else if (service.workloadKind !== 'web' || service.public === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inbound email service "${inbound.service}" must be a public web service`,
        path: ['email', 'inbound', 'service'],
      });
    }
    if (!environment.domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inbound email requires environment.domain so Hypervibe can manage its MX record',
        path: ['email', 'inbound', 'hostname'],
      });
    } else {
      const hostname = inbound.hostname.toLowerCase().replace(/\.$/, '');
      const domain = environment.domain.toLowerCase().replace(/\.$/, '');
      if (!hostname.endsWith(`.${domain}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `inbound email hostname must be a subdomain of ${environment.domain}`,
          path: ['email', 'inbound', 'hostname'],
        });
      }
    }
  }
  if (environment.email.deliveryEvents) {
    const deliveryEvents = environment.email.deliveryEvents;
    const service = environment.services[deliveryEvents.service];
    if (!service) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `delivery events target unknown service "${deliveryEvents.service}"`,
        path: ['email', 'deliveryEvents', 'service'],
      });
    } else if (service.workloadKind !== 'web' || service.public === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `delivery-event service "${deliveryEvents.service}" must be a public web service`,
        path: ['email', 'deliveryEvents', 'service'],
      });
    }
    const uniqueEvents = new Set(deliveryEvents.events);
    if (uniqueEvents.size !== deliveryEvents.events.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'delivery events cannot contain duplicates',
        path: ['email', 'deliveryEvents', 'events'],
      });
    }
  }
  if (environment.email.forwarding) {
    if (!environment.domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'email forwarding requires environment.domain',
        path: ['email', 'forwarding'],
      });
    } else {
      const domain = environment.domain.toLowerCase().replace(/\.$/, '');
      for (const [alias, destination] of Object.entries(environment.email.forwarding.aliases)) {
        if (destination.toLowerCase() === `${alias.toLowerCase()}@${domain}`) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `forwarding alias "${alias}" cannot forward to itself`,
            path: ['email', 'forwarding', 'aliases', alias],
          });
        }
      }
    }
  }
  if (environment.email.sender && environment.domain) {
    const senderDomain = environment.email.sender.address.split('@').at(-1)?.toLowerCase();
    const domain = environment.domain.toLowerCase().replace(/\.$/, '');
    if (senderDomain !== domain && !senderDomain?.endsWith(`.${domain}`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `email sender must use ${environment.domain} or one of its subdomains`,
        path: ['email', 'sender', 'address'],
      });
    }
  }
  if (environment.email.enabled) {
    for (const key of EMAIL_MANAGED_ENV_KEYS) {
      if (key in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `email-managed environment variable "${key}" cannot also be declared in envVars`,
          path: ['envVars', key],
        });
      }
      if (environment.envVarExceptions?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `email-managed environment variable "${key}" cannot also be an environment variable exception`,
          path: ['envVarExceptions'],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `email-managed environment variable "${key}" cannot also be selected through envFile.include`,
          path: ['envFile', 'include'],
        });
      }
      if (environment.removeEnvVars?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `email-managed environment variable "${key}" cannot also be retired`,
          path: ['removeEnvVars'],
        });
      }
    }
  }
  if (environment.messaging) {
    const messaging = environment.messaging;
    const runtimeServices = new Set<string>();
    for (const [index, serviceName] of messaging.services.entries()) {
      if (runtimeServices.has(serviceName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Twilio runtime service "${serviceName}" is listed more than once`,
          path: ['messaging', 'services', index],
        });
      }
      runtimeServices.add(serviceName);
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Twilio runtime targets unknown service "${serviceName}"`,
          path: ['messaging', 'services', index],
        });
      }
    }
    for (const [name, target] of [
      ['inbound', messaging.service.inbound],
      ['deliveryStatus', messaging.service.deliveryStatus],
    ] as const) {
      if (!target) continue;
      const service = environment.services[target.service];
      if (!service) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Twilio ${name} webhook targets unknown service "${target.service}"`,
          path: ['messaging', 'service', name, 'service'],
        });
      } else if (service.workloadKind !== 'web' || service.public === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Twilio ${name} webhook service "${target.service}" must be a public web service`,
          path: ['messaging', 'service', name, 'service'],
        });
      }
      if (!runtimeServices.has(target.service)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Twilio ${name} webhook service "${target.service}" must also be listed in messaging.services for signature validation`,
          path: ['messaging', 'service', name, 'service'],
        });
      }
    }
    const databaseAliasKeys = new Set(Object.values(environment.services)
      .flatMap((service) => Object.keys(service.databaseEnvAliases ?? {})));
    for (const key of MESSAGING_MANAGED_ENV_KEYS) {
      if (databaseAliasKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `messaging-managed environment variable "${key}" cannot also be a managed database alias`,
          path: ['messaging'],
        });
      }
      if (key in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `messaging-managed environment variable "${key}" cannot also be declared in envVars`,
          path: ['envVars', key],
        });
      }
      if (environment.envVarExceptions?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `messaging-managed environment variable "${key}" cannot also be an environment variable exception`,
          path: ['envVarExceptions'],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `messaging-managed environment variable "${key}" cannot also be selected through envFile.include`,
          path: ['envFile', 'include'],
        });
      }
      if (environment.removeEnvVars?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `messaging-managed environment variable "${key}" cannot also be retired`,
          path: ['removeEnvVars'],
        });
      }
    }
  }
  if (environment.loadBalancer) {
    if (!environment.domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'loadBalancer requires domain because the domain is its public hostname',
        path: ['loadBalancer'],
      });
    }
    const seenServices = new Set<string>();
    for (const [index, serviceName] of environment.loadBalancer.services.entries()) {
      if (seenServices.has(serviceName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `loadBalancer service "${serviceName}" is declared more than once`,
          path: ['loadBalancer', 'services', index],
        });
        continue;
      }
      seenServices.add(serviceName);
      const service = environment.services[serviceName];
      if (!service) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `loadBalancer targets unknown service "${serviceName}"`,
          path: ['loadBalancer', 'services', index],
        });
      } else if (service.workloadKind !== 'web' || service.public === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `loadBalancer service "${serviceName}" must be a public web service`,
          path: ['loadBalancer', 'services', index],
        });
      }
    }
  }
  if (environment.ios?.release) {
    for (const [index, serviceName] of environment.ios.release.services.entries()) {
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `iOS release gate targets unknown service "${serviceName}"`,
          path: ['ios', 'release', 'services', index],
        });
      }
    }
    if (
      environment.deploy?.strategy !== 'branch'
      || (environment.deploy.trigger ?? 'ci') !== 'ci'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ios.release requires deploy.strategy="branch" and deploy.trigger="ci" so mobile releases can consume server deploy evidence',
        path: ['ios', 'release'],
      });
    }
  }
  const databaseAliasKeys = new Set<string>();
  const replicaRuntimeKeys = new Set(environment.database?.resilience
    ? [
      'DATABASE_READ_URL',
      ...Object.keys(environment.database.resilience.replicas ?? {}).map((name) =>
        `DATABASE_READ_URL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
      ),
    ]
    : []);
  for (const key of replicaRuntimeKeys) {
    if (key in environment.envVars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable "${key}" is managed by database read-replica wiring`,
        path: ['envVars', key],
      });
    }
    if (environment.envFile?.include.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable "${key}" is managed by database read-replica wiring`,
        path: ['envFile', 'include'],
      });
    }
    if (environment.removeEnvVars?.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable "${key}" must be removed by changing database.resilience.replicas`,
        path: ['removeEnvVars'],
      });
    }
  }
  for (const [serviceName, service] of Object.entries(environment.services)) {
    for (const alias of Object.keys(service.databaseEnvAliases ?? {})) {
      databaseAliasKeys.add(alias);
      if (!environment.database) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `service "${serviceName}" declares databaseEnvAliases but this environment has no database`,
          path: ['services', serviceName, 'databaseEnvAliases'],
        });
      }
      if ((DATABASE_ENV_ALIAS_SOURCES as readonly string[]).includes(alias) || replicaRuntimeKeys.has(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot replace a canonical managed database variable`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
      if (alias in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot also be declared in envVars`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
      if (environment.envFile?.include.includes(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot also be selected through envFile.include`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
      if (environment.removeEnvVars?.includes(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database alias "${alias}" cannot also be retired`,
          path: ['services', serviceName, 'databaseEnvAliases', alias],
        });
      }
    }
  }
  const retiredKeys = new Set<string>();
  for (const key of environment.removeEnvVars ?? []) {
    if (retiredKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `retired environment variable "${key}" is listed more than once`,
        path: ['removeEnvVars'],
      });
    }
    retiredKeys.add(key);
    if (key in environment.envVars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `retired environment variable "${key}" cannot also be declared in envVars`,
        path: ['removeEnvVars'],
      });
    }
    if (environment.envFile?.include.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `retired environment variable "${key}" cannot also be selected through envFile.include`,
        path: ['removeEnvVars'],
      });
    }
  }
  const exceptionKeys = new Set<string>();
  for (const key of environment.envVarExceptions ?? []) {
    if (exceptionKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" is listed more than once`,
        path: ['envVarExceptions'],
      });
    }
    exceptionKeys.add(key);
    if (key in environment.envVars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" cannot also be declared in envVars`,
        path: ['envVarExceptions'],
      });
    }
    if (environment.envFile?.include.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" cannot also be selected through envFile.include`,
        path: ['envVarExceptions'],
      });
    }
    if (environment.removeEnvVars?.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `environment variable exception "${key}" cannot also be retired`,
        path: ['envVarExceptions'],
      });
    }
  }
  const storageByService = new Map<string, string>();
  for (const [storageName, storage] of Object.entries(environment.storage ?? {})) {
    for (const serviceName of storage.injectInto) {
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `storage target service "${serviceName}" is not declared in this environment`,
          path: ['storage', storageName, 'injectInto'],
        });
      }
      const existing = storageByService.get(serviceName);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `service "${serviceName}" cannot receive both "${existing}" and "${storageName}" because bucket wiring uses the standard AWS_* variable names`,
          path: ['storage', storageName, 'injectInto'],
        });
      } else {
        storageByService.set(serviceName, storageName);
      }
    }
  }
  const stripe = environment.payments?.stripe;
  if (stripe) {
    const catalogEnvVars = Object.values(stripe.catalog?.products ?? {})
      .flatMap((product) => Object.values(product.prices).map((price) => price.envVar));
    const hasRuntimeProjection = Boolean(stripe.credentials) || catalogEnvVars.length > 0;
    const targetServices = stripe.services
      ?? (hasRuntimeProjection ? Object.keys(environment.services) : []);
    if (hasRuntimeProjection && targetServices.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stripe runtime environment sync requires at least one target service',
        path: ['payments', 'stripe', 'services'],
      });
    }
    const seenServices = new Set<string>();
    for (const serviceName of targetServices) {
      if (seenServices.has(serviceName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe environment sync service "${serviceName}" is listed more than once`,
          path: ['payments', 'stripe', 'services'],
        });
      }
      seenServices.add(serviceName);
      if (!environment.services[serviceName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe environment sync targets unknown service "${serviceName}"`,
          path: ['payments', 'stripe', 'services'],
        });
      }
    }

    for (const [webhookName, webhook] of Object.entries(stripe.webhooks)) {
      if (!environment.services[webhook.service]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe webhook "${webhookName}" targets unknown service "${webhook.service}"`,
          path: ['payments', 'stripe', 'webhooks', webhookName, 'service'],
        });
      }
      if (
        targetServices.includes(webhook.service)
        && (
          catalogEnvVars.includes(webhook.envVar)
          || stripe.credentials?.secretKeyEnvVar === webhook.envVar
          || stripe.credentials?.publishableKeyEnvVar === webhook.envVar
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe webhook "${webhookName}" cannot manage ${webhook.envVar} on service "${webhook.service}" because Stripe runtime sync also manages that variable`,
          path: ['payments', 'stripe', 'webhooks', webhookName, 'envVar'],
        });
      }
    }

    const managedKeys = new Set([
      ...catalogEnvVars,
      ...(stripe.credentials
        ? [
          stripe.credentials.secretKeyEnvVar,
          ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
        ]
        : []),
      ...Object.values(stripe.webhooks).map((webhook) => webhook.envVar),
    ]);
    for (const key of managedKeys) {
      if (databaseAliasKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be a managed database alias`,
          path: ['payments', 'stripe'],
        });
      }
      if (key in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be declared in envVars`,
          path: ['envVars', key],
        });
      }
      if (environment.envVarExceptions?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be an environment variable exception`,
          path: ['envVarExceptions'],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be selected through envFile.include`,
          path: ['envFile', 'include'],
        });
      }
      if (environment.removeEnvVars?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stripe-managed environment variable "${key}" cannot also be retired`,
          path: ['removeEnvVars'],
        });
      }
    }
  }
});

export const projectSpecSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  gitRemoteUrl: z.string().min(1).optional(),
  /** Project-wide build and automation runtime desired state. */
  runtime: projectRuntimeSpecSchema.optional(),
  /** Canonical provider-neutral code-host and primary application-CI selection. */
  devops: devopsSpecSchema.optional(),
  github: githubSpecSchema.optional(),
  /** @deprecated Use github.collaboration. Accepted for one compatibility period. */
  collaboration: collaborationSpecSchema.optional(),
  secrets: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'secret names must be valid environment variable names'),
    delegatedSecretSpecSchema
  ).default({}),
  environments: z.record(z.string().min(1), environmentSpecSchema),
}).strict().superRefine((spec, ctx) => {
  for (const [targetName, target] of Object.entries(spec.environments)) {
    const migration = target.dataMigration;
    if (!migration) continue;
    if (migration.fromEnvironment === targetName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dataMigration.fromEnvironment must name a different environment',
        path: ['environments', targetName, 'dataMigration', 'fromEnvironment'],
      });
      continue;
    }
    const source = spec.environments[migration.fromEnvironment];
    if (!source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dataMigration.fromEnvironment targets unknown environment "${migration.fromEnvironment}"`,
        path: ['environments', targetName, 'dataMigration', 'fromEnvironment'],
      });
      continue;
    }
    if (migration.include.database && (!source.database || !target.database)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'database migration requires database declarations in both source and target environments',
        path: ['environments', targetName, 'dataMigration', 'include', 'database'],
      });
    }
    for (const [index, storageName] of migration.include.storage.entries()) {
      if (!source.storage?.[storageName] || !target.storage?.[storageName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `storage migration "${storageName}" requires matching declarations in both source and target environments`,
          path: ['environments', targetName, 'dataMigration', 'include', 'storage', index],
        });
      }
    }
  }
  if (spec.github && spec.collaboration) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use github.collaboration; github and legacy top-level collaboration cannot both be declared',
      path: ['collaboration'],
    });
  }
  if (spec.github && spec.devops) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Legacy github and canonical devops cannot both be declared',
      path: ['devops'],
    });
  }
  if (
    spec.devops?.canonicalEnvironment
    && spec.devops.canonicalEnvironment !== 'repository'
    && !spec.environments[spec.devops.canonicalEnvironment]
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `devops.canonicalEnvironment targets unknown environment "${spec.devops.canonicalEnvironment}"`,
      path: ['devops', 'canonicalEnvironment'],
    });
  }
  if (!spec.devops?.ci) {
    for (const [environmentName, environment] of Object.entries(spec.environments)) {
      if (
        spec.devops
        && environment.deploy?.strategy === 'branch'
        && environment.deploy.trigger !== 'native'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'deploy.trigger="ci" requires devops.ci.provider',
          path: ['environments', environmentName, 'deploy', 'trigger'],
        });
      }
    }
  }
  if (spec.devops?.code.repository.state === 'absent') {
    if (spec.devops.code.repository.management !== 'managed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'devops.code.repository.state="absent" requires management="managed"; Hypervibe never deletes an externally managed repository',
        path: ['devops', 'code', 'repository', 'management'],
      });
    }
    if (spec.devops.ci) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'devops.ci must be removed before the managed code repository can be declared absent',
        path: ['devops', 'ci'],
      });
    }
    for (const [environmentName, environment] of Object.entries(spec.environments)) {
      if (environment.deploy?.strategy === 'branch') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'branch deploys must be removed before the managed code repository can be declared absent',
          path: ['environments', environmentName, 'deploy', 'strategy'],
        });
      }
    }
  }
  if (
    spec.github?.canonicalEnvironment
    && spec.github.canonicalEnvironment !== 'repository'
    && !spec.environments[spec.github.canonicalEnvironment]
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `github.canonicalEnvironment targets unknown environment "${spec.github.canonicalEnvironment}"`,
      path: ['github', 'canonicalEnvironment'],
    });
  }
  const restoreDrillEnvironments = Object.entries(spec.environments)
    .filter(([, environment]) => Boolean(environment.database?.resilience?.restoreDrill))
    .map(([environmentName]) => environmentName);
  if (restoreDrillEnvironments.length > 0 && (!spec.github || spec.github.enabled === false)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'database restoreDrill requires enabled top-level github desired state for its managed scheduled workflow',
      path: ['github'],
    });
  }
  if (restoreDrillEnvironments.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'the first restore-drill slice supports one canonical environment per repository',
      path: ['environments'],
    });
  }
  if (restoreDrillEnvironments.length === 1) {
    const canonicalEnvironment = spec.github?.canonicalEnvironment
      ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0]);
    if (restoreDrillEnvironments[0] !== canonicalEnvironment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `database restoreDrill must target the GitHub canonical environment "${canonicalEnvironment}" in the first slice`,
        path: ['environments', restoreDrillEnvironments[0], 'database', 'resilience', 'restoreDrill'],
      });
    }
  }
  const deliveryEventOwners = Object.entries(spec.environments)
    .filter(([, environment]) => Boolean(environment.email.deliveryEvents))
    .map(([environmentName]) => environmentName);
  if (deliveryEventOwners.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SendGrid has one account-level delivery-event webhook; declare it in only one environment (currently: ${deliveryEventOwners.join(', ')})`,
      path: ['environments'],
    });
  }
  const githubSecretKeys = Object.entries(spec.secrets)
    .filter(([, secret]) => secret.githubActions?.repository || secret.githubActions?.environments.length)
    .map(([key]) => key);
  if (githubSecretKeys.length > 0 && (!spec.github || spec.github.enabled === false)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `GitHub Actions secret destinations require enabled top-level github desired state (${githubSecretKeys.join(', ')})`,
      path: ['github'],
    });
  }
  for (const [key, secret] of Object.entries(spec.secrets)) {
    const seen = new Set<string>();
    for (const environmentName of secret.environments) {
      if (seen.has(environmentName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" lists environment "${environmentName}" more than once`,
          path: ['secrets', key, 'environments'],
        });
        continue;
      }
      seen.add(environmentName);

      const environment = spec.environments[environmentName];
      if (!environment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" targets unknown environment "${environmentName}"`,
          path: ['secrets', key, 'environments'],
        });
        continue;
      }
      if (Object.keys(environment.services).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" requires at least one service in environment "${environmentName}"`,
          path: ['secrets', key, 'environments'],
        });
      }
      if (key in environment.envVars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be declared in environments.${environmentName}.envVars`,
          path: ['environments', environmentName, 'envVars', key],
        });
      }
      if (environment.envVarExceptions?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be an environment variable exception in "${environmentName}"`,
          path: ['environments', environmentName, 'envVarExceptions'],
        });
      }
      if (environment.envFile?.include.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot be selected through environments.${environmentName}.envFile.include`,
          path: ['environments', environmentName, 'envFile', 'include'],
        });
      }
      if (environment.removeEnvVars?.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be retired in environment "${environmentName}"`,
          path: ['environments', environmentName, 'removeEnvVars'],
        });
      }
      const databaseAliasServices = Object.entries(environment.services)
        .filter(([, service]) => key in (service.databaseEnvAliases ?? {}))
        .map(([serviceName]) => serviceName);
      if (databaseAliasServices.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be a managed database alias on service(s): ${databaseAliasServices.join(', ')}`,
          path: ['secrets', key],
        });
      }
      const stripe = environment.payments?.stripe;
      const catalogEnvVars = Object.values(stripe?.catalog?.products ?? {})
        .flatMap((product) => Object.values(product.prices).map((price) => price.envVar));
      const stripeManagedKeys = new Set([
        ...catalogEnvVars,
        ...(stripe?.credentials
          ? [
            stripe.credentials.secretKeyEnvVar,
            ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
          ]
          : []),
        ...Object.values(stripe?.webhooks ?? {}).map((webhook) => webhook.envVar),
      ]);
      if (stripeManagedKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be managed by Stripe environment sync in "${environmentName}"`,
          path: ['secrets', key],
        });
      }
      if (environment.email.enabled && (EMAIL_MANAGED_ENV_KEYS as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be managed by email desired state in "${environmentName}"`,
          path: ['secrets', key],
        });
      }
      if (environment.messaging && (MESSAGING_MANAGED_ENV_KEYS as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `delegated secret "${key}" cannot also be managed by messaging desired state in "${environmentName}"`,
          path: ['secrets', key],
        });
      }
    }
  }
});

export type ServiceSpec = z.infer<typeof serviceSpecSchema>;
export type ProjectRuntimeSpec = z.infer<typeof projectRuntimeSpecSchema>;
export type DatabaseSpec = z.infer<typeof databaseSpecSchema>;
export type IosSpec = z.infer<typeof iosSpecSchema>;
export type IosReleaseSpec = z.infer<typeof iosReleaseSpecSchema>;
export type QueueSpec = z.infer<typeof queueSpecSchema>;
export type StorageSpec = z.infer<typeof storageSpecSchema>;
export type DataMigrationSpec = z.infer<typeof dataMigrationSpecSchema>;
export type MaintenanceSpec = z.infer<typeof maintenanceSpecSchema>;
export type StripePriceEnvBindingSpec = z.infer<typeof stripePriceEnvBindingSpecSchema>;
export type StripeCatalogPriceSpec = z.infer<typeof stripeCatalogPriceSpecSchema>;
export type StripeCatalogProductSpec = z.infer<typeof stripeCatalogProductSpecSchema>;
export type StripeCatalogSpec = z.infer<typeof stripeCatalogSpecSchema>;
export type StripeWebhookSpec = z.infer<typeof stripeWebhookSpecSchema>;
export type StripeEnvironmentSyncSpec = z.infer<typeof stripeEnvironmentSyncSpecSchema>;
export type PaymentsSpec = z.infer<typeof paymentsSpecSchema>;
export type EmailSenderSpec = z.infer<typeof emailSenderSpecSchema>;
export type EmailInboundSpec = z.infer<typeof emailInboundSpecSchema>;
export type EmailDeliveryEventsSpec = z.infer<typeof emailDeliveryEventsSpecSchema>;
export type EmailForwardingSpec = z.infer<typeof emailForwardingSpecSchema>;
export type EmailSpec = z.infer<typeof emailSpecSchema>;
export type TwilioMessagingSpec = z.infer<typeof twilioMessagingSpecSchema>;
export type IosTestflightGroupSpec = z.infer<typeof iosTestflightGroupSpecSchema>;
export type DomainRegistrationSpec = z.infer<typeof domainRegistrationSpecSchema>;
export type EnvFileSpec = z.infer<typeof envFileSpecSchema>;
export type DelegatedSecretSpec = z.infer<typeof delegatedSecretSpecSchema>;
export type CollaborationSpec = z.infer<typeof collaborationSpecSchema>;
export type GitHubScheduleSpec = z.infer<typeof githubScheduleSpecSchema>;
export type GitHubAutomationSpec = z.infer<typeof githubAutomationSpecSchema>;
export type GitHubPagesSpec = z.infer<typeof githubPagesSpecSchema>;
export type GitHubSpec = z.infer<typeof githubSpecSchema>;
export type DevOpsSpec = z.infer<typeof devopsSpecSchema>;
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;
export type ProjectSpec = z.infer<typeof projectSpecSchema>;
