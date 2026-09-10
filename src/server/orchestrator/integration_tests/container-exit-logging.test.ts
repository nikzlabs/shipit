import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  handleContainerExited,
  createMissingContainerReconciler,
  setupContainerHealthMonitoring,
} from "../app-lifecycle.js";
import { startHealthMonitor, createHealthMonitorState, type HealthDeps } from "../container-health.js";
import { createOomCircuitBreaker } from "../oom-circuit-breaker.js";
import { createSessionLoopDetector } from "../loop-detector.js";
import type { SessionContainerManager, SessionContainer } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface, ChatMessageGroup } from "../session-runner.js";
import type { ChatHistoryManager, PersistedMessage } from "../chat-history.js";
import type { WsServerMessage, LogSource } from "../../shared/types.js";

interface FakeRunner {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
  disposeCalls: { force?: boolean }[];
  setChatMessageGroups: (groups: ChatMessageGroup[]) => void;
  setRunning: (running: boolean) => void;
}

function makeFakeRunner(sessionId: string, workerStreamDownSince = 0): FakeRunner {
  const emitted: WsServerMessage[] = [];
  const disposeCalls: { force?: boolean }[] = [];
  const runner = Object.assign(new EventEmitter(), {
    sessionId,
    sessionDir: "/tmp/x",
    workspaceDir: "/tmp/x",
    running: false,
    queueLength: 0,
    viewerCount: 0,
    lastSseEventAt: 0,
    workerStreamDownSince,
    disposed: false,
    wasInterrupted: false,
    chatMessageGroups: [] as ChatMessageGroup[],
    steeredMessages: [],
    recordedCards: [],
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    getAgent: () => null,
    setAgent: () => undefined,
    getTurnEventBuffer: () => [],
    attachViewer: () => undefined,
    detachViewer: () => undefined,
    waitForPreviewStatus: async () => undefined,
    previewStatusKnown: true,
    buildPreviewStatus: () => ({ type: "preview_status", running: false } as WsServerMessage),
    dispose: (opts?: { force?: boolean }) => { disposeCalls.push(opts ?? {}); },
  }) as unknown as SessionRunnerInterface & { chatMessageGroups: ChatMessageGroup[] };
  const setChatMessageGroups = (g: ChatMessageGroup[]): void => { runner.chatMessageGroups = g; };
  const setRunning = (running: boolean): void => { runner.running = running; };
  return { runner, emitted, disposeCalls, setChatMessageGroups, setRunning };
}

interface FakeChatHistoryCalls {
  replaceInProgress: { sessionId: string; messages: PersistedMessage[] }[];
  finalizeInProgress: string[];
  append: { sessionId: string; message: PersistedMessage }[];
}

function makeFakeChatHistoryManager(): { manager: ChatHistoryManager; calls: FakeChatHistoryCalls } {
  const calls: FakeChatHistoryCalls = {
    replaceInProgress: [],
    finalizeInProgress: [],
    append: [],
  };
  const manager = {
    replaceInProgress: (sessionId: string, messages: PersistedMessage[]) => {
      calls.replaceInProgress.push({ sessionId, messages });
    },
    finalizeInProgress: (sessionId: string) => {
      calls.finalizeInProgress.push(sessionId);
    },
    append: (sessionId: string, message: PersistedMessage) => {
      calls.append.push({ sessionId, message });
      return 0;
    },
  } as unknown as ChatHistoryManager;
  return { manager, calls };
}

function makeFakeRegistry(entries: Map<string, SessionRunnerInterface>): SessionRunnerRegistry {
  return {
    get: (sid: string) => entries.get(sid),
    ids: () => [...entries.keys()],
    dispose: (sid: string, opts?: { force?: boolean }) => {
      entries.get(sid)?.dispose(opts);
    },
  } as unknown as SessionRunnerRegistry;
}

