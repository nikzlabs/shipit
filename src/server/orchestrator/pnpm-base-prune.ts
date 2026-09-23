import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { splitLockKey } from "./pnpm-lockfile.js";

/**
 * Remove every package carrying an install-time build from the tree the verified pnpm base is
 * published from, and from the `node_modules/.pnpm/lock.yaml` that tree carries
 * (docs/276-shared-package-cache-integrity plan.md section 5, "Sharing for ineligible repos";
 * planning#604, reqs 2, 9, 10, 13).
 *
 * The builder installs `--ignore-scripts`, so such a package lands unbuilt — and the session's
 * own install over a read-only base can neither build it nor chmod it. Pruning it makes the
 * base a tree that is complete *except* for those packages; the session's install re-imports
 * precisely them into its private store and runs their scripts as its own uid. Which packages
 * those are is `scanTarballForBuildTriggers`' verdict, read off the digest-verified tarballs —
 * the same verdict that used to refuse the candidate outright.
 *
 * **Pruning the carried lockfile is the load-bearing half, not tidying.** A hole in the tree
 * alone is repaired only under `--frozen-lockfile`: a bare `pnpm install` compares the carried
 * lockfile against the repo's, finds them equal, reports "Already up to date" and leaves the
 * hole (measured, `ineligible-sharing-spike.sh` cell E). ShipIt cannot assume the flag —
 * `agent.install` is repo-authored with no default, and `tuneNpmInstall` rewrites npm commands
 * only — so the delta has to be visible to the weaker command. The carried install state has to
 * go with it, or the install never reaches the lockfile at all (`INSTALL_STATE_PREFIX`).
 *
 * **A prune that cannot be verified yields NO base rather than a pruned one.** The publish is
 * what hands the tree to every later session of the repo, so the invariant is checked against
 * what is actually on disk after the rewrite (`verifyPrune`), not inferred from the rewrite
 * having been attempted. Every failure here is reported and the base is not published.
 */

const VIRTUAL_STORE_DIR = ".pnpm";
const CARRIED_LOCKFILE = "lock.yaml";
/** pnpm's own hoisted-alias directory inside the virtual store; not a package directory. */
const HOISTED_DIR = "node_modules";
const BIN_DIR = ".bin";

/**
 * pnpm's carried install state, which short-circuits an install BEFORE it reads the carried
 * lockfile at all: `lastValidatedTimestamp` against the mtimes of the project's manifests and
 * `pnpm-lock.yaml`. The builder writes one, so a base carries the BUILDER's clock — and a
 * session whose checkout is older than the build (a container restart, a session that gains the
 * overlay later) gets "Already up to date" with a hole in its tree.
 *
 * Measured 2026-09-21 on pnpm 12.5.1 (`pruned-base-spike.sh` cell G), both ways: with the file
 * present and the mtimes stale, a bare install over a pruned tree reports "Already up to date"
 * in 1 ms and repairs nothing; with the same tree and the same mtimes and the file removed, it
 * re-imports. Matched by prefix, because the name carries a state version pnpm has already
 * bumped once.
 */
const INSTALL_STATE_PREFIX = ".pnpm-workspace-state";

export interface PrunablePackage {
  /** The canonical `name@version` the tarball scan named. */
  key: string;
  name: string;
  version: string;
}

export interface PruneSuccess {
  ok: true;
  /** Virtual-store directory names removed, in the order they were found. */
  removedDirs: string[];
  /** Carried install-state files removed, so a session's own install cannot short-circuit. */
  removedState: string[];
  /** `packages:` / `snapshots:` keys removed from the carried lockfile. */
  removedLockKeys: string[];
  /** Dep-dir-relative paths of the symlinks removed alongside them. */
  removedLinks: string[];
  /** Virtual-store directories the base still carries; zero means it shares nothing. */
  remainingPackages: number;
}

export type PruneResult = PruneSuccess | { ok: false; detail: string };

class PruneError extends Error {}

