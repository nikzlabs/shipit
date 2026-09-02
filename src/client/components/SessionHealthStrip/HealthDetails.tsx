/**
 * HealthDetails — the expandable diagnostic detail rows shown when the user
 * toggles "details" in the SessionHealthStrip. Renders the raw health probe
 * fields (container id, worker url, runner flag, viewers, last SSE event).
 */

import {
  type ContainerHealth,
  formatLatency,
  formatStaleness,
} from "./utils/healthState.js";

export interface HealthDetailsProps {
  sessionId: string;
  health: ContainerHealth | null;
  error: string | null;
}

export function HealthDetails({ sessionId, health, error }: HealthDetailsProps) {
  return (
    // Bounded for the same reason as the strip's creation-error box: this block
    // is inserted into TerminalPanel's flex column above a `flex-1 min-h-0` log
    // view, so its content height is taken first and the log gets the leftover.
    // The `poll error` row below carries an unbounded message, and on a narrow
    // panel any `break-all` value can wrap into extra lines. `max-h-48` sits
    // above the block's natural height (measured: 178px for the nine rows at a
    // 900px width), so opening details looks exactly as it did; past that it
    // scrolls. `tabIndex` makes the clipped rows reachable by keyboard.
    <div
      className="max-h-48 overflow-y-auto px-3 py-2 border-t border-(--color-border-secondary) bg-(--color-bg-tertiary) font-mono text-[11px] leading-relaxed"
      tabIndex={0}
      role="group"
      aria-label="Session health details"
      data-testid="health-details"
    >
      <DetailRow label="session" value={sessionId} />
      <DetailRow label="container" value={health?.containerState ?? "—"} />
      <DetailRow label="container id" value={health?.containerId ?? "—"} />
      <DetailRow label="worker url" value={health?.workerUrl ?? "—"} />
      <DetailRow
        label="worker"
        value={
          health
            ? health.workerReachable
              ? `reachable (${formatLatency(health.workerLatencyMs)})`
              : "unreachable"
            : "—"
        }
      />
      <DetailRow
        label="agent (worker)"
        value={
          health?.agentRunning === null || health?.agentRunning === undefined
            ? "—"
            : health.agentRunning ? "running" : "idle"
        }
      />
      <DetailRow
        label="runner.running"
        value={
          health?.runnerRunningFlag === null || health?.runnerRunningFlag === undefined
            ? "—"
            : String(health.runnerRunningFlag)
        }
      />
      <DetailRow
        label="viewers"
        value={
          health?.viewerCount === null || health?.viewerCount === undefined
            ? "—"
            : String(health.viewerCount)
        }
      />
      <DetailRow
        label="last sse event"
        value={health?.lastEventAt ? formatStaleness(health.lastEventAt) : "—"}
      />
      {error && <DetailRow label="poll error" value={error} valueClass="text-(--color-error)" />}
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-(--color-text-tertiary) shrink-0 w-32">{label}</span>
      <span className={`text-(--color-text-secondary) break-all ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}
