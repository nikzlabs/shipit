import { describe, it, expect, vi } from "vitest";
import { BackgroundTaskTracker, BACKGROUND_TASK_TTL_MS } from "./background-task-tracker.js";

/**
 * docs/235 — the tracker is a deliberately *lossy* view of the agent backend's
 * background work. The backend reports its task list only when it changes, with
 * no heartbeat and no pull API, so these tests pin the two bounds that keep a
 * dropped event from pinning a session permanently unreclaimable.
 */
describe("BackgroundTaskTracker", () => {
  const task = (id: string, description?: string) => ({ id, type: "local_bash", description });

  it("reports the count while a streaming process is resident", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a"), task("b")]);
    expect(t.count(true)).toBe(2);
  });

  it("replaces the list wholesale rather than merging", () => {
    // The backend sends the complete current set, never a delta — so a second
    // event with one task means one task, not three.
    const t = new BackgroundTaskTracker();
    t.set([task("a"), task("b")]);
    t.set([task("c")]);
    expect(t.count(true)).toBe(1);
    expect(t.descriptions(true)).toEqual(["c"]);
  });

  it("treats an empty list as drained", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a")]);
    t.set([]);
    expect(t.count(true)).toBe(0);
  });

  it("reports zero when no streaming process is resident", () => {
    // A background task cannot outlive the CLI process — the CLI reaps its
    // background work on exit. So without a live streaming process the honest
    // answer is zero regardless of what the last event said.
    const t = new BackgroundTaskTracker();
    t.set([task("a")]);
    expect(t.count(false)).toBe(0);
    expect(t.descriptions(false)).toEqual([]);
  });

  it("decays a stale count so a dropped drain event can't strand a session", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a")]);
    // Capture the boundary after set(): set records its own Date.now(), which
    // can advance by a millisecond between two calls under CI load.
    const now = Date.now();
    // Just inside the window: still trusted.
    expect(t.count(true, now + BACKGROUND_TASK_TTL_MS - 1)).toBe(1);
    // Past it: we would rather under-report (and let the next real event
    // correct us) than hold `agentBusy` true forever.
    expect(t.count(true, now + BACKGROUND_TASK_TTL_MS)).toBe(0);
    expect(t.descriptions(true, now + BACKGROUND_TASK_TTL_MS)).toEqual([]);
  });

  it("still trusts the count through a long silent background task", () => {
    // The regression this pins: a background bash task emits NOTHING between
    // `task_started` and completion (2026-09-09 probe — two 30-minute tasks,
    // zero events, one of them printing every 15s). So `seenAt` is set once at
    // start and the TTL is the whole protection a long job gets. At the old
    // ten-minute value this session read as idle 20 minutes before its work
    // finished, and the idle enforcer was free to reclaim the container.
    const t = new BackgroundTaskTracker();
    t.set([task("a", "sleep 1800")]);
    const now = Date.now();
    expect(t.count(true, now + 30 * 60_000)).toBe(1);
    expect(t.descriptions(true, now + 30 * 60_000)).toEqual(["sleep 1800"]);
  });

  it("expires exactly one hour after the list last changed", () => {
    // The literal hour is the contract, not an incidental value: a stale count
    // reads as busy, and a busy session cannot be reclaimed for memory, cannot
    // descend a disk tier, and returns 409 on a manual merge. Written as
    // elapsed times rather than as the exported constant, so that changing the
    // constant has to be a deliberate edit here too.
    vi.useFakeTimers();
    try {
      const t = new BackgroundTaskTracker();
      t.set([task("a", "sleep 3600")]);
      const start = Date.now();
      expect(t.count(true, start + 60 * 60_000 - 1)).toBe(1);
      expect(t.count(true, start + 60 * 60_000)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the window when any later list update arrives", () => {
    // `set()` replaces the WHOLE list and stamps `seenAt` for all of it, so a
    // SECOND task starting or finishing renews protection for the first. This
    // is why the agent-facing docs say the window runs from the list's last
    // change and not from the task's start — the difference is unbounded.
    vi.useFakeTimers();
    try {
      const t = new BackgroundTaskTracker();
      t.set([task("a", "long")]);
      vi.advanceTimersByTime(59 * 60_000);
      t.set([task("a", "long"), task("b", "short")]); // b starts
      t.set([task("a", "long")]); // b finishes — still non-empty, so still a stamp
      const renewed = Date.now();
      // `a` has now been outstanding for ~118 minutes and still counts.
      expect(t.count(true, renewed + 59 * 60_000)).toBe(1);
      expect(t.count(true, renewed + 60 * 60_000)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears everything on demand", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a")]);
    t.clear();
    expect(t.count(true)).toBe(0);
  });

  it("falls back to the task id when the backend gave no description", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("abc123", undefined)]);
    expect(t.descriptions(true)).toEqual(["abc123"]);
  });
});
