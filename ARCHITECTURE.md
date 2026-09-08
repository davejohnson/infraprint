# Hypervibe Architecture

Hypervibe is an infrastructure creation, migration, and destruction orchestrator.
It is not a loose collection of imperative provider functions.

## Product Model

Treat the desired-state loop as the product center:

1. `hv_spec` defines infrastructure intent.
2. `hv_plan` observes live provider state, checks required connections, computes drift, orders dependencies, and surfaces warnings or blocked work.
3. `hv_apply` converges from a specific plan, rejects stale plans, records receipts, and confirm-gates destructive or billable actions.
4. `hv_status` verifies convergence and reports drift.

Fresh repositories enter that loop through `hv_spec`. A read in a git
repository with no matching local or repo-backed project returns a successful,
explicit `initialized: false` bootstrap contract so an agent can inspect the
application and submit its initial desired state. The read performs no writes;
only the following `hv_spec` call with `spec` creates the project and committed
`.hypervibe/spec.json`. Other commands continue to reject uninitialized
projects as `NOT_FOUND` and point back to this flow. An unknown explicit project
selector is treated as a possible typo: the error returns the requested name,
the current-repository candidate, and a bounded registered-project list so an
agent can retry an unambiguous correction and a CLI user can check the name.

When adding capabilities that create, mutate, purchase, migrate, deploy, schedule, or destroy infrastructure, default to modeling them in the spec and plan/apply flow. Use separate imperative tools only for read-only inspection, explicit operational actions, or narrow escape hatches; they should not become the primary path for lifecycle-managed infrastructure.

Domain, DNS, registrar, hosting, load balancers, database, object storage, queues, deploy-source, CI deploy, and recurring job changes are lifecycle infrastructure. Do not hide those mutations inside CI, diagnostics, or helper tools; add them to desired state, compute them in `hv_plan`, and converge them in `hv_apply`.

Read-only provider forensics belong in `hv_inspect`. Adoption of already-existing provider infrastructure into Hypervibe local/repo state belongs in `hv_import` and must be explicit, mapping-driven, and confirmation-gated. Do not use `hv_import` as a generic read tool.

## State Ownership

Desired infrastructure state is repo-backed when Hypervibe runs inside a git worktree:

- `.hypervibe/spec.json` is the committed source of truth for infrastructure shape.
- `.hypervibe/bindings.json` stores non-secret provider identity bindings needed for team members to observe the same live resources.
- Scoped storage identity is the composite of the provider resource id and its
  provider-native context. Keep `externalId` provider-native and present the
  opaque, non-secret `instanceScope` beside it. Railway uses project and
  environment ids; cloud adapters may use account/project, region, resource
  group, storage-account, or similar coordinates. Matching unscoped ids alone
  do not prove that two environments share one data instance.
- Local SQLite is a cache/history/secrets store for revisions, runs, receipts, and local credentials.
- Provider APIs are observed live state.

Do not treat cached local state as proof of convergence when live observation is available.

Unreadable local state is not empty state. Non-empty corrupt or schema-invalid
JSON in bindings, plans, receipts, service configuration, or policies blocks
the operation; repositories must never replace it with `{}`/`[]` and continue
reconciliation. Empty legacy columns may still decode to their declared empty
shape.

A local project with no environment/provider decision uses the non-provider
sentinel `unconfigured`. Project creation, adapter lookup, health/log routing,
and legacy bootstrap must never turn a missing choice into Cloud Run, Railway,
or another real provider. The first reviewed environment spec establishes the
project's hosting provider before plan/apply can mutate infrastructure.

## Project Runtime Desired State

The top-level `runtime` field declares the project runtime used by
Hypervibe-generated build and automation paths. It is a typed contract such as
`{ "kind": "node", "version": "24", "installCommand": "npm install --global npm@11.19.0 && npm ci", "buildCommand": "npm run build" }`
or `{ "kind": "python", "version": "3.13", "installCommand": "python -m pip install -r requirements.txt" }`;
it is not the runtime used to execute Hypervibe itself.

- A repository-owned Dockerfile remains authoritative and is never rewritten
  from `runtime`. When no Dockerfile exists, generated CI/provider builds use
  the declared runtime image and only the commands persisted in desired state.
- Migration setup, project build jobs, and managed checks with no explicit
  same-kind version/install command inherit the reviewed project runtime. A
  check-level version or install command remains an intentional override.
- Generated containers never invent a package manager, dependency install,
  build, or service start command. Fresh-project analysis may derive commands
  from one consistent lockfile, an exact `packageManager` declaration,
  and named package scripts. Those commands become desired state and are
  reviewable. Missing or conflicting evidence blocks generated builds; a
  repository Dockerfile remains the escape hatch for custom build systems.
- Cron workloads always declare `startCommand`. Provider adapters must not
  substitute an application command while creating or updating a scheduled job.
- Hypervibe-owned isolated helpers, such as App Store releases, restore drills,
  provider bootstrap images, and portable deploy gates, share one explicit
  managed runtime contract and must not inherit project language settings. Its
  version is regression-checked against Hypervibe's own `.node-version`; exact
  helper dependencies are checked against the application lockfile.
- Runtime changes are part of each environment's deployment contract and are
  projected into local service build state during apply. Because hosting APIs
  generally cannot observe the base runtime directly, that drift is reported
  as unverified rather than falsely presented as provider-confirmed.
- On fresh-project discovery Hypervibe inspects repository-native evidence
  (`.node-version`, `.nvmrc`, `.python-version`, `.tool-versions`, Volta, and
  language manifests). A single concrete Node or Python selection is proposed
  to the agent and persisted in the initial spec; conflicting, unversioned,
  polyglot, and custom-language projects require an explicit decision or a
  repository Dockerfile.
- Specs that omit `runtime` never imply a Node or Python version. A
  repository-owned Dockerfile can build without this field; generated builds,
  migrations, and checks that need language tooling stop with runtime guidance
  instead of silently selecting a compatibility default.
- Repository evidence is rechecked by `hv_spec`. A changed native version is
  returned as a suggested desired-state patch, not applied invisibly. Major or
  language changes therefore remain plan/apply reviewed, while declared major
  or minor selectors use the latest compatible patch in generated CI and
  pulled runtime images.

## Code Map

- `src/application/`: the transport-neutral command registry, command context, result envelope, provider bootstrap, and shared orchestration entrypoint.
- `src/application/hosted/`: side-effect-free inspection contracts for a trusted hosting process. They validate exact source bytes and return bounded, value-free receipts without opening local state or contacting providers.
- `src/interfaces/mcp/`: the MCP registration/response adapter. It exposes the canonical `hv_*` ids without owning command behavior.
- `src/interfaces/cli/`: the human and JSON CLI adapter. It parses friendly command paths into the same registry used by MCP.
- `src/tools/`: transport-neutral command group declarations retained under their historical filenames while they are moved incrementally; they must not import MCP.
- `src/domain/spec/`: the desired-state document (`ProjectSpec`), revisioned in the `project_specs` table through `SpecStore`.
- `src/domain/plan/`: the reconciliation engine: observe live state, pure `diffEnvironment`, `ConvergeExecutor`, and the planId handshake.
- `src/adapters/providers/`: provider-owned API integrations and provider-specific lifecycle behavior.
- `src/domain/services/`: orchestration services that sequence capabilities without owning provider API quirks.
- `src/adapters/db/repositories/`: SQLite data access; JSON columns should be validated through `parseJsonColumn`.

Legacy `*.tools.ts` files that are not included by `createCommandRegistry` are internal helper libraries pending extraction. Do not expose them through an interface.

## Interface Boundary

MCP and CLI are adapters over one command application layer:

```text
CLI ─┐
     ├─ command registry/context/results ─ domain plan/services ─ providers
MCP ─┘
```

- Define a command once with its canonical id, CLI path, description, Zod input schema, safety metadata, and handler.
- Interface code may parse, render, prompt, and translate protocol envelopes. It must not contain provider calls or infrastructure orchestration.
- The command runner owns validation, error conversion, redaction, and the structured result envelope. Secrets must be redacted before any interface sees a result.
- MCP `structuredContent` and CLI `--json` expose the same redacted command envelope.
- MCP resolves repository-backed project state from the client's declared file roots for each request, never from the long-running server process's launch directory. Multiple project identities, unavailable roots, and roots with unmatched repository identities fail closed instead of selecting unrelated single-project state.
- The `hypervibe` no-argument entrypoint remains MCP-compatible. Human CLI commands use explicit arguments; `hypervibe mcp` and `hypervibe-mcp` are explicit MCP entrypoints.
- A future HTTP adapter may use this boundary, but remote auth, locking, state ownership, and secret custody are separate product decisions. Do not introduce an unauthenticated remote interface.
- `@hypervibe/hypervibe/hosted` is a library boundary, not an HTTP interface. Its versioned committed-spec inspector accepts bytes only with a provider-verified repository identity, exact full revision, and matching SHA-256. The trusted host owns account authorization, code-host installation tokens, exact-revision reads, pairing, and tenancy; the inspector owns the existing project schema, repository-claim consistency, secret-shaped-content rejection, and a deterministic import receipt.
- Hosted inspection never reads a checkout, opens SQLite, observes infrastructure, plans, applies, or manufactures provider endpoints. It returns only declared environments, services, provider capabilities, and HTTPS endpoints that are explicit safe domains in desired state. A missing spec repository claim remains visible as unverified; a present mismatched claim fails closed.


## Repository Collaboration

