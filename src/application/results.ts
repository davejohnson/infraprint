/**
 * Transport-neutral result contract for every Hypervibe command.
 *
 * Interface adapters may add protocol-specific wrappers, but they must expose
 * this redacted envelope unchanged.
 */

import { NotSupportedError } from '../domain/errors/not-supported.error.js';

export type ErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS_PROJECT'
  | 'VALIDATION'
  | 'CONFIRM_REQUIRED'
  | 'MISSING_CONNECTION'
  | 'PROVIDER_ERROR'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface CommandEnvelope {
  ok: boolean;
  data?: unknown;
  error?: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  /**
   * Agent-control guidance. Hypervibe tools are often used by autonomous
   * coding agents; this tells them when to stop and ask instead of trying
   * unrelated workaround calls.
   */
  agentInstruction?: {
    action: 'continue' | 'stop_and_report' | 'ask_user';
    message: string;
  };
  /** What the agent should do next to make progress. */
  hint?: string;
  warnings?: string[];
  /** Suggested follow-up tool calls, e.g. ["hv_plan"]. */
  next?: string[];
  /** Safe, machine-readable retry metadata for an interactive interface. */
  confirmation?: {
    message: string;
    retryInput: Record<string, boolean | string[]>;
  };
}

export interface ResponseExtras {
  hint?: string;
  warnings?: string[];
  next?: string[];
  agentInstruction?: CommandEnvelope['agentInstruction'];
}

const REDACTED = '[redacted]';

const SENSITIVE_KEYS = new Set([
  'apikey',
  'apitoken',
  'authorization',
  'authtoken',
  'clientsecret',
  'connectionstring',
  'connectionurl',
  'credentials',
  'credentialsencrypted',
  'databasepassword',
  'databaseurl',
  'dbpassword',
  'directurl',
  'password',
  'passphrase',
  'pgpassword',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'signingsecret',
  'token',
  'webhooksecret',
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  if (normalized.endsWith('token') || normalized.endsWith('secret')) {
    return true;
  }
  if (normalized === 'secretaccesskey') {
    return true;
  }
  if (/^(database|db|pg).*(url|password)$/.test(normalized)) {
    return true;
  }
  if (/^(access|refresh|admin|api|auth).*token$/.test(normalized)) {
    return true;
  }
  return false;
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+:[^@\s/]+)@/gi, `$1${REDACTED}@`)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\bgh[oprsu]_[A-Za-z0-9_]{20,}/g, REDACTED)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\brk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bwhsec_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\bsbp_[A-Za-z0-9_]{16,}/g, REDACTED)
    .replace(/\bsb_secret_[A-Za-z0-9_]{16,}/g, REDACTED)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{16,}/g, REDACTED);
}

function redactForResponse(value: unknown, keyHint?: string, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    if (keyHint && isSensitiveKey(keyHint)) {
      return value === REDACTED || /^\*+$/.test(value) ? value : REDACTED;
    }
    return redactSensitiveString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((entry) => redactForResponse(entry, keyHint, seen));
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) && entry && typeof entry === 'object'
      ? REDACTED
      : redactForResponse(entry, key, seen);
  }
  seen.delete(value);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyArrayField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return Array.isArray(value) && value.length > 0;
}

function hasReceiptStatus(value: unknown, statuses: Set<string>): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!isRecord(entry)) return false;
    const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
    return statuses.has(status);
  });
}

function hasConnectionSetup(data: Record<string, unknown>): boolean {
  const setup = data.connectionSetup;
  return isRecord(setup) || (Array.isArray(setup) && setup.some(isRecord));
}

const CONNECTION_SETUP_AGENT_MESSAGE = 'Stop before any dependent operation. Show the user the exact clickable setup links and required permissions from connectionSetup, recommend its recommendedSetupUrl, and offer to open that page in their browser. Then explain where to save the credential and show the complete credentialExample with /absolute/path replaced by the real local path. Never summarize this as a vague "Hypervibe credential flow" or ask the user to paste a token into chat.';

