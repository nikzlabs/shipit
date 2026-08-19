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
 * The `o=` driver option one spec mounts with — the single place the three dirs
 * are joined, so "what we asked for" and "what the daemon holds" are compared as
 * the same string. See {@link createOverlayVolume}'s post-create check.
 */
export function overlayDriverOpts(spec: OverlaySpec): string {
  return `lowerdir=${spec.lowerdir},upperdir=${spec.upperdir},workdir=${spec.workdir}`;
}

/** What a live volume of this name is, relative to the spec we want it to be. */
export type OverlayVolumeState = "absent" | "match" | "mismatch";

/**
 * A reading of what the daemon holds under a spec's volume name — the verdict
 * plus the raw driver option behind it, so a caller that has to *explain* a
 * mismatch doesn't have to inspect a second time to say what it saw.
 */
export interface OverlayVolumeReading {
  state: OverlayVolumeState;
  /**
   * The `o=` driver option the daemon holds. Absent both when the volume does
   * not exist AND when it exists with **no driver options at all** — the shape
   * Docker's implicit named-volume creation leaves behind, and the one worth
   * naming in an error (see {@link assertOverlayVolumesMatch}).
   */
  observedOpts?: string;
}

/**
 * Compare the volume the daemon currently holds under `spec.volumeName` against
 * the spec, keeping what was actually read.
 *
 * `match` means a recreate would be a pure no-op, so the caller may leave the
 * volume — and anything mounting it — alone. `mismatch` is the case that MUST
 * recreate: the opts name a base generation, and `prepareOverlayDirs` deletes the
 * superseded generation's upper/work as it rotates, so a volume left at the old
 * opts wires the session to directories that no longer exist.
 *
 * The `o=` string is the whole comparison, deliberately. Labels are not part of it:
 * they are stamped for parity with the sweeps (which key on the volume NAME), so
 * treating a label drift as a mismatch would cost a Compose-stack teardown —
 * `releaseOverlayVolumeHolders` — for something that mounts identically.
 */
export async function readOverlayVolume(
  docker: Docker,
  spec: OverlaySpec,
): Promise<OverlayVolumeReading> {
  let info: { Options?: Record<string, string> | null };
  try {
    info = await docker.getVolume(spec.volumeName).inspect();
  } catch (err) {
    if (errStatus(err) === 404) return { state: "absent" };
    throw err;
  }
  const observedOpts = info.Options?.o;
  if (observedOpts === overlayDriverOpts(spec)) return { state: "match", observedOpts };
  return { state: "mismatch", ...(observedOpts ? { observedOpts } : {}) };
}

/** The verdict half of {@link readOverlayVolume}, for callers that only branch on it. */
export async function overlayVolumeState(
  docker: Docker,
  spec: OverlaySpec,
): Promise<OverlayVolumeState> {
  return (await readOverlayVolume(docker, spec)).state;
}

/**
 * Force-remove every container currently holding any of these volumes, so a
 * subsequent `docker volume rm` cannot fail with 409 (`volume is in use`).
 *
 * **Why this exists (the ops finding of 2026-08-19).** A session's Compose
 * siblings mount the same per-session overlay volumes the agent does. On a base
 * rotation the orchestrator reaps the superseded `g<M>/{upper,work}` and then
 * recreates the volumes against `g<N>` — but the siblings were still holding
 * them, the removal 409'd, and `docker volume create` on a name that already
 * exists returns the EXISTING volume and silently ignores the new driver opts.
 * Four production sessions ended up mounting an overlay whose upperdir and
 * workdir were unlinked: reads served a frozen base generation, writes failed
 * ENOENT, and the damage reached past the dep dir — `agent.install` failed and
 * gated Compose services never started.
 *
 * Only volumes that genuinely need recreating are passed here — a session whose
 * base did not rotate keeps its Compose stack running, which is what the
 * restart-agent path (docs/127) deliberately preserves. When the base DID rotate
 * the siblings are mounting reaped directories anyway, so removing them is not a
 * cost: a container freezes its mount set at create time, so nothing short of a
 * recreate could ever hand them the new generation.
 *
 * **The holder set is DYNAMIC, so this list must be derived fresh at the moment
 * it is used** (operator finding, 2026-08-19). While an operator was repairing a
 * production session, an unrelated `refreshSecrets` reconcile re-created that
 * session's `dev-1` and `assetgen-1` containers mid-window — a holder set read
 * minutes earlier was already stale. Hence: never cache this, and treat its
 * result as "true a moment ago", which is why {@link createOverlayVolume} loops.
 *
 * Returns the ids of the containers it removed, for the caller's log and to tell
 * the compose path that it owes the stack a reconcile.
 */
