import fs from "node:fs";
import path from "node:path";
import { identityForTarget } from "./session-worker-uid.js";
import { PNPM_VERIFIED_NAMESPACE, type DepDirOverlaySpec } from "./overlay-session.js";
import type { SessionIdentity } from "../shared/session-identity.js";

/**
 * Seeds a verified pnpm base's executable targets into the session's overlay upper, owned by the
 * session (planning#606, docs/276 section 5 "Sharing for ineligible repos").
 *
 * Any install that relinks `.bin` chmods every executable target **unconditionally** — 10 calls in
 * the harness set a mode the file already had. Over a mounted base those targets are lower files
 * owned by the publishing uid: the session may rewrite their bytes (copy-up) but not chmod them, so
 * `pnpm add` dies with `ERR_PNPM_CMD_SHIM_CHMOD` … `Operation not permitted` and docs/276 req 9 is
 * broken. Pre-copying each target into the upper puts a file the session OWNS at that path, and
 * pnpm's chmod lands there instead. Matching the modes cannot work (the chmod is unconditional),
 * shared ownership cannot exist under per-session uids (docs/270), and the container has no
 * `CAP_FOWNER`.
 *
 * The upper is SESSION-controlled and a preserved Compose service can still be writing to it while
 * this runs, so every path inside it is resolved through a **directory descriptor** rather than by
 * name: a swapped ancestor cannot redirect an orchestrator-privileged mkdir, create or chmod out of
 * the tree (the docs/272 lesson, in a place docs/272 does not reach).
 */

/** pnpm's virtual store: every real package directory in an isolated tree lives under it. */
const PNPM_VIRTUAL_STORE_DIR = ".pnpm";

/** Beside the upper, never inside it: the upper is the mounted tree the agent sees. */
export const BIN_SEED_MARKER_FILE = "bin-seed.json";

// A `directories.bin` is ordinary package content; bound the walk rather than trusting its shape.
const MAX_BIN_DIR_DEPTH = 16;
const MAX_BIN_DIR_FILES = 4096;

export interface BinSeedMarker {
  version: 1;
  seededAt: string;
  files: number;
  bytes: number;
}

export interface BinSeedResult {
  /** Files copied into the upper by this run. */
  files: number;
  bytes: number;
  /** Targets the upper already had — an agent edit, or a previous seed. Never replaced. */
  present: number;
  /** Targets that could not be copied; a non-zero count leaves no marker, so the next start retries. */
  failed: number;
}

export function binSeedMarkerPath(upperdir: string): string {
  return path.join(path.dirname(upperdir), BIN_SEED_MARKER_FILE);
}

interface PackageManifest {
  bin?: unknown;
  directories?: { bin?: unknown };
}

/**
 * The executable targets of one package directory, as paths relative to it.
 *
 * Read off the shims pnpm 12.5.1 actually writes, not off the manifest spec. What that shows:
 * `directories.bin` is enumerated **recursively** (a file four levels down gets its own shim), an
 * empty-string `bin` falls through to it, an empty-object `bin` does not, and a non-empty `bin`
 * takes precedence over it.
 *
 * This takes the **union** anyway — `bin` and every file under `directories.bin`, always. The
 * asymmetry is the reason: a target pnpm links and this misses stays in the foreign-owned lower and
 * `pnpm add` EPERMs on it, while a file pnpm never touches costs one byte-identical copy of a
 * script. So the precedence rules above are worth knowing and not worth encoding — each one is a
 * place a future pnpm could change and take the defect with it. The recursion is NOT optional in
 * the same way: dropping it loses targets pnpm does link.
 */
