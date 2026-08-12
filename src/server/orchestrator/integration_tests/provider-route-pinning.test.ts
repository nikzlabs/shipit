/**
 * docs/260 — per-turn account routing, driven end to end through env-prep.
 *
 * These drive `prepareSessionAgentEnvironment` against the REAL
 * `ProviderAccountManager`, `CredentialStore` and `SessionManager` (a real
 * SQLite DB), rather than the stubs the unit tests use. That combination is
 * the thing worth integrating: selection is a decision taken in env-prep and
 * carried as a VALUE (the returned turn route + the runner stamp), and every
 * unit test in this area stubs one side or the other.
 *
 * Covers:
 *   - req 1  — every turn selects its account; nothing persists a route on the
 *              session row
 *   - req 5/9 — telemetry orders, only remembered refusals skip, and the turn
 *              route follows recovery
 *   - req 7  — a refused subscription never rolls onto metered billing
 *   - req 8  — the strategy always wins across turns (cutoffs move work)
 *   - req 6/13 wording — an all-refused selection names the earliest re-try
 *   - detached system turns run the session's own agent through the same
 *              selection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CredentialStore } from "../credential-store.js";
import { accountServiceForHarness, ProviderAccountManager } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { SessionRunnerRegistry } from "../session-runner.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { wakeSessionWithTurn } from "../wake-session.js";
import { markProviderAccountUnauthenticated } from "../app-lifecycle.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap } from "../../shared/types.js";
import type { ProviderRouteKind } from "../../shared/types/domain-types/provider.js";
import { createTestDatabaseManager } from "./test-helpers.js";

class FakeRunner extends EventEmitter {
  agentId: AgentId = "claude";
  running = false;
  disposed = false;
  sessionId = "s1";
  sessionDir = "/tmp/s1";
  residentRoute: { kind: ProviderRouteKind; id: string } | undefined = undefined;
  pushAgentEnv = () => {};
}

/**
 * Seed real on-disk credentials for an account so provisioning has a source.
 * `token` is written into the file the CLI would read, so a test can tell
 * *whose* credentials a session ended up holding.
 */
