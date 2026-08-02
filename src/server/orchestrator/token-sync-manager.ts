/**
 * Per-turn OAuth token sync (docs/142 Problem A — rotating refresh token).
 *
 * The agent CLI rewrites its credentials file in place when it refreshes a
 * rotating (single-use) OAuth token. Because each session has its own *copy*
 * of the credentials (write-once provisioning) and never writes back, the
 * orchestrator's source token goes stale and every new session inherits a dead
 * refresh token → 401. The fix: sync just the token file IN at each turn start
 * (so the session always begins from the freshest token), and write it BACK to
 * the source after the turn IFF it advanced — keeping one authoritative copy
 * without distributing a long-lived refresh token N ways.
 *
 * Both agents are covered: Claude is the confirmed failure; Codex has the same
 * latent rotation hazard (rotating refresh token + per-session copy) even
 * though it hadn't been observed in the wild. Each agent declares its token
 * file(s) and a "freshness" reader so the expiry guards compare like with like
 * (Claude: `claudeAiOauth.expiresAt`; Codex: the access-token JWT `exp` claim /
 * `last_refresh`, since its `auth.json` carries no plain expiry field).
 *
 * This module also owns the docs/153 leaked-subtree-symlink repair, which the
 * sync-in / repush paths run before the per-turn copy so the orchestrator and
 * the agent container converge on the same physical file.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { PROVIDER_ACCOUNTS_SUBDIR, providerAccountCredentialRoot } from "./provider-account-manager.js";
import {
  AGENT_CREDENTIAL_PATHS,
  chownSessionCredentialsTree,
  perSessionCredentialsDir,
} from "./session-credentials-scaffold.js";

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

// Claude keys conversation history by its encoded cwd. Session agents always
// run at /workspace, so only this bucket can be resumed by the next CLI spawn.
// Scanning sibling buckets can find a structurally valid conversation that
// `claude --resume` still rejects as "No conversation found" because it belongs
// to a different project.
const CLAUDE_SESSION_PROJECT_DIR = CONTAINER_WORKSPACE_DIR.replaceAll("/", "-");

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
export function readCodexTokenFreshness(file: string): number | null {
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

/**
 * Per-turn sync options.
 *
 * `repairLeakedSubtrees` — run the docs/153 leak repair as part of this sync.
 * Defaults to true; a caller passes **false** when a resident agent process is
 * about to be REUSED rather than respawned. The repair is destructive by
 * nature (unlink `.claude`, re-copy the subtree, merge the orphan, then
 * `rmSync` the orphan root), and doing that under a live CLI is what produced
 * `Not logged in · Please run /login` mid-session (nikzlabs/shipit#1874): the
 * unlink→copy sequence has a real window in which `.claude/.credentials.json`
 * does not exist at all, and if the source subtree is missing the copy never
 * happens and the window never closes.
 *
 * Skipping it costs nothing on a reuse turn. Everything the repair produces is
 * consumed at SPAWN time — the on-disk convergence matters to the next
 * `claude --resume`, and the recovered `agentSessionId` is read by
 * `buildRunParams`, which the reuse branch never calls. The token copy below
 * still runs, because that IS how a long-lived process stays authenticated
 * across a rotation (docs/142 A).
 */
export interface SyncTokenInOptions {
  repairLeakedSubtrees?: boolean;
}

export function syncAgentTokenIn(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): void {
  syncAgentTokenInFromRoot(
    credentialsRoot, sessionId, agentId, credentialsRoot,
    onRecoverAgentSessionId, currentAgentSessionId, opts,
  );
}

export function syncProviderAccountTokenIn(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): void {
  syncAgentTokenInFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    onRecoverAgentSessionId,
    currentAgentSessionId,
    opts,
  );
}

function syncAgentTokenInFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  // docs/153 — repair leaked subtree-root symlinks before the per-turn copy
  // so the orchestrator and the agent container converge on the same
  // physical file. See `materializeLeakedSubtreeSymlinks` for the full why,
  // and {@link SyncTokenInOptions} for why a reuse turn opts out.
  if (opts?.repairLeakedSubtrees ?? true) {
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
  // The per-turn token copy lands `root:root`; re-own it for the worker (docs/150).
  chownSessionCredentialsTree(credentialsRoot, sessionId);
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
  // The repushed token lands `root:root`; re-own it for the worker (docs/150).
  if (wrote) chownSessionCredentialsTree(credentialsRoot, sessionId);
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

/**
 * The `.codex/` equivalent. Codex's resume is **rollout-file-backed**: a
 * durable (`ephemeral: false`) thread materializes
 * `sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl`, and
 * `thread/resume` reads that file. Lose it and the app-server answers
 * `-32600 no rollout found for thread id …` forever, because
 * `sessions.agent_session_id` still points at the vanished thread.
 *
 * Deliberately an allowlist of *state* paths, not the whole subtree: `.codex/`
 * also holds `auth.json` and `config.toml`, which are the **shared
 * authentication/config baseline** the repair just cpSync'd in from the
 * source root. Merging is `force: false` (shared wins on conflict), so even a
 * same-named orphan copy can't clobber the fresh credentials — but keeping
 * them out of the allowlist makes that guarantee structural rather than
 * incidental.
 */
const CODEX_SESSION_STATE_SUBPATHS: readonly string[] = [
  "sessions",
  "archived_sessions",
  "history.jsonl",
];

/**
 * Per-subtree conversation-state allowlist, keyed by the credential-subtree
 * `rel` from {@link AGENT_CREDENTIAL_PATHS}.
 *
 * A `rel` that is a directory and is **absent** from this map is treated as
 * unpreservable by {@link mergeOrphanState}, which fails the merge and so
 * keeps the orphan root on disk. That fail-safe default is the fix for the
 * `.codex` data loss: the repair used to iterate every agent's subtree but
 * only knew how to merge Claude's, so a `.codex` orphan was silently
 * "merged" (a no-op) and then recursively deleted, taking the session's
 * rollouts with it. A future agent's subtree now leaks an orphan dir rather
 * than losing the user's conversation.
 *
 * Exported because the docs/150 account-switch reprovisioning path needs the
 * same allowlist: replacing account A's credential subtree with account B's
 * must not take the session's conversation with it (req 9 — a session keeps
 * its conversation across an account switch). See
 * `removeProviderSubtreeForReplacement` in `session-agent-credentials.ts`.
 * One definition, two consumers — a second hand-maintained copy is exactly
 * how the `.codex` case got missed the first time.
 */
export const SUBTREE_STATE_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  ".claude": CLAUDE_SESSION_STATE_SUBPATHS,
  ".codex": CODEX_SESSION_STATE_SUBPATHS,
};

/** Subtrees under a Codex home that can hold a thread's rollout jsonl. */
const CODEX_ROLLOUT_ROOTS: readonly string[] = ["sessions", "archived_sessions"];

/**
 * Depth bound for the rollout scan. The real layout is
 * `sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` (depth 3); the slack absorbs a
 * CLI layout change without letting a pathological tree turn a per-turn check
 * into an unbounded walk.
 */
const CODEX_ROLLOUT_SCAN_MAX_DEPTH = 5;

/** Anchor for symlink targets authored to point at the volume root. */
const CREDENTIALS_MOUNT_PREFIX = "/credentials/";

/**
 * Result of a single leak-repair pass over a session's credentials dir.
 * Three terminal states:
 *
 *   - `outcome: "no-action"` — no Case fired; caller leaves DB alone.
 *   - `outcome: "recovered"` — a Case fired and a resumable conversation
 *     jsonl was found; `recoveredAgentSessionId` is the id to set.
 *   - `outcome: "clear"` — the session's persisted agent conversation is
 *     not resumable from disk. For Claude that means no resumable
 *     `projects/*\/*.jsonl` (the on-disk state is just stub metadata from
 *     the post-turn flow); for Codex it means no rollout jsonl for the
 *     persisted thread id. Caller must clear the DB pointer so the next
 *     spawn starts a fresh conversation instead of looping on a known-bad
 *     id — and should re-seed it from ShipIt's own transcript
 *     (`buildConversationReplay`), which is unaffected. Only the CLI-side
 *     resume continuity is lost.
 */
type LeakRepairResult =
  | { outcome: "no-action" }
  | { outcome: "recovered"; recoveredAgentSessionId: string }
  | { outcome: "clear" };

/**
 * Token file names *inside* a credential subtree (e.g. `.credentials.json` for
 * `.claude`), derived from {@link AGENT_TOKEN_FILES} so the two lists can't
 * drift. Used by the Case 1/3 merge to rescue a credential the destination
 * lacks, and by the credential-less warning below.
 */
