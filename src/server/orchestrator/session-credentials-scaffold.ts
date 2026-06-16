/**
 * Per-agent credential isolation — per-session scaffold (docs/138).
 *
 * The orchestrator keeps a single source-of-truth credentials directory
 * (`credentialsDir`, e.g. `/credentials`) holding *both* agents' creds side by
 * side: `.claude/` + `.claude.json` (Claude), `.codex/` (Codex), plus the
 * shared, non-agent-sensitive `.gitconfig`. Historically that whole directory
 * was mounted into *every* session container, so a Claude session could read
 * Codex's credentials and vice versa.
 *
 * This module gives each session its own subtree under
 * `<credentialsDir>/sessions/<sessionId>` and mounts *that* at `/credentials`
 * instead (a Subpath mount of the credentials volume in production, or a bind
 * mount in dev — mirrors how the workspace volume is sub-pathed per session).
 * The per-session dir starts empty except for the shared `.gitconfig`; the
 * pinned agent's subtree is copied in only once, on the session's first turn
 * (see `provisionAgentCredentials` in {@link ./session-agent-credentials.js}).
 * Net guarantee: a Claude session's container never has `.codex` on disk, and a
 * Codex session's never has `.claude`.
 *
 * The functions here are deliberately pure (filesystem in/out, no Docker, no DB)
 * so they are unit-testable and can be called from both the container-lifecycle
 * mount builder and the first-turn provisioning hook. This file holds the
 * per-session dir scaffold + shared-config copying; agent-credential
 * provisioning lives in `session-agent-credentials.ts`, per-turn token sync in
 * `token-sync-manager.ts`, and repo-memory sharing in `repo-memory-manager.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import { writeContainerGitConfig } from "./git-config.js";
import { chownTreeToSessionWorker } from "./session-worker-uid.js";

/** Subdirectory under the credentials root that holds per-session subtrees. */
export const SESSION_CREDENTIALS_SUBDIR = "sessions";

/**
 * Files/dirs (relative to the credentials root) that make up each agent's
 * credential subtree — exactly the paths the session-worker image symlinks
 * into the runtime home (docs/150 — `/home/shipit`, was `/root`; see
 * `docker/Dockerfile.session-worker.*`):
 *   ~/.claude      -> /credentials/.claude
 *   ~/.claude.json -> /credentials/.claude.json
 *   ~/.codex       -> /credentials/.codex
 */
export const AGENT_CREDENTIAL_PATHS: Record<AgentId, readonly string[]> = {
  claude: [".claude", ".claude.json"],
  codex: [".codex"],
};

/**
 * Shared, non-agent-sensitive config copied verbatim into every session's
 * credentials dir regardless of agent.
 *
 * NOTE: `.gitconfig` is deliberately NOT in this list. The orchestrator's own
 * `.gitconfig` embeds the GitHub PAT inline (see `setGlobalCredentialHelper`),
 * so copying it into the sandbox would leak the token (docs/088 finding #5).
 * Instead each session gets a *generated*, token-free gitconfig via
 * {@link writeSessionGitConfig} that points `credential.helper` at the
 * brokering `shipit-git-credential` helper.
 */
export const SHARED_CREDENTIAL_PATHS: readonly string[] = [];

/**
 * Write the per-session container gitconfig (identity + brokering credential
 * helper, no token). Called from both the scaffold and provisioning hooks so
 * every container — warm/idle or freshly provisioned — has a token-free
 * gitconfig at `/credentials/.gitconfig`.
 */
export function writeSessionGitConfig(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  writeContainerGitConfig(path.join(dir, ".gitconfig"));
}

/** Absolute host path of a session's private credentials subtree. */
export function perSessionCredentialsDir(credentialsRoot: string, sessionId: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR, sessionId);
}

/**
 * Hand the per-session credentials subtree to the unprivileged session-worker
 * user (docs/150 §7). No-op unless `SHIPIT_SESSION_WORKER_UID` is set. Every
 * orchestrator-side writer into the subtree (scaffold, provision, per-turn token
 * sync, repush) calls this after writing so the freshly-written `0600 root:root`
 * credential files stay readable by `shipit` after the container's boot-time
 * chown has already run. Any future writer touching the subtree — including an
 * archive-restore path that recreates it after a disk-janitor sweep — must call
 * this too; the entrypoint chown only runs at container start.
 */
export function chownSessionCredentialsTree(credentialsRoot: string, sessionId: string): void {
  chownTreeToSessionWorker(perSessionCredentialsDir(credentialsRoot, sessionId));
}

/**
 * Path of a session's credentials subtree *relative to the credentials volume
 * root* — used as the Docker `VolumeOptions.Subpath` in production, where the
 * credentials volume root maps to `credentialsRoot` on the orchestrator. Always
 * a POSIX path (Docker expects forward slashes).
 */
export function perSessionCredentialsSubpath(sessionId: string): string {
  return path.posix.join(SESSION_CREDENTIALS_SUBDIR, sessionId);
}

/** Copy a single credential path (file or dir) from the source root into dest, overwriting. */
export function copyCredentialPath(srcRoot: string, destRoot: string, rel: string): void {
  const src = path.join(srcRoot, rel);
  if (!fs.existsSync(src)) return; // e.g. Codex never logged in — no .codex
  const dest = path.join(destRoot, rel);
  // `dereference: true` materializes any symlinks at or under `src` as real
  // files in `dest`. docs/150 added legacy-alias symlinks at the credentials
  // root (e.g. `<credentialsDir>/.claude` → `provider-accounts/.../.claude`),
  // and the legacy `provisionAgentCredentials` path passes the credentials
  // root as `srcRoot`. Without dereferencing, fs.cpSync would copy the
  // symlink itself into the session dir with an *absolute* `/credentials/...`
  // target. The agent container's `/credentials` mount is a Docker Subpath of
  // `sessions/<id>/`, so that absolute target resolves to a session-local
  // path different from what the orchestrator sees — splitting one
  // credentials file into two physical copies and stranding the agent on a
  // stale token that no `repushAgentToken` write can update. See docs/153.
  fs.cpSync(src, dest, { recursive: true, force: true, dereference: true });
}

/**
 * Ensure a session's credentials dir exists and carries the shared (non-agent)
 * config. Called at container-create time — including for warm/standby
 * containers, which are created before the agent is known. The dir therefore
 * holds **no agent credentials** while the container idles in the pool; only
 * `.gitconfig` is present.
 *
 * Idempotent and best-effort: re-copies `.gitconfig` (cheap, keeps the git
 * credential helper fresh as of container boot) and never throws on a missing
 * source.
 */
export function ensureSessionCredentialsScaffold(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of SHARED_CREDENTIAL_PATHS) {
    copyCredentialPath(credentialsRoot, dir, rel);
  }
  // Generate a token-free gitconfig (identity + brokering credential helper).
  writeSessionGitConfig(credentialsRoot, sessionId);
  // Hand the freshly-written subtree to the unprivileged worker user (docs/150).
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

/**
 * Remove a session's credentials subtree (e.g. on full reset, or as a
 * disk-janitor sweep for sessions no longer tracked). Best-effort; never
 * throws. Removing the parent `<credentialsRoot>/sessions` dir is supported by
 * passing the literal sessions-root via {@link sessionCredentialsRoot}.
 */
export function removeSessionCredentials(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — the next disk-janitor pass will retry.
  }
}

/** Root dir holding every session's credentials subtree (`<credentialsRoot>/sessions`). */
export function sessionCredentialsRoot(credentialsRoot: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR);
}
