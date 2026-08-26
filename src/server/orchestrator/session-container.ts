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

import type Docker from "dockerode";
import { createDockerClient } from "./docker-client.js";
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
  isTrackedContainerRunning,
  cleanupOrphanContainers,
  reapStandbyContainers,
  getSessionByContainerIp,
  type DiscoveryDeps,
} from "./container-discovery.js";
import { reapSessionEgressSidecars } from "./egress-orphan-reaper.js";
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
  resolveWorkerNodeVersion as resolveWorkerNodeVersionFn,
  prepareOverlaySpecs as prepareOverlaySpecsFn,
  resolveSiblingOverlayDepDirs as resolveSiblingOverlayDepDirsFn,
  preparePnpmStore as preparePnpmStoreFn,
  type OverlayProvisionerDeps,
} from "./container-overlay-provisioner.js";
import type { DepDirOverlaySpec } from "./overlay-session.js";
import { egressEnforceEnabled, allowEgressToSubnets } from "./egress-firewall-install.js";
import { extractNetworkSubnets } from "./egress-firewall.js";
import {
  containComposeServices as applyComposeServiceEgress,
  invalidateComposeServiceContainment,
} from "./compose-service-egress.js";
import { egressDnsEnabled, orchestratorCallbackHost } from "./egress-dns-install.js";
import { egressProxyEnabled } from "./egress-proxy-install.js";
import {
  kernelRuntime,
  resolveSeccompSecurityOpt,
  readonlyRootfsEnabled,
} from "./container-hardening.js";
import { reloadEgressSidecars } from "./egress-reload.js";
import { listEgressAllowedHosts } from "./egress-policy.js";
import type { PluginEgressPolicy } from "./plugin-egress.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import type { SessionCapabilities, SessionInfo } from "../shared/types.js";

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
  isTrackedContainerRunning,
  cleanupOrphanContainers,
  reapStandbyContainers,
  getSessionByContainerIp,
  type DiscoveryDeps,
} from "./container-discovery.js";

export {
  startHealthMonitor,
  stopHealthMonitor,
  type HealthDeps,
  type HealthMonitorState,
} from "./container-health.js";

