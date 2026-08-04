/**
 * docs/150 req 14 — "When hard exhaustion happens partway through a turn,
 * ShipIt retries on the next eligible account regardless of what that turn has
 * already done."
 *
 * The provider ends the turn with `agent_result { error: "…usage limit…" }`.
 * Before that result can drain the queue or finalize the turn, the executor
 * re-runs it once on a fresh agent; the retry's own env-prep is what moves the
 * session onto another account (the spent one was benched by the listener a
 * moment earlier, req 7).
 *
 * These drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` path in-process with a fake agent, the same way the
 * docs/179 auth-retry tests do. Reverting the `retryOnNextAccount` branch in
 * `turn-executor.ts` makes them bite: the failed turn settles and the user is
 * left to resend.
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

function makeDeps(agents: FakeAgent[]): {
  deps: SystemTurnDeps;
  prepareAgentEnv: ReturnType<typeof vi.fn>;
  persistUserRow: ReturnType<typeof vi.fn>;
  autoCommit: ReturnType<typeof vi.fn>;
} {
  const prepareAgentEnv = vi.fn().mockResolvedValue(undefined);
  const persistUserRow = vi.fn();
  const autoCommit = vi.fn().mockResolvedValue({
    commitHash: null,
    parentHash: null,
    conflictedFiles: [],
    rebaseInProgress: false,
    secretFindings: [],
  });
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit,
    scheduleAutoPush: vi.fn(),
    prepareAgentEnv,
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
        append: persistUserRow,
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  return { deps, prepareAgentEnv, persistUserRow, autoCommit };
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

const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";

describe("same-turn quota failover (docs/150 req 14)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-runs the turn once on a fresh agent when the provider reports exhaustion", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, prepareAgentEnv } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");
    // The dying process held the spent account's token — it must not survive
    // into the retry and keep spending it.
    expect(agents[0]!.kill).toHaveBeenCalled();
    // The retry re-runs env-prep, which is what actually moves the session onto
    // the next eligible account (the spent one is already benched).
    expect(prepareAgentEnv).toHaveBeenCalledTimes(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    runner.dispose({ force: true });
  });

  // Bounded to one retry: if the second account is spent too, the turn fails
  // normally rather than marching down every account one process at a time.
  it("does not retry a second time when the retry is also exhausted", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  // An ordinary failure is the user's to see and act on; silently re-running it
  // on another account would burn a second subscription's quota for nothing.
  it("does not retry an error that is not quota exhaustion", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: "API Error: 500", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");

    expect(agents).toHaveLength(1);

    runner.dispose({ force: true });
  });

  // The failed attempt must not look like a completed turn: draining the queue
  // or committing there would tell the user (and the next queued turn) that a
  // turn we are about to re-run is over.
  it("leaves drain and commit to the retry, not the exhausted attempt", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const { deps, autoCommit } = makeDeps(agents);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    // The killed process's `done` must not run terminal work either.
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    expect(autoCommit).not.toHaveBeenCalled();
    expect(runner.running).toBe(true);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn finished");
    // Wait for the commit itself rather than assuming it lands in the same tick
    // `running` clears. It deliberately does not: the finished-SSE broadcast is
    // sequenced between them so other tabs update without waiting out the git
    // work (`broadcastFinishedIfIdle`). What this test pins is WHICH attempt
    // commits — asserted above for the exhausted one, here for the retry.
    await waitFor(() => autoCommit.mock.calls.length > 0, "retry committed");

    runner.dispose({ force: true });
  });
});
