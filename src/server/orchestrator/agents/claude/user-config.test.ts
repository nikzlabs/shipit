import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyClaudeUserConfigDefaults, ensureClaudeUserConfigDefaults } from "./user-config.js";

describe("claude user-config defaults", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-config-"));
    configPath = path.join(dir, ".claude.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("applyClaudeUserConfigDefaults", () => {
    it("sets onboarding + trust on an empty config", () => {
      const config: Record<string, unknown> = {};
      expect(applyClaudeUserConfigDefaults(config)).toBe(true);
      expect(config.hasCompletedOnboarding).toBe(true);
      expect(config.projects).toEqual({
        "/app": { hasTrustDialogAccepted: true },
        "/workspace": { hasTrustDialogAccepted: true },
      });
    });

    it("is idempotent — a config that already has the defaults is unchanged", () => {
      const config: Record<string, unknown> = {};
      applyClaudeUserConfigDefaults(config);
      expect(applyClaudeUserConfigDefaults(config)).toBe(false);
    });

    it("merges into an existing config without clobbering unrelated keys", () => {
      const config: Record<string, unknown> = {
        theme: "dark",
        numStartups: 7,
        projects: {
          "/workspace": { history: ["a", "b"], mcpServers: { x: {} } },
          "/some/other/dir": { history: ["c"] },
        },
      };
      expect(applyClaudeUserConfigDefaults(config)).toBe(true);
      expect(config.theme).toBe("dark");
      expect(config.numStartups).toBe(7);
      expect(config.projects).toEqual({
        // Existing per-project state survives; only the trust flag is added.
        "/workspace": { history: ["a", "b"], mcpServers: { x: {} }, hasTrustDialogAccepted: true },
        "/some/other/dir": { history: ["c"] },
        "/app": { hasTrustDialogAccepted: true },
      });
    });
  });

  describe("ensureClaudeUserConfigDefaults", () => {
    it("creates the file when it doesn't exist", () => {
      expect(ensureClaudeUserConfigDefaults(configPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      expect(written.hasCompletedOnboarding).toBe(true);
      expect(written.projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    });

    it("does not rewrite a file that already carries the defaults", () => {
      ensureClaudeUserConfigDefaults(configPath);
      const before = fs.readFileSync(configPath, "utf-8");
      expect(ensureClaudeUserConfigDefaults(configPath)).toBe(false);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    });

    it("preserves unrelated keys of an existing user-authored config", () => {
      fs.writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" }, tipsHistory: { x: 1 } }));
      expect(ensureClaudeUserConfigDefaults(configPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      expect(written.oauthAccount).toEqual({ emailAddress: "a@b.c" });
      expect(written.tipsHistory).toEqual({ x: 1 });
      expect(written.projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    });

    it("leaves an unparseable config untouched rather than clobbering it", () => {
      fs.writeFileSync(configPath, "{not json");
      expect(ensureClaudeUserConfigDefaults(configPath)).toBe(false);
      expect(fs.readFileSync(configPath, "utf-8")).toBe("{not json");
    });

    it("never throws when the path is unwritable", () => {
      // A directory where the file should be — write fails, call must not throw.
      fs.mkdirSync(configPath);
      expect(ensureClaudeUserConfigDefaults(configPath)).toBe(false);
    });
  });
});