function tokenFileNamesForSubtree(rel: string): string[] {
  const names: string[] = [];
  for (const files of Object.values(AGENT_TOKEN_FILES)) {
    for (const file of files ?? []) {
      // AGENT_TOKEN_FILES entries are credentials-root-relative POSIX paths
      // ("<subtree>/<name>"), so split on "/" rather than path.sep.
      const parts = file.split("/");
      if (parts.length === 2 && parts[0] === rel) names.push(parts[1]);
    }
  }
  return names;
}

/**
 * Session-dir-relative base dirs to look for Case 3 orphans under, in a
 * deterministic order.
 *
 * The orphan is whatever the agent CLI wrote while it followed a leaked
 * symlink in its own (Subpath-mounted) namespace, so its path mirrors the
 * *account root the symlink named at the time it was created* — not the
 * account the session resolves to today. Those diverge whenever the account
 * was renamed or replaced: a symlink authored against the migrated
 * `provider-accounts/claude/claude-default` root leaves an orphan under that
 * name long after the live account root became `acct_<uuid>`. Probing exactly
 * one computed base is why that shape was stranded forever with no credential
 * and no log line — `existsSync` on the computed path simply returned false
 * and the repair read it as a healthy no-op.
 *
 * So: keep the computed base (it is the most likely match, and covers source
 * roots the scan below can't see), then add every *other* account dir actually
 * present under `<sessionDir>/provider-accounts/<agentId>/`, sorted by name so
 * several stale dirs are handled in a fixed order rather than readdir order.
 *
 * Discovery never leaves the session dir: entries come from a single
 * `readdirSync` of a path under `sessionDir`, symlinked entries are skipped
 * (`isDirectory()` is false for a symlink from `withFileTypes`), and a name
 * can't contain a path separator.
 */
function discoverOrphanBases(
  credentialsRoot: string,
  sessionDir: string,
  agentId: AgentId,
  sourceRoot: string,
): string[] {
  // The computed base: "<sourceRoot relative to credentialsRoot>", which is
  // where the agent CLI wrote when it followed the now-removed symlink. Only
  // meaningful when sourceRoot lives under credentialsRoot (the
  // provider-account flow); the legacy `provisionAgentCredentials` path uses
  // sourceRoot === credentialsRoot, where the mirror collapses to dst itself.
  const sourceRelToCredentials = path.relative(credentialsRoot, sourceRoot);
  const expectedBase =
    sourceRelToCredentials
      && sourceRelToCredentials !== ""
      && !sourceRelToCredentials.startsWith("..")
      && !path.isAbsolute(sourceRelToCredentials)
      ? sourceRelToCredentials
      : null;

  const bases: string[] = expectedBase ? [expectedBase] : [];

  const accountsDir = path.join(sessionDir, PROVIDER_ACCOUNTS_SUBDIR, agentId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return bases; // no leaked provider-accounts subtree — nothing to discover
  }
  const discovered = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PROVIDER_ACCOUNTS_SUBDIR, agentId, entry.name))
    .sort();
  for (const base of discovered) {
    if (!bases.includes(base)) bases.push(base);
  }
  return bases;
}

/**
 * The removable root of an orphan at `<sessionDir>/<relBase>/...` — the
 * top-level dir the leak created inside the session dir (in practice
 * `provider-accounts/`). Deliberately coarse: every stale account dir under it
 * shares one root, so ANY merge failure below it keeps the whole tree (the
 * orphan is the only copy of what it holds). Null when `relBase` names no
 * segment inside the session dir.
 */
function orphanRootFor(sessionDir: string, relBase: string): string | null {
  const firstSegment = relBase.split(path.sep)[0] ?? "";
  if (!firstSegment) return null;
  const root = path.join(sessionDir, firstSegment);
  return root === sessionDir ? null : root;
}

/**
 * Merge every orphan for one `rel` into `dst`, in the caller's order, and
 * report the combined outcome. A failure under any orphan marks that orphan's
 * root unsafe, so the cleanup pass keeps the whole tree rather than deleting
 * state it could not preserve.
 */
