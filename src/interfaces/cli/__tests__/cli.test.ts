import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandRegistry } from '../../../application/commands.js';
import { commandError, commandSuccess } from '../../../application/results.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../../adapters/secrets/secret-store.js';
import { runCli } from '../run.js';
import type { CliIo } from '../io.js';

function makeIo(options: { tty?: boolean; confirm?: boolean; stdin?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    writeOut(text) {
      stdout += text;
    },
    writeErr(text) {
      stderr += text;
    },
    async readStdin() {
      return options.stdin ?? '';
    },
    async confirm() {
      return options.confirm ?? false;
    },
    stdinIsTTY: options.tty ?? false,
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(
    'hv_spec',
    'Read a project spec.',
    {
      project: z.string().optional().describe('Project name'),
      includeHistory: z.boolean().optional().describe('Include revision history'),
      tags: z.array(z.string()).optional().describe('Tags to include'),
    },
    async (input) => commandSuccess(input)
  );
  registry.register(
    'hv_destroy',
    'Delete local records.',
    {
      project: z.string(),
      confirm: z.boolean().optional(),
    },
    async (input) => input.confirm
      ? commandSuccess({ deleted: input.project })
      : commandError('CONFIRM_REQUIRED', `Delete ${input.project}?`)
  );
  registry.register(
    'hv_connections',
    'Store a provider connection.',
    {
      provider: z.string(),
      credentials: z.record(z.unknown()).optional(),
      credentialsRef: z.string().optional(),
    },
    async (input) => commandSuccess(input)
  );
  registry.register(
    'hv_health',
    'Return a deliberately unsafe test payload.',
    {},
    async () => ({
      ok: true,
      data: { apiToken: 'ghp_abcdefghijklmnopqrstuvwxyz123456' },
    })
  );
  registry.register(
    'hv_plan',
    'Plan with encrypted environment overrides.',
    { envVars: z.record(z.string()).optional() },
    async (input) => commandSuccess(input)
  );
  registry.register(
    'hv_db_query',
    'Run a parameterized database query.',
    { sql: z.string(), params: z.array(z.unknown()).optional() },
    async (input) => commandSuccess(input)
  );
  return registry;
}

describe('Hypervibe CLI', () => {
  it('routes friendly nested commands and coerces schema-backed flags', async () => {
    const output = makeIo();
    const exitCode = await runCli(
      ['spec', '--project', 'invoice-perfect', '--include-history', '--tags', 'one', '--tags', 'two', '--json'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      ok: true,
      data: {
        project: 'invoice-perfect',
        includeHistory: true,
        tags: ['one', 'two'],
      },
    });
    expect(output.stderr()).toBe('');
  });

  it('reads complete command input from stdin', async () => {
    const output = makeIo({ stdin: '{"project":"stdin-project","includeHistory":true}' });
    const exitCode = await runCli(
      ['spec', '--input', '-', '--json'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout()).data.project).toBe('stdin-project');
  });

  it('rejects unknown fields in complete JSON input instead of silently dropping typos', async () => {
    const output = makeIo({ stdin: '{"project":"stdin-project","incldueHistory":true}' });
    const exitCode = await runCli(
      ['spec', '--input', '-', '--json'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(output.stdout()).toContain('incldueHistory');
  });

  it('uses the same command-aware human presentation as MCP', async () => {
    const output = makeIo();
    const exitCode = await runCli(
      ['spec', '--project', 'invoice-perfect'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain('✅  HYPERVIBE · SPEC READY');
    expect(output.stdout()).not.toMatch(/\u001b\[/);
  });

  it('prompts only on a TTY and retries with the safe confirmation patch', async () => {
    const output = makeIo({ tty: true, confirm: true });
    const exitCode = await runCli(
      ['destroy', '--project', 'old-project'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain('CONFIRM_REQUIRED');
    expect(output.stdout()).toContain('Deleted: old-project');
  });

  it('does not prompt in JSON mode', async () => {
    const output = makeIo({ tty: true, confirm: true });
    const exitCode = await runCli(
      ['destroy', '--project', 'old-project', '--json'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.stdout()).error.code).toBe('CONFIRM_REQUIRED');
  });

  it('rejects literal secret flags and points to safe input paths', async () => {
    const output = makeIo();
    const exitCode = await runCli(
      ['connections', '--provider', 'railway', '--credentials', '{"apiToken":"secret"}'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(2);
    expect(output.stderr()).toContain('literal secrets can leak through shell history');
    expect(output.stderr()).not.toContain('apiToken');
    expect(output.stderr()).not.toContain('{"apiToken":"secret"}');
  });

  it('rejects secret-bearing env overrides and query parameters in shell flags', async () => {
    for (const argv of [
      ['plan', '--env-vars', '{"SESSION_SECRET":"do-not-save"}'],
      ['db', 'query', '--sql', 'SELECT $1', '--params', '["do-not-save"]'],
    ]) {
      const output = makeIo();
      const exitCode = await runCli(argv, {
        registry: makeRegistry(),
        io: output.io,
        initialize: false,
      });

      expect(exitCode).toBe(2);
      expect(output.stderr()).toContain('literal secrets can leak through shell history');
      expect(output.stderr()).not.toContain('do-not-save');
    }
  });

  it('redacts handler results in the command runner before CLI rendering', async () => {
    const output = makeIo();
    const exitCode = await runCli(
      ['health', '--json'],
      { registry: makeRegistry(), io: output.io, initialize: false }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout()).data.apiToken).toBe('[redacted]');
    expect(output.stdout()).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
  });

  it('generates root and command help from the registry', async () => {
    const root = makeIo();
    const rootCode = await runCli(
      ['--help'],
      { registry: makeRegistry(), io: root.io, initialize: false }
    );
    expect(rootCode).toBe(0);
    expect(root.stdout()).toContain('spec');

    const command = makeIo();
    const commandCode = await runCli(
      ['spec', '--help'],
      { registry: makeRegistry(), io: command.io, initialize: false }
    );
    expect(commandCode).toBe(0);
    expect(command.stdout()).toContain('--include-history');
    expect(command.stdout()).toContain('--input <path|->');
  });

  it('does not create local state just to render help', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-cli-help-'));
    const previous = process.env.HYPERVIBE_DATA_DIR;
    SqliteAdapter.resetInstance();
    SecretStore.resetInstance();
    process.env.HYPERVIBE_DATA_DIR = dataDir;
    try {
      const output = makeIo();
      expect(await runCli(['--help'], { io: output.io })).toBe(0);
      expect(existsSync(path.join(dataDir, 'hypervibe.db'))).toBe(false);
      expect(existsSync(path.join(dataDir, '.secret-key'))).toBe(false);
    } finally {
      SqliteAdapter.resetInstance();
      SecretStore.resetInstance();
      if (previous === undefined) delete process.env.HYPERVIBE_DATA_DIR;
      else process.env.HYPERVIBE_DATA_DIR = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
