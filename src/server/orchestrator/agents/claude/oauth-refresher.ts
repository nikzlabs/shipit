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

/**
 * How far before the encoded `expiresAt` to fire a refresh tick during normal
 * operation. Picked generously — well above any plausible session-side
 * "near expiry" heuristic the CLI might use — so the orchestrator always wins
 * the race and sessions never trigger their own refresh.
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

/**
 * Public outcome classifications for a single refresh tick. Returned from
 * `refreshNow()` and surfaced in logs.
 */
export type RefreshOutcome =
  | "rotated_tier1"           // claude auth status rotated the token
  | "rotated_tier2"            // billable Haiku fallback rotated the token
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
   * always reaches Tier 2 — a real authenticated API call, which both *probes
   * validity* (a dead grant surfaces `invalid_grant`, classified as `revoked`)
   * and triggers refresh-on-use. Its verdict is the tick's classification, not
   * the expiry timestamp: anything but a dead grant is a heal, because the
   * recovery ALSO force-pushes the source token into the failing session
   * (`repushSessionAgentToken`), which is what actually repairs a session
   * holding a dead-but-later-dated copy. A `revoked` account is reported as
   * unhealed so the caller surfaces the sign-in card instead of spending the
   * single recovery budget on a turn that cannot succeed.
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
    const sourceFile = path.join(accountRoot, CLAUDE_CREDENTIALS_RELATIVE);

    const before = this.readSourceExpiresAt(accountId);
    if (before === NO_EXPIRY) {
      const result: RefreshResult = {
        outcome: "missing_credentials",
        accountId,
        beforeExpiresAt: null,
        afterExpiresAt: null,
        reason: `source file missing or unparseable at ${sourceFile}`,
      };
      console.log(`[claude-oauth-refresh] account=${accountId} missing_credentials — waiting for auth_complete`);
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
    before: number,
    after: number,
    outcome: "rotated_tier1" | "rotated_tier2",
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount = 0;
    const wasUnauthenticated = state.emittedUnauthenticated;
    state.emittedUnauthenticated = false;
    console.log(
      `[claude-oauth-refresh] account=${accountId} ${outcome} new_expires_at=${new Date(after).toISOString()}`,
    );
    try {
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

    if (isRateLimited) {
      console.log(
        `[claude-oauth-refresh] account=${accountId} rate_limited failure_count=${state.failureCount} — backoff scheduled`,
      );
      this.scheduleBackoff(accountId, RATE_LIMIT_BACKOFF_MS);
      return {
        outcome: "rate_limited",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason: "rate_limit",
      };
    }

    console.log(
      `[claude-oauth-refresh] account=${accountId} unknown_failure failure_count=${state.failureCount} — short backoff`,
    );
    this.scheduleBackoff(accountId, GENERIC_BACKOFF_MS);
    return {
      outcome: "unknown_failure",
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
      reason: combinedOutput.slice(0, 200) || "no CLI output",
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

  /**
   * Read the encoded `expiresAt` (epoch ms) from the account's source token
   * file. Returns null if the file is missing, unparseable, or carries no
   * expiry value — which the caller treats as "no usable token, don't act."
   */
  private readSourceExpiresAt(accountId: string): number | null {
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("claude", accountId);
    const file = path.join(accountRoot, CLAUDE_CREDENTIALS_RELATIVE);
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
