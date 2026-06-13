/**
 * Overlay dep store — session-lifecycle gating, scope, and GC source (docs/183).
 *
 * Reusable foundation shared by the (in-progress) dependency-directory overlay
 * design. It answers the design-agnostic lifecycle questions:
 *   - **Is this session overlay-backed?** (`isOverlayEligible`) — gated behind the
 *     `OVERLAY_DEP_STORE` kill switch (default ON; `OVERLAY_DEP_STORE=0`/`false`
 *     forces it off for one release). Repo-backed, non-ops sessions only.
 *   - **What `(repo, runtime)` scope does it belong to?** (`resolveOverlayScope`,
 *     `overlayRuntimeKey`) — the orchestrator-side runtime fingerprint.
 *   - **Which bases are live, for GC?** (`liveOverlayScopeHashes`).
 *
 * NOTE (docs/183 dep-dir pivot): the per-session mount-spec construction, the
 * worker snapshot pull, and the publish-after-install flow that previously lived
 * here were **whole-workspace-shaped** and have been removed — the dep-dir design
 * rebuilds them per declared dep dir (N mounts at `/workspace/<dep-dir>` subpaths,
 * a per-dep-dir snapshot, and a scope key extended by the dep-dir relpath). The
 * reused decision logic still lives in `overlay-base.ts` (the publish CAS) and the
 * reused mechanism in `overlay-volume.ts` (volume primitives). `liveOverlayScopeHashes`
 * here is the GC plumbing; its scope key gains the dep-dir relpath in that work.
 *
 * Everything here no-ops when `isOverlayEnabled()` returns false (the explicit
 * kill switch), so a deployment can force the plain `agent.install` path back.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import type { SessionInfo } from "../shared/types.js";
import { resolveShipitConfig, DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";
import { overlayScopeHash, overlayVolumeName, overlayBaseGenDir, type OverlaySpec } from "./overlay-volume.js";
import { readBasePointerByHash, type BasePointer, type OverlayScope } from "./overlay-base.js";
import { makeMarker, serializeMarker } from "../shared/install-marker.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";

// ---------------------------------------------------------------------------
// Feature flag + eligibility
// ---------------------------------------------------------------------------

/**
 * The overlay dep store is ON by default (SHI-127, canary-complete on the prod
 * VPS — see docs/183 FINDINGS.md). `OVERLAY_DEP_STORE` is retained for one
 * release as an explicit **kill switch**: setting it to `0` (or `false`) forces
 * the plain `agent.install` path back, so a self-hoster or prod can disable the
 * overlay without a redeploy if a regression surfaces. Any other value (unset,
 * `1`, `true`, anything else) keeps the default-on behavior. The knob is slated
 * for removal once default-on has soaked (SHI-127 step 3).
 */
export function isOverlayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OVERLAY_DEP_STORE;
  return v !== "0" && v !== "false";
}

/**
 * A session is overlay-eligible iff the feature is on AND it is a repo-backed,
 * non-ops session. Ops sessions are excluded because they may be pinned to a
 * non-default inspected build commit (`--shipit-source`); they run their install
 * into their own upper but must never publish or even route through the shared
 * base routing (plan §3). A session with no `remoteUrl` is authored locally and
 * has no `(repo, runtime)` scope to share.
 */
export function isOverlayEligible(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isOverlayEnabled(env)) return false;
  if (!session.remoteUrl) return false;
  if (session.kind === "ops") return false;
  return true;
}

/**
 * Orchestrator-side runtime fingerprint for the overlay base scope. Unlike
 * `install-runtime.ts:runtimeKey()` (which runs inside the worker and reads the
 * container's own libc/Node ABI), this must be computable BEFORE the container
 * exists, because the base scope picks the overlay `lowerdir` at create time.
 *
 * The session-worker image is fixed per deployment, and an image digest pins its
 * libc and Node ABI — so `<imageId>|<arch>` is an ABI-correct fingerprint without
 * needing the container's runtime introspection. A worker-image rebuild changes
 * `SESSION_WORKER_IMAGE_ID`/`IMAGE_DIGEST`, rotating the scope for free.
 */
export function overlayRuntimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const imageId = env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  return `${imageId}|${process.arch}`;
}

