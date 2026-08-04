import type { DockerMemoryStats } from "../../server/shared/types.js";
import { Badge } from "./ui/badge.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface DockerMemoryBadgeProps {
  stats: DockerMemoryStats;
}

export function DockerMemoryBadge({ stats }: DockerMemoryBadgeProps) {
  const { usedBytes, totalBytes } = stats;
  const hasLimit = totalBytes > 0;
  const pct = hasLimit ? (usedBytes / totalBytes) * 100 : 0;

  // Severity tiers use theme-aware semantic tokens so contrast holds on every
  // theme (hardcoded Tailwind shades like text-yellow-400 wash out on light bg).
  let colorClass = "text-(--color-text-secondary)";
  if (hasLimit) {
    if (pct >= 90) colorClass = "text-(--color-error)";
    else if (pct >= 60) colorClass = "text-(--color-warning)";
  }

  const label = hasLimit
    ? `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`
    : formatBytes(usedBytes);

  const title = hasLimit
    ? `Docker memory: ${formatBytes(usedBytes)} used of ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`
    : `Docker memory: ${formatBytes(usedBytes)} used`;

  // Background stays constant; only the text color tracks severity, so override
  // the chip background and the (conditional) text color over Badge's default.
  return (
    <Badge numeric className={`bg-(--color-bg-hover) ${colorClass}`} title={title}>
      {label}
    </Badge>
  );
}
