/**
 * Recovery from a session container that fails to come up.
 *
 * The reported symptom was a session that "doesn't start or stops" with
 * `Error: connect ECONNREFUSED 0.0.0.0` in chat, leaving the user to type
 * "continue" — and even then the original prompt was gone, so the fresh agent
 * had no idea what it was continuing.
 *
 * `0.0.0.0` is the runner's placeholder worker URL (`http://0.0.0.0:0`), which
 * it holds between construction and `setWorkerUrl()`. Node prints
 * `connect ECONNREFUSED 0.0.0.0` for it (the `:0` is omitted). Reaching the
 * POST with the placeholder still set requires the worker-ready gate to have
 * been resolved by `dispose()` rather than by `setWorkerUrl()`, which happens
 * on exactly two paths — both covered here:
 *
 *   1. Container creation genuinely failed. Now retried before giving up.
 *   2. The missing-container reconciler force-disposed a runner whose creation
 *      was still IN FLIGHT (the runner is registered synchronously, but the
 *      manager's map entry only appears partway through `createContainer`).
 *
 * Plus the diagnosability half: when creation does fail terminally, the parked
 * turn must report the real cause, not the placeholder address.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRunnerFactory, createMissingContainerReconciler } from "./app-lifecycle.js";
import { ContainerSessionRunner, WorkerUnavailableError } from "./container-session-runner.js";
import type { SessionContainerManager, SessionContainer } from "./session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "./session-runner.js";
import type { AgentId, AgentRunParams, WsServerMessage, LogSource } from "../shared/types.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

interface FakeManager {
  mgr: SessionContainerManager;
  createCalls: number;
  destroyCalls: string[];
  recordedErrors: { sessionId: string; error: string }[];
}

/**
 * A container manager whose `create` fails for the first `failures` calls and
 * then succeeds. `create` is the only interesting seam — everything else is
 * the minimum `createContainerForRunner` touches.
 */
function makeFakeManager(opts: {
  failures: number;
  error?: Error;
  neverSucceeds?: boolean;
}): FakeManager {
  const state = { createCalls: 0, destroyCalls: [] as string[], recordedErrors: [] as { sessionId: string; error: string }[] };
  const mgr = {
    get: () => undefined,
    isStandby: () => false,
    claimStandby: () => undefined,
    destroy: async (sessionId: string) => { state.destroyCalls.push(sessionId); },
    // A constant is enough here: `create` is faked, so nothing ever compares
    // the snapshot. Cancellation itself is covered in `app-lifecycle.test.ts`
    // and `container-lifecycle.test.ts`.
    teardownEpoch: () => 0,
    prepareOverlaySpecs: async () => [],
    preparePnpmStore: () => undefined,
    buildConfigForWorkspace: () => ({ sessionId: "s1" }),
    create: async (): Promise<SessionContainer> => {
      state.createCalls++;
      if (opts.neverSucceeds || state.createCalls <= opts.failures) {
        throw opts.error ?? new Error("Container has no IP on network shipit-net");
      }
      return { workerUrl: "http://172.18.0.9:9100", status: "running" } as SessionContainer;
    },
    recordCreateError: (sessionId: string, error: string) => { state.recordedErrors.push({ sessionId, error }); },
    clearCreateError: () => undefined,
  } as unknown as SessionContainerManager;
  return {
    mgr,
    get createCalls() { return state.createCalls; },
    get destroyCalls() { return state.destroyCalls; },
    get recordedErrors() { return state.recordedErrors; },
  } as FakeManager;
}

function makeFakeRegistry(runners: Map<string, SessionRunnerInterface>): SessionRunnerRegistry {
  return {
    ids: () => [...runners.keys()],
    get: (id: string) => runners.get(id),
  } as unknown as SessionRunnerRegistry;
}

/** Minimal runner stand-in for the reconciler, with a settable `awaitingContainer`. */
function makeReconcilerRunner(sessionId: string, awaitingContainer: boolean): {
  runner: SessionRunnerInterface;
  disposeCalls: { force?: boolean }[];
  emitted: WsServerMessage[];
} {
  const disposeCalls: { force?: boolean }[] = [];
  const emitted: WsServerMessage[] = [];
  const runner = Object.assign(new EventEmitter(), {
    sessionId,
    sessionDir: "/tmp/x",
    disposed: false,
    running: false,
    awaitingContainer,
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    dispose: (o?: { force?: boolean }) => { disposeCalls.push(o ?? {}); },
  }) as unknown as SessionRunnerInterface;
  return { runner, disposeCalls, emitted };
}