function canonical(name: string, version: string): string {
  return `${name}@${version}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The identity a virtual-store directory's NAME claims, or null when the name does not carry one.
 *
 * This is the second of two signals, and it exists because the first one can be wrong: pnpm names
 * the directory from the lockfile key, while `packageIdentity` reads the installed manifest — and
 * an admitted `patchedDependencies` patch can rewrite that manifest's `name` or `version`. Found
 * by independent review 2026-09-21: with only the manifest read, a patched `esbuild@0.21.5` lost
 * its lockfile entries and KEPT its directory, unbuilt, and the verification agreed with the
 * removal because both used the same parser.
 *
 * Deliberately conservative. pnpm mangles the name — `/` becomes `+`, peer suffixes become `_`
 * separators, and a long one is truncated and hashed — so anything that does not parse cleanly
 * yields null and the manifest decides alone. A name that parses to a package the prune is NOT
 * removing changes nothing: the two signals are a union over the prune set, never a rule for
 * removing more than it names.
 */
function directoryIdentity(dirName: string): { name: string; version: string } | null {
  const bare = dirName.split(/[_(]/)[0].replace(/\+/g, "/");
  return splitLockKey(bare);
}

/**
 * The package a virtual-store directory holds, read from the package's own manifest. The manifest
 * is the same answer for every pnpm version, where the directory name is an internal encoding —
 * but see `directoryIdentity` for the case where the two disagree.
 */
function packageIdentity(virtualDir: string): { name: string; version: string } {
  const modules = path.join(virtualDir, "node_modules");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(modules, { withFileTypes: true });
  } catch (err) {
    throw new PruneError(`${virtualDir} carries no readable node_modules: ${message(err)}`);
  }

  // A package's own directory is the one REAL directory here; everything else it links to is a
  // symlink, and `.bin` is pnpm's own. A scoped package sits one level further down.
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.name === BIN_DIR || !entry.isDirectory()) continue;
    if (!entry.name.startsWith("@")) {
      candidates.push(path.join(modules, entry.name));
      continue;
    }
    for (const scoped of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
      if (scoped.isDirectory()) candidates.push(path.join(modules, entry.name, scoped.name));
    }
  }
  if (candidates.length !== 1) {
    throw new PruneError(
      `${virtualDir}/node_modules holds ${candidates.length} package directories, so the package `
      + "it carries cannot be identified",
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(candidates[0], "package.json"), "utf-8"));
  } catch (err) {
    throw new PruneError(`${candidates[0]} has no readable package.json: ${message(err)}`);
  }
  const name = isRecord(manifest) ? manifest.name : undefined;
  const version = isRecord(manifest) ? manifest.version : undefined;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new PruneError(`${candidates[0]}/package.json names no package and version`);
  }
  return { name, version };
}

/** What a virtual-store directory claims to hold, by both signals. */
interface StoreEntry {
  /** From the installed package's own manifest. */
  manifest: { name: string; version: string };
  /** From the directory name, which pnpm derives from the lockfile key. Null when it is mangled. */
  declared: { name: string; version: string } | null;
}

/** Every virtual-store directory, by directory name. Unreadable entries throw rather than skip. */
function virtualStore(depDir: string): Map<string, StoreEntry> {
  const root = path.join(depDir, VIRTUAL_STORE_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new PruneError(`the built tree has no readable ${VIRTUAL_STORE_DIR}: ${message(err)}`);
  }
  const out = new Map<string, StoreEntry>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === HOISTED_DIR) continue;
    out.set(entry.name, {
      manifest: packageIdentity(path.join(root, entry.name)),
      declared: directoryIdentity(entry.name),
    });
  }
  return out;
}

/**
 * Whether a virtual-store directory holds a package the prune removes, by EITHER signal. A
 * directory matched on its name alone is one whose installed manifest disagrees with the lockfile
 * key pnpm named it from — a patched manifest — and leaving it is how a build-bearing package
 * survives a prune that reported success.
 */
function entryMatches(entry: StoreEntry, targets: ReadonlySet<string>): { name: string; version: string } | null {
  for (const id of [entry.manifest, entry.declared]) {
    if (id && targets.has(canonical(id.name, id.version))) return id;
  }
  return null;
}

/**
 * What a dependency edge in the carried lockfile points at. The value is a bare version for an
 * ordinary dependency and a whole `name@version` for an `npm:` alias, so the dependency's own
 * name decides only the first case — reading it as the target either way misses every alias.
 */
export function resolveLockEdge(depName: string, raw: string): { name: string; version: string } | null {
  const withoutPeers = raw.replace(/\(.*\)$/, "").trim();
  if (withoutPeers === "") return null;
  // `link:`, `file:`, `workspace:` and friends resolve outside the registry and outside the base.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(withoutPeers)) return null;
  const at = withoutPeers.lastIndexOf("@");
  if (at > 0) {
    const name = withoutPeers.slice(0, at);
    const version = withoutPeers.slice(at + 1);
    if (name && version) return { name, version };
  }
  return { name: depName, version: withoutPeers };
}

function readCarriedLock(depDir: string): Record<string, unknown> {
  const file = path.join(depDir, VIRTUAL_STORE_DIR, CARRIED_LOCKFILE);
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new PruneError(
      `${VIRTUAL_STORE_DIR}/${CARRIED_LOCKFILE} could not be read, so a session's own install `
      + `could not be shown the prune: ${message(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new PruneError(`${VIRTUAL_STORE_DIR}/${CARRIED_LOCKFILE} is not a mapping`);
  }
  return parsed;
}

/**
 * Every reference is carried as fields, never as a joined path. Both halves can contain a `/` —
 * a lockfile key for a scoped package, an importer directory for a workspace member — so a
 * joined string cannot be taken apart again. Splitting one is how the first draft silently
 * rewrote nothing for a workspace (`pruned-base-spike.sh` cell B).
 */
interface LockKeyRef {
  section: string;
  key: string;
}
interface LockEdgeRef {
  importer: string;
  group: string;
  name: string;
}

function describeKey(ref: LockKeyRef): string {
  return `${ref.section}/${ref.key}`;
}

function describeEdge(ref: LockEdgeRef): string {
  return `${ref.importer}'s ${ref.group}.${ref.name}`;
}

