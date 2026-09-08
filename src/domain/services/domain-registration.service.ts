import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { cloudflareTokenKind } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type {
  RegistrarDomainCandidate,
  RegistrarWorkflowStatus,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { getCloudflareAdapter } from './cloudflare-ops.service.js';
import { cloudflareScopeHintsForDomain } from './domain-scope.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { CLOUDFLARE_TOKEN_URLS } from './connection-guidance.js';

const OPERATION = 'cloudflareRegistrarRegistration';

interface DomainRegistrationBinding {
  provider?: string;
  accountId?: string;
  state?: string;
  completed?: boolean;
  links?: { self?: string; resource?: string };
  updatedAt?: string;
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.$/, '').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function summarizeRegistrarDomain(domain: RegistrarDomainCandidate) {
  return {
    name: normalizeDomain(domain.name),
    registrable: domain.registrable,
    tier: domain.tier ?? null,
    reason: domain.reason ?? null,
    pricing: domain.pricing
      ? {
        currency: domain.pricing.currency,
        registrationCost: domain.pricing.registration_cost,
        renewalCost: domain.pricing.renewal_cost,
      }
      : null,
  };
}

function registrationOptions(environmentSpec: EnvironmentSpec): Record<string, unknown> {
  const spec = environmentSpec.domainRegistration;
  return {
    years: spec?.years ?? 'default',
    autoRenew: spec?.autoRenew ?? false,
    privacyMode: spec?.privacyMode ?? 'redaction',
  };
}

function registrationBinding(environment: Environment | null, domain: string): DomainRegistrationBinding | null {
  const registrations = asRecord(environment?.platformBindings?.domainRegistrations);
  return asRecord(registrations?.[domain]) as DomainRegistrationBinding | null;
}

export interface CloudflareRegistrarCredentialRequirement {
  reason: string;
  requiredCredentialKeys: Array<'apiToken' | 'accountId' | 'registrarApiToken'>;
}

/**
 * Return the value-free credential roles needed to replace a Cloudflare
 * connection without dropping the already-working DNS identity. Connection
 * adds replace the complete credential object, so a Registrar-only map is not
 * executable even though registrarApiToken is the newly missing role.
 */
export function cloudflareRegistrarCredentialRequirement(
  domain: string
): CloudflareRegistrarCredentialRequirement | null {
  const connection = new ConnectionRepository().findBestVerifiedMatchFromHints(
    'cloudflare',
    cloudflareScopeHintsForDomain(domain)
  );
  if (!connection) return null;

  const credentials = getSecretStore().decryptObject<{
    apiToken?: string;
    apiTokenKind?: 'user' | 'account' | 'unknown';
    accountId?: string;
    registrarApiToken?: string;
  }>(connection.credentialsEncrypted);
  const apiTokenIsAccountOwned = Boolean(credentials.apiToken) && (
    cloudflareTokenKind(credentials.apiToken!) === 'account'
    || credentials.apiTokenKind === 'account'
  );
  const requiredCredentialKeys: CloudflareRegistrarCredentialRequirement['requiredCredentialKeys'] = [
    'apiToken',
    ...(apiTokenIsAccountOwned && credentials.accountId?.trim() ? ['accountId' as const] : []),
    'registrarApiToken',
  ];
  const registrarToken = credentials.registrarApiToken?.trim();
  if (registrarToken) {
    if (cloudflareTokenKind(registrarToken) === 'account') {
      return {
        reason: `Cloudflare domain registration for ${domain} requires a Cloudflare User API Token (usually cfut_), but the stored registrarApiToken is an Account API Token (usually cfat_). Start from the pre-filled Hypervibe User API Token template at ${CLOUDFLARE_TOKEN_URLS.user}, narrow it to the target account/zone, and add Registrar write permissions before creating it. Then either use it as apiToken/CLOUDFLARE_API_TOKEN for a single-token setup, or keep the Account API Token as apiToken and store the User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN.`,
        requiredCredentialKeys,
      };
    }
    return null;
  }

  if (apiTokenIsAccountOwned) {
    return {
      reason: `Cloudflare domain registration for ${domain} cannot use the stored apiToken because it is an Account API Token (usually cfat_). Account API Tokens are correct for durable DNS/custom-domain/email automation, but Cloudflare Registrar requires a User API Token (usually cfut_). Start from the pre-filled Hypervibe User API Token template at ${CLOUDFLARE_TOKEN_URLS.user}, narrow it to the target account/zone, and add Registrar write permissions before creating it. Then either use it as apiToken/CLOUDFLARE_API_TOKEN for a single-token setup, or keep the Account API Token as apiToken and store the User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN.`,
      requiredCredentialKeys,
    };
  }

  return null;
}

export function cloudflareRegistrarCredentialProblem(domain: string): string | null {
  return cloudflareRegistrarCredentialRequirement(domain)?.reason ?? null;
}

function workflowActionResult(domain: string, workflow: RegistrarWorkflowStatus, action: 'started' | 'polled'): ActionResult {
  if (workflow.state === 'succeeded') {
    return { success: true, message: `Cloudflare registration for ${domain} succeeded`, data: { workflow } };
  }
  if (workflow.state === 'failed' || workflow.completed) {
    return {
      success: false,
      message: `Cloudflare registration for ${domain} failed`,
      error: workflow.error?.message ?? `Registration workflow reached terminal state ${workflow.state}.`,
      data: { workflow },
    };
  }
  if (workflow.state === 'action_required') {
    return {
      success: false,
      status: 'blocked',
      message: `Cloudflare registration for ${domain} requires user action`,
      error: workflow.error?.message ?? 'Cloudflare paused the registration workflow and requires user action before Hypervibe can continue.',
      data: { workflow },
    };
  }

  const verb = action === 'started' ? 'started and is' : 'is';
  const extra = workflow.state === 'blocked'
    ? 'Cloudflare says progress is blocked by a third party such as the registry; re-run hv_plan/hv_apply later to poll it.'
    : 'Re-run hv_plan/hv_apply later to poll it.';
  return {
    success: false,
    status: 'pending',
    message: `Cloudflare registration for ${domain} ${verb} ${workflow.state}. ${extra}`,
    data: { workflow },
  };
}

function registrationAction(params: {
  domain: string;
  accountId: string;
  type: 'create' | 'update';
  reason: string;
  candidate?: RegistrarDomainCandidate;
  binding?: DomainRegistrationBinding;
  environmentSpec: EnvironmentSpec;
}): PlanAction {
  return {
    id: `domain:${params.domain}:register`,
    type: params.type,
    resource: { kind: 'domain', name: params.domain, provider: 'cloudflare' },
    verified: true,
    reason: params.reason,
    ...(params.type === 'create' ? { billable: true, requiresConfirm: true } : {}),
    metadata: {
      operation: OPERATION,
      accountId: params.accountId,
      registration: registrationOptions(params.environmentSpec),
      ...(params.candidate ? { candidate: summarizeRegistrarDomain(params.candidate) } : {}),
      ...(params.binding ? { workflow: params.binding } : {}),
    },
  };
}

export function isCloudflareDomainRegistrationAction(action: PlanAction): boolean {
  return action.metadata?.operation === OPERATION;
}

export function addDomainRegistrationDependency(actions: PlanAction[], registrationActionId: string): PlanAction[] {
  return actions.map((action) => {
    if (action.id === registrationActionId || action.type === 'noop') {
      return action;
    }
    if (!['project', 'environment', 'service', 'domain'].includes(action.resource.kind)) {
      return action;
    }
    const dependsOn = Array.from(new Set([...(action.dependsOn ?? []), registrationActionId]));
    return { ...action, dependsOn };
  });
}

export async function planCloudflareDomainRegistration(params: {
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { environmentSpec, environment } = params;
  const warnings: string[] = [];
  const registrationSpec = environmentSpec.domainRegistration;
  if (!registrationSpec?.register || !environmentSpec.domain) {
    return { warnings };
  }

  const domain = normalizeDomain(environmentSpec.domain);
  const adapterResult = getCloudflareAdapter(domain);
  if ('error' in adapterResult) {
    warnings.push(`Cannot plan Cloudflare Registrar for ${domain}: ${adapterResult.error}`);
    return { warnings };
  }
  const { adapter } = adapterResult;

  let accountId: string;
  try {
    accountId = await adapter.resolveAccountId(registrationSpec.accountId);
  } catch (error) {
    warnings.push(`Cannot plan Cloudflare Registrar for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return { warnings };
  }

  const binding = registrationBinding(environment, domain);
  if (binding?.completed && binding.state === 'succeeded') {
    return { warnings };
  }
  if (binding?.state && !binding.completed && binding.state !== 'failed') {
    return {
      action: registrationAction({
        domain,
        accountId: binding.accountId ?? accountId,
        type: 'update',
        reason: `Cloudflare registration workflow for ${domain} is ${binding.state}; apply will poll it before continuing.`,
        binding,
        environmentSpec,
      }),
      warnings,
    };
  }

  let candidate: RegistrarDomainCandidate | undefined;
  try {
    const checked = await adapter.checkRegistrarDomains(accountId, [domain]);
    candidate = checked.find((entry) => normalizeDomain(entry.name) === domain);
  } catch (error) {
    warnings.push(`Cloudflare Registrar availability check failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return { warnings };
  }

  if (!candidate) {
    warnings.push(`Cloudflare did not return an availability result for ${domain}; domain registration cannot be planned.`);
    return { warnings };
  }
  if (!candidate.registrable) {
    warnings.push(`Cloudflare reports ${domain} is not registrable through the Registrar API${candidate.reason ? ` (${candidate.reason})` : ''}.`);
    return { warnings };
  }
  if (candidate.tier === 'premium') {
    warnings.push(`Cloudflare reports ${domain} is premium priced; Registrar API registration is not supported for premium domains.`);
    return { warnings };
  }

  const pricing = candidate.pricing
    ? ` (${candidate.pricing.currency} ${candidate.pricing.registration_cost} registration, ${candidate.pricing.renewal_cost} renewal)`
    : '';
  return {
    action: registrationAction({
      domain,
      accountId,
      type: 'create',
      reason: `Domain ${domain} is available for Cloudflare registration${pricing}. This is billable and successful registrations are non-refundable.`,
      candidate,
      environmentSpec,
    }),
    warnings,
  };
}

export async function applyCloudflareDomainRegistration(params: {
  project: Project;
  envName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const { project, envName, environmentSpec, action } = params;
  const domain = normalizeDomain(action.resource.name);
  const registrationSpec = environmentSpec.domainRegistration;
  if (!registrationSpec?.register) {
    return { success: true, message: `No registration requested for ${domain}` };
  }

  const adapterResult = getCloudflareAdapter(domain);
  if ('error' in adapterResult) {
    return { success: false, message: 'Cloudflare adapter unavailable', error: adapterResult.error };
  }
  const { adapter } = adapterResult;

  let accountId: string;
  try {
    accountId = await adapter.resolveAccountId(registrationSpec.accountId);
  } catch (error) {
    return {
      success: false,
      message: 'Cloudflare account could not be resolved',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, envName);
  const binding = registrationBinding(environment, domain);
  const plannedAccountId = typeof action.metadata?.accountId === 'string'
    ? action.metadata.accountId
    : undefined;
  const effectiveAccountId = binding?.state && !binding.completed && binding.state !== 'failed'
    ? binding.accountId ?? accountId
    : accountId;
  if (!plannedAccountId || plannedAccountId !== effectiveAccountId) {
    return {
      success: false,
      status: 'blocked',
      message: `Cloudflare registration action for ${domain} has stale account authority`,
      error: `The reviewed account is ${plannedAccountId ?? 'missing'}, but the current registration target is ${effectiveAccountId}. Re-run hv_plan.`,
    };
  }

  if (binding?.state && !binding.completed && binding.state !== 'failed') {
    try {
      const workflow = await adapter.getRegistrarRegistrationStatus(effectiveAccountId, domain);
      persistWorkflow(envRepo, project, envName, domain, effectiveAccountId, workflow);
      return workflowActionResult(domain, workflow, 'polled');
    } catch (error) {
      return {
        success: false,
        message: `Failed to poll Cloudflare registration for ${domain}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let candidate: RegistrarDomainCandidate | undefined;
  try {
    const checked = await adapter.checkRegistrarDomains(accountId, [domain]);
    candidate = checked.find((entry) => normalizeDomain(entry.name) === domain);
  } catch (error) {
    return {
      success: false,
      message: `Cloudflare availability check failed for ${domain}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!candidate?.registrable) {
    return {
      success: false,
      message: `${domain} is not registrable through Cloudflare Registrar API`,
      error: candidate?.reason ?? 'No registrable availability result returned',
      data: candidate ? { candidate: summarizeRegistrarDomain(candidate) } : undefined,
    };
  }
  if (candidate.tier === 'premium') {
    return {
      success: false,
      message: `${domain} is premium priced`,
      error: 'Cloudflare Registrar API does not support premium domain registration.',
      data: { candidate: summarizeRegistrarDomain(candidate) },
    };
  }

  const reviewedCandidate = asRecord(action.metadata?.candidate);
  const reviewedRegistration = asRecord(action.metadata?.registration);
  const currentCandidate = summarizeRegistrarDomain(candidate);
  const currentRegistration = registrationOptions(environmentSpec);
  if (
    !reviewedCandidate
    || !reviewedRegistration
    || JSON.stringify(reviewedCandidate) !== JSON.stringify(currentCandidate)
    || JSON.stringify(reviewedRegistration) !== JSON.stringify(currentRegistration)
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Cloudflare registration terms for ${domain} changed after planning`,
      error: 'Availability, pricing, tier, or registration options no longer match the explicitly confirmed plan. Re-run hv_plan and review the new billable action.',
      data: { candidate: currentCandidate },
    };
  }

  try {
    const workflow = await adapter.createRegistrarRegistration(accountId, {
      domainName: domain,
      ...(registrationSpec.autoRenew !== undefined ? { autoRenew: registrationSpec.autoRenew } : {}),
      ...(registrationSpec.privacyMode ? { privacyMode: registrationSpec.privacyMode } : {}),
      ...(registrationSpec.years !== undefined ? { years: registrationSpec.years } : {}),
    });
    persistWorkflow(envRepo, project, envName, domain, accountId, workflow);
    return workflowActionResult(domain, workflow, 'started');
  } catch (error) {
    return {
      success: false,
      message: `Cloudflare registration failed for ${domain}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function persistWorkflow(
  envRepo: EnvironmentRepository,
  project: Project,
  envName: string,
  domain: string,
  accountId: string,
  workflow: RegistrarWorkflowStatus
): void {
  const environment = envRepo.findByProjectAndName(project.id, envName)
    ?? envRepo.create({ projectId: project.id, name: envName });
  const existing = asRecord(environment.platformBindings.domainRegistrations) ?? {};
  envRepo.updatePlatformBindings(environment.id, {
    domainRegistrations: {
      ...existing,
      [domain]: {
        provider: 'cloudflare',
        accountId,
        state: workflow.state,
        completed: workflow.completed,
        links: workflow.links,
        updatedAt: workflow.updated_at,
      },
    },
  });
}
