import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { reattachInFlightTurns } from "./restart-turn-reattach.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { WorkerAgentStatus } from "../shared/types.js";

async function startFakeWorker(
  status: Partial<WorkerAgentStatus>,
  laterStatus?: Partial<WorkerAgentStatus>,
): Promise<{ url: string; close: () => Promise<void>; probes: () => number }> {
  let probes = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/agent/status")) {
      probes++;
      const body = probes > 1 && laterStatus ? laterStatus : status;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: false, latestSseSeq: 0, ...body }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    probes: () => probes,
  };
}

interface Harness {
  deps: Parameters<typeof reattachInFlightTurns>[0];
  created: string[];
  resumed: string[];
  destroyed: string[];
  disposed: string[];
  runners: Map<string, FakeRunner>;
}

interface FakeRunner {
  agentBusy: boolean;
  viewerCount: number;
  disposed: boolean;
  declineDispose: boolean;
  preserveComposeOnDispose: boolean;
}

interface HarnessOpts {
  sessions?: Set<string>;
  existingRunners?: Map<string, Partial<FakeRunner>> | Set<string>;
  standby?: Set<string>;
  resumeResult?: boolean;
  reserved?: Set<string>;
}

function makeHarness(
  containers: { sessionId: string; workerUrl: string; status?: string; workerBuildId?: string }[],
  opts: HarnessOpts = {},
): Harness {
  const created: string[] = [];
  const resumed: string[] = [];
  const destroyed: string[] = [];
  const disposed: string[] = [];
  const sessions = opts.sessions ?? new Set(containers.map((c) => c.sessionId));
  const runnerSpecs = opts.existingRunners instanceof Set
    ? new Map([...opts.existingRunners].map((id) => [id, {} as Partial<FakeRunner>]))
    : opts.existingRunners ?? new Map<string, Partial<FakeRunner>>();

  const runners = new Map<string, FakeRunner>();
  for (const [id, spec] of runnerSpecs) {
    runners.set(id, {
      agentBusy: false,
      viewerCount: 0,
      disposed: false,
      declineDispose: false,
      preserveComposeOnDispose: false,
      ...spec,
    });
  }

  const containerManager = {
    getAll: () => containers.map((c) => ({ ...c, status: c.status ?? "running" })),
    isStandby: (id: string) => opts.standby?.has(id) ?? false,
    destroyAgentContainer: async (id: string) => { destroyed.push(id); },
  } as unknown as SessionContainerManager;

  const runnerRegistry = {
    get: (id: string) => runners.get(id) as unknown as SessionRunnerInterface | undefined,
    getOrCreate: (id: string) => {
      created.push(id);
      return {
        resumeInFlightTurn: async () => {
          resumed.push(id);
          return opts.resumeResult ?? true;
        },
      } as unknown as SessionRunnerInterface;
    },
    dispose: (id: string) => {
      disposed.push(id);
      const r = runners.get(id);
      if (r && !r.declineDispose) r.disposed = true;
    },
  } as unknown as SessionRunnerRegistry;

  const sessionManager = {
    get: (id: string) =>
      sessions.has(id)
        ? {
          id,
          workspaceDir: `/ws/${id}`,
          archived: false,
          ...(opts.reserved?.has(id) ? { keepPreviewRunning: true } : {}),
        }
        : undefined,
  } as unknown as SessionManager;

  return {
    deps: {
      containerManager, runnerRegistry, sessionManager, defaultAgentId: "claude",
      orchestratorBuildId: "current-build",
      confirmDelayMs: 0,
    },
    created,
    resumed,
    destroyed,
    disposed,
    runners,
  };
}

