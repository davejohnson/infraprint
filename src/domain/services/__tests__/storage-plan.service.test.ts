import { describe, expect, it } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { parseStorageBindings, planStorage, storageEnvKeys } from '../storage-plan.service.js';

const spec = environmentSpecSchema.parse({
  hosting: { provider: 'railway' }, services: { api: {} },
  storage: { uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api'] } },
});

function env(platformBindings: Record<string, unknown> = {}): Environment {
  return {
    id: 'local-env',
    projectId: 'project',
    name: 'staging',
    platformBindings: { services: { api: { serviceId: 'svc' } }, ...platformBindings },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function observed(
  storage: ObservedState['storage'] = [],
  envVarKeys: string[] = [],
  services: ObservedState['services'] = [{
    name: 'api', externalId: 'svc', workloadKind: 'web', customDomains: [], config: {},
    envVarKeys, envVarHashes: {}, status: 'running',
  }]
): ObservedState {
  return {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'rp', environmentId: 're', databases: [], partial: false, warnings: [], storage,
    services,
  };
}

describe('storage-plan.service', () => {
  it('presents legacy storage bindings with their provider instance scope', () => {
    const environment = env({
      storageProviders: { railway: { projectId: 'rp', environmentId: 're' } },
      storage: {
        uploads: {
          provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: [], envKeys: [],
        },
      },
    });

    expect(parseStorageBindings(environment).uploads).toMatchObject({
      externalId: 'bucket-1',
      instanceScope: { projectId: 'rp', environmentId: 're' },
    });
  });

  it('preserves provider-native scope fields for non-Railway storage identities', () => {
    const environment = env({
      storageProviders: {
        s3: { accountId: 'aws-account', region: 'us-west-2' },
        gcs: { projectId: 'gcp-project', location: 'northamerica-northeast1' },
        azureblob: {
          subscriptionId: 'azure-subscription',
          resourceGroup: 'app-production',
          storageAccount: 'appdocuments',
        },
      },
      storage: {
        awsDocuments: { provider: 's3', externalId: 'aws-bucket', region: 'us-west-2', services: [], envKeys: [] },
        gcpDocuments: { provider: 'gcs', externalId: 'gcp-bucket', region: 'northamerica-northeast1', services: [], envKeys: [] },
        azureDocuments: { provider: 'azureblob', externalId: 'documents', region: 'westus2', services: [], envKeys: [] },
      },
    });

    const bindings = parseStorageBindings(environment);
    expect(bindings.awsDocuments.instanceScope).toEqual({ accountId: 'aws-account', region: 'us-west-2' });
    expect(bindings.gcpDocuments.instanceScope).toEqual({ projectId: 'gcp-project', location: 'northamerica-northeast1' });
    expect(bindings.azureDocuments.instanceScope).toEqual({
      subscriptionId: 'azure-subscription',
      resourceGroup: 'app-production',
      storageAccount: 'appdocuments',
    });
  });

  it('preserves a binding scope when the current provider context changes', () => {
    const environment = env({
      storageProviders: { railway: { projectId: 'new-project', environmentId: 'new-environment' } },
      storage: {
        uploads: {
          provider: 'railway',
          externalId: 'bucket-1',
          instanceScope: { projectId: 'original-project', environmentId: 'original-environment' },
          region: 'sjc',
          services: [],
          envKeys: [],
        },
      },
    });

    expect(parseStorageBindings(environment).uploads.instanceScope).toEqual({
      projectId: 'original-project',
      environmentId: 'original-environment',
    });
  });

  it('uses the standard AWS S3 runtime variable contract', () => {
    expect(storageEnvKeys('uploads')).toEqual([
      'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_S3_BUCKET_NAME', 'AWS_DEFAULT_REGION', 'AWS_S3_URL_STYLE',
    ]);
  });
  it('plans bucket creation before explicit service wiring', () => {
    const result = planStorage({ environmentSpec: spec, environment: env(), observed: observed() });
    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({ type: 'create', billable: true });
    expect(result.actions.find((item) => item.id === 'storage:uploads:wiring:api')).toMatchObject({
      type: 'update',
      dependsOn: ['storage:uploads', 'service:api'],
      metadata: expect.objectContaining({ serviceId: 'svc' }),
    });
  });

  it('marks create-then-wire service identity as pending behind the service dependency', () => {
    const result = planStorage({
      environmentSpec: spec,
      environment: env({ services: {} }),
      observed: observed([], [], []),
    });
    expect(result.actions.find((item) => item.id === 'storage:uploads:wiring:api')).toMatchObject({
      type: 'update',
      dependsOn: ['storage:uploads', 'service:api'],
      metadata: expect.objectContaining({ serviceIdPending: true }),
    });
  });

  it('does not silently adopt a same-name live bucket', () => {
    const result = planStorage({
      environmentSpec: spec,
      environment: env(),
      observed: observed([{ provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'sjc', status: 'ready' }]),
    });
    expect(result.actions[0]).toMatchObject({ type: 'update', metadata: expect.objectContaining({ blockedReason: 'unmanaged_conflict' }) });
    expect(result.unmanaged).toContainEqual(expect.objectContaining({ name: 'uploads' }));
  });

  it('reports every duplicate same-name bucket as an ambiguous adoption candidate', () => {
    const result = planStorage({
      environmentSpec: spec,
      environment: env(),
      observed: observed([
        { provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'sjc', status: 'ready' },
        { provider: 'railway', kind: 'object', externalId: 'bucket-2', name: 'uploads', region: 'sjc', status: 'ready' },
      ]),
    });
    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({
        blockedReason: 'ambiguous_storage_identity',
        externalIds: ['bucket-1', 'bucket-2'],
      }),
    });
    expect(result.unmanaged.filter((item) => item.name === 'uploads')).toHaveLength(2);
  });

  it('blocks immutable region drift and reports wiring in sync by key presence', () => {
    const environment = env({ storage: { uploads: { provider: 'railway', externalId: 'bucket-1', region: 'iad', services: ['api'], envKeys: storageEnvKeys('uploads') } } });
    const result = planStorage({
      environmentSpec: spec,
      environment,
      observed: observed([{ provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'iad', status: 'ready' }], storageEnvKeys('uploads')),
    });
    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({ metadata: expect.objectContaining({ blockedReason: 'immutable_region' }) });
    expect(result.actions.find((item) => item.id.endsWith('wiring:api'))?.type).toBe('noop');
  });

  it.each([
    ['missing', undefined],
    ['different', { projectId: 'other-project', environmentId: 're' }],
  ])('blocks replacement when a bound bucket live scope is %s', (_label, liveScope) => {
    const environment = env({
      storage: {
        uploads: {
          provider: 'railway',
          externalId: 'bucket-1',
          instanceScope: { projectId: 'rp', environmentId: 're' },
          region: 'sjc',
          services: ['api'],
          envKeys: storageEnvKeys('uploads'),
        },
      },
    });
    const result = planStorage({
      environmentSpec: spec,
      environment,
      observed: observed([{
        provider: 'railway',
        kind: 'object',
        externalId: 'bucket-1',
        ...(liveScope ? { instanceScope: liveScope } : {}),
        name: 'uploads',
        region: 'sjc',
        status: 'ready',
      }]),
    });

    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({ blockedReason: 'storage_binding_identity_mismatch' }),
    });
    expect(result.actions.some((item) => item.id === 'storage:uploads' && item.type === 'create')).toBe(false);
  });

  it('blocks replacement when the bound bucket is absent from a known observation', () => {
    const environment = env({
      storage: {
        uploads: {
          provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: [], envKeys: [],
        },
      },
    });
    const result = planStorage({ environmentSpec: spec, environment, observed: observed([]) });

    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({ blockedReason: 'storage_binding_identity_mismatch' }),
    });
    expect(result.actions.some((item) => item.id === 'storage:uploads' && item.type === 'create')).toBe(false);
  });

  it('uses the bound service id when same-name service observations disagree on wiring', () => {
    const environment = env({
      storage: {
        uploads: {
          provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: ['api'],
          envKeys: storageEnvKeys('uploads'),
        },
      },
    });
    const replacement = {
      name: 'api', externalId: 'svc-replacement', workloadKind: 'web' as const, customDomains: [], config: {},
      envVarKeys: storageEnvKeys('uploads'), envVarHashes: {}, status: 'running' as const,
    };
    const bound = {
      name: 'api', externalId: 'svc', workloadKind: 'web' as const, customDomains: [], config: {},
      envVarKeys: [], envVarHashes: {}, status: 'running' as const,
    };
    const result = planStorage({
      environmentSpec: spec,
      environment,
      observed: observed(
        [{ provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'sjc', status: 'ready' }],
        [],
        [replacement, bound]
      ),
    });

    expect(result.actions.find((item) => item.id === 'storage:uploads:wiring:api')).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({ serviceId: 'svc' }),
    });
  });

  it('blocks storage wiring when only a same-name service replacement is observed', () => {
    const environment = env({
      services: { api: { serviceId: 'svc-original' } },
      storage: {
        uploads: {
          provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: ['api'],
          envKeys: storageEnvKeys('uploads'),
        },
      },
    });
    const replacement = {
      name: 'api', externalId: 'svc-replacement', workloadKind: 'web' as const, customDomains: [], config: {},
      envVarKeys: storageEnvKeys('uploads'), envVarHashes: {}, status: 'running' as const,
    };
    const result = planStorage({
      environmentSpec: spec,
      environment,
      observed: observed(
        [{ provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'sjc', status: 'ready' }],
        [],
        [replacement]
      ),
    });

    expect(result.actions.find((item) => item.id === 'storage:uploads:wiring:api')).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({
        blockedReason: 'service_binding_identity_mismatch',
        serviceId: 'svc-original',
      }),
    });
  });

  it('requires an explicit data migration before changing a bound storage provider', () => {
    const targetSpec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' },
      services: { api: {} },
      storage: { uploads: { provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: ['api'] } },
    });
    const environment = env({
      storageProviders: { railway: { projectId: 'rp', environmentId: 're' } },
      storage: {
        uploads: {
          provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: ['api'],
          envKeys: storageEnvKeys('uploads'),
        },
      },
    });

    const result = planStorage({ environmentSpec: targetSpec, environment, observed: observed() });

    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({
      type: 'update',
      metadata: expect.objectContaining({ blockedReason: 'provider_migration_required' }),
      reason: expect.stringContaining('dataMigration'),
    });
  });

  it('confirmation-gates managed bucket deletion after unwiring', () => {
    const withoutStorage = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { api: {} } });
    const environment = env({
      storageProviders: { railway: { projectId: 'rp', environmentId: 're' } },
      storage: { uploads: { provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: ['api'], envKeys: storageEnvKeys('uploads') } },
    });
    const result = planStorage({ environmentSpec: withoutStorage, environment, observed: observed() });
    expect(result.actions.find((item) => item.id === 'storage:uploads:destroy')).toMatchObject({
      type: 'destroy', dataBearing: true, requiresConfirm: true, dependsOn: ['storage:uploads:unwiring:api'],
      metadata: expect.objectContaining({
        externalId: 'bucket-1',
        instanceScope: { projectId: 'rp', environmentId: 're' },
      }),
    });
  });

  it('blocks only the removed storage provider whose inventory is unknown', () => {
    const withoutStorage = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { api: {} } });
    const environment = env({
      storageProviders: {
        s3: { accountId: 'aws-account', region: 'us-west-2' },
        gcs: { projectId: 'gcp-project', location: 'us-west1' },
      },
      storage: {
        archives: { provider: 's3', externalId: 'archives', region: 'us-west-2', services: [], envKeys: [] },
        reports: { provider: 'gcs', externalId: 'reports', region: 'us-west1', services: [], envKeys: [] },
      },
    });
    const live = observed([{
      provider: 'gcs',
      kind: 'object',
      externalId: 'reports',
      instanceScope: { projectId: 'gcp-project', location: 'us-west1' },
      name: 'reports',
      region: 'us-west1',
      status: 'ready',
    }]);
    live.completeness = {
      storage: 'unknown',
      storageByProvider: { s3: 'unknown', gcs: 'complete' },
    };

    const result = planStorage({ environmentSpec: withoutStorage, environment, observed: live });

    expect(result.actions.find((item) => item.id === 'storage:archives:observation-blocked')).toMatchObject({
      type: 'update',
      verified: false,
      metadata: expect.objectContaining({ blockedReason: 'storage_observation_unknown' }),
    });
    expect(result.actions.find((item) => item.id === 'storage:archives:destroy')).toBeUndefined();
    expect(result.actions.find((item) => item.id === 'storage:reports:destroy')).toMatchObject({
      type: 'destroy',
      verified: true,
    });
  });
});
