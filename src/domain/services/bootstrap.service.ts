import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { adapterFactory } from './adapter.factory.js';
import { getProjectScopeHints } from './project-scope.js';
import { DeployOrchestrator } from './deploy.orchestrator.js';
import { InfraTransaction } from './infra.transaction.js';
import { getCloudPrepareProfile, isCloudPrepared } from './cloud-prepare.js';
import { snapshotEnvironmentBindings } from './local-state.transaction.js';
import { resolveProject } from './resolve-project.js';
import { hostingProviderForEnvironment } from './hosting-env.service.js';
import { buildRailwayGitHubRepoAccessHelp, isRailwayGitHubRepoAccessError } from './railway-help.js';
import type { WorkloadKind } from '../entities/service.entity.js';
import type { Receipt } from '../ports/provider.port.js';
import type { ProjectRuntime } from '../spec/project-runtime.js';
import { parseHostingBindings, type IHostingAdapter } from '../ports/hosting.port.js';
import {
  type DesiredState,
  workloadKindForServiceName,
} from './spec.service.js';
import { buildDeploySourceEnvVars, resolveGitDeploySource } from './deploy-source.js';
import { attachBootstrapDomain } from './bootstrap-domain.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

type SourceConfigurableHostingAdapter = {
  connectServiceToRepo?: (params: { serviceId: string; repo: string; branch: string }) => Promise<Receipt>;
  isGitHubRepoAccessible?: (fullRepoName: string) => Promise<boolean | null>;
};

function defaultPublicForWorkload(workloadKind: WorkloadKind): boolean {
  return workloadKind === 'web';
}

function recordConnectedDeploySource(params: {
  environmentId: string;
  provider: string;
  serviceName: string;
  serviceId: string;
  repo: string;
  branch: string;
  tx: InfraTransaction;
}): void {
  const latestEnvironment = envRepo.findById(params.environmentId);
  if (!latestEnvironment) {
    return;
  }

  const bindings = parseHostingBindings(latestEnvironment);
  const services = { ...(bindings.services ?? {}) };
  services[params.serviceName] = {
    ...(services[params.serviceName] ?? {}),
    serviceId: params.serviceId,
    source: {
      repo: params.repo,
      branch: params.branch,
    },
  };

  snapshotEnvironmentBindings({
    tx: params.tx,
    envRepo,
    environmentId: params.environmentId,
    label: `environment_bindings_deploy_source_${params.serviceName}`,
  });
  envRepo.updatePlatformBindings(params.environmentId, {
    provider: params.provider,
    services,
  });
}

