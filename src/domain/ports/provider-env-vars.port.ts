import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';

export interface ProviderEnvironmentVariablesRequest {
  environment: Environment;
  service: Service;
}

export type ProviderEnvironmentVariablesResult =
  | { success: true; variables: Record<string, string> }
  | { success: false; error: string };

/** Provider-neutral read boundary for one exactly bound service's variables. */
export interface IProviderEnvironmentVariablesAdapter {
  readProviderEnvironmentVariables(
    request: ProviderEnvironmentVariablesRequest
  ): Promise<ProviderEnvironmentVariablesResult>;
}

export function isProviderEnvironmentVariablesAdapter(
  value: unknown
): value is IProviderEnvironmentVariablesAdapter {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).readProviderEnvironmentVariables === 'function';
}
