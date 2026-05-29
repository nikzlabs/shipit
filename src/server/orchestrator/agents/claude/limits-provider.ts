/**
 * ClaudeLimitsProvider — event-fed snapshot of the user's Claude
 * subscription rate-limit windows for the header badge.
 *
 * Anthropic's `/api/oauth/usage` endpoint is aggressively server-side
 * rate-limited (returns 429 with `retry-after: 0` after a handful of
 * calls, ~30 min lockout — see docs/135 and
 * https://github.com/anthropics/claude-code/issues/31637). Polling it
 * leaves the badge stuck on 30-minute-old data.
 *
 * Instead, the Claude CLI emits `rate_limit_event` messages in its
 * `--output-format=stream-json` stream every time a window's utilization
 * changes — the data comes from Anthropic's `anthropic-ratelimit-unified-*`
 * response headers, so it's free and arrives on the very next API call.
 * `ClaudeAdapter` parses those events and emits a normalized
 * `agent_rate_limits` AgentEvent; the orchestrator routes it here via
 * `setRateLimits()`. Same pattern as `CodexLimitsProvider`.
 */

import type { AuthManager } from "./auth-manager.js";
import type { LimitsProvider } from "../types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../../shared/types.js";

export interface ClaudeLimitsDeps {
  authManager: Pick<AuthManager, "getAccessToken">;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class ClaudeLimitsProvider implements LimitsProvider {
  readonly agentId = "claude" as const;
  private authManager: Pick<AuthManager, "getAccessToken">;
  private now: () => number;
  /**
   * Latest windows pushed from the Claude CLI stream. `null` until the
   * first `rate_limit_event` arrives (typically on the first turn). This
   * is also what gates `canFetch()`.
   */
  private latest: {
    session: SubscriptionLimitsWindow | null;
    weekly: SubscriptionLimitsWindow | null;
    at: number;
  } | null = null;

  constructor(deps: ClaudeLimitsDeps) {
    this.authManager = deps.authManager;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Record a fresh rate-limit snapshot pushed from a Claude turn. Called
   * by the orchestrator's `recordAgentRateLimits` when an
   * `agent_rate_limits` AgentEvent arrives. The caller should follow this
   * with `LimitsRegistry.markAuthRefreshed("claude")` so the badge
   * updates immediately rather than on the next sweep.
   */
  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
  ): void {
    this.latest = { session, weekly, at: this.now() };
  }

  canFetch(): boolean {
    return this.latest !== null;
  }

  async refreshFetchable(): Promise<boolean> {
    return this.latest !== null;
  }

  async fetch(): Promise<SubscriptionLimits | null> {
    if (!this.latest) return null;
    // Plan tier isn't part of the rate-limit payload — pull it from the
    // credentials file via AuthManager. A missing token just means no
    // tier in the tooltip; the usage numbers still render.
    let plan: string | null = null;
    const tokenResult = await this.authManager.getAccessToken();
    if (tokenResult.token !== null) {
      plan = tokenResult.plan;
    }
    return {
      agentId: "claude",
      plan,
      session: this.latest.session,
      weekly: this.latest.weekly,
      fetchedAt: this.latest.at,
    };
  }
}
