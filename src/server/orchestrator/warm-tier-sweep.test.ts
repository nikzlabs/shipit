/**
 * Tests for the warm-tier repair sweep (planning#501, docs/288 req 10).
 *
 * The failure it exists for is invisible by construction: a standby has no
 * runner and no event stream, so the sweep's own liveness question — asked of
 * DOCKER, not of the tracking map — is the load-bearing part. A sweep that
 * trusted `containerManager.get(id).status` would be as blind as everything
 * else and would pass a test that never notices.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWarmTierSweep, WARM_REPAIR_GRACE_MS } from "./warm-tier-sweep.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DockerMemoryStats } from "../shared/types.js";

const URL = "https://github.com/acme/app";
const WARM_ID = "warm-1";

/** Older than the grace window, so the sweep is willing to judge it. */
const OLD = new Date(Date.now() - WARM_REPAIR_GRACE_MS - 60_000).toISOString();

interface World {
  warmSessionId?: string | undefined;
  status?: string;
  /** What the tracking map holds: `null` = no entry at all. */
  tracked: { status: string } | null;
  /** What DOCKER says. `undefined` = it could not answer. */
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
  const ensureStandbyForWarmSession = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const setWarmSessionId = vi.fn();
  let memory: DockerMemoryStats | null = null;

  const repoStore = {
    list: () => [{ url: URL, status: w.status, warmSessionId: w.warmSessionId }],
    // Re-read after the Docker probe — a claim may have taken the session.
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
    getMemoryStats: () => memory,
  });

  return {
    sweep,
    warmSessionForRepo,
    ensureStandbyForWarmSession,
    destroy,
    setWarmSessionId,
    setMemory: (m: DockerMemoryStats | null) => { memory = m; },
  };
}

/** A reading at the eviction line. */
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
    expect(world.ensureStandbyForWarmSession).toHaveBeenCalledWith({
      sessionId: WARM_ID,
      sessionDir: "/sessions/warm-1",
      workspaceDir: "/sessions/warm-1/workspace",
      repoUrl: URL,
    });
    // The row and the clone are fine — only the container died.
    expect(world.warmSessionForRepo).not.toHaveBeenCalled();
    expect(world.setWarmSessionId).not.toHaveBeenCalled();
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
    // `starting` is a real state the runner factory already knows how to wait
    // out; Docker would report it as not running.
    world = makeSweep({ tracked: { status: "starting" }, dockerRunning: false });

    await world.sweep();

    expect(world.ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("does not act when Docker could not answer", async () => {
    // During a daemon blip every session looks dead at once. Rebuilding them
    // all is worse than waiting for the next pass.
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
      // Warming sets `warmSessionId` before it builds the standby, so a
      // mid-warm session legitimately has no container yet.
      waitForWarmSession: () => Promise.resolve(),
    });

    await sweep();

    expect(ensureStandbyForWarmSession).not.toHaveBeenCalled();
  });

  it("abandons the repair when a claim takes the session mid-probe", async () => {
    // The Docker probe is long enough for a claim to land: it clears
    // `warmSessionId` and hands the session to a user who is opening it now.
    // Destroying that container would turn their warm claim cold.
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

    // The second repo may be the one the user is about to open.
    expect(ensureStandbyForWarmSession).toHaveBeenCalledTimes(2);
  });
});
