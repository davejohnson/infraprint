import { initializeDatabase } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry, type CommandRegistry } from '../../application/commands.js';
import type { CommandEnvelope } from '../../application/results.js';
import { formatCommandResult } from '../../application/presentation.js';
import { HYPERVIBE_VERSION } from '../../version.js';
import { createProcessCliIo, type CliIo } from './io.js';
import { commandHelp, parseCliInvocation, rootHelp } from './parser.js';

export interface CliRunOptions {
  io?: CliIo;
  registry?: CommandRegistry;
  initialize?: boolean;
}

function renderResult(commandId: string, result: CommandEnvelope, json: boolean): string {
  return json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatCommandResult(commandId, result)}\n`;
}

export async function runCli(
  argv: string[],
  options: CliRunOptions = {}
): Promise<number> {
  const io = options.io ?? createProcessCliIo();
  const registry = options.registry ?? createCommandRegistry(createCommandContext());

  let invocation;
  try {
    invocation = await parseCliInvocation(registry, argv, io.readStdin);
  } catch (error) {
    io.writeErr(`Hypervibe CLI error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (invocation.version) {
    io.writeOut(`${HYPERVIBE_VERSION}\n`);
    return 0;
  }
  if (!invocation.command) {
    io.writeOut(rootHelp(registry));
    return invocation.help ? 0 : 2;
  }
  if (invocation.help) {
    io.writeOut(commandHelp(invocation.command));
    return 0;
  }

  // Help, version, and parse failures must not create or migrate local state.
  // Initialize only once we know a real command is going to execute.
  if (options.initialize !== false) {
    initializeDatabase();
  }

  let result = await registry.execute(invocation.command.id, invocation.input);
  const canPrompt = (
    !invocation.json
    && !invocation.nonInteractive
    && io.stdinIsTTY
    && !result.ok
    && result.error?.code === 'CONFIRM_REQUIRED'
    && result.confirmation
  );

  if (canPrompt && result.confirmation) {
    io.writeOut(renderResult(invocation.command.id, result, false));
    const confirmed = await io.confirm(result.confirmation.message);
    if (!confirmed) {
      io.writeErr('Confirmation declined; no confirmed action was executed.\n');
      return 1;
    }
    result = await registry.execute(invocation.command.id, {
      ...invocation.input,
      ...result.confirmation.retryInput,
    });
  }

  io.writeOut(renderResult(invocation.command.id, result, invocation.json));
  return result.ok ? 0 : 1;
}
