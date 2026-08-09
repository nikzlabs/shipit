/**
 * docs/150 — route pinning, the fail-fast that must happen *before* it, and
 * what the pinned route governs afterwards.
 *
 * These drive `prepareSessionAgentEnvironment` against the REAL
 * `ProviderAccountManager`, `CredentialStore` and `SessionManager` (a real
 * SQLite DB), rather than the stubs the unit tests use. That combination is the
 * thing worth integrating: pinning is a decision taken in env-prep and durably
 * recorded by the session manager, and every unit test in this area stubs one
 * side or the other, so nothing until now asserted that the two actually agree.
 *
 * Covers:
 *   - req 3  — the first turn pins { agent_id, provider_route_kind, provider_route_id }
 *   - req 12 — an exhausted subscription does not roll onto metered billing
 *   - req 13 — an all-exhausted turn fails with the reset time, pins NOTHING,
 *              and provisions no credentials
 *   - reqs 4/6/9 — an EXISTING pinned session moves at the proactive cutoff and
 *              keeps its conversation
 *   - req 18 — a detached system turn recreates its runner from the persisted
 *              agent and route, not from the global default
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SessionRunner, SessionRunnerRegistry } from "../session-runner.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { wakeSessionWithTurn } from "../wake-session.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap } from "../../shared/types.js";
import { createTestDatabaseManager } from "./test-helpers.js";

class FakeRunner extends EventEmitter {
  agentId: AgentId = "claude";
  running = false;
  disposed = false;
  sessionId = "s1";
  sessionDir = "/tmp/s1";
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
function sessionWindowAt(pct: number, agentId: AgentId = "claude"): SubscriptionLimits {
  return {
    agentId,
    routeId: "unused",
    plan: null,
    session: { usedPct: pct, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
    weekly: null,
    fetchedAt: 0,
  };
}

describe("provider route pinning (docs/150)", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let dbManager: ReturnType<typeof createTestDatabaseManager>;
  let savedSessionId: string | undefined;
  /** Live quota snapshot the manager reads — mutated per test. */
  let limits: SubscriptionLimitsMap;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-route-pin-"));
    store = new CredentialStore(root);
    limits = {};
    accounts = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: store,
      getSubscriptionLimits: () => limits,
    });
    dbManager = createTestDatabaseManager();
    sessions = new SessionManager(dbManager);
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
    const acct = accounts.create(provider, label);
    accounts.setAccountStatus(provider, acct.id, "ready");
    seedAccountCredentials(root, provider, acct.id, token);
    return acct.id;
  }

  async function runEnvPrep(sessionId: string, agentId: AgentId): Promise<void> {
    const runner = new FakeRunner();
    runner.sessionId = sessionId;
    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId,
      agentId,
      enforceAccountRouting: true,
      deps: {
        credentialsDir: root,
        credentialStore: store,
        sessionManager: sessions,
        providerAccountManager: accounts,
      },
    });
  }

  it("pins agent and provider route on a Claude session's first turn", async () => {
    const accountId = readyAccount("claude", "Work");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    await runEnvPrep("s1", "claude");

    const session = sessions.get("s1");
    expect(session?.agentId).toBe("claude");
    expect(session?.providerRouteKind).toBe("account");
    expect(session?.providerRouteId).toBe(accountId);
    expect(session?.agentPinned).toBe(true);
  });

  it("pins agent and provider route on a Codex session's first turn", async () => {
    const accountId = readyAccount("codex", "Personal");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    await runEnvPrep("s1", "codex");

    const session = sessions.get("s1");
    expect(session?.agentId).toBe("codex");
    expect(session?.providerRouteKind).toBe("account");
    expect(session?.providerRouteId).toBe(accountId);
  });

  it("stamps lastUsedAt through the real account manager (req 21 wiring)", async () => {
    // env-prep calls `markAccountUsed?.()` optionally, so that the bookkeeping
    // can never fail a turn. That optionality means a wiring mistake would be
    // silent — this asserts the stamp actually lands when the collaborator is
    // the real manager, which is what `balanced` depends on.
    const accountId = readyAccount("claude", "Work");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));
    expect(accounts.get("claude", accountId)?.lastUsedAt).toBeUndefined();

    await runEnvPrep("s1", "claude");

    expect(accounts.get("claude", accountId)?.lastUsedAt).toBeGreaterThan(0);
  });

  it("keeps the pinned route on later turns instead of re-selecting", async () => {
    const first = readyAccount("claude", "Work");
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));
    await runEnvPrep("s1", "claude");

    // A second, higher-priority-looking account appears mid-life. A pinned
    // session must not drift onto it — req 9's continuity depends on staying
    // put until something makes the pinned account unusable.
    readyAccount("claude", "Newer");
    await runEnvPrep("s1", "claude");

    expect(sessions.get("s1")?.providerRouteId).toBe(first);
  });

  it("pins a healthy secondary when the first account is exhausted", async () => {
    const first = readyAccount("claude", "Spent");
    const second = readyAccount("claude", "Healthy");
    accounts.markAccountExhausted("claude", first, Date.now() + 3_600_000);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    await runEnvPrep("s1", "claude");

    expect(sessions.get("s1")?.providerRouteId).toBe(second);
  });

  it("fails an all-exhausted turn, pinning nothing and provisioning nothing (req 13)", async () => {
    const resetAt = Date.now() + 30 * 60 * 1000;
    const first = readyAccount("claude", "A");
    const second = readyAccount("claude", "B");
    accounts.markAccountExhausted("claude", first, resetAt);
    accounts.markAccountExhausted("claude", second, resetAt);
    const sessionDir = path.join(root, "sessions", "s1");
    sessions.track("s1", "Test", sessionDir);

    await expect(runEnvPrep("s1", "claude")).rejects.toThrow();

    // req 13 — the turn fails *before* anything makes it look like it ran on an
    // account. A pin or a provisioned credential subtree here would leave the
    // session claiming an account it never used.
    const session = sessions.get("s1");
    expect(session?.providerRouteId).toBeFalsy();
    expect(session?.agentPinned).toBeFalsy();
    expect(fs.existsSync(path.join(sessionDir, ".claude", ".credentials.json"))).toBe(false);
  });

  it("names the earliest reset time when every account is spent (req 13)", async () => {
    const soon = Date.now() + 10 * 60 * 1000;
    const later = Date.now() + 90 * 60 * 1000;
    const first = readyAccount("claude", "A");
    const second = readyAccount("claude", "B");
    // Deliberately spend the LATER-resetting account first, so a bug that
    // reports "the first exhausted account's reset" rather than the minimum
    // would surface.
    accounts.markAccountExhausted("claude", first, later);
    accounts.markAccountExhausted("claude", second, soon);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    await expect(runEnvPrep("s1", "claude")).rejects.toThrow(
      new RegExp(new Date(soon).toISOString().slice(0, 16)),
    );
  });

  it("does not roll an exhausted subscription onto a configured API key (req 12)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const only = readyAccount("claude", "Subscription");
    accounts.markAccountExhausted("claude", only, Date.now() + 3_600_000);
    sessions.track("s1", "Test", path.join(root, "sessions", "s1"));

    // The API key would work. Spending the user's money because a subscription
    // ran out is the one outcome this feature must never produce.
    await expect(runEnvPrep("s1", "claude")).rejects.toThrow();
    expect(sessions.get("s1")?.providerRouteId).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // reqs 4, 6, 8, 9 — the PROACTIVE cutoff for an existing pinned session.
  //
  // Distinct from the exhaustion cases above: at 95% the account is still
  // perfectly able to run the turn, so nothing fails — the session simply has
  // to be on the next account by the time the turn spawns, WITHOUT losing the
  // conversation it is in the middle of. The load-bearing half is the second
  // clause: a test that only checked the route field would pass while req 9's
  // failure mode (reprovisioning deletes the resume transcript) shipped.
  // -------------------------------------------------------------------------
  describe("an existing pinned session at the proactive cutoff", () => {
    /**
     * Pin `s1` to a first Claude account and give it the state a session
     * mid-conversation actually holds: a resume id, the CLI's conversation
     * jsonl, and that account's credentials in its per-session subtree.
     */
    async function pinnedMidConversation(): Promise<{ first: string; second: string; dir: string }> {
      const first = readyAccount("claude", "Work", "token-a");
      const second = readyAccount("claude", "Personal", "token-b");
      sessions.track("s1", "Test", path.join(root, "sessions", "s1"));
      await runEnvPrep("s1", "claude");
      expect(sessions.get("s1")?.providerRouteId).toBe(first);

      sessions.setAgentSessionId("s1", "conv-xyz");
      // The per-session subtree the container would hold after that first turn.
      // Written here rather than provisioned because provisioning is gated on a
      // ContainerSessionRunner; the switch itself is not, which is the point.
      const dir = path.join(root, "sessions", "s1");
      fs.mkdirSync(path.join(dir, ".claude", "projects", "-workspace"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "token-a" } }),
      );
      fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "a-only");
      fs.writeFileSync(
        path.join(dir, ".claude", "projects", "-workspace", "conv-xyz.jsonl"),
        "turn1\n",
      );
      return { first, second, dir };
    }

    function sessionAccessToken(dir: string): string {
      const raw = fs.readFileSync(path.join(dir, ".claude", ".credentials.json"), "utf-8");
      return (JSON.parse(raw) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
    }

    it("switches to the next account at the default 90% cutoff and keeps the conversation", async () => {
      const { first, second, dir } = await pinnedMidConversation();

      limits = { claude: { [first]: sessionWindowAt(95) } };
      await runEnvPrep("s1", "claude");

      const session = sessions.get("s1");
      expect(session?.providerRouteId).toBe(second);
      // req 9 — the local context that makes `--resume` work is still there.
      expect(session?.agentSessionId).toBe("conv-xyz");
      expect(
        fs.readFileSync(path.join(dir, ".claude", "projects", "-workspace", "conv-xyz.jsonl"), "utf-8"),
      ).toBe("turn1\n");
      // ...and the session is now running on the incoming account's credentials,
      // with the outgoing account's leftovers cleared.
      expect(sessionAccessToken(dir)).toBe("token-b");
      expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);
    });

    it("stays put below the cutoff, and moves once the user lowers it (req 4)", async () => {
      const { first, second } = await pinnedMidConversation();

      // 60% is comfortably under the 90% default — nothing should move, or the
      // cutoff would be decoration.
      limits = { claude: { [first]: sessionWindowAt(60) } };
      await runEnvPrep("s1", "claude");
      expect(sessions.get("s1")?.providerRouteId).toBe(first);

      // The same 60% against a user-configured 50% cutoff does move it. This is
      // the whole of req 4 end to end: the stored setting reaches the router.
      store.setFailoverCutoffs("anthropic", "sub", { session: 50 });
      await runEnvPrep("s1", "claude");
      expect(sessions.get("s1")?.providerRouteId).toBe(second);
    });

    it("does not churn when every account is over the cutoff", async () => {
      const { first, second } = await pinnedMidConversation();

      // Both spent-but-usable. Moving here would kill the resident process every
      // turn to land somewhere no better (req 6's "only if there IS somewhere
      // better"), so the session stays where it is and keeps working.
      limits = {
        claude: { [first]: sessionWindowAt(95), [second]: sessionWindowAt(97) },
      };
      await runEnvPrep("s1", "claude");

      expect(sessions.get("s1")?.providerRouteId).toBe(first);
    });

    it("carries a Codex rollout across a cutoff switch", async () => {
      const first = readyAccount("codex", "Codex work", "codex-a");
      const second = readyAccount("codex", "Codex personal", "codex-b");
      sessions.track("s2", "Test", path.join(root, "sessions", "s2"));
      await runEnvPrep("s2", "codex");
      expect(sessions.get("s2")?.providerRouteId).toBe(first);

      sessions.setAgentSessionId("s2", "thread-1");
      const dir = path.join(root, "sessions", "s2");
      const rollout = path.join(dir, ".codex", "sessions", "2026", "08", "04");
      fs.mkdirSync(rollout, { recursive: true });
      fs.writeFileSync(path.join(rollout, "rollout-2026-thread-1.jsonl"), "codex-turn1\n");

      limits = { codex: { [first]: sessionWindowAt(91, "codex") } };
      await runEnvPrep("s2", "codex");

      expect(sessions.get("s2")?.providerRouteId).toBe(second);
      expect(sessions.get("s2")?.agentSessionId).toBe("thread-1");
      // `thread/resume` reads this file; losing it is `-32600 no rollout found`.
      expect(fs.readFileSync(path.join(rollout, "rollout-2026-thread-1.jsonl"), "utf-8")).toBe(
        "codex-turn1\n",
      );
      expect(fs.readFileSync(path.join(dir, ".codex", "auth.json"), "utf-8")).toContain("codex-b");
    });

    // req 11 — the switch is announced where the user is already looking, and
    // it is PERSISTED, not merely emitted: a notice the transcript forgets on
    // reload is not a record of which subscription is now paying.
    it("records the switch in the session transcript", async () => {
      const { first } = await pinnedMidConversation();
      const chatHistoryManager = new ChatHistoryManager(dbManager);
      const runner = new SessionRunner({
        sessionId: "s1",
        sessionDir: path.join(root, "sessions", "s1"),
        defaultAgentId: "claude",
      });

      limits = { claude: { [first]: sessionWindowAt(95) } };
      await prepareSessionAgentEnvironment(runner, {
        sessionId: "s1",
        agentId: "claude",
        enforceAccountRouting: true,
        deps: {
          credentialsDir: root,
          credentialStore: store,
          sessionManager: sessions,
          providerAccountManager: accounts,
          chatHistoryManager,
        },
      });

      // Matched on the clause every failover sentence shares, not on the
      // reason-specific half: `failoverNotice` has one sentence per reason, so
      // anchoring here on "out of quota" pinned the *exhaustion* wording to a
      // test whose scenario is a 95% **cutoff**. It passed only because both
      // cases once shared a single hardcoded string, and broke the moment they
      // stopped — which is the distinction this test should be asserting, not
      // tripping over.
      const notices = chatHistoryManager
        .load("s1")
        .filter((m) => (m.text ?? "").includes("continuing this session on"));
      expect(notices).toHaveLength(1);
      // The account is at 95% of the 90% cutoff — it has quota left and is
      // being moved by policy, so telling the user it "is out of quota" would
      // be false (docs/150 req 6: a cutoff moves work, it does not stop it).
      expect(notices[0]?.text).toContain("reached your usage cutoff");
      expect(notices[0]?.text).not.toContain("out of quota");
      // Named by the user's own account labels — "acct_9f3e… → acct_1b77…"
      // would not tell them which subscription is now paying.
      expect(notices[0]?.text).toContain("Work");
      expect(notices[0]?.text).toContain("Personal");

      runner.dispose({ force: true });
    });
  });
});

