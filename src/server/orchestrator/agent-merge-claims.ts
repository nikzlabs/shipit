/**
 * docs/287-agent-merge-per-repo §4 — the durable record that an agent merge was
 * attempted, written BEFORE the REST call and deleted only once its outcome has
 * been recorded.
 *
 * The merge call is a plain `fetch`, and it can reject *after* GitHub accepted
 * the request. The row is what turns "we do not know" into a question that can
 * be answered later: a surviving row is resolved by reading THAT pull request in
 * THAT repository and asking whether `expected_sha` is merged. The shape of the
 * failure is never consulted — a socket error and a 500 look identical whether
 * or not the merge landed.
 *
 * `merging` means the outcome is unknown and reconciliation owns the row.
 * `settling` means a merge response came back and its effects are being written;
 * that one bit is what stops a stale "still open" read from erasing the proof.
 *
 * One row per session, by primary key. `ON DELETE CASCADE` means deleting a
 * session takes its claim with it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";

export type AgentMergeClaimState = "merging" | "settling";

export interface AgentMergeClaim {
  sessionId: string;
  /** `github:<owner>/<repo>`, case-normalised — see `git-utils.ts` `repoId`. */
  repoId: string;
  prNumber: number;
  /** The head the merge gate observed, and the commit the merge was pinned to. */
  expectedSha: string;
  /** The turn that owns this claim. See {@link currentTurnId}. */
  turnId: string;
  state: AgentMergeClaimState;
  createdAt: string;
}

interface ClaimRow {
  session_id: string;
  repo_id: string;
  pr_number: number;
  expected_sha: string;
  turn_id: string;
  state: string;
  created_at: string;
}

/**
 * A per-PROCESS prefix for turn identities. `runner.turnEpoch` restarts at 0
 * whenever a runner is recreated, so a bare epoch would let turn 0 of a previous
 * process read as the turn running now. The prefix makes that comparison fail
 * closed.
 */
const PROCESS_TURN_PREFIX = randomUUID().slice(0, 8);

/** The identity of the turn currently running on a runner. */
export function currentTurnId(turnEpoch: number): string {
  return `${PROCESS_TURN_PREFIX}:${turnEpoch}`;
}

/**
 * The merge's stable natural identity, for correlating log lines across a
 * restart. Built only from durable row values, so a resumed settlement derives
 * the string the first attempt did.
 */
export function mergeRecordId(claim: Pick<AgentMergeClaim, "repoId" | "prNumber" | "expectedSha">): string {
  return `agent-merge:${claim.repoId}#${claim.prNumber}@${claim.expectedSha}`;
}

function fromRow(row: ClaimRow): AgentMergeClaim {
  return {
    sessionId: row.session_id,
    repoId: row.repo_id,
    prNumber: row.pr_number,
    expectedSha: row.expected_sha,
    turnId: row.turn_id,
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
   * either state refuses the new claim, and the caller refuses the merge.
   *
   * Replacing a row loses a merge that is still in flight. A claims and GitHub
   * merges, but A's response is slow; B replaces A's row, gets "already merged",
   * and releases it; A returns to find no row and reports the merge as settled.
   * Merged, unrecorded, unrecoverable. Refusing makes that sequence impossible.
   *
   * A row left by a crashed attempt does block the next merge. That is the
   * intended direction — the reconciliation triggers resolve it, and until then
   * "an earlier attempt is unresolved" is the honest answer.
   */
  claim(claim: Omit<AgentMergeClaim, "state" | "createdAt">): boolean {
    // A bare INSERT, so the PRIMARY KEY enforces single-flight. A second
    // orchestrator on the same database is not in this event loop, and its
    // conflict must refuse rather than throw out of the route.
    try {
      this.db.prepare(
        `INSERT INTO agent_merge_claims
           (session_id, repo_id, pr_number, expected_sha, turn_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'merging', ?)`,
      ).run(
        claim.sessionId, claim.repoId, claim.prNumber, claim.expectedSha,
        claim.turnId, new Date().toISOString(),
      );
      return true;
    } catch (err) {
      // The route turns `false` into one refusal message; this says which of
      // the reasons it was — conflict, missing session, read-only database.
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
   * Release a claim whose merge did NOT happen — a definitive refusal. The
   * `state = 'merging'` filter keeps "only an unresolved attempt may be
   * discarded" in the statement: a `settling` row means a merge happened.
   */
  releaseUnmerged(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ? AND state = 'merging'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /**
   * Write the merge's transcript record and drop the claim **atomically**.
   *
   * "Record, then delete" is not crash-idempotent: a crash between the two
   * produces a second notice when recovery re-settles the surviving row. Both
   * writes are synchronous SQLite against one database, so a transaction removes
   * the window. `record` must therefore be synchronous and do no I/O.
   */
  releaseAfterRecording(sessionId: string, expectedSha: string, record: () => void): boolean {
    let released = false;
    this.db.transaction(() => {
      // The row is the permission to record, checked INSIDE the transaction so
      // two overlapping settlements cannot both write: the second finds it gone.
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
