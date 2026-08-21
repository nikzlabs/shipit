/**
 * PrStatusActions — the open-PR card's status chips and secondary action
 * controls: diff stats, pending review, CI, review decision, and the
 * resolve-conflicts / fix-CI buttons.
 *
 * The auto-merge toggle and the merge button are NOT here: they live in
 * `PrMergeActions` below, which always renders on a line of its own.
 *
 * Extracted from OpenPhase because it renders in two places depending on the
 * viewport, and only the placement differs:
 *
 * - **Desktop** — inline in the card's title row, inside the column left of the
 *   search / docs / ⋯ cluster.
 * - **Mobile** — as its own full-width row below the card header (rendered by
 *   PrLifecycleCard). The card's icon cluster is a sibling column, so it
 *   narrows *every* wrapped row, not just the first: on a 427px phone that
 *   leaves the inline row ~258px, which isn't enough for the merge controls to
 *   share with the chips. Breaking out to the card's full width gives ~370px.
 */

import { useState } from "react";
import { usePrStore, useActiveAutoMerge } from "../../stores/pr-store.js";
import type { PrCardState } from "../../stores/pr-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useGitStore } from "../../stores/git-store.js";
import { useCommentStore } from "../../stores/comment-store.js";
import { useCiDisplay } from "../../hooks/useCiDisplay.js";
import { Button } from "../ui/button.js";
import {
  AutoMergeToggle,
  FixCIButton,
  MergeButton,
  ResolveConflictsButton,
} from "../PrStatusControls.js";
import { CircleNotchIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { DiffStats, PreviouslyMergedNote, useOpenPrDiff } from "./shared.js";
import { CiIndicator, ReviewIndicator, MergeConflictIndicator } from "./indicators/index.js";

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

/**
 * Is the merge button allowed to show? Shared by the card's merge row and the
 * detail panel's action box so the two can't drift apart.
 *
 * Gates on CI state AND on GitHub-reported mergeability. Don't gate on
 * `mergeable === "unknown"` — that's the brief window after each push while
 * GitHub computes mergeability, and gating would flicker the button off-on
 * every push. The cost of a stale click during that window is bounded (the
 * merge attempt fails with a toast).
 *
 * docs/174 — also gate on GitHub's review decision. A base branch with a
 * required-review protection rule reports "review_required" until approved and
 * "changes_requested" when a reviewer blocks; both mean GitHub would reject the
 * merge, so hide the button. "approved"/"none" allow it ("none" = no review
 * requirement, the common solo-repo case).
 */
function useCanMerge(card: PrCardState, sessionId: string): boolean {
  const mergeable = usePrStore((s) => s.statusBySession[sessionId]?.mergeable);
  const reviewDecision = usePrStore((s) => s.statusBySession[sessionId]?.reviewDecision);
  const ciDisplay = useCiDisplay(card.checks);
  const isCiPassed = ciDisplay.kind === "success";
  // "none" must come from the poller explicitly — `"unknown"` means we haven't
  // heard from the poller yet, so we don't know whether CI exists. Treating
  // that as "none" would let the merge button appear in the gap between PR
  // creation and the first poll, before pending workflows have registered.
  // The poller also force-overrides "none" → "pending" for a grace window
  // when the repo runs CI but GitHub hasn't registered any checks for the
  // current head SHA. Once that grace expires (docs-only PRs whose changed
  // paths don't match any workflow's `paths:` filter, or a repo with no
  // PR-triggered workflow at all), the state is legitimately "none" and the
  // merge button appears. `useCiDisplay` also retires the override locally at
  // its deadline, so a paused poller can't strand the button behind a spinner.
  const isCiNone = ciDisplay.kind === "none";
  const isReviewBlocked = reviewDecision === "review_required" || reviewDecision === "changes_requested";
  return (isCiPassed || isCiNone) && mergeable !== "conflicting" && !isReviewBlocked;
}

/**
 * The auto-merge toggle and the merge button, on a row of their own.
 *
 * `basis-full` is what buys the separate line: in the mobile actions row (a
 * full-width flex-wrap container) it forces the pair onto a line below the
 * chips instead of letting greedy wrapping mix them in; in the desktop card the
 * caller drops it into the title column as a block-level row below the title.
 * Either way the pair never shares a line with the diff/CI chips, and the
 * toggle can't ride up and strand the button alone.
 *
 * Renders nothing when neither control applies, so the card doesn't grow an
 * empty row.
 */
export function PrMergeActions({
  card,
  sessionId,
  canAutoMerge,
}: {
  card: PrCardState;
  sessionId: string;
  canAutoMerge?: boolean;
}) {
  const canMerge = useCanMerge(card, sessionId);
  // Same rule as every other auto-merge surface: an arming belongs to one pull
  // request, so read it through the selector rather than off the card.
  const autoMerge = useActiveAutoMerge(sessionId);
  const showMergeButton = canMerge && !autoMerge?.enabled;

  if (!card.pr || (!canAutoMerge && !showMergeButton)) return null;

  return (
    <div className="w-full basis-full mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 md:gap-x-3">
      {/* `pl-0` on the leading toggle: this row sits directly under the PR
          title, and the ghost button's `px-2` would otherwise inset the visible
          switch 8px past the title's text edge — a gap the hover background
          makes obvious by painting the button's real box out to the alignment
          line. Dropping only the left padding puts the switch AND its hover
          background on that line, without the negative margin that would make
          the merge button's solid fill hang left of the title. The other
          AutoMergeToggle call sites (detail panel, overflow menu) keep `px-2`:
          they sit inside their own padded container, where symmetric padding is
          what's wanted. */}
      {canAutoMerge && <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} className="pl-0" />}
      {showMergeButton && <MergeButton sessionId={sessionId} autoMerge={autoMerge} />}
    </div>
  );
}

