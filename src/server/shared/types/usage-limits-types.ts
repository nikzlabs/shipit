/**
 * SubscriptionLimits — single-snapshot shape for an agent's
 * subscription rate-limit usage. Client-importable; the provider
 * interface that produces these snapshots lives in
 * `src/server/orchestrator/limits/types.ts` and is orchestrator-only.
 *
 * See docs/135-subscription-limits-badge/plan.md.
 */

import type { AgentId } from "./agent-types.js";

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
  /** Which agent these numbers belong to. */
  agentId: AgentId;
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
 * **provider → route → limits** (docs/150 req 10).
 *
 * The inner key is a provider-account id or a reserved route id, so a user with
 * two Anthropic subscriptions gets two independent entries under `claude`
 * rather than one that flickers between whichever account last took a turn.
 * Routes with no snapshot are **omitted** (not stored as `null`). Connected
 * provider accounts still render an unknown-state pill from the account
 * registry; this map supplies readings, not account visibility. Reserved
 * routes have no account row, so their pill remains snapshot-driven. The
 * client replaces its store map wholesale on each broadcast so stale readings
 * and signed-out reserved routes propagate naturally.
 */
export type SubscriptionLimitsMap = Partial<Record<AgentId, Record<string, SubscriptionLimits>>>;

/**
 * Flatten the nested map to a list — what most consumers actually want (render
 * each pill, find the worst window, ask whether anything is exhausted). Each
 * entry carries its own `agentId`/`routeId`, so nothing has to be re-derived
 * from the nesting.
 */
export function listSubscriptionLimits(map: SubscriptionLimitsMap): SubscriptionLimits[] {
  const out: SubscriptionLimits[] = [];
  for (const byRoute of Object.values(map)) {
    if (!byRoute) continue;
    // Defensive: this map arrives over the wire, and a hole here would
    // otherwise throw inside every consumer that reads `.agentId`.
    for (const snap of Object.values(byRoute)) if (snap) out.push(snap);
  }
  return out;
}