function makeFakeContainerManager(
  containers: Map<string, Partial<SessionContainer>>,
  standby: Set<string>,
  adopt?: { impl: (sid: string) => Promise<boolean>; calls: string[] },
  liveness?: { impl: (sid: string) => Promise<boolean | undefined>; calls: string[] },
): SessionContainerManager {
  const gone: string[] = [];
  return {
    get: (sid: string) => containers.get(sid) as SessionContainer | undefined,
    isStandby: (sid: string) => standby.has(sid),
    adoptRunningContainer: adopt
      ? async (sid: string) => { adopt.calls.push(sid); return adopt.impl(sid); }
      : async () => false,
    isTrackedContainerRunning: liveness
      ? async (sid: string) => { liveness.calls.push(sid); return liveness.impl(sid); }
      : async () => true,
    markContainerGone: async (sid: string, expectedId: string) => {
      const sc = containers.get(sid);
      if (sc?.id !== expectedId) return false;
      gone.push(sid);
      containers.delete(sid);
      return true;
    },
    _gone: gone,
  } as unknown as SessionContainerManager;
}

describe("handleContainerExited (container_exited breadcrumb)", () => {
  it("writes a server log entry to the per-session ring", () => {
    const { runner } = makeFakeRunner("sess-1");
    const registry = makeFakeRegistry(new Map([["sess-1", runner]]));
    const calls: { sid: string; source: LogSource; text: string }[] = [];

    handleContainerExited(
      "sess-1",
      137,
      "OOMKilled",
      registry,
      (sid, source, text) => calls.push({ sid, source, text }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sid: "sess-1",
      source: "server",
      text: expect.stringContaining("OOMKilled") as string,
    });
  });

  it("does not assume exit 137 is OOMKilled when no explicit error string is given", () => {
    const { runner } = makeFakeRunner("sess-1");
    const registry = makeFakeRegistry(new Map([["sess-1", runner]]));
    const calls: { sid: string; source: LogSource; text: string }[] = [];

    handleContainerExited(
      "sess-1",
      137,
      undefined,
      registry,
      (sid, source, text) => calls.push({ sid, source, text }),
    );

    expect(calls[0]?.text).toContain("exit 137");
    expect(calls[0]?.text).not.toContain("OOMKilled");
  });

  it("emits session_status to the runner and force-disposes", () => {
    const { runner, emitted, disposeCalls } = makeFakeRunner("sess-2");
    const registry = makeFakeRegistry(new Map([["sess-2", runner]]));

    handleContainerExited("sess-2", 1, "crash", registry);

    const status = emitted.find((m) => m.type === "session_status");
    expect(status).toMatchObject({
      type: "session_status",
      sessionId: "sess-2",
      running: false,
      error: expect.stringContaining("crash") as string,
    });
    expect(disposeCalls).toHaveLength(1);
    expect(disposeCalls[0]).toEqual({ force: true });
  });

  it("works when broadcastLog is not wired (defensive)", () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-3");
    const registry = makeFakeRegistry(new Map([["sess-3", runner]]));

    expect(() => handleContainerExited("sess-3", 0, undefined, registry)).not.toThrow();
    expect(disposeCalls).toHaveLength(1);
  });

  it("writes the log ring entry even when the runner is already gone", () => {
    const registry = makeFakeRegistry(new Map());
    const calls: { sid: string; source: LogSource; text: string }[] = [];

    handleContainerExited(
      "sess-missing",
      137,
      "OOMKilled",
      registry,
      (sid, source, text) => calls.push({ sid, source, text }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sid).toBe("sess-missing");
  });

  describe("partial-turn preservation (OOM mid-turn)", () => {
    it("finalizes in-flight chatMessageGroups before disposing the runner", () => {
      const { runner, setChatMessageGroups, setRunning } = makeFakeRunner("sess-oom");
      const registry = makeFakeRegistry(new Map([["sess-oom", runner]]));
      const { manager, calls } = makeFakeChatHistoryManager();

      setRunning(true);
      setChatMessageGroups([
        {
          text: "I'll start by reading the file.",
          toolUse: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo" } }],
          toolResults: [{ toolUseId: "t1", content: "file contents" }],
        },
        { text: "Now let me edit it.", toolUse: [] },
      ]);

      handleContainerExited("sess-oom", 137, "OOMKilled", registry, undefined, manager);

      expect(calls.replaceInProgress).toHaveLength(1);
      expect(calls.replaceInProgress[0]?.sessionId).toBe("sess-oom");
      expect(calls.replaceInProgress[0]?.messages).toHaveLength(2);
      expect(calls.replaceInProgress[0]?.messages[0]).toMatchObject({
        role: "assistant",
        text: "I'll start by reading the file.",
      });
      expect(calls.finalizeInProgress).toEqual(["sess-oom"]);
      expect(calls.append).toHaveLength(1);
      expect(calls.append[0]?.message).toMatchObject({
        role: "assistant",
        notice: true,
        noticeLevel: "warn",
      });
      expect(calls.append[0]?.message.text).toContain("OOMKilled");
    });

    it("running runner still finalizes when there are no in-memory groups (preserves orphaned in_progress rows)", () => {
      const { runner, setRunning } = makeFakeRunner("sess-oom2");
      const registry = makeFakeRegistry(new Map([["sess-oom2", runner]]));
      const { manager, calls } = makeFakeChatHistoryManager();

      setRunning(true);
      handleContainerExited("sess-oom2", 137, undefined, registry, undefined, manager);

      expect(calls.replaceInProgress).toHaveLength(1);
      expect(calls.replaceInProgress[0]?.messages).toEqual([]);
      expect(calls.finalizeInProgress).toEqual(["sess-oom2"]);
      expect(calls.append).toHaveLength(1);
    });

    it("idle runner with stale chatMessageGroups does not overwrite DB in-progress rows", () => {
      const { runner, setChatMessageGroups } = makeFakeRunner("sess-idle-stale");
      const registry = makeFakeRegistry(new Map([["sess-idle-stale", runner]]));
      const { manager, calls } = makeFakeChatHistoryManager();

      setChatMessageGroups([
        { text: "This is the already-finalized previous assistant response.", toolUse: [] },
      ]);

      handleContainerExited("sess-idle-stale", 137, undefined, registry, undefined, manager);

      expect(calls.replaceInProgress).toHaveLength(0);
      expect(calls.finalizeInProgress).toEqual(["sess-idle-stale"]);
      expect(calls.append).toHaveLength(1);
      expect(calls.append[0]?.message.text).toContain("exit 137");
    });

    it("idle runner with no groups still finalizes orphaned in_progress rows", () => {
      const { runner } = makeFakeRunner("sess-idle-empty");
      const registry = makeFakeRegistry(new Map([["sess-idle-empty", runner]]));
      const { manager, calls } = makeFakeChatHistoryManager();

      handleContainerExited("sess-idle-empty", 1, undefined, registry, undefined, manager);

      expect(calls.replaceInProgress).toHaveLength(0);
      expect(calls.finalizeInProgress).toEqual(["sess-idle-empty"]);
      expect(calls.append).toHaveLength(1);
    });

    it("skips groups with no text and no tool use (empty placeholders)", () => {
      const { runner, setChatMessageGroups, setRunning } = makeFakeRunner("sess-oom3");
      const registry = makeFakeRegistry(new Map([["sess-oom3", runner]]));
      const { manager, calls } = makeFakeChatHistoryManager();

      setRunning(true);
      setChatMessageGroups([
        { text: "", toolUse: [] },
        { text: "Real content", toolUse: [] },
        { text: "", toolUse: [] },
      ]);

      handleContainerExited("sess-oom3", 137, "OOMKilled", registry, undefined, manager);

      expect(calls.replaceInProgress[0]?.messages).toHaveLength(1);
      expect(calls.replaceInProgress[0]?.messages[0]?.text).toBe("Real content");
    });

    it("still force-disposes the runner if chat-history persistence throws", () => {
      const { runner, disposeCalls, setChatMessageGroups, setRunning } = makeFakeRunner("sess-oom4");
      const registry = makeFakeRegistry(new Map([["sess-oom4", runner]]));
      setRunning(true);
      setChatMessageGroups([{ text: "partial", toolUse: [] }]);
      const manager = {
        replaceInProgress: () => { throw new Error("db write failed"); },
        finalizeInProgress: () => undefined,
        append: () => 0,
      } as unknown as ChatHistoryManager;

      handleContainerExited("sess-oom4", 137, "OOMKilled", registry, undefined, manager);

      expect(disposeCalls).toEqual([{ force: true }]);
    });

    it("does nothing to chat history when no chatHistoryManager is passed (back-compat)", () => {
      const { runner, disposeCalls, setChatMessageGroups } = makeFakeRunner("sess-oom5");
      const registry = makeFakeRegistry(new Map([["sess-oom5", runner]]));
      setChatMessageGroups([{ text: "partial", toolUse: [] }]);

      expect(() =>
        handleContainerExited("sess-oom5", 137, "OOMKilled", registry),
      ).not.toThrow();
      expect(disposeCalls).toEqual([{ force: true }]);
    });
  });
});

