/**
 * LimitsPoller — orchestrator-level subscription-limits poller for
 * every registered agent backend. Polls each fetchable provider
 * once per minute, caches the latest snapshot per agent, and emits
 * an SSE `subscription_limits` event whenever any provider's
 * snapshot changes (success → success delta, transition into an
 * error state, sign-out → key removed).
 *
 * Design notes — see docs/135-subscription-limits-badge/plan.md
 * ("Polling on the orchestrator"):
 *
 *   - **No active-agent gating.** The poller hits every fetchable
 *     provider in parallel on the same cadence; the client renders
 *     one pill per cache entry. The rest of the header is
 *     account-wide / global, so the limits badge follows that
 *     pattern rather than inventing a focus-driven element.
 *   - **Per-provider backoff.** Each provider has its own failure
 *     counter and retry window. Claude failing doesn't slow Codex
 *     down. Auth failures (401/403) halt that provider until the
 *     next `auth_complete` from its auth manager. 429s are honored
 *     verbatim (Retry-After or 15m default) without bumping the
 *     generic counter. 5xx / schema / network errors share an
 *     exponential backoff capped at 5 minutes.
 *   - **No SSE-client gating.** The plan calls for "runs whenever
 *     there is at least one connected SSE client AND at least one
 *     fetchable provider," but in practice the SSE client list is
 *     owned by index.ts and not trivially injectable here. The
 *     poller is started by index.ts after SSE is up, so the
 *     practical gating is: poller runs while the orchestrator is
 *     alive AND at least one provider can fetch. The cost is ≤2
 *     HTTP calls/minute regardless of viewers, which is well within
 *     budget; we revisit if a third or fourth provider lands.
 *
 * Snapshot lifecycle:
 *
 *   - On `start()`: refreshes every provider's `canFetch()` cache
 *     and runs an immediate poll so the initial SSE burst includes
 *     fresh data instead of leaving the badge blank for 60s.
 *   - Every `intervalMs`: re-checks `canFetch()` on each provider,
 *     fires `fetch()` in parallel for fetchable ones, merges the
 *     results into the cache, broadcasts on any change.
 *   - On auth-complete from a manager: immediately refreshes that
 *     one provider so the pill appears within seconds of sign-in.
 *   - On sign-out: that provider's entry is deleted from the cache
 *     on the next tick (canFetch=false → omitted from the broadcast
 *     map).
 */

import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap } from "../shared/types.js";
import type { LimitsProvider, LimitsSkipTick } from "./limits/types.js";
import { LIMITS_SKIP_TICK } from "./limits/types.js";

export interface LimitsPollerOptions {
  /** Map of registered providers, keyed by agent id. */
  providers: Map<AgentId, LimitsProvider>;
  /** Broadcast helper, typically `sseBroadcast` from index.ts. */
  sseBroadcast: (event: string, data: unknown) => void;
  /**
   * Cadence for the main loop. Defaults to 30 minutes — a long
   * safety heartbeat. Fresh data primarily flows in via
   * `triggerProviderRefresh()` on agent-turn completion (Claude)
   * and `recordCodexRateLimits()` from the agent event stream
   * (Codex); the periodic timer exists only to refresh idle tabs
   * that haven't run a turn in a long time. Anthropic's
   * `/api/oauth/usage` endpoint is aggressively rate-limited
   * server-side (returns 429 with `retry-after: 0` after a few
   * calls — see plan.md "Refresh strategy"), so the wall-clock
   * cadence is deliberately lazy.
   */
  intervalMs?: number;
  /**
   * Maximum backoff applied to a single provider after consecutive
   * 5xx / schema / network failures. Defaults to 30 minutes.
   */
  maxBackoffMs?: number;
  /**
   * Default backoff when a provider returns 429 without a
   * Retry-After header. Defaults to 30 minutes — meaningfully
   * longer than the normal cadence so a rate-limit response
   * visibly slows polling down rather than nudging it.
   */
  default429BackoffMs?: number;
  /**
   * Minimum interval between turn-driven `triggerProviderRefresh()`
   * fetches for the same provider. A user running a tight burst of
   * turns shouldn't spam `/api/oauth/usage` and earn a 429 — the
   * upstream numbers don't change that fast anyway. Defaults to
   * 90 seconds.
   */
  triggerDebounceMs?: number;
}

