import { readFileSync } from 'node:fs';
import type { ZodTypeAny } from 'zod';
import type { CommandDefinition, CommandRegistry } from '../../application/commands.js';

export interface ParsedCliInvocation {
  command?: CommandDefinition;
  input: Record<string, unknown>;
  json: boolean;
  nonInteractive: boolean;
  help: boolean;
  version: boolean;
}

const SENSITIVE_LITERAL_FIELDS = new Set([
  'adminAccessToken',
  'adminCredentialsJson',
  'connectionUrl',
  'credentials',
  'envVars',
  'params',
  'sourceConnectionUrl',
  'targetConnectionUrl',
  'value',
  'vars',
]);

function camelCaseFlag(flag: string): string {
  return flag.replace(/-([a-z0-9])/g, (_, value: string) => value.toUpperCase());
}

function kebabCaseField(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function schemaAccepts(schema: ZodTypeAny, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function coerceScalar(schema: ZodTypeAny, raw: string): unknown {
  if (schemaAccepts(schema, raw)) {
    return raw;
  }

  const candidates: unknown[] = [];
  if (raw === 'true') candidates.push(true);
  if (raw === 'false') candidates.push(false);
  if (/^-?(?:\d+|\d*\.\d+)$/.test(raw)) candidates.push(Number(raw));
  if (/^[{[]/.test(raw)) {
    try {
      candidates.push(JSON.parse(raw));
    } catch {
      // The command schema will report the useful validation error.
    }
  }

  return candidates.find((candidate) => schemaAccepts(schema, candidate)) ?? raw;
}

function coerceValues(schema: ZodTypeAny, values: Array<string | boolean>): unknown {
  if (values.length === 1 && typeof values[0] === 'boolean') {
    return values[0];
  }

  const stringValues = values.map(String);
  if (schemaAccepts(schema, stringValues)) {
    return stringValues;
  }
  if (stringValues.length === 1) {
    const scalar = coerceScalar(schema, stringValues[0]);
    if (schemaAccepts(schema, scalar)) {
      return scalar;
    }
    const asArray = [scalar];
    if (schemaAccepts(schema, asArray)) {
      return asArray;
    }
  }

  const coerced = stringValues.map((value) => coerceScalar(schema, value));
  return schemaAccepts(schema, coerced) ? coerced : stringValues;
}

function findCommand(
  registry: CommandRegistry,
  argv: string[]
): { command?: CommandDefinition; consumed: number } {
  const candidates = registry.list().sort((a, b) => b.cliPath.length - a.cliPath.length);
  const command = candidates.find((candidate) => (
    candidate.cliPath.every((segment, index) => argv[index] === segment)
  ));
  return command ? { command, consumed: command.cliPath.length } : { consumed: 0 };
}

export async function parseCliInvocation(
  registry: CommandRegistry,
  argv: string[],
  readStdin: () => Promise<string>
): Promise<ParsedCliInvocation> {
  const { command, consumed } = findCommand(registry, argv);
  const remaining = argv.slice(consumed);
  let json = false;
  let nonInteractive = false;
  let help = false;
  let version = false;
  let inputSource: string | undefined;
  let specFile: string | undefined;
  const rawFlags = new Map<string, Array<string | boolean>>();

  for (let index = 0; index < remaining.length; index += 1) {
    const token = remaining[index];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--non-interactive') {
      nonInteractive = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--version' || token === '-V') {
      version = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error('Unexpected positional argument. Use named --flags or --input.');
    }

    const equals = token.indexOf('=');
    let flag = token.slice(2, equals >= 0 ? equals : undefined);
    let value: string | boolean | undefined = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (flag.startsWith('no-')) {
      flag = flag.slice(3);
      value = false;
    }

    if (value === undefined) {
      const next = remaining[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }

    if (flag === 'input') {
      if (typeof value !== 'string') throw new Error('--input requires a file path or "-".');
      inputSource = value;
      continue;
    }
    if (flag === 'file' && command?.id === 'hv_spec') {
      if (typeof value !== 'string') throw new Error('--file requires a desired-state JSON path.');
      specFile = value;
      continue;
    }

    const field = flag === 'confirm-action' ? 'confirmActions' : camelCaseFlag(flag);
    const existing = rawFlags.get(field) ?? [];
    existing.push(value);
    rawFlags.set(field, existing);
  }

  if (!command) {
    return {
      input: {},
      json,
      nonInteractive,
      help,
      version,
    };
  }

  let input: Record<string, unknown> = {};
  if (inputSource) {
    const raw = inputSource === '-'
      ? await readStdin()
      : readFileSync(inputSource, 'utf8');
    input = parseJsonObject(raw, inputSource === '-' ? 'stdin' : inputSource);
  }
  if (specFile) {
    input.spec = parseJsonObject(readFileSync(specFile, 'utf8'), specFile);
  }

  for (const [field, values] of rawFlags) {
    const fieldSchema = command.inputShape[field];
    if (!fieldSchema) {
      throw new Error(`Unknown option for ${command.cliPath.join(' ')}. Run the command with --help.`);
    }
    if (SENSITIVE_LITERAL_FIELDS.has(field)) {
      throw new Error(
        `--${kebabCaseField(field)} is intentionally unavailable because literal secrets can leak through shell history. Use a safe reference or --input - instead.`
      );
    }
    if (values.some((value) => typeof value === 'boolean') && !schemaAccepts(fieldSchema, true)) {
      throw new Error(`--${kebabCaseField(field)} requires a value.`);
    }
    input[field] = coerceValues(fieldSchema, values);
  }

  return { command, input, json, nonInteractive, help, version };
}

function optionValue(schema: ZodTypeAny): string {
  if (schemaAccepts(schema, true) && schemaAccepts(schema, false)) {
    return '';
  }
  if (schemaAccepts(schema, ['value'])) {
    return ' <value...>';
  }
  return ' <value>';
}

export function commandHelp(command: CommandDefinition): string {
  const lines = [
    `Usage: hypervibe ${command.cliPath.join(' ')} [options]`,
    '',
    command.description,
    '',
    'Options:',
  ];
  for (const [field, schema] of Object.entries(command.inputShape)) {
    if (SENSITIVE_LITERAL_FIELDS.has(field)) continue;
    const flag = field === 'confirmActions' ? 'confirm-action' : kebabCaseField(field);
    const description = schema.description ? `  ${schema.description}` : '';
    lines.push(`  --${flag}${optionValue(schema)}${description}`);
  }
  if (command.id === 'hv_spec') {
    lines.push('  --file <path>  Read the desired-state spec from a JSON file.');
  }
  lines.push(
    '  --input <path|->  Read the complete command input object from JSON.',
    '  --json            Print the redacted command envelope as JSON.',
    '  --non-interactive Never prompt for confirmation.',
    '  -h, --help        Show command help.'
  );
  return `${lines.join('\n')}\n`;
}

export function rootHelp(registry: CommandRegistry): string {
  const lines = [
    'Usage: hypervibe <command> [options]',
    '',
    'Desired-state infrastructure orchestration through the same command core as Hypervibe MCP.',
    '',
    'Commands:',
  ];
  for (const command of registry.list().sort((a, b) => a.cliPath.join(' ').localeCompare(b.cliPath.join(' ')))) {
    const summary = command.description.split('\n')[0];
    const compact = summary.length > 96 ? `${summary.slice(0, 93).trimEnd()}...` : summary;
    lines.push(`  ${command.cliPath.join(' ').padEnd(28)} ${compact}`);
  }
  lines.push(
    '',
    'Run "hypervibe <command> --help" for command options.',
    'Run "hypervibe mcp" to launch the MCP stdio server explicitly.'
  );
  return `${lines.join('\n')}\n`;
}
