import { adapterFactory } from './adapter.factory.js';
import { UNCONFIGURED_HOSTING_PROVIDER, type Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { NotSupportedError } from '../errors/not-supported.error.js';
import { providerRegistry } from '../registry/provider.registry.js';
import {
  isProviderBuildLogsAdapter,
  isProviderDeploymentsAdapter,
  isProviderRuntimeLogsAdapter,
  type ProviderDeployment,
  type ProviderLogEntry,
} from '../ports/provider-logs.port.js';

export type { ProviderDeployment };

const ERROR_LOG_SEVERITIES = new Set([
  'warn',
  'warning',
  'err',
  'error',
  'critical',
  'alert',
  'emergency',
  'fatal',
]);

/** Adapter resolution failed before a provider log API could be called. */
export class ProviderLogsConnectionError extends Error {}

export interface ProviderLogsReadErrorDetails {
  message: string;
  cause?: string;
  causeCode?: string;
  httpStatus?: number;
}

function providerLogsReadErrorDetails(error: unknown): ProviderLogsReadErrorDetails {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const record = error && typeof error === 'object'
    ? error as { cause?: unknown; code?: unknown; response?: { status?: unknown } }
    : {};
  const cause = record.cause;
  const causeRecord = cause && typeof cause === 'object'
    ? cause as { message?: unknown; code?: unknown }
    : {};
  const causeMessage = cause instanceof Error
    ? cause.message.slice(0, 1000)
    : typeof causeRecord.message === 'string'
      ? causeRecord.message.slice(0, 1000)
      : undefined;
  const causeCode = typeof causeRecord.code === 'string'
    ? causeRecord.code
    : typeof record.code === 'string'
      ? record.code
      : undefined;
  const httpStatus = typeof record.response?.status === 'number'
    ? record.response.status
    : undefined;
  return {
    message,
    ...(causeMessage && causeMessage !== message ? { cause: causeMessage } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(httpStatus ? { httpStatus } : {}),
  };
}

export class ProviderLogsReadError extends Error {
  readonly details: ProviderLogsReadErrorDetails;

  constructor(
    readonly provider: string,
    readonly operation: string,
    error: unknown
  ) {
    const details = providerLogsReadErrorDetails(error);
    const cause = [
      details.message,
      details.cause,
      details.causeCode ? `code ${details.causeCode}` : undefined,
      details.httpStatus ? `HTTP ${details.httpStatus}` : undefined,
    ].filter(Boolean).join('; ');
    super(`${provider} ${operation} failed: ${cause}`);
    this.name = 'ProviderLogsReadError';
    this.details = details;
  }
}

async function readProviderOperation<T>(
  provider: string,
  operation: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new ProviderLogsReadError(provider, operation, error);
  }
}

function boundedProviderLogs(
  logs: ProviderLogEntry[],
  requestedLimit: number,
  errorsOnly: boolean
): ProviderLogEntry[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit)));
  const selected = errorsOnly ? logs.filter(isErrorLike) : logs;
  if (selected.length <= limit) return selected;
  return [...selected]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-limit);
}

export function detectProviderName(projectDefaultPlatform: string | undefined, bindingsProvider: string | undefined): string {
  return (bindingsProvider || projectDefaultPlatform || UNCONFIGURED_HOSTING_PROVIDER).toLowerCase();
}

export function isErrorLike(log: ProviderLogEntry): boolean {
  const message = log.message.trim();
  const normalizedMessage = message.toLowerCase();
  const severity = (log.severity || '').toLowerCase();
  // Normalize the provider vocabularies we expose through the shared log
  // port. In particular, Cloud Logging returns WARNING/CRITICAL/ALERT/
  // EMERGENCY and would otherwise be dropped by this second-stage filter.
  if (ERROR_LOG_SEVERITIES.has(severity)) {
    return true;
  }

  // File/module names are not runtime exceptions merely because their path
  // contains "error" or "exception".
  if (
    /^(?:loading|loaded|registering|registered|importing|imported)\b/i.test(message)
    && /\b(?:errors?|exceptions?)\.[a-z0-9]+(?:\b|$)/i.test(message)
  ) {
    return false;
  }

  // Successful summaries such as "0 errors" should not be promoted to
  // failures. Strip the zero-count phrase so a separate real failure signal
  // on the same line can still win.
  const withoutZeroCounts = normalizedMessage.replace(/\b0\s+(?:errors?|failures?)\b/g, '');
  return (
    /\b(?:error|exception|failed|failure|crash(?:ed)?|fatal)\b/.test(withoutZeroCounts)
    || /\b(?:econnrefused|connection refused|unhandled rejection|uncaught exception)\b/.test(withoutZeroCounts)
    || /[A-Za-z][A-Za-z0-9]*Error(?=[:\s]|$)/.test(message)
  );
}

