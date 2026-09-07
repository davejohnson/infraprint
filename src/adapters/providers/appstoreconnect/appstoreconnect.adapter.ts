import { z } from 'zod';
import { createSign, createPrivateKey } from 'crypto';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for App Store Connect API
export const AppStoreConnectCredentialsSchema = z.object({
  keyId: z.string().min(1, 'Key ID is required'),
  issuerId: z.string().min(1, 'Issuer ID is required'),
  privateKey: z.string().min(1, 'Private key (p8 contents) is required'),
});

export type AppStoreConnectCredentials = z.infer<typeof AppStoreConnectCredentialsSchema>;

export interface AppStoreConnectBuild {
  id: string;
  version: string;
  buildNumber: string;
  processingState: string;
  usesNonExemptEncryption: boolean | null;
  uploadedDate: string;
  appId: string;
}

export interface AppStoreBetaTester {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  inviteType?: string;
  state?: string;
}

export interface AppStoreBetaGroup {
  id: string;
  name: string;
  isInternal: boolean;
  hasAccessToAllBuilds?: boolean;
  publicLinkEnabled?: boolean;
  publicLink?: string;
  publicLinkLimit?: number;
  feedbackEnabled?: boolean;
}

export interface AppStoreVersion {
  id: string;
  versionString: string;
  appStoreState: string;
  platform: string;
}

export interface ReviewSubmission {
  id: string;
  state: string;
  platform: string;
}

export interface AppStoreVersionLocalization {
  id: string;
  locale: string;
  description?: string;
  keywords?: string;
  promotionalText?: string;
  marketingUrl?: string;
  supportUrl?: string;
  whatsNew?: string;
}

export interface AppScreenshotSet {
  id: string;
  screenshotDisplayType: string;
}

export interface AppScreenshot {
  id: string;
  fileName?: string;
  assetDeliveryState?: { state?: string; errors?: Array<{ code?: string; detail?: string }> };
}

const APP_STORE_CONNECT_API = 'https://api.appstoreconnect.apple.com/v1';
const APP_STORE_CONNECT_PAGE_LIMIT = 200;
const MAX_APP_STORE_CONNECT_PAGES = 1_000;

const paginationLinksSchema = z.object({
  next: z.string().url().nullable().optional(),
}).passthrough();

const betaGroupResourceSchema = z.object({
  id: z.string().min(1),
  attributes: z.object({
    name: z.string().min(1),
    isInternalGroup: z.boolean(),
    hasAccessToAllBuilds: z.boolean().nullable().optional(),
    publicLinkEnabled: z.boolean().nullable().optional(),
    publicLink: z.string().nullable().optional(),
    publicLinkLimit: z.number().int().nullable().optional(),
    feedbackEnabled: z.boolean().nullable().optional(),
  }).passthrough(),
}).passthrough();

const betaGroupListResponseSchema = z.object({
  data: z.array(betaGroupResourceSchema),
  links: paginationLinksSchema.optional(),
}).passthrough();

const betaGroupResponseSchema = z.object({
  data: betaGroupResourceSchema,
}).passthrough();

const bundleIdResourceSchema = z.object({
  id: z.string().min(1),
  attributes: z.object({
    identifier: z.string().min(1),
    name: z.string().min(1),
    platform: z.string().min(1),
  }).passthrough(),
}).passthrough();

const bundleIdListResponseSchema = z.object({
  data: z.array(bundleIdResourceSchema),
  links: paginationLinksSchema.optional(),
}).passthrough();

const reviewSubmissionResourceSchema = z.object({
  id: z.string().min(1),
  attributes: z.object({
    state: z.string().min(1),
    platform: z.string().min(1),
  }).passthrough(),
}).passthrough();

const reviewSubmissionListResponseSchema = z.object({
  data: z.array(reviewSubmissionResourceSchema),
  links: paginationLinksSchema.optional(),
}).passthrough();

const reviewSubmissionResponseSchema = z.object({
  data: reviewSubmissionResourceSchema,
}).passthrough();

function malformedResponse(context: string): Error {
  return new Error(
    `App Store Connect returned a malformed ${context} response; provider state is unknown.`
  );
}

function requireUniqueResourceIds<T extends { id: string }>(resources: T[], context: string): T[] {
  const seen = new Set<string>();
  for (const resource of resources) {
    if (seen.has(resource.id)) {
      throw new Error(
        `App Store Connect returned duplicate ${context} identity ${resource.id}; provider state is unknown.`
      );
    }
    seen.add(resource.id);
  }
  return resources;
}

