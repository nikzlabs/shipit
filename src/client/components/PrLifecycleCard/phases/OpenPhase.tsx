import { usePrStore, useActiveAutoMerge } from "../../../stores/pr-store.js";
import type { PrCardState } from "../../../stores/pr-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useCiDisplay } from "../../../hooks/useCiDisplay.js";
import { useIsMobile } from "../../../hooks/useMediaQuery.js";
import { useState } from "react";
import { WarningIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { PrStateBadge } from "../PrStateBadge.js";
import { PrMergeActions, PrStatusActions } from "../PrStatusActions.js";
import { BranchLabel } from "../shared.js";
import { Spinner } from "../../Spinner.js";
import { FailedChecksList, DeploymentStatusRow } from "../indicators/index.js";

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
  const ciDisplay = useCiDisplay(card.checks);

  const isMobile = useIsMobile();
  // The arming that can still act on THIS pull request — never the raw card

  const autoMerge = useActiveAutoMerge(sessionId);
  if (!pr) return null;

  const autoFix = card.autoFix;
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const isCiFailed = ciDisplay.kind === "failure";
  // "none" must come from the poller explicitly — `"unknown"` means we haven't

  const isCiNone = ciDisplay.kind === "none";

  // symmetric top/bottom padding so the last wrapped row never touches the

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
          {/* On mobile the status/action cluster is hoisted out of this column
              into a full-width row below the header (PrLifecycleCard renders
              it), because the card's icon cluster narrows every row here and
              the auto-merge toggle + merge button don't fit in what's left. */}
          {!isMobile && (
            <span className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
              <PrStatusActions card={card} sessionId={sessionId} />
            </span>
          )}
        </div>
        {/* The auto-merge toggle + merge button always get a line of their own,
            below the title/chips row rather than crammed onto its end. */}
        {!isMobile && <PrMergeActions card={card} sessionId={sessionId} canAutoMerge={canAutoMerge} />}
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
            <Spinner size={14} className="text-(--color-info) shrink-0" />
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

function AutoResolveFailureBanner({ sessionId, card }: { sessionId: string; card: PrCardState }) {
  const enabled = useSettingsStore((s) => s.autoResolveConflicts);
  const setToast = useUiStore((s) => s.setToast);

  const lastError =
    card.autoResolve?.status === "exhausted" ? (card.autoResolve.lastError ?? "unknown error") : null;

  // across the intervening reset genuinely sees, since it never rendered the

  const [dismissedError, setDismissedError] = useState<string | null>(null);
  if (dismissedError !== null && dismissedError !== lastError) setDismissedError(null);
  if (!enabled) return null;
  if (lastError === null) return null;
  if (dismissedError === lastError) return null;

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
    <div className="mt-1 flex items-start gap-2 pl-5 text-xs">
      {/* `max-h-20` + `overflow-y-auto` bound the height at ~5 lines; a short
          error still renders as the single line it always was. `min-w-0` lets
          the box shrink inside the flex row so long tokens wrap instead of
          widening the card. `tabIndex` puts the clipped text in the tab order,
          which is what makes a keyboard-only user able to scroll it. */}
      <div
        className="min-w-0 flex-1 max-h-20 overflow-y-auto whitespace-pre-wrap wrap-break-word text-(--color-text-tertiary)"
        tabIndex={0}
        role="group"
        aria-label="Auto-resolve failure detail"
        data-testid="auto-resolve-last-error"
      >
        Auto-resolve couldn&rsquo;t finish. Last error: {lastError}.
      </div>
      <button
        type="button"
        onClick={() => void handleRetry()}
        className="shrink-0 text-(--color-text-primary) hover:underline cursor-pointer"
        data-testid="auto-resolve-retry"
      >
        Retry
      </button>
      {/* `-my-1 p-1` widens the hit target to a comfortable tap size without
          adding a row of height to the banner. */}
      <button
        type="button"
        onClick={() => setDismissedError(lastError)}
        aria-label="Dismiss auto-resolve failure"
        title="Dismiss"
        className="shrink-0 -my-1 p-1 text-(--color-text-tertiary) hover:text-(--color-text-primary) cursor-pointer"
        data-testid="auto-resolve-dismiss"
      >
        <XIcon size={ICON_SIZE.SM} />
      </button>
    </div>
  );
}