function mergeOrphans(
  orphans: readonly { path: string; root: string | null }[],
  dst: string,
  rel: string,
  unsafeOrphanRoots: Set<string>,
): OrphanMergeResult {
  const combined: OrphanMergeResult = { preserved: false, failed: false };
  for (const orphan of orphans) {
    if (!fs.existsSync(orphan.path)) continue;
    const merge = mergeOrphanState(orphan.path, dst, rel);
    if (merge.preserved) combined.preserved = true;
    if (merge.failed) {
      combined.failed = true;
      if (orphan.root) unsafeOrphanRoots.add(orphan.root);
    }
  }
  return combined;
}

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
 *   Case 3 — ORPHAN BESIDE A REAL DIR (`.claude/` is a real dir, but
 *     `<sessionDir>/provider-accounts/.../<rel>` still exists). Two known
 *     producers, and the second is the one actually observed in the field:
 *     (a) the pre-#758 destructive repair rm'd the symlink and cpSync'd the
 *     shared baseline but left the orphan tree behind; (b) —
 *     CONFIRMED 2026-08-02 — `migrateProviderDefault` `renameSync`'d a live
 *     agent home into `provider-accounts/<provider>/<accountId>/`, which
 *     produces exactly this shape with no symlink ever involved. See the
 *     addendum in `docs/153-orchestrator-owned-claude-oauth-refresh/plan.md`.
 *     Do not assume a symlink was here; in every observed case there was not
 *     one. The agent now
 *     reads `.claude/` (real dir) which has no `projects/...` for this
 *     session, so `--resume <agentSessionId>` keeps failing with "No
 *     conversation found" until we layer the orphan back on top. Repair:
 *     skip rmSync + skip cpSync from shared (dst already has the shared
 *     baseline); merge orphan content + drop orphan root + recover
 *     agent_session_id.
 *
 *   Case 2 (true no-op) — `.claude/` is a real dir AND no orphan exists.
 *
 *   Case 5 — CODEX STALE THREAD (`.codex/` is a real dir, but the DB's
 *     thread id has no rollout jsonl under `.codex/sessions`). Read-only
 *     detection; see the block near the end of this function.
 *
 * For both repair cases the order is critical: read latest jsonl mtime
 * from the orphan BEFORE any cpSync/merge, since cpSync doesn't preserve
 * mtimes. Then merge with shared-wins-on-conflict for the subtree state
 * paths in {@link SUBTREE_STATE_SUBPATHS} (`.claude/`, `.codex/`) and
 * orphan-wins for `.claude.json` (session-specific CLI config; the shared
 * one is a generic baseline).
 *
 * The orphan root is dropped ONLY after every merge under it succeeded —
 * the orphan is the only copy of the session's conversation state, so a
 * failed or impossible merge leaves it on disk for a later pass (or a
 * human) to rescue.
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
  // Orphan roots whose content could not be fully preserved. Removal is
  // opt-out rather than opt-in: a root lands here the moment any merge under
  // it fails, and roots in this set survive the cleanup pass below. The
  // orphan is the ONLY copy of the session's conversation state, so a failed
  // preservation must never be followed by a recursive delete.
  const unsafeOrphanRoots = new Set<string>();

  // For the post-destructive-repair case below (no symlink, but orphan still
  // present): the orphan lives at a "<sessionDir>/<account root relative to
  // credentialsRoot>" mirror — where the agent CLI wrote when it followed the
  // now-removed symlink in its Subpath namespace. The account dir named by
  // that symlink is not necessarily the one the session resolves to today, so
  // the bases are *discovered*, not computed. See {@link discoverOrphanBases}.
  const orphanBases = discoverOrphanBases(credentialsRoot, sessionDir, agentId, sourceRoot);

  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    const dst = path.join(sessionDir, rel);
    let dstStat: fs.Stats;
    try {
      dstStat = fs.lstatSync(dst);
    } catch {
      continue; // dst doesn't exist — nothing to repair
    }

    // Orphans to layer back onto `dst`, in the deterministic order above. Case
    // 1 contributes at most one (the symlink's own target); Case 3 contributes
    // one per stale account dir that actually holds this `rel`.
    const orphans: { path: string; root: string | null }[] = [];
    let isSymlinkLeak = false;

    if (dstStat.isSymbolicLink()) {
      // ---- Case 1: live symlink leak ----
      isSymlinkLeak = true;
      const target = fs.readlinkSync(dst);
      // Resolve the orphan the symlink points at *inside the agent
      // container's namespace*. Two target shapes are observed in the wild:
      //   - prod: absolute `/credentials/provider-accounts/...` (the literal
      //     volume-mount path on the orchestrator side, baked in by the legacy
      //     alias when credentialsDir = "/credentials"). docs/150 req 19 stopped
      //     creating those aliases and retires them at boot, but a session
      //     provisioned before that still carries the leaked symlink.
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
        orphans.push({
          path: path.join(sessionDir, relativeFromVolume),
          root: orphanRootFor(sessionDir, relativeFromVolume),
        });
      }
    } else {
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
      //
      // Every discovered base is probed, not just the one derived from the
      // currently resolved account: the orphan is named after whichever
      // account root the leaked symlink pointed at, which for a migrated or
      // replaced account is a *different* directory (the docs/153 "stranded
      // with no credential" shape — see {@link discoverOrphanBases}).
      for (const base of orphanBases) {
        const candidateOrphan = path.join(sessionDir, base, rel);
        if (!fs.existsSync(candidateOrphan)) continue;
        orphans.push({ path: candidateOrphan, root: orphanRootFor(sessionDir, base) });
      }
    }

    for (const orphan of orphans) {
      if (orphan.root) orphanRootsToRemove.add(orphan.root);
    }

    if (!isSymlinkLeak && orphans.length === 0) {
      // Case 2 — healthy dir with no orphan. Silent, EXCEPT when the subtree
      // carries no token file at all: that session authenticates on nothing
      // and will fail every turn, and used to do so with no log line anywhere
      // (the incident that motivated the discovery fix above took a container
      // forensics session to find). One greppable line per turn is the cost of
      // never having to do that again.
      const tokenNames = tokenFileNamesForSubtree(rel);
      if (
        tokenNames.length > 0
        && dstStat.isDirectory()
        && !tokenNames.some((name) => fs.existsSync(path.join(dst, name)))
      ) {
        console.warn(
          `[session-credentials] ${sessionDir}: ${rel} has no token file (looked for ${tokenNames.join(", ")}) `
            + `and no orphan to recover one from — this session will fail authentication until its credentials `
            + `are reprovisioned (source root ${sourceRoot})`,
        );
      }
      continue;
    }

    // Recover the agent_session_id from the orphans' `projects/` trees BEFORE
    // any cpSync/merge — cpSync doesn't preserve mtimes, so once we copy the
    // orphan's jsonls into dst the latest-mtime ordering signal is gone.
    // Applies to both Case 1 and Case 3; first orphan (in the deterministic
    // order above) that yields a resumable id wins.
    if (rel === ".claude" && recoveredAgentSessionId === null) {
      for (const orphan of orphans) {
        if (!fs.existsSync(orphan.path)) continue;
        recoveredAgentSessionId = findLatestAgentSessionId(path.join(orphan.path, "projects"));
        if (recoveredAgentSessionId !== null) break;
      }
    }

    const orphanPathsNote = orphans.map((orphan) => orphan.path).join(", ") || null;

    if (isSymlinkLeak) {
      // `recursive: true` is required: Node.js 24.13.0 (the version currently
      // in the GitHub Actions toolcache) throws ERR_FS_EISDIR when fs.rmSync
      // targets a symlink whose target is a directory, even though POSIX
      // unlink would remove the symlink itself. With `recursive: true`, the
      // symlink is removed and the target dir is left untouched (same end
      // state, just doesn't trip the Node 24.13.0 bug).
      fs.rmSync(dst, { force: true, recursive: true });
      const src = path.join(sourceRoot, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true, force: true, dereference: true });
      }
      const merge = mergeOrphans(orphans, dst, rel, unsafeOrphanRoots);
      // Only claim a merge when one actually happened. The unconditional
      // "(orphan merged from …)" note was actively misleading: for `.codex`
      // the merge was a silent no-op, so the log asserted preservation on the
      // very pass that deleted the rollout.
      console.log(
        `[session-credentials] repaired leaked symlink in ${sessionDir}: ${rel}${describeMerge(merge, orphanPathsNote)}`,
      );
    } else {
      // Case 3 — orphan-only recovery; dst already has the shared baseline
      // from the previous destructive repair.
      const merge = mergeOrphans(orphans, dst, rel, unsafeOrphanRoots);
      console.log(
        `[session-credentials] recovered orphaned history in ${sessionDir}: ${rel} (no leaked symlink, but ${orphanPathsNote} present)${describeMerge(merge, orphanPathsNote)}`,
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
      if (unsafeOrphanRoots.has(orphanRoot)) {
        console.warn(
          `[session-credentials] keeping orphan ${orphanRoot}: its conversation state could not be preserved (it is the only copy)`,
        );
        continue;
      }
      try {
        fs.rmSync(orphanRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[session-credentials] failed to drop orphan ${orphanRoot}:`, err);
      }
    }
  }

  // ---- Codex stale-thread detection ----
  //
  // The filesystem repair above is cross-agent (both CLIs can inherit leaked
  // credential symlinks), but the resume *shape* is not, so each agent gets
  // its own staleness probe. Claude's (Case 4, above) reads
  // `.claude/projects/*/*.jsonl`; Codex's reads the rollout tree, and neither
  // signal may be applied to the other agent.
  //
  // Codex fails closed on a bad resume (see `codex-event-handler.ts`), which
  // is correct — a missing rollout is not permission to silently answer in an
  // empty thread. But fail-closed alone leaves a session whose rollout is
  // already gone retrying `thread/resume` on every single turn and erroring
  // every time, with no way out but manual DB surgery. Detecting the missing
  // rollout *before* the spawn converts that permanent loop into one explicit
  // recovery: clear the dead pointer so the next `thread/start` is the only
  // one attempted, and let the caller re-seed the new thread from ShipIt's own
  // visible chat history (`buildConversationReplay`) so it is not contextless.
  // The adapter's fail-closed guarantee is untouched — this path never
  // *reaches* a failing resume.
  // eslint-disable-next-line no-restricted-syntax -- docs/155: Codex-specific CLI-shape recovery, see comment above
  if (agentId === "codex") {
    if (!currentAgentSessionId) return { outcome: "no-action" };
    const dst = path.join(sessionDir, ".codex");
    let isRealDir = false;
    try {
      const stat = fs.lstatSync(dst);
      isRealDir = !stat.isSymbolicLink() && stat.isDirectory();
    } catch { /* no `.codex` yet — nothing to judge */ }
    if (!isRealDir) return { outcome: "no-action" };
    // Runs AFTER the merge loop on purpose: a rollout the repair just restored
    // from an orphan must count as present, so a successful repair suppresses
    // the clear and the session keeps true `thread/resume` continuity.
    //
    // If a merge *failed*, the rollout is still absent here and the pointer is
    // cleared — but the orphan holding it was deliberately kept above, so the
    // raw state survives for a later pass or a human. Unsticking the user
    // (replayed transcript, working turn) beats preserving a resume id whose
    // every use errors.
    if (codexRolloutState(dst, currentAgentSessionId) !== "absent") {
      return { outcome: "no-action" };
    }
    console.log(
      `[session-credentials] clearing stale agent_session_id in ${sessionDir}: .codex (DB pointed at thread ${currentAgentSessionId}, no rollout on disk)`,
    );
    return { outcome: "clear" };
  }
  // eslint-disable-next-line no-restricted-syntax -- docs/155: Claude-specific CLI-shape recovery, see comment above
  if (agentId !== "claude") return { outcome: "no-action" };
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
  const candidate = path.join(
    projectsRoot,
    CLAUDE_SESSION_PROJECT_DIR,
    `${agentSessionId}.jsonl`,
  );
  return fs.existsSync(candidate) && jsonlIsResumableConversation(candidate);
}

/**
 * Outcome of a single orphan merge. Both flags matter and they are not
 * complements:
 *
 *   - `preserved` — at least one piece of conversation state was copied into
 *     `dst`. Gates the "orphan merged" wording in the repair log, which used
 *     to be printed unconditionally and so claimed a merge that never
 *     happened (the `.codex` incident: the log said "orphan merged" ~500ms
 *     before `thread/resume` failed with "no rollout found").
 *   - `failed` — something we *should* have preserved could not be. Gates the
 *     recursive removal of the orphan root: a merge that failed must leave
 *     the source alone, because the orphan is the only copy.
 *
 * `{preserved: false, failed: false}` is the legitimate "nothing of value in
 * the orphan" case — safe to drop, nothing to claim.
 */
interface OrphanMergeResult {
  preserved: boolean;
  failed: boolean;
}

/**
 * Log suffix describing what a merge actually did. Never claims preservation
 * that didn't happen — the log line is the only signal an operator has that
 * the orphan was safe to delete.
 */
function describeMerge(merge: OrphanMergeResult, orphanPath: string | null): string {
  if (!orphanPath) return "";
  if (merge.failed) {
    return merge.preserved
      ? ` (orphan PARTIALLY merged from ${orphanPath}; kept — some state could not be preserved)`
      : ` (orphan NOT merged from ${orphanPath}; kept — nothing could be preserved)`;
  }
  return merge.preserved
    ? ` (orphan merged from ${orphanPath})`
    : ` (orphan at ${orphanPath} held no conversation state)`;
}

/**
 * Move conversation state from an orphan subtree into the freshly
 * materialized destination. Behavior is per-rel:
 *
 *   - For a subtree dir with a {@link SUBTREE_STATE_SUBPATHS} entry
 *     (`.claude/`, `.codex/`): copy those session-state subpaths recursively
 *     without overwriting anything the shared source already provided
 *     (`force: false` ⇒ the fresh auth/config baseline always wins).
 *   - For `.claude.json`: if the orphan version exists and differs from
 *     what the shared source wrote, overwrite dest with the orphan.
 *   - For anything else: refuse. We don't know what carries conversation
 *     state in an unknown subtree, so we report failure and the caller keeps
 *     the orphan rather than deleting state it can't identify.
 */
function mergeOrphanState(orphanPath: string, dstPath: string, rel: string): OrphanMergeResult {
  const stateSubpaths = SUBTREE_STATE_SUBPATHS[rel];
  if (stateSubpaths) {
    const result: OrphanMergeResult = { preserved: false, failed: false };
    for (const sub of stateSubpaths) {
      const orphanSub = path.join(orphanPath, sub);
      if (!fs.existsSync(orphanSub)) continue;
      try {
        fs.cpSync(orphanSub, path.join(dstPath, sub), {
          recursive: true,
          force: false,
          errorOnExist: false,
          dereference: true,
        });
        result.preserved = true;
      } catch (err) {
        result.failed = true;
        console.warn(`[session-credentials] failed to merge orphan ${orphanSub}:`, err);
      }
    }
    // Rescue a token file the destination is MISSING. This is not a widening
    // of "shared wins on conflict" — an existing dst token is never touched,
    // so the fresh baseline still wins whenever there is one to win with. It
    // covers the case where there isn't: a session whose resolved account root
    // no longer exists on the orchestrator (renamed/deleted account) has no
    // source to sync a token in from, and the orphan holds its only copy. The
    // repair is about to delete that orphan, so without this the fix would
    // destroy the very credential it exists to restore. A rescued token is not
    // necessarily the freshest one — the per-turn sync-in still pulls a newer
    // source token over it — but it is the difference between a session that
    // authenticates and one that fails every turn.
    for (const name of tokenFileNamesForSubtree(rel)) {
      const orphanToken = path.join(orphanPath, name);
      const dstToken = path.join(dstPath, name);
      if (!fs.existsSync(orphanToken) || fs.existsSync(dstToken)) continue;
      try {
        fs.mkdirSync(path.dirname(dstToken), { recursive: true });
        fs.cpSync(orphanToken, dstToken, { dereference: true });
        result.preserved = true;
        console.log(
          `[session-credentials] restored missing ${rel}/${name} from orphan ${orphanPath}`,
        );
      } catch (err) {
        result.failed = true;
        console.warn(`[session-credentials] failed to restore ${orphanToken}:`, err);
      }
    }
    return result;
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
      return { preserved: true, failed: false };
    } catch (err) {
      console.warn(`[session-credentials] failed to merge orphan .claude.json from ${orphanPath}:`, err);
      return { preserved: false, failed: true };
    }
  }
  // Unknown subtree — fail closed so the caller keeps the orphan on disk.
  console.warn(
    `[session-credentials] no merge strategy for orphan subtree ${rel} at ${orphanPath}; keeping it rather than deleting unknown state`,
  );
  return { preserved: false, failed: true };
}

