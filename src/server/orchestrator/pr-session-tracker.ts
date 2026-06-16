/**
 * PrSessionTracker — per-session / per-repo state owned by the PR poller.
 *
 * Split out of `pr-status-poller.ts` (docs/201 Phase P9). This is the
 * bookkeeping layer: it holds the in-memory maps the poll loop reads and
 * mutates (last-known PR summary, repo association, PR-tab focus, terminal
 * promotion, REST-verify debouncing, cached GraphQL nodes, last-push
 * timestamps) plus the pure query helpers that derive a poll's GraphQL
 * shape from that state. It owns no timers and makes no network or SSE
 * calls — the supervisor drives cadence and the poller owns I/O.
 */

import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GraphQLPrNode } from "./pr-status-parser.js";

/**
 * Cap for the bulk `pullRequests(first: N)` connection. Sessions whose PR is
 * past this cap fall through to the `verifyMissingPr` REST path. Kept at the
 * previous hard-coded value so behavior on big-PR-set repos is unchanged.
 */
const BULK_QUERY_MAX = 30;
/**
 * Floor for the bulk `pullRequests(first: N)` connection. Sized to absorb PRs
 * opened out-of-band on a tracked session's branch (e.g. user ran `gh pr
 * create` in the terminal) before that session has been observed at least
 * once, and to keep the post-restart first poll cheap when `lastKnown` is
 * empty. Tuned conservatively — bump if production sees too many REST
 * verify probes for sessions whose PRs are past the floor but inside the cap.
 *
 * See docs/155-pr-poll-query-scoping/plan.md Phase 1a.
 */
const BULK_QUERY_DISCOVERY_FLOOR = 5;

export class PrSessionTracker {
  /** sessionId → timestamp of the last auto-push the orchestrator notified about. */
  readonly lastAutoPushAt = new Map<string, number>();
  /** sessionId → last known PrStatusSummary (for diffing) */
  readonly lastKnown = new Map<string, PrStatusSummary>();
  /** sessionId → repo key tracking */
  readonly sessionRepos = new Map<string, string>();
  /**
   * Sessions whose PR tab is the active right-panel tab (docs/133 Phase 4).
   * Reported over WS via `pr_tab_active`. When any tracked session on a repo is
   * here, that repo's poll fetches the heavier conversation fields (issue
   * comments + review threads); otherwise the light query is used.
   */
  readonly prTabActiveSessions = new Set<string>();
  /** Sessions whose PRs have been merged or closed — excluded from future queries. */
  readonly mergedSessions = new Set<string>();
  /**
   * docs/202 — sessionId → the PR **number** of a superseded (merged) PR that a
   * re-armed session has moved past. While set, `verifyMissingPr` treats a
   * terminal (merged/closed) REST result carrying THIS number as "no current
   * PR" instead of re-promoting the session to merged — without it, the
   * immediate forced poll `reArm`→`trackSession` fires would re-find the old
   * merged PR via `findPullRequestAnyState` and clobber the freshly re-armed
   * card back to merged within one tick. Cleared the moment a PR with a
   * *different* number appears (the new PR opened), so normal tracking resumes.
   * Seeded from the persisted `previousMergedPr` breadcrumb on startup so the
   * suppression survives an orchestrator restart before the new PR exists.
   */
  readonly supersededPrNumbers = new Map<string, number>();
  /**
   * Sessions whose REST verify is currently running. Prevents two overlapping
   * polls (or a verify + the next poll) from both firing the same REST call.
   */
  readonly inFlightVerify = new Set<string>();
  /**
   * Sessions whose absence from the bulk GraphQL result has already been
   * REST-verified during the current "missing" episode. Cleared when the PR
   * reappears in a GraphQL response. Without this, every poll would re-fire
   * a REST probe for any session whose PR is past the `first: N` cap or
   * whose PR's true state didn't match the bulk view (e.g. due to a transient
   * GraphQL error window).
   */
  readonly verifiedAbsent = new Set<string>();
  /** sessionId → last known GraphQL PR node (cached for extracting check details). */
  readonly lastPrNodes = new Map<string, GraphQLPrNode>();

