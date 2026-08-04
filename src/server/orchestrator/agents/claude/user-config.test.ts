import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyClaudeUserConfigDefaults,
  claudeTrustKey,
  ensureClaudeUserConfigDefaults,
  ensureClaudeWorkspaceTrusted,
} from "./user-config.js";

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

  // docs/118 (SHI-59) — the `RUNTIME_MODE=local` branch. Trust is keyed by the enclosing
  // git root of the CLI's cwd, so a dogfood session's
  // `<dataDir>/sessions/<id>/workspace` needs its own key; `/workspace` (an
  // ancestor) grants it nothing.
  describe("claudeTrustKey", () => {
    it("resolves to the enclosing git repository root", () => {
      const repo = path.join(dir, "sessions", "abc", "workspace");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
      expect(claudeTrustKey(path.join(repo, "sub", "deep"))).toBe(repo);
      expect(claudeTrustKey(repo)).toBe(repo);
    });

    it("treats a `.git` FILE as a root too (linked worktree)", () => {
      const wt = path.join(dir, "wt");
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/wt");
      expect(claudeTrustKey(wt)).toBe(wt);
    });

    it("falls back to the resolved directory when nothing above it is a repo", () => {
      const plain = path.join(dir, "not-a-repo");
      fs.mkdirSync(plain, { recursive: true });
      expect(claudeTrustKey(plain)).toBe(plain);
    });
  });

  describe("ensureClaudeWorkspaceTrusted", () => {
    /** A local session workspace at `<dir>/sessions/<id>/workspace`, git-inited. */
    function makeWorkspace(id: string): string {
      const ws = path.join(dir, "sessions", id, "workspace");
      fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
      return ws;
    }

    it("trusts the workspace's own directory", () => {
      const ws = makeWorkspace("s1");
      expect(ensureClaudeWorkspaceTrusted(configPath, ws)).toBe(true);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        projects: Record<string, unknown>;
      };
      expect(written.projects[ws]).toEqual({ hasTrustDialogAccepted: true });
    });

    it("writes ONLY the trust key — no onboarding or pre-trusted dirs", () => {
      const ws = makeWorkspace("s1");
      ensureClaudeWorkspaceTrusted(configPath, ws);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      expect(written.hasCompletedOnboarding).toBeUndefined();
      expect(Object.keys(written.projects as object)).toEqual([ws]);
    });

    it("is idempotent — a second call does not rewrite the file", () => {
      const ws = makeWorkspace("s1");
      ensureClaudeWorkspaceTrusted(configPath, ws);
      const before = fs.readFileSync(configPath, "utf-8");
      expect(ensureClaudeWorkspaceTrusted(configPath, ws)).toBe(false);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    });

    it("preserves the CLI's own per-project state and unrelated keys", () => {
      const ws = makeWorkspace("s1");
      fs.writeFileSync(configPath, JSON.stringify({
        oauthAccount: { emailAddress: "a@b.c" },
        projects: { [ws]: { history: ["a"] }, "/app": { hasTrustDialogAccepted: true } },
      }));
      expect(ensureClaudeWorkspaceTrusted(configPath, ws)).toBe(true);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        oauthAccount: unknown;
        projects: Record<string, unknown>;
      };
      expect(written.oauthAccount).toEqual({ emailAddress: "a@b.c" });
      expect(written.projects[ws]).toEqual({ history: ["a"], hasTrustDialogAccepted: true });
      expect(written.projects["/app"]).toEqual({ hasTrustDialogAccepted: true });
    });

    it("prunes sibling session workspaces that no longer exist, bounding growth", () => {
      const live = makeWorkspace("live");
      const dead = path.join(dir, "sessions", "dead", "workspace");
      fs.writeFileSync(configPath, JSON.stringify({
        projects: { [dead]: { hasTrustDialogAccepted: true, history: ["x"] } },
      }));
      expect(ensureClaudeWorkspaceTrusted(configPath, live)).toBe(true);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        projects: Record<string, unknown>;
      };
      expect(Object.keys(written.projects)).toEqual([live]);
    });

    it("prunes only same-shaped siblings — never an unrelated or still-present entry", () => {
      const live = makeWorkspace("live");
      const otherLive = makeWorkspace("other");
      const deadElsewhere = path.join(dir, "elsewhere", "gone", "workspace");
      const deadDifferentLeaf = path.join(dir, "sessions", "x", "checkout");
      fs.writeFileSync(configPath, JSON.stringify({
        projects: {
          [otherLive]: { hasTrustDialogAccepted: true },
          [deadElsewhere]: { history: ["keep"] },
          [deadDifferentLeaf]: { history: ["keep"] },
          "/app": { hasTrustDialogAccepted: true },
        },
      }));
      ensureClaudeWorkspaceTrusted(configPath, live);
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        projects: Record<string, unknown>;
      };
      expect(Object.keys(written.projects).sort()).toEqual(
        [live, otherLive, deadElsewhere, deadDifferentLeaf, "/app"].sort(),
      );
    });

    it("leaves an unparseable config untouched rather than clobbering it", () => {
      const ws = makeWorkspace("s1");
      fs.writeFileSync(configPath, "{not json");
      expect(ensureClaudeWorkspaceTrusted(configPath, ws)).toBe(false);
      expect(fs.readFileSync(configPath, "utf-8")).toBe("{not json");
    });

    it("never throws when the path is unwritable", () => {
      const ws = makeWorkspace("s1");
      fs.mkdirSync(configPath);
      expect(ensureClaudeWorkspaceTrusted(configPath, ws)).toBe(false);
    });

    // The regression that would matter: the containerized posture is real
    // security (a container session can hold an arbitrary user repo), so the
    // local-mode writer must not weaken it and `CLAUDE_PRE_TRUSTED_DIRS` must
    // keep meaning exactly what it means today.
    it("does not change what the containerized writer produces", () => {
      const containerConfig = path.join(dir, "container.json");
      ensureClaudeUserConfigDefaults(containerConfig);
      const written = JSON.parse(fs.readFileSync(containerConfig, "utf-8")) as {
        hasCompletedOnboarding: boolean;
        projects: Record<string, unknown>;
      };
      expect(written.hasCompletedOnboarding).toBe(true);
      expect(written.projects).toEqual({
        "/app": { hasTrustDialogAccepted: true },
        "/workspace": { hasTrustDialogAccepted: true },
      });
    });

    it("a shallow key like /workspace prunes nothing (containerized shape is inert)", () => {
      fs.writeFileSync(configPath, JSON.stringify({
        projects: { "/app": { hasTrustDialogAccepted: true }, "/gone/workspace": { history: ["k"] } },
      }));
      ensureClaudeWorkspaceTrusted(configPath, "/workspace");
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        projects: Record<string, unknown>;
      };
      expect(written.projects["/gone/workspace"]).toEqual({ history: ["k"] });
      expect(written.projects["/app"]).toEqual({ hasTrustDialogAccepted: true });
    });
  });
});
