import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StripeProjectsAdapter,
  type StripeProjectsCliRunner,
  type StripeProjectsCliResult,
} from '../stripe-projects.adapter.js';

let tempDirectory: string;

function success(data: unknown): StripeProjectsCliResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, data }),
  };
}

function makeRunner(
  handler: (args: string[]) => StripeProjectsCliResult
): StripeProjectsCliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      return handler(args);
    },
  };
}

function standardRunner(configurations: unknown[] = [{
  resource_id: 'resource_1',
  access_configuration_keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_WORKERS_ACCOUNT_ID'],
  access_configuration: {
    CLOUDFLARE_API_TOKEN: '••••••••',
    CLOUDFLARE_WORKERS_ACCOUNT_ID: '••••••••',
  },
}]): StripeProjectsCliRunner & { calls: string[][] } {
  return makeRunner((args) => {
    if (args.slice(0, 4).join(' ') === 'projects env show --json') {
      return success({ name: 'production', output: '.env.production', resources: ['workers'], active: true });
    }
    return success({ resource_access_configurations: configurations });
  });
}

async function connectedAdapter(runner: StripeProjectsCliRunner): Promise<StripeProjectsAdapter> {
  const adapter = new StripeProjectsAdapter({ cwd: tempDirectory, runner });
  await adapter.connect({ authMode: 'default' });
  return adapter;
}

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-stripe-projects-'));
  fs.mkdirSync(path.join(tempDirectory, '.projects'));
  const output = path.join(tempDirectory, '.env.production');
  fs.writeFileSync(output, [
    'CLOUDFLARE_API_TOKEN=cfat_local_secret',
    'CLOUDFLARE_WORKERS_ACCOUNT_ID=account_123',
    'UNRELATED_SECRET=must_not_be_selected',
    '',
  ].join('\n'));
  fs.chmodSync(output, 0o600);
});

afterEach(() => {
  fs.rmSync(tempDirectory, { force: true, recursive: true });
});

describe('StripeProjectsAdapter', () => {
  it('selects only fields declared for one service without running mutating commands', async () => {
    const runner = standardRunner();
    const adapter = await connectedAdapter(runner);

    const resolved = await adapter.getSecret('production/cloudflare/workers');

    expect(JSON.parse(resolved.value)).toEqual({
      CLOUDFLARE_API_TOKEN: 'cfat_local_secret',
      CLOUDFLARE_WORKERS_ACCOUNT_ID: 'account_123',
    });
    expect(resolved.value).not.toContain('must_not_be_selected');
    expect(runner.calls).toEqual([
      ['projects', 'env', 'show', '--json', '--non-interactive'],
      ['projects', 'env', '--service', 'cloudflare/workers', '--json', '--non-interactive'],
    ]);
    expect(runner.calls.flat()).not.toContain('--pull');
    expect(runner.calls.flat()).not.toContain('--refresh');
    expect(runner.calls.flat()).not.toContain('use');
  });

  it('supports a field fragment and metadata-only listing', async () => {
    const runner = standardRunner();
    const adapter = await connectedAdapter(runner);

    const resolved = await adapter.getSecret(
      'production/cloudflare/workers',
      'CLOUDFLARE_API_TOKEN'
    );
    const listed = await adapter.listSecrets('production/cloudflare/workers');

    expect(resolved.value).toBe('cfat_local_secret');
    expect(listed).toEqual([{
      path: 'production/cloudflare/workers',
      keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_WORKERS_ACCOUNT_ID'],
    }]);
  });

  it('does not require unrelated service fields when one field is selected', async () => {
    fs.writeFileSync(path.join(tempDirectory, '.env.production'), 'CLOUDFLARE_API_TOKEN=cfat_local_secret\n');
    fs.chmodSync(path.join(tempDirectory, '.env.production'), 0o600);
    const adapter = await connectedAdapter(standardRunner());

    await expect(adapter.getSecret(
      'production/cloudflare/workers',
      'CLOUDFLARE_API_TOKEN'
    )).resolves.toEqual({ value: 'cfat_local_secret' });
  });

  it('blocks a reference to an environment that is not active', async () => {
    const adapter = await connectedAdapter(standardRunner());

    await expect(adapter.getSecret('staging/cloudflare/workers')).rejects.toThrow(
      'is not active (active: "production")'
    );
  });

  it('blocks duplicate service identities instead of choosing one', async () => {
    const configuration = {
      resource_id: 'resource_1',
      access_configuration_keys: ['CLOUDFLARE_API_TOKEN'],
    };
    const adapter = await connectedAdapter(standardRunner([
      configuration,
      { ...configuration, resource_id: 'resource_2' },
    ]));

    await expect(adapter.getSecret('production/cloudflare/workers')).rejects.toThrow(
      'multiple matching resource configurations'
    );
  });

  it('blocks output paths outside the linked project root', async () => {
    const runner = makeRunner((args) => args.includes('show')
      ? success({ name: 'production', output: '../outside.env', active: true })
      : success({
        resource_access_configurations: [{ access_configuration_keys: ['CLOUDFLARE_API_TOKEN'] }],
      }));
    const adapter = await connectedAdapter(runner);

    await expect(adapter.getSecret('production/cloudflare/workers')).rejects.toThrow(
      'must stay inside the project root'
    );
  });

  it('blocks symbolic-link and overly permissive output files', async () => {
    if (process.platform === 'win32') return;

    const output = path.join(tempDirectory, '.env.production');
    const target = path.join(tempDirectory, '.env.target');
    fs.renameSync(output, target);
    fs.symlinkSync(target, output);
    const symlinkAdapter = await connectedAdapter(standardRunner());
    await expect(symlinkAdapter.getSecret('production/cloudflare/workers')).rejects.toThrow(
      'regular, non-symbolic-link file'
    );

    fs.unlinkSync(output);
    fs.renameSync(target, output);
    fs.chmodSync(output, 0o644);
    const permissionsAdapter = await connectedAdapter(standardRunner());
    await expect(permissionsAdapter.getSecret('production/cloudflare/workers')).rejects.toThrow(
      'owner-only (chmod 600)'
    );
  });

  it('never includes raw CLI output or error messages in an error', async () => {
    const secret = 'cfat_must_never_cross_the_boundary';
    const runner = makeRunner(() => ({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'LOCAL_ENV_CACHE_MISSING', message: `provider returned ${secret}` },
      }),
    }));
    const adapter = await connectedAdapter(runner);

    let message = '';
    try {
      await adapter.getSecret('production/cloudflare/workers');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('LOCAL_ENV_CACHE_MISSING');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('provider returned');
  });
});
