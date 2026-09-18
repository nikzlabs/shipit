// eslint-disable-next-line no-restricted-imports -- useEffect: setInterval lifecycle for the ticking clock (external timer sync)
import { useEffect, useState } from "react";
import { Badge } from "./ui/badge.js";

interface UptimeBadgeProps {

  processStartedAt: number;
}

export function formatUptime(elapsedMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

export function UptimeBadge({ processStartedAt }: UptimeBadgeProps) {
  const [label, setLabel] = useState(() => formatUptime(Date.now() - processStartedAt));

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {

    setLabel(formatUptime(Date.now() - processStartedAt));

    const interval = setInterval(() => {
      setLabel((prev) => {
        const next = formatUptime(Date.now() - processStartedAt);
        return next === prev ? prev : next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [processStartedAt]);

  return (
    <Badge
      numeric
      className="bg-(--color-bg-hover)"
      title={`Orchestrator uptime: ${label} (started ${new Date(processStartedAt).toLocaleString()})`}
    >
      {label}
    </Badge>
  );
}
