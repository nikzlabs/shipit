import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  perSessionCredentialsDir,
  perSessionCredentialsSubpath,
  sessionCredentialsRoot,
  ensureSessionCredentialsScaffold,
  ensureSessionAgentUserConfig,
  provisionAgentCredentials,
  provisionProviderAccountCredentials,
  provisionSubAgentCredentials,
  provisionSubAgentSpawnHome,
  releaseSubAgentCredentials,
  releaseSubAgentSpawnHome,
  removeSubAgentCredentials,
  subAgentSpawnHomeContainerDir,
  subAgentSpawnHomeDir,
  sweepSubAgentSpawnHomes,
  readSessionAccountMarker,
  writeSessionAccountMarker,
  removeSessionCredentials,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
  repushAgentToken,
  repushProviderAccountToken,
  repoMemoryDir,
  provisionRepoMemory,
  chownSessionCredentialsTree,
  clearSubtreeBorrows,
} from "./session-credentials.js";

function seedCredentialsRoot(root: string): void {
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"claude-tok"}}');
  fs.writeFileSync(path.join(root, ".claude.json"), '{"projects":{}}');
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "auth.json"), '{"tokens":{"access_token":"codex-tok"}}');
  fs.writeFileSync(path.join(root, ".gitconfig"), "[user]\n\tname = Test\n");
  fs.writeFileSync(path.join(root, "shipit-credentials.json"), '{"githubToken":"ghp_x"}');
}

