/**
 * Lockfile-keyed `node_modules` store — fast path for the worker's install
 * step. See `docs/148-fast-npm-install/plan.md`.
 *
 * Engages only for a recognized **single bare** installer command (`npm
 * install|ci|i`, `yarn [install]`, `pnpm install|i`) with exactly one
 * top-level lockfile. Anything else falls through to today's plain install
 * — `agent.install` is arbitrary shell, and snapshotting only `node_modules`
 * for a script that also writes `.venv/` or `vendor/` would silently drop
 * side effects.
 *
 * Topology constraint: this runs inside the session container's worker,
 * because the workspace is a Docker named volume the orchestrator can't
 * see. Materialization is therefore a worker-side file operation (tar
 * stream → cp -a → fall through to real install), not an overlay mount.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Container-internal mount point for the per-repo `node_modules` store. Lives
 * inside the existing `/dep-cache` mount so no additional Docker mount is
 * needed — npm tarball cache and the materialized-tree store share one volume
 * subtree per repo.
 */
export const DEFAULT_NM_STORE_CONTAINER_PATH = "/dep-cache/nm-store";

/** Kill-switch env var. Set to `"disabled"` to force today's plain install. */
export const FAST_INSTALL_ENV = "SHIPIT_FAST_INSTALL";

/** Override env var — tests point this at a temp directory. */
export const NM_STORE_DIR_ENV = "SHIPIT_NM_STORE_DIR";

export function fastInstallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FAST_INSTALL_ENV] === "disabled";
}

/** Resolve the on-host store root, honoring the test/override env var. */
export function nmStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[NM_STORE_DIR_ENV] ?? DEFAULT_NM_STORE_CONTAINER_PATH;
}

const LOCKFILE_NAMES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;
export type LockfileName = (typeof LOCKFILE_NAMES)[number];

export interface LockfileInfo {
  name: LockfileName;
  path: string;
  contentHash: string;
}

/**
 * Return the single top-level lockfile in `workspaceDir`, or null when
 * zero or more than one is present. v1 deliberately falls through to a
 * plain install in the multi-lockfile case — that's a workspace/monorepo
 * shape (or an in-progress package-manager migration) and a single hoisted
 * `node_modules` cache wouldn't be correct.
 */
export function findLockfile(workspaceDir: string): LockfileInfo | null {
  const found: LockfileInfo[] = [];
  for (const name of LOCKFILE_NAMES) {
    const lockPath = path.join(workspaceDir, name);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(lockPath);
    } catch {
      continue;
    }
    const contentHash = crypto.createHash("sha256").update(buf).digest("hex");
    found.push({ name, path: lockPath, contentHash });
  }
  if (found.length !== 1) return null;
  return found[0];
}

/**
 * Compute a runtime fingerprint that participates in the store key so a tree
 * built for one runtime is a *cache miss* on another. Native addons (`.node`
 * binaries from `node-gyp`/`prebuild-install`) are compiled against the
 * specific Node ABI, arch, and libc — restoring an x64/glibc tree into an
 * arm64/musl container would load-fail at agent startup, *after* install
 * was already marked done. Erring on the side of more invalidations (a
 * spurious miss is one slow install) is the safe direction.
 *
 * `IMAGE_DIGEST`/`SESSION_WORKER_IMAGE_ID` is consulted first so a deploy
 * that rebuilds the worker image gets a fresh key for free.
 */
export function runtimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const imageId = env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  const libc = detectLibc();
  // `process.versions.node` carries the patch version too, but the ABI
  // we care about is the major. A node 22.x → 22.y bump can reuse the
  // store; 22 → 24 cannot.
  const nodeMajor = process.versions.node.split(".")[0];
  return `${imageId}|${process.arch}|${libc}|node${nodeMajor}`;
}

