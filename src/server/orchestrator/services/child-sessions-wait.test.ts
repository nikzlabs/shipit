/**
 * Unit tests for the resilient child-session readiness check (docs/182).
 *
 * `waitForChildIdle` is exercised here against a real (in-memory) SessionManager
 * and a stub runner whose `verifyRunningState()` we drive directly — that lets
 * us cover the durable / level-triggered outcomes (idle / error / archived /
 * pending) and, critically, the headless-reconcile regression (vector #5)
 * without a Docker container or a full app.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { SessionRunnerRegistry, type SessionRunnerInterface } from "../session-runner.js";
import { waitForChildIdle } from "./child-sessions.js";

/**
 * Minimal runner stub: only the members `waitForChildIdle` / `buildChildView`
 * actually read. `verifyRunningState` runs `verifyEffect` (e.g. a worker probe
 * that resets a stuck flag) then returns the current `running` value.
 */
class StubRunner extends EventEmitter {
  running = false;
  queueLength = 0;
  lastTurnErrored = false;
  disposed = false;
  verifyCalls = 0;
  verifyEffect?: () => void;
  async verifyRunningState(): Promise<boolean> {
    this.verifyCalls++;
    this.verifyEffect?.();
    return this.running;
  }
}

function asRunner(stub: StubRunner): SessionRunnerInterface {
  return stub as unknown as SessionRunnerInterface;
}

describe("waitForChildIdle (docs/182)", () => {
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  const PARENT = "parent_1";
  const CHILD = "child_1";

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    sessionManager.track(PARENT, "Parent", "/tmp/parent");
    sessionManager.track(CHILD, "Child", "/tmp/child");
    sessionManager.setParentSession(CHILD, PARENT);
  });

  /** Build a registry whose `getOrCreate`/`get` hand back the given stub. */
  function registryWith(stub: StubRunner): SessionRunnerRegistry {
    const registry = new SessionRunnerRegistry({ runnerFactory: () => asRunner(stub) });
    registry.getOrCreate(CHILD, "/tmp/child", "claude");
    return registry;
  }

  it("returns idle immediately when the runner is already idle", async () => {
    const stub = new StubRunner();
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("idle");
    expect(result.idle).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("returns the error outcome when the runner records a turn error", async () => {
    const stub = new StubRunner();
    stub.lastTurnErrored = true;
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("error");
    expect(result.idle).toBe(false);
    expect(result.child.status).toBe("error");
  });

  it("derives the error outcome from the persisted flag after a runner restart", async () => {
    // No runner in the registry (rebuilt-and-gone), but the session row records
    // the last turn errored — the durable fallback must still report `error`.
    sessionManager.setLastTurnErrored(CHILD, true);
    const registry = new SessionRunnerRegistry({ runnerFactory: () => asRunner(new StubRunner()) });
    const result = await waitForChildIdle(sessionManager, registry, PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("error");
  });

  it("returns archived when the child has been user-archived", async () => {
    const stub = new StubRunner();
    stub.running = true; // even a 'running' runner loses to a torn-down session
    sessionManager.archive(CHILD);
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("archived");
    expect(result.idle).toBe(true);
  });

  it("reconciles a stuck running=true on a viewerless child (vector #5)", async () => {
    // The runner believes it's running with ZERO viewers, but a worker probe
    // (modeled by verifyEffect) reports idle. The readiness check must call
    // verifyRunningState and resolve `idle` within the wait — not block for the
    // full timeout, which is the worst-case bug this feature targets.
    const stub = new StubRunner();
    stub.running = true;
    stub.verifyEffect = () => {
      stub.running = false; // worker says no agent is running — reset the flag
    };
    const start = Date.now();
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 60_000,
    });
    expect(stub.verifyCalls).toBe(1);
    expect(result.outcome).toBe("idle");
    // Resolved via the reconcile, not by waiting out the 60s timeout.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("returns pending when a bounded segment elapses with the child still running", async () => {
    const stub = new StubRunner();
    stub.running = true; // stays running across the probe and the segment
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 10_000,
      segmentMs: 40,
    });
    expect(result.outcome).toBe("pending");
    expect(result.pending).toBe(true);
    expect(result.idle).toBe(false);
  });

  it("times out (legacy single long-poll) when no segment is given and the child stays running", async () => {
    const stub = new StubRunner();
    stub.running = true;
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 40,
    });
    expect(result.outcome).toBe("timed-out");
    expect(result.timedOut).toBe(true);
  });

  it("wakes on the runner's idle event and re-derives the outcome", async () => {
    const stub = new StubRunner();
    stub.running = true;
    const waitPromise = waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    // Finish the turn and fire the fast-wakeup event after the wait has armed.
    await new Promise((r) => setTimeout(r, 20));
    stub.running = false;
    stub.emit("idle");
    const result = await waitPromise;
    expect(result.outcome).toBe("idle");
  });
});
