/**
 * PrLifecycleCard — sticky top chrome for the chat panel.
 *
 * Single-line design for each PR phase: ready, creating, open, merged, error.
 * Updates in place when the store state changes. Always renders (even pre-PR
 * or for sessions without a PR card) so the right cluster — search icon and
 * the overflow menu housing conversation- and PR-level preferences — has a
 * stable home. See docs/156.
 */

import { useState, useCallback } from "react";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useCommentStore } from "../stores/comment-store.js";
import { Button } from "./ui/button.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu.js";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.js";
import { MarkdownContent } from "./message-markdown.js";
import {
  AutoMergeToggle,
  ClosePrDropdownItem,
  FixCIButton,
  MergeButton,
  ResolveConflictsButton,
  useClosePr,
} from "./PrStatusControls.js";
import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  CopyIcon,
  DownloadSimpleIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  WarningIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  SealCheckIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import { GitPullRequestClosedIcon } from "./GitPullRequestClosedIcon.js";
import type { GitHubDeploymentStatus, PrReviewDecision } from "../../server/shared/types.js";
import { ICON_SIZE } from "../design-tokens.js";

// ---- Shared ----

// NB: block-level `flex` (not `inline-flex`) so the chip renders at exactly
// h-6 regardless of its parent. As an inline-flex element it would be
// baseline-aligned inside a non-flex parent's line box, rounding the line up
// to 25px and making any containing row 1px taller (the merged PR card bug).
const linkClass = "h-6 flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) transition-colors border border-(--color-border-secondary) rounded px-1.5";
const MAX_VISIBLE_FAILURES = 5;

const DEFAULT_BRANCHES = new Set(["main", "master"]);
function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch);
}

function Spinner() {
  return (
    <CircleNotchIcon size={14} className="animate-spin text-(--color-info) shrink-0" />
  );
}

function DiffStats({ ins, del, onClick }: { ins: number; del: number; onClick?: () => void }) {
  const content = (
    <>
      <span className="text-(--color-success)">+{ins}</span>
      <span className="text-(--color-error)">-{del}</span>
    </>
  );
  if (!onClick) {
    return <span className={`${linkClass} shrink-0`}>{content}</span>;
  }
  return (
    <button onClick={onClick} className={`${linkClass} shrink-0 cursor-pointer hover:text-(--color-text-secondary)`} title="View full diff">
      {content}
    </button>
  );
}

/** Fetch diff of HEAD vs a base branch and open it in the diff dialog. */
function useOpenPrDiff(baseBranch?: string) {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useCallback(async () => {
    if (!sessionId) return;
    const base = baseBranch || "main";
    try {
      await useGitStore.getState().fetchDiffVsBranch(sessionId, base);
      useGitStore.getState().openDiffDialog(`Changes vs ${base}`);
    } catch {
      // Silently fail
    }
  }, [sessionId, baseBranch]);
}

/**
 * PR title (with rich-tooltip PR body) for the open phase. The branch name
 * itself is no longer surfaced here — pre-PR it's replaced by the session
 * title in ReadyPhase, and the copy affordance has moved to the overflow
 * menu's "Copy branch name" item.
 *
 * Rendering rules:
 *   - `prTitle` unset, non-default base → "base ← head".
 *   - `prTitle` unset, default base     → just `headBranch`.
 *   - `prTitle` set                     → render `prTitle`; tooltip shows
 *                                          full `prBody` as markdown (or a
 *                                          fallback when there's no body).
 */
