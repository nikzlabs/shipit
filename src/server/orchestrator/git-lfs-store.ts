import fs from "node:fs";
import path from "node:path";
import { runGit, repoDeclaresLfs, isGitLfsAvailable, PROBE_TIMEOUT_MS } from "./git-lfs.js";

/**
 * Cross-session Git LFS object sharing via the bare repo cache (docs/232, SHI-236).
 *
 * ## The problem
 *
 * docs/231 made LFS content materialize during provisioning, but nothing is
 * shared: **every** session clone on an asset-heavy repo pays its own full
 * network transfer, where plain git objects are hardlinked from the per-remote
 * bare cache for free. N sessions on one repo = N complete downloads.
 *
 * There are two independent causes, and fixing either alone changes nothing:
 *
 *  1. `git clone --local` hardlinks `.git/objects` but does **not** carry
 *     `.git/lfs` — a fresh clone starts with an empty LFS store.
 *  2. The bare cache has no LFS objects to share in the first place. LFS content
 *     is only fetched by the smudge filter or an explicit `git lfs fetch`, and
 *     the mirror fetch does neither — the orchestrator deliberately installs LFS
 *     with `--skip-smudge` (see the `git-lfs.ts` docstring for why that's
 *     load-bearing). So the cache's `lfs/objects` is empty even in principle.
 *
 * This module closes both: {@link fetchLfsIntoCache} populates the cache-side
 * store off the critical path, and {@link linkLfsObjectsIntoClone} hardlinks it
 * into each session clone — mirroring exactly what `clone --local` already does
 * for `.git/objects`.
 *
 * ## Why hardlinks and not a shared `lfs.storage`
 *
 * Pointing every clone's `lfs.storage` at one shared directory looks simpler and
 * is worse on two counts:
 *
 *  - **Isolation.** The store would have to be bind-mounted into every session
 *    container for in-container LFS to work, giving every agent write access to a
 *    directory every other session reads. One session could then corrupt or
 *    poison another's assets. Hardlinks share the *bytes* without sharing a
 *    writable namespace: the session sees only the links it was given, and the
 *    object files stay root-owned and are never chowned (see
 *    `session-worker-uid.ts`), so the agent can read them and cannot rewrite them.
 *  - **Prune.** `git lfs prune` in one session against a genuinely shared store
 *    can evict objects another live session still needs, because it prunes on its
 *    own reachability view. With hardlinks the kernel does the refcounting: each
 *    clone drops only *its* link, and the inode survives while any link remains.
 *    That's the same property `clone --local` relies on for git objects, and it's
 *    what makes a cache-side prune safe for live sessions too.
 *
 * ## Rollout
 *
 * **On by default**, with `SHIPIT_GIT_LFS_SHARED_STORE=off` as the escape hatch.
 * It shipped opt-in for one release as a canary, then flipped: the safety here
 * doesn't come from the flag, it comes from the design. Every function is
 * best-effort, and the seeding step is deliberately non-authoritative — a cache
 * fetch that fails or a link that can't be made just means the session's own
 * `git lfs pull` downloads the object, which is the pre-docs/232 behavior. So the
 * failure mode of being wrong about LFS is "no speedup", not "broken session", and
 * nothing here may fail provisioning.
 *
 * A repo that doesn't use LFS costs one `git grep` per background prefetch sweep
 * (`repoDeclaresLfs` answers no) and one `existsSync` per clone — so turning this
 * on is genuinely inert for non-LFS repos rather than merely cheap.
 *
 * What default-on *does* spend is **disk**: the cache-side store accumulates
 * asset versions as refs advance and there is still no cache-side prune, so it's
 * only reclaimed when the whole `repo-cache/<hash>` goes unreferenced. See
 * `docs/232-shared-lfs-object-store` Known gaps.
 */

/** Opt-**out** flag — see "Rollout" above. Off means every function here no-ops. */
const SHARED_STORE_ENV = "SHIPIT_GIT_LFS_SHARED_STORE";

/** Ceiling on the cache-side `git lfs fetch`. Off the critical path, so generous. */
const DEFAULT_CACHE_FETCH_TIMEOUT_MS = 900_000;
const CACHE_FETCH_TIMEOUT_ENV = "SHIPIT_GIT_LFS_CACHE_FETCH_TIMEOUT_MS";