function seedAccountCredentials(
  root: string,
  provider: AgentId,
  accountId: string,
  token = "t",
): void {
  const base = path.join(root, "provider-accounts", provider, accountId);
  if (provider === "claude") {
    fs.mkdirSync(path.join(base, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(base, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(base, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, accessToken: token } }),
    );
  } else {
    fs.mkdirSync(path.join(base, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(base, ".codex", "auth.json"), JSON.stringify({ tokens: token }));
  }
}

/** A quota snapshot with `pct` used in the short (5h) window. */
function sessionWindowAt(pct: number, serviceId = "anthropic"): SubscriptionLimits {
  return {
    serviceId,
    billingMode: "sub",
    routeId: "unused",
    plan: null,
    session: { usedPct: pct, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
    weekly: null,
    fetchedAt: 0,
  };
}

describe("per-turn account routing (docs/260)", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let savedSessionId: string | undefined;
  /** Live quota snapshot the manager reads — mutated per test. */
  let limits: SubscriptionLimitsMap;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-route-turn-"));
    store = new CredentialStore(root);
    limits = {};
    accounts = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: store,
      getSubscriptionLimits: () => limits,
    });
    sessions = new SessionManager(createTestDatabaseManager());
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
  });

  function readyAccount(provider: AgentId, label: string, token = "t"): string {
    const serviceId = accountServiceForHarness(provider);
    const acct = accounts.create(serviceId, label);
    accounts.setAccountStatus(serviceId, acct.id, "ready");
    seedAccountCredentials(root, provider, acct.id, token);
    return acct.id;
  }

  async function runEnvPrep(
    sessionId: string,
    agentId: AgentId,
    opts: { excludeRouteIds?: string[] } = {},
  ): Promise<{ runner: FakeRunner; turnRoute: { kind: ProviderRouteKind; id: string } | undefined }> {
    const runner = new FakeRunner();
    runner.sessionId = sessionId;
    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId,
      agentId,
      enforceAccountRouting: true,
      ...(opts.excludeRouteIds ? { excludeRouteIds: opts.excludeRouteIds } : {}),
      deps: {
        credentialsDir: root,
        credentialStore: store,
        sessionManager: sessions,
        providerAccountManager: accounts,
      },
    });
    return { runner, turnRoute: result.turnRoute };
  }

  it("selects an account per turn and carries it as a value, never a session row (req 1)", async () => {
    const accountId = readyAccount("claude", "Work");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    const { runner, turnRoute } = await runEnvPrep("s1", "claude");

    expect(turnRoute).toEqual({ kind: "account", id: accountId });
    // The runner stamp is the process-scoped identity (docs/260 §5)...
    expect(runner.residentRoute).toEqual({ kind: "account", id: accountId });
    // ...and the session row records the agent, but NO route (req 2).
    const session = sessions.get("s1");
    expect(session?.agentId).toBe("claude");
    expect(session?.providerRouteId).toBeFalsy();
  });

  it("routes a Codex turn the same way", async () => {
    const accountId = readyAccount("codex", "Personal");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    const { turnRoute } = await runEnvPrep("s1", "codex");

    expect(turnRoute).toEqual({ kind: "account", id: accountId });
    expect(sessions.get("s1")?.agentId).toBe("codex");
  });

  it("stamps lastUsedAt through the real account manager (req 21 wiring)", async () => {
    // env-prep calls `markAccountUsed?.()` optionally, so that the bookkeeping
    // can never fail a turn. That optionality means a wiring mistake would be
    // silent — this asserts the stamp actually lands when the collaborator is
    // the real manager, which is what `balanced` depends on.
    const accountId = readyAccount("claude", "Work");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));
    expect(accounts.get("anthropic", accountId)?.lastUsedAt).toBeUndefined();

    await runEnvPrep("s1", "claude");

    expect(accounts.get("anthropic", accountId)?.lastUsedAt).toBeGreaterThan(0);
  });

  it("routes to a healthy secondary while the first account's refusal is remembered (req 9)", async () => {
    const first = readyAccount("claude", "Spent");
    const second = readyAccount("claude", "Healthy");
    accounts.markAccountExhausted("anthropic", first, Date.now() + 3_600_000);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    const { turnRoute } = await runEnvPrep("s1", "claude");
    expect(turnRoute).toEqual({ kind: "account", id: second });
  });

  it("routes the next turn to a healthy subscription after an account-qualified auth failure", async () => {
    process.env.ANTHROPIC_API_KEY = "configured-metered-key";
    const first = readyAccount("claude", "Missing source");
    const second = readyAccount("claude", "Healthy subscription");
    const events: { event: string; data: unknown }[] = [];
    const agentRegistry = {
      refreshAuth: () => {},
      list: () => [],
    } as unknown as AgentRegistry;

    // This is the persistence and UI event path used by the OAuth refresher's
    // account_unauthenticated event for missing credentials and revocation.
    markProviderAccountUnauthenticated({
      agentId: "claude",
      accountId: first,
      providerAccountManager: accounts,
      agentRegistry,
      sseBroadcast: (event, data) => events.push({ event, data }),
      credentialStore: store,
    });

    expect(accounts.get("anthropic", first)?.status).toBe("auth_failed");
    expect(events).toContainEqual({
      event: "provider_accounts",
      data: { accounts: expect.arrayContaining([expect.objectContaining({ id: first, status: "auth_failed" })]) },
    });

    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));
    const { turnRoute } = await runEnvPrep("s1", "claude");
    expect(turnRoute).toEqual({ kind: "account", id: second });
    expect(turnRoute).not.toEqual({ kind: "reserved", id: "anthropic-key" });
  });

  it("returns to the strategy's best account the turn its refusal clears (reqs 1, 8)", async () => {
    const first = readyAccount("claude", "Primary");
    const second = readyAccount("claude", "Secondary");
    accounts.markAccountExhausted("anthropic", first, Date.now() + 1_000);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    // First turn: primary is refusal-blocked, the session runs on the
    // secondary. No pin records that.
    expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(second);

    // The refusal lapses; the next turn is back on the primary — the strategy
    // wins, with no stored preference to fight.
    accounts.clearAccountExhaustion("anthropic", first);
    expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(first);
  });

  it("still TRIES the best remembered-refused account rather than failing untried (req 12)", async () => {
    // A resend after an all-refused turn re-tries every account: the turn's
    // own selection is optimistic, so refusal memory orders candidates but
    // cannot fail a first attempt on its own.
    const resetAt = Date.now() + 10 * 60 * 1000;
    const first = readyAccount("claude", "A");
    const second = readyAccount("claude", "B");
    accounts.markAccountExhausted("anthropic", first, resetAt);
    accounts.markAccountExhausted("anthropic", second, resetAt);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    const { turnRoute } = await runEnvPrep("s1", "claude");
    expect(turnRoute).toEqual({ kind: "account", id: first });
  });

  it("fails only when every account was refused THIS turn — the attempt loop's exclusions (reqs 6, 9)", async () => {
    const first = readyAccount("claude", "A");
    const second = readyAccount("claude", "B");
    const sessionDir = path.join(root, "sessions", "s1");
    sessions.track("s1", "Test", sessionDir);

    await expect(
      runEnvPrep("s1", "claude", { excludeRouteIds: [first, second] }),
    ).rejects.toThrow(/out of quota/);

    // The turn fails *before* anything makes it look like it ran on an
    // account: no credentials, no agent pin, no route anywhere.
    const session = sessions.get("s1");
    expect(session?.agentPinned).toBeFalsy();
    expect(fs.existsSync(path.join(sessionDir, ".claude", ".credentials.json"))).toBe(false);
  });

  it("does not roll a refused subscription onto a configured API key (req 7)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const only = readyAccount("claude", "Subscription");
    accounts.markAccountExhausted("anthropic", only, Date.now() + 3_600_000);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    // The remembered refusal is probed (req 12) — but the answer is NEVER the
    // metered key, neither on the first attempt nor after the account refused
    // this very turn.
    expect((await runEnvPrep("s1", "claude")).turnRoute).toEqual({ kind: "account", id: only });
    await expect(runEnvPrep("s1", "claude", { excludeRouteIds: [only] })).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // req 8 — cutoffs move work per turn, as ordering, not as displacement
  // machinery: at 95% the account still runs turns, it just stops being the
  // first choice, and the strategy is re-asked on every turn.
  // -------------------------------------------------------------------------
  describe("cutoffs steer the per-turn selection (req 8)", () => {
    it("moves the next turn off an account past the default 90% cutoff", async () => {
      const first = readyAccount("claude", "Work");
      const second = readyAccount("claude", "Personal");
      sessions.track("s1", "Test", path.join(root, "sessions", "s1"));
      expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(first);

      limits = { "anthropic:sub": { [first]: sessionWindowAt(95) } };
      expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(second);
    });

    it("stays put below the cutoff, and moves once the user lowers it", async () => {
      const first = readyAccount("claude", "Work");
      const second = readyAccount("claude", "Personal");
      sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

      // 60% is comfortably under the 90% default — nothing should move, or
      // the cutoff would be decoration.
      limits = { "anthropic:sub": { [first]: sessionWindowAt(60) } };
      expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(first);

      // The same 60% against a user-configured 50% cutoff does move it. This
      // is the stored setting reaching the router, end to end.
      store.setFailoverCutoffs("anthropic", "sub", { session: 50 });
      expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(second);
    });

    it("keeps working on the best over-cutoff account when every account is over", async () => {
      const first = readyAccount("claude", "Work");
      const second = readyAccount("claude", "Personal");
      sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

      limits = {
        "anthropic:sub": { [first]: sessionWindowAt(95), [second]: sessionWindowAt(97) },
      };
      // Spent-but-usable: the ordering is stable (priority order within the
      // tier), so the session keeps working instead of failing or churning.
      expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(first);
      expect((await runEnvPrep("s1", "claude")).turnRoute?.id).toBe(first);
    });

    it("steers Codex turns by the same rule", async () => {
      const first = readyAccount("codex", "Codex work");
      const second = readyAccount("codex", "Codex personal");
      sessions.track("s2", "Test", path.join(root, "sessions", "s2"));
      expect((await runEnvPrep("s2", "codex")).turnRoute?.id).toBe(first);

      limits = { "openai:sub": { [first]: sessionWindowAt(91, "openai") } };
      expect((await runEnvPrep("s2", "codex")).turnRoute?.id).toBe(second);
      // The resume pointer is untouched by routing — conversation state is
      // account-agnostic (req 7; the credential-subtree preservation itself is
      // covered by `ensureSessionAccountCredentials`'s own tests).
      sessions.setAgentSessionId("s2", "thread-1");
      await runEnvPrep("s2", "codex");
      expect(sessions.get("s2")?.agentSessionId).toBe("thread-1");
    });
  });
});

