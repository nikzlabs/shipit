import type { SessionContainerManager } from "../session-container.js";
import { deriveSessionMemorySizing, type SessionMemorySizing } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager, ManagedService } from "../service-manager.js";
import type { AgentId, LogRingEntry, ProviderRouteKind } from "../../shared/types.js";
import { getContainerHealth, type ContainerHealth } from "./health.js";
import { workerGet } from "../worker-http.js";
import type { NodeRuntimeStatus } from "../../shared/types/node-runtime-types.js";
import { ServiceError } from "./types.js";
import {
  AGENT_DEFAULTS,
  resolveShipitConfig,
  ShipitConfigError,
  type AgentConfig,
  type ComposeConfig,
} from "../../shared/shipit-config.js";
import type { SessionOomCircuitBreaker, OomBreakerState } from "../oom-circuit-breaker.js";
import {
  installContentKeyDiagnostic,
  type InstallContentKeyOff,
} from "../install-content-key.js";

const SERVICE_LOG_TAIL_LINES = 20;
const NODE_RUNTIME_PROBE_TIMEOUT_MS = 2000;
const RECENT_LOG_LINES = 50;

export interface ServiceDiagnostic {
  name: string;
  status: ManagedService["status"];
  preview: ManagedService["preview"];
  port: number | null;
  containerIp: string | null;
  error: string | null;
  logTail: string;
}

export interface ProviderRouteDiagnostic {
  agentId: AgentId | null;
  kind: ProviderRouteKind | null;
  routeId: string | null;
  label: string;
}

const RESERVED_ROUTE_LABEL: Record<string, string> = {
  "claude-env-oauth": "Anthropic OAuth token from the environment",
  "claude-api-key": "Anthropic API key — metered billing",
  "codex-api-key": "OpenAI API key — metered billing",
};

export interface ProviderRouteSession {
  agentId?: AgentId | null;
  providerRouteKind?: ProviderRouteKind;
  providerRouteId?: string;
}

export function describeProviderRoute(
  session: ProviderRouteSession | undefined,
  getAccountLabel: (provider: AgentId, accountId: string) => string | undefined,
): ProviderRouteDiagnostic | null {
  if (!session) return null;
  const agentId = session.agentId ?? null;
  const kind = session.providerRouteKind ?? null;
  const routeId = session.providerRouteId ?? null;

  if (!kind || !routeId) {
    return { agentId, kind: null, routeId: null, label: "selected per turn — the next turn picks an account" };
  }
  if (kind === "reserved") {
    return { agentId, kind, routeId, label: RESERVED_ROUTE_LABEL[routeId] ?? routeId };
  }
  const label = agentId ? getAccountLabel(agentId, routeId) : undefined;
  return { agentId, kind, routeId, label: label ?? "account no longer connected" };
}

export interface RunnerDiagnostic {
  running: boolean;
  viewerCount: number;
  queueLength: number;
  /** Epoch milliseconds; zero when no event has arrived. */
  lastSseEventAt: number;
  turnEventBufferSize: number;
  disposed: boolean;
}

export interface ParsedShipitConfig {
  agent: AgentConfig;
  compose?: ComposeConfig;
  version?: number;
  warnings: string[];
  parseError?: string;
  sizing: SessionMemorySizing;
}

export interface SessionDiagnostics {
  sessionId: string;
  generatedAt: number;
  health: ContainerHealth | { error: string };
  services: ServiceDiagnostic[];
  stackStartError: string | null;
  runner: RunnerDiagnostic | null;
  recentLogs: LogRingEntry[];
  parsedConfig: ParsedShipitConfig | null;
  oomBreaker: OomBreakerState | null;
  providerRoute: ProviderRouteDiagnostic | null;
  nodeRuntime: NodeRuntimeStatus | null;
  installContentKeyOff: InstallContentKeyOff | null;
}

export interface DiagnosticsDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  serviceManagers: Map<string, ServiceManager>;
  getLogBuffer: (sessionId: string) => LogRingEntry[];
  getWorkspaceDir: (sessionId: string) => string | null;
  oomBreaker?: SessionOomCircuitBreaker;
  getSessionRoute?: (sessionId: string) => ProviderRouteSession | undefined;
  getAccountLabel?: (provider: AgentId, accountId: string) => string | undefined;
}