function detectLibc(): string {
  // Node's `process.report.getReport()` exposes `header.glibcVersionRuntime`
  // on glibc systems; alpine/musl returns no such field. Resort to "musl"
  // when the field is absent — good enough for the storeKey, since the
  // alternative is keying everything to "unknown" and losing all reuse.
  try {
    const report = (process.report as { getReport?: () => unknown }).getReport?.();
    const header = (report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (header?.glibcVersionRuntime) return `glibc-${header.glibcVersionRuntime}`;
    return "musl";
  } catch {
    return "unknown";
  }
}

/**
 * Whether the given install command is a single bare invocation of a
 * recognized package manager — the only shape we will swap for a
 * materialize. Any shell metacharacter (chaining, redirection, env
 * prefix, pipes, substitution) or extra arg disqualifies the command.
 */
export function isCacheableInstall(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Reject any shell metacharacter — anything that could make the command
  // produce side effects beyond `node_modules`.
  if (/[&;|<>$`(){}\\*?[\]]/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  // `FOO=bar npm install` — env prefix disqualifies.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
  const [tool, sub, ...rest] = tokens;
  if (tool === "npm") {
    if (rest.length !== 0) return false;
    return sub === "install" || sub === "i" || sub === "ci";
  }
  if (tool === "yarn") {
    if (sub === undefined) return true; // bare `yarn` defaults to install
    if (sub === "install" && rest.length === 0) return true;
    return false;
  }
  if (tool === "pnpm") {
    if (rest.length !== 0) return false;
    return sub === "install" || sub === "i";
  }
  return false;
}

/**
 * Option E — inject `--prefer-offline --no-audit --no-fund` into bare
 * `npm install|ci|i` invocations. Audit + fund metadata round-trips are
 * pure overhead in our setting and easily shave seconds. Only the exact
 * cacheable shapes are tuned, so a user who deliberately wrote
 * `npm install --audit` (which `isCacheableInstall` already rejects) is
 * untouched.
 */
export function tuneNpmInstall(command: string): string {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== "npm") return trimmed;
  if (!(tokens[1] === "install" || tokens[1] === "i" || tokens[1] === "ci")) return trimmed;
  if (tokens.length !== 2) return trimmed; // only the bare form qualifies
  return `${trimmed} --prefer-offline --no-audit --no-fund`;
}

/**
 * Canonical store key: `sha256(lockfileName || lockfileContent || runtimeKey
 * || resolvedInstallCommand)`. Hashing lockfile *content* shares the store
 * across repos with identical deps. Including the resolved (post-tuning)
 * command ensures `npm install` and `npm install --omit=dev` (which build
 * different trees from the same lockfile) can never share a store.
 */
export function computeStoreKey(args: {
  lockfile: LockfileInfo;
  runtimeKey: string;
  installCommand: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(args.lockfile.name)
    .update("\0")
    .update(args.lockfile.contentHash)
    .update("\0")
    .update(args.runtimeKey)
    .update("\0")
    .update(args.installCommand)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// materialize / populate
// ---------------------------------------------------------------------------

export type MaterializeStrategy = "tar" | "copy";

export interface MaterializeResult {
  ok: boolean;
  strategy?: MaterializeStrategy;
  /** Set when `ok === false`. The last error from the ladder, for logs. */
  error?: string;
}

/**
 * Materialize the store directory into `destDir` as an **independent
 * copy** — the agent may `npm rebuild` / patch-package / add a dep
 * mid-session, so sharing inodes with the store (e.g. `cp -al`) would
 * corrupt the store the moment that happens. Hardlink ladder is
 * deliberately rejected for that reason.
 *
 * Ladder: tar-stream → `cp -a` → fail (caller falls through to real
 * install). Reflink (`cp --reflink=always`) is omitted here because the
 * prod VPS is ext4; add it as a rung above tar when a host with xfs(reflink)
 * /btrfs appears.
 *
 * `destDir` is created (or cleared) before extraction — the marker check
 * has already established that no completed install is in this workspace.
 */
export async function materialize(
  storeDir: string,
  destDir: string,
): Promise<MaterializeResult> {
  // The store dir must exist; the caller is supposed to check, but defend
  // anyway — failing fast here surfaces a clearer signal than a tar error
  // would.
  try {
    const st = await fsp.stat(storeDir);
    if (!st.isDirectory()) return { ok: false, error: `${storeDir} is not a directory` };
  } catch (err) {
    return { ok: false, error: `store missing: ${(err as Error).message}` };
  }

  // Wipe any pre-existing partial `node_modules` from a failed install so
  // the materialized tree is exactly the store contents.
  await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(destDir, { recursive: true });

  // Rung 1 — tar-stream. Fewer per-file syscalls than `cp -a` on trees of
  // ~10k tiny files.
  try {
    await runShell(`tar -C ${shq(storeDir)} -cf - . | tar -C ${shq(destDir)} -xf -`);
    return { ok: true, strategy: "tar" };
  } catch {
    // fall through
  }

  // Rung 2 — `cp -a`. Always correct, slower. Reset destDir first so a
  // partial tar extract doesn't leak into the copy result.
  await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(destDir, { recursive: true });
  try {
    await runShellArgs("cp", ["-a", `${storeDir}/.`, destDir]);
    return { ok: true, strategy: "copy" };
  } catch (err) {
    // Leave destDir cleaned up so the caller can do a real install into
    // a fresh workspace.
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Publish `srcDir` (a freshly-installed `node_modules`) into `storeDir`
 * via **temp-dir + atomic rename**. Single-flight across processes is
 * achieved by the rename: at most one populator wins, the others see
 * `storeDir` already present and drop their temp.
 *
 * Never overwrites an existing store. If two sessions race on the same
 * brand-new storeKey, the loser's `cp -a` into the temp dir is wasted
 * work, but no reader ever sees a torn store and no in-progress reader
 * can have its inodes pulled out from under it.
 */
export async function populateStore(
  srcDir: string,
  storeDir: string,
): Promise<{ published: boolean }> {
  // Fast skip: already published. Common when the on-activation install
  // raced a warm-pool pre-install for the same lockfile.
  try {
    await fsp.stat(storeDir);
    return { published: false };
  } catch {
    /* not yet — populate */
  }

  const parent = path.dirname(storeDir);
  await fsp.mkdir(parent, { recursive: true });
  const tmp = path.join(
    parent,
    `.tmp-${crypto.randomBytes(8).toString("hex")}-${path.basename(storeDir)}`,
  );

  try {
    await runShellArgs("cp", ["-a", `${srcDir}/.`, tmp]);
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // Atomic publish. Linux directory rename fails with ENOTEMPTY/EEXIST
  // when dest exists and is non-empty — exactly the signal we want for
  // "another populator beat us, drop our temp."
  try {
    await fsp.rename(tmp, storeDir);
    return { published: true };
  } catch {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { published: false };
  }
}

// ---------------------------------------------------------------------------
// shell helpers — kept local so the module has zero runtime deps
// ---------------------------------------------------------------------------

/** Shell-quote a single path argument (no shell metacharacters in paths). */
function shq(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function runShell(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, { shell: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

function runShellArgs(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}