function BranchLabel({
  baseBranch,
  headBranch,
  prTitle,
  prBody,
}: {
  baseBranch?: string;
  headBranch?: string;
  prTitle?: string;
  prBody?: string;
}) {
  if (!headBranch && !prTitle) return null;

  const labelClass =
    "h-6 text-xs flex items-center gap-1 min-w-0 overflow-hidden text-(--color-text-secondary)";

  if (!prTitle) {
    const content = baseBranch && !isDefaultBranch(baseBranch) ? (
      <>{baseBranch} <span className="text-(--color-text-tertiary)">←</span> {headBranch}</>
    ) : headBranch;
    return (
      <span className={labelClass}>
        <span className="truncate">{content}</span>
      </span>
    );
  }

  const trimmedBody = (prBody ?? "").trim();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={labelClass}>
            <span className="truncate">{prTitle}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="max-w-lg max-h-96 flex flex-col overflow-hidden text-left p-0"
        >
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {trimmedBody.length > 0 ? (
              <MarkdownContent text={trimmedBody} />
            ) : (
              <div className="text-(--color-text-primary)">No description</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Pre-PR label: shows what the user asked for, not the synthetic branch slug.
 *
 * Resolution order:
 *  1. The session title. `graduateSession` sets it to a snippet of the first
 *     user message immediately, and an AI rename replaces it with a tidy
 *     phrase a few seconds later — both are user-meaningful.
 *  2. If the title is still the pre-graduation placeholder ("New session") or
 *     somehow empty, fall back to the first user message from chat history so
 *     we show *something the user typed* rather than nothing.
 *
 * We deliberately never fall back to the branch slug — `shipit/pf_7ol` reads
 * as noise to the user and would be inconsistent with the post-PR view, which
 * shows the PR title.
 */
function SessionTitleLabel({ sessionId }: { sessionId: string }) {
  const title = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId)?.title);
  const firstUserText = useSessionStore((s) => s.messages.find((m) => m.role === "user")?.text);
  const trimmedTitle = title?.trim() ?? "";
  const isPlaceholder = !trimmedTitle || trimmedTitle === "New session";
  const text = isPlaceholder ? firstUserText?.trim() : trimmedTitle;
  if (!text) return null;
  return (
    <span className="h-6 text-xs flex items-center gap-1 min-w-0 overflow-hidden text-(--color-text-secondary)">
      <span className="truncate">{text}</span>
    </span>
  );
}

function CiIndicator({ checks }: { checks: PrCardState["checks"] }) {
  if (!checks || checks.state === "none") return null;

  if (checks.state === "success") {
    return (
      <span className="h-6 text-(--color-success) text-xs flex items-center gap-1 shrink-0" title={`CI passed  ${checks.total}/${checks.total} checks`}>
        <CheckCircleIcon size={ICON_SIZE.SM} /> CI {checks.total}/{checks.total}
      </span>
    );
  }
  if (checks.state === "failure") {
    return (
      <span className="h-6 text-(--color-error) text-xs flex items-center gap-1 shrink-0" title={`CI failed  ${checks.failed} of ${checks.total}`}>
        <XCircleIcon size={ICON_SIZE.SM} /> CI {checks.passed}/{checks.total}
      </span>
    );
  }
  // pending
  const pendingLabel = checks.total === 0 ? "CI" : `CI ${checks.passed}/${checks.total}`;
  const pendingTitle = checks.total === 0 ? "Waiting for CI checks to start" : `CI running  ${checks.passed}/${checks.total}`;
  return (
    <span className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0 animate-pulse" title={pendingTitle}>
      <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" /> {pendingLabel}
    </span>
  );
}

/**
 * docs/174 — GitHub review/approval status. Renders nothing for "none" (the
 * base branch requires no review — the common solo-repo case), so the card
 * looks identical to before for unprotected repos. The other three states
 * explain the merge button's presence/absence inline, without a GitHub tab.
 */
function ReviewIndicator({ reviewDecision }: { reviewDecision: PrReviewDecision | undefined }) {
  if (!reviewDecision || reviewDecision === "none") return null;

  if (reviewDecision === "approved") {
    return (
      <span className="h-6 text-(--color-success) text-xs flex items-center gap-1 shrink-0" title="PR approved">
        <SealCheckIcon size={ICON_SIZE.SM} /> Approved
      </span>
    );
  }
  if (reviewDecision === "changes_requested") {
    return (
      <span className="h-6 text-(--color-error) text-xs flex items-center gap-1 shrink-0" title="A reviewer requested changes">
        <XCircleIcon size={ICON_SIZE.SM} /> Changes requested
      </span>
    );
  }
  // review_required
  return (
    <span className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0" title="This branch requires a review before merging">
      <EyeIcon size={ICON_SIZE.SM} /> Review required
    </span>
  );
}

function PendingReviewButton({ sessionId, count }: { sessionId: string; count: number }) {
  const [submitting, setSubmitting] = useState(false);
  const clearComments = useCommentStore((s) => s.clearComments);
  const setToast = useUiStore((s) => s.setToast);

  const handleSubmit = async () => {
    if (submitting || count === 0) return;
    const comments = useCommentStore.getState().getAllComments(sessionId);
    if (comments.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/review`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          comments: comments.map((comment) => ({
            path: comment.filePath,
            line: comment.line,
            body: comment.text,
          })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setToast({ message: data.error || "Failed to send review" });
        return;
      }
      clearComments(sessionId);
      setToast({ message: `Sent review with ${comments.length} comment${comments.length === 1 ? "" : "s"}` });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to send review",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={handleSubmit}
      disabled={submitting}
      className="shrink-0 h-6 border border-(--color-border-secondary)"
      title="Send local diff comments to GitHub as one review"
    >
      {submitting ? (
        <CircleNotchIcon size={14} className="animate-spin" />
      ) : (
        <PaperPlaneTiltIcon size={ICON_SIZE.SM} />
      )}
      {submitting ? "Sending..." : `Send review (${count})`}
    </Button>
  );
}

/**
 * MergeConflictIndicator — surfaces GitHub's `CONFLICTING` mergeable state.
 *
 * Renders a warning-tone label next to the CI indicator when the PR cannot
 * be merged because the base branch has diverged. Only shown when the
 * GitHub poller has explicitly observed `"conflicting"` — `"unknown"` is
 * treated as neutral to avoid flicker after a push (see OpenPhase comment).
 */
function MergeConflictIndicator() {
  return (
    <span
      className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0"
      title="Branch has merge conflicts with the base branch. Use Resolve conflicts to rebase and let the agent fix them."
    >
      <WarningIcon size={ICON_SIZE.SM} /> Merge conflicts
    </span>
  );
}

function FailedChecksList({ checks }: { checks: PrCardState["checks"] }) {
  const failedChecks = checks?.failedChecks;
  if (!failedChecks || failedChecks.length === 0) return null;

  const visible = failedChecks.slice(0, MAX_VISIBLE_FAILURES);
  const remaining = failedChecks.length - visible.length;

  return (
    <div className="mt-1 space-y-0.5">
      {visible.map((check) => (
        <div key={check.name} className="text-xs text-(--color-text-secondary)">
          <XCircleIcon size={12} className="inline text-(--color-error)" /> {check.name} — <span className="text-(--color-text-tertiary)">{check.summary}</span>
        </div>
      ))}
      {remaining > 0 && (
        <div className="text-xs text-(--color-text-tertiary)">
          and {remaining} more...
        </div>
      )}
    </div>
  );
}

// ---- Deployment status ----

function DeploymentStatusRow({ deployments }: { deployments: GitHubDeploymentStatus[] }) {
  if (deployments.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {deployments.map((d, i) => {
        const isActive = d.state === "success";
        const isPending = d.state === "pending" || d.state === "in_progress" || d.state === "queued";
        const isFailed = d.state === "failure" || d.state === "error";
        return (
          <div key={`${d.environment}-${i}`} className="flex items-center gap-1.5 text-xs">
            {isPending && <CircleNotchIcon size={12} className="text-(--color-warning) animate-spin shrink-0" />}
            {isActive && <GlobeIcon size={12} className="text-(--color-success) shrink-0" />}
            {isFailed && <XCircleIcon size={12} className="text-(--color-error) shrink-0" />}
            {!isPending && !isActive && !isFailed && <GlobeIcon size={12} className="text-(--color-text-tertiary) shrink-0" />}
            <span className="text-(--color-text-secondary)">{d.environment}</span>
            {d.environmentUrl && (
              <a href={d.environmentUrl} target="_blank" rel="noopener noreferrer" className="text-(--color-text-link) hover:text-(--color-accent) truncate max-w-xs">
                {(() => { try { return new URL(d.environmentUrl).hostname; } catch { return d.environmentUrl; } })()}
              </a>
            )}
            {d.creator && <span className="text-(--color-text-tertiary)">via {d.creator}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---- Phase renderers ----

// Note: the global "Auto-create PR after every meaningful turn" toggle was
// previously rendered here in an overflow menu. It moved to Settings → GitHub
// because the ready-phase card only appears for sessions without a PR (and is
// transient when auto-create is on), which made the toggle effectively
// undiscoverable. See docs/099-auto-pr-on-meaningful-turn/plan.md.

function ReadyPhase({
  card,
  sessionId,
  creating: externalCreating,
  onCreatePr,
}: {
  card: PrCardState;
  sessionId: string;
  creating?: boolean;
  onCreatePr?: () => void;
}) {
  const prCreationTurnRunning = useSessionStore((s) => s.isLoading && s.activity?.label === "Creating PR...");
  const creating = Boolean(externalCreating) || prCreationTurnRunning;
  const ins = card.totalInsertions ?? 0;
  const del = card.totalDeletions ?? 0;
  const hasDiffStats = ins > 0 || del > 0;
  const openDiff = useOpenPrDiff();

  return (
    <div className="flex items-center gap-3 flex-nowrap min-w-0 flex-1">
      <PrStateBadge sessionId={sessionId} />
      <SessionTitleLabel sessionId={sessionId} />
      <span className="ml-auto shrink-0 flex items-center gap-3">
        {hasDiffStats && <DiffStats ins={ins} del={del} onClick={openDiff} />}
        {hasDiffStats && (
          <Button
            size="sm"
            onClick={onCreatePr}
            disabled={creating || !onCreatePr}
            className="shrink-0 h-6 bg-(--color-success) hover:bg-(--color-success) hover:opacity-90 text-(--color-text-inverse)"
          >
            {creating && <CircleNotchIcon size={14} className="animate-spin" />}
            {creating ? "Creating PR..." : "Create PR"}
          </Button>
        )}
      </span>
    </div>
  );
}

function OpenPhase({
  card,
  sessionId,
  canAutoMerge,
}: {
  card: PrCardState;
  sessionId: string;
  canAutoMerge?: boolean;
}) {
  const pr = card.pr;
  const deployments = usePrStore((s) => s.statusBySession[sessionId]?.deployments);
  const mergeable = usePrStore((s) => s.statusBySession[sessionId]?.mergeable);
  const reviewDecision = usePrStore((s) => s.statusBySession[sessionId]?.reviewDecision);
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const pendingReviewCount = useCommentStore((s) => s.getCommentCount(sessionId));
  const autoFixCi = useSettingsStore((s) => s.autoFixCi);
  const openDiff = useOpenPrDiff(pr?.baseBranch);
  if (!pr) return null;

  const autoFix = card.autoFix;
  const autoMerge = card.autoMerge;
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const isCiFailed = card.checks?.state === "failure";
  const isCiPassed = card.checks?.state === "success";
  // "none" must come from the poller explicitly — undefined means we haven't
  // heard from the poller yet, so we don't know whether CI exists. Treating
  // undefined as "none" would let the merge button appear in the gap between
  // PR creation and the first poll, before pending workflows have registered.
  // The poller also force-overrides "none" → "pending" for a grace window
  // when the repo runs CI but GitHub hasn't registered any checks for the
  // current head SHA. Once that grace expires (e.g., docs-only PRs whose
  // changed paths don't match any workflow's `paths:` filter), the state
  // legitimately becomes "none" and the merge button appears.
  const isCiNone = card.checks?.state === "none";
  const isConflicting = mergeable === "conflicting";
  // docs/174 — also gate on GitHub's review decision. A base branch with a
  // required-review protection rule reports "review_required" until approved
  // and "changes_requested" when a reviewer blocks; both mean GitHub would
  // reject the merge, so hide the button. "approved"/"none" allow it ("none" =
  // no review requirement, the common solo-repo case).
  const isReviewBlocked = reviewDecision === "review_required" || reviewDecision === "changes_requested";
  // Merge button visibility: gate on CI state AND on GitHub-reported
  // mergeability. Don't gate on `mergeable === "unknown"` — that's the brief
  // window after each push while GitHub computes mergeability, and gating
  // would flicker the button off-on every push. The cost of a stale click
  // during that window is bounded (the merge attempt fails with a toast).
  const canMerge = (isCiPassed || isCiNone) && !isConflicting && !isReviewBlocked;
  // docs/169 — auto-fix is now a global setting, not a per-card toggle. Show the
  // manual "Fix CI" button when CI failed and the auto-loop isn't actively
  // handling it (global auto-fix off, or its budget exhausted).
  const showFixButton = isCiFailed && !isAutoFixRunning && (!autoFixCi || isAutoFixExhausted);
  const showMergeButton = canMerge && !autoMerge?.enabled;
  // The inline conflict UI yields to the RebaseBanner once a rebase is
  // active — RebaseBanner is the surface for the in-flight flow. The
  // indicator and Resolve button reappear if the rebase aborts back to
  // the conflict state.
  const showConflictUi = isConflicting && rebaseStatus === "idle";

  // Two-column layout so additional rows (auto-merge text, failed checks,
  // deploys) and the wrapped badges row all align under the PR title rather
  // than getting offset by ad-hoc `pl-5` padding under the icon. Each first-row
  // anchor (left badge box, title line) is `h-6` and the parent is
  // `items-start`, so when the block grows multiple rows tall the badge and
  // title stay centered on the first line — matching the right-side action
  // cluster (also `h-6`, top-anchored). The card's own `py-2` then provides
  // symmetric top/bottom padding so the last wrapped row never touches the
  // bottom border.
  return (
    <div className="min-w-0 flex-1 flex items-start gap-x-3">
      <div className="h-6 flex items-center shrink-0">
        <PrStateBadge sessionId={sessionId} url={pr.url} prNumber={pr.number} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex-1 min-w-0 flex items-center">
            <BranchLabel
              baseBranch={pr.baseBranch}
              headBranch={pr.headBranch}
              prTitle={pr.title}
              prBody={pr.body}
            />
          </div>
          <span className="basis-full sm:basis-auto min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
            <DiffStats ins={pr.insertions} del={pr.deletions} onClick={openDiff} />
            {pendingReviewCount > 0 && (
              <PendingReviewButton sessionId={sessionId} count={pendingReviewCount} />
            )}
            <CiIndicator checks={card.checks} />
            <ReviewIndicator reviewDecision={reviewDecision} />
            {canAutoMerge && (
              <span className="shrink-0">
                <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />
              </span>
            )}
            {showConflictUi && <MergeConflictIndicator />}
            {showConflictUi && (
              <ResolveConflictsButton sessionId={sessionId} baseBranch={pr.baseBranch} />
            )}
            {showMergeButton && (
              <MergeButton sessionId={sessionId} autoMerge={autoMerge} />
            )}
            {showFixButton && (
              <FixCIButton sessionId={sessionId} />
            )}
          </span>
        </div>
        {/* docs/175 decision #2 — durable, conditional transparency line. Shown
            ONLY once we know the head commit has zero CI checks (`isCiNone`)
            AND auto-merge is armed: that combination means the PR will merge as
            soon as it's mergeable, with no CI gate and no review. `wrap-break-word`
            + `items-start` keep it readable when it wraps on a narrow viewport. */}
        {autoMerge?.enabled && isCiNone && (
          <div className="mt-1 text-xs text-(--color-warning) flex items-start gap-1 wrap-break-word">
            <WarningIcon size={12} className="mt-0.5 shrink-0" />
            <span>This PR has no CI checks — it will merge as soon as it&rsquo;s mergeable.</span>
          </div>
        )}
        {autoMerge?.error && autoMerge.managed && (
          <div className="mt-1 text-xs text-(--color-warning) flex items-center gap-1">
            <WarningIcon size={12} /> {autoMerge.error.message}
          </div>
        )}
        {autoMerge?.error && !autoMerge.managed && (
          <div className="mt-1 text-xs text-(--color-warning) flex items-center gap-1">
            <WarningIcon size={12} /> {autoMerge.error.message}{" "}
            <a
              href={autoMerge.error.settingsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:opacity-80"
            >
              {autoMerge.error.code === "auto_merge_not_enabled" ? "Enable in repository settings" : "Configure branch protection"}
            </a>
          </div>
        )}
        {isAutoFixRunning && (
          <div className="mt-1 flex items-center gap-2">
            <Spinner />
            <span className="text-xs text-(--color-warning)">
              Auto-fixing (attempt {autoFix.attemptCount}/{autoFix.maxAttempts})...
            </span>
          </div>
        )}
        {isAutoFixExhausted && (
          <div className="mt-1 text-xs text-(--color-text-tertiary)">
            Auto-fix exhausted ({autoFix.maxAttempts}/{autoFix.maxAttempts} attempts)
          </div>
        )}
        <AutoResolveFailureBanner sessionId={sessionId} card={card} />
        {isCiFailed && !isAutoFixRunning && <FailedChecksList checks={card.checks} />}
        {deployments && deployments.length > 0 && <DeploymentStatusRow deployments={deployments} />}
      </div>
    </div>
  );
}

/**
 * docs/146 — failure banner for auto-resolve. Renders ONLY for
 * `outcome: "exhausted"` (the manager-terminal state). Per-attempt
 * `error` / `deferred` outcomes are transient and shouldn't flash the
 * banner up and down between retries — only the actionable terminal state
 * gets a UI surface.
 *
 * Gated on `settings.autoResolveConflicts === true` as well, so a user who
 * disabled the feature mid-loop doesn't see a stale banner. The server-side
 * `attachAutomationState` omits the block when disabled, but belt-and-
 * suspenders this on the client.
 */
function AutoResolveFailureBanner({ sessionId, card }: { sessionId: string; card: PrCardState }) {
  const enabled = useSettingsStore((s) => s.autoResolveConflicts);
  const setToast = useUiStore((s) => s.setToast);
  if (!enabled) return null;
  if (card.autoResolve?.status !== "exhausted") return null;
  const lastError = card.autoResolve.lastError ?? "unknown error";

  const handleRetry = async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-resolve/retry`, {
        method: "POST",
      });
      if (!res.ok) {
        if (res.status === 409) {
          setToast({ message: "Auto-resolve is already in flight" });
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      }
    } catch (err) {
      setToast({ message: "Retry failed — check the connection and try again" });
      console.error("[auto-resolve] retry failed:", err);
    }
  };

  return (
    <div className="mt-1 flex items-center gap-2 pl-5 text-xs">
      <span className="text-(--color-text-tertiary)">
        Auto-resolve couldn&rsquo;t finish. Last error: {lastError}.
      </span>
      <button
        type="button"
        onClick={() => void handleRetry()}
        className="text-(--color-text-primary) hover:underline cursor-pointer"
        data-testid="auto-resolve-retry"
      >
        Retry
      </button>
    </div>
  );
}

function TerminalPhase({ card, sessionId, text }: { card: PrCardState; sessionId: string; text: string }) {
  const pr = card.pr;
  const openDiff = useOpenPrDiff(pr?.baseBranch);
  const hasDiffStats = pr && (pr.insertions > 0 || pr.deletions > 0);
  return (
    <div className="flex items-center gap-3 flex-nowrap min-w-0 flex-1">
      <PrStateBadge sessionId={sessionId} url={pr?.url} prNumber={pr?.number} />
      <span className="h-6 flex items-center text-xs text-(--color-text-secondary) truncate min-w-0">{text}</span>
      {pr && (
        <span className="ml-auto shrink-0">
          {hasDiffStats
            ? <DiffStats ins={pr.insertions} del={pr.deletions} onClick={openDiff} />
            : <button onClick={openDiff} className={`${linkClass} shrink-0 cursor-pointer hover:text-(--color-text-secondary)`} title="View full diff">Diff</button>
          }
        </span>
      )}
    </div>
  );
}

/** Render error text with inline links (https://...) and backtick-highlighted terms (`word`). */
function RichErrorText({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/\S+|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("https://")) {
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-(--color-text-link) hover:opacity-80 underline">{part}</a>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="text-xs bg-(--color-bg-tertiary) px-1 py-0.5 rounded text-(--color-text-primary)">{part.slice(1, -1)}</code>;
    }
    return part;
  });
  return <>{parts}</>;
}

