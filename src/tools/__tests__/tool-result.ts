import type { ToolEnvelope } from '../../application/results.js';
import { expect } from 'vitest';

export function parseToolEnvelope(result: unknown): ToolEnvelope {
  const record = result && typeof result === 'object'
    ? result as { structuredContent?: unknown; content?: unknown }
    : {};
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    return record.structuredContent as ToolEnvelope;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const jsonEntry = content.find((entry) =>
    Boolean(entry)
    && typeof entry === 'object'
    && 'text' in entry
    && typeof (entry as { text?: unknown }).text === 'string'
    && (entry as { text: string }).text.trim().startsWith('{')
  ) as { text: string } | undefined;
  const jsonText = jsonEntry?.text;
  if (!jsonText) {
    throw new Error('Tool result did not include a structured Hypervibe envelope.');
  }
  return JSON.parse(jsonText) as ToolEnvelope;
}

export function expectActionableConnectionSetup(
  value: unknown,
  expected: { provider: string; project?: string; scope?: string; setupUrl?: boolean }
): Record<string, any> {
  const candidates = Array.isArray(value) ? value : [value];
  const setup = candidates.find((candidate) => (
    candidate && typeof candidate === 'object' && (candidate as { provider?: unknown }).provider === expected.provider
  )) as Record<string, any> | undefined;

  expect(setup).toBeDefined();
  expect(setup).toMatchObject({
    provider: expected.provider,
    ...(expected.project ? { project: expected.project } : {}),
    ...(expected.scope ? { scope: expected.scope } : {}),
  });
  expect(setup!.tokenType).toEqual(expect.any(String));
  expect(setup!.requiredPermissions.length).toBeGreaterThan(0);
  expect(setup!.credentialExample).toContain(`hv_connections `);
  expect(setup!.credentialExample).toContain(`provider="${expected.provider}"`);
  expect(setup!.credentialExample).toMatch(/credentials(?:Ref)?=/);
  if (expected.project) expect(setup!.credentialExample).toContain(`project="${expected.project}"`);
  if (expected.setupUrl !== false) {
    expect(setup!.recommendedSetupUrl).toMatch(/^https:\/\//);
    expect(setup!.setupUrls).toEqual(expect.arrayContaining([
      expect.stringContaining(setup!.recommendedSetupUrl),
    ]));
  }
  return setup!;
}
