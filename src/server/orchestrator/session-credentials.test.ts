import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  perSessionCredentialsDir,
  perSessionCredentialsSubpath,
  sessionCredentialsRoot,
  ensureSessionCredentialsScaffold,
  provisionAgentCredentials,
  provisionProviderAccountCredentials,
  provisionSubAgentCredentials,
  removeSubAgentCredentials,
  removeSessionCredentials,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
  repushAgentToken,
  repushProviderAccountToken,
  repoMemoryDir,
  provisionRepoMemory,
  syncMemoryBack,
  REPO_MEMORY_SUBDIR,
  chownSessionCredentialsTree,
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

  it("provisioning Codex copies .codex but NOT .claude / .claude.json", () => {
    provisionAgentCredentials(root, sid, "codex");
    const dir = perSessionCredentialsDir(root, sid);
    expect(fs.readFileSync(path.join(dir, ".codex", "auth.json"), "utf-8")).toContain("codex-tok");
    expect(fs.existsSync(path.join(dir, ".gitconfig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(false);
  });

  it("provisioning tolerates a missing agent subtree (agent never logged in)", () => {
    fs.rmSync(path.join(root, ".codex"), { recursive: true, force: true });
    expect(() => provisionAgentCredentials(root, sid, "codex")).not.toThrow();
    const dir = perSessionCredentialsDir(root, sid);
    expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);
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

    syncProviderAccountTokenIn(root, sid, "claude", "acct-b");
    expect(readTail(path.join(perSessionCredentialsDir(root, sid), ".claude", ".credentials.json"))).toBe("B-NEW");

    writeClaudeToken(perSessionCredentialsDir(root, sid), "B-ROTATED", 12_000);
    syncProviderAccountTokenBack(root, sid, "claude", "acct-b");

    expect(readTail(path.join(accountB, ".claude", ".credentials.json"))).toBe("B-ROTATED");
    expect(readTail(path.join(accountA, ".claude", ".credentials.json"))).toBe("A-OLD");
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
    // that subtree (docs/150 `ensureLegacyAlias`).
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

    it("removes ONLY the sub-agent subtree, leaving the pinned agent's intact", () => {
      provisionAgentCredentials(root, sid, "claude");
      provisionSubAgentCredentials(root, sid, "codex");
      const dir = perSessionCredentialsDir(root, sid);
      expect(fs.existsSync(path.join(dir, ".codex"))).toBe(true);

      removeSubAgentCredentials(root, sid, "codex");
      expect(fs.existsSync(path.join(dir, ".codex"))).toBe(false);
      // The pinned Claude subtree is untouched.
      expect(fs.existsSync(path.join(dir, ".claude", ".credentials.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(true);
    });

    it("removeSubAgentCredentials is best-effort on a missing subtree", () => {
      provisionAgentCredentials(root, sid, "claude");
      expect(() => removeSubAgentCredentials(root, sid, "codex")).not.toThrow();
    });
  });
});

// docs/155 — per-repo Claude memory sharing. The shared dir lives at
// `<credentialsRoot>/repo-memory/<repoHash>`; provision copies it INTO a
// session's `.claude/projects/-workspace/memory`, sync-back copies modified
// files OUT (last-write-wins per file by mtime).
describe("per-repo Claude memory sharing (docs/155)", () => {
  let root: string;
  const sid = "memsession01";
  const repoHash = "abc123def456abcd";

  const sharedDir = () => repoMemoryDir(root, repoHash);
  const sessionMemoryDir = () =>
    path.join(perSessionCredentialsDir(root, sid), ".claude", "projects", "-workspace", "memory");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-mem-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("repoMemoryDir resolves under the repo-memory subdir keyed by hash", () => {
    expect(repoMemoryDir(root, repoHash)).toBe(path.join(root, REPO_MEMORY_SUBDIR, repoHash));
  });

  it("provisionRepoMemory copies shared files into the session memory subtree", () => {
    fs.mkdirSync(sharedDir(), { recursive: true });
    fs.writeFileSync(path.join(sharedDir(), "MEMORY.md"), "- index");
    fs.writeFileSync(path.join(sharedDir(), "user-likes-tabs.md"), "tabs");

    provisionRepoMemory(root, sid, repoHash);

    expect(fs.readFileSync(path.join(sessionMemoryDir(), "MEMORY.md"), "utf8")).toBe("- index");
    expect(fs.readFileSync(path.join(sessionMemoryDir(), "user-likes-tabs.md"), "utf8")).toBe("tabs");
  });

  it("provisionRepoMemory creates an empty shared dir when none exists yet", () => {
    provisionRepoMemory(root, sid, repoHash);
    expect(fs.existsSync(sharedDir())).toBe(true);
    expect(fs.existsSync(sessionMemoryDir())).toBe(true);
  });

  it("syncMemoryBack mirrors session-written files back to the shared dir", () => {
    fs.mkdirSync(sessionMemoryDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionMemoryDir(), "new-note.md"), "insight");

    syncMemoryBack(root, sid, repoHash);

    expect(fs.readFileSync(path.join(sharedDir(), "new-note.md"), "utf8")).toBe("insight");
  });

  it("syncMemoryBack is a no-op when the session never wrote a memory dir", () => {
    fs.mkdirSync(perSessionCredentialsDir(root, sid), { recursive: true });
    expect(() => syncMemoryBack(root, sid, repoHash)).not.toThrow();
    expect(fs.existsSync(sharedDir())).toBe(false);
  });

  it("round-trips: provision-in does not push unchanged files back out", () => {
    fs.mkdirSync(sharedDir(), { recursive: true });
    const sharedFile = path.join(sharedDir(), "kept.md");
    fs.writeFileSync(sharedFile, "original");
    // Back-date the shared file so any naive copy-back (which would set a
    // newer mtime) is detectable.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(sharedFile, old, old);
    const originalMtime = fs.statSync(sharedFile).mtimeMs;

    provisionRepoMemory(root, sid, repoHash);
    // Session didn't touch the file — sync-back must not rewrite it.
    syncMemoryBack(root, sid, repoHash);

    expect(fs.readFileSync(sharedFile, "utf8")).toBe("original");
    expect(fs.statSync(sharedFile).mtimeMs).toBe(originalMtime);
  });

  it("last-write-wins: a newer session edit overwrites the shared file", () => {
    fs.mkdirSync(sharedDir(), { recursive: true });
    const sharedFile = path.join(sharedDir(), "evolving.md");
    fs.writeFileSync(sharedFile, "v1");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(sharedFile, old, old);

    provisionRepoMemory(root, sid, repoHash);
    // The session's CLI rewrites the memory (newer mtime than the shared copy).
    const sessionFile = path.join(sessionMemoryDir(), "evolving.md");
    fs.writeFileSync(sessionFile, "v2");

    syncMemoryBack(root, sid, repoHash);

    expect(fs.readFileSync(sharedFile, "utf8")).toBe("v2");
  });

  it("nested subdirectories are mirrored both ways", () => {
    fs.mkdirSync(path.join(sharedDir(), "sub"), { recursive: true });
    fs.writeFileSync(path.join(sharedDir(), "sub", "deep.md"), "deep");

    provisionRepoMemory(root, sid, repoHash);
    expect(fs.readFileSync(path.join(sessionMemoryDir(), "sub", "deep.md"), "utf8")).toBe("deep");

    fs.writeFileSync(path.join(sessionMemoryDir(), "sub", "added.md"), "added");
    syncMemoryBack(root, sid, repoHash);
    expect(fs.readFileSync(path.join(sharedDir(), "sub", "added.md"), "utf8")).toBe("added");
  });
});
