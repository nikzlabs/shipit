import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { switchSessionProviderAccount } from "./provider-account-switch.js";
import { ServiceError } from "./types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

/**
 * docs/150 req 9 — the account-switch transition. The behaviour that matters is
 * not "the route field changed" but "the user's conversation is still there
 * afterwards", so these tests write real credential trees and real
 * conversation-state files and assert on the resulting session dir.
 */
describe("switchSessionProviderAccount", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;

  const SESSION = "sess-1";
  const sessionDir = () => path.join(root, "sessions", SESSION);

  /** A provider-account credential root with a distinguishable token. */
  function seedAccount(provider: "claude" | "codex", accountId: string, token: string): void {
    const accountRoot = providerAccountCredentialRoot(root, provider, accountId);
    if (provider === "claude") {
      fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), token);
      fs.writeFileSync(path.join(accountRoot, ".claude.json"), token);
    } else {
      fs.mkdirSync(path.join(accountRoot, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(accountRoot, ".codex", "auth.json"), token);
    }
  }

  function registryWith(runner: unknown): SessionRunnerRegistry {
    return { get: () => runner } as unknown as SessionRunnerRegistry;
  }

  const emptyRegistry = () => registryWith(undefined);

  function deps(registry: SessionRunnerRegistry = emptyRegistry()) {
    return {
      sessionManager: sessions,
      runnerRegistry: registry,
      providerAccountManager: accounts,
      credentialsDir: root,
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-account-switch-"));
    store = new CredentialStore(root);
    accounts = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    sessions = new SessionManager(createTestDatabaseManager());
    sessions.track(SESSION, "Test session");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("carries the Claude conversation across the switch and replaces the credentials", () => {
    const a = accounts.create("claude", "Account A");
    const b = accounts.create("claude", "Account B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    seedAccount("claude", a.id, "token-a");
    seedAccount("claude", b.id, "token-b");

    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);
    sessions.setAgentSessionId(SESSION, "conv-abc");

    // Session already provisioned from A, with a resume transcript written by
    // the CLI and a settings file only A produced.
    const dir = sessionDir();
    fs.mkdirSync(path.join(dir, ".claude", "projects", "-workspace"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), "token-a");
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "a-only");
    fs.writeFileSync(path.join(dir, ".claude", "projects", "-workspace", "conv-abc.jsonl"), "turn1\n");

    const result = switchSessionProviderAccount(SESSION, b.id, deps());

    expect(result).toMatchObject({
      fromAccountId: a.id,
      toAccountId: b.id,
      agentSessionId: "conv-abc",
      killedRunningAgent: false,
    });
    // The conversation the user is mid-way through survives...
    expect(
      fs.readFileSync(path.join(dir, ".claude", "projects", "-workspace", "conv-abc.jsonl"), "utf-8"),
    ).toBe("turn1\n");
    // ...the credentials are B's...
    expect(fs.readFileSync(path.join(dir, ".claude", ".credentials.json"), "utf-8")).toBe("token-b");
    // ...and A-only leftovers are gone.
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
    // The resume id is untouched, which is what makes the next turn continue.
    expect(sessions.get(SESSION)?.agentSessionId).toBe("conv-abc");
    expect(sessions.get(SESSION)?.providerRouteId).toBe(b.id);
  });

  it("carries a Codex rollout across the switch", () => {
    const a = accounts.create("codex", "Codex A");
    const b = accounts.create("codex", "Codex B");
    accounts.setAccountStatus("codex", a.id, "ready");
    accounts.setAccountStatus("codex", b.id, "ready");
    seedAccount("codex", a.id, "codex-a");
    seedAccount("codex", b.id, "codex-b");

    sessions.setAgentId(SESSION, "codex");
    sessions.setProviderRoute(SESSION, "account", a.id);

    const dir = sessionDir();
    const rollout = path.join(dir, ".codex", "sessions", "2026", "08", "01");
    fs.mkdirSync(rollout, { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex", "auth.json"), "codex-a");
    fs.writeFileSync(path.join(rollout, "rollout-thread-1.jsonl"), "thread\n");

    switchSessionProviderAccount(SESSION, b.id, deps());

    expect(fs.readFileSync(path.join(rollout, "rollout-thread-1.jsonl"), "utf-8")).toBe("thread\n");
    expect(fs.readFileSync(path.join(dir, ".codex", "auth.json"), "utf-8")).toBe("codex-b");
  });

  it("kills a live agent so it cannot keep spending the outgoing account's token", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    seedAccount("claude", a.id, "token-a");
    seedAccount("claude", b.id, "token-b");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    let killed = 0;
    let clearedAgent = false;
    const runner = {
      running: false,
      getAgent: () => ({ kill: () => { killed++; } }),
      setAgent: (agent: unknown) => { clearedAgent = agent === null; },
    };

    const result = switchSessionProviderAccount(SESSION, b.id, deps(registryWith(runner)));

    expect(killed).toBe(1);
    expect(clearedAgent).toBe(true);
    expect(result.killedRunningAgent).toBe(true);
  });

  it("still rewrites credentials when killing an already-dead agent throws", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    seedAccount("claude", a.id, "token-a");
    seedAccount("claude", b.id, "token-b");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    const runner = {
      running: false,
      getAgent: () => ({ kill: () => { throw new Error("ESRCH"); } }),
      setAgent: () => {},
    };

    switchSessionProviderAccount(SESSION, b.id, deps(registryWith(runner)));

    expect(fs.readFileSync(path.join(sessionDir(), ".claude", ".credentials.json"), "utf-8")).toBe("token-b");
    expect(sessions.get(SESSION)?.providerRouteId).toBe(b.id);
  });

  it("refuses to switch mid-turn rather than yanking credentials from under it", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    seedAccount("claude", b.id, "token-b");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    const runner = { running: true, getAgent: () => null, setAgent: () => {} };

    expect(() => switchSessionProviderAccount(SESSION, b.id, deps(registryWith(runner))))
      .toThrow(ServiceError);
    expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
  });

  it("refuses an account that is not usable", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "auth_failed");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    expect(() => switchSessionProviderAccount(SESSION, b.id, deps())).toThrow(/not usable/);
    expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
  });

  it("refuses an account belonging to the other provider", () => {
    const claudeA = accounts.create("claude", "A");
    const codexB = accounts.create("codex", "B");
    accounts.setAccountStatus("claude", claudeA.id, "ready");
    accounts.setAccountStatus("codex", codexB.id, "ready");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", claudeA.id);

    // Cross-provider is not a "switch" — it would need a different agent CLI
    // and a conversation the other provider cannot read.
    expect(() => switchSessionProviderAccount(SESSION, codexB.id, deps())).toThrow(/No claude account/);
  });

  it("is a no-op when the session is already on the target account", () => {
    const a = accounts.create("claude", "A");
    accounts.setAccountStatus("claude", a.id, "ready");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    let killed = 0;
    const runner = {
      running: false,
      getAgent: () => ({ kill: () => { killed++; } }),
      setAgent: () => {},
    };

    const result = switchSessionProviderAccount(SESSION, a.id, deps(registryWith(runner)));

    expect(result.killedRunningAgent).toBe(false);
    // Re-provisioning a session onto the account it is already using would kill
    // a healthy agent for nothing.
    expect(killed).toBe(0);
  });
});