Repository collaboration setup is lifecycle development infrastructure. GitHub issue labels, issue templates, PR templates, branch protection, and deploy-promotion guardrails should be expressed in the project spec and converged through `hv_plan`/`hv_apply`. Do not add one-off setup tools for these paths unless they are read-only inspection or explicit repair operations.

Collaborator invitations are guidance-only by default. If Hypervibe ever mutates repository access, that must be confirm-gated, permission-audited, and represented as desired state rather than hidden inside a helper tool.

Do not model collaborators as permanent Hypervibe operator/contributor roles.
The current chat task determines the required capability. Any checkout can
read committed desired topology and non-secret bindings, and may check public
bound endpoints without provider credentials. Exact drift, private logs, and
provider mutations require a verified connection on the machine performing
that operation.

Missing provider access is a task boundary, not a reason to grant membership
automatically. Offer either to connect credentials the user already controls
or to prepare a value-free handoff naming the provider, scope, environment,
and blocked task for the person who manages that access. A project owner can
keep provider control and execute the resulting plan; add a collaborator to a
provider only when they truly need independent mutation authority.

This access model does not require a hosted Hypervibe control plane, shared
drift service, or secret relay. API-key transfer is initially an external human
workflow: the key owner may supply it out of band for the infrastructure owner
to store through a safe local reference, or both may use an existing shared
secret manager such as 1Password. Hypervibe records only the delegated slot
and value-free handoff metadata.

## Provider Boundary

Keep provider behavior behind the provider boundary. Generic orchestration code in `src/domain/plan`, shared `src/domain/services`, and shared command modules must not grow provider-name branches or direct imports from `src/adapters/providers/<provider>` just to express hosting behavior.

Provider-specific logic belongs under `src/adapters/providers/<provider>/...` and should be exposed through:

- adapter capabilities,
- provider registry metadata,
- provider-owned helper modules,
- or a narrow provider-owned service.

Provider adapters own provider quirks:

- API endpoints and API-specific request shapes,
- generated provider CI steps,
- credential-to-secret mapping,
- log/build/deploy semantics,
- polling and terminal-state rules,
- verification DNS record shapes,
- retry behavior,
- provider-specific error enrichment.

Generic orchestration owns sequencing and policy:

- ordering dependencies,
- enforcing confirmations,
- freezing encrypted plan inputs,
- routing actions by capability,
- producing provider-neutral receipts,
- and preserving the spec/plan/apply contract.

Every registered hosting lifecycle declares the exact `workloadKinds` its
adapter can reconcile end to end (`web`, `worker`, and/or `cron`). Registry
registration rejects missing, empty, duplicate, or unknown claims. Spec
validation checks every declared service against that provider-owned metadata
before a new project is persisted and before plan/apply can observe or mutate a
provider project or environment. Do not infer worker support from deployment
category, cron support from a vendor's general product surface, or either from
an adapter's unrelated feature flags. A provider is listed for a workload kind
only after its create, update, CI/deploy, observation, and teardown paths handle
that kind; any limits on exact kind observation remain separately declared.

Product-specific surfaces such as SendGrid email setup or Stripe payments may stay opinionated when they are not part of generic infrastructure reconciliation.

## Platform Bindings

Environments store provider bindings in `platformBindings` using generic keys only:

```json
{
  "provider": "<registered-hosting-provider>",
  "projectId": "<provider-project-id>",
  "environmentId": "<provider-environment-id>",
  "services": {
    "api": {
      "serviceId": "...",
      "url": "...",
      "customDomains": ["..."]
    }
  }
}
```

Provider-specific legacy binding names such as `railwayProjectId` and `railwayEnvironmentId` were migrated away in SQLite migration 7.

Custom-domain traffic proxying is explicit desired state through the optional
`environment.domainProxy` boolean (default `true`). Verification records always
remain unproxied. A successful DNS write records the domain name and effective
proxy state in `platformBindings.domainDns`, so changing the setting plans a
domain update instead of hiding an imperative Cloudflare toggle. This supports
the reversible certificate-validation workflow where a traffic CNAME is made
DNS-only until the hosting provider verifies the domain, then proxied again.
Environment custom domains always require a successful provider-side attachment
before Hypervibe writes DNS. Hosting providers declare `lifecycle.hosting` and
their custom-domain support in registry metadata; generic orchestration must not
infer support from a provider name or deployment category. There is no generic
CNAME-to-service fallback. Cloud Run, DigitalOcean App Platform, Railway, and
Vercel implement provider-owned attach, observation, and exact detach contracts.
Each successful attachment persists the provider
domain id, service and environment ids, Cloudflare zone id, and every managed
DNS record id before it may converge. An observed provider attachment without
that durable binding is normally an adoption candidate and blocks with
`hv_import` guidance; it is never silently adopted. The compatibility exception
requires exact local project, environment, and service bindings plus one live,
provider-verified attachment of the desired domain to that same service. A
legacy service binding may omit the hostname because the reviewed spec and
provider observation supply that evidence; a matching hostname alone is never
identity. Planning emits an explicit local-only adoption action carrying every
durable provider id. Apply re-observes those identities before recording the
provider domain id and makes no provider or DNS mutation. It does not claim
unrecorded DNS identities, so a later detach still blocks until the exact DNS
binding is restored. Missing ownership evidence, duplicate attachments,
partial observation, or conflicting bindings continue to block. Removing `environment.domain` plans a
confirmation-gated detach of only those exact identities, with provider absence
verified before DNS deletion. A provider attachment accepted before its DNS
requirements are available is persisted with a known-empty record set so a
later plan can continue or safely detach it.

Provider certificate flows remain provider-owned. Cloud Run uses native domain
mappings only in regions where Google exposes that API. DigitalOcean preserves
the full App Spec while reconciling its domain collection. Vercel uses the exact
Project-domain identity. Cloud Run declares DNS-only traffic in provider
metadata, so generic apply forces its Cloudflare traffic records unproxied even
if `domainProxy` was requested. GitHub Pages remains the separate project-level
lifecycle described below.

AWS ECS Express Mode and Azure Container Apps use authentication-only
connections. Infrastructure identities must never return to their credential
schemas.

Hosting geography is desired state, never authentication. An environment may
set `hosting.region`; when it does not, the provider adapter uses its documented
Hypervibe default. Agents should normally omit the field unless latency, data
residency, provider availability, or existing infrastructure gives them a
reason to choose it. Connection forms and credential files must not ask users
for region or location.

- The `ecs` connection contains only an AWS access-key pair. Its explicit
  per-environment project action ensures the selected account/region
  default-VPC prerequisite and owns one tagged ECR repository, the two
  AWS-documented Express Mode IAM roles, and one ECS cluster. The shared default
  VPC is never treated as an environment-owned deletion target. Each service
  action owns one ECS Express
  Gateway service; AWS owns the Fargate, load-balancer, security-group,
  autoscaling, monitoring, and generated-HTTPS resources inside that service.
  Managed CI may only push to the bound repository and update already-bound
  Express service ARNs.
- The `azure-container-apps` connection contains only a Microsoft Entra service
  principal and subscription. Its explicit per-environment
  project action owns one tagged resource group, Basic ACR registry, ACR push
  assignment, and Container Apps managed environment. Each service action owns
  one system-identity Container App and its exact ACR pull assignment. Managed
  CI may only push to the deterministic bound registry and update already-bound
  Container App ARM ids.
- These provider projects deliberately do not share across Hypervibe
  environments. That makes the existing project action the complete ownership
  and teardown boundary without hiding an environment deletion inside another
  resource action.
- AWS custom domains are phased through a Hypervibe-tagged ACM certificate and
  the exact Express-managed ALB listener rule/certificate attachment. Azure
  custom domains first return the provider's direct DNS and verification
  requirements, then create and bind the managed certificate only after those
  records resolve publicly. Both providers require DNS-only traffic during
  certificate issuance and renewal. Domain detach removes only the exact
  reviewed binding and Hypervibe-owned certificate before DNS deletion.

The removed hand-built ECS and pre-provisioned Container Apps implementations
must not be revived. AWS and Azure datastore and secret providers remain
independent capabilities.

DigitalOcean Container Registry is an account-level hosting prerequisite, not
a credential field. The explicit DigitalOcean project action reuses the
deterministically selected existing registry or creates a free Starter registry
when the account has none. Provider CI only discovers and uses that reviewed
registry; it must never create registry infrastructure. Environment teardown
does not delete the shared account registry.

Hosting-provider migrations retain the abandoned provider identity until
cleanup is provider-confirmed. Every hosting adapter declares its smallest
complete teardown boundary: Cloud Run and Vercel own individual services,
Railway owns one environment inside a shared project, and ECS Express, Azure
Container Apps, and DigitalOcean App Platform own one project/app boundary per
Hypervibe environment. Planning must use that declaration; generic code must
never infer deletion scope from a provider name. Project-boundary cleanup
deletes exact services first and then the owned project. Railway cleanup deletes
the exact environment and must not delete shared Railway services. Every action
is confirmation-gated, provider absence must be verified before the retained
binding is cleared, and a second provider switch is blocked while an earlier
cleanup identity remains.

