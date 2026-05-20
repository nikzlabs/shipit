/**
 * CodexLimitsProvider — pulls a subscription rate-limit snapshot
 * from OpenAI's internal Codex usage endpoint, the same call the
 * `codex` CLI uses to populate its `/status` REPL line.
 *
 * Same caveat as Claude (see docs/135-subscription-limits-badge/plan.md
 * "API research"): the URL is community-reported and has shifted
 * across versions. The provider tolerates schema drift gracefully:
 * any shape it doesn't recognize is returned as
 * `error: "limits unavailable"` rather than throwing.
 */

import type { CodexAuthManager } from "../codex-auth.js";
import type { LimitsProvider, LimitsSkipTick } from "./types.js";
import { LIMITS_SKIP_TICK, isAccessTokenExpired } from "./types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../shared/types.js";

/**
 * Community-reported usage endpoint the Codex CLI uses internally
 * to populate `/status`. Unstable — confirm before relying on.
 */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";

export interface CodexLimitsDeps {
  codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  /** Inject for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class CodexLimitsProvider implements LimitsProvider {
  readonly agentId = "codex" as const;
  private codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private lastKnownFetchable = false;

  constructor(deps: CodexLimitsDeps) {
    this.codexAuthManager = deps.codexAuthManager;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  canFetch(): boolean {
    return this.lastKnownFetchable;
  }

  async refreshFetchable(): Promise<boolean> {
    const result = await this.codexAuthManager.getAccessToken();
    this.lastKnownFetchable = result.token !== null;
    return this.lastKnownFetchable;
  }

  async fetch(): Promise<SubscriptionLimits | null | LimitsSkipTick> {
    const tokenResult = await this.codexAuthManager.getAccessToken();
    if (tokenResult.token === null) {
      this.lastKnownFetchable = false;
      return null;
    }
    this.lastKnownFetchable = true;

    // Same idle-expiry story as Claude: the Codex CLI refreshes the
    // shared credential file on each turn, so an idle session leaves a
    // stale access token that 401s. Skip rather than surfacing a false
    // "auth expired". See LIMITS_SKIP_TICK.
    if (isAccessTokenExpired(tokenResult.expiresAt, this.now())) {
      return LIMITS_SKIP_TICK;
    }

    const fetchedAt = this.now();
    let response: Response;
    try {
      response = await this.fetchImpl(CODEX_USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
          Accept: "application/json",
          "User-Agent": "ShipIt-Orchestrator/1.0 (codex-limits-poller)",
        },
      });
    } catch (err) {
      return this.errorSnapshot(
        fetchedAt,
        "limits unavailable",
        `network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      return this.errorSnapshot(fetchedAt, "auth expired", `HTTP ${response.status}`);
    }
    if (response.status === 429) {
      return this.errorSnapshot(fetchedAt, "rate limited", "HTTP 429");
    }
    if (!response.ok) {
      return this.errorSnapshot(
        fetchedAt,
        "limits unavailable",
        `HTTP ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return this.errorSnapshot(
        fetchedAt,
        "limits unavailable",
        `non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseCodexUsage(body, fetchedAt);
    if (!parsed) {
      const preview = JSON.stringify(body ?? null).slice(0, 1024);
      console.warn("[codex-limits] Unexpected /codex/usage payload shape:", preview);
      return this.errorSnapshot(
        fetchedAt,
        "limits unavailable",
        "unexpected payload shape",
      );
    }
    return parsed;
  }

  private errorSnapshot(
    fetchedAt: number,
    userFacing: string,
    detail: string,
  ): SubscriptionLimits {
    console.warn(`[codex-limits] fetch failed: ${userFacing} (${detail})`);
    return {
      agentId: "codex",
      plan: null,
      session: null,
      weekly: null,
      fetchedAt,
      error: userFacing,
    };
  }
}

// ---- Parser ----

/**
 * Parse the Codex `/codex/usage` response into a SubscriptionLimits
 * snapshot. Tolerant of multiple field-name variants because the
 * endpoint is undocumented and the shape has drifted across CLI
 * versions — see plan.md "API research".
 *
 * Exported for unit tests.
 */
export function parseCodexUsage(body: unknown, fetchedAt: number): SubscriptionLimits | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  const plan =
    pickStr(obj, "plan") ??
    pickStr(obj, "subscription") ??
    pickStr(obj, "tier") ??
    pickNestedStr(obj, "plan", "name") ??
    null;

  const session = readWindow(obj, ["five_hour", "session", "rolling", "fiveHour"]);
  const weekly = readWindow(obj, ["weekly", "seven_day", "week", "sevenDay"]);

  if (!session && !weekly) return null;

  return {
    agentId: "codex",
    plan,
    session,
    weekly,
    fetchedAt,
  };
}

function readWindow(
  obj: Record<string, unknown>,
  candidateKeys: string[],
): SubscriptionLimitsWindow | null {
  for (const key of candidateKeys) {
    const v = obj[key];
    if (v && typeof v === "object") {
      const parsed = parseWindow(v as Record<string, unknown>);
      if (parsed) return parsed;
    }
  }
  return null;
}

function parseWindow(obj: Record<string, unknown>): SubscriptionLimitsWindow | null {
  const usedRaw =
    pickNum(obj, "utilization") ??
    pickNum(obj, "used_pct") ??
    pickNum(obj, "usedPct") ??
    pickNum(obj, "percent_used") ??
    pickNum(obj, "percentUsed");
  if (usedRaw === null) return null;
  const usedPct = clampPct(usedRaw <= 1 ? usedRaw * 100 : usedRaw);

  const resetAt =
    pickIso(obj, "resets_at") ??
    pickIso(obj, "reset_at") ??
    pickIso(obj, "resetAt") ??
    pickEpoch(obj, "resets_at_epoch") ??
    pickEpoch(obj, "reset_epoch");
  if (!resetAt) return null;

  return { usedPct, resetAt };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function pickStr(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pickNestedStr(
  obj: Record<string, unknown>,
  outer: string,
  inner: string,
): string | null {
  const o = obj[outer];
  if (o && typeof o === "object") {
    const v = (o as Record<string, unknown>)[inner];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNum(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickIso(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function pickEpoch(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v < 10_000_000_000 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  return null;
}