interface PerProviderState {
  /** Last seen snapshot. Used for delta detection. */
  lastSnapshot?: SubscriptionLimits;
  /** Number of consecutive 5xx/network/schema failures. */
  consecutiveFailures: number;
  /**
   * Epoch ms before which we should not poll. Set by
   * 429 (Retry-After) and exponential backoff.
   */
  pollNotBefore: number;
  /**
   * Set after a 401/403; cleared by `markAuthRefreshed()`. While
   * true, the provider is skipped on every tick — auth is the only
   * fix, no point hammering the endpoint.
   */
  authStalled: boolean;
  /**
   * Epoch ms of the most recent `fetch()` call (regardless of
   * outcome). Used by `triggerProviderRefresh()` to debounce
   * turn-driven refreshes so a tight burst of turns doesn't earn
   * a 429.
   */
  lastFetchAttemptAt: number;
}

export class LimitsPoller {
  private providers: Map<AgentId, LimitsProvider>;
  private sseBroadcast: (event: string, data: unknown) => void;
  private intervalMs: number;
  private maxBackoffMs: number;
  private default429BackoffMs: number;
  private triggerDebounceMs: number;

  private cache = new Map<AgentId, SubscriptionLimits>();
  private state = new Map<AgentId, PerProviderState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks if a fetch overruns intervalMs. */
  private tickInFlight = false;

  constructor(opts: LimitsPollerOptions) {
    this.providers = opts.providers;
    this.sseBroadcast = opts.sseBroadcast;
    this.intervalMs = opts.intervalMs ?? 30 * 60_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30 * 60_000;
    this.default429BackoffMs = opts.default429BackoffMs ?? 30 * 60_000;
    this.triggerDebounceMs = opts.triggerDebounceMs ?? 90_000;
    for (const id of this.providers.keys()) {
      this.state.set(id, {
        consecutiveFailures: 0,
        pollNotBefore: 0,
        authStalled: false,
        lastFetchAttemptAt: 0,
      });
    }
  }

  /**
   * Snapshot of the current cache, used by the SSE initial-connect
   * burst in index.ts. Returns a plain object keyed by agent id —
   * providers absent from the cache are omitted.
   */
  getSnapshot(): SubscriptionLimitsMap {
    const out: SubscriptionLimitsMap = {};
    for (const [id, snap] of this.cache) {
      out[id] = snap;
    }
    return out;
  }

  /**
   * Start the polling loop. Idempotent — calling twice is a no-op.
   * Fires one immediate poll so the snapshot is populated before
   * the first interval elapses.
   */
  start(): void {
    if (this.timer !== null) return;
    // Don't keep the event loop alive just for the limits poller.
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        console.error("[limits-poller] interval tick failed:", err);
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    void this.tick().catch((err: unknown) => {
      console.error("[limits-poller] initial tick failed:", err);
    });
  }

  /** Stop the polling loop. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Notify the poller that a specific provider's auth has been
   * refreshed (e.g. `auth_complete` from AuthManager). Clears any
   * `authStalled` flag and triggers an immediate refresh of just
   * that provider so its pill appears within seconds of sign-in.
   */
  markAuthRefreshed(agentId: AgentId): void {
    const state = this.state.get(agentId);
    if (state) {
      state.authStalled = false;
      state.consecutiveFailures = 0;
      state.pollNotBefore = 0;
    }
    void this.refreshOne(agentId).catch((err: unknown) => {
      console.error(`[limits-poller] auth-refresh poll for ${agentId} failed:`, err);
    });
  }

  /**
   * Trigger a refresh for a specific provider tied to a user action
   * (typically an agent-turn completion). Unlike `markAuthRefreshed`
   * this does NOT clear the authStalled / failure counters — it
   * respects them so an active user can't defeat a 429 backoff.
   *
   * Debounced: if a `fetch()` for this provider ran within
   * `triggerDebounceMs`, the trigger is a no-op. The upstream usage
   * numbers don't change faster than that anyway, and Anthropic's
   * `/api/oauth/usage` will 429 us into a 30-min penalty if we
   * spam it during a tight burst of turns.
   *
   * This is the primary refresh path for Claude — see
   * `agent-execution.ts`'s `agent_result` handler.
   */
  triggerProviderRefresh(agentId: AgentId): void {
    const state = this.state.get(agentId);
    if (!state) return;
    if (state.authStalled) return;
    const now = Date.now();
    if (state.pollNotBefore > now) return;
    if (now - state.lastFetchAttemptAt < this.triggerDebounceMs) return;
    void this.refreshOne(agentId).catch((err: unknown) => {
      console.error(`[limits-poller] triggered refresh for ${agentId} failed:`, err);
    });
  }