/**
 * Whether cross-session LFS object sharing is enabled on this deployment.
 *
 * **On unless explicitly disabled.** The polarity matches `SHIPIT_GIT_LFS` in
 * `git-lfs.ts` (unset = on, `off` = off) so the two LFS knobs read the same way,
 * and an empty value — what a `${VAR:-}` compose passthrough supplies when the
 * operator hasn't set anything — means "default", not "off".
 */
export function lfsSharedStoreEnabled(): boolean {
  const raw = (process.env[SHARED_STORE_ENV] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

function cacheFetchTimeoutMs(): number {
  const raw = Number(process.env[CACHE_FETCH_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_FETCH_TIMEOUT_MS;
}

/** `<repo>/lfs/objects` in a bare cache; `<repo>/.git/lfs/objects` in a clone. */
export function lfsObjectsDir(repoDir: string, bare: boolean): string {
  return bare ? path.join(repoDir, "lfs", "objects") : path.join(repoDir, ".git", "lfs", "objects");
}

export interface LinkStats {
  /** Objects hardlinked from the cache into the clone. */
  linked: number;
  /** Objects copied because the hardlink couldn't be made (cross-device, etc.). */
  copied: number;
  /** Objects already present in the clone — nothing to do. */
  present: number;
  /** Objects that could be neither linked nor copied; the session re-downloads these. */
  failed: number;
}

/**
 * Which ref to hand `git lfs fetch` in a bare cache, or `null` if the repo has no
 * branches (nothing to fetch).
 *
 * **This exists because the bare-ref form is fragile.** `git lfs fetch origin`
 * with no ref resolves `HEAD`, and in a bare repo whose `HEAD` doesn't resolve it
 * fails outright — `Git can't resolve ref: "HEAD"`, zero objects fetched
 * (verified against git-lfs 3.3.0). That isn't hypothetical for our cache:
 * `RepoGit.readHead` already documents `HEAD` coming back unresolvable, and a
 * remote that renames its default branch leaves the cache's `HEAD` symref
 * pointing at a branch that the next `fetch --prune` (refspec
 * `+refs/heads/*:refs/heads/*`) deletes. The repo would then never share an
 * object again, quietly, for as long as the symref stayed dangling.
 *
 * Naming the ref explicitly sidesteps all of it: `git lfs fetch origin <branch>`
 * works whether or not `HEAD` resolves.
 */
export async function resolveCacheFetchRef(bareRepoDir: string): Promise<string | null> {
  // Prefer HEAD's own branch — that's the ref session clones are cut from, so
  // its objects are the ones worth having in the cache.
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], bareRepoDir, PROBE_TIMEOUT_MS);
  if (head.code === 0 && head.stdout.trim()) {
    const sym = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], bareRepoDir, PROBE_TIMEOUT_MS);
    const branch = sym.stdout.trim();
    if (sym.code === 0 && branch) return branch;
  }
  // HEAD is dangling or detached — fall back to any branch the cache does have,
  // which still shares far more than fetching nothing.
  const refs = await runGit(
    ["for-each-ref", "--count=1", "--format=%(refname:short)", "refs/heads/"],
    bareRepoDir,
    PROBE_TIMEOUT_MS,
  );
  const first = refs.stdout.trim().split("\n")[0]?.trim();
  return first || null;
}

/**
 * Fetch LFS objects into the **bare cache** so session clones can share them.
 *
 * Must be explicit: the orchestrator runs with `--skip-smudge`, and a mirror
 * `git fetch` never transfers LFS content on its own.
 *
 * Call from the cache-refresh path, which is off the user's critical path — the
 * whole point is to move the transfer off the claim slow-path, so this must never
 * be awaited from provisioning. Returns whether the cache store was populated;
 * `false` covers every "no thanks" case (flag off, not an LFS repo, no binary,
 * no branches, fetch failed) and is never an error the caller must handle.
 */
