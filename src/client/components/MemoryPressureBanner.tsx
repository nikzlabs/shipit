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
 * Threshold rationale: see `src/server/orchestrator/memory-pressure.ts`.
 * The banner fires at 80%; eviction kicks in at 85%; the 5-point gap is
 * deliberate so users see a warning before automatic action.
 */

import { WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { DockerMemoryStats } from "../../server/shared/types.js";
import { MEMORY_PRESSURE_BANNER_THRESHOLD, memoryUsedFraction } from "../../server/orchestrator/memory-pressure.js";

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
  if (fraction === null || fraction < MEMORY_PRESSURE_BANNER_THRESHOLD) return null;

  const budgetBytes = stats.budgetBytes && stats.budgetBytes > 0 ? stats.budgetBytes : stats.totalBytes;
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
      <span className="font-medium tabular-nums">
        {budgetIsSet ? "ShipIt memory" : "Docker memory"}: {used} / {total} ({pct}%)
      </span>
      <span className="hidden sm:inline opacity-90">
        {isCritical
          ? budgetIsSet
            ? "— at the memory budget. Idle sessions are being stopped; close inactive ones to choose what goes."
            : "— host is near OOM. Close inactive sessions or archive a few to free memory."
          : "— close inactive sessions to free memory before things get evicted."}
      </span>
    </div>
  );
}
