import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  logMergeObserved,
  logMergePerformed,
  noteMergePerformed,
  resetMergeAttribution,
} from "./merge-attribution.js";

/**
 * docs/266 req 7 — the merge record. The requirement exists because an ops
 * review of PR #2327 could not tell who merged it: the managed loop, the merge
 * button, `gh pr merge`, and GitHub's own web UI all produced the same silence.
 *
 * These pin the two things a log line can lose without anyone noticing: its
 * SHAPE (the four lines must read as one family and grep with one pattern) and
 * the rule that decides whether the observation speaks at all.
 */
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

  // The sandbox route can merge a PR in a repository that is not the session's
  // own, so the owner/repo field is the only thing saying which one was touched.
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

  // Nothing in ShipIt performs a web-UI merge, so the record has to come from the
  // observer — and it has to say "observed", not "performed", or the line claims
  // an action ShipIt never took.
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

  // The whole point of the memory: the poller observes ShipIt's own merge moments
  // after the route performs it. Without this the record would contradict itself,
  // and "we did not merge it" would stop being trustworthy.
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

  // The managed auto-merge loop logs its own line (unchanged since docs/266) and
  // only notes the merge here, so the observation must honour a bare note too.
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

  // The two sides resolve owner/repo differently — a performed merge parses the
  // remote URL the user configured, the poller uses GitHub's canonical
  // `nameWithOwner` — and GitHub treats the two case-insensitively. Without the
  // normalization a remote whose casing differs from GitHub's own misses on
  // EVERY merge, so every ShipIt merge would also be reported as an outside one.
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

  // A different PR in the same repo, and the same PR number in a different repo,
  // are different merges — the key has to carry all three parts.
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

  // The set is bounded because it lives for the process. Its reader runs seconds
  // after the write, so evicting the oldest entries is free — but an unbounded
  // set would grow for every PR the host ever merges.
  it("bounds the memory, evicting oldest first", () => {
    const c = capture();
    try {
      for (let i = 0; i < 300; i++) noteMergePerformed("o", "r", i);

      // Newest survive.
      logMergeObserved({ owner: "o", repo: "r", prNumber: 299, sessionId: "s1" });
      expect(c.lines()).toEqual([]);

      // Oldest evicted — an observation for it is no longer suppressed.
      logMergeObserved({ owner: "o", repo: "r", prNumber: 0, sessionId: "s1" });
      expect(c.lines()).toHaveLength(1);
    } finally {
      c.restore();
    }
  });

  // One grep has to find all four lines. This pins the three emitted here; the
  // fourth (the managed loop's, which this module only notes) is held to the
  // same pattern by `auto-merge-manager.test.ts`.
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