function successAgentInstruction(data: unknown): CommandEnvelope['agentInstruction'] | undefined {
  if (!isRecord(data)) return undefined;
  if (isNonEmptyArrayField(data, 'blocked') || isNonEmptyArrayField(data, 'actionScopedBlocked')) {
    if (hasConnectionSetup(data)) {
      return {
        action: 'ask_user',
        message: CONNECTION_SETUP_AGENT_MESSAGE,
      };
    }
    return {
      action: 'ask_user',
      message: 'Stop here. Summarize the blockers and ask the user to provide the missing connection, confirmation, or direction before running more apply/deploy tools.',
    };
  }
  if (data.applied === false || data.success === false || hasReceiptStatus(data.receipts, new Set(['failed', 'blocked', 'pending', 'aborted']))) {
    return {
      action: 'stop_and_report',
      message: 'Stop here. Report which stage receipts succeeded, failed, were blocked, or are pending; ask the user before retrying or trying a different path.',
    };
  }
  return undefined;
}

function errorAgentInstruction(code: ErrorCode, details?: unknown): CommandEnvelope['agentInstruction'] {
  if (isRecord(details) && hasConnectionSetup(details)) {
    return {
      action: 'ask_user',
      message: CONNECTION_SETUP_AGENT_MESSAGE,
    };
  }
  if (code === 'CONFIRM_REQUIRED') {
    return {
      action: 'ask_user',
      message: 'Stop here. Report the confirmation requirement and ask the user before rerunning with confirm=true or confirmActions.',
    };
  }
  if (code === 'MISSING_CONNECTION') {
    return {
      action: 'ask_user',
      message: CONNECTION_SETUP_AGENT_MESSAGE,
    };
  }
  return {
    action: 'stop_and_report',
    message: 'Stop here. Summarize what worked and what failed, include the actionable error details, and ask the user before retrying or trying an alternate approach.',
  };
}

function titleForKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusSymbol(status: unknown): string {
  if (typeof status === 'boolean') return status ? '✅' : '❌';
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  if (!normalized) return '•';
  if (['ok', 'success', 'succeeded', 'complete', 'completed', 'verified', 'healthy', 'passed', 'pass', 'in_sync', 'ready'].includes(normalized)) {
    return '✅';
  }
  if (['failed', 'failure', 'error', 'errored', 'rejected', 'missing', 'unverified', 'unhealthy', 'canceled', 'cancelled', 'aborted', 'expired'].includes(normalized)) {
    return '❌';
  }
  if (['pending', 'queued', 'in_progress'].includes(normalized)) {
    return '⏳';
  }
  if (['running', 'active'].includes(normalized)) {
    return '🟢';
  }
  if (normalized === 'blocked') {
    return '🚧';
  }
  if (normalized === 'skipped_requires_confirm') {
    return '🔐';
  }
  if (['warning', 'warn', 'skipped', 'noop'].includes(normalized)) {
    return '⚠️';
  }
  if (normalized === 'unknown') return '❔';
  return '•';
}

export function isOutcomeOnlyStatus(status: unknown): boolean {
  if (typeof status === 'boolean') return true;
  if (typeof status !== 'string') return false;
  return [
    'ok', 'success', 'succeeded', 'complete', 'verified', 'healthy', 'passed', 'pass',
    'failed', 'failure', 'error', 'errored', 'rejected', 'unverified', 'unhealthy',
  ].includes(status.toLowerCase());
}

export interface CommandTableColumn {
  header: string;
  value: (record: Record<string, unknown>) => unknown;
  maxWidth?: number;
}

