import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const genericOrchestrationFiles: Array<[string, URL]> = [
  ['src/domain/plan/diff.engine.ts', new URL('../../domain/plan/diff.engine.ts', import.meta.url)],
  ['src/domain/plan/plan.service.ts', new URL('../../domain/plan/plan.service.ts', import.meta.url)],
  ['src/application/apply-plan.ts', new URL('../../application/apply-plan.ts', import.meta.url)],
  ['src/tools/hv-ci.tools.ts', new URL('../hv-ci.tools.ts', import.meta.url)],
];

const commandRegistrySource = readFileSync(
  new URL('../../application/commands.ts', import.meta.url),
  'utf8'
);
const registeredCommandModules = Array.from(
  commandRegistrySource.matchAll(/from ['"]\.\.\/tools\/([^'"]+\.tools)\.js['"]/g),
  (match) => [
    `src/tools/${match[1]}.ts`,
    new URL(`../${match[1]}.ts`, import.meta.url),
  ] as const
);

const interfaceModules: Array<[string, URL]> = [
  ['src/interfaces/cli/parser.ts', new URL('../../interfaces/cli/parser.ts', import.meta.url)],
  ['src/interfaces/cli/run.ts', new URL('../../interfaces/cli/run.ts', import.meta.url)],
  ['src/interfaces/mcp/adapter.ts', new URL('../../interfaces/mcp/adapter.ts', import.meta.url)],
];

const providerNeutralHostingServices: Array<[string, URL]> = [
  ['src/domain/services/hosting-env.service.ts', new URL('../../domain/services/hosting-env.service.ts', import.meta.url)],
  ['src/domain/services/deploy-source.ts', new URL('../../domain/services/deploy-source.ts', import.meta.url)],
  ['src/domain/services/bootstrap.service.ts', new URL('../../domain/services/bootstrap.service.ts', import.meta.url)],
];

const providerApiMarkers = [
  'environmentUnskipService',
  'serviceInstanceDeployV2',
  'backboard.railway.app',
  'Service Instance not found',
  'Railway API 400',
  'RAILWAY_SERVICE_INSTANCE_MISSING',
  'RAILWAY_DEPLOY_POLLING_GRAPHQL_400',
];

const hostingProviderBranches = [
  /provider\s*={2,3}\s*['"](railway|cloudrun)['"]/,
  /provider\s*!={1,2}\s*['"](railway|cloudrun)['"]/,
  /case\s+['"](railway|cloudrun)['"]/,
];

describe('provider boundary architecture', () => {
  it('keeps hosted committed-spec inspection pure and read-only', () => {
    const source = readFileSync(
      new URL('../../application/hosted/committed-spec-inspection.ts', import.meta.url),
      'utf8'
    );

    expect(source).not.toContain('/adapters/');
    expect(source).not.toContain('repo-spec-file');
    expect(source).not.toContain('child_process');
    expect(source).not.toMatch(/\b(?:readFile|writeFile|fetch)\b/);
  });

  it('keeps command declarations transport-neutral', () => {
    expect(registeredCommandModules.length).toBeGreaterThan(0);
    for (const [label, url] of registeredCommandModules) {
      const source = readFileSync(url, 'utf8');
      expect(source, `${label} must not import MCP`).not.toContain('@modelcontextprotocol');
      expect(source, `${label} must register commands, not MCP-shaped tools`).not.toContain('server.tool(');
    }
  });

  it('keeps provider implementations behind the registered command boundary', () => {
    for (const [label, url] of registeredCommandModules) {
      const source = readFileSync(url, 'utf8');
      expect(source, `${label} must route provider behavior through ports, registries, or services`)
        .not.toContain('/adapters/providers/');
    }
  });

  it('keeps Railway implementation details out of the registered command surface', () => {
    for (const [label, url] of registeredCommandModules) {
      const source = readFileSync(url, 'utf8');
      expect(source, `${label} must route providers through capabilities, not Railway shortcuts`).not.toMatch(/railway/i);
    }
  });

  it('keeps generic lifecycle selectors and routing provider-neutral', () => {
    const source = readFileSync(new URL('../lifecycle.tools.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('/adapters/providers/');
    expect(source).not.toMatch(/railwayProjectId|cloudrunProjectId|githubRepositoryId/i);
    expect(source).not.toMatch(/provider:\s*z\.(?:enum|literal)\(/);
  });

  it('keeps interface adapters free of provider implementations and command orchestration', () => {
    for (const [label, url] of interfaceModules) {
      const source = readFileSync(url, 'utf8');
      expect(source, `${label} must not import provider implementations`).not.toContain('/adapters/providers/');
      expect(source, `${label} must not import historical command modules`).not.toContain('/tools/');
    }
  });

  it('keeps provider API details out of generic orchestration files', () => {
    for (const [label, url] of genericOrchestrationFiles) {
      const source = readFileSync(url, 'utf8');
      for (const marker of providerApiMarkers) {
        expect(source, `${label} should not contain provider API marker ${marker}`).not.toContain(marker);
      }
    }
  });

  it('keeps hosting-provider branches out of the pure diff engine', () => {
    const source = readFileSync(new URL('../../domain/plan/diff.engine.ts', import.meta.url), 'utf8');
    for (const branchPattern of hostingProviderBranches) {
      expect(source, `diff.engine.ts should use providerBehavior metadata instead of ${branchPattern}`).not.toMatch(branchPattern);
    }
  });

  it('keeps hosting env and source orchestration behind provider-neutral ports', () => {
    const literalProviderBranch = /\b(?:provider|adapterName)\s*(?:===|!==|==|!=)\s*['"][^'"]+['"]/;
    const literalAdapterNameBranch = /\bhostingAdapter\.name\s*(?:===|!==|==|!=)\s*['"][^'"]+['"]/;
    for (const [label, url] of providerNeutralHostingServices) {
      const source = readFileSync(url, 'utf8');
      expect(source, `${label} must not import a concrete provider adapter`)
        .not.toContain('/adapters/providers/');
      expect(source, `${label} must not select behavior by provider id`)
        .not.toMatch(literalProviderBranch);
      expect(source, `${label} must not select behavior by adapter name`)
        .not.toMatch(literalAdapterNameBranch);
    }
  });
});
