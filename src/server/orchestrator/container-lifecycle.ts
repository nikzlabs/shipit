/**
 * Container lifecycle — create, destroy, cleanup, and config building.
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 * All functions receive explicit dependencies rather than accessing class state.
 */

import type Docker from "dockerode";
import fs from "node:fs";
import type { EventEmitter } from "node:events";
import type {
  ContainerConfig,
  SessionContainer,
  SessionContainerManagerEvents,
} from "./session-container.js";
import {
  CONTAINER_SESSION_ID_LABEL,
} from "./session-container.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CPU_PERIOD = 100_000; // 100ms

// ---------------------------------------------------------------------------
// Internal types for dependency injection
// ---------------------------------------------------------------------------

export interface LifecycleDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  networkName: string;
  workerPort: number;
  skipHealthCheck: boolean;
  workspaceVolume?: string;
  credentialsVolume?: string;
  imageName: string;
  defaultMemoryLimit: number;
  defaultCpuQuota: number;
  defaultPidsLimit: number;
  stackName?: string;
  dockerImageName?: string;
  dockerProxyHost?: string;
  dockerProxyPort?: number;
  emitter: EventEmitter<SessionContainerManagerEvents>;
  baseLabels: () => Record<string, string>;
}

// ---------------------------------------------------------------------------
// Mount / env builders
// ---------------------------------------------------------------------------

interface MountSpec {
  binds: string[];
  mounts: {
    Type: "volume"; Source: string; Target: string; ReadOnly?: boolean;
    VolumeOptions?: { Subpath?: string };
  }[];
  workspaceDir: string;
}

/** Container-internal mount point for the shared dependency cache. */
export const DEP_CACHE_CONTAINER_PATH = "/dep-cache";

/**
 * Container-internal mount point for the shared git repo. Hidden path to
 * prevent the AI agent from discovering and writing to the shared repo
 * instead of the session worktree at /user.
 */
export const INTERNAL_GIT_MOUNT = "/.shipit-internal-git";

/**
 * Host-side directory (relative to /workspace) for .git override files.
 * Each file rewrites the worktree gitdir reference to use INTERNAL_GIT_MOUNT
 * so the original /workspace/repos/... path is never exposed inside containers.
 */
const GIT_OVERRIDE_DIR = "/workspace/.git-overrides";

export function buildMounts(
  config: ContainerConfig,
  workspaceVolume: string | undefined,
  credentialsVolume: string | undefined,
): MountSpec {
  const binds: string[] = [];
  const mounts: MountSpec["mounts"] = [];
  const workspaceDir = "/user";

  if (workspaceVolume) {
    const relPath = config.sessionDir.replace(/^\/workspace\//, "");
    mounts.push({
      Type: "volume",
      Source: workspaceVolume,
      Target: "/user",
      VolumeOptions: { Subpath: relPath },
    });
  } else {
    binds.push(`${config.sessionDir}:/user:rw`);
  }

  if (credentialsVolume) {
    mounts.push({
      Type: "volume",
      Source: credentialsVolume,
      Target: "/credentials",
    });
  } else {
    binds.push(`${config.credentialsDir}:/credentials:rw`);
  }

  // For worktree sessions, mount the shared repo at a HIDDEN path so the AI
  // agent cannot discover it by exploring /workspace. The worktree's .git file
  // (which contains an absolute gitdir reference) is overridden via a separate
  // mount to point at the hidden path. Read-write is required because git
  // commits in a worktree write objects to the shared repo's object store.
  if (config.sharedRepoDir) {
    if (workspaceVolume) {
      const repoRelPath = config.sharedRepoDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: INTERNAL_GIT_MOUNT,
        VolumeOptions: { Subpath: repoRelPath },
      });
      // Shadow /user/.git with a rewritten gitdir reference pointing to the
      // hidden mount path instead of the original /workspace/repos/... path.
      const gitOverrideRelPath = `.git-overrides/${config.sessionId}`;
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: "/user/.git",
        VolumeOptions: { Subpath: gitOverrideRelPath },
      });
    } else {
      binds.push(`${config.sharedRepoDir}:${INTERNAL_GIT_MOUNT}:rw`);
      binds.push(`${config.sessionDir}/.git-override:/user/.git:rw`);
    }
  }

  // Mount the per-repo dependency cache so npm/yarn/pnpm share downloaded
  // packages across all sessions for the same repository.
  if (config.depCacheDir) {
    if (workspaceVolume) {
      const cacheRelPath = config.depCacheDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: DEP_CACHE_CONTAINER_PATH,
        VolumeOptions: { Subpath: cacheRelPath },
      });
    } else {
      binds.push(`${config.depCacheDir}:${DEP_CACHE_CONTAINER_PATH}:rw`);
    }
  }

  return { binds, mounts, workspaceDir };
}

