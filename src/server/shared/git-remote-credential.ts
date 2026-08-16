/**
 * The credential ONE orchestrator-side git invocation authenticates a remote
 * with, expressed so that nothing downstream can undo it.
 *
 * ## Why this lives in `shared/`
 *
 * It started in `orchestrator/repo-git.ts` (docs/262 req 10), where a plugin
 * repository needed its own installation token instead of the global helper's
 * host PAT. docs/266 E3 (planning#404) needs the identical shape for a
 * *different* reason — the dropped-uid git on a session workspace — and that
 * caller is `shared/git.ts`'s {@link GitManager}, which `repo-git.ts` already
 * imports from. Leaving the helpers there would be a cycle, and copying them
 * would give the two paths independently-drifting definitions of "the only
 * credential this git may use". So the mechanism moved down; `repo-git.ts`
 * re-exports it and its behaviour is unchanged.
 *
 * ## What docs/266 E3 needs it for
 *
 * E1 made orchestrator git on a session workspace run as that workspace's uid.
 * That git still has to `push`, so it needs a credential it can read — and
 * until E3 that was the PAT, mirrored into a global gitconfig owned by the
 * worker uid. A payload executing during a git op could read it, which is
 * broader than what the session container can obtain from its own broker, and
 * requirement 11's "equal authority is not an escalation" argument does not
 * cover it.
 *
 * The fix has two halves, and this file is the second:
 *
 *   1. `git-config.ts` moves the PAT out of the worker-readable gitconfig into
 *      a root-only file the global helper `cat`s. The dropped git can still
 *      read the config (identity, `url.insteadOf`) and can no longer read the
 *      secret — its inherited helper simply answers nothing.
 *   2. The remote op supplies its own credential here: a short-lived,
 *      single-repo installation token when a GitHub App is configured, and the
 *      PAT when it is not (`getRepoScopedGitCredential`, docs/172 Gap 2-R).
 *      That is exactly the credential the container's own broker would hand
 *      the agent, so stealing it gains nothing the session did not have.
 *
 * ## Why the argv, and why the environment, and why not a file
 *
 * Three mechanisms were available and only this combination survives contact
 * with the rest of the codebase:
 *
 *   - **A second `GIT_CONFIG_GLOBAL` through the child environment** — tried
 *     during E1 and reverted. simple-git's `env(object)` *assigns* the executor
 *     environment, so any caller chaining `.env()` afterwards (`git-utils.ts`,
 *     `repo-git.ts` both do) silently discards the override while the uid drop
 *     stays in force. A control a caller can undo by accident is not a control.
 *   - **The token in the config value** (`-c credential.helper=!echo …TOKEN`) —
 *     durable, but it puts the secret in the process argv, which
 *     `/proc/<pid>/cmdline` hands to every uid in the container.
 *   - **The token in a file** — durable, but it puts the secret at rest, which
 *     is the thing E3 exists to stop doing.
 *
 * So: the *shape* travels on the argv (`-c`, which no `.env()` can remove), the
 * *secret* travels in the environment of a simple-git instance that is created
 * and consumed inside a single function and never handed to a caller who could
 * chain `.env()` onto it. Both halves are required; either alone is the failure
 * mode above.
 */

import type { SimpleGit, SimpleGitOptions } from "simple-git";
import { safeSimpleGit } from "./git-hooks-guard.js";
import { type GitTreeUidDeps, resolveGitTreeUid } from "./git-tree-uid.js";

/**
 * A username/password pair for one remote, supplied per git invocation instead
 * of taken from the orchestrator's global git config.
 *
 * Why this exists: the global credential helper echoes ONE credential — the
 * host PAT — for every repository the orchestrator touches. That is wrong for
 * a plugin repository, which is a *different* repository and, under GitHub App
 * mode, needs its own installation token (docs/262 req 10, `plugin-fetch.ts`);
 * and it is wrong for a dropped-uid git, which must not be able to reach the
 * PAT at all (docs/266 E3).
 */
export interface GitRemoteCredential {
  /**
   * The origin it is for — `https://github.com`, scheme included. The
   * credential is offered to no other origin.
   */
  origin: string;
  /**
   * What to supply. **Omitted means supply nothing** — the inherited helpers
   * are still reset and prompts are still disabled, so an anonymous fetch is
   * genuinely anonymous rather than quietly answered by a stale global helper,
   * and a private repository fails fast with a classifiable message instead of
   * stalling on a prompt (review finding).
   */
  token?: { username: string; password: string };
}

