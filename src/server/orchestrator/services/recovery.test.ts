/**
 * Unit tests for `restartContainer` (Rescue session) — Phase 3.1+3.2.
 *
 * Verifies the full ordered flow:
 *   1. emit phase=stopping_stack
 *   2. serviceManager.stop()
 *   3. killAgentOnWorker (best-effort)
 *   4. runnerRegistry.dispose({force:true})
 *   5. emit phase=destroying_container
 *   6. containerManager.destroy()
 *   7. containerManager.reapOrphans()
 *   8. emit phase=creating_container
 *   9. runnerRegistry.getOrCreate() — creates a fresh runner
 *   10. emit phase=starting_stack and phase=ready (or phase=failed)
 *
 * See docs/124-session-rescue-and-diagnostics §3.1, §3.2.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { restartAgent, restartContainer } from "./recovery.js";
import { createOomCircuitBreaker } from "../oom-circuit-breaker.js";
import { createSessionLoopDetector } from "../loop-detector.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager } from "../service-manager.js";
import type { WsServerMessage, WsContainerRestarting } from "../../shared/types.js";

type StubRunner = SessionRunnerInterface & {
  killAgentOnWorker?: (opts?: { timeoutMs?: number }) => Promise<void>;
  serviceManager: ServiceManager | null;
  emitted: WsServerMessage[];
};

function makeStubRunner(sessionId: string, withServiceManager: boolean): StubRunner {
  const emitted: WsServerMessage[] = [];
  const stubMgr = withServiceManager
    ? Object.assign(new EventEmitter(), {
      _stopCalls: 0,
      stop: async function stop(this: { _stopCalls: number }) {
        this._stopCalls += 1;
      },
    }) as unknown as ServiceManager & { _stopCalls: number }
    : null;

  const runner = Object.assign(new EventEmitter(), {
    sessionId,
    sessionDir: "/tmp/x",
    workspaceDir: "/tmp/x",
    running: false,
    queueLength: 0,
    viewerCount: 0,
    lastSseEventAt: 0,
    disposed: false,
    wasInterrupted: false,
    /**
     * Mirrors the real ContainerSessionRunner field. The `restartAgent`
     * service writes `true` to this before disposing so the runner's
     * `disposed` lifecycle handler in app-lifecycle.ts skips `mgr.stop()`.
     * Initial value is `false` so the test starts in the same state as a
     * fresh production runner — assertions then verify `restartAgent`
     * flipped it before forcing the dispose.
     */
    preserveComposeOnDispose: false,
    serviceManager: stubMgr,
    killAgentOnWorkerCalls: 0,
    killAgentOnWorker: async function killAgentOnWorker(this: { killAgentOnWorkerCalls: number }) {
      this.killAgentOnWorkerCalls += 1;
    },
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    emitted,
    getAgent: () => null,
    setAgent: () => undefined,
    getTurnEventBuffer: () => [],
    attachViewer: () => undefined,
    detachViewer: () => undefined,
    waitForPreviewStatus: async () => undefined,
    previewStatusKnown: true,
    buildPreviewStatus: () => ({ type: "preview_status", running: false } as WsServerMessage),
    dispose: () => undefined,
  }) as unknown as StubRunner;

  return runner;
}

function makeStubContainerManager(opts: {
  hasExisting: boolean;
  finalState?: "running" | "missing" | "starting" | "pending";
  createError?: string;
}): SessionContainerManager {
  const order: { name: string; at: number }[] = [];
  let existing = opts.hasExisting
    ? ({ id: "old-container", status: "running" } as { id: string; status: "running" | "starting" | "stopped" | "stopping" | "missing" })
    : null;
  let createError: { error: string; at: number } | null = null;
  let destroyCalls = 0;
  let reapCalls = 0;

  // Drive the polling loop after destroy: depending on finalState, simulate
  // what the readiness window observes.
  const finalize = () => {
    if (opts.finalState === "missing") {
      createError = { error: opts.createError ?? "no image", at: Date.now() };
    } else if (opts.finalState === "running") {
      existing = { id: "new-container", status: "running" };
    } else if (opts.finalState === "starting") {
      existing = { id: "new-container", status: "starting" };
    }
    // "pending" → leave existing as-is
  };

  return {
    get: (sid: string) => {
      void sid;
      return existing as never;
    },
    destroy: async () => {
      destroyCalls += 1;
      order.push({ name: "destroy", at: Date.now() });
      existing = null;
      setTimeout(finalize, 50);
    },
    reapOrphans: async () => {
      reapCalls += 1;
      order.push({ name: "reapOrphans", at: Date.now() });
      // Also drive the post-create transition from the no-container path
      // (where destroy is skipped) — restartContainer always calls
      // reapOrphans as defense-in-depth, so it's a reliable seam.
      if (destroyCalls === 0) setTimeout(finalize, 50);
    },
    getLastCreateError: () => createError as never,
    clearCreateError: () => { createError = null; },
    _destroyCalls: () => destroyCalls,
    _reapCalls: () => reapCalls,
    _order: () => order,
  } as unknown as SessionContainerManager;
}