/** The `(repo, runtime)` base scope for an eligible session, or null if ineligible. */
export function resolveOverlayScope(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): OverlayScope | null {
  if (!isOverlayEligible(session, env)) return null;
  return { repoUrl: session.remoteUrl, runtimeKey: overlayRuntimeKey(env) };
}

// ---------------------------------------------------------------------------
// Per-dep-dir overlay specs (docs/183 dep-dir design)
// ---------------------------------------------------------------------------

/**
 * One overlay mount for one declared dep dir. Extends the daemon volume params
 * (`OverlaySpec`) with where it mounts in the container and which `(repo, runtime,
 * dep-dir)` scope it belongs to — everything Phase 3 (container wiring) and Phase 4
 * (per-dep-dir publish) need.
 */
export interface DepDirOverlaySpec extends OverlaySpec {
  /** The declared dep dir this overlay backs, relative to the workspace (e.g. `node_modules`). */
  depDir: string;
  /** Container path this volume mounts at — `/workspace/<depDir>`, nested under the workspace mount. */
  mountPath: string;
  /** Per-dep-dir scope (the base scope extended with `depDir`). */
  scope: OverlayScope;
  /** `overlayScopeHash(repo, runtime, depDir)` — the base dir + GC identity for this dep dir. */
  scopeHash: string;
  /**
   * The base generation this mount pins as its lowerdir (`g<N>`; 0 = the empty
   * cold-start dir). Recorded so post-create steps (the marker pre-stamp) can
   * verify the pointer they read describes the SAME base the daemon actually
   * mounted — a publish racing container creation moves the pointer's
   * generation, and stamping from the newer pointer would claim deps the
   * pinned (older) lowerdir doesn't hold.
   */
  generation: number;
  /**
   * The same lower/upper/work dirs as the daemon-host paths above, but as
   * **orchestrator-visible** paths (under the orchestrator's state dir, which is
   * the same volume the daemon mountpoint resolves to). The daemon's
   * `mount -t overlay` fails with ENOENT unless all three dirs exist, and
   * nothing else creates them — a cold scope has no published base (so no
   * `overlay-base/<hash>/`), and the per-session `upper`/`work` dirs are born
   * here. Container creation mkdirs these right before creating the volume.
   * Absent when the populator has no orchestrator state dir (unit-test/mock
   * configurations).
   */
  orchDirs?: { lowerdir: string; upperdir: string; workdir: string };
}

/**
 * Build **N** overlay specs — one per declared dep dir — for an eligible session.
 * Pure: given the base `(repo, runtime)` scope, the dep dirs (from `agent.dep-dirs`),
 * and the daemon-host mountpoint of the workspace **state** volume (where the
 * `overlay-base/` and `sessions/` subtrees live), it composes the absolute
 * lowerdir/upperdir/workdir paths and the `/workspace/<dep-dir>` mount target. No
 * Docker, no filesystem — the volume create/mount itself is Phase 3.
 *
 * Each dep dir gets its own base (`overlay-base/<scopeHash>`, scopeHash keyed on the
 * dep-dir relpath) and its own per-session upper/work under
 * `sessions/<id>/overlay/<scopeHash>/` — so two dep dirs never share an upperdir
 * (the kernel forbids it) and a runtime change rotates the scope (and thus the upper)
 * for free.
 */
