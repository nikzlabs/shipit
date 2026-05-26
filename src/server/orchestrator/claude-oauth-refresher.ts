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
import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import type { AgentId, ProviderAccount } from "../shared/types.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { RuntimeMode } from "./app-di.js";

/**
 * How far before the encoded `expiresAt` to fire a refresh tick during normal
 * operation. Picked generously — well above any plausible session-side
 * "near expiry" heuristic the CLI might use — so the orchestrator always wins
 * the race and sessions never trigger their own refresh.
 */
const SAFETY_MARGIN_MS = 30 * 60 * 1000; // 30 minutes

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

/** Sentinel for "no credentials on disk" (file missing or unparseable). */
const NO_EXPIRY: null = null;

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
    for (const account of this.deps.providerAccountManager.list("claude")) {
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
    const accounts = this.deps.providerAccountManager.list("claude");
    return Promise.all(accounts.map((a) => this.runTickForAccount(a.id)));
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
   */
  private runTickForAccount(accountId: string): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    if (state.inFlight) return state.inFlight;
    const promise = this.executeTick(accountId).finally(() => {
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
   */
  private async executeTick(accountId: string): Promise<RefreshResult> {
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
    const nearExpiry = before <= now + this.deps.safetyMarginMs;

    if (!nearExpiry) {
      // Token's still healthy. Tier 1 was just read-only. Rearm on the
      // expiry-derived schedule.
      state.failureCount = 0;
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
    return this.handleFailure(accountId, before, afterTier2, combinedOutput);
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
   *   - `429` / `rate_limit` / `rate limited` → rate_limited, backoff
   *   - `invalid_grant` / `invalid_refresh_token` → revoked, stop scheduling
   *     and emit `claude_account_unauthenticated`
   *   - otherwise → unknown_failure, short backoff
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
    const isRevoked =
      lc.includes("invalid_grant") || lc.includes("invalid_refresh_token") || lc.includes("invalid refresh token");

    if (isRevoked) {
      console.log(`[claude-oauth-refresh] account=${accountId} revoked (invalid_grant) — emitting auth_required`);
      this.emitUnauthenticated(accountId);
      // Stop scheduling. The auth_complete handler will reschedule when the
      // user signs back in.
      return {
        outcome: "revoked",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason: "invalid_grant",
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

  /**
   * Emit the per-account auth-required signals. Two channels:
   *   - The existing global `auth_required` SSE — drives the UI card flip
   *     ("Sign in" state) just like the AuthManager's OAuth-url event does
   *     today. Sufficient for the single-account v1 UX.
   *   - The new per-account `claude_account_unauthenticated` SSE — carries
   *     `{ accountId }` for docs/150 multi-account failover to consume.
   */
  private emitUnauthenticated(accountId: string): void {
    const state = this.ensureAccountState(accountId);
    if (state.emittedUnauthenticated) return; // Don't spam SSE on each backoff tick.
    state.emittedUnauthenticated = true;
    this.emit("account_unauthenticated", accountId);
    this.deps.sseBroadcast("claude_account_unauthenticated", { accountId });
    this.deps.sseBroadcast("auth_required", {});
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
      const opts: SpawnOptionsWithoutStdio = {
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
        try { child.kill("SIGKILL"); } catch {/* */}
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

/** Re-export account type for convenience in wiring code. */
export type { ProviderAccount };
