import type { LoginIntegrationId } from "../../shared/catalogue/types.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { writeSessionAccountMarker } from "../session-credentials.js";
import { signOutProvider } from "./settings.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

describe("signOutProvider", () => {
  let root: string;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let runningSessionIds: Set<string>;
  let residentAgents: Map<string, { killed: boolean; cleared: boolean }>;
  let signedOutProviders: string[];

  const registry = () => ({
    ids: () => [...new Set([...residentAgents.keys(), ...runningSessionIds])],
    get: (id: string) => {
      const resident = residentAgents.get(id);
      if (!resident && !runningSessionIds.has(id)) return undefined;
      return {
        sessionId: id,
        running: runningSessionIds.has(id),
        backgroundWorkDescriptions: [] as string[],
        residentRoute: undefined,
        getAgent: () => (resident ? { kill: () => { resident.killed = true; } } : null),
        setAgent: (agent: unknown) => { if (resident && agent === null) resident.cleared = true; },
      };
    },
  }) as unknown as SessionRunnerRegistry;

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

  function connectAccount(label: string): string {
    const account = accounts.create("anthropic", label);
    accounts.setAccountStatus("anthropic", account.id, "ready");
    seedAccount(account.id, `token-${label}`);
    return account.id;
  }

  function pinSession(id: string, accountId: string, agentId: "claude" | "codex" = "claude"): void {
    sessions.track(id, id);
    sessions.setAgentId(id, agentId);
    fs.mkdirSync(path.join(root, "sessions", id), { recursive: true });
    writeSessionAccountMarker(root, id, agentId, accountId);
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
      getActiveAccountId: () => null,
      cancel: () => {},
    } as unknown as AgentAuthManager);
    accounts.attachAuthManagers(new Map<LoginIntegrationId, AgentAuthManager>([
      ["anthropic-oauth", stubAuthManager("claude")],
      ["openai-chatgpt", stubAuthManager("codex")],
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

    expect(accounts.list("anthropic")).toEqual([]);
    expect(fs.existsSync(accountRoot)).toBe(false);
    expect(signedOutProviders).toEqual(["claude"]);
  });

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

  it("retires the resident agent process before it takes the credentials away", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
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

  it("routes the session's next turn through selection once accounts are gone (req 1)", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(accounts.selectAccountForTurn("anthropic")).toEqual({ ok: false, reason: "auth_required" });
  });

  it("leaves a session on a reserved route alone", () => {
    connectAccount("A");
    sessions.track("s1", "s1");
    sessions.setAgentId("s1", "claude");
    sessions.setProviderRoute("s1", "reserved", "claude-env-oauth");
    seedSessionCredentials("s1", "env-token");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.readFileSync(sessionTokenPath("s1"), "utf-8")).toBe("env-token");
  });

  it("leaves the other provider's pinned sessions alone", () => {
    const claudeAccount = connectAccount("A");
    const codexAccount = accounts.create("openai", "Codex A");
    accounts.setAccountStatus("openai", codexAccount.id, "ready");
    pinSession("s1", claudeAccount);
    pinSession("s2", codexAccount.id, "codex");
    seedSessionCredentials("s1", "token-A");
    const codexAuth = path.join(root, "sessions", "s2", ".codex", "auth.json");
    fs.mkdirSync(path.dirname(codexAuth), { recursive: true });
    fs.writeFileSync(codexAuth, "codex-token");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
    expect(fs.readFileSync(codexAuth, "utf-8")).toBe("codex-token");
    expect(accounts.list("openai").map((account) => account.id)).toEqual([codexAccount.id]);
  });

  it("revokes an archived session's copy too", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
    sessions.archive("s1");

    signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root });

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
  });

  it("refuses mid-turn without revoking or deleting anything", () => {
    const a = connectAccount("A");
    pinSession("s1", a);
    seedSessionCredentials("s1", "token-A");
    runningSessionIds.add("s1");

    expect(() => signOutProvider(accounts, sessions, registry(), "claude", { credentialsDir: root }))
      .toThrow(/mid-turn/i);

    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(true);
    expect(accounts.list("anthropic").map((account) => account.id)).toEqual([a]);
    expect(signedOutProviders).toEqual([]);
  });
});
