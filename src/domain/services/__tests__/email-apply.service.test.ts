import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { SendGridAdapter } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { CloudflareAdapter } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyEmailAction } from '../email-apply.service.js';
import {
  EMAIL_OPERATIONS,
  emailDeliveryEventsConfigHash,
  emailDnsConfigHash,
  emailInboundConfigHash,
  emailRuntimeConfigHash,
} from '../email-plan.service.js';

const fullScopes = [
  'mail.send',
  'whitelabel.read',
  'whitelabel.create',
  'whitelabel.update',
  'user.email.read',
  'user.email.create',
  'user.email.update',
  'user.webhooks.parse.settings.read',
  'user.webhooks.parse.settings.create',
  'user.webhooks.parse.settings.delete',
  'user.webhooks.event.settings.read',
  'user.webhooks.event.settings.update',
];

function emailSpec() {
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

describe('declarative email apply', () => {
  let tempDir: string;
  let project: ReturnType<ProjectRepository['create']>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-email-apply-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'email-app', defaultPlatform: 'railway' });
    new ServiceRepository().create({ projectId: project.id, name: 'api' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-environment',
        services: { api: { serviceId: 'rail-service', url: 'https://api.example.com' } },
      },
    });
    const connection = new ConnectionRepository().create({
      provider: 'sendgrid',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'SG.secret-runtime-value' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    vi.spyOn(SendGridAdapter.prototype, 'getScopes').mockResolvedValue(fullScopes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('syncs sender defaults and inbound aliases only through the reviewed runtime action', async () => {
    const setEnvVars = vi.fn().mockResolvedValue({
      success: true,
      message: 'synced',
      data: {
        runtimeRolloutRequired: true,
        rolloutBaseline: { state: 'present', deploymentId: 'deployment-before-email-sync' },
      },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsDeferredDeploy: true },
        setEnvVars,
      } as never,
    });
    const spec = emailSpec();
    const action: PlanAction = {
      id: 'email:runtime',
      type: 'update',
      resource: { kind: 'email', name: 'production', provider: 'railway' },
      verified: false,
      reason: 'sync',
      metadata: {
        operation: EMAIL_OPERATIONS.runtimeSync,
        services: ['api'],
        configHash: emailRuntimeConfigHash(spec),
        credentialHash: createHash('sha256').update('SG.secret-runtime-value', 'utf8').digest('hex'),
      },
    };

    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action,
    });

    expect(result.success).toBe(true);
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'api' }),
      {
        SENDGRID_API_KEY: 'SG.secret-runtime-value',
        SENDGRID_FROM_EMAIL: 'hello@example.com',
        SENDGRID_FROM_NAME: 'Example',
        SENDGRID_REPLY_TO: 'support@example.com',
        SENDGRID_INBOUND_HOSTNAME: 'inbound.example.com',
        SENDGRID_INBOUND_ALIASES: '["replies","support"]',
      }
    );
    expect(JSON.stringify(result)).not.toContain('SG.secret-runtime-value');
    expect(result.data).toMatchObject({
      runtimeRolloutRequired: true,
      rolloutBaselines: {
        api: { state: 'present', deploymentId: 'deployment-before-email-sync' },
      },
    });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.email).toMatchObject({
      runtime: {
        configHash: emailRuntimeConfigHash(spec),
        services: ['api'],
      },
    });
  });

  it('projects the CI inbox with empty aliases without leaking the SendGrid credential', async () => {
    const setEnvVars = vi.fn().mockResolvedValue({ success: true, message: 'synced' });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsDeferredDeploy: true },
        setEnvVars,
      } as never,
    });
    const spec = ciInboxSpec();
    const action: PlanAction = {
      id: 'email:runtime',
      type: 'update',
      resource: { kind: 'email', name: 'production', provider: 'railway' },
      verified: false,
      reason: 'sync',
      metadata: {
        operation: EMAIL_OPERATIONS.runtimeSync,
        services: ['api'],
        configHash: emailRuntimeConfigHash(spec),
        credentialHash: createHash('sha256').update('SG.secret-runtime-value', 'utf8').digest('hex'),
      },
    };

    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action,
    });

    expect(result.success).toBe(true);
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'api' }),
      {
        SENDGRID_API_KEY: 'SG.secret-runtime-value',
        SENDGRID_FROM_EMAIL: 'canary@staging.example.com',
        SENDGRID_FROM_NAME: 'Example Canary',
        SENDGRID_INBOUND_HOSTNAME: 'ci-mail.staging.example.com',
        SENDGRID_INBOUND_ALIASES: '[]',
      }
    );
    expect(JSON.stringify(result)).not.toContain('SG.secret-runtime-value');
    expect(result.data).toMatchObject({
      services: ['api'],
      keys: [
        'SENDGRID_API_KEY',
        'SENDGRID_FROM_EMAIL',
        'SENDGRID_FROM_NAME',
        'SENDGRID_INBOUND_ALIASES',
        'SENDGRID_INBOUND_HOSTNAME',
      ],
    });
  });

  it('creates the dedicated CI inbound route without provider-managed local parts', async () => {
    const route = {
      hostname: 'ci-mail.staging.example.com',
      url: 'https://api.example.com/api/webhooks/canary-email-receipts',
      spam_check: true,
      send_raw: false,
    };
    vi.spyOn(SendGridAdapter.prototype, 'listInboundParseWebhooks')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([route]);
    const create = vi.spyOn(SendGridAdapter.prototype, 'createInboundParseWebhook')
      .mockResolvedValue(route);
    const spec = ciInboxSpec();
    const action: PlanAction = {
      id: 'email:sendgrid:inbound:ci-mail.staging.example.com',
      type: 'create',
      resource: { kind: 'email', name: 'ci-mail.staging.example.com', provider: 'sendgrid' },
      verified: false,
      reason: 'create',
      metadata: {
        operation: EMAIL_OPERATIONS.inboundEnsure,
        hostname: 'ci-mail.staging.example.com',
        service: 'api',
        path: '/api/webhooks/canary-email-receipts',
        aliases: [],
        spamCheck: true,
        sendRaw: false,
        configHash: emailInboundConfigHash(spec),
        expectedUrl: 'https://api.example.com/api/webhooks/canary-email-receipts',
      },
    };

    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        hostname: 'ci-mail.staging.example.com',
        service: 'api',
        path: '/api/webhooks/canary-email-receipts',
        aliases: [],
      },
    });
    expect(create).toHaveBeenCalledWith(
      'ci-mail.staging.example.com',
      'https://api.example.com/api/webhooks/canary-email-receipts',
      { spam_check: true, send_raw: false }
    );
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.email).toMatchObject({
      inbound: {
        hostname: 'ci-mail.staging.example.com',
        aliases: [],
      },
    });
  });

  it('applies staging email DNS through a Cloudflare connection scoped to the parent zone', async () => {
    const connections = new ConnectionRepository();
    const cloudflare = connections.create({
      provider: 'cloudflare',
      scope: 'invoiceperfect.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    connections.updateStatus(cloudflare.id, 'verified');
    const spec = environmentSpecSchema.parse({
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
    vi.spyOn(SendGridAdapter.prototype, 'listDomainAuthentications').mockResolvedValue([{
      id: 42,
      domain: 'staging.invoiceperfect.com',
      subdomain: 'em',
      username: 'user',
      valid: true,
      default: false,
      legacy: false,
      dns: {
        dkim1: {
          host: 's1._domainkey.staging.invoiceperfect.com',
          type: 'CNAME',
          data: 's1.sendgrid.net',
          valid: true,
        },
        dkim2: {
          host: 's2._domainkey.staging.invoiceperfect.com',
          type: 'CNAME',
          data: 's2.sendgrid.net',
          valid: true,
        },
        mail_cname: {
          host: 'em.staging.invoiceperfect.com',
          type: 'CNAME',
          data: 'u.sendgrid.net',
          valid: true,
        },
      },
    }]);
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
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([]);
    const upsertDnsRecord = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord')
      .mockImplementation(async (zoneId, name, type, content, options) => ({
        action: 'created',
        record: {
          id: `dns-${name}`,
          zone_id: zoneId,
          zone_name: 'invoiceperfect.com',
          name,
          type,
          content,
          proxiable: type === 'CNAME',
          proxied: false,
          ttl: 1,
          created_on: '',
          modified_on: '',
          ...(options?.priority !== undefined ? { priority: options.priority } : {}),
        },
      }));

    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action: {
        id: 'email:cloudflare:dns',
        type: 'update',
        resource: { kind: 'domain', name: 'staging.invoiceperfect.com', provider: 'cloudflare' },
        verified: false,
        reason: 'sync',
        metadata: {
          operation: EMAIL_OPERATIONS.dnsSync,
          domain: 'staging.invoiceperfect.com',
          inboundHostname: 'ci-mail.staging.invoiceperfect.com',
          configHash: emailDnsConfigHash(spec),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(findZone).toHaveBeenNthCalledWith(1, 'staging.invoiceperfect.com');
    expect(findZone).toHaveBeenNthCalledWith(2, 'invoiceperfect.com');
    expect(upsertDnsRecord).toHaveBeenCalledTimes(4);
    expect(upsertDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'ci-mail.staging.invoiceperfect.com',
      'MX',
      'mx.sendgrid.net',
      { proxied: false, priority: 10 }
    );
  });

  it('creates and verifies the exact service-targeted inbound parse route', async () => {
    const route = {
      hostname: 'inbound.example.com',
      url: 'https://api.example.com/webhooks/sendgrid/inbound',
      spam_check: true,
      send_raw: false,
    };
    vi.spyOn(SendGridAdapter.prototype, 'listInboundParseWebhooks')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([route]);
    const create = vi.spyOn(SendGridAdapter.prototype, 'createInboundParseWebhook')
      .mockResolvedValue(route);
    const spec = emailSpec();
    const action: PlanAction = {
      id: 'email:sendgrid:inbound:inbound.example.com',
      type: 'create',
      resource: { kind: 'email', name: 'inbound.example.com', provider: 'sendgrid' },
      verified: false,
      reason: 'create',
      metadata: {
        operation: EMAIL_OPERATIONS.inboundEnsure,
        hostname: 'inbound.example.com',
        service: 'api',
        path: '/webhooks/sendgrid/inbound',
        aliases: ['replies', 'support'],
        spamCheck: true,
        sendRaw: false,
        configHash: emailInboundConfigHash(spec),
        expectedUrl: 'https://api.example.com/webhooks/sendgrid/inbound',
      },
    };

    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action,
    });

    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledWith(
      'inbound.example.com',
      'https://api.example.com/webhooks/sendgrid/inbound',
      { spam_check: true, send_raw: false }
    );
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.email).toMatchObject({
      inbound: {
        hostname: 'inbound.example.com',
        service: 'api',
        aliases: ['replies', 'support'],
      },
    });
  });

  it('refuses an inbound action whose reviewed service path changed', async () => {
    const spec = emailSpec();
    const listInbound = vi.spyOn(SendGridAdapter.prototype, 'listInboundParseWebhooks');
    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action: {
        id: 'email:sendgrid:inbound:inbound.example.com',
        type: 'create',
        resource: { kind: 'email', name: 'inbound.example.com', provider: 'sendgrid' },
        verified: false,
        reason: 'create',
        metadata: {
          operation: EMAIL_OPERATIONS.inboundEnsure,
          hostname: 'inbound.example.com',
          service: 'api',
          path: '/different',
          aliases: ['replies', 'support'],
          spamCheck: true,
          sendRaw: false,
          configHash: emailInboundConfigHash(spec),
        },
      },
    });

    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(listInbound).not.toHaveBeenCalled();
  });

  it('syncs the account-level delivery webhook only through its reviewed action', async () => {
    const spec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { api: { workloadKind: 'web', public: true } },
      domain: 'example.com',
      email: {
        enabled: true,
        deliveryEvents: { service: 'api', events: ['bounce', 'delivered'] },
      },
    });
    const disabled = {
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
    };
    const enabled = { ...disabled, enabled: true, url: 'https://api.example.com/webhooks/sendgrid/events', bounce: true, delivered: true };
    vi.spyOn(SendGridAdapter.prototype, 'getEventWebhookSettings')
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(enabled);
    const update = vi.spyOn(SendGridAdapter.prototype, 'updateEventWebhookSettings').mockResolvedValue(enabled);
    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action: {
        id: 'email:sendgrid:delivery-events',
        type: 'update',
        resource: { kind: 'email', name: 'delivery-events', provider: 'sendgrid' },
        verified: false,
        reason: 'sync',
        metadata: {
          operation: EMAIL_OPERATIONS.deliveryEventsEnsure,
          service: 'api',
          path: '/webhooks/sendgrid/events',
          events: ['bounce', 'delivered'],
          configHash: emailDeliveryEventsConfigHash(spec),
          expectedUrl: 'https://api.example.com/webhooks/sendgrid/events',
        },
      },
    });
    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      url: 'https://api.example.com/webhooks/sendgrid/events',
      bounce: true,
      delivered: true,
      click: false,
    }));
  });

  it('creates a forwarding destination through a parent-zone Cloudflare connection and stops pending verification', async () => {
    const connection = new ConnectionRepository().create({
      provider: 'cloudflare',
      scope: 'invoiceperfect.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
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
    vi.spyOn(CloudflareAdapter.prototype, 'listEmailRoutingAddresses').mockResolvedValue([]);
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createEmailRoutingAddress').mockResolvedValue({
      id: 'destination-1',
      email: 'owner@example.net',
      verified: null,
    });
    const spec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { api: { workloadKind: 'web', public: true } },
      domain: 'staging.invoiceperfect.com',
      email: {
        enabled: true,
        forwarding: { aliases: { support: 'owner@example.net' } },
      },
    });
    const result = await applyEmailAction({
      project,
      environmentName: 'production',
      environmentSpec: spec,
      action: {
        id: 'email:cloudflare:destination:owner@example.net',
        type: 'create',
        resource: { kind: 'email', name: 'owner@example.net', provider: 'cloudflare' },
        verified: false,
        reason: 'create',
        metadata: {
          operation: EMAIL_OPERATIONS.forwardingDestinationEnsure,
          domain: 'staging.invoiceperfect.com',
          destination: 'owner@example.net',
        },
      },
    });
    expect(result).toMatchObject({ success: false, status: 'pending' });
    expect(findZone).toHaveBeenNthCalledWith(1, 'staging.invoiceperfect.com');
    expect(findZone).toHaveBeenNthCalledWith(2, 'invoiceperfect.com');
    expect(create).toHaveBeenCalledWith('account-1', 'owner@example.net');
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(environment.platformBindings.email).toMatchObject({
      forwarding: {
        destinations: {
          'owner@example.net': { externalId: 'destination-1', verified: false },
        },
      },
    });
  });
});
