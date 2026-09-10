// Excuse empty workspace dep dirs only when npm records a link and neither
// lockfile records nested dependencies. The manifest check rejects stale install records.
import fs from "node:fs";
import path from "node:path";
import { HIDDEN_LOCKFILE, NPM_LOCKFILE, parsePackages } from "./dep-tree-staleness.js";

function normalizeLinkTarget(resolved: string): string | null {
  const raw = resolved.trim().replace(/^file:/, "");
  if (!raw || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const segments = raw.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return null;
  return segments.join("/");
}

export function hoistedLinkTargets(
  hiddenLockfileText: string,
  manifestLockfileText: string,
): Set<string> {
  const installed = parsePackages(hiddenLockfileText);
  const manifest = parsePackages(manifestLockfileText);
  if (installed === null || manifest === null) return new Set();

  const hoisted = new Set<string>();
  for (const entry of Object.values(installed)) {
    if (typeof entry !== "object" || entry === null) continue;
    const resolved: unknown = entry.resolved;
    if (entry.link !== true || typeof resolved !== "string") continue;
    const normalized = normalizeLinkTarget(resolved);
    if (normalized) hoisted.add(normalized);
  }
  if (hoisted.size === 0) return hoisted;

  // Include optional packages: every hidden-lockfile entry describes installed files.
  // Match the full prefix since a target path can itself contain node_modules.
  const keys = [...Object.keys(installed), ...Object.keys(manifest)];
  for (const target of [...hoisted]) {
    const prefix = `${target}/node_modules/`;
    if (keys.some((key) => key.startsWith(prefix))) hoisted.delete(target);
  }
  return hoisted;
}

export function hoistedAwayDepDirs(workspaceRoot: string, emptyDepDirs: string[]): string[] {
  const targetsByAncestor = new Map<string, Set<string>>();

  const targetsFor = (ancestor: string): Set<string> => {
    const cached = targetsByAncestor.get(ancestor);
    if (cached) return cached;
    let targets = new Set<string>();
    try {
      const dir = path.join(workspaceRoot, ancestor);
      targets = hoistedLinkTargets(
        fs.readFileSync(path.join(dir, "node_modules", HIDDEN_LOCKFILE), "utf8"),
        fs.readFileSync(path.join(dir, NPM_LOCKFILE), "utf8"),
      );
    } catch {
      // Without both lockfiles, no exemption can be confirmed.
    }
    targetsByAncestor.set(ancestor, targets);
    return targets;
  };

  const hoisted: string[] = [];
  for (const depDir of emptyDepDirs) {
    if (path.posix.basename(depDir) !== "node_modules") continue;
    const packageDir = path.posix.dirname(depDir);
    if (packageDir === ".") continue;

    // npm link targets are relative to the ancestor that wrote the lockfile.
    for (let ancestor = path.posix.dirname(packageDir); ; ancestor = path.posix.dirname(ancestor)) {
      if (targetsFor(ancestor).has(path.posix.relative(ancestor, packageDir))) {
        hoisted.push(depDir);
        break;
      }
      if (ancestor === ".") break;
    }
  }
  return hoisted;
}
