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
import { providerAccountCredentialRoot } from "./provider-account-manager.js";

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
  provisionAgentCredentialsFromRoot(credentialsRoot, sessionId, agentId, credentialsRoot, false);
}

export function provisionProviderAccountCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
): void {
  provisionAgentCredentialsFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    true,
  );
}

function provisionAgentCredentialsFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  replaceExistingProviderSubtree: boolean,
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
    if (replaceExistingProviderSubtree) {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    }
    copyCredentialPath(sourceRoot, dir, rel);
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
// Both agents are covered: Claude is the confirmed failure; Codex has the same
// latent rotation hazard (rotating refresh token + per-session copy) even
// though it hadn't been observed in the wild. Each agent declares its token
// file(s) and a "freshness" reader so the expiry guards compare like with like
// (Claude: `claudeAiOauth.expiresAt`; Codex: the access-token JWT `exp` claim /
// `last_refresh`, since its `auth.json` carries no plain expiry field).
// ---------------------------------------------------------------------------

/**
 * Token files (relative to the credentials root) that carry the rotating OAuth
 * token — distinct from {@link AGENT_CREDENTIAL_PATHS} (the full provisioned
 * subtree). Only these are synced per-turn, so the CLI's other in-place writes
 * (Claude: history/projects/settings under `.claude`; Codex: `config.toml`
 * under `.codex`) are never clobbered.
 */
const AGENT_TOKEN_FILES: Partial<Record<AgentId, readonly string[]>> = {
  claude: [".claude/.credentials.json", ".claude/credentials.json", ".claude/auth.json"],
  codex: [".codex/auth.json"],
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
 * "Freshness" (epoch ms) of a Codex `auth.json` — a strictly larger value means
 * a more-recently-refreshed token. Codex writes no plain `expiresAt`, so we
 * read, in order: an explicit `expires_at`/`expiresAt` if a future CLI adds
 * one; else the access/id-token JWT `exp` claim (advances on every refresh);
 * else the `last_refresh` ISO timestamp. Returns null when none is parseable —
 * which the guards treat as "can't prove it's newer".
 */
function readCodexTokenFreshness(file: string): number | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const tokens = (o.tokens && typeof o.tokens === "object" ? o.tokens : {}) as Record<string, unknown>;
    const explicit = o.expires_at ?? o.expiresAt ?? tokens.expires_at ?? tokens.expiresAt;
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
      return explicit < 10_000_000_000 ? explicit * 1000 : explicit; // seconds → ms
    }
    for (const k of ["access_token", "id_token"]) {
      const jwt = tokens[k] ?? o[k];
      if (typeof jwt !== "string") continue;
      const parts = jwt.split(".");
      if (parts.length < 2) continue;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
          return payload.exp * 1000; // JWT exp is seconds
        }
      } catch { /* malformed JWT segment — try the next token */ }
    }
    if (typeof o.last_refresh === "string") {
      const t = Date.parse(o.last_refresh);
      if (Number.isFinite(t)) return t;
    }
  } catch {
    // missing / invalid JSON
  }
  return null;
}

/**
 * Per-agent token "freshness" reader (epoch ms). Source and session files for
 * the *same* agent are always compared with the same reader, so the metrics
 * never mix across agents.
 */
const TOKEN_FRESHNESS: Partial<Record<AgentId, (file: string) => number | null>> = {
  claude: readClaudeTokenExpiry,
  codex: readCodexTokenFreshness,
};

/**
 * Before a turn: copy the freshest token file from the orchestrator source into
 * the session's per-session dir, so the session's CLI starts from the latest
 * token rather than a stale write-once copy. Only the token file is touched.
 * No-op for agents without a registered token file (e.g. Codex). (docs/142 A)
 */
