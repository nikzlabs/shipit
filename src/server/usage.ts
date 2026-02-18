import fs from "node:fs";
import path from "node:path";
import type { UsageTurn, SessionUsage, UsageStats } from "./types.js";

const DEFAULT_USAGE_FILE = path.join("/workspace", ".shipit-usage.json");

/**
 * Manages per-turn usage/cost data. Persists to a JSON file on disk so data
 * survives server restarts.
 *
 * @param usageFile - Path to the JSON file for persistence.
 *   Defaults to `/workspace/.shipit-usage.json`. Override in tests.
 */
export class UsageManager {
  private turns: UsageTurn[] = [];
  private usageFile: string;

  constructor(usageFile?: string) {
    this.usageFile = usageFile ?? DEFAULT_USAGE_FILE;
    this.load();
  }

  /** Load usage data from disk. */
  private load(): void {
    try {
      if (fs.existsSync(this.usageFile)) {
        const raw = fs.readFileSync(this.usageFile, "utf-8");
        this.turns = JSON.parse(raw);
      }
    } catch {
      this.turns = [];
    }
  }

  /** Persist usage data to disk. */
  private save(): void {
    try {
      const dir = path.dirname(this.usageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.usageFile, JSON.stringify(this.turns, null, 2));
    } catch (err) {
      console.error("[usage] failed to save:", err instanceof Error ? err.message : String(err));
    }
  }

  /** Record a turn's cost, duration, and optional token counts. */
  record(sessionId: string, costUsd: number, durationMs: number, inputTokens?: number, outputTokens?: number): void {
    this.turns.push({
      sessionId,
      costUsd,
      durationMs,
      timestamp: new Date().toISOString(),
      inputTokens,
      outputTokens,
    });
    this.save();
  }

  /** Get aggregated usage for a single session. */
  getSessionUsage(sessionId: string): SessionUsage | undefined {
    const sessionTurns = this.turns.filter((t) => t.sessionId === sessionId);
    if (sessionTurns.length === 0) return undefined;

    return {
      sessionId,
      totalCostUsd: sessionTurns.reduce((sum, t) => sum + t.costUsd, 0),
      totalDurationMs: sessionTurns.reduce((sum, t) => sum + t.durationMs, 0),
      turnCount: sessionTurns.length,
    };
  }

  /** Get cumulative token totals for a session. */
  getSessionTokenTotals(sessionId: string): { cumulativeInputTokens: number; cumulativeOutputTokens: number } | undefined {
    const sessionTurns = this.turns.filter((t) => t.sessionId === sessionId);
    if (sessionTurns.length === 0) return undefined;

    const hasAnyTokens = sessionTurns.some((t) => t.inputTokens !== undefined || t.outputTokens !== undefined);
    if (!hasAnyTokens) return undefined;

    return {
      cumulativeInputTokens: sessionTurns.reduce((sum, t) => sum + (t.inputTokens ?? 0), 0),
      cumulativeOutputTokens: sessionTurns.reduce((sum, t) => sum + (t.outputTokens ?? 0), 0),
    };
  }

  /** Get per-turn usage data for a session (for the usage modal breakdown). */
  getSessionTurns(sessionId: string): UsageTurn[] {
    return this.turns.filter((t) => t.sessionId === sessionId);
  }

  /** Get aggregated usage across all sessions. */
  getStats(): UsageStats {
    const sessionMap = new Map<string, UsageTurn[]>();
    for (const turn of this.turns) {
      const list = sessionMap.get(turn.sessionId);
      if (list) {
        list.push(turn);
      } else {
        sessionMap.set(turn.sessionId, [turn]);
      }
    }

    const sessions: SessionUsage[] = [];
    for (const [sessionId, turns] of sessionMap) {
      sessions.push({
        sessionId,
        totalCostUsd: turns.reduce((sum, t) => sum + t.costUsd, 0),
        totalDurationMs: turns.reduce((sum, t) => sum + t.durationMs, 0),
        turnCount: turns.length,
      });
    }

    return {
      sessions,
      totalCostUsd: this.turns.reduce((sum, t) => sum + t.costUsd, 0),
      totalTurns: this.turns.length,
    };
  }

  /** Delete all usage data for a session. */
  delete(sessionId: string): boolean {
    const before = this.turns.length;
    this.turns = this.turns.filter((t) => t.sessionId !== sessionId);
    if (this.turns.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}