export function buildOverlaySpecs(args: {
  sessionId: string;
  scope: Pick<OverlayScope, "repoUrl" | "runtimeKey">;
  depDirs: string[];
  /** Absolute daemon-host mountpoint of the workspace state volume (`shipit-workspace`). */
  volumeMountpoint: string;
  /**
   * Orchestrator-visible root of the SAME state volume (the orchestrator's
   * `stateDir`, e.g. `/workspace`). When provided, each spec carries
   * `orchDirs` — the lower/upper/work dirs as paths the orchestrator can
   * `mkdir` before the daemon mounts the overlay (see `DepDirOverlaySpec.orchDirs`).
   */
  stateRoot?: string;
  /**
   * Resolve the current base generation for a per-dep-dir scope hash — normally
   * backed by `readBasePointer` (the pointer's `generation`). Bases are
   * generational (`overlay-base/<hash>/g<N>`, see `overlayBaseGenDir`): a mount
   * pins ONE immutable generation, chosen here at spec-build time. Defaults to
   * `0` — the empty cold-start generation, created on demand at container
   * create — when absent or when the resolver has no pointer.
   */
  generationForScope?: (scopeHash: string) => number;
}): DepDirOverlaySpec[] {
  const { sessionId, scope, depDirs, volumeMountpoint, stateRoot } = args;
  const generationForScope = args.generationForScope ?? (() => 0);
  return depDirs.map((depDir) => {
    const scopeHash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, depDir);
    const generation = generationForScope(scopeHash);
    const sessionOverlayDir = path.join(volumeMountpoint, "sessions", sessionId, "overlay", scopeHash);
    const orchSessionOverlayDir = stateRoot
      ? path.join(stateRoot, "sessions", sessionId, "overlay", scopeHash)
      : undefined;
    return {
      volumeName: overlayVolumeName(sessionId, depDir),
      lowerdir: overlayBaseGenDir(volumeMountpoint, scopeHash, generation),
      upperdir: path.join(sessionOverlayDir, "upper"),
      workdir: path.join(sessionOverlayDir, "work"),
      depDir,
      mountPath: path.posix.join("/workspace", depDir),
      scope: { repoUrl: scope.repoUrl, runtimeKey: scope.runtimeKey, depDir },
      scopeHash,
      generation,
      ...(stateRoot && orchSessionOverlayDir
        ? {
            orchDirs: {
              lowerdir: overlayBaseGenDir(stateRoot, scopeHash, generation),
              upperdir: path.join(orchSessionOverlayDir, "upper"),
              workdir: path.join(orchSessionOverlayDir, "work"),
            },
          }
        : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// GC live source
// ---------------------------------------------------------------------------

/**
 * The set of overlay-base scope-hashes any *resumable* session could mount —
 * the authoritative liveness source the disk-janitor's `sweepOrphanedOverlayBases`
 * needs (plan §4: an mtime fallback alone could reap a base out from under a live
 * mount). A session is resumable unless it has been disk-evicted/archived; we
 * include every non-evicted repo-backed session (its bases would be re-mounted on
 * resume) for the current runtime fingerprint. Returns an empty set when the
 * feature is killed (`OVERLAY_DEP_STORE=0`/`false`), so the janitor sweep stays
 * inert under the kill switch.
 *
 * Under the dep-dir design there are **N bases per session** — one per declared dep
 * dir — so the live-set enumerates `(session × dep dir)`: for each resumable session
 * we resolve its declared dep dirs (`resolveDepDirs`, normally each session's
 * `agent.dep-dirs`) and add `overlayScopeHash(repo, runtime, depDir)` for each. The
 * resolver is injected so this stays pure and unit-testable; it is only consulted
 * when the feature is on (the kill-switch gate short-circuits first, so no config
 * reads happen when the store is killed off).
 */
export function liveOverlayScopeHashes(
  sessions: SessionInfo[],
  resolveDepDirs: (session: SessionInfo) => string[],
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const live = new Set<string>();
  if (!isOverlayEnabled(env)) return live;
  const runtimeKey = overlayRuntimeKey(env);
  for (const s of sessions) {
    if (!s.remoteUrl) continue;
    if (s.kind === "ops") continue;
    if (s.diskTier === "evicted") continue;
    for (const depDir of resolveDepDirs(s)) {
      live.add(overlayScopeHash(s.remoteUrl, runtimeKey, depDir));
    }
  }
  return live;
}

/**
 * Concrete `resolveDepDirs` for `liveOverlayScopeHashes` — a session's declared
 * `agent.dep-dirs` (read from its workspace `shipit.yaml`). Falls back to the
 * default `[node_modules]` if the config can't be read, and to `[]` if the session
 * has no workspace dir on disk (nothing to mount). Kept here (not inline at the
 * wiring site) so the fs coupling is localized and testable.
 */
export function depDirsForSession(session: Pick<SessionInfo, "workspaceDir">): string[] {
  if (!session.workspaceDir) return [];
  try {
    return resolveShipitConfig(session.workspaceDir).agent.depDirs;
  } catch {
    return [...DEFAULT_DEP_DIRS];
  }
}

/**
 * Contextual dep-dir validation against the host clone (docs/183 Phase 3b) — the
 * checks the pure config parser (Phase 1) couldn't make because it has no
 * workspace/git context. Keep a declared dep dir only when **both** hold:
 *
 *  - its **parent directory exists** in the clone — so the daemon nests the overlay
 *    onto a real parent (the spike showed it will `mkdir -p` an absent parent, but
 *    we must not rely on that — an invented parent means the source tree the user
 *    expects at that path simply isn't there); and
 *  - the path is **git-ignored** — i.e. a build artifact, never tracked source.
 *    Overlaying a tracked path would shadow real committed source with a foreign or
 *    empty base, corrupting the working tree.
 *
 * A dropped dir just falls back to a plain install for that path — never fatal. Any
 * error (not a git repo, git failure) drops ALL dep dirs (conservative → plain
 * install), so a broken clone can never silently overlay the wrong thing.
 */
export async function validDepDirsForOverlay(
  depDirs: string[],
  workspaceDir: string,
): Promise<string[]> {
  if (depDirs.length === 0) return [];
  // Parent must exist on disk (dirname of `node_modules` is `.` → the workspace root).
  const parentExists = depDirs.filter((d) => fs.existsSync(path.join(workspaceDir, path.dirname(d))));
  if (parentExists.length === 0) return [];
  try {
    // Query each dir in both bare and trailing-slash forms. A directory-only
    // .gitignore pattern (`node_modules/` — the common form) only matches the
    // bare name once the directory exists on disk, and a fresh clone never has
    // its dep dirs materialized yet — so the bare query alone silently drops
    // every dep dir on exactly the sessions the overlay targets. The slash
    // form matches the pattern regardless of on-disk presence.
    const queries = parentExists.flatMap((d) => [d, `${d}/`]);
    const ignored = new Set(await simpleGit(workspaceDir).checkIgnore(queries));
    return parentExists.filter((d) => ignored.has(d) || ignored.has(`${d}/`));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// pnpm detection + shared store (docs/197 Part 2)
// ---------------------------------------------------------------------------

/**
 * Subtree (under the workspace state volume) holding the shared pnpm stores,
 * keyed by runtime hash: `pnpm-store/<runtimeKey-hash>/`. Lives on the SAME
 * state volume as each session's workspace clone, so pnpm's store→`node_modules`
 * hardlinks stay within one superblock — the whole point of the store (an overlay
 * `node_modules` forces those links across the overlayfs boundary, hits EXDEV, and
 * silently degrades to a 464 MB full copy per session; canary FINDINGS).
 */
export const PNPM_STORE_SUBDIR = "pnpm-store";

/**
 * Short, stable hash of the runtime fingerprint, used to name the shared pnpm
 * store dir. One store per runtime so a worker-image rebuild rotates it for free
 * (same ABI argument as overlay scope rotation, docs/183 precondition (c)) and the
 * disk-janitor can reap stores keyed on a since-superseded runtime. 16 hex chars,
 * matching `overlayScopeHash` / `repoUrlToHash` width.
 */
export function pnpmStoreHash(runtimeKey: string): string {
  return crypto.createHash("sha256").update(runtimeKey).digest("hex").slice(0, 16);
}

/**
 * Orchestrator-visible host path of the shared pnpm store for the CURRENT runtime:
 * `<stateDir>/pnpm-store/<runtimeKey-hash>`. Created lazily at container-create
 * time (the daemon would auto-create the Subpath source, but we mkdir it so dev/
 * bind mode works too). The container mounts it at `PNPM_STORE_CONTAINER_PATH` and
 * `npm_config_store_dir` points pnpm there.
 */
export function pnpmStoreDirForRuntime(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir, PNPM_STORE_SUBDIR, pnpmStoreHash(overlayRuntimeKey(env)));
}

/** Read the trimmed `packageManager` field from a workspace `package.json`, or null. */
function readPackageManagerField(workspaceDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, "package.json"), "utf-8")) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === "string" && pkg.packageManager.trim()) {
      return pkg.packageManager.trim();
    }
  } catch {
    /* missing/invalid package.json — no signal */
  }
  return null;
}

