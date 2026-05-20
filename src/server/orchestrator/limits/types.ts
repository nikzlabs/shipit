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

/**
 * Sentinel a provider's `fetch()` may return to mean "skip this tick
 * — keep the last cached snapshot, don't broadcast, don't treat as
 * an error."
 *
 * Both the Claude and Codex credentials live in one shared file that
 * each agent's CLI refreshes *on every turn*. The access token in
 * that file is short-lived (hours); the refresh token is long-lived.
 * When a session sits idle past the access-token TTL nobody refreshes
 * the file, so the token on disk goes stale even though auth is
 * fundamentally valid. Hitting the upstream usage endpoint with the
 * stale token returns 401 → a misleading "auth expired" in the UI.
 *
 * When a provider can *see* (via the credential's `expiresAt`) that
 * its token is expired, it returns this sentinel instead of firing
 * the doomed request: the badge keeps its last-known numbers and
 * self-heals the moment any session runs a turn (which refreshes the
 * shared credential). See docs/135-subscription-limits-badge/plan.md.
 */
export const LIMITS_SKIP_TICK = Symbol("limits-skip-tick");
export type LimitsSkipTick = typeof LIMITS_SKIP_TICK;

/**
 * Skew applied when judging access-token expiry: treat a token as
 * expired slightly early so we don't fire a request that dies
 * mid-flight. 60s covers clock skew + request latency.
 */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * True when a *known* expiry is at/before `now + skew`. A `null`
 * expiry (env tokens, or a credentials schema that omits the field)
 * is never treated as expired — in that case we let a real upstream
 * 401 be the signal rather than guessing.
 */
export function isAccessTokenExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now + ACCESS_TOKEN_EXPIRY_SKEW_MS;
}

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
   * Returning `LIMITS_SKIP_TICK` means "leave the cache untouched
   * this tick" (see the sentinel's docstring).
   */
  fetch(): Promise<SubscriptionLimits | null | LimitsSkipTick>;
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