/**
 * Whether a Codex thread's rollout jsonl is present under `codexHome`.
 *
 * Tri-state on purpose. `"unknown"` (a directory that exists but can't be
 * read) must NOT be collapsed into `"absent"`: absent is the trigger for
 * clearing `sessions.agent_session_id`, and clearing a *live* thread's
 * pointer on a transient permissions error would throw away a perfectly good
 * conversation. Only a definitively-missing rollout (ENOENT all the way down,
 * or a readable tree with no matching file) reports `"absent"`.
 *
 * Matching is `basename.includes(threadId) && endsWith(".jsonl")` rather than
 * an exact `rollout-<ts>-<id>.jsonl` pattern, so a CLI change to the filename
 * prefix or timestamp format degrades to "found" rather than to a spurious
 * "absent".
 *
 * The one assumption left is that the thread id appears in the rollout's
 * filename at all. If a future CLI drops it, every Codex turn would read as
 * stale and get a transcript replay instead of a resume — degraded, not
 * broken, and loud: the `clearing stale agent_session_id` line would then
 * appear on every turn of every Codex session rather than once.
 */
function codexRolloutState(codexHome: string, threadId: string): "found" | "absent" | "unknown" {
  let sawUnreadableDir = false;

  const walk = (dir: string, depth: number): boolean => {
    if (depth > CODEX_ROLLOUT_SCAN_MAX_DEPTH) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") sawUnreadableDir = true;
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (walk(path.join(dir, entry.name), depth + 1)) return true;
      } else if (entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        return true;
      }
    }
    return false;
  };

  for (const root of CODEX_ROLLOUT_ROOTS) {
    if (walk(path.join(codexHome, root), 0)) return "found";
  }
  return sawUnreadableDir ? "unknown" : "absent";
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
 * Walk `<projectsRoot>/-workspace/*.jsonl`, keep only files that pass
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
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(
      path.join(projectsRoot, CLAUDE_SESSION_PROJECT_DIR),
      { withFileTypes: true },
    );
  } catch {
    return null;
  }
  const projectDir = path.join(projectsRoot, CLAUDE_SESSION_PROJECT_DIR);
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const full = path.join(projectDir, file.name);
    try {
      const mtimeMs = fs.statSync(full).mtimeMs;
      candidates.push({ path: full, mtimeMs });
    } catch { /* ignore — race with another writer */ }
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
 * Absolute paths of a session's rotating-token files — the exact set
 * {@link syncAgentTokenBack} would consider writing back. Exposed so the
 * mid-turn publisher (docs/153) can watch precisely those files without
 * duplicating the per-agent layout table. Paths are returned whether or not
 * they exist yet; a token file is created by the sync-in on the first turn.
 */
