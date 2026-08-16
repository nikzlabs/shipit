/**
 * planning#384 — stop ORCHESTRATOR-SIDE git from executing hooks that live in a
 * repository ShipIt does not trust.
 *
 * ## What this is, and what it is NOT
 *
 * It is ONE control against a writable `.git`, not the boundary. Hooks are
 * merely the cheapest of several executable registrations a writable `.git`
 * offers: `.git/config` — same mount, same writer — also carries
 * `filter.*.clean`/`smudge`, `core.fsmonitor`, `credential.helper`,
 * `core.sshCommand` and remote helpers, and `core.hooksPath` affects none of
 * them. Several cannot be disabled the way hooks can, because ShipIt depends on
 * them (git-lfs *is* a filter). A writable workspace also reaches ShipIt's own
 * execution outside git entirely — `shipit.yaml`'s `agent.install` commands and
 * `docker-compose.yml` are read from it and re-run by the watcher.
 *
 * So do not read a green `git-hooks-guard.test.ts` as "a plugin can no longer
 * run code in the orchestrator". The real question — whether `.git` and the
 * workspace's control files should be writable by plugin containers at all — is
 * a product decision about what plugins are for, and is open in planning#384.
 * This module raises the cost of one route and pins it with a test.
 *
 * ## The escalation this route allows
 *
 * A session's workspace is bind-mounted read-write into containers whose code is
 * untrusted by design — a plugin CLI run and a plugin service both get
 * `<workspaceDir>` at `/project` (docs/262 req 19), and
 * `chownWorkspaceGitToSessionWorker` makes `.git` writable to exactly the uid
 * those containers run as. So `/project/.git/hooks/pre-commit` is a file the
 * untrusted side can create.
 *
 * ShipIt's own post-turn auto-commit then runs `git commit` on that same tree
 * from **inside the orchestrator process**, which is root and mounts the
 * credential store, `/var/run/docker.sock`, and every session's workspace. One
 * ordinary turn in the consuming session turns "plugin wrote a file" into
 * "arbitrary code as root next to the Docker socket". `pre-commit` is only the
 * cheapest vector; git fires hooks on checkout, merge, rebase, push, `am`, and —
 * via `reference-transaction` — on essentially any ref update.
 *
 * ## Why `core.hooksPath` — complete for HOOKS, and only for hooks
 *
 * Git resolves every hook through ONE function (`find_hook()` in `hook.c`):
 * when `core.hooksPath` is set it looks under that directory, otherwise under
 * `$GIT_DIR/hooks`. There is no hook that bypasses it. So overriding
 * `core.hooksPath` to a path that can hold no executables disables **every**
 * hook git can invoke — including hook types added by future git versions —
 * without us having to enumerate them correctly. `/dev/null` is the
 * conventional value: `/dev/null/<hook-name>` can never resolve (ENOTDIR).
 *
 * This does NOT cover git's *other* repo-config-driven command execution
 * (`core.fsmonitor`, `core.pager`, `core.sshCommand`, `diff.external`,
 * `filter.*.clean/smudge`, `credential.helper`, aliases). Those are a separate
 * class with a separate fix — several of them are load-bearing for legitimate
 * behaviour here (git-lfs is a `filter`), so they cannot be blanket-disabled.
 *
 * ## One instrument, on the command line — and why not the environment
 *
 * The override travels as `-c core.hooksPath=…` on every git argv:
 * {@link safeSimpleGit} for simple-git callers, {@link gitArgsWithHooksDisabled}
 * for raw `spawn`/`execFile`/`execFileSync`. It beats a repository-local
 * `.git/config` (git reads `-c` *after* every config file), which matters
 * because `.git/config` sits on the same writable mount as `.git/hooks` — a fix
 * that could only win on config-file precedence would just be re-overridden.
 *
 * Git's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` environment protocol expresses the
 * same override with the same precedence, and installing it once on the
 * orchestrator process looks like a strictly better backstop: it would reach
 * every raw git spawn, including ones nobody has written yet. **It was tried and
 * rejected**, because it breaks simple-git for every command:
 * `blockUnsafeOperationsPlugin` inspects the *environment* as well as the argv,
 * so any instance that forwards `process.env` (e.g. `fetchAndResolveDefaultBranch`)
 * throws `GitPluginError: Use of "GIT_CONFIG_COUNT" is not permitted` before git
 * runs. The only way to keep it would be `unsafe.allowUnsafeConfigEnvCount:
 * true`, which switches off simple-git's protection against *inherited* config
 * injection wholesale — the same class of protection `RepoGit.sanitizeGitEnv`
 * and `server-test-setup.ts` exist to preserve. Trading a real guard against
 * arbitrary inherited config for a redundant second copy of this one is a bad
 * bargain. (Caught by `warm-sessions.test.ts`, which went red on it.)
 *
 * What the environment layer would have bought — coverage of a raw git spawn
 * someone adds later — is bought instead by `git-hooks-guard-coverage.test.ts`,
 * which fails the build when a `git` process is spawned without going through
 * {@link gitArgsWithHooksDisabled}. That fails loudly at CI rather than quietly
 * at runtime, which is the better trade anyway.
 *
 * ## Not applied inside the session container
 *
 * The agent's own git is left alone. A project's `pre-commit` formatter running
 * when the agent commits is legitimate behaviour a user expects, and the agent
 * is already inside the trust boundary — it can execute arbitrary code by
 * design, so a hook it fires is not an escalation. (Plugin code reaching the
 * *session worker's* uid is a smaller, separate question, and disabling hooks
 * there would break the legitimate case; see the PR body for planning#384.)
 */

