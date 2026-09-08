import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import {
  SendGridAdapter,
  assessSendGridScopes,
  type SendGridCredentials,
  type SendGridDomainAuthentication,
} from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ActionResult } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import { SENDGRID_DELIVERY_EVENTS, type EnvironmentSpec } from '../spec/spec.schema.js';
import { findCloudflareZone, getCloudflareAdapterFromHints } from './cloudflare-ops.service.js';
import { cloudflareScopeHintsForDomain, normalizeDomainName } from './domain-scope.js';
import {
  EMAIL_OPERATIONS,
  deliveryEventsUrl,
  emailAuthorizationConfigHash,
  emailConfigHash,
  emailDeliveryEventsConfigHash,
  emailDnsConfigHash,
  emailForwardingConfigHash,
  emailInboundConfigHash,
  emailRuntimeConfigHash,
  emailRuntimeKeysForService,
  inboundParseUrl,
  type SendGridInboundParseRoute,
} from './email-plan.service.js';
import {
  catchAllPayload,
  forwardedTo,
  resolveCloudflareEmailContext,
  routingRuleForAddress,
  rulePayload,
} from './email-routing.service.js';
import { removeHostingEnvVars, syncHostingEnvVars } from './hosting-env.service.js';
import { getProjectScopeHints } from './project-scope.js';