`hv_inspect` environment forensics are provider-scoped. When the selected host
is not the current host, the selected adapter receives only its own retained
binding (when present), logical project/environment context, and bounded
service-name hints. It must never receive another provider's platform binding.
All hosting adapters expose this read-only inventory contract. For migrations
that predate retained bindings, `hv_import mode="retained-cleanup"` reruns that
inventory, rejects partial, ambiguous, or explicitly unowned results, and
confirmation-gates recording the exact cleanup target. It never mutates the
provider; deletion remains a separately reviewed `hv_plan`/`hv_apply` action.
`hv_plan scope="retained-cleanup"` persists an isolated plan containing only
those previous-host destroy actions. The same isolated scope may include one
exact abandoned PostgreSQL identity recorded through
`hv_import mode="retained-database-cleanup"` after provider-owned inventory.
It may likewise include one exact Redis-compatible cache identity recorded through
`hv_import mode="retained-cache-cleanup"`. These bindings carry the durable provider id and provider-native account/project
and region/organization scope, never connection material. Planning and apply
re-observe that exact scoped identity; deletion is data-bearing and
confirmation-gated, and the binding is cleared only after provider-confirmed
terminal absence. It observes the current host for the usual stale-plan
fingerprint, preflights only the current and retained hosting, database, or cache
providers, and neither loads deploy env files nor resolves unrelated
integrations. `hv_apply` derives that isolation from the persisted plan scope,
not caller input.
This migration-recovery lifecycle is distinct from the future general
environment desired-absent lifecycle.

Provider inventory is provider-owned and mandatory. Registering hosting
lifecycle support fails without bounded provider-owned environment forensics.
Registering any
database, cache, or storage lifecycle capability fails unless the same provider
declares a provider-resource inspector with exact durable-id and exact-name
selectors, a bounded `limit` selector, mutual exclusion between id and name,
and non-empty provider-native scope keys. Every returned identity carries those
non-secret scope values. This registry invariant prevents lifecycle support and
forensic inventory from drifting apart as providers are added or extended.
When an environment has no durable database binding, `hv_inspect` may return
bounded account-level candidates but must label them as unattributed inventory;
it must not collapse a successful inventory containing differently named
instances into `null`, select one by convention, or silently adopt it. Exact
adoption or retained cleanup is a separate explicit `hv_import` decision.

When an attached Railway domain remains provider-unverified, the reviewed
domain update first calls Railway's non-destructive `customDomainUpdate` for
the same environment to refresh provider verification before rewriting DNS.
Verified domains remain read-only on this path.
For a provider adapter that exposes the repair capability, setting a new
`environment.domainRecreateRevision` plans a one-time, confirmation-gated
domain replacement. Apply deletes only the observed custom-domain id, recreates
the same hostname on the same service and environment only after the provider
confirms the old attachment is absent, and writes the provider's fresh DNS
requirements. Duplicate matching attachments block before deletion. The
consumed revision is stored in
`platformBindings.domainDns.recreateRevision` after DNS is written so later
plans cannot repeat the deletion. Keep `domainProxy` disabled until provider
ownership and certificate issuance are verified, then enable it in a separate
reviewed plan.
Cloudflare DNS mutations resolve durable zone and record identities before
writing. Ambiguous same-name zones or same-name/type records block instead of
selecting the first result. Record deletion treats already-absent as success but
must verify terminal absence before reporting success. Multi-value record sets,
including Cloud Run A/AAAA answers, are reconciled as a set and persist every
exact record id without pruning unrelated values Hypervibe did not create.
When that binding confirms the desired traffic record is proxied, provider-side
CNAME comparison is intentionally opaque: a verified domain with a ready
provider certificate may converge even if the origin reports its DNS comparison
as false. Missing bindings, unproxied intent, unverified ownership, and pending
or failed certificates must still plan repair.

Provider-managed edge load balancers use a separate generic
`platformBindings.loadBalancer` topology. The public hostname, provider scope,
and each monitor/pool/load-balancer provider id are durable identities. The
monitor, pool, and public hostname are distinct plan actions with explicit
dependencies; apply must never create all three from a single convenience
handler. A load-balancer hostname owns routing for `environment.domain`, so the
ordinary single-service domain/DNS action is mutually exclusive while the
load-balancer spec is present. Teardown reverses the dependency order and must
confirm terminal absence before clearing each binding.
Provider-internal ingress created as part of a hosting lifecycle, such as the
ECS Express ALB, remains owned by that hosting action and is not advertised as
a generic edge load-balancer provider. The generic contract is for redundant
public origins and requires the explicit monitor/pool/hostname lifecycle above.

Opt-in live load-balancer conformance exercises that same desired-state path
against disposable provider resources. Test cleanup removes the public
hostname, then pool, then monitor before deleting origins. A failed cleanup
preserves Hypervibe state and reports only non-secret durable identities; it
must not fall back to direct provider deletion.

## Plan Honesty

Plan honesty beats optimistic UX. `hv_apply`, `hv_deploy`, CI helpers, and provider task runners must not report success unless provider receipts, health checks, logs, or a follow-up observe prove the intended state.

Partial progress should be returned as explicit `succeeded`, `failed`, `skipped`, `pending`, or `blocked` receipts with the actionable next step. Do not hide provider errors behind generic "bootstrap failed" or "problem processing request" messages when logs, trace ids, or step details are available.

Hypervibe should be stage-gated by default. A failed, blocked, pending, or confirmation-required stage is a stop point for autonomous agents: report which stages worked, which stage stopped progress, and what user decision or credential is needed next. Do not encourage agents to keep trying alternate tools, direct provider calls, or one-off workaround paths unless the user explicitly asks for broad investigation or repeated retries.

The shared tool response envelope supports this with `agentInstruction`. Use it to tell agents when to `stop_and_report` or `ask_user`, especially for missing connections, failed receipts, provider errors, pending seed/deploy steps, and confirm-gated actions.

## Reconciliation Safety Invariants

A persisted plan is an authorization boundary, not just a progress preview.
Every provider mutation during `hv_apply` must be attributable to one reviewed,
non-noop action:

- An action handler may mutate only the resource and operation named by that
  action. Shared helpers must not create, repair, attach, deploy, or destroy
  unrelated resources from the wider spec.
- A noop action must cause zero provider mutations. If live state exists but
  Hypervibe lacks its local identity binding, plan an explicit adoption or
  binding-reconciliation action; do not call it noop and do not create a
  replacement during another action.
- Dependencies must be explicit plan edges. If service configuration requires a
  database, queue, storage bucket, domain, or secret first, plan that action and
  make the service action depend on it instead of ensuring the prerequisite
  imperatively.
- Receipts are action-scoped evidence. Do not reuse a whole-environment
  bootstrap result as proof that several distinct actions succeeded.

Observation is tri-state: present, absent, or unknown. Only provider-confirmed
absence may authorize a create based on observed state:

- Permission errors, timeouts, rate limits, server failures, unsupported reads,
  and partial observation are unknown, not absent.
- Never swallow a non-not-found provider error and return `null`, an empty list,
  or `false` that the diff engine will interpret as absence.
- Track observation completeness per capability. Successful hosting observation
  does not prove database, storage, queue, App Store, DNS, or repository-setting
  observation succeeded.
- Match existing resources by durable provider id first. Name matching may
  produce adoption candidates, but multiple matches are ambiguity that must be
  reported and blocked.

Creates, updates, and destroys must be retry-safe:

- Billable and data-bearing actions require exact action-id confirmation.
- Provider deletes must treat already-absent resources as converged, wait for
  realistic asynchronous deletion, and verify terminal absence before removing
  local bindings.
- Provider writes followed by a read must tolerate bounded eventual consistency
  and verify the exact expected identity or revision; exhausting the observation
  window remains a blocked or failed action, never inferred success.
- Multi-resource destruction follows dependency order and stops on failed or
  unknown deletion. Do not delete dependent data, storage, networking, or
  credentials until the owning resource is confirmed absent.
- A failed prerequisite is a stop point inside an orchestration stage. Do not
  keep issuing dependent provider mutations and hope rollback will reconstruct
  the prior state.

Lifecycle changes require contract tests for noop mutation freedom,
action-scoped mutation authority, observation-error preservation, duplicate
identity handling, import round trips, confirmation gating, and idempotent
delete retry. The current audit and repair queue is tracked in
[`docs/reconciliation-safety-backlog.md`](docs/reconciliation-safety-backlog.md).

## Connections And Secrets

Provider credentials and required external connections should be discovered as early as possible from the spec and reported before apply. Prefer `credentialsRef` with exported environment variables, `dotenv:` references, local JSON files, or secret-manager refs; raw credentials in chat are still accepted when the user intentionally chooses that path.

`project` on `hv_connections` and `hv_secrets` selects and validates command context; it does not redefine provider credential scope or make locally stored credentials project-owned. Provider `scope` remains the durable resource boundary. A project-only `hv_connections` call lists connections in that explicit context, and an unknown explicit project must fail instead of being silently ignored.

Umbrella command modes must stay unambiguous in the registry description,
field schemas, validation hints, generated CLI help, and MCP instructions. A
project-only `hv_secrets` call lists sources just like `hv_connections`; masked
hosting-variable reads require an explicit `env`. Only parameterless
`hv_inspect({})` performs provider discovery. Every bounded inspection requires
`provider`, and full environment observation additionally requires `project`
and `env`. Discovery returns every inspection mode's required, optional,
one-of, and mutually-exclusive selectors plus whether that mode accepts the
bounded `limit` selector. Provider-owned resource inspectors declare this
contract beside their driver. A recoverable selector mismatch returns one safe
machine-readable corrected call and permits exactly that retry; it does not
instruct an agent to stop merely for removing a field the selected mode cannot
consume.

Secrets never cross output boundaries. Secret values may be accepted through `credentialsRef`, encrypted into plans, or stored as verified connections, but they must not be printed in tool output, committed specs, warnings, logs, receipts, or test snapshots.

