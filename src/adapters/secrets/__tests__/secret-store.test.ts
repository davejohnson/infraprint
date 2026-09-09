import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, getSecretStore } from '../secret-store.js';
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from '../../storage/paths.js';

const originalDataDir = process.env.HYPERVIBE_DATA_DIR;
const originalSecretKey = process.env.HYPERVIBE_SECRET_KEY;
let dataDir: string;

function mode(filePath: string): number {
  return lstatSync(filePath).mode & 0o777;
}

beforeEach(() => {
  SecretStore.resetInstance();
  dataDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-secret-store-'));
  process.env.HYPERVIBE_DATA_DIR = dataDir;
  delete process.env.HYPERVIBE_SECRET_KEY;
});

afterEach(() => {
  SecretStore.resetInstance();
  if (originalDataDir === undefined) {
    delete process.env.HYPERVIBE_DATA_DIR;
  } else {
    process.env.HYPERVIBE_DATA_DIR = originalDataDir;
  }
  if (originalSecretKey === undefined) {
    delete process.env.HYPERVIBE_SECRET_KEY;
  } else {
    process.env.HYPERVIBE_SECRET_KEY = originalSecretKey;
  }
});

describe.skipIf(process.platform === 'win32')('SecretStore local key security', () => {
  it('creates an owner-only key and preserves authenticated encryption', () => {
    chmodSync(dataDir, 0o755);

    const store = getSecretStore();
    const encrypted = store.encrypt('private test value');

    expect(store.decrypt(encrypted)).toBe('private test value');
    expect(mode(dataDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(path.join(dataDir, '.secret-key'))).toBe(PRIVATE_FILE_MODE);
    expect(statSync(path.join(dataDir, '.secret-key')).size).toBe(64);
  });

  it('repairs permissive permissions on an existing key and directory', () => {
    const keyFile = path.join(dataDir, '.secret-key');
    chmodSync(dataDir, 0o755);
    writeFileSync(keyFile, '00'.repeat(32), { mode: 0o644 });

    getSecretStore();

    expect(mode(dataDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(mode(keyFile)).toBe(PRIVATE_FILE_MODE);
  });

  it('refuses to load a key through a symbolic link', () => {
    const target = path.join(dataDir, 'target-key');
    writeFileSync(target, '00'.repeat(32), { mode: 0o600 });
    symlinkSync(target, path.join(dataDir, '.secret-key'));

    expect(() => getSecretStore()).toThrow(/symbolic link/i);
  });

  it('rejects malformed injected keys without echoing their value', () => {
    process.env.HYPERVIBE_SECRET_KEY = 'not-a-valid-key';

    expect(() => getSecretStore()).toThrow(
      /HYPERVIBE_SECRET_KEY is corrupt.*64 hexadecimal characters/i
    );
  });
});

describe('SecretStore deterministic secret derivation', () => {
  it('matches the pinned version-one derivation vector', () => {
    process.env.HYPERVIBE_SECRET_KEY = '00'.repeat(32);

    const derived = getSecretStore().deriveSecret('application-secret', {
      environment: 'production',
      generation: '1',
      key: 'SESSION_SECRET',
      project: 'hypervibe',
    });

    expect(derived).toHaveLength(32);
    expect(derived.toString('hex')).toBe(
      '71c00c858b6e4e15f34b9e86c0e9afa826fadd1fae683fe894ab7878db2d17aa'
    );
    derived.fill(0);
  });

  it('is stable for canonically equivalent context', () => {
    process.env.HYPERVIBE_SECRET_KEY = '11'.repeat(32);
    const store = getSecretStore();
    const first = store.deriveSecret('application-secret', {
      project: 'hypervibe',
      environment: 'production',
    });
    const reordered = store.deriveSecret('application-secret', {
      environment: 'production',
      project: 'hypervibe',
    });

    expect(reordered).toEqual(first);
    first.fill(0);
    reordered.fill(0);
  });

  it('separates domains, context fields, and ambiguous concatenations', () => {
    process.env.HYPERVIBE_SECRET_KEY = '22'.repeat(32);
    const store = getSecretStore();
    const baseline = store.deriveSecret('application-secret', {
      environment: 'production',
      generation: '1',
      project: 'hypervibe',
    });
    const otherDomain = store.deriveSecret('other-secret', {
      environment: 'production',
      generation: '1',
      project: 'hypervibe',
    });
    const otherContext = store.deriveSecret('application-secret', {
      environment: 'staging',
      generation: '1',
      project: 'hypervibe',
    });
    const nextGeneration = store.deriveSecret('application-secret', {
      environment: 'production',
      generation: '2',
      project: 'hypervibe',
    });
    const firstBoundary = store.deriveSecret('application-secret', {
      first: 'ab',
      second: 'c',
    });
    const secondBoundary = store.deriveSecret('application-secret', {
      first: 'a',
      second: 'bc',
    });

    expect(otherDomain).not.toEqual(baseline);
    expect(otherContext).not.toEqual(baseline);
    expect(nextGeneration).not.toEqual(baseline);
    expect(secondBoundary).not.toEqual(firstBoundary);
    for (const secret of [
      baseline,
      otherDomain,
      otherContext,
      nextGeneration,
      firstBoundary,
      secondBoundary,
    ]) {
      secret.fill(0);
    }
  });

  it('derives the same material after reopening the persisted local key', () => {
    const first = getSecretStore().deriveSecret('application-secret', {
      environment: 'production',
      generation: '1',
      key: 'SESSION_SECRET',
      project: 'hypervibe',
    });

    SecretStore.resetInstance();
    const afterRestart = getSecretStore().deriveSecret('application-secret', {
      environment: 'production',
      generation: '1',
      key: 'SESSION_SECRET',
      project: 'hypervibe',
    });

    expect(afterRestart).toEqual(first);
    first.fill(0);
    afterRestart.fill(0);
  });
});
