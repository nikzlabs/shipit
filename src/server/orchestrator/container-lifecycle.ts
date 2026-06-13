/**
 * Container lifecycle — create, destroy, cleanup, and config building.
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 * All functions receive explicit dependencies rather than accessing class state.
 */

import type Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import type { EventEmitter } from "node:events";
import type {
  ContainerConfig,
  SessionContainer,
  SessionContainerManagerEvents,
} from "./session-container.js";
import {
  CONTAINER_SESSION_ID_LABEL,
} from "./session-container.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import type { HostMount } from "../shared/shipit-config.js";
import {
  ensureSessionCredentialsScaffold,
  perSessionCredentialsDir,
  perSessionCredentialsSubpath,
} from "./session-credentials.js";
import { createOverlayVolume, removeOverlayVolume } from "./overlay-volume.js";
import { preStampInstallMarker, type DepDirOverlaySpec } from "./overlay-session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CPU_PERIOD = 100_000; // 100ms

/**
 * docs/128 — DNS target an ops session's agent uses to reach the Docker daemon.
 * Points at the `docker-socket-proxy` compose sibling (a read-only proxy that
 * mounts the real host socket and rejects mutating endpoints), reachable by
 * service name once the agent joins the session compose network. The ops agent
 * never mounts the real socket; all Docker access flows through this proxy.
 */
export const OPS_DOCKER_HOST = "tcp://docker-socket-proxy:2375";

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
  /**
   * Orchestrator-visible state dir holding `overlay-base-meta/` — needed by the
   * base-hit marker pre-stamp (docs/183, `preStampInstallMarker`). Optional;
   * without it the pre-stamp is skipped.
   */
  stateDir?: string;
  emitter: EventEmitter<SessionContainerManagerEvents>;
  baseLabels: () => Record<string, string>;
}

// ---------------------------------------------------------------------------
// Mount / env builders
// ---------------------------------------------------------------------------

interface MountSpec {
  binds: string[];
  mounts: {
    Type: "bind" | "volume"; Source: string; Target: string; ReadOnly?: boolean;
    BindOptions?: { Propagation?: string; CreateMountpoint?: boolean };
    VolumeOptions?: { Subpath?: string };
  }[];
  workspaceDir: string;
}

/** Container-internal mount point for the shared dependency cache. */
export const DEP_CACHE_CONTAINER_PATH = "/dep-cache";

/**
 * docs/198 — container-internal mount point for the shared per-runtime pnpm
 * store. It must be **pnpm's own relocation target**, not an arbitrary path:
 * pnpm 11 ignores `npm_config_store_dir` (and `pnpm config set store-dir`) and,
 * when HOME's default store sits on a different device than the project (HOME is
 * on the container overlay fs; `/workspace` is its own volume mount), relocates
 * the content-addressable store to `<nearest mountpoint of project>/.pnpm-store`
 * — i.e. `/workspace/.pnpm-store` (pnpm FAQ: a project on a filesystem mounted at
 * `/mnt` gets its store at `/mnt/.pnpm-store`). Mounting the shared store there
 * means pnpm "relocates" straight INTO it with zero configuration. The host
 * source is a Subpath of the SAME state volume as `/workspace`, so pnpm's
 * store→node_modules hardlinks stay within one superblock (no EXDEV full copy).
 * `npm_config_store_dir` is still exported at this path for older pnpm versions
 * that honor it — they land in the same shared dir.
 *
 * The earlier top-level `/pnpm-store` target (docs/197) was empirically dead on
 * pnpm 11: the env was ignored and the store relocated into the workspace,
 * leaving this mount empty and breaking cross-session sharing (canary 2026-06-12).
 */
export const PNPM_STORE_CONTAINER_PATH = "/workspace/.pnpm-store";

