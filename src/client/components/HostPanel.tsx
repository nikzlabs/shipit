/**
 * HostPanel — read-only "Host" tab for ops sessions (docs/128).
 *
 * Renders the orchestrator's host signals inline: every ShipIt-managed
 * container with its Docker state, status, and owning session. Informational
 * only (§1/§2) — there are NO action buttons here. To *do* anything (inspect
 * logs, kill an orphan) the operator asks the agent in chat (§5), which reaches
 * Docker read-only through the proxy.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: poll the host overview while the tab is visible
import { useCallback, useEffect, useState } from "react";
import { ArrowClockwiseIcon, CircleNotchIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { formatRelativeDate } from "../utils/dates.js";
import { ShipitSourceStatusCard } from "./ShipitSourceStatusCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { HostOverview, HostContainerInfo } from "../../server/shared/types.js";

interface HostPanelProps {
  /** True while the tab is visible — gates the background poll. */
  isActiveTab: boolean;
}

/** Local mirror of the orchestrator's `ShipitSourceStatus` DTO (docs/162). */
interface SourceStatus {
  available: boolean;
  ref?: string;
  shortRef?: string;
  exact: boolean;
  refSource?: "build-id" | "checkout-head";
  remoteUrl?: string;
  reason?: string;
}

const POLL_MS = 5000;

function stateColor(state: string): string {
  if (state === "running") return "bg-(--color-success)";
  if (state === "restarting" || state === "paused" || state === "created") return "bg-(--color-warning)";
  return "bg-(--color-error)"; // exited / dead
}

function ContainerRow({ c }: { c: HostContainerInfo }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-(--color-border-primary)">
      <span
        className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${stateColor(c.state)}`}
        title={c.state}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-(--color-text-primary) truncate">
            {c.sessionTitle ?? c.name}
          </span>
          {c.agentRunning && (
            <span className="text-[9px] font-semibold uppercase tracking-wide text-(--color-success) shrink-0">
              agent running
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-(--color-text-tertiary)">
          <span className="truncate">{c.status}</span>
          <span className="opacity-50">·</span>
          <span className="font-mono shrink-0">{c.id}</span>
        </div>
        <div className="text-[10px] text-(--color-text-tertiary) truncate mt-px font-mono opacity-70">
          {c.image}
        </div>
      </div>
    </div>
  );
}

export function HostPanel({ isActiveTab }: HostPanelProps) {
  const [data, setData] = useState<HostOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // docs/162 — the running ShipIt source ref the Ops agent's `shipit source *`
  // reads run against. Fetched per active ops session (the route is gated on
  // `kind === "ops"`); changes only on deploy, so no tight poll.
  const sessionId = useSessionStore((s) => s.sessionId);
  const [source, setSource] = useState<SourceStatus | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/host/overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as HostOverview;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSource = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/source/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SourceStatus;
      setSource(json);
      setSourceError(null);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  // Poll while the tab is open; stop when it's hidden so a background ops
  // session isn't hammering the Docker socket. This is a genuine external-system
  // sync (a polling timer with cleanup), which the rule explicitly permits.
  // eslint-disable-next-line no-restricted-syntax -- interval polling of the host overview with cleanup on unmount/tab-hide
  useEffect(() => {
    if (!isActiveTab) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [isActiveTab, refresh]);

  // Source status changes only on deploy — fetch once when the tab opens
  // (and whenever the active session changes), no interval.
  // eslint-disable-next-line no-restricted-syntax -- one-shot source-status fetch on tab activation
  useEffect(() => {
    if (!isActiveTab) return;
    void refreshSource();
  }, [isActiveTab, refreshSource]);

  return (
    <div className="absolute inset-0 flex flex-col bg-(--color-bg-primary)">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-(--color-border-primary) shrink-0">
        <span className="text-xs font-semibold text-(--color-text-secondary)">Host containers</span>
        {data?.dockerAvailable && (
          <span className="text-[10px] text-(--color-text-tertiary)">
            {data.totals.running}/{data.totals.containers} running
          </span>
        )}
        <span className="flex-1" />
        {data && (
          <span className="text-[10px] text-(--color-text-tertiary)">
            {formatRelativeDate(data.generatedAt)}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          className="p-0! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          aria-label="Refresh host overview"
        >
          {loading
            ? <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" />
            : <ArrowClockwiseIcon size={ICON_SIZE.SM} />}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <ShipitSourceStatusCard status={source} error={sourceError} />
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-(--color-error)">
            <WarningIcon size={ICON_SIZE.SM} className="shrink-0" />
            <span>Failed to load host overview: {error}</span>
          </div>
        )}
        {data && !data.dockerAvailable && (
          <div className="px-3 py-6 text-center text-xs text-(--color-text-tertiary)">
            Docker is unreachable from the orchestrator.
          </div>
        )}
        {data?.dockerAvailable && data.containers.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-(--color-text-tertiary)">
            No ShipIt-managed containers running.
          </div>
        )}
        {data?.containers.map((c) => <ContainerRow key={c.id} c={c} />)}
      </div>

      <div className="shrink-0 border-t border-(--color-border-primary) px-3 py-1.5 text-[10px] text-(--color-text-tertiary)">
        Read-only. Ask the agent in chat to investigate a container.
      </div>
    </div>
  );
}
