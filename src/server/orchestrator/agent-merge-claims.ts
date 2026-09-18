/** Written before the merge call: a failed response does not prove GitHub rejected it. */
import type { DatabaseManager } from "../shared/database.js";

/** Only pending requests can be replaced; later states may represent a completed merge. */
export type AgentMergeClaimState = "pending" | "merging" | "settling";

export type AgentMergeMethod = "merge" | "squash" | "rebase";

export function mergeMethodFor(method: string | undefined): AgentMergeMethod {
  return method === "squash" ? "squash" : method === "rebase" ? "rebase" : "merge";
}

export interface AgentMergeClaim {
  sessionId: string;
  repoId: string;
  prNumber: number;
  expectedSha: string;
  state: AgentMergeClaimState;
  method: AgentMergeMethod;
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

export function mergeRecordId(claim: Pick<AgentMergeClaim, "repoId" | "prNumber" | "expectedSha">): string {
  return `agent-merge:${claim.repoId}#${claim.prNumber}@${claim.expectedSha}`;
}

function fromRow(row: ClaimRow): AgentMergeClaim {
  return {
    sessionId: row.session_id,
    repoId: row.repo_id,
    prNumber: row.pr_number,
    expectedSha: row.expected_sha,
    state: row.state === "settling" ? "settling" : row.state === "pending" ? "pending" : "merging",
    method: row.method === "squash" ? "squash" : row.method === "rebase" ? "rebase" : "merge",
    origin: row.origin === "auto" ? "auto" : "direct",
    createdAt: row.created_at,
  };
}

export class AgentMergeClaimStore {
  private db;
  // Block reconciliation during live calls; after restart, reconcile the surviving rows.
  private readonly mergeInFlight = new Set<string>();

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  // Revoke unsent calls without deleting rows that may be evidence of a merge.
  private readonly mergeCancelled = new Set<string>();

  markMergeInFlight(sessionId: string): void {
    this.mergeInFlight.add(sessionId);
  }

  clearMergeInFlight(sessionId: string): void {
    this.mergeInFlight.delete(sessionId);
    this.mergeCancelled.delete(sessionId);
  }

  isMergeInFlight(sessionId: string): boolean {
    return this.mergeInFlight.has(sessionId);
  }

  isMergeCancelled(sessionId: string): boolean {
    return this.mergeCancelled.has(sessionId);
  }

  claim(claim: Omit<AgentMergeClaim, "state" | "origin" | "createdAt">): boolean {
    return this.write(claim, "merging", "direct");
  }

  arm(claim: Omit<AgentMergeClaim, "state" | "origin" | "createdAt">): boolean {
    return this.write(claim, "pending", "auto");
  }

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

  list(): AgentMergeClaim[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_merge_claims WHERE state != 'pending' ORDER BY created_at")
      .all() as ClaimRow[];
    return rows.map(fromRow);
  }

  getAttempt(sessionId: string): AgentMergeClaim | null {
    const claim = this.get(sessionId);
    return claim && claim.state !== "pending" ? claim : null;
  }

  listPending(): AgentMergeClaim[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_merge_claims WHERE state = 'pending' ORDER BY created_at")
      .all() as ClaimRow[];
    return rows.map(fromRow);
  }

  // Match the full identity: another PR can be armed at the same SHA during an await.
  beginMerging(claim: Pick<AgentMergeClaim, "sessionId" | "expectedSha" | "prNumber" | "repoId" | "method">): boolean {
    const res = this.db.prepare(
      `UPDATE agent_merge_claims SET state = 'merging'
       WHERE session_id = ? AND expected_sha = ? AND pr_number = ? AND repo_id = ? AND method = ?
         AND state = 'pending'`,
    ).run(claim.sessionId, claim.expectedSha, claim.prNumber, claim.repoId, claim.method);
    return res.changes > 0;
  }

  cancelPendingForRepo(repoId: string, record?: (claim: AgentMergeClaim) => void): AgentMergeClaim[] {
    let cancelled: AgentMergeClaim[] = [];
    this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM agent_merge_claims WHERE state = 'pending' AND repo_id = ?")
        .all(repoId) as ClaimRow[];
      this.db
        .prepare("DELETE FROM agent_merge_claims WHERE state = 'pending' AND repo_id = ?")
        .run(repoId);
      cancelled = rows.map(fromRow);
      for (const claim of cancelled) record?.(claim);

      const inFlight = this.db
        .prepare("SELECT session_id FROM agent_merge_claims WHERE state = 'merging' AND repo_id = ?")
        .all(repoId) as { session_id: string }[];
      for (const row of inFlight) {
        if (this.mergeInFlight.has(row.session_id)) this.mergeCancelled.add(row.session_id);
      }
    })();
    return cancelled;
  }

  /** Delete and record atomically; record must be synchronous and do no external I/O. */
  releasePending(
    claim: Pick<AgentMergeClaim, "sessionId" | "expectedSha" | "prNumber" | "repoId" | "method">,
    record?: () => void,
  ): boolean {
    let released = false;
    this.db.transaction(() => {
      const res = this.db.prepare(
        `DELETE FROM agent_merge_claims
         WHERE session_id = ? AND expected_sha = ? AND pr_number = ? AND repo_id = ? AND method = ?
           AND state = 'pending'`,
      ).run(claim.sessionId, claim.expectedSha, claim.prNumber, claim.repoId, claim.method);
      if (res.changes === 0) return;
      record?.();
      released = true;
    })();
    return released;
  }

  markSettling(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "UPDATE agent_merge_claims SET state = 'settling' WHERE session_id = ? AND expected_sha = ? AND state = 'merging'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  release(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ?",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  releaseUnmerged(sessionId: string, expectedSha: string): boolean {
    const res = this.db.prepare(
      "DELETE FROM agent_merge_claims WHERE session_id = ? AND expected_sha = ? AND state = 'merging'",
    ).run(sessionId, expectedSha);
    return res.changes > 0;
  }

  /** Record and delete atomically; record must be synchronous and do no external I/O. */
  releaseAfterRecording(sessionId: string, expectedSha: string, record: () => void): boolean {
    let released = false;
    this.db.transaction(() => {
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
