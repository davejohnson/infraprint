import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { getProjectScopeHints } from './project-scope.js';
import { parseGitHubRepoFromRemote, normalizeGitRemoteForBuild } from '../../lib/git-remote.js';
import type { Project } from '../entities/project.entity.js';
import type { BuildConfig, WorkloadKind } from '../entities/service.entity.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import type { DesiredState } from './spec.service.js';

const connectionRepo = new ConnectionRepository();

export interface GitDeploySource {
  repo: string;
  branch: string;
}

export function classifyDeployEnvironment(environmentName: string): 'staging' | 'production' | null {
  const normalized = environmentName.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod' || normalized.includes('prod')) {
    return 'production';
  }
  if (normalized === 'staging' || normalized === 'stage' || normalized.includes('stag')) {
    return 'staging';
  }
  return null;
}

export function resolveGitDeploySource(
  project: { gitRemoteUrl?: string },
  environmentName: string,
  deploy?: DesiredState['deploy']
): { source: GitDeploySource | null; error?: string } {
  if (deploy?.strategy !== 'branch') {
    return { source: null };
  }

  const kind = classifyDeployEnvironment(environmentName);
  if (!deploy.branch && deploy.branches && !kind) {
    return {
      source: null,
      error: `Legacy staging/production branch mapping cannot select a branch for environment "${environmentName}". Set deploy.branch explicitly.`,
    };
  }

  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    return {
      source: null,
      error: 'Project gitRemoteUrl is missing or is not a GitHub remote, so Railway repo-linked deploys cannot be configured.',
    };
  }

  const branch = deploy.branch
    ?? (kind === 'production' ? deploy.branches?.production : undefined)
    ?? (kind === 'staging' ? deploy.branches?.staging : undefined)
    ?? 'main';

  return {
    source: {
      repo,
      branch,
    },
  };
}

export function buildDeploySourceEnvVars(project: Project, adapterName: string): Record<string, string> {
  const sourceRepoUrl = normalizeGitRemoteForBuild(project.gitRemoteUrl);
  if (!sourceRepoUrl) {
    return {};
  }

  const sourceEnvVars: Record<string, string> = {
    HYPERVIBE_SOURCE_REPO_URL: sourceRepoUrl,
    HYPERVIBE_SOURCE_REVISION: 'main',
  };

  if (adapterName === 'cloudrun') {
    const githubConnection = connectionRepo.findBestMatchFromHints('github', getProjectScopeHints(project));
    if (githubConnection) {
      const githubCredentials = getSecretStore().decryptObject<GitHubCredentials>(githubConnection.credentialsEncrypted);
      if (githubCredentials.apiToken) {
        sourceEnvVars.HYPERVIBE_GITHUB_TOKEN = githubCredentials.apiToken;
      }
    }
  }

  return sourceEnvVars;
}

export function definedBuildConfigUpdates(updates: {
  workloadKind?: WorkloadKind;
  builder?: 'nixpacks' | 'dockerfile' | 'buildpack';
  dockerfilePath?: string;
  buildCommand?: string;
  startCommand?: string;
  releaseCommand?: string;
  healthCheckPath?: string;
  cronSchedule?: string;
  public?: boolean;
}): Partial<BuildConfig> {
  const buildConfig: Partial<BuildConfig> = {};
  for (const [key, value] of Object.entries(updates) as Array<[keyof BuildConfig, unknown]>) {
    if (value !== undefined) {
      buildConfig[key] = value as never;
    }
  }
  return buildConfig;
}
