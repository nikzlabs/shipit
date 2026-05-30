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

import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap } from "../shared/types.js";
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
  private cache = new Map<AgentId, SubscriptionLimits>();

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
    for (const [id, snap] of this.cache) {
      out[id] = snap;
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
   */
  async refreshNow(agentId: AgentId, reason: "manual" | "seed"): Promise<void> {
    const provider = this.providers.get(agentId);
    if (!provider?.refreshNow) return;
    try {
      await provider.refreshNow(reason);
    } catch (err) {
      console.error(`[limits] on-demand refresh for ${agentId} failed:`, err);
    }
    await this.refreshOne(agentId);
  }

  /**
   * Notify the registry that a provider's credentials have been cleared.
   * Deletes the cached snapshot and broadcasts so the client drops the
   * corresponding pill immediately.
   */
  markSignedOut(agentId: AgentId): void {
    const had = this.cache.delete(agentId);
    if (had) {
      this.broadcast();
    }
  }

  // ---- Internals ----

  private async refreshOne(agentId: AgentId): Promise<void> {
    const provider = this.providers.get(agentId);
    if (!provider) return;
    const snapshot = await provider.fetch();
    if (this.applySnapshot(agentId, snapshot)) {
      this.broadcast();
    }
  }

  /**
   * Merge a fresh snapshot into the cache. Returns `true` if the cache
   * changed in a way that should trigger a broadcast.
   */
  private applySnapshot(agentId: AgentId, snapshot: SubscriptionLimits | null): boolean {
    if (snapshot === null) {
      const had = this.cache.delete(agentId);
      return had;
    }
    const prev = this.cache.get(agentId);
    const isChange =
      prev?.plan !== snapshot.plan ||
      prev?.lockedUntil !== snapshot.lockedUntil ||
      !windowEqual(prev.session, snapshot.session) ||
      !windowEqual(prev.weekly, snapshot.weekly);
    this.cache.set(agentId, snapshot);
    return isChange;
  }

  private broadcast(): void {
    this.sseBroadcast("subscription_limits", { limits: this.getSnapshot() });
  }
}

function windowEqual(
  a: SubscriptionLimits["session"],
  b: SubscriptionLimits["session"],
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.usedPct === b.usedPct && a.resetAt === b.resetAt;
}
