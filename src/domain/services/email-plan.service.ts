import { createHash } from 'crypto';
import type {
  SendGridDomainAuthentication,
  SendGridEventWebhookSettings,
  SendGridVerifiedSender,
} from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type {
  CloudflareDnsRecord,
  CloudflareEmailRoutingAddress,
  CloudflareEmailRoutingRule,
  CloudflareEmailRoutingSettings,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import {
  EMAIL_MANAGED_ENV_KEYS,
  type EmailInboundSpec,
  type EnvironmentSpec,
} from '../spec/spec.schema.js';
import { findCloudflareZone, getCloudflareAdapterFromHints } from './cloudflare-ops.service.js';
import { cloudflareScopeHintsForDomain, normalizeDomainName } from './domain-scope.js';
import { getProjectScopeHints } from './project-scope.js';
import { getSendGridAdapter, getSendGridApiKeyHash } from './sendgrid-ops.service.js';
import {
  forwardedTo,
  resolveCloudflareEmailContext,
  routingRuleForAddress,
} from './email-routing.service.js';
import { serviceBindingFor } from './spec.service.js';

export const EMAIL_OPERATIONS = {
  runtimeSync: 'emailRuntimeSync',
  authorizationEnsure: 'emailAuthorizationEnsure',
  authorizationAdopt: 'emailAuthorizationAdopt',
  dnsSync: 'emailDnsSync',
  dnsAdopt: 'emailDnsAdopt',
  inboundEnsure: 'emailInboundEnsure',
  inboundAdopt: 'emailInboundAdopt',
  inboundReplace: 'emailInboundReplace',
  authorizationVerify: 'emailAuthorizationVerify',
  deliveryEventsEnsure: 'emailDeliveryEventsEnsure',
  deliveryEventsAdopt: 'emailDeliveryEventsAdopt',
  forwardingDnsEnsure: 'emailForwardingDnsEnsure',
  forwardingDnsAdopt: 'emailForwardingDnsAdopt',
  forwardingDestinationEnsure: 'emailForwardingDestinationEnsure',
  forwardingDestinationAdopt: 'emailForwardingDestinationAdopt',
  forwardingRuleEnsure: 'emailForwardingRuleEnsure',
  forwardingRuleAdopt: 'emailForwardingRuleAdopt',
  forwardingRuleDestroy: 'emailForwardingRuleDestroy',
  forwardingCatchAllEnsure: 'emailForwardingCatchAllEnsure',
  forwardingCatchAllAdopt: 'emailForwardingCatchAllAdopt',
} as const;

type KnownObservation<T> = { status: 'known'; items: T[] };
type UnknownObservation = { status: 'unknown'; error: string };
type EmailObservation<T> = KnownObservation<T> | UnknownObservation;
type EmailValueObservation<T> = { status: 'known'; value: T } | UnknownObservation;

export interface SendGridInboundParseRoute {
  hostname: string;
  url: string;
  spam_check: boolean;
  send_raw: boolean;
}

export interface EmailIntegrationState {
  runtimeKey: { status: 'known'; hash: string } | UnknownObservation;
  domainAuthentications: EmailObservation<SendGridDomainAuthentication>;
  verifiedSenders: EmailObservation<SendGridVerifiedSender>;
  inboundRoutes: EmailObservation<SendGridInboundParseRoute>;
  dnsRecords: EmailObservation<CloudflareDnsRecord>;
  deliveryEvents: EmailValueObservation<SendGridEventWebhookSettings>;
  forwardingSettings: EmailValueObservation<CloudflareEmailRoutingSettings>;
  forwardingDestinations: EmailObservation<CloudflareEmailRoutingAddress>;
  forwardingRules: EmailObservation<CloudflareEmailRoutingRule>;
  forwardingCatchAll: EmailValueObservation<CloudflareEmailRoutingRule>;
  warnings: string[];
}

export interface EmailPlanResult {
  actions: PlanAction[];
  warnings: string[];
  fingerprint?: string;
}

function known<T>(items: T[] = []): KnownObservation<T> {
  return { status: 'known', items };
}

function unknown(error: string): UnknownObservation {
  return { status: 'unknown', error };
}

function knownValue<T>(value: T): { status: 'known'; value: T } {
  return { status: 'known', value };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function emailBindings(environment: Environment | null): Record<string, unknown> {
  return asRecord(environment?.platformBindings.email) ?? {};
}

export function emailConfigHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizedDnsRecord(record: CloudflareDnsRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type.toUpperCase(),
    name: record.name.toLowerCase().replace(/\.$/, ''),
    content: record.content.toLowerCase().replace(/\.$/, ''),
    priority: record.priority ?? null,
  };
}

function normalizedDomainAuth(auth: SendGridDomainAuthentication): Record<string, unknown> {
  const dns = [auth.dns.dkim1, auth.dns.dkim2, auth.dns.mail_cname]
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => ({
      type: record.type.toUpperCase(),
      name: record.host.toLowerCase().replace(/\.$/, ''),
      content: record.data.toLowerCase().replace(/\.$/, ''),
      valid: record.valid,
    }))
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
  return {
    id: auth.id,
    domain: auth.domain.toLowerCase(),
    valid: auth.valid,
    dns,
  };
}

export function emailIntegrationFingerprint(state: EmailIntegrationState): string {
  const normalize = <T>(observation: EmailObservation<T>, mapper: (item: T) => unknown): unknown =>
    observation.status === 'unknown'
      ? { status: 'unknown', error: observation.error }
      : { status: 'known', items: observation.items.map(mapper) };

  return emailConfigHash({
    runtimeKey: state.runtimeKey,
    domainAuthentications: normalize(state.domainAuthentications, normalizedDomainAuth),
    verifiedSenders: normalize(state.verifiedSenders, (sender) => ({
      id: sender.id ?? null,
      address: sender.from_email?.toLowerCase() ?? null,
      name: sender.from_name ?? null,
      replyTo: sender.reply_to?.toLowerCase() ?? null,
      verified: sender.verified === true,
    })),
    inboundRoutes: normalize(state.inboundRoutes, (route) => ({
      hostname: route.hostname.toLowerCase(),
      url: route.url,
      spamCheck: route.spam_check,
      sendRaw: route.send_raw,
    })),
    dnsRecords: normalize(state.dnsRecords, normalizedDnsRecord),
    deliveryEvents: state.deliveryEvents.status === 'unknown'
      ? state.deliveryEvents
      : { status: 'known', value: state.deliveryEvents.value },
    forwardingSettings: state.forwardingSettings.status === 'unknown'
      ? state.forwardingSettings
      : {
        status: 'known',
        value: {
          id: state.forwardingSettings.value.id,
          enabled: state.forwardingSettings.value.enabled,
          status: state.forwardingSettings.value.status ?? null,
        },
      },
    forwardingDestinations: normalize(state.forwardingDestinations, (destination) => ({
      id: destination.id,
      email: destination.email.toLowerCase(),
      verified: destination.verified ?? null,
    })),
    forwardingRules: normalize(state.forwardingRules, (rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      actions: rule.actions,
      matchers: rule.matchers,
    })),
    forwardingCatchAll: state.forwardingCatchAll.status === 'unknown'
      ? state.forwardingCatchAll
      : {
        status: 'known',
        value: {
          id: state.forwardingCatchAll.value.id,
          enabled: state.forwardingCatchAll.value.enabled,
          actions: state.forwardingCatchAll.value.actions,
        },
      },
  });
}

