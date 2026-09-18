import { describe, it, expect, vi } from "vitest";
import { BackgroundTaskTracker, BACKGROUND_TASK_TTL_MS } from "./background-task-tracker.js";

describe("BackgroundTaskTracker", () => {
  const task = (id: string, description?: string) => ({ id, type: "local_bash", description });

  it("reports the count while a streaming process is resident", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a"), task("b")]);
    expect(t.count(true)).toBe(2);
  });

  it("replaces the list wholesale rather than merging", () => {
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
    const t = new BackgroundTaskTracker();
    t.set([task("a")]);
    expect(t.count(false)).toBe(0);
    expect(t.descriptions(false)).toEqual([]);
  });

  it("decays a stale count so a dropped drain event can't strand a session", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a")]);
    const now = Date.now();
    expect(t.count(true, now + BACKGROUND_TASK_TTL_MS - 1)).toBe(1);
    expect(t.count(true, now + BACKGROUND_TASK_TTL_MS)).toBe(0);
    expect(t.descriptions(true, now + BACKGROUND_TASK_TTL_MS)).toEqual([]);
  });

  it("still trusts the count through a long silent background task", () => {
    const t = new BackgroundTaskTracker();
    t.set([task("a", "sleep 1800")]);
    const now = Date.now();
    expect(t.count(true, now + 30 * 60_000)).toBe(1);
    expect(t.descriptions(true, now + 30 * 60_000)).toEqual(["sleep 1800"]);
  });

  it("expires exactly one hour after the list last changed", () => {
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
    vi.useFakeTimers();
    try {
      const t = new BackgroundTaskTracker();
      t.set([task("a", "long")]);
      vi.advanceTimersByTime(59 * 60_000);
      t.set([task("a", "long"), task("b", "short")]);
      t.set([task("a", "long")]);
      const renewed = Date.now();
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