/**
 * docs/150 — a DETACHED system turn (no WS connect, no viewer) has to rebuild
 * its runner from what the session persisted.
 *
 * `SessionRunnerRegistry.getOrCreate` applies its `defaultAgentId` argument only
 * when it CONSTRUCTS a runner, so a runner already in the registry — seeded with
 * the global default by container rescue or the warm pool — comes back carrying
 * that default. The WS path corrects this on connect; a wake turn never connects,
 * which is how a Codex session ran Claude (`reconcile-runner-agent.ts`). The
 * route half is read from the session row rather than held on the runner, so the
 * assertion here is that the detached turn keeps the pinned account instead of
 * re-selecting the provider's primary.
 */
describe("detached system turns reuse the persisted agent and route (docs/150)", () => {
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

  /**
   * A Codex session pinned to the SECOND Codex account, so "kept the persisted
   * route" and "re-ran the router" have different answers — the router would
   * name the first (primary) account.
   */
  function codexSessionPinnedToSecondary(): { primary: string; pinned: string } {
    const primary = accounts.create("codex", "Codex primary");
    const pinned = accounts.create("codex", "Codex secondary");
    for (const id of [primary.id, pinned.id]) {
      accounts.setAccountStatus("codex", id, "ready");
      seedAccountCredentials(root, "codex", id);
    }
    sessions.track(SESSION, "Detached", path.join(root, "workspaces", SESSION));
    sessions.setAgentId(SESSION, "codex");
    sessions.setProviderRoute(SESSION, "account", pinned.id);
    sessions.setAgentPinned(SESSION);
    return { primary: primary.id, pinned: pinned.id };
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
    const { primary, pinned } = codexSessionPinnedToSecondary();
    // Container rescue / the warm pool seeded this one with the global default.
    const stale = registry.getOrCreate(SESSION, path.join(root, "workspaces", SESSION), "claude");
    expect(stale.agentId).toBe("claude");

    await wakeSessionWithTurn(wakeDeps(), sessions.get(SESSION)!, { text: "a merged PR needs you" });

    // The turn runs the session's own provider...
    expect(registry.get(SESSION)?.agentId).toBe("codex");
    // ...on the account the session is pinned to, not the one the router would
    // pick for a fresh session.
    expect(sessions.get(SESSION)?.providerRouteId).toBe(pinned);
    expect(accounts.get("codex", pinned)?.lastUsedAt).toBeGreaterThan(0);
    expect(accounts.get("codex", primary)?.lastUsedAt).toBeUndefined();
  });

  it("recreates a disposed runner from the persisted agent, not defaultAgentId", async () => {
    const { primary, pinned } = codexSessionPinnedToSecondary();
    registry.getOrCreate(SESSION, path.join(root, "workspaces", SESSION), "codex");
    registry.dispose(SESSION, { force: true });
    expect(registry.get(SESSION)).toBeUndefined();

    await wakeSessionWithTurn(wakeDeps(), sessions.get(SESSION)!, { text: "a merged PR needs you" });

    expect(registry.get(SESSION)?.agentId).toBe("codex");
    expect(sessions.get(SESSION)?.providerRouteId).toBe(pinned);
    expect(accounts.get("codex", primary)?.lastUsedAt).toBeUndefined();
  });
});
