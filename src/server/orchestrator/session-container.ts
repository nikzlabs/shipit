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
import { type HostMount } from "../shared/shipit-config.js";
import {
  resolveAgentDockerLimits,
  readAgentConfig,
} from "./container-config-builder.js";
import {
  resolveWorkerImageId as resolveWorkerImageIdFn,
  resolveWorkerBaseDigest as resolveWorkerBaseDigestFn,
  prepareOverlaySpecs as prepareOverlaySpecsFn,
  preparePnpmStore as preparePnpmStoreFn,
  type OverlayProvisionerDeps,
} from "./container-overlay-provisioner.js";
import type { DepDirOverlaySpec } from "./overlay-session.js";
import { egressEnforceEnabled, allowEgressToSubnets } from "./egress-firewall-install.js";
import { extractNetworkSubnets } from "./egress-firewall.js";
import { egressDnsEnabled } from "./egress-dns-install.js";
import { egressProxyEnabled } from "./egress-proxy-install.js";
import {
  kernelRuntime,
  resolveSeccompSecurityOpt,
  readonlyRootfsEnabled,
} from "./container-hardening.js";
import { reloadEgressSidecars } from "./egress-reload.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import type { SessionInfo } from "../shared/types.js";

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

// Agent resource-limit resolution (deployment config → Docker units) lives in
// container-config-builder.ts; re-exported here so existing import sites
// (diagnostics, claim-session, app-lifecycle, index) keep their import path.
export {
  resolveAgentDockerLimits,
  readAgentConfig,
  applyEnvCaps,
  type AgentDockerLimits,
  type EffectiveAgentResources,
} from "./container-config-builder.js";

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
  /**
   * docs/197 Part 2 — host path `<stateDir>/pnpm-store/<runtimeKey-hash>`, the
   * shared per-runtime pnpm store. When set, the container bind-mounts it (a
   * subpath of the SAME state volume as `/workspace`, so store→node_modules
   * hardlinks stay within one superblock) and `npm_config_store_dir` points pnpm
   * there. Populated by `preparePnpmStore` ONLY for pnpm repos under the
   * `OVERLAY_DEP_STORE` flag — those repos get this INSTEAD of `overlaySpecs`.
   */
  pnpmStoreDir?: string;
  /** Host path: /workspace/sessions/{uuid}/uploads (uploaded files) */
  uploadsDir?: string;
  /**
   * docs/217 — Host path: /workspace/sessions/{uuid}/scratch. Mounted **rw** at
   * `/persist`: a persistent, non-git, agent-writable scratch tier that survives
   * container teardown (sibling of `workspace/`, like `uploads/`). The agent
   * writes throwaway-but-keep files here (presented artifacts being the motivating
   * case) instead of the ephemeral `/tmp`.
   */
  scratchDir?: string;
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
  /**
   * docs/128 — privileged "ops" session. Gates the read-only journal mounts and
   * the `DOCKER_HOST` → read-only docker-socket-proxy wiring. Derived from the
   * server-authoritative `session.kind === "ops"`, never from workspace files.
   */
  opsSession?: boolean;
  /**
   * docs/128 — allow-listed read-only host mounts (journal paths) parsed from
   * `x-shipit-host-mounts`. Only applied to the container when `opsSession` is
   * true; otherwise dropped at config-build time.
   */
  hostMounts?: HostMount[];
  /**
   * docs/183 dep-dir design — overlay dep store. When set, the orchestrator
   * creates one `local`-driver `type=overlay` volume **per declared dep dir**
   * (lowerdir=shared base, upper/work=this session) and mounts each **nested** at
   * `/workspace/<dep-dir>`; `/workspace` itself stays the normal host-clone mount.
   * The daemon performs each overlay mount as it builds the container. Populated
   * by the eligibility/spec-builder logic (`buildOverlaySpecs`); absent for
   * non-overlay sessions (the byte-for-byte-unchanged path).
   */
  overlaySpecs?: DepDirOverlaySpec[];
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
  /**
   * docs/128 — whether this is an "ops" session (reaches Docker via the read-only
   * `docker-socket-proxy` compose sibling). Recorded so the live egress reload
   * (`reloadEgress`) re-emits the Tier B resolver rule allowlisting that alias.
   */
  opsSession?: boolean;
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
   * The claim-time refresh compares this against `resolveAgentDockerLimits()`
   * for the current deployment settings. If those changed after a standby
   * booted, the standby must be re-provisioned because container memory is
   * immutable at runtime. Absent on rediscovered / re-adopted containers, where
   * the booted limits genuinely aren't known.
   */
  bootedLimits?: { memoryLimit: number; cpuQuota: number; pidsLimit: number };
  /**
   * docs/183 dep-dir design — names of the per-session overlay volumes created
   * for this container (one per declared dep dir), when it is an overlay session.
   * Recorded so `destroyContainer` can `docker volume rm` each on teardown without
   * re-deriving eligibility. Absent for non-overlay sessions.
   */
  overlayVolumeNames?: string[];
  /**
   * docs/172 — the resolved egress containment (`ResolvedEgressConfig.contained`)
   * this container was actually created with. The egress topology is installed
   * into the netns at creation, so this is the source of truth for "what is the
   * live container running"; the egress API compares it against the now-resolved
   * policy to surface a "pending — restart to apply" indicator. Absent on
   * rediscovered/re-adopted containers, where the booted policy isn't known.
   */
  egressContainedAtStart?: boolean;
  /**
   * docs/172 ordering fix — set on a freshly *created* container to a promise
   * that resolves once the Tier-A egress firewall install
   * (`installEgressFirewall`) for this container has completed (and immediately
   * for the non-contained / enforcement-off path). `allowEgressToSessionNetwork`
   * awaits it before appending the per-subnet ACCEPT, so a create-time compose
   * join can't land its rule first only for `init-firewall.sh`'s
   * `iptables -F OUTPUT` to flush it ~1s later — the race that stranded ops
   * agents off their `docker-socket-proxy`. Absent on rediscovered/re-adopted
   * containers (the install already ran with the previous incarnation and the
   * netns firewall persisted with the running container), where the gate is a
   * no-op.
   */
  egressFirewallReady?: Promise<void>;
  /**
   * docs/172 ordering fix — the per-session/compose network names the agent has
   * joined (and to which egress was opened). Recorded so that if the Tier-A
   * firewall is ever re-installed (its rebuild does `iptables -F OUTPUT`) the
   * orchestrator can idempotently re-open egress to each (allow-subnet.sh is
   * `-C` before `-A`), making it structurally impossible for an OUTPUT flush to
   * permanently strand an already-joined subnet.
   */
  joinedSessionNetworks?: Set<string>;
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
  /** Default PID limit. Defaults to 4096. */
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
  /**
   * Orchestrator-visible root of the workspace state volume (the app's
   * `stateDir`, `/workspace` in containerized runtime). Needed by the overlay
   * dep store (docs/183) to create each overlay's lower/upper/work dirs before
   * the daemon mounts them — the spec's own paths are daemon-host paths the
   * orchestrator container cannot reach. Optional: without it, overlay specs
   * carry no `orchDirs` and creation relies on the dirs already existing.
   */
  stateDir?: string;
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
  /**
   * docs/172 (SHI-90) — resolve a session's egress containment + composed
   * extra-host allowlist at container start. Built in `app-di` where the durable
   * `EgressAllowlistStore` + the live MCP `CredentialStore` are in scope, and
   * passed straight through to `LifecycleDeps.resolveEgressConfig`. Omitted in
   * tests / no-store runtimes → containment defaults on, env-only allowlist.
   */
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = process.env.SESSION_WORKER_IMAGE;
const DEFAULT_NETWORK = process.env.DOCKER_NETWORK;
const DEFAULT_MEMORY_LIMIT = 1536 * 1024 * 1024; // 1.5 GB (agent container)
const DEFAULT_CPU_QUOTA = 50_000; // 0.5 CPU (50000 µs per 100ms period)
const DEFAULT_PIDS_LIMIT = 4096;
const DEFAULT_WORKER_PORT = 9100;

