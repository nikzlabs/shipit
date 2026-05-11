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
     * service writes to this before disposing so the runner's `disposed`
     * lifecycle handler in app-lifecycle.ts skips `mgr.stop()`. Must be
     * present on the stub (rather than added at write time) so the
     * `"preserveComposeOnDispose" in runner` typeguard in recovery.ts
     * resolves true.
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

});