export function formatTableCell(value: unknown, maxWidth = 40): string {
  if (value === null || value === undefined) return '';
  const text = scalarText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 1)}…`;
}

export function formatCommandTable(
  records: Array<Record<string, unknown>>,
  columns: CommandTableColumn[]
): string[] {
  if (records.length === 0 || columns.length === 0) return [];
  const rows = records.map((entry) => columns.map((column) => (
    formatTableCell(column.value(entry), column.maxWidth) || '—'
  )));
  const widths = columns.map((column, index) => Math.max(
    column.header.length,
    ...rows.map((row) => row[index].length)
  ));
  const formatRow = (cells: string[]) => cells
    .map((cell, index) => index === cells.length - 1 ? cell : cell.padEnd(widths[index]))
    .join('  ');
  return [
    '',
    formatRow(columns.map((column) => column.header)),
    formatRow(widths.map((width) => '─'.repeat(width))),
    ...rows.map(formatRow),
  ];
}

function actionIcon(type?: string): string {
  switch (type?.toLowerCase()) {
    case 'create':
      return '➕';
    case 'update':
      return '🔧';
    case 'destroy':
    case 'delete':
      return '🧨';
    case 'replace':
      return '♻️';
    case 'noop':
      return '✅';
    default:
      return '•';
  }
}

function emphasizeLabel(line: string): string {
  const match = /^([A-Za-z][A-Za-z0-9 _/-]{0,47}):\s*(.*)$/.exec(line);
  if (!match) return line;
  return `${match[1]}: ${match[2]}`;
}

function scalarText(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function summarizeProject(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name : undefined;
  const id = typeof value.id === 'string' ? value.id : undefined;
  const gitRemoteUrl = typeof value.gitRemoteUrl === 'string' ? value.gitRemoteUrl : undefined;
  const parts = [
    name ?? id,
    id && name ? `id ${id}` : undefined,
    gitRemoteUrl ? `git ${gitRemoteUrl}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function summarizeSpec(value: unknown): string[] {
  if (!isRecord(value)) return [summarizeValue(value)];
  const project = typeof value.project === 'string' ? value.project : 'project';
  const lines = [`${project}${typeof value.version === 'number' ? ` (v${value.version})` : ''}`];
  const environments = isRecord(value.environments) ? value.environments : {};
  for (const [name, env] of Object.entries(environments).slice(0, 8)) {
    if (!isRecord(env)) {
      lines.push(`${name}: ${summarizeValue(env)}`);
      continue;
    }
    const hosting = isRecord(env.hosting) && typeof env.hosting.provider === 'string'
      ? env.hosting.provider
      : 'unknown hosting';
    const services = isRecord(env.services) ? Object.keys(env.services) : [];
    const database = isRecord(env.database) && typeof env.database.provider === 'string'
      ? `${env.database.provider}${typeof env.database.engine === 'string' ? `/${env.database.engine}` : ''}`
      : undefined;
    const storage = isRecord(env.storage) ? Object.keys(env.storage) : [];
    const deploy = isRecord(env.deploy)
      ? `${typeof env.deploy.strategy === 'string' ? env.deploy.strategy : 'deploy'}${typeof env.deploy.trigger === 'string' ? `/${env.deploy.trigger}` : ''}${typeof env.deploy.branch === 'string' ? `@${env.deploy.branch}` : ''}`
      : undefined;
    const parts = [
      `hosting ${hosting}`,
      services.length > 0 ? `services ${services.join(', ')}` : undefined,
      database ? `database ${database}` : undefined,
      storage.length > 0 ? `storage ${storage.join(', ')}` : undefined,
      typeof env.domain === 'string' ? `domain ${env.domain}` : undefined,
      isRecord(env.email) && env.email.enabled === true ? 'email enabled' : undefined,
      deploy ? `deploy ${deploy}` : undefined,
    ].filter(Boolean);
    lines.push(`${name}: ${parts.join('; ')}`);
  }
  const total = Object.keys(environments).length;
  if (total > 8) lines.push(`... ${total - 8} more environment(s)`);
  return lines;
}

function summarizeAction(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const id = typeof value.id === 'string' ? value.id : undefined;
  const type = typeof value.type === 'string' ? value.type : undefined;
  const resource = isRecord(value.resource) ? value.resource : undefined;
  const resourceName = resource
    ? [
      typeof resource.kind === 'string' ? resource.kind : undefined,
      typeof resource.name === 'string' ? resource.name : undefined,
    ].filter(Boolean).join(':')
    : undefined;
  const provider = resource && typeof resource.provider === 'string' ? `on ${resource.provider}` : undefined;
  const reason = typeof value.reason === 'string' ? `- ${value.reason}` : undefined;
  const actionName = id ?? resourceName ?? 'action';
  return [actionIcon(type), `\`${actionName}\``, type, provider, reason].filter(Boolean).join(' ');
}

function summarizeReceipt(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const actionId = typeof value.actionId === 'string' ? value.actionId : undefined;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const error = typeof value.error === 'string' ? `error: ${value.error}` : undefined;
  return [statusSymbol(status), actionId ? `\`${actionId}\`` : 'receipt', isOutcomeOnlyStatus(status) ? undefined : status, message, error].filter(Boolean).join(' - ');
}

