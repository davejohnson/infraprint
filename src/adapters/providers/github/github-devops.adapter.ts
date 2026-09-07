import { GitHubAdapter, GitHubApiError } from './github.adapter.js';
import type {
  CiArtifactSummary,
  CiDispatchRequest,
  CiJobSummary,
  CiOperationsPort,
  CiPhase,
  CiRunSummary,
  CodeHostIdentityPort,
  CodeRepositoryIdentity,
} from '../../../domain/ports/devops.port.js';
import type { Observation } from '../../../domain/ports/provider-observation.js';

function repositoryParts(identity: CodeRepositoryIdentity): [string, string] {
  const parts = identity.path.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Invalid GitHub repository identity ${identity.path}`);
  return [parts[0], parts[1]];
}

function phase(status: string, conclusion?: string | null): CiPhase {
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested') return 'queued';
  if (status === 'in_progress') return 'running';
  if (status !== 'completed') return 'unknown';
  switch (conclusion) {
    case 'success': return 'succeeded';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure': return 'failed';
    case 'cancelled': return 'canceled';
    case 'skipped':
    case 'neutral': return 'skipped';
    default: return 'unknown';
  }
}

export class GitHubCodeHostIdentityAdapter implements CodeHostIdentityPort {
  constructor(private readonly adapter: GitHubAdapter) {}

  async observeRepository(scope: string): Promise<Observation<CodeRepositoryIdentity>> {
    const parts = scope.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { state: 'unknown', reason: `GitHub scope must be owner/repository, got ${scope}` };
    }
    try {
      const repository = await this.adapter.getRepository(parts[0], parts[1]);
      const path = repository.full_name ?? `${parts[0]}/${parts[1]}`;
      const webUrl = repository.html_url ?? `https://github.com/${path}`;
      return {
        state: 'present',
        value: {
          provider: 'github',
          nativeId: repository.id === undefined ? path : String(repository.id),
          instanceScope: 'https://github.com',
          canonicalScope: webUrl,
          path,
          defaultBranch: repository.default_branch,
          webUrl,
          cloneUrls: [
            repository.clone_url ?? `${webUrl}.git`,
            repository.ssh_url ?? `git@github.com:${path}.git`,
          ],
        },
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return { state: 'absent' };
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

export class GitHubActionsOperationsAdapter implements CiOperationsPort {
  constructor(private readonly adapter: GitHubAdapter) {}

  async listDefinitions(repository: CodeRepositoryIdentity) {
    const [owner, repo] = repositoryParts(repository);
    const response = await this.adapter.listWorkflows(owner, repo);
    return response.workflows.map((workflow) => ({
      id: String(workflow.id),
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
    }));
  }

  async listRuns(repository: CodeRepositoryIdentity, definition: string, limit: number): Promise<CiRunSummary[]> {
    const [owner, repo] = repositoryParts(repository);
    const response = await this.adapter.listWorkflowRuns(owner, repo, definition, { per_page: Math.min(Math.max(limit, 1), 100) });
    return response.workflow_runs.map((run) => ({
      id: String(run.id),
      name: run.name,
      phase: phase(run.status, run.conclusion),
      nativeStatus: run.conclusion ?? run.status,
      sha: run.head_sha,
      ref: run.head_branch,
      source: run.event,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      webUrl: run.html_url,
    }));
  }

  async listJobs(repository: CodeRepositoryIdentity, runId: string, limit: number): Promise<CiJobSummary[]> {
    const [owner, repo] = repositoryParts(repository);
    const response = await this.adapter.listWorkflowRunJobs(owner, repo, runId, { per_page: Math.min(Math.max(limit, 1), 100) });
    return response.jobs.map((job) => ({
      id: String(job.id),
      name: job.name,
      phase: phase(job.status, job.conclusion),
      nativeStatus: job.conclusion ?? job.status,
      ...(job.started_at ? { startedAt: job.started_at } : {}),
      ...(job.completed_at ? { completedAt: job.completed_at } : {}),
      webUrl: job.html_url,
    }));
  }

  async getJobLog(repository: CodeRepositoryIdentity, jobId: string): Promise<string> {
    const [owner, repo] = repositoryParts(repository);
    return this.adapter.getWorkflowJobLogs(owner, repo, jobId);
  }

  async listArtifacts(repository: CodeRepositoryIdentity, runId?: string, limit = 100): Promise<CiArtifactSummary[]> {
    const [owner, repo] = repositoryParts(repository);
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const response = runId
      ? await this.adapter.listWorkflowRunArtifacts(owner, repo, runId)
      : await this.adapter.listArtifacts(owner, repo, boundedLimit);
    return response.artifacts.slice(0, boundedLimit).map((artifact) => ({
      id: String(artifact.id),
      name: artifact.name,
      ...(artifact.workflow_run ? { runId: String(artifact.workflow_run.id) } : {}),
      expired: artifact.expired,
      createdAt: artifact.created_at,
    }));
  }

  async dispatch(repository: CodeRepositoryIdentity, request: CiDispatchRequest): Promise<CiRunSummary> {
    const [owner, repo] = repositoryParts(repository);
    if (request.sha) {
      const ref = await this.adapter.getRef(owner, repo, `heads/${request.ref}`);
      if (!ref || ref.object.sha !== request.sha) throw new Error(`GitHub ref ${request.ref} is not at reviewed commit ${request.sha}`);
    }
    await this.adapter.triggerWorkflow(
      owner,
      repo,
      request.definition,
      request.ref,
      request.inputs
        ? Object.fromEntries(Object.entries(request.inputs).map(([key, value]) => [key, String(value)]))
        : undefined
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      const runs = await this.listRuns(repository, request.definition, 20);
      const observed = runs.find((run) => run.ref === request.ref && (!request.sha || run.sha === request.sha));
      if (observed) return observed;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error('GitHub accepted the workflow dispatch but its exact run identity could not yet be observed; do not retry blindly, inspect runs first');
  }
}
