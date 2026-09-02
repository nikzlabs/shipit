import type { GitHubDeploymentStatus } from "./deployment-types.js";

// ---- GitHub auth server messages ----

export interface WsGitHubStatus {
  type: "github_status";
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  /**
   * Set when the orchestrator just detected that the stored GitHub token
   * is invalid (expired/revoked) from a git operation that returned
   * "Authentication failed". Present alongside `authenticated: false` and
   * triggers a user-visible toast pointing back to Settings → GitHub.
   * Unset on a normal logout. See `GitHubAuthManager.markTokenInvalid`.
   */
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
    mergeable: PrMergeableState;
    reviewDecision: PrReviewDecision;
  } | null;
}

/**
 * GitHub-reported mergeability for a PR.
 *
 * Mirrors the `MergeableState` enum from GitHub's GraphQL API. Treated as a
 * tri-state because `"unknown"` is meaningfully distinct from `"conflicting"`:
 * GitHub returns `UNKNOWN` for a brief window after each push while it
 * computes mergeability, and we don't want to gate UI on that transient state.
 */
export type PrMergeableState = "mergeable" | "conflicting" | "unknown";

/**
 * GitHub-reported review/approval status for a PR.
 *
 * Mirrors GitHub's GraphQL `PullRequestReviewDecision` enum, lower-cased, with
 * the API's `null` collapsed to `"none"`. GitHub returns a non-null decision
 * ONLY when the base branch has a review-requirement branch-protection rule, so
 * `"none"` means "no review is required" — the common ShipIt solo-repo case —
 * and is treated as non-blocking. `"review_required"` and `"changes_requested"`
 * block the merge; `"approved"` and `"none"` allow it. See docs/174.
 */
export type PrReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

/**
 * Where the session's local branch stands against the same branch on the remote
 * — the question "would merging this pull request ship what the session has
 * actually produced?"
 *
 *  - `in-sync` — local HEAD is the remote tip. The PR carries everything.
 *  - `ahead` — the session has commits the remote has not seen. A merge now
 *    ships the state of the last SUCCESSFUL push, silently dropping them. This
 *    is not hypothetical: `services/auto-push-scheduler.ts` records an incident
 *    where two pull requests merged seven and two commits behind after ten
 *    hours of rejected pushes.
 *  - `behind` — the remote's history already contains every commit this session
 *    made, plus more. Not a block: the extra commits are somebody's deliberate
 *    act on the branch (a suggestion applied on GitHub, a push from a laptop),
 *    which the merge is right to ship. Note this is an ancestry statement, not
 *    a promise about the resulting tree — a remote commit is free to revert an
 *    earlier one. That is a decision made on the branch, not the stale snapshot
 *    this guard exists to catch.
 *  - `diverged` — both sides have commits the other lacks (a rebase, a reset
 *    onto a fresh base). A merge ships the remote's history, which is not what
 *    the session holds. ShipIt never force-pushes on its own, so this needs a
 *    human decision before the merge.
 */
export type BranchSyncState = "in-sync" | "ahead" | "behind" | "diverged";

