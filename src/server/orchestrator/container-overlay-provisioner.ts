/**
 * Container overlay / pnpm provisioning (docs/183, docs/197, docs/198).
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 * This module owns the dep-dir overlay-store integration — resolving the
 * per-dep-dir overlay specs a container should mount, and resolving the shared
 * per-runtime pnpm store dir that replaces the overlay for pnpm repos — plus
 * the worker-image-ID resolution the overlay scope keys on. Overlay volume
 * creation/teardown itself happens in `container-lifecycle.ts` from the specs
 * this module produces.
 *
 * All functions receive explicit dependencies rather than accessing class state;
 * the manager caches the worker image ID and threads its docker/volume/state
 * config through the deps object.
 */

import type Docker from "dockerode";
import {
  buildOverlaySpecs,
  depDirsForSession,
  isPnpmRepo,
  pnpmStoreDirForRuntime,
  resolveOverlayScope,
  validDepDirsForOverlay,
  type DepDirOverlaySpec,
} from "./overlay-session.js";
import { resolveVolumeMountpoint, volumeExists } from "./overlay-volume.js";
import { readBasePointerByHash } from "./overlay-base.js";
import type { SessionInfo } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Dependency bundle
// ---------------------------------------------------------------------------

export interface OverlayProvisionerDeps {
  docker: Docker;
  /**
   * Docker named volume for workspace data. Overlay subtrees and the pnpm store
   * must live on the SAME superblock as `/workspace`, so both provisioning paths
   * no-op without it.
   */
  workspaceVolume?: string;
  /**
   * Orchestrator-visible root of the workspace state volume (the app's
   * `stateDir`). Needed by the overlay dep store to create each overlay's
   * lower/upper/work dirs and to anchor the pnpm store dir.
   */
  stateDir?: string;
}

// ---------------------------------------------------------------------------
// Worker image ID — overlay runtime scope fingerprint (docs/183)
// ---------------------------------------------------------------------------

/**
 * docs/183 — resolve the Docker image ID of the session-worker base image. This
 * is the ABI fingerprint the overlay dep store keys its rolling base scope on
 * (`overlayRuntimeKey`): a worker-image rebuild that bumps Node or glibc changes
 * this id, rotating the scope so an ABI-incompatible base (e.g. one holding a
 * `better-sqlite3` compiled against the old ABI) is never reused. Resolved at
 * runtime — not hardcoded in deploy.sh — so a self-update rotates the scope for
 * free.
 *
 * Returns `""` (a miss) when the image can't be inspected (Docker unavailable /
 * image absent) — the caller then leaves the scope on the `"unknown"` fallback,
 * which simply means no rotation (the prior behavior), never a wrong reuse. The
 * caller (`SessionContainerManager`) caches the result, incl. the miss, so this
 * adds no per-session Docker call.
 */
export async function resolveWorkerImageId(docker: Docker, imageName: string): Promise<string> {
  try {
    const info = await docker.getImage(imageName).inspect();
    return info.Id ?? "";
  } catch (err) {
    console.warn(
      `[overlay] could not inspect worker image ${imageName} for the runtime scope:`,
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

// ---------------------------------------------------------------------------
// Overlay spec resolution (docs/183)
// ---------------------------------------------------------------------------

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
export async function prepareOverlaySpecs(
  deps: OverlayProvisionerDeps,
  opts: {
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
  },
): Promise<DepDirOverlaySpec[]> {
  const scope = resolveOverlayScope(opts.session);
  if (!scope) return [];
  if (!deps.workspaceVolume) return [];
  // docs/197 Part 2 — pnpm repos do NOT overlay `node_modules`: pnpm's
  // store→node_modules hardlinks cannot cross the overlayfs boundary (EXDEV) and
  // silently degrade to a full per-session copy. They get a shared same-fs pnpm
  // store instead (`preparePnpmStore`), so the overlay specs are skipped here.
  if (isPnpmRepo(opts.workspaceDir)) return [];
  const declared = depDirsForSession({ workspaceDir: opts.workspaceDir });
  const valid = await validDepDirsForOverlay(declared, opts.workspaceDir);
  if (valid.length === 0) return [];
  const volumeMountpoint = await resolveVolumeMountpoint(deps.docker, deps.workspaceVolume);
  const stateDir = deps.stateDir;
  const specs = buildOverlaySpecs({
    sessionId: opts.sessionId,
    scope,
    depDirs: valid,
    volumeMountpoint,
    stateRoot: stateDir,
    // Pin each mount to the scope's CURRENT base generation (bases are
    // immutable `g<N>` dirs — see overlay-base.ts). No pointer / no stateDir
    // → generation 0, the empty cold-start lowerdir.
    generationForScope: stateDir
      ? (scopeHash) => readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0
      : undefined,
  });
  if (!opts.requireProvisioned) return specs;
  const provisioned: DepDirOverlaySpec[] = [];
  for (const spec of specs) {
    if (await volumeExists(deps.docker, spec.volumeName)) {
      provisioned.push(spec);
    } else {
      console.warn(
        `[overlay:${opts.sessionId}] skipping compose mount for ${spec.depDir}: ` +
        `volume ${spec.volumeName} is not provisioned (agent container predates the overlay enable?)`,
      );
    }
  }
  return provisioned;
}

// ---------------------------------------------------------------------------
// pnpm shared store resolution (docs/197 Part 2)
// ---------------------------------------------------------------------------

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
export function preparePnpmStore(
  deps: Pick<OverlayProvisionerDeps, "workspaceVolume" | "stateDir">,
  opts: {
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  },
): string | undefined {
  if (!resolveOverlayScope(opts.session)) return undefined;
  if (!deps.workspaceVolume) return undefined;
  if (!deps.stateDir) return undefined;
  if (!isPnpmRepo(opts.workspaceDir)) return undefined;
  return pnpmStoreDirForRuntime(deps.stateDir);
}
