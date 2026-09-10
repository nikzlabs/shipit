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
  CONTAINER_BUILD_ID_LABEL,
  CONTAINER_SESSION_ID_LABEL,
} from "./session-container.js";
import {
  CONTAINER_PLUGIN_STORE_DIR,
  CONTAINER_WORKSPACE_DIR,
  DEP_CACHE_CONTAINER_PATH,
} from "../shared/fs-constants.js";
import { pluginsRoot } from "./plugin-generations.js";
import {
  CONTAINER_SESSION_STATE_DIR,
  INSTALL_MARKER_FILE,
  sessionStateDirForWorkspace,
  sessionSharedStateDir,
} from "./session-state-dir.js";
import { agentHome } from "../shared/agent-home.js";
import type { HostMount } from "../shared/shipit-config.js";
import { DEFAULT_DEP_DIRS, resolveShipitConfig } from "../shared/shipit-config.js";
import {
  ensureSessionCredentialsScaffold,
  perSessionCredentialsDir,
  perSessionCredentialsSubpath,
  sweepSubAgentSpawnHomes,
} from "./session-credentials.js";
import { assertOverlayVolumesMatch, createOverlayVolume, removeOverlayVolume } from "./overlay-volume.js";
import {
  preStampInstallMarker,
  sortOverlayDepDirs,
  supersededSessionOverlayLayers,
  type DepDirOverlaySpec,
} from "./overlay-session.js";
import {
  chownToSessionWorker,
  handWorkspaceBackToWorker,
  reconcileDepDirCacheOwnership,
  sessionWorkerGid,
  shareTreeOnce,
  identityForTarget,
} from "./session-worker-uid.js";
import { buildTierAEgressInputs, installEgressFirewall } from "./egress-firewall-install.js";
import {
  buildResolverConfigB64,
  launchEgressResolver,
  sessionInternalNames,
  orchestratorCallbackHost,
  OPS_DOCKER_PROXY_DNS_NAME,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import {
  buildProxyAllowed,
  launchEgressProxy,
  EGRESS_PROXY_UID,
  EGRESS_PROXY_PORT,
  EGRESS_PROXY_LABEL,
} from "./egress-proxy-install.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { readonlyRootfsTmpfs } from "./container-hardening.js";
import { generateWorkerToken, setWorkerAuthToken, clearWorkerAuthToken } from "./worker-auth.js";
import { clearEgressDecisionTokens } from "./egress-decision-auth.js";
import { WORKER_TOKEN_ENV } from "../shared/worker-auth.js";

const DEFAULT_CPU_PERIOD = 100_000;

export const OPS_DOCKER_HOST = `tcp://${OPS_DOCKER_PROXY_DNS_NAME}:2375`;

/** Concurrent teardown cancelled creation; callers must not retry. */
export class ContainerCreateCancelledError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, at: string) {
    super(`Container creation for ${sessionId} was cancelled by a concurrent teardown (at: ${at})`);
    this.name = "ContainerCreateCancelledError";
    this.sessionId = sessionId;
  }
}

export interface CreateContainerOpts {
  /** Capture before preflight awaits so a teardown during preflight cancels creation. */
  intentEpoch?: number;
}

export interface LifecycleDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  destroyEpochs: Map<string, number>;
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
  egressEnforce?: boolean;
  egressSidecarImage?: string;
  egressDns?: boolean;
  egressProxy?: boolean;
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
  reopenJoinedEgress?: (sessionId: string) => Promise<void>;
  kernelRuntime?: string;
  seccompSecurityOpt?: string;
  readonlyRootfs?: boolean;
  stateDir?: string;
  emitter: EventEmitter<SessionContainerManagerEvents>;
  baseLabels: () => Record<string, string>;
}

interface MountSpec {
  binds: string[];
  mounts: {
    Type: "bind" | "volume"; Source: string; Target: string; ReadOnly?: boolean;
    BindOptions?: { Propagation?: string; CreateMountpoint?: boolean };
    VolumeOptions?: { Subpath?: string };
  }[];
  workspaceDir: string;
}

export { DEP_CACHE_CONTAINER_PATH };

export const PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright-browsers";

export const ANDROID_SDK_ROOT = "/opt/android-sdk";
export const JAVA_HOME = "/opt/java";

