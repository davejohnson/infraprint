import { z } from 'zod';
import { lookup } from 'dns/promises';
import pg from 'pg';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IDatabaseAdapter,
  DatabaseCapabilities,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import {
  createUnresolvedDatabaseMutation,
  databaseCreateMayHaveCommitted,
  parseUnresolvedDatabaseMutation,
} from '../../../domain/ports/database.port.js';
import type { ObservedDatabase } from '../../../domain/ports/observe.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

// Credentials schema for self-registration
export const SupabaseCredentialsSchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  organizationId: z.string().trim().min(1, 'Organization ID must not be empty').optional(),
});

export type SupabaseCredentials = z.infer<typeof SupabaseCredentialsSchema>;

export class SupabaseApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(`Supabase API error: ${status}${message ? ` ${message}` : ''}`);
    this.name = 'SupabaseApiError';
  }
}

const SUPABASE_API_URL = 'https://api.supabase.com/v1';
const { Client } = pg;

interface SupabaseProject {
  id: string;
  name: string;
  organization_id: string;
  region: string;
  status: string;
  database?: {
    host: string;
    port: number;
    name: string;
    user: string;
    password?: string;
  };
}

interface SupabaseOrganization {
  id: string;
  name?: string;
}

interface SupabaseProjectScope extends Record<string, string> {
  organizationId: string;
  region: string;
}

function normalizedSupabaseProjectStatus(
  status: string
): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
  const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown'> = {
    ACTIVE_HEALTHY: 'running',
    ACTIVE_UNHEALTHY: 'error',
    COMING_UP: 'provisioning',
    GOING_DOWN: 'stopped',
    INACTIVE: 'stopped',
    INIT_FAILED: 'error',
    PAUSED: 'stopped',
    PAUSING: 'stopped',
    REMOVED: 'stopped',
    RESTORING: 'provisioning',
    UNKNOWN: 'unknown',
  };
  return statusMap[status] ?? 'unknown';
}