function summarizeConnection(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const provider = typeof value.provider === 'string' ? value.provider : 'connection';
  const status = typeof value.status === 'string' ? value.status : undefined;
  const scope = typeof value.scope === 'string' ? `for ${value.scope}` : undefined;
  const reasons = Array.isArray(value.reasons) ? `(${value.reasons.join(', ')})` : undefined;
  return [statusSymbol(status), provider, scope, isOutcomeOnlyStatus(status) ? undefined : status, reasons].filter(Boolean).join(' ');
}

function summarizeValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return scalarText(value);
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value instanceof Date) return value.toISOString();
  const record = value as Record<string, unknown>;
  const outcome = outcomeValue(record);
  const result = statusSymbol(outcome);
  const omitOutcome = new Set<string>(['conclusion', 'success', 'ok', 'healthy', 'verified', 'expired']);
  if (isOutcomeOnlyStatus(record.status)) omitOutcome.add('status');
  if (isOutcomeOnlyStatus(record.phase)) omitOutcome.add('phase');
  if (isOutcomeOnlyStatus(record.state)) omitOutcome.add('state');
  const preferred = [
    'name',
    'id',
    'status',
    'conclusion',
    'provider',
    'environment',
    'url',
    'message',
    'reason',
    'path',
    'count',
  ];
  const parts = preferred
    .filter((key) => !omitOutcome.has(key) && record[key] !== undefined && (record[key] === null || typeof record[key] !== 'object'))
    .map((key) => `${key}: ${scalarText(record[key])}`);
  if (parts.length > 0) return [result === '•' ? undefined : result, parts.slice(0, 4).join(', ')].filter(Boolean).join(' ');
  return `${Object.keys(record).length} field(s)`;
}

function formatLogs(values: unknown[]): string[] {
  if (values.length === 0) return ['Logs: none'];
  const lines = [`Logs: ${values.length}`];
  for (const value of values.slice(0, 12)) {
    if (!isRecord(value)) {
      lines.push(`  - ${summarizeValue(value)}`);
      continue;
    }
    const status = typeof value.status === 'string' ? value.status : undefined;
    const conclusion = typeof value.conclusion === 'string' ? value.conclusion : undefined;
    const result = conclusion ?? status;
    const summary = [
      statusSymbol(result),
      typeof value.name === 'string' ? value.name : 'job',
      value.jobId !== undefined ? `job ${scalarText(value.jobId)}` : undefined,
      status && (conclusion || !isOutcomeOnlyStatus(status)) ? status : undefined,
      typeof value.returnedLines === 'number' && typeof value.lineCount === 'number'
        ? `${value.returnedLines}/${value.lineCount} lines${value.truncated === true ? ' (truncated)' : ''}`
        : undefined,
    ].filter(Boolean).join(' · ');
    lines.push(`  - ${summary}`);
    if (typeof value.text === 'string') {
      value.text.split('\n').forEach((line) => lines.push(`  - │ ${line}`));
    }
  }
  if (values.length > 12) lines.push(`  - ... ${values.length - 12} more`);
  return lines;
}

function summarizeStorage(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const status = typeof value.status === 'string' ? value.status : undefined;
  const scope = isRecord(value.instanceScope) ? value.instanceScope : undefined;
  const scopeText = scope
    ? Object.entries(scope)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, entry]) => `${key}=${entry}`)
      .join(' / ')
    : '';
  return [
    statusSymbol(status),
    typeof value.name === 'string' ? value.name : undefined,
    typeof value.provider === 'string' ? `provider ${value.provider}` : undefined,
    typeof value.externalId === 'string' ? `resource ${value.externalId}` : undefined,
    scopeText ? `scope ${scopeText}` : undefined,
    status && !isOutcomeOnlyStatus(status) ? status : undefined,
    typeof value.objectCount === 'number' ? `${value.objectCount} object(s)` : undefined,
    typeof value.sizeBytes === 'number' ? `${value.sizeBytes} byte(s)` : undefined,
  ].filter(Boolean).join(', ');
}

