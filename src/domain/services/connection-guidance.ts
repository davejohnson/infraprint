import { z } from 'zod';

const CLOUDFLARE_DNS_TOKEN_PERMISSIONS = [
  { key: 'zone', type: 'read' },
  { key: 'zone_settings', type: 'read' },
  { key: 'dns', type: 'edit' },
  { key: 'account_settings', type: 'read' },
];
const CLOUDFLARE_DNS_PERMISSION_QUERY = encodeURIComponent(JSON.stringify(CLOUDFLARE_DNS_TOKEN_PERMISSIONS));

/** Official Cloudflare template URLs with Hypervibe's base DNS permissions pre-selected. */
export const CLOUDFLARE_TOKEN_URLS = {
  user: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${CLOUDFLARE_DNS_PERMISSION_QUERY}&accountId=%2A&zoneId=all&name=Hypervibe%20DNS%20and%20domains`,
  account: `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${CLOUDFLARE_DNS_PERMISSION_QUERY}&name=Hypervibe%20DNS%20and%20domains`,
} as const;

/** Pre-filled GitHub PAT creation URLs, one per token role. */
export const GITHUB_TOKEN_URLS = {
  /** apiToken: workflow/secrets management. */
  api: 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Hypervibe%20GitHub%20API',
  /** apiToken: repository-scoped workflow/secrets management. */
  fineGrained: 'https://github.com/settings/personal-access-tokens/new?name=Hypervibe%20repository&description=Manage%20one%20repository%20with%20Hypervibe&expires_in=90&actions=write&administration=write&contents=write&environments=write&issues=write&pull_requests=write&secrets=write&actions_variables=write&workflows=write',
  /** packageReadToken: durable GHCR image pulls. */
  packageRead: 'https://github.com/settings/tokens/new?scopes=read:packages&description=Hypervibe%20GHCR%20pull',
  /** Single-token setup covering both roles. */
  combined: 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys',
  /** Classic-only access for changing a GitHub App installation's repositories. */
  railwayAppScope: 'https://github.com/settings/tokens/new?scopes=repo&description=Hypervibe%20Railway%20app%20scope',
} as const;

/** GitLab documents these query parameters for pre-filled personal tokens. */
export const GITLAB_TOKEN_URLS = {
  api: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Hypervibe&description=Manage+GitLab+repository+and+CI+with+Hypervibe&scopes=api',
  personalTokenDocs: 'https://docs.gitlab.com/user/profile/personal_access_tokens/',
  projectTokenDocs: 'https://docs.gitlab.com/user/project/settings/project_access_tokens/',
  deployTokenDocs: 'https://docs.gitlab.com/user/project/deploy_tokens/',
} as const;

export interface ConnectionGuidance {
  provider: string;
  displayName: string;
  tokenType: string;
  setupUrl?: string;
  setupUrls?: Array<{ label: string; url: string }>;
  permissions: string[];
  credentialExample: string;
  notes?: string[];
}

export interface ConnectionSetupDetails {
  provider: string;
  project?: string;
  scope?: string;
  displayName?: string;
  tokenType?: string;
  recommendedSetupUrl?: string;
  setupUrls: string[];
  requiredPermissions: string[];
  credentialExample: string;
  notes?: string[];
}

export type CredentialInputKind = 'text' | 'secret' | 'multilineSecret' | 'choice';

/**
 * A provider-neutral description of one credential field. Clients use this to
 * render connection forms without importing provider knowledge or schemas.
 */
export interface CredentialFieldDescriptor {
  name: string;
  label: string;
  required: boolean;
  sensitive: boolean;
  inputKind: CredentialInputKind;
  options?: string[];
  description?: string;
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault
      || current instanceof z.ZodCatch
    ) {
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodBranded) {
      current = current._def.type;
      continue;
    }
    return current;
  }
}

function credentialFieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/);
  const acronyms: Record<string, string> = {
    api: 'API',
    aws: 'AWS',
    gcp: 'GCP',
    id: 'ID',
    json: 'JSON',
    oauth: 'OAuth',
    url: 'URL',
  };
  return words
    .map((word) => acronyms[word.toLowerCase()] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function isSensitiveCredentialField(name: string): boolean {
  if (/(?:kind|mode|type)$/i.test(name)) {
    return false;
  }
  return /(token|key|secret|password|credential|private|connection(?:url|string))/i.test(name);
}

function enumOptions(schema: z.ZodTypeAny): string[] | undefined {
  if (schema instanceof z.ZodEnum) {
    return [...schema.options];
  }
  if (schema instanceof z.ZodNativeEnum) {
    const options = Object.values(schema.enum).filter((value): value is string => typeof value === 'string');
    return [...new Set(options)];
  }
  return undefined;
}

/**
 * Derive a safe form contract from a provider-owned Zod credential schema.
 * Schemas which cannot be represented as an object are intentionally omitted;
 * clients can fall back to credentialsRef for those providers.
 */
export function credentialFieldsFromSchema(
  schema: z.ZodTypeAny
): CredentialFieldDescriptor[] | undefined {
  const objectSchema = unwrapSchema(schema);
  if (!(objectSchema instanceof z.ZodObject)) {
    return undefined;
  }

  return Object.entries(objectSchema.shape).map(([name, rawField]) => {
    const field = rawField as z.ZodTypeAny;
    const unwrapped = unwrapSchema(field);
    const options = enumOptions(unwrapped);
    const sensitive = isSensitiveCredentialField(name);
    const inputKind: CredentialInputKind = options
      ? 'choice'
      : sensitive && /(credentials|private.*key)/i.test(name)
        ? 'multilineSecret'
        : sensitive
          ? 'secret'
          : 'text';
    const description = field.description ?? unwrapped.description;

    return {
      name,
      label: credentialFieldLabel(name),
      required: !field.safeParse(undefined).success,
      sensitive,
      inputKind,
      ...(options ? { options } : {}),
      ...(description ? { description } : {}),
    };
  });
}

const GUIDANCE: Record<string, ConnectionGuidance> = {
  '1password': {
    provider: '1password',
    displayName: '1Password',
    tokenType: '1Password service account token',
    setupUrl: 'https://www.1password.dev/service-accounts/',
    permissions: ['Grant the service account access only to the vaults Hypervibe should read.'],
    credentialExample: 'hv_connections provider="1password" credentialsRef="env:OP_SERVICE_ACCOUNT_TOKEN"',
    notes: ['The token usually starts with ops_.'],
  },
  appstoreconnect: {
    provider: 'appstoreconnect',
    displayName: 'App Store Connect',
    tokenType: 'App Store Connect team API key (keyId + issuerId + .p8 private key)',
    setupUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
    permissions: [
      'Create a Team Key under Users and Access -> Integrations (only Account Holder or Admin can generate one).',
      'App Manager role covers TestFlight groups/testers, builds, metadata, and App Store submissions.',
      'Use Admin role if Hypervibe should register bundle IDs and enable capabilities declared in the ios spec — Certificates, Identifiers & Profiles access requires it.',
    ],
    credentialExample: 'hv_connections provider="appstoreconnect" credentialsRef="file:/absolute/path/appstoreconnect.json"',
    notes: [
      'The JSON must include keyId, issuerId, and privateKey. The .p8 private key can only be downloaded once.',
      'Individual (per-user) keys do not work for provisioning operations; use a Team Key.',
    ],
  },
  'aws-secrets': {
    provider: 'aws-secrets',
    displayName: 'AWS Secrets Manager',
    tokenType: 'AWS SDK default credential chain or explicit IAM access key (accessKeyId/secretAccessKey, plus sessionToken for temporary STS credentials)',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    setupUrls: [
      {
        label: 'Open IAM security credentials to create or rotate an access key',
        url: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      },
      {
        label: 'Review the AWS access-key security guidance',
        url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
      },
      {
        label: 'Review Secrets Manager authentication and permissions',
        url: 'https://docs.aws.amazon.com/secretsmanager/',
      },
    ],
    permissions: [
      'secretsmanager:GetSecretValue and secretsmanager:ListSecrets for read-only resolution (ListSecrets is required for connection verification and hv_secrets).',
    ],
    credentialExample: 'hv_connections provider="aws-secrets"',
    notes: [
      'Prefer temporary STS credentials when your organization can issue them. Never create or use root-user access keys.',
      'With credentials omitted, Hypervibe uses the AWS SDK default provider chain: environment variables, shared profiles and SSO, web identity, ECS task credentials, or an EC2 instance role.',
      'For unattended automation, pass an explicit credentialsRef JSON containing accessKeyId and secretAccessKey, plus sessionToken when using temporary STS credentials.',
      'The secret access key is shown only when it is created. Save it outside the repository.',
    ],
  },
  'azure-postgres': {
    provider: 'azure-postgres',
    displayName: 'Azure Database for PostgreSQL',
    tokenType: 'Microsoft Entra application service principal (tenantId, clientId, and clientSecret) for one Azure subscription',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Microsoft Entra service-principal setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'PostgreSQL Flexible Server ARM operations',
        url: 'https://learn.microsoft.com/en-us/rest/api/postgresql/',
      },
      {
        label: 'PostgreSQL Flexible Server firewall behavior',
        url: 'https://learn.microsoft.com/en-us/azure/postgresql/security/security-firewall-rules',
      },
    ],
    permissions: [
      'At the exact resource-group scope, grant Microsoft.Resources/subscriptions/resourceGroups/read.',
      'Grant Microsoft.DBforPostgreSQL/flexibleServers/read, write, and delete plus Microsoft.DBforPostgreSQL/flexibleServers/databases/read and write.',
      'Grant Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/read and write so Hypervibe can install the reviewed Azure-services access rule required by Azure-hosted workloads.',
      'Resource-group Contributor is a broader fallback. Prefer a custom role containing only the operations above when your organization supports custom roles.',
    ],
    credentialExample: 'hv_connections provider="azure-postgres" credentialsRef="file:/absolute/path/azure-postgres.json"',
    notes: [
      'The JSON file contains only tenantId, subscriptionId, clientId, and clientSecret. Reuse the verified azure-container-apps connection when possible; resource-group identity, location, and server shape are lifecycle state, never credentials.',
      'Hypervibe places PostgreSQL in the exact resource group owned by the same Azure Container Apps environment. This lifecycle intentionally rejects non-Azure hosting until a different network contract is implemented.',
      'Hypervibe creates one Flexible Server, one logical app database, and a firewall rule whose start/end are 0.0.0.0. Microsoft defines that rule as access from Azure services; it includes other customers’ Azure resources, so strong generated database credentials remain essential.',
      'The generated administrator credential and connection URL are encrypted in local component state and never returned in plans, receipts, logs, or repo bindings.',
      'Client secrets expire. Store this JSON outside the repository, rotate before expiry, and reconnect with the replacement value.',
    ],
  },
  'azure-managed-redis': {
    provider: 'azure-managed-redis',
    displayName: 'Azure Managed Redis',
    tokenType: 'Microsoft Entra application service principal (tenantId, clientId, and clientSecret) for one Azure subscription',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Microsoft Entra service-principal setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'Azure Managed Redis built-in role',
        url: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/databases',
      },
      {
        label: 'Azure Managed Redis REST operations',
        url: 'https://learn.microsoft.com/en-us/rest/api/redis/redisenterprisecache/',
      },
    ],
    permissions: [
      'At the exact resource-group scope, assign Azure Managed Redis Contributor (role ID 3015e5ed-6856-4ab3-b2f0-b8492aa30ca6). It creates/manages Managed Redis resources without granting cache data access.',
      'The service principal must be allowed to invoke the database listKeys action so Hypervibe can wire the generated TLS endpoint; confirm that a custom deny assignment does not remove this action.',
      'Also grant Microsoft.Resources/subscriptions/resourceGroups/read at the same scope when it is not already included by the role assignment.',
    ],
    credentialExample: 'hv_connections provider="azure-managed-redis" credentialsRef="file:/absolute/path/azure-managed-redis.json"',
    notes: [
      'The JSON file contains only tenantId, subscriptionId, clientId, and clientSecret. Reuse the verified azure-container-apps connection when possible; resource-group identity and placement are lifecycle state, never credentials.',
      'Hypervibe creates one public-network-enabled, TLS-only Azure Managed Redis cluster in the exact resource group owned by the same Azure Container Apps environment. The default database uses encrypted client protocol and access-key authentication; non-Azure hosting is rejected.',
      'Set cache.region and cache.size in desired state when the documented defaults are unsuitable. Azure Managed Redis network, subnetwork, and tier fields are rejected by this public-endpoint lifecycle instead of being ignored.',
      'Client secrets expire. Store this JSON outside the repository, rotate before expiry, and reconnect with the replacement value.',
    ],
  },
  azureblob: {
    provider: 'azureblob',
    displayName: 'Azure Blob Storage',
    tokenType: 'Azure default credential chain (including Azure CLI login), or a Microsoft Entra service principal for unattended automation',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Microsoft Entra service-principal setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'Azure Storage Account Contributor role',
        url: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/storage',
      },
    ],
    permissions: [
      'Reuse the Azure Container Apps service principal when available; its reviewed subscription-level Contributor setup already covers the deterministic environment resource group and storage accounts.',
      'For a storage-only principal, grant Microsoft.Resources/subscriptions/resourceGroups/read and write, Microsoft.Storage/register/action, and the Storage Account Contributor actions required to create, tag, inspect, and delete accounts in Hypervibe-named resource groups. Subscription Contributor is the broader built-in fallback.',
      'Allow Microsoft.Storage/storageAccounts/listKeys/action so Hypervibe can stream migrations and wire the private container into selected workloads.',
    ],
    credentialExample: 'hv_connections provider="azureblob"',
    notes: [
      'If the project already has a verified azure-container-apps connection, Hypervibe reuses it; no separate Blob Storage connection or account key is required.',
      'For local use, authenticate through the Azure default credential chain (for example az login), then add the connection without credentials. Hypervibe discovers a sole enabled subscription; when several are accessible, select one with credentials={"authMode":"default","subscriptionId":"<id>"}.',
      'For unattended automation, a standalone connection JSON may contain tenantId, subscriptionId, clientId, and clientSecret. Storage location comes from the spec, and Hypervibe deterministically reuses or creates the environment resource group.',
      'Hypervibe creates a dedicated storage account per declared bucket, disables public blob access, requires HTTPS/TLS 1.2, and creates one private container. The boundary keeps each generated account key scoped to one Hypervibe storage resource.',
      'The account key and generated connection string are runtime secrets. They never enter specs, bindings, plans, receipts, or logs.',
    ],
  },
  'azure-container-apps': {
    provider: 'azure-container-apps',
    displayName: 'Azure Container Apps',
    tokenType: 'Microsoft Entra service principal using tenantId, subscriptionId, application clientId, and a clientSecret',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupUrls: [
      {
        label: 'Create or review the Microsoft Entra application',
        url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        label: 'Official service-principal and client-secret setup guide',
        url: 'https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal',
      },
      {
        label: 'Azure built-in role definitions',
        url: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles',
      },
    ],
    permissions: [
      'At subscription scope, assign Contributor (role ID b24988ac-6180-42a0-ab88-20f7382dd24c) so Hypervibe can register Microsoft.App and Microsoft.ContainerRegistry and create/delete its tagged resource groups, Basic ACR registries, managed environments, Container Apps, and managed certificates.',
      'At the same subscription scope, assign Role Based Access Control Administrator (role ID f58310d9-a9f6-439a-9e8d-f62e7b41a168) so the reviewed project/service actions can grant AcrPush to the connected service principal and AcrPull to each Container App managed identity. Contributor alone cannot create role assignments.',
      'Hypervibe creates the registry in Legacy Registry Permissions mode, assigns AcrPush (8311e382-0749-4cb8-b61a-304f252e45ec) to the service principal, and assigns AcrPull (7f951dda-4ed3-4680-a7ca-43fe172d538d) to each app identity; users do not pre-create any of these resources.',
      'Custom domains require Microsoft.App managed-certificate and Container App update permissions included by Contributor. DNS must point directly to Azure while the free certificate is issued and renewed, so Cloudflare proxying remains disabled.',
    ],
    credentialExample: 'hv_connections provider="azure-container-apps" credentialsRef="file:/absolute/path/azure-container-apps.json"',
    notes: [
      'The JSON needs only tenantId, subscriptionId, clientId, and clientSecret. Do not include location, a resource group, registry, registry server, managed-environment ID, or Container App ID—those are Hypervibe desired state.',
      'Hypervibe uses canadacentral when environments.<name>.hosting.region is omitted. An agent may declare another Azure location in the spec when latency, residency, or existing infrastructure requires it.',
      'Copy the client secret VALUE when it is created; Azure shows it only once. Do not use the secret ID.',
      'Microsoft does not publish a documented pre-filled credential-template URL for this flow. The links above intentionally open the official app-registration and role documentation without guessed dashboard parameters.',
      'Client secrets expire. Store the JSON outside the repository, rotate it before expiry, and reconnect from a file, dotenv mapping, or secret-manager reference.',
    ],
  },
  bitwarden: {
    provider: 'bitwarden',
    displayName: 'Bitwarden Secrets Manager',
    tokenType: 'Bitwarden Secrets Manager machine account access token',
    setupUrl: 'https://bitwarden.com/help/access-tokens/',
    permissions: ['Grant the machine account read access to the projects/secrets Hypervibe should resolve.'],
    credentialExample: 'hv_connections provider="bitwarden" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"accessToken":"BITWARDEN_ACCESS_TOKEN","organizationId":"BITWARDEN_ORGANIZATION_ID"}',
  },
  cloudflare: {
    provider: 'cloudflare',
    displayName: 'Cloudflare',
    tokenType: 'Cloudflare User API Token as apiToken for simple DNS, custom domains, load balancing, email routing, and Registrar/domain purchase; or Cloudflare Account API Token as apiToken for durable DNS, custom domains, load balancing, and email routing automation, with a separate User API Token only when that account-token setup also buys domains',
    setupUrl: CLOUDFLARE_TOKEN_URLS.user,
    setupUrls: [
      {
        label: 'Create pre-filled User API Token for DNS/custom domains; add optional Registrar, email, or load-balancer permissions below',
        url: CLOUDFLARE_TOKEN_URLS.user,
      },
      {
        label: 'Create pre-filled Account API Token for durable DNS/custom-domain automation; add optional email or load-balancer permissions below',
        url: CLOUDFLARE_TOKEN_URLS.account,
      },
    ],
    permissions: [
      `For the simplest setup, create a Cloudflare User API Token from the pre-filled Hypervibe template at ${CLOUDFLARE_TOKEN_URLS.user} and map it as apiToken/CLOUDFLARE_API_TOKEN. That one token can manage DNS and custom domains; add the optional permissions below for email routing, load balancing, or Registrar.`,
      `For durable team/service automation that should not be tied to one user, create a Cloudflare Account API Token from the pre-filled Hypervibe template at ${CLOUDFLARE_TOKEN_URLS.account} and map it as apiToken/CLOUDFLARE_API_TOKEN plus accountId/CLOUDFLARE_ACCOUNT_ID.`,
      'For DNS/custom domains with either token type: grant Zone -> Zone -> Read.',
      'For DNS/custom domains with either token type: grant Zone -> DNS -> Edit.',
      'For Railway/custom-domain verification and some zone lookups: grant Zone -> Zone Settings -> Read or Edit.',
      'For environments declaring loadBalancer: grant the Cloudflare API token Load Balancers Read and Load Balancers Write on the target zone.',
      'For environments declaring loadBalancer: grant Load Balancing: Monitors and Pools Read and Load Balancing: Monitors and Pools Write on the owning account.',
      'For DNS/custom domains with either token type: Zone Resources must be Include -> Specific zone -> the target domain, for example hlspropertycare.com.',
      'For account-scoped permissions: Account Resources must be Include -> Specific account -> the target account. The user-token template initially selects all accounts/zones because Cloudflare template URLs accept ids, not domain names; narrow both selectors before creating the token.',
      'For email routing only: grant Zone -> Email Routing Rules -> Edit.',
      'For email routing only: grant Account -> Email Routing Addresses -> Edit.',
      'For accountId auto-resolution: grant Account -> Account Settings -> Read; otherwise pass accountId/CLOUDFLARE_ACCOUNT_ID explicitly.',
      'For Registrar/domain purchase: grant Registrar write permissions on a Cloudflare User API Token. If apiToken is already that User API Token, no second token is needed. If apiToken is an Account API Token, add a User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN because Account API Tokens cannot be used for Registrar.',
    ],
    credentialExample: 'single User API Token: hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}; account-token setup that also buys domains: hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID","registrarApiToken":"CLOUDFLARE_REGISTRAR_API_TOKEN"}',
    notes: [
      `Create user tokens with ${CLOUDFLARE_TOKEN_URLS.user}; create account tokens with ${CLOUDFLARE_TOKEN_URLS.account}. Both links pre-fill the token name plus Zone Read, Zone Settings Read, DNS Edit, and Account Settings Read.`,
      'User API Tokens are fine for DNS, custom domains, and email routing, and are the simplest path when Hypervibe may also register domains. New user tokens use the documented cfut_ prefix.',
      'Account API Tokens are for durable service-principal style automation that should survive an individual user leaving the account. New account tokens use the documented cfat_ prefix (older tokens are unprefixed and still work). Cloudflare lists Registrar as NOT supported by Account API Tokens, so account-token setups need a User API Token only for Registrar/domain purchase.',
      'If the spec does not purchase/register domains, omit registrarApiToken. If apiToken is a User API Token with Registrar permissions, omit registrarApiToken even when registering domains.',
      'For either token type, review the pre-filled permissions and narrow resources to the intended account and zone before creating it. Cloudflare does not document template keys for Hypervibe\'s optional Email Routing, Load Balancing, or Registrar permissions, so add those manually only when the spec needs them. Cloudflare token verification only proves the token is active, not that it has these permissions — missing permissions surface at plan/apply time.',
      'Use the token secret itself as apiToken/CLOUDFLARE_API_TOKEN; do not use the token name or token id. Do not use the legacy Global API Key.',
    ],
  },
  cloudrun: {
    provider: 'cloudrun',
    displayName: 'Google Cloud Run',
    tokenType: 'Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'Grant roles/run.admin on the target Google Cloud project so Hypervibe can create/update Cloud Run services and jobs.',
      'Grant roles/iam.serviceAccountUser on the runtime service account.',
      'Grant roles/cloudbuild.builds.editor so Hypervibe can run Cloud Build builds.',
      'Grant roles/artifactregistry.admin when Hypervibe should create the Docker repository; roles/artifactregistry.writer is enough if the repository already exists.',
      'Grant roles/serviceusage.serviceUsageAdmin so Hypervibe can auto-enable required APIs.',
      'Grant roles/cloudsql.client when using Cloud SQL, plus roles/cloudsql.admin if Hypervibe provisions the instance.',
      'Grant roles/cloudscheduler.admin when using cron jobs.',
      'Grant roles/pubsub.editor when using queues.',
      'For read-only GCS inventory, explicitly prepare gcsAccess="inspect" to enable storage.googleapis.com and grant roles/storage.viewer.',
      'For GCS create, object transfer, or teardown, explicitly prepare gcsAccess="lifecycle" to grant roles/storage.admin after reviewing that broader project-scoped access.',
      'For read-only Memorystore inventory, explicitly prepare memorystoreAccess="inspect" to enable Redis/Compute APIs and grant roles/redis.viewer plus roles/compute.networkViewer.',
      'For Memorystore create or teardown, explicitly prepare memorystoreAccess="lifecycle" to grant roles/redis.admin, roles/compute.networkViewer, and roles/compute.networkUser after reviewing that broader project-scoped access.',
      'For Pub/Sub queue lifecycle, explicitly prepare queueAccess="lifecycle" to enable pubsub.googleapis.com and grant roles/pubsub.editor. Other preparation modes never add that role.',
      'Grant roles/logging.viewer and roles/logging.viewAccessor for logs.',
      'Native custom domains use the Cloud Run domain-mapping API covered by roles/run.admin. The connected identity must also be authorized for the verified base domain before apply.',
    ],
    credentialExample: 'hv_connections provider="cloudrun" credentialsRef="file:/absolute/path/cloudrun.json"',
    notes: [
      'Run hv_connections action="prepare" when Hypervibe should enable APIs and grant these roles. After the credential-free preview, prefer confirm=true with adminAuth="default" to use existing Google Application Default Credentials; explicit one-time admin credential references remain available. GCS, Memorystore, and Pub/Sub access are staged independently and never added by another capability.',
      'The connection JSON contains only projectId and credentials. Hypervibe uses us-central1 when environments.<name>.hosting.region is omitted; an agent may declare another supported region in the spec.',
      'Cloud Run native domain mappings are available only in Google-supported regions. Hypervibe blocks before DNS mutation in other regions; use a separately declared external HTTPS load balancer there.',
      'Cloud Run returns a multi-value A/AAAA/CNAME record set for the mapping. Hypervibe keeps those traffic records DNS-only while Google validates ownership and manages TLS.',
      'Google recommends short-lived credentials over long-lived service account JSON keys; if you use a JSON key, rotate it and grant only the roles above.',
    ],
  },
  cloudsql: {
    provider: 'cloudsql',
    displayName: 'Google Cloud SQL',
    tokenType: 'Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'Grant roles/cloudsql.viewer to the connected service account so connection verification can list and inspect Cloud SQL instances.',
      'Grant roles/cloudsql.client to the connected service account so hv_db_query can open its operation-scoped authenticated connector.',
      'Also grant roles/cloudsql.admin when Hypervibe should create or delete Cloud SQL instances and logical databases through hv_plan/hv_apply.',
      'The Cloud Run runtime service account separately needs roles/cloudsql.client when deployed services connect through /cloudsql.',
      'The sqladmin.googleapis.com API must already be enabled — hv_connections provider="cloudrun" action="prepare" enables it.',
    ],
    credentialExample: 'hv_connections provider="cloudsql" credentialsRef="file:/absolute/path/cloudsql.json"',
  },
  memorystore: {
    provider: 'memorystore',
    displayName: 'Google Cloud Memorystore',
    tokenType: 'Compatible verified Cloud Run Google identity, or a standalone Google Cloud service account JSON key',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    permissions: [
      'Grant roles/redis.viewer for connection verification and live observation of Memorystore instances.',
      'Grant roles/redis.admin when Hypervibe should create and delete Memorystore instances through hv_plan/hv_apply.',
      'Grant roles/compute.networkViewer so plan/apply can prove the selected existing VPC and subnet, and roles/compute.networkUser so Cloud Run can attach Direct VPC egress.',
      'Grant serviceusage.services.use on the target project (roles/serviceusage.serviceUsageConsumer is the standard role) and enable redis.googleapis.com before connecting.',
      'When reusing Cloud Run credentials, preview hv_connections provider="cloudrun" action="prepare" memorystoreAccess="inspect" for inventory or memorystoreAccess="lifecycle" for create/delete, then explicitly confirm the reviewed preparation.',
      'Declare cache.region/network/subnetwork/tier/size in hv_spec. Hypervibe verifies the existing network and configures Cloud Run Direct VPC egress; it never creates a VPC or subnet implicitly.',
    ],
    credentialExample: 'hv_connections provider="memorystore" credentialsRef="file:/absolute/path/memorystore.json"',
    notes: [
      'If the project already has a verified cloudrun connection, Hypervibe reuses it; no second Google service-account key is required.',
      'The connection JSON contains authentication only: projectId and credentials (the service-account JSON as a string). Placement belongs under environments.<name>.cache in hv_spec; omitted placement defaults new caches to us-central1 and the existing default VPC/default regional subnet.',
      'Hypervibe creates private-IP Redis with AUTH enabled and transit encryption disabled. Access is limited by the selected VPC, so never treat the resulting REDIS_URL as internet reachable.',
      'Google recommends short-lived credentials over service-account JSON keys. If a key is required, rotate it and grant only the project roles above.',
    ],
  },
  database: {
    provider: 'database',
    displayName: 'External database',
    tokenType: 'database connection URL',
    permissions: ['Use a database user with the least privileges required for the intended hv_db query or migration operation.'],
    credentialExample: 'hv_connections provider="database" credentialsRef="dotenv:/absolute/path/.env#DATABASE_URL"',
  },
  digitalocean: {
    provider: 'digitalocean',
    displayName: 'DigitalOcean',
    tokenType: 'DigitalOcean personal access token (PAT, normally prefixed dop_v1_)',
    setupUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    permissions: [
      'For Managed PostgreSQL and Valkey observation, grant database:read and database:view_credentials on the DigitalOcean team that owns the clusters.',
      'For Managed PostgreSQL and Valkey lifecycle through hv_plan/hv_apply, also grant database:create, database:update, and database:delete.',
      'DigitalOcean requires regions:read, sizes:read, and actions:read alongside non-read database scopes so Hypervibe can validate regions/sizes and observe asynchronous actions.',
      'When DigitalOcean App Platform hosting is enabled, also grant app:read, app:create, app:update, and app:delete; omit those app scopes for a database/cache-only connection.',
      'For exact-SHA App Platform CI deploys, grant registry:read and registry:update. Also grant registry:create plus account:read so the reviewed project action can create a stable free Starter registry when the team has none.',
      'App Platform custom-domain attach, observation, certificate status, and detach use the same app:read/app:update permissions; Hypervibe preserves the rest of the current App Spec.',
    ],
    credentialExample: 'hv_connections provider="digitalocean" credentialsRef="file:/absolute/path/digitalocean.json"',
    notes: [
      'Create the PAT at https://cloud.digitalocean.com/account/api/tokens with Custom Scopes for least privilege. Full Access is a broader fallback, not the recommended default.',
      'The JSON credential file needs only apiToken for ordinary App Platform use. Hypervibe deterministically reuses an existing team registry, or creates a free Starter registry during the reviewed project action when none exists; CI only reads and uses that registry.',
      'App placement is desired state, not authentication. Hypervibe uses nyc when environments.<name>.hosting.region is omitted; an agent may declare another App Platform region in the spec.',
      'DigitalOcean shows a PAT only once. Store it in a dotenv file or secret manager instead of chat; Hypervibe accepts DIGITALOCEAN_TOKEN and HYPERVIBE_DIGITALOCEAN_TOKEN.',
      'Token scopes cannot be changed after creation, and the token cannot exceed its creator\'s DigitalOcean team role. Create a replacement token if scopes or team access are wrong.',
    ],
  },
  fly: {
    provider: 'fly',
    displayName: 'Fly.io',
    tokenType: 'Fly.io organization-scoped access token plus the exact organization slug',
    setupUrl: 'https://fly.io/dashboard',
    setupUrls: [
      {
        label: 'Open the Fly.io dashboard, select the organization, then open Tokens',
        url: 'https://fly.io/dashboard',
      },
      {
        label: 'Review Fly.io token types and organization-token guidance',
        url: 'https://fly.io/docs/security/tokens/',
      },
    ],
    permissions: [
      'Create an organization-scoped token for the one Fly.io organization Hypervibe should manage. Hypervibe needs organization access to list/create/delete Apps, create/update Machines, reconcile app secrets and public IPs, manage TLS certificates, push exact-image digests to registry.fly.io, create/observe/delete Managed Postgres clusters, databases, and users, and create/list/remove operation-scoped WireGuard peers for bounded private database access.',
      'Do not use fly auth token: Fly.io documents that command as a short-lived user token intended for local use.',
      'Do not use an app deploy token: it is restricted to one existing App and cannot authorize Hypervibe to create the per-service Apps or Managed Postgres clusters declared in desired state.',
      'Keep organizationSlug scoped to the same organization that issued the token. Hypervibe records the non-secret organization slug beside every durable App and database identity and refuses cross-organization bindings.',
    ],
    credentialExample: 'hv_connections provider="fly" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"FLY_API_TOKEN","organizationSlug":"FLY_ORGANIZATION_SLUG"}',
    notes: [
      'Fly.io does not publish a documented pre-filled token-template URL. In the dashboard, select the intended organization, open Tokens, create an organization token, and copy its value once into a dotenv file or secret manager.',
      'The credential contains only apiToken and organizationSlug. App and Managed Postgres placement belongs in environments.<name>.hosting.region; Hypervibe defaults to iad when it is omitted.',
      'Hypervibe uses the Machines and Managed Postgres HTTP APIs directly. It does not install or invoke flyctl for infrastructure lifecycle operations.',
      'Fly Managed Postgres endpoints remain private to Fly networking. For each bounded local query, seed, or migration operation, Hypervibe creates a uniquely named WireGuard peer, starts its packaged userspace connector, verifies PostgreSQL through the tunnel, and removes that exact peer afterward. A matching pre-existing peer blocks for manual inspection instead of being silently deleted.',
    ],
  },
  elasticache: {
    provider: 'elasticache',
    displayName: 'Amazon ElastiCache',
    tokenType: 'the verified AWS IAM access key pair used by ECS (accessKeyId/secretAccessKey) and scoped to one account',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    permissions: [
      'Reuse the verified ecs connection; do not create a separate placement credential. For verification and observation add elasticache:DescribeServerlessCaches plus ec2:DescribeVpcs, ec2:DescribeSubnets, and ec2:DescribeSecurityGroups to that IAM principal.',
      'For lifecycle management through hv_plan/hv_apply: elasticache:CreateServerlessCache, elasticache:DeleteServerlessCache, elasticache:AddTagsToResource, ec2:CreateSecurityGroup, ec2:AuthorizeSecurityGroupIngress, ec2:DeleteSecurityGroup, and ec2:CreateTags.',
      'If the account has never used ElastiCache, allow iam:CreateServiceLinkedRole only when iam:AWSServiceName equals elasticache.amazonaws.com, or have an administrator create that service-linked role first.',
    ],
    credentialExample: 'hv_connections provider="ecs" credentialsRef="file:/absolute/path/aws-ecs.json"',
    notes: [
      'The JSON needs only accessKeyId and secretAccessKey. Region and size belong in environments.<name>.cache; network, subnet, and security-group IDs are never connection credentials.',
      'The ECS project action creates and binds a tagged workload security group in the region\'s exact default VPC. ElastiCache re-observes that binding read-only, creates a dedicated managed security group accepting TCP 6379 only from the workload group, and creates TLS-only serverless Valkey in the exact default subnets.',
      'Deletion waits for provider-confirmed cache absence before removing the managed security group. Cache deletion is data-bearing and exact-action confirmation remains required.',
      'Scope mutation permissions to the intended account, region, default VPC, and Hypervibe-tagged resources where AWS supports resource-level conditions.',
    ],
  },
  ecs: {
    provider: 'ecs',
    displayName: 'AWS ECS Express Mode',
    tokenType: 'AWS IAM access key pair containing accessKeyId and secretAccessKey',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    setupUrls: [
      {
        label: 'Create or review an IAM user access key',
        url: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      },
      {
        label: 'Official ECS Express Mode IAM-role setup',
        url: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-getting-started.html',
      },
      {
        label: 'Official ECS Express Mode infrastructure model',
        url: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html',
      },
    ],
    permissions: [
      'For identity and observation: sts:GetCallerIdentity; ecs:ListClusters, ecs:DescribeClusters, ecs:ListServices, ecs:DescribeServices, ecs:DescribeExpressGatewayService; ecr:DescribeRepositories, ecr:ListTagsForResource; iam:GetRole, iam:ListAttachedRolePolicies; ec2:DescribeVpcs, ec2:DescribeSubnets, ec2:DescribeSecurityGroups; acm:ListCertificates, acm:DescribeCertificate, acm:ListTagsForCertificate; and elasticloadbalancing:DescribeLoadBalancers, DescribeTargetGroups, DescribeListeners, DescribeListenerCertificates, and DescribeRules.',
      'For the reviewed project action: ec2:CreateDefaultVpc when the selected region lacks one, plus ec2:CreateSecurityGroup, ec2:DeleteSecurityGroup, and ec2:CreateTags for the deterministic Hypervibe workload group; ecr:CreateRepository, ecr:DeleteRepository, ecr:TagResource; iam:CreateRole, iam:DeleteRole, iam:TagRole, iam:AttachRolePolicy, iam:DetachRolePolicy, and iam:PassRole limited to Hypervibe hv-* roles; and ecs:CreateCluster, ecs:DeleteCluster, ecs:TagResource.',
      'Allow the project action to attach only AmazonECSTaskExecutionRolePolicy and AmazonECSInfrastructureRoleforExpressGatewayServices. The latter is AWS\'s managed infrastructure policy for Express Mode.',
      'For service lifecycle and CI release: ecs:CreateExpressGatewayService, ecs:UpdateExpressGatewayService, ecs:DeleteExpressGatewayService, ecs:DescribeExpressGatewayService; ecr:GetAuthorizationToken plus ecr:BatchCheckLayerAvailability, ecr:GetDownloadUrlForLayer, ecr:BatchGetImage, ecr:InitiateLayerUpload, ecr:UploadLayerPart, ecr:CompleteLayerUpload, and ecr:PutImage on hypervibe/* repositories; and iam:PassRole for the two exact project roles.',
      'For declared custom domains: acm:RequestCertificate, acm:AddTagsToCertificate, acm:DescribeCertificate, acm:ListCertificates, acm:ListTagsForCertificate, acm:DeleteCertificate, elasticloadbalancing:DescribeLoadBalancers, DescribeTargetGroups, DescribeListeners, DescribeListenerCertificates, DescribeRules, AddListenerCertificates, RemoveListenerCertificates, and ModifyRule on Express-managed load balancers.',
      'If the account has never used ECS, allow iam:CreateServiceLinkedRole only for ECS service-linked roles, or have an administrator create the ECS service-linked role first.',
    ],
    credentialExample: 'hv_connections provider="ecs" credentialsRef="file:/absolute/path/aws-ecs.json"',
    notes: [
      'The JSON needs only accessKeyId and secretAccessKey. Do not include region, cluster, repository, VPC, subnet, security-group, IAM-role, load-balancer, listener, or certificate IDs—Hypervibe creates and binds those through plan/apply. The same verified ecs connection is reused by ElastiCache.',
      'Hypervibe uses us-west-2 when environments.<name>.hosting.region is omitted. An agent may declare another AWS region in the spec when latency, residency, or existing infrastructure requires it.',
      'AWS does not publish a documented pre-filled access-key creation template. The official IAM page cannot safely preselect a user or permissions, so Hypervibe does not invent dashboard query parameters.',
      'ECS Express Mode creates the Fargate service, public HTTPS endpoint, load balancer, security groups, autoscaling, monitoring, and networking components. Hypervibe owns the smaller prerequisite project boundary and exact-digest CI release.',
      'AWS shows a new secret access key only once. Store it outside the repository and rotate it regularly.',
    ],
  },
  doppler: {
    provider: 'doppler',
    displayName: 'Doppler',
    tokenType: 'Doppler read-only service token',
    setupUrl: 'https://dashboard.doppler.com/',
    setupUrls: [
      { label: 'Open the Doppler dashboard and select the project config Access tab', url: 'https://dashboard.doppler.com/' },
      { label: 'Follow the official service-token guide', url: 'https://docs.doppler.com/docs/service-tokens' },
    ],
    permissions: [
      'Create a service token scoped to the project/config Hypervibe should read.',
    ],
    credentialExample: 'hv_connections provider="doppler" credentialsRef="env:DOPPLER_TOKEN"',
    notes: ['Service tokens start with dp.st. and are scoped to a single config.'],
  },
  gcs: {
    provider: 'gcs',
    displayName: 'Google Cloud Storage',
    tokenType: 'Google Application Default Credentials, or service-account JSON for unattended automation',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    setupUrls: [
      {
        label: 'Create or review a dedicated Google Cloud service account',
        url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      },
      {
        label: 'Cloud Storage IAM roles',
        url: 'https://cloud.google.com/storage/docs/access-control/iam-roles',
      },
    ],
    permissions: [
      'Grant roles/storage.admin to the dedicated service account on the target project so Hypervibe can create, label, inspect, empty, and delete its buckets.',
      'Enable storage.googleapis.com in the target project before connecting.',
    ],
    credentialExample: 'hv_connections provider="gcs"',
    notes: [
      'If the project already has a verified cloudrun connection, Hypervibe reuses it; no separate Cloud Storage connection or HMAC key is required.',
      'For local use, run gcloud auth application-default login and gcloud config set project <project-id>, then add the connection without credentials.',
      'For unattended automation, pass the service-account JSON key file directly; Hypervibe derives the project id from that signed credential. Storage location comes from the spec.',
      'Hypervibe enforces uniform bucket-level access and public-access prevention. The service-account JSON is supplied only to selected workloads as a runtime secret and never enters repo bindings or output.',
      'Application Default Credentials can manage and migrate data, but a local gcloud user session is never copied into a workload. Runtime access uses a matching Cloud Run identity or an explicit service account for cross-cloud hosting.',
    ],
  },
  github: {
    provider: 'github',
    displayName: 'GitHub',
    tokenType: 'classic GitHub personal access token with repo, workflow, and read:packages for the one-token setup; or a fine-grained repository token plus a separate classic package-read PAT for least privilege',
    setupUrl: GITHUB_TOKEN_URLS.combined,
    setupUrls: [
      { label: 'Create recommended combined classic token', url: GITHUB_TOKEN_URLS.combined },
      { label: 'Create pre-filled classic API token', url: GITHUB_TOKEN_URLS.api },
      { label: 'Create pre-filled fine-grained repository token', url: GITHUB_TOKEN_URLS.fineGrained },
      { label: 'Create optional classic GHCR package token', url: GITHUB_TOKEN_URLS.packageRead },
      { label: 'GitHub fine-grained permission reference', url: 'https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens' },
    ],
    permissions: [
      'Select the repository owner and only the repositories Hypervibe should manage. Grant Metadata read; Administration read/write; Actions read/write; Contents read/write; Issues read/write; Pull requests read/write; Secrets read/write; and Workflows read/write.',
      'When enabled in desired state, also grant Dependabot alerts read/write, Code scanning alerts read/write, and Secret scanning alerts read/write. Organization policy and product entitlement can still block these settings; Hypervibe reports that without claiming success.',
      'For the one-token classic PAT setup, grant repo, workflow, and read:packages. Hypervibe uses it for API management and package/image reads.',
      `For private GHCR image pulls, packageReadToken must have read:packages — create it here: ${GITHUB_TOKEN_URLS.packageRead}. This can be the same classic PAT only when that PAT also has repo + workflow + read:packages.`,
    ],
    credentialExample: 'hv_connections provider="github" scope="owner/repository" credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_GITHUB_TOKEN"',
    notes: [
      'Save the repository-management PAT as HYPERVIBE_GITHUB_TOKEN in an existing gitignored .env file, replace /absolute/path in the Connect command with that file\'s directory, and let the agent call hv_connections.',
      'Keep a read:packages-only NODE_AUTH_TOKEN separate from HYPERVIBE_GITHUB_TOKEN. When both roles are needed, map apiToken to HYPERVIBE_GITHUB_TOKEN and packageReadToken to NODE_AUTH_TOKEN.',
      'NODE_AUTH_TOKEN, HYPERVIBE_GITHUB_TOKEN, and HYPERVIBE_GITHUB_PACKAGES_TOKEN remain accepted as aliases for compatibility when one explicitly referenced value supplies the requested scalar credential.',
      'An explicitly referenced variable wins. If it is absent and multiple aliases contain different values, Hypervibe blocks instead of guessing.',
      'A read:packages-only token cannot manage repository infrastructure; use it only as packageReadToken.',
      'The fine-grained creation link pre-fills the token name, 90-day expiry, and core repository permissions. You must still choose the resource owner and only the repositories Hypervibe should manage.',
      'Fine-grained PAT responses do not expose classic OAuth scopes. Hypervibe verifies identity and discovers missing endpoint permissions during plan/apply.',
      `A classic apiToken remains supported for compatibility and needs repo + workflow (${GITHUB_TOKEN_URLS.api}); security endpoints may also need security_events.`,
    ],
  },
  gitlab: {
    provider: 'gitlab',
    displayName: 'GitLab',
    tokenType: 'GitLab project access token for an existing project, or a personal access token with api for managed project lifecycle; Railway also needs a separate read_registry project deploy token',
    setupUrl: GITLAB_TOKEN_URLS.api,
    setupUrls: [
      { label: 'Create pre-filled GitLab.com personal access token', url: GITLAB_TOKEN_URLS.api },
      { label: 'GitLab personal access token guide', url: GITLAB_TOKEN_URLS.personalTokenDocs },
      { label: 'GitLab project access token guide', url: GITLAB_TOKEN_URLS.projectTokenDocs },
      { label: 'GitLab deploy token guide', url: GITLAB_TOKEN_URLS.deployTokenDocs },
    ],
    permissions: [
      'For an existing project, grant api and give the token principal Maintainer access. Managed project creation/deletion instead requires a personal access token whose user owns the exact parent namespace (Owner for a group); Hypervibe verifies this before planning either mutation.',
      'For managed rollback, GitLab Premium or Ultimate must protect each hypervibe-rollback-<environment>-* wildcard so only the exact authenticated token user can create it. Role-wide Maintainer access is rejected because it would let another Maintainer manufacture a privileged rollback ref.',
      'For Railway private-image pulls, create a project deploy token in the exact project with read_registry only. Store its generated username as registryUsername and token as registryReadToken.',
    ],
    credentialExample: 'hv_connections provider="gitlab" scope="https://gitlab.com/group/project" credentialsRef="file:/absolute/path/gitlab-connection.json"',
    notes: [
      'The JSON contains apiToken, optional instanceUrl for self-managed GitLab, and registryUsername/registryReadToken for Railway. Keep it outside the repository.',
      'Choose explicit expiries for both tokens and rotate them before expiry. A GitLab deploy token value is shown only when created.',
      'For self-managed GitLab, use the same officially documented personal-token path on the declared HTTPS instance and set instanceUrl; do not use the GitLab.com creation link.',
      'GitLab.com 18.1+ can use the observed hosted Linux runner. Self-managed deploys require one exact locked project runner id, one exact online linux/amd64 manager system id, a dedicated tag, protected-ref-only jobs, and the exact hypervibe-capabilities maintenance-note attestation declared in devops.ci.runner.',
      'GitLab does not expose executor type or Docker privileged mode through these project APIs. The docker-privileged capability is therefore an operator attestation, not provider proof; protect runner administration and verify its config.toml out of band.',
      'The exact project deploy-token page is <project web URL>/-/settings/repository under Deploy tokens; availability and placement can vary by GitLab version.',
    ],
  },
  openai: {
    provider: 'openai',
    displayName: 'OpenAI API',
    tokenType: 'OpenAI project API key stored as apiKey (not a ChatGPT subscription or browser session)',
    setupUrl: 'https://platform.openai.com/api-keys',
    permissions: [
      'Create the key in the OpenAI project that should pay for and audit Hypervibe coding automation.',
      'The project must have access to gpt-5.6-sol and the key must allow model reads plus Responses API writes.',
      'Scope the key to this project and keep it out of the repository; Hypervibe syncs it only as the OPENAI_API_KEY Actions secret.',
    ],
    credentialExample: 'hv_connections provider="openai" scope="owner/repository" credentialsRef="env:OPENAI_API_KEY"',
    notes: [
      'OpenAI API billing is separate from ChatGPT plans. Set project budgets and usage limits in the OpenAI Platform before enabling scheduled AI automation.',
      'The key is never included in specs, plans, logs, snapshots, or workflow files.',
    ],
  },
  local: {
    provider: 'local',
    displayName: 'Local Docker',
    tokenType: 'local Docker socket path',
    permissions: ['The local user must be able to access the Docker socket.'],
    credentialExample: 'hv_connections provider="local" credentials={"dockerSocket":"/var/run/docker.sock"}',
  },
  rds: {
    provider: 'rds',
    displayName: 'Amazon RDS',
    tokenType: 'AWS IAM access key (accessKeyId/secretAccessKey, plus sessionToken for temporary STS credentials)',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    permissions: [
      'For verification and observation: rds:DescribeDBInstances, rds:DescribeDBSubnetGroups, ec2:DescribeVpcs, ec2:DescribeSubnets, ec2:DescribeSecurityGroups, and ec2:DescribeSecurityGroupRules.',
      'For operation-scoped hv_db_query access: ec2:AuthorizeSecurityGroupIngress and ec2:RevokeSecurityGroupIngress on the database security group.',
      'For lifecycle management through hv_plan/hv_apply: rds:CreateDBInstance, rds:DeleteDBInstance, rds:AddTagsToResource, ec2:CreateSecurityGroup, ec2:DeleteSecurityGroup, and ec2:CreateTags.',
    ],
    credentialExample: 'reuse the verified ECS identity automatically with hv_connections provider="ecs" credentialsRef="file:/absolute/path/aws.json"; a separate compatible identity may use hv_connections provider="rds" credentialsRef="file:/absolute/path/rds.json"',
    notes: [
      'RDS desired state is accepted only for ECS-hosted environments. Hypervibe derives region and the exact default-VPC workload network from the persisted ECS binding; it never creates or guesses that hosting network from a database action.',
      'A standalone RDS JSON includes accessKeyId and secretAccessKey, with sessionToken for temporary STS credentials. Legacy region/vpcId/dbSubnetGroupName values must match the bound ECS account, region, and default VPC.',
      'Scope RDS mutation permissions to the intended DB instance ARNs and EC2 mutation permissions to security groups in the intended account, region, and VPC. AWS describe actions generally require Resource="*".',
      'Hypervibe-created RDS instances have one durable PostgreSQL rule from the exact ECS workload security group. hv_db_query may add only the current caller IPv4 /32 under a separate operation-scoped label and removes it after the query.',
      'Prefer temporary STS credentials. IAM user secret access keys are shown only once when created and should be rotated regularly.',
    ],
  },
  s3: {
    provider: 's3',
    displayName: 'Amazon S3',
    tokenType: 'AWS default credential chain (AWS CLI profile, SSO, environment, or instance identity), or an explicit access-key pair for automation',
    setupUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    setupUrls: [
      {
        label: 'Create or rotate an IAM access key',
        url: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      },
      {
        label: 'Amazon S3 API permissions reference',
        url: 'https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html',
      },
    ],
    permissions: [
      'Grant sts:GetCallerIdentity and s3:ListAllMyBuckets for connection verification and managed-bucket discovery.',
      'Grant s3:CreateBucket, s3:GetBucketLocation, s3:GetBucketTagging, s3:PutBucketTagging, s3:PutBucketPublicAccessBlock, s3:PutEncryptionConfiguration, and s3:DeleteBucket for lifecycle management.',
      'On Hypervibe-created hv-* buckets, grant s3:ListBucket, s3:ListBucketVersions, s3:GetObject, s3:GetObjectVersion, s3:PutObject, s3:DeleteObject, and s3:DeleteObjectVersion for usage observation, migration, and confirmed teardown.',
    ],
    credentialExample: 'hv_connections provider="s3"',
    notes: [
      'If the project already has a verified ecs connection, Hypervibe reuses it; no separate S3 connection or bucket access key is required.',
      'For local use, authenticate normally with the AWS CLI and select a profile through AWS_PROFILE when needed; then add the connection without credentials. Hypervibe uses the AWS SDK default credential chain.',
      'For unattended automation, a standalone connection JSON may contain accessKeyId and secretAccessKey. Storage region comes from the spec. Never use root-user access keys.',
      'Hypervibe creates a private, public-access-blocked, AES-256-encrypted bucket and refuses to adopt an untagged name collision.',
      'Temporary CLI/SSO credentials can manage and migrate data but are never copied into a deployed service. Runtime access uses workload identity or an explicit durable credential.',
    ],
  },
  railway: {
    provider: 'railway',
    displayName: 'Railway',
    tokenType: 'Railway Account API token (create with "No workspace" selected)',
    setupUrl: 'https://railway.com/account/tokens',
    permissions: [
      'Account tokens act with your access across workspaces; Hypervibe needs one that can create projects, services, environments, variables, databases, domains, and deployments in the target workspace.',
    ],
    credentialExample: 'hv_connections provider="railway" credentialsRef="dotenv:/absolute/path/.env#HYPERVIBE_RAILWAY_TOKEN"',
    notes: [
      'Create the token at https://railway.com/account/tokens and select "No workspace" so it is an account token. Hypervibe verifies with the GraphQL me query, which Railway documents as unusable with workspace or project tokens — workspace-scoped tokens fail verification.',
      'Do NOT use a Project token (from a project\'s settings page): project tokens are scoped to one environment, use a different auth header, and cannot call the account-level API Hypervibe needs.',
      'If multiple workspaces are visible, include workspaceId: credentialsMap={"apiToken":"HYPERVIBE_RAILWAY_TOKEN","workspaceId":"RAILWAY_WORKSPACE_ID"} so projects are created in the right workspace.',
    ],
  },
  vercel: {
    provider: 'vercel',
    displayName: 'Vercel',
    tokenType: 'Vercel personal access token created under the Personal Account and scoped to the intended personal account or Team (new tokens normally use the vcp_ prefix)',
    setupUrl: 'https://vercel.com/account/settings/tokens',
    setupUrls: [
      {
        label: 'Create or review Vercel personal access tokens',
        url: 'https://vercel.com/account/settings/tokens',
      },
      {
        label: 'Vercel access-token and Team-scope guidance',
        url: 'https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token',
      },
      {
        label: 'Vercel roles and extended permissions',
        url: 'https://vercel.com/docs/rbac/access-roles',
      },
    ],
    permissions: [
      'For a Team scope, use an Owner or Member token identity, or a Developer/Contributor identity granted Create Project, Full Production Deployment, and Environment Variable Manager permissions for the intended Team.',
      'Hypervibe needs REST access to read/create/delete Projects, read and upsert/delete Project environment variables, upload deployment files, and create/read production Deployments.',
      'Declared custom domains additionally require REST access to add, inspect/verify, and remove domains on the exact Project.',
      'Scope the token to only the intended Vercel Team when possible and include that immutable teamId in the connection JSON; omit teamId only for a personal-account deployment scope.',
    ],
    credentialExample: 'hv_connections provider="vercel" credentialsRef="file:/absolute/path/vercel.json"',
    notes: [
      'The JSON must contain accessToken and may contain teamId. Find the immutable Team ID under Team Settings -> General; Hypervibe records only a non-secret team:<id> or user:<id> binding.',
      'VERCEL_ACCESS_TOKEN, VERCEL_TOKEN, and HYPERVIBE_VERCEL_ACCESS_TOKEN are accepted aliases when resolving a scalar accessToken. Use a JSON file or credentialsMap when teamId is required.',
      'Hypervibe creates source-less Vercel Projects and deploys exact checked-out Git files through the REST API. If a bound Project has a Vercel-native Git link, CI reconciliation blocks until that link is manually disconnected.',
      'The Vercel hosting slice supports public web projects built by Vercel framework/static auto-detection. It rejects workers, cron jobs, release commands, arbitrary long-lived start commands, and build/Dockerfile overrides it cannot honestly apply.',
      'Project creation and production deployments may consume metered build/function resources. Hypervibe confirmation-gates service creation and never creates Projects from the managed CI workflow.',
    ],
  },
  sendgrid: {
    provider: 'sendgrid',
    displayName: 'SendGrid',
    tokenType: 'SendGrid API key (Restricted Access for least privilege; Full Access is the reliable choice during setup)',
    setupUrl: 'https://app.sendgrid.com/settings/api_keys',
    permissions: [
      'Grant mail.send so Hypervibe can sync a runtime SENDGRID_API_KEY that can send transactional email.',
      'For domain authentication: whitelabel.read, whitelabel.create, whitelabel.update (SendGrid still names these scopes "whitelabel" even though the UI says Sender Authentication).',
      'For single-sender verification: SendGrid publishes no restricted scope for the /verified_senders API — use a Full Access key for this path; hypervibe checks user.email.* as a best-effort signal.',
      'For event webhook setup: user.webhooks.event.settings.read and user.webhooks.event.settings.update.',
      'For SendGrid Inbound Parse: user.webhooks.parse.settings read/create/delete.',
    ],
    credentialExample: 'hv_connections provider="sendgrid" credentialsRef="dotenv:/absolute/path/.env#SENDGRID_API_KEY"',
    notes: [
      'Setup needs mail.send plus EITHER domain authentication OR sender verification — not necessarily all scopes.',
      'Full Access is acceptable during setup; rotate to a narrower runtime key after sender/domain authorization if desired. Note some restricted keys cannot call GET /v3/scopes, which fails verification even for usable keys.',
    ],
  },
  twilio: {
    provider: 'twilio',
    displayName: 'Twilio',
    tokenType: 'four values from the same Twilio account or subaccount: Account SID (AC...), Restricted API Key SID (SK...), its one-time API Key Secret, and the primary Account Auth Token',
    setupUrl: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
    setupUrls: [
      {
        label: 'Account SID and primary Auth Token (Console Dashboard -> Account Info)',
        url: 'https://console.twilio.com/',
      },
      {
        label: 'Restricted API Key SID and one-time secret (Settings -> Account settings -> API keys & auth tokens)',
        url: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
      },
      {
        label: 'Existing phone numbers and PN... SIDs (Products & Services -> Numbers & Senders -> Phone Numbers)',
        url: 'https://console.twilio.com/us1/develop/phone-numbers/manage/incoming',
      },
      {
        label: 'Messaging Services and MG... SIDs (Hypervibe normally creates or adopts these)',
        url: 'https://console.twilio.com/us1/develop/sms/services',
      },
    ],
    permissions: [
      'On the Restricted key Permissions screen enable twilio/messaging/services/list, twilio/messaging/services/read, twilio/messaging/services/create, and twilio/messaging/services/update.',
      'Enable twilio/messaging/services.phonenumbers/list, twilio/messaging/services.phonenumbers/create, and twilio/messaging/services.phonenumbers/delete so Hypervibe can observe, attach, and confirmation-gate moves of an existing number.',
      'Enable twilio/messaging/messages/create so the application can send through the Messaging Service after Hypervibe projects the same restricted key at runtime.',
      'The primary Account Auth Token has no restricted scopes. It is required at runtime because Twilio signs inbound and delivery-status webhooks with that token in X-Twilio-Signature.',
    ],
    credentialExample: 'hv_connections provider="twilio" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"accountSid":"TWILIO_ACCOUNT_SID","apiKeySid":"TWILIO_API_KEY_SID","apiKeySecret":"TWILIO_API_KEY_SECRET","authToken":"TWILIO_AUTH_TOKEN"}',
    notes: [
      'First switch the Twilio Console to the exact parent account or subaccount that owns the phone number. The AC..., SK..., Auth Token, and optional PN... SID must all belong to that same account.',
      'Copy TWILIO_ACCOUNT_SID from Console Dashboard -> Account Info. It is 34 characters and starts with AC.',
      'Create a Restricted API key under Settings -> Account settings -> API keys & auth tokens. Copy its SK... SID and secret immediately: Twilio displays the secret only once. A Standard key also works but is broader than necessary.',
      'Reveal the primary Auth Token under Console Dashboard -> Account Info (or the Auth Tokens section on API keys & auth tokens). Do not substitute the API Key Secret or a test credential; webhook validation requires the matching primary account Auth Token.',
      'Put only the four connection values in the local dotenv file: TWILIO_ACCOUNT_SID=AC..., TWILIO_API_KEY_SID=SK..., TWILIO_API_KEY_SECRET=..., and TWILIO_AUTH_TOKEN=.... Keep that file out of git.',
      'To attach a sender, open Products & Services -> Numbers & Senders -> Phone Numbers, select an existing SMS-capable number, and copy its 34-character PN... SID into messaging.sender.phoneNumberSid. Use the SID, not the +E.164 phone number.',
      'Do not add TWILIO_MESSAGING_SERVICE_SID to the connection or spec. Hypervibe creates or explicitly adopts the Messaging Service by service.name, records the resulting MG... SID, and projects it at apply time.',
      'The sender block is optional. Hypervibe does not buy phone numbers or complete A2P 10DLC, toll-free verification, or other regulatory registration; complete any required registration in Twilio before production sending.',
      'The Auth Token is a high-privilege account credential. Hypervibe encrypts it locally and projects it only to services explicitly named by messaging.services.',
    ],
  },
  stripe: {
    provider: 'stripe',
    displayName: 'Stripe',
    tokenType: 'Stripe server API key for one environment: a restricted key (rk_test_... for a named sandbox or rk_live_... for production) is preferred; unrestricted sk_test_.../sk_live_... keys also work. Pass it in secretKey with the optional matching publishableKey (pk_test_.../pk_live_...). Legacy global sandboxSecretKey/liveSecretKey fields remain supported',
    setupUrl: 'https://dashboard.stripe.com/apikeys',
    setupUrls: [
      { label: 'Create or replace a named development sandbox', url: 'https://dashboard.stripe.com/' },
      { label: 'Create the selected sandbox API key', url: 'https://dashboard.stripe.com/apikeys' },
      { label: 'Stripe sandbox setup guide', url: 'https://docs.stripe.com/sandboxes/dashboard/manage' },
    ],
    permissions: [
      'For Hypervibe reconciliation, a restricted key needs Accounts: Read plus Products, Prices, and Webhook Endpoints: Write. Write includes read. An unrestricted secret key is a broader fallback.',
      'If the same key is projected to an application seed that creates development fixtures, also grant only the resources that seed uses—normally Customers and Subscriptions: Write, plus Payment Methods or Test Clocks: Write when those workflows are declared by the application.',
      'Create a separate scoped connection for each isolated Stripe sandbox and for production; the scope should match payments.stripe.environment (normally development, staging, or production).',
    ],
    credentialExample: 'hv_connections provider="stripe" scope="development" credentialsRef="dotenv:/absolute/path/.env.stripe.development" credentialsMap={"secretKey":"STRIPE_SECRET_KEY","publishableKey":"STRIPE_PUBLISHABLE_KEY"}',
    notes: [
      'Fresh development workflow: in the Stripe account picker choose Switch to sandbox -> Create sandbox, name it for the project or workflow, open it, create its API key, save the key pair in a gitignored .env.stripe.development file, then run the scoped hv_connections example. Ordinary sandbox keys cannot create another sandbox.',
      'To reset development later, create a new named sandbox, replace the two local dotenv values, and run the same hv_connections call again. hv_plan will observe an empty Stripe target and review recreation of the catalog and webhooks; the old sandbox remains untouched until you delete it in Stripe.',
      'Keep customer, subscription, persona, and entitlement fixtures in the application database.seedCommand. In managed CI, Hypervibe deploys and verifies the exact desired commit before starting a newly declared seed command.',
      'Stripe idempotency keys are retry protection, not durable fixture identity. The application seed should reconcile stored Stripe IDs and deterministic metadata before creating missing customers or subscriptions.',
      'Omit publishableKey from both the spec credential projection and credentialsMap when the application does not use it.',
      'A global legacy connection can still carry sandboxSecretKey/sandboxPublishableKey plus liveSecretKey/livePublishableKey, but separate scoped connections are required when development and staging use different Stripe sandboxes.',
    ],
  },
  'stripe-projects': {
    provider: 'stripe-projects',
    displayName: 'Stripe Projects',
    tokenType: 'Official Stripe CLI with the Projects plugin, a linked repository, and an already-pulled active project environment; Hypervibe stores no Stripe Projects credential value',
    setupUrl: 'https://projects.dev/',
    setupUrls: [
      { label: 'Install the official Stripe CLI', url: 'https://docs.stripe.com/stripe-cli/install' },
      { label: 'Set up Stripe Projects', url: 'https://projects.dev/' },
    ],
    permissions: [
      'The local Stripe Projects setup must include the provider/service and environment fields Hypervibe should read.',
      'Run the explicit Stripe Projects pull as the signed-in operator after selecting the intended environment; Hypervibe reads only that existing local output.',
    ],
    credentialExample: 'hv_connections provider="stripe-projects"',
    notes: [
      'References use stripe-projects://<environment>/<provider>/<service>, for example stripe-projects://production/cloudflare/workers.',
      'Map the exact service fields reported by Stripe Projects into the destination provider with credentialsMap, for example hv_connections provider="cloudflare" credentialsRef="stripe-projects://production/cloudflare/workers" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_WORKERS_ACCOUNT_ID"}.',
      'Hypervibe never runs Stripe Projects pull, refresh, environment selection/update, provider linking, provisioning, or credential rotation. If the selected environment or local output is stale, it stops with the exact explicit Stripe CLI commands for the operator.',
      'The Stripe-managed output must be a regular, non-symlink file inside the linked repository and owner-only on POSIX systems (chmod 600).',
    ],
  },
  supabase: {
    provider: 'supabase',
    displayName: 'Supabase',
    tokenType: 'Supabase personal access token',
    setupUrl: 'https://supabase.com/dashboard/account/tokens',
    permissions: [
      'Personal access tokens are not permission-scoped: they carry your full account privileges. Your account must be an Owner or Administrator of the target organization to create projects (Developer/Read-only roles cannot).',
      'Include organizationId when multiple organizations are visible.',
    ],
    credentialExample: 'hv_connections provider="supabase" credentialsRef="dotenv:/absolute/path/.env#SUPABASE_ACCESS_TOKEN"',
  },
  neon: {
    provider: 'neon',
    displayName: 'Neon',
    tokenType: 'Neon personal API key or organization API key with project create/read/delete access (not a project-scoped organization key)',
    setupUrl: 'https://console.neon.tech/app/settings/api-keys',
    permissions: [
      'Use a personal API key for personal projects, or a personal API key with organizationId / an organization API key for organization projects; the identity must be allowed to create, read, and delete projects in the target account or organization.',
      'Do not use a project-scoped organization API key: Neon limits it to one existing project and explicitly prevents destructive project operations such as project deletion.',
    ],
    credentialExample: 'hv_connections provider="neon" credentialsRef="dotenv:/absolute/path/.env#NEON_API_KEY"',
    notes: [
      'organizationId is required when a personal API key should manage organization-owned projects; use credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiKey":"NEON_API_KEY","organizationId":"NEON_ORGANIZATION_ID"} in that case. Omit it for personal projects or when an organization API key already infers the organization.',
      'regionId is optional and uses Neon region IDs such as aws-us-west-2. The API key token is shown only when created, so store it in a dotenv file or secret manager instead of chat.',
    ],
  },
  vault: {
    provider: 'vault',
    displayName: 'HashiCorp Vault',
    tokenType: 'Vault token or AppRole role_id/secret_id',
    setupUrl: 'https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2',
    permissions: [
      'read on <mount>/data/<path> and list on <mount>/metadata/<path> for the KV v2 secrets Hypervibe should resolve.',
      'Add create/update on <mount>/data/<path> if Hypervibe should write secrets, and delete on <mount>/metadata/<path> if it should delete them (deletion removes all versions).',
      "auth/token/lookup-self is used for verification; it is included in Vault's default policy.",
    ],
    credentialExample: 'hv_connections provider="vault" credentialsRef="file:/absolute/path/vault.json"',
  },
};

export function getConnectionGuidance(provider: string): ConnectionGuidance | undefined {
  return GUIDANCE[provider];
}

function credentialExample(
  guidance: ConnectionGuidance,
  options: { scope?: string; project?: string; requiredCredentialKeys?: string[] } = {}
): string {
  let example = guidance.credentialExample;
  switch (guidance.provider) {
    case 'cloudflare': {
      const required = new Set(options.requiredCredentialKeys ?? []);
      if (options.requiredCredentialKeys && required.has('registrarApiToken')) {
        const credentialsMap = {
          apiToken: 'CLOUDFLARE_API_TOKEN',
          ...(required.has('accountId') ? { accountId: 'CLOUDFLARE_ACCOUNT_ID' } : {}),
          registrarApiToken: 'CLOUDFLARE_REGISTRAR_API_TOKEN',
        };
        example = `hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap=${JSON.stringify(credentialsMap)}`;
      } else if (options.requiredCredentialKeys && required.has('accountId')) {
        example = 'hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}';
      } else if (options.requiredCredentialKeys) {
        example = 'hv_connections provider="cloudflare" scope="example.com" credentialsRef="dotenv:/absolute/path/.env#CLOUDFLARE_API_TOKEN"';
      }
      if (options.scope) example = example.replaceAll('scope="example.com"', `scope="${options.scope}"`);
      break;
    }
    case 'github':
      if (options.requiredCredentialKeys?.includes('packageReadToken')) {
        example = 'hv_connections provider="github" scope="owner/repository" credentialsRef="dotenv:/absolute/path/.env" credentialsMap={"apiToken":"HYPERVIBE_GITHUB_TOKEN","packageReadToken":"NODE_AUTH_TOKEN"}';
      }
      if (options.scope) example = example.replace('scope="owner/repository"', `scope="${options.scope}"`);
      break;
    case 'database':
      if (options.scope) example = example.replace('provider="database"', `provider="database" scope="${options.scope}"`);
      break;
    case 'appstoreconnect':
      if (options.scope) example = example.replace('provider="appstoreconnect"', `provider="appstoreconnect" scope="${options.scope}"`);
      break;
    case 'stripe':
      if (options.scope) example = example.replace('scope="development"', `scope="${options.scope}"`);
      break;
    case 'elasticache':
      if (options.scope) example = example.replace('provider="ecs"', `provider="ecs" scope="${options.scope}"`);
      break;
  }
  if (options.scope && !example.includes(`scope="${options.scope}"`)) {
    example = example.replace(
      `provider="${guidance.provider}"`,
      `provider="${guidance.provider}" scope="${options.scope}"`
    );
  }
  return options.project
    ? example.replace('hv_connections ', `hv_connections project="${options.project}" `)
    : example;
}

export function connectionSetupDetails(
  provider: string,
  options: { scope?: string; project?: string; requiredCredentialKeys?: string[] } = {}
): ConnectionSetupDetails {
  const guidance = getConnectionGuidance(provider);
  if (!guidance) {
    return {
      provider,
      ...(options.project ? { project: options.project } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      setupUrls: [],
      requiredPermissions: [],
      credentialExample: `hv_connections ${options.project ? `project="${options.project}" ` : ''}provider="${provider}" credentialsRef="env:NAME"`,
      notes: [
        'Run hv_connections to see the provider schema and credential fields.',
        'Prefer credentialsRef="env:NAME", credentialsRef="dotenv:/absolute/path/.env#KEY", or credentialsRef="file:/absolute/path" so secrets do not enter chat.',
      ],
    };
  }

  const setupUrls = guidance.setupUrls?.length
    ? guidance.setupUrls.map((entry) => `${entry.label}: ${entry.url}`)
    : guidance.setupUrl ? [guidance.setupUrl] : [];

  const recommendedSetupUrl = provider === 'github'
    ? options.requiredCredentialKeys?.includes('packageReadToken')
      ? GITHUB_TOKEN_URLS.combined
      : GITHUB_TOKEN_URLS.api
    : guidance.setupUrl ?? guidance.setupUrls?.[0]?.url;

  return {
    provider,
    ...(options.project ? { project: options.project } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    displayName: guidance.displayName,
    tokenType: guidance.tokenType,
    ...(recommendedSetupUrl
      ? { recommendedSetupUrl }
      : {}),
    setupUrls,
    requiredPermissions: guidance.permissions,
    credentialExample: credentialExample(guidance, options),
    ...(guidance.notes?.length ? { notes: guidance.notes } : {}),
  };
}

/** Shared application-boundary payload for one unavailable provider connection. */
export function connectionSetupOptions(
  provider: string,
  options: { scope?: string; project?: string } = {}
) {
  return {
    details: { connectionSetup: connectionSetupDetails(provider, options) },
    hint: formatConnectionGuidance(provider, { scope: options.scope }),
    next: ['hv_connections'],
  };
}

export function formatConnectionGuidance(
  provider: string,
  options: { scope?: string; intro?: string } = {}
): string {
  const guidance = getConnectionGuidance(provider);
  const scopeText = options.scope ? ` for ${options.scope}` : '';
  if (!guidance) {
    return [
      options.intro ?? `Confirm the ${provider} credential type and permissions${scopeText}.`,
      'Use hv_connections to see the provider schema and use credentialsRef="env:NAME" or credentialsRef="dotenv:/absolute/path/.env#KEY" where possible.',
    ].join(' ');
  }

  const parts = [
    options.intro ?? `Confirm the ${guidance.displayName} credential type and permissions${scopeText}.`,
    `Token/credential type: ${guidance.tokenType}.`,
    guidance.setupUrls?.length
      ? `Create or review it here: ${guidance.setupUrls.map((entry) => `${entry.label}: ${entry.url}`).join('; ')}.`
      : guidance.setupUrl ? `Create or review it here: ${guidance.setupUrl}.` : undefined,
    `Required permissions: ${guidance.permissions.join(' ')}`,
    guidance.notes?.length ? `Notes: ${guidance.notes.join(' ')}` : undefined,
    `Connect with: ${credentialExample(guidance, { scope: options.scope })}.`,
  ].filter(Boolean);
  return parts.join(' ');
}
