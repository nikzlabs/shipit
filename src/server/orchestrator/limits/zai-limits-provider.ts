/**
 * ZaiLimitsProvider — the quota reader behind the catalogue's `zai-plan-usage`
 * (planning#339, docs/252 reqs 10 and 15).
 *
 * GLM's coding plan is the launch subscription on a **non-first-party** service,
 * so it is the one that proves req 10's indicator is a property of a
 * `(service, billing mode)` rather than of a harness. It differs from both
 * shipped providers in two ways that shape everything below:
 *
 *   1. **No harness owns it.** The plan is authenticated by a pasted key
 *      (`ZAI_CODING_PLAN_KEY`) delivered to whichever harness carries it, so
 *      this provider is not in `buildAgentRuntime`'s per-`AgentId` table. It
 *      joins the registry the same way the other two do — by declaring its own
 *      `(serviceId, billingMode)` — which is exactly the seam docs/252 phase 6
 *      opened.
 *   2. **No event stream.** Nothing pushes GLM's numbers during a turn, so the
 *      snapshot is *pulled*: `refreshNow()` fetches, and the registry's
 *      `fetch()` returns what was last pulled. `setRateLimits()` is still
 *      honoured — if a harness ever does report a reading for a GLM credential
 *      it is a real reading and dropping it would be a lie of omission — but
 *      nothing is known to produce one.
 *
 * ## The payload, as measured
 *
 * `GET https://api.z.ai/api/monitor/usage/quota/limit` is undocumented — it is
 * the internal endpoint behind Z.ai's own subscription UI. It was exercised
 * against a real coding-plan key on 2026-08-17, and **every field guess taken
 * from community reports was wrong**, which is the single most useful fact in
 * this file:
 *
 * ```jsonc
 * { "code": 200, "msg": "Operation successful", "success": true,
 *   "data": {
 *     "level": "lite",                       // the PLAN TIER
 *     "limits": [
 *       // the 5-hour window, before it has been opened by any usage:
 *       { "type": "CREDIT_LIMIT", "unit": 3, "number": 5,
 *         "usage": 2000, "remaining": 2000, "currentValue": 0, "percentage": 0 },
 *       // the long window:
 *       { "type": "CREDIT_LIMIT", "unit": 6, "number": 1,
 *         "usage": 10000, "remaining": 9210, "currentValue": 789,
 *         "percentage": 7, "nextResetTime": 1787407089998 }
 *     ] } }
 * ```
 *
 * Four things it establishes, each of which a plausible reading gets backwards:
 *
 *   - **`usage` is the ALLOWANCE, not the consumption**, and certainly not a
 *     percentage. Consumption is `usage - remaining`. A reader that treated
 *     `usage` as a percent — which is what the community field names suggested —
 *     would have reported this plan as 100% spent while it sat at 0.05%.
 *   - **`currentValue` lags and must not be used.** After one small call
 *     `remaining` moved 2000 → 1999 while `currentValue` stayed at 0, so the two
 *     disagree inside a single entry. `usage - remaining` is self-consistent in
 *     both entries; `currentValue` is not.
 *   - **`percentage` is unreliable at the low end.** The same entry reported
 *     `1` for a true 0.05%. It is kept only as a fallback for a payload that
 *     omits `remaining`, never in preference to the exact fraction.
 *   - **A window with no usage yet carries no `nextResetTime`.** The 5-hour
 *     entry gained one the moment a request landed, resetting exactly 5.00 hours
 *     later. So an absent reset is "no window is open", not a malformed payload.
 *
 * `unit` + `number` define the window length, so both windows carry a real
 * `startedAt` rather than one inferred from the badge's own constants.
 * **`unit: 3` is hours** — measured: `number: 5` produced a reset exactly five
 * hours out. **`unit: 6` is weeks** — confirmed by the plan holder rather than
 * measured, because one reset boundary cannot tell a weekly cycle from a
 * monthly one. The two provenances are recorded at {@link UNIT_MS}, which is
 * where a third unit would have to justify itself.
 *
 * ## The parser still fails closed
 *
 * The measurement pins today's contract; it does not make it a published one,
 * and this endpoint can change without notice. So {@link parseZaiQuota}
 * discards anything it cannot read completely, and the rules below are what
 * turned a wrong-shaped payload into an empty pill rather than a fabricated
 * "100% used" bar when the guesses were tested:
 *
 *   - **A window needs a consumed fraction AND a future reset time.**
 *   - **A percentage outside 0–100, or a `remaining` outside `[0, usage]`, is a
 *     misread field, not a value to clamp.** Clamping is right against a
 *     documented API — Claude's reader does exactly that — and wrong here,
 *     because being out of range is the evidence that the field is not what we
 *     think it is.
 *   - **Two windows that cannot be told apart report nothing.** Ambiguity is
 *     resolved by discarding, never by picking.
 */

