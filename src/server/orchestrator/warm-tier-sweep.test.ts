import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWarmTierSweep, startWarmTierSweep, WARM_REPAIR_GRACE_MS } from "./warm-tier-sweep.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DockerMemoryStats } from "../shared/types.js";

const URL = "https://github.com/acme/app";
const WARM_ID = "warm-1";

const OLD = new Date(Date.now() - WARM_REPAIR_GRACE_MS - 60_000).toISOString();

interface World {
  warmSessionId?: string | undefined;
  status?: string;
  tracked: { status: string } | null;
  dockerRunning: boolean | undefined;
  createdAt: string;
  sessionExists: boolean;
}

function makeSweep(world: Partial<World> = {}) {
  const w: World = {
    warmSessionId: WARM_ID,
    status: "ready",
    tracked: { status: "running" },
    dockerRunning: true,
    createdAt: OLD,
    sessionExists: true,
    ...world,
  };

  const warmSessionForRepo = vi.fn(async () => undefined);
  const ensureStandbyForWarmSession = vi.fn(async (_opts: unknown) => undefined);
  const destroy = vi.fn(async () => undefined);
  const stopPreview = vi.fn((_sessionId: string) => undefined);
  const repairPreview = vi.fn(async (_opts: unknown) => undefined);
  const setWarmSessionId = vi.fn();
  let memory: DockerMemoryStats | null = null;

  const repoStore = {
    list: () => [{ url: URL, status: w.status, warmSessionId: w.warmSessionId }],
    get: () => ({ url: URL, status: w.status, warmSessionId: w.warmSessionId }),
    setWarmSessionId,
  } as unknown as RepoStore;

  const sessionManager = {
    get: (id: string) =>
      w.sessionExists && id === WARM_ID
        ? { id, workspaceDir: "/sessions/warm-1/workspace", createdAt: w.createdAt }
        : undefined,
  } as unknown as SessionManager;

  const containerManager = {
    get: () => w.tracked ?? undefined,
    isTrackedContainerRunning: async () => w.dockerRunning,
    destroy,
  } as unknown as SessionContainerManager;

  const sweep = createWarmTierSweep({
    repoStore,
    sessionManager,
    containerManager,
    warmSessionForRepo,
    ensureStandbyForWarmSession,
    stopPreview,
    repairPreview,
    getMemoryStats: () => memory,
  });

  return {
    sweep,
    warmSessionForRepo,
    ensureStandbyForWarmSession,
    stopPreview,
    repairPreview,
    destroy,
    setWarmSessionId,
    setMemory: (m: DockerMemoryStats | null) => { memory = m; },
    claim: () => { w.warmSessionId = undefined; },
  };
}

function atBudget(): DockerMemoryStats {
  return {
    totalBytes: 100, usedBytes: 100, budgetBytes: 100,
    warnAtBytes: 90, evictAtBytes: 100, bySession: {},
  } as unknown as DockerMemoryStats;
}