function ErrorPhase({
  card,
  onCreatePr,
}: {
  card: PrCardState;
  sessionId: string;
  onCreatePr?: () => void;
}) {
  const setSettingsTab = useUiStore((s) => s.setSettingsTab);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const agentRunning = useSessionStore((s) => s.isLoading);
  const lines = card.errorMessage?.split("\n") ?? [];
  const isAuthError = card.errorKind === "auth";

  const handleSignIn = () => {
    setSettingsTab("github");
    setSettingsOpen(true);
  };

  return (
    <div className="flex items-start gap-3 min-w-0 flex-1">
      <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error) shrink-0 mt-0.5" />
      <span className="text-xs text-(--color-text-secondary) wrap-break-word min-w-0">
        Failed to create PR{lines.length > 0 && ": "}
        {lines.map((line, i) => (
          <span key={i}>
            {i > 0 && <br />}
            <RichErrorText text={line} />
          </span>
        ))}
        {isAuthError && (
          <>
            <br />
            Your GitHub token is missing or expired — reconnect to keep pushing.
          </>
        )}
      </span>
      {isAuthError && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignIn}
          className="shrink-0"
        >
          Sign in to GitHub
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onCreatePr}
        disabled={agentRunning || !onCreatePr}
        className="shrink-0"
      >
        {agentRunning ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}

