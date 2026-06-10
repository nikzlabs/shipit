/**
 * Regression test for the "other tabs stale on turn completion" bug.
 *
 * On a normal turn end the active viewer learns `running=false` immediately
 * over its per-session WS (`session_status`), but OTHER tabs/viewers only learn
 * it from the global SSE `session_agent_finished` broadcast. That broadcast
 * used to be emitted AFTER the post-turn commit/PR flow (`runCommitAndPr`),
 * which can take several seconds — so a second/backgrounded tab kept showing the
 * session as running (and, because `computeAttentionReason` short-circuits to
 * null while "running", masked its true attention reason) for the whole commit
 * duration.
 *
 * The fix splits the two responsibilities in `turn-executor.ts`:
 *   - `broadcastFinishedIfIdle()` — the pure SSE UI signal — fires BEFORE the
 *     commit/PR work, so other tabs update promptly.
 *   - `signalIdleIfIdle()` (the runner "idle" event that drives auto-
 *     remediation) — stays AFTER the commit so a CI-fix / conflict-resolve turn
 *     never kicks off against a pre-commit tree.
 *
 * This test drives the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` path in-process (no Docker) with a fake agent and asserts
 * the ordering: `session_agent_finished` is broadcast before `autoCommit` is
 * invoked. Reverting the split (moving the SSE broadcast back after
 * `runCommitAndPr`) makes this bite.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";

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

describe("turn completion broadcast ordering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("broadcasts session_agent_finished (SSE) before the post-turn commit runs", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];

    // Shared call-order log: the SSE broadcast and the commit each push a marker
    // so we can assert their relative order rather than just that both happened.
    const order: string[] = [];
    const sseBroadcast = vi.fn((event: string) => {
      if (event === "session_agent_finished") order.push("finished");
    });
    const autoCommit = vi.fn(async () => {
      order.push("commit");
      return { commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false };
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: autoCommit as never,
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
        authManager: { startOAuthFlow: vi.fn() } as never,
        sseBroadcast,
        broadcastLog: vi.fn(),
        getSelectedModel: () => undefined,
      },
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch({ text: "do work" });
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "agent run");

    // Non-streaming turn end: agent_result flips running=false (agent-listeners),
    // then the process exits and the `done` handler runs drain → finished → commit.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitFor(() => !runner.running, "turn finished");
    await waitFor(() => order.includes("commit"), "commit ran");

    expect(sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });
    // The SSE UI signal must precede the (slow) commit so other tabs update promptly.
    expect(order).toEqual(["finished", "commit"]);

    runner.dispose({ force: true });
  });
});