/**
 * Optional callback fired by the per-turn sync paths when the docs/153 leak
 * repair reaches a terminal state about the session's CLI conversation id.
 *
 *   - string: a resumable conversation jsonl exists on disk; the caller
 *     should update `sessions.agent_session_id` to this value so the next
 *     `claude --resume <id>` finds it.
 *   - null: the leak repair fired but no resumable conversation was found
 *     (the on-disk state is only post-turn metadata stubs). The caller
 *     should *clear* `sessions.agent_session_id` and drop the `--resume`
 *     arg from the next spawn, so the CLI starts a fresh conversation
 *     instead of `--resume`-looping on a known-bad id. The orchestrator
 *     side chat history is unaffected; only the CLI-side resume
 *     continuity is gone.
 *
 * Optional because not every caller has a SessionManager (tests, local
 * mode).
 */
export type AgentSessionIdRecoveryCallback = (
  recoveredOrClear: string | null,
) => void;

export function syncAgentTokenIn(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
): void {
  syncAgentTokenInFromRoot(
    credentialsRoot, sessionId, agentId, credentialsRoot,
    onRecoverAgentSessionId, currentAgentSessionId,
  );
}

export function syncProviderAccountTokenIn(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
): void {
  syncAgentTokenInFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    onRecoverAgentSessionId,
    currentAgentSessionId,
  );
}

function syncAgentTokenInFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  // docs/153 — repair leaked subtree-root symlinks before the per-turn copy
  // so the orchestrator and the agent container converge on the same
  // physical file. See `materializeLeakedSubtreeSymlinks` for the full why.
  const repair = materializeLeakedSubtreeSymlinks(
    credentialsRoot, sessionDir, agentId, sourceRoot, currentAgentSessionId,
  );
  if (repair.outcome !== "no-action" && onRecoverAgentSessionId) {
    try {
      onRecoverAgentSessionId(
        repair.outcome === "recovered" ? repair.recoveredAgentSessionId : null,
      );
    } catch (err) {
      console.warn("[session-credentials] recovered agent_session_id callback failed:", err);
    }
  }
  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
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
    const dstExp = fs.existsSync(dst) ? freshness(dst) : null;
    if (dstExp !== null) {
      const srcExp = freshness(src);
      if (srcExp === null || srcExp <= dstExp) continue;
    }
    atomicCopyFile(src, dst);
  }
}

/**
 * After an explicit re-auth (`auth_complete`): force the freshly-minted source
 * token into a session's per-session dir, **unconditionally** (no expiry
 * guard). Distinct from {@link syncAgentTokenIn}, whose guard would skip a
 * session holding a later-expiry-but-dead token — exactly the state a manual
 * re-login exists to repair. So a session pinned *before* the re-auth recovers
 * immediately instead of waiting for its next turn's sync-in. (docs/142 A3)
 *
 * Cross-agent safe: only overwrites a token file the session **already has**.
 * A warm/idle container (no agent creds yet) or a session pinned to the other
 * agent has no matching token file, so nothing is written — we never create
 * `.claude` inside a Codex session (docs/138 isolation). Returns true iff a
 * file was written (the session was an active holder of this agent's token).
 */
export function repushAgentToken(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
): boolean {
  return repushAgentTokenFromRoot(
    credentialsRoot, sessionId, agentId, credentialsRoot,
    onRecoverAgentSessionId, currentAgentSessionId,
  );
}

export function repushProviderAccountToken(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
): boolean {
  return repushAgentTokenFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    onRecoverAgentSessionId,
    currentAgentSessionId,
  );
}

function repushAgentTokenFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
): boolean {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return false;
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);

  // Repair leaked subtree-root symlinks before writing. Sessions provisioned
  // through the pre-fix `copyCredentialPath` saw the legacy-alias symlinks at
  // the credentials root preserved as symlinks in the session dir — with an
  // *absolute* `/credentials/...` target that resolves to a different
  // physical file inside the agent container (subpath-mounted on
  // `sessions/<id>/`) than it does on the orchestrator (volume-root mounted).
  // The repush below copies through the orchestrator-side resolution; the
  // agent-side stale copy never gets touched, so the agent keeps 401'ing on a
  // dead token. Replace any such symlink with a real materialized subtree so
  // both namespaces converge on the same file again. See docs/153.
  const repair = materializeLeakedSubtreeSymlinks(
    credentialsRoot, sessionDir, agentId, sourceRoot, currentAgentSessionId,
  );
  if (repair.outcome !== "no-action" && onRecoverAgentSessionId) {
    try {
      onRecoverAgentSessionId(
        repair.outcome === "recovered" ? repair.recoveredAgentSessionId : null,
      );
    } catch (err) {
      console.warn("[session-credentials] recovered agent_session_id callback failed:", err);
    }
  }

  let wrote = false;
  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(sessionDir, rel);
    if (!fs.existsSync(dst)) continue; // don't seed creds into a non-holder
    atomicCopyFile(src, dst);
    wrote = true;
  }
  return wrote;
}

/**
 * Subpaths under `.claude/` that carry the session's CLI-side conversation
 * state — written by the agent CLI when it followed the leaked symlink in
 * its own namespace. These are the orphan files the non-destructive repair
 * has to rescue before nuking the orphan tree. Shared-dir entries win on
 * conflict (defensive — same filename collision is implausible since
 * `projects/<encoded-cwd>/<agentSessionId>.jsonl` carries the session's
 * unique agent_session_id).
 */
const CLAUDE_SESSION_STATE_SUBPATHS: readonly string[] = [
  "projects",
  "sessions",
  "history.jsonl",
];

/** Anchor for symlink targets authored to point at the volume root. */
const CREDENTIALS_MOUNT_PREFIX = "/credentials/";

/**
 * Result of a single leak-repair pass over a session's credentials dir.
 * Three terminal states:
 *
 *   - `outcome: "no-action"` — no Case fired; caller leaves DB alone.
 *   - `outcome: "recovered"` — a Case fired and a resumable conversation
 *     jsonl was found; `recoveredAgentSessionId` is the id to set.
 *   - `outcome: "clear"` — a Case fired but no resumable conversation
 *     jsonl exists (the on-disk state is just stub metadata from the
 *     post-turn flow). Caller must clear the DB pointer and drop the
 *     `--resume` arg on the next spawn so the CLI starts a fresh
 *     conversation instead of `--resume <known-bad-id>`-looping. The
 *     orchestrator-side chat history is unaffected; only the CLI-side
 *     resume continuity is lost.
 */
type LeakRepairResult =
  | { outcome: "no-action" }
  | { outcome: "recovered"; recoveredAgentSessionId: string }
  | { outcome: "clear" };

/**
 * Repair the docs/153 leak. Two entry conditions:
 *
 *   Case 1 — LIVE LEAK (`.claude/` is a symlink). The legacy alias was
 *     preserved as a symlink during provisioning (or recreated post-
 *     provisioning by a still-unidentified writer). The agent CLI, inside
 *     the Subpath-mounted container, followed the symlink target string
 *     into `<sessionDir>/provider-accounts/.../...` and wrote conversation
 *     history there. Repair: unlink + cpSync shared baseline + merge
 *     orphan content + drop orphan root + recover agent_session_id.
 *
 *   Case 3 — POST-DESTRUCTIVE-REPAIR ORPHAN (`.claude/` is a real dir, but
 *     `<sessionDir>/provider-accounts/.../<rel>` still exists). The
 *     pre-#758 destructive repair already rm'd the symlink and cpSync'd
 *     the shared baseline, but left the orphan tree behind. The agent now
 *     reads `.claude/` (real dir) which has no `projects/...` for this
 *     session, so `--resume <agentSessionId>` keeps failing with "No
 *     conversation found" until we layer the orphan back on top. Repair:
 *     skip rmSync + skip cpSync from shared (dst already has the shared
 *     baseline); merge orphan content + drop orphan root + recover
 *     agent_session_id.
 *
 *   Case 2 (true no-op) — `.claude/` is a real dir AND no orphan exists.
 *
 * For both repair cases the order is critical: read latest jsonl mtime
 * from the orphan BEFORE any cpSync/merge, since cpSync doesn't preserve
 * mtimes. Then merge with shared-wins-on-conflict for `.claude/`'s state
 * subpaths and orphan-wins for `.claude.json` (session-specific CLI
 * config; the shared one is a generic baseline).
 *
 * Idempotent. The repaired session converges to a single physical
 * `.claude/` tree containing both the fresh shared credentials and the
 * session's recovered conversation history.
 */
