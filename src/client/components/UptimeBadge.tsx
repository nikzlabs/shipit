// eslint-disable-next-line no-restricted-imports -- useEffect: setInterval lifecycle for the ticking clock (external timer sync)
import { useEffect, useState } from "react";

interface UptimeBadgeProps {
  /** Epoch milliseconds when the orchestrator process started. */
  processStartedAt: number;
}

/**
 * Format an elapsed-millisecond span as total minutes ("Nm"). Sub-minute
 * spans render as "0m". Negative values (clock skew between server and
 * client) clamp to 0.
 */
export function formatUptime(elapsedMs: number): string {
  const totalMin = Math.max(0, Math.floor(elapsedMs / 60_000));
  return `${totalMin}m`;
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
