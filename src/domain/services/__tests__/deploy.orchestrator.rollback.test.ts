import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { DeployOrchestrator } from '../deploy.orchestrator.js';
import type { IHostingAdapter } from '../../ports/hosting.port.js';

describe('DeployOrchestrator local rollback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-deploy-rollback-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores prior environment bindings after a failed deploy rollback', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'rollback-project', defaultPlatform: 'railway' });
    const originalBindings = {
      provider: 'railway',
      projectId: 'rail-old-project',
      environmentId: 'rail-old-env',
      services: {
        web: {
          serviceId: 'rail-old-service',
          url: 'https://old.example.com',
        },
      },
    };
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: originalBindings,
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });

    const adapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'created',
          data: {
            created: true,
            projectId: 'rail-new-project',
            environmentId: 'rail-new-env',
          },
        };
      },
      async deploy() {
        return {
          serviceId: 'deploy-run-1',
          externalId: 'rail-new-service',
          url: 'https://new.example.com',
          status: 'deploying',
          receipt: {
            success: true,
            message: 'deploy started',
            data: {
              createdService: true,
              environmentId: 'rail-new-env',
            },
          },
        };
      },
      async setEnvVars() {
        return { success: true, message: 'ok' };
      },
      async getDeployStatus() {
        return { status: 'failed' };
      },
      async deleteProject() {
        return { success: true };
      },
      async deleteService() {
        return { success: true };
      },
    };

    const orchestrator = new DeployOrchestrator();
    const result = await orchestrator.execute({
      project,
      environment,
      services: [service],
      adapter,
    });

    expect(result.success).toBe(false);
    const restored = envRepo.findById(environment.id);
    expect(restored?.platformBindings).toEqual(originalBindings);
  });

  it('stores provider-neutral bindings for non-Railway deploys', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'cloud-project', defaultPlatform: 'cloudrun' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-old-project',
        environmentId: 'rail-old-env',
      },
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
    });

    const adapter: IHostingAdapter = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: false,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: false,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'using gcp project',
          data: {
            projectId: 'gcp-project',
            environmentId: 'us-central1',
          },
        };
      },
      async deploy() {
        return {
          serviceId: service.id,
          externalId: 'cloudrun-web',
          url: 'https://web.example.run.app',
          status: 'deploying',
          receipt: {
            success: true,
            message: 'deploy started',
            data: {
              environmentId: 'us-central1',
            },
          },
        };
      },
      async setEnvVars() {
        return { success: true, message: 'ok' };
      },
      async getDeployStatus() {
        return { status: 'deployed', url: 'https://web.example.run.app' };
      },
    };

    const orchestrator = new DeployOrchestrator();
    const result = await orchestrator.execute({
      project,
      environment,
      services: [service],
      adapter,
    });

    expect(result.success).toBe(true);
    expect(result.urls).toEqual(['https://web.example.run.app']);
    expect(result.serviceUrls).toEqual({ web: 'https://web.example.run.app' });
    expect(result.primaryUrl).toBe('https://web.example.run.app');
    const updated = envRepo.findById(environment.id);
    expect(updated?.platformBindings).toEqual({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      environmentId: 'us-central1',
      services: {
        web: {
          serviceId: 'cloudrun-web',
          url: 'https://web.example.run.app',
          workloadKind: 'web',
        },
      },
    });
  });

  it('skips stale service bindings during env pre-sync so deploy can repair them', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'stale-binding-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-staging-env',
        services: {
          web: { serviceId: 'production-only-web' },
        },
      },
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });

    const adapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'exists',
          data: { projectId: 'rail-project', environmentId: 'rail-staging-env' },
        };
      },
      async setEnvVars() {
        return {
          success: false,
          message: 'cached service id is not in this environment',
          data: { staleBinding: true, ignoredBoundServiceId: 'production-only-web' },
        };
      },
      async deploy() {
        return {
          serviceId: service.id,
          externalId: 'web-staging-service',
          status: 'deploying',
          receipt: {
            success: true,
            message: 'deploy started',
            data: { environmentId: 'rail-staging-env', createdService: true },
          },
        };
      },
      async getDeployStatus() {
        return { status: 'deployed' };
      },
      async deleteService() {
        return { success: true };
      },
    };

    const orchestrator = new DeployOrchestrator();
    const result = await orchestrator.execute({
      project,
      environment,
      services: [service],
      adapter,
      envVars: { DATABASE_URL: '${{postgres-db-staging.DATABASE_URL}}' },
    });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    const updated = envRepo.findById(environment.id)?.platformBindings as { services?: Record<string, { serviceId?: string }> };
    expect(updated.services?.web?.serviceId).toBe('web-staging-service');
  });

  it('never promotes a failed wrong-name create id to a service binding and retains its recovery marker after rollback', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({ name: 'partial-create-project', defaultPlatform: 'railway' });
    const originalBindings = {
      provider: 'railway',
      projectId: 'rail-project',
      environmentId: 'rail-staging',
      services: {},
    };
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: originalBindings,
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });
    const deleteService = vi.fn(async () => ({ success: true }));
    const recovery = {
      provider: 'railway',
      operation: 'create' as const,
      resourceName: 'web-staging',
      providerScope: { projectId: 'rail-project', environmentId: 'rail-staging' },
      state: 'mismatched' as const,
      serviceId: 'svc-wrong',
      returnedName: 'not-web-staging',
    };
    const adapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportsAutoWiring: true, supportsHealthChecks: true,
        supportsCronSchedule: false, supportsReleaseCommand: true, supportsMultiEnvironment: true,
        managedTls: true, supportsAutoScaling: false, supportsObserve: false,
      },
      async connect() {},
      async verify() { return { success: true }; },
      async ensureProject() {
        return { success: true, message: 'exists', data: { projectId: 'rail-project', environmentId: 'rail-staging' } };
      },
      async deploy() {
        return {
          serviceId: service.id,
          externalId: 'svc-wrong',
          status: 'failed',
          receipt: {
            success: false,
            message: 'wrong identity',
            error: 'returned service name did not match',
            data: {
              phase: 'serviceCreate', environmentId: 'rail-staging', mutationAttempted: true,
              serviceCreateRecovery: recovery,
            },
          },
        };
      },
      async setEnvVars() { return { success: true, message: 'ok' }; },
      deleteService,
    };

    const result = await new DeployOrchestrator().execute({ project, environment, services: [service], adapter });

    expect(result.success).toBe(false);
    expect(deleteService).not.toHaveBeenCalled();
    expect(envRepo.findById(environment.id)?.platformBindings).toEqual({
      ...originalBindings,
      serviceCreateRecovery: { web: recovery },
    });
    expect((result.run.receipts.find((receipt) => receipt.step === 'deploy_web')?.result as Record<string, unknown>)).toMatchObject({
      externalId: 'svc-wrong',
      serviceCreateRecovery: recovery,
    });
  });

  it('derives a conservative durable blocker when a malformed successful deploy has no id', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({ name: 'malformed-success-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway', projectId: 'rail-project', environmentId: 'rail-staging', services: {},
      },
    });
    const service = serviceRepo.create({
      projectId: project.id, name: 'web', buildConfig: { builder: 'nixpacks' },
    });
    const deploy = vi.fn(async () => ({
      serviceId: service.id,
      status: 'deploying' as const,
      receipt: { success: true, message: 'created but malformed response', data: { environmentId: 'rail-staging' } },
    }));
    const adapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'], supportsAutoWiring: true, supportsHealthChecks: true,
        supportsCronSchedule: false, supportsReleaseCommand: true, supportsMultiEnvironment: true,
        managedTls: true, supportsAutoScaling: false, supportsObserve: false,
      },
      async connect() {},
      async verify() { return { success: true }; },
      async ensureProject() {
        return { success: true, message: 'exists', data: { projectId: 'rail-project', environmentId: 'rail-staging' } };
      },
      deploy,
      async setEnvVars() { return { success: true, message: 'ok' }; },
    };

    const result = await new DeployOrchestrator().execute({ project, environment, services: [service], adapter });

    expect(result.success).toBe(false);
    expect(envRepo.findById(environment.id)?.platformBindings).toMatchObject({
      services: {},
      serviceCreateRecovery: {
        web: {
          provider: 'railway',
          operation: 'create',
          resourceName: 'web',
          providerScope: { projectId: 'rail-project', environmentId: 'rail-staging' },
          state: 'unresolved',
        },
      },
    });
  });
});

