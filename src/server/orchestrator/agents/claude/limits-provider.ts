/**
 * ClaudeLimitsProvider — snapshot of the user's Claude subscription
 * rate-limit windows for the header badge, from two sources:
 *
 *   1. **Event stream (free, primary near the limit).** The Claude CLI emits
 *      `rate_limit_event` messages in its `--output-format=stream-json` stream;
 *      `ClaudeAdapter` parses them and the orchestrator routes them here via
 *      `setRateLimits()`. The catch: Claude CLI only includes `utilization`
 *      once a warning threshold trips (anthropics/claude-code#50518), so at
 *      **low usage** these windows have `usedPct: null` — a reset time but no
 *      number. Same pattern as `CodexLimitsProvider`.
 *
 *   2. **`/api/oauth/usage` (on-demand, the only low-usage number).** The
 *      undocumented OAuth endpoint that backs Claude Code's `/usage` screen
 *      reports the real percentage at any usage level. But Anthropic
 *      aggressively rate-limits it (429 after a handful of calls, then ~30 min
 *      lockout — anthropics/claude-code#31637). So we never poll it: it's
 *      fetched only on an explicit `refreshNow()` (the user's refresh button,
 *      plus one seed fetch per sign-in), guarded by single-flight + a 429
 *      lockout. See docs/161.
 *
 * `fetch()` merges the two: per window, a known number wins over a null one,
 * and when both are known the fresher source wins. This means the live event
 * number stays authoritative near the limit while the API number fills in the
 * low-usage gap.
 */

import type { AuthManager } from "./auth-manager.js";
import type { LimitsProvider } from "../types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../../shared/types.js";

/** OAuth usage endpoint backing Claude Code's `/usage` slash command. */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Beta header the CLI sends on every OAuth call; a no-op here, sent for parity. */
export const CLAUDE_CLIENT_BETA_HEADER = "oauth-2025-04-20";
/** Default lockout when a 429 carries no usable `Retry-After`. */
const DEFAULT_429_LOCKOUT_MS = 30 * 60_000;

interface WindowSnapshot {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  at: number;
}

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

  /** Latest windows pushed from the CLI stream (`rate_limit_event`). */
  private eventLatest: WindowSnapshot | null = null;
  /** Latest windows pulled from `/api/oauth/usage` via `refreshNow()`. */
  private apiLatest: WindowSnapshot | null = null;
  /** Epoch ms until which `/api/oauth/usage` is locked out after a 429. */
  private lockedUntil = 0;
  /** Single-flight guard so concurrent refreshes share one request. */
  private inFlight: Promise<void> | null = null;

  constructor(deps: ClaudeLimitsDeps) {
    this.authManager = deps.authManager;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Record a fresh rate-limit snapshot pushed from a Claude turn. Called by the
   * orchestrator's `recordAgentRateLimits` when an `agent_rate_limits`
   * AgentEvent arrives. Follow with `LimitsRegistry.markAuthRefreshed("claude")`
   * to rebroadcast.
   */
  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
  ): void {
    this.eventLatest = { session, weekly, at: this.now() };
  }

  canFetch(): boolean {
    return this.eventLatest !== null || this.apiLatest !== null;
  }

  async fetch(): Promise<SubscriptionLimits | null> {
    if (!this.eventLatest && !this.apiLatest) return null;

    // Plan tier isn't in either payload — derive from the credentials file.
    let plan: string | null = null;
    const tokenResult = await this.authManager.getAccessToken();
    if (tokenResult.token !== null) plan = tokenResult.plan;

    const session = mergeWindow(
      this.eventLatest?.session ?? null,
      this.eventLatest?.at ?? 0,
      this.apiLatest?.session ?? null,
      this.apiLatest?.at ?? 0,
    );
    const weekly = mergeWindow(
      this.eventLatest?.weekly ?? null,
      this.eventLatest?.at ?? 0,
      this.apiLatest?.weekly ?? null,
      this.apiLatest?.at ?? 0,
    );

    const fetchedAt = Math.max(this.eventLatest?.at ?? 0, this.apiLatest?.at ?? 0);
    return {
      agentId: "claude",
      plan,
      session,
      weekly,
      fetchedAt,
      ...(this.lockedUntil > this.now() ? { lockedUntil: this.lockedUntil } : {}),
    };
  }

  /**
   * On-demand `/api/oauth/usage` fetch. Single-flight and lockout-guarded so a
   * user mashing the refresh button (or back-to-back seeds) can't trip the
   * upstream 429. `"seed"` self-skips once an API snapshot already exists;
   * `"manual"` always attempts (subject only to the lockout). Never throws.
   */
  async refreshNow(reason: "manual" | "seed"): Promise<void> {
    if (reason === "seed" && this.apiLatest !== null) return;
    if (this.lockedUntil > this.now()) return;
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const tokenResult = await this.authManager.getAccessToken();
    if (tokenResult.token === null) return;
    // Skip a doomed call against an idle-expired access token — the shared
    // credential file is refreshed by the CLI on each turn; we don't refresh
    // it ourselves (blast radius). The badge keeps its last numbers.
    if (
      tokenResult.expiresAt !== null &&
      tokenResult.expiresAt <= this.now() + 60_000
    ) {
      return;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(CLAUDE_USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
          "anthropic-beta": CLAUDE_CLIENT_BETA_HEADER,
          Accept: "application/json",
          "User-Agent": "ShipIt-Orchestrator/1.0 (claude-limits)",
        },
      });
    } catch (err) {
      console.warn(`[claude-limits] /usage network error: ${errMsg(err)}`);
      return;
    }

    if (response.status === 429) {
      this.lockedUntil = this.now() + retryAfterMs(response);
      console.warn(
        `[claude-limits] /usage 429 — locked out until ${new Date(this.lockedUntil).toISOString()}`,
      );
      return;
    }
    if (!response.ok) {
      console.warn(`[claude-limits] /usage HTTP ${response.status}`);
      return;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      console.warn(`[claude-limits] /usage non-JSON body: ${errMsg(err)}`);
      return;
    }

    const parsed = parseUsageWindows(body);
    if (!parsed) {
      console.warn("[claude-limits] /usage unexpected payload shape");
      return;
    }
    // A successful fetch clears any prior lockout.
    this.lockedUntil = 0;
    this.apiLatest = { session: parsed.session, weekly: parsed.weekly, at: this.now() };
  }
}