// Agent resource-limit resolution (shipit.yaml → Docker units) lives in
// container-config-builder.ts; re-exported here so existing import sites
// (diagnostics, claim-session, app-lifecycle, index) keep their import path.
export {
  resolveAgentDockerLimits,
  readAgentConfig,
  deriveSessionMemorySizing,
  type AgentDockerLimits,
  type SessionMemorySizing,
} from "./container-config-builder.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerConfig {
  sessionId: string;
  /** Host path: /workspace/sessions/{uuid} */
  sessionDir: string;
  /** Host path to the git repo directory, mounted as /workspace in the container:
   *  /workspace/sessions/{uuid}/workspace. Always a `workspace/` child of the
   *  session dir — the pre-`workspace/` flat layout, where the clone WAS the
   *  session dir, was removed in planning#288. */
  workspaceDir: string;
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
  /**
   * docs/246 — Host path: /workspace/sessions/{uuid}/state. Mounted **rw** at
   * `/session-state`: ShipIt's OWN per-session artifacts (the install marker,
   * fetched CI logs, the compose override, the agent env file), kept out of the
   * user's git clone so the post-turn `git add -A` can never stage them into
   * their repository. Another sibling of `workspace/`, like `scratch/`.
   *
   * Always present: `buildContainerConfig` derives it from the clone path and
   * refuses a session whose clone isn't `<sessionDir>/workspace` (planning#288), so
   * neither the mount nor the worker's `SHIPIT_SESSION_STATE_DIR` has a
   * "no state dir" case to fall back from.
   */
  sessionStateDir: string;
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
  /**
   * planning#313 — the per-session token this container's worker requires on
   * orchestrator→worker calls (injected as `SHIPIT_WORKER_TOKEN` at create,
   * re-read from the container env on adoption). Absent for a container created
   * before the mechanism existed, in which case its worker gates only the
   * loopback-only routes. Registered by base URL in `worker-auth.ts`, which is
   * where the transports read it — this field is the record, not the lookup.
   */
  workerToken?: string;
  /** Container lifecycle status. */
  status: "starting" | "running" | "stopping" | "stopped";
  /** Immutable build ID baked into the worker image, when labeled (docs/242). */
  workerBuildId?: string;
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
   * Surfaced in diagnostics next to the live `deriveSessionMemorySizing()`
   * value: the booted limit is frozen at create, so if host RAM or a
   * `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` override changed
   * after this container booted, the two diverge and the panel flags it.
   * (Since sizing is host-derived (docs/229), a shipit.yaml / HEAD change can
   * no longer cause that drift — there is no claim-time reprovision.) Absent
   * on rediscovered / re-adopted containers, where the booted limits aren't known.
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
   * nikzlabs/shipit#2426 — the (dep dir → overlay volume) pairs this container was
   * actually created with, the authoritative answer to "what does the agent have
   * mounted". The compose path needs BOTH halves: the volume to reference and the
   * dep dir that decides where to nest it under a service's workspace mount.
   *
   * Recorded rather than re-derived. Re-deriving reads the LIVE workspace
   * (`shipit.yaml`'s `dep-dirs`, the pnpm signals, `git check-ignore`), all of
   * which the agent can change mid-session — and a disagreement there silently
   * produced zero compose mounts while the agent kept its overlay, giving the two
   * containers independent dependency trees.
   *
   * A container the orchestrator did NOT create (rediscovered after a restart,
   * or re-adopted by the inverse-leak reconciler) has no `overlaySpecs` to record,
   * so `container-discovery.ts` reads the same pairs back off the container's own
   * `docker inspect` mount table (`overlayDepDirsFromMounts`) — still the
   * container, still not a re-derivation. Absent only where no record is built at
   * all, which {@link SessionContainerManager.provisionedOverlayDepDirs} reports
   * as the `null` "cannot say".
   */
  overlayDepDirs?: { depDir: string; volumeName: string }[];
  /**
   * The ops finding of 2026-08-19 — set when creating this container had to remove
   * Compose siblings that were holding an overlay volume whose base generation had
   * rotated, so the volume could be recreated over the new generation.
   *
   * The compose path decides whether to reconcile by asking whether the dep-dir SET
   * changed, and a rotation does not change it (the volume name is keyed on session
   * + dep dir, never on the generation). But the containers are now gone, and a
   * service container freezes its mounts at create time, so a reconcile is the only
   * thing that can bring them back over the new generation. Consumed once by
   * {@link SessionContainerManager.consumeOverlayVolumesRecreated}.
   */
  overlayVolumesRecreated?: boolean;
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
   * docs/279 — the sandbox {@link SessionCapabilities} this container was
   * actually created with, for the same "pending — restart to apply" diff
   * {@link egressContainedAtStart} serves and under the same convention: absent
   * means UNKNOWN (a non-sandbox session, or a rediscovered/re-adopted container
   * whose boot-time grants aren't knowable), and unknown reports no pending diff.
   *
   * It cannot be folded into `egressContainedAtStart`, which is the obvious-looking
   * shortcut: a network-OFF sandbox and a network-ON one both resolve to
   * `contained: true`, so that flag reads identically across the one change it
   * would be asked about, while the base allowlist the container is running
   * differs completely.
   */
  capabilitiesAtStart?: SessionCapabilities;
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
   * docs/172 (planning#92) — resolve a session's egress containment + composed
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
/**
 * Image label (not set by the orchestrator) stamped by
 * Dockerfile.session-worker.prod with the git SHA the worker image was built
 * from. Containers inherit image labels, so adoption after an orchestrator
 * redeploy can log which build a grandfathered worker is running (docs/113).
 */
export const CONTAINER_BUILD_ID_LABEL = "shipit-build-id";

// ---------------------------------------------------------------------------
// SessionContainerManager
// ---------------------------------------------------------------------------

export class SessionContainerManager extends EventEmitter<SessionContainerManagerEvents> {
  private docker: Docker;
  private containers = new Map<string, SessionContainer>();
  /** Serialize service containment per session; concurrent Compose starts can overlap. */
  private composeEgressRuns = new Map<string, Promise<void>>();
  private composeServiceNames = new Map<string, string[]>();
  private containerOriginSessions = new Map<string, string>();
  private containerOriginNegative = new Map<string, number>();
  private containerOriginRefresh?: Promise<void>;
  private containerOriginRefreshStartedAt = 0;
  private containerOriginRefreshedAt = 0;
  private containerOriginRefreshBackoffUntil = 0;
  private containerOriginRefreshFailed = false;
  private sessionNetworkRanges = new Map<string, { subnet: string; gateway?: string }[]>();
  private sessionNetworkRangeRefresh?: Promise<void>;
  private sessionNetworkRangeRefreshBackoffUntil = 0;
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
   * planning#196 — cached `BASE_IMAGE_DIGEST` baked into the session-worker image, the
   * ABI fingerprint the overlay scope now keys on instead of `workerImageId`.
   * Resolved once via `resolveWorkerBaseDigest`; a failed inspect / pre-planning#196
   * image (no baked digest) is cached as `""` (a miss) so there is no per-session
   * Docker call and the scope falls back to the worker-image-id behavior.
   */
  private workerBaseDigest?: string;
  /**
   * docs/248 — cached `NODE_VERSION` from the session-worker image. The overlay
   * scope compares it against the repo's Node pin to decide whether that pin
   * actually changes the runtime. Cached as `""` on a miss, same as above.
   */
  private workerNodeVersion?: string;
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
    this.docker = opts.docker ?? createDockerClient({ socketPath: opts.socketPath ?? "/var/run/docker.sock" });
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
   * The manager's configured Docker client (honours the `socketPath` option),
   * exposed so boot-time sweeps that live OUTSIDE the manager — the disk
   * janitor's orphan egress-sidecar reap (planning#224) — talk to the same daemon
   * rather than constructing a default-socket client of their own.
   */
  get dockerClient(): Docker {
    return this.docker;
  }

  /**
   * nikzlabs/shipit#2426 — the (dep dir → overlay volume) pairs this session's
   * agent container was created with, or `null` when nothing is known about it
   * (no live container record at all — a session whose container has gone away,
   * or a runtime that creates none).
   *
   * `[]` and `null` are deliberately different answers: `[]` means the container
   * genuinely has no overlay, so a compose service that mounts the dep dir path
   * plainly agrees with it, while `null` means we cannot say. The compose path
   * treats only `null` as a reason to look further.
   */
  provisionedOverlayDepDirs(sessionId: string): { depDir: string; volumeName: string }[] | null {
    const sc = this.containers.get(sessionId);
    if (!sc) return null;
    return sc.overlayDepDirs ?? [];
  }

  /**
   * Whether creating this session's current agent container had to remove Compose
   * siblings so a rotated overlay volume could be recreated — see
   * {@link SessionContainer.overlayVolumesRecreated}. Read-and-clear: the answer
   * is "does the stack owe itself a reconcile", and one reconcile settles it.
   */
  consumeOverlayVolumesRecreated(sessionId: string): boolean {
    const sc = this.containers.get(sessionId);
    if (!sc?.overlayVolumesRecreated) return false;
    sc.overlayVolumesRecreated = false;
    return true;
  }

  /**
   * docs/279 — record the sandbox capability set a freshly-created container was
   * plumbed with. Called by `createContainerForRunner` (`app-lifecycle.ts`) at
   * the point it derives the container's Docker access from that same set, which
   * is where the grant becomes container plumbing.
   *
   * A setter rather than a `ContainerConfig` field: `dockerAccess` is the only
   * part of the set the config layer acts on, and threading the whole set through
   * `buildConfigForWorkspace` → `buildConfig` → `ContainerConfig` would put a
   * sandbox-only concept into the shared type every container-creation path
   * builds, for a value nothing downstream of it reads.
   *
   * No-op when the container record is gone (creation raced a teardown): the
   * unrecorded set reads as "unknown", which reports no pending diff — the same
   * safe direction a rediscovered container lands in.
   */
  recordCapabilitiesAtStart(sessionId: string, capabilities: SessionCapabilities): void {
    const sc = this.containers.get(sessionId);
    if (sc) sc.capabilitiesAtStart = capabilities;
  }

  /**
   * docs/279 — the capability set this session's RUNNING container was created
   * with, or `null` when that isn't knowable (no running container, or one
   * rediscovered after an orchestrator restart). The other side of
   * `capabilitiesPendingRestart`'s diff; mirrors the egress API's `liveContained`.
   */
  capabilitiesAtStart(sessionId: string): SessionCapabilities | null {
    const sc = this.containers.get(sessionId);
    if (sc?.status !== "running") return null;
    return sc.capabilitiesAtStart ?? null;
  }

  /** Boot-effective containment used when generating the Compose override. */
  isEgressContained(sessionId: string): boolean {
    if (!egressEnforceEnabled()) return false;
    const sc = this.containers.get(sessionId);
    return sc?.egressContainedAtStart ?? this.resolveEgressConfig?.(sessionId)?.contained ?? true;
  }

  /**
   * The session's resolved egress config — the very inputs a contained
   * session's resolver and SNI proxy are launched with (base allowlist minus
   * removed defaults, plus operator/MCP/durable extras; or the docs/211
   * lifeline set for a Network-off sandbox).
   *
   * Exposed so a READER can answer "can this session reach host X?" from the
   * same seam that configures the enforcement, rather than re-deriving the
   * composition from the store and drifting from it. docs/262 req 24's Plugins
   * card is the first such reader: re-deriving it would, among other things,
   * have reported a Network-off sandbox against the full default base, which is
   * not the base that session runs on. Answers `undefined` when no resolver is
   * wired (test runtimes).
   */
  resolveEgress(sessionId: string): ResolvedEgressConfig | undefined {
    return this.resolveEgressConfig?.(sessionId);
  }

  /**
   * docs/262 req 24 — the same posture, shaped for the two plugin containers
   * that run outside Compose (`plugin-egress.ts`).
   *
   * It composes the answers above rather than adding a second source: the
   * containment verdict, the resolved config the session's own resolver and
   * proxy were launched with, the tier flags, the sidecar image, and this
   * manager's labels. The one thing it adds is the session's in-memory
   * allow-once hosts — a plugin container's SNI proxy is on a network denied
   * ShipIt's whole API, so it cannot ask the decision endpoint and the answer
   * has to travel with it. That set plus the config's entries is exactly what
   * `egressHostReach` reports on the Plugins card, so enforcement and the
   * card cannot disagree.
   */
  pluginEgressPolicy(sessionId: string): PluginEgressPolicy {
    const contained = this.isEgressContained(sessionId);
    const config = this.resolveEgressConfig?.(sessionId);
    return {
      contained,
      config,
      // A session that admits no user hosts admits no live decision either
      // (docs/211's tighten-only `network` capability, planning#380). Its own
      // decision route refuses to card, so this set is empty in practice — kept
      // explicit so a plugin container cannot become the one surface that widens
      // a sealed sandbox.
      allowOnceHosts: contained && !config?.userHostsExcluded ? listEgressAllowedHosts(sessionId) : [],
      sidecarImage: process.env.SESSION_EGRESS_SIDECAR_IMAGE,
      dnsEnabled: this.isEgressDnsContained(sessionId),
      proxyEnabled: this.isEgressProxyContained(sessionId),
    };
  }

  isEgressDnsContained(sessionId: string): boolean {
    return this.isEgressContained(sessionId) && egressDnsEnabled();
  }

  isEgressProxyContained(sessionId: string): boolean {
    return this.isEgressContained(sessionId) && egressProxyEnabled();
  }

  /** Remove the old session bridge before an Open/Contained policy transition. */
  async resetSessionNetwork(sessionId: string): Promise<void> {
    const network = this.docker.getNetwork(`shipit-session-${sessionId}`);
    let info: Docker.NetworkInspectInfo;
    try { info = await network.inspect(); } catch { return; }
    for (const containerId of Object.keys(info.Containers ?? {})) {
      try { await network.disconnect({ Container: containerId, Force: true }); } catch { /* already detached */ }
    }
    try { await network.remove(); } catch (error) {
      const code = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
      if (code !== 404) throw error;
    }
  }

  /** Recreate a stale Open/Contained bridge before Compose can reuse it. */
  async ensureSessionNetworkMode(sessionId: string, internal: boolean): Promise<void> {
    const network = this.docker.getNetwork(`shipit-session-${sessionId}`);
    let info: Docker.NetworkInspectInfo;
    try { info = await network.inspect(); } catch { return; }
    if ((info.Internal ?? false) === internal) return;
    await this.resetSessionNetwork(sessionId);
  }

  /** Remove the NAT endpoint from stopped services before Compose starts them. */
  async prepareComposeServiceStart(sessionId: string, _serviceNames: string[]): Promise<void> {
    if (!this.isEgressContained(sessionId)) return;
    try {
      const networkInfo = await this.docker.getNetwork(`shipit-session-${sessionId}`).inspect();
      this.sessionNetworkRanges.set(sessionId, (networkInfo.IPAM?.Config ?? [])
        .filter((entry): entry is { Subnet: string; Gateway?: string } => Boolean(entry.Subnet))
        .map((entry) => ({ subnet: entry.Subnet, ...(entry.Gateway ? { gateway: entry.Gateway } : {}) })));
    } catch { /* containment later verifies the network and fails closed */ }
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`shipit-parent-session=${sessionId}`] },
    });
    const network = this.docker.getNetwork(`shipit-egress-${sessionId}`);
    for (const entry of containers) {
      const serviceName = entry.Labels?.["shipit-service-name"];
      if (!serviceName || entry.State === "running" || entry.State === "paused") continue;
      invalidateComposeServiceContainment(sessionId, entry.Id);
      try {
        await network.disconnect({ Container: entry.Id, Force: true });
      } catch (error) {
        const code = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
        const message = error instanceof Error ? error.message : String(error);
        if (code !== 404 && !/not connected|no such network|not found/i.test(message)) throw error;
      }
    }
  }

  /**
   * Apply the owning session's effective egress policy to its running Compose
   * services. Called after every Compose `up`, because that command can replace
   * containers while preserving service names.
   */
  async containComposeServices(sessionId: string, serviceNames: string[], refresh = false): Promise<void> {
    if (!egressEnforceEnabled()) return;
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    const sc = this.containers.get(sessionId);
    const config = this.resolveEgressConfig?.(sessionId) ?? { contained: true, extraHosts: [] };
    const contained = sc?.egressContainedAtStart ?? config.contained;
    if (!contained) return;
    if (serviceNames.length > 0) this.composeServiceNames.set(sessionId, [...serviceNames]);
    if (!sidecarImage) {
      throw new Error(
        "Compose egress containment is on but SESSION_EGRESS_SIDECAR_IMAGE is not set",
      );
    }
    const prior = this.composeEgressRuns.get(sessionId) ?? Promise.resolve();
    const run = (async () => {
      try { await prior; } catch { /* a failed predecessor must not poison the queue */ }
      await applyComposeServiceEgress({
        docker: this.docker,
        sessionId,
        sidecarImage,
        config: { ...config, contained },
        serviceNames,
        dnsEnabled: egressDnsEnabled(),
        proxyEnabled: egressProxyEnabled(),
        labels: this.baseLabels(),
        orchestratorHost: orchestratorCallbackHost(),
        refresh,
      });
    })();
    this.composeEgressRuns.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.composeEgressRuns.get(sessionId) === run) this.composeEgressRuns.delete(sessionId);
    }
  }

  /**
   * docs/262 — the session-worker image, exposed so the plugin install runner
   * can borrow its toolchain (node, npm, git) for a throwaway container. It
   * bypasses the image's entrypoint and mounts none of a session's paths, so
   * this is a toolchain reference, not a session container.
   */
  get workerImageName(): string {
    return this.imageName;
  }

  /**
   * The workspace state volume's name, or `undefined` in dev/dogfood, where the
   * state dir is a bind mount. Exposed for the same reason as the image: the
   * plugin overlay volume's paths must be translated onto the DAEMON's view of
   * this volume, and only the manager knows which volume that is.
   */
  get workspaceVolumeName(): string | undefined {
    return this.workspaceVolume;
  }

  /**
   * docs/172 (planning#92) — apply a newly-added durable allowlist host to a RUNNING,
   * contained session by relaunching the Tier B resolver + Tier C proxy with the
   * regenerated config, so the host resolves (DNS + ipset auto-pin) and its SNI
   * is permitted without waiting for the next container start. Best-effort and
   * A no-op when egress isn't enforced, the session has no running container, or
   * the session is in Open mode.
   *
   * **It throws on failure, and the failure is not benign.** This said "errors
   * are swallowed by the reload module — the worst case is applies on next
   * restart", and neither half is true: `reloadEgressSidecars` propagates, and it
   * REMOVES the old resolver/proxy before launching the replacement, so a failed
   * launch leaves the agent with no DNS or no SNI proxy rather than with a stale
   * allowlist. Both callers catch — the route answers 503 and says the refresh
   * failed closed, the WS handler logs — which is what makes it survivable, not
   * anything this method does.
   *
   * **Returns whether the AGENT's sidecars were relaunched** — the claim its one
   * reporting caller makes (`computeEgressGrantOutcome`'s `reloaded`). It used to
   * return `true` on the path where the container is not running and only the
   * Compose services were refreshed (planning#380): that answer happened to be
   * unused, because the grant outcome short-circuits on `startedContained ===
   * null` first, but the next caller would have believed the docstring. The
   * service refresh below is NOT part of this answer: it runs on every reaching
   * path and reports failure by throwing, so folding it in would only blur which
   * surface got the new list.
   */
  async reloadEgress(sessionId: string): Promise<boolean> {
    if (!egressEnforceEnabled()) return false;
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    if (!sidecarImage) return false;
    const sc = this.containers.get(sessionId);
    const cfg = this.resolveEgressConfig?.(sessionId) ?? { contained: true, extraHosts: [] };
    if (!cfg.contained) return false;
    const reloadResolver = egressDnsEnabled();
    const reloadProxy = egressProxyEnabled();
    if (!reloadResolver && !reloadProxy) return false;
    const agentRunning = sc?.status === "running" && Boolean(sc.id);
    if (agentRunning && sc?.id) {
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
    }
    // Service sidecars borrow different network namespaces. Refresh each of
    // them with the new effective allowlist as part of the same operation.
    try {
      await this.containComposeServices(sessionId, this.composeServiceNames.get(sessionId) ?? [], true);
    } catch (error) {
      console.error(`[egress:${sessionId}] service allowlist refresh failed closed:`, error);
      throw error;
    }
    return agentRunning;
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
      // docs/172 Gap 1 (planning#92) Tier A — egress enforcement, default-off via
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
      // docs/172 Gap 5 (planning#99) — kernel-tier hardening, env-gated default-OFF.
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

    // docs/172 Gap 1 (planning#92) — the agent is now multi-homed: it has an interface
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
   * session/compose network it just joined (docs/172 Gap 1, planning#92). No-op unless
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

  /**
   * Stop and remove only the agent container, preserving Compose services,
   * networks, and volumes owned by the session. Used when rotating the worker
   * image after an orchestrator update and by the manual Restart agent flow.
   */
  async destroyAgentContainer(sessionId: string): Promise<void> {
    this.lastCreateErrors.delete(sessionId);
    return destroyContainer(this.lifecycleDeps(), sessionId, { preserveChildResources: true });
  }

  // NOTE: there is deliberately no `destroyAll()`. It existed for the shutdown
  // path (docs/051) and `dispose()` was its only caller — which is exactly how
  // docs/113 zero-downtime updates got defeated: `deploy.sh` stopped killing
  // session containers, and the orchestrator's own shutdown hook kept doing it.
  // Teardown is per-session and explicit (`destroy(sessionId)`), owned by the
  // idle enforcer, archive/repo-delete, tier escalation and Rescue.
  //
  // `full_reset` is the one path that arguably wants a sweep and never had one:
  // `fullReset()` (`services/misc.ts`) disposes the runners and wipes the
  // workspace but takes no container manager, so the containers run on against
  // a deleted workspace until the idle enforcer's capacity limit or the next
  // boot's `cleanupOrphanContainers()` reaps them. That is pre-existing — this
  // method was never wired there despite its old "for full_reset" docstring —
  // and fixing it means giving `fullReset` a container manager, not resurrecting
  // an all-sessions sweep on a path that doesn't need one.

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
   * planning#196 — resolve the `BASE_IMAGE_DIGEST` baked into the worker image, the
   * pinned-base ABI fingerprint the overlay scope keys on. Mirrors
   * {@link resolveWorkerImageId}'s caching (incl. caching a miss as `""`) so it
   * adds no per-session Docker call. Returns `undefined` when the image can't be
   * inspected or carries no baked digest (a pre-planning#196 image) — the caller then
   * leaves the scope on the worker-image-id / `"unknown"` fallback.
   */
  async resolveWorkerBaseDigest(): Promise<string | undefined> {
    if (this.workerBaseDigest !== undefined) return this.workerBaseDigest || undefined;
    this.workerBaseDigest = await resolveWorkerBaseDigestFn(this.docker, this.imageName);
    return this.workerBaseDigest || undefined;
  }

  /**
   * docs/248 — the Node version baked into the worker image, or undefined when
   * the image can't be inspected or declares none.
   */
  async resolveWorkerNodeVersion(): Promise<string | undefined> {
    if (this.workerNodeVersion !== undefined) return this.workerNodeVersion || undefined;
    this.workerNodeVersion = await resolveWorkerNodeVersionFn(this.docker, this.imageName);
    return this.workerNodeVersion || undefined;
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

  /** Resolve agent, Compose-service, and sidecar IPs to their owning session. */
  async getSessionByAnyContainerIp(ip: string): Promise<{ sessionId: string } | undefined> {
    const agent = this.getSessionByContainerIp(ip);
    if (agent) return { sessionId: agent.sessionId };
    const arrivedAt = Date.now();
    const cached = this.containerOriginSessions.get(ip);
    if (cached && arrivedAt - this.containerOriginRefreshedAt <= 1_000) return { sessionId: cached };
    if ((this.containerOriginNegative.get(ip) ?? 0) > arrivedAt) return undefined;

    const refresh = async (): Promise<void> => {
      if (Date.now() < this.containerOriginRefreshBackoffUntil) return;
      if (!this.containerOriginRefresh) {
        this.containerOriginRefreshStartedAt = Date.now();
        this.containerOriginRefresh = (async () => {
        try {
          const entries = await Promise.race([
            this.docker.listContainers({
              filters: { label: ["shipit-parent-session"] },
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("container-origin lookup timed out")), 1_000).unref();
            }),
          ]);
          const next = new Map<string, string>();
          for (const entry of entries) {
            const sessionId = entry.Labels?.["shipit-parent-session"];
            if (!sessionId) continue;
            for (const network of Object.values(entry.NetworkSettings?.Networks ?? {})) {
              if (network.IPAddress) next.set(network.IPAddress, sessionId);
            }
          }
          this.containerOriginSessions = next;
          this.containerOriginRefreshedAt = Date.now();
          this.containerOriginRefreshBackoffUntil = 0;
          this.containerOriginRefreshFailed = false;
          for (const [negativeIp, expiresAt] of this.containerOriginNegative) {
            if (expiresAt <= this.containerOriginRefreshedAt) this.containerOriginNegative.delete(negativeIp);
          }
        } catch (error) {
          console.warn("[container-guard] could not refresh container IP index:", error);
          this.containerOriginRefreshBackoffUntil = Date.now() + 5_000;
          this.containerOriginRefreshFailed = true;
          this.containerOriginNegative.clear();
        } finally {
          this.containerOriginRefresh = undefined;
        }
        })();
      }
      await this.containerOriginRefresh;
    };

    const joinedRefreshStartedAt = this.containerOriginRefresh
      ? this.containerOriginRefreshStartedAt
      : 0;
    await refresh();
    // If this request joined a snapshot that started before the request, take a
    // second snapshot. A service can appear between those two events.
    if (joinedRefreshStartedAt > 0 && joinedRefreshStartedAt < arrivedAt
      && Date.now() >= this.containerOriginRefreshBackoffUntil) {
      await refresh();
    }
    const refreshed = this.containerOriginSessions.get(ip);
    if (refreshed) return { sessionId: refreshed };
    if (this.containerOriginRefreshFailed) {
      await this.refreshSessionNetworkRanges();
      throw new Error("container-origin index is unavailable");
    }
    this.containerOriginNegative.set(ip, Date.now() + 1_000);
    return undefined;
  }

  private async refreshSessionNetworkRanges(): Promise<void> {
    if (Date.now() < this.sessionNetworkRangeRefreshBackoffUntil) return;
    this.sessionNetworkRangeRefresh ??= (async () => {
        try {
          await Promise.race([
            Promise.all([...this.containers.keys()].map(async (sessionId) => {
              const inspected = await Promise.allSettled([
                this.docker.getNetwork(`shipit-session-${sessionId}`).inspect(),
                this.docker.getNetwork(`shipit-egress-${sessionId}`).inspect(),
              ]);
              const ranges = inspected.flatMap((result) => result.status === "fulfilled"
                ? (result.value.IPAM?.Config ?? [])
                  .filter((entry): entry is { Subnet: string; Gateway?: string } => Boolean(entry.Subnet))
                  .map((entry) => ({ subnet: entry.Subnet, ...(entry.Gateway ? { gateway: entry.Gateway } : {}) }))
                : []);
              // Preserve the last-known-good ranges when Docker cannot inspect
              // either network. This fallback exists for Docker outages, so an
              // outage must never erase it and turn the API guard fail-open.
              if (ranges.length > 0) this.sessionNetworkRanges.set(sessionId, ranges);
            })),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("session-network range lookup timed out")), 1_000).unref();
            }),
          ]);
          this.sessionNetworkRangeRefreshBackoffUntil = Date.now() + 1_000;
        } catch (error) {
          console.warn("[container-guard] could not refresh session network ranges:", error);
          this.sessionNetworkRangeRefreshBackoffUntil = Date.now() + 5_000;
        } finally {
          this.sessionNetworkRangeRefresh = undefined;
        }
      })();
    await this.sessionNetworkRangeRefresh;
  }

  /** Conservative bridge-origin check used only when Docker lookup is unavailable. */
  isLikelySessionContainerIp(ip: string): boolean {
    const toIpv4 = (value: string): number | null => {
      const parts = value.split(".").map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
      return parts.reduce((result, part) => (result * 256) + part, 0) >>> 0;
    };
    const target = toIpv4(ip);
    if (target === null) return false;
    for (const ranges of this.sessionNetworkRanges.values()) {
      for (const range of ranges) {
        if (range.gateway === ip) continue;
        const [baseText, prefixText] = range.subnet.split("/");
        const base = toIpv4(baseText);
        const prefix = Number(prefixText);
        if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if ((target & mask) === (base & mask)) return true;
      }
    }
    return false;
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
   * Stop and remove every UNCLAIMED `shipit-standby=true` container at boot — a
   * standby holds no work and was built from the previous process's worker
   * image, so it never survives a restart. `activeSessionIds` is load-bearing:
   * the label is immutable after create, so a claimed session's container still
   * carries it and only the session row tells the two apart. See
   * `reapStandbyContainers`.
   */
  async reapStandbyContainers(activeSessionIds: Set<string>): Promise<number> {
    return reapStandbyContainers(this.discoveryDeps(), activeSessionIds);
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

  /**
   * Ask Docker whether the tracked container for a session is still running.
   * `undefined` means Docker could not answer — never treat that as death.
   * See `isTrackedContainerRunning` in `container-discovery.ts`.
   */
  async isTrackedContainerRunning(sessionId: string): Promise<boolean | undefined> {
    return isTrackedContainerRunning(this.discoveryDeps(), sessionId);
  }

  /**
   * Apply the `die` we never received: drop the tracking entry for a container
   * Docker has confirmed is no longer running, and reap what that `die` would
   * have reaped. Returns `false` when nothing was done.
   *
   * Deliberately the same work the `die` handler in `container-health.ts`
   * performs — reap the egress sidecars, mark stopped, forget it — and
   * deliberately NOT `destroy()`. There is nothing left to stop, and
   * `destroy()` would also sweep the session's Compose children on a path
   * whose only established fact is "the agent container is gone". The dead
   * container's own shell is removed by name on the next create for this
   * session (`removeStaleContainer`).
   *
   * The sidecar reap is not optional and must happen BEFORE the map entry
   * goes: the Tier B/C egress sidecars share the agent container's netns and
   * are dead weight without it, and every later `destroyContainer(sessionId)`
   * early-returns once the entry is gone — so skipping it here latches the
   * leak for the life of the orchestrator. Startup orphan cleanup does not
   * save us either: it protects every active session's id.
   *
   * `expectedContainerId` guards against an incarnation race. The caller
   * inspected one container and then awaited; a rescue or manual restart can
   * replace the entry in that window, and a late "not running" answer about
   * the OLD container must not delete the healthy replacement. Same guard the
   * `die` handler applies for the same reason.
   */
  async markContainerGone(sessionId: string, expectedContainerId: string): Promise<boolean> {
    const sc = this.containers.get(sessionId);
    if (!sc) return false;
    if (sc.id !== expectedContainerId) {
      console.warn(
        `[container] markContainerGone(${sessionId}) ignored — tracked ${sc.id.slice(0, 12)} != probed ${expectedContainerId.slice(0, 12)} (container was replaced)`,
      );
      return false;
    }
    await reapSessionEgressSidecars(this.docker, sessionId, sc.id);
    sc.status = "stopped";
    this.containers.delete(sessionId);
    this.standbySessionIds.delete(sessionId);
    return true;
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
    workspaceDir: string;
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
   * #2426 — the overlay pairs a SIBLING container (a plugin companion CLI's
   * invocation container) should nest under its copy of the working tree.
   *
   * Reads this session's agent-container record and only falls back to
   * re-derivation when there is none; see `resolveSiblingOverlayDepDirs` for the
   * reasoning. The `provisioned` argument is supplied here rather than by the
   * caller so the record lookup and the fallback cannot be wired up out of step.
   */
  async resolveSiblingOverlayDepDirs(opts: {
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  }): Promise<{ depDir: string; volumeName: string }[]> {
    return resolveSiblingOverlayDepDirsFn(this.overlayDeps(), {
      ...opts,
      provisioned: this.provisionedOverlayDepDirs(opts.sessionId),
    });
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

  /**
   * Release this manager's orchestrator-side resources — the Docker event
   * health monitor and every listener attached to it.
   *
   * It **must not touch the containers**. `dispose()` is reached from exactly
   * one place: the Fastify `onClose` hook (`shutdown-manager.ts`), i.e. the
   * orchestrator is going down — most often because `deploy.sh` is swapping it
   * for a new build. docs/113 makes updates zero-downtime by leaving session
   * containers alive across that swap; the new orchestrator re-adopts them at
   * boot (`rediscoverContainers()`), and `reattachInFlightTurns()` (docs/240)
   * picks up turns that were mid-flight. Destroying them here defeats both, and
   * it kills running agents mid-tool-call — the 2026-08-10 incident, where six
   * session containers were destroyed 9 seconds before the orchestrator itself
   * was replaced.
   *
   * This is the same contract CLAUDE.md states for the WebSocket lifecycle:
   * container teardown belongs to the idle enforcer and to explicit user
   * actions (archive, repo delete, full reset, Rescue), each of which calls
   * `destroy(sessionId)` itself. Process shutdown is none of those.
   *
   * The container map is deliberately NOT cleared: the containers are still
   * running, and the map is the record of that. The process is about to exit
   * and take it with them.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this.stopHealthMonitor();
    this.removeAllListeners();
  }
}
