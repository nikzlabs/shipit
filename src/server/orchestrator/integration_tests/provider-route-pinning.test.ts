/**
 * docs/150 — route pinning and the fail-fast that must happen *before* it.
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
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { createTestDatabaseManager } from "./test-helpers.js";

class FakeRunner extends EventEmitter {
  agentId: AgentId = "claude";
  running = false;
  disposed = false;
  sessionId = "s1";
  sessionDir = "/tmp/s1";
  pushAgentEnv = () => {};
}

/** Seed real on-disk credentials for an account so provisioning has a source. */
function seedAccountCredentials(root: string, provider: AgentId, accountId: string): void {
  const base = path.join(root, "provider-accounts", provider, accountId);
  if (provider === "claude") {
    fs.mkdirSync(path.join(base, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(base, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(base, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, accessToken: "t" } }),
    );
  } else {
    fs.mkdirSync(path.join(base, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(base, ".codex", "auth.json"), JSON.stringify({ tokens: {} }));
  }
}

describe("provider route pinning (docs/150)", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let dbManager: ReturnType<typeof createTestDatabaseManager>;
  let savedSessionId: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-route-pin-"));
    store = new CredentialStore(root);
    accounts = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
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

  function readyAccount(provider: AgentId, label: string): string {
    const acct = accounts.create(provider, label);
    accounts.setAccountStatus(provider, acct.id, "ready");
    seedAccountCredentials(root, provider, acct.id);
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
});
