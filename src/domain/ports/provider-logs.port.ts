import type { Environment } from '../entities/environment.entity.js';

/** A provider-neutral runtime log entry returned across the adapter boundary. */
export interface ProviderLogEntry {
  timestamp: string;
  severity: string;
  message: string;
}

export interface ProviderDeployment {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  service?: string;
  type?: string;
  logUri?: string;
}

export interface ProviderRuntimeLogsRequest {
  environment: Environment;
  serviceName: string;
  /** Hard public result bound. Providers may also use it as a query optimization. */
  limit: number;
  /** Providers may filter remotely, but callers must still enforce this locally. */
  errorsOnly?: boolean;
}

export interface ProviderRuntimeLogsResult {
  deploymentStatus?: string;
  deploymentId?: string;
  logs: ProviderLogEntry[];
}

export interface ProviderDeploymentsRequest {
  environment: Environment;
  serviceName?: string;
  /** Hard public result bound. Providers may also use it as a query optimization. */
  limit: number;
}

export interface ProviderBuildLogsRequest {
  environment: Environment;
  serviceName: string;
  deploymentId?: string;
}

export interface ProviderBuildLogsResult {
  deploymentId: string;
  buildLogs: string;
}

/** Provider port for bounded runtime log reads. */
export interface IProviderRuntimeLogsAdapter {
  readProviderLogs(request: ProviderRuntimeLogsRequest): Promise<ProviderRuntimeLogsResult>;
}

/** Provider port for bounded deployment-history reads. */
export interface IProviderDeploymentsAdapter {
  listProviderDeployments(request: ProviderDeploymentsRequest): Promise<ProviderDeployment[]>;
}

/** Provider port for build-log reads. */
export interface IProviderBuildLogsAdapter {
  readProviderBuildLogs(request: ProviderBuildLogsRequest): Promise<ProviderBuildLogsResult>;
}

function hasMethod<K extends string>(value: unknown, method: K): value is Record<K, (...args: never[]) => unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>)[method] === 'function';
}

export function isProviderRuntimeLogsAdapter(value: unknown): value is IProviderRuntimeLogsAdapter {
  return hasMethod(value, 'readProviderLogs');
}

export function isProviderDeploymentsAdapter(value: unknown): value is IProviderDeploymentsAdapter {
  return hasMethod(value, 'listProviderDeployments');
}

export function isProviderBuildLogsAdapter(value: unknown): value is IProviderBuildLogsAdapter {
  return hasMethod(value, 'readProviderBuildLogs');
}
