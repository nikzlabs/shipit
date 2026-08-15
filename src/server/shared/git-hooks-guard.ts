/**
 * planning#384 — stop ORCHESTRATOR-SIDE git from executing hooks that live in a
 * repository ShipIt does not trust.
 *
 * ## The escalation this closes
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
 * ## Why `core.hooksPath`, and why that is COMPLETE for hooks
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
 * ## Two layers, deliberately
 *
 * 1. **`-c core.hooksPath=…` on the command line** ({@link safeSimpleGit},
 *    {@link gitArgsWithHooksDisabled}). Explicit, greppable, and immune to a
 *    caller that replaces the child environment — `RepoGit` does exactly that
 *    via `sanitizeGitEnv`.
 * 2. **`GIT_CONFIG_*` environment pairs on the orchestrator process**
 *    ({@link installGitHooksGuard}). A backstop that reaches raw `spawn("git",
 *    …)` / `execFileSync("git", …)` call sites and any future one, since every
 *    such site here inherits `process.env`.
 *
 * Both beat a repository-local `.git/config` (git reads `-c` and the
 * `GIT_CONFIG_KEY_n` pairs *after* every config file), which matters because
 * `.git/config` sits on the same writable mount as `.git/hooks` — an attacker
 * who could only be beaten by config-file precedence could simply set
 * `core.hooksPath` back.
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
  // simple-git refuses to pass `core.hooksPath` through unless this flag is on,
  // because the value is normally caller-supplied and a *writable* hooks
  // directory is arbitrary code execution. Ours is the frozen constant above and
  // points at a character device, so the flag's hazard doesn't apply — the
  // override can only ever take hooks away. Same posture as the other `unsafe.*`
  // opt-ins in `repo-git.ts` / `git-utils.ts`: enabled for one known value, not
  // for whatever a caller hands us.
  const unsafe = { ...options?.unsafe, allowUnsafeHooksPath: true };
  const merged = { ...options, config, unsafe };
  // simple-git rejects `baseDir: undefined` in the options-object form, so keep
  // the two-argument shape when we have a directory and the bare one when not.
  return baseDir === undefined ? simpleGit(merged) : simpleGit(baseDir, merged);
}

const COUNT_KEY = "GIT_CONFIG_COUNT";

/**
 * Merge the hooks-disabled override into a git environment as
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs, without
 * disturbing pairs that are already there.
 *
 * Returns a NEW object; the input is not mutated. Idempotent — calling it twice
 * on the same environment produces the same result rather than a second,
 * redundant pair.
 */
export function withGitHooksDisabledEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const parsed = Number.parseInt(out[COUNT_KEY] ?? "", 10);
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  for (let i = 0; i < count; i++) {
    if (out[`GIT_CONFIG_KEY_${i}`] === "core.hooksPath" && out[`GIT_CONFIG_VALUE_${i}`] === HOOKS_DISABLED_PATH) {
      return out; // already installed — don't grow the list on every call
    }
  }
  out[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
  out[`GIT_CONFIG_VALUE_${count}`] = HOOKS_DISABLED_PATH;
  out[COUNT_KEY] = String(count + 1);
  return out;
}

/**
 * Install the override on the orchestrator process itself, so every `git` it
 * spawns — through simple-git or through a bare `spawn`/`execFileSync` — starts
 * with hooks disabled.
 *
 * Called once at orchestrator start-up ({@link file://./../orchestrator/index.ts}).
 * The command-line `-c` layer is what actually guarantees coverage for the
 * paths that rebuild the child environment; this is the sweep for everything
 * else, including call sites nobody has written yet.
 *
 * Idempotent and cheap, so start-up ordering can't produce a double entry.
 */
export function installGitHooksGuard(env: NodeJS.ProcessEnv = process.env): void {
  const next = withGitHooksDisabledEnv(env);
  for (const [key, value] of Object.entries(next)) {
    if (env[key] !== value) env[key] = value;
  }
}

/**
 * Strip the `GIT_CONFIG_*` pairs this module installs from a child environment.
 *
 * Needed by anything that rebuilds a git environment and drops
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (`RepoGit.sanitizeGitEnv`): a
 * `GIT_CONFIG_COUNT` left pointing at keys that are no longer there is not a
 * silent no-op — git exits 128 with `missing config key GIT_CONFIG_KEY_0`. Such
 * callers keep hooks disabled through the `-c` layer instead.
 */
export function withoutGitConfigEnvPairs(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  Reflect.deleteProperty(out, COUNT_KEY);
  for (const key of Object.keys(out)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) Reflect.deleteProperty(out, key);
  }
  return out;
}
