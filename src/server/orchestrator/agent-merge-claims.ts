/**
 * docs/287-agent-merge-per-repo §4 — the durable record that an agent merge was
 * attempted, written BEFORE the REST call and deleted only once its outcome has
 * been recorded.
 *
 * ## Why a row exists at all
 *
 * The merge call is a plain `fetch`, and it can reject *after* GitHub accepted
 * the request. Without a durable row, a transport error, a timeout or a crash in
 * that window destroys the only evidence that a merge happened: the process
 * comes back with a merged pull request, a session that never learned about it,
 * and nothing in the transcript. The row turns "we do not know" into a question
 * that can be answered later, from the row's own tuple.
 *
 * ## Resolved from the tuple, never from the error
 *
 * A surviving `merging` row is resolved by reading THAT pull request in THAT
 * repository and asking whether `expected_sha` is merged. The shape of the
 * failure says nothing — a socket error and a 500 look identical whether or not
 * the merge landed — so it is never consulted.
 *
 * ## The two states
 *
 * - **`merging`** — the REST call is in flight, or its outcome was
 *   indeterminate. Reconciliation owns it.
 * - **`settling`** — the merge is known to have happened and its effects are
 *   being written. The row outlives the writes so a crash mid-settlement is
 *   recoverable; settlement is idempotent on the row's natural identity.
 *
 * One row per session, by primary key: a session runs one turn at a time, and a
 * turn performs at most one merge. `ON DELETE CASCADE` means deleting a session
 * takes its claim with it.
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
 * A per-PROCESS random prefix for turn identities.
 *
 * `runner.turnEpoch` is a per-runner counter that restarts at 0 whenever a
 * runner is recreated — a container restart, an orchestrator restart. A bare
 * epoch would therefore let a claim written by turn 0 of a previous process read
 * as "the currently active turn" during turn 0 of the next one, and a stale
 * claim would write session state into an unrelated turn. Prefixing with a value
 * that cannot repeat makes that comparison fail closed instead.
 */
const PROCESS_TURN_PREFIX = randomUUID().slice(0, 8);

/** The identity of the turn currently running on a runner. */
export function currentTurnId(turnEpoch: number): string {
  return `${PROCESS_TURN_PREFIX}:${turnEpoch}`;
}

/**
 * The merge record's stable natural identity (req 11).
 *
 * Built ONLY from durable row values, so a settlement resumed after a restart
 * derives the same string the first attempt did — which is what makes the
 * transcript notice and the merge record fire once rather than once per
 * recovery. A random id would defeat the whole point.
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
   * Replacing a row was the obvious reading of "one turn, one merge", and it was
   * wrong in both states. A `settling` row is proof that a merge HAPPENED and
   * its effects are still being written, so replacing it discards that proof. A
   * `merging` row is an attempt whose outcome nobody has learned YET — replacing
   * it loses a merge that is still in flight:
   *
   *   A claims and GitHub performs the merge, but A's response is slow. B claims
   *   and replaces A's row. B gets "already merged", a definitive refusal, and
   *   releases the row. A finally returns merged, finds no row of its own, and
   *   reports the merge as already settled. The pull request merged; nothing
   *   recorded it and nothing will (cross-agent review finding).
   *
   * Refusing instead makes that sequence impossible: B never reaches the REST
   * call. A row left behind by a crashed or unresolved attempt does block the
   * next merge, which is the intended direction — it is resolved by the three
   * reconciliation triggers (end of turn, session activation, startup), and
   * until then "an earlier attempt is unresolved" is the honest answer.
   */
  claim(claim: Omit<AgentMergeClaim, "state" | "createdAt">): boolean {
    // A bare INSERT, so the primary key enforces single-flight rather than the
    // read above it: `get` and `run` are both synchronous here, but a second
    // orchestrator on the same database is not in this process's event loop, and
    // a conflict there must refuse rather than throw its way out of the route.
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
      // Every reason to land here refuses the merge, so none of them may be
      // silent: a conflicting row, a session deleted under the foreign key, a
      // read-only database. The route turns `false` into one refusal message;
      // this line is what says which of them it was.
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

  /**
   * The merge is known to have happened; its effects are now being written.
   *
   * Guarded on the SHA so a late transition cannot promote a row that has since
   * been replaced by a newer attempt. Returns false when nothing matched.
   */
  markSettling(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "UPDATE agent_merge_claims SET state = 'settling' WHERE session_id = ? AND expected_sha = ?",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /**
   * Drop the claim — after settlement is written, or when GitHub definitively
   * refused. Guarded on the SHA for the same reason as {@link markSettling}.
   */
  release(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ?",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /**
   * Release a claim whose merge did NOT happen — a definitive refusal.
   *
   * The `state = 'merging'` filter keeps the "only an unresolved attempt may be
   * discarded" rule inside the statement rather than in the caller's argument.
   * Single-flight {@link claim} already stops a second request from ever seeing
   * another request's `settling` row, so this is the belt to that braces: a
   * `settling` row means a merge HAPPENED, and no refusal path may delete one.
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
   * "Record, then delete" is not crash-idempotent on its own: a transcript
   * notice gets a random id, so a crash between the append and the delete
   * produces a second notice when recovery re-settles the surviving row. One
   * transaction removes the window rather than trying to detect it afterwards —
   * both writes are synchronous SQLite against the same database, so either the
   * record and the release both land or neither does.
   *
   * `record` must therefore be synchronous and must not perform I/O.
   */
  releaseAfterRecording(sessionId: string, expectedSha: string, record: () => void): boolean {
    let released = false;
    this.db.transaction(() => {
      // The row is the permission to record. Checked INSIDE the transaction so
      // two settlements that overlap — the turn's own and a reconciliation pass
      // that fired at the end of that turn — cannot both write the record: the
      // second finds the row gone and writes nothing.
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