describe("createMissingContainerReconciler (orphan-runner detector)", () => {
  it("force-disposes a runner whose container has vanished and writes a log entry", async () => {
    const { runner, emitted, disposeCalls } = makeFakeRunner("sess-orphan");
    const registry = makeFakeRegistry(new Map([["sess-orphan", runner]]));
    const containerManager = makeFakeContainerManager(new Map(), new Set());
    const calls: { sid: string; source: LogSource; text: string }[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (sid, source, text) => calls.push({ sid, source, text }),
    });
    await reconcile();

    expect(disposeCalls).toEqual([{ force: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sid).toBe("sess-orphan");
    expect(calls[0]?.text).toMatch(/container is gone/i);
    expect(emitted.find((m) => m.type === "session_status")).toBeDefined();
  });

  it("leaves healthy runners alone when their container is present", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-ok");
    const registry = makeFakeRegistry(new Map([["sess-ok", runner]]));
    const containerManager = makeFakeContainerManager(
      new Map([["sess-ok", { id: "c1", sessionId: "sess-ok" } as Partial<SessionContainer>]]),
      new Set(),
    );
    const calls: unknown[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (...args) => calls.push(args),
    });
    await reconcile();

    expect(disposeCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips standby sessions (warm pool transient race)", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-warm");
    const registry = makeFakeRegistry(new Map([["sess-warm", runner]]));
    const containerManager = makeFakeContainerManager(new Map(), new Set(["sess-warm"]));

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(disposeCalls).toEqual([]);
  });

  it("handles multiple runners — orphans go, healthy stay", async () => {
    const a = makeFakeRunner("sess-a");
    const b = makeFakeRunner("sess-b");
    const c = makeFakeRunner("sess-c");
    const registry = makeFakeRegistry(new Map([
      ["sess-a", a.runner],
      ["sess-b", b.runner],
      ["sess-c", c.runner],
    ]));
    const containerManager = makeFakeContainerManager(
      new Map([["sess-b", { id: "c-b", sessionId: "sess-b" } as Partial<SessionContainer>]]),
      new Set(),
    );
    const logged: string[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (sid) => logged.push(sid),
    });
    await reconcile();

    expect(a.disposeCalls).toEqual([{ force: true }]);
    expect(b.disposeCalls).toEqual([]);
    expect(c.disposeCalls).toEqual([{ force: true }]);
    expect(logged.sort()).toEqual(["sess-a", "sess-c"]);
  });

  it("is a no-op when no containerManager is wired (local mode)", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-x");
    const registry = makeFakeRegistry(new Map([["sess-x", runner]]));

    const reconcile = createMissingContainerReconciler({
      containerManager: null,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(disposeCalls).toEqual([]);
  });

  it("re-adopts a live untracked container and does NOT dispose the runner", async () => {
    const { runner, emitted, disposeCalls } = makeFakeRunner("sess-adopt");
    const registry = makeFakeRegistry(new Map([["sess-adopt", runner]]));
    const adopt = { impl: async () => true, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(new Map(), new Set(), adopt);
    const logged: { sid: string; text: string }[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (sid, _source, text) => logged.push({ sid, text }),
      // Presence enables adoption; the stub does not call the resolver.
      sessionInfoResolver: (sid) => ({ workspaceDir: `/ws/${sid}`, dockerAccess: false }),
    });
    await reconcile();

    expect(adopt.calls).toEqual(["sess-adopt"]);
    expect(disposeCalls).toEqual([]);
    expect(emitted.find((m) => m.type === "session_status")).toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.text).toMatch(/recovered/i);
  });

  it("force-disposes the runner when adoption fails (no live container found)", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-gone");
    const registry = makeFakeRegistry(new Map([["sess-gone", runner]]));
    const adopt = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(new Map(), new Set(), adopt);

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
      sessionInfoResolver: (sid) => ({ workspaceDir: `/ws/${sid}`, dockerAccess: false }),
    });
    await reconcile();

    expect(adopt.calls).toEqual(["sess-gone"]);
    expect(disposeCalls).toEqual([{ force: true }]);
  });

  it("still force-disposes when adoptRunningContainer throws (Docker error)", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-throw");
    const registry = makeFakeRegistry(new Map([["sess-throw", runner]]));
    const adopt = {
      impl: async () => { throw new Error("docker daemon unreachable"); },
      calls: [] as string[],
    };
    const containerManager = makeFakeContainerManager(new Map(), new Set(), adopt);

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
      sessionInfoResolver: (sid) => ({ workspaceDir: `/ws/${sid}`, dockerAccess: false }),
    });
    await reconcile();

    expect(adopt.calls).toEqual(["sess-throw"]);
    expect(disposeCalls).toEqual([{ force: true }]);
  });

  const TRACKED = new Map([["sess-e", { id: "c-e", sessionId: "sess-e", workerUrl: "http://10.0.0.1:9100" } as Partial<SessionContainer>]]);

  const DOWN_LONG_AGO = (): number => Date.now() - 5 * 60_000;
  const DOWN_RECENTLY = (): number => Date.now() - 5_000;

  it("declares a tracked-but-dead container gone once the worker stops answering", async () => {
    const { runner, emitted, disposeCalls } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );
    const logged: string[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (_sid, _source, text) => logged.push(text),
    });
    await reconcile();

    expect(liveness.calls).toEqual(["sess-e"]);
    expect(disposeCalls).toEqual([{ force: true }]);
    expect(logged[0]).toMatch(/container is gone/i);
    expect(emitted.find((m) => m.type === "session_status")).toBeDefined();
    expect((containerManager as unknown as { _gone: string[] })._gone).toEqual(["sess-e"]);
  });

  it("does not probe Docker while the worker's stream is healthy", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", 0);
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(liveness.calls).toEqual([]);
    expect(disposeCalls).toEqual([]);
  });

  it("leaves a slow-to-reconnect worker alone below the time threshold", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", DOWN_RECENTLY());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(liveness.calls).toEqual([]);
    expect(disposeCalls).toEqual([]);
  });

  it("keeps a session whose container is running and whose worker answers", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => true, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );
    const probed: string[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
      workerResponds: async (url) => { probed.push(url); return true; },
    });
    await reconcile();

    expect(liveness.calls).toEqual(["sess-e"]);
    expect(probed).toEqual(["http://10.0.0.1:9100"]);
    expect(disposeCalls).toEqual([]);
  });

  it("reports a live container whose worker never answers, without forgetting it", async () => {
    const { runner, disposeCalls, emitted } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => true, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );
    const logged: string[] = [];

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: (_sid, _source, text) => logged.push(text),
      workerResponds: async () => false,
    });
    await reconcile();

    expect(disposeCalls).toEqual([{ force: true }]);
    expect(emitted.find((m) => m.type === "session_status")).toBeDefined();
    expect(logged[0]).toMatch(/stopped responding/i);
    expect(logged[0]).toMatch(/restart/i);
    expect((containerManager as unknown as { _gone: string[] })._gone).toEqual([]);
  });

  it("never declares a session dead when Docker cannot answer", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => undefined, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(disposeCalls).toEqual([]);
  });

  it("never probes a runner whose container is still being created", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    (runner as unknown as { awaitingContainer: boolean }).awaitingContainer = true;
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(liveness.calls).toEqual([]);
    expect(disposeCalls).toEqual([]);
  });

  it("does not try to adopt a container it has just proved is not running", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const adopt = { impl: async () => true, calls: [] as string[] };
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), adopt, liveness,
    );

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
      sessionInfoResolver: (sid) => ({ workspaceDir: `/ws/${sid}`, dockerAccess: false }),
    });
    await reconcile();

    expect(adopt.calls).toEqual([]);
    expect(disposeCalls).toEqual([{ force: true }]);
  });

  it("ignores a probe answer about a container that has since been replaced", async () => {
    const { runner, disposeCalls } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const containers = new Map(TRACKED);
    const liveness = {
      calls: [] as string[],
      impl: async () => {
        containers.set("sess-e", { id: "c-e2", sessionId: "sess-e" } as Partial<SessionContainer>);
        return false;
      },
    };
    const containerManager = makeFakeContainerManager(containers, new Set(), undefined, liveness);

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
    });
    await reconcile();

    expect(disposeCalls).toEqual([]);
    expect(containers.get("sess-e")?.id).toBe("c-e2");
  });

  it("preserves an interrupted turn and appends a visible notice", async () => {
    const { runner, emitted, setRunning, setChatMessageGroups } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    setRunning(true);
    setChatMessageGroups([{ text: "half a turn", toolUse: [] }]);
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );
    const { manager, calls } = makeFakeChatHistoryManager();

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
      chatHistoryManager: manager,
    });
    await reconcile();

    expect(calls.replaceInProgress[0]?.messages[0]?.text).toBe("half a turn");
    expect(calls.finalizeInProgress).toEqual(["sess-e"]);
    expect(calls.append[0]?.message.text).toMatch(/container is gone/i);
    expect(calls.append[0]?.message.notice).toBe(true);
    expect(emitted.find((m) => m.type === "system_notice")).toBeDefined();
  });

  it("still force-disposes when the chat-history write throws", async () => {
    const { runner, disposeCalls, setRunning } = makeFakeRunner("sess-e", DOWN_LONG_AGO());
    setRunning(true);
    const registry = makeFakeRegistry(new Map([["sess-e", runner]]));
    const liveness = { impl: async () => false, calls: [] as string[] };
    const containerManager = makeFakeContainerManager(
      new Map(TRACKED), new Set(), undefined, liveness,
    );
    const failing = {
      replaceInProgress: () => { throw new Error("db write failed"); },
      finalizeInProgress: () => undefined,
      append: () => 0,
    } as unknown as ChatHistoryManager;

    const reconcile = createMissingContainerReconciler({
      containerManager,
      runnerRegistry: registry,
      broadcastLog: () => undefined,
      chatHistoryManager: failing,
    });
    await reconcile();

    expect(disposeCalls).toEqual([{ force: true }]);
  });
});