export const CONTAINER_LABEL_KEY = "shipit-session";
export const CONTAINER_LABEL_VALUE = "true";
export const CONTAINER_SESSION_ID_LABEL = "shipit-session-id";
export const CONTAINER_STACK_LABEL = "shipit-stack";
export const CONTAINER_STANDBY_LABEL = "shipit-standby";

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
  private stateDir?: string;
  private credentialsVolume?: string;
  private stackName?: string;
  private dockerImageName?: string;
  private dockerProxyHost?: string;
  private dockerProxyPort?: number;
  private resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
  /**
   * docs/183 — cached Docker image ID of the session-worker base image, the
   * ABI fingerprint the overlay dep store keys its rolling base scope on
   * (`overlayRuntimeKey`). Resolved once via `resolveWorkerImageId`; a failed
   * inspect is cached as `""` (a miss) so there is no per-session Docker call.
   */
  private workerImageId?: string;
  /**
   * SHI-194 — cached `BASE_IMAGE_DIGEST` baked into the session-worker image, the
   * ABI fingerprint the overlay scope now keys on instead of `workerImageId`.
   * Resolved once via `resolveWorkerBaseDigest`; a failed inspect / pre-SHI-194
   * image (no baked digest) is cached as `""` (a miss) so there is no per-session
   * Docker call and the scope falls back to the worker-image-id behavior.
   */
  private workerBaseDigest?: string;
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
    this.stateDir = opts.stateDir;
    this.credentialsVolume = opts.credentialsVolume;
    this.stackName = opts.stackName;
    this.dockerImageName = opts.dockerImageName;
    this.dockerProxyHost = opts.dockerProxyHost;
    this.dockerProxyPort = opts.dockerProxyPort;
    this.resolveEgressConfig = opts.resolveEgressConfig;
  }

  /**
   * docs/172 (SHI-90) — apply a newly-added durable allowlist host to a RUNNING,
   * contained session by relaunching the Tier B resolver + Tier C proxy with the
   * regenerated config, so the host resolves (DNS + ipset auto-pin) and its SNI
   * is permitted without waiting for the next container start. Best-effort and
   * fail-safe: a no-op when egress isn't enforced, the session has no running
   * container, or the session is in Open mode. Errors are swallowed by the reload
   * module — the durable add already persisted, so the worst case is "applies on
   * next restart." Returns true if a reload was attempted.
   */
  async reloadEgress(sessionId: string): Promise<boolean> {
    if (!egressEnforceEnabled()) return false;
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    if (!sidecarImage) return false;
    const sc = this.containers.get(sessionId);
    if (sc?.status !== "running" || !sc.id) return false;
    const cfg = this.resolveEgressConfig?.(sessionId) ?? { contained: true, extraHosts: [] };
    if (!cfg.contained) return false;
    const reloadResolver = egressDnsEnabled();
    const reloadProxy = egressProxyEnabled();
    if (!reloadResolver && !reloadProxy) return false;
    await reloadEgressSidecars({
      docker: this.docker,
      agentContainerId: sc.id,
      sessionId,
      sidecarImage,
      opsSession: sc.opsSession ?? false,
      extraHosts: cfg.extraHosts,
      ...(cfg.base ? { base: cfg.base } : {}),
      ...(cfg.identityRules ? { identityRules: cfg.identityRules } : {}),
      baseLabels: this.baseLabels(),
      reloadResolver,
      reloadProxy,
    });
    return true;
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
      // docs/172 Gap 1 (SHI-90) Tier A — egress enforcement, default-off via
      // SESSION_EGRESS_ENFORCE; the installer sidecar image via env.
      egressEnforce: egressEnforceEnabled(),
      egressSidecarImage: process.env.SESSION_EGRESS_SIDECAR_IMAGE,
      egressDns: egressDnsEnabled(),
      egressProxy: egressProxyEnabled(),
      ...(this.resolveEgressConfig ? { resolveEgressConfig: this.resolveEgressConfig } : {}),
      // docs/172 ordering fix — re-open egress to already-joined session networks
      // at the end of the Tier-A install so a future firewall rebuild can't strand
      // them (no-op on first boot; nothing is joined until compose-up runs later).
      reopenJoinedEgress: (sessionId: string) => this.reopenJoinedSessionEgress(sessionId),
      // docs/172 Gap 5 (SHI-97) — kernel-tier hardening, env-gated default-OFF.
      // gVisor via SESSION_RUNTIME; seccomp via SESSION_SECCOMP(_PROFILE);
      // read-only rootfs via SESSION_READONLY_ROOTFS. resolveSeccompSecurityOpt
      // reads + validates the profile (throws fail-closed if enabled but bad).
      kernelRuntime: kernelRuntime(),
      seccompSecurityOpt: resolveSeccompSecurityOpt(),
      readonlyRootfs: readonlyRootfsEnabled(),
      stateDir: this.stateDir,
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

  private overlayDeps(): OverlayProvisionerDeps {
    return {
      docker: this.docker,
      workspaceVolume: this.workspaceVolume,
      stateDir: this.stateDir,
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

    // docs/172 ordering fix — remember this attachment so a later Tier-A firewall
    // re-install (which flushes OUTPUT) can re-open egress to it idempotently
    // (`reopenJoinedSessionEgress`). An already-joined subnet must never be left
    // stranded by a flush.
    (sc.joinedSessionNetworks ??= new Set()).add(networkName);

    // docs/172 Gap 1 (SHI-90) — the agent is now multi-homed: it has an interface
    // on this session/compose network in addition to the orchestrator bridge. The
    // Tier A egress firewall (installed at container creation) default-denies
    // OUTPUT and only allowed the *default-gateway* subnet, so traffic to preview
    // service containers on THIS subnet is dropped — the agent (and its in-netns
    // Playwright browser) can't reach the live preview to verify its work. Re-open
    // egress to this one session subnet via the short-lived allow-subnet sidecar.
    // The agent gains no route to any other network, so cross-session isolation is
    // unchanged. Best-effort: a failure only degrades preview reachability, it
    // never weakens containment, so we log and continue (never fail the join).
    await this.allowEgressToSessionNetwork(sc.id, sessionId, networkName);
  }

  /**
   * Self-heal the agent's attachment to a session/compose network it was
   * stranded off (docs/128 — stranded ops agent after a proxy/network recreate).
   *
   * The agent joins `shipit-session-<id>` imperatively (see
   * {@link connectToNetwork}), and that attachment is normally only re-established
   * on an orchestrator-driven `docker compose up` (ServiceManager.joinSessionNetwork).
   * But the compose network/bridge can be rebuilt out from under the long-lived
   * agent WITHOUT the orchestrator issuing a `compose up`: the ops
   * `docker-socket-proxy` sibling is recreated by its own `restart: unless-stopped`
   * policy, a host/daemon restart recreates the network, or the network is pruned
   * and re-made. When that happens the new service joins the NEW bridge while the
   * agent stays bolted to the OLD, now-empty bridge — same IPAM subnet (compose
   * reuses it per-project), different L2 segment → ARP blackhole + embedded-DNS
   * failure, so `DOCKER_HOST=tcp://docker-socket-proxy:2375` is permanently
   * unreachable for the rest of the session.
   *
   * This is the condition-based heal that closes that gap. Driven by the service
   * poller's heartbeat, it is **membership-gated** so the steady state is a single
   * cheap `network inspect`: if the agent is already a member of the live network
   * it returns immediately (no sidecar churn). Only when the agent is MISSING from
   * the live network does it force-disconnect any dangling endpoint Docker still
   * tracks under that name (so we don't trip {@link connectToNetwork}'s
   * "already exists" swallow) and reconnect — which also re-opens egress to the
   * subnet. Returns true iff it actually re-attached.
   *
   * No-op (returns false) when there's no container record or the network isn't
   * present yet (a later `joinSessionNetwork` creates the attachment). Never
   * throws — a heal failure must never disrupt the poll loop that drives it.
   */
  async ensureConnectedToSessionNetwork(sessionId: string, networkName: string): Promise<boolean> {
    const sc = this.containers.get(sessionId);
    if (!sc?.id) return false;

    let info: Docker.NetworkInspectInfo;
    try {
      info = await this.docker.getNetwork(networkName).inspect();
    } catch {
      // Network not present (not yet created, or torn down) — nothing to heal.
      return false;
    }

    const members = info.Containers ?? {};
    if (Object.prototype.hasOwnProperty.call(members, sc.id)) {
      return false; // Already attached to the live network — cheap no-op.
    }

    // The agent is NOT on the live network: a network/bridge recreate stranded it
    // on the old, now-dead segment. Force-disconnect any endpoint Docker still
    // tracks under this name, then reconnect (+ re-open egress) onto the live bridge.
    console.warn(
      `[network:${sessionId}] agent container not attached to live network ${networkName} ` +
        "(likely a proxy/network recreate) — reconnecting",
    );
    try {
      await this.docker.getNetwork(networkName).disconnect({ Container: sc.id, Force: true });
    } catch {
      // No dangling endpoint to clear — fine.
    }
    try {
      await this.connectToNetwork(sessionId, networkName);
      return true;
    } catch (err) {
      console.warn(
        `[network:${sessionId}] reconnect to ${networkName} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Best-effort: open the agent's default-deny egress to the IPAM subnet(s) of a
   * session/compose network it just joined (docs/172 Gap 1, SHI-90). No-op unless
   * the session is contained, enforcement is enabled, and the sidecar image is
   * configured — i.e. only when there is a firewall to punch a hole in. Swallows
   * all errors (logs a warning): preview reachability is a convenience, not a
   * containment guarantee.
   *
   * Containment is read from `egressContainedAtStart` — the boot-time truth set
   * only on *fresh* container creation. After an orchestrator restart the live
   * container is *rediscovered* (container-discovery.ts) and *reconnected*
   * WITHOUT that field, yet its netns firewall persisted with the still-running
   * container, so the agent is STILL contained. Treating the unknown
   * (`undefined`) value as "not contained" silently skipped the hole-punch on
   * every post-restart compose (re)start — the agent could no longer reach its
   * own preview (curl / Playwright ETIMEDOUT), the residual GH #1509 failure.
   * So when the boot value is unknown we fall back to the resolved policy; an
   * explicit `false` (booted in Open mode — no firewall) stays a hard skip. We
   * derive locally and never write `egressContainedAtStart` back: the egress
   * status API relies on `undefined` meaning "boot policy unknown" to avoid a
   * false "pending · restart to apply" diff (api-routes-egress.ts).
   */
  private async allowEgressToSessionNetwork(
    agentContainerId: string,
    sessionId: string,
    networkName: string,
  ): Promise<void> {
    const sc = this.containers.get(sessionId);
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    if (!egressEnforceEnabled() || !sidecarImage) {
      return; // Enforcement off / no sidecar image → no firewall to re-open.
    }
    const contained =
      sc?.egressContainedAtStart ?? this.resolveEgressConfig?.(sessionId)?.contained ?? true;
    if (!contained) {
      return; // Session is in Open mode → no firewall to punch a hole in.
    }
    if (sc?.egressContainedAtStart === undefined) {
      console.log(
        `[egress:${sessionId}] boot containment unknown (rediscovered container); derived contained=${contained} from resolved policy — re-opening preview egress`,
      );
    }
    // docs/172 ordering fix — the load-bearing guarantee. The Tier-A firewall
    // install (`installEgressFirewall`) rebuilds OUTPUT with `iptables -F OUTPUT`.
    // If a create-time compose join appends its per-subnet ACCEPT *before* that
    // flush lands (~1s later), the rule is wiped and the agent is left default-deny
    // to its own session subnet — the docker-socket-proxy is unreachable (proven on
    // prod by the install log landing after the egress-open log). Awaiting the
    // boot-time readiness promise orders this allow strictly AFTER the flush.
    // Best-effort: a freshly created contained container sets the promise; on a
    // rediscovered/Open/heal path it's absent and this is a no-op. Never block or
    // throw on it (an install failure tears the container down on its own path).
    if (sc?.egressFirewallReady) {
      try {
        await sc.egressFirewallReady;
      } catch {
        /* install failed; the create() catch reaps the container */
      }
    }
    try {
      const info = await this.docker.getNetwork(networkName).inspect();
      const subnets = extractNetworkSubnets(info);
      if (subnets.length === 0) {
        console.warn(`[egress:${sessionId}] no IPAM subnet found for ${networkName}; preview may be unreachable from the agent browser`);
        return;
      }
      const allowed = await allowEgressToSubnets(this.docker, {
        agentContainerId,
        sidecarImage,
        subnets,
        labels: { ...this.baseLabels(), "shipit-parent-session": sessionId },
      });
      console.log(`[egress:${sessionId}] opened agent egress to session subnet(s) ${allowed.join(", ")} (${networkName})`);
    } catch (err) {
      console.warn(
        `[egress:${sessionId}] failed to open egress to ${networkName} (preview may be unreachable from the agent browser):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * docs/172 ordering fix — re-open the agent's egress to every session/compose
   * network it has already joined. Invoked at the end of the Tier-A firewall
   * install (via `LifecycleDeps.reopenJoinedEgress`) so that if the firewall is
   * ever rebuilt (its `iptables -F OUTPUT` would otherwise drop the
   * already-installed per-subnet ACCEPTs) the holes are re-punched. Idempotent
   * (allow-subnet.sh runs `-C` before `-A`) and best-effort — `allowEgressToSessionNetwork`
   * swallows its own errors. A no-op on a fresh boot (nothing joined yet) and on
   * Open-mode / enforcement-off sessions.
   */
  async reopenJoinedSessionEgress(sessionId: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    if (!sc?.id || !sc.joinedSessionNetworks?.size) return;
    for (const networkName of sc.joinedSessionNetworks) {
      await this.allowEgressToSessionNetwork(sc.id, sessionId, networkName);
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

  /**
   * docs/183 — resolve and cache the Docker image ID of the session-worker base
   * image. This is the ABI fingerprint the overlay dep store keys its rolling
   * base scope on (`overlayRuntimeKey`): a worker-image rebuild that bumps Node
   * or glibc changes this id, rotating the scope so an ABI-incompatible base
   * (e.g. one holding a `better-sqlite3` compiled against the old ABI) is never
   * reused. Resolved at runtime — not hardcoded in deploy.sh — so a self-update
   * rotates the scope for free.
   *
   * Cached after the first inspect (incl. a failed inspect, cached as a miss),
   * so it adds no per-session Docker call. Returns `undefined` when the image
   * can't be inspected (Docker unavailable / image absent) — the caller then
   * leaves the scope on the `"unknown"` fallback, which simply means no
   * rotation (the prior behavior), never a wrong reuse. The inspect itself lives
   * in container-overlay-provisioner.ts; this method owns only the cache.
   */
  async resolveWorkerImageId(): Promise<string | undefined> {
    if (this.workerImageId !== undefined) return this.workerImageId || undefined;
    // resolveWorkerImageIdFn caches the miss as "" so we don't re-inspect per session.
    this.workerImageId = await resolveWorkerImageIdFn(this.docker, this.imageName);
    return this.workerImageId || undefined;
  }

  /**
   * SHI-194 — resolve the `BASE_IMAGE_DIGEST` baked into the worker image, the
   * pinned-base ABI fingerprint the overlay scope keys on. Mirrors
   * {@link resolveWorkerImageId}'s caching (incl. caching a miss as `""`) so it
   * adds no per-session Docker call. Returns `undefined` when the image can't be
   * inspected or carries no baked digest (a pre-SHI-194 image) — the caller then
   * leaves the scope on the worker-image-id / `"unknown"` fallback.
   */
  async resolveWorkerBaseDigest(): Promise<string | undefined> {
    if (this.workerBaseDigest !== undefined) return this.workerBaseDigest || undefined;
    this.workerBaseDigest = await resolveWorkerBaseDigestFn(this.docker, this.imageName);
    return this.workerBaseDigest || undefined;
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
   * for repo-scoped capabilities and applies deployment-owned session limits.
   */
  buildConfig(opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir?: string;
    credentialsDir: string;
    depCacheDir?: string;
    /** docs/197 Part 2 — shared per-runtime pnpm store host dir; absent for non-pnpm / flag-off sessions. */
    pnpmStoreDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
    opsSession?: boolean;
    hostMounts?: HostMount[];
    /** docs/183 — one overlay dep store spec per declared dep dir; absent for non-overlay sessions. */
    overlaySpecs?: DepDirOverlaySpec[];
  }): ContainerConfig {
    return buildContainerConfig({
      imageName: this.imageName,
      defaultMemoryLimit: this.defaultMemoryLimit,
      defaultCpuQuota: this.defaultCpuQuota,
      defaultPidsLimit: this.defaultPidsLimit,
    }, opts);
  }

  /**
   * Build a ContainerConfig from a workspace directory. Reads deployment-owned
   * session limits via `resolveAgentDockerLimits` and reads the workspace's
   * shipit.yaml for compose.docker-socket capability.
   *
   * All real container creation flows (runner-factory fresh + standby fallback
   * + warm-pool standby) must go through here so deployment limits and
   * workspace capabilities are propagated consistently.
   */
  buildConfigForWorkspace(opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir: string;
    credentialsDir: string;
    depCacheDir?: string;
    /**
     * docs/197 Part 2 — shared per-runtime pnpm store host dir from
     * `preparePnpmStore`. Present only for pnpm repos under the `OVERLAY_DEP_STORE`
     * flag; mutually exclusive with `overlaySpecs` (a pnpm repo gets the store, not
     * the overlay). Absent for everything else (the byte-for-byte-unchanged path).
     */
    pnpmStoreDir?: string;
    env?: Record<string, string>;
    /**
     * docs/128 — set true only when the session's server-authoritative
     * `kind === "ops"`. Enables the privileged journal mounts + read-only
     * Docker proxy wiring. The caller (runner factory) is the gate; this
     * method then reads the workspace's allow-listed `x-shipit-host-mounts`
     * and applies them. A non-ops session with a forged `x-shipit-host-mounts`
     * passes `opsSession` falsy here, so its mounts are dropped downstream.
     */
    opsSession?: boolean;
    /**
     * docs/211 — explicit Docker-access override for a **sandbox** session. A
     * sandbox starts from an empty `/workspace` with no root `shipit.yaml`, so
     * `resolveAgentDockerLimits` would always read `dockerAccess: false`. The
     * server-authoritative `capabilities.docker` grant is threaded here instead,
     * and takes precedence over the workspace-derived value (which is moot for a
     * sandbox). `false`/`true` both win over the shipit.yaml value via `??`;
     * `undefined` (the non-sandbox path) falls back to the derived limit
     * unchanged. The ops gate downstream (`buildContainerConfig` forces
     * `dockerAccess: false` for ops) is unaffected — a sandbox is never ops.
     */
    dockerAccess?: boolean;
    /**
     * docs/183 dep-dir design — per-dep-dir overlay specs from `prepareOverlaySpecs`.
     * Empty/absent for non-overlay sessions (the byte-for-byte-unchanged path).
     */
    overlaySpecs?: DepDirOverlaySpec[];
  }): ContainerConfig {
    const cfg = readAgentConfig(opts.workspaceDir);
    const limits = resolveAgentDockerLimits(opts.workspaceDir);
    return this.buildConfig({
      sessionId: opts.sessionId,
      sessionDir: opts.sessionDir,
      workspaceDir: opts.workspaceDir,
      credentialsDir: opts.credentialsDir,
      depCacheDir: opts.depCacheDir,
      pnpmStoreDir: opts.pnpmStoreDir,
      env: opts.env,
      memoryLimit: limits.memoryLimit,
      cpuQuota: limits.cpuQuota,
      pidsLimit: limits.pidsLimit,
      // docs/211 — a sandbox's Docker access is the explicit capability grant,
      // not the (always-false) shipit.yaml-derived value.
      dockerAccess: opts.dockerAccess ?? limits.dockerAccess,
      opsSession: opts.opsSession,
      hostMounts: opts.opsSession ? cfg.hostMounts : undefined,
      overlaySpecs: opts.overlaySpecs,
    });
  }

  /**
   * docs/183 dep-dir design — resolve the per-dep-dir overlay specs for a session,
   * or `[]` when the feature is killed off / the session is ineligible / nothing is
   * overlay-worthy. Async because it inspects the workspace state volume for its
   * daemon-host mountpoint. The caller passes the result into
   * `buildConfigForWorkspace({ overlaySpecs })`.
   *
   * Returns `[]` (the byte-for-byte-unchanged path) when:
   *  - the `OVERLAY_DEP_STORE=0`/`false` kill switch is set, the session has no
   *    remote, or it is an ops session (`resolveOverlayScope` → null);
   *  - there is no workspace state volume to anchor the overlay subtrees against
   *    (dev/bind mode); or
   *  - no declared dep dir survives contextual validation (`validDepDirsForOverlay`:
   *    parent exists + git-ignored artifact).
   */
  async prepareOverlaySpecs(opts: {
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
    /**
     * Keep only specs whose overlay volume already exists on the daemon. The
     * compose path passes `true`: it consumes the specs as `external` volume
     * references, and the volumes are created at agent-container-create time —
     * so a container built before the flag was enabled (or whose provisioning
     * failed) has none, and referencing them would fail the whole `compose up`.
     * Creation paths omit this (they are about to create the volumes).
     */
    requireProvisioned?: boolean;
  }): Promise<DepDirOverlaySpec[]> {
    return prepareOverlaySpecsFn(this.overlayDeps(), opts);
  }

  /**
   * docs/197 Part 2 — resolve the shared per-runtime pnpm store host dir for a
   * session, or `undefined` when the store doesn't apply. Returns the dir only
   * when ALL hold:
   *  - the session is overlay-eligible (`resolveOverlayScope` non-null — i.e. the
   *    `OVERLAY_DEP_STORE` kill switch is NOT set, the session is repo-backed and
   *    non-ops). The store rides the same rollout gate as the overlay it replaces,
   *    so the kill-switched path is byte-for-byte unchanged;
   *  - there is a workspace state volume (so the store can be a Subpath of the SAME
   *    superblock as `/workspace` — the hardlink requirement) and a state dir to
   *    anchor it; and
   *  - the workspace is a pnpm repo (`isPnpmRepo`).
   *
   * For a pnpm repo this is populated INSTEAD of `prepareOverlaySpecs` (which
   * returns [] for the same repos) — one mechanism per ecosystem. The dir itself is
   * created lazily at container-create time; this is a pure path computation (no
   * Docker, no fs), safe to call on every creation path.
   */
  preparePnpmStore(opts: {
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  }): string | undefined {
    return preparePnpmStoreFn(this.overlayDeps(), opts);
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
