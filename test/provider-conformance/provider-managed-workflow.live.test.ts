import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import '../../src/application/providers.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import { supportsWorkloadMaintenance } from '../../src/domain/ports/maintenance.port.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import {
  cacheProviderContracts,
  databaseProviderContracts,
  hostingProviderContracts,
  managedWorkflowGitHubCredentials,
  type HostingProviderContract,
  type ManagedWorkflowFixture,
  type ProviderCredentialField,
} from './provider-matrix.js';
import {
  actionIdsRequiringConfirmation,
  nonNoopActions,
  pendingInfrastructureReview,
  selectTriggeredWorkflowRun,
  terminalReceiptFailures,
  type JsonObject,
} from './managed-workflow-harness.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(repositoryRoot, 'dist/index.js');
const selectedProvider = process.env.HYPERVIBE_LIVE_MANAGED_HOSTING?.trim();
const liveDescribe = selectedProvider ? describe : describe.skip;
const REVIEW_POLL_MS = 10_000;
const WORKFLOW_POLL_MS = 10_000;

let contract: HostingProviderContract | undefined;
let workspace = '';
let dataDirectory = '';
let repository = '';
let projectName = '';
let commitSha = '';
let resourcesMayExist = false;

function positiveDuration(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds`);
  }
  return parsed;
}

function parseCredentialValue(
  credential: ProviderCredentialField,
  value: string
): unknown {
  try {
    if (credential.parseAs === 'json') return JSON.parse(value);
    if (credential.parseAs === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error('not a finite number');
      return parsed;
    }
    if (credential.parseAs === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('not true or false');
    }
    return value;
  } catch {
    throw new Error(
      `${credential.environmentVariable} must contain a valid ${
        credential.parseAs ?? 'string'
      } value`
    );
  }
}

function requiredCredentials(
  fields: ProviderCredentialField[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const credential of fields) {
    const value = process.env[credential.environmentVariable];
    if (value === undefined || value.length === 0) {
      if (!credential.optional) missing.push(credential.environmentVariable);
      continue;
    }
    output[credential.field] = parseCredentialValue(credential, value);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing live-provider credential environment variables: ${missing.join(', ')}`
    );
  }
  return output;
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(
        `${executable} ${args.join(' ')} failed (exit ${code}): ${stderr.slice(0, 2000)}`
      ));
    });
  });
}

async function runHypervibe(
  command: string[],
  input: JsonObject
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, ...command, '--input', '-', '--json'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HYPERVIBE_DATA_DIR: dataDirectory,
          HYPERVIBE_DISABLE_REPO_SPEC: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      let envelope: JsonObject;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new Error(
          `Hypervibe ${command.join(' ')} returned non-JSON output (exit ${code}). `
          + `${stderr.slice(0, 2000)} ${stdout.slice(0, 2000)}`
        ));
        return;
      }
      if (code !== 0 || envelope.ok !== true) {
        reject(new Error(
          `Hypervibe ${command.join(' ')} failed (exit ${code}): `
          + JSON.stringify(envelope.error ?? envelope).slice(0, 4000)
        ));
        return;
      }
      resolve(envelope);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function connectProvider(
  provider: string,
  credentials: ProviderCredentialField[],
  scope?: string
): Promise<void> {
  const credentialPath = path.join(
    dataDirectory,
    `.credentials-${provider}-${process.pid}.json`
  );
  writeFileSync(
    credentialPath,
    JSON.stringify(requiredCredentials(credentials)),
    { encoding: 'utf8', mode: 0o600 }
  );
  chmodSync(credentialPath, 0o600);
  try {
    await runHypervibe(['connect'], {
      provider,
      credentialsRef: `file:${credentialPath}`,
      ...(scope ? { scope } : {}),
    });
  } finally {
    rmSync(credentialPath, { force: true });
  }
}

