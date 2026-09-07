# Provider conformance

Hypervibe provider support is a lifecycle contract, not a provider name in a
schema. Every supported provider must pass the same resource contract through
the normal desired-state loop.

Catalog and blueprint work is intentionally separate from this contract.
The active provider scope deliberately excludes Heroku and Render. Fly.io Apps,
Machines, certificates, and Managed Postgres are now in scope as
`ready-for-live` candidates. Supabase and Neon remain in scope.

## Contract families

Hosting, databases, caches, storage, queues, and edge load balancing have
separate contracts:

- Hosting: project/environment identity, service identity, configuration,
  environment-variable drift, deploy/source state, observation, deletion, and
  terminal absence. Every hosting registration declares its exact complete
  workload kinds; an unsupported kind blocks at spec validation before project
  or environment mutation. Environment custom-domain support is a separate
  explicit provider capability; unsupported hosts must block before DNS mutation.
- PostgreSQL: provision, observe, wire runtime variables, connect with a
  bounded operation, noop, replace/migrate, destroy, retry, and terminal
  absence.
- Redis: provision, observe, wire `REDIS_URL`, verify a bounded `SET`/`GET`,
  noop, destroy, retry, and terminal absence. SQL migrations and database reset
  do not apply.
- Object storage: private creation, durable scoped identity, ownership-safe
  observation, provider-native runtime wiring, streaming list/get/put, and
  confirmed data-bearing teardown.
- Queues: a provider-declared backend and either explicit topic/subscription
  resources or application-managed PostgreSQL wiring. Hypervibe never invents
  provider queue mutations for the latter.
- Edge load balancing: independently observed monitor, pool, and hostname
  resources with explicit dependency edges and reverse-order teardown.

The complete lifecycle matrix lives in
`test/provider-conformance/provider-matrix.ts`. A provider moves from `planned`
to `ready-for-live` after its registry, schema, adapter, connection guidance,
and mocked contract are green. The opt-in live runner accepts
`ready-for-live`, but the roadmap remains red and Hypervibe does not advertise
support. Only a green live contract promotes it to `supported`.

### Hosting workload kinds

These are implemented adapter lifecycles, not a claim about every feature the
vendor offers:

| Hosting provider | Web | Worker | Cron |
| --- | --- | --- | --- |
| Railway | yes | yes | yes |
| GCP Cloud Run | yes | yes | yes |
| DigitalOcean App Platform | yes | yes | yes |
| Fly.io Machines | yes | yes | no |
| AWS ECS Express Mode | yes | no | no |
| Azure Container Apps | yes | no | no |
| Vercel | yes | no | no |

`hv_spec`, `hv_plan`, and `hv_apply` read this contract from provider registry
metadata. Unsupported services fail with their exact spec path before any
hosting project, environment, or service mutation. Fly.io's adapter implements
always-on Machines for web and worker workloads but not provider-native cron
schedules. ECS Express, Azure Container Apps, and Vercel currently implement
only their public web lifecycle; Hypervibe does not reinterpret those adapters
as background-worker or scheduled-job implementations.

The ordinary `npm test` suite stays green for supported behavior. Run
`npm run test:providers:roadmap` separately to execute one intentionally red
acceptance test per provider/resource contract. Each failure reports whether
the provider is registered, exposes the requested lifecycle and engine,
accepts the matrix credential shape, and has been promoted to `supported`.
Those failures are the implementation queue; they must not be added to the
ordinary CI gate until the corresponding provider is fully supported.

Hypervibe's own repository declares two daily, read-only safeguards. A focused
check reruns the matrix/registry contract, and a provider-truth code audit
compares every registered capability and public claim with current official
provider documentation and the available live-conformance evidence. The AI
audit does not replace a live contract: adapter code and mocked tests can move
a provider only to `ready-for-live`, while `supported` still requires concrete,
recent live evidence. Missing or stale proof is reported as a durable finding;
the daily job never receives provider credentials or mutates infrastructure.
The provider-truth scope is split into parallel, non-overlapping hosting,
data-service, and integration shards. Findings are combined only when every
expected shard report exists; a failed or incomplete shard preserves existing
issues instead of treating missing evidence as a clean audit.

### Code-host and CI conformance

