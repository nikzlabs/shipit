/**
 * PrStatusSection — full status breakdown for the PR detail panel.
 *
 * Reads from the SAME store slice the inline card reads (`pr-store`:
 * `cardBySession` + `statusBySession`), so the card and panel are always two
 * views of one model — never parallel state. This is the richer, wider
 * rendering of the compact card status row.
 *
 * Actionable controls (merge, auto-fix, auto-merge) remain on the card for
 * now; wiring them into the panel is docs/133 Phase 3 follow-up.
 */

import {
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  GlobeIcon,
  WarningIcon,
  SealCheckIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { PrReviewDecision } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { PrCardState } from "../../stores/pr-store.js";
import {
  AutoMergeToggle,
  FixCIButton,
  MergeButton,
  ResolveConflictsButton,
} from "../PrStatusControls.js";

function ChecksSummary({ checks }: { checks: PrCardState["checks"] }) {
  if (!checks || checks.state === "none") {
    return <p className="text-sm text-(--color-text-tertiary)">No CI checks for this PR.</p>;
  }

  let icon: React.ReactNode;
  let label: string;
  if (checks.state === "success") {
    icon = <CheckCircleIcon size={ICON_SIZE.SM} className="text-(--color-success)" />;
    label = `${checks.passed}/${checks.total} checks passed`;
  } else if (checks.state === "failure") {
    icon = <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error)" />;
    label = `${checks.failed} of ${checks.total} checks failing`;
  } else {
    icon = <CircleNotchIcon size={ICON_SIZE.SM} className="text-(--color-warning) animate-spin" />;
    label = checks.total === 0 ? "Waiting for CI to start" : `${checks.passed}/${checks.total} checks complete`;
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-(--color-text-secondary)">
        {icon} {label}
      </div>
      {checks.failedChecks && checks.failedChecks.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-6">
          {checks.failedChecks.map((c) => (
            <li key={c.name} className="text-xs text-(--color-text-secondary)">
              <XCircleIcon size={12} className="inline text-(--color-error)" /> {c.name}
              {c.summary && <span className="text-(--color-text-tertiary)"> — {c.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * docs/174 — review/approval status row. Renders nothing for "none" (no review
 * requirement), matching the inline card's `ReviewIndicator`.
 */
function ReviewSummary({ reviewDecision }: { reviewDecision: PrReviewDecision | undefined }) {
  if (!reviewDecision || reviewDecision === "none") return null;

  let icon: React.ReactNode;
  let label: string;
  if (reviewDecision === "approved") {
    icon = <SealCheckIcon size={ICON_SIZE.SM} className="text-(--color-success)" />;
    label = "Approved";
  } else if (reviewDecision === "changes_requested") {
    icon = <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error)" />;
    label = "Changes requested";
  } else {
    icon = <EyeIcon size={ICON_SIZE.SM} className="text-(--color-warning)" />;
    label = "Review required before merging";
  }

  return (
    <div className="flex items-center gap-2 text-sm text-(--color-text-secondary)">
      {icon} {label}
    </div>
  );
}

export function PrStatusSection({ sessionId, card }: { sessionId: string; card: PrCardState }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const pr = card.pr;
  const deployments = status?.deployments ?? [];
  const mergeable = status?.mergeable;
  const reviewDecision = status?.reviewDecision;
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const autoFixCi = useSettingsStore((s) => s.autoFixCi);
  const checks = card.checks ?? (status ? status.checks : undefined);
  const autoFix = card.autoFix;
  const autoMerge = card.autoMerge;
  const isCiFailed = checks?.state === "failure";
  const isCiPassed = checks?.state === "success";
  const isCiNone = checks?.state === "none";
  const isConflicting = mergeable === "conflicting";
  // docs/174 — gate the merge button on GitHub's review decision too.
  const isReviewBlocked = reviewDecision === "review_required" || reviewDecision === "changes_requested";
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const showConflictUi = isConflicting && rebaseStatus === "idle" && card.phase === "open" && pr;
  const canMerge = (isCiPassed || isCiNone) && !isConflicting && !isReviewBlocked;
  const showMergeButton = card.phase === "open" && canMerge && !autoMerge?.enabled;
  // docs/169 — auto-fix is a global setting; the manual "Fix CI" button shows
  // when CI failed and the auto-loop isn't actively handling it.
  const showFixButton = card.phase === "open" && isCiFailed && !isAutoFixRunning && (!autoFixCi || isAutoFixExhausted);
  const showAutoMergeToggle = card.phase === "open" && (!isCiFailed || isCiPassed);
  // Close lives in the merge dropdown and the header's PrActionsMenu, not here;
  // only render the action box when one of these inline controls is present so
  // it never collapses to an empty bordered row.
  const hasActions = showMergeButton || showFixButton || showAutoMergeToggle || !!showConflictUi;

  return (
    <section className="px-4 py-3 border-b border-(--color-border-primary) space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
        Status
      </h3>

      <ChecksSummary checks={checks} />

      <ReviewSummary reviewDecision={reviewDecision} />

      {hasActions && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-(--color-border-primary) bg-(--color-bg-secondary)/40 p-2">
          {showMergeButton && <MergeButton sessionId={sessionId} autoMerge={autoMerge} />}
          {showFixButton && <FixCIButton sessionId={sessionId} />}
          {showAutoMergeToggle && <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />}
          {showConflictUi && (
            <ResolveConflictsButton sessionId={sessionId} baseBranch={pr.baseBranch} />
          )}
        </div>
      )}

      {autoMerge?.enabled && !isCiPassed && !isCiNone && (
        <div className="text-xs text-(--color-text-secondary)">
          Will merge when CI passes.
        </div>
      )}
      {autoMerge?.error && (
        <div className="flex items-center gap-1 text-xs text-(--color-warning)">
          <WarningIcon size={12} /> {autoMerge.error.message}
        </div>
      )}
      {isAutoFixRunning && autoFix && (
        <div className="flex items-center gap-2 text-xs text-(--color-warning)">
          <CircleNotchIcon size={12} className="animate-spin" />
          Auto-fixing (attempt {autoFix.attemptCount}/{autoFix.maxAttempts})...
        </div>
      )}
      {isAutoFixExhausted && autoFix && (
        <div className="text-xs text-(--color-text-tertiary)">
          Auto-fix exhausted ({autoFix.maxAttempts}/{autoFix.maxAttempts} attempts)
        </div>
      )}

      {mergeable === "conflicting" && (
        <div className="flex items-center gap-2 text-sm text-(--color-warning)">
          <WarningIcon size={ICON_SIZE.SM} /> Branch has merge conflicts with the base branch.
        </div>
      )}

      {deployments.length > 0 && (
        <div className="space-y-1">
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
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