  /**
   * Drop all per-session state for a session being untracked (archived, PR
   * merged, etc.). Deliberately does NOT clear `mergedSessions`: the poller's
   * `untrackSession` leaves the terminal marker in place so a re-track of an
   * already-merged session doesn't re-promote it — matching the pre-split
   * behavior exactly.
   */
  untrack(sessionId: string): void {
    this.sessionRepos.delete(sessionId);
    this.lastKnown.delete(sessionId);
    this.lastPrNodes.delete(sessionId);
    this.inFlightVerify.delete(sessionId);
    this.verifiedAbsent.delete(sessionId);
    this.supersededPrNumbers.delete(sessionId);
    this.prTabActiveSessions.delete(sessionId);
    this.lastAutoPushAt.delete(sessionId);
  }

  /** True when at least one non-merged session is still tracked on this repo. */
  repoHasTrackedSessions(repoKey: string): boolean {
    for (const [sid, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (!this.mergedSessions.has(sid)) return true;
    }
    return false;
  }

  /**
   * Pick the bulk `pullRequests(first: N)` connection size for this poll.
   *
   * `N` is the count of non-merged sessions tracked on this repo, raised to
   * the discovery floor (so a brand-new repo with one session still picks up
   * out-of-band PRs) and capped at `BULK_QUERY_MAX` (sessions past the cap
   * fall through to `verifyMissingPr`).
   *
   * See docs/155-pr-poll-query-scoping/plan.md Phase 1a.
   */
  computeBulkFirst(repoKey: string): number {
    let trackedCount = 0;
    for (const [sessionId, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      trackedCount++;
    }
    return Math.min(BULK_QUERY_MAX, Math.max(trackedCount, BULK_QUERY_DISCOVERY_FLOOR));
  }

  /**
   * Collect PR numbers for the `focused${i}` aliases on this poll.
   *
   * A session contributes one focused alias iff its PR tab is active AND we
   * already know its PR number (from `lastKnown`). Sessions in
   * `prTabActiveSessions` whose first poll hasn't landed yet are skipped —
   * the next poll picks them up via the bulk view, then subsequent polls
   * upgrade to a focused alias with conversation fields.
   *
   * See docs/155-pr-poll-query-scoping/plan.md Phase 1b.
   */
  collectFocusedPrNumbers(repoKey: string): number[] {
    const numbers: number[] = [];
    for (const sessionId of this.prTabActiveSessions) {
      if (this.sessionRepos.get(sessionId) !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      const prNumber = this.lastKnown.get(sessionId)?.prNumber;
      if (typeof prNumber !== "number") continue;
      numbers.push(prNumber);
    }
    return numbers;
  }

  /**
   * Collect PR numbers for the `coverage${i}` aliases on this poll — one per
   * tracked, non-merged session on this repo whose PR number we already know.
   *
   * These light-field aliases guarantee a known tracked PR is always in the
   * query result regardless of the bulk `first: N` window: on a busy repo the
   * window can be smaller than the open-PR set, and even with `UPDATED_AT DESC`
   * ordering a tracked PR that hasn't been pushed to recently can sort below
   * the window. Aliasing by number makes windowing-out impossible for any PR
   * we've seen at least once. (A never-yet-seen PR has no known number yet; it
   * is discovered through the ordered bulk window, then sustained here.)
   *
   * See docs/155-pr-poll-query-scoping/plan.md Phase 1a.
   */
  collectCoveragePrNumbers(repoKey: string): number[] {
    const numbers: number[] = [];
    for (const [sessionId, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      const prNumber = this.lastKnown.get(sessionId)?.prNumber;
      if (typeof prNumber !== "number") continue;
      numbers.push(prNumber);
    }
    return numbers;
  }
}
