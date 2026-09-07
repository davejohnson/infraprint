import { z, type ZodRawShape } from 'zod';
import './providers.js';
import type { CommandContext } from './context.js';
import {
  commandError,
  commandErrorFromUnknown,
  redactCommandEnvelope,
  type CommandEnvelope,
} from './results.js';
import { registerCoreTools } from '../tools/core.tools.js';
import { registerLifecycleTools } from '../tools/lifecycle.tools.js';
import { registerConnectionsTools } from '../tools/connections.tools.js';
import { registerHvDeployTools } from '../tools/hv-deploy.tools.js';
import { registerHvObservabilityTools } from '../tools/hv-observability.tools.js';
import { registerHvDbTools } from '../tools/hv-db.tools.js';
import { registerHvSecretsTools } from '../tools/hv-secrets.tools.js';
import { registerHvCiTools } from '../tools/hv-ci.tools.js';
import { registerHvAppstoreTools } from '../tools/hv-appstore.tools.js';
import { registerHvDevxTools } from '../tools/hv-devx.tools.js';
import { registerHvCloudTools } from '../tools/hv-cloud.tools.js';

export type CommandAccess = 'read' | 'write';

export interface CommandDefinition {
  /** Stable command identity. MCP exposes this value unchanged. */
  id: string;
  /** Human-oriented CLI path, for example ["spec"]. */
  cliPath: string[];
  description: string;
  inputShape: ZodRawShape;
  inputSchema: z.ZodObject<ZodRawShape>;
  access: CommandAccess;
  execute(input: Record<string, unknown>): Promise<CommandEnvelope>;
}

function confirmationFieldForCommand(
  id: string,
  inputShape: ZodRawShape
): string | undefined {
  if (id === 'hv_spec' && inputShape.confirmNativeDeploy) {
    return 'confirmNativeDeploy';
  }
  if (id === 'hv_db_query' && inputShape.allowMutations) {
    return 'allowMutations';
  }
  if (inputShape.confirm) {
    return 'confirm';
  }
  return undefined;
}

function addConfirmationMetadata(
  id: string,
  inputShape: ZodRawShape,
  result: CommandEnvelope
): CommandEnvelope {
  if (result.ok || result.error?.code !== 'CONFIRM_REQUIRED' || result.confirmation) {
    return result;
  }
  const field = confirmationFieldForCommand(id, inputShape);
  if (!field) {
    return result;
  }
  return {
    ...result,
    confirmation: {
      message: result.error.message,
      retryInput: { [field]: true },
    },
  };
}

export interface CommandRegistrar {
  register<Args extends ZodRawShape>(
    name: string,
    description: string,
    inputShape: Args,
    handler: (
      args: z.infer<z.ZodObject<Args>>
    ) => Promise<CommandEnvelope> | CommandEnvelope
  ): unknown;
}

const READ_ONLY_COMMANDS = new Set([
  'hv_status',
  'hv_inspect',
  'hv_logs',
  'hv_health',
  'hv_ci_status',
  'hv_appstore_status',
  'hv_runs',
  'hv_secrets',
]);

const ROOT_COMMANDS = new Set([
  'apply',
  'deploy',
  'destroy',
  'health',
  'import',
  'inspect',
  'logs',
  'plan',
  'rollback',
  'runs',
  'status',
]);

export function cliPathForCommand(id: string): string[] {
  const segments = id.replace(/^hv_/, '').split('_');
  return segments.length === 1 || ROOT_COMMANDS.has(segments.join('_'))
    ? [segments.join('-')]
    : segments;
}

export class CommandRegistry implements CommandRegistrar {
  private readonly definitions = new Map<string, CommandDefinition>();

  register<Args extends ZodRawShape>(
    name: string,
    description: string,
    inputShape: Args,
    handler: (
      args: z.infer<z.ZodObject<Args>>
    ) => Promise<CommandEnvelope> | CommandEnvelope
  ): void {
    if (this.definitions.has(name)) {
      throw new Error(`Duplicate Hypervibe command: ${name}`);
    }

    // Command inputs are contracts, not bags of best-effort options. Zod
    // objects strip unknown keys by default, which made misspelled JSON/MCP
    // arguments disappear before a handler could report them. Keep the
    // canonical application boundary strict so every adapter rejects typos.
    const inputSchema = z.object(inputShape).strict();
    this.definitions.set(name, {
      id: name,
      cliPath: cliPathForCommand(name),
      description,
      inputShape,
      inputSchema,
      // Anything not proven read-only is classified as write so future
      // interfaces cannot accidentally grant mutation through a loose policy.
      access: READ_ONLY_COMMANDS.has(name) ? 'read' : 'write',
      execute: async (input) => addConfirmationMetadata(
        name,
        inputShape,
        redactCommandEnvelope(await handler(input as z.infer<z.ZodObject<Args>>))
      ),
    });
  }

  list(): CommandDefinition[] {
    return Array.from(this.definitions.values());
  }

  get(id: string): CommandDefinition | undefined {
    return this.definitions.get(id);
  }

  findByCliPath(path: string[]): CommandDefinition | undefined {
    return this.list().find((definition) => (
      definition.cliPath.length === path.length
      && definition.cliPath.every((segment, index) => segment === path[index])
    ));
  }

  async execute(id: string, input: unknown): Promise<CommandEnvelope> {
    const definition = this.get(id);
    if (!definition) {
      return commandError('NOT_FOUND', `Unknown Hypervibe command "${id}".`);
    }

    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      return commandError('VALIDATION', `Invalid input for ${id}.`, {
        details: parsed.error.flatten(),
        hint: `Run "hypervibe ${definition.cliPath.join(' ')} --help" to inspect its input fields.`,
      });
    }

    try {
      return await definition.execute(parsed.data);
    } catch (error) {
      return commandErrorFromUnknown(error);
    }
  }
}

export function createCommandRegistry(ctx: CommandContext): CommandRegistry {
  const registry = new CommandRegistry();

  registerCoreTools(registry, ctx);
  registerLifecycleTools(registry, ctx);
  registerConnectionsTools(registry, ctx);
  registerHvDeployTools(registry, ctx);
  registerHvObservabilityTools(registry, ctx);
  registerHvDbTools(registry, ctx);
  registerHvSecretsTools(registry, ctx);
  registerHvCiTools(registry, ctx);
  registerHvAppstoreTools(registry, ctx);
  registerHvDevxTools(registry, ctx);
  registerHvCloudTools(registry, ctx);

  return registry;
}