Stripe Projects is supported only as a narrow local credential source. A
`stripe-projects://<environment>/<provider>/<service>` reference must match the
currently active environment. Hypervibe may invoke only the read-only,
redacted `stripe projects env show --json` and
`stripe projects env --service <provider>/<service> --json` metadata paths,
then select those declared keys from the already-existing Stripe-managed output
file. That file must resolve inside the linked repository, must be a regular
non-symlink file, and must be owner-only on POSIX systems. Duplicate matching
service configurations, absent keys, a different active environment, missing
output, or unknown CLI output all block without returning a value.

This credential source does not transfer infrastructure or rotation ownership
to Hypervibe. Resolution must never call Stripe Projects pull, refresh,
environment use/create/update/delete, provider link, service add/remove, or
credential rotation paths: pull may rotate expiring provider access behind the
command. The operator selects and pulls an environment explicitly, then calls
`hv_connections` with `credentialsMap`; Hypervibe snapshots the mapped provider
credentials into its encrypted verified connection. After an intentional pull
or rotation, the operator reruns that destination `hv_connections` call. This
read-only local credential-source exception does not weaken the provider-CLI
prohibition for infrastructure operations.

Provider-declared environment-variable aliases may simplify local credential
references without duplicating secret values. Exact requested names win. When
an exact name is absent, all populated aliases must contain one distinct value
or resolution blocks without returning any value. GitHub declares
`NODE_AUTH_TOKEN`, `HYPERVIBE_GITHUB_TOKEN`, and
`HYPERVIBE_GITHUB_PACKAGES_TOKEN` as one alias group; `NODE_AUTH_TOKEN` is the
recommended combined-token name because npm must resolve it before Hypervibe
starts.

Connection guidance is part of the product contract, not incidental copy. Every provider or secret-manager connection should have a `ConnectionGuidance` entry in `src/domain/services/connection-guidance.ts`, and token/permission errors should route through `formatConnectionGuidance(...)` whenever possible.

Missing-connection results must be directly actionable in both MCP and CLI.
Return the exact prefilled setup links, identify one `recommendedSetupUrl`, and
include a project/scoped `credentialExample` using a safe local reference. The
human renderer keeps clickable links and that command ahead of long permission
details. Agents reproduce the links, offer to open the recommended page, tell
the user exactly where to save the credential, and then call `hv_connections`
themselves. Never hide those steps behind the phrase "credential flow."

GCP cloud preparation uses a credential-free preview followed by explicit
confirmation. It accepts `adminAuth: "default"` so an operator's existing
Google Application Default Credentials can perform the one-time API/IAM work
without manufacturing or exporting another credential. Explicit access-token
and service-account references remain supported when a distinct automation
identity is intentional; none of these admin credentials are stored. Connection
creation audit events retain only the non-secret credential source kind, and
cloud preparation audit events retain only the authentication source kind,
target project/service account, requested capability, and safe outcome
category. When local ADC is absent, the result must distinguish it from the
stored deploy service-account credential and return Google's official ADC URL,
the exact `gcloud auth application-default` commands, project-scoped roles and
permissions, the official Cloud CLI installation path when `gcloud` is absent,
caveats, and the complete safe retry call. Do not recommend a third-party
package-manager wrapper when Google provides a first-party installer or archive;
package-manager runtime coupling can fail independently of Google credentials.
Cloud Run authentication is compatible with GCS and Memorystore and is reused
through provider registry metadata; operators must not create redundant Google
service-account keys for those capabilities. GCS, Memorystore, and Pub/Sub
preparation are explicit independent capabilities. A capability preparation
must reconcile only its selected APIs and roles; it must not repair base Cloud
Run permissions or grant another capability's role. Base Cloud Run preparation
remains a separate provider-only prepare call. Successive preparations preserve
other previously reviewed capability evidence. Explicit queue-role removal is a standalone,
removal-only operation; it affects only the connected deploy service-account
member, including that member's conditional bindings, and never disables the
Pub/Sub API, grants other access, or edits another principal.

When adding or changing token guidance, include all of these details:

- The exact credential kind, including distinctions that matter operationally, such as user token vs account token, classic PAT vs fine-grained PAT, service account JSON vs access token, or read token vs API-management token.
- The official URL where the user creates or reviews that credential. If there are multiple valid token types, include the URL for each and say which use case needs which token.
- GitHub PAT creation URLs must be role-specific and pre-filled with the token name/description plus the required classic scopes or fine-grained permissions. A generic GitHub token settings URL is not actionable connection guidance.
- When a provider officially supports credential-template URLs, guidance must use them with the known required name and least-privilege permissions pre-filled. Do not depend on undocumented dashboard parameters; identify optional permissions that the supported template cannot represent.
- The exact scopes, roles, IAM permissions, or product permission toggles required, including resource scoping such as repo, zone, project, account, team, or organization.
- The expected shape, prefix, or caveats when helpful, such as token prefixes, one-time-download keys, required companion ids like `accountId`, package-read tokens, or credentials that cannot support a feature.
- A safe `hv_connections` example using `credentialsRef` (`env:...`, `dotenv:/absolute/path/.env#KEY`, `file:/absolute/path`, a secret-manager ref, or the constrained Stripe Projects credential source above). Use `credentialsMap` when a provider needs multiple fields.

Tests should fail if new provider guidance omits these basics. Update `src/domain/services/__tests__/connection-guidance.test.ts` and add provider-specific verification-error assertions for ambiguous or commonly miscreated tokens.

## Delegated Secrets

Delegated secrets are lifecycle-managed slots, not ordinary environment variables and not provider connections:

- `ProjectSpec.secrets` declares the name, responsible principal, runtime environments and/or GitHub Actions destinations, required/optional behavior, and preserve-only drift policy. It never contains a value.
- `hv_plan secretRefs={...}` is the only write input. References are resolved locally, values are encrypted into that specific plan, and the plan action/preview contains only key names and non-secret metadata.
- Declared keys are excluded from deploy env files and rejected from ordinary `envVars` overrides. An owner's local `.env` must never silently become the desired value for a delegated slot.
- Missing, unaccepted, drifted, or newly reassigned required slots produce `inputRequired`. The plan remains inspectable but `hv_apply` must reject it before connection checks or provider mutations.
- A successful provider receipt records value-free binding metadata (`delegatedEnvBindings` for hosting and `delegatedActionsBindings` for GitHub): key name, destination, principal, SHA-256 value hash, timestamp, and action id. The value itself is never stored in repo bindings or receipts.
- Live observation compares provider hashes against the accepted hash. Matching values are preserved without needing the secret locally. Drift is reported and preserved until a new explicit plan input is supplied.

`.hypervibe/spec.json` and the sanitized `.hypervibe/bindings.json` make this state reconstructible after a local database or checkout is lost. Provider connections and encrypted in-flight plans remain local and must be recreated.

In the no-service model, `principal` is declarative attribution, not authenticated authorization. Git review/branch protection and provider-scoped membership enforce who may change the spec and mutate infrastructure. A local principal or collaborator edit cannot grant a hosting, cloud, or code-host role, but a caller who already holds provider mutation credentials can still change provider state. Do not treat delegated metadata as a centralized ACL or automatically apply unreviewed changes with privileged credentials; authenticated principal enforcement would require a trusted service or signed attestation.

## Deploy Env Files

Local `.env` files are deploy input candidates, not a raw publish list. Prefer `.env.<environment>` over `.env` when present. When an environment deploy/plan uses the default repo convention and `.env` exists but `.env.<environment>` does not, Hypervibe creates `.env.<environment>` from `.env` before loading deploy vars. When both files exist, Hypervibe may copy newly added base `.env` keys into `.env.<environment>`, but it must preserve environment-specific values instead of overwriting them.

Repo-backed spec writes create or non-destructively extend `.env.example` with
the value-free product convention `RECAPTCHA_SITE_KEY=` and
`RECAPTCHA_SECRET_KEY=`. The template is never a deploy input. Hypervibe does
not own a reCAPTCHA provider connection; actual per-environment values remain
ordinary `.env.<environment>` inputs and reach hosting only through a persisted
plan and apply.

Keep env-file handling policy-driven through the environment spec (`envFile.mode`, `include`, `exclude`):

