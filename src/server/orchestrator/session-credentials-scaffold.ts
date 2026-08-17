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
import { chownTreeToSessionWorker, sealDirMode } from "./session-worker-uid.js";

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
  // OpenCode's XDG data root: auth.json + the opencode.db session store live
  // under ~/.local/share/opencode (docs/270). The nested path means any
  // symlinking step must create `~/.local/share` first.
  opencode: [".local/share/opencode"],
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
 * The directory the per-session credential subtrees live IN — `<sessionId>`
 * children. docs/270 gives this to `shared/session-identity.ts` as its second
 * root, so a chown of a per-session credential file resolves to the SAME
 * identity a chown inside that session's workspace does.
 */
export function perSessionCredentialsRoot(credentialsRoot: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR);
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
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  chownTreeToSessionWorker(dir);
  // docs/270 — seal it, for the same reason and by the same means as the session
  // directory: once sessions hold different uids, a subtree left at the default
  // 0755 is one another session's payload can walk into. This one holds the
  // agent's provider credentials, so it is if anything the worse of the two to
  // leave open. `chownTreeToSessionWorker` above has already resolved this path
  // to the owning session, so the mode is all that is missing.
  //
  // Directory-level, exactly like the session dir: 0700 denies traversal, so no
  // credential file inside needs a mode of its own and no writer has to remember
  // one — which matters here, where several unrelated writers create files.
  sealDirMode(dir);
}

/**
 * docs/260 §4/§5 — which provider ACCOUNT'S credentials a session's subtree
 * currently holds, per agent. Written by every writer that replaces the subtree
 * (first-turn provisioning, the per-turn identity check, and the temporary
 * sub-agent credential window), cleared by revocation, so it is authoritative
 * for the copy on disk — token bytes cannot answer this (the CLI rotates them),
 * and the session row no longer records a route at all.
 *
 * It lives at the scaffold layer rather than beside the provisioning code
 * because the token sync is its most important READER: a write-back is only
 * allowed to publish the session's token to the account the marker names, and a
 * reader that has to import the provisioner to ask would be a module cycle. The
 * marker is state about the subtree, which is what this module owns.
 *
 * Orchestrator-side state only. It sits inside the per-session dir for the same
 * reason the credentials do — one thing to delete — but nothing in the container
 * reads it, so whether a given writer leaves it `root:root` or hands it to the
 * worker with the rest of the tree is deliberately not something callers manage.
 */
const SESSION_ACCOUNT_MARKER = ".shipit-provider-accounts.json";

export function readSessionAccountMarker(
  credentialsRoot: string,
  sessionId: string,
): Partial<Record<AgentId, string>> {
  const file = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SESSION_ACCOUNT_MARKER);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<AgentId, string>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if ((key === "claude" || key === "codex" || key === "opencode") && typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSessionAccountMarker(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string | null,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  const current = readSessionAccountMarker(credentialsRoot, sessionId);
  if (accountId === null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by the AgentId union, not arbitrary input
    delete current[agentId];
  } else {
    current[agentId] = accountId;
  }
  fs.writeFileSync(path.join(dir, SESSION_ACCOUNT_MARKER), JSON.stringify(current));
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

/**
 * Drop a symlink sitting AT a credential destination so the copy that follows
 * materializes a real file/dir there.
 *
 * DEFENSIVE ONLY — this guards a case we have never observed. It does **not**
 * explain any known incident, and in particular it does not explain the
 * `.credentials.json` found nested under
 * `<sessionDir>/provider-accounts/<provider>/<account>/.claude/`. That nesting
 * came from `migrateProviderDefault`'s `renameSync` moving a live agent home
 * (see `provider-account-manager.ts` and the addendum in
 * `docs/153-orchestrator-owned-claude-oauth-refresh/plan.md`); every affected
 * session had a real `.claude` directory and no symlink was ever found. An
 * earlier draft of this comment narrated the symlink as the cause — it was a
 * hypothesis, it was disproved, and chasing it cost hours. If you are here
 * debugging nested credentials, look at the migration, not at this function.
 *
 * What is independently true, and why the guard is still worth keeping:
 *
 *   - `fs.cpSync`'s `dereference` option governs the SOURCE only; it says
 *     nothing about a symlink at the destination.
 *   - Both destination-symlink outcomes would be bad. If the link RESOLVES,
 *     `cpSync` follows it and writes THROUGH it, so the flat
 *     `<sessionDir>/<rel>` never becomes a real dir and the credential lands
 *     wherever the link pointed. If it DANGLES, `cpSync` throws EEXIST and
 *     provisioning fails — quietly, since `prepareSessionAgentEnvironment`
 *     catches and warns.
 *   - `rmSync` on a symlink unlinks the LINK, never the target, so removing it
 *     cannot destroy whatever the link pointed at.
 *   - `recursive: true` is required for the symlink-to-directory case: Node.js
 *     24.13.0 throws ERR_FS_EISDIR without it (the same constraint the leak
 *     repair documents).
 *   - Only the FINAL path component is materialized. Every entry in
 *     {@link SHARED_CREDENTIAL_PATHS} is single-segment; OpenCode's
 *     `.local/share/opencode` (docs/270) is the one multi-segment rel in
 *     {@link AGENT_CREDENTIAL_PATHS}, and its parents are ordinary
 *     directories everywhere ShipIt creates them (`cpSync` materializes them
 *     as real dirs; the image symlink sits at the LEAF). A symlink smuggled
 *     into a PARENT component would still be followed — keep leaf-level
 *     symlinking the rule for any future entry.
 */
function materializeCredentialDestination(dest: string): void {
  const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink()) return;
  // Read the target before unlinking: it names the tree the agent CLI has been
  // reading and writing, which is the one piece of forensics worth having when
  // this fires. Best-effort — the removal matters, the log line does not.
  let target = "?";
  try {
    target = fs.readlinkSync(dest);
  } catch {
    // Unreadable link — still remove it.
  }
  fs.rmSync(dest, { recursive: true, force: true });
  console.warn(
    `[session-credentials] removed symlink at credential destination ${dest} -> ${target}; `
      + `materializing a real path instead. Any state under the old target is recovered by the `
      + `per-turn orphan repair (docs/153).`,
  );
}

/** Copy a single credential path (file or dir) from the source root into dest, overwriting. */
export function copyCredentialPath(srcRoot: string, destRoot: string, rel: string): void {
  const src = path.join(srcRoot, rel);
  if (!fs.existsSync(src)) return; // e.g. Codex never logged in — no .codex
  const dest = path.join(destRoot, rel);
  // Never write THROUGH a symlink at the destination — see the function's doc.
  materializeCredentialDestination(dest);
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
