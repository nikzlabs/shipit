import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunnerRegistry, type SessionRunnerInterface } from "./session-runner.js";
import { SessionManager } from "./sessions.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionInfo } from "../shared/types.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "./wake-session.js";
import { takeQueueHold } from "./services/recovery.js";
import { makeDispatchTurnDeps, type FakeAgent } from "./integration_tests/dispatch-test-helpers.js";
import { createTestDatabaseManager } from "./integration_tests/test-helpers.js";
import type { DatabaseManager } from "../shared/database.js";

const SESSION = { id: "s1", workspaceDir: "/tmp/s1" } as SessionInfo;

function setup(container: { status: string } | undefined) {
  const agents: FakeAgent[] = [];
  const { deps } = makeDispatchTurnDeps(agents, []);
  const registry = new SessionRunnerRegistry({ onRunnerCreated: (r) => r.setSystemTurnDeps(deps) });
  const wakeDeps = {
    sessionManager: {} as SessionManager,
    runnerRegistry: registry,
    defaultAgentId: "claude" as const,
    containerManager: { get: () => container } as unknown as SessionContainerManager,
  };
  return { agents, registry, wakeDeps };
}

function markAwaitingContainer(runner: SessionRunnerInterface): void {
  Object.defineProperty(runner, "awaitingContainer", { get: () => true });
}

describe("wakeSessionWithTurn", () => {
  let runners: SessionRunnerInterface[] = [];
  afterEach(() => {
    for (const r of runners) r.dispose({ force: true });
    runners = [];
  });

  it("keeps a runner whose container is still being created (docs/321)", async () => {
    const { registry, wakeDeps } = setup(undefined);
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude");
    markAwaitingContainer(runner);
    runners.push(runner);

    await wakeSessionWithTurn(wakeDeps, SESSION, { text: "continue" });

    expect(runner.disposed).toBe(false);
    expect(registry.get("s1")).toBe(runner);
    expect(runner.running).toBe(true);
  });

  it("replaces a runner whose container is gone", async () => {
    const { registry, wakeDeps } = setup(undefined);
    const stale = registry.getOrCreate("s1", "/tmp/s1", "claude");

    await wakeSessionWithTurn(wakeDeps, SESSION, { text: "continue" });

    const fresh = registry.get("s1")!;
    runners.push(fresh);
    expect(stale.disposed).toBe(true);
    expect(fresh).not.toBe(stale);
  });

  it("releases the caller's hold just before its dispatch, so the wake runs ahead of held messages", async () => {
    const { registry, wakeDeps } = setup({ status: "running" });
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude");
    runners.push(runner);
    const hold = takeQueueHold(runner, { lease: true });
    runner.enqueue({ text: "sent while held", execution: "interactive" });

    const handle = await wakeSessionWithTurn(wakeDeps, SESSION, { text: "continue", releaseHold: hold });

    expect(handle.admitted).toBe("started");
    expect(runner.running).toBe(true);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["sent while held"]);
    expect(runner.postTurnWorkInFlight).toBe(false);
  });
});

describe("wakeSessionWithTurn while the agent waits for an answer (docs/322)", () => {
  let dbManager: DatabaseManager;
  afterEach(() => dbManager.close());

  function setup(awaiting: boolean) {
    dbManager = createTestDatabaseManager();
    const sessionManager = new SessionManager(dbManager);
    sessionManager.track("parent", "Parent", "/tmp/parent");
    sessionManager.setAwaitingAnswer("parent", awaiting);
    const getOrCreate = vi.fn(() => { throw new Error("booted a runner"); });
    const restoreWorkspace = vi.fn(async () => true);
    const deps = {
      sessionManager,
      runnerRegistry: { get: () => undefined, getOrCreate },
      defaultAgentId: "claude",
      restoreWorkspace,
    } as unknown as WakeSessionDeps;
    return { deps, sessionManager, getOrCreate, restoreWorkspace };
  }

  it("saves the wake and boots nothing for it (req 1, 8)", async () => {
    const { deps, sessionManager, getOrCreate, restoreWorkspace } = setup(true);
    const session = sessionManager.get("parent")!;

    const handle = await wakeSessionWithTurn(deps, session, {
      text: "Child PR #42 merged",
      deliveryId: "watch-1:1",
      onSettled: () => {},
    });

    expect(handle.admitted).toBe("queued");
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(restoreWorkspace).not.toHaveBeenCalled();
    expect(sessionManager.heldTurns("parent")).toEqual([
      expect.objectContaining({
        text: "Child PR #42 merged",
        automatic: true,
        systemTurn: true,
        deliveryId: "watch-1:1",
      }),
    ]);
  });

  it("saves the wake of a scheduled run the user stopped — a quota continuation's too (docs/324 req 33)", async () => {
    const { deps, sessionManager, getOrCreate } = setup(false);
    sessionManager.setScheduleRun("parent", "schedule-1", "run-1");
    sessionManager.setRunStoppedAt("parent", "2026-10-07T09:30:00.000Z");

    const handle = await wakeSessionWithTurn(deps, sessionManager.get("parent")!, { text: "Continue where you stopped." });

    expect(handle.admitted).toBe("queued");
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(sessionManager.heldTurns("parent").map((m) => m.text)).toEqual(["Continue where you stopped."]);
  });

  it("goes on to the runner when nothing is held", async () => {
    const { deps, sessionManager, getOrCreate } = setup(false);

    await expect(wakeSessionWithTurn(deps, sessionManager.get("parent")!, { text: "wake" }))
      .rejects.toThrow("booted a runner");
    expect(getOrCreate).toHaveBeenCalled();
    expect(sessionManager.heldTurns("parent")).toEqual([]);
  });

  it("releases the caller's hold when the wake is saved, so what it kept queued runs", async () => {
    dbManager = createTestDatabaseManager();
    const sessionManager = new SessionManager(dbManager);
    sessionManager.track("s1", "Session", "/tmp/s1");
    sessionManager.setAwaitingAnswer("s1", true);
    const { deps } = makeDispatchTurnDeps([], []);
    const registry = new SessionRunnerRegistry({ onRunnerCreated: (r) => r.setSystemTurnDeps(deps) });
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude");
    const hold = takeQueueHold(runner, { lease: true });
    runner.enqueue({ text: "sent while held", execution: "interactive" });

    const handle = await wakeSessionWithTurn(
      { sessionManager, runnerRegistry: registry, defaultAgentId: "claude" },
      sessionManager.get("s1")!,
      { text: "continue", releaseHold: hold },
    );

    expect(handle.admitted).toBe("queued");
    expect(sessionManager.heldTurns("s1").map((m) => m.text)).toEqual(["continue"]);
    expect(runner.systemTurnInProgress).toBe(false);
    expect(runner.running).toBe(true);
    expect(runner.messageQueue).toEqual([]);
    runner.dispose({ force: true });
  });
});
