import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { signOutProvider } from "./settings.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

/**
 * SHI-283 — provider-wide sign-out has to take the account away from the
 * sessions running on it, not just delete the rows.
 *
 * The row is not where the token lives: every pinned session holds its own copy
 * in `<credentialsDir>/sessions/<id>/`, and that copy is what the CLI in the
 * container reads. Nothing else deletes it — first-turn provisioning is guarded
 * on `agentPinned`, and only a switch to another account overwrites it. So these
 * tests are mostly about *which* sessions lose their copy, and what survives the
 * removal.
 */
describe("signOutProvider", () => {
  let root: string;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let runningSessionIds: Set<string>;
  /** Sessions holding a resident (idle but alive) agent process, id → kill spy. */
  let residentAgents: Map<string, { killed: boolean; cleared: boolean }>;
  /** Providers whose singleton credentials the stub auth manager cleared. */
  let signedOutProviders: string[];

  const registry = () => ({
    get: (id: string) => {
      const resident = residentAgents.get(id);
      if (!resident && !runningSessionIds.has(id)) return undefined;
      return {
        running: runningSessionIds.has(id),
        getAgent: () => (resident ? { kill: () => { resident.killed = true; } } : null),
        setAgent: (agent: unknown) => { if (resident && agent === null) resident.cleared = true; },
      };
    },
  }) as unknown as SessionRunnerRegistry;

  /** The per-session copy of the token — what the CLI actually reads. */
  const sessionTokenPath = (sessionId: string): string =>
    path.join(root, "sessions", sessionId, ".claude", ".credentials.json");

  function seedSessionCredentials(sessionId: string, token: string): void {
    fs.mkdirSync(path.dirname(sessionTokenPath(sessionId)), { recursive: true });
    fs.writeFileSync(sessionTokenPath(sessionId), token);
  }

  function seedAccount(accountId: string, token: string): string {
    const accountRoot = providerAccountCredentialRoot(root, "claude", accountId);
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), token);
    return accountRoot;
  }

  /** A connected account with credentials on disk. */
  function connectAccount(label: string): string {
    const account = accounts.create("claude", label);
    accounts.setAccountStatus("claude", account.id, "ready");
    seedAccount(account.id, `token-${label}`);
    return account.id;
  }

  function pinSession(id: string, accountId: string, agentId: "claude" | "codex" = "claude"): void {
    sessions.track(id, id);
    sessions.setAgentId(id, agentId);
    sessions.setProviderRoute(id, "account", accountId);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-provider-signout-"));
    accounts = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: new CredentialStore(root),
    });
    signedOutProviders = [];
    const stubAuthManager = (provider: "claude" | "codex"): AgentAuthManager => ({
      signOut: () => { signedOutProviders.push(provider); },
      // `delete()` ends the device flow of the row it removes; nothing is
      // in flight in these tests, so the scope is always empty.
      getActiveAccountId: () => null,
      cancel: () => {},
    } as unknown as AgentAuthManager);
    accounts.attachAuthManagers(new Map<"claude" | "codex", AgentAuthManager>([
      ["claude", stubAuthManager("claude")],
      ["codex", stubAuthManager("codex")],
    ]));
    sessions = new SessionManager(createTestDatabaseManager());
    runningSessionIds = new Set();
    residentAgents = new Map();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("signs out with nothing pinned, dropping the rows and the source credentials", () => {
    const a = connectAccount("A");
    const accountRoot = providerAccountCredentialRoot(root, "claude", a);

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(accounts.list("claude")).toEqual([]);
    expect(fs.existsSync(accountRoot)).toBe(false);
    expect(signedOutProviders).toEqual(["claude"]);
  });

  /**
   * The defect this file exists for: sign-out erased the *source* subtree and
   * the row, and left every pinned session holding a working subscription token
   * it could go on spending indefinitely.
   */
  it("revokes each pinned session's own copy of the token, not just the source", () => {
    const a = connectAccount("A");
    const b = connectAccount("B");
    pinSession("s1", a);
    pinSession("s2", b);
    seedSessionCredentials("s1", "token-A");
    seedSessionCredentials("s2", "token-B");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
    expect(fs.existsSync(sessionTokenPath("s2"))).toBe(false);
  });

  /**
   * A resident CLI holds the token in memory, where deleting files cannot reach
   * it — same reason the per-account disconnect retires the process first.
   */
  it("retires the resident agent process before it takes the credentials away", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
    // Idle but alive, so the running-turn refusal does not apply.
    residentAgents.set("s1", { killed: false, cleared: false });

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(residentAgents.get("s1")).toEqual({ killed: true, cleared: true });
    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
  });

  it("keeps the conversation state, so reconnecting resumes rather than restarts", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
    const resume = path.join(root, "sessions", "s1", ".claude", "projects", "-workspace", "abc.jsonl");
    fs.mkdirSync(path.dirname(resume), { recursive: true });
    fs.writeFileSync(resume, "{}");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
    expect(fs.existsSync(resume)).toBe(true);
  });

  /**
   * The dangling pin is what makes the session recoverable: it reads unusable,
   * so the next turn's preflight fails it over — and re-provisions credentials —
   * once an account is connected again. Clearing it would look tidier and would
   * strand the session, since env prep only provisions for a session that is not
   * yet pinned.
   */
  it("leaves the pin pointing at the gone account so the session can re-route", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(sessions.get("s1")?.providerRouteId).toBe(a);
    expect(accounts.isRouteUsableForTurn("claude", { kind: "account", id: a })).toBe(false);
  });

  /**
   * A reserved route has no account row, and its credentials came from env
   * OAuth rather than from anything this deletes — revoking there would break a
   * path that does not depend on the signed-out accounts at all.
   */
  it("leaves a session on a reserved route alone", () => {
    connectAccount("A");
    sessions.track("s1", "s1");
    sessions.setAgentId("s1", "claude");
    sessions.setProviderRoute("s1", "reserved", "claude-env-oauth");
    seedSessionCredentials("s1", "env-token");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.readFileSync(sessionTokenPath("s1"), "utf-8")).toBe("env-token");
  });

  /** Signing out of one provider must not touch the other's sessions. */
  it("leaves the other provider's pinned sessions alone", () => {
    const claudeAccount = connectAccount("A");
    const codexAccount = accounts.create("codex", "Codex A");
    accounts.setAccountStatus("codex", codexAccount.id, "ready");
    pinSession("s1", claudeAccount);
    pinSession("s2", codexAccount.id, "codex");
    seedSessionCredentials("s1", "token-A");
    const codexAuth = path.join(root, "sessions", "s2", ".codex", "auth.json");
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.writeFileSync(codexAuth, "codex-token");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
    expect(fs.readFileSync(codexAuth, "utf-8")).toBe("codex-token");
    expect(accounts.list("codex").map((account) => account.id)).toEqual([codexAccount.id]);
  });

  /**
   * An archived session cannot be running, but its credential subtree survives
   * archival and comes back with it — leaving the copy is the same leak on a
   * delay.
   */
  it("revokes an archived session's copy too", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
    sessions.archive("s1");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
  });

  /**
   * The one refusal sign-out keeps: rewriting credentials under a live agent
   * turns someone's in-flight turn into a 401 instead of an answer. It has to
   * refuse *before* touching anything, so the retry has something to act on.
   */
  it("refuses mid-turn without revoking or deleting anything", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
    runningSessionIds.add("s1");

    expect(() => signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root }))
      .toThrow(/mid-turn/i);

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(true);
    expect(accounts.list("claude").map((account) => account.id)).toEqual([a]);
    expect(signedOutProviders).toEqual([]);
  });
});