// ---- Merge ----

/**
 * Pick the better of an event window and an API window. A known `usedPct`
 * beats a `null` one; when both are known the fresher source wins; when both
 * are unknown the event window's `resetAt` is preferred (it's the one the CLI
 * just reported). Returns null only when neither source has the window.
 */
function mergeWindow(
  ev: SubscriptionLimitsWindow | null,
  evAt: number,
  api: SubscriptionLimitsWindow | null,
  apiAt: number,
): SubscriptionLimitsWindow | null {
  const evKnown = ev !== null && ev.usedPct !== null;
  const apiKnown = api !== null && api.usedPct !== null;
  if (evKnown && apiKnown) return evAt >= apiAt ? tag(ev, "event") : tag(api, "usage-api");
  if (evKnown) return tag(ev, "event");
  if (apiKnown) return tag(api, "usage-api");
  if (ev) return tag(ev, "event");
  if (api) return tag(api, "usage-api");
  return null;
}

function tag(
  w: SubscriptionLimitsWindow,
  source: "event" | "usage-api",
): SubscriptionLimitsWindow {
  return { ...w, source };
}

// ---- /usage parsing (session + weekly only) ----

function parseUsageWindows(
  body: unknown,
): { session: SubscriptionLimitsWindow | null; weekly: SubscriptionLimitsWindow | null } | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const session = readWindow(obj, ["five_hour", "session", "fiveHour"]);
  const weekly = readWindow(obj, ["seven_day", "weekly", "sevenDay"]);
  if (!session && !weekly) return null;
  return { session, weekly };
}

function readWindow(
  obj: Record<string, unknown>,
  keys: string[],
): SubscriptionLimitsWindow | null {
  for (const key of keys) {
    const v = obj[key];
    if (v && typeof v === "object") {
      const w = parseWindow(v as Record<string, unknown>);
      if (w) return w;
    }
  }
  return null;
}

function parseWindow(obj: Record<string, unknown>): SubscriptionLimitsWindow | null {
  const usedRaw =
    pickNum(obj, "utilization") ?? pickNum(obj, "used_pct") ?? pickNum(obj, "usedPct");
  const resetAt =
    pickIso(obj, "resets_at") ?? pickIso(obj, "reset_at") ?? pickIso(obj, "resetAt");
  if (!resetAt) return null;
  if (usedRaw === null) return { usedPct: null, resetAt };
  // Tolerate fraction (0–1) or percent (0–100).
  const usedPct = clampPct(usedRaw <= 1 ? usedRaw * 100 : usedRaw);
  return { usedPct, resetAt };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 100 ? 100 : n;
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
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v < 10_000_000_000 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  return null;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    // `retry-after: 0` is the documented Anthropic bug value — treat any
    // non-positive / unparseable header as "use the default lockout" so we
    // don't immediately re-fire into another 429.
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return DEFAULT_429_LOCKOUT_MS;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
