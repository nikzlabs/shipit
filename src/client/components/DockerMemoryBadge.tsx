import type { DockerMemoryStats } from "../../server/shared/types.js";

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

  // Color tiers: green → yellow → orange → red
  let colorClass = "text-(--color-text-secondary)";
  if (hasLimit) {
    if (pct >= 90) colorClass = "text-red-400";
    else if (pct >= 75) colorClass = "text-orange-400";
    else if (pct >= 60) colorClass = "text-yellow-400";
  }

  const label = hasLimit
    ? `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`
    : formatBytes(usedBytes);

  const title = hasLimit
    ? `Docker memory: ${formatBytes(usedBytes)} used of ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`
    : `Docker memory: ${formatBytes(usedBytes)} used`;

  return (
    <span
      className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-(--color-bg-hover) ${colorClass} font-medium tabular-nums`}
      title={title}
    >
      {label}
    </span>
  );
}
