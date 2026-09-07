import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3';

export interface SendGridDomainAuthentication {
  id: number;
  domain: string;
  subdomain: string;
  username: string;
  valid: boolean;
  default: boolean;
  legacy: boolean;
  dns: SendGridDnsRecords;
}

export interface SendGridDnsRecords {
  mail_cname?: SendGridDnsRecord;
  dkim1?: SendGridDnsRecord;
  dkim2?: SendGridDnsRecord;
  mail_server?: SendGridDnsRecord;
  subdomain_spf?: SendGridDnsRecord;
}

export interface SendGridDnsRecord {
  host: string;
  type: string;
  data: string;
  valid: boolean;
}

export interface SendGridValidationResult {
  id: number;
  valid: boolean;
  validation_results: {
    mail_cname?: { valid: boolean; reason?: string };
    dkim1?: { valid: boolean; reason?: string };
    dkim2?: { valid: boolean; reason?: string };
  };
}

export interface SendGridEventWebhookSettings {
  enabled: boolean;
  url: string;
  group_resubscribe: boolean;
  delivered: boolean;
  group_unsubscribe: boolean;
  spam_report: boolean;
  bounce: boolean;
  deferred: boolean;
  unsubscribe: boolean;
  processed: boolean;
  open: boolean;
  click: boolean;
  dropped: boolean;
}

export const SENDGRID_SCOPE_REQUIREMENTS = {
  mailSend: ['mail.send'],
  domainAuthentication: ['whitelabel.read', 'whitelabel.create', 'whitelabel.update'],
  senderVerification: ['user.email.read', 'user.email.create', 'user.email.update'],
  eventWebhook: ['user.webhooks.event.settings.read', 'user.webhooks.event.settings.update'],
  inboundParse: [
    'user.webhooks.parse.settings.read',
    'user.webhooks.parse.settings.create',
    'user.webhooks.parse.settings.delete',
  ],
} as const;

export type SendGridScopeCapability = keyof typeof SENDGRID_SCOPE_REQUIREMENTS;

export interface SendGridPermissionAudit {
  scopes: string[];
  hasMailSend: boolean;
  canManageDomainAuthentication: boolean;
  canManageSenderVerification: boolean;
  canConfigureEventWebhook: boolean;
  canConfigureInboundParse: boolean;
  setupReady: boolean;
  missingScopes: Record<SendGridScopeCapability, string[]>;
  requiredAuthorizationPaths: Array<'domainAuthentication' | 'senderVerification'>;
  recommendation: string;
}

export interface SendGridVerifiedSender {
  id?: number | string;
  nickname?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
  reply_to_name?: string;
  verified?: boolean;
  locked?: boolean;
}

export interface CreateSendGridVerifiedSenderInput {
  nickname: string;
  fromEmail: string;
  replyTo: string;
  fromName?: string;
  replyToName?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

// Credentials schema for self-registration
export const SendGridCredentialsSchema = z.object({
  apiKey: z.string().min(1, 'API key is required').refine(
    (key) => key.startsWith('SG.'),
    'SendGrid API key must start with SG.'
  ),
});

export type SendGridCredentials = z.infer<typeof SendGridCredentialsSchema>;

export class SendGridApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'SendGridApiError';
  }
}

function hasSendGridScope(scopeSet: Set<string>, requiredScope: string): boolean {
  if (scopeSet.has(requiredScope) || scopeSet.has('*')) return true;

  const segments = requiredScope.split('.');
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    if (scopeSet.has(`${segments.slice(0, i).join('.')}.*`)) return true;
  }

  return false;
}

function missingSendGridScopes(scopes: string[], requiredScopes: readonly string[]): string[] {
  const scopeSet = new Set(scopes);
  return requiredScopes.filter((scope) => !hasSendGridScope(scopeSet, scope));
}

