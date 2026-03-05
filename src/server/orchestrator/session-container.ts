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
 */

import Docker from "dockerode";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerConfig {
  sessionId: string;
  /** Host path: /workspace/sessions/{uuid} */
  sessionDir: string;
  /** Host path: /workspace/repos/{hash} (for worktree sessions) */
  sharedRepoDir?: string;
  /** Host path: /credentials (Claude CLI auth, GitHub token) */
  credentialsDir: string;
  /** Container image name. */
  imageName: string;
  /** Memory limit in bytes. */
  memoryLimit: number;
  /** CPU quota in microseconds per 100ms period. */
  cpuQuota: number;
  /** Maximum number of PIDs. */
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
}

export interface SessionContainerManagerEvents {
  /** Emitted when a container exits unexpectedly (OOM, crash). */
  container_exited: [sessionId: string, exitCode: number, error?: string];
  /** Emitted when a container is successfully started. */
  container_started: [sessionId: string];
  /** Emitted when a container is destroyed. */
  container_destroyed: [sessionId: string];
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
  /** Default memory limit in bytes. Defaults to 512MB. */
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
const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024; // 512 MB
const DEFAULT_CPU_QUOTA = 50_000; // 0.5 CPU (50000 µs per 100ms period)
const DEFAULT_CPU_PERIOD = 100_000; // 100ms
const DEFAULT_PIDS_LIMIT = 256;
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
  private credentialsVolume?: string;
  private stackName?: string;
  private dockerImageName?: string;
  private dockerProxyHost?: string;
  private dockerProxyPort?: number;
  private standbySessionIds = new Set<string>();
  private eventStream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
  private _disposed = false;

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

  // --- Container lifecycle ---