// ---- Main component ----

export interface PrLifecycleCardProps {
  sessionId: string;
  onOpenDetails?: () => void;
  /** Ask the agent to create a PR. The agent has context the orchestrator doesn't, so it can pick a good title and write a proper Summary/Changes/Test plan body. */
  onCreatePr?: () => void;
  /** Whether the session has a GitHub remote — gates the Auto-fix / Auto-merge overflow toggles. */
  canAutoMerge?: boolean;
  /** Opens the conversation search bar. */
  onSearch?: () => void;
  /** Downloads the conversation as JSON. */
  onDownloadChat?: () => void;
  /** True when the session has a recently-rewound state that can still be restored. */
  recoverRewindAvailable?: boolean;
  /** Restore the most recent rewind. */
  onRecoverRewind?: () => void;
}

export function PrLifecycleCard({
  sessionId,
  onOpenDetails,
  onCreatePr,
  canAutoMerge,
  onSearch,
  onDownloadChat,
  recoverRewindAvailable,
  onRecoverRewind,
}: PrLifecycleCardProps) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const autoMerge = usePrStore((s) => s.autoMergeBySession[sessionId] ?? s.cardBySession[sessionId]?.autoMerge);
  const sessionBranch = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId)?.branch);
  const setToast = useUiStore((s) => s.setToast);
  const startRebase = useGitStore((s) => s.startRebase);
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  // Prefer card-derived branches because they update mid-turn (e.g. branch
  // rename on graduation), then fall back to the session record.
  const headBranch = card?.pr?.headBranch ?? card?.headBranch ?? sessionBranch;
  const handleCopyBranch = useCallback(() => {
    if (!headBranch) return;
    void navigator.clipboard.writeText(headBranch);
    setToast({ message: "Branch name copied" });
  }, [headBranch, setToast]);

  // "Sync with <base>" rebases the branch onto the latest base and pushes,
  // reusing the conflict-resolution flow that the push-rejected banner and the
  // "Resolve conflicts" button already drive. Unlike those, this entry point is
  // always available — the user no longer has to wait for a rejected push or a
  // GitHub-reported conflict to pull in upstream changes. A clean rebase shows
  // the spinner banner; a no-op (already current) confirms via toast.
  const syncBaseBranch = card?.pr?.baseBranch ?? "main";
  const syncDisabled = isAgentRunning || rebaseStatus !== "idle";
  const handleSyncWithBase = useCallback(() => {
    if (isAgentRunning || useGitStore.getState().rebaseStatus !== "idle") return;
    void startRebase(sessionId, syncBaseBranch);
  }, [isAgentRunning, startRebase, sessionId, syncBaseBranch]);

  // Close lives in this always-present overflow menu (in addition to the merge
  // dropdown's copy) so it stays reachable when the merge button is hidden —
  // most importantly during merge conflicts. The hook owns the two-step confirm;
  // the menu's onOpenChange resets it so it never reopens armed.
  const closeState = useClosePr(sessionId);

  // The whole card body opens the PR detail tab, but only once a PR exists
  // (open/merged/closed) — the ready/creating/error phases have no PR to
  // drill into. Clicks that originate on an interactive control (button, link,
  // input) are ignored via the closest() guard, so toggling auto-fix, merging,
  // or copying the branch never also switches the tab — no per-control
  // stopPropagation needed. See docs/133.
  const hasPr = !!card?.pr && (card.phase === "open" || card.phase === "merged" || card.phase === "closed");
  const clickable = hasPr && !!onOpenDetails;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    onOpenDetails?.();
  };

  // Key the inner subtree on sessionId so transient per-session UI state
  // (e.g. MergeButton's "Merging..." flag, CreatePR's "Creating..." flag,
  // OpenPhase's "Fixing..." flag) resets when the user switches sessions.
  // Without this, switching sessions while a merge is in flight leaves the
  // button stuck on "Merging..." against the new session.
  const phaseContent = card ? (
    <>
      {(card.phase === "ready" || card.phase === "creating") && <ReadyPhase card={card} sessionId={sessionId} creating={card.phase === "creating"} onCreatePr={onCreatePr} />}
      {card.phase === "open" && <OpenPhase card={card} sessionId={sessionId} canAutoMerge={canAutoMerge} />}
      {card.phase === "merged" && (
        <TerminalPhase card={card} sessionId={sessionId}
          text={`Merged: ${card.pr?.title ?? `PR #${card.pr?.number}`}${card.pr?.baseBranch && !isDefaultBranch(card.pr.baseBranch) ? ` into ${card.pr.baseBranch}` : ""}`}
        />
      )}
      {card.phase === "closed" && (
        <TerminalPhase card={card} sessionId={sessionId} text={`PR #${card.pr?.number} closed`} />
      )}
      {card.phase === "error" && <ErrorPhase card={card} sessionId={sessionId} onCreatePr={onCreatePr} />}
    </>
  ) : (
    // No PR card yet — leave the left side empty so the right cluster (search
    // + overflow) anchors the bar. Keeps session-management actions reachable
    // pre-PR without re-introducing a separate top bar.
    <div className="min-w-0 flex-1" />
  );

  return (
    <div
      key={sessionId}
      onClick={handleClick}
      aria-label={clickable ? "Open PR details" : undefined}
      className={`shrink-0 flex items-start gap-2 px-3 sm:px-4 py-2 border-b border-(--color-border-primary) ${clickable ? "cursor-pointer hover:bg-(--color-bg-hover)/40 transition-colors" : ""}`}
    >
      <div className="min-w-0 flex-1 flex items-center">
        {phaseContent}
      </div>
      <div className="shrink-0 h-6 flex items-center gap-1">
        {onSearch && (
          <button
            onClick={onSearch}
            className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
            title="Search conversation"
            aria-label="Search conversation"
          >
            <MagnifyingGlassIcon size={ICON_SIZE.SM} weight="bold" />
          </button>
        )}
        <OverflowMenu
          label="Session actions"
          triggerClassName="h-auto w-auto p-1"
          onOpenChange={(open) => {
            // Reset the destructive close-confirm whenever the menu closes, so a
            // partial confirmation never carries over to the next open.
            if (!open) closeState.reset();
          }}
        >
          {/* The Auto-merge toggle now lives inline in the open-phase card row
              (always visible, desktop + mobile). The overflow keeps a copy only
              for the phases that have no inline row — pre-PR (ready/creating/no
              card), merged, closed — so auto-merge can still be armed before a
              PR exists. Gating on `phase !== "open"` keeps it rendered exactly
              once. */}
          {canAutoMerge && card?.phase !== "open" && (
            <>
              <div className="px-2 py-1">
                <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />
              </div>
              <DropdownMenuSeparator />
            </>
          )}
          {canAutoMerge && (
            <DropdownMenuItem
              onSelect={handleSyncWithBase}
              disabled={syncDisabled}
              title={
                isAgentRunning
                  ? "Wait for the agent to finish before syncing"
                  : `Rebase onto ${syncBaseBranch} and push`
              }
            >
              <ArrowsClockwiseIcon size={ICON_SIZE.SM} />
              Sync with {syncBaseBranch}
            </DropdownMenuItem>
          )}
          {headBranch && (
            <DropdownMenuItem onSelect={handleCopyBranch} title={`Copy ${headBranch}`}>
              <CopyIcon size={ICON_SIZE.SM} />
              Copy branch name
            </DropdownMenuItem>
          )}
          {recoverRewindAvailable && onRecoverRewind && (
            <DropdownMenuItem onSelect={onRecoverRewind}>
              <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
              Recover recent rewind
            </DropdownMenuItem>
          )}
          {onDownloadChat && (
            <DropdownMenuItem onSelect={onDownloadChat}>
              <DownloadSimpleIcon size={ICON_SIZE.SM} />
              Download chat
            </DropdownMenuItem>
          )}
          {card?.phase === "open" && (
            <>
              <DropdownMenuSeparator />
              <ClosePrDropdownItem state={closeState} />
            </>
          )}
        </OverflowMenu>
      </div>
    </div>
  );
}