export function packageBinTargets(pkgDir: string): string[] {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return [];
  }
  const declared: string[] = [];
  const bin = manifest.bin;
  if (typeof bin === "string") {
    declared.push(bin);
  } else if (bin !== null && typeof bin === "object") {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === "string") declared.push(value);
    }
  }
  if (typeof manifest.directories?.bin === "string") {
    const binDir = path.resolve(pkgDir, manifest.directories.bin);
    if (withinDir(pkgDir, binDir)) {
      for (const file of filesUnder(binDir, 0)) declared.push(path.relative(pkgDir, file));
    }
  }

  const targets = new Set<string>();
  for (const declaredPath of declared) {
    if (declaredPath === "") continue;
    const abs = path.resolve(pkgDir, declaredPath);
    // A manifest is package-controlled input: a `bin` escaping its own package names a file the
    // seed has no business copying.
    if (!withinDir(pkgDir, abs)) continue;
    if (!isRegularFile(abs)) continue;
    targets.add(path.relative(pkgDir, abs));
  }
  return [...targets].sort();
}

// Regular files only, and never through a symlinked directory: a published base is built from
// verified tarballs, but a tarball may still carry links.
function filesUnder(dir: string, depth: number): string[] {
  if (depth > MAX_BIN_DIR_DEPTH) return [];
  const found: string[] = [];
  for (const entry of readDirSafe(dir)) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(child, depth + 1));
    else if (entry.isFile()) found.push(child);
    if (found.length > MAX_BIN_DIR_FILES) break;
  }
  return found.slice(0, MAX_BIN_DIR_FILES);
}

/**
 * Every executable target of every package in a pnpm tree, as paths relative to the tree root,
 * sorted and deduplicated.
 *
 * Checked against pnpm's own answer, not just against the manifest rule: pnpm's shim writer leaves
 * the absolute target in a `# cmd-shim-target=` trailer, so the set it actually linked is readable
 * and the two are compared in `integration_tests/pnpm-store-isolation.test.ts`.
 */
export function resolvePnpmBinSeedSet(treeRoot: string): string[] {
  const targets = new Set<string>();
  const virtualStore = path.join(treeRoot, PNPM_VIRTUAL_STORE_DIR);
  for (const entry of readDirSafe(virtualStore)) {
    if (!entry.isDirectory()) continue;
    collectPackages(path.join(virtualStore, entry.name, "node_modules"), treeRoot, targets);
  }
  return [...targets].sort();
}

// One level, descending only into `@scope` directories. readdir reports a symlinked dependency as
// a link rather than a directory, so the packages a virtual-store entry links in are skipped: each
// real package is reached through its own entry.
function collectPackages(dir: string, treeRoot: string, out: Set<string>): void {
  for (const entry of readDirSafe(dir)) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      collectPackages(child, treeRoot, out);
      continue;
    }
    for (const target of packageBinTargets(child)) {
      const rel = path.relative(treeRoot, path.join(child, target));
      if (withinRel(rel)) out.add(rel);
    }
  }
}

/**
 * Copy each seed target from the base into the upper: byte-identical, same mode, owned by the
 * session. An entry the upper already has is LEFT ALONE — it is the agent's own edit to a
 * dependency (docs/276 req 11), and replacing it is the one way this repair could destroy work.
 *
 * Each file is written to a temporary name and published with `link()`, which fails rather than
 * replacing: a write that dies part-way leaves no half-file for a later run to mistake for a
 * finished one.
 */
export function seedBinTargetsIntoUpper(args: {
  lowerdir: string;
  upperdir: string;
  targets?: string[];
  /** `null` means there is no session identity to hand ownership to; omitted resolves it. */
  owner?: SessionIdentity | null;
}): BinSeedResult {
  const { lowerdir, upperdir } = args;
  const targets = args.targets ?? resolvePnpmBinSeedSet(lowerdir);
  const owner = args.owner === undefined ? identityForTarget(upperdir) : args.owner;
  const result: BinSeedResult = { files: 0, bytes: 0, present: 0, failed: 0 };
  if (targets.length === 0) return result;

  let rootFd: number;
  try {
    rootFd = openDirNoFollow(upperdir);
  } catch (err) {
    result.failed = targets.length;
    warn(`could not open the overlay upper ${upperdir}`, err);
    return result;
  }
  try {
    for (const rel of targets) seedOne({ rootFd, lowerdir, upperdir, rel, owner, result });
  } finally {
    fs.closeSync(rootFd);
  }
  return result;
}

