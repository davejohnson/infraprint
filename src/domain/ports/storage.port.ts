import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { Receipt, VerifyResult } from './provider.port.js';
import type { ObservedStorage } from './observe.port.js';

export interface StorageCapabilities {
  kind: 'object';
  regions: string[];
  privateOnly: boolean;
  supportsUsageObservation: boolean;
  /** Provider can expose a streaming object data plane for migration. */
  supportsObjectTransfer?: boolean;
}

export interface StorageObjectRecord {
  key: string;
  size: number;
}

export interface StorageObjectPayload {
  body: Readable | ReadableStream | Blob;
  size: number;
  contentType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

export interface StorageObjectClient {
  list(): Promise<StorageObjectRecord[]>;
  get(key: string): Promise<StorageObjectPayload>;
  put(key: string, payload: StorageObjectPayload): Promise<void>;
  destroy(): void;
}

/**
 * Opaque, non-secret provider coordinates required to address one storage
 * instance. Adapters own the field names (for example Railway project and
 * environment ids, or a cloud account/project plus region).
 */
export type StorageContext = Record<string, string>;

/**
 * Durable, non-secret evidence that a bucket create may have committed but
 * did not produce a trustworthy normal binding. This marker is a retry
 * blocker and recovery hint only; it is never deletion authority.
 */
export interface StorageCreateRecovery {
  provider: string;
  operation: 'create';
  resourceName: string;
  providerScope: StorageContext;
  state: 'unresolved' | 'identified' | 'mismatched';
  externalId?: string;
  returnedName?: string;
}

const nonEmptyStorageRecoveryString = z.string().trim().min(1);

export const storageCreateRecoverySchema = z.object({
  provider: nonEmptyStorageRecoveryString,
  operation: z.literal('create'),
  resourceName: nonEmptyStorageRecoveryString,
  providerScope: z.record(nonEmptyStorageRecoveryString).refine(
    (scope) => Object.keys(scope).length > 0
      && Object.keys(scope).every((key) => key.trim().length > 0),
    'Storage create recovery requires a non-empty provider scope.'
  ),
  state: z.enum(['unresolved', 'identified', 'mismatched']),
  externalId: nonEmptyStorageRecoveryString.optional(),
  returnedName: nonEmptyStorageRecoveryString.optional(),
}).strict().superRefine((marker, ctx) => {
  if (marker.state === 'unresolved' && marker.externalId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalId'],
      message: 'An unresolved storage create cannot claim a provider id.',
    });
  }
  if (marker.state !== 'unresolved' && !marker.externalId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalId'],
      message: 'An identified or mismatched storage create requires a provider id.',
    });
  }
  if (marker.state === 'identified' && marker.returnedName !== marker.resourceName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['returnedName'],
      message: 'An identified storage create must return the exact requested name.',
    });
  }
  if (marker.state === 'mismatched' && marker.returnedName === marker.resourceName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['returnedName'],
      message: 'A mismatched storage create cannot return the exact requested name.',
    });
  }
});

export function createStorageCreateRecovery(input: {
  provider: string;
  resourceName: string;
  providerScope: StorageContext;
  state: StorageCreateRecovery['state'];
  externalId?: string;
  returnedName?: string;
}): StorageCreateRecovery {
  const providerScope = Object.fromEntries(
    Object.entries(input.providerScope)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return storageCreateRecoverySchema.parse({
    provider: input.provider.trim(),
    operation: 'create',
    resourceName: input.resourceName.trim(),
    providerScope,
    state: input.state,
    ...(input.externalId !== undefined ? { externalId: input.externalId.trim() } : {}),
    ...(input.returnedName !== undefined ? { returnedName: input.returnedName.trim() } : {}),
  });
}

export function parseStorageCreateRecovery(value: unknown): StorageCreateRecovery | null {
  const parsed = storageCreateRecoverySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const storageCreateRecoveryMapSchema = z.record(storageCreateRecoverySchema)
  .superRefine((recoveries, ctx) => {
    for (const [name, recovery] of Object.entries(recoveries)) {
      if (!name.trim() || recovery.resourceName !== name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'A storage create-recovery entry must use its exact resource name as the map key.',
        });
      }
    }
  });

export function parseStorageCreateRecoveryMap(
  value: unknown
): Record<string, StorageCreateRecovery> | null {
  const parsed = storageCreateRecoveryMapSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface StorageCredentials {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  region: string;
  urlStyle: string;
}

export interface StorageEnsureResult {
  receipt: Receipt;
  externalId?: string;
  context?: StorageContext;
}

export interface IStorageAdapter {
  readonly name: string;
  readonly capabilities: StorageCapabilities;
  /** Stable environment-variable names written when a service is wired. */
  runtimeEnvKeys(name: string): string[];
  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;
  /**
   * Verify or resolve storage context from already-converged provider
   * scaffolding. It must never create a project or deploy environment.
   */
  ensureContext(
    projectName: string,
    environment: Environment,
    context?: Partial<StorageContext>,
    desiredRegion?: string
  ): Promise<StorageEnsureResult>;
  /**
   * Resolve provider scope for first-use observation using identity/read APIs
   * only. This method must never create, register, tag, or mutate resources.
   */
  resolveObservationContext?(
    projectName: string,
    environment: Environment,
    desiredRegion: string
  ): Promise<StorageEnsureResult>;
  observe(environment: Environment, context: StorageContext): Promise<ObservedStorage[]>;
  ensureBucket(environment: Environment, context: StorageContext, name: string, region: string): Promise<StorageEnsureResult>;
  /** Resolve provider-native runtime configuration. Secret values never enter receipts or bindings. */
  getRuntimeEnv(environment: Environment, context: StorageContext, externalId: string, name: string): Promise<Record<string, string>>;
  /** S3-compatible data-plane credentials when this provider exposes them. */
  getCredentials?(environment: Environment, context: StorageContext, externalId: string): Promise<StorageCredentials>;
  /**
   * Optional provider-native object stream. Azure/GCP adapters can translate
   * their native APIs here; S3-compatible adapters may rely on credentials.
   */
  openObjectTransfer?(environment: Environment, context: StorageContext, externalId: string): Promise<StorageObjectClient>;
  destroyBucket(environment: Environment, context: StorageContext, externalId: string): Promise<Receipt>;
}

/** Runtime proof for every method required by the production storage contract. */
export function supportsStorageLifecycle(value: unknown): value is IStorageAdapter {
  const adapter = value as Partial<IStorageAdapter> | null;
  return Boolean(
    adapter
    && typeof adapter.connect === 'function'
    && typeof adapter.verify === 'function'
    && typeof adapter.ensureContext === 'function'
    && typeof adapter.observe === 'function'
    && typeof adapter.ensureBucket === 'function'
    && typeof adapter.getRuntimeEnv === 'function'
    && typeof adapter.destroyBucket === 'function'
    && (
      typeof adapter.openObjectTransfer === 'function'
      || typeof adapter.getCredentials === 'function'
    )
  );
}