/**
 * Decisive pnpm signal from the `agent.install` command list, or null if the list
 * names no recognized package manager. A `pnpm` invocation anywhere → pnpm (it is
 * literally what we will run); otherwise an `npm`/`yarn`/`bun` invocation is a
 * decisive NON-pnpm signal that outranks a stray lockfile (plan §"pnpm detection",
 * precedence 3 > 2).
 */
function pnpmSignalFromInstall(install: string[]): boolean | null {
  let sawNonPnpm = false;
  for (const cmd of install) {
    if (/(?:^|[\s;&|(])pnpm(?:[\s;&|)]|$)/.test(cmd)) return true;
    if (/(?:^|[\s;&|(])(?:npm|yarn|bun)(?:[\s;&|)]|$)/.test(cmd)) sawNonPnpm = true;
  }
  return sawNonPnpm ? false : null;
}

/**
 * docs/197 Part 2 — is this workspace a pnpm repo? The single orchestrator-side
 * decision both the overlay skip (`prepareOverlaySpecs` → []) and the shared-store
 * mount (`preparePnpmStore`) derive from, so the two can never disagree. Signals,
 * in precedence order (first DECISIVE one wins):
 *
 *   1. `packageManager` field in `package.json` — the corepack standard.
 *      Authoritative either way when present: `pnpm…` → pnpm; any other manager
 *      (`npm@`/`yarn@`/`bun@`) → NOT pnpm, even with a stray `pnpm-lock.yaml`.
 *   2. A recognized package-manager invocation in `agent.install` — truthful by
 *      construction. `pnpm` → pnpm; a non-pnpm manager → NOT pnpm. Outranks the
 *      lockfile (it is what actually runs), covers repos with no lockfile yet.
 *   3. `pnpm-lock.yaml` at the workspace root — the conventional fallback signal,
 *      weakest because a since-changed manager can leave one behind.
 *
 * Any unreadable input degrades that signal to "absent" → falls through, so a
 * broken workspace is never mis-routed to pnpm. Resolves the canonical conflict
 * (both `package-lock.json` and `pnpm-lock.yaml` present) as 1 > 2 > 3.
 */
