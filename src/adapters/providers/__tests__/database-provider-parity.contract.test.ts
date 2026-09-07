import { vi } from 'vitest';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ObservedState } from '../../../domain/ports/observe.port.js';
import { RdsAdapter } from '../aws/rds.adapter.js';
import { CloudSqlAdapter } from '../gcp/cloudsql.adapter.js';
import { FlyDatabaseAdapter } from '../fly/fly-database.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../railway/railway-database.factory.js';
import { SupabaseAdapter } from '../supabase/supabase.adapter.js';
import {
  runDatabaseProviderParityContract,
  type DatabaseLifecycleParityFixture,
  type DatabaseLifecycleParityScenario,
} from './database-lifecycle.contract.js';

const RESOURCE_NAME = 'invoice-perfect-production-postgres';
const EXTERNAL_IDS: [string, string] = [RESOURCE_NAME, 'invoice-perfect-production-postgres-duplicate'];

function makeEnvironment(
  platformBindings: Record<string, unknown> = {}
): Environment {
  const now = new Date();
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

function makeComponent(
  provider: string,
  externalId: string,
  bindings: Record<string, unknown> = {}
): Component {
  const now = new Date();
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: { provider, ...bindings },
    createdAt: now,
    updatedAt: now,
  };
}

function fetchMetrics(fetchMock: ReturnType<typeof vi.fn>): Pick<
  DatabaseLifecycleParityFixture,
  'mutations' | 'observations'
> {
  return {
    mutations: () => fetchMock.mock.calls
      .filter((call) => !['GET', 'HEAD'].includes((call[1] as RequestInit | undefined)?.method ?? 'GET'))
      .map((call) => call[0]),
    observations: () => fetchMock.mock.calls
      .filter((call) => ['GET', 'HEAD'].includes((call[1] as RequestInit | undefined)?.method ?? 'GET'))
      .length,
  };
}

async function setupSupabase(
  scenario: DatabaseLifecycleParityScenario
): Promise<DatabaseLifecycleParityFixture> {
  let itemReads = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/v1/organizations') {
      return Response.json([{ id: 'org-1', name: 'Primary' }]);
    }

    if (method === 'GET' && url.pathname === '/v1/projects') {
      if (scenario === 'observation_unknown') {
        return Response.json({ message: 'observation unavailable' }, { status: 503 });
      }
      if (scenario === 'identity_conflict') {
        return Response.json(EXTERNAL_IDS.map((id) => ({
          id,
          name: RESOURCE_NAME,
          organization_id: 'org-1',
          region: 'us-east-1',
          status: 'ACTIVE_HEALTHY',
        })));
      }
    }

    if (url.pathname === `/v1/projects/${EXTERNAL_IDS[0]}` && method === 'GET') {
      itemReads += 1;
      if (scenario === 'already_absent') {
        return Response.json({ message: 'not found' }, { status: 404 });
      }
      if (scenario === 'delete_observation_unknown') {
        return Response.json({ message: 'observation unavailable' }, { status: 503 });
      }
      if (scenario === 'delete_retry' && itemReads >= 3) {
        return Response.json({ message: 'not found' }, { status: 404 });
      }
      return Response.json({
        id: EXTERNAL_IDS[0],
        name: RESOURCE_NAME,
        organization_id: 'org-1',
        region: 'us-east-1',
        status: itemReads > 1 ? 'GOING_DOWN' : 'ACTIVE_HEALTHY',
      });
    }

    if (url.pathname === `/v1/projects/${EXTERNAL_IDS[0]}` && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected Supabase request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HYPERVIBE_SUPABASE_DELETE_ATTEMPTS', '4');
  vi.stubEnv('HYPERVIBE_SUPABASE_DELETE_DELAY_MS', '0');
  const adapter = new SupabaseAdapter();
  await adapter.connect({ accessToken: 'token', organizationId: 'org-1' });
  return { adapter, ...fetchMetrics(fetchMock) };
}