export function supportsLogsDeploymentsProvider(provider: string): boolean {
  return Boolean(providerRegistry.getMetadata(provider.toLowerCase())?.orchestration?.logs?.deployments);
}

export function supportsLogsBuildProvider(provider: string): boolean {
  return Boolean(providerRegistry.getMetadata(provider.toLowerCase())?.orchestration?.logs?.build);
}

export function logsDeploymentsUnsupportedMessage(provider: string): string {
  const supported = providerRegistry.all()
    .filter((entry) => entry.metadata.orchestration?.logs?.deployments)
    .map((entry) => entry.metadata.name)
    .sort();
  return `logs_deployments currently supports ${supported.join(', ') || '(none)'} only (provider: ${provider}).`;
}

export function logsBuildUnsupportedMessage(provider: string): string {
  const supported = providerRegistry.all()
    .filter((entry) => entry.metadata.orchestration?.logs?.build)
    .map((entry) => entry.metadata.name)
    .sort();
  return `logs_build currently supports ${supported.join(', ') || '(none)'} only (provider: ${provider}).`;
}

export async function fetchProviderLogs(
  provider: string,
  project: Project,
  environment: Environment,
  serviceName: string,
  lines: number,
  options: { errorsOnly?: boolean } = {}
): Promise<{ deploymentStatus?: string; deploymentId?: string; logs: ProviderLogEntry[] }> {
  const result = await adapterFactory.getProviderAdapter(provider, project);
  if (!result.success || !result.adapter) {
    throw new ProviderLogsConnectionError(result.error || `Failed to create ${provider} adapter`);
  }
  const runtimeLogsAdapter = result.adapter;
  if (!isProviderRuntimeLogsAdapter(runtimeLogsAdapter)) {
    throw new NotSupportedError(provider, 'log reads');
  }

  // Some provider APIs do not support server-side severity filters. Preserve
  // the upstream bounded scan in that case, then enforce the caller's limit
  // locally so an over-returning provider cannot widen the public result.
  const scanLimit = options.errorsOnly ? 500 : lines;
  const providerResult = await readProviderOperation(
    provider,
    'service log read',
    () => runtimeLogsAdapter.readProviderLogs({
      environment,
      serviceName,
      limit: scanLimit,
      errorsOnly: options.errorsOnly,
    })
  );
  return {
    ...providerResult,
    logs: boundedProviderLogs(providerResult.logs, lines, options.errorsOnly === true),
  };
}

/**
 * List recent deployments for an environment (optionally narrowed to one
 * service) across the supported hosting providers. Throws on resolution and
 * provider failures with the same messages the legacy tools returned.
 */
export async function fetchProviderDeployments(
  provider: string,
  project: Project,
  environment: Environment,
  serviceName: string | undefined,
  limit: number
): Promise<ProviderDeployment[]> {
  const result = await adapterFactory.getProviderAdapter(provider, project);
  if (!result.success || !result.adapter) {
    throw new ProviderLogsConnectionError(result.error || `Failed to create ${provider} adapter`);
  }
  const deploymentsAdapter = result.adapter;
  if (!isProviderDeploymentsAdapter(deploymentsAdapter)) {
    throw new NotSupportedError(provider, 'deployment listing', logsDeploymentsUnsupportedMessage(provider));
  }
  const deployments = await readProviderOperation(
    provider,
    'deployment listing',
    () => deploymentsAdapter.listProviderDeployments({
      environment,
      serviceName,
      limit,
    })
  );
  return deployments.slice(0, limit);
}

/**
 * Get build logs for a deployment (latest by default) across the supported
 * hosting providers. Throws on resolution and provider failures.
 */
export async function fetchProviderBuildLogs(
  provider: string,
  project: Project,
  environment: Environment,
  serviceName: string,
  deploymentId?: string
): Promise<{ deploymentId: string; buildLogs: string }> {
  const result = await adapterFactory.getProviderAdapter(provider, project);
  if (!result.success || !result.adapter) {
    throw new ProviderLogsConnectionError(result.error || `Failed to create ${provider} adapter`);
  }
  const buildLogsAdapter = result.adapter;
  if (!isProviderBuildLogsAdapter(buildLogsAdapter)) {
    throw new NotSupportedError(provider, 'build log reads', logsBuildUnsupportedMessage(provider));
  }
  return readProviderOperation(
    provider,
    'build log read',
    () => buildLogsAdapter.readProviderBuildLogs({
      environment,
      serviceName,
      deploymentId,
    })
  );
}
