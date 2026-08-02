/**
 * Regression tests for docs/179 — the "new session 401 once a day" bug, and
 * its fix: a runtime-401 auto-retry.
 *
 * Symptom: a session that started in the narrow window where the scheduled
 * OAuth refresher had fallen behind its safety margin (a run of 429 backoffs
 * ate the lead time) synced in a dying source token and 401'd on its very first
 * CLI call. The user saw a sign-in card for a turn that should just have run,
 * and had to re-authenticate + re-send despite already being signed in.
 *
 * Fix: when a turn's CLI emits `auth_required`, the executor first awaits a
 * single-flight source-token heal (`ensureAgentTokenFresh`). If the token
 * rotates back to usable, it re-dispatches the SAME turn once on a fresh agent —
 * no sign-in card, no manual re-send. Only when the heal genuinely fails (token
 * revoked / rate-limited) does the visible re-auth flow surface. The retry is
 * bounded: a second `auth_required` on the re-dispatched turn surfaces the card
 * rather than looping.
 *
 * These tests drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` → `wireAgentListeners` path in-process (no Docker) with a
 * fake agent we make emit `auth_required`, mirroring the stale-token 401.
 * Reverting either the `recoverAuth` re-dispatch (turn-executor.ts) or the
 * listener's `willRecoverAuth`/`recoverAuth` wiring (agent-listeners.ts) makes
 * these bite: the heal is never awaited and the card surfaces on the first 401.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import { testDispatch } from "./dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  return agent;
}

/**
 * Minimal `SystemTurnDeps` for the dispatch path, with the docs/179
 * `ensureAgentTokenFresh` healer injected. `healResult` controls whether the
 * heal reports the token usable (→ silent re-dispatch) or not (→ sign-in card).
 */