function seedOne(args: {
  rootFd: number;
  lowerdir: string;
  upperdir: string;
  rel: string;
  owner: SessionIdentity | null;
  result: BinSeedResult;
}): void {
  const { rootFd, lowerdir, rel, owner, result } = args;
  const src = path.join(lowerdir, rel);
  let data: Buffer;
  let mode: number;
  try {
    const stat = fs.lstatSync(src);
    if (!stat.isFile()) return;
    mode = stat.mode & 0o7777;
    data = fs.readFileSync(src);
  } catch (err) {
    result.failed += 1;
    warn(`could not read the base's bin target ${rel}`, err);
    return;
  }

  const dir = openUpperDir({ rootFd, lowerdir, rel: path.dirname(rel), owner });
  if (dir === null) {
    result.failed += 1;
    return;
  }
  try {
    publish({ dirFd: dir.fd, name: path.basename(rel), data, mode, owner, rel, result });
  } finally {
    if (dir.fd !== rootFd) fs.closeSync(dir.fd);
  }
}

/** Walk (and create) `rel` inside the upper, each step resolved through the previous step's fd. */
function openUpperDir(args: {
  rootFd: number;
  lowerdir: string;
  rel: string;
  owner: SessionIdentity | null;
}): { fd: number } | null {
  const { rootFd, lowerdir, rel, owner } = args;
  if (rel === "" || rel === ".") return { fd: rootFd };
  let fd = rootFd;
  let walked = "";
  for (const segment of rel.split(path.sep)) {
    const at = descriptorPath(fd, segment);
    walked = walked === "" ? segment : path.join(walked, segment);
    let created = false;
    try {
      fs.mkdirSync(at);
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        if (fd !== rootFd) fs.closeSync(fd);
        warn(`could not create ${walked} in the overlay upper`, err);
        return null;
      }
    }
    let next: number;
    try {
      // O_NOFOLLOW: a symlink the session put here fails ELOOP rather than redirecting us.
      next = openDirNoFollow(at);
    } catch (err) {
      if (fd !== rootFd) fs.closeSync(fd);
      warn(`refusing to seed through ${walked}: the overlay upper does not have a directory there`, err);
      return null;
    }
    if (fd !== rootFd) fs.closeSync(fd);
    fd = next;
    if (created) {
      // The merged view shows the UPPER directory's mode, so a copied-up directory that is not
      // group-writable would take the base's group write away from Compose services (docs/271 §3).
      applyDirMetadata(fd, path.join(lowerdir, walked), owner, walked);
    }
  }
  return { fd };
}

function publish(args: {
  dirFd: number;
  name: string;
  data: Buffer;
  mode: number;
  owner: SessionIdentity | null;
  rel: string;
  result: BinSeedResult;
}): void {
  const { dirFd, name, data, mode, owner, rel, result } = args;
  const tmpName = `.shipit-bin-seed.${process.pid}.${tmpCounter++}`;
  const tmpAt = descriptorPath(dirFd, tmpName);
  let fd: number;
  try {
    // `wx` is O_CREAT|O_EXCL, which refuses an existing entry — a symlink planted here included.
    fd = fs.openSync(tmpAt, "wx", 0o600);
  } catch (err) {
    result.failed += 1;
    warn(`could not stage ${rel} in the overlay upper`, err);
    return;
  }
  let staged = false;
  try {
    let written = 0;
    while (written < data.length) written += fs.writeSync(fd, data, written);
    fs.fchmodSync(fd, mode);
    // Ownership is the whole point of the seed, so a chown that fails is a FAILED seed and not a
    // warning: the file would be there and pnpm's chmod would still EPERM on it.
    if (owner) fs.fchownSync(fd, owner.uid, owner.gid);
    staged = true;
  } catch (err) {
    result.failed += 1;
    warn(`could not write ${rel} into the overlay upper`, err);
  } finally {
    fs.closeSync(fd);
    if (!staged) removeQuietly(tmpAt);
  }
  if (!staged) return;
  try {
    // link() never replaces: an entry the agent put here wins, whatever the marker says.
    fs.linkSync(tmpAt, descriptorPath(dirFd, name));
    result.files += 1;
    result.bytes += data.length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") result.present += 1;
    else {
      result.failed += 1;
      warn(`could not publish ${rel} in the overlay upper`, err);
    }
  } finally {
    removeQuietly(tmpAt);
  }
}

