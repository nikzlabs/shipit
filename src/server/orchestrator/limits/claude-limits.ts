/**
 * ClaudeLimitsProvider — pulls a subscription rate-limit snapshot
 * from Anthropic's undocumented OAuth-scoped usage endpoint, the
 * same call the Claude CLI makes to populate its `/usage` REPL
 * screen.
 *
 * Status of the endpoint (see docs/135-subscription-limits-badge/plan.md
 * — "API research"): the URL is community-reported, not Anthropic-
 * documented. The provider tolerates schema drift gracefully: any
 * shape it doesn't recognize is returned as
 * `error: "limits unavailable"` rather than throwing, and the poller
 * applies backoff.
 *
 * The provider is *constructor-injected* with an
 * `AuthManager.getAccessToken()`-shaped getter and a fetch
 * implementation so unit tests don't have to monkey-patch
 * `globalThis.fetch` or instantiate `AuthManager` itself.
 */

import type { AuthManager } from "../auth.js";
import type { LimitsProvider, LimitsSkipTick } from "./types.js";
import { LIMITS_SKIP_TICK, isAccessTokenExpired } from "./types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../shared/types.js";

/**
 * OAuth usage endpoint that backs Claude Code's `/usage` slash command.
 *
 * Verified empirically against `api.anthropic.com` with a Max-tier
 * OAuth token on 2026-05-19 (doc 135 Phase 0). Endpoint accepts a
 * plain `Authorization: Bearer ...` and the user-side scopes the CLI
 * is already minted with (`user:profile` / `user:sessions:claude_code`
 * are sufficient — no extra scope, no extra header). The
 * `anthropic-beta: oauth-2025-04-20` header is a no-op here but is
 * harmless if sent.
 *
 * Response shape (verified):
 *
 *   {
 *     "five_hour":            { "utilization": 0..100, "resets_at": ISO },
 *     "seven_day":            { "utilization": 0..100, "resets_at": ISO },
 *     "seven_day_opus":       null | { utilization, resets_at },
 *     "seven_day_sonnet":     null | { utilization, resets_at },
 *     "seven_day_oauth_apps": null | { utilization, resets_at },
 *     "extra_usage":          { is_enabled, monthly_limit, used_credits,
 *                               utilization, currency, disabled_reason },
 *     ...internal-codename keys that are always null for end users
 *   }
 *
 *   Note: the response does NOT include a plan/subscription field.
 *   The provider derives the plan label from
 *   `AuthManager.getAccessToken().plan` instead, which the auth
 *   manager pulls from `~/.claude/.credentials.json` (Phase 0:
 *   `claudeAiOauth.subscriptionType` + `rateLimitTier`).
 */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * Beta header Claude Code sends to identify itself to the OAuth APIs.
 * Per Phase 0 capture this is a no-op for the usage endpoint, but the
 * CLI sends it on every OAuth call so we mirror that for parity in
 * case Anthropic later tightens a server-side filter.
 */
export const CLAUDE_CLIENT_BETA_HEADER = "oauth-2025-04-20";

export interface ClaudeLimitsDeps {
  authManager: Pick<AuthManager, "getAccessToken">;
  /** Inject for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class ClaudeLimitsProvider implements LimitsProvider {
  readonly agentId = "claude" as const;
  private authManager: Pick<AuthManager, "getAccessToken">;
  private fetchImpl: typeof fetch;
  private now: () => number;
  /**
   * Cached "no token available" state so `canFetch()` is cheap. We
   * don't call `getAccessToken()` synchronously in `canFetch()` —
   * the file read would be too expensive for a hot path.
   */
  private lastKnownFetchable = false;

