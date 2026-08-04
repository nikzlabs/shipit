import { usePrStore } from "../../../stores/pr-store.js";
import type { PrCardState } from "../../../stores/pr-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useCiDisplay } from "../../../hooks/useCiDisplay.js";
import { useIsMobile } from "../../../hooks/useMediaQuery.js";
import { WarningIcon } from "@phosphor-icons/react";
import { PrStateBadge } from "../PrStateBadge.js";
import { PrMergeActions, PrStatusActions } from "../PrStatusActions.js";
import { BranchLabel, Spinner } from "../shared.js";
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
  // The status chips and action controls live in this column on desktop, but
  // are hoisted to a full-width row below the header on mobile — see
  // PrStatusActions for why (the card's icon cluster narrows every row here).
  const isMobile = useIsMobile();
  if (!pr) return null;

  const autoFix = card.autoFix;
  const autoMerge = card.autoMerge;
  const isAutoFixRunning = autoFix?.status === "running";
  const isAutoFixExhausted = autoFix?.status === "exhausted";
  const isCiFailed = ciDisplay.kind === "failure";
  // "none" must come from the poller explicitly — `"unknown"` means we haven't
  // heard from the poller yet, so we don't know whether CI exists. See
  // PrStatusActions, which gates the merge button on the same distinction.
  const isCiNone = ciDisplay.kind === "none";

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
