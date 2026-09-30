// Filesystem side of plugin-skill ownership, shared by the worker's sweep and the rebase flow.
// Kept out of plugin-skill-marker.ts, which the browser bundle imports.

import fs from "node:fs";
import path from "node:path";
import { HARNESSES } from "./catalogue/harnesses.js";
import { markerClaimsOwnership, PLUGIN_SKILL_MARKER, PLUGIN_SKILL_PREFIX } from "./plugin-skill-marker.js";

const STAGING_RE = new RegExp(`^\\.${PLUGIN_SKILL_PREFIX}.*\\.staging-`);

/** Every harness's skills discovery root; workspace-relative when `workspaceDir` is "". */
export function pluginSkillRoots(workspaceDir: string): string[] {
  const names = [...new Set(HARNESSES.map((h) => h.capabilities.skillsDirName))];
  return names.map((name) => (workspaceDir ? path.join(workspaceDir, name, "skills") : `${name}/skills`));
}

// Ownership requires valid marker content, not just a filename or symlink.
export function pluginSkillOwnership(p: string): "ours" | "absent" | "foreign" {
  if (!fs.existsSync(p)) return "absent";
  const marker = path.join(p, PLUGIN_SKILL_MARKER);
  try {
    if (!fs.lstatSync(marker).isFile()) return "foreign";
    return markerClaimsOwnership(fs.readFileSync(marker, "utf-8")) ? "ours" : "foreign";
  } catch {
    return "foreign";
  }
}

export interface OwnedPluginSkillDir {
  dir: string;
  name: string;
  staging: boolean;
}

/** ShipIt's copies, and staging dirs an interrupted copy left, in every skills root except `keep`. */
export function ownedPluginSkillDirs(
  workspaceDir: string,
  keep: ReadonlySet<string>,
): OwnedPluginSkillDir[] {
  const found: OwnedPluginSkillDir[] = [];
  for (const root of pluginSkillRoots(workspaceDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const staging = STAGING_RE.test(entry.name);
      if (!staging && (!entry.name.startsWith(PLUGIN_SKILL_PREFIX) || keep.has(entry.name))) continue;
      const dir = path.join(root, entry.name);
      if (pluginSkillOwnership(dir) === "ours") found.push({ dir, name: entry.name, staging });
    }
  }
  return found;
}