- default to high-confidence runtime keys,
- skip provider/control-plane credentials,
- skip local-looking values such as `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, `.local`, and `.internal`,
- warn with key names for ignored, excluded, or skipped keys,
- surface the env file path in plan previews,
- never let stale local values override Hypervibe-managed infrastructure env vars such as database or queue URLs.

## Runtime Environment Rollouts

Environment-variable desired state is additive/preserve-only by default.
Omission never means deletion because provider observation may be partial and
live variables may be intentionally managed outside ordinary `envVars`.

Managed database compatibility aliases are per-service desired state through
`services.<name>.databaseEnvAliases`. The spec stores only an alias name and
canonical source (`DATABASE_URL` or `DIRECT_URL`); the resolved
value is derived from the managed component inside plan/apply and never written
to the spec, plan preview, status, receipt, or bindings. Alias keys cannot
collide with ordinary env vars, env-file includes, removal tombstones,
delegated secrets, Stripe-managed keys, or canonical database variables.
Planning and status must diff each alias only on its target service, and
provider reference values may use presence-only comparison where the provider
returns a resolved value instead of the reference expression.

Deletion uses `EnvironmentSpec.removeEnvVars` as an explicit durable tombstone:

- validate names and reject collisions with `envVars`, env-file includes,
  delegated secret slots, overrides, and Hypervibe-managed database, queue,
  storage, or source-integration keys;
- plan only keys observed live (or locally bound keys when observation is
  unavailable);
- emit key names and presence/absence only, never values;
- require per-action confirmation;
- route apply through the provider adapter's `deleteEnvVars` capability;
- keep the applied-spec hash dependent on successful removal.

Renames are two-release operations. First add the replacement and deploy
compatible code while preserving the old key. Only a later spec may tombstone
the old key. Planning must reject removals while ordinary service
configuration is not converged; provider-side variable deletion can create a
revision or redeploy the current image even when exact-SHA CI owns the next
code release.

For `deploy.strategy: "branch"` with `trigger: "ci"`, generic orchestration
passes a deployment-deferral option only to adapters that declare the
capability. It means provider configuration may converge, but the adapter must
not independently source or build new application code for an already-bound
service:

- Railway stages variable writes with deploys skipped and suppresses its
  explicit service redeploy.
- Cloud Run uses the existing service/job image while reconciling its
  revision-scoped configuration. The exact-SHA workflow remains the next code
  release boundary.

Do not run deploy-status or HTTP health checks against the configuration pass;
the later CI run and `hv_health` own that verification. New resources with no
existing image may still require provider bootstrap before CI can target them,
and receipts must report that honestly.

`deploymentDeferred` means only that Hypervibe did not release new application
code. It must not imply stale runtime configuration: Cloud Run, Fly.io, ECS
Express, Azure Container Apps, and DigitalOcean can activate configuration with
the current image, while providers such as Railway and Vercel can leave the
currently selected deployment unchanged. An adapter sets
`runtimeRolloutRequired` only when its successful mutation has left runtime
configuration waiting for a later deployment. Generic orchestration must
preserve this provider-owned evidence and must never derive it from the provider
name or from `deploymentDeferred`.

When a provider confirms `runtimeRolloutRequired`, apply persists the affected
service and the exact deployment identity observed immediately after the
configuration write as non-secret rollout evidence.
`hv_status` must report `restart_required` and must not report the environment
in sync while that same deployment is still active. A later provider-observed
successful deployment with a different exact
identity satisfies the rollout; an absent, failed, or unobservable deployment
does not. For CI-triggered environments, the status guidance points back to the
managed CI trigger/status path instead of bypassing that release authority with
a provider redeploy.

### Environment Variable Coverage

Desired state prevents new cross-environment configuration gaps before they
reach providers. A runtime key introduced through ordinary `envVars`, an
`envFile.include` slot, or a delegated secret must be represented in every
non-local environment that shares a desired service with a declaring
environment. Each environment supplies its own value or secret reference;
Hypervibe never copies values between environments.

An environment may list a key in `envVarExceptions` only to document that the
shared key intentionally does not apply there. Retirement tombstones also make
absence explicit. Mixed ordinary/delegated handling for the same key is
invalid. `hv_spec` blocks newly introduced gaps and gaps created by adding
a matching environment or service. Pre-existing gaps remain readable and do
not block unrelated spec changes, but are reported until repaired or explicitly
excepted. Provider observation and AI are not required for this guardrail;
`hv_plan` and `hv_apply` continue to own convergence of the accepted spec.

## Stripe Desired State

Stripe sandboxes are isolated environments with their own API keys and object
ids. Model the relationship explicitly through
`environments.<name>.payments.stripe`:

- `payments.stripe.environment` selects a Stripe connection scope and defaults
  to the Hypervibe environment name, so development, staging, and production
  can use distinct Stripe sandboxes/live mode.
- Scoped Stripe connections use `secretKey` plus optional `publishableKey`.
  The server-side field accepts a least-privilege restricted `rk_` key or an
  unrestricted `sk_` key and derives sandbox/live mode from its prefix. Legacy
  global sandbox/live credentials remain a compatibility fallback, but cannot
  represent distinct development and staging sandboxes.
- Creating and deleting the named Stripe sandbox and issuing its keys remain
  Stripe Dashboard operations. Replacing the verified connection at the same
  Hypervibe scope intentionally retargets that environment; the next plan must
  observe the empty/new target and review explicit catalog and webhook
  recreation. It never mutates the old sandbox through the new connection.
- Runtime credential projection is explicit through
  `payments.stripe.credentials`. Hypervibe-owned products and recurring prices
  are declared under `payments.stripe.catalog.products`; each price declares
  the hosting env key that receives its provider id.
- Named webhook endpoints are declared through `payments.stripe.webhooks`.
  Each webhook owns one HTTPS URL, event set, target service, and hosting env
  key. The Stripe endpoint and its creation-only signing value projection are
  one plan/apply lifecycle action; there is no imperative webhook setup tool.
- Catalog identity resolves by durable provider id first. An unbound exact
  metadata/name/config match is an explicit confirm-gated adoption candidate;
  multiple candidates block instead of choosing one. Unmanaged products and
  prices are untouched.
- Product display fields and an explicitly declared Stripe tax code are mutable. Recurring price amount, currency, and
  interval are immutable: changing them plans a replacement, makes hosting
  consume the replacement, and only then permits confirm-gated archival of the
  previous price. Removal follows the same hosting-before-archive order.
- `hv_plan` observes Stripe catalog values and webhook endpoints internally and
  compares only hashes against hosting observation. Webhook identity resolves
  by a durable bound endpoint id first. URL matches are adoption candidates;
  zero, one, and multiple matches remain distinct plan outcomes.
- Plans, warnings, bindings, receipts, and tool output contain managed key
  names, provider ids, catalog diagnostics, and one-way hashes, never Stripe
  keys, webhook signing values, or resolved runtime values.
- `hv_apply` resolves the Stripe connection again and routes runtime changes
  through the hosting adapter. Webhook creation syncs the returned signing
  value before recording the binding. A failed hosting sync deletes and
  verifies the new endpoint; if rollback cannot be verified, the provider id
  is recorded so the next plan cannot orphan or duplicate it.
- Webhook adoption, replacement/rotation, and deletion require exact action-id
  confirmation. Deletion verifies provider absence before removing the hosting
  variable and local binding. Noop actions make no Stripe or hosting calls.
- For CI-triggered branch deploys, supported adapters defer code deployment so
  the exact-SHA workflow remains the release boundary.
- Stripe customers, subscriptions, subscription items, personas, entitlements,
  and test-clock scenarios are application fixture/data state, not Hypervibe
  infrastructure resources. A versioned `database.seedCommand` may reconcile
  both sides after catalog, credential, webhook, and deployment prerequisites
  converge. Stored provider ids and metadata are durable identity; Stripe
  idempotency keys provide retry safety only.
- A non-noop database seed in a managed-CI environment depends on the reviewed
  integration actions and applied-spec marker, then on one explicit exact-SHA
  release action. Apply dispatches and verifies that release before starting
  the provider-neutral seed task, so a seed command introduced by the desired
  commit cannot run in the previously deployed image.

Stripe-managed runtime keys cannot also come from ordinary `envVars`, env-file
includes, delegated secret slots, overrides, or removal tombstones. Removing
or renaming a catalog key is part of its reviewed catalog lifecycle; ordinary
unrelated runtime variables continue to use the two-release retirement process.

## Email Desired State

SendGrid email configuration lives under each environment's `email` desired
state. It owns one optional sender identity and one optional Inbound Parse route
per environment. The inbound route names a public web service and relative path;
its provider URL is derived from that service's durable hosting binding. Alias
local parts are application routing intent because SendGrid delivers all mail
for one parse hostname to one endpoint.

Email reconciliation uses separate action authorities for hosting runtime
variables, SendGrid sender/domain authorization, Cloudflare DNS records,
SendGrid inbound parsing and delivery events, Cloudflare mailbox forwarding,
and final domain validation. A service or deploy
bootstrap must never configure email as a side effect. Inbound route replacement
is confirmation-gated because SendGrid replaces it through delete/create.
Matching unmanaged provider identities are explicit adoption actions;
duplicates and observation failures block instead of selecting or creating.

Domain authentication is preferred when `environment.domain` exists. A sender
declared without a domain uses single-sender verification and returns a pending
receipt until the external verification email is accepted. Inbound parsing owns
the `mx.sendgrid.net` MX record for its declared subdomain. The account-level
SendGrid delivery-event webhook can be declared by only one environment.
Cloudflare forwarding destinations, routing DNS, aliases, and the catch-all are
explicit actions with destination-verification dependencies; provider-global
destination addresses are never deleted implicitly.

A SendGrid-backed CI email journey reuses this lifecycle rather than adding a
Hypervibe-hosted inbox. The desired state declares a dedicated staging Inbound
Parse hostname and may intentionally use `aliases: []`; dynamic local parts for
individual test runs are application data and must not become desired-state
aliases. Hypervibe owns SendGrid authorization and route reconciliation,
Cloudflare MX records, and the existing runtime-variable projection. The
application owns issuing and expiring recipient capabilities, validating and
storing inbound messages, and exposing a protected polling API. It may issue a
recipient through an API or let CI derive one from an application canary secret;
CI never receives provider credentials.

Inbound Parse delivery semantics are part of the application boundary. A
permanently invalid or over-limit message is acknowledged with `2xx` and
dropped, while retryable storage failures may return `5xx`. Rate limits should
key valid recipient capabilities independently so unrelated SendGrid delivery
traffic cannot exhaust one shared provider-IP bucket.

A recipient capability is application-level staging hardening, not provider
origin authentication. SendGrid signature verification requires preserving the
exact raw multipart request for verification before parsing, while OAuth adds an
application token endpoint and token lifecycle. Both policies remain explicit
application concerns until Hypervibe can model their credentials, provider
configuration, runtime projection, observation, and rotation through the full
spec -> plan -> apply lifecycle. Hypervibe does not store CI messages,
verification links, or receipt state.

## Messaging Desired State

Twilio messaging configuration lives under each environment's `messaging`
desired state. It owns one Messaging Service, optional inbound-message and
delivery-status callbacks, an explicit list of application services receiving
the runtime contract, and optionally one existing Twilio phone-number SID.
Callback URLs are derived from durable public hosting bindings; webhook targets
must also receive the runtime contract so they can validate Twilio signatures.

Messaging reconciliation separates Messaging Service configuration, sender-pool
attachment, and hosting runtime variables into distinct reviewed actions. It
resolves the persisted Messaging Service SID before considering exact-name
adoption, blocks duplicate names and unknown observations, and verifies provider
read-back before recording a binding. Moving an existing phone number between
sender pools is confirmation-gated. A noop action performs no Twilio or hosting
mutation.

Hypervibe does not purchase or release phone numbers, synthesize webhook
handlers, or manage Voice, Verify, WhatsApp, A2P registration, campaigns, or
message sending. Those concerns remain application/account setup until their
lifecycle can be modeled without weakening the plan authorization boundary.
Twilio credentials are accepted only through the connection boundary and are
projected solely to services named by `messaging.services`; secrets and runtime
values never enter specs, plans, bindings, receipts, or tool output.

## iOS Release Desired State

Bundle IDs, capabilities, TestFlight groups/testers, and release workflows live
under each environment's `ios` desired state. There are no imperative bundle-ID,
TestFlight upload, or TestFlight distribution commands.

- `ios.release` requires a CI-triggered branch deploy. It names the server
  services that gate the mobile release, the repository-relative build command
  and IPA path, build-only GitHub environment secret names, signing provider,
  TestFlight groups, export-compliance answer, and optional beta-review
  submission.
- Hypervibe manages the server deploy workflow, iOS release workflow, and App
  Store Connect credentials through plan/apply. TestFlight upload, processing,
  compliance, declared-group distribution, optional beta review, and release
  evidence use a Hypervibe-owned runtime embedded into the managed workflow;
  the app does not supply submission code. The legacy default `scriptPath` is
  accepted only while existing specs migrate and custom values are rejected.
- Signing is an explicit provider contract. `provider: "project"` preserves the
  compatibility path where the app build owns signing. `provider: "match"`
  makes Hypervibe install existing Match assets read-only into an ephemeral
  keychain before invoking the app-defined build command. Match credentials are
  scoped to that preparation step and cannot also be declared as build-command
  secrets. Certificate/profile creation, rotation, and revocation never happen
  during deploys; they require a separate explicit lifecycle design.
- A successful server deploy writes an artifact whose name and JSON body carry
  the environment, repository, exact full Git SHA, and deployed service set.
  The artifact is emitted only after provider deployment steps succeed.
- The macOS iOS workflow shares the server deploy concurrency key and uses two
  isolated jobs. The build job consumes a specific successful server run,
  validates its evidence, checks out that exact SHA, prepares signing, invokes
  the app-defined build command, validates the IPA identity, and uploads a
  short-lived artifact. A fresh release job receives App Store credentials,
  downloads and revalidates the IPA and server evidence, then runs the managed
  release runtime. It never checks out or executes project code. This job
  boundary prevents an arbitrary build command from modifying the submission
  runtime or inheriting App Store Connect credentials.
- The iOS artifact records separate `mobile.repository`/`mobile.sha` and
  `server.repository`/`server.sha` fields. V1 is monorepo-first and therefore
  requires those repositories and SHAs to match at the workflow gate, while the
  evidence shape leaves a future explicit multi-repo policy possible.
- `hv_ci_status` is the read-only path for workflows, runs, logs, and release
  artifact provenance. `hv_appstore_submit` requires successful managed server
  and iOS evidence artifacts for the same SHA before final review submission.
- Xcode projects, schemes, entitlements, build/test commands, artifact paths,
  App Store metadata/screenshots, and local device operations remain
  project-owned. Hypervibe owns the release envelope around the resulting IPA.

## CI And Push Deploys

For push deploys, `deploy.trigger: "ci"` is the portable default. The canonical
`devops.code` and optional `devops.ci` blocks select independently registered
code-host and CI providers. Legacy top-level `github` desired state remains
readable through one lossless compatibility normalization to `github` plus
`github-actions`; new providers must not add parallel top-level blocks.

Code-host and CI provider ids are open registry values. Generic plan/apply,
hosting, tool, CLI, and MCP code routes through provider capabilities and does
not branch on GitHub, GitLab, or provider-native API fields. Code identity and
CI execution identity are separate durable bindings even when one vendor
supplies both. A CI provider must prove compatibility with the exact bound code
repository before any configuration, variable, dispatch, or evidence action.

`devops.ci` names one primary application release authority. Project features
such as GitHub Pages may use a separate feature-scoped executor, but that
executor has disjoint files and secrets and cannot own application deploy
variables, release evidence, promotion, or rollback. Pages retains separate
content-source, static-hosting-target, and optional publication-executor
bindings; its target need not be the application repository.

Hosting providers emit provider-neutral, versioned deploy recipes. CI adapters
render those recipes and operate definitions/runs; hosting code never emits
GitHub Actions or GitLab CI syntax. The neutral program has typed triggers,
runner requirements, logical variables/secrets, semantic steps, concurrency,
and release evidence. It has no raw provider-YAML or privileged free-form-shell
escape hatch. An unknown program/step version or unsupported semantic returns
`UNSUPPORTED` before mutation.

CI configuration is an observed authority graph, not just a file hash. The CI
adapter owns whole-root, provider-proven composable-include, or provider-managed
configuration semantics and must observe all import and transformation layers
that can alter privileged jobs. Unknown effective configuration blocks secret
sync, dispatch, and release evidence. The initial GitLab MVP supports only a
Hypervibe-owned root `.gitlab-ci.yml`; a pre-existing unmanaged root is
preserved and blocks with review guidance.

CI variables are observed with provider-native scope, precedence, protection,
and value visibility (`plaintext`, `redacted`, `omitted`, or `unknown`). Raw
values are fingerprinted, if available, and erased inside the adapter response
boundary. Every higher-precedence value or dispatch input that can shadow a
commit, applied-spec, promotion, or renderer control value must be proven safe;
unknown or overrideable gates block privileged work. Dispatch may reference
only the bound reviewed definition and exact provider-observed revision. APIs
that accept replacement configuration at dispatch time are never used.

Run, job, pipeline, artifact, and attempt ids are bounded opaque strings scoped
by provider instance and execution identity. Native queue/pause/cancel behavior
is normalized but never trusted as the only concurrency gate: every privileged
job rejects a stale/superseded run immediately before provider mutation. The
GitLab renderer does this with the short-lived job token and the environment's
provider deployment history, proving the exact current job/pipeline/SHA and
that no newer deployment exists before exposing provider credentials to its
runtime.
Artifact size and retention are observed capabilities, and release evidence
includes the exact run, job, attempt, SHA, program fingerprint, and provider
revision.

GitLab Cloud/self-managed code hosting and GitLab CI are separate registered
capability sets that may share one verified connection. Self-managed instances
require an explicit non-secret instance URL and tested version/capability
range. GitLab projects bind by durable numeric project id first; project path
and clone URLs are current display/location data. Repository lifecycle is
explicit under `devops.code.repository`: external is the compatibility default,
while managed create/delete uses isolated confirmation-gated actions, verifies
the exact parent namespace or project authority, never adopts a name match, and
retains the durable binding until exact provider absence is proven. GitLab.com
scheduled deletion retains that binding through the provider's 30-day
retention window; self-managed permanent deletion is re-observed before local
state is removed. Deletion intent is persisted before the first provider call;
if self-managed GitLab schedules deletion but permanent removal fails, the
binding is retained and the next separately confirmed destroy retries the exact
numeric id and full path. Managed creation initializes the declared default branch;
the resulting default branch and visibility are observed and must converge. If
GitLab acknowledges the exact project but those settings or clone identities do
not converge, Hypervibe retains the durable id for recovery and blocks instead
of retrying creation. In-place repository-setting updates are not part of this
slice, so later drift blocks explicitly rather than being reported as a noop.
moving existing local history into that new remote remains separate source
coordination, not an implicit infrastructure side effect.

GitLab CI renders the registered provider-neutral recipes for Azure Container
Apps, Cloud Run, DigitalOcean App Platform, ECS Express, Railway, and Vercel.
CI may build and copy an exact-SHA image, but it mutates only pre-existing bound
hosting resources and registries; it never bootstraps hosting infrastructure.
Cloud Run, Azure Container Apps, and ECS Express deploy the registry-returned
image digest, while provider APIs that accept a tag are pinned to the full Git
SHA and re-observed with release markers.
GitLab-hosted runners are accepted only on GitLab.com under the dedicated
hosted tag, and a project/group runner that can claim that tag blocks secret
sync. Self-managed execution requires one exact locked project runner id, one
exact online linux/amd64 manager system id, a dedicated uncontested tag,
protected-ref-only jobs, and a provider-observed maintenance-note capability
attestation. GitLab does not expose executor type or privileged-Docker mode in
these project APIs, so `docker-privileged` remains an explicit operator
attestation and must not be described as provider-proven.

GitLab rollback selects only an unexpired successful managed release artifact,
creates a deterministic exact-SHA protected tag, and dispatches a new typed-
input pipeline. The tag wildcard must allow only the exact authenticated GitLab
user—not the Maintainer role generally—so another Maintainer cannot manufacture
a privileged rollback ref. Per-environment `resource_group` serialization,
forward-deployment protection, disabled rollback retries, and fresh evidence
observation close deploy races. Teardown first removes managed jobs through one
reviewed merge request, proves them absent and no relevant job active, deletes
one exact owned variable per confirmation-gated action, and only then removes
the local CI binding. These paths remain `ready-for-live`, not `supported`,
until recent live lifecycle evidence exists for the exact GitLab offering,
version, runner mode, and hosting recipe. Collaboration, Pages, and advanced
GitLab features remain separate capabilities.

Deployment ownership is exclusive. Only an explicit `deploy.strategy: "branch"`
with `deploy.trigger: "native"` may retain a provider-native repository source.
Manual promotion and Hypervibe-managed CI both require every service source to
be provider-confirmed disconnected. A confirmed native source is explicit
drift: providers that expose a safe disconnect capability plan a
provider-source disconnect action, while providers without one block with
manual guidance. Unknown source observation also blocks; it must never be
interpreted as disconnected. Source reconciliation is an isolated plan stage:
no billable resource, environment-variable, workflow, release, or unrelated
mutation is included until a later plan confirms that every source is
disconnected. A noop action performs no provider mutation.

Post-deploy endpoint success does not hide failures elsewhere in the project.
When provider connections are available, `hv_health` also observes the latest
bound deployment for every declared environment and service through the hosting
adapter. Failed deployments are surfaced with their environment, provider,
service, and status; permission failures, unsupported reads, missing bindings,
and pending states remain `unknown`, never healthy. The requested endpoint and
target environment retain their own result, so an unrelated production failure
is reported without falsifying a successful staging HTTP check.

The standard team workflow is:

1. short-lived feature branches,
2. pull request into `main`,
3. checks on the pull request,
4. merge to `main` auto-deploys staging,
5. production is manually promoted from `main`, ideally by passing the exact commit SHA that already passed staging.

Do not default to a long-lived `staging` branch. `main` is the accepted-code branch, staging is the deployed preview of `main`, and production is a deliberate manual promotion. Generated production deploy workflows must not run from push events by default; they should use `workflow_dispatch` and support a `commit_sha` input.

Managed CI rollback is an explicit operational action over that same exact-SHA
release boundary. `hv_rollback` must select only unexpired server-release
evidence emitted by a successful run of the exact managed environment workflow.
When a provider exposes immutable image evidence (currently Railway), the
release record includes the exact registry digest; rollback downloads and
validates it, skips source checkout and image rebuilding, and deploys the
recorded immutable image URI.
After a failed promotion it restores the latest known-good release; after a
successful promotion it selects the previous distinct successful release unless
the caller names another previously verified full SHA. The repository, workflow,
ref, target SHA, source artifact id, source run id, and latest observed workflow
run id are frozen into a persisted rollback plan and re-observed immediately
before dispatch. Any workflow drift, unknown observation, ambiguous evidence,
newer run, or in-progress deployment blocks without mutation. Dispatch is a
pending receipt until `hv_ci_status` proves the workflow succeeded and
`hv_health` proves the endpoint. Rollback never reverses database migrations or
provider-side manual configuration; tool-mode migration steps are skipped during
rollback, while startup/release-command migrations must remain backward-compatible.

Direct-provider deploy runs do not currently persist a provider-neutral,
immutable release identity that can be restored and re-observed. Their service
receipts and historical spec revision are not proof of the deployed source or
image. `hv_rollback` therefore fails closed for direct-provider environments,
including when given a historical `toRunId`; it must never redeploy the current
spec or checkout and describe that mutation as restoration. Direct-provider
rollback may be added only through an adapter capability that persists the exact
immutable release identity, freezes it into action-scoped authority, and
re-verifies it immediately before and after mutation.

Do not switch a project to `deploy.trigger: "native"` just to avoid missing CI, package, or image credentials. That changes the desired infrastructure contract. Provider-native deploys are an explicit opt-in and may require provider-specific external app access such as the Railway GitHub App.

Generated provider CI workflow steps belong under provider-owned modules and are exposed through provider registry metadata. Generic GitHub orchestration should assemble workflows, sync files/secrets, inspect runs/logs, and diagnose failures without owning provider API scripts.

Generated workflows must gate image deployment on the environment-scoped
`HYPERVIBE_APPLIED_SPEC_HASH` GitHub Actions variable. The desired hash covers
only that environment plus its applicable delegated-secret declarations.
`hv_plan` models updating this marker after the infrastructure actions that
affect a release, and `hv_apply` updates it only after those actions complete.
A non-noop database seed is excluded from the marker's own dependencies to
avoid a cycle; in a managed-CI environment, an explicit exact-SHA release
depends on the marker and the seed depends on that verified release. This preserves
automatic code-only staging deploys while preventing a changed desired-state
contract from deploying before reconciliation. Missing, failed, pending, or
unconfirmed dependencies must leave the previous marker intact.

Generated deployment workflow files are repository infrastructure and must be
delivered through the deterministic `hypervibe/github-infrastructure` branch
and reviewable pull request. Applying file drift returns a pending receipt and
must defer workflow secrets, bindings, and the applied-spec marker until the
reviewed file is present on the default branch.

The deterministic branch must be reusable after merge commits, squash merges,
and rebase merges. A retained branch may be reset to the current default-branch
head only when GitHub proves its exact current SHA was the head of a merged
Hypervibe infrastructure pull request with the canonical title, body marker,
head ref, and base ref. Re-observe the branch immediately before resetting it
and verify the reset before writing files. Closed-unmerged pull requests,
post-merge commits, duplicate open pull requests, ambiguous provenance, and
observation failures must block without branch or file mutations.
New branch creation uses bounded read-after-write polling for the exact requested
SHA before any files are written. A successful create response alone is not
proof that the branch is ready, and an observation that never converges still
blocks the infrastructure action.

GitHub desired state uses capability-level opt-in with exclusive ownership.
Once a capability is enabled, Hypervibe owns and reconciles every generated
file and setting for that capability; individual managed files cannot be
delegated back to the repository. Requiring pull requests therefore owns the
canonical lowercase `.github/pull_request_template.md`. `externalWorkflows`
remains a read-only integration surface because it names workflows Hypervibe
observes but does not manage.

Managed checks default to `changeScope: "application"`. On pull requests they
must keep the workflow and required check alive, classify changed paths through
the read-only GitHub pull-request API, and skip checkout, runtime setup,
dependency installation, application commands, and failure upload only when
every changed path is narrow Hypervibe-owned infrastructure. Empty,
unrecognized, mixed, or renamed-from-application path sets run the full check.
Checks that validate repository infrastructure declare `changeScope: "all"`.
Do not implement this policy with workflow-level `paths-ignore` or commit skip
markers: skipped required workflows can remain pending and block merges, while
selectively skipped job steps preserve the required check result.

Broad code audits may declare two or more non-overlapping `shards`. Each shard
runs as an independent read-only agent job with the same reviewed rules and a
bounded scope. Hypervibe combines reports only after every expected artifact is
present and structurally valid. Missing or failed shards block aggregation;
partial reports preserve their findings but must keep the publishing job failed
so stale issues are never closed from incomplete evidence.

Every external workflow consumed by autofix declares a narrow evidence artifact
name/pattern separately from its required paths. The generated consumer filters
the source run by that pattern and treats absent or incomplete required evidence
as non-actionable: it must not invoke the repair agent or publish a patch. A
legacy spec without the artifact pattern remains parseable so it can be repaired,
but GitHub infrastructure reconciliation blocks and the compiled workflow uses a
non-matching sentinel. Unexpected artifact transport or authorization failures
remain errors. Repair summaries and patch files are written outside the checkout
so diagnostic output cannot be included in the proposed source patch.

When a canonical environment has both deployment-workflow drift and other
managed GitHub file drift, apply must combine all known repository files and
the manifest into the same infrastructure pull request. Dependent secrets,
bindings, repository settings, and the applied-spec marker remain deferred
until the reviewed commit is present on the default branch.

Static GitHub Pages publishing is project-level desired state under
`github.pages`; it is not a synthetic hosting environment. A GitHub-only
project uses the reserved canonical environment name `repository`. The Pages
Actions workflow is a managed repository file and must merge through the same
reviewable infrastructure pull request before any provider settings change.
After merge, planning emits separate GitHub Pages and Cloudflare DNS actions,
with explicit dependency order, provider snapshots, and confirmation for DNS
replacement or teardown. Apply may mutate only the reviewed provider action.
Certificate provisioning is asynchronous. Apply requests HTTPS enforcement
after the reviewed domain configuration is visible; a GitHub
certificate/HTTPS rejection returns pending, while every other provider error
fails. When GitHub reports the exact combination of valid unproxied DNS, a site
served by Pages, HTTPS eligibility, no certificate, and
`peer_failed_verification`, planning may authorize one same-domain detach and
reattach to restart GitHub's certificate job. Apply re-observes that signature,
verifies both transitions, leaves DNS untouched, and records a 24-hour attempt
cooldown in the GitHub environment binding. GitHub's DNS health observation is
asynchronous, so planning polls its documented `202` response and blocks rather
than silently falling back when health remains unknown. Valid apex address
records and the valid alternate `www` CNAME are both accepted as Pages routes.
A later apply verifies the enabled
setting. Disabling Pages removes the
reviewed workflow first, then confirm-gates
site deletion and removal of only the exact Pages address records Hypervibe
recognizes. Mail, verification, and unrelated DNS records are never part of
the Pages mutation boundary.

`hv_ci_trigger` is the only supported dispatch path and `hv_ci_status` is the
authoritative observation path for Hypervibe-managed CI deploys. A request to
deploy or promote an environment must use those tools for the reviewed
definition, followed by `hv_health` after a successful run. Agents must not
dispatch, monitor, or inspect managed runs with `gh`, code-host connectors/apps,
browser/UI inspection, or direct CI/provider APIs; a blocked `hv_ci_trigger` or
`hv_ci_status` result should surface its connection/error guidance and stop the
stage.

## Database Resilience

Provider-managed database resilience is optional desired state under
`database.resilience`. Omitting the block preserves backward compatibility and
means Hypervibe does not manage resilience settings. Within a declared block:

- `availability` owns the provider's zonal/regional HA mode;
- `backups` owns automated-backup count and PITR log retention; and
- `replicas` owns named provider read replicas; and
- `restoreDrill` owns a scheduled isolated point-in-time restore verification.
  Removing a named replica is an
  explicit, confirm-gated deletion. Removing the whole resilience block stops
  management and does not silently reduce protection or delete replicas.

Resilience planning is provider-neutral and capability-driven. Unsupported
providers and incomplete observations produce blocked actions, not fallback
provider branches or inferred absence. A regional-HA action depends on backup
and PITR enablement when those settings are not already live. Cost-increasing
HA, retention, and replica creates are billable actions; retention/HA
reductions and replica deletion require exact action-id confirmation.

Read replicas are provider resources, not backups. Their exact provider ids are
stored in encrypted component bindings with connection material, while the
sanitized environment topology stores only provider ids, regions, and tiers so
repo-backed recovery remains possible. Runtime wiring uses
`DATABASE_READ_URL_<NAME>` and, only when one replica exists,
`DATABASE_READ_URL`. Replica deletion must first remove those variables from
every bound service, then verify provider-terminal absence before pruning the
binding. A noop action performs no provider mutation, and immutable replica
region/tier drift blocks until an explicit replacement lifecycle is supported.

A restore drill is repository-managed operational infrastructure, not a restore
of the primary in place. V1 supports one drill on the GitHub canonical
environment. Hypervibe compiles a provider-owned scheduled workflow and runtime
through the existing review-gated GitHub infrastructure plan action. Initial or
changed drill workflow publication is billable and requires exact action-id
confirmation because each future run creates a temporary database instance.
The workflow is not proposed until the declared repository credential secret is
provider-observed by name; the credential value never enters specs, plans,
bindings, workflow files, receipts, or output.

Each run freezes the bound primary provider id in non-secret workflow config,
clones that exact primary to a unique `hv-drill-*` instance at the declared PITR
offset, applies source-specific ownership labels, changes only the clone's
temporary `postgres` password, and executes one declared query inside a
read-only transaction. Application services are never repointed. Successful
runs delete the labeled clone, wait for provider-confirmed terminal absence,
and publish evidence to the GitHub step summary. Failed labeled clones remain
inspectable for the declared short retention period; later runs garbage collect
only instances with the generated prefix and matching drill/source labels. A
failure before ownership labeling may delete only the exact unique target
created by that same run. Workflow runs are observed through `hv_ci_status`.

Opt-in live recovery conformance provisions backup policy and a read replica
through ordinary plan/apply, publishes the drill workflow through reviewed
GitHub infrastructure, dispatches it through Hypervibe, and requires explicit
non-secret evidence for generated-target creation and provider-terminal
deletion. If a run is non-terminal, a failed clone is retained, or terminal
cleanup evidence is missing, teardown stops before removing the workflow, replica, or
primary so the recorded lifecycle remains recoverable.

Cloud SQL is the first resilience adapter. It observes and verifies HA,
backup/PITR policy, and replica topology through the SQL Admin API. Its restore
drill uses `instances.clone` with an explicit point-in-time to create a new
instance, never a destructive restore onto the primary. Provider-to-provider
replica promotion/failover, replica replacement, and multi-environment
restore-drill scheduling are separate future lifecycle slices.

Environment data moves are explicit one-use desired state under the target
environment's `dataMigration`. V1 copies only whole PostgreSQL databases and
named object buckets from another declared environment. Plan isolates pending
copy actions from ordinary convergence, apply restores into fresh unreachable
targets, verifies non-secret manifests, and only then records active bindings.
The next plan performs service/CI cutover; a later fully converged plan may
offer separate confirm-gated deletion of retained rollback targets. Provider
adapters own provisioning and bounded/native data-plane access while generic
transfer engines own PostgreSQL snapshot and object streaming semantics. See
`docs/data-migration.md` for the operator contract.

Environment maintenance is a provider-neutral desired-state boundary under
`environments.<name>.maintenance.enabled`. Entry is ordered and verified:
Cloudflare publishes a bound static 503 Worker route, cron/worker/web workloads
are suspended in that order with exact restoration snapshots, PostgreSQL sets
`default_transaction_read_only` for the bound role and database, and a final
fresh observation records the active state. Exit reverses the database and
workload changes before removing the exact bound edge route. Every stage stores
only durable provider identity and non-secret restoration state, and a failed
or unknown observation blocks the next mutation. Migration copy actions carry
fresh source and target maintenance fingerprints and re-observe both immediately
before provisioning a candidate target.

The workload port is implemented by Azure Container Apps, DigitalOcean App
Platform, GCP Cloud Run, Railway, and Vercel. DigitalOcean archives and restores
only the exact bound app, preserves the complete live App Spec on both writes,
and verifies a terminal archived state with zero running instances before entry
succeeds. Every component restoration snapshot is durable before that atomic
app-level mutation. Vercel pauses and unpauses only the exact bound Project,
preserves a Project that was already paused, and verifies provider pause state
on its direct production origins before entry succeeds. Cloudflare supplies the
common public edge and PostgreSQL supplies the provider-independent write
fence. ECS Express explicitly declares maintenance unsupported until it can
prove all background and direct-origin workloads are reversibly stopped.
Generic planning must fail closed for unsupported providers; capability
presence is never inferred from a provider name.

Object-storage lifecycle is implemented for Amazon S3, Azure Blob Storage,
Google Cloud Storage, and Railway. Each adapter owns provider-native private
resource creation, ownership metadata, live usage observation, runtime-secret
wiring, streaming transfer, and confirmed teardown. Azure uses one dedicated
storage account per declared bucket so its account key and deletion boundary do
not span unrelated Hypervibe storage resources. Generic orchestration must not
pretend that accepting a provider id is equivalent to implementing this full
contract.

Storage connections reuse compatible primary cloud authentication (`ecs` for
S3, `cloudrun` for GCS, and `azure-container-apps` for Blob Storage) when it is
already verified. Standalone storage connections accept the same authentication
shape, not a second storage-specific key. For local operation they also use the
provider-native credential path: the AWS SDK default profile/SSO chain, Google
Application Default Credentials, or the Azure default credential chain. Explicit
credentials remain available for unattended automation. Region/location remains in the spec;
first-use observation resolves account/project/subscription scope through an
explicitly read-only adapter method, while provider registration, resource-group
creation, and credential derivation remain inside the reviewed apply action.
Temporary CLI sessions may provision, observe, and migrate storage, but are not
projected into deployed workloads as long-lived secrets.

## Database Tasks And Seed Data

Do not use temporary release-command changes to run one-off data operations. Release commands are durable deploy-time schema configuration.

Schema migrations are not an imperative Hypervibe operation. Application
containers should converge schema during startup, or the spec may declare a
durable provider predeploy/release command when startup migration is not
appropriate.

Fresh-environment seed/bootstrap data belongs in desired state as `database.seedCommand`. It should plan a visible one-shot seed action, run through the provider-neutral environment task runner during `hv_apply`, and record completion on the database component only after terminal success. In a managed-CI environment, a non-noop seed has an explicit dependency on a verified exact-SHA release of the desired commit. If that release remains in progress, apply stops pending before the seed; it never runs the older image or races newly issued integration credentials.

`hv_db_migrate` must not exist in the command registry, MCP surface, or CLI.
Provider-to-provider data moves are lifecycle operations modeled as explicit
`dataMigration` spec/plan/apply actions with dependency edges, data-bearing
confirmation, isolated copy and cutover stages, and verification receipts.
Database resets likewise belong to desired-state destruction, not an
imperative shortcut. Re-running or repairing seed or migrated data requires a
new reviewable desired-state id; Hypervibe does not expose a generic seed or
copy command runner.

## New Provider Checklist

New provider support needs a full contract, not a name in an enum. Add or confirm:

- provider registry metadata,
- credential schema,
- connection guidance with exact token type, URL, permissions, and examples,
- adapter capability flags,
- observe behavior and partial-observe semantics,
- diff/apply behavior,
- CI workflow behavior if supported,
- log/build/deploy inspection behavior if supported,
- domain attach behavior if supported,
- database/env-var wiring behavior if supported,
- tests that prove unsupported features fail with clear guidance.

## Tool And CLI Policy

The Hypervibe CLI is a supported interface to the same command registry, state store, plan/apply engine, provider adapters, and audit history as MCP. It is not a provider-CLI bypass.

Generic command ids are provider-neutral contracts. A command such as
`hv_inspect` or `hv_import` must accept registered provider names and dispatch
through provider capabilities or provider-owned drivers; it must not default to
one provider, narrow its schema to one provider, expose provider-prefixed ids,
or contain provider API/mapping logic in the command module. Providers without
the requested capability return explicit `UNSUPPORTED`. Contract tests scan the
registered command surface for these regressions.

Do not introduce dependencies on provider CLIs for infrastructure operations. Hypervibe should use its provider adapters and recorded connections so state, audit history, and drift detection stay coherent. When an MCP client already has Hypervibe tools, agents should call them directly rather than spawning the Hypervibe CLI.
