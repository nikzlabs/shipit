import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SecretCipher,
  resolveSecretCipher,
  parseSecretKey,
  isEncrypted,
  ENC_PREFIX,
  SECRET_KEY_FILENAME,
} from "./secret-cipher.js";

describe("SecretCipher", () => {
  const key = crypto.randomBytes(32);
  const cipher = new SecretCipher(key);

  it("round-trips a value through encrypt → decrypt", () => {
    const plaintext = "sk-super-secret-value-123";
    const enc = cipher.encrypt(plaintext);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).toMatch(new RegExp(`^${ENC_PREFIX}`));
    expect(enc).not.toContain(plaintext);
    expect(cipher.decrypt(enc)).toBe(plaintext);
  });

  it("produces a fresh IV per call (no deterministic ciphertext)", () => {
    const a = cipher.encrypt("same");
    const b = cipher.encrypt("same");
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe("same");
    expect(cipher.decrypt(b)).toBe("same");
  });

  it("handles unicode and empty strings", () => {
    for (const v of ["", "👋 héllo \n世界", "a".repeat(10_000)]) {
      expect(cipher.decrypt(cipher.encrypt(v))).toBe(v);
    }
  });

  it("returns legacy plaintext verbatim (migration path)", () => {
    expect(cipher.decrypt("plain-token")).toBe("plain-token");
    expect(cipher.decrypt("{\"json\":true}")).toBe("{\"json\":true}");
  });

  it("rejects a tampered ciphertext (auth-tag mismatch)", () => {
    const enc = cipher.encrypt("secret");
    // Flip a byte in the base64 body.
    const body = enc.slice(ENC_PREFIX.length);
    const raw = Buffer.from(body, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = ENC_PREFIX + raw.toString("base64");
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it("rejects decryption under the wrong key (no silent garbage)", () => {
    const enc = cipher.encrypt("secret");
    const other = new SecretCipher(crypto.randomBytes(32));
    expect(() => other.decrypt(enc)).toThrow();
  });

  it("rejects a too-short ciphertext", () => {
    expect(() => cipher.decrypt(ENC_PREFIX + Buffer.from("short").toString("base64"))).toThrow(
      /too short|corrupt/,
    );
  });

  it("rejects a key of the wrong size", () => {
    expect(() => new SecretCipher(crypto.randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe("parseSecretKey", () => {
  it("accepts 64-char hex", () => {
    const hex = crypto.randomBytes(32).toString("hex");
    expect(parseSecretKey(hex).length).toBe(32);
    expect(parseSecretKey(`hex:${hex}`).length).toBe(32);
  });

  it("accepts base64 (with and without scheme prefix)", () => {
    const b64 = crypto.randomBytes(32).toString("base64");
    expect(parseSecretKey(b64).length).toBe(32);
    expect(parseSecretKey(`base64:${b64}`).length).toBe(32);
  });

  it("throws on a key that doesn't decode to 32 bytes", () => {
    expect(() => parseSecretKey("tooshort")).toThrow(/32 bytes/);
    expect(() => parseSecretKey(crypto.randomBytes(16).toString("hex"))).toThrow(/32 bytes/);
  });
});

describe("resolveSecretCipher", () => {
  let tmpDir: string;
  const savedEnv = {
    key: process.env.SHIPIT_SECRET_KEY,
    keyFile: process.env.SHIPIT_SECRET_KEY_FILE,
    flag: process.env.SHIPIT_SECRET_ENCRYPTION,
  };

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore env so tests don't leak into each other.
    for (const [name, val] of [
      ["SHIPIT_SECRET_KEY", savedEnv.key],
      ["SHIPIT_SECRET_KEY_FILE", savedEnv.keyFile],
      ["SHIPIT_SECRET_ENCRYPTION", savedEnv.flag],
    ] as const) {
      if (val === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = val;
    }
  });

  function mkTmp(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-cipher-"));
    delete process.env.SHIPIT_SECRET_KEY;
    delete process.env.SHIPIT_SECRET_KEY_FILE;
    delete process.env.SHIPIT_SECRET_ENCRYPTION;
    return tmpDir;
  }

  it("generates and persists a key file when none exists", () => {
    const dir = mkTmp();
    const cipher = resolveSecretCipher({ credentialsDir: dir });
    expect(cipher).not.toBeNull();
    const keyPath = path.join(dir, SECRET_KEY_FILENAME);
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("reuses the same generated key across calls (stable round-trips)", () => {
    const dir = mkTmp();
    const enc = resolveSecretCipher({ credentialsDir: dir })!.encrypt("v");
    const reopened = resolveSecretCipher({ credentialsDir: dir })!;
    expect(reopened.decrypt(enc)).toBe("v");
  });

  it("prefers SHIPIT_SECRET_KEY over the key file", () => {
    const dir = mkTmp();
    const key = crypto.randomBytes(32);
    process.env.SHIPIT_SECRET_KEY = key.toString("base64");
    const cipher = resolveSecretCipher({ credentialsDir: dir })!;
    // No key file is generated when the env key is supplied.
    expect(fs.existsSync(path.join(dir, SECRET_KEY_FILENAME))).toBe(false);
    // Same key → an externally-built cipher decrypts it.
    const enc = cipher.encrypt("x");
    expect(new SecretCipher(key).decrypt(enc)).toBe("x");
  });

  it("throws on a malformed SHIPIT_SECRET_KEY (fail closed)", () => {
    const dir = mkTmp();
    process.env.SHIPIT_SECRET_KEY = "not-a-valid-key";
    expect(() => resolveSecretCipher({ credentialsDir: dir })).toThrow(/32 bytes/);
  });

  it("throws rather than regenerate over a wrong-size key file", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, SECRET_KEY_FILENAME), "deadbeef");
    expect(() => resolveSecretCipher({ credentialsDir: dir })).toThrow(/Failed to load/);
  });

  it("returns null when encryption is explicitly disabled", () => {
    const dir = mkTmp();
    process.env.SHIPIT_SECRET_ENCRYPTION = "off";
    expect(resolveSecretCipher({ credentialsDir: dir })).toBeNull();
  });

  it("adopts a concurrently-created key when it loses the create race (EEXIST)", () => {
    const dir = mkTmp();
    const keyPath = path.join(dir, SECRET_KEY_FILENAME);
    // The "winner" persisted this key just after our existsSync check.
    const winner = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, `${winner.toString("base64")}\n`);

    // Force the generate branch (existsSync false) and make the exclusive create
    // lose (openSync → EEXIST).
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(() => {
      const e = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
      e.code = "EEXIST";
      throw e;
    });
    try {
      const cipher = resolveSecretCipher({ credentialsDir: dir })!;
      // Adopted the winner's key, not a freshly generated one.
      const enc = cipher.encrypt("x");
      expect(new SecretCipher(winner).decrypt(enc)).toBe("x");
    } finally {
      existsSpy.mockRestore();
      openSpy.mockRestore();
    }
  });
});
