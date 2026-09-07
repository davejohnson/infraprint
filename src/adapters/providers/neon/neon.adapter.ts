import { z } from 'zod';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  DatabaseCapabilities,
  IDatabaseAdapter,
  ProvisionableType,
  ProvisionResult,
} from '../../../domain/ports/database.port.js';
import {
  createUnresolvedDatabaseMutation,
  databaseCreateMayHaveCommitted,
  parseUnresolvedDatabaseMutation,
} from '../../../domain/ports/database.port.js';
import type { ObservedDatabase } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

export const NeonCredentialsSchema = z.object({
  apiKey: z
    .string({ required_error: 'Neon API key is required' })
    .min(1, 'Neon API key is required'),
  organizationId: z.string().min(1).optional(),
  regionId: z.string().min(1).optional(),
});

export type NeonCredentials = z.infer<typeof NeonCredentialsSchema>;

const NEON_API_URL = 'https://console.neon.tech/api/v2';

interface NeonProject {
  id: string;
  name: string;
  region_id?: string;
  org_id?: string;
  pg_version?: number;
}

interface NeonOperation {
  id: string;
  project_id: string;
  status:
    | 'scheduling'
    | 'running'
    | 'finished'
    | 'failed'
    | 'cancelling'
    | 'cancelled'
    | 'skipped'
    | 'error';
  failures_count?: number;
}

interface NeonListProjectsResponse {
  projects: NeonProject[];
  pagination?: {
    cursor?: string;
    next?: string;
  };
  unavailable?: unknown[];
  unavailable_project_ids?: string[];
}

interface NeonCreateProjectResponse {
  project: NeonProject;
  branch?: { id: string; name: string };
  databases?: Array<{ name: string; owner_name?: string }>;
  roles?: Array<{ name: string; protected?: boolean }>;
  endpoints?: Array<{ id: string; host?: string }>;
  operations?: NeonOperation[];
}

interface NeonProjectResponse {
  project: NeonProject;
}

interface NeonOperationResponse {
  operation: NeonOperation;
}

interface NeonConnectionUriResponse {
  uri: string;
}

interface NeonRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface OperationWaitResult {
  ready: boolean;
  operation?: NeonOperation;
  attempts: number;
}

class NeonApiError extends Error {
  constructor(
    readonly status: number,
    detail?: string
  ) {
    super(`Neon API error: ${status}${detail ? ` ${detail}` : ''}`);
    this.name = 'NeonApiError';
  }
}

