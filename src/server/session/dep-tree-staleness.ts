/**
 * Post-install staleness check — is the dependency tree the one the lockfile
 * asks for? (nikzlabs#2496, the second half of docs/272.)
 *
 * docs/272 made an install's outcome more than its exit status: a declared
 * `agent.dep-dirs` entry that is present-and-EMPTY after the install fails it.
 * That closes only the emptiest case. A directory that is present and **stale**
 * — the tree a *previous* commit's install left behind — passes the emptiness
 * probe, the marker is stamped for the CURRENT commit, and the
 * `x-shipit-depends-on-install` gate opens over dependencies that do not match
 * the code. The laundering pattern is the same one docs/272 names: an install
 * ending in `|| true`, or in `|| [ -x node_modules/.bin/vite ]`, exits 0 having
 * installed nothing, and "nothing" over a leftover tree is invisible to an
 * emptiness check.
 *
 * ## Why npm's own hidden lockfile, and not a check of ShipIt's devising
 *
 * The tempting generic check — "did the install write anything into the dep
 * dir?" — cannot be made safe. A legitimate no-op install writes nothing, and
 * the doc explicitly invites a repo to declare a *build output* directory in
 * `dep-dirs`, where an incremental build that produces nothing is the normal
 * case. Failing those would be worse than the hole it closes.
 *
 * npm already keeps the record we need. `node_modules/.package-lock.json` is
 * npm's own statement of what it reified into that directory, and npm rewrites
 * it on **every** run, including a complete no-op (verified against npm 10:
 * a second `npm install` over an up-to-date tree bumps its mtime and content).
 * So comparing it to `package-lock.json` answers exactly the question the exit
 * status cannot: does the tree on disk hold what the lockfile asks for? A stale
 * tree and a current lockfile disagree; a genuine install of any shape agrees,
 * because npm wrote both sides itself moments earlier.
 *
 * ## What this deliberately does not flag
 *
 * Every rule below exists to protect a *legitimately partial* tree, which the
 * `dep-dirs` contract explicitly permits:
 *
 *  - **Only a dir that holds a `.package-lock.json` is checked at all.** That
 *    file is the signal "npm reified THIS directory". A monorepo's
 *    `packages/web/node_modules` — near-empty because everything hoisted to the
 *    root — has none, and is left alone. So is a `dist/` declared per the
 *    doc's build-output advice, and so is any yarn/pip/other tree.
 *  - **Dev dependencies are required only when the tree already has some.** An
 *    install run with `--omit=dev` (or `NODE_ENV=production`) produces a hidden
 *    lockfile with no `dev` entries at all; requiring the lockfile's dev
 *    packages there would fail every such repo. Calibrating on what the tree
 *    itself recorded needs no parsing of the user's command line.
 *  - **Optional, peer, bundled, linked and platform-restricted entries are
 *    never required.** Each is legitimately absent for a reason ShipIt cannot
 *    see from the lockfile alone (platform mismatch, `--legacy-peer-deps`, a
 *    workspace link).
 *  - **Extra packages are never a mismatch.** The comparison runs in one
 *    direction only: a required entry missing from the tree, or present at the
 *    wrong version. A tree holding *more* than the lockfile asks for is what
 *    every partial cleanup looks like, and it is not a failed install.
 *  - **A filtered workspace install disables the comparison entirely.** This
 *    one was caught in review and is the sharpest false positive of the set:
 *    `npm install --workspace=packages/web` reifies only that workspace's
 *    dependencies while the ROOT lockfile keeps describing every workspace, so
 *    a naive comparison flags a perfectly good install (verified against npm
 *    10 — the sibling workspace's packages and its `node_modules/<name>` link
 *    are both simply absent). {@link npmLockfileMismatches} detects it from the
 *    artifact rather than the command line — a workspace link the lockfile
 *    declares and the tree does not hold means the install was filtered — which
 *    also covers the other routes to the same state (`--prefix`, an install run
 *    from inside a subpackage).
 *  - **A command that bypasses the lockfile disables it too.** `--no-package-lock`
 *    and `--package-lock=false` let npm resolve from `package.json` and write a
 *    hidden lockfile that may legitimately disagree with the on-disk
 *    `package-lock.json`; `--package-lock-only` rewrites the hidden lockfile
 *    without touching the tree at all. Neither pair of files describes the same
 *    intent, so there is nothing to compare — see {@link bypassesLockfile}.
 *
 * Two known false negatives, recorded rather than fixed. A **partial `npm ci`**
 * leaves no npm record at all (`npm ci` wipes the directory first, and writes
 * the hidden lockfile only at the end), so a half-extracted tree is compared
 * against nothing and only the emptiness check covers it. And a **nested
 * workspace dep dir** (`packages/web/node_modules` in a monorepo) has no
 * lockfile beside it — npm keeps the lockfile at the root — so a stale tree
 * there is not seen either. Both err in the safe direction.
 *
 * Cost: two `readFileSync` + `JSON.parse` per declared dep dir that has a
 * hidden lockfile, on the post-install path only. Never a tree walk.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig } from "../shared/shipit-config.js";

/** npm's hidden lockfile, written by npm into the dep dir it reified. */
export const HIDDEN_LOCKFILE = ".package-lock.json";
/** The manifest lockfile, beside the `package.json` the dep dir belongs to. */
export const NPM_LOCKFILE = "package-lock.json";

/** How many example packages a failure message names. */
export const MAX_REPORTED_MISMATCHES = 3;

