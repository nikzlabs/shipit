/**
 * Session diagnostics service — single aggregate view of everything the
 * orchestrator knows about a session, suitable for either an interactive
 * panel or a one-shot bug-report payload.
 *
 * See docs/124-session-rescue-and-diagnostics §3.1 / §3.3.
 *
 * Composes:
 *   - {@link getContainerHealth}      → container/worker/SSE state
 *   - ServiceManager service map      → compose service status + log tails
 *   - SessionRunner state             → running flag, viewer count, queue
 *   - per-session log ring            → last N orchestrator log entries
 *
 * The endpoint is read-only and safe to call repeatedly. Worker probes
 * inherit the short timeout from `getContainerHealth` so a wedged worker
 * can't hang the request.
 */

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

/** Tail of the per-service compose log buffer included in diagnostics. */
const SERVICE_LOG_TAIL_LINES = 20;
/** Budget for the worker's `/node-runtime` probe. It reads a cached value. */
const NODE_RUNTIME_PROBE_TIMEOUT_MS = 2000;
/** Tail of the per-session orchestrator log ring included in diagnostics. */
const RECENT_LOG_LINES = 50;

export interface ServiceDiagnostic {
  name: string;
  status: ManagedService["status"];
  preview: ManagedService["preview"];
  port: number | null;
  containerIp: string | null;
  error: string | null;
  /** Tail of stdout/stderr captured by `docker compose logs -f`. */
  logTail: string;
}

/**
 * docs/150 req 11 — which provider account this session is running on, right
 * now.
 *
 * The chat-visible failover notice covers the *moment* a session changes
 * account. It does not answer "which account is this session on?", which is the
 * question after a proactive cutoff or a hard-exhaustion retry has quietly
 * moved it — and until now nothing in the client read `providerRouteId` at all,
 * so the answer existed only in the database.
 *
 * `label` is always renderable: an account's name, the reserved route's
 * description, or an explanation of why there is neither.
 */
export interface ProviderRouteDiagnostic {
  /** The agent this session is pinned to, or null before its first turn. */
  agentId: AgentId | null;
  kind: ProviderRouteKind | null;
  /** Account id (`acct_…`) or reserved route id. Null before the first turn. */
  routeId: string | null;
  /** What to show the user. Never the opaque id when a name is available. */
  label: string;
}

/**
 * Reserved routes are metered billing or an environment-supplied token, not
 * account rows — so they have no label to look up and need their own copy.
 * Spelled out rather than shown as the raw id because "claude-api-key" in a
 * diagnostics panel does not tell the user they are spending money per token.
 */
const RESERVED_ROUTE_LABEL: Record<string, string> = {
  "claude-env-oauth": "Anthropic OAuth token from the environment",
  "claude-api-key": "Anthropic API key — metered billing",
  "codex-api-key": "OpenAI API key — metered billing",
};

/** Session fields {@link describeProviderRoute} reads. */
export interface ProviderRouteSession {
  agentId?: AgentId | null;
  providerRouteKind?: ProviderRouteKind;
  providerRouteId?: string;
}

/**
 * Resolve a session's stored route into something displayable. Pure, so the
 * three states that matter — pinned account, reserved route, not yet pinned —
 * are testable without a database.
 */
export function describeProviderRoute(
  session: ProviderRouteSession | undefined,
  getAccountLabel: (provider: AgentId, accountId: string) => string | undefined,
): ProviderRouteDiagnostic | null {
  if (!session) return null;
  const agentId = session.agentId ?? null;
  const kind = session.providerRouteKind ?? null;
  const routeId = session.providerRouteId ?? null;

  // docs/260 — no live process means no current route: every turn selects
  // its account fresh, so between turns this is the honest steady state, not
  // an error.
  if (!kind || !routeId) {
    return { agentId, kind: null, routeId: null, label: "selected per turn — the next turn picks an account" };
  }
  if (kind === "reserved") {
    return { agentId, kind, routeId, label: RESERVED_ROUTE_LABEL[routeId] ?? routeId };
  }
  const label = agentId ? getAccountLabel(agentId, routeId) : undefined;
  // The account can be disconnected while the process lives on — worth
  // naming, since it explains a session that is about to change account.
  return { agentId, kind, routeId, label: label ?? "account no longer connected" };
}

