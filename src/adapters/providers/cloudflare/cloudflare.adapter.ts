import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import type { IDnsProvider, DnsRecord } from '../../../domain/ports/dns.port.js';
import type {
  IEdgeMaintenanceAdapter,
  MaintenanceEdgeBinding,
  MaintenanceEdgeObservation,
} from '../../../domain/ports/maintenance.port.js';
import type {
  ILoadBalancerAdapter,
  LoadBalancerEnsureResult,
  LoadBalancerMonitor,
  LoadBalancerOrigin,
  LoadBalancerPool,
  LoadBalancerScope,
  ManagedLoadBalancer,
} from '../../../domain/ports/load-balancer.port.js';
import { CLOUDFLARE_TOKEN_URLS } from '../../../domain/services/connection-guidance.js';
import type { Receipt } from '../../../domain/ports/provider.port.js';

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_USER_TOKEN_URL = CLOUDFLARE_TOKEN_URLS.user;
const CLOUDFLARE_ACCOUNT_TOKEN_URL = CLOUDFLARE_TOKEN_URLS.account;
const CLOUDFLARE_DNS_PERMISSIONS = 'Zone > Zone > Read, Zone > Zone Settings > Read or Edit, and Zone > DNS > Edit/Write';
const CLOUDFLARE_REGISTRAR_PERMISSIONS = 'Registrar write permissions on the target account';
const CLOUDFLARE_PAGE_CAP = 1000;

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  name_servers: string[];
  account?: {
    id: string;
    name?: string;
  };
}

export interface CloudflareAccount {
  id: string;
  name?: string;
}

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  zone_name?: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  proxiable: boolean;
  ttl: number;
  priority?: number;
  created_on: string;
  modified_on: string;
}

export interface CreateDnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  data?: Record<string, unknown>;
}

export interface UpdateDnsRecordInput {
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface CloudflareEmailRoutingAddress {
  id: string;
  email: string;
  created?: string;
  modified?: string;
  tag?: string;
  verified?: string | null;
}

export interface CloudflareEmailRoutingAction {
  type: 'drop' | 'forward' | 'worker';
  value?: string[];
}

export interface CloudflareEmailRoutingMatcher {
  type: 'all' | 'literal';
  field?: 'to';
  value?: string;
}

export interface CloudflareEmailRoutingRule {
  id: string;
  name?: string;
  enabled: boolean;
  actions: CloudflareEmailRoutingAction[];
  matchers: CloudflareEmailRoutingMatcher[];
  priority?: number;
  tag?: string;
}

export interface CloudflareEmailRoutingSettings {
  id: string;
  enabled: boolean;
  name: string;
  status?: 'ready' | 'unconfigured' | 'misconfigured' | 'misconfigured/locked' | 'unlocked' | string;
  created?: string;
  modified?: string;
  skip_wizard?: boolean;
  tag?: string;
}

export interface CloudflareEmailRoutingDnsRecord {
  type?: string;
  name?: string;
  content?: string;
  priority?: number;
  ttl?: number;
}

export interface CloudflareEmailRoutingDnsSettings {
  record?: CloudflareEmailRoutingDnsRecord[];
  errors?: Array<{ code?: string; missing?: CloudflareEmailRoutingDnsRecord }>;
}

export interface RegistrarPricing {
  currency: string;
  registration_cost: string;
  renewal_cost: string;
}

export interface RegistrarDomainCandidate {
  name: string;
  registrable: boolean;
  pricing?: RegistrarPricing;
  reason?: string;
  tier?: 'standard' | 'premium' | string;
}

export interface RegistrarWorkflowStatus {
  completed: boolean;
  created_at: string;
  updated_at: string;
  links: {
    self: string;
    resource?: string;
  };
  state: 'pending' | 'in_progress' | 'action_required' | 'blocked' | 'succeeded' | 'failed' | string;
  context?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface RegistrarRegistrantContact {
  email: string;
  phone: string;
  postal_info: {
    address: {
      city: string;
      country_code: string;
      postal_code: string;
      state: string;
      street: string;
    };
    name: string;
    organization?: string;
  };
  fax?: string;
}

export interface RegistrarRegistrationInput {
  domainName: string;
  autoRenew?: boolean;
  contacts?: {
    registrant?: RegistrarRegistrantContact;
  };
  privacyMode?: 'redaction' | 'off';
  years?: number;
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
  };
}

interface CloudflareLoadBalancerMonitor {
  id: string;
  description?: string;
  type?: string;
  path?: string;
  interval?: number;
  timeout?: number;
  expected_codes?: string;
  follow_redirects?: boolean;
}

interface CloudflareLoadBalancerPool {
  id: string;
  name: string;
  monitor?: string;
  enabled?: boolean;
  origin_steering?: { policy?: string };
  origins?: Array<{
    name?: string;
    address?: string;
    enabled?: boolean;
    header?: { Host?: string[] };
  }>;
}

interface CloudflareManagedLoadBalancer {
  id: string;
  name: string;
  default_pools?: string[];
  fallback_pool?: string;
  enabled?: boolean;
  proxied?: boolean;
  steering_policy?: string;
}

class CloudflareApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

function isCloudflareNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

// Credentials schema for self-registration
export const CloudflareCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
  accountId: z.string().min(1).optional(),
  registrarApiToken: z.string().min(1).optional(),
  apiTokenKind: z.enum(['user', 'account', 'unknown']).optional(),
});

export type CloudflareCredentials = z.infer<typeof CloudflareCredentialsSchema>;

function normalizeApiToken(token: string): string {
  let normalized = token.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized
    .replace(/^authorization:\s*bearer\s+/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
}

function tokenSetupHelp(kind: 'user' | 'account' | 'unknown', domain?: string): string {
  const scope = domain ? ` for ${domain}` : '';
  if (kind === 'account') {
    return [
      `Cloudflare rejected this Account API Token${scope}. Account tokens usually start with cfat_.`,
      `Create or review Account API Tokens in Cloudflare at Manage Account > Account API Tokens: ${CLOUDFLARE_ACCOUNT_TOKEN_URL}`,
      `For DNS automation, grant ${CLOUDFLARE_DNS_PERMISSIONS} for the target zone.`,
      'Account API Tokens also require accountId in the Hypervibe credentials.',
      `Cloudflare Registrar domain registration is not supported by Account API Tokens; use a User API Token from My Profile > API Tokens if Hypervibe needs to buy domains: ${CLOUDFLARE_USER_TOKEN_URL}`,
    ].join(' ');
  }
  if (kind === 'user') {
    return [
      `Cloudflare rejected this User API Token${scope}. User tokens usually start with cfut_.`,
      `Create a User API Token in Cloudflare at My Profile > API Tokens: ${CLOUDFLARE_USER_TOKEN_URL}`,
      `Use Create Token, start from the Edit zone DNS template, and grant ${CLOUDFLARE_DNS_PERMISSIONS} for the target zone.`,
      'Use the token secret itself as apiToken/CLOUDFLARE_API_TOKEN, not the token name, token id, or legacy Global API Key.',
    ].join(' ');
  }
  return [
    `Cloudflare rejected this API token${scope}.`,
    `For the simplest DNS/custom-domain/email automation setup, create a User API Token under My Profile > API Tokens: ${CLOUDFLARE_USER_TOKEN_URL}`,
    `Grant ${CLOUDFLARE_DNS_PERMISSIONS} for the target zone.`,
    `For durable account-owned automation that should not be tied to a user, create an Account API Token under Manage Account > Account API Tokens: ${CLOUDFLARE_ACCOUNT_TOKEN_URL} and pass accountId.`,
    'User API Tokens usually start with cfut_; Account API Tokens usually start with cfat_.',
    'Cloudflare Registrar/domain purchase requires a User API Token; Account API Tokens are not supported for Registrar.',
    'Do not use the legacy Global API Key.',
  ].join(' ');
}

export function cloudflareTokenKind(token: string): 'user' | 'account' | 'unknown' {
  const normalized = normalizeApiToken(token);
  if (normalized.startsWith('cfut_')) return 'user';
  if (normalized.startsWith('cfat_')) return 'account';
  return 'unknown';
}

function registrarTokenSetupHelp(domain?: string): string {
  const scope = domain ? ` for ${domain}` : '';
  return [
    `Cloudflare Registrar/domain purchase${scope} requires a Cloudflare User API Token, not an Account API Token.`,
    `Create the User API Token at My Profile > API Tokens: ${CLOUDFLARE_USER_TOKEN_URL}`,
    `Grant ${CLOUDFLARE_REGISTRAR_PERMISSIONS}.`,
    'For a single-token setup, store that User API Token as apiToken/CLOUDFLARE_API_TOKEN; it can handle DNS and Registrar when it has both permission sets.',
    'For a durable account-token setup, keep the Account API Token as apiToken/CLOUDFLARE_API_TOKEN and store the User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN.',
    'New user tokens usually start with cfut_; new account tokens usually start with cfat_.',
  ].join(' ');
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
  return warnings.filter(Boolean).join(' ');
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/g, '');
}

