import { describe, expect, it } from 'vitest';
import { bindingIdentityFingerprint } from '../binding-identity.js';

describe('bindingIdentityFingerprint', () => {
  it('is stable across key order and credential rotation', () => {
    const first = bindingIdentityFingerprint({
      provider: 'railway',
      volumeId: 'volume-1',
      providerScope: { projectId: 'project-1', environmentId: 'environment-1' },
      password: 'first-secret',
      connectionString: 'postgres://user:first-secret@example.invalid/app',
      pooledUrl: 'postgres://user:first-secret@pool.example.invalid/app',
    });
    const second = bindingIdentityFingerprint({
      pooledUrl: 'postgres://user:second-secret@pool.example.invalid/app',
      connectionString: 'postgres://user:second-secret@example.invalid/app',
      password: 'second-secret',
      providerScope: { environmentId: 'environment-1', projectId: 'project-1' },
      volumeId: 'volume-1',
      provider: 'railway',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['volumeId', { volumeId: 'volume-2' }],
    ['securityGroupId', { securityGroupId: 'sg-2' }],
    ['ownership flag', { securityGroupManagedByHypervibe: false }],
    ['resource kind', { resourceKind: 'volume-only' }],
  ])('changes when the destructive %s changes', (_label, patch) => {
    const base = {
      provider: 'rds',
      volumeId: 'volume-1',
      securityGroupId: 'sg-1',
      securityGroupManagedByHypervibe: true,
      resourceKind: 'postgres',
      providerScope: { accountId: '123456789012', region: 'us-west-2' },
    };

    expect(bindingIdentityFingerprint({ ...base, ...patch }))
      .not.toBe(bindingIdentityFingerprint(base));
  });
});
