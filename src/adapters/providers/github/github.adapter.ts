import { z } from 'zod';
import { createRequire } from 'module';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_PAGES_HEALTH_ATTEMPTS = 3;
const GITHUB_PAGES_HEALTH_RETRY_MS = 1_000;
const require = createRequire(import.meta.url);

function encodeFileContent(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function decodeFileContent(content: string): string {
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

function workflowRouteId(workflowId: string | number): string {
  const value = String(workflowId);
  return encodeURIComponent(value.slice(value.lastIndexOf('/') + 1));
}

// Credentials schema for self-registration
export const GitHubCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
  login: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  packageReadToken: z.string().min(1).optional(),
}).strict();

export type GitHubCredentials = z.infer<typeof GitHubCredentialsSchema>;

export interface GitHubUser {
  login: string;
  id: number;
  name?: string;
  email?: string;
}

export interface GitHubVerifyResult {
  success: boolean;
  error?: string;
  login?: string;
  scopes?: string[];
}

export interface GitHubPagesConfig {
  url?: string;
  html_url?: string;
  status?: string;
  cname?: string | null;
  custom_404: boolean;
  https_enforced?: boolean;
  public: boolean;
  source?: {
    branch: string;
    path: string;
  };
  build_type?: string;
  https_certificate?: {
    state: string;
    description: string;
    domains: string[];
    expires_at?: string;
  };
  protected_domain_state?: string | null;
  pending_domain_unverified_at?: string | null;
}

export interface GitHubPagesDomainHealth {
  host?: string;
  uri?: string;
  nameservers?: string;
  dns_resolves?: boolean;
  is_proxied?: boolean;
  is_cloudflare_ip?: boolean;
  is_fastly_ip?: boolean;
  is_old_ip_address?: boolean;
  is_a_record?: boolean;
  has_cname_record?: boolean;
  has_mx_records_present?: boolean;
  is_valid_domain?: boolean;
  is_apex_domain?: boolean;
  should_be_a_record?: boolean;
  is_cname_to_github_user_domain?: boolean;
  is_cname_to_pages_dot_github_dot_com?: boolean;
  is_cname_to_fastly?: boolean;
  is_pointed_to_github_pages_ip?: boolean;
  is_non_github_pages_ip_present?: boolean;
  is_https_eligible?: boolean;
  is_served_by_pages?: boolean;
  is_valid?: boolean;
  responds_to_https?: boolean;
  enforces_https?: boolean;
  https_error?: string | null;
  caa_error?: string | null;
}

export interface GitHubPagesHealthCheck {
  domain?: GitHubPagesDomainHealth;
  alt_domain?: GitHubPagesDomainHealth | null;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description?: string | null;
}

export interface GitHubActionsVariable {
  name: string;
  value: string;
  created_at?: string;
  updated_at?: string;
}

export interface GitHubPullRequestSummary {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly documentationUrl?: string
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function isGitHubNotFound(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && error.status === 404;
}

export class GitHubAdapter {
  readonly name = 'github';
  private credentials: GitHubCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as GitHubCredentials;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>,
    responseOptions?: { acceptEmpty202?: boolean }
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.apiToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${GITHUB_API_URL}${endpoint}`, options);

    if (!response.ok) {
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
      let documentationUrl: string | undefined;
      try {
        const errorBody = await response.json() as { message?: string; documentation_url?: string };
        if (errorBody.message) {
          errorMessage = `GitHub API error: ${errorBody.message}`;
        }
        documentationUrl = errorBody.documentation_url;
      } catch {
        // Ignore JSON parse errors
      }
      throw new GitHubApiError(errorMessage, response.status, documentationUrl);
    }

    if (response.status === 204 || (response.status === 202 && responseOptions?.acceptEmpty202)) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestText(
    method: 'GET',
    endpoint: string
  ): Promise<string> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const response = await fetch(`${GITHUB_API_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.apiToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    });

