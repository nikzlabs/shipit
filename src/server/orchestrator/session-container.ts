/**
 * SessionContainerManager — manages Docker containers for session isolation.
 *
 * Each session runs inside a dedicated Docker container with its own network
 * namespace, filesystem mount, and resource limits. The orchestrator (Fastify
 * server on the host) communicates with containers over a Docker bridge network.
 *
 * Containers run the session-worker process (src/server/session/session-worker.ts) which
 * exposes an HTTP + SSE interface on port 9100 inside the container. The
 * orchestrator reaches containers via their bridge IP — no host port mappings needed.
 *
 * Implementation is split across focused modules:
 * - container-lifecycle.ts — create, destroy, cleanup, config building
 * - container-discovery.ts — rediscover, orphan cleanup, IP lookup
 * - container-health.ts   — health monitoring via Docker events
 */

import Docker from "dockerode";
import { EventEmitter } from "node:events";
import {
  createContainer,
  destroyContainer,
  buildContainerConfig,
  cleanupSessionDockerResources,
  type LifecycleDeps,
} from "./container-lifecycle.js";
import {
  rediscoverContainers,
  adoptRunningContainer,
  cleanupOrphanContainers,
  getSessionByContainerIp,
  type DiscoveryDeps,
} from "./container-discovery.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
  createHealthMonitorState,
  type HealthDeps,
  type HealthMonitorState,
} from "./container-health.js";
import { resolveShipitConfig, AGENT_DEFAULTS, type ShipitConfig } from "../shared/shipit-config.js";

// ---------------------------------------------------------------------------
// Re-export sub-module public symbols for backwards compatibility
// ---------------------------------------------------------------------------

export {
  buildMounts,
  buildEnv,
  DEP_CACHE_CONTAINER_PATH,
  waitForWorkerHealth,
  createContainer,
  cleanupSessionDockerResources,
  destroyContainer,
  buildContainerConfig,
  type LifecycleDeps,
} from "./container-lifecycle.js";

export {
  rediscoverContainers,
  adoptRunningContainer,
  cleanupOrphanContainers,
  getSessionByContainerIp,
  type DiscoveryDeps,
} from "./container-discovery.js";

export {
  startHealthMonitor,
  stopHealthMonitor,
  type HealthDeps,
  type HealthMonitorState,
} from "./container-health.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerConfig {
  sessionId: string;
  /** Host path: /workspace/sessions/{uuid} */
  sessionDir: string;
  /** Host path to the git repo directory, mounted as /workspace in the container.
   *  New layout: /workspace/sessions/{uuid}/workspace
   *  Falls back to sessionDir for legacy sessions. */
  workspaceDir?: string;
  /** Host path: /workspace/dep-cache/{hash} (shared dependency cache) */
  depCacheDir?: string;
  /** Host path: /workspace/sessions/{uuid}/uploads (uploaded files) */
  uploadsDir?: string;
  /** Host path: /credentials (Claude CLI auth, GitHub token) */
  credentialsDir: string;
  /** Container image name. */
  imageName: string;
  /** Agent container memory limit in bytes. */
  memoryLimit: number;
  /** Agent CPU quota in microseconds per 100ms period. */
  cpuQuota: number;
  /** Agent maximum number of PIDs. */
  pidsLimit: number;
  /** Environment variables to pass to the container. */
  env?: Record<string, string>;
  /** Additional Docker labels to apply to the container. */
  extraLabels?: Record<string, string>;
  /** Whether this session needs Docker access (Docker CLI + proxy). */
  dockerAccess?: boolean;
}

