/**
 * Install-marker dep-dir contradiction check (docs/183).
 *
 * A matching `.shipit/.install-done` marker is not sufficient to skip
 * `agent.install` when a declared dep dir is present-but-EMPTY: the marker lives
 * in the host clone while the deps live in the dep dir, and the two can
 * disagree. Two live-observed failure modes, both fixed by reinstalling:
 *
 *  1. **Flag ON, freshly enabled (the original hazard, PR #1234).** A warm
 *     session's clone carries a marker stamped by a pre-overlay install; the
 *     container is later recreated with `OVERLAY_DEP_STORE` newly enabled,
 *     mounting an EMPTY overlay over the (now hidden) previously-installed deps.
 *     The marker still matches — same commit, runtime, commands — so the gate
 *     skips, leaving the session with no dependencies. Worse, `install_ok=true`
 *     then lets the publish hook capture the empty merged view as the scope's
 *     shared rolling base, poisoning every future session of that scope.
 *
 *  2. **Flag rolled OFF (the documented incident response, FINDINGS finding 3).**
 *     A session whose deps lived in the overlay store gets its container
 *     recreated with `OVERLAY_DEP_STORE` rolled back off. Now there is NO overlay
 *     mount, but the dep dir left behind in the host clone (the old overlay
 *     mountpoint) is EMPTY — the deps were only ever in the now-unmounted
 *     overlay upper. The marker still matches exactly, so an overlay-mount-only
 *     check (which required an overlay mount to distrust the marker) would skip →
 *     dep-less session. Generalizing to "empty regardless of mount type" closes
 *     this too.
 *
 * The contradiction signal is therefore **the dep dir exists but its (merged)
 * view is empty**, whether that dir is an overlay mount or a plain directory.
 * The overlay case is a strict subset, so this generalization keeps protecting
 * the publish hook from capturing an empty base (mode 1) while also covering the
 * flag-rollback path (mode 2) — one check, not two.
 *
 * An **absent** dep dir is deliberately NOT a contradiction. A repo that
 * legitimately has no install-managed dep dir — the default `node_modules`
 * declared on a non-Node repo, an `agent.install` that populates somewhere else,
 * or any session whose dep dir was simply never created — has that dir absent,
 * and reinstalling on every resume would defeat the marker-skip for them with no
 * benefit (the live rollback signature is an empty leftover dir, never an absent
 * one). Absence keeps the skip; only present-but-empty distrusts the marker.
 *
 * Cost note: this runs on every `/install`. It reads the shipit config (already
 * cached on disk) and does a single non-recursive `readdir` per declared dep dir
 * — an O(N dep dirs) emptiness probe, never a recursive scan.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig } from "../shared/shipit-config.js";

/**
 * Parse `/proc/self/mounts` content and return the subset of `depDirs` whose
 * mount point `<workspaceRoot>/<depDir>` is an overlay mount. Pure (takes the
 * mounts text) so the parsing is unit-testable. `/proc/mounts` octal-escapes
 * spaces (`\040`); dep-dir paths are config-validated relative paths that the
 * parser already rejects exotic forms of, so a literal match is sufficient.
 *
 * Used only to LABEL a contradiction as overlay-backed in the log line; the
 * reinstall decision itself no longer depends on the mount type.
 */
export function overlayMountedDepDirs(
  procMountsText: string,
  workspaceRoot: string,
  depDirs: string[],
): string[] {
  const targetToDepDir = new Map<string, string>();
  for (const depDir of depDirs) {
    targetToDepDir.set(path.posix.join(workspaceRoot, depDir), depDir);
  }
  const mounted: string[] = [];
  for (const line of procMountsText.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    if (parts[2] !== "overlay") continue;
    const depDir = targetToDepDir.get(parts[1]);
    if (depDir !== undefined) mounted.push(depDir);
  }
  return mounted;
}

/** A declared dep dir that contradicts a matching install marker. */
export interface ContradictingDepDir {
  /** The declared dep-dir relative path (e.g. `node_modules`). */
  depDir: string;
  /** Whether the empty dir is an overlay mount (for the log line only). */
  overlay: boolean;
}

/**
 * The declared dep dirs that are present-but-EMPTY — i.e. the dirs that
 * contradict a matching install marker (see module doc). Returns `[]` when no
 * dep dir is empty (the dep dir is populated, or absent, or the repo opted out
 * with `agent.dep-dirs: []`), or when the config can't be read (conservative:
 * never force a reinstall on a read failure).
 *
 * Each empty dir is labeled with whether it is an overlay mount, purely for the
 * gate's warning line; `/proc/self/mounts` being unavailable just leaves the
 * label `false` and never changes the reinstall decision.
 */
export function emptyDepDirsContradictingMarker(
  workspaceRoot: string,
): ContradictingDepDir[] {
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceRoot).agent.depDirs;
  } catch {
    return [];
  }
  if (depDirs.length === 0) return [];

  // Best-effort overlay labeling. A read failure (no /proc, non-container) just
  // means no dir is labeled overlay — the emptiness decision below is unchanged.
  let overlaySet = new Set<string>();
  try {
    const mountsText = fs.readFileSync("/proc/self/mounts", "utf8");
    overlaySet = new Set(overlayMountedDepDirs(mountsText, workspaceRoot, depDirs));
  } catch {
    // ignore — treat nothing as overlay-backed
  }

  const contradicting: ContradictingDepDir[] = [];
  for (const depDir of depDirs) {
    const abs = path.join(workspaceRoot, depDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(abs);
    } catch {
      // Absent (ENOENT) or otherwise unreadable: an absent dep dir is NOT a
      // contradiction (legitimately dep-less repos keep the marker-skip), and a
      // transient read error should not force a spurious reinstall. Either way,
      // skip — only a dir we can confirm is present-but-empty contradicts.
      continue;
    }
    if (entries.length === 0) {
      contradicting.push({ depDir, overlay: overlaySet.has(depDir) });
    }
  }
  return contradicting;
}
