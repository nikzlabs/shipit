import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./types.js";
import { doneSessionTest, isSessionDone, isTerminalPrResolved, resolvedAt } from "./session-resolution.js";

function make(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "child", title: "Child", createdAt: "2026-08-14T09:00:00.000Z", lastUsedAt: "2026-08-14T10:00:00.000Z", remoteUrl: "", ...overrides };
}

describe("session resolution", () => {
  it("recognizes merged and closed sessions", () => {
    expect(resolvedAt(make({ mergedAt: "2026-08-14 11:00:00", closedAt: "2026-08-14 10:00:00" }))).toBe("2026-08-14 11:00:00");
    expect(isTerminalPrResolved(make({ closedAt: "2026-08-14 11:00:00" }))).toBe(true);
  });

  it("reactivates after a later turn across timestamp formats", () => {
    expect(isTerminalPrResolved(make({ mergedAt: "2026-08-14 10:00:00", lastUsedAt: "2026-08-14T10:00:01.000Z" }))).toBe(false);
  });

  // docs/316-done-sessions-return-memory: SQLite keeps the merge time to the second.
  it("does not reactivate on use in the same second as the merge", () => {
    expect(isTerminalPrResolved(make({ mergedAt: "2026-08-14 10:00:00", lastUsedAt: "2026-08-14T10:00:00.700Z" }))).toBe(true);
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
