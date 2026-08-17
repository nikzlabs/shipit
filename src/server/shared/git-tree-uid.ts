/**
 * planning#384 / docs/266 — decide the uid an orchestrator-side `git` runs as.
 *
 * ## Why this exists
 *
 * A session's workspace is bind-mounted read-write into containers whose code
 * is untrusted by design (a plugin CLI run, a plugin service), and
 * `chownWorkspaceGitToSessionWorker` makes `.git` writable to the session's own
 * uid — the one those containers run as. (It resolves that through
 * `resolveGitDirOwner`, which follows the *tree's* owner wherever that and the
 * configured uid disagree; the hazard below is the same either way, since both
 * answers are the untrusted side.) An ordinary `npm install` reaches the same place —
 * a dependency's `postinstall` runs in the session worker as that same uid, so
 * this is NOT a plugin-specific hazard (docs/266-orchestrator-git-trust-boundary req 2).
 *
 * Git executes code named by repository-local configuration. Reproduced against
 * git 2.39.5 with PR #2301's `core.hooksPath=/dev/null` guard in force:
 * `filter.<name>.clean` runs during `git add`/`commit`, `core.fsmonitor` runs
 * during a plain `git status`, and a `!`-prefixed `alias.*` runs too. The set is
 * not enumerable — `filter.<name>` is arbitrarily named — and several members
 * are load-bearing (git-lfs *is* a filter), so it cannot be denied key by key
 * (docs/266-orchestrator-git-trust-boundary req 3).
 *
 * So the fix is not to disarm the payload. It is to stop running it as **root
 * in the orchestrator**, which holds `/credentials`, `/var/run/docker.sock` and
 * every session's workspace. Run git as the uid that owns the tree instead, and
 * the payload executes at exactly the authority its author already had — which
 * is no escalation at all (docs/266-orchestrator-git-trust-boundary req 11, decided 2026-08-16).
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
 * ownership" rather than execute the payload (docs/266-orchestrator-git-trust-boundary req 7).
 *
 * ## docs/270: WHICH tree's ownership
 *
 * Once uids differ per session, "the owner of the directory git runs in" stops
 * being a safe predicate, because that directory is bind-mounted read-write into
 * compose services and an Open session's service may run as root — so a session
 * can `chown` its own workspace and thereby *name* the uid ShipIt's git will
 * hold, and therefore the uid a `.git/config` payload executes at. The answer is
 * not to abandon ownership but to read it off the one directory in the chain no
 * session can write: `<sessionsRoot>/<sessionId>`, which is mounted into
 * nothing. `shared/session-identity.ts` owns that lookup; the fallback below is
 * for paths that belong to no session.
 *
 * **That fail-closed half is built but not armed.** `git-config.ts` still
 * writes `safe.directory=*` by default, which is precisely what suppresses that
 * refusal, so a call site that fails to drop silently runs as root exactly as
 * before. `SHIPIT_GIT_STRICT_OWNERSHIP=1` removes the `*` and turns that into a
 * loud `fatal: detected dubious ownership` (docs/266-orchestrator-git-trust-boundary E2, planning#403). It is a
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
import { identityForPath, sessionIdForPath } from "./session-identity.js";

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
  // docs/270 req 2 — when the path belongs to a session, the identity comes from
  // that session's DIRECTORY, which is mounted into nothing and so cannot be
  // re-owned from inside the session. Stat'ing the tree instead would let an
  // Open session's root compose service `chown` its own workspace and thereby
  // choose the uid ShipIt's git — and any `.git/config` payload it executes —
  // runs as. Falls through to the tree only for paths that belong to no session
  // (the shared bare cache, `/opt/shipit`) and when the roots are unconfigured,
  // which is local mode and every test.
  //
  // Note the `sessionIdForPath` gate rather than a null check on the identity:
  // for a path inside a session the session's record is the ONLY answer, and
  // "no record" resolves to the deployment's configured value or to no drop at
  // all. Falling through to the tree there would hand the decision straight back
  // to the party the gate exists to keep out of it.
  if (sessionIdForPath(dir) !== null) return identityForPath(dir);
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
 * `git-hooks-guard-coverage.test.ts` (docs/266-orchestrator-git-trust-boundary E2): a raw git spawn that names a
 * working directory and omits this call fails the build. Five things count as
 * naming one — a `cwd` option, a `-C <dir>` argument, `--git-dir`/`--work-tree`,
 * `GIT_DIR`/`GIT_WORK_TREE` in the spawn's `env`, and a `clone`/`init`/`worktree`
 * subcommand, which names the tree it CREATES as an ordinary argument rather
 * than as a working directory (planning#410 found the simple-git form of that
 * one cloning as root into a session's state directory). Spread it **inline at
 * the call site**, not via a local variable: the scanner reads the call, and a
 * name it cannot follow reads to it exactly like a site that forgot.
 *
 * Both the argv and the options object are followed through one level of
 * in-file `const NAME = …`, including an object literal's own spreads, because
 * a working directory can travel in a variable either way. Anything the scanner
 * cannot resolve is treated as carrying one — the fail-closed direction is to
 * demand the call, never to assume it is unnecessary.
 *
 * Which git processes it finds is itself part of the guarantee, so the scanner
 * reads the launcher names a file imported from `node:child_process` (aliases
 * and `promisify` wrappers included) rather than a fixed list, and resolves the
 * binary through one level of in-file `const` and through a leading path.
 * `spawnSync("git", …)`, `execSync("git …")` and `const GIT = "git"` were all
 * silent exemptions before planning#409; the first two are covered, and a binary
 * the scanner cannot read now FAILS rather than passing.
 *
 * What it still does NOT see, stated because an overstated guarantee is worse
 * than a named gap:
 *
 *   - The **inherited process cwd**. A spawn with no `cwd`, no `-C` and no
 *     `--git-dir` passes, and runs wherever the orchestrator started.
 *     `build-id.ts`'s `resolveBuildId` is a live instance; it is harmless
 *     because the orchestrator's cwd holds no repository in production, which is
 *     a property of the deployment rather than something this rule checks.
 *   - Indirection deeper than one level, or through anything other than an
 *     in-file `const`. A name declared twice is unreadable rather than resolved
 *     to the first declaration, so shadowing fails closed.
 *   - `exec`/`execSync` reached as a method on a receiver that is not a
 *     `node:child_process` namespace binding, because `.exec(` is
 *     `RegExp.prototype.exec` several hundred times over in this tree. `cp.exec(`
 *     on a namespace import IS read; `db.exec(` is not.
 *   - A launcher that is not `node:child_process` at all — an `execa` or
 *     `cross-spawn` dependency would bypass every rule here. Neither is in
 *     `package.json`; adding one means extending this scanner in the same PR.
 *   - `GIT_DIR` inherited through `env: { ...process.env }` rather than written
 *     literally. The spread makes the options object unreadable, so the uid rule
 *     still demands the drop — but the hazard itself is the deployment's
 *     environment, which no source scan can see.
 *   - The `git-lfs` binary invoked directly. This repo reaches LFS as
 *     `git lfs …`, which IS covered; a bare `git-lfs` spawn is excluded because
 *     the fix these rules demand (`-c core.hooksPath=…`) is a git argument it
 *     does not accept, so demanding it would be a remedy that fails.
 */
export function gitSpawnOverridesForTree(
  dir: string | undefined,
): { uid?: number; gid?: number } {
  const treeUid = resolveGitTreeUid(dir);
  if (treeUid === null) return {};
  return { uid: treeUid.uid, gid: treeUid.gid };
}
