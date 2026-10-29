import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ABANDONED_DRAFT_RECLAIM_AFTER_MS, createIdleEnforcer, DONE_SESSION_RECLAIM_AFTER_MS } from "./idle-enforcer.js";
import type { IdleServiceHooks } from "./idle-enforcer.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { DockerMemoryStats, SessionInfo } from "../shared/types.js";
import type { WokenSession } from "./services/idle-compaction.js";

const ID = "22222222-2222-4222-8222-222222222222";

const WAIT = DONE_SESSION_RECLAIM_AFTER_MS;

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const resolved = new Date(Date.now() - 60_000).toISOString();
  return {
    id: ID,
    title: "Done",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: "2026-09-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r",
    mergedAt: resolved,
    ...overrides,
  };
}

// Below budget: nothing here is reclaimed for memory.
const underBudget: DockerMemoryStats = { usedBytes: 10, totalBytes: 100, budgetBytes: 100, bySession: {} };

type FakeRunner = Partial<SessionRunnerInterface>;

function harness(
  sessions: SessionInfo[],
  runner?: FakeRunner | (() => FakeRunner | undefined),
  opts: { poolWarm?: string[]; standby?: boolean; declineDispose?: boolean; noContainer?: boolean } = {},
) {
  const current = () => (typeof runner === "function" ? runner() : runner);
  const destroy = vi.fn().mockResolvedValue(undefined);
  const stopServices = vi.fn();
  const dispose = vi.fn(() => {
    const r = current();
    if (r && !opts.declineDispose) (r as { disposed: boolean }).disposed = true;
  });
  const containerManager = {
    get: (id: string) => (id === ID && !opts.noContainer ? { sessionId: ID } : undefined),
    getAll: () => [{ sessionId: ID }],
    isStandby: () => opts.standby ?? false,
    destroy,
    destroyAgentContainer: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionContainerManager;
  const services: IdleServiceHooks = { liveSessions: () => [ID], has: (id) => id === ID, stop: stopServices };
  // The real queries split on the warm column: listAll() never returns a draft.
  const sessionManager = {
    listAll: () => sessions.filter((s) => !s.warm),
    listWarm: () => sessions.filter((s) => s.warm),
    get: (id: string) => sessions.find((s) => s.id === id),
  } as unknown as SessionManager;
  const runnerRegistry = {
    get: (id: string) => (id === ID ? current() : undefined),
    dispose,
  } as unknown as SessionRunnerRegistry;
  const enforce = createIdleEnforcer({
    containerManager, runnerRegistry, sessionManager, services, getMemoryStats: () => underBudget,
    poolWarmSessionIds: () => new Set(opts.poolWarm ?? []),
  });
  return { enforce, destroy, stopServices, dispose };
}

describe("docs/316-done-sessions-return-memory — done sessions return their memory", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); });

  function afterWait(enforce: () => void): void {
    enforce();
    vi.advanceTimersByTime(WAIT);
    enforce();
  }

  it("stops the container and the whole stack of a done session below the budget (reqs 3, 6)", () => {
    const { enforce, destroy, stopServices } = harness([session()]);
    afterWait(enforce);
    expect(stopServices).toHaveBeenCalledWith(ID);
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("waits 10 minutes after the session becomes done (reqs 4, 9)", () => {
    const { enforce, destroy } = harness([session()]);
    enforce();
    vi.advanceTimersByTime(WAIT - 1_000);
    enforce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("starts the wait when the session becomes done, not when its PR resolved (req 4)", () => {
    const sessions = [session({ mergedAt: "2026-09-01T00:00:00.000Z", pinnedAt: "2026-09-01T00:00:00.000Z" })];
    const { enforce, destroy } = harness(sessions);
    enforce();
    delete sessions[0].pinnedAt;
    enforce();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAIT);
    enforce();
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("leaves a session the user continued after the merge (req 5)", () => {
    const { enforce, destroy } = harness([session({ lastUsedAt: new Date().toISOString() })]);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves a session with Keep preview running set (req 7)", () => {
    const { enforce, destroy, stopServices } = harness([session({ keepPreviewRunning: true })]);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
    expect(stopServices).not.toHaveBeenCalled();
  });

  it("stops a done session the user has open, 10 minutes after it became done (req 8)", () => {
    const runner = { viewerCount: 1, agentBusy: false, running: false, backgroundWorkDescriptions: [] as string[], disposed: false, queueLength: 0, lastViewerDetachAt: 0 };
    const { enforce, destroy, dispose } = harness([session()], runner);
    enforce();
    vi.advanceTimersByTime(WAIT - 60_000);
    runner.lastViewerDetachAt = Date.now();
    enforce();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    enforce();
    expect(dispose).toHaveBeenCalledWith(ID);
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("leaves an open session with memory below the budget when it is not done", () => {
    const runner = { viewerCount: 1, agentBusy: false, running: false, backgroundWorkDescriptions: [] as string[], disposed: false, queueLength: 0, lastViewerDetachAt: 0 };
    const { enforce, destroy } = harness([session({ mergedAt: undefined })], runner);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves a done session whose agent is busy", () => {
    const runner = { viewerCount: 0, agentBusy: true, running: false, backgroundWorkDescriptions: [] as string[], disposed: false, queueLength: 0, lastViewerDetachAt: 0 };
    const { enforce, destroy } = harness([session()], runner);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("starts the wait when the agent stops, not at a merge during its turn (reqs 4, 11)", () => {
    const runner = {
      viewerCount: 0, agentBusy: true, running: true, backgroundWorkDescriptions: [] as string[],
      disposed: false, queueLength: 0, lastViewerDetachAt: 0,
    };
    const { enforce, destroy } = harness([session()], runner);
    afterWait(enforce);
    runner.running = false;
    runner.agentBusy = false;
    enforce();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAIT);
    enforce();
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("leaves a merged parent with an unfinished child", () => {
    const child = session({ id: "child", parentSessionId: ID, rootSessionId: ID, mergedAt: undefined });
    const { enforce, destroy } = harness([session(), child]);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("stops a merged parent whose children are all merged", () => {
    const child = session({ id: "child", parentSessionId: ID, rootSessionId: ID });
    const { enforce, destroy } = harness([session(), child]);
    afterWait(enforce);
    expect(destroy).toHaveBeenCalledWith(ID);
  });
});

describe("abandoned warm drafts return their memory", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); });

  const draft = (overrides: Partial<SessionInfo> = {}) =>
    session({ title: "Warm session", warm: true, mergedAt: undefined, ...overrides });
  const unviewed = () => ({ viewerCount: 0, agentBusy: false, running: false, backgroundWorkDescriptions: [] as string[], disposed: false, queueLength: 0, lastViewerDetachAt: 0 });

  function afterWait(enforce: () => void): void {
    enforce();
    vi.advanceTimersByTime(ABANDONED_DRAFT_RECLAIM_AFTER_MS);
    enforce();
  }

  it("stops the standby and the whole stack of a draft no tab ever opened, below the budget", () => {
    const { enforce, destroy, stopServices } = harness([draft()], undefined, { standby: true });
    afterWait(enforce);
    expect(stopServices).toHaveBeenCalledWith(ID);
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("waits 10 minutes before it stops a draft", () => {
    const { enforce, destroy } = harness([draft()]);
    enforce();
    vi.advanceTimersByTime(ABANDONED_DRAFT_RECLAIM_AFTER_MS - 1_000);
    enforce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("stops a draft the user opened and then left", () => {
    const runner = unviewed();
    const { enforce, destroy, dispose } = harness([draft()], runner);
    afterWait(enforce);
    expect(dispose).toHaveBeenCalledWith(ID);
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("restarts the wait when the user looks at the draft between two passes", () => {
    const runner = unviewed();
    const { enforce, destroy } = harness([draft()], runner);
    enforce();
    vi.advanceTimersByTime(ABANDONED_DRAFT_RECLAIM_AFTER_MS - 60_000);
    runner.lastViewerDetachAt = Date.now();
    vi.advanceTimersByTime(60_000);
    enforce();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ABANDONED_DRAFT_RECLAIM_AFTER_MS);
    enforce();
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("leaves the repo's pool warm session", () => {
    const { enforce, destroy, stopServices } = harness([draft()], undefined, { poolWarm: [ID], standby: true });
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
    expect(stopServices).not.toHaveBeenCalled();
  });

  it("leaves a draft the user has open", () => {
    const { enforce, destroy } = harness([draft()], { ...unviewed(), viewerCount: 1 });
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves a draft whose agent is busy", () => {
    const { enforce, destroy } = harness([draft()], { ...unviewed(), agentBusy: true });
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves the container and stack of a draft whose runner declines disposal", () => {
    const { enforce, dispose, destroy, stopServices } = harness([draft()], unviewed(), { declineDispose: true });
    afterWait(enforce);
    expect(dispose).toHaveBeenCalledWith(ID);
    expect(destroy).not.toHaveBeenCalled();
    expect(stopServices).not.toHaveBeenCalled();
  });

  it("stops the stack of a draft whose agent container is already gone", () => {
    const { enforce, destroy, stopServices } = harness([draft()], undefined, { noContainer: true });
    afterWait(enforce);
    expect(stopServices).toHaveBeenCalledWith(ID);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves an idle session after its first message while memory is below the budget", () => {
    const { enforce, destroy } = harness([draft({ warm: false })], unviewed());
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("docs/333-idle-compaction req 8 — sessions that wait for their idle compaction", () => {
  const MB = 1024 * 1024;
  const OLDEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const MIDDLE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NEWEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const IDS = [OLDEST, MIDDLE, NEWEST];

  interface PressureRunner {
    viewerCount: number;
    agentBusy: boolean;
    disposed: boolean;
    queueLength: number;
    lastViewerDetachAt: number;
    turnEpoch: number;
  }

  function pressure(waiting: string[], wokenIds: string[] = [], previews: string[] = []) {
    const runners = new Map<string, PressureRunner>(IDS.map((id, i) => [id, {
      viewerCount: 0, agentBusy: false, disposed: false, queueLength: 0, lastViewerDetachAt: 1_000 * (i + 1), turnEpoch: 4,
    }]));
    const stopped = new Set<string>();
    const waits = new Set(waiting);
    const sessions = new Map(IDS.map((id) => [id, { id, lastUsedAt: "2026-10-20T09:00:00.000Z" } as SessionInfo]));
    // As the fire records it, before the wake; the wake's runner is new.
    const woken = new Map<string, WokenSession>(wokenIds.map((id) => {
      runners.get(id)!.lastViewerDetachAt = 0;
      return [id, { lastUsedAt: sessions.get(id)!.lastUsedAt, previewBefore: previews.includes(id) }];
    }));
    const starting = new Set<string>();
    const preserved: string[] = [];
    const containerIds = new Map(IDS.map((id) => [id, `container-${id}`]));
    const containerManager = {
      get: (id: string) => (stopped.has(id) ? undefined : { sessionId: id, id: containerIds.get(id) }),
      getAll: () => IDS.filter((id) => !stopped.has(id)).map((sessionId) => ({ sessionId })),
      isStandby: () => false,
      destroy: vi.fn().mockResolvedValue(undefined),
      // Production teardown yields before the container is gone, so a pass still lists it.
      destroyAgentContainer: vi.fn(async (id: string) => {
        await Promise.resolve();
        stopped.add(id);
      }),
    } as unknown as SessionContainerManager;
    const runnerRegistry = {
      get: (id: string) => {
        const r = runners.get(id);
        return r && !r.disposed ? r : undefined;
      },
      dispose: (id: string) => {
        const r = runners.get(id);
        if (!r || r.agentBusy) return;
        r.disposed = true;
        if ((r as { preserveComposeOnDispose?: boolean }).preserveComposeOnDispose) preserved.push(id);
      },
    } as unknown as SessionRunnerRegistry;
    // The compaction is a turn: it makes the session busy until it ends.
    const fire = vi.fn(async (id: string) => {
      waits.delete(id);
      runners.get(id)!.agentBusy = true;
      runners.get(id)!.turnEpoch += 1;
    });
    let stats: DockerMemoryStats = underBudget;
    const enforce = createIdleEnforcer({
      containerManager,
      runnerRegistry,
      sessionManager: {
        listAll: () => [], listWarm: () => [], get: (id: string) => sessions.get(id),
      } as unknown as SessionManager,
      services: { liveSessions: () => [], has: (id) => previews.includes(id), stop: vi.fn() },
      getMemoryStats: () => stats,
      idleCompaction: {
        isWaiting: (id) => waits.has(id),
        fire,
        wokenSessions: () => woken,
        forgetWoken: (id) => { woken.delete(id); },
        isStarting: (id) => starting.has(id),
      },
    });
    /** A fresh reading `overMb` over the budget, each session's agent taking `agentMb`. */
    const pass = async (overMb: number, agentMb = 100): Promise<void> => {
      stats = {
        usedBytes: (1_000 + overMb) * MB,
        totalBytes: 2_000 * MB,
        budgetBytes: 1_000 * MB,
        warnAtBytes: 900 * MB,
        evictAtBytes: 1_000 * MB,
        bySession: Object.fromEntries(
          IDS.filter((id) => !stopped.has(id)).map((id) => [id, { agentBytes: agentMb * MB, serviceBytes: 0 }]),
        ),
      };
      enforce();
      // Teardowns settle before the next pass may act.
      await new Promise((r) => setImmediate(r));
    };
    return {
      pass, fire, stopped, runners, waits, containerIds, woken, sessions, starting, preserved,
      destroyed: containerManager.destroyAgentContainer as ReturnType<typeof vi.fn>,
    };
  }

  it("stops every session that does not wait before one that does, oldest first", async () => {
    const { pass, fire, stopped } = pressure([OLDEST]);
    await pass(150);
    expect([...stopped].sort()).toEqual([MIDDLE, NEWEST].sort());
    expect(fire).not.toHaveBeenCalled();
  });

  it("compacts a waiting session instead of stopping it, and counts its memory", async () => {
    const { pass, fire, stopped } = pressure([OLDEST, MIDDLE]);
    await pass(150);
    expect([...stopped]).toEqual([NEWEST]);
    // One more session's worth was missing, so one compaction starts, not two.
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
  });

  it("stops the compacted session in a later pass, once its compaction is over, before anyone else", async () => {
    const { pass, fire, stopped, runners } = pressure([OLDEST, MIDDLE, NEWEST]);
    await pass(50);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST]);

    // Still compacting: its memory is on its way back, so nobody else is touched.
    await pass(50);
    expect(stopped.size).toBe(0);
    expect(fire).toHaveBeenCalledTimes(1);

    runners.get(OLDEST)!.agentBusy = false;
    await pass(50);
    expect([...stopped]).toEqual([OLDEST]);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("counts a compacted session's stop once, and goes on to the next one for the rest", async () => {
    const { pass, fire, runners, destroyed } = pressure([OLDEST, MIDDLE, NEWEST]);
    await pass(50);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST]);

    runners.get(OLDEST)!.agentBusy = false;
    await pass(150);
    expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST, MIDDLE]);
  });

  it("forgets a compacting session the user came back to: its memory no longer counts", async () => {
    const { pass, fire, stopped, runners } = pressure([OLDEST, MIDDLE, NEWEST]);
    await pass(50);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST]);

    runners.get(OLDEST)!.viewerCount = 1;
    await pass(50);
    expect(stopped.has(OLDEST)).toBe(false);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST, MIDDLE]);
  });

  it("stops only as many compacted sessions as memory is still short of, and forgets the rest", async () => {
    const { pass, fire, runners, destroyed } = pressure([OLDEST, MIDDLE, NEWEST]);
    await pass(250);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST, MIDDLE, NEWEST]);

    for (const id of IDS) runners.get(id)!.agentBusy = false;
    await pass(50);
    expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
    // The others are ordinary idle sessions again, stopped in the ordinary order.
    await pass(50);
    expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST, MIDDLE]);
  });

  it.each([
    ["ran another turn after its compaction", (r: PressureRunner) => { r.turnEpoch += 1; }],
    ["got a new container", (_r: PressureRunner, ids: Map<string, string>) => { ids.set(OLDEST, "replacement"); }],
  ] as [string, (r: PressureRunner, ids: Map<string, string>) => void][])(
    "forgets a compacting session that %s",
    async (_label, use) => {
      const { pass, fire, runners, containerIds, destroyed } = pressure([OLDEST, MIDDLE, NEWEST]);
      await pass(50);
      expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST]);

      runners.get(OLDEST)!.agentBusy = true;
      use(runners.get(OLDEST)!, containerIds);
      await pass(50);
      // Its memory no longer counts as on its way back, so the next session is compacted.
      expect(destroyed).not.toHaveBeenCalled();
      expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST, MIDDLE]);
    },
  );

  it("forgets it also after a visit while memory was under the budget", async () => {
    const { pass, fire, runners, waits, destroyed } = pressure([OLDEST, MIDDLE, NEWEST]);
    await pass(50);
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST]);

    // The user came back, worked, and left; the compaction ended and a new deadline waits.
    const oldest = runners.get(OLDEST)!;
    oldest.agentBusy = false;
    oldest.lastViewerDetachAt = 9_000;
    waits.add(OLDEST);
    await pass(-100);

    await pass(50);
    expect(destroyed).not.toHaveBeenCalled();
    expect(fire.mock.calls.map(([id]) => id)).toEqual([OLDEST, MIDDLE]);
  });

  describe("a container an idle compaction started (req 13)", () => {
    it("is stopped again once its compaction is over, under the budget too", async () => {
      const { pass, runners, woken, destroyed } = pressure([], [OLDEST]);
      const oldest = runners.get(OLDEST)!;
      oldest.agentBusy = true;
      oldest.turnEpoch += 1;
      await pass(-100);
      expect(destroyed, "not while it compacts").not.toHaveBeenCalled();

      oldest.agentBusy = false;
      await pass(-100);
      expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
      expect(oldest.disposed).toBe(true);
      expect(woken.size).toBe(0);
    });

    it("is stopped again when no compaction ran after the wake", async () => {
      const { pass, destroyed } = pressure([], [OLDEST]);
      await pass(-100);
      expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
    });

    it("is not counted as idle while its fire starts it, also over the budget", async () => {
      const { pass, starting, woken, destroyed } = pressure([], [OLDEST]);
      starting.add(OLDEST);
      await pass(250);
      expect(destroyed.mock.calls.map(([id]) => id)).not.toContain(OLDEST);
      expect(woken.has(OLDEST)).toBe(true);
    });

    it("keeps a preview that ran before the wake", async () => {
      const { pass, preserved, destroyed } = pressure([], [OLDEST], [OLDEST]);
      await pass(-100);
      expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
      expect(preserved).toEqual([OLDEST]);
    });

    it("stops the preview the wake started with the container", async () => {
      const { pass, preserved, destroyed } = pressure([], [OLDEST]);
      await pass(-100);
      expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
      expect(preserved).toEqual([]);
    });

    it("is not stopped for a retry of the compaction turn: only another turn is use", async () => {
      const { pass, runners, destroyed } = pressure([], [OLDEST]);
      runners.get(OLDEST)!.turnEpoch += 3;
      await pass(-100);
      expect(destroyed.mock.calls.map(([id]) => id)).toEqual([OLDEST]);
    });

    it.each([
      ["the user came back to", (r: PressureRunner) => { r.viewerCount = 1; }],
      ["the user visited and left", (r: PressureRunner) => { r.lastViewerDetachAt = 9_000; }],
      ["ran another turn", (_r: PressureRunner, s: SessionInfo) => { s.lastUsedAt = "2026-10-20T09:30:00.000Z"; }],
    ] as [string, (r: PressureRunner, s: SessionInfo) => void][])(
      "is kept, and forgotten, when %s",
      async (_label, use) => {
        const { pass, runners, sessions, woken, destroyed } = pressure([], [OLDEST]);
        use(runners.get(OLDEST)!, sessions.get(OLDEST)!);
        await pass(-100);
        expect(destroyed).not.toHaveBeenCalled();
        expect(woken.size).toBe(0);
      },
    );

    it("keeps the mark while its container is still being created", async () => {
      const { pass, stopped, runners, woken, destroyed } = pressure([], [OLDEST]);
      stopped.add(OLDEST);
      (runners.get(OLDEST)! as PressureRunner & { awaitingContainer?: boolean }).awaitingContainer = true;
      await pass(-100);
      expect(destroyed).not.toHaveBeenCalled();
      expect(woken.has(OLDEST)).toBe(true);
    });

    it("is forgotten when its container is gone", async () => {
      const { pass, stopped, woken, destroyed } = pressure([], [OLDEST]);
      stopped.add(OLDEST);
      await pass(-100);
      expect(destroyed).not.toHaveBeenCalled();
      expect(woken.size).toBe(0);
    });
  });
});
