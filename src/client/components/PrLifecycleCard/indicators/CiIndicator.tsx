import type { PrCardState } from "../../../stores/pr-store.js";
import { CheckCircleIcon, XCircleIcon, CircleNotchIcon, CircleDashedIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { useCiDisplay } from "../../../hooks/useCiDisplay.js";

/**
 * Why "no checks" is a visible chip and not blank space: an empty check-run
 * set is a *terminal* state, and it's the one the indicator is best placed to
 * report. Rendering nothing made it indistinguishable from "the poller hasn't
 * spoken yet", so the preceding grace spinner read as an unresolved load —
 * users waited on a result that was never coming, or went hunting for a broken
 * runner (nikzlabs/shipit#1730). Neutral tertiary color keeps it informational:
 * no CI is a fact about the repo, not a failure and not pending work.
 */
export function CiIndicator({ checks }: { checks: PrCardState["checks"] }) {
  const display = useCiDisplay(checks);

  if (display.kind === "unknown") return null;

  if (display.kind === "none") {
    return (
      <span
        className="h-6 text-(--color-text-tertiary) text-xs flex items-center gap-1 shrink-0"
        title="No CI checks ran for this pull request — no workflow matched the pull request event"
      >
        <CircleDashedIcon size={ICON_SIZE.SM} /> No checks
      </span>
    );
  }

  if (display.kind === "success") {
    return (
      <span className="h-6 text-(--color-success) text-xs flex items-center gap-1 shrink-0" title={`CI passed  ${display.total}/${display.total} checks`}>
        <CheckCircleIcon size={ICON_SIZE.SM} /> CI {display.total}/{display.total}
      </span>
    );
  }
  if (display.kind === "failure") {
    return (
      <span className="h-6 text-(--color-error) text-xs flex items-center gap-1 shrink-0" title={`CI failed  ${display.failed} of ${display.total}`}>
        <XCircleIcon size={ICON_SIZE.SM} /> CI {display.passed}/{display.total}
      </span>
    );
  }
  // pending
  const pendingLabel = display.total === 0 ? "CI" : `CI ${display.passed}/${display.total}`;
  const pendingTitle = display.total === 0 ? "Waiting for CI checks to start" : `CI running  ${display.passed}/${display.total}`;
  return (
    <span className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0 animate-pulse" title={pendingTitle}>
      <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" /> {pendingLabel}
    </span>
  );
}
