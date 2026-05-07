/**
 * SessionDiagnosticsPanel — single-screen aggregate of everything the
 * orchestrator knows about a session.
 *
 * See docs/124-session-rescue-and-diagnostics §3. Reachable from the
 * SessionHealthStrip's "Open diagnostics" button. Polls
 * `GET /api/sessions/:id/diagnostics` while open. The "Copy" button
 * dumps the full payload as JSON for bug reports.
 *
 * The panel is read-only: every action belongs to other surfaces
 * (Kill agent / Restart container live in the strip itself). This
 * screen exists so the user can SEE state — and copy it into a chat
 * or issue when something is broken.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: polling external state
import { useEffect, useState, useCallback } from "react";
import {
  CopyIcon,
  CheckIcon,
  CaretRightIcon,
  CaretDownIcon,
} from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import { ICON_SIZE } from "../design-tokens.js";

// ---- Server payload shape (mirrors services/diagnostics.ts) ----

interface ContainerHealthPayload {
  containerState: string;
  workerReachable: boolean;
  workerLatencyMs: number | null;
  agentRunning: boolean | null;
  lastEventAt: number | null;
  runnerRunningFlag: boolean | null;
  viewerCount: number | null;
  lastCreateError: string | null;
  lastCreateErrorAt: number | null;
  workerUrl: string | null;
  containerId: string | null;
}

interface ServiceDiagnostic {
  name: string;
  status: "stopped" | "starting" | "running" | "error";
  preview: "auto" | "manual";
  port: number | null;
  containerIp: string | null;
  error: string | null;
  logTail: string;
}

interface RunnerDiagnostic {
  running: boolean;
  viewerCount: number;
  queueLength: number;
  lastSseEventAt: number;
  turnEventBufferSize: number;
  disposed: boolean;
}

interface LogEntry {
  type: "log_entry";
  source: "stderr" | "stdout" | "server" | "preview" | "install";
  text: string;
  timestamp: string;
}

interface DiagnosticsPayload {
  sessionId: string;
  generatedAt: number;
  health: ContainerHealthPayload | { error: string };
  services: ServiceDiagnostic[];
  stackStartError: string | null;
  runner: RunnerDiagnostic | null;
  recentLogs: LogEntry[];
}

const POLL_INTERVAL_MS = 2000;

export interface SessionDiagnosticsPanelProps {
  sessionId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SessionDiagnosticsPanel({ sessionId, open, onOpenChange }: SessionDiagnosticsPanelProps) {
  const api = useApi();
  const [data, setData] = useState<DiagnosticsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const poll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const fresh = await api.get<DiagnosticsPayload>(`/api/sessions/${sessionId}/diagnostics`);
      setData(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api, sessionId]);

  // Poll while open. Reset state when the dialog closes so the next
  // open starts clean.
  // eslint-disable-next-line no-restricted-syntax -- polling external state while dialog is open
  useEffect(() => {
    if (!open || !sessionId) {
      setData(null);
      setError(null);
      setCopied(false);
      return;
    }
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, sessionId, poll]);

  const onCopy = useCallback(async () => {
    if (!data) return;
    const payload = {
      ...data,
      clientCopiedAt: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Browsers may deny clipboard access (insecure context, permission
      // policy). Fall back to letting the user copy manually from the JSON
      // panel in the UI — silently swallow here so we don't crash the
      // dialog.
    }
  }, [data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(960px,95vw)] max-w-none p-0 flex flex-col">
        <DialogHeader>
          <DialogTitle>Session diagnostics</DialogTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onCopy()}
              disabled={!data}
              title="Copy the full diagnostics payload as JSON for bug reports."
            >
              {copied
                ? <CheckIcon size={ICON_SIZE.XS} />
                : <CopyIcon size={ICON_SIZE.XS} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-auto p-5 space-y-5 text-xs font-mono">
          {!data && !error && <p className="text-(--color-text-tertiary)">Loading…</p>}
          {error && (
            <p className="text-(--color-error)">Failed to load diagnostics: {error}</p>
          )}
          {data && (
            <>
              <Section title="Container & worker">
                <HealthRows health={data.health} />
                {data.stackStartError && (
                  <KvRow
                    label="stack start error"
                    value={data.stackStartError}
                    valueClass="text-(--color-error) whitespace-pre-wrap"
                  />
                )}
              </Section>

              <Section title={`Compose stack (${data.services.length})`}>
                {data.services.length === 0 && (
                  <p className="text-(--color-text-tertiary)">No compose services.</p>
                )}
                {data.services.map((svc) => (
                  <ServiceRow key={svc.name} svc={svc} />
                ))}
              </Section>

              <Section title="Runner">
                {data.runner === null && (
                  <p className="text-(--color-text-tertiary)">No runner attached.</p>
                )}
                {data.runner && <RunnerRows runner={data.runner} />}
              </Section>

              <Section title={`Recent logs (${data.recentLogs.length})`}>
                {data.recentLogs.length === 0 && (
                  <p className="text-(--color-text-tertiary)">No log entries.</p>
                )}
                {data.recentLogs.length > 0 && (
                  <pre className="bg-(--color-bg-tertiary) border border-(--color-border-secondary) rounded p-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                    {data.recentLogs.map((e) => `[${e.timestamp}] [${e.source}] ${e.text}`).join("\n")}
                  </pre>
                )}
              </Section>

              <Section title="Meta">
                <KvRow label="session" value={data.sessionId} />
                <KvRow label="generated at" value={new Date(data.generatedAt).toISOString()} />
              </Section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Sub-components ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-(--color-text-primary) mb-2 uppercase tracking-wide">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function KvRow({
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
      <span className="text-(--color-text-tertiary) shrink-0 w-40">{label}</span>
      <span className={`text-(--color-text-secondary) break-all ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}

function HealthRows({ health }: { health: DiagnosticsPayload["health"] }) {
  if ("error" in health) {
    return <KvRow label="health" value={health.error} valueClass="text-(--color-error)" />;
  }
  return (
    <>
      <KvRow label="container state" value={health.containerState} />
      <KvRow label="container id" value={health.containerId ?? "—"} />
      <KvRow label="worker url" value={health.workerUrl ?? "—"} />
      <KvRow
        label="worker reachable"
        value={
          health.workerReachable
            ? `yes${health.workerLatencyMs !== null ? ` (${health.workerLatencyMs}ms)` : ""}`
            : "no"
        }
        valueClass={health.workerReachable ? "" : "text-(--color-error)"}
      />
      <KvRow
        label="agent (worker)"
        value={health.agentRunning === null ? "—" : health.agentRunning ? "running" : "idle"}
      />
      <KvRow
        label="runner.running"
        value={health.runnerRunningFlag === null ? "—" : String(health.runnerRunningFlag)}
      />
      <KvRow
        label="viewers"
        value={health.viewerCount === null ? "—" : String(health.viewerCount)}
      />
      <KvRow
        label="last sse event"
        value={
          health.lastEventAt
            ? `${formatRelative(health.lastEventAt)} (${new Date(health.lastEventAt).toISOString()})`
            : "—"
        }
      />
      {health.lastCreateError && (
        <KvRow
          label="last create error"
          value={
            health.lastCreateErrorAt
              ? `${health.lastCreateError} (${formatRelative(health.lastCreateErrorAt)})`
              : health.lastCreateError
          }
          valueClass="text-(--color-error) whitespace-pre-wrap"
        />
      )}
    </>
  );
}

function RunnerRows({ runner }: { runner: RunnerDiagnostic }) {
  return (
    <>
      <KvRow label="running" value={String(runner.running)} />
      <KvRow label="viewer count" value={String(runner.viewerCount)} />
      <KvRow label="queue length" value={String(runner.queueLength)} />
      <KvRow
        label="last sse event"
        value={
          runner.lastSseEventAt
            ? `${formatRelative(runner.lastSseEventAt)} (${new Date(runner.lastSseEventAt).toISOString()})`
            : "—"
        }
      />
      <KvRow label="turn buffer size" value={String(runner.turnEventBufferSize)} />
      <KvRow label="disposed" value={String(runner.disposed)} />
    </>
  );
}

function ServiceRow({ svc }: { svc: ServiceDiagnostic }) {
  const [expanded, setExpanded] = useState(false);
  const Caret = expanded ? CaretDownIcon : CaretRightIcon;
  const statusColor =
    svc.status === "running" ? "text-(--color-success)"
      : svc.status === "error" ? "text-(--color-error)"
        : svc.status === "starting" ? "text-(--color-warning)"
          : "text-(--color-text-tertiary)";
  return (
    <div className="border border-(--color-border-secondary) rounded">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-(--color-bg-tertiary) transition-colors text-left"
      >
        <Caret size={ICON_SIZE.XS} />
        <span className="font-semibold text-(--color-text-primary)">{svc.name}</span>
        <span className={statusColor}>{svc.status}</span>
        <span className="text-(--color-text-tertiary)">
          {svc.preview === "auto" ? "auto-preview" : "manual"}
          {svc.port !== null && `, port ${svc.port}`}
          {svc.containerIp && `, ip ${svc.containerIp}`}
        </span>
        {svc.error && (
          <span className="text-(--color-error) truncate">— {svc.error}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-(--color-border-secondary) bg-(--color-bg-tertiary) p-2">
          {svc.logTail
            ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                {svc.logTail}
              </pre>
            )
            : <p className="text-(--color-text-tertiary)">No log output buffered.</p>
          }
        </div>
      )}
    </div>
  );
}

function formatRelative(ms: number): string {
  const elapsedSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}s ago`;
  if (elapsedSec < 3600) return `${Math.round(elapsedSec / 60)}m ago`;
  return `${Math.round(elapsedSec / 3600)}h ago`;
}