export function isPnpmRepo(workspaceDir: string): boolean {
  // Signal 1 — packageManager field (decisive whichever manager it names).
  const pm = readPackageManagerField(workspaceDir);
  if (pm !== null) return pm.startsWith("pnpm");
  // Signal 2 — install commands (decisive when they name a known manager).
  let install: string[];
  try {
    install = resolveShipitConfig(workspaceDir).agent.install;
  } catch {
    install = [];
  }
  const installSignal = pnpmSignalFromInstall(install);
  if (installSignal !== null) return installSignal;
  // Signal 3 — lockfile fallback.
  return fs.existsSync(path.join(workspaceDir, "pnpm-lock.yaml"));
}

// ---------------------------------------------------------------------------
// Base-hit marker pre-stamp (the "main unchanged ≈ skip" closer)
// ---------------------------------------------------------------------------

/**
 * Write a `.shipit/.install-done` marker into a FRESH clone whose overlay
 * mounts a base that already holds the right deps — so the worker's `/install`
 * gate skips and a "main unchanged" session pays ~0 instead of a full install.
 *
 * Measured before this existed (FINDINGS.md): a same-commit session over a
 * populated 66 MB base still ran a full npm install (2.6 s) AND copy-up'd the
 * entire tree into its private upper — the marker lives in the host clone, not
 * the base, so a fresh clone never has one.
 *
 * The stamp is written ONLY when every condition the worker gate would check is
 * provably satisfied by the mounted base:
 *  - no marker exists yet (never clobber a real one — a mismatched existing
 *    marker must keep forcing a reinstall);
 *  - EVERY mounted dep dir's pointer matches this session's deps — either by
 *    exact commit (the base holds exactly this commit's install) OR, when the
 *    pointer carries a `depsHash` (docs/198), by content: the pointer's recorded
 *    dependency content key equals this workspace's, so a base built at a
 *    DIFFERENT commit with byte-identical dep files still skips. A pointer
 *    without a `depsHash` (legacy) or a workspace whose install isn't content-
 *    keyable falls back to exact-commit-only;
 *  - each pointer still names the generation the mount actually pinned (a
 *    publish racing container creation advances the pointer; stamping from the
 *    newer pointer would claim deps the pinned older lowerdir doesn't hold);
 *  - the pointer carries the publisher's marker stamp (worker runtime key +
 *    install commands), the commands equal this session's `agent.install`, and
 *    all dep dirs agree on the runtime key.
 *
 * Anything off → no stamp → the worker gate misses → a real install runs (the
 * always-safe fallback). The worker gate stays the single decision point: it
 * re-derives its own runtime key and re-checks the overlay-emptiness
 * contradiction (overlay-dep-check.ts), so a wrong pre-stamp can only ever be
 * as harmful as a stale-but-matching marker — which those checks catch.
 *
 * Called from container creation AFTER the container started (the mount is
 * pinned, so the generation re-read is race-correct) and BEFORE the runner's
 * worker URL resolves (so `/install` cannot observe a half-written marker).
 */
