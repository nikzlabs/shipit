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
 * Built from {@link OPS_DOCKER_PROXY_DNS_NAME} so the alias the agent dials and
 * the name the Tier B resolver allowlists (`sessionInternalNames`) stay in lockstep.
 */
export const OPS_DOCKER_HOST = `tcp://${OPS_DOCKER_PROXY_DNS_NAME}:2375`;

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
   * docs/172 Gap 1 (planning#92) — Tier A egress enforcement. When `egressEnforce` is
   * true, after the agent container starts a privileged installer sidecar is run
   * in its netns to apply the default-deny iptables/ipset firewall (using
   * `egressSidecarImage`). Both come from `SESSION_EGRESS_ENFORCE` /
   * `SESSION_EGRESS_SIDECAR_IMAGE`; absent/false → no-op (byte-for-byte unchanged).
   */
  egressEnforce?: boolean;
  egressSidecarImage?: string;
  /**
   * docs/172 Tier B (planning#92) — controlled DNS. When true (requires
   * `egressEnforce`), the agent's resolv.conf is pointed at an in-netns dnsmasq
   * resolver that forwards only allowlisted domains (closing DNS tunneling) and
   * pins resolved IPs into the egress ipset. From `SESSION_EGRESS_DNS=1`.
   */
  egressDns?: boolean;
  /**
   * docs/172 Tier C (planning#92) — transparent SNI proxy. When true (requires
   * `egressDns`), a long-lived SNI-peek proxy is launched in the agent's netns
   * and the installer REDIRECTs the agent's :443 to it for hostname-level HTTPS
   * policy (closing the CDN co-tenancy gap). From `SESSION_EGRESS_PROXY=1`.
   */
  egressProxy?: boolean;
  /**
   * docs/172 (planning#92) — per-session egress configuration resolved at container
   * start from the durable allowlist store + live MCP credential store. Lets the
   * browser global toggle / per-session override govern whether THIS session is
   * contained (so "Open mode" skips the firewall install entirely) and feeds the
   * composed extra-host allowlist into BOTH the Tier B resolver config and the
   * Tier C proxy allowlist. Omitted in tests / no-store runtimes → defaults to
   * `{ contained: true, extraHosts: [] }` (byte-for-byte the env-only behavior).
   */
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
  /**
   * docs/172 ordering fix — re-open the agent's egress to every session/compose
   * network it has already joined. Called at the end of the Tier-A firewall
   * install so a rebuild's `iptables -F OUTPUT` can never permanently strand an
   * already-joined subnet (idempotent; a no-op on first boot where nothing is
   * joined yet). Wired from `SessionContainerManager.reopenJoinedSessionEgress`.
   */
  reopenJoinedEgress?: (sessionId: string) => Promise<void>;
  /**
   * docs/172 Gap 5 (planning#99) — kernel-tier hardening, all env-gated default-OFF
   * (resolved in session-container.ts from `container-hardening.ts`). Omitted in
   * tests / when the operator hasn't opted in → byte-for-byte unchanged.
   *
   * - `runtime` — alternate OCI runtime for `HostConfig.Runtime` (e.g. `runsc`
   *   for gVisor) where the host registers it; undefined → Docker default `runc`.
   * - `seccompSecurityOpt` — the `seccomp=<json>` SecurityOpt entry from the
   *   committed profile; undefined → Docker's default seccomp profile applies.
   * - `readonlyRootfs` — when true, `ReadonlyRootfs: true` + the minimal tmpfs
   *   writable set; the persistent mounts (/workspace, /credentials, …) stay rw.
   */
  kernelRuntime?: string;
  seccompSecurityOpt?: string;
  readonlyRootfs?: boolean;
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

/**
 * Container-internal mount point for the shared dependency cache. Defined in
 * `shared/fs-constants.ts` (session code needs it too — docs/248) and
 * re-exported here for this module's existing importers.
 */
export { DEP_CACHE_CONTAINER_PATH };

/**
 * docs/150 §8 — stable, shared Playwright browser cache path. The session-worker
 * image installs the chrome-for-testing build here at build time (readable by
 * the unprivileged `shipit` runtime user) instead of under `$HOME/.cache`, which
 * would land in the build user's root home and be unreachable post-`gosu`.
 */
export const PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright-browsers";

/**
 * docs/213 — baked Android toolchain paths. The session-worker image installs
 * the Android SDK and a JDK at these locations (a stable /opt/java symlink keeps
 * JAVA_HOME arch-independent). Like PLAYWRIGHT_BROWSERS_PATH, they're set as ENV
 * in the image AND mirrored at the launch boundary (buildEnv) so they're explicit
 * even if the image ENV drifts. The toolchain is ambient — present in every
 * session — so any Android/Gradle repo builds with no per-repo configuration.
 */
export const ANDROID_SDK_ROOT = "/opt/android-sdk";
export const JAVA_HOME = "/opt/java";

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

/**
 * Create the shared pnpm store dir on the host and hand it to the session-worker
 * UID, before any container mounts it. Returns whether the store is safe to
 * mount — `false` means the caller must drop the mount (planning#2286).
 *
 * The chown is the load-bearing half. Every OTHER writable mount is handed over
 * by the entrypoint's chown loop (`docker/session-worker/entrypoint.sh`), which
 * stamps a `.shipit-uid-<uid>` sentinel into each one. The pnpm store is not in
 * that loop and cannot be: it is mounted NESTED at `/workspace/.pnpm-store`, so
 * it is only ever chowned as collateral of the `chown -R /workspace` walk — and
 * that walk is sentinel-gated on the WORKSPACE, whose sentinel is stamped on the
 * session's first boot. The walk does traverse the nested mount, so a store that
 * is already mounted at that first boot gets handed over; what the loop never
 * does is REVISIT the store once the workspace sentinel exists. A store dir
 * created after that boot — a container recreated post-idle, a runtime-key
 * rotation, a janitor sweep that reclaimed the previous store — is therefore
 * never walked, and stays `root:root` from this very `mkdirSync`. The agent runs
 * as `SHIPIT_SESSION_WORKER_UID` with no `sudo`, and the dir is a mount point it
 * can neither chown nor remove, so `pnpm install` dead-ends on
 * `EACCES: permission denied, mkdir '/workspace/.pnpm-store/…'` with no
 * in-session recovery.
 *
 * Chowning here instead makes the handoff unconditional — it runs on every
 * container create, so it also repairs a store left root-owned by an earlier
 * build. Two properties are deliberate:
 *
 *  - **Verified, not best-effort.** `chownToSessionWorker` logs and swallows a
 *    failure, which is right for the writers it was built for (a stale credential
 *    file is repaired by the next sync). Here the same swallow would reproduce
 *    the unrecoverable EACCES this function exists to prevent. So we re-`lstat`
 *    and report the truth, and the caller mounts nothing it could not hand over:
 *    pnpm then falls back to relocating its store into the workspace
 *    (`.pnpm-store`, already in the template gitignore) — per-session and slower,
 *    but working, which a root-owned mount is not.
 *  - **Marker-gated for the contents, not blanket-recursive.** This used to be
 *    flatly non-recursive, justified by "the next boot's `chown -R /workspace`
 *    walks the nested store and repairs the contents". docs/270 falsified that
 *    in the same breath as it needed it: `chown_workspace()` now `-prune`s
 *    `.pnpm-store`, so nothing walks the contents at all. That left an upgraded
 *    deployment with a store whose entries carry the OLD gid and `0755`/`0644`,
 *    which a session at an allocated uid can read and cannot add to — `pnpm`
 *    EACCESes writing into an existing fanout directory, and (with
 *    `protected_hardlinks=1`) cannot even link an existing store file into
 *    `node_modules`. `shareTreeOnce` walks it exactly once per gid and costs one
 *    `existsSync` on every create after that, which keeps the hot path the
 *    reason the walk was avoided in the first place.
 */
export function ensurePnpmStoreDir(storeDir: string): boolean {
  try {
    fs.mkdirSync(storeDir, { recursive: true });
  } catch (err) {
    console.warn(`[containers] pnpm store mkdir failed for ${storeDir}:`, err);
    return false;
  }
  const gid = sessionWorkerGid();
  if (gid === null) return true; // legacy root runtime — the worker owns everything
  // docs/270 — the store is shared per runtime across sessions, so it is handed
  // over by GROUP, not by owner. Chowning it to one session's uid would take it
  // from every other session, which is the failure this dir's own docstring
  // describes (an EACCES with no in-session recovery) arriving by a new route.
  // The verification below follows: the property that matters is now the group.
  //
  // `shareTreeOnce`, not `shareWithAllSessions`: the dir itself is not enough
  // when the store was POPULATED under a previous identity, and no other code
  // path walks its contents any more (see the docstring). The marker keeps that
  // walk to once per gid.
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
  // config.workspaceDir is the git repo directory (session.workspaceDir),
  // always `<sessionDir>/workspace`.
  const hostWorkspaceDir = config.workspaceDir;

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

  // Mount the uploads directory for user-uploaded files **read-only**
  // (docs/172 Gap 6 / planning#47). The agent has no legitimate write need under
  // /uploads — uploads are produced by the user from the browser, the agent
  // only consumes them — so a `:ro` mount removes the ability for a
  // prompt-injected agent to delete or tamper with the user's uploads. This is
  // the cheap structural read-only defense the containment threat model calls
  // for; it is independent of the whole-rootfs ReadonlyRootfs layer (Gap 5).
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

  // docs/217 — Mount the persistent scratch directory at /persist **read-write**.
  // Unlike /uploads (the user's files, :ro), this is the agent's OWN scratch: a
  // non-git tier that survives container teardown so presented artifacts (and any
  // keep-but-don't-commit files) don't vanish from the ephemeral /tmp on restart.
  // It's a sibling of workspace/, so the disk-reclaim paths (which rm workspace/
  // only) leave it intact — exactly right for this only-copy data. Worker-UID
  // ownership is handled by the entrypoint chown loop (see docs/217 §1a).
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

  // docs/246 — Mount ShipIt's own per-session state dir at /session-state
  // **read-write**. This is what keeps ShipIt's generated artifacts out of the
  // user's git clone: the install marker is written here by the worker after
  // `agent.install`, and the agent reads fetched CI logs from here during a CI
  // fix. Both used to live in `<clone>/.shipit/`, where the post-turn
  // `git add -A` staged them into the user's repository.
  //
  // Not everything in the state dir is exposed by this mount being present —
  // the compose override and `.env.agent` are orchestrator-only and simply
  // aren't read from inside the container. Worker-UID ownership comes from the
  // entrypoint chown loop, same as /persist.
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

  // docs/262 — the session's plugin root, mounted READ-ONLY. `/plugins/<name>`
  // symlinks resolve through it, so the agent can browse a plugin but cannot
  // edit one from the consuming session (req 7). There is deliberately NO
  // writable view of this at any path: an earlier revision added one so an
  // in-container install could write `node_modules`, which made the read-only
  // guarantee decorative. Plugin code that writes runs in its own container
  // against an overlay volume instead (plan §1b).
  //
  // Mounting each generation directly would have been simpler and wrong:
  // Docker resolves a bind source's symlinks at creation, which would pin
  // whichever generation was live when the session opened and leave refresh
  // (req 12) invisible until the container was recreated. Mounting the ROOT
  // keeps both hops — `<name>/active` → `generations/<sha>` — inside the
  // container, where they resolve per access.
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
  const home = agentHome();
  const env: string[] = [
    `SESSION_ID=${config.sessionId}`,
    `WORKSPACE_DIR=${workspaceDir}`,
    // docs/246 — where the worker writes the install marker: the mounted slice
    // of the session's state dir, never a path inside the clone. Every session
    // gets the mount (planning#288 removed the un-mountable flat layout), so this is
    // unconditional and the worker can rely on the directory existing.
    `SHIPIT_SESSION_STATE_DIR=${CONTAINER_SESSION_STATE_DIR}`,
    `WORKER_PORT=${workerPort}`,
    "WORKER_MODE=session",
    // docs/150 — the worker drops to the unprivileged `shipit` user whose home
    // is /home/shipit. AGENT_HOME is the single source of truth that the
    // worker, agent CLIs, and terminal resolve their HOME from (agentHome()).
    // In prod the orchestrator resolves this to /home/shipit; local mode keeps
    // AGENT_HOME=/root in the orchestrator container's own env, but buildEnv is
    // never reached there (no container).
    `HOME=${home}`,
    `AGENT_HOME=${home}`,
    // docs/150 §8 — the build-time Playwright browser install is pinned to a
    // shared path readable by both root (build) and `shipit` (runtime). The
    // image sets this ENV too; mirror it here so it's explicit at the launch
    // boundary and survives an image whose ENV drifts.
    `PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}`,
    // docs/213 — baked, ambient Android toolchain. Mirrored here like the
    // Playwright path so any Android/Gradle repo builds with no per-repo setup.
    // ANDROID_HOME is the legacy alias some tools still read; keep both.
    `ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}`,
    `ANDROID_HOME=${ANDROID_SDK_ROOT}`,
    `JAVA_HOME=${JAVA_HOME}`,
    // Point git inside the container at the same global config the orchestrator
    // uses. The credentials directory is mounted at /credentials, and the
    // orchestrator writes user.name/user.email there via initGlobalGitConfig().
    // This way, any git operation inside the container (agent bash, rebase --continue,
    // etc.) inherits the user's configured identity automatically.
    "GIT_CONFIG_GLOBAL=/credentials/.gitconfig",
  ];

  // docs/150 Rollout — forward the worker UID so the image's entrypoint chowns
  // the writable mounts to the SAME uid the orchestrator's chown helpers use. A
  // single env on the orchestrator flips both sides; unset = the entrypoint's
  // own default (1000) still applies in-image, and orchestrator-side chowns are
  // no-ops, preserving today's behavior.
  if (procEnv.SHIPIT_SESSION_WORKER_UID) {
    // docs/270 — the UID is now per-session and the GID is the shared one. The
    // identity is read from the session's own directory (the record the session
    // cannot write), so a session created before docs/270 resolves to the shared
    // value and its container boots exactly as it did. Both are forwarded: the
    // entrypoint needs the pair, because `gosu <uid>:<gid>` and the chown loop
    // can no longer assume they are equal.
    const identity = identityForTarget(config.workspaceDir);
    const uid = identity?.uid ?? procEnv.SHIPIT_SESSION_WORKER_UID;
    const gid = identity?.gid ?? procEnv.SHIPIT_SESSION_WORKER_UID;
    env.push(`SHIPIT_SESSION_WORKER_UID=${uid}`);
    env.push(`SHIPIT_SESSION_WORKER_GID=${gid}`);
    // planning#415 — forward the resolved `agent.dep-dirs` (colon-separated,
    // the PATH convention) so the entrypoint's workspace chown can PRUNE them
    // exactly like this side's worktree walk does
    // (`chownWorktreeToSessionWorker`'s `excludeRelDirs`). The entrypoint has
    // no other way to learn the list: shipit.yaml lives in the workspace, but
    // the entrypoint is POSIX sh and the config is resolved — validated,
    // defaulted — here. Without the prune, the entrypoint's walk chowns a dep
    // dir mounted as a docs/183 overlay entry-by-entry, and `chown` sets
    // ATTR_UID even when the value does not change, so overlayfs answers with
    // a copy-up of each shared-base file into the session's private upper
    // layer. Forwarded only alongside the uid because the entrypoint reads it
    // solely on the non-root path; an explicitly empty resolved list
    // (`agent.dep-dirs: []`) forwards nothing, which the entrypoint reads as
    // "no dep dirs" — the same prune set as an orchestrator that predates
    // this change.
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

  // planning#196 — forward the pinned base-image digest so the worker's install-runtime
  // `runtimeKey()` (the install-marker ABI gate) keys on the SAME base digest the
  // orchestrator's `overlayRuntimeKey()` scope uses. The worker image also bakes
  // `BASE_IMAGE_DIGEST` as an ENV, so this forward is normally identical to the
  // baked value; forwarding keeps an operator override consistent across both
  // sides. Absent in dev/local and when the overlay store is off → not forwarded,
  // and the worker falls back to its baked ENV / `SESSION_WORKER_IMAGE_ID`.
  if (procEnv.BASE_IMAGE_DIGEST) {
    env.push(`BASE_IMAGE_DIGEST=${procEnv.BASE_IMAGE_DIGEST}`);
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
  // Same source the Tier B resolver allowlist derives from — see
  // orchestratorCallbackHost — so SHIPIT_HOST and the dnsmasq server= line can't diverge.
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

/**
 * Create the orchestrator-visible lower/upper/work dirs an overlay spec needs
 * before the daemon mounts it, and hand the per-session dirs to the worker uid
 * (docs/183 × docs/150, planning#147).
 *
 * The daemon's `mount -t overlay` fails with ENOENT unless lowerdir, upperdir AND
 * workdir all exist, and nothing else creates them: a cold scope has no published
 * base yet (no `overlay-base/<hash>/`; an empty `g0` lowerdir is a valid cold
 * start), and the per-session upper/work dirs are born here.
 *
 * **The ownership handoff (planning#147).** These dirs are created by the **root**
 * orchestrator, but the non-root worker (uid `SHIPIT_SESSION_WORKER_UID`) is what
 * writes through the merged mount. overlayfs creates a new upper file with the
 * fsuid of the writing process, so the worker can only `npm install` a NEW dep if
 * its **upperdir/workdir are worker-owned** — otherwise the write EACCESes. We
 * `chown` both to the worker uid right after mkdir (no-op when the uid is unset →
 * legacy root runtime unchanged). The chown is non-recursive: the dirs are freshly
 * created and empty. The shared `lowerdir` is deliberately left as-is — the empty
 * cold-start `g0` is read-only and traversable by the worker (mode 0755), and a
 * populated base generation is made worker-owned at publish time (the base
 * materialization's recursive chown), so copy-up of an existing dep preserves
 * worker ownership and stays writable.
 *
 * **Superseded-generation reset (the ops finding of 2026-08-17).** The per-session
 * upper/work dirs are keyed by the base generation they were built against
 * (`sessionOverlayGenDir`), so a session that slept through a publish arrives here
 * with its previous `g<M>/` still on disk beside the `g<N>/` it is about to mount.
 * Those bytes are only meaningful over the lower that produced them — carrying them
 * across gave the prod host its `overlayfs: failed to get index nlink (…, err=-61)`
 * warnings and, worse, a merged dep tree torn between two generations. They are a
 * pure install-delta cache, so they are simply reaped.
 *
 * **The install marker goes with them**, for the reason `reclaimBlockedSessionCaches`
 * documents (planning#296): after the reset the session's dep dir remounts over a
 * *populated* base, so it is not present-but-EMPTY, `overlay-dep-check.ts` sees no
 * contradiction, and a still-matching marker would skip `agent.install` — leaving
 * the session with the base's deps and none of its own. Removed marker FIRST, same
 * ordering rule: a half-failure must land on "no marker, deps present" (a harmless
 * extra install), never "marker present, deps gone". `preStampInstallMarker` then
 * re-stamps post-start if the NEW generation genuinely satisfies this checkout, so
 * the base-hit fast path survives a rotation instead of paying a full install.
 */
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
    // Marker first — see the ordering rule in the docstring.
    if (opts.workspaceDir) removeInstallMarkerForRotation(opts.workspaceDir);
    for (const dir of superseded) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        // Best-effort: a leftover upper we could not remove is disk, not
        // correctness — the mount below pins the new generation's own dirs.
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
    // docs/270 req 9 — a base generation PUBLISHED BEFORE this deployment gained
    // a shared gid is owned `<old-uid>:<old-gid>` with `0644` files, and nothing
    // else ever revisits it: `publishBase` shares only the generation it is
    // creating. overlayfs copy-up preserves the lower file's owner AND mode, so
    // a session at an allocated uid copies up an unwritable file and EACCESes on
    // its first edit of an inherited dependency — precisely the bug docs/183's
    // chown exists to prevent, reintroduced for every pre-upgrade generation.
    // Marker-gated so the walk happens once per generation per gid; it lives
    // beside the generation, never inside it, because the generation is mounted
    // as the user's `node_modules` lower layer.
    shareTreeOnce(spec.orchDirs.lowerdir, { beside: true });
    // Hand the per-session copy-on-write dirs to the worker uid so the agent's
    // `npm install` of a new dep lands in the upper as the worker, not root.
    chownToSessionWorker(path.dirname(spec.orchDirs.upperdir));
    chownToSessionWorker(spec.orchDirs.upperdir);
    chownToSessionWorker(spec.orchDirs.workdir);
    // docs/272 — the upperdir's own mode IS the merged dep dir's mode (overlayfs
    // takes the merged root from the upper once it exists), so a Compose service
    // at a different uid can only create its `node_modules/.vite`-style cache if
    // this dir is group-writable. `selfHealWorkspaceOwnership` asserts that on
    // every boot, but it runs BEFORE this function — so on a rotation it sees an
    // upperdir that does not exist yet and the freshly-mkdir'd one would stay at
    // the umask default until the boot after. Idempotent and O(1) on an empty
    // dir; a no-op in the legacy root runtime.
    reconcileDepDirCacheOwnership(spec.orchDirs.upperdir);
  }
}

/**
 * Drop this session's `.install-done` marker because its overlay lower rotated
 * under it (see {@link prepareOverlayDirs}). Best-effort and never throws — a
 * marker we failed to remove costs a skipped install we would rather have run,
 * which the worker's own gate (`overlay-dep-check.ts`) still backstops for the
 * empty-dep-dir case; throwing here would fail container creation outright.
 */
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

/**
 * Self-heal worker ownership of a session's workspace on every container
 * (re)create (SHI — recreate-after-idle root-owned-tree wedge).
 *
 * The non-root entrypoint's boot-time `chown -R /workspace` runs ONCE per
 * workspace: it is skipped on every later boot because the UID-stamped sentinel
 * `/workspace/.shipit-uid-<uid>` already exists from the first boot (the
 * deliberate warm-reuse optimization — re-walking a populated tree every boot is
 * expensive). The orchestrator's per-git-op handbacks
 * (`handWorkspaceBackToWorker` on claim / rebase / fork-merge, `.git`-only on
 * post-turn commit) are what keep the tree worker-owned thereafter — but the
 * container-recreate-after-idle path runs NONE of them. It simply boots a fresh
 * container against the persisted clone and relies on the tree already being
 * worker-owned.
 *
 * That assumption breaks for any root-owned node that slipped into the worktree
 * during the session's life and was never handed back (an interrupted handback,
 * an orchestrator-root write the narrow `.git`-only post-turn handback didn't
 * cover, the root-written pre-stamp marker). On recreate it persists, and the
 * non-root agent (uid 1000) then EACCESes: `npm install` fails fast writing into
 * the root-owned cwd (its temp / lockfile), and the agent can't edit tracked
 * files or rebase — the "wedged, root-owned workspace" symptom.
 *
 * Re-asserting worker ownership here, at the single choke point every boot
 * passes through, makes the next resume self-heal. The walk is bounded — it
 * excludes `.git` object data files and the declared dep dirs (the large
 * `node_modules` overlay) — and idempotent (an already-worker-owned tree costs a
 * no-op `lchown` per node), so the steady-state cost is negligible.
 *
 * The dep-dir exclusion above left one gap (#1666): a root process that wrote a
 * tool cache *inside* a dep dir — a Compose dev server's `node_modules/.vite`
 * before #1646 ran services as the worker uid — leaves a root-owned subtree the
 * worktree handback never repairs, and the next `npm run build` EACCESes trying
 * to `rmdir` it (no `sudo` to recover). So we *also* run a **bounded** dep-dir
 * reconciliation here ({@link reconcileDepDirCacheOwnership}): it only `lstat`s
 * the direct children of each per-session dep-dir layer and chowns the rare
 * non-worker-owned cache tree, never re-walking the whole `node_modules` or the
 * shared overlay lowerdir. For an overlay session the per-session writable layer
 * is each spec's `upperdir` (where a copied-up/new `.vite` lands); otherwise it's
 * `workspaceDir/<depDir>`.
 *
 * Gated twice:
 *  - the chown helpers are a no-op when `SHIPIT_SESSION_WORKER_UID` is unset
 *    (legacy root runtime — byte-for-byte unchanged); and
 *  - we skip entirely in dev/dogfood bind-mount mode (no `workspaceVolume`),
 *    where `/workspace` is the developer's host source tree and a recursive
 *    chown would rewrite host ownership (docs/150 §2/§9, mirrors the entrypoint's
 *    `SHIPIT_SKIP_WORKSPACE_CHOWN`).
 *
 * Exported + the chown fns injectable so the gating is unit-testable without root.
 */
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

  // #1666 — repair root-owned tool caches the handback's dep-dir exclusion skips.
  const overlaySpecs = config.overlaySpecs;
  if (overlaySpecs && overlaySpecs.length > 0) {
    // Overlay session: reconcile each per-session upperdir (the writable layer
    // where a root-leaked `node_modules/.vite` copy-up/new dir lands). Never the
    // shared lowerdir.
    for (const spec of overlaySpecs) {
      if (spec.orchDirs) reconcileDepDir(spec.orchDirs.upperdir);
    }
  } else {
    // Non-overlay session: the dep dir is a plain subtree of the workspace.
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

  // docs/217 — Ensure the persistent scratch directory exists before mounting.
  // The entrypoint chown loop hands /persist to the worker UID so the non-root
  // worker can write to it.
  if (config.scratchDir) {
    fs.mkdirSync(config.scratchDir, { recursive: true });
  }

  // docs/246 — same for ShipIt's per-session state dir. Created here as well as
  // in `createSessionDirFactory` because a session whose dir predates the state
  // dir (or a warm clone claimed into place) must still get one before the
  // mount resolves.
  fs.mkdirSync(config.sessionStateDir, { recursive: true });
  // The mounted slice must exist before the mount resolves, or Docker creates
  // it root-owned and the entrypoint chown races the worker's first write.
  fs.mkdirSync(sessionSharedStateDir(config.sessionStateDir), { recursive: true });

  // Ensure the dep cache directory exists on the host before mounting.
  if (config.depCacheDir) {
    fs.mkdirSync(config.depCacheDir, { recursive: true });
  }

  // docs/197 Part 2 — create the shared pnpm store dir lazily before mounting it,
  // and hand it to the worker uid (planning#2286). A store we could not hand over
  // must not be mounted at all: a root-owned mount point is unrecoverable from
  // inside the container, whereas dropping it just costs the session the SHARED
  // store — pnpm relocates into the workspace's own `.pnpm-store` instead. Drop
  // it before `buildMounts`/`buildEnv` so the mount and `npm_config_store_dir`
  // can never disagree about whether the store exists.
  if (config.pnpmStoreDir && !ensurePnpmStoreDir(config.pnpmStoreDir)) {
    console.warn(
      `[containers] could not hand pnpm store ${config.pnpmStoreDir} to the session-worker uid; ` +
        `skipping the shared-store mount for ${config.sessionId} — pnpm will use its own ` +
        `per-session store (slower, still correct)`,
    );
    config = { ...config, pnpmStoreDir: undefined };
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
    // Release sub-agent spawn homes a crashed/restarted orchestrator orphaned.
    // Here because container create is the one race-free moment: a fresh
    // container has no worker yet, so no spawn of this session is in flight.
    // Release, not delete — a stranded token rotation is published back first
    // (`sweepSubAgentSpawnHomes` docstring has the why).
    sweepSubAgentSpawnHomes(config.credentialsDir, config.sessionId);
  } catch (err) {
    console.warn(
      `[containers] credentials scaffold failed for ${config.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // docs/262 — create the plugin root before the two mounts reference it.
  // Activation creates it lazily, and a session with no plugins never has one
  // at all; letting Docker auto-create the missing bind source would leave a
  // root-owned directory that the non-root worker cannot write into, breaking
  // the install runner for every session that later declares a plugin.
  try {
    fs.mkdirSync(pluginsRoot(config.sessionStateDir), { recursive: true });
  } catch (err) {
    console.warn(
      `[containers] plugin root scaffold failed for ${config.sessionId}:`,
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

  // docs/150 §2/§9 — when `/workspace` (and the other mounts) fall through to
  // the bind-mount branch (dev / dogfood, no workspaceVolume), the entrypoint
  // must NOT `chown -R` them: that would rewrite ownership of the developer's
  // bind-mounted host source tree. Signal the entrypoint to skip the workspace
  // chown. This deliberately bypasses the non-root hardening in dev mode.
  if (!deps.workspaceVolume) {
    env.push("SHIPIT_SKIP_WORKSPACE_CHOWN=1");
  }

  // docs/172 Gap 5 (planning#99) — under a read-only rootfs, /home/shipit is a tmpfs
  // (see readonlyRootfsTmpfs) which shadows the image-baked credential symlinks
  // (`.claude`→/credentials, etc.). Signal the non-root entrypoint to re-create
  // them into the tmpfs HOME before it gosu-drops. No-op when readonly-rootfs is
  // off. (ReadonlyRootfs requires the non-root runtime, where the entrypoint's
  // prep branch runs; in dev bind-mount mode it stays off.)
  if (deps.readonlyRootfs) {
    env.push("SHIPIT_READONLY_HOME=1");
  }

  // Expose orchestrator API so the agent can query service status/logs
  env.push(...await buildOrchestratorCallbackEnv(config.sessionId));

  // planning#313 — the per-container secret the worker requires on every call that
  // doesn't come from its own loopback, i.e. every orchestrator call. Fresh per
  // container so a token learned in one session opens nothing in another; the
  // container env is the source of truth, so an orchestrator restart re-reads it
  // at adoption (`container-discovery.ts`) instead of needing a persisted key.
  const workerToken = generateWorkerToken();
  env.push(`${WORKER_TOKEN_ENV}=${workerToken}`);

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
    workerToken,
    status: "starting",
    hostWorkspaceDir: config.sessionDir,
    dockerAccess: config.dockerAccess ?? false,
    // docs/128/172 — recorded so the live egress reload path (`reloadEgress`)
    // re-emits the docker-socket-proxy resolver rule for ops sessions.
    opsSession: config.opsSession ?? false,
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
    // #2426 — what the compose path mounts, so it never has to re-derive
    // eligibility from a workspace that has moved on since. See the field doc.
    // Sorted for the reason `sortOverlayDepDirs` documents: this list's ORDER is
    // part of the compose override's bytes, and the adoption path records the
    // same set from a source whose order is not ours. The two must agree, or a
    // session alternating between created and rediscovered rewrites the override
    // — and recreates every compose service — on each transition.
    overlayDepDirs: config.overlaySpecs
      && sortOverlayDepDirs(config.overlaySpecs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName }))),
  };
  deps.containers.set(config.sessionId, sc);

  const shortId = config.sessionId.slice(0, 12);

  // docs/172 ordering fix — resolver for `sc.egressFirewallReady`. Declared out
  // here (assigned once the egress policy is known, below) so the catch can
  // unblock any concurrent compose-join awaiter even on a failed create — a
  // never-resolving gate would otherwise hang the join's egress re-open.
  let signalEgressFirewallReady: () => void = () => {};

  try {
    // Self-heal worker ownership of the persisted workspace BEFORE the worker
    // boots (and its `agent.install` runs). On a recreate-after-idle nothing
    // else re-asserts it, so a root-owned node left in the worktree would
    // otherwise wedge the non-root agent (EACCES) and fail install fast. No-op
    // in legacy root runtime + dev bind-mount mode. See selfHealWorkspaceOwnership.
    selfHealWorkspaceOwnership(config, deps.workspaceVolume);

    // docs/183 dep-dir design — create each per-session `local` `type=overlay`
    // volume (serialized inside createOverlayVolume to dodge the overlay2 EBUSY
    // hazard) right before the container references them; the daemon performs the
    // `mount -t overlay` as it builds the container. Kept INSIDE the try so any
    // later failure removes them via the catch below (`sc.overlayVolumeNames`).
    //
    // The daemon's mount fails with ENOENT unless lowerdir, upperdir AND workdir
    // all exist — and nothing else creates them. `prepareOverlayDirs` mkdirs the
    // orchestrator-visible twins (`orchDirs`, same volume via stateDir — the spec's
    // own paths are daemon-host paths the orchestrator container cannot reach) AND
    // hands the per-session upper/work dirs to the worker uid so the non-root agent
    // can `npm install` into the overlay (planning#147).
    if (config.overlaySpecs) {
      // `workspaceDir` lets the rotation reset drop this session's install
      // marker along with the superseded upper — see prepareOverlayDirs.
      prepareOverlayDirs(config.overlaySpecs, {
        workspaceDir: config.workspaceDir,
        sessionId: config.sessionId,
      });
      // The ops finding of 2026-08-19. `prepareOverlayDirs` has just DELETED the
      // superseded generation's upper/work, so every volume whose opts still name
      // it must be recreated — and a volume cannot be removed while a container
      // mounts it (409). The session's Compose siblings mount exactly these
      // volumes, and on the restart-agent path (docs/127) they are deliberately
      // left running, so the removal failed, `createVolume` returned the existing
      // volume with its stale opts, and the session ran on an overlay whose upper
      // layer no longer existed on the host: writes ENOENT'd, `agent.install`
      // failed, and gated compose services never started. `releaseHolders` lets
      // the create tear those siblings down — re-derived on every attempt,
      // because an unrelated compose reconcile can mint a new holder at any
      // moment (operator finding) — and verify the result instead of trusting it.
      for (const spec of config.overlaySpecs) {
        const { releasedHolders } = await createOverlayVolume(
          deps.docker,
          spec,
          deps.baseLabels(),
          { releaseHolders: true, sessionId: config.sessionId },
        );
        // Those siblings are gone now, and nothing else brings them back: the
        // dep-dir SET is unchanged, so the compose path's own "did the overlay
        // change?" test says no and skips the reconcile. Record it so
        // `applyOverlayDepDirs` asks for one anyway — a service container freezes
        // its mounts at create time, so the recreate is the only way it can ever
        // see the new generation.
        if (releasedHolders.length > 0) sc.overlayVolumesRecreated = true;
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
        // docs/172 Tier B — DNS is NOT redirected via the container `--dns`
        // option: on a user-defined network Docker keeps 127.0.0.11 as the
        // nameserver and demotes `--dns` to a mere upstream, so the agent never
        // actually queries 127.0.0.1. The installer sidecar instead REDIRECTs the
        // agent's DNS (dst 127.0.0.11:53) into the in-netns resolver at the
        // iptables layer (see docker/egress-sidecar/init-firewall.sh). So we leave
        // Dns at Docker's default — the Tier A / off paths are unchanged.
        //
        // docs/172 Tier C — enable route_localnet IN THE AGENT'S OWN NETNS so the
        // installer's nat/OUTPUT REDIRECT of :443 to the loopback SNI proxy isn't
        // dropped as a martian (non-loopback src → 127/8). It's set HERE, at agent
        // creation, rather than in the NET_ADMIN-only installer sidecar: Docker keeps
        // that sidecar's /proc/sys read-only, so `echo 1 >`/`sysctl -w` fail EROFS
        // there. The agent owns its netns, so this namespaced sysctl is permitted and
        // affects only this session — least privilege (no Privileged installer).
        // Gated on Tier C (egressProxy); unset otherwise so Tier A/B are unchanged.
        Sysctls: deps.egressProxy ? { "net.ipv4.conf.all.route_localnet": "1" } : undefined,
        // docs/172 Gap 5 (planning#99) — kernel-tier hardening, all env-gated
        // default-OFF (see container-hardening.ts). With every flag unset this
        // is byte-for-byte the prior config: no Runtime override (Docker default
        // runc), SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: false, no
        // Tmpfs.
        //
        // gVisor: an alternate OCI runtime registered on the host. Omitted
        // (undefined) unless SESSION_RUNTIME is set, so runc stays the default.
        Runtime: deps.kernelRuntime,
        // Custom seccomp profile appended to SecurityOpt; Docker's default
        // seccomp applies when seccompSecurityOpt is undefined (never unconfined).
        SecurityOpt: deps.seccompSecurityOpt
          ? ["no-new-privileges", deps.seccompSecurityOpt]
          : ["no-new-privileges"],
        // Read-only rootfs shrinks the tamper surface; the persistent writable
        // mounts (/workspace, /credentials, /uploads, /dep-cache) are bind/volume
        // mounts and stay writable, and the image-rootfs writable paths come back
        // as the tmpfs set below. Requires the non-root runtime (the entrypoint
        // re-creates the credential symlinks into the tmpfs HOME — see
        // SHIPIT_READONLY_HOME below + docker/session-worker/entrypoint.sh).
        ReadonlyRootfs: deps.readonlyRootfs ?? false,
        Tmpfs: deps.readonlyRootfs ? readonlyRootfsTmpfs() : undefined,
        CapDrop: ["ALL"],
        // docs/150 §10 — capability tightening after the non-root migration.
        // CHOWN/SETUID/SETGID/FOWNER stay: the root entrypoint needs them to chown
        // the writable mounts and `gosu`-drop to `shipit` (caps are a container-wide
        // bounding set shared by PID 1 and the worker). KILL stays for process mgmt.
        // Dropped now that the worker is non-root: DAC_OVERRIDE (the worker owns its
        // own files and no longer bypasses DAC as root) and NET_BIND_SERVICE (the
        // worker listens on 9100, not a privileged port).
        CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "KILL"],
      },
      Env: env,
    });

    // Assign the container ID BEFORE start() so the health monitor's
    // stale-incarnation guard (`containerId !== sc.id`) is armed as early
    // as possible. If the new container dies before we'd otherwise reach
    // the `sc.id = …` below, a `die` event arriving with this ID is
    // correctly attributed instead of being mistaken for a stale event.
    sc.id = container.id;

    // nikzlabs/shipit#2495 — the SECOND verification, and the one that closes the
    // window. `createOverlayVolume` above verified each volume at creation and
    // nothing re-checked it after; the container is only built with these mounts
    // here, ~twenty lines later. A volume removed inside that window does not fail
    // `createContainer` — Docker silently auto-creates a plain, empty, root-owned
    // one under the same name — and the session then boots with a dep dir its own
    // uid cannot write, permanently. Checked before `start()` so the catch below
    // still owns the cleanup (container removed, then every overlay volume,
    // INCLUDING the plain impostor — leaving it would make the retry reuse it).
    // See assertOverlayVolumesMatch for the full failure account.
    if (config.overlaySpecs && config.overlaySpecs.length > 0) {
      await assertOverlayVolumesMatch(deps.docker, config.overlaySpecs, {
        sessionId: config.sessionId,
      });
    }

    await container.start();

    // Get the container's IP on the bridge network
    const info = await container.inspect();
    sc.workerBuildId = info.Config?.Labels?.[CONTAINER_BUILD_ID_LABEL] || undefined;
    const networks = info.NetworkSettings.Networks;
    const networkInfo = networks[deps.networkName];
    if (!networkInfo?.IPAddress) {
      throw new Error(`Container has no IP on network ${deps.networkName}`);
    }

    sc.containerIp = networkInfo.IPAddress;
    sc.workerUrl = `http://${sc.containerIp}:${deps.workerPort}`;
    // planning#313 — bind the token to the base URL the transports key off. Done the
    // moment the URL is known, before anything can dial it.
    setWorkerAuthToken(sc.workerUrl, sc.workerToken);

    // docs/172 Gap 1 (planning#92) Tier A — install the default-deny egress firewall
    // into the agent's netns via a privileged sidecar, BEFORE the container is
    // declared ready (no user turn has run yet, so the injected-agent surface
    // doesn't exist until after this point). Fail-closed: if the firewall can't
    // be installed we throw, and the catch below tears the container down rather
    // than run it with unrestricted egress. Gated on the flag → default no-op.
    // docs/172 (planning#92) — the browser global toggle / per-session override can
    // turn containment OFF for a session ("Open mode — stop babysitting"); when
    // it does we skip the firewall install entirely. The composed extra-host
    // allowlist (operator extras + live MCP hosts + durable user allowlist) is
    // shared by the Tier B resolver and the Tier C proxy so they never drift.
    // Default (no resolver wired): contained, no extra hosts — unchanged env-only
    // behavior.
    const egressCfg = deps.resolveEgressConfig?.(config.sessionId) ?? { contained: true, extraHosts: [] };
    // Record the resolved containment this container is actually being created
    // with — the egress sidecars are plumbed into the netns below and can't be
    // re-plumbed live, so this is the source of truth the egress API diffs
    // against the current policy to show "pending — restart to apply" (docs/172).
    sc.egressContainedAtStart = egressCfg.contained;
    // docs/172 ordering fix — expose a readiness promise the moment we know the
    // egress policy, resolved once the Tier-A install below has finished. A
    // concurrent compose-network join (`allowEgressToSessionNetwork`) awaits it
    // before appending its per-subnet ACCEPT, so the allow always lands AFTER
    // `init-firewall.sh`'s `iptables -F OUTPUT` instead of being flushed by it.
    // Resolved in every branch (including the non-contained path and the create()
    // catch) so an awaiter never hangs.
    sc.egressFirewallReady = new Promise<void>((resolve) => {
      signalEgressFirewallReady = resolve;
    });
    if (deps.egressEnforce && egressCfg.contained) {
      if (!deps.egressSidecarImage) {
        // Fail closed: this session is contained but the deployment can't run
        // the privileged egress sidecar (no image configured), so we refuse to
        // start it rather than run with unenforced/open egress. Name the escape
        // hatches so the operator (and the surfaced session-start error) can act.
        throw new Error(
          "Agent egress containment is on but cannot be enforced: SESSION_EGRESS_SIDECAR_IMAGE is not set. " +
            "Provide/build the egress sidecar image (deploy.sh / dev.sh build it), or disable containment " +
            "with SESSION_EGRESS_ENFORCE=0 if this host can't run the NET_ADMIN sidecar.",
        );
      }
      const egressLabels = { ...deps.baseLabels(), "shipit-parent-session": config.sessionId };
      const inputs = await buildTierAEgressInputs();
      // Tier A: install the firewall (and, under Tier B, lock DNS to the resolver
      // uid; under Tier C, REDIRECT :443 to the SNI proxy uid/port).
      await installEgressFirewall(deps.docker, {
        agentContainerId: container.id,
        sidecarImage: deps.egressSidecarImage,
        inputs,
        resolverUid: deps.egressDns ? EGRESS_RESOLVER_UID : undefined,
        proxyUid: deps.egressProxy ? EGRESS_PROXY_UID : undefined,
        proxyPort: deps.egressProxy ? EGRESS_PROXY_PORT : undefined,
        labels: egressLabels,
      });
      // Tier B: launch the controlled resolver into the agent's netns (after the
      // installer, so the ipset it pins into already exists). It keeps the parent
      // session label so cleanupSessionDockerResources tears it down on destroy,
      // PLUS a distinct EGRESS_RESOLVER_LABEL so the compose pre-start stale-sweep
      // (killStaleContainers) doesn't mistake this long-lived sidecar for a stale
      // compose container and SIGKILL it (docs/172 Bug-2 fix, planning#92).
      if (deps.egressDns) {
        const configB64 = buildResolverConfigB64({
          // Ops sessions additionally need their docker-socket-proxy compose
          // alias forwarded to Docker's embedded DNS — without it the Tier B
          // resolver REFUSES DOCKER_HOST by name (planning#92 Tier B host verification).
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
      // Tier C: launch the SNI proxy into the agent's netns (after the resolver,
      // since it dials destination IPs the resolver pinned into the ipset). Same
      // labeling rationale as the resolver — parent-session for destroy cleanup,
      // EGRESS_PROXY_LABEL so the compose stale-sweep spares it.
      if (deps.egressProxy) {
        // C2 allow-once: point the proxy at the orchestrator decision endpoint
        // (same host the worker calls back on — resolvable via the controlled
        // resolver, which allowlists it). On an unknown SNI the proxy queries it;
        // the orchestrator surfaces the allow-once card and answers allow/deny.
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
      // docs/172 ordering fix — the install (and its `iptables -F OUTPUT`) is
      // done: (1) unblock any concurrent compose join waiting on the gate so its
      // ACCEPT now lands AFTER the flush, then (2) re-open egress to any network
      // the agent has ALREADY joined so this fresh OUTPUT chain can't have
      // permanently stranded it. Idempotent; a no-op on first boot (compose-up
      // joins the session network only later). Done before resolving the worker
      // URL so the agent never observes a default-deny window to its own subnet.
      signalEgressFirewallReady();
      await deps.reopenJoinedEgress?.(config.sessionId);
    }
    // Non-contained / enforcement-off path: there is no firewall to wait on, so
    // resolve immediately. (Idempotent if already resolved above.)
    signalEgressFirewallReady();

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
    if (config.overlaySpecs && config.overlaySpecs.length > 0 && deps.stateDir) {
      try {
        const stamped = await preStampInstallMarker({
          // The ORCHESTRATOR's state dir (overlay base pointers). The session
          // state dir the marker goes in is resolved from the clone path.
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
    // Clean up on failure. Mirror destroyContainer's ordering: stop the agent
    // container, reap any parent-session-labeled child resources, THEN remove
    // the agent container. The egress Tier B/C sidecars (resolver + proxy) are
    // long-lived containers that share the agent's netns (`container:<agent>`)
    // and carry the `shipit-parent-session` label; if a later step throws after
    // one of them launched, removing only the agent container leaks them (and
    // they keep a netns reference). cleanupSessionDockerResources is what reaps
    // them — the agent container itself isn't parent-session-labeled, so the
    // explicit stop/remove around the cleanup is still required.
    deps.containers.delete(config.sessionId);
    // planning#313 — same reasoning as destroyContainer: the URL may already be
    // registered (the throw can come after the IP was resolved), and this
    // container is going away.
    clearWorkerAuthToken(sc.workerUrl);
    // docs/172 ordering fix — unblock any concurrent compose-join awaiter; the
    // container is being torn down, so resolving (not hanging) lets the join's
    // best-effort egress re-open fall through to its "no container" no-op.
    signalEgressFirewallReady();
    if (sc.id) {
      try {
        const c = deps.docker.getContainer(sc.id);
        try { await c.stop({ t: 2 }); } catch { /* may not be running */ }
      } catch {
        // Container reference invalid
      }
    }
    // Reap egress sidecars / docker-proxy child containers, networks, and
    // volumes created before the throw. Best-effort — the disk-janitor orphan
    // sweep is the backstop — and done before removing the agent container so
    // the netns-sharing sidecars are gone first.
    try {
      await cleanupSessionDockerResources(deps.docker, config.sessionId);
    } catch {
      /* best-effort; disk-janitor is the backstop */
    }
    if (sc.id) {
      try {
        const c = deps.docker.getContainer(sc.id);
        try { await c.remove({ force: true }); } catch { /* may already be gone */ }
      } catch {
        // Container reference invalid
      }
    }
    // docs/183 dep-dir design — drop every per-session overlay volume we created
    // above so a failed create doesn't leak them. The disk-janitor orphan-volume
    // sweep is the backstop, but reclaim eagerly here.
    //
    // Two properties here are LOAD-BEARING for the #2495 verification above, not
    // incidental. **It must run after the container removal** a few lines up: a
    // `volume rm` while a container still references the volume is a 409, which
    // `removeOverlayVolume` swallows by design — reorder these and the impostor
    // silently survives. And **it must reclaim by `sc.overlayVolumeNames`**, every
    // name the specs ASKED for rather than every volume we successfully created,
    // because the volume the verification rejects is precisely the one this path
    // did not create: the plain one Docker conjured under an overlay-intended
    // name. (`createOverlayVolume`'s converge loop would also repair it on the
    // next attempt — this is what keeps it from sitting on disk in between, and
    // on the paths where there is no next attempt.) Do not narrow the list.
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
        // 304 = already stopped, 409 = removal already in progress, 404 = already
        // gone — all safe to ignore, they're the outcome we wanted.
        //
        // 404 is now *routine*, not exceptional (planning#224): every orchestrator
        // teardown stops the agent container, which fires a Docker `die`, which
        // fires the crash-site egress reap — so the reaper and this sweep race for
        // the same two sidecars on every healthy destroy. Whoever loses sees a 404.
        if (code !== 304 && code !== 409 && code !== 404) {
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
  opts: { preserveChildResources?: boolean } = {},
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
  // planning#313 — drop the token binding with the container. Bridge IPs are
  // recycled, so a stale entry would otherwise hand the previous container's
  // token to whatever lands on that address next.
  clearWorkerAuthToken(sc.workerUrl);
  // planning#371 — the same for the session's egress decision-query tokens: this
  // teardown reaps every `shipit-parent-session` child below, sidecars included,
  // so nothing that could present one survives it.
  clearEgressDecisionTokens(sessionId);

  // `sc.id` is EMPTY between the map publish above (`containers.set`, with
  // `id: ""`) and the assignment that follows `docker.createContainer` — a window
  // that spans an image pull and the overlay provisioning, so an archive landing
  // inside it is entirely ordinary. Dialing Docker with it builds the path
  // `/containers//stop`, which the daemon's router answers with a canonicalizing
  // `301` — and following that redirect is what killed the orchestrator on
  // 2026-08-26 (the full chain is in `docker-client.ts`). The failure-cleanup path
  // in `createContainer` already guards this way; this one did not.
  //
  // Skipping is right rather than merely safe: with no id there is no container we
  // could name, and every call here needs one. What it does NOT do is stop the
  // in-flight creation, so a container may still be started for a session that is
  // being archived — a separate lifecycle defect (create/destroy are not
  // serialized), which this log makes visible instead of silent.
  if (!sc.id) {
    console.warn(
      `[containers] destroy(${sessionId}) reached a container still being created `
      + "(no id yet) — skipping the agent-container stop/remove. Its creation is not "
      + "cancelled, so it may need the orphan sweep.",
    );
  }

  // Stop the session container first so it can't create new child resources
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

  // A full session-container teardown owns its proxy/Compose children. The
  // agent-only restart path deliberately leaves those resources alive so a
  // worker refresh does not interrupt the user's preview stack.
  if (!opts.preserveChildResources) {
    await cleanupSessionDockerResources(deps.docker, sessionId);
  }

  // Remove the session container — same empty-id guard as the stop above.
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
    workspaceDir: string;
    credentialsDir: string;
    depCacheDir?: string;
    /** docs/197 Part 2 — shared per-runtime pnpm store host dir; absent for non-pnpm / flag-off sessions. */
    pnpmStoreDir?: string;
    uploadsDir?: string;
    /** docs/217 — persistent scratch host dir; defaults to a `sessionDir` sibling. */
    scratchDir?: string;
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
    scratchDir: opts.scratchDir ?? path.join(opts.sessionDir, "scratch"),
    // docs/246 — ALWAYS resolved from the clone path via the one contract the
    // host-side callers share, so the mount and every host writer agree on where
    // this session's state lives. Throws for a clone that isn't
    // `<sessionDir>/workspace`.
    //
    // Deliberately NOT overridable (planning#288). It used to accept an explicit
    // `sessionStateDir`, which no production caller ever passed and which the
    // overlay pre-stamp would now ignore: `preStampInstallMarker` derives the
    // marker's home from the clone path, so an override would mount
    // `<custom>/shared` while the pre-stamp wrote `<sessionDir>/state/shared` —
    // an unreadable marker and a full `agent.install` on every base hit.
    sessionStateDir: sessionStateDirForWorkspace(opts.workspaceDir),
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