function makeDeps(
  agents: FakeAgent[],
  ensureAgentTokenFresh: SystemTurnDeps["ensureAgentTokenFresh"],
  resolveTurnAccountId?: SystemTurnDeps["resolveTurnAccountId"],
): {
  deps: SystemTurnDeps;
  sseBroadcast: ReturnType<typeof vi.fn>;
  startOAuthFlow: ReturnType<typeof vi.fn>;
} {
  const sseBroadcast = vi.fn();
  const startOAuthFlow = vi.fn();
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    ...(ensureAgentTokenFresh ? { ensureAgentTokenFresh } : {}),
    ...(resolveTurnAccountId ? { resolveTurnAccountId } : {}),
    autoCommit: vi.fn().mockResolvedValue({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
    }),
    scheduleAutoPush: vi.fn(),
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
        clearAgentSessionId: vi.fn(),
        setLastTurnErrored: vi.fn(),
        get: vi.fn(),
        track: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      } as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: vi.fn(),
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast,
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  return { deps, sseBroadcast, startOAuthFlow };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("runtime-401 auto-retry (docs/179)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("heals the token and silently re-dispatches the turn (no sign-in card) on a transient 401", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    // Heal reports the token usable again → the executor should re-dispatch.
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // The stale-token 401: the CLI demands auth, then the worker process exits.
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    // The heal is awaited and the SAME turn is re-dispatched on a fresh agent.
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(agents[0]!.kill).toHaveBeenCalled();

    // Quiet recovery: no sign-in card, no OAuth flow start.
    expect(messages.some((m) => m.type === "auth_required")).toBe(false);
    expect(startOAuthFlow).not.toHaveBeenCalled();

    // The retried turn completes normally and finalizes the turn.
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    // Bounded: exactly two agents (original + one retry).
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("surfaces a re-auth error pointing to Settings (no re-dispatch, no OAuth popup) when the heal fails — token revoked / rate-limited", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    // Heal can't make the token usable → fall back to the visible re-auth flow.
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps, sseBroadcast, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    // The heal is attempted, fails, and a re-auth error surfaces — pointing
    // the user to Settings rather than auto-launching the OAuth flow.
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).not.toHaveBeenCalled();
    // No re-dispatch — exactly one agent — and the turn is finished.
    expect(agents).toHaveLength(1);
    expect(sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  it("does not loop: a second auth_required on the re-dispatched turn surfaces the card instead of healing again", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // First 401 → heal succeeds → re-dispatch.
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");

    // The re-dispatched turn ALSO 401s. Because it's the auth-retry, the
    // executor must NOT heal+retry again — it surfaces the card.
    agents[1]!.emit("auth_required");
    agents[1]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error on the retry");

    // The heal ran exactly once (first attempt only); no third agent spawned.
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(agents).toHaveLength(2);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  it("finalizes visible first-attempt output before a healed auth retry that fails empty", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    let durableHistory: any[] = [];
    const history = deps.listenerDeps.chatHistoryManager as any;
    history.replaceInProgress = vi.fn((_sid: string, messages: any[]) => {
      durableHistory = [...durableHistory.filter((m) => !m.inProgress), ...messages];
    });
    history.finalizeInProgress = vi.fn(() => {
      durableHistory = durableHistory.map((m) => ({ ...m, inProgress: false }));
    });
    history.append = vi.fn((_sid: string, message: any) => { durableHistory.push(message); });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Visible before auth failed" }] });
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "healed retry");

    agents[1]!.emit("error", new Error("retry spawn failed"));
    await waitFor(() => durableHistory.some((m) => m.isError), "durable retry error");
    expect(durableHistory.map((m) => m.text)).toContain("Visible before auth failed");
    expect(durableHistory.some((m) => String(m.text).includes("retry spawn failed"))).toBe(true);
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);

    runner.dispose({ force: true });
  });
  // ---- the heal has to actually heal something (docs/179, 2026-08-02) ----
  //
  // Production ran six `auth healed` events across three sessions in six hours
  // with ZERO `[claude-oauth-refresh]` log lines beside them, and four of the
  // six were followed by a surfaced failure anyway. Every heal was a no-op:
  // `ensureFresh` short-circuited on the SOURCE token's `expiresAt`, which
  // still had margin, so the turn was re-dispatched ~120ms later on
  // byte-identical credentials. Two things make the retry mean something now —
  // the heal is forced (expiry is not evidence when a live 401 says otherwise),
  // and the source token is force-pushed into the session, bypassing the
  // per-turn sync-in guard that refuses to overwrite a dead-but-later-dated
  // copy.

  it("forces the heal rather than letting it short-circuit on source expiry", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2, "re-dispatched agent");

    expect(ensureAgentTokenFresh).toHaveBeenCalledWith("claude", undefined, { force: true });

    runner.dispose({ force: true });
  });

  it("force-pushes the source token into the session BEFORE the healed retry spawns", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(agents, ensureAgentTokenFresh);
    const repushed: { sessionId: string; agentId: AgentId; agentsAtCall: number }[] = [];
    deps.repushSessionAgentToken = (sessionId, agentId) => {
      repushed.push({ sessionId, agentId, agentsAtCall: agents.length });
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "healed retry");

    // Ordering matters: the retry's env-prep runs the guarded sync-in, so the
    // unconditional push has to land before the second agent is created.
    expect(repushed).toEqual([{ sessionId: "s1", agentId: "claude", agentsAtCall: 1 }]);

    runner.dispose({ force: true });
  });

  it("does not repush when the heal failed (no retry to prepare for)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps } = makeDeps(agents, vi.fn().mockResolvedValue(false));
    const repush = vi.fn();
    deps.repushSessionAgentToken = repush;
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");

    expect(repush).not.toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  // The other half of the incident: even when a viewer WAS attached, the
  // sign-in notice was emit-only, so it vanished on the next session switch or
  // reload. With no viewer attached — the production case, twice — it reached
  // nobody at all and the user was left with a prompt and no reply.
  it("leaves the surfaced sign-in notice in durable chat history", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents, vi.fn().mockResolvedValue(false));
    let durableHistory: any[] = [];
    const history = deps.listenerDeps.chatHistoryManager as any;
    history.replaceInProgress = vi.fn((_sid: string, messages: any[]) => {
      durableHistory = [...durableHistory.filter((m) => !m.inProgress), ...messages];
    });
    history.finalizeInProgress = vi.fn(() => {
      durableHistory = durableHistory.map((m) => ({ ...m, inProgress: false }));
    });
    history.append = vi.fn((_sid: string, message: any) => { durableHistory.push(message); });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => durableHistory.some((m) => m.isError), "durable sign-in notice");

    const notice = durableHistory.find((m) => m.isError);
    expect(String(notice.text)).toContain("Settings → Agents");
    // Finalized, so the next turn's `replaceInProgress` can't delete it.
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);
    // And exactly one error row — the generic "ended without a response" is
    // suppressed on the auth path rather than sitting beside it unpersisted.
    expect(durableHistory.filter((m) => m.isError)).toHaveLength(1);

    runner.dispose({ force: true });
  });

  // docs/150 — with several accounts per provider, the heal has to name the
  // account this turn is pinned to. Provider-wide, `ensureAgentTokenFresh`
  // refreshes every account and returns `results.every(Boolean)`, so a second
  // account that is revoked (or was never signed in) makes the aggregate false
  // and a healthy account's turn gets a sign-in card it did not need.
  it("heals the account the turn is pinned to, not the whole provider", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    // Stands in for the real healer: account-scoped calls heal, a
    // provider-wide call reports failure because a sibling account is revoked.
    const ensureAgentTokenFresh = vi.fn(
      async (_agentId: AgentId, accountId?: string) => accountId === "acct_healthy",
    );
    const { deps, startOAuthFlow } = makeDeps(
      agents,
      ensureAgentTokenFresh as unknown as SystemTurnDeps["ensureAgentTokenFresh"],
      () => "acct_healthy",
    );
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");
    expect(ensureAgentTokenFresh).toHaveBeenCalledWith("claude", "acct_healthy", { force: true });
    // Quiet recovery — the revoked sibling never entered the picture.
    expect(startOAuthFlow).not.toHaveBeenCalled();

    runner.dispose({ force: true });
  });

  // docs/150 — a session pinned to a reserved route (`claude-api-key`,
  // `claude-env-oauth`) has no account token of its own. Rotating every
  // *subscription* account and reporting the aggregate answers a question
  // nobody asked: a bad API key would read as healed because the subscriptions
  // are fine. Don't heal; let the 401 surface.
  it("does not heal a reserved-route turn off other accounts' tokens", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps(
      agents,
      ensureAgentTokenFresh,
      // Pinned to `claude-api-key` — not an account.
      () => undefined,
    );
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "error"), "re-auth error surfaced");

    // No OAuth refresh was attempted, and no silent re-dispatch happened.
    expect(ensureAgentTokenFresh).not.toHaveBeenCalled();
    expect(agents).toHaveLength(1);

    runner.dispose({ force: true });
  });

  it("clears a rejected resume id and re-dispatches the same turn once as a fresh conversation", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents, undefined);
    let agentSessionId: string | undefined = "rejected-resume-id";
    const sessionManager = deps.listenerDeps.sessionManager as any;
    sessionManager.get = vi.fn(() => ({ id: "s1", agentId: "claude", agentSessionId }));
    sessionManager.clearAgentSessionId = vi.fn(() => { agentSessionId = undefined; });
    sessionManager.setAgentSessionId = vi.fn((_sid: string, next: string) => { agentSessionId = next; });
    deps.buildRunParams = vi.fn(async () => ({
      prompt: "do work",
      cwd: "/tmp/s1",
      ...(agentSessionId ? { sessionId: agentSessionId } : {}),
    }));
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "resumed run");
    expect(agents[0]!.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "rejected-resume-id" }));

    agents[0]!.emit("log", "stderr", "No conversation found with session ID: rejected-resume-id");
    agents[0]!.emit("done", 1);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "fresh-conversation retry");
    expect(sessionManager.clearAgentSessionId).toHaveBeenCalledWith("s1");
    expect(agents[1]!.run.mock.calls[0]![0]).not.toHaveProperty("sessionId");

    agents[1]!.emit("event", { type: "agent_init", agentId: "claude", sessionId: "fresh-session-id", tools: [] });
    agents[1]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Recovered" }] });
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "fresh-session-id" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "recovered turn finished");
    expect(agentSessionId).toBe("fresh-session-id");
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("keeps first-attempt output durable when the fresh-conversation retry fails empty", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents, undefined);
    let agentSessionId: string | undefined = "rejected-resume-id";
    let durableHistory: any[] = [];
    const sessionManager = deps.listenerDeps.sessionManager as any;
    sessionManager.get = vi.fn(() => ({ id: "s1", agentId: "claude", agentSessionId }));
    sessionManager.clearAgentSessionId = vi.fn(() => { agentSessionId = undefined; });
    sessionManager.setAgentSessionId = vi.fn((_sid: string, next: string) => { agentSessionId = next; });
    const history = deps.listenerDeps.chatHistoryManager as any;
    history.replaceInProgress = vi.fn((_sid: string, messages: any[]) => {
      durableHistory = [...durableHistory.filter((m) => !m.inProgress), ...messages];
    });
    history.finalizeInProgress = vi.fn(() => {
      durableHistory = durableHistory.map((m) => ({ ...m, inProgress: false }));
    });
    history.append = vi.fn((_sid: string, message: any) => { durableHistory.push(message); });
    deps.buildRunParams = vi.fn(async () => ({
      prompt: "do work",
      cwd: "/tmp/s1",
      ...(agentSessionId ? { sessionId: agentSessionId } : {}),
    }));
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "resumed run");
    agents[0]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Work already shown" }] });
    agents[0]!.emit("log", "stderr", "No conversation found with session ID: rejected-resume-id");
    agents[0]!.emit("done", 1);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "fresh retry");

    // The bounded retry fails before producing any content. Its error-path
    // replace only touches in-progress rows, so the finalized first attempt is
    // still present when history is reloaded from durable storage.
    agents[1]!.emit("error", new Error("fresh retry failed"));
    await waitFor(() => durableHistory.some((m) => m.isError), "durable retry error");
    expect(durableHistory.map((m) => m.text)).toContain("Work already shown");
    expect(durableHistory.some((m) => String(m.text).includes("fresh retry failed"))).toBe(true);
    expect(durableHistory.every((m) => !m.inProgress)).toBe(true);
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });
});
