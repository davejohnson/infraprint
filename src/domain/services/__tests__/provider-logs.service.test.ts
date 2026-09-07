import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import { adapterFactory } from '../adapter.factory.js';
import {
  detectProviderName,
  fetchProviderDeployments,
  fetchProviderLogs,
  isErrorLike,
  ProviderLogsReadError,
  supportsLogsBuildProvider,
  supportsLogsDeploymentsProvider,
} from '../provider-logs.service.js';

const now = new Date('2026-09-04T00:00:00.000Z');
const project: Project = {
  id: 'project-id',
  name: 'logs-app',
  defaultPlatform: 'railway',
  policies: {},
  createdAt: now,
  updatedAt: now,
};
const environment: Environment = {
  id: 'environment-id',
  projectId: project.id,
  name: 'staging',
  platformBindings: {
    provider: 'railway',
    projectId: 'railway-project',
    environmentId: 'railway-environment',
    services: {
      web: { serviceId: 'railway-web' },
      worker: { serviceId: 'railway-worker' },
    },
  },
  createdAt: now,
  updatedAt: now,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider-logs.service helpers', () => {
  describe('detectProviderName', () => {
    it('prefers explicit provider from bindings', () => {
      expect(detectProviderName('railway', 'cloudrun')).toBe('cloudrun');
    });

    it('falls back to project default platform', () => {
      expect(detectProviderName('vercel', undefined)).toBe('vercel');
    });

    it('reports unconfigured when no provider is available', () => {
      expect(detectProviderName(undefined, undefined)).toBe('unconfigured');
    });
  });

  describe('isErrorLike', () => {
    it('detects error by severity across provider vocabularies', () => {
      for (const severity of [
        'warn',
        'WARNING',
        'err',
        'ERROR',
        'CRITICAL',
        'ALERT',
        'EMERGENCY',
        'fatal',
      ]) {
        expect(isErrorLike({ timestamp: '', severity, message: 'otherwise benign' }), severity).toBe(true);
      }
      expect(isErrorLike({ timestamp: '', severity: 'NOTICE', message: 'otherwise benign' })).toBe(false);
    });

    it('detects error by message keywords', () => {
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'Unhandled exception occurred' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'deploy failed due to timeout' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'SequelizeConnectionRefusedError: connect ECONNREFUSED 127.0.0.1:5432' })).toBe(true);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'service is healthy' })).toBe(false);
    });

    it('ignores benign filenames and zero-error summaries', () => {
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'Loading model: exception.js' })).toBe(false);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: 'Checks complete: 0 errors' })).toBe(false);
      expect(isErrorLike({ timestamp: '', severity: 'info', message: '0 errors, 0 failures' })).toBe(false);
    });
  });

  describe('provider support matrix', () => {
    it('matches deployments provider support contract', () => {
      expect(supportsLogsDeploymentsProvider('railway')).toBe(true);
      expect(supportsLogsDeploymentsProvider('cloudrun')).toBe(true);
      expect(supportsLogsDeploymentsProvider('vercel')).toBe(false);
    });

    it('matches build provider support contract', () => {
      expect(supportsLogsBuildProvider('railway')).toBe(true);
      expect(supportsLogsBuildProvider('cloudrun')).toBe(false);
      expect(supportsLogsBuildProvider('vercel')).toBe(false);
    });
  });

  describe('service log contract', () => {
    it('filters error-like entries and requests a bounded scan when errorsOnly is true', async () => {
      const readProviderLogs = vi.fn(async () => ({
        logs: [
          ...Array.from({ length: 50 }, (_, index) => ({
            timestamp: `2026-09-03T00:${String(index).padStart(2, '0')}:00Z`,
            severity: 'info',
            message: `poll ${index}`,
          })),
          {
            timestamp: '2026-09-03T01:00:00Z',
            severity: 'error',
            message: 'worker failed',
          },
        ],
      }));
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
        success: true,
        adapter: { readProviderLogs } as never,
      });

      const result = await fetchProviderLogs('railway', project, environment, 'worker', 50, { errorsOnly: true });

      expect(readProviderLogs).toHaveBeenCalledWith({
        environment,
        serviceName: 'worker',
        limit: 500,
        errorsOnly: true,
      });
      expect(result.logs).toEqual([{
        timestamp: '2026-09-03T01:00:00Z',
        severity: 'error',
        message: 'worker failed',
      }]);
    });

    it('forwards the exact service and requested limit for an unfiltered read', async () => {
      const readProviderLogs = vi.fn(async () => ({ logs: [] }));
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
        success: true,
        adapter: { readProviderLogs } as never,
      });

      await fetchProviderLogs('railway', project, environment, 'worker', 37);

      expect(readProviderLogs).toHaveBeenCalledWith({
        environment,
        serviceName: 'worker',
        limit: 37,
        errorsOnly: undefined,
      });
    });

    it('enforces the requested output limit even when a provider returns too many records', async () => {
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
        success: true,
        adapter: {
          readProviderLogs: vi.fn(async () => ({
            logs: Array.from({ length: 51 }, (_, index) => ({
              timestamp: `2026-09-03T00:${String(index).padStart(2, '0')}:00Z`,
              severity: 'error',
              message: `error ${index}`,
            })),
          })),
        } as never,
      });

      const result = await fetchProviderLogs('railway', project, environment, 'worker', 50, { errorsOnly: true });

      expect(result.logs).toHaveLength(50);
      expect(result.logs[0]?.message).toBe('error 1');
      expect(result.logs[49]?.message).toBe('error 50');
    });

    it('preserves the provider operation and underlying network cause', async () => {
      const networkCause = Object.assign(new Error('getaddrinfo ENOTFOUND backboard.railway.app'), {
        code: 'ENOTFOUND',
      });
      const fetchError = Object.assign(new TypeError('fetch failed'), { cause: networkCause });
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
        success: true,
        adapter: {
          readProviderLogs: vi.fn(async () => { throw fetchError; }),
        } as never,
      });

      const failure = await fetchProviderLogs('railway', project, environment, 'worker', 50)
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(ProviderLogsReadError);
      expect(failure).toMatchObject({
        provider: 'railway',
        operation: 'service log read',
        details: {
          message: 'fetch failed',
          cause: 'getaddrinfo ENOTFOUND backboard.railway.app',
          causeCode: 'ENOTFOUND',
        },
      });
    });
  });

  describe('provider-neutral adapter boundary', () => {
    it('hard-bounds deployment results even when the provider over-returns', async () => {
      const listProviderDeployments = vi.fn(async () => [
        { id: 'deployment-1', status: 'deployed' },
        { id: 'deployment-2', status: 'deployed' },
        { id: 'deployment-3', status: 'deployed' },
      ]);
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
        success: true,
        adapter: { listProviderDeployments } as never,
      });

      await expect(fetchProviderDeployments(
        'railway',
        project,
        environment,
        'web',
        2
      )).resolves.toEqual([
        { id: 'deployment-1', status: 'deployed' },
        { id: 'deployment-2', status: 'deployed' },
      ]);
      expect(listProviderDeployments).toHaveBeenCalledWith({
        environment,
        serviceName: 'web',
        limit: 2,
      });
    });

    it('does not recognize legacy concrete-provider method combinations as a log port', async () => {
      vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
        success: true,
        adapter: {
          getDeployments: vi.fn(),
          getDeploymentLogs: vi.fn(),
        } as never,
      });

      await expect(fetchProviderLogs(
        'railway',
        project,
        environment,
        'web',
        10
      )).rejects.toMatchObject({
        name: 'NotSupportedError',
        provider: 'railway',
        capability: 'log reads',
      });
    });
  });
});
