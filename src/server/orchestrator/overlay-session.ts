/**
 * Overlay dep store — session-lifecycle orchestration (docs/183 Phase 3/4).
 *
 * This is the connective tissue between the two proven halves of the feature:
 *   - the *mechanism* (`overlay-volume.ts`): per-session `local` `type=overlay`
 *     Docker volume the daemon mounts at `/workspace`;
 *   - the *decision* (`overlay-base.ts`): the rolling-base publish
 *     compare-and-swap keyed on `main`-commit ancestry.
 *
 * It answers the lifecycle questions:
 *   - **Is this session overlay-backed?** (`isOverlayEligible`) — gated behind the
 *     `OVERLAY_DEP_STORE` feature flag (default OFF), so production is byte-for-byte
 *     unchanged until a deployment opts in. Repo-backed, non-ops sessions only.
 *   - **What base does it mount, and where do its upper/work layers live?**
 *     (`buildOverlaySpec`) — resolves the daemon-host absolute paths the overlay
 *     volume needs, ensures the (possibly-empty, cold-start v0) base dir exists,
 *     and resets the scratch workdir while PRESERVING the per-session upper across
 *     container recreations (the upper holds the session's `.git` and uncommitted
 *     work — wiping it on restart would be data loss).
 *   - **May this install advance the shared base?** (`publishOverlayBaseAfterInstall`)
 *     — pulls the worker-exported merged snapshot, builds a `PublishCandidate`, and
 *     defers the actual ordering decision to `publishBase`. The strong correctness
 *     guard is `sourceIsDefaultBranch` (HEAD === the repo's current default commit):
 *     any user/agent commit moves HEAD off the default tip, so a mid-session publish
 *     self-excludes.
 *   - **Which bases are live, for GC?** (`liveOverlayScopeHashes`).
 *
 * Everything here no-ops unless `isOverlayEnabled()` returns true, so importing it
 * is behavior-preserving.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type Docker from "dockerode";

import type { SessionInfo } from "../shared/types.js";
import {
  overlayBaseDir,
  overlayScopeHash,
  overlayVolumeName,
  resolveVolumeMountpoint,
  type OverlaySpec,
} from "./overlay-volume.js";
import {
  publishBase,
  readBasePointer,
  type IsAncestorFn,
  type OverlayScope,
  type PublishCandidate,
  type PublishResult,
} from "./overlay-base.js";

// ---------------------------------------------------------------------------
// Feature flag + eligibility
// ---------------------------------------------------------------------------

/**
 * The overlay dep store is OFF by default. A deployment opts in by setting
 * `OVERLAY_DEP_STORE=1` (or `true`). Until then every branch in this module is
 * inert and sessions use the plain `agent.install` path unchanged. The flag
 * exists because the container-runtime paths (the daemon overlay mount, the
 * compose wiring) are only verifiable on real Docker overlay across the host
 * matrix — see docs/183 §0 / FINDINGS.md.
 */
export function isOverlayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OVERLAY_DEP_STORE;
  return v === "1" || v === "true";
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

/** The `(repo, runtime)` scope for an eligible session, or null if ineligible. */
export function resolveOverlayScope(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): OverlayScope | null {
  if (!isOverlayEligible(session, env)) return null;
  return { repoUrl: session.remoteUrl, runtimeKey: overlayRuntimeKey(env) };
}

// ---------------------------------------------------------------------------
// Spec construction
// ---------------------------------------------------------------------------

/** Per-session subtree (under the state dir) holding the overlay upper/work. */
function sessionOverlayDirs(stateDir: string, sessionId: string): {
  upperDir: string;
  workDir: string;
} {
  const subtree = path.join(stateDir, "sessions", sessionId);
  return {
    upperDir: path.join(subtree, "overlay-upper"),
    workDir: path.join(subtree, "overlay-work"),
  };
}

export interface BuildOverlaySpecDeps {
  docker: Docker;
  /** Orchestrator-visible root of the `shipit-workspace` named volume. */
  stateDir: string;
  /** Name of the `shipit-workspace` state volume (its daemon-host mountpoint
   *  is the prefix for every absolute overlay path). */
  workspaceVolume: string;
  /** Injectable for tests — defaults to the real `docker volume inspect`. */
  resolveMountpoint?: (docker: Docker, name: string) => Promise<string>;
}