export function assessSendGridScopes(scopes: string[]): SendGridPermissionAudit {
  const missingScopes = {
    mailSend: missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.mailSend),
    domainAuthentication: missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.domainAuthentication),
    senderVerification: missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.senderVerification),
    eventWebhook: missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.eventWebhook),
    inboundParse: missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.inboundParse),
  };

  const hasMailSend = missingScopes.mailSend.length === 0;
  const canManageDomainAuthentication = missingScopes.domainAuthentication.length === 0;
  const canManageSenderVerification = missingScopes.senderVerification.length === 0;
  const canConfigureEventWebhook = missingScopes.eventWebhook.length === 0;
  const canConfigureInboundParse = missingScopes.inboundParse.length === 0;
  const setupReady = hasMailSend && (canManageDomainAuthentication || canManageSenderVerification);

  return {
    scopes,
    hasMailSend,
    canManageDomainAuthentication,
    canManageSenderVerification,
    canConfigureEventWebhook,
    canConfigureInboundParse,
    setupReady,
    missingScopes,
    requiredAuthorizationPaths: ['domainAuthentication', 'senderVerification'],
    recommendation: setupReady
      ? 'The SendGrid API key can send mail and authorize sender identities through at least one supported setup path.'
      : 'Create a SendGrid API key with Mail Send plus either Domain Authentication permissions (whitelabel.read, whitelabel.create, whitelabel.update) or Sender Identity permissions (user.email.read, user.email.create, user.email.update). Full Access is acceptable for setup, then rotate to a narrower runtime key after sender/domain authorization is complete.',
  };
}

function missingSetupScopeSummary(permissions: SendGridPermissionAudit): string {
  const missing: Array<[string, string[]]> = [];
  if (!permissions.hasMailSend) {
    missing.push(['mailSend', permissions.missingScopes.mailSend]);
  }
  if (!permissions.canManageDomainAuthentication && !permissions.canManageSenderVerification) {
    missing.push(['domainAuthentication', permissions.missingScopes.domainAuthentication]);
    missing.push(['senderVerification', permissions.missingScopes.senderVerification]);
  }

  return missing
    .filter(([, scopes]) => scopes.length > 0)
    .map(([group, scopes]) => `${group}: ${scopes.join(', ')}`)
    .join('; ');
}

