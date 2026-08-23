/**
 * The merge record (docs/266 req 7): which session, which pull request, and who
 * performed the merge.
 *
 * The requirement was written after an ops review of PR #2327 could not tell who
 * merged it, because no merge path logged anything. The managed auto-merge loop
 * grew its line first (`auto-merge-manager.ts`, which still emits its own); this
 * module carries the other three so all four read as one family and grep with a
 * single pattern — `Merged PR #`.
 *
 * It also answers the one question the poller cannot answer alone. A merge ShipIt
 * performs is observed a second time by `verifyMissingPr` seconds later, so
 * without a record of what this process did the observation could neither report
 * an outside merge as one nor stay quiet about ShipIt's own — the whole point
 * being that "we did not merge it" becomes a positive record instead of an
 * inference from silence. {@link noteMergePerformed} is that record.
 *
 * The memory is per-process and deliberately not persisted: its only reader runs
 * within seconds of the write, and an orchestrator restart inside that window
 * degrades to reporting a ShipIt merge as an outside one. That is a log being a
 * record rather than a proof — persisting it would buy an incident review
 * nothing it does not already get from the performed-merge line itself.
 *
 * Every line here carries ShipIt-controlled tokens only: a session id, a PR
 * number, an owner/repo, a merge method, and a fixed verb from {@link MergeVia}.
 * Nothing from the user's workspace (a PR title, a branch description, a GitHub
 * error string) may go in — the read-only ops log surface withholds any line
 * carrying free text, which would defeat the record.
 */

/** How a merge ShipIt performed itself was triggered. A closed set, on purpose. */
export type MergeVia = "the ShipIt merge button" | "gh pr merge";

export interface PerformedMerge {
  owner: string;
  repo: string;
  prNumber: number;
  /** The ShipIt session the pull request belongs to. */
  sessionId: string;
  via: MergeVia;
  /** The merge method GitHub was asked for. */
  method: string;
}

/**
 * PRs merged by this orchestrator process, as `owner/repo#number`. Bounded and
 * FIFO-evicted: the only reader is the terminal observation that follows the
 * merge by seconds, so a short memory is enough and an unbounded set would
 * outlive every session that filled it.
 */
const performedHere = new Set<string>();
const PERFORMED_LIMIT = 256;

function key(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

/**
 * Remember a merge this process performed, without logging it. For the managed
 * auto-merge loop, which emits its own line and only needs the observation that
 * follows to stay quiet.
 */
export function noteMergePerformed(owner: string, repo: string, prNumber: number): void {
  if (performedHere.size >= PERFORMED_LIMIT) {
    const oldest = performedHere.values().next();
    if (!oldest.done) performedHere.delete(oldest.value);
  }
  performedHere.add(key(owner, repo, prNumber));
}

/** Record and log a merge this process performed. */
export function logMergePerformed(m: PerformedMerge): void {
  noteMergePerformed(m.owner, m.repo, m.prNumber);
  console.log(
    `[pr] Merged PR #${m.prNumber} (${m.owner}/${m.repo}) for ${m.sessionId}`
    + ` via ${m.via} (${m.method})`,
  );
}

/**
 * Record a merge this process only *observed* — the GitHub web UI, a laptop, or
 * native auto-merge that GitHub executed on its own.
 *
 * Silent when this process performed the merge itself: that merge already has
 * its own line, and a second one claiming an outside actor would contradict it.
 * Call once per real merge (the poller's fire-once terminal edge).
 */
export function logMergeObserved(m: {
  owner: string;
  repo: string;
  prNumber: number;
  sessionId: string;
}): void {
  if (performedHere.has(key(m.owner, m.repo, m.prNumber))) return;
  console.log(
    `[pr-poller] Merged PR #${m.prNumber} (${m.owner}/${m.repo}) for ${m.sessionId}`
    + " via a merge outside ShipIt (observed, not performed by this orchestrator)",
  );
}

/** Test-only: drop the performed-merge memory so cases don't leak into each other. */
export function resetMergeAttribution(): void {
  performedHere.clear();
}
