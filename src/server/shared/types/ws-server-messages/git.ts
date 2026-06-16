import type { GitCommitInfo } from "../domain-types.js";

export interface WsGitLog {
  type: "git_log";
  commits: GitCommitInfo[];
}

export interface WsGitCommitted {
  type: "git_committed";
  hash: string;
  message: string;
}

// ---- Git identity messages ----

export interface WsGitIdentityRequired {
  type: "git_identity_required";
}

export interface WsGitIdentitySet {
  type: "git_identity_set";
  name: string;
  email: string;
}

// ---- Rebase messages (server → client) ----

/** Server → Client: git push was rejected due to non-fast-forward (branch has diverged). */
export interface WsGitPushRejected {
  type: "git_push_rejected";
  reason: "non_fast_forward";
  message: string;
}

/** Server → Client: rebase has started. */
export interface WsRebaseStarted {
  type: "rebase_started";
  baseBranch: string;
}

/** Server → Client: rebase encountered conflicts. */
export interface WsRebaseConflicts {
  type: "rebase_conflicts";
  conflicts: { path: string }[];
}

/** Server → Client: rebase completed successfully. */
export interface WsRebaseComplete {
  type: "rebase_complete";
  forcePushed: boolean;
  /**
   * Set when the branch already contained every commit from the base branch,
   * so no rebase ran (the ancestry short-circuit in `runRebaseFlow`). Lets the
   * client confirm a no-op "Sync with main" click — otherwise a manual sync
   * that had nothing to do would flash the banner and vanish silently.
   */
  upToDate?: boolean;
}

/** Server → Client: rebase was aborted. */
export interface WsRebaseAborted {
  type: "rebase_aborted";
  /**
   * Set when the abort was caused by a server-side failure (e.g. fetch
   * error, unresolvable base ref, non-conflict git rebase failure, runner
   * busy). Absent for user-initiated aborts via the `/rebase/abort`
   * endpoint, where reaching idle is the intended outcome.
   */
  reason?: string;
}

/**
 * Server → Client: an auto-resolve-conflicts attempt has started. (docs/146)
 *
 * Fires from the rebase-driver wrapper at the top of an attempt. The inner
 * `rebase_started` / `rebase_conflicts` / `rebase_complete` events still fire
 * from `runRebaseFlow` as a side effect — this envelope is the outer
 * attempt-loop signal carrying `attempt` (only meaningful in the retry
 * context).
 */
export interface WsAutoResolveStarted {
  type: "auto_resolve_started";
  sessionId: string;
  baseBranch: string;
  /** 1-indexed attempt number. Pairs with the same field on WsAutoResolveResult. */
  attempt: number;
}

/**
 * Server → Client: an auto-resolve-conflicts attempt has settled. (docs/146)
 *
 * `success`, `error`, and `deferred` are per-attempt outcomes. `exhausted` is
 * the manager-emitted terminal envelope (cap reached) and is the only outcome
 * the failure banner renders.
 */
export interface WsAutoResolveResult {
  type: "auto_resolve_result";
  sessionId: string;
  outcome: "success" | "exhausted" | "deferred" | "error";
  /** 1-indexed; matches the `attempt` field on the prior WsAutoResolveStarted for the same attempt. */
  attempt: number;
  /**
   * Only meaningful when outcome === "success". Mirrors WsRebaseComplete.forcePushed
   * so the PR-card sub-banner can optionally show "rebased locally, push deferred"
   * without listening to two channels.
   */
  forcePushed?: boolean;
  /** Failure / defer reason. Required when outcome === "exhausted" — the failure banner needs it. */
  lastError?: string;
}