interface StubRegistry {
  _disposeCalls: { sessionId: string; force?: boolean }[];
  _getOrCreateCalls: number;
  _runners: Map<string, SessionRunnerInterface>;
}

function makeStubRegistry(initial: Record<string, SessionRunnerInterface>, freshRunner?: SessionRunnerInterface): SessionRunnerRegistry & StubRegistry {
  const disposeCalls: { sessionId: string; force?: boolean }[] = [];
  let getOrCreateCalls = 0;
  const runners = new Map<string, SessionRunnerInterface>(Object.entries(initial));
  return {
    get: (sid: string) => runners.get(sid),
    dispose: (sid: string, opts?: { force?: boolean }) => {
      disposeCalls.push({ sessionId: sid, force: opts?.force });
      runners.delete(sid);
    },
    getOrCreate: (sid: string) => {
      getOrCreateCalls += 1;
      const r = freshRunner ?? makeStubRunner(sid, false);
      runners.set(sid, r);
      return r;
    },
    _disposeCalls: disposeCalls,
    get _getOrCreateCalls() { return getOrCreateCalls; },
    _runners: runners,
  } as unknown as SessionRunnerRegistry & StubRegistry;
}

const sessionManager = {
  get: (sid: string) =>
    sid === "rescue-1"
      ? { id: sid, title: "t", workspaceDir: "/tmp/ws" }
      : undefined,
} as unknown as SessionManager;

