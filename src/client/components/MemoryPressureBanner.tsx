/**
 * MemoryPressureBanner — surfaces when Docker memory usage crosses
 * `MEMORY_PRESSURE_BANNER_THRESHOLD` (80%) so the user can react before
 * the orchestrator starts auto-evicting idle containers (or the host
 * starts OOM-killing them).
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
import { MEMORY_PRESSURE_BANNER_THRESHOLD } from "../../server/orchestrator/memory-pressure.js";

interface MemoryPressureBannerProps {
  stats: DockerMemoryStats | null;
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function MemoryPressureBanner({ stats }: MemoryPressureBannerProps) {
  if (!stats || stats.totalBytes <= 0) return null;
  const fraction = stats.usedBytes / stats.totalBytes;
  if (fraction < MEMORY_PRESSURE_BANNER_THRESHOLD) return null;

  const pct = Math.round(fraction * 100);
  const used = formatGiB(stats.usedBytes);
  const total = formatGiB(stats.totalBytes);
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
        Docker memory: {used} / {total} ({pct}%)
      </span>
      <span className="hidden sm:inline opacity-90">
        {isCritical
          ? "— host is near OOM. Close inactive sessions or archive a few to free memory."
          : "— close inactive sessions to free memory before things get evicted."}
      </span>
    </div>
  );
}
