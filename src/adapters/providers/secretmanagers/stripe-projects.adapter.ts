import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  type ISecretManagerAdapter,
  type ResolvedSecret,
  type SecretListItem,
  type SecretManagerVerifyResult,
  StripeProjectsCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';
import { parseEnvFile } from '../../../utils/env-parser.js';
import { primaryWorkspaceDirectory } from '../../../lib/workspace-context.js';

const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_OUTPUT_FILE_BYTES = 1024 * 1024;
const REFERENCE_FORMAT = 'stripe-projects://<environment>/<provider>/<service>';
const SAFE_REFERENCE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface StripeProjectsEnvelope {
  ok: boolean;
  data?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export interface StripeProjectsCliResult {
  exitCode: number;
  stdout: string;
  errorCode?: string;
}

export interface StripeProjectsCliRunner {
  run(args: string[], cwd: string): Promise<StripeProjectsCliResult>;
}

export interface StripeProjectsAdapterOptions {
  cwd?: string;
  runner?: StripeProjectsCliRunner;
}

interface EnvironmentSelection {
  environment: string;
  provider: string;
  service: string;
}

interface EnvironmentMetadata {
  name: string;
  output: string;
  active: boolean;
}

function defaultCliRunner(): StripeProjectsCliRunner {
  return {
    run(args, cwd) {
      return new Promise((resolve) => {
        execFile(
          'stripe',
          args,
          {
            cwd,
            encoding: 'utf8',
            maxBuffer: CLI_MAX_BUFFER_BYTES,
            timeout: CLI_TIMEOUT_MS,
          },
          (error, stdout) => {
            const processError = error as NodeJS.ErrnoException & { code?: string | number } | null;
            resolve({
              exitCode: typeof processError?.code === 'number' ? processError.code : error ? 1 : 0,
              stdout: stdout ?? '',
              ...(typeof processError?.code === 'string' ? { errorCode: processError.code } : {}),
            });
          }
        );
      });
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCliError(error: StripeProjectsEnvelope['error']): string {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode) ? rawCode : 'COMMAND_FAILED';
  return `Stripe Projects command failed (${code}). Run the same Stripe Projects command directly for details.`;
}

function decodeReferencePart(raw: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new Error(`Invalid Stripe Projects credential reference. Expected ${REFERENCE_FORMAT}.`);
  }
  if (!SAFE_REFERENCE_PART.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid Stripe Projects credential reference. Expected ${REFERENCE_FORMAT}.`);
  }
  return value;
}

function parseReferencePath(referencePath: string): EnvironmentSelection {
  const parts = referencePath.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid Stripe Projects credential reference. Expected ${REFERENCE_FORMAT}.`);
  }
  const [environment, provider, service] = parts.map(decodeReferencePart);
  return { environment, provider, service };
}

function findStripeProjectRoot(startDirectory: string): string {
  let current = fs.realpathSync(startDirectory);
  while (true) {
    const projectsDirectory = path.join(current, '.projects');
    try {
      const metadata = fs.lstatSync(projectsDirectory);
      if (metadata.isSymbolicLink()) {
        throw new Error('Stripe Projects .projects directory must not be a symbolic link.');
      }
      if (metadata.isDirectory()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('No Stripe Projects project found. Run `stripe projects init` in this repository first.');
    }
    current = parent;
  }
}

function containedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireSafeOutputFile(projectRoot: string, output: string): string {
  const candidate = path.resolve(projectRoot, output);
  if (!containedPath(projectRoot, candidate)) {
    throw new Error('Stripe Projects environment output must stay inside the project root.');
  }

  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Stripe Projects environment output is missing. Run \`stripe projects env --pull\` explicitly, then retry.`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Stripe Projects environment output must be a regular, non-symbolic-link file.');
  }
  if (metadata.size > MAX_OUTPUT_FILE_BYTES) {
    throw new Error('Stripe Projects environment output is unexpectedly large.');
  }

  const realCandidate = fs.realpathSync(candidate);
  if (!containedPath(projectRoot, realCandidate)) {
    throw new Error('Stripe Projects environment output must stay inside the project root.');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Stripe Projects environment output must be owner-only (chmod 600).');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('Stripe Projects environment output must be owned by the current user.');
  }
  return realCandidate;
}

export class StripeProjectsAdapter implements ISecretManagerAdapter {
  readonly name = 'stripe-projects' as const;

  private readonly cwd: string;
  private readonly runner: StripeProjectsCliRunner;
  private connected = false;

  constructor(options: StripeProjectsAdapterOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? primaryWorkspaceDirectory());
    this.runner = options.runner ?? defaultCliRunner();
  }

  async connect(credentials: unknown): Promise<void> {
    const parsed = StripeProjectsCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      throw new Error(`Invalid Stripe Projects credentials: ${parsed.error.message}`);
    }
    this.connected = true;
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      this.requireConnected();
      const environment = await this.getActiveEnvironment();
      const projectRoot = findStripeProjectRoot(this.cwd);
      requireSafeOutputFile(projectRoot, environment.output);
      return {
        success: true,
        identity: `Stripe Projects environment ${environment.name}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(referencePath: string, key?: string, version?: string): Promise<ResolvedSecret> {
    this.requireConnected();
    if (version !== undefined) {
      throw new Error('Stripe Projects credential references do not support versions.');
    }

    const selection = parseReferencePath(referencePath);
    const { keys, output } = await this.resolveSelection(selection);
    if (key && !keys.includes(key)) {
      throw new Error(`Stripe Projects service ${selection.provider}/${selection.service} does not expose requested field "${key}".`);
    }

    const projectRoot = findStripeProjectRoot(this.cwd);
    const values = parseEnvFile(requireSafeOutputFile(projectRoot, output));
    const selected: Record<string, string> = {};
    const missing: string[] = [];
    for (const envKey of key ? [key] : keys) {
      if (typeof values[envKey] !== 'string' || values[envKey].length === 0) {
        missing.push(envKey);
      } else {
        selected[envKey] = values[envKey];
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Stripe Projects local output is missing ${missing.join(', ')}. `
        + `Run \`stripe projects env use ${selection.environment}\` and \`stripe projects env --pull\` explicitly, then retry.`
      );
    }

    return { value: key ? selected[key] : JSON.stringify(selected) };
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    this.requireConnected();
    if (!pathPrefix) {
      throw new Error(`Stripe Projects listing requires a full path: ${REFERENCE_FORMAT}.`);
    }
    const selection = parseReferencePath(pathPrefix);
    const { keys } = await this.resolveSelection(selection);
    return [{ path: pathPrefix, keys }];
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error('Not connected. Call connect() first.');
  }

  private async runJson(args: string[]): Promise<Record<string, unknown>> {
    const result = await this.runner.run([...args, '--json', '--non-interactive'], this.cwd);
    if (result.errorCode === 'ENOENT') {
      throw new Error('Stripe CLI is not installed. Install it, then install the official Projects plugin with `stripe plugin install projects`.');
    }

    let envelope: StripeProjectsEnvelope | null = null;
    try {
      envelope = JSON.parse(result.stdout.trim()) as StripeProjectsEnvelope;
    } catch {
      // Never include raw CLI output: even unexpected output must respect the secret boundary.
    }
    if (!envelope || typeof envelope.ok !== 'boolean') {
      throw new Error(result.exitCode === 0
        ? 'Stripe Projects returned an invalid JSON response.'
        : 'Stripe Projects command failed without a valid JSON response.');
    }
    if (!envelope.ok) throw new Error(safeCliError(envelope.error));
    const data = record(envelope.data);
    if (!data) throw new Error('Stripe Projects returned invalid response data.');
    return data;
  }

  private async getActiveEnvironment(): Promise<EnvironmentMetadata> {
    const data = await this.runJson(['projects', 'env', 'show']);
    if (
      typeof data.name !== 'string'
      || !SAFE_REFERENCE_PART.test(data.name)
      || typeof data.output !== 'string'
      || data.active !== true
    ) {
      throw new Error('Stripe Projects returned invalid active-environment metadata.');
    }
    return { name: data.name, output: data.output, active: true };
  }

  private async resolveSelection(selection: EnvironmentSelection): Promise<{ keys: string[]; output: string }> {
    const environment = await this.getActiveEnvironment();
    if (environment.name !== selection.environment) {
      throw new Error(
        `Stripe Projects environment "${selection.environment}" is not active (active: "${environment.name}"). `
        + `Run \`stripe projects env use ${selection.environment}\` and \`stripe projects env --pull\` explicitly, then retry.`
      );
    }

    const data = await this.runJson([
      'projects',
      'env',
      '--service',
      `${selection.provider}/${selection.service}`,
    ]);
    const configurations = Array.isArray(data.resource_access_configurations)
      ? data.resource_access_configurations.map(record).filter((value): value is Record<string, unknown> => value !== null)
      : [];
    if (configurations.length === 0) {
      throw new Error(`Stripe Projects service ${selection.provider}/${selection.service} has no locally cached credentials in the active environment.`);
    }
    if (configurations.length > 1) {
      throw new Error(`Stripe Projects service ${selection.provider}/${selection.service} has multiple matching resource configurations; select a unique service before resolving credentials.`);
    }

    const rawKeys = configurations[0].access_configuration_keys;
    if (!Array.isArray(rawKeys) || rawKeys.some((value) => typeof value !== 'string' || !SAFE_ENVIRONMENT_KEY.test(value))) {
      throw new Error('Stripe Projects returned invalid credential-field metadata.');
    }
    const keys = [...new Set(rawKeys)].sort();
    if (keys.length === 0) {
      throw new Error(`Stripe Projects service ${selection.provider}/${selection.service} exposes no credential fields.`);
    }
    return { keys, output: environment.output };
  }
}

secretManagerRegistry.register({
  metadata: {
    name: 'stripe-projects',
    displayName: 'Stripe Projects',
    credentialsSchema: StripeProjectsCredentialsSchema,
    setupHelpUrl: 'https://projects.dev/',
    credentials: {
      supportsNativeCliAuth: true,
    },
  },
  factory: () => new StripeProjectsAdapter(),
});