const CREDENTIAL_ENV_USERNAME = "SHIPIT_GIT_CRED_USERNAME";
const CREDENTIAL_ENV_PASSWORD = "SHIPIT_GIT_CRED_PASSWORD";

/** A scheme + host (optionally `:port`) and nothing that could reshape a config key. */
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/;

/**
 * Environment variables simple-git refuses to spawn with unless the matching
 * `unsafe` flag is set — all of them ways to make git run someone else's code.
 * We drop them instead of allowing them: a bare-cache clone or fetch pages
 * nothing, diffs nothing, opens no ssh session, and must never reach an askpass
 * program, since replacing exactly that is the point of the helper below.
 *
 * Dropped rather than enumerated as `unsafe` flags because ONE of these present
 * in the orchestrator's environment fails every credentialed fetch before git
 * runs — `PAGER=cat` is enough, and it is a variable no deployment thinks of as
 * git configuration (review finding, P1).
 *
 * The two NOT dropped are deliberate: `GIT_CONFIG_GLOBAL` carries the identity
 * and `safe.directory` this orchestrator sets on purpose, and `GIT_EDITOR` is
 * set on purpose so git never opens an interactive editor. Their flags stay on.
 */
const UNSAFE_GIT_ENV = [
  "PAGER", "GIT_PAGER",
  "GIT_ASKPASS", "SSH_ASKPASS",
  "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEMPLATE_DIR",
  "GIT_SEQUENCE_EDITOR",
  // Highest-precedence config injection, above GIT_CONFIG_GLOBAL — it could
  // reinstate a credential helper we just reset. Same reasoning
  // `server-test-setup.ts` clears these for.
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
];

/**
 * The environment a credentialed git child gets: ours, minus the variables
 * above, minus any `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs the
 * dropped `GIT_CONFIG_COUNT` addressed.
 *
 * planning#384 — this drop is one of two reasons the hooks guard lives on the
 * command line rather than in the environment: whatever `GIT_CONFIG_*` pairs the
 * orchestrator sets, this path deletes them. Hooks stay disabled here through
 * the `-c core.hooksPath=…` that `safeSimpleGit` puts on every argv, which no
 * environment rebuild can remove. (The other reason is that simple-git refuses
 * to spawn at all when it sees `GIT_CONFIG_COUNT` in the environment — see
 * `shared/git-hooks-guard.ts`.)
 */
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of UNSAFE_GIT_ENV) Reflect.deleteProperty(out, key);
  for (const key of Object.keys(out)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) Reflect.deleteProperty(out, key);
  }
  return out;
}

/**
 * The `-c` arguments that make ONE supplied credential the only one git uses,
 * and only for `origin`.
 *
 * All three properties are load-bearing:
 *
 *  - The empty `credential.helper=` **resets** the inherited helper list.
 *    `credential.helper` is multi-valued and git consults helpers in config
 *    order — system, global, local, then `-c` — so without the reset the global
 *    helper answers first with the host PAT and the credential passed here is
 *    never reached. On an App-only install that silently means "no credential".
 *    On the docs/266 dropped-uid path it also removes the workspace-local
 *    `credential.helper` — which points at the *container's* brokering binary
 *    (`/usr/local/bin/shipit-git-credential`, absent on the orchestrator) — so
 *    git stops shelling out to a path that cannot exist here.
 *  - The replacement is **URL-scoped** (`credential.<origin>.helper`), so it is
 *    host-aware. An unscoped `!f() { echo … }` helper echoes its token for
 *    whatever host git hands it, which is the exact bug docs/172 Gap 2 fixed in
 *    the container gitconfig: a redirect to another host would be handed the
 *    token. Here nothing outside `origin` gets an answer at all.
 *  - The token travels in the **environment**, not in the config value, so it
 *    never lands in the process's argv (readable through `ps`) and never
 *    reaches the cache's on-disk config the way an `https://user:token@host`
 *    remote would. git passes its own environment to the helper it shells out
 *    to.
 */
export function gitCredentialConfig(credential: GitRemoteCredential): string[] {
  const { origin } = credential;
  if (!SAFE_ORIGIN.test(origin)) throw new Error(`Refusing to build a git credential helper for origin "${origin}"`);
  // The reset alone IS the anonymous case: helpers cleared, nothing offered.
  if (!credential.token) return ["credential.helper="];
  const helper = `!f() { echo "username=$${CREDENTIAL_ENV_USERNAME}"; echo "password=$${CREDENTIAL_ENV_PASSWORD}"; }; f`;
  return ["credential.helper=", `credential.${origin}.helper=${helper}`];
}

