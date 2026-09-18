// Keep log fields free of user-authored text so the ops log surface can expose them.
export type MergeVia = "the ShipIt merge button" | "gh pr merge";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface PerformedMerge {
  owner: string;
  repo: string;
  prNumber: number;
  sessionId: string;
  via: MergeVia;
  method: MergeMethod;
}

// Process-local evidence only: restarts, renames, and in-flight polls can miss a performed merge.
const performedHere = new Set<string>();
const PERFORMED_LIMIT = 256;

function key(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`.toLowerCase();
}

// The managed loop writes its own log and uses this to suppress the later observation.
export function noteMergePerformed(owner: string, repo: string, prNumber: number): void {
  if (performedHere.size >= PERFORMED_LIMIT) {
    const oldest = performedHere.values().next();
    if (!oldest.done) performedHere.delete(oldest.value);
  }
  performedHere.add(key(owner, repo, prNumber));
}

export function logMergePerformed(m: PerformedMerge): void {
  noteMergePerformed(m.owner, m.repo, m.prNumber);
  console.log(
    `[pr] Merged PR #${m.prNumber} (${m.owner}/${m.repo}) for ${m.sessionId}`
    + ` via ${m.via} (${m.method})`,
  );
}

// Call before persisting the terminal edge so a crash cannot omit the merge record.
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

export function resetMergeAttribution(): void {
  performedHere.clear();
}
