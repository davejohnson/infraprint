import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { CloudflareAdapter } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SendGridAdapter } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import {
  EMAIL_OPERATIONS,
  emailAuthorizationConfigHash,
  emailDnsConfigHash,
  emailInboundConfigHash,
  emailRuntimeConfigHash,
  planEmail,
  resolveEmailIntegrationState,
  type EmailIntegrationState,
} from '../email-plan.service.js';

const project = {
  id: 'project-1',
  name: 'email-app',
  defaultPlatform: 'railway',
  policies: {},
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies Project;

function spec() {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { api: { workloadKind: 'web', public: true } },
    domain: 'example.com',
    email: {
      enabled: true,
      sender: { address: 'hello@example.com', name: 'Example', replyTo: 'support@example.com' },
      inbound: {
        hostname: 'inbound.example.com',
        service: 'api',
        path: '/webhooks/sendgrid/inbound',
        aliases: ['support', 'replies'],
      },
    },
  });
}

function ciInboxSpec() {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { api: { workloadKind: 'web', public: true } },
    domain: 'staging.example.com',
    email: {
      enabled: true,
      sender: { address: 'canary@staging.example.com', name: 'Example Canary' },
      inbound: {
        hostname: 'ci-mail.staging.example.com',
        service: 'api',
        path: '/api/webhooks/canary-email-receipts',
        aliases: [],
      },
    },
  });
}

function specWithRouting() {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    services: { api: { workloadKind: 'web', public: true } },
    domain: 'example.com',
    email: {
      enabled: true,
      sender: { address: 'hello@example.com' },
      deliveryEvents: { service: 'api', events: ['delivered', 'bounce'] },
      forwarding: {
        aliases: { support: 'owner@example.net' },
        catchAll: { action: 'forward', destination: 'owner@example.net' },
      },
    },
  });
}

function environment(email: Record<string, unknown> = {}): Environment {
  return {
    id: 'environment-1',
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      services: { api: { serviceId: 'service-1', url: 'https://api.example.com' } },
      ...(Object.keys(email).length > 0 ? { email } : {}),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function observed(keys: string[] = []): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    services: [{
      name: 'api',
      externalId: 'service-1',
      workloadKind: 'web',
      url: 'https://api.example.com',
      customDomains: [],
      config: { public: true },
      envVarKeys: keys,
      envVarHashes: {},
      status: 'running',
    }],
    databases: [],
    completeness: { services: 'complete' },
    partial: false,
    warnings: [],
  };
}

function state(overrides: Partial<EmailIntegrationState> = {}): EmailIntegrationState {
  return {
    runtimeKey: { status: 'known', hash: 'runtime-key-hash' },
    domainAuthentications: { status: 'known', items: [] },
    verifiedSenders: { status: 'known', items: [] },
    inboundRoutes: { status: 'known', items: [] },
    dnsRecords: { status: 'known', items: [] },
    deliveryEvents: { status: 'unknown', error: 'not requested' },
    forwardingSettings: { status: 'unknown', error: 'not requested' },
    forwardingDestinations: { status: 'known', items: [] },
    forwardingRules: { status: 'known', items: [] },
    forwardingCatchAll: { status: 'unknown', error: 'not requested' },
    warnings: [],
    ...overrides,
  };
}

const domainAuthentication = {
  id: 42,
  domain: 'example.com',
  subdomain: 'em',
  username: 'user',
  valid: true,
  default: false,
  legacy: false,
  dns: {
    dkim1: { host: 's1._domainkey.example.com', type: 'CNAME', data: 's1.sendgrid.net', valid: true },
    dkim2: { host: 's2._domainkey.example.com', type: 'CNAME', data: 's2.sendgrid.net', valid: true },
    mail_cname: { host: 'em.example.com', type: 'CNAME', data: 'u.sendgrid.net', valid: true },
  },
};

