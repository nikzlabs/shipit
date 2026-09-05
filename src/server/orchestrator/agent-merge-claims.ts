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

export type AgentMergeClaimState = "merging" | "settling";

export interface AgentMergeClaim {
  sessionId: string;
  /** `github:<owner>/<repo>`, case-normalised — see `git-utils.ts` `repoId`. */
  repoId: string;
  prNumber: number;
  /** The head the merge gate observed, and the commit the merge was pinned to. */
  expectedSha: string;
  state: AgentMergeClaimState;
  createdAt: string;
}

interface ClaimRow {
  session_id: string;
  repo_id: string;
  pr_number: number;
  expected_sha: string;
  state: string;
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
    state: row.state === "settling" ? "settling" : "merging",
    createdAt: row.created_at,
  };
}

export class AgentMergeClaimStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  /**
   * Record a merge about to be attempted. **Single-flight**: an existing row of
   * either state refuses the new claim.
   *
   * Replacing a row loses a merge still in flight: A merges but answers slowly,
   * B replaces A's row and releases it on "already merged", A finds nothing to
   * settle. A row left by a crash does block the next merge, which is the
   * intended direction; the reconciliation triggers resolve it.
   */
  claim(claim: Omit<AgentMergeClaim, "state" | "createdAt">): boolean {
    // A bare INSERT, so the PRIMARY KEY enforces single-flight even against a
    // second orchestrator, which is not in this event loop.
    try {
      this.db.prepare(
        `INSERT INTO agent_merge_claims
           (session_id, repo_id, pr_number, expected_sha, state, created_at)
         VALUES (?, ?, ?, ?, 'merging', ?)`,
      ).run(
        claim.sessionId, claim.repoId, claim.prNumber, claim.expectedSha,
        new Date().toISOString(),
      );
      return true;
    } catch (err) {
      // The route turns `false` into one message; this says which reason.
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

  /** Every outstanding claim, for reconciliation at startup. */
  list(): AgentMergeClaim[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_merge_claims ORDER BY created_at")
      .all() as ClaimRow[];
    return rows.map(fromRow);
  }

  /** The merge is known to have happened; its effects are now being written. */
  markSettling(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "UPDATE agent_merge_claims SET state = 'settling' WHERE session_id = ? AND expected_sha = ?",
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
