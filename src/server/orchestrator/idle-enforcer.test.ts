import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleEnforcer, DONE_SESSION_RECLAIM_AFTER_MS } from "./idle-enforcer.js";
import type { IdleServiceHooks } from "./idle-enforcer.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { DockerMemoryStats, SessionInfo } from "../shared/types.js";

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

function harness(sessions: SessionInfo[], runner?: FakeRunner | (() => FakeRunner | undefined)) {
  const current = () => (typeof runner === "function" ? runner() : runner);
  const destroy = vi.fn().mockResolvedValue(undefined);
  const stopServices = vi.fn();
  const dispose = vi.fn(() => {
    const r = current();
    if (r) (r as { disposed: boolean }).disposed = true;
  });
  const containerManager = {
    get: (id: string) => (id === ID ? { sessionId: ID } : undefined),
    getAll: () => [{ sessionId: ID }],
    isStandby: () => false,
    destroy,
    destroyAgentContainer: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionContainerManager;
  const services: IdleServiceHooks = { liveSessions: () => [ID], has: (id) => id === ID, stop: stopServices };
  const sessionManager = {
    listAll: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id),
  } as unknown as SessionManager;
  const runnerRegistry = {
    get: (id: string) => (id === ID ? current() : undefined),
    dispose,
  } as unknown as SessionRunnerRegistry;
  const enforce = createIdleEnforcer({
    containerManager, runnerRegistry, sessionManager, services, getMemoryStats: () => underBudget,
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

  it("leaves a done session the user has open, and stops it a wait after they leave (req 8)", () => {
    const runner = { viewerCount: 1, agentBusy: false, disposed: false, queueLength: 0, lastViewerDetachAt: 0 };
    const { enforce, destroy } = harness([session()], runner);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();

    runner.viewerCount = 0;
    runner.lastViewerDetachAt = Date.now();
    enforce();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAIT);
    enforce();
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("keeps the wait after the viewer leaves when the runner is gone before it ends (req 8)", () => {
    const runner = { viewerCount: 0, agentBusy: false, disposed: false, queueLength: 0, lastViewerDetachAt: 0 };
    let current: typeof runner | undefined = runner;
    const { enforce, destroy } = harness([session()], () => current);
    enforce();
    vi.advanceTimersByTime(WAIT - 60_000);
    runner.lastViewerDetachAt = Date.now();
    enforce();
    current = undefined;
    vi.advanceTimersByTime(120_000);
    enforce();
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAIT);
    enforce();
    expect(destroy).toHaveBeenCalledWith(ID);
  });

  it("leaves a done session whose agent is busy", () => {
    const runner = { viewerCount: 0, agentBusy: true, disposed: false, queueLength: 0, lastViewerDetachAt: 0 };
    const { enforce, destroy } = harness([session()], runner);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("leaves a merged parent with a live child", () => {
    const child = session({ id: "child", parentSessionId: ID, mergedAt: undefined });
    const { enforce, destroy } = harness([session(), child]);
    afterWait(enforce);
    expect(destroy).not.toHaveBeenCalled();
  });
});