describe("session-credentials", () => {
  let root: string;
  const sid = "abc123def456";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-creds-"));
    seedCredentialsRoot(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearSubtreeBorrows();
  });

  it("computes the per-session dir and POSIX subpath", () => {
    expect(perSessionCredentialsDir(root, sid)).toBe(path.join(root, "sessions", sid));
    expect(perSessionCredentialsSubpath(sid)).toBe(`sessions/${sid}`);
    expect(sessionCredentialsRoot(root)).toBe(path.join(root, "sessions"));
  });

  describe("docs/150 §7 — worker-UID ownership handoff", () => {
    const prev = process.env.SHIPIT_SESSION_WORKER_UID;
    afterEach(() => {
      if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = prev;
    });

    it("scaffold + provision chown the subtree to the worker UID when set", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      ensureSessionCredentialsScaffold(root, sid);
      provisionAgentCredentials(root, sid, "claude");
      const dir = perSessionCredentialsDir(root, sid);
      expect(fs.lstatSync(path.join(dir, ".gitconfig")).uid).toBe(myUid);
      expect(fs.lstatSync(path.join(dir, ".claude.json")).uid).toBe(myUid);
    });

    it("chownSessionCredentialsTree is a no-op (no throw) when unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      ensureSessionCredentialsScaffold(root, sid);
      expect(() => chownSessionCredentialsTree(root, sid)).not.toThrow();
    });

    it("provisionRepoMemory chowns the seeded memory dir to the worker UID", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const repoHash = "deadbeef";
      const shared = repoMemoryDir(root, repoHash);
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(path.join(shared, "MEMORY.md"), "- [x] note");
      provisionRepoMemory(root, sid, repoHash);
      const sessionMemory = path.join(
        perSessionCredentialsDir(root, sid),
        ".claude", "projects", "-workspace", "memory",
      );
      expect(fs.lstatSync(sessionMemory).uid).toBe(myUid);
      expect(fs.lstatSync(path.join(sessionMemory, "MEMORY.md")).uid).toBe(myUid);
    });
  });

  it("scaffold removes a credential file orchestrator code left in the sandbox", () => {
    const dir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(dir, { recursive: true });
    const stray = path.join(dir, ".git-credential-github");
    fs.writeFileSync(stray, "username=x-access-token\npassword=ghp_x\n");

    ensureSessionCredentialsScaffold(root, sid);

    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".gitconfig"), "utf-8"))
      .toContain("/usr/local/bin/shipit-git-credential");
  });

  it("scaffold seeds only the shared .gitconfig — no agent creds", () => {
    ensureSessionCredentialsScaffold(root, sid);
    const dir = perSessionCredentialsDir(root, sid);
    expect(fs.existsSync(path.join(dir, ".gitconfig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(false);
  });

  it("provisioning Claude copies .claude + .claude.json but NOT .codex", () => {
    provisionAgentCredentials(root, sid, "claude");
    const dir = perSessionCredentialsDir(root, sid);
    expect(fs.readFileSync(path.join(dir, ".claude", ".credentials.json"), "utf-8")).toContain("claude-tok");
    expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitconfig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "shipit-credentials.json"))).toBe(false);
  });

  describe("Claude workspace trust in the session container's own .claude.json", () => {
    function readSessionConfig(): Record<string, unknown> {
      const raw = fs.readFileSync(path.join(perSessionCredentialsDir(root, sid), ".claude.json"), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    }

    it("provisioning pre-trusts /workspace and completes onboarding", () => {
      provisionAgentCredentials(root, sid, "claude");
      const config = readSessionConfig();
      expect(config.hasCompletedOnboarding).toBe(true);
      expect(config.projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    });

    it("merges into the copied source config without clobbering unrelated keys", () => {
      fs.writeFileSync(
        path.join(root, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" }, projects: { "/workspace": { history: ["x"] } } }),
      );
      provisionAgentCredentials(root, sid, "claude");
      const config = readSessionConfig();
      expect(config.oauthAccount).toEqual({ emailAddress: "a@b.c" });
      expect(config.projects).toEqual({
        "/workspace": { history: ["x"], hasTrustDialogAccepted: true },
        "/app": { hasTrustDialogAccepted: true },
      });
    });

    it("writes the config even when the source root has no .claude.json at all", () => {
      fs.rmSync(path.join(root, ".claude.json"), { force: true });
      provisionAgentCredentials(root, sid, "claude");
      expect(readSessionConfig().projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    });

    it("ensureSessionAgentUserConfig heals an already-provisioned session and is idempotent", () => {
      provisionAgentCredentials(root, sid, "claude");
      const configPath = path.join(perSessionCredentialsDir(root, sid), ".claude.json");
      fs.writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));

      ensureSessionAgentUserConfig(root, sid, "claude");
      expect(readSessionConfig().projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
      expect(readSessionConfig().oauthAccount).toEqual({ emailAddress: "a@b.c" });

      const after = fs.readFileSync(configPath, "utf-8");
      ensureSessionAgentUserConfig(root, sid, "claude");
      expect(fs.readFileSync(configPath, "utf-8")).toBe(after);
    });

    it("is a no-op for a Codex session", () => {
      provisionAgentCredentials(root, sid, "codex");
      ensureSessionAgentUserConfig(root, sid, "codex");
      expect(fs.existsSync(path.join(perSessionCredentialsDir(root, sid), ".claude.json"))).toBe(false);
    });

    it("applies to a provider-account provisioned session too", () => {
      const accountRoot = path.join(root, "provider-accounts", "claude", "acct-1");
      fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"a1"}}');
      fs.writeFileSync(path.join(accountRoot, ".claude.json"), '{"projects":{}}');
      provisionProviderAccountCredentials(root, sid, "claude", "acct-1");
      expect(readSessionConfig().projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    });
  });

  it("provisioning Codex copies .codex but NOT .claude / .claude.json", () => {
    provisionAgentCredentials(root, sid, "codex");
    const dir = perSessionCredentialsDir(root, sid);
    expect(fs.readFileSync(path.join(dir, ".codex", "auth.json"), "utf-8")).toContain("codex-tok");
    expect(fs.existsSync(path.join(dir, ".gitconfig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(false);
  });

  it("provisioning tolerates a missing agent subtree, and still creates the DIR (planning#444)", () => {
    fs.rmSync(path.join(root, ".codex"), { recursive: true, force: true });
    expect(() => provisionAgentCredentials(root, sid, "codex")).not.toThrow();
    const dir = perSessionCredentialsDir(root, sid);
    expect(fs.statSync(path.join(dir, ".codex")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(dir, ".codex"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, ".gitconfig"))).toBe(true);
  });

  const claudeCreds = (accessTail: string, expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken: `tok-${accessTail}`, refreshToken: "r", expiresAt } });

  const writeClaudeToken = (dir: string, accessTail: string, expiresAt: number) => {
    const p = path.join(dir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, claudeCreds(accessTail, expiresAt));
  };

  const readTail = (file: string) =>
    (JSON.parse(fs.readFileSync(file, "utf-8")).claudeAiOauth.accessToken as string).replace("tok-", "");

  it("provisionProviderAccountCredentials copies only the selected account subtree", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    writeClaudeToken(accountA, "A", 3_000);
    writeClaudeToken(accountB, "B", 4_000);

    provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("B");
    expect(fs.existsSync(path.join(perSessionCredentialsDir(root, sid), ".codex"))).toBe(false);
  });

  it("reprovisioning from another account preserves conversation state but replaces credentials", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    writeClaudeToken(accountA, "A", 3_000);
    writeClaudeToken(accountB, "B", 4_000);

    provisionProviderAccountCredentials(root, sid, "claude", "acct-a");

    const sessionDir = perSessionCredentialsDir(root, sid);
    const transcript = path.join(sessionDir, ".claude", "projects", "-workspace", "conv-1.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    fs.writeFileSync(path.join(sessionDir, ".claude", "settings.json"), '{"onlyUnderA":true}');

    provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.readFileSync(transcript, "utf-8")).toBe('{"type":"user"}\n');
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("B");
    expect(fs.existsSync(path.join(sessionDir, ".claude", "settings.json"))).toBe(false);
  });

  it("reprovisioning preserves a Codex rollout across an account switch", () => {
    const accountA = path.join(root, "provider-accounts", "codex", "acct-a");
    const accountB = path.join(root, "provider-accounts", "codex", "acct-b");
    for (const [dir, tok] of [[accountA, "A"], [accountB, "B"]] as const) {
      fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".codex", "auth.json"), `{"tokens":{"access_token":"${tok}"}}`);
    }

    provisionProviderAccountCredentials(root, sid, "codex", "acct-a");

    const sessionDir = perSessionCredentialsDir(root, sid);
    const rollout = path.join(sessionDir, ".codex", "sessions", "2026", "08", "01", "rollout-1-t.jsonl");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, "{}\n");
    fs.writeFileSync(path.join(sessionDir, ".codex", "config.toml"), "model = 'a'\n");

    provisionProviderAccountCredentials(root, sid, "codex", "acct-b");

    expect(fs.existsSync(rollout)).toBe(true);
    expect(fs.readFileSync(path.join(sessionDir, ".codex", "auth.json"), "utf-8")).toContain('"B"');
    expect(fs.existsSync(path.join(sessionDir, ".codex", "config.toml"))).toBe(false);
  });

  it("syncAgentTokenIn copies the freshest source token into the session dir", () => {
    writeClaudeToken(root, "SOURCE", 2_000);
    provisionAgentCredentials(root, sid, "claude");
    writeClaudeToken(root, "FRESH", 9_000);

    syncAgentTokenIn(root, sid, "claude");

    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("FRESH");
  });

  it("syncAgentTokenIn does NOT clobber a fresher session token with a staler source", () => {
    writeClaudeToken(root, "STALE", 1_000);
    fs.mkdirSync(path.join(perSessionCredentialsDir(root, sid), ".claude"), { recursive: true });
    writeClaudeToken(perSessionCredentialsDir(root, sid), "LOCAL", 5_000);

    syncAgentTokenIn(root, sid, "claude");

    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("LOCAL");
  });

  it("syncAgentTokenIn copies when the session has no token yet", () => {
    writeClaudeToken(root, "SEED", 5_000);
    fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });

    syncAgentTokenIn(root, sid, "claude");

    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("SEED");
  });

  it("syncAgentTokenBack writes a newer session token back to the source", () => {
    writeClaudeToken(root, "OLD", 1_000);
    provisionAgentCredentials(root, sid, "claude");
    writeClaudeToken(perSessionCredentialsDir(root, sid), "ROTATED", 5_000);

    syncAgentTokenBack(root, sid, "claude");

    expect(readTail(path.join(root, ".claude", ".credentials.json"))).toBe("ROTATED");
  });

  it("provider account token sync-in/back compares against the same account source", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    writeClaudeToken(accountA, "A-OLD", 1_000);
    writeClaudeToken(accountB, "B-NEW", 9_000);
    provisionProviderAccountCredentials(root, sid, "claude", "acct-a");

    writeSessionAccountMarker(root, sid, "claude", "acct-b");
    syncProviderAccountTokenIn(root, sid, "claude", "acct-b");
    expect(readTail(path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json"))).toBe("B-NEW");

    writeClaudeToken(perSessionCredentialsDir(root, sid), "B-ROTATED", 12_000);
    syncProviderAccountTokenBack(root, sid, "claude", "acct-b");

    expect(readTail(path.join(accountB, ".claude", ".credentials.json"))).toBe("B-ROTATED");
    expect(readTail(path.join(accountA, ".claude", ".credentials.json"))).toBe("A-OLD");
  });

  it("does not publish a BORROWED account's token into the session's own account root", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    writeClaudeToken(accountA, "A-FRESH", 12_000);
    writeClaudeToken(accountB, "B-LIVE", 5_000);
    provisionProviderAccountCredentials(root, sid, "claude", "acct-b");
    provisionSubAgentCredentials(root, sid, "claude", "acct-a");

    syncProviderAccountTokenBack(root, sid, "claude", "acct-b");

    expect(readTail(path.join(accountB, ".claude", ".credentials.json"))).toBe("B-LIVE");
  });

  it("does not publish a borrowed account's token into the flat root", () => {
    writeClaudeToken(root, "FLAT", 1_000);
    writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A-FRESH", 12_000);
    fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
    provisionSubAgentCredentials(root, sid, "claude", "acct-a");

    syncAgentTokenBack(root, sid, "claude");

    expect(readTail(path.join(root, ".claude", ".credentials.json"))).toBe("FLAT");
  });

  it("records the borrowed account on the subtree marker, so the borrow is visible", () => {
    writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
    writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
    provisionProviderAccountCredentials(root, sid, "claude", "acct-b");
    expect(readSessionAccountMarker(root, sid).claude).toBe("acct-b");

    provisionSubAgentCredentials(root, sid, "claude", "acct-a");
    expect(readSessionAccountMarker(root, sid).claude).toBe("acct-a");

    writeClaudeToken(perSessionCredentialsDir(root, sid), "A-ROTATED", 15_000);
    syncProviderAccountTokenBack(root, sid, "claude", "acct-a");
    expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
      .toBe("A-ROTATED");
  });

  describe("same-harness spawn home isolation", () => {
    const spawnId = "spawn-1234";

    it("provisions into the per-spawn home and leaves the session subtree byte-identical", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");
      const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
      const before = fs.readFileSync(sessionFile, "utf-8");

      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");

      expect(fs.readFileSync(sessionFile, "utf-8")).toBe(before);
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-b");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      expect(readTail(path.join(home, ".claude", ".credentials.json"))).toBe("A");
      expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(true);
    });

    it("provisions the flat root's copy when no account routes the spawn (the GLM shape)", () => {
      fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
      writeClaudeToken(perSessionCredentialsDir(root, sid), "SESSION-LIVE", 9_000);

      provisionSubAgentSpawnHome(root, sid, spawnId, "claude");

      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
      expect(readTail(path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json")))
        .toBe("SESSION-LIVE");
    });

    it("release publishes a fresher rotation to the account root and removes the home", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000);

      releaseSubAgentSpawnHome(root, sid, spawnId);

      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A-ROTATED");
      expect(fs.existsSync(home)).toBe(false);
    });

    it("release never regresses a target the refresher moved past the spawn's copy", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A-NEWER", 20_000);

      releaseSubAgentSpawnHome(root, sid, spawnId);

      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A-NEWER");
    });

    it("release publishes to the provenance-named root, whatever the caller's world says", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000);

      releaseSubAgentSpawnHome(root, sid, spawnId);

      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A-ROTATED");
      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-b", ".claude", ".credentials.json")))
        .toBe("B");
    });

    it("release publishes NOTHING from a home with no provenance (a torn provision)", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000);
      fs.rmSync(path.join(home, ".shipit-spawn-home.json"));

      releaseSubAgentSpawnHome(root, sid, spawnId);

      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A");
      expect(fs.existsSync(home)).toBe(false);
    });

    it("container-create sweep publishes a stranded rotation, then removes the homes", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      provisionSubAgentSpawnHome(root, sid, "spawn-flat", "claude");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000);

      sweepSubAgentSpawnHomes(root, sid);

      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A-ROTATED");
      expect(fs.existsSync(home)).toBe(false);
      expect(fs.existsSync(subAgentSpawnHomeDir(root, sid, "spawn-flat"))).toBe(false);
      expect(fs.existsSync(path.join(perSessionCredentialsDir(root, sid), "sub-agent-homes"))).toBe(false);
    });

    describe("a refused publish is quarantined, never deleted", () => {
      const strandedDir = (accountRoot: string) => path.join(accountRoot, ".shipit-stranded-tokens");
      const strandedFiles = (accountRoot: string) => {
        try {
          return fs.readdirSync(strandedDir(accountRoot));
        } catch {
          return [];
        }
      };
      const unorderableCreds = (tail: string) => `{"claudeAiOauth":{"accessToken":"tok-${tail}"}}`;

      it("keeps a rotation whose OWN copy cannot be ordered", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
        const home = subAgentSpawnHomeDir(root, sid, spawnId);
        fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), unorderableCreds("ROTATED"));

        releaseSubAgentSpawnHome(root, sid, spawnId);

        expect(fs.existsSync(home)).toBe(false);
        expect(readTail(path.join(accountRoot, ".claude", ".credentials.json"))).toBe("A");
        const kept = strandedFiles(accountRoot);
        expect(kept).toHaveLength(1);
        expect(readTail(path.join(strandedDir(accountRoot), kept[0]))).toBe("ROTATED");
      });

      it("keeps a rotation the TARGET's own unreadability refused", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
        const home = subAgentSpawnHomeDir(root, sid, spawnId);
        writeClaudeToken(home, "A-ROTATED", 15_000);
        fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), unorderableCreds("A"));

        releaseSubAgentSpawnHome(root, sid, spawnId);

        expect(fs.existsSync(home)).toBe(false);
        const kept = strandedFiles(accountRoot);
        expect(kept).toHaveLength(1);
        expect(readTail(path.join(strandedDir(accountRoot), kept[0]))).toBe("A-ROTATED");
      });

      it("leaves nothing behind when the publish succeeds", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
        writeClaudeToken(subAgentSpawnHomeDir(root, sid, spawnId), "A-ROTATED", 15_000);

        releaseSubAgentSpawnHome(root, sid, spawnId);

        expect(readTail(path.join(accountRoot, ".claude", ".credentials.json"))).toBe("A-ROTATED");
        expect(strandedFiles(accountRoot)).toEqual([]);
      });

      it("carries an adapter's own in-home quarantine out before the removal", () => {
        const accountRoot = path.join(root, "provider-accounts", "grok", "acct-x");
        const writeGrokAuth = (dir: string, tail: string, expiresAt: string) => {
          const p = path.join(dir, ".grok", "auth.json");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify({ "xai:api": { access_token: `tok-${tail}`, expires_at: expiresAt } }));
        };
        writeGrokAuth(accountRoot, "X", "2026-08-23T18:00:00.000Z");
        provisionSubAgentSpawnHome(root, sid, spawnId, "grok", "acct-x");
        const home = subAgentSpawnHomeDir(root, sid, spawnId);
        fs.writeFileSync(
          path.join(home, ".grok", "auth.json.stranded-1756000000000"),
          JSON.stringify({ "xai:api": { access_token: "tok-ROTATED" } }),
        );

        releaseSubAgentSpawnHome(root, sid, spawnId);

        expect(fs.existsSync(home)).toBe(false);
        const kept = strandedFiles(accountRoot);
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatch(/^\.grok_auth\.json\.stranded-1756000000000-[0-9a-f]{8}$/);
        expect(JSON.parse(fs.readFileSync(path.join(strandedDir(accountRoot), kept[0]), "utf-8")))
          .toMatchObject({ "xai:api": { access_token: "tok-ROTATED" } });
      });

      it("does not fan the quarantined bearer out into later provisions", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
        fs.writeFileSync(
          path.join(subAgentSpawnHomeDir(root, sid, spawnId), ".claude", ".credentials.json"),
          unorderableCreds("ROTATED"),
        );
        releaseSubAgentSpawnHome(root, sid, spawnId);
        expect(strandedFiles(accountRoot)).toHaveLength(1);

        provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
        provisionSubAgentSpawnHome(root, sid, "spawn-next", "claude", "acct-a");

        for (const dir of [perSessionCredentialsDir(root, sid), subAgentSpawnHomeDir(root, sid, "spawn-next")]) {
          expect(fs.existsSync(path.join(dir, ".shipit-stranded-tokens"))).toBe(false);
          expect(fs.readdirSync(path.join(dir, ".claude"))).toEqual([".credentials.json"]);
        }
      });

      it("KEEPS the home when the rotation could be neither published nor quarantined", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
        const home = subAgentSpawnHomeDir(root, sid, spawnId);
        const homeToken = path.join(home, ".claude", ".credentials.json");
        fs.writeFileSync(homeToken, unorderableCreds("ROTATED"));
        // A file forces ENOTDIR even when the test runs as root.
        fs.writeFileSync(strandedDir(accountRoot), "not a directory");

        releaseSubAgentSpawnHome(root, sid, spawnId);
        expect(readTail(homeToken)).toBe("ROTATED");

        sweepSubAgentSpawnHomes(root, sid);
        expect(readTail(homeToken)).toBe("ROTATED");

        fs.rmSync(strandedDir(accountRoot));
        sweepSubAgentSpawnHomes(root, sid);
        expect(fs.existsSync(home)).toBe(false);
        expect(strandedFiles(accountRoot)).toHaveLength(1);
      });

      it("does not let two rescues in the same millisecond overwrite each other", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        const now = vi.spyOn(Date, "now").mockReturnValue(1_756_000_000_000);
        try {
          for (const id of ["spawn-1", "spawn-2"]) {
            provisionSubAgentSpawnHome(root, sid, id, "claude", "acct-a");
            fs.writeFileSync(
              path.join(subAgentSpawnHomeDir(root, sid, id), ".claude", ".credentials.json"),
              unorderableCreds(id.toUpperCase()),
            );
            releaseSubAgentSpawnHome(root, sid, id);
          }
        } finally {
          now.mockRestore();
        }

        const kept = strandedFiles(accountRoot).map((n) => readTail(path.join(strandedDir(accountRoot), n)));
        expect(kept.sort()).toEqual(["SPAWN-1", "SPAWN-2"]);
      });

      it("keeps a bounded number of artifacts, newest first", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        for (let i = 0; i < 8; i++) {
          provisionSubAgentSpawnHome(root, sid, `spawn-${i}`, "claude", "acct-a");
          fs.writeFileSync(
            path.join(subAgentSpawnHomeDir(root, sid, `spawn-${i}`), ".claude", ".credentials.json"),
            unorderableCreds(`R${i}`),
          );
          releaseSubAgentSpawnHome(root, sid, `spawn-${i}`);
        }

        const kept = strandedFiles(accountRoot).map((n) => readTail(path.join(strandedDir(accountRoot), n)));
        expect(kept).toHaveLength(5);
        expect(kept).toContain("R7");
        expect(kept).not.toContain("R0");
      });
    });

    describe("cross-harness borrow cleanup", () => {
      const strandedFiles = (accountRoot: string) => {
        try {
          return fs.readdirSync(path.join(accountRoot, ".shipit-stranded-tokens"));
        } catch {
          return [];
        }
      };

      it("preserves a refused rotation before the borrowed subtree is wiped", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentCredentials(root, sid, "claude", "acct-a");
        const borrowed = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
        fs.writeFileSync(borrowed, '{"claudeAiOauth":{"accessToken":"tok-ROTATED"}}');

        releaseSubAgentCredentials(root, sid, "claude");

        expect(fs.existsSync(borrowed)).toBe(false);
        const kept = strandedFiles(accountRoot);
        expect(kept).toHaveLength(1);
        expect(readTail(path.join(accountRoot, ".shipit-stranded-tokens", kept[0]))).toBe("ROTATED");
      });

      it("keeps nothing when the borrowed copy is provably superseded", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentCredentials(root, sid, "claude", "acct-a");

        releaseSubAgentCredentials(root, sid, "claude");

        expect(strandedFiles(accountRoot)).toEqual([]);
      });
    });

    it("the container path pairs with the host path under the /credentials mount", () => {
      expect(subAgentSpawnHomeContainerDir(spawnId)).toBe(`/credentials/sub-agent-homes/${spawnId}`);
      expect(subAgentSpawnHomeDir(root, sid, spawnId)).toBe(
        path.join(perSessionCredentialsDir(root, sid), "sub-agent-homes", spawnId),
      );
    });
  });

  describe("a borrow never loses the session's own account", () => {
    const seedTwoAccounts = () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
    };

    it("restores the session's account after an ordinary borrow", () => {
      seedTwoAccounts();
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");
      provisionSubAgentCredentials(root, sid, "claude", "acct-a");

      expect(releaseSubAgentCredentials(root, sid, "claude")).toBe("acct-b");
    });

    it("survives a borrow taken while the marker reads as absent", () => {
      seedTwoAccounts();
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

      provisionSubAgentCredentials(root, sid, "claude", "acct-a");
      removeSubAgentCredentials(root, sid, "claude");
      expect(readSessionAccountMarker(root, sid).claude).toBeUndefined();

      provisionSubAgentCredentials(root, sid, "claude", "acct-a");
      expect(releaseSubAgentCredentials(root, sid, "claude")).toBe("acct-b");
    });

    it("reports no account to restore for a session that never had one", () => {
      seedTwoAccounts();
      fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
      provisionSubAgentCredentials(root, sid, "claude", "acct-a");

      expect(releaseSubAgentCredentials(root, sid, "claude")).toBeUndefined();
    });

    it("never exposes an empty marker mid-write", () => {
      seedTwoAccounts();
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

      const observed: (string | undefined)[] = [];
      const realRename = fs.renameSync;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        observed.push(readSessionAccountMarker(root, sid).claude);
        realRename(from, to);
      });
      try {
        writeSessionAccountMarker(root, sid, "claude", "acct-a");
      } finally {
        spy.mockRestore();
      }

      expect(observed).toEqual(["acct-b"]);
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-a");
      const leftovers = fs.readdirSync(perSessionCredentialsDir(root, sid)).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    });
  });

  describe("write-back marker repair", () => {
    const rotateInSession = () => writeClaudeToken(perSessionCredentialsDir(root, sid), "ROTATED", 15_000);
    const accountA = () => path.join(root, "provider-accounts", "claude", "acct-a");

    it("repairs a lost marker for the session's own turn route and publishes the rotation", () => {
      writeClaudeToken(accountA(), "A", 12_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      writeSessionAccountMarker(root, sid, "claude", null);
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("ROTATED");
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-a");
    });

    it("logs each outcome as a countable record, keeping the greppable prose", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const lastWriteBackLine = (): string =>
        warn.mock.calls
          .map((c) => String(c[0]))
          .filter((line) => line.includes("write-back="))
          .at(-1) ?? "";
      try {
        writeClaudeToken(accountA(), "A", 12_000);
        provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
        writeSessionAccountMarker(root, sid, "claude", null);
        rotateInSession();
        syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

        const repair = lastWriteBackLine();
        expect(repair).toContain("write-back=repaired");
        expect(repair).toContain(`session=${sid}`);
        expect(repair).toContain("agent=claude");
        expect(repair).toContain("target=account:acct-a");
        expect(repair).toContain("reason=lost-marker");

        writeSessionAccountMarker(root, sid, "claude", "acct-b");
        syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });
        const refusal = lastWriteBackLine();
        expect(refusal).toContain("write-back=refused");
        expect(refusal).toContain("holder=acct-b");
        expect(refusal).toContain("reason=other-account");
        expect(refusal).toContain(`refusing claude token write-back for ${sid} to account acct-a`);
      } finally {
        warn.mockRestore();
      }
    });

    it("still refuses a caller that is publishing a BORROWED account", () => {
      writeClaudeToken(accountA(), "A", 12_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      writeSessionAccountMarker(root, sid, "claude", null);
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a");

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
      expect(readSessionAccountMarker(root, sid).claude).toBeUndefined();
    });

    it("refuses while a flat-route borrow holds the subtree", () => {
      writeClaudeToken(accountA(), "A", 12_000);
      writeClaudeToken(root, "FLAT", 1_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      provisionSubAgentCredentials(root, sid, "claude");
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
      expect(readSessionAccountMarker(root, sid).claude).toBeUndefined();

      expect(releaseSubAgentCredentials(root, sid, "claude")).toBe("acct-a");
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      writeSessionAccountMarker(root, sid, "claude", null);
      rotateInSession();
      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });
      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("ROTATED");
    });

    it("refuses a session-route publish for the whole borrow, marker agreement included", () => {
      writeClaudeToken(accountA(), "A", 1_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      provisionSubAgentCredentials(root, sid, "claude", "acct-a");
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-a");
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
      releaseSubAgentCredentials(root, sid, "claude");
    });

    it("still refuses when the marker names a different account", () => {
      writeClaudeToken(accountA(), "A", 1_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
    });
  });

  it("syncAgentTokenBack does NOT clobber a fresher source (failed-refresh race guard)", () => {
    writeClaudeToken(root, "GOOD", 9_000);
    fs.mkdirSync(path.join(perSessionCredentialsDir(root, sid), ".claude"), { recursive: true });
    writeClaudeToken(perSessionCredentialsDir(root, sid), "STALE", 1_000);

    syncAgentTokenBack(root, sid, "claude");

    expect(readTail(path.join(root, ".claude", ".credentials.json"))).toBe("GOOD");
  });

  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const fakeJwt = (exp: number) => `${b64url({ alg: "none" })}.${b64url({ exp })}.sig`;
  const codexAuth = (exp: number) =>
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: fakeJwt(exp), refresh_token: "r" } });
  const writeCodexToken = (dir: string, exp: number) => {
    const p = path.join(dir, ".codex", "auth.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, codexAuth(exp));
  };
  const readCodexExp = (file: string): number => {
    const jwt = (JSON.parse(fs.readFileSync(file, "utf8")).tokens.access_token as string).split(".")[1];
    return JSON.parse(Buffer.from(jwt, "base64url").toString("utf8")).exp as number;
  };
  const sessionCodexFile = () => path.join(perSessionCredentialsDir(root, sid), ".codex", "auth.json");

  it("syncAgentTokenIn copies a fresher source Codex token (by JWT exp) into the session", () => {
    writeCodexToken(root, 2_000);
    provisionAgentCredentials(root, sid, "codex");
    writeCodexToken(root, 9_000);

    syncAgentTokenIn(root, sid, "codex");

    expect(readCodexExp(sessionCodexFile())).toBe(9_000);
  });

  it("syncAgentTokenIn does NOT clobber a fresher session Codex token", () => {
    writeCodexToken(root, 1_000);
    fs.mkdirSync(path.join(perSessionCredentialsDir(root, sid), ".codex"), { recursive: true });
    writeCodexToken(perSessionCredentialsDir(root, sid), 5_000);

    syncAgentTokenIn(root, sid, "codex");

    expect(readCodexExp(sessionCodexFile())).toBe(5_000);
  });

  it("syncAgentTokenBack writes a newer session Codex token back to the source", () => {
    writeCodexToken(root, 1_000);
    provisionAgentCredentials(root, sid, "codex");
    writeCodexToken(perSessionCredentialsDir(root, sid), 5_000);

    syncAgentTokenBack(root, sid, "codex");

    expect(readCodexExp(path.join(root, ".codex", "auth.json"))).toBe(5_000);
  });

  it("repushAgentToken forces the source token in even when the session token has a LATER expiry", () => {
    writeClaudeToken(root, "FRESH", 1_000);
    provisionAgentCredentials(root, sid, "claude");
    writeClaudeToken(perSessionCredentialsDir(root, sid), "DEAD", 9_000);

    const wrote = repushAgentToken(root, sid, "claude");

    expect(wrote).toBe(true);
    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("FRESH");
  });

  it("repushAgentToken does NOT seed a token into a session that never held one (no cross-agent leak)", () => {
    writeClaudeToken(root, "SRC", 5_000);
    provisionAgentCredentials(root, sid, "codex");

    const wrote = repushAgentToken(root, sid, "claude");

    expect(wrote).toBe(false);
    expect(fs.existsSync(path.join(perSessionCredentialsDir(root, sid), ".claude"))).toBe(false);
  });

  it("repushProviderAccountToken writes only from the matching account source", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    writeClaudeToken(accountA, "A", 1_000);
    writeClaudeToken(accountB, "B", 2_000);
    provisionProviderAccountCredentials(root, sid, "claude", "acct-a");

    const wrote = repushProviderAccountToken(root, sid, "claude", "acct-b");

    expect(wrote).toBe(true);
    expect(readTail(path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json"))).toBe("B");
  });

  it("provisioning from a credentialsRoot whose .claude is a legacy-alias symlink materializes real files", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.rmSync(path.join(root, ".claude"), { recursive: true, force: true });
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("acct", 9_000));
    fs.symlinkSync(path.join(account, ".claude"), path.join(root, ".claude"));

    provisionAgentCredentials(root, sid, "claude");

    const sessionClaude = path.join(perSessionCredentialsDir(root, sid), ".claude");
    expect(fs.lstatSync(sessionClaude).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(sessionClaude).isDirectory()).toBe(true);
    expect(readTail(path.join(sessionClaude, ".credentials.json"))).toBe("acct");
  });

  it("provisioning does NOT write through a resolvable symlink at the destination", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("ACCT", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    const nested = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync(nested, path.join(sessionDir, ".claude"));

    provisionProviderAccountCredentials(root, sid, "claude", "claude-default");

    const sessionClaude = path.join(sessionDir, ".claude");
    expect(fs.lstatSync(sessionClaude).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(sessionClaude).isDirectory()).toBe(true);
    expect(readTail(path.join(sessionClaude, ".credentials.json"))).toBe("ACCT");
    expect(fs.existsSync(path.join(nested, ".credentials.json"))).toBe(false);
  });

  it("provisioning survives a DANGLING symlink at the destination (was EEXIST)", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("ACCT", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(
      "/credentials/provider-accounts/claude/claude-default/.claude",
      path.join(sessionDir, ".claude"),
    );

    expect(() =>
      provisionProviderAccountCredentials(root, sid, "claude", "claude-default"),
    ).not.toThrow();

    const sessionClaude = path.join(sessionDir, ".claude");
    expect(fs.lstatSync(sessionClaude).isSymbolicLink()).toBe(false);
    expect(readTail(path.join(sessionClaude, ".credentials.json"))).toBe("ACCT");
  });

  it("provisioning materializes a symlinked FILE destination too (.claude.json)", () => {
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    const nested = path.join(sessionDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, ".claude.json"), '{"projects":{"leaked":{}}}');
    fs.symlinkSync(path.join(nested, ".claude.json"), path.join(sessionDir, ".claude.json"));

    provisionAgentCredentials(root, sid, "claude");

    const dest = path.join(sessionDir, ".claude.json");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    const materialized = JSON.parse(fs.readFileSync(dest, "utf-8")) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(materialized.projects)).not.toContain("leaked");
    expect(materialized.projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    expect(fs.readFileSync(path.join(nested, ".claude.json"), "utf-8"))
      .toBe('{"projects":{"leaked":{}}}');
  });

  it("provisioning leaves the orphan tree for the per-turn repair to recover", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("ACCT", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    const nested = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(path.join(nested, "projects", "-workspace"), { recursive: true });
    const agentSessionId = "7c1f2ab4-55d0-4a9e-8f31-9b2ce7d40a68";
    fs.writeFileSync(
      path.join(nested, "projects", "-workspace", `${agentSessionId}.jsonl`),
      resumableJsonl(agentSessionId),
    );
    fs.symlinkSync(nested, path.join(sessionDir, ".claude"));

    provisionProviderAccountCredentials(root, sid, "claude", "claude-default");
    expect(fs.existsSync(
      path.join(nested, "projects", "-workspace", `${agentSessionId}.jsonl`),
    )).toBe(true);

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(fs.existsSync(
      path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`),
    )).toBe(true);
    expect(recovered).toEqual([agentSessionId]);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("repushAgentToken repairs a leaked symlink in the session dir", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const stale = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, ".credentials.json"), claudeCreds("STALE", 1_000));

    const wrote = repushProviderAccountToken(root, sid, "claude", "claude-default");

    expect(wrote).toBe(true);
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("FRESH");
  });

  it("delivers a rotated token to the path the container reads, with the leak repair suppressed", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("ROTATED", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    // The subpath mount makes this absolute link resolve to a different file in the container.
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const containerVisible = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(containerVisible, { recursive: true });
    fs.writeFileSync(path.join(containerVisible, ".credentials.json"), claudeCreds("STALE", 1_000));

    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default", undefined, undefined,
      { repairLeakedSubtrees: false },
    );

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(true);
    expect(readTail(path.join(containerVisible, ".credentials.json"))).toBe("ROTATED");
  });

  it("repushProviderAccountToken reaches the container-visible token with repair suppressed", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const containerVisible = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(containerVisible, { recursive: true });
    fs.writeFileSync(path.join(containerVisible, ".credentials.json"), claudeCreds("DEAD", 99_000));

    const wrote = repushProviderAccountToken(
      root, sid, "claude", "claude-default", undefined, undefined,
      { repairLeakedSubtrees: false },
    );

    expect(wrote).toBe(true);
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(true);
    expect(readTail(path.join(containerVisible, ".credentials.json"))).toBe("FRESH");
  });

  it("syncProviderAccountTokenIn repairs a leaked symlink on the per-turn sync-in path", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default");

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("FRESH");
  });

  function seedLeakedSessionWithOrphanHistory(opts: {
    accessTail: string;
    expiresAt: number;
    projectDir: string;
    agentSessionId: string;
    jsonlContents: string;
    mtimeMs?: number;
  }): { sessionDir: string; account: string; orphan: string; jsonlPath: string } {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(account, ".claude", ".credentials.json"),
      claudeCreds(opts.accessTail, opts.expiresAt),
    );
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const orphan = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    const projectsDir = path.join(orphan, "projects", opts.projectDir);
    fs.mkdirSync(projectsDir, { recursive: true });
    const jsonlPath = path.join(projectsDir, `${opts.agentSessionId}.jsonl`);
    fs.writeFileSync(jsonlPath, opts.jsonlContents);
    if (opts.mtimeMs !== undefined) {
      fs.utimesSync(jsonlPath, opts.mtimeMs / 1000, opts.mtimeMs / 1000);
    }
    return { sessionDir, account, orphan, jsonlPath };
  }

  const resumableJsonl = (agentSessionId: string) =>
    `${JSON.stringify({ sessionId: agentSessionId, type: "summary" })}\n`
    + `${JSON.stringify({ sessionId: agentSessionId, type: "user", message: { role: "user", content: "hi" } })}\n`
    + `${JSON.stringify({ sessionId: agentSessionId, type: "assistant", message: { role: "assistant", content: "hello" } })}\n`;
  const stubJsonl = (agentSessionId: string) =>
    `${JSON.stringify({ sessionId: agentSessionId, type: "last-prompt", prompt: "x" })}\n`
    + `${JSON.stringify({ sessionId: agentSessionId, type: "ai-title", title: "y" })}\n`;

  it("non-destructive repair: merges orphan conversation history into the rebuilt .claude/", () => {
    const recovered: (string | null)[] = [];
    const onRecover = (id: string | null) => { recovered.push(id); };
    const agentSessionId = "b5903553-cab6-49a9-a9c0-855a7708867d";
    const { sessionDir } = seedLeakedSessionWithOrphanHistory({
      accessTail: "FRESH",
      expiresAt: 9_000,
      projectDir: "-workspace",
      agentSessionId,
      jsonlContents: resumableJsonl(agentSessionId),
    });

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", onRecover);

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("FRESH");
    const mergedJsonl = path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`);
    expect(fs.existsSync(mergedJsonl)).toBe(true);
    const lines = fs.readFileSync(mergedJsonl, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    expect(recovered).toEqual([agentSessionId]);
  });

  it("non-destructive repair: picks the most-recently-modified jsonl when multiple exist", () => {
    const oldSid = "11111111-1111-4111-8111-111111111111";
    const newSid = "22222222-2222-4222-8222-222222222222";
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const orphanProjects = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude", "projects", "-workspace");
    fs.mkdirSync(orphanProjects, { recursive: true });
    const oldJsonl = path.join(orphanProjects, `${oldSid}.jsonl`);
    const newJsonl = path.join(orphanProjects, `${newSid}.jsonl`);
    fs.writeFileSync(oldJsonl, resumableJsonl(oldSid));
    fs.writeFileSync(newJsonl, resumableJsonl(newSid));
    const past = Date.now() / 1000 - 3600;
    const now = Date.now() / 1000;
    fs.utimesSync(oldJsonl, past, past);
    fs.utimesSync(newJsonl, now, now);

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(recovered).toEqual([newSid]);
  });

  it("non-destructive repair: no orphan present → callback fires with null (clear signal)", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(recovered).toEqual([null]);
  });

  it("non-destructive repair: shared-source files win on filename collision with orphan", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude", "projects", "-workspace"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sharedJsonl = path.join(account, ".claude", "projects", "-workspace", "shared.jsonl");
    fs.writeFileSync(sharedJsonl, "SHARED-CONTENT\n");
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const orphanProjects = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude", "projects", "-workspace");
    fs.mkdirSync(orphanProjects, { recursive: true });
    fs.writeFileSync(path.join(orphanProjects, "shared.jsonl"), "ORPHAN-OVERRIDE\n");

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default");

    const merged = fs.readFileSync(path.join(sessionDir, ".claude", "projects", "-workspace", "shared.jsonl"), "utf-8");
    expect(merged).toBe("SHARED-CONTENT\n");
  });

  it("non-destructive repair: preserves orphan .claude.json over the shared baseline", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    fs.writeFileSync(path.join(account, ".claude.json"), '{"projects":{}}');
    fs.rmSync(path.join(root, ".claude.json"), { force: true });
    fs.symlinkSync(path.join(account, ".claude.json"), path.join(root, ".claude.json"));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    fs.symlinkSync(path.join(account, ".claude.json"), path.join(sessionDir, ".claude.json"));
    const orphanRoot = path.join(sessionDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(orphanRoot, { recursive: true });
    fs.writeFileSync(path.join(orphanRoot, ".claude.json"), '{"projects":{"foo":"bar"}}');

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default");

    expect(fs.lstatSync(path.join(sessionDir, ".claude.json")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(sessionDir, ".claude.json"), "utf-8")).toBe('{"projects":{"foo":"bar"}}');
  });

  it("non-destructive repair (case 3): merges orphan history when .claude/ is already a real dir", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const agentSessionId = "b5903553-cab6-49a9-a9c0-855a7708867d";
    const orphanProjects = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default",
      ".claude", "projects", "-workspace",
    );
    fs.mkdirSync(orphanProjects, { recursive: true });
    fs.writeFileSync(
      path.join(orphanProjects, `${agentSessionId}.jsonl`),
      resumableJsonl(agentSessionId),
    );

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    const mergedJsonl = path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`);
    expect(fs.existsSync(mergedJsonl)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    expect(recovered).toEqual([agentSessionId]);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("FRESH");
  });

  it("non-destructive repair (case 3): true no-op when .claude/ is a real dir AND no orphan exists", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("EXISTING", 5_000));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(recovered).toEqual([]);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("non-destructive repair (case 3): does not re-copy shared content over user CLI writes in .claude/", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    fs.writeFileSync(path.join(account, ".claude", "settings.json"), "SHARED-SETTINGS");
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", "settings.json"), "USER-CUSTOMIZED");
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const orphanProjects = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default",
      ".claude", "projects", "-workspace",
    );
    fs.mkdirSync(orphanProjects, { recursive: true });
    fs.writeFileSync(path.join(orphanProjects, "conv.jsonl"), '{"sessionId":"x","type":"summary"}\n');

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default");

    expect(fs.readFileSync(path.join(sessionDir, ".claude", "settings.json"), "utf-8")).toBe("USER-CUSTOMIZED");
    expect(fs.existsSync(path.join(sessionDir, ".claude", "projects", "-workspace", "conv.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  const ACCT_UUID = "acct_11111111-2222-3333-4444-555555555555";

  function seedLegacyNamedOrphan(opts: { withResolvedAccount?: boolean } = {}) {
    if (opts.withResolvedAccount) {
      const account = path.join(root, "provider-accounts", "claude", ACCT_UUID);
      fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    }
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude", "projects", "-workspace"), { recursive: true });
    const orphanRoot = path.join(sessionDir, "provider-accounts", "claude", "claude-default");
    const orphan = path.join(orphanRoot, ".claude");
    fs.mkdirSync(path.join(orphan, "projects", "-workspace"), { recursive: true });
    fs.writeFileSync(path.join(orphan, ".credentials.json"), claudeCreds("ORPHAN", 9_000));
    return { sessionDir, orphan, orphanRoot };
  }

  it("orphan discovery: repairs an orphan under the LEGACY account dir name when the session resolves to acct_<uuid>", () => {
    const { sessionDir, orphan } = seedLegacyNamedOrphan();
    const agentSessionId = "3f0b6a02-1c8d-4f7e-9a55-2b1c0d8e4f11";
    fs.writeFileSync(
      path.join(orphan, "projects", "-workspace", `${agentSessionId}.jsonl`),
      resumableJsonl(agentSessionId),
    );

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID, (id) => { recovered.push(id); });

    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("ORPHAN");
    expect(fs.existsSync(
      path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`),
    )).toBe(true);
    expect(recovered).toEqual([agentSessionId]);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("orphan discovery: a live account credential still wins over the orphan's copy", () => {
    const { sessionDir } = seedLegacyNamedOrphan({ withResolvedAccount: true });
    fs.writeFileSync(
      path.join(sessionDir, ".claude", ".credentials.json"),
      claudeCreds("EXISTING", 9_000),
    );

    syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID);

    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("EXISTING");
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("orphan discovery: merges several stale account dirs in a deterministic order", () => {
    const { sessionDir } = seedLegacyNamedOrphan();
    const olderOrphan = path.join(
      sessionDir, "provider-accounts", "claude", "acct_00000000-old", ".claude",
    );
    fs.mkdirSync(path.join(olderOrphan, "projects", "-workspace"), { recursive: true });
    fs.writeFileSync(path.join(olderOrphan, ".credentials.json"), claudeCreds("OLDER", 9_000));
    fs.writeFileSync(path.join(olderOrphan, "projects", "-workspace", "older.jsonl"), resumableJsonl("older-id"));
    fs.writeFileSync(
      path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude", "projects", "-workspace", "newer.jsonl"),
      resumableJsonl("newer-id"),
    );

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID, (id) => { recovered.push(id); });

    const merged = path.join(sessionDir, ".claude", "projects", "-workspace");
    expect(fs.existsSync(path.join(merged, "older.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(merged, "newer.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    expect(recovered).toEqual(["older-id"]);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("OLDER");
  });

  it("orphan discovery: a failed merge keeps the discovered orphan on disk", () => {
    const { sessionDir, orphan } = seedLegacyNamedOrphan();
    fs.writeFileSync(path.join(orphan, "projects", "-workspace", "conv.jsonl"), resumableJsonl("conv-id"));
    fs.rmSync(path.join(sessionDir, ".claude", "projects"), { recursive: true, force: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", "projects"), "not a directory");

    syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID);

    expect(fs.existsSync(path.join(orphan, "projects", "-workspace", "conv.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(true);
  });

  it("orphan discovery: warns when a subtree has no token and no orphan to recover one from", () => {
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude", "projects"), { recursive: true });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((line) =>
      line.includes(".claude has no token file") && line.includes("fail authentication"),
    )).toBe(true);
  });

  it("orphan discovery: no warning for a healthy session (token present, no orphan)", () => {
    const account = path.join(root, "provider-accounts", "claude", ACCT_UUID);
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("EXISTING", 5_000));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.filter((line) => line.includes("has no token file"))).toEqual([]);
  });

  it("non-destructive repair (case 4): recovers when DB agent_session_id has no matching jsonl on disk", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const goodSid = "b5903553-cab6-49a9-a9c0-855a7708867d";
    const olderSid1 = "11111111-1111-4111-8111-111111111111";
    const olderSid2 = "22222222-2222-4222-8222-222222222222";
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, `${olderSid1}.jsonl`), resumableJsonl(olderSid1));
    fs.writeFileSync(path.join(projectsDir, `${olderSid2}.jsonl`), resumableJsonl(olderSid2));
    fs.writeFileSync(path.join(projectsDir, `${goodSid}.jsonl`), resumableJsonl(goodSid));
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(projectsDir, `${olderSid1}.jsonl`), now - 7200, now - 7200);
    fs.utimesSync(path.join(projectsDir, `${olderSid2}.jsonl`), now - 3600, now - 3600);
    fs.utimesSync(path.join(projectsDir, `${goodSid}.jsonl`), now, now);

    const staleSid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      staleSid,
    );

    expect(recovered).toEqual([goodSid]);
    expect(fs.existsSync(path.join(projectsDir, `${olderSid1}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(projectsDir, `${olderSid2}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(projectsDir, `${goodSid}.jsonl`))).toBe(true);
  });

  it("non-destructive repair (case 4): no callback when the DB id already matches an on-disk jsonl", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const goodSid = "b5903553-cab6-49a9-a9c0-855a7708867d";
    const olderSid = "11111111-1111-4111-8111-111111111111";
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, `${goodSid}.jsonl`), resumableJsonl(goodSid));
    fs.writeFileSync(path.join(projectsDir, `${olderSid}.jsonl`), resumableJsonl(olderSid));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      goodSid,
    );

    expect(recovered).toEqual([]);
  });

  it("non-destructive repair (case 4): no-op when currentAgentSessionId is null (fresh session)", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      null,
    );

    expect(recovered).toEqual([]);
  });

  it("non-destructive repair (case 4): callback fires with null when DB id has no resumable jsonl on disk", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      "doesnt-matter-no-projects-exist",
    );

    expect(recovered).toEqual([null]);
  });

  it("non-destructive repair: malformed jsonl first line → no callback fired", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const orphanProjects = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude", "projects", "-workspace");
    fs.mkdirSync(orphanProjects, { recursive: true });
    fs.writeFileSync(path.join(orphanProjects, "garbage.jsonl"), "not json at all\n");

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(recovered).toEqual([null]);
  });

  it("validator: picks an older real-conversation jsonl over a newer stub-only jsonl", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });

    const realSid = "11111111-1111-4111-8111-111111111111";
    const stubSid = "22222222-2222-4222-8222-222222222222";
    fs.writeFileSync(path.join(projectsDir, `${realSid}.jsonl`), resumableJsonl(realSid));
    fs.writeFileSync(path.join(projectsDir, `${stubSid}.jsonl`), stubJsonl(stubSid));
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(projectsDir, `${realSid}.jsonl`), now - 3600, now - 3600);
    fs.utimesSync(path.join(projectsDir, `${stubSid}.jsonl`), now, now);

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      "stale-db-id-with-no-jsonl",
    );

    expect(recovered).toEqual([realSid]);
  });

  it("validator: ignores a newer resumable conversation from a different project bucket", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));

    const workspaceSid = "11111111-1111-4111-8111-111111111111";
    const otherProjectSid = "9ee27e97-b788-4aed-b1e0-d87c23e2eebf";
    const workspaceDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    const otherProjectDir = path.join(sessionDir, ".claude", "projects", "-tmp-other-project");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(otherProjectDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, `${workspaceSid}.jsonl`), resumableJsonl(workspaceSid));
    fs.writeFileSync(path.join(otherProjectDir, `${otherProjectSid}.jsonl`), resumableJsonl(otherProjectSid));
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(workspaceDir, `${workspaceSid}.jsonl`), now - 60, now - 60);
    fs.utimesSync(path.join(otherProjectDir, `${otherProjectSid}.jsonl`), now, now);

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      "stale-db-id-with-no-jsonl",
    );

    expect(recovered).toEqual([workspaceSid]);
  });

  it("validator: only-stub jsonls present → callback fires with null (clear signal)", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });
    const stubSid1 = "11111111-1111-4111-8111-111111111111";
    const stubSid2 = "22222222-2222-4222-8222-222222222222";
    fs.writeFileSync(path.join(projectsDir, `${stubSid1}.jsonl`), stubJsonl(stubSid1));
    fs.writeFileSync(path.join(projectsDir, `${stubSid2}.jsonl`), stubJsonl(stubSid2));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      "stale-db-id-with-no-jsonl",
    );

    expect(recovered).toEqual([null]);
  });

  it("validator: DB id points at a stub-only jsonl → fires Case 4 anyway, recovers from a sibling real jsonl", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });

    const stubSidInDb = "856d63e4-stub-pointer-from-prod-aaaa";
    const realSid = "11111111-1111-4111-8111-111111111111";
    fs.writeFileSync(path.join(projectsDir, `${stubSidInDb}.jsonl`), stubJsonl(stubSidInDb));
    fs.writeFileSync(path.join(projectsDir, `${realSid}.jsonl`), resumableJsonl(realSid));

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      stubSidInDb,
    );

    expect(recovered).toEqual([realSid]);
  });

  describe("docs/274 req 13 — a rotating Grok subscription token", () => {
    const account = "acct_grok";
    // Match the CLI's scope key, `key` token field, and ISO expiry, not the reader's fallback formats.
    const GROK_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
    const grokAuth = (tag: string, expiresAt: number) =>
      JSON.stringify({
        [GROK_SCOPE]: {
          key: `tok-${tag}`,
          refresh_token: `ref-${tag}`,
          expires_at: new Date(expiresAt).toISOString(),
          auth_mode: "oidc",
          user_id: "user-fixture",
        },
      });

    function seedAccount(expiresAt: number, tag = "SOURCE"): string {
      const accountRoot = path.join(root, "provider-accounts", "grok", account);
      fs.mkdirSync(path.join(accountRoot, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(accountRoot, ".grok", "auth.json"), grokAuth(tag, expiresAt));
      return accountRoot;
    }

    it("syncs the account's token into the session at turn start", () => {
      seedAccount(9_000_000_000_000);
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });

      syncProviderAccountTokenIn(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(sessionDir, ".grok", "auth.json"), "utf-8")).toContain("tok-SOURCE");
    });

    it("never overwrites a session token that is already fresher", () => {
      seedAccount(1_000_000_000_000, "STALE");
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "auth.json"), grokAuth("ROTATED", 9_000_000_000_000));

      syncProviderAccountTokenIn(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(sessionDir, ".grok", "auth.json"), "utf-8")).toContain("tok-ROTATED");
    });

    it("publishes a rotation back to the account source", () => {
      const accountRoot = seedAccount(1_000_000_000_000, "OLD");
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "auth.json"), grokAuth("ROTATED", 9_000_000_000_000));
      writeSessionAccountMarker(root, sid, "grok", account);

      syncProviderAccountTokenBack(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(accountRoot, ".grok", "auth.json"), "utf-8")).toContain("tok-ROTATED");
    });

    it("refuses to publish into an account the subtree does not hold", () => {
      const accountRoot = seedAccount(1_000_000_000_000, "OLD");
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "auth.json"), grokAuth("OTHER", 9_000_000_000_000));
      writeSessionAccountMarker(root, sid, "grok", "acct_someone_else");

      syncProviderAccountTokenBack(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(accountRoot, ".grok", "auth.json"), "utf-8")).toContain("tok-OLD");
    });

    it("touches nothing in .grok but auth.json", () => {
      const accountRoot = seedAccount(9_000_000_000_000);
      fs.writeFileSync(path.join(accountRoot, ".grok", "config.toml"), 'shared = true\n');
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok", "sessions"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "sessions", "conversation.json"), '{"turns":1}');
      fs.writeFileSync(path.join(sessionDir, ".grok", "config.toml"), 'session_local = true\n');

      syncProviderAccountTokenIn(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(sessionDir, ".grok", "sessions", "conversation.json"), "utf-8")).toBe('{"turns":1}');
      expect(fs.readFileSync(path.join(sessionDir, ".grok", "config.toml"), "utf-8")).toContain("session_local");
    });

    it("does not warn about a missing token on a key-billed session", () => {
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        syncAgentTokenIn(root, sid, "grok");
        const complaints = warn.mock.calls
          .map((call) => call.join(" "))
          .filter((line) => line.includes("no token file"));
        expect(complaints).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it("still warns when an account-scoped session has no token", () => {
      seedAccount(9_000_000_000_000);
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.rmSync(path.join(root, "provider-accounts", "grok", account, ".grok", "auth.json"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        syncProviderAccountTokenIn(root, sid, "grok", account);
        const complaints = warn.mock.calls
          .map((call) => call.join(" "))
          .filter((line) => line.includes("no token file"));
        expect(complaints.length).toBeGreaterThan(0);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("docs/153 — Codex rollout preservation", () => {
    const threadId = "019fb994-733e-7051-86da-e7a800bfc710";
    const rolloutRel = path.join("sessions", "2026", "07", "31", `rollout-2026-07-31T19-20-00-${threadId}.jsonl`);
    const codexAuth = (tail: string, exp: number) => JSON.stringify({
      tokens: { access_token: `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig-${tail}` },
    });

    function seedLeakedCodexWithRollout(): { sessionDir: string; orphan: string; account: string } {
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      fs.writeFileSync(path.join(account, ".codex", "config.toml"), 'model = "gpt-5"\n');

      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.symlinkSync(path.join(account, ".codex"), path.join(sessionDir, ".codex"));

      const orphan = path.join(sessionDir, "provider-accounts", "codex", "codex-default", ".codex");
      fs.mkdirSync(path.dirname(path.join(orphan, rolloutRel)), { recursive: true });
      fs.writeFileSync(path.join(orphan, rolloutRel), `${JSON.stringify({ id: threadId, type: "session_meta" })}\n`);
      fs.writeFileSync(path.join(orphan, "history.jsonl"), `${JSON.stringify({ text: "earlier prompt" })}\n`);
      fs.writeFileSync(path.join(orphan, "auth.json"), codexAuth("STALE", 1_000));
      return { sessionDir, orphan, account };
    }

    it("survives a live leaked-symlink repair and drops the orphan only after preserving it", () => {
      const { sessionDir } = seedLeakedCodexWithRollout();

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      expect(fs.lstatSync(path.join(sessionDir, ".codex")).isSymbolicLink()).toBe(false);
      const merged = path.join(sessionDir, ".codex", rolloutRel);
      expect(fs.existsSync(merged)).toBe(true);
      expect(fs.readFileSync(merged, "utf-8")).toContain(threadId);
      expect(fs.existsSync(path.join(sessionDir, ".codex", "history.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    });

    it("does not let the orphan's stale auth/config clobber the shared baseline", () => {
      const { sessionDir } = seedLeakedCodexWithRollout();

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      expect(fs.readFileSync(path.join(sessionDir, ".codex", "auth.json"), "utf-8")).toContain("FRESH");
      expect(fs.existsSync(path.join(sessionDir, ".codex", "config.toml"))).toBe(true);
    });

    it("case 3: recovers a rollout from a post-repair orphan when .codex/ is already a real dir", () => {
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));

      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      const orphan = path.join(sessionDir, "provider-accounts", "codex", "codex-default", ".codex");
      fs.mkdirSync(path.dirname(path.join(orphan, rolloutRel)), { recursive: true });
      fs.writeFileSync(path.join(orphan, rolloutRel), `${JSON.stringify({ id: threadId })}\n`);

      const recovered: (string | null)[] = [];
      syncProviderAccountTokenIn(
        root, sid, "codex", "codex-default",
        (id) => { recovered.push(id); },
        threadId,
      );

      expect(fs.existsSync(path.join(sessionDir, ".codex", rolloutRel))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
      expect(recovered).toEqual([]);
    });

    it("keeps the orphan when preservation fails — never delete the only copy", () => {
      const { sessionDir, orphan } = seedLeakedCodexWithRollout();
      fs.rmSync(path.join(sessionDir, ".codex"), { force: true, recursive: true });
      fs.mkdirSync(path.join(sessionDir, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      fs.writeFileSync(path.join(sessionDir, ".codex", "sessions"), "not a directory");

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      expect(fs.existsSync(path.join(orphan, rolloutRel))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(true);
    });

    it("an unknown credential subtree is never deleted (fail-safe default)", () => {
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.symlinkSync(path.join(account, ".codex"), path.join(sessionDir, ".codex"));
      const orphan = path.join(sessionDir, "provider-accounts", "codex", "codex-default", ".codex");
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(path.join(orphan, "auth.json"), codexAuth("STALE", 1_000));

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    });

    it("clears a stale Codex thread pointer when no rollout exists on disk", () => {
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".codex", "sessions"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));

      const recovered: (string | null)[] = [];
      syncProviderAccountTokenIn(
        root, sid, "codex", "codex-default",
        (id) => { recovered.push(id); },
        threadId,
      );

      expect(recovered).toEqual([null]);
    });

    it("leaves a live Codex thread pointer alone when its rollout is present", () => {
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.dirname(path.join(sessionDir, ".codex", rolloutRel)), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".codex", rolloutRel), "{}\n");
      fs.writeFileSync(path.join(sessionDir, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));

      const recovered: (string | null)[] = [];
      syncProviderAccountTokenIn(
        root, sid, "codex", "codex-default",
        (id) => { recovered.push(id); },
        threadId,
      );

      expect(recovered).toEqual([]);
    });

    it("does not clear on a fresh session with no thread pointer yet", () => {
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));

      const recovered: (string | null)[] = [];
      syncProviderAccountTokenIn(
        root, sid, "codex", "codex-default",
        (id) => { recovered.push(id); },
        null,
      );

      expect(recovered).toEqual([]);
    });

    it("a Claude session's jsonl state is unaffected by the Codex probe", () => {
      const account = path.join(root, "provider-accounts", "claude", "claude-default");
      fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
      const sessionDir = perSessionCredentialsDir(root, sid);
      const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
      const claudeSid = "11111111-1111-4111-8111-111111111111";
      fs.writeFileSync(path.join(projectsDir, `${claudeSid}.jsonl`), resumableJsonl(claudeSid));

      const recovered: (string | null)[] = [];
      syncProviderAccountTokenIn(
        root, sid, "claude", "claude-default",
        (id) => { recovered.push(id); },
        claudeSid,
      );

      expect(recovered).toEqual([]);
    });
  });

  it("removeSessionCredentials drops the subtree and is idempotent", () => {
    provisionAgentCredentials(root, sid, "claude");
    expect(fs.existsSync(perSessionCredentialsDir(root, sid))).toBe(true);
    removeSessionCredentials(root, sid);
    expect(fs.existsSync(perSessionCredentialsDir(root, sid))).toBe(false);
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(true);
    expect(() => removeSessionCredentials(root, sid)).not.toThrow();
  });

  describe("sub-agent credentials (docs/144)", () => {
    it("provisions only the sub-agent subtree next to the pinned agent's", () => {
      provisionAgentCredentials(root, sid, "claude");
      const dir = perSessionCredentialsDir(root, sid);
      expect(fs.existsSync(path.join(dir, ".claude"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);

      provisionSubAgentCredentials(root, sid, "codex");
      expect(fs.existsSync(path.join(dir, ".codex", "auth.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".claude", ".credentials.json"))).toBe(true);
    });

    it("removes cross-provider auth and config, leaving the pinned agent intact", () => {
      provisionAgentCredentials(root, sid, "claude");
      provisionSubAgentCredentials(root, sid, "codex");
      const dir = perSessionCredentialsDir(root, sid);
      expect(fs.existsSync(path.join(dir, ".codex"))).toBe(true);

      removeSubAgentCredentials(root, sid, "codex");
      expect(fs.existsSync(path.join(dir, ".codex", "auth.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, ".claude", ".credentials.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(true);
    });

    it("preserves a Codex parent's rollout across same-harness reviewer cleanup", () => {
      provisionAgentCredentials(root, sid, "codex");
      const dir = perSessionCredentialsDir(root, sid);
      const rollout = path.join(dir, ".codex", "sessions", "2026", "08", "14", "rollout-parent.jsonl");
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.writeFileSync(rollout, '{"thread_id":"parent-thread"}\n');
      fs.writeFileSync(path.join(dir, ".codex", "config.toml"), 'model = "reviewer-model"\n');

      removeSubAgentCredentials(root, sid, "codex");

      expect(fs.readFileSync(rollout, "utf8")).toContain("parent-thread");
      expect(fs.existsSync(path.join(dir, ".codex", "auth.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, ".codex", "config.toml"))).toBe(false);
    });

    it.each(["failure", "cancellation"])(
      "preserves Claude resume state and removes temporary credentials after %s",
      () => {
        provisionAgentCredentials(root, sid, "claude");
        const dir = perSessionCredentialsDir(root, sid);
        const conversation = path.join(dir, ".claude", "projects", "-workspace", "parent.jsonl");
        fs.mkdirSync(path.dirname(conversation), { recursive: true });
        fs.writeFileSync(conversation, '{"sessionId":"parent"}\n');
        fs.writeFileSync(path.join(dir, ".claude", "settings.json"), '{}');

        removeSubAgentCredentials(root, sid, "claude");

        expect(fs.existsSync(conversation)).toBe(true);
        expect(fs.existsSync(path.join(dir, ".claude", ".credentials.json"))).toBe(false);
        expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
        expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(false);
      },
    );

    it("removeSubAgentCredentials is best-effort on a missing subtree", () => {
      provisionAgentCredentials(root, sid, "claude");
      expect(() => removeSubAgentCredentials(root, sid, "codex")).not.toThrow();
    });
  });
});
