import {
  AzureResourceManagerClient,
  AzureResourceManagerError,
  type AzureArmResourceIdentity,
} from './azure-resource-manager.client.js';

export const AZURE_POSTGRES_API_VERSION = '2025-08-01';

export interface AzurePostgresServer {
  id: string;
  name: string;
  location: string;
  sku?: {
    name?: string;
    tier?: string;
  };
  properties?: {
    state?: string;
    fullyQualifiedDomainName?: string;
    administratorLogin?: string;
    version?: string;
    network?: {
      publicNetworkAccess?: string;
    };
  };
  tags?: Record<string, string>;
}

export interface AzurePostgresDatabase {
  id: string;
  name: string;
  properties?: {
    charset?: string;
    collation?: string;
  };
}

export interface AzurePostgresFirewallRule {
  id: string;
  name: string;
  properties?: {
    startIpAddress?: string;
    endIpAddress?: string;
  };
}

export class AzurePostgresClient {
  constructor(private readonly arm: AzureResourceManagerClient) {}

  async verifyScope(): Promise<void> {
    await this.arm.verifySubscription();
  }

  serverResourceId(name: string): string {
    return this.arm.resourcePath(
      'Microsoft.DBforPostgreSQL',
      'flexibleServers',
      name
    );
  }

  parseServerId(value: string): AzureArmResourceIdentity {
    return this.arm.parseResourceId(
      value,
      'Microsoft.DBforPostgreSQL',
      'flexibleServers'
    );
  }

  async listServers(): Promise<AzurePostgresServer[]> {
    const servers = await this.arm.listAll<AzurePostgresServer>(
      this.arm.resourceGroupProviderPath(
        'Microsoft.DBforPostgreSQL',
        'flexibleServers'
      ),
      AZURE_POSTGRES_API_VERSION
    );
    for (const server of servers) {
      const identity = this.parseServerId(server.id);
      if (identity.name.toLowerCase() !== server.name.toLowerCase()) {
        throw new Error(
          `Azure PostgreSQL returned inconsistent resource identity ${server.id}.`
        );
      }
    }
    return servers;
  }

  async findServersByName(name: string): Promise<AzurePostgresServer[]> {
    const normalized = name.toLowerCase();
    return (await this.listServers())
      .filter((server) => server.name.toLowerCase() === normalized);
  }

  async getServer(resourceId: string): Promise<AzurePostgresServer | null> {
    const identity = this.parseServerId(resourceId);
    const expectedResourceId = this.serverResourceIdForIdentity(identity);
    const server = await this.arm.getNullable<AzurePostgresServer>(
      expectedResourceId,
      AZURE_POSTGRES_API_VERSION
    );
    if (server) {
      this.parseServerId(server.id);
      if (server.id.toLowerCase() !== expectedResourceId.toLowerCase()) {
        throw new Error(
          `Azure PostgreSQL returned ${server.id} for ${resourceId}.`
        );
      }
    }
    return server;
  }

  async createServer(
    name: string,
    body: Record<string, unknown>
  ): Promise<void> {
    await this.arm.request(
      'PUT',
      this.serverResourceId(name),
      AZURE_POSTGRES_API_VERSION,
      body
    );
  }

  async createDatabase(
    serverResourceId: string,
    databaseName: string
  ): Promise<void> {
    const identity = this.parseServerId(serverResourceId);
    await this.arm.request(
      'PUT',
      `${this.serverResourceIdForIdentity(identity)}/databases/${encodeURIComponent(databaseName)}`,
      AZURE_POSTGRES_API_VERSION,
      {
        properties: {
          charset: 'UTF8',
          collation: 'en_US.utf8',
        },
      }
    );
  }

  async createAzureServicesFirewallRule(
    serverResourceId: string
  ): Promise<void> {
    const identity = this.parseServerId(serverResourceId);
    await this.arm.request(
      'PUT',
      `${this.serverResourceIdForIdentity(identity)}/firewallRules/hypervibe-azure-services`,
      AZURE_POSTGRES_API_VERSION,
      {
        properties: {
          startIpAddress: '0.0.0.0',
          endIpAddress: '0.0.0.0',
        },
      }
    );
  }