function mapBetaGroup(resource: z.infer<typeof betaGroupResourceSchema>): AppStoreBetaGroup {
  return {
    id: resource.id,
    name: resource.attributes.name,
    isInternal: resource.attributes.isInternalGroup,
    hasAccessToAllBuilds: resource.attributes.hasAccessToAllBuilds ?? undefined,
    publicLinkEnabled: resource.attributes.publicLinkEnabled ?? undefined,
    publicLink: resource.attributes.publicLink ?? undefined,
    publicLinkLimit: resource.attributes.publicLinkLimit ?? undefined,
    feedbackEnabled: resource.attributes.feedbackEnabled ?? undefined,
  };
}

function mapBundleId(resource: z.infer<typeof bundleIdResourceSchema>): {
  id: string;
  identifier: string;
  name: string;
  platform: string;
} {
  return {
    id: resource.id,
    identifier: resource.attributes.identifier,
    name: resource.attributes.name,
    platform: resource.attributes.platform,
  };
}

function mapReviewSubmission(resource: z.infer<typeof reviewSubmissionResourceSchema>): ReviewSubmission {
  return {
    id: resource.id,
    state: resource.attributes.state,
    platform: resource.attributes.platform,
  };
}

export class AppStoreConnectAdapter {
  private credentials: AppStoreConnectCredentials | null = null;

  connect(credentials: AppStoreConnectCredentials): void {
    this.credentials = credentials;
  }

  // ---------------------------------------------------------------------------
  // App Store Connect API - Authentication
  // ---------------------------------------------------------------------------

