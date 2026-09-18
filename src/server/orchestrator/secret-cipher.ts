import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ENC_PREFIX = "shipit:enc:v1:";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

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

  // Accept legacy plaintext. Propagate decryption errors: an empty fallback risks overwriting data.
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

export const SECRET_KEY_FILENAME = "secret-key";

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

// The generated key shares the credentials volume; use an external key to protect a whole-volume copy.
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

  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    // Never overwrite a concurrent creator's key: it may already have encrypted data.
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
    const existing = parseSecretKey(fs.readFileSync(keyPath, "utf8"));
    console.log(`[secret-cipher] Adopted a concurrently-created key at ${keyPath}.`);
    return new SecretCipher(existing);
  }
}