import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import { resolveGitTreeUid } from "./git-tree-uid.js";

/**
 * A `core.hooksPath` value under which no hook can ever be found. `/dev/null` is
 * a character device, so resolving `/dev/null/<hook>` fails with ENOTDIR for
 * every name — there is nothing to create, chmod, or race.
 */
export const HOOKS_DISABLED_PATH = "/dev/null";

/** The single config override, in git's `key=value` form. */
export const HOOKS_DISABLED_CONFIG = `core.hooksPath=${HOOKS_DISABLED_PATH}`;

/** `["-c", "core.hooksPath=/dev/null"]` — prefix for a raw `git` argv. */
export const GIT_HOOKS_DISABLED_ARGS: readonly string[] = ["-c", HOOKS_DISABLED_CONFIG];

/**
 * Prefix a raw `git` argv so the invocation runs no repository hooks.
 *
 * For the `spawn("git", …)` / `execFile("git", …)` call sites that don't go
 * through simple-git. Safe in front of anything, including subcommand-with-args
 * forms like `lfs smudge` and `-C <dir> …`, because git parses its own options
 * before the subcommand.
 */
export function gitArgsWithHooksDisabled(args: readonly string[]): string[] {
  return [...GIT_HOOKS_DISABLED_ARGS, ...args];
}

/**
 * `simpleGit()` with hooks disabled on every command it issues.
 *
 * Use this instead of importing `simple-git` directly anywhere in the
 * orchestrator — `eslint.config.js` enforces that with `no-restricted-imports`.
 * simple-git's `config` option prefixes `-c <entry>` to each spawned command, so
 * a single instance covers `commit`, `merge`, `rebase`, `checkout`, `push`,
 * `am`, and everything else the instance is later asked to do.
 *
 * A caller's own `config` entries are kept and placed FIRST, so ours wins on a
 * conflict (git takes the last `-c` for a given key).
 */
export function safeSimpleGit(baseDir?: string, options?: Partial<SimpleGitOptions>): SimpleGit {
  const config = [...(options?.config ?? []), HOOKS_DISABLED_CONFIG];
  // docs/266 — drop to the uid that owns the tree, when there is one and we are
  // root. Applied HERE rather than at the ~200 call sites on purpose: this is
  // already the single choke point every orchestrator git goes through
  // (`eslint.config.js` forbids importing `simple-git` directly), so a call site
  // nobody has written yet is covered automatically, and there is no hand-kept
  // list to go stale. A caller's own `spawnOptions` wins — a deliberate choice
  // is never overridden.
  const treeUid = options?.spawnOptions ? null : resolveGitTreeUid(baseDir);
  const spawnOptions = options?.spawnOptions
    ?? (treeUid === null ? undefined : { uid: treeUid.uid, gid: treeUid.gid });


  // simple-git refuses `core.hooksPath` unless `allowUnsafeHooksPath` is on,
  // because the value is normally caller-supplied and a *writable* hooks
  // directory is arbitrary code execution. Ours is the frozen constant above and
  // points at a character device, so the flag's hazard doesn't apply — the
  // override can only ever take hooks away.
  const unsafe = { ...options?.unsafe, allowUnsafeHooksPath: true };

  const merged = { ...options, config, unsafe, spawnOptions };
  // simple-git rejects `baseDir: undefined` in the options-object form, so keep
  // the two-argument shape when we have a directory and the bare one when not.
  //
  // Note there is deliberately NO environment override here. An earlier version
  // pointed the dropped git at a second `GIT_CONFIG_GLOBAL` via `.env()`;
  // simple-git's `env(object)` ASSIGNS the executor environment, so any caller
  // chaining `.env()` afterwards (`git-utils.ts`, `repo-git.ts`) discarded it
  // while the uid drop stayed in force — dropped uid, root's config, no warning.
  // The global config is instead made readable by the worker uid directly
  // (`git-config.ts`), which nothing downstream can undo.
  return baseDir === undefined ? simpleGit(merged) : simpleGit(baseDir, merged);
}
