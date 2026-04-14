import * as crypto from 'crypto';
import { config, loadServerConfig } from '../config';

// ── AES-256-GCM encryption for API keys ──────────────────────────────
//
// Derives an encryption key from the server's JWT secret via PBKDF2.
// Each value gets a unique random IV. Stored format:
//   enc:v1:<iv_base64>:<authTag_base64>:<ciphertext_base64>
//
// Backwards compatible: plaintext values (no "enc:v1:" prefix) are
// returned as-is by decrypt and auto-migrated on next save.

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;       // GCM recommended IV length
const TAG_BYTES = 16;      // GCM auth tag length
const KEY_BYTES = 32;      // AES-256
const PBKDF2_ITERATIONS = 100_000;
const SALT = 'tms-terminal-apikey-encryption-v1';
const PREFIX = 'enc:v1:';

let derivedKey: Buffer | null = null;

function getDerivedKey(): Buffer {
  if (derivedKey) return derivedKey;

  // Use the JWT secret as the source key material
  let secret = config.jwtSecret;
  if (!secret) {
    const saved = loadServerConfig();
    secret = saved.jwtSecret ?? '';
  }
  if (!secret) {
    throw new Error('Cannot encrypt: no JWT secret configured');
  }

  derivedKey = crypto.pbkdf2Sync(secret, SALT, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
  return derivedKey;
}

/** Reset the cached derived key (e.g. after JWT secret rotation). */
export function resetEncryptionKey(): void {
  derivedKey = null;
}

/** Encrypt a plaintext API key. Returns the "enc:v1:..." string. */
export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return plaintext;

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return PREFIX
    + iv.toString('base64') + ':'
    + authTag.toString('base64') + ':'
    + encrypted.toString('base64');
}

/** Decrypt an API key. If it's plaintext (no prefix), returns as-is. */
export function decryptApiKey(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored;

  const key = getDerivedKey();
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return '';

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');

  if (iv.length !== IV_BYTES || authTag.length !== TAG_BYTES) return '';

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed — wrong key or tampered data
    return '';
  }
}

/** Check if a value is already encrypted. */
export function isEncrypted(value: string): boolean {
  return !!value && value.startsWith(PREFIX);
}