import type { LimitsProvider } from "../agents/types.js";
import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsWindow,
  SubscriptionWindowName,
} from "../../shared/types.js";

/** Z.ai's internal quota endpoint — see this module's docstring. */
export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/** The catalogue id of the service this reader reports for. */
export const ZAI_SERVICE_ID = "zai";

/**
 * Lockout after a 429 that carries no usable `Retry-After`.
 *
 * Deliberately not Anthropic's 30 minutes: that number is a measured property
 * of `/api/oauth/usage`, and copying it here would assert something about Z.ai
 * nobody has observed. Five minutes is short enough that a spurious lockout
 * costs the user little and long enough to stop a refresh loop.
 */
const DEFAULT_429_LOCKOUT_MS = 5 * 60_000;

const SESSION_WINDOW_MS = 5 * 60 * 60_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Clock-skew slack on each horizon, so a window reported at its full length still classifies. */
const SESSION_HORIZON_MS = SESSION_WINDOW_MS + 15 * 60_000;
const WEEKLY_HORIZON_MS = WEEKLY_WINDOW_MS + 60 * 60_000;

interface WindowSnapshot {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  /**
   * The plan tier, from the payload's `data.level` ("lite"). Carried on the
   * snapshot rather than fetched separately, because unlike Claude and Codex —
   * which read a tier out of a credentials file or a JWT claim — this one
   * arrives in the same response as the numbers.
   */
  plan: string | null;
  /**
   * The windows the plan HAS, as distinct from the windows this reading could
   * put a number on (planning#454). Absent on an event-pushed reading, which
   * carries no such statement.
   */
  windows?: SubscriptionWindowName[];
  at: number;
}

export interface ZaiLimitsDeps {
  /**
   * The route ids of every configured GLM subscription credential.
   *
   * Unlike the account-backed providers there is no cached-route union here:
   * a supplied secret is either stored or it is not, so the credential store is
   * the complete answer. A route that leaves this list loses its cached
   * snapshot on the registry's next pass, which is what makes deleting a
   * credential drop its pill.
   */
  listRouteIds: () => string[];
  /** The plan key behind one route. `undefined` once the credential is gone. */
  secretForRoute: (routeId: string) => string | undefined;
  /** Inject for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class ZaiLimitsProvider implements LimitsProvider {
  readonly serviceId = ZAI_SERVICE_ID;
  readonly billingMode = "sub" as const;

  private listRouteIdsFn: () => string[];
  private secretForRoute: (routeId: string) => string | undefined;
  private fetchImpl: typeof fetch;
  private now: () => number;

  /** Latest windows pulled from the quota endpoint, per route. */
  private apiLatest = new Map<string, WindowSnapshot>();
  /** Latest windows a harness pushed for this credential, per route. See the docstring. */
  private eventLatest = new Map<string, WindowSnapshot>();
  /** Epoch ms until which the endpoint is locked out after a 429, per route. */
  private lockedUntil = new Map<string, number>();
  /** Single-flight guard so concurrent refreshes share one request, per route. */
  private inFlight = new Map<string, Promise<LimitsRefreshResult>>();
  /** Invalidates a response that started before this route's secret changed. */
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
    // An event carries no tier, and inventing one is the same class of fiction
    // as inventing a percentage.
    this.eventLatest.set(routeId, { session, weekly, plan: null, at: this.now() });
  }

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    const api = this.apiLatest.get(routeId) ?? null;
    const event = this.eventLatest.get(routeId) ?? null;
    const lockedUntilNow = this.lockedUntil.get(routeId) ?? 0;
    const locked = lockedUntilNow > this.now();
    // A route with no reading but an active lockout still owes the user the
    // countdown behind its disabled refresh button (docs/161).
    if (!api && !event && !locked) return null;

    // Whole-snapshot freshness rather than Claude's per-window merge: both
    // windows arrive in one payload from each source here, so there is no
    // low-usage gap for one source to fill in the other. Picking the fresher
    // source keeps the two meters describing the same moment.
    const latest = pickFresher(api, event);
    return {
      serviceId: this.serviceId,
      billingMode: this.billingMode,
      routeId,
      plan: latest?.plan ?? null,
      session: latest?.session ?? null,
      weekly: latest?.weekly ?? null,
      // planning#454 — `data.limits[]` lists every window the plan has, so an
      // unmentioned one is genuinely absent and the pill must not draw a
      // `5h · —` for it. Only a reader whose payload is a COMPLETE statement
      // may say this; Claude's event stream is not one and stays silent.
      // Declared only when a reading exists — a lockout-only snapshot claims
      // nothing, and silence draws both.
      ...(latest?.windows ? { availableWindows: latest.windows } : {}),
      fetchedAt: latest?.at ?? 0,
      ...(locked ? { lockedUntil: lockedUntilNow } : {}),
    };
  }

  /**
   * Pull this route's quota from Z.ai.
   *
   * `"seed"` is the once-per-credential baseline (boot, and the moment a
   * credential is added) and self-skips once a reading exists; `"manual"` is
   * the user's refresh button and always attempts, subject only to the lockout.
   * Never throws — every failure is an outcome the button can explain.
   */
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
          // Z.ai's coding plan is a bearer token, not an `x-api-key` — the same
          // fact the catalogue records as `ANTHROPIC_AUTH_TOKEN` on this row.
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
      // Distinguished from a generic failure because the remedy differs: this
      // one is "replace the key", which is the message the pill's button shows.
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

