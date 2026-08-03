import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isLocalRuntime,
  linkAgentHomeToCredentials,
} from "./local-agent-credentials.js";
import { resolveRuntimeMode } from "./app-di.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";

/**
 * SHI-282 — local mode (`RUNTIME_MODE=local`, the dogfood `dev` service) could
 * never authenticate an agent, because every credential-provisioning branch in
 * `session-agent-env.ts` is gated on `runner instanceof ContainerSessionRunner`
 * and local mode has no container. These pin the local-mode replacement.
 */

let tmp: string;
let home: string;
let credentials: string;

const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";

function seedAccount(agentId: "claude" | "codex", accountId: string, files: Record<string, string>): string {
  const root = providerAccountCredentialRoot(credentials, agentId, accountId);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-creds-"));
  home = path.join(tmp, "home");
  credentials = path.join(tmp, "credentials");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(credentials, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isLocalRuntime", () => {
  /**
   * The one property that keeps this module out of a developer's real home:
   * the linking call site is gated on it, and it must be false everywhere
   * except the dogfood. A test suite that flipped it would start writing
   * symlinks into `agentHome()` — the same class of accident
   * `resolveCredentialsDir` guards against for the credentials volume.
   */
  it("is false under the test suite", () => {
    expect(isLocalRuntime()).toBe(false);
  });

  /**
   * Deliberately duplicated from `resolveRuntimeMode` rather than imported —
   * importing `app-di` from the credential module would close a cycle. This is
   * what keeps the two readings from drifting.
   */
  it("agrees with resolveRuntimeMode for every RUNTIME_MODE spelling", () => {
    const original = process.env.RUNTIME_MODE;
    try {
      for (const value of ["local", "LOCAL", "Local", "containerized", "", "bogus"]) {
        process.env.RUNTIME_MODE = value;
        expect(isLocalRuntime(), `RUNTIME_MODE=${value}`).toBe(resolveRuntimeMode() === "local");
      }
      delete process.env.RUNTIME_MODE;
      expect(isLocalRuntime()).toBe(resolveRuntimeMode() === "local");
    } finally {
      if (original === undefined) delete process.env.RUNTIME_MODE;
      else process.env.RUNTIME_MODE = original;
    }
  });
});