async function setupFly(
  scenario: DatabaseLifecycleParityScenario
): Promise<DatabaseLifecycleParityFixture> {
  let itemReads = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/v1/postgres') {
      if (scenario === 'observation_unknown') {
        return Response.json({ error: 'observation unavailable' }, { status: 503 });
      }
      if (scenario === 'identity_conflict') {
        return Response.json({
          data: EXTERNAL_IDS.map((id) => ({
            id,
            name: RESOURCE_NAME,
            organization: { slug: 'hypervibe-test' },
            region: 'iad',
            plan: 'basic',
            status: 'ready',
          })),
        });
      }
    }

    if (url.pathname === `/v1/postgres/${EXTERNAL_IDS[0]}` && method === 'GET') {
      itemReads += 1;
      if (scenario === 'already_absent') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      if (scenario === 'delete_observation_unknown') {
        return Response.json({ error: 'observation unavailable' }, { status: 503 });
      }
      if (scenario === 'delete_retry' && itemReads >= 3) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      return Response.json({
        data: {
          id: EXTERNAL_IDS[0],
          name: RESOURCE_NAME,
          organization: { slug: 'hypervibe-test' },
          region: 'iad',
          plan: 'basic',
          status: itemReads > 1 ? 'deleting' : 'ready',
        },
      });
    }

    if (url.pathname === `/v1/postgres/${EXTERNAL_IDS[0]}` && method === 'DELETE') {
      return new Response(null, { status: 202 });
    }

    throw new Error(`Unexpected Fly.io request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HYPERVIBE_FLY_DATABASE_DELETE_ATTEMPTS', '4');
  vi.stubEnv('HYPERVIBE_FLY_DATABASE_DELETE_DELAY_MS', '0');
  const adapter = new FlyDatabaseAdapter();
  await adapter.connect({
    apiToken: 'flyv1-test-token',
    organizationSlug: 'hypervibe-test',
  });
  return { adapter, ...fetchMetrics(fetchMock) };
}

async function setupCloudSql(
  scenario: DatabaseLifecycleParityScenario
): Promise<DatabaseLifecycleParityFixture> {
  let itemReads = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const itemPath = `/v1/projects/gcp-project/instances/${EXTERNAL_IDS[0]}`;

    if (url.pathname === itemPath && method === 'GET') {
      itemReads += 1;
      if (scenario === 'observation_unknown' || scenario === 'delete_observation_unknown') {
        return Response.json({ message: 'observation unavailable' }, { status: 503 });
      }
      if (scenario === 'already_absent' || (scenario === 'delete_retry' && itemReads >= 3)) {
        return Response.json({ message: 'not found' }, { status: 404 });
      }
      return Response.json({
        name: EXTERNAL_IDS[0],
        state: itemReads > 1 ? 'PENDING_DELETE' : 'RUNNABLE',
        databaseVersion: 'POSTGRES_15',
        region: 'us-central1',
      });
    }

    if (url.pathname === itemPath && method === 'DELETE') {
      return Response.json({});
    }

    throw new Error(`Unexpected Cloud SQL request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HYPERVIBE_CLOUDSQL_DELETE_ATTEMPTS', '4');
  vi.stubEnv('HYPERVIBE_CLOUDSQL_DELETE_DELAY_MS', '0');
  const adapter = new CloudSqlAdapter();
  await adapter.connect({
    projectId: 'gcp-project',
    region: 'us-central1',
    credentials: JSON.stringify({
      type: 'service_account',
      project_id: 'gcp-project',
      private_key: 'dummy',
      client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
    }),
  });
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry =
    new Date(Date.now() + 60_000);
  return { adapter, ...fetchMetrics(fetchMock) };
}

