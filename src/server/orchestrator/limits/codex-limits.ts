/**
 * CodexLimitsProvider — surfaces the user's Codex subscription
 * rate-limit usage in the header badge.
 *
 * Unlike Claude, Codex has no usable HTTP usage endpoint we can poll
 * (the community-reported `/backend-api/codex/usage` path 401s even
 * with a valid token — see docs/135 "API research"). Instead the Codex
 * App Server *pushes* the exact numbers it uses for its own `/status`
 * line via an `account/rateLimits/updated` JSON-RPC notification during
 * a turn. `CodexAdapter` captures that and emits an `agent_rate_limits`
 * AgentEvent; the orchestrator feeds it here via `setRateLimits()`.
 *
 * This provider is *event-fed*: `fetch()` returns the latest pushed
 * snapshot (enriched with the plan tier read from the auth token), and
 * `canFetch()` is true once at least one turn has delivered a snapshot.
 * The orchestrator's `LimitsRegistry` rebroadcasts whenever a fresh
 * `setRateLimits()` lands, so the badge updates within seconds of the
 * incoming event.
 */

import type { CodexAuthManager } from "../codex-auth.js";
import type { LimitsProvider } from "./types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../shared/types.js";

export interface CodexLimitsDeps {
  codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class CodexLimitsProvider implements LimitsProvider {
  readonly agentId = "codex" as const;
  private codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  private now: () => number;
  /**
   * Latest windows pushed from the Codex app-server stream. `null` until
   * the first `account/rateLimits/updated` arrives (i.e. until a turn has
   * run), which is also what gates `canFetch()`.
   */
  private latest: {
    session: SubscriptionLimitsWindow | null;
    weekly: SubscriptionLimitsWindow | null;
    at: number;
  } | null = null;

  constructor(deps: CodexLimitsDeps) {
    this.codexAuthManager = deps.codexAuthManager;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Record a fresh rate-limit snapshot pushed from a Codex turn. Called by
   * the orchestrator when an `agent_rate_limits` AgentEvent arrives. The
   * caller should follow this with `LimitsRegistry.markAuthRefreshed("codex")`
   * so the badge updates immediately rather than on the next event.
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
    // Plan tier isn't part of the rate-limit payload (`limitName` is null),
    // so — like Claude reading its tier from the credentials file — we pull
    // it from the auth token's JWT claim. A missing token just means no tier
    // in the tooltip; the usage numbers still render.
    let plan: string | null = null;
    const tokenResult = await this.codexAuthManager.getAccessToken();
    if (tokenResult.token !== null) {
      plan = tokenResult.plan;
    }
    return {
      agentId: "codex",
      plan,
      session: this.latest.session,
      weekly: this.latest.weekly,
      fetchedAt: this.latest.at,
    };
  }
}
