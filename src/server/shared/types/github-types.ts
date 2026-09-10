import type { GitHubDeploymentStatus } from "./deployment-types.js";

export interface WsGitHubStatus {
  type: "github_status";
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  /** Invalid stored token; absent on normal logout. */
  tokenInvalidReason?: string;
}

export interface WsGitHubPushResult {
  type: "github_push_result";
  success: boolean;
  message: string;
  branch?: string;
}

export interface WsGitHubRemotes {
  type: "github_remotes";
  remotes: { name: string; url: string }[];
}

export interface WsGitHubBranches {
  type: "github_branches";
  current: string;
  remote: string[];
}

export interface WsGitHubSearchResults {
  type: "github_search_results";
  repos: {
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }[];
}

export interface WsPrStatus {
  type: "pr_status";
  pr: {
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    checks: {
      state: "pending" | "success" | "failure" | "none";
      total: number;
      passed: number;
      failed: number;
      pending: number;
    };
    autoMergeEnabled: boolean;
    mergeable: PrMergeableState;
    reviewDecision: PrReviewDecision;
  } | null;
}

/** GitHub reports unknown while recomputing mergeability; it is not a conflict. */
export type PrMergeableState = "mergeable" | "conflicting" | "unknown";

/** GitHub null maps to none (non-blocking); required/changes-requested block merging. */
export type PrReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

// Ahead/diverged can omit local work from a merge. Behind means the remote includes local ancestry.
export type BranchSyncState = "in-sync" | "ahead" | "behind" | "diverged";

export interface BranchSyncStatus {
  state: BranchSyncState;
  ahead: number;
  behind: number;
}

export interface CIFailureLog {
  checkName: string;
  conclusion: string;
  summary: string;
  annotations: {
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }[];
  errorLines: string[];
  logExcerpt: string;
  logFilePath?: string;
}

export interface AutoFixState {
  /** Resets when head SHA changes. */
  attemptCount: number;
  lastHeadSha: string;
  status: "idle" | "running" | "deferred" | "exhausted";
  lastError?: string;
  nextEligibleAt?: number;
}

export interface PrAutoMergeError {
  code: "auto_merge_not_enabled" | "no_branch_protection";
  message: string;
  settingsUrl: string;
}

// Only native-unavailable indicates repo configuration trouble; the others retain ShipIt's safety gates.
export type AutoMergeManagedReason = "native-unavailable" | "session-live" | "branch-unsynced";

export interface AutoMergeState {
  enabled: boolean;
  mergeMethod: "squash" | "merge" | "rebase";
  managed?: boolean;
  /** Absent on legacy state means native-unavailable. */
  managedReason?: AutoMergeManagedReason;
  settingsUrl?: string;
  reason?: string;
  error?: PrAutoMergeError;
  /** Internal: merge call succeeded; keep enabled until polling confirms, and do not retry. */
  completed?: boolean;
}

export interface PrCommentAuthor {
  login: string;
  avatarUrl: string;
}

export type PrAuthor = PrCommentAuthor;

export interface PrIssueComment {
  id: string;
  author: PrCommentAuthor;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrReviewThreadComment {
  id: string;
  author: PrCommentAuthor;
  body: string;
  createdAt: string;
}

export interface PrReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: PrReviewThreadComment[];
}

export interface PrStatusSummary {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prBody: string;
  prCreatedAt?: string;
  prAuthor?: PrAuthor;
  prState: "open" | "merged" | "closed";
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  files?: PrFileStat[];
  checks: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    failedChecks?: { name: string; summary: string }[];
    /** Epoch ms: expire synthetic pending-with-zero-checks even while polling is paused. */
    graceUntil?: number;
  };
  mergeable: PrMergeableState;
  reviewDecision: PrReviewDecision;
  /** Absent means unknown and does not block; only ahead/diverged block merging. */
  branchSync?: BranchSyncStatus;
  autoMergeEnabled: boolean;
  autoFix?: {
    status: "idle" | "running" | "deferred" | "exhausted";
    attemptCount: number;
    maxAttempts: number;
  };
  deployments?: GitHubDeploymentStatus[];
  /** Undefined means not fetched; [] means no comments. */
  issueComments?: PrIssueComment[];
  /** Same fetch semantics as issueComments. */
  reviewThreads?: PrReviewThread[];
  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    managed?: boolean;
    managedReason?: AutoMergeManagedReason;
    settingsUrl?: string;
    reason?: string;
    error?: PrAutoMergeError;
  };
  /** Omitted when auto-resolution is disabled so its failure banner stays hidden. */
  autoResolve?: {
    status: "idle" | "running" | "deferred" | "exhausted";
    attemptCount: number;
    maxAttempts: number;
    lastError?: string;
    nextEligibleAt?: number;
  };
}

export interface PrFileStat {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

export interface NotableFileChange {
  path: string;
  label: string;
  kind: "doc" | "config" | "image";
  /** Renames and copies map to M. */
  status: "M" | "A" | "D";
}

export interface WsPrLifecycleUpdate {
  type: "pr_lifecycle_update";
  sessionId: string;
  cardId: string;
  phase: "ready" | "creating" | "open" | "merged" | "error";
  headBranch?: string;
  files?: PrFileStat[];
  totalInsertions?: number;
  totalDeletions?: number;
  /** Omission preserves the client's last list. */
  notableFiles?: NotableFileChange[];
  pr?: {
    number: number;
    title: string;
    body?: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
  };
  checks?: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    managed?: boolean;
    managedReason?: AutoMergeManagedReason;
    settingsUrl?: string;
    reason?: string;
    error?: PrAutoMergeError;
  };
  errorMessage?: string;
  /** Also permits this re-armed card to replace a stale terminal card. */
  previousMergedPr?: {
    number: number;
    url: string;
    title: string;
    baseBranch: string;
  };
}

/** Patch only the file list; leave poller-owned phase, checks, and PR state intact. */
export interface WsPrNotableFiles {
  type: "pr_notable_files";
  sessionId: string;
  cardId: string;
  notableFiles: NotableFileChange[];
}

/** Transient safety signal; the client also checks autoResetMergedBranch. */
export interface WsResetEligible {
  type: "reset_eligible";
  sessionId: string;
  eligible: boolean;
}