export function buildMounts(
  config: ContainerConfig,
  workspaceVolume: string | undefined,
  credentialsVolume: string | undefined,
  overlayDepSpecs?: DepDirOverlaySpec[],
): MountSpec {
  const binds: string[] = [];
  const mounts: MountSpec["mounts"] = [];
  const workspaceDir = CONTAINER_WORKSPACE_DIR;
  // config.workspaceDir is the git repo directory (session.workspaceDir).
  // It may be the same as sessionDir (legacy) or a subdirectory (new layout).
  const hostWorkspaceDir = config.workspaceDir ?? config.sessionDir;

  // The workspace mount is ALWAYS the normal host clone (source + `.git`,
  // authoritative). docs/183 dep-dir design: even for overlay sessions
  // `/workspace` stays this mount — each declared dep dir is overlaid via its own
  // nested `/workspace/<dep-dir>` mount appended at the end of this function, not
  // by replacing the workspace root.
  if (workspaceVolume) {
    const relPath = hostWorkspaceDir.replace(/^\/workspace\//, "");
    mounts.push({
      Type: "volume",
      Source: workspaceVolume,
      Target: CONTAINER_WORKSPACE_DIR,
      VolumeOptions: { Subpath: relPath },
    });
  } else {
    binds.push(`${hostWorkspaceDir}:${CONTAINER_WORKSPACE_DIR}:rw`);
  }

  // docs/138 — mount the session's *private* credentials subtree at
  // /credentials, never the shared root. The subtree lives under
  // `<credentialsDir>/sessions/<sessionId>` and contains only the pinned
  // agent's creds (populated on first turn) plus the shared `.gitconfig`. This
  // is the cross-agent isolation boundary: a Claude session never sees `.codex`
  // and vice versa.
  if (credentialsVolume) {
    // Production: the credentials volume root maps to `config.credentialsDir`,
    // so the per-session subtree is reachable via a Subpath mount.
    mounts.push({
      Type: "volume",
      Source: credentialsVolume,
      Target: "/credentials",
      VolumeOptions: { Subpath: perSessionCredentialsSubpath(config.sessionId) },
    });
  } else {
    // Dev: bind the per-session subtree directly.
    binds.push(`${perSessionCredentialsDir(config.credentialsDir, config.sessionId)}:/credentials:rw`);
  }

  // Mount the uploads directory for user-uploaded files.
  if (config.uploadsDir) {
    if (workspaceVolume) {
      const uploadsRelPath = config.uploadsDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: "/uploads",
        VolumeOptions: { Subpath: uploadsRelPath },
      });
    } else {
      binds.push(`${config.uploadsDir}:/uploads:rw`);
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

  // docs/198 — mount the shared per-runtime pnpm store at pnpm 11's relocation
  // target `/workspace/.pnpm-store` (NESTED under the workspace mount above, like
  // the overlay dep dirs — Docker orders mounts by destination depth so the parent
  // `/workspace` always lands first). A Subpath of the SAME state volume as
  // `/workspace` (so store→node_modules hardlinks share one superblock), or a plain
  // bind in dev mode. Set only for pnpm repos under the OVERLAY_DEP_STORE flag
  // (`preparePnpmStore`); absent otherwise → byte-for-byte unchanged.
  if (config.pnpmStoreDir) {
    if (workspaceVolume) {
      const storeRelPath = config.pnpmStoreDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: PNPM_STORE_CONTAINER_PATH,
        VolumeOptions: { Subpath: storeRelPath },
      });
    } else {
      binds.push(`${config.pnpmStoreDir}:${PNPM_STORE_CONTAINER_PATH}:rw`);
    }
  }

  // docs/128 — privileged read-only host mounts for ops sessions. These are
  // gated on `config.opsSession`, which the caller derives from the
  // server-authoritative `session.kind === "ops"`. A non-ops session that
  // forged `x-shipit-host-mounts` in its shipit.yaml never reaches here with
  // `opsSession` set, so its mounts are silently dropped.
  if (config.opsSession && config.hostMounts) {
    for (const m of config.hostMounts) {
      // Do not preflight with fs.existsSync(): in production the orchestrator
      // runs in a container, so that would check the orchestrator filesystem
      // rather than the Docker host. Let the Docker daemon validate the host
      // source, but forbid creating a missing journal directory that would
      // mask a misconfigured host as an empty mount.
      mounts.push({
        Type: "bind",
        Source: m.source,
        Target: m.target,
        ReadOnly: true,
        BindOptions: { CreateMountpoint: false },
      });
    }
  }

  // docs/183 dep-dir design — mount each declared dep dir's per-session
  // `type=overlay` volume at `/workspace/<dep-dir>`, NESTED under the workspace
  // mount above. The daemon performs the `mount -t overlay` as it builds the
  // container, so the merged dep view lands at the nested target by construction
  // (proven across the host matrix — prototype/nested-overlay-spike.sh, 3/3).
  // Absent/empty for non-overlay sessions → byte-for-byte unchanged. Docker
  // orders mounts by destination depth, so the parent `/workspace` mount always
  // lands before these children regardless of array order.
  if (overlayDepSpecs) {
    for (const spec of overlayDepSpecs) {
      mounts.push({
        Type: "volume",
        Source: spec.volumeName,
        Target: spec.mountPath,
      });
    }
  }

  return { binds, mounts, workspaceDir };
}