/**
 * docs/260 — a DETACHED system turn (no WS connect, no viewer) has to rebuild
 * its runner from what the session persisted: the AGENT is the session's own,
 * and the account is whatever the router chooses for that turn — there is no
 * pinned route to reuse.
 */
describe("detached system turns run the session's agent through per-turn selection", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let registry: SessionRunnerRegistry;
  let savedSessionId: string | undefined;

  const SESSION = "s-detached";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-detached-turn-"));
    store = new CredentialStore(root);
    accounts = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    sessions = new SessionManager(createTestDatabaseManager());
    registry = new SessionRunnerRegistry();
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    registry.disposeAll();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
  });

  /** A Codex session with two connected accounts; the router's answer is the primary. */
  function codexSessionWithTwoAccounts(): { primary: string; secondary: string } {
    const primary = accounts.create("openai", "Codex primary");
    const secondary = accounts.create("openai", "Codex secondary");
    for (const id of [primary.id, secondary.id]) {
      accounts.setAccountStatus("openai", id, "ready");
      seedAccountCredentials(root, "codex", id);
    }
    sessions.track(SESSION, "Detached", path.join(root, "workspaces", SESSION));
    sessions.setAgentId(SESSION, "codex");
    sessions.setAgentPinned(SESSION);
    return { primary: primary.id, secondary: secondary.id };
  }

  function wakeDeps() {
    return {
      sessionManager: sessions,
      runnerRegistry: registry,
      defaultAgentId: "claude" as AgentId,
      credentialsDir: root,
      credentialStore: store,
      providerAccountManager: accounts,
    };
  }

  it("corrects a runner seeded with the global default before the turn's env-prep", async () => {
    const { primary, secondary } = codexSessionWithTwoAccounts();
    // Container rescue / the warm pool seeded this one with the global default.
    const stale = registry.getOrCreate(SESSION, path.join(root, "workspaces", SESSION), "claude");
    expect(stale.agentId).toBe("claude");

    await wakeSessionWithTurn(wakeDeps(), sessions.get(SESSION)!, { text: "a merged PR needs you" });

    // The turn runs the session's own provider. (Account selection itself
    // happens in the dispatched turn's own env-prep, which this minimal wake
    // harness does not wire — the wake's pre-turn env-prep is an
    // account-neutral warm-up by design, docs/260 §5b.)
    expect(registry.get(SESSION)?.agentId).toBe("codex");
    expect(accounts.get("openai", secondary)?.lastUsedAt).toBeUndefined();
    void primary;
  });

  it("recreates a disposed runner from the persisted agent, not defaultAgentId", async () => {
    const { primary } = codexSessionWithTwoAccounts();
    registry.getOrCreate(SESSION, path.join(root, "workspaces", SESSION), "codex");
    registry.dispose(SESSION, { force: true });
    expect(registry.get(SESSION)).toBeUndefined();

    await wakeSessionWithTurn(wakeDeps(), sessions.get(SESSION)!, { text: "a merged PR needs you" });

    expect(registry.get(SESSION)?.agentId).toBe("codex");
    void primary;
  });
});
