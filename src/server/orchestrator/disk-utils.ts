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
 * on unarchive; SHI-180/docs/217) and any future durable scratch tier — is
 * DURABLE and must survive. This is an allowlist on purpose: a blanket `rm` of
 * the session root would take `uploads/` with it, and the allowlist is
 * future-proof against new durable siblings.
 */
export const REGENERABLE_SESSION_SUBDIRS = ["workspace", OVERLAY_SESSION_SUBDIR] as const;

/**
 * SHI-192 — reclaim a session's REGENERABLE on-disk tiers while PRESERVING its
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
  const targets = [workspaceDir, path.join(sessionRoot, OVERLAY_SESSION_SUBDIR)];
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
