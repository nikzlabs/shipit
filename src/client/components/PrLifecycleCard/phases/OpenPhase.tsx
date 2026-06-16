import { useState } from "react";
import { usePrStore } from "../../../stores/pr-store.js";
import type { PrCardState } from "../../../stores/pr-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useGitStore } from "../../../stores/git-store.js";
import { useCommentStore } from "../../../stores/comment-store.js";
import { Button } from "../../ui/button.js";
import {
  AutoMergeToggle,
  FixCIButton,
  MergeButton,
  ResolveConflictsButton,
} from "../../PrStatusControls.js";
import {
  WarningIcon,
  CircleNotchIcon,
  PaperPlaneTiltIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { PrStateBadge } from "../PrStateBadge.js";
import { BranchLabel, DiffStats, PreviouslyMergedNote, Spinner, useOpenPrDiff } from "../shared.js";
import {
  CiIndicator,
  ReviewIndicator,
  MergeConflictIndicator,
  FailedChecksList,
  DeploymentStatusRow,
} from "../indicators/index.js";

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
      size="md"
      variant="ghost"
      onClick={handleSubmit}
      disabled={submitting}
      className="shrink-0 border border-(--color-border-secondary)"
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

export function OpenPhase({
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
            {card.previousMergedPr && (
              <PreviouslyMergedNote previousMergedPr={card.previousMergedPr} />
            )}
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
