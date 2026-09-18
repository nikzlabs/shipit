import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { SessionRunnerRegistry, type SessionRunnerInterface } from "../session-runner.js";
import { waitForChildIdle, registerMergeWatch } from "./child-sessions.js";
import { ServiceError } from "./types.js";

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
    sessionManager.setLastTurnErrored(CHILD, true);
    const registry = new SessionRunnerRegistry({ runnerFactory: () => asRunner(new StubRunner()) });
    const result = await waitForChildIdle(sessionManager, registry, PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("error");
  });

  it("returns archived when the child has been user-archived", async () => {
    const stub = new StubRunner();
    stub.running = true;
    sessionManager.archive(CHILD);
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("archived");
    expect(result.idle).toBe(true);
  });

  it("reconciles a stuck running=true on a viewerless child (vector #5)", async () => {
    const stub = new StubRunner();
    stub.running = true;
    stub.verifyEffect = () => {
      stub.running = false;
    };
    const start = Date.now();
    const result = await waitForChildIdle(sessionManager, registryWith(stub), PARENT, CHILD, {
      timeoutMs: 60_000,
    });
    expect(stub.verifyCalls).toBe(1);
    expect(result.outcome).toBe("idle");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("returns pending when a bounded segment elapses with the child still running", async () => {
    const stub = new StubRunner();
    stub.running = true;
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
    await new Promise((r) => setTimeout(r, 20));
    stub.running = false;
    stub.emit("idle");
    const result = await waitPromise;
    expect(result.outcome).toBe("idle");
  });
});

describe("registerMergeWatch — arm-time archived guards (docs/196)", () => {
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

  it("arms a watch when both parent and child are active", () => {
    const res = registerMergeWatch(sessionManager, PARENT, CHILD);
    expect(res).toMatchObject({ childId: CHILD, state: "armed", alreadyArmed: false });
    expect(sessionManager.getMergeWatch(CHILD)?.state).toBe("armed");
    expect(sessionManager.getMergeWatch(CHILD)?.parentSessionId).toBe(PARENT);
  });

  it("refuses to arm a watch whose PARENT is archived (would only ever be dropped on fire)", () => {
    sessionManager.archive(PARENT);
    expect(() => registerMergeWatch(sessionManager, PARENT, CHILD)).toThrow(/Parent session is archived/);
    expect(sessionManager.getMergeWatch(CHILD)).toBeUndefined();
  });

  it("propagates the 400 statusCode for an archived parent", () => {
    sessionManager.archive(PARENT);
    try {
      registerMergeWatch(sessionManager, PARENT, CHILD);
      throw new Error("expected registerMergeWatch to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).statusCode).toBe(400);
    }
  });

  it("refuses to arm a watch on an archived CHILD (existing guard, still holds)", () => {
    sessionManager.archive(CHILD);
    expect(() => registerMergeWatch(sessionManager, PARENT, CHILD)).toThrow(/Child session is archived/);
  });
});
