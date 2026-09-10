// Compare npm's install record with the manifest lockfile to detect stale deps.
// No hidden lockfile (for example, after partial npm ci) means no comparison.
import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig } from "../shared/shipit-config.js";

export const HIDDEN_LOCKFILE = ".package-lock.json";
export const NPM_LOCKFILE = "package-lock.json";
export const MAX_REPORTED_MISMATCHES = 3;

export interface LockMismatch {
  packagePath: string;
  expected: string;
  found: string | null;
}

export interface StaleDepDir {
  depDir: string;
  mismatches: LockMismatch[];
}

export interface LockEntry {
  version?: unknown;
  resolved?: unknown;
  dev?: unknown;
  optional?: unknown;
  devOptional?: unknown;
  peer?: unknown;
  link?: unknown;
  extraneous?: unknown;
  inBundle?: unknown;
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
}

export function parsePackages(text: string): Record<string, LockEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const packages = (parsed as { packages?: unknown }).packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) return null;
  return packages as Record<string, LockEntry>;
}

// Apply exclusions to the manifest only; hidden lockfiles record installed files.
function isRequired(key: string, entry: LockEntry, treeHasDev: boolean): boolean {
  if (!key.startsWith("node_modules/")) return false;
  if (typeof entry.version !== "string" || entry.version.length === 0) return false;
  if (entry.link === true || entry.extraneous === true || entry.inBundle === true) return false;
  if (entry.optional === true || entry.devOptional === true || entry.peer === true) return false;
  if (entry.os !== undefined || entry.cpu !== undefined || entry.libc !== undefined) return false;
  if (entry.dev === true) return treeHasDev;
  return true;
}

const LOCKFILE_BYPASS_FLAGS = ["--no-package-lock", "--package-lock=false", "--package-lock-only"];

// A false substring match skips validation rather than rejecting a valid install.
export function bypassesLockfile(installCommands: string[]): boolean {
  return installCommands.some((cmd) => LOCKFILE_BYPASS_FLAGS.some((flag) => cmd.includes(flag)));
}

export function npmLockfileMismatches(
  lockfileText: string,
  hiddenLockfileText: string,
): LockMismatch[] | null {
  const required = parsePackages(lockfileText);
  const installed = parsePackages(hiddenLockfileText);
  if (required === null || installed === null) return null;

  // Missing workspace links can indicate a filtered install; skip the comparison.
  for (const [key, entry] of Object.entries(required)) {
    if (entry?.link === true && installed[key] === undefined) return null;
  }

  // Permit --omit=dev without parsing the install command.
  const treeHasDev = Object.values(installed).some((e) => e?.dev === true);

  const mismatches: LockMismatch[] = [];
  for (const [key, entry] of Object.entries(required)) {
    if (entry === null || typeof entry !== "object") continue;
    if (!isRequired(key, entry, treeHasDev)) continue;
    const expected = entry.version as string;
    const have = installed[key];
    const found = have && typeof have.version === "string" ? have.version : null;
    if (found !== expected) mismatches.push({ packagePath: key, expected, found });
  }
  return mismatches;
}

export function staleDepDirs(workspaceRoot: string, installCommands: string[]): StaleDepDir[] {
  if (bypassesLockfile(installCommands)) return [];

  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceRoot).agent.depDirs;
  } catch {
    return [];
  }
  if (depDirs.length === 0) return [];

  const stale: StaleDepDir[] = [];
  for (const depDir of depDirs) {
    // Nested workspace dirs without their own manifest lockfile are skipped.
    const hiddenPath = path.join(workspaceRoot, depDir, HIDDEN_LOCKFILE);
    const lockPath = path.join(workspaceRoot, path.dirname(depDir), NPM_LOCKFILE);
    let hiddenText: string;
    let lockText: string;
    try {
      hiddenText = fs.readFileSync(hiddenPath, "utf8");
      lockText = fs.readFileSync(lockPath, "utf8");
    } catch {
      continue;
    }
    const mismatches = npmLockfileMismatches(lockText, hiddenText);
    if (mismatches !== null && mismatches.length > 0) stale.push({ depDir, mismatches });
  }
  return stale;
}
