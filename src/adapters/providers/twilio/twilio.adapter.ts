import { z } from 'zod';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

const TWILIO_MESSAGING_URL = 'https://messaging.twilio.com/v1';
const TWILIO_API_URL = 'https://api.twilio.com/2010-04-01';

const accountSidSchema = z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'Account SID must start with AC and contain 32 hexadecimal characters');
const apiKeySidSchema = z.string().regex(/^SK[0-9a-fA-F]{32}$/, 'API Key SID must start with SK and contain 32 hexadecimal characters');
const messagingServiceSidSchema = z.string().regex(/^MG[0-9a-fA-F]{32}$/);
const phoneNumberSidSchema = z.string().regex(/^PN[0-9a-fA-F]{32}$/);

const messagingServiceResponseSchema = z.object({
  sid: messagingServiceSidSchema,
  account_sid: accountSidSchema,
  friendly_name: z.string(),
  inbound_request_url: z.string().nullable(),
  inbound_method: z.enum(['GET', 'POST']),
  fallback_url: z.string().nullable(),
  fallback_method: z.enum(['GET', 'POST']),
  status_callback: z.string().nullable(),
  use_inbound_webhook_on_number: z.boolean(),
  date_created: z.string().optional(),
  date_updated: z.string().optional(),
}).passthrough();

const messagingPhoneResponseSchema = z.object({
  sid: phoneNumberSidSchema,
  account_sid: accountSidSchema,
  service_sid: messagingServiceSidSchema,
  phone_number: z.string(),
  country_code: z.string(),
  capabilities: z.array(z.string()),
}).passthrough();

export const TwilioCredentialsSchema = z.object({
  accountSid: accountSidSchema.describe('Account SID (AC...) from Console Dashboard -> Account Info; use the account or subaccount that owns the declared phone number'),
  apiKeySid: apiKeySidSchema.describe('Restricted API Key SID (SK...) from Settings -> Account settings -> API keys & auth tokens'),
  apiKeySecret: z.string().min(1, 'API Key Secret is required')
    .describe('API Key Secret displayed once when the Restricted API key is created; this is not the Account Auth Token'),
  authToken: z.string().min(1, 'Auth Token is required for webhook signature validation')
    .describe('Primary Account Auth Token from Console Dashboard -> Account Info; required to validate X-Twilio-Signature webhooks'),
}).strict();

export type TwilioCredentials = z.infer<typeof TwilioCredentialsSchema>;

export interface TwilioMessagingService {
  sid: string;
  account_sid: string;
  friendly_name: string;
  inbound_request_url: string | null;
  inbound_method: 'GET' | 'POST';
  fallback_url: string | null;
  fallback_method: 'GET' | 'POST';
  status_callback: string | null;
  use_inbound_webhook_on_number: boolean;
  date_created?: string;
  date_updated?: string;
}

export interface TwilioMessagingPhoneNumber {
  sid: string;
  account_sid: string;
  service_sid: string;
  phone_number: string;
  country_code: string;
  capabilities: string[];
}

export interface TwilioMessagingServiceInput {
  friendlyName: string;
  inboundRequestUrl?: string | null;
  statusCallback?: string | null;
}

export class TwilioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message);
    this.name = 'TwilioApiError';
  }
}

function formBody(values: Record<string, string | boolean | number | null | undefined>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  return form;
}

