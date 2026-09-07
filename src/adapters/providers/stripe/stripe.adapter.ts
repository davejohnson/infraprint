import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const STRIPE_API_URL = 'https://api.stripe.com/v1';
const STRIPE_REQUEST_TIMEOUT_MS = 20_000;

export type StripeMode = 'sandbox' | 'live';

/** Stripe secret and restricted server keys encode their target mode. */
export function stripeApiKeyMode(key: string): StripeMode | null {
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'sandbox';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return null;
}

export interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  tax_code?: string | null;
  active: boolean;
  metadata: Record<string, string>;
  default_price?: string | null;
  created: number;
  updated: number;
}

export interface StripePrice {
  id: string;
  product: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: {
    interval: 'day' | 'week' | 'month' | 'year';
    interval_count: number;
  } | null;
  type: 'one_time' | 'recurring';
  metadata: Record<string, string>;
  nickname: string | null;
  lookup_key?: string | null;
  created: number;
}

export interface StripeWebhookEndpoint {
  id: string;
  url: string;
  status: 'enabled' | 'disabled';
  enabled_events: string[];
  secret?: string; // Only returned on creation
  created: number;
  description?: string;
  metadata: Record<string, string>;
}

const stripeProductResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  tax_code: z.string().nullable().optional(),
  active: z.boolean(),
  metadata: z.record(z.string()),
  default_price: z.string().nullable().optional(),
  created: z.number(),
  updated: z.number(),
}).passthrough();

const stripePriceResponseSchema = z.object({
  id: z.string().min(1),
  product: z.string().min(1),
  active: z.boolean(),
  currency: z.string().min(1),
  unit_amount: z.number().nullable(),
  recurring: z.object({
    interval: z.enum(['day', 'week', 'month', 'year']),
    interval_count: z.number().int().positive(),
  }).passthrough().nullable(),
  type: z.enum(['one_time', 'recurring']),
  metadata: z.record(z.string()),
  nickname: z.string().nullable(),
  lookup_key: z.string().nullable().optional(),
  created: z.number(),
}).passthrough();

const stripeProductListResponseSchema = z.object({
  data: z.array(stripeProductResponseSchema),
  has_more: z.boolean(),
}).passthrough();

const stripePriceListResponseSchema = z.object({
  data: z.array(stripePriceResponseSchema),
  has_more: z.boolean(),
}).passthrough();

export type StripeApiErrorKind = 'http' | 'timeout' | 'network' | 'malformed_response';

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: StripeApiErrorKind = 'http'
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

// Credentials schema for self-registration
export const StripeCredentialsSchema = z.object({
  /**
   * Preferred shape for an environment-scoped Stripe connection
   * (hv_connections provider="stripe" scope="staging" ...).
   */
  secretKey: z.string().optional().refine(
    (key) => !key || stripeApiKeyMode(key) !== null,
    'Stripe server API key must start with sk_test_, sk_live_, rk_test_, or rk_live_'
  ).describe('Server-side key for exactly one Stripe sandbox or live account. Restricted rk_test_/rk_live_ keys are preferred; sk_test_/sk_live_ keys also work.'),
  publishableKey: z.string().optional().refine(
    (key) => !key || key.startsWith('pk_test_') || key.startsWith('pk_live_'),
    'Publishable key must start with pk_test_ or pk_live_'
  ).describe('Optional publishable key from the same Stripe sandbox or live account as secretKey.'),
  /** Legacy global connection fields retained for compatibility. */
  sandboxSecretKey: z.string().optional().refine(
    (key) => !key || stripeApiKeyMode(key) === 'sandbox',
    'Sandbox server API key must start with sk_test_ or rk_test_'
  ),
  sandboxPublishableKey: z.string().optional().refine(
    (key) => !key || key.startsWith('pk_test_'),
    'Sandbox publishable key must start with pk_test_'
  ),
  liveSecretKey: z.string().optional().refine(
    (key) => !key || stripeApiKeyMode(key) === 'live',
    'Live server API key must start with sk_live_ or rk_live_'
  ),
  livePublishableKey: z.string().optional().refine(
    (key) => !key || key.startsWith('pk_live_'),
    'Live publishable key must start with pk_live_'
  ),
}).superRefine((data, ctx) => {
  if (!data.secretKey && !data.sandboxSecretKey && !data.liveSecretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'secretKey, sandboxSecretKey, or liveSecretKey is required',
    });
  }
  if (data.publishableKey && data.secretKey) {
    const secretIsLive = stripeApiKeyMode(data.secretKey) === 'live';
    const publishableIsLive = data.publishableKey.startsWith('pk_live_');
    if (secretIsLive !== publishableIsLive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'secretKey and publishableKey must belong to the same Stripe mode',
        path: ['publishableKey'],
      });
    }
  }
  const hasScopedShape = Boolean(data.secretKey || data.publishableKey);
  const hasLegacyShape = Boolean(
    data.sandboxSecretKey
    || data.sandboxPublishableKey
    || data.liveSecretKey
    || data.livePublishableKey
  );
  if (hasScopedShape && hasLegacyShape) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Do not mix environment-scoped secretKey/publishableKey with legacy global sandbox/live fields',
    });
  }
  if (data.publishableKey && !data.secretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'publishableKey requires the matching environment-scoped secretKey',
      path: ['publishableKey'],
    });
  }
});

