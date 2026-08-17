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
 * ## The contract is reverse-engineered, and the parser is written that way
 *
 * `GET https://api.z.ai/api/monitor/usage/quota/limit` is the internal endpoint
 * behind Z.ai's own subscription UI. It is **not documented by Z.ai** and can
 * change without notice, so every field name below is a guess informed by
 * community implementations rather than a published contract.
 *
 * That is why {@link parseZaiQuota} **fails closed**: anything it cannot read
 * completely and unambiguously yields no window, and a payload that yields no
 * window at all yields no snapshot. req 10 prefers no indicator to a fictional
 * one, and a quota bar that is quietly wrong is the same dishonesty phase 5
 * refused to build a failover cutoff over. Three specific choices follow from
 * it, each of which would be over-cautious against a documented API:
 *
 *   - **A window needs a percentage AND a reset time.** An entry with only one
 *     of them is more likely a field we misread than a window that is half
 *     reported, so it is discarded rather than rendered as a bare countdown.
 *   - **A percentage outside 0–100 is a misread, not a value to clamp.** If
 *     `usage` turns out to be a token count, clamping would render "100% used"
 *     for a plan that is barely touched. The whole entry is dropped instead.
 *   - **Windows are told apart by their reset horizon, not by the `unit` field.**
 *     Community reports say a numeric `unit` distinguishes the 5-hour window
 *     from the weekly one, but not which value means which — and guessing wrong
 *     swaps the two meters silently. A reset that falls within ~5h is the
 *     session window and one beyond it is the weekly window, which needs no
 *     magic number and checks itself. Two entries landing in the same bucket
 *     are ambiguous and that bucket reports nothing.
 *
 * Until this has been exercised against a real GLM coding-plan key, the honest
 * summary is that a correct payload renders correctly and every other payload
 * renders nothing.
 */

import type { LimitsProvider } from "../agents/types.js";
import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsWindow,
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
    this.eventLatest.set(routeId, { session, weekly, at: this.now() });
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
      // The payload carries no tier name we can trust, and inventing one is the
      // same class of fiction as inventing a percentage.
      plan: null,
      session: latest?.session ?? null,
      weekly: latest?.weekly ?? null,
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
    this.apiLatest.set(routeId, { session: parsed.session, weekly: parsed.weekly, at: this.now() });
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
 * Read Z.ai's quota envelope into the two windows req 10's indicator renders.
 *
 * Exported for its own tests: this function is the whole fail-closed contract,
 * and the rules it enforces are stated in this module's docstring. Returns
 * `null` when nothing usable was found — never a zeroed pair, which is the one
 * output that would look like a real reading.
 */
export function parseZaiQuota(
  body: unknown,
  now: number,
): { session: SubscriptionLimitsWindow | null; weekly: SubscriptionLimitsWindow | null } | null {
  const entries = readLimitEntries(body);
  if (!entries) return null;

  let session: SubscriptionLimitsWindow | null = null;
  let weekly: SubscriptionLimitsWindow | null = null;
  let sessionAmbiguous = false;
  let weeklyAmbiguous = false;

  for (const entry of entries) {
    const read = readWindow(entry, now);
    if (!read) continue;
    if (read.dueInMs <= SESSION_HORIZON_MS) {
      if (session) sessionAmbiguous = true;
      session = read.window;
    } else if (read.dueInMs <= WEEKLY_HORIZON_MS) {
      if (weekly) weeklyAmbiguous = true;
      weekly = read.window;
    }
    // A reset beyond a week belongs to no window this indicator renders
    // (a monthly allowance, a subscription expiry) and is left alone.
  }

  // Two entries in one bucket means the horizon rule could not tell them apart.
  // Showing either would be a coin flip presented as a measurement.
  if (sessionAmbiguous) session = null;
  if (weeklyAmbiguous) weekly = null;
  if (!session && !weekly) return null;
  return { session, weekly };
}

/**
 * The `data.limits[]` array, tolerating an envelope that is one level flatter
 * than reported. Both shapes are guesses; accepting either costs nothing,
 * because every entry still has to parse completely to count.
 */
function readLimitEntries(body: unknown): Record<string, unknown>[] | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  // An explicit failure envelope is a failure, whatever else it carries.
  if (root.success === false) return null;
  const data = isRecord(root.data) ? root.data : root;
  const limits = Array.isArray(data.limits) ? data.limits : root.limits;
  if (!Array.isArray(limits)) return null;
  const entries = limits.filter(isRecord);
  return entries.length > 0 ? entries : null;
}

/**
 * One `limits[]` entry, or `null` if it cannot be read completely.
 *
 * `dueInMs` comes back alongside the window because the caller classifies by
 * reset horizon rather than by the entry's own `unit` field — see the module
 * docstring for why.
 */
function readWindow(
  entry: Record<string, unknown>,
  now: number,
): { window: SubscriptionLimitsWindow; dueInMs: number } | null {
  const usedPct = readPercent(entry);
  if (usedPct === null) return null;
  const resetMs = readTimestamp(entry);
  if (resetMs === null) return null;
  const dueInMs = resetMs - now;
  // A window that has already reset describes a period that has ended, so it is
  // not evidence about now (`subscriptionWindowIsCurrent` says the same thing
  // downstream). Reading one here would also misclassify it as the 5h window.
  if (dueInMs <= 0) return null;
  return { window: { usedPct, resetAt: new Date(resetMs).toISOString() }, dueInMs };
}

const PERCENT_KEYS = [
  "usage",
  "usagePercent",
  "usage_percent",
  "used",
  "usedPct",
  "used_pct",
  "utilization",
  "percent",
  "percentage",
];

/**
 * The entry's consumed percentage, on a 0–100 scale.
 *
 * A value outside that range is rejected rather than clamped. Against a
 * documented API clamping is right — Claude's reader does exactly that, and its
 * comment records the bug that came from treating a small value as a fraction.
 * Here the field NAMES are the guess, so an out-of-range number is evidence we
 * read the wrong field (a token count, a byte total), and clamping it to 100
 * would paint a full bar over an untouched plan.
 */
function readPercent(entry: Record<string, unknown>): number | null {
  for (const key of PERCENT_KEYS) {
    const value = entry[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < 0 || value > 100) return null;
    return value;
  }
  return null;
}

const RESET_KEYS = [
  "resetTime",
  "reset_time",
  "resetAt",
  "reset_at",
  "resetsAt",
  "resets_at",
  "nextResetTime",
  "next_reset_time",
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