export class TwilioAdapter {
  readonly name = 'twilio';
  private credentials: TwilioCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = TwilioCredentialsSchema.parse(credentials);
  }

  getCredentials(): TwilioCredentials {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return this.credentials;
  }

  private async request<T>(
    baseUrl: string,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    values?: Record<string, string | boolean | number | null | undefined>,
    authentication: 'api-key' | 'auth-token' = 'api-key'
  ): Promise<T> {
    const credentials = this.getCredentials();
    const username = authentication === 'api-key' ? credentials.apiKeySid : credentials.accountSid;
    const password = authentication === 'api-key' ? credentials.apiKeySecret : credentials.authToken;
    const body = values ? formBody(values) : undefined;
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: body.toString() } : {}),
    });
    if (response.status === 204) return {} as T;
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const error = data && typeof data === 'object' && !Array.isArray(data)
        ? data as { message?: unknown; code?: unknown }
        : {};
      throw new TwilioApiError(
        `Twilio API error: ${typeof error.message === 'string' ? error.message : `${response.status} ${response.statusText}`}`,
        response.status,
        typeof error.code === 'number' ? error.code : undefined
      );
    }
    return data as T;
  }

  async verify(): Promise<{ success: boolean; error?: string; accountId?: string }> {
    try {
      const credentials = this.getCredentials();
      await this.listMessagingServices(1);
      await this.request(
        TWILIO_API_URL,
        'GET',
        `/Accounts/${credentials.accountSid}.json`,
        undefined,
        'auth-token'
      );
      return { success: true, accountId: credentials.accountSid };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listMessagingServices(limit = 1000): Promise<TwilioMessagingService[]> {
    const result = await this.request<unknown>(
      TWILIO_MESSAGING_URL,
      'GET',
      `/Services?PageSize=${Math.max(1, Math.min(limit, 1000))}`
    );
    return z.object({ services: z.array(messagingServiceResponseSchema) })
      .passthrough()
      .parse(result)
      .services;
  }

  async getMessagingService(serviceSid: string): Promise<TwilioMessagingService | null> {
    messagingServiceSidSchema.parse(serviceSid);
    try {
      const result = await this.request<unknown>(TWILIO_MESSAGING_URL, 'GET', `/Services/${serviceSid}`);
      return messagingServiceResponseSchema.parse(result);
    } catch (error) {
      if (error instanceof TwilioApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createMessagingService(input: TwilioMessagingServiceInput): Promise<TwilioMessagingService> {
    const result = await this.request<unknown>(TWILIO_MESSAGING_URL, 'POST', '/Services', {
      FriendlyName: input.friendlyName,
      InboundRequestUrl: input.inboundRequestUrl ?? '',
      InboundMethod: 'POST',
      StatusCallback: input.statusCallback ?? '',
      UseInboundWebhookOnNumber: false,
    });
    return messagingServiceResponseSchema.parse(result);
  }

  async updateMessagingService(serviceSid: string, input: TwilioMessagingServiceInput): Promise<TwilioMessagingService> {
    messagingServiceSidSchema.parse(serviceSid);
    const result = await this.request<unknown>(TWILIO_MESSAGING_URL, 'POST', `/Services/${serviceSid}`, {
      FriendlyName: input.friendlyName,
      InboundRequestUrl: input.inboundRequestUrl ?? '',
      InboundMethod: 'POST',
      StatusCallback: input.statusCallback ?? '',
      UseInboundWebhookOnNumber: false,
    });
    return messagingServiceResponseSchema.parse(result);
  }

  async listMessagingPhoneNumbers(serviceSid: string): Promise<TwilioMessagingPhoneNumber[]> {
    messagingServiceSidSchema.parse(serviceSid);
    const result = await this.request<unknown>(
      TWILIO_MESSAGING_URL,
      'GET',
      `/Services/${serviceSid}/PhoneNumbers?PageSize=1000`
    );
    return z.object({ phone_numbers: z.array(messagingPhoneResponseSchema) })
      .passthrough()
      .parse(result)
      .phone_numbers;
  }

  async attachMessagingPhoneNumber(serviceSid: string, phoneNumberSid: string): Promise<TwilioMessagingPhoneNumber> {
    messagingServiceSidSchema.parse(serviceSid);
    phoneNumberSidSchema.parse(phoneNumberSid);
    const result = await this.request<unknown>(TWILIO_MESSAGING_URL, 'POST', `/Services/${serviceSid}/PhoneNumbers`, {
      PhoneNumberSid: phoneNumberSid,
    });
    return messagingPhoneResponseSchema.parse(result);
  }

  async detachMessagingPhoneNumber(serviceSid: string, phoneNumberSid: string): Promise<void> {
    messagingServiceSidSchema.parse(serviceSid);
    phoneNumberSidSchema.parse(phoneNumberSid);
    await this.request(TWILIO_MESSAGING_URL, 'DELETE', `/Services/${serviceSid}/PhoneNumbers/${phoneNumberSid}`);
  }
}

async function inspectTwilio(
  adapter: TwilioAdapter,
  request: ProviderInspectionRequest
): Promise<Record<string, unknown>> {
  if (request.resource !== 'messaging-service') {
    throw new Error(`Unsupported Twilio inspection resource "${request.resource ?? ''}".`);
  }
  if (request.id) {
    const service = await adapter.getMessagingService(request.id);
    const services = service ? [{ id: service.sid, name: service.friendly_name, ...service }] : [];
    return {
      observation: service ? 'present' : 'absent',
      resource: request.resource,
      services,
      ...(service ? { service } : { id: request.id }),
      truncated: false,
      partial: false,
    };
  }
  const fetchLimit = request.name ? 1000 : Math.min(1000, request.limit + 1);
  const listed = await adapter.listMessagingServices(fetchLimit);
  const matches = listed
    .filter((service) => !request.name || service.friendly_name === request.name)
    .map((service) => ({ id: service.sid, name: service.friendly_name, ...service }));
  const incompleteExactSearch = Boolean(request.name && listed.length >= fetchLimit && matches.length === 0);
  const ambiguous = Boolean(request.name && matches.length > 1);
  const truncated = matches.length > request.limit;
  return {
    observation: incompleteExactSearch
      ? 'unknown'
      : ambiguous
        ? 'ambiguous'
        : matches.length > 0
          ? 'present'
          : 'absent',
    resource: request.resource,
    services: matches.slice(0, request.limit),
    ...(matches.length === 0 && request.name ? { name: request.name } : {}),
    truncated,
    partial: incompleteExactSearch || truncated,
  };
}

providerRegistry.register({
  metadata: {
    name: 'twilio',
    displayName: 'Twilio',
    category: 'messaging',
    credentialsSchema: TwilioCredentialsSchema,
    setupHelpUrl: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
  },
  factory: (credentials) => {
    const adapter = new TwilioAdapter();
    adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['messaging-service'],
    defaultResource: 'messaging-service',
    selectors: {
      'messaging-service': { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, collectionKey: 'services' },
    },
    inspect: (adapter, request) => inspectTwilio(adapter as TwilioAdapter, request),
  },
});
