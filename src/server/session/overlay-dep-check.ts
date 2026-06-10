/**
 * Overlay-aware install-marker validation (docs/183).
 *
 * A matching `.shipit/.install-done` marker is no longer sufficient to skip
 * `agent.install` when a declared dep dir is overlay-backed: the marker lives in
 * the host clone while the deps live in the overlay (base + upper), and the two
 * can disagree. The concrete, live-observed failure: a warm session's clone
 * carries a marker stamped by a pre-overlay install; the container is later
 * recreated with `OVERLAY_DEP_STORE` newly enabled, mounting an EMPTY overlay
 * over the (now hidden) previously-installed deps. The marker still matches —
 * same commit, runtime, commands — so the gate skips, leaving the session with
 * no dependencies at all. Worse, `install_ok=true` then lets the publish hook
 * capture the empty merged view as the scope's shared rolling base, poisoning
 * every future session of that `(repo, runtime, dep-dir)` scope.
 *
 * The contradiction is detectable in-container: if a declared dep dir is an
 * overlay mount (per `/proc/self/mounts`) AND its merged view is empty, the
 * marker's claim ("install completed for this exact commit/runtime/commands")
 * cannot be about THIS overlay's contents — treat it as a miss and reinstall.
 * Non-overlay sessions have no overlay mount at a dep dir, so the check returns
 * `[]` and the gate behaves exactly as before (flag-off stays byte-for-byte).
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

/**
 * The declared dep dirs whose overlay-backed merged view is EMPTY — i.e. the
 * dirs that contradict a matching install marker (see module doc). Returns `[]`
 * when nothing is overlay-backed (non-overlay sessions: unchanged behavior),
 * when the config can't be read, or when `/proc/self/mounts` is unavailable
 * (conservative: never force a reinstall on a read failure).
 */
export function overlayBackedEmptyDepDirs(workspaceRoot: string): string[] {
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceRoot).agent.depDirs;
  } catch {
    return [];
  }
  if (depDirs.length === 0) return [];

  let mountsText: string;
  try {
    mountsText = fs.readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return [];
  }

  const overlayDirs = overlayMountedDepDirs(mountsText, workspaceRoot, depDirs);
  const empty: string[] = [];
  for (const depDir of overlayDirs) {
    const abs = path.join(workspaceRoot, depDir);
    try {
      if (fs.readdirSync(abs).length === 0) empty.push(depDir);
    } catch {
      empty.push(depDir); // unreadable merged view — same contradiction
    }
  }
  return empty;
}