describe("linkAgentHomeToCredentials", () => {
  it("points the agent home at the routed account's subtree", () => {
    const root = seedAccount("claude", ACCOUNT_A, {
      ".claude/.credentials.json": '{"token":"a"}',
      ".claude.json": '{"hasCompletedOnboarding":true}',
    });

    const outcomes = linkAgentHomeToCredentials({
      credentialsDir: credentials,
      agentId: "claude",
      accountId: ACCOUNT_A,
      home,
    });

    expect(outcomes).toEqual({ ".claude": "linked", ".claude.json": "linked" });
    // What actually matters: the CLI, reading `$HOME/.claude/...`, gets the
    // account's file — not a copy of it.
    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"a"}');
    expect(fs.realpathSync(path.join(home, ".claude"))).toBe(fs.realpathSync(path.join(root, ".claude")));
  });

  /**
   * The reason this links instead of copying. A copy would need the per-turn
   * `syncAgentTokenIn` / `syncAgentTokenBack` pair to stay alive — both also
   * container-gated — because the OAuth refresh token is single-use and
   * rotating. With one physical file there is nothing to keep in step.
   */
  it("leaves one physical file, so a source rotation is visible immediately", () => {
    const root = seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": '{"token":"old"}' });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });

    // The orchestrator's refresher rotates the source, as it does hourly.
    fs.writeFileSync(path.join(root, ".claude/.credentials.json"), '{"token":"new"}');

    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"new"}');
  });

  /** ...and the CLI's own write-back reaches the source, so no sync-back is needed. */
  it("carries a CLI-side token rotation back to the source", () => {
    const root = seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": '{"token":"old"}' });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });

    fs.writeFileSync(path.join(home, ".claude/.credentials.json"), '{"token":"cli-rotated"}');

    expect(fs.readFileSync(path.join(root, ".claude/.credentials.json"), "utf8")).toBe('{"token":"cli-rotated"}');
  });

  it("is idempotent — a second call relinks nothing", () => {
    seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": "{}", ".claude.json": "{}" });
    const args = { credentialsDir: credentials, agentId: "claude" as const, accountId: ACCOUNT_A, home };

    linkAgentHomeToCredentials(args);
    expect(linkAgentHomeToCredentials(args)).toEqual({
      ".claude": "already-linked",
      ".claude.json": "already-linked",
    });
  });

  /**
   * Why the call site runs this every turn rather than once at pin time: the
   * home is shared, so a sibling local session pinned to another account will
   * have repointed it.
   */
  it("repoints when the turn routes to a different account", () => {
    seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": '{"token":"a"}' });
    const rootB = seedAccount("claude", ACCOUNT_B, { ".claude/.credentials.json": '{"token":"b"}' });

    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });
    const outcomes = linkAgentHomeToCredentials({
      credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_B, home,
    });

    expect(outcomes[".claude"]).toBe("linked");
    expect(fs.realpathSync(path.join(home, ".claude"))).toBe(fs.realpathSync(path.join(rootB, ".claude")));
    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"b"}');
  });

  it("skips a source that was never created — Codex signed out", () => {
    seedAccount("claude", ACCOUNT_A, { ".claude.json": "{}" });

    expect(
      linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home }),
    ).toEqual({ ".claude": "no-source", ".claude.json": "linked" });
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("covers Codex's own subtree, which failed identically", () => {
    // The bug was gated on the runner type, not the agent — so Codex was just
    // as dead as Claude, and the fix has to reach it through the same call.
    const root = seedAccount("codex", ACCOUNT_A, { ".codex/auth.json": '{"token":"c"}' });

    expect(
      linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "codex", accountId: ACCOUNT_A, home }),
    ).toEqual({ ".codex": "linked" });
    expect(fs.realpathSync(path.join(home, ".codex"))).toBe(fs.realpathSync(path.join(root, ".codex")));
  });

  it("falls back to the flat credentials root for the legacy singleton route", () => {
    fs.mkdirSync(path.join(credentials, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(credentials, ".claude/.credentials.json"), '{"token":"legacy"}');

    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", home });

    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"legacy"}');
  });

  it("follows a docs/150 alias symlink at the flat root", () => {
    const root = seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": '{"token":"aliased"}' });
    fs.symlinkSync(path.join(root, ".claude"), path.join(credentials, ".claude"));

    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", home });

    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"aliased"}');
  });

  it("treats a dangling source alias as absent rather than linking to nothing", () => {
    fs.symlinkSync(path.join(credentials, "gone"), path.join(credentials, ".claude"));

    expect(
      linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", home }),
    ).toEqual({ ".claude": "no-source", ".claude.json": "no-source" });
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
  });

  /**
   * `AuthManager`'s pre-docs/150 singleton flow logged in with `HOME=/root`,
   * which in local mode IS the agent home. A real `.claude` there is somebody's
   * login and their conversation jsonl — recreating it is not possible, so it
   * gets renamed, never removed.
   */
  it("moves a pre-existing real credential dir aside instead of deleting it", () => {
    fs.mkdirSync(path.join(home, ".claude/projects"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/projects/old.jsonl"), "legacy conversation");
    seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": "{}" });

    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });

    const backup = fs.readdirSync(home).find((e) => e.startsWith(".claude.shipit-backup-"));
    expect(backup, "the old home was deleted rather than backed up").toBeDefined();
    expect(fs.readFileSync(path.join(home, backup!, "projects/old.jsonl"), "utf8")).toBe("legacy conversation");
    expect(fs.lstatSync(path.join(home, ".claude")).isSymbolicLink()).toBe(true);
  });

  it("creates the home directory if it does not exist yet", () => {
    seedAccount("claude", ACCOUNT_A, { ".claude.json": "{}" });
    const fresh = path.join(tmp, "nested", "home");

    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home: fresh });

    expect(fs.readFileSync(path.join(fresh, ".claude.json"), "utf8")).toBe("{}");
  });
});
