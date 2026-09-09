import sodium from 'sodium-native';
import fs from 'fs';
import path from 'path';
import { createHmac, randomUUID, type Hmac } from 'crypto';
import {
  ensurePrivateDirectory,
  getDataDir,
  hardenPrivateFile,
  PRIVATE_FILE_MODE,
} from '../storage/paths.js';

const SECRET_DERIVATION_LABEL = 'hypervibe.secret-store.derived-secret.v1';
const MAX_DERIVATION_DOMAIN_BYTES = 128;
const MAX_DERIVATION_CONTEXT_FIELDS = 32;
const MAX_DERIVATION_CONTEXT_KEY_BYTES = 128;
const MAX_DERIVATION_CONTEXT_VALUE_BYTES = 4096;

function compareContextKeys(
  [left]: readonly [string, string],
  [right]: readonly [string, string]
): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function updateLengthPrefixedUtf8(
  hmac: Hmac,
  lengthBuffer: Buffer,
  value: string
): void {
  lengthBuffer.writeUInt32BE(Buffer.byteLength(value, 'utf-8'));
  hmac.update(lengthBuffer);
  hmac.update(value, 'utf-8');
}

export class SecretStore {
  private key: Buffer;
  private readonly dataDir: string;
  private readonly keyFile: string;
  private static instance: SecretStore | null = null;

  private constructor() {
    this.dataDir = getDataDir();
    this.keyFile = path.join(this.dataDir, '.secret-key');
    this.key = this.loadOrCreateKey();
  }

  static getInstance(): SecretStore {
    if (!SecretStore.instance) {
      SecretStore.instance = new SecretStore();
    }
    return SecretStore.instance;
  }

  static resetInstance(): void {
    SecretStore.instance?.key.fill(0);
    SecretStore.instance = null;
  }

  private parseKeyHex(keyHex: string, source: string): Buffer {
    const expectedCharacters = sodium.crypto_secretbox_KEYBYTES * 2;
    if (
      keyHex.length !== expectedCharacters
      || !/^[0-9a-fA-F]+$/.test(keyHex)
    ) {
      throw new Error(
        `${source} is corrupt (expected ${expectedCharacters} hexadecimal characters). Restore it from backup or set HYPERVIBE_SECRET_KEY; generating a new key would make existing encrypted data unrecoverable.`
      );
    }
    return Buffer.from(keyHex, 'hex');
  }

  private readStoredKey(): Buffer {
    hardenPrivateFile(this.keyFile);
    return this.parseKeyHex(
      fs.readFileSync(this.keyFile, 'utf-8').trim(),
      this.keyFile
    );
  }

  /**
   * Publish a complete key atomically without ever overwriting a key created
   * by another Hypervibe process. POSIX hard links make the fully-written temp
   * file visible in one operation; Windows uses an exclusive copy.
   */
  private publishNewKey(key: Buffer): boolean {
    const tempFile = path.join(
      this.dataDir,
      `.secret-key.tmp-${process.pid}-${randomUUID()}`
    );
    const descriptor = fs.openSync(
      tempFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      PRIVATE_FILE_MODE
    );
    try {
      fs.writeFileSync(descriptor, key.toString('hex'), 'utf-8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    hardenPrivateFile(tempFile);

    try {
      if (process.platform === 'win32') {
        fs.copyFileSync(tempFile, this.keyFile, fs.constants.COPYFILE_EXCL);
      } else {
        fs.linkSync(tempFile, this.keyFile);
      }
      hardenPrivateFile(this.keyFile);
      return true;
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && error.code === 'EEXIST'
      ) {
        return false;
      }
      throw error;
    } finally {
      fs.unlinkSync(tempFile);
    }
  }

  private loadOrCreateKey(): Buffer {
    // Externally injected key wins (CI, containers, key managers). Must be
    // the hex encoding of exactly crypto_secretbox_KEYBYTES bytes.
    const envKey = process.env.HYPERVIBE_SECRET_KEY?.trim();
    if (envKey) {
      return this.parseKeyHex(envKey, 'HYPERVIBE_SECRET_KEY');
    }

    ensurePrivateDirectory(this.dataDir);
    if (hardenPrivateFile(this.keyFile)) {
      return this.readStoredKey();
    }

    const key = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.randombytes_buf(key);
    if (!this.publishNewKey(key)) {
      key.fill(0);
      return this.readStoredKey();
    }

    // A fresh key alongside an existing database means previously encrypted
    // data (connections, component bindings) can never be decrypted again.
    if (fs.existsSync(path.join(this.dataDir, 'hypervibe.db'))) {
      console.error(
        `[hypervibe] WARNING: ${this.keyFile} was missing but ${this.dataDir}/hypervibe.db exists. `
        + 'A new encryption key was generated: previously encrypted connections and bindings are unrecoverable. '
        + 'Restore .secret-key from backup (or set HYPERVIBE_SECRET_KEY) and restart, or reconnect providers with hv_connections.'
      );
    }

    return key;
  }

  encrypt(plaintext: string): string {
    const message = Buffer.from(plaintext, 'utf-8');
    const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
    sodium.randombytes_buf(nonce);

    const ciphertext = Buffer.alloc(message.length + sodium.crypto_secretbox_MACBYTES);
    sodium.crypto_secretbox_easy(ciphertext, message, nonce, this.key);

    // Return nonce + ciphertext as base64
    const combined = Buffer.concat([nonce, ciphertext]);
    return combined.toString('base64');
  }

  decrypt(encrypted: string): string {
    const combined = Buffer.from(encrypted, 'base64');

    const nonce = combined.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.subarray(sodium.crypto_secretbox_NONCEBYTES);

    const decrypted = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES);
    const success = sodium.crypto_secretbox_open_easy(decrypted, ciphertext, nonce, this.key);

    if (!success) {
      throw new Error(
        'Failed to decrypt: authentication failed. The encryption key has likely changed '
        + '(.secret-key was regenerated or HYPERVIBE_SECRET_KEY differs from the key that encrypted this data). '
        + 'Restore the original key, or reconnect the affected providers with hv_connections.'
      );
    }

    return decrypted.toString('utf-8');
  }

