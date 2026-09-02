/**
 * Orchestrator-owned Claude OAuth refresh (docs/153).
 *
 * Previously, every session container's Claude CLI independently refreshed the
 * OAuth access token when it expired. With N sessions sharing one outbound NAT
 * IP, Anthropic's OAuth rate limiter saw a single noisy client and 429'd them
 * en masse. Once the rate limit kicked in, no session could ever refresh — the
 * limiter ledger stayed full because every active session kept re-trying. The
 * surface symptom: every Claude session 401s ~8h after fresh auth and stays
 * stuck until manual re-auth.
 *
 * This module moves refresh ownership to the orchestrator. It schedules
 * proactive refresh ticks well before access-token expiry, runs single-flight
 * (one in-flight refresh per account, no concurrent attempts), and propagates
 * the rotated token to every pinned session via the existing `repushAgentToken`
 * machinery. With one outbound caller instead of N, the rate-limit ledger is no
 * longer in contention.
 *
 * The refresh itself is delegated to the `claude` CLI binary — we do NOT speak
 * Anthropic's OAuth wire directly. The CLI is lockfile-pinned, owned by
 * Anthropic, and tracks any contract changes (endpoint, client_id, request
 * shape, error handling). We just spawn it and observe its file-write to know
 * whether the rotation succeeded.
 *
 * **The orchestrator is not the only refresher, and never was.** docs/153's
 * original design says sessions "never trigger their own refresh" because the
 * orchestrator always wins the race on a 45-minute lead. That reasoning covers
 * a session under a TURN. It stopped covering anything once agent processes
 * became resident: a streaming CLI outlives its turn by hours and refreshes on
 * its own schedule, and Anthropic's refresh tokens are single-use, so such a
 * rotation silently invalidates the copy on the account root. The tick that
 * then spends that copy cannot succeed — and worse, the CLI responds to it by
 * BLANKING the account's credentials file, which the next tick reads as
 * `missing_credentials` and turns into a sign-in prompt. Roughly daily, per
 * account. So every tick begins by HARVESTING (see
 * {@link ClaudeOAuthRefresher.harvestSessionRotations}): if any session pinned
 * to this account holds a token newer than the source, adopt it and treat that
 * as the rotation. Spend nothing until the source is known to be current.
 *
 * See docs/153-orchestrator-owned-claude-oauth-refresh/plan.md.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { killChild } from "../../../shared/kill-child.js";
import type { AgentId } from "../../../shared/types.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import type { RuntimeMode } from "../../app-di.js";
import {
  perSessionCredentialsDir,
  readSessionAccountMarker,
  sessionCredentialsRoot,
} from "../../session-credentials-scaffold.js";
import {
  isBlankedClaudeCredential,
  sessionTokenIsAheadOfSource,
  syncProviderAccountTokenBack,
} from "../../token-sync-manager.js";

/**
 * How far before the encoded `expiresAt` to fire a refresh tick during normal
 * operation. Picked generously — well above any plausible session-side
 * "near expiry" heuristic the CLI might use — so the orchestrator wins the
 * race for a session that is under a turn.
 *
 * It does NOT make sessions stop refreshing, and the original wording here
 * ("sessions never trigger their own refresh") was read as a guarantee for
 * years after it stopped being one. A resident CLI runs on its own clock with
 * no turn in view, so no lead time the orchestrator picks can preempt it; the
 * harvest, not this margin, is what keeps the source current.
 *
 * Bumped from 30→45 min after the first prod deploy: tier 1 (`claude auth
 * status --json`) is read-only by design, so every healthy rotation goes
 * through the generic backoff schedule (~30s+60s+5m+15m of waits between
 * tier-1 noop ticks before tier 2 runs), and the cumulative latency from
 * the first failed tier-1 to a successful tier-2 rotation can exceed the
 * 30-min lead time, leaving a window where the source token has already
 * expired. 45 min gives a comfortable cushion. (docs/153)
 */
const SAFETY_MARGIN_MS = 45 * 60 * 1000; // 45 minutes

/**
 * If `start()` runs against a source whose `expiresAt` is already in the past,
 * fire the first tick after this short delay rather than synchronously, so any
 * other startup work that might also touch the credentials file gets to settle.
 */
const STARTUP_OVERDUE_DELAY_MS = 1_000;

/**
 * Schedule used when a tick fails to rotate. The first failure waits one minute,
 * the next two, etc., up to a 30-minute cap. Reset on a successful rotation or
 * on `auth_complete` (re-auth).
 */
const RATE_LIMIT_BACKOFF_MS: readonly number[] = [
  60_000,           // 1 min
  120_000,          // 2 min
  300_000,          // 5 min
  600_000,          // 10 min
  1_800_000,        // 30 min — and stay here
];

/**
 * Generic backoff used for non-rate-limit failure modes ("unknown failure").
 * Same shape but with a shorter ramp — we want to retry sooner because we don't
 * have a positive 429 signal that says "back off."
 */
const GENERIC_BACKOFF_MS: readonly number[] = [
  30_000,           // 30 sec
  60_000,           // 1 min
  300_000,          // 5 min
  900_000,          // 15 min — and stay here
];

/** Timeout for each CLI subprocess invocation. */
const TIER1_TIMEOUT_MS = 30_000;
const TIER2_TIMEOUT_MS = 60_000;

/** Path inside the per-account credential root that holds the OAuth token. */
const CLAUDE_CREDENTIALS_RELATIVE = path.join(".claude", ".credentials.json");

/**
 * CLI phrases that mean the REFRESH token is dead — the OAuth server evaluated
 * the grant and rejected it, so no amount of retrying will ever rotate again.
 * Only these justify flipping the account to "needs sign-in" and stopping the
 * schedule. Mirrors the Codex refresher's revoked classifier.
 *
 * Deliberately NARROW — this is NOT the session-side auth classifier's broad
 * list. Generic 401 phrases ("unauthorized", "authentication_error",
 * "invalid authentication credentials") describe a dead ACCESS token, which is
 * the *routine pre-refresh state* of every tier-2 run once the token is past
 * expiry: the CLI's first API attempt 401s (captured verbatim in the
 * `--debug api` log), and only then does refresh-on-use fire. When that
 * refresh is merely rate-limited (429), times out, or hits a network blip,
 * the combined output contains those 401 phrases with a perfectly healthy
 * refresh token. Matching them here misclassified every such tick as
 * `revoked` — signing the user out roughly daily and stopping the schedule,
 * while Codex (narrow patterns) never logged out. A genuine revocation always
 * surfaces `invalid_grant` in the debug capture, so nothing is lost.
 */
