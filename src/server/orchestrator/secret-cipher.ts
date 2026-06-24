/**
 * SecretCipher — at-rest encryption for the secret/credential data ShipIt
 * persists (docs/220).
 *
 * Cipher: AES-256-GCM with a per-record random 12-byte IV and the 16-byte
 * GCM auth tag, using only `node:crypto` (no new dependency). Each encrypted
 * value is a self-describing string:
 *
 *     shipit:enc:v1:<base64( iv[12] || tag[16] || ciphertext )>
 *
 * The `shipit:enc:v1:` prefix is both a version marker and the migration
 * discriminator: `decrypt()` returns any value WITHOUT the prefix verbatim, so
 * a store seeded with legacy plaintext reads transparently and re-encrypts on
 * the next write (see SecretStore / CredentialStore).
 *
 * Key management lives in `resolveSecretCipher()` below — the cipher itself is
 * key-agnostic and just holds the 32-byte key it is handed.
 *
 * THREAT MODEL (see docs/220 plan):
 *   - Protects the persisted bytes when they are copied WITHOUT the key — a
 *     leaked SQLite dump, a backup of `shipit-credentials.json`, a value pasted
 *     into a bug report. This is the realistic at-rest leak after PR #1567
 *     closed the transport leak.
 *   - Does NOT protect against an attacker who can read the whole credentials
 *     volume (they get the auto-generated key file too). Operators who need
 *     that keep the key OFF the volume via `SHIPIT_SECRET_KEY` (see below).
 *   - Out of scope: provider OAuth CLI credential files under
 *     `provider-accounts/<provider>/acct_*` — ShipIt doesn't own their format
 *     (the provider CLIs write them); they already live at mode 0600 in the
 *     credentials volume.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Version-tagged prefix on every ciphertext. Bump the suffix to rotate format. */
export const ENC_PREFIX = "shipit:enc:v1:";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length

/** True when `value` is a SecretCipher ciphertext (vs legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export class SecretCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `[secret-cipher] key must be ${KEY_BYTES} bytes, got ${key.length}`,
      );
    }
    this.key = key;
  }

  /** Encrypt a UTF-8 string into the `shipit:enc:v1:<base64>` envelope. */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  /**
   * Decrypt a value produced by `encrypt()`. A value WITHOUT the `ENC_PREFIX`
   * is returned verbatim — that is the transparent-plaintext migration path,
   * NOT an error.
   *
   * Throws on a tampered ciphertext or a wrong/rotated key (GCM auth-tag
   * mismatch). Callers MUST let this propagate: swallowing it and falling back
   * to an empty value would let the next write overwrite real data — exactly
   * the silent-wipe the design forbids. Fail closed instead.
   */
  decrypt(value: string): string {
    if (!isEncrypted(value)) return value;
    const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new Error("[secret-cipher] ciphertext too short — corrupt record");
    }
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
  }
}

/** Default basename of the auto-generated key file inside the credentials dir. */
export const SECRET_KEY_FILENAME = "secret-key";

/**
 * Parse a user-supplied `SHIPIT_SECRET_KEY` into a 32-byte buffer. Accepts a
 * 64-char hex string or a base64 string (with or without an explicit
 * `base64:` / `hex:` scheme prefix). Throws a clear error on anything that
 * doesn't decode to exactly 32 bytes — we fail closed at boot rather than
 * silently truncate or pad a malformed key.
 */
export function parseSecretKey(raw: string): Buffer {
  const trimmed = raw.trim();
  let body = trimmed;
  let scheme: "hex" | "base64" | undefined;
  if (trimmed.startsWith("hex:")) {
    scheme = "hex";
    body = trimmed.slice(4);
  } else if (trimmed.startsWith("base64:")) {
    scheme = "base64";
    body = trimmed.slice(7);
  }

  let buf: Buffer;
  if (scheme === "hex" || (!scheme && /^[0-9a-fA-F]{64}$/.test(body))) {
    buf = Buffer.from(body, "hex");
  } else {
    buf = Buffer.from(body, "base64");
  }

  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `[secret-cipher] SHIPIT_SECRET_KEY must decode to ${KEY_BYTES} bytes ` +
        `(got ${buf.length}). Provide 64 hex chars or a 32-byte base64 value.`,
    );
  }
  return buf;
}

