# hypervibe

> Desired-state infrastructure management from your terminal or agent.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)

Hypervibe is a desired-state infrastructure orchestrator with two interfaces over one engine: a human/automation-friendly CLI and an [MCP server](https://modelcontextprotocol.io/) for Codex and Claude. Both use the same specs, reviewed plans, provider adapters, connections, receipts, and audit history.

```
You: "Create staging with hosting, Postgres, object storage, a queue, and api.staging.example.com"

Agent: Updates the desired state, plans every provider change and dependency,
       applies the reviewed plan, and verifies the resulting services and resources.
```

## Features

**Providers and Integrations**

Lifecycle maturity is reported by `hv_inspect {}` and `hv_connections {}`. Every lifecycle slice below is implemented and `ready-for-live`; a dated successful live conformance result is still required before any slice is promoted to `supported`.

- **AWS** *(ready for live conformance)* - ECS Express hosting, RDS Postgres, ElastiCache Serverless Valkey/Redis, and private S3 buckets
- **Azure** *(ready for live conformance)* - Container Apps hosting, PostgreSQL Flexible Server, Managed Redis, and private Blob Storage containers
- **Fly.io** *(ready for live conformance)* - Apps/Machines hosting and Managed Postgres with operation-scoped private WireGuard access
- **Google Cloud** *(ready for live conformance)* - Cloud Run hosting, Cloud SQL Postgres, Memorystore Redis with Direct VPC egress, private Cloud Storage buckets, and Pub/Sub queues
- **DigitalOcean** *(ready for live conformance)* - App Platform hosting, Managed PostgreSQL, and Managed Valkey
- **Railway** *(ready for live conformance)* - App hosting, Postgres databases, Redis caches, private S3-compatible storage buckets, cron jobs, and postgres-backed queues
- **Supabase** *(ready for live conformance)* - Managed Postgres with direct or pooled connectivity
- **Neon** *(ready for live conformance)* - Managed Postgres
- **Vercel** *(ready for live conformance)* - Projects and Deployments hosting
- **Cloudflare** - DNS/domain management and a ready-for-live edge load balancer for two or more public HTTPS origins
- **Stripe** - Payment integration, webhooks, products
- **SendGrid** - Email authentication, domain verification
- **Twilio** - Messaging Services, webhook callbacks, existing-number attachment

**Secret Managers**
- **HashiCorp Vault** - KV secrets with versioning
- **AWS Secrets Manager** - Versioned reads with the AWS SDK default credential chain
- **Doppler** - Simple config management
- **Stripe Projects** - Resolve one service from an already-pulled active local environment

**Workloads & Connected Infrastructure**
- Services declare `workloadKind: web | worker | cron`. Workers are always-on background consumers (on Cloud Run: internal-only ingress, minimum one instance; they must still listen on `PORT`).
- `queues` in the spec declares named message queues: Cloud Run environments get real Pub/Sub topics + subscriptions (apps receive `QUEUE_TOPIC_*` / `QUEUE_SUBSCRIPTION_*`); Railway environments are postgres-backed (pg-boss model — requires a declared database; apps consume via `DATABASE_URL`). Every queue environment gets `QUEUE_BACKEND` and `QUEUE_NAMES`.
- `storage` declares named private object buckets and an explicit `injectInto` service list. Ready-for-live providers are Amazon S3 (`s3`), Azure Blob Storage (`azureblob`), Google Cloud Storage (`gcs`), and Railway (`railway`), independent of the hosting provider. S3/Railway wire the established `AWS_*` contract; Azure and GCS wire explicit provider-native variables plus `OBJECT_STORAGE_PROVIDER` and `OBJECT_STORAGE_BUCKET`. Credentials never appear in specs, bindings, plans, receipts, or logs. Bucket deletion is data-bearing and confirmation-gated.
- Existing `ecs`, `cloudrun`, and `azure-container-apps` connections are reused automatically for their matching storage provider. Reused GCP access is explicit and staged: `hv_connections provider="cloudrun" action="prepare" gcsAccess="inspect"` previews read-only inventory access, while `gcsAccess="lifecycle"` separately previews the broader create/transfer/teardown role. Confirm with `adminAuth="default"` to use existing Google Application Default Credentials; Hypervibe does not require a second exported token or JSON key. A normal `gcloud auth login` and Hypervibe's stored deploy service-account key are not user ADC: if ADC is absent, run `gcloud auth application-default login` and optionally set the quota project before retrying. Hypervibe returns the exact commands, required project roles, official Google setup URL, and retry call without storing the user credential. Otherwise the standalone storage connection accepts the same cloud authentication fields. Region/location is desired state in the spec; Hypervibe creates provider resources and derives workload credentials, so operators do not obtain separate bucket HMAC keys, Azure account keys, or storage-specific settings.
- Memorystore reuses a verified `cloudrun` connection. Cache region/network/subnetwork/tier/size live in `hv_spec`, and Hypervibe verifies an existing VPC/subnet before configuring Cloud Run Direct VPC egress; it never creates networking implicitly. `memorystoreAccess="inspect"` stages Redis/Compute read access, while `memorystoreAccess="lifecycle"` adds the reviewed Redis and network-use roles. Pub/Sub remains independently granted only by `queueAccess="lifecycle"`.
- Standalone S3/GCS/Azure Blob connections can also use the normal local cloud login with no credential value: AWS profiles/SSO through the default SDK chain, `gcloud auth application-default login`, or Azure's default credential chain (including `az login`). Explicit credential files remain supported for CI. Expiring local sessions are used for lifecycle and migration only and are never copied into deployed services.
- `cache` declares Redis independently from SQL/document databases. Hypervibe wires the cache contract into its consumers; cache deletion is data-bearing and confirmation-gated.
- Domains, DNS records, databases, caches, storage, queues, schedules, and service dependencies all remain explicit desired state. Hypervibe plans their dependency order, projects only the required runtime bindings into each service, and verifies each resource through its provider adapter.
- Resource placement is provider-native desired state: for example, an AWS region such as `us-west-2`, an Azure location such as `westus2`, a GCS location such as `us-central1`, or a Railway placement such as `sjc`.

**Developer Experience**
- **CLI and MCP parity** - Every supported command is available through both interfaces
- **Provider-neutral DevOps** - Canonical code-host and CI interfaces cover GitHub/GitHub Actions and a ready-for-live GitLab/GitLab CI implementation without coupling hosting recipes to either vendor
- **Human and JSON output** - Readable terminal output by default, stable redacted envelopes with `--json`
- **Natural language** - No YAML, no clicking through dashboards
- **Resource orchestration** - Plan databases, caches, storage, queues, domains/DNS, and integrations together, then project only the required secret-safe runtime bindings into each service
- **Environment management** - Staging, production, PR previews
- **Migration support** - Run Prisma, Drizzle, TypeORM migrations
- **Local development** - Generate Docker Compose for local parity
- **Secret rotation** - Rotate once, propagate to all environments
- **Audit trail** - Track secret access across deploys

## Quick Start

### Download the macOS Companion

Download the latest installer from
[GitHub Releases](https://github.com/davejohnson/hypervibe/releases/latest).
Choose `arm64` for Apple Silicon Macs or `x86_64` for Intel Macs. Each DMG has
an adjacent `.sha256` checksum file.

### 1. Install the CLI

Published releases are public on the npm registry. Installation does not
require GitHub access, a package token, or custom npm registry configuration.

```bash
npm install -g @hypervibe/hypervibe@latest
hypervibe --help
```

The core desired-state workflow is:

```bash
hypervibe spec --file .hypervibe/spec.json
hypervibe plan --env staging
hypervibe apply --plan-id <plan-id>
hypervibe status --env staging
```

Human-readable output is the default. Add `--json` for automation, or
`--input <file|->` to supply the complete command input as JSON. Confirmation
prompts are TTY-only; scripts must pass explicit confirmation flags.

To connect this exact repository to Hypervibe's hosted reporting without a
GitHub PAT:

```bash
cd /path/to/your/repository
hypervibe cloud pair
# Open the returned Hypervibe URL and approve the displayed repository.
hypervibe cloud pair --action status
```

The same workflow is available to MCP clients as `hv_cloud_pair`: call it once
with `action="start"`, offer to open `verificationUrl`, then call it with
`action="status"` after the user approves. Hypervibe detects the GitHub origin,
uses the repositories selected in the Hypervibe GitHub App, and stores the
one-time device and environment credentials only in the encrypted local
connection store. Do not paste a GitHub token or choose an environment.

To run the current source checkout instead:

```bash
git clone https://github.com/davejohnson/hypervibe.git
cd hypervibe
npm ci
npm run build
node dist/index.js --help
```

### 2. Install As Codex MCP

```bash
codex mcp add hypervibe -- npx -y @hypervibe/hypervibe@latest
codex mcp list
```

### 3. Install As Claude Code MCP

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "hypervibe": {
      "command": "npx",
      "args": ["-y", "@hypervibe/hypervibe@latest"]
    }
  }
}
```

### 4. Connect Providers

Restart Claude Code, then:

```
You: "Show me which provider connections this staging spec requires"
Claude: Lists the hosting, database, storage, queue, DNS, and integration connections needed by the plan.

You: "Connect those providers using my local credential references"
Claude: Validates each reference locally and stores the verified connections securely.
```

### 5. Deploy

```
You: "Create a new project called my-app with staging and production environments"
You: "Add the API, worker, Postgres, documents bucket, and events queue to staging"
You: "Attach api.myapp.com and manage its DNS"
You: "Plan and apply staging"
You: "Verify the services and connected resources"
```

Environment custom domains use the same spec/plan/apply loop for Cloud Run,
DigitalOcean App Platform, Railway, and Vercel.
Hypervibe attaches the hostname at the provider first, writes only returned
Cloudflare records, persists exact provider/DNS ids, and confirmation-gates
exact detach. Cloud Run stays DNS-only during its native certificate flow.
GitHub Pages custom domains use the separate project-level `github.pages`
lifecycle.

### 6. Supply Secrets (Optional)

Declare delegated secret slots in the spec, then supply local or secret-manager
references when planning:

```
You: "Connect to Vault at https://vault.mycompany.com"
You: "Plan production with APP_SIGNING_KEY from vault://secret/myapp/runtime#signing-key"
Claude: Resolves the value locally, encrypts it into the reviewed plan, and injects it only during hv_apply.
```

Secret references use the format: `provider://path[#key][@version]`

