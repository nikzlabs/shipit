/**
 * Orchestrator-only `LimitsProvider` interface. The matching domain
 * type `SubscriptionLimits` lives in
 * `src/server/shared/types/usage-limits-types.ts` so it's
 * client-importable; providers themselves are server-only.
 *
 * Both providers today are *event-fed*: their numbers arrive on the
 * agent's stream (`rate_limit_event` for Claude,
 * `account/rateLimits/updated` for Codex) and the orchestrator pushes
 * them into the provider via its `setRateLimits()` method.
 *
 * See docs/135-subscription-limits-badge/plan.md.
 */

import type { AgentId, SubscriptionLimits, SubscriptionLimitsWindow } from "../../shared/types.js";

export interface LimitsProvider {
  /** Which agent backend this provider belongs to. */
  readonly agentId: AgentId;

  /**
   * Cheap synchronous check: do we have enough auth + state to render a
   * pill? Returns false until the first `setRateLimits()` lands (event-
   * fed providers stay blank on cold start) and again after sign-out.
   * Providers that report `false` are omitted from the broadcast map
   * entirely — the client doesn't see a key for them and renders no
   * pill.
   */
  canFetch(): boolean;

  /**
   * Return the latest cached snapshot, enriched with derived fields
   * (e.g. plan tier read from credentials). Must never throw; returns
   * `null` when the provider has no snapshot yet or has been signed out.
   */
  fetch(): Promise<SubscriptionLimits | null>;

  /**
   * Record a fresh rate-limit snapshot pushed from an agent turn (Claude:
   * `rate_limit_event` stream messages; Codex: `account/rateLimits/updated`
   * notification). Promoted onto the interface so the orchestrator's
   * `recordAgentRateLimits` can be a one-line map lookup instead of an
   * if/else cascade keyed by `agentId`. (docs/155)
   */
  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
  ): void;
}
