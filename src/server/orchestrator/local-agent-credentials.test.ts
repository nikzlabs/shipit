import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearAgentHomeCredentialLinks,
  isLocalRuntime,
  linkAgentHomeToCredentials,
} from "./local-agent-credentials.js";
import { resolveRuntimeMode } from "./app-di.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";

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
  it("is false under the test suite", () => {
    expect(isLocalRuntime()).toBe(false);
  });

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
    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"a"}');
    expect(fs.realpathSync(path.join(home, ".claude"))).toBe(fs.realpathSync(path.join(root, ".claude")));
  });

  it("leaves one physical file, so a source rotation is visible immediately", () => {
    const root = seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": '{"token":"old"}' });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });

    fs.writeFileSync(path.join(root, ".claude/.credentials.json"), '{"token":"new"}');

    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe('{"token":"new"}');
  });

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

describe("clearAgentHomeCredentialLinks", () => {
  it("removes a previous account turn's links so an env-authenticated turn has no account credentials", () => {
    seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": "{}", ".claude.json": "{}" });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });

    const outcomes = clearAgentHomeCredentialLinks({ agentId: "claude", home });

    expect(outcomes).toEqual({ ".claude": "unlinked", ".claude.json": "unlinked" });
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("leaves the account's own credentials intact", () => {
    const root = seedAccount("claude", ACCOUNT_A, { ".claude/.credentials.json": "{\"token\":\"live\"}" });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_A, home });

    clearAgentHomeCredentialLinks({ agentId: "claude", home });

    expect(fs.readFileSync(path.join(root, ".claude/.credentials.json"), "utf8")).toBe("{\"token\":\"live\"}");
  });

  it("is idempotent and reports nothing to clear on a home that was never linked", () => {
    expect(clearAgentHomeCredentialLinks({ agentId: "codex", home })).toEqual({ ".codex": "absent" });

    seedAccount("codex", ACCOUNT_A, { ".codex/auth.json": "{}" });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "codex", accountId: ACCOUNT_A, home });
    clearAgentHomeCredentialLinks({ agentId: "codex", home });

    expect(clearAgentHomeCredentialLinks({ agentId: "codex", home })).toEqual({ ".codex": "absent" });
  });

  it("does not touch a real credential directory", () => {
    fs.mkdirSync(path.join(home, ".claude/projects"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/projects/old.jsonl"), "legacy conversation");

    const outcomes = clearAgentHomeCredentialLinks({ agentId: "claude", home });

    expect(outcomes[".claude"]).toBe("absent");
    expect(fs.readFileSync(path.join(home, ".claude/projects/old.jsonl"), "utf8")).toBe("legacy conversation");
  });

  it("links resolve to the same file a scoped spawn's HOME would read", () => {
    const root = seedAccount("claude", ACCOUNT_B, { ".claude/.credentials.json": "{\"v\":1}" });
    linkAgentHomeToCredentials({ credentialsDir: credentials, agentId: "claude", accountId: ACCOUNT_B, home });

    expect(fs.realpathSync(path.join(home, ".claude/.credentials.json")))
      .toBe(fs.realpathSync(path.join(root, ".claude/.credentials.json")));
  });
});
