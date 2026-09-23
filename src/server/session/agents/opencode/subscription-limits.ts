import { readOpenCodeAccount } from "../../../shared/opencode-account.js";
import type { AgentEvent } from "../agent-process.js";
import type { SubscriptionLimitsWindow } from "../../../shared/types.js";

type RateLimitsEvent = Extract<AgentEvent, { type: "agent_rate_limits" }>;

function windowFrom(raw: unknown): { seconds: number; window: SubscriptionLimitsWindow } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const { used_percent: used, limit_window_seconds: seconds, reset_at: reset } = value;
  if (typeof used !== "number" || !Number.isFinite(used)
    || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0
    || typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0) return null;
  const resetMs = reset < 10_000_000_000 ? reset * 1000 : reset;
  const end = new Date(resetMs);
  const start = new Date(resetMs - seconds * 1000);
  if (!Number.isFinite(end.getTime()) || !Number.isFinite(start.getTime())) return null;
  return {
    seconds,
    window: { usedPct: Math.min(100, Math.max(0, used)), resetAt: end.toISOString(), startedAt: start.toISOString() },
  };
}

export function parseOpenCodeSubscriptionLimits(raw: unknown): RateLimitsEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const limits = (raw as Record<string, unknown>).rate_limit;
  if (!limits || typeof limits !== "object") return null;
  const value = limits as Record<string, unknown>;
  const windows = [windowFrom(value.primary_window), windowFrom(value.secondary_window)];
  const session = windows.find((w) => w?.seconds === 18_000)?.window ?? null;
  const weekly = windows.find((w) => w?.seconds === 604_800)?.window ?? null;
  return session || weekly ? { type: "agent_rate_limits", session, weekly } : null;
}

/** OpenCode's JSON stream omits quota; read the same account endpoint as Codex. */
export class OpenCodeSubscriptionLimits {
  private request: AbortController | undefined;
  private stopped = false;
  private reportedFailure = false;
  private rateLimited = false;

  constructor(private readonly options: {
    dataHome: string;
    routeId: string;
    onLimits: (event: RateLimitsEvent) => void;
    onFailure: (message: string) => void;
    fetchFn?: typeof fetch;
  }) {}

  start(): void {
    void this.refresh(5_000);
  }

  async finish(): Promise<void> {
    // A reading started before the last model call cannot measure that call.
    this.request?.abort();
    this.request = undefined;
    await this.refresh(2_000);
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.request?.abort();
  }

  private async refresh(timeoutMs: number): Promise<void> {
    if (this.stopped || this.request || this.rateLimited) return;
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => request.abort(), timeoutMs);
    let event: RateLimitsEvent | null;
    try {
      const token = readOpenCodeAccount(this.options.dataHome, this.options.routeId);
      const response = await (this.options.fetchFn ?? fetch)("https://chatgpt.com/backend-api/wham/usage", {
        headers: { Authorization: `Bearer ${token.access}`, "ChatGPT-Account-Id": token.accountId, "User-Agent": "codex-cli" },
        redirect: "error",
        signal: request.signal,
      });
      if (request.signal.aborted || this.stopped) return;
      if (response.status === 429) this.rateLimited = true;
      if (!response.ok) throw new Error("Usage request failed");
      const raw: unknown = await response.json();
      if (raw && typeof raw === "object" && "account_id" in raw
        && raw.account_id !== null && raw.account_id !== undefined && raw.account_id !== token.accountId) {
        throw new Error("Usage response account does not match");
      }
      event = parseOpenCodeSubscriptionLimits(raw);
      if (!event) throw new Error("Usage response has no supported windows");
      const current = readOpenCodeAccount(this.options.dataHome, this.options.routeId);
      if (current.accountId !== token.accountId || request.signal.aborted || this.stopped) return;
    } catch {
      event = null;
      if (!this.stopped && this.request === request) {
        this.reportFailure("OpenAI subscription limits could not be updated; keeping the last reading.");
      }
    } finally {
      clearTimeout(timeout);
      if (this.request === request) this.request = undefined;
    }
    if (event && !this.stopped && !request.signal.aborted) {
      try { this.options.onLimits(event); }
      catch { this.reportFailure("OpenAI subscription limit update could not be delivered."); }
    }
  }

  private reportFailure(message: string): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    // Never log upstream bodies or exception text: either can contain credentials.
    try { this.options.onFailure(message); }
    catch { console.warn(`[opencode] ${message}`); }
  }
}