// ---- PR state badge (reused in sidebar + card phases) ----

export function PrStateBadge({ sessionId, url, prNumber }: { sessionId: string; url?: string; prNumber?: number }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  const prState = status?.prState ?? (card?.phase === "merged" ? "merged" : card?.phase === "closed" ? "closed" : card?.phase === "open" ? "open" : null);

  const base = "w-5 h-5 rounded-md flex items-center justify-center shrink-0 border";

  let className: string;
  let title: string;
  let icon: React.ReactNode;

  if (prState === "merged") {
    className = `${base} bg-(--color-pr-subtle) text-(--color-pr) border-(--color-pr-border)`;
    title = prNumber ? `PR #${prNumber} merged` : "PR merged";
    icon = <GitMergeIcon size={ICON_SIZE.SM} />;
  } else if (prState === "open") {
    className = `${base} bg-(--color-success-subtle) text-(--color-success) border-(--color-success-border)`;
    title = prNumber ? `PR #${prNumber}` : "PR open";
    icon = <GitPullRequestIcon size={ICON_SIZE.SM} />;
  } else if (prState === "closed") {
    // Closed-but-not-merged: red, mirroring GitHub's convention, so it reads as
    // distinct from both the green open PR and a plain (PR-less) branch.
    className = `${base} bg-(--color-error)/15 text-(--color-error) border-(--color-error)/30`;
    title = prNumber ? `PR #${prNumber} closed` : "PR closed";
    icon = <GitPullRequestClosedIcon size={ICON_SIZE.SM} />;
  } else {
    className = `${base} bg-(--color-bg-tertiary) text-(--color-text-tertiary) border-(--color-border-secondary)`;
    title = "Branch";
    icon = <GitBranchIcon size={ICON_SIZE.SM} />;
  }

  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={`${className} hover:opacity-80 transition-opacity`} title={title}>
        {icon}
      </a>
    );
  }
  return <span className={className} title={title}>{icon}</span>;
}