function fixtureSpec(params: {
  revision?: string;
  includeService?: boolean;
}): JsonObject {
  if (!contract?.managedWorkflow) {
    throw new Error('Managed workflow fixture is unavailable');
  }
  const fixture = contract.managedWorkflow;
  return projectSpecSchema.parse({
    version: 1,
    project: projectName,
    gitRemoteUrl: `https://github.com/${repository}.git`,
    environments: {
      [fixture.environmentName]: {
        hosting: { provider: contract.provider },
        services: params.includeService === false
          ? {}
          : {
              [fixture.serviceName]: fixture.service,
            },
        ...(params.includeService !== false && fixture.database
          ? { database: fixture.database }
          : {}),
        ...(params.includeService !== false && fixture.cache
          ? { cache: fixture.cache }
          : {}),
        email: { enabled: false },
        envVars: params.includeService === false
          ? {}
          : {
              HYPERVIBE_CONFORMANCE_REVISION: params.revision ?? 'create',
            },
        deploy: {
          strategy: 'branch',
          trigger: 'ci',
          branch: 'main',
          autoDeploy: false,
        },
      },
    },
  });
}

function datastoreConnectionProfiles(
  fixture: ManagedWorkflowFixture
): Array<{ provider: string; credentials: ProviderCredentialField[] }> {
  const profiles: Array<{
    provider: string;
    credentials: ProviderCredentialField[];
  }> = [];
  if (fixture.database) {
    const database = databaseProviderContracts.find((entry) => (
      entry.provider === fixture.database!.provider
      && entry.engine === fixture.database!.engine
    ));
    if (!database || database.status === 'planned') {
      throw new Error(
        `Managed workflow database ${fixture.database.provider}/${fixture.database.engine} is not ready for live use.`
      );
    }
    profiles.push(database);
  }
  if (fixture.cache) {
    const cache = cacheProviderContracts.find((entry) => (
      entry.provider === fixture.cache!.provider
      && entry.engine === fixture.cache!.engine
    ));
    if (!cache || cache.status === 'planned') {
      throw new Error(
        `Managed workflow cache ${fixture.cache.provider}/${fixture.cache.engine} is not ready for live use.`
      );
    }
    profiles.push(cache);
  }
  return profiles;
}

function expectedDestroyActionIds(
  fixture: ManagedWorkflowFixture
): string[] {
  return [
    `service:${fixture.serviceName}:destroy`,
    ...(fixture.database
      ? [`database:${fixture.database.provider}:destroy`]
      : []),
    ...(fixture.cache
      ? [`cache:${fixture.cache.provider}:destroy`]
      : []),
  ];
}

async function setSpec(spec: JsonObject): Promise<void> {
  await runHypervibe(['spec', 'set'], {
    project: projectName,
    replace: true,
    spec,
  });
}

async function plan(): Promise<JsonObject> {
  return runHypervibe(['plan'], {
    project: projectName,
    env: contract!.managedWorkflow!.environmentName,
    includeEnvFile: false,
  });
}

async function apply(planEnvelope: JsonObject): Promise<JsonObject> {
  return runHypervibe(['apply'], {
    project: projectName,
    planId: planEnvelope.data.planId,
    confirmActions: actionIdsRequiringConfirmation(planEnvelope),
  });
}

function assertPlanCanApply(planEnvelope: JsonObject): void {
  expect(planEnvelope.data.blocked ?? []).toEqual([]);
  expect(planEnvelope.data.inputRequired ?? []).toEqual([]);
  const mutations = nonNoopActions(planEnvelope);
  expect(
    mutations.filter((action) => action.verified !== true)
  ).toEqual([]);
}

function assertNoTerminalApplyFailure(applyEnvelope: JsonObject): void {
  expect(terminalReceiptFailures(applyEnvelope)).toEqual([]);
}

async function applyCurrentSpec(): Promise<{
  plan: JsonObject;
  apply: JsonObject;
}> {
  const planEnvelope = await plan();
  assertPlanCanApply(planEnvelope);
  return {
    plan: planEnvelope,
    apply: await apply(planEnvelope),
  };
}