export class NeonAdapter implements IDatabaseAdapter {
  readonly name = 'neon';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: true,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: false,
    serverlessOptimized: true,
  };

  private credentials: NeonCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = NeonCredentialsSchema.parse(credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const response = await this.request<NeonListProjectsResponse>('GET', '/projects', {
        query: {
          limit: 1,
          org_id: this.credentials.organizationId,
        },
      });
      this.assertCompleteProjectList(response);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
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
      return {
        component: this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: `Neon only supports PostgreSQL. Requested type: ${type}`,
        },
      };
    }

    const resourceName = options?.resourceName ?? `${environment.name}-db`;
    const databaseName = options?.databaseName ?? 'app';
    const organizationId = this.credentials.organizationId?.trim();
    if (!organizationId) {
      return {
        component: this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: 'Failed to provision Neon project',
          error: 'Neon organizationId is required for a durably scoped database create. Add it to the Neon connection before running hv_plan/hv_apply.',
        },
      };
    }
    let created: NeonCreateProjectResponse | undefined;
    let createMutationAttempted = false;
    let unresolvedCreateOutcome = false;

    try {
      let matches: NeonProject[];
      try {
        matches = await this.findProjectsByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether Neon project "${resourceName}" already exists, so Hypervibe refused to create a project that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `Neon project "${resourceName}" already exists: ${matches
            .map((project) => `${project.name} (${project.id})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended project or remove the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      const regionId = options?.region ?? this.credentials.regionId;
      createMutationAttempted = true;
      let acknowledged: NeonCreateProjectResponse;
      try {
        acknowledged = await this.request<NeonCreateProjectResponse>('POST', '/projects', {
          query: {
            org_id: organizationId,
          },
          body: {
            project: {
              name: resourceName,
              ...(regionId ? { region_id: regionId } : {}),
              branch: {
                name: 'main',
                database_name: databaseName,
              },
            },
          },
        });
        unresolvedCreateOutcome = true;
      } catch (error) {
        unresolvedCreateOutcome = databaseCreateMayHaveCommitted(error);
        throw error;
      }
      if (
        acknowledged?.project
        && typeof acknowledged.project.id === 'string'
        && acknowledged.project.id.trim()
        && acknowledged.project.id === acknowledged.project.id.trim()
      ) {
        created = acknowledged;
        unresolvedCreateOutcome = false;
      }
      if (
        !created
        || acknowledged.project.name !== resourceName
        || Boolean(
          acknowledged.project.org_id
          && this.credentials.organizationId
          && acknowledged.project.org_id !== this.credentials.organizationId
        )
        || Boolean(
          acknowledged.project.region_id
          && regionId
          && acknowledged.project.region_id !== regionId
        )
      ) {
        throw new Error(
          `Neon acknowledged project creation without the exact expected ${resourceName} identity.`
        );
      }

      const projectId = created.project.id;
      const operationResult = await this.waitForOperations(
        projectId,
        created.operations ?? []
      );
      if (!operationResult.ready) {
        return {
          component: this.createdComponent(environment, created, databaseName),
          receipt: {
            success: false,
            message: 'Neon created the project, but readiness could not be proven',
            error: operationResult.operation
              ? `Neon operation ${operationResult.operation.id} did not finish after ${operationResult.attempts} checks (last status: ${operationResult.operation.status}).`
              : 'Neon project creation did not reach a verified ready state.',
            data: {
              projectId,
              regionId: created.project.region_id,
              ...(operationResult.operation ? {
                operationId: operationResult.operation.id,
                operationStatus: operationResult.operation.status,
              } : {}),
              attempts: operationResult.attempts,
            },
          },
        };
      }

      const databaseRecord = created.databases?.find(
        (candidate) => candidate.name === databaseName
      ) ?? created.databases?.[0];
      const database = databaseRecord?.name ?? databaseName;
      const roleName = databaseRecord?.owner_name
        ?? created.roles?.find((candidate) => candidate.protected !== true)?.name;
      if (!roleName) {
        return {
          component: this.createdComponent(environment, created, database),
          receipt: {
            success: false,
            message: 'Neon created the project, but connection metadata is incomplete',
            error: `Project ${projectId} did not return a database role, so Hypervibe did not attempt to retrieve a connection URI.`,
            data: {
              projectId,
              regionId: created.project.region_id,
            },
          },
        };
      }

      const branchId = created.branch?.id;
      const endpointId = created.endpoints?.[0]?.id;
      const directUrl = await this.retrieveConnectionUri(projectId, {
        database,
        roleName,
        branchId,
        endpointId,
        pooled: false,
      });
      const pooledUrl = await this.retrieveConnectionUri(projectId, {
        database,
        roleName,
        branchId,
        endpointId,
        pooled: true,
      });
      const parsed = this.parseConnectionUri(directUrl);

      const component: Component = {
        ...this.createdComponent(environment, created, database),
        bindings: {
          provider: 'neon',
          instanceId: projectId,
          providerScope: this.projectScope(created.project),
          connectionString: directUrl,
          pooledUrl,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          password: parsed.password,
          database,
          roleName,
          ...(branchId ? { branchId } : {}),
          ...(endpointId ? { endpointId } : {}),
        },
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created Neon project: ${created.project.name}`,
          data: {
            projectId,
            regionId: created.project.region_id,
            ready: true,
            operations: (created.operations ?? []).map((operation) => operation.id),
          },
        },
        connectionUrl: directUrl,
        envVars: {
          DATABASE_URL: pooledUrl,
          DIRECT_URL: directUrl,
          DATABASE_POOLER_URL: pooledUrl,
          DATABASE_SSL: 'true',
          PGHOST: parsed.host,
          PGPORT: String(parsed.port),
          PGUSER: parsed.username,
          PGPASSWORD: parsed.password,
          PGDATABASE: database,
        },
      };
    } catch (error) {
      let recoveryError: string | undefined;
      if (!created && unresolvedCreateOutcome) {
        try {
          created = await this.recoverCreatedProject(resourceName) ?? undefined;
        } catch (recoveryFailure) {
          recoveryError = this.formatError(recoveryFailure);
        }
      }
      const unresolvedComponent = !created && unresolvedCreateOutcome
        ? this.unresolvedCreateComponent(environment, resourceName, organizationId, databaseName)
        : undefined;
      return {
        component: created
          ? this.createdComponent(environment, created, databaseName)
          : unresolvedComponent ?? this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: created
            ? 'Neon created the project, but provisioning did not complete'
            : 'Failed to provision Neon project',
          error: `${this.formatError(error)}${recoveryError
            ? ` Exact-name recovery also failed: ${recoveryError}`
            : ''}`,
          ...(created ? {
            data: {
              projectId: created.project.id,
              regionId: created.project.region_id,
            },
          } : unresolvedComponent ? {
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
    if (component.externalId) this.assertComponentScope(component);
    const bindings = component.bindings as {
      connectionString?: string;
      database?: string;
      roleName?: string;
      branchId?: string;
      endpointId?: string;
    };
    if (bindings.connectionString) {
      return bindings.connectionString;
    }
    if (!component.externalId || !bindings.database || !bindings.roleName) {
      return null;
    }

    return this.retrieveConnectionUri(component.externalId, {
      database: bindings.database,
      roleName: bindings.roleName,
      branchId: bindings.branchId,
      endpointId: bindings.endpointId,
      pooled: false,
    });
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }

    const projectId = component.externalId;
    try {
      this.assertComponentScope(component);
      const existing = await this.getProject(projectId);
      if (!existing) {
        return {
          success: true,
          message: `Neon project is already absent: ${projectId}`,
        };
      }

      try {
        await this.request('DELETE', `/projects/${encodeURIComponent(projectId)}`);
      } catch (error) {
        if (this.isNotFound(error)) {
          return {
            success: true,
            message: `Neon project is already absent: ${projectId}`,
          };
        }
        throw error;
      }

      const attempts = this.positiveIntegerEnv('HYPERVIBE_NEON_DELETE_ATTEMPTS', 60);
      const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_NEON_DELETE_DELAY_MS', 1000);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.getProject(projectId)) {
          return {
            success: true,
            message: `Deleted Neon project: ${projectId}`,
          };
        }
        if (attempt < attempts) {
          await this.delay(delayMs);
        }
      }

      return {
        success: false,
        message: 'Neon accepted deletion but the project is still present',
        error: `Project ${projectId} was still observable after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Neon project',
        error: this.formatError(error),
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
      this.assertComponentScope(component);
      const project = await this.getProject(component.externalId);
      return project
        ? { status: 'running', message: `Neon project ${project.id} is present` }
        : { status: 'stopped', message: `Neon project ${component.externalId} is absent` };
    } catch (error) {
      return {
        status: 'unknown',
        message: this.formatError(error),
      };
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
    if (component?.externalId) this.assertComponentScope(component);
    if (unresolved
      && unresolved.providerScope.organizationId !== this.credentials.organizationId) {
      throw new Error(
        `Neon unresolved database create belongs to organization ${unresolved.providerScope.organizationId}, not connected organization ${this.credentials.organizationId ?? 'unspecified'}.`
      );
    }

    let project: NeonProject | null;
    if (component?.externalId) {
      project = await this.getProject(component.externalId);
    } else {
      const expectedName = unresolved?.resourceName
        ?? options?.resourceName
        ?? `${environment.name}-db`;
      const matches = await this.findProjectsByName(expectedName);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Neon projects match "${expectedName}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      project = matches[0] ?? null;
    }

    if (!project) {
      return null;
    }
    return {
      provider: 'neon',
      engine: 'postgres',
      externalId: project.id,
      providerScope: this.projectScope(project),
      name: project.name,
      status: 'running',
    };
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const projects = (request.id
      ? [await this.getProject(request.id)].filter((project): project is NeonProject => Boolean(project))
      : await this.listProjects()).filter((project) => (
      (!this.credentials!.organizationId || project.org_id === this.credentials!.organizationId)
      && (!request.name || project.name.toLowerCase() === request.name.toLowerCase())
    ));
    const databases = projects.slice(0, request.limit).map((project) => ({
      id: project.id,
      name: project.name,
      engine: 'postgres',
      status: 'ready',
      ...(project.pg_version ? { databaseVersion: String(project.pg_version) } : {}),
      ...(project.region_id ? { region: project.region_id } : {}),
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

  private emptyComponent(
    environment: Environment,
    type: ProvisionableType
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private unresolvedCreateComponent(
    environment: Environment,
    resourceName: string,
    organizationId: string,
    database: string
  ): Component {
    const providerScope = { organizationId };
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: this.name,
        providerScope,
        unresolvedMutation: createUnresolvedDatabaseMutation(resourceName, providerScope),
        database,
      },
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private createdComponent(
    environment: Environment,
    response: NeonCreateProjectResponse,
    database: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'neon',
        instanceId: response.project.id,
        providerScope: this.projectScope(response.project),
        database,
        ...(response.roles?.[0]?.name ? { roleName: response.roles[0].name } : {}),
        ...(response.branch?.id ? { branchId: response.branch.id } : {}),
        ...(response.endpoints?.[0]?.id ? { endpointId: response.endpoints[0].id } : {}),
      },
      externalId: response.project.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private async listProjects(): Promise<NeonProject[]> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }
    const projects: NeonProject[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const response = await this.request<NeonListProjectsResponse>('GET', '/projects', {
        query: {
          limit: 400,
          cursor,
          org_id: this.credentials.organizationId,
        },
      });
      this.assertCompleteProjectList(response);
      projects.push(...response.projects);
      const nextCursor = response.pagination?.cursor ?? response.pagination?.next;
      if (!nextCursor) {
        break;
      }
      if (visitedCursors.has(nextCursor)) {
        throw new Error(`Neon project pagination repeated cursor "${nextCursor}"`);
      }
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return projects;
  }

  private projectScope(project: NeonProject): Record<string, string> {
    const organizationId = typeof project.org_id === 'string' && project.org_id.trim()
      ? project.org_id.trim()
      : this.credentials?.organizationId;
    const regionId = typeof project.region_id === 'string' && project.region_id.trim()
      ? project.region_id.trim()
      : this.credentials?.regionId;
    return {
      projectId: project.id,
      ...(organizationId ? { organizationId } : {}),
      ...(regionId ? { regionId } : {}),
    };
  }

  private assertCompleteProjectList(response: NeonListProjectsResponse): void {
    const unavailableCount =
      (Array.isArray(response.unavailable) ? response.unavailable.length : 0)
      + (Array.isArray(response.unavailable_project_ids)
        ? response.unavailable_project_ids.length
        : 0);
    if (unavailableCount > 0) {
      throw new Error(
        `Neon project observation is incomplete: ${unavailableCount} project record(s) were unavailable.`
      );
    }
    if (!Array.isArray(response.projects)) {
      throw new Error('Neon project observation returned an invalid projects list.');
    }
    const ids = new Set<string>();
    for (const project of response.projects) {
      if (
        !project
        || typeof project.id !== 'string'
        || !project.id.trim()
        || typeof project.name !== 'string'
        || !project.name.trim()
      ) {
        throw new Error(
          'Neon project observation returned a project without a durable ID and name.'
        );
      }
      if (ids.has(project.id)) {
        throw new Error(
          `Neon project observation returned duplicate project identity ${project.id}.`
        );
      }
      ids.add(project.id);
    }
  }

  private async findProjectsByName(name: string): Promise<NeonProject[]> {
    const normalized = name.toLowerCase();
    return (await this.listProjects()).filter(
      (project) => project.name.toLowerCase() === normalized
    );
  }

  private async recoverCreatedProject(
    resourceName: string
  ): Promise<NeonCreateProjectResponse | null> {
    const attempts = Math.max(
      1,
      Number(process.env.HYPERVIBE_NEON_CREATE_RECOVERY_ATTEMPTS ?? 3) || 3
    );
    const delayMs = Math.max(
      0,
      Number(process.env.HYPERVIBE_NEON_CREATE_RECOVERY_DELAY_MS ?? 1000) || 0
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const matches = await this.findProjectsByName(resourceName);
      if (matches.length > 1) {
        throw new Error(
          `Neon returned multiple projects named ${resourceName} after an uncertain create; no identity was selected.`
        );
      }
      if (matches.length === 1) return { project: matches[0]! };
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private async getProject(projectId: string): Promise<NeonProject | null> {
    try {
      const response = await this.request<NeonProjectResponse>(
        'GET',
        `/projects/${encodeURIComponent(projectId)}`
      );
      const project = response.project;
      if (
        !project
        || typeof project.id !== 'string'
        || !project.id.trim()
        || typeof project.name !== 'string'
        || !project.name.trim()
      ) {
        throw new Error(
          `Neon returned an invalid project response for ${projectId}; absence was not confirmed.`
        );
      }
      if (project.id !== projectId) {
        throw new Error(
          `Neon returned project ${project.id} for exact project lookup ${projectId}.`
        );
      }
      return project;
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async waitForOperations(
    projectId: string,
    operations: NeonOperation[]
  ): Promise<OperationWaitResult> {
    let totalAttempts = 0;
    for (const initialOperation of operations) {
      if (['finished', 'skipped'].includes(initialOperation.status)) {
        continue;
      }
      if (['cancelled', 'error'].includes(initialOperation.status)) {
        return {
          ready: false,
          operation: initialOperation,
          attempts: totalAttempts,
        };
      }

      const result = await this.waitForOperation(projectId, initialOperation);
      totalAttempts += result.attempts;
      if (!result.ready) {
        return {
          ...result,
          attempts: totalAttempts,
        };
      }
    }
    return {
      ready: true,
      attempts: totalAttempts,
    };
  }

  private async waitForOperation(
    projectId: string,
    initialOperation: NeonOperation
  ): Promise<OperationWaitResult> {
    const attempts = this.positiveIntegerEnv('HYPERVIBE_NEON_OPERATION_ATTEMPTS', 60);
    const delayMs = this.nonNegativeIntegerEnv('HYPERVIBE_NEON_OPERATION_DELAY_MS', 1000);
    let latest = initialOperation;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await this.request<NeonOperationResponse>(
        'GET',
        `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(initialOperation.id)}`
      );
      latest = response.operation;
      if (['finished', 'skipped'].includes(latest.status)) {
        return { ready: true, operation: latest, attempts: attempt };
      }
      if (['cancelled', 'error'].includes(latest.status)) {
        return { ready: false, operation: latest, attempts: attempt };
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }

    return {
      ready: false,
      operation: latest,
      attempts,
    };
  }

  private async retrieveConnectionUri(
    projectId: string,
    options: {
      database: string;
      roleName: string;
      branchId?: string;
      endpointId?: string;
      pooled: boolean;
    }
  ): Promise<string> {
    const response = await this.request<NeonConnectionUriResponse>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/connection_uri`,
      {
        query: {
          database_name: options.database,
          role_name: options.roleName,
          branch_id: options.branchId,
          endpoint_id: options.endpointId,
          pooled: options.pooled,
        },
      }
    );
    if (!response.uri) {
      throw new Error(`Neon did not return a connection URI for project ${projectId}.`);
    }
    return response.uri;
  }

  private parseConnectionUri(uri: string): {
    host: string;
    port: number;
    username: string;
    password: string;
  } {
    const parsed = new URL(uri);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: NeonRequestOptions = {}
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }
    const url = new URL(`${NEON_API_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new NeonApiError(
        response.status,
        text ? this.safeApiError(text) : undefined
      );
    }
    if (response.status === 204) {
      return {} as T;
    }
    return response.json() as Promise<T>;
  }

  private safeApiError(text: string): string {
    const bounded = text.slice(0, 500);
    return bounded
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URL]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof NeonApiError && error.status === 404;
  }

  private assertComponentScope(component: Component): void {
    if (!this.credentials) throw new Error('Neon adapter is not connected.');
    const rawScope = component.bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const projectId = typeof scope?.projectId === 'string'
      ? scope.projectId
      : undefined;
    if (!projectId || projectId !== component.externalId) {
      throw new Error(
        `Neon binding ${component.externalId ?? component.id} is missing or conflicts with its durable projectId provider scope; re-import or re-plan the database before using it.`
      );
    }
    const connectedOrganizationId = this.credentials.organizationId;
    if (!connectedOrganizationId) return;
    const organizationId = typeof scope?.organizationId === 'string'
      ? scope.organizationId
      : undefined;
    if (!organizationId) {
      throw new Error(
        `Neon binding ${component.externalId ?? component.id} is missing its durable organizationId provider scope; re-import or re-plan the database before using it.`
      );
    }
    if (organizationId !== connectedOrganizationId) {
      throw new Error(
        `Neon binding scope organization ${organizationId} does not match connected organization ${connectedOrganizationId}.`
      );
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}

providerRegistry.register({
  metadata: {
    name: 'neon',
    displayName: 'Neon',
    category: 'database',
    credentialsSchema: NeonCredentialsSchema,
    setupHelpUrl: 'https://console.neon.tech/app/settings/api-keys',
    credentials: {
      defaultScalarKey: 'apiKey',
      environmentVariableAliases: [
        ['NEON_API_KEY', 'HYPERVIBE_NEON_API_KEY'],
        ['NEON_ORGANIZATION_ID', 'HYPERVIBE_NEON_ORGANIZATION_ID'],
        ['NEON_REGION_ID', 'HYPERVIBE_NEON_REGION_ID'],
      ],
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
        scopeKeys: ['projectId'],
      },
    },
    inspect: (adapter, request) => (
      adapter as NeonAdapter
    ).inspectDatabaseResources(request),
  },
  factory: async (credentials) => {
    const validated = NeonCredentialsSchema.parse(credentials);
    const adapter = new NeonAdapter();
    await adapter.connect(validated);
    return adapter;
  },
});
