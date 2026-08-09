import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { failoverNotice, failoverPinnedSession, switchSessionProviderAccount } from "./provider-account-switch.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import type { SubscriptionLimits, SubscriptionLimitsMap } from "../../shared/types.js";
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
    const a = accounts.create("anthropic", "Account A");
    const b = accounts.create("anthropic", "Account B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
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
    const a = accounts.create("openai", "Codex A");
    const b = accounts.create("openai", "Codex B");
    accounts.setAccountStatus("openai", a.id, "ready");
    accounts.setAccountStatus("openai", b.id, "ready");
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
    const a = accounts.create("anthropic", "A");
    const b = accounts.create("anthropic", "B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
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
    const a = accounts.create("anthropic", "A");
    const b = accounts.create("anthropic", "B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
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
    const a = accounts.create("anthropic", "A");
    const b = accounts.create("anthropic", "B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
    seedAccount("claude", b.id, "token-b");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    const runner = { running: true, getAgent: () => null, setAgent: () => {} };

    expect(() => switchSessionProviderAccount(SESSION, b.id, deps(registryWith(runner))))
      .toThrow(ServiceError);
    expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
  });

  it("refuses an account that is not usable", () => {
    const a = accounts.create("anthropic", "A");
    const b = accounts.create("anthropic", "B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "auth_failed");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    expect(() => switchSessionProviderAccount(SESSION, b.id, deps())).toThrow(/not usable/);
    expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
  });

  it("refuses an account belonging to the other provider", () => {
    const claudeA = accounts.create("anthropic", "A");
    const codexB = accounts.create("openai", "B");
    accounts.setAccountStatus("anthropic", claudeA.id, "ready");
    accounts.setAccountStatus("openai", codexB.id, "ready");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", claudeA.id);

    // Cross-provider is not a "switch" — it would need a different agent CLI
    // and a conversation the other provider cannot read.
    expect(() => switchSessionProviderAccount(SESSION, codexB.id, deps())).toThrow(/No claude account/);
  });

  it("is a no-op when the session is already on the target account", () => {
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");
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

/**
 * docs/150 reqs 3, 7, 8 — the pre-turn failover: an already-pinned session
 * whose account is spent moves to the next eligible one, keeping its
 * conversation, and fails the turn when there is nowhere to go.
 */
describe("failoverPinnedSession", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let limits: SubscriptionLimitsMap;

  const SESSION = "sess-failover";
  const sessionDir = () => path.join(root, "sessions", SESSION);

  /** An exhausted 5h window that frees up at `resetAt`. */
  function spent(resetAt: string): SubscriptionLimits {
    return {
      serviceId: "anthropic",
    billingMode: "sub",
      routeId: "unused",
      plan: null,
      session: { usedPct: 100, resetAt },
      weekly: null,
      fetchedAt: 0,
    };
  }

  function seedClaudeAccount(accountId: string, token: string): void {
    const accountRoot = providerAccountCredentialRoot(root, "claude", accountId);
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), token);
    fs.writeFileSync(path.join(accountRoot, ".claude.json"), token);
  }

  const deps = () => ({
    sessionManager: sessions,
    providerAccountManager: accounts,
    credentialsDir: root,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-account-failover-"));
    store = new CredentialStore(root);
    limits = {};
    accounts = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: store,
      getSubscriptionLimits: () => limits,
    });
    sessions = new SessionManager(createTestDatabaseManager());
    sessions.track(SESSION, "Test session");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Two ready Claude accounts, session pinned to the first, mid-conversation. */
  function pinnedToExhaustedPrimary(): { a: string; b: string } {
    const a = accounts.create("anthropic", "Work");
    const b = accounts.create("anthropic", "Personal");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
    seedClaudeAccount(a.id, "token-a");
    seedClaudeAccount(b.id, "token-b");

    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);
    sessions.setAgentSessionId(SESSION, "conv-xyz");

    const dir = sessionDir();
    fs.mkdirSync(path.join(dir, ".claude", "projects", "-workspace"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), "token-a");
    fs.writeFileSync(path.join(dir, ".claude", "projects", "-workspace", "conv-xyz.jsonl"), "turn1\n");

    limits = { "anthropic:sub": { [a.id]: spent(new Date(Date.now() + 3_600_000).toISOString()) } };
    return { a: a.id, b: b.id };
  }

  it("moves an exhausted pinned session to the next account and keeps the conversation (reqs 3, 8, 9)", () => {
    const { a, b } = pinnedToExhaustedPrimary();

    const moved = failoverPinnedSession(SESSION, deps());

    expect(moved).toMatchObject({
      provider: "claude",
      fromAccountId: a,
      fromLabel: "Work",
      toAccountId: b,
      toLabel: "Personal",
    });
    expect(sessions.get(SESSION)?.providerRouteId).toBe(b);
    // req 9 — the user does not lose the conversation they are in the middle of.
    expect(sessions.get(SESSION)?.agentSessionId).toBe("conv-xyz");
    expect(
      fs.readFileSync(path.join(sessionDir(), ".claude", "projects", "-workspace", "conv-xyz.jsonl"), "utf-8"),
    ).toBe("turn1\n");
    // ...running on the incoming account's credentials.
    expect(
      fs.readFileSync(path.join(sessionDir(), ".claude", ".credentials.json"), "utf-8"),
    ).toBe("token-b");
  });

  // docs/150 reqs 6, 7, 11 — a cutoff move and an exhaustion move are
  // different events, and the transcript notice is where the user learns which
  // one happened. "out of quota" about an account sitting at 92% tells them
  // their subscription is spent when it is not.
  describe("the notice says why the session moved", () => {
    /** A window at `usedPct`, still open — over the 90% cutoff but not spent. */
    function used(pct: number): SubscriptionLimits {
      return {
        serviceId: "anthropic",
    billingMode: "sub",
        routeId: "unused",
        plan: null,
        session: { usedPct: pct, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
        weekly: null,
        fetchedAt: 0,
      };
    }

    function twoAccountsPinnedToFirst(): { a: string; b: string } {
      const a = accounts.create("anthropic", "Work");
      const b = accounts.create("anthropic", "Personal");
      accounts.setAccountStatus("anthropic", a.id, "ready");
      accounts.setAccountStatus("anthropic", b.id, "ready");
      seedClaudeAccount(a.id, "token-a");
      seedClaudeAccount(b.id, "token-b");
      sessions.setAgentId(SESSION, "claude");
      sessions.setProviderRoute(SESSION, "account", a.id);
      return { a: a.id, b: b.id };
    }

    it("reports a cutoff move as a cutoff, not as exhaustion (req 6)", () => {
      const { a, b } = twoAccountsPinnedToFirst();
      limits = { "anthropic:sub": { [a]: used(92), [b]: used(10) } };

      const moved = failoverPinnedSession(SESSION, deps());

      expect(moved?.reason).toBe("over_cutoff");
      expect(failoverNotice(moved!)).toBe(
        "Work reached your usage cutoff — continuing this session on Personal.",
      );
    });

    it("reports a spent account as out of quota (req 7)", () => {
      const { a, b } = twoAccountsPinnedToFirst();
      limits = { "anthropic:sub": { [a]: spent(new Date(Date.now() + 3_600_000).toISOString()), [b]: used(10) } };

      const moved = failoverPinnedSession(SESSION, deps());

      expect(moved?.reason).toBe("exhausted");
      expect(failoverNotice(moved!)).toBe(
        "Work is out of quota — continuing this session on Personal.",
      );
    });

    // req 23 strands sessions on a disconnected account, and a signed-out one
    // reaches the same state. Neither ran out of anything.
    it("reports an account that lost its sign-in as unavailable", () => {
      const { a, b } = twoAccountsPinnedToFirst();
      accounts.setAccountStatus("anthropic", a, "auth_failed");
      limits = { "anthropic:sub": { [b]: used(10) } };

      const moved = failoverPinnedSession(SESSION, deps());

      expect(moved?.reason).toBe("unavailable");
      expect(failoverNotice(moved!)).toBe(
        "Work is no longer available — continuing this session on Personal.",
      );
    });
  });

  it("does nothing while the pinned account still has quota", () => {
    const a = accounts.create("anthropic", "Work");
    accounts.create("anthropic", "Personal");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    seedClaudeAccount(a.id, "token-a");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);

    expect(failoverPinnedSession(SESSION, deps())).toBeNull();
    expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
  });

  // The router walks primary-first, so asking it "who should run this turn"
  // would name the primary and read as "you have been skipped" for a session
  // healthily pinned to a secondary. Eligibility is asked about the pinned
  // route, not derived from the router's preference.
  it("leaves a healthy session pinned to a NON-primary account alone", () => {
    const a = accounts.create("anthropic", "Work");
    const b = accounts.create("anthropic", "Personal");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
    seedClaudeAccount(a.id, "token-a");
    seedClaudeAccount(b.id, "token-b");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", b.id);

    expect(accounts.getPrimary("anthropic")?.id).toBe(a.id);
    expect(failoverPinnedSession(SESSION, deps())).toBeNull();
    expect(sessions.get(SESSION)?.providerRouteId).toBe(b.id);
  });

  it("fails the turn with the earliest reset when the only account is spent (reqs 8 + 13)", () => {
    const a = accounts.create("anthropic", "Work");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    seedClaudeAccount(a.id, "token-a");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    limits = { "anthropic:sub": { [a.id]: spent(resetAt) } };

    expect(() => failoverPinnedSession(SESSION, deps())).toThrow(ProviderRouteUnavailableError);
    // The session stays where it is: nothing to move to, so nothing moved.
    expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
  });

  // req 12 — a spent subscription must never roll onto pay-as-you-go billing.
  it("does not move an exhausted session onto the metered API-key route", () => {
    const a = accounts.create("anthropic", "Work");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    seedClaudeAccount(a.id, "token-a");
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "account", a.id);
    limits = { "anthropic:sub": { [a.id]: spent(new Date(Date.now() + 3_600_000).toISOString()) } };

    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-metered";
    try {
      expect(() => failoverPinnedSession(SESSION, deps())).toThrow(ProviderRouteUnavailableError);
      expect(sessions.get(SESSION)?.providerRouteId).toBe(a.id);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("leaves a session on a reserved route alone (no subscription window to exhaust)", () => {
    sessions.setAgentId(SESSION, "claude");
    sessions.setProviderRoute(SESSION, "reserved", "claude-api-key");

    expect(failoverPinnedSession(SESSION, deps())).toBeNull();
    expect(sessions.get(SESSION)?.providerRouteId).toBe("claude-api-key");
  });

  it("does nothing for a session that has not been pinned yet", () => {
    sessions.setAgentId(SESSION, "claude");
    expect(failoverPinnedSession(SESSION, deps())).toBeNull();
  });
});
