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
 *   - **Thread a uid through every call site.** `createGitManager` alone has
 *     ~189 callers, with raw `safeSimpleGit(workspaceDir)` sites beside them. A
 *     hand-converted list is stale the moment someone adds one more, and the
 *     failure is silent.
 *   - **Match the path against the sessions root.** Needs configuration this
 *     module cannot see, and it re-answers a question the filesystem already
 *     answers.
 *
 * Ownership is the same fact git's own CVE-2022-24765 check tests. That makes
 * the two self-consistent by construction: where we correctly drop, git is
 * satisfied; where we fail to drop, git *would* refuse with "detected dubious
 * ownership" rather than execute the payload (docs/266 req 7).
 *
 * **That fail-closed half is built but not armed.** `git-config.ts` still
 * writes `safe.directory=*` by default, which is precisely what suppresses that
 * refusal, so a call site that fails to drop silently runs as root exactly as
 * before. `SHIPIT_GIT_STRICT_OWNERSHIP=1` removes the `*` and turns that into a
 * loud `fatal: detected dubious ownership` (docs/266 E2, planning#403). It is a
 * switch rather than a deletion because arming it turns every missed site into
 * a hard failure at once, on the post-turn commit path, and this module is
 * inert unless the process is root — so it cannot be exercised for real
 * anywhere but a production orchestrator. Sequence: land the drop, observe it
 * in production, then arm this. Until it is armed the coverage here is real,
 * and enforced at CI (below), but not enforced by git at runtime.
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
 * Like the hooks wrapper, this IS enforced by
 * `git-hooks-guard-coverage.test.ts` (docs/266 E2): a raw git spawn that names a
 * working directory — as a `cwd` option or as a `-C <dir>` argument — and omits
 * this call fails the build. Spread it **inline at the call site**, not via a
 * local variable: the scanner reads the call, and a name it cannot follow reads
 * to it exactly like a site that forgot.
 *
 * Both the argv and the options object are followed through one level of
 * in-file `const NAME = …`, including an object literal's own spreads, because
 * a working directory can travel in a variable either way. Anything the scanner
 * cannot resolve is treated as carrying one — the fail-closed direction is to
 * demand the call, never to assume it is unnecessary.
 *
 * What it still does NOT see, stated because an overstated guarantee is worse
 * than a named gap:
 *
 *   - A working directory reached through the environment (`GIT_DIR`,
 *     `GIT_WORK_TREE`) or a `--git-dir` argument.
 *   - The **inherited process cwd**. A spawn with no `cwd` and no `-C` passes,
 *     and runs wherever the orchestrator started. `build-id.ts`'s
 *     `resolveBuildId` is a live instance; it is harmless because the
 *     orchestrator's cwd holds no repository in production, which is a property
 *     of the deployment rather than something this rule checks.
 *   - Indirection deeper than one level, or through anything other than an
 *     in-file `const`.
 *   - A spawn whose binary is not a quoted `git` literal — `const GIT = "git"`
 *     makes the call invisible to all three rules here.
 */
export function gitSpawnOverridesForTree(
  dir: string | undefined,
): { uid?: number; gid?: number } {
  const treeUid = resolveGitTreeUid(dir);
  if (treeUid === null) return {};
  return { uid: treeUid.uid, gid: treeUid.gid };
}
