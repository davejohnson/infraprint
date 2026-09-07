import { z } from 'zod';
import { hostingBindingsSchema } from '../../domain/ports/hosting.port.js';

/**
 * Zod schemas for JSON TEXT columns, used with parseJsonColumn so reads are
 * validated instead of blind `JSON.parse` + type assertions.
 *
 * All schemas are passthrough (to preserve provider-owned extension fields)
 * and carry defaults only for genuinely empty legacy columns. Non-empty
 * corrupt or schema-invalid state is rejected by parseJsonColumn.
 */

/** projects.policies — free-form policy map (includes legacy desiredState). */
export const policiesColumnSchema = z.record(z.unknown()).default({});

/** environments.platform_bindings — provider bindings (see HostingBindings). */
export const platformBindingsColumnSchema = hostingBindingsSchema;

/** services.build_config */
export const buildConfigColumnSchema = z
  .object({
    workloadKind: z.enum(['web', 'worker', 'cron']).optional(),
    builder: z.enum(['nixpacks', 'dockerfile', 'buildpack']).optional(),
    dockerfilePath: z.string().optional(),
    buildCommand: z.string().optional(),
    watchPaths: z.array(z.string()).optional(),
    startCommand: z.string().optional(),
    releaseCommand: z.string().optional(),
    healthCheckPath: z.string().optional(),
    cronSchedule: z.string().optional(),
    public: z.boolean().optional(),
    runtime: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('node'),
        version: z.string(),
        installCommand: z.string().optional(),
        buildCommand: z.string().optional(),
      }),
      z.object({
        kind: z.literal('python'),
        version: z.string(),
        installCommand: z.string().optional(),
        buildCommand: z.string().optional(),
      }),
    ]).optional(),
  })
  .passthrough()
  .default({});

/** services.env_var_spec */
export const envVarSpecColumnSchema = z
  .object({
    required: z.array(z.string()).optional(),
    optional: z.array(z.string()).optional(),
    secrets: z.array(z.string()).optional(),
  })
  .passthrough()
  .default({});

/** components.bindings */
export const componentBindingsColumnSchema = z
  .object({
    connectionString: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
  })
  .passthrough()
  .default({});

/** runs.plan */
export const runPlanColumnSchema = z.record(z.unknown()).default({});

/** runs.receipts */
export const runReceiptsColumnSchema = z.array(z.unknown()).default([]);