/** Keys of `packages:` and `snapshots:` that resolve to one of the given packages. */
function lockKeysNaming(lock: Record<string, unknown>, targets: ReadonlySet<string>): LockKeyRef[] {
  const out: LockKeyRef[] = [];
  for (const section of ["packages", "snapshots"]) {
    const group = lock[section];
    if (!isRecord(group)) continue;
    for (const key of Object.keys(group)) {
      const split = splitLockKey(key);
      if (split && targets.has(canonical(split.name, split.version))) out.push({ section, key });
    }
  }
  return out;
}

/** Importer edges that resolve to one of the given packages. */
function importerEdgesNaming(
  lock: Record<string, unknown>,
  targets: ReadonlySet<string>,
): LockEdgeRef[] {
  const out: LockEdgeRef[] = [];
  const importers = lock.importers;
  if (!isRecord(importers)) return out;
  for (const [importer, value] of Object.entries(importers)) {
    if (!isRecord(value)) continue;
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = value[group];
      if (!isRecord(deps)) continue;
      for (const [name, entry] of Object.entries(deps)) {
        const raw = isRecord(entry) ? entry.version : entry;
        if (typeof raw !== "string") continue;
        const edge = resolveLockEdge(name, raw);
        if (edge && targets.has(canonical(edge.name, edge.version))) {
          out.push({ importer, group, name });
        }
      }
    }
  }
  return out;
}

function allLockKeys(lock: Record<string, unknown>): Map<string, LockKeyRef> {
  const out = new Map<string, LockKeyRef>();
  for (const section of ["packages", "snapshots"]) {
    const group = lock[section];
    if (!isRecord(group)) continue;
    for (const key of Object.keys(group)) out.set(describeKey({ section, key }), { section, key });
  }
  return out;
}

function importerDirs(lock: Record<string, unknown>): string[] {
  return isRecord(lock.importers) ? Object.keys(lock.importers).sort() : [];
}

/**
 * Symlinks the prune leaves pointing at a directory it removed, in the places a session reads
 * before its own install repairs anything: the importer view (`node_modules/<name>`), the
 * command shims beside it, and pnpm's hoisted-alias directory.
 *
 * Edges *inside* another package's `node_modules` are deliberately NOT collected. A retained
 * package that depends on a pruned one keeps its dangling edge, and pnpm relinks it: measured
 * with `vite` retained and `esbuild` pruned, 47 incoming edges left, `require("vite")` loading
 * after a bare install. Cutting them instead would mean pruning transitively, which is a
 * different and much larger removal set.
 */
function linkScanDirs(depDir: string): string[] {
  return [
    depDir,
    path.join(depDir, BIN_DIR),
    path.join(depDir, VIRTUAL_STORE_DIR, HOISTED_DIR),
    path.join(depDir, VIRTUAL_STORE_DIR, HOISTED_DIR, BIN_DIR),
  ];
}

function linksInto(depDir: string, removedDirs: ReadonlySet<string>): string[] {
  const storeRoot = path.join(depDir, VIRTUAL_STORE_DIR);
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.readlinkSync(full);
        } catch {
          continue;
        }
        const rel = path.relative(storeRoot, path.resolve(dir, target));
        const first = rel.split(path.sep)[0];
        if (!rel.startsWith("..") && !path.isAbsolute(rel) && removedDirs.has(first)) {
          out.push(path.relative(depDir, full));
        }
        continue;
      }
      // One level of `@scope/` only: a deeper walk would collect the intra-package edges above.
      if (entry.isDirectory() && depth === 0 && entry.name.startsWith("@")) visit(full, depth + 1);
    }
  };
  for (const dir of linkScanDirs(depDir)) visit(dir, 0);
  return out;
}