  async upsertFirewallRule(
    serverResourceId: string,
    ruleName: string,
    address: string
  ): Promise<void> {
    const identity = this.parseServerId(serverResourceId);
    await this.arm.request(
      'PUT',
      `${this.serverResourceIdForIdentity(identity)}/firewallRules/${encodeURIComponent(ruleName)}`,
      AZURE_POSTGRES_API_VERSION,
      { properties: { startIpAddress: address, endIpAddress: address } }
    );
  }

  async getFirewallRule(
    serverResourceId: string,
    ruleName: string
  ): Promise<AzurePostgresFirewallRule | null> {
    const identity = this.parseServerId(serverResourceId);
    const resourceId = `${this.serverResourceIdForIdentity(identity)}/firewallRules/${encodeURIComponent(ruleName)}`;
    const rule = await this.arm.getNullable<AzurePostgresFirewallRule>(
      resourceId,
      AZURE_POSTGRES_API_VERSION
    );
    if (rule && (!rule.id || rule.id.toLowerCase() !== resourceId.toLowerCase())) {
      throw new Error(`Azure PostgreSQL returned firewall rule ${rule.id ?? 'without an ID'} for ${resourceId}.`);
    }
    return rule;
  }

  async deleteFirewallRule(
    serverResourceId: string,
    ruleName: string
  ): Promise<void> {
    const identity = this.parseServerId(serverResourceId);
    try {
      await this.arm.request(
        'DELETE',
        `${this.serverResourceIdForIdentity(identity)}/firewallRules/${encodeURIComponent(ruleName)}`,
        AZURE_POSTGRES_API_VERSION
      );
    } catch (error) {
      if (!(error instanceof AzureResourceManagerError) || error.status !== 404) throw error;
    }
  }

  async getAzureServicesFirewallRule(
    serverResourceId: string
  ): Promise<AzurePostgresFirewallRule | null> {
    const identity = this.parseServerId(serverResourceId);
    const resourceId = `${this.serverResourceIdForIdentity(identity)}/firewallRules/hypervibe-azure-services`;
    const rule = await this.arm.getNullable<AzurePostgresFirewallRule>(
      resourceId,
      AZURE_POSTGRES_API_VERSION
    );
    if (rule && (!rule.id || rule.id.toLowerCase() !== resourceId.toLowerCase())) {
      throw new Error(`Azure PostgreSQL returned firewall rule ${rule.id ?? 'without an ID'} for ${resourceId}.`);
    }
    return rule;
  }

  async getDatabase(
    serverResourceId: string,
    databaseName: string
  ): Promise<AzurePostgresDatabase | null> {
    const identity = this.parseServerId(serverResourceId);
    const resourceId = `${this.serverResourceIdForIdentity(identity)}/databases/${encodeURIComponent(databaseName)}`;
    const database = await this.arm.getNullable<AzurePostgresDatabase>(
      resourceId,
      AZURE_POSTGRES_API_VERSION
    );
    if (database && (!database.id || database.id.toLowerCase() !== resourceId.toLowerCase())) {
      throw new Error(`Azure PostgreSQL returned database ${database.id ?? 'without an ID'} for ${resourceId}.`);
    }
    return database;
  }

  async deleteServer(resourceId: string): Promise<void> {
    const identity = this.parseServerId(resourceId);
    try {
      await this.arm.request(
        'DELETE',
        this.serverResourceIdForIdentity(identity),
        AZURE_POSTGRES_API_VERSION
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

  private serverResourceIdForIdentity(identity: AzureArmResourceIdentity): string {
    return `/subscriptions/${encodeURIComponent(identity.subscriptionId)}`
      + `/resourceGroups/${encodeURIComponent(identity.resourceGroup)}`
      + `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${encodeURIComponent(identity.name)}`;
  }
}