describe('planEmail', () => {
  it('plans explicit runtime, authorization, DNS, inbound, and verification actions', async () => {
    const result = await planEmail({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment(),
      observed: observed(),
      serviceDependencies: ['service:api'],
      integrationState: state(),
    });

    expect(result.actions.map((action) => [action.id, action.type, action.metadata?.operation])).toEqual([
      ['email:runtime', 'update', EMAIL_OPERATIONS.runtimeSync],
      ['email:sendgrid:authorization', 'create', EMAIL_OPERATIONS.authorizationEnsure],
      ['email:cloudflare:dns', 'update', EMAIL_OPERATIONS.dnsSync],
      ['email:sendgrid:inbound:inbound.example.com', 'create', EMAIL_OPERATIONS.inboundEnsure],
      ['email:sendgrid:authorization-verify', 'update', EMAIL_OPERATIONS.authorizationVerify],
    ]);
    expect(result.actions[2].dependsOn).toEqual(['email:sendgrid:authorization']);
    expect(result.actions[3].dependsOn).toEqual(['email:cloudflare:dns', 'service:api']);
    expect(result.actions[4].dependsOn).toEqual([
      'email:cloudflare:dns',
      'email:sendgrid:inbound:inbound.example.com',
    ]);
  });

  it('keeps dynamic CI recipients application-owned while planning their dedicated inbound hostname', async () => {
    const result = await planEmail({
      project,
      environmentName: 'staging',
      environmentSpec: ciInboxSpec(),
      environment: environment(),
      observed: observed(),
      serviceDependencies: ['service:api'],
      integrationState: state(),
    });

    expect(result.actions.find((action) => action.id === 'email:runtime')).toMatchObject({
      type: 'update',
      dependsOn: ['service:api'],
      metadata: {
        operation: EMAIL_OPERATIONS.runtimeSync,
        services: ['api'],
      },
    });
    expect(result.actions.find((action) => action.id === 'email:sendgrid:inbound:ci-mail.staging.example.com'))
      .toMatchObject({
        type: 'create',
        resource: {
          kind: 'email',
          name: 'ci-mail.staging.example.com',
          provider: 'sendgrid',
        },
        dependsOn: ['email:cloudflare:dns', 'service:api'],
        metadata: {
          operation: EMAIL_OPERATIONS.inboundEnsure,
          hostname: 'ci-mail.staging.example.com',
          service: 'api',
          path: '/api/webhooks/canary-email-receipts',
          aliases: [],
          expectedUrl: 'https://api.example.com/api/webhooks/canary-email-receipts',
        },
      });
  });

  it('plans explicit adoption when matching live identities are not locally bound', async () => {
    const result = await planEmail({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment(),
      observed: observed(),
      integrationState: state({
        domainAuthentications: { status: 'known', items: [domainAuthentication] },
        inboundRoutes: {
          status: 'known',
          items: [{
            hostname: 'inbound.example.com',
            url: 'https://api.example.com/webhooks/sendgrid/inbound',
            spam_check: true,
            send_raw: false,
          }],
        },
        dnsRecords: {
          status: 'known',
          items: [
            { id: 'dns-1', zone_id: 'zone-1', zone_name: 'example.com', name: 's1._domainkey.example.com', type: 'CNAME', content: 's1.sendgrid.net', proxiable: true, proxied: false, ttl: 1, created_on: '', modified_on: '' },
            { id: 'dns-2', zone_id: 'zone-1', zone_name: 'example.com', name: 's2._domainkey.example.com', type: 'CNAME', content: 's2.sendgrid.net', proxiable: true, proxied: false, ttl: 1, created_on: '', modified_on: '' },
            { id: 'dns-3', zone_id: 'zone-1', zone_name: 'example.com', name: 'em.example.com', type: 'CNAME', content: 'u.sendgrid.net', proxiable: true, proxied: false, ttl: 1, created_on: '', modified_on: '' },
            { id: 'dns-4', zone_id: 'zone-1', zone_name: 'example.com', name: 'inbound.example.com', type: 'MX', content: 'mx.sendgrid.net', priority: 10, proxiable: false, proxied: false, ttl: 1, created_on: '', modified_on: '' },
          ],
        },
      }),
    });

    expect(result.actions.find((action) => action.id === 'email:sendgrid:authorization')?.metadata?.operation)
      .toBe(EMAIL_OPERATIONS.authorizationAdopt);
    expect(result.actions.find((action) => action.id === 'email:cloudflare:dns')?.metadata?.operation)
      .toBe(EMAIL_OPERATIONS.dnsAdopt);
    expect(result.actions.find((action) => action.id.includes(':inbound:'))?.metadata?.operation)
      .toBe(EMAIL_OPERATIONS.inboundAdopt);
  });

  it('makes an inbound route replacement explicit and confirm-gated', async () => {
    const desired = spec();
    const result = await planEmail({
      project,
      environmentName: 'production',
      environmentSpec: desired,
      environment: environment({
        runtime: { configHash: emailRuntimeConfigHash(desired) },
        authorization: { configHash: emailAuthorizationConfigHash(desired), externalId: '42', verified: true },
        dns: { configHash: emailDnsConfigHash(desired) },
        inbound: { configHash: emailInboundConfigHash(desired), hostname: 'inbound.example.com' },
      }),
      observed: observed(),
      integrationState: state({
        domainAuthentications: { status: 'known', items: [domainAuthentication] },
        inboundRoutes: {
          status: 'known',
          items: [{
            hostname: 'inbound.example.com',
            url: 'https://old.example.com/parse',
            spam_check: true,
            send_raw: false,
          }],
        },
      }),
    });
    const inbound = result.actions.find((action) => action.id.includes(':inbound:'));
    expect(inbound).toMatchObject({
      type: 'replace',
      requiresConfirm: true,
      metadata: { operation: EMAIL_OPERATIONS.inboundReplace },
    });
  });

  it('preserves matching bindings when provider observation is unknown', async () => {
    const desired = spec();
    const result = await planEmail({
      project,
      environmentName: 'production',
      environmentSpec: desired,
      environment: environment({
        runtime: {
          configHash: emailRuntimeConfigHash(desired),
          credentialHash: 'runtime-key-hash',
        },
        authorization: {
          mode: 'domain',
          domain: 'example.com',
          configHash: emailAuthorizationConfigHash(desired),
          externalId: '42',
          verified: true,
        },
        dns: { configHash: emailDnsConfigHash(desired) },
        inbound: { configHash: emailInboundConfigHash(desired), hostname: 'inbound.example.com' },
      }),
      observed: observed([
        'SENDGRID_API_KEY',
        'SENDGRID_FROM_EMAIL',
        'SENDGRID_FROM_NAME',
        'SENDGRID_REPLY_TO',
        'SENDGRID_INBOUND_HOSTNAME',
        'SENDGRID_INBOUND_ALIASES',
      ]),
      integrationState: state({
        domainAuthentications: { status: 'unknown', error: 'timeout' },
        inboundRoutes: { status: 'unknown', error: 'timeout' },
        dnsRecords: { status: 'unknown', error: 'timeout' },
      }),
    });

    expect(result.actions.every((action) => action.type === 'noop')).toBe(true);
  });

  it('blocks ambiguous provider identities instead of choosing one', async () => {
    const duplicate = { ...domainAuthentication, id: 43 };
    const result = await planEmail({
      project,
      environmentName: 'production',
      environmentSpec: spec(),
      environment: environment(),
      observed: observed(),
      integrationState: state({
        domainAuthentications: { status: 'known', items: [domainAuthentication, duplicate] },
      }),
    });

    expect(result.actions.find((action) => action.id === 'email:sendgrid:authorization'))
      .toMatchObject({ metadata: { blockedReason: 'email_authorization_identity_ambiguous' } });
  });

  it('plans event delivery and forwarding as explicit dependent actions', async () => {
    const result = await planEmail({
      project,
      environmentName: 'production',
      environmentSpec: specWithRouting(),
      environment: environment(),
      observed: observed(),
      serviceDependencies: ['service:api'],
      integrationState: state({
        deliveryEvents: {
          status: 'known',
          value: {
            enabled: false,
            url: '',
            group_resubscribe: false,
            delivered: false,
            group_unsubscribe: false,
            spam_report: false,
            bounce: false,
            deferred: false,
            unsubscribe: false,
            processed: false,
            open: false,
            click: false,
            dropped: false,
          },
        },
        forwardingSettings: {
          status: 'known',
          value: { id: 'routing', enabled: false, name: 'Email Routing', status: 'unconfigured' },
        },
        forwardingDestinations: { status: 'known', items: [] },
        forwardingRules: { status: 'known', items: [] },
        forwardingCatchAll: {
          status: 'known',
          value: { id: 'catch-all', enabled: false, actions: [{ type: 'drop' }], matchers: [{ type: 'all' }] },
        },
      }),
    });

    const delivery = result.actions.find((action) => action.id === 'email:sendgrid:delivery-events');
    const destination = result.actions.find((action) => action.id === 'email:cloudflare:destination:owner@example.net');
    const forward = result.actions.find((action) => action.id === 'email:cloudflare:forward:support@example.com');
    const catchAll = result.actions.find((action) => action.id === 'email:cloudflare:forwarding-catchall');
    expect(delivery).toMatchObject({
      type: 'update',
      dependsOn: ['service:api'],
      metadata: { operation: EMAIL_OPERATIONS.deliveryEventsEnsure },
    });
    expect(destination).toMatchObject({ type: 'create', metadata: { operation: EMAIL_OPERATIONS.forwardingDestinationEnsure } });
    expect(forward?.dependsOn).toEqual([
      'email:cloudflare:forwarding-dns',
      'email:cloudflare:destination:owner@example.net',
    ]);
    expect(catchAll?.dependsOn).toEqual([
      'email:cloudflare:forwarding-dns',
      'email:cloudflare:destination:owner@example.net',
    ]);
  });
});