/**
 * Apply the prune to a built tree, then verify it. On any failure the caller must publish no
 * base: a half-pruned tree installs `rc=0` and runs code that was never built.
 */
export function prunePnpmBase(depDir: string, packages: readonly PrunablePackage[]): PruneResult {
  const targets = new Set(packages.map((p) => canonical(p.name, p.version)));
  try {
    const before = virtualStore(depDir);
    const beforeLock = readCarriedLock(depDir);
    const beforeKeys = allLockKeys(beforeLock);
    const beforeImporters = importerDirs(beforeLock);

    const removedDirs: string[] = [];
    for (const [dirName, entry] of before) {
      if (entryMatches(entry, targets) === null) continue;
      fs.rmSync(path.join(depDir, VIRTUAL_STORE_DIR, dirName), { recursive: true, force: true });
      removedDirs.push(dirName);
    }

    const removedSet = new Set(removedDirs);
    const removedLinks = linksInto(depDir, removedSet);
    for (const rel of removedLinks) fs.rmSync(path.join(depDir, rel), { force: true });

    const removedLockKeys = rewriteCarriedLock(depDir, beforeLock, targets).map(describeKey);
    const removedState = dropCarriedInstallState(depDir);

    const detail = verifyPrune(depDir, {
      targets,
      before,
      removedDirs: removedSet,
      beforeKeys,
      beforeImporters,
      lockfileVersion: beforeLock.lockfileVersion,
    });
    if (detail !== null) return { ok: false, detail };

    return {
      ok: true,
      removedDirs,
      removedState,
      removedLockKeys,
      removedLinks,
      remainingPackages: before.size - removedDirs.length,
    };
  } catch (err) {
    if (err instanceof PruneError) return { ok: false, detail: err.message };
    return { ok: false, detail: message(err) };
  }
}

/** Remove the carried install state; see `INSTALL_STATE_PREFIX`. Returns what was removed. */
function dropCarriedInstallState(depDir: string): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(depDir, { withFileTypes: true });
  } catch (err) {
    throw new PruneError(`the built tree could not be listed: ${message(err)}`);
  }
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.startsWith(INSTALL_STATE_PREFIX)) continue;
    try {
      fs.rmSync(path.join(depDir, entry.name), { force: true });
    } catch (err) {
      throw new PruneError(`${entry.name} could not be removed: ${message(err)}`);
    }
    removed.push(entry.name);
  }
  return removed;
}

