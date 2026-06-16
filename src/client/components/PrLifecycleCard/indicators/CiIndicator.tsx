import type { PrCardState } from "../../../stores/pr-store.js";
import { CheckCircleIcon, XCircleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";

export function CiIndicator({ checks }: { checks: PrCardState["checks"] }) {
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