  encryptObject(obj: unknown): string {
    return this.encrypt(JSON.stringify(obj));
  }

  decryptObject<T>(encrypted: string): T {
    return JSON.parse(this.decrypt(encrypted)) as T;
  }

  /**
   * Derive stable, opaque secret material without exposing the store's root
   * key. The versioned label and length-prefixed, sorted context make the
   * input encoding unambiguous; changing that encoding intentionally changes
   * every derived value.
   */
  deriveSecret(
    domain: string,
    context: Readonly<Record<string, string>>
  ): Buffer {
    const domainBytes = Buffer.byteLength(domain, 'utf-8');
    if (domainBytes === 0 || domainBytes > MAX_DERIVATION_DOMAIN_BYTES) {
      throw new Error(
        `Secret derivation domain must contain 1-${MAX_DERIVATION_DOMAIN_BYTES} UTF-8 bytes.`
      );
    }

    const entries = Object.entries(context).sort(compareContextKeys);
    if (
      entries.length === 0
      || entries.length > MAX_DERIVATION_CONTEXT_FIELDS
    ) {
      throw new Error(
        `Secret derivation context must contain 1-${MAX_DERIVATION_CONTEXT_FIELDS} fields.`
      );
    }

    for (const [key, value] of entries) {
      const keyBytes = Buffer.byteLength(key, 'utf-8');
      if (
        keyBytes === 0
        || keyBytes > MAX_DERIVATION_CONTEXT_KEY_BYTES
      ) {
        throw new Error(
          `Secret derivation context keys must contain 1-${MAX_DERIVATION_CONTEXT_KEY_BYTES} UTF-8 bytes.`
        );
      }
      if (typeof value !== 'string') {
        throw new Error('Secret derivation context values must be strings.');
      }
      if (Buffer.byteLength(value, 'utf-8') > MAX_DERIVATION_CONTEXT_VALUE_BYTES) {
        throw new Error(
          `Secret derivation context values must contain at most ${MAX_DERIVATION_CONTEXT_VALUE_BYTES} UTF-8 bytes.`
        );
      }
    }

    const hmac = createHmac('sha256', this.key);
    const lengthBuffer = Buffer.alloc(4);
    try {
      hmac.update(SECRET_DERIVATION_LABEL, 'utf-8');
      updateLengthPrefixedUtf8(hmac, lengthBuffer, domain);
      lengthBuffer.writeUInt32BE(entries.length);
      hmac.update(lengthBuffer);
      for (const [key, value] of entries) {
        updateLengthPrefixedUtf8(hmac, lengthBuffer, key);
        updateLengthPrefixedUtf8(hmac, lengthBuffer, value);
      }
      return hmac.digest();
    } finally {
      lengthBuffer.fill(0);
    }
  }
}

export function getSecretStore(): SecretStore {
  return SecretStore.getInstance();
}