/**
 * Seed a freshly created upper once, and record it in a marker beside the upper so the decision is
 * idempotent and inspectable.
 *
 * Seed-once is the whole point: `prepareOverlayDirs` resets an upper only when the base generation
 * is superseded, so WITHIN a generation the upper is reused across container restarts and
 * re-seeding would put the base's copy back over the agent's own edit (req 11 inverted). A rotation
 * deletes the generation directory, marker included, so the next generation seeds again. The
 * never-replace rule in `publish` is the second, independent guarantee of the same thing.
 *
 * A run that could not copy everything leaves NO marker, so the next start retries the entries that
 * are still missing rather than declaring a partial seed done.
 */
export function seedOverlayBinTargetsOnce(
  spec: DepDirOverlaySpec,
  opts: { tag?: string } = {},
): BinSeedResult | null {
  if (spec.scope.namespace !== PNPM_VERIFIED_NAMESPACE) return null;
  if (!spec.orchDirs) return null;
  const { lowerdir, upperdir } = spec.orchDirs;
  const marker = binSeedMarkerPath(upperdir);
  if (fs.existsSync(marker)) return null;

  const tag = opts.tag ?? "[overlay]";
  const result = seedBinTargetsIntoUpper({ lowerdir, upperdir });
  const cost = `${result.files} file(s) / ${Math.round(result.bytes / 1024)} KiB`;
  if (result.failed > 0) {
    console.error(
      `${tag} seeded only ${cost} of the verified base's executable targets for ${spec.depDir} — ` +
      `${result.failed} failed, so no marker is written and the next container start retries them; ` +
      "until then `pnpm add` in this session fails EPERM (planning#606)",
    );
    return result;
  }
  try {
    const payload: BinSeedMarker = {
      version: 1,
      seededAt: new Date().toISOString(),
      files: result.files,
      bytes: result.bytes,
    };
    fs.writeFileSync(marker, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    console.warn(
      `${tag} could not record the bin seed for ${spec.depDir}; the next start will re-run it ` +
      "against the entries that are still missing:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // A base with no executables at all needs no seed and is not worth a line.
  if (result.files > 0 || result.present > 0) {
    const kept = result.present > 0 ? `, kept ${result.present} the upper already had` : "";
    console.log(
      `${tag} seeded ${cost} of verified-base executable targets into ${spec.depDir}'s upper` +
      `${kept} so this session can chmod them (planning#606)`,
    );
  }
  return result;
}

let tmpCounter = 0;

/**
 * `mkdirat`/`openat` have no Node binding, and this must not resolve a path the session can reshape
 * between two calls. Linux answers both: a name under `/proc/self/fd/<dirfd>` is resolved from that
 * descriptor, so the ancestors are fixed by the kernel rather than re-walked by name.
 */
function descriptorPath(dirFd: number, name: string): string {
  return `/proc/self/fd/${dirFd}/${name}`;
}

function openDirNoFollow(target: string): number {
  return fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
}

function applyDirMetadata(
  fd: number,
  lowerCounterpart: string,
  owner: SessionIdentity | null,
  label: string,
): void {
  try {
    fs.fchmodSync(fd, modeOf(lowerCounterpart) ?? 0o775);
    if (owner) fs.fchownSync(fd, owner.uid, owner.gid);
  } catch (err) {
    warn(`could not set the mode or owner of ${label} in the overlay upper`, err);
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // A leftover staging file is visible to the session and harmless; the next seed uses a new name.
  }
}

function modeOf(p: string): number | null {
  try {
    return fs.lstatSync(p).mode & 0o7777;
  } catch {
    return null;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function withinDir(root: string, target: string): boolean {
  return withinRel(path.relative(root, target));
}

function withinRel(rel: string): boolean {
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function warn(what: string, err: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : "";
  console.warn(`[overlay:bin-seed] ${what}${detail}`);
}
