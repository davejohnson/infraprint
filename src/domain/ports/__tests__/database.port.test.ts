import { describe, expect, it } from 'vitest';
import {
  createUnresolvedDatastoreMutation,
  databaseCreateMayHaveCommitted,
  parseUnresolvedDatastoreMutation,
} from '../database.port.js';

describe('unresolved datastore create contract', () => {
  it('round-trips only a complete exact name/scope marker', () => {
    expect(() => createUnresolvedDatastoreMutation(
      'database',
      'app-production-postgres',
      {}
    )).toThrow('complete provider scope');
  });

  it('parses a complete cache marker and rejects a kind mismatch', () => {
    const marker = createUnresolvedDatastoreMutation(
      'cache',
      'app-production-redis',
      { projectId: 'project-1', environmentId: 'environment-1' }
    );
    const bindings = { unresolvedMutation: marker };

    expect(parseUnresolvedDatastoreMutation(bindings, 'cache')).toEqual(marker);
    expect(parseUnresolvedDatastoreMutation(bindings, 'database')).toBeNull();
  });

  it.each([
    [{ status: 400 }, false],
    [{ status: 404 }, false],
    [{ status: 408 }, true],
    [{ status: 500 }, true],
    [{ $metadata: { httpStatusCode: 503 } }, true],
    [new Error('socket closed after request transmission'), true],
  ] as const)('classifies provider create outcomes without treating timeout as rejection', (error, expected) => {
    expect(databaseCreateMayHaveCommitted(error)).toBe(expected);
  });
});