// --------------------------------------------------------------------------
// Harness — drive the real `createContainerForRunner` through the factory
// --------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  // `createContainerForRunner` stats the workspace and treats a missing one as
  // a terminal (non-retryable) failure, so it has to actually exist.
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-create-recovery-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function startRunner(mgr: SessionContainerManager, broadcastLog?: (sid: string, source: LogSource, text: string) => void): ContainerSessionRunner {
  const factory = buildRunnerFactory({
    deps: {},
    containerManager: mgr,
    credentialsDir: TEST_CREDENTIALS_DIR,
    runtimeMode: "containerized",
    ...(broadcastLog ? { broadcastLog } : {}),
  });
  return factory!({
    sessionId: "s1",
    sessionDir: workspaceDir,
    defaultAgentId: "claude" as AgentId,
  }) as ContainerSessionRunner;
}

/** Wait until `predicate()` holds, advancing past the retry backoff timers. */
async function settle(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// --------------------------------------------------------------------------
// 1. Container creation retries instead of stranding the user's turn
// --------------------------------------------------------------------------

describe("container creation retries transient failures", () => {
  it("recovers on a retry and hands the runner a real worker URL", async () => {
    // The failure the user hits: creation dies once (busy daemon, IP
    // allocation race, health-check miss). Before, this disposed the runner
    // and the queued turn dialed the placeholder. Now attempt 2 succeeds and
    // the turn — parked on the worker-ready gate — just starts a bit late.
    const fake = makeFakeManager({ failures: 1 });
    const runner = startRunner(fake.mgr);

    await settle(() => fake.createCalls >= 2, "second create attempt");
    await runner.whenWorkerReady();

    expect(runner.getWorkerUrl()).toBe("http://172.18.0.9:9100");
    expect(runner.disposed).toBe(false);
    // A recovered create must not leave a create error behind for the health
    // strip to show — the session is healthy.
    expect(fake.recordedErrors).toEqual([]);
    runner.dispose({ force: true });
  });

  it("keeps the turn's parked gate unresolved while retrying", async () => {
    // The gate is what makes the retry invisible: as long as it stays
    // unresolved, `_startAgentViaProxy` waits rather than failing. If a retry
    // resolved it early the turn would proceed against no worker.
    const fake = makeFakeManager({ failures: 1 });
    const runner = startRunner(fake.mgr);

    let ready = false;
    // eslint-disable-next-line no-restricted-syntax -- observing the gate without awaiting it is the point
    void runner.whenWorkerReady().then(() => { ready = true; });

    await settle(() => fake.createCalls >= 1, "first create attempt");
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toBe(false);
    expect(runner.awaitingContainer).toBe(true);

    await settle(() => ready, "gate resolved after successful retry");
    expect(runner.awaitingContainer).toBe(false);
    runner.dispose({ force: true });
  });

  it("gives up after the attempt budget and disposes the runner", async () => {
    const fake = makeFakeManager({ failures: 0, neverSucceeds: true });
    const runner = startRunner(fake.mgr);

    await settle(() => runner.disposed, "runner disposed after budget exhausted");
    expect(fake.createCalls).toBe(3);
    expect(fake.recordedErrors).toHaveLength(1);
    expect(fake.recordedErrors[0]?.error).toMatch(/no IP on network/);
  });

  it("does not retry a deterministic failure", async () => {
    // A missing workspace can't be fixed by trying again; retrying only
    // delays the error the user needs to act on.
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    const fake = makeFakeManager({ failures: 0 });
    const runner = startRunner(fake.mgr);

    await settle(() => runner.disposed, "runner disposed without retry");
    expect(fake.createCalls).toBe(0);
    expect(fake.recordedErrors[0]?.error).toMatch(/workspace is missing/i);
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  it("destroys leftovers before each retry so the next attempt starts clean", async () => {
    const fake = makeFakeManager({ failures: 1 });
    const runner = startRunner(fake.mgr);

    await settle(() => fake.createCalls >= 2, "second create attempt");
    // First attempt: no destroy (nothing existed). Retry: destroy first.
    expect(fake.destroyCalls).toEqual(["s1"]);
    runner.dispose({ force: true });
  });
});

// --------------------------------------------------------------------------
// 2. A terminal failure reports its real cause, not the placeholder address
// --------------------------------------------------------------------------

/** Start an agent turn and return whatever it rejected with (null if it didn't). */
async function captureRejection(runner: ContainerSessionRunner, agentId: AgentId): Promise<unknown> {
  try {
    await runner._startAgentViaProxy(agentId, {} as AgentRunParams);
    return null;
  } catch (err) {
    return err;
  }
}

describe("a turn parked on a failed container reports the real cause", () => {
  it("throws the recorded creation error instead of ECONNREFUSED 0.0.0.0", async () => {
    const fake = makeFakeManager({
      failures: 0,
      neverSucceeds: true,
      error: new Error("no space left on device"),
    });
    const runner = startRunner(fake.mgr);
    await settle(() => runner.disposed, "runner disposed after budget exhausted");

    // Exactly what the user's turn does: it was parked on the worker-ready
    // gate, dispose released it, and it now tries to start the agent.
    const err = await captureRejection(runner, "claude" as AgentId);

    expect(err).toBeInstanceOf(WorkerUnavailableError);
    expect((err as Error).message).toContain("no space left on device");
    expect((err as Error).message).not.toMatch(/ECONNREFUSED|0\.0\.0\.0/);
  });

  it("still fails legibly when no cause was recorded", async () => {
    // `dispose()` resolves the gate from paths that never recorded a reason
    // (archive, full reset). The message must still name the container.
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
      workerUrl: "http://0.0.0.0:0",
    });
    runner.dispose({ force: true });

    const err = await captureRejection(runner, "claude" as AgentId);

    expect(err).toBeInstanceOf(WorkerUnavailableError);
    expect((err as Error).message).toMatch(/session container isn't running/i);
    expect((err as Error).message).not.toMatch(/ECONNREFUSED|0\.0\.0\.0/);
  });
});

// --------------------------------------------------------------------------
// 3. The reconciler no longer kills sessions that are mid-creation
// --------------------------------------------------------------------------

describe("missing-container reconciler skips in-flight creation", () => {
  function reconcilerFor(runner: SessionRunnerInterface): () => Promise<void> {
    return createMissingContainerReconciler({
      containerManager: {
        get: () => undefined,
        isStandby: () => false,
      } as unknown as SessionContainerManager,
      runnerRegistry: makeFakeRegistry(new Map([[runner.sessionId, runner]])),
      broadcastLog: () => undefined,
    });
  }

  it("leaves a runner whose container is still being created alone", async () => {
    // The race: `getOrCreate` registers the runner synchronously, but the
    // manager's map entry only lands partway through `createContainer`.
    // Everything before that (destroying a stale container, resolving overlay
    // specs, building the config) looked like an orphaned runner to this pass.
    const { runner, disposeCalls, emitted } = makeReconcilerRunner("s-creating", true);
    await reconcilerFor(runner)();

    expect(disposeCalls).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("still disposes a genuinely orphaned runner", async () => {
    // The guard must not blunt the reconciler's actual job.
    const { runner, disposeCalls } = makeReconcilerRunner("s-orphan", false);
    await reconcilerFor(runner)();

    expect(disposeCalls).toEqual([{ force: true }]);
  });
});

// --------------------------------------------------------------------------
// 4. `awaitingContainer` semantics
// --------------------------------------------------------------------------

describe("ContainerSessionRunner.awaitingContainer", () => {
  it("is false for a runner that reconnected to a live container", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
      workerUrl: "http://172.18.0.4:9100",
    });
    expect(runner.awaitingContainer).toBe(false);
    runner.dispose({ force: true });
  });

  it("flips false once creation fails, so a dead runner isn't shielded forever", () => {
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
      workerUrl: "http://0.0.0.0:0",
    });
    expect(runner.awaitingContainer).toBe(true);
    runner.markWorkerUnavailable("boom");
    expect(runner.awaitingContainer).toBe(false);
    runner.dispose({ force: true });
  });
});
