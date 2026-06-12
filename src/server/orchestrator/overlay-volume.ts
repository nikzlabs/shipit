/**
 * Overlay dep store — daemon-performed overlay mount subsystem (docs/183 Phase 2).
 *
 * Instead of copying `node_modules` into each session, ShipIt keeps one rolling
 * overlay base per `(repo, runtime fingerprint)`: the whole-workspace filesystem
 * state captured right after a successful install. A new session mounts that base
 * read-only as the overlay `lowerdir`, gets its own per-session `upperdir`/`workdir`
 * for copy-on-write, and runs its real install on top — doing only incremental work.
 *
 * Mount mechanism (decided — plan §4 "Host-mount design decisions"): the
 * orchestrator stays **unprivileged**. Using the `docker.sock` it already holds,
 * it creates a per-session **`local`-driver volume with `type=overlay`** whose
 * `o=lowerdir=…,upperdir=…,workdir=…` point at absolute daemon-host paths. When the
 * session container mounts that volume at `/workspace`, the **Docker daemon performs
 * the `mount -t overlay`** as it builds the container — so the merged view lands in
 * the container's mount namespace by construction. No privileged sidecar, no
 * `CAP_SYS_ADMIN`, no cross-container mount propagation. Proven on all four documented
 * targets (`prototype/volume-driver-overlay-spike.sh`, `shared-volume-spike.sh`).
 *
 * This module owns ONLY the Docker-volume mechanics (name → spec → create/inspect/
 * remove) plus the serialization that avoids the overlay2 EBUSY hazard. The base
 * filesystem (lowerdir contents, the rolling-base publish CAS) is Phase 3; the
 * session-eligibility decision and the spec populator are later phases. Nothing
 * here is wired into live session creation until a caller populates
 * `ContainerConfig.overlaySpecs`, so importing it is behavior-preserving.
 */

import crypto from "node:crypto";
import path from "node:path";
import type Docker from "dockerode";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Dedicated subtree (under the workspace state volume) that holds the shared
 * overlay bases, keyed by scope hash: `overlay-base/<scope-hash>/`. This is NOT
 * under `dep-cache/` on purpose — the dep-cache subtree is bind/Subpath-mounted
 * **read-write** into every session at `/dep-cache`, so a base placed there would
 * be writable from inside any session and could mutate the immutable lowerdir under
 * other sessions' live overlay mounts (undefined behavior). The `overlay-base/`
 * subtree is never mounted into a session container, so it is unreachable-for-write.
 */
export const OVERLAY_BASE_SUBDIR = "overlay-base";

/**
 * Suffix for the per-session overlay volume. The full name is
 * `shipit-<sessionId[:12]>_overlay`, deliberately matching the
 * `^shipit-([a-f0-9-]{12})_` pattern that `sweepOrphanSessionVolumes`
 * (disk-janitor.ts) already reclaims — so a crash-orphaned overlay volume is swept
 * automatically once no live session owns the 12-char prefix. Do NOT rename to
 * `shipit-overlay-<id>`: that fails the `<12 hex>_` regex and would leak.
 */
export const OVERLAY_VOLUME_SUFFIX = "_overlay";

/** Stamped on the overlay volume for parity with the compose-volume sweep. */
export const OVERLAY_MANAGED_LABEL = "shipit-managed";

// ---------------------------------------------------------------------------
// Naming / path helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Per-session overlay volume name. The dep-dir design (docs/183) mounts **N**
 * overlay volumes per session — one per declared dep dir — so the name carries a
 * stable per-dep-dir discriminator: `shipit-<sessionId[:12]>_overlay-<depHash8>`.
 * Omitting `depDir` yields the legacy single-volume name (`shipit-<id>_overlay`),
 * kept for the inert Phase-2 single-spec plumbing.
 *
 * Every form still matches the disk-janitor orphan-volume regex
 * (`^shipit-([a-f0-9-]{12})_`) — the discriminator only extends the suffix — so a
 * crash-orphaned per-dep-dir volume is swept automatically. See OVERLAY_VOLUME_SUFFIX.
 */
export function overlayVolumeName(sessionId: string, depDir?: string): string {
  const base = `shipit-${sessionId.slice(0, 12)}${OVERLAY_VOLUME_SUFFIX}`;
  if (depDir === undefined) return base;
  return `${base}-${depDirDiscriminator(depDir)}`;
}