const OUTCOME_KEYS = ['conclusion', 'success', 'ok', 'healthy', 'verified', 'expired', 'status', 'phase', 'state', 'severity'] as const;
const ID_KEYS = ['id', 'actionId', 'runId', 'jobId', 'artifactId', 'deploymentId', 'externalId', 'providerId'] as const;
const IDENTITY_KEYS = ['name', 'key', 'label', 'service', 'environment', 'provider', 'type', 'kind'] as const;
const STATE_KEYS = ['status', 'phase', 'state', 'severity'] as const;
const CONTEXT_KEYS = ['scope', 'platform', 'version', 'path', 'branch', 'ref', 'source'] as const;
const DESCRIPTION_KEYS = ['message', 'summary', 'reason', 'evidence'] as const;
const TIME_KEYS = ['timestamp', 'createdAt', 'startedAt', 'updatedAt', 'completedAt', 'lastVerifiedAt', 'expiresAt'] as const;
const LINK_KEYS = ['url', 'webUrl'] as const;

function isTableScalar(value: unknown): boolean {
  return value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || value instanceof Date;
}

function outcomeValue(entry: Record<string, unknown>): unknown {
  for (const key of OUTCOME_KEYS) {
    const value = entry[key];
    if (value === null || value === undefined || value === '') continue;
    if (key === 'expired' && typeof value === 'boolean') return !value;
    return value;
  }
  return undefined;
}

function columnWidth(key: string): number {
  if (LINK_KEYS.includes(key as typeof LINK_KEYS[number])) return 120;
  if (DESCRIPTION_KEYS.includes(key as typeof DESCRIPTION_KEYS[number])) return 64;
  if (TIME_KEYS.includes(key as typeof TIME_KEYS[number])) return 28;
  if (ID_KEYS.includes(key as typeof ID_KEYS[number])) return 48;
  if (['name', 'label', 'path'].includes(key)) return 40;
  return 30;
}

function orderedTableKeys(key: string, records: Array<Record<string, unknown>>): string[] {
  const discovered = Array.from(new Set(records.flatMap((entry) => (
    Object.entries(entry)
      .filter(([, value]) => isTableScalar(value))
      .map(([entryKey]) => entryKey)
  ))));
  if (key === 'rows') return discovered;

  const hasExplicitOutcome = records.some((entry) => (
    ['conclusion', 'success', 'ok', 'healthy', 'verified', 'expired']
      .some((entryKey) => entry[entryKey] !== null && entry[entryKey] !== undefined)
  ));
  const omit = new Set<string>(['conclusion', 'success', 'ok', 'healthy', 'verified', 'expired']);
  if (discovered.includes('nativeStatus') && discovered.some((entryKey) => ['status', 'phase'].includes(entryKey))) {
    omit.add('nativeStatus');
  }
  for (const stateKey of STATE_KEYS) {
    const values = records
      .map((entry) => entry[stateKey])
      .filter((value) => value !== null && value !== undefined && value !== '');
    if (!hasExplicitOutcome && values.length > 0 && values.every(isOutcomeOnlyStatus)) {
      omit.add(stateKey);
    }
  }

  const earlyPriority: readonly string[] = [
    ...IDENTITY_KEYS,
    ...STATE_KEYS,
    ...CONTEXT_KEYS,
  ];
  const latePriority: readonly string[] = [
    ...DESCRIPTION_KEYS,
    ...TIME_KEYS,
    ...LINK_KEYS,
    ...ID_KEYS,
  ];
  const categorized = new Set([...earlyPriority, ...latePriority]);
  return [
    ...earlyPriority.filter((entryKey, index) => (
      earlyPriority.indexOf(entryKey) === index && discovered.includes(entryKey) && !omit.has(entryKey)
    )),
    ...discovered.filter((entryKey) => !categorized.has(entryKey) && !omit.has(entryKey)),
    ...latePriority.filter((entryKey, index) => (
      latePriority.indexOf(entryKey) === index && discovered.includes(entryKey) && !omit.has(entryKey)
    )),
  ];
}

function formatRecordTable(key: string, values: unknown[]): string[] | null {
  const parsed = values.map((value) => isRecord(value) ? value : null);
  if (parsed.some((entry) => !entry)) return null;
  const records = parsed.filter(isRecord).slice(0, 12);
  const keys = orderedTableKeys(key, records);
  if (keys.length === 0) return null;
  const hasResult = key !== 'rows' && records.some((entry) => statusSymbol(outcomeValue(entry)) !== '•');
  const columns: CommandTableColumn[] = [
    ...(hasResult
      ? [{ header: 'RESULT', value: (entry: Record<string, unknown>) => statusSymbol(outcomeValue(entry)), maxWidth: 6 }]
      : []),
    ...keys.map((entryKey) => ({
      header: titleForKey(entryKey).toUpperCase(),
      value: (entry: Record<string, unknown>) => entry[entryKey],
      maxWidth: columnWidth(entryKey),
    })),
  ];
  return formatCommandTable(records, columns);
}