Code hosting and primary CI use separate open registries and normalized ports;
they are not hosting-provider lifecycle ids. GitHub/GitHub Actions retain the
legacy compatibility route. GitLab/GitLab CI is currently `ready-for-live` for
mocked project create/delete, reviewed whole-root configuration and teardown,
environment-scoped variables, exact-SHA dispatch/evidence/rollback, and the
portable Azure Container Apps, Cloud Run, DigitalOcean, ECS Express, Railway,
and Vercel deploy recipes. GitLab.com 18.1+ uses its exact hosted-runner tag.
Self-managed execution requires one exact locked project runner and manager,
an uncontested tag, protected-ref-only execution, and an operator capability
attestation; GitLab's project APIs do not prove executor or privileged-Docker
configuration.

Mocked contracts cover tri-state repository/file observation, nested durable
identity, exact namespace/project lifecycle authority, confirmed destructive
actions, atomic merge-request configuration and removal, exact CI Lint include
provenance, unowned/overlapping variable refusal, one-variable-per-action
mutation/deletion, exact-SHA dispatch, evidence-bound rollback-tag creation,
normalized runs/jobs/logs/artifacts, secret erasure, and zero-mutation noop.
Runner observation rejects project/group runners that can claim the hosted tag
and multiple managers for a self-managed runner. A Bitbucket-shaped fake
provider remains registerable without editing the spec schema, generic tools,
hosting adapter, or application router.

This does not establish public GitLab support. There is no recent live receipt
for project lifecycle, rollback/teardown, any portable hosting recipe, or a
self-managed runner. Live evidence must name the exact GitLab offering,
version/edition, runner mode, and hosting recipe; GitLab.com evidence never
promotes self-managed instances or a different host. See [the accepted GitLab
architecture and evidence boundary](gitlab-integration.md).

### Environment custom domains

`test/provider-conformance/domain-lifecycle.spec.json` is the isolated live
fixture for environment domains. It declares one DNS-only subdomain under
`domain-test.hypervibe.dev` for each hosting provider: AWS ECS Express Mode,
Azure Container Apps, Cloud Run, DigitalOcean App Platform, Fly.io, Railway,
and Vercel. Run each environment stage-by-stage through `hv_spec`, `hv_plan`,
`hv_apply`, and `hv_status`; do not apply the entire seven-provider fixture as one
opaque batch.

Hosting credential schemas contain authentication and durable account/project
scope only. Region/location is optional desired state at
`environments.<name>.hosting.region`; agents normally omit it and accept the
provider default unless latency, residency, availability, or an existing
resource gives them a concrete reason to choose one.

The shared contract requires provider attach before Cloudflare mutation,
provider-returned DNS records only, durable provider/service/environment/zone
and record ids, explicit pending certificate receipts, noop convergence, and a
confirmation-gated exact detach with terminal provider and DNS absence. An
already-attached hostname without the durable binding blocks for explicit
`hv_import`. Cloud Run, ECS Express Mode, and Azure Container Apps declare
DNS-only traffic; Railway, DigitalOcean, Vercel, and Fly.io may opt into proxying only
after direct certificate validation succeeds.

### Environment maintenance and data cutover

Maintenance is a provider-neutral environment lifecycle capability.
The shared contract requires a bound Cloudflare static 503 edge, ordered
cron/worker/web suspension, a PostgreSQL write fence, fresh tri-state
observation after every boundary, exact restoration snapshots, and edge removal
only after normal workload/database state is verified. Migration copy authority
requires active source and target maintenance observations and hashes both into
the reviewed action; apply re-observes both before creating a fresh data target.

Azure Container Apps, Cloud Run, DigitalOcean App Platform, Railway, and Vercel
expose the workload-maintenance port. DigitalOcean resolves the exact bound app
and component, uses the documented app archive/restore setting, and requires a
terminal deployment plus zero provider-reported running instances before entry
converges. The full observed App Spec is preserved during each write, while the
durable snapshot stores only the prior non-secret maintenance object. Vercel
resolves only its durable Project binding, verifies the documented paused state
and direct production origins, preserves Projects paused before Hypervibe
maintenance, and resumes without a deployment. DigitalOcean and Vercel remain
`maintenance: ready-for-live` until their opt-in entry/noop/exit paths pass. ECS
Express and Fly.io report `maintenance: unsupported`, so generic planning
blocks before mutation.

