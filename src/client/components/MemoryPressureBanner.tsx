/**
 * MemoryPressureBanner — surfaces when memory usage crosses
 * `MEMORY_PRESSURE_BANNER_THRESHOLD` (80%) so the user can react before
 * the orchestrator starts auto-evicting idle containers (or the host
 * starts OOM-killing them).
 *
 * docs/284 — usage is measured against the user's memory budget when one is
 * set, and against host memory otherwise. The banner names which, because
 * "80% of the 16 GB you allotted" and "80% of the machine" call for different
 * reactions.
 *
 * Renders as a thin alert bar above the main layout. Hidden when stats
 * are unavailable or usage is below the threshold.
 *
 * Threshold rationale: see `src/server/orchestrator/memory-pressure.ts`. With
 * no budget set the banner fires at 80% of host and reclaim at 85%; with an
 * explicit budget it fires at 90% of it and reclaim starts AT it. Either way
 * the gap is deliberate, so users see a warning before automatic action.
 */

import { WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { DockerMemoryStats } from "../../server/shared/types.js";
import { isUnderBannerPressure, memoryUsedFraction, targetsOf } from "../../server/orchestrator/memory-pressure.js";

interface MemoryPressureBannerProps {
  stats: DockerMemoryStats | null;
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function MemoryPressureBanner({ stats }: MemoryPressureBannerProps) {
  if (!stats || stats.totalBytes <= 0) return null;
  // docs/284 req 12 — report against the budget that decides reclaim, not the
  // host total. On a large host with a small budget, a host-measured banner
  // would never fire and previews would be stopped with no warning at all.
  const fraction = memoryUsedFraction(stats);
  if (fraction === null || !isUnderBannerPressure(stats)) return null;

  const { budgetBytes } = targetsOf(stats);
  const pct = Math.round(fraction * 100);
  const used = formatGiB(stats.usedBytes);
  const total = formatGiB(budgetBytes);
  const budgetIsSet = budgetBytes < stats.totalBytes;
  // Severity: 80–89% warning (orange), 90%+ critical (red).
  const isCritical = fraction >= 0.90;
  const tone = isCritical
    ? "bg-(--color-error-subtle) text-(--color-error) border-(--color-error)/30"
    : "bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning)/30";

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b ${tone}`}
      data-testid="memory-pressure-banner"
    >
      <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
      {/* Always "Docker memory": the reading sums every running container on
          the host, ShipIt's or not, so calling it ShipIt's own usage would
          overstate what closing a session can give back. What changes with a
          budget is only the number it is measured against. */}
      <span className="font-medium tabular-nums">
        Docker memory: {used} / {total}{budgetIsSet ? " budget" : ""} ({pct}%)
      </span>
      <span className="hidden sm:inline opacity-90">
        {isCritical
          ? budgetIsSet
            ? "— at the memory budget. Idle sessions are being stopped; close inactive ones to choose what goes."
            : "— host is near OOM. Close inactive sessions or archive a few to free memory."
          : "— close inactive sessions to free memory before things get stopped."}
      </span>
    </div>
  );
}