/**
 * {@link gitCredentialConfig} + {@link gitCredentialEnv} shaped for a raw
 * `spawn("git", …)` — the sites that cannot use a simple-git instance.
 *
 * `args` goes in front of the subcommand (git parses its own options first, so
 * it is safe ahead of `lfs smudge` or `-C <dir> …`); `env` is merged into the
 * child's environment. Both are empty when there is no credential, so a call
 * site can spread them unconditionally and read the same either way.
 */
export function gitCredentialSpawnOverrides(
  credential: GitRemoteCredential | null,
): { args: string[]; env: Record<string, string> } {
  if (!credential) return { args: [], env: {} };
  return {
    args: gitCredentialConfig(credential).flatMap((entry) => ["-c", entry]),
    env: gitCredentialEnv(credential),
  };
}

/** The environment that helper reads the credential out of. */
export function gitCredentialEnv(credential: GitRemoteCredential): Record<string, string> {
  if (!credential.token) return {};
  return {
    [CREDENTIAL_ENV_USERNAME]: credential.token.username,
    [CREDENTIAL_ENV_PASSWORD]: credential.token.password,
  };
}

/**
 * The `url.<base>.insteadOf` rewrites `initGlobalGitConfig` installs, as
 * `[from, to]` pairs. Kept in sync by hand with `git-config.ts` — see
 * {@link parseRemoteOrigin} for why reading the raw URL without them is a bug.
 */
const GITHUB_SSH_REWRITES: readonly (readonly [string, string])[] = [
  ["git@github.com:", "https://github.com/"],
  ["ssh://git@github.com/", "https://github.com/"],
];

