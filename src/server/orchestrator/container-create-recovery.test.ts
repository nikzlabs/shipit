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

interface FakeManager {
  mgr: SessionContainerManager;
  createCalls: number;
  destroyCalls: string[];
  recordedErrors: { sessionId: string; error: string }[];
}

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

let workspaceDir: string;

beforeEach(() => {
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

async function settle(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("container creation retries transient failures", () => {
  it("recovers on a retry and hands the runner a real worker URL", async () => {
    const fake = makeFakeManager({ failures: 1 });
    const runner = startRunner(fake.mgr);

    await settle(() => fake.createCalls >= 2, "second create attempt");
    await runner.whenWorkerReady();

    expect(runner.getWorkerUrl()).toBe("http://172.18.0.9:9100");
    expect(runner.disposed).toBe(false);
    expect(fake.recordedErrors).toEqual([]);
    runner.dispose({ force: true });
  });

  it("keeps the turn's parked gate unresolved while retrying", async () => {
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
    expect(fake.destroyCalls).toEqual(["s1"]);
    runner.dispose({ force: true });
  });
});

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

    const err = await captureRejection(runner, "claude" as AgentId);

    expect(err).toBeInstanceOf(WorkerUnavailableError);
    expect((err as Error).message).toContain("no space left on device");
    expect((err as Error).message).not.toMatch(/ECONNREFUSED|0\.0\.0\.0/);
  });

  it("still fails legibly when no cause was recorded", async () => {
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
    const { runner, disposeCalls, emitted } = makeReconcilerRunner("s-creating", true);
    await reconcilerFor(runner)();

    expect(disposeCalls).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("still disposes a genuinely orphaned runner", async () => {
    const { runner, disposeCalls } = makeReconcilerRunner("s-orphan", false);
    await reconcilerFor(runner)();

    expect(disposeCalls).toEqual([{ force: true }]);
  });
});

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