describe("warm tier sweep", () => {
  let world: ReturnType<typeof makeSweep>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rebuilds the standby when Docker says the container is not running", async () => {
    world = makeSweep({ tracked: { status: "running" }, dockerRunning: false });

    await world.sweep();

    expect(world.destroy).toHaveBeenCalledWith(WARM_ID);
    expect(world.ensureStandbyForWarmSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: WARM_ID,
        sessionDir: "/sessions/warm-1",
        workspaceDir: "/sessions/warm-1/workspace",
        repoUrl: URL,
      }),
    );
    expect(world.warmSessionForRepo).not.toHaveBeenCalled();
    expect(world.setWarmSessionId).not.toHaveBeenCalled();
  });

  it("drops the pre-started preview before rebuilding the standby", async () => {
    world = makeSweep({ tracked: { status: "running" }, dockerRunning: false });

    await world.sweep();

    expect(world.stopPreview).toHaveBeenCalledWith(WARM_ID);
    expect(world.stopPreview.mock.invocationCallOrder[0])
      .toBeLessThan(world.destroy.mock.invocationCallOrder[0] ?? Infinity);
  });

  it("does not touch the preview of a healthy standby", async () => {
    world = makeSweep({ tracked: { status: "running" }, dockerRunning: true });

    await world.sweep();

    expect(world.stopPreview).not.toHaveBeenCalled();
  });

  it("re-runs the preview pre-start for a healthy standby", async () => {
    world = makeSweep({ tracked: { status: "running" }, dockerRunning: true });

    await world.sweep();

    expect(world.repairPreview).toHaveBeenCalledWith({
      sessionId: WARM_ID,
      workspaceDir: "/sessions/warm-1/workspace",
      repoUrl: URL,
    });
    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
    expect(world.destroy).not.toHaveBeenCalled();
  });

  it("does not repair the preview of a session a claim has just taken", async () => {
    world = makeSweep({ tracked: { status: "running" }, dockerRunning: true });
    world.claim();

    await world.sweep();

    expect(world.repairPreview).not.toHaveBeenCalled();
  });

  it("does not repair a preview when Docker could not answer", async () => {
    world = makeSweep({ tracked: { status: "running" }, dockerRunning: undefined });

    await world.sweep();

    expect(world.repairPreview).not.toHaveBeenCalled();
  });

  it("hands the rebuild a live ownership check, not a snapshot", async () => {
    world = makeSweep({ dockerRunning: false });

    await world.sweep();

    const opts = world.ensureStandbyForWarmSession.mock.calls[0]![0] as { stillWanted?: () => boolean };
    expect(opts.stillWanted?.()).toBe(true);
    world.claim();
    expect(opts.stillWanted?.()).toBe(false);
  });

  it("rebuilds when the tracking map holds no container at all", async () => {
    world = makeSweep({ tracked: null });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).toHaveBeenCalledTimes(1);
  });

  it("leaves a healthy standby alone", async () => {
    world = makeSweep({ dockerRunning: true });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
    expect(world.destroy).not.toHaveBeenCalled();
  });

  it("does not act on a container that is still being created", async () => {
    world = makeSweep({ tracked: { status: "starting" }, dockerRunning: false });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("does not act when Docker could not answer", async () => {
    world = makeSweep({ dockerRunning: undefined });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("does nothing while ShipIt is at its memory budget", async () => {
    world = makeSweep({ dockerRunning: false });
    world.setMemory(atBudget());

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
    expect(world.warmSessionForRepo).not.toHaveBeenCalled();
  });

  it("leaves a freshly warmed session alone until the grace window passes", async () => {
    world = makeSweep({ tracked: null, createdAt: new Date().toISOString() });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("warms a ready repo that has no warm session at all", async () => {
    world = makeSweep({ warmSessionId: undefined });

    await world.sweep();

    expect(world.warmSessionForRepo).toHaveBeenCalledWith(URL);
    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("clears the pointer and re-warms when the session row is gone", async () => {
    world = makeSweep({ sessionExists: false });

    await world.sweep();

    expect(world.setWarmSessionId).toHaveBeenCalledWith(URL, undefined);
    expect(world.warmSessionForRepo).toHaveBeenCalledWith(URL);
  });

  it("skips a repo that is not ready", async () => {
    world = makeSweep({ status: "cloning", dockerRunning: false });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });
});

describe("startWarmTierSweep — the timer", () => {
  function makeDeps(hold?: Promise<void>) {
    const passes: string[] = [];
    const warmSessionForRepo = vi.fn(async (url: string) => {
      passes.push(url);
      if (hold) await hold;
    });
    return {
      passes,
      deps: {
        repoStore: {
          list: () => [{ url: URL, status: "ready", warmSessionId: undefined }],
          get: () => ({ url: URL, status: "ready", warmSessionId: undefined }),
          setWarmSessionId: vi.fn(),
        } as unknown as RepoStore,
        sessionManager: { get: () => undefined } as unknown as SessionManager,
        containerManager: {
          get: () => undefined,
          isTrackedContainerRunning: async () => false,
          destroy: vi.fn(),
        } as unknown as SessionContainerManager,
        warmSessionForRepo,
        ensureStandbyForWarmSession: vi.fn(async () => undefined),
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => { vi.useRealTimers(); });

  it("runs a pass on every tick until it is cleared", async () => {
    const { passes, deps } = makeDeps();
    const timer = startWarmTierSweep(deps, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(passes).toHaveLength(2);

    clearInterval(timer);
    await vi.advanceTimersByTimeAsync(5000);
    expect(passes).toHaveLength(2);
  });

  it("skips a tick while the previous pass is still running", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { passes, deps } = makeDeps(hold);
    const timer = startWarmTierSweep(deps, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(passes).toHaveLength(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(passes).toHaveLength(2);

    clearInterval(timer);
  });

  it("does not hold the event loop open", () => {
    const { deps } = makeDeps();
    const timer = startWarmTierSweep(deps, { intervalMs: 1000 });
    expect(timer.hasRef()).toBe(false);
    clearInterval(timer);
  });
});

describe("warm tier sweep — concurrency and failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("never judges a repo whose warm is still in flight", async () => {
    const ensureStandbyForWarmSession = vi.fn(async () => undefined);
    const sweep = createWarmTierSweep({
      repoStore: {
        list: () => [{ url: URL, status: "ready", warmSessionId: WARM_ID }],
        get: () => ({ url: URL, status: "ready", warmSessionId: WARM_ID }),
        setWarmSessionId: vi.fn(),
      } as unknown as RepoStore,
      sessionManager: {
        get: () => ({ id: WARM_ID, workspaceDir: "/w/workspace", createdAt: OLD }),
      } as unknown as SessionManager,
      containerManager: {
        get: () => undefined,
        isTrackedContainerRunning: async () => false,
        destroy: vi.fn(),
      } as unknown as SessionContainerManager,
      warmSessionForRepo: vi.fn(async () => undefined),
      ensureStandbyForWarmSession,
      waitForWarmSession: () => Promise.resolve(),
    });

    await sweep();

    expect(ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("abandons the repair when a claim takes the session mid-probe", async () => {
    let claimed = false;
    const ensureStandbyForWarmSession = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const sweep = createWarmTierSweep({
      repoStore: {
        list: () => [{ url: URL, status: "ready", warmSessionId: WARM_ID }],
        get: () => ({ url: URL, status: "ready", warmSessionId: claimed ? undefined : WARM_ID }),
        setWarmSessionId: vi.fn(),
      } as unknown as RepoStore,
      sessionManager: {
        get: () => ({ id: WARM_ID, workspaceDir: "/w/workspace", createdAt: OLD }),
      } as unknown as SessionManager,
      containerManager: {
        get: () => ({ status: "running" }),
        isTrackedContainerRunning: async () => { claimed = true; return false; },
        destroy,
      } as unknown as SessionContainerManager,
      warmSessionForRepo: vi.fn(async () => undefined),
      ensureStandbyForWarmSession,
    });

    await sweep();

    expect(destroy).not.toHaveBeenCalled();
    expect(ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("keeps going after one repo's repair throws", async () => {
    const ensureStandbyForWarmSession = vi.fn(async (opts: { repoUrl: string }) => {
      if (opts.repoUrl === URL) throw new Error("docker exploded");
    });
    const sweep = createWarmTierSweep({
      repoStore: {
        list: () => [
          { url: URL, status: "ready", warmSessionId: "warm-a" },
          { url: `${URL}-2`, status: "ready", warmSessionId: "warm-b" },
        ],
        get: (u: string) => ({ url: u, status: "ready", warmSessionId: u === URL ? "warm-a" : "warm-b" }),
        setWarmSessionId: vi.fn(),
      } as unknown as RepoStore,
      sessionManager: {
        get: (id: string) => ({ id, workspaceDir: `/s/${id}/workspace`, createdAt: OLD }),
      } as unknown as SessionManager,
      containerManager: {
        get: () => undefined,
        isTrackedContainerRunning: async () => false,
        destroy: vi.fn(async () => undefined),
      } as unknown as SessionContainerManager,
      warmSessionForRepo: vi.fn(async () => undefined),
      ensureStandbyForWarmSession,
    });

    await sweep();

    expect(ensureStandbyForWarmSession).toHaveBeenCalledTimes(2);
  });
});
