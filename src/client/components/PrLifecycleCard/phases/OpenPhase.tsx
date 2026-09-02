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
  // The arming that can still act on THIS pull request — never the raw card
  // value, which can carry an arming the PR already outlived (docs/077). Read
  // above the early return below: hooks run unconditionally.
  const autoMerge = useActiveAutoMerge(sessionId);
  if (!pr) return null;

  const autoFix = card.autoFix;
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
 *
 * `lastError` is unbounded: most values are short labels ("timeout",
 * "force_push_failed"), but the error paths carry `getErrorMessage(err)` from a
 * failed git command, which can be a screenful of stderr. The banner therefore
 * caps the message at a few lines and scrolls the rest, and carries a dismiss
 * button — otherwise a long error pushes the whole conversation out of view
 * with no way to close it.
 */
function AutoResolveFailureBanner({ sessionId, card }: { sessionId: string; card: PrCardState }) {
  const enabled = useSettingsStore((s) => s.autoResolveConflicts);
  const setToast = useUiStore((s) => s.setToast);
  // The failure on show, or null when there is none. Both re-arm conditions read
  // off this one value.
  const lastError =
    card.autoResolve?.status === "exhausted" ? (card.autoResolve.lastError ?? "unknown error") : null;
  // Dismissal hides ONE failure, not the feature, so it is keyed on the failure
  // it dismissed. That re-arms the banner on BOTH transitions that mean "this is
  // a different failure": the status leaving "exhausted" (lastError → null), and
  // a fresh exhaustion carrying a different error. Keying on the status alone
  // would miss `exhausted A → exhausted B` — which a viewer that reconnected
  // across the intervening reset genuinely sees, since it never rendered the
  // non-exhausted snapshots in between.
  //
  // The re-arm is a render-phase adjustment rather than an effect: it is derived
  // from the state this render already has, and it self-terminates (once
  // cleared, the condition is false).
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
