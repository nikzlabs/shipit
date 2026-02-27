import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";

describe("CredentialStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cred-store-"));
    return tmpDir;
  }

  // ---- Agent env ----

  describe("agentEnv", () => {
    it("returns undefined for unset key", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
    });

    it("set persists and get retrieves", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-test");

      expect(store.getAgentEnv("OPENAI_API_KEY")).toBe("sk-test");
    });

    it("getAllAgentEnv returns all stored keys", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-1");
      store.setAgentEnv("GOOGLE_API_KEY", "AIza-2");

      expect(store.getAllAgentEnv()).toEqual({
        OPENAI_API_KEY: "sk-1",
        GOOGLE_API_KEY: "AIza-2",
      });
    });

    it("new instance reads back saved env", () => {
      const dir = createTmpDir();
      new CredentialStore(dir).setAgentEnv("OPENAI_API_KEY", "sk-persisted");

      const store2 = new CredentialStore(dir);
      expect(store2.getAgentEnv("OPENAI_API_KEY")).toBe("sk-persisted");
    });
  });

  // ---- GitHub token ----

  describe("githubToken", () => {
    it("returns null when not set", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getGithubToken()).toBeNull();
    });

    it("set and get round-trip", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_test123");

      expect(store.getGithubToken()).toBe("ghp_test123");
    });

    it("clear removes token", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_test123");
      store.clearGithubToken();

      expect(store.getGithubToken()).toBeNull();
    });

    it("returns null for empty string token", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "shipit-credentials.json"),
        JSON.stringify({ githubToken: "" }),
      );

      const store = new CredentialStore(dir);
      expect(store.getGithubToken()).toBeNull();
    });

    it("new instance reads back saved token", () => {
      const dir = createTmpDir();
      new CredentialStore(dir).setGithubToken("ghp_persisted");

      const store2 = new CredentialStore(dir);
      expect(store2.getGithubToken()).toBe("ghp_persisted");
    });
  });

  // ---- Cross-concern ----

  describe("mixed credentials", () => {
    it("all credential types coexist in one file", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-abc");
      store.setGithubToken("ghp_xyz");

      const raw = JSON.parse(fs.readFileSync(path.join(dir, "shipit-credentials.json"), "utf-8"));
      expect(raw).toEqual({
        agentEnv: { OPENAI_API_KEY: "sk-abc" },
        githubToken: "ghp_xyz",
      });
    });

    it("clear removes everything", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-abc");
      store.setGithubToken("ghp_xyz");

      store.clear();
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
      expect(store.getGithubToken()).toBeNull();
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    it("handles corrupt JSON gracefully", () => {
      const dir = createTmpDir();
      fs.writeFileSync(path.join(dir, "shipit-credentials.json"), "not json{{{");

      const store = new CredentialStore(dir);
      expect(store.getGithubToken()).toBeNull();
    });

    it("creates directory if missing", () => {
      const dir = createTmpDir();
      const nested = path.join(dir, "sub", "dir");
      const store = new CredentialStore(nested);
      store.setAgentEnv("OPENAI_API_KEY", "sk-test");

      expect(fs.existsSync(path.join(nested, "shipit-credentials.json"))).toBe(true);
    });

    it("file has restrictive permissions", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_secret");

      const stat = fs.statSync(path.join(dir, "shipit-credentials.json"));
      // 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});
