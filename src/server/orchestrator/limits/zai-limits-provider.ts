import type { LimitsProvider } from "../agents/types.js";
import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsWindow,
  SubscriptionWindowName,
} from "../../shared/types.js";

export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

export const ZAI_SERVICE_ID = "zai";

// Defensive fallback, not a measured Z.ai retry interval.
const DEFAULT_429_LOCKOUT_MS = 5 * 60_000;

const SESSION_WINDOW_MS = 5 * 60 * 60_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;
// Allow clock skew when classifying a window at its full length.
const SESSION_HORIZON_MS = SESSION_WINDOW_MS + 15 * 60_000;
const WEEKLY_HORIZON_MS = WEEKLY_WINDOW_MS + 60 * 60_000;

interface WindowSnapshot {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  plan: string | null;
  // Declared windows can include an ambiguous reading. Events omit this field.
  windows?: SubscriptionWindowName[];
  at: number;
}

export interface ZaiLimitsDeps {
  listRouteIds: () => string[];
  secretForRoute: (routeId: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ZaiLimitsProvider implements LimitsProvider {
  readonly serviceId = ZAI_SERVICE_ID;
  readonly billingMode = "sub" as const;

  private listRouteIdsFn: () => string[];
  private secretForRoute: (routeId: string) => string | undefined;
  private fetchImpl: typeof fetch;
  private now: () => number;

  private apiLatest = new Map<string, WindowSnapshot>();
  private eventLatest = new Map<string, WindowSnapshot>();
  private lockedUntil = new Map<string, number>();
  private inFlight = new Map<string, Promise<LimitsRefreshResult>>();
  private routeGeneration = new Map<string, number>();

  constructor(deps: ZaiLimitsDeps) {
    this.listRouteIdsFn = deps.listRouteIds;
    this.secretForRoute = deps.secretForRoute;
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
    this.eventLatest.set(routeId, { session, weekly, plan: null, at: this.now() });
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
      plan: latest?.plan ?? null,
      session: latest?.session ?? null,
      weekly: latest?.weekly ?? null,
      ...(latest?.windows ? { availableWindows: latest.windows } : {}),
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
    const secret = this.secretForRoute(routeId);
    if (!secret) {
      return { routeId, outcome: "no-credentials", detail: "no GLM plan key stored for this credential" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(ZAI_QUOTA_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
          "User-Agent": "ShipIt-Orchestrator/1.0 (zai-limits)",
        },
      });
    } catch (err) {
      console.warn(`[zai-limits] quota fetch network error: ${errMsg(err)}`);
      return { routeId, outcome: "failed", detail: `network error: ${errMsg(err)}` };
    }

    if (response.status === 429) {
      if ((this.routeGeneration.get(routeId) ?? 0) !== generation) {
        return { routeId, outcome: "skipped" };
      }
      const until = this.now() + retryAfterMs(response);
      this.lockedUntil.set(routeId, until);
      console.warn(
        `[zai-limits] quota fetch 429 for ${routeId} — locked out until ${new Date(until).toISOString()}`,
      );
      return { routeId, outcome: "rate-limited", lockedUntil: until };
    }
    if (response.status === 401 || response.status === 403) {
      console.warn(`[zai-limits] quota fetch rejected the plan key (HTTP ${response.status})`);
      return { routeId, outcome: "no-credentials", detail: `GLM rejected this key (HTTP ${response.status})` };
    }
    if (!response.ok) {
      console.warn(`[zai-limits] quota fetch HTTP ${response.status}`);
      return { routeId, outcome: "failed", detail: `HTTP ${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      console.warn(`[zai-limits] quota fetch non-JSON body: ${errMsg(err)}`);
      return { routeId, outcome: "failed", detail: "response was not JSON" };
    }

    const parsed = parseZaiQuota(body, this.now());
    if (!parsed) {
      console.warn("[zai-limits] quota payload not recognised — reporting nothing rather than a guess");
      return { routeId, outcome: "failed", detail: "unexpected quota payload" };
    }
    if ((this.routeGeneration.get(routeId) ?? 0) !== generation) {
      return { routeId, outcome: "skipped" };
    }
    this.lockedUntil.delete(routeId);
    this.apiLatest.set(routeId, {
      session: parsed.session,
      weekly: parsed.weekly,
      plan: parsed.plan,
      windows: parsed.windows,
      at: this.now(),
    });
    return { routeId, outcome: "updated" };
  }
}

function pickFresher(a: WindowSnapshot | null, b: WindowSnapshot | null): WindowSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

// Unit 3 was measured as hours on 2026-08-17; unit 6 was confirmed as weeks by the plan holder.
// Unknown units use the reset horizon; do not infer missing enum values.
const UNIT_MS: Record<number, number> = {
  3: 60 * 60_000,
  6: 7 * 24 * 60 * 60_000,
};

const SESSION_SLOT_MAX_MS = 6 * 60 * 60_000;

export function parseZaiQuota(
  body: unknown,
  now: number,
): {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  plan: string | null;
  windows: SubscriptionWindowName[];
} | null {
  const root = readEnvelope(body);
  if (!root) return null;

  let session: SubscriptionLimitsWindow | null = null;
  let weekly: SubscriptionLimitsWindow | null = null;
  let sessionAmbiguous = false;
  let weeklyAmbiguous = false;

  for (const entry of root.limits) {
    const read = readWindow(entry, now);
    if (!read) continue;
    if (read.isSessionSlot) {
      if (session) sessionAmbiguous = true;
      session = read.window;
    } else {
      if (weekly) weeklyAmbiguous = true;
      weekly = read.window;
    }
  }

  if (sessionAmbiguous) session = null;
  if (weeklyAmbiguous) weekly = null;
  if (!session && !weekly) return null;
  // Ambiguous readings still establish that a window exists.
  const windows: SubscriptionWindowName[] = [];
  if (session || sessionAmbiguous) windows.push("session");
  if (weekly || weeklyAmbiguous) windows.push("weekly");
  return { session, weekly, plan: root.plan, windows };
}

function readEnvelope(body: unknown): { limits: Record<string, unknown>[]; plan: string | null } | null {
  if (!isRecord(body)) return null;
  if (body.success === false) return null;
  const data = isRecord(body.data) ? body.data : body;
  const raw = Array.isArray(data.limits) ? data.limits : body.limits;
  if (!Array.isArray(raw)) return null;
  const limits = raw.filter(isRecord);
  if (limits.length === 0) return null;
  const level = typeof data.level === "string" ? data.level.trim() : "";
  const plan = level ? level.charAt(0).toUpperCase() + level.slice(1) : null;
  return { limits, plan };
}

function readWindow(
  entry: Record<string, unknown>,
  now: number,
): { window: SubscriptionLimitsWindow; isSessionSlot: boolean } | null {
  const usedPct = readConsumedPct(entry);
  if (usedPct === null) return null;
  const resetMs = readTimestamp(entry);
  // An unused window omits its reset time.
  if (resetMs === null || resetMs - now <= 0) return null;

  const windowMs = readDeclaredWindowMs(entry);
  const isSessionSlot = windowMs !== null
    ? windowMs <= SESSION_SLOT_MAX_MS
    : resetMs - now <= SESSION_HORIZON_MS;
  if (windowMs === null && !isSessionSlot && resetMs - now > WEEKLY_HORIZON_MS) return null;

  return {
    window: {
      usedPct,
      resetAt: new Date(resetMs).toISOString(),
      ...(windowMs !== null ? { startedAt: new Date(resetMs - windowMs).toISOString() } : {}),
    },
    isSessionSlot,
  };
}

function readDeclaredWindowMs(entry: Record<string, unknown>): number | null {
  const unit = entry.unit;
  const number = entry.number;
  if (typeof unit !== "number" || typeof number !== "number") return null;
  if (!Number.isFinite(number) || number <= 0) return null;
  const unitMs = UNIT_MS[unit];
  return unitMs === undefined ? null : unitMs * number;
}

// Measured on 2026-08-17: usage is the allowance; currentValue lags remaining.
// Prefer the exact fraction: percentage reported 1 for 0.05% consumption.
function readConsumedPct(entry: Record<string, unknown>): number | null {
  const allowance = entry.usage;
  const remaining = entry.remaining;
  if (
    typeof allowance === "number" && Number.isFinite(allowance) && allowance > 0
    && typeof remaining === "number" && Number.isFinite(remaining)
    && remaining >= 0 && remaining <= allowance
  ) {
    return ((allowance - remaining) / allowance) * 100;
  }
  const percentage = entry.percentage;
  if (typeof percentage === "number" && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
    return percentage;
  }
  return null;
}

const RESET_KEYS = [
  "nextResetTime",
  "next_reset_time",
  "resetTime",
  "reset_time",
  "resetAt",
  "reset_at",
  "resetsAt",
  "resets_at",
];

function readTimestamp(entry: Record<string, unknown>): number | null {
  for (const key of RESET_KEYS) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value < 10_000_000_000 ? value * 1000 : value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