describe('DeployOrchestrator run plan secrecy', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-deploy-plan-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('never persists env var values in the run plan — key names only', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'plan-secrecy-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({ projectId: project.id, name: 'staging' });
    const service = serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });

    const orchestrator = new DeployOrchestrator();
    const plan = orchestrator.buildPlan({
      project,
      environment,
      services: [service],
      envVars: {
        DATABASE_URL: 'postgres://user:sup3rsecret@host:5432/app',
        SENDGRID_API_KEY: 'SG.very-secret-value',
      },
      adapter: { name: 'railway' } as unknown as IHostingAdapter,
    });

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('sup3rsecret');
    expect(serialized).not.toContain('SG.very-secret-value');

    const setEnvStep = plan.steps.find((step) => step.action === 'setEnvVars')!;
    expect(setEnvStep.params).toEqual({ envVarKeys: ['DATABASE_URL', 'SENDGRID_API_KEY'] });
  });

  it('records deployment deferral and omits misleading health checks', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'deferred-plan-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({ projectId: project.id, name: 'staging' });
    const service = serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });

    const plan = new DeployOrchestrator().buildPlan({
      project,
      environment,
      services: [service],
      deferProviderDeployment: true,
      adapter: { name: 'railway' } as unknown as IHostingAdapter,
    });

    expect(plan.steps.some((step) => step.action === 'verifyHealth')).toBe(false);
    expect(plan.metadata).toMatchObject({ deploymentDeferralRequested: true });
  });
});