/**
 * Build the `OverlaySpec` for an eligible session: resolve daemon-host absolute
 * paths for the shared base (lowerdir), the per-session upper, and the scratch
 * workdir, and ensure those dirs exist on disk.
 *
 * Path duality: the orchestrator container sees these dirs under `stateDir`; the
 * daemon mounts them via the workspace volume's daemon-host mountpoint. They are
 * the same physical dirs on the same volume, so the spec's absolute paths are
 * `<mountpoint>/<path relative to stateDir>`.
 *
 * Layer lifecycle:
 *   - **lowerdir** (`overlay-base/<scope-hash>`): created empty for a cold-start
 *     v0; once a base is published it holds the rolling base contents (swapped
 *     atomically by `copySnapshotToBase`).
 *   - **upperdir** (`sessions/<id>/overlay-upper`): created if absent, **never
 *     wiped** — it is the durable session storage for an overlay session (its
 *     `.git`, commits, and uncommitted work live only here, since the base
 *     excludes `.git`).
 *   - **workdir** (`sessions/<id>/overlay-work`): overlay scratch; reset to empty
 *     on every mount (the kernel requires an empty workdir).
 */
export async function buildOverlaySpec(
  session: Pick<SessionInfo, "id">,
  scope: OverlayScope,
  deps: BuildOverlaySpecDeps,
): Promise<OverlaySpec> {
  const scopeHash = overlayScopeHash(scope.repoUrl, scope.runtimeKey);
  const resolve = deps.resolveMountpoint ?? resolveVolumeMountpoint;
  const mountpoint = await resolve(deps.docker, deps.workspaceVolume);

  // Base contents dir — empty for a cold-start v0; ensure it exists so the
  // daemon's `mount -t overlay` has a real lowerdir to point at.
  const baseContentsDir = overlayBaseDir(deps.stateDir, scopeHash);
  await fs.mkdir(baseContentsDir, { recursive: true });

  const { upperDir, workDir } = sessionOverlayDirs(deps.stateDir, session.id);
  // Upper persists across container recreations (idle eviction / restart-agent /
  // reconnect) — wiping it would drop the session's .git and uncommitted work.
  await fs.mkdir(upperDir, { recursive: true });
  // Workdir must be empty on every mount — reset it.
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const toDaemonPath = (p: string): string => {
    const rel = path.relative(deps.stateDir, p);
    // The mapping is only valid when `p` is genuinely under `stateDir` AND
    // `stateDir` is the orchestrator's mount of the same named volume whose
    // daemon-host `mountpoint` we resolved. We can't cheaply verify the volume
    // identity, but a relative path that escapes (`..`) or is absolute means
    // `stateDir` isn't the volume root (e.g. a misconfigured `SHIPIT_STATE_DIR`
    // not on `WORKSPACE_VOLUME`) — bail so `prepareOverlaySpec` falls back to
    // plain install rather than wiring the overlay to a bogus daemon path.
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `overlay stateDir ${deps.stateDir} is not an ancestor of ${p} — ` +
          `SHIPIT_STATE_DIR must be the orchestrator mount of WORKSPACE_VOLUME`,
      );
    }
    return path.posix.join(mountpoint, ...rel.split(path.sep));
  };

  return {
    volumeName: overlayVolumeName(session.id),
    lowerdir: toDaemonPath(baseContentsDir),
    upperdir: toDaemonPath(upperDir),
    workdir: toDaemonPath(workDir),
  };
}

// ---------------------------------------------------------------------------
// Snapshot fetch + extract
// ---------------------------------------------------------------------------

/**
 * Stream `GET <workerUrl>/workspace/snapshot` (the merged-workspace tar, `.git`
 * excluded) into `destDir` via `tar -x`. The merged view already resolved every
 * whiteout, so the extracted tree is exactly what the next base should contain.
 * Rejects on a non-2xx response or a non-zero tar exit so a truncated archive
 * never becomes a base.
 */
export async function fetchSnapshotToDir(workerUrl: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const url = new URL("/workspace/snapshot", workerUrl);

  await new Promise<void>((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`snapshot GET failed: HTTP ${res.statusCode ?? "?"}`));
        return;
      }
      const tar = spawn("tar", ["-x", "-f", "-", "-C", destDir], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let tarErr = "";
      tar.stderr?.on("data", (c: Buffer) => { tarErr += c.toString(); });
      tar.on("error", reject);
      tar.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extract exited ${code ?? "?"}: ${tarErr.trim()}`));
      });
      res.on("error", (err) => { tar.stdin?.destroy(); reject(err); });
      if (tar.stdin) res.pipe(tar.stdin);
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Publish after install
// ---------------------------------------------------------------------------

export interface PublishAfterInstallDeps {
  stateDir: string;
  /** Base URL of the session worker (e.g. `http://172.17.0.2:9100`). */
  workerUrl: string;
  /** `git merge-base --is-ancestor` over the bare cache. */
  isAncestor: IsAncestorFn;
  /** The repo's CURRENT default-branch commit, resolved from the bare cache. */
  currentDefaultCommit: string | null;
  /** Override snapshot fetch (tests). Defaults to `fetchSnapshotToDir`. */
  fetchSnapshot?: (workerUrl: string, destDir: string) => Promise<void>;
  /** Override the worker HEAD lookup (tests). Defaults to the worker endpoint. */
  fetchHeadCommit?: (workerUrl: string) => Promise<string | null>;
  depthCap?: number;
}

