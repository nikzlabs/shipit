/**
 * LimitsRegistry — orchestrator-level cache + SSE broadcaster for every
 * registered agent backend's subscription rate-limit windows.
 *
 * Architecture (docs/135 — "Refresh strategy"):
 *
 *   - **Both providers are event-fed.** Claude's snapshots arrive on the
 *     CLI's `rate_limit_event` stream messages (parsed by `ClaudeAdapter`,
 *     emitted as `AgentRateLimitsEvent`); Codex's arrive on the
 *     app-server's `account/rateLimits/updated` notification (parsed by
 *     `CodexAdapter`, same event type). The orchestrator routes both
 *     through `recordAgentRateLimits(agentId, …)` which calls
 *     `provider.setRateLimits(…)` and then `markAuthRefreshed(agentId)`
 *     so this registry rebroadcasts.
 *   - **No HTTP polling.** Anthropic's `/api/oauth/usage` is aggressively
 *     server-side rate-limited (`HTTP 429` with `retry-after: 0` after a
 *     handful of calls, ~30 min lockout — see
 *     https://github.com/anthropics/claude-code/issues/31637). We don't
 *     touch it; the data we'd have polled for is on every API response's
 *     `anthropic-ratelimit-unified-*` headers, which the CLI already
 *     surfaces via `rate_limit_event`.
 *   - **Sign-in / sign-out propagate via auth events.** `markAuthRefreshed`
 *     re-derives the plan tier from the credentials file (Codex's
 *     `auth.json`, Claude's `.credentials.json`) and broadcasts.
 *     `markSignedOut` drops the entry so the pill disappears.
 *   - **No active-agent gating.** The badge shows one pill per provider
 *     that has at least one snapshot — same global feel as the rest of
 *     the header.
 */

import type {
  AgentId,
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsMap,
} from "../shared/types.js";
import type { LimitsProvider } from "./agents/types.js";

export interface LimitsRegistryOptions {
  /** Map of registered providers, keyed by agent id. */
  providers: Map<AgentId, LimitsProvider>;
  /** Broadcast helper, typically `sseBroadcast` from index.ts. */
  sseBroadcast: (event: string, data: unknown) => void;
}

export class LimitsRegistry {
  private providers: Map<AgentId, LimitsProvider>;
  private sseBroadcast: (event: string, data: unknown) => void;
  /**
   * docs/150 — `agentId → routeId → snapshot`. The inner key is a
   * provider-account id or a reserved route id, so two connected subscriptions
   * for the same provider stay independent instead of overwriting each other.
   */
  private cache = new Map<AgentId, Map<string, SubscriptionLimits>>();

  constructor(opts: LimitsRegistryOptions) {
    this.providers = opts.providers;
    this.sseBroadcast = opts.sseBroadcast;
  }

  /**
   * Snapshot of the current cache, used by the SSE initial-connect burst
   * in index.ts. Returns a plain object keyed by agent id — providers
   * absent from the cache are omitted.
   */
  getSnapshot(): SubscriptionLimitsMap {
    const out: SubscriptionLimitsMap = {};
    for (const [agentId, byRoute] of this.cache) {
      if (byRoute.size === 0) continue;
      out[agentId] = Object.fromEntries(byRoute);
    }
    return out;
  }

  /**
   * Re-pull a single provider's snapshot and broadcast if it changed.
   * Called when either:
   *   - the provider's auth manager fires `auth_complete` (sign-in /
   *     credential rotation) — the plan tier may have changed; or
   *   - `recordAgentRateLimits` just pushed a fresh `setRateLimits()`
   *     payload into the provider — the windows changed.
   */
  markAuthRefreshed(agentId: AgentId): void {
    void this.refreshOne(agentId).catch((err: unknown) => {
      console.error(`[limits] refresh for ${agentId} failed:`, err);
    });
  }

