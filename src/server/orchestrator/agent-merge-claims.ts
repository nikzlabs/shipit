/**
 * docs/287-agent-merge-per-repo §4 — the durable record that an agent merge was
 * attempted, written BEFORE the REST call and deleted once its outcome has been
 * recorded.
 *
 * The call can reject AFTER GitHub accepted it, so the row turns "we do not
 * know" into a question answerable later: is `expected_sha` merged in THAT pull
 * request? The failure's shape is never consulted. `merging` means the outcome
 * is unknown; `settling` means a response came back, which stops a stale "still
 * open" read erasing the proof. One row per session, by primary key.
 */
import type { DatabaseManager } from "../shared/database.js";

/**
 * docs/288 — `pending` is a REQUEST, not an attempt: `gh pr merge --auto` wrote
 * it and the executor has not called GitHub yet. That is why it, alone, may be
 * replaced or cleared by anything.
 */
export type AgentMergeClaimState = "pending" | "merging" | "settling";

export type AgentMergeMethod = "merge" | "squash" | "rebase";

/** The `gh pr merge --squash|--rebase` flag, narrowed. Unknown reads as `merge`. */
export function mergeMethodFor(method: string | undefined): AgentMergeMethod {
  return method === "squash" ? "squash" : method === "rebase" ? "rebase" : "merge";
}

export interface AgentMergeClaim {
  sessionId: string;
  /** `github:<owner>/<repo>`, case-normalised — see `git-utils.ts` `repoId`. */
  repoId: string;
  prNumber: number;
  /** The head the merge gate observed, and the commit the merge was pinned to. */
  expectedSha: string;
  state: AgentMergeClaimState;
  /** docs/288 — a request is performed long after the flag was passed. */
  method: AgentMergeMethod;
  /** `direct` for `gh pr merge`, `auto` for a request the executor carries out. */
  origin: "direct" | "auto";
  createdAt: string;
}

interface ClaimRow {
  session_id: string;
  repo_id: string;
  pr_number: number;
  expected_sha: string;
  state: string;
  method: string;
  origin: string;
  created_at: string;
}

/** The merge's natural identity, for correlating log lines across a restart. */
export function mergeRecordId(claim: Pick<AgentMergeClaim, "repoId" | "prNumber" | "expectedSha">): string {
  return `agent-merge:${claim.repoId}#${claim.prNumber}@${claim.expectedSha}`;
}

function fromRow(row: ClaimRow): AgentMergeClaim {
  return {
    sessionId: row.session_id,
    repoId: row.repo_id,
    prNumber: row.pr_number,
    expectedSha: row.expected_sha,
    // Unknown reads as `merging`: the state that grants the fewest powers.
    state: row.state === "settling" ? "settling" : row.state === "pending" ? "pending" : "merging",
    method: row.method === "squash" ? "squash" : row.method === "rebase" ? "rebase" : "merge",
    origin: row.origin === "auto" ? "auto" : "direct",
    createdAt: row.created_at,
  };
}

