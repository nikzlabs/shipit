/**
 * planning#384 / docs/266 — decide the uid an orchestrator-side `git` runs as.
 *
 * ## Why this exists
 *
 * A session's workspace is bind-mounted read-write into containers whose code
 * is untrusted by design (a plugin CLI run, a plugin service), and
 * `chownWorkspaceGitToSessionWorker` makes `.git` writable to exactly the uid
 * those containers run as. An ordinary `npm install` reaches the same place —
 * a dependency's `postinstall` runs in the session worker as that same uid, so
 * this is NOT a plugin-specific hazard (docs/266 req 2).
 *
 * Git executes code named by repository-local configuration. Reproduced against
 * git 2.39.5 with PR #2301's `core.hooksPath=/dev/null` guard in force:
 * `filter.<name>.clean` runs during `git add`/`commit`, `core.fsmonitor` runs
 * during a plain `git status`, and a `!`-prefixed `alias.*` runs too. The set is
 * not enumerable — `filter.<name>` is arbitrarily named — and several members
 * are load-bearing (git-lfs *is* a filter), so it cannot be denied key by key
 * (docs/266 req 3).
 *
 * So the fix is not to disarm the payload. It is to stop running it as **root
 * in the orchestrator**, which holds `/credentials`, `/var/run/docker.sock` and
 * every session's workspace. Run git as the uid that owns the tree instead, and
 * the payload executes at exactly the authority its author already had — which
 * is no escalation at all (docs/266 req 11, decided 2026-08-16).
 *
 * ## Why ownership is the predicate, and not a path or a threaded parameter
 *
 * The obvious implementations are worse:
 *
 *   - **Thread a uid through every call site.** There are ~189 `createGitManager`
 *     calls plus 13 raw `safeSimpleGit(workspaceDir)` sites across 8 files. A
 *     hand-converted list is stale the moment someone adds the fourteenth, and
 *     the failure is silent.
 *   - **Match the path against the sessions root.** Needs configuration this
 *     module cannot see, and it re-answers a question the filesystem already
 *     answers.
 *
 * Ownership is the same fact git's own CVE-2022-24765 check tests. That makes
 * the two self-consistent by construction: where we correctly drop, git is
 * satisfied; where we fail to drop, git *would* refuse with "detected dubious
 * ownership" rather than execute the payload (docs/266 req 7).
 *
 * **That fail-closed half is NOT yet in force.** `git-config.ts` still sets
 * `safe.directory=*` globally, which is precisely what suppresses that refusal,
 * so today a call site that fails to drop silently runs as root exactly as
 * before. Narrowing it is docs/266 E2 and is deliberately a separate change:
 * removing the `*` turns every missed site into a hard failure at once, and it
 * should land only after this drop has been observed working in production.
 * Until then the coverage this module gives is real but not self-enforcing.
 *
 * ## When this returns null (i.e. no drop)
 *
 *   - **We are not root.** Inside the session worker container, in local mode,
 *     and in every test, so all three are byte-for-byte unchanged. A non-root
 *     process cannot setuid anyway; asking would be an EPERM at spawn.
 *   - **The tree is root-owned.** The shared bare cache and `/opt/shipit` are
 *     ShipIt's own, not a session's, and nothing untrusted can write them.
 *     (Verified for the bare cache: `buildMounts` in `container-lifecycle.ts`
 *     binds the workspace, per-session credentials, uploads, scratch, session
 *     state, the plugin store, the dep cache and the pnpm store — not the cache.)
 *   - **The path cannot be stat'd.** A missing directory is not a tree we can
 *     reason about; git will fail on it for its own reasons.
 */

import fs from "node:fs";

/** The uid/gid an orchestrator-side git should drop to, or `null` for "stay put". */
export interface GitTreeUid {
  uid: number;
  gid: number;
}

/**
 * Injection seam. The real implementations are `process.getuid` and
 * `fs.statSync`; tests supply fakes because the interesting states (running as
 * root, against a tree owned by someone else) cannot be produced in a session
 * container — it has no root and `unshare -r` is refused.
 */
export interface GitTreeUidDeps {
  getuid: () => number | undefined;
  statOwner: (dir: string) => { uid: number; gid: number } | null;
}

export const defaultGitTreeUidDeps: GitTreeUidDeps = {
  getuid: () => process.getuid?.(),
  statOwner: (dir: string) => {
    try {
      const st = fs.statSync(dir);
      return { uid: st.uid, gid: st.gid };
    } catch {
      return null;
    }
  },
};

