import type { GitHubDeploymentStatus } from "./deployment-types.js";

// ---- GitHub auth client messages ----

export interface WsGitHubSetToken {
  type: "github_set_token";
  token: string;
}

export interface WsGitHubPush {
  type: "github_push";
  remote?: string;
  branch?: string;
}

export interface WsGitHubPull {
  type: "github_pull";
  remote?: string;
  branch?: string;
}

export interface WsGitHubSetRemote {
  type: "github_set_remote";
  name: string;
  url: string;
}

export interface WsGitHubLogout {
  type: "github_logout";
}

export interface WsGitHubCreatePR {
  type: "github_create_pr";
  title: string;
  body: string;
  base: string;
  draft?: boolean;
}

// ---- PR status & merge messages ----

export interface WsMergePr {
  type: "merge_pr";
  method?: "merge" | "squash" | "rebase";
}

// ---- GitHub auth server messages ----

export interface WsGitHubStatus {
  type: "github_status";
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface WsGitHubPushResult {
  type: "github_push_result";
  success: boolean;
  message: string;
  branch?: string;
}

export interface WsGitHubPullResult {
  type: "github_pull_result";
  success: boolean;
  message: string;
}

export interface WsGitHubRemotes {
  type: "github_remotes";
  remotes: { name: string; url: string }[];
}

export interface WsGitHubPRCreated {
  type: "github_pr_created";
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
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

// ---- PR status & merge server messages ----

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
    mergeable: boolean;
  } | null;
}

export interface WsMergePrResult {
  type: "merge_pr_result";
  success: boolean;
  message: string;
  autoMergeEnabled?: boolean;
}

// ---- PR lifecycle types ----

/** CI failure log for a single check run — used by the fix-ci flow. */
export interface CIFailureLog {
  checkName: string;
  conclusion: string;         // "failure", "cancelled", "timed_out"
  summary: string;            // one-line from CheckRun.title
  annotations: {
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }[];
  errorLines: string[];       // extracted error-like lines (most actionable)
  logExcerpt: string;         // last 20 lines of cleaned log (fallback)
  logFilePath?: string;       // absolute path to full log file on disk
}

/** Auto-fix state for a session's PR, managed by the poller. */
export interface AutoFixState {
  enabled: boolean;
  attemptCount: number;       // resets when head SHA changes
  lastHeadSha: string;        // tracks which commit's CI we're fixing
  status: "idle" | "running" | "exhausted";
}

/** Auto-merge error from GitHub — missing repo settings or branch protection. */
export interface PrAutoMergeError {
  code: "auto_merge_not_enabled" | "no_branch_protection";
  message: string;
  settingsUrl: string;
}

/** Auto-merge state for a session's PR, managed by the poller. */
export interface AutoMergeState {
  enabled: boolean;
  mergeMethod: "squash" | "merge" | "rebase";
  /** True when GitHub native auto-merge failed and ShipIt manages the merge. */
  managed?: boolean;
  /** GitHub settings URL — shown in tooltip when managed. */
  settingsUrl?: string;
  error?: PrAutoMergeError;
}

/** Summary of a PR's current status, used by both the inline card and sidebar icons. */
export interface PrStatusSummary {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prState: "open" | "merged" | "closed";
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
    /** Per-check failure details (populated when state is "failure"). */
    failedChecks?: { name: string; summary: string }[];
  };
  mergeable: boolean;
  autoMergeEnabled: boolean;
  /** Auto-fix state — present when auto-fix has been interacted with. */
  autoFix?: {
    enabled: boolean;
    status: "idle" | "running" | "exhausted";
    attemptCount: number;
    maxAttempts: number;       // always 3
  };
  /** GitHub Deployment statuses from platforms like Vercel/Cloudflare (fetched via GitHub Deployments API). */
  deployments?: GitHubDeploymentStatus[];
  /** Auto-merge state — present when auto-merge has been interacted with. */
  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    /** True when ShipIt manages the merge (GitHub native auto-merge unavailable). */
    managed?: boolean;
    /** GitHub settings URL for configuring branch protection. */
    settingsUrl?: string;
    error?: PrAutoMergeError;
  };
}

/** File stat for the "ready" phase of the PR lifecycle card. */
export interface PrFileStat {
  path: string;
  status: string; // M, A, D, R, etc.
  insertions: number;
  deletions: number;
}

/** Inline PR lifecycle card state, sent as a WS message. */
export interface WsPrLifecycleUpdate {
  type: "pr_lifecycle_update";
  sessionId: string;
  /** Stable card ID — used to update the card in place. */
  cardId: string;
  phase: "ready" | "creating" | "open" | "merged" | "error";
  /** Current branch name (present in "ready" phase). */
  headBranch?: string;
  /** Present in "ready" phase — files changed by the agent turn. */
  files?: PrFileStat[];
  totalInsertions?: number;
  totalDeletions?: number;
  /** Present in "open" and "merged" phases — PR info. */
  pr?: {
    number: number;
    title: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
  };
  /** Present in "open" phase — CI check status. */
  checks?: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  /** Present in "error" phase — error message. */
  errorMessage?: string;
}