const TERMINAL_AUTH_FAILURE_PATTERNS = [
  "invalid_grant",
  "invalid_refresh_token",
  "invalid refresh token",
];

/** Sentinel for "no credentials on disk" (file missing or unparseable). */
const NO_EXPIRY = null;

/** Upper bound on a logged CLI-output excerpt. Long enough to name a cause. */
const REASON_MAX_CHARS = 300;

/** Lines worth keeping when excerpting CLI output for a failed tick. */
const FAILURE_SIGNAL_PATTERN =
  /(error|invalid|denied|forbidden|unauthor|rate[ _-]?limit|429|401|403|timeout|refus|fail|expired)/i;

/**
 * Headers whose VALUE is a credential whatever it looks like. Suppressed whole
 * rather than pattern-matched, because the value's shape is the provider's
 * choice: `Basic dXNlcjpwYXNz` is short, base64-padded and matches no token
 * pattern worth writing.
 */
const CREDENTIAL_HEADER_PATTERN =
  /^([ \t>|-]*)(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|anthropic-api-key)(\s*[:=]\s*).*$/gim;

/**
 * Strip anything credential-shaped before a CLI excerpt reaches a log line.
 *
 * The excerpt's source includes the `--debug api` capture, which carries
 * request headers and response bodies — so this is not defence-in-depth, it is
 * the only thing standing between a bearer token and the orchestrator log.
 *
 * Two layers, because neither is sufficient alone. Whole credential-bearing
 * HEADERS are dropped by name, which needs no guess about the value's encoding.
 * Then token shapes are redacted wherever else they appear (a JSON body, a
 * query string): known prefixes, and any opaque run of 24+ credential
 * characters.
 *
 * It is still a filter, not a parser: a short, unprefixed secret in a field
 * nobody enumerated survives it. Treat the excerpt as *likely* clean, not
 * proven clean — which is also why it is capped and never logged in full.
 */