export interface SessionContainer {
  /** Docker container ID. */
  id: string;
  /** ShipIt session ID. */
  sessionId: string;
  /** Bridge network IP (e.g. 172.18.0.3). */
  containerIp: string;
  /** Worker IPC URL (e.g. http://172.18.0.3:9100). */
  workerUrl: string;
  /** Container lifecycle status. */
  status: "starting" | "running" | "stopping" | "stopped";
  /** Host-side workspace directory for bind mount validation. */
  hostWorkspaceDir: string;
  /** Whether this session has Docker access. */
  dockerAccess: boolean;
  /** Session-specific bridge network name (only set when dockerAccess is true). */
  sessionNetworkName?: string;
  /** Resource limits for child containers created through the proxy. */
  resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
  /**
   * The Docker-units resource limits the *agent* container was actually
   * created with. Always populated by `createContainer`, regardless of
   * `dockerAccess` — unlike `resourceLimits`, which is the child-container
   * budget set only for docker-access sessions.
   *
   * The claim-time refresh compares this against
   * `resolveAgentDockerLimits()` of the now-current workspace: when a
   * warm→claim HEAD jump changed the declared `agent.memory`, the standby
   * container booted with the wrong (stale) limit and must be re-provisioned
   * — container memory is immutable at runtime. Absent on rediscovered /
   * re-adopted containers, where the booted limits genuinely aren't known.
   */
  bootedLimits?: { memoryLimit: number; cpuQuota: number; pidsLimit: number };
}

export interface SessionContainerManagerEvents {
  /** Emitted when a container exits unexpectedly (OOM, crash). */
  container_exited: [sessionId: string, exitCode: number, error?: string];
  /** Emitted when a container is successfully started. */
  container_started: [sessionId: string];
  /** Emitted when a container is destroyed. */
  container_destroyed: [sessionId: string];
  /**
   * Emitted when a Compose-managed (i.e. user) container belonging to a
   * session exits unexpectedly. The Docker event-stream listener used to
   * filter these out (it only watched containers labeled
   * `shipit-session=true`), so service OOM kills surfaced ~5s later as
   * generic "Exited with code 137" via `pollStatus`. With the wider
   * filter this fires immediately and carries the OOM annotation when
   * available, which lets the UI distinguish a crash from an OOM kill.
   * See docs/124-session-rescue-and-diagnostics §1.2.
   */
  service_exited: [sessionId: string, info: {
    serviceName?: string;
    containerId: string;
    exitCode: number;
    oom: boolean;
  }];
  /**
   * Emitted after the Docker event stream successfully reconnects from a
   * down period. `gapMs` is the duration the stream was unavailable —
   * any `die`/`oom` events that fired during this window were lost, so
   * the missing-container reconciler is the only fallback for catching
   * containers that vanished while we weren't listening. The handler
   * writes a breadcrumb to every active session's log ring so the
   * diagnostic snapshot preserves the context.
   */
  health_monitor_resumed: [info: { gapMs: number }];
}