export type StripeCredentials = z.infer<typeof StripeCredentialsSchema>;

export class StripeAdapter {
  readonly name = 'stripe';
  private credentials: StripeCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as StripeCredentials;
  }

  private getApiKey(mode: StripeMode): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const key = this.credentials.secretKey
      ?? (mode === 'sandbox' ? this.credentials.sandboxSecretKey : this.credentials.liveSecretKey);
    if (!key) {
      throw new Error(`No ${mode} Stripe secret key configured. Use an environment-scoped secretKey, or a legacy global sandboxSecretKey/liveSecretKey.`);
    }
    return key;
  }

  /**
   * Runtime key material for the selected Stripe mode. Callers must keep these
   * values inside provider mutation boundaries and never include them in
   * plans, logs, warnings, bindings, or receipts.
   */
  getRuntimeCredentials(mode: StripeMode): { secretKey: string; publishableKey?: string; mode: StripeMode } {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const secretKey = this.getApiKey(mode);
    const publishableKey = this.credentials.publishableKey
      ?? (mode === 'sandbox'
        ? this.credentials.sandboxPublishableKey
        : this.credentials.livePublishableKey);
    return {
      secretKey,
      ...(publishableKey ? { publishableKey } : {}),
      mode: stripeApiKeyMode(secretKey) ?? mode,
    };
  }

  private async request<T>(
    mode: StripeMode,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>,
    requestOptions: { idempotencyKey?: string } = {}
  ): Promise<T> {
    const apiKey = this.getApiKey(mode);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (requestOptions.idempotencyKey) {
      headers['Idempotency-Key'] = requestOptions.idempotencyKey;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    };

    if (body && method === 'POST') {
      fetchOptions.body = this.encodeFormData(body);
    }

    let response: Response;
    try {
      response = await fetch(`${STRIPE_API_URL}${endpoint}`, fetchOptions);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timedOut = name === 'AbortError' || name === 'TimeoutError';
      throw new StripeApiError(
        timedOut
          ? `Stripe API request timed out after ${STRIPE_REQUEST_TIMEOUT_MS}ms`
          : 'Stripe API request failed before a response was received',
        0,
        timedOut ? 'timeout' : 'network'
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new StripeApiError(
        `Stripe API returned a malformed response (${response.status})`,
        response.status,
        'malformed_response'
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new StripeApiError(
        `Stripe API returned an invalid response shape (${response.status})`,
        response.status,
        'malformed_response'
      );
    }
    const payload = data as T & { error?: { message?: string } };

    if (!response.ok) {
      throw new StripeApiError(
        payload.error?.message || `Stripe API error: ${response.status}`,
        response.status
      );
    }

    return payload;
  }

  private encodeFormData(obj: Record<string, unknown>, prefix = ''): string {
    const pairs: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}[${key}]` : key;

      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        pairs.push(this.encodeFormData(value as Record<string, unknown>, fullKey));
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object') {
            pairs.push(this.encodeFormData(item as Record<string, unknown>, `${fullKey}[${index}]`));
          } else {
            pairs.push(`${encodeURIComponent(`${fullKey}[${index}]`)}=${encodeURIComponent(String(item))}`);
          }
        });
      } else {
        pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
      }
    }

    return pairs.filter(Boolean).join('&');
  }

  async verify(modeOrScope?: StripeMode | string): Promise<{ success: boolean; error?: string; accountId?: string }> {
    // The generic connection-verify path passes no mode; default to whichever
    // key is configured (live wins when both are) instead of failing a
    // sandbox-only connection by always reaching for the live key.
    const resolvedMode: StripeMode = modeOrScope === 'live' || modeOrScope === 'sandbox'
      ? modeOrScope
      : (
        (this.credentials?.secretKey && stripeApiKeyMode(this.credentials.secretKey) === 'live')
        || this.credentials?.liveSecretKey
          ? 'live'
          : 'sandbox'
      );
    try {
      const result = await this.request<{ id: string }>(resolvedMode, 'GET', '/account');
      return { success: true, accountId: result.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listProducts(mode: StripeMode, limit = 100, includeInactive = false): Promise<StripeProduct[]> {
    const products: StripeProduct[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;
    const seenCursors = new Set<string>();

    while (hasMore && products.length < limit) {
      const active = includeInactive ? '' : '&active=true';
      const pageLimit = Math.min(100, limit - products.length);
      const endpoint = startingAfter
        ? `/products?limit=${pageLimit}${active}&starting_after=${startingAfter}`
        : `/products?limit=${pageLimit}${active}`;

      const raw = await this.request<unknown>(mode, 'GET', endpoint);
      const parsed = stripeProductListResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new StripeApiError(
          'Stripe returned an invalid product-list response; catalog absence is unknown.',
          200,
          'malformed_response'
        );
      }
      const response = parsed.data as { data: StripeProduct[]; has_more: boolean };
      products.push(...response.data);
      hasMore = response.has_more;

      if (hasMore) {
        const nextCursor = response.data.at(-1)?.id;
        if (!nextCursor) {
          throw new Error('Stripe product pagination reported more results without a continuation cursor.');
        }
        if (seenCursors.has(nextCursor)) {
          throw new Error(`Stripe product pagination repeated continuation cursor ${nextCursor}.`);
        }
        seenCursors.add(nextCursor);
        startingAfter = nextCursor;
      }
    }

    return products.slice(0, limit);
  }

  async listPrices(mode: StripeMode, limit = 100, includeInactive = false): Promise<StripePrice[]> {
    const prices: StripePrice[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;
    const seenCursors = new Set<string>();

    while (hasMore && prices.length < limit) {
      const active = includeInactive ? '' : '&active=true';
      const pageLimit = Math.min(100, limit - prices.length);
      const endpoint = startingAfter
        ? `/prices?limit=${pageLimit}${active}&starting_after=${startingAfter}`
        : `/prices?limit=${pageLimit}${active}`;

      const raw = await this.request<unknown>(mode, 'GET', endpoint);
      const parsed = stripePriceListResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new StripeApiError(
          'Stripe returned an invalid price-list response; catalog absence is unknown.',
          200,
          'malformed_response'
        );
      }
      const response = parsed.data as { data: StripePrice[]; has_more: boolean };
      prices.push(...response.data);
      hasMore = response.has_more;

      if (hasMore) {
        const nextCursor = response.data.at(-1)?.id;
        if (!nextCursor) {
          throw new Error('Stripe price pagination reported more results without a continuation cursor.');
        }
        if (seenCursors.has(nextCursor)) {
          throw new Error(`Stripe price pagination repeated continuation cursor ${nextCursor}.`);
        }
        seenCursors.add(nextCursor);
        startingAfter = nextCursor;
      }
    }

    return prices.slice(0, limit);
  }

  async getProduct(mode: StripeMode, productId: string): Promise<StripeProduct | null> {
    try {
      return await this.request<StripeProduct>(mode, 'GET', `/products/${productId}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getPrice(mode: StripeMode, priceId: string): Promise<StripePrice | null> {
    try {
      return await this.request<StripePrice>(mode, 'GET', `/prices/${priceId}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createProduct(
    mode: StripeMode,
    product: Partial<StripeProduct> & { id?: string },
    options: { idempotencyKey?: string } = {}
  ): Promise<StripeProduct> {
    const body: Record<string, unknown> = {
      name: product.name,
      active: product.active ?? true,
    };

    if (product.id) {
      body.id = product.id;
    }
    if (product.description) {
      body.description = product.description;
    }
    if (product.tax_code !== undefined && product.tax_code !== null) {
      body.tax_code = product.tax_code;
    }
    if (product.metadata && Object.keys(product.metadata).length > 0) {
      body.metadata = product.metadata;
    }

    return this.request<StripeProduct>(mode, 'POST', '/products', body, options);
  }

  async updateProduct(
    mode: StripeMode,
    productId: string,
    product: Pick<Partial<StripeProduct>, 'name' | 'description' | 'tax_code' | 'active' | 'metadata'>
  ): Promise<StripeProduct> {
    return this.request<StripeProduct>(mode, 'POST', `/products/${productId}`, {
      ...(product.name !== undefined ? { name: product.name } : {}),
      ...(product.description !== undefined ? { description: product.description ?? '' } : {}),
      ...(product.tax_code !== undefined ? { tax_code: product.tax_code ?? '' } : {}),
      ...(product.active !== undefined ? { active: product.active } : {}),
      ...(product.metadata !== undefined ? { metadata: product.metadata } : {}),
    });
  }

  async createPrice(
    mode: StripeMode,
    price: Partial<StripePrice> & { product: string },
    options: { idempotencyKey?: string } = {}
  ): Promise<StripePrice> {
    const body: Record<string, unknown> = {
      product: price.product,
      currency: price.currency || 'usd',
      active: price.active ?? true,
    };

    if (price.unit_amount !== null && price.unit_amount !== undefined) {
      body.unit_amount = price.unit_amount;
    }

    if (price.recurring) {
      body.recurring = {
        interval: price.recurring.interval,
        interval_count: price.recurring.interval_count,
      };
    }

    if (price.nickname) {
      body.nickname = price.nickname;
    }
    if (price.lookup_key) {
      body.lookup_key = price.lookup_key;
    }

    if (price.metadata && Object.keys(price.metadata).length > 0) {
      body.metadata = price.metadata;
    }

    return this.request<StripePrice>(mode, 'POST', '/prices', body, options);
  }

  async updatePrice(
    mode: StripeMode,
    priceId: string,
    price: Pick<Partial<StripePrice>, 'active' | 'nickname' | 'metadata'>
  ): Promise<StripePrice> {
    return this.request<StripePrice>(mode, 'POST', `/prices/${priceId}`, {
      ...(price.active !== undefined ? { active: price.active } : {}),
      ...(price.nickname !== undefined ? { nickname: price.nickname ?? '' } : {}),
      ...(price.metadata !== undefined ? { metadata: price.metadata } : {}),
    });
  }

  // Webhook Management

  async listWebhookEndpoints(mode: StripeMode): Promise<StripeWebhookEndpoint[]> {
    const response = await this.request<{ data: StripeWebhookEndpoint[] }>(mode, 'GET', '/webhook_endpoints?limit=100');
    return response.data;
  }

  async getWebhookEndpoint(mode: StripeMode, endpointId: string): Promise<StripeWebhookEndpoint | null> {
    try {
      return await this.request<StripeWebhookEndpoint>(mode, 'GET', `/webhook_endpoints/${endpointId}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createWebhookEndpoint(
    mode: StripeMode,
    url: string,
    events: string[],
    options?: { description?: string; metadata?: Record<string, string> }
  ): Promise<StripeWebhookEndpoint> {
    const body: Record<string, unknown> = {
      url,
      enabled_events: events,
    };

    if (options?.description) {
      body.description = options.description;
    }
    if (options?.metadata) {
      body.metadata = options.metadata;
    }

    return this.request<StripeWebhookEndpoint>(mode, 'POST', '/webhook_endpoints', body);
  }

  async updateWebhookEndpoint(
    mode: StripeMode,
    endpointId: string,
    updates: { url?: string; enabled_events?: string[]; description?: string; disabled?: boolean }
  ): Promise<StripeWebhookEndpoint> {
    return this.request<StripeWebhookEndpoint>(mode, 'POST', `/webhook_endpoints/${endpointId}`, updates as Record<string, unknown>);
  }

  async deleteWebhookEndpoint(mode: StripeMode, endpointId: string): Promise<{ id: string; deleted: boolean }> {
    return this.request<{ id: string; deleted: boolean }>(mode, 'DELETE', `/webhook_endpoints/${endpointId}`);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'stripe',
    displayName: 'Stripe',
    category: 'payment',
    credentialsSchema: StripeCredentialsSchema,
    setupHelpUrl: 'https://dashboard.stripe.com/apikeys',
  },
  factory: (credentials) => {
    const adapter = new StripeAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