export async function fetchLfsIntoCache(
  bareRepoDir: string,
  opts?: { isAvailable?: () => Promise<boolean> },
): Promise<boolean> {
  if (!lfsSharedStoreEnabled()) return false;
  try {
    // Resolve the ref FIRST and use it for detection too. `repoDeclaresLfs`
    // defaults to grepping `HEAD`, and `git grep … HEAD` exits 128 on a bare repo
    // whose HEAD dangles — which reads as "not an LFS repo" and skips the fetch
    // before the fetch's own HEAD-independence ever helps. Both HEAD dependencies
    // have to go, or the dangling-HEAD cache still shares nothing.
    const ref = await resolveCacheFetchRef(bareRepoDir);
    if (!ref) return false; // no branches yet — nothing a session would check out
    if (!(await repoDeclaresLfs(bareRepoDir, ref))) return false;
    if (!(await (opts?.isAvailable ?? isGitLfsAvailable)())) {
      console.warn(`[git-lfs-store] Skipping cache fetch for ${bareRepoDir} — git-lfs binary unavailable`);
      return false;
    }
    const startedAt = Date.now();
    // `--all` would pull every version of every asset ever committed, which on an
    // asset-heavy repo is unboundedly larger than the working set. Naming one ref
    // fetches the objects for what a session clone actually checks out — and,
    // unlike the no-ref form, doesn't fall over on an unresolvable `HEAD` (see
    // `resolveCacheFetchRef`).
    const res = await runGit(["lfs", "fetch", "origin", ref], bareRepoDir, cacheFetchTimeoutMs());
    const durationMs = Date.now() - startedAt;
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200);
      console.warn(
        `[git-lfs-store] Cache LFS fetch failed for ${bareRepoDir} ` +
          `(${res.timedOut ? "timed out" : `exit ${res.code ?? "abnormal"}`})${detail ? `: ${detail}` : ""}` +
          ` — sessions will download their own objects`,
      );
      return false;
    }
    console.log(`[git-lfs-store] Fetched LFS objects into cache ${bareRepoDir} in ${durationMs}ms`);
    return true;
  } catch (err) {
    console.warn(`[git-lfs-store] Cache LFS fetch threw for ${bareRepoDir}:`, String(err));
    return false;
  }
}

/**
 * Hardlink the cache's LFS objects into a freshly cloned session workspace, so
 * the session's `git lfs pull` finds them locally instead of downloading them.
 *
 * Deliberately **not** authoritative: it doesn't need to be complete or even
 * correct about what the session needs. Anything it misses (an object committed
 * after the last cache fetch, a link that failed) is still downloaded by the
 * subsequent `materializeLfsContent` pull. That's what lets this be a pure
 * best-effort optimization with no correctness surface — it can only turn a
 * network transfer into a local link, never the reverse.
 *
 * Runs BEFORE `materializeLfsContent` (so the pull can see the objects) and
 * therefore before the chown handback, which is where the linked files' immunity
 * from `chown` matters — see the `lfsObjectsDir` branch in
 * `session-worker-uid.ts`.
 */
export function linkLfsObjectsIntoClone(bareRepoDir: string, sessionDir: string): LinkStats {
  const stats: LinkStats = { linked: 0, copied: 0, present: 0, failed: 0 };
  if (!lfsSharedStoreEnabled()) return stats;
  const src = lfsObjectsDir(bareRepoDir, true);
  const dst = lfsObjectsDir(sessionDir, false);
  try {
    if (!fs.existsSync(src)) return stats; // cache never fetched LFS for this repo
    linkTree(src, dst, stats);
    const total = stats.linked + stats.copied;
    if (total > 0 || stats.failed > 0) {
      console.log(
        `[git-lfs-store] Seeded ${sessionDir} from cache: ${stats.linked} linked, ` +
          `${stats.copied} copied, ${stats.present} already present, ${stats.failed} failed`,
      );
    }
  } catch (err) {
    // A partially-seeded store is fine — the pull fills the gaps.
    console.warn(`[git-lfs-store] Seeding ${sessionDir} from ${bareRepoDir} failed:`, String(err));
  }
  return stats;
}

/**
 * Recreate `src`'s directory structure under `dst`, hardlinking regular files.
 *
 * Hardlink first, copy as the fallback: `EXDEV` (cache and session dirs on
 * different filesystems) is the expected miss and costs disk instead of network,
 * which is still the trade we want. Symlinks are skipped entirely rather than
 * recreated — git-lfs never writes one into the object store, so one appearing
 * here means something else did, and following it could write outside `dst`.
 */
function linkTree(src: string, dst: string, stats: LinkStats): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  let dstReady = false;
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      linkTree(from, to, stats);
      continue;
    }
    if (!entry.isFile()) continue; // symlink / socket / fifo — not ours to copy
    // Created lazily so an empty fanout dir in the cache doesn't leave an empty
    // one behind in every clone.
    if (!dstReady) {
      try {
        fs.mkdirSync(dst, { recursive: true });
        dstReady = true;
      } catch {
        stats.failed += entries.length;
        return;
      }
    }
    try {
      fs.linkSync(from, to);
      stats.linked++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        stats.present++;
        continue;
      }
      try {
        fs.copyFileSync(from, to);
        stats.copied++;
      } catch {
        stats.failed++;
      }
    }
  }
}
