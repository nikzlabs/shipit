/**
 * Orchestrator-only `LimitsProvider` interface. The matching domain
 * type `SubscriptionLimits` lives in
 * `src/server/shared/types/usage-limits-types.ts` so it's
 * client-importable; providers themselves are server-only because
 * they perform OAuth-authenticated HTTP fetches against upstream
 * APIs.
 *
 * See docs/135-subscription-limits-badge/plan.md.
 */

import type { AgentId, SubscriptionLimits } from "../../shared/types.js";

export interface LimitsProvider {
  /** Which agent backend this provider belongs to. */
  readonly agentId: AgentId;

  /**
   * Cheap synchronous check: do we have enough auth + config to even
   * try a fetch? Returns false for API-key paths (Anthropic /
   * OpenAI pay-as-you-go) and when no credentials are loaded.
   *
   * Providers that report `false` are omitted from the broadcast map
   * entirely — the client doesn't see a key for them and renders no
   * pill. Flipping to `true` (e.g. after a fresh sign-in) makes the
   * next poll include the provider.
   */
  canFetch(): boolean;

  /**
   * Fetch a fresh snapshot. Must never throw — failures should be
   * returned as a snapshot with `error` populated so the cache /
   * broadcast pipeline can react uniformly. Returning `null` means
   * "the provider became unfetchable between `canFetch()` and the
   * actual fetch" (e.g. credentials were cleared mid-poll); the
   * caller treats this the same as `canFetch() === false`.
   */
  fetch(): Promise<SubscriptionLimits | null>;
}

/**
 * Classified failure modes returned by `fetchUsage*` helpers so the
 * poller can apply the right backoff. Plain `Error` is used for the
 * "unexpected schema" case — the caller treats that the same as 5xx.
 */
export type LimitsFetchError =
  | { kind: "auth"; message: string }
  | { kind: "rate_limited"; retryAfterSec: number | null; message: string }
  | { kind: "transient"; message: string };
