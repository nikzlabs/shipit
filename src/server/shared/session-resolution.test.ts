import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./types.js";
import { isResolvedForGrouping, isTerminalPrResolved, resolvedAt } from "./session-resolution.js";

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
    expect(isResolvedForGrouping({ ...resolved, pinnedAt: "2026-08-14T12:00:00Z" }, { hasVisibleBrood: false })).toBe(false);
    expect(isResolvedForGrouping(resolved, { hasVisibleBrood: true })).toBe(false);
    expect(isResolvedForGrouping(resolved, { hasVisibleBrood: false })).toBe(true);
  });

  it("keeps a running session active when its PR becomes terminal mid-turn", () => {
    const resolved = make({ mergedAt: "2026-08-14 11:00:00" });
    expect(isResolvedForGrouping(resolved, { hasVisibleBrood: false, isRunning: true })).toBe(false);
  });
});