describe("restartContainer (docs/124 §3.1, §3.2)", () => {
  it("emits phases in order and exercises the deep-restart flow", async () => {
    const oldRunner = makeStubRunner("rescue-1", true);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    const result = await restartContainer(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    expect(result).toMatchObject({ ok: true, newContainerState: "running", noContainer: false });

    // serviceManager.stop() was called before dispose
    expect((oldRunner.serviceManager as unknown as { _stopCalls: number })._stopCalls).toBe(1);

    // killAgentOnWorker was called (best-effort)
    expect((oldRunner as unknown as { killAgentOnWorkerCalls: number }).killAgentOnWorkerCalls).toBe(1);

    // dispose was forced
    expect(registry._disposeCalls).toEqual([{ sessionId: "rescue-1", force: true }]);

    // destroy + reapOrphans both called
    const cmAny = cm as unknown as { _destroyCalls: () => number; _reapCalls: () => number; _order: () => { name: string }[] };
    expect(cmAny._destroyCalls()).toBe(1);
    expect(cmAny._reapCalls()).toBe(1);
    // reap runs after destroy
    expect(cmAny._order().map((o) => o.name)).toEqual(["destroy", "reapOrphans"]);

    // A fresh runner was created
    expect(registry._getOrCreateCalls).toBe(1);

    // Phased progress: stopping_stack came before destroying_container,
    // which came before creating_container, ready was the final phase.
    const phases = oldRunner.emitted
      .filter((m): m is WsContainerRestarting => m.type === "container_restarting")
      .map((m) => m.phase);
    expect(phases).toContain("stopping_stack");
    expect(phases).toContain("destroying_container");
    expect(phases).toContain("creating_container");

    // The new runner gets `starting_stack` and `ready` after dispose, since
    // emitMessage on the old runner can't reach reconnecting viewers.
    const freshPhases = freshRunner.emitted
      .filter((m): m is WsContainerRestarting => m.type === "container_restarting")
      .map((m) => m.phase);
    expect(freshPhases).toContain("starting_stack");
    expect(freshPhases).toContain("ready");
  });

  it("emits phase=failed with reason=create_failed when creation errors", async () => {
    const oldRunner = makeStubRunner("rescue-1", false);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "missing", createError: "no docker daemon" });

    const result = await restartContainer(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    expect(result.newContainerState).toBe("missing");
    expect(result.error).toBe("no docker daemon");

    const failed = freshRunner.emitted
      .filter((m): m is WsContainerRestarting => m.type === "container_restarting")
      .find((m) => m.phase === "failed");
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({ phase: "failed", reason: "create_failed", message: "no docker daemon" });
  });

  it("surfaces lastInterruptError when the kill fails", async () => {
    const oldRunner = makeStubRunner("rescue-1", false);
    oldRunner.killAgentOnWorker = async () => { throw new Error("worker timeout"); };
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    await restartContainer(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    const sessionStatus = oldRunner.emitted.find(
      (m): m is Extract<WsServerMessage, { type: "session_status" }> => m.type === "session_status",
    );
    expect(sessionStatus).toBeDefined();
    expect(sessionStatus?.lastInterruptError).toMatch(/worker timeout/);
  });

  it("noContainer=true when no container existed", async () => {
    const oldRunner = makeStubRunner("rescue-1", false);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: false, finalState: "running" });

    const result = await restartContainer(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    expect(result.noContainer).toBe(true);
    // destroy is skipped, but reapOrphans still runs as defense in depth
    const cmAny = cm as unknown as { _destroyCalls: () => number; _reapCalls: () => number };
    expect(cmAny._destroyCalls()).toBe(0);
    expect(cmAny._reapCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// restartAgent (docs/127-restart-agent)
// ---------------------------------------------------------------------------

describe("restartAgent (docs/127)", () => {
  it("destroys and recreates the agent container WITHOUT touching compose", async () => {
    const oldRunner = makeStubRunner("rescue-1", true);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    const result = await restartAgent(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    expect(result).toMatchObject({ ok: true, newContainerState: "running" });

    // CRITICAL: serviceManager.stop() must NOT be called. The whole point of
    // restartAgent is to preserve the compose stack.
    expect((oldRunner.serviceManager as unknown as { _stopCalls: number })._stopCalls).toBe(0);

    // killAgentOnWorker is called (best-effort, same as restartContainer)
    expect((oldRunner as unknown as { killAgentOnWorkerCalls: number }).killAgentOnWorkerCalls).toBe(1);

    // preserveComposeOnDispose was set to true on the OLD runner before dispose
    // so app-lifecycle's disposed handler skips mgr.stop().
    expect((oldRunner as unknown as { preserveComposeOnDispose: boolean }).preserveComposeOnDispose).toBe(true);

    // dispose was forced
    expect(registry._disposeCalls).toEqual([{ sessionId: "rescue-1", force: true }]);

    // destroy WAS called for the agent container
    const cmAny = cm as unknown as { _destroyCalls: () => number; _reapCalls: () => number; _order: () => { name: string }[] };
    expect(cmAny._destroyCalls()).toBe(1);

    // CRITICAL: reapOrphans was NOT called — it would force-kill the running
    // compose containers (they carry `shipit-parent-session=<sid>`).
    expect(cmAny._reapCalls()).toBe(0);

    // A fresh runner was created
    expect(registry._getOrCreateCalls).toBe(1);
  });

  it("emits restarting_agent phase but not the compose phases", async () => {
    const oldRunner = makeStubRunner("restart-1", true);
    const freshRunner = makeStubRunner("restart-1", false);
    const registry = makeStubRegistry({ "restart-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    // Use a session id known to the sessionManager stub
    await restartAgent(
      {
        sessionManager: {
          get: (sid: string) =>
            sid === "restart-1"
              ? { id: sid, title: "t", workspaceDir: "/tmp/ws" }
              : undefined,
        } as unknown as SessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "restart-1",
    );

    const phases = [
      ...oldRunner.emitted,
      ...freshRunner.emitted,
    ]
      .filter((m): m is WsContainerRestarting => m.type === "container_restarting")
      .map((m) => m.phase);

    expect(phases).toContain("restarting_agent");
    expect(phases).toContain("destroying_container");
    expect(phases).toContain("creating_container");
    expect(phases).toContain("ready");
    // No compose phases
    expect(phases).not.toContain("stopping_stack");
    expect(phases).not.toContain("starting_stack");
  });

  it("emits phase=failed when the new container can't be created", async () => {
    const oldRunner = makeStubRunner("rescue-1", false);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({
      hasExisting: true,
      finalState: "missing",
      createError: "image pull failed",
    });

    const result = await restartAgent(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    expect(result.newContainerState).toBe("missing");
    expect(result.error).toBe("image pull failed");

    const failed = freshRunner.emitted
      .filter((m): m is WsContainerRestarting => m.type === "container_restarting")
      .find((m) => m.phase === "failed");
    expect(failed).toMatchObject({
      phase: "failed",
      reason: "create_failed",
      message: "image pull failed",
    });
  });

  it("surfaces lastInterruptError when kill fails but still proceeds", async () => {
    const oldRunner = makeStubRunner("rescue-1", false);
    oldRunner.killAgentOnWorker = async () => { throw new Error("worker EHOSTUNREACH"); };
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    const result = await restartAgent(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );

    // Restart still succeeded — kill failure is non-blocking by design.
    expect(result.newContainerState).toBe("running");

    const sessionStatus = oldRunner.emitted.find(
      (m): m is Extract<WsServerMessage, { type: "session_status" }> => m.type === "session_status",
    );
    expect(sessionStatus).toBeDefined();
    expect(sessionStatus?.lastInterruptError).toMatch(/worker EHOSTUNREACH/);
  });

  it("two consecutive restartAgent calls each preserve compose (idempotent chaining)", async () => {
    // Three runners total: r0 is the original, r1 is the first replacement
    // produced by the first restartAgent, r2 is the second replacement.
    // Each round MUST set preserveComposeOnDispose=true on the runner
    // being disposed (r0 in round 1, r1 in round 2) — that's the
    // invariant that lets the compose stack survive both restarts.
    const r0 = makeStubRunner("rescue-1", true);
    const r1 = makeStubRunner("rescue-1", true);
    const r2 = makeStubRunner("rescue-1", true);

    const handouts = [r1, r2];
    const disposeCalls: { sessionId: string; force?: boolean }[] = [];
    let getOrCreateCalls = 0;
    const runners = new Map<string, SessionRunnerInterface>([["rescue-1", r0]]);
    const registry = {
      get: (sid: string) => runners.get(sid),
      dispose: (sid: string, opts?: { force?: boolean }) => {
        disposeCalls.push({ sessionId: sid, force: opts?.force });
        runners.delete(sid);
      },
      getOrCreate: (sid: string) => {
        getOrCreateCalls += 1;
        const next = handouts.shift();
        if (!next) throw new Error("test ran out of runners");
        runners.set(sid, next);
        return next;
      },
    } as unknown as SessionRunnerRegistry;

    // Round 1: r0 → r1
    const cm1 = makeStubContainerManager({ hasExisting: true, finalState: "running" });
    const result1 = await restartAgent(
      {
        sessionManager,
        containerManager: cm1,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );
    expect(result1.newContainerState).toBe("running");
    expect((r0 as unknown as { preserveComposeOnDispose: boolean }).preserveComposeOnDispose).toBe(true);
    expect((r1 as unknown as { preserveComposeOnDispose: boolean }).preserveComposeOnDispose).toBe(false);

    // Round 2: r1 → r2 (chaining — the runner that was just adopted is
    // now being disposed again).
    const cm2 = makeStubContainerManager({ hasExisting: true, finalState: "running" });
    const result2 = await restartAgent(
      {
        sessionManager,
        containerManager: cm2,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
      },
      "rescue-1",
    );
    expect(result2.newContainerState).toBe("running");
    expect((r1 as unknown as { preserveComposeOnDispose: boolean }).preserveComposeOnDispose).toBe(true);
    expect((r2 as unknown as { preserveComposeOnDispose: boolean }).preserveComposeOnDispose).toBe(false);

    // NOTE: We intentionally do NOT assert on `serviceManager._stopCalls`
    // here. The stub runner's `dispose: () => undefined` never invokes
    // the real disposed-handler (which lives in app-lifecycle.ts and is
    // where `mgr.stop()` actually gates on the preserve flag). End-to-end
    // verification of "preserve flag → mgr.stop() not called" lives in
    // `integration_tests/service-manager-adoption.test.ts`, which
    // exercises the disposed handler directly with a real
    // ContainerSessionRunner.
    //
    // What this test DOES verify: `restartAgent` correctly sets the
    // preserve flag on whichever runner it's disposing — including the
    // runner adopted by a previous restartAgent (r1 in round 2). Without
    // that, the adoption handoff would silently fall back to "tear down
    // compose" on the second iteration.

    // Two destroys, two getOrCreates, two forced disposes; zero reaps
    // across both rounds (reaping by `shipit-parent-session` label would
    // kill the surviving compose containers).
    expect((cm1 as unknown as { _reapCalls: () => number })._reapCalls()).toBe(0);
    expect((cm2 as unknown as { _reapCalls: () => number })._reapCalls()).toBe(0);
    expect(disposeCalls).toHaveLength(2);
    expect(disposeCalls.every((c) => c.force === true)).toBe(true);
    expect(getOrCreateCalls).toBe(2);
  });

});

// ---------------------------------------------------------------------------
// Breaker + loop-detector reset on user-initiated restart
// ---------------------------------------------------------------------------
// Regression for Bug B: `restartContainer`/`restartAgent` reset the OOM
// breaker but used to leave the loop detector's independent event window
// intact. Since both gate the same runner factory — and the loop detector
// can re-`forceTrip` the breaker off its stale window — a restart that
// only cleared the breaker stayed sticky.

describe("recovery clears BOTH the OOM breaker and the loop detector", () => {
  it("restartContainer forgets the loop-detector window and un-trips the breaker", async () => {
    const oomBreaker = createOomCircuitBreaker();
    const loopDetector = createSessionLoopDetector();

    // Drive the loop: 3 container_started events trip the detector, which
    // force-trips the breaker — the exact state a session lands in after
    // the create/phantom-exit loop.
    loopDetector.recordContainerStarted("rescue-1");
    loopDetector.recordContainerStarted("rescue-1");
    const alert = loopDetector.recordContainerStarted("rescue-1");
    expect(alert).not.toBeNull();
    oomBreaker.forceTrip("rescue-1");
    expect(oomBreaker.isTripped("rescue-1")).toBe(true);
    expect(loopDetector.countInWindow("rescue-1")).toBe(3);

    const oldRunner = makeStubRunner("rescue-1", false);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    await restartContainer(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
        oomBreaker,
        loopDetector,
      },
      "rescue-1",
    );

    // Both gates must be clear, or the very next create the user asked for
    // would be refused (breaker) or instantly re-tripped (loop detector).
    expect(oomBreaker.isTripped("rescue-1")).toBe(false);
    expect(loopDetector.countInWindow("rescue-1")).toBe(0);
  });

  it("restartAgent forgets the loop-detector window and un-trips the breaker", async () => {
    const oomBreaker = createOomCircuitBreaker();
    const loopDetector = createSessionLoopDetector();

    loopDetector.recordContainerStarted("rescue-1");
    loopDetector.recordContainerStarted("rescue-1");
    loopDetector.recordContainerStarted("rescue-1");
    oomBreaker.forceTrip("rescue-1");
    expect(oomBreaker.isTripped("rescue-1")).toBe(true);
    expect(loopDetector.countInWindow("rescue-1")).toBe(3);

    const oldRunner = makeStubRunner("rescue-1", false);
    const freshRunner = makeStubRunner("rescue-1", false);
    const registry = makeStubRegistry({ "rescue-1": oldRunner }, freshRunner);
    const cm = makeStubContainerManager({ hasExisting: true, finalState: "running" });

    await restartAgent(
      {
        sessionManager,
        containerManager: cm,
        runnerRegistry: registry,
        defaultAgentId: "claude" as never,
        oomBreaker,
        loopDetector,
      },
      "rescue-1",
    );

    expect(oomBreaker.isTripped("rescue-1")).toBe(false);
    expect(loopDetector.countInWindow("rescue-1")).toBe(0);
  });
});

