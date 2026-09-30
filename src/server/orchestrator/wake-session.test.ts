import { describe, it, expect, afterEach } from "vitest";
import { SessionRunnerRegistry, type SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionInfo } from "../shared/types.js";
import { wakeSessionWithTurn } from "./wake-session.js";
import { takeQueueHold } from "./services/recovery.js";
import { makeDispatchTurnDeps, type FakeAgent } from "./integration_tests/dispatch-test-helpers.js";

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