export function PrStatusActions({
  card,
  sessionId,
}: {
  card: PrCardState;
  sessionId: string;
}) {
  const pr = card.pr;
  const mergeable = usePrStore((s) => s.statusBySession[sessionId]?.mergeable);
  const reviewDecision = usePrStore((s) => s.statusBySession[sessionId]?.reviewDecision);
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const pendingReviewCount = useCommentStore((s) => s.getCommentCount(sessionId));
  const autoFixCi = useSettingsStore((s) => s.autoFixCi);
  const openDiff = useOpenPrDiff(pr?.baseBranch);
  const ciDisplay = useCiDisplay(card.checks);
  if (!pr) return null;

  const autoFix = card.autoFix;
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const isCiFailed = ciDisplay.kind === "failure";
  const isConflicting = mergeable === "conflicting";
  // docs/169 — auto-fix is now a global setting, not a per-card toggle. Show the
  // manual "Fix CI" button when CI failed and the auto-loop isn't actively
  // handling it (global auto-fix off, or its budget exhausted).
  const showFixButton = isCiFailed && !isAutoFixRunning && (!autoFixCi || isAutoFixExhausted);
  // The inline conflict UI yields to the RebaseBanner once a rebase is
  // active — RebaseBanner is the surface for the in-flight flow. The
  // indicator and Resolve button reappear if the rebase aborts back to
  // the conflict state.
  const showConflictUi = isConflicting && rebaseStatus === "idle";

  return (
    <>
      <DiffStats ins={pr.insertions} del={pr.deletions} onClick={openDiff} />
      {pendingReviewCount > 0 && (
        <PendingReviewButton sessionId={sessionId} count={pendingReviewCount} />
      )}
      <CiIndicator checks={card.checks} />
      <ReviewIndicator reviewDecision={reviewDecision} />
      {card.previousMergedPr && (
        <PreviouslyMergedNote previousMergedPr={card.previousMergedPr} />
      )}
      {/* The merge controls are NOT here — PrMergeActions renders them on their
          own row (see its docstring). The conflict / fix-CI controls stay on the
          chips line: a conflicting or CI-failed PR is never mergeable, so they
          never compete with the merge button for space. */}
      {showConflictUi && <MergeConflictIndicator />}
      {showConflictUi && (
        <ResolveConflictsButton sessionId={sessionId} baseBranch={pr.baseBranch} />
      )}
      {showFixButton && <FixCIButton sessionId={sessionId} />}
    </>
  );
}