/**
 * The uid/gid `git` should run as for a tree at {@link dir}, or `null` to run
 * as the current user.
 *
 * Deliberately cheap and uncached: one `statSync` per git invocation is
 * microseconds, and a cache would have to be invalidated by every chown in
 * `session-worker-uid.ts` — a correctness risk for no measurable gain. Revisit
 * only with a profile that names it.
 */
export function resolveGitTreeUid(
  dir: string | undefined,
  deps: GitTreeUidDeps = defaultGitTreeUidDeps,
): GitTreeUid | null {
  if (!dir) return null;
  // Only root can setuid. Everywhere else — session worker, local mode, tests —
  // this is the no-op branch, which is what keeps this change inert outside a
  // containerized production orchestrator.
  if (deps.getuid() !== 0) return null;
  const owner = deps.statOwner(dir);
  if (owner === null) return null;
  // A root-owned tree is ShipIt's own (bare cache, /opt/shipit). Dropping there
  // would break writes for no security gain: nothing untrusted can write it.
  if (owner.uid === 0) return null;
  return { uid: owner.uid, gid: owner.gid };
}

/**
 * Environment variable naming the separate gitconfig a dropped-uid git reads
 * instead of the orchestrator's own.
 *
 * It is NOT token-free — see `writeUnprivilegedGitConfig`. It has to carry a
 * credential helper, because a dropped-uid git that cannot authenticate cannot
 * push, and the post-turn auto-push is not optional. What it buys is that the
 * PAT stops being readable by *every* uid in the orchestrator container and
 * becomes readable by one; the end state docs/266 E3 wants is a repo-scoped,
 * short-lived token here instead.
 *
 * Set once at boot by `initGitConfig` (`orchestrator/git-config.ts`), which also
 * writes the file. An env var rather than an import because `shared/` may not
 * reach into `orchestrator/`, and it mirrors how the orchestrator already
 * publishes `GIT_CONFIG_GLOBAL` to its own git children.
 */
export const UNPRIVILEGED_GITCONFIG_ENV = "SHIPIT_UNPRIVILEGED_GITCONFIG";

/**
 * Path of that gitconfig, or `null` when the orchestrator has not
 * written one (local mode, tests, any process that is not the orchestrator).
 *
 * `null` means "do not override `GIT_CONFIG_GLOBAL`". That is the safe answer
 * for every non-dropping caller — and a dropping caller only ever reaches this
 * inside a production orchestrator, which has written the file at boot.
 */
export function unprivilegedGitConfigPath(): string | null {
  const raw = process.env[UNPRIVILEGED_GITCONFIG_ENV];
  return raw?.trim() ? raw : null;
}

/**
 * The same drop, for the raw `spawn`/`execFile`/`execFileSync` git call sites
 * that do not go through {@link safeSimpleGit}.
 *
 * Spread into the options object. Returns `{}` when no drop applies, so every
 * call site can spread unconditionally and read identically whether or not the
 * deployment has an unprivileged worker uid:
 *
 * ```ts
 * execFileSync("git", gitArgsWithHooksDisabled(args), {
 *   cwd, stdio: "pipe", ...gitSpawnOverridesForTree(cwd),
 * });
 * ```
 *
 * Unlike the hooks wrapper, this is NOT yet enforced by
 * `git-hooks-guard-coverage.test.ts`: a raw git spawn that forgets it runs as
 * root against the tree. The two raw sites that touch a session workspace
 * (`git-lfs-blob.ts`, `github-auth.ts`) are converted; a scanner rule to keep
 * that true belongs with docs/266 E2, where the fail-closed half lands.
 */
export function gitSpawnOverridesForTree(
  dir: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { uid?: number; gid?: number; env?: NodeJS.ProcessEnv } {
  const treeUid = resolveGitTreeUid(dir);
  if (treeUid === null) return {};
  const config = unprivilegedGitConfigPath();
  return {
    uid: treeUid.uid,
    gid: treeUid.gid,
    // Same reasoning as `safeSimpleGit`: point the dropped-uid git at its own
    // config rather than the orchestrator's. Unlike simple-git, a raw spawn has
    // no plugin standing in the way, so this is a plain env override.
    env: config === null ? baseEnv : { ...baseEnv, GIT_CONFIG_GLOBAL: config },
  };
}
