import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type {
  CommandDefinition,
  CommandRegistrar,
} from '../../application/commands.js';
import { CommandRegistry } from '../../application/commands.js';
import type { CommandEnvelope } from '../../application/results.js';
import { formatCommandResult } from '../../application/presentation.js';
import { fileURLToPath } from 'node:url';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function toMcpToolResponse(
  envelope: CommandEnvelope,
  commandId = 'unknown'
): McpToolResponse {
  return {
    content: [{ type: 'text', text: formatCommandResult(commandId, envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(envelope.ok ? {} : { isError: true }),
  };
}

function registerDefinition(
  server: McpServer,
  registry: CommandRegistry,
  definition: CommandDefinition
): void {
  server.registerTool(
    definition.id,
    {
      description: definition.description,
      // The SDK validates before invoking our callback. Preserve unknown keys
      // at that transport boundary so the canonical strict command runner can
      // return the same structured VALIDATION envelope as the CLI instead of
      // silently stripping a misspelled option.
      inputSchema: definition.inputSchema.passthrough(),
      annotations: {
        readOnlyHint: definition.access === 'read',
      },
    },
    async (args) => {
      const capabilities = server.server.getClientCapabilities();
      let workspaceDirectories: string[] | undefined;
      if (capabilities?.roots) {
        try {
          const { roots } = await server.server.listRoots();
          workspaceDirectories = roots.flatMap((root) => {
            try {
              const url = new URL(root.uri);
              return url.protocol === 'file:' ? [fileURLToPath(url)] : [];
            } catch {
              return [];
            }
          });
        } catch {
          workspaceDirectories = [];
        }
      }
      const execute = () => registry.execute(definition.id, args);
      const envelope = workspaceDirectories === undefined
        ? await execute()
        : await runWithWorkspaceDirectories(workspaceDirectories, execute);
      return toMcpToolResponse(envelope, definition.id);
    }
  );
}

export function registerCommandRegistry(
  server: McpServer,
  registry: CommandRegistry
): void {
  for (const definition of registry.list()) {
    registerDefinition(server, registry, definition);
  }
}

/**
 * Compatibility adapter for focused tests that register one command group.
 * Production server construction uses registerCommandRegistry instead.
 */
export function createMcpCommandRegistrar(server: McpServer): CommandRegistrar {
  return {
    register<Args extends ZodRawShape>(
      name: string,
      description: string,
      inputShape: Args,
      handler: (
        args: z.infer<z.ZodObject<Args>>
      ) => Promise<CommandEnvelope> | CommandEnvelope
    ): void {
      const registry = new CommandRegistry();
      registry.register(name, description, inputShape, handler);
      registerDefinition(server, registry, registry.get(name)!);
    },
  };
}