function formatArray(key: string, values: unknown[]): string[] {
  if (values.length === 0) return [`${titleForKey(key)}: none`];
  if (key === 'logs') return formatLogs(values);
  const lines = [`${titleForKey(key)}: ${values.length}`];
  const preserveAsRows = ['actions', 'drift', 'unmanaged', 'blocked', 'actionScopedBlocked', 'storage', 'receipts', 'required', 'missing'];
  if (!preserveAsRows.includes(key)) {
    const table = formatRecordTable(key, values);
    if (table) {
      lines.push(...table);
      if (values.length > 12) lines.push(`… ${values.length - 12} more ${titleForKey(key).toLowerCase()}`);
      return lines;
    }
  }
  const formatter =
    ['actions', 'drift', 'unmanaged', 'blocked', 'actionScopedBlocked'].includes(key)
      ? summarizeAction
      : key === 'storage'
        ? summarizeStorage
        : key === 'receipts'
          ? summarizeReceipt
          : ['required', 'missing'].includes(key)
            ? summarizeConnection
            : summarizeValue;
  for (const item of values.slice(0, 12)) {
    lines.push(`  - ${formatter(item)}`);
  }
  if (values.length > 12) lines.push(`  - ... ${values.length - 12} more`);
  return lines;
}

function formatConnections(value: unknown): string[] {
  if (Array.isArray(value)) return formatArray('connections', value);
  if (!isRecord(value)) return [`Connections: ${summarizeValue(value)}`];
  const required = Array.isArray(value.required) ? value.required : [];
  const missing = Array.isArray(value.missing) ? value.missing : [];
  const lines = [`Connections: ${required.length} required, ${missing.length} missing`];
  for (const item of missing.slice(0, 12)) {
    lines.push(`  - ${summarizeConnection(item)}`);
  }
  if (missing.length > 12) lines.push(`  - ... ${missing.length - 12} more missing`);
  return lines;
}

function setupLink(value: string, recommendedSetupUrl?: string): string {
  const match = /^(.*?):\s+(https?:\/\/\S+)$/.exec(value);
  const label = (match?.[1] ?? 'Open setup page').replace(/[\[\]]/g, '');
  const url = match?.[2] ?? value;
  const recommended = url === recommendedSetupUrl ? ' (recommended)' : '';
  return `  - Setup Link${recommended}: [${label}](${url})`;
}

function formatConnectionSetup(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const validEntries = entries.filter(isRecord);
  if (validEntries.length === 0) return [`Connection Setup: ${summarizeValue(value)}`];
  const lines = [`Connection Setup: ${validEntries.length}`];
  for (const entry of validEntries.slice(0, 6)) {
    const provider = typeof entry.provider === 'string' ? entry.provider : 'provider';
    const scope = typeof entry.scope === 'string' ? ` for ${entry.scope}` : '';
    lines.push(`  - ${provider}${scope}`);
    const recommendedSetupUrl = typeof entry.recommendedSetupUrl === 'string'
      ? entry.recommendedSetupUrl
      : undefined;
    const setupUrls = Array.isArray(entry.setupUrls) ? entry.setupUrls.filter((item): item is string => typeof item === 'string') : [];
    setupUrls.slice(0, 4).forEach((url) => lines.push(setupLink(url, recommendedSetupUrl)));
    if (typeof entry.credentialExample === 'string') {
      lines.push(`  - Connect with hv_connections: ${entry.credentialExample}`);
    }
    if (typeof entry.tokenType === 'string') {
      lines.push(`  - Token Type: ${entry.tokenType}`);
    }
    const notes = Array.isArray(entry.notes) ? entry.notes.filter((item): item is string => typeof item === 'string') : [];
    notes.slice(0, 3).forEach((note) => lines.push(`  - Note: ${note}`));
    const permissions = Array.isArray(entry.requiredPermissions)
      ? entry.requiredPermissions.filter((item): item is string => typeof item === 'string')
      : [];
    permissions.slice(0, 8).forEach((permission) => lines.push(`  - Permission: ${permission}`));
    if (permissions.length > 8) lines.push(`  - Permission: ... ${permissions.length - 8} more`);
  }
  if (validEntries.length > 6) lines.push(`  - ... ${validEntries.length - 6} more`);
  return lines;
}