function materializeLeakedSubtreeSymlinks(
  credentialsRoot: string,
  sessionDir: string,
  agentId: AgentId,
  sourceRoot: string,
  currentAgentSessionId?: string | null,
): LeakRepairResult {
  // `aCaseFired` distinguishes between "no Case applied → DB stays untouched"
  // and "Case applied but couldn't recover a resumable id → DB must be
  // cleared so the next turn drops --resume". Cases 1/3 set it via the
  // filesystem-mutation path; Case 4 sets it inline below.
  let aCaseFired = false;
  let recoveredAgentSessionId: string | null = null;
  const orphanRootsToRemove = new Set<string>();

  // For the post-destructive-repair case below (no symlink, but orphan still
  // present): the orphan lives at the "<sessionDir>/<sourceRoot relative to
  // credentialsRoot>" mirror, which is where the agent CLI wrote when it
  // followed the now-removed symlink in its Subpath namespace. Only relevant
  // when sourceRoot lives under credentialsRoot (the provider-account flow);
  // the legacy `provisionAgentCredentials` path uses sourceRoot ===
  // credentialsRoot, where the mirror collapses to dst itself.
  const sourceRelToCredentials = path.relative(credentialsRoot, sourceRoot);
  const expectedOrphanBase =
    sourceRelToCredentials
      && sourceRelToCredentials !== ""
      && !sourceRelToCredentials.startsWith("..")
      && !path.isAbsolute(sourceRelToCredentials)
      ? sourceRelToCredentials
      : null;

  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    const dst = path.join(sessionDir, rel);
    let dstStat: fs.Stats | null = null;
    try {
      dstStat = fs.lstatSync(dst);
    } catch {
      continue; // dst doesn't exist — nothing to repair
    }

    let orphanPath: string | null = null;
    let isSymlinkLeak = false;

    if (dstStat.isSymbolicLink()) {
      // ---- Case 1: live symlink leak ----
      isSymlinkLeak = true;
      const target = fs.readlinkSync(dst);
      // Resolve the orphan the symlink points at *inside the agent
      // container's namespace*. Two target shapes are observed in the wild:
      //   - prod: absolute `/credentials/provider-accounts/...` (the literal
      //     volume-mount path on the orchestrator side, baked in by
      //     ensureLegacyAlias when credentialsDir = "/credentials").
      //   - test: absolute `<credentialsRoot>/provider-accounts/...` (the
      //     temp-dir path of the test fixture).
      // Both reduce to a "path relative to the credentials root"; prepending
      // `<sessionDir>` gives the in-agent-namespace orphan location.
      let relativeFromVolume: string | null = null;
      if (target.startsWith(CREDENTIALS_MOUNT_PREFIX)) {
        relativeFromVolume = target.slice(CREDENTIALS_MOUNT_PREFIX.length);
      } else if (target.startsWith(`${credentialsRoot}${path.sep}`)) {
        relativeFromVolume = target.slice(credentialsRoot.length + 1);
      }
      if (relativeFromVolume) {
        orphanPath = path.join(sessionDir, relativeFromVolume);
        const orphanRoot = path.join(sessionDir, relativeFromVolume.split(path.sep)[0] ?? "");
        if (orphanRoot && orphanRoot !== sessionDir) orphanRootsToRemove.add(orphanRoot);
      }
    } else if (expectedOrphanBase) {
      // ---- Case 3: real dir + orphan still present ----
      //
      // Sessions repaired by the pre-#758 destructive flow had their leaked
      // symlink rm'd and the shared baseline cpSync'd on top — but the
      // orphan subtree at `<sessionDir>/<sourceRel>/<rel>` (where the agent
      // CLI wrote its conversation history while the leak was live) was
      // never touched. dst is already a real dir; we just need to layer the
      // orphan content on top and drop the orphan root. NO cpSync from
      // shared — dst already has shared content from the previous repair,
      // and re-copying risks clobbering anything the user's CLI has written
      // to `.claude/` since.
      const candidateOrphan = path.join(sessionDir, expectedOrphanBase, rel);
      if (fs.existsSync(candidateOrphan)) {
        orphanPath = candidateOrphan;
        const orphanRoot = path.join(sessionDir, expectedOrphanBase.split(path.sep)[0] ?? "");
        if (orphanRoot && orphanRoot !== sessionDir) orphanRootsToRemove.add(orphanRoot);
      }
    }

    if (!isSymlinkLeak && !orphanPath) continue; // healthy dir with no orphan — true no-op

    // Recover the agent_session_id from the orphan's `projects/` tree BEFORE
    // any cpSync/merge — cpSync doesn't preserve mtimes, so once we copy the
    // orphan's jsonls into dst the latest-mtime ordering signal is gone.
    // Applies to both Case 1 and Case 3.
    if (
      orphanPath
        && rel === ".claude"
        && recoveredAgentSessionId === null
        && fs.existsSync(orphanPath)
    ) {
      recoveredAgentSessionId = findLatestAgentSessionId(path.join(orphanPath, "projects"));
    }

    if (isSymlinkLeak) {
      fs.rmSync(dst, { force: true });
      const src = path.join(sourceRoot, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true, force: true, dereference: true });
      }
      if (orphanPath && fs.existsSync(orphanPath)) {
        mergeOrphanState(orphanPath, dst, rel);
      }
      const mergeNote = orphanPath ? ` (orphan merged from ${orphanPath})` : "";
      console.log(`[session-credentials] repaired leaked symlink in ${sessionDir}: ${rel}${mergeNote}`);
    } else {
      // Case 3 — orphan-only recovery; dst already has the shared baseline
      // from the previous destructive repair.
      mergeOrphanState(orphanPath!, dst, rel);
      console.log(
        `[session-credentials] recovered orphaned history in ${sessionDir}: ${rel} (no leaked symlink, but ${orphanPath} present)`,
      );
    }

    aCaseFired = true;
  }

  // ---- Case 4: stale DB pointer, jsonls already on disk ----
  //
  // The session sailed through the docs/153 cycle: Cases 1/3 already ran on
  // a previous turn (or an out-of-band cleanup dropped the orphan without
  // firing the recovery callback). `.claude/` is a healthy real dir, no
  // orphan tree to merge, but `sessions.agent_session_id` in the DB points
  // at a UUID that has no matching `<dst>/projects/*/<id>.jsonl` on disk —
  // typically a doomed-init UUID stranded by the pre-#764 listener.
  // Result: `--resume <stale-id>` fails on every turn, the user is stuck
  // until manual intervention.
  //
  // Recovery: scan `<dst>/projects/*/*.jsonl` for the latest-mtime file and
  // surface its sessionId as the recovered id. The caller (post-#764)
  // propagates it through to the spawn arg, so the next turn `--resume`s
  // the conversation the user actually had. Read-only — no filesystem
  // mutations needed. Skipped on fresh sessions (no current id to compare)
  // and on non-claude agents (no `projects/<encoded-cwd>/<id>.jsonl`
  // layout).
  //
  // docs/155: Claude-specific CLI-shape recovery. The
  // `<sessionDir>/.claude/projects/<encoded-cwd>/<id>.jsonl` layout is
  // unique to the Claude CLI's `--resume` flag; Codex uses a different
  // on-disk resume mechanism. Per plan.md non-goal ("CLI-shape
  // differences stay distinct").
  if (
    // eslint-disable-next-line no-restricted-syntax -- docs/155: Claude-specific CLI-shape recovery, see comment above
    agentId === "claude"
    && recoveredAgentSessionId === null
    && currentAgentSessionId
  ) {
    const dst = path.join(sessionDir, ".claude");
    let isRealDir = false;
    try {
      const stat = fs.lstatSync(dst);
      isRealDir = !stat.isSymbolicLink() && stat.isDirectory();
    } catch { /* dst doesn't exist — nothing to recover */ }
    if (isRealDir) {
      const projectsRoot = path.join(dst, "projects");
      if (!jsonlExistsForAgentSessionId(projectsRoot, currentAgentSessionId)) {
        // Stale-pointer condition confirmed (DB id has no jsonl on disk).
        // This IS a Case — the caller must either set the recovered id or
        // clear the DB; in either case the spawn must NOT pass
        // `--resume <currentAgentSessionId>`.
        aCaseFired = true;
        const latest = findLatestAgentSessionId(projectsRoot);
        if (latest && latest !== currentAgentSessionId) {
          recoveredAgentSessionId = latest;
          console.log(
            `[session-credentials] recovered stale agent_session_id in ${sessionDir}: .claude (DB pointed at ${currentAgentSessionId}, latest on disk is ${latest})`,
          );
        } else {
          console.log(
            `[session-credentials] clearing stale agent_session_id in ${sessionDir}: .claude (DB pointed at ${currentAgentSessionId}, no resumable jsonl on disk)`,
          );
        }
      }
    }
  }

  if (aCaseFired) {
    for (const orphanRoot of orphanRootsToRemove) {
      try {
        fs.rmSync(orphanRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[session-credentials] failed to drop orphan ${orphanRoot}:`, err);
      }
    }
  }

  if (!aCaseFired) return { outcome: "no-action" };
  if (recoveredAgentSessionId !== null) {
    return { outcome: "recovered", recoveredAgentSessionId };
  }
  return { outcome: "clear" };
}

/**
 * True iff `<projectsRoot>/*\/<agentSessionId>.jsonl` exists for any
 * encoded-cwd subdir AND that file passes
 * {@link jsonlIsResumableConversation}. Filename-existence alone is not
 * enough: the CLI's post-turn flow writes freshly-named stub jsonls
 * (last-prompt/ai-title/pr-link events only) that have valid names but
 * fail `--resume` with "No conversation found". Used by Case 4 in the
 * leak repair to distinguish "DB id points at a resumable conversation"
 * from "DB id points at junk."
 */
function jsonlExistsForAgentSessionId(projectsRoot: string, agentSessionId: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, `${agentSessionId}.jsonl`);
    if (fs.existsSync(candidate) && jsonlIsResumableConversation(candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * Move conversation state from an orphan subtree into the freshly
 * materialized destination. Behavior is per-rel:
 *
 *   - For `.claude/`: copy specific session-state subpaths
 *     (`projects/`, `sessions/`, `history.jsonl`) recursively without
 *     overwriting anything the shared source already provided.
 *   - For `.claude.json`: if the orphan version exists and differs from
 *     what the shared source wrote, overwrite dest with the orphan.
 */
function mergeOrphanState(orphanPath: string, dstPath: string, rel: string): void {
  if (rel === ".claude") {
    for (const sub of CLAUDE_SESSION_STATE_SUBPATHS) {
      const orphanSub = path.join(orphanPath, sub);
      if (!fs.existsSync(orphanSub)) continue;
      try {
        fs.cpSync(orphanSub, path.join(dstPath, sub), {
          recursive: true,
          force: false,
          errorOnExist: false,
          dereference: true,
        });
      } catch (err) {
        console.warn(`[session-credentials] failed to merge orphan ${orphanSub}:`, err);
      }
    }
    return;
  }
  if (rel === ".claude.json") {
    try {
      const orphanContent = fs.readFileSync(orphanPath);
      let dstContent: Buffer | null = null;
      try {
        dstContent = fs.readFileSync(dstPath);
      } catch { /* dst missing — orphan wins by default */ }
      if (!dstContent || !orphanContent.equals(dstContent)) {
        fs.writeFileSync(dstPath, orphanContent);
      }
    } catch (err) {
      console.warn(`[session-credentials] failed to merge orphan .claude.json from ${orphanPath}:`, err);
    }
  }
}

/**
 * Number of lines scanned from each jsonl when evaluating whether it
 * contains a *real* conversation. The Claude CLI's post-turn flow writes
 * metadata stubs (last-prompt / ai-title / pr-link events) into freshly
 * named jsonls AFTER touching the conversation jsonl, so a naive
 * latest-mtime pick lands on the stub. Cheap to scan more lines on the
 * candidate set, but in practice the first user/assistant events appear
 * very early — 50 lines is generous.
 */
const RESUMABLE_JSONL_SCAN_LINES = 50;

/**
 * Lightweight check that a jsonl looks like a resumable conversation —
 * the CLI requires at least one `type: "user"` AND one `type: "assistant"`
 * message-event row to load `--resume <id>` successfully. Stub jsonls
 * written by the post-turn flow (last-prompt / ai-title / pr-link) carry
 * neither and would fail `--resume` with "No conversation found" if
 * picked. Returns false on parse errors / missing rows.
 */
function jsonlIsResumableConversation(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (!raw.trim()) return false;
  let hasUser = false;
  let hasAssistant = false;
  const lines = raw.split("\n", RESUMABLE_JSONL_SCAN_LINES);
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: { type?: unknown };
    try {
      parsed = JSON.parse(line) as { type?: unknown };
    } catch {
      continue;
    }
    if (parsed.type === "user") hasUser = true;
    else if (parsed.type === "assistant") hasAssistant = true;
    if (hasUser && hasAssistant) return true;
  }
  return false;
}

/**
 * Walk `<projectsRoot>/*\/*.jsonl`, keep only files that pass
 * {@link jsonlIsResumableConversation} (real user+assistant events
 * present), and return the `sessionId` from the most-recently-modified
 * qualifying file's first JSON line. Returns null when no jsonl exists,
 * no candidate is resumable, or no usable `sessionId` is present.
 *
 * Used by all four leak-repair cases. Returning null is meaningful: the
 * caller surfaces it as an explicit "clear the DB pointer" signal so the
 * CLI's next turn drops `--resume` and starts fresh, rather than passing
 * a known-bad id that would re-trigger the missing-conversation loop.
 */
function findLatestAgentSessionId(projectsRoot: string): string | null {
  const candidates: { path: string; mtimeMs: number }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, entry.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const full = path.join(projectDir, file.name);
      try {
        const mtimeMs = fs.statSync(full).mtimeMs;
        candidates.push({ path: full, mtimeMs });
      } catch { /* ignore — race with another writer */ }
    }
  }
  // Descending mtime — pick the first that looks like a real conversation.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    if (!jsonlIsResumableConversation(c.path)) continue;
    try {
      const raw = fs.readFileSync(c.path, "utf8");
      const firstNewline = raw.indexOf("\n");
      const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
      if (!firstLine.trim()) continue;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      const sid = parsed.sessionId;
      if (typeof sid === "string" && sid.length > 0) return sid;
    } catch { /* try the next candidate */ }
  }
  return null;
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
  syncAgentTokenBackToRoot(credentialsRoot, sessionId, agentId, credentialsRoot);
}

export function syncProviderAccountTokenBack(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
): void {
  syncAgentTokenBackToRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
  );
}

function syncAgentTokenBackToRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const sessionFile = path.join(sessionDir, rel);
    if (!fs.existsSync(sessionFile)) continue;
    const sessionExp = freshness(sessionFile);
    if (sessionExp === null) continue; // can't prove it's newer — don't risk a regression
    const sourceFile = path.join(sourceRoot, rel);
    const sourceExp = fs.existsSync(sourceFile) ? freshness(sourceFile) : null;
    if (sourceExp !== null && sessionExp <= sourceExp) continue; // source already as fresh or fresher
    atomicCopyFile(sessionFile, sourceFile);
  }
}
