import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { Run } from '../../entities/run.entity.js';
import { withReceiptValidatedManagedSecretBindings } from '../managed-secret-binding-receipts.js';

const now = new Date('2026-09-08T00:00:00.000Z');

function environmentWithBinding(): Environment {
  return {
    id: 'environment-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {
      delegatedEnvBindings: [{
        name: 'SESSION_SECRET',
        principal: 'hypervibe',
        valueHash: 'sha256-value',
        source: 'hypervibe-generated',
        generator: 'random-base64url-32-v1',
        generation: 1,
        syncedAt: now.toISOString(),
        applyRunId: 'apply-1',
        actionId: 'secret:SESSION_SECRET',
      }],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function applyRun(receiptStatus?: 'success' | 'failure'): Run {
  return {
    id: 'apply-1',
    projectId: 'project-1',
    environmentId: 'environment-1',
    type: 'apply',
    status: receiptStatus === 'success' ? 'succeeded' : 'failed',
    plan: {},
    receipts: receiptStatus ? [{
      step: 'secret:SESSION_SECRET',
      status: receiptStatus,
      timestamp: now.toISOString(),
    }] : [],
    error: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
  };
}

describe('managed secret binding receipt validation', () => {
  it('omits a binding whose known local apply lacks a successful action receipt', () => {
    const environment = environmentWithBinding();
    const findById = vi.fn(() => applyRun('failure'));

    const validated = withReceiptValidatedManagedSecretBindings(environment, { findById });

    expect(validated?.platformBindings.delegatedEnvBindings).toEqual([]);
    expect(environment.platformBindings.delegatedEnvBindings).toHaveLength(1);
  });

  it('keeps a binding with an exact successful local action receipt', () => {
    const environment = environmentWithBinding();
    const findById = vi.fn(() => applyRun('success'));

    expect(withReceiptValidatedManagedSecretBindings(environment, { findById })).toBe(environment);
  });

  it('does not accept an unrelated successful receipt from the same apply', () => {
    const environment = environmentWithBinding();
    const run = applyRun('success');
    run.receipts[0].step = 'service:web';

    const validated = withReceiptValidatedManagedSecretBindings(environment, {
      findById: vi.fn(() => run),
    });

    expect(validated?.platformBindings.delegatedEnvBindings).toEqual([]);
  });

  it('keeps a repository-shared binding when its apply run is not local', () => {
    const environment = environmentWithBinding();
    const findById = vi.fn(() => null);

    expect(withReceiptValidatedManagedSecretBindings(environment, { findById })).toBe(environment);
  });
});
