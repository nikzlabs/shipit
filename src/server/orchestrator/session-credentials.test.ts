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

/**
 * Build a fake source-of-truth credentials root with both agents' creds plus
 * the shared .gitconfig — mirrors the live `/credentials` layout.
 */
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
    // The borrow ledger is process-local, so a test that provisions a borrow
    // without releasing it would otherwise leak into the next one.
    clearSubtreeBorrows();
  });

  it("computes the per-session dir and POSIX subpath", () => {
    expect(perSessionCredentialsDir(root, sid)).toBe(path.join(root, "sessions", sid));
    expect(perSessionCredentialsSubpath(sid)).toBe(`sessions/${sid}`);
    expect(sessionCredentialsRoot(root)).toBe(path.join(root, "sessions"));
  });

  // docs/150 §7 — the orchestrator writes per-session creds AFTER the container
  // boots (its boot-time chown can't see them), so every writer hands the
  // subtree to the worker UID. No-op unless SHIPIT_SESSION_WORKER_UID is set.
  describe("docs/150 §7 — worker-UID ownership handoff", () => {
    const prev = process.env.SHIPIT_SESSION_WORKER_UID;
    afterEach(() => {
      if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = prev;
    });

    it("scaffold + provision chown the subtree to the worker UID when set", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      // Should not throw and should leave the whole subtree owned by myUid.
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

    // docs/150 + docs/155 — the auto-memory dir is written into the per-session
    // subtree on the first turn (after boot). The agent must be able to WRITE
    // new memory there, not just read it, so provisionRepoMemory hands the
    // freshly-created memory dir to the worker UID too.
    it("provisionRepoMemory chowns the seeded memory dir to the worker UID", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      // Seed a shared per-repo memory file so something gets mirrored in.
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

  /**
   * #2432 — a session that ran the server test suite in-box had its brokered
   * `/credentials/.gitconfig` rewritten to `cat` a `.git-credential-github`
   * holding a 5-character fixture token, and could not push again. The suite
   * hole is closed in `server-test-setup.ts`; this is the repair for the
   * sessions already carrying the artifact, which runs on every container
   * create. The regenerated gitconfig no longer references the file, so what is
   * left is a stale credential sitting where the agent can reach it.
   */
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
    // Cross-agent isolation: a warm/idle container carries NO agent creds.
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
    // The Codex session would read these — they must be absent.
    expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);
    // shipit-credentials.json is never copied into a session container.
    expect(fs.existsSync(path.join(dir, "shipit-credentials.json"))).toBe(false);
  });

  // A freshly provisioned Claude session container must start TRUSTED: without
  // `projects["/workspace"].hasTrustDialogAccepted` the CLI silently drops the
  // workspace's own `.claude/settings.json` permissions.allow entries. The
  // orchestrator-side login flow writes this into a DIFFERENT file than the one
  // the container reads, so provisioning has to write it here.
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

    // Provisioning runs once per session, so sessions pinned before this
    // existed only heal via the per-turn re-assert.
    it("ensureSessionAgentUserConfig heals an already-provisioned session and is idempotent", () => {
      provisionAgentCredentials(root, sid, "claude");
      const configPath = path.join(perSessionCredentialsDir(root, sid), ".claude.json");
      // Simulate a session provisioned by the old code path.
      fs.writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));

      ensureSessionAgentUserConfig(root, sid, "claude");
      expect(readSessionConfig().projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
      expect(readSessionConfig().oauthAccount).toEqual({ emailAddress: "a@b.c" });

      const after = fs.readFileSync(configPath, "utf-8");
      ensureSessionAgentUserConfig(root, sid, "claude");
      expect(fs.readFileSync(configPath, "utf-8")).toBe(after);
    });

    // Cross-agent isolation: a Codex session must not grow a Claude config.
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
    // This assertion used to be `.codex` does NOT exist, and that was the bug.
    // "Agent never logged in" is exactly the key-billed shape: the credential
    // travels as an env var, `copyCredentialPath` early-returns on a missing
    // source, and the image has ALREADY symlinked `~/.codex` at this path — so
    // leaving nothing here leaves the link DANGLING. That is not a harmless
    // absence: a dangling symlink is an existing directory entry, so the CLI's
    // own `mkdir` fails and it dies at startup (grok did exactly this in every
    // session container; OpenCode did it before that, docs/270).
    fs.rmSync(path.join(root, ".codex"), { recursive: true, force: true });
    expect(() => provisionAgentCredentials(root, sid, "codex")).not.toThrow();
    const dir = perSessionCredentialsDir(root, sid);
    // The directory exists…
    expect(fs.statSync(path.join(dir, ".codex")).isDirectory()).toBe(true);
    // …and is EMPTY. Materializing the mount point must never invent credential
    // material, which is what keeps the docs/138 isolation guarantee intact.
    expect(fs.readdirSync(path.join(dir, ".codex"))).toEqual([]);
    // .gitconfig still provisioned.
    expect(fs.existsSync(path.join(dir, ".gitconfig"))).toBe(true);
  });

  // docs/142 A — per-turn OAuth token sync (rotating refresh token fix)

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

  // docs/150-multiple-provider-subscriptions req 9 — an account switch reprovisions credentials but must not
  // take the session's conversation with it. Claude resumes from
  // `.claude/projects/<encoded-cwd>/<agentSessionId>.jsonl` and Codex from
  // `.codex/sessions/.../rollout-*.jsonl`; both are per-session files that
  // carry no account identity, so switching accounts does not invalidate them.
  it("reprovisioning from another account preserves conversation state but replaces credentials", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    writeClaudeToken(accountA, "A", 3_000);
    writeClaudeToken(accountB, "B", 4_000);

    provisionProviderAccountCredentials(root, sid, "claude", "acct-a");

    // The session runs a turn: the CLI writes its conversation jsonl, plus a
    // settings file that only account A produces.
    const sessionDir = perSessionCredentialsDir(root, sid);
    const transcript = path.join(sessionDir, ".claude", "projects", "-workspace", "conv-1.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    fs.writeFileSync(path.join(sessionDir, ".claude", "settings.json"), '{"onlyUnderA":true}');

    provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

    // Conversation survives …
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.readFileSync(transcript, "utf-8")).toBe('{"type":"user"}\n');
    // … credentials are account B's …
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("B");
    // … and A-only leftovers are gone.
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
    provisionAgentCredentials(root, sid, "claude"); // session starts with the source token
    // Source rotates to a newer token (simulating a prior write-back).
    writeClaudeToken(root, "FRESH", 9_000);

    syncAgentTokenIn(root, sid, "claude");

    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("FRESH");
  });

  it("syncAgentTokenIn does NOT clobber a fresher session token with a staler source", () => {
    writeClaudeToken(root, "STALE", 1_000); // source is older (e.g. not yet refreshed)
    fs.mkdirSync(path.join(perSessionCredentialsDir(root, sid), ".claude"), { recursive: true });
    writeClaudeToken(perSessionCredentialsDir(root, sid), "LOCAL", 5_000); // session refreshed locally

    syncAgentTokenIn(root, sid, "claude");

    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("LOCAL"); // kept its fresher token
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
    // The session's CLI refreshed to a later-expiry token.
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

    // A turn that moves the session to acct-b makes the subtree acct-b's FIRST
    // (`ensureSessionAccountCredentials`, docs/260 req 4) and only then syncs
    // the token. The write-back publishes to the account the subtree records,
    // so the two steps are one sequence, not two independent ones.
    writeSessionAccountMarker(root, sid, "claude", "acct-b");
    syncProviderAccountTokenIn(root, sid, "claude", "acct-b");
    expect(readTail(path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json"))).toBe("B-NEW");

    writeClaudeToken(perSessionCredentialsDir(root, sid), "B-ROTATED", 12_000);
    syncProviderAccountTokenBack(root, sid, "claude", "acct-b");

    expect(readTail(path.join(accountB, ".claude", ".credentials.json"))).toBe("B-ROTATED");
    expect(readTail(path.join(accountA, ".claude", ".credentials.json"))).toBe("A-OLD");
  });

  // A same-harness consult (`shipit agent run`, session naming, voice cleanup)
  // BORROWS the session's own credential subtree for an account chosen
  // independently of the session's. While that borrow is in place the session's
  // token file holds the borrowed account's bearer, and every write-back path —
  // the turn-end sync-back and the mid-turn publisher — is still pointed at the
  // session's own account. Publishing then copies one account's credential into
  // another account's root, which is the duplicate-bearer state
  // `quarantineDuplicateClaudeCredentials` exists to clean up after.
  it("does not publish a BORROWED account's token into the session's own account root", () => {
    const accountA = path.join(root, "provider-accounts", "claude", "acct-a");
    const accountB = path.join(root, "provider-accounts", "claude", "acct-b");
    // A was just reconnected, so its token has the latest expiry of the two —
    // which is exactly what makes the freshness guard wave the write through.
    writeClaudeToken(accountA, "A-FRESH", 12_000);
    writeClaudeToken(accountB, "B-LIVE", 5_000);
    provisionProviderAccountCredentials(root, sid, "claude", "acct-b"); // the session runs on B
    provisionSubAgentCredentials(root, sid, "claude", "acct-a"); // a consult borrows A

    syncProviderAccountTokenBack(root, sid, "claude", "acct-b");

    expect(readTail(path.join(accountB, ".claude", ".credentials.json"))).toBe("B-LIVE");
  });

  // The same hazard in the direction that looks safe. A reserved/legacy-route
  // session still gets same-harness background work, and that work routes to an
  // account of its own — so the flat write-back can be handed an account's
  // bearer. The flat root is `migrateProviderDefault`'s "this install has
  // pre-account credentials" marker, so a copy landing there mints an extra
  // account row at the next boot, holding a duplicate of a real account's token.
  it("does not publish a borrowed account's token into the flat root", () => {
    writeClaudeToken(root, "FLAT", 1_000);
    writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A-FRESH", 12_000);
    fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
    provisionSubAgentCredentials(root, sid, "claude", "acct-a"); // background work borrows A

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

    // The borrow's own write-back still reaches the account it actually ran on.
    writeClaudeToken(perSessionCredentialsDir(root, sid), "A-ROTATED", 15_000);
    syncProviderAccountTokenBack(root, sid, "claude", "acct-a");
    expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
      .toBe("A-ROTATED");
  });

  /**
   * The 2026-08-21 incident class: a SAME-harness spawn must never write the
   * session's own subtree, because the LIVE primary CLI re-reads its credential
   * file mid-turn — a cross-provider provision there 401s it within seconds and
   * the quiet auth retry loops the turn. The spawn gets an isolated per-spawn
   * home instead, and the session subtree stays byte-identical throughout.
   */
  describe("same-harness spawn home isolation", () => {
    const spawnId = "spawn-1234";

    it("provisions into the per-spawn home and leaves the session subtree byte-identical", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b"); // the session runs on B
      const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
      const before = fs.readFileSync(sessionFile, "utf-8");

      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");

      // The primary's file and marker are untouched — the regression.
      expect(fs.readFileSync(sessionFile, "utf-8")).toBe(before);
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-b");
      // The spawn home holds the consult's own account copy, plus the CLI's
      // normalized user config.
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      expect(readTail(path.join(home, ".claude", ".credentials.json"))).toBe("A");
      expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(true);
    });

    it("provisions the flat root's copy when no account routes the spawn (the GLM shape)", () => {
      fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
      writeClaudeToken(perSessionCredentialsDir(root, sid), "SESSION-LIVE", 9_000);

      provisionSubAgentSpawnHome(root, sid, spawnId, "claude");

      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      // The flat root's seeded token (`claude-tok`, no expiry shape) was copied.
      expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
      expect(readTail(path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json")))
        .toBe("SESSION-LIVE");
    });

    it("release publishes a fresher rotation to the account root and removes the home", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000); // the consult's CLI rotated

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

    /**
     * Cross-agent review finding — the release must take its write-back target
     * from the home's own provenance, never from the caller. A suppressed
     * removal failure can leave the FAILED account's copy in the home while
     * the failover loop has already moved on to the fallback account; a
     * caller-supplied target would then copy one account's bearer into another
     * account's root (the duplicate-bearer class the marker machinery exists
     * to prevent, resurfacing one directory over).
     */
    it("release publishes to the provenance-named root, whatever the caller's world says", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000);

      // The service-level caller has moved `accountId` on to acct-b by now —
      // and can no longer say so: the release reads only the provenance.
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

      // Unproven content is deleted, never published.
      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A");
      expect(fs.existsSync(home)).toBe(false);
    });

    /**
     * Cross-agent review finding — an orchestrator restart orphans the home
     * (the releasing `finally` died with the process), and with rotating
     * refresh tokens a deleted rotation permanently kills the source
     * credential. The container-create sweep therefore RELEASES each home —
     * provenance-driven write-back first — rather than deleting blind.
     */
    it("container-create sweep publishes a stranded rotation, then removes the homes", () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
      provisionSubAgentSpawnHome(root, sid, "spawn-flat", "claude");
      const home = subAgentSpawnHomeDir(root, sid, spawnId);
      writeClaudeToken(home, "A-ROTATED", 15_000); // rotation stranded by a crash

      sweepSubAgentSpawnHomes(root, sid);

      expect(readTail(path.join(root, "provider-accounts", "claude", "acct-a", ".claude", ".credentials.json")))
        .toBe("A-ROTATED");
      expect(fs.existsSync(home)).toBe(false);
      expect(fs.existsSync(subAgentSpawnHomeDir(root, sid, "spawn-flat"))).toBe(false);
      expect(fs.existsSync(path.join(perSessionCredentialsDir(root, sid), "sub-agent-homes"))).toBe(false);
    });

    /**
     * planning#448's other half, at the cleanup site PR #2514 did not cover.
     * A refusal is `classifyTokenFreshness` saying it cannot ORDER the two
     * copies (planning#449) — not that the spawn's copy is worthless. Refusing
     * and then `rmSync`-ing the home turns "we cannot tell which is newer" into
     * "the newer one is gone", which for a single-use refresh token is the
     * permanent death of the source credential.
     */
    describe("a refused publish is quarantined, never deleted", () => {
      const strandedDir = (accountRoot: string) => path.join(accountRoot, ".shipit-stranded-tokens");
      const strandedFiles = (accountRoot: string) => {
        try {
          return fs.readdirSync(strandedDir(accountRoot));
        } catch {
          return [];
        }
      };
      /** Valid JSON credential with no expiry — what an `unorderable` reading looks like. */
      const unorderableCreds = (tail: string) => `{"claudeAiOauth":{"accessToken":"tok-${tail}"}}`;

      it("keeps a rotation whose OWN copy cannot be ordered", () => {
        const accountRoot = path.join(root, "provider-accounts", "claude", "acct-a");
        writeClaudeToken(accountRoot, "A", 12_000);
        provisionSubAgentSpawnHome(root, sid, spawnId, "claude", "acct-a");
        const home = subAgentSpawnHomeDir(root, sid, spawnId);
        // The consult's CLI rotated, but in a shape this agent's reader no
        // longer understands — the planning#449 failure mode.
        fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), unorderableCreds("ROTATED"));

        releaseSubAgentSpawnHome(root, sid, spawnId);

        expect(fs.existsSync(home)).toBe(false);
        // The destination is deliberately untouched — the publish was refused.
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
        // The source went unorderable after the provision (a reader that has
        // stopped matching its CLI reads EVERY real file this way).
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

      /**
       * PR #2514's rescue, rescued in turn. The grok adapter quarantines a
       * rotation it could not publish beside its destination — and in a
       * same-harness spawn that destination is `$HOME/.grok/auth.json`, i.e.
       * INSIDE the home this release then deletes. The refusal is also
       * self-concealing: the declared token file still holds the pre-rotation
       * copy, so the ordinary publish sees nothing to do and reports success.
       */
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
        // What the adapter leaves behind: the token file untouched at the old
        // copy, the rotation only in its own `.stranded-` sibling.
        fs.writeFileSync(
          path.join(home, ".grok", "auth.json.stranded-1756000000000"),
          JSON.stringify({ "xai:api": { access_token: "tok-ROTATED" } }),
        );

        releaseSubAgentSpawnHome(root, sid, spawnId);

        expect(fs.existsSync(home)).toBe(false);
        const kept = strandedFiles(accountRoot);
        expect(kept).toEqual([".grok_auth.json.stranded-1756000000000"]);
        expect(JSON.parse(fs.readFileSync(path.join(strandedDir(accountRoot), kept[0]), "utf-8")))
          .toMatchObject({ "xai:api": { access_token: "tok-ROTATED" } });
      });

      /**
       * Why the quarantine sits in its own directory rather than beside its
       * destination as `.credentials.json.stranded-…`: provisioning copies the
       * DECLARED credential paths wholesale, so a sibling inside `.claude/`
       * would ride into every later session subtree and spawn home — one
       * refusal fanning a live bearer out across the host.
       */
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
    });

    it("the container path pairs with the host path under the /credentials mount", () => {
      expect(subAgentSpawnHomeContainerDir(spawnId)).toBe(`/credentials/sub-agent-homes/${spawnId}`);
      expect(subAgentSpawnHomeDir(root, sid, spawnId)).toBe(
        path.join(perSessionCredentialsDir(root, sid), "sub-agent-homes", spawnId),
      );
    });
  });

  /**
   * planning#445 — the incident the borrow ledger exists for.
   *
   * Losing the marker is not a cosmetic bookkeeping error: every write-back
   * afterwards is refused, and a refused write-back DROPS a rotation whose
   * token has already invalidated the source's copy upstream. The account then
   * fails every refresher tick, the CLI erases the source file about an hour
   * later, and the user is made to sign in again — which is how a reconnect
   * interval of a week or more became one of a day or two.
   */
  describe("a borrow never loses the session's own account", () => {
    const seedTwoAccounts = () => {
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-a"), "A", 12_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
    };

    it("restores the session's account after an ordinary borrow", () => {
      seedTwoAccounts();
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b"); // the session runs on B
      provisionSubAgentCredentials(root, sid, "claude", "acct-a"); // a consult borrows A

      expect(releaseSubAgentCredentials(root, sid, "claude")).toBe("acct-b");
    });

    /**
     * The exact shape that stranded the account in production. The second
     * borrow's own pre-read of the marker returns `undefined` — the first
     * borrow's wipe has already cleared it — so a caller that captured the
     * account itself restored nothing and left the subtree with NO marker.
     * The ledger's re-entrancy makes the outer borrow's capture the answer for
     * both.
     */
    it("survives a borrow taken while the marker reads as absent", () => {
      seedTwoAccounts();
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

      provisionSubAgentCredentials(root, sid, "claude", "acct-a"); // borrow 1
      removeSubAgentCredentials(root, sid, "claude"); // its wipe: the marker is now absent
      expect(readSessionAccountMarker(root, sid).claude).toBeUndefined();

      provisionSubAgentCredentials(root, sid, "claude", "acct-a"); // borrow 2, into that window
      expect(releaseSubAgentCredentials(root, sid, "claude")).toBe("acct-b");
    });

    it("reports no account to restore for a session that never had one", () => {
      seedTwoAccounts();
      fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
      provisionSubAgentCredentials(root, sid, "claude", "acct-a");

      expect(releaseSubAgentCredentials(root, sid, "claude")).toBeUndefined();
    });

    /**
     * The marker write is temp + rename, so a reader can only ever observe the
     * old value or the new one. The old in-place `writeFileSync` truncated
     * first, and a reader landing in that window parsed nothing and reported
     * "no recorded account" — the same permanent refusal a genuinely lost
     * marker causes, from a write that was working perfectly.
     */
    it("never exposes an empty marker mid-write", () => {
      seedTwoAccounts();
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b");

      const observed: (string | undefined)[] = [];
      const realRename = fs.renameSync;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        // Mid-write: the temp file holds the new value, the marker still holds
        // the old one. A concurrent reader must see an account either way.
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
      // And no temp file left behind in the subtree the container mounts.
      const leftovers = fs.readdirSync(perSessionCredentialsDir(root, sid)).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    });
  });

  /**
   * planning#445 — an absent marker is resolved, not assumed. The write-back
   * may repair one it can prove is lost, and only then; a dropped rotation
   * kills the source credential, so "refuse and move on" is the expensive
   * branch, not the safe one.
   */
  describe("write-back marker repair", () => {
    const rotateInSession = () => writeClaudeToken(perSessionCredentialsDir(root, sid), "ROTATED", 15_000);
    const accountA = () => path.join(root, "provider-accounts", "claude", "acct-a");

    it("repairs a lost marker for the session's own turn route and publishes the rotation", () => {
      writeClaudeToken(accountA(), "A", 12_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      writeSessionAccountMarker(root, sid, "claude", null); // the marker went missing
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("ROTATED");
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-a");
    });

    /**
     * The repair and the refusals are the only signal an operator has for how
     * often a marker goes missing in production, so the countable part of the
     * line is behavior, not decoration. The prose is pinned too: the incident
     * was diagnosed by grepping "refusing … token write-back", and a runbook
     * that stops matching is worse than no structure at all.
     */
    it("logs each outcome as a countable record, keeping the greppable prose", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The write-back also chowns and seals the subtree, which can warn on its
      // own — pick the write-back's line rather than whatever warned last.
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

        // A refusal is countable by the rule that fired, and still carries the
        // sentence the incident was grepped by.
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

      // No `sessionOwnRoute`: this is the borrow's own write-back, and it has
      // no standing to say whose copy is on disk.
      syncProviderAccountTokenBack(root, sid, "claude", "acct-a");

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
      expect(readSessionAccountMarker(root, sid).claude).toBeUndefined();
    });

    /**
     * The cross-account guarantee, in the one case the repair could have
     * weakened it: a borrow on a legacy/flat route records NO account, so the
     * absent marker is truthful and the subtree holds someone else's bearer.
     * The ledger says a borrow is in flight, and the write-back refuses.
     */
    it("refuses while a flat-route borrow holds the subtree", () => {
      writeClaudeToken(accountA(), "A", 12_000);
      writeClaudeToken(root, "FLAT", 1_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      provisionSubAgentCredentials(root, sid, "claude"); // legacy route: marker cleared
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
      expect(readSessionAccountMarker(root, sid).claude).toBeUndefined();

      // And once the borrow ends, the same call repairs and publishes.
      expect(releaseSubAgentCredentials(root, sid, "claude")).toBe("acct-a");
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      writeSessionAccountMarker(root, sid, "claude", null);
      rotateInSession();
      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });
      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("ROTATED");
    });

    /**
     * The borrow writes its marker AFTER its copy lands, so a marker that
     * agrees with the session's route is not by itself proof that the token
     * under it is the session's. For the duration of a borrow a session-route
     * caller publishes nothing, whatever the marker says.
     */
    it("refuses a session-route publish for the whole borrow, marker agreement included", () => {
      writeClaudeToken(accountA(), "A", 1_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-a");
      provisionSubAgentCredentials(root, sid, "claude", "acct-a"); // a consult borrows the same account
      expect(readSessionAccountMarker(root, sid).claude).toBe("acct-a"); // marker agrees
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
      releaseSubAgentCredentials(root, sid, "claude");
    });

    it("still refuses when the marker names a different account", () => {
      writeClaudeToken(accountA(), "A", 1_000);
      writeClaudeToken(path.join(root, "provider-accounts", "claude", "acct-b"), "B", 5_000);
      provisionProviderAccountCredentials(root, sid, "claude", "acct-b"); // the subtree is B's
      rotateInSession();

      syncProviderAccountTokenBack(root, sid, "claude", "acct-a", { sessionOwnRoute: true });

      expect(readTail(path.join(accountA(), ".claude", ".credentials.json"))).toBe("A");
    });
  });

  it("syncAgentTokenBack does NOT clobber a fresher source (failed-refresh race guard)", () => {
    writeClaudeToken(root, "GOOD", 9_000); // source already advanced (e.g. by another session)
    fs.mkdirSync(path.join(perSessionCredentialsDir(root, sid), ".claude"), { recursive: true });
    writeClaudeToken(perSessionCredentialsDir(root, sid), "STALE", 1_000); // this session never refreshed

    syncAgentTokenBack(root, sid, "claude");

    // The stale session token must not regress the fresher source.
    expect(readTail(path.join(root, ".claude", ".credentials.json"))).toBe("GOOD");
  });

  // docs/142 A — Codex token sync (auth.json carries no plain expiry; freshness
  // comes from the access-token JWT `exp` claim).

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
    writeCodexToken(root, 9_000); // source rotated to a later-expiry token

    syncAgentTokenIn(root, sid, "codex");

    expect(readCodexExp(sessionCodexFile())).toBe(9_000);
  });

  it("syncAgentTokenIn does NOT clobber a fresher session Codex token", () => {
    writeCodexToken(root, 1_000); // staler source
    fs.mkdirSync(path.join(perSessionCredentialsDir(root, sid), ".codex"), { recursive: true });
    writeCodexToken(perSessionCredentialsDir(root, sid), 5_000); // session refreshed locally

    syncAgentTokenIn(root, sid, "codex");

    expect(readCodexExp(sessionCodexFile())).toBe(5_000);
  });

  it("syncAgentTokenBack writes a newer session Codex token back to the source", () => {
    writeCodexToken(root, 1_000);
    provisionAgentCredentials(root, sid, "codex");
    writeCodexToken(perSessionCredentialsDir(root, sid), 5_000); // session's CLI refreshed

    syncAgentTokenBack(root, sid, "codex");

    expect(readCodexExp(path.join(root, ".codex", "auth.json"))).toBe(5_000);
  });

  // docs/142 A3 — force-push a refreshed source token into pinned sessions on re-auth.

  it("repushAgentToken forces the source token in even when the session token has a LATER expiry", () => {
    // The session holds a later-expiry-but-DEAD token (the exact state a manual
    // re-login repairs) — the expiry-guarded sync-in would skip it, repush must not.
    writeClaudeToken(root, "FRESH", 1_000);
    provisionAgentCredentials(root, sid, "claude");
    writeClaudeToken(perSessionCredentialsDir(root, sid), "DEAD", 9_000);

    const wrote = repushAgentToken(root, sid, "claude");

    expect(wrote).toBe(true);
    const sessionFile = path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json");
    expect(readTail(sessionFile)).toBe("FRESH"); // forced despite the staler expiry
  });

  it("repushAgentToken does NOT seed a token into a session that never held one (no cross-agent leak)", () => {
    writeClaudeToken(root, "SRC", 5_000);
    // A Codex session: provisioned WITHOUT .claude.
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

  // docs/153 — repair the legacy-alias symlink leak that splits the agent's
  // and the orchestrator's view of `<sessionDir>/.claude/.credentials.json`.

  it("provisioning from a credentialsRoot whose .claude is a legacy-alias symlink materializes real files", () => {
    // Recreate the prod state: source-of-truth credentials live under
    // provider-accounts/..., and the legacy `<root>/.claude` is a SYMLINK to
    // that subtree. Migration stopped creating those aliases in docs/150
    // req 19, but an install that migrated before then still has them on disk
    // until its next boot retires them, so the repair stays load-bearing.
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.rmSync(path.join(root, ".claude"), { recursive: true, force: true });
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("acct", 9_000));
    fs.symlinkSync(path.join(account, ".claude"), path.join(root, ".claude"));

    provisionAgentCredentials(root, sid, "claude");

    // The session dir must hold a *real* directory + file, not a symlink that
    // would resolve to different physical files inside the agent container
    // (subpath-mounted on sessions/<id>/) vs. on the orchestrator (volume
    // root). See docs/153.
    const sessionClaude = path.join(perSessionCredentialsDir(root, sid), ".claude");
    expect(fs.lstatSync(sessionClaude).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(sessionClaude).isDirectory()).toBe(true);
    expect(readTail(path.join(sessionClaude, ".credentials.json"))).toBe("acct");
  });

  // docs/153 — the ORIGIN of the orphan, not just its repair. `cpSync`'s
  // `dereference` option governs the SOURCE; a symlink at the DESTINATION is
  // unhandled, and provisioning is the first writer into a fresh session dir.
  // Both unhandled shapes below produced a session that authenticates on
  // nothing, and both did it quietly (`prepareSessionAgentEnvironment` catches
  // and warns), which is why this went unnoticed while five sessions accrued.

  it("provisioning does NOT write through a resolvable symlink at the destination", () => {
    // The shape found on the host: `<sessionDir>/.claude` is a symlink into a
    // nested `provider-accounts/...` tree that RESOLVES. Pre-fix, cpSync
    // followed it and the flat path never became a real dir — the credential
    // landed nested, the CLI followed the same link so the session worked, and
    // it broke permanently the moment the link was replaced by a real dir.
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
    // The credential is FLAT, where the container's `~/.claude` resolves it.
    expect(readTail(path.join(sessionClaude, ".credentials.json"))).toBe("ACCT");
    // ...and nothing was written through the link into the nested tree.
    expect(fs.existsSync(path.join(nested, ".credentials.json"))).toBe(false);
  });

  it("provisioning survives a DANGLING symlink at the destination (was EEXIST)", () => {
    // The other half: when the link doesn't resolve on the orchestrator,
    // cpSync throws EEXIST. `prepareSessionAgentEnvironment` catches that and
    // only warns, so the session simply had no credentials at all.
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
    // `.claude.json` is a file rel, so it takes the same destination path with
    // none of the directory machinery — assert it explicitly rather than
    // inferring it from the `.claude` case.
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    const nested = path.join(sessionDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, ".claude.json"), '{"projects":{"leaked":{}}}');
    fs.symlinkSync(path.join(nested, ".claude.json"), path.join(sessionDir, ".claude.json"));

    provisionAgentCredentials(root, sid, "claude");

    const dest = path.join(sessionDir, ".claude.json");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    // Structural, not byte-exact: the invariant is "a fresh scaffold, none of
    // the link target's state" — the scaffold's *contents* are owned by the
    // pre-trust seeding (85bb9eae) and grow keys over time. Pinning the literal
    // bytes here made this test fail the moment pre-trust landed, even though
    // the leak it guards never reopened.
    const materialized = JSON.parse(fs.readFileSync(dest, "utf-8")) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(materialized.projects)).not.toContain("leaked");
    // ...and it IS the provisioned scaffold, not an empty or partial file.
    // `toMatchObject`, so adding a pre-trusted dir doesn't break this again.
    expect(materialized.projects).toMatchObject({ "/workspace": { hasTrustDialogAccepted: true } });
    // The link target is left alone — it may hold the only copy of state.
    expect(fs.readFileSync(path.join(nested, ".claude.json"), "utf-8"))
      .toBe('{"projects":{"leaked":{}}}');
  });

  it("provisioning leaves the orphan tree for the per-turn repair to recover", () => {
    // The two halves compose: provisioning stops the orphan being created (it
    // unlinks rather than writes through), and the per-turn repair — which
    // runs one step later in `prepareSessionAgentEnvironment` — discovers the
    // tree the link pointed at and merges its conversation back. Unlinking
    // must therefore never take the target with it.
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
    // The conversation is still on disk after provisioning — not collateral of
    // the unlink.
    expect(fs.existsSync(
      path.join(nested, "projects", "-workspace", `${agentSessionId}.jsonl`),
    )).toBe(true);

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    // ...and the very next step folds it into the real `.claude/`.
    expect(fs.existsSync(
      path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`),
    )).toBe(true);
    expect(recovered).toEqual([agentSessionId]);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("repushAgentToken repairs a leaked symlink in the session dir", () => {
    // Simulate the broken on-disk state from prod: a session pinned BEFORE the
    // copyCredentialPath dereference fix has `<sessionDir>/.claude` as a
    // symlink pointing into the account subtree (absolute path).
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    // Pretend the agent followed the symlink at container boot (subpath
    // namespace) and wrote a stale local copy alongside.
    const stale = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, ".credentials.json"), claudeCreds("STALE", 1_000));

    const wrote = repushProviderAccountToken(root, sid, "claude", "claude-default");

    expect(wrote).toBe(true);
    // `<sessionDir>/.claude` is now a real directory with the fresh token.
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("FRESH");
  });

  // docs/179 §4 — the guarantee the resident-process fix leans on: suppressing
  // the destructive repair must NOT also suppress the token copy. The earlier
  // "still refreshes the token" coverage used a real `.claude` directory plus a
  // separate orphan, where the naive destination is already correct. On the
  // ACTUAL leaked shape, `<sessionDir>/.claude` resolves back to the shared
  // source on the orchestrator, so the freshness guard saw source and
  // destination as one file and skipped the copy — leaving the resident CLI on
  // a dead token with nothing in the logs to say so.
  it("delivers a rotated token to the path the container reads, with the leak repair suppressed", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("ROTATED", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    // The leak: an absolute symlink that resolves to the shared source here,
    // but to the session's own orphan inside the subpath-mounted container.
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const containerVisible = path.join(sessionDir, "provider-accounts", "claude", "claude-default", ".claude");
    fs.mkdirSync(containerVisible, { recursive: true });
    fs.writeFileSync(path.join(containerVisible, ".credentials.json"), claudeCreds("STALE", 1_000));

    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default", undefined, undefined,
      { repairLeakedSubtrees: false },
    );

    // Topology untouched — a resident CLI never saw its credentials vanish.
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(true);
    // ...and the rotated token still reached the file that CLI actually reads.
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
    // A LATER expiry than the source: the re-push path is deliberately
    // unguarded, so this must still be overwritten (docs/142 A3).
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

  // docs/153 — non-destructive repair: orphan conversation history under
  // <sessionDir>/provider-accounts/.../.claude/projects/ must be merged
  // into the rebuilt <sessionDir>/.claude/ before the orphan is dropped,
  // and the agent_session_id from the latest jsonl must be reported back
  // so the orchestrator can update sessions.agent_session_id and avoid the
  // "no conversation found" → fresh-init-UUID loop.

  function seedLeakedSessionWithOrphanHistory(opts: {
    accessTail: string;
    expiresAt: number;
    projectDir: string;          // encoded-cwd, e.g. "-workspace"
    agentSessionId: string;       // UUID the CLI was using
    jsonlContents: string;        // contents to write; first line must JSON-parse with sessionId
    mtimeMs?: number;             // explicit mtime for ranking against other jsonls
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

  // docs/153 Fix — jsonl must contain BOTH a `type: "user"` AND a
  // `type: "assistant"` event in the first ~50 lines to count as
  // resumable. Stub jsonls (last-prompt/ai-title/pr-link only) get
  // filtered out by the validator, so positive recovery tests must
  // include both event types in their fixture.
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

    // .claude/ is real with fresh creds.
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("FRESH");
    // The orphan jsonl is now under <sessionDir>/.claude/projects/ where
    // claude --resume <id> will find it.
    const mergedJsonl = path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`);
    expect(fs.existsSync(mergedJsonl)).toBe(true);
    const lines = fs.readFileSync(mergedJsonl, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    // Orphan provider-accounts/ subtree dropped.
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    // Recovery callback got the agent_session_id from the jsonl's first line.
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
    const past = Date.now() / 1000 - 3600; // 1h ago
    const now = Date.now() / 1000;
    fs.utimesSync(oldJsonl, past, past);
    fs.utimesSync(newJsonl, now, now);

    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(root, sid, "claude", "claude-default", (id) => { recovered.push(id); });

    expect(recovered).toEqual([newSid]);
  });

  it("non-destructive repair: no orphan present → callback fires with null (clear signal)", () => {
    // A leak with no agent-side activity yet: symlink exists, but the agent
    // never followed it (no orphan tree). Repair fires but finds no resumable
    // jsonl → callback receives null so the caller drops the DB pointer and
    // skips --resume on the next spawn.
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
    // Sanity check the merge semantics: if both shared and orphan happen
    // to carry the same file under projects/, the shared (fresh) version
    // is preserved — the agent_session_id rederivation will still see the
    // orphan-only files as well.
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
    expect(merged).toBe("SHARED-CONTENT\n"); // shared wins; orphan was skipped
  });

  it("non-destructive repair: preserves orphan .claude.json over the shared baseline", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    fs.writeFileSync(path.join(account, ".claude.json"), '{"projects":{}}');
    // seedCredentialsRoot pre-wrote a real .claude.json at <root>; replace
    // it with the docs/150-style legacy-alias symlink for this test.
    fs.rmSync(path.join(root, ".claude.json"), { force: true });
    fs.symlinkSync(path.join(account, ".claude.json"), path.join(root, ".claude.json"));
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    fs.symlinkSync(path.join(account, ".claude.json"), path.join(sessionDir, ".claude.json"));
    // The agent wrote a richer .claude.json into its session-local view via
    // the second symlink (which resolved to the orphan subtree).
    const orphanRoot = path.join(sessionDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(orphanRoot, { recursive: true });
    fs.writeFileSync(path.join(orphanRoot, ".claude.json"), '{"projects":{"foo":"bar"}}');

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default");

    expect(fs.lstatSync(path.join(sessionDir, ".claude.json")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(sessionDir, ".claude.json"), "utf-8")).toBe('{"projects":{"foo":"bar"}}');
  });

  // docs/153 — Case 3 in materializeLeakedSubtreeSymlinks: the previous
  // (destructive) repair already replaced the leaked symlink with a real
  // dir, but the orphan `<sessionDir>/provider-accounts/.../.claude/projects/`
  // subtree is still on disk. These are the sessions that ran the repair
  // BEFORE PR #758 landed — credentials are visible, conversation history
  // is not. The repair has to fire on this entry condition too.

  it("non-destructive repair (case 3): merges orphan history when .claude/ is already a real dir", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    // Pre-stage `.claude/` as a real dir with the shared baseline content
    // (what the pre-#758 destructive repair would have left).
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    // Orphan jsonl from when the CLI wrote through the (now-removed) symlink.
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

    // `.claude/` still a real dir; orphan jsonl now visible there.
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    const mergedJsonl = path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`);
    expect(fs.existsSync(mergedJsonl)).toBe(true);
    // Orphan provider-accounts/ subtree dropped.
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    // Recovery callback got the agent_session_id from the jsonl's first line.
    expect(recovered).toEqual([agentSessionId]);
    // Shared baseline credentials preserved (orphan didn't carry these).
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
    // No provider-accounts/ subtree was created.
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("non-destructive repair (case 3): does not re-copy shared content over user CLI writes in .claude/", () => {
    // If the user's CLI has written something into `.claude/` since the
    // destructive repair ran (e.g. CLI config tweaks), the case-3 path must
    // not clobber it. The orphan only carries this session's conversation
    // history — projects/, sessions/, history.jsonl — and `.claude.json`.
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    fs.writeFileSync(path.join(account, ".claude", "settings.json"), "SHARED-SETTINGS");
    const sessionDir = perSessionCredentialsDir(root, sid);
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    // The user's CLI has rewritten settings.json post-destructive-repair.
    fs.writeFileSync(path.join(sessionDir, ".claude", "settings.json"), "USER-CUSTOMIZED");
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    // Orphan with conversation history.
    const orphanProjects = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default",
      ".claude", "projects", "-workspace",
    );
    fs.mkdirSync(orphanProjects, { recursive: true });
    fs.writeFileSync(path.join(orphanProjects, "conv.jsonl"), '{"sessionId":"x","type":"summary"}\n');

    syncProviderAccountTokenIn(root, sid, "claude", "claude-default");

    // User's customised settings.json preserved — case 3 does NOT cpSync from shared.
    expect(fs.readFileSync(path.join(sessionDir, ".claude", "settings.json"), "utf-8")).toBe("USER-CUSTOMIZED");
    // Conversation history merged in.
    expect(fs.existsSync(path.join(sessionDir, ".claude", "projects", "-workspace", "conv.jsonl"))).toBe(true);
    // Orphan dropped.
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  // docs/153 — Case 3 orphan DISCOVERY. The orphan dir is named after the
  // account root the leaked symlink pointed at *when it was created*, which is
  // not necessarily the account the session resolves to today: a symlink
  // authored while the migrated `claude-default` root was live leaves its
  // orphan under that name long after the live root became `acct_<uuid>`.
  // Probing only the computed base read that as a healthy no-op, so five
  // production sessions sat with no credential, a stranded orphan holding the
  // only copy of it, and no log line at all.

  const ACCT_UUID = "acct_11111111-2222-3333-4444-555555555555";

  /**
   * The stranded shape, exactly as found on the host: `.claude/` is a real dir
   * with conversation history but NO credential, the only credential sits in
   * an orphan under the LEGACY account dir name, and the account the session
   * is pinned to has no credential root on the orchestrator any more.
   */
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

    // The credential the session authenticates with is back where the CLI
    // reads it — the whole point of the fix.
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("ORPHAN");
    // Conversation history merged, agent_session_id recovered, orphan dropped.
    expect(fs.existsSync(
      path.join(sessionDir, ".claude", "projects", "-workspace", `${agentSessionId}.jsonl`),
    )).toBe(true);
    expect(recovered).toEqual([agentSessionId]);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("orphan discovery: a live account credential still wins over the orphan's copy", () => {
    // Shared-wins-on-conflict is unchanged: the orphan token is a rescue for a
    // destination that has none, never an overwrite of a fresher baseline.
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
    // A second stale account dir, sorting BEFORE "claude-default".
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

    // Both orphans' history is preserved, and the whole tree is dropped.
    const merged = path.join(sessionDir, ".claude", "projects", "-workspace");
    expect(fs.existsSync(path.join(merged, "older.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(merged, "newer.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    // Lexicographic order decides, not readdir order: "acct_00000000-old"
    // sorts first, so its jsonl and its token are the ones that land.
    expect(recovered).toEqual(["older-id"]);
    expect(readTail(path.join(sessionDir, ".claude", ".credentials.json"))).toBe("OLDER");
  });

  it("orphan discovery: a failed merge keeps the discovered orphan on disk", () => {
    const { sessionDir, orphan } = seedLegacyNamedOrphan();
    fs.writeFileSync(path.join(orphan, "projects", "-workspace", "conv.jsonl"), resumableJsonl("conv-id"));
    // A plain FILE named `projects` in the destination makes the merge throw.
    fs.rmSync(path.join(sessionDir, ".claude", "projects"), { recursive: true, force: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", "projects"), "not a directory");

    syncProviderAccountTokenIn(root, sid, "claude", ACCT_UUID);

    // The orphan is the only copy of the conversation — it must survive.
    expect(fs.existsSync(path.join(orphan, "projects", "-workspace", "conv.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(true);
  });

  it("orphan discovery: warns when a subtree has no token and no orphan to recover one from", () => {
    // The silent-no-op that hid the incident. `.claude/` is a real dir with no
    // credential and nothing to repair from: nothing this module can do, but
    // the next occurrence has to be greppable instead of needing container
    // forensics.
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

  // docs/153 — Case 4 in materializeLeakedSubtreeSymlinks: `.claude/` is a
  // real dir (Cases 1/3 don't apply), no orphan tree, but the DB's
  // agent_session_id has no matching jsonl on disk while a DIFFERENT jsonl
  // does exist. Production observed this on sessions where some out-of-band
  // cleanup removed the orphan without firing the original recovery
  // callback, leaving the DB pointer permanently stuck on a doomed UUID.

  it("non-destructive repair (case 4): recovers when DB agent_session_id has no matching jsonl on disk", () => {
    const account = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    const sessionDir = perSessionCredentialsDir(root, sid);
    // Healthy on-disk shape: real .claude/ dir, no symlink, no orphan.
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude", ".credentials.json"), claudeCreds("FRESH", 9_000));
    // Seed several jsonls; the newest one (by mtime) holds the recovered id.
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

    // DB points at a UUID that has no jsonl on disk.
    const staleSid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const recovered: (string | null)[] = [];
    syncProviderAccountTokenIn(
      root, sid, "claude", "claude-default",
      (id) => { recovered.push(id); },
      staleSid,
    );

    expect(recovered).toEqual([goodSid]);
    // Read-only — no filesystem mutations expected.
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

    // DB id already matches the goodSid jsonl on disk → no recovery needed.
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
    // The session's DB id points at a UUID with no jsonl AT ALL — this is
    // the prod state after the loop scrambled the DB with a doomed init
    // UUID that never produced a conversation. Case 4 fires (stale-pointer
    // confirmed), no recovery is possible (no jsonls to scan), so the
    // callback fires with null so the caller clears the DB and the next
    // turn drops --resume → fresh conversation.
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

    // Repair still happened (symlink replaced with real dir).
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    // Validator finds no resumable jsonl → clear signal so the caller
    // drops the DB pointer and the next spawn skips --resume.
    expect(recovered).toEqual([null]);
  });

  // docs/153 — resumability validator: findLatestAgentSessionId must
  // skip jsonls that are missing real user/assistant events. Otherwise
  // the post-turn stub jsonls (last-prompt/ai-title/pr-link) get picked
  // by latest-mtime and the recovered id `--resume`-fails immediately.

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
    // Stub is NEWER on mtime; validator must still pick the real one.
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

    // Claude resolves --resume within the current cwd's encoded project
    // bucket. A valid JSONL elsewhere is still unresumable from /workspace.
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
    // Two stub jsonls — neither carries user+assistant events. The CLI
    // would emit "No conversation found" if we picked either. Validator
    // returns null → callback fires with null so the caller clears.
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
    // The exact prod failure mode: DB pointer matches a file by name
    // (stub jsonl from the post-turn flow), but `--resume` fails because
    // the content isn't resumable. Case 4 must detect this and find the
    // sibling real-conversation jsonl.
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

  // ---- Codex rollout preservation ----
  //
  // Regression for the prod incident where env prep logged
  //   "repaired leaked symlink …: .codex (orphan merged from …)"
  // and ~500ms later `thread/resume` failed with
  //   -32600 "no rollout found for thread id <id>".
  // The repair iterated every agent's credential subtree but `mergeOrphanState`
  // only implemented `.claude` / `.claude.json`, so a `.codex` orphan was
  // "merged" by doing nothing and then recursively deleted — destroying the
  // only copy of Codex's disk-backed rollout while `sessions.agent_session_id`
  // still pointed at that thread.
  /**
   * planning#435 / docs/274 req 13 — a Grok subscription token is short-lived
   * (~6h) and rotates, so "connect once" only holds if the rotation LANDS.
   *
   * These exercise the generic sync machinery through the grok entries added to
   * `AGENT_TOKEN_FILES` and the freshness table: without both, a session that
   * outlives one token would 401 mid-work and its refreshed token would be
   * stranded in the session's own copy where the next container never sees it.
   */
  describe("docs/274 req 13 — a rotating Grok subscription token", () => {
    const account = "acct_grok";
    // The REAL file shape (live `grok login --device-auth`, planning#435):
    // unguessable scope key, access token under `key`, ISO-8601 `expires_at`
    // string. The first fixture used `grok-build` / `access_token` / a number,
    // which the reader also accepts as a fallback — so those tests could not
    // catch a regression that only broke the live file (planning#449).
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

    /**
     * The guard that makes the sync SAFE, and it is the half that a naive
     * "always copy the source in" would get wrong: a session that just
     * refreshed its own token must not have it clobbered by a staler source,
     * because the refresh may already have invalidated the source's copy
     * upstream.
     */
    it("never overwrites a session token that is already fresher", () => {
      seedAccount(1_000_000_000_000, "STALE");
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "auth.json"), grokAuth("ROTATED", 9_000_000_000_000));

      syncProviderAccountTokenIn(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(sessionDir, ".grok", "auth.json"), "utf-8")).toContain("tok-ROTATED");
    });

    /**
     * The publish half — a rotation reaching the source, so the NEXT container
     * starts from the live token rather than a dead refresh token.
     *
     * The account MARKER is what says whose bearer the subtree currently holds,
     * and the write-back refuses without it: publishing a token to an account
     * that is not the one on disk is how one subscription's credential lands in
     * another's source.
     */
    it("publishes a rotation back to the account source", () => {
      const accountRoot = seedAccount(1_000_000_000_000, "OLD");
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "auth.json"), grokAuth("ROTATED", 9_000_000_000_000));
      writeSessionAccountMarker(root, sid, "grok", account);

      syncProviderAccountTokenBack(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(accountRoot, ".grok", "auth.json"), "utf-8")).toContain("tok-ROTATED");
    });

    /** …and refuses when the subtree holds a DIFFERENT account's credentials. */
    it("refuses to publish into an account the subtree does not hold", () => {
      const accountRoot = seedAccount(1_000_000_000_000, "OLD");
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".grok", "auth.json"), grokAuth("OTHER", 9_000_000_000_000));
      writeSessionAccountMarker(root, sid, "grok", "acct_someone_else");

      syncProviderAccountTokenBack(root, sid, "grok", account);

      expect(fs.readFileSync(path.join(accountRoot, ".grok", "auth.json"), "utf-8")).toContain("tok-OLD");
    });

    /**
     * The token file is the ONLY thing synced. `.grok/` also holds config.toml
     * and the sessions store the CLI writes in place, and a sync that touched
     * them would destroy this session's resume history every turn.
     */
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

    /**
     * A KEY-billed grok session has no auth.json anywhere and is perfectly
     * healthy — its credential travels as an environment variable. The
     * credential-less warning must stay quiet for it, or every key-billed turn
     * logs that it "will fail authentication" while working fine.
     */
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

    /** …and stays loud for an ACCOUNT-scoped session, which is genuinely broken. */
    it("still warns when an account-scoped session has no token", () => {
      seedAccount(9_000_000_000_000);
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(path.join(sessionDir, ".grok"), { recursive: true });
      // Remove the source too, so the sync has nothing to copy in and the
      // session is left authenticating on nothing.
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

    /**
     * Seed the exact prod shape: a live leaked `.codex` symlink pointing at
     * the provider-account subtree, plus the orphan tree the Codex CLI wrote
     * through that symlink inside the container's namespace (carrying a
     * durable rollout).
     */
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
      // The orphan also carries a STALE auth.json — the shared baseline must win.
      fs.writeFileSync(path.join(orphan, "auth.json"), codexAuth("STALE", 1_000));
      return { sessionDir, orphan, account };
    }

    it("survives a live leaked-symlink repair and drops the orphan only after preserving it", () => {
      const { sessionDir } = seedLeakedCodexWithRollout();

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      // The symlink is gone and `.codex/` is a real dir.
      expect(fs.lstatSync(path.join(sessionDir, ".codex")).isSymbolicLink()).toBe(false);
      // THE REGRESSION: the durable rollout is still there, at the path the
      // Codex app-server reads for `thread/resume`.
      const merged = path.join(sessionDir, ".codex", rolloutRel);
      expect(fs.existsSync(merged)).toBe(true);
      expect(fs.readFileSync(merged, "utf-8")).toContain(threadId);
      expect(fs.existsSync(path.join(sessionDir, ".codex", "history.jsonl"))).toBe(true);
      // Preservation succeeded, so the orphan root is cleaned up.
      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    });

    it("does not let the orphan's stale auth/config clobber the shared baseline", () => {
      const { sessionDir } = seedLeakedCodexWithRollout();

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      // Shared auth wins on collision (`force: false`), and `auth.json` isn't
      // in the state allowlist at all.
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
      // The rollout was restored before the staleness probe ran, so the DB
      // pointer must be left alone.
      expect(recovered).toEqual([]);
    });

    it("keeps the orphan when preservation fails — never delete the only copy", () => {
      const { sessionDir, orphan } = seedLeakedCodexWithRollout();
      // Replace the leak with a real `.codex/` dir that has a plain FILE
      // named `sessions`, so the orphan's `sessions/` dir cannot be copied
      // onto it and the merge throws.
      fs.rmSync(path.join(sessionDir, ".codex"), { force: true, recursive: true });
      fs.mkdirSync(path.join(sessionDir, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      fs.writeFileSync(path.join(sessionDir, ".codex", "sessions"), "not a directory");

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      // Merge failed → the orphan (the only copy of the rollout) survives.
      expect(fs.existsSync(path.join(orphan, rolloutRel))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(true);
    });

    it("an unknown credential subtree is never deleted (fail-safe default)", () => {
      // The class-level guarantee: the bug was a subtree the merge didn't
      // understand being deleted anyway. `mergeOrphanState` now refuses.
      const account = path.join(root, "provider-accounts", "codex", "codex-default");
      fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(account, ".codex", "auth.json"), codexAuth("FRESH", 9_000_000_000));
      const sessionDir = perSessionCredentialsDir(root, sid);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.symlinkSync(path.join(account, ".codex"), path.join(sessionDir, ".codex"));
      const orphan = path.join(sessionDir, "provider-accounts", "codex", "codex-default", ".codex");
      fs.mkdirSync(orphan, { recursive: true });
      // No recognized state subpaths at all — nothing to preserve, safe to drop.
      fs.writeFileSync(path.join(orphan, "auth.json"), codexAuth("STALE", 1_000));

      syncProviderAccountTokenIn(root, sid, "codex", "codex-default");

      expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    });

    // ---- Stale-thread detection (the recovery half) ----

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

      // null == "clear the pointer"; the caller then arms a history replay.
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
      // Cross-agent guard: the Codex staleness signal must never be applied
      // to a Claude pointer (and vice versa).
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
    // Source-of-truth root is untouched.
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(true);
    expect(() => removeSessionCredentials(root, sid)).not.toThrow();
  });

  // docs/144 — sub-agent credential provisioning is scoped to the sub-agent's
  // subtree and never touches the pinned agent's.
  describe("sub-agent credentials (docs/144)", () => {
    it("provisions only the sub-agent subtree next to the pinned agent's", () => {
      // Pin the session to Claude first (write-once on first turn).
      provisionAgentCredentials(root, sid, "claude");
      const dir = perSessionCredentialsDir(root, sid);
      expect(fs.existsSync(path.join(dir, ".claude"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);

      // Cross-provider spawn provisions Codex alongside, without disturbing Claude.
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
      // The pinned Claude subtree is untouched.
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

      // The reviewer may use another service/model route, but cleanup is keyed
      // to the harness. The parent's rollout is state; auth/config are not.
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

        // runSubAgent and non-turn work call the same helper from `finally`, so
        // both failure and cancellation have this cleanup contract.
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
