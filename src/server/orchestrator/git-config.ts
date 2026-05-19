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
  fs.mkdirSync(credentialsDir, { recursive: true });
  const configPath = path.join(credentialsDir, ".gitconfig");
  process.env.GIT_CONFIG_GLOBAL = configPath;

  // Migrate from legacy shipit-credentials.json if global config has no identity
  migrateLegacyIdentity(credentialsDir);

  // Ensure commit signing is always disabled
  try {
    execFileSync("git", ["config", "--global", "commit.gpgsign", "false"]);
  } catch {
    // git may not be installed yet (unlikely but safe)
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
 * Read git identity from the global config.
 * Returns null if user.name or user.email is not set.
 */
export function getGitIdentity(): GitIdentity | null {
  try {
    const name = execFileSync("git", ["config", "--global", "user.name"], {
      encoding: "utf-8",
    }).trim();
    const email = execFileSync("git", ["config", "--global", "user.email"], {
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
  execFileSync("git", ["config", "--global", "user.name", name]);
  execFileSync("git", ["config", "--global", "user.email", email]);
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
  execFileSync("git", ["config", "--global", "credential.helper", helper]);
}

/**
 * Remove the global credential helper. Called on logout / token-invalidation
 * so a freshly-rotated PAT (or a "signed out" state) is not silently masked
 * by a stale helper still echoing the old token.
 */
export function clearGlobalCredentialHelper(): void {
  try {
    execFileSync("git", ["config", "--global", "--unset", "credential.helper"]);
  } catch {
    // Already unset — `git config --unset` exits non-zero in that case.
  }
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