export async function executeBootstrap(params: {
  projectName: string;
  environmentName: string;
  /** Non-secret desired hosting placement; provider default when omitted. */
  hostingRegion?: string;
  services: string[];
  crons?: DesiredState['crons'];
  domain?: string;
  serviceConfig?: DesiredState['serviceConfig'];
  envVars?: DesiredState['envVars'];
  deploy?: DesiredState['deploy'];
  verifyHttpHealth?: boolean;
  queueEnvVars?: Record<string, string>;
  envVarsByService?: Record<string, Record<string, string>>;
  ensureHostingProject?: boolean;
  runtime?: ProjectRuntime;
}): Promise<{ success: boolean; summary: Record<string, unknown> }> {
  const tx = new InfraTransaction();
  const project = resolveProject({ projectName: params.projectName });
  if (!project) {
    return {
      success: false,
      summary: {
        blocked: true,
        error: `Project ${params.projectName} has no reviewed desired state.`,
        next: 'Initialize the project with hv_spec so its hosting provider is explicit before apply.',
      },
    };
  }
  const scopeHints = getProjectScopeHints(project);

  let environment = envRepo.findByProjectAndName(project.id, params.environmentName);
  if (!environment) {
    environment = envRepo.create({ projectId: project.id, name: params.environmentName });
    const createdEnvironmentId = environment.id;
    tx.addStep({
      id: `environment:${createdEnvironmentId}`,
      label: 'env_create',
      resource: { provider: 'hypervibe', type: 'environment', id: createdEnvironmentId, name: environment.name },
      compensate: async () => ({
        success: envRepo.delete(createdEnvironmentId),
        message: `Deleted local environment ${createdEnvironmentId}`,
      }),
    });
  }

  const serviceWorkloads = params.services.map((serviceName, index) => {
    let service = serviceRepo.findByProjectAndName(project.id, serviceName);
    const runtimeConfig = params.serviceConfig?.[serviceName];
    const workloadKind = runtimeConfig?.workloadKind ?? service?.buildConfig.workloadKind ?? workloadKindForServiceName(serviceName, index);
    const publicAccess = typeof runtimeConfig?.public === 'boolean'
      ? runtimeConfig.public
      : defaultPublicForWorkload(workloadKind);
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: serviceName,
        buildConfig: {
          workloadKind,
          builder: 'nixpacks',
          ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
          ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
          ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
          ...(params.runtime ? { runtime: params.runtime } : {}),
          public: publicAccess,
        },
      });
      const createdServiceId = service.id;
      tx.addStep({
        id: `service:${createdServiceId}`,
        label: 'service_create',
        resource: { provider: 'hypervibe', type: 'service', id: createdServiceId, name: service.name },
        compensate: async () => ({
          success: serviceRepo.delete(createdServiceId),
          message: `Deleted local service ${createdServiceId}`,
        }),
      });
    } else {
      const nextBuildConfig = {
        ...service.buildConfig,
        workloadKind,
        ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
        ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
        ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
        ...(params.runtime ? { runtime: params.runtime } : {}),
        public: publicAccess,
      };
      const buildConfigChanged = JSON.stringify(service.buildConfig) !== JSON.stringify(nextBuildConfig);
      if (buildConfigChanged) {
        service = serviceRepo.update(service.id, {
          buildConfig: nextBuildConfig,
        }) ?? service;
      }
    }
    return service;
  });
  const cronWorkloads = Object.entries(params.crons ?? {}).map(([cronName, cronConfig]) => {
    let service = serviceRepo.findByProjectAndName(project.id, cronName);
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: cronName,
        buildConfig: {
          workloadKind: 'cron',
          builder: 'nixpacks',
          cronSchedule: cronConfig.schedule,
          ...(cronConfig.command ? { startCommand: cronConfig.command } : {}),
          ...(params.runtime ? { runtime: params.runtime } : {}),
        },
      });
      const createdServiceId = service.id;
      tx.addStep({
        id: `service:${createdServiceId}`,
        label: 'cron_create',
        resource: { provider: 'hypervibe', type: 'cron', id: createdServiceId, name: service.name },
        compensate: async () => ({
          success: serviceRepo.delete(createdServiceId),
          message: `Deleted local cron job ${createdServiceId}`,
        }),
      });
    } else {
      service = serviceRepo.update(service.id, {
        buildConfig: {
          ...service.buildConfig,
          workloadKind: 'cron',
          builder: service.buildConfig.builder ?? 'nixpacks',
          cronSchedule: cronConfig.schedule,
          ...(cronConfig.command ? { startCommand: cronConfig.command } : {}),
          ...(params.runtime ? { runtime: params.runtime } : {}),
        },
      }) ?? service;
    }
    return service;
  });
  const workloads = [...serviceWorkloads, ...cronWorkloads];

  if (workloads.length === 0) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: 'No workloads resolved for infrastructure apply',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const targetPlatform = hostingProviderForEnvironment(project, environment);
  const cloudPrepareProfile = getCloudPrepareProfile(targetPlatform);
  if (cloudPrepareProfile && !isCloudPrepared(project, targetPlatform)) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `${cloudPrepareProfile.label} is not prepared for Hypervibe deploys. Run hv_connections provider="${targetPlatform}" action="prepare" confirm=true before applying.`,
        action: 'cloud_prepare',
        provider: targetPlatform,
        requiredVersion: cloudPrepareProfile.version,
        requiredApis: cloudPrepareProfile.requiredApis,
        requiredRoles: cloudPrepareProfile.requiredRoles,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const hostingProject = project.defaultPlatform?.toLowerCase() === targetPlatform
    ? project
    : { ...project, defaultPlatform: targetPlatform };
  const hostingResult = await adapterFactory.getHostingAdapter(hostingProject);
  if (!hostingResult.success || !hostingResult.adapter) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: hostingResult.error || 'Hosting adapter unavailable',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }
  const hostingAdapter = hostingResult.adapter as unknown as IHostingAdapter;
  if (!hostingAdapter.capabilities || typeof hostingAdapter.deploy !== 'function') {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${targetPlatform} is not a hosting adapter`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  try {
    await hostingAdapter.configureTarget?.({ region: params.hostingRegion });
  } catch (error) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Invalid hosting target for ${targetPlatform}: ${error instanceof Error ? error.message : String(error)}`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const unsupportedReleaseCommands = Object.entries(params.serviceConfig ?? {})
    .filter(([, config]) => Boolean(config?.releaseCommand))
    .map(([serviceName]) => serviceName);
  if (unsupportedReleaseCommands.length > 0 && !hostingAdapter.capabilities.supportsReleaseCommand) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${hostingAdapter.name} does not support releaseCommand/predeploy configuration via API for services: ${unsupportedReleaseCommands.join(', ')}. Move the command to migrations.mode="tool" or remove releaseCommand from serviceConfig.`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const orchestrator = new DeployOrchestrator();
  const deploySource = resolveGitDeploySource(project, params.environmentName, params.deploy);
  const deployTrigger = params.deploy?.trigger ?? 'ci';
  const deferProviderDeployment = params.deploy?.strategy === 'branch'
    && deployTrigger === 'ci'
    && hostingAdapter.capabilities.supportsDeferredDeploy === true;
  const sourceEnvVars = buildDeploySourceEnvVars(
    project,
    hostingAdapter,
    deploySource.source?.branch
      ?? params.deploy?.branch
      ?? params.deploy?.branches?.production
      ?? 'main'
  );
  const deployEnvVars = {
    ...sourceEnvVars,
    ...(params.queueEnvVars ?? {}),
    ...(params.envVars ?? {}),
  };
  const deploy = await orchestrator.execute({
    project,
    environment,
    services: workloads,
    envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
    ...(params.envVarsByService ? { envVarsByService: params.envVarsByService } : {}),
    ...(params.verifyHttpHealth ? { verifyHttpHealth: true } : {}),
    ...(deferProviderDeployment ? { deferProviderDeployment: true } : {}),
    ensureProject: params.ensureHostingProject !== false,
    adapter: hostingAdapter,
  });

  const rolloutBaselines: Record<string, unknown> = {};
  let runtimeRolloutRequired = false;
  for (const receipt of deploy.run.receipts) {
    const receiptResult = receipt.result;
    if (!receiptResult || typeof receiptResult !== 'object') continue;
    if (receiptResult.runtimeRolloutRequired === true) {
      runtimeRolloutRequired = true;
    }
    const aggregate = receiptResult.rolloutBaselines;
    if (aggregate && typeof aggregate === 'object' && !Array.isArray(aggregate)) {
      Object.assign(rolloutBaselines, aggregate);
    }
    const serviceName = receiptResult.service;
    const rolloutBaseline = receiptResult.rolloutBaseline;
    if (
      typeof serviceName === 'string'
      && rolloutBaseline
      && typeof rolloutBaseline === 'object'
      && !Array.isArray(rolloutBaseline)
    ) {
      rolloutBaselines[serviceName] = rolloutBaseline;
    }
  }

  const summary: Record<string, unknown> = {
    project: project.name,
    environment: environment.name,
    service: serviceWorkloads[0]?.name ?? cronWorkloads[0]?.name,
    services: serviceWorkloads.map((service) => service.name),
    ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
    deploymentRunId: deploy.run.id,
    deploymentSuccess: deploy.success,
    deploymentDeferralRequested: deferProviderDeployment,
    ...(runtimeRolloutRequired ? { runtimeRolloutRequired: true } : {}),
    ...(Object.keys(rolloutBaselines).length > 0 ? { rolloutBaselines } : {}),
    urls: deploy.urls,
    serviceUrls: deploy.serviceUrls,
    primaryUrl: deploy.primaryUrl,
    deploymentCreatedResources: deploy.createdResources,
    deploymentRollback: deploy.rollback,
    transaction: {
      created: tx.listResources(),
    },
  };

  if (!deploy.success) {
    const cleanup = await tx.rollback();
    summary.rollback = cleanup;
    return {
      success: false,
      summary: {
        ...summary,
        error: deploy.errors.join('; ') || 'Deploy failed',
      },
    };
  }

  if (params.deploy?.strategy === 'branch' && deployTrigger === 'native') {
    if (!deploySource.source) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: deploySource.error || 'Branch deploy source configuration is incomplete',
          rollback: cleanup,
        },
      };
    }

    const latestEnvironment = envRepo.findById(environment.id) ?? environment;
    const boundServices = parseHostingBindings(latestEnvironment).services ?? {};
    const sourceAdapter = hostingAdapter as IHostingAdapter & SourceConfigurableHostingAdapter;

    if (typeof sourceAdapter.connectServiceToRepo !== 'function') {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Provider ${hostingAdapter.name} does not support repo-linked deploy source configuration`,
          rollback: cleanup,
        },
      };
    }

    const sourceFailures: string[] = [];
    let repoAccessHelp: ReturnType<typeof buildRailwayGitHubRepoAccessHelp> | undefined;
    for (const service of workloads) {
      const serviceId = boundServices[service.name]?.serviceId;
      if (!serviceId) {
        sourceFailures.push(`${service.name}: missing bound provider service ID`);
        continue;
      }

      const receipt = await sourceAdapter.connectServiceToRepo({
        serviceId,
        repo: deploySource.source.repo,
        branch: deploySource.source.branch,
      });
      if (!receipt.success) {
        const error = receipt.error || receipt.message;
        sourceFailures.push(`${service.name}: ${error}`);
        if (!repoAccessHelp && isRailwayGitHubRepoAccessError(error)) {
          repoAccessHelp = buildRailwayGitHubRepoAccessHelp(deploySource.source.repo);
        }
      } else {
        recordConnectedDeploySource({
          environmentId: environment.id,
          provider: hostingAdapter.name,
          serviceName: service.name,
          serviceId,
          repo: deploySource.source.repo,
          branch: deploySource.source.branch,
          tx,
        });
      }
    }

    if (sourceFailures.length > 0) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Failed to configure deploy source for ${sourceFailures.join('; ')}`,
          rollback: cleanup,
          ...(repoAccessHelp
            ? {
                help: repoAccessHelp,
                nextSteps: repoAccessHelp.nextSteps,
              }
            : {}),
        },
      };
    }

    // serviceConnect succeeds even when the Railway GitHub App cannot see the
    // repo (builds work, but the UI shows "repo not found" and pushes never
    // auto-deploy). Verify and surface the GitHub-side fix when needed.
    const repoAccess = typeof sourceAdapter.isGitHubRepoAccessible === 'function'
      ? await sourceAdapter.isGitHubRepoAccessible(deploySource.source.repo)
      : null;

    summary.deploySource = {
      strategy: 'branch',
      trigger: 'native',
      repo: deploySource.source.repo,
      branch: deploySource.source.branch,
      services: serviceWorkloads.map((service) => service.name),
      ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
      ...(repoAccess === false
        ? {
            warning: `Railway's GitHub App cannot access ${deploySource.source.repo}: native Railway pushes to GitHub will NOT auto-deploy until the user grants the Railway GitHub App access, confirms a Railway project member has connected GitHub contributor access, accepts any pending app permission updates, and waits for Railway caches to refresh.`,
            help: buildRailwayGitHubRepoAccessHelp(deploySource.source.repo),
          }
        : {}),
    };
  } else if (params.deploy?.strategy === 'branch') {
    const branch = deploySource.source?.branch
      ?? params.deploy.branch
      ?? params.deploy.branches?.production
      ?? params.deploy.branches?.staging
      ?? 'main';
    summary.deploymentMode = 'provision';
    summary.appDeployment = {
      status: 'pending_ci',
      reason: 'Infrastructure is configured; application code deploys when the GitHub Actions branch workflow runs.',
    };
    summary.appDeploymentPending = true;
    summary.deploySource = {
      strategy: 'branch',
      trigger: 'ci',
      ...(deploySource.source ? { repo: deploySource.source.repo } : {}),
      branch,
      services: serviceWorkloads.map((service) => service.name),
      ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
      nextSteps: [
        'Run hv_plan and hv_apply for this environment to create or update the GitHub Actions deploy workflow and sync available provider secrets.',
        `Push to ${branch} or trigger the workflow to build the image and deploy it through provider APIs.`,
        'Use hv_ci_status to inspect workflow runs, then hv_health after a successful workflow run.',
      ],
    };
  }

  if (params.domain) {
    await attachBootstrapDomain({
      domain: params.domain,
      environment,
      hostingAdapter,
      serviceWorkloads,
      scopeHints,
      targetPlatform,
      summary,
    });
  }

  return { success: deploy.success, summary };
}