export type WorkerMode = "session" | "preview";

export function buildEnv(
  config: ContainerConfig,
  workspaceDir: string,
  workerPort: number,
  dockerProxyHost: string | undefined,
  dockerProxyPort: number | undefined,
  workerMode: WorkerMode = "session",
): string[] {
  const env: string[] = [
    `SESSION_ID=${config.sessionId}`,
    `WORKSPACE_DIR=${workspaceDir}`,
    `WORKER_PORT=${workerPort}`,
    `WORKER_MODE=${workerMode}`,
    "HOME=/root",
  ];

  // Point npm/yarn/pnpm caches at the shared per-repo cache mount so
  // subsequent sessions skip network downloads for already-cached packages.
  if (config.depCacheDir) {
    env.push(`npm_config_cache=${DEP_CACHE_CONTAINER_PATH}/npm`);
    env.push(`YARN_CACHE_FOLDER=${DEP_CACHE_CONTAINER_PATH}/yarn`);
    env.push(`PNPM_STORE_DIR=${DEP_CACHE_CONTAINER_PATH}/pnpm`);
  }
  if (config.dockerAccess) {
    if (!dockerProxyHost || !dockerProxyPort) {
      throw new Error(`Docker access requested but proxy not configured for session ${config.sessionId}`);
    }
    env.push(`DOCKER_HOST=tcp://${dockerProxyHost}:${dockerProxyPort}`);
    const sessionPrefix = config.sessionId.slice(0, 12);
    env.push(`COMPOSE_PROJECT_NAME=shipit-${sessionPrefix}`);
  }
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      env.push(`${key}=${value}`);
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function waitForWorkerHealth(workerUrl: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Git override helpers
// ---------------------------------------------------------------------------

/**
 * Write a .git override file that rewrites the gitdir reference from the
 * original host path to the hidden container-internal mount path.
 *
 * The override file is mounted at /user/.git inside the container, shadowing
 * the original worktree .git file so that git resolves against
 * INTERNAL_GIT_MOUNT instead of /workspace/repos/....
 */
export function writeGitOverride(config: ContainerConfig, workspaceVolume: string | undefined): void {
  if (!config.sharedRepoDir) return;

  const gitdirContent = `gitdir: ${INTERNAL_GIT_MOUNT}/.git/worktrees/${config.sessionId}\n`;

  if (workspaceVolume) {
    // Volume mode: write to the .git-overrides directory on the workspace volume
    fs.mkdirSync(GIT_OVERRIDE_DIR, { recursive: true });
    fs.writeFileSync(`${GIT_OVERRIDE_DIR}/${config.sessionId}`, gitdirContent);
  } else {
    // Bind mode: write alongside the session directory
    fs.writeFileSync(`${config.sessionDir}/.git-override`, gitdirContent);
  }
}

/** Remove the .git override file created by writeGitOverride. */
export function removeGitOverride(sessionId: string, sessionDir: string | undefined, workspaceVolume: string | undefined): void {
  try {
    if (workspaceVolume) {
      fs.unlinkSync(`${GIT_OVERRIDE_DIR}/${sessionId}`);
    } else if (sessionDir) {
      fs.unlinkSync(`${sessionDir}/.git-override`);
    }
  } catch {
    // File may not exist
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createContainer(
  deps: LifecycleDeps,
  config: ContainerConfig,
): Promise<SessionContainer> {
  if (deps.containers.has(config.sessionId)) {
    throw new Error(`Container already exists for session ${config.sessionId}`);
  }

  // Ensure the dep cache directory exists on the host before mounting.
  if (config.depCacheDir) {
    fs.mkdirSync(config.depCacheDir, { recursive: true });
  }

  // Write the .git override file before computing mounts (it will be mounted
  // at /user/.git to shadow the original worktree gitdir reference).
  writeGitOverride(config, deps.workspaceVolume);

  const { binds, mounts, workspaceDir } = buildMounts(
    config,
    deps.workspaceVolume,
    deps.credentialsVolume,
  );

  const env = buildEnv(
    config,
    workspaceDir,
    deps.workerPort,
    deps.dockerProxyHost,
    deps.dockerProxyPort,
    "session",
  );

  // Use Docker-capable image when Docker access is requested
  const imageName = (config.dockerAccess && deps.dockerImageName)
    ? deps.dockerImageName
    : config.imageName;

  // Create session-specific bridge network for Docker-enabled sessions.
  // Child containers created through the proxy join this network so they
  // can communicate with each other but not with other sessions' containers.
  let sessionNetworkName: string | undefined;
  if (config.dockerAccess) {
    sessionNetworkName = `shipit-session-${config.sessionId.slice(0, 12)}`;
    try {
      await deps.docker.createNetwork({
        Name: sessionNetworkName,
        Driver: "bridge",
        Labels: {
          ...deps.baseLabels(),
          "shipit-parent-session": config.sessionId,
        },
      });
    } catch (err) {
      // Network may already exist from a previous run — log other errors
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) {
        console.warn(`[containers] Failed to create session network ${sessionNetworkName}:`, msg);
      }
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
  deps.containers.set(config.sessionId, sc);

  const shortId = config.sessionId.slice(0, 12);

  try {
    const container = await deps.docker.createContainer({
      name: `agent-${shortId}`,
      Image: imageName,
      Cmd: ["node", "--import", "tsx", "src/server/session/session-worker.ts"],
      Labels: {
        ...deps.baseLabels(),
        [CONTAINER_SESSION_ID_LABEL]: config.sessionId,
        ...config.extraLabels,
      },
      HostConfig: {
        Binds: binds.length > 0 ? binds : undefined,
        Mounts: mounts.length > 0 ? mounts as Parameters<typeof deps.docker.createContainer>[0]["HostConfig"] extends { Mounts?: infer M } ? M : never : undefined,
        Memory: config.memoryLimit,
        CpuQuota: config.cpuQuota,
        CpuPeriod: DEFAULT_CPU_PERIOD,
        PidsLimit: config.pidsLimit,
        NetworkMode: deps.networkName,
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
    const networkInfo = networks[deps.networkName];
    if (!networkInfo?.IPAddress) {
      throw new Error(`Container has no IP on network ${deps.networkName}`);
    }

    sc.id = container.id;
    sc.containerIp = networkInfo.IPAddress;
    sc.workerUrl = `http://${sc.containerIp}:${deps.workerPort}`;

    // Wait for the worker process to be healthy before declaring the container ready.
    if (!deps.skipHealthCheck) {
      await waitForWorkerHealth(sc.workerUrl);
    }
    sc.status = "running";

    deps.emitter.emit("container_started", config.sessionId);
    return sc;
  } catch (err) {
    // Clean up on failure — stop/remove the container if it was created
    deps.containers.delete(config.sessionId);
    if (sc.id) {
      try {
        const c = deps.docker.getContainer(sc.id);
        try { await c.stop({ t: 2 }); } catch { /* may not be running */ }
        try { await c.remove({ force: true }); } catch { /* may already be gone */ }
      } catch {
        // Container reference invalid
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup session Docker resources
// ---------------------------------------------------------------------------

export async function cleanupSessionDockerResources(
  docker: Docker,
  sessionId: string,
): Promise<void> {
  const parentLabel = `shipit-parent-session=${sessionId}`;

  // Stop and remove child containers
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [parentLabel] },
    });
    for (const ci of containers) {
      try {
        const container = docker.getContainer(ci.Id);
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
    const networks = await docker.listNetworks({
      filters: { label: [parentLabel] },
    });
    for (const ni of networks) {
      try {
        const network = docker.getNetwork(ni.Id);
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
    const volumes = await docker.listVolumes({
      filters: { label: [parentLabel] },
    });
    for (const vi of (volumes?.Volumes ?? [])) {
      try {
        const volume = docker.getVolume(vi.Name);
        await volume.remove();
      } catch (err) {
        console.warn(`[containers] Failed to clean up volume ${vi.Name} for session ${sessionId}:`, err);
      }
    }
  } catch {
    // Docker may not be available
  }
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

export async function destroyContainer(
  deps: LifecycleDeps,
  sessionId: string,
): Promise<void> {
  deps.standbySessionIds.delete(sessionId);
  const sc = deps.containers.get(sessionId);
  if (!sc) return;

  sc.status = "stopping";

  // Stop the session container first so it can't create new child resources
  try {
    const container = deps.docker.getContainer(sc.id);
    try {
      await container.stop({ t: 5 });
    } catch {
      // Already stopped or doesn't exist
    }
  } catch {
    // Container may already be gone
  }

  // Clean up Docker resources created through the proxy (after session is stopped)
  await cleanupSessionDockerResources(deps.docker, sessionId);

  // Remove the session container
  try {
    const container = deps.docker.getContainer(sc.id);
    try {
      await container.remove({ force: true });
    } catch {
      // Already removed
    }
  } catch {
    // Container may already be gone
  }

  // Clean up the .git override file
  removeGitOverride(sessionId, sc.hostWorkspaceDir, deps.workspaceVolume);

  sc.status = "stopped";
  deps.containers.delete(sessionId);
  deps.emitter.emit("container_destroyed", sessionId);
}

// ---------------------------------------------------------------------------
// Preview container
// ---------------------------------------------------------------------------

/** Label used to associate preview containers with their session. */
export const PREVIEW_CONTAINER_LABEL = "shipit-preview-for";

/**
 * Build mounts for the preview container — workspace only, no credentials.
 */
export function buildPreviewMounts(
  config: ContainerConfig,
  workspaceVolume: string | undefined,
): MountSpec {
  const binds: string[] = [];
  const mounts: MountSpec["mounts"] = [];
  const workspaceDir = "/user";

  if (workspaceVolume) {
    const relPath = config.sessionDir.replace(/^\/workspace\//, "");
    mounts.push({
      Type: "volume",
      Source: workspaceVolume,
      Target: "/user",
      VolumeOptions: { Subpath: relPath },
    });
  } else {
    binds.push(`${config.sessionDir}:/user:rw`);
  }

  // Worktree: mount shared repo at hidden path (same as session container)
  if (config.sharedRepoDir) {
    if (workspaceVolume) {
      const repoRelPath = config.sharedRepoDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: INTERNAL_GIT_MOUNT,
        VolumeOptions: { Subpath: repoRelPath },
      });
      const gitOverrideRelPath = `.git-overrides/${config.sessionId}`;
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: "/user/.git",
        VolumeOptions: { Subpath: gitOverrideRelPath },
      });
    } else {
      binds.push(`${config.sharedRepoDir}:${INTERNAL_GIT_MOUNT}:rw`);
      binds.push(`${config.sessionDir}/.git-override:/user/.git:rw`);
    }
  }

  // Dependency cache
  if (config.depCacheDir) {
    if (workspaceVolume) {
      const cacheRelPath = config.depCacheDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: DEP_CACHE_CONTAINER_PATH,
        VolumeOptions: { Subpath: cacheRelPath },
      });
    } else {
      binds.push(`${config.depCacheDir}:${DEP_CACHE_CONTAINER_PATH}:rw`);
    }
  }

  return { binds, mounts, workspaceDir };
}

/**
 * Create a preview container for the given session. Shares the workspace
 * volume but has no credentials mount. The preview worker receives secrets
 * via PUT /secrets after the container is healthy.
 */
export async function createPreviewContainer(
  deps: LifecycleDeps,
  config: ContainerConfig,
  previewMemoryLimit: number,
  previewPidsLimit?: number,
): Promise<{ id: string; ip: string; workerUrl: string }> {
  // Ensure the .git override file exists (may already exist from session container).
  writeGitOverride(config, deps.workspaceVolume);

  // Ensure the dep cache directory exists on the host before mounting.
  if (config.depCacheDir) {
    fs.mkdirSync(config.depCacheDir, { recursive: true });
  }

  const { binds, mounts, workspaceDir } = buildPreviewMounts(
    config,
    deps.workspaceVolume,
  );

  const env = buildEnv(
    config,
    workspaceDir,
    deps.workerPort,
    undefined, // no Docker proxy for preview
    undefined,
    "preview",
  );

  const shortId = config.sessionId.slice(0, 12);

  const container = await deps.docker.createContainer({
    name: `preview-${shortId}`,
    Image: config.imageName,
    Cmd: ["node", "--import", "tsx", "src/server/session/session-worker.ts"],
    Labels: {
      ...deps.baseLabels(),
      [PREVIEW_CONTAINER_LABEL]: config.sessionId,
      "shipit-parent-session": config.sessionId,
    },
    HostConfig: {
      Binds: binds.length > 0 ? binds : undefined,
      Mounts: mounts.length > 0 ? mounts as Parameters<typeof deps.docker.createContainer>[0]["HostConfig"] extends { Mounts?: infer M } ? M : never : undefined,
      Memory: previewMemoryLimit,
      CpuQuota: config.cpuQuota,
      CpuPeriod: DEFAULT_CPU_PERIOD,
      PidsLimit: previewPidsLimit ?? config.pidsLimit,
      NetworkMode: deps.networkName,
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: false,
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE", "NET_BIND_SERVICE", "KILL"],
    },
    Env: env,
  });

  await container.start();

  const info = await container.inspect();
  const networks = info.NetworkSettings.Networks;
  const networkInfo = networks[deps.networkName];
  if (!networkInfo?.IPAddress) {
    // Clean up on failure
    try { await container.stop({ t: 2 }); } catch { /* */ }
    try { await container.remove({ force: true }); } catch { /* */ }
    throw new Error(`Preview container has no IP on network ${deps.networkName}`);
  }

  const ip = networkInfo.IPAddress;
  const workerUrl = `http://${ip}:${deps.workerPort}`;

  if (!deps.skipHealthCheck) {
    await waitForWorkerHealth(workerUrl);
  }

  return { id: container.id, ip, workerUrl };
}

// ---------------------------------------------------------------------------
// Build config
// ---------------------------------------------------------------------------

export function buildContainerConfig(
  deps: Pick<LifecycleDeps, "imageName" | "defaultMemoryLimit" | "defaultCpuQuota" | "defaultPidsLimit">,
  opts: {
    sessionId: string;
    sessionDir: string;
    credentialsDir: string;
    sharedRepoDir?: string;
    depCacheDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
  },
): ContainerConfig {
  return {
    sessionId: opts.sessionId,
    sessionDir: opts.sessionDir,
    credentialsDir: opts.credentialsDir,
    sharedRepoDir: opts.sharedRepoDir,
    depCacheDir: opts.depCacheDir,
    imageName: deps.imageName,
    memoryLimit: opts.memoryLimit ?? deps.defaultMemoryLimit,
    cpuQuota: opts.cpuQuota ?? deps.defaultCpuQuota,
    pidsLimit: opts.pidsLimit ?? deps.defaultPidsLimit,
    env: opts.env,
    dockerAccess: opts.dockerAccess,
  };
}