function carriedInstallState(depDir: string): string[] {
  try {
    return fs
      .readdirSync(depDir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.startsWith(INSTALL_STATE_PREFIX))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function withoutKeys(
  group: Record<string, unknown>,
  drop: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(group).filter(([key]) => !drop.has(key)));
}

function rewriteCarriedLock(
  depDir: string,
  lock: Record<string, unknown>,
  targets: ReadonlySet<string>,
): LockKeyRef[] {
  // Each map is rebuilt without the removed keys rather than deleted from in place: the key is
  // repo-controlled, and a filtered copy cannot be made to mean anything but "these keys, minus
  // those". Insertion order is preserved, so the rewritten document reads like the original.
  const removed = lockKeysNaming(lock, targets);
  for (const section of new Set(removed.map((r) => r.section))) {
    const group = lock[section];
    if (!isRecord(group)) continue;
    const drop = new Set(removed.filter((r) => r.section === section).map((r) => r.key));
    lock[section] = withoutKeys(group, drop);
  }

  const edges = importerEdgesNaming(lock, targets);
  const importers = lock.importers;
  if (isRecord(importers)) {
    for (const ref of edges) {
      const importer = importers[ref.importer];
      if (!isRecord(importer)) continue;
      const deps = importer[ref.group];
      if (!isRecord(deps)) continue;
      importer[ref.group] = withoutKeys(
        deps,
        new Set(edges.filter((e) => e.importer === ref.importer && e.group === ref.group).map((e) => e.name)),
      );
    }
  }

  const file = path.join(depDir, VIRTUAL_STORE_DIR, CARRIED_LOCKFILE);
  try {
    fs.writeFileSync(file, stringifyYaml(lock));
  } catch (err) {
    throw new PruneError(`${VIRTUAL_STORE_DIR}/${CARRIED_LOCKFILE} could not be rewritten: ${message(err)}`);
  }
  return removed;
}

/**
 * Whether anything in the tree would hide the prune from a session's own install — the half of
 * the verification that stands on its own, and the one the whole mechanism turns on. Two things
 * hide it: a hole the carried lockfile still papers over, which a bare `pnpm install` reports as
 * up to date; and carried install state, which short-circuits before the lockfile is read at all.
 *
 * Returns the reason, or null when nothing does. An unreadable tree or lockfile is a reason,
 * never a pass.
 */
export function findPruneRemnants(
  depDir: string,
  packages: readonly PrunablePackage[],
): string | null {
  const targets = new Set(packages.map((p) => canonical(p.name, p.version)));
  const state = carriedInstallState(depDir);
  if (state.length > 0) {
    return `${state.join(", ")} would short-circuit a session's own install on the builder's `
      + "clock, before it reads the carried lockfile the prune rewrote";
  }
  let store: ReadonlyMap<string, StoreEntry>;
  let lock: Record<string, unknown>;
  try {
    store = virtualStore(depDir);
    lock = readCarriedLock(depDir);
  } catch (err) {
    return err instanceof PruneError ? err.message : message(err);
  }

  for (const [dirName, entry] of store) {
    const hit = entryMatches(entry, targets);
    if (hit !== null) {
      return `${dirName} still holds ${canonical(hit.name, hit.version)}, which the prune removes`;
    }
  }
  const surviving = lockKeysNaming(lock, targets);
  if (surviving.length > 0) {
    return `the carried lockfile still names ${surviving.slice(0, 3).map(describeKey).join(", ")}, `
      + "so a session's own install would report the tree up to date with a package missing from it";
  }
  const survivingEdges = importerEdgesNaming(lock, targets);
  if (survivingEdges.length > 0) {
    return `the carried lockfile still depends on ${survivingEdges.slice(0, 3).map(describeEdge).join(", ")}`;
  }
  return null;
}

/**
 * The named check the invariant rests on, taken over what is on disk after the rewrite: nothing
 * naming a pruned package survives, the prune removed exactly the packages it meant to, and it
 * removed nothing else.
 */
function verifyPrune(
  depDir: string,
  expected: {
    targets: ReadonlySet<string>;
    before: ReadonlyMap<string, StoreEntry>;
    removedDirs: ReadonlySet<string>;
    beforeKeys: ReadonlyMap<string, LockKeyRef>;
    beforeImporters: string[];
    lockfileVersion: unknown;
  },
): string | null {
  const remnant = findPruneRemnants(
    depDir,
    [...expected.targets].map((key) => {
      const at = key.lastIndexOf("@");
      return { key, name: key.slice(0, at), version: key.slice(at + 1) };
    }),
  );
  if (remnant !== null) return remnant;

  const after = virtualStore(depDir);
  const lock = readCarriedLock(depDir);

  for (const dirName of after.keys()) {
    if (!expected.before.has(dirName)) {
      return `${dirName} appeared in the virtual store during the prune`;
    }
  }
  for (const dirName of expected.before.keys()) {
    const gone = !after.has(dirName);
    if (gone !== expected.removedDirs.has(dirName)) {
      return gone
        ? `${dirName} was removed from the virtual store but is not a package the prune removes`
        : `${dirName} holds a package the prune removes but is still in the virtual store`;
    }
  }

  const afterKeys = allLockKeys(lock);
  for (const label of afterKeys.keys()) {
    if (!expected.beforeKeys.has(label)) {
      return `the carried lockfile gained ${label} during the prune`;
    }
  }
  for (const [label, ref] of expected.beforeKeys) {
    if (afterKeys.has(label)) continue;
    const split = splitLockKey(ref.key);
    if (!split || !expected.targets.has(canonical(split.name, split.version))) {
      return `${label} was removed from the carried lockfile but is not a package the prune removes`;
    }
  }
  if (lock.lockfileVersion !== expected.lockfileVersion) {
    return "the carried lockfile's lockfileVersion changed during the prune";
  }
  const afterImporters = importerDirs(lock);
  if (afterImporters.join("\0") !== expected.beforeImporters.join("\0")) {
    return "the carried lockfile's importer set changed during the prune";
  }

  const dangling = linksInto(depDir, expected.removedDirs);
  if (dangling.length > 0) {
    return `${dangling.slice(0, 3).join(", ")} still link into a removed package`;
  }
  return null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
