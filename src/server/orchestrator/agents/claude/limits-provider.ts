import type { AuthManager } from "./auth-manager.js";
import type { LimitsProvider } from "../types.js";
import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsWindow,
} from "../../../shared/types.js";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_CLIENT_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_429_LOCKOUT_MS = 30 * 60_000;

interface WindowSnapshot {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  at: number;
}

export interface ClaudeLimitsDeps {
  authManager: Pick<AuthManager, "getAccessToken">;
  /** Includes accounts without readings, so their first usage fetch can run. */
  listAccountRouteIds?: () => string[];
  /** Undefined selects the legacy/environment credential path. */
  credentialDirForRoute?: (routeId: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ClaudeLimitsProvider implements LimitsProvider {
  readonly serviceId = "anthropic";
  readonly billingMode = "sub" as const;
  private authManager: Pick<AuthManager, "getAccessToken">;
  private fetchImpl: typeof fetch;
  private now: () => number;

  private eventLatest = new Map<string, WindowSnapshot>();
  private apiLatest = new Map<string, WindowSnapshot>();
  private lockedUntil = new Map<string, number>();
  private inFlight = new Map<string, Promise<LimitsRefreshResult>>();
  private routeGeneration = new Map<string, number>();

  private listAccountRouteIds: (() => string[]) | undefined;
  private credentialDirForRoute: ((routeId: string) => string | undefined) | undefined;

  constructor(deps: ClaudeLimitsDeps) {
    this.authManager = deps.authManager;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
    this.listAccountRouteIds = deps.listAccountRouteIds;
    this.credentialDirForRoute = deps.credentialDirForRoute;
  }

  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
    routeId: string,
  ): void {
    this.eventLatest.set(routeId, { session, weekly, at: this.now() });
  }

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
    this.inFlight.delete(routeId);
    this.routeGeneration.set(routeId, (this.routeGeneration.get(routeId) ?? 0) + 1);
  }

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    const eventLatest = this.eventLatest.get(routeId) ?? null;
    const apiLatest = this.apiLatest.get(routeId) ?? null;
    const lockedUntilNow = this.lockedUntil.get(routeId) ?? 0;
    const locked = lockedUntilNow > this.now();
    if (!eventLatest && !apiLatest && !locked) return null;

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
    // Omit availableWindows: a missing event window may simply not have arrived yet.
    return {
      serviceId: this.serviceId,
      billingMode: this.billingMode,
      routeId,
      plan,
      session,
      weekly,
      fetchedAt,
      ...(locked ? { lockedUntil: lockedUntilNow } : {}),
    };
  }

  async refreshNow(reason: "manual" | "seed", routeId: string): Promise<LimitsRefreshResult> {
    if (reason === "seed" && this.apiLatest.has(routeId)) {
      return { routeId, outcome: "skipped" };
    }
    const lockedUntil = this.lockedUntil.get(routeId) ?? 0;
    if (lockedUntil > this.now()) {
      return { routeId, outcome: "locked", lockedUntil };
    }
    const existing = this.inFlight.get(routeId);
    if (existing) return existing;
    const generation = this.routeGeneration.get(routeId) ?? 0;
    const request = this.doRefresh(routeId, generation);
    const run = request.finally(() => {
      if (this.inFlight.get(routeId) === run) this.inFlight.delete(routeId);
    });
    this.inFlight.set(routeId, run);
    return run;
  }

  private async doRefresh(routeId: string, generation: number): Promise<LimitsRefreshResult> {
    const tokenResult = await this.authManager.getAccessToken(this.credentialDirForRoute?.(routeId));
    if (tokenResult.token === null) {
      console.warn(`[claude-limits] /usage skipped for ${routeId}: ${tokenResult.reason}`);
      return {
        routeId,
        outcome: "no-credentials",
        detail: tokenResult.reason === "api-key" ? "route uses an API key, not a subscription" : "no OAuth credentials on disk",
      };
    }
    if (
      tokenResult.expiresAt !== null &&
      tokenResult.expiresAt <= this.now() + 60_000
    ) {
      console.warn(`[claude-limits] /usage skipped for ${routeId}: access token expired`);
      return { routeId, outcome: "expired-token", detail: "access token expired — sign in again" };
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
      return { routeId, outcome: "failed", detail: `network error: ${errMsg(err)}` };
    }

    if (response.status === 429) {
      if ((this.routeGeneration.get(routeId) ?? 0) !== generation) {
        return { routeId, outcome: "skipped" };
      }
      const until = this.now() + retryAfterMs(response);
      this.lockedUntil.set(routeId, until);
      console.warn(
        `[claude-limits] /usage 429 for ${routeId} — locked out until ${new Date(until).toISOString()}`,
      );
      return { routeId, outcome: "rate-limited", lockedUntil: until };
    }
    if (!response.ok) {
      console.warn(`[claude-limits] /usage HTTP ${response.status}`);
      return { routeId, outcome: "failed", detail: `HTTP ${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      console.warn(`[claude-limits] /usage non-JSON body: ${errMsg(err)}`);
      return { routeId, outcome: "failed", detail: "response was not JSON" };
    }

    const parsed = parseUsageWindows(body);
    if (!parsed) {
      console.warn("[claude-limits] /usage unexpected payload shape");
      return { routeId, outcome: "failed", detail: "unexpected /usage payload" };
    }
    if ((this.routeGeneration.get(routeId) ?? 0) !== generation) {
      return { routeId, outcome: "skipped" };
    }
    this.lockedUntil.delete(routeId);
    this.apiLatest.set(routeId, { session: parsed.session, weekly: parsed.weekly, at: this.now() });
    return { routeId, outcome: "updated" };
  }
}

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
  // Usage is a percentage: 1 means 1%, not 100%.
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
    // Anthropic can return Retry-After: 0; use the lockout instead of retrying immediately.
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return DEFAULT_429_LOCKOUT_MS;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
