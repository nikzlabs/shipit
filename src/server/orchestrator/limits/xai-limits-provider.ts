import {
  extractXaiAccessToken,
  grokAuthFileFor,
  readXaiAuthFile,
} from "../agents/grok/auth-manager.js";
import type { LimitsProvider } from "../agents/types.js";
import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsWindow,
  SubscriptionWindowName,
} from "../../shared/types.js";

// Without format=credits, HTTP 200 reports monthly spend instead of subscription usage.
export const XAI_QUOTA_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export const XAI_SERVICE_ID = "xai";

// Defensive fallback, not a measured xAI retry interval.
const DEFAULT_429_LOCKOUT_MS = 5 * 60_000;

const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";

interface WindowSnapshot {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  at: number;
}

export interface XaiLimitsDeps {
  listRouteIds: () => string[];
  // Read per request: the CLI refreshes auth.json in place.
  credentialDirForRoute: (routeId: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class XaiLimitsProvider implements LimitsProvider {
  readonly serviceId = XAI_SERVICE_ID;
  readonly billingMode = "sub" as const;

  private listRouteIdsFn: () => string[];
  private credentialDirForRoute: (routeId: string) => string | undefined;
  private fetchImpl: typeof fetch;
  private now: () => number;

  private apiLatest = new Map<string, WindowSnapshot>();
  private eventLatest = new Map<string, WindowSnapshot>();
  private lockedUntil = new Map<string, number>();
  private inFlight = new Map<string, Promise<LimitsRefreshResult>>();
  private routeGeneration = new Map<string, number>();

  constructor(deps: XaiLimitsDeps) {
    this.listRouteIdsFn = deps.listRouteIds;
    this.credentialDirForRoute = deps.credentialDirForRoute;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  routeIds(): string[] {
    return [...new Set(this.listRouteIdsFn())];
  }

  forgetRoute(routeId: string): void {
    this.apiLatest.delete(routeId);
    this.eventLatest.delete(routeId);
    this.lockedUntil.delete(routeId);
    this.inFlight.delete(routeId);
    this.routeGeneration.set(routeId, (this.routeGeneration.get(routeId) ?? 0) + 1);
  }

  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
    routeId: string,
  ): void {
    this.eventLatest.set(routeId, { session, weekly, at: this.now() });
  }

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    const api = this.apiLatest.get(routeId) ?? null;
    const event = this.eventLatest.get(routeId) ?? null;
    const lockedUntilNow = this.lockedUntil.get(routeId) ?? 0;
    const locked = lockedUntilNow > this.now();
    // A lockout needs a countdown even before the first reading.
    if (!api && !event && !locked) return null;

    const latest = pickFresher(api, event);
    return {
      serviceId: this.serviceId,
      billingMode: this.billingMode,
      routeId,
      plan: null,
      session: latest?.session ?? null,
      weekly: latest?.weekly ?? null,
      ...(latest ? { availableWindows: namedWindows(latest) } : {}),
      fetchedAt: latest?.at ?? 0,
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
    const credentialDir = this.credentialDirForRoute(routeId);
    if (credentialDir === undefined) {
      return { routeId, outcome: "no-credentials", detail: "no xAI account behind this credential" };
    }
    const parsedAuth = readXaiAuthFile(grokAuthFileFor(credentialDir));
    const token = parsedAuth ? extractXaiAccessToken(parsedAuth) : null;
    if (!token) {
      return { routeId, outcome: "no-credentials", detail: "no usable token in this account's auth.json" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(XAI_QUOTA_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "ShipIt-Orchestrator/1.0 (xai-limits)",
        },
      });
    } catch (err) {
      console.warn(`[xai-limits] usage fetch network error: ${errMsg(err)}`);
      return { routeId, outcome: "failed", detail: `network error: ${errMsg(err)}` };
    }

    if (response.status === 429) {
      if ((this.routeGeneration.get(routeId) ?? 0) !== generation) {
        return { routeId, outcome: "skipped" };
      }
      const until = this.now() + retryAfterMs(response);
      this.lockedUntil.set(routeId, until);
      console.warn(
        `[xai-limits] usage fetch 429 for ${routeId} — locked out until ${new Date(until).toISOString()}`,
      );
      return { routeId, outcome: "rate-limited", lockedUntil: until };
    }
    if (response.status === 401) {
      console.warn("[xai-limits] usage fetch rejected the token (HTTP 401)");
      return { routeId, outcome: "expired-token", detail: "xAI rejected this sign-in (HTTP 401)" };
    }
    if (response.status === 403) {
      console.warn("[xai-limits] usage fetch forbidden (HTTP 403)");
      return { routeId, outcome: "no-credentials", detail: "xAI refused this credential (HTTP 403)" };
    }
    if (!response.ok) {
      console.warn(`[xai-limits] usage fetch HTTP ${response.status}`);
      return { routeId, outcome: "failed", detail: `HTTP ${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      console.warn(`[xai-limits] usage fetch non-JSON body: ${errMsg(err)}`);
      return { routeId, outcome: "failed", detail: "response was not JSON" };
    }

    const parsed = parseXaiBilling(body);
    if (!parsed) {
      console.warn("[xai-limits] billing payload not recognised — reporting nothing rather than a guess");
      return { routeId, outcome: "failed", detail: "unexpected billing payload" };
    }
    if ((this.routeGeneration.get(routeId) ?? 0) !== generation) {
      return { routeId, outcome: "skipped" };
    }
    this.lockedUntil.delete(routeId);
    this.apiLatest.set(routeId, {
      session: null,
      weekly: parsed.weekly,
      at: this.now(),
    });
    return { routeId, outcome: "updated" };
  }
}

function namedWindows(snap: WindowSnapshot): SubscriptionWindowName[] {
  const out: SubscriptionWindowName[] = [];
  if (snap.session) out.push("session");
  if (snap.weekly) out.push("weekly");
  return out;
}

function pickFresher(a: WindowSnapshot | null, b: WindowSnapshot | null): WindowSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

export function parseXaiBilling(body: unknown): { weekly: SubscriptionLimitsWindow } | null {
  if (!isRecord(body)) return null;
  const config = isRecord(body.config) ? body.config : body;

  const usedPct = readPct(config.creditUsagePercent);
  if (usedPct === null) return null;

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  if (!period) return null;
  // Other periods would be mislabeled as 7d; billingPeriodStart/End omit the type.
  if (period.type !== WEEKLY_PERIOD_TYPE) return null;

  const resetAt = readIso(period.end);
  if (resetAt === null) return null;
  const startedAt = readIso(period.start);

  return {
    weekly: {
      usedPct,
      resetAt,
      ...(startedAt === null ? {} : { startedAt }),
    },
  };
}

// Reject out-of-range values: clamping could hide a changed undocumented schema.
function readPct(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 100) return null;
  return raw;
}

function readIso(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return DEFAULT_429_LOCKOUT_MS;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
