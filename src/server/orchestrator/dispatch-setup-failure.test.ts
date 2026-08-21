/**
 * planning#265 — a dispatched turn that throws during SETUP must settle, restore the
 * runner, and release the queue.
 *
 * docs/240 made completion a settlement resolved exactly once from a `finally`
 * — but that `finally` lives inside `executeAgentTurn`, which only owns the turn
 * once setup has succeeded. `runDispatchedTurn` does real work first (steer-gate
 * inputs, attachment resolution, `createAgent`), and `dispatchOnRunner`
 * fire-and-forgot the whole thing with no rejection handler. A throw there left
 * the handle unresolved, `running` stuck true, and — the reason this blocks
 * docs/239 — planning#260's `isDeliveryInFlight` reading a live runner as "still
 * pending", so the watch was never retried and never reached `delivery-failed`.
 *
 * The last test is the one that matters: it drives the real MergeWatchManager
 * against a real `SessionRunner` whose dispatch dies at setup, and asserts the
 * supervisor takes it all the way to `delivery-failed` in-process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager, MAX_DELIVERY_ATTEMPTS } from "./merge-watch.js";
import { SessionRunner } from "./session-runner.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import type { PrTerminalStateInfo } from "./pr-status-poller.js";
import { testDispatch, makeDispatchTurnDeps, waitForTurn, flushTurn, type FakeAgent } from "./integration_tests/dispatch-test-helpers.js";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

describe("dispatch setup failure (planning#265)", () => {
  let runner: SessionRunner;

  beforeEach(() => { runner = makeRunner(); });
  afterEach(() => { runner.dispose({ force: true }); vi.restoreAllMocks(); });

  it("settles `errored` and clears `running` when agent creation throws", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.agentFactory = () => { throw new Error("container unreachable"); };
    runner.setSystemTurnDeps(deps);

    const handle = runner.dispatch(testDispatch({ text: "wake up", systemTurn: true }));
    const outcome = await handle.settled;

    expect(outcome.status).toBe("errored");
    expect(outcome.errored).toBe(true);
    expect(outcome.detail).toContain("container unreachable");
    expect(runner.running).toBe(false);
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("settles `errored` when setup throws before any agent is created", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    // `steerInputs` is consulted at the very top of `runDispatchedTurn`, before
    // attachments are resolved and long before a listener is wired.
    deps.steerInputs = () => { throw new Error("credential refresh failed"); };
    runner.setSystemTurnDeps(deps);

    const outcome = await runner.dispatch(testDispatch({ text: "wake up" })).settled;

    expect(outcome.status).toBe("errored");
    expect(outcome.detail).toContain("credential refresh failed");
    expect(agents).toHaveLength(0);
    expect(runner.running).toBe(false);
  });

  it("leaves the runner usable — a later dispatch runs normally", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let failNext = true;
    const good = deps.agentFactory;
    deps.agentFactory = (agentId) => {
      if (failNext) { failNext = false; throw new Error("boom"); }
      return good(agentId);
    };
    runner.setSystemTurnDeps(deps);

    await runner.dispatch(testDispatch({ text: "first" })).settled;
    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => agents.length === 1, "second turn started");
    expect(runner.running).toBe(true);
  });

  it("releases the queue: an entry queued behind the failed turn still runs", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let failNext = true;
    const good = deps.agentFactory;
    deps.agentFactory = (agentId) => {
      if (failNext) { failNext = false; throw new Error("boom"); }
      return good(agentId);
    };
    runner.setSystemTurnDeps(deps);

    // The first dispatch flips `running` synchronously, so the second is queued.
    runner.dispatch(testDispatch({ text: "doomed" }));
    runner.dispatch(testDispatch({ text: "queued behind it" }));
    expect(runner.queueLength).toBe(1);

    await waitForTurn(() => agents.length === 1, "queued turn started after the failure");
    expect(runner.queueLength).toBe(0);
  });
});

/**
 * The compounding failure the issue is really about: without the settlement,
 * planning#260's supervisor treats a dead dispatch as permanently in flight.
 */
describe("a merge-watch delivery whose dispatch dies at setup reaches delivery-failed (planning#265)", () => {
  it("is retried to `delivery-failed` with no orchestrator restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = new DatabaseManager(":memory:");
    const sessionManager = new SessionManager(db);
    const chatHistoryManager = new ChatHistoryManager(db);

    sessionManager.track("parent", "Parent", "/tmp/parent");
    sessionManager.track("child", "Child", "/tmp/child");
    sessionManager.setParentSession("child", "parent");

    // A REAL runner whose dispatched-turn setup always throws — the exact shape
    // of "the parent's container won't resume".
    const parentRunner = new SessionRunner({
      sessionId: "parent",
      sessionDir: "/tmp/parent",
      defaultAgentId: "claude" as AgentId,
    });
    const setupDeps = {
      ...makeDispatchTurnDeps([], []).deps,
      agentFactory: () => { throw new Error("worker unreachable"); },
    } as SystemTurnDeps;
    parentRunner.setSystemTurnDeps(setupDeps);

    const registry = {
      get: (id: string) => (id === "parent" ? (parentRunner as unknown as SessionRunnerInterface) : undefined),
      getOrCreate: () => parentRunner as unknown as SessionRunnerInterface,
      dispose: () => { /* the wake path never disposes a live runner here */ },
    } as unknown as SessionRunnerRegistry;

    const manager = new MergeWatchManager({
      sessionManager,
      runnerRegistry: registry,
      chatHistoryManager,
      defaultAgentId: "claude",
    });

    sessionManager.setMergeWatch("child", {
      parentSessionId: "parent",
      state: "armed",
      registeredAt: new Date().toISOString(),
    });

    const merged: PrTerminalStateInfo = {
      sessionId: "child",
      outcome: "merged",
      prNumber: 7,
      prUrl: "https://github.com/o/r/pull/7",
      prTitle: "Foundation",
      branch: "shipit/child",
    };
    await manager.handleChildPrTerminal(merged);
    await flushTurn();

    // Attempt 1 failed and released the in-flight marker (pre-fix it stayed set
    // forever, because the settlement never fired).
    expect(sessionManager.getMergeWatch("child")?.deliveryAttempts).toBe(1);
    expect(sessionManager.getMergeWatch("child")?.state).toBe("merge-observed");

    // Drive the supervisor past the backoff until the budget is spent.
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) {
      vi.setSystemTime(Date.now() + 30 * 60_000);
      await manager.retryStalledDeliveries();
      await flushTurn();
    }

    expect(sessionManager.getMergeWatch("child")?.state).toBe("delivery-failed");
    const failureCard = chatHistoryManager
      .load("parent")
      .map((m) => m.childMerged)
      .find((c) => c?.deliveryFailure);
    expect(failureCard?.deliveryFailure?.error).toContain("worker unreachable");

    manager.stopRetryLoop();
    parentRunner.dispose({ force: true });
    db.close();
    vi.useRealTimers();
  });
});
