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

export interface WsGitIdentityRequired {
  type: "git_identity_required";
}

export interface WsGitIdentitySet {
  type: "git_identity_set";
  name: string;
  email: string;
}

export interface WsGitPushRejected {
  type: "git_push_rejected";
  reason: "non_fast_forward";
  message: string;
}

export interface WsRebaseStarted {
  type: "rebase_started";
  sessionId: string;
  baseBranch: string;
}

export interface WsRebaseConflicts {
  type: "rebase_conflicts";
  sessionId: string;
  conflicts: { path: string }[];
}

export interface WsRebaseComplete {
  type: "rebase_complete";
  sessionId: string;
  forcePushed: boolean;
  upToDate?: boolean;
  /** A persisted base-sync card replaces the up-to-date toast. */
  baseMoved?: boolean;
}

export interface WsRebaseAborted {
  type: "rebase_aborted";
  sessionId: string;
  /** Server failure; absent for user-initiated aborts. */
  reason?: string;
}

export interface WsAutoResolveStarted {
  type: "auto_resolve_started";
  sessionId: string;
  baseBranch: string;
  /** One-based. */
  attempt: number;
}

export interface WsAutoResolveResult {
  type: "auto_resolve_result";
  sessionId: string;
  /** Only exhausted is terminal and renders the failure banner. */
  outcome: "success" | "exhausted" | "deferred" | "error";
  attempt: number;
  forcePushed?: boolean;
  /** Required for exhausted. */
  lastError?: string;
}
