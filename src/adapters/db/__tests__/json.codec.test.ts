import { describe, expect, it } from 'vitest';
import { parseJsonColumn } from '../json.codec.js';
import {
  buildConfigColumnSchema,
  componentBindingsColumnSchema,
  platformBindingsColumnSchema,
  runReceiptsColumnSchema,
} from '../column.schemas.js';

describe('parseJsonColumn', () => {
  it('parses valid JSON through the schema', () => {
    const result = parseJsonColumn(
      buildConfigColumnSchema,
      JSON.stringify({ startCommand: 'npm start', public: true }),
      'test'
    );
    expect(result).toEqual({ startCommand: 'npm start', public: true });
  });

  it('preserves the complete reviewed runtime build contract', () => {
    expect(parseJsonColumn(
      buildConfigColumnSchema,
      JSON.stringify({
        runtime: {
          kind: 'node',
          version: '24',
          installCommand: 'npm install --global npm@11.19.0 && npm ci',
          buildCommand: 'npm run build',
        },
      }),
      'test'
    )).toMatchObject({
      runtime: {
        kind: 'node',
        version: '24',
        installCommand: 'npm install --global npm@11.19.0 && npm ci',
        buildCommand: 'npm run build',
      },
    });
  });

  it('preserves unknown keys (passthrough)', () => {
    const result = parseJsonColumn(
      componentBindingsColumnSchema,
      JSON.stringify({ host: 'db.example.com', customKey: 'kept' }),
      'test'
    );
    expect(result).toEqual({ host: 'db.example.com', customKey: 'kept' });
  });

  it('blocks on corrupt JSON instead of turning unknown state into an empty value', () => {
    expect(() => parseJsonColumn(buildConfigColumnSchema, '{not json', 'test'))
      .toThrow('refuses to treat unreadable state as empty');
    expect(() => parseJsonColumn(runReceiptsColumnSchema, '{not json', 'test'))
      .toThrow('refuses to treat unreadable state as empty');
  });

  it('blocks on schema mismatch', () => {
    // build_config must be an object, not an array
    expect(() => parseJsonColumn(buildConfigColumnSchema, '[1,2,3]', 'test'))
      .toThrow('persisted JSON has an invalid shape');
  });

  it('falls back to default on null/empty input', () => {
    expect(parseJsonColumn(buildConfigColumnSchema, null, 'test')).toEqual({});
    expect(parseJsonColumn(buildConfigColumnSchema, '', 'test')).toEqual({});
    expect(parseJsonColumn(runReceiptsColumnSchema, undefined, 'test')).toEqual([]);
  });

  it('rejects wrong field types inside known keys', () => {
    expect(() => parseJsonColumn(buildConfigColumnSchema, JSON.stringify({ public: 'yes' }), 'test'))
      .toThrow('persisted JSON has an invalid shape');
  });

  it('rejects malformed hosting identities without rejecting provider-specific bindings', () => {
    expect(() => parseJsonColumn(
      platformBindingsColumnSchema,
      JSON.stringify({ provider: 42, projectId: 'project-1' }),
      'environments.platform_bindings'
    )).toThrow('refuses to treat unreadable state as empty');
    expect(() => parseJsonColumn(
      platformBindingsColumnSchema,
      JSON.stringify({
        provider: 'railway',
        projectId: 'project-1',
        services: { web: { serviceId: 'service-1' } },
        railwayEnvironmentName: 'production',
        providerRuntime: { arbitrary: ['passthrough', 1] },
      }),
      'environments.platform_bindings'
    )).not.toThrow();
  });
});