function canonicalDnsName(value: string, zoneName?: string): string {
  const normalized = normalizeDnsName(value);
  const zone = zoneName ? normalizeDnsName(zoneName) : '';
  if (!zone || normalized === zone) return normalized;
  if (normalized === '@') return zone;
  return normalized.endsWith(`.${zone}`) ? normalized : `${normalized}.${zone}`;
}

function normalizeDnsContent(type: string, value: string): string {
  const normalizedType = type.trim().toUpperCase();
  const trimmed = value.trim();
  if (normalizedType === 'CNAME') {
    return trimmed
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/g, '')
      .replace(/\.+$/g, '')
      .toLowerCase();
  }
  return trimmed;
}

function isDuplicateDnsRecordError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|identical record/i.test(message);
}

export class CloudflareAdapter implements IDnsProvider, ILoadBalancerAdapter, IEdgeMaintenanceAdapter {
  readonly name = 'cloudflare';
  private credentials: CloudflareCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as CloudflareCredentials;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>,
    token?: string
  ): Promise<CloudflareResponse<T>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${normalizeApiToken(token ?? this.credentials.apiToken)}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${CLOUDFLARE_API_URL}${endpoint}`, options);
    const data = (await response.json()) as CloudflareResponse<T>;

    if (!response.ok || data.success !== true) {
      const errorMsg = Array.isArray(data.errors)
        ? data.errors.map((error) => error.message).join(', ')
        : '';
      throw new CloudflareApiError(
        `Cloudflare API error: ${errorMsg || `HTTP ${response.status}`}`,
        response.status
      );
    }

    return data;
  }

  /**
   * A successful Cloudflare write response is only an acknowledgement. Keep
   * the acknowledged id available to the caller, but do not mark the write
   * verified until an exact read observes the requested configuration.
   */
  private async verifyLoadBalancerWrite<T>(params: {
    label: string;
    acknowledged: T;
    get: () => Promise<T | null>;
    matches: (observed: T) => boolean;
  }): Promise<{ resource: T; verified: boolean; verificationError?: string }> {
    const configuredAttempts = Number(
      process.env.HYPERVIBE_CLOUDFLARE_LB_VERIFY_ATTEMPTS ?? 8
    );
    const attempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0
      ? configuredAttempts
      : 8;
    const configuredInterval = Number(
      process.env.HYPERVIBE_CLOUDFLARE_LB_VERIFY_INTERVAL_MS ?? 500
    );
    const interval = Number.isInteger(configuredInterval) && configuredInterval >= 0
      ? configuredInterval
      : 500;
    let lastError = `${params.label} was not observable after Cloudflare acknowledged the write.`;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const observed = await params.get();
        if (observed && params.matches(observed)) {
          return { resource: observed, verified: true };
        }
        lastError = observed
          ? `${params.label} was observable, but its configuration had not converged.`
          : `${params.label} was not yet observable after Cloudflare acknowledged the write.`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < attempts && interval > 0) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }

    return {
      resource: params.acknowledged,
      verified: false,
      verificationError: lastError,
    };
  }

  private loadBalancerCreateOutcomeMayBeUnknown(error: unknown): boolean {
    // A concrete client-error response is provider acknowledgement that the
    // request was rejected. Transport/parser failures and 5xx responses can
    // occur after commit, so they require bounded identity recovery.
    return !(error instanceof CloudflareApiError
      && error.status !== undefined
      && error.status >= 400
      && error.status < 500);
  }

  private async recoverLoadBalancerCreateIdentity<T extends { id: string }>(params: {
    label: string;
    find: () => Promise<T[]>;
  }): Promise<T | undefined> {
    const configuredAttempts = Number(
      process.env.HYPERVIBE_CLOUDFLARE_LB_VERIFY_ATTEMPTS ?? 8
    );
    const attempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0
      ? Math.min(configuredAttempts, 20)
      : 8;
    const configuredInterval = Number(
      process.env.HYPERVIBE_CLOUDFLARE_LB_VERIFY_INTERVAL_MS ?? 500
    );
    const interval = Number.isInteger(configuredInterval) && configuredInterval >= 0
      ? configuredInterval
      : 500;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const matches = await params.find();
        if (matches.length > 1) {
          throw new Error(
            `Multiple ${params.label} resources appeared after create: ${matches.map((resource) => resource.id).join(', ')}.`
          );
        }
        if (matches.length === 1) return matches[0];
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts - 1 && interval > 0) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }

    if (lastError) {
      throw new Error(
        `Could not recover ${params.label} identity after an uncertain create: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }
    return undefined;
  }

  private async rawRequest(
    method: 'GET' | 'PUT',
    endpoint: string,
    options: { body?: string; contentType?: string } = {}
  ): Promise<Response> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const response = await fetch(`${CLOUDFLARE_API_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${normalizeApiToken(this.credentials.apiToken)}`,
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    if (!response.ok) {
      throw new CloudflareApiError(`Cloudflare API error: HTTP ${response.status}`, response.status);
    }
    return response;
  }

  private maintenanceScript(hostname: string): { name: string; source: string; contentHash: string } {
    const normalized = hostname.trim().replace(/\.$/, '').toLowerCase();
    const contentHash = createHash('sha256').update(`hypervibe-maintenance-v1:${normalized}`).digest('hex');
    const name = `hv-maintenance-${createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`;
    const source = `addEventListener("fetch",event=>event.respondWith(new Response("Temporarily unavailable for maintenance\\n",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store","Retry-After":"30","X-Hypervibe-Maintenance":"${contentHash}"}})));`;
    return { name, source, contentHash };
  }

  async observeMaintenanceEdge(
    hostname: string,
    binding?: MaintenanceEdgeBinding
  ): Promise<MaintenanceEdgeObservation> {
    try {
      const expected = this.maintenanceScript(hostname);
      const scope = await this.resolveLoadBalancerScope(hostname);
      const routes = await this.listPaginated<{ id: string; pattern: string; script?: string }>(
        `/zones/${scope.zoneId}/workers/routes`
      );
      const pattern = `${hostname.trim().replace(/\.$/, '').toLowerCase()}/*`;
      const matching = routes.filter((route) => route.pattern.toLowerCase() === pattern);
      const conflicting = routes.filter((route) => {
        const candidate = route.pattern.toLowerCase();
        return candidate.startsWith(`${hostname.toLowerCase()}/`)
          && candidate !== pattern
          && route.script !== expected.name;
      });
      if (conflicting.length > 0) {
        return { state: 'unknown', hostname, markerVerified: false, binding, reason: 'maintenance_edge_conflicting_route' };
      }
      if (!binding) {
        return matching.length === 0
          ? { state: 'inactive', hostname, markerVerified: false }
          : { state: 'unknown', hostname, markerVerified: false, reason: 'maintenance_edge_unbound_route' };
      }
      if (
        binding.hostname !== hostname
        || binding.accountId !== scope.accountId
        || binding.zoneId !== scope.zoneId
        || binding.scriptName !== expected.name
        || binding.contentHash !== expected.contentHash
      ) {
        return { state: 'unknown', hostname, markerVerified: false, reason: 'maintenance_edge_binding_mismatch' };
      }
      const exact = matching.filter((route) => route.id === binding.routeId && route.script === binding.scriptName);
      if (exact.length !== 1) {
        return matching.length === 0
          ? { state: 'inactive', hostname, markerVerified: false, binding }
          : { state: 'unknown', hostname, markerVerified: false, binding, reason: 'maintenance_edge_route_mismatch' };
      }
      const marker = await fetch(`https://${hostname}/.well-known/hypervibe-maintenance?nonce=${Date.now()}`, {
        redirect: 'manual',
        headers: { 'Cache-Control': 'no-cache' },
      });
      const markerVerified = marker.status === 503
        && marker.headers.get('x-hypervibe-maintenance') === expected.contentHash;
      return markerVerified
        ? { state: 'active', hostname, markerVerified: true, binding }
        : { state: 'unknown', hostname, markerVerified: false, binding, reason: 'maintenance_edge_marker_unverified' };
    } catch {
      return { state: 'unknown', hostname, markerVerified: false, reason: 'maintenance_edge_observation_failed' };
    }
  }

  async ensureMaintenanceEdge(
    hostname: string,
    expectedContentHash: string,
    binding?: MaintenanceEdgeBinding
  ): Promise<Receipt> {
    try {
      const expected = this.maintenanceScript(hostname);
      if (expected.contentHash !== expectedContentHash) {
        throw new Error('Reviewed maintenance content changed.');
      }
      const scope = await this.resolveLoadBalancerScope(hostname);
      const pattern = `${hostname.trim().replace(/\.$/, '').toLowerCase()}/*`;
      const routes = await this.listPaginated<{ id: string; pattern: string; script?: string }>(
        `/zones/${scope.zoneId}/workers/routes`
      );
      const matching = routes.filter((route) => route.pattern.toLowerCase() === pattern);
      const conflicting = routes.filter((route) => {
        const candidate = route.pattern.toLowerCase();
        return candidate.startsWith(`${hostname.toLowerCase()}/`)
          && candidate !== pattern
          && route.script !== expected.name;
      });
      if (matching.some((route) => route.script !== expected.name) || conflicting.length > 0) {
        throw new Error('The hostname already has a different Cloudflare Worker route.');
      }
      if (!binding && matching.length > 0) {
        throw new Error('A matching maintenance route exists without a durable Hypervibe binding.');
      }
      await this.rawRequest(
        'PUT',
        `/accounts/${scope.accountId}/workers/scripts/${encodeURIComponent(expected.name)}`,
        { body: expected.source, contentType: 'application/javascript' }
      );
      let route = binding
        ? matching.find((candidate) => candidate.id === binding.routeId)
        : undefined;
      if (!route) {
        const created = await this.request<{ id: string; pattern: string; script: string }>(
          'POST',
          `/zones/${scope.zoneId}/workers/routes`,
          { pattern, script: expected.name }
        );
        route = created.result;
      }
      const nextBinding: MaintenanceEdgeBinding = {
        hostname,
        accountId: scope.accountId,
        zoneId: scope.zoneId,
        routeId: route.id,
        scriptName: expected.name,
        contentHash: expected.contentHash,
      };
      return {
        success: true,
        message: `Cloudflare maintenance edge configured for ${hostname}`,
        data: { binding: nextBinding, applied: 1, skipped: 0 },
      };
    } catch (error) {
      return {
        success: false,
        message: `Cloudflare maintenance edge was not configured for ${hostname}`,
        error: error instanceof Error ? error.message : 'Cloudflare maintenance edge failed',
      };
    }
  }

  async removeMaintenanceEdge(binding: MaintenanceEdgeBinding): Promise<Receipt> {
    try {
      const routes = await this.listPaginated<{ id: string; pattern: string; script?: string }>(
        `/zones/${binding.zoneId}/workers/routes`
      );
      const route = routes.find((candidate) => candidate.id === binding.routeId);
      if (route && (
        route.pattern.toLowerCase() !== `${binding.hostname.toLowerCase()}/*`
        || route.script !== binding.scriptName
      )) {
        throw new Error('The bound Cloudflare route identity changed.');
      }
      if (route) {
        await this.request('DELETE', `/zones/${binding.zoneId}/workers/routes/${binding.routeId}`);
      }
      try {
        await this.request('DELETE', `/accounts/${binding.accountId}/workers/scripts/${encodeURIComponent(binding.scriptName)}`);
      } catch (error) {
        if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
      }
      return {
        success: true,
        message: `Cloudflare maintenance edge removed from ${binding.hostname}`,
        data: { applied: route ? 1 : 0, skipped: route ? 0 : 1 },
      };
    } catch (error) {
      return {
        success: false,
        message: `Cloudflare maintenance edge was not removed from ${binding.hostname}`,
        error: error instanceof Error ? error.message : 'Cloudflare maintenance edge removal failed',
      };
    }
  }

  maintenanceContentHash(hostname: string): string {
    return this.maintenanceScript(hostname).contentHash;
  }

  private async listPaginated<T>(
    endpoint: string,
    description = 'Cloudflare resource'
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      if (page > CLOUDFLARE_PAGE_CAP) {
        throw new Error(`${description} pagination exceeded ${CLOUDFLARE_PAGE_CAP} pages.`);
      }
      const separator = endpoint.includes('?') ? '&' : '?';
      const response = await this.request<T[]>('GET', `${endpoint}${separator}page=${page}&per_page=100`);
      if (!Array.isArray(response.result)) {
        throw new Error(`${description} observation returned an invalid list.`);
      }
      items.push(...response.result);
      hasMore = this.hasNextPage(response, page, 100, description);
      page += 1;
    }
    return items;
  }

  private hasNextPage<T>(
    response: CloudflareResponse<T[]>,
    expectedPage: number,
    requestedPageSize: number,
    description: string
  ): boolean {
    const info = response.result_info;
    if (!info) {
      if (response.result.length >= requestedPageSize) {
        throw new Error(
          `${description} observation returned a full page without pagination metadata.`
        );
      }
      return false;
    }
    if (
      !Number.isInteger(info.page)
      || info.page !== expectedPage
      || !Number.isInteger(info.per_page)
      || info.per_page <= 0
      || !Number.isInteger(info.total_count)
      || info.total_count < 0
      || !Number.isInteger(info.total_pages)
      || info.total_pages < 0
      || (info.total_pages < expectedPage
        && !(expectedPage === 1 && info.total_pages === 0 && response.result.length === 0))
    ) {
      throw new Error(`${description} observation returned invalid pagination metadata.`);
    }
    return expectedPage < info.total_pages;
  }

  private registrarToken(domain?: string): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const explicit = this.credentials.registrarApiToken?.trim();
    const fallback = this.credentials.apiToken;
    const token = explicit || fallback;
    const kind = explicit ? cloudflareTokenKind(token) : (this.credentials.apiTokenKind ?? cloudflareTokenKind(token));
    if (kind === 'account') {
      const credentialName = explicit ? 'registrarApiToken' : 'apiToken';
      throw new Error(`${registrarTokenSetupHelp(domain)} The configured ${credentialName} is an Account API Token, which Cloudflare does not support for Registrar.`);
    }
    return token;
  }

  private async verifyUserToken(token: string): Promise<void> {
    await this.request<{ id: string }>('GET', '/user/tokens/verify', undefined, token);
  }

  private async verifyToken(domain?: string): Promise<{ success: true; kind: 'user' | 'account' | 'unknown'; warning?: string } | { success: false; error: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const kind = cloudflareTokenKind(this.credentials.apiToken);

    if (kind === 'account') {
      const accountId = this.credentials.accountId?.trim();
      if (!accountId) {
        return {
          success: false,
          error: `${tokenSetupHelp('account', domain)} Add CLOUDFLARE_ACCOUNT_ID and connect with credentialsMap={"apiToken":"CLOUDFLARE_API_TOKEN","accountId":"CLOUDFLARE_ACCOUNT_ID"}.`,
        };
      }
      try {
        await this.request<{ id: string; status?: string }>('GET', `/accounts/${accountId}/tokens/verify`);
        return {
          success: true,
          kind,
          warning: this.credentials.registrarApiToken
            ? 'Cloudflare Account API Token verified for DNS/custom-domain/email automation.'
            : 'Cloudflare Account API Token verified for DNS/custom-domain/email automation. Cloudflare Registrar domain registration is not supported by Account API Tokens; add registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN if Hypervibe needs to buy domains.',
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: `${tokenSetupHelp('account', domain)} Cloudflare response: ${msg}` };
      }
    }

    try {
      await this.verifyUserToken(this.credentials.apiToken);
      return { success: true, kind };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (this.credentials.accountId?.trim()) {
        try {
          await this.request<{ id: string; status?: string }>('GET', `/accounts/${this.credentials.accountId.trim()}/tokens/verify`);
          return {
            success: true,
            kind: 'account',
            warning: this.credentials.registrarApiToken
              ? 'Cloudflare Account API Token verified for DNS/custom-domain/email automation.'
              : 'Cloudflare Account API Token verified for DNS/custom-domain/email automation. Cloudflare Registrar domain registration is not supported by Account API Tokens; add registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN if Hypervibe needs to buy domains.',
          };
        } catch {
          // Keep the user-token verification error below; it is usually clearer.
        }
      }
      // Global API Keys return 401 on /user/tokens/verify since that endpoint only works with API Tokens
      if (msg.includes('Authentication') || msg.includes('401') || msg.includes('Invalid access token') || msg.includes('Invalid API Token')) {
        return {
          success: false,
          error: `${tokenSetupHelp(kind, domain)} Cloudflare response: ${msg}`,
        };
      }
      return { success: false, error: msg };
    }
  }

  private async verifyRegistrarToken(domain?: string): Promise<string | undefined> {
    if (!this.credentials?.registrarApiToken) return undefined;
    const token = this.credentials.registrarApiToken;
    const kind = cloudflareTokenKind(token);
    if (kind === 'account') {
      return `${registrarTokenSetupHelp(domain)} The configured registrarApiToken is an Account API Token.`;
    }
    try {
      await this.verifyUserToken(token);
      return undefined;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `${registrarTokenSetupHelp(domain)} Cloudflare response: ${msg}`;
    }
  }

  async verify(domain?: string): Promise<{ success: boolean; error?: string; zones?: string[]; warning?: string; tokenKind?: 'user' | 'account' | 'unknown' }> {
    const verified = await this.verifyToken(domain);
    if (!verified.success) {
      return verified;
    }
    const registrarError = await this.verifyRegistrarToken(domain);
    if (registrarError) {
      return { success: false, error: registrarError };
    }

    if (domain) {
      try {
        const zone = await this.findZoneByName(domain);
        if (zone) {
          return {
            success: true,
            zones: [zone.name],
            tokenKind: verified.kind,
            ...(verified.warning ? { warning: verified.warning } : {}),
          };
        }

        const zones = await this.listZones();
        const zoneNames = zones.map(z => z.name);
        return {
          success: true,
          zones: zoneNames,
          tokenKind: verified.kind,
          warning: combineWarnings(
            verified.warning,
            `Token is valid, but Hypervibe could not find a Cloudflare zone for "${domain}". If the zone already exists, make sure the token includes ${CLOUDFLARE_DNS_PERMISSIONS} for that zone. If Hypervibe will register the domain first, this is expected until Cloudflare creates the zone.`
          ),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          success: true,
          tokenKind: verified.kind,
          warning: combineWarnings(
            verified.warning,
            `Token is valid, but Hypervibe could not confirm Cloudflare zone access for "${domain}" (${msg}). DNS automation needs zone visibility or an existing zone-scoped token with DNS permissions; domain registration may still be possible with account/registrar permissions.`
          ),
        };
      }
    }

    return { success: true, tokenKind: verified.kind, ...(verified.warning ? { warning: verified.warning } : {}) };
  }

  async listZones(): Promise<CloudflareZone[]> {
    const zones: CloudflareZone[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      if (page > CLOUDFLARE_PAGE_CAP) {
        throw new Error(`Cloudflare zone pagination exceeded ${CLOUDFLARE_PAGE_CAP} pages.`);
      }
      const response = await this.request<CloudflareZone[]>('GET', `/zones?page=${page}&per_page=50`);
      if (!Array.isArray(response.result)) {
        throw new Error('Cloudflare zone observation returned an invalid list.');
      }
      zones.push(...response.result);
      hasMore = this.hasNextPage(response, page, 50, 'Cloudflare zone');
      page += 1;
    }

    return zones;
  }

  async listAccounts(): Promise<CloudflareAccount[]> {
    const accounts: CloudflareAccount[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      if (page > CLOUDFLARE_PAGE_CAP) {
        throw new Error(`Cloudflare account pagination exceeded ${CLOUDFLARE_PAGE_CAP} pages.`);
      }
      const response = await this.request<CloudflareAccount[]>('GET', `/accounts?page=${page}&per_page=50`);
      if (!Array.isArray(response.result)) {
        throw new Error('Cloudflare account observation returned an invalid list.');
      }
      accounts.push(...response.result);
      hasMore = this.hasNextPage(response, page, 50, 'Cloudflare account');
      page += 1;
    }

    return accounts;
  }

  async resolveAccountId(accountId?: string): Promise<string> {
    const explicit = accountId?.trim() || this.credentials?.accountId?.trim();
    if (explicit) {
      return explicit;
    }

    const accounts = await this.listAccounts();
    if (accounts.length === 1) {
      return accounts[0].id;
    }
    if (accounts.length === 0) {
      throw new Error('No Cloudflare accounts are visible to this API token.');
    }
    throw new Error(`Multiple Cloudflare accounts are visible (${accounts.map((account) => account.name ?? account.id).join(', ')}). Pass accountId or store it in the Cloudflare connection credentials.`);
  }

  async findZoneByName(domain: string): Promise<CloudflareZone | null> {
    const zones = await this.listPaginated<CloudflareZone>(
      `/zones?name=${encodeURIComponent(domain)}`,
      'Cloudflare zone'
    );
    if (zones.length > 1) {
      throw new Error(`Multiple Cloudflare zones match ${domain}; use a zone-scoped connection so Hypervibe can resolve one durable zone identity.`);
    }
    return zones[0] ?? null;
  }

  async resolveLoadBalancerScope(hostname: string): Promise<LoadBalancerScope> {
    const labels = hostname.trim().replace(/\.$/, '').toLowerCase().split('.');
    for (let index = 0; index <= labels.length - 2; index++) {
      const zone = await this.findZoneByName(labels.slice(index).join('.'));
      if (!zone) continue;
      return {
        zoneId: zone.id,
        accountId: zone.account?.id ?? await this.resolveAccountId(),
      };
    }
    throw new Error(`Cloudflare zone not found for load-balancer hostname ${hostname}.`);
  }

  private mapLoadBalancerMonitor(resource: CloudflareLoadBalancerMonitor): LoadBalancerMonitor {
    return {
      id: resource.id,
      name: resource.description ?? '',
      type: resource.type ?? '',
      path: resource.path ?? '/',
      intervalSeconds: resource.interval ?? 60,
      timeoutSeconds: resource.timeout ?? 5,
      expectedCodes: resource.expected_codes ?? '200-399',
      followRedirects: resource.follow_redirects ?? false,
    };
  }

  private loadBalancerMonitorMatches(
    observed: LoadBalancerMonitor,
    desired: Omit<LoadBalancerMonitor, 'id'>
  ): boolean {
    return observed.name === desired.name
      && observed.type === desired.type
      && observed.path === desired.path
      && observed.intervalSeconds === desired.intervalSeconds
      && observed.timeoutSeconds === desired.timeoutSeconds
      && observed.expectedCodes === desired.expectedCodes
      && observed.followRedirects === desired.followRedirects;
  }

  async findMonitorsByName(accountId: string, name: string): Promise<LoadBalancerMonitor[]> {
    const resources = await this.listPaginated<CloudflareLoadBalancerMonitor>(
      `/accounts/${encodeURIComponent(accountId)}/load_balancers/monitors`
    );
    return resources
      .map((resource) => this.mapLoadBalancerMonitor(resource))
      .filter((resource) => resource.name === name);
  }

  async getMonitor(accountId: string, id: string): Promise<LoadBalancerMonitor | null> {
    try {
      const response = await this.request<CloudflareLoadBalancerMonitor>(
        'GET',
        `/accounts/${encodeURIComponent(accountId)}/load_balancers/monitors/${encodeURIComponent(id)}`
      );
      return this.mapLoadBalancerMonitor(response.result);
    } catch (error) {
      if (isCloudflareNotFound(error)) return null;
      throw error;
    }
  }

  async ensureMonitor(
    accountId: string,
    desired: Omit<LoadBalancerMonitor, 'id'>,
    id?: string
  ): Promise<LoadBalancerEnsureResult<LoadBalancerMonitor>> {
    const body = {
      description: desired.name,
      type: desired.type,
      method: 'GET',
      path: desired.path,
      interval: desired.intervalSeconds,
      timeout: desired.timeoutSeconds,
      expected_codes: desired.expectedCodes,
      follow_redirects: desired.followRedirects,
    };
    const endpoint = `/accounts/${encodeURIComponent(accountId)}/load_balancers/monitors${id ? `/${encodeURIComponent(id)}` : ''}`;
    let acknowledged: LoadBalancerMonitor;
    try {
      const response = await this.request<CloudflareLoadBalancerMonitor>(id ? 'PUT' : 'POST', endpoint, body);
      acknowledged = this.mapLoadBalancerMonitor(response.result);
      if (!acknowledged.id || (id && acknowledged.id !== id)) {
        throw new Error('Cloudflare returned an invalid monitor identity after the write.');
      }
    } catch (error) {
      if (id || !this.loadBalancerCreateOutcomeMayBeUnknown(error)) throw error;
      const recovered = await this.recoverLoadBalancerCreateIdentity({
        label: `Cloudflare load-balancer monitor "${desired.name}"`,
        find: () => this.findMonitorsByName(accountId, desired.name),
      });
      if (!recovered) throw error;
      acknowledged = recovered;
    }
    return {
      ...(await this.verifyLoadBalancerWrite({
        label: `Cloudflare load-balancer monitor ${acknowledged.id}`,
        acknowledged,
        get: () => this.getMonitor(accountId, acknowledged.id),
        matches: (observed) => this.loadBalancerMonitorMatches(observed, desired),
      })),
      created: !id,
    };
  }

  async deleteMonitor(accountId: string, id: string): Promise<void> {
    const endpoint = `/accounts/${encodeURIComponent(accountId)}/load_balancers/monitors/${encodeURIComponent(id)}`;
    try {
      await this.request<{ id: string }>('DELETE', endpoint);
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
    if (await this.getMonitor(accountId, id)) {
      throw new Error(`Cloudflare monitor ${id} still exists after deletion.`);
    }
  }

  private mapLoadBalancerPool(resource: CloudflareLoadBalancerPool): LoadBalancerPool {
    return {
      id: resource.id,
      name: resource.name,
      monitorId: resource.monitor ?? '',
      origins: (resource.origins ?? []).map((origin) => ({
        name: origin.name ?? '',
        address: origin.address ?? '',
        hostHeader: origin.header?.Host?.[0] ?? '',
        enabled: origin.enabled !== false,
      })),
      enabled: resource.enabled !== false,
      steering: resource.origin_steering?.policy ?? 'random',
    };
  }

  private loadBalancerPoolMatches(
    observed: LoadBalancerPool,
    desired: Omit<LoadBalancerPool, 'id'>
  ): boolean {
    const byName = (left: LoadBalancerOrigin, right: LoadBalancerOrigin) => (
      left.name.localeCompare(right.name)
    );
    return observed.name === desired.name
      && observed.monitorId === desired.monitorId
      && observed.enabled === desired.enabled
      && observed.steering === desired.steering
      && JSON.stringify([...observed.origins].sort(byName))
        === JSON.stringify([...desired.origins].sort(byName));
  }

  async findPoolsByName(accountId: string, name: string): Promise<LoadBalancerPool[]> {
    const resources = await this.listPaginated<CloudflareLoadBalancerPool>(
      `/accounts/${encodeURIComponent(accountId)}/load_balancers/pools`
    );
    return resources
      .map((resource) => this.mapLoadBalancerPool(resource))
      .filter((resource) => resource.name === name);
  }

  async getPool(accountId: string, id: string): Promise<LoadBalancerPool | null> {
    try {
      const response = await this.request<CloudflareLoadBalancerPool>(
        'GET',
        `/accounts/${encodeURIComponent(accountId)}/load_balancers/pools/${encodeURIComponent(id)}`
      );
      return this.mapLoadBalancerPool(response.result);
    } catch (error) {
      if (isCloudflareNotFound(error)) return null;
      throw error;
    }
  }

  async ensurePool(
    accountId: string,
    desired: Omit<LoadBalancerPool, 'id'>,
    id?: string
  ): Promise<LoadBalancerEnsureResult<LoadBalancerPool>> {
    const body = {
      name: desired.name,
      monitor: desired.monitorId,
      enabled: desired.enabled,
      origin_steering: { policy: desired.steering },
      origins: desired.origins.map((origin) => ({
        name: origin.name,
        address: origin.address,
        enabled: origin.enabled,
        header: { Host: [origin.hostHeader] },
      })),
    };
    const endpoint = `/accounts/${encodeURIComponent(accountId)}/load_balancers/pools${id ? `/${encodeURIComponent(id)}` : ''}`;
    let acknowledged: LoadBalancerPool;
    try {
      const response = await this.request<CloudflareLoadBalancerPool>(id ? 'PUT' : 'POST', endpoint, body);
      acknowledged = this.mapLoadBalancerPool(response.result);
      if (!acknowledged.id || (id && acknowledged.id !== id)) {
        throw new Error('Cloudflare returned an invalid load-balancer pool identity after the write.');
      }
    } catch (error) {
      if (id || !this.loadBalancerCreateOutcomeMayBeUnknown(error)) throw error;
      const recovered = await this.recoverLoadBalancerCreateIdentity({
        label: `Cloudflare load-balancer pool "${desired.name}"`,
        find: () => this.findPoolsByName(accountId, desired.name),
      });
      if (!recovered) throw error;
      acknowledged = recovered;
    }
    return {
      ...(await this.verifyLoadBalancerWrite({
        label: `Cloudflare load-balancer pool ${acknowledged.id}`,
        acknowledged,
        get: () => this.getPool(accountId, acknowledged.id),
        matches: (observed) => this.loadBalancerPoolMatches(observed, desired),
      })),
      created: !id,
    };
  }

  async deletePool(accountId: string, id: string): Promise<void> {
    const endpoint = `/accounts/${encodeURIComponent(accountId)}/load_balancers/pools/${encodeURIComponent(id)}`;
    try {
      await this.request<{ id: string }>('DELETE', endpoint);
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
    if (await this.getPool(accountId, id)) {
      throw new Error(`Cloudflare load-balancer pool ${id} still exists after deletion.`);
    }
  }

  private mapManagedLoadBalancer(resource: CloudflareManagedLoadBalancer): ManagedLoadBalancer {
    return {
      id: resource.id,
      hostname: resource.name,
      poolId: resource.default_pools?.[0] ?? '',
      fallbackPoolId: resource.fallback_pool ?? '',
      enabled: resource.enabled !== false,
      proxied: resource.proxied !== false,
      steering: resource.steering_policy ?? 'off',
    };
  }

  private managedLoadBalancerMatches(
    observed: ManagedLoadBalancer,
    desired: Omit<ManagedLoadBalancer, 'id'>
  ): boolean {
    return normalizeDnsName(observed.hostname) === normalizeDnsName(desired.hostname)
      && observed.poolId === desired.poolId
      && observed.fallbackPoolId === desired.fallbackPoolId
      && observed.enabled === desired.enabled
      && observed.proxied === desired.proxied
      && observed.steering === desired.steering;
  }

  async findLoadBalancersByHostname(zoneId: string, hostname: string): Promise<ManagedLoadBalancer[]> {
    const resources = await this.listPaginated<CloudflareManagedLoadBalancer>(
      `/zones/${encodeURIComponent(zoneId)}/load_balancers`
    );
    const normalized = hostname.trim().replace(/\.$/, '').toLowerCase();
    return resources
      .map((resource) => this.mapManagedLoadBalancer(resource))
      .filter((resource) => resource.hostname.trim().replace(/\.$/, '').toLowerCase() === normalized);
  }

  async getLoadBalancer(zoneId: string, id: string): Promise<ManagedLoadBalancer | null> {
    try {
      const response = await this.request<CloudflareManagedLoadBalancer>(
        'GET',
        `/zones/${encodeURIComponent(zoneId)}/load_balancers/${encodeURIComponent(id)}`
      );
      return this.mapManagedLoadBalancer(response.result);
    } catch (error) {
      if (isCloudflareNotFound(error)) return null;
      throw error;
    }
  }

  async ensureLoadBalancer(
    zoneId: string,
    desired: Omit<ManagedLoadBalancer, 'id'>,
    id?: string
  ): Promise<LoadBalancerEnsureResult<ManagedLoadBalancer>> {
    const body = {
      name: desired.hostname,
      default_pools: [desired.poolId],
      fallback_pool: desired.fallbackPoolId,
      enabled: desired.enabled,
      proxied: desired.proxied,
      steering_policy: desired.steering,
    };
    const endpoint = `/zones/${encodeURIComponent(zoneId)}/load_balancers${id ? `/${encodeURIComponent(id)}` : ''}`;
    let acknowledged: ManagedLoadBalancer;
    try {
      const response = await this.request<CloudflareManagedLoadBalancer>(id ? 'PUT' : 'POST', endpoint, body);
      acknowledged = this.mapManagedLoadBalancer(response.result);
      if (!acknowledged.id || (id && acknowledged.id !== id)) {
        throw new Error('Cloudflare returned an invalid public load-balancer identity after the write.');
      }
    } catch (error) {
      if (id || !this.loadBalancerCreateOutcomeMayBeUnknown(error)) throw error;
      const recovered = await this.recoverLoadBalancerCreateIdentity({
        label: `Cloudflare public load balancer "${desired.hostname}"`,
        find: () => this.findLoadBalancersByHostname(zoneId, desired.hostname),
      });
      if (!recovered) throw error;
      acknowledged = recovered;
    }
    return {
      ...(await this.verifyLoadBalancerWrite({
        label: `Cloudflare load balancer ${acknowledged.id}`,
        acknowledged,
        get: () => this.getLoadBalancer(zoneId, acknowledged.id),
        matches: (observed) => this.managedLoadBalancerMatches(observed, desired),
      })),
      created: !id,
    };
  }

  async deleteLoadBalancer(zoneId: string, id: string): Promise<void> {
    const endpoint = `/zones/${encodeURIComponent(zoneId)}/load_balancers/${encodeURIComponent(id)}`;
    try {
      await this.request<{ id: string }>('DELETE', endpoint);
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
    if (await this.getLoadBalancer(zoneId, id)) {
      throw new Error(`Cloudflare load balancer ${id} still exists after deletion.`);
    }
  }

  async searchRegistrarDomains(params: {
    accountId: string;
    query: string;
    extensions?: string[];
    limit?: number;
  }): Promise<RegistrarDomainCandidate[]> {
    const search = new URLSearchParams();
    search.set('q', params.query);
    if (params.limit !== undefined) {
      search.set('limit', String(params.limit));
    }
    for (const extension of params.extensions ?? []) {
      search.append('extensions', extension.replace(/^\./, ''));
    }

    const response = await this.request<{ domains: RegistrarDomainCandidate[] }>(
      'GET',
      `/accounts/${params.accountId}/registrar/domain-search?${search.toString()}`,
      undefined,
      this.registrarToken(params.query)
    );
    return response.result.domains;
  }

  async checkRegistrarDomains(accountId: string, domains: string[]): Promise<RegistrarDomainCandidate[]> {
    const registrarToken = this.registrarToken(domains[0]);
    const response = await this.request<{ domains: RegistrarDomainCandidate[] }>(
      'POST',
      `/accounts/${accountId}/registrar/domain-check`,
      { domains },
      registrarToken
    );
    return response.result.domains;
  }

  async createRegistrarRegistration(
    accountId: string,
    input: RegistrarRegistrationInput
  ): Promise<RegistrarWorkflowStatus> {
    const body: Record<string, unknown> = {
      domain_name: input.domainName,
    };
    if (input.autoRenew !== undefined) {
      body.auto_renew = input.autoRenew;
    }
    if (input.contacts) {
      body.contacts = input.contacts;
    }
    if (input.privacyMode) {
      body.privacy_mode = input.privacyMode;
    }
    if (input.years !== undefined) {
      body.years = input.years;
    }

    const response = await this.request<RegistrarWorkflowStatus>(
      'POST',
      `/accounts/${accountId}/registrar/registrations`,
      body,
      this.registrarToken(input.domainName)
    );
    return response.result;
  }

  async getRegistrarRegistrationStatus(accountId: string, domainName: string): Promise<RegistrarWorkflowStatus> {
    const response = await this.request<RegistrarWorkflowStatus>(
      'GET',
      `/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domainName)}/registration-status`,
      undefined,
      this.registrarToken(domainName)
    );
    return response.result;
  }

  async getEmailRoutingSettings(zoneId: string): Promise<CloudflareEmailRoutingSettings> {
    const response = await this.request<CloudflareEmailRoutingSettings>('GET', `/zones/${zoneId}/email/routing`);
    return response.result;
  }

  async getEmailRoutingDnsSettings(zoneId: string): Promise<CloudflareEmailRoutingDnsSettings> {
    const response = await this.request<CloudflareEmailRoutingDnsSettings>('GET', `/zones/${zoneId}/email/routing/dns`);
    return response.result;
  }

  async enableEmailRoutingDns(zoneId: string): Promise<CloudflareEmailRoutingDnsSettings> {
    const response = await this.request<CloudflareEmailRoutingDnsSettings>('POST', `/zones/${zoneId}/email/routing/dns`);
    return response.result;
  }

  async listEmailRoutingAddresses(accountId: string): Promise<CloudflareEmailRoutingAddress[]> {
    const addresses: CloudflareEmailRoutingAddress[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      if (page > CLOUDFLARE_PAGE_CAP) {
        throw new Error(`Cloudflare email-address pagination exceeded ${CLOUDFLARE_PAGE_CAP} pages.`);
      }
      const response = await this.request<CloudflareEmailRoutingAddress[]>(
        'GET',
        `/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=100`
      );
      if (!Array.isArray(response.result)) {
        throw new Error('Cloudflare email-address observation returned an invalid list.');
      }
      addresses.push(...response.result);
      hasMore = this.hasNextPage(
        response,
        page,
        100,
        'Cloudflare email-address'
      );
      page += 1;
    }

    return addresses;
  }

  async createEmailRoutingAddress(accountId: string, email: string): Promise<CloudflareEmailRoutingAddress> {
    const response = await this.request<CloudflareEmailRoutingAddress>(
      'POST',
      `/accounts/${accountId}/email/routing/addresses`,
      { email }
    );
    return response.result;
  }

  async deleteEmailRoutingAddress(accountId: string, addressId: string): Promise<{ id: string }> {
    const response = await this.request<{ id: string }>(
      'DELETE',
      `/accounts/${accountId}/email/routing/addresses/${addressId}`
    );
    return response.result;
  }

  async listEmailRoutingRules(zoneId: string): Promise<CloudflareEmailRoutingRule[]> {
    const rules: CloudflareEmailRoutingRule[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      if (page > CLOUDFLARE_PAGE_CAP) {
        throw new Error(`Cloudflare email-rule pagination exceeded ${CLOUDFLARE_PAGE_CAP} pages.`);
      }
      const response = await this.request<CloudflareEmailRoutingRule[]>(
        'GET',
        `/zones/${zoneId}/email/routing/rules?page=${page}&per_page=100`
      );
      if (!Array.isArray(response.result)) {
        throw new Error('Cloudflare email-rule observation returned an invalid list.');
      }
      rules.push(...response.result);
      hasMore = this.hasNextPage(response, page, 100, 'Cloudflare email-rule');
      page += 1;
    }

    return rules;
  }

  async createEmailRoutingRule(
    zoneId: string,
    rule: {
      name?: string;
      enabled?: boolean;
      actions: CloudflareEmailRoutingAction[];
      matchers: CloudflareEmailRoutingMatcher[];
      priority?: number;
    }
  ): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'POST',
      `/zones/${zoneId}/email/routing/rules`,
      rule as Record<string, unknown>
    );
    return response.result;
  }

  async updateEmailRoutingRule(
    zoneId: string,
    ruleId: string,
    rule: {
      name?: string;
      enabled?: boolean;
      actions: CloudflareEmailRoutingAction[];
      matchers: CloudflareEmailRoutingMatcher[];
      priority?: number;
    }
  ): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'PUT',
      `/zones/${zoneId}/email/routing/rules/${ruleId}`,
      rule as Record<string, unknown>
    );
    return response.result;
  }

  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<{ id: string }> {
    const response = await this.request<{ id: string }>(
      'DELETE',
      `/zones/${zoneId}/email/routing/rules/${ruleId}`
    );
    return response.result;
  }

  async getEmailRoutingCatchAll(zoneId: string): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'GET',
      `/zones/${zoneId}/email/routing/rules/catch_all`
    );
    return response.result;
  }

  async updateEmailRoutingCatchAll(
    zoneId: string,
    rule: {
      name?: string;
      enabled: boolean;
      actions: CloudflareEmailRoutingAction[];
      matchers: Array<{ type: 'all' }>;
    }
  ): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'PUT',
      `/zones/${zoneId}/email/routing/rules/catch_all`,
      rule as Record<string, unknown>
    );
    return response.result;
  }

  async listDnsRecords(zoneId: string, type?: string): Promise<CloudflareDnsRecord[]> {
    const records: CloudflareDnsRecord[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      if (page > CLOUDFLARE_PAGE_CAP) {
        throw new Error(`Cloudflare DNS-record pagination exceeded ${CLOUDFLARE_PAGE_CAP} pages.`);
      }
      const typeParam = type ? `&type=${encodeURIComponent(type)}` : '';
      const response = await this.request<CloudflareDnsRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?page=${page}&per_page=100${typeParam}`
      );
      if (!Array.isArray(response.result)) {
        throw new Error('Cloudflare DNS-record observation returned an invalid list.');
      }
      records.push(...response.result);
      hasMore = this.hasNextPage(response, page, 100, 'Cloudflare DNS-record');
      page += 1;
    }

    return records;
  }

  async createDnsRecord(zoneId: string, record: CreateDnsRecordInput): Promise<CloudflareDnsRecord> {
    const body: Record<string, unknown> = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1, // 1 = automatic
      proxied: record.proxied ?? false,
    };

    if (record.priority !== undefined) {
      body.priority = record.priority;
    }

    if (record.data) {
      body.data = record.data;
    }

    const response = await this.request<CloudflareDnsRecord>('POST', `/zones/${zoneId}/dns_records`, body);
    return response.result;
  }

  async updateDnsRecord(zoneId: string, recordId: string, updates: UpdateDnsRecordInput): Promise<CloudflareDnsRecord> {
    const response = await this.request<CloudflareDnsRecord>(
      'PATCH',
      `/zones/${zoneId}/dns_records/${recordId}`,
      updates as Record<string, unknown>
    );
    return response.result;
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    let deleted = { id: recordId };
    try {
      const response = await this.request<{ id: string }>('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
      deleted = response.result;
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
    if ((await this.listDnsRecords(zoneId)).some((record) => record.id === recordId)) {
      throw new Error(`Cloudflare DNS record ${recordId} still exists after deletion.`);
    }
    return deleted;
  }

  private dnsRecordMatchesName(
    record: CloudflareDnsRecord,
    desiredName: string,
    fallbackZoneName?: string
  ): boolean {
    const zoneName = record.zone_name || fallbackZoneName;
    return canonicalDnsName(record.name, zoneName) === canonicalDnsName(desiredName, zoneName);
  }

  private async findDnsRecordByName(
    zoneId: string,
    records: CloudflareDnsRecord[],
    desiredName: string
  ): Promise<CloudflareDnsRecord | undefined> {
    const knownZoneName = records.find((record) => record.zone_name)?.zone_name;
    const zoneName = records.some((record) => !record.zone_name)
      ? knownZoneName ?? (
          await this.request<CloudflareZone>('GET', `/zones/${encodeURIComponent(zoneId)}`)
        ).result.name
      : undefined;
    const matches = records.filter((record) => this.dnsRecordMatchesName(record, desiredName, zoneName));
    if (matches.length > 1) {
      throw new Error(`Multiple Cloudflare ${matches[0]!.type} records match ${desiredName}; resolve duplicate DNS identities before applying.`);
    }
    return matches[0];
  }

  private dnsRecordNeedsUpdate(
    record: CloudflareDnsRecord,
    type: string,
    content: string,
    options?: { ttl?: number; proxied?: boolean; priority?: number }
  ): boolean {
    if (normalizeDnsContent(type, record.content) !== normalizeDnsContent(type, content)) {
      return true;
    }
    if (options?.ttl !== undefined && record.ttl !== options.ttl) {
      return true;
    }
    if (options?.proxied !== undefined && record.proxied !== options.proxied) {
      return true;
    }
    if (options?.priority !== undefined && record.priority !== options.priority) {
      return true;
    }
    return false;
  }

  private async finishDnsRecordUpsert(
    zoneId: string,
    existing: CloudflareDnsRecord,
    type: string,
    content: string,
    options?: { ttl?: number; proxied?: boolean; priority?: number }
  ): Promise<{ record: CloudflareDnsRecord; action: 'updated' }> {
    if (!this.dnsRecordNeedsUpdate(existing, type, content, options)) {
      return { record: existing, action: 'updated' };
    }

    const updated = await this.updateDnsRecord(zoneId, existing.id, {
      content,
      ttl: options?.ttl,
      proxied: options?.proxied,
      priority: options?.priority,
    });
    return { record: updated, action: 'updated' };
  }

  async upsertDnsRecord(
    zoneId: string,
    name: string,
    type: string,
    content: string,
    options?: { ttl?: number; proxied?: boolean; priority?: number }
  ): Promise<{ record: CloudflareDnsRecord; action: 'created' | 'updated' }> {
    // Find existing record by name and type
    const records = await this.listDnsRecords(zoneId, type);
    const existing = await this.findDnsRecordByName(zoneId, records, name);

    if (existing) {
      return this.finishDnsRecordUpsert(zoneId, existing, type, content, options);
    }

    try {
      const created = await this.createDnsRecord(zoneId, {
        type,
        name,
        content,
        ttl: options?.ttl,
        proxied: options?.proxied,
        priority: options?.priority,
      });
      return { record: created, action: 'created' };
    } catch (error) {
      if (!isDuplicateDnsRecordError(error)) {
        throw error;
      }

      const refreshed = await this.listDnsRecords(zoneId, type);
      const recovered = await this.findDnsRecordByName(zoneId, refreshed, name);
      if (!recovered) {
        throw error;
      }
      return this.finishDnsRecordUpsert(zoneId, recovered, type, content, options);
    }
  }

  /**
   * Ensure a set of DNS records exist for a name+type combination.
   * Creates missing records, deletes extra records, leaves matching records unchanged.
   * Useful for multi-value records like GitHub Pages A records.
   */
  async ensureRecords(
    zoneId: string,
    name: string,
    type: string,
    contents: string[],
    options?: { ttl?: number; proxied?: boolean; pruneExtras?: boolean }
  ): Promise<{
    created: string[];
    deleted: string[];
    unchanged: string[];
    records: CloudflareDnsRecord[];
  }> {
    // Get existing records for this name+type
    const allRecords = await this.listDnsRecords(zoneId, type);
    const existingRecords = allRecords.filter(
      (r) => r.name === name || r.name === `${name}.${r.zone_name}`
    );

    const existingContents = new Set(existingRecords.map((r) => r.content));
    const desiredContents = new Set(contents);

    const created: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    // Create missing records
    for (const content of contents) {
      if (!existingContents.has(content)) {
        try {
          await this.createDnsRecord(zoneId, {
            type,
            name,
            content,
            ttl: options?.ttl,
            proxied: options?.proxied,
          });
          created.push(content);
        } catch (error) {
          // Handle race condition where record was created between list and create
          if (error instanceof Error && error.message.includes('already exists')) {
            unchanged.push(content);
          } else {
            throw error;
          }
        }
      } else {
        unchanged.push(content);
      }
    }

    // Delete extras only when the caller explicitly owns the complete set.
    if (options?.pruneExtras !== false) {
      for (const record of existingRecords) {
        if (!desiredContents.has(record.content)) {
          await this.deleteDnsRecord(zoneId, record.id);
          deleted.push(record.content);
        }
      }
    }

    const refreshed = (await this.listDnsRecords(zoneId, type)).filter(
      (record) => record.name === name || record.name === `${name}.${record.zone_name}`
    );
    const records: CloudflareDnsRecord[] = [];
    for (const content of desiredContents) {
      const matches = refreshed.filter((record) => record.content === content);
      if (matches.length !== 1) {
        throw new Error(`Cloudflare returned ${matches.length} ${type} records for ${name} with desired value ${content}; refusing an ambiguous record-set binding.`);
      }
      const current = matches[0]!;
      const reconciled = this.dnsRecordNeedsUpdate(current, type, content, options)
        ? await this.updateDnsRecord(zoneId, current.id, {
            content,
            ttl: options?.ttl,
            proxied: options?.proxied,
          })
        : current;
      records.push(reconciled);
    }

    return { created, deleted, unchanged, records };
  }

  // IDnsProvider interface methods (wrapping Cloudflare-specific methods)

  async listRecords(zoneId: string, type?: string): Promise<DnsRecord[]> {
    const records = await this.listDnsRecords(zoneId, type);
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      priority: r.priority,
    }));
  }

  async createRecord(zoneId: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    const created = await this.createDnsRecord(zoneId, record);
    return {
      id: created.id,
      name: created.name,
      type: created.type,
      content: created.content,
      ttl: created.ttl,
      proxied: created.proxied,
      priority: created.priority,
    };
  }

  async updateRecord(zoneId: string, recordId: string, updates: Partial<DnsRecord>): Promise<DnsRecord> {
    const updated = await this.updateDnsRecord(zoneId, recordId, updates);
    return {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      content: updated.content,
      ttl: updated.ttl,
      proxied: updated.proxied,
      priority: updated.priority,
    };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.deleteDnsRecord(zoneId, recordId);
  }

  async upsertRecord(
    zoneId: string,
    name: string,
    type: string,
    content: string,
    options?: Partial<DnsRecord>
  ): Promise<{ record: DnsRecord; action: 'created' | 'updated' }> {
    const result = await this.upsertDnsRecord(zoneId, name, type, content, options);
    return {
      record: {
        id: result.record.id,
        name: result.record.name,
        type: result.record.type,
        content: result.record.content,
        ttl: result.record.ttl,
        proxied: result.record.proxied,
        priority: result.record.priority,
      },
      action: result.action,
    };
  }
}

async function inspectCloudflareResources(
  adapter: CloudflareAdapter,
  request: ProviderInspectionRequest
): Promise<Record<string, unknown>> {
  const resource = request.resource ?? 'zone';
  if (resource === 'account') {
    const accounts = await adapter.listAccounts();
    const truncated = accounts.length > request.limit;
    return {
      observation: accounts.length > 0 ? 'present' : 'absent',
      resource,
      accounts: accounts.slice(0, request.limit),
      truncated,
      partial: truncated,
    };
  }

  const zoneName = request.scope?.trim() || (resource === 'zone' ? request.name?.trim() : undefined);
  if (resource === 'zone' && !request.id && !zoneName) {
    const zones = await adapter.listZones();
    return {
      observation: zones.length > 0 ? 'present' : 'absent',
      resource,
      zones: zones.slice(0, request.limit),
      truncated: zones.length > request.limit,
      partial: zones.length > request.limit,
    };
  }
  const zone = resource === 'zone' && request.id
    ? (await adapter.listZones()).find((candidate) => candidate.id === request.id) ?? null
    : zoneName
      ? await adapter.findZoneByName(zoneName)
      : null;
  if (!zone) {
    return {
      observation: 'absent',
      resource: 'zone',
      zones: [],
      ...(request.id ? { id: request.id } : { name: zoneName }),
      truncated: false,
      partial: false,
    };
  }
  if (resource === 'zone') {
    return { observation: 'present', resource, zone, zones: [zone], truncated: false, partial: false };
  }
  if (resource === 'dns') {
    const records = await adapter.listDnsRecords(zone.id);
    const filtered = request.id
      ? records.filter((record) => record.id === request.id)
      : request.name
        ? records.filter((record) => record.name.toLowerCase() === request.name!.toLowerCase())
        : records;
    return {
      observation: filtered.length > 0 ? 'present' : 'absent',
      resource,
      zone: { id: zone.id, name: zone.name },
      records: filtered.slice(0, request.limit),
      ...(filtered.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: filtered.length > request.limit,
      partial: filtered.length > request.limit,
    };
  }
  if (resource === 'email-routing') {
    const [settings, dns, rules] = await Promise.all([
      adapter.getEmailRoutingSettings(zone.id),
      adapter.getEmailRoutingDnsSettings(zone.id),
      adapter.listEmailRoutingRules(zone.id),
    ]);
    const truncated = rules.length > request.limit;
    return {
      observation: 'present',
      resource,
      zone: { id: zone.id, name: zone.name },
      settings,
      dns,
      rules: rules.slice(0, request.limit),
      truncated,
      partial: truncated,
    };
  }
  throw new Error(`Unsupported Cloudflare inspection resource "${resource}".`);
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudflare',
    displayName: 'Cloudflare',
    category: 'dns',
    credentialsSchema: CloudflareCredentialsSchema,
    setupHelpUrl: CLOUDFLARE_USER_TOKEN_URL,
    credentials: {
      defaultScalarKey: 'apiToken',
      localEnvInputs: [
        {
          envKey: 'CLOUDFLARE_API_TOKEN',
          credentialKeys: ['apiToken'],
          comment: 'Cloudflare API token for DNS, custom-domain, and account automation',
        },
        {
          envKey: 'CLOUDFLARE_ACCOUNT_ID',
          credentialKeys: ['accountId'],
          comment: 'Cloudflare account ID required when the API token is account-owned',
        },
        {
          envKey: 'CLOUDFLARE_REGISTRAR_API_TOKEN',
          credentialKeys: ['registrarApiToken'],
          comment: 'Cloudflare User API Token with Registrar write permission for domain purchases',
        },
      ],
    },
    maturity: {
      lifecycle: {
        'load-balancer': {
          status: 'ready-for-live',
          reason: 'Mocked monitor/pool/load-balancer lifecycle is complete; the opt-in live contract has no recorded evidence.',
        },
      },
    },
    lifecycle: {
      loadBalancer: {
        topology: 'monitor-pool-balancer',
        minimumOrigins: 2,
      },
    },
  },
  factory: (credentials) => {
    const adapter = new CloudflareAdapter();
    adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['zone', 'dns', 'account', 'email-routing'],
    defaultResource: 'zone',
    selectors: {
      zone: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, collectionKey: 'zones' },
      dns: { mode: 'provider-resource', required: ['scope'], optional: ['project', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, collectionKey: 'records' },
      account: { mode: 'provider-resource', optional: ['project', 'scope', 'limit'], list: true, collectionKey: 'accounts' },
      'email-routing': { mode: 'provider-resource', required: ['scope'], optional: ['project', 'limit'], list: true },
    },
    inspect: (adapter, request) => inspectCloudflareResources(adapter as CloudflareAdapter, request),
  },
});
