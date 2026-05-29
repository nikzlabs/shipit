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
  XIcon,
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
  /** Docker-units limits the container actually booted with, or null when unknown. */
  bootedLimits: { memoryLimit: number; cpuQuota: number; pidsLimit: number } | null;
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

interface ParsedShipitConfig {
  agent: { memory: number; cpu: number; pids: number; install: string[] };
  compose?: { file: string; dockerSocket: boolean };
  version?: number;
  warnings: string[];
  /** YAML parse error message, if shipit.yaml is malformed. */
  parseError?: string;
  /** Post-clamp values the container actually boots on. */
  effectiveAgent: { memory: number; cpu: number; pids: number; dockerAccess: boolean };
}

interface OomBreakerState {
  tripped: boolean;
  countInWindow: number;
  lastOomAt: number | null;
  trippedAt: number | null;
  threshold: number;
  windowMs: number;
}

interface DiagnosticsPayload {
  sessionId: string;
  generatedAt: number;
  health: ContainerHealthPayload | { error: string };
  services: ServiceDiagnostic[];
  stackStartError: string | null;
  runner: RunnerDiagnostic | null;
  recentLogs: LogEntry[];
  parsedConfig: ParsedShipitConfig | null;
  oomBreaker: OomBreakerState | null;
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-9 w-9 max-md:h-10 max-md:w-10"
              aria-label="Close"
            >
              <XIcon size={ICON_SIZE.MD} weight="bold" />
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

              <Section title="Parsed shipit.yaml">
                <ParsedConfigRows
                  config={data.parsedConfig}
                  bootedLimits={
                    data.health && !("error" in data.health)
                      ? data.health.bootedLimits
                      : null
                  }
                />
              </Section>