export class SendGridAdapter {
  readonly name = 'sendgrid';
  private credentials: SendGridCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as SendGridCredentials;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.apiKey}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${SENDGRID_API_URL}${endpoint}`, options);

    // Handle accepted and no-content responses.
    if (response.status === 202 || response.status === 204) {
      return {} as T;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new SendGridApiError(
          `SendGrid API error: HTTP ${response.status}`,
          response.status
        );
      }
      throw new Error(`SendGrid API returned invalid JSON for ${method} ${endpoint}.`);
    }

    if (!response.ok) {
      const errorMsg = (data as { errors?: Array<{ message: string }> }).errors
        ?.map((e) => e.message)
        .join(', ') || `HTTP ${response.status}`;
      throw new SendGridApiError(
        `SendGrid API error: ${errorMsg}`,
        response.status
      );
    }

    return data as T;
  }

  async getScopes(): Promise<string[]> {
    const result = await this.request<{ scopes: string[] }>('GET', '/scopes');
    return Array.isArray(result.scopes) ? result.scopes : [];
  }

  async verify(): Promise<{
    success: boolean;
    error?: string;
    warning?: string;
    scopes?: string[];
    permissions?: SendGridPermissionAudit;
  }> {
    try {
      const scopes = await this.getScopes();
      const permissions = assessSendGridScopes(scopes);
      if (!permissions.setupReady) {
        return {
          success: false,
          error: `SendGrid API key is valid but is missing setup permissions: ${missingSetupScopeSummary(permissions)}. ${permissions.recommendation}`,
          scopes,
          permissions,
        };
      }

      return {
        success: true,
        scopes,
        permissions,
        ...((!permissions.canConfigureEventWebhook || !permissions.canConfigureInboundParse) && {
          warning: [
            ...(!permissions.canConfigureEventWebhook
              ? [`SendGrid API key cannot configure delivery-event webhooks. Add ${SENDGRID_SCOPE_REQUIREMENTS.eventWebhook.join(', ')} for that capability.`]
              : []),
            ...(!permissions.canConfigureInboundParse
              ? [`SendGrid API key cannot configure Inbound Parse. Add ${SENDGRID_SCOPE_REQUIREMENTS.inboundParse.join(', ')} when environment.email.inbound is declared.`]
              : []),
          ].join(' '),
        }),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listDomainAuthentications(): Promise<SendGridDomainAuthentication[]> {
    const result = await this.request<SendGridDomainAuthentication[]>(
      'GET',
      '/whitelabel/domains'
    );
    if (!Array.isArray(result)) {
      throw new Error('SendGrid domain-authentication observation returned an invalid list.');
    }
    return result;
  }

  async getDomainAuthentication(domainId: number): Promise<SendGridDomainAuthentication | null> {
    try {
      const result = await this.request<SendGridDomainAuthentication>(
        'GET',
        `/whitelabel/domains/${domainId}`
      );
      return result;
    } catch (error) {
      if (error instanceof SendGridApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async validateDomainAuthentication(domainId: number): Promise<SendGridValidationResult> {
    const result = await this.request<SendGridValidationResult>(
      'POST',
      `/whitelabel/domains/${domainId}/validate`
    );
    return result;
  }

  async createDomainAuthentication(
    domain: string,
    options?: { subdomain?: string; default?: boolean }
  ): Promise<SendGridDomainAuthentication> {
    const body: Record<string, unknown> = {
      domain,
      default: options?.default ?? false,
    };

    if (options?.subdomain) {
      body.subdomain = options.subdomain;
    }

    const result = await this.request<SendGridDomainAuthentication>(
      'POST',
      '/whitelabel/domains',
      body
    );
    return result;
  }

  async listVerifiedSenders(): Promise<SendGridVerifiedSender[]> {
    const result = await this.request<{ results?: SendGridVerifiedSender[] }>(
      'GET',
      '/verified_senders'
    );
    if (!Array.isArray(result.results)) {
      throw new Error('SendGrid verified-sender observation returned an invalid list.');
    }
    return result.results;
  }

  async createVerifiedSender(input: CreateSendGridVerifiedSenderInput): Promise<SendGridVerifiedSender> {
    const body: Record<string, unknown> = {
      nickname: input.nickname,
      from_email: input.fromEmail,
      reply_to: input.replyTo,
    };

    if (input.fromName) body.from_name = input.fromName;
    if (input.replyToName) body.reply_to_name = input.replyToName;
    if (input.address) body.address = input.address;
    if (input.address2) body.address2 = input.address2;
    if (input.city) body.city = input.city;
    if (input.state) body.state = input.state;
    if (input.zip) body.zip = input.zip;
    if (input.country) body.country = input.country;

    return this.request<SendGridVerifiedSender>('POST', '/verified_senders', body);
  }

  // Event Webhook Management

  async getEventWebhookSettings(): Promise<SendGridEventWebhookSettings> {
    return this.request<SendGridEventWebhookSettings>('GET', '/user/webhooks/event/settings');
  }

  async updateEventWebhookSettings(
    settings: Partial<SendGridEventWebhookSettings>
  ): Promise<SendGridEventWebhookSettings> {
    return this.request<SendGridEventWebhookSettings>(
      'PATCH',
      '/user/webhooks/event/settings',
      settings as Record<string, unknown>
    );
  }

  // Inbound Parse Webhook (for receiving emails)

  async listInboundParseWebhooks(): Promise<Array<{ hostname: string; url: string; spam_check: boolean; send_raw: boolean }>> {
    const result = await this.request<{ result: Array<{ hostname: string; url: string; spam_check: boolean; send_raw: boolean }> }>(
      'GET',
      '/user/webhooks/parse/settings'
    );
    if (!Array.isArray(result.result)) {
      throw new Error('SendGrid Inbound Parse observation returned an invalid list.');
    }
    return result.result;
  }

  async createInboundParseWebhook(
    hostname: string,
    url: string,
    options?: { spam_check?: boolean; send_raw?: boolean }
  ): Promise<{ hostname: string; url: string; spam_check: boolean; send_raw: boolean }> {
    return this.request(
      'POST',
      '/user/webhooks/parse/settings',
      {
        hostname,
        url,
        spam_check: options?.spam_check ?? true,
        send_raw: options?.send_raw ?? false,
      }
    );
  }

  async deleteInboundParseWebhook(hostname: string): Promise<void> {
    await this.request('DELETE', `/user/webhooks/parse/settings/${hostname}`);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'sendgrid',
    displayName: 'SendGrid',
    category: 'email',
    credentialsSchema: SendGridCredentialsSchema,
    setupHelpUrl: 'https://app.sendgrid.com/settings/api_keys',
    credentials: {
      defaultScalarKey: 'apiKey',
    },
  },
  factory: (credentials) => {
    const adapter = new SendGridAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
