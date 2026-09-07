import type { Project } from '../entities/project.entity.js';

export type CloudPrepareProvider = 'cloudrun';

export interface CloudPrepareProfile {
  provider: CloudPrepareProvider;
  version: string;
  label: string;
  requiredApis: string[];
  requiredRoles: string[];
}

export interface CloudPreparationRecord {
  provider: CloudPrepareProvider;
  version: string;
  preparedAt: string;
  gcpProjectId?: string;
  deployServiceAccountEmail?: string;
  requiredApis: string[];
  requiredRoles: string[];
}

export const CLOUD_PREPARE_PROFILES: Record<CloudPrepareProvider, CloudPrepareProfile> = {
  cloudrun: {
    provider: 'cloudrun',
    version: 'gcp-cloudrun-v1',
    label: 'GCP Cloud Run + Cloud SQL',
    requiredApis: [
      'serviceusage.googleapis.com',
      'cloudresourcemanager.googleapis.com',
      'run.googleapis.com',
      'sqladmin.googleapis.com',
      'cloudbuild.googleapis.com',
      'artifactregistry.googleapis.com',
      'secretmanager.googleapis.com',
      'logging.googleapis.com',
      'cloudscheduler.googleapis.com',
    ],
    requiredRoles: [
      'roles/run.admin',
      'roles/run.invoker',
      'roles/iam.serviceAccountUser',
      'roles/cloudbuild.builds.editor',
      'roles/artifactregistry.admin',
      'roles/cloudsql.admin',
      'roles/cloudsql.client',
      'roles/secretmanager.admin',
      'roles/serviceusage.serviceUsageAdmin',
      'roles/cloudscheduler.admin',
      'roles/logging.viewer',
      'roles/logging.viewAccessor',
    ],
  },
};

export function getCloudPrepareProfile(provider: string): CloudPrepareProfile | null {
  return provider === 'cloudrun' ? CLOUD_PREPARE_PROFILES.cloudrun : null;
}

export function getCloudPreparation(
  project: Pick<Project, 'policies'>,
  provider: CloudPrepareProvider
): CloudPreparationRecord | null {
  const root = asRecord(project.policies.cloudPreparation);
  const record = asRecord(root?.[provider]);
  if (!record) return null;

  const requiredApis = asStringArray(record.requiredApis);
  const requiredRoles = asStringArray(record.requiredRoles);
  const preparedAt = typeof record.preparedAt === 'string' ? record.preparedAt : undefined;
  const version = typeof record.version === 'string' ? record.version : undefined;
  if (!preparedAt || !version) return null;

  return {
    provider,
    version,
    preparedAt,
    gcpProjectId: typeof record.gcpProjectId === 'string' ? record.gcpProjectId : undefined,
    deployServiceAccountEmail: typeof record.deployServiceAccountEmail === 'string' ? record.deployServiceAccountEmail : undefined,
    requiredApis,
    requiredRoles,
  };
}

export function isCloudPrepared(
  project: Pick<Project, 'policies'> | null | undefined,
  provider: string
): boolean {
  if (!project) return false;
  const profile = getCloudPrepareProfile(provider);
  if (!profile) return true;
  const record = getCloudPreparation(project, profile.provider);
  if (!record || record.version !== profile.version) return false;

  return (
    profile.requiredApis.every((api) => record.requiredApis.includes(api))
    && profile.requiredRoles.every((role) => record.requiredRoles.includes(role))
  );
}

/**
 * Extra APIs/roles queues need on GCP. Kept out of the base profile so
 * existing prepared projects are not forced to re-run prepare: deploys
 * keep working; only queue actions require the addon (with a clear
 * re-run-prepare hint). Queue access is added only when the caller explicitly
 * selects queueAccess="lifecycle".
 */
export const QUEUE_PREPARE_ADDON = {
  requiredApis: ['pubsub.googleapis.com'],
  requiredRoles: ['roles/pubsub.editor'],
} as const;

export type QueuePrepareAccess = 'lifecycle' | 'remove';

export const GCS_PREPARE_ADDONS = {
  inspect: {
    requiredApis: ['storage.googleapis.com'],
    requiredRoles: ['roles/storage.viewer'],
  },
  lifecycle: {
    requiredApis: ['storage.googleapis.com'],
    requiredRoles: ['roles/storage.admin'],
  },
} as const;

export type GcsPrepareAccess = keyof typeof GCS_PREPARE_ADDONS;

export const MEMORYSTORE_PREPARE_ADDONS = {
  inspect: {
    requiredApis: ['compute.googleapis.com', 'redis.googleapis.com'],
    requiredRoles: ['roles/compute.networkViewer', 'roles/redis.viewer'],
  },
  lifecycle: {
    requiredApis: ['compute.googleapis.com', 'redis.googleapis.com'],
    requiredRoles: ['roles/compute.networkUser', 'roles/compute.networkViewer', 'roles/redis.admin'],
  },
} as const;

export type MemorystorePrepareAccess = keyof typeof MEMORYSTORE_PREPARE_ADDONS;

export function isCloudPreparedForQueues(
  project: Pick<Project, 'policies'> | null | undefined,
  provider: string
): boolean {
  if (!isCloudPrepared(project, provider)) return false;
  const profile = getCloudPrepareProfile(provider);
  if (!profile || !project) return true;
  const record = getCloudPreparation(project, profile.provider);
  if (!record) return false;
  return (
    QUEUE_PREPARE_ADDON.requiredApis.every((api) => record.requiredApis.includes(api))
    && QUEUE_PREPARE_ADDON.requiredRoles.every((role) => record.requiredRoles.includes(role))
  );
}

export function withCloudPreparationRecord(
  policies: Record<string, unknown>,
  provider: CloudPrepareProvider,
  record: CloudPreparationRecord
): Record<string, unknown> {
  const cloudPreparation = {
    ...asRecord(policies.cloudPreparation),
    [provider]: record,
  };
  return {
    ...policies,
    cloudPreparation,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
