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
    expect(isTerminalPrResolved(make({ mergedAt: "2026-08-14 10:00:00", lastUsedAt: "2026-08-14T10:00:00.001Z" }))).toBe(false);
  });

  it("keeps pinned sessions and visible coordinators active", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isSessionDone({ ...resolved, pinnedAt: "2026-08-14T12:00:00Z" }, { hasLiveChild: false })).toBe(false);
    expect(isSessionDone(resolved, { hasLiveChild: true })).toBe(false);
    expect(isSessionDone(resolved, { hasLiveChild: false })).toBe(true);
  });

  it("keeps a session with a blocked workspace active", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isSessionDone({ ...resolved, workspaceBlock: "conflict" }, { hasLiveChild: false })).toBe(false);
    expect(isSessionDone(resolved, { hasLiveChild: false })).toBe(true);
  });

  it("keeps a session with a Keep preview running reservation active", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isSessionDone({ ...resolved, keepPreviewRunning: true }, { hasLiveChild: false })).toBe(false);
  });

  it("derives the child context from the list, ignoring archived children", () => {
    const parent = make({ id: "parent", mergedAt: "2026-08-14 11:00:00" });
    const child = make({ id: "kid", parentSessionId: "parent" });
    expect(doneSessionTest([parent, child])(parent)).toBe(false);
    expect(doneSessionTest([parent, { ...child, userArchived: true, archived: true }])(parent)).toBe(true);
    expect(doneSessionTest([parent])(parent)).toBe(true);
  });
});
