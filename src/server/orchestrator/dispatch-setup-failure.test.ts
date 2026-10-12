import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { MergeWatchManager, MAX_DELIVERY_ATTEMPTS } from "./merge-watch.js";
import { SessionRunner } from "./session-runner.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import { storeOnlyInbox } from "./session-inbox-test-helpers.js";
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

    runner.dispatch(testDispatch({ text: "doomed" }));
    runner.dispatch(testDispatch({ text: "queued behind it" }));
    expect(runner.queueLength).toBe(1);

    await waitForTurn(() => agents.length === 1, "queued turn started after the failure");
    expect(runner.queueLength).toBe(0);
  });
});

// A parent's watch stores its notice in the inbox and has no delivery to fail
// (docs/328-session-message-inbox req 6), so the wake turn under test is a session's own.
describe("a merge-watch delivery whose dispatch dies at setup reaches delivery-failed (planning#265)", () => {
  it("is retried to `delivery-failed` with no orchestrator restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = new DatabaseManager(":memory:");
    const sessionManager = new SessionManager(db);
    const chatHistoryManager = new ChatHistoryManager(db);

    sessionManager.track("s1", "Chained work", "/tmp/s1");

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const setupDeps = {
      ...makeDispatchTurnDeps([], []).deps,
      agentFactory: () => { throw new Error("worker unreachable"); },
    } as SystemTurnDeps;
    runner.setSystemTurnDeps(setupDeps);

    const registry = {
      get: (id: string) => (id === "s1" ? (runner as unknown as SessionRunnerInterface) : undefined),
      getOrCreate: () => runner as unknown as SessionRunnerInterface,
      dispose: () => { /* unused */ },
    } as unknown as SessionRunnerRegistry;

    const manager = new MergeWatchManager({
      sessionManager,
      runnerRegistry: registry,
      chatHistoryManager,
      sessionInbox: storeOnlyInbox(db).sessionInbox,
      defaultAgentId: "claude",
    });

    const now = new Date().toISOString();
    sessionManager.setSelfMergeWatch("s1", {
      kind: "self",
      parentSessionId: "s1",
      watchId: "watch-1",
      prNumber: 7,
      state: "merge-observed",
      registeredAt: now,
      observedAt: now,
      mergedPr: {
        prNumber: 7,
        prUrl: "https://github.com/o/r/pull/7",
        prTitle: "Foundation",
        branch: "shipit/s1",
      },
    });

    await manager.handleSelfMerge("s1");
    await flushTurn();

    expect(sessionManager.getSelfMergeWatch("s1")?.deliveryAttempts).toBe(1);
    expect(sessionManager.getSelfMergeWatch("s1")?.state).toBe("merge-observed");

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 1; i++) {
      vi.setSystemTime(Date.now() + 30 * 60_000);
      await manager.retryStalledDeliveries();
      await flushTurn();
    }

    expect(sessionManager.getSelfMergeWatch("s1")?.state).toBe("delivery-failed");
    expect(sessionManager.getSelfMergeWatch("s1")?.lastDeliveryError).toContain("worker unreachable");

    manager.stopRetryLoop();
    runner.dispose({ force: true });
    db.close();
    vi.useRealTimers();
  });
});
