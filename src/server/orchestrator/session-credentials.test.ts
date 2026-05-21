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
  removeSessionCredentials,
  syncAgentTokenIn,
  syncAgentTokenBack,
  repushAgentToken,
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

  it("removeSessionCredentials drops the subtree and is idempotent", () => {
    provisionAgentCredentials(root, sid, "claude");
    expect(fs.existsSync(perSessionCredentialsDir(root, sid))).toBe(true);
    removeSessionCredentials(root, sid);
    expect(fs.existsSync(perSessionCredentialsDir(root, sid))).toBe(false);
    // Source-of-truth root is untouched.
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(true);
    expect(() => removeSessionCredentials(root, sid)).not.toThrow();
  });
});