  /**
   * Run a provider's on-demand `/api/oauth/usage` fetch (Claude) and
   * rebroadcast the merged snapshot. `"manual"` is the user's refresh button;
   * `"seed"` is the once-per-sign-in baseline. No-ops for providers without an
   * on-demand path (Codex) or unknown agents. Never throws.
   *
   * Returns one result per route attempted, so the caller (the HTTP route
   * behind the pill's refresh button) can tell the user why nothing changed.
   */
  async refreshNow(
    agentId: AgentId,
    reason: "manual" | "seed",
    routeId?: string,
  ): Promise<LimitsRefreshResult[]> {
    const provider = this.providers.get(agentId);
    if (!provider?.refreshNow) {
      return routeId ? [{ routeId, outcome: "unavailable" }] : [];
    }
    // Without an explicit route this fans out over every route the provider
    // knows about — right for the once-per-sign-in seed, wrong for the pill's
    // button. Each route is a separate upstream call against a separate token,
    // and `/api/oauth/usage` allows only a handful before a ~30 min lockout, so
    // a fan-out press spends every OTHER account's budget too. The badge sends
    // its own `routeId` for exactly that reason (docs/161).
    const routes = routeId ? [routeId] : provider.routeIds();
    const results: LimitsRefreshResult[] = [];
    for (const route of routes) {
      try {
        results.push(await provider.refreshNow(reason, route));
      } catch (err) {
        console.error(`[limits] on-demand refresh for ${agentId}/${route} failed:`, err);
        results.push({ routeId: route, outcome: "failed", detail: errMsg(err) });
      }
    }
    await this.refreshOne(agentId);
    return results;
  }

  /**
   * Notify the registry that a provider's credentials have been cleared.
   * Deletes the cached snapshot and broadcasts so the client drops the
   * corresponding pill immediately.
   */
  markSignedOut(agentId: AgentId, routeId?: string): void {
    if (routeId === undefined) {
      const had = this.cache.delete(agentId);
      if (had) this.broadcast();
      return;
    }
    // Disconnecting one account must not blank the other's pill.
    this.providers.get(agentId)?.forgetRoute(routeId);
    const byRoute = this.cache.get(agentId);
    if (byRoute?.delete(routeId)) {
      if (byRoute.size === 0) this.cache.delete(agentId);
      this.broadcast();
    }
  }

  // ---- Internals ----

  private async refreshOne(agentId: AgentId): Promise<void> {
    const provider = this.providers.get(agentId);
    if (!provider) return;
    let changed = false;
    const live = new Set(provider.routeIds());
    for (const routeId of live) {
      const snapshot = await provider.fetch(routeId);
      if (this.applySnapshot(agentId, routeId, snapshot)) changed = true;
    }
    // Drop cached routes the provider has since forgotten (sign-out), so a
    // stale pill can't outlive its account.
    const byRoute = this.cache.get(agentId);
    if (byRoute) {
      for (const routeId of [...byRoute.keys()]) {
        if (!live.has(routeId)) {
          byRoute.delete(routeId);
          changed = true;
        }
      }
      if (byRoute.size === 0) this.cache.delete(agentId);
    }
    if (changed) this.broadcast();
  }

  /**
   * Merge a fresh snapshot into the cache. Returns `true` if the cache
   * changed in a way that should trigger a broadcast.
   */
  private applySnapshot(
    agentId: AgentId,
    routeId: string,
    snapshot: SubscriptionLimits | null,
  ): boolean {
    const byRoute = this.cache.get(agentId);
    if (snapshot === null) {
      if (!byRoute?.delete(routeId)) return false;
      if (byRoute.size === 0) this.cache.delete(agentId);
      return true;
    }
    const prev = byRoute?.get(routeId);
    const isChange =
      prev?.plan !== snapshot.plan ||
      prev.lockedUntil !== snapshot.lockedUntil ||
      !windowEqual(prev.session, snapshot.session) ||
      !windowEqual(prev.weekly, snapshot.weekly);
    if (byRoute) byRoute.set(routeId, snapshot);
    else this.cache.set(agentId, new Map([[routeId, snapshot]]));
    return isChange;
  }

  private broadcast(): void {
    this.sseBroadcast("subscription_limits", { limits: this.getSnapshot() });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function windowEqual(
  a: SubscriptionLimits["session"],
  b: SubscriptionLimits["session"],
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.usedPct === b.usedPct && a.resetAt === b.resetAt;
}