function appendNestedArrayLines(
  lines: string[],
  value: Record<string, unknown>,
  excluded = new Set<string>()
): void {
  const arrays = Object.entries(value)
    .filter(([key, entry]) => !excluded.has(key) && Array.isArray(entry)) as Array<[string, unknown[]]>;
  for (const [key, entries] of arrays.slice(0, 8)) {
    for (const line of formatArray(key, entries)) {
      lines.push(`  ${line}`);
      if (lines.length >= 76) {
        lines.push('  … nested output truncated; structuredContent contains the full redacted envelope.');
        return;
      }
    }
  }
  if (arrays.length > 8) lines.push(`  … ${arrays.length - 8} more nested collections`);
}

function formatRecordLines(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const priority = [
    'project',
    'revision',
    'specRevision',
    'specSource',
    'environment',
    'verified',
    'inSync',
    'summary',
    'connections',
    'connectionSetup',
    'deploySource',
    'spec',
    'actions',
    'drift',
    'unmanaged',
    'blocked',
    'actionScopedBlocked',
    'receipts',
  ];
  const keys = [
    ...priority.filter((key) => Object.prototype.hasOwnProperty.call(record, key)),
    ...Object.keys(record).filter((key) => !priority.includes(key)),
  ];

  for (const key of keys) {
    const value = record[key];
    if (key === 'project') {
      lines.push(`${titleForKey(key)}: ${summarizeProject(value) ?? summarizeValue(value)}`);
    } else if (key === 'spec') {
      const specLines = summarizeSpec(value);
      lines.push(`Spec: ${specLines[0]}`);
      specLines.slice(1).forEach((line) => lines.push(`  - ${line}`));
    } else if (key === 'connections') {
      lines.push(...formatConnections(value));
    } else if (key === 'connectionSetup') {
      lines.push(...formatConnectionSetup(value));
    } else if (key === 'observed' && isRecord(value)) {
      lines.push(`${titleForKey(key)}: ${summarizeValue(value)}`);
      const simpleEntries = Object.entries(value)
        .filter(([, entry]) => entry === null || typeof entry !== 'object')
        .slice(0, 8);
      for (const [entryKey, entryValue] of simpleEntries) {
        lines.push(`  - ${entryKey}: ${scalarText(entryValue)}`);
      }
      appendNestedArrayLines(lines, value);
    } else if (Array.isArray(value)) {
      lines.push(...formatArray(key, value));
    } else if (isRecord(value)) {
      lines.push(`${titleForKey(key)}: ${summarizeValue(value)}`);
      const simpleEntries = Object.entries(value)
        .filter(([, entry]) => entry === null || typeof entry !== 'object')
        .slice(0, 8);
      for (const [entryKey, entryValue] of simpleEntries) {
        lines.push(`  - ${entryKey}: ${scalarText(entryValue)}`);
      }
      appendNestedArrayLines(lines, value);
    } else {
      lines.push(`${titleForKey(key)}: ${scalarText(value)}`);
    }
    if (lines.length >= 80) {
      lines.push('... output truncated; structuredContent contains the full redacted envelope.');
      break;
    }
  }
  return lines;
}

/**
 * Render redacted command data for a human interface. Command-aware
 * presentations reuse this fallback so uncommon fields are never hidden.
 */
export function formatCommandDataLines(data: unknown): string[] {
  return isRecord(data)
    ? formatRecordLines(data)
    : [summarizeValue(data)];
}

/** One branded header rule for every human-facing command renderer. */
export function formatHypervibeHeader(icon: string, title: string): string {
  return `${icon}  HYPERVIBE · ${title}`;
}

