import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, queueSpecSchema } from '../spec.schema.js';

function envWithQueues(overrides: Record<string, unknown> = {}) {
  return environmentSpecSchema.safeParse({
    hosting: { provider: 'railway' },
    queues: { 'email-jobs': {} },
    ...overrides,
  });
}

describe('queueSpecSchema', () => {
  it('accepts an empty queue spec and one with ackDeadlineSeconds in range', () => {
    expect(queueSpecSchema.safeParse({}).success).toBe(true);
    expect(queueSpecSchema.safeParse({ ackDeadlineSeconds: 10 }).success).toBe(true);
    expect(queueSpecSchema.safeParse({ ackDeadlineSeconds: 600 }).success).toBe(true);
  });

  it('rejects ackDeadlineSeconds out of bounds', () => {
    expect(queueSpecSchema.safeParse({ ackDeadlineSeconds: 9 }).success).toBe(false);
    expect(queueSpecSchema.safeParse({ ackDeadlineSeconds: 601 }).success).toBe(false);
    expect(queueSpecSchema.safeParse({ ackDeadlineSeconds: 30.5 }).success).toBe(false);
  });

  it('is strict: unknown keys are rejected', () => {
    expect(queueSpecSchema.safeParse({ retention: '7d' }).success).toBe(false);
  });
});

describe('environmentSpecSchema queues', () => {
  it('accepts valid queue names', () => {
    const result = envWithQueues({
      database: { provider: 'railway' },
      queues: { 'email-jobs': {}, a: {}, 'q2-with-digits': {} },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid queue names', () => {
    for (const bad of ['Bad_Name', '9lead']) {
      const result = envWithQueues({
        database: { provider: 'railway' },
        queues: { [bad]: {} },
      });
      expect(result.success, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it('leaves provider-owned queue/database constraints to registry validation', () => {
    const result = envWithQueues();
    expect(result.success).toBe(true);
  });

  it('accepts railway queues when a database is declared', () => {
    const result = envWithQueues({ database: { provider: 'railway' } });
    expect(result.success).toBe(true);
  });

  it('accepts cloudrun queues without a database', () => {
    const result = envWithQueues({ hosting: { provider: 'cloudrun' } });
    expect(result.success).toBe(true);
  });
});
