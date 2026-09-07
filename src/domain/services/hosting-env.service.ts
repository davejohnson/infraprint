import type { Environment } from '../entities/environment.entity.js';
import { UNCONFIGURED_HOSTING_PROVIDER, type Project } from '../entities/project.entity.js';
import type { Service } from '../entities/service.entity.js';
import { parseHostingBindings, type IHostingAdapter } from '../ports/hosting.port.js';
import type { Receipt } from '../ports/provider.port.js';
import { isProviderEnvironmentVariablesAdapter } from '../ports/provider-env-vars.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { adapterFactory } from './adapter.factory.js';

export const HOSTING_ENV_REMOVE_OPERATION = 'hostingEnvRemove';

export function hostingProviderForEnvironment(project: Project, environment: Environment): string {
  const bindings = parseHostingBindings(environment);
  if (bindings.provider) return bindings.provider.toLowerCase();
  const provider = project.defaultPlatform?.trim().toLowerCase();
  if (provider && provider !== UNCONFIGURED_HOSTING_PROVIDER) return provider;
  throw new Error(
    `Environment ${environment.name} has no reviewed hosting provider binding. Run hv_spec and hv_plan before runtime synchronization.`
  );
}

export function providerDisplayName(provider: string): string {
  return providerRegistry.getMetadata(provider.toLowerCase())?.displayName ?? provider;
}

export function serviceHasHostingBinding(environment: Environment, serviceName: string): boolean {
  const bindings = parseHostingBindings(environment);
  const serviceBinding = bindings.services?.[serviceName];
  return Boolean(serviceBinding?.serviceId || serviceBinding?.jobName);
}

export function isHostingEnvRemovalAction(action: {
  resource: { kind: string };
  metadata?: Record<string, unknown>;
}): boolean {
  return action.resource.kind === 'service'
    && action.metadata?.operation === HOSTING_ENV_REMOVE_OPERATION;
}

export async function syncHostingEnvVars(params: {
  project: Project;
  environment: Environment;
  service: Service;
  vars: Record<string, string>;
  /** Keep exact-SHA CI as the next code release boundary when supported. */
  deferDeployment?: boolean;
}): Promise<Receipt & { provider?: string }> {
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const displayName = providerDisplayName(provider);

  if (!serviceHasHostingBinding(params.environment, params.service.name)) {
    return {
      success: false,
      message: `${params.service.name} is not deployed to ${displayName} in ${params.environment.name}`,
      error: `Service ${params.service.name} is not bound in environment ${params.environment.name}`,
      provider,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      message: `No ${displayName} hosting adapter available`,
      error: adapterResult.error || `No ${provider} hosting adapter available`,
      provider,
    };
  }

  const adapter = adapterResult.adapter as unknown as Partial<IHostingAdapter>;
  if (typeof adapter.setEnvVars !== 'function') {
    return {
      success: false,
      message: `${displayName} does not support environment variable sync`,
      error: `${provider} adapter does not implement setEnvVars`,
      provider,
    };
  }

  const deferDeployment = params.deferDeployment === true
    && adapter.capabilities?.supportsDeferredDeploy === true;
  const receipt = deferDeployment
    ? await adapter.setEnvVars(
      params.environment,
      params.service,
      params.vars,
      { deferDeployment: true }
    )
    : await adapter.setEnvVars(
      params.environment,
      params.service,
      params.vars
    );
  return {
    ...receipt,
    provider,
    data: {
      ...(receipt.data ?? {}),
      provider,
      service: params.service.name,
      variableCount: Object.keys(params.vars).length,
      ...(deferDeployment ? { deploymentDeferred: true } : {}),
    },
  };
}

export async function removeHostingEnvVars(params: {
  project: Project;
  environment: Environment;
  service: Service;
  keys: string[];
}): Promise<Receipt & { provider?: string }> {
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const displayName = providerDisplayName(provider);
  const keys = [...new Set(params.keys)]
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .sort();

  if (keys.length !== new Set(params.keys).size || keys.length === 0) {
    return {
      success: false,
      message: 'No valid environment variables were selected for deletion',
      error: 'The plan action did not contain a valid, non-empty key list',
      provider,
    };
  }

  if (!serviceHasHostingBinding(params.environment, params.service.name)) {
    return {
      success: false,
      message: `${params.service.name} is not deployed to ${displayName} in ${params.environment.name}`,
      error: `Service ${params.service.name} is not bound in environment ${params.environment.name}`,
      provider,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      message: `No ${displayName} hosting adapter available`,
      error: adapterResult.error || `No ${provider} hosting adapter available`,
      provider,
    };
  }

  const adapter = adapterResult.adapter as unknown as Partial<IHostingAdapter>;
  if (typeof adapter.deleteEnvVars !== 'function') {
    return {
      success: false,
      message: `${displayName} does not support explicit environment variable removal`,
      error: `${provider} adapter does not implement deleteEnvVars`,
      provider,
    };
  }

  const receipt = await adapter.deleteEnvVars(params.environment, params.service, keys);
  return {
    ...receipt,
    provider,
    data: {
      ...(receipt.data ?? {}),
      provider,
      service: params.service.name,
      requestedKeys: keys,
      requestedVariableCount: keys.length,
    },
  };
}

export async function readHostingEnvVars(params: {
  project: Project;
  environment: Environment;
  service: Service;
}): Promise<
  { success: true; provider: string; variables: Record<string, string> }
  | { success: false; provider: string; error: string; connectionUnavailable?: boolean }
> {
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const displayName = providerDisplayName(provider);

  if (!serviceHasHostingBinding(params.environment, params.service.name)) {
    return {
      success: false,
      provider,
      error: `Service ${params.service.name} is not deployed to ${displayName} in ${params.environment.name}`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      provider,
      error: adapterResult.error || `No ${provider} hosting adapter available`,
      connectionUnavailable: true,
    };
  }

  const adapter = adapterResult.adapter;
  if (!isProviderEnvironmentVariablesAdapter(adapter)) {
    return {
      success: false,
      provider,
      error: `${displayName} env var reads are not supported by this adapter version`,
    };
  }

  const readResult = await adapter.readProviderEnvironmentVariables({
    environment: params.environment,
    service: params.service,
  });
  return readResult.success
    ? { success: true, provider, variables: readResult.variables }
    : { success: false, provider, error: readResult.error };
}