// Match pnpm 11's automatic relocation path; keep the store on the workspace filesystem for hardlinks.
export const PNPM_STORE_CONTAINER_PATH = "/workspace/.pnpm-store";

/** Verify shared-store ownership before mounting; the worker cannot repair a failed handoff. */
export function ensurePnpmStoreDir(storeDir: string): boolean {
  try {
    fs.mkdirSync(storeDir, { recursive: true });
  } catch (err) {
    console.warn(`[containers] pnpm store mkdir failed for ${storeDir}:`, err);
    return false;
  }
  const gid = sessionWorkerGid();
  if (gid === null) return true;
  // Share contents once per GID; the entrypoint excludes this nested mount from its chown walk.
  shareTreeOnce(storeDir);
  try {
    return fs.lstatSync(storeDir).gid === gid;
  } catch (err) {
    console.warn(`[containers] pnpm store ownership check failed for ${storeDir}:`, err);
    return false;
  }
}

export function buildMounts(
  config: ContainerConfig,
  workspaceVolume: string | undefined,
  credentialsVolume: string | undefined,
  overlayDepSpecs?: DepDirOverlaySpec[],
): MountSpec {
  const binds: string[] = [];
  const mounts: MountSpec["mounts"] = [];
  const workspaceDir = CONTAINER_WORKSPACE_DIR;
  const hostWorkspaceDir = config.workspaceDir;

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

  // Mount only this session's credential subtree; the shared root contains other agents' credentials.
  if (credentialsVolume) {
    mounts.push({
      Type: "volume",
      Source: credentialsVolume,
      Target: "/credentials",
      VolumeOptions: { Subpath: perSessionCredentialsSubpath(config.sessionId) },
    });
  } else {
    binds.push(`${perSessionCredentialsDir(config.credentialsDir, config.sessionId)}:/credentials:rw`);
  }

  if (config.uploadsDir) {
    if (workspaceVolume) {
      const uploadsRelPath = config.uploadsDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: "/uploads",
        ReadOnly: true,
        VolumeOptions: { Subpath: uploadsRelPath },
      });
    } else {
      binds.push(`${config.uploadsDir}:/uploads:ro`);
    }
  }

  if (config.scratchDir) {
    if (workspaceVolume) {
      const scratchRelPath = config.scratchDir.replace(/^\/workspace\//, "");
      mounts.push({
        Type: "volume",
        Source: workspaceVolume,
        Target: "/persist",
        ReadOnly: false,
        VolumeOptions: { Subpath: scratchRelPath },
      });
    } else {
      binds.push(`${config.scratchDir}:/persist:rw`);
    }
  }

  if (workspaceVolume) {
    const stateRelPath = sessionSharedStateDir(config.sessionStateDir).replace(/^\/workspace\//, "");
    mounts.push({
      Type: "volume",
      Source: workspaceVolume,
      Target: CONTAINER_SESSION_STATE_DIR,
      ReadOnly: false,
      VolumeOptions: { Subpath: stateRelPath },
    });
  } else {
    binds.push(`${sessionSharedStateDir(config.sessionStateDir)}:${CONTAINER_SESSION_STATE_DIR}:rw`);
  }

  // Mount the root so generation symlinks resolve on each access; direct binds would pin a generation.
  const hostPluginsRoot = pluginsRoot(config.sessionStateDir);
  if (workspaceVolume) {
    mounts.push({
      Type: "volume",
      Source: workspaceVolume,
      Target: CONTAINER_PLUGIN_STORE_DIR,
      ReadOnly: true,
      VolumeOptions: { Subpath: hostPluginsRoot.replace(/^\/workspace\//, "") },
    });
  } else {
    binds.push(`${hostPluginsRoot}:${CONTAINER_PLUGIN_STORE_DIR}:ro`);
  }

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

  if (config.opsSession && config.hostMounts) {
    for (const m of config.hostMounts) {
      // Only the daemon can check host paths; do not create missing sources that would hide configuration errors.
      mounts.push({
        Type: "bind",
        Source: m.source,
        Target: m.target,
        ReadOnly: true,
        BindOptions: { CreateMountpoint: false },
      });
    }
  }

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
  const home = agentHome();
  const env: string[] = [
    `SESSION_ID=${config.sessionId}`,
    `WORKSPACE_DIR=${workspaceDir}`,
    `SHIPIT_SESSION_STATE_DIR=${CONTAINER_SESSION_STATE_DIR}`,
    `WORKER_PORT=${workerPort}`,
    "WORKER_MODE=session",
    `HOME=${home}`,
    `AGENT_HOME=${home}`,
    `PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}`,
    `ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}`,
    `ANDROID_HOME=${ANDROID_SDK_ROOT}`,
    `JAVA_HOME=${JAVA_HOME}`,
    "GIT_CONFIG_GLOBAL=/credentials/.gitconfig",
  ];

  if (procEnv.SHIPIT_SESSION_WORKER_UID) {
    const identity = identityForTarget(config.workspaceDir);
    const uid = identity?.uid ?? procEnv.SHIPIT_SESSION_WORKER_UID;
    const gid = identity?.gid ?? procEnv.SHIPIT_SESSION_WORKER_UID;
    env.push(`SHIPIT_SESSION_WORKER_UID=${uid}`);
    env.push(`SHIPIT_SESSION_WORKER_GID=${gid}`);
    // Let the entrypoint exclude dep dirs from chown: even an unchanged UID causes overlay copy-up.
    let depDirs: string[];
    try {
      depDirs = resolveShipitConfig(config.workspaceDir).agent.depDirs;
    } catch {
      depDirs = [...DEFAULT_DEP_DIRS];
    }
    if (depDirs.length > 0) {
      env.push(`SHIPIT_DEP_DIRS=${depDirs.join(":")}`);
    }
  }

  const workerImageId = procEnv.SESSION_WORKER_IMAGE_ID ?? procEnv.IMAGE_DIGEST;
  if (workerImageId) {
    env.push(`SESSION_WORKER_IMAGE_ID=${workerImageId}`);
  }

  if (procEnv.BASE_IMAGE_DIGEST) {
    env.push(`BASE_IMAGE_DIGEST=${procEnv.BASE_IMAGE_DIGEST}`);
  }

  if (config.depCacheDir) {
    env.push(`npm_config_cache=${DEP_CACHE_CONTAINER_PATH}/npm`);
    env.push(`YARN_CACHE_FOLDER=${DEP_CACHE_CONTAINER_PATH}/yarn`);
    env.push(`PNPM_STORE_DIR=${DEP_CACHE_CONTAINER_PATH}/pnpm`);
  }

  if (config.pnpmStoreDir) {
    env.push(`npm_config_store_dir=${PNPM_STORE_CONTAINER_PATH}`);
  }
  // Ops must select the read-only proxy even if dockerAccess is also true.
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
  const orchestratorHost = orchestratorCallbackHost();
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

export function prepareOverlayDirs(
  specs: DepDirOverlaySpec[] | undefined,
  opts: { workspaceDir?: string; sessionId?: string } = {},
): void {
  if (!specs) return;
  const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
  const superseded = specs.flatMap((spec) =>
    spec.orchDirs
      ? supersededSessionOverlayLayers(spec.orchDirs.sessionScopeDir, spec.generation)
      : [],
  );
  if (superseded.length > 0) {
    // Invalidate before deleting layers; a populated new base can hide the loss of session-specific deps.
    if (opts.workspaceDir) removeInstallMarkerForRotation(opts.workspaceDir);
    for (const dir of superseded) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `${tag} could not reap superseded session upper ${dir}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const markerNote = opts.workspaceDir
      ? " and dropped the install marker so agent.install re-validates over the new base"
      : "";
    console.log(
      `${tag} base generation rotated — reset ${superseded.length} superseded upper layer(s)${markerNote}`,
    );
  }
  for (const spec of specs) {
    if (!spec.orchDirs) continue;
    fs.mkdirSync(spec.orchDirs.lowerdir, { recursive: true });
    fs.mkdirSync(spec.orchDirs.upperdir, { recursive: true });
    fs.mkdirSync(spec.orchDirs.workdir, { recursive: true });
    // Copy-up preserves ownership and mode. Repair old bases once, with the marker outside the mounted tree.
    shareTreeOnce(spec.orchDirs.lowerdir, { beside: true });
    chownToSessionWorker(path.dirname(spec.orchDirs.upperdir));
    chownToSessionWorker(spec.orchDirs.upperdir);
    chownToSessionWorker(spec.orchDirs.workdir);
    // The upper directory sets the merged root's mode; new directories must allow Compose cache writes.
    reconcileDepDirCacheOwnership(spec.orchDirs.upperdir);
  }
}

function removeInstallMarkerForRotation(workspaceDir: string): void {
  try {
    const markerFile = path.join(
      sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)),
      INSTALL_MARKER_FILE,
    );
    fs.rmSync(markerFile, { force: true });
  } catch (err) {
    console.warn(
      "[overlay] could not drop the install marker after a base-generation rotation:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function selfHealWorkspaceOwnership(
  config: Pick<ContainerConfig, "workspaceDir" | "overlaySpecs">,
  workspaceVolume: string | undefined,
  handBack: (workspaceDir: string) => void = handWorkspaceBackToWorker,
  reconcileDepDir: (depDirPath: string) => void = reconcileDepDirCacheOwnership,
): void {
  // Dev/dogfood bind mount — never chown the host source tree.
  if (!workspaceVolume) return;
  const workspaceDir = config.workspaceDir;
  handBack(workspaceDir);

  // The worktree handback excludes dep dirs; repair their caches separately.
  const overlaySpecs = config.overlaySpecs;
  if (overlaySpecs && overlaySpecs.length > 0) {
    for (const spec of overlaySpecs) {
      if (spec.orchDirs) reconcileDepDir(spec.orchDirs.upperdir);
    }
  } else {
    let depDirs: string[];
    try {
      depDirs = resolveShipitConfig(workspaceDir).agent.depDirs;
    } catch {
      depDirs = [...DEFAULT_DEP_DIRS];
    }
    for (const depDir of depDirs) {
      reconcileDepDir(path.join(workspaceDir, depDir));
    }
  }
}

export async function createContainer(
  deps: LifecycleDeps,
  config: ContainerConfig,
  opts?: CreateContainerOpts,
): Promise<SessionContainer> {
  if (deps.containers.has(config.sessionId)) {
    throw new Error(`Container already exists for session ${config.sessionId}`);
  }

  const epochAtStart = opts?.intentEpoch ?? deps.destroyEpochs.get(config.sessionId) ?? 0;
  const abortIfTornDown = (at: string): void => {
    if ((deps.destroyEpochs.get(config.sessionId) ?? 0) !== epochAtStart) {
      throw new ContainerCreateCancelledError(config.sessionId, at);
    }
  };

  if (config.uploadsDir) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
  }

  if (config.scratchDir) {
    fs.mkdirSync(config.scratchDir, { recursive: true });
  }

  fs.mkdirSync(config.sessionStateDir, { recursive: true });
  fs.mkdirSync(sessionSharedStateDir(config.sessionStateDir), { recursive: true });

  if (config.depCacheDir) {
    fs.mkdirSync(config.depCacheDir, { recursive: true });
  }

  if (config.pnpmStoreDir && !ensurePnpmStoreDir(config.pnpmStoreDir)) {
    console.warn(
      `[containers] could not hand pnpm store ${config.pnpmStoreDir} to the session-worker uid; ` +
        `skipping the shared-store mount for ${config.sessionId} — pnpm will use its own ` +
        `per-session store (slower, still correct)`,
    );
    config = { ...config, pnpmStoreDir: undefined };
  }

  try {
    ensureSessionCredentialsScaffold(config.credentialsDir, config.sessionId);
    // No worker is running yet. Release orphaned homes while preserving rotated credentials.
    sweepSubAgentSpawnHomes(config.credentialsDir, config.sessionId);
  } catch (err) {
    console.warn(
      `[containers] credentials scaffold failed for ${config.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    fs.mkdirSync(pluginsRoot(config.sessionStateDir), { recursive: true });
  } catch (err) {
    console.warn(
      `[containers] plugin root scaffold failed for ${config.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

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

  if (!deps.workspaceVolume) {
    env.push("SHIPIT_SKIP_WORKSPACE_CHOWN=1");
  }

  if (deps.readonlyRootfs) {
    env.push("SHIPIT_READONLY_HOME=1");
  }

  env.push(...await buildOrchestratorCallbackEnv(config.sessionId));

  const workerToken = generateWorkerToken();
  env.push(`${WORKER_TOKEN_ENV}=${workerToken}`);

  const imageName = ((config.dockerAccess || config.opsSession) && deps.dockerImageName)
    ? deps.dockerImageName
    : config.imageName;

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
    workerToken,
    status: "starting",
    hostWorkspaceDir: config.sessionDir,
    dockerAccess: config.dockerAccess ?? false,
    opsSession: config.opsSession ?? false,
    sessionNetworkName,
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
    overlayVolumeNames: config.overlaySpecs?.map((s) => s.volumeName),
    // Match adoption order to avoid changing Compose override bytes and recreating services.
    overlayDepDirs: config.overlaySpecs
      && sortOverlayDepDirs(config.overlaySpecs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName }))),
  };
  deps.containers.set(config.sessionId, sc);

  const shortId = config.sessionId.slice(0, 12);

  let signalEgressFirewallReady: () => void = () => {};

  try {
    selfHealWorkspaceOwnership(config, deps.workspaceVolume);

    if (config.overlaySpecs) {
      prepareOverlayDirs(config.overlaySpecs, {
        workspaceDir: config.workspaceDir,
        sessionId: config.sessionId,
      });
      // Release Compose holders so volumes can be recreated with the new generation's paths.
      for (const spec of config.overlaySpecs) {
        const { releasedHolders } = await createOverlayVolume(
          deps.docker,
          spec,
          deps.baseLabels(),
          { releaseHolders: true, sessionId: config.sessionId },
        );
        // Force Compose reconciliation even when the dep-dir set is unchanged.
        if (releasedHolders.length > 0) sc.overlayVolumesRecreated = true;
      }
    }

    await removeStaleContainer(deps.docker, `agent-${shortId}`);

    abortIfTornDown("before createContainer");

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
        // Node cannot reap orphaned grandchildren; docker-init prevents PID exhaustion.
        Init: true,
        // Allow loopback SNI redirects here; the installer sidecar cannot write /proc/sys.
        Sysctls: deps.egressProxy ? { "net.ipv4.conf.all.route_localnet": "1" } : undefined,
        Runtime: deps.kernelRuntime,
        SecurityOpt: deps.seccompSecurityOpt
          ? ["no-new-privileges", deps.seccompSecurityOpt]
          : ["no-new-privileges"],
        ReadonlyRootfs: deps.readonlyRootfs ?? false,
        Tmpfs: deps.readonlyRootfs ? readonlyRootfsTmpfs() : undefined,
        CapDrop: ["ALL"],
        // The root entrypoint needs ownership and identity capabilities before dropping privileges.
        CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "KILL"],
      },
      Env: env,
    });

    // Publish before start so the health monitor can identify an immediate exit.
    sc.id = container.id;

    // Recheck after container creation: Docker silently replaces a missing overlay volume with a plain volume.
    if (config.overlaySpecs && config.overlaySpecs.length > 0) {
      await assertOverlayVolumesMatch(deps.docker, config.overlaySpecs, {
        sessionId: config.sessionId,
      });
    }

    abortIfTornDown("before container start");

    await container.start();

    const info = await container.inspect();
    sc.workerBuildId = info.Config?.Labels?.[CONTAINER_BUILD_ID_LABEL] || undefined;
    const networks = info.NetworkSettings.Networks;
    const networkInfo = networks[deps.networkName];
    if (!networkInfo?.IPAddress) {
      throw new Error(`Container has no IP on network ${deps.networkName}`);
    }

    sc.containerIp = networkInfo.IPAddress;
    sc.workerUrl = `http://${sc.containerIp}:${deps.workerPort}`;
    setWorkerAuthToken(sc.workerUrl, sc.workerToken);

    const egressCfg = deps.resolveEgressConfig?.(config.sessionId) ?? { contained: true, extraHosts: [] };
    sc.egressContainedAtStart = egressCfg.contained;
    // Network joins must append ACCEPT rules after the installer's OUTPUT flush. Resolve on failure too.
    sc.egressFirewallReady = new Promise<void>((resolve) => {
      signalEgressFirewallReady = resolve;
    });
    if (deps.egressEnforce && egressCfg.contained) {
      if (!deps.egressSidecarImage) {
        throw new Error(
          "Agent egress containment is on but cannot be enforced: SESSION_EGRESS_SIDECAR_IMAGE is not set. " +
            "Provide/build the egress sidecar image (deploy.sh / dev.sh build it), or disable containment " +
            "with SESSION_EGRESS_ENFORCE=0 if this host can't run the NET_ADMIN sidecar.",
        );
      }
      const egressLabels = { ...deps.baseLabels(), "shipit-parent-session": config.sessionId };
      const inputs = await buildTierAEgressInputs();
      await installEgressFirewall(deps.docker, {
        agentContainerId: container.id,
        sidecarImage: deps.egressSidecarImage,
        inputs,
        resolverUid: deps.egressDns ? EGRESS_RESOLVER_UID : undefined,
        proxyUid: deps.egressProxy ? EGRESS_PROXY_UID : undefined,
        proxyPort: deps.egressProxy ? EGRESS_PROXY_PORT : undefined,
        labels: egressLabels,
      });
      if (deps.egressDns) {
        const configB64 = buildResolverConfigB64({
          internalDomains: sessionInternalNames({ opsSession: config.opsSession }),
          extraDomains: egressCfg.extraHosts,
          ...(egressCfg.base ? { base: egressCfg.base } : {}),
        });
        await launchEgressResolver(deps.docker, {
          agentContainerId: container.id,
          sidecarImage: deps.egressSidecarImage,
          configB64,
          labels: { ...egressLabels, [EGRESS_RESOLVER_LABEL]: config.sessionId, "shipit-egress-parent": container.id },
        });
      }
      if (deps.egressProxy) {
        const orchPort = process.env.PORT || "3000";
        const decisionUrl = `http://${orchestratorCallbackHost()}:${orchPort}/api/egress/decision`;
        await launchEgressProxy(deps.docker, {
          agentContainerId: container.id,
          sidecarImage: deps.egressSidecarImage,
          allowed: buildProxyAllowed({ extraHosts: egressCfg.extraHosts, ...(egressCfg.base ? { base: egressCfg.base } : {}) }),
          sessionId: config.sessionId,
          decisionUrl,
          ...(egressCfg.identityRules ? { identityRules: egressCfg.identityRules } : {}),
          labels: { ...egressLabels, [EGRESS_PROXY_LABEL]: config.sessionId, "shipit-egress-parent": container.id },
        });
      }
      const dnsNote = deps.egressDns ? " + Tier B controlled resolver" : "";
      const proxyNote = deps.egressProxy ? " + Tier C SNI proxy" : "";
      console.log(
        `[egress:${config.sessionId}] Tier A firewall installed ` +
          `(${inputs.hosts.length} hosts, ${inputs.cidrs.length} CIDRs)${dnsNote}${proxyNote}`,
      );
      signalEgressFirewallReady();
      await deps.reopenJoinedEgress?.(config.sessionId);
    }
    signalEgressFirewallReady();

    abortIfTornDown("before the worker health wait");

    if (!deps.skipHealthCheck) {
      await waitForWorkerHealth(sc.workerUrl);
    }
    sc.status = "running";

    // Stamp after start pins the lower layer, but before returning lets the worker run install.
    if (config.overlaySpecs && config.overlaySpecs.length > 0 && deps.stateDir) {
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

    abortIfTornDown("before returning a ready container");

    deps.emitter.emit("container_started", config.sessionId);
    return sc;
  } catch (err) {
    // A replacement may already own the session's resources and reused IP. Remove only our container in that case.
    const existing = deps.containers.get(config.sessionId);
    const supersededByNewer = existing !== undefined && existing !== sc;
    if (existing === sc) {
      deps.containers.delete(config.sessionId);
    }
    if (!supersededByNewer) clearWorkerAuthToken(sc.workerUrl);
    signalEgressFirewallReady();
    if (sc.id) {
      try {
        const c = deps.docker.getContainer(sc.id);
        try { await c.stop({ t: 2 }); } catch { /* may not be running */ }
      } catch {
        // Container reference invalid
      }
    }
    if (!supersededByNewer) {
      try {
        await cleanupSessionDockerResources(deps.docker, config.sessionId);
      } catch {
        /* best-effort; disk-janitor is the backstop */
      }
    }
    if (sc.id) {
      try {
        const c = deps.docker.getContainer(sc.id);
        try { await c.remove({ force: true }); } catch { /* may already be gone */ }
      } catch {
        // Container reference invalid
      }
    }
    // Remove all requested volume names after the container, including plain volumes Docker substituted.
    if (sc.overlayVolumeNames && !supersededByNewer) {
      for (const name of sc.overlayVolumeNames) {
        await removeOverlayVolume(deps.docker, name);
      }
    }
    throw err;
  }
}

async function removeStaleContainer(
  docker: Docker,
  name: string,
): Promise<void> {
  try {
    const existing = docker.getContainer(name);
    await existing.inspect();
    try { await existing.stop({ t: 2 }); } catch { /* may not be running */ }
    await existing.remove({ force: true });
  } catch {
    // Best-effort stale-container cleanup.
  }
}

export async function cleanupSessionDockerResources(
  docker: Docker,
  sessionId: string,
): Promise<void> {
  const parentLabel = `shipit-parent-session=${sessionId}`;

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
        if (code !== 304 && code !== 409 && code !== 404) {
          console.warn(`[containers] Failed to clean up child container ${ci.Id.slice(0, 12)} for session ${sessionId}:`, err);
        }
      }
    }
  } catch {
    // Docker may not be available
  }

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

export async function destroyContainer(
  deps: LifecycleDeps,
  sessionId: string,
  opts: { preserveChildResources?: boolean; replacementFollows?: boolean } = {},
): Promise<void> {
  const stack = new Error("destroyContainer caller trace").stack;
  console.warn(`[container] destroyContainer(${sessionId}) called from:\n${stack}`);

  // Cancel creation before the missing-record guard: preflight may not have published a record yet.
  deps.destroyEpochs.set(sessionId, (deps.destroyEpochs.get(sessionId) ?? 0) + 1);

  deps.standbySessionIds.delete(sessionId);
  const sc = deps.containers.get(sessionId);
  if (!sc) return;

  sc.status = "stopping";
  clearWorkerAuthToken(sc.workerUrl);
  clearEgressDecisionTokens(sessionId);

  if (!sc.id) {
    console.warn(
      `[containers] destroy(${sessionId}) reached a container still being created `
      + "(no id yet) — skipping the agent-container stop/remove; the creation has "
      + "been cancelled and cleans up after itself.",
    );
  }

  // Stop the agent before removing children so it cannot create more resources.
  if (sc.id) {
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
  }

  if (!opts.preserveChildResources) {
    await cleanupSessionDockerResources(deps.docker, sessionId);
  }

  if (sc.id) {
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
  }

  if (sc.overlayVolumeNames) {
    for (const name of sc.overlayVolumeNames) {
      await removeOverlayVolume(deps.docker, name);
    }
  }

  sc.status = "stopped";
  deps.containers.delete(sessionId);
  // Keep preview documents through replacement; reporting them gone drops their iframe state.
  deps.emitter.emit(
    "container_destroyed",
    sessionId,
    !opts.preserveChildResources && !opts.replacementFollows,
  );
}

export function buildContainerConfig(
  deps: Pick<LifecycleDeps, "imageName" | "defaultMemoryLimit" | "defaultCpuQuota" | "defaultPidsLimit">,
  opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir: string;
    credentialsDir: string;
    depCacheDir?: string;
    pnpmStoreDir?: string;
    uploadsDir?: string;
    scratchDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
    opsSession?: boolean;
    hostMounts?: HostMount[];
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
    scratchDir: opts.scratchDir ?? path.join(opts.sessionDir, "scratch"),
    // Match the install-marker writer's derived path; an override would mount a different directory.
    sessionStateDir: sessionStateDirForWorkspace(opts.workspaceDir),
    imageName: deps.imageName,
    memoryLimit: opts.memoryLimit ?? deps.defaultMemoryLimit,
    cpuQuota: opts.cpuQuota ?? deps.defaultCpuQuota,
    pidsLimit: opts.pidsLimit ?? deps.defaultPidsLimit,
    env: opts.env,
    dockerAccess: opts.opsSession ? false : opts.dockerAccess,
    opsSession: opts.opsSession,
    hostMounts: opts.opsSession ? opts.hostMounts : undefined,
    overlaySpecs: opts.overlaySpecs,
  };
}