/** One package the lockfile requires that the tree does not hold at that version. */
export interface LockMismatch {
  /** The lockfile's own key, e.g. `node_modules/vite`. */
  packagePath: string;
  /** The version `package-lock.json` asks for. */
  expected: string;
  /** The version the tree records, or `null` when it holds no such package. */
  found: string | null;
}

/** A declared dep dir whose tree disagrees with its lockfile. */
export interface StaleDepDir {
  /** The declared dep-dir relative path (e.g. `node_modules`). */
  depDir: string;
  /** The disagreeing packages, in lockfile order. Never empty. */
  mismatches: LockMismatch[];
}

/** The subset of a lockfile entry this module reads. */
interface LockEntry {
  version?: unknown;
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

/**
 * Parse a lockfile's `packages` map, or `null` when the text is not a v2+ npm
 * lockfile. A v1 lockfile (npm 6) has `dependencies` and no `packages`, and is
 * not comparable to a hidden lockfile — `null` means "skip this dir", never
 * "the tree is stale".
 */
function parsePackages(text: string): Record<string, LockEntry> | null {
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

/**
 * Is this lockfile entry one the tree MUST hold?
 *
 * `treeHasDev` is the self-calibration described in the module doc: the caller
 * passes whether the tree recorded any dev package at all, and dev entries are
 * required only then.
 */
function isRequired(key: string, entry: LockEntry, treeHasDev: boolean): boolean {
  // The root project (`""`) and workspace paths (`packages/web`) are not things
  // installed INTO this dep dir. Only `node_modules/…` keys are.
  if (!key.startsWith("node_modules/")) return false;
  if (typeof entry.version !== "string" || entry.version.length === 0) return false;
  if (entry.link === true || entry.extraneous === true || entry.inBundle === true) return false;
  if (entry.optional === true || entry.devOptional === true || entry.peer === true) return false;
  // A platform-restricted package is legitimately skipped by npm on a host it
  // does not match, so its absence says nothing about the install.
  if (entry.os !== undefined || entry.cpu !== undefined || entry.libc !== undefined) return false;
  if (entry.dev === true) return treeHasDev;
  return true;
}

/**
 * Flags that sever the tie between `package-lock.json` and the tree npm builds,
 * making the two files describe different intents rather than the same one.
 * `--no-package-lock` / `--package-lock=false` resolve from `package.json` and
 * leave the on-disk lockfile untouched; `--package-lock-only` rewrites the
 * hidden lockfile without touching the tree.
 */
const LOCKFILE_BYPASS_FLAGS = ["--no-package-lock", "--package-lock=false", "--package-lock-only"];

/**
 * Does any install command opt out of the lockfile? A substring test is the
 * right shape here: these flags take no value, and the direction of a false
 * match is to skip the check, never to fail an install.
 */
export function bypassesLockfile(installCommands: string[]): boolean {
  return installCommands.some((cmd) => LOCKFILE_BYPASS_FLAGS.some((flag) => cmd.includes(flag)));
}

/**
 * Compare a `package-lock.json` against the `node_modules/.package-lock.json`
 * npm wrote for the same tree.
 *
 * Returns the disagreeing packages, or `null` when the pair is not comparable —
 * unparseable, not a v2+ lockfile, or a filtered workspace install — which the
 * caller treats as "nothing to say", never as a failure. Pure, so the whole
 * rule set is unit-testable without a filesystem.
 */
export function npmLockfileMismatches(
  lockfileText: string,
  hiddenLockfileText: string,
): LockMismatch[] | null {
  const required = parsePackages(lockfileText);
  const installed = parsePackages(hiddenLockfileText);
  if (required === null || installed === null) return null;

  // A filtered install reifies part of the tree against a lockfile describing
  // all of it. The tell is a workspace link the lockfile declares and the tree
  // does not hold: npm creates `node_modules/<name>` for every workspace it
  // reifies, so a missing one means this install covered only some of them, and
  // every "missing" package below would be an artifact of the filter.
  for (const [key, entry] of Object.entries(required)) {
    if (entry?.link === true && installed[key] === undefined) return null;
  }

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

/**
 * The declared dep dirs whose tree disagrees with its lockfile, for a workspace
 * whose install has just finished.
 *
 * Returns `[]` when nothing disagrees, when no declared dir is an npm-reified
 * tree, when an install command bypasses the lockfile, when the repo opted out
 * with `agent.dep-dirs: []`, or when the config cannot be read — conservative in
 * exactly the direction `classifyEmptyDepDirs` is: an unreadable
 * declaration never fails an install.
 */
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
    // The lockfile that governs a dep dir sits beside the `package.json` the
    // dir belongs to — the dir's parent. For the default `node_modules` that is
    // the workspace root; for `packages/web/node_modules` it is `packages/web`,
    // which in a hoisting workspace setup has no lockfile of its own and is
    // therefore skipped.
    const hiddenPath = path.join(workspaceRoot, depDir, HIDDEN_LOCKFILE);
    const lockPath = path.join(workspaceRoot, path.dirname(depDir), NPM_LOCKFILE);
    let hiddenText: string;
    let lockText: string;
    try {
      hiddenText = fs.readFileSync(hiddenPath, "utf8");
      lockText = fs.readFileSync(lockPath, "utf8");
    } catch {
      continue; // Not an npm-reified tree, or no lockfile — nothing to compare.
    }
    const mismatches = npmLockfileMismatches(lockText, hiddenText);
    if (mismatches !== null && mismatches.length > 0) stale.push({ depDir, mismatches });
  }
  return stale;
}
