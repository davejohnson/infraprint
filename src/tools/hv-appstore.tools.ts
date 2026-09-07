import type { CommandRegistrar } from '../application/commands.js';
import { z } from 'zod';
import type { CommandContext } from '../application/context.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError, describeError } from '../application/results.js';
import {
  getAppStoreConnectAdapter,
  summarizeBuild,
} from '../domain/services/appstore-ops.service.js';
import { connectionSetupOptions, formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { projectField } from './schemas.js';
import { ignoredOptionWarnings } from '../application/command-options.js';

type ConnectedAppStoreAdapter = Extract<
  ReturnType<typeof getAppStoreConnectAdapter>,
  { adapter: unknown }
>['adapter'];

const SETUP_HINT =
  `${formatConnectionGuidance('appstoreconnect')} For multiple apps/teams use a scoped connection (scope="<bundle id>"). Uploads additionally require the Xcode command line tools (xcode-select --install).`;

const platformField = z.enum(['IOS', 'MAC_OS', 'TV_OS']).optional().describe('Platform (default: IOS)');
type AscPlatform = 'IOS' | 'MAC_OS' | 'TV_OS' | undefined;

function adapterOrThrow(scopeHint?: string, project?: string): ConnectedAppStoreAdapter {
  const result = getAppStoreConnectAdapter(scopeHint);
  if ('error' in result) {
    throw new HvError('MISSING_CONNECTION', result.error, {
      ...connectionSetupOptions('appstoreconnect', { project, scope: scopeHint }),
      hint: SETUP_HINT,
    });
  }
  return result.adapter;
}

/**
 * Compute App Store submission readiness for the editable version
 * (build attached, localization metadata, screenshots).
 */
async function computeReadiness(
  adapter: ConnectedAppStoreAdapter,
  appId: string,
  options: { platform?: AscPlatform; locale: string; screenshotDisplayType: string },
): Promise<Record<string, unknown>> {
  const version = await adapter.getEditableAppStoreVersion(appId, options.platform);
  if (!version) {
    return {
      version: null,
      missing: ['No editable App Store version found (expected PREPARE_FOR_SUBMISSION or similar state). Create a new version in App Store Connect.'],
    };
  }

  const build = await adapter.getAppStoreVersionBuild(version.id);
  const localizations = await adapter.listAppStoreVersionLocalizations(version.id);
  const localization = localizations.find((l) => l.locale.toLowerCase() === options.locale.toLowerCase()) ?? null;

  let screenshotSet: { id: string; screenshotDisplayType: string } | null = null;
  let screenshots: Array<{ id: string; fileName?: string; state?: string }> = [];
  if (localization) {
    const sets = await adapter.listAppScreenshotSets(localization.id);
    screenshotSet = sets.find((s) => s.screenshotDisplayType === options.screenshotDisplayType) ?? null;
    if (screenshotSet) {
      const items = await adapter.listAppScreenshots(screenshotSet.id);
      screenshots = items.map((s) => ({ id: s.id, fileName: s.fileName, state: s.assetDeliveryState?.state }));
    }
  }

  const checks = {
    hasBuildAttached: !!build,
    hasLocalization: !!localization,
    hasDescription: !!localization?.description,
    hasWhatsNew: !!localization?.whatsNew,
    hasScreenshotSet: !!screenshotSet,
    screenshotCount: screenshots.length,
  };
  const missing: string[] = [];
  if (!checks.hasBuildAttached) missing.push('Attach a build to the App Store version');
  if (!checks.hasLocalization) missing.push(`Create localization ${options.locale}`);
  if (checks.hasLocalization && !checks.hasDescription) missing.push(`Set description for ${options.locale}`);
  if (checks.hasLocalization && !checks.hasWhatsNew) missing.push(`Set what's new for ${options.locale}`);
  if (checks.hasLocalization && !checks.hasScreenshotSet) missing.push(`Create screenshot set ${options.screenshotDisplayType} for ${options.locale}`);
  if (checks.hasScreenshotSet && checks.screenshotCount === 0) missing.push(`Upload at least one screenshot for ${options.locale}/${options.screenshotDisplayType}`);

  return {
    version,
    locale: options.locale,
    screenshotDisplayType: options.screenshotDisplayType,
    readinessChecks: checks,
    missing,
    localizations: localizations.map((l) => ({
      id: l.id,
      locale: l.locale,
      hasDescription: !!l.description,
      hasWhatsNew: !!l.whatsNew,
    })),
    screenshotSet,
    screenshots,
  };
}

const STATUS_SECTIONS = ['builds', 'groups', 'testers', 'readiness', 'capabilities'] as const;
type StatusSection = (typeof STATUS_SECTIONS)[number];

export function registerHvAppstoreTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_appstore_status',
    'Read-only App Store Connect overview for an app: TestFlight builds, beta groups, testers, App Store submission readiness, and App ID capabilities. Use include to limit scope. Requires an appstoreconnect connection (API key from https://appstoreconnect.apple.com/access/integrations/api).',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g. com.example.myapp)'),
      include: z.array(z.enum(STATUS_SECTIONS)).optional().describe('Sections to include (default: all of builds, groups, testers, readiness, capabilities)'),
      platform: platformField,
      locale: z.string().optional().describe('Localization to inspect for readiness (default: en-US)'),
      screenshotDisplayType: z.string().optional().describe('Screenshot display type to inspect for readiness (default: APP_IPHONE_65)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max builds/testers to return (default: 10 builds, 200 testers)'),
    },
    wrapCommandHandler(async ({ appIdentifier, include, platform, locale, screenshotDisplayType, limit }) => {
      const adapter = adapterOrThrow(appIdentifier);
      const sections = new Set<StatusSection>(include?.length ? include : STATUS_SECTIONS);
      const selectedSections = [...sections];
      const resolvedPlatform = platform ?? 'IOS';
      const resolvedLocale = locale ?? 'en-US';
      const resolvedScreenshotDisplayType = screenshotDisplayType ?? 'APP_IPHONE_65';
      const warnings: string[] = [
        ...(ignoredOptionWarnings('hv_appstore_status', `include=${JSON.stringify(selectedSections)}`, {
          platform: sections.has('readiness') ? undefined : platform,
          locale: sections.has('readiness') ? undefined : locale,
          screenshotDisplayType: sections.has('readiness') ? undefined : screenshotDisplayType,
          limit: sections.has('builds') || sections.has('testers') ? undefined : limit,
        }) ?? []),
      ];

      const app = await adapter.findAppByBundleId(appIdentifier);
      if (!app && (sections.has('builds') || sections.has('groups') || sections.has('testers') || sections.has('readiness'))) {
        throw new HvError('NOT_FOUND', `App not found for bundle ID: ${appIdentifier}.`, {
          hint: 'Create the app in App Store Connect first, or check the bundle identifier. App ID capabilities are converged from the environment ios spec through hv_plan/hv_apply.',
        });
      }

      const data: Record<string, unknown> = { app };
      const section = async (name: StatusSection, fn: () => Promise<unknown>) => {
        if (!sections.has(name)) return;
        try {
          data[name] = await fn();
        } catch (error) {
          warnings.push(`Failed to load ${name}: ${describeError(error)}`);
        }
      };

      await section('builds', async () => {
        const requestedLimit = limit ?? 10;
        const builds = await adapter.listBuilds({ appId: app!.id, limit: requestedLimit });
        // Provider pagination is an optimization, not the public command
        // boundary. Keep the result bounded if the API/adapter over-returns.
        return builds.slice(0, requestedLimit).map(summarizeBuild);
      });
      await section('groups', () => adapter.listBetaGroups(app!.id));
      await section('testers', async () => {
        const requestedLimit = limit ?? 200;
        const testers = await adapter.listBetaTesters({ appId: app!.id, limit: requestedLimit });
        return testers.slice(0, requestedLimit);
      });
      await section('readiness', () => computeReadiness(adapter, app!.id, {
        platform: resolvedPlatform,
        locale: resolvedLocale,
        screenshotDisplayType: resolvedScreenshotDisplayType,
      }));
      await section('capabilities', async () => {
        const bundleId = await adapter.findBundleIdByIdentifier(appIdentifier);
        if (!bundleId) return { bundleId: null, capabilities: [], note: `Bundle ID not registered: ${appIdentifier}. Declare it in the environment ios spec and run hv_plan/hv_apply.` };
        return { bundleId, capabilities: await adapter.getBundleIdCapabilities(bundleId.id) };
      });

      return commandSuccess(data, { warnings });
    })
  );

  commands.register(
    'hv_appstore_submit',
    'Submit an app version for App Store review only after the latest managed server deploy and iOS release workflows succeeded for the same Git commit. The app must have a PREPARE_FOR_SUBMISSION version with a build attached.',
    {
      project: projectField,
      environment: z.string().min(1).describe('Desired environment whose server/mobile release evidence gates submission'),
      appIdentifier: z.string().describe('App bundle identifier (e.g. com.example.myapp)'),
      platform: platformField,
    },
    wrapCommandHandler(async ({ project: projectRef, environment: environmentName, appIdentifier, platform }) => {
      const resolvedPlatform = platform ?? 'IOS';
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const stored = new SpecStore().get(project);
      if (!stored) {
        return commandError('NOT_FOUND', `Project "${project.name}" has no desired-state spec.`);
      }
      const environmentSpec = stored.spec.environments[environmentName];
      if (!environmentSpec?.ios?.release || environmentSpec.ios.bundleId !== appIdentifier) {
        return commandError(
          'VALIDATION',
          `Environment "${environmentName}" does not declare ios.release for ${appIdentifier}.`,
          { hint: 'Declare the release under environments.<name>.ios.release and converge it with hv_plan/hv_apply.' }
        );
      }
      const repository = parseGitHubRepoFromRemote(stored.spec.gitRemoteUrl ?? project.gitRemoteUrl);
      if (!repository) {
        return commandError('VALIDATION', 'The project has no valid GitHub repository for release evidence.');
      }
      const [owner, repo] = repository?.split('/') ?? [];
      if (!owner || !repo) {
        return commandError('VALIDATION', 'The project has no valid GitHub repository for release evidence.');
      }
      const github = getGitHubAdapter(repository);
      if ('error' in github) {
        return commandError('MISSING_CONNECTION', github.error, {
          ...connectionSetupOptions('github', { project: project.name, scope: repository }),
        });
      }
      const safeEnvironment = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const serverWorkflow = `deploy-${environmentSpec.hosting.provider}-${safeEnvironment}.yml`;
      const iosWorkflow = `hypervibe-ios-release-${safeEnvironment}.yml`;
      let serverRuns;
      let iosRuns;
      let artifacts;
      try {
        [serverRuns, iosRuns, artifacts] = await Promise.all([
          github.adapter.listWorkflowRuns(owner, repo, serverWorkflow, { status: 'completed', per_page: 20 }),
          github.adapter.listWorkflowRuns(owner, repo, iosWorkflow, { status: 'completed', per_page: 20 }),
          github.adapter.listArtifacts(owner, repo, 100),
        ]);
      } catch (error) {
        return commandError('PROVIDER_ERROR', `Could not verify managed release workflows: ${describeError(error)}`, {
          hint: 'Inspect the workflows through hv_ci_status, then retry after both runs succeed.',
        });
      }
      const successfulServerRuns = new Set(
        serverRuns.workflow_runs.filter((run) => run.conclusion === 'success').map((run) => run.id)
      );
      const successfulIosRuns = new Set(
        iosRuns.workflow_runs.filter((run) => run.conclusion === 'success').map((run) => run.id)
      );
      const serverPrefix = `hypervibe-server-release-${safeEnvironment}-`;
      const iosPrefix = `hypervibe-ios-release-${safeEnvironment}-`;
      const matchingArtifacts = (prefix: string, runIds: Set<number>) => artifacts.artifacts
        .filter((artifact) =>
          !artifact.expired
          && artifact.name.startsWith(prefix)
          && artifact.workflow_run
          && runIds.has(artifact.workflow_run.id)
        )
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      const latestServerArtifact = matchingArtifacts(serverPrefix, successfulServerRuns)[0];
      const latestIosArtifact = matchingArtifacts(iosPrefix, successfulIosRuns)[0];
      const serverSha = latestServerArtifact?.name.slice(serverPrefix.length);
      const iosSha = latestIosArtifact?.name.slice(iosPrefix.length);
      const validSha = (value: string | undefined): value is string =>
        Boolean(value && /^[0-9a-f]{40}$/i.test(value));
      if (!validSha(serverSha) || !validSha(iosSha) || serverSha !== iosSha) {
        return commandError('VALIDATION', 'App Store submission is blocked by mismatched or missing release evidence.', {
          details: {
            environment: environmentName,
            server: latestServerArtifact
              ? {
                runId: latestServerArtifact.workflow_run?.id,
                artifactId: latestServerArtifact.id,
                sha: serverSha,
              }
              : null,
            mobile: latestIosArtifact
              ? {
                runId: latestIosArtifact.workflow_run?.id,
                artifactId: latestIosArtifact.id,
                sha: iosSha,
              }
              : null,
          },
          hint: 'Run the managed server deploy and iOS release workflows for the same commit, verify them with hv_ci_status, then retry.',
        });
      }
      const adapter = adapterOrThrow(appIdentifier, project.name);

      const app = await adapter.findAppByBundleId(appIdentifier);
      if (!app) {
        return commandError('NOT_FOUND', `App not found for bundle ID: ${appIdentifier}.`, {
          hint: 'Create the app in App Store Connect first.',
        });
      }

      const version = await adapter.getEditableAppStoreVersion(app.id, resolvedPlatform);
      if (!version) {
        const versions = await adapter.listAppStoreVersions(app.id, { platform: resolvedPlatform, limit: 5 });
        return commandError('VALIDATION', 'No version ready for submission. Create a new version in App Store Connect with state PREPARE_FOR_SUBMISSION.', {
          details: { currentVersions: versions.map((v) => ({ version: v.versionString, state: v.appStoreState, platform: v.platform })) },
        });
      }

      const build = await adapter.getAppStoreVersionBuild(version.id);
      if (!build) {
        return commandError('VALIDATION', `Version ${version.versionString} has no build attached. Select a build in App Store Connect first.`, {
          details: { version: { versionString: version.versionString, state: version.appStoreState } },
          hint: 'Run the managed iOS release workflow declared by ios.release, then attach the processed build to the version.',
        });
      }

      const { reviewSubmission, reusedExistingSubmission } = await adapter.submitForReview({
        appId: app.id,
        appStoreVersionId: version.id,
        platform: version.platform,
      });
      ctx.repos.audit.create({
        action: 'appstore.submit',
        resourceType: 'appstore',
        resourceId: app.id,
        details: {
          appIdentifier,
          environment: environmentName,
          releaseSha: iosSha,
          serverRunId: latestServerArtifact.workflow_run?.id,
          iosRunId: latestIosArtifact.workflow_run?.id,
          version: version.versionString,
          buildNumber: build.version,
          reviewSubmissionId: reviewSubmission.id,
        },
      });

      return commandSuccess({
        message: 'App submitted for App Store review',
        app,
        version: { id: version.id, versionString: version.versionString, previousState: version.appStoreState },
        build: { id: build.id, buildNumber: build.version },
        reviewSubmission: { id: reviewSubmission.id, state: reviewSubmission.state, reusedExistingSubmission },
        releaseGate: {
          environment: environmentName,
          sha: iosSha,
          serverRunId: latestServerArtifact.workflow_run?.id,
          iosRunId: latestIosArtifact.workflow_run?.id,
          serverArtifactId: latestServerArtifact.id,
          iosArtifactId: latestIosArtifact.id,
        },
      });
    })
  );

}
