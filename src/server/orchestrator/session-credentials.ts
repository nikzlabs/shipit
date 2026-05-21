/**
 * Per-agent credential isolation (docs/138).
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
 * (see `provisionAgentCredentials`). Net guarantee: a Claude session's
 * container never has `.codex` on disk, and a Codex session's never has
 * `.claude`.
 *
 * The functions here are deliberately pure (filesystem in/out, no Docker, no DB)
 * so they are unit-testable and can be called from both the container-lifecycle
 * mount builder and the first-turn provisioning hook.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import { writeContainerGitConfig } from "./git-config.js";

/** Subdirectory under the credentials root that holds per-session subtrees. */
export const SESSION_CREDENTIALS_SUBDIR = "sessions";

/**
 * Files/dirs (relative to the credentials root) that make up each agent's
 * credential subtree — exactly the paths the session-worker image symlinks
 * into `/root` (see `docker/Dockerfile.session-worker.*`):
 *   /root/.claude      -> /credentials/.claude
 *   /root/.claude.json -> /credentials/.claude.json
 *   /root/.codex       -> /credentials/.codex
 */
const AGENT_CREDENTIAL_PATHS: Record<AgentId, readonly string[]> = {
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
const SHARED_CREDENTIAL_PATHS: readonly string[] = [];

/**
 * Write the per-session container gitconfig (identity + brokering credential
 * helper, no token). Called from both the scaffold and provisioning hooks so
 * every container — warm/idle or freshly provisioned — has a token-free
 * gitconfig at `/credentials/.gitconfig`.
 */
function writeSessionGitConfig(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  writeContainerGitConfig(path.join(dir, ".gitconfig"));
}

/** Absolute host path of a session's private credentials subtree. */
export function perSessionCredentialsDir(credentialsRoot: string, sessionId: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR, sessionId);
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
function copyCredentialPath(srcRoot: string, destRoot: string, rel: string): void {
  const src = path.join(srcRoot, rel);
  if (!fs.existsSync(src)) return; // e.g. Codex never logged in — no .codex
  const dest = path.join(destRoot, rel);
  // `force: true` overwrites; `recursive: true` handles dirs; the source paths
  // are real files/dirs on the orchestrator (the symlinks live in the container
  // image, not here), so no dereference juggling is needed.
  fs.cpSync(src, dest, { recursive: true, force: true });
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
}

/**
 * Provision the **pinned agent's** credential subtree into a session's
 * credentials dir. Called exactly once, on the session's first turn, after the
 * agent is fixed. Copies only `agentId`'s files (plus a fresh `.gitconfig`) —
 * the other agent's credentials never land in this session's container.
 *
 * Because the per-session dir is already mounted into the (possibly already
 * running) container, writing here makes the credentials visible immediately;
 * no container remount is needed. This mirrors how env-based platform
 * credentials are injected, one layer down (files, not env).
 */
export function provisionAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // Refresh shared config first (token may have been set after the warm
  // container's scaffold ran), then the agent subtree.
  for (const rel of SHARED_CREDENTIAL_PATHS) {
    copyCredentialPath(credentialsRoot, dir, rel);
  }
  // Regenerate the token-free gitconfig — identity may have been set after the
  // warm container's scaffold ran (e.g. GitHub connected mid-session).
  writeSessionGitConfig(credentialsRoot, sessionId);
  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    copyCredentialPath(credentialsRoot, dir, rel);
  }
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

// ---------------------------------------------------------------------------
// Per-turn OAuth token sync (docs/142 Problem A — rotating refresh token)
//
// The agent CLI rewrites its credentials file in place when it refreshes a
// rotating (single-use) OAuth token. Because each session has its own *copy*
// of the credentials (write-once provisioning) and never writes back, the
// orchestrator's source token goes stale and every new session inherits a dead
// refresh token → 401. The fix: sync just the token file IN at each turn start
// (so the session always begins from the freshest token), and write it BACK to
// the source after the turn IFF it advanced — keeping one authoritative copy
// without distributing a long-lived refresh token N ways.
//
// Scoped to Claude for now: that's the confirmed failure, and the expiry guard
// below understands the Claude credentials shape. Codex stays on plain
// write-once provisioning (it has not exhibited the bug); extend when its token
// file shape is verified.
// ---------------------------------------------------------------------------