export async function preStampInstallMarker(args: {
  /** Orchestrator-visible state dir holding `overlay-base-meta/` (pointers). */
  stateDir: string;
  /** The session's host clone (where `.shipit/.install-done` lives). */
  workspaceDir: string;
  /** The overlay specs the container was created with. */
  specs: DepDirOverlaySpec[];
  /** Pointer reader — injected for tests; defaults to the real by-hash read. */
  readPointer?: (stateDir: string, scopeHash: string) => BasePointer | null;
}): Promise<boolean> {
  const { stateDir, workspaceDir, specs } = args;
  if (specs.length === 0) return false;
  const readPointer = args.readPointer ?? readBasePointerByHash;

  const markerFile = path.join(workspaceDir, ".shipit", ".install-done");
  if (fs.existsSync(markerFile)) return false;

  let head: string;
  try {
    head = (await simpleGit(workspaceDir).revparse(["HEAD"])).trim();
  } catch {
    return false;
  }
  if (!head) return false;

  let installCommands: string[];
  let installInputs: string[] | null;
  try {
    const agent = resolveShipitConfig(workspaceDir).agent;
    installCommands = agent.install;
    installInputs = agent.installInputs;
  } catch {
    return false;
  }
  if (installCommands.length === 0) return false;

  // docs/198 — the content key for THIS workspace's dep files. Computed up front
  // so the per-spec gate can take the content path: a pointer whose recorded
  // `depsHash` equals this widens the stamp to a base built at a DIFFERENT commit
  // (the "main advanced by a non-dep commit" scenario the exact-commit gate
  // missed entirely). Also stamped into the marker we write, so a still-later
  // session can content-match this one (the worker gate re-derives + re-checks).
  const depsHash = computeInstallDepsHash(workspaceDir, installCommands, installInputs);

  let runtimeKey: string | null = null;
  for (const spec of specs) {
    const ptr = readPointer(stateDir, spec.scopeHash);
    if (!ptr?.marker) return false;
    // Either the base was built at THIS exact commit (the original path), or it
    // holds byte-identical dep inputs (docs/198 content path). Both sides must
    // carry a real hash for the content path — a `null`/absent hash never
    // content-matches, so a legacy pointer (no `depsHash`) or a non-recognized
    // install degrades cleanly to exact-commit-only, i.e. today's behavior.
    const commitMatches = ptr.commit === head;
    const contentMatches =
      depsHash !== null && typeof ptr.marker.depsHash === "string" && ptr.marker.depsHash === depsHash;
    if (!commitMatches && !contentMatches) return false;
    // Generation is pinned by the mount regardless of which match fired — a
    // publish that advanced the pointer past the lowerdir we mounted must still
    // block (we'd otherwise claim deps the older pinned generation doesn't hold).
    if (ptr.generation !== spec.generation) return false;
    const cmds = ptr.marker.installCommands;
    if (cmds.length !== installCommands.length || !cmds.every((c, i) => c === installCommands[i])) {
      return false;
    }
    if (runtimeKey === null) runtimeKey = ptr.marker.runtimeKey;
    else if (runtimeKey !== ptr.marker.runtimeKey) return false;
  }
  if (!runtimeKey) return false;

  // sourceCommit is THIS session's HEAD (not the pointer's) — truthful for the
  // marker we're writing into this workspace, even when the content path matched
  // a base built at a different commit.
  const marker = makeMarker(
    { sourceCommit: head, runtimeKey, installCommands, depsHash },
    new Date().toISOString(),
  );
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, serializeMarker(marker));
  return true;
}