/** The more recent of two snapshots, either of which may be absent. */
function pickFresher(a: WindowSnapshot | null, b: WindowSnapshot | null): WindowSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

// ---- Payload parsing ----

/**
 * Milliseconds per `unit` value, for the unit values whose meaning is
 * **established** — and the provenance of each differs, which is worth knowing
 * before adding a third.
 *
 *   - **`3` is hours — measured.** An entry with `number: 5` produced a
 *     `nextResetTime` exactly five hours after the request that opened the
 *     window. Predicted first, then confirmed by consuming a little quota and
 *     re-probing.
 *   - **`6` is weeks — confirmed by the plan holder**, not by measurement. One
 *     reset boundary cannot distinguish a weekly cycle from a monthly one (the
 *     observed window sat 4.85 days out and did not move between probes), so
 *     this one rests on someone who can see what Z.ai's own subscription UI
 *     calls that limit.
 *
 * Note the enum is NOT the sequential time-unit ladder it looks like — 3 is
 * hours and 6 is weeks, so the gaps are not days-then-weeks. That is exactly
 * why nothing else is listed: an unrecognised unit falls back to the reset
 * horizon in {@link readWindow}, which is less precise but cannot put a
 * confident-looking `startedAt` on a window whose length we invented.
 */
const UNIT_MS: Record<number, number> = {
  3: 60 * 60_000,
  6: 7 * 24 * 60 * 60_000,
};

/** Longest window that belongs in the `session` slot rather than the long one. */
const SESSION_SLOT_MAX_MS = 6 * 60 * 60_000;

/**
 * Read Z.ai's quota envelope into the two windows req 10's indicator renders,
 * plus the plan tier.
 *
 * Exported for its own tests: this function is the whole fail-closed contract,
 * and the rules it enforces are stated in this module's docstring. Returns
 * `null` when nothing usable was found — never a zeroed pair, which is the one
 * output that would look like a real reading.
 */
export function parseZaiQuota(
  body: unknown,
  now: number,
): {
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  plan: string | null;
  /** See the `windows` note at the end of this function. */
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

  // Two entries in one slot means neither the declared window length nor the
  // reset horizon could tell them apart. Showing either would be a coin flip
  // presented as a measurement.
  if (sessionAmbiguous) session = null;
  if (weeklyAmbiguous) weekly = null;
  if (!session && !weekly) return null;
  // The windows the plan HAS, which is a different question from the windows
  // this parse could report (planning#454). An ambiguous slot counts as PRESENT
  // — two entries landed in it, so the window plainly exists and only its
  // number is unresolvable. Reporting it absent would delete the slot from the
  // pill on the strength of a parse failure.
  const windows: SubscriptionWindowName[] = [];
  if (session || sessionAmbiguous) windows.push("session");
  if (weekly || weeklyAmbiguous) windows.push("weekly");
  return { session, weekly, plan: root.plan, windows };
}