export async function getSessionDiagnostics(
  deps: DiagnosticsDeps,
  sessionId: string,
): Promise<SessionDiagnostics> {
  const { containerManager, runnerRegistry, serviceManagers, getLogBuffer, getWorkspaceDir, oomBreaker } = deps;

  // A failed container probe must leave service and runner diagnostics available.
  let health: ContainerHealth | { error: string };
  try {
    health = await getContainerHealth({ containerManager, runnerRegistry }, sessionId);
  } catch (err) {
    if (err instanceof ServiceError) {
      health = { error: err.message };
    } else {
      health = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const mgr = serviceManagers.get(sessionId);
  const services: ServiceDiagnostic[] = mgr
    ? mgr.getServices().map((svc) => ({
        name: svc.name,
        status: svc.status,
        preview: svc.preview,
        port: svc.port ?? null,
        containerIp: svc.containerIp ?? null,
        error: svc.error ?? null,
        logTail: tailLines(mgr.getLogBuffer(svc.name), SERVICE_LOG_TAIL_LINES),
      }))
    : [];
  const stackStartError = mgr?.startError ?? null;

  const runner = runnerRegistry.get(sessionId);
  const runnerDiagnostic: RunnerDiagnostic | null = runner
    ? {
        running: runner.running,
        viewerCount: runner.viewerCount,
        queueLength: runner.queueLength,
        lastSseEventAt: typeof runner.lastSseEventAt === "number" ? runner.lastSseEventAt : 0,
        turnEventBufferSize: runner.getTurnEventBuffer().length,
        disposed: readDisposed(runner),
      }
    : null;

  const allLogs = getLogBuffer(sessionId);
  const recentLogs = allLogs.length > RECENT_LOG_LINES
    ? allLogs.slice(-RECENT_LOG_LINES)
    : allLogs.slice();

  const workspaceDir = getWorkspaceDir(sessionId);
  const parsedConfig = workspaceDir ? readParsedConfig(workspaceDir) : null;

  // Display the resident process's route; the next turn may select a different one.
  const resident = runner?.residentRoute;
  const routeSession = deps.getSessionRoute?.(sessionId);
  const providerRoute = deps.getSessionRoute
    ? describeProviderRoute(
        {
          agentId: routeSession?.agentId ?? null,
          ...(resident ? { providerRouteKind: resident.kind, providerRouteId: resident.id } : {}),
        },
        deps.getAccountLabel ?? (() => undefined),
      )
    : null;

  const nodeRuntime = await probeNodeRuntime(containerManager, sessionId);

  return {
    sessionId,
    generatedAt: Date.now(),
    health,
    services,
    stackStartError,
    runner: runnerDiagnostic,
    recentLogs,
    parsedConfig,
    oomBreaker: oomBreaker ? oomBreaker.getState(sessionId) : null,
    providerRoute,
    nodeRuntime,
    installContentKeyOff: workspaceDir ? installContentKeyDiagnostic(workspaceDir) : null,
  };
}

async function probeNodeRuntime(
  containerManager: SessionContainerManager | null,
  sessionId: string,
): Promise<NodeRuntimeStatus | null> {
  const sc = containerManager?.get(sessionId);
  if (sc?.status !== "running" || !sc.workerUrl) return null;
  try {
    const res = await workerGet(sc.workerUrl, "/node-runtime", {
      timeoutMs: NODE_RUNTIME_PROBE_TIMEOUT_MS,
    });
    return isNodeRuntimeStatus(res) ? res : null;
  } catch {
    return null;
  }
}

// Containers can outlive a deploy and return an older response shape.
function isNodeRuntimeStatus(value: unknown): value is NodeRuntimeStatus {
  const v = value as Partial<NodeRuntimeStatus> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.state === "string" &&
    typeof v.activeVersion === "string" &&
    typeof v.mismatch === "boolean"
  );
}

function readParsedConfig(workspaceDir: string): ParsedShipitConfig {
  // Host-derived sizing remains available even when workspace YAML cannot be parsed.
  const sizing = deriveSessionMemorySizing();
  try {
    const cfg = resolveShipitConfig(workspaceDir);
    return {
      agent: cfg.agent,
      compose: cfg.compose,
      version: cfg.version,
      warnings: cfg.warnings,
      sizing,
    };
  } catch (err) {
    const message = err instanceof ShipitConfigError || err instanceof Error
      ? err.message
      : String(err);
    return {
      agent: { ...AGENT_DEFAULTS, install: [] },
      warnings: [],
      parseError: message,
      sizing,
    };
  }
}

function tailLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return trimmed.slice(-n).join("\n");
}

function readDisposed(runner: SessionRunnerInterface): boolean {
  const r = runner as { disposed?: boolean };
  return r.disposed === true;
}
