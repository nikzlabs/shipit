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

/** pnpm's virtual store, and its own record that it reconciled the tree beside it. */
export const PNPM_VIRTUAL_STORE = ".pnpm";
export const PNPM_INSTALL_STATE_PREFIX = ".pnpm-workspace-state";

/**
 * Declared dep dirs that hold a pnpm tree pnpm never reconciled — `agent.install` exited 0 without
 * a pnpm install having run over this tree at all.
 *
 * It matters because a verified pnpm base can be **pruned**: packages carrying an install-time
 * build are left out of it deliberately, and the session's own install is what puts them back
 * (`orchestrator/pnpm-base-prune.ts`, docs/276 section 5). A repo-authored command that decides for
 * itself whether to install — `test -d node_modules || pnpm install` is the shape — sees the
 * mounted base, skips, and leaves a tree that is silently short of exactly those packages. The
 * command is the repo's to write; what ShipIt owes it is a loud failure rather than a working
 * directory that quietly is not.
 *
 * The signal is pnpm's own `.pnpm-workspace-state-v1.json`, which the prune removes from the base
 * and which every install writes back (measured 2026-09-21 on pnpm 11.22.0, 12.4.1 and 12.5.1, the
 * whole range a verified base is mounted for). It is the one signal that survives an install that
 * legitimately installs LESS than the lockfile: `--prod` and a filtered install both write it,
 * while comparing package sets reports either as a failure.
 */
export function unreconciledPnpmDepDirs(workspaceRoot: string): string[] {
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceRoot).agent.depDirs;
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const depDir of depDirs) {
    const root = path.join(workspaceRoot, depDir);
    // Only a pnpm tree is in scope; anything else has no state file to be missing.
    if (!fs.existsSync(path.join(root, PNPM_VIRTUAL_STORE, "lock.yaml"))) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    if (!entries.some((name) => name.startsWith(PNPM_INSTALL_STATE_PREFIX))) out.push(depDir);
  }
  return out;
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