/**
 * Resolve the encryption key and build a SecretCipher, or return `null` when
 * encryption is explicitly disabled (`SHIPIT_SECRET_ENCRYPTION=0|false|off`).
 *
 * Key source precedence (first match wins):
 *   1. `SHIPIT_SECRET_KEY` env var — an externally-managed key (Docker secret,
 *      KMS-injected, etc.). Malformed ⇒ throw at boot (fail closed).
 *   2. A key file at `SHIPIT_SECRET_KEY_FILE` (default
 *      `<credentialsDir>/secret-key`, mode 0600). Present-but-unreadable or
 *      wrong-size ⇒ throw (fail closed — never regenerate over an existing key,
 *      which would orphan all data encrypted under it).
 *   3. No key anywhere ⇒ generate a fresh 32-byte key, persist it to the key
 *      file (mode 0600), and use it. This is the zero-config self-hoster
 *      default: the key lives beside the data on the same credentials volume.
 */
export function resolveSecretCipher(opts: {
  credentialsDir: string;
}): SecretCipher | null {
  const flag = process.env.SHIPIT_SECRET_ENCRYPTION?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    console.warn(
      "[secret-cipher] Encryption DISABLED via SHIPIT_SECRET_ENCRYPTION — " +
        "secrets and credentials are stored in plaintext.",
    );
    return null;
  }

  const envKey = process.env.SHIPIT_SECRET_KEY;
  if (envKey?.trim()) {
    // Throws on a malformed key — a clear boot failure, not a silent fallback.
    const key = parseSecretKey(envKey);
    console.log("[secret-cipher] Using encryption key from SHIPIT_SECRET_KEY.");
    return new SecretCipher(key);
  }

  const keyPath =
    process.env.SHIPIT_SECRET_KEY_FILE ??
    path.join(opts.credentialsDir, SECRET_KEY_FILENAME);

  if (fs.existsSync(keyPath)) {
    let key: Buffer;
    try {
      key = parseSecretKey(fs.readFileSync(keyPath, "utf8"));
    } catch (err) {
      // Wrong size / unreadable. Do NOT regenerate — that would orphan every
      // record already encrypted under the existing key. Fail closed loudly.
      throw new Error(
        `[secret-cipher] Failed to load encryption key from ${keyPath}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          "Refusing to regenerate over an existing key file.",
        { cause: err },
      );
    }
    console.log(`[secret-cipher] Loaded encryption key from ${keyPath}.`);
    return new SecretCipher(key);
  }

  // No key configured anywhere — generate and persist one (zero-config default).
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    // Exclusive create (`wx`) closes the TOCTOU window between the `existsSync`
    // check above and this write: if a second orchestrator sharing a fresh
    // credentials volume raced us to the key file, `openSync` throws EEXIST and
    // we adopt the winner's key below — rather than overwriting it and orphaning
    // any data the winner already encrypted under it.
    const fd = fs.openSync(keyPath, "wx", 0o600);
    try {
      fs.writeSync(fd, `${key.toString("base64")}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(keyPath, 0o600);
    console.log(
      `[secret-cipher] Generated a new encryption key at ${keyPath} (mode 0600). ` +
        "Back up this file — losing it makes encrypted secrets unrecoverable.",
    );
    return new SecretCipher(key);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Lost the create race — adopt the key the winner persisted.
    const existing = parseSecretKey(fs.readFileSync(keyPath, "utf8"));
    console.log(`[secret-cipher] Adopted a concurrently-created key at ${keyPath}.`);
    return new SecretCipher(existing);
  }
}