export class SupabaseAdapter implements IDatabaseAdapter {
  readonly name = 'supabase';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: true,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: false,
    serverlessOptimized: true,
  };

  private credentials: SupabaseCredentials | null = null;
  private resolvedOrganization: SupabaseOrganization | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = SupabaseCredentialsSchema.parse(credentials);
    this.resolvedOrganization = null;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const organization = await this.resolveConnectedOrganization();
      return {
        success: true,
        email: `Organization: ${organization.name ?? organization.id}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.resolvedOrganization = null;
  }

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      databaseName?: string;
      resourceName?: string;
    }
  ): Promise<ProvisionResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (type !== 'postgres') {
      const emptyComponent: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component: emptyComponent,
        receipt: {
          success: false,
          message: `Supabase only supports PostgreSQL. Requested type: ${type}`,
        },
      };
    }

    let acknowledgedProject: SupabaseProject | undefined;
    let requestedOrganizationId: string | undefined;
    const requestedRegion = options?.region || 'us-east-1';
    const projectName = options?.resourceName || `${environment.name}-db`;
    let createMutationAttempted = false;
    let unresolvedCreateOutcome = false;
    try {
      const orgId = (await this.resolveConnectedOrganization()).id;
      requestedOrganizationId = orgId;

      // Create project name from environment
      const dbPassword = this.generatePassword();

      let existingByName: SupabaseProject[];
      try {
        existingByName = await this.findProjectsByName(orgId, projectName);
      } catch (error) {
        throw new Error([
          `Could not check whether Supabase project "${projectName}" already exists, so Hypervibe refused to create a new project that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (existingByName.length > 0) {
        throw new Error([
          `Supabase project "${projectName}" already exists in organization ${orgId}: ${existingByName.map((p) => `${p.name} (${p.id})`).join(', ')}.`,
          'Hypervibe will not create another Supabase project with the same name. Bind/import the intended database or delete the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      // Create Supabase project
      createMutationAttempted = true;
      let project: SupabaseProject;
      try {
        project = await this.request<SupabaseProject>('POST', '/projects', {
          organization_id: orgId,
          name: projectName,
          region: requestedRegion,
          plan: options?.size || 'free',
          db_pass: dbPassword,
        });
        unresolvedCreateOutcome = true;
      } catch (error) {
        unresolvedCreateOutcome = databaseCreateMayHaveCommitted(error);
        throw error;
      }
      if (
        project
        && typeof project.id === 'string'
        && project.id.trim()
        && project.id === project.id.trim()
      ) {
        acknowledgedProject = project;
        unresolvedCreateOutcome = false;
      }
      const acknowledgedScope = this.projectScope(project);
      if (
        !acknowledgedProject
        || project.name !== projectName
        || acknowledgedScope.organizationId !== orgId
        || acknowledgedScope.region !== requestedRegion
      ) {
        throw new Error(
          `Supabase acknowledged project creation without the exact expected ${orgId}/${requestedRegion}/${projectName} identity.`
        );
      }

      // Build connection URLs
      // Supabase provides both direct and pooled connections
      const host = project.database?.host || `db.${project.id}.supabase.co`;
      const port = project.database?.port || 5432;
      const user = project.database?.user || 'postgres';
      const password = project.database?.password || dbPassword;
      const database = project.database?.name || 'postgres';

      const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      const encodedDatabase = encodeURIComponent(database);
      const directUrl = `postgresql://${auth}@${host}:${port}/${encodedDatabase}`;
      const pooledUrl = `postgresql://${auth}@${host}:6543/${encodedDatabase}?pgbouncer=true`;
      const readiness = await this.waitForDatabaseReadiness(project.id, host, directUrl);

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'postgres',
        bindings: {
          connectionString: directUrl,
          host,
          port,
          username: user,
          password,
          database,
          provider: 'supabase',
          instanceId: project.id,
          providerScope: this.projectScope(project),
          pooledUrl,
        },
        externalId: project.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: readiness.ready,
          message: readiness.ready
            ? `Created Supabase project: ${project.name}`
            : `Supabase created project ${project.name}, but database readiness could not be proven`,
          ...(!readiness.ready ? {
            error: readiness.error
              ?? `Supabase project ${project.id} did not become reachable after ${readiness.attempts} checks.`,
          } : {}),
          data: {
            projectId: project.id,
            region: project.region,
            ready: readiness.ready,
            status: readiness.status,
            attempts: readiness.attempts,
            ...(readiness.error ? { readinessError: readiness.error } : {}),
          },
        },
        connectionUrl: directUrl,
        envVars: {
          DATABASE_URL: directUrl,
          DIRECT_URL: directUrl,
          DATABASE_POOLER_URL: pooledUrl,
          DATABASE_SSL: 'true',
          PGHOST: host,
          PGPORT: String(port),
          PGUSER: user,
          PGPASSWORD: password,
          PGDATABASE: database,
        },
      };
    } catch (error) {
      let recoveryError: string | undefined;
      if (!acknowledgedProject && unresolvedCreateOutcome && requestedOrganizationId) {
        try {
          acknowledgedProject = await this.recoverCreatedProject(
            requestedOrganizationId,
            projectName
          ) ?? undefined;
        } catch (recoveryFailure) {
          recoveryError = this.formatError(recoveryFailure);
        }
      }
      const emptyComponent: Component = acknowledgedProject?.id
        && requestedOrganizationId
        && requestedRegion
        ? {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {
              provider: 'supabase',
              instanceId: acknowledgedProject.id,
              providerScope: {
                organizationId: typeof acknowledgedProject.organization_id === 'string'
                  && acknowledgedProject.organization_id.trim()
                  ? acknowledgedProject.organization_id.trim()
                  : requestedOrganizationId,
                region: typeof acknowledgedProject.region === 'string'
                  && acknowledgedProject.region.trim()
                  ? acknowledgedProject.region.trim()
                  : requestedRegion,
              },
            },
            externalId: acknowledgedProject.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : unresolvedCreateOutcome && requestedOrganizationId
          ? this.unresolvedCreateComponent(
              environment,
              projectName,
              requestedOrganizationId,
              requestedRegion
            )
          : {
            id: '',
            environmentId: environment.id,
            type,
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

      return {
        component: emptyComponent,
        receipt: {
          success: false,
          message: 'Failed to provision Supabase project',
          error: `${this.formatError(error)}${recoveryError
            ? ` Exact-name recovery also failed: ${recoveryError}`
            : ''}`,
          ...(acknowledgedProject ? {
            data: {
              projectId: acknowledgedProject.id,
              organizationId: typeof acknowledgedProject.organization_id === 'string'
                && acknowledgedProject.organization_id.trim()
                ? acknowledgedProject.organization_id.trim()
                : requestedOrganizationId,
              region: typeof acknowledgedProject.region === 'string'
                && acknowledgedProject.region.trim()
                ? acknowledgedProject.region.trim()
                : requestedRegion,
              mutationAttempted: createMutationAttempted,
            },
          } : unresolvedCreateOutcome ? {
            data: {
              mutationAttempted: createMutationAttempted,
              resourceCreated: 'unknown',
              unresolvedCreateRetained: true,
            },
          } : {}),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.credentials) {
      return null;
    }

    if (!component.externalId) {
      return null;
    }

    const scope = await this.assertComponentScope(component);
    const project = await this.getProject(component.externalId);
    if (!project) {
      return null;
    }
    this.assertProjectScope(project, scope, component.externalId);

    const bindings = component.bindings as { connectionString?: string };
    if (bindings.connectionString) {
      return bindings.connectionString;
    }

    if (project.database) {
      const { host, port, user, password, name } = project.database;
      return `postgresql://${user}:${password}@${host}:${port}/${name}`;
    }

    return null;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials) {
      return { success: false, message: 'Not connected' };
    }

    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }

    try {
      const scope = await this.assertComponentScope(component);
      const existing = await this.getProject(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Supabase project is already absent: ${component.externalId}`,
        };
      }
      this.assertProjectScope(existing, scope, component.externalId);
      try {
        await this.request('DELETE', `/projects/${component.externalId}`);
      } catch (error) {
        if (error instanceof SupabaseApiError && error.status === 404) {
          return {
            success: true,
            message: `Supabase project is already absent: ${component.externalId}`,
          };
        }
        throw error;
      }
      const attempts = Number(process.env.HYPERVIBE_SUPABASE_DELETE_ATTEMPTS ?? 60);
      const delayMs = Number(process.env.HYPERVIBE_SUPABASE_DELETE_DELAY_MS ?? 1000);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const remaining = await this.getProject(component.externalId);
        if (!remaining) {
          return {
            success: true,
            message: `Deleted Supabase project: ${component.externalId}`,
          };
        }
        this.assertProjectScope(remaining, scope, component.externalId);
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      return {
        success: false,
        message: 'Supabase accepted deletion but the project is still present',
        error: `Project ${component.externalId} was still observable after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Supabase project',
        error: String(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.credentials || !component.externalId) {
      return { status: 'unknown' };
    }

    try {
      const project = await this.request<SupabaseProject>(
        'GET',
        `/projects/${component.externalId}`
      );

      return {
        status: normalizedSupabaseProjectStatus(project.status),
        message: project.status,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const unresolved = parseUnresolvedDatabaseMutation(component?.bindings);
    let project: SupabaseProject | null;
    if (component?.externalId) {
      const scope = await this.assertComponentScope(component);
      project = await this.getProject(component.externalId);
      if (project) this.assertProjectScope(project, scope, component.externalId);
    } else {
      const orgId = (await this.resolveConnectedOrganization()).id;
      if (unresolved && unresolved.providerScope.organizationId !== orgId) {
        throw new Error(
          `Supabase unresolved database create belongs to organization ${unresolved.providerScope.organizationId}, not connected organization ${orgId}.`
        );
      }
      const expectedName = unresolved?.resourceName
        ?? options?.resourceName
        ?? `${environment.name}-db`;
      const candidates = (await this.listProjects()).filter((item) =>
        item.organization_id === orgId
        && item.name.toLowerCase() === expectedName.toLowerCase()
        && (!unresolved || item.region === unresolved.providerScope.region)
      );
      if (candidates.length > 1) {
        throw new Error(`Multiple Supabase projects match ${expectedName}: ${candidates.map((item) => item.id).join(', ')}`);
      }
      project = candidates[0] ?? null;
    }
    if (!project) return null;
    return {
      provider: 'supabase',
      engine: 'postgres',
      externalId: project.id,
      providerScope: this.projectScope(project),
      name: project.name,
      status: normalizedSupabaseProjectStatus(project.status),
    };
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const projects = (request.id
      ? [await this.getProject(request.id)].filter((project): project is SupabaseProject => Boolean(project))
      : await this.listProjects()).filter((project) => (
      (!this.credentials!.organizationId || project.organization_id === this.credentials!.organizationId)
      && (!request.name || project.name === request.name)
    ));
    const databases = projects.slice(0, request.limit).map((project) => ({
      id: project.id,
      name: project.name,
      engine: 'postgres',
      status: project.status.toLowerCase(),
      region: project.region,
      providerScope: this.projectScope(project),
    }));
    const ambiguous = Boolean(request.name && projects.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : projects.length > 0 ? 'present' : 'absent',
      resource: 'database',
      databases,
      ...(projects.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: projects.length > request.limit,
      partial: false,
    };
  }

  // Helper methods

  private unresolvedCreateComponent(
    environment: Environment,
    resourceName: string,
    organizationId: string,
    region: string
  ): Component {
    const providerScope = { organizationId, region };
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: this.name,
        providerScope,
        unresolvedMutation: createUnresolvedDatabaseMutation(resourceName, providerScope),
      },
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private async resolveConnectedOrganization(): Promise<SupabaseOrganization> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (this.resolvedOrganization) {
      return this.resolvedOrganization;
    }

    const rawOrganizations = await this.request<unknown>('GET', '/organizations');
    if (!Array.isArray(rawOrganizations)) {
      throw new Error('Supabase credential verification returned an invalid organization list.');
    }

    const organizations: SupabaseOrganization[] = [];
    const seenIds = new Set<string>();
    for (const rawOrganization of rawOrganizations) {
      if (!rawOrganization || typeof rawOrganization !== 'object' || Array.isArray(rawOrganization)) {
        throw new Error('Supabase credential verification returned a malformed organization.');
      }
      const record = rawOrganization as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : undefined;
      if (!id) {
        throw new Error('Supabase credential verification returned an organization without an id.');
      }
      if (seenIds.has(id)) {
        throw new Error(`Supabase credential verification returned duplicate organization ${id}.`);
      }
      seenIds.add(id);
      organizations.push({ id, ...(name ? { name } : {}) });
    }

    const configuredOrganizationId = this.credentials.organizationId;
    if (configuredOrganizationId) {
      const configured = organizations.find(({ id }) => id === configuredOrganizationId);
      if (!configured) {
        const visible = organizations.map(({ id }) => id).sort().join(', ') || 'none';
        throw new Error(
          `Configured Supabase organization ${configuredOrganizationId} is not accessible to the connected token; visible organizations: ${visible}.`
        );
      }
      this.resolvedOrganization = configured;
      return configured;
    }

    if (organizations.length === 0) {
      throw new Error('The connected Supabase token has access to no organizations.');
    }
    if (organizations.length > 1) {
      throw new Error(
        `The connected Supabase token can access multiple organizations (${organizations.map(({ id }) => id).sort().join(', ')}); set organizationId explicitly before managing a database.`
      );
    }

    this.resolvedOrganization = organizations[0]!;
    return this.resolvedOrganization;
  }

  private async assertComponentScope(component: Component): Promise<SupabaseProjectScope> {
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const organizationId = typeof scope?.organizationId === 'string'
      ? scope.organizationId.trim()
      : '';
    const region = typeof scope?.region === 'string' ? scope.region.trim() : '';
    if (!organizationId || !region) {
      throw new Error(
        `Supabase binding ${component.externalId ?? component.id} is missing its durable organizationId/region provider scope; re-import or re-plan the database before using it.`
      );
    }

    const connectedOrganization = await this.resolveConnectedOrganization();
    if (organizationId !== connectedOrganization.id) {
      throw new Error(
        `Supabase binding scope organization ${organizationId} does not match connected organization ${connectedOrganization.id}.`
      );
    }
    return { organizationId, region };
  }

  private assertProjectScope(
    project: SupabaseProject,
    expected: SupabaseProjectScope,
    projectId: string
  ): void {
    const observed = this.projectScope(project);
    if (
      observed.organizationId !== expected.organizationId
      || observed.region !== expected.region
    ) {
      throw new Error(
        `Supabase project ${projectId} scope ${observed.organizationId}/${observed.region} does not match persisted scope ${expected.organizationId}/${expected.region}.`
      );
    }
  }

  private async listProjects(): Promise<SupabaseProject[]> {
    const projects = await this.request<SupabaseProject[]>('GET', '/projects');
    if (!Array.isArray(projects)) {
      throw new Error('Supabase project observation returned an invalid project list.');
    }
    for (const project of projects) {
      if (!project || typeof project !== 'object' || Array.isArray(project) || !project.id || !project.name) {
        throw new Error('Supabase project observation returned a malformed project.');
      }
      this.projectScope(project);
    }
    return projects;
  }

  private async getProject(projectId: string): Promise<SupabaseProject | null> {
    try {
      const project = await this.request<SupabaseProject>('GET', `/projects/${projectId}`);
      if (!project?.id) {
        throw new Error(
          `Supabase returned an invalid project response for ${projectId}; absence was not confirmed.`
        );
      }
      if (project.id !== projectId) {
        throw new Error(
          `Supabase returned project ${project.id} for exact project lookup ${projectId}.`
        );
      }
      return project;
    } catch (error) {
      if (error instanceof SupabaseApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async findProjectsByName(organizationId: string, name: string): Promise<SupabaseProject[]> {
    const normalized = name.toLowerCase();
    const projects = await this.listProjects();
    return projects.filter((project) =>
      project.organization_id === organizationId
      && project.name.toLowerCase() === normalized
    );
  }

  private async recoverCreatedProject(
    organizationId: string,
    projectName: string
  ): Promise<SupabaseProject | null> {
    const attempts = Math.max(
      1,
      Number(process.env.HYPERVIBE_SUPABASE_CREATE_RECOVERY_ATTEMPTS ?? 3) || 3
    );
    const delayMs = Math.max(
      0,
      Number(process.env.HYPERVIBE_SUPABASE_CREATE_RECOVERY_DELAY_MS ?? 1000) || 0
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const matches = await this.findProjectsByName(organizationId, projectName);
      if (matches.length > 1) {
        throw new Error(
          `Supabase returned multiple projects named ${projectName} in organization ${organizationId} after an uncertain create; no identity was selected.`
        );
      }
      if (matches.length === 1) return matches[0]!;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private projectScope(project: SupabaseProject): SupabaseProjectScope {
    if (
      typeof project.organization_id !== 'string'
      || !project.organization_id.trim()
      || typeof project.region !== 'string'
      || !project.region.trim()
    ) {
      throw new Error(
        `Supabase project ${project.id || 'without an id'} did not return durable organization and region scope.`
      );
    }
    return {
      organizationId: project.organization_id.trim(),
      region: project.region.trim(),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(`${SUPABASE_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new SupabaseApiError(response.status, text);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async waitForDatabaseReadiness(
    projectId: string,
    host: string,
    connectionUrl: string
  ): Promise<{ ready: boolean; attempts: number; status?: string; error?: string }> {
    const maxAttempts = Number(process.env.HYPERVIBE_SUPABASE_READY_ATTEMPTS ?? 20);
    const delayMs = Number(process.env.HYPERVIBE_SUPABASE_READY_DELAY_MS ?? 15000);
    let lastStatus: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const latest = await this.request<SupabaseProject>('GET', `/projects/${projectId}`);
        lastStatus = latest.status;
        await lookup(host);
        const client = new Client({
          connectionString: connectionUrl,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 10000,
        });
        try {
          await client.connect();
          await client.query('select 1');
          return { ready: true, attempts: attempt, status: lastStatus };
        } finally {
          await client.end().catch(() => {});
        }
      } catch (error) {
        lastError = this.formatError(error);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return {
      ready: false,
      attempts: maxAttempts,
      status: lastStatus,
      error: lastError,
    };
  }

  private formatError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const causeRecord = cause as Record<string, unknown>;
      const details = [causeRecord.code, causeRecord.errno, causeRecord.syscall, causeRecord.hostname]
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        .join(' ');
      return details ? `${error.message} (${details})` : error.message;
    }
    return error.message;
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'supabase',
    displayName: 'Supabase',
    category: 'database',
    credentialsSchema: SupabaseCredentialsSchema,
    setupHelpUrl: 'https://supabase.com/dashboard/account/tokens',
    credentials: {
      defaultScalarKey: 'accessToken',
    },
    maturity: {
      lifecycle: {
        database: { status: 'ready-for-live' },
      },
    },
    lifecycle: {
      databaseEngines: ['postgres'],
    },
  },
  inspection: {
    resources: ['database'],
    defaultResource: 'database',
    selectors: {
      database: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['organizationId'],
      },
    },
    inspect: (adapter, request) => (
      adapter as SupabaseAdapter
    ).inspectDatabaseResources(request),
  },
  factory: async (credentials) => {
    const adapter = new SupabaseAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
});