function makeManagerEmitter(): SessionContainerManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getAll: () => [],
    get: () => undefined,
    isStandby: () => false,
  }) as unknown as SessionContainerManager;
}

describe("setupContainerHealthMonitoring → oomBreaker integration", () => {
  function setup(sessionId = "sess-1") {
    const manager = makeManagerEmitter();
    const fake = makeFakeRunner(sessionId);
    const registry = makeFakeRegistry(new Map([[sessionId, fake.runner]]));
    const logs: { sid: string; source: LogSource; text: string }[] = [];
    const breaker = createOomCircuitBreaker({ windowMs: 60_000, threshold: 3 });
    const loopDetector = createSessionLoopDetector({ threshold: 3, windowMs: 60_000 });
    setupContainerHealthMonitoring(
      manager,
      registry,
      (sid, source, text) => logs.push({ sid, source, text }),
      loopDetector,
      breaker,
    );
    return { manager, fake, breaker, loopDetector, logs, sessionId };
  }

  it("counts exit code 137 as OOM even when error is undefined (die-before-oom case)", () => {
    const { manager, breaker, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, undefined);
    expect(breaker.getState(sessionId).countInWindow).toBe(1);
  });

  it("counts an explicit error='Out of memory' as OOM (oom-first case)", () => {
    const { manager, breaker, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, "Out of memory");
    expect(breaker.getState(sessionId).countInWindow).toBe(1);
  });

  it("ignores non-OOM exits (exit 0 / exit 1, no OOM marker)", () => {
    const { manager, breaker, sessionId } = setup();
    manager.emit("container_exited", sessionId, 0, undefined);
    manager.emit("container_exited", sessionId, 1, "crash");
    expect(breaker.getState(sessionId).countInWindow).toBe(0);
  });

  it("trips after 3 mixed OOM signals (1 explicit + 2 die-only with exit 137)", () => {
    const { manager, fake, breaker, logs, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, "Out of memory");
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_exited", sessionId, 137, undefined);
    expect(breaker.isTripped(sessionId)).toBe(true);
    expect(breaker.getState(sessionId).countInWindow).toBe(3);
    expect(fake.emitted.some((m) => m.type === "session_memory_exhausted")).toBe(true);
    expect(logs.some((l) => l.text.includes("Session disabled"))).toBe(true);
  });

  it("force-trips the breaker when the loop detector fires (Fix B)", () => {
    const { manager, fake, breaker, logs, sessionId } = setup();
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    expect(breaker.isTripped(sessionId)).toBe(true);
    expect(fake.emitted.some((m) => m.type === "session_memory_exhausted")).toBe(true);
    expect(logs.some((l) => l.text.includes("LOOP DETECTED"))).toBe(true);
    expect(logs.some((l) => l.text.includes("Session disabled"))).toBe(true);
  });

  it("does not report a compose service exit 137 as OOM when the event says oom: false", () => {
    const { manager, fake, logs, sessionId } = setup();
    manager.emit("service_exited", sessionId, {
      serviceName: "dev", containerId: "c1", exitCode: 137, oom: false,
    });

    const serviceLogs = logs.filter((l) => l.text.includes("dev"));
    expect(serviceLogs).toHaveLength(1);
    expect(serviceLogs[0]?.text).toContain("exited with code 137");
    expect(serviceLogs[0]?.text).not.toContain("OOM");
    expect(serviceLogs[0]?.text).not.toContain("memory");
    expect(fake.emitted.some((m) => m.type === "service_oom")).toBe(false);
  });

  it("still reports a confirmed compose service OOM as one", () => {
    const { manager, fake, logs, sessionId } = setup();
    manager.emit("service_exited", sessionId, {
      serviceName: "dev", containerId: "c1", exitCode: 137, oom: true,
    });

    const serviceLogs = logs.filter((l) => l.text.includes("dev"));
    expect(serviceLogs[0]?.text).toContain("OOM-killed");
    expect(serviceLogs[0]?.text).toContain("Increase memory limits");
    expect(fake.emitted.some((m) => m.type === "service_oom")).toBe(true);
  });

  it("a compose service exit never touches the agent-container OOM breaker", () => {
    const { manager, breaker, sessionId } = setup();
    for (let i = 0; i < 5; i++) {
      manager.emit("service_exited", sessionId, {
        serviceName: "dev", containerId: `c${i}`, exitCode: 137, oom: false,
      });
    }
    expect(breaker.getState(sessionId).countInWindow).toBe(0);
    expect(breaker.isTripped(sessionId)).toBe(false);
  });

  async function wireDockerEvents(manager: SessionContainerManager) {
    const eventStream = new EventEmitter();
    await startHealthMonitor(
      {
        docker: { getEvents: vi.fn(async () => eventStream) } as unknown as HealthDeps["docker"],
        containers: new Map(),
        standbySessionIds: new Set<string>(),
        emitter: manager as unknown as HealthDeps["emitter"],
        labelFilters: () => [],
      },
      createHealthMonitorState(),
    );
    return (attributes: Record<string, string>) => eventStream.emit(
      "data",
      Buffer.from(JSON.stringify({
        Action: "die",
        Actor: { ID: "c1", Attributes: { exitCode: "137", ...attributes } },
      })),
    );
  }

  it("a dying egress sidecar produces no compose-service line, end to end", async () => {
    const { manager, fake, logs, sessionId } = setup();
    const die = await wireDockerEvents(manager);

    die({
      "shipit-parent-session": sessionId,
      "shipit-egress-service-sidecar": "true",
      "shipit-egress-parent": "svc-1",
    });

    expect(logs.some((l) => /^\[compose\] \S+ exited with code/.test(l.text))).toBe(false);
    expect(logs).toHaveLength(0);
    expect(fake.emitted).toHaveLength(0);
  });

  it("…while the project's own service still produces exactly that line", async () => {
    const { manager, logs, sessionId } = setup();
    const die = await wireDockerEvents(manager);

    die({ "shipit-parent-session": sessionId, "shipit-service-name": "dev" });

    expect(logs.map((l) => l.text)).toEqual(["[compose] dev exited with code 137."]);
  });

  it("writes no session log line for a dying egress sidecar", () => {
    const { manager, logs, sessionId } = setup();
    manager.emit("session_child_exited", sessionId, {
      containerId: "sidecar-1", exitCode: 137, oom: false, egressSidecar: true,
    });

    expect(logs).toHaveLength(0);
    expect(logs.some((l) => /^\[compose\] \S+ exited with code/.test(l.text))).toBe(false);
  });

  it("still tells the OPERATOR, on the console", () => {
    const { manager, sessionId } = setup();
    const console_ = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      manager.emit("session_child_exited", sessionId, {
        containerId: "sidecar-1", exitCode: 137, oom: false, egressSidecar: true,
      });
      const line = console_.mock.calls.map((c) => String(c[0])).find((t) => t.includes("sidecar-1"));
      expect(line).toContain("egress sidecar exited");
      expect(line).toContain(sessionId);
      expect(line).not.toContain("compose");
    } finally {
      console_.mockRestore();
    }
  });

  it("sends no runner message for a dying egress sidecar, OOM included", () => {
    const { manager, fake, logs, sessionId } = setup();
    manager.emit("session_child_exited", sessionId, {
      containerId: "sidecar-1", exitCode: 137, oom: true, egressSidecar: true,
    });

    expect(fake.emitted.some((m) => m.type === "service_oom")).toBe(false);
    expect(fake.emitted).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("a dying session child never touches the agent-container OOM breaker", () => {
    const { manager, breaker, sessionId } = setup();
    for (let i = 0; i < 5; i++) {
      manager.emit("session_child_exited", sessionId, {
        containerId: `sidecar-${i}`, exitCode: 137, oom: true, egressSidecar: true,
      });
    }
    expect(breaker.getState(sessionId).countInWindow).toBe(0);
    expect(breaker.isTripped(sessionId)).toBe(false);
  });

  it("emits session_memory_exhausted exactly once across both trip paths", () => {
    const { manager, fake, sessionId } = setup();
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_exited", sessionId, 137, undefined);
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    manager.emit("container_started", sessionId);
    const memoryMsgs = fake.emitted.filter((m) => m.type === "session_memory_exhausted");
    expect(memoryMsgs).toHaveLength(1);
  });
});
