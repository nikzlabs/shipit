import { describe, it, expect } from "vitest";
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

  it("bounds the decay to a single window", () => {
    // A stale count reads as busy, and a busy session is never reclaimed, so
    // the cost of a dropped event has to be bounded rather than open-ended —
    // long enough to outlast a real build, short enough to not be forever.
    expect(BACKGROUND_TASK_TTL_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(BACKGROUND_TASK_TTL_MS).toBeLessThanOrEqual(4 * 3_600_000);
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