function redactSecrets(text: string): string {
  return text
    .replace(CREDENTIAL_HEADER_PATTERN, "$1$2$3[redacted]")
    .replace(/("[A-Za-z_]*(?:token|secret|key|password|passwd|auth)[A-Za-z_]*"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/\b(bearer|basic)(\s+)\S+/gi, "$1$2[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-+/]{24,}={0,2}/g, "[redacted]");
}

/**
 * A safe, single-line excerpt of what the CLI said on a tick that did not
 * rotate — the field whose absence made the daily-reconnect bug take a day of
 * production forensics to diagnose. `unknown_failure` was logged with a count
 * and nothing else, so four consecutive ticks that each spawned a billable
 * Haiku call and each failed for a knowable reason were indistinguishable in
 * the log from any other failure.
 *
 * Prefers lines carrying a {@link FAILURE_SIGNAL_PATTERN} and takes the LAST
 * few of them: the CLI's own final complaint says more than its banner.
 */
export function summarizeRefreshFailure(combinedOutput: string): string {
  const lines = redactSecrets(combinedOutput)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const signal = lines.filter((line) => FAILURE_SIGNAL_PATTERN.test(line));
  const joined = (signal.length > 0 ? signal : lines).slice(-3).join(" | ").replace(/\s+/g, " ");
  if (!joined) return "no CLI output";
  return joined.length > REASON_MAX_CHARS ? `${joined.slice(0, REASON_MAX_CHARS - 1)}…` : joined;
}

/**
 * Why a source credential carries no usable expiry. `missing_credentials`
 * conflated two states that call for different responses and look identical in
 * a log:
 *
 *   - **`missing`** — no file. The user signed out, or the account was reset.
 *   - **`blanked`** — the CLI rewrote the file with its OAuth tokens emptied
 *     (`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,…}}`).
 *     That is what it does when asked to refresh with a grant the OAuth server
 *     has already spent, and it is the terminal step of the daily-reconnect
 *     bug — so seeing it named in a log is the difference between "the user
 *     signed out" and "we just destroyed a live account's credentials".
 *   - **`unreadable`** — a file that is neither: truncated, foreign, or a
 *     shape this reader does not know. Never assumed to be empty.
 *
 * Diagnosis only. Nothing acts on the classification — in particular a blanked
 * SOURCE is neither repaired nor deleted, here or anywhere. A file this reader
 * believes is empty may be a partial write or a credential shape it has not
 * been taught, `expiresAt: 0` is a claim in the file rather than proof about
 * the account, and there is no compare-and-swap — a repair that loses a race
 * with a completing sign-in destroys a live credential, while the account is
 * already unusable either way. So the log line is the whole feature, and the
 * user reconnects once.
 *
 * A session's own copy is judged differently, and only there:
 * {@link isBlankedClaudeCredential} lets the sync guards read a blanked REPLICA
 * as "nothing to protect", so a session the CLI blanked can take the account's
 * live token on its next turn instead of being wedged forever (planning#495).
 * The predicate is shared with this function so that a probe and a reader
 * cannot come to disagree about one file; the asymmetry is in who consults it,
 * not in what it says.
 */
interface UnusableSource {
  kind: "missing" | "blanked" | "unreadable";
  detail: string;
}

/** A rotation adopted from a session's own CLI. See `harvestSessionRotations`. */
interface HarvestResult {
  sessionId: string;
  before: number | null;
  after: number;
}

/**
 * Public outcome classifications for a single refresh tick. Returned from
 * `refreshNow()` and surfaced in logs.
 */
export type RefreshOutcome =
  | "rotated_tier1"           // claude auth status rotated the token
  | "rotated_tier2"            // billable Haiku fallback rotated the token
  | "harvested_session"        // a session's resident CLI had already rotated; we adopted its token
  | "noop"                     // token wasn't near expiry; nothing to do
  | "rate_limited"             // a 429 was observed (or inferred from no-rotation in the dead-token state)
  | "revoked"                  // invalid_grant — refresh token is dead
  | "unknown_failure"          // neither tier rotated and we couldn't classify why
  | "missing_credentials";     // source file doesn't exist (post sign-out)

export interface RefreshResult {
  outcome: RefreshOutcome;
  accountId: string;
  beforeExpiresAt: number | null;
  afterExpiresAt: number | null;
  reason?: string;
}

export interface ClaudeOAuthRefresherEvents {
  refreshed: [accountId: string, expiresAt: number];
  account_unauthenticated: [accountId: string];
  /**
   * A previously-revoked account's token rotated back to healthy. The recovery
   * counterpart of `account_unauthenticated`: consumers (index.ts) flip the
   * provider-account row back to `ready` and re-broadcast `agent_list` so the
   * model selector clears its stale "needs auth" state. Fires only on the
   * revoked → recovered transition, not on routine healthy rotations.
   */
  account_reauthenticated: [accountId: string];
}

/**
 * Per-account scheduling + single-flight state. One instance per Claude
 * provider account. Lazy-created on first `scheduleAccount`.
 */
interface AccountState {
  accountId: string;
  /** The pending refresh tick timer. `null` when the account is unscheduled. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The in-flight refresh promise, if any. Other callers `await` this. */
  inFlight: Promise<RefreshResult> | null;
  /** Consecutive failure counter (resets to 0 on a successful rotation). */
  failureCount: number;
  /** Whether the account has emitted `account_unauthenticated` since the last successful rotation. */
  emittedUnauthenticated: boolean;
}

export interface ClaudeOAuthRefresherDeps {
  credentialsDir: string;
  providerAccountManager: ProviderAccountManager;
  /**
   * Force the freshly-rotated source token into every Claude-pinned session
   * for the given account. Same shape as the closure
   * `repushTokenToPinnedSessions` in `app-lifecycle.ts`.
   */
  repushAccountToken: (agentId: AgentId, accountId: string) => void;
  /** Used to fire the per-account SSE event for docs/150 failover. */
  sseBroadcast: (event: string, data: unknown) => void;
  /** Runtime mode. The refresher only does work in `containerized` mode. */
  runtimeMode: RuntimeMode;
  /** Inject for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject for tests. Defaults to `child_process.spawn`. */
  spawn?: typeof nodeSpawn;
  /** Inject for tests. Defaults to the production `safetyMargin`. */
  safetyMarginMs?: number;
}

/**
 * App-scoped Claude OAuth refresher. Construct once in `buildApp`, `start()`
 * after auth and event wiring, `stop()` on shutdown. Public API:
 *
 *   - `start()` — schedules ticks for every existing Claude account.
 *   - `stop()` — cancels all pending timers, leaves in-flight refreshes to settle.
 *   - `refreshNow(accountId?)` — triggers an immediate refresh. Used by:
 *       (a) `auth_complete` to refresh-after-sign-in;
 *       (b) session-level `auth_required` for synchronous repair before the UI
 *           shows a sign-in prompt;
 *       (c) tests.
 *
 * Non-public state is per-account and isolated — one account's failure does
 * not affect another's schedule.
 */
export class ClaudeOAuthRefresher extends EventEmitter {
  private readonly deps: Required<Omit<ClaudeOAuthRefresherDeps, "safetyMarginMs">> & { safetyMarginMs: number };
  private readonly accounts = new Map<string, AccountState>();
  private started = false;
  private stopped = false;

  constructor(deps: ClaudeOAuthRefresherDeps) {
    super();
    this.deps = {
      credentialsDir: deps.credentialsDir,
      providerAccountManager: deps.providerAccountManager,
      repushAccountToken: deps.repushAccountToken,
      sseBroadcast: deps.sseBroadcast,
      runtimeMode: deps.runtimeMode,
      now: deps.now ?? (() => Date.now()),
      spawn: deps.spawn ?? nodeSpawn,
      safetyMarginMs: deps.safetyMarginMs ?? SAFETY_MARGIN_MS,
    };
  }

  /**
   * Schedule refresh ticks for every Claude account currently known to the
   * provider account manager. Idempotent — safe to call repeatedly (e.g. after
   * `auth_complete` migrated a new account into existence).
   *
   * No-op in local (dogfood) runtime — there are no per-session containers, no
   * stampede, and the inner orchestrator inherits credentials from the outer
   * via env. Running here would be redundant churn.
   */
  start(): void {
    if (this.stopped) return; // Refuse to start after stop() — keep semantics simple.
    this.started = true;
    if (this.deps.runtimeMode !== "containerized") {
      console.log("[claude-oauth-refresh] skipping start: runtimeMode != containerized");
      return;
    }
    for (const account of this.deps.providerAccountManager.list("anthropic")) {
      this.scheduleAccount(account.id);
    }
  }

  /**
   * Cancel all pending refresh timers. In-flight refreshes are not aborted —
   * they'll settle and update state, but their results will be ignored for
   * scheduling purposes once `stopped = true`.
   */
  stop(): void {
    this.stopped = true;
    for (const state of this.accounts.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
  }

  /**
   * Trigger an immediate refresh. If `accountId` is omitted, refreshes every
   * known Claude account in parallel. Single-flight — concurrent callers
   * targeting the same account await the same in-flight promise.
   *
   * Used by:
   *  - The `auth_complete` handler: nudges the refresher to rearm immediately
   *    on fresh tokens rather than waiting for the next scheduled tick.
   *  - The `auth_required` SSE handler in `agent-listeners.ts`: synchronous
   *    repair attempt before falling through to the UI sign-in prompt.
   *  - Tests.
   */
  async refreshNow(accountId?: string): Promise<RefreshResult[]> {
    if (this.deps.runtimeMode !== "containerized") {
      return [];
    }
    if (accountId) {
      return [await this.runTickForAccount(accountId)];
    }
    const accounts = this.deps.providerAccountManager.list("anthropic");
    return Promise.all(accounts.map((a) => this.runTickForAccount(a.id)));
  }

  /**
   * Best-effort "make the source token usable before someone reads it." Cheap
   * to call on hot paths (session start, session naming): when the source
   * token still has more than `safetyMarginMs` of life left, it returns
   * immediately WITHOUT spawning the CLI — the common, healthy case. Only when
   * the token is within the safety margin (or already expired) does it await an
   * immediate single-flight refresh.
   *
   * This closes the gap the scheduled refresher can't cover on its own: if a
   * scheduled tick has fallen behind its margin (a run of 429 backoffs ate the
   * lead time), a session that starts in that window would otherwise sync in a
   * dying token and 401 on its first CLI call. Calling this before the token is
   * copied into the session heals the source first.
   *
   * Never throws — a failed refresh resolves to `false`. Returns `true` when
   * the token is usable (present and not expired) after the call: `true` for a
   * healthy token (no work done), `true` after a successful rotation, `false`
   * when the token is missing or still expired (rate-limited / revoked).
   *
   * `accountId` omitted → every known Claude account, aggregated with
   * `every()`. That is right for a *proactive* sweep ("is everything healthy")
   * and wrong for a caller asking about one turn: since docs/150 a provider can
   * have several accounts, so one revoked account would answer `false` for a
   * turn whose own account is fine. Callers that know which account they mean
   * must pass it — see `resolveTurnAccountId` on the turn deps. No-op (returns
   * `true`) outside containerized runtime, matching `refreshNow`.
   *
   * `opts.force` switches the call from "is the source healthy?" to "give me a
   * token nobody has used yet", for the runtime-401 recovery path — see
   * {@link ensureFreshOne}.
   */
  async ensureFresh(accountId?: string, opts?: { force?: boolean }): Promise<boolean> {
    if (this.deps.runtimeMode !== "containerized") return true;
    const force = opts?.force ?? false;
    if (accountId) return this.ensureFreshOne(accountId, force);
    const accounts = this.deps.providerAccountManager.list("anthropic");
    if (accounts.length === 0) return true;
    const results = await Promise.all(accounts.map((a) => this.ensureFreshOne(a.id, force)));
    return results.every(Boolean);
  }

  /**
   * `force` is the difference between the two questions a caller can ask.
   *
   * **Unforced** (the proactive sweeps — env-prep step 2a, session naming) asks
   * "is the SOURCE token healthy?" A token with margin left short-circuits with
   * no CLI spawn, which is what keeps the call near-free on the hot path.
   *
   * **Forced** (the runtime-401 recovery, docs/179) asks "give me a token the
   * failing session has not already tried." Source expiry cannot answer that:
   * the 401 came from a session whose *synced copy* is dead — a single-use
   * refresh token a sibling container rotated first (see the
   * `prepareAgentEnv` note in `session-runner.ts`) — while the source itself
   * still has hours of margin. The unforced short-circuit therefore returned
   * `true` having done nothing, the executor re-dispatched the turn ~120ms
   * later on byte-identical credentials, it 401'd again, and the single shared
   * recovery budget was gone. Production bore that out: six `auth healed`
   * events in a six-hour window with ZERO `[claude-oauth-refresh]` lines
   * beside them.
   *
   * So the forced path skips the healthy short-circuit and runs a tick that
   * reaches Tier 2 — a real authenticated API call, which both *probes
   * validity* (a dead grant surfaces `invalid_grant`, classified as `revoked`)
   * and triggers refresh-on-use. Its verdict is the tick's classification, not
   * the expiry timestamp: anything but a dead grant is a heal, because the
   * recovery ALSO force-pushes the source token into the failing session
   * (`repushSessionAgentToken`), which is what actually repairs a session
   * holding a dead-but-later-dated copy. A `revoked` account is reported as
   * unhealed so the caller surfaces the sign-in card instead of spending the
   * single recovery budget on a turn that cannot succeed.
   *
   * One tick outcome now reaches this without a Tier-2 probe having run: a
   * HARVEST, which adopts a token another session's CLI minted minutes ago. See
   * the note at the harvest call in `executeTick` for why that is the better
   * evidence rather than a hole, and what it gives up.
   */
  private async ensureFreshOne(accountId: string, force = false): Promise<boolean> {
    const before = this.readSourceExpiresAt(accountId);
    // No usable source on disk — a sign-in is required; nothing this path can
    // do. The caller falls back to whatever token (if any) is already synced.
    if (before === NO_EXPIRY) return false;
    const now = this.deps.now();
    if (!force && before - now > this.deps.safetyMarginMs) return true; // healthy; no work.
    // Within margin, expired, or forced — heal it. `runTickForAccount` is
    // single-flight, so a scheduled tick or a concurrent caller already
    // refreshing is awaited rather than duplicated.
    let outcome: RefreshOutcome | null = null;
    try {
      outcome = (await this.runTickForAccount(accountId, force)).outcome;
    } catch (err) {
      // runTickForAccount swallows its own errors; this is purely defensive.
      console.error(`[claude-oauth-refresh] ensureFresh tick for ${accountId} threw:`, err);
    }
    const after = this.readSourceExpiresAt(accountId);
    if (after === NO_EXPIRY) return false;
    if (force && (outcome === "revoked" || outcome === "missing_credentials")) {
      console.log(
        `[claude-oauth-refresh] account=${accountId} forced heal probe reported ${outcome} — not healed`,
      );
      return false;
    }
    return after > this.deps.now();
  }

  // ---- internal ----

  /**
   * Schedule (or reschedule) the next tick for an account based on its source
   * token's encoded `expiresAt`. If the token is already past expiry
   * (orchestrator was down, never refreshed, or just freshly authenticated
   * after the source was wiped), fire on a short startup delay so other boot
   * work can settle first.
   */
  private scheduleAccount(accountId: string): void {
    if (this.stopped) return;
    const state = this.ensureAccountState(accountId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const expiresAt = this.readSourceExpiresAt(accountId);
    if (expiresAt === NO_EXPIRY) {
      // No usable source — wait for `auth_complete` (signals the user signed
      // back in) before rearming. The wireEventHandlers handler nudges us.
      return;
    }
    const now = this.deps.now();
    const fireAt = expiresAt - this.deps.safetyMarginMs;
    const delay = Math.max(STARTUP_OVERDUE_DELAY_MS, fireAt - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        // runTickForAccount swallows its own errors, but defensively log
        // anything that escapes the safety net.
        console.error(`[claude-oauth-refresh] unexpected error in tick for ${accountId}:`, err);
      });
    }, delay);
    // setTimeout returns a Timer object on Node — unref so a single dangling
    // refresher doesn't keep the process alive during shutdown.
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  /**
   * Schedule the next tick after a failure, using a backoff schedule keyed off
   * `failureCount`. A separate schedule from `scheduleAccount` because the
   * expiry-derived schedule doesn't help when the token has already failed to
   * refresh — we need to retry at fixed intervals until it works.
   */
  private scheduleBackoff(accountId: string, schedule: readonly number[]): void {
    if (this.stopped) return;
    const state = this.ensureAccountState(accountId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const idx = Math.min(state.failureCount, schedule.length - 1);
    const delay = schedule[idx];
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[claude-oauth-refresh] unexpected error in backoff tick for ${accountId}:`, err);
      });
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  /**
   * Single-flight gate for a refresh attempt on a specific account. Returns the
   * existing in-flight promise if one is already running, otherwise starts a
   * new attempt.
   *
   * A forced caller that joins an in-flight *unforced* tick can come back
   * without a rotation; that's fine, because `ensureFreshOne` judges a forced
   * heal by whether the expiry actually advanced rather than by this returning.
   */
  private runTickForAccount(accountId: string, force = false): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    if (state.inFlight) return state.inFlight;
    const promise = this.executeTick(accountId, force).finally(() => {
      state.inFlight = null;
    });
    state.inFlight = promise;
    return promise;
  }

  /**
   * Run a single refresh tick: snapshot source state, run Tier 1, snapshot
   * again. If Tier 1 didn't rotate AND the token is expired (or near expiry),
   * fall through to Tier 2. Classify the outcome and schedule the next tick
   * accordingly.
   *
   * `force` (runtime-401 recovery) makes Tier 2 unconditional: Tier 1 is
   * read-only for a token that still has margin, so without it the tick would
   * return `noop` for exactly the token that just produced a 401.
   */
  private async executeTick(accountId: string, force = false): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("claude", accountId);
    const sourceFile = this.sourceFileFor(accountId);

    // HARVEST BEFORE SPEND. A session's resident CLI may have rotated this
    // account's single-use refresh token since the last tick, which makes our
    // copy dead on arrival — see the module docstring. Adopting is both the
    // repair and the rotation: nothing upstream needs to be asked for a token
    // that already exists on this disk.
    //
    // It short-circuits the FORCED path too (docs/179's 401 recovery), which
    // otherwise always reaches tier 2 as a validity probe. That is a deliberate
    // trade, and the reasoning runs the other way from how it first looks: the
    // probe exists to tell a dead ACCESS token from a dead GRANT, and a token
    // another session minted minutes ago is direct evidence the grant was live
    // — stronger than the Haiku call, which infers it. It is also the exact
    // repair the 401 called for, since a session 401s precisely because a
    // sibling rotated out from under it. What is given up: a grant revoked
    // between that session's refresh and now reads as healed, so the recovery
    // spends its single retry before the sign-in card appears one turn later.
    const harvest = this.harvestSessionRotations(accountId);
    if (harvest) {
      return this.handleSuccess(accountId, harvest.before, harvest.after, "harvested_session");
    }

    const before = this.readSourceExpiresAt(accountId);
    if (before === NO_EXPIRY) {
      const unusable = this.describeUnusableSource(sourceFile);
      const result: RefreshResult = {
        outcome: "missing_credentials",
        accountId,
        beforeExpiresAt: null,
        afterExpiresAt: null,
        reason: unusable.detail,
      };
      console.log(
        `[claude-oauth-refresh] account=${accountId} missing_credentials — waiting for auth_complete`
          + ` source=${unusable.kind} detail=${unusable.detail}`,
      );
      // An existing account with no usable source cannot run turns. Treat this
      // like terminal revocation so persistence, routing, and Settings all
      // stop advertising the exact account as ready. emitUnauthenticated is
      // idempotent; repeated manual probes do not duplicate the notifications.
      this.emitUnauthenticated(accountId, "missing_credentials");
      return result;
    }

    // Tier 1: `claude auth status --json`. Designed for scripted use, no model,
    // no prompt — structurally cannot trigger a billable conversation API call.
    // May or may not trigger an OAuth refresh depending on CLI internals; we
    // measure by file-state delta.
    const tier1Log = await this.spawnCliInRoot(
      ["auth", "status", "--json"],
      accountRoot,
      TIER1_TIMEOUT_MS,
    );
    const afterTier1 = this.readSourceExpiresAt(accountId);

    if (afterTier1 !== NO_EXPIRY && afterTier1 > before) {
      return this.handleSuccess(accountId, before, afterTier1, "rotated_tier1");
    }

    const now = this.deps.now();
    const isNearExpiry = before <= now + this.deps.safetyMarginMs;
    // `force` (runtime-401 recovery) runs tier 2 regardless: tier 1 is
    // read-only for a token with margin left, so without this the tick returns
    // `noop` for exactly the token that just produced a 401.
    const runTier2 = force || isNearExpiry;

    if (!runTier2) {
      // Token's still healthy. Tier 1 was just read-only. Rearm on the
      // expiry-derived schedule.
      state.failureCount = 0;
      this.handleHealthySource(accountId);
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: afterTier1,
      };
    }

    // Tier 2: billable Haiku prompt. Forces the CLI to make a real
    // authenticated API call, which triggers refresh-on-use if needed. Tools
    // disabled and session persistence suppressed so there's no surrounding
    // side-effect.
    const tier2Log = await this.spawnCliInRoot(
      [
        "--print", "ok",
        "--model", "claude-haiku-4-5-20251001",
        "--tools", "",
        "--no-session-persistence",
      ],
      accountRoot,
      TIER2_TIMEOUT_MS,
    );
    const afterTier2 = this.readSourceExpiresAt(accountId);

    if (afterTier2 !== NO_EXPIRY && afterTier2 > before) {
      return this.handleSuccess(accountId, before, afterTier2, "rotated_tier2");
    }

    // Neither tier rotated. Classify the failure from the combined CLI output.
    const combinedOutput = `${tier1Log}\n${tier2Log}`;
    // A FORCED tick on a token that wasn't actually due ran tier 2 as a
    // *validity probe*, not as a scheduled refresh (docs/179). A revocation is
    // still terminal and must be classified — that's the signal the 401
    // recovery is asking for — but "didn't rotate a token that wasn't near
    // expiry" is not a scheduling failure, and letting it reach
    // `handleFailure` would bump `failureCount` and replace this account's
    // expiry-derived schedule with a backoff every time a session 401s.
    if (force && !isNearExpiry && !this.outputIndicatesRevoked(combinedOutput)) {
      state.failureCount = 0;
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: afterTier2,
        reason: "forced validity probe found a live token that needed no rotation",
      };
    }
    return this.handleFailure(accountId, before, afterTier2, combinedOutput);
  }

  /** Shared with {@link handleFailure} — the only terminal "this grant is dead" test. */
  private outputIndicatesRevoked(combinedOutput: string): boolean {
    const lc = combinedOutput.toLowerCase();
    return TERMINAL_AUTH_FAILURE_PATTERNS.some((phrase) => lc.includes(phrase));
  }

  /**
   * Common path for a successful rotation: log, propagate to sessions, clear
   * failure counter / unauthenticated flag, schedule the next tick.
   */
  private handleSuccess(
    accountId: string,
    before: number | null,
    after: number,
    outcome: "rotated_tier1" | "rotated_tier2" | "harvested_session",
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount = 0;
    const wasUnauthenticated = state.emittedUnauthenticated;
    state.emittedUnauthenticated = false;
    console.log(
      `[claude-oauth-refresh] account=${accountId} ${outcome} new_expires_at=${new Date(after).toISOString()}`,
    );
    try {
      // Unconditional by design (docs/142 A3) — including onto the session a
      // harvest just adopted FROM. That is safe only because the harvest ran
      // first: the source now holds that session's own token, so the push is
      // byte-identical there and genuinely repairs every OTHER pinned session,
      // each of which is holding the copy the rotation invalidated upstream.
      this.deps.repushAccountToken("claude", accountId);
    } catch (err) {
      console.error(`[claude-oauth-refresh] account=${accountId} repush failed:`, err);
    }
    this.emit("refreshed", accountId, after);
    if (wasUnauthenticated) {
      // The card is back online; clear the warning state (docs/150 failover
      // consumers should see this and un-mark the account as needing sign-in).
      this.deps.sseBroadcast("claude_account_authenticated", { accountId });
      // Flip the persisted account row back to `ready` + refresh the agent
      // registry so the model selector clears its stale "needs auth" state.
      // The SSE above only repairs failover consumers, not the agent_list the
      // picker reads from. (index.ts wires this to markProviderAccountReauthenticated.)
      this.emit("account_reauthenticated", accountId);
    }
    this.scheduleAccount(accountId);
    return {
      outcome,
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
    };
  }

  /**
   * Both tiers ran and neither rotated the token. Parse the CLI output for
   * known signals to classify the failure:
   *   - `invalid_grant` / `invalid_refresh_token` → revoked, stop scheduling
   *     and emit `claude_account_unauthenticated` (the ONLY terminal signal —
   *     see {@link TERMINAL_AUTH_FAILURE_PATTERNS} for why generic 401
   *     phrases must never be treated as revocation)
   *   - `429` / `rate_limit` / `rate limited` → rate_limited, backoff
   *   - otherwise (including a routine expired-access-token 401 whose refresh
   *     didn't complete this tick) → unknown_failure, short backoff — the
   *     next tick retries and rotates once the transient clears
   */
  private handleFailure(
    accountId: string,
    before: number,
    after: number | null,
    combinedOutput: string,
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount += 1;
    const lc = combinedOutput.toLowerCase();
    const reason = summarizeRefreshFailure(combinedOutput);
    const isRateLimited =
      lc.includes("429") || lc.includes("rate_limit") || lc.includes("rate limited");
    const isRevoked = this.outputIndicatesRevoked(combinedOutput);

    if (isRevoked) {
      console.log(`[claude-oauth-refresh] account=${accountId} revoked (${this.authFailureReason(lc)}) — emitting auth_required`);
      this.emitUnauthenticated(accountId, "revoked");
      // Stop scheduling. The auth_complete handler will reschedule when the
      // user signs back in.
      return {
        outcome: "revoked",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason: this.authFailureReason(lc),
      };
    }

    // Both remaining classifications append `reason=` to the sentence they have
    // always printed rather than rewording it: an incident was diagnosed by
    // grepping these lines, and a runbook that stops matching is worse than a
    // missing field. The excerpt is redacted — see {@link summarizeRefreshFailure}.
    if (isRateLimited) {
      console.log(
        `[claude-oauth-refresh] account=${accountId} rate_limited failure_count=${state.failureCount} — backoff scheduled`
          + ` reason="${reason}"`,
      );
      this.scheduleBackoff(accountId, RATE_LIMIT_BACKOFF_MS);
      return {
        outcome: "rate_limited",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason,
      };
    }

    console.log(
      `[claude-oauth-refresh] account=${accountId} unknown_failure failure_count=${state.failureCount} — short backoff`
        + ` reason="${reason}"`,
    );
    this.scheduleBackoff(accountId, GENERIC_BACKOFF_MS);
    return {
      outcome: "unknown_failure",
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
      reason,
    };
  }

  private authFailureReason(lcOutput: string): string {
    return TERMINAL_AUTH_FAILURE_PATTERNS.find((phrase) => lcOutput.includes(phrase)) ?? "auth_failure";
  }

  /**
   * Emit the per-account auth-required signals. Two channels:
   *   - The unified `agent_auth_failed` SSE with `reason: "revoked"` —
   *     drives the UI card flip ("Sign in" state) without naming Claude in
   *     the event itself. (docs/155 Phase 2b — replaces the legacy
   *     `auth_required` broadcast.)
   *   - The per-account `claude_account_unauthenticated` SSE — carries
   *     `{ accountId }` for docs/150 multi-account failover to consume.
   */
  private emitUnauthenticated(accountId: string, reason: "revoked" | "missing_credentials"): void {
    const state = this.ensureAccountState(accountId);
    if (state.emittedUnauthenticated) return; // Don't spam SSE on each backoff tick.
    state.emittedUnauthenticated = true;
    this.emit("account_unauthenticated", accountId);
    this.deps.sseBroadcast("claude_account_unauthenticated", { accountId });
    // docs/150-multiple-provider-subscriptions req 19 — see the matching comment in the Codex refresher: the
    // client drops an `agent_auth_failed` that names no account.
    this.deps.sseBroadcast("agent_auth_failed", { loginId: "anthropic-oauth", accountId, reason });
  }

  /** Clear the terminal-state latch when re-auth wrote a healthy source file. */
  private handleHealthySource(accountId: string): void {
    const state = this.ensureAccountState(accountId);
    if (!state.emittedUnauthenticated) return;
    state.emittedUnauthenticated = false;
    try {
      this.deps.repushAccountToken("claude", accountId);
    } catch (err) {
      console.error(`[claude-oauth-refresh] account=${accountId} recovery repush failed:`, err);
    }
    this.deps.sseBroadcast("claude_account_authenticated", { accountId });
    this.emit("account_reauthenticated", accountId);
  }

  /**
   * Spawn `claude <args>` with `HOME=<accountRoot>` so the CLI reads/writes
   * the *account's* `.claude/.credentials.json` directly. Capture stdout +
   * stderr and the `--debug api` log to a temp file, so we can classify the
   * outcome from the combined text.
   *
   * Resolves with the captured text. Never rejects — process failures /
   * timeouts return what we managed to capture so the caller can still
   * classify.
   */
  private spawnCliInRoot(
    args: string[],
    accountRoot: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let debugFile: string | null = null;
      try {
        debugFile = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-refresh-")),
          "debug.log",
        );
      } catch (err) {
        console.warn("[claude-oauth-refresh] failed to create debug log file:", err);
      }
      const fullArgs = [...args];
      if (debugFile) {
        fullArgs.push("--debug", "api", "--debug-file", debugFile);
      }
      const opts: SpawnOptions = {
        env: { ...process.env, HOME: accountRoot },
        stdio: ["ignore", "pipe", "pipe"],
      };
      let child: ChildProcess;
      try {
        child = this.deps.spawn("claude", fullArgs, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (debugFile) this.cleanupDebugDir(debugFile);
        resolve(`[spawn-failed] ${msg}`);
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killChild(child, "SIGKILL");
        finish("[timeout] claude CLI did not exit in time");
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const finish = (extra: string): void => {
        let debugContent = "";
        if (debugFile) {
          try {
            if (fs.existsSync(debugFile)) {
              debugContent = fs.readFileSync(debugFile, "utf8");
            }
          } catch { /* */ }
          this.cleanupDebugDir(debugFile);
        }
        resolve(`${stdout}\n${stderr}\n${debugContent}\n${extra}`.trim());
      };

      child.on("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish("");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish(`[error] ${err.message}`);
      });
    });
  }

  private cleanupDebugDir(debugFile: string): void {
    try {
      fs.rmSync(path.dirname(debugFile), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // ---- harvest (adopt a session's own rotation) ----

  /**
   * Bring the source up to date from the sessions that share it, and report the
   * rotation if that moved anything.
   *
   * The premise the rest of this file rests on — that the orchestrator is the
   * only thing refreshing this account — is false for a RESIDENT CLI, which
   * keeps running between turns and refreshes on its own clock. Because
   * Anthropic's refresh tokens are single-use, such a rotation leaves the
   * account root holding a grant the OAuth server has already spent: every
   * later tick is doomed, and the tier-2 spend is what makes the CLI blank the
   * source file and take the account down. So the source is reconciled with
   * the sessions BEFORE anything is spent.
   *
   * Which sessions count: exactly those whose subtree marker (docs/260) names
   * this account, and whose token file physically LIVES in their own subtree
   * ({@link tokenFileIsOwnedBySubtree}). Both conditions, because each answers a
   * different question and neither answers the other's:
   *
   *   - The marker is the recorded identity of the copy — token bytes cannot
   *     say whose they are — so a session on another account, or one whose
   *     subtree is lent to a sub-agent's account, is not read.
   *   - The containment check is what stops a *leaked subtree-root symlink*
   *     (`containerVisibleCredentialPath`, pre-docs/150-req-19) from turning
   *     `sessions/<id>/.claude` into a second name for some OTHER account's
   *     root: orchestrator-side that path resolves back through the symlink, so
   *     without this a session marked A whose `.claude` points at B would have
   *     B's token compared against A's and copied into A. No race needed. The
   *     turn-end write-back is exposed to the same shape and is bounded by the
   *     leak repair its own turn runs; a tick scans every subtree on the disk,
   *     including sessions that will never take another turn, so it must check.
   *
   * What this does NOT establish is that the BYTES under a matching marker are
   * that account's. Nothing on disk can: the marker records what provisioning
   * intended, docs/260 §4b says so explicitly, and it lives in a subtree the
   * session worker can write. The same limit already governs the turn-end
   * write-back, which publishes on the marker's word too — the harvest widens
   * *when* that write can fire (a timer, not a turn), not what it trusts.
   *
   * The write itself is the ordinary write-back, guards included:
   * `sessionOwnRoute` says the account is the SESSION'S own (the marker just
   * matched, the same authority `finalizeSessionAgentEnvironment` falls back
   * to), so a *recorded* sub-agent borrow refuses for its whole window rather
   * than publishing a borrowed bearer. The freshness guard inside decides every
   * copy, so iterating all candidates converges on the newest one of those it
   * is offered.
   */
  private harvestSessionRotations(accountId: string): HarvestResult | null {
    const credentialsDir = this.deps.credentialsDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sessionCredentialsRoot(credentialsDir), { withFileTypes: true });
    } catch {
      return null; // no per-session subtrees at all — nothing to harvest from
    }
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((sessionId) => readSessionAccountMarker(credentialsDir, sessionId).claude === accountId)
      .filter((sessionId) => this.tokenFileIsOwnedBySubtree(sessionId));
    if (candidates.length === 0) return null;

    const before = this.readSourceExpiresAt(accountId);
    let best = before;
    let adoptedFrom: string | null = null;
    for (const sessionId of candidates) {
      if (!sessionTokenIsAheadOfSource(credentialsDir, sessionId, "claude", accountId)) continue;
      try {
        syncProviderAccountTokenBack(credentialsDir, sessionId, "claude", accountId, { sessionOwnRoute: true });
      } catch (err) {
        console.warn(`[claude-oauth-refresh] account=${accountId} harvest from session ${sessionId} failed:`, err);
        continue;
      }
      const after = this.readSourceExpiresAt(accountId);
      if (after === NO_EXPIRY) continue;
      if (best !== NO_EXPIRY && after <= best) continue; // the write-back declined; keep looking
      best = after;
      adoptedFrom = sessionId;
    }
    if (adoptedFrom === null || best === NO_EXPIRY) return null;
    console.log(
      `[claude-oauth-refresh] account=${accountId} harvested a session-side rotation from ${adoptedFrom}`
        + ` was=${before === NO_EXPIRY ? "none" : new Date(before).toISOString()}`
        + ` now=${new Date(best).toISOString()}`,
    );
    return { sessionId: adoptedFrom, before, after: best };
  }

  /**
   * Does this session's token file physically live inside this session's own
   * subtree — or is the path a link to somewhere else on the credentials volume?
   *
   * `<sessionDir>/.claude` can be an absolute symlink into
   * `/credentials/provider-accounts/…`, left by provisioning that predates
   * docs/150-multiple-provider-subscriptions req 19. Orchestrator-side that
   * resolves back OUT of the session, which is the whole reason
   * `containerVisibleCredentialPath` exists on the sync-in side. A harvest
   * reading through one would be reading an account root and calling it a
   * session's rotation.
   *
   * Realpath rather than an `lstat` on the file: the escape can be at any
   * component (`.claude` itself is the observed one), and comparing resolved
   * prefixes catches every variant with one syscall. A path that cannot be
   * resolved at all — the file simply does not exist yet — is not a candidate
   * either, and answering `false` for it costs nothing: `sessionTokenIsAheadOfSource`
   * would have found nothing to publish.
   */
  private tokenFileIsOwnedBySubtree(sessionId: string): boolean {
    const sessionDir = perSessionCredentialsDir(this.deps.credentialsDir, sessionId);
    try {
      const resolvedFile = fs.realpathSync(this.sessionTokenFileFor(sessionId));
      const resolvedDir = fs.realpathSync(sessionDir);
      return resolvedFile.startsWith(resolvedDir + path.sep);
    } catch {
      return false;
    }
  }

  // ---- source-file reads ----

  /** The account's own credential file — the token every session is served from. */
  private sourceFileFor(accountId: string): string {
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("claude", accountId);
    return path.join(accountRoot, CLAUDE_CREDENTIALS_RELATIVE);
  }

  /** One session's copy of that credential. */
  private sessionTokenFileFor(sessionId: string): string {
    return path.join(
      perSessionCredentialsDir(this.deps.credentialsDir, sessionId),
      CLAUDE_CREDENTIALS_RELATIVE,
    );
  }

  /**
   * Read the encoded `expiresAt` (epoch ms) from the account's source token
   * file. Returns null if the file is missing, unparseable, or carries no
   * expiry value — which the caller treats as "no usable token, don't act."
   */
  private readSourceExpiresAt(accountId: string): number | null {
    return this.readClaudeExpiresAt(this.sourceFileFor(accountId));
  }

  /** {@link readSourceExpiresAt} for any Claude credential file. */
  private readClaudeExpiresAt(file: string): number | null {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
      const expiresAtRaw = oauth?.expiresAt;
      if (typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw) && expiresAtRaw > 0) {
        // Heuristic: < 10^10 means seconds, otherwise ms.
        return expiresAtRaw < 10_000_000_000 ? expiresAtRaw * 1000 : expiresAtRaw;
      }
    } catch { /* missing/invalid */ }
    return null;
  }

  /** Why a source file carries no usable expiry. See {@link UnusableSource}. */
  private describeUnusableSource(file: string): UnusableSource {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { kind: "missing", detail: `source file missing at ${file}` };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: "unreadable", detail: `source file at ${file} is not parseable JSON` };
    }
    // Shared with the sync guards rather than re-derived here (planning#495):
    // they must agree that a blanked file holds nothing, because this names the
    // state in a log and they act on it.
    if (isBlankedClaudeCredential(parsed)) {
      return {
        kind: "blanked",
        detail: `the CLI blanked the source at ${file} (empty accessToken/refreshToken, expiresAt=0)`,
      };
    }
    return { kind: "unreadable", detail: `source file at ${file} carries no usable expiry` };
  }

  private ensureAccountState(accountId: string): AccountState {
    let state = this.accounts.get(accountId);
    if (!state) {
      state = {
        accountId,
        timer: null,
        inFlight: null,
        failureCount: 0,
        emittedUnauthenticated: false,
      };
      this.accounts.set(accountId, state);
    }
    return state;
  }

  // ---- test/inspection helpers ----

  /**
   * For tests only. Returns a snapshot of the internal account state so tests
   * can assert on failure counts, timer presence, etc. Not part of the public
   * runtime contract.
   */
  _inspectForTest(accountId: string): Readonly<Pick<AccountState, "failureCount" | "emittedUnauthenticated">> & {
    hasTimer: boolean;
    hasInFlight: boolean;
  } {
    const state = this.ensureAccountState(accountId);
    return {
      failureCount: state.failureCount,
      emittedUnauthenticated: state.emittedUnauthenticated,
      hasTimer: state.timer !== null,
      hasInFlight: state.inFlight !== null,
    };
  }

  /** For tests: returns all known account IDs. */
  _knownAccountsForTest(): string[] {
    return Array.from(this.accounts.keys());
  }
}
