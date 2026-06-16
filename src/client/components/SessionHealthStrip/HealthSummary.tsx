/**
 * HealthSummary — the left side of the SessionHealthStrip top row: the
 * status dot + label, the inline container/worker/agent/last-event metrics,
 * and any poll / action error text. Pure rendering of derived health state.
 */

import { StatusDot } from "../ui/status-dot.js";
import {
  type ContainerHealth,
  dotStatus,
  formatLatency,
  formatStaleness,
  summarize,
} from "./utils/healthState.js";

export interface HealthSummaryProps {
  health: ContainerHealth | null;
  isRestarting: boolean;
  phaseLabel: string | null;
  error: string | null;
  actionError: string | null;
}

export function HealthSummary({
  health,
  isRestarting,
  phaseLabel,
  error,
  actionError,
}: HealthSummaryProps) {
  const summary = summarize(health, isRestarting, phaseLabel);

  return (
    <div className="flex items-center gap-3 min-w-0 flex-1">
      <span className="flex items-center gap-1.5 shrink-0">
        <StatusDot status={dotStatus(summary.severity)} />
        <span className="font-medium text-(--color-text-primary)">{summary.label}</span>
      </span>
      {health && !isRestarting && (
        <>
          <span className="text-(--color-text-tertiary) truncate">
            container: <span className="text-(--color-text-secondary)">{health.containerState}</span>
          </span>
          <span className="text-(--color-text-tertiary) truncate">
            worker:{" "}
            <span className={health.workerReachable ? "text-(--color-text-secondary)" : "text-(--color-error)"}>
              {health.workerReachable ? formatLatency(health.workerLatencyMs) : "unreachable"}
            </span>
          </span>
          <span className="text-(--color-text-tertiary) truncate">
            agent:{" "}
            <span className="text-(--color-text-secondary)">
              {health.agentRunning === null ? "—" : health.agentRunning ? "running" : "idle"}
            </span>
          </span>
          {health.lastEventAt !== null && (
            <span className="text-(--color-text-tertiary) truncate">
              last event:{" "}
              <span className="text-(--color-text-secondary)">{formatStaleness(health.lastEventAt)}</span>
            </span>
          )}
        </>
      )}
      {error && !health && (
        <span className="text-(--color-error) truncate">{error}</span>
      )}
      {actionError && (
        <span className="text-(--color-error) truncate" title={actionError}>
          {actionError}
        </span>
      )}
    </div>
  );
}