/** Local-vs-remote commit counts for a session's branch. */
export interface BranchSyncStatus {
  state: BranchSyncState;
  /** Commits on local HEAD that the remote branch does not have. */
  ahead: number;
  /** Commits on the remote branch that local HEAD does not have. */
  behind: number;
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

/**
 * Auto-fix state for a session's PR, managed by the poller via `AutoFixManager`
 * (which extends the shared `AutoRemediationManager`). docs/169 moved the toggle
 * to a global persisted setting, so this no longer carries a per-session
 * `enabled` flag; presence of the state means the auto-loop (or a manual fix)
 * has acted at least once on this session.
 */
export interface AutoFixState {
  attemptCount: number;       // resets when head SHA changes
  lastHeadSha: string;        // tracks which commit's CI we're fixing
  status: "idle" | "running" | "deferred" | "exhausted";
  lastError?: string;
  nextEligibleAt?: number;
}

/** Auto-merge error from GitHub — missing repo settings or branch protection. */
export interface PrAutoMergeError {
  code: "auto_merge_not_enabled" | "no_branch_protection";
  message: string;
  settingsUrl: string;
}

/**
 * Why auto-merge is ShipIt-managed rather than GitHub-native. docs/266.
 *
 *  - `native-unavailable` — GitHub refused `enablePullRequestAutoMerge` (no
 *    branch protection, "Allow auto-merge" off). A repo misconfiguration: the
 *    card explains it and links to the settings page.
 *  - `session-live` — ShipIt declined to hand the PR to GitHub because the
 *    session has a live runner, so the merge must stay behind the busy gate in
 *    `AutoMergeManager.handleManaged`. Nothing is wrong; the card says the PR
 *    merges when the session finishes.
 *  - `branch-unsynced` — ShipIt declined for the same structural reason on a
 *    different signal: the session holds commits GitHub has not got. Native
 *    auto-merge would merge the branch as GitHub currently has it the moment
 *    its checks pass, and once armed ShipIt cannot hold it; the managed loop
 *    can, and waits for the push to land.
 *
 * The three must stay distinguishable: rendering either of the last two as the
 * first tells the user their repository is misconfigured when it isn't.
 */
export type AutoMergeManagedReason = "native-unavailable" | "session-live" | "branch-unsynced";

/** Auto-merge state for a session's PR, managed by the poller. */
export interface AutoMergeState {
  enabled: boolean;
  mergeMethod: "squash" | "merge" | "rebase";
  /** True when ShipIt, not GitHub, owns the merge. See {@link managedReason}. */
  managed?: boolean;
  /**
   * Why {@link managed} is set. Absent on an old/hand-built state is read as
   * `native-unavailable` (the only reason that existed before docs/266).
   */
  managedReason?: AutoMergeManagedReason;
  /** GitHub settings URL — shown in tooltip when managed. */
  settingsUrl?: string;
  /**
   * The actual error GitHub returned from `enablePullRequestAutoMerge` that
   * caused the managed-merge fallback (e.g. "Auto-merge is not enabled for this
   * repository…"). Surfaced verbatim in the managed-merge tooltip so the user
   * sees the real precondition that's missing, not a generic guess. docs/077.
   */
  reason?: string;
  error?: PrAutoMergeError;
  /**
   * True once the ShipIt-managed merge REST call has succeeded. The PR is
   * merging; we keep `enabled` true until the poller observes the merged state
   * (so the client keeps treating auto-merge as owning the next move and stays
   * silent), and short-circuit any further merge attempts. Internal poller
   * bookkeeping — never broadcast to the client.
   */
  completed?: boolean;
}

/** Author of a PR comment or review (subset of GitHub's Actor). */
export interface PrCommentAuthor {
  login: string;
  /** Avatar URL; empty string when GitHub omits it (e.g. deleted user). */
  avatarUrl: string;
}

/** Author of the pull request itself. */
export type PrAuthor = PrCommentAuthor;

/**
 * A PR-level (issue) comment — the conversation timeline comments that appear
 * under the PR body on github.com, not tied to a diff line. docs/133 Phase 4.
 */
export interface PrIssueComment {
  /** GraphQL node id — stable identity for diffing/keys. */
  id: string;
  author: PrCommentAuthor;
  /** Markdown source. */
  body: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Permalink on github.com (escape hatch). */
  url: string;
}

/** A single comment within a review thread. */
export interface PrReviewThreadComment {
  id: string;
  author: PrCommentAuthor;
  body: string;
  createdAt: string;
}

/**
 * A review thread — line comments grouped as GitHub renders them. Read-only in
 * docs/133 Phase 4 (reply/resolve write-back is deferred to docs/102).
 */
export interface PrReviewThread {
  id: string;
  isResolved: boolean;
  /** True when the thread targets a line that has since changed. */
  isOutdated: boolean;
  /** File path the thread is anchored to (null for file-level threads). */
  path: string | null;
  /** Line number in the diff (null when outdated/unavailable). */
  line: number | null;
  comments: PrReviewThreadComment[];
}

/** Summary of a PR's current status, used by both the inline card and sidebar icons. */
export interface PrStatusSummary {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  /** PR description body (markdown source). Empty string when none. */
  prBody: string;
  /** ISO timestamp when the PR was opened. */
  prCreatedAt?: string;
  /** PR author. Undefined when GitHub omits the actor. */
  prAuthor?: PrAuthor;
  prState: "open" | "merged" | "closed";
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  /** Per-file summary for the open PR. Present when returned by GitHub's bounded files connection. */
  files?: PrFileStat[];
  checks: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    /** Per-check failure details (populated when state is "failure"). */
    failedChecks?: { name: string; summary: string }[];
    /**
     * Epoch ms at which a *forced* pending state expires. Set only when the
     * poller rewrote a genuine `"none"` reading to `"pending"` because the
     * repo runs CI but GitHub hasn't registered a check yet (`CiGraceTracker`).
     *
     * The client treats `pending` + `total === 0` past this instant as the
     * terminal "no checks" state. Without it, a summary persisted moments
     * before polling paused (last viewer detached) rehydrates as a spinner
     * that never resolves — nikzlabs/shipit#1730.
     */
    graceUntil?: number;
  };
  mergeable: PrMergeableState;
  /**
   * GitHub review/approval status. `"none"` when the base branch requires no
   * review (the merge gate treats it as non-blocking). `"review_required"` and
   * `"changes_requested"` block the merge button and managed auto-merge. docs/174.
   */
  reviewDecision: PrReviewDecision;
  /**
   * Where the session's local branch stands against its remote counterpart,
   * computed from the local clone's remote-tracking ref (no network). Gates the
   * merge button and managed auto-merge so neither ships a stale remote tip
   * while the session holds unpushed commits.
   *
   * `undefined` means "could not tell" — no workspace, no tracking ref, a bare
   * repo. Absence never blocks a merge: only a positive `ahead`/`diverged`
   * reading does.
   */
  branchSync?: BranchSyncStatus;
  autoMergeEnabled: boolean;
  /**
   * Auto-fix state — present when the auto-fix loop (or a manual "Fix CI") has
   * acted on this session. docs/169: the on/off toggle is now the global
   * `autoFixCi` setting, not a per-session flag, so this carries only the loop
   * status. Omitted when the manager has no state for the session.
   */
  autoFix?: {
    status: "idle" | "running" | "deferred" | "exhausted";
    attemptCount: number;
    maxAttempts: number;       // always 3
  };
  /** GitHub Deployment statuses from platforms like Vercel/Cloudflare (fetched via GitHub Deployments API). */
  deployments?: GitHubDeploymentStatus[];
  /**
   * PR-level (issue) comments — docs/133 Phase 4. Only populated when the
   * conversation fields were fetched (i.e. a session's PR tab is active);
   * `undefined` means "not fetched", distinct from `[]` ("none").
   */
  issueComments?: PrIssueComment[];
  /**
   * Review threads (line comments) — docs/133 Phase 4, read-only. Same
   * fetch-gating semantics as `issueComments`.
   */
  reviewThreads?: PrReviewThread[];
  /** Auto-merge state — present when auto-merge has been interacted with. */
  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    /** True when ShipIt, not GitHub, owns the merge. See {@link managedReason}. */
    managed?: boolean;
    /** Why ShipIt owns the merge — a repo misconfiguration, or a live session. docs/266. */
    managedReason?: AutoMergeManagedReason;
    /** GitHub settings URL for configuring branch protection. */
    settingsUrl?: string;
    /** The real GitHub error that triggered the managed-merge fallback. docs/077. */
    reason?: string;
    error?: PrAutoMergeError;
  };
  /**
   * Auto-resolve-conflicts state — present when the global
   * `autoResolveConflicts` setting is on AND the session has seen at least
   * one transition through the manager. (docs/146) Omitted when the setting
   * is off so the failure banner does not render for disabled users.
   */
  autoResolve?: {
    status: "idle" | "running" | "deferred" | "exhausted";
    attemptCount: number;
    maxAttempts: number; // always 3 — echoes MAX_AUTO_RESOLVE_ATTEMPTS
    lastError?: string;
    nextEligibleAt?: number;
  };
}

