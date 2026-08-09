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
  /**
   * **`inputTokens` INCLUDES `cachedInputTokens`** — measured against
   * codex-cli 0.146.0, not inferred. The adapter subtracts one from the other
   * before emitting `agent_result` so ShipIt's own token classes stay disjoint,
   * as Claude's already are; the rule is `disjointCodexTokens`
   * (`shared/codex-token-usage.ts`), shared with the orchestrator's `codex exec
   * --json` reader. Nothing downstream should re-derive that.
   */
  total?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
  last?: { totalTokens?: number };
  modelContextWindow?: number;
}

/**
 * One rate-limit window from an `account/rateLimits/updated` notification.
 * `usedPercent` is 0–100, `resetsAt` is epoch *seconds*, `windowDurationMins`
 * distinguishes the 5-hour (300) and weekly (10080) windows. Do not infer a
 * window's identity from the `primary` / `secondary` slot: some plans expose
 * only one window, and that single `primary` window can be weekly.
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
    session: { usedPct: number; resetAt: string; startedAt?: string } | null;
    weekly: { usedPct: number; resetAt: string; startedAt?: string } | null;
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

    const primary = this.parseRateWindow(rl.primary);
    const secondary = this.parseRateWindow(rl.secondary);
    const session = this.windowForDuration(primary, secondary, 300)
      // Backward compatibility for app-server payloads without duration.
      ?? (primary?.durationMins === null ? primary.window : null);
    const weekly = this.windowForDuration(primary, secondary, 10_080)
      ?? (secondary?.durationMins === null ? secondary.window : null);
    if (!session && !weekly) return null;

    this.lastRateLimits = { session, weekly };
    return { type: "agent_rate_limits", session, weekly };
  }

  /** Normalize one Codex rate-limit window into the shared window shape. */
  private parseRateWindow(
    raw: unknown,
  ): {
    window: { usedPct: number; resetAt: string; startedAt?: string };
    durationMins: number | null;
  } | null {
    if (!raw || typeof raw !== "object") return null;
    const w = raw as CodexRateLimitWindow;
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
    if (typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt) || w.resetsAt <= 0) return null;
    const usedPct = Math.min(100, Math.max(0, w.usedPercent));
    // resetsAt is epoch seconds; tolerate a ms value defensively.
    const ms = w.resetsAt < 10_000_000_000 ? w.resetsAt * 1000 : w.resetsAt;
    const resetAt = new Date(ms).toISOString();
    const durationMs =
      typeof w.windowDurationMins === "number" && Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0
        ? w.windowDurationMins * 60_000
        : null;
    return {
      durationMins: durationMs === null ? null : durationMs / 60_000,
      window: {
        usedPct,
        resetAt,
        ...(durationMs === null ? {} : { startedAt: new Date(ms - durationMs).toISOString() }),
      },
    };
  }

  private windowForDuration(
    primary: ReturnType<CodexRateLimits["parseRateWindow"]>,
    secondary: ReturnType<CodexRateLimits["parseRateWindow"]>,
    durationMins: number,
  ): { usedPct: number; resetAt: string; startedAt?: string } | null {
    return [primary, secondary].find((candidate) => candidate?.durationMins === durationMins)?.window ?? null;
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