  /**
   * Notify the poller that a provider's credentials have been
   * cleared. Deletes the cached snapshot and broadcasts so the
   * client drops the corresponding pill immediately. No fetch is
   * fired — there's nothing left to authenticate.
   */
  markSignedOut(agentId: AgentId): void {
    const had = this.cache.delete(agentId);
    const state = this.state.get(agentId);
    if (state) {
      state.authStalled = false;
      state.consecutiveFailures = 0;
      state.pollNotBefore = 0;
      state.lastSnapshot = undefined;
      state.lastFetchAttemptAt = 0;
    }
    if (had) {
      this.broadcast();
    }
  }

  /** Single tick of the poll loop. Public for tests. */
  async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = Date.now();
      const fetches: Promise<{ agentId: AgentId; snapshot: SubscriptionLimits | null | LimitsSkipTick }>[] = [];

      for (const [agentId, provider] of this.providers) {
        const state = this.ensureState(agentId);
        if (state.authStalled) continue;
        if (state.pollNotBefore > now) continue;

        // Cheap precheck — providers cache their last `canFetch()`
        // result. Returns false on first call until at least one
        // `fetch()` has run; the providers all expose a
        // `refreshFetchable()` we use below to ensure the first
        // tick still picks up fetchable accounts.
        const fetchable = provider.canFetch();
        if (!fetchable) {
          // Try to refresh the provider's cache (async file read).
          // If it stays unfetchable, drop any existing snapshot for
          // that provider so the client's pill disappears.
          fetches.push(
            (async () => {
              const refreshed = await maybeRefreshFetchable(provider);
              if (!refreshed) {
                return { agentId, snapshot: null };
              }
              state.lastFetchAttemptAt = Date.now();
              return { agentId, snapshot: await provider.fetch() };
            })(),
          );
          continue;
        }
        state.lastFetchAttemptAt = now;
        fetches.push(
          (async () => ({ agentId, snapshot: await provider.fetch() }))(),
        );
      }

      const results = await Promise.allSettled(fetches);

      let changed = false;
      for (const result of results) {
        if (result.status === "rejected") {
          // Providers are supposed to never throw. If one slips
          // through, log it; we don't have an agentId binding here
          // because the rejection happened inside the inner async
          // — so we can't mutate per-provider state. This is rare.
          console.error("[limits-poller] provider rejected unexpectedly:", result.reason);
          continue;
        }
        const { agentId, snapshot } = result.value;
        // Skip sentinel — provider deliberately declined to fetch
        // (e.g. its access token is expired but refreshable). Leave
        // the cache and per-provider state untouched.
        if (snapshot === LIMITS_SKIP_TICK) continue;
        if (this.applySnapshot(agentId, snapshot)) {
          changed = true;
        }
      }

