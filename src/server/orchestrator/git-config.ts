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
import { UNPRIVILEGED_GITCONFIG_ENV } from "../shared/git-tree-uid.js";

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
 * Set GIT_CONFIG_GLOBAL to a file in the credentials directory so all git
 * operations (in any repo) inherit identity and settings from a single place.
 *
 * Also disables commit signing and migrates identity from the legacy
 * credential store JSON if present.
 */
export function initGlobalGitConfig(credentialsDir: string): void {
  // docs/266 — 0700, not the default 0755. This directory holds the
  // orchestrator's `.gitconfig`, into which `setGlobalCredentialHelper` writes
  // the raw PAT inline. It was world-readable inside the orchestrator container
  // for as long as it has existed; harmless while nothing non-root ran there,
  // and load-bearing the moment orchestrator git drops uid. Tightening it is
  // worth doing on its own merits, so it is not gated on the drop.
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  tightenMode(credentialsDir, 0o700);
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

  // docs/150 §7 addendum (planning#33 activation blocker). When the session worker
  // runs as an unprivileged uid (SHIPIT_SESSION_WORKER_UID set), each session's
  // workspace under /workspace is owned by that uid (e.g. 1000), but THIS
  // orchestrator process keeps running git as root. Git's CVE-2022-24765
  // ownership check then refuses every orchestrator-side git op on those trees
  // with "detected dubious ownership" — breaking auto-commit, auto-push, branch
  // graduation, the bare-cache fetch, and the `gh pr` branch lookup (all of
  // which run git via GIT_CONFIG_GLOBAL).
  //
  // `safe.directory` is honored ONLY from system/global config — never from a
  // repo-local config or a `-c safe.directory=` command-line override (git's
  // own anti-spoofing rule). So it must live here, in GIT_CONFIG_GLOBAL. This
  // file is written by the root orchestrator into its own credentials dir, so
  // it is root-owned and git-as-root trusts it. A single `*` entry covers the
  // bare cache, every per-session worktree, and any future path without an
  // enumerate-on-create dance. Gated: with the flag unset (today's default,
  // root worker) nothing is written and behavior is byte-for-byte unchanged.
  // `--replace-all` keeps it idempotent across repeated init calls (tests).
  if (sessionWorkerUid() !== null) {
    try {
      execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "--replace-all", "safe.directory", "*"]));
    } catch {
      // git may not be installed yet (unlikely but safe)
    }
  }

  // docs/266 — the config a DROPPED-UID git reads instead of the one above.
  //
  // A git running as the session's uid cannot read the orchestrator's own
  // global config once that file is 0600 root-owned, and it still needs
  // identity (`git commit` hard-fails without one) and `commit.gpgsign=false`
  // (no signing key). So: a second file, 0600 and owned by the worker uid,
  // published to `shared/` through an env var because `shared/` may not import
  // from `orchestrator/`.
  //
  // Deliberately WITHOUT `safe.directory`: this config is read only by a git
  // that is already running as the tree's owner, so the ownership check passes
  // on its own. Adding the `*` here would hand the dropped git the same blanket
  // trust the root path has, for no reason.
  writeUnprivilegedGitConfig(credentialsDir);

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
  if (!process.env.GIT_EDITOR) {
    process.env.GIT_EDITOR = "true";
  }
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
/** Filename of the token-free config a dropped-uid orchestrator git reads. */
export const UNPRIVILEGED_GITCONFIG_FILE = ".gitconfig-unprivileged";

/**
 * Write the token-free gitconfig for orchestrator git that has dropped to a
 * session's uid (docs/266 E3), and publish its path via
 * {@link UNPRIVILEGED_GITCONFIG_ENV}.
 *
 * Carries exactly what a commit needs and nothing that authenticates:
 * identity, `commit.gpgsign=false`, and the docs/200 `insteadOf` rewrites. No
 * `credential.helper` — see the caveat below — and no `safe.directory`, because
 * a git already running as the tree's owner passes the ownership check on its
 * own.
 *
 * It DOES carry a `credential.helper`, and that is the one deliberate
 * compromise in docs/266's implementation — see
 * {@link setGlobalCredentialHelper}. A dropped-uid git that cannot authenticate
 * cannot `push`, and the post-turn auto-push is not optional, so the token has
 * to be reachable by that uid. The residual is stated plainly in the PR and
 * tracked: docs/266 E3 wants a repo-scoped, short-lived token here instead of
 * the PAT — no broader than what the session container can already obtain from
 * its own broker — which is per-session and per-repo and so cannot live in this
 * boot-time, repo-less writer. Until that lands, a payload executing during an
 * orchestrator git op can read the PAT out of this file. That is strictly
 * better than today, where it executes as root and can read everything, and it
 * is NOT the finished boundary.
 */