/** Render the safety and next-step portion shared by every human interface. */
export function formatCommandGuidanceLines(payload: CommandEnvelope): string[] {
  const lines: string[] = [];

  if (payload.warnings?.length) {
    lines.push('', '⚠️  WARNINGS');
    payload.warnings.forEach((warning) => lines.push(`• ${warning}`));
  }

  if (payload.agentInstruction) {
    lines.push('', '🛑  AGENT INSTRUCTION', payload.agentInstruction.message);
  }

  if (payload.hint) {
    lines.push('', '💡  HINT', payload.hint);
  }

  if (payload.next?.length) {
    lines.push('', '➡️  NEXT', payload.next.map((step) => `\`${step}\``).join(' → '));
  }

  return lines;
}

export function formatCommandEnvelope(payload: CommandEnvelope): string {
  const lines: string[] = [];
  const appendListLines = (entries: string[]) => {
    entries.forEach((line) => {
      if (line.startsWith('  - ')) {
        lines.push(`  • ${emphasizeLabel(line.slice(4))}`);
      } else {
        lines.push(`▸ ${emphasizeLabel(line)}`);
      }
    });
  };
  if (payload.ok) {
    lines.push(formatHypervibeHeader('✅', 'COMPLETE'));
  } else {
    lines.push(formatHypervibeHeader('❌', 'ERROR'));
    lines.push(`${payload.error?.code ?? 'UNKNOWN'} · ${payload.error?.message ?? 'Unknown error'}`);
  }

  if (payload.data !== undefined) {
    lines.push('', '📦 RESULT');
    const dataLines = formatCommandDataLines(payload.data);
    appendListLines(dataLines);
  }

  if (!payload.ok && payload.error?.details !== undefined) {
    lines.push('', '🔎  DETAILS');
    const detailLines = isRecord(payload.error.details)
      ? formatRecordLines(payload.error.details)
      : Array.isArray(payload.error.details)
        ? formatArray('details', payload.error.details)
        : [summarizeValue(payload.error.details)];
    appendListLines(detailLines);
  }

  lines.push(...formatCommandGuidanceLines(payload));

  return lines.join('\n');
}

export function redactCommandEnvelope(payload: CommandEnvelope): CommandEnvelope {
  return redactForResponse(payload) as CommandEnvelope;
}

export function commandSuccess(data?: unknown, extras?: ResponseExtras): CommandEnvelope {
  const agentInstruction = extras?.agentInstruction ?? successAgentInstruction(data);
  return redactCommandEnvelope({
    ok: true,
    ...(data !== undefined ? { data } : {}),
    ...(agentInstruction ? { agentInstruction } : {}),
    ...(extras?.hint ? { hint: extras.hint } : {}),
    ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    ...(extras?.next?.length ? { next: extras.next } : {}),
  });
}

export function commandError(
  code: ErrorCode,
  message: string,
  extras?: ResponseExtras & { details?: unknown }
): CommandEnvelope {
  const agentInstruction = extras?.agentInstruction ?? errorAgentInstruction(code, extras?.details);
  return redactCommandEnvelope({
    ok: false,
    error: {
      code,
      message,
      ...(extras?.details !== undefined ? { details: extras.details } : {}),
    },
    agentInstruction,
    ...(extras?.hint ? { hint: extras.hint } : {}),
    ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    ...(extras?.next?.length ? { next: extras.next } : {}),
  });
}

/**
 * Typed error a handler can throw to short-circuit into a structured
 * command error response.
 */
export class HvError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly extras?: ResponseExtras & { details?: unknown }
  ) {
    super(message);
    this.name = 'HvError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function commandErrorFromUnknown(error: unknown): CommandEnvelope {
  if (error instanceof HvError) {
    return commandError(error.code, error.message, error.extras);
  }
  if (error instanceof NotSupportedError) {
    return commandError('UNSUPPORTED', error.message, error.hint ? { hint: error.hint } : undefined);
  }
  return commandError('INTERNAL', describeError(error));
}

/**
 * Wrap a command handler so thrown errors become structured envelopes.
 * HvError keeps its code; anything else is INTERNAL.
 */
export function wrapCommandHandler<Args>(
  fn: (args: Args) => Promise<CommandEnvelope> | CommandEnvelope
): (args: Args) => Promise<CommandEnvelope> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (error) {
      return commandErrorFromUnknown(error);
    }
  };
}

/** Compatibility names while command modules move out of src/tools. */
export type ToolEnvelope = CommandEnvelope;
export const toolSuccess = commandSuccess;
export const toolError = commandError;
export const wrapHandler = wrapCommandHandler;