/** File stat for the "ready" phase of the PR lifecycle card. */
export interface PrFileStat {
  path: string;
  status: string; // M, A, D, R, etc.
  insertions: number;
  deletions: number;
}

/**
 * docs/205 — a "notable" file changed somewhere across the whole PR: a design
 * doc (`.md`), an allowlisted config file, or an image (added or modified).
 * Powers the PR card's collapsible changed-docs strip, where each entry renders
 * as a chip that opens the file inline. A pure 1:1 projection of the PR's
 * changed-file list — one chip per classified file, never collapsed; not
 * persisted.
 */
export interface NotableFileChange {
  /** Workspace-relative path (used as the chip's tooltip and the open target). */
  path: string;
  /**
   * Compact path label shown on the chip — `<parent>/<basename>`, with a
   * `NNN-slug` feature dir shortened to its number (`246/plan.md`). Derived
   * purely from `path`, so labels are unique within a diff.
   */
  label: string;
  kind: "doc" | "config" | "image";
  /** Normalized git status — Modified, Added, or Deleted (renames/copies map to M). */
  status: "M" | "A" | "D";
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
  /**
   * docs/205 — notable files (docs + allowlisted config) changed across the
   * whole PR, for the card's collapsible changed-docs strip. Present on the
   * "ready" and auto-create "open" emits; omitted on phases that don't compute
   * a file list (creating/error/merged), where the client preserves the
   * last-known list so the strip stays sticky.
   */
  notableFiles?: NotableFileChange[];
  /** Present in "open" and "merged" phases — PR info. */
  pr?: {
    number: number;
    title: string;
    /** PR description body (markdown source). Optional; omitted when none. */
    body?: string;
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
  /** Auto-merge state — present when auto-merge has been interacted with. */
  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    /** True when ShipIt, not GitHub, owns the merge. See {@link managedReason}. */
    managed?: boolean;
    /** Why ShipIt owns the merge — a repo misconfiguration, or a live session. docs/266. */
    managedReason?: AutoMergeManagedReason;
    /** GitHub settings URL for configuring branch protection. */
    settingsUrl?: string;
    /** The real GitHub error that triggered the managed-merge fallback. docs/077. */
    reason?: string;
    error?: PrAutoMergeError;
  };
  /** Present in "error" phase — error message. */
  errorMessage?: string;
  /**
   * docs/202 — set on a re-armed session's card (it shipped a PR before, then
   * the branch was rebased + progressed). Renders a "Previously merged #N" note
   * on the ready/open card. It also doubles as the override signal: a card
   * carrying this is allowed to replace a stale terminal (merged/closed) card in
   * the client store's `updateCard` guard, so it lands regardless of cross-
   * channel arrival order.
   */
  previousMergedPr?: {
    number: number;
    url: string;
    title: string;
    baseBranch: string;
  };
}