              <Section title="OOM circuit breaker">
                <OomBreakerRows state={data.oomBreaker} />
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

function ParsedConfigRows({
  config,
  bootedLimits,
}: {
  config: ParsedShipitConfig | null;
  /** Docker-units limits the container actually booted with — see ContainerHealth.bootedLimits. */
  bootedLimits: { memoryLimit: number; cpuQuota: number; pidsLimit: number } | null;
}) {
  if (!config) {
    return (
      <p className="text-(--color-text-tertiary)">
        No workspace directory resolved for this session — shipit.yaml not read.
      </p>
    );
  }
  const { agent, compose, warnings, version, parseError, effectiveAgent } = config;

  // When env caps shrink a declared value, render "declared → effective"
  // inline so the panel reads exactly the way someone debugging an OOM
  // would want: the value they wrote, an arrow, the value the container
  // actually booted on.
  const memoryClamped = effectiveAgent.memory !== agent.memory;
  const cpuClamped = effectiveAgent.cpu !== agent.cpu;
  const pidsClamped = effectiveAgent.pids !== agent.pids;

  // What the container *actually* booted with (Docker units → human units).
  // The parsed config above is read live at request time; the booted
  // limits are frozen at container-create. They diverge exactly when a
  // warm→claim HEAD jump changed agent.memory after the container booted —
  // the incident where diagnostics showed memory: 3072 while the container
  // ran on a 1 GiB cgroup. Showing both side by side surfaces that.
  const bootedMemoryMiB = bootedLimits ? Math.round(bootedLimits.memoryLimit / 1024 / 1024) : null;
  const bootedCpu = bootedLimits ? bootedLimits.cpuQuota / 100_000 : null;
  const bootedPids = bootedLimits ? bootedLimits.pidsLimit : null;
  const memoryMismatch = bootedMemoryMiB !== null && bootedMemoryMiB !== effectiveAgent.memory;
  const cpuMismatch = bootedCpu !== null && bootedCpu !== effectiveAgent.cpu;
  const pidsMismatch = bootedPids !== null && bootedPids !== effectiveAgent.pids;

  return (
    <>
      {parseError && (
        <KvRow
          label="parse error"
          value={parseError}
          valueClass="text-(--color-error) whitespace-pre-wrap"
        />
      )}
      <KvRow
        label="agent.memory"
        value={memoryClamped
          ? `${agent.memory} MiB → ${effectiveAgent.memory} MiB (capped)`
          : `${agent.memory} MiB`}
        valueClass={memoryClamped ? "text-(--color-warning)" : undefined}
      />
      <KvRow
        label="agent.cpu"
        value={cpuClamped
          ? `${agent.cpu} → ${effectiveAgent.cpu} (capped)`
          : `${agent.cpu}`}
        valueClass={cpuClamped ? "text-(--color-warning)" : undefined}
      />
      <KvRow
        label="agent.pids"
        value={pidsClamped
          ? `${agent.pids} → ${effectiveAgent.pids} (capped)`
          : `${agent.pids}`}
        valueClass={pidsClamped ? "text-(--color-warning)" : undefined}
      />
      <KvRow
        label="booted memory"
        value={bootedMemoryMiB === null
          ? "— (container not running / limits unknown)"
          : memoryMismatch
            ? `${bootedMemoryMiB} MiB ⚠ differs from parsed ${effectiveAgent.memory} MiB`
            : `${bootedMemoryMiB} MiB (matches parsed)`}
        valueClass={memoryMismatch ? "text-(--color-error)" : undefined}
      />
      <KvRow
        label="booted cpu"
        value={bootedCpu === null
          ? "—"
          : cpuMismatch
            ? `${bootedCpu} ⚠ differs from parsed ${effectiveAgent.cpu}`
            : `${bootedCpu}`}
        valueClass={cpuMismatch ? "text-(--color-error)" : undefined}
      />
      <KvRow
        label="booted pids"
        value={bootedPids === null
          ? "—"
          : pidsMismatch
            ? `${bootedPids} ⚠ differs from parsed ${effectiveAgent.pids}`
            : `${bootedPids}`}
        valueClass={pidsMismatch ? "text-(--color-error)" : undefined}
      />
      <KvRow
        label="agent.install"
        value={agent.install.length === 0 ? "—" : agent.install.join(" && ")}
      />
      <KvRow
        label="compose"
        value={
          compose
            ? `${compose.file}${compose.dockerSocket ? " (docker-socket: true)" : ""}`
            : "—"
        }
      />
      {version !== undefined && <KvRow label="version" value={String(version)} />}
      {warnings.length > 0 && (
        <div className="mt-1 rounded border border-(--color-warning) bg-(--color-warning)/10 p-2 space-y-1">
          <div className="text-(--color-warning) font-semibold uppercase tracking-wide text-[11px]">
            {warnings.length === 1 ? "warning" : `${warnings.length} warnings`}
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="text-(--color-text-secondary) whitespace-pre-wrap break-words">
              {w}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

function OomBreakerRows({ state }: { state: OomBreakerState | null }) {
  if (!state) {
    return <p className="text-(--color-text-tertiary)">Not wired (test mode / local runtime).</p>;
  }
  const windowLabel = `${Math.round(state.windowMs / 1000)}s`;
  return (
    <>
      <KvRow
        label="status"
        value={state.tripped
          ? `tripped — refusing new containers until "Rescue session" resets it`
          : `healthy (${state.countInWindow}/${state.threshold} OOM kills in last ${windowLabel})`}
        valueClass={state.tripped ? "text-(--color-error)" : ""}
      />
      <KvRow
        label="last OOM"
        value={state.lastOomAt
          ? `${formatRelative(state.lastOomAt)} (${new Date(state.lastOomAt).toISOString()})`
          : "—"}
      />
      {state.trippedAt !== null && (
        <KvRow
          label="tripped at"
          value={`${formatRelative(state.trippedAt)} (${new Date(state.trippedAt).toISOString()})`}
          valueClass="text-(--color-error)"
        />
      )}
      {state.tripped && (
        <p className="mt-1 text-(--color-text-secondary)">
          The agent container hit its memory cap repeatedly. Increase
          {" "}<code>agent.memory</code> in <code>shipit.yaml</code> and use
          {" "}<strong>Rescue session</strong> to retry — that clears the breaker.
        </p>
      )}
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