export async function releaseOverlayVolumeHolders(
  docker: Docker,
  volumeNames: string[],
  opts: { sessionId?: string } = {},
): Promise<string[]> {
  if (volumeNames.length === 0) return [];
  const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
  let holders: { Id: string; Names?: string[] }[];
  try {
    holders = await docker.listContainers({
      all: true,
      filters: { volume: volumeNames },
    });
  } catch (err) {
    // Not fatal here: `createOverlayVolume`'s verify-and-retry is what makes a
    // surviving holder loud, and it runs either way.
    console.warn(
      `${tag} could not list the containers holding ${volumeNames.join(", ")}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
  const released: string[] = [];
  for (const holder of holders) {
    try {
      await docker.getContainer(holder.Id).remove({ force: true });
      released.push(holder.Id);
    } catch (err) {
      // 404 — someone else removed it first, which is the outcome we wanted.
      if (errStatus(err) === 404) continue;
      console.warn(
        `${tag} could not remove ${holder.Names?.[0] ?? holder.Id} before recreating its overlay volume:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (released.length > 0) {
    console.log(
      `${tag} removed ${released.length} container(s) holding ${volumeNames.length} ` +
      `overlay volume(s) whose base generation rotated — they are recreated over the new generation`,
    );
  }
  return released;
}

/**
 * How many times {@link createOverlayVolume} will release-remove-create-verify
 * before giving up. Three, because the thing it is racing — an unrelated compose
 * reconcile re-creating a holder — is a bounded burst, not a standing condition:
 * each round the holder set is re-derived, so a reconcile has to land inside a
 * sub-second window three times running to exhaust it.
 */
const OVERLAY_CREATE_ATTEMPTS = 3;

/** Backoff between attempts, so a reconcile in flight has time to finish. */
const OVERLAY_CREATE_RETRY_MS = 250;

/** What `createOverlayVolume` did, for a caller that has to react to a recreate. */
export interface OverlayVolumeCreateResult {
  /** The volume already matched the spec and was left untouched. */
  unchanged: boolean;
  /** Ids of containers removed to free the volume — non-empty ⇒ the stack owes itself a reconcile. */
  releasedHolders: string[];
}

/**
 * Create the per-session `local`-driver `type=overlay` volume. The daemon performs
 * the overlay mount when the session container later mounts this volume at
 * `/workspace`. Serialized to avoid the overlay2 EBUSY hazard.
 *
 * Idempotent on name conflict: a volume that already exists with exactly the opts
 * this spec wants is left alone, and one that disagrees (a crash left it behind, or
 * the base rotated under it) is recreated — a stale overlay volume pointing at a
 * since-rebuilt base would otherwise wire the session to the wrong lowerdir.
 *
 * **Recreating is a converge loop, not one shot** (the 2026-08-19 ops finding plus
 * the operator's field correction). Two facts force it:
 *
 * 1. `createVolume` against a name that is already taken returns the EXISTING
 *    volume and ignores `DriverOpts` entirely — no error, no warning. So a removal
 *    that silently failed produced a volume naming a generation `prepareOverlayDirs`
 *    had just deleted, and the session ran on an overlay with no upperdir.
 * 2. The removal fails (409) whenever a container mounts the volume, and **the
 *    holder set is dynamic**: an unrelated compose reconcile (`refreshSecrets`, a
 *    plugin reconcile) can re-create a Compose sibling at any moment. Tearing the
 *    holders down and then creating merely shrinks that race — it does not close it.
 *
 * So each attempt re-derives the holders, removes them, recreates, and **verifies**
 * by re-inspecting; a mismatch retries. Only after {@link OVERLAY_CREATE_ATTEMPTS}
 * does it throw — a container that fails to create is visible and recoverable, one
 * that starts on a dead upper layer is neither, but a single transient reconcile
 * must not be what fails it.
 *
 * `releaseHolders` is opt-in because only the session dep-dir path owns its
 * volumes' holders. The plugin runtime overlay is shared between a service and a
 * CLI container by design (`ensurePluginRuntimeOverlay`), so it never asks for this.
 */
export async function createOverlayVolume(
  docker: Docker,
  spec: OverlaySpec,
  labels: Record<string, string> = {},
  opts: { releaseHolders?: boolean; sessionId?: string } = {},
): Promise<OverlayVolumeCreateResult> {
  return serialize(async () => {
    const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
    const releasedHolders: string[] = [];
    for (let attempt = 1; attempt <= OVERLAY_CREATE_ATTEMPTS; attempt++) {
      const state = await overlayVolumeState(docker, spec);
      if (state === "match") {
        return { unchanged: attempt === 1 && releasedHolders.length === 0, releasedHolders };
      }
      if (state === "mismatch") {
        // Derived HERE, on every attempt — see releaseOverlayVolumeHolders.
        if (opts.releaseHolders) {
          releasedHolders.push(
            ...(await releaseOverlayVolumeHolders(docker, [spec.volumeName], opts)),
          );
        }
        await removeVolumeIfExists(docker, spec.volumeName);
      }
      await docker.createVolume({
        Name: spec.volumeName,
        Driver: "local",
        DriverOpts: {
          type: "overlay",
          device: "overlay",
          o: overlayDriverOpts(spec),
        },
        Labels: { ...labels, [OVERLAY_MANAGED_LABEL]: "true" },
      });
      if (await overlayVolumeState(docker, spec) === "match") {
        return { unchanged: false, releasedHolders };
      }
      if (attempt < OVERLAY_CREATE_ATTEMPTS) {
        console.warn(
          `${tag} ${spec.volumeName} still names a different generation after attempt ${attempt} ` +
          `— a container re-took it mid-recreate; retrying`,
        );
        await new Promise((r) => setTimeout(r, OVERLAY_CREATE_RETRY_MS));
      }
    }
    throw new Error(
      `Overlay volume ${spec.volumeName} could not be recreated with the requested driver opts ` +
      `after ${OVERLAY_CREATE_ATTEMPTS} attempts (wanted "${overlayDriverOpts(spec)}"). Docker ` +
      `returns the pre-existing volume when the name is taken, so the removal kept failing — ` +
      `typically HTTP 409 because a container still mounts it.`,
    );
  });
}

/**
 * Greppable marker every verification failure carries. Exported so ops can grep
 * one literal and the tests can assert on one literal.
 */
export const OVERLAY_VERIFY_FAILURE = "overlay volume verification failed";

/**
 * Re-verify, at the moment the container has been BUILT with these mounts, that
 * every spec's volume is still the overlay we created — and throw if any is not.
 *
 * **Why this exists (nikzlabs/shipit#2495).** Verification used to happen once,
 * inside {@link createOverlayVolume}, and never again. That leaves a window: the
 * volume is created, and only ~twenty lines later does `docker createContainer`
 * reference it. Anything that removes the volume inside that window is invisible
 * to the create — and Docker does not fail a container that names a volume which
 * no longer exists. **It silently auto-creates one**, as a plain `local` volume
 * with NO driver options: empty, `root:root 0755`.
 *
 * The result is the worst shape a session can boot in. The dep dir mounts as an
 * empty directory the session uid cannot write, so `npm ci` EACCESes on its first
 * `mkdir`, `agent.install` never writes `/session-state/.install-done`, and every
 * `x-shipit-depends-on-install` service stays down — for the session's whole life,
 * with no in-container recovery (the path is a mount point, there is no `sudo`,
 * and the Compose siblings see the same directory through their own mounts). One
 * production session shipped exactly this: `…_overlay-dba27c31` carrying the
 * overlay-intended NAME with `Options: null`, beside a sibling dep dir that
 * mounted correctly.
 *
 * So the check is deliberately placed AFTER `createContainer` and BEFORE
 * `start()`: that is the first instant at which Docker's implicit creation has
 * already happened and is therefore observable, and the last instant at which
 * refusing costs nothing. A create that throws here is retried by
 * `createContainerForRunner` — whose failure path removes the container and every
 * overlay volume first, which is the load-bearing half: leaving the plain volume
 * behind would make the next attempt reuse it. A session that fails to create is
 * recoverable; one that boots wedged is not.
 *
 * Trigger-independent by construction: it does not care *what* removed the
 * volume, only that what the container was built with is not what we created.
 */
export async function assertOverlayVolumesMatch(
  docker: Docker,
  specs: readonly (OverlaySpec & { depDir?: string })[],
  opts: { sessionId?: string } = {},
): Promise<void> {
  const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
  for (const spec of specs) {
    const { state, observedOpts } = await readOverlayVolume(docker, spec);
    if (state === "match") continue;
    const held = state === "absent"
      ? "it does not exist at all"
      : observedOpts
        ? `it holds "${observedOpts}"`
        : "it holds NO driver options — the shape Docker leaves behind when it implicitly "
          + "creates a named volume that a container referenced but that no longer existed";
    throw new Error(
      `${tag} ${OVERLAY_VERIFY_FAILURE}: ${spec.volumeName}`
      + `${spec.depDir ? ` (dep dir "${spec.depDir}")` : ""} is not the overlay it was created as — `
      + `${held}, but this container was built to mount "${overlayDriverOpts(spec)}". `
      + `Refusing to start it: that mount would be an empty root-owned directory the session uid `
      + `cannot write, so agent.install could never succeed and the session would boot wedged.`,
    );
  }
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
    // 404 means it vanished between the inspect and here — nothing to do. Anything
    // else stays a warning rather than a throw because it is not yet a defect: the
    // create below re-reads what the daemon actually holds and throws THERE if the
    // removal did not take. Warning and then verifying catches every path that can
    // leave stale opts, not just this one.
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