export interface RunnerDiagnostic {
  /** Whether the runner thinks an agent is currently running. */
  running: boolean;
  /** Attached browser viewers. */
  viewerCount: number;
  /** Queued messages waiting for the agent to be free. */
  queueLength: number;
  /** Most recent SSE event timestamp (ms epoch). 0 = never. */
  lastSseEventAt: number;
  /** Number of events buffered for reconnecting viewers in the current turn. */
  turnEventBufferSize: number;
  /** Whether the runner has been disposed. */
  disposed: boolean;
}

/**
 * Snapshot of how the orchestrator parsed the session's `shipit.yaml` — the
 * agent block, compose block, schema version, and any warnings (e.g. for
 * legacy keys like `resources:` / `capabilities:`, or the removed
 * `agent.memory` / `agent.cpu` / `agent.pids` resource fields). When the file
 * is malformed, `parseError` carries the message.
 *
 * Surfaced in `SessionDiagnosticsPanel` alongside `sizing` so the operator can
 * see both how the yaml parsed and what memory the session was auto-sized to.
 */
export interface ParsedShipitConfig {
  /** The values as written in shipit.yaml (after parsing). */
  agent: AgentConfig;
  compose?: ComposeConfig;
  version?: number;
  /**
   * Migration warnings from the parser — legacy keys (`resources:`) and the
   * removed `agent.memory` / `agent.cpu` / `agent.pids` resource fields, which
   * are warned-and-ignored now that sizing is automatic (docs/229).
   */
  warnings: string[];
  /** YAML parse error message, if shipit.yaml is malformed. */
  parseError?: string;
  /**
   * The automatic memory sizing the container booted with — host RAM, reserve,
   * usable, the derived per-session ceiling, and any deployment env override
   * (docs/229). Independent of `agent` (the repo no longer sets memory).
   */
  sizing: SessionMemorySizing;
}

export interface SessionDiagnostics {
  sessionId: string;
  /** Server-side ms epoch when this snapshot was assembled. */
  generatedAt: number;
  /**
   * Container/worker/SSE summary. When the container manager isn't
   * configured (test-mode / local runtime) this carries `{ error }` so
   * the panel can render the rest of the diagnostics anyway.
   */
  health: ContainerHealth | { error: string };
  /** One entry per compose-managed service. Empty when no compose stack. */
  services: ServiceDiagnostic[];
  /** Compose stack-level start error, if any. */
  stackStartError: string | null;
  runner: RunnerDiagnostic | null;
  /** Last {@link RECENT_LOG_LINES} orchestrator log entries for this session. */
  recentLogs: LogRingEntry[];
  /**
   * Parsed `shipit.yaml` for this session — `null` when the workspace
   * directory isn't resolvable (e.g. session has no workspaceDir yet).
   */
  parsedConfig: ParsedShipitConfig | null;
  /**
   * OOM circuit breaker state — `null` when no breaker is wired (test
   * mode / local runtime). When tripped, future container creation for
   * this session is refused until the user opts back in via "Rescue
   * session" / agent-container-restart.
   */
  oomBreaker: OomBreakerState | null;
  /**
   * docs/150 req 11 — the provider account this session runs on. `null` when
   * the build has no session/account wiring (test mode).
   */
  providerRoute: ProviderRouteDiagnostic | null;
  /**
   * docs/248 — how the repo's Node version pin was resolved, straight from the
   * worker. This is requirement 6's surface: when the pin can't be honored the
   * discrepancy has to be *visible* rather than silently assumed correct, and
   * this panel is the one place that already aggregates "what is this session
   * actually running". `null` when there's no reachable container worker.
   */
  nodeRuntime: NodeRuntimeStatus | null;
}