The DigitalOcean contract follows the provider's documented
[archive/restore App Spec operation](https://docs.digitalocean.com/products/app-platform/how-to/archive-restore/)
and verifies terminal shutdown through the Apps API
[running-instances endpoint](https://docs.digitalocean.com/reference/api/reference/apps/#get-retrieve-app-instances).

Redis/Valkey conformance covers Azure Managed Redis, DigitalOcean, ElastiCache,
Memorystore, and Railway. The Railway adapter slice is `ready-for-live`, not
`supported`, until the opt-in live teardown contract passes.

Cloud SQL is the first database-resilience and restore-drill slice. Its mocked
contract pins tri-state HA/backup/replica observation, action-scoped mutations,
read-replica wiring and terminal deletion, plus deterministic compilation of a
review-gated scheduled PITR clone workflow. The drill workflow must prove exact
source identity, generated-target isolation, ownership-label-gated cleanup,
read-only SQL verification, secret-free files and receipts, and terminal clone
absence. Live restore drills remain opt-in and billable; ordinary provider
conformance does not schedule or create drill clones. The infrastructure live
profile now proves backup-policy convergence, replica lifecycle, reviewed
workflow publication, manual dispatch, terminal clone cleanup evidence, and
dependency-ordered teardown in an isolated project/repository.

Neon is the first newly implemented database slice. Its registry, credential
schema, provider adapter, connection guidance, and mocked create/observe/destroy
contract are green. It is `ready-for-live`, not `supported`, until the opt-in
live contract proves create, noop, and terminal teardown against an isolated
Neon account.

DigitalOcean is the first combined hosting/database/cache slice. One registered
deployment provider exposes App Platform directly and derives Managed
PostgreSQL and Managed Valkey adapters through the provider registry. Its mocked
contracts pin complete pagination, durable-ID-first observation, duplicate-name
blocking, partial-create identity preservation, secret-safe receipts, and
provider-confirmed terminal deletion. New Redis-compatible clusters use
DigitalOcean's current `valkey` engine; observation also recognizes legacy
`redis` clusters.

DigitalOcean App Platform, Managed PostgreSQL, and Managed Valkey are
`ready-for-live`. Hypervibe generates a provider-owned GitHub
Actions workflow that publishes one DOCR image tagged with the exact checked-
out Git SHA, updates only already-bound App Platform components, waits for that
exact deployment ID to become `ACTIVE`, and verifies the active component
image. CI never creates infrastructure. The reviewed project action
deterministically reuses an existing team registry, or creates a free Starter
registry when none exists; the connection contains only the API token.

The review-gated managed-workflow harness and provider-neutral Docker fixture
can now prove one full desired-state stack: App Platform, Managed PostgreSQL, and
Managed Valkey create/observe/wire, exact-SHA deploy, noop, update, dependency-
ordered destruction, and terminal absence. Promotion to `supported` still
requires one successful opt-in run against an isolated DigitalOcean team.

Fly.io is a combined hosting/database candidate registered under one `fly`
connection. The hosting adapter uses the Machines HTTP API directly and creates
one deterministic App per logical service. Apply allocates only the reviewed
service's shared IPv4/IPv6 ingress, reconciles app secrets, and creates a
stopped source-less Machine with ownership metadata; it never starts the
bootstrap image with the application's command. The provider-owned GitHub
workflow and provider-neutral portable recipe used by GitLab publish the
checked-out commit, resolve its immutable registry digest, update only the
single existing owned Machine with optimistic version checking, and wait for
the exact Machine and health checks to converge. CI cannot create Apps,
Machines, IPs, certificates, or databases.

The derived Fly Managed Postgres adapter creates one cluster, one logical
database, and one dedicated `schema_admin` user. If a downstream create step
fails, it removes the exact partial cluster and verifies absence; if rollback
cannot be verified, the failed receipt retains the cluster id and explicitly
requires cleanup. Normal teardown also waits for provider-confirmed absence.
The cluster endpoints remain private to Fly networking. For each bounded local
query, seed, or migration operation, Hypervibe now creates one uniquely named
organization WireGuard peer, re-observes its durable id and public key, starts
the packaged userspace connector with its private key over stdin, verifies the
database with `SELECT 1`, and removes the exact peer after the operation. An
existing matching peer blocks instead of being treated as stale and deleted.
No Fly CLI or public PostgreSQL proxy is installed or created. The matrix keeps
both Fly entries at `ready-for-live`; promotion now requires a successful
isolated hosting/database lifecycle using the packaged connector.

Cloudflare provides the first provider-managed edge load-balancer lifecycle.
An environment may declare one load balancer at its existing `domain`, with at
least two public web services as distinct public HTTPS DNS origins. Local,
private, IP-literal, credential-bearing, path-qualified, nonstandard-port, and
duplicate origin URLs block before provider mutation. Hypervibe owns and observes one
account-scoped health monitor, one account-scoped equal-weight origin pool, and
one zone-scoped proxied hostname load balancer. Each resource has a separate
plan/apply action and durable provider id. Same-name unbound resources block
(load-balancer adoption is outside V1); non-404 observation failures preserve state; teardown removes
the hostname before the pool and monitor and verifies terminal absence after
each provider deletion. Its infrastructure live profile creates two disposable
Railway HTTPS origins, verifies public Cloudflare health and in-place monitor
updates, then proves load-balancer-first cleanup before origin deletion. V1
does not create AWS ALBs, private origins, weighted
steering, geo steering, session affinity, or cross-environment origins. ECS
Express already manages its ALB as provider-internal hosting ingress; it is not
a second implementation of this cross-origin edge-balancer contract.

Azure Container Apps is now an authentication-only, `ready-for-live` hosting
slice. Its reviewed project action creates the tagged resource group, Basic
ACR registry, role assignments, and managed environment; service actions create
system-identity Container Apps, and CI only pushes an exact digest and updates
already-bound app IDs. Azure Database for PostgreSQL Flexible Server and Azure
Managed Redis are implemented under independent `azure-postgres` and
`azure-managed-redis` provider ids and reuse that verified authentication-only
connection. They derive the exact Container Apps resource group and location,
declare their public-network/TLS contracts explicitly, carry scoped partial
create identities through failure, and are `ready-for-live` pending complete
Azure full-stack live contracts. Generated passwords, keys, and connection URLs
stay out of receipts. The hosting adapter defaults to `canadacentral`; another
location is declared in `hosting.region`, never in the service-principal
credential.

The extended matrix also includes:

- [Azure Database for PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/rest/api/postgresql/)
  for PostgreSQL, and [Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/overview)
  for Redis. They use separate provider ids because they have independent
  resource types, durable identities, observation, and deletion lifecycles.
- [Vercel Projects and Deployments](https://vercel.com/docs/rest-api) for
  hosting. Vercel is intentionally absent from the database matrix because
  [Vercel Postgres is no longer available](https://vercel.com/docs/postgres);
  its current Postgres offerings are provider-owned Marketplace integrations.
  The replacement hosting slice binds a verified personal or Team scope,
  creates one source-less Project per logical web service, and keeps project,
  production-variable, and deletion mutations inside spec/plan/apply. Its
  managed workflow uploads the exact checked-out files through the REST API,
  reconciles deployments by repository and full Git SHA before creating one,
  and blocks Vercel-native Git links. It supports public framework/static web
  projects and rejects arbitrary long-lived start commands or build overrides
  it cannot apply. Its review-gated managed-workflow harness is now available,
  so the matrix entry is `ready-for-live`; promotion still requires a
  successful opt-in create/deploy/noop/update/destroy run.
- [Fly.io Machines](https://fly.io/docs/machines/api/) and the
  [Machines API reference](https://docs.machines.dev/) for hosting, plus
  [Fly Managed Postgres](https://fly.io/docs/mpg/) for PostgreSQL. Hypervibe
  uses organization-scoped tokens and provider HTTP APIs rather than `flyctl`.
  It records the organization scope beside App and cluster identities, blocks
  name-only adoption, keeps placement in desired state, and uses a packaged
  userspace WireGuard connector for bounded access to private database
  endpoints. These are `ready-for-live` entries rather than support claims
  until their opt-in live lifecycle evidence is complete.
- [Neon Postgres](https://api-docs.neon.tech/reference/use-cases) as its own
  database provider. Neon owns the project, branch, endpoint, database, and
  deletion lifecycle even when a Vercel integration wires it to an app. Its
  adapter uses the public Neon API directly and does not depend on a provider
  CLI.
- [Amazon ElastiCache Serverless](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/wwe-getting-started.html)
  under the `elasticache` cache provider. It reuses the verified auth-only
  `ecs` connection; region and size are desired cache fields, never credential
  placement. The ECS project action owns a deterministic tagged workload
  security group in the exact regional default VPC, and every Express create,
  update, environment-variable removal, and managed-CI release preserves that
  group and the verified default subnets. ElastiCache re-observes this binding
  without mutation, then creates TLS serverless Valkey plus a dedicated group
  whose only ingress is TCP 6379 from the workload group. Teardown proves cache
  absence before deleting and proving absence of its group. The mocked contract
  is `ready-for-live`; it is not `supported` without a successful recent opt-in
  live create/noop/update/destroy run.
- [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html)
  under the `rds` database provider. RDS is implemented only with ECS Express:
  it reuses the verified `ecs` connection, requires the exact persisted
  account/region/default-VPC workload-network binding, and never creates or
  guesses hosting scaffolding from a database action. Each instance gets one
  tagged database security group whose durable PostgreSQL ingress is limited to
  the exact ECS workload security group. Hypervibe re-observes the database,
  attachment, and ingress before reporting success or database convergence;
  teardown proves database absence before deleting the exact managed group.
  Bounded local diagnostics may still add and remove their separately labelled
  caller `/32` rule. The mocked contract is `ready-for-live`; promotion requires
  a successful complete ECS plus RDS live lifecycle.
- [Google Cloud Memorystore for Redis](https://cloud.google.com/memorystore/docs/redis/reference/rest)
  under the `memorystore` cache provider. Its private-IP, Redis AUTH, durable
  resource observation, uncertain-create preservation, terminal deletion,
  desired placement drift, existing-network verification, and Cloud Run Direct
  VPC egress lifecycle pass mocked tests. It is `ready-for-live`, not
  `supported`: promotion still requires a successful recent opt-in live
  create/noop/update/destroy run against an isolated Google Cloud project whose
  selected VPC and regional subnet already exist. Hypervibe never creates that
  networking implicitly.

These entries are live-conformance candidates, not current support promises. An entry
stays `planned` until its provider adapter and mocked lifecycle contract pass,
then remains `ready-for-live` until its complete live lifecycle contract passes.

## Required lifecycle phases

Every live provider contract must prove:

1. A verified connection is available through a local credential reference.
2. A ProjectSpec plans provider-confirmed creates; unknown observation never
   authorizes a create.
3. Apply mutates only the exact actions in the persisted plan.
4. Live observation returns durable provider identities.
5. Replanning unchanged desired state produces only noops and causes zero
   provider mutations.
6. A configuration change updates the existing resource rather than creating a
   duplicate.
7. Removing desired resources plans dependency-ordered, exact-action-confirmed
   deletion.
8. Apply waits for provider-terminal absence before removing local bindings.
9. Repeating deletion after interruption or provider-side absence converges
   safely.
10. No credentials, connection URLs, passwords, or secret values appear in
    plans, receipts, logs, snapshots, or test failures.

An environment-level desired-absent state is required for complete cleanup.
Test cleanup must not call provider APIs directly, because that would bypass
the lifecycle behavior the test is intended to prove.

## Running an opt-in live test

Live tests are skipped during ordinary `npm test`. They are billable and
destructive and must use an isolated provider account/project intended for
testing.

Build first, export only the credential variables named by the provider matrix,
then select exactly one contract:

```sh
HYPERVIBE_LIVE_HOSTING=railway npm run test:providers:live
HYPERVIBE_LIVE_HOSTING=fly npm run test:providers:live
HYPERVIBE_LIVE_DATABASE=cloudsql npm run test:providers:live
HYPERVIBE_LIVE_DATABASE=neon npm run test:providers:live
HYPERVIBE_LIVE_DATABASE=fly npm run test:providers:live
HYPERVIBE_LIVE_DATABASE=azure-postgres npm run test:providers:live
HYPERVIBE_LIVE_CACHE=railway npm run test:providers:live
HYPERVIBE_LIVE_CACHE=memorystore npm run test:providers:live
HYPERVIBE_LIVE_CACHE=elasticache npm run test:providers:live
HYPERVIBE_LIVE_CACHE=azure-managed-redis npm run test:providers:live
```

The runner accepts only `ready-for-live` or live-proven entries and refuses any
`planned` entry before reading credentials or creating billable resources.

The Neon contract requires `HYPERVIBE_TEST_NEON_API_KEY` plus the Railway
fixture-host credentials. Set `HYPERVIBE_TEST_NEON_ORGANIZATION_ID` when a
personal Neon key should target an organization, and optionally set
`HYPERVIBE_TEST_NEON_REGION_ID`. Use only an isolated account/workspace because
the contract creates and destroys real provider resources.

The Fly contracts require `HYPERVIBE_TEST_FLY_API_TOKEN` and
`HYPERVIBE_TEST_FLY_ORGANIZATION_SLUG`. Use a short-lived organization-scoped
token for the exact isolated organization; an app deploy token cannot create
the reviewed Apps or Managed Postgres cluster. The database contract creates a
billable Basic Managed Postgres cluster with 10 GB of storage, exercises the
packaged private WireGuard connector with `SELECT 1`, and verifies terminal
cluster and peer absence during teardown. Fly prorates clusters deleted during
the month, but the operator must still explicitly authorize this billable live
run before starting it.

The runner copies a tiny HTTP fixture into a temporary worktree and writes a
mode-`0600` temporary credential object. Hypervibe consumes it through
`credentialsRef=file:...`; the file is deleted immediately after connection
verification. Values are never passed as CLI arguments or printed. The test
removes its services, databases, and caches through spec/plan/apply, and its
`afterAll` repeats that desired-state cleanup after a partial test failure.

## Running recovery and load-balancer live tests

The infrastructure live runner proves the two provider-managed lifecycle
contracts that need more than an ordinary single-resource fixture. Select
exactly one contract:

```sh
HYPERVIBE_LIVE_INFRASTRUCTURE=cloudsql-recovery npm run test:providers:infrastructure-live
HYPERVIBE_LIVE_INFRASTRUCTURE=cloudflare-load-balancer npm run test:providers:infrastructure-live
```

Both contracts are billable and destructive. They confirm every exact action
id automatically only inside an explicitly selected live run. Ordinary tests
skip the file. Cleanup uses only Hypervibe spec/plan/apply; it never calls a
provider API or provider CLI directly. When cleanup cannot be proven, the
runner preserves its data directory and prints only action ids, resource
names, and sanitized durable bindings needed for a retry.

### Cloud SQL recovery

Use a clean disposable checkout of a dedicated GitHub repository and an
absolute persistent Hypervibe data directory. Commit this bootstrap spec before
running, replacing the project and repository:

```json
{
  "version": 1,
  "project": "hypervibe-recovery-live",
  "gitRemoteUrl": "https://github.com/OWNER/REPOSITORY.git",
  "environments": {
    "production": {
      "hosting": { "provider": "cloudrun" },
      "services": {},
      "database": {
        "provider": "cloudsql",
        "resilience": {
          "backups": { "retainedBackups": 8, "pitrRetentionDays": 7 },
          "replicas": { "live": {} }
        }
      },
      "email": { "enabled": false },
      "envVars": {},
      "deploy": { "strategy": "manual" }
    }
  }
}
```

The GCP credential is a service-account JSON key created at
`https://console.cloud.google.com/iam-admin/serviceaccounts` and scoped to one
isolated project. Grant `roles/cloudsql.admin` for instance, backup-policy,
replica, clone, user, and deletion lifecycle; `roles/cloudsql.client` for the
connector; the Cloud Run verification roles documented by `hv_connections`; and
enable `sqladmin.googleapis.com`. The GitHub credential is a
[pre-filled fine-grained token](https://github.com/settings/personal-access-tokens/new?name=Hypervibe%20repository&description=Manage%20one%20repository%20with%20Hypervibe&expires_in=90&actions=write&administration=write&contents=write&environments=write&issues=write&pull_requests=write&secrets=write&actions_variables=write&workflows=write) scoped to
the one disposable repository with Contents, Pull requests, Actions, Variables,
and Secrets read/write permissions as described by the GitHub connection
guidance. Connect both through file/dotenv references, never raw command values.

Before the run, declare a repository target under
`spec.secrets.HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS.githubActions`, then supply a
separate minimal-role drill service-account JSON through `hv_plan secretRefs`
without printing it. It needs the exact clone/connect/delete/
get/list/update and user-update permissions documented in the restore-drill
section of the README, not the broader lifecycle administrator role:

```text
hv_plan project="hypervibe-recovery-live" env="production" secretRefs={"HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS":"env:HYPERVIBE_TEST_GCP_DRILL_SERVICE_ACCOUNT_JSON"}
```

Then export:

```text
HYPERVIBE_LIVE_REPOSITORY_WORKTREE=/absolute/path/to/disposable-checkout
HYPERVIBE_LIVE_DATA_DIR=/absolute/path/to/persistent-hypervibe-state
HYPERVIBE_TEST_GITHUB_REPOSITORY=OWNER/REPOSITORY
HYPERVIBE_TEST_GITHUB_API_TOKEN=...
HYPERVIBE_TEST_GCP_PROJECT_ID=...
HYPERVIBE_TEST_GCP_SERVICE_ACCOUNT_JSON=...
HYPERVIBE_TEST_GCP_DRILL_SERVICE_ACCOUNT_JSON=... # used only to pre-seed the repository secret
HYPERVIBE_TEST_GCP_REGION=us-central1 # optional
```

The runner first converges backup/PITR policy and one read replica. It then
adds the restore drill through the managed GitHub infrastructure action,
prints the review URL, and waits for a human merge. It dispatches the workflow
through `hv_ci_trigger`, observes it only through `hv_ci_status`, and requires
safe log markers proving that one generated `hv-drill-*` clone was created and
provider-confirmed absent after verification. Cleanup first removes the
scheduled workflow through a second reviewed PR, then deletes the replica, and
only then deletes the primary. A non-terminal run, retained clone, failed clone
cleanup, or missing terminal marker stops teardown and preserves the workflow,
primary, bindings, and local state for inspected recovery.

### Cloudflare load balancing

Use the
[pre-filled Cloudflare Account API Token template](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=Hypervibe%20DNS%20and%20domains) (or the
[pre-filled User API Token template](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=Hypervibe%20DNS%20and%20domains)) and scope it to one isolated
existing zone. The links preselect Hypervibe's base DNS permissions; add Load
Balancers Read/Write on that zone and Load Balancing Monitors and Pools
Read/Write on the owning account for this profile. Use the token value, not its
name/id or a Global API Key. A safe connection example is:

```text
hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}
```

The test also needs an isolated Railway workspace token through the existing
`HYPERVIBE_TEST_RAILWAY_TOKEN`/optional workspace-id live profile. Export:

```text
HYPERVIBE_TEST_CLOUDFLARE_API_TOKEN=...
HYPERVIBE_TEST_CLOUDFLARE_ACCOUNT_ID=... # optional when uniquely observable
HYPERVIBE_TEST_CLOUDFLARE_LOAD_BALANCER_HOSTNAME=hv-conformance-UNIQUE.example.com
HYPERVIBE_TEST_RAILWAY_TOKEN=...
HYPERVIBE_TEST_RAILWAY_WORKSPACE_ID=... # optional
```

The required hostname prefix prevents accidentally targeting an ordinary
application hostname. Hypervibe creates two HTTPS Railway origins, then a
Cloudflare monitor, pool, and public load balancer as three separately
authorized actions. The contract verifies public health, noop convergence, and
an in-place monitor update. Teardown removes the public hostname before the
pool and monitor, proves there are no unmanaged load-balancer resources, and
only then removes the two origins.

If that cleanup fails, rerun with the printed absolute paths as
`HYPERVIBE_LIVE_REPOSITORY_WORKTREE` and `HYPERVIBE_LIVE_DATA_DIR`. The runner
reuses the original project identity and bindings, converges the leftover edge
resources to absent before creating anything new, and leaves the
caller-provided workspace intact after success.

## Running a managed-workflow live test

Providers whose first application release must run through a managed GitHub
Actions workflow use a separate review-gated harness. These hosting profiles
are enabled:

| Provider id | Fixture directory | Workflow | Managed datastores | Health URL |
| --- | --- | --- | --- | --- |
| `vercel` | `test/provider-conformance/fixture-vercel` | `deploy-vercel-production.yml` | none | HTTPS `/api/health` |
| `digitalocean` | `test/provider-conformance/fixture` | `deploy-digitalocean-production.yml` | PostgreSQL + Valkey | HTTPS `/health` |

The harness never merges its own infrastructure pull request: it applies the
reviewed plan, prints the Hypervibe PR URL, waits for a human merge, and then
continues through `hv_ci_trigger`, `hv_ci_status`, `hv_health`, noop/update
checks, and spec-driven teardown. Teardown may produce a second infrastructure
PR that removes durable service ids from the workflow; the harness waits for
that review too. Exact-SHA proof comes from the successful Hypervibe
server-release evidence artifact tied to the observed workflow run, not from
GitHub's dispatch-ref `head_sha`.

Use a disposable checkout of a dedicated GitHub repository and an isolated
provider account, Team, subscription, or resource group. Copy the tracked
files from the selected profile's fixture directory into the repository. Add
this canonical `.hypervibe/spec.json`, replacing the project, repository, and
provider:

```json
{
  "version": 1,
  "project": "hypervibe-managed-live",
  "gitRemoteUrl": "https://github.com/OWNER/REPOSITORY.git",
  "secrets": {},
  "environments": {
    "production": {
      "hosting": {
        "provider": "PROVIDER"
      },
      "services": {
        "web": {
          "workloadKind": "web",
          "healthCheckPath": "/api/health",
          "public": true
        }
      },
      "email": {
        "enabled": false
      },
      "envVars": {
        "HYPERVIBE_CONFORMANCE_REVISION": "create"
      },
      "deploy": {
        "strategy": "branch",
        "trigger": "ci",
        "branch": "main",
        "autoDeploy": false
      }
    }
  }
}
```

For `vercel`, use provider `vercel` and keep the service block above. For
`digitalocean`, replace the service block with this exact object:

```json
{
  "workloadKind": "web",
  "startCommand": "node server.mjs",
  "healthCheckPath": "/health",
  "public": true
}
```

The `digitalocean` profile also requires these environment fields:

```json
"database": {
  "provider": "digitalocean",
  "engine": "postgres"
},
"cache": {
  "provider": "digitalocean",
  "engine": "redis"
}
```

Commit and push those files to `main` before running the harness. The test
proves the local spec is byte-for-byte committed at `HEAD` and that every
required fixture path is tracked before it can create a provider resource.
`HYPERVIBE_LIVE_DATA_DIR` must be a persistent absolute directory; interrupted
runs retain encrypted connection state, durable bindings, and cleanup
authority there instead of losing them in a temporary directory.

Export:

```sh
export HYPERVIBE_LIVE_REPOSITORY_WORKTREE="/absolute/path/to/disposable-checkout"
export HYPERVIBE_LIVE_DATA_DIR="/absolute/path/to/persistent-live-state"
export HYPERVIBE_TEST_GITHUB_REPOSITORY="OWNER/REPOSITORY"
export HYPERVIBE_TEST_GITHUB_API_TOKEN="<fine-grained repository PAT, or classic PAT with repo + workflow>"

# Select exactly one configured provider:
export HYPERVIBE_TEST_VERCEL_ACCESS_TOKEN="<Vercel personal or Team token>"
# Required only when the token should operate in a Team:
export HYPERVIBE_TEST_VERCEL_TEAM_ID="team_..."
HYPERVIBE_LIVE_MANAGED_HOSTING=vercel npm run test:providers:managed-live

# Add this explicit opt-in to pause, verify, retry, and unpause the disposable
# Vercel Project after its exact-SHA health check:
HYPERVIBE_LIVE_MANAGED_HOSTING=vercel HYPERVIBE_LIVE_MAINTENANCE=1 npm run test:providers:managed-live

# Or, after exporting the provider variables described below:
HYPERVIBE_LIVE_MANAGED_HOSTING=digitalocean npm run test:providers:managed-live
```

The recommended GitHub credential is a
[pre-filled fine-grained repository PAT](https://github.com/settings/personal-access-tokens/new?name=Hypervibe%20repository&description=Manage%20one%20repository%20with%20Hypervibe&expires_in=90&actions=write&administration=write&contents=write&environments=write&issues=write&pull_requests=write&secrets=write&actions_variables=write&workflows=write)
whose selected repository is only the isolated fixture. Grant Metadata read
plus Administration, Actions, Contents, Pull requests, Secrets, and Workflows
read/write. A classic PAT with `repo` and `workflow` also works but cannot be
restricted to one repository. The credential is stored through a repository-
scoped `credentialsRef`; none of these hosting profiles needs package-read
permission on that repository-management token. The Vercel credential is a
[personal access token](https://vercel.com/account/settings/tokens) scoped to
the intended personal account or Team. It must be able to read that scope and
create, configure, deploy, and delete Projects there; include the immutable
`teamId` for a Team-scoped run. The harness writes temporary
mode-`0600` credential files inside the persistent data directory and removes
them immediately after Hypervibe verifies each connection; values never enter
command arguments, plans, receipts, or test output.

For DigitalOcean App Platform, create a
[custom-scope PAT](https://cloud.digitalocean.com/account/api/tokens) for the
isolated team. Grant `app:read`, `app:create`, `app:update`, `app:delete`,
`registry:read`, `registry:update`, `registry:create`, and `account:read`, plus
the region, size, and action read scopes described in the DigitalOcean section
above. Export only `HYPERVIBE_TEST_DIGITALOCEAN_TOKEN`. The reviewed project
action reuses an existing registry or creates a free Starter registry when none
exists. This account-level support registry is not removed by environment
teardown. The full-stack profile also
requires `database:read`, `database:view_credentials`, `database:create`,
`database:update`, and `database:delete`; the created PostgreSQL and Valkey
clusters are billable and are removed by exact confirmed actions during
teardown.

The default review and workflow timeouts are 30 minutes. Override them with
positive millisecond values in `HYPERVIBE_LIVE_REVIEW_TIMEOUT_MS` and
`HYPERVIBE_LIVE_WORKFLOW_TIMEOUT_MS`. If a review or workflow fails, the
`afterAll` stage still changes the spec to desired-absent for the service and
any declared database/cache, confirms every exact destroy action, waits for
provider-confirmed absence, and preserves the data directory if cleanup cannot
be proven. Do not delete that directory until the test reports verified
teardown.

Until the environment desired-absent lifecycle is implemented, the final live
provider-context/local-binding assertion remains a test-first `todo`. A live
run may therefore leave an empty provider project/environment context, but it
must not leave a workload, database, or cache. Use only an isolated provider
account/project intended for testing. Do not enable a provider in shared CI
until the final assertion is executable and cleanup failures surface the
remaining provider resource identities.