/**
 * docs/210 — a notableFiles-only patch for the PR card's changed-docs strip.
 *
 * The strip's list (`WsPrLifecycleUpdate.notableFiles`) is computed only at the
 * "ready"/"open" lifecycle emits and is then frozen: once a PR exists the
 * post-turn flow short-circuits (the poller drives the card) and the poller
 * preserves the last-known list rather than recomputing it. That left the strip
 * stuck at the PR-creation snapshot — docs changed in later turns showed in the
 * Docs panel but never on the card.
 *
 * This message is emitted after every post-turn commit on a session that
 * already has a PR. It re-derives the list from the current branch and patches
 * `notableFiles` in place on the live card WITHOUT replacing the poller-owned
 * fields (phase, pr, checks, …), so the strip tracks the branch as it evolves.
 */
export interface WsPrNotableFiles {
  type: "pr_notable_files";
  sessionId: string;
  /** Stable card ID — matches the live PR card so the patch lands in place. */
  cardId: string;
  /** The current, fully-recomputed notable-file list (may be empty). */
  notableFiles: NotableFileChange[];
}

/**
 * docs/218 — transient signal: is this session reset-eligible right now (merged,
 * branch untouched since the merge, clean tree, plain repo state)? Drives the
 * composer's "start from latest base" control visibility. Safety-only — the
 * client ANDs it with the `autoResetMergedBranch` setting. Recomputed and pushed
 * on session activation and after each turn; never persisted (like
 * `pr_notable_files` / `preview_status`).
 */
export interface WsResetEligible {
  type: "reset_eligible";
  sessionId: string;
  eligible: boolean;
}