## Architecture

```
               ┌───────────────┐
               │ Hypervibe CLI │
               └───────┬───────┘
                       │
┌───────────────┐      ▼
│ MCP clients   ├──► Command registry/context/results
└───────────────┘      │
                       ▼
               Spec → Plan → Apply → Status
                       │
                       ▼
              Provider and secret adapters
```

## Available Commands

Hypervibe exposes the same focused operations as canonical `hv_*` MCP tools and friendly CLI commands. The core is a Terraform-style loop:

1. `hv_spec` — declare the desired state (services, database, cache, storage, load balancer, domain, email, messaging, env vars) as a revisioned spec
2. `hv_plan` — observe live infrastructure, diff against the spec, and get an executable plan
3. `hv_apply planId=...` — converge. Stale plans are rejected; destroying data-bearing resources requires explicit confirmation
4. `hv_status` — see drift between desired and observed state at any time

Around that core: hosted reporting pairing (`hv_cloud_pair`), provider
connections (`hv_connections`), deploy/rollback, logs/errors/health, bounded
database diagnostics, secrets, domains/DNS, email, payments, CI, App
Store/TestFlight, and local dev tools.

`hv_connections` and `hv_secrets` both accept `project="name-or-id"` to select and validate project context. Provider `scope` remains separate: it identifies the actual repository, domain, account, or environment covered by a credential.

Their parameter modes are intentionally explicit:

```text
hv_connections                                      # list globally
hv_connections project="my-app"                     # list; validate project context
hv_connections project="my-app" provider="github" credentialsRef="env:NODE_AUTH_TOKEN"

hv_secrets                                          # list sources globally
hv_secrets project="my-app"                         # list sources; validate project context
hv_secrets project="my-app" env="staging"           # masked hosting-variable names

hv_inspect                                          # provider/capability discovery; no parameters
hv_inspect provider="cloudrun"                      # connection verification; discovery advertises each resource selector contract
hv_inspect provider="cloudrun" project="my-app" env="staging" region="us-central1"  # full live environment
hv_inspect provider="cloudsql" resource="database" limit=25  # bounded Cloud SQL instance inventory

# Recover an abandoned host from a migration that predates retained bindings.
hv_inspect provider="cloudrun" project="my-app" env="production" region="us-central1"
hv_import provider="cloudrun" mode="retained-cleanup" project="my-app" env="production" region="us-central1" confirm=true
hv_import provider="cloudsql" mode="retained-database-cleanup" project="my-app" env="production" id="exact-instance-id" confirm=true
hv_import provider="memorystore" mode="retained-cache-cleanup" project="my-app" env="production" id="exact-cache-id" confirm=true

# Discover and safely remove billable remnants left after their owning runtime was deleted.
hv_inspect provider="cloudsql" project="my-app" resource="backup" limit=25
hv_import provider="cloudsql" mode="retained-resource-cleanup" resource="backup" project="my-app" env="production" id="projects/gcp-project/backups/exact-backup-id" confirm=true
hv_inspect provider="cloudrun" project="my-app" resource="artifact" limit=25  # all Artifact Registry locations
hv_import provider="cloudrun" mode="retained-resource-cleanup" resource="artifact" project="my-app" env="production" id="projects/gcp-project/locations/us-central1/repositories/exact-repository" confirm=true
hv_plan project="my-app" env="production" scope="retained-cleanup"  # review exact confirm-gated cleanup actions
```

For `hv_inspect`, any bounded selector requires `provider`; `project` plus `env` never replaces it. Parameterless discovery reports every resource mode's selector contract and whether it accepts `limit`. Every database, cache, and storage lifecycle provider is required at registration time to expose bounded exact-id/name inventory with durable provider scope. Selecting a non-current hosting provider runs read-only provider-scoped environment forensics and never passes the current provider's binding to that adapter. The retained cleanup import modes only record complete inspected identities locally; they do not delete anything until a later isolated plan is explicitly confirmed. For hosting-variable mode, `hv_secrets` requires an explicit `env` and does not infer staging from `project` alone.

- Full generated MCP/CLI catalog: `docs/TOOLS.md`
- Regenerate after tool changes: `npm run build && npm run docs:tools`

### Database diagnostics

`hv_db_query` can diagnose managed Postgres without asking you to expose it permanently. Railway uses a temporary TCP proxy, Cloud SQL uses a local authenticated connector, and an ECS-hosted RDS instance gets a separately labelled temporary `/32` security-group rule for the Hypervibe caller in addition to its workload-group-only runtime rule. Supabase normally uses its existing direct endpoint, so no temporary provider resource is needed. Hypervibe releases only access it created; concurrent queries share the same short-lived lease, and every response reports the access mode and cleanup status without returning database credentials or endpoints.

Diagnostic reads run in a PostgreSQL read-only transaction with a 30-second statement timeout. Results are capped at 500 rows and 512 KiB. Mutations still require `allowMutations=true`, and multi-statement SQL remains blocked.

### Managed database runtime variables

PostgreSQL services receive the canonical managed variables `DATABASE_URL` and
`DIRECT_URL`. Applications with a legacy name can declare a per-service alias;
Hypervibe resolves it inside plan/apply and never writes the database value to
the spec:

```json
{
  "services": {
    "events-worker": {
      "workloadKind": "worker",
      "startCommand": "npm run events:worker",
      "public": false,
      "databaseEnvAliases": {
        "POSTGRES_DB_URL": "DATABASE_URL"
      }
    }
  },
  "database": {
    "provider": "rds",
    "engine": "postgres"
  }
}
```

`hv_plan` and `hv_status` expose the key-only contract and verify that each
declared alias is attached to its target service. `inSync` describes
configuration convergence; `runtimeHealth` remains unverified until HTTP
health or worker log/error evidence is checked.

### Declarative SendGrid email

Email sender identity, inbound parsing, delivery events, and mailbox forwarding
belong in the environment spec. One environment may declare one default sender,
one SendGrid Inbound Parse route, and the account-level delivery-event webhook:

```json
{
  "domain": "example.com",
  "services": {
    "api": { "workloadKind": "web", "public": true }
  },
  "email": {
    "enabled": true,
    "sender": {
      "address": "hello@example.com",
      "name": "Example",
      "replyTo": "support@example.com"
    },
    "inbound": {
      "hostname": "inbound.example.com",
      "service": "api",
      "path": "/webhooks/sendgrid/inbound",
      "aliases": ["support", "replies"],
      "spamCheck": true,
      "sendRaw": false
    },
    "deliveryEvents": {
      "service": "api",
      "path": "/webhooks/sendgrid/events",
      "events": ["processed", "delivered", "bounce", "dropped"]
    },
    "forwarding": {
      "aliases": {
        "support": "owner@example.net",
        "billing": "owner@example.net"
      },
      "catchAll": { "action": "drop" }
    }
  }
}
```

`hv_plan` separates runtime-key projection, SendGrid sender/domain
authorization, Cloudflare DNS, inbound-parse creation, delivery events,
forwarding destination verification, aliases, catch-all routing, and domain
validation into reviewable actions. `hv_apply` installs `SENDGRID_API_KEY` plus the
declared sender defaults on each service; the inbound target also receives
`SENDGRID_INBOUND_HOSTNAME` and a JSON `SENDGRID_INBOUND_ALIASES` value.

SendGrid routes inbound parsing by hostname, not local-part alias. The target
service reads the recipient from the parsed request and dispatches aliases such
as `support@inbound.example.com` itself. Domain authentication authorizes sender
addresses under `domain`; without a domain, a declared sender uses SendGrid's
single-sender verification flow and apply remains pending until its verification
email is accepted. Cloudflare destination creation returns pending until the
destination mailbox accepts its verification email; forwarding rules run only
afterward. Because SendGrid exposes one delivery-event webhook per account, the
project spec may declare `deliveryEvents` in only one environment.

#### SendGrid-backed CI email journeys

A staging application can use the same inbound-email lifecycle as a CI test
inbox without a separate mailbox service. Give the CI traffic its own inbound
hostname and leave `aliases` empty because per-run recipient local parts are
temporary application state, not durable provider configuration:

```json
{
  "domain": "staging.example.com",
  "services": {
    "api": { "workloadKind": "web", "public": true }
  },
  "email": {
    "enabled": true,
    "sender": {
      "address": "canary@staging.example.com",
      "name": "Example Canary"
    },
    "inbound": {
      "hostname": "ci-mail.staging.example.com",
      "service": "api",
      "path": "/api/webhooks/canary-email-receipts",
      "aliases": [],
      "spamCheck": true,
      "sendRaw": false
    }
  }
}
```

Hypervibe owns the SendGrid authorization and Inbound Parse route, Cloudflare
MX record, and hosting runtime projection. The application owns the test-inbox
behavior: it can issue a short-lived recipient from a protected endpoint or let
CI derive one from an application canary secret, the webhook accepts only valid
recipients and stores the minimum verification result, and a protected polling
endpoint returns that result to CI. The CI job may need that application canary
credential and the non-secret inbound hostname, but it never needs the SendGrid
API key.