/** Default worker HEAD lookup — `GET /workspace/head-commit`. */
async function fetchHeadCommitFromWorker(workerUrl: string): Promise<string | null> {
  const url = new URL("/workspace/head-commit", workerUrl);
  return new Promise<string | null>((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode >= 400) { resolve(null); return; }
        try {
          const parsed = JSON.parse(body) as { commit?: string | null };
          resolve(parsed.commit ?? null);
        } catch { resolve(null); }
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * After a successful (exit-0) install on an eligible session, attempt to advance
 * the shared rolling base. Returns the `PublishResult`, or null when the session
 * isn't even a publish candidate (so we skip the expensive snapshot pull).
 *
 * Correctness: we set `preUserInstall: true` because this runs synchronously
 * right after `agent.install`, before the first agent turn. The decisive guard is
 * `sourceIsDefaultBranch` — HEAD must equal the repo's current default commit. A
 * user/agent commit (auto-committed each turn) moves HEAD off the default tip, so
 * a stale or diverged session declines via `publishBase`'s ancestry CAS. We never
 * throw into the install path: a publish failure must not fail the session.
 */
export async function publishOverlayBaseAfterInstall(
  session: Pick<SessionInfo, "id" | "remoteUrl" | "kind">,
  scope: OverlayScope,
  deps: PublishAfterInstallDeps,
): Promise<PublishResult | null> {
  const fetchHead = deps.fetchHeadCommit ?? fetchHeadCommitFromWorker;
  const commit = await fetchHead(deps.workerUrl);
  if (!commit) return null;

  const sourceIsDefaultBranch =
    deps.currentDefaultCommit !== null && commit === deps.currentDefaultCommit;
  if (!sourceIsDefaultBranch) {
    // Not a publish candidate (source isn't the default tip) — don't pull a
    // snapshot we'd only discard. Surface the existing pointer for the caller's logs.
    return { outcome: "skipped-ineligible", pointer: readBasePointer(deps.stateDir, scope) };
  }

  // Peek the current base before exporting the (whole-workspace) snapshot: when
  // the base is already at this commit, `publishBase` would return `skipped-equal`
  // after we'd uselessly tarred + extracted the entire merged tree. A marker-skip
  // install on an unchanged default branch is the steady-state case, so short-
  // circuit here to avoid re-exporting a snapshot every activation.
  const existing = readBasePointer(deps.stateDir, scope);
  if (existing?.commit === commit) {
    return { outcome: "skipped-equal", pointer: existing };
  }

  const snapshotDir = path.join(
    deps.stateDir,
    "overlay-snapshots",
    `${session.id}-${overlayScopeHash(scope.repoUrl, scope.runtimeKey)}`,
  );
  await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
  const fetchSnapshot = deps.fetchSnapshot ?? fetchSnapshotToDir;
  try {
    await fetchSnapshot(deps.workerUrl, snapshotDir);
    const candidate: PublishCandidate = {
      commit,
      exitCode: 0,
      preUserInstall: true,
      sourceIsDefaultBranch: true,
      snapshotDir,
    };
    return await publishBase({
      stateDir: deps.stateDir,
      scope,
      candidate,
      isAncestor: deps.isAncestor,
      currentDefaultCommit: deps.currentDefaultCommit ?? undefined,
      depthCap: deps.depthCap,
    });
  } finally {
    await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// GC live source
// ---------------------------------------------------------------------------

/**
 * The set of overlay-base scope-hashes any *resumable* session could mount —
 * the authoritative liveness source the disk-janitor's `sweepOrphanedOverlayBases`
 * needs (plan §4: an mtime fallback alone could reap a base out from under a live
 * mount). A session is resumable unless it has been disk-evicted/archived; we
 * include every non-evicted repo-backed session (its base would be re-mounted on
 * resume) for the current runtime fingerprint. Returns an empty set when the
 * feature is off, so the janitor sweep stays inert until a deployment opts in.
 */
export function liveOverlayScopeHashes(
  sessions: SessionInfo[],
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const live = new Set<string>();
  if (!isOverlayEnabled(env)) return live;
  const runtimeKey = overlayRuntimeKey(env);
  for (const s of sessions) {
    if (!s.remoteUrl) continue;
    if (s.kind === "ops") continue;
    if (s.diskTier === "evicted") continue;
    live.add(overlayScopeHash(s.remoteUrl, runtimeKey));
  }
  return live;
}