export function agentTokenFilePaths(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): string[] {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return [];
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  return files.map((rel) => path.join(sessionDir, rel));
}

/**
 * Does the session hold a strictly fresher token than the orchestrator source?
 *
 * Pure read, and deliberately the same comparison {@link syncAgentTokenBack}
 * uses for its write guard — exposed so a caller can cheaply answer "would
 * calling the sync-back write anything?" without calling it. The mid-turn
 * publisher (docs/153) needs that: the agent CLI rewrites `.credentials.json`
 * for reasons other than an OAuth rotation (the `mcpOAuth` key churns), so
 * every file-change event would otherwise drive a sync-back whose copy is
 * guarded away but whose trailing `chownSessionCredentialsTree` is not.
 *
 * This is a *pre*-check, never a replacement: the authoritative guard stays
 * inside the sync-back, so a race between this read and the write can only
 * cost a redundant call, never a stale-token clobber.
 */
export function sessionTokenIsAheadOfSource(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId?: string,
): boolean {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return false;
  const sourceRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, agentId, accountId)
    : credentialsRoot;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const sessionFile = path.join(sessionDir, rel);
    if (!fs.existsSync(sessionFile)) continue;
    const sessionExp = freshness(sessionFile);
    if (sessionExp === null) continue; // can't prove it's newer
    const sourceFile = path.join(sourceRoot, rel);
    const sourceExp = fs.existsSync(sourceFile) ? freshness(sourceFile) : null;
    if (sourceExp !== null && sessionExp <= sourceExp) continue;
    return true;
  }
  return false;
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
  // Back-sync writes the orchestrator's own copy, but keep the session subtree's
  // ownership consistent for the worker after any in-place edits (docs/150).
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}
