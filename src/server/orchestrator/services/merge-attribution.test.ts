import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  logMergeObserved,
  logMergePerformed,
  noteMergePerformed,
  resetMergeAttribution,
} from "./merge-attribution.js";

describe("merge attribution", () => {
  beforeEach(() => {
    resetMergeAttribution();
  });

  function capture(): { lines: () => string[]; restore: () => void } {
    const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
    return {
      lines: () => log.mock.calls.map((c) => String(c[0])),
      restore: () => { log.mockRestore(); },
    };
  }

  it("records the merge button with session, PR, repo and method", () => {
    const c = capture();
    try {
      logMergePerformed({
        owner: "o", repo: "r", prNumber: 7, sessionId: "s1",
        via: "the ShipIt merge button", method: "squash",
      });
      expect(c.lines()).toEqual([
        "[pr] Merged PR #7 (o/r) for s1 via the ShipIt merge button (squash)",
      ]);
    } finally {
      c.restore();
    }
  });

  it("records gh pr merge against the repository it actually named", () => {
    const c = capture();
    try {
      logMergePerformed({
        owner: "other", repo: "proj", prNumber: 12, sessionId: "s2",
        via: "gh pr merge", method: "merge",
      });
      expect(c.lines()).toEqual([
        "[pr] Merged PR #12 (other/proj) for s2 via gh pr merge (merge)",
      ]);
    } finally {
      c.restore();
    }
  });

  it("records an outside merge as observed rather than performed", () => {
    const c = capture();
    try {
      logMergeObserved({ owner: "o", repo: "r", prNumber: 9, sessionId: "s3" });
      expect(c.lines()).toEqual([
        "[pr-poller] Merged PR #9 (o/r) for s3"
        + " via a merge no ShipIt path recorded (observed, not performed by this orchestrator process)",
      ]);
    } finally {
      c.restore();
    }
  });

  it("stays silent when this process performed the merge via a route", () => {
    const c = capture();
    try {
      logMergePerformed({
        owner: "o", repo: "r", prNumber: 7, sessionId: "s1",
        via: "the ShipIt merge button", method: "squash",
      });
      logMergeObserved({ owner: "o", repo: "r", prNumber: 7, sessionId: "s1" });

      expect(c.lines().filter((l) => l.includes("no ShipIt path recorded"))).toEqual([]);
      expect(c.lines()).toHaveLength(1);
    } finally {
      c.restore();
    }
  });

  it("stays silent when the managed loop noted the merge without logging", () => {
    const c = capture();
    try {
      noteMergePerformed("o", "r", 42);
      logMergeObserved({ owner: "o", repo: "r", prNumber: 42, sessionId: "s1" });

      expect(c.lines()).toEqual([]);
    } finally {
      c.restore();
    }
  });

  it("matches across the casing difference between a remote URL and GitHub's canonical name", () => {
    const c = capture();
    try {
      noteMergePerformed("NikZLabs", "ShipIt", 42);
      logMergeObserved({ owner: "nikzlabs", repo: "shipit", prNumber: 42, sessionId: "s1" });

      expect(c.lines()).toEqual([]);
    } finally {
      c.restore();
    }
  });

  it("does not silence a different PR or a same-numbered PR elsewhere", () => {
    const c = capture();
    try {
      noteMergePerformed("o", "r", 7);
      logMergeObserved({ owner: "o", repo: "r", prNumber: 8, sessionId: "s1" });
      logMergeObserved({ owner: "o", repo: "other", prNumber: 7, sessionId: "s2" });

      expect(c.lines()).toHaveLength(2);
    } finally {
      c.restore();
    }
  });

  it("bounds the memory, evicting oldest first", () => {
    const c = capture();
    try {
      for (let i = 0; i < 300; i++) noteMergePerformed("o", "r", i);

      logMergeObserved({ owner: "o", repo: "r", prNumber: 299, sessionId: "s1" });
      expect(c.lines()).toEqual([]);

      logMergeObserved({ owner: "o", repo: "r", prNumber: 0, sessionId: "s1" });
      expect(c.lines()).toHaveLength(1);
    } finally {
      c.restore();
    }
  });

  it("shares one greppable prefix across every performed and observed line", () => {
    const c = capture();
    try {
      logMergePerformed({
        owner: "o", repo: "r", prNumber: 1, sessionId: "s1",
        via: "the ShipIt merge button", method: "squash",
      });
      logMergePerformed({
        owner: "o", repo: "r", prNumber: 2, sessionId: "s1",
        via: "gh pr merge", method: "merge",
      });
      logMergeObserved({ owner: "o", repo: "r", prNumber: 3, sessionId: "s1" });

      for (const line of c.lines()) expect(line).toMatch(/Merged PR #\d+ \(\S+\/\S+\) for \S+ via /);
    } finally {
      c.restore();
    }
  });
});
