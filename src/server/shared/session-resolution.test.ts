import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./types.js";
import {
  doneSessionTest,
  isSessionDone,
  isTerminalPrResolved,
  isWorkResolved,
  resolvedAt,
  scheduledViewTest,
  workResolvedAt,
} from "./session-resolution.js";

function make(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "child", title: "Child", createdAt: "2026-08-14T09:00:00.000Z", lastUsedAt: "2026-08-14T10:00:00.000Z", remoteUrl: "", ...overrides };
}

describe("session resolution", () => {
  it("recognizes merged and closed sessions", () => {
    expect(resolvedAt(make({ mergedAt: "2026-08-14 11:00:00", closedAt: "2026-08-14 10:00:00" }))).toBe("2026-08-14 11:00:00");
    expect(isTerminalPrResolved(make({ closedAt: "2026-08-14 11:00:00" }))).toBe(true);
  });

  it("reactivates after a later turn across timestamp formats", () => {
    expect(isTerminalPrResolved(make({ mergedAt: "2026-08-14 10:00:00", lastUsedAt: "2026-08-14T10:00:00.001Z" }))).toBe(false);
  });

  it("keeps pinned sessions and visible coordinators active", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isSessionDone({ ...resolved, pinnedAt: "2026-08-14T12:00:00Z" }, { hasUnfinishedDescendant: false })).toBe(false);
    expect(isSessionDone(resolved, { hasUnfinishedDescendant: true })).toBe(false);
    expect(isSessionDone(resolved, { hasUnfinishedDescendant: false })).toBe(true);
  });

  it("keeps a session with a blocked workspace active", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isSessionDone({ ...resolved, workspaceBlock: "conflict" }, { hasUnfinishedDescendant: false })).toBe(false);
    expect(isSessionDone(resolved, { hasUnfinishedDescendant: false })).toBe(true);
  });

  it("keeps a session with a Keep preview running reservation active", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isSessionDone({ ...resolved, keepPreviewRunning: true }, { hasUnfinishedDescendant: false })).toBe(false);
  });

  it("derives the child context from the list, ignoring archived children", () => {
    const parent = make({ id: "parent", mergedAt: "2026-08-14 11:00:00" });
    const child = make({ id: "kid", parentSessionId: "parent" });
    expect(doneSessionTest([parent, child])(parent)).toBe(false);
    expect(doneSessionTest([parent, { ...child, userArchived: true, archived: true }])(parent)).toBe(true);
    expect(doneSessionTest([parent])(parent)).toBe(true);
  });

  it("counts only unfinished descendants, so a fully merged tree is done", () => {
    const parent = make({ id: "parent", mergedAt: "2026-08-14 11:00:00" });
    const child = make({ id: "kid", parentSessionId: "parent", rootSessionId: "parent", mergedAt: "2026-08-14 11:00:00" });
    const grandchild = make({ id: "grand", parentSessionId: "kid", rootSessionId: "parent" });
    expect(doneSessionTest([parent, child])(parent)).toBe(true);
    const isDone = doneSessionTest([parent, child, grandchild]);
    expect(isDone(parent)).toBe(false);
    expect(isDone(child)).toBe(false);
  });

  // The browser never gets archived rows or rows the cap hides, so neither may
  // change the answer for a row it does get.
  it("gives the same answer with or without rows the browser does not get", () => {
    const parent = make({ id: "parent", mergedAt: "2026-08-14 11:00:00" });
    const archivedMid = make({ id: "mid", parentSessionId: "parent", rootSessionId: "parent", userArchived: true, archived: true });
    const underArchived = make({ id: "low", parentSessionId: "mid", rootSessionId: "parent" });
    const mergedChild = make({ id: "done-kid", parentSessionId: "parent", rootSessionId: "parent", mergedAt: "2026-08-14 11:00:00" });
    const server = doneSessionTest([parent, archivedMid, underArchived, mergedChild]);
    const browser = doneSessionTest([parent, underArchived]);
    expect(server(parent)).toBe(false);
    expect(browser(parent)).toBe(false);
    expect(server(underArchived)).toBe(browser(underArchived));
    expect(doneSessionTest([parent, mergedChild])(parent)).toBe(doneSessionTest([parent])(parent));
  });
});

describe("docs/324-scheduled-sessions: a run's resolution", () => {
  const run = (overrides: Partial<SessionInfo> = {}) => make({ id: "run", scheduleId: "sched-1", ...overrides });

  it("is the saved finish, not the PR", () => {
    expect(isWorkResolved(run({ runFinishedAt: "2026-08-14T12:00:00.000Z" }))).toBe(true);
    expect(isWorkResolved(run({ mergedAt: "2026-08-14 11:00:00" }))).toBe(false);
    expect(workResolvedAt(run({ mergedAt: "2026-08-14 11:00:00" }))).toBeUndefined();
    expect(workResolvedAt(run({ runFinishedAt: "2026-08-14T12:00:00.000Z", mergedAt: "2026-08-14 11:00:00" })))
      .toBe("2026-08-14T12:00:00.000Z");
  });

  it("leaves any other session to its PR", () => {
    const merged = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isWorkResolved(merged)).toBe(true);
    expect(workResolvedAt(merged)).toBe("2026-08-14 11:00:00");
  });

  it("decides done the same way as for any other session", () => {
    const finished = run({ runFinishedAt: "2026-08-14T12:00:00.000Z" });
    expect(doneSessionTest([finished])(finished)).toBe(true);
    const pinned = { ...finished, pinnedAt: "2026-08-14T13:00:00Z" };
    expect(doneSessionTest([pinned])(pinned)).toBe(false);
    const child = make({ id: "kid", parentSessionId: "run", rootSessionId: "run" });
    expect(doneSessionTest([finished, child])(finished)).toBe(false);
  });

  it("puts a run and its spawn tree in the Scheduled view, and nothing else", () => {
    const parent = run();
    const grandchild = make({ id: "grand", parentSessionId: "kid", rootSessionId: "run" });
    const other = make({ id: "other" });
    const otherChild = make({ id: "other-kid", parentSessionId: "other", rootSessionId: "other" });
    const isScheduled = scheduledViewTest([parent, grandchild, other, otherChild]);
    expect([parent, grandchild, other, otherChild].map(isScheduled)).toEqual([true, true, false, false]);
  });
});