    if (!response.ok) {
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json() as { message?: string };
        if (errorBody.message) {
          errorMessage = `GitHub API error: ${errorBody.message}`;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    return await response.text();
  }

  async verify(): Promise<GitHubVerifyResult> {
    try {
      if (!this.credentials) {
        throw new Error('Not connected. Call connect() first.');
      }
      const response = await fetch(`${GITHUB_API_URL}/user`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.credentials.apiToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      });
      if (!response.ok) {
        let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
        try {
          const errorBody = await response.json() as { message?: string };
          if (errorBody.message) {
            errorMessage = `GitHub API error: ${errorBody.message}`;
          }
        } catch {
          // Ignore JSON parse errors.
        }
        throw new Error(errorMessage);
      }
      const user = await response.json() as GitHubUser;
      const scopes = (response.headers.get('x-oauth-scopes') ?? '')
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      return { success: true, login: user.login, ...(scopes.length > 0 ? { scopes } : {}) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getPagesConfig(owner: string, repo: string): Promise<GitHubPagesConfig | null> {
    try {
      return await this.request<GitHubPagesConfig>('GET', `/repos/${owner}/${repo}/pages`);
    } catch (error) {
      // 404 means Pages is not enabled (GitHub returns "Not Found" message)
      if (isGitHubNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async getPagesHealthCheck(owner: string, repo: string): Promise<GitHubPagesHealthCheck> {
    for (let attempt = 0; attempt < GITHUB_PAGES_HEALTH_ATTEMPTS; attempt += 1) {
      const health = await this.request<GitHubPagesHealthCheck>(
        'GET',
        `/repos/${owner}/${repo}/pages/health`,
        undefined,
        { acceptEmpty202: true }
      );
      if (health.domain || health.alt_domain) return health;
      if (attempt < GITHUB_PAGES_HEALTH_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, GITHUB_PAGES_HEALTH_RETRY_MS));
      }
    }
    throw new GitHubApiError('GitHub Pages DNS health check is still pending', 202);
  }

  async createPagesSite(
    owner: string,
    repo: string,
    options: { buildType: 'workflow' }
  ): Promise<void> {
    await this.request<unknown>('POST', `/repos/${owner}/${repo}/pages`, {
      build_type: options.buildType,
    });
  }

  async updatePagesSite(
    owner: string,
    repo: string,
    config: { buildType?: 'workflow'; cname?: string | null; httpsEnforced?: boolean }
  ): Promise<void> {
    await this.request<void>('PUT', `/repos/${owner}/${repo}/pages`, {
      ...(config.buildType ? { build_type: config.buildType } : {}),
      ...(config.cname !== undefined ? { cname: config.cname } : {}),
      ...(config.httpsEnforced !== undefined ? { https_enforced: config.httpsEnforced } : {}),
    });
  }

  async deletePagesSite(owner: string, repo: string): Promise<void> {
    await this.request<void>('DELETE', `/repos/${owner}/${repo}/pages`);
  }

  /**
   * Create or update a file in a repository via the Contents API.
   */
  async getFileContent(owner: string, repo: string, path: string): Promise<string | null> {
    try {
      const existing = await this.request<{ content: string }>(
        'GET',
        `/repos/${owner}/${repo}/contents/${path}`
      );
      return decodeFileContent(existing.content);
    } catch (error) {
      if (isGitHubNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async getRepository(owner: string, repo: string): Promise<{
    id?: number;
    full_name?: string;
    default_branch: string;
    html_url?: string;
    clone_url?: string;
    ssh_url?: string;
    private?: boolean;
    security_and_analysis?: {
      advanced_security?: { status: 'enabled' | 'disabled' };
      secret_scanning?: { status: 'enabled' | 'disabled' };
      secret_scanning_push_protection?: { status: 'enabled' | 'disabled' };
      dependabot_security_updates?: { status: 'enabled' | 'disabled' };
    };
  }> {
    return this.request('GET', `/repos/${owner}/${repo}`);
  }

  async getRef(owner: string, repo: string, ref: string): Promise<{ ref: string; object: { sha: string } } | null> {
    try {
      return await this.request<{ ref: string; object: { sha: string } }>(
        'GET',
        `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(ref)}`
      );
    } catch (error) {
      if (isGitHubNotFound(error)) return null;
      throw error;
    }
  }

  async createRef(owner: string, repo: string, ref: string, sha: string): Promise<void> {
    await this.request('POST', `/repos/${owner}/${repo}/git/refs`, { ref, sha });
  }

  async updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    await this.request('PATCH', `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(ref)}`, {
      sha,
      force: options.force ?? false,
    });
  }

  async getFile(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<{ sha: string; content: string } | null> {
    try {
      const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const existing = await this.request<{ sha: string; content: string }>(
        'GET',
        `/repos/${owner}/${repo}/contents/${path}${suffix}`
      );
      return { sha: existing.sha, content: decodeFileContent(existing.content) };
    } catch (error) {
      if (isGitHubNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Create or update a file in a repository via the Contents API.
   */
  async createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    commitMessage: string,
    branch?: string
  ): Promise<{ created: boolean; updated: boolean }> {
    const contentBase64 = encodeFileContent(content);

    // Check if file already exists
    try {
      const existing = await this.request<{ sha: string; content: string }>(
        'GET',
        `/repos/${owner}/${repo}/contents/${path}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`
      );

      // Update existing file
      await this.request<unknown>('PUT', `/repos/${owner}/${repo}/contents/${path}`, {
        message: commitMessage,
        content: contentBase64,
        sha: existing.sha,
        ...(branch ? { branch } : {}),
      });

      return { created: false, updated: true };
    } catch (error) {
      if (isGitHubNotFound(error)) {
        // Create new file
        await this.request<unknown>('PUT', `/repos/${owner}/${repo}/contents/${path}`, {
          message: commitMessage,
          content: contentBase64,
          ...(branch ? { branch } : {}),
        });

        return { created: true, updated: false };
      }
      throw error;
    }
  }

  async deleteFile(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    commitMessage: string,
    branch: string
  ): Promise<void> {
    await this.request('DELETE', `/repos/${owner}/${repo}/contents/${path}`, {
      message: commitMessage,
      sha,
      branch,
    });
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options: { state?: 'open' | 'closed' | 'all'; head?: string; base?: string } = {}
  ): Promise<GitHubPullRequestSummary[]> {
    const params = new URLSearchParams({ state: options.state ?? 'open', per_page: '100' });
    if (options.head) params.set('head', options.head);
    if (options.base) params.set('base', options.base);
    return this.request('GET', `/repos/${owner}/${repo}/pulls?${params.toString()}`);
  }

  async createPullRequest(owner: string, repo: string, input: {
    title: string;
    head: string;
    base: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; html_url: string }> {
    return this.request('POST', `/repos/${owner}/${repo}/pulls`, input);
  }

  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<{ status: 'ahead' | 'behind' | 'diverged' | 'identical'; ahead_by: number; behind_by: number }> {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
  }

  async listRepositorySecrets(owner: string, repo: string): Promise<string[]> {
    const response = await this.request<{ secrets: Array<{ name: string }> }>(
      'GET',
      `/repos/${owner}/${repo}/actions/secrets?per_page=100`
    );
    return response.secrets.map((secret) => secret.name);
  }

  async getVulnerabilityAlertsEnabled(owner: string, repo: string): Promise<boolean> {
    try {
      await this.request('GET', `/repos/${owner}/${repo}/vulnerability-alerts`);
      return true;
    } catch (error) {
      if (isGitHubNotFound(error)) return false;
      throw error;
    }
  }

  async enableVulnerabilityAlerts(owner: string, repo: string): Promise<void> {
    await this.request('PUT', `/repos/${owner}/${repo}/vulnerability-alerts`);
  }

  async updateRepositorySecurity(owner: string, repo: string, settings: {
    advancedSecurity?: boolean;
    secretScanning?: boolean;
    pushProtection?: boolean;
    dependabotSecurityUpdates?: boolean;
  }): Promise<void> {
    const security_and_analysis: Record<string, { status: 'enabled' }> = {};
    if (settings.advancedSecurity) security_and_analysis.advanced_security = { status: 'enabled' };
    if (settings.secretScanning) security_and_analysis.secret_scanning = { status: 'enabled' };
    if (settings.pushProtection) security_and_analysis.secret_scanning_push_protection = { status: 'enabled' };
    if (settings.dependabotSecurityUpdates) security_and_analysis.dependabot_security_updates = { status: 'enabled' };
    await this.request('PATCH', `/repos/${owner}/${repo}`, { security_and_analysis });
  }

  async getCodeScanningDefaultSetup(owner: string, repo: string): Promise<{ state?: string } | null> {
    try {
      return await this.request('GET', `/repos/${owner}/${repo}/code-scanning/default-setup`);
    } catch (error) {
      if (isGitHubNotFound(error)) return null;
      throw error;
    }
  }

  async enableCodeScanningDefaultSetup(owner: string, repo: string): Promise<void> {
    await this.request('PATCH', `/repos/${owner}/${repo}/code-scanning/default-setup`, { state: 'configured' });
  }

  async getWorkflowPermissions(owner: string, repo: string): Promise<{
    default_workflow_permissions: 'read' | 'write';
    can_approve_pull_request_reviews: boolean;
  }> {
    return this.request('GET', `/repos/${owner}/${repo}/actions/permissions/workflow`);
  }

  async allowActionsPullRequests(owner: string, repo: string): Promise<void> {
    const current = await this.getWorkflowPermissions(owner, repo);
    await this.request('PUT', `/repos/${owner}/${repo}/actions/permissions/workflow`, {
      default_workflow_permissions: current.default_workflow_permissions,
      can_approve_pull_request_reviews: true,
    });
  }

  /**
   * Set a repository secret for GitHub Actions.
   * Uses the repo public key to encrypt the value via libsodium sealed box.
   * Requires tweetnacl and tweetnacl-sealedbox-js to be available.
   */
  async setRepositorySecret(
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string
  ): Promise<void> {
    // Get the repo public key for encrypting secrets
    const publicKeyResponse = await this.request<{
      key_id: string;
      key: string;
    }>('GET', `/repos/${owner}/${repo}/actions/secrets/public-key`);

    // GitHub expects libsodium sealed-box encryption for Actions secrets.
    const sealedBox = require('tweetnacl-sealedbox-js') as {
      seal: (message: Uint8Array, publicKey: Uint8Array) => Uint8Array;
    };
    const encrypted = Buffer.from(
      sealedBox.seal(Buffer.from(secretValue), Buffer.from(publicKeyResponse.key, 'base64'))
    ).toString('base64');

    // Set the secret
    await this.request<unknown>('PUT', `/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
      encrypted_value: encrypted,
      key_id: publicKeyResponse.key_id,
    });
  }

  /**
   * List Actions secret names scoped to a GitHub environment. Secret values
   * are never returned by GitHub or exposed by this adapter.
   */
  async listEnvironmentSecrets(
    owner: string,
    repo: string,
    environmentName: string
  ): Promise<string[]> {
    const environment = encodeURIComponent(environmentName);
    try {
      const response = await this.request<{ secrets: Array<{ name: string }> }>(
        'GET',
        `/repos/${owner}/${repo}/environments/${environment}/secrets?per_page=100`
      );
      return response.secrets.map((secret) => secret.name);
    } catch (error) {
      if (isGitHubNotFound(error)) return [];
      throw error;
    }
  }

  /**
   * Create or update an Actions secret scoped to a GitHub environment.
   */
  async setEnvironmentSecret(
    owner: string,
    repo: string,
    environmentName: string,
    secretName: string,
    secretValue: string
  ): Promise<void> {
    const environment = encodeURIComponent(environmentName);
    try {
      await this.request<unknown>('GET', `/repos/${owner}/${repo}/environments/${environment}`);
    } catch (error) {
      if (!isGitHubNotFound(error)) throw error;
      await this.request<unknown>('PUT', `/repos/${owner}/${repo}/environments/${environment}`, {});
    }
    const publicKeyResponse = await this.request<{ key_id: string; key: string }>(
      'GET',
      `/repos/${owner}/${repo}/environments/${environment}/secrets/public-key`
    );
    const sealedBox = require('tweetnacl-sealedbox-js') as {
      seal: (message: Uint8Array, publicKey: Uint8Array) => Uint8Array;
    };
    const encrypted = Buffer.from(
      sealedBox.seal(Buffer.from(secretValue), Buffer.from(publicKeyResponse.key, 'base64'))
    ).toString('base64');
    await this.request<unknown>(
      'PUT',
      `/repos/${owner}/${repo}/environments/${environment}/secrets/${encodeURIComponent(secretName)}`,
      { encrypted_value: encrypted, key_id: publicKeyResponse.key_id }
    );
  }

  /**
   * Delete an Actions secret scoped to a GitHub environment.
   */
  async deleteEnvironmentSecret(
    owner: string,
    repo: string,
    environmentName: string,
    secretName: string
  ): Promise<void> {
    const environment = encodeURIComponent(environmentName);
    await this.request<unknown>(
      'DELETE',
      `/repos/${owner}/${repo}/environments/${environment}/secrets/${encodeURIComponent(secretName)}`
    );
  }

  // ============= Repository Secrets =============

  /**
   * List repository secrets (names only - values are never exposed).
   */
  async listSecrets(owner: string, repo: string): Promise<{
    total_count: number;
    secrets: Array<{ name: string; created_at: string; updated_at: string }>;
  }> {
    return await this.request<{
      total_count: number;
      secrets: Array<{ name: string; created_at: string; updated_at: string }>;
    }>('GET', `/repos/${owner}/${repo}/actions/secrets`);
  }

  /**
   * Delete a repository secret.
   */
  async deleteSecret(owner: string, repo: string, secretName: string): Promise<void> {
    await this.request<void>('DELETE', `/repos/${owner}/${repo}/actions/secrets/${secretName}`);
  }

  // ============= Environment Variables =============

  /**
   * Read an Actions variable scoped to a GitHub environment.
   * Returns null when the variable has not been created yet.
   */
  async getEnvironmentVariable(
    owner: string,
    repo: string,
    environmentName: string,
    variableName: string
  ): Promise<GitHubActionsVariable | null> {
    const environment = encodeURIComponent(environmentName);
    const variable = encodeURIComponent(variableName);
    try {
      return await this.request<GitHubActionsVariable>(
        'GET',
        `/repos/${owner}/${repo}/environments/${environment}/variables/${variable}`
      );
    } catch (error) {
      if (isGitHubNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or update an Actions variable scoped to a GitHub environment.
   */
  async setEnvironmentVariable(
    owner: string,
    repo: string,
    environmentName: string,
    variableName: string,
    value: string
  ): Promise<void> {
    const environment = encodeURIComponent(environmentName);
    const variable = encodeURIComponent(variableName);
    const endpoint = `/repos/${owner}/${repo}/environments/${environment}/variables`;
    try {
      await this.request<unknown>('GET', `/repos/${owner}/${repo}/environments/${environment}`);
    } catch (error) {
      if (!isGitHubNotFound(error)) {
        throw error;
      }
      await this.request<unknown>('PUT', `/repos/${owner}/${repo}/environments/${environment}`, {});
    }
    const existing = await this.getEnvironmentVariable(owner, repo, environmentName, variableName);
    if (existing) {
      await this.request<void>('PATCH', `${endpoint}/${variable}`, { name: variableName, value });
      return;
    }
    await this.request<void>('POST', endpoint, { name: variableName, value });
  }

  // ============= Repository Labels =============

  async listLabels(owner: string, repo: string): Promise<GitHubLabel[]> {
    return await this.request<GitHubLabel[]>('GET', `/repos/${owner}/${repo}/labels?per_page=100`);
  }

  async createOrUpdateLabel(
    owner: string,
    repo: string,
    label: { name: string; color: string; description?: string }
  ): Promise<{ created: boolean; updated: boolean }> {
    const encodedName = encodeURIComponent(label.name);
    const color = label.color.replace(/^#/, '').toLowerCase();
    const description = label.description ?? '';
    try {
      const existing = await this.request<GitHubLabel>('GET', `/repos/${owner}/${repo}/labels/${encodedName}`);
      const currentColor = existing.color.replace(/^#/, '').toLowerCase();
      const currentDescription = existing.description ?? '';
      if (currentColor === color && currentDescription === description) {
        return { created: false, updated: false };
      }
      await this.request<GitHubLabel>('PATCH', `/repos/${owner}/${repo}/labels/${encodedName}`, {
        name: label.name,
        color,
        description,
      });
      return { created: false, updated: true };
    } catch (error) {
      if (isGitHubNotFound(error)) {
        await this.request<GitHubLabel>('POST', `/repos/${owner}/${repo}/labels`, {
          name: label.name,
          color,
          description,
        });
        return { created: true, updated: false };
      }
      throw error;
    }
  }

  // ============= Workflows =============

  /**
   * List workflows in a repository.
   */
  async listWorkflows(owner: string, repo: string): Promise<{
    total_count: number;
    workflows: Array<{
      id: number;
      name: string;
      path: string;
      state: string;
      created_at: string;
      updated_at: string;
    }>;
  }> {
    return await this.request<{
      total_count: number;
      workflows: Array<{
        id: number;
        name: string;
        path: string;
        state: string;
        created_at: string;
        updated_at: string;
      }>;
    }>('GET', `/repos/${owner}/${repo}/actions/workflows`);
  }

  /**
   * List workflow runs for a specific workflow.
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowId: string | number,
    options?: { status?: string; per_page?: number }
  ): Promise<{
    total_count: number;
    workflow_runs: Array<{
      id: number;
      name: string;
      display_title?: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      head_sha: string;
      head_branch: string;
      event: string;
      html_url: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.per_page) params.set('per_page', String(options.per_page));
    const query = params.toString() ? `?${params.toString()}` : '';

    return await this.request<{
      total_count: number;
      workflow_runs: Array<{
        id: number;
        name: string;
        display_title?: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        updated_at: string;
        head_sha: string;
        head_branch: string;
        event: string;
        html_url: string;
      }>;
    }>('GET', `/repos/${owner}/${repo}/actions/workflows/${workflowRouteId(workflowId)}/runs${query}`);
  }

  /**
   * List repository Actions artifacts. Names and workflow-run identities are
   * sufficient for release-gate verification; artifact contents remain in
   * GitHub and are not exposed through command results.
   */
  async listArtifacts(owner: string, repo: string, perPage = 100): Promise<{
    total_count: number;
    artifacts: Array<{
      id: number;
      name: string;
      expired: boolean;
      created_at: string;
      updated_at: string;
      workflow_run: {
        id: number;
        repository_id: number;
        head_repository_id: number;
        head_branch: string;
        head_sha: string;
      } | null;
    }>;
  }> {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/actions/artifacts?per_page=${Math.max(1, Math.min(perPage, 100))}`
    );
  }

  /**
   * List artifacts emitted by one workflow run. Scoping the read to a durable
   * run id lets operational commands prove provenance without trusting a
   * repository-wide artifact name match.
   */
  async listWorkflowRunArtifacts(owner: string, repo: string, runId: string | number): Promise<{
    total_count: number;
    artifacts: Array<{
      id: number;
      name: string;
      expired: boolean;
      created_at: string;
      updated_at: string;
      workflow_run: {
        id: number;
        repository_id: number;
        head_repository_id: number;
        head_branch: string;
        head_sha: string;
      } | null;
    }>;
  }> {
    return this.request(
      'GET',
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`
    );
  }

  /**
   * List jobs and steps for a workflow run.
   */
  async listWorkflowRunJobs(
    owner: string,
    repo: string,
    runId: string | number,
    options?: { per_page?: number }
  ): Promise<{
    total_count: number;
    jobs: Array<{
      id: number;
      run_id: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at: string | null;
      completed_at: string | null;
      html_url: string;
      steps?: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        number: number;
        started_at: string | null;
        completed_at: string | null;
      }>;
    }>;
  }> {
    const params = new URLSearchParams();
    if (options?.per_page) params.set('per_page', String(options.per_page));
    const query = params.toString() ? `?${params.toString()}` : '';

    return await this.request<{
      total_count: number;
      jobs: Array<{
        id: number;
        run_id: number;
        name: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        html_url: string;
        steps?: Array<{
          name: string;
          status: string;
          conclusion: string | null;
          number: number;
          started_at: string | null;
          completed_at: string | null;
        }>;
      }>;
    }>('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs${query}`);
  }

  /**
   * Download plain text logs for a workflow job.
   */
  async getWorkflowJobLogs(owner: string, repo: string, jobId: string | number): Promise<string> {
    return await this.requestText('GET', `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
  }

  /**
   * Trigger a workflow dispatch event.
   */
  async triggerWorkflow(
    owner: string,
    repo: string,
    workflowId: string | number,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    await this.request<void>('POST', `/repos/${owner}/${repo}/actions/workflows/${workflowRouteId(workflowId)}/dispatches`, {
      ref,
      inputs: inputs ?? {},
    });
  }

  // ============= Branch Protection =============

  /**
   * Get branch protection rules.
   */
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<{
    required_status_checks: {
      strict: boolean;
      contexts: string[];
      checks: Array<{ context: string; app_id: number | null }>;
    } | null;
    required_pull_request_reviews: {
      required_approving_review_count: number;
      dismiss_stale_reviews: boolean;
      require_code_owner_reviews: boolean;
    } | null;
    enforce_admins: { enabled: boolean } | null;
    required_linear_history: { enabled: boolean } | null;
    allow_force_pushes: { enabled: boolean } | null;
    allow_deletions: { enabled: boolean } | null;
  } | null> {
    try {
      return await this.request<{
        required_status_checks: {
          strict: boolean;
          contexts: string[];
          checks: Array<{ context: string; app_id: number | null }>;
        } | null;
        required_pull_request_reviews: {
          required_approving_review_count: number;
          dismiss_stale_reviews: boolean;
          require_code_owner_reviews: boolean;
        } | null;
        enforce_admins: { enabled: boolean } | null;
        required_linear_history: { enabled: boolean } | null;
        allow_force_pushes: { enabled: boolean } | null;
        allow_deletions: { enabled: boolean } | null;
      }>('GET', `/repos/${owner}/${repo}/branches/${branch}/protection`);
    } catch (error) {
      // 404 means no protection rules
      if (isGitHubNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Update branch protection rules.
   */
  async updateBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    rules: {
      requireReviews?: boolean;
      requiredReviewers?: number;
      dismissStaleReviews?: boolean;
      requireCodeOwnerReviews?: boolean;
      requireStatusChecks?: boolean;
      statusChecks?: string[];
      strictStatusChecks?: boolean;
      enforceAdmins?: boolean;
      preserveStatusChecks?: boolean;
      requireLinearHistory?: boolean;
      allowForcePushes?: boolean;
      allowDeletions?: boolean;
    }
  ): Promise<void> {
    const body: Record<string, unknown> = {
      enforce_admins: rules.enforceAdmins ?? false,
      required_linear_history: rules.requireLinearHistory ?? false,
      allow_force_pushes: rules.allowForcePushes ?? false,
      allow_deletions: rules.allowDeletions ?? false,
      restrictions: null, // We don't restrict who can push
    };

    if (rules.preserveStatusChecks) {
      const existing = await this.getBranchProtection(owner, repo, branch);
      const current = existing?.required_status_checks;
      const contexts = current?.contexts?.length
        ? current.contexts
        : current?.checks?.map((check) => check.context).filter(Boolean) ?? [];
      body.required_status_checks = current
        ? { strict: current.strict, contexts }
        : null;
    } else if (rules.requireStatusChecks && rules.statusChecks && rules.statusChecks.length > 0) {
      body.required_status_checks = {
        strict: rules.strictStatusChecks ?? true,
        contexts: rules.statusChecks,
      };
    } else {
      body.required_status_checks = null;
    }

    if (rules.requireReviews) {
      body.required_pull_request_reviews = {
        required_approving_review_count: rules.requiredReviewers ?? 1,
        dismiss_stale_reviews: rules.dismissStaleReviews ?? false,
        require_code_owner_reviews: rules.requireCodeOwnerReviews ?? false,
      };
    } else {
      body.required_pull_request_reviews = null;
    }

    await this.request<void>('PUT', `/repos/${owner}/${repo}/branches/${branch}/protection`, body);
  }

}

function repositoryFromInspectionScope(scope?: string): { owner: string; repo: string } {
  const normalized = scope
    ?.trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = normalized?.split('/').filter(Boolean) ?? [];
  if (parts.length < 2) {
    throw new Error('GitHub inspection requires scope="owner/repo" or a Hypervibe project with a GitHub remote.');
  }
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

async function inspectGitHubResources(
  adapter: GitHubAdapter,
  request: ProviderInspectionRequest
): Promise<Record<string, unknown>> {
  const { owner, repo } = repositoryFromInspectionScope(request.scope);
  const resource = request.resource ?? 'repository';
  if (resource === 'repository') {
    return {
      observation: 'present',
      resource,
      repository: { owner, repo, ...await adapter.getRepository(owner, repo) },
    };
  }
  if (resource === 'ref' || resource === 'branch') {
    const selected = request.id ?? request.name;
    if (!selected) throw new Error(`GitHub ${resource} inspection requires id or name.`);
    const refName = selected.replace(/^refs\//, '').replace(/^branches\//, 'heads/');
    const ref = await adapter.getRef(owner, repo, refName.startsWith('heads/') || refName.startsWith('tags/')
      ? refName
      : `heads/${refName}`);
    return {
      observation: ref ? 'present' : 'absent',
      resource,
      repository: `${owner}/${repo}`,
      ...(ref ? { ref: { name: ref.ref, sha: ref.object.sha } } : { name: selected }),
    };
  }
  if (resource === 'pages') {
    const [config, health] = await Promise.all([
      adapter.getPagesConfig(owner, repo),
      adapter.getPagesHealthCheck(owner, repo),
    ]);
    return {
      observation: config ? 'present' : 'absent',
      resource,
      repository: `${owner}/${repo}`,
      config,
      health,
    };
  }
  if (resource === 'pull-request') {
    const listed = await adapter.listPullRequests(owner, repo, {
      state: 'all',
      ...(request.name ? { head: `${owner}:${request.name}` } : {}),
    });
    const pullRequests = listed.map((pullRequest) => ({
      id: String(pullRequest.number),
      name: pullRequest.head.ref,
      ...pullRequest,
    }));
    return {
      observation: pullRequests.length > 0 ? 'present' : 'absent',
      resource,
      repository: `${owner}/${repo}`,
      pullRequests: pullRequests.slice(0, request.limit),
      ...(pullRequests.length === 0 && request.name ? { name: request.name } : {}),
      truncated: pullRequests.length > request.limit,
      partial: pullRequests.length >= 100,
    };
  }
  if (resource === 'branch-protection') {
    const branch = request.id ?? request.name;
    if (!branch) throw new Error('GitHub branch-protection inspection requires id or name.');
    const protection = await adapter.getBranchProtection(owner, repo, branch);
    return {
      observation: protection ? 'present' : 'absent',
      resource,
      repository: `${owner}/${repo}`,
      branch,
      protection,
    };
  }
  throw new Error(`Unsupported GitHub inspection resource "${resource}".`);
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'github',
    displayName: 'GitHub',
    category: 'deployment',
    credentialsSchema: GitHubCredentialsSchema,
    setupHelpUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages&description=Hypervibe%20CI%20deploys',
    credentials: {
      defaultScalarKey: 'apiToken',
      environmentVariableAliases: [[
        'NODE_AUTH_TOKEN',
        'HYPERVIBE_GITHUB_TOKEN',
        'HYPERVIBE_GITHUB_PACKAGES_TOKEN',
      ]],
    },
  },
  factory: (credentials) => {
    const adapter = new GitHubAdapter();
    adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['repository', 'ref', 'branch', 'pages', 'pull-request', 'branch-protection'],
    defaultResource: 'repository',
    selectors: {
      repository: { mode: 'provider-resource', oneOf: [['scope', 'project']], optional: ['scope', 'project'] },
      ref: { mode: 'provider-resource', oneOf: [['scope', 'project'], ['id', 'name']], optional: ['scope', 'project', 'id', 'name'], mutuallyExclusive: [['id', 'name']] },
      branch: { mode: 'provider-resource', oneOf: [['scope', 'project'], ['id', 'name']], optional: ['scope', 'project', 'id', 'name'], mutuallyExclusive: [['id', 'name']] },
      pages: { mode: 'provider-resource', oneOf: [['scope', 'project']], optional: ['scope', 'project'] },
      'pull-request': { mode: 'provider-resource', oneOf: [['scope', 'project']], optional: ['scope', 'project', 'name', 'limit'], list: true, collectionKey: 'pullRequests' },
      'branch-protection': { mode: 'provider-resource', oneOf: [['scope', 'project'], ['id', 'name']], optional: ['scope', 'project', 'id', 'name'], mutuallyExclusive: [['id', 'name']] },
    },
    inspect: (adapter, request) => inspectGitHubResources(adapter as GitHubAdapter, request),
  },
});
