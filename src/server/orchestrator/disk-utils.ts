/**
 * Shared disk-reclaim helpers used by both the startup janitor
 * (`startup-janitor.ts`) and the steady-state disk-tier escalation ladder
 * (`tier-escalation.ts`): free/total-bytes probes, disk-pressure watermark
 * resolution, the pacing/throttle primitive, the docker spawner, and the
 * error-message extractor.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OVERLAY_SESSION_SUBDIR } from "./overlay-session.js";
import {
  SESSION_STATE_SUBDIR,
  SESSION_WORKSPACE_SUBDIR,
  INSTALL_MARKER_FILE,
  sessionStateDirForWorkspace,
  sessionSharedStateDir,
} from "./session-state-dir.js";

/**
 * docs/161 — default free-disk probe for the disk-pressure pass. Returns bytes
 * available to an unprivileged user on the filesystem holding `dir`, or null if
 * `statfs` is unavailable / errors (the pressure path then no-ops gracefully).
 */
export async function statfsFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * docs/161 — total size (bytes) of the filesystem holding `dir`, or null if
 * `statfs` is unavailable / errors. Backs the fraction-of-disk pressure
 * watermarks (`DISK_FREE_LOW_PCT` / `DISK_FREE_HIGH_PCT`), which are portable
 * across host disk sizes in a way the absolute `*_BYTES` vars are not.
 */
export async function statfsTotalBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.blocks * st.bsize;
  } catch {
    return null;
  }
}

/**
 * docs/161 — resolve the effective disk-pressure byte watermarks from the
 * configured inputs. Each watermark is resolved independently:
 *   - an explicit `*Bytes` value always wins (backward compat), otherwise
 *   - a `*Pct` fraction (0..1) is multiplied by the host's total disk size.
 * A watermark stays `undefined` when neither is set (or a `*Pct` is given but
 * `totalBytes` is unknown), which leaves the pressure override disabled — its
 * gate already no-ops unless BOTH watermarks resolve.
 */
export function resolveDiskWatermarks(inputs: {
  lowBytes?: number;
  highBytes?: number;
  lowPct?: number;
  highPct?: number;
  totalBytes: number | null;
}): { diskFreeLow?: number; diskFreeHigh?: number } {
  const resolve = (bytes: number | undefined, pct: number | undefined): number | undefined => {
    if (bytes !== undefined) return bytes;
    if (pct !== undefined && inputs.totalBytes !== null) return pct * inputs.totalBytes;
    return undefined;
  };
  return {
    diskFreeLow: resolve(inputs.lowBytes, inputs.lowPct),
    diskFreeHigh: resolve(inputs.highBytes, inputs.highPct),
  };
}

export function getMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Regenerable children of a session root (`sessions/<id>/`) that disk reclaim
 * may delete: the git `workspace/` checkout (re-clones from the bare cache) and
 * the docs/183 `overlay/` upperdirs (pure install-delta cache; rebuilds on the
 * next install after unarchive). Everything else under the session root —
 * notably `uploads/` (user files, referenced by persisted chat history, restored
 * on unarchive; planning#182/docs/217) and any future durable scratch tier — is
 * DURABLE and must survive. This is an allowlist on purpose: a blanket `rm` of
 * the session root would take `uploads/` with it, and the allowlist is
 * future-proof against new durable siblings.
 */
export const REGENERABLE_SESSION_SUBDIRS = [
  "workspace",
  OVERLAY_SESSION_SUBDIR,
  // docs/246 — ShipIt's own generated state. Every artifact in it is
  // regenerated (compose override, agent env file, CI logs) and, critically,
  // the install marker DESCRIBES the checkout: leaving it behind when
  // `workspace/` is reclaimed makes it outlive the clone it refers to, so the
  // restored session matches a marker whose `node_modules` no longer exists and
  // `/install` returns `{ skipped: true }` — a dep-less session. Before the
  // marker moved out of the clone, deleting the checkout necessarily deleted it.
  SESSION_STATE_SUBDIR,
] as const;

/**
 * planning#194 — reclaim a session's REGENERABLE on-disk tiers while PRESERVING its
 * durable, non-git siblings. The historical bug: every reclaim site (`fs.rm`'d
 * `workspaceDir`, the `sessions/<id>/workspace` checkout) deleted only the
 * cheap, re-clonable half and orphaned the expensive `overlay/` sibling
 * (~490 MB per worker-image digest the session lived through), leaking ~60 GB on
 * prod. This deletes the checkout AND the overlay upper, never a blanket `rm` of
 * the session root (which would take `uploads/` and break the transcript on
 * restore — see {@link REGENERABLE_SESSION_SUBDIRS}).
 *
 * `workspaceDir` is the checkout subdir; its parent is the session root. Each
 * target is stat-checked so a missing dir (already reclaimed, e.g. an evicted
 * session whose `workspace/` is gone but whose `overlay/` orphan survives) is
 * skipped without counting. Never rejects. `paceMs` throttles between removals
 * (the sweeps drip reclaim so a concurrent agent start isn't starved).
 *
 * Returns the absolute paths actually removed and any per-dir failures, so
 * callers keep their own logging/counting semantics.
 */
export async function reclaimRegenerableSessionDirs(
  workspaceDir: string,
  opts: { paceMs?: number } = {},
): Promise<{ removed: string[]; failed: { dir: string; message: string }[] }> {
  const paceMs = opts.paceMs ?? 0;
  const sessionRoot = path.dirname(workspaceDir);
  // The checkout (the exact `workspaceDir` given — its basename is `workspace`
  // in prod) plus the overlay upper sibling. NEVER a blanket `rm` of
  // `sessionRoot`, which also holds durable `uploads/` — see
  // {@link REGENERABLE_SESSION_SUBDIRS}.
  // Derived from {@link REGENERABLE_SESSION_SUBDIRS}, NOT hand-listed. The
  // hand-listed version silently ignored additions to that constant: docs/246
  // added `state` to it and nothing changed, so the install marker kept
  // outliving the clone it describes (evict → restore → fresh checkout with no
  // deps, marker still matches, `/install` skips, dep-less session). The unit
  // test that "covered" it asserted the constant's CONTENTS, which passed while
  // the behaviour was unchanged — declaration pinned, effect not.
  //
  // The checkout keeps using the `workspaceDir` argument verbatim rather than
  // `<sessionRoot>/workspace`: callers pass the session's real checkout path and
  // it stays authoritative here.
  const targets = [
    workspaceDir,
    ...REGENERABLE_SESSION_SUBDIRS
      .filter((sub) => sub !== SESSION_WORKSPACE_SUBDIR)
      .map((sub) => path.join(sessionRoot, sub)),
  ];
  const removed: string[] = [];
  const failed: { dir: string; message: string }[] = [];
  for (const dir of targets) {
    try {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat) continue;
      await sleep(paceMs);
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      failed.push({ dir, message: getMessage(err) });
    }
  }
  return { removed, failed };
}

