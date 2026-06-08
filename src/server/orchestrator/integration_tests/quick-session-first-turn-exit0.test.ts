/**
 * Regression tests for docs/163 — the quick-session / warm-standby "first turn
 * silently never ran" bug.
 *
 * Symptom (distinct from docs/162): on the warm-reconnect dispatch path the
 * worker accepts `/agent/start`, env-prep + run-params are fast, `agent.run()`
 * fires — and yet the CLI exits with code 0 having produced NO `agent_result`:
 * no edits, no commit, no PR, and crucially NO error surfaced. The user's only
 * workaround was resending the prompt.
 *
 * Root cause of the MASKING: `emitErrorOnNoResult` was wired ONLY on the WS
 * turn path. The dispatched (quick / headless / child / CI-fix) path left it
 * unset, so the executor's `done` handler fell straight through to the normal
 * drain → commit → finished teardown and reported a *completed* turn for a turn
 * that did nothing.
 *
 * Fix: the dispatch path now treats a no-result exit as a non-completed turn —
 * it auto-retries once (the user's "resend" workaround, automated) and, if that
 * still produces nothing, surfaces a visible error via the agent's `error`
 * event instead of silently finishing.
 *
 * These tests drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` path in-process (no Docker) with a fake agent that we
 * make exit without a result, mirroring the wedged worker. Reverting either the
 * `onNoResultExit` hook (turn-executor.ts) or its dispatch wiring
 * (dispatched-turn.ts) makes these bite: only one agent is ever spawned and the
 * turn finishes with no error.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  removeAllListeners: () => this;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  return agent;
}

/** A minimal listenerDeps + turn deps wiring usable by executeAgentTurn. */
function makeDeps(agents: FakeAgent[], appended: unknown[]): {
  deps: SystemTurnDeps;
  sseBroadcast: ReturnType<typeof vi.fn>;
} {
  const sseBroadcast = vi.fn();
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
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
        append: (_sid: string, msg: unknown) => { appended.push(msg); },
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      authManager: { startOAuthFlow: vi.fn() } as never,
      sseBroadcast,
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  return { deps, sseBroadcast };
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

describe("quick-session first-turn exit-0 (docs/163)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("auto-retries once when the first dispatched turn exits with no result", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: unknown[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps } = makeDeps(agents, appended);
    runner.setSystemTurnDeps(deps);

    runner.dispatch({ text: "do work" });

    // First agent spawns.
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // The wedged worker case: the process exits 0 with no agent_result.
    agents[0]!.emit("done", 0);

    // The fix retries the turn with a fresh agent rather than reporting success.
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    // The retry is announced to the user (not silent).
    expect(messages.some((m) => m.type === "system_notice" && /retry/i.test(String(m.message)))).toBe(true);

    runner.dispose({ force: true });
  });

  it("surfaces a visible error (not a silent completed turn) when the retry also produces no result", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: { role?: string; isError?: boolean; text?: string }[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps, sseBroadcast } = makeDeps(agents, appended as unknown[]);
    runner.setSystemTurnDeps(deps);

    runner.dispatch({ text: "do work" });
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("done", 0); // no result → retry
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("done", 0); // retry ALSO produces no result → must surface an error

    // An error row is persisted to chat history — the failure is no longer silent.
    await waitFor(
      () => appended.some((m) => m.role === "assistant" && m.isError === true),
      "error chat row",
    );
    // The client gets a visible `error` message and the turn is finished + reset.
    expect(messages.some((m) => m.type === "error")).toBe(true);
    expect(sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });
    expect(runner.running).toBe(false);
    // Bounded: no third attempt.
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("does NOT retry when the first turn completes normally (agent_result before done)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: { role?: string; isError?: boolean }[] = [];
    const { deps, sseBroadcast } = makeDeps(agents, appended as unknown[]);
    runner.setSystemTurnDeps(deps);

    runner.dispatch({ text: "do work" });
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    // Healthy turn: a result, then the process exits.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitFor(() => sseBroadcast.mock.calls.some((c) => c[0] === "session_agent_finished"), "finished");

    // No retry, no error row.
    expect(agents).toHaveLength(1);
    expect(appended.some((m) => m.isError === true)).toBe(false);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  it("does NOT retry an auth-blocked turn (auth_required ends the turn legitimately)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: unknown[] = [];
    const { deps } = makeDeps(agents, appended);
    runner.setSystemTurnDeps(deps);

    runner.dispatch({ text: "do work" });
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    // Give any (incorrect) retry a chance to fire, then assert it did not.
    await flush();
    await flush();
    expect(agents).toHaveLength(1);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });
});