      if (changed) this.broadcast();
    } finally {
      this.tickInFlight = false;
    }
  }

  // ---- Internals ----

  private async refreshOne(agentId: AgentId): Promise<void> {
    const provider = this.providers.get(agentId);
    if (!provider) return;
    const state = this.ensureState(agentId);
    if (state.authStalled) return;

    const refreshed = await maybeRefreshFetchable(provider);
    if (refreshed) state.lastFetchAttemptAt = Date.now();
    const snapshot = refreshed ? await provider.fetch() : null;
    if (snapshot === LIMITS_SKIP_TICK) return;
    if (this.applySnapshot(agentId, snapshot)) {
      this.broadcast();
    }
  }

  /**
   * Merge a fresh snapshot into the cache and update the
   * per-provider state. Returns `true` if the cache changed in a
   * way that should trigger a broadcast.
   *
   * Stale-data preservation: when a fresh fetch fails (`error` set)
   * but we have a prior successful snapshot for this provider, we
   * keep the prior data fields and attach only the new error reason.
   * The cached `fetchedAt` stays pinned to when the data was
   * actually fresh, so the UI can compute "last refreshed N min
   * ago." A subsequent successful fetch replaces the snapshot
   * wholesale, clearing the staleness.
   */
  private applySnapshot(agentId: AgentId, snapshot: SubscriptionLimits | null): boolean {
    const state = this.ensureState(agentId);

    if (snapshot === null) {
      // Provider unfetchable (canFetch=false, e.g. credentials
      // cleared). Drop any existing entry — sign-out propagates.
      const had = this.cache.delete(agentId);
      state.lastSnapshot = undefined;
      return had;
    }

    // Apply backoff classification on the *fresh* error, regardless
    // of whether we end up merging or replacing below.
    if (snapshot.error === "auth expired") {
      state.authStalled = true;
      state.consecutiveFailures = 0;
      state.pollNotBefore = 0;
    } else if (snapshot.error === "rate limited") {
      state.pollNotBefore = Date.now() + this.default429BackoffMs;
      // Don't bump the generic failure counter — a 429 isn't an outage.
    } else if (snapshot.error) {
      state.consecutiveFailures += 1;
      const backoff = Math.min(
        this.maxBackoffMs,
        this.intervalMs * 2 ** (state.consecutiveFailures - 1),
      );
      state.pollNotBefore = Date.now() + backoff;
    } else {
      // Success — clear failure tracking.
      state.consecutiveFailures = 0;
      state.pollNotBefore = 0;
    }

    // Decide what to store: merge stale-but-present data with the
    // fresh error, or take the fresh snapshot as-is.
    const prev = state.lastSnapshot;
    const effective: SubscriptionLimits =
      snapshot.error && prev && hasData(prev)
        ? {
            ...prev,
            error: snapshot.error,
            // Preserve prev.fetchedAt — that's when the *data* was
            // fresh; the failed refresh attempt at `snapshot.fetchedAt`
            // is information we discard.
          }
        : snapshot;

    const isChange =
      !prev ||
      prev.error !== effective.error ||
      prev.plan !== effective.plan ||
      !windowEqual(prev.session, effective.session) ||
      !windowEqual(prev.weekly, effective.weekly) ||
      !windowEqual(prev.weeklyOpus ?? null, effective.weeklyOpus ?? null) ||
      !windowEqual(prev.weeklySonnet ?? null, effective.weeklySonnet ?? null);

    this.cache.set(agentId, effective);
    state.lastSnapshot = effective;
    return isChange;
  }

  private broadcast(): void {
    this.sseBroadcast("subscription_limits", { limits: this.getSnapshot() });
  }

  private ensureState(agentId: AgentId): PerProviderState {
    let s = this.state.get(agentId);
    if (!s) {
      s = { consecutiveFailures: 0, pollNotBefore: 0, authStalled: false, lastFetchAttemptAt: 0 };
      this.state.set(agentId, s);
    }
    return s;
  }
}

/**
 * Providers expose an optional `refreshFetchable()` method that
 * primes their `canFetch()` cache via an async credential lookup.
 * If the provider doesn't expose it, fall back to the cached value.
 * Exported for unit tests.
 */
export async function maybeRefreshFetchable(provider: LimitsProvider): Promise<boolean> {
  const maybeRefresh = (provider as LimitsProvider & {
    refreshFetchable?: () => Promise<boolean>;
  }).refreshFetchable;
  if (typeof maybeRefresh === "function") {
    try {
      return await maybeRefresh.call(provider);
    } catch (err) {
      console.warn("[limits-poller] refreshFetchable failed:", err);
      return provider.canFetch();
    }
  }
  return provider.canFetch();
}

function windowEqual(
  a: SubscriptionLimits["session"],
  b: SubscriptionLimits["session"],
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.usedPct === b.usedPct && a.resetAt === b.resetAt;
}

function hasData(s: SubscriptionLimits): boolean {
  return (
    s.session !== null ||
    s.weekly !== null ||
    (s.weeklyOpus ?? null) !== null ||
    (s.weeklySonnet ?? null) !== null
  );
}