/**
 * The `data.limits[]` array and `data.level`, tolerating an envelope one level
 * flatter than the measured one. The flat form is a guess kept because it costs
 * nothing — every entry still has to parse completely to count.
 */
function readEnvelope(body: unknown): { limits: Record<string, unknown>[]; plan: string | null } | null {
  if (!isRecord(body)) return null;
  // An explicit failure envelope is a failure, whatever else it carries.
  if (body.success === false) return null;
  const data = isRecord(body.data) ? body.data : body;
  const raw = Array.isArray(data.limits) ? data.limits : body.limits;
  if (!Array.isArray(raw)) return null;
  const limits = raw.filter(isRecord);
  if (limits.length === 0) return null;
  // `level` is the plan tier ("lite"). Titled for display, since every other
  // provider's `plan` is a proper noun ("Pro", "Max 20x") and this one arrives
  // lowercase.
  const level = typeof data.level === "string" ? data.level.trim() : "";
  const plan = level ? level.charAt(0).toUpperCase() + level.slice(1) : null;
  return { limits, plan };
}

/**
 * One `limits[]` entry, or `null` if it cannot be read completely.
 *
 * `isSessionSlot` is decided by the entry's DECLARED window length when its
 * `unit` is one we have measured, and by the reset horizon otherwise. The
 * declared length is preferred because it is the API's own statement rather
 * than our inference from a timestamp — and it is what lets the 5-hour window
 * carry an exact `startedAt`, so the badge's elapsed marker stops depending on
 * a constant this vendor never agreed to.
 */
function readWindow(
  entry: Record<string, unknown>,
  now: number,
): { window: SubscriptionLimitsWindow; isSessionSlot: boolean } | null {
  const usedPct = readConsumedPct(entry);
  if (usedPct === null) return null;
  const resetMs = readTimestamp(entry);
  // No reset time means no window is open yet (the measured shape of an unused
  // 5-hour window), and a reset already past describes a period that has ended.
  // Neither is evidence about now — `subscriptionWindowIsCurrent` says the same
  // thing downstream — and neither can be placed on a horizon.
  if (resetMs === null || resetMs - now <= 0) return null;

  const windowMs = readDeclaredWindowMs(entry);
  const isSessionSlot = windowMs !== null
    ? windowMs <= SESSION_SLOT_MAX_MS
    : resetMs - now <= SESSION_HORIZON_MS;
  // A window longer than a week that we could only place by horizon is not one
  // of the two slots this indicator renders; drop it rather than file it as
  // "7d". A DECLARED length is trusted even when long, because the API said it.
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

/** The entry's declared window length, when its `unit` is one we have measured. */
function readDeclaredWindowMs(entry: Record<string, unknown>): number | null {
  const unit = entry.unit;
  const number = entry.number;
  if (typeof unit !== "number" || typeof number !== "number") return null;
  if (!Number.isFinite(number) || number <= 0) return null;
  const unitMs = UNIT_MS[unit];
  return unitMs === undefined ? null : unitMs * number;
}

/**
 * The fraction of this window's allowance already consumed, 0–100.
 *
 * **`usage` is the allowance and `remaining` is what is left**, so consumption
 * is their difference — measured, and the correction that matters most in this
 * file. Reading `usage` as a percentage (the shape community reports suggested)
 * turns a plan at 0.05% into one reporting 100%.
 *
 * `percentage` is a fallback only. The same entry that was truly at 0.05%
 * reported `1`, so it is the coarser answer; and `currentValue` is not used at
 * all, because it lagged `remaining` inside a single entry.
 *
 * Out-of-range values are rejected rather than clamped: being out of range is
 * the evidence that the field is not what we think it is.
 */
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

/** The entry's reset instant as epoch ms, from an ISO string or an epoch number. */
function readTimestamp(entry: Record<string, unknown>): number | null {
  for (const key of RESET_KEYS) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      // Seconds or milliseconds — the boundary is the year 2286 in seconds and
      // 1970 in milliseconds, so nothing real is ambiguous.
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
