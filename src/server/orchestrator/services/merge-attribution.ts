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
 * without a record of what this process did the observation could not tell an
 * outside merge from ShipIt's own. {@link noteMergePerformed} is that record.
 *
 * ## What the observed line may and may not claim
 *
 * The memory is per-process and deliberately not persisted, and there is a
 * narrow window in which a poll already in flight observes a merge before the
 * merge call's own continuation records it. So the observation cannot honestly
 * assert "nobody in ShipIt merged this" — only "no ShipIt path in this
 * orchestrator process recorded merging it", which is what its wording says.
 * That is still the positive record the requirement asked for: it distinguishes
 * a merge ShipIt performed from one it did not, and it names its own bound
 * instead of overstating. Persisting the set would close the restart case and
 * neither of the other two, for a durable write on every merge.
 *
 * ## Repository identity
 *
 * The key is lowercased because the two sides resolve owner/repo differently and
 * GitHub treats them case-insensitively: a performed merge parses the remote URL
 * the user configured (`resolveGitHubRemote`), while the poller switches to
 * GitHub's canonical `nameWithOwner` (`canonicalApiTarget`). Without the
 * normalization, a remote whose casing differs from GitHub's own would miss on
 * EVERY merge, not in some edge case. A repository RENAMED between a merge and
 * its observation still misses — the two names are genuinely different — and the
 * observed line's wording is what keeps that from becoming a false claim.
 *
 * ## Line content
 *
 * Every field is a ShipIt-controlled token: a session id, a PR number, an
 * owner/repo, a {@link MergeMethod}, and a fixed verb from {@link MergeVia}.
 * Nothing from the user's workspace (a PR title, a branch description, a GitHub
 * error string) may go in — the read-only ops log surface withholds any line
 * carrying free text, which would defeat the record.
 */

/** How a merge ShipIt performed itself was triggered. A closed set, on purpose. */
export type MergeVia = "the ShipIt merge button" | "gh pr merge";

/**
 * The merge methods GitHub accepts. Closed here so the formatter cannot be
 * handed free text. Both routes take `method?: string` off the request body and
 * cast it to this union unchecked before calling GitHub — that cast is
 * pre-existing and deliberately left alone (narrowing it would silently turn an
 * invalid method into a `merge`, a behaviour change). It is not a hole in
 * practice: GitHub rejects a method outside this set, so the merge fails and no
 * line is written.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

export interface PerformedMerge {
  owner: string;
  repo: string;
  prNumber: number;
  /** The ShipIt session the pull request belongs to. */
  sessionId: string;
  via: MergeVia;
  /** The merge method GitHub was asked for. */
  method: MergeMethod;
}

/**
 * PRs merged by this orchestrator process, as `owner/repo#number` lowercased.
 * Bounded and FIFO-evicted: the only reader is the terminal observation that
 * follows the merge by seconds, so a short memory is enough and an unbounded set
 * would grow for every PR the host ever merges.
 */
const performedHere = new Set<string>();
const PERFORMED_LIMIT = 256;

function key(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`.toLowerCase();
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
 * Record a merge no ShipIt path in this process performed — the GitHub web UI, a
 * laptop, or native auto-merge that GitHub executed on its own.
 *
 * Silent when this process performed the merge itself: that merge already has
 * its own line, and a second one naming a different actor would contradict it.
 * Call once per real merge (the poller's fire-once terminal edge), and call it
 * BEFORE persisting the terminal state — a crash in between would otherwise
 * leave the merge recorded as terminal with its record never written.
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
    + " via a merge no ShipIt path recorded (observed, not performed by this orchestrator process)",
  );
}

/** Test-only: drop the performed-merge memory so cases don't leak into each other. */
export function resetMergeAttribution(): void {
  performedHere.clear();
}