const connectionRepo = new ConnectionRepository();
const environmentRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function booleanValue(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function currentEmailBindings(environment: Environment): Record<string, unknown> {
  return asRecord(environment.platformBindings.email) ?? {};
}

function updateEmailBinding(
  environment: Environment,
  key: string,
  value: Record<string, unknown>
): Environment | null {
  const latest = environmentRepo.findById(environment.id) ?? environment;
  return environmentRepo.updatePlatformBindings(environment.id, {
    email: {
      ...currentEmailBindings(latest),
      enabled: true,
      provider: 'sendgrid',
      [key]: value,
    },
  });
}

function updateForwardingBinding(
  environment: Environment,
  key: string,
  value: Record<string, unknown>
): Environment | null {
  const latest = environmentRepo.findById(environment.id) ?? environment;
  const forwarding = asRecord(currentEmailBindings(latest).forwarding) ?? {};
  return updateEmailBinding(latest, 'forwarding', { ...forwarding, [key]: value });
}

function updateForwardingMapBinding(
  environment: Environment,
  mapKey: 'aliases' | 'destinations',
  itemKey: string,
  value?: Record<string, unknown>
): Environment | null {
  const latest = environmentRepo.findById(environment.id) ?? environment;
  const forwarding = asRecord(currentEmailBindings(latest).forwarding) ?? {};
  const current = asRecord(forwarding[mapKey]) ?? {};
  const next = { ...current };
  if (value) next[itemKey] = value;
  else delete next[itemKey];
  return updateEmailBinding(latest, 'forwarding', { ...forwarding, [mapKey]: next });
}

function verifiedSendGridAdapter(project: Project, environmentSpec: EnvironmentSpec):
  | { adapter: SendGridAdapter; credentials: SendGridCredentials }
  | { error: string } {
  const scopeHints = [
    ...(environmentSpec.domain ? [environmentSpec.domain] : []),
    ...getProjectScopeHints(project),
  ];
  const connection = connectionRepo.findBestVerifiedMatchFromHints('sendgrid', scopeHints);
  if (!connection) {
    return { error: 'No verified SendGrid connection matches this project and email domain.' };
  }
  const credentials = getSecretStore().decryptObject<SendGridCredentials>(connection.credentialsEncrypted);
  const adapter = new SendGridAdapter();
  adapter.connect(credentials);
  return { adapter, credentials };
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function staleAction(message: string): ActionResult {
  return {
    success: false,
    status: 'blocked',
    message: 'Email plan action no longer matches desired state',
    error: `${message} Re-run hv_plan.`,
  };
}

function senderRuntimeVars(environmentSpec: EnvironmentSpec): Record<string, string> {
  const sender = environmentSpec.email.sender;
  if (!sender) return {};
  return {
    SENDGRID_FROM_EMAIL: sender.address,
    ...(sender.name ? { SENDGRID_FROM_NAME: sender.name } : {}),
    ...(sender.replyTo ? { SENDGRID_REPLY_TO: sender.replyTo } : {}),
  };
}

function runtimeVarsForService(
  environmentSpec: EnvironmentSpec,
  serviceName: string,
  apiKey: string
): Record<string, string> {
  const inbound = environmentSpec.email.inbound;
  return {
    SENDGRID_API_KEY: apiKey,
    ...senderRuntimeVars(environmentSpec),
    ...(inbound?.service === serviceName
      ? {
        SENDGRID_INBOUND_HOSTNAME: inbound.hostname,
        SENDGRID_INBOUND_ALIASES: JSON.stringify(
          [...inbound.aliases].map((alias) => alias.toLowerCase()).sort()
        ),
      }
      : {}),
  };
}

async function applyRuntime(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const expectedServices = Object.keys(params.environmentSpec.services).sort();
  if (
    params.action.resource.provider !== params.environmentSpec.hosting.provider
    || stringValue(metadata, 'configHash') !== emailRuntimeConfigHash(params.environmentSpec)
    || !sameStrings(stringArray(metadata, 'services'), expectedServices)
  ) {
    return staleAction('Runtime targets or configuration changed.');
  }

  const sendgrid = verifiedSendGridAdapter(params.project, params.environmentSpec);
  if ('error' in sendgrid) {
    return { success: false, status: 'blocked', message: 'SendGrid connection unavailable', error: sendgrid.error };
  }
  const credentialHash = createHash('sha256')
    .update(sendgrid.credentials.apiKey, 'utf8')
    .digest('hex');
  if (stringValue(metadata, 'credentialHash') !== credentialHash) {
    return staleAction('The reviewed SendGrid runtime credential changed.');
  }
  const scopes = assessSendGridScopes(await sendgrid.adapter.getScopes());
  if (!scopes.hasMailSend) {
    return {
      success: false,
      status: 'blocked',
      message: 'SendGrid runtime key cannot send mail',
      error: `Missing SendGrid scope(s): ${scopes.missingScopes.mailSend.join(', ')}`,
    };
  }

  const runtimeBinding = asRecord(currentEmailBindings(params.environment).runtime);
  const previousKeys = asRecord(runtimeBinding?.perServiceKeys);
  const perServiceKeys: Record<string, string[]> = {};
  const failures: string[] = [];
  let deploymentDeferred = false;
  let runtimeRolloutRequired = false;
  const rolloutBaselines: Record<string, unknown> = {};
  for (const serviceName of expectedServices) {
    const service = serviceRepo.findByProjectAndName(params.project.id, serviceName);
    if (!service) {
      failures.push(`${serviceName}: service is not tracked locally`);
      break;
    }
    const desiredKeys = emailRuntimeKeysForService(params.environmentSpec, serviceName);
    const synced = await syncHostingEnvVars({
      project: params.project,
      environment: params.environment,
      service,
      vars: runtimeVarsForService(params.environmentSpec, serviceName, sendgrid.credentials.apiKey),
      deferDeployment: params.environmentSpec.deploy?.strategy === 'branch'
        && params.environmentSpec.deploy.trigger === 'ci',
    });
    if (!synced.success) {
      failures.push(`${serviceName}: ${synced.error ?? synced.message}`);
      break;
    }
    const syncedData = asRecord(synced.data);
    deploymentDeferred ||= syncedData?.deploymentDeferred === true;
    runtimeRolloutRequired ||= syncedData?.runtimeRolloutRequired === true;
    if (syncedData?.runtimeRolloutRequired === true && syncedData.rolloutBaseline) {
      rolloutBaselines[serviceName] = syncedData.rolloutBaseline;
    }

    const obsoleteKeys = stringArray(previousKeys, serviceName)
      .filter((key) => !desiredKeys.includes(key));
    if (obsoleteKeys.length > 0) {
      const removed = await removeHostingEnvVars({
        project: params.project,
        environment: params.environment,
        service,
        keys: obsoleteKeys,
      });
      if (!removed.success) {
        failures.push(`${serviceName}: ${removed.error ?? removed.message}`);
        break;
      }
      const removedData = asRecord(removed.data);
      deploymentDeferred ||= removedData?.deploymentDeferred === true;
      runtimeRolloutRequired ||= removedData?.runtimeRolloutRequired === true;
      if (removedData?.runtimeRolloutRequired === true && removedData.rolloutBaseline) {
        rolloutBaselines[serviceName] = removedData.rolloutBaseline;
      }
    }
    perServiceKeys[serviceName] = desiredKeys;
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: 'Failed to sync declarative SendGrid runtime configuration',
      error: failures.join('; '),
      data: { services: expectedServices, keys: [...new Set(Object.values(perServiceKeys).flat())].sort() },
    };
  }

  updateEmailBinding(params.environment, 'runtime', {
    configHash: emailRuntimeConfigHash(params.environmentSpec),
    credentialHash,
    services: expectedServices,
    perServiceKeys,
    updatedAt: new Date().toISOString(),
  });
  return {
    success: true,
    message: `Synced SendGrid runtime configuration to ${expectedServices.length} service(s)`,
    data: {
      services: expectedServices,
      keys: [...new Set(Object.values(perServiceKeys).flat())].sort(),
      ...(deploymentDeferred ? { deploymentDeferred: true } : {}),
      ...(runtimeRolloutRequired ? { runtimeRolloutRequired: true } : {}),
      ...(Object.keys(rolloutBaselines).length > 0 ? { rolloutBaselines } : {}),
    },
  };
}

function exactDomainMatches(auths: SendGridDomainAuthentication[], domain: string): SendGridDomainAuthentication[] {
  return auths.filter((auth) => normalizeDomainName(auth.domain) === domain);
}

async function applyAuthorization(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const mode = stringValue(metadata, 'mode');
  const expectedHash = emailAuthorizationConfigHash(params.environmentSpec);
  if (!expectedHash || stringValue(metadata, 'configHash') !== expectedHash) {
    return staleAction('Sender authorization configuration changed.');
  }
  const sendgrid = verifiedSendGridAdapter(params.project, params.environmentSpec);
  if ('error' in sendgrid) {
    return { success: false, status: 'blocked', message: 'SendGrid connection unavailable', error: sendgrid.error };
  }
  const permissions = assessSendGridScopes(await sendgrid.adapter.getScopes());
  const operation = stringValue(metadata, 'operation');

  if (mode === 'domain' && params.environmentSpec.domain) {
    const domain = normalizeDomainName(params.environmentSpec.domain);
    if (params.action.resource.name !== domain || stringValue(metadata, 'domain') !== domain) {
      return staleAction('Domain authorization target changed.');
    }
    if (!permissions.canManageDomainAuthentication) {
      return {
        success: false,
        status: 'blocked',
        message: 'SendGrid domain authentication permission is missing',
        error: `Missing SendGrid scope(s): ${permissions.missingScopes.domainAuthentication.join(', ')}`,
      };
    }
    const matches = exactDomainMatches(await sendgrid.adapter.listDomainAuthentications(), domain);
    if (matches.length > 1) {
      return { success: false, status: 'blocked', message: `Multiple SendGrid domain authentications match ${domain}`, error: 'Resolve the duplicate provider identities before applying.' };
    }
    const candidateId = stringValue(metadata, 'candidateExternalId');
    if (operation === EMAIL_OPERATIONS.authorizationAdopt) {
      if (matches.length !== 1 || String(matches[0].id) !== candidateId) {
        return staleAction('The reviewed SendGrid adoption candidate changed.');
      }
      updateEmailBinding(params.environment, 'authorization', {
        mode: 'domain',
        domain,
        externalId: String(matches[0].id),
        configHash: expectedHash,
        verified: matches[0].valid === true,
        updatedAt: new Date().toISOString(),
      });
      return { success: true, message: `Adopted SendGrid domain authentication ${matches[0].id} for ${domain}` };
    }

    const existingBinding = asRecord(currentEmailBindings(params.environment).authorization);
    const bindingTargetsDomain = stringValue(existingBinding, 'mode') === 'domain'
      && stringValue(existingBinding, 'domain') === domain;
    const boundId = bindingTargetsDomain ? stringValue(existingBinding, 'externalId') : undefined;
    if (matches.length === 1 && boundId && String(matches[0].id) !== boundId) {
      return staleAction('The bound SendGrid domain identity changed.');
    }
    if (matches.length === 1 && !boundId && params.action.type === 'create') {
      return staleAction('A matching unmanaged SendGrid domain authentication appeared.');
    }
    const auth = matches[0] ?? await sendgrid.adapter.createDomainAuthentication(domain, { default: false });
    updateEmailBinding(params.environment, 'authorization', {
      mode: 'domain',
      domain,
      externalId: String(auth.id),
      configHash: expectedHash,
      verified: auth.valid === true,
      updatedAt: new Date().toISOString(),
    });
    return {
      success: true,
      message: `${matches[0] ? 'Reconciled' : 'Created'} SendGrid domain authentication for ${domain}`,
      data: { domain, domainId: auth.id, verified: auth.valid === true },
    };
  }

  const sender = params.environmentSpec.email.sender;
  if (mode !== 'singleSender' || !sender || params.environmentSpec.domain) {
    return staleAction('Single-sender authorization target changed.');
  }
  const address = sender.address.toLowerCase();
  if (params.action.resource.name !== address || stringValue(metadata, 'address') !== address) {
    return staleAction('Single-sender address changed.');
  }
  if (!permissions.canManageSenderVerification) {
    return {
      success: false,
      status: 'blocked',
      message: 'SendGrid sender-verification permission is missing',
      error: `Missing SendGrid scope(s): ${permissions.missingScopes.senderVerification.join(', ')}`,
    };
  }
  const matches = (await sendgrid.adapter.listVerifiedSenders())
    .filter((candidate) => candidate.from_email?.toLowerCase() === address);
  if (matches.length > 1) {
    return { success: false, status: 'blocked', message: `Multiple SendGrid sender identities match ${address}`, error: 'Resolve the duplicate provider identities before applying.' };
  }
  const candidateId = stringValue(metadata, 'candidateExternalId');
  if (operation === EMAIL_OPERATIONS.authorizationAdopt) {
    if (matches.length !== 1 || String(matches[0].id ?? address) !== candidateId) {
      return staleAction('The reviewed sender adoption candidate changed.');
    }
  } else if (matches.length === 0) {
    matches.push(await sendgrid.adapter.createVerifiedSender({
      nickname: sender.name ?? address,
      fromEmail: sender.address,
      fromName: sender.name,
      replyTo: sender.replyTo ?? sender.address,
    }));
  }
  const live = matches[0];
  const externalId = String(live.id ?? address);
  updateEmailBinding(params.environment, 'authorization', {
    mode: 'singleSender',
    address,
    externalId,
    configHash: expectedHash,
    verified: live.verified === true,
    updatedAt: new Date().toISOString(),
  });
  if (live.verified !== true) {
    return {
      success: false,
      status: 'pending',
      message: `SendGrid sender verification is pending for ${address}`,
      data: { address, senderId: externalId },
    };
  }
  return { success: true, message: `SendGrid sender ${address} is verified`, data: { address, senderId: externalId } };
}

function sendGridDnsRecords(auth: SendGridDomainAuthentication): Array<{
  type: string;
  name: string;
  content: string;
  priority?: number;
}> {
  return [auth.dns.dkim1, auth.dns.dkim2, auth.dns.mail_cname]
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => ({
      type: record.type.toUpperCase(),
      name: record.host.toLowerCase().replace(/\.$/, ''),
      content: record.data.toLowerCase().replace(/\.$/, ''),
    }));
}