async function convergeReviewedInfrastructure(
  initialApply: JsonObject
): Promise<JsonObject> {
  const timeoutMs = positiveDuration(
    'HYPERVIBE_LIVE_REVIEW_TIMEOUT_MS',
    30 * 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let currentApply = initialApply;
  let announcedUrl: string | undefined;

  while (true) {
    assertNoTerminalApplyFailure(currentApply);
    const review = pendingInfrastructureReview(currentApply);
    if (!review) {
      expect(currentApply.data.applied).toBe(true);
      return currentApply;
    }
    if (review.pullRequestUrl !== announcedUrl) {
      announcedUrl = review.pullRequestUrl;
      process.stdout.write(
        `\nHypervibe infrastructure review required: ${review.pullRequestUrl}\n`
        + 'Merge that PR after review; this live test will continue automatically.\n'
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for review of ${review.pullRequestUrl}. `
        + 'The harness will now attempt spec-driven provider cleanup.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REVIEW_POLL_MS));
    const next = await applyCurrentSpec();
    currentApply = next.apply;
  }
}

async function waitForWorkflowRun(
  triggeredAfterMs: number,
  existingRunIds: Set<number>
): Promise<JsonObject> {
  const fixture = contract!.managedWorkflow!;
  const timeoutMs = positiveDuration(
    'HYPERVIBE_LIVE_WORKFLOW_TIMEOUT_MS',
    30 * 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let run: JsonObject | null = null;

  while (Date.now() < deadline) {
    const status = await runHypervibe(['ci', 'status'], {
      project: projectName,
      repo: repository,
      include: ['runs'],
      workflow: fixture.workflow,
    });
    if (status.data.runs?.error) {
      throw new Error(
        `hv_ci_status could not inspect workflow runs: ${status.data.runs.error}`
      );
    }
    run = selectTriggeredWorkflowRun(status.data.runs ?? [], {
      existingRunIds,
      triggeredAfterMs,
    });
    if (run?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_POLL_MS));
  }

  if (!run || run.status !== 'completed') {
    throw new Error(
      `Timed out waiting for the new ${fixture.workflow} dispatch`
    );
  }

  const jobs = await runHypervibe(['ci', 'status'], {
    project: projectName,
    repo: repository,
    include: ['jobs'],
    runId: run.id,
  });
  if (jobs.data.jobs?.error) {
    throw new Error(
      `hv_ci_status could not inspect workflow jobs: ${jobs.data.jobs.error}`
    );
  }
  const unsuccessfulJobs = (jobs.data.jobs as JsonObject[] ?? [])
    .filter((job) => !['success', 'skipped'].includes(job.conclusion));
  if (run.conclusion !== 'success' || unsuccessfulJobs.length > 0) {
    const logs = await runHypervibe(['ci', 'status'], {
      project: projectName,
      repo: repository,
      include: ['logs'],
      runId: run.id,
      logLines: 200,
    });
    throw new Error(
      `Managed workflow ${run.id} failed: `
      + JSON.stringify({
        conclusion: run.conclusion,
        jobs: unsuccessfulJobs,
        logs: logs.data.logs,
        diagnostics: logs.data.diagnostics,
      }).slice(0, 12_000)
    );
  }

  const artifacts = await runHypervibe(['ci', 'status'], {
    project: projectName,
    repo: repository,
    include: ['artifacts'],
  });
  if (artifacts.data.artifacts?.error) {
    throw new Error(
      `hv_ci_status could not inspect release evidence: ${artifacts.data.artifacts.error}`
    );
  }
  expect(artifacts.data.artifacts).toContainEqual(
    expect.objectContaining({
      name:
        `hypervibe-server-release-${fixture.environmentName}-${commitSha}`,
      expired: false,
      workflowRun: expect.objectContaining({ id: run.id }),
    })
  );
  return run;
}

async function verifyHealth(): Promise<void> {
  const fixture = contract!.managedWorkflow!;
  const status = await runHypervibe(['status'], {
    project: projectName,
    env: fixture.environmentName,
  });
  const service = (status.data.services as JsonObject[] ?? [])
    .find((entry) => entry.name === fixture.serviceName);
  expect(service).toMatchObject({
    name: fixture.serviceName,
    status: 'running',
  });
  if (typeof service?.url !== 'string') {
    throw new Error(
      `hv_status returned no public URL for ${fixture.serviceName}`
    );
  }
  const publicUrl = new URL(service.url);
  expect(fixture.publicUrlProtocols).toContain(publicUrl.protocol);

  const health = await runHypervibe(['health'], {
    project: projectName,
    url: publicUrl.toString(),
    path: fixture.service.healthCheckPath,
    timeoutMs: 30_000,
  });
  expect(health.data.check).toMatchObject({ ok: true });
}

async function verifyOptInMaintenanceLifecycle(): Promise<void> {
  if (process.env.HYPERVIBE_LIVE_MAINTENANCE !== '1') return;
  const fixture = contract!.managedWorkflow!;
  if (contract!.maintenance === 'unsupported') {
    throw new Error(
      `${contract!.provider} does not expose a live-ready maintenance contract.`
    );
  }
  const bindingsPath = path.join(workspace, '.hypervibe/bindings.json');
  if (!existsSync(bindingsPath)) {
    throw new Error('The live maintenance scenario requires repo-backed provider bindings.');
  }
  const bindings = JSON.parse(readFileSync(bindingsPath, 'utf8')) as JsonObject;
  const platformBindings = bindings.environments?.[fixture.environmentName]
    ?.platformBindings as Record<string, unknown> | undefined;
  const serviceId = (
    platformBindings?.services as Record<string, JsonObject> | undefined
  )?.[fixture.serviceName]?.serviceId;
  if (!platformBindings || typeof serviceId !== 'string') {
    throw new Error(
      `The live maintenance scenario could not resolve the exact ${fixture.serviceName} service binding.`
    );
  }
  const registered = providerRegistry.get(contract!.provider);
  if (!registered) {
    throw new Error(`Provider ${contract!.provider} is not registered.`);
  }
  const adapter = await registered.factory(requiredCredentials(contract!.credentials));
  if (!supportsWorkloadMaintenance(adapter)) {
    throw new Error(
      `Provider ${contract!.provider} does not implement the workload-maintenance port.`
    );
  }
  const now = new Date();
  const environment: Environment = {
    id: `live-${fixture.environmentName}`,
    projectId: projectName,
    name: fixture.environmentName,
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
  const snapshot = await adapter.observeMaintenanceWorkload(
    environment,
    serviceId,
    fixture.service.workloadKind
  );
  expect(snapshot).toMatchObject({
    serviceId,
    workloadKind: fixture.service.workloadKind,
    state: 'running',
    wasRunning: true,
  });

  try {
    const entry = await adapter.suspendMaintenanceWorkload(environment, snapshot);
    expect(entry).toMatchObject({
      success: true,
      data: { applied: 1, skipped: 0 },
    });
    await expect(adapter.observeMaintenanceWorkload(
      environment,
      serviceId,
      fixture.service.workloadKind
    )).resolves.toMatchObject({ state: 'suspended' });
    await expect(adapter.suspendMaintenanceWorkload(environment, snapshot))
      .resolves.toMatchObject({
        success: true,
        data: { applied: 0, skipped: 1 },
      });
  } finally {
    await expect(adapter.resumeMaintenanceWorkload(environment, snapshot))
      .resolves.toMatchObject({ success: true });
  }
  await expect(adapter.observeMaintenanceWorkload(
    environment,
    serviceId,
    fixture.service.workloadKind
  )).resolves.toMatchObject({ state: 'running' });
}

async function verifyCommittedFixture(): Promise<void> {
  const fixture = contract!.managedWorkflow!;
  const specPath = path.join(workspace, '.hypervibe/spec.json');
  if (!existsSync(specPath)) {
    throw new Error(
      `The isolated live repository must commit .hypervibe/spec.json. `
      + `Copy ${fixture.fixtureDirectory} into it and follow docs/provider-conformance.md.`
    );
  }
  const worktreeSpec = readFileSync(specPath, 'utf8');
  const committedSpec = await runProcess(
    'git',
    ['show', 'HEAD:.hypervibe/spec.json'],
    workspace
  );
  if (worktreeSpec !== committedSpec) {
    throw new Error(
      '.hypervibe/spec.json must be clean and committed at HEAD before live provisioning.'
    );
  }

  const rawDocument = JSON.parse(worktreeSpec);
  const parsed = projectSpecSchema.parse(rawDocument);
  projectName = parsed.project;
  const expected = fixtureSpec({});
  if (
    JSON.stringify(rawDocument) !== JSON.stringify(expected)
    || JSON.stringify(parsed) !== JSON.stringify(expected)
  ) {
    throw new Error(
      'The committed .hypervibe/spec.json does not match the canonical managed-workflow fixture documented for this provider.'
    );
  }
  for (const requiredPath of fixture.requiredPaths) {
    await runProcess('git', ['cat-file', '-e', `HEAD:${requiredPath}`], workspace);
  }
  commitSha = (
    await runProcess('git', ['rev-parse', 'HEAD'], workspace)
  ).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error('The live repository HEAD is not a full Git commit SHA.');
  }
}

liveDescribe('live managed provider workflow contract', () => {
  beforeAll(async () => {
    contract = hostingProviderContracts.find(
      (entry) => entry.provider === selectedProvider
    );
    if (!contract) {
      throw new Error(
        `Unknown managed hosting provider "${selectedProvider}".`
      );
    }
    if (!contract.managedWorkflow) {
      throw new Error(
        `Hosting provider "${contract.provider}" has no managed-workflow live fixture.`
      );
    }
    if (contract.status === 'planned') {
      throw new Error(
        `Hosting provider "${contract.provider}" is still planned and cannot run live.`
      );
    }
    if (!existsSync(cliPath)) {
      throw new Error(
        'dist/index.js is missing. Run npm run build before the managed live contract.'
      );
    }

    const workspaceInput =
      process.env.HYPERVIBE_LIVE_REPOSITORY_WORKTREE?.trim();
    const dataDirectoryInput =
      process.env.HYPERVIBE_LIVE_DATA_DIR?.trim();
    repository = process.env.HYPERVIBE_TEST_GITHUB_REPOSITORY?.trim() ?? '';
    if (!workspaceInput || !path.isAbsolute(workspaceInput)) {
      throw new Error(
        'HYPERVIBE_LIVE_REPOSITORY_WORKTREE must be the absolute path to a disposable checkout of the isolated GitHub test repository.'
      );
    }
    if (!dataDirectoryInput || !path.isAbsolute(dataDirectoryInput)) {
      throw new Error(
        'HYPERVIBE_LIVE_DATA_DIR must be an absolute persistent directory so interrupted runs retain bindings and cleanup authority.'
      );
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(
        'HYPERVIBE_TEST_GITHUB_REPOSITORY must be owner/repository.'
      );
    }
    workspace = path.resolve(workspaceInput);
    dataDirectory = path.resolve(dataDirectoryInput);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);

    await verifyCommittedFixture();
    await setSpec(fixtureSpec({}));
    const connectedProviders = new Set<string>();
    for (const profile of [
      contract,
      ...datastoreConnectionProfiles(contract.managedWorkflow),
    ]) {
      if (connectedProviders.has(profile.provider)) continue;
      await connectProvider(profile.provider, profile.credentials);
      connectedProviders.add(profile.provider);
    }
    await connectProvider(
      'github',
      managedWorkflowGitHubCredentials,
      repository
    );
  }, 2 * 60_000);

  afterAll(async () => {
    if (!contract?.managedWorkflow || !resourcesMayExist) return;
    await setSpec(fixtureSpec({ includeService: false }));
    const teardown = await applyCurrentSpec();
    assertNoTerminalApplyFailure(teardown.apply);
    for (const actionId of expectedDestroyActionIds(contract.managedWorkflow)) {
      const destroyReceipt = (
        teardown.apply.data.receipts as JsonObject[] ?? []
      ).find((receipt) => receipt.actionId === actionId);
      expect(destroyReceipt).toMatchObject({ status: 'succeeded' });
    }
    await convergeReviewedInfrastructure(teardown.apply);

    const verified = await plan();
    const incomplete = nonNoopActions(verified).filter(
      (action) => ['service', 'database', 'cache'].includes(
        action.resource?.kind
      )
    );
    expect(incomplete).toEqual([]);
    expect(
      (verified.data.unmanaged as JsonObject[] ?? [])
        .filter((item) => ['service', 'database', 'cache'].includes(item.kind))
    ).toEqual([]);
    resourcesMayExist = false;
  }, 40 * 60_000);

  it('creates, exact-SHA deploys, verifies, updates, noops, and tears down through Hypervibe', async () => {
    const fixture = contract!.managedWorkflow!;
    resourcesMayExist = true;

    const first = await applyCurrentSpec();
    expect(nonNoopActions(first.plan).length).toBeGreaterThan(0);
    assertNoTerminalApplyFailure(first.apply);
    await convergeReviewedInfrastructure(first.apply);
    if (fixture.database) {
      const query = await runHypervibe(['db', 'query'], {
        project: projectName,
        env: fixture.environmentName,
        sql: 'SELECT 1::int AS healthy',
      });
      expect(query.data).toMatchObject({
        rowCount: 1,
        access: {
          provider: fixture.database.provider,
          cleanup: expect.not.stringMatching(/^failed$/),
        },
      });
      expect(query.data.rows).toEqual([{ healthy: 1 }]);
    }

    const workflows = await runHypervibe(['ci', 'status'], {
      project: projectName,
      repo: repository,
      include: ['workflows'],
    });
    if (workflows.data.workflows?.error) {
      throw new Error(
        `hv_ci_status could not inspect workflows: ${workflows.data.workflows.error}`
      );
    }
    expect(workflows.data.workflows).toContainEqual(
      expect.objectContaining({
        path: `.github/workflows/${fixture.workflow}`,
        state: 'active',
      })
    );

    const existingRuns = await runHypervibe(['ci', 'status'], {
      project: projectName,
      repo: repository,
      include: ['runs'],
      workflow: fixture.workflow,
    });
    if (existingRuns.data.runs?.error) {
      throw new Error(
        `hv_ci_status could not inspect existing runs: ${existingRuns.data.runs.error}`
      );
    }
    const existingRunIds = new Set<number>(
      (existingRuns.data.runs as JsonObject[] ?? [])
        .map((run) => run.id)
        .filter((id): id is number => typeof id === 'number')
    );
    const triggeredAfterMs = Date.now();
    await runHypervibe(['ci', 'trigger'], {
      project: projectName,
      repo: repository,
      workflow: fixture.workflow,
      ref: 'main',
      inputs: { commit_sha: commitSha },
    });
    const run = await waitForWorkflowRun(triggeredAfterMs, existingRunIds);
    expect(run).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
    });
    await verifyHealth();
    await verifyOptInMaintenanceLifecycle();

    const noop = await plan();
    expect(nonNoopActions(noop)).toEqual([]);
    const noopApply = await apply(noop);
    assertNoTerminalApplyFailure(noopApply);
    expect((noopApply.data.receipts as JsonObject[]).every(
      (receipt) => receipt.status === 'skipped_noop'
    )).toBe(true);

    await setSpec(fixtureSpec({ revision: 'update' }));
    const update = await applyCurrentSpec();
    expect(nonNoopActions(update.plan)).not.toContainEqual(
      expect.objectContaining({
        type: 'create',
        resource: expect.objectContaining({
          kind: 'service',
          name: fixture.serviceName,
        }),
      })
    );
    assertNoTerminalApplyFailure(update.apply);
    const verifiedUpdate = await plan();
    expect(
      nonNoopActions(verifiedUpdate).filter(
        (action) => action.resource?.kind === 'service'
      )
    ).toEqual([]);
  }, 60 * 60_000);
});
