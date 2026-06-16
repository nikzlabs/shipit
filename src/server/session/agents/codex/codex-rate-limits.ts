/**
 * Rate-limit and token-usage tracking for the Codex adapter.
 *
 * The Codex App Server pushes two streams of telemetry: `thread/tokenUsage/
 * updated` (per-turn billing + real context occupancy) and
 * `account/rateLimits/updated` (the 5h session + weekly subscription windows).
 * `CodexRateLimits` accumulates the latest snapshot of each so the adapter can
 * surface token usage at turn end, emit a combined `agent_rate_limits` badge
 * update, and rewrite a known misleading "monthly usage limit" error message.
 */

import type { AgentEvent } from "../agent-process.js";

/**
 * Token usage snapshot from a `thread/tokenUsage/updated` notification.
 * `total` is the cumulative turn rollup (billing); `last` is the most recent
 * API call (real context-window occupancy — see AgentResultEvent.contextTokens).
 */
export interface CodexTokenUsage {
  total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  last?: { totalTokens?: number };
  modelContextWindow?: number;
}

/**
 * One rate-limit window from an `account/rateLimits/updated` notification.
 * `usedPercent` is 0–100, `resetsAt` is epoch *seconds*, `windowDurationMins`
 * distinguishes the 5-hour (300) and weekly (10080) windows. The app-server
 * sends two: `primary` (the 5h session window) and `secondary` (weekly).
 */
interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export class CodexRateLimits {
  /** Latest token usage from `thread/tokenUsage/updated`, surfaced at turn end. */
  private _lastTokenUsage: CodexTokenUsage | null = null;

  /** Latest subscription rate-limit snapshot pushed by the app-server. */
  private lastRateLimits: {
    session: { usedPct: number; resetAt: string } | null;
    weekly: { usedPct: number; resetAt: string } | null;
  } = { session: null, weekly: null };

  get lastTokenUsage(): CodexTokenUsage | null {
    return this._lastTokenUsage;
  }

  /**
   * Record a `thread/tokenUsage/updated` snapshot. A null/undefined payload
   * keeps the previous snapshot rather than clobbering it.
   */
  recordTokenUsage(tokenUsage: CodexTokenUsage | undefined): void {
    this._lastTokenUsage = tokenUsage ?? this._lastTokenUsage;
  }

  /**
   * Map an `account/rateLimits/updated` notification to an `agent_rate_limits`
   * event. The app-server reports two windows — `primary` (5h session) and
   * `secondary` (weekly) — the same data it draws its `/status` line from. The
   * orchestrator routes this into the subscription-limits badge. Returns null
   * when neither window parses, so a malformed payload leaves the badge (and
   * the stored snapshot) on its last value.
   */
  updateRateLimits(params: Record<string, unknown>): AgentEvent | null {
    const rl = params.rateLimits as Record<string, unknown> | undefined;
    if (!rl || typeof rl !== "object") return null;

    const session = this.parseRateWindow(rl.primary);
    const weekly = this.parseRateWindow(rl.secondary);
    if (!session && !weekly) return null;

    this.lastRateLimits = { session, weekly };
    return { type: "agent_rate_limits", session, weekly };
  }

  /** Normalize one Codex rate-limit window into `{ usedPct, resetAt }`. */
  private parseRateWindow(
    raw: unknown,
  ): { usedPct: number; resetAt: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const w = raw as CodexRateLimitWindow;
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
    if (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt) || w.resetsAt <= 0) return null;
    const usedPct = Math.min(100, Math.max(0, w.usedPercent));
    // resetsAt is epoch seconds; tolerate a ms value defensively.
    const ms = w.resetsAt < 10_000_000_000 ? w.resetsAt * 1000 : w.resetsAt;
    return { usedPct, resetAt: new Date(ms).toISOString() };
  }

  /**
   * Codex app-server can return the generic "org monthly usage limit" text
   * even when its own pushed telemetry says the rolling 5h window is the
   * exhausted meter. Correct only that known mismatch; all other upstream
   * errors pass through unchanged.
   */
  normalizeJsonRpcError(message: string): string {
    if (!/monthly usage limit/i.test(message)) return message;

    const sessionLimit = this.lastRateLimits.session;
    if (!sessionLimit || sessionLimit.usedPct < 100) return message;

    const reset = new Date(sessionLimit.resetAt);
    const resetText = Number.isNaN(reset.getTime())
      ? sessionLimit.resetAt
      : reset.toISOString();
    return `You've hit Codex's 5h usage limit. It resets at ${resetText}.`;
  }
}
