import type { HostCpuStats } from "../../server/shared/types.js";
import { Badge } from "./ui/badge.js";

interface HostCpuBadgeProps {
  stats: HostCpuStats;
}

export function HostCpuBadge({ stats }: HostCpuBadgeProps) {
  const pct = Math.round(stats.usedPercent);
  const cores = `${stats.cores} ${stats.cores === 1 ? "core" : "cores"}`;

  let colorClass = "text-(--color-text-secondary)";
  if (pct >= 90) colorClass = "text-(--color-error)";
  else if (pct >= 60) colorClass = "text-(--color-warning)";

  return (
    <Badge
      numeric
      className={`bg-(--color-bg-hover) whitespace-nowrap ${colorClass}`}
      title={`Machine CPU load: ${pct}% of ${cores}, all cores together`}
    >
      {`CPU ${pct}% / ${cores}`}
    </Badge>
  );
}
