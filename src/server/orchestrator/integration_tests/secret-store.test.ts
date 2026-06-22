/**
 * Integration tests for SecretStore — per-repo secret storage in SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { SecretStore } from "../secret-store.js";
import { SecretCipher, isEncrypted } from "../secret-cipher.js";
import { createTestDatabaseManager } from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";

describe("Integration: SecretStore", () => {
  let dbManager: DatabaseManager;
  let store: SecretStore;

  beforeEach(() => {
    dbManager = createTestDatabaseManager();
    store = new SecretStore(dbManager);
  });

  afterEach(() => {
    dbManager.close();
  });

  it("loadSecrets returns empty object for unknown repo", () => {
    const secrets = store.loadSecrets("https://github.com/org/unknown");
    expect(secrets).toEqual({});
  });

  it("saveSecrets and loadSecrets round-trip", () => {
    const repoUrl = "https://github.com/org/repo";
    store.saveSecrets(repoUrl, {
      STRIPE_KEY: "sk_test_123",
      DATABASE_URL: "postgres://localhost/db",
    });

    const loaded = store.loadSecrets(repoUrl);
    expect(loaded).toEqual({
      STRIPE_KEY: "sk_test_123",
      DATABASE_URL: "postgres://localhost/db",
    });
  });

  it("loadSecretNames returns only key names, never values", () => {
    const repoUrl = "https://github.com/org/repo";
    store.saveSecrets(repoUrl, {
      STRIPE_KEY: "sk_test_123",
      DATABASE_URL: "postgres://localhost/db",
    });

    const names = store.loadSecretNames(repoUrl);
    expect(names.sort()).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    // The values must not leak through this method.
    expect(JSON.stringify(names)).not.toContain("sk_test_123");
  });

  it("loadSecretNames returns empty array for unknown repo", () => {
    expect(store.loadSecretNames("https://github.com/org/unknown")).toEqual([]);
  });

  it("saveSecrets replaces all existing secrets", () => {
    const repoUrl = "https://github.com/org/repo";
    store.saveSecrets(repoUrl, { KEY_A: "a", KEY_B: "b" });
    store.saveSecrets(repoUrl, { KEY_C: "c" });

    const loaded = store.loadSecrets(repoUrl);
    expect(loaded).toEqual({ KEY_C: "c" });
    expect(loaded).not.toHaveProperty("KEY_A");
    expect(loaded).not.toHaveProperty("KEY_B");
  });

  it("saveSecrets with empty object clears all secrets", () => {
    const repoUrl = "https://github.com/org/repo";
    store.saveSecrets(repoUrl, { KEY: "value" });
    store.saveSecrets(repoUrl, {});

    const loaded = store.loadSecrets(repoUrl);
    expect(loaded).toEqual({});
  });

  it("secrets are isolated by repo URL", () => {
    const repo1 = "https://github.com/org/repo1";
    const repo2 = "https://github.com/org/repo2";

    store.saveSecrets(repo1, { KEY: "value1" });
    store.saveSecrets(repo2, { KEY: "value2" });

    expect(store.loadSecrets(repo1)).toEqual({ KEY: "value1" });
    expect(store.loadSecrets(repo2)).toEqual({ KEY: "value2" });
  });

  it("deleteSecrets removes all secrets for a repo", () => {
    const repoUrl = "https://github.com/org/repo";
    store.saveSecrets(repoUrl, { KEY: "value" });
    store.deleteSecrets(repoUrl);

    expect(store.loadSecrets(repoUrl)).toEqual({});
  });

  it("deleteSecrets does not affect other repos", () => {
    const repo1 = "https://github.com/org/repo1";
    const repo2 = "https://github.com/org/repo2";

    store.saveSecrets(repo1, { A: "1" });
    store.saveSecrets(repo2, { B: "2" });
    store.deleteSecrets(repo1);

    expect(store.loadSecrets(repo1)).toEqual({});
    expect(store.loadSecrets(repo2)).toEqual({ B: "2" });
  });

  // ---- At-rest encryption (docs/220) ----

  describe("encryption", () => {
    const repoUrl = "https://github.com/org/repo";

    it("encrypts values at rest but round-trips through the API", () => {
      const cipher = new SecretCipher(crypto.randomBytes(32));
      const enc = new SecretStore(dbManager, cipher);
      enc.saveSecrets(repoUrl, { STRIPE_KEY: "sk_live_123" });

      // Raw column is ciphertext — no plaintext value in the DB.
      const row = dbManager.db
        .prepare("SELECT value FROM secrets WHERE repo_url = ? AND key = 'STRIPE_KEY'")
        .get(repoUrl) as { value: string };
      expect(isEncrypted(row.value)).toBe(true);
      expect(row.value).not.toContain("sk_live_123");

      // loadSecrets transparently decrypts.
      expect(enc.loadSecrets(repoUrl)).toEqual({ STRIPE_KEY: "sk_live_123" });
    });

    it("reads legacy plaintext rows and re-encrypts on construction", () => {
      // Seed a plaintext row via a plaintext store.
      store.saveSecrets(repoUrl, { LEGACY: "plain-value" });

      const cipher = new SecretCipher(crypto.randomBytes(32));
      const enc = new SecretStore(dbManager, cipher); // migrateToEncrypted runs
      const row = dbManager.db
        .prepare("SELECT value FROM secrets WHERE repo_url = ? AND key = 'LEGACY'")
        .get(repoUrl) as { value: string };
      expect(isEncrypted(row.value)).toBe(true);
      expect(enc.loadSecrets(repoUrl)).toEqual({ LEGACY: "plain-value" });
    });

    it("fails closed (throws at construction) under the wrong key", () => {
      new SecretStore(dbManager, new SecretCipher(crypto.randomBytes(32))).saveSecrets(repoUrl, {
        K: "v",
      });
      // A wrong key is rejected when the store is built (decrypt-validation of
      // existing ciphertext), not lazily on the first loadSecrets.
      expect(() => new SecretStore(dbManager, new SecretCipher(crypto.randomBytes(32)))).toThrow();
    });

    it("fails closed (throws) when encrypted rows exist but no cipher is configured", () => {
      new SecretStore(dbManager, new SecretCipher(crypto.randomBytes(32))).saveSecrets(repoUrl, {
        K: "v",
      });
      // Disabling encryption (no cipher) over encrypted data must not silently
      // hand ciphertext back as a plaintext value.
      expect(() => new SecretStore(dbManager)).toThrow(/encrypted secrets/);
    });
  });
});