export interface DiagnosticsDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  serviceManagers: Map<string, ServiceManager>;
  getLogBuffer: (sessionId: string) => LogRingEntry[];
  /**
   * Returns the on-disk workspace directory for a session, or `null` when
   * the session has no workspace assigned yet. Used to parse and surface
   * the session's `shipit.yaml`.
   */
  getWorkspaceDir: (sessionId: string) => string | null;
  /**
   * Shared OOM circuit breaker. Omitted in test mode / local runtime;
   * when present, its per-session state is included in the payload.
   */
  oomBreaker?: SessionOomCircuitBreaker;
  /**
   * docs/150 req 11 — the session's stored provider route, and a way to turn an
   * account id into the name the user gave it. Two narrow accessors rather than
   * the session manager and account manager themselves, matching how
   * `getWorkspaceDir` is injected here: the service stays free of both.
   *
   * Optional; omitted in test-mode builds, where `providerRoute` is null.
   */
  getSessionRoute?: (sessionId: string) => ProviderRouteSession | undefined;
  getAccountLabel?: (provider: AgentId, accountId: string) => string | undefined;
}

/**
 * Get the full diagnostics payload for a session.
 *
 * Throws ServiceError(404) if the session doesn't exist (caller should
 * have validated, but we double-check via the runner registry).
 */
export async function getSessionDiagnostics(
  deps: DiagnosticsDeps,
  sessionId: string,
): Promise<SessionDiagnostics> {
  const { containerManager, runnerRegistry, serviceManagers, getLogBuffer, getWorkspaceDir, oomBreaker } = deps;

  // Health probe — gracefully degrade when no container manager is
  // configured. The panel still has value for service + runner state.
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

  // docs/260 — the displayed route is the RESIDENT process's (typed runner
  // state), because that is the only thing that has one between selections;
  // an idle session's account is chosen fresh at its next turn.
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
  };
}

/**
 * Ask the worker how it resolved the repo's Node pin (docs/248).
 *
 * Best-effort by construction: the endpoint is read-only, never awaits the
 * provisioning download itself (it reports `pending` instead), and any failure
 * degrades to `null`. Diagnostics must always render — a panel that 500s
 * because one probe timed out is worse than one missing a row.
 */
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

/**
 * Structural check on the worker's reply. The worker is a trusted peer, but a
 * version-skewed one (a container that outlived a deploy — docs/113) may not
 * have the endpoint at all, and the panel should show nothing rather than
 * render `undefined`.
 */
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

/**
 * Read and parse the workspace's `shipit.yaml`. Errors are captured into
 * `parseError` rather than thrown — the diagnostics endpoint should
 * always succeed so the user can actually see why their config is broken.
 */
function readParsedConfig(workspaceDir: string): ParsedShipitConfig {
  // Memory sizing is derived from host capacity, independent of the workspace
  // config, so it's computed the same way whether or not the yaml parses.
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
    // Capture the error message but still return a usable shape — the panel
    // can render `parseError` alongside the auto-derived sizing.
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

/**
 * Return the last `n` lines of `text`. Trailing newline (if any) is
 * preserved on the last line. Empty input → empty string.
 */
function tailLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  // split on a trailing "\n" produces an empty final element — drop it
  // so the count reflects real lines, then re-join with newlines.
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return trimmed.slice(-n).join("\n");
}

/**
 * `disposed` is private on ContainerSessionRunner but exposed via the
 * `disposed` getter. The SessionRunner interface doesn't promise it, so
 * read defensively.
 */
function readDisposed(runner: SessionRunnerInterface): boolean {
  const r = runner as { disposed?: boolean };
  return r.disposed === true;
}