/**
 * Token files (relative to the credentials root) that carry the rotating OAuth
 * token — distinct from {@link AGENT_CREDENTIAL_PATHS} (the full provisioned
 * subtree). Only these are synced per-turn, so the CLI's other in-place writes
 * under `.claude` (history, projects, settings) are never clobbered.
 */
const AGENT_TOKEN_FILES: Partial<Record<AgentId, readonly string[]>> = {
  claude: [".claude/.credentials.json", ".claude/credentials.json", ".claude/auth.json"],
};

/** Copy a file via temp + atomic rename so a concurrent reader never sees a partial write. */
function atomicCopyFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

/**
 * Parse the OAuth expiry (epoch ms) from a Claude credentials file. Tolerant of
 * the `claudeAiOauth.expiresAt` (ms) and `expires_at` (seconds) shapes; returns
 * null when the file is missing, unparseable, or carries no expiry — which the
 * write-back guard treats as "can't prove it's newer, don't risk it".
 */
function readClaudeTokenExpiry(file: string): number | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const oauth = o.claudeAiOauth as Record<string, unknown> | undefined;
    const raw = oauth?.expiresAt ?? oauth?.expires_at ?? o.expiresAt ?? o.expires_at;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw < 10_000_000_000 ? raw * 1000 : raw; // seconds → ms heuristic
    }
  } catch {
    // missing / invalid JSON
  }
  return null;
}

/**
 * Before a turn: copy the freshest token file from the orchestrator source into
 * the session's per-session dir, so the session's CLI starts from the latest
 * token rather than a stale write-once copy. Only the token file is touched.
 * No-op for agents without a registered token file (e.g. Codex). (docs/142 A)
 */
export function syncAgentTokenIn(credentialsRoot: string, sessionId: string, agentId: AgentId): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const src = path.join(credentialsRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(sessionDir, rel);
    // Expiry guard (mirrors syncAgentTokenBack): only pull when the source is
    // strictly newer than the session's current token. Without this, an
    // unconditional copy clobbers a token the session refreshed locally with a
    // staler source — and, when the source itself is stale/dead, propagates
    // that dead token into every session (which is what uniformly broke
    // sessions, naming included, while the orchestrator token was expired).
    // Skip only when we can prove the session token is already as fresh or
    // fresher; copy on a missing/corrupt/older session token. (docs/142 A)
    const dstExp = fs.existsSync(dst) ? readClaudeTokenExpiry(dst) : null;
    if (dstExp !== null) {
      const srcExp = readClaudeTokenExpiry(src);
      if (srcExp === null || srcExp <= dstExp) continue;
    }
    atomicCopyFile(src, dst);
  }
}

/**
 * After a turn: if the session's CLI refreshed the rotating token (its token
 * file now carries a strictly later expiry than the orchestrator source), write
 * it back so the source — and every future session — stays fresh. The expiry
 * guard is what makes the rare concurrent-refresh case safe: a session that
 * FAILED to refresh (same/older expiry) can never clobber a fresher source
 * token. No-op for agents without a registered token file. (docs/142 A)
 */
export function syncAgentTokenBack(credentialsRoot: string, sessionId: string, agentId: AgentId): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const sessionFile = path.join(sessionDir, rel);
    if (!fs.existsSync(sessionFile)) continue;
    const sessionExp = readClaudeTokenExpiry(sessionFile);
    if (sessionExp === null) continue; // can't prove it's newer — don't risk a regression
    const sourceFile = path.join(credentialsRoot, rel);
    const sourceExp = fs.existsSync(sourceFile) ? readClaudeTokenExpiry(sourceFile) : null;
    if (sourceExp !== null && sessionExp <= sourceExp) continue; // source already as fresh or fresher
    atomicCopyFile(sessionFile, sourceFile);
  }
}