/** Short, filesystem/volume-name-safe discriminator for a dep-dir relpath. */
export function depDirDiscriminator(depDir: string): string {
  return crypto.createHash("sha256").update(depDir).digest("hex").slice(0, 8);
}

/**
 * Content-addressed scope hash for an overlay base, keyed on
 * `(repo, runtime fingerprint[, dep-dir relpath])`. The runtime fingerprint
 * (`runtimeKey()` from install-runtime.ts) describes ABI compatibility — image
 * digest, arch, libc, Node ABI — so a base with compiled native addons is never
 * reused across incompatible runtimes. Under the dep-dir design (docs/183) the
 * scope also includes the dep-dir relpath, so each declared dep dir gets its own
 * base. Omitting `depDir` reproduces the legacy `(repo, runtime)` hash byte-for-byte
 * (no trailing field is mixed in), so the single-base publish CAS is unaffected.
 * 16 hex chars matches `repoUrlToHash`'s width.
 */
export function overlayScopeHash(repoUrl: string, runtimeKey: string, depDir?: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(repoUrl)
    .update("\0")
    .update(runtimeKey);
  if (depDir !== undefined) {
    hash.update("\0").update(depDir);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * On-disk (orchestrator-visible state dir) path to an overlay base subtree:
 * `<stateDir>/overlay-base/<scope-hash>`. This is where the orchestrator writes the
 * base contents; the absolute *daemon-host* path used as the overlay `lowerdir` is
 * resolved separately via `resolveVolumeMountpoint` (the state dir is on the
 * `shipit-workspace` named volume).
 */
export function overlayBaseDir(stateDir: string, scopeHash: string): string {
  return path.join(stateDir, OVERLAY_BASE_SUBDIR, scopeHash);
}

/**
 * On-disk path of ONE immutable base generation:
 * `<stateDir>/overlay-base/<scope-hash>/g<generation>`.
 *
 * Bases are generational because a live overlay mount pins its lowerdir
 * dentries — and (spike-proven on the docs/183 measurement host) renaming or
 * deleting that directory out from under the mount breaks merged-readdir for
 * every same-scope session (readdir returns empty while path lookups still
 * resolve), silently corrupting npm/tar/ls in those containers. So a publish
 * NEVER mutates or replaces an existing generation: it writes the next
 * `g<N+1>` beside it and moves the pointer. `g0` is the empty cold-start
 * lowerdir (created at container-create time, before any base exists).
 */
export function overlayBaseGenDir(stateDir: string, scopeHash: string, generation: number): string {
  return path.join(stateDir, OVERLAY_BASE_SUBDIR, scopeHash, `g${generation}`);
}

// ---------------------------------------------------------------------------
// Overlay spec
// ---------------------------------------------------------------------------

/**
 * Everything the daemon needs to mount one session's overlay. All three dirs are
 * **absolute daemon-host paths** (resolved via `docker volume inspect`), because the
 * orchestrator runs in its own container and cannot pass its own container-internal
 * paths to the daemon. Per overlay's kernel rules: `lowerdir` may live on a different
 * filesystem, but `upperdir` + `workdir` must share one; `workdir` must be empty.
 */
export interface OverlaySpec {
  /** Volume name — always `overlayVolumeName(sessionId)`. */
  volumeName: string;
  /** Absolute daemon-host path to the shared, read-only base. */
  lowerdir: string;
  /** Absolute daemon-host path to this session's private upper layer. */
  upperdir: string;
  /** Absolute daemon-host path to this session's overlay workdir (must be empty). */
  workdir: string;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * overlay2 raises `device or resource busy` (EBUSY) when overlay mounts are created
 * in parallel, so we serialize volume creation through a single promise chain. The
 * actual `mount -t overlay` happens later, when the daemon builds the container, but
 * Docker's per-volume store lock already serializes first-use mounts (proven for
 * `type=overlay` by `shared-volume-spike.sh`, PASS=8/8) — so serializing the create
 * is the part we own. Failures don't poison the chain.
 */
let createChain: Promise<void> = Promise.resolve();

async function serialize<T>(fn: () => Promise<T>): Promise<T> {
  // Take the current tail, install our own gate as the new tail, then wait for
  // the previous link before running. The gate is released in `finally` so a
  // failing link still unblocks the next caller (and its own error propagates to
  // this caller, not to the next one).
  const prev = createChain;
  let release!: () => void;
  createChain = new Promise<void>((r) => { release = r; });
  try {
    await prev;
  } catch {
    // A previous link's failure is that caller's problem, not ours.
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Docker operations
// ---------------------------------------------------------------------------

/**
 * Resolve a named volume's absolute mountpoint on the daemon host
 * (`docker volume inspect -f '{{.Mountpoint}}'`). The overlay base/upper/work dirs
 * are cross-subtree subpaths of this mountpoint.
 */
export async function resolveVolumeMountpoint(
  docker: Docker,
  volumeName: string,
): Promise<string> {
  const info = await docker.getVolume(volumeName).inspect();
  if (!info.Mountpoint) {
    throw new Error(`Volume ${volumeName} has no Mountpoint`);
  }
  return info.Mountpoint;
}

/**
 * Create the per-session `local`-driver `type=overlay` volume. The daemon performs
 * the overlay mount when the session container later mounts this volume at
 * `/workspace`. Serialized to avoid the overlay2 EBUSY hazard.
 *
 * Idempotent on name conflict: if a volume with the same name already exists (e.g. a
 * crash left it behind), it is removed and recreated so the driver opts reflect the
 * current base/upper/work — a stale overlay volume pointing at a since-rebuilt base
 * would otherwise wire the session to the wrong lowerdir.
 */
export async function createOverlayVolume(
  docker: Docker,
  spec: OverlaySpec,
  labels: Record<string, string> = {},
): Promise<void> {
  await serialize(async () => {
    await removeVolumeIfExists(docker, spec.volumeName);
    await docker.createVolume({
      Name: spec.volumeName,
      Driver: "local",
      DriverOpts: {
        type: "overlay",
        device: "overlay",
        o: `lowerdir=${spec.lowerdir},upperdir=${spec.upperdir},workdir=${spec.workdir}`,
      },
      Labels: { ...labels, [OVERLAY_MANAGED_LABEL]: "true" },
    });
  });
}

/**
 * Whether a named volume currently exists on the daemon. Used by the compose
 * path to mount only overlay volumes the agent container was actually built
 * with — re-deriving eligibility there can disagree with what was provisioned
 * (e.g. a container created before `OVERLAY_DEP_STORE` was enabled), and a
 * compose override referencing a missing `external` volume fails the whole
 * `compose up`. 404 → false; any other daemon error propagates.
 */
export async function volumeExists(docker: Docker, volumeName: string): Promise<boolean> {
  try {
    await docker.getVolume(volumeName).inspect();
    return true;
  } catch (err) {
    if (errStatus(err) === 404) return false;
    throw err;
  }
}

/**
 * Remove a per-session overlay volume on teardown. The daemon unmounts the overlay
 * when the container stops, so this is a plain `docker volume rm` with no manual
 * unmount-ordering. Best-effort: a missing/already-removed volume is not an error.
 */
export async function removeOverlayVolume(
  docker: Docker,
  volumeName: string,
): Promise<void> {
  try {
    await docker.getVolume(volumeName).remove({ force: true });
  } catch (err) {
    // 404 (already gone) / 409 (still in use by a racing teardown) are both fine —
    // the disk-janitor orphan-volume sweep is the backstop.
    const code = errStatus(err);
    if (code !== 404 && code !== 409) {
      console.warn(
        `[overlay] failed to remove volume ${volumeName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function removeVolumeIfExists(docker: Docker, volumeName: string): Promise<void> {
  try {
    await docker.getVolume(volumeName).remove({ force: true });
  } catch (err) {
    // 404 means it never existed — the common case; anything else we let surface
    // only as a warning so create can still proceed (it will throw 409 itself if
    // the volume genuinely couldn't be cleared).
    if (errStatus(err) !== 404) {
      console.warn(
        `[overlay] pre-create removal of ${volumeName} did not complete cleanly:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function errStatus(err: unknown): number {
  if (err && typeof err === "object" && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode;
  }
  return 0;
}