  constructor(deps: ClaudeLimitsDeps) {
    this.authManager = deps.authManager;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Best-effort liveness check used by the poller's gating logic.
   * The first call always returns false (the cache is unset until
   * `fetch()` has run once); subsequent calls return whatever
   * `getAccessToken()` reported last. The poller calls `fetch()`
   * directly on auth-complete events so the cache primes itself
   * within seconds of sign-in.
   */
  canFetch(): boolean {
    return this.lastKnownFetchable;
  }

  /**
   * Refresh `canFetch()`'s cached signal by re-resolving the token.
   * Called from the poller before each tick so a fresh sign-in or
   * sign-out propagates to gating in <1 tick.
   */
  async refreshFetchable(): Promise<boolean> {
    const result = await this.authManager.getAccessToken();
    this.lastKnownFetchable = result.token !== null;
    return this.lastKnownFetchable;
  }

  async fetch(): Promise<SubscriptionLimits | null | LimitsSkipTick> {
    const tokenResult = await this.authManager.getAccessToken();
    if (tokenResult.token === null) {
      this.lastKnownFetchable = false;
      return null;
    }
    this.lastKnownFetchable = true;

    // The access token in the shared credential file is short-lived;
    // the Claude CLI refreshes it on each turn. When a session sits
    // idle past the TTL nobody refreshes it, and hitting /usage with
    // the stale token returns 401 — a misleading "auth expired" given
    // the long-lived refresh token is still valid. Skip the doomed
    // call; the badge keeps its last numbers and self-heals on the
    // next turn. See LIMITS_SKIP_TICK.
    if (isAccessTokenExpired(tokenResult.expiresAt, this.now())) {
      return LIMITS_SKIP_TICK;
    }
    // Plan label is derived from the credentials file (the /usage
    // response doesn't include one — Phase 0 finding). When the token
    // came from ANTHROPIC_AUTH_TOKEN (env, dogfooding) there's no
    // credentials file to inspect; `plan` is null and the tooltip
    // just shows the agent name without a tier.
    const authPlan = tokenResult.plan;

    const fetchedAt = this.now();
    let response: Response;
    try {
      response = await this.fetchImpl(CLAUDE_USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
          "anthropic-beta": CLAUDE_CLIENT_BETA_HEADER,
          Accept: "application/json",
          "User-Agent": "ShipIt-Orchestrator/1.0 (claude-limits-poller)",
        },
      });
    } catch (err) {
      return this.errorSnapshot(
        fetchedAt,
        authPlan,
        "limits unavailable",
        `network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      return this.errorSnapshot(fetchedAt, authPlan, "auth expired", `HTTP ${response.status}`);
    }
    if (response.status === 429) {
      // The poller honors a separate rate-limit backoff branch — we
      // still return an error snapshot so the UI shows the failure
      // state instead of stale numbers.
      return this.errorSnapshot(fetchedAt, authPlan, "rate limited", "HTTP 429");
    }
    if (!response.ok) {
      return this.errorSnapshot(
        fetchedAt,
        authPlan,
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
        authPlan,
        "limits unavailable",
        `non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseClaudeUsage(body, fetchedAt);
    if (!parsed) {
      // Log a truncated payload to help future schema regressions
      // get diagnosed. Capped at ~1 KB; we don't expect PII here.
      const preview = JSON.stringify(body ?? null).slice(0, 1024);
      console.warn("[claude-limits] Unexpected /usage payload shape:", preview);
      return this.errorSnapshot(
        fetchedAt,
        authPlan,
        "limits unavailable",
        "unexpected payload shape",
      );
    }
    // Prefer the auth-derived plan over whatever the parser may have
    // pulled out of the body (today the body has no plan field, so
    // `parsed.plan` is always null — but we keep the union for
    // forward compatibility if Anthropic adds the field later).
    return { ...parsed, plan: authPlan ?? parsed.plan };
  }

  private errorSnapshot(
    fetchedAt: number,
    plan: string | null,
    userFacing: string,
    detail: string,
  ): SubscriptionLimits {
    console.warn(`[claude-limits] fetch failed: ${userFacing} (${detail})`);
    return {
      agentId: "claude",
      plan,
      session: null,
      weekly: null,
      weeklyOpus: null,
      fetchedAt,
      error: userFacing,
    };
  }
}

// ---- Parser ----

/**
 * Parse the Anthropic `/api/oauth/usage` response into a
 * `SubscriptionLimits` snapshot. Tolerant of multiple field-name
 * variants because the endpoint is undocumented and community
 * reports differ — see plan.md "API research".
 *
 * Returns null when no window can be reconstructed (caller treats
 * that as a schema mismatch and surfaces "limits unavailable").
 *
 * Exported for unit tests.
 */
export function parseClaudeUsage(body: unknown, fetchedAt: number): SubscriptionLimits | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  // Plan label — Anthropic's response sometimes carries it as
  // `subscription`, sometimes nested under `plan`. Either way it's
  // a free-form display string ("Pro", "Max 20x", "Max 5x", ...).
  const plan =
    pickStr(obj, "subscription") ??
    pickStr(obj, "plan") ??
    pickStr(obj, "tier") ??
    pickNestedStr(obj, "subscription", "tier") ??
    pickNestedStr(obj, "plan", "name") ??
    null;

  const session = readWindow(obj, ["five_hour", "session", "rolling", "fiveHour"]);
  const weekly = readWindow(obj, ["seven_day", "weekly", "week", "sevenDay"]);
  const weeklyOpus = readWindow(obj, [
    "seven_day_opus",
    "weekly_opus",
    "weeklyOpus",
    "opus_weekly",
  ]);

  if (!session && !weekly && !weeklyOpus) return null;

  return {
    agentId: "claude",
    plan,
    session,
    weekly,
    weeklyOpus,
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
    pickNum(obj, "percentUsed") ??
    pickNum(obj, "usage_percent");
  if (usedRaw === null) return null;

  // Some upstream values are fractions (0–1), others are 0–100.
  // Normalize: anything ≤1 is a fraction, scale up.
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