export async function resolveEmailIntegrationState(params: {
  project: Project;
  environmentSpec: EnvironmentSpec;
}): Promise<EmailIntegrationState> {
  const { project, environmentSpec } = params;
  const wantsDomain = Boolean(environmentSpec.domain);
  const wantsSender = Boolean(!environmentSpec.domain && environmentSpec.email.sender);
  const wantsInbound = Boolean(environmentSpec.email.inbound);
  const wantsDeliveryEvents = Boolean(environmentSpec.email.deliveryEvents);
  const wantsForwarding = Boolean(environmentSpec.email.forwarding && environmentSpec.domain);
  const wantsDns = Boolean(environmentSpec.domain);
  const warnings: string[] = [];

  let domainAuthentications: EmailIntegrationState['domainAuthentications'] = known();
  let verifiedSenders: EmailIntegrationState['verifiedSenders'] = known();
  let inboundRoutes: EmailIntegrationState['inboundRoutes'] = known();
  let dnsRecords: EmailIntegrationState['dnsRecords'] = known();
  let deliveryEvents: EmailIntegrationState['deliveryEvents'] = unknown('Delivery-event observation was not requested');
  let forwardingSettings: EmailIntegrationState['forwardingSettings'] = unknown('Email-forwarding observation was not requested');
  let forwardingDestinations: EmailIntegrationState['forwardingDestinations'] = known();
  let forwardingRules: EmailIntegrationState['forwardingRules'] = known();
  let forwardingCatchAll: EmailIntegrationState['forwardingCatchAll'] = unknown('Email-forwarding observation was not requested');
  const scopeHints = [
    ...(environmentSpec.domain ? [environmentSpec.domain] : []),
    ...getProjectScopeHints(project),
  ];
  const runtimeKeyResult = getSendGridApiKeyHash(scopeHints);
  const runtimeKey: EmailIntegrationState['runtimeKey'] = 'error' in runtimeKeyResult
    ? unknown(runtimeKeyResult.error)
    : { status: 'known', hash: runtimeKeyResult.hash };

  const sendgrid = getSendGridAdapter(scopeHints);
  if ('error' in sendgrid) {
    if (wantsDomain) domainAuthentications = unknown(sendgrid.error);
    if (wantsSender) verifiedSenders = unknown(sendgrid.error);
    if (wantsInbound) inboundRoutes = unknown(sendgrid.error);
    if (wantsDeliveryEvents) deliveryEvents = unknown(sendgrid.error);
  } else {
    if (wantsDomain) {
      try {
        domainAuthentications = known(await sendgrid.adapter.listDomainAuthentications());
      } catch (error) {
        domainAuthentications = unknown(error instanceof Error ? error.message : String(error));
      }
    }
    if (wantsSender) {
      try {
        verifiedSenders = known(await sendgrid.adapter.listVerifiedSenders());
      } catch (error) {
        verifiedSenders = unknown(error instanceof Error ? error.message : String(error));
      }
    }
    if (wantsInbound) {
      try {
        inboundRoutes = known(await sendgrid.adapter.listInboundParseWebhooks());
      } catch (error) {
        inboundRoutes = unknown(error instanceof Error ? error.message : String(error));
      }
    }
    if (wantsDeliveryEvents) {
      try {
        deliveryEvents = knownValue(await sendgrid.adapter.getEventWebhookSettings());
      } catch (error) {
        deliveryEvents = unknown(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (wantsDns && environmentSpec.domain) {
    const domain = normalizeDomainName(environmentSpec.domain);
    const cloudflare = getCloudflareAdapterFromHints(cloudflareScopeHintsForDomain(domain));
    if ('error' in cloudflare) {
      dnsRecords = unknown(cloudflare.error);
    } else {
      try {
        const zone = await findCloudflareZone(cloudflare.adapter, domain);
        if (!zone) {
          dnsRecords = known();
        } else {
          const targetNames = new Set<string>();
          if (statefulKnown(domainAuthentications)) {
            const auth = domainAuthentications.items.find((candidate) =>
              normalizeDomainName(candidate.domain) === domain
            );
            for (const record of [auth?.dns.dkim1, auth?.dns.dkim2, auth?.dns.mail_cname]) {
              if (record) targetNames.add(record.host.toLowerCase().replace(/\.$/, ''));
            }
          }
          if (environmentSpec.email.inbound) {
            targetNames.add(environmentSpec.email.inbound.hostname.toLowerCase().replace(/\.$/, ''));
          }
          const records = await cloudflare.adapter.listDnsRecords(zone.id);
          dnsRecords = known(records.filter((record) =>
            targetNames.has(record.name.toLowerCase().replace(/\.$/, ''))
          ));
        }
      } catch (error) {
        dnsRecords = unknown(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (wantsForwarding && environmentSpec.domain) {
    const domain = normalizeDomainName(environmentSpec.domain);
    const cloudflare = await resolveCloudflareEmailContext(domain);
    if ('error' in cloudflare) {
      forwardingSettings = unknown(cloudflare.error);
      forwardingDestinations = unknown(cloudflare.error);
      forwardingRules = unknown(cloudflare.error);
      forwardingCatchAll = unknown(cloudflare.error);
    } else {
      const observe = async <T>(read: () => Promise<T>): Promise<EmailValueObservation<T>> => {
        try {
          return knownValue(await read());
        } catch (error) {
          return unknown(error instanceof Error ? error.message : String(error));
        }
      };
      forwardingSettings = await observe(() => cloudflare.adapter.getEmailRoutingSettings(cloudflare.zone.id));
      const destinations = await observe(() => cloudflare.adapter.listEmailRoutingAddresses(cloudflare.accountId));
      forwardingDestinations = destinations.status === 'known'
        ? known(destinations.value)
        : destinations;
      const rules = await observe(() => cloudflare.adapter.listEmailRoutingRules(cloudflare.zone.id));
      forwardingRules = rules.status === 'known' ? known(rules.value) : rules;
      forwardingCatchAll = await observe(() => cloudflare.adapter.getEmailRoutingCatchAll(cloudflare.zone.id));
    }
  }

  for (const [name, observation] of Object.entries({
    runtimeKey,
    domainAuthentication: domainAuthentications,
    senderVerification: verifiedSenders,
    inboundParse: inboundRoutes,
    dns: dnsRecords,
    deliveryEvents,
    forwardingSettings,
    forwardingDestinations,
    forwardingRules,
    forwardingCatchAll,
  })) {
    if (name === 'deliveryEvents' && !wantsDeliveryEvents) continue;
    if (name.startsWith('forwarding') && !wantsForwarding) continue;
    if (observation.status === 'unknown') {
      warnings.push(`Email ${name} observation is unknown: ${observation.error}`);
    }
  }

  return {
    runtimeKey,
    domainAuthentications,
    verifiedSenders,
    inboundRoutes,
    dnsRecords,
    deliveryEvents,
    forwardingSettings,
    forwardingDestinations,
    forwardingRules,
    forwardingCatchAll,
    warnings,
  };
}

function statefulKnown<T>(observation: EmailObservation<T>): observation is KnownObservation<T> {
  return observation.status === 'known';
}

function serviceUrl(environment: Environment | null, serviceName: string): string | undefined {
  if (!environment) return undefined;
  const binding = serviceBindingFor(environment, serviceName);
  const value = stringValue(binding, 'url');
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function inboundParseUrl(environment: Environment | null, inbound: EmailInboundSpec): string | undefined {
  const base = serviceUrl(environment, inbound.service);
  if (!base) return undefined;
  return new URL(inbound.path, base).toString();
}

export function emailRuntimeKeysForService(environmentSpec: EnvironmentSpec, serviceName: string): string[] {
  const keys = ['SENDGRID_API_KEY'];
  if (environmentSpec.email.sender) {
    keys.push('SENDGRID_FROM_EMAIL');
    if (environmentSpec.email.sender.name) keys.push('SENDGRID_FROM_NAME');
    if (environmentSpec.email.sender.replyTo) keys.push('SENDGRID_REPLY_TO');
  }
  if (environmentSpec.email.inbound?.service === serviceName) {
    keys.push('SENDGRID_INBOUND_HOSTNAME', 'SENDGRID_INBOUND_ALIASES');
  }
  return keys.sort();
}

export function emailRuntimeConfigHash(environmentSpec: EnvironmentSpec): string {
  const services = Object.keys(environmentSpec.services).sort();
  return emailConfigHash({
    services: services.map((service) => ({
      service,
      keys: emailRuntimeKeysForService(environmentSpec, service),
    })),
    sender: environmentSpec.email.sender ?? null,
    inbound: environmentSpec.email.inbound
      ? {
        hostname: environmentSpec.email.inbound.hostname,
        service: environmentSpec.email.inbound.service,
        aliases: [...environmentSpec.email.inbound.aliases].sort(),
      }
      : null,
  });
}

export function emailAuthorizationConfigHash(environmentSpec: EnvironmentSpec): string | undefined {
  if (environmentSpec.domain) {
    return emailConfigHash({ mode: 'domain', domain: normalizeDomainName(environmentSpec.domain) });
  }
  if (environmentSpec.email.sender) {
    return emailConfigHash({
      mode: 'singleSender',
      address: environmentSpec.email.sender.address.toLowerCase(),
    });
  }
  return undefined;
}

export function emailDnsConfigHash(environmentSpec: EnvironmentSpec): string | undefined {
  if (!environmentSpec.domain) return undefined;
  return emailConfigHash({
    domain: normalizeDomainName(environmentSpec.domain),
    inboundHostname: environmentSpec.email.inbound?.hostname.toLowerCase() ?? null,
  });
}

export function emailInboundConfigHash(environmentSpec: EnvironmentSpec): string | undefined {
  const inbound = environmentSpec.email.inbound;
  if (!inbound) return undefined;
  return emailConfigHash({
    hostname: inbound.hostname.toLowerCase(),
    service: inbound.service,
    path: inbound.path,
    aliases: [...inbound.aliases].map((alias) => alias.toLowerCase()).sort(),
    spamCheck: inbound.spamCheck,
    sendRaw: inbound.sendRaw,
  });
}

export function deliveryEventsUrl(
  environment: Environment | null,
  deliveryEvents: NonNullable<EnvironmentSpec['email']['deliveryEvents']>
): string | undefined {
  const base = serviceUrl(environment, deliveryEvents.service);
  return base ? new URL(deliveryEvents.path, base).toString() : undefined;
}

export function emailDeliveryEventsConfigHash(environmentSpec: EnvironmentSpec): string | undefined {
  const deliveryEvents = environmentSpec.email.deliveryEvents;
  if (!deliveryEvents) return undefined;
  return emailConfigHash({
    service: deliveryEvents.service,
    path: deliveryEvents.path,
    events: [...deliveryEvents.events].sort(),
  });
}

function desiredForwardingAliases(environmentSpec: EnvironmentSpec): Record<string, string> {
  if (!environmentSpec.domain || !environmentSpec.email.forwarding) return {};
  const domain = normalizeDomainName(environmentSpec.domain);
  return Object.fromEntries(Object.entries(environmentSpec.email.forwarding.aliases)
    .map(([alias, destination]) => [`${alias.toLowerCase()}@${domain}`, destination.toLowerCase()])
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function emailForwardingConfigHash(environmentSpec: EnvironmentSpec): string | undefined {
  if (!environmentSpec.domain || !environmentSpec.email.forwarding) return undefined;
  return emailConfigHash({
    domain: normalizeDomainName(environmentSpec.domain),
    aliases: desiredForwardingAliases(environmentSpec),
    catchAll: environmentSpec.email.forwarding.catchAll,
  });
}

function forwardingRuleMatches(rule: CloudflareEmailRoutingRule, destination: string): boolean {
  const forwards = forwardedTo(rule).map((value) => value.toLowerCase());
  return rule.enabled && forwards.length === 1 && forwards[0] === destination;
}

function forwardingCatchAllMatches(
  rule: CloudflareEmailRoutingRule,
  desired: NonNullable<EnvironmentSpec['email']['forwarding']>['catchAll']
): boolean {
  if (!rule.enabled) return false;
  if (desired.action === 'drop') {
    return rule.actions.length === 1 && rule.actions[0].type === 'drop';
  }
  const forwards = forwardedTo(rule).map((value) => value.toLowerCase());
  return forwards.length === 1 && forwards[0] === desired.destination.toLowerCase();
}

function planDeliveryEvents(params: {
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  state: EmailIntegrationState;
  bindings: Record<string, unknown>;
  serviceDependencies?: string[];
}): PlanAction[] {
  const desired = params.environmentSpec.email.deliveryEvents;
  if (!desired) return [];
  const binding = asRecord(params.bindings.deliveryEvents);
  const configHash = emailDeliveryEventsConfigHash(params.environmentSpec)!;
  const expectedUrl = deliveryEventsUrl(params.environment, desired);
  let type: PlanAction['type'] = 'update';
  let operation: string = EMAIL_OPERATIONS.deliveryEventsEnsure;
  let reason = 'Configure the SendGrid account delivery-event webhook';
  let verified = false;
  let blockedReason: string | undefined;
  if (params.state.deliveryEvents.status === 'unknown') {
    if (stringValue(binding, 'configHash') === configHash && stringValue(binding, 'url') === expectedUrl) {
      type = 'noop';
      reason = 'Preserving the recorded delivery-event webhook because provider observation is unknown';
    } else {
      blockedReason = 'email_delivery_events_observation_unknown';
    }
  } else if (!expectedUrl) {
    blockedReason = 'email_delivery_events_service_url_missing';
    reason = `Delivery-event service ${desired.service} has no public provider URL`;
  } else {
    const live = params.state.deliveryEvents.value;
    const enabledEvents = [...desired.events].every((event) => live[event] === true);
    const disabledEvents = Object.keys(live)
      .filter((key) => !['enabled', 'url'].includes(key) && typeof live[key as keyof SendGridEventWebhookSettings] === 'boolean')
      .every((event) => desired.events.includes(event as typeof desired.events[number]) || live[event as keyof SendGridEventWebhookSettings] === false);
    const matches = live.enabled && live.url === expectedUrl && enabledEvents && disabledEvents;
    if (matches && stringValue(binding, 'configHash') === configHash) {
      type = 'noop';
      verified = true;
      reason = 'SendGrid delivery-event webhook is in sync';
    } else if (matches && !stringValue(binding, 'configHash')) {
      operation = EMAIL_OPERATIONS.deliveryEventsAdopt;
      reason = 'Adopt the existing SendGrid delivery-event webhook';
    } else if (live.enabled && !stringValue(binding, 'configHash')) {
      type = 'replace';
      reason = 'Replace the unmanaged account-level SendGrid delivery-event webhook';
    }
  }
  return [{
    id: 'email:sendgrid:delivery-events',
    type,
    resource: { kind: 'email', name: 'delivery-events', provider: 'sendgrid' },
    verified,
    reason,
    ...(type === 'replace' ? { requiresConfirm: true } : {}),
    ...(params.serviceDependencies?.length ? { dependsOn: [...new Set(params.serviceDependencies)] } : {}),
    metadata: {
      operation,
      service: desired.service,
      path: desired.path,
      events: [...desired.events].sort(),
      configHash,
      ...(expectedUrl ? { expectedUrl } : {}),
      ...(blockedReason ? blockedMetadata(blockedReason) : {}),
    },
  }];
}

function planForwarding(params: {
  environmentSpec: EnvironmentSpec;
  state: EmailIntegrationState;
  bindings: Record<string, unknown>;
}): PlanAction[] {
  const forwarding = params.environmentSpec.email.forwarding;
  const domain = params.environmentSpec.domain
    ? normalizeDomainName(params.environmentSpec.domain)
    : undefined;
  if (!forwarding || !domain) return [];
  const actions: PlanAction[] = [];
  const forwardingBinding = asRecord(params.bindings.forwarding);
  const dnsBinding = asRecord(forwardingBinding?.dns);
  const destinationBindings = asRecord(forwardingBinding?.destinations) ?? {};
  const aliasBindings = asRecord(forwardingBinding?.aliases) ?? {};
  const configHash = emailForwardingConfigHash(params.environmentSpec)!;

  let dnsType: PlanAction['type'] = 'update';
  let dnsOperation: string = EMAIL_OPERATIONS.forwardingDnsEnsure;
  let dnsVerified = false;
  let dnsReason = `Enable Cloudflare Email Routing DNS for ${domain}`;
  let dnsBlocked: string | undefined;
  if (params.state.forwardingSettings.status === 'unknown') {
    if (stringValue(dnsBinding, 'zoneId')) {
      dnsType = 'noop';
      dnsReason = 'Preserving recorded Email Routing DNS because provider observation is unknown';
    } else dnsBlocked = 'email_forwarding_observation_unknown';
  } else if (params.state.forwardingSettings.value.enabled) {
    dnsVerified = true;
    if (stringValue(dnsBinding, 'zoneId')) {
      dnsType = 'noop';
      dnsReason = `Cloudflare Email Routing DNS is enabled for ${domain}`;
    } else {
      dnsOperation = EMAIL_OPERATIONS.forwardingDnsAdopt;
      dnsReason = `Record existing Cloudflare Email Routing DNS for ${domain}`;
    }
  }
  const dnsAction: PlanAction = {
    id: 'email:cloudflare:forwarding-dns',
    type: dnsType,
    resource: { kind: 'domain', name: domain, provider: 'cloudflare' },
    verified: dnsVerified,
    reason: dnsReason,
    metadata: {
      operation: dnsOperation,
      domain,
      configHash,
      ...(dnsBlocked ? blockedMetadata(dnsBlocked) : {}),
    },
  };
  actions.push(dnsAction);

  const aliases = desiredForwardingAliases(params.environmentSpec);
  const destinations = [...new Set([
    ...Object.values(aliases),
    ...(forwarding.catchAll.action === 'forward' ? [forwarding.catchAll.destination.toLowerCase()] : []),
  ])].sort();
  const destinationActionIds = new Map<string, string>();
  for (const email of destinations) {
    const actionId = `email:cloudflare:destination:${email}`;
    destinationActionIds.set(email, actionId);
    const binding = asRecord(destinationBindings[email]);
    let type: PlanAction['type'] = 'create';
    let operation: string = EMAIL_OPERATIONS.forwardingDestinationEnsure;
    let reason = `Create Cloudflare Email Routing destination ${email}`;
    let verified = false;
    let blockedReason: string | undefined;
    let candidateExternalId: string | undefined;
    if (params.state.forwardingDestinations.status === 'unknown') {
      if (stringValue(binding, 'externalId') && booleanValue(binding, 'verified')) {
        type = 'noop';
        reason = 'Preserving verified forwarding destination because provider observation is unknown';
      } else blockedReason = 'email_forwarding_destination_observation_unknown';
    } else {
      const matches = params.state.forwardingDestinations.items
        .filter((candidate) => candidate.email.toLowerCase() === email);
      if (matches.length > 1) {
        type = 'update';
        blockedReason = 'email_forwarding_destination_identity_ambiguous';
        reason = `Multiple Cloudflare forwarding destinations match ${email}`;
      } else if (matches.length === 1) {
        candidateExternalId = matches[0].id;
        const boundId = stringValue(binding, 'externalId');
        if (boundId && boundId !== candidateExternalId) {
          type = 'update';
          blockedReason = 'email_forwarding_destination_binding_mismatch';
        } else if (matches[0].verified) {
          verified = true;
          if (boundId) {
            type = 'noop';
            reason = `Forwarding destination ${email} is verified`;
          } else {
            type = 'update';
            operation = EMAIL_OPERATIONS.forwardingDestinationAdopt;
            reason = `Adopt verified forwarding destination ${email}`;
          }
        } else {
          type = 'update';
          reason = `Wait for ${email} to accept Cloudflare destination verification`;
        }
      }
    }
    actions.push({
      id: actionId,
      type,
      resource: { kind: 'email', name: email, provider: 'cloudflare' },
      verified,
      reason,
      metadata: {
        operation,
        domain,
        destination: email,
        ...(candidateExternalId ? { candidateExternalId } : {}),
        ...(blockedReason ? blockedMetadata(blockedReason) : {}),
      },
    });
  }

  for (const [alias, destination] of Object.entries(aliases)) {
    const binding = asRecord(aliasBindings[alias]);
    let type: PlanAction['type'] = 'create';
    let operation: string = EMAIL_OPERATIONS.forwardingRuleEnsure;
    let reason = `Create forwarding rule ${alias} -> ${destination}`;
    let verified = false;
    let blockedReason: string | undefined;
    let candidateExternalId: string | undefined;
    if (params.state.forwardingRules.status === 'unknown') {
      if (stringValue(binding, 'externalId') && stringValue(binding, 'destination') === destination) {
        type = 'noop';
        reason = 'Preserving recorded forwarding rule because provider observation is unknown';
      } else blockedReason = 'email_forwarding_rule_observation_unknown';
    } else {
      const matches = params.state.forwardingRules.items.filter((rule) => routingRuleForAddress(rule, alias));
      if (matches.length > 1) {
        type = 'update';
        blockedReason = 'email_forwarding_rule_identity_ambiguous';
        reason = `Multiple Cloudflare forwarding rules match ${alias}`;
      } else if (matches.length === 1) {
        candidateExternalId = matches[0].id;
        const boundId = stringValue(binding, 'externalId');
        if (boundId && boundId !== candidateExternalId) {
          type = 'update';
          blockedReason = 'email_forwarding_rule_binding_mismatch';
        } else if (forwardingRuleMatches(matches[0], destination)) {
          verified = true;
          if (boundId) {
            type = 'noop';
            reason = `Forwarding rule ${alias} is in sync`;
          } else {
            type = 'update';
            operation = EMAIL_OPERATIONS.forwardingRuleAdopt;
            reason = `Adopt existing forwarding rule ${alias}`;
          }
        } else {
          type = 'update';
          reason = `Update forwarding rule ${alias} -> ${destination}`;
        }
      }
    }
    actions.push({
      id: `email:cloudflare:forward:${alias}`,
      type,
      resource: { kind: 'email', name: alias, provider: 'cloudflare' },
      verified,
      reason,
      dependsOn: [dnsAction.id, destinationActionIds.get(destination)!],
      metadata: {
        operation,
        domain,
        alias,
        destination,
        configHash: emailConfigHash({ alias, destination }),
        ...(candidateExternalId ? { candidateExternalId } : {}),
        ...(blockedReason ? blockedMetadata(blockedReason) : {}),
      },
    });
  }

  for (const [alias, rawBinding] of Object.entries(aliasBindings)) {
    if (alias in aliases) continue;
    const binding = asRecord(rawBinding);
    const externalId = stringValue(binding, 'externalId');
    if (!externalId) continue;
    actions.push({
      id: `email:cloudflare:forward:${alias}:destroy`,
      type: 'destroy',
      resource: { kind: 'email', name: alias, provider: 'cloudflare' },
      verified: params.state.forwardingRules.status === 'known',
      reason: `Delete formerly managed forwarding rule ${alias}`,
      metadata: {
        operation: EMAIL_OPERATIONS.forwardingRuleDestroy,
        domain,
        alias,
        externalId,
        ...(params.state.forwardingRules.status === 'unknown'
          ? blockedMetadata('email_forwarding_rule_observation_unknown')
          : {}),
      },
    });
  }

  const catchAllBinding = asRecord(forwardingBinding?.catchAll);
  const catchAll = forwarding.catchAll;
  let catchAllType: PlanAction['type'] = 'update';
  let catchAllOperation: string = EMAIL_OPERATIONS.forwardingCatchAllEnsure;
  let catchAllReason = `Configure the ${domain} catch-all route to ${catchAll.action}`;
  let catchAllVerified = false;
  let catchAllBlocked: string | undefined;
  if (params.state.forwardingCatchAll.status === 'unknown') {
    if (stringValue(catchAllBinding, 'configHash') === emailConfigHash(catchAll)) {
      catchAllType = 'noop';
      catchAllReason = 'Preserving recorded catch-all route because provider observation is unknown';
    } else catchAllBlocked = 'email_forwarding_catchall_observation_unknown';
  } else if (forwardingCatchAllMatches(params.state.forwardingCatchAll.value, catchAll)) {
    catchAllVerified = true;
    if (stringValue(catchAllBinding, 'configHash') === emailConfigHash(catchAll)) {
      catchAllType = 'noop';
      catchAllReason = `Catch-all route for ${domain} is in sync`;
    } else {
      catchAllOperation = EMAIL_OPERATIONS.forwardingCatchAllAdopt;
      catchAllReason = `Adopt the existing catch-all route for ${domain}`;
    }
  }
  actions.push({
    id: 'email:cloudflare:forwarding-catchall',
    type: catchAllType,
    resource: { kind: 'email', name: `${domain}:catch-all`, provider: 'cloudflare' },
    verified: catchAllVerified,
    reason: catchAllReason,
    dependsOn: [
      dnsAction.id,
      ...(catchAll.action === 'forward'
        ? [destinationActionIds.get(catchAll.destination.toLowerCase())!]
        : []),
    ],
    metadata: {
      operation: catchAllOperation,
      domain,
      action: catchAll.action,
      ...(catchAll.action === 'forward' ? { destination: catchAll.destination.toLowerCase() } : {}),
      configHash: emailConfigHash(catchAll),
      ...(catchAllBlocked ? blockedMetadata(catchAllBlocked) : {}),
    },
  });
  return actions;
}

function desiredDnsRecords(
  environmentSpec: EnvironmentSpec,
  state: EmailIntegrationState
): Array<{ type: string; name: string; content: string; priority?: number }> | undefined {
  if (!environmentSpec.domain || state.domainAuthentications.status === 'unknown') return undefined;
  const domain = normalizeDomainName(environmentSpec.domain);
  const matches = state.domainAuthentications.items.filter((auth) =>
    normalizeDomainName(auth.domain) === domain
  );
  if (matches.length > 1) return undefined;
  if (matches.length !== 1) return undefined;
  const records: Array<{ type: string; name: string; content: string; priority?: number }> = [
    matches[0].dns.dkim1,
    matches[0].dns.dkim2,
    matches[0].dns.mail_cname,
  ]
      .filter((record): record is NonNullable<typeof record> => Boolean(record))
      .map((record) => ({
        type: record.type.toUpperCase(),
        name: record.host.toLowerCase().replace(/\.$/, ''),
        content: record.data.toLowerCase().replace(/\.$/, ''),
      }));
  if (environmentSpec.email.inbound) {
    records.push({
      type: 'MX',
      name: environmentSpec.email.inbound.hostname.toLowerCase(),
      content: 'mx.sendgrid.net',
      priority: 10,
    });
  }
  return records;
}

function dnsRecordsMatch(
  desired: Array<{ type: string; name: string; content: string; priority?: number }>,
  observed: CloudflareDnsRecord[]
): { matches: boolean; duplicate: string | undefined } {
  for (const record of desired) {
    const candidates = observed.filter((candidate) =>
      candidate.type.toUpperCase() === record.type
      && candidate.name.toLowerCase().replace(/\.$/, '') === record.name
    );
    if (candidates.length > 1) return { matches: false, duplicate: `${record.type} ${record.name}` };
    if (candidates.length !== 1) return { matches: false, duplicate: undefined };
    const candidate = candidates[0];
    if (
      candidate.content.toLowerCase().replace(/\.$/, '') !== record.content
      || (record.priority !== undefined && candidate.priority !== record.priority)
    ) {
      return { matches: false, duplicate: undefined };
    }
  }
  return { matches: true, duplicate: undefined };
}

function blockedMetadata(reason: string): Record<string, unknown> {
  return { blockedReason: reason };
}

export async function planEmail(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
  serviceDependencies?: string[];
  domainDependencies?: string[];
  /** Provider observation already resolved by the caller; primarily useful for deterministic contract tests. */
  integrationState?: EmailIntegrationState;
}): Promise<EmailPlanResult> {
  const { project, environmentName, environmentSpec, environment, observed } = params;
  if (!environmentSpec.email.enabled) return { actions: [], warnings: [] };

  const state = params.integrationState
    ?? await resolveEmailIntegrationState({ project, environmentSpec });
  const actions: PlanAction[] = [];
  const bindings = emailBindings(environment);
  const serviceNames = Object.keys(environmentSpec.services).sort();

  const runtimeBinding = asRecord(bindings.runtime);
  const runtimeConfigHash = emailRuntimeConfigHash(environmentSpec);
  const servicesKnown = observed !== null && observed.completeness?.services !== 'unknown';
  const desiredRuntimeKeyHash = state.runtimeKey.status === 'known' ? state.runtimeKey.hash : undefined;
  const boundRuntimeKeyHash = stringValue(runtimeBinding, 'credentialHash');
  const runtimeCredentialMatches = desiredRuntimeKeyHash
    ? boundRuntimeKeyHash === desiredRuntimeKeyHash
    : Boolean(boundRuntimeKeyHash);
  const runtimeKeysPresent = servicesKnown && serviceNames.every((serviceName) => {
    const desiredKeys = emailRuntimeKeysForService(environmentSpec, serviceName);
    const observedService = observed?.services.find((service) => service.name === serviceName);
    return desiredKeys.every((key) => {
      if (!observedService?.envVarKeys.includes(key)) return false;
      if (key !== 'SENDGRID_API_KEY' || !desiredRuntimeKeyHash) return true;
      const liveHash = observedService.envVarHashes.SENDGRID_API_KEY;
      return liveHash ? liveHash === desiredRuntimeKeyHash : runtimeCredentialMatches;
    });
  });
  const runtimeBindingMatches = stringValue(runtimeBinding, 'configHash') === runtimeConfigHash
    && runtimeCredentialMatches;
  const runtimePreserved = (!servicesKnown || state.runtimeKey.status === 'unknown') && runtimeBindingMatches;
  actions.push({
    id: 'email:runtime',
    type: runtimeKeysPresent && runtimeBindingMatches || runtimePreserved ? 'noop' : 'update',
    resource: { kind: 'email', name: environmentName, provider: environmentSpec.hosting.provider },
    verified: runtimeKeysPresent && runtimeBindingMatches,
    reason: runtimeKeysPresent && runtimeBindingMatches
      ? 'SendGrid runtime configuration is present on every declared service'
      : runtimePreserved
        ? 'Preserving recorded SendGrid runtime configuration because service observation is unknown'
        : 'Sync SendGrid runtime configuration to declared services',
    ...(params.serviceDependencies?.length ? { dependsOn: [...new Set(params.serviceDependencies)] } : {}),
    metadata: {
      operation: EMAIL_OPERATIONS.runtimeSync,
      services: serviceNames,
      configHash: runtimeConfigHash,
      ...(desiredRuntimeKeyHash ? { credentialHash: desiredRuntimeKeyHash } : {}),
      managedKeys: [...EMAIL_MANAGED_ENV_KEYS],
      ...((!servicesKnown || state.runtimeKey.status === 'unknown') && !runtimeBindingMatches
        ? blockedMetadata('email_runtime_observation_unknown')
        : {}),
    },
  });

  let authorizationAction: PlanAction | undefined;
  if (environmentSpec.domain) {
    const domain = normalizeDomainName(environmentSpec.domain);
    const authorizationBinding = asRecord(bindings.authorization);
    const configHash = emailAuthorizationConfigHash(environmentSpec)!;
    const bindingTargetsDomain = stringValue(authorizationBinding, 'mode') === 'domain'
      && stringValue(authorizationBinding, 'domain') === domain;
    const boundId = bindingTargetsDomain ? stringValue(authorizationBinding, 'externalId') : undefined;
    let type: PlanAction['type'] = 'update';
    let operation: string = EMAIL_OPERATIONS.authorizationEnsure;
    let verified = false;
    let reason = `Create or reconcile SendGrid domain authentication for ${domain}`;
    let blockedReason: string | undefined;
    let candidateExternalId: string | undefined;

    if (state.domainAuthentications.status === 'unknown') {
      if (boundId && stringValue(authorizationBinding, 'configHash') === configHash) {
        type = 'noop';
        reason = 'Preserving recorded SendGrid domain authentication because provider observation is unknown';
      } else {
        blockedReason = 'email_authorization_observation_unknown';
      }
    } else {
      const matches = state.domainAuthentications.items.filter((auth) => normalizeDomainName(auth.domain) === domain);
      if (matches.length > 1) {
        blockedReason = 'email_authorization_identity_ambiguous';
        reason = `Multiple SendGrid domain authentications match ${domain}`;
      } else if (matches.length === 1) {
        candidateExternalId = String(matches[0].id);
        if (boundId && boundId !== candidateExternalId) {
          blockedReason = 'email_authorization_binding_mismatch';
          reason = `SendGrid domain authentication binding does not match the live ${domain} identity`;
        } else if (!boundId) {
          operation = EMAIL_OPERATIONS.authorizationAdopt;
          reason = `Adopt the existing SendGrid domain authentication for ${domain}`;
        } else if (stringValue(authorizationBinding, 'configHash') === configHash) {
          type = 'noop';
          verified = true;
          reason = `SendGrid domain authentication exists for ${domain}`;
        }
      } else {
        type = boundId ? 'update' : 'create';
        reason = boundId
          ? `Recreate the missing bound SendGrid domain authentication for ${domain}`
          : `Create SendGrid domain authentication for ${domain}`;
      }
    }

    authorizationAction = {
      id: 'email:sendgrid:authorization',
      type,
      resource: { kind: 'email', name: domain, provider: 'sendgrid' },
      verified,
      reason,
      ...(params.domainDependencies?.length ? { dependsOn: [...new Set(params.domainDependencies)] } : {}),
      metadata: {
        operation,
        mode: 'domain',
        domain,
        configHash,
        ...(candidateExternalId ? { candidateExternalId } : {}),
        ...(blockedReason ? blockedMetadata(blockedReason) : {}),
      },
    };
    actions.push(authorizationAction);
  } else if (environmentSpec.email.sender) {
    const sender = environmentSpec.email.sender;
    const address = sender.address.toLowerCase();
    const authorizationBinding = asRecord(bindings.authorization);
    const configHash = emailAuthorizationConfigHash(environmentSpec)!;
    const bindingTargetsSender = stringValue(authorizationBinding, 'mode') === 'singleSender'
      && stringValue(authorizationBinding, 'address') === address;
    const boundId = bindingTargetsSender ? stringValue(authorizationBinding, 'externalId') : undefined;
    let type: PlanAction['type'] = 'update';
    let operation: string = EMAIL_OPERATIONS.authorizationEnsure;
    let verified = false;
    let reason = `Create or reconcile SendGrid sender verification for ${address}`;
    let blockedReason: string | undefined;
    let candidateExternalId: string | undefined;

    if (state.verifiedSenders.status === 'unknown') {
      if (
        boundId
        && stringValue(authorizationBinding, 'configHash') === configHash
        && booleanValue(authorizationBinding, 'verified') === true
      ) {
        type = 'noop';
        reason = 'Preserving verified sender binding because provider observation is unknown';
      } else {
        blockedReason = 'email_authorization_observation_unknown';
      }
    } else {
      const matches = state.verifiedSenders.items.filter((candidate) => candidate.from_email?.toLowerCase() === address);
      if (matches.length > 1) {
        blockedReason = 'email_authorization_identity_ambiguous';
        reason = `Multiple SendGrid verified senders match ${address}`;
      } else if (matches.length === 1) {
        candidateExternalId = String(matches[0].id ?? address);
        if (boundId && boundId !== candidateExternalId) {
          blockedReason = 'email_authorization_binding_mismatch';
          reason = `SendGrid sender binding does not match the live ${address} identity`;
        } else if (!boundId) {
          operation = EMAIL_OPERATIONS.authorizationAdopt;
          reason = `Adopt the existing SendGrid sender identity for ${address}`;
        } else if (stringValue(authorizationBinding, 'configHash') === configHash && matches[0].verified === true) {
          type = 'noop';
          verified = true;
          reason = `SendGrid sender ${address} is verified`;
        } else if (matches[0].verified !== true) {
          reason = `Wait for ${address} to accept SendGrid sender verification`;
        }
      } else {
        type = boundId ? 'update' : 'create';
      }
    }

    authorizationAction = {
      id: 'email:sendgrid:authorization',
      type,
      resource: { kind: 'email', name: address, provider: 'sendgrid' },
      verified,
      reason,
      metadata: {
        operation,
        mode: 'singleSender',
        address,
        configHash,
        ...(candidateExternalId ? { candidateExternalId } : {}),
        ...(blockedReason ? blockedMetadata(blockedReason) : {}),
      },
    };
    actions.push(authorizationAction);
  }

  let dnsAction: PlanAction | undefined;
  if (environmentSpec.domain) {
    const domain = normalizeDomainName(environmentSpec.domain);
    const dnsBinding = asRecord(bindings.dns);
    const configHash = emailDnsConfigHash(environmentSpec)!;
    const desired = desiredDnsRecords(environmentSpec, state);
    let type: PlanAction['type'] = 'update';
    let operation: string = EMAIL_OPERATIONS.dnsSync;
    let verified = false;
    let reason = `Sync SendGrid DNS records in Cloudflare for ${domain}`;
    let blockedReason: string | undefined;

    if (state.dnsRecords.status === 'unknown') {
      if (stringValue(dnsBinding, 'configHash') === configHash) {
        type = 'noop';
        reason = 'Preserving recorded SendGrid DNS configuration because provider observation is unknown';
      } else {
        blockedReason = 'email_dns_observation_unknown';
      }
    } else if (desired) {
      const match = dnsRecordsMatch(desired, state.dnsRecords.items);
      if (match.duplicate) {
        blockedReason = 'email_dns_identity_ambiguous';
        reason = `Multiple Cloudflare records match ${match.duplicate}`;
      } else if (match.matches) {
        if (stringValue(dnsBinding, 'configHash') === configHash) {
          type = 'noop';
          verified = true;
          reason = `SendGrid DNS records are in sync for ${domain}`;
        } else {
          operation = EMAIL_OPERATIONS.dnsAdopt;
          reason = `Record existing SendGrid DNS identities for ${domain}`;
        }
      }
    }

    dnsAction = {
      id: 'email:cloudflare:dns',
      type,
      resource: { kind: 'domain', name: domain, provider: 'cloudflare' },
      verified,
      reason,
      dependsOn: authorizationAction ? [authorizationAction.id] : undefined,
      metadata: {
        operation,
        domain,
        configHash,
        ...(environmentSpec.email.inbound
          ? { inboundHostname: environmentSpec.email.inbound.hostname.toLowerCase() }
          : {}),
        ...(blockedReason ? blockedMetadata(blockedReason) : {}),
      },
    };
    actions.push(dnsAction);
  }

  let inboundAction: PlanAction | undefined;
  if (environmentSpec.email.inbound) {
    const inbound = environmentSpec.email.inbound;
    const hostname = inbound.hostname.toLowerCase();
    const expectedUrl = inboundParseUrl(environment, inbound);
    const inboundBinding = asRecord(bindings.inbound);
    const configHash = emailInboundConfigHash(environmentSpec)!;
    let type: PlanAction['type'] = 'update';
    let operation: string = EMAIL_OPERATIONS.inboundEnsure;
    let verified = false;
    let requiresConfirm = false;
    let reason = `Create or reconcile SendGrid inbound parse for ${hostname}`;
    let blockedReason: string | undefined;

    if (state.inboundRoutes.status === 'unknown') {
      if (
        stringValue(inboundBinding, 'configHash') === configHash
        && stringValue(inboundBinding, 'hostname') === hostname
      ) {
        type = 'noop';
        reason = 'Preserving recorded inbound parse route because provider observation is unknown';
      } else {
        blockedReason = 'email_inbound_observation_unknown';
      }
    } else {
      const matches = state.inboundRoutes.items.filter((route) => route.hostname.toLowerCase() === hostname);
      if (matches.length > 1) {
        blockedReason = 'email_inbound_identity_ambiguous';
        reason = `Multiple SendGrid inbound parse routes match ${hostname}`;
      } else if (matches.length === 1) {
        const routeMatches = Boolean(expectedUrl)
          && matches[0].url === expectedUrl
          && matches[0].spam_check === inbound.spamCheck
          && matches[0].send_raw === inbound.sendRaw;
        if (routeMatches && stringValue(inboundBinding, 'configHash') === configHash) {
          type = 'noop';
          verified = true;
          reason = `SendGrid inbound parse is in sync for ${hostname}`;
        } else if (routeMatches && !stringValue(inboundBinding, 'hostname')) {
          operation = EMAIL_OPERATIONS.inboundAdopt;
          reason = `Adopt the existing SendGrid inbound parse route for ${hostname}`;
        } else if (expectedUrl) {
          type = 'replace';
          operation = EMAIL_OPERATIONS.inboundReplace;
          requiresConfirm = true;
          reason = `Replace the SendGrid inbound parse route for ${hostname}`;
        }
      } else {
        type = 'create';
        reason = `Create SendGrid inbound parse for ${hostname}`;
      }
    }

    inboundAction = {
      id: `email:sendgrid:inbound:${hostname}`,
      type,
      resource: { kind: 'email', name: hostname, provider: 'sendgrid' },
      verified,
      reason,
      ...(requiresConfirm ? { requiresConfirm: true } : {}),
      dependsOn: [
        ...(dnsAction ? [dnsAction.id] : []),
        ...(params.serviceDependencies ?? []),
      ],
      metadata: {
        operation,
        hostname,
        service: inbound.service,
        path: inbound.path,
        aliases: [...inbound.aliases].map((alias) => alias.toLowerCase()).sort(),
        spamCheck: inbound.spamCheck,
        sendRaw: inbound.sendRaw,
        configHash,
        ...(expectedUrl ? { expectedUrl } : {}),
        ...(blockedReason ? blockedMetadata(blockedReason) : {}),
      },
    };
    actions.push(inboundAction);
  }

  actions.push(...planDeliveryEvents({
    environmentSpec,
    environment,
    state,
    bindings,
    serviceDependencies: params.serviceDependencies,
  }));
  actions.push(...planForwarding({ environmentSpec, state, bindings }));

  if (environmentSpec.domain) {
    const domain = normalizeDomainName(environmentSpec.domain);
    const matches = state.domainAuthentications.status === 'known'
      ? state.domainAuthentications.items.filter((auth) => normalizeDomainName(auth.domain) === domain)
      : [];
    const authorizationBinding = asRecord(bindings.authorization);
    const bindingVerified = booleanValue(authorizationBinding, 'verified') === true;
    const liveVerified = matches.length === 1 && matches[0].valid === true;
    const preserveUnknown = state.domainAuthentications.status === 'unknown' && bindingVerified;
    actions.push({
      id: 'email:sendgrid:authorization-verify',
      type: liveVerified && bindingVerified || preserveUnknown ? 'noop' : 'update',
      resource: { kind: 'email', name: domain, provider: 'sendgrid' },
      verified: liveVerified,
      reason: liveVerified
        ? 'SendGrid domain authentication is verified'
        : preserveUnknown
          ? 'Preserving recorded SendGrid verification because provider observation is unknown'
        : 'Validate SendGrid domain authentication after DNS synchronization',
      dependsOn: [
        ...(dnsAction ? [dnsAction.id] : []),
        ...(inboundAction ? [inboundAction.id] : []),
      ],
      metadata: {
        operation: EMAIL_OPERATIONS.authorizationVerify,
        mode: 'domain',
        domain,
        ...(state.domainAuthentications.status === 'unknown' && !bindingVerified
          ? blockedMetadata('email_authorization_observation_unknown')
          : {}),
      },
    });
  }

  if (!environmentSpec.domain && !environmentSpec.email.sender) {
    state.warnings.push('Email is enabled without environment.domain or email.sender; Hypervibe will sync the runtime key but cannot verify a sender identity.');
  }

  return {
    actions,
    warnings: state.warnings,
    fingerprint: emailIntegrationFingerprint(state),
  };
}
