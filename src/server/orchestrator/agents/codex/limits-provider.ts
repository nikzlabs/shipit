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

import type { CodexAuthManager } from "./auth-manager.js";
import type { LimitsProvider } from "../types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../../shared/types.js";

export interface CodexLimitsDeps {
  codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class CodexLimitsProvider implements LimitsProvider {
  // docs/252 req 10 — see `ClaudeLimitsProvider`: the allowance belongs to
  // OpenAI's subscription, not to the Codex harness.
  readonly serviceId = "openai";
  readonly billingMode = "sub" as const;
  private codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  private now: () => number;
  /**
   * Latest windows pushed from the Codex app-server stream, keyed by **route
   * id** (docs/150). Empty until the first `account/rateLimits/updated`
   * arrives for a route (i.e. until a turn has run on it), which is what gates
   * that route's presence in `routeIds()`. Keyed rather than single-slot
   * because two connected ChatGPT subscriptions have independent windows —
   * sharing one slot showed whichever account last took a turn.
   */
  private latest = new Map<string, {
    session: SubscriptionLimitsWindow | null;
    weekly: SubscriptionLimitsWindow | null;
    at: number;
  }>();

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
    routeId: string,
  ): void {
    const now = this.now();
    const previous = this.latest.get(routeId) ?? null;
    this.latest.set(routeId, {
      session: preserveWindowAnchor(previous?.session ?? null, session, now),
      weekly: preserveWindowAnchor(previous?.weekly ?? null, weekly, now),
      at: now,
    });
  }

  routeIds(): string[] {
    return [...this.latest.keys()];
  }

  forgetRoute(routeId: string): void {
    this.latest.delete(routeId);
  }

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    const latest = this.latest.get(routeId);
    if (!latest) return null;
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
      serviceId: this.serviceId,
      billingMode: this.billingMode,
      routeId,
      plan,
      session: latest.session,
      weekly: latest.weekly,
      // planning#454 — the app-server's `account/rateLimits/updated` carries
      // BOTH windows in one notification (`rateLimits.primary` / `.secondary`),
      // so a window missing from a reading is one the plan does not have, and
      // the pill must not draw a `5h · —` nothing will ever fill.
      //
      // This is a statement Claude's reader deliberately does NOT make: its
      // `rate_limit_event` delivers one window per event, so the same `null`
      // there means "not yet". Same field, opposite answer, and the difference
      // is a property of the SOURCE rather than of the vendor.
      availableWindows: [
        ...(latest.session ? (["session"] as const) : []),
        ...(latest.weekly ? (["weekly"] as const) : []),
      ],
      fetchedAt: latest.at,
    };
  }
}

/** Keep Codex's rolling reset updates from moving the time marker back to zero. */
function preserveWindowAnchor(
  previous: SubscriptionLimitsWindow | null,
  incoming: SubscriptionLimitsWindow | null,
  now: number,
): SubscriptionLimitsWindow | null {
  if (!incoming || !previous?.startedAt) return incoming;
  const previousReset = Date.parse(previous.resetAt);
  if (!Number.isFinite(previousReset) || previousReset <= now) return incoming;
  return { ...incoming, startedAt: previous.startedAt };
}