export function buildEnv(
  config: ContainerConfig,
  workspaceDir: string,
  workerPort: number,
  dockerProxyHost: string | undefined,
  dockerProxyPort: number | undefined,
  procEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const env: string[] = [
    `SESSION_ID=${config.sessionId}`,
    `WORKSPACE_DIR=${workspaceDir}`,
    `WORKER_PORT=${workerPort}`,
    "WORKER_MODE=session",
    "HOME=/root",
    // Point git inside the container at the same global config the orchestrator
    // uses. The credentials directory is mounted at /credentials, and the
    // orchestrator writes user.name/user.email there via initGlobalGitConfig().
    // This way, any git operation inside the container (agent bash, rebase --continue,
    // etc.) inherits the user's configured identity automatically.
    "GIT_CONFIG_GLOBAL=/credentials/.gitconfig",
  ];

  // docs/183 — forward the session-worker image id so the worker's
  // install-runtime `runtimeKey()` shares the orchestrator's ABI fingerprint.
  // The orchestrator resolves it once at startup (`resolveWorkerImageId` →
  // `process.env.SESSION_WORKER_IMAGE_ID`) so a worker-image rebuild rotates the
  // overlay base scope AND invalidates a stale install marker. Mirrors the
  // worker's own precedence (`SESSION_WORKER_IMAGE_ID ?? IMAGE_DIGEST`). Absent
  // in dev/local (no Docker) and when the overlay store is off → not forwarded,
  // and the worker falls back to `"unknown"` exactly as before.
  const workerImageId = procEnv.SESSION_WORKER_IMAGE_ID ?? procEnv.IMAGE_DIGEST;
  if (workerImageId) {
    env.push(`SESSION_WORKER_IMAGE_ID=${workerImageId}`);
  }

  // Point npm/yarn/pnpm caches at the shared per-repo cache mount so
  // subsequent sessions skip network downloads for already-cached packages.
  if (config.depCacheDir) {
    env.push(`npm_config_cache=${DEP_CACHE_CONTAINER_PATH}/npm`);
    env.push(`YARN_CACHE_FOLDER=${DEP_CACHE_CONTAINER_PATH}/yarn`);
    env.push(`PNPM_STORE_DIR=${DEP_CACHE_CONTAINER_PATH}/pnpm`);
  }

  // docs/198 — point pnpm at the shared per-runtime store mount. pnpm 11 ignores
  // this env (it relocates into `/workspace/.pnpm-store`, which is exactly where the
  // store is mounted — see PNPM_STORE_CONTAINER_PATH), but OLDER pnpm versions honor
  // `npm_config_store_dir`, and pointing them at the same mounted path keeps them on
  // the shared store too. Set only for pnpm repos under the OVERLAY_DEP_STORE flag
  // (`preparePnpmStore`); absent otherwise → byte-for-byte unchanged.
  if (config.pnpmStoreDir) {
    env.push(`npm_config_store_dir=${PNPM_STORE_CONTAINER_PATH}`);
  }
  // docs/128 — ops gate MUST be checked before `dockerAccess`. An ops session's
  // shipit.yaml declares `compose.docker-socket: true` (so the proxy *sibling*
  // may mount the socket), and `resolveAgentDockerLimits` derives the agent's
  // `dockerAccess` from that same flag — so an ops session can arrive here with
  // both `opsSession` and `dockerAccess` set. The agent must NEVER get the
  // read-write session docker-proxy; it reaches Docker only through the
  // read-only docker-socket-proxy. `buildContainerConfig` already forces
  // `dockerAccess: false` for ops sessions, but we order the check ops-first
  // here too so the invariant is structural, not dependent on the caller.
  if (config.opsSession) {
    env.push(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
  } else if (config.dockerAccess) {
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

export async function buildOrchestratorCallbackEnv(sessionId: string): Promise<string[]> {
  const orchestratorPort = process.env.PORT || "3000";
  const orchestratorHost =
    process.env.SHIPIT_ORCHESTRATOR_HOST || (await import("node:os")).hostname();
  const env = [
    `SHIPIT_SESSION_ID=${sessionId}`,
    `SHIPIT_PORT=${orchestratorPort}`,
    `SHIPIT_HOST=${orchestratorHost}`,
  ];
  if (process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS) {
    env.push(`SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS=${process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS}`);
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
// Create
// ---------------------------------------------------------------------------

export async function createContainer(
  deps: LifecycleDeps,
  config: ContainerConfig,
): Promise<SessionContainer> {
  if (deps.containers.has(config.sessionId)) {
    throw new Error(`Container already exists for session ${config.sessionId}`);
  }

  // Ensure the uploads directory exists on the host before mounting.
  if (config.uploadsDir) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
  }

  // Ensure the dep cache directory exists on the host before mounting.
  if (config.depCacheDir) {
    fs.mkdirSync(config.depCacheDir, { recursive: true });
  }

  // docs/197 Part 2 — create the shared pnpm store dir lazily before mounting it.
  if (config.pnpmStoreDir) {
    fs.mkdirSync(config.pnpmStoreDir, { recursive: true });
  }

  // docs/138 — create the session's private credentials subtree before the
  // mount references it, and seed it with the shared `.gitconfig`. Warm/standby
  // containers hit this too: they carry no agent creds while idle (the agent
  // subtree is only copied in on first turn), satisfying the isolation goal.
  // Best-effort: Docker auto-creates a missing bind/subpath source, and the
  // first-turn provisioning re-creates the dir + copies `.gitconfig` anyway, so
  // a non-writable credentials dir (e.g. in unit tests) must not block create.
  try {
    ensureSessionCredentialsScaffold(config.credentialsDir, config.sessionId);
  } catch (err) {
    console.warn(
      `[containers] credentials scaffold failed for ${config.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // docs/183 dep-dir design — the per-session `type=overlay` volumes (one per
  // declared dep dir) are mounted nested at `/workspace/<dep-dir>`. buildMounts
  // only needs each volume's NAME + mount target; the volumes themselves are
  // created inside the try block below — right before the container references
  // them — so any throw between here and container start can't leak a
  // just-created volume. Non-overlay sessions pass no specs and skip this.
  const { binds, mounts, workspaceDir } = buildMounts(
    config,
    deps.workspaceVolume,
    deps.credentialsVolume,
    config.overlaySpecs,
  );

  const env = buildEnv(
    config,
    workspaceDir,
    deps.workerPort,
    deps.dockerProxyHost,
    deps.dockerProxyPort,
  );

  // Expose orchestrator API so the agent can query service status/logs
  env.push(...await buildOrchestratorCallbackEnv(config.sessionId));

  // Use the docker-capable image when Docker access is requested, or for ops
  // sessions (docs/128) — the agent runs `docker ps/logs/inspect` against a proxy
  // (and, for ops, `journalctl` over the journal mounts), so it needs the docker
  // CLI + journalctl baked in. That image is built by the `session-worker-docker`
  // deploy service and selected via `SESSION_WORKER_DOCKER_IMAGE`
  // (deps.dockerImageName, threaded from app-lifecycle.ts → setDockerProxy). If
  // the env is unset, deps.dockerImageName is undefined and we fall back to the
  // base image — see the deployment wiring in deployment/vps/.
  const imageName = ((config.dockerAccess || config.opsSession) && deps.dockerImageName)
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
    // Always record what the agent container actually booted with — the
    // claim-time refresh compares this against the now-current shipit.yaml
    // to detect a stale-limit standby. (`resourceLimits` below is the
    // separate child-container budget, docker-access sessions only.)
    bootedLimits: {
      memoryLimit: config.memoryLimit,
      cpuQuota: config.cpuQuota,
      pidsLimit: config.pidsLimit,
    },
    resourceLimits: (config.dockerAccess) ? {
      memory: config.memoryLimit,
      cpuQuota: config.cpuQuota,
      pidsLimit: config.pidsLimit,
    } : undefined,
    // docs/183 dep-dir design — recorded so destroyContainer can `docker volume
    // rm` each per-session overlay volume on teardown (and the failure path below).
    overlayVolumeNames: config.overlaySpecs?.map((s) => s.volumeName),
  };
  deps.containers.set(config.sessionId, sc);

  const shortId = config.sessionId.slice(0, 12);

  try {
    // docs/183 dep-dir design — create each per-session `local` `type=overlay`
    // volume (serialized inside createOverlayVolume to dodge the overlay2 EBUSY
    // hazard) right before the container references them; the daemon performs the
    // `mount -t overlay` as it builds the container. Kept INSIDE the try so any
    // later failure removes them via the catch below (`sc.overlayVolumeNames`).
    //
    // The daemon's mount fails with ENOENT unless lowerdir, upperdir AND workdir
    // all exist — and nothing else creates them: a cold scope has no published
    // base yet (no `overlay-base/<hash>/`; an empty lowerdir is a valid cold
    // start), and the per-session upper/work dirs are born here. The spec's own
    // paths are daemon-host paths the orchestrator container cannot reach, so we
    // mkdir the orchestrator-visible twins (`orchDirs`, same volume via stateDir).
    if (config.overlaySpecs) {
      for (const spec of config.overlaySpecs) {
        if (spec.orchDirs) {
          fs.mkdirSync(spec.orchDirs.lowerdir, { recursive: true });
          fs.mkdirSync(spec.orchDirs.upperdir, { recursive: true });
          fs.mkdirSync(spec.orchDirs.workdir, { recursive: true });
        }
        await createOverlayVolume(deps.docker, spec, deps.baseLabels());
      }
    }

    // Remove any leftover container with the same name (e.g. from a crash)
    await removeStaleContainer(deps.docker, `agent-${shortId}`);

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

    // Assign the container ID BEFORE start() so the health monitor's
    // stale-incarnation guard (`containerId !== sc.id`) is armed as early
    // as possible. If the new container dies before we'd otherwise reach
    // the `sc.id = …` below, a `die` event arriving with this ID is
    // correctly attributed instead of being mistaken for a stale event.
    sc.id = container.id;

    await container.start();

    // Get the container's IP on the bridge network
    const info = await container.inspect();
    const networks = info.NetworkSettings.Networks;
    const networkInfo = networks[deps.networkName];
    if (!networkInfo?.IPAddress) {
      throw new Error(`Container has no IP on network ${deps.networkName}`);
    }

    sc.containerIp = networkInfo.IPAddress;
    sc.workerUrl = `http://${sc.containerIp}:${deps.workerPort}`;

    // Wait for the worker process to be healthy before declaring the container ready.
    if (!deps.skipHealthCheck) {
      await waitForWorkerHealth(sc.workerUrl);
    }
    sc.status = "running";

    // docs/183 — base-hit marker pre-stamp: if every overlay dep dir mounts a
    // base whose pointer matches this clone's HEAD (+ commands + worker runtime
    // key, generation re-verified), write `.shipit/.install-done` so the
    // worker's /install gate skips and "main unchanged" pays ~0 instead of a
    // full install over the populated base. Runs AFTER container start (the
    // lowerdir is pinned, so the generation check is race-correct) and before
    // the caller resolves the runner's worker URL (so /install can't race the
    // write). Best-effort: any failure just means a real install runs.
    if (config.overlaySpecs && config.overlaySpecs.length > 0 && deps.stateDir && config.workspaceDir) {
      try {
        const stamped = await preStampInstallMarker({
          stateDir: deps.stateDir,
          workspaceDir: config.workspaceDir,
          specs: config.overlaySpecs,
        });
        if (stamped) {
          console.log(`[overlay:${config.sessionId}] pre-stamped install marker from base pointer (base-hit)`);
        }
      } catch (err) {
        console.warn(
          `[overlay:${config.sessionId}] marker pre-stamp failed (continuing with a real install):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

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
    // docs/183 dep-dir design — drop every per-session overlay volume we created
    // above so a failed create doesn't leak them. The disk-janitor orphan-volume
    // sweep is the backstop, but reclaim eagerly here.
    if (sc.overlayVolumeNames) {
      for (const name of sc.overlayVolumeNames) {
        await removeOverlayVolume(deps.docker, name);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Remove stale container by name (handles 409 conflicts on create)
// ---------------------------------------------------------------------------

async function removeStaleContainer(
  docker: Docker,
  name: string,
): Promise<void> {
  try {
    const existing = docker.getContainer(name);
    await existing.inspect(); // throws if not found
    try { await existing.stop({ t: 2 }); } catch { /* may not be running */ }
    await existing.remove({ force: true });
  } catch {
    // Container doesn't exist — nothing to clean up
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
        const code = err && typeof err === "object" && "statusCode" in err ? (err as { statusCode: number }).statusCode : 0;
        // 304 = container already stopped, 409 = removal already in progress — safe to ignore
        if (code !== 304 && code !== 409) {
          console.warn(`[containers] Failed to clean up child container ${ci.Id.slice(0, 12)} for session ${sessionId}:`, err);
        }
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
  // Diagnostic: emit a stack trace at every destroy entry. Field reports
  // show session containers receiving SIGTERM with exit 0 (consistent
  // with `container.stop({t:5})` below) without any of the known
  // dispose-path log prefixes appearing — meaning either an unidentified
  // code path is calling this OR something external is reaching into the
  // Docker daemon. The stack trace tells us which.
  // TODO(observability): remove or downgrade to debug once the field
  // report from docs/124-session-rescue-and-diagnostics follow-up is
  // resolved.
  const stack = new Error("destroyContainer caller trace").stack;
  console.warn(`[container] destroyContainer(${sessionId}) called from:\n${stack}`);

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

  // docs/183 dep-dir design — drop every per-session overlay volume after the
  // container is gone. The daemon unmounts each overlay on container stop, so this
  // is a plain `docker volume rm` with no manual unmount-ordering. The shared
  // read-only bases (lowerdirs) live in their own `overlay-base/<hash>/` subtrees
  // and are NOT touched.
  if (sc.overlayVolumeNames) {
    for (const name of sc.overlayVolumeNames) {
      await removeOverlayVolume(deps.docker, name);
    }
  }

  sc.status = "stopped";
  deps.containers.delete(sessionId);
  deps.emitter.emit("container_destroyed", sessionId);
}

// ---------------------------------------------------------------------------
// Build config
// ---------------------------------------------------------------------------

export function buildContainerConfig(
  deps: Pick<LifecycleDeps, "imageName" | "defaultMemoryLimit" | "defaultCpuQuota" | "defaultPidsLimit">,
  opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir?: string;
    credentialsDir: string;
    depCacheDir?: string;
    /** docs/197 Part 2 — shared per-runtime pnpm store host dir; absent for non-pnpm / flag-off sessions. */
    pnpmStoreDir?: string;
    uploadsDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
    /** docs/128 — privileged ops session (read-only Docker proxy + journal mounts). */
    opsSession?: boolean;
    /** docs/128 — allow-listed read-only host mounts; applied only when opsSession. */
    hostMounts?: HostMount[];
    /** docs/183 dep-dir design — one overlay spec per declared dep dir; absent for non-overlay sessions. */
    overlaySpecs?: DepDirOverlaySpec[];
  },
): ContainerConfig {
  return {
    sessionId: opts.sessionId,
    sessionDir: opts.sessionDir,
    workspaceDir: opts.workspaceDir,
    credentialsDir: opts.credentialsDir,
    depCacheDir: opts.depCacheDir,
    pnpmStoreDir: opts.pnpmStoreDir,
    uploadsDir: opts.uploadsDir ?? path.join(opts.sessionDir, "uploads"),
    imageName: deps.imageName,
    memoryLimit: opts.memoryLimit ?? deps.defaultMemoryLimit,
    cpuQuota: opts.cpuQuota ?? deps.defaultCpuQuota,
    pidsLimit: opts.pidsLimit ?? deps.defaultPidsLimit,
    env: opts.env,
    // docs/128 — an ops session must NEVER get the read-write session
    // docker-proxy (it reaches Docker only through the read-only
    // docker-socket-proxy sibling). The agent's `dockerAccess` is derived from
    // `compose.docker-socket: true`, which the ops template sets so the proxy
    // *service* can mount the socket — but that flag must not also elevate the
    // *agent*. Force it off here so the read-write proxy and its session
    // network are never created, and `buildEnv` routes DOCKER_HOST to the
    // read-only proxy.
    dockerAccess: opts.opsSession ? false : opts.dockerAccess,
    opsSession: opts.opsSession,
    hostMounts: opts.opsSession ? opts.hostMounts : undefined,
    overlaySpecs: opts.overlaySpecs,
  };
}
