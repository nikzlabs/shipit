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
  /**
   * docs/150 — every connected account for this provider, whether or not it has
   * reported quota yet.
   *
   * Without this, `routeIds()` could only name routes that already had a cached
   * snapshot, which made the once-per-sign-in seed fetch a no-op for a freshly
   * connected account: you needed data before you were allowed to fetch data,
   * so the pill sat at "—" until a turn happened to push an event. Optional —
   * tests and pre-docs/150 wiring fall back to the cached keys alone.
   */
  listAccountRouteIds?: () => string[];
  /**
   * docs/150 — the credential dir backing a route, so the usage fetch reads
   * THAT account's token.
   *
   * Returning `undefined` selects the legacy/env path, which is correct for the
   * reserved `claude-env-oauth` / API-key routes. Getting this wrong is not a
   * missing number but a wrong one: without it the fetch reads the root config
   * dir (or `ANTHROPIC_AUTH_TOKEN`) for every route and attributes one
   * subscription's usage to another.
   */
  credentialDirForRoute?: (routeId: string) => string | undefined;
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
   * docs/150 — every cache below is keyed by **route id** (a provider-account
   * id, or a reserved route like `claude-env-oauth`). Two connected Anthropic
   * subscriptions have two independent 5h windows, two independent
   * `/api/oauth/usage` results, and two independent 429 lockouts — a 429
   * against one account's token says nothing about another's. Sharing any of
   * these across routes produces plausible numbers attributed to the wrong
   * subscription, which is worse than no numbers.
   */
  /** Latest windows pushed from the CLI stream (`rate_limit_event`), per route. */
  private eventLatest = new Map<string, WindowSnapshot>();
  /** Latest windows pulled from `/api/oauth/usage` via `refreshNow()`, per route. */
  private apiLatest = new Map<string, WindowSnapshot>();
  /** Epoch ms until which `/api/oauth/usage` is locked out after a 429, per route. */
  private lockedUntil = new Map<string, number>();
  /** Single-flight guard so concurrent refreshes share one request, per route. */
  private inFlight = new Map<string, Promise<void>>();

  private listAccountRouteIds: (() => string[]) | undefined;
  private credentialDirForRoute: ((routeId: string) => string | undefined) | undefined;

  constructor(deps: ClaudeLimitsDeps) {
    this.authManager = deps.authManager;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
    this.listAccountRouteIds = deps.listAccountRouteIds;
    this.credentialDirForRoute = deps.credentialDirForRoute;
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
    routeId: string,
  ): void {
    this.eventLatest.set(routeId, { session, weekly, at: this.now() });
  }

  /**
   * Routes this provider can be asked about: every connected account (so a
   * newly connected one is refreshable before it has ever reported), unioned
   * with anything already cached (so a reserved env/API-key route, which only
   * appears once a turn pushes a snapshot, is not dropped).
   */
  routeIds(): string[] {
    return [...new Set([
      ...(this.listAccountRouteIds?.() ?? []),
      ...this.eventLatest.keys(),
      ...this.apiLatest.keys(),
    ])];
  }

  forgetRoute(routeId: string): void {
    this.eventLatest.delete(routeId);
    this.apiLatest.delete(routeId);
    this.lockedUntil.delete(routeId);
  }

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    const eventLatest = this.eventLatest.get(routeId) ?? null;
    const apiLatest = this.apiLatest.get(routeId) ?? null;
    if (!eventLatest && !apiLatest) return null;

    // Plan tier isn't in either payload — derive from the credentials file.
    // Account-scoped for the same reason `doRefresh` is (docs/150 req 19): the
    // unscoped read hits the singleton config root, which since the aliases
    // were retired holds nothing on a migrated install — so every account's
    // pill lost its plan label, and before that they all showed the migrated
    // default's label regardless of whose usage the numbers were.
    let plan: string | null = null;
    const tokenResult = await this.authManager.getAccessToken(this.credentialDirForRoute?.(routeId));
    if (tokenResult.token !== null) plan = tokenResult.plan;

    const session = mergeWindow(
      eventLatest?.session ?? null,
      eventLatest?.at ?? 0,
      apiLatest?.session ?? null,
      apiLatest?.at ?? 0,
    );
    const weekly = mergeWindow(
      eventLatest?.weekly ?? null,
      eventLatest?.at ?? 0,
      apiLatest?.weekly ?? null,
      apiLatest?.at ?? 0,
    );

    const fetchedAt = Math.max(eventLatest?.at ?? 0, apiLatest?.at ?? 0);
    const lockedUntil = this.lockedUntil.get(routeId) ?? 0;
    return {
      agentId: "claude",
      routeId,
      plan,
      session,
      weekly,
      fetchedAt,
      ...(lockedUntil > this.now() ? { lockedUntil } : {}),
    };
  }

  /**
   * On-demand `/api/oauth/usage` fetch. Single-flight and lockout-guarded so a
   * user mashing the refresh button (or back-to-back seeds) can't trip the
   * upstream 429. `"seed"` self-skips once an API snapshot already exists;
   * `"manual"` always attempts (subject only to the lockout). Never throws.
   */
  async refreshNow(reason: "manual" | "seed", routeId: string): Promise<void> {
    if (reason === "seed" && this.apiLatest.has(routeId)) return;
    if ((this.lockedUntil.get(routeId) ?? 0) > this.now()) return;
    const existing = this.inFlight.get(routeId);
    if (existing) {
      await existing;
      return;
    }
    const run = this.doRefresh(routeId).finally(() => {
      this.inFlight.delete(routeId);
    });
    this.inFlight.set(routeId, run);
    await run;
  }

  private async doRefresh(routeId: string): Promise<void> {
    // Account-scoped: `getAccessToken()` with no dir prefers ANTHROPIC_AUTH_TOKEN
    // and otherwise reads the ROOT config dir, so passing nothing here fetched
    // the wrong subscription's usage (or none at all, leaving the pill at "—").
    const tokenResult = await this.authManager.getAccessToken(this.credentialDirForRoute?.(routeId));
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
      const until = this.now() + retryAfterMs(response);
      this.lockedUntil.set(routeId, until);
      console.warn(
        `[claude-limits] /usage 429 for ${routeId} — locked out until ${new Date(until).toISOString()}`,
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
    // A successful fetch clears any prior lockout for this route.
    this.lockedUntil.delete(routeId);
    this.apiLatest.set(routeId, { session: parsed.session, weekly: parsed.weekly, at: this.now() });
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
  // `/api/oauth/usage` reports percent on a 0–100 scale (e.g. a weekly value of
  // 46 means 46%). Do NOT treat small values as 0–1 fractions: a real low
  // session reading of `1` means 1%, and a fraction heuristic would inflate it
  // to 100% (the bug behind the badge showing "5h 100%" at 1% actual usage).
  const usedPct = clampPct(usedRaw);
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