export class AgentMergeClaimStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  /**
   * Record a merge about to be attempted. **Single-flight** against an attempt;
   * it supersedes a docs/288 request, which `gh pr merge` makes redundant.
   *
   * A row left `merging` by a crash does block the next merge, which is the
   * intended direction; the reconciliation triggers resolve it.
   */
  claim(claim: Omit<AgentMergeClaim, "state" | "origin" | "createdAt">): boolean {
    return this.write(claim, "merging", "direct");
  }

  /**
   * docs/288 req 1 — record a REQUEST: `gh pr merge --auto` asking ShipIt to
   * merge this exact commit once its checks pass. Refused over an attempt, for
   * the same single-flight reason; a `pending` row is replaced, because an agent
   * that pushes again and re-arms at the new commit is the ordinary case.
   */
  arm(claim: Omit<AgentMergeClaim, "state" | "origin" | "createdAt">): boolean {
    return this.write(claim, "pending", "auto");
  }

  /**
   * The single-flight rule, in one place. An attempt whose outcome is unknown
   * (`merging`) or still being written (`settling`) may never be written over:
   * replacing one loses a merge still in flight — A merges but answers slowly, B
   * replaces A's row and releases it on "already merged", A finds nothing to
   * settle. A `pending` row is not an attempt and carries no such risk.
   */
  private write(
    claim: Omit<AgentMergeClaim, "state" | "origin" | "createdAt">,
    state: AgentMergeClaimState,
    origin: "direct" | "auto",
  ): boolean {
    try {
      let written = false;
      this.db.transaction(() => {
        const row = this.db
          .prepare("SELECT state FROM agent_merge_claims WHERE session_id = ?")
          .get(claim.sessionId) as { state: string } | undefined;
        if (row && row.state !== "pending") return;
        this.db.prepare(
          `INSERT OR REPLACE INTO agent_merge_claims
             (session_id, repo_id, pr_number, expected_sha, state, method, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          claim.sessionId, claim.repoId, claim.prNumber, claim.expectedSha,
          state, claim.method, origin, new Date().toISOString(),
        );
        written = true;
      })();
      return written;
    } catch (err) {
      // A second orchestrator holding the write lock lands here, which is the
      // safe answer. The route turns `false` into one message; this says why.
      console.warn(`[agent-merge] claim refused for ${claim.sessionId}:`, err);
      return false;
    }
  }

  get(sessionId: string): AgentMergeClaim | null {
    const row = this.db
      .prepare("SELECT * FROM agent_merge_claims WHERE session_id = ?")
      .get(sessionId) as ClaimRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Every outstanding ATTEMPT, for reconciliation. Deliberately excludes
   * `pending`: reconciliation resolves a merge whose outcome is unknown, and a
   * request has not been attempted — settlement would read it as "not merged"
   * and delete the very row the executor is waiting to act on.
   */
  list(): AgentMergeClaim[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_merge_claims WHERE state != 'pending' ORDER BY created_at")
      .all() as ClaimRow[];
    return rows.map(fromRow);
  }

  /**
   * The session's outstanding ATTEMPT, or null. Same exclusion as {@link list}
   * and for the same reason: settlement asks "did this merge?" and DELETES the
   * row when the answer is no, which would destroy a request that has not been
   * attempted at all.
   */
  getAttempt(sessionId: string): AgentMergeClaim | null {
    const claim = this.get(sessionId);
    return claim && claim.state !== "pending" ? claim : null;
  }

  /** docs/288 — the executor's work list, oldest first. */
  listPending(): AgentMergeClaim[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_merge_claims WHERE state = 'pending' ORDER BY created_at")
      .all() as ClaimRow[];
    return rows.map(fromRow);
  }

  /**
   * docs/288 — `pending → merging`, the instant before the REST call. The
   * `state = 'pending'` filter is what makes two executors, or an executor and a
   * revocation, unable to both act on one request.
   */
  beginMerging(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "UPDATE agent_merge_claims SET state = 'merging' WHERE session_id = ? AND expected_sha = ? AND state = 'pending'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /**
   * docs/288 req 4 — the whole of revocation. Only `pending` rows: a row past it
   * is being settled or resolved from its tuple and can no longer merge
   * anything, so there is nothing left to cancel. Returns the cancelled rows so
   * the caller can tell each session why.
   */
  cancelPendingForRepo(repoId: string): AgentMergeClaim[] {
    let cancelled: AgentMergeClaim[] = [];
    this.db.transaction(() => {
      // Read then delete, both filtered the same way and both inside the
      // transaction, so the returned rows are exactly the ones that went.
      const rows = this.db
        .prepare("SELECT * FROM agent_merge_claims WHERE state = 'pending' AND repo_id = ?")
        .all(repoId) as ClaimRow[];
      this.db
        .prepare("DELETE FROM agent_merge_claims WHERE state = 'pending' AND repo_id = ?")
        .run(repoId);
      cancelled = rows.map(fromRow);
    })();
    return cancelled;
  }

  /** docs/288 — end a request that will not be carried out. `pending` only. */
  releasePending(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ? AND state = 'pending'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /** The merge is known to have happened; its effects are now being written. */
  markSettling(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      // `merging` only: `settling` is proof a response came back, and a docs/288
      // request has not been attempted at all.
      "UPDATE agent_merge_claims SET state = 'settling' WHERE session_id = ? AND expected_sha = ? AND state = 'merging'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /** Drop the claim — settlement written, or GitHub definitively refused. */
  release(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ?",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /**
   * Release a claim whose merge did NOT happen. The `state = 'merging'` filter
   * keeps "only an unresolved attempt may be discarded" in the statement.
   */
  releaseUnmerged(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ? AND state = 'merging'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /**
   * Write the transcript record and drop the claim **atomically** — "record,
   * then delete" produces a second notice when recovery re-settles the row after
   * a crash between the two. `record` must be synchronous and do no I/O.
   */
  releaseAfterRecording(sessionId: string, expectedSha: string, record: () => void): boolean {
    let released = false;
    this.db.transaction(() => {
      // The row is the permission to record, checked inside the transaction so
      // two overlapping settlements cannot both write.
      const row = this.db
        .prepare("SELECT session_id FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ?")
        .get(sessionId, expectedSha);
      if (!row) return;
      record();
      released = this.release(sessionId, expectedSha);
    })();
    return released;
  }
}
