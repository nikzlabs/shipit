// Empty dep dirs invalidate the install marker even after overlay storage is disabled.
// Absent dirs remain valid for repos whose install does not populate the declared path.
import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { hoistedAwayDepDirs } from "./npm-workspace-hoist.js";

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

export interface ContradictingDepDir {
  depDir: string;
  overlay: boolean;
}

export interface EmptyDepDirReport {
  contradicting: ContradictingDepDir[];
  hoistedAway: string[];
}

export function classifyEmptyDepDirs(workspaceRoot: string): EmptyDepDirReport {
  const none: EmptyDepDirReport = { contradicting: [], hoistedAway: [] };
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceRoot).agent.depDirs;
  } catch {
    return none;
  }
  if (depDirs.length === 0) return none;

  // Mount type affects the log label only, not the reinstall decision.
  let overlaySet = new Set<string>();
  try {
    const mountsText = fs.readFileSync("/proc/self/mounts", "utf8");
    overlaySet = new Set(overlayMountedDepDirs(mountsText, workspaceRoot, depDirs));
  } catch {
    // Leave labels false when /proc is unavailable.
  }

  const empty: string[] = [];
  for (const depDir of depDirs) {
    const abs = path.join(workspaceRoot, depDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(abs);
    } catch {
      // A missing or unreadable dir is not proof that reinstall is needed.
      continue;
    }
    if (entries.length === 0) empty.push(depDir);
  }
  if (empty.length === 0) return none;

  // Overlay mount points cannot be absent; npm's hoist record can excuse empty ones.
  const hoistedAway = new Set(hoistedAwayDepDirs(workspaceRoot, empty));
  return {
    contradicting: empty
      .filter((depDir) => !hoistedAway.has(depDir))
      .map((depDir) => ({ depDir, overlay: overlaySet.has(depDir) })),
    hoistedAway: empty.filter((depDir) => hoistedAway.has(depDir)),
  };
}
