/**
 * Integration tests for SecretStore — per-repo secret storage in SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SecretStore } from "../secret-store.js";
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
});