function applyGithubSshRewrite(url: string): string {
  for (const [from, to] of GITHUB_SSH_REWRITES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

/** What {@link parseRemoteOrigin} could work out about a remote's URL. */
export interface RemoteOrigin {
  /** Scheme + host, the form {@link gitCredentialConfig} scopes a helper to. */
  origin: string;
  /** Bare host, for the credential resolver's own host check. */
  host: string;
  /** `owner`/`repo` when the URL names them — what a repo-scoped mint needs. */
  owner?: string;
  repo?: string;
}

/**
 * Split an `https://` remote URL into the pieces a credential resolver needs,
 * or `null` when there is nothing to authenticate.
 *
 * `null` for every non-HTTP(S) remote on purpose, and that covers more of the
 * real call sites than it looks: a session fork's `origin` is a local path
 * until it is re-pointed, `session-fork-merge` adds another session's
 * *directory* as a remote, and tests use `file://`-less local paths throughout.
 * None of those authenticate, and offering a credential to them would be the
 * host-confusion bug docs/172 Gap 2 fixed.
 *
 * **A GitHub SSH remote is the one exception, and it is not optional.** The
 * orchestrator installs a global `url.https://github.com/.insteadOf` for
 * exactly `git@github.com:` and `ssh://git@github.com/` (docs/200,
 * `git-config.ts`), so a git op on such a remote does not speak SSH at all — it
 * connects over HTTPS and asks for an HTTPS credential. The configured URL git
 * reports through `getRemotes` is the **pre-rewrite** spelling, so reading it
 * literally would decline a credential for an operation that then goes on to
 * need one, and the push would fail with "could not read Username" where it
 * used to succeed. `setGitRemote` accepts SSH spellings and a fork inherits
 * them, so this is a reachable state and not a curiosity. Any OTHER ssh remote
 * stays `null`: the image ships no key, so ShipIt holds nothing for it.
 * {@link GITHUB_SSH_REWRITES} mirrors the rewrite `git-config.ts` writes — the
 * two are a pair and must move together.
 *
 * The `owner`/`repo` split is deliberately generic rather than GitHub-specific
 * — the resolver decides whether it recognises the host. Only the first two
 * path segments are read, and a `.git` suffix is stripped.
 */
export function parseRemoteOrigin(url: string | undefined): RemoteOrigin | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(applyGithubSshRewrite(url.trim()));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!SAFE_ORIGIN.test(origin)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return { origin, host: parsed.hostname };
  return {
    origin,
    host: parsed.hostname,
    owner: segments[0],
    repo: segments[1].replace(/\.git$/, ""),
  };
}

/**
 * Resolve the credential for one remote, or `null` for "offer nothing".
 *
 * Injected rather than imported: minting lives in the orchestrator
 * (`GitHubAuthManager`), and `shared/` must stay loadable inside the session
 * worker, which has neither.
 */
export type GitRemoteCredentialResolver = (
  remote: RemoteOrigin,
) => Promise<{ username: string; password: string } | null>;

/**
 * The credential a git op on `dir` should carry for `remote`, or `null` for
 * "change nothing".
 *
 * `null` is the answer on every path that is not docs/266's dropped-uid git,
 * and that is the point: a root-side orchestrator git still reads the global
 * helper, which still reads the root-only PAT file, so handing it a second
 * credential would be churn with a blast radius. The predicate is
 * {@link resolveGitTreeUid} — the SAME fact `safeSimpleGit` drops on — so the
 * two can never disagree about which invocations need their own credential.
 * Read here rather than remembered from whenever the caller's instance was
 * built, which is the safe side of the one case where the two can differ: a
 * workspace chowned to the worker uid *after* a `GitManager` was made for it
 * gets a credential, where a cached "no drop" would leave the op unable to
 * authenticate.
 *
 * Never throws. Every failure below resolves to `null`, which means the caller
 * runs the git it would have run anyway: docs/266 req 6 and `CLAUDE.md`
 * invariant 2 both say the post-turn path may not gain a way to fail, and a
 * credential that cannot be minted must therefore degrade to E1's behaviour
 * rather than abort the operation.
 */
export async function resolveTreeRemoteCredential(
  dir: string,
  remote: string,
  resolve: GitRemoteCredentialResolver | undefined,
  readRemoteUrl?: () => Promise<string | undefined>,
  /**
   * Injection seam, same one {@link resolveGitTreeUid} documents and for the
   * same reason: the interesting state — running as root against a tree owned
   * by someone else — cannot be produced in a session container, which has no
   * root and where `unshare -r` is refused.
   */
  treeUidDeps?: GitTreeUidDeps,
): Promise<GitRemoteCredential | null> {
  if (!resolve) return null;
  if (resolveGitTreeUid(dir, treeUidDeps) === null) return null;

  let url: string | undefined;
  try {
    url = readRemoteUrl ? await readRemoteUrl() : await defaultReadRemoteUrl(dir, remote);
  } catch {
    return null;
  }
  const origin = parseRemoteOrigin(url);
  if (!origin) return null;

  try {
    const token = await resolve(origin);
    return token ? { origin: origin.origin, token } : null;
  } catch (err) {
    console.warn(
      `[git] resolving a remote credential for ${origin.origin} failed; `
      + "falling back to the inherited helpers:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function defaultReadRemoteUrl(dir: string, remote: string): Promise<string | undefined> {
  const remotes = await safeSimpleGit(dir).getRemotes(true);
  const match = remotes.find((r) => r.name === remote);
  return match?.refs.push || match?.refs.fetch || undefined;
}

/**
 * A git instance that authenticates `credential.origin` with `credential` and
 * nothing else.
 *
 * **Create it, use it, drop it.** The returned instance must never be handed to
 * a caller who might chain `.env()` onto it: simple-git's `env(object)`
 * *assigns* the executor environment, so one such call silently deletes the
 * token while the `-c` reset that disabled every inherited helper stays in
 * force — a git with no credential at all and no warning. That asymmetry is why
 * the shape rides the argv and the secret rides the environment; see this
 * file's header.
 */
export function credentialledGit(
  dir: string,
  credential: GitRemoteCredential,
  options?: Partial<SimpleGitOptions>,
  extraEnv?: Record<string, string>,
): SimpleGit {
  return safeSimpleGit(dir, {
    ...options,
    config: [...(options?.config ?? []), ...gitCredentialConfig(credential)],
    // The same three false positives `repo-git.ts` documents: our own
    // credential helper, and the `GIT_CONFIG_GLOBAL` / `GIT_EDITOR` this
    // orchestrator sets on purpose. Everything else simple-git guards against
    // is dropped from the environment by `sanitizeGitEnv` instead.
    unsafe: {
      ...options?.unsafe,
      allowUnsafeConfigPaths: true,
      allowUnsafeEditor: true,
      allowUnsafeCredentialHelper: true,
    },
  }).env({
    ...sanitizeGitEnv(process.env),
    ...gitCredentialEnv(credential),
    // The inherited helpers are reset, so a credential that fails must fail
    // fast rather than block on a prompt nothing will ever answer.
    GIT_TERMINAL_PROMPT: "0",
    ...extraEnv,
  });
}