  /**
   * Generate a JWT for App Store Connect API authentication.
   */
  private generateJwt(): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'ES256',
      kid: this.credentials.keyId,
      typ: 'JWT',
    };
    const payload = {
      iss: this.credentials.issuerId,
      iat: now,
      exp: now + 1200, // 20 minutes
      aud: 'appstoreconnect-v1',
    };

    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');

    const headerB64 = encode(header);
    const payloadB64 = encode(payload);
    const signingInput = `${headerB64}.${payloadB64}`;

    // Normalize the private key format
    let keyPem = this.credentials.privateKey;
    if (!keyPem.includes('-----BEGIN')) {
      keyPem = `-----BEGIN PRIVATE KEY-----\n${keyPem}\n-----END PRIVATE KEY-----`;
    }

    const privateKey = createPrivateKey(keyPem);
    const sign = createSign('SHA256');
    sign.update(signingInput);

    // ES256 produces a DER-encoded signature; we need raw r||s for JWT
    const derSig = sign.sign(privateKey);
    const rawSig = derToRaw(derSig);
    const signatureB64 = rawSig.toString('base64url');

    return `${signingInput}.${signatureB64}`;
  }

  /**
   * Make an authenticated request to the App Store Connect API.
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const jwt = this.generateJwt();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const url = path.startsWith('http') ? path : `${APP_STORE_CONNECT_API}${path}`;
    const response = await fetch(url, options);

    if (!response.ok) {
      let errorMessage = `App Store Connect API error: ${response.status}`;
      try {
        const errorBody = await response.json() as { errors?: Array<{ detail?: string }> };
        if (errorBody.errors?.[0]?.detail) {
          errorMessage = `App Store Connect API: ${errorBody.errors[0].detail}`;
        }
      } catch { /* ignore */ }
      throw new Error(errorMessage);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch every page before treating a missing resource as absent. App Store
   * Connect returns absolute next links; only follow links back to its v1 API
   * and fail if the provider repeats a page or returns an unbounded sequence.
   */
  private async collectPages<T>(
    initialPath: string,
    context: string,
    parsePage: (response: unknown) => { data: T[]; next?: string | null },
  ): Promise<T[]> {
    const results: T[] = [];
    const seen = new Set<string>();
    const expectedPathname = new URL(this.canonicalPageUrl(initialPath, context)).pathname;
    let path: string | null = initialPath;

    while (path) {
      const canonical = this.canonicalPageUrl(path, context);
      if (new URL(canonical).pathname !== expectedPathname) {
        throw new Error(
          `App Store Connect ${context} pagination changed collection identity; provider state is unknown.`
        );
      }
      if (seen.has(canonical)) {
        throw new Error(
          `App Store Connect ${context} pagination repeated a page; provider state is unknown.`
        );
      }
      if (seen.size >= MAX_APP_STORE_CONNECT_PAGES) {
        throw new Error(
          `App Store Connect ${context} pagination exceeded ${MAX_APP_STORE_CONNECT_PAGES} pages; provider state is unknown.`
        );
      }
      seen.add(canonical);

      const page = parsePage(await this.apiRequest<unknown>('GET', path));
      results.push(...page.data);
      path = page.next ?? null;
    }

    return results;
  }

  private canonicalPageUrl(path: string, context: string): string {
    let url: URL;
    try {
      url = path.startsWith('http://') || path.startsWith('https://')
        ? new URL(path)
        : new URL(`${APP_STORE_CONNECT_API}${path.startsWith('/') ? path : `/${path}`}`);
    } catch {
      throw malformedResponse(`${context} pagination link`);
    }

    const api = new URL(APP_STORE_CONNECT_API);
    if (
      url.origin !== api.origin
      || (url.pathname !== api.pathname && !url.pathname.startsWith(`${api.pathname}/`))
      || url.username
      || url.password
      || url.hash
    ) {
      throw new Error(
        `App Store Connect returned an unsafe ${context} pagination link; provider state is unknown.`
      );
    }
    url.searchParams.sort();
    return url.toString();
  }

  /**
   * Verify the API key works by listing bundle IDs.
   */
  async verify(): Promise<{ success: boolean; error?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'No credentials to verify' };
    }

    try {
      await this.listBundleIds();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Builds
  // ---------------------------------------------------------------------------

  /** List recent builds, optionally filtered by App Store Connect app ID. */
  async listBuilds(options?: {
    appId?: string;
    limit?: number;
  }): Promise<AppStoreConnectBuild[]> {
    const limit = options?.limit ?? 10;
    const params = new URLSearchParams();
    params.set('sort', '-uploadedDate');
    params.set('limit', String(limit));
    params.set('fields[builds]', 'version,uploadedDate,processingState,usesNonExemptEncryption,buildAudienceType');
    params.set('fields[preReleaseVersions]', 'version');
    params.set('include', 'preReleaseVersion,app');

    if (options?.appId) {
      params.set('filter[app]', options.appId);
    }

    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          version: string;
          uploadedDate: string;
          processingState: string;
          usesNonExemptEncryption: boolean | null;
        };
        relationships?: {
          preReleaseVersion?: { data?: { id: string } };
          app?: { data?: { id: string } };
        };
      }>;
      included?: Array<{
        type: string;
        id: string;
        attributes: { version?: string; bundleId?: string };
      }>;
    }>('GET', `/builds?${params.toString()}`);

    const preReleaseVersions = new Map(
      (result.included ?? [])
        .filter(i => i.type === 'preReleaseVersions')
        .map(i => [i.id, i.attributes.version ?? ''])
    );

    return result.data.slice(0, limit).map(build => ({
      id: build.id,
      version: preReleaseVersions.get(build.relationships?.preReleaseVersion?.data?.id ?? '') ?? '',
      buildNumber: build.attributes.version,
      processingState: build.attributes.processingState,
      usesNonExemptEncryption: build.attributes.usesNonExemptEncryption,
      uploadedDate: build.attributes.uploadedDate,
      appId: build.relationships?.app?.data?.id ?? '',
    }));
  }

  /**
   * List beta groups for an app.
   */
  async listBetaGroups(appId: string): Promise<AppStoreBetaGroup[]> {
    const params = new URLSearchParams({
      limit: String(APP_STORE_CONNECT_PAGE_LIMIT),
      'fields[betaGroups]': 'name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLink,publicLinkLimit,feedbackEnabled',
    });
    const resources = await this.collectPages(
      `/apps/${encodeURIComponent(appId)}/betaGroups?${params.toString()}`,
      'beta-group list',
      (raw) => {
        const parsed = betaGroupListResponseSchema.safeParse(raw);
        if (!parsed.success) throw malformedResponse('beta-group list');
        return { data: parsed.data.data, next: parsed.data.links?.next };
      }
    );
    return requireUniqueResourceIds(resources, 'beta-group').map(mapBetaGroup);
  }

  async findBetaGroupByName(appId: string, name: string): Promise<AppStoreBetaGroup | null> {
    const groups = await this.listBetaGroups(appId);
    const normalized = name.toLowerCase();
    const matches = groups.filter((group) => group.name.toLowerCase() === normalized);
    if (matches.length > 1) {
      throw new Error(
        `Multiple TestFlight beta groups named "${name}" exist for app ${appId}; make the group name unique in App Store Connect before retrying.`
      );
    }
    return matches[0] ?? null;
  }

  async createBetaGroup(input: {
    appId: string;
    name: string;
    isInternal?: boolean;
    hasAccessToAllBuilds?: boolean;
    feedbackEnabled?: boolean;
    publicLinkEnabled?: boolean;
    publicLinkLimit?: number;
  }): Promise<AppStoreBetaGroup> {
    const attributes: Record<string, unknown> = {
      name: input.name,
      isInternalGroup: input.isInternal ?? false,
    };

    if (input.hasAccessToAllBuilds !== undefined) attributes.hasAccessToAllBuilds = input.hasAccessToAllBuilds;
    if (input.feedbackEnabled !== undefined) attributes.feedbackEnabled = input.feedbackEnabled;
    if (input.publicLinkEnabled !== undefined) attributes.publicLinkEnabled = input.publicLinkEnabled;
    if (input.publicLinkLimit !== undefined) {
      attributes.publicLinkLimitEnabled = true;
      attributes.publicLinkLimit = input.publicLinkLimit;
    }

    const raw = await this.apiRequest<unknown>('POST', '/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes,
        relationships: {
          app: {
            data: { type: 'apps', id: input.appId },
          },
        },
      },
    });
    const response = betaGroupResponseSchema.safeParse(raw);
    if (!response.success) throw malformedResponse('beta-group creation');
    const group = mapBetaGroup(response.data.data);
    const expectedInternal = input.isInternal ?? false;
    if (group.name !== input.name || group.isInternal !== expectedInternal) {
      throw new Error(
        `App Store Connect acknowledged beta-group creation as ${group.id}, but returned a different name or group type; creation outcome is unknown.`
      );
    }
    return group;
  }

  async updateBetaGroup(groupId: string, attrs: {
    hasAccessToAllBuilds?: boolean;
    feedbackEnabled?: boolean;
    publicLinkEnabled?: boolean;
    publicLinkLimit?: number;
  }): Promise<AppStoreBetaGroup> {
    const attributes: Record<string, unknown> = {};
    if (attrs.hasAccessToAllBuilds !== undefined) attributes.hasAccessToAllBuilds = attrs.hasAccessToAllBuilds;
    if (attrs.feedbackEnabled !== undefined) attributes.feedbackEnabled = attrs.feedbackEnabled;
    if (attrs.publicLinkEnabled !== undefined) attributes.publicLinkEnabled = attrs.publicLinkEnabled;
    if (attrs.publicLinkLimit !== undefined) {
      attributes.publicLinkLimitEnabled = true;
      attributes.publicLinkLimit = attrs.publicLinkLimit;
    }

    const response = await this.apiRequest<{
      data: {
        id: string;
        attributes: {
          name: string;
          isInternalGroup: boolean;
          hasAccessToAllBuilds?: boolean;
          publicLinkEnabled?: boolean;
          publicLink?: string;
          publicLinkLimit?: number;
          feedbackEnabled?: boolean;
        };
      };
    }>('PATCH', `/betaGroups/${groupId}`, {
      data: {
        type: 'betaGroups',
        id: groupId,
        attributes,
      },
    });

    return {
      id: response.data.id,
      name: response.data.attributes.name,
      isInternal: response.data.attributes.isInternalGroup,
      hasAccessToAllBuilds: response.data.attributes.hasAccessToAllBuilds,
      publicLinkEnabled: response.data.attributes.publicLinkEnabled,
      publicLink: response.data.attributes.publicLink,
      publicLinkLimit: response.data.attributes.publicLinkLimit,
      feedbackEnabled: response.data.attributes.feedbackEnabled,
    };
  }

  async getOrCreateBetaGroup(input: {
    appId: string;
    name: string;
    isInternal?: boolean;
    hasAccessToAllBuilds?: boolean;
    feedbackEnabled?: boolean;
    publicLinkEnabled?: boolean;
    publicLinkLimit?: number;
  }): Promise<{ group: AppStoreBetaGroup; created: boolean }> {
    const existing = await this.findBetaGroupByName(input.appId, input.name);
    if (existing) {
      return { group: existing, created: false };
    }
    const group = await this.createBetaGroup(input);
    return { group, created: true };
  }

  async listBetaTesters(options?: {
    email?: string;
    appId?: string;
    groupId?: string;
    limit?: number;
  }): Promise<AppStoreBetaTester[]> {
    const limit = options?.limit ?? 200;
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('fields[betaTesters]', 'firstName,lastName,email,inviteType,state');
    if (options?.email && !options?.groupId) {
      params.set('filter[email]', options.email);
    }
    if (options?.appId) {
      params.set('filter[apps]', options.appId);
    }

    const path = options?.groupId
      ? `/betaGroups/${options.groupId}/betaTesters?${params.toString()}`
      : `/betaTesters?${params.toString()}`;
    const response = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          firstName?: string;
          lastName?: string;
          email?: string;
          inviteType?: string;
          state?: string;
        };
      }>;
    }>('GET', path);

    const testers = response.data.map((tester) => ({
      id: tester.id,
      firstName: tester.attributes.firstName,
      lastName: tester.attributes.lastName,
      email: tester.attributes.email,
      inviteType: tester.attributes.inviteType,
      state: tester.attributes.state,
    }));

    const selected = options?.email && options.groupId
      ? testers.filter((tester) => tester.email?.toLowerCase() === options.email!.toLowerCase())
      : testers;
    return selected.slice(0, limit);
  }

  async findBetaTesterByEmail(email: string): Promise<AppStoreBetaTester | null> {
    const testers = await this.listBetaTesters({ email, limit: 10 });
    return testers.find((tester) => tester.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async createBetaTester(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    appIds?: string[];
    groupIds?: string[];
  }): Promise<AppStoreBetaTester> {
    const relationships: Record<string, unknown> = {};
    if (input.appIds?.length) {
      relationships.apps = {
        data: input.appIds.map((id) => ({ type: 'apps', id })),
      };
    }
    if (input.groupIds?.length) {
      relationships.betaGroups = {
        data: input.groupIds.map((id) => ({ type: 'betaGroups', id })),
      };
    }

    const response = await this.apiRequest<{
      data: {
        id: string;
        attributes: {
          firstName?: string;
          lastName?: string;
          email?: string;
          inviteType?: string;
          state?: string;
        };
      };
    }>('POST', '/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: {
          email: input.email,
          ...(input.firstName ? { firstName: input.firstName } : {}),
          ...(input.lastName ? { lastName: input.lastName } : {}),
        },
        ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
      },
    });

    return {
      id: response.data.id,
      firstName: response.data.attributes.firstName,
      lastName: response.data.attributes.lastName,
      email: response.data.attributes.email,
      inviteType: response.data.attributes.inviteType,
      state: response.data.attributes.state,
    };
  }

  async getOrCreateBetaTester(input: {
    email: string;
    firstName?: string;
    lastName?: string;
    appIds?: string[];
    groupIds?: string[];
  }): Promise<{ tester: AppStoreBetaTester; created: boolean }> {
    const existing = await this.findBetaTesterByEmail(input.email);
    if (existing) {
      return { tester: existing, created: false };
    }
    const tester = await this.createBetaTester(input);
    return { tester, created: true };
  }

  async addBetaTesterToBetaGroups(testerId: string, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.apiRequest('POST', `/betaTesters/${testerId}/relationships/betaGroups`, {
      data: groupIds.map((id) => ({ type: 'betaGroups', id })),
    });
  }

  // ---------------------------------------------------------------------------
  // Bundle IDs & Capabilities
  // ---------------------------------------------------------------------------

  /**
   * List all registered Bundle IDs (App IDs).
   */
  async listBundleIds(options?: { identifier?: string }): Promise<Array<{
    id: string;
    identifier: string;
    name: string;
    platform: string;
  }>> {
    const params = new URLSearchParams({
      limit: String(APP_STORE_CONNECT_PAGE_LIMIT),
      'fields[bundleIds]': 'identifier,name,platform',
    });
    if (options?.identifier) params.set('filter[identifier]', options.identifier);

    const resources = await this.collectPages(
      `/bundleIds?${params.toString()}`,
      'bundle-id list',
      (raw) => {
        const parsed = bundleIdListResponseSchema.safeParse(raw);
        if (!parsed.success) throw malformedResponse('bundle-id list');
        return { data: parsed.data.data, next: parsed.data.links?.next };
      }
    );
    return requireUniqueResourceIds(resources, 'bundle-id').map(mapBundleId);
  }

  /**
   * Find a Bundle ID by its identifier string (e.g., "com.example.app").
   */
  async findBundleIdByIdentifier(identifier: string): Promise<{ id: string; identifier: string; name: string; platform: string } | null> {
    const matches = (await this.listBundleIds({ identifier }))
      .filter((bundleId) => bundleId.identifier === identifier);
    if (matches.length > 1) {
      throw new Error(
        `Multiple App Store Connect Bundle ID resources use identifier "${identifier}"; make the identifier unique before retrying.`
      );
    }
    return matches[0] ?? null;
  }

  /**
   * Register a new Bundle ID (App ID).
   */
  async registerBundleId(
    identifier: string,
    name: string,
    platform: string = 'IOS',
  ): Promise<{ id: string; identifier: string; name: string; platform: string }> {
    const response = await this.apiRequest<{
      data: {
        id: string;
        attributes: { identifier: string; name: string; platform: string };
      };
    }>('POST', '/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: { identifier, name, platform },
      },
    });

    return {
      id: response.data.id,
      identifier: response.data.attributes.identifier,
      name: response.data.attributes.name,
      platform: response.data.attributes.platform,
    };
  }

  /**
   * Get capabilities enabled on a Bundle ID.
   */
  async getBundleIdCapabilities(bundleIdId: string): Promise<Array<{ id: string; type: string }>> {
    const response = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { capabilityType: string };
      }>;
    }>('GET', `/bundleIds/${bundleIdId}/bundleIdCapabilities`);

    return response.data.map(c => ({
      id: c.id,
      type: c.attributes.capabilityType,
    }));
  }

  /**
   * Enable capabilities on a Bundle ID. Skips already-enabled ones.
   */
  async enableCapabilities(
    bundleIdId: string,
    capabilityTypes: string[],
  ): Promise<{ enabled: string[]; alreadyEnabled: string[]; errors: Array<{ type: string; error: string }> }> {
    const existing = await this.getBundleIdCapabilities(bundleIdId);
    const existingTypes = new Set(existing.map(c => c.type));

    const enabled: string[] = [];
    const alreadyEnabled: string[] = [];
    const errors: Array<{ type: string; error: string }> = [];

    for (const capType of capabilityTypes) {
      if (existingTypes.has(capType)) {
        alreadyEnabled.push(capType);
        continue;
      }
      try {
        await this.apiRequest('POST', '/bundleIdCapabilities', {
          data: {
            type: 'bundleIdCapabilities',
            attributes: { capabilityType: capType },
            relationships: {
              bundleId: {
                data: { type: 'bundleIds', id: bundleIdId },
              },
            },
          },
        });
        enabled.push(capType);
      } catch (error) {
        errors.push({ type: capType, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { enabled, alreadyEnabled, errors };
  }

  // ---------------------------------------------------------------------------
  // Apps
  // ---------------------------------------------------------------------------

  /**
   * List apps.
   */
  async listApps(): Promise<Array<{ id: string; bundleId: string; name: string }>> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { bundleId: string; name: string };
      }>;
    }>('GET', '/apps?limit=200&fields[apps]=bundleId,name');

    return result.data.map(app => ({
      id: app.id,
      bundleId: app.attributes.bundleId,
      name: app.attributes.name,
    }));
  }

  /**
   * Find an app by bundle ID.
   */
  async findAppByBundleId(bundleId: string): Promise<{ id: string; bundleId: string; name: string } | null> {
    const apps = await this.listApps();
    return apps.find(a => a.bundleId === bundleId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // App Store Versions & Submission
  // ---------------------------------------------------------------------------

  /**
   * List App Store versions for an app.
   */
  async listAppStoreVersions(
    appId: string,
    options?: { platform?: 'IOS' | 'MAC_OS' | 'TV_OS'; limit?: number }
  ): Promise<AppStoreVersion[]> {
    const limit = options?.limit ?? 10;
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('fields[appStoreVersions]', 'versionString,appStoreState,platform');
    if (options?.platform) {
      params.set('filter[platform]', options.platform);
    }

    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          versionString: string;
          appStoreState: string;
          platform: string;
        };
      }>;
    }>('GET', `/apps/${appId}/appStoreVersions?${params.toString()}`);

    return result.data.slice(0, limit).map(v => ({
      id: v.id,
      versionString: v.attributes.versionString,
      appStoreState: v.attributes.appStoreState,
      platform: v.attributes.platform,
    }));
  }

  /**
   * Get the latest editable App Store version for an app.
   * Returns versions in states that can be submitted (PREPARE_FOR_SUBMISSION, etc.)
   */
  async getEditableAppStoreVersion(
    appId: string,
    platform?: 'IOS' | 'MAC_OS' | 'TV_OS'
  ): Promise<AppStoreVersion | null> {
    const versions = await this.listAppStoreVersions(appId, { platform, limit: 10 });

    // Editable states
    const editableStates = [
      'PREPARE_FOR_SUBMISSION',
      'DEVELOPER_REJECTED',
      'REJECTED',
      'METADATA_REJECTED',
      'INVALID_BINARY',
    ];

    return versions.find(v => editableStates.includes(v.appStoreState)) ?? null;
  }

  /**
   * List review submissions for an app, optionally filtered by platform and state.
   */
  async listReviewSubmissions(
    appId: string,
    options?: { platform?: string; states?: string[] }
  ): Promise<ReviewSubmission[]> {
    const params = new URLSearchParams();
    params.set('limit', String(APP_STORE_CONNECT_PAGE_LIMIT));
    params.set('fields[reviewSubmissions]', 'state,platform');
    if (options?.platform) {
      params.set('filter[platform]', options.platform);
    }
    if (options?.states?.length) {
      params.set('filter[state]', options.states.join(','));
    }

    const resources = await this.collectPages(
      `/apps/${encodeURIComponent(appId)}/reviewSubmissions?${params.toString()}`,
      'review-submission list',
      (raw) => {
        const parsed = reviewSubmissionListResponseSchema.safeParse(raw);
        if (!parsed.success) throw malformedResponse('review-submission list');
        return { data: parsed.data.data, next: parsed.data.links?.next };
      }
    );
    return requireUniqueResourceIds(resources, 'review-submission')
      .map(mapReviewSubmission)
      .filter((submission) => (
        (!options?.platform || submission.platform === options.platform)
        && (!options?.states?.length || options.states.includes(submission.state))
      ));
  }

  /**
   * Create a review submission for an app on a platform.
   */
  async createReviewSubmission(appId: string, platform: string): Promise<ReviewSubmission> {
    const raw = await this.apiRequest<unknown>('POST', '/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform },
        relationships: {
          app: {
            data: { type: 'apps', id: appId },
          },
        },
      },
    });
    const result = reviewSubmissionResponseSchema.safeParse(raw);
    if (!result.success) throw malformedResponse('review-submission creation');
    const submission = mapReviewSubmission(result.data.data);
    if (submission.platform !== platform || submission.state !== 'READY_FOR_REVIEW') {
      throw new Error(
        `App Store Connect acknowledged review-submission creation as ${submission.id}, but returned platform/state ${submission.platform}/${submission.state} instead of ${platform}/READY_FOR_REVIEW; creation outcome is unknown.`
      );
    }
    return submission;
  }

  /**
   * Add an App Store version as an item on a review submission.
   */
  async addReviewSubmissionItem(reviewSubmissionId: string, appStoreVersionId: string): Promise<void> {
    await this.apiRequest('POST', '/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: {
            data: { type: 'reviewSubmissions', id: reviewSubmissionId },
          },
          appStoreVersion: {
            data: { type: 'appStoreVersions', id: appStoreVersionId },
          },
        },
      },
    });
  }

  /**
   * Submit a review submission to App Review.
   */
  async submitReviewSubmission(reviewSubmissionId: string): Promise<ReviewSubmission> {
    const result = await this.apiRequest<{
      data: { id: string; attributes: { state: string; platform: string } };
    }>('PATCH', `/reviewSubmissions/${reviewSubmissionId}`, {
      data: {
        type: 'reviewSubmissions',
        id: reviewSubmissionId,
        attributes: { submitted: true },
      },
    });

    return {
      id: result.data.id,
      state: result.data.attributes.state,
      platform: result.data.attributes.platform,
    };
  }

  /**
   * Submit an App Store version for review via the reviewSubmissions flow
   * (the appStoreVersionSubmissions create endpoint was removed in ASC API 4.0):
   * reuse or create an open review submission, add the version as an item,
   * then submit. The version must be in PREPARE_FOR_SUBMISSION state with a
   * valid build attached.
   */
  async submitForReview(input: {
    appId: string;
    appStoreVersionId: string;
    platform: string;
  }): Promise<{ reviewSubmission: ReviewSubmission; reusedExistingSubmission: boolean }> {
    // Observe every state for the platform before creating. Filtering to the
    // familiar open states can hide a newly introduced or transitional state
    // and incorrectly make it appear safe to create another submission.
    const observed = await this.listReviewSubmissions(input.appId, {
      platform: input.platform,
    });
    const open = observed.filter((submission) => submission.state !== 'COMPLETE');

    const inFlight = open.find(s => s.state !== 'READY_FOR_REVIEW');
    if (inFlight) {
      throw new Error(
        `A review submission for this app is already ${inFlight.state} (id ${inFlight.id}). Wait for it to finish or cancel it in App Store Connect before submitting again.`
      );
    }

    const ready = open.filter((submission) => submission.state === 'READY_FOR_REVIEW');
    if (ready.length > 1) {
      throw new Error(
        `Multiple READY_FOR_REVIEW submissions exist for ${input.platform}; resolve the duplicate submissions in App Store Connect before retrying.`
      );
    }

    let submission = ready[0] ?? null;
    const reusedExistingSubmission = submission !== null;
    if (!submission) {
      submission = await this.createReviewSubmission(input.appId, input.platform);
    }

    try {
      await this.addReviewSubmissionItem(submission.id, input.appStoreVersionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not add version ${input.appStoreVersionId} to review submission ${submission.id} (state ${submission.state}): ${detail}`
      );
    }

    const reviewSubmission = await this.submitReviewSubmission(submission.id);
    return { reviewSubmission, reusedExistingSubmission };
  }

  /**
   * Get the build attached to an App Store version.
   */
  async getAppStoreVersionBuild(appStoreVersionId: string): Promise<{ id: string; version: string } | null> {
    const result = await this.apiRequest<{
      data: {
        id: string;
        attributes: { version: string };
      } | null;
    }>('GET', `/appStoreVersions/${appStoreVersionId}/build?fields[builds]=version`);

    if (!result.data) {
      return null;
    }

    return {
      id: result.data.id,
      version: result.data.attributes.version,
    };
  }

  /**
   * List localizations for an App Store version.
   */
  async listAppStoreVersionLocalizations(appStoreVersionId: string): Promise<AppStoreVersionLocalization[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          locale: string;
          description?: string;
          keywords?: string;
          promotionalText?: string;
          marketingUrl?: string;
          supportUrl?: string;
          whatsNew?: string;
        };
      }>;
    }>(
      'GET',
      `/appStoreVersions/${appStoreVersionId}/appStoreVersionLocalizations?limit=200`
    );

    return result.data.map((item) => ({
      id: item.id,
      locale: item.attributes.locale,
      description: item.attributes.description,
      keywords: item.attributes.keywords,
      promotionalText: item.attributes.promotionalText,
      marketingUrl: item.attributes.marketingUrl,
      supportUrl: item.attributes.supportUrl,
      whatsNew: item.attributes.whatsNew,
    }));
  }

  /**
   * List screenshot sets for a localization.
   */
  async listAppScreenshotSets(localizationId: string): Promise<AppScreenshotSet[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: { screenshotDisplayType: string };
      }>;
    }>(
      'GET',
      `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=200`
    );

    return result.data.map((set) => ({
      id: set.id,
      screenshotDisplayType: set.attributes.screenshotDisplayType,
    }));
  }

  /**
   * List screenshots in a screenshot set.
   */
  async listAppScreenshots(appScreenshotSetId: string): Promise<AppScreenshot[]> {
    const result = await this.apiRequest<{
      data: Array<{
        id: string;
        attributes: {
          fileName?: string;
          assetDeliveryState?: { state?: string; errors?: Array<{ code?: string; detail?: string }> };
        };
      }>;
    }>('GET', `/appScreenshotSets/${appScreenshotSetId}/appScreenshots?limit=200`);

    return result.data.map((s) => ({
      id: s.id,
      fileName: s.attributes.fileName,
      assetDeliveryState: s.attributes.assetDeliveryState,
    }));
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format for JWT.
 */
function derToRaw(derSig: Buffer): Buffer {
  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  let offset = 2; // skip 0x30 + length byte
  if (derSig[1]! > 0x80) offset += derSig[1]! - 0x80; // handle extended length

  // Read r
  offset++; // skip 0x02
  const rLen = derSig[offset]!;
  offset++;
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  // Read s
  offset++; // skip 0x02
  const sLen = derSig[offset]!;
  offset++;
  let s = derSig.subarray(offset, offset + sLen);

  // Strip leading zero padding
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);

  // Pad to 32 bytes each
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - r.length);
  s.copy(raw, 64 - s.length);
  return raw;
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'appstoreconnect',
    displayName: 'App Store Connect',
    category: 'appstore',
    credentialsSchema: AppStoreConnectCredentialsSchema,
    setupHelpUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
  },
  factory: (credentials) => {
    const adapter = new AppStoreConnectAdapter();
    adapter.connect(credentials as AppStoreConnectCredentials);
    return adapter;
  },
});