export function writeUnprivilegedGitConfig(credentialsDir: string): void {
  const destPath = path.join(credentialsDir, UNPRIVILEGED_GITCONFIG_FILE);
  try {
    fs.writeFileSync(destPath, "", { mode: 0o600 });
    const set = (key: string, value: string): void => {
      execFileSync("git", gitArgsWithHooksDisabled(["config", "--file", destPath, key, value]));
    };
    const id = getGitIdentity() ?? FALLBACK_CONTAINER_GIT_IDENTITY;
    set("user.name", id.name);
    set("user.email", id.email);
    set("commit.gpgsign", "false");
    set("url.https://github.com/.insteadOf", "git@github.com:");
    // Owned by the worker uid, because that uid is the only reader. Mode stays
    // 0600 so no OTHER uid on the box can read it — which matters precisely
    // because `setGlobalCredentialHelper` puts the token in here too.
    chownToSessionWorker(destPath);
    process.env[UNPRIVILEGED_GITCONFIG_ENV] = destPath;
    // A token already installed (this runs at boot, but `initGitConfig` can be
    // re-entered) must reach the new file, or the first dropped-uid push after a
    // restart fails to authenticate.
    const existing = getGlobalCredentialHelperValue();
    if (existing !== null) set("credential.helper", existing);
  } catch (err) {
    // A dropped-uid git with no config falls back to git's defaults: no
    // identity, so `commit` fails loudly rather than silently misattributing.
    // Leave the env var unset so `safeSimpleGit` does not point at a file that
    // is not there.
    process.env[UNPRIVILEGED_GITCONFIG_ENV] = "";
    console.error(
      "[git-config] failed to write the unprivileged gitconfig:",
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
  // `!f() { echo "password=TOKEN"; echo "username=x-access-token"; }; f` —
  // git invokes the value as a shell command when the leading char is `!`.
  const helper = `!f() { echo "password=${token}"; echo "username=x-access-token"; }; f`;
  execFileSync("git", gitArgsWithHooksDisabled(["config", "--global", "credential.helper", helper]));
  // docs/266 — mirror it into the unprivileged config, because orchestrator git
  // on a session workspace now runs as that workspace's uid and would otherwise
  // be unable to authenticate a `push`. This is the deliberate compromise
  // recorded on {@link writeUnprivilegedGitConfig}: the token becomes readable
  // by the session's uid inside the orchestrator container. Strictly better than
  // the status quo it replaces — where the same payload ran as root and could
  // read the whole credential store, the Docker socket and every workspace —
  // and strictly weaker than docs/266 E3's end state, which wants a repo-scoped
  // short-lived token here instead.
  writeUnprivilegedCredentialHelper(helper);
}

/**
 * The current global `credential.helper` value, or `null` when none is set.
 *
 * Used to seed a freshly-written unprivileged config at boot: the token is
 * installed once, on login, and a later restart must not leave the dropped-uid
 * git unable to push until the next token change.
 */
function getGlobalCredentialHelperValue(): string | null {
  try {
    const out = execFileSync(
      "git",
      gitArgsWithHooksDisabled(["config", "--global", "--get", "credential.helper"]),
      { encoding: "utf-8" },
    );
    const value = out.trim();
    return value ? value : null;
  } catch {
    // `--get` exits non-zero when the key is unset — not an error here.
    return null;
  }
}

/** Write (or clear) the credential helper in the unprivileged config. */
function writeUnprivilegedCredentialHelper(helper: string | null): void {
  const destPath = process.env[UNPRIVILEGED_GITCONFIG_ENV];
  if (!destPath) return;
  try {
    execFileSync("git", gitArgsWithHooksDisabled(
      helper === null
        ? ["config", "--file", destPath, "--unset", "credential.helper"]
        : ["config", "--file", destPath, "--replace-all", "credential.helper", helper],
    ));
  } catch {
    // `--unset` exits non-zero when the key was already absent; a write failure
    // costs authentication on the dropped path and is reported by git itself.
  }
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
  // docs/266 — the mirror must clear with it, or a revoked token keeps being
  // echoed to every dropped-uid git op. Same reasoning as the global one.
  writeUnprivilegedCredentialHelper(null);
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