async function setupRds(
  scenario: DatabaseLifecycleParityScenario
): Promise<DatabaseLifecycleParityFixture> {
  let observations = 0;
  const mutations: unknown[] = [];
  const adapter = new RdsAdapter();
  await adapter.connect({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-west-2',
    vpcId: 'vpc-1',
  });
  const rdsSend = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeDBInstancesCommand) {
      observations += 1;
      if (scenario === 'observation_unknown' || scenario === 'delete_observation_unknown') {
        const error = new Error('RDS observation unavailable');
        Object.assign(error, { name: 'ThrottlingException' });
        throw error;
      }
      if (scenario === 'already_absent' || (scenario === 'delete_retry' && observations >= 3)) {
        const error = new Error('DB instance not found');
        Object.assign(error, { name: 'DBInstanceNotFoundFault' });
        throw error;
      }
      return {
        DBInstances: [{
          DBInstanceIdentifier: EXTERNAL_IDS[0],
          DBInstanceArn: `arn:aws:rds:us-west-2:123456789012:db:${EXTERNAL_IDS[0]}`,
          DBInstanceStatus: observations > 1 ? 'deleting' : 'available',
        }],
      };
    }
    if (command instanceof CreateDBInstanceCommand || command instanceof DeleteDBInstanceCommand) {
      mutations.push(command);
      return {};
    }
    throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  const ec2Send = vi.fn(async (command: unknown) => {
    mutations.push(command);
    return {};
  });
  (adapter as unknown as { rds: { send: typeof rdsSend } }).rds = { send: rdsSend };
  (adapter as unknown as { ec2: { send: typeof ec2Send } }).ec2 = { send: ec2Send };
  const stsSend = vi.fn(async (command: unknown) => {
    if (command instanceof GetCallerIdentityCommand) return { Account: '123456789012' };
    throw new Error(`Unexpected STS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  (adapter as unknown as { sts: { send: typeof stsSend } }).sts = { send: stsSend };
  vi.stubEnv('HYPERVIBE_RDS_READY_ATTEMPTS', '4');
  vi.stubEnv('HYPERVIBE_RDS_READY_DELAY_MS', '0');
  return {
    adapter,
    mutations: () => mutations,
    observations: () => observations,
  };
}

function railwayObservedState(
  scenario: DatabaseLifecycleParityScenario
): ObservedState {
  const identityConflict = scenario === 'identity_conflict';
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-env',
    services: [],
    databases: identityConflict
      ? EXTERNAL_IDS.map((externalId) => ({
        provider: 'railway',
        engine: 'postgres',
        externalId,
        name: RESOURCE_NAME,
        status: 'running',
      }))
      : [],
    partial: scenario === 'observation_unknown',
    warnings: scenario === 'observation_unknown' ? ['database observation unavailable'] : [],
    completeness: {
      project: 'complete',
      environment: 'complete',
      services: 'complete',
      databases: scenario === 'observation_unknown' ? 'unknown' : 'complete',
    },
  };
}

async function setupRailway(
  scenario: DatabaseLifecycleParityScenario
): Promise<DatabaseLifecycleParityFixture> {
  const mutations: unknown[] = [];
  let observations = 0;
  let hostingAdapter: RailwayAdapter | Record<string, unknown>;

  if (scenario === 'observation_unknown' || scenario === 'identity_conflict') {
    hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
      },
      observe: vi.fn(async () => {
        observations += 1;
        return railwayObservedState(scenario);
      }),
      ensureComponent: vi.fn(async () => {
        mutations.push('ensureComponent');
        throw new Error('Provisioning should be blocked by observation');
      }),
      ensureProject: vi.fn(),
      listPlugins: vi.fn(async () => []),
    };
  } else {
    const railway = new RailwayAdapter();
    const request = vi.fn(async (document: unknown) => {
      const operation = String(document);
      if (operation.includes('query GetService')) {
        observations += 1;
        if (scenario === 'already_absent') {
          return { service: null };
        }
        if (scenario === 'delete_observation_unknown') {
          throw new Error('Railway database observation unavailable');
        }
        return observations >= 3
          ? { service: null }
          : { service: { id: EXTERNAL_IDS[0] } };
      }
      if (operation.includes('mutation DeleteService')) {
        mutations.push(document);
        return { serviceDelete: true };
      }
      throw new Error(`Unexpected Railway request: ${operation}`);
    });
    (railway as unknown as { client: { request: typeof request } }).client = { request };
    hostingAdapter = railway;
  }

  vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '4');
  vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
  const adapter = createRailwayDatabaseAdapter({
    hostingAdapter: hostingAdapter as never,
    envRepo: {
      findById: () => makeEnvironment({ projectId: 'rail-project', environmentId: 'rail-env' }),
    } as never,
  });
  return {
    adapter,
    mutations: () => mutations,
    observations: () => observations,
  };
}

const providers: Array<{
  displayName: string;
  provider: string;
  setup(scenario: DatabaseLifecycleParityScenario): Promise<DatabaseLifecycleParityFixture>;
  platformBindings?: Record<string, unknown>;
  componentBindings?: Record<string, unknown>;
}> = [
  {
    displayName: 'Railway',
    provider: 'railway',
    setup: setupRailway,
    platformBindings: { projectId: 'rail-project', environmentId: 'rail-env' },
    componentBindings: {
      providerScope: { projectId: 'rail-project' },
      resourceKind: 'service',
    },
  },
  {
    displayName: 'Supabase',
    provider: 'supabase',
    setup: setupSupabase,
    componentBindings: {
      providerScope: { organizationId: 'org-1', region: 'us-east-1' },
    },
  },
  {
    displayName: 'Cloud SQL',
    provider: 'cloudsql',
    setup: setupCloudSql,
    componentBindings: {
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
    },
  },
  {
    displayName: 'Amazon RDS',
    provider: 'rds',
    setup: setupRds,
    platformBindings: {
      provider: 'ecs',
      projectId: 'arn:aws:ecs:us-west-2:123456789012:cluster/hv-parity-production',
      environmentId: 'arn:aws:ecs:us-west-2:123456789012:cluster/hv-parity-production',
      services: {},
    },
    componentBindings: {
      providerScope: { accountId: '123456789012', region: 'us-west-2' },
    },
  },
  {
    displayName: 'Fly Managed Postgres',
    provider: 'fly',
    setup: setupFly,
    componentBindings: { organizationSlug: 'hypervibe-test' },
  },
];

for (const provider of providers) {
  runDatabaseProviderParityContract({
    displayName: provider.displayName,
    externalIds: EXTERNAL_IDS,
    resourceName: RESOURCE_NAME,
    makeEnvironment: () => makeEnvironment(provider.platformBindings),
    makeComponent: (externalId) => makeComponent(
      provider.provider,
      externalId,
      provider.componentBindings
    ),
    setup: provider.setup,
  });
}