describe('email provider scope resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-email-plan-scope-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));

    const connections = new ConnectionRepository();
    const sendgrid = connections.create({
      provider: 'sendgrid',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'SG.secret-runtime-value' }),
    });
    connections.updateStatus(sendgrid.id, 'verified');
    const cloudflare = connections.create({
      provider: 'cloudflare',
      scope: 'invoiceperfect.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    connections.updateStatus(cloudflare.id, 'verified');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('observes a staging email domain through its parent-zone Cloudflare connection', async () => {
    vi.spyOn(SendGridAdapter.prototype, 'listDomainAuthentications').mockResolvedValue([]);
    vi.spyOn(SendGridAdapter.prototype, 'listInboundParseWebhooks').mockResolvedValue([]);
    const findZone = vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'zone-1',
        name: 'invoiceperfect.com',
        status: 'active',
        paused: false,
        type: 'full',
        name_servers: [],
        account: { id: 'account-1' },
      });
    const listDnsRecords = vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([]);
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { api: { workloadKind: 'web', public: true } },
      domain: 'staging.invoiceperfect.com',
      email: {
        enabled: true,
        sender: { address: 'canary@staging.invoiceperfect.com' },
        inbound: {
          hostname: 'ci-mail.staging.invoiceperfect.com',
          service: 'api',
          aliases: [],
        },
      },
    });

    const result = await resolveEmailIntegrationState({ project, environmentSpec });

    expect(result.dnsRecords).toEqual({ status: 'known', items: [] });
    expect(result.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('No Cloudflare connection found'),
    ]));
    expect(findZone).toHaveBeenNthCalledWith(1, 'staging.invoiceperfect.com');
    expect(findZone).toHaveBeenNthCalledWith(2, 'invoiceperfect.com');
    expect(listDnsRecords).toHaveBeenCalledWith('zone-1');
  });
});
