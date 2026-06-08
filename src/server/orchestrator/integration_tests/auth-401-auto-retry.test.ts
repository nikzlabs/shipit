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
    autoCommit: vi.fn().mockResolvedValue({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
    }),
    scheduleAutoPush: vi.fn(),
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
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
      authManager: { startOAuthFlow } as never,
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

    runner.dispatch({ text: "do work" });
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

  it("surfaces the sign-in card (no re-dispatch) when the heal fails — token revoked / rate-limited", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    // Heal can't make the token usable → fall back to the visible re-auth flow.
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const { deps, sseBroadcast, startOAuthFlow } = makeDeps(agents, ensureAgentTokenFresh);
    runner.setSystemTurnDeps(deps);

    runner.dispatch({ text: "do work" });
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    // The heal is attempted, fails, and the sign-in card surfaces.
    await waitFor(() => messages.some((m) => m.type === "auth_required"), "sign-in card surfaced");
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).toHaveBeenCalled();
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

    runner.dispatch({ text: "do work" });
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // First 401 → heal succeeds → re-dispatch.
    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "re-dispatched agent run");

    // The re-dispatched turn ALSO 401s. Because it's the auth-retry, the
    // executor must NOT heal+retry again — it surfaces the card.
    agents[1]!.emit("auth_required");
    agents[1]!.emit("done", 0);
    await waitFor(() => messages.some((m) => m.type === "auth_required"), "sign-in card on the retry");

    // The heal ran exactly once (first attempt only); no third agent spawned.
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(startOAuthFlow).toHaveBeenCalled();
    expect(agents).toHaveLength(2);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });
});
