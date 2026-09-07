import { createHash } from 'node:crypto';

export interface AzureEnvironmentResourceGroupScope {
  subscriptionId: string;
  resourceGroup: string;
  resourceGroupId: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Azure Container Apps owns one deterministic resource group per Hypervibe
 * environment. Same-cloud datastores use this exact scope so their placement
 * cannot drift into connection credentials or an unrelated resource group.
 */
export function azureEnvironmentResourceGroupScope(params: {
  subscriptionId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
}): AzureEnvironmentResourceGroupScope {
  const prefix = `hv-${params.projectName}-${params.environmentName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54) || 'hypervibe';
  const resourceGroup = `${prefix}-${hash(`${params.environmentId}:${params.environmentName}`).slice(0, 8)}`;
  return {
    subscriptionId: params.subscriptionId,
    resourceGroup,
    resourceGroupId: azureResourceGroupId(params.subscriptionId, resourceGroup),
  };
}

export function azureResourceGroupId(
  subscriptionId: string,
  resourceGroup: string
): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

export function parseAzureResourceGroupScope(
  value: string,
  expectedSubscriptionId: string
): AzureEnvironmentResourceGroupScope {
  const match = value.match(/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)$/i);
  if (!match || match[1]!.toLowerCase() !== expectedSubscriptionId.toLowerCase()) {
    throw new Error(`Invalid or cross-subscription Azure resource group ID: ${value}`);
  }
  const resourceGroup = decodeURIComponent(match[2]!);
  return {
    subscriptionId: expectedSubscriptionId,
    resourceGroup,
    resourceGroupId: azureResourceGroupId(expectedSubscriptionId, resourceGroup),
  };
}

export function explicitAzureResourceGroupScope(
  value: string,
  expectedSubscriptionId: string
): AzureEnvironmentResourceGroupScope {
  if (value.startsWith('/')) {
    return parseAzureResourceGroupScope(value, expectedSubscriptionId);
  }
  const resourceGroup = value.trim();
  if (
    resourceGroup !== value
    || resourceGroup.length === 0
    || resourceGroup.length > 90
    || /[<>%&:\\?/#]/.test(resourceGroup)
    || resourceGroup.endsWith('.')
  ) {
    throw new Error('Azure resource-group scope must be an exact resource-group name or ARM resource-group ID.');
  }
  return {
    subscriptionId: expectedSubscriptionId,
    resourceGroup,
    resourceGroupId: azureResourceGroupId(expectedSubscriptionId, resourceGroup),
  };
}

export function azureContainerAppsResourceGroupScopeFromBinding(
  binding: unknown,
  expectedSubscriptionId: string
): AzureEnvironmentResourceGroupScope | null {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const record = binding as Record<string, unknown>;
  if (
    record.provider !== 'azure-container-apps'
    || typeof record.projectId !== 'string'
    || record.projectId.length === 0
  ) return null;
  return parseAzureResourceGroupScope(record.projectId, expectedSubscriptionId);
}