/**
 * planning#296 — reclaim a session's regenerable CACHES while leaving the
 * `workspace/` checkout in place: the `overlay/` upper (docs/183 install
 * deltas) and, with it, the `.install-done` marker.
 *
 * Used by the one path that must reclaim what it can while preserving what it
 * can't restore — an eviction blocked because the checkout is the only copy of
 * the work (an auto-commit the secret scanner or an unresolved merge state
 * refused, or a commit that could not be pushed). Such a session can stay
 * pinned at `light` for weeks, so dropping the install delta keeps the pin from
 * hoarding the expensive half of its disk.
 *
 * **The marker must go with the upper.** The marker claims "this checkout's
 * deps are installed", and after the upper is gone that is false — but not
 * *detectably* false: the session's dep dir remounts over the shared rolling
 * base, whose lower is usually populated, so the present-but-EMPTY contradiction
 * check (`overlay-dep-check.ts`) does not fire and `agent.install` would be
 * skipped, leaving the session with the base's deps and none of its own. Both
 * removals therefore live in one function rather than at the call site. Same
 * unlink `claim-session.ts` does when it hands a clone to a new session.
 *
 * **"`agent.install` will re-run" is an assumption, not a guarantee** (the ops
 * finding of 2026-08-20): the docs/271 trust gate refuses a changed list on a
 * plugin-bearing session, so this reclaim can leave exactly the dep-less session
 * the paragraph above exists to prevent. Two things make that survivable rather
 * than silent. The gate reports a withhold landing on an absent marker, which is
 * this state, so the session says what happened instead of dying on
 * `sh: 1: vite: not found`. And docs/271's accepted-command record is no longer
 * the marker, so this unlink no longer destroys it.
 *
 * Never rejects.
 */
export async function reclaimBlockedSessionCaches(
  workspaceDir: string,
): Promise<{ removed: string[]; message?: string }> {
  const overlayDir = path.join(path.dirname(workspaceDir), OVERLAY_SESSION_SUBDIR);
  const removed: string[] = [];
  try {
    // Via the canonical resolvers, not a hand-built path — and resolved INSIDE
    // the try so an unrecognized layout throws here and takes the overlay
    // removal with it. Failing closed is the point: if we can't locate the
    // marker we must not delete the deps it describes.
    const markerFile = path.join(
      sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)), INSTALL_MARKER_FILE,
    );
    // Marker FIRST. If the second removal fails, the surviving state is
    // "no marker, deps present" — a harmless extra reinstall. The reverse
    // order's half-failure is "marker present, deps gone", which is the
    // dep-less session this function exists to prevent.
    if (await fs.stat(markerFile).catch(() => null)) {
      await fs.rm(markerFile, { force: true });
      removed.push(markerFile);
    }
    if (await fs.stat(overlayDir).catch(() => null)) {
      await fs.rm(overlayDir, { recursive: true, force: true });
      removed.push(overlayDir);
    }
    return { removed };
  } catch (err) {
    return { removed, message: getMessage(err) };
  }
}

/**
 * Pacing primitive for the throttled sweeps. `ms <= 0` resolves synchronously
 * (the test default) so unit tests never pay real wall-clock; production wires
 * a small positive pace so the reclaim drips out instead of saturating the
 * Docker daemon / git layer that a concurrent agent start needs.
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Spawn `docker <args>` and collect combined stdout+stderr. */
export function defaultRunDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`docker ${args[0]} exited ${code}: ${output.trim()}`));
    });
    proc.on("error", reject);
  });
}
