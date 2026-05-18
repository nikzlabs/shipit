// eslint-disable-next-line no-restricted-imports -- useEffect: setInterval lifecycle for the ticking clock (external timer sync)
import { useEffect, useState } from "react";

interface UptimeBadgeProps {
  /** Epoch milliseconds when the orchestrator process started. */
  processStartedAt: number;
}

/**
 * Format an elapsed-millisecond span into a compact human label:
 *   < 60s   → "Ns"
 *   < 1h    → "Mm Ss"
 *   < 1d    → "Hh Mm"
 *   >= 1d   → "Dd Hh"
 *
 * Negative values (clock skew between server and client) clamp to 0.
 */
export function formatUptime(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Live-ticking uptime indicator. Reads `processStartedAt` (server epoch ms)
 * and recomputes the elapsed time once a second. The badge re-renders only
 * when the displayed label changes, so a stale tab doesn't waste cycles.
 *
 * Sits next to DockerMemoryBadge in the header — the user's only signal
 * that "Just Restart" actually bounced the orchestrator process.
 */
export function UptimeBadge({ processStartedAt }: UptimeBadgeProps) {
  const [label, setLabel] = useState(() => formatUptime(Date.now() - processStartedAt));

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    // Reset immediately if the source timestamp changed (e.g. after a
    // restart bounced the orchestrator and SSE reconnected with a fresh
    // start time).
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
    <span
      className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-(--color-bg-hover) text-(--color-text-secondary) font-medium tabular-nums"
      title={`Orchestrator uptime: ${label} (started ${new Date(processStartedAt).toLocaleString()})`}
    >
      {label}
    </span>
  );
}
