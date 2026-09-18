import type { AgentEvent } from "../agent-process.js";

// total accumulates thread billing; last measures the latest call's context occupancy.
export interface CodexTokenUsage {
  /** inputTokens includes cachedInputTokens; convert with disjointCodexTokens. */
  total?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
  last?: { totalTokens?: number };
  modelContextWindow?: number;
}

// Identify windows by duration: a lone primary window can be weekly.
interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export class CodexRateLimits {
  private _lastTokenUsage: CodexTokenUsage | null = null;

  private _lastTurnId: string | null = null;

  private _baselineTotal: CodexTokenUsage["total"] | undefined;

  private lastRateLimits: {
    session: { usedPct: number; resetAt: string; startedAt?: string } | null;
    weekly: { usedPct: number; resetAt: string; startedAt?: string } | null;
  } = { session: null, weekly: null };

  get lastTokenUsage(): CodexTokenUsage | null {
    return this._lastTokenUsage;
  }

  // thread/resume replays the prior turn's total; use it as the baseline after recreation.
  recordTokenUsage(tokenUsage: CodexTokenUsage | undefined, turnId?: string): void {
    if (!tokenUsage) return;
    if (turnId !== undefined && turnId !== this._lastTurnId) {
      this._baselineTotal = this._lastTokenUsage?.total;
      this._lastTurnId = turnId;
    }
    this._lastTokenUsage = tokenUsage;
  }

  // An empty recorded turn ID is still known; do not bill its replay to a new turn.
  turnTokenUsage(
    turnId: string | null | undefined,
  ): { usage: CodexTokenUsage; baselineTotal: CodexTokenUsage["total"] | undefined } | null {
    if (!this._lastTokenUsage) return null;
    if (turnId && this._lastTurnId !== null && turnId !== this._lastTurnId) return null;
    return { usage: this._lastTokenUsage, baselineTotal: this._baselineTotal };
  }

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

  // Correct the known monthly-limit message only when telemetry confirms 5h exhaustion.
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