An unguessable recipient is staging isolation, not proof that SendGrid sent the
request. Apply strict request-size limits, short recipient expiry, and
capability-aware rate limits rather than one small shared provider-IP bucket.
SendGrid stops retrying only after a `2xx` response, so permanently invalid or
over-limit payloads should be acknowledged and discarded; reserve `5xx` for
transient failures that can succeed on retry.
Applications that require provider-origin authentication must verify SendGrid's
signed multipart request without changing its raw bytes, or put SendGrid OAuth
in front of the webhook. Signature keys, OAuth tokens, message storage, and
receipt APIs remain application-owned; Hypervibe does not currently provision
or rotate those credentials.

### Declarative Twilio messaging

Twilio support deliberately covers the shared setup most applications need: a
Messaging Service, optional inbound-message and delivery-status callbacks, the
runtime credentials, and optional attachment of an existing phone number.

Collect these values from the same Twilio account or subaccount:

| Hypervibe field | Twilio value | Where to find it |
| --- | --- | --- |
| `accountSid` | `AC...` Account SID | [Console Dashboard](https://console.twilio.com/) -> Account Info |
| `apiKeySid` | `SK...` Restricted API Key SID | [Settings -> Account settings -> API keys & auth tokens](https://console.twilio.com/us1/account/keys-credentials/api-keys) |
| `apiKeySecret` | API Key Secret | Shown once when that key is created; copy it immediately |
| `authToken` | Primary Account Auth Token | Console Dashboard -> Account Info -> Show, or the Auth Tokens section of API keys & auth tokens |
| `messaging.sender.phoneNumberSid` | Optional existing `PN...` Phone Number SID | [Numbers & Senders -> Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming); open the SMS-capable number and copy its SID, not its `+...` phone number |

Do not look for an `MG...` SID before setup. The spec declares a friendly
`service.name`; Hypervibe creates or explicitly adopts that Messaging Service,
records its `MG...` SID, and projects `TWILIO_MESSAGING_SERVICE_SID` during
apply.

```json
{
  "services": {
    "api": { "workloadKind": "web", "public": true }
  },
  "messaging": {
    "provider": "twilio",
    "services": ["api"],
    "service": {
      "name": "example-production",
      "inbound": {
        "service": "api",
        "path": "/webhooks/twilio/messages"
      },
      "deliveryStatus": {
        "service": "api",
        "path": "/webhooks/twilio/status"
      }
    },
    "sender": {
      "phoneNumberSid": "PN0123456789abcdef0123456789abcdef"
    }
  }
}
```

Create a Restricted API key with these exact Twilio permissions:

```text
twilio/messaging/services/list
twilio/messaging/services/read
twilio/messaging/services/create
twilio/messaging/services/update
twilio/messaging/services.phonenumbers/list
twilio/messaging/services.phonenumbers/create
twilio/messaging/services.phonenumbers/delete
twilio/messaging/messages/create
```

Keep the four connection values in a local, gitignored env file:

```dotenv
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SID=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SECRET=replace-with-the-one-time-secret
TWILIO_AUTH_TOKEN=replace-with-the-primary-auth-token
```

Connect that file by reference:

```text
hv_connections provider="twilio" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"accountSid":"TWILIO_ACCOUNT_SID","apiKeySid":"TWILIO_API_KEY_SID","apiKeySecret":"TWILIO_API_KEY_SECRET","authToken":"TWILIO_AUTH_TOKEN"}
```

`hv_plan` reviews Messaging Service creation/adoption, sender attachment, and
runtime projection separately. `hv_apply` derives webhook URLs from the target
service's public binding and projects the Twilio values only to
`messaging.services`. Moving a number from another sender pool requires exact
action confirmation. Hypervibe does not buy numbers or manage Voice, Verify,
WhatsApp, A2P registration, campaigns, or application message sending.
Complete any A2P 10DLC, toll-free verification, or other regulatory setup in
Twilio before production sending. The primary Auth Token is still required even
when API calls use a restricted key because Twilio uses the account token to
sign inbound and delivery-status webhooks.

## Team-Shared Desired State

Hypervibe treats infrastructure as a repo-backed definition, not as one user's private local state. When run from a git worktree, `hv_spec` writes the desired infrastructure shape to:

```text
.hypervibe/spec.json
```

Commit that file with the app. It is the shared source of truth for environments, services, cron jobs, databases, caches, delegated secret ownership, domains, email, messaging, env vars, deploy strategy, and migrations. When a teammate clones the repo and runs `hv_spec`, `hv_plan`, or `hv_status`, Hypervibe reads this file, creates a local project cache if needed, and reports any missing provider connections before apply. The local `project_specs` table is a revision journal behind this file: if `spec.json` is edited outside Hypervibe (or pulled with new changes), the next read adopts it as a new revision and says so in a warning.

Hypervibe also maintains non-secret provider identity bindings in:

```text
.hypervibe/bindings.json
```

This file lets teammates observe and converge the same provider resources instead of planning duplicate projects/services. It is for non-secret IDs such as provider project IDs, environment IDs, service IDs, custom domain bindings, and CI workflow sync metadata. Credentials, tokens, passwords, database URLs, and secret values stay out of the repo and remain local/provider-side.

No Hypervibe user role is required. The current chat task determines which
access is needed:

- anyone with the checkout can read the committed desired topology;
- public service URLs in committed bindings can be checked without a hosting
  provider account;
- exact provider drift, private logs, plans, and applies require a verified
  provider connection on the machine doing that work.

When a collaborator lacks that connection, Hypervibe should offer two paths:
connect credentials they already control, or prepare a value-free handoff
naming the provider, scope, environment, and blocked task for the
infrastructure owner. It should not assume that every coder belongs in each
hosting, data, DNS, or integration provider account. This stays local and repo-backed; it
does not require a new Hypervibe web service or shared drift database.

### Delegated secrets

Use a delegated secret slot when a collaborator, customer, or app owner should
supply and rotate a runtime or GitHub Actions credential without giving it to
the repository owner. The spec records the name, responsible principal, and
provider destinations, but never the value:

```json
{
  "secrets": {
    "ANTHROPIC_API_KEY": {
      "ownership": "delegated",
      "principal": "github:alice",
      "environments": ["production"],
      "githubActions": { "repository": true },
      "required": true,
      "driftPolicy": "preserve"
    }
  }
}
```

The principal is a non-secret ownership label, not an authenticated Hypervibe
identity. Provider credentials remain the enforcement boundary, but Alice does
not need provider membership merely to own the API key. She can send the key
to the infrastructure owner through an agreed out-of-band channel; the owner
stores it in a local safe reference such as 1Password, a private env file, or
another supported manager and runs the plan/apply. A shared secret-manager
item is the natural repeatable handoff when both people already use one. Give
Alice narrowly scoped provider membership and have her connect her own
credentials only if she needs to apply independently. Changing `principal` or
a collaborator list in a checkout does not grant a provider role. Without a
hosted control plane, Hypervibe cannot prove that the person supplying a key is
`github:alice`; do not auto-apply unreviewed spec changes with an owner/admin
credential.

For Anthropic, Alice creates a standard workspace-scoped API key at [Claude Platform API keys](https://platform.claude.com/settings/keys). Claude subscription billing and Claude API billing are separate, so the Platform account/workspace must have API billing configured. She saves the value locally, outside the repository:

```text
# /Users/alice/.config/hypervibe/friend-app.env
ANTHROPIC_API_KEY=...
```

If Alice will apply independently, she connects only the provider credentials
she already controls. `hv_plan` reports the exact credential type, official
setup URL, permissions, and resource scope for every required connection; she
stores each value outside the repository and passes only a safe local
reference:

```text
hv_connections provider="<required-provider>" credentialsRef="dotenv:/Users/alice/.config/hypervibe/provider.env#PROVIDER_TOKEN"
```

Then she creates and applies a plan without sending either token through chat:

```text
hv_plan project="friend-app" env="production" secretRefs={"ANTHROPIC_API_KEY":"dotenv:/Users/alice/.config/hypervibe/friend-app.env#ANTHROPIC_API_KEY"}
hv_apply project="friend-app" planId="<planId>"
```

The value is resolved on Alice's machine, encrypted into that specific plan, injected into every service in the target environment, and never returned by a tool. Hypervibe records only the principal, a SHA-256 value hash, timestamp, and apply receipt in `.hypervibe/bindings.json`. Ordinary `envVars` and `.env` loading cannot overwrite a delegated key. Missing values, out-of-band drift, or a changed principal produce an inspectable but non-executable plan that preserves the live value until a new explicit `secretRefs` input is supplied.

If a machine or local Hypervibe database is lost, recloning the committed `.hypervibe/spec.json` and `.hypervibe/bindings.json` restores the desired shape and accepted hashes. Provider connections must be reconnected and in-flight plans must be recreated; no runtime secret value is recoverable from the repo.

### Deploy env from `.env`

When `.env.<environment>` or repo `.env` exists, `hv_plan` considers it as a local deploy input. Environment-specific files such as `.env.production` and `.env.staging` win over `.env`. Hypervibe does **not** blindly publish every key. The default policy is `envFile.mode: "runtime"`: Hypervibe syncs high-confidence app runtime keys such as `SENDGRID_API_KEY`, `SESSION_SECRET`, `*_URL`, `*_TOKEN`, `*_SECRET`, `APP_*`, `VITE_*`, and similar names; it skips provider/control-plane credentials such as `RAILWAY_API_TOKEN`, `GITHUB_TOKEN`, and `CLOUDFLARE_API_TOKEN`; it skips local-looking runtime values such as `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, `.local`, and `.internal`; and it reports ignored key names in the plan.

Every repo-backed spec write also creates or non-destructively extends `.env.example` with `RECAPTCHA_SITE_KEY=` and `RECAPTCHA_SECRET_KEY=`. Hypervibe does not connect to reCAPTCHA or validate/store those values. Put the real environment-specific values in `.env.staging`, `.env.production`, or another selected env file; `hv_plan` encrypts them into the persisted plan and `hv_apply` performs the hosting sync. The site key is public, while the secret key must remain server-side.

Tune this per environment in `.hypervibe/spec.json`:

```json
{
  "envFile": {
    "mode": "explicit",
    "include": ["SENDGRID_API_KEY", "CUSTOM_WORKER_FLAG"],
    "exclude": ["LOCAL_DEBUG_FLAG"]
  }
}
```

Modes are `runtime` (default), `all`, `explicit`, and `off`. Values loaded from the env file are encrypted into the plan and never printed. The plan warning names the env file path and selected keys so the agent can show the user exactly what source is being applied. Generated infrastructure values such as `DATABASE_URL` still win over stale local `.env` values.

### Stripe environments and hosting env sync

Use a separate scoped Stripe connection for each named Stripe sandbox and for
production. The connection scope is the stable mapping between a Hypervibe
environment and Stripe; it defaults to the Hypervibe environment name.

For an existing Stripe dotenv file:

```text
hv_connections provider="stripe" scope="staging" credentialsRef="dotenv:/absolute/path/.env.stripe-sync.staging" credentialsMap={"secretKey":"STRIPE_SECRET_KEY"}
```

If the file also contains a publishable key:

```text
hv_connections provider="stripe" scope="staging" credentialsRef="dotenv:/absolute/path/.env.stripe-sync.staging" credentialsMap={"secretKey":"STRIPE_SECRET_KEY","publishableKey":"STRIPE_PUBLISHABLE_KEY"}
```

Repeat with `scope="development"` for a development sandbox and
`scope="production"` for Stripe live mode. Sandbox keys begin with `sk_test_`
or `rk_test_` and `pk_test_`; production server keys begin with `sk_live_` or
`rk_live_`. Restricted `rk_` keys are preferred and are accepted in the
`secretKey` connection field. Open the intended sandbox before revealing its
API keys because each Stripe sandbox has its own isolated key pair and objects.
See [Stripe sandbox management](https://docs.stripe.com/sandboxes/dashboard/manage)
and [sandbox API-key access](https://docs.stripe.com/sandboxes/dashboard/manage-access).

#### Fast fresh development sandboxes

Stripe sandbox creation itself is a short Dashboard step because an ordinary
sandbox API key cannot create another sandbox or its keys. Everything after
that stays in Hypervibe's desired-state loop:

1. In Stripe's account picker choose **Switch to sandbox → Create sandbox**.
   Name it for the project or workflow and open it. Copy a restricted `rk_test_`
   key (or an unrestricted `sk_test_` key) and the optional `pk_test_` key into
   a gitignored `.env.stripe.development`.
2. Connect that exact sandbox:

   ```text
   hv_connections provider="stripe" scope="development" credentialsRef="dotenv:/absolute/path/.env.stripe.development" credentialsMap={"secretKey":"STRIPE_SECRET_KEY","publishableKey":"STRIPE_PUBLISHABLE_KEY"}
   ```

3. Declare `payments.stripe.environment: "development"`, catalog prices,
   runtime credential projection, and webhooks; run `hv_plan` and `hv_apply`,
   then verify the managed CI release with `hv_ci_status` and `hv_health`.
4. In the following desired-state revision, add a versioned application seed
   such as `npm run db:seed:personas -- --dataset=invoice-perfect-v1`. The seed
   owns paired application rows and Stripe test customers/subscriptions;
   Hypervibe owns only their prerequisites and execution receipt.

For a clean reset, create another named sandbox, replace the two local dotenv
values, and run the same scoped `hv_connections` call. `hv_plan` then reviews
recreation of products, prices, environment projection, and webhooks against
the empty target. The old sandbox is untouched and can be deleted in Stripe
after the replacement and fixtures are verified.

Application seeds must use stored provider IDs and deterministic Stripe
metadata as durable fixture identity. Stripe idempotency keys protect immediate
retries but expire; they do not replace reconciliation. Keep baseline personas
stable. Add test-clock personas later as disposable fixtures because deleting a
test clock also deletes its associated Stripe test objects.

Then declare the Stripe catalog Hypervibe owns and which hosting services
receive its runtime values. Products and recurring prices are lifecycle
resources: `hv_plan` observes them, proposes explicit create/update/adopt/
replace/archive actions, and `hv_apply` records durable provider IDs:

```json
{
  "payments": {
    "stripe": {
      "environment": "staging",
      "services": ["web", "cron"],
      "credentials": {
        "secretKeyEnvVar": "STRIPE_SECRET_KEY",
        "publishableKeyEnvVar": "STRIPE_PUBLISHABLE_KEY"
      },
      "catalog": {
        "products": {
          "starter": {
            "name": "Starter",
            "description": "Starter subscription",
            "prices": {
              "monthly": {
                "unitAmount": 1900,
                "currency": "usd",
                "interval": "month",
                "envVar": "STRIPE_STARTER_MONTHLY_PRICE_ID"
              },
              "yearly": {
                "unitAmount": 19000,
                "currency": "usd",
                "interval": "year",
                "envVar": "STRIPE_STARTER_YEARLY_PRICE_ID"
              }
            }
          },
          "pro": {
            "name": "Pro",
            "prices": {
              "monthly": {
                "unitAmount": 4900,
                "currency": "usd",
                "interval": "month",
                "envVar": "STRIPE_PRO_MONTHLY_PRICE_ID"
              }
            }
          }
        }
      }
    }
  }
}
```

Unbound products and prices with exactly matching identity/configuration are
offered as confirm-gated adoption actions. Multiple candidates block rather
than choosing one. Recurring price amount, currency, and interval are
immutable in Stripe; changing one creates a replacement, updates hosting
variables, and only then offers a confirm-gated archive of the previous price.
Removing a managed price or product likewise removes its hosting projection
before archiving it. Unmanaged Stripe objects are untouched.

`hv_plan` reads Stripe and hosting state, but persists only provider identities,
managed key names, and hashes—not credentials or webhook signing values.
`hv_apply` resolves the encrypted Stripe connection again and writes runtime
values through the hosting adapter. With CI-triggered branch deploys, the
adapter preserves the approved exact-SHA workflow as the next code-release
boundary instead of turning a configuration sync into an unrelated source
release. Stripe-managed keys
cannot also be supplied through `envVars`, `.env` includes, delegated secrets,
one-off overrides, or `removeEnvVars`.

Declare webhook endpoints in the same desired-state section instead of calling
an imperative setup command:

```json
{
  "payments": {
    "stripe": {
      "environment": "staging",
      "webhooks": {
        "billing": {
          "url": "https://billing.example.com/api/webhooks/stripe",
          "service": "web",
          "envVar": "STRIPE_WEBHOOK_SECRET",
          "events": [
            "checkout.session.completed",
            "customer.subscription.updated",
            "customer.subscription.deleted",
            "invoice.paid",
            "invoice.payment_failed"
          ]
        }
      }
    }
  }
}
```

`envVar` defaults to `STRIPE_WEBHOOK_SECRET`, and `events` defaults to the
common SaaS event set when omitted. `hv_plan` observes endpoint identity and
hosting value hashes. A single existing endpoint with the declared URL and an
observed hosting value becomes an explicit confirm-gated adoption action;
multiple matches are blocked. Creation syncs Stripe's creation-only signing
value to the named service and stores only the endpoint id plus a one-way hash.
Replacement/rotation and deletion are also confirm-gated. If hosting sync
fails, apply rolls the new endpoint back and verifies its absence; an
unverifiable rollback records the endpoint id so a later plan cannot create a
duplicate.

### Gated iOS releases in GitHub Actions

Keep App Store identity, capabilities, TestFlight groups, and the release
workflow in each environment's desired state. The server and iOS code may live
in the same repository (the v1 workflow is monorepo-first), while release
evidence records mobile and server repository/SHA fields separately:

```json
{
  "hosting": { "provider": "cloudrun" },
  "services": { "api": {} },
  "deploy": {
    "strategy": "branch",
    "trigger": "ci",
    "branch": "main"
  },
  "ios": {
    "bundleId": "com.example.app",
    "capabilities": ["PUSH_NOTIFICATIONS"],
    "testflight": {
      "groups": {
        "Internal": {
          "internal": true,
          "testers": ["developer@example.com"]
        }
      }
    },
    "release": {
      "services": ["api"],
      "trigger": "after-server-deploy",
      "build": {
        "workingDirectory": "apps/ios",
        "command": "bundle exec fastlane build",
        "ipaPath": "build/Example.ipa",
        "requiredSecrets": ["SENTRY_AUTH_TOKEN"]
      },
      "signing": {
        "provider": "match",
        "gitBranch": "main"
      },
      "testflight": {
        "groups": ["Internal"],
        "usesNonExemptEncryption": false,
        "submitForBetaReview": false
      }
    }
  }
}
```

`hv_plan`/`hv_apply` reconcile the bundle ID, capabilities, beta groups,
server deploy workflow, iOS release workflow, and its App Store Connect
environment secrets. With `signing.provider: "match"`, the matching GitHub
environment must already contain `MATCH_GIT_URL`, `MATCH_PASSWORD`, and
`MATCH_GIT_BASIC_AUTHORIZATION`. Hypervibe observes those names and scopes the
values to read-only signing preparation; they never enter Hypervibe state or
the project build step. `build.requiredSecrets` is only for additional secrets
needed by the app-defined build command.

The server workflow uploads signed release evidence only after provider deploy
success. The macOS iOS workflow shares the server deploy concurrency group,
downloads that evidence, and requires the same repository and full Git SHA.
Its build job checks out that exact commit, installs existing Match assets into
an ephemeral keychain, runs the project build, validates the IPA, and uploads a
short-lived artifact. A fresh release job revalidates the artifact and server
evidence before running Hypervibe's embedded Apple upload, processing,
compliance, declared-group distribution, optional beta-review, and
release-manifest runtime. App Store credentials never enter the project build
job, and the release job never checks out or executes project code.

Use `signing.provider: "project"` when a project intentionally owns its signing
implementation. Versioned App Store metadata/screenshots and local device builds
remain project files; neither becomes an imperative Hypervibe command.

The iOS artifact records separate mobile and server provenance. Inspect these
workflows through `hv_ci_status`; final `hv_appstore_submit` also refuses
submission unless the latest successful server and iOS workflow runs have the
same SHA.

### Retiring or renaming runtime variables

Omitting a key from `envVars`, an env file, or a local secret input means
**preserve the provider value**. Hypervibe never treats a partial desired map
as permission to delete live variables.

Delete a retired key only through the environment's explicit tombstone list:

```json
{
  "envVars": {
    "NEW_FEATURE_FLAG": "enabled"
  },
  "removeEnvVars": ["OLD_FEATURE_FLAG"]
}
```

`hv_plan` emits one `service:<name>:env-remove` action per affected service.
The action shows key names but no values, and `hv_apply` skips it unless that
exact action ID is passed in `confirmActions`. GCP Cloud Run and Railway both
support these explicit removals. Hypervibe-managed database, queue, storage,
delegated-secret, and source-integration keys cannot be tombstoned; change or
remove the owning resource instead.

Renames require two releases:

1. Add the replacement key while keeping the old key. Deploy code that accepts
   the replacement and temporarily falls back to the old key, then verify it in
   staging and production.
2. In a later spec change, stop supplying the old key and add it to
   `removeEnvVars`. Review and explicitly confirm the removal action.

Hypervibe rejects a removal plan while any service configuration is still
drifting. This prevents a same-release `SOME_TOKEN` to `ANOTHER_TOKEN` change
from removing the old value before compatible code is running. A confirmed
removal may reconcile or redeploy the provider's already-compatible current
image, so do not collapse these two releases into one.

### Environment data migration

To promote real data from one environment into another, declare a one-use
`dataMigration` on the target rather than renaming environments or running a
provider CLI:

```json
{
  "dataMigration": {
    "id": "initial-production-launch",
    "fromEnvironment": "staging",
    "include": { "database": true, "storage": ["documents"] }
  }
}
```

Hypervibe isolates the confirmed copy stage, restores into fresh unreachable
targets, verifies non-secret database/storage manifests, and records the new
bindings only after success. Re-run plan/apply to cut services over, verify the
production release, then re-plan to review deletion of retained rollback
targets. See [the full migration workflow](docs/data-migration.md).

The copy is authorized only while both source and target declare
`"maintenance": { "enabled": true }` and Hypervibe freshly verifies the full
boundary: a Cloudflare-owned static 503 marker, every hosting workload stopped,
and PostgreSQL defaulting new sessions to read-only. Azure Container Apps, GCP
Cloud Run, DigitalOcean App Platform, Railway, and Vercel implement reversible
workload maintenance. AWS ECS Express currently fails closed before the copy.
DigitalOcean's exact-app archive/restore path and Vercel's exact-ID pause/unpause
path are implemented and remain behind their opt-in live maintenance promotion
gates.
No application maintenance flag, email dry-run switch, or AI dry-run switch is
introduced.

### Database resilience and restore drills

Cloud SQL can manage regional availability, backup/PITR retention, named read
replicas, and a scheduled isolated restore drill through normal desired state:

```json
{
  "github": { "canonicalEnvironment": "production" },
  "environments": {
    "production": {
      "hosting": { "provider": "cloudrun" },
      "services": { "web": {} },
      "database": {
        "provider": "cloudsql",
        "resilience": {
          "availability": "regional",
          "backups": { "retainedBackups": 8, "pitrRetentionDays": 7 },
          "replicas": { "analytics": { "region": "us-west1" } },
          "restoreDrill": {
            "schedule": { "cron": "30 4 * * 1", "timezone": "America/Vancouver" },
            "credentialsSecret": "HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS",
            "verificationQuery": "SELECT count(*) FROM users",
            "restoreLagMinutes": 10,
            "retainFailedInstanceDays": 3
          }
        }
      }
    }
  }
}
```

The first restore-drill slice supports one GitHub canonical environment per
repository. It generates a reviewed scheduled workflow that clones the exact
bound primary at the declared point in time, runs the SQL check in a read-only
transaction, and deletes the successful clone only after confirming its
ownership labels. Failed labeled clones remain briefly for inspection and are
collected by a later run. Application database bindings never change.

Use a dedicated GCP service-account JSON key, created or reviewed at
`https://console.cloud.google.com/iam-admin/serviceaccounts`, and store it in
the repository Actions secret named by `credentialsSecret`. Scope it to the
single GCP project containing the source instance. The recommended custom role
contains only:

```text
cloudsql.instances.clone
cloudsql.instances.connect
cloudsql.instances.delete
cloudsql.instances.get
cloudsql.instances.list
cloudsql.instances.update
cloudsql.users.update
```

`roles/cloudsql.admin` also works but is broader than the drill needs.
Cloud SQL Admin API must be enabled. The connector still needs a network path;
this V1 workflow targets Hypervibe-provisioned Cloud SQL instances with public
IP connectivity. Declare a value-free GitHub Actions destination in
`spec.secrets`, then supply the local file only to the plan:

```json
{
  "secrets": {
    "HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS": {
      "principal": "github:infrastructure-owner",
      "githubActions": { "repository": true }
    }
  }
}
```

```text
hv_plan project="example" env="production" secretRefs={"HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS":"file:/absolute/path/cloudsql-drill-service-account.json"}
```

`hv_plan` blocks while the secret name cannot be observed. Once present, the
GitHub infrastructure action is billable and confirmation-gated because each
scheduled run creates a temporary Cloud SQL instance. After the generated PR
is merged, use `hv_ci_status` to inspect `Hypervibe / db-restore-drill-production`
runs and their bounded logs.

### Database data operations

Do not temporarily change a service `releaseCommand` just to seed or import production data. Application containers should converge schema during startup. When startup migration is not appropriate, a release command is durable desired deploy configuration for repeatable schema work, such as `migrations: { "mode": "releaseCommand", "command": "npm run db:migrate" }`.

For fresh environments, declare seed/bootstrap data on the database. This is provider-neutral desired state; it works through the normal plan/apply flow for any supported hosting/database target:

```json
{
  "database": {
    "provider": "supabase",
    "engine": "postgres",
    "seedCommand": "npm run db:seed"
  }
}
```

`hv_plan` emits a visible one-shot database seed action. `hv_apply` runs it after the database exists as a one-off command inside the deployed service environment, then records the command hash plus `seededAt` on the database component. The command does not run again unless the command changes.

When the same CI-owned plan introduces Stripe runtime variables or creates a
webhook signing secret, Hypervibe converges those resources and unlocks the
reviewed release first, then reports the seed as pending. After that release is
healthy, re-run `hv_plan`/`hv_apply`; the unchanged seed command remains planned
and runs against the newly deployed image. This keeps webhook-producing fixture
creation on the application side without racing the Stripe/application boundary.

Hypervibe does not expose an imperative database migration command. Schema
migrations belong in application startup or durable declared release
configuration. Provider-to-provider data moves and database resets must be
modeled as explicit desired-state lifecycle actions before Hypervibe supports
them; they cannot bypass `hv_plan`/`hv_apply`. Re-seeding likewise requires a
reviewable desired-state change rather than a generic command runner.

### Managed load balancing

The first load-balancer slice uses Cloudflare in front of two or more
equivalent public web services. The environment `domain` is the public
hostname; each origin continues to use its provider-issued HTTPS URL and host
header. Origins must resolve to distinct public DNS hosts; local/private hosts,
IP literals, embedded credentials, paths, nonstandard ports, and duplicate
addresses block before any load-balancer mutation. Declare it through the
normal desired-state loop:

```json
{
  "domain": "app.example.com",
  "services": {
    "web-a": { "workloadKind": "web", "public": true },
    "web-b": { "workloadKind": "web", "public": true }
  },
  "loadBalancer": {
    "provider": "cloudflare",
    "services": ["web-a", "web-b"],
    "healthCheckPath": "/health"
  }
}
```

`hv_plan` observes and reconciles three explicit resources: an HTTPS health
monitor, an equal-weight random origin pool, and the zone hostname load
balancer. Pool/topology changes and initial hostname creation are marked
billable. Removing the block plans confirmed deletion of public routing before
the pool and monitor are removed. Same-name resources without durable bindings
are never adopted implicitly; adopting existing Cloudflare load-balancer
resources is outside V1, so those conflicts block until removed or renamed.
ECS Express's ALB remains provider-internal hosting ingress, not a generic
cross-origin edge load balancer; adding a second AWS-facing abstraction here
would duplicate ownership and weaken the action boundary.

Typical team flow:

1. One person changes infrastructure through Hypervibe, such as adding a cron service.
2. Hypervibe updates `.hypervibe/spec.json` and, after apply, `.hypervibe/bindings.json`.
3. They commit those files.
4. Teammates pull, run `hv_plan`, and see the same desired shape and provider bindings.
5. Each teammate connects their own provider credentials locally with `hv_connections` when needed.

## Provider Credentials

### Cloudflare token permissions

Recommended default for DNS, custom domains, and email routing: use a **Cloudflare Account API Token** plus `accountId`. Cloudflare recommends Account API Tokens for automation credentials that are not associated with a specific user.

Create it from the
[pre-filled Hypervibe Account API Token template](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=Hypervibe%20DNS%20and%20domains).
The link preselects Zone Read, Zone Settings Read, DNS Edit, and Account
Settings Read. Choose the target account and narrow the zone resources before
creating the token.

Set these permissions and resources:

```text
Permissions:
- Zone -> Zone -> Read
- Zone -> Zone Settings -> Read or Edit
- Zone -> DNS -> Edit
- Load Balancers Read and Load Balancers Write on the target zone (for `loadBalancer`)
- Load Balancing: Monitors and Pools Read and Write on the owning account (for `loadBalancer`)
- Zone -> Email Routing Rules -> Edit (for `email.forwarding`)
- Account -> Email Routing Addresses -> Edit (to create/verify forwarding destinations)
- Account -> Account Settings -> Read (lets Hypervibe auto-resolve accountId)

Zone Resources:
- Include -> Specific zone -> example.com
```

Use the generated token secret itself as `CLOUDFLARE_API_TOKEN`; do not use the token name, token id, or legacy Global API Key. New User API Tokens usually start with `cfut_`; Account API Tokens usually start with `cfat_`.

Connect without pasting the token into chat. If the values are in an existing `.env` file, reference the keys directly instead of copying them to a temporary file:

```text
hv_connections provider=cloudflare scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}
```

If the repository already uses the official Stripe Projects plugin for this
Cloudflare service, select and pull the environment yourself once, then let
Hypervibe map only that service's fields from the existing local output:

```text
stripe projects env use production
stripe projects env --pull
hv_connections provider=cloudflare scope="example.com" credentialsRef="stripe-projects://production/cloudflare/workers" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_WORKERS_ACCOUNT_ID"}
```

Use the exact key names reported by
`stripe projects env --service cloudflare/workers`; Projects may namespace a
service field to avoid collisions. Hypervibe does not run either setup command,
refresh the cache, link providers, provision services, or rotate Stripe
Projects credentials. It checks the
active environment through redacted metadata, reads only the fields Stripe
Projects declares for `cloudflare/workers`, and snapshots them into the
encrypted Cloudflare connection. The output file must be inside the linked
repository, non-symlinked, and owner-only (`chmod 600`) on POSIX. After an
intentional Stripe Projects pull or rotation, rerun the same `hv_connections`
call to update Hypervibe's encrypted snapshot.

Hypervibe accepts either a raw token or a copied authorization value such as `Bearer <token>` for Cloudflare.

If Hypervibe needs Cloudflare Registrar/domain purchase, use a **User API Token** instead because Cloudflare Registrar is not compatible with Account API Tokens. Create it under `My Profile -> API Tokens -> Create Token -> Edit zone DNS`, add the same zone permissions above, and connect it without `accountId`:

[Open the pre-filled Hypervibe User API Token template](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=Hypervibe%20DNS%20and%20domains),
narrow its account and zone selectors, and add Registrar write before creating
it. Cloudflare's documented template keys cover Hypervibe's base DNS
permissions but not the optional Registrar, Email Routing, or Load Balancing
permissions, so add only the optional capabilities the spec uses.

```text
hv_connections provider=cloudflare scope="example.com" credentialsRef="dotenv:/absolute/path/.env#CLOUDFLARE_API_TOKEN"
```

If the token is valid but Hypervibe cannot confirm zone access during `hv_connections`, the connection is still saved and verified with a warning; `hv_plan`/`hv_apply` will surface any remaining DNS or registrar-specific blockers.

### GitHub token permissions

For the current desired-state GitHub model—including generic checks, autofix,
pull-request review, code audit, dependency/security controls, declarative
GitHub Pages with custom-domain DNS, exact token permissions, and the
infrastructure PR flow—see
[GitHub infrastructure for beginners](docs/github-infrastructure.md).

Recommended for a one-token setup: create a classic PAT with `repo`,
`workflow`, and `read:packages` from the
[pre-filled combined-token link](https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys),
then export it under npm's required variable name:

```bash
export NODE_AUTH_TOKEN=ghp_...
```

Then call `hv_connections provider=github credentialsRef="env:NODE_AUTH_TOKEN"`.
For existing `.env` files, use
`credentialsRef="dotenv:/absolute/path/.env#NODE_AUTH_TOKEN"`. For JSON
credentials, save the JSON to a local file and use
`credentialsRef="file:/absolute/path/to/credentials.json"`. If the user
intentionally wants to enter credentials in chat, `credentials={...}` is still
accepted.

For GitHub connections, `NODE_AUTH_TOKEN`, `HYPERVIBE_GITHUB_TOKEN`, and
`HYPERVIBE_GITHUB_PACKAGES_TOKEN` are aliases. An explicitly referenced
variable wins. If that variable is absent, Hypervibe accepts one distinct value
from either alias; if different fallback values exist, it blocks instead of
guessing. Prefer `NODE_AUTH_TOKEN` for the combined token because npm itself
does not know Hypervibe's aliases.

**Recommended for CI deploys: a classic PAT with `repo`, `workflow`, and `read:packages`**, created by a user with access to the target repositories. Create it from:

```text
https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys
```

That one token can be used for both:

- `apiToken`: GitHub API work such as writing `.github/workflows/*`, reading Actions runs/jobs/logs, triggering workflows, and creating repository secrets.
- `packageReadToken`: durable GHCR image-pull credentials for Railway image deploys.

For an existing `.env` file with one token:

```text
NODE_AUTH_TOKEN=ghp_...
```

Connect it like this:

```text
hv_connections provider=github scope="owner/repo" credentialsRef="dotenv:/absolute/path/.env#NODE_AUTH_TOKEN"
```

For split credentials, create the repository-management token from the
[pre-filled fine-grained link](https://github.com/settings/personal-access-tokens/new?name=Hypervibe%20repository&description=Manage%20one%20repository%20with%20Hypervibe&expires_in=90&actions=write&administration=write&contents=write&environments=write&issues=write&pull_requests=write&secrets=write&actions_variables=write&workflows=write) (or the
[pre-filled classic API link](https://github.com/settings/tokens/new?scopes=repo,workflow&description=Hypervibe%20GitHub%20API)), and create the classic package token
from the [pre-filled `read:packages` link](https://github.com/settings/tokens/new?scopes=read:packages&description=Hypervibe%20GHCR%20pull):

```text
HYPERVIBE_GITHUB_TOKEN=github_pat_...      # fine-grained repository permissions above
HYPERVIBE_GITHUB_PACKAGES_TOKEN=ghp_...    # scopes: read:packages
```

Then connect:

```text
hv_connections provider=github scope="owner/repo" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"HYPERVIBE_GITHUB_PACKAGES_TOKEN"}
```

A token with only `read:packages` is **not** enough for Hypervibe CI deploy setup. It can be used as `packageReadToken`, but the `apiToken` still needs `repo` + `workflow` for classic PATs so Hypervibe can manage workflows and repository secrets.

What hypervibe uses the GitHub token for, and the permission each operation needs:

| Operation | Classic PAT scope | Fine-grained permission |
|---|---|---|
| Propose managed CI/config files through the Hypervibe infrastructure PR | `repo` (+ `workflow` for files under `.github/workflows/`) | Contents: read/write, Pull requests: read/write, Workflows: read/write |
| List/trigger Actions workflows, read runs/jobs/logs (`hv_ci_status`, `hv_ci_trigger`) | `repo` | Actions: read/write |
| Reconcile declared Actions secrets (`spec.secrets.*.githubActions`) | `repo` | Secrets: read/write |
| Branch protection (`github.collaboration.pullRequests`) | `repo` + repo admin | Administration: read/write |
| Generated push deploys (`deploy.trigger: "ci"`) | `repo` + `workflow`; add Secrets read/write if Hypervibe should sync provider API tokens | Contents: read/write, Actions: read/write, Secrets: read/write, Environments: read/write |
| Manage the Railway GitHub App's repository access for `deploy.trigger: "native"` selected-repos installs | `repo` + repo admin — **classic PAT only**; GitHub's app-installation APIs do not accept fine-grained PATs | not supported |
| Private repo source fetch for Cloud Run builds | `repo` | Contents: read |

Fine-grained PATs can work for some GitHub API operations when granted the permissions in the table, but GitHub Packages/GHCR package authentication still requires a classic PAT. If you use a fine-grained PAT as `apiToken`, still provide a classic PAT with `read:packages` as `packageReadToken` for Railway GHCR deploys.

### GitLab CI (ready for live validation)

GitLab is selected through the canonical provider-neutral block, not a second
top-level vendor object:

```json
{
  "gitRemoteUrl": "https://gitlab.com/acme/storefront.git",
  "devops": {
    "code": {
      "provider": "gitlab",
      "scope": "https://gitlab.com/acme/storefront",
      "repository": { "state": "present", "management": "external" }
    },
    "ci": { "provider": "gitlab-ci" },
    "canonicalEnvironment": "production"
  }
}
```

The ready-for-live deploy path targets GitLab 18.1 or newer and renders the
same provider-neutral hosting recipes for Railway, Vercel, DigitalOcean App
Platform, Cloud Run, Azure Container Apps, and ECS Express. GitLab.com can use
the tagged hosted Linux runner. Self-managed GitLab uses an explicit
`devops.ci.runner` binding containing one numeric project-runner id, one manager
system id, a dedicated tag, and declared capabilities. Hypervibe proves that
the runner is locked, online, protected-ref-only, uncontested, and backed by
exactly one online linux/amd64 manager. GitLab does not expose executor type or
privileged-Docker mode through these APIs, so `docker-privileged` is an operator
attestation mirrored exactly in the runner maintenance note.

```json
"ci": {
  "provider": "gitlab-ci",
  "runner": {
    "mode": "self-managed",
    "runnerId": "123",
    "managerSystemId": "s_runner-host-1",
    "tag": "hypervibe-prod",
    "capabilities": ["linux-amd64", "docker-privileged"]
  }
}
```

Create an exact-project API token with `api` and Maintainer access (the
[GitLab.com pre-filled PAT link](https://gitlab.com/-/user_settings/personal_access_tokens?name=Hypervibe&description=Manage+GitLab+repository+and+CI+with+Hypervibe&scopes=api)). Explicit managed project creation/deletion instead requires a personal token whose user owns the exact parent group, or its own personal namespace. Railway additionally needs a project deploy token with `read_registry` for its durable private-image pull. Store credentials outside the repository:

```text
hv_connections provider="gitlab" scope="https://gitlab.com/acme/storefront" credentialsRef="file:/absolute/path/gitlab-connection.json"
```

The JSON contains `apiToken`, optional `instanceUrl`, and the deploy token's
`registryUsername`/`registryReadToken`. The first apply creates one atomic
configuration commit and merge request, then stops pending human review. After
merge, re-run plan/apply; Hypervibe proves the exact files and CI Lint include
graph before creating project-specific, environment-scoped variables.

The project must disable pipeline-variable overrides, enable forward-deployment
protection, disable rollback retries, enable its container registry for image
recipes, protect deploy branches against direct/force pushes, and—for
production—protect the GitLab environment for Maintainers. Each
`hypervibe-rollback-<environment>-*` protected-tag rule must allow only the exact
authenticated GitLab user; the broader Maintainer role is rejected. This
per-user rule requires GitLab Premium or Ultimate.

Immediately before any hosting API mutation, the generated deploy job uses its
short-lived GitLab job token to prove its exact deployment job, pipeline, SHA,
environment, and ordering through the Deployments API. Unknown identity or a
newer environment deployment fails closed.

Status, bounded logs/artifacts, exact-SHA manual trigger, and evidence-backed
rollback use the same `hv_ci_status`, `hv_ci_trigger`, and `hv_rollback`
commands as GitHub. To remove managed CI, keep `devops.ci` selected and first
change the environment deploy strategy to `manual`: Hypervibe reviews removal
of its generated files, waits for active jobs, deletes each exact owned
variable with confirmation, and finally removes its binding. Then remove
`devops.ci`. Repository lifecycle is separately explicit:

```json
"repository": {
  "state": "present",
  "management": "managed",
  "visibility": "private",
  "defaultBranch": "main"
}
```

Creation makes one initialized remote project and uses its verified numeric id
as the durable identity. The declared default branch and visibility must also converge;
setting drift blocks explicitly, and an acknowledged nonconverged project keeps
its durable binding so creation is never retried blindly. It does not push or
rewrite local Git history. Before deletion,
tear down CI and branch deploys, then set `state` to `absent`; create/delete
actions require exact action-id confirmation. GitLab.com keeps the binding
during its 30-day deletion retention, while self-managed deletion is verified
absent before local state is removed. If scheduled self-managed deletion is
acknowledged but permanent removal fails, Hypervibe retains the binding and
plans another confirmed retry against the same numeric id and full path. All of
this remains `ready-for-live`, not
publicly `supported`, until recent opt-in live contracts pass for the exact
GitLab offering, runner mode, and hosting recipe.

### Push deploys

`deploy.strategy: "branch"` defaults to `deploy.trigger: "ci"`. Hypervibe sets up push deploys through the selected CI provider and calls hosting APIs directly; it does not install or depend on provider CLIs.

Provider-native source ownership is exclusive. Only an explicit
`deploy.trigger: "native"` may keep a repository connected at the hosting
provider. Manual and CI modes stage source reconciliation before every other
mutation: Railway disconnects through its provider API, while Vercel and
DigitalOcean block with manual-disconnect guidance.
Unknown source observation blocks for all three providers. After the source-only
plan converges, run `hv_plan` again to review storage, variable, workflow, or
deployment work separately.

Typical setup:

- Define the environment with `deploy: { strategy: "branch", branch: "main" }` or an explicit `trigger: "ci"`.
- Run `hv_apply` first so Hypervibe records provider project, environment, and service ID bindings.
- Declare `deploy.strategy="branch"` and `deploy.trigger="ci"` with `hv_spec`, then run `hv_plan` and `hv_apply`.
- Check the returned `requiredSecrets`, `syncedSecrets`, `manualSecrets`, and `requiredVariables`. Hypervibe syncs provider API credentials to GitHub Actions secrets when the provider connection is verified and the GitHub token can write repo secrets.

Provider workflow behavior:

| Provider | Generated GitHub Actions deploy path | Usually synced from verified connection | Manual GitHub values when Hypervibe does not already know IDs |
|---|---|---|---|
| `railway` | Build/push OCI image to GHCR with GitHub's built-in workflow token, update `ServiceInstance.source.image` via Railway GraphQL, then trigger deploy via Railway GraphQL | `RAILWAY_API_TOKEN`; `IMAGE_REGISTRY_USERNAME`/`IMAGE_REGISTRY_TOKEN` from the verified GitHub connection | Variables: `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_IDS` |
| `cloudrun` | Build/push OCI image to Google Artifact Registry, patch Cloud Run services through Google APIs | `GCP_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID` | Variable: `CLOUDRUN_SERVICE_NAMES`; optional variable: `GCP_ARTIFACT_REPOSITORY`; region comes from desired state/provider default |

Every generated workflow checks the selected environment's committed desired
state before building. Hypervibe stores the last successfully applied
environment contract hash in the environment-scoped GitHub Actions variable
`HYPERVIBE_APPLIED_SPEC_HASH`. Code-only commits retain the same hash and
continue to auto-deploy to staging. A commit that changes the environment
contract stops before image build until the exact commit is reconciled:

1. Check out the target commit.
2. Run `hv_plan` and review the environment plan.
3. Run `hv_apply` so all desired-state actions complete and the final hash
   marker advances.
4. Trigger that commit with `hv_ci_trigger`, inspect it with `hv_ci_status`,
   and verify it with `hv_health`.

For project-backed checks, `hv_health` keeps the requested HTTP result separate
and also reports the latest bound deployment status for every declared
environment and service. This lets a healthy staging endpoint surface a failed
production build; provider read failures and pending states remain unknown.

The marker is environment-specific: production-only desired-state changes do
not block staging. Production workflows remain manual and enforce the same
reconciliation check for the promoted SHA.

After a deploy job fails, the generated workflow runs a separate evidence job
with read-only Actions access. It reads the completed deploy job's last 400 log
lines, applies credential-pattern redaction in addition to GitHub's normal
secret masking, bounds the result to 64 KiB, and retains
`hypervibe-deploy-failure.log` as an artifact for 14 days. Declare that path on
an external workflow source together with its exact artifact name or narrow
trailing-wildcard `failureArtifactPattern` when a Hypervibe autofix should
consume deploy evidence. The generated downloader filters by that pattern, so
other artifacts from the source run are ignored. The artifact remains untrusted diagnostic input: generated autofix
workflows cannot change `.github/`, `.hypervibe/`, secrets, deployment, auth,
billing, or database schema, and they only open draft pull requests for human
review. Evidence collection runs even though the deploy dependency failed, and
missing or incomplete declared evidence is a successful non-actionable outcome:
autofix stops before model invocation and publishes no patch. Its patch and
summary are staged outside the checkout so the summary cannot enter the patch.
Draft pull requests include the configured agent's diagnosis and verification
summary instead of model-specific boilerplate. A
reconciliation-gate failure explicitly identifies itself as infrastructure
work, so the agent produces no source patch and the operator continues through
`hv_plan` and `hv_apply`.

Railway deploy polling retries idempotent reads after bounded network, 429, and
5xx failures. Image updates and deploy-triggering mutations are never replayed
by that retry path. If the read retry budget is exhausted, `hv_ci_status`
reports a transient Railway API diagnostic rather than inferring an
infrastructure defect from the generated workflow source printed in the log.

During a CI-managed `hv_apply`, supported hosting adapters keep GitHub Actions
as the application-code release boundary. Railway applies variable changes
with deploys skipped and does not call its service redeploy mutation. For an
existing Cloud Run service or job, Hypervibe applies configuration using the
currently deployed image instead of independently building branch code; the
generated workflow later swaps in the approved commit image. Cloud Run
configuration is revision-scoped, which is why variable removals and
incompatible value transitions still require the two-release process above.
Health checks for this apply pass are deferred to the later CI deployment.

For Railway GHCR deploys, the generated workflow grants `packages: write` and uses `${{ github.actor }}` plus `${{ secrets.GITHUB_TOKEN }}` only for the workflow-time image push. The hosting provider also needs durable image-pull credentials because GitHub's workflow token is short-lived and only exists inside the Actions job. Hypervibe syncs those pull credentials into `IMAGE_REGISTRY_USERNAME` and `IMAGE_REGISTRY_TOKEN` from the verified GitHub connection when it has a login and a package-read-capable `packageReadToken`. Do not use `${{ secrets.GITHUB_TOKEN }}` for `IMAGE_REGISTRY_TOKEN`, and do not use a `read:packages`-only token as the GitHub `apiToken`.

When Hypervibe syncs GitHub Actions secrets, it records only secret names plus local one-way value hashes. If the local provider token changes later, `hv_plan` will report the CI deploy action as needing an update and `hv_apply` will resync the GitHub secret value. Raw secret values are never written to `.hypervibe/spec.json`, `.hypervibe/bindings.json`, or tool output.

To repair a stale declared GitHub Actions secret without pasting the token into
chat, re-plan from the local source of truth:

```text
hv_plan project="apreskeys.com" env="production" secretRefs={"IMAGE_REGISTRY_TOKEN":"dotenv:/Users/dave/projects/condoshare/.env#GHCR_TOKEN"}
```

For any Hypervibe-managed CI deploy, dispatch the reviewed definition with
`hv_ci_trigger`, inspect its workflows/runs/jobs/logs with `hv_ci_status`, and
finish with `hv_health`. Agents must not dispatch or monitor it with `gh`,
code-host connectors/apps, browser/UI inspection, or direct CI/provider APIs;
those paths bypass the verified connection, diagnostics, and audit boundary:

```text
hv_ci_status project="apreskeys.com" repo="davejohnson/apreskeys.com" include=["logs"] runId=28272281787
```

If the logs contain `docker buildx imagetools inspect ... ghcr.io ... 403 Forbidden`, the workflow has not reached Railway yet. Fix `IMAGE_REGISTRY_USERNAME` and `IMAGE_REGISTRY_TOKEN` first; Railway will not show a new deploy attempt until GHCR image verification can read the image.

`deploy.trigger: "native"` opts into provider-native repo integrations instead. For Railway native push autodeploys, grant the [Railway GitHub App](https://github.com/apps/railway-app) access in GitHub:

- Install/open the [Railway GitHub App](https://github.com/apps/railway-app/installations/new) and grant it access to the repo. If it is installed for "Only select repositories", add the target repo.
- Make sure at least one Railway project member has connected GitHub and has contributor access to the repo.
- Accept any pending permission updates for the Railway GitHub App in GitHub.
- After permission changes, wait a few minutes for Railway caches to refresh, then rerun `hv_status` or `hv_plan`.
- If Railway still cannot see the repo, disconnect/reconnect the service source in Railway, refresh Add -> GitHub Repository, or reinstall the Railway GitHub App.

### Secret managers and credential sources

Vault, AWS Secrets Manager, Doppler, 1Password, and Bitwarden are resolve-only.
Hypervibe reads a referenced value while building an authorized plan and never
writes, deletes, or rotates manager data. 1Password uses a [service account token](https://developer.1password.com/docs/service-accounts/) scoped only to required vaults. Bitwarden Secrets Manager uses a [machine account access token](https://bitwarden.com/help/access-tokens/) plus the organization id.

Stripe Projects is also resolve-only, but only from an already-pulled active
environment using
`stripe-projects://<environment>/<provider>/<service>`. Hypervibe never asks it
to reveal values through CLI output or perform pull/refresh/rotation work; it
uses redacted service metadata to select keys from the protected local output.

Runtime values from `.env.<environment>` and `.env` are still synchronized to
hosting through `hv_plan` and `hv_apply`. The environment-specific file wins,
selected values are encrypted into the reviewed plan, and no plaintext value is
returned. The removed secret sync command was the separate imperative path that
mutated hosting without that authorization boundary.

## Configuration

Hypervibe stores data locally:
- **Database**: `~/.hypervibe/hypervibe.db` (SQLite)
- **Secrets**: Encrypted with `~/.hypervibe/.secret-key`

No data is sent to external servers except the providers you connect.

You can override the storage location by setting `HYPERVIBE_DATA_DIR` when launching the MCP server.

## Updating Existing Projects

Hypervibe has three kinds of state to keep current:

- **The installed Hypervibe package** in Codex, Claude, or another MCP client.
- **Local Hypervibe state** in `~/.hypervibe`, especially the SQLite database schema and encrypted provider connections.
- **Repo-backed project state** in `.hypervibe/spec.json` and `.hypervibe/bindings.json`, which should be committed with the app.

The default install command uses `@hypervibe/hypervibe@latest`, so users should not need to know or remember a package-upgrade command. When Codex, Claude, or another MCP client restarts the Hypervibe server, `npx` resolves the latest published package and Hypervibe automatically runs any pending SQLite migrations at startup.

Normal update flow:

1. Restart the MCP client/server so `npx -y @hypervibe/hypervibe@latest` starts the newest published package.
2. In each app repo, pull the latest `.hypervibe/spec.json` and `.hypervibe/bindings.json`, then run `hv_status` or `hv_plan`.
3. Commit any intended changes Hypervibe makes to `.hypervibe/spec.json`, `.hypervibe/bindings.json`, generated CI workflows, or other repo files.

Provider credentials remain local and encrypted. Database component bindings (connection URLs, passwords) are also encrypted at rest. The encryption key lives in `~/.hypervibe/.secret-key` (0600); back it up — regenerating it makes previously encrypted data unrecoverable. Set `HYPERVIBE_SECRET_KEY` (64 hex chars) to supply the key externally (CI, containers). Teammates may still need to run `hv_connections` for their own AWS, Azure, Cloudflare, GCP, GitHub, Railway, or SendGrid access after installing Hypervibe, but ordinary Hypervibe package and SQLite schema upgrades should happen on restart.

`workloadKind: "job"` was removed from the service spec — it never had run-to-completion deploy semantics. Specs using it fail validation; choose `worker` (always-on, internal-only on Cloud Run with a minimum of one instance — note Cloud Run workers must still listen on `PORT`) or `cron` (scheduled). Railway, Cloud Run, and DigitalOcean implement `web`, `worker`, and `cron`; Fly implements `web` and `worker`; ECS Express, Azure Container Apps, and Vercel currently implement `web` only. Registry-backed spec validation rejects an unsupported provider/workload combination before provider project or environment mutation. Railway's observe cannot distinguish `web` from `worker`, so kind drift is not detected there.

The provider catalog is intentionally focused. Every implemented hosting lifecycle currently remains behind the provider-conformance live promotion gate and is `ready-for-live`, not `supported`. Hosting connections contain authentication and account/project scope only; geography belongs in optional `environments.<name>.hosting.region` desired state and otherwise uses a provider default. AWS project actions ensure the shared default-VPC prerequisite and own its tagged workload security group, ECR, IAM roles, and an ECS cluster; every Express mutation preserves the exact default subnets and workload group. RDS is ECS-only: it reuses that exact account/region/default-VPC binding and gives its managed database security group one durable PostgreSQL ingress source—the exact ECS workload group. Azure project actions own the resource group, ACR, role assignments, and managed environment; DigitalOcean project actions reuse or create a free Starter registry. Fly creates one source-less App and stopped Machine per logical service, then managed CI changes only the exact bound Machine to an immutable image digest. Users do not pre-create or paste those infrastructure IDs into credentials. Heroku and Render remain deliberately out of scope. Cloud SQL, Railway, RDS, Supabase, Neon, DigitalOcean, Fly Managed Postgres, and Azure PostgreSQL are ready-for-live database targets. None is promoted to `supported` without dated live lifecycle evidence. Fly Managed Postgres stays private: bounded local query, seed, and migration operations use an operation-scoped WireGuard peer and Hypervibe's packaged userspace connector, then remove the exact peer after the operation.

Redis is a separate cache lifecycle instead of a database component and wires `REDIS_URL`. Amazon ElastiCache is `ready-for-live` with ECS Express: it reuses the auth-only `ecs` connection, resolves the bound default-VPC workload network, and accepts cache region/size only through desired state. Azure Managed Redis with Container Apps, GCP Memorystore with Cloud Run Direct VPC, DigitalOcean Managed Valkey, and Railway Redis are also implemented and `ready-for-live`. PostgreSQL is the only database engine in desired state; MongoDB and MySQL are intentionally outside the core lifecycle.

## Adding New Providers

Providers self-register through the plugin system:

```typescript
// src/adapters/providers/example/example.adapter.ts
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

export class ExampleAdapter implements IProvider {
  // ... implementation
}

providerRegistry.register({
  metadata: {
    name: 'example',
    displayName: 'Example Provider',
    category: 'dns',
    credentialsSchema: ExampleCredentialsSchema,
    // Lifecycle providers also declare databaseEngines/cacheEngines here and
    // expose primary or derived lifecycle adapters.
  },
  factory: (credentials) => new ExampleAdapter(credentials),
});
```

Then import during application provider bootstrap:
```typescript
import '../adapters/providers/example/example.adapter.js';
```

See `docs/provider-conformance.md` before adding hosting, database, or cache
support. Provider IDs are extensible, but support is a tested observe/plan/apply/
destroy contract rather than a schema enum.

## Releasing Hypervibe

Releases are one command from a clean, up-to-date `main` checkout:

```bash
npm ci
npm run release -- patch
```

The public package uses npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) through GitHub
Actions OIDC. Its trusted publisher for `@hypervibe/hypervibe` has these exact
fields:

- provider: GitHub Actions
- organization or user: `davejohnson`
- repository: `hypervibe`
- workflow filename: `release.yml`
- environment name: none
- allowed action: `npm publish`

The workflow uses npm 11.19.0 with public provenance and no long-lived npm
credential. Changes to the trusted publisher must preserve the exact repository
and workflow identity above.

Use `minor`, `major`, or an exact stable version such as `0.2.0` instead of
`patch`. The release command verifies that `main` exactly matches
`origin/main`, updates `package.json` and `package-lock.json`, runs the full
test/typecheck/build/package-safety suite, creates the release commit and an
annotated `vX.Y.Z` tag, and atomically pushes both. The tag starts
`release.yml`; it publishes the public npm package with provenance, builds
native Apple Silicon (`arm64`) and Intel (`x86_64`) DMGs on matching GitHub
macOS runners, creates SHA-256 checksum files, and attaches all four files to a
public [GitHub Release](https://github.com/davejohnson/hypervibe/releases). By
default the command watches that workflow through `gh` and fails if any
package, installer, or release job fails.

Preview the next version and git operations without changing anything:

```bash
npm run release -- patch --dry-run
```

Pass `--no-wait` only when another process will monitor the GitHub release
workflow. If validation fails before the release commit, the script restores
the original package version files. If the atomic push fails, it keeps the
local release commit and tag and prints the exact retry command.

Local installer builds use an ad-hoc signature by default. Tagged GitHub
releases require the Developer ID Application and App Store Connect secrets
documented in [`apps/macos/README.md`](apps/macos/README.md). The release
workflow imports them only into an ephemeral keychain, notarizes and staples
both DMGs, and fails rather than publishing an unsigned installer.

## Philosophy

**Let LLMs handle the fuzzy stuff.** Hypervibe returns raw data and lets your agent interpret it. No complex pattern matching or hardcoded rules—your agent figures out that "prod-us-east" means production.

**Simple shortcuts are fine.** Exact matches for `production`, `staging`, `development` work instantly. Everything else? Claude handles it.

**Two-step flows for safety.** Import and destructive operations show you what will happen first, then ask for confirmation.

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

---

Built for [Claude Code](https://claude.ai/code). Powered by [MCP](https://modelcontextprotocol.io/).
