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
 * `total` is the cumulative rollup for the whole THREAD (billing); `last` is the
 * most recent API call (real context-window occupancy — see
 * AgentResultEvent.contextTokens).
 */
export interface CodexTokenUsage {
  /**
   * The running total for the thread, NOT for the turn — it survives
   * `thread/resume` because the app-server restores it from the rollout file.
   * `codexTurnTokens` subtracts the previous turn's rollup to get this turn's;
   * see {@link CodexRateLimits.recordTokenUsage} for where that baseline comes
   * from (planning#367).
   *
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

  /** Turn the latest snapshot belongs to, from the notification's `turnId`. */
  private _lastTurnId: string | null = null;

  /**
   * The rollup as it stood before the latest snapshot's turn — the baseline
   * `codexTurnTokens` subtracts. See {@link recordTokenUsage} for where it
   * comes from.
   */
  private _baselineTotal: CodexTokenUsage["total"] | undefined;

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
   *
   * `turnId` is what makes the cumulative rollup usable as a per-turn figure.
   * Measured against codex-cli 0.146.0: every snapshot carries the turn it
   * belongs to, and a `thread/resume` REPLAYS the previous turn's snapshot —
   * same numbers, the OLD `turnId` — before the new turn produces one of its
   * own. That replay is exactly the baseline `codexTurnTokens` needs, so it is
   * captured here, WITHIN the turn, rather than held across turns: a ShipIt
   * adapter is constructed per turn and its container is destroyed on idle,
   * while the app-server's accumulator survives both (it is restored from the
   * rollout file in the persistent `~/.codex` volume). Cross-turn memory would
   * therefore be missing at exactly the moments the accumulator is not, and each
   * such gap would post a whole thread's tokens as one turn's.
   *
   * A snapshot without a `turnId` (an older app-server) shifts nothing and is
   * simply the latest — that is the pre-planning#367 behaviour, which is right
   * for a thread that only ever runs one turn.
   */
  recordTokenUsage(tokenUsage: CodexTokenUsage | undefined, turnId?: string): void {
    if (!tokenUsage) return;
    if (turnId !== undefined && turnId !== this._lastTurnId) {
      this._baselineTotal = this._lastTokenUsage?.total;
      this._lastTurnId = turnId;
    }
    this._lastTokenUsage = tokenUsage;
  }

  /**
   * The rollup **the named turn produced**, with the baseline to subtract from
   * it, or null when the only snapshot held belongs to another turn.
   *
   * Null is the honest answer for a turn that reported no usage of its own: the
   * snapshot left over from `thread/resume`'s replay is the PREVIOUS turn's
   * cumulative total (and its `last` the previous turn's context occupancy), so
   * surfacing it would record that turn a second time.
   *
   * Both ids have to be known to refuse — an app-server that sends no `turnId`
   * gets the snapshot it would have got before.
   */
  turnTokenUsage(
    turnId: string | null | undefined,
  ): { usage: CodexTokenUsage; baselineTotal: CodexTokenUsage["total"] | undefined } | null {
    if (!this._lastTokenUsage) return null;
    if (turnId && this._lastTurnId && turnId !== this._lastTurnId) return null;
    return { usage: this._lastTokenUsage, baselineTotal: this._baselineTotal };
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
