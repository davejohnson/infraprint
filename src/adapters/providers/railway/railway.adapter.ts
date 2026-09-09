import { GraphQLClient, gql } from 'graphql-request';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import type {
  IProviderAdapter,
  Receipt,
  ComponentResult,
  DeployResult,
  JobResult,
  ProviderCapabilities,
  DeploymentMutationOptions,
  TemporaryDatabaseAccess,
  HostingServiceDeleteOptions,
  HostingServiceDeleteScope,
} from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import {
  createHostingServiceCreateRecovery,
  parseHostingBindings,
  parseHostingServiceCreateRecovery,
  type HostingServiceCreateRecovery,
} from '../../../domain/ports/hosting.port.js';
import {
  createStorageCreateRecovery,
  parseStorageCreateRecovery,
  type StorageCreateRecovery,
} from '../../../domain/ports/storage.port.js';
import { githubPackagePullCredentials } from '../github/package-pull.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { hashEnvValue } from '../../../domain/ports/observe.port.js';
import type { ObservedCache, ObservedDatabase, ObservedService, ObservedState, ObservedStorage } from '../../../domain/ports/observe.port.js';
import {
  providerRegistry,
  type DatabaseRuntimeProjection,
} from '../../../domain/registry/provider.registry.js';
import {
  buildRailwayGitHubActionsSteps,
  diagnoseRailwayWorkflowLog,
  RAILWAY_CI_REQUIRED_SECRETS,
} from './railway-ci.workflow.js';
import { buildRailwayPortableRecipe } from './railway-ci.recipe.js';
import {
  normalizeProviderDnsRecord,
  providerDnsRecordsAreConfigured,
  type NormalizedDnsRecord,
} from '../../../domain/services/domain-dns-records.js';
import { inspectRailwayResources } from './railway-inspection.driver.js';
import type {
  IWorkloadMaintenanceAdapter,
  MaintenanceWorkloadObservation,
  MaintenanceWorkloadSnapshot,
} from '../../../domain/ports/maintenance.port.js';
import type {
  IProviderBuildLogsAdapter,
  IProviderDeploymentsAdapter,
  IProviderRuntimeLogsAdapter,
  ProviderBuildLogsRequest,
  ProviderDeployment,
  ProviderDeploymentsRequest,
  ProviderRuntimeLogsRequest,
  ProviderRuntimeLogsResult,
} from '../../../domain/ports/provider-logs.port.js';
import type {
  IProviderEnvironmentVariablesAdapter,
  ProviderEnvironmentVariablesRequest,
  ProviderEnvironmentVariablesResult,
} from '../../../domain/ports/provider-env-vars.port.js';
import { redactExactValues } from '../../../utils/redact-exact-values.js';

// Credentials schema for self-registration
export const RailwayCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
});

export type RailwayCredentials = z.infer<typeof RailwayCredentialsSchema>;

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

export const TASK_EXIT_SENTINEL = /__HYPERVIBE_TASK_EXIT:(\d+)__/;
export const TASK_EXIT_SENTINEL_PREFIX = '__HYPERVIBE_TASK_EXIT:';

type ResourceExistence =
  | { state: 'present' }
  | { state: 'absent' }
  | { state: 'unknown'; error: string };

type DeletionVerification =
  | { deleted: true }
  | { deleted: false; error: string };

type ServiceInstanceInventory =
  | { state: 'complete'; environmentIds: string[] }
  | { state: 'absent' }
  | { state: 'unknown'; error: string };

type RailwayDeploymentStatus = {
  status: string;
  staticUrl?: string;
};

type RailwayDeploymentInstance = {
  environmentId?: string;
  latestDeployment?: RailwayDeploymentStatus;
};

type RailwayDeploymentInstanceSelection =
  | { recognized: false }
  | { recognized: true; instance: RailwayDeploymentInstance | null };

export interface RailwayVolumeTarget {
  projectId: string;
  environmentId: string;
  serviceId: string;
  mountPath: string;
}

export type RailwayVolumeResolution =
  | { success: true; state: 'absent' }
  | { success: true; state: 'present'; volumeId: string; pendingDeletion: boolean }
  | { success: false; error: string; volumeId?: string };

export type RailwayServiceInstanceInspection =
  | {
      state: 'present';
      instanceId: string;
      serviceId: string;
      environmentId: string;
      sourceImage?: string;
    }
  | { state: 'absent' }
  | { state: 'unknown'; error: string };

interface RailwayVolumeInstance {
  instanceId: string;
  volumeId: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  mountPath: string;
  deletedAt: string | null;
  isPendingDeletion: boolean;
}

class RailwayProjectPaginationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectRailwayDatabaseRuntime(
  component: Component,
  standard: DatabaseRuntimeProjection
): DatabaseRuntimeProjection {
  const bindings = component.bindings as Record<string, unknown>;
  const pluginName = typeof bindings.pluginName === 'string' && bindings.pluginName.length > 0
    ? bindings.pluginName
    : undefined;
  if (!pluginName) return standard;

  return {
    envVars: {
      DATABASE_URL: '${{' + pluginName + '.DATABASE_URL}}',
      DIRECT_URL: '${{' + pluginName + '.DATABASE_PRIVATE_URL}}',
    },
    connectionUrl: standard.connectionUrl,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildTaskStartCommand(command: string): string {
  const inner = `${command}; hv_exit=$?; echo "__HYPERVIBE_TASK_EXIT:\${hv_exit}__"; exit $hv_exit`;
  return `/bin/sh -c ${shellSingleQuote(inner)}`;
}

function normalizeRailwayGitRepo(repo?: string): string | undefined {
  if (!repo) {
    return undefined;
  }

  return repo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

function cachedBranchForSource(
  cachedSource: { repo?: string; branch?: string } | undefined,
  sourceRepo: string | undefined
): string | undefined {
  if (!cachedSource?.branch || !sourceRepo) {
    return undefined;
  }
  return normalizeRailwayGitRepo(cachedSource.repo) === normalizeRailwayGitRepo(sourceRepo)
    ? cachedSource.branch
    : undefined;
}

function railwayNamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    || 'default';
}

export class RailwayAdapter implements
  IProviderAdapter,
  IWorkloadMaintenanceAdapter,
  IProviderRuntimeLogsAdapter,
  IProviderDeploymentsAdapter,
  IProviderBuildLogsAdapter,
  IProviderEnvironmentVariablesAdapter {
  readonly name = 'railway';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['nixpacks', 'dockerfile'],
    supportedComponents: ['postgres'],
    supportsAutoWiring: true,
    supportsHealthChecks: true,
    supportsCronSchedule: true,
    supportsReleaseCommand: true, // mapped to Railway's preDeployCommand
    supportsMultiEnvironment: true,
    managedTls: true,
    supportsObserve: true,
    queues: { backend: 'postgres' },
    supportsOneOffTasks: true,
    supportsDeferredDeploy: true,
    supportsTemporaryDatabaseAccess: true,
    supportsMaintenance: true,
  };

  private client: GraphQLClient | null = null;
  private credentials: RailwayCredentials | null = null;
  private resolvedWorkspaceId: string | null | undefined;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as RailwayCredentials;
    this.resolvedWorkspaceId = undefined;
    this.client = new GraphQLClient(RAILWAY_API_URL, {
      headers: {
        Authorization: `Bearer ${this.credentials.apiToken}`,
      },
    });
  }

  async verify(): Promise<{
    success: boolean;
    error?: string;
    email?: string;
    workspaceId?: string;
    workspaces?: Array<{ id: string; name?: string }>;
  }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const query = gql`
        query Me {
          me {
            id
            email
          }
        }
      `;
      const result = await this.client.request<{ me: { id: string; email: string } }>(query);
      if (result.me?.id) {
        const workspaces = await this.getWorkspaces();
        const workspaceId = await this.resolveWorkspaceId();
        return { success: true, email: result.me.email, workspaceId: workspaceId ?? undefined, workspaces };
      }
      return { success: false, error: 'No user returned from Railway API' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.credentials = null;
    this.resolvedWorkspaceId = undefined;
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      // Check if we already have a project ID bound
      const bindings = environment.platformBindings as { projectId?: string };
      const existingProjectId = bindings.projectId;
      if (existingProjectId) {
        let existing: { id: string; name: string } | null;
        try {
          existing = await this.getProjectIdentity(existingProjectId);
        } catch (error) {
          return {
            success: false,
            message: 'Failed to ensure Railway project',
            error: `Could not verify bound Railway project ${existingProjectId}, so Hypervibe refused to replace or rebind it: ${this.describeError(error)}`,
            data: { projectId: existingProjectId, verification: 'unknown' },
          };
        }
        if (existing) {
          return {
            success: true,
            message: `Using existing Railway project: ${existing.name}`,
            data: { projectId: existing.id, projectName: existing.name, created: false },
          };
        }
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: `Bound Railway project ${existingProjectId} is absent. Hypervibe will not silently create a replacement or adopt a same-name project; re-run hv_plan after clearing or importing the intended binding.`,
          data: { projectId: existingProjectId, verification: 'absent' },
        };
      }

      let existingByName: RailwayProject[];
      try {
        existingByName = await this.findProjectsByName(projectName);
      } catch (error) {
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: [
            `Could not check whether Railway project "${projectName}" already exists, so Hypervibe refused to create a new project that might be a duplicate.`,
            this.describeError(error),
          ].join(' '),
        };
      }
      if (existingByName.length === 1) {
        const existing = existingByName[0];
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: `Railway project "${existing.name}" (${existing.id}) already exists but is not bound to this environment. Hypervibe will not silently adopt it; use hv_import to adopt that exact project, then run hv_plan again.`,
          data: {
            projectName,
            adoptionCandidateProjectId: existing.id,
          },
        };
      }
      if (existingByName.length > 1) {
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: [
            `Multiple Railway projects named "${projectName}" are visible: ${existingByName.map((p) => `${p.name} (${p.id})`).join(', ')}.`,
            'Hypervibe will not create another project or guess which duplicate to manage. Bind/import the intended Railway project id or delete the duplicate, then run hv_plan again.',
          ].join(' '),
          data: {
            projectName,
            duplicateProjectIds: existingByName.map((p) => p.id),
          },
        };
      }

      // Railway has used multiple input names over time. A second mutation is
      // safe only when GraphQL validation proves the previous resolver never
      // ran; transport failures and malformed acknowledgements are unknown.
      let created: { id: string; name?: string } | null = null;
      let createError: string | undefined;
      try {
        created = await this.createProject(projectName);
      } catch (error) {
        createError = this.describeError(error);
      }
      if (!created) {
        return {
          success: false,
          message: 'Failed to ensure Railway project',
          error: createError || `Unable to create project "${projectName}" on Railway`,
        };
      }

      let verified: { id: string; name: string } | null;
      try {
        verified = await this.waitForProjectIdentity(created.id, projectName);
      } catch (error) {
        return {
          success: false,
          message: `Created Railway project "${projectName}" but could not verify it`,
          error: this.describeError(error),
          data: { projectId: created.id, projectName: created.name ?? projectName, created: true, verification: 'unknown' },
        };
      }
      if (!verified) {
        return {
          success: false,
          message: `Created Railway project "${projectName}" but verification did not find it`,
          error: 'Provider project creation is not yet confirmed. Re-run hv_plan before retrying.',
          data: { projectId: created.id, projectName: created.name ?? projectName, created: true, verification: 'absent' },
        };
      }

      return {
        success: true,
        message: `Created Railway project: ${verified.name}`,
        data: {
          projectId: verified.id,
          projectName: verified.name,
          created: true,
        },
      };
    } catch (error) {
      const message = this.describeError(error);
      return {
        success: false,
        message: 'Failed to ensure Railway project',
        error: message,
      };
    }
  }

  async ensureEnvironment(environment: Environment): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
    };
    const projectId = bindings.projectId;
    if (!projectId) {
      return {
        success: false,
        message: `Failed to ensure Railway environment "${environment.name}"`,
        error: 'Railway project binding is missing. Apply the project action first.',
      };
    }

    let details: RailwayProjectDetails | null;
    try {
      details = await this.getProjectDetails(projectId);
    } catch (error) {
      return {
        success: false,
        message: `Failed to ensure Railway environment "${environment.name}"`,
        error: `Could not observe Railway environments, so Hypervibe refused to create one: ${this.describeError(error)}`,
      };
    }
    if (!details) {
      return {
        success: false,
        message: `Failed to ensure Railway environment "${environment.name}"`,
        error: `Bound Railway project ${projectId} was not found. Re-run hv_plan before applying.`,
      };
    }

    const environments = details.environments.edges.map((edge) => edge.node);
    const bound = bindings.environmentId
      ? environments.find((candidate) => candidate.id === bindings.environmentId)
      : undefined;
    if (bound) {
      return {
        success: true,
        message: `Using existing Railway environment: ${bound.name}`,
        data: {
          projectId,
          environmentId: bound.id,
          environmentName: bound.name,
          created: false,
        },
      };
    }
    if (bindings.environmentId) {
      return {
        success: false,
        message: `Failed to ensure Railway environment "${environment.name}"`,
        error: `Bound Railway environment ${bindings.environmentId} is absent from project ${projectId}. Hypervibe will not silently replace it or adopt a same-name environment; re-run hv_plan after clearing or importing the intended binding.`,
        data: { projectId, environmentId: bindings.environmentId, verification: 'absent' },
      };
    }

    const named = environments.filter(
      (candidate) => candidate.name.toLowerCase() === environment.name.toLowerCase()
    );
    if (named.length > 1) {
      return {
        success: false,
        message: `Failed to ensure Railway environment "${environment.name}"`,
        error: `Multiple Railway environments named "${environment.name}" are visible. Hypervibe will not guess which one to bind.`,
        data: { duplicateEnvironmentIds: named.map((candidate) => candidate.id).sort() },
      };
    }
    if (named.length === 1) {
      const existing = named[0]!;
      return {
        success: false,
        message: `Failed to ensure Railway environment "${environment.name}"`,
        error: `Railway environment "${existing.name}" (${existing.id}) already exists but is not bound locally. Hypervibe will not silently adopt it; use hv_import to adopt that exact environment, then run hv_plan again.`,
        data: {
          projectId,
          adoptionCandidateEnvironmentId: existing.id,
        },
      };
    }

    let environmentId: string | undefined;
    try {
      environmentId = await this.createRailwayEnvironment(projectId, environment.name);
    } catch (error) {
      return {
        success: false,
        message: `Failed to create Railway environment "${environment.name}"`,
        error: this.describeError(error),
      };
    }
    if (!environmentId) {
      return {
        success: false,
        message: `Failed to create Railway environment "${environment.name}"`,
        error: 'Railway returned no environment id. Re-run hv_plan before retrying.',
      };
    }

    let verifiedEnvironment: { id: string; name: string } | null;
    try {
      verifiedEnvironment = await this.waitForEnvironmentIdentity(
        projectId,
        environmentId,
        environment.name
      );
    } catch (error) {
      return {
        success: false,
        message: `Created Railway environment "${environment.name}" but could not verify it`,
        error: this.describeError(error),
        data: { projectId, environmentId, created: true, verification: 'unknown' },
      };
    }
    if (!verifiedEnvironment) {
      return {
        success: false,
        message: `Created Railway environment "${environment.name}" but verification did not find it`,
        error: 'Provider environment creation is not yet confirmed. Re-run hv_plan before retrying.',
        data: { projectId, environmentId, created: true, verification: 'absent' },
      };
    }
    return {
      success: true,
      message: `Created Railway environment: ${verifiedEnvironment.name}`,
      data: {
        projectId,
        environmentId: verifiedEnvironment.id,
        environmentName: verifiedEnvironment.name,
        created: true,
      },
    };
  }

  private async createProject(projectName: string): Promise<{ id: string; name?: string }> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const workspaceId = await this.resolveWorkspaceId();

    const attempts: Array<{ mutation: string; variables: Record<string, unknown>; label: string }> = workspaceId
      ? [{
        label: 'input.workspaceId',
        mutation: `
          mutation CreateProject($name: String!, $workspaceId: String!) {
            projectCreate(input: { name: $name, workspaceId: $workspaceId }) {
              id
              name
            }
          }
        `,
        variables: { name: projectName, workspaceId },
      }, {
        label: 'input.teamId',
        mutation: `
          mutation CreateProject($name: String!, $teamId: String) {
            projectCreate(input: { name: $name, teamId: $teamId }) {
              id
              name
            }
          }
        `,
        variables: { name: projectName, teamId: this.credentials?.teamId ?? workspaceId },
      }]
      : [{
        label: 'input.name_only',
        mutation: `
          mutation CreateProject($name: String!) {
            projectCreate(input: { name: $name }) {
              id
              name
            }
          }
        `,
        variables: { name: projectName },
      }];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await this.client.request<unknown>(
          gql`${attempt.mutation}`,
          attempt.variables
        );
        if (!isRecord(result) || !isRecord(result.projectCreate)) {
          throw new Error(`${attempt.label}: Railway returned an invalid projectCreate acknowledgement; creation state is unknown and Hypervibe will not issue another mutation.`);
        }
        const id = result.projectCreate.id;
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error(`${attempt.label}: Railway returned a projectCreate acknowledgement without an id; creation state is unknown and Hypervibe will not issue another mutation.`);
        }
        const name = typeof result.projectCreate.name === 'string' && result.projectCreate.name.length > 0
          ? result.projectCreate.name
          : undefined;
        return { id, ...(name ? { name } : {}) };
      } catch (error) {
        if (!this.isGraphqlSchemaCompatibilityError(error)) {
          throw error;
        }
        errors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }

    throw new Error(`Railway project creation is unsupported by the available GraphQL schema variants: ${errors.join(' | ')}`);
  }

  private async resolveWorkspaceId(): Promise<string | null> {
    if (this.resolvedWorkspaceId !== undefined) {
      return this.resolvedWorkspaceId;
    }
    if (!this.client) {
      this.resolvedWorkspaceId = null;
      return this.resolvedWorkspaceId;
    }

    if (this.credentials?.workspaceId) {
      this.resolvedWorkspaceId = this.credentials.workspaceId;
      return this.resolvedWorkspaceId;
    }

    // Backward compatibility: some users stored teamId previously.
    if (this.credentials?.teamId) {
      this.resolvedWorkspaceId = this.credentials.teamId;
      return this.resolvedWorkspaceId;
    }

    const workspaces = await this.getWorkspaces();
    if (workspaces.length > 1) {
      throw new Error(
        `Multiple Railway workspaces are visible (${workspaces.map((workspace) => `${workspace.name ?? 'unnamed'} (${workspace.id})`).join(', ')}). Set credentials.workspaceId explicitly; Hypervibe will not guess a project-creation scope.`
      );
    }
    this.resolvedWorkspaceId = workspaces[0]?.id ?? null;
    return this.resolvedWorkspaceId;
  }

  private async getWorkspaces(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const attempts: Array<{
      label: string;
      query: string;
      parse: (payload: unknown) => Array<{ id: string; name?: string }>;
    }> = [
      {
        label: 'me.workspaces.edges',
        // Connection-style shape (older API responses)
        query: `
          query MyWorkspacesConnection {
            me {
              workspaces {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
        parse: (payload) => {
          if (!isRecord(payload) || !isRecord(payload.me) || !isRecord(payload.me.workspaces)
            || !Array.isArray(payload.me.workspaces.edges)) {
            throw new Error('Railway returned an invalid me.workspaces connection.');
          }
          return payload.me.workspaces.edges.map((edge, index) => {
            if (!isRecord(edge) || !isRecord(edge.node)
              || typeof edge.node.id !== 'string' || edge.node.id.length === 0
              || (edge.node.name !== undefined && typeof edge.node.name !== 'string')) {
              throw new Error(`Railway returned an invalid workspace at edge ${index}.`);
            }
            return {
              id: edge.node.id,
              ...(typeof edge.node.name === 'string' ? { name: edge.node.name } : {}),
            };
          });
        },
      },
      {
        label: 'me.workspaces direct',
        // Direct array/object shape (newer API responses)
        query: `
          query MyWorkspacesDirect {
            me {
              workspaces {
                id
                name
              }
            }
          }
        `,
        parse: (payload) => {
          if (!isRecord(payload) || !isRecord(payload.me) || !('workspaces' in payload.me)) {
            throw new Error('Railway returned an invalid direct workspace inventory.');
          }
          const raw = payload.me.workspaces;
          const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : null;
          if (!list) {
            throw new Error('Railway returned an invalid direct workspace collection.');
          }
          return list.map((workspace, index) => {
            if (!isRecord(workspace) || typeof workspace.id !== 'string' || workspace.id.length === 0
              || (workspace.name !== undefined && typeof workspace.name !== 'string')) {
              throw new Error(`Railway returned an invalid workspace at index ${index}.`);
            }
            return {
              id: workspace.id,
              ...(typeof workspace.name === 'string' ? { name: workspace.name } : {}),
            };
          });
        },
      },
      {
        label: 'me.workspace',
        // Singular workspace shape fallback
        query: `
          query MyWorkspaceSingular {
            me {
              workspace {
                id
                name
              }
            }
          }
        `,
        parse: (payload) => {
          if (!isRecord(payload) || !isRecord(payload.me) || !('workspace' in payload.me)) {
            throw new Error('Railway returned an invalid singular workspace inventory.');
          }
          const workspace = payload.me.workspace;
          if (workspace === null) return [];
          if (!isRecord(workspace) || typeof workspace.id !== 'string' || workspace.id.length === 0
            || (workspace.name !== undefined && typeof workspace.name !== 'string')) {
            throw new Error('Railway returned an invalid singular workspace.');
          }
          return [{
            id: workspace.id,
            ...(typeof workspace.name === 'string' ? { name: workspace.name } : {}),
          }];
        },
      },
    ];

    const schemaErrors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await this.client.request<unknown>(gql`${attempt.query}`);
        const parsed = attempt.parse(result);
        const seen = new Set<string>();
        for (const workspace of parsed) {
          if (seen.has(workspace.id)) {
            throw new Error(`Railway returned duplicate workspace id ${workspace.id}.`);
          }
          seen.add(workspace.id);
        }
        return parsed;
      } catch (error) {
        if (!this.isGraphqlSchemaCompatibilityError(error)) {
          throw error;
        }
        schemaErrors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }

    throw new Error(`Railway workspace observation is unsupported by the available GraphQL schema variants: ${schemaErrors.join(' | ')}`);
  }

  private async getProjectIdentity(projectId: string): Promise<{ id: string; name: string } | null> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const query = gql`
      query GetProjectIdentity($id: String!) {
        project(id: $id) {
          id
          name
        }
      }
    `;
    try {
      const result = await this.client.request<unknown>(query, { id: projectId });
      if (!isRecord(result) || !('project' in result)) {
        throw new Error(`Railway returned an invalid project identity response for ${projectId}.`);
      }
      if (result.project === null) return null;
      if (!isRecord(result.project)
        || typeof result.project.id !== 'string'
        || result.project.id !== projectId
        || typeof result.project.name !== 'string'
        || result.project.name.length === 0) {
        throw new Error(`Railway returned a partial or mismatched project identity for ${projectId}.`);
      }
      return { id: result.project.id, name: result.project.name };
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'project')) return null;
      throw error;
    }
  }

  private async waitForProjectIdentity(
    projectId: string,
    expectedName: string
  ): Promise<{ id: string; name: string } | null> {
    const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS ?? 10);
    const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS ?? 250);
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
      ? Math.floor(configuredAttempts)
      : 10;
    const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
      ? configuredDelayMs
      : 250;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const project = await this.getProjectIdentity(projectId);
      if (project) {
        if (project.name !== expectedName) {
          throw new Error(`Railway project ${projectId} was expected to be named "${expectedName}" but is named "${project.name}".`);
        }
        return project;
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }
    return null;
  }

  private async waitForEnvironmentIdentity(
    projectId: string,
    environmentId: string,
    expectedName: string
  ): Promise<{ id: string; name: string } | null> {
    const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS ?? 10);
    const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS ?? 250);
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
      ? Math.floor(configuredAttempts)
      : 10;
    const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
      ? configuredDelayMs
      : 250;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const project = await this.getProjectDetails(projectId);
      if (!project) {
        throw new Error(`Railway project ${projectId} disappeared while verifying environment ${environmentId}.`);
      }
      const matches = project.environments.edges
        .map((edge) => edge.node)
        .filter((environment) => environment.id === environmentId);
      if (matches.length > 1) {
        throw new Error(`Railway returned duplicate environment id ${environmentId} in project ${projectId}.`);
      }
      const environment = matches[0];
      if (environment) {
        if (environment.name !== expectedName) {
          throw new Error(`Railway environment ${environmentId} was expected to be named "${expectedName}" but is named "${environment.name}".`);
        }
        return { id: environment.id, name: environment.name };
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }
    return null;
  }

  private isGraphqlSchemaCompatibilityError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const response = (error as Error & {
      response?: {
        errors?: Array<{
          message?: string;
          path?: Array<string | number>;
          extensions?: Record<string, unknown>;
        }>;
      };
    }).response;
    const errors = response?.errors;
    if (!Array.isArray(errors) || errors.length === 0) return false;

    const schemaMessage = /^(Cannot query field|Unknown argument|Unknown type|Unknown field|Variable .+ is never used|Field .+ is not defined by type|Field .+ must not have a selection|Field .+ must have a selection of subfields)/i;
    return errors.every((entry) => {
      if (Array.isArray(entry.path) && entry.path.length > 0) return false;
      const code = typeof entry.extensions?.code === 'string'
        ? entry.extensions.code.toUpperCase()
        : undefined;
      return code === 'GRAPHQL_VALIDATION_FAILED'
        || (typeof entry.message === 'string' && schemaMessage.test(entry.message));
    });
  }

  private isProviderConfirmedNotFound(error: unknown, expectedRootField: string): boolean {
    if (!(error instanceof Error)) return false;
    const response = (error as Error & {
      response?: {
        status?: number;
        errors?: Array<{ extensions?: Record<string, unknown> }>;
      };
    }).response;
    const errors = response?.errors;
    if (!Array.isArray(errors) || errors.length === 0) return false;
    return errors.every((entry) => {
      const path = (entry as { path?: Array<string | number> }).path;
      const code = typeof entry.extensions?.code === 'string'
        ? entry.extensions.code.toUpperCase()
        : undefined;
      const statusCode = entry.extensions?.statusCode;
      const exactRoot = Array.isArray(path)
        && path.length === 1
        && path[0] === expectedRootField;
      return exactRoot && (
        code === 'NOT_FOUND'
          || code === 'RESOURCE_NOT_FOUND'
          || statusCode === 404
          || statusCode === '404'
      );
    });
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      const anyError = error as Error & {
        response?: {
          errors?: Array<{
            message?: string;
            path?: Array<string | number>;
            extensions?: Record<string, unknown>;
          }>;
          status?: number;
        };
      };
      const gqlErrors = anyError.response?.errors ?? [];
      if (gqlErrors.length > 0) {
        return gqlErrors
          .map((entry) => {
            const details = [
              typeof entry.extensions?.code === 'string' ? `code: ${entry.extensions.code}` : undefined,
              typeof entry.extensions?.statusCode === 'number' ? `status: ${entry.extensions.statusCode}` : undefined,
              entry.path?.length ? `path: ${entry.path.join('.')}` : undefined,
            ].filter(Boolean);
            const suffix = details.length ? ` (${details.join(', ')})` : '';
            return `${entry.message ?? 'Unknown GraphQL error'}${suffix}`;
          })
          .join('; ');
      }
      if (anyError.response?.status) {
        return `${error.message} (HTTP ${anyError.response.status})`;
      }
      return error.message;
    }
    return String(error);
  }

  private isMutationOutcomeUncertain(error: unknown): boolean {
    if (!(error instanceof Error)) return true;
    const status = (error as Error & { response?: { status?: number | string } }).response?.status;
    const numericStatus = typeof status === 'number'
      ? status
      : typeof status === 'string' && /^\d+$/.test(status)
        ? Number(status)
        : undefined;
    // Most provider HTTP 4xx responses are definitive rejections. HTTP 408 is
    // different: a timeout can be returned after the resolver committed. As
    // with transport failures, malformed GraphQL successes, and 5xx responses,
    // it must be reconciled rather than treated as permission to retry.
    return numericStatus === undefined
      || numericStatus < 400
      || numericStatus === 408
      || numericStatus >= 500;
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
    };
    const projectId = bindings.projectId;
    if (!projectId) {
      throw new Error('No Railway project bound to this environment');
    }

    // Railway component provisioning is service-first: create a datastore service.
    const created = await this.createServiceBackedDatastore(type, environment, projectId);
    if (created) {
      return created;
    }

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
        message: `Failed to create ${type} component`,
        error: `Unable to create ${type} service-backed datastore on Railway project ${projectId}`,
      },
    };
  }

  private async createServiceBackedDatastore(
    type: ComponentType,
    environment: Environment,
    projectId: string
  ): Promise<ComponentResult | null> {
    const client = this.client;
    if (!client) return null;

    const imageMap: Partial<Record<ComponentType, string>> = {
      postgres: 'postgres:16',
      redis: 'bitnami/redis:7.4',
    };
    const image = imageMap[type];
    if (!image) return null;

    const environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);
    if (!environmentId) {
      return {
        component: {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {},
          externalId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        receipt: {
          success: false,
          message: `No Railway environment resolved for ${environment.name}`,
          error: `Could not resolve or create Railway environment "${environment.name}" on project ${projectId}`,
          data: { phase: 'resolveEnvironment', projectId, environmentName: environment.name },
        },
      };
    }
    const baseServiceName = `${type}-db`;
    const serviceName = this.railwayServiceNameForEnvironment(baseServiceName, environment.name);
    const serviceResolution = await this.resolveServiceIdForEnvironment(
      projectId,
      this.railwayServiceNameCandidates(baseServiceName, environment.name),
      environmentId
    );
    const existingServiceId = serviceResolution.serviceId;
    const existingServiceName = serviceResolution.serviceName ?? serviceName;
    if (existingServiceId) {
      return {
        component: {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {},
          externalId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        receipt: {
          success: false,
          message: `Railway ${type} datastore service ${existingServiceName} already exists but is not bound locally`,
          error: `Hypervibe will not mutate or adopt Railway service ${existingServiceId} from a create action. Use hv_import to adopt that exact datastore, then re-run hv_plan.`,
          data: {
            adoptionCandidateServiceId: existingServiceId,
            serviceName: existingServiceName,
            projectId,
            environmentId,
          },
        },
      };
    }
    const createMutation = gql`
      mutation CreateService($input: ServiceCreateInput!) {
        serviceCreate(input: $input) {
          id
          name
        }
      }
    `;

    let createdService: { id: string; name?: string } | undefined;
    const emptyComponent = (): Component => ({
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const unresolvedCreateComponent = (): Component => {
      const providerScope = { projectId, environmentId };
      return {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          provider: 'railway',
          providerScope,
          unresolvedMutation: {
            resourceKind: type === 'redis' ? 'cache' : 'database',
            operation: 'create',
            resourceName: serviceName,
            providerScope,
          },
        },
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    };
    const partialCreatedService = (
      identity: { id: string; name?: string },
      volumeId?: string,
      volumeTarget?: RailwayVolumeTarget
    ): Component => ({
      id: '',
      environmentId: environment.id,
      type,
      bindings: {
        provider: 'railway',
        providerScope: {
          projectId,
          ...(type === 'redis' ? { environmentId } : {}),
        },
        resourceKind: 'service',
        ...(identity.name ? { pluginName: identity.name } : {}),
        ...(volumeId ? { volumeId } : {}),
        ...(volumeTarget ? { volumeTarget } : {}),
      },
      externalId: identity.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      const result = await client.request<{
        serviceCreate?: { id?: unknown; name?: unknown } | null;
      }>(
        createMutation,
        {
          input: {
            projectId,
            environmentId,
            name: serviceName,
            source: {
              image,
            },
          },
        }
      );
      const returnedId = typeof result.serviceCreate?.id === 'string'
        && result.serviceCreate.id.trim().length > 0
        ? result.serviceCreate.id
        : undefined;
      const returnedName = typeof result.serviceCreate?.name === 'string'
        && result.serviceCreate.name.trim().length > 0
        ? result.serviceCreate.name
        : undefined;

      if (!returnedId) {
        let recoveryError: string | undefined;
        try {
          createdService = await this.recoverServiceIdentityAfterCreate(
            projectId,
            serviceName,
            environmentId
          );
        } catch (error) {
          recoveryError = this.describeError(error);
        }
        return {
          component: createdService
            ? partialCreatedService(createdService)
            : unresolvedCreateComponent(),
          receipt: {
            success: false,
            message: createdService
              ? `Railway created ${type} service ${createdService.name ?? serviceName}, but serviceCreate returned no valid id`
              : `Railway serviceCreate returned no valid id for ${type}`,
            error: 'The create acknowledgement was malformed, so Hypervibe stopped before any service-instance, variable, volume, or redeploy follow-up.',
            data: {
              phase: 'serviceCreate',
              projectId,
              environmentId,
              image,
              mutationAttempted: true,
              ...(createdService
                ? { recoveredServiceId: createdService.id, recoveredServiceName: createdService.name }
                : { resourceCreated: 'unknown' }),
              ...(recoveryError ? { recoveryError } : {}),
            },
          },
        };
      }

      createdService = {
        id: returnedId,
        ...(returnedName ? { name: returnedName } : {}),
      };
      if (returnedName !== serviceName) {
        return {
          component: partialCreatedService(createdService),
          receipt: {
            success: false,
            message: `Railway returned service ${returnedId} with an unexpected name after creating ${type}`,
            error: returnedName
              ? `Expected Railway service name "${serviceName}" but serviceCreate returned "${returnedName}". Hypervibe retained the returned id for cleanup and stopped before follow-up mutations.`
              : `Expected Railway service name "${serviceName}" but serviceCreate returned no valid name. Hypervibe retained the returned id for cleanup and stopped before follow-up mutations.`,
            data: {
              phase: 'serviceCreate',
              projectId,
              environmentId,
              image,
              mutationAttempted: true,
              returnedServiceId: returnedId,
              ...(returnedName ? { returnedServiceName: returnedName } : {}),
              expectedServiceName: serviceName,
            },
          },
        };
      }

      const ensured = await this.ensureServiceInstanceForEnvironment(
        createdService.id,
        environmentId
      );
      if (!ensured.success) {
        return {
          component: partialCreatedService(createdService),
          receipt: {
            success: false,
            message: `Created ${type} service ${createdService.name} but Railway did not expose an instance in ${environment.name}`,
            error: ensured.error,
          },
        };
      }

      const bootstrapVars = this.buildDatastoreBootstrapVars(type, serviceName);
      if (bootstrapVars) {
        const varsSet = await this.upsertServiceVariables(projectId, createdService.id, environmentId, bootstrapVars);
        if (!varsSet.success) {
          return {
            component: partialCreatedService(createdService),
            receipt: {
              success: false,
              message: `Created ${type} service ${createdService.name} but failed to set bootstrap variables`,
              error: varsSet.error,
            },
          };
        }
      }

      // Persist data across redeploys; without a volume the datastore is ephemeral.
      const mountPath = this.datastoreVolumeMountPath(type);
      let volumeId: string | undefined;
      let volumeTarget: RailwayVolumeTarget | undefined;
      if (mountPath) {
        volumeTarget = {
          projectId,
          environmentId,
          serviceId: createdService.id,
          mountPath,
        };
        const volume = await this.attachServiceVolume(volumeTarget);
        if (!volume.success) {
          return {
            component: partialCreatedService(createdService, volume.volumeId, volumeTarget),
            receipt: {
              success: false,
              message: `Created ${type} service ${createdService.name} but failed to attach a volume`,
              error: volume.error,
              data: {
                phase: 'volumeCreate',
                mutationAttempted: volume.mutationAttempted,
                volumeTarget,
                ...(volume.volumeId ? { volumeId: volume.volumeId } : {}),
              },
            },
          };
        }
        volumeId = volume.volumeId;
      }

      // serviceCreate with source.image starts the first deployment before the
      // variables/volume above exist (postgres crashloops with "superuser
      // password is not specified"); redeploy so the container boots with them.
      const redeploy = await this.redeployDatastoreService(createdService.id, environmentId);
      if (!redeploy.success) {
        return {
          component: partialCreatedService(createdService, volumeId, volumeTarget),
          receipt: {
            success: false,
            message: `Created ${type} service ${createdService.name} but failed to redeploy it with bootstrap configuration`,
            error: redeploy.error,
          },
        };
      }

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          provider: 'railway',
          providerScope: {
            projectId,
            ...(type === 'redis' ? { environmentId } : {}),
          },
          resourceKind: 'service',
          pluginName: createdService.name,
          ...(volumeId ? { volumeId } : {}),
          ...(volumeTarget ? { volumeTarget } : {}),
        },
        externalId: createdService.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created ${type} datastore as Railway service (${createdService.name})`,
          data: { serviceId: createdService.id, serviceName: createdService.name, serviceBacked: true },
        },
      };
    } catch (error) {
      const mutationOutcomeUncertain = !createdService && this.isMutationOutcomeUncertain(error);
      let recoveryError: string | undefined;
      if (!createdService && mutationOutcomeUncertain) {
        try {
          createdService = await this.recoverServiceIdentityAfterCreate(
            projectId,
            serviceName,
            environmentId
          );
        } catch (recoveryFailure) {
          recoveryError = this.describeError(recoveryFailure);
        }
      }
      return {
        component: createdService
          ? partialCreatedService(createdService)
          : mutationOutcomeUncertain
            ? unresolvedCreateComponent()
            : emptyComponent(),
        receipt: {
          success: false,
          message: createdService
            ? `Railway may have created ${type} service ${createdService.name}, but the create response or follow-up setup was not verified`
            : `Failed to create ${type} service-backed datastore`,
          error: this.describeError(error),
          data: {
            phase: 'serviceCreate',
            projectId,
            environmentId,
            image,
            mutationAttempted: true,
            ...(createdService
              ? { recoveredServiceId: createdService.id, recoveredServiceName: createdService.name }
              : { resourceCreated: mutationOutcomeUncertain ? 'unknown' : false }),
            ...(recoveryError ? { recoveryError } : {}),
          },
        },
      };
    }
  }

  /**
   * A GraphQL transport failure can happen after Railway committed
   * serviceCreate. The exact requested name was proved absent immediately
   * before the mutation, so a later unique name match is attributable to this
   * attempt and may be retained for explicit recovery/cleanup.
   */
  private async recoverServiceIdentityAfterCreate(
    projectId: string,
    serviceName: string,
    environmentId?: string
  ): Promise<{ id: string; name: string } | undefined> {
    const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS ?? 10);
    const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS ?? 250);
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
      ? Math.min(Math.floor(configuredAttempts), 20)
      : 10;
    const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
      ? configuredDelayMs
      : 250;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        let matches = (await this.listProjectServices(projectId, { throwOnFailure: true }))
          .filter((service) => service.name === serviceName);
        if (environmentId) {
          const environmentMatches: typeof matches = [];
          for (const match of matches) {
            if (await this.serviceHasEnvironmentInstance(match.id, environmentId)) {
              environmentMatches.push(match);
            }
          }
          matches = environmentMatches;
        }
        if (matches.length > 1) {
          throw new Error(
            `Multiple Railway services named "${serviceName}"${environmentId ? ` in environment ${environmentId}` : ''} appeared after serviceCreate: ${matches.map((service) => service.id).join(', ')}.`
          );
        }
        if (matches.length === 1) return matches[0];
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }

    if (lastError) {
      throw new Error(
        `Could not recover the Railway service identity after an uncertain create: ${this.describeError(lastError)}`
      );
    }
    return undefined;
  }

  private buildDatastoreBootstrapVars(type: ComponentType, serviceName: string): Record<string, string> | null {
    const serviceHost = `${serviceName}.railway.internal`;

    if (type === 'postgres') {
      const password = randomBytes(18).toString('base64url');
      const connectionUrl = `postgresql://postgres:${password}@${serviceHost}:5432/postgres`;
      return {
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: 'postgres',
        POSTGRES_DB: 'postgres',
        // Volume mounts contain lost+found; initdb refuses a non-empty dir,
        // so point PGDATA at a subdirectory of the mount.
        PGDATA: '/var/lib/postgresql/data/pgdata',
        DATABASE_URL: connectionUrl,
        DATABASE_PRIVATE_URL: connectionUrl,
        PGHOST: serviceHost,
        PGPORT: '5432',
        PGUSER: 'postgres',
        PGPASSWORD: password,
        PGDATABASE: 'postgres',
      };
    }

    if (type === 'redis') {
      const password = randomBytes(18).toString('base64url');
      const connectionUrl = `redis://default:${password}@${serviceHost}:6379`;
      return {
        REDIS_PASSWORD: password,
        ALLOW_EMPTY_PASSWORD: 'no',
        REDIS_URL: connectionUrl,
      };
    }

    return null;
  }

  private datastoreVolumeMountPath(type: ComponentType): string | null {
    if (type === 'postgres') return '/var/lib/postgresql/data';
    if (type === 'redis') return '/bitnami/redis/data';
    return null;
  }

  private async attachServiceVolume(
    target: RailwayVolumeTarget
  ): Promise<
    | { success: true; volumeId: string; mutationAttempted: true }
    | { success: false; error: string; volumeId?: string; mutationAttempted: boolean }
  > {
    if (!this.client) {
      return {
        success: false,
        error: 'Not connected. Call connect() first.',
        mutationAttempted: false,
      };
    }

    const preflight = await this.resolveServiceVolume(target);
    if (!preflight.success) {
      return {
        success: false,
        error: `Railway volume preflight is unknown: ${preflight.error}`,
        mutationAttempted: false,
      };
    }
    if (preflight.state === 'present') {
      return {
        success: false,
        error: `Railway volume ${preflight.volumeId} already targets service ${target.serviceId} at ${target.mountPath}. Hypervibe will not silently adopt it from a create action.`,
        volumeId: preflight.volumeId,
        mutationAttempted: false,
      };
    }

    const mutation = gql`
      mutation VolumeCreate($input: VolumeCreateInput!) {
        volumeCreate(input: $input) {
          id
        }
      }
    `;
    let acknowledgedVolumeId: string | undefined;
    let mutationError: string | undefined;
    try {
      const result = await this.client.request<{
        volumeCreate?: { id?: unknown } | null;
      }>(mutation, { input: target });
      if (typeof result.volumeCreate?.id === 'string'
        && result.volumeCreate.id.trim().length > 0) {
        acknowledgedVolumeId = result.volumeCreate.id;
      } else {
        mutationError = 'Railway volumeCreate returned no valid volume id.';
      }
    } catch (error) {
      mutationError = this.describeError(error);
    }

    const recovered = await this.waitForCreatedServiceVolume(target, acknowledgedVolumeId);
    if (recovered.success && recovered.state === 'present') {
      return {
        success: true,
        volumeId: recovered.volumeId,
        mutationAttempted: true,
      };
    }

    const recoveryError = recovered.success
      ? `No active volume became visible for service ${target.serviceId} at ${target.mountPath}.`
      : recovered.error;
    return {
      success: false,
      error: [
        mutationError ? `volumeCreate: ${mutationError}` : undefined,
        `recovery: ${recoveryError}`,
      ].filter((value): value is string => Boolean(value)).join('; '),
      ...(recovered.success
        ? acknowledgedVolumeId ? { volumeId: acknowledgedVolumeId } : {}
        : recovered.volumeId
          ? { volumeId: recovered.volumeId }
          : acknowledgedVolumeId
            ? { volumeId: acknowledgedVolumeId }
            : {}),
      mutationAttempted: true,
    };
  }

  async resolveServiceVolume(
    target: RailwayVolumeTarget,
    expectedVolumeId?: string
  ): Promise<RailwayVolumeResolution> {
    const invalidTargetField = (Object.entries(target) as Array<[
      keyof RailwayVolumeTarget,
      string,
    ]>).find(([, value]) => typeof value !== 'string' || value.trim().length === 0);
    if (invalidTargetField) {
      return {
        success: false,
        error: `Railway volume target ${invalidTargetField[0]} must be a non-empty string.`,
      };
    }
    if (expectedVolumeId !== undefined
      && (typeof expectedVolumeId !== 'string' || expectedVolumeId.trim().length === 0)) {
      return { success: false, error: 'Railway volume id must be a non-empty string.' };
    }

    try {
      const volumes = await this.listEnvironmentVolumeInstances(target);
      const live = volumes.filter((volume) => volume.deletedAt === null);
      const targetMatches = live.filter((volume) => (
        volume.projectId === target.projectId
        && volume.environmentId === target.environmentId
        && volume.serviceId === target.serviceId
        && volume.mountPath === target.mountPath
      ));
      if (targetMatches.length > 1) {
        return {
          success: false,
          error: `Multiple active Railway volumes match service ${target.serviceId} at ${target.mountPath}: ${targetMatches.map((volume) => volume.volumeId).join(', ')}.`,
        };
      }

      if (expectedVolumeId) {
        const idMatches = live.filter((volume) => volume.volumeId === expectedVolumeId);
        if (idMatches.length > 1) {
          return {
            success: false,
            error: `Railway returned duplicate active instances for volume ${expectedVolumeId}.`,
          };
        }
        if (idMatches.length === 1 && targetMatches[0]?.volumeId !== expectedVolumeId) {
          const actual = idMatches[0]!;
          return {
            success: false,
            error: `Railway volume ${expectedVolumeId} is attached to service ${actual.serviceId} in environment ${actual.environmentId} at ${actual.mountPath}, not the recorded target.`,
          };
        }
        if (targetMatches.length === 1 && targetMatches[0]!.volumeId !== expectedVolumeId) {
          return {
            success: false,
            error: `Railway target ${target.serviceId}:${target.mountPath} resolves to volume ${targetMatches[0]!.volumeId}, not recorded volume ${expectedVolumeId}.`,
          };
        }
      }

      const match = targetMatches[0];
      if (!match) return { success: true, state: 'absent' };
      return {
        success: true,
        state: 'present',
        volumeId: match.volumeId,
        pendingDeletion: match.isPendingDeletion,
      };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  private async listEnvironmentVolumeInstances(
    target: RailwayVolumeTarget
  ): Promise<RailwayVolumeInstance[]> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const query = gql`
      query EnvironmentVolumeInstances(
        $environmentId: String!
        $projectId: String!
        $after: String
      ) {
        environment(id: $environmentId, projectId: $projectId) {
          id
          volumeInstances(first: 100, after: $after) {
            edges {
              node {
                id
                serviceId
                environmentId
                mountPath
                deletedAt
                isPendingDeletion
                volume {
                  id
                  projectId
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;
    const volumes: RailwayVolumeInstance[] = [];
    const seenInstanceIds = new Set<string>();
    const seenVolumeIds = new Set<string>();
    const seenCursors = new Set<string>();
    let after: string | null = null;

    for (let page = 0; page < 100; page += 1) {
      const result: unknown = await this.client.request<unknown>(query, {
        environmentId: target.environmentId,
        projectId: target.projectId,
        after,
      });
      if (!isRecord(result) || !('environment' in result) || !isRecord(result.environment)
        || result.environment.id !== target.environmentId
        || !isRecord(result.environment.volumeInstances)
        || !Array.isArray(result.environment.volumeInstances.edges)
        || !isRecord(result.environment.volumeInstances.pageInfo)) {
        throw new Error(
          `Railway returned a partial or mismatched volume inventory for environment ${target.environmentId} in project ${target.projectId}.`
        );
      }
      const connection: Record<string, unknown> = result.environment.volumeInstances;
      const edges = connection.edges as unknown[];
      for (const [index, edge] of edges.entries()) {
        if (!isRecord(edge) || !isRecord(edge.node) || !isRecord(edge.node.volume)
          || typeof edge.node.id !== 'string' || edge.node.id.trim().length === 0
          || typeof edge.node.serviceId !== 'string' || edge.node.serviceId.trim().length === 0
          || typeof edge.node.environmentId !== 'string' || edge.node.environmentId.trim().length === 0
          || typeof edge.node.mountPath !== 'string' || edge.node.mountPath.trim().length === 0
          || (edge.node.deletedAt !== null && typeof edge.node.deletedAt !== 'string')
          || typeof edge.node.isPendingDeletion !== 'boolean'
          || typeof edge.node.volume.id !== 'string' || edge.node.volume.id.trim().length === 0
          || typeof edge.node.volume.projectId !== 'string' || edge.node.volume.projectId.trim().length === 0) {
          throw new Error(
            `Railway returned a partial volume identity at page ${page + 1}, edge ${index + 1}.`
          );
        }
        if (edge.node.environmentId !== target.environmentId
          || edge.node.volume.projectId !== target.projectId) {
          throw new Error(
            `Railway returned volume ${edge.node.volume.id} outside requested project/environment scope.`
          );
        }
        if (seenInstanceIds.has(edge.node.id) || seenVolumeIds.has(edge.node.volume.id)) {
          throw new Error(
            `Railway returned duplicate volume identity ${edge.node.volume.id} while paginating environment ${target.environmentId}.`
          );
        }
        seenInstanceIds.add(edge.node.id);
        seenVolumeIds.add(edge.node.volume.id);
        volumes.push({
          instanceId: edge.node.id,
          volumeId: edge.node.volume.id,
          projectId: edge.node.volume.projectId,
          environmentId: edge.node.environmentId,
          serviceId: edge.node.serviceId,
          mountPath: edge.node.mountPath,
          deletedAt: edge.node.deletedAt,
          isPendingDeletion: edge.node.isPendingDeletion,
        });
      }

      const pageInfo: Record<string, unknown> = connection.pageInfo as Record<string, unknown>;
      if (typeof pageInfo.hasNextPage !== 'boolean'
        || (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string')) {
        throw new Error(`Railway returned invalid volume pagination metadata for environment ${target.environmentId}.`);
      }
      if (!pageInfo.hasNextPage) return volumes;
      if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor.length === 0
        || pageInfo.endCursor === after || seenCursors.has(pageInfo.endCursor)) {
        throw new Error(`Railway returned a missing or repeated volume pagination cursor for environment ${target.environmentId}.`);
      }
      seenCursors.add(pageInfo.endCursor);
      after = pageInfo.endCursor;
    }

    throw new Error(
      `Railway volume inventory exceeded 100 pages for environment ${target.environmentId}; observation is incomplete.`
    );
  }

  private async waitForCreatedServiceVolume(
    target: RailwayVolumeTarget,
    acknowledgedVolumeId?: string
  ): Promise<RailwayVolumeResolution> {
    const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS ?? 10);
    const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS ?? 250);
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
      ? Math.min(Math.floor(configuredAttempts), 20)
      : 10;
    const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
      ? configuredDelayMs
      : 250;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const resolution = await this.resolveServiceVolume(target);
      if (!resolution.success) {
        lastError = resolution.error;
      } else if (resolution.state === 'present' && !resolution.pendingDeletion) {
        if (acknowledgedVolumeId && resolution.volumeId !== acknowledgedVolumeId) {
          return {
            success: false,
            error: `Railway volumeCreate acknowledged ${acknowledgedVolumeId}, but the exact target resolves to ${resolution.volumeId}.`,
            volumeId: resolution.volumeId,
          };
        }
        return resolution;
      } else if (resolution.state === 'present') {
        lastError = `Railway volume ${resolution.volumeId} is already pending deletion.`;
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }

    return lastError
      ? { success: false, error: lastError }
      : { success: true, state: 'absent' };
  }

  async deleteVolume(
    volumeId: string,
    target: RailwayVolumeTarget
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    if (typeof volumeId !== 'string' || volumeId.trim().length === 0) {
      return { success: false, error: 'Railway volume id must be a non-empty string.' };
    }

    const existing = await this.resolveServiceVolume(target, volumeId);
    if (!existing.success) {
      return {
        success: false,
        error: `Railway volume identity is unknown before deletion: ${existing.error}`,
      };
    }
    if (existing.state === 'absent') {
      return { success: true, alreadyAbsent: true };
    }

    let mutationError: string | undefined;
    if (!existing.pendingDeletion) {
      const mutation = gql`
        mutation DeleteVolume($volumeId: String!) {
          volumeDelete(volumeId: $volumeId)
        }
      `;
      try {
        const result = await this.client.request<Record<string, unknown>>(mutation, { volumeId });
        const value = result.volumeDelete;
        const accepted = value === true
          || value === 1
          || value === volumeId
          || (typeof value === 'string' && value.toLowerCase() === 'true')
          || (isRecord(value) && (value.success === true || value.id === volumeId));
        if (!accepted) {
          return { success: false, error: 'volumeDelete returned unsuccessful payload' };
        }
      } catch (error) {
        if (!this.isProviderConfirmedNotFound(error, 'volumeDelete')) {
          mutationError = this.describeError(error);
        }
      }
    }

    const verification = await this.waitUntilVolumeDeleted(volumeId, target);
    if (verification.deleted) return { success: true };
    return {
      success: false,
      error: [
        mutationError ? `volumeDelete: ${mutationError}` : undefined,
        `volume deletion could not be verified: ${verification.error}`,
      ].filter((value): value is string => Boolean(value)).join('; '),
    };
  }

  private async waitUntilVolumeDeleted(
    volumeId: string,
    target: RailwayVolumeTarget
  ): Promise<DeletionVerification> {
    const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_DELETE_ATTEMPTS ?? 40);
    const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_DELETE_DELAY_MS ?? 500);
    const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
      ? Math.min(Math.floor(configuredAttempts), 120)
      : 40;
    const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
      ? configuredDelayMs
      : 500;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const resolution = await this.resolveServiceVolume(target, volumeId);
      if (!resolution.success) {
        return { deleted: false, error: resolution.error };
      }
      if (resolution.state === 'absent') return { deleted: true };
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }
    return {
      deleted: false,
      error: `volume ${volumeId} still exists after ${attempts} observation attempts.`,
    };
  }

  private async redeployDatastoreService(
    serviceId: string,
    environmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const mutation = gql`
      mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    try {
      await this.client.request(mutation, { serviceId, environmentId });
      return { success: true };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  private async upsertServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const mutation = gql`
      mutation UpsertVariables($projectId: String!, $serviceId: String!, $environmentId: String!, $variables: EnvironmentVariables!) {
        variableCollectionUpsert(
          input: {
            projectId: $projectId
            serviceId: $serviceId
            environmentId: $environmentId
            variables: $variables
          }
        )
      }
    `;
    try {
      await this.client.request(mutation, {
        projectId,
        serviceId,
        environmentId,
        variables,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: this.describeError(error) };
    }
  }

  private async resolveRailwayEnvironmentId(
    projectId: string,
    environment: Environment
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    const bindings = environment.platformBindings as { environmentId?: string };
    const environmentId = bindings.environmentId;
    const projectEnvironments = await this.listProjectEnvironments(projectId);
    const environmentIds = projectEnvironments.map((env) => env.id);
    if (environmentId) {
      if (environmentIds.includes(environmentId)) return environmentId;
      throw new Error(`Bound Railway environment ${environmentId} is absent from project ${projectId}. Hypervibe will not silently rebind by name or create a replacement.`);
    }
    const byName = projectEnvironments.filter(
      (candidate) => candidate.name.toLowerCase() === environment.name.toLowerCase()
    );
    if (byName.length > 0) {
      throw new Error(
        `Railway environment "${environment.name}" is not bound locally${byName.length === 1 ? `; ${byName[0]!.id} is an adoption candidate` : ` and has duplicate candidates: ${byName.map((candidate) => candidate.id).join(', ')}`}. Use hv_import to adopt the exact environment before mutating it.`
      );
    }
    return undefined;
  }

  private async listProjectEnvironments(projectId: string): Promise<Array<{ id: string; name: string }>> {
    const client = this.client;
    if (!client) throw new Error('Not connected. Call connect() first.');
    const envQuery = gql`
      query GetEnvironments($projectId: String!) {
        project(id: $projectId) {
          environments {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;
    const envResult = await client.request<unknown>(envQuery, { projectId });
    if (!isRecord(envResult) || !('project' in envResult)) {
      throw new Error(`Railway returned an invalid environment inventory response for project ${projectId}.`);
    }
    if (envResult.project === null) return [];
    if (!isRecord(envResult.project)
      || (envResult.project.id !== undefined && envResult.project.id !== projectId)) {
      throw new Error(`Railway returned a mismatched environment inventory for project ${projectId}.`);
    }
    const envs = envResult.project.environments as
      | { edges?: Array<{ node?: { id?: string; name?: string } }> }
      | Array<{ id?: string; name?: string }>
      | undefined;
    if (!envs) {
      throw new Error(`Railway returned an invalid environment inventory for project ${projectId}.`);
    }

    const rawEnvironments = Array.isArray(envs)
      ? envs
      : Array.isArray(envs.edges)
        ? envs.edges.map((edge) => edge.node)
        : null;
    if (!rawEnvironments || rawEnvironments.some((env) => (
      !env || typeof env.id !== 'string' || !env.id || typeof env.name !== 'string' || !env.name
    ))) {
      throw new Error(`Railway returned a partial environment inventory for project ${projectId}.`);
    }
    const parsed = rawEnvironments.map((env) => ({ id: env!.id!, name: env!.name! }));
    if (new Set(parsed.map((env) => env.id)).size !== parsed.length) {
      throw new Error(`Railway returned duplicate environment ids for project ${projectId}.`);
    }
    return parsed;
  }

  private async createRailwayEnvironment(projectId: string, environmentName: string): Promise<string | undefined> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const attempts: Array<{ label: string; mutation: string; variables: Record<string, unknown> }> = [
      {
        label: 'environmentCreate.input',
        mutation: `
          mutation CreateEnvironment($projectId: String!, $name: String!) {
            environmentCreate(input: { projectId: $projectId, name: $name }) {
              id
              name
            }
          }
        `,
        variables: { projectId, name: environmentName },
      },
      {
        label: 'environmentCreate.arguments',
        mutation: `
          mutation CreateEnvironment($projectId: String!, $name: String!) {
            environmentCreate(projectId: $projectId, name: $name) {
              id
              name
            }
          }
        `,
        variables: { projectId, name: environmentName },
      },
    ];

    const schemaErrors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await this.client.request<unknown>(gql`${attempt.mutation}`, attempt.variables);
        if (!isRecord(result) || !isRecord(result.environmentCreate)) {
          throw new Error(`${attempt.label}: Railway returned an invalid environmentCreate acknowledgement; creation state is unknown and Hypervibe will not issue another mutation.`);
        }
        const id = result.environmentCreate.id;
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error(`${attempt.label}: Railway returned an environmentCreate acknowledgement without an id; creation state is unknown and Hypervibe will not issue another mutation.`);
        }
        return id;
      } catch (error) {
        if (!this.isGraphqlSchemaCompatibilityError(error)) {
          throw error;
        }
        schemaErrors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }

    throw new Error(`Railway environment creation is unsupported by the available GraphQL schema variants: ${schemaErrors.join(' | ')}`);
  }

  private railwayServiceNameForEnvironment(baseName: string, environmentName: string): string {
    const base = railwayNamePart(baseName);
    const env = railwayNamePart(environmentName);
    if (env === 'production' || env === 'prod') {
      return base;
    }
    if (base.endsWith(`-${env}`)) {
      return base;
    }
    return `${base}-${env}`.slice(0, 64).replace(/-+$/g, '') || base;
  }

  private railwayServiceNameCandidates(baseName: string, environmentName: string): string[] {
    return Array.from(new Set([
      baseName,
      this.railwayServiceNameForEnvironment(baseName, environmentName),
    ]));
  }

  private boundServiceNameForId(
    services: Record<string, { serviceId?: string; source?: { repo?: string; branch?: string } }> | undefined,
    serviceId: string
  ): string | undefined {
    return Object.entries(services ?? {})
      .find(([, binding]) => binding.serviceId === serviceId)?.[0];
  }

  private hypervibeServiceNameFromRailwayName(providerName: string, environmentName: string): string {
    const env = railwayNamePart(environmentName);
    if (env === 'production' || env === 'prod') {
      return providerName;
    }
    const suffix = `-${env}`;
    return providerName.endsWith(suffix)
      ? providerName.slice(0, -suffix.length) || providerName
      : providerName;
  }

  private async resolveServiceIdForEnvironment(
    projectId: string,
    serviceNames: string | string[],
    environmentId: string,
    boundServiceId?: string
  ): Promise<{ serviceId?: string; serviceName?: string; ignoredBoundServiceId?: string; verifiedInEnvironment?: boolean }> {
    // An empty list is valid only after a successful provider read. If both
    // supported query shapes fail, propagate the error so deploy cannot turn
    // an unknown inventory into permission to create a duplicate service.
    const services = await this.listProjectServices(projectId, { throwOnFailure: true });
    const names = new Set(Array.isArray(serviceNames) ? serviceNames : [serviceNames]);
    if (boundServiceId) {
      const bound = services.find((service) => service.id === boundServiceId);
      if (!bound) {
        throw new Error(`Bound Railway service ${boundServiceId} is absent from project ${projectId}. Hypervibe will not silently create or adopt a replacement.`);
      }
      const hasInstance = await this.serviceHasEnvironmentInstance(bound.id, environmentId);
      return {
        serviceId: bound.id,
        serviceName: bound.name,
        verifiedInEnvironment: hasInstance,
      };
    }

    const candidates = services.filter((service) => names.has(service.name));
    const environmentMatches: Array<{ id: string; name: string }> = [];
    for (const candidate of candidates) {
      // A failed instance read is not evidence that this project-level
      // service is absent from the target environment. Propagate the failure
      // so callers cannot create a duplicate service from an unknown read.
      if (await this.serviceHasEnvironmentInstance(candidate.id, environmentId)) {
        environmentMatches.push(candidate);
      }
    }
    if (environmentMatches.length > 1) {
      throw new Error(
        `Multiple Railway services match ${Array.from(names).map((name) => `"${name}"`).join(' or ')} in environment ${environmentId}: ${environmentMatches.map((service) => `${service.name} (${service.id})`).join(', ')}. Hypervibe will not guess which service to manage.`
      );
    }
    if (environmentMatches.length === 1) {
      const match = environmentMatches[0]!;
      return { serviceId: match.id, serviceName: match.name, verifiedInEnvironment: true };
    }

    return {};
  }

  private async serviceHasEnvironmentInstance(
    serviceId: string,
    environmentId: string
  ): Promise<boolean> {
    const existence = await this.serviceEnvironmentInstanceExists(serviceId, environmentId);
    if (existence.state === 'unknown') {
      throw new Error(existence.error);
    }
    return existence.state === 'present';
  }

  private async ensureServiceInstanceForEnvironment(
    serviceId: string,
    environmentId: string
  ): Promise<{ success: true; created: boolean } | { success: false; error: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      if (await this.serviceHasEnvironmentInstance(serviceId, environmentId)) {
        return { success: true, created: false };
      }

      return {
        success: false,
        error: `Railway service ${serviceId} has no service instance in environment ${environmentId}. Re-run hv_plan/hv_apply so Hypervibe can create or bind an environment-scoped service before deploy/domain/task operations.`,
      };
    } catch (error) {
      return {
        success: false,
        error: this.describeError(error),
      };
    }
  }

  private async listProjectServices(
    projectId: string,
    _options?: { throwOnFailure?: boolean }
  ): Promise<Array<{ id: string; name: string }>> {
    const client = this.client;
    if (!client) throw new Error('Not connected. Call connect() first.');
    const schemaErrors: string[] = [];
    const attempts = [
      {
        label: 'project.services.edges',
        query: gql`
        query GetProjectServicesConnection($projectId: String!) {
          project(id: $projectId) {
            services {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      },
      {
        label: 'project.services direct',
        query: gql`
        query GetProjectServicesDirect($projectId: String!) {
          project(id: $projectId) {
            services {
              id
              name
            }
          }
        }
      `,
      },
    ];

    for (const attempt of attempts) {
      try {
        const result = await client.request<Record<string, unknown>>(attempt.query, { projectId });
        const project = result.project as
          | {
              services?:
                | { edges?: Array<{ node?: { id?: string; name?: string } }> }
                | Array<{ id?: string; name?: string }>;
            }
          | undefined;
        const services = project?.services;
        if (!project || !services) {
          throw new Error(`Railway returned no project service collection for ${projectId}`);
        }
        if (Array.isArray(services)) {
          if (services.some((service) => !service.id || !service.name)) {
            throw new Error(`Railway returned a partial project service list for ${projectId}`);
          }
          const parsed = services.map((service) => ({ id: service.id!, name: service.name! }));
          if (new Set(parsed.map((service) => service.id)).size !== parsed.length) {
            throw new Error(`Railway returned duplicate service ids for project ${projectId}`);
          }
          return parsed;
        }
        if (!Array.isArray(services.edges)) {
          throw new Error(`Railway returned an invalid project service connection for ${projectId}`);
        }
        if (services.edges.some((edge) => !edge.node?.id || !edge.node?.name)) {
          throw new Error(`Railway returned a partial project service list for ${projectId}`);
        }
        const parsed = services.edges.map((edge) => ({ id: edge.node!.id!, name: edge.node!.name! }));
        if (new Set(parsed.map((service) => service.id)).size !== parsed.length) {
          throw new Error(`Railway returned duplicate service ids for project ${projectId}`);
        }
        return parsed;
      } catch (error) {
        if (!this.isGraphqlSchemaCompatibilityError(error)) {
          throw error;
        }
        schemaErrors.push(`${attempt.label}: ${this.describeError(error)}`);
      }
    }

    throw new Error(`Railway service observation is unsupported by the available GraphQL schema variants: ${schemaErrors.join(' | ')}`);
  }

  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const existing = await this.projectExists(projectId);
    if (existing.state === 'absent') return { success: true };
    if (existing.state === 'unknown') {
      return { success: false, error: `project absence is unknown (${projectId}): ${existing.error}` };
    }

    const attempts: Array<{ mutation: string; variables: Record<string, unknown>; label: string }> = [
      {
        label: 'projectDelete.id',
        mutation: `
          mutation DeleteProject($id: String!) {
            projectDelete(id: $id)
          }
        `,
        variables: { id: projectId },
      },
      {
        label: 'projectDelete.input.id',
        mutation: `
          mutation DeleteProject($id: String!) {
            projectDelete(input: { id: $id })
          }
        `,
        variables: { id: projectId },
      },
      {
        label: 'projectDelete.input.projectId',
        mutation: `
          mutation DeleteProject($id: String!) {
            projectDelete(input: { projectId: $id })
          }
        `,
        variables: { id: projectId },
      },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await this.client.request<Record<string, unknown>>(gql`${attempt.mutation}`, attempt.variables);
        const accepted = this.isDeleteAccepted(result, 'projectDelete', projectId);
        if (!accepted) {
          return { success: false, error: `${attempt.label}: delete mutation returned unsuccessful payload` };
        }
        const verification = await this.waitUntilProjectDeleted(projectId);
        if (verification.deleted) {
          return { success: true };
        }
        return {
          success: false,
          error: `${attempt.label}: delete acknowledged but could not be verified: ${verification.error}`,
        };
      } catch (error) {
        const message = this.describeError(error);
        if (this.isProviderConfirmedNotFound(error, 'projectDelete')) {
          return { success: true };
        }
        if (!this.isGraphqlSchemaCompatibilityError(error)) {
          return { success: false, error: `${attempt.label}: ${message}` };
        }
        errors.push(`${attempt.label}: ${message}`);
      }
    }
    return { success: false, error: errors.join(' | ') };
  }

  async deleteEnvironment(
    projectId: string,
    environmentId: string
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const existing = await this.environmentExists(projectId, environmentId);
    if (existing.state === 'absent') {
      return { success: true, alreadyAbsent: true };
    }
    if (existing.state === 'unknown') {
      return {
        success: false,
        error: `environment absence is unknown (${environmentId}): ${existing.error}`,
      };
    }

    try {
      const mutation = gql`
        mutation DeleteEnvironment($id: String!) {
          environmentDelete(id: $id)
        }
      `;
      const result = await this.client.request<Record<string, unknown>>(mutation, { id: environmentId });
      if (!this.isDeleteAccepted(result, 'environmentDelete', environmentId)) {
        return { success: false, error: 'environmentDelete.id: delete mutation returned unsuccessful payload' };
      }
      const attempts = Number(process.env.HYPERVIBE_RAILWAY_DELETE_ATTEMPTS ?? 40);
      const delayMs = Number(process.env.HYPERVIBE_RAILWAY_DELETE_DELAY_MS ?? 500);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const existence = await this.environmentExists(projectId, environmentId);
        if (existence.state === 'absent') return { success: true };
        if (existence.state === 'unknown') {
          return {
            success: false,
            error: `environment absence is unknown (${environmentId}): ${existence.error}`,
          };
        }
        if (attempt < attempts - 1) {
          await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
        }
      }
      return {
        success: false,
        error: `environment still exists after ${attempts} observation attempts (${environmentId})`,
      };
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'environmentDelete')) {
        const verification = await this.environmentExists(projectId, environmentId);
        if (verification.state === 'absent') return { success: true, alreadyAbsent: true };
        return {
          success: false,
          error: verification.state === 'unknown'
            ? `environmentDelete.id: not-found acknowledgement could not be verified: ${verification.error}`
            : `environmentDelete.id: not-found acknowledgement conflicted with a still-present environment (${environmentId})`,
        };
      }
      return { success: false, error: `environmentDelete.id: ${this.describeError(error)}` };
    }
  }

  async deleteService(
    serviceId: string,
    target: HostingServiceDeleteScope,
    options: HostingServiceDeleteOptions
  ): Promise<{ success: boolean; error?: string; alreadyAbsent?: boolean }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    if (typeof serviceId !== 'string' || serviceId.trim().length === 0
      || !target || !isRecord(target)
      || target.scope !== 'environment'
      || typeof target.projectId !== 'string' || target.projectId.trim().length === 0
      || typeof target.environmentId !== 'string' || target.environmentId.trim().length === 0) {
      return {
        success: false,
        error: `Railway service deletion requires an exact project and environment target for ${serviceId}; project-global deletion is not authorized.`,
      };
    }
    if (!options || !isRecord(options) || typeof options.allowMutation !== 'boolean') {
      return {
        success: false,
        error: `Railway service deletion requires an explicit mutation decision for ${serviceId}.`,
      };
    }

    const { projectId, environmentId } = target;
    const existing = await this.serviceEnvironmentInstanceExists(serviceId, environmentId);
    if (existing.state === 'absent') {
      return { success: true, alreadyAbsent: true };
    }
    if (existing.state === 'unknown') {
      return {
        success: false,
        error: `service instance absence is unknown (${serviceId} in ${environmentId}): ${existing.error}`,
      };
    }
    if (!options.allowMutation) {
      return {
        success: false,
        error: `Railway service ${serviceId} remains present, and another local binding forbids provider mutation.`,
      };
    }

    const inventory = await this.serviceInstanceInventory(serviceId, projectId);
    if (inventory.state === 'absent') {
      return {
        success: false,
        error: `Railway returned conflicting service and service-instance evidence for ${serviceId}; deletion is blocked.`,
      };
    }
    if (inventory.state === 'unknown') {
      return {
        success: false,
        error: `service instance inventory is unknown (${serviceId}): ${inventory.error}`,
      };
    }
    if (!inventory.environmentIds.includes(environmentId)) {
      return {
        success: false,
        error: `Railway returned conflicting service-instance evidence for ${serviceId} in ${environmentId}; deletion is blocked.`,
      };
    }
    const siblingEnvironmentIds = inventory.environmentIds.filter((id) => id !== environmentId);
    if (siblingEnvironmentIds.length > 0) {
      return {
        success: false,
        error: `Railway service ${serviceId} also has instance(s) in ${siblingEnvironmentIds.join(', ')}. Railway may delete non-fork sibling instances, so Hypervibe will not issue serviceDelete.`,
      };
    }

    try {
      const mutation = gql`
        mutation DeleteEnvironmentService($id: String!, $environmentId: String!) {
          serviceDelete(id: $id, environmentId: $environmentId)
        }
      `;
      const result = await this.client.request<Record<string, unknown>>(mutation, { id: serviceId, environmentId });
      const accepted = this.isDeleteAccepted(result, 'serviceDelete', serviceId);
      if (!accepted) {
        return { success: false, error: 'serviceDelete.id: delete mutation returned unsuccessful payload' };
      }
      const verification = await this.waitUntilServiceInstanceDeleted(serviceId, environmentId);
      if (verification.deleted) {
        return { success: true };
      }
      return {
        success: false,
        error: `serviceDelete.id: delete acknowledged but could not be verified: ${verification.error}`,
      };
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'serviceDelete')) {
        const verification = await this.serviceEnvironmentInstanceExists(serviceId, environmentId);
        if (verification.state === 'absent') return { success: true, alreadyAbsent: true };
        return {
          success: false,
          error: verification.state === 'unknown'
            ? `serviceDelete.id: not-found acknowledgement could not be verified: ${verification.error}`
            : `serviceDelete.id: not-found acknowledgement conflicted with a still-present service instance (${serviceId} in ${environmentId})`,
        };
      }
      return { success: false, error: `serviceDelete.id: ${this.describeError(error)}` };
    }
  }

  private isDeleteAccepted(
    payload: Record<string, unknown>,
    field: 'projectDelete' | 'environmentDelete' | 'serviceDelete',
    expectedId: string
  ): boolean {
    const value = payload[field];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') return value === expectedId || value.toLowerCase() === 'true';
    if (isRecord(value)) {
      if ('success' in value) return value.success === true;
      if ('id' in value) return value.id === expectedId;
      return false;
    }
    return false;
  }

  private async waitUntilProjectDeleted(projectId: string): Promise<DeletionVerification> {
    const attempts = Number(process.env.HYPERVIBE_RAILWAY_DELETE_ATTEMPTS ?? 40);
    const delayMs = Number(process.env.HYPERVIBE_RAILWAY_DELETE_DELAY_MS ?? 500);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const existence = await this.projectExists(projectId);
      if (existence.state === 'absent') return { deleted: true };
      if (existence.state === 'unknown') {
        return {
          deleted: false,
          error: `project absence is unknown (${projectId}): ${existence.error}`,
        };
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }
    return {
      deleted: false,
      error: `project still exists after ${attempts} observation attempts (${projectId})`,
    };
  }

  private async waitUntilServiceInstanceDeleted(
    serviceId: string,
    environmentId: string
  ): Promise<DeletionVerification> {
    const attempts = Number(process.env.HYPERVIBE_RAILWAY_DELETE_ATTEMPTS ?? 40);
    const delayMs = Number(process.env.HYPERVIBE_RAILWAY_DELETE_DELAY_MS ?? 500);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const existence = await this.serviceEnvironmentInstanceExists(serviceId, environmentId);
      if (existence.state === 'absent') return { deleted: true };
      if (existence.state === 'unknown') {
        return {
          deleted: false,
          error: `service instance absence is unknown (${serviceId} in ${environmentId}): ${existence.error}`,
        };
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }
    return {
      deleted: false,
      error: `service instance still exists after ${attempts} observation attempts (${serviceId} in ${environmentId})`,
    };
  }

  private async projectExists(projectId: string): Promise<ResourceExistence> {
    if (!this.client) {
      return { state: 'unknown', error: 'Not connected. Call connect() first.' };
    }
    try {
      const query = gql`
        query GetProject($id: String!) {
          project(id: $id) {
            id
          }
        }
      `;
      const result = await this.client.request<unknown>(query, { id: projectId });
      if (!isRecord(result) || !('project' in result)) {
        return { state: 'unknown', error: `Railway returned an invalid project existence response for ${projectId}.` };
      }
      if (result.project === null) return { state: 'absent' };
      if (!isRecord(result.project) || result.project.id !== projectId) {
        return { state: 'unknown', error: `Railway returned a partial or mismatched project identity for ${projectId}.` };
      }
      return { state: 'present' };
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'project')) return { state: 'absent' };
      return { state: 'unknown', error: this.describeError(error) };
    }
  }

  async inspectServiceInstance(
    serviceId: string,
    environmentId: string
  ): Promise<RailwayServiceInstanceInspection> {
    if (!this.client) {
      return { state: 'unknown', error: 'Not connected. Call connect() first.' };
    }
    if (typeof serviceId !== 'string' || !serviceId.trim()
      || typeof environmentId !== 'string' || !environmentId.trim()) {
      return { state: 'unknown', error: 'Railway service-instance inspection requires exact service and environment ids.' };
    }
    try {
      const query = gql`
        query GetServiceEnvironmentInstance($serviceId: String!, $environmentId: String!) {
          serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
            id
            serviceId
            environmentId
            source {
              image
            }
          }
        }
      `;
      const result = await this.client.request<unknown>(query, { serviceId, environmentId });
      if (!isRecord(result) || !('serviceInstance' in result)) {
        return {
          state: 'unknown',
          error: `Railway returned an invalid service-instance existence response for ${serviceId}.`,
        };
      }
      if (result.serviceInstance === null) return { state: 'absent' };
      if (!isRecord(result.serviceInstance)
        || typeof result.serviceInstance.id !== 'string'
        || result.serviceInstance.id.length === 0
        || result.serviceInstance.serviceId !== serviceId
        || result.serviceInstance.environmentId !== environmentId) {
        return {
          state: 'unknown',
          error: `Railway returned a partial service-instance identity for ${serviceId} in ${environmentId}.`,
        };
      }
      const source = result.serviceInstance.source;
      if (source !== undefined && source !== null && !isRecord(source)) {
        return {
          state: 'unknown',
          error: `Railway returned a malformed service-instance source for ${serviceId} in ${environmentId}.`,
        };
      }
      const image = isRecord(source) ? source.image : undefined;
      if (image !== undefined && image !== null && typeof image !== 'string') {
        return {
          state: 'unknown',
          error: `Railway returned a malformed service-instance image for ${serviceId} in ${environmentId}.`,
        };
      }
      return {
        state: 'present',
        instanceId: result.serviceInstance.id,
        serviceId,
        environmentId,
        ...(typeof image === 'string' && image.trim() ? { sourceImage: image } : {}),
      };
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'serviceInstance')) return { state: 'absent' };
      return { state: 'unknown', error: this.describeError(error) };
    }
  }

  private async serviceEnvironmentInstanceExists(
    serviceId: string,
    environmentId: string
  ): Promise<ResourceExistence> {
    const inspected = await this.inspectServiceInstance(serviceId, environmentId);
    return inspected.state === 'unknown'
      ? inspected
      : { state: inspected.state };
  }

  private async serviceInstanceInventory(
    serviceId: string,
    projectId: string
  ): Promise<ServiceInstanceInventory> {
    if (!this.client) {
      return { state: 'unknown', error: 'Not connected. Call connect() first.' };
    }
    const environmentIds: string[] = [];
    const instanceIds = new Set<string>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      try {
        const query = gql`
          query GetServiceInstanceInventory($serviceId: String!, $after: String) {
            service(id: $serviceId) {
              id
              projectId
              serviceInstances(first: 100, after: $after) {
                edges {
                  node {
                    id
                    environmentId
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `;
        const result: unknown = await this.client.request<unknown>(query, { serviceId, after });
        if (!isRecord(result) || !('service' in result)) {
          return { state: 'unknown', error: 'Railway returned an invalid service inventory response.' };
        }
        if (result.service === null) return { state: 'absent' };
        if (!isRecord(result.service)
          || result.service.id !== serviceId
          || result.service.projectId !== projectId
          || !isRecord(result.service.serviceInstances)
          || !Array.isArray(result.service.serviceInstances.edges)
          || !isRecord(result.service.serviceInstances.pageInfo)
          || typeof result.service.serviceInstances.pageInfo.hasNextPage !== 'boolean') {
          return { state: 'unknown', error: 'Railway returned a partial or mismatched service-instance inventory.' };
        }
        for (const edge of result.service.serviceInstances.edges) {
          if (!isRecord(edge) || !isRecord(edge.node)
            || typeof edge.node.id !== 'string' || edge.node.id.length === 0
            || typeof edge.node.environmentId !== 'string' || edge.node.environmentId.length === 0
            || instanceIds.has(edge.node.id)
            || environmentIds.includes(edge.node.environmentId)) {
            return { state: 'unknown', error: 'Railway returned a partial or duplicate service-instance identity.' };
          }
          instanceIds.add(edge.node.id);
          environmentIds.push(edge.node.environmentId);
        }
        if (!result.service.serviceInstances.pageInfo.hasNextPage) {
          return { state: 'complete', environmentIds };
        }
        const endCursor: unknown = result.service.serviceInstances.pageInfo.endCursor;
        if (typeof endCursor !== 'string' || endCursor.length === 0 || cursors.has(endCursor)) {
          return { state: 'unknown', error: 'Railway returned an invalid or repeated service-instance pagination cursor.' };
        }
        cursors.add(endCursor);
        after = endCursor;
      } catch (error) {
        if (this.isProviderConfirmedNotFound(error, 'service')) return { state: 'absent' };
        return { state: 'unknown', error: this.describeError(error) };
      }
    }
    return { state: 'unknown', error: 'Railway service-instance inventory exceeded the pagination safety limit.' };
  }

  private async environmentExists(projectId: string, environmentId: string): Promise<ResourceExistence> {
    if (!this.client) {
      return { state: 'unknown', error: 'Not connected. Call connect() first.' };
    }
    if (typeof projectId !== 'string' || !projectId.trim()
      || typeof environmentId !== 'string' || !environmentId.trim()) {
      return { state: 'unknown', error: 'Railway environment inspection requires exact project and environment ids.' };
    }
    try {
      const query = gql`
        query GetEnvironment($environmentId: String!, $projectId: String!) {
          environment(id: $environmentId, projectId: $projectId) {
            id
          }
        }
      `;
      const result = await this.client.request<unknown>(query, { environmentId, projectId });
      if (!isRecord(result) || !('environment' in result)) {
        return { state: 'unknown', error: `Railway returned an invalid environment existence response for ${environmentId} in project ${projectId}.` };
      }
      if (result.environment === null) return { state: 'absent' };
      if (!isRecord(result.environment) || result.environment.id !== environmentId) {
        return { state: 'unknown', error: `Railway returned a partial or mismatched environment identity for ${environmentId} in project ${projectId}.` };
      }
      return { state: 'present' };
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'environment')) return { state: 'absent' };
      return { state: 'unknown', error: this.describeError(error) };
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId: string }>;
      serviceCreateRecovery?: Record<string, unknown>;
    };
    const projectId = bindings.projectId;

    if (!projectId) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: 'No Railway project bound to this environment',
        },
      };
    }

    try {
      const railwayEnvId = await this.resolveRailwayEnvironmentId(projectId, environment);
      if (!railwayEnvId) {
        return {
          serviceId: service.id,
          status: 'failed',
          receipt: {
            success: false,
            message: `Railway environment "${environment.name}" not found and could not be created`,
          },
        };
      }

      // Check if a service is already bound to this Railway environment. A
      // project-level service that only has instances in another environment
      // cannot be deployed here; create a target-environment service instead.
      const providerServiceName = this.railwayServiceNameForEnvironment(service.name, environment.name);
      const providerScope = { projectId, environmentId: railwayEnvId };
      const failedCreateRecovery = (
        recovery: HostingServiceCreateRecovery,
        message: string,
        error: string,
        mutationAttempted: boolean
      ): DeployResult => ({
        serviceId: service.id,
        ...(recovery.serviceId ? { externalId: recovery.serviceId } : {}),
        status: 'failed',
        receipt: {
          success: false,
          message,
          error,
          data: {
            provider: this.name,
            phase: 'serviceCreate',
            environmentId: railwayEnvId,
            mutationAttempted,
            serviceCreateRecovery: recovery,
          },
        },
      });
      const identifiedCreateRecovery = (serviceId: string): HostingServiceCreateRecovery => (
        createHostingServiceCreateRecovery({
          provider: this.name,
          resourceName: providerServiceName,
          providerScope,
          state: 'identified',
          serviceId,
          returnedName: providerServiceName,
        })
      );
      const rawPriorRecovery = bindings.serviceCreateRecovery?.[service.name];
      if (rawPriorRecovery !== undefined) {
        const priorRecovery = parseHostingServiceCreateRecovery(rawPriorRecovery);
        const scope = priorRecovery?.providerScope;
        if (!priorRecovery
          || priorRecovery.provider !== this.name
          || priorRecovery.resourceName !== providerServiceName
          || scope?.projectId !== projectId
          || scope?.environmentId !== railwayEnvId
          || Object.keys(scope).length !== 2) {
          return {
            serviceId: service.id,
            status: 'failed',
            receipt: {
              success: false,
              message: `Railway service-create recovery state for ${service.name} is invalid`,
              error: 'The persisted recovery marker does not match the exact provider, project, environment, and service name. Hypervibe refused to create or mutate a service.',
            },
          };
        }
        return failedCreateRecovery(
          priorRecovery,
          `Railway service creation for ${service.name} is incomplete`,
          priorRecovery.serviceId
            ? `Railway service ${priorRecovery.serviceId} must be inspected and explicitly recovered or cleaned up before another deploy.`
            : `A previous Railway serviceCreate for "${providerServiceName}" may have committed without returning an id. Inspect that exact project/environment before retrying.`,
          false
        );
      }
      const serviceResolution = await this.resolveServiceIdForEnvironment(
        projectId,
        this.railwayServiceNameCandidates(service.name, environment.name),
        railwayEnvId,
        bindings.services?.[service.name]?.serviceId
      );
      let railwayServiceId = serviceResolution.serviceId;
      let createdService = false;

      if (!railwayServiceId) {
        // Create service
        const createMutation = gql`
          mutation CreateService($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
              name
            }
          }
        `;

        let createResult: unknown;
        try {
          createResult = await this.client.request<unknown>(createMutation, {
            input: {
              projectId,
              environmentId: railwayEnvId,
              name: providerServiceName,
            },
          });
        } catch (error) {
          if (!this.isMutationOutcomeUncertain(error)) throw error;
          let recovered: { id: string; name: string } | undefined;
          let recoveryError: string | undefined;
          try {
            recovered = await this.recoverServiceIdentityAfterCreate(
              projectId,
              providerServiceName,
              railwayEnvId
            );
          } catch (recoveryFailure) {
            recoveryError = this.describeError(recoveryFailure);
          }
          const recovery = createHostingServiceCreateRecovery({
            provider: this.name,
            resourceName: providerServiceName,
            providerScope,
            state: recovered ? 'identified' : 'unresolved',
            ...(recovered ? { serviceId: recovered.id, returnedName: recovered.name } : {}),
          });
          return failedCreateRecovery(
            recovery,
            recovered
              ? `Railway created service ${providerServiceName}, but the create response was lost`
              : `Railway service creation for ${providerServiceName} is unresolved`,
            [this.describeError(error), recoveryError].filter(Boolean).join('; '),
            true
          );
        }

        const payload = isRecord(createResult) && isRecord(createResult.serviceCreate)
          ? createResult.serviceCreate
          : null;
        const returnedId = typeof payload?.id === 'string' && payload.id.trim().length > 0
          ? payload.id
          : undefined;
        const returnedName = typeof payload?.name === 'string' && payload.name.trim().length > 0
          ? payload.name
          : undefined;
        if (!returnedId) {
          let recovered: { id: string; name: string } | undefined;
          let recoveryError: string | undefined;
          try {
            recovered = await this.recoverServiceIdentityAfterCreate(
              projectId,
              providerServiceName,
              railwayEnvId
            );
          } catch (error) {
            recoveryError = this.describeError(error);
          }
          const recovery = createHostingServiceCreateRecovery({
            provider: this.name,
            resourceName: providerServiceName,
            providerScope,
            state: recovered ? 'identified' : 'unresolved',
            ...(recovered ? { serviceId: recovered.id, returnedName: recovered.name } : {}),
            ...(!recovered && returnedName ? { returnedName } : {}),
          });
          return failedCreateRecovery(
            recovery,
            `Railway serviceCreate returned no valid id for ${providerServiceName}`,
            [
              'Hypervibe stopped before service-instance, configuration, variable, redeploy, or domain mutations.',
              recoveryError,
            ].filter(Boolean).join(' '),
            true
          );
        }
        if (returnedName !== providerServiceName) {
          const recovery = createHostingServiceCreateRecovery({
            provider: this.name,
            resourceName: providerServiceName,
            providerScope,
            state: 'mismatched',
            serviceId: returnedId,
            ...(returnedName ? { returnedName } : {}),
          });
          return failedCreateRecovery(
            recovery,
            `Railway returned an unexpected service identity for ${service.name}`,
            returnedName
              ? `Expected service name "${providerServiceName}" but serviceCreate returned "${returnedName}". The returned id was retained only for recovery.`
              : `Expected service name "${providerServiceName}" but serviceCreate returned no valid name. The returned id was retained only for recovery.`,
            true
          );
        }

        railwayServiceId = returnedId;
        createdService = true;
      }

      const ensuredInstance = serviceResolution.verifiedInEnvironment
        ? { success: true as const, created: false }
        : await this.ensureServiceInstanceForEnvironment(
          railwayServiceId,
          railwayEnvId
        );
      if (!ensuredInstance.success) {
        if (createdService) {
          return failedCreateRecovery(
            identifiedCreateRecovery(railwayServiceId),
            `Railway created ${service.name}, but its environment instance was not verified`,
            ensuredInstance.error,
            true
          );
        }
        return {
          serviceId: service.id,
          externalId: railwayServiceId,
          status: 'failed',
          receipt: {
            success: false,
            message: `Railway service ${service.name} is missing an instance in environment ${environment.name}`,
            error: ensuredInstance.error,
            data: {
              provider: this.name,
              phase: 'ensureServiceInstance',
              serviceId: railwayServiceId,
              environmentId: railwayEnvId,
            },
          },
        };
      }

      const runtimeConfig = {
        startCommand: service.buildConfig.startCommand,
        releaseCommand: service.buildConfig.releaseCommand,
        healthcheckPath: service.buildConfig.healthCheckPath,
        cronSchedule: service.buildConfig.cronSchedule,
      };
      if (runtimeConfig.startCommand || runtimeConfig.releaseCommand || runtimeConfig.healthcheckPath || runtimeConfig.cronSchedule) {
        const configReceipt = await this.updateServiceInstanceConfig({
          serviceId: railwayServiceId,
          environmentId: railwayEnvId,
          ...runtimeConfig,
        });
        if (!configReceipt.success) {
          if (createdService) {
            return failedCreateRecovery(
              identifiedCreateRecovery(railwayServiceId),
              `Railway created ${service.name}, but runtime configuration failed`,
              configReceipt.error || configReceipt.message,
              true
            );
          }
          return {
            serviceId: service.id,
            externalId: railwayServiceId,
            status: 'failed',
            receipt: {
              success: false,
              message: `Failed to configure ${service.name} before deploy`,
              error: configReceipt.error || configReceipt.message,
            },
          };
        }
      }

      // Datastore wiring is supplied by apply from the exact declared component.
      // A service action must never discover or attach unrelated project plugins.
      let rolloutBaseline: Record<string, unknown> | undefined;
      let runtimeRolloutRequired = false;
      if (Object.keys(envVars).length > 0) {
        const envForVarSync: Environment = {
          ...environment,
          platformBindings: {
            ...bindings,
            services: {
              ...(bindings.services ?? {}),
              [service.name]: { serviceId: railwayServiceId },
            },
          },
        };
        const envReceipt = options.deferDeployment
          ? await this.setEnvVars(
            envForVarSync,
            service,
            envVars,
            { deferDeployment: true }
          )
          : await this.setEnvVars(envForVarSync, service, envVars);
        if (!envReceipt.success) {
          if (createdService) {
            return failedCreateRecovery(
              identifiedCreateRecovery(railwayServiceId),
              `Railway created ${service.name}, but environment-variable configuration failed`,
              envReceipt.error ?? envReceipt.message,
              true
            );
          }
          return {
            serviceId: service.id,
            externalId: railwayServiceId,
            status: 'failed',
            receipt: {
              success: false,
              message: `Failed to configure environment variables for ${service.name}`,
              error: envReceipt.error ?? envReceipt.message,
              data: {
                provider: this.name,
                phase: 'setEnvVars',
                railwayServiceId,
                environmentId: railwayEnvId,
              },
            },
          };
        }
        const envRolloutBaseline = envReceipt.data?.rolloutBaseline;
        if (envRolloutBaseline && typeof envRolloutBaseline === 'object' && !Array.isArray(envRolloutBaseline)) {
          rolloutBaseline = envRolloutBaseline as Record<string, unknown>;
        }
        runtimeRolloutRequired = envReceipt.data?.runtimeRolloutRequired === true;
      }

      // CI-managed branch deploys release an exact SHA after hv_apply. Do not
      // redeploy the previous image merely because its configuration changed.
      if (!options.deferDeployment && railwayEnvId) {
        const redeployMutation = gql`
          mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
            serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
          }
        `;
        try {
          await this.client.request(redeployMutation, {
            serviceId: railwayServiceId,
            environmentId: railwayEnvId,
          });
        } catch (error) {
          if (createdService) {
            return failedCreateRecovery(
              identifiedCreateRecovery(railwayServiceId),
              `Railway created ${service.name}, but redeploy failed`,
              this.describeError(error),
              true
            );
          }
          throw error;
        }
      }

      // Public services need a Railway-generated service domain; Railway does
      // not create one automatically (the "Generate Domain" button in its UI).
      let url: string | undefined;
      let domainError: string | undefined;
      if (service.buildConfig.public === true && railwayEnvId) {
        const ensured = await this.ensureServiceDomain(railwayServiceId, railwayEnvId);
        url = ensured.domain ? `https://${ensured.domain}` : undefined;
        domainError = ensured.error;
      }

      return {
        serviceId: service.id,
        externalId: railwayServiceId,
        ...(url ? { url } : {}),
        status: options.deferDeployment ? 'configured' : 'deploying',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared ${service.name} for CI deployment`
            : `Deployment triggered for ${service.name}`,
          data: {
            railwayServiceId,
            environmentId: railwayEnvId,
            createdService,
            providerResourceName: providerServiceName,
            ...(runtimeRolloutRequired
              ? {
                  runtimeRolloutRequired: true,
                  ...(rolloutBaseline ? { rolloutBaseline } : {}),
                }
              : {}),
            ...(options.deferDeployment
              ? {
                deploymentDeferred: true,
              }
              : {}),
            ...(serviceResolution.ignoredBoundServiceId ? { replacedServiceBinding: serviceResolution.ignoredBoundServiceId } : {}),
            ...(url ? { url } : {}),
            ...(domainError ? { domainError } : {}),
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Deployment failed for ${service.name}`,
          error: String(error),
        },
      };
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const safeReceipt = (receipt: Receipt): Receipt => redactExactValues(receipt, Object.values(vars));

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const projectId = bindings.projectId;
    let environmentId = bindings.environmentId;

    if (!projectId) {
      return safeReceipt({
        success: false,
        message: 'No Railway project bound to this environment',
      });
    }

    try {
      environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);

      if (!environmentId) {
        return safeReceipt({
          success: false,
          message: 'No Railway environment ID available for variable update',
        });
      }

      const serviceResolution = await this.resolveServiceIdForEnvironment(
        projectId,
        this.railwayServiceNameCandidates(service.name, environment.name),
        environmentId,
        bindings.services?.[service.name]?.serviceId
      );
      const railwayServiceId = serviceResolution.serviceId;
      if (!railwayServiceId) {
        return safeReceipt({
          success: false,
          message: `Service ${service.name} not found in Railway environment ${environment.name}`,
          data: {
            phase: 'resolveService',
            projectId,
            environmentId,
            ...(serviceResolution.ignoredBoundServiceId
              ? { staleBinding: true, ignoredBoundServiceId: serviceResolution.ignoredBoundServiceId }
              : {}),
          },
        });
      }

      const mutation = gql`
        mutation UpsertVariables($projectId: String!, $serviceId: String!, $environmentId: String!, $variables: EnvironmentVariables!, $skipDeploys: Boolean!) {
          variableCollectionUpsert(
            input: {
              projectId: $projectId
              serviceId: $serviceId
              environmentId: $environmentId
              variables: $variables
              skipDeploys: $skipDeploys
            }
          )
        }
      `;

      const ensuredInstance = await this.ensureServiceInstanceForEnvironment(
        railwayServiceId,
        environmentId
      );
      if (!ensuredInstance.success) {
        return safeReceipt({
          success: false,
          message: `Railway service ${service.name} is missing an instance in environment ${environment.name}`,
          error: ensuredInstance.error,
          data: {
            phase: 'ensureServiceInstance',
            serviceId: railwayServiceId,
            environmentId,
          },
        });
      }

      let rolloutBaseline: { state: 'present' | 'absent' | 'unknown'; deploymentId?: string } | undefined;
      if (!options.deferDeployment) {
        try {
          const instance = await this.getServiceInstanceDetails(railwayServiceId, environmentId);
          rolloutBaseline = instance
            ? instance.latestDeployment?.id
              ? { state: 'present', deploymentId: instance.latestDeployment.id }
              : instance.latestDeployment === null
                ? { state: 'absent' }
                : { state: 'unknown' }
            : { state: 'unknown' };
        } catch {
          rolloutBaseline = { state: 'unknown' };
        }
      }

      await this.client.request(mutation, {
        projectId: projectId,
        serviceId: railwayServiceId,
        environmentId: environmentId,
        variables: vars,
        skipDeploys: options.deferDeployment === true,
      });

      if (options.deferDeployment) {
        try {
          const instance = await this.getServiceInstanceDetails(railwayServiceId, environmentId);
          rolloutBaseline = instance
            ? instance.latestDeployment?.id
              ? { state: 'present', deploymentId: instance.latestDeployment.id }
              : instance.latestDeployment === null
                ? { state: 'absent' }
                : { state: 'unknown' }
            : { state: 'unknown' };
        } catch {
          // The variable mutation succeeded, but absence was not proven. Keep
          // rollout verification fail-closed until a later deployment can be
          // compared with a known baseline.
          rolloutBaseline = { state: 'unknown' };
        }
      }

      return safeReceipt({
        success: true,
        message: `Set ${Object.keys(vars).length} environment variables`,
        data: {
          variableCount: Object.keys(vars).length,
          ...(Object.keys(vars).length > 0
            ? {
                runtimeRolloutRequired: true,
                ...(rolloutBaseline ? { rolloutBaseline } : {}),
              }
            : {}),
          ...(options.deferDeployment
            ? {
                deploymentDeferred: true,
              }
            : {}),
        },
      });
    } catch (error) {
      return safeReceipt({
        success: false,
        message: 'Failed to set environment variables',
        error: this.describeError(error),
      });
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const projectId = bindings.projectId;
    if (!projectId) {
      return {
        success: false,
        message: 'No Railway project bound to this environment',
      };
    }

    const uniqueKeys = [...new Set(keys)].sort();
    const invalidKey = uniqueKeys.find((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    if (invalidKey) {
      return {
        success: false,
        message: 'Failed to delete environment variables',
        error: `Invalid environment variable name: ${invalidKey}`,
      };
    }
    if (uniqueKeys.length === 0) {
      return {
        success: true,
        message: 'No environment variables were selected for deletion',
        data: { deletedKeys: [], variableCount: 0, redeployMayBeTriggered: false },
      };
    }

    try {
      const environmentId = await this.resolveRailwayEnvironmentId(projectId, environment);
      if (!environmentId) {
        return {
          success: false,
          message: 'No Railway environment ID available for variable deletion',
        };
      }

      const serviceResolution = await this.resolveServiceIdForEnvironment(
        projectId,
        this.railwayServiceNameCandidates(service.name, environment.name),
        environmentId,
        bindings.services?.[service.name]?.serviceId
      );
      const railwayServiceId = serviceResolution.serviceId;
      if (!railwayServiceId) {
        return {
          success: false,
          message: `Service ${service.name} not found in Railway environment ${environment.name}`,
        };
      }

      let rolloutBaseline: { state: 'present' | 'absent' | 'unknown'; deploymentId?: string };
      try {
        const instance = await this.getServiceInstanceDetails(railwayServiceId, environmentId);
        rolloutBaseline = instance
          ? instance.latestDeployment?.id
            ? { state: 'present', deploymentId: instance.latestDeployment.id }
            : instance.latestDeployment === null
              ? { state: 'absent' }
              : { state: 'unknown' }
          : { state: 'unknown' };
      } catch {
        rolloutBaseline = { state: 'unknown' };
      }

      const mutation = gql`
        mutation DeleteVariable($input: VariableDeleteInput!) {
          variableDelete(input: $input)
        }
      `;
      const deletedKeys: string[] = [];
      for (const key of uniqueKeys) {
        try {
          await this.client.request(mutation, {
            input: {
              projectId,
              serviceId: railwayServiceId,
              environmentId,
              name: key,
            },
          });
          deletedKeys.push(key);
        } catch (error) {
          return {
            success: false,
            message: `Deleted ${deletedKeys.length} of ${uniqueKeys.length} environment variables`,
            error: String(error),
            data: {
              deletedKeys,
              failedKey: key,
              variableCount: deletedKeys.length,
              redeployMayBeTriggered: deletedKeys.length > 0,
            },
          };
        }
      }

      return {
        success: true,
        message: `Deleted ${deletedKeys.length} explicitly retired environment variables`,
        data: {
          deletedKeys,
          variableCount: deletedKeys.length,
          // Railway's documented single-variable delete does not expose the
          // skipDeploys option available to variable upserts.
          redeployMayBeTriggered: true,
          runtimeRolloutRequired: true,
          rolloutBaseline,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete environment variables',
        error: String(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string; reason?: string }> {
    if (!this.client) {
      return {
        status: 'unknown',
        reason: 'Railway deployment observation requires a verified connection.',
      };
    }

    // First attempt: deployment ID lookup (legacy behavior).
    try {
      const deploymentQuery = gql`
        query GetDeployment($id: String!) {
          deployment(id: $id) {
            id
            status
            staticUrl
          }
        }
      `;

      const deploymentResult = await this.client.request<{
        deployment: { id: string; status: string; staticUrl?: string } | null;
      }>(deploymentQuery, { id: deploymentId });

      if (deploymentResult.deployment) {
        return {
          status: this.normalizeStatus(deploymentResult.deployment.status),
          url: deploymentResult.deployment.staticUrl,
        };
      }
    } catch {
      // A bound service ID is not a deployment ID, so use the environment-
      // scoped service lookup below. Failures from that authoritative lookup
      // are preserved in the returned observation reason.
    }

    const environmentId = parseHostingBindings(environment).environmentId;
    if (!environmentId) {
      return {
        status: 'unknown',
        reason: `Railway deployment observation for service ${deploymentId} requires a bound environmentId.`,
      };
    }

    // Second attempt: treat deploymentId as a service ID (current deploy flow),
    // supporting both connection and array response shapes.
    const serviceQueries = [
      {
        name: 'serviceInstances connection query',
        query: gql`
          query GetServiceStatusConnection($id: String!) {
            service(id: $id) {
              id
              serviceInstances {
                edges {
                  node {
                    environmentId
                    latestDeployment {
                      id
                      status
                      staticUrl
                    }
                  }
                }
              }
            }
          }
        `,
      },
      {
        name: 'serviceInstances direct query',
        query: gql`
          query GetServiceStatusDirect($id: String!) {
            service(id: $id) {
              id
              serviceInstances {
                environmentId
                latestDeployment {
                  id
                  status
                  staticUrl
                }
              }
            }
          }
        `,
      },
    ];
    const queryErrors: string[] = [];

    for (const { name, query } of serviceQueries) {
      try {
        const serviceResult = await this.client.request<Record<string, unknown>>(query, { id: deploymentId });
        const selection = this.extractServiceInstance(serviceResult, environmentId);
        if (!selection.recognized) {
          queryErrors.push(`${name}: Railway returned an unrecognized serviceInstances shape`);
          continue;
        }
        if (!selection.instance) {
          return {
            status: 'unknown',
            reason: `Railway service ${deploymentId} has no instance in bound environment ${environmentId}.`,
          };
        }
        const latestDeployment = selection.instance.latestDeployment;
        if (!latestDeployment?.status) {
          return {
            status: 'unknown',
            reason: `Railway service ${deploymentId} has no latest deployment in bound environment ${environmentId}.`,
          };
        }
        return {
          status: this.normalizeStatus(latestDeployment.status),
          url: latestDeployment.staticUrl,
        };
      } catch (error) {
        queryErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      status: 'unknown',
      reason: `Railway deployment observation failed for service ${deploymentId} in environment ${environmentId}: ${queryErrors.join('; ')}`,
    };
  }

  private extractServiceInstance(
    payload: Record<string, unknown>,
    environmentId: string
  ): RailwayDeploymentInstanceSelection {
    const service = payload.service as
      | {
          serviceInstances?:
            | { edges?: Array<{ node?: RailwayDeploymentInstance }> }
            | RailwayDeploymentInstance[];
        }
      | undefined;
    const instances = service?.serviceInstances;
    if (!instances) return { recognized: false };

    const edges = (instances as { edges?: Array<{ node?: RailwayDeploymentInstance }> }).edges;
    if (Array.isArray(edges)) {
      return {
        recognized: true,
        instance: edges.find((edge) => edge.node?.environmentId === environmentId)?.node ?? null,
      };
    }

    if (Array.isArray(instances)) {
      return {
        recognized: true,
        instance: instances.find((instance) => instance.environmentId === environmentId) ?? null,
      };
    }

    return { recognized: false };
  }

  private normalizeStatus(status: string): string {
    const normalized = status.toUpperCase();
    if (normalized.includes('SUCCESS')) return 'deployed';
    if (normalized.includes('FAIL')) return 'failed';
    if (normalized.includes('CANCEL')) return 'canceled';
    if (normalized.includes('BUILD') || normalized.includes('QUEUED') || normalized.includes('DEPLOY')) {
      return 'deploying';
    }
    return status.toLowerCase();
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<JobResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const client = this.client;
    const startedAt = Date.now();
    const cleanupWarnings: string[] = [];
    const fail = (message: string, error?: string, data?: Record<string, unknown>): JobResult => ({
      jobId: '',
      status: 'failed',
      runner: 'railway-temp-service',
      durationMs: Date.now() - startedAt,
      ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join(' ') } : {}),
      receipt: {
        success: false,
        message,
        ...(error ? { error } : {}),
        ...(data ? { data } : {}),
      },
    });

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string }>;
    };
    const projectId = bindings.projectId;
    const environmentId = bindings.environmentId;
    const sourceServiceId = bindings.services?.[service.name]?.serviceId;
    if (!projectId || !environmentId || !sourceServiceId) {
      return fail(
        `Railway environment task requires bindings for service ${service.name}`,
        'Missing Railway project/environment/service bindings. Apply service convergence first.'
      );
    }

    const sweepWarning = await this.sweepTaskServices(projectId, environmentId);
    if (sweepWarning) {
      cleanupWarnings.push(sweepWarning);
    }

    const ensuredSourceInstance = await this.ensureServiceInstanceForEnvironment(
      sourceServiceId,
      environmentId
    );
    if (!ensuredSourceInstance.success) {
      return fail(
        `Railway environment task requires service ${service.name} in environment ${environment.name}`,
        ensuredSourceInstance.error,
        { phase: 'ensureServiceInstance', serviceId: sourceServiceId, environmentId }
      );
    }

    // Tasks run the deployed image so they execute the same code and deps.
    let image: string | undefined;
    try {
      const result = await client.request<{ serviceInstance?: { source?: { image?: string | null } | null } }>(
        gql`
          query TaskSourceInstance($serviceId: String!, $environmentId: String!) {
            serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
              source {
                image
              }
            }
          }
        `,
        { serviceId: sourceServiceId, environmentId }
      );
      image = result.serviceInstance?.source?.image ?? undefined;
    } catch (error) {
      return fail(
        `Could not read the deployed image for ${service.name}`,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!image) {
      return fail(
        `Railway environment task requires a deployed image for service ${service.name}`,
        'The service has no image source yet. Deploy it first (push to the deploy branch or hv_ci_trigger), then re-run the task.',
        { pendingDeploy: true }
      );
    }

    let variables: Record<string, string>;
    try {
      const vars = await this.getServiceVariables(projectId, sourceServiceId, environmentId);
      // RAILWAY_* are provider-injected for the SOURCE service; the temp
      // service gets its own set from Railway.
      variables = Object.fromEntries(Object.entries(vars).filter(([key]) => !key.startsWith('RAILWAY_')));
    } catch (error) {
      return fail(
        `Could not read env vars for ${service.name}`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const taskName = `hv-task-${Date.now()}`;
    let taskServiceId: string;
    try {
      const created = await client.request<{ serviceCreate: { id: string } }>(
        gql`
          mutation CreateTaskService($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
              name
            }
          }
        `,
        {
          input: {
            projectId,
            environmentId,
            name: taskName,
            ...(Object.keys(variables).length > 0 ? { variables } : {}),
          },
        }
      );
      taskServiceId = created.serviceCreate.id;
    } catch (error) {
      return fail(
        'Could not create the temporary Railway task service',
        error instanceof Error ? error.message : String(error)
      );
    }

    const runTask = async (): Promise<JobResult> => {
      const pull = image.startsWith('ghcr.io/') ? githubPackagePullCredentials() : null;
      // The sentinel is the exit-code source of truth: Railway deployment
      // statuses have no run-to-completion value for a NEVER-restart service.
      const startCommand = buildTaskStartCommand(command);
      await client.request(
        gql`
          mutation ConfigureTaskService(
            $serviceId: String!
            $environmentId: String!
            $input: ServiceInstanceUpdateInput!
          ) {
            serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
          }
        `,
        {
          serviceId: taskServiceId,
          environmentId,
          input: {
            source: { image },
            ...(pull ? { registryCredentials: { username: pull.username, password: pull.token } } : {}),
            startCommand,
            restartPolicyType: 'NEVER',
            restartPolicyMaxRetries: 0,
          },
        }
      );

      const deployResult = await client.request<{ serviceInstanceDeployV2?: string }>(
        gql`
          mutation DeployTaskService($serviceId: String!, $environmentId: String!) {
            serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
          }
        `,
        { serviceId: taskServiceId, environmentId }
      );
      const deploymentId = deployResult.serviceInstanceDeployV2;
      if (!deploymentId) {
        return fail('Railway did not return a deployment id for the task service');
      }

      const timeoutMs = options?.timeoutMs ?? 4 * 60 * 1000;
      const pollIntervalMs = options?.pollIntervalMs ?? 3000;
      const deadline = Date.now() + timeoutMs;
      let exitCode: number | undefined;
      let deployStatus = 'UNKNOWN';
      let logs: RailwayLogEntry[] = [];
      const outputFrom = (entries: RailwayLogEntry[]): string => entries
        .slice(-100)
        .map((entry) => entry.message)
        .filter((message) => !message.includes(TASK_EXIT_SENTINEL_PREFIX))
        .join('\n')
        .slice(-4000);
      for (;;) {
        try {
          const statusResult = await client.request<{ deployment?: { status?: string } }>(
            gql`
              query TaskDeploymentStatus($id: String!) {
                deployment(id: $id) {
                  status
                }
              }
            `,
            { id: deploymentId }
          );
          deployStatus = statusResult.deployment?.status ?? deployStatus;
        } catch {
          // Keep the last known status; transient API errors must not kill the poll.
        }
        try {
          logs = await this.getDeploymentLogs(deploymentId, 500);
        } catch {
          // Logs are unavailable while the image is still building.
        }
        const logText = logs.map((entry) => entry.message).join('\n');
        const match = logText.match(TASK_EXIT_SENTINEL);
        if (match) {
          exitCode = Number(match[1]);
          break;
        }
        if (logText.includes(TASK_EXIT_SENTINEL_PREFIX)) {
          const durationMs = Date.now() - startedAt;
          const output = outputFrom(logs);
          const data = { taskService: taskName, taskServiceId, deploymentId, image, deployStatus };
          return {
            jobId: deploymentId,
            status: 'failed',
            durationMs,
            output,
            runner: 'railway-temp-service',
            ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join(' ') } : {}),
            receipt: {
              success: false,
              message: 'Railway environment task emitted a malformed exit sentinel',
              error: `Task logs contained ${TASK_EXIT_SENTINEL_PREFIX} but no parseable exit code. This indicates a Hypervibe command-wrapper bug.`,
              data,
            },
          };
        }
        if (deployStatus === 'CRASHED' || deployStatus === 'FAILED') {
          break;
        }
        if (Date.now() >= deadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      const durationMs = Date.now() - startedAt;
      const output = outputFrom(logs);
      const data = { taskService: taskName, taskServiceId, deploymentId, image, deployStatus };
      if (exitCode === 0) {
        return {
          jobId: deploymentId,
          status: 'completed',
          exitCode,
          durationMs,
          output,
          runner: 'railway-temp-service',
          receipt: { success: true, message: `Completed Railway environment task for ${service.name}`, data },
        };
      }
      if (exitCode !== undefined) {
        return {
          jobId: deploymentId,
          status: 'failed',
          exitCode,
          durationMs,
          output,
          runner: 'railway-temp-service',
          receipt: {
            success: false,
            message: `Railway environment task exited with code ${exitCode}`,
            error: `Command exited with code ${exitCode}. Check the task output.`,
            data,
          },
        };
      }
      if (deployStatus === 'CRASHED' || deployStatus === 'FAILED') {
        return {
          jobId: deploymentId,
          status: 'failed',
          durationMs,
          output,
          runner: 'railway-temp-service',
          receipt: {
            success: false,
            message: `Railway environment task deployment ended as ${deployStatus} before the command reported an exit code`,
            error: 'The task container failed to start (image pull or boot failure). Check the task output and registry credentials.',
            data,
          },
        };
      }
      return {
        jobId: deploymentId,
        status: 'timeout',
        durationMs,
        output,
        runner: 'railway-temp-service',
        receipt: {
          success: false,
          message: `Railway environment task did not finish within ${Math.round(timeoutMs / 60000)} minute(s)`,
          error: 'No exit sentinel appeared in the task logs before the timeout.',
          data,
        },
      };
    };

    let outcome: JobResult;
    try {
      outcome = await runTask();
    } catch (error) {
      outcome = fail(
        `Railway environment task failed for ${service.name}`,
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      const deleted = await this.deleteService(taskServiceId, {
        scope: 'environment',
        projectId,
        environmentId,
      }, { allowMutation: true });
      if (!deleted.success) {
        cleanupWarnings.push(`Temporary task service ${taskName} (${taskServiceId}) could not be deleted: ${deleted.error ?? 'unknown error'}. Delete it in Railway to avoid billing.`);
      }
    } catch (error) {
      cleanupWarnings.push(`Temporary task service ${taskName} (${taskServiceId}) could not be deleted: ${error instanceof Error ? error.message : String(error)}. Delete it in Railway to avoid billing.`);
    }

    return { ...outcome, ...(cleanupWarnings.length > 0 ? { cleanupWarning: cleanupWarnings.join(' ') } : {}) };
  }

  private async sweepTaskServices(projectId: string, environmentId: string): Promise<string | undefined> {
    try {
      const services = await this.listProjectServices(projectId, { throwOnFailure: true });
      const taskServices = services.filter((service) => service.name.startsWith('hv-task-'));
      const failures: string[] = [];

      for (const service of taskServices) {
        try {
          const deleted = await this.deleteService(service.id, {
            scope: 'environment',
            projectId,
            environmentId,
          }, { allowMutation: true });
          if (!deleted.success) {
            failures.push(`${service.name} (${service.id}): ${deleted.error ?? 'unknown error'}`);
          }
        } catch (error) {
          failures.push(`${service.name} (${service.id}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return failures.length > 0
        ? `Could not delete leftover Railway task service(s): ${failures.join('; ')}.`
        : undefined;
    } catch (error) {
      return `Could not inspect leftover Railway task services before run: ${error instanceof Error ? error.message : String(error)}.`;
    }
  }

  /**
   * Get the database connection URL from a Railway service
   * Useful for running migrations locally against remote DB
   */
  async getDatabaseUrl(
    projectId: string,
    environmentId: string,
    serviceId: string
  ): Promise<string | null> {
    const vars = await this.getServiceVariables(projectId, serviceId, environmentId);
    return vars['DATABASE_URL'] || vars['DATABASE_PRIVATE_URL'] || null;
  }

  async listProjects(): Promise<RailwayProject[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    // The top-level `projects` query spans every workspace the token can
    // access. `me { projects }` only returns personal-account projects, which
    // silently hides workspace/team projects.
    const query = gql`
      query ListProjects($after: String) {
        projects(first: 100, after: $after) {
          edges {
            node {
              id
              name
              description
              createdAt
              updatedAt
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    try {
      return await this.listProjectConnection(query, (payload) => {
        if (!isRecord(payload) || !('projects' in payload)) {
          throw new RailwayProjectPaginationError('Railway returned an invalid top-level project inventory.');
        }
        return payload.projects;
      });
    } catch (error) {
      // Only GraphQL validation proves this query never ran. Authorization,
      // transport, pagination, and payload failures must remain unknown rather
      // than falling back to the narrower personal-project inventory.
      if (!this.isGraphqlSchemaCompatibilityError(error)) throw error;

      const legacyQuery = gql`
        query ListPersonalProjects($after: String) {
          me {
            projects(first: 100, after: $after) {
              edges {
                node {
                  id
                  name
                  description
                  createdAt
                  updatedAt
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `;
      return this.listProjectConnection(legacyQuery, (payload) => {
        if (!isRecord(payload) || !isRecord(payload.me) || !('projects' in payload.me)) {
          throw new RailwayProjectPaginationError('Railway returned an invalid personal project inventory.');
        }
        return payload.me.projects;
      });
    }
  }

  private async listProjectConnection(
    query: string,
    extractConnection: (payload: unknown) => unknown
  ): Promise<RailwayProject[]> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const all: RailwayProject[] = [];
    const seenCursors = new Set<string>();
    const seenProjectIds = new Set<string>();
    const configuredPageLimit = Number(process.env.HYPERVIBE_RAILWAY_PROJECT_PAGE_LIMIT ?? 1000);
    const pageLimit = Number.isFinite(configuredPageLimit) && configuredPageLimit >= 1
      ? Math.floor(configuredPageLimit)
      : 1000;
    let pagesRead = 0;
    let after: string | null = null;

    do {
      if (pagesRead >= pageLimit) {
        throw new RailwayProjectPaginationError(`Railway project pagination exceeded ${pageLimit} pages.`);
      }
      let payload: unknown;
      try {
        payload = await this.client.request<unknown>(query, { after });
      } catch (error) {
        if (pagesRead > 0 && this.isGraphqlSchemaCompatibilityError(error)) {
          throw new RailwayProjectPaginationError(
            `Railway project pagination failed schema validation after ${pagesRead} successful page(s): ${this.describeError(error)}`
          );
        }
        throw error;
      }
      const connection = extractConnection(payload);
      if (!isRecord(connection) || !Array.isArray(connection.edges) || !isRecord(connection.pageInfo)
        || typeof connection.pageInfo.hasNextPage !== 'boolean'
        || (connection.pageInfo.endCursor !== null && typeof connection.pageInfo.endCursor !== 'string')) {
        throw new RailwayProjectPaginationError('Railway returned a malformed project connection.');
      }

      for (const [index, edge] of connection.edges.entries()) {
        if (!isRecord(edge) || !isRecord(edge.node)
          || typeof edge.node.id !== 'string' || edge.node.id.length === 0
          || typeof edge.node.name !== 'string' || edge.node.name.length === 0) {
          throw new RailwayProjectPaginationError(`Railway returned an invalid project at edge ${index}.`);
        }
        if (seenProjectIds.has(edge.node.id)) {
          throw new RailwayProjectPaginationError(`Railway returned duplicate project id "${edge.node.id}".`);
        }
        seenProjectIds.add(edge.node.id);
        all.push({
          id: edge.node.id,
          name: edge.node.name,
          ...(typeof edge.node.description === 'string' ? { description: edge.node.description } : {}),
          ...(typeof edge.node.createdAt === 'string' ? { createdAt: edge.node.createdAt } : {}),
          ...(typeof edge.node.updatedAt === 'string' ? { updatedAt: edge.node.updatedAt } : {}),
        });
      }
      pagesRead += 1;

      if (!connection.pageInfo.hasNextPage) {
        after = null;
        continue;
      }
      const nextCursor = connection.pageInfo.endCursor;
      if (!nextCursor) {
        throw new RailwayProjectPaginationError(
          'Railway project pagination reported another page without an end cursor.'
        );
      }
      if (seenCursors.has(nextCursor)) {
        throw new RailwayProjectPaginationError(
          `Railway project pagination repeated cursor "${nextCursor}".`
        );
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
    } while (after);

    return all;
  }

  async getProjectDetails(projectId: string): Promise<RailwayProjectDetails | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    try {
      const query = gql`
        query GetProjectDetails($id: String!) {
          project(id: $id) {
            id
            name
            description
            environments {
              edges {
                node {
                  id
                  name
                  config(decryptVariables: false)
                }
              }
            }
            buckets {
              edges { node { id name } }
            }
            services {
              edges {
                node {
                  id
                  name
                  icon
                  repoTriggers {
                    edges {
                      node {
                        repository
                        branch
                      }
                    }
                  }
                  serviceInstances {
                    edges {
                      node {
                        environmentId
                        domains {
                          serviceDomains {
                            domain
                          }
                          customDomains {
                            id
                            domain
                            status {
                              verified
                              certificateStatus
                              dnsRecords {
                                currentValue
                                fqdn
                                hostlabel
                                purpose
                                recordType
                                requiredValue
                                status
                                zone
                              }
                              verificationDnsHost
                              verificationToken
                            }
                          }
                        }
                        startCommand
                        preDeployCommand
                        healthcheckPath
                        cronSchedule
                        numReplicas
                        sleepApplication
                        source { image }
                        latestDeployment {
                          id
                          status
                        }
                      }
                    }
                  }
                }
              }
            }
            plugins {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `;

      const result = await this.client.request<unknown>(query, { id: projectId });
      if (!isRecord(result) || !('project' in result)) {
        throw new Error(`Railway returned an invalid project-details response for ${projectId}.`);
      }
      if (result.project === null) return null;
      return this.validateProjectDetails(result.project, projectId);
    } catch (error) {
      if (this.isProviderConfirmedNotFound(error, 'project')) {
        return null;
      }
      throw error;
    }
  }

  private validateProjectDetails(value: unknown, expectedProjectId: string): RailwayProjectDetails {
    if (!isRecord(value)
      || typeof value.id !== 'string' || value.id !== expectedProjectId
      || typeof value.name !== 'string' || value.name.length === 0) {
      throw new Error(`Railway returned partial or mismatched project details for ${expectedProjectId}.`);
    }

    const requireEdges = (connection: unknown, label: string): Array<Record<string, unknown>> => {
      if (!isRecord(connection) || !Array.isArray(connection.edges)) {
        throw new Error(`Railway project ${expectedProjectId} omitted its ${label} inventory.`);
      }
      return connection.edges.map((edge, index) => {
        if (!isRecord(edge) || !isRecord(edge.node)) {
          throw new Error(`Railway project ${expectedProjectId} returned an invalid ${label} edge at index ${index}.`);
        }
        return edge;
      });
    };
    const requireIdentity = (node: Record<string, unknown>, label: string): void => {
      if (typeof node.id !== 'string' || node.id.length === 0
        || typeof node.name !== 'string' || node.name.length === 0) {
        throw new Error(`Railway project ${expectedProjectId} returned a partial ${label} identity.`);
      }
    };

    for (const edge of requireEdges(value.environments, 'environment')) {
      requireIdentity(edge.node as Record<string, unknown>, 'environment');
    }
    for (const edge of requireEdges(value.services, 'service')) {
      const node = edge.node as Record<string, unknown>;
      requireIdentity(node, 'service');
      requireEdges(node.repoTriggers, 'service repo-trigger');
      requireEdges(node.serviceInstances, 'service instance');
    }
    for (const edge of requireEdges(value.plugins, 'plugin')) {
      requireIdentity(edge.node as Record<string, unknown>, 'plugin');
    }
    if (value.buckets !== undefined) {
      for (const edge of requireEdges(value.buckets, 'bucket')) {
        requireIdentity(edge.node as Record<string, unknown>, 'bucket');
      }
    }

    return value as unknown as RailwayProjectDetails;
  }

  async getServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string
  ): Promise<Record<string, string>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    return this.fetchServiceVariables(projectId, serviceId, environmentId);
  }

  async readProviderEnvironmentVariables(
    request: ProviderEnvironmentVariablesRequest
  ): Promise<ProviderEnvironmentVariablesResult> {
    const bindings = parseHostingBindings(request.environment);
    const projectId = bindings.projectId;
    const environmentId = bindings.environmentId;
    const serviceId = bindings.services?.[request.service.name]?.serviceId;
    if (!projectId || !environmentId || !serviceId) {
      return {
        success: false,
        error: `Service ${request.service.name} is missing Railway bindings in ${request.environment.name}`,
      };
    }
    return {
      success: true,
      variables: await this.getServiceVariables(projectId, serviceId, environmentId),
    };
  }

  private async fetchServiceVariables(
    projectId: string,
    serviceId: string,
    environmentId: string
  ): Promise<Record<string, string>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetVariables($projectId: String!, $serviceId: String!, $environmentId: String!) {
        variables(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId)
      }
    `;

    const result = await this.client.request<{ variables: Record<string, string> }>(query, {
      projectId,
      serviceId,
      environmentId,
    });
    return result.variables ?? {};
  }

  /**
   * Read-only lookup of a public TCP proxy for a service port. Used by
   * plan-time resolution, which must never mutate live infrastructure.
   */
  async getTcpProxy(
    environmentId: string,
    serviceId: string,
    applicationPort: number
  ): Promise<RailwayTcpProxy | null> {
    const proxies = await this.listTcpProxies(environmentId, serviceId);
    return proxies.find((proxy) => proxy.applicationPort === applicationPort) ?? null;
  }

  private async listTcpProxies(environmentId: string, serviceId: string): Promise<RailwayTcpProxy[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query TcpProxies($environmentId: String!, $serviceId: String!) {
        tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
          id
          domain
          proxyPort
          applicationPort
          syncStatus
          deletedAt
        }
      }
    `;

    const result = await this.client.request<{ tcpProxies?: RailwayTcpProxy[] }>(query, {
      environmentId,
      serviceId,
    });
    return (result.tcpProxies ?? []).filter((proxy) =>
      !proxy.deletedAt && proxy.syncStatus !== 'DELETED' && proxy.syncStatus !== 'DELETING'
    );
  }

  /**
   * Ensure a public TCP proxy exists for a service port (e.g. postgres 5432)
   * so externally-run tools (pg_dump/pg_restore, CI) can reach an otherwise
   * internal-only datastore. Reuses an existing proxy for the same
   * application port when one is present.
   */
  async ensureTcpProxy(
    environmentId: string,
    serviceId: string,
    applicationPort: number
  ): Promise<{ id: string; domain: string; proxyPort: number; created: boolean }> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const existing = await this.getTcpProxy(environmentId, serviceId, applicationPort);
    if (existing) {
      return { id: existing.id, domain: existing.domain, proxyPort: existing.proxyPort, created: false };
    }

    const mutation = gql`
      mutation TcpProxyCreate($input: TCPProxyCreateInput!) {
        tcpProxyCreate(input: $input) {
          id
          domain
          proxyPort
          applicationPort
        }
      }
    `;

    try {
      const result = await this.client.request<{ tcpProxyCreate?: RailwayTcpProxy }>(mutation, {
        input: { environmentId, serviceId, applicationPort },
      });
      const created = result.tcpProxyCreate;
      if (!created?.domain || typeof created.proxyPort !== 'number') {
        throw new Error('Railway returned an empty tcpProxyCreate payload');
      }
      return { id: created.id, domain: created.domain, proxyPort: created.proxyPort, created: true };
    } catch (error) {
      throw new Error(this.describeError(error));
    }
  }

  /** Delete one TCP proxy and verify it is no longer active. */
  async deleteTcpProxy(environmentId: string, serviceId: string, proxyId: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const mutation = gql`
      mutation TcpProxyDelete($id: String!) {
        tcpProxyDelete(id: $id)
      }
    `;

    try {
      const before = await this.listTcpProxies(environmentId, serviceId);
      if (!before.some((proxy) => proxy.id === proxyId)) {
        return;
      }
      const result = await this.client.request<{ tcpProxyDelete?: boolean }>(mutation, { id: proxyId });
      if (result.tcpProxyDelete !== true) {
        const afterUnconfirmedDelete = await this.listTcpProxies(environmentId, serviceId);
        if (!afterUnconfirmedDelete.some((proxy) => proxy.id === proxyId)) {
          return;
        }
        throw new Error(`Railway did not confirm deletion of TCP proxy ${proxyId}`);
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const proxies = await this.listTcpProxies(environmentId, serviceId);
        if (!proxies.some((proxy) => proxy.id === proxyId)) {
          return;
        }
        if (attempt < 7) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      throw new Error(`TCP proxy ${proxyId} is still active after Railway confirmed deletion`);
    } catch (error) {
      throw new Error(this.describeError(error));
    }
  }

  async acquireTemporaryDatabaseAccess(
    environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    const ids = this.databaseAccessIds(environment, component);
    if (!ids) {
      throw new Error('Railway database bindings are missing projectId, environmentId, or serviceId.');
    }

    const proxy = await this.ensureTcpProxy(ids.environmentId, ids.serviceId, applicationPort);
    try {
      const vars = await this.getServiceVariables(ids.projectId, ids.serviceId, ids.environmentId);
      const connectionUrl = this.buildProxyDatabaseUrl(vars, proxy);
      if (!connectionUrl) {
        throw new Error('Railway datastore variables are missing PGUSER or POSTGRES_PASSWORD.');
      }
      return {
        connectionUrl,
        source: proxy.created ? 'created_proxy' : 'existing_proxy',
        endpoint: `${proxy.domain.replace(/\.+$/, '')}:${proxy.proxyPort}`,
        temporary: proxy.created,
        ...(proxy.created ? { releaseToken: proxy.id } : {}),
      };
    } catch (error) {
      if (proxy.created) {
        try {
          await this.deleteTcpProxy(ids.environmentId, ids.serviceId, proxy.id);
        } catch (cleanupError) {
          throw new Error(
            `${this.describeError(error)} Cleanup also failed for temporary TCP proxy ${proxy.id}: ${this.describeError(cleanupError)}`
          );
        }
      }
      throw new Error(this.describeError(error));
    }
  }

  async releaseTemporaryDatabaseAccess(
    environment: Environment,
    component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    if (!access.releaseToken) {
      throw new Error('Temporary Railway database access is missing its cleanup token.');
    }
    const ids = this.databaseAccessIds(environment, component);
    if (!ids) {
      throw new Error('Railway database bindings are missing environmentId or serviceId for cleanup.');
    }
    await this.deleteTcpProxy(ids.environmentId, ids.serviceId, access.releaseToken);
  }

  private databaseAccessIds(
    environment: Environment,
    component: Component
  ): { projectId: string; environmentId: string; serviceId: string } | null {
    const componentBindings = component.bindings as Record<string, unknown>;
    const environmentBindings = environment.platformBindings as Record<string, unknown>;
    const projectId = typeof componentBindings.projectId === 'string'
      ? componentBindings.projectId
      : typeof environmentBindings.projectId === 'string' ? environmentBindings.projectId : undefined;
    const environmentId = typeof environmentBindings.environmentId === 'string'
      ? environmentBindings.environmentId
      : undefined;
    const serviceId = component.externalId
      ?? (typeof componentBindings.serviceId === 'string' ? componentBindings.serviceId : undefined);
    return projectId && environmentId && serviceId ? { projectId, environmentId, serviceId } : null;
  }

  private buildProxyDatabaseUrl(
    vars: Record<string, string>,
    proxy: { domain: string; proxyPort: number }
  ): string | null {
    const user = vars.PGUSER;
    const password = vars.POSTGRES_PASSWORD;
    if (!user || !password) return null;
    const database = vars.PGDATABASE || vars.POSTGRES_DB;
    if (!database) return null;
    const domain = proxy.domain.replace(/\.+$/, '');
    return `postgresql://${user}:${encodeURIComponent(password)}@${domain}:${proxy.proxyPort}/${database}`;
  }

  async updateServiceInstanceConfig(params: {
    serviceId: string;
    environmentId: string;
    startCommand?: string;
    releaseCommand?: string;
    healthcheckPath?: string;
    cronSchedule?: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const input: Record<string, unknown> = {};
    if (params.startCommand) {
      input.startCommand = params.startCommand;
    }
    if (params.releaseCommand) {
      // Railway models the release/predeploy step as preDeployCommand: [String!]
      input.preDeployCommand = [params.releaseCommand];
    }
    if (params.healthcheckPath) {
      input.healthcheckPath = params.healthcheckPath;
    }
    if (params.cronSchedule) {
      input.cronSchedule = params.cronSchedule;
    }

    if (Object.keys(input).length === 0) {
      return {
        success: true,
        message: 'No Railway service instance updates requested',
      };
    }

    const mutation = gql`
      mutation UpdateServiceInstance(
        $serviceId: String!
        $environmentId: String!
        $input: ServiceInstanceUpdateInput!
      ) {
        serviceInstanceUpdate(
          serviceId: $serviceId
          environmentId: $environmentId
          input: $input
        )
      }
    `;

    try {
      await this.client.request(mutation, {
        serviceId: params.serviceId,
        environmentId: params.environmentId,
        input,
      });
      return {
        success: true,
        message: 'Railway service instance updated',
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Railway service instance',
        error: this.describeError(error),
      };
    }
  }

  async connectServiceToRepo(params: {
    serviceId: string;
    repo: string;
    branch: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const mutation = gql`
      mutation ServiceConnect($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) {
          id
        }
      }
    `;

    try {
      await this.client.request(mutation, {
        id: params.serviceId,
        input: {
          repo: params.repo,
          branch: params.branch,
        },
      });

      return {
        success: true,
        message: 'Railway service connected to repository',
        data: {
          repo: params.repo,
          branch: params.branch,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to connect Railway service to repository',
        error: this.describeError(error),
      };
    }
  }

  async disconnectDeploySource(params: { serviceId: string }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const mutation = gql`
      mutation ServiceDisconnect($id: String!) {
        serviceDisconnect(id: $id) {
          id
        }
      }
    `;

    try {
      const result = await this.client.request<{
        serviceDisconnect?: { id?: string } | null;
      }>(mutation, { id: params.serviceId });
      const disconnectedId = result.serviceDisconnect?.id;
      if (!disconnectedId || disconnectedId !== params.serviceId) {
        return {
          success: false,
          message: 'Failed to disconnect Railway service deploy source',
          error: disconnectedId
            ? `Railway serviceDisconnect returned unexpected service id ${disconnectedId}.`
            : 'Railway serviceDisconnect returned no service id.',
        };
      }
      return {
        success: true,
        message: 'Railway service deploy source disconnected',
        data: { serviceId: disconnectedId },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to disconnect Railway service deploy source',
        error: this.describeError(error),
      };
    }
  }

  private normalizeRailwayRecordName(record: RailwayCustomDomainDnsRecord): string | null {
    const fqdn = typeof record.fqdn === 'string' ? record.fqdn.trim().replace(/\.$/, '') : '';
    if (fqdn) {
      return fqdn;
    }

    const hostlabel = typeof record.hostlabel === 'string' ? record.hostlabel.trim() : '';
    const zone = typeof record.zone === 'string' ? record.zone.trim() : '';
    if (!hostlabel && !zone) {
      return null;
    }
    if (hostlabel === '@' || hostlabel.length === 0) {
      return zone || null;
    }
    if (!zone) {
      return hostlabel;
    }
    return `${hostlabel}.${zone}`;
  }

  private extractCustomDomainDnsRecords(status?: RailwayCustomDomainStatus | null): NormalizedDnsRecord[] {
    const records: NormalizedDnsRecord[] = [];

    for (const record of status?.dnsRecords ?? []) {
      const name = this.normalizeRailwayRecordName(record);
      const normalized = normalizeProviderDnsRecord({
        name,
        type: record.recordType,
        value: record.requiredValue,
        currentValue: record.currentValue,
        purpose: record.purpose,
        status: record.status,
      });
      if (!normalized) {
        continue;
      }
      records.push(normalized);
    }

    const verificationHost = status?.verificationDnsHost?.trim().replace(/\.$/, '');
    const verificationToken = status?.verificationToken?.trim();
    if (verificationHost && verificationToken) {
      records.push({
        name: verificationHost,
        type: 'TXT',
        value: verificationToken,
        purpose: 'verification',
      });
    }

    return records;
  }

  async getCustomDomainStatus(params: {
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<RailwayCustomDomain | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetServiceCustomDomains($id: String!) {
        service(id: $id) {
          id
          serviceInstances {
            edges {
              node {
                environmentId
                domains {
                  customDomains {
                    id
                    domain
                    status {
                      verified
                      certificateStatus
                      dnsRecords {
                        currentValue
                        fqdn
                        hostlabel
                        purpose
                        recordType
                        requiredValue
                        status
                        zone
                      }
                      verificationDnsHost
                      verificationToken
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const result = await this.client.request<{
        service?: {
          serviceInstances?: {
            edges?: Array<{
              node?: {
                environmentId?: string;
                domains?: {
                  customDomains?: RailwayCustomDomain[];
                };
              };
            }>;
          };
        };
      }>(query, { id: params.serviceId });

      const matches = (result.service?.serviceInstances?.edges ?? [])
        .filter((edge) => edge.node?.environmentId === params.environmentId)
        .flatMap((edge) => edge.node?.domains?.customDomains ?? [])
        .filter((domain) => domain.domain.toLowerCase() === params.domain.toLowerCase());
      if (matches.length > 1) {
        throw new Error(`Multiple Railway custom-domain attachments match ${params.domain} in environment ${params.environmentId}.`);
      }
      return matches[0] ?? null;
    } catch (error) {
      throw new Error(`Failed to observe Railway custom domain ${params.domain}: ${this.describeError(error)}`);
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (!params.projectId) {
      return {
        success: false,
        message: 'Failed to attach Railway custom domain',
        error: 'Railway custom-domain creation requires the Railway projectId, but no project binding was available. Re-run hv_status or hv_plan to refresh repo bindings, then retry.',
      };
    }

    const ensuredInstance = await this.ensureServiceInstanceForEnvironment(
      params.serviceId,
      params.environmentId
    );
    if (!ensuredInstance.success) {
      return {
        success: false,
        message: 'Failed to attach Railway custom domain',
        error: `Railway service ${params.serviceId} has no service instance in environment ${params.environmentId}: ${ensuredInstance.error}`,
        data: {
          phase: 'ensureServiceInstance',
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
      };
    }

    const existing = await this.getCustomDomainStatus(params);
    if (existing) {
      let current = existing;
      let refreshed = false;
      if (existing.status?.verified === false) {
        const mutation = gql`
          mutation RefreshCustomDomain($id: String!, $environmentId: String!) {
            customDomainUpdate(id: $id, environmentId: $environmentId)
          }
        `;
        try {
          await this.client.request<{ customDomainUpdate: boolean }>(mutation, {
            id: existing.id,
            environmentId: params.environmentId,
          });
          refreshed = true;
          current = await this.getCustomDomainStatus(params) ?? existing;
        } catch (error) {
          return {
            success: false,
            message: 'Failed to refresh pending Railway custom domain',
            error: this.describeError(error),
            data: {
              domain: existing.domain,
              customDomainId: existing.id,
              phase: 'customDomainUpdate',
            },
          };
        }
      }
      return {
        success: true,
        message: refreshed
          ? 'Railway custom domain already attached; refreshed pending verification'
          : 'Railway custom domain already attached',
        data: {
          domain: current.domain,
          customDomainId: current.id,
          created: false,
          ...(refreshed ? { refreshed: true } : {}),
          ...(typeof current.status?.verified === 'boolean'
            ? { providerVerified: current.status.verified }
            : {}),
          ...(current.status?.certificateStatus
            ? { certificateStatus: current.status.certificateStatus }
            : {}),
          dnsRecords: this.extractCustomDomainDnsRecords(current.status),
        },
      };
    }

    const mutation = gql`
      mutation CreateCustomDomain($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) {
          id
          domain
        }
      }
    `;

    try {
      const result = await this.client.request<{
        customDomainCreate: {
          id: string;
          domain: string;
        };
      }>(mutation, {
        input: {
          projectId: params.projectId,
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
      });

      const current = await this.getCustomDomainStatus(params);
      return {
        success: true,
        message: 'Railway custom domain attached',
        data: {
          domain: result.customDomainCreate.domain,
          customDomainId: result.customDomainCreate.id,
          created: true,
          ...(typeof current?.status?.verified === 'boolean'
            ? { providerVerified: current.status.verified }
            : {}),
          ...(current?.status?.certificateStatus
            ? { certificateStatus: current.status.certificateStatus }
            : {}),
          dnsRecords: this.extractCustomDomainDnsRecords(current?.status),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to attach Railway custom domain',
        error: this.describeError(error),
      };
    }
  }

  async detachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    customDomainId?: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const existing = await this.getCustomDomainStatus(params);
    if (!existing) {
      return {
        success: true,
        message: 'Railway custom domain is already absent',
        data: {
          domain: params.domain,
          customDomainId: params.customDomainId,
          alreadyAbsent: true,
        },
      };
    }
    if (params.customDomainId && existing.id !== params.customDomainId) {
      return {
        success: false,
        message: 'Railway custom-domain identity changed',
        error: `Reviewed custom-domain id ${params.customDomainId} does not match observed id ${existing.id} for ${params.domain}.`,
      };
    }

    const mutation = gql`
      mutation DeleteCustomDomain($id: String!) {
        customDomainDelete(id: $id)
      }
    `;
    try {
      const deleted = await this.client.request<{ customDomainDelete: boolean }>(
        mutation,
        { id: existing.id }
      );
      if (deleted.customDomainDelete !== true) {
        return {
          success: false,
          message: 'Failed to detach Railway custom domain',
          error: `Railway did not confirm deletion of custom-domain id ${existing.id}.`,
        };
      }
      const remaining = await this.getCustomDomainStatus(params);
      if (remaining) {
        return {
          success: false,
          message: 'Railway custom-domain deletion is not complete',
          error: `Railway custom-domain id ${remaining.id} still exists for ${params.domain} after deletion.`,
        };
      }
      return {
        success: true,
        message: 'Railway custom domain detached',
        data: {
          domain: params.domain,
          customDomainId: existing.id,
          deleted: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to detach Railway custom domain',
        error: this.describeError(error),
      };
    }
  }

  async recreateCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<Receipt> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (!params.projectId) {
      return {
        success: false,
        message: 'Failed to recreate Railway custom domain',
        error: 'Railway custom-domain creation requires the Railway projectId, but no project binding was available. Re-run hv_status or hv_plan to refresh repo bindings, then retry.',
      };
    }

    const ensuredInstance = await this.ensureServiceInstanceForEnvironment(
      params.serviceId,
      params.environmentId
    );
    if (!ensuredInstance.success) {
      return {
        success: false,
        message: 'Failed to recreate Railway custom domain',
        error: `Railway service ${params.serviceId} has no service instance in environment ${params.environmentId}: ${ensuredInstance.error}`,
        data: {
          phase: 'ensureServiceInstance',
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
      };
    }

    let existing: RailwayCustomDomain | null;
    try {
      existing = await this.getCustomDomainStatus(params);
    } catch (error) {
      return {
        success: false,
        message: 'Failed to recreate Railway custom domain',
        error: this.describeError(error),
        data: {
          phase: 'observeCustomDomain',
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
      };
    }

    if (existing) {
      const deleteMutation = gql`
        mutation DeleteCustomDomain($id: String!) {
          customDomainDelete(id: $id)
        }
      `;
      try {
        const deleted = await this.client.request<{ customDomainDelete: boolean }>(
          deleteMutation,
          { id: existing.id }
        );
        if (deleted.customDomainDelete !== true) {
          return {
            success: false,
            message: 'Failed to recreate Railway custom domain',
            error: `Railway did not confirm deletion of custom domain ${params.domain}`,
            data: {
              phase: 'customDomainDelete',
              customDomainId: existing.id,
              domain: params.domain,
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          message: 'Failed to recreate Railway custom domain',
          error: this.describeError(error),
          data: {
            phase: 'customDomainDelete',
            customDomainId: existing.id,
            domain: params.domain,
          },
        };
      }
      try {
        const remaining = await this.getCustomDomainStatus(params);
        if (remaining) {
          return {
            success: false,
            message: 'Railway custom-domain deletion is not yet terminal',
            error: `Railway custom domain ${params.domain} still exists after deletion; retry after provider deletion converges.`,
            data: {
              phase: 'customDomainDeleteVerification',
              customDomainId: remaining.id,
              domain: params.domain,
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          message: 'Failed to verify Railway custom-domain deletion',
          error: this.describeError(error),
          data: {
            phase: 'customDomainDeleteVerification',
            customDomainId: existing.id,
            domain: params.domain,
          },
        };
      }
    }

    const createMutation = gql`
      mutation CreateCustomDomain($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) {
          id
          domain
        }
      }
    `;

    try {
      const created = await this.client.request<{
        customDomainCreate: {
          id: string;
          domain: string;
        };
      }>(createMutation, {
        input: {
          projectId: params.projectId,
          serviceId: params.serviceId,
          environmentId: params.environmentId,
          domain: params.domain,
        },
      });
      const current = await this.getCustomDomainStatus(params);

      return {
        success: true,
        message: existing
          ? 'Railway custom domain deleted and recreated'
          : 'Railway custom domain created because no previous attachment existed',
        data: {
          domain: created.customDomainCreate.domain,
          ...(existing ? { previousCustomDomainId: existing.id } : {}),
          customDomainId: created.customDomainCreate.id,
          created: true,
          recreated: Boolean(existing),
          ...(typeof current?.status?.verified === 'boolean'
            ? { providerVerified: current.status.verified }
            : {}),
          ...(current?.status?.certificateStatus
            ? { certificateStatus: current.status.certificateStatus }
            : {}),
          dnsRecords: this.extractCustomDomainDnsRecords(current?.status),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to recreate Railway custom domain',
        error: this.describeError(error),
        data: {
          phase: 'customDomainCreate',
          domain: params.domain,
          ...(existing ? { deletedCustomDomainId: existing.id } : {}),
        },
      };
    }
  }

  /**
   * Return the service's Railway-generated domain for an environment,
   * creating one when none exists. Returns null (with error) on failure
   * rather than throwing, so a domain problem degrades to a missing URL
   * instead of failing the deploy.
   */
  private async ensureServiceDomain(
    serviceId: string,
    environmentId: string
  ): Promise<{ domain: string | null; error?: string }> {
    if (!this.client) {
      return { domain: null, error: 'Not connected. Call connect() first.' };
    }
    try {
      const query = gql`
        query ServiceDomains($serviceId: String!) {
          service(id: $serviceId) {
            serviceInstances {
              edges {
                node {
                  environmentId
                  domains {
                    serviceDomains {
                      domain
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const existing = await this.client.request<{
        service?: {
          serviceInstances?: {
            edges?: Array<{
              node?: {
                environmentId?: string;
                domains?: { serviceDomains?: Array<{ domain?: string }> };
              };
            }>;
          };
        };
      }>(query, { serviceId });
      const instance = existing.service?.serviceInstances?.edges
        ?.map((edge) => edge.node)
        .find((node) => node?.environmentId === environmentId);
      const current = instance?.domains?.serviceDomains?.[0]?.domain;
      if (current) {
        return { domain: current };
      }

      const mutation = gql`
        mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) {
            domain
          }
        }
      `;
      const created = await this.client.request<{ serviceDomainCreate?: { domain?: string } }>(
        mutation,
        { input: { serviceId, environmentId } }
      );
      return { domain: created.serviceDomainCreate?.domain ?? null };
    } catch (error) {
      return { domain: null, error: this.describeError(error) };
    }
  }

  /**
   * Whether Railway's GitHub integration (the Railway GitHub App) can access
   * a repo ("owner/name"). serviceConnect can succeed without this — builds
   * work, but Railway's UI shows "repo not found" and pushes never
   * auto-deploy. Returns null when access could not be determined.
   */
  async isGitHubRepoAccessible(fullRepoName: string): Promise<boolean | null> {
    if (!this.client) return null;
    const query = gql`
      query GitHubRepoAccess($fullRepoName: String!) {
        gitHubRepoAccessAvailable(fullRepoName: $fullRepoName) {
          hasAccess
          isPublic
        }
      }
    `;
    try {
      const result = await this.client.request<{
        gitHubRepoAccessAvailable?: { hasAccess?: boolean; isPublic?: boolean };
      }>(query, { fullRepoName });
      const access = result.gitHubRepoAccessAvailable;
      return typeof access?.hasAccess === 'boolean' ? access.hasAccess : null;
    } catch {
      return null;
    }
  }

  async findProjectsByName(name: string): Promise<RailwayProject[]> {
    const projects = await this.listProjects();
    const normalized = name.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase() === normalized);
  }

  /**
   * List plugins in a Railway project
   */
  async listPlugins(projectId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetProjectPlugins($id: String!) {
        project(id: $id) {
          plugins {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;

    const result = await this.client.request<{
      project: { plugins: { edges: Array<{ node: { id: string; name: string } }> } };
    }>(query, { id: projectId });

    return result.project.plugins.edges.map((e) => {
      const name = e.node.name.toLowerCase();
      let type = 'unknown';
      if (name.includes('postgres') || name === 'postgresql') type = 'postgres';
      if (name.includes('redis') || name.includes('valkey')) type = 'redis';

      return { id: e.node.id, name: e.node.name, type };
    });
  }

  async readProviderLogs(request: ProviderRuntimeLogsRequest): Promise<ProviderRuntimeLogsResult> {
    const bindings = parseHostingBindings(request.environment);
    const serviceId = bindings.services?.[request.serviceName]?.serviceId;
    if (!bindings.projectId || !bindings.environmentId || !serviceId) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }
    const deployments = await this.getDeployments(
      bindings.projectId,
      bindings.environmentId,
      serviceId,
      1
    );
    if (deployments.length === 0) {
      return { logs: [] };
    }

    const latestDeployment = deployments[0]!;
    const logs = await this.getDeploymentLogs(latestDeployment.id, request.limit);
    return {
      deploymentStatus: latestDeployment.status,
      deploymentId: latestDeployment.id,
      logs: logs.map((log) => ({
        timestamp: log.timestamp,
        severity: log.severity || 'info',
        message: log.message,
      })),
    };
  }

  async listProviderDeployments(request: ProviderDeploymentsRequest): Promise<ProviderDeployment[]> {
    const bindings = parseHostingBindings(request.environment);
    if (!bindings.projectId || !bindings.environmentId) {
      throw new Error(`Environment not deployed to ${this.name}`);
    }
    const serviceId = request.serviceName
      ? bindings.services?.[request.serviceName]?.serviceId
      : undefined;
    if (request.serviceName && !serviceId) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }
    const deployments = await this.getDeployments(
      bindings.projectId,
      bindings.environmentId,
      serviceId,
      request.limit
    );
    return deployments.map((deployment) => ({
      id: deployment.id,
      status: deployment.status,
      createdAt: deployment.createdAt,
      url: deployment.staticUrl,
    }));
  }

  async readProviderBuildLogs(request: ProviderBuildLogsRequest): Promise<{ deploymentId: string; buildLogs: string }> {
    const bindings = parseHostingBindings(request.environment);
    if (!bindings.projectId || !bindings.environmentId) {
      throw new Error(`Environment not deployed to ${this.name}`);
    }
    const serviceId = bindings.services?.[request.serviceName]?.serviceId;
    if (!serviceId) {
      throw new Error(`Environment/service not fully bound to ${this.name}`);
    }

    let deploymentId = request.deploymentId;
    if (!deploymentId) {
      const deployments = await this.getDeployments(
        bindings.projectId,
        bindings.environmentId,
        serviceId,
        1
      );
      if (deployments.length === 0) {
        throw new Error('No deployments found for service');
      }
      deploymentId = deployments[0]!.id;
    }

    const buildLogs = await this.getBuildLogs(deploymentId);
    return { deploymentId, buildLogs: buildLogs || 'No build logs available' };
  }

  async getDeployments(
    projectId: string,
    environmentId: string,
    serviceId?: string,
    limit = 10
  ): Promise<RailwayDeployment[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetDeployments($projectId: String!, $environmentId: String!, $serviceId: String, $first: Int) {
        deployments(
          input: {
            projectId: $projectId
            environmentId: $environmentId
            serviceId: $serviceId
          }
          first: $first
        ) {
          edges {
            node {
              id
              status
              createdAt
              staticUrl
            }
          }
        }
      }
    `;

    const result = await this.client.request<{
      deployments: { edges: Array<{ node: RailwayDeployment }> };
    }>(query, { projectId, environmentId, serviceId, first: limit });

    return result.deployments.edges.map((e) => e.node);
  }

  async getDeploymentLogs(
    deploymentId: string,
    limit = 500
  ): Promise<RailwayLogEntry[]> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetLogs($deploymentId: String!, $limit: Int) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp
          message
          severity
        }
      }
    `;

    const result = await this.client.request<{
      deploymentLogs: RailwayLogEntry[];
    }>(query, { deploymentId, limit });
    return result.deploymentLogs ?? [];
  }

  async getBuildLogs(deploymentId: string): Promise<string> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetBuildLogs($deploymentId: String!) {
        buildLogs(deploymentId: $deploymentId) {
          timestamp
          message
          severity
        }
      }
    `;

    const result = await this.client.request<{ buildLogs: RailwayLogEntry[] }>(query, { deploymentId });
    return this.formatRailwayLogEntries(result.buildLogs ?? []);
  }

  private formatRailwayLogEntries(logs: RailwayLogEntry[]): string {
    return logs
      .map((log) => [log.timestamp, log.severity, log.message].filter(Boolean).join(' '))
      .filter((line) => line.length > 0)
      .join('\n');
  }

  private async getBucketState(projectId: string, environmentId: string): Promise<{
    projectBuckets: Array<{ id: string; name: string }>;
    environmentBuckets: Record<string, { region?: string; isCreated?: boolean; isDeleted?: boolean }>;
    unmergedChangesCount: number;
  }> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const query = gql`
      query GetBucketState($projectId: String!, $environmentId: String!) {
        project(id: $projectId) {
          id
          buckets { edges { node { id name } } }
          environments { edges { node { id unmergedChangesCount } } }
        }
        environment(id: $environmentId) { id config(decryptVariables: false) }
      }
    `;
    const result = await this.client.request<unknown>(query, { projectId, environmentId });
    if (!isRecord(result)
      || !Object.prototype.hasOwnProperty.call(result, 'project')
      || !Object.prototype.hasOwnProperty.call(result, 'environment')) {
      throw new Error(`Railway returned an incomplete bucket-state response for project ${projectId} and environment ${environmentId}.`);
    }
    if (!isRecord(result.project) || result.project.id !== projectId) {
      throw new Error(`Railway did not confirm the bound project ${projectId} while observing bucket state.`);
    }
    if (!isRecord(result.project.buckets) || !Array.isArray(result.project.buckets.edges)) {
      throw new Error(`Railway returned an incomplete bucket inventory for project ${projectId}.`);
    }
    const projectBuckets: Array<{ id: string; name: string }> = [];
    const bucketIds = new Set<string>();
    const bucketNames = new Set<string>();
    for (const edge of result.project.buckets.edges) {
      if (!isRecord(edge)
        || !isRecord(edge.node)
        || typeof edge.node.id !== 'string'
        || edge.node.id.trim().length === 0
        || typeof edge.node.name !== 'string'
        || edge.node.name.trim().length === 0) {
        throw new Error(`Railway returned a malformed bucket identity for project ${projectId}.`);
      }
      const normalizedName = edge.node.name.toLowerCase();
      if (bucketIds.has(edge.node.id)) {
        throw new Error(`Railway returned duplicate bucket id ${edge.node.id} for project ${projectId}.`);
      }
      if (bucketNames.has(normalizedName)) {
        throw new Error(`Railway returned multiple buckets named "${edge.node.name}" for project ${projectId}.`);
      }
      bucketIds.add(edge.node.id);
      bucketNames.add(normalizedName);
      projectBuckets.push({ id: edge.node.id, name: edge.node.name });
    }

    if (!isRecord(result.project.environments) || !Array.isArray(result.project.environments.edges)) {
      throw new Error(`Railway returned an incomplete environment inventory for project ${projectId}.`);
    }
    const environmentNodes: Array<{ id: string; unmergedChangesCount: number }> = [];
    const environmentIds = new Set<string>();
    for (const edge of result.project.environments.edges) {
      const unmergedChangesCount = isRecord(edge) && isRecord(edge.node)
        ? edge.node.unmergedChangesCount
        : undefined;
      if (!isRecord(edge)
        || !isRecord(edge.node)
        || typeof edge.node.id !== 'string'
        || edge.node.id.trim().length === 0
        || (unmergedChangesCount !== null
          && (typeof unmergedChangesCount !== 'number'
            || !Number.isSafeInteger(unmergedChangesCount)
            || unmergedChangesCount < 0))) {
        throw new Error(`Railway returned a malformed environment identity or staged-change count for project ${projectId}.`);
      }
      if (environmentIds.has(edge.node.id)) {
        throw new Error(`Railway returned duplicate environment id ${edge.node.id} for project ${projectId}.`);
      }
      environmentIds.add(edge.node.id);
      // Railway's public schema makes this count nullable, and its official
      // client interprets null as no staged changes. A missing field remains
      // invalid so partial observations still fail closed.
      environmentNodes.push({ id: edge.node.id, unmergedChangesCount: unmergedChangesCount ?? 0 });
    }
    const environmentNode = environmentNodes.find((candidate) => candidate.id === environmentId);
    if (!environmentNode) {
      throw new Error(`Railway did not confirm bound environment ${environmentId} in project ${projectId}.`);
    }

    if (!isRecord(result.environment) || result.environment.id !== environmentId) {
      throw new Error(`Railway did not confirm the exact environment ${environmentId} while observing bucket configuration.`);
    }
    if (!Object.prototype.hasOwnProperty.call(result.environment, 'config')
      || !isRecord(result.environment.config)
      || !Object.prototype.hasOwnProperty.call(result.environment.config, 'buckets')
      || !isRecord(result.environment.config.buckets)) {
      throw new Error(`Railway returned an incomplete bucket configuration for environment ${environmentId}.`);
    }
    const environmentBuckets: Record<string, { region?: string; isCreated?: boolean; isDeleted?: boolean }> = {};
    for (const [bucketId, rawConfig] of Object.entries(result.environment.config.buckets)) {
      if (bucketId.trim().length === 0 || !isRecord(rawConfig)) {
        throw new Error(`Railway returned a malformed bucket configuration for environment ${environmentId}.`);
      }
      if (Object.prototype.hasOwnProperty.call(rawConfig, 'region')
        && (typeof rawConfig.region !== 'string' || rawConfig.region.trim().length === 0)) {
        throw new Error(`Railway returned an invalid region for bucket ${bucketId} in environment ${environmentId}.`);
      }
      if (Object.prototype.hasOwnProperty.call(rawConfig, 'isCreated') && typeof rawConfig.isCreated !== 'boolean') {
        throw new Error(`Railway returned an invalid creation state for bucket ${bucketId} in environment ${environmentId}.`);
      }
      if (Object.prototype.hasOwnProperty.call(rawConfig, 'isDeleted') && typeof rawConfig.isDeleted !== 'boolean') {
        throw new Error(`Railway returned an invalid deletion state for bucket ${bucketId} in environment ${environmentId}.`);
      }
      environmentBuckets[bucketId] = {
        ...(typeof rawConfig.region === 'string' ? { region: rawConfig.region } : {}),
        ...(typeof rawConfig.isCreated === 'boolean' ? { isCreated: rawConfig.isCreated } : {}),
        ...(typeof rawConfig.isDeleted === 'boolean' ? { isDeleted: rawConfig.isDeleted } : {}),
      };
    }
    return {
      projectBuckets,
      environmentBuckets,
      unmergedChangesCount: environmentNode.unmergedChangesCount,
    };
  }

  private storageVerificationPolicy(): { attempts: number; delayMs: number } {
    const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_STORAGE_VERIFY_ATTEMPTS ?? 10);
    const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_STORAGE_VERIFY_DELAY_MS ?? 250);
    return {
      attempts: Number.isFinite(configuredAttempts) && configuredAttempts >= 1
        ? Math.min(Math.floor(configuredAttempts), 20)
        : 10,
      delayMs: Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
        ? configuredDelayMs
        : 250,
    };
  }

  /**
   * Reconcile a possibly committed bucketCreate without repeating the
   * mutation. getBucketState proves the exact project and environment scope
   * before any name match is accepted.
   */
  private async recoverBucketIdentityAfterCreate(
    projectId: string,
    environmentId: string,
    requestedName: string
  ): Promise<{ id: string; name: string } | undefined> {
    const { attempts, delayMs } = this.storageVerificationPolicy();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const state = await this.getBucketState(projectId, environmentId);
        const candidate = state.projectBuckets.find(
          (bucket) => bucket.name.toLowerCase() === requestedName.toLowerCase()
        );
        if (candidate) return candidate;
      } catch {
        // An uncertain read cannot prove absence. Keep retrying within the
        // bounded recovery window, then retain an unresolved marker.
      }
      if (attempt < attempts - 1) {
        await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
    }
    return undefined;
  }

  private async getBucketUsage(bucketId: string, environmentId: string): Promise<{ objectCount?: number; sizeBytes?: number }> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const query = gql`
      query BucketUsage($bucketId: String!, $environmentId: String!) {
        bucketInstanceDetails(bucketId: $bucketId, environmentId: $environmentId) { objectCount sizeBytes }
      }
    `;
    const result = await this.client.request<{ bucketInstanceDetails?: { objectCount?: number; sizeBytes?: number } }>(query, { bucketId, environmentId });
    return result.bucketInstanceDetails ?? {};
  }

  private async commitBucketPatch(
    environmentId: string,
    buckets: Record<string, Record<string, unknown>>,
    commitMessage: string
  ): Promise<void> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const mutation = gql`
      mutation CommitBucketPatch($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) {
        environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage)
      }
    `;
    const result = await this.client.request<unknown>(mutation, { environmentId, patch: { buckets }, commitMessage });
    if (!isRecord(result) || result.environmentPatchCommit !== true) {
      throw new Error(`Railway did not acknowledge the bucket configuration commit for environment ${environmentId}; mutation state is unknown.`);
    }
  }

  async ensureStorageContext(
    projectName: string,
    environment: Environment,
    context: { projectId?: string; environmentId?: string } = {}
  ): Promise<Receipt> {
    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
    };
    const projectId = context.projectId ?? bindings.projectId;
    const environmentId = context.environmentId ?? bindings.environmentId;
    if (!projectId || !environmentId) {
      return {
        success: false,
        message: `Failed to resolve Railway storage context for "${environment.name}"`,
        error: 'Railway project/environment bindings are missing. Apply project/environment scaffolding first.',
      };
    }
    return {
      success: true,
      message: `Railway storage context is ready for ${projectName}/${environment.name}`,
      data: { projectId, environmentId },
    };
  }

  async getStorageCredentials(
    environment: Environment,
    externalId: string
  ): Promise<{ bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string; region: string; urlStyle: string }> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = environment.platformBindings as { projectId?: string; environmentId?: string };
    if (!bindings.projectId || !bindings.environmentId) throw new Error('Railway storage context is missing');
    const query = gql`
      query BucketCredentials($projectId: String!, $environmentId: String!, $bucketId: String!) {
        bucketS3Credentials(projectId: $projectId, environmentId: $environmentId, bucketId: $bucketId) {
          endpoint accessKeyId secretAccessKey bucketName region urlStyle
        }
      }
    `;
    const result = await this.client.request<{
      bucketS3Credentials: Array<{
        endpoint: string; accessKeyId: string; secretAccessKey: string; bucketName: string; region: string; urlStyle: string;
      }>;
    }>(query, { projectId: bindings.projectId, environmentId: bindings.environmentId, bucketId: externalId });
    const credential = result.bucketS3Credentials?.[0];
    if (!credential) throw new Error('Railway returned no S3 credentials for the bucket');
    return {
      bucket: credential.bucketName,
      endpoint: credential.endpoint,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      region: credential.region,
      urlStyle: credential.urlStyle,
    };
  }

  async ensureStorage(environment: Environment, name: string, options: { region: string }): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      storageCreateRecovery?: unknown;
    };
    if (!bindings.projectId || !bindings.environmentId) {
      return { success: false, message: `Failed to create Railway bucket "${name}"`, error: 'Railway project/environment bindings are missing. Apply project scaffolding first.' };
    }
    const providerScope = {
      projectId: bindings.projectId,
      environmentId: bindings.environmentId,
    };
    const failedCreateRecovery = (
      recovery: StorageCreateRecovery,
      message: string,
      error: string,
      details: Record<string, unknown> = {}
    ): Receipt => ({
      success: false,
      message,
      error,
      data: {
        provider: 'railway',
        phase: 'bucketCreate',
        region: options.region,
        storageCreateRecovery: recovery,
        ...(recovery.externalId ? { externalId: recovery.externalId } : {}),
        ...details,
      },
    });
    const markerForObservedCandidate = (
      candidate: { id: string; name: string } | undefined,
      returnedId?: string,
      returnedName?: string
    ): StorageCreateRecovery => {
      const exactCandidate = candidate?.name === name ? candidate : undefined;
      if (returnedId) {
        if (exactCandidate?.id === returnedId) {
          return createStorageCreateRecovery({
            provider: 'railway', resourceName: name, providerScope,
            state: 'identified', externalId: returnedId, returnedName: name,
          });
        }
        return createStorageCreateRecovery({
          provider: 'railway', resourceName: name, providerScope,
          state: 'mismatched', externalId: returnedId,
          ...(returnedName && returnedName !== name ? { returnedName } : {}),
        });
      }
      if (candidate) {
        return createStorageCreateRecovery({
          provider: 'railway', resourceName: name, providerScope,
          state: candidate.name === name ? 'identified' : 'mismatched',
          externalId: candidate.id,
          returnedName: candidate.name,
        });
      }
      return createStorageCreateRecovery({
        provider: 'railway', resourceName: name, providerScope, state: 'unresolved',
      });
    };

    const rawRecoveryMap = bindings.storageCreateRecovery;
    if (rawRecoveryMap !== undefined) {
      if (!isRecord(rawRecoveryMap)) {
        return {
          success: false,
          message: `Railway bucket "${name}" has malformed retained create-recovery state`,
          error: 'Repair or explicitly resolve the retained storage-create blocker before retrying. No bucket mutation was attempted.',
          data: { provider: 'railway', phase: 'bucketCreate', mutationAttempted: false },
        };
      }
      if (Object.prototype.hasOwnProperty.call(rawRecoveryMap, name)) {
        const priorRecovery = parseStorageCreateRecovery(rawRecoveryMap[name]);
        const validScope = priorRecovery
          && priorRecovery.provider === 'railway'
          && priorRecovery.resourceName === name
          && Object.keys(priorRecovery.providerScope).length === 2
          && priorRecovery.providerScope.projectId === bindings.projectId
          && priorRecovery.providerScope.environmentId === bindings.environmentId;
        if (!priorRecovery || !validScope) {
          return {
            success: false,
            message: `Railway bucket "${name}" has inconsistent retained create-recovery state`,
            error: 'Inspect the exact Railway project/environment and repair the retained storage-create marker before retrying. No bucket mutation was attempted.',
            data: { provider: 'railway', phase: 'bucketCreate', mutationAttempted: false },
          };
        }
        return failedCreateRecovery(
          priorRecovery,
          `Railway bucket "${name}" has retained create-recovery state`,
          'Use hv_inspect to resolve the exact bucket identity, then explicitly adopt that bucket with hv_import. Hypervibe will not repeat bucketCreate.',
          { mutationAttempted: false }
        );
      }
    }

    let createdBucket: { id: string; name: string } | undefined;
    let patchSubmitted = false;
    try {
      const state = await this.getBucketState(bindings.projectId, bindings.environmentId);
      const existing = state.projectBuckets.filter((bucket) => bucket.name.toLowerCase() === name.toLowerCase());
      if (existing.length > 0) {
        const candidate = existing[0]!;
        return {
          success: false,
          message: `Railway bucket "${candidate.name}" already exists but is not bound locally`,
          error: `Hypervibe will not silently attach or adopt Railway bucket ${candidate.id}. Use hv_import to adopt that exact bucket, then run hv_plan again.`,
          data: { adoptionCandidateExternalId: candidate.id, region: state.environmentBuckets[candidate.id]?.region },
        };
      }
      if (state.unmergedChangesCount > 0) {
        return {
          success: false,
          message: `Railway environment has ${state.unmergedChangesCount} unmerged change(s)`,
          error: 'Commit or discard the staged Railway environment changes before Hypervibe creates the bucket, then re-run hv_plan.',
        };
      }
      const mutation = gql`
        mutation CreateBucket($input: BucketCreateInput!) {
          bucketCreate(input: $input) { id name projectId }
        }
      `;
      let created: unknown;
      try {
        created = await this.client.request<unknown>(mutation, {
          input: { projectId: bindings.projectId, name },
        });
      } catch (error) {
        if (!this.isMutationOutcomeUncertain(error)) {
          return {
            success: false,
            message: `Railway rejected bucket creation for "${name}"`,
            error: this.describeError(error),
            data: { provider: 'railway', phase: 'bucketCreate', mutationAttempted: false, region: options.region },
          };
        }
        const recovered = await this.recoverBucketIdentityAfterCreate(
          bindings.projectId,
          bindings.environmentId,
          name
        );
        const recovery = markerForObservedCandidate(recovered);
        return failedCreateRecovery(
          recovery,
          recovered
            ? `Railway bucket create for "${name}" was recovered but not applied`
            : `Railway bucket create outcome for "${name}" is unresolved`,
          recovered
            ? 'The provider request failed after it may have committed. Hypervibe retained the observed bucket identity for explicit adoption and will not attach or retry it automatically.'
            : 'The provider request failed after it may have committed, and bounded exact-name recovery did not resolve an identity. Inspect Railway and explicitly adopt or clean up the result before retrying.',
          { mutationAttempted: true, verification: recovered ? 'present' : 'unknown' }
        );
      }

      const createdRecord = isRecord(created) && isRecord(created.bucketCreate)
        ? created.bucketCreate
        : undefined;
      const returnedId = typeof createdRecord?.id === 'string' && createdRecord.id.trim().length > 0
        ? createdRecord.id.trim()
        : undefined;
      const returnedName = typeof createdRecord?.name === 'string' && createdRecord.name.trim().length > 0
        ? createdRecord.name
        : undefined;
      const exactAcknowledgement = Boolean(
        returnedId
        && returnedName === name
        && createdRecord?.projectId === bindings.projectId
      );
      if (!exactAcknowledgement || !returnedId) {
        const recovered = await this.recoverBucketIdentityAfterCreate(
          bindings.projectId,
          bindings.environmentId,
          name
        );
        const recovery = markerForObservedCandidate(recovered, returnedId, returnedName);
        return failedCreateRecovery(
          recovery,
          `Railway returned a malformed or mismatched acknowledgement for bucket "${name}"`,
          'The create acknowledgement was not trustworthy, so no bucket attachment was attempted. Hypervibe retained conservative recovery state; inspect the exact Railway project/environment and explicitly adopt the intended bucket before retrying.',
          { mutationAttempted: true, verification: recovered ? 'present' : 'unknown' }
        );
      }
      const exactBucket = { id: returnedId, name };
      createdBucket = exactBucket;

      const { attempts, delayMs } = this.storageVerificationPolicy();
      let creationState: typeof state | undefined;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const observed = await this.getBucketState(bindings.projectId, bindings.environmentId);
        const observedBucket = observed.projectBuckets.find((bucket) => bucket.id === exactBucket.id);
        if (observedBucket?.name === exactBucket.name) {
          creationState = observed;
          break;
        }
        if (attempt < attempts - 1) await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
      if (!creationState) {
        return failedCreateRecovery(
          createStorageCreateRecovery({
            provider: 'railway', resourceName: name, providerScope,
            state: 'identified', externalId: exactBucket.id, returnedName: name,
          }),
          `Created Railway bucket "${name}" but could not verify it`,
          'Provider bucket creation is not yet confirmed. Inspect and explicitly adopt the exact bucket before retrying.',
          { mutationAttempted: true, created: true, verification: 'absent' }
        );
      }
      if (creationState.unmergedChangesCount > 0) {
        return failedCreateRecovery(
          createStorageCreateRecovery({
            provider: 'railway', resourceName: name, providerScope,
            state: 'identified', externalId: exactBucket.id, returnedName: name,
          }),
          `Created Railway bucket "${name}" but found ${creationState.unmergedChangesCount} unmerged change(s) before attachment`,
          'Hypervibe refused to commit a bucket patch alongside staged Railway environment changes. Resolve the staged changes, then explicitly adopt this bucket.',
          { mutationAttempted: true, created: true, verification: 'present' }
        );
      }

      patchSubmitted = true;
      await this.commitBucketPatch(
        bindings.environmentId,
        { [exactBucket.id]: { region: options.region, isCreated: true, isDeleted: false } },
        `Create bucket ${exactBucket.name}`
      );

      let converged = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const observed = await this.getBucketState(bindings.projectId, bindings.environmentId);
        const observedBucket = observed.projectBuckets.find((bucket) => bucket.id === exactBucket.id);
        const instance = observed.environmentBuckets[exactBucket.id];
        if (observedBucket?.name === exactBucket.name
          && instance?.region === options.region
          && instance.isCreated === true
          && instance.isDeleted === false
          && observed.unmergedChangesCount === 0) {
          converged = true;
          break;
        }
        if (attempt < attempts - 1) await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
      if (!converged) {
        return failedCreateRecovery(
          createStorageCreateRecovery({
            provider: 'railway', resourceName: name, providerScope,
            state: 'identified', externalId: exactBucket.id, returnedName: name,
          }),
          `Railway acknowledged bucket "${name}" but its environment attachment did not converge`,
          'The exact bucket region and active environment configuration could not be verified. Inspect and explicitly adopt the bucket before retrying.',
          { mutationAttempted: true, created: true, patchSubmitted: true, verification: 'pending' }
        );
      }
      return { success: true, message: `Created Railway bucket "${exactBucket.name}" in ${options.region}`, data: { externalId: exactBucket.id, region: options.region, created: true } };
    } catch (error) {
      if (createdBucket) {
        return failedCreateRecovery(
          createStorageCreateRecovery({
            provider: 'railway', resourceName: name, providerScope,
            state: 'identified', externalId: createdBucket.id, returnedName: name,
          }),
          `Failed to ensure Railway bucket "${name}" after its identity was acknowledged`,
          this.describeError(error),
          { mutationAttempted: true, created: true, patchSubmitted, verification: 'unknown' }
        );
      }
      return {
        success: false,
        message: `Failed to ensure Railway bucket "${name}"`,
        error: this.describeError(error),
        data: {
          provider: 'railway',
          phase: 'bucketCreate',
          mutationAttempted: false,
          region: options.region,
        },
      };
    }
  }

  async destroyStorage(environment: Environment, externalId: string): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const bindings = environment.platformBindings as { projectId?: string; environmentId?: string };
    if (!bindings.projectId || !bindings.environmentId) {
      return { success: false, message: 'Failed to delete Railway bucket', error: 'Railway project/environment bindings are missing.' };
    }
    let patchSubmitted = false;
    try {
      const state = await this.getBucketState(bindings.projectId, bindings.environmentId);
      const bucket = state.projectBuckets.find((candidate) => candidate.id === externalId);
      const instance = state.environmentBuckets[externalId];
      if (!bucket) {
        if (!instance || instance.isDeleted === true) {
          return { success: true, message: 'Railway bucket is already absent', data: { externalId, deleted: false } };
        }
        return {
          success: false,
          message: 'Failed to delete Railway bucket',
          error: `Railway returned an active environment configuration for bucket ${externalId} without the matching project bucket identity. Deletion state is unknown.`,
          data: { externalId, verification: 'unknown' },
        };
      }
      if (!instance || instance.isDeleted === true) {
        return { success: true, message: 'Railway bucket is already absent', data: { externalId, deleted: false } };
      }
      if (state.unmergedChangesCount > 0) {
        return {
          success: false,
          message: `Railway environment has ${state.unmergedChangesCount} unmerged change(s)`,
          error: 'Commit or discard the staged Railway environment changes before deleting the bucket, then re-run hv_plan.',
        };
      }
      patchSubmitted = true;
      await this.commitBucketPatch(bindings.environmentId, { [externalId]: { isDeleted: true } }, `Delete bucket ${bucket.name}`);

      const configuredAttempts = Number(process.env.HYPERVIBE_RAILWAY_STORAGE_VERIFY_ATTEMPTS ?? 10);
      const configuredDelayMs = Number(process.env.HYPERVIBE_RAILWAY_STORAGE_VERIFY_DELAY_MS ?? 250);
      const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1
        ? Math.min(Math.floor(configuredAttempts), 20)
        : 10;
      const delayMs = Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
        ? configuredDelayMs
        : 250;
      let deleted = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const observed = await this.getBucketState(bindings.projectId, bindings.environmentId);
        const observedBucket = observed.projectBuckets.find((candidate) => candidate.id === externalId);
        const observedInstance = observed.environmentBuckets[externalId];
        if (!observedBucket && observedInstance && observedInstance.isDeleted !== true) {
          throw new Error(`Railway returned an active environment configuration for bucket ${externalId} without its project identity.`);
        }
        if (!observedInstance || observedInstance.isDeleted === true) {
          deleted = true;
          break;
        }
        if (attempt < attempts - 1) await this.sleep(Math.min(delayMs * (2 ** attempt), 2000));
      }
      if (!deleted) {
        return {
          success: false,
          message: `Railway acknowledged deletion of bucket "${bucket.name}" but terminal absence was not verified`,
          error: 'The bucket remains active in the bound environment. Re-run hv_plan before retrying deletion.',
          data: { externalId, deleted: false, patchSubmitted: true, verification: 'pending' },
        };
      }
      return {
        success: true,
        message: `Deleted Railway bucket "${bucket.name}" (Railway permanently deletes it after its recovery window)`,
        data: { externalId, deleted: true },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Railway bucket',
        error: this.describeError(error),
        data: { externalId, patchSubmitted, verification: 'unknown' },
      };
    }
  }

  /**
   * Read back the live state of an environment for spec → observe → diff reconciliation.
   * Never includes raw env var values — only key names and sha256 hashes.
   */
  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const observedAt = new Date().toISOString();
    const warnings: string[] = [];
    let partial = false;

    const bindings = environment.platformBindings as {
      projectId?: string;
      environmentId?: string;
      services?: Record<string, { serviceId?: string; workloadKind?: string; source?: { repo?: string; branch?: string } }>;
    };
    const projectId = bindings.projectId;
    if (!projectId) {
      return {
        provider: 'railway',
        observedAt,
        projectExists: false,
        services: [],
        databases: [],
        caches: [],
        storage: [],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'complete',
          databases: 'complete',
          caches: 'complete',
          storage: 'complete',
        },
        partial: false,
        warnings: [],
      };
    }

    const details = await this.getProjectDetails(projectId);
    if (!details) {
      return {
        provider: 'railway',
        observedAt,
        projectExists: false,
        projectId,
        services: [],
        databases: [],
        caches: [],
        storage: [],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'complete',
          databases: 'complete',
          caches: 'complete',
          storage: 'complete',
        },
        partial: false,
        warnings: [],
      };
    }

    const projectEnvironments = (details.environments?.edges ?? []).map((e) => e.node);
    let environmentId = bindings.environmentId;
    if (!environmentId || !projectEnvironments.some((env) => env.id === environmentId)) {
      environmentId = projectEnvironments.find(
        (env) => env.name.toLowerCase() === environment.name.toLowerCase()
      )?.id;
    }
    if (!environmentId) {
      warnings.push(`Could not resolve Railway environment for "${environment.name}"`);
      return {
        provider: 'railway',
        observedAt,
        projectExists: true,
        projectId,
        services: [],
        databases: [],
        caches: [],
        storage: [],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'unknown',
          databases: 'unknown',
          caches: 'unknown',
          storage: 'unknown',
        },
        partial: true,
        warnings,
      };
    }

    const services: ObservedService[] = [];
    const databases: ObservedDatabase[] = [];
    const caches: ObservedCache[] = [];
    const storage: ObservedStorage[] = [];
    let databaseObservationComplete = true;
    let cacheObservationComplete = true;

    const environmentConfig = projectEnvironments.find((candidate) => candidate.id === environmentId)?.config;
    for (const edge of details.buckets?.edges ?? []) {
      const instance = environmentConfig?.buckets?.[edge.node.id];
      if (!instance || instance.isDeleted === true) continue;
      const usage = await this.getBucketUsage(edge.node.id, environmentId);
      storage.push({
        provider: 'railway',
        kind: 'object',
        externalId: edge.node.id,
        instanceScope: { projectId, environmentId },
        name: edge.node.name,
        region: instance.region,
        status: 'ready',
        ...usage,
      });
    }

    for (const edge of details.services?.edges ?? []) {
      const node = edge.node;
      const instanceEdges = node.serviceInstances?.edges ?? [];
      const instance = instanceEdges.find((e) => e.node.environmentId === environmentId)?.node;
      if (!instance) {
        continue;
      }

      const boundServiceName = this.boundServiceNameForId(bindings.services, node.id);
      const engine = boundServiceName
        ? null
        : this.classifyDatastoreImage(instance.source?.image);
      if (engine) {
        if (engine === 'redis') {
          caches.push({
            provider: 'railway',
            engine: 'redis',
            externalId: node.id,
            providerScope: { projectId, environmentId },
            name: node.name,
            status: this.toObservedDatastoreStatus(instance.latestDeployment?.status),
          });
        } else {
          databases.push({
            provider: 'railway',
            engine,
            externalId: node.id,
            providerScope: { projectId, environmentId },
            name: node.name,
            status: this.toObservedDatastoreStatus(instance.latestDeployment?.status),
          });
        }
        continue;
      }

      const observedServiceName = boundServiceName
        ?? this.hypervibeServiceNameFromRailwayName(node.name, environment.name);

      const serviceDomain = instance?.domains?.serviceDomains?.[0]?.domain;
      const customDomains = (instance?.domains?.customDomains ?? []).map((d) => d.domain);
      const customDomainStatus = Object.fromEntries(
        (instance?.domains?.customDomains ?? []).map((domain) => {
          const dnsRecords = this.extractCustomDomainDnsRecords(domain.status);
          const routingRecords = dnsRecords.filter((record) => record.purpose !== 'verification');
          const dnsConfigured = providerDnsRecordsAreConfigured(routingRecords);
          return [domain.domain, {
            ...(domain.id ? { providerDomainId: domain.id } : {}),
            ...(typeof domain.status?.verified === 'boolean'
              ? { providerVerified: domain.status.verified }
              : {}),
            ...(domain.status?.certificateStatus
              ? { certificateStatus: domain.status.certificateStatus }
              : {}),
            ...(dnsRecords.length > 0 ? { dnsRecords } : {}),
            ...(dnsConfigured !== undefined
              ? { dnsConfigured }
              : {}),
          }];
        })
      );
      const isPublic = Boolean(serviceDomain || customDomains.length > 0);

      let startCommand = instance?.startCommand ?? undefined;
      let releaseCommand: string | undefined;
      let healthCheckPath = instance?.healthcheckPath ?? undefined;
      let cronSchedule: string | undefined;
      let numReplicas: number | undefined;
      let sleepApplication: boolean | undefined;
      let deploymentId: string | undefined;
      let deploymentStatus: string | undefined;
      let instanceSourceRepo: string | undefined;
      let instanceSourceObserved = false;
      let status: ObservedService['status'] = 'unknown';

      if (environmentId) {
        try {
          const instanceDetails = await this.getServiceInstanceDetails(node.id, environmentId);
          if (instanceDetails) {
            instanceSourceObserved = true;
            startCommand = instanceDetails.startCommand ?? startCommand;
            releaseCommand = this.normalizePreDeployCommand(instanceDetails.preDeployCommand);
            healthCheckPath = instanceDetails.healthcheckPath ?? healthCheckPath;
            cronSchedule = instanceDetails.cronSchedule ?? undefined;
            numReplicas = instanceDetails.numReplicas;
            sleepApplication = instanceDetails.sleepApplication;
            deploymentId = instanceDetails.latestDeployment?.id;
            deploymentStatus = instanceDetails.latestDeployment?.status;
            instanceSourceRepo = instanceDetails.source?.repo ?? undefined;
            // No deployment at all means the service has no source connected.
            status = instanceDetails.latestDeployment
              ? this.toObservedStatus(instanceDetails.latestDeployment.status)
              : 'empty';
          }
        } catch (error) {
          warnings.push(`Failed to read service instance for "${observedServiceName}" (${node.name}): ${this.describeError(error)}`);
          partial = true;
        }
      }

      const envVarKeys: string[] = [];
      const envVarHashes: Record<string, string> = {};
      if (environmentId) {
        try {
          const vars = await this.fetchServiceVariables(projectId, node.id, environmentId);
          for (const [key, value] of Object.entries(vars)) {
            envVarKeys.push(key);
            envVarHashes[key] = hashEnvValue(value);
          }
        } catch (error) {
          warnings.push(`Failed to read variables for "${observedServiceName}" (${node.name}): ${this.describeError(error)}`);
          partial = true;
        }
      }

      // serviceConnect sets ServiceInstance.source.repo (per-environment);
      // repoTriggers on the Service is for webhook-configured deploys.
      // Use the instance source as primary, repoTriggers as fallback.
      const repoTrigger = node.repoTriggers?.edges?.[0]?.node;
      const cachedSource = bindings.services?.[observedServiceName]?.source;
      const sourceRepo = instanceSourceRepo ?? repoTrigger?.repository;
      const sourceBranch = repoTrigger?.branch ?? cachedBranchForSource(cachedSource, sourceRepo);
      const sourceState: ObservedService['sourceState'] = sourceRepo
        ? 'connected'
        : instanceSourceObserved
          ? 'disconnected'
          : 'unknown';

      services.push({
        name: observedServiceName,
        externalId: node.id,
        workloadKind: ['web', 'worker', 'cron'].includes(
          bindings.services?.[observedServiceName]?.workloadKind ?? ''
        )
          ? bindings.services![observedServiceName]!.workloadKind as 'web' | 'worker' | 'cron'
          : cronSchedule ? 'cron' : 'web',
        url: serviceDomain ? `https://${serviceDomain}` : undefined,
        customDomains,
        ...(Object.keys(customDomainStatus).length > 0 ? { customDomainStatus } : {}),
        config: {
          startCommand,
          releaseCommand,
          healthCheckPath,
          cronSchedule,
          public: isPublic,
        },
        ...(sourceRepo
          ? { source: { repo: sourceRepo, ...(sourceBranch ? { branch: sourceBranch } : {}) } }
          : {}),
        sourceState,
        envVarKeys,
        envVarHashes,
        status,
        ...(deploymentId
          ? {
              deployment: {
                id: deploymentId,
                ...(deploymentStatus ? { status: deploymentStatus } : {}),
              },
            }
          : {}),
        maintenance: {
          state: !deploymentId || ['REMOVED', 'CANCELLED'].includes(deploymentStatus ?? '')
            ? 'suspended'
            : ['SUCCESS', 'SLEEPING'].includes(deploymentStatus ?? '') ? 'running' : 'unknown',
          ...(deploymentId ? { deploymentId } : {}),
          ...(deploymentStatus ? { deploymentStatus } : {}),
          ...(numReplicas === undefined ? {} : { numReplicas }),
          ...(sleepApplication === undefined ? {} : { sleepApplication }),
        },
      });
    }

    const serviceObservationComplete = !partial;
    for (const edge of details.plugins?.edges ?? []) {
      const node = edge.node;
      const engine = this.classifyDatastoreEngine(node.name);
      if (engine === 'redis') {
        cacheObservationComplete = false;
        caches.push({
          provider: 'railway',
          engine: 'redis',
          externalId: node.id,
          providerScope: { projectId },
          name: node.name,
          status: 'unknown',
        });
      } else {
        databaseObservationComplete = false;
        databases.push({
          provider: 'railway',
          engine: engine ?? 'unknown',
          externalId: node.id,
          providerScope: { projectId },
          name: node.name,
          status: 'unknown',
        });
      }
    }
    if (!databaseObservationComplete || !cacheObservationComplete) {
      partial = true;
      warnings.push(
        'Railway legacy plugin inventory does not expose environment-specific readiness; datastore observation remains unknown.'
      );
    }

    return {
      provider: 'railway',
      observedAt,
      projectExists: true,
      projectId,
      environmentId,
      services,
      databases,
      caches,
      storage,
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: serviceObservationComplete ? 'complete' : 'unknown',
        databases: databaseObservationComplete ? 'complete' : 'unknown',
        caches: cacheObservationComplete ? 'complete' : 'unknown',
        storage: 'complete',
      },
      partial,
      warnings,
    };
  }

  private async getServiceInstanceDetails(
    serviceId: string,
    environmentId: string
  ): Promise<{
    startCommand?: string;
    preDeployCommand?: unknown;
    healthcheckPath?: string;
    cronSchedule?: string;
    numReplicas?: number;
    sleepApplication?: boolean;
    source?: { repo?: string } | null;
    latestDeployment?: { id?: string; status?: string } | null;
  } | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    const query = gql`
      query GetServiceInstance($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          startCommand
          preDeployCommand
          healthcheckPath
          cronSchedule
          numReplicas
          sleepApplication
          source {
            repo
          }
          latestDeployment {
            id
            status
          }
        }
      }
    `;

    const result = await this.client.request<{
      serviceInstance?: {
        startCommand?: string;
        preDeployCommand?: unknown;
        healthcheckPath?: string;
        cronSchedule?: string;
        numReplicas?: number;
        sleepApplication?: boolean;
        source?: { repo?: string } | null;
        latestDeployment?: { id?: string; status?: string } | null;
      } | null;
    }>(query, { serviceId, environmentId });
    return result.serviceInstance ?? null;
  }

  async observeMaintenanceWorkload(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<MaintenanceWorkloadObservation> {
    const bindings = environment.platformBindings as {
      environmentId?: string;
      services?: Record<string, { serviceId?: string }>;
    };
    if (
      !bindings.environmentId
      || !Object.values(bindings.services ?? {}).some((binding) => binding.serviceId === serviceId)
    ) {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_unbound' };
    }
    try {
      const details = await this.getServiceInstanceDetails(serviceId, bindings.environmentId);
      if (!details) {
        return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_missing' };
      }
      const deploymentStatus = details.latestDeployment?.status;
      const suspended = !details.latestDeployment
        || ['REMOVED', 'CANCELLED'].includes(deploymentStatus ?? '');
      const running = ['SUCCESS', 'SLEEPING'].includes(deploymentStatus ?? '');
      return {
        serviceId,
        environmentId: bindings.environmentId,
        workloadKind,
        wasRunning: running,
        state: suspended ? 'suspended' : running ? 'running' : 'unknown',
        deploymentId: details.latestDeployment?.id,
        deploymentStatus,
        numReplicas: details.numReplicas,
        sleepApplication: details.sleepApplication,
        cronSchedule: details.cronSchedule,
      };
    } catch {
      return { serviceId, workloadKind, wasRunning: false, state: 'unknown', reason: 'maintenance_workload_observation_failed' };
    }
  }

  async suspendMaintenanceWorkload(
    environment: Environment,
    expected: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const current = await this.observeMaintenanceWorkload(environment, expected.serviceId, expected.workloadKind);
    if (current.state === 'suspended') {
      return { success: true, message: `Railway workload ${expected.serviceId} is already suspended`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'running' || !current.environmentId || !current.deploymentId) {
      return { success: false, message: 'Railway workload was not suspended', error: 'The exact bound workload deployment could not be verified.' };
    }
    try {
      if (current.cronSchedule) {
        await this.updateMaintenanceInstance(current.environmentId, expected.serviceId, { cronSchedule: null });
      }
      const mutation = gql`
        mutation DeploymentRemove($id: String!) {
          deploymentRemove(id: $id)
        }
      `;
      await this.client.request(mutation, { id: current.deploymentId });
      const verified = await this.waitForRailwayMaintenanceState(environment, expected, 'suspended');
      return verified
        ? { success: true, message: `Suspended Railway workload ${expected.serviceId}`, data: { applied: 1, skipped: 0 } }
        : { success: false, message: 'Railway suspension was not verified', error: 'Railway did not report the reviewed deployment removed before the verification deadline.' };
    } catch (error) {
      return { success: false, message: 'Railway workload was not suspended', error: this.describeError(error) };
    }
  }

  async resumeMaintenanceWorkload(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const current = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
    if (!snapshot.wasRunning) {
      return current.state === 'suspended'
        ? { success: true, message: `Railway workload ${snapshot.serviceId} was stopped before maintenance`, data: { applied: 0, skipped: 1 } }
        : { success: false, message: 'Railway restoration was blocked', error: 'A workload that was previously stopped is now running.' };
    }
    if (current.state === 'running') {
      return { success: true, message: `Railway workload ${snapshot.serviceId} is already running`, data: { applied: 0, skipped: 1 } };
    }
    if (current.state !== 'suspended' || !current.environmentId) {
      return { success: false, message: 'Railway workload was not restored', error: 'The exact bound workload state could not be verified.' };
    }
    try {
      await this.updateMaintenanceInstance(current.environmentId, snapshot.serviceId, {
        ...(snapshot.numReplicas === undefined ? {} : { numReplicas: snapshot.numReplicas }),
        ...(snapshot.sleepApplication === undefined ? {} : { sleepApplication: snapshot.sleepApplication }),
      });
      const redeploy = gql`
        mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }
      `;
      await this.client.request(redeploy, {
        serviceId: snapshot.serviceId,
        environmentId: current.environmentId,
      });
      if (!await this.waitForRailwayMaintenanceState(environment, snapshot, 'running')) {
        return { success: false, message: 'Railway restoration was not verified', error: 'Railway did not report a successful deployment before the verification deadline.' };
      }
      if (snapshot.cronSchedule) {
        await this.updateMaintenanceInstance(current.environmentId, snapshot.serviceId, {
          cronSchedule: snapshot.cronSchedule,
        });
      }
      return { success: true, message: `Restored Railway workload ${snapshot.serviceId}`, data: { applied: 1, skipped: 0 } };
    } catch (error) {
      return { success: false, message: 'Railway workload was not restored', error: this.describeError(error) };
    }
  }

  private async updateMaintenanceInstance(
    environmentId: string,
    serviceId: string,
    input: Record<string, unknown>
  ): Promise<void> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    const mutation = gql`
      mutation ServiceInstanceUpdate(
        $serviceId: String!
        $environmentId: String!
        $input: ServiceInstanceUpdateInput!
      ) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `;
    await this.client.request(mutation, { serviceId, environmentId, input });
  }

  private async waitForRailwayMaintenanceState(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot,
    expected: 'running' | 'suspended'
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const observed = await this.observeMaintenanceWorkload(environment, snapshot.serviceId, snapshot.workloadKind);
      if (observed.state === expected) return true;
      if (observed.state === 'unknown' && ['FAILED', 'CRASHED'].includes(observed.deploymentStatus ?? '')) return false;
      if (attempt < 120) {
        const delay = Number(process.env.HYPERVIBE_RAILWAY_WAIT_DELAY_MS ?? 1000);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  /**
   * Railway returns preDeployCommand as a JSON scalar — a list of command
   * strings (we always write a single-element list). Normalize to the
   * spec's single releaseCommand string for drift comparison.
   */
  private normalizePreDeployCommand(value: unknown): string | undefined {
    if (typeof value === 'string') return value || undefined;
    if (Array.isArray(value)) {
      const commands = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
      return commands.length > 0 ? commands.join(' && ') : undefined;
    }
    return undefined;
  }

  /** Same name-based datastore classification used by listPlugins. */
  private classifyDatastoreEngine(name: string): string | null {
    const normalized = name.toLowerCase();
    if (normalized.includes('postgres')) return 'postgres';
    if (normalized.includes('redis') || normalized.includes('valkey')) return 'redis';
    return null;
  }

  private classifyDatastoreImage(image?: string | null): 'postgres' | 'redis' | null {
    if (!image) return null;
    const normalized = image.toLowerCase();
    if (/(^|\/)postgres(?::|@|$)/.test(normalized)) return 'postgres';
    if (/(^|\/)(?:redis|valkey)(?::|@|$)/.test(normalized)) return 'redis';
    return null;
  }

  private toObservedStatus(status?: string): ObservedService['status'] {
    if (!status) return 'unknown';
    const normalized = status.toUpperCase();
    if (normalized.includes('SUCCESS')) return 'running';
    if (normalized.includes('FAIL') || normalized.includes('CRASH')) return 'failed';
    return 'unknown';
  }

  private toObservedDatastoreStatus(
    status?: string
  ): ObservedDatabase['status'] {
    if (!status) return 'unknown';
    const normalized = status.toUpperCase();
    if (normalized.includes('SUCCESS') || normalized === 'SLEEPING') return 'running';
    if (normalized.includes('FAIL') || normalized.includes('CRASH')) return 'error';
    if (normalized.includes('REMOVED') || normalized.includes('CANCEL')) return 'stopped';
    if (
      normalized.includes('BUILD')
      || normalized.includes('DEPLOY')
      || normalized.includes('QUEUE')
      || normalized.includes('INITIAL')
      || normalized.includes('WAIT')
    ) return 'provisioning';
    return 'unknown';
  }
}

export interface RailwayProject {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RailwayServiceInstance {
  environmentId: string;
  domains: {
    serviceDomains: Array<{ domain: string }>;
    customDomains: Array<{ id?: string; domain: string; status?: RailwayCustomDomainStatus | null }>;
  };
  startCommand?: string;
  preDeployCommand?: unknown;
  healthcheckPath?: string;
  cronSchedule?: string;
  numReplicas?: number;
  sleepApplication?: boolean;
  source?: { image?: string | null } | null;
  latestDeployment?: { id?: string; status?: string } | null;
}

export interface RailwayTcpProxy {
  id: string;
  domain: string;
  proxyPort: number;
  applicationPort: number;
  syncStatus?: string;
  deletedAt?: string | null;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  staticUrl?: string;
}

export interface RailwayCustomDomainDnsRecord {
  fqdn?: string;
  hostlabel?: string;
  purpose?: string;
  recordType?: string;
  requiredValue?: string;
  currentValue?: string;
  status?: string;
  zone?: string;
}

export interface RailwayCustomDomainStatus {
  verified?: boolean;
  certificateStatus?: string;
  dnsRecords?: RailwayCustomDomainDnsRecord[];
  verificationDnsHost?: string;
  verificationToken?: string;
}

export interface RailwayCustomDomain {
  id: string;
  domain: string;
  status?: RailwayCustomDomainStatus | null;
}

export interface RailwayLogEntry {
  timestamp: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
}

export interface RailwayProjectDetails {
  id: string;
  name: string;
  description?: string;
  environments: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        config?: { buckets?: Record<string, { region?: string; isDeleted?: boolean }> };
      };
    }>;
  };
  services: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        icon?: string;
        repoTriggers: {
          edges: Array<{
            node: {
              repository: string;
              branch: string;
            };
          }>;
        };
        serviceInstances: {
          edges: Array<{
            node: RailwayServiceInstance;
          }>;
        };
      };
    }>;
  };
  plugins: {
    edges: Array<{
      node: {
        id: string;
        name: string;
      };
    }>;
  };
  buckets?: {
    edges: Array<{ node: { id: string; name: string } }>;
  };
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'railway',
    displayName: 'Railway',
    category: 'deployment',
    credentialsSchema: RailwayCredentialsSchema,
    setupHelpUrl: 'https://railway.com/account/tokens',
    credentials: {
      defaultScalarKey: 'apiToken',
      localEnvInputs: [
        {
          envKey: 'HYPERVIBE_RAILWAY_TOKEN',
          credentialKeys: ['apiToken'],
          comment: 'Railway API token for the selected workspace and project infrastructure',
        },
      ],
    },
    maturity: {
      lifecycle: {
        hosting: { status: 'ready-for-live' },
        database: { status: 'ready-for-live' },
        cache: { status: 'ready-for-live' },
        storage: { status: 'ready-for-live' },
        queue: {
          status: 'ready-for-live',
          reason: 'Postgres-backed queue wiring is implemented; live promotion evidence has not been recorded.',
        },
      },
    },
    lifecycle: {
      hosting: { workloadKinds: ['web', 'worker', 'cron'], customDomains: 'managed', maintenance: 'managed', teardownBoundary: 'environment' },
      databaseEngines: ['postgres'],
      databaseConnectivity: { compatibleHostingProviders: ['railway'] },
      cacheEngines: ['redis'],
      cacheConnectivity: { compatibleHostingProviders: ['railway'] },
      queue: { backend: 'postgres', resources: 'application-managed' },
    },
    orchestration: {
      project: {
        shareAcrossEnvironments: true,
      },
      environment: {
        separateResource: true,
      },
      diff: {
        requiresBranchDeployForCode: true,
        workloadKindObservation: 'cron-only',
        presenceOnlyManagedEnvVar: ({ value }) => /^\$\{\{[^}]+\}\}$/.test(value),
      },
      logs: {
        runtime: true,
        deployments: true,
        build: true,
      },
      ci: {
        displayName: 'Railway',
        requiredSecrets: RAILWAY_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          RAILWAY_API_TOKEN: 'apiToken',
        },
        requiresGitHubPackagePull: true,
        buildGitHubActionsSteps: buildRailwayGitHubActionsSteps,
        buildPortableRecipe: buildRailwayPortableRecipe,
        portableRunnerCapabilities: ['linux-amd64', 'docker-privileged'],
        diagnoseWorkflowLog: diagnoseRailwayWorkflowLog,
      },
      nativeBranchDeploy: {
        needsGitHubAppAccess: true,
        githubAppInstallUrl: 'https://github.com/apps/railway-app/installations/new',
        nonNativeSourcePolicy: 'disconnect',
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new RailwayAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['project', 'environment', 'database', 'cache', 'storage'],
    defaultResource: 'project',
    selectors: {
      project: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, collectionKey: 'projects' },
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true },
      database: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId', 'environmentId'] },
      cache: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId', 'environmentId'] },
      storage: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId'] },
    },
    inspect: (adapter, request) => inspectRailwayResources(adapter as RailwayAdapter, request),
  },
  adoption: { project: true },
  databaseRuntime: {
    project: projectRailwayDatabaseRuntime,
  },
  derivedAdapters: {
    database: async (adapter, context) => {
      const [{ createRailwayDatabaseAdapter }, { EnvironmentRepository }] = await Promise.all([
        import('./railway-database.factory.js'),
        import('../../db/repositories/environment.repository.js'),
      ]);
      return createRailwayDatabaseAdapter({
        hostingAdapter: adapter as IProviderAdapter,
        envRepo: new EnvironmentRepository(),
        project: context.project,
      });
    },
    cache: async (adapter, context) => {
      const [{ createRailwayCacheAdapter }, { EnvironmentRepository }] = await Promise.all([
        import('./railway-cache.factory.js'),
        import('../../db/repositories/environment.repository.js'),
      ]);
      return createRailwayCacheAdapter({
        hostingAdapter: adapter as IProviderAdapter,
        envRepo: new EnvironmentRepository(),
        project: context.project,
      });
    },
    storage: async (adapter) => {
      const { createRailwayStorageAdapter } = await import('./railway-storage.factory.js');
      return createRailwayStorageAdapter(adapter as RailwayAdapter);
    },
  },
});