describe("reattachInFlightTurns", () => {
  const workers: { close: () => Promise<void> }[] = [];

  beforeEach(() => { workers.length = 0; });
  afterEach(async () => { for (const w of workers) await w.close(); });

  async function worker(
    status: Partial<WorkerAgentStatus>,
    laterStatus?: Partial<WorkerAgentStatus>,
  ): Promise<string> {
    const w = await startFakeWorker(status, laterStatus);
    workers.push(w);
    return w.url;
  }

  it("reattaches a session whose worker still has a turn in flight", async () => {
    const url = await worker({ running: true, turnActive: true, turnStartSseSeq: 3, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url }]);

    const adopted = await reattachInFlightTurns(h.deps);

    expect(adopted).toBe(1);
    expect(h.created).toEqual(["s1"]);
    expect(h.resumed).toEqual(["s1"]);
  });

  it("leaves a CURRENT idle session untouched — no runner is created for it", async () => {
    const url = await worker({ running: true, turnActive: false, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "current-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.destroyed).toEqual([]);
  });

  it("reclaims a stale container whose agent process is stopped, without recreating it", async () => {
    const url = await worker({ running: false, turnActive: false, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual(["s1"]);
    expect(h.created).toEqual([]);
    expect(h.resumed).toEqual([]);
  });

  it("reclaims a stale container whose agent CLI is merely idle-resident", async () => {
    const url = await worker({ running: true, turnActive: false, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual(["s1"]);
    expect(h.created).toEqual([]);
  });

  it("leaves a stale idle worker alone while it has outstanding background tasks", async () => {
    const url = await worker({ running: true, turnActive: false, backgroundTaskCount: 1 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual([]);
  });

  it("leaves a stale worker alone while a self-woken turn is in flight", async () => {
    const url = await worker({ running: true, turnActive: false, selfWakeActive: true });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual([]);
  });

  it("leaves a stale worker alone while a terminal or an install is live", async () => {
    const term = await worker({ running: true, turnActive: false, terminalActive: true });
    const inst = await worker({ running: false, turnActive: false, installRunning: true });
    const h = makeHarness([
      { sessionId: "terminal", workerUrl: term, workerBuildId: "old-build" },
      { sessionId: "installing", workerUrl: inst, workerBuildId: "old-build" },
    ]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual([]);
  });

  it("re-probes before destroying, and keeps a worker that woke in between", async () => {
    const woke = await worker(
      { running: true, turnActive: false },
      { running: true, turnActive: false, selfWakeActive: true },
    );
    const started = await worker(
      { running: true, turnActive: false },
      { running: true, turnActive: true },
    );
    const h = makeHarness([
      { sessionId: "self-woke", workerUrl: woke, workerBuildId: "old-build" },
      { sessionId: "turn-started", workerUrl: started, workerBuildId: "old-build" },
    ]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual([]);
  });

  it("keeps a worker whose confirming probe fails", async () => {
    const w = await startFakeWorker({ running: true, turnActive: false });
    const h = makeHarness([{ sessionId: "s1", workerUrl: w.url, workerBuildId: "old-build" }]);
    const sweep = reattachInFlightTurns({
      ...h.deps,
      confirmDelayMs: 50,
    });
    await new Promise((r) => setTimeout(r, 20));
    await w.close();

    expect(await sweep).toBe(0);
    expect(h.destroyed).toEqual([]);
  });

  it("never reclaims a session holding an always-on preview reservation", async () => {
    const url = await worker({ running: true, turnActive: false });
    const h = makeHarness(
      [{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }],
      { reserved: new Set(["s1"]) },
    );

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual([]);
    expect(h.disposed).toEqual([]);
  });

  it("disposes an existing bootstrap runner before reclaiming its stale container", async () => {
    const url = await worker({ running: false, turnActive: false });
    const h = makeHarness(
      [{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }],
      { existingRunners: new Set(["s1"]) },
    );

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.disposed).toEqual(["s1"]);
    expect(h.destroyed).toEqual(["s1"]);
    expect(h.created).toEqual([]);
    expect(h.runners.get("s1")?.preserveComposeOnDispose).toBe(true);
  });

  it("leaves the container alone when its runner is busy or has a viewer", async () => {
    const url = await worker({ running: true, turnActive: false });
    const h = makeHarness(
      [
        { sessionId: "busy", workerUrl: url, workerBuildId: "old-build" },
        { sessionId: "watched", workerUrl: url, workerBuildId: "old-build" },
      ],
      {
        existingRunners: new Map([
          ["busy", { agentBusy: true }],
          ["watched", { viewerCount: 1 }],
        ]),
      },
    );

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.disposed).toEqual([]);
    expect(h.destroyed).toEqual([]);
  });

  it("leaves the container alone when its runner declines disposal", async () => {
    const url = await worker({ running: true, turnActive: false });
    const h = makeHarness(
      [{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }],
      { existingRunners: new Map([["s1", { declineDispose: true }]]) },
    );

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.disposed).toEqual(["s1"]);
    expect(h.destroyed).toEqual([]);
    expect(h.runners.get("s1")?.preserveComposeOnDispose).toBe(false);
  });

  it("preserves a stale container while its turn is active", async () => {
    const url = await worker({ running: true, turnActive: true, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(1);
    expect(h.destroyed).toEqual([]);
    expect(h.created).toEqual(["s1"]);
    expect(h.resumed).toEqual(["s1"]);
  });

  it("does not reclaim an idle agent when the worker is current or its build is unknown", async () => {
    const url = await worker({ running: false, turnActive: false });
    const h = makeHarness([
      { sessionId: "current", workerUrl: url, workerBuildId: "current-build" },
      { sessionId: "unknown", workerUrl: url },
    ]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.destroyed).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("skips standby containers, archived/unknown sessions, and live turns that already have a runner", async () => {
    const url = await worker({ running: true, turnActive: true });
    const h = makeHarness(
      [
        { sessionId: "standby", workerUrl: url, workerBuildId: "old-build" },
        { sessionId: "unknown", workerUrl: url, workerBuildId: "old-build" },
        { sessionId: "has-runner", workerUrl: url, workerBuildId: "old-build" },
        { sessionId: "stopped", workerUrl: url, status: "exited", workerBuildId: "old-build" },
      ],
      {
        standby: new Set(["standby"]),
        sessions: new Set(["standby", "has-runner", "stopped"]),
        existingRunners: new Set(["has-runner"]),
      },
    );

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.destroyed).toEqual([]);
  });

  it("keeps going when one worker is unreachable, and leaves its container untouched", async () => {
    const live = await worker({ running: true, turnActive: true });
    const h = makeHarness([
      { sessionId: "dead", workerUrl: "http://127.0.0.1:1", workerBuildId: "old-build" },
      { sessionId: "live", workerUrl: live },
    ]);

    expect(await reattachInFlightTurns(h.deps)).toBe(1);
    expect(h.created).toEqual(["live"]);
    expect(h.destroyed).toEqual([]);
  });

  it("treats a legacy worker (no turnActive field) as neither adoptable nor idle", async () => {
    const url = await worker({ running: true, latestSseSeq: 4 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url, workerBuildId: "old-build" }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.destroyed).toEqual([]);
  });

  it("is a no-op without a container manager (local / test runtime)", async () => {
    const h = makeHarness([]);
    expect(await reattachInFlightTurns({ ...h.deps, containerManager: null })).toBe(0);
  });
});
