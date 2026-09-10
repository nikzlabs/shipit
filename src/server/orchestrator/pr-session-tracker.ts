import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GraphQLPrNode } from "./pr-status-parser.js";

const BULK_QUERY_MAX = 30;
const BULK_QUERY_DISCOVERY_FLOOR = 5;

export class PrSessionTracker {
  readonly lastAutoPushAt = new Map<string, number>();
  readonly lastKnown = new Map<string, PrStatusSummary>();
  readonly sessionRepos = new Map<string, string>();
  readonly prTabActiveSessions = new Set<string>();
  readonly mergedSessions = new Set<string>();
  // Suppress the old terminal PR after re-arming, until a different PR appears.
  readonly supersededPrNumbers = new Map<string, number>();
  readonly inFlightVerify = new Set<string>();
  // Probe once per absence episode; clear when GraphQL returns the PR again.
  readonly verifiedAbsent = new Set<string>();
  readonly lastPrNodes = new Map<string, GraphQLPrNode>();

  untrack(sessionId: string): void {
    // Retain the terminal marker so re-tracking cannot promote the same merged PR again.
    this.sessionRepos.delete(sessionId);
    this.lastKnown.delete(sessionId);
    this.lastPrNodes.delete(sessionId);
    this.inFlightVerify.delete(sessionId);
    this.verifiedAbsent.delete(sessionId);
    this.supersededPrNumbers.delete(sessionId);
    this.prTabActiveSessions.delete(sessionId);
    this.lastAutoPushAt.delete(sessionId);
  }

  repoHasTrackedSessions(repoKey: string): boolean {
    for (const [sid, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (!this.mergedSessions.has(sid)) return true;
    }
    return false;
  }

  computeBulkFirst(repoKey: string): number {
    let trackedCount = 0;
    for (const [sessionId, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      trackedCount++;
    }
    return Math.min(BULK_QUERY_MAX, Math.max(trackedCount, BULK_QUERY_DISCOVERY_FLOOR));
  }

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

  // Query known PRs by number so a busy repository cannot push them outside the bulk window.
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
