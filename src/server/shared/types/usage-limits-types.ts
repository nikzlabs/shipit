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
  /** Percentage of the window currently consumed (0–100, clamped). */
  usedPct: number;
  /** ISO timestamp of when the window resets. */
  resetAt: string;
}

export interface SubscriptionLimits {
  /** Which agent these numbers belong to. */
  agentId: AgentId;
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
  /**
   * Optional weekly Opus-only sub-quota — Claude Max only. Null
   * otherwise (and absent for non-Claude providers).
   */
  weeklyOpus?: SubscriptionLimitsWindow | null;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
  /**
   * Populated when the fetch failed (auth expired, 5xx, schema
   * mismatch, ...). The UI renders a neutral "—" pill with this
   * string as the tooltip rather than the numeric breakdown.
   */
  error?: string;
}

/**
 * Map sent over the wire on every `subscription_limits` SSE
 * broadcast. Providers that report `canFetch() === false` are
 * **omitted** from the map (not stored as `null`); a missing key
 * means "do not render a pill." The client replaces its store map
 * wholesale on each broadcast so sign-outs propagate naturally.
 */
export type SubscriptionLimitsMap = Partial<Record<AgentId, SubscriptionLimits>>;
