import {
  AzureResourceManagerClient,
  AzureResourceManagerError,
  type AzureArmResourceIdentity,
} from './azure-resource-manager.client.js';

export const AZURE_MANAGED_REDIS_API_VERSION = '2025-07-01';
export const AZURE_MANAGED_REDIS_DATABASE = 'default';

export interface AzureManagedRedisCluster {
  id: string;
  name: string;
  location: string;
  sku?: { name?: string };
  properties?: {
    provisioningState?: string;
    resourceState?: string;
    hostName?: string;
    minimumTlsVersion?: string;
    publicNetworkAccess?: string;
  };
  tags?: Record<string, string>;
}

export interface AzureManagedRedisDatabase {
  id: string;
  name: string;
  properties?: {
    provisioningState?: string;
    resourceState?: string;
    clientProtocol?: string;
    accessKeysAuthentication?: string;
    port?: number;
    redisVersion?: string;
  };
}

interface AzureManagedRedisKeys {
  primaryKey?: string;
  secondaryKey?: string;
}

export class AzureManagedRedisClient {
  constructor(private readonly arm: AzureResourceManagerClient) {}

  async verifyScope(): Promise<void> {
    await this.arm.verifySubscription();
  }

  clusterResourceId(name: string): string {
    return this.arm.resourcePath(
      'Microsoft.Cache',
      'redisEnterprise',
      name
    );
  }

  parseClusterId(value: string): AzureArmResourceIdentity {
    return this.arm.parseResourceId(
      value,
      'Microsoft.Cache',
      'redisEnterprise'
    );
  }

  async listClusters(): Promise<AzureManagedRedisCluster[]> {
    const clusters = await this.arm.listAll<AzureManagedRedisCluster>(
      this.arm.resourceGroupProviderPath(
        'Microsoft.Cache',
        'redisEnterprise'
      ),
      AZURE_MANAGED_REDIS_API_VERSION
    );
    for (const cluster of clusters) {
      const identity = this.parseClusterId(cluster.id);
      if (identity.name.toLowerCase() !== cluster.name.toLowerCase()) {
        throw new Error(
          `Azure Managed Redis returned inconsistent resource identity ${cluster.id}.`
        );
      }
    }
    return clusters;
  }

  async findClustersByName(name: string): Promise<AzureManagedRedisCluster[]> {
    const normalized = name.toLowerCase();
    return (await this.listClusters())
      .filter((cluster) => cluster.name.toLowerCase() === normalized);
  }

  async getCluster(
    resourceId: string
  ): Promise<AzureManagedRedisCluster | null> {
    const identity = this.parseClusterId(resourceId);
    const expectedResourceId = this.clusterResourceIdForIdentity(identity);
    const cluster = await this.arm.getNullable<AzureManagedRedisCluster>(
      expectedResourceId,
      AZURE_MANAGED_REDIS_API_VERSION
    );
    if (cluster) {
      this.parseClusterId(cluster.id);
      if (cluster.id.toLowerCase() !== expectedResourceId.toLowerCase()) {
        throw new Error(
          `Azure Managed Redis returned ${cluster.id} for ${resourceId}.`
        );
      }
    }
    return cluster;
  }

  async createCluster(
    name: string,
    body: Record<string, unknown>
  ): Promise<void> {
    await this.arm.request(
      'PUT',
      this.clusterResourceId(name),
      AZURE_MANAGED_REDIS_API_VERSION,
      body
    );
  }

  async updateCluster(
    resourceId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const identity = this.parseClusterId(resourceId);
    await this.arm.request(
      'PATCH',
      this.clusterResourceIdForIdentity(identity),
      AZURE_MANAGED_REDIS_API_VERSION,
      body
    );
  }

  async createDatabase(clusterResourceId: string): Promise<void> {
    const identity = this.parseClusterId(clusterResourceId);
    await this.arm.request(
      'PUT',
      `${this.clusterResourceIdForIdentity(identity)}/databases/${AZURE_MANAGED_REDIS_DATABASE}`,
      AZURE_MANAGED_REDIS_API_VERSION,
      {
        properties: {
          clientProtocol: 'Encrypted',
          clusteringPolicy: 'NoCluster',
          evictionPolicy: 'VolatileLRU',
          accessKeysAuthentication: 'Enabled',
          port: 10000,
        },
      }
    );
  }

  async getDatabase(
    clusterResourceId: string
  ): Promise<AzureManagedRedisDatabase | null> {
    const identity = this.parseClusterId(clusterResourceId);
    const resourceId = `${this.clusterResourceIdForIdentity(identity)}/databases/${AZURE_MANAGED_REDIS_DATABASE}`;
    const database = await this.arm.getNullable<AzureManagedRedisDatabase>(
      resourceId,
      AZURE_MANAGED_REDIS_API_VERSION
    );
    if (database && (!database.id || database.id.toLowerCase() !== resourceId.toLowerCase())) {
      throw new Error(`Azure Managed Redis returned database ${database.id ?? 'without an ID'} for ${resourceId}.`);
    }
    return database;
  }

  async listKeys(clusterResourceId: string): Promise<string> {
    const identity = this.parseClusterId(clusterResourceId);
    const keys = await this.arm.request<AzureManagedRedisKeys>(
      'POST',
      `${this.clusterResourceIdForIdentity(identity)}/databases/${AZURE_MANAGED_REDIS_DATABASE}/listKeys`,
      AZURE_MANAGED_REDIS_API_VERSION
    );
    if (typeof keys.primaryKey !== 'string' || keys.primaryKey.length === 0) {
      throw new Error(
        'Azure Managed Redis did not return a primary access key.'
      );
    }
    return keys.primaryKey;
  }

  async deleteCluster(resourceId: string): Promise<void> {
    const identity = this.parseClusterId(resourceId);
    try {
      await this.arm.request(
        'DELETE',
        this.clusterResourceIdForIdentity(identity),
        AZURE_MANAGED_REDIS_API_VERSION
      );
    } catch (error) {
      if (
        !(error instanceof AzureResourceManagerError)
        || error.status !== 404
      ) {
        throw error;
      }
    }
  }

  private clusterResourceIdForIdentity(identity: AzureArmResourceIdentity): string {
    return `/subscriptions/${encodeURIComponent(identity.subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(identity.resourceGroup)}`
      + `/providers/Microsoft.Cache/redisEnterprise/${encodeURIComponent(identity.name)}`;
  }
}
