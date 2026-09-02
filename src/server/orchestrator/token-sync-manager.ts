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
 * A reader that cannot answer is not the same as a file with nothing to lose —
 * see {@link TokenFreshnessReading} for the tri-state that separates them, and
 * `token-freshness-guard.test.ts` for the fixtures that keep every declared
 * reader honest against the file its CLI really writes (planning#449).
 *
 * This module also owns the docs/153 leaked-subtree-symlink repair, which the
 * sync-in / repush paths run before the per-turn copy so the orchestrator and
 * the agent container converge on the same physical file.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import {
  CONTAINER_WORKSPACE_DIR,
  STRANDED_CREDENTIAL_MARKER,
  isStrandedCredentialOf,
} from "../shared/fs-constants.js";
import { PROVIDER_ACCOUNTS_SUBDIR, providerAccountCredentialRoot } from "./provider-account-manager.js";
import { probeNestedString } from "./agents/agent-auth-base.js";
import { readXaiTokenFreshnessFile } from "./agents/grok/auth-manager.js";
import {
  AGENT_CREDENTIAL_PATHS,
  chownSessionCredentialsTree,
  perSessionCredentialsDir,
  readSessionAccountMarker,
  subtreeBorrowInFlight,
  writeSessionAccountMarker,
} from "./session-credentials-scaffold.js";

/**
 * Token files (relative to the credentials root) that carry the rotating OAuth
 * token — distinct from {@link AGENT_CREDENTIAL_PATHS} (the full provisioned
 * subtree). Only these are synced per-turn, so the CLI's other in-place writes
 * (Claude: history/projects/settings under `.claude`; Codex: `config.toml`
 * under `.codex`) are never clobbered.
 */
/**
 * Why the planning#448 grok defect — a CLI's refresh REPLACING the symlink
 * ShipIt handed it, so the watched path never moves and cleanup deletes the
 * only live copy — cannot occur for the other three. Established 2026-08-23;
 * written down so the next reader does not re-derive it.
 *
 * The hazard needs a symlink AT THE RENAMED PATH. `rename(2)` does not follow a
 * symlink on its destination, so it swaps the link itself for a regular file. A
 * symlink one level UP — at the directory — is untouched by a rename of a file
 * inside it, because both the temp name and the final name resolve through the
 * same link into the same real directory.
 *
 * That is the whole difference. The session-worker image links each harness's
 * credential root as a DIRECTORY (`~/.claude`, `~/.codex`,
 * `~/.local/share/opencode`, `~/.grok` — see {@link AGENT_CREDENTIAL_PATHS}),
 * and every token file below sits inside one as a real file. Grok was the sole
 * exception, and not because of the image: its adapter builds a throwaway
 * `GROK_HOME` per turn and linked `auth.json` itself, file to file.
 *
 *  - **claude** — token at `~/.claude/.credentials.json`, inside the directory
 *    link. Structurally safe whatever the CLI does. Measured anyway, because
 *    `~/.claude.json` IS handed over as a file link: `claude` 2.1.232 resolves
 *    the link and renames onto the TARGET (probe: the link survived, the target's
 *    inode changed), so even the file-linked path stays current. That last part
 *    is CLI behaviour rather than a syscall guarantee — but `.claude.json` is
 *    config, not a token, so a future CLI that stopped doing it would cost
 *    onboarding state and not a login.
 *  - **codex** — token at `~/.codex/auth.json`, inside the directory link, and
 *    the CLI writes THROUGH a file link besides (probe: `codex login
 *    --with-api-key` onto a symlinked `auth.json` left the link in place and
 *    updated the target).
 *  - **opencode** — nothing to lose: every ShipIt-routed OpenCode mode is
 *    authenticated by a string key in the spawn env (docs/272-opencode-inference
 *    §2), so no supported run consumes or rotates file auth, which is why this
 *    table has no `opencode` row. Its own writer is a plain `writeFile` with no
 *    rename (`Auth.set` → `FileSystem.writeJson`, read out of the pinned
 *    binary), so a link would survive one anyway. **Reopening condition** —
 *    and note it is about USE, not about this table: the day a file-backed
 *    login becomes routable (the CLI already carries a console device-code
 *    OAuth flow with refresh handling, listed as follow-up in that doc), a
 *    rotating token lives in `~/.local/share/opencode/auth.json` and needs a
 *    row here, a {@link TOKEN_FRESHNESS} reader, and a
 *    `token-freshness-guard.test.ts` fixture. The directory link keeps it safe
 *    from the rename half, not from the rotation half. Provisioning is already
 *    willing to carry such a file — `copyCredentialPath` copies the whole
 *    declared `.local/share/opencode` directory if one exists — so "no file is
 *    provisioned" is a fact about the current routing, not an invariant the
 *    code enforces.
 */
export const AGENT_TOKEN_FILES: Partial<Record<AgentId, readonly string[]>> = {
  claude: [".claude/.credentials.json", ".claude/credentials.json", ".claude/auth.json"],
  codex: [".codex/auth.json"],
  // planning#435 — Grok's subscription login, and the reason docs/274 req 13
  // exists as a separate requirement from req 12. The access token lives ~6
  // HOURS with a refresh token beside it, which is short enough that an ordinary
  // working session outlives one: a write-once copy would 401 mid-turn, and the
  // rotation the CLI then performs would be stranded in the session's own copy
  // where the next container never sees it. Declaring the file here is what puts
  // grok on the same per-turn sync-in / publish-back path Claude and Codex use.
  //
  // planning#448 — declaring the file is not enough on its own. The session
  // adapter's throwaway GROK_HOME *symlinks* auth.json at this path, and the
  // CLI's refresh is an atomic rename onto $GROK_HOME/auth.json, which replaces
  // the symlink with a regular file. The rotation then lives only in the
  // throwaway root, this path never moves, and publish-back is a no-op. The
  // adapter copies a replaced file back onto this path (freshness-guarded)
  // before deleting the throwaway home, which is what makes the declaration
  // actually observe a grok rotation.
  //
  // Only `auth.json` — NOT the rest of `.grok`, which holds config.toml,
  // sessions and logs the CLI writes in place and must never be clobbered.
  grok: [".grok/auth.json"],
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
 * null when the file is missing, unparseable, or carries no expiry.
 *
 * What null then MEANS is decided by {@link classifyTokenFreshness}, not here:
 * a null on a file that is nonetheless a credential reads as `unorderable` and
 * stops the guards from overwriting it, because that is what a reader which has
 * stopped matching its CLI looks like (planning#449).
 *
 * **Numeric only, deliberately** — the two tolerances the sibling readers carry
 * were both investigated for Claude and both rejected (planning#495):
 *
 *   - **A JWT `exp` claim**, of the kind {@link readCodexTokenFreshness} needs.
 *     Claude's access token is an opaque `sk-ant-oat…` bearer, not a JWT, so
 *     there is no claim to read.
 *   - **An ISO-8601 string expiry**, the shape variant that broke grok's first
 *     reader on every real file. Every captured Claude credential writes epoch
 *     ms (see the fixture provenance in `token-freshness-guard.test.ts`), and
 *     `Date.parse` is not the free insurance it looks like: it reads `"0"` as
 *     the year 2000 and accepts locale strings, so a malformed live credential
 *     would come out `ordered` at a fabricated timestamp instead of safely
 *     `unorderable`. It would also silently diverge from
 *     `ClaudeOAuthRefresher.readClaudeExpiresAt`, which is numeric-only — two
 *     readers of one file disagreeing is the hazard this subsystem keeps
 *     paying for. If Claude ever does ship a string expiry, the fix is one
 *     strict reader shared by both, not a lenient branch here.
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
 * Has the Claude CLI BLANKED this credential — rewritten it with its OAuth
 * tokens emptied (`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,…}}`)?
 *
 * That is what the CLI writes when asked to refresh with a grant the OAuth
 * server has already spent, which is the ordinary consequence of a sibling
 * session rotating the shared account token first (docs/153). The file still
 * parses as a credential and still carries the `claudeAiOauth` key — it just
 * holds no bearer at all.
 *
 * It matters here because the two facts {@link TokenFreshnessReading} separates
 * are "the reader broke" and "there is nothing to protect", and a blanked file
 * is emphatically the second: `expiresAt: 0` fails the reader's `> 0` test, so
 * without this probe a blanked session copy reads as `unorderable` and the
 * sync-in refuses, forever, to hand that session the account's live token. The
 * session is then wedged with an empty credential and no way back — observed in
 * production 2026-09-02, as a `refused-copy` and a `stranded-rotation` line two
 * seconds apart on one session whose CLI had 401'd two minutes earlier.
 *
 * Emptiness is judged on the TOKENS, never on `expiresAt` alone: a file with a
 * live `accessToken` and an expiry this reader cannot parse is the planning#449
 * state and must stay `unorderable`. Only a credential with no access token AND
 * no refresh token anywhere is declared to hold nothing.
 *
 * "Anywhere" is load-bearing, and the reason it delegates to
 * `probeNestedString` rather than reading four fields inline. Claude's schema
 * has varied across CLI versions — `extractAccessToken`
 * (`agents/claude/auth-manager.ts`) probes `accessToken`/`access_token` at the
 * TOP level as well as inside `claudeAiOauth`, and takes the first non-empty
 * hit. A probe that looked only at the nested pair would call a file blank
 * while a live top-level bearer sat in it, and an `a ?? b` over the pair would
 * do worse still: `""` is not nullish, so an empty `accessToken` beside a live
 * `access_token` short-circuits to the empty one. Both mistakes fail in the
 * dangerous direction. A missed blank merely leaves a file `unorderable`, which
 * is where it was before this existed; a wrongly-declared blank licenses an
 * overwrite — and on the spawn-home and borrow cleanup paths
 * (`syncSubAgentSpawnHomeTokenBack`, `preserveBorrowedTokensBeforeWipe`) an
 * `absent` reading skips the quarantine and the caller then deletes the only
 * copy. So the predicate is deliberately conservative: any non-empty token, at
 * either level, under either alias, defeats it.
 *
 * Takes `unknown` because its callers hand it whatever `JSON.parse` returned,
 * and `JSON.parse("null")` is a valid parse whose property access throws.
 *
 * Shared with `agents/claude/oauth-refresher.ts`, which names the same shape in
 * its `missing_credentials` diagnosis. One predicate, two consumers — a second
 * hand-rolled copy is how a reader and a probe come to disagree about the same
 * file.
 */
export function isBlankedClaudeCredential(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  // The `claudeAiOauth` object is the anchor: it is the shape the CLI actually
  // blanks, and requiring it keeps a file this probe has not been taught on the
  // safe side of the tri-state rather than the overwritable one.
  const oauth = o.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return false;
  return probeNestedString(o, ["accessToken", "access_token"], "claudeAiOauth") === null
    && probeNestedString(o, ["refreshToken", "refresh_token"], "claudeAiOauth") === null;
}

/**
 * Per-agent probe for "this file is the harness's own logged-out marker, not a
 * credential" — the one thing {@link holdsProtectableCredential}'s otherwise
 * generic test cannot see, because such a file is structurally indistinguishable
 * from a live one.
 *
 * Only Claude has an entry, because only Claude's blanked shape is documented
 * from a real file. A harness with no entry keeps the generic behaviour, which
 * is what every harness had before this existed.
 */
const AGENT_BLANK_CREDENTIAL: Partial<Record<AgentId, (parsed: unknown) => boolean>> = {
  claude: isBlankedClaudeCredential,
};

/**
 * Which copy of a token file is being classified — and therefore whether the
 * blank probe applies to it at all.
 *
 *   - **`replica`** — a session's own copy (or a sub-agent spawn home's). The
 *     orchestrator can rebuild it from the source at any time, so declaring a
 *     blanked one `absent` costs nothing if the judgement is wrong and un-wedges
 *     the session if it is right.
 *   - **`source`** — the orchestrator's flat root or an account root. The only
 *     copy there is, and the one a completing sign-in writes.
 *
 * The split exists because the two sides do not carry the same risk, and
 * docs/153 already decided the source side. It weighed repairing a blanked
 * ACCOUNT root — by deleting it, so a session's rotation could be harvested over
 * it — and rejected it: there is no compare-and-swap here, so a repair that
 * loses a race with a completing sign-in destroys a live credential to save a
 * reconnect the user is already doing. Overwriting a blanked source rather than
 * deleting it narrows that window but does not close it, and "the session's
 * token is live" is not established either — `ordered` means a parseable
 * positive expiry, which a revoked token also has.
 *
 * That is a decision a human made about a state this incident did not involve,
 * so it stands. planning#495 is about the REPLICA: the CLI blanks a session's
 * copy too, and there the refusal wedged the session out of ever receiving a
 * working token again.
 */
type TokenFileRole = "replica" | "source";

/**
 * "Freshness" (epoch ms) of a Codex `auth.json` — a strictly larger value means
 * a more-recently-refreshed token. Codex writes no plain `expiresAt`, so we
 * read, in order: an explicit `expires_at`/`expiresAt` if a future CLI adds
 * one; else the access/id-token JWT `exp` claim (advances on every refresh);
 * else the `last_refresh` ISO timestamp. Returns null when none is parseable;
 * {@link classifyTokenFreshness} decides what that null means for the guards.
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
 *
 * Exported for the guard test in `token-freshness-guard.test.ts`, which runs
 * every reader in this table against a committed REAL-shape credential file.
 * A reader that has quietly stopped matching the file its CLI writes returns
 * null on every real file and is otherwise invisible (planning#449) — the
 * fixture is what turns that into a red build. A new harness joining
 * {@link AGENT_TOKEN_FILES} needs a reader here AND a fixture there.
 */
export const TOKEN_FRESHNESS: Partial<Record<AgentId, (file: string) => number | null>> = {
  claude: readClaudeTokenExpiry,
  codex: readCodexTokenFreshness,
  // Imported rather than re-implemented: the auth manager already parses this
  // file's scope-keyed shape for the identity and plan, and two parsers of one
  // format are how the guards come to disagree about which copy is newer.
  grok: readXaiTokenFreshnessFile,
};

/**
 * What a freshness reader was able to say about ONE token file.
 *
 * The tri-state exists because `null` collapsed two facts that call for
 * opposite actions (planning#449):
 *
 *   - **`absent`** — nothing here to protect. The file is missing, empty, not a
 *     JSON object at all, or the harness's own LOGGED-OUT marker
 *     ({@link AGENT_BLANK_CREDENTIAL}) — so overwriting it destroys no
 *     credential and the sync-in copy proceeds exactly as it always has.
 *   - **`unorderable`** — the file IS a structurally valid credential and the
 *     reader could not find a freshness signal in it. That is what a renamed
 *     field, a changed encoding, or a new layout looks like: grok's live
 *     `auth.json` writes `expires_at` as an ISO-8601 **string** where the first
 *     reader accepted only epoch numbers, so it returned null on every real
 *     file. Treated as the dangerous reading — never overwrite it, and say so
 *     loudly.
 *   - **`ordered`** — the reader answered; the guards compare `at`.
 *
 * The distinction matters because the sync-in guard is deliberately "copy
 * unless proven unnecessary" (docs/142 A: a session must start from the
 * freshest token, and a session with no token at all must get one). Under a
 * plain null that direction cannot tell "this session has nothing worth
 * keeping" from "this reader has stopped working", and picks the answer that
 * clobbers a just-refreshed rotating token with a staler source copy — which
 * the CLI has already invalidated upstream. The direction is unchanged for the
 * first case and inverted only for the second.
 */
export type TokenFreshnessReading =
  | { kind: "ordered"; at: number }
  | { kind: "unorderable" }
  | { kind: "absent" };

/**
 * Is there a credential here that overwriting would destroy?
 *
 * Deliberately generic and shallow: every file in {@link AGENT_TOKEN_FILES} is
 * JSON today, so "parses as a non-empty JSON object" is very nearly the whole
 * test. It answers the only question the guards ask — "could a CLI have written
 * this?" — without a second per-agent parser deciding which copy is newer,
 * which is how two readers of one format come to disagree. A future harness
 * whose credential is not JSON needs its own probe here; until it has one, its
 * file reads as `absent` and stays overwritable, which is what every file was
 * before this existed.
 *
 * The one per-agent exception is {@link AGENT_BLANK_CREDENTIAL}, applied to a
 * `replica` only, and it does not reopen that hazard: it answers "is there a
 * bearer in here", never "which copy is newer", so it cannot disagree with a
 * freshness reader about an ordering. It exists because a harness's own
 * LOGGED-OUT file parses exactly like a live one, so the generic test says
 * "credential" about a file that holds nothing — and a session protected from
 * being overwritten by a token it does not have is a session that never
 * authenticates again.
 */
function holdsProtectableCredential(agentId: AgentId, role: TokenFileRole, file: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return false; // missing, unreadable, or not JSON — nothing to preserve
  }
  // An array is excluded deliberately: `Object.keys(["x"]).length` is 1, so a
  // JSON array would otherwise read as a credential on its indices alone.
  // No agent writes one, and none of the readers would understand it.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length === 0) return false;
  if (role === "source") return true; // see {@link TokenFileRole}
  return !(AGENT_BLANK_CREDENTIAL[agentId]?.(record) ?? false);
}

/** Read one token file through its agent's reader and classify the answer. */
function classifyTokenFreshness(
  agentId: AgentId,
  role: TokenFileRole,
  read: (file: string) => number | null,
  file: string,
): TokenFreshnessReading {
  if (!fs.existsSync(file)) return { kind: "absent" };
  const at = read(file);
  if (at !== null) return { kind: "ordered", at };
  return holdsProtectableCredential(agentId, role, file) ? { kind: "unorderable" } : { kind: "absent" };
}

/**
 * One COUNTABLE line whenever a freshness reader met a credential it could not
 * order, in the shape {@link logWriteBackOutcome} established.
 *
 * Logged on EVERY occurrence rather than once per process, matching the
 * write-back refusals: each line is a rotation that did not move, so the count
 * is the measurement. A healthy reader never prints one — source and session
 * hold the same shape, so either both order or neither file exists. A stream
 * of them says the reader has stopped matching what its CLI writes, which is
 * the failure this whole tri-state exists to make visible.
 */
function logUnorderableToken(
  outcome: "refused-copy" | "skipped-copy" | "stranded-rotation" | "refused-publish",
  fields: { sessionId: string; agentId: AgentId; direction: "sync-in" | "sync-back"; file: string },
  prose: string,
): void {
  console.warn(
    `[session-credentials] token-freshness=unorderable outcome=${outcome} session=${fields.sessionId} `
      + `agent=${fields.agentId} direction=${fields.direction} file=${fields.file} — ${prose}`,
  );
}

/** The same closing advice on every unorderable line — the reader, not the file, is the suspect. */
const UNORDERABLE_HINT =
  "the file parses as a credential but carries no freshness signal this reader recognizes, "
  + "which is what a renamed field or a changed encoding looks like — re-check the reader "
  + "against a REAL captured credential file (docs/266-harness-integration-recipe)";

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

/**
 * Where the AGENT CONTAINER will actually read `<sessionDir>/<rel>`.
 *
 * Normally that is just `<sessionDir>/<rel>`. But a session provisioned before
 * docs/150-multiple-provider-subscriptions req 19 can carry a *leaked subtree-root symlink* — `<sessionDir>/.claude`
 * pointing at an absolute `/credentials/provider-accounts/...` path — and that
 * one path resolves to two different physical files:
 *
 *   - **orchestrator** (`credentialsRoot` mounted at its own path): back to the
 *     SHARED account source.
 *   - **agent container** (`<sessionDir>` subpath-mounted at `/credentials`):
 *     to `<sessionDir>/provider-accounts/...`, the session's own orphan copy.
 *
 * Writing "the session's token" through the naive path therefore writes to the
 * source the orchestrator already read it from, while the CLI keeps reading a
 * stale orphan. Worse, the freshness guard sees source and destination as the
 * same file and skips the copy entirely — so the token silently never rotates
 * for exactly the sessions that most need it.
 *
 * That is only masked, not fixed, by the leak repair: a turn that suppresses
 * repair to protect a resident process (docs/179 §4) still has to deliver a
 * rotated token to it. Resolving the destination here is what makes "the
 * per-turn token copy still runs" true rather than aspirational.
 *
 * Returns the naive path unchanged when there is no leak, so the repaired and
 * never-leaked cases are byte-identical to before.
 */
function containerVisibleCredentialPath(
  credentialsRoot: string,
  sessionDir: string,
  rel: string,
): string {
  const naive = path.join(sessionDir, rel);
  const segments = rel.split("/");
  const subtreeRoot = segments[0];
  const rest = segments.slice(1);
  // Only a subtree ROOT (`.claude`, `.codex`) is ever leaked as a symlink; a
  // rel with no nesting has no subtree root to resolve through.
  if (!subtreeRoot || rest.length === 0) return naive;

  let target: string;
  try {
    if (!fs.lstatSync(path.join(sessionDir, subtreeRoot)).isSymbolicLink()) return naive;
    target = fs.readlinkSync(path.join(sessionDir, subtreeRoot));
  } catch {
    return naive; // Missing or unreadable — nothing to resolve through.
  }

  // Same two target shapes `materializeLeakedSubtreeSymlinks` handles: the
  // production `/credentials/...` mount path and the test fixture's
  // `<credentialsRoot>/...` temp path. Both reduce to a path relative to the
  // credentials volume root, which is what `<sessionDir>` maps to in-container.
  let relativeFromVolume: string | null = null;
  if (target.startsWith(CREDENTIALS_MOUNT_PREFIX)) {
    relativeFromVolume = target.slice(CREDENTIALS_MOUNT_PREFIX.length);
  } else if (target.startsWith(`${credentialsRoot}${path.sep}`)) {
    relativeFromVolume = target.slice(credentialsRoot.length + 1);
  }
  if (!relativeFromVolume) return naive;

  return path.join(sessionDir, relativeFromVolume, ...rest);
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
    // Resolve through a leaked subtree symlink so both the freshness compare
    // and the copy land on the file the CLI reads — see
    // {@link containerVisibleCredentialPath}. Identical to `sessionDir/rel`
    // whenever there is no leak.
    const dst = containerVisibleCredentialPath(credentialsRoot, sessionDir, rel);
    // Expiry guard (mirrors syncAgentTokenBack): only pull when the source is
    // strictly newer than the session's current token. Without this, an
    // unconditional copy clobbers a token the session refreshed locally with a
    // staler source — and, when the source itself is stale/dead, propagates
    // that dead token into every session (which is what uniformly broke
    // sessions, naming included, while the orchestrator token was expired).
    // Skip only when we can prove the session token is already as fresh or
    // fresher; copy on a missing/corrupt/older session token. (docs/142 A)
    //
    // planning#449 — "corrupt" is where that used to fail unsafe. A reader that
    // returns null on a session file which IS a credential is not evidence that
    // the copy is safe; it is evidence that the reader stopped working, and the
    // copy it licensed destroys a token the CLI had just rotated. See
    // {@link TokenFreshnessReading}: `absent` still copies, `unorderable` does
    // not.
    const dstReading = classifyTokenFreshness(agentId, "replica", freshness, dst);
    if (dstReading.kind === "unorderable") {
      logUnorderableToken(
        "refused-copy",
        { sessionId, agentId, direction: "sync-in", file: dst },
        `refusing to copy ${src} over the session's own credential: ${UNORDERABLE_HINT}`,
      );
      continue;
    }
    if (dstReading.kind === "ordered") {
      const srcReading = classifyTokenFreshness(agentId, "source", freshness, src);
      if (srcReading.kind === "unorderable") {
        // The mirror signal: the SOURCE is the file we cannot order. Nothing is
        // at risk (we skip, as a null source expiry always did), but a rotation
        // the orchestrator holds is not reaching this session, and silence is
        // how that goes unnoticed for months.
        logUnorderableToken(
          "skipped-copy",
          { sessionId, agentId, direction: "sync-in", file: src },
          `not pulling the source token into ${sessionId}: ${UNORDERABLE_HINT}`,
        );
        continue;
      }
      if (srcReading.kind !== "ordered" || srcReading.at <= dstReading.at) continue;
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
  opts?: SyncTokenInOptions,
): boolean {
  return repushAgentTokenFromRoot(
    credentialsRoot, sessionId, agentId, credentialsRoot,
    onRecoverAgentSessionId, currentAgentSessionId, opts,
  );
}

export function repushProviderAccountToken(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): boolean {
  return repushAgentTokenFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    onRecoverAgentSessionId,
    currentAgentSessionId,
    opts,
  );
}

function repushAgentTokenFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
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
  //
  // docs/179 §4 — but NOT under a live CLI. This path runs from the scheduled
  // OAuth refresher and from post-sign-in, neither of which is tied to a turn
  // boundary, so it can fire at any moment including mid-turn. The repair is
  // destructive (unlink → re-copy → merge → `rmSync`), and the CLI re-reads
  // its credentials per request (verified — see the docs/179 plan), so a
  // resident process spanning the window reports itself unauthenticated. The
  // callers pass `repairLeakedSubtrees: false` when the session has a live
  // agent; the token write below still happens, and now lands on the
  // container-visible path even while the leak is left in place.
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

  let wrote = false;
  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    if (!fs.existsSync(src)) continue;
    // Resolve through a leaked subtree symlink — see
    // {@link containerVisibleCredentialPath}. This also makes the non-holder
    // check below ask the right question: whether the file the CLI *reads*
    // exists, not whether the symlink happens to resolve back to the source
    // (which it always does, on the orchestrator side).
    const dst = containerVisibleCredentialPath(credentialsRoot, sessionDir, rel);
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
/**
 * The `.grok/` equivalent (planning#435). Grok resumes with `-r <sessionId>`
 * against its own `sessions/` store under `$GROK_HOME`, so that directory is the
 * conversation state a repair must rescue before dropping an orphan.
 *
 * Deliberately an allowlist of *state*, like the two above: `.grok/` also holds
 * `auth.json` and `config.toml`, which are the shared authentication/config
 * baseline the repair has just copied in from the source root. The merge is
 * `force: false` (shared wins), so even a same-named orphan copy could not
 * clobber the fresh credential — keeping them out of the list makes that
 * structural rather than incidental.
 */
const GROK_SESSION_STATE_SUBPATHS: readonly string[] = ["sessions"];

export const SUBTREE_STATE_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  ".claude": CLAUDE_SESSION_STATE_SUBPATHS,
  ".codex": CODEX_SESSION_STATE_SUBPATHS,
  ".grok": GROK_SESSION_STATE_SUBPATHS,
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
      //     alias when credentialsDir = "/credentials"). docs/150-multiple-provider-subscriptions req 19 stopped
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
      //
      // **Only for an ACCOUNT-scoped flow** (planning#435). "No token file" is a
      // defect when the session is pinned to a subscription account and a
      // perfectly ordinary state when it is not: a key-billed session's
      // credential travels as an environment variable and NOTHING is ever
      // written to its credential subtree — which is provisioned as an empty
      // directory regardless, because a dangling symlink kills the CLI at
      // startup (planning#444). Warning there would tell every key-billed grok
      // and Codex turn that it "will fail authentication" while it works fine,
      // and a warning that cries wolf on the common path is how the real one
      // stops being read. `sourceRoot !== credentialsRoot` is exactly the
      // account-scoped case — `syncProviderAccountTokenIn` resolves an account
      // root, the plain path passes the credentials root through unchanged.
      const tokenNames = tokenFileNamesForSubtree(rel);
      if (
        tokenNames.length > 0
        && sourceRoot !== credentialsRoot
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
    const sessionReading = classifyTokenFreshness(agentId, "replica", freshness, sessionFile);
    if (sessionReading.kind !== "ordered") continue; // can't prove it's newer
    const sourceFile = path.join(sourceRoot, rel);
    const sourceReading = classifyTokenFreshness(agentId, "source", freshness, sourceFile);
    // An unorderable source is one the sync-back refuses to overwrite
    // (planning#449), so promising a write here would send the publisher into a
    // call that can only decline.
    //
    // Silent on purpose, and the reason is verifiable rather than assumed: this
    // runs per file-change event, while the turn-end sync-back that logs the
    // same fact is UNCONDITIONAL — `finalizeSessionAgentEnvironment`
    // (`session-agent-env.ts`) calls it whatever this pre-check answered, as do
    // the non-turn and sub-agent publishers. So the refusal is reported once
    // per turn instead of once per write the CLI makes during it.
    if (sourceReading.kind === "unorderable") continue;
    if (sourceReading.kind === "ordered" && sessionReading.at <= sourceReading.at) continue;
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
export function syncAgentTokenBack(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  opts?: ProviderTokenWriteBackOptions,
): void {
  // planning#445 — the marker is written after the borrow's copy lands, so for an
  // instant the subtree holds the borrowed account's bearer under the session's
  // own (or no) marker. A session-route caller refuses for the whole borrow
  // instead of trusting the marker alone; the borrow's own write-back passes no
  // `sessionOwnRoute` and is unaffected, since it is publishing to the very
  // account whose copy is on disk.
  if (opts?.sessionOwnRoute === true && subtreeBorrowInFlight(sessionId, agentId)) {
    logWriteBackOutcome(
      "refused",
      { sessionId, agentId, target: "flat-root", holder: undefined, reason: "borrow-in-flight" },
      `refusing ${agentId} token write-back for ${sessionId} to the flat root: `
        + `the subtree is lent to a sub-agent`,
    );
    return;
  }
  // The same identity-before-ordering rule as the account write-back below, in
  // the direction that looks like it cannot be wrong and is worse when it is: a
  // session on a reserved/legacy route still gets same-harness background work,
  // and that work routes to an ACCOUNT independently of the session. Its borrow
  // leaves an account's bearer in a subtree whose route is flat, and this
  // write-back would publish it to the flat root — which is not just one more
  // wrong copy. `<credentialsRoot>/.claude/.credentials.json` is exactly the
  // marker `migrateProviderDefault` reads as "this install has pre-account
  // credentials", so the next boot would mint a whole extra `claude-default`
  // account row holding a duplicate of a real account's token, and the
  // duplicate quarantine would then demand a reconnect of both.
  const holder = readSessionAccountMarker(credentialsRoot, sessionId)[agentId];
  if (holder !== undefined) {
    logWriteBackOutcome(
      "refused",
      { sessionId, agentId, target: "flat-root", holder, reason: "subtree-holds-account" },
      `refusing ${agentId} token write-back for ${sessionId} to the flat root: `
        + `the subtree holds account ${holder}`,
    );
    return;
  }
  syncAgentTokenBackToRoot(credentialsRoot, sessionId, agentId, credentialsRoot);
}

/**
 * The account write-back, refusing any publication the subtree does not own.
 *
 * The freshness guard inside orders two tokens; it cannot tell whose they are.
 * That is enough while a session's subtree only ever holds its own account's
 * copy — and it stops being true the moment a same-harness consult BORROWS the
 * subtree for another account (`provisionSubAgentCredentials`, and see its
 * docstring for the whole shape). During that window every caller here is still
 * pointed at the session's own account while the file holds the borrowed one's
 * bearer, and "the borrowed token is newer" is the normal case — a freshly
 * reconnected account has the latest expiry there is. The write then copies one
 * account's credential into another account's root, and both accounts are
 * afterwards authenticating as the same subscription.
 *
 * So identity is checked before ordering: the subtree's own marker says whose
 * copy is on disk, and a write-back may only publish to that account.
 *
 * A marker that names a DIFFERENT account is always a refusal. A marker that
 * names NOTHING is the ambiguous case, and treating it as a refusal outright
 * was itself an incident (planning#445): a rotation refused is a rotation
 * DROPPED, and the token it was carrying has already invalidated the source's
 * copy upstream, so the account dies — the refresher then fails every tick,
 * the CLI eventually erases the source file, and the user is made to sign in
 * again. So absence is resolved rather than assumed, and only two readings
 * exist:
 *
 *   - **A borrow is in flight** ({@link subtreeBorrowInFlight}). The subtree is
 *     lent out, so nothing in it is the session's to publish — an absent marker
 *     there is a flat-route borrow saying exactly that. Refuse; and a
 *     session-route caller refuses for the WHOLE borrow whatever the marker
 *     says, because the borrow writes its marker after its copy lands and a
 *     failed provision can leave that gap open indefinitely.
 *   - **No borrow is in flight, and the caller is publishing the SESSION'S OWN
 *     turn route** (`sessionOwnRoute`, set only by the turn-end sync-back and
 *     the mid-turn publisher, both armed from the route the turn resolved).
 *     Then the copy on disk is that account's — an account-routed turn cannot
 *     have spawned otherwise — and the missing marker is the defect, not the
 *     subtree. Repair it and publish.
 *
 * Note what this does NOT relax: a borrowed account's marker still names that
 * account, so `holder !== accountId` refuses it exactly as before, and a
 * borrow's own write-back (which passes no `sessionOwnRoute`) can never repair
 * its way into another account's root.
 */
export interface ProviderTokenWriteBackOptions {
  /**
   * The caller's `accountId` is the SESSION'S own resolved turn route, not an
   * account borrowed for a sub-agent. Only such a caller may repair a lost
   * marker; see the refusal rules above.
   */
  sessionOwnRoute?: boolean;
}

/**
 * One COUNTABLE line per write-back outcome that is not an ordinary publish.
 *
 * The prose is unchanged from what these paths have always printed, because an
 * incident was diagnosed by grepping it (`refusing claude token write-back for
 * … the subtree holds no recorded account`) and a runbook that stops matching
 * is worse than no structure at all. The `key=value` prefix is what is new: an
 * operator can count `write-back=repaired` against `write-back=refused
 * reason=…` instead of eyeballing sentences, and `reason` says which of the
 * rules fired rather than leaving it to be inferred from the wording.
 *
 * What a repair count does and does not measure (planning#445): it counts marker
 * losses **that a rotation happened to land on**, which is the population that
 * matters — a lost marker with no rotation behind it costs nothing. A loss
 * whose session simply stops rotating is invisible here and shows up instead as
 * the next turn's `[credentials] <session> account subtree replaced for <id>`
 * heal (`session-agent-env.ts`). Count both to see the whole shape.
 */
function logWriteBackOutcome(
  outcome: "repaired" | "refused",
  fields: { sessionId: string; agentId: AgentId; target: string; holder: string | undefined; reason: string },
  prose: string,
): void {
  console.warn(
    `[session-credentials] write-back=${outcome} session=${fields.sessionId} agent=${fields.agentId} `
      + `target=${fields.target} holder=${fields.holder ?? "none"} reason=${fields.reason} — ${prose}`,
  );
}

export function syncProviderAccountTokenBack(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  opts?: ProviderTokenWriteBackOptions,
): void {
  // A borrow in flight settles the question before the marker is consulted, and
  // in the direction the marker cannot: the borrow writes its marker AFTER its
  // copy lands, so for an instant the subtree holds the borrower's bearer under
  // the session's own marker — and a provisioning failure can leave that state
  // indefinitely. A session-route caller therefore publishes nothing for the
  // duration of a borrow, which is also what makes the missing-marker repair
  // below safe.
  if (opts?.sessionOwnRoute === true && subtreeBorrowInFlight(sessionId, agentId)) {
    logWriteBackOutcome(
      "refused",
      { sessionId, agentId, target: `account:${accountId}`, holder: undefined, reason: "borrow-in-flight" },
      `refusing ${agentId} token write-back for ${sessionId} to account ${accountId}: `
        + `the subtree is lent to a sub-agent`,
    );
    return;
  }
  const holder = readSessionAccountMarker(credentialsRoot, sessionId)[agentId];
  if (holder !== accountId) {
    const repairable = holder === undefined && opts?.sessionOwnRoute === true;
    if (!repairable) {
      logWriteBackOutcome(
        "refused",
        {
          sessionId, agentId, target: `account:${accountId}`, holder,
          reason: holder === undefined ? "no-recorded-account" : "other-account",
        },
        `refusing ${agentId} token write-back for ${sessionId} to account ${accountId}: `
          + `the subtree holds ${holder ?? "no recorded account"}`,
      );
      return;
    }
    logWriteBackOutcome(
      "repaired",
      { sessionId, agentId, target: `account:${accountId}`, holder, reason: "lost-marker" },
      `repairing lost ${agentId} account marker for ${sessionId}: recording ${accountId} `
        + `(the session's own turn route, no borrow in flight) and publishing its rotation`,
    );
    writeSessionAccountMarker(credentialsRoot, sessionId, agentId, accountId);
  }
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
    const sessionReading = classifyTokenFreshness(agentId, "replica", freshness, sessionFile);
    // Missing / empty / not-a-credential: nothing to publish, exactly as a null
    // expiry always meant here.
    if (sessionReading.kind === "absent") continue;
    if (sessionReading.kind === "unorderable") {
      // Can't prove it's newer — don't risk a regression. Unchanged behavior,
      // newly audible: this direction fails SAFE, so a broken reader silently
      // strands every rotation instead of corrupting anything (planning#449).
      logUnorderableToken(
        "stranded-rotation",
        { sessionId, agentId, direction: "sync-back", file: sessionFile },
        `not publishing this session's token to ${sourceRoot}: ${UNORDERABLE_HINT}`,
      );
      continue;
    }
    const sourceFile = path.join(sourceRoot, rel);
    const sourceReading = classifyTokenFreshness(agentId, "source", freshness, sourceFile);
    if (sourceReading.kind === "unorderable") {
      // Same invariant as the sync-in refusal, in the direction that would
      // damage every session at once: a source credential we cannot order may
      // be newer than this session's copy (the refresher writes it too), so
      // publishing over it can bury the live token the whole install shares.
      //
      // What it costs, stated rather than discovered later: for as long as the
      // source stays unorderable, EVERY session's rotation is stranded — this
      // refusal and the `stranded-rotation` one above between them stop the
      // publish loop entirely. That window closes when the reader is fixed
      // (which is what the log line asks for), and `repushAgentToken` remains
      // the unconditional escape hatch a re-auth uses meanwhile (docs/142 A3).
      // The alternative is publishing blind into a file we cannot read, which
      // is planning#449 pointed at the source instead of at one session.
      logUnorderableToken(
        "refused-publish",
        { sessionId, agentId, direction: "sync-back", file: sourceFile },
        `refusing to overwrite the source credential with ${sessionFile}: ${UNORDERABLE_HINT}`,
      );
      continue;
    }
    // source already as fresh or fresher
    if (sourceReading.kind === "ordered" && sessionReading.at <= sourceReading.at) continue;
    atomicCopyFile(sessionFile, sourceFile);
  }
  // Back-sync writes the orchestrator's own copy, but keep the session subtree's
  // ownership consistent for the worker after any in-place edits (docs/150).
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

/**
 * Directory beside a credential root that holds tokens a spawn-home release
 * REFUSED to publish. Deliberately not one of the {@link AGENT_CREDENTIAL_PATHS}
 * entries and not inside one: provisioning copies only the declared paths, so a
 * quarantined bearer is never fanned out into session subtrees or the next
 * spawn home the way a `.claude/.credentials.json.stranded-…` sibling would be.
 */
const STRANDED_TOKEN_SUBDIR = ".shipit-stranded-tokens";

/**
 * How many quarantined artifacts to keep per (target root, token file).
 *
 * Unbounded retention is a slow leak of live bearer tokens: one freshness-reader
 * regression makes every spawn produce another file, forever, and eventually
 * fills the very volume the next quarantine needs. Bounded retention is safe
 * *because* these tokens rotate single-use — each rotation invalidates the one
 * before it, so only the NEWEST stranded copy can still authenticate and the
 * older ones are already dead. A few spares beyond that are for the human doing
 * the post-mortem, not for recovery.
 */
const STRANDED_TOKEN_KEEP = 5;

/**
 * Keep a rotation a cleanup path refused (or failed) to publish, instead of
 * letting the caller's removal destroy it. Returns whether the copy is now
 * durable somewhere the caller's delete cannot reach.
 *
 * A refusal is not a decision that the token is worthless — it is
 * `classifyTokenFreshness` saying it cannot ORDER the two copies (planning#449),
 * which is exactly the state a reader that stopped matching its CLI produces on
 * every file. Refusing and then deleting turns "we could not tell which is
 * newer" into "the newer one is gone", and with a single-use refresh token that
 * is the permanent death of the source credential, not lost work. PR #2514 hit
 * the same shape one cleanup site over — grok's throwaway `GROK_HOME` — and the
 * answer is the same: put the copy somewhere the delete cannot reach and say
 * where. The destination is left untouched; the two can be diffed by hand.
 *
 * The BOOLEAN is the part that matters. A quarantine can itself fail — a full
 * volume, a read-only root — and a caller that deletes anyway on the strength
 * of having *called* this has destroyed the token just the same. Callers whose
 * removal is optional must gate on the return value.
 */
function quarantineTokenCopy(targetRoot: string, rel: string, sourceFile: string): boolean {
  const flat = rel.replaceAll("/", "_");
  // The stamp is not a unique name: two releases for the same account and token
  // path in one millisecond would rename onto each other, and the second would
  // silently replace the first rescued credential. The uuid tail is what makes
  // the name unique; the stamp stays because it is what makes the directory
  // readable, and what {@link pruneStrandedTokens} sorts on.
  const stamped = isStrandedCredential(flat) ? flat : `${flat}${STRANDED_CREDENTIAL_MARKER}${Date.now()}`;
  const quarantined = path.join(targetRoot, STRANDED_TOKEN_SUBDIR, `${stamped}-${randomUUID().slice(0, 8)}`);
  try {
    atomicCopyFile(sourceFile, quarantined);
    fs.chmodSync(quarantined, 0o600);
    console.warn(`[session-credentials] quarantined unpublishable token at ${quarantined}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[session-credentials] failed to quarantine ${sourceFile} at ${quarantined}: ${reason}`);
    return false;
  }
  pruneStrandedTokens(targetRoot, flat);
  return true;
}

/** Does this flattened name already carry a producer's `.stranded-<epoch>` stamp? */
function isStrandedCredential(flat: string): boolean {
  const at = flat.lastIndexOf(STRANDED_CREDENTIAL_MARKER);
  return at >= 0 && isStrandedCredentialOf(flat, flat.slice(0, at));
}

/**
 * Drop all but the newest {@link STRANDED_TOKEN_KEEP} artifacts for one token
 * file. Sorted by name, whose leading `<flat>.stranded-<epoch ms>` orders
 * correctly for every timestamp of the same digit length — true until the year
 * 2286, and a mis-sort costs a spare copy, never the newest one.
 *
 * Best-effort: failing to prune is a disk-space problem, and destroying a
 * rescue to solve one would be the bug this whole path exists to prevent.
 */
function pruneStrandedTokens(targetRoot: string, flat: string): void {
  const dir = path.join(targetRoot, STRANDED_TOKEN_SUBDIR);
  try {
    const mine = fs.readdirSync(dir).filter((n) => n.startsWith(`${flat}${STRANDED_CREDENTIAL_MARKER}`)).sort();
    for (const stale of mine.slice(0, Math.max(0, mine.length - STRANDED_TOKEN_KEEP))) {
      fs.rmSync(path.join(dir, stale), { force: true });
    }
  } catch {
    // Unreadable directory — leave the pile alone.
  }
}

/**
 * Carry an adapter's own quarantine out of a directory that is about to be
 * removed. Returns false if any of them could not be rescued.
 *
 * The grok adapter quarantines a CLI rotation it refused to publish beside its
 * destination, and its destination is `$HOME/.grok/auth.json` — which, for a
 * same-harness sub-agent run, is INSIDE the per-spawn home. So #2514's rescue
 * landed in the one directory `releaseSubAgentSpawnHome` then removes, and the
 * only copy of the rotation died anyway. The refusal is also self-concealing:
 * the declared token file is left holding the PRE-rotation copy, so the publish
 * loop sees nothing to do and reports success.
 *
 * Deliberately keyed on the shared marker rather than on the harness — any
 * adapter that adopts the convention is covered the day it does, and one that
 * does not has no matching files and pays a single `readdir`. Regular files
 * only, and only names carrying a real stamp: this copies its input verbatim
 * into a credential root, so it must not be talked into following a symlink or
 * hauling in whatever else shares the directory.
 */
function rescueAdapterQuarantines(targetRoot: string, rel: string, copyFile: string): boolean {
  const dir = path.dirname(copyFile);
  const base = path.basename(rel);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return true; // no such directory in this copy — the common case
  }
  let allRescued = true;
  for (const entry of entries) {
    if (!isStrandedCredentialOf(entry, base)) continue;
    const found = path.join(dir, entry);
    if (!fs.lstatSync(found, { throwIfNoEntry: false })?.isFile()) continue;
    if (!quarantineTokenCopy(targetRoot, path.join(path.dirname(rel), entry), found)) allRescued = false;
  }
  return allRescued;
}

/**
 * Publish a rotation a same-harness sub-agent spawn left in its ISOLATED
 * per-spawn home (see `provisionSubAgentSpawnHome`) back to the credential root
 * the home was provisioned from — the provider-account root when `accountId` is
 * set, the flat root otherwise.
 *
 * Deliberately marker- and ledger-free, unlike the two session-subtree
 * write-backs above: those need identity checks because the session dir can
 * hold ANY account's copy, while a spawn home holds exactly the copy this
 * function's own `accountId` parameter provisioned into it — the pairing is by
 * construction, enforced by the one caller (`releaseSubAgentSpawnHome`) passing
 * the same value to both. The freshness ordering still applies: a target the
 * refresher (or another session's write-back) moved past the spawn's copy is
 * never regressed, and an unorderable file on either side refuses the copy for
 * the same planning#449 reasons the session paths do. Unlike the session paths,
 * a refusal here is followed by the caller DELETING the only copy — so every
 * refusal (and every failed copy) quarantines first, via
 * {@link quarantineTokenCopy}.
 *
 * **Returns whether the home is safe to delete.** False means at least one
 * rotation is still only in the home: neither published nor quarantined. The
 * caller must then KEEP the home, because deleting it on the strength of having
 * *tried* is the same data loss by a longer route.
 *
 * No chown: the target roots are orchestrator-owned (never container-mounted),
 * and the spawn home is deleted by the caller right after.
 */
export function syncSubAgentSpawnHomeTokenBack(
  credentialsRoot: string,
  sessionId: string,
  spawnHome: string,
  agentId: AgentId,
  accountId?: string,
): boolean {
  const files = AGENT_TOKEN_FILES[agentId];
  // No declared token file ⇒ nothing this harness keeps on disk can rotate, so
  // there is nothing for the caller's `rmSync` to destroy. True for OpenCode
  // today and stated at {@link AGENT_TOKEN_FILES}; a harness that gains a
  // file-based login gains an entry there, and this early return stops
  // applying to it in the same edit.
  if (!files) return true;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const targetRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, agentId, accountId)
    : credentialsRoot;
  let safeToDelete = true;
  for (const rel of files) {
    const spawnFile = path.join(spawnHome, rel);
    if (!rescueAdapterQuarantines(targetRoot, rel, spawnFile)) safeToDelete = false;
    const spawnReading = classifyTokenFreshness(agentId, "replica", freshness, spawnFile);
    if (spawnReading.kind === "absent") continue;
    const targetFile = path.join(targetRoot, rel);
    if (spawnReading.kind === "unorderable") {
      logUnorderableToken(
        "stranded-rotation",
        { sessionId, agentId, direction: "sync-back", file: spawnFile },
        `not publishing this spawn home's token to ${targetRoot}: ${UNORDERABLE_HINT}`,
      );
      if (!quarantineTokenCopy(targetRoot, rel, spawnFile)) safeToDelete = false;
      continue;
    }
    const targetReading = classifyTokenFreshness(agentId, "source", freshness, targetFile);
    if (targetReading.kind === "unorderable") {
      logUnorderableToken(
        "refused-publish",
        { sessionId, agentId, direction: "sync-back", file: targetFile },
        `refusing to overwrite the source credential with ${spawnFile}: ${UNORDERABLE_HINT}`,
      );
      if (!quarantineTokenCopy(targetRoot, rel, spawnFile)) safeToDelete = false;
      continue;
    }
    if (targetReading.kind === "ordered" && spawnReading.at <= targetReading.at) continue;
    try {
      atomicCopyFile(spawnFile, targetFile);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[session-credentials] failed to publish ${spawnFile} to ${targetFile}: ${reason}`);
      if (!quarantineTokenCopy(targetRoot, rel, spawnFile)) safeToDelete = false;
    }
  }
  return safeToDelete;
}

/**
 * The same preservation for the CROSS-harness borrow, whose cleanup wipes the
 * borrowed subtree out of the session's own credentials dir
 * (`removeSubAgentCredentials`) rather than deleting an isolated home.
 *
 * The borrow publishes through `syncAgentTokenBack` / `syncProviderAccountTokenBack`,
 * which carry the marker and ledger identity checks the spawn-home path does not
 * need — and which refuse an unorderable file exactly the same way. The wipe
 * then follows unconditionally, so the borrow had planning#475's bug too: a
 * Codex consult that rotates into a shape the reader cannot order has its
 * `auth.json` refused and then deleted, leaving the source holding a refresh
 * token the CLI already spent.
 *
 * Rather than re-deciding what the publish should have done, this asks the
 * weaker question the caller actually needs answered: **is this copy provably
 * superseded at the target?** Only a strictly-fresher ordered target says yes.
 * Anything else — either side unorderable, target absent, target older — keeps
 * a copy. It runs AFTER the publish, so a successful publish is the ordered
 * case and costs nothing.
 *
 * Unlike the spawn home, the wipe here is NOT optional: leaving a borrowed
 * cross-provider credential in the session subtree is the docs/138 isolation
 * failure the borrow exists to bound, and the restoring reprovision would
 * overwrite it anyway. So this reports nothing — it preserves what it can and
 * the caller wipes regardless.
 */
export function preserveBorrowedTokensBeforeWipe(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId?: string,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const targetRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, agentId, accountId)
    : credentialsRoot;
  const borrowRoot = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const borrowedFile = path.join(borrowRoot, rel);
    rescueAdapterQuarantines(targetRoot, rel, borrowedFile);
    const borrowedReading = classifyTokenFreshness(agentId, "replica", freshness, borrowedFile);
    if (borrowedReading.kind === "absent") continue;
    const targetReading = classifyTokenFreshness(agentId, "source", freshness, path.join(targetRoot, rel));
    const superseded = borrowedReading.kind === "ordered"
      && targetReading.kind === "ordered"
      && borrowedReading.at <= targetReading.at;
    if (superseded) continue;
    quarantineTokenCopy(targetRoot, rel, borrowedFile);
  }
}