export interface SessionContainerManagerOpts {
  /** Docker socket path. Defaults to /var/run/docker.sock. */
  socketPath?: string;
  /** Docker instance (for testing). Overrides socketPath. */
  docker?: Docker;
  /** Container image name. Read from SESSION_WORKER_IMAGE env var. */
  imageName?: string;
  /** Docker bridge network name. Defaults to "shipit". */
  networkName?: string;
  /** Default agent container memory limit in bytes. Defaults to 1GB. */
  memoryLimit?: number;
  /** Default CPU quota (microseconds per 100ms period). Defaults to 50000 (0.5 CPU). */
  cpuQuota?: number;
  /** Default PID limit. Defaults to 256. */
  pidsLimit?: number;
  /** Worker IPC port inside containers. Defaults to 9100. */
  workerPort?: number;
  /** Skip health check polling after container start (for unit tests with mocked Docker). */
  skipHealthCheck?: boolean;
  /**
   * Docker named volume for workspace data. When set, session containers mount
   * this volume instead of bind-mounting the sessionDir path (which only exists
   * inside the orchestrator container, not on the host). The session subdirectory
   * is passed as WORKSPACE_DIR env var.
   */
  workspaceVolume?: string;
  /** Docker named volume for credentials. */
  credentialsVolume?: string;
  /** Stack name for labelling containers (e.g. "shipit-dev", "shipit-prod"). */
  stackName?: string;
  /** Docker-capable session worker image name. Uses Docker CLI + proxy. */
  dockerImageName?: string;
  /** Docker API proxy host (bridge gateway IP). Required for Docker-enabled sessions. */
  dockerProxyHost?: string;
  /** Docker API proxy port. Required for Docker-enabled sessions. */
  dockerProxyPort?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = process.env.SESSION_WORKER_IMAGE;
const DEFAULT_NETWORK = process.env.DOCKER_NETWORK;
const DEFAULT_MEMORY_LIMIT = 1024 * 1024 * 1024; // 1 GB (agent container)
const DEFAULT_CPU_QUOTA = 50_000; // 0.5 CPU (50000 µs per 100ms period)
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_WORKER_PORT = 9100;

export const CONTAINER_LABEL_KEY = "shipit-session";
export const CONTAINER_LABEL_VALUE = "true";
export const CONTAINER_SESSION_ID_LABEL = "shipit-session-id";
export const CONTAINER_STACK_LABEL = "shipit-stack";
export const CONTAINER_STANDBY_LABEL = "shipit-standby";

// ---------------------------------------------------------------------------
// Agent resource limits — single source of truth for shipit.yaml → Docker
// ---------------------------------------------------------------------------

/** Docker-units limits derived from a workspace's shipit.yaml. */
export interface AgentDockerLimits {
  /** Container memory ceiling in bytes (cgroup memory.max). */
  memoryLimit: number;
  /** CPU quota: microseconds per 100ms period. */
  cpuQuota: number;
  /** Max processes inside the container's pids cgroup. */
  pidsLimit: number;
  /** Whether the agent gets a Docker socket proxy + session network. */
  dockerAccess: boolean;
}

/**
 * Read a workspace's shipit.yaml and map `agent.memory/cpu/pids` and
 * `compose.docker-socket` to canonical Docker-units limits.
 *
 * This is the single place that translates the user's declared resources
 * into Docker units. Every container creation path (fresh, standby fallback,
 * warm-pool standby, rediscover) must derive its limits from here — anything
 * else silently falls back to the manager's compiled-in defaults (1 GiB /
 * 0.5 CPU / 256 pids), under-provisioning containers that declared more.
 *
 * Old-format shipit.yaml (`resources:` / `capabilities:` blocks) is no longer
 * recognised: `resolveShipitConfig` emits warnings for those keys but does
 * not extract values from them, so misconfigured files fall through to
 * defaults. The warnings are surfaced in the diagnostics panel.
 */
export function resolveAgentDockerLimits(workspaceDir: string): AgentDockerLimits {
  const { effective, warnings } = applyEnvCaps(readAgentConfig(workspaceDir));

  // The clamp used to be silent. Surface it in the orchestrator log so a
  // misconfigured MAX_SESSION_MEMORY_MB can't shrink a declared limit
  // without anyone knowing — that's how a 3072-declared session boots at
  // 1024 and then OOMs on `npm install`. We deliberately log here (and not
  // only in the diagnostics endpoint) so journalctl carries the breadcrumb
  // even when nobody opens the panel.
  for (const w of warnings) {
    console.warn(`[shipit-config] ${workspaceDir}: ${w}`);
  }

  return {
    memoryLimit: effective.memory * 1024 * 1024,
    cpuQuota: Math.round(effective.cpu * 100_000),
    pidsLimit: effective.pids,
    dockerAccess: effective.dockerAccess,
  };
}

/**
 * Parse a workspace's shipit.yaml, falling back to AGENT_DEFAULTS when the
 * file is genuinely broken (malformed YAML, unreadable, schema violation).
 *
 * The fallback is deliberate — a broken config shouldn't block the session
 * entirely — but it is NOT silent: a broken shipit.yaml that quietly
 * produces a 1 GiB container is a real footgun (the session then OOMs and
 * nobody can tell why). The catch logs the workspace dir, the fact that
 * defaults are being applied, and the underlying error so journalctl
 * carries the breadcrumb. A genuinely-absent shipit.yaml is the common,
 * legitimate case and does not throw — `resolveShipitConfig` returns
 * defaults for it without hitting this catch.
 */
export function readAgentConfig(workspaceDir: string): ShipitConfig {
  try {
    return resolveShipitConfig(workspaceDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Interpolate AGENT_DEFAULTS rather than hard-coding the numbers so the
    // log line can't drift if the defaults ever change.
    const d = AGENT_DEFAULTS;
    console.error(
      `[shipit-config] Failed to parse shipit.yaml in ${workspaceDir} — ` +
        `falling back to default agent resources ` +
        `(${d.memory} MiB / ${d.cpu} CPU / ${d.pids} pids): ${detail}`,
    );
    return { agent: { ...AGENT_DEFAULTS, install: [] }, warnings: [] };
  }
}

/** What the container actually boots with — declared values after env caps applied. */
export interface EffectiveAgentResources {
  memory: number;
  cpu: number;
  pids: number;
  dockerAccess: boolean;
}

/**
 * Apply deployment-level env caps to a parsed shipit.yaml's agent block.
 * Returns the post-clamp values that the container will actually boot on,
 * plus a list of human-readable warnings for each metric that was capped.
 *
 * Exported so the diagnostics endpoint can surface the same clamp warnings
 * in the UI alongside the orchestrator log line — visibility on both sides.
 */
export function applyEnvCaps(cfg: ShipitConfig): {
  effective: EffectiveAgentResources;
  warnings: string[];
} {
  const caps = getResourceCaps();
  const warnings: string[] = [];

  const memory = Math.min(cfg.agent.memory, caps.memoryMb);
  if (cfg.agent.memory > caps.memoryMb) {
    warnings.push(
      `agent.memory ${cfg.agent.memory} MiB clamped to ${caps.memoryMb} MiB by MAX_SESSION_MEMORY_MB`,
    );
  }

  const cpu = Math.min(cfg.agent.cpu, caps.cpu);
  if (cfg.agent.cpu > caps.cpu) {
    warnings.push(
      `agent.cpu ${cfg.agent.cpu} clamped to ${caps.cpu} by MAX_SESSION_CPU`,
    );
  }

  const pids = Math.min(cfg.agent.pids, caps.pids);
  if (cfg.agent.pids > caps.pids) {
    warnings.push(
      `agent.pids ${cfg.agent.pids} clamped to ${caps.pids} by MAX_SESSION_PIDS`,
    );
  }

  return {
    effective: {
      memory,
      cpu,
      pids,
      dockerAccess: cfg.compose?.dockerSocket ?? false,
    },
    warnings,
  };
}

interface AgentResourceCaps {
  memoryMb: number;
  cpu: number;
  pids: number;
}

/** Deployment-level ceiling on per-session resources, read from env vars at call time. */
function getResourceCaps(): AgentResourceCaps {
  return {
    memoryMb: parseEnvInt("MAX_SESSION_MEMORY_MB", 4096),
    cpu: parseEnvFloat("MAX_SESSION_CPU", 4),
    pids: parseEnvInt("MAX_SESSION_PIDS", 2048),
  };
}

function parseEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseEnvFloat(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseFloat(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// SessionContainerManager
// ---------------------------------------------------------------------------

export class SessionContainerManager extends EventEmitter<SessionContainerManagerEvents> {
  private docker: Docker;
  private containers = new Map<string, SessionContainer>();
  private imageName: string;
  private networkName: string;
  private defaultMemoryLimit: number;
  private defaultCpuQuota: number;
  private defaultPidsLimit: number;
  private workerPort: number;
  private skipHealthCheck: boolean;
  private workspaceVolume?: string;
  private credentialsVolume?: string;
  private stackName?: string;
  private dockerImageName?: string;
  private dockerProxyHost?: string;
  private dockerProxyPort?: number;
  private standbySessionIds = new Set<string>();
  private healthMonitorState: HealthMonitorState = createHealthMonitorState();
  private _disposed = false;
  /**
   * Per-session record of the most recent container creation failure.
   * Surfaced via the container health endpoint so the SessionHealthStrip
   * can display it — without this, async creation errors fired from the
   * runner factory's fire-and-forget block were only logged server-side
   * and the user was stuck on "Restarting…" forever. Cleared on
   * successful create() or destroy().
   */
  private lastCreateErrors = new Map<string, { error: string; at: number }>();

  constructor(opts: SessionContainerManagerOpts = {}) {
    super();
    this.docker = opts.docker ?? new Docker({ socketPath: opts.socketPath ?? "/var/run/docker.sock" });
    const imageName = opts.imageName ?? DEFAULT_IMAGE;
    if (!imageName) throw new Error("SESSION_WORKER_IMAGE env var is required when no imageName option is provided");
    this.imageName = imageName;

    const networkName = opts.networkName ?? DEFAULT_NETWORK;
    if (!networkName) throw new Error("DOCKER_NETWORK env var is required when no networkName option is provided");
    this.networkName = networkName;
    this.defaultMemoryLimit = opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.defaultCpuQuota = opts.cpuQuota ?? DEFAULT_CPU_QUOTA;
    this.defaultPidsLimit = opts.pidsLimit ?? DEFAULT_PIDS_LIMIT;
    this.workerPort = opts.workerPort ?? DEFAULT_WORKER_PORT;
    this.skipHealthCheck = opts.skipHealthCheck ?? false;
    this.workspaceVolume = opts.workspaceVolume;
    this.credentialsVolume = opts.credentialsVolume;
    this.stackName = opts.stackName;
    this.dockerImageName = opts.dockerImageName;
    this.dockerProxyHost = opts.dockerProxyHost;
    this.dockerProxyPort = opts.dockerProxyPort;
  }

  /** Build the base label set for containers and networks. */
  private baseLabels(): Record<string, string> {
    const labels: Record<string, string> = {
      [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
    };
    if (this.stackName) {
      labels[CONTAINER_STACK_LABEL] = this.stackName;
    }
    return labels;
  }

  /** Build the label filter array for listing/querying containers. */
  private labelFilters(): string[] {
    const filters = [`${CONTAINER_LABEL_KEY}=${CONTAINER_LABEL_VALUE}`];
    if (this.stackName) {
      filters.push(`${CONTAINER_STACK_LABEL}=${this.stackName}`);
    }
    return filters;
  }

  // --- Dependency bundles for sub-modules ---

  private lifecycleDeps(): LifecycleDeps {
    return {
      docker: this.docker,
      containers: this.containers,
      standbySessionIds: this.standbySessionIds,
      networkName: this.networkName,
      workerPort: this.workerPort,
      skipHealthCheck: this.skipHealthCheck,
      workspaceVolume: this.workspaceVolume,
      credentialsVolume: this.credentialsVolume,
      imageName: this.imageName,
      defaultMemoryLimit: this.defaultMemoryLimit,
      defaultCpuQuota: this.defaultCpuQuota,
      defaultPidsLimit: this.defaultPidsLimit,
      stackName: this.stackName,
      dockerImageName: this.dockerImageName,
      dockerProxyHost: this.dockerProxyHost,
      dockerProxyPort: this.dockerProxyPort,
      emitter: this,
      baseLabels: () => this.baseLabels(),
    };
  }

  private discoveryDeps(): DiscoveryDeps {
    return {
      docker: this.docker,
      containers: this.containers,
      standbySessionIds: this.standbySessionIds,
      networkName: this.networkName,
      workerPort: this.workerPort,
      labelFilters: () => this.labelFilters(),
    };
  }

  private healthDeps(): HealthDeps {
    return {
      docker: this.docker,
      containers: this.containers,
      standbySessionIds: this.standbySessionIds,
      emitter: this,
      labelFilters: () => this.labelFilters(),
    };
  }

  // --- Docker availability ---

  /** Check if Docker is available by pinging the daemon. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  // --- Network setup ---

  /**
   * Ensure the Docker bridge network exists. Creates it if missing.
   * Should be called once at startup.
   */
  async ensureNetwork(): Promise<void> {
    try {
      const network = this.docker.getNetwork(this.networkName);
      await network.inspect();
    } catch {
      // Network doesn't exist — create it
      await this.docker.createNetwork({
        Name: this.networkName,
        Driver: "bridge",
        Labels: this.baseLabels(),
      });
    }
  }

  /**
   * Connect a session's container to an additional Docker network.
   * Used to join the agent container to the compose service network.
   * Silently succeeds if the container is already on the network.
   */
  getDockerClient(): Docker { return this.docker; }

  async connectToNetwork(sessionId: string, networkName: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    if (!sc?.id) throw new Error(`No container found for session ${sessionId}`);

    const network = this.docker.getNetwork(networkName);
    try {
      await network.connect({ Container: sc.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) throw err;
    }
  }

  // --- Container lifecycle (delegates to container-lifecycle.ts) ---

  /**
   * Create and start a container for the given session.
   * Returns the SessionContainer with its bridge IP and worker URL.
   */
  async create(config: ContainerConfig): Promise<SessionContainer> {
    return createContainer(this.lifecycleDeps(), config);
  }

  /**
   * Stop and remove a container for the given session.
   * Gracefully stops with a 5-second timeout before force-killing.
   * Also cleans up Docker resources (containers, networks, volumes) created
   * by the session through the Docker API proxy.
   */
  async destroy(sessionId: string): Promise<void> {
    this.lastCreateErrors.delete(sessionId);
    return destroyContainer(this.lifecycleDeps(), sessionId);
  }

  /** Stop and remove all session containers. Used for full_reset and shutdown. */
  async destroyAll(): Promise<void> {
    const sessionIds = [...this.containers.keys()];
    await Promise.allSettled(sessionIds.map((id) => this.destroy(id)));
  }

  /**
   * Forcibly reap any compose-child resources still labeled
   * `shipit-parent-session={sid}` even when no session container record
   * exists. Used by Rescue session as defense-in-depth after `destroy()`,
   * so a fresh runner never inherits orphans from a prior incarnation.
   */
  async reapOrphans(sessionId: string): Promise<void> {
    await cleanupSessionDockerResources(this.docker, sessionId);
  }

  /** Get the container info for a session. */
  get(sessionId: string): SessionContainer | undefined {
    return this.containers.get(sessionId);
  }

  /** Get all active containers. */
  getAll(): SessionContainer[] {
    return [...this.containers.values()];
  }

  /** Number of active containers. */
  get size(): number {
    return this.containers.size;
  }

  /**
   * Record the most recent container creation failure for a session. Used by
   * the runner factory's fire-and-forget async block to surface errors that
   * would otherwise be invisible to the client. Capped TTL is enforced by the
   * client via the `at` timestamp — the server keeps the latest error until
   * the next successful create/destroy.
   */
  recordCreateError(sessionId: string, error: string): void {
    this.lastCreateErrors.set(sessionId, { error, at: Date.now() });
  }

  /** Read the most recent create error for a session, or undefined. */
  getLastCreateError(sessionId: string): { error: string; at: number } | undefined {
    return this.lastCreateErrors.get(sessionId);
  }

  /** Clear the create error for a session — call on successful create/destroy. */
  clearCreateError(sessionId: string): void {
    this.lastCreateErrors.delete(sessionId);
  }

  /**
   * Configure Docker proxy settings (called after the proxy starts).
   * Enables Docker-capable sessions to set DOCKER_HOST env var.
   */
  setDockerProxy(host: string, port: number, dockerImageName?: string): void {
    this.dockerProxyHost = host;
    this.dockerProxyPort = port;
    if (dockerImageName) {
      this.dockerImageName = dockerImageName;
    }
  }

  /**
   * Look up a session by its container's bridge IP address.
   * Used by the Docker API proxy for source-IP routing.
   */
  getSessionByContainerIp(ip: string): SessionContainer | undefined {
    return getSessionByContainerIp(this.containers, ip);
  }

  // --- Standby container support ---

  /**
   * Create a standby container for a warm session. Identical to `create()` but
   * labels the container with `shipit-standby=true` and tracks it as standby.
   */
  async createStandby(config: ContainerConfig): Promise<SessionContainer> {
    const sc = await this.create({
      ...config,
      extraLabels: { ...config.extraLabels, [CONTAINER_STANDBY_LABEL]: "true" },
    });
    this.standbySessionIds.add(config.sessionId);
    return sc;
  }

  /** Check whether a session's container is a standby (not yet claimed by a user). */
  isStandby(sessionId: string): boolean {
    return this.standbySessionIds.has(sessionId);
  }

  /**
   * Claim a standby container — removes the standby flag and returns the
   * container so the runner factory can reuse it instead of creating a new one.
   */
  claimStandby(sessionId: string): SessionContainer | undefined {
    if (!this.standbySessionIds.has(sessionId)) return undefined;
    this.standbySessionIds.delete(sessionId);
    return this.containers.get(sessionId);
  }

  /** Number of standby containers currently tracked. */
  get standbyCount(): number {
    return this.standbySessionIds.size;
  }

  // --- Orphan cleanup (delegates to container-discovery.ts) ---

  /**
   * Remove containers left over from a previous orchestrator run.
   * Scans for containers with the shipit-session label that don't match
   * any currently tracked session.
   */
  async cleanupOrphans(activeSessionIds: Set<string>): Promise<number> {
    return cleanupOrphanContainers(this.discoveryDeps(), activeSessionIds);
  }

  /**
   * Rediscover running containers from a previous orchestrator run.
   * After restart, the in-memory containers map is empty even though Docker
   * containers keep running. This method queries Docker for containers with
   * the shipit-session label, and for each running container whose session ID
   * is in the active set, populates the map so the runner factory can
   * reconnect to them instead of creating duplicates.
   */
  async rediscover(
    activeSessionIds: Set<string>,
    sessionInfoResolver?: (sessionId: string) => {
      workspaceDir: string;
      dockerAccess: boolean;
      resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
    } | undefined,
  ): Promise<number> {
    return rediscoverContainers(this.discoveryDeps(), activeSessionIds, sessionInfoResolver);
  }

  /**
   * Re-adopt a single running container that has no manager-map entry.
   * The durable backstop for the inverse leak — a live Docker container
   * orphaned because a `die`/`oom` event deleted a healthy container's
   * entry. Called from the missing-container reconciler before it
   * force-disposes a runner. Returns `true` when a container was adopted.
   */
  async adoptRunningContainer(
    sessionId: string,
    sessionInfoResolver?: (sessionId: string) => {
      workspaceDir: string;
      dockerAccess: boolean;
      resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
    } | undefined,
  ): Promise<boolean> {
    return adoptRunningContainer(this.discoveryDeps(), sessionId, sessionInfoResolver);
  }

  // --- Health monitoring (delegates to container-health.ts) ---

  /**
   * Start listening for Docker events to detect container crashes (OOM, exit).
   * Emits "container_exited" when a session container dies unexpectedly.
   */
  async startHealthMonitor(): Promise<void> {
    return startHealthMonitor(this.healthDeps(), this.healthMonitorState);
  }

  /** Stop the Docker event stream. */
  stopHealthMonitor(): void {
    stopHealthMonitor(this.healthMonitorState);
  }

  // --- Build container config ---

  /**
   * Build a ContainerConfig with defaults applied. Low-level convenience for
   * callers that already know the limits they want. Most callers should use
   * `buildConfigForWorkspace` instead — it reads the workspace's shipit.yaml
   * and applies the declared `agent.memory/cpu/pids` and `capabilities.docker`,
   * which is the only way to honor the user's resource declarations.
   */
  buildConfig(opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir?: string;
    credentialsDir: string;
    depCacheDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
  }): ContainerConfig {
    return buildContainerConfig({
      imageName: this.imageName,
      defaultMemoryLimit: this.defaultMemoryLimit,
      defaultCpuQuota: this.defaultCpuQuota,
      defaultPidsLimit: this.defaultPidsLimit,
    }, opts);
  }

  /**
   * Build a ContainerConfig from a workspace directory. Reads the workspace's
   * shipit.yaml via `resolveAgentDockerLimits` and applies the declared agent
   * resources (memory/cpu/pids) and compose.docker-socket capability —
   * this is the only container-creation entry point that honors
   * user-declared limits.
   *
   * All real container creation flows (runner-factory fresh + standby
   * fallback + warm-pool standby) must go through here so user-declared
   * resources are propagated consistently. See `resolveAgentDockerLimits`
   * for the underlying shipit.yaml → Docker-units translation.
   */
  buildConfigForWorkspace(opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir: string;
    credentialsDir: string;
    depCacheDir?: string;
    env?: Record<string, string>;
  }): ContainerConfig {
    const limits = resolveAgentDockerLimits(opts.workspaceDir);
    return this.buildConfig({
      sessionId: opts.sessionId,
      sessionDir: opts.sessionDir,
      workspaceDir: opts.workspaceDir,
      credentialsDir: opts.credentialsDir,
      depCacheDir: opts.depCacheDir,
      env: opts.env,
      memoryLimit: limits.memoryLimit,
      cpuQuota: limits.cpuQuota,
      pidsLimit: limits.pidsLimit,
      dockerAccess: limits.dockerAccess,
    });
  }

  // --- Dispose ---

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this.stopHealthMonitor();
    await this.destroyAll();
    this.removeAllListeners();
  }
}
