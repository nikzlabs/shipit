import { describe, it, expect } from "vitest";
import { addUnreportedPr, MAX_UNREPORTED_PRS, unreportedPrs, withUnreportedPrs } from "./merge-watch-prs.js";
import type { SessionMergeWatch, SessionMergeWatchPr } from "../shared/types.js";

const pr = (prNumber: number, outcome: "merged" | "closed" = "merged"): SessionMergeWatchPr => ({
  outcome, prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, prTitle: `Step ${prNumber}`, branch: "b",
});
const WATCH: SessionMergeWatch = { parentSessionId: "parent", state: "delivered", registeredAt: "t0" };

describe("the PRs that a parent's watch still owes (docs/196-session-notify-on-merge)", () => {
  it("appends in order and keeps a PR one time", () => {
    const kept = addUnreportedPr([pr(8)], pr(9), "last");
    expect(kept.map((p) => p.prNumber)).toEqual([8, 9]);
    expect(addUnreportedPr(kept, pr(9), "last")).toBe(kept);
  });

  it("treats a close and a merge of one PR as two events", () => {
    const kept = addUnreportedPr([pr(8, "closed")], pr(8), "last");
    expect(kept.map((p) => p.outcome)).toEqual(["closed", "merged"]);
  });

  it("puts a PR that was not delivered in front, and moves it there when it was kept already", () => {
    expect(addUnreportedPr([pr(9), pr(8)], pr(8), "first").map((p) => p.prNumber)).toEqual([8, 9]);
  });

  it("does not keep a new PR past the cap", () => {
    const full = Array.from({ length: MAX_UNREPORTED_PRS }, (_, i) => pr(i + 1));
    expect(addUnreportedPr(full, pr(999), "last")).toBe(full);
  });

  it("a PR that goes back in front takes the place of no PR that was kept", () => {
    const full = Array.from({ length: MAX_UNREPORTED_PRS }, (_, i) => pr(i + 100));
    const restored = addUnreportedPr(full, pr(99), "first");
    expect(restored.map((p) => p.prNumber)).toEqual([99, ...full.map((p) => p.prNumber)]);
  });

  it("leaves out the PR that the parent already knows, when it reads and when it writes", () => {
    const reportedPr = { prNumber: 8, outcome: "merged" as const };
    expect(unreportedPrs({ ...WATCH, reportedPr, unreportedPrs: [pr(8), pr(9)] }).map((p) => p.prNumber)).toEqual([9]);
    expect(withUnreportedPrs({ ...WATCH, reportedPr }, [pr(8), pr(9)]).unreportedPrs?.map((p) => p.prNumber)).toEqual([9]);
  });

  it("writes no empty list", () => {
    const written = withUnreportedPrs({ ...WATCH, unreportedPrs: [pr(8)] }, []);
    expect("unreportedPrs" in written).toBe(false);
  });
});
