/**
 * SubscriptionLimits — single-snapshot shape for an agent's
 * subscription rate-limit usage. Client-importable; the provider
 * interface that produces these snapshots lives in
 * `src/server/orchestrator/limits/types.ts` and is orchestrator-only.
 *
 * See docs/135-subscription-limits-badge/plan.md.
 */

import type { BillingMode } from "../catalogue/types.js";
import { credentialModeKey } from "./domain-types/credential-route.js";

export interface SubscriptionLimitsWindow {
  /**
   * Percentage of the window currently consumed (0–100, clamped). `null`
   * means utilization was not reported by the provider at this usage
   * level (e.g. Claude CLI 2.1.140 only includes `utilization` in
   * `rate_limit_event` once a warning threshold trips). The window still
   * exists and has a `resetAt` — the UI should render the countdown
   * without a percentage rather than fake a number.
   */
  usedPct: number | null;
  /** ISO timestamp of when the window resets. */
  resetAt: string;
  /** Stable beginning of the displayed window, when the provider supplies it. */
  startedAt?: string;
  /**
   * Where this window's number came from. `"event"` = the CLI's
   * `rate_limit_event` stream (free, live near the limit, but `usedPct` is
   * `null` below a warning threshold). `"usage-api"` = an on-demand
   * `/api/oauth/usage` fetch (the only source of a low-usage number). Lets
   * the tooltip explain provenance. Absent on legacy/Codex windows.
   */
  source?: "event" | "usage-api";
}

export interface SubscriptionLimits {
  /**
   * docs/252 req 10 — usage is reported per **billing mode of a service**, not
   * per agent. `agentId` was the conflation this feature removes: a harness is
   * not a vendor, so it cannot own a quota, and one service can hold both a
   * subscription (which has an allowance) and a key (which has none).
   *
   * Only a `sub` mode ever produces a snapshot — a key has no allowance and
   * nothing that resets, and req 10 keeps that slot empty rather than filling
   * it with a placeholder. The mode is still carried explicitly so the key is
   * uniform with every other `(service, mode)` map in this feature.
   */
  serviceId: string;
  billingMode: BillingMode;
  /**
   * docs/150 req 10 — which *route* produced these numbers: a provider-account
   * id (`acct_…`) or a reserved route id (`claude-env-oauth`,
   * `claude-api-key`).
   *
   * Quota belongs to the subscription, not the provider: two connected
   * Anthropic accounts have two independent 5h windows, and keying only by
   * provider made the badge show whichever account last took a turn.
   * Duplicated from the map key so a snapshot stays self-describing once it has
   * been pulled out of the map.
   */
  routeId: string;
  /**
   * Subscription tier name to render in the tooltip
   * (e.g. "Pro", "Max 20x", "Plus"). Null when the provider can't
   * determine it.
   */
  plan: string | null;
  /** Rolling short-window quota (Claude: 5h, Codex: 5h). */
  session: SubscriptionLimitsWindow | null;
  /** Weekly quota across all models. */
  weekly: SubscriptionLimitsWindow | null;
  /** Epoch ms when this snapshot was last updated. */
  fetchedAt: number;
  /**
   * Epoch ms until which an on-demand `/api/oauth/usage` refresh is locked
   * out after a 429 (Anthropic rate-limits that endpoint to a handful of
   * calls, then 429s for ~30 min — see docs/161). The client disables the
   * refresh button and shows a countdown while `now < lockedUntil`. Absent
   * when not locked. Providers without an on-demand path (Codex) never set
   * it.
   */
  lockedUntil?: number;
}

/**
 * Map sent over the wire on every `subscription_limits` SSE broadcast:
 * **`${serviceId}:${billingMode}` → route → limits** (docs/150 req 10,
 * re-keyed by docs/252 req 10).
 *
 * The OUTER key moved off `AgentId`; the inner one deliberately did not.
 * Dropping the route would be a regression, not a simplification: two connected
 * subscriptions have two independent 5h windows, two independent
 * `/api/oauth/usage` results and two independent 429 lockouts, and req 12's
 * failover has to know *which* subscription is exhausted before moving to
 * another.
 *
 * So a user with two Anthropic subscriptions gets two independent entries under
 * `anthropic:sub` rather than one that flickers between whichever account last
 * took a turn.
 * Routes with no snapshot are **omitted** (not stored as `null`). Connected
 * provider accounts still render an unknown-state pill from the account
 * registry; this map supplies readings, not account visibility. Reserved
 * routes have no account row, so their pill remains snapshot-driven. The
 * client replaces its store map wholesale on each broadcast so stale readings
 * and signed-out reserved routes propagate naturally.
 */
export type SubscriptionLimitsMap = Record<string, Record<string, SubscriptionLimits> | undefined>;

/** The outer key of {@link SubscriptionLimitsMap} for one snapshot. */
export function limitsModeKey(of: { serviceId: string; billingMode: BillingMode }): string {
  return credentialModeKey(of.serviceId, of.billingMode);
}

/**
 * Why an on-demand usage refresh did or didn't produce new numbers.
 *
 * Every one of these except `"updated"` used to be a silent `return` inside the
 * provider, which is what made the refresh button look broken: the click
 * spun, the pill stayed at `—`, and nothing anywhere said why. The outcome
 * travels back on the `POST /api/limits/refresh` response so the button can
 * explain itself.
 */
export type LimitsRefreshOutcome =
  /** Fresh numbers fetched and cached. */
  | "updated"
  /** A previous 429 is still locked out; no request was made. */
  | "locked"
  /** This attempt was 429'd — `lockedUntil` says until when. */
  | "rate-limited"
  /** No usable OAuth token on disk for this route (signed out / never signed in). */
  | "no-credentials"
  /** The route's access token is at/past expiry, so the call would 401. */
  | "expired-token"
  /** Network error, non-429 HTTP error, or an unparseable payload. */
  | "failed"
  /** Nothing to do: unknown route, or a provider with no on-demand path (Codex). */
  | "unavailable"
  /** `reason: "seed"` self-skip — this route already has a usage-api snapshot. */
  | "skipped";

/** One route's refresh outcome, returned per route by `POST /api/limits/refresh`. */
export interface LimitsRefreshResult {
  routeId: string;
  outcome: LimitsRefreshOutcome;
  /** Epoch ms the lockout elapses, when `outcome` is `locked` / `rate-limited`. */
  lockedUntil?: number;
  /** Short human-readable detail for the button tooltip (HTTP status, error text). */
  detail?: string;
}

/**
 * Flatten the nested map to a list — what most consumers actually want (render
 * each pill, find the worst window, ask whether anything is exhausted). Each
 * entry carries its own `serviceId`/`billingMode`/`routeId`, so nothing has to
 * be re-derived from the nesting.
 */
export function listSubscriptionLimits(map: SubscriptionLimitsMap): SubscriptionLimits[] {
  const out: SubscriptionLimits[] = [];
  for (const byRoute of Object.values(map)) {
    if (!byRoute) continue;
    // Defensive: this map arrives over the wire, and a hole here would
    // otherwise throw inside every consumer that reads `.serviceId`.
    for (const snap of Object.values(byRoute)) if (snap) out.push(snap);
  }
  return out;
}