  /**
   * Create and start a container for the given session.
   * Returns the SessionContainer with its bridge IP and worker URL.
   */
  async create(config: ContainerConfig): Promise<SessionContainer> {
    if (this.containers.has(config.sessionId)) {
      throw new Error(`Container already exists for session ${config.sessionId}`);
    }

    // Build mounts. When running inside Docker (orchestrator is itself a
    // container), paths like /workspace/sessions/{uuid} exist in a named volume,
    // not on the host. Use Docker volume subpaths (API 1.45+) to mount just
    // the session subdir at /user for a short cwd that saves tokens.
    const binds: string[] = [];
    const mounts: Array<{
      Type: "volume"; Source: string; Target: string; ReadOnly?: boolean;
      VolumeOptions?: { Subpath?: string };
    }> = [];
    const workspaceDir = "/user";
    if (this.workspaceVolume) {
      // Mount the session subdir from the named volume at /user
      const relPath = config.sessionDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: this.workspaceVolume,
        Target: "/user",
        VolumeOptions: { Subpath: relPath },
      });
    } else {
      binds.push(`${config.sessionDir}:/user:rw`);
    }
    if (this.credentialsVolume) {
      mounts.push({
        Type: "volume",
        Source: this.credentialsVolume,
        Target: "/credentials",
      });
    } else {
      binds.push(`${config.credentialsDir}:/credentials:rw`);
    }
    // For worktree sessions, mount the shared repo at its ORIGINAL absolute
    // path so that the worktree's .git file (which contains an absolute gitdir
    // reference like /workspace/repos/{hash}/.git/worktrees/{branch}) resolves
    // correctly inside the container. Read-write is required because git commits
    // in a worktree write objects to the shared repo's object store.
    if (config.sharedRepoDir) {
      if (this.workspaceVolume) {
        const repoRelPath = config.sharedRepoDir.replace(/^\/workspace\//, "");
        mounts.push({
          Type: "volume",
          Source: this.workspaceVolume,
          Target: config.sharedRepoDir,
          VolumeOptions: { Subpath: repoRelPath },
        });
      } else {
        binds.push(`${config.sharedRepoDir}:${config.sharedRepoDir}:rw`);
      }
    }

    // Build environment variables
    const env: string[] = [
      `SESSION_ID=${config.sessionId}`,
      `WORKSPACE_DIR=${workspaceDir}`,
      `WORKER_PORT=${this.workerPort}`,
      "HOME=/root",
    ];
    if (config.dockerAccess) {
      if (!this.dockerProxyHost || !this.dockerProxyPort) {
        throw new Error(`Docker access requested but proxy not configured for session ${config.sessionId}`);
      }
      env.push(`DOCKER_HOST=tcp://${this.dockerProxyHost}:${this.dockerProxyPort}`);
      const sessionPrefix = config.sessionId.slice(0, 12);
      env.push(`COMPOSE_PROJECT_NAME=shipit-${sessionPrefix}`);
    }
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        env.push(`${key}=${value}`);
      }
    }

    // Use Docker-capable image when Docker access is requested
    const imageName = (config.dockerAccess && this.dockerImageName)
      ? this.dockerImageName
      : config.imageName;

    // Create session-specific bridge network for Docker-enabled sessions.
    // Child containers created through the proxy join this network so they
    // can communicate with each other but not with other sessions' containers.
    let sessionNetworkName: string | undefined;
    if (config.dockerAccess) {
      sessionNetworkName = `shipit-session-${config.sessionId.slice(0, 12)}`;
      try {
        await this.docker.createNetwork({
          Name: sessionNetworkName,
          Driver: "bridge",
          Labels: {
            ...this.baseLabels(),
            "shipit-parent-session": config.sessionId,
          },
        });
      } catch {
        // Network may already exist from a previous run
      }
      env.push(`SHIPIT_SESSION_NETWORK=${sessionNetworkName}`);
    }

    const sc: SessionContainer = {
      id: "",
      sessionId: config.sessionId,
      containerIp: "",
      workerUrl: "",
      status: "starting",
      hostWorkspaceDir: config.sessionDir,
      dockerAccess: config.dockerAccess ?? false,
      sessionNetworkName,
      resourceLimits: (config.dockerAccess) ? {
        memory: config.memoryLimit,
        cpuQuota: config.cpuQuota,
        pidsLimit: config.pidsLimit,
      } : undefined,
    };
    this.containers.set(config.sessionId, sc);

    try {
      const container = await this.docker.createContainer({
        Image: imageName,
        Cmd: ["node", "--import", "tsx", "src/server/session/session-worker.ts"],
        Labels: {
          ...this.baseLabels(),
          [CONTAINER_SESSION_ID_LABEL]: config.sessionId,
          ...config.extraLabels,
        },
        HostConfig: {
          Binds: binds.length > 0 ? binds : undefined,
          Mounts: mounts.length > 0 ? mounts as Parameters<typeof this.docker.createContainer>[0]["HostConfig"] extends { Mounts?: infer M } ? M : never : undefined,
          Memory: config.memoryLimit,
          CpuQuota: config.cpuQuota,
          CpuPeriod: DEFAULT_CPU_PERIOD,
          PidsLimit: config.pidsLimit,
          NetworkMode: this.networkName,
          SecurityOpt: ["no-new-privileges"],
          ReadonlyRootfs: false,
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE", "NET_BIND_SERVICE", "KILL"],
        },
        Env: env,
      });

      await container.start();

      // Get the container's IP on the bridge network
      const info = await container.inspect();
      const networks = info.NetworkSettings.Networks;
      const networkInfo = networks[this.networkName];
      if (!networkInfo?.IPAddress) {
        throw new Error(`Container has no IP on network ${this.networkName}`);
      }

      sc.id = container.id;
      sc.containerIp = networkInfo.IPAddress;
      sc.workerUrl = `http://${sc.containerIp}:${this.workerPort}`;

      // Wait for the worker process to be healthy before declaring the container ready.
      if (!this.skipHealthCheck) {
        await this.waitForWorkerHealth(sc.workerUrl);
      }
      sc.status = "running";

      this.emit("container_started", config.sessionId);
      return sc;
    } catch (err) {
      // Clean up on failure
      this.containers.delete(config.sessionId);
      throw err;
    }
  }

  /**
   * Poll the worker's /health endpoint until it responds.
   * Retries every 500ms up to 30s before giving up.
   */
  private async waitForWorkerHealth(workerUrl: string): Promise<void> {
    const maxWaitMs = 30_000;
    const intervalMs = 500;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${workerUrl}/health`);
        if (res.ok) return;
      } catch {
        // Worker not up yet — retry
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Worker at ${workerUrl} did not become healthy within ${maxWaitMs / 1000}s`);
  }

  /**
   * Stop and remove a container for the given session.
   * Gracefully stops with a 5-second timeout before force-killing.
   * Also cleans up Docker resources (containers, networks, volumes) created
   * by the session through the Docker API proxy.
   */
  async destroy(sessionId: string): Promise<void> {
    this.standbySessionIds.delete(sessionId);
    const sc = this.containers.get(sessionId);
    if (!sc) return;

    sc.status = "stopping";

    // Stop the session container first so it can't create new child resources
    try {
      const container = this.docker.getContainer(sc.id);
      try {
        await container.stop({ t: 5 });
      } catch {
        // Already stopped or doesn't exist
      }
    } catch {
      // Container may already be gone
    }

    // Clean up Docker resources created through the proxy (after session is stopped)
    await this.cleanupSessionDockerResources(sessionId);

    // Remove the session container
    try {
      const container = this.docker.getContainer(sc.id);
      try {
        await container.remove({ force: true });
      } catch {
        // Already removed
      }
    } catch {
      // Container may already be gone
    }

    sc.status = "stopped";
    this.containers.delete(sessionId);
    this.emit("container_destroyed", sessionId);
  }

  /**
   * Clean up Docker resources (containers, networks, volumes) created by a
   * session through the Docker API proxy. These are identified by the
   * `shipit-parent-session` label.
   */
  private async cleanupSessionDockerResources(sessionId: string): Promise<void> {
    const parentLabel = `shipit-parent-session=${sessionId}`;

    // Stop and remove child containers
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [parentLabel] },
      });
      for (const ci of containers) {
        try {
          const container = this.docker.getContainer(ci.Id);
          if (ci.State === "running") {
            await container.stop({ t: 5 });
          }
          await container.remove({ force: true });
        } catch (err) {
          console.warn(`[containers] Failed to clean up child container ${ci.Id.slice(0, 12)} for session ${sessionId}:`, err);
        }
      }
    } catch {
      // Docker may not be available
    }

    // Remove child networks
    try {
      const networks = await this.docker.listNetworks({
        filters: { label: [parentLabel] },
      });
      for (const ni of networks) {
        try {
          const network = this.docker.getNetwork(ni.Id);
          await network.remove();
        } catch (err) {
          console.warn(`[containers] Failed to clean up network ${ni.Id.slice(0, 12)} for session ${sessionId}:`, err);
        }
      }
    } catch {
      // Docker may not be available
    }

    // Remove child volumes
    try {
      const volumes = await this.docker.listVolumes({
        filters: { label: [parentLabel] },
      });
      for (const vi of (volumes?.Volumes ?? [])) {
        try {
          const volume = this.docker.getVolume(vi.Name);
          await volume.remove();
        } catch (err) {
          console.warn(`[containers] Failed to clean up volume ${vi.Name} for session ${sessionId}:`, err);
        }
      }
    } catch {
      // Docker may not be available
    }
  }

  /** Stop and remove all session containers. Used for full_reset and shutdown. */
  async destroyAll(): Promise<void> {
    const sessionIds = [...this.containers.keys()];
    await Promise.allSettled(sessionIds.map((id) => this.destroy(id)));
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
    for (const sc of this.containers.values()) {
      if (sc.containerIp === ip) return sc;
    }
    return undefined;
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

  // --- Orphan cleanup ---

  /**
   * Remove containers left over from a previous orchestrator run.
   * Scans for containers with the shipit-session label that don't match
   * any currently tracked session.
   */
  async cleanupOrphans(activeSessionIds: Set<string>): Promise<number> {
    let removed = 0;
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: this.labelFilters(),
        },
      });

      for (const containerInfo of containers) {
        const sessionId = containerInfo.Labels?.[CONTAINER_SESSION_ID_LABEL];
        if (sessionId && !activeSessionIds.has(sessionId)) {
          try {
            const container = this.docker.getContainer(containerInfo.Id);
            if (containerInfo.State === "running") {
              await container.stop({ t: 5 });
            }
            await container.remove({ force: true });
            removed++;
          } catch {
            // Container may already be gone
          }
        }
      }
    } catch {
      // Docker may not be available
    }
    return removed;
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
    let count = 0;
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: this.labelFilters() },
      });
      for (const ci of containers) {
        const sessionId = ci.Labels?.[CONTAINER_SESSION_ID_LABEL];
        if (!sessionId || !activeSessionIds.has(sessionId)) continue;
        if (this.containers.has(sessionId)) continue;
        if (ci.State !== "running") continue;
        try {
          const container = this.docker.getContainer(ci.Id);
          const info = await container.inspect();
          const networkInfo = info.NetworkSettings?.Networks?.[this.networkName];
          if (!networkInfo?.IPAddress) continue;
          const resolved = sessionInfoResolver?.(sessionId);
          // Skip containers whose session info can't be resolved — without a
          // valid workspace dir, bind mount validation would be unsafe
          if (!resolved?.workspaceDir) continue;
          const dockerAccess = resolved.dockerAccess;
          this.containers.set(sessionId, {
            id: ci.Id,
            sessionId,
            containerIp: networkInfo.IPAddress,
            workerUrl: `http://${networkInfo.IPAddress}:${this.workerPort}`,
            status: "running",
            hostWorkspaceDir: resolved.workspaceDir,
            dockerAccess,
            sessionNetworkName: dockerAccess ? `shipit-session-${sessionId.slice(0, 12)}` : undefined,
            resourceLimits: dockerAccess ? resolved.resourceLimits : undefined,
          });
          if (ci.Labels?.[CONTAINER_STANDBY_LABEL] === "true") {
            this.standbySessionIds.add(sessionId);
          }
          count++;
        } catch {
          // Container may have exited between list and inspect
        }
      }
    } catch {
      // Docker may not be available
    }
    return count;
  }

  // --- Health monitoring via Docker event stream ---

  /**
   * Start listening for Docker events to detect container crashes (OOM, exit).
   * Emits "container_exited" when a session container dies unexpectedly.
   */
  async startHealthMonitor(): Promise<void> {
    if (this.eventStream) return;

    try {
      this.eventStream = await this.docker.getEvents({
        filters: {
          type: ["container"],
          event: ["die", "oom"],
          label: this.labelFilters(),
        },
      });

      this.eventStream.on("data", (chunk: Buffer) => {
        try {
          const event = JSON.parse(chunk.toString());
          const sessionId = event.Actor?.Attributes?.[CONTAINER_SESSION_ID_LABEL];
          if (!sessionId) return;

          const sc = this.containers.get(sessionId);
          if (!sc) return;

          if (event.Action === "die" || event.Action === "oom") {
            // Skip if destroy() is already in-flight — it will handle cleanup
            if (sc.status === "stopping") return;
            const exitCode = Number(event.Actor?.Attributes?.exitCode ?? 1);
            const error = event.Action === "oom" ? "Out of memory" : undefined;
            sc.status = "stopped";
            this.containers.delete(sessionId);
            this.emit("container_exited", sessionId, exitCode, error);
          }
        } catch {
          // Malformed event — ignore
        }
      });

      this.eventStream.on("error", () => {
        // Event stream disconnected — will be restarted on next call
        this.eventStream = null;
      });
    } catch {
      // Docker events not available
    }
  }

  /** Stop the Docker event stream. */
  stopHealthMonitor(): void {
    if (this.eventStream) {
      this.eventStream.destroy?.();
      this.eventStream = null;
    }
  }

  // --- Build container config ---

  /**
   * Build a ContainerConfig with defaults applied. Convenience method
   * for callers that don't want to specify every field.
   */
  buildConfig(opts: {
    sessionId: string;
    sessionDir: string;
    credentialsDir: string;
    sharedRepoDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
  }): ContainerConfig {
    return {
      sessionId: opts.sessionId,
      sessionDir: opts.sessionDir,
      credentialsDir: opts.credentialsDir,
      sharedRepoDir: opts.sharedRepoDir,
      imageName: this.imageName,
      memoryLimit: opts.memoryLimit ?? this.defaultMemoryLimit,
      cpuQuota: opts.cpuQuota ?? this.defaultCpuQuota,
      pidsLimit: opts.pidsLimit ?? this.defaultPidsLimit,
      env: opts.env,
      dockerAccess: opts.dockerAccess,
    };
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