async function applyDns(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const expectedHash = emailDnsConfigHash(params.environmentSpec);
  const domain = params.environmentSpec.domain
    ? normalizeDomainName(params.environmentSpec.domain)
    : undefined;
  if (
    !domain
    || params.action.resource.provider !== 'cloudflare'
    || params.action.resource.name !== domain
    || stringValue(metadata, 'domain') !== domain
    || stringValue(metadata, 'configHash') !== expectedHash
  ) {
    return staleAction('Email DNS target changed.');
  }

  const sendgrid = verifiedSendGridAdapter(params.project, params.environmentSpec);
  if ('error' in sendgrid) {
    return { success: false, status: 'blocked', message: 'SendGrid connection unavailable', error: sendgrid.error };
  }
  const authMatches = exactDomainMatches(await sendgrid.adapter.listDomainAuthentications(), domain);
  if (authMatches.length !== 1) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot resolve one SendGrid domain authentication for ${domain}`,
      error: authMatches.length === 0 ? 'Apply the authorization action first.' : 'Resolve duplicate SendGrid domain authentications.',
    };
  }
  const records = sendGridDnsRecords(authMatches[0]);
  if (params.environmentSpec.email.inbound) {
    records.push({
      type: 'MX',
      name: params.environmentSpec.email.inbound.hostname.toLowerCase(),
      content: 'mx.sendgrid.net',
      priority: 10,
    });
  }

  const cloudflare = getCloudflareAdapterFromHints(cloudflareScopeHintsForDomain(domain));
  if ('error' in cloudflare) {
    return { success: false, status: 'blocked', message: 'Cloudflare connection unavailable', error: cloudflare.error };
  }
  const zone = await findCloudflareZone(cloudflare.adapter, domain);
  if (!zone) {
    return { success: false, status: 'blocked', message: `Cloudflare zone not found for ${domain}`, error: 'Connect the DNS zone that owns this domain.' };
  }
  const liveRecords = await cloudflare.adapter.listDnsRecords(zone.id);
  for (const record of records) {
    const matches = liveRecords.filter((candidate) =>
      candidate.type.toUpperCase() === record.type
      && candidate.name.toLowerCase().replace(/\.$/, '') === record.name
    );
    if (matches.length > 1) {
      return { success: false, status: 'blocked', message: `Multiple Cloudflare records match ${record.type} ${record.name}`, error: 'Resolve duplicate DNS identities before applying.' };
    }
  }

  const operation = stringValue(metadata, 'operation');
  const recordBindings: Array<Record<string, unknown>> = [];
  if (operation === EMAIL_OPERATIONS.dnsAdopt) {
    for (const record of records) {
      const match = liveRecords.find((candidate) =>
        candidate.type.toUpperCase() === record.type
        && candidate.name.toLowerCase().replace(/\.$/, '') === record.name
        && candidate.content.toLowerCase().replace(/\.$/, '') === record.content
        && (record.priority === undefined || candidate.priority === record.priority)
      );
      if (!match) return staleAction(`The reviewed ${record.type} ${record.name} DNS adoption candidate changed.`);
      recordBindings.push({ id: match.id, type: record.type, name: record.name, priority: record.priority ?? null });
    }
  } else {
    for (const record of records) {
      const result = await cloudflare.adapter.upsertDnsRecord(
        zone.id,
        record.name,
        record.type,
        record.content,
        { proxied: false, ...(record.priority !== undefined ? { priority: record.priority } : {}) }
      );
      const verified = result.record.content.toLowerCase().replace(/\.$/, '') === record.content
        && (record.priority === undefined || result.record.priority === record.priority);
      if (!verified) {
        return { success: false, message: `Cloudflare did not verify ${record.type} ${record.name}`, error: 'The provider receipt did not match the requested DNS record.' };
      }
      recordBindings.push({ id: result.record.id, type: record.type, name: record.name, priority: record.priority ?? null });
    }
  }

  updateEmailBinding(params.environment, 'dns', {
    configHash: expectedHash,
    provider: 'cloudflare',
    zoneId: zone.id,
    records: recordBindings,
    updatedAt: new Date().toISOString(),
  });
  return {
    success: true,
    message: `${operation === EMAIL_OPERATIONS.dnsAdopt ? 'Recorded' : 'Synchronized'} ${records.length} SendGrid DNS record(s) in Cloudflare`,
    data: { domain, records: recordBindings },
  };
}

function routeMatches(route: SendGridInboundParseRoute, expectedUrl: string, inbound: NonNullable<EnvironmentSpec['email']['inbound']>): boolean {
  return route.url === expectedUrl
    && route.spam_check === inbound.spamCheck
    && route.send_raw === inbound.sendRaw;
}

async function applyInbound(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const inbound = params.environmentSpec.email.inbound;
  const metadata = asRecord(params.action.metadata);
  const expectedHash = emailInboundConfigHash(params.environmentSpec);
  if (!inbound || !expectedHash) return staleAction('Inbound parse was removed.');
  const hostname = inbound.hostname.toLowerCase();
  if (
    params.action.resource.provider !== 'sendgrid'
    || params.action.resource.name !== hostname
    || stringValue(metadata, 'hostname') !== hostname
    || stringValue(metadata, 'service') !== inbound.service
    || stringValue(metadata, 'path') !== inbound.path
    || stringValue(metadata, 'configHash') !== expectedHash
    || !sameStrings(stringArray(metadata, 'aliases'), inbound.aliases.map((alias) => alias.toLowerCase()))
    || booleanValue(metadata, 'spamCheck') !== inbound.spamCheck
    || booleanValue(metadata, 'sendRaw') !== inbound.sendRaw
  ) {
    return staleAction('Inbound parse target or options changed.');
  }
  const expectedUrl = inboundParseUrl(params.environment, inbound);
  if (!expectedUrl) {
    return { success: false, status: 'blocked', message: `Inbound service ${inbound.service} has no public provider URL`, error: 'Apply its service action first, then re-run hv_plan.' };
  }
  if (stringValue(metadata, 'expectedUrl') && stringValue(metadata, 'expectedUrl') !== expectedUrl) {
    return staleAction('The target service URL changed.');
  }

  const sendgrid = verifiedSendGridAdapter(params.project, params.environmentSpec);
  if ('error' in sendgrid) {
    return { success: false, status: 'blocked', message: 'SendGrid connection unavailable', error: sendgrid.error };
  }
  const permissions = assessSendGridScopes(await sendgrid.adapter.getScopes());
  if (!permissions.canConfigureInboundParse) {
    return {
      success: false,
      status: 'blocked',
      message: 'SendGrid inbound-parse permission is missing',
      error: `Missing SendGrid scope(s): ${permissions.missingScopes.inboundParse.join(', ')}`,
    };
  }
  const routes = await sendgrid.adapter.listInboundParseWebhooks();
  const matches = routes.filter((route) => route.hostname.toLowerCase() === hostname);
  if (matches.length > 1) {
    return { success: false, status: 'blocked', message: `Multiple SendGrid inbound parse routes match ${hostname}`, error: 'Resolve duplicate provider identities before applying.' };
  }
  const operation = stringValue(metadata, 'operation');
  let route: SendGridInboundParseRoute;
  if (operation === EMAIL_OPERATIONS.inboundAdopt) {
    if (matches.length !== 1 || !routeMatches(matches[0], expectedUrl, inbound)) {
      return staleAction('The reviewed inbound parse adoption candidate changed.');
    }
    route = matches[0];
  } else if (operation === EMAIL_OPERATIONS.inboundReplace) {
    if (params.action.type !== 'replace' || matches.length !== 1) {
      return staleAction('The reviewed inbound parse replacement identity changed.');
    }
    const previous = matches[0];
    await sendgrid.adapter.deleteInboundParseWebhook(hostname);
    try {
      route = await sendgrid.adapter.createInboundParseWebhook(hostname, expectedUrl, {
        spam_check: inbound.spamCheck,
        send_raw: inbound.sendRaw,
      });
    } catch (error) {
      let rollbackError: string | undefined;
      try {
        await sendgrid.adapter.createInboundParseWebhook(previous.hostname, previous.url, {
          spam_check: previous.spam_check,
          send_raw: previous.send_raw,
        });
      } catch (rollback) {
        rollbackError = rollback instanceof Error ? rollback.message : String(rollback);
      }
      return {
        success: false,
        message: `Failed to replace SendGrid inbound parse route for ${hostname}`,
        error: `${error instanceof Error ? error.message : String(error)}${rollbackError ? `; rollback also failed: ${rollbackError}` : '; the previous route was restored'}`,
      };
    }
  } else if (matches.length === 0) {
    route = await sendgrid.adapter.createInboundParseWebhook(hostname, expectedUrl, {
      spam_check: inbound.spamCheck,
      send_raw: inbound.sendRaw,
    });
  } else if (routeMatches(matches[0], expectedUrl, inbound)) {
    route = matches[0];
  } else {
    return staleAction('The inbound route now requires a reviewed replacement.');
  }

  const verified = (await sendgrid.adapter.listInboundParseWebhooks())
    .find((candidate) => candidate.hostname.toLowerCase() === hostname);
  if (!verified || !routeMatches(verified, expectedUrl, inbound)) {
    return { success: false, message: `SendGrid did not verify inbound parse for ${hostname}`, error: 'The provider read-back did not match the requested route.' };
  }
  updateEmailBinding(params.environment, 'inbound', {
    configHash: expectedHash,
    hostname,
    service: inbound.service,
    path: inbound.path,
    url: route.url,
    aliases: [...inbound.aliases].map((alias) => alias.toLowerCase()).sort(),
    spamCheck: inbound.spamCheck,
    sendRaw: inbound.sendRaw,
    updatedAt: new Date().toISOString(),
  });
  return {
    success: true,
    message: `${operation === EMAIL_OPERATIONS.inboundAdopt ? 'Adopted' : 'Configured'} SendGrid inbound parse for ${hostname}`,
    data: { hostname, service: inbound.service, path: inbound.path, aliases: inbound.aliases },
  };
}

function eventSettingsMatch(
  settings: Awaited<ReturnType<SendGridAdapter['getEventWebhookSettings']>>,
  url: string,
  events: string[]
): boolean {
  return settings.enabled
    && settings.url === url
    && SENDGRID_DELIVERY_EVENTS.every((event) => settings[event] === events.includes(event));
}

async function applyDeliveryEvents(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const desired = params.environmentSpec.email.deliveryEvents;
  const metadata = asRecord(params.action.metadata);
  const expectedHash = emailDeliveryEventsConfigHash(params.environmentSpec);
  const expectedUrl = desired ? deliveryEventsUrl(params.environment, desired) : undefined;
  if (
    !desired
    || !expectedHash
    || !expectedUrl
    || params.action.resource.provider !== 'sendgrid'
    || params.action.resource.name !== 'delivery-events'
    || stringValue(metadata, 'service') !== desired.service
    || stringValue(metadata, 'path') !== desired.path
    || stringValue(metadata, 'configHash') !== expectedHash
    || stringValue(metadata, 'expectedUrl') !== expectedUrl
    || !sameStrings(stringArray(metadata, 'events'), desired.events)
  ) return staleAction('Delivery-event target or settings changed.');

  const sendgrid = verifiedSendGridAdapter(params.project, params.environmentSpec);
  if ('error' in sendgrid) {
    return { success: false, status: 'blocked', message: 'SendGrid connection unavailable', error: sendgrid.error };
  }
  const permissions = assessSendGridScopes(await sendgrid.adapter.getScopes());
  if (!permissions.canConfigureEventWebhook) {
    return {
      success: false,
      status: 'blocked',
      message: 'SendGrid delivery-event permission is missing',
      error: `Missing SendGrid scope(s): ${permissions.missingScopes.eventWebhook.join(', ')}`,
    };
  }
  const live = await sendgrid.adapter.getEventWebhookSettings();
  const operation = stringValue(metadata, 'operation');
  if (operation === EMAIL_OPERATIONS.deliveryEventsAdopt) {
    if (!eventSettingsMatch(live, expectedUrl, desired.events)) {
      return staleAction('The reviewed delivery-event webhook adoption candidate changed.');
    }
  } else {
    const settings = Object.fromEntries(
      SENDGRID_DELIVERY_EVENTS.map((event) => [event, desired.events.includes(event)])
    );
    await sendgrid.adapter.updateEventWebhookSettings({ enabled: true, url: expectedUrl, ...settings });
  }
  const verified = await sendgrid.adapter.getEventWebhookSettings();
  if (!eventSettingsMatch(verified, expectedUrl, desired.events)) {
    return { success: false, message: 'SendGrid did not verify the delivery-event webhook', error: 'Provider read-back differs from the reviewed settings.' };
  }
  updateEmailBinding(params.environment, 'deliveryEvents', {
    configHash: expectedHash,
    url: expectedUrl,
    service: desired.service,
    path: desired.path,
    events: [...desired.events].sort(),
    updatedAt: new Date().toISOString(),
  });
  return { success: true, message: `Configured SendGrid delivery events at ${expectedUrl}`, data: { url: expectedUrl, events: desired.events } };
}

function forwardingDomain(environmentSpec: EnvironmentSpec): string | undefined {
  return environmentSpec.domain && environmentSpec.email.forwarding
    ? normalizeDomainName(environmentSpec.domain)
    : undefined;
}

function forwardingAliasDestination(environmentSpec: EnvironmentSpec, alias: string): string | undefined {
  const domain = forwardingDomain(environmentSpec);
  if (!domain) return undefined;
  const entry = Object.entries(environmentSpec.email.forwarding!.aliases)
    .find(([local]) => `${local.toLowerCase()}@${domain}` === alias);
  return entry?.[1].toLowerCase();
}

async function applyForwardingDns(params: {
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const domain = forwardingDomain(params.environmentSpec);
  if (
    !domain
    || params.action.resource.provider !== 'cloudflare'
    || params.action.resource.name !== domain
    || stringValue(metadata, 'domain') !== domain
    || stringValue(metadata, 'configHash') !== emailForwardingConfigHash(params.environmentSpec)
  ) return staleAction('Forwarding DNS target changed.');
  const context = await resolveCloudflareEmailContext(domain);
  if ('error' in context) return { success: false, status: 'blocked', message: 'Cloudflare email context unavailable', error: context.error };
  const operation = stringValue(metadata, 'operation');
  const settings = await context.adapter.getEmailRoutingSettings(context.zone.id);
  if (operation === EMAIL_OPERATIONS.forwardingDnsAdopt) {
    if (!settings.enabled) return staleAction('The reviewed Email Routing DNS adoption candidate changed.');
  } else if (!settings.enabled) {
    await context.adapter.enableEmailRoutingDns(context.zone.id);
  }
  const verified = await context.adapter.getEmailRoutingSettings(context.zone.id);
  if (!verified.enabled) {
    return { success: false, message: `Cloudflare did not enable Email Routing for ${domain}`, error: 'Provider read-back still reports disabled.' };
  }
  updateForwardingBinding(params.environment, 'dns', {
    zoneId: context.zone.id,
    accountId: context.accountId,
    enabled: true,
    updatedAt: new Date().toISOString(),
  });
  return { success: true, message: `Cloudflare Email Routing DNS is enabled for ${domain}`, data: { domain } };
}

async function applyForwardingDestination(params: {
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const domain = forwardingDomain(params.environmentSpec);
  const destination = stringValue(metadata, 'destination')?.toLowerCase();
  const desiredDestinations = new Set([
    ...Object.values(params.environmentSpec.email.forwarding?.aliases ?? {}).map((value) => value.toLowerCase()),
    ...(params.environmentSpec.email.forwarding?.catchAll.action === 'forward'
      ? [params.environmentSpec.email.forwarding.catchAll.destination.toLowerCase()]
      : []),
  ]);
  if (
    !domain
    || !destination
    || !desiredDestinations.has(destination)
    || params.action.resource.provider !== 'cloudflare'
    || params.action.resource.name !== destination
    || stringValue(metadata, 'domain') !== domain
  ) return staleAction('Forwarding destination changed.');
  const context = await resolveCloudflareEmailContext(domain);
  if ('error' in context) return { success: false, status: 'blocked', message: 'Cloudflare email context unavailable', error: context.error };
  const matches = (await context.adapter.listEmailRoutingAddresses(context.accountId))
    .filter((candidate) => candidate.email.toLowerCase() === destination);
  if (matches.length > 1) {
    return { success: false, status: 'blocked', message: `Multiple Cloudflare destinations match ${destination}`, error: 'Resolve duplicate provider identities before applying.' };
  }
  const operation = stringValue(metadata, 'operation');
  let live = matches[0];
  if (operation === EMAIL_OPERATIONS.forwardingDestinationAdopt) {
    if (!live || live.id !== stringValue(metadata, 'candidateExternalId')) {
      return staleAction('The reviewed forwarding destination adoption candidate changed.');
    }
  } else if (!live) {
    live = await context.adapter.createEmailRoutingAddress(context.accountId, destination);
  }
  updateForwardingMapBinding(params.environment, 'destinations', destination, {
    externalId: live.id,
    verified: Boolean(live.verified),
    updatedAt: new Date().toISOString(),
  });
  if (!live.verified) {
    return {
      success: false,
      status: 'pending',
      message: `Cloudflare sent destination verification to ${destination}`,
      data: { destination, verificationRequired: true },
    };
  }
  return { success: true, message: `Forwarding destination ${destination} is verified`, data: { destination } };
}

async function applyForwardingRule(params: {
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const domain = forwardingDomain(params.environmentSpec);
  const alias = stringValue(metadata, 'alias')?.toLowerCase();
  const operation = stringValue(metadata, 'operation');
  const context = domain ? await resolveCloudflareEmailContext(domain) : { error: 'Email forwarding is no longer declared.' };
  if ('error' in context) return staleAction(context.error);
  if (
    !alias
    || params.action.resource.provider !== 'cloudflare'
    || params.action.resource.name !== alias
    || stringValue(metadata, 'domain') !== domain
  ) return staleAction('Forwarding rule identity changed.');

  const rules = await context.adapter.listEmailRoutingRules(context.zone.id);
  const matches = rules.filter((rule) => routingRuleForAddress(rule, alias));
  if (matches.length > 1) {
    return { success: false, status: 'blocked', message: `Multiple Cloudflare forwarding rules match ${alias}`, error: 'Resolve duplicate provider identities before applying.' };
  }
  if (operation === EMAIL_OPERATIONS.forwardingRuleDestroy) {
    const externalId = stringValue(metadata, 'externalId');
    if (!externalId) return staleAction('Forwarding rule deletion identity is missing.');
    const bound = asRecord(asRecord(asRecord(currentEmailBindings(params.environment).forwarding)?.aliases)?.[alias]);
    if (stringValue(bound, 'externalId') !== externalId || forwardingAliasDestination(params.environmentSpec, alias)) {
      return staleAction('Forwarding rule deletion authority changed.');
    }
    const byId = rules.find((rule) => rule.id === externalId);
    if (byId) await context.adapter.deleteEmailRoutingRule(context.zone.id, externalId);
    const remains = (await context.adapter.listEmailRoutingRules(context.zone.id)).some((rule) => rule.id === externalId);
    if (remains) return { success: false, message: `Cloudflare did not delete forwarding rule ${alias}`, error: 'Provider read-back still contains the rule.' };
    updateForwardingMapBinding(params.environment, 'aliases', alias);
    return { success: true, message: `Deleted forwarding rule ${alias}`, data: { alias } };
  }

  const destination = forwardingAliasDestination(params.environmentSpec, alias);
  if (
    !destination
    || stringValue(metadata, 'destination') !== destination
    || stringValue(metadata, 'configHash') !== emailConfigHash({ alias, destination })
  ) return staleAction('Forwarding rule destination changed.');
  const destinationMatches = (await context.adapter.listEmailRoutingAddresses(context.accountId))
    .filter((candidate) => candidate.email.toLowerCase() === destination);
  if (destinationMatches.length !== 1 || !destinationMatches[0].verified) {
    return { success: false, status: 'pending', message: `Forwarding destination ${destination} is not verified`, error: 'Accept the Cloudflare verification email, then re-run hv_plan.' };
  }
  let rule = matches[0];
  if (operation === EMAIL_OPERATIONS.forwardingRuleAdopt) {
    if (!rule || rule.id !== stringValue(metadata, 'candidateExternalId')) {
      return staleAction('The reviewed forwarding rule adoption candidate changed.');
    }
  } else {
    const payload = rulePayload(alias, destination);
    rule = rule
      ? await context.adapter.updateEmailRoutingRule(context.zone.id, rule.id, payload)
      : await context.adapter.createEmailRoutingRule(context.zone.id, payload);
  }
  const verified = (await context.adapter.listEmailRoutingRules(context.zone.id))
    .find((candidate) => candidate.id === rule.id);
  if (!verified || !verified.enabled || forwardedTo(verified).map((value) => value.toLowerCase()).join() !== destination) {
    return { success: false, message: `Cloudflare did not verify forwarding rule ${alias}`, error: 'Provider read-back differs from the reviewed destination.' };
  }
  updateForwardingMapBinding(params.environment, 'aliases', alias, {
    externalId: rule.id,
    destination,
    configHash: emailConfigHash({ alias, destination }),
    updatedAt: new Date().toISOString(),
  });
  return { success: true, message: `Configured ${alias} -> ${destination}`, data: { alias, destination } };
}

async function applyForwardingCatchAll(params: {
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const domain = forwardingDomain(params.environmentSpec);
  const desired = params.environmentSpec.email.forwarding?.catchAll;
  if (
    !domain
    || !desired
    || params.action.resource.provider !== 'cloudflare'
    || params.action.resource.name !== `${domain}:catch-all`
    || stringValue(metadata, 'domain') !== domain
    || stringValue(metadata, 'action') !== desired.action
    || stringValue(metadata, 'configHash') !== emailConfigHash(desired)
    || (desired.action === 'forward' && stringValue(metadata, 'destination') !== desired.destination.toLowerCase())
  ) return staleAction('Forwarding catch-all settings changed.');
  const context = await resolveCloudflareEmailContext(domain);
  if ('error' in context) return { success: false, status: 'blocked', message: 'Cloudflare email context unavailable', error: context.error };
  const destination = desired.action === 'forward' ? desired.destination.toLowerCase() : undefined;
  if (destination) {
    const matches = (await context.adapter.listEmailRoutingAddresses(context.accountId))
      .filter((candidate) => candidate.email.toLowerCase() === destination);
    if (matches.length !== 1 || !matches[0].verified) {
      return { success: false, status: 'pending', message: `Catch-all destination ${destination} is not verified`, error: 'Accept the Cloudflare verification email, then re-run hv_plan.' };
    }
  }
  const operation = stringValue(metadata, 'operation');
  let rule = await context.adapter.getEmailRoutingCatchAll(context.zone.id);
  const matches = desired.action === 'drop'
    ? rule.enabled && rule.actions.length === 1 && rule.actions[0].type === 'drop'
    : rule.enabled && forwardedTo(rule).map((value) => value.toLowerCase()).join() === destination;
  if (operation === EMAIL_OPERATIONS.forwardingCatchAllAdopt) {
    if (!matches) return staleAction('The reviewed catch-all adoption candidate changed.');
  } else {
    rule = await context.adapter.updateEmailRoutingCatchAll(
      context.zone.id,
      catchAllPayload(desired.action, destination, true)
    );
  }
  updateForwardingBinding(params.environment, 'catchAll', {
    externalId: rule.id,
    configHash: emailConfigHash(desired),
    action: desired.action,
    ...(destination ? { destination } : {}),
    updatedAt: new Date().toISOString(),
  });
  return { success: true, message: `Configured ${domain} catch-all to ${desired.action}`, data: { domain, action: desired.action, ...(destination ? { destination } : {}) } };
}

async function applyVerification(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const domain = params.environmentSpec.domain
    ? normalizeDomainName(params.environmentSpec.domain)
    : undefined;
  if (
    !domain
    || params.action.resource.provider !== 'sendgrid'
    || params.action.resource.name !== domain
    || stringValue(metadata, 'domain') !== domain
  ) {
    return staleAction('Domain-verification target changed.');
  }
  const sendgrid = verifiedSendGridAdapter(params.project, params.environmentSpec);
  if ('error' in sendgrid) {
    return { success: false, status: 'blocked', message: 'SendGrid connection unavailable', error: sendgrid.error };
  }
  const matches = exactDomainMatches(await sendgrid.adapter.listDomainAuthentications(), domain);
  const binding = asRecord(currentEmailBindings(params.environment).authorization);
  if (
    matches.length !== 1
    || stringValue(binding, 'externalId') !== String(matches[0].id)
  ) {
    return staleAction('The bound SendGrid domain identity changed.');
  }
  const validation = await sendgrid.adapter.validateDomainAuthentication(matches[0].id);
  updateEmailBinding(params.environment, 'authorization', {
    ...binding,
    verified: validation.valid,
    updatedAt: new Date().toISOString(),
  });
  if (!validation.valid) {
    return {
      success: false,
      status: 'pending',
      message: `SendGrid domain authentication is waiting for DNS propagation for ${domain}`,
      data: { domain, domainId: matches[0].id, verified: false },
    };
  }
  return {
    success: true,
    message: `Verified SendGrid domain authentication for ${domain}`,
    data: { domain, domainId: matches[0].id, verified: true },
  };
}

export async function applyEmailAction(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const environment = environmentRepo.findByProjectAndName(params.project.id, params.environmentName);
  if (!environment) {
    return { success: false, status: 'blocked', message: 'Email environment is not tracked locally', error: `No local environment "${params.environmentName}" exists.` };
  }
  if (!params.environmentSpec.email.enabled) return staleAction('Email is no longer enabled.');
  const operation = stringValue(asRecord(params.action.metadata), 'operation');
  switch (operation) {
    case EMAIL_OPERATIONS.runtimeSync:
      return applyRuntime({ ...params, environment });
    case EMAIL_OPERATIONS.authorizationEnsure:
    case EMAIL_OPERATIONS.authorizationAdopt:
      return applyAuthorization({ ...params, environment });
    case EMAIL_OPERATIONS.dnsSync:
    case EMAIL_OPERATIONS.dnsAdopt:
      return applyDns({ ...params, environment });
    case EMAIL_OPERATIONS.inboundEnsure:
    case EMAIL_OPERATIONS.inboundAdopt:
    case EMAIL_OPERATIONS.inboundReplace:
      return applyInbound({ ...params, environment });
    case EMAIL_OPERATIONS.deliveryEventsEnsure:
    case EMAIL_OPERATIONS.deliveryEventsAdopt:
      return applyDeliveryEvents({ ...params, environment });
    case EMAIL_OPERATIONS.forwardingDnsEnsure:
    case EMAIL_OPERATIONS.forwardingDnsAdopt:
      return applyForwardingDns({ ...params, environment });
    case EMAIL_OPERATIONS.forwardingDestinationEnsure:
    case EMAIL_OPERATIONS.forwardingDestinationAdopt:
      return applyForwardingDestination({ ...params, environment });
    case EMAIL_OPERATIONS.forwardingRuleEnsure:
    case EMAIL_OPERATIONS.forwardingRuleAdopt:
    case EMAIL_OPERATIONS.forwardingRuleDestroy:
      return applyForwardingRule({ ...params, environment });
    case EMAIL_OPERATIONS.forwardingCatchAllEnsure:
    case EMAIL_OPERATIONS.forwardingCatchAllAdopt:
      return applyForwardingCatchAll({ ...params, environment });
    case EMAIL_OPERATIONS.authorizationVerify:
      return applyVerification({ ...params, environment });
    default:
      return { success: false, status: 'blocked', message: `Unknown email operation ${operation ?? '(missing)'}`, error: 'Re-run hv_plan with this Hypervibe version.' };
  }
}
