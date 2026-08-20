/**
 * XaiLimitsProvider — the quota reader behind the catalogue's `xai-plan-usage`
 * (planning#435, planning#454, docs/274 req 16).
 *
 * ## How this endpoint was missed, which is the useful part
 *
 * This subscription shipped declaring **no reader at all**. Three separate
 * checks agreed that xAI published no usage API, and all three were wrong the
 * same way — they treated an endpoint's surface as its set of PATHS:
 *
 *   - an unauthenticated route sweep tested paths (`/v1/usage`, `/v1/rate-limits`
 *     → nginx 404) and never varied a query string;
 *   - a strings dump of the `grok` binary was grepped with a path-shaped regex,
 *     which stopped at the `?` — so it found `/billing` and reported it as a
 *     dead end;
 *   - the authenticated probe was written from that path list, and called
 *     `GET /v1/billing` bare.
 *
 * And bare `/v1/billing` **answers 200**. It returns a different representation
 * — calendar-month credit spend, every field zero on a subscription — so it did
 * not look like a wrong call, it looked like proof there was nothing to read. A
 * 200 that answers a different question is more dangerous than a 404, because a
 * 404 is never mistaken for an answer. `/billing?format=credits` was a literal
 * in the vendor's own binary the whole time.
 *
 * ## The payload, as measured
 *
 * `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, exercised
 * against a live SuperGrok token on 2026-08-20:
 *
 * ```jsonc
 * { "config": {
 *     "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY",
 *                        "start": "2026-08-18T09:41:48.430622+00:00",
 *                        "end":   "2026-08-25T09:41:48.430622+00:00" },
 *     "creditUsagePercent": 10.0,              // the POOL — what the pill shows
 *     "productUsage": [ { "product": "GrokBuild", "usagePercent": 10.0 },
 *                       { "product": "GrokChat" } ],   // note: no field at all
 *     "onDemandCap": { "val": 0 }, "onDemandUsed": { "val": 0 },
 *     "prepaidBalance": { "val": 0 }, "isUnifiedBillingUser": true,
 *     "billingPeriodStart": "…", "billingPeriodEnd": "…" } }   // mirror the period
 * ```
 *
 * Three things it settles:
 *
 *   - **One pool, shared across products.** `creditUsagePercent` is the figure
 *     that limits the user; `productUsage[]` is a breakdown of the same pool and
 *     is deliberately not rendered — the pill has one number per window, and a
 *     per-product split would invite reading two of them as two allowances. An
 *     unused product carries no `usagePercent` key at all rather than a zero.
 *   - **There is NO short window.** The plan has a weekly allowance and nothing
 *     else, so {@link parseXaiBilling} reports the session slot as `null` and
 *     the pill draws no `5h` meter for it (`windowsShown`). Reporting a window
 *     the plan does not have is what produced the empty read-out this feature
 *     was opened to fix.
 *   - **The period is stated, not inferred.** `currentPeriod.start`/`.end` give
 *     a real `startedAt`, so the pill's elapsed-time marker is measured rather
 *     than derived from its own 7-day constant.
 *
 * ## Fail-closed rules
 *
 * The measurement pins today's contract; it does not make it a published one.
 * So a payload that cannot be read completely reports nothing:
 *
 *   - **A percentage outside 0–100 is a misread field, not a value to clamp.**
 *     Being out of range is the evidence that the field is not what we think it
 *     is. (Same rule as the GLM reader, and the opposite of Claude's — clamping
 *     is right against a documented API and wrong against a guessed one.)
 *   - **A period that is not weekly is refused.** The pill labels this window
 *     `7d`, so a monthly period would be mislabelled rather than merely
 *     imprecise. If xAI ever reports one, that needs a window slot the pill does
 *     not currently have — not a relabelled weekly one.
 *   - **`billingPeriodStart`/`End` are NOT used as a fallback** for a missing
 *     `currentPeriod`. They carry no `type`, so accepting them would mean
 *     guessing the window length that the previous rule exists to refuse.
 */

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
} from "../../shared/types.js";

/** xAI's subscription billing endpoint — see this module's docstring. */
export const XAI_QUOTA_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/** The catalogue id of the service this reader reports for. */
export const XAI_SERVICE_ID = "xai";

/**
 * Lockout after a 429 that carries no usable `Retry-After`.
 *
 * Five minutes, matching the GLM reader and for the same reason: Anthropic's 30
 * is a MEASURED property of `/api/oauth/usage`, and copying it here would assert
 * something about xAI nobody has observed. No 429 has been seen from this
 * endpoint at all; the lockout exists so that one cannot become a refresh loop.
 */
const DEFAULT_429_LOCKOUT_MS = 5 * 60_000;

/** The only `currentPeriod.type` this reader accepts — see the fail-closed rules. */
const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";

interface WindowSnapshot {
  /**
   * Always `null` today: the plan has no short window (see the docstring). Kept
   * as a field rather than dropped because {@link setRateLimits} can be handed
   * one by a harness, and discarding a real reading would be a lie of omission.
   */
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  at: number;
}

export interface XaiLimitsDeps {
  /** The route ids of every connected xAI subscription account. */
  listRouteIds: () => string[];
  /**
   * The credential root holding one route's `.grok/auth.json`. `undefined` once
   * the account is gone.
   *
   * A directory rather than a token: the CLI refreshes `auth.json` in place
   * roughly every six hours, so a token captured at registration would go stale
   * between refreshes. Reading the file per request is what keeps this reader
   * using the same credential the harness does.
   */
  credentialDirForRoute: (routeId: string) => string | undefined;
  /** Inject for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Inject for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class XaiLimitsProvider implements LimitsProvider {
  readonly serviceId = XAI_SERVICE_ID;
  readonly billingMode = "sub" as const;

  private listRouteIdsFn: () => string[];
  private credentialDirForRoute: (routeId: string) => string | undefined;
  private fetchImpl: typeof fetch;
  private now: () => number;

  /** Latest windows pulled from the billing endpoint, per route. */
  private apiLatest = new Map<string, WindowSnapshot>();
  /** Latest windows a harness pushed for this credential, per route. */
  private eventLatest = new Map<string, WindowSnapshot>();
  /** Epoch ms until which the endpoint is locked out after a 429, per route. */
  private lockedUntil = new Map<string, number>();
  /** Single-flight guard so concurrent refreshes share one request, per route. */
  private inFlight = new Map<string, Promise<LimitsRefreshResult>>();
  /** Invalidates a response that started before this route's credential changed. */
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
    // A route with no reading but an active lockout still owes the user the
    // countdown behind its disabled refresh button (docs/161).
    if (!api && !event && !locked) return null;

    // Whole-snapshot freshness, like the GLM reader: one payload carries
    // everything, so there is no per-window gap for a second source to fill.
    const latest = pickFresher(api, event);
    return {
      serviceId: this.serviceId,
      billingMode: this.billingMode,
      routeId,
      // Not a gap — the plan name is reachable at `/v1/settings` and was
      // declined (docs/274 requirements.md, 2026-08-20 receipt): a second call
      // to a second endpoint for a label nobody asked for.
      plan: null,
      session: latest?.session ?? null,
      weekly: latest?.weekly ?? null,
      fetchedAt: latest?.at ?? 0,
      ...(locked ? { lockedUntil: lockedUntilNow } : {}),
    };
  }

  /**
   * Pull this route's usage from xAI.
   *
   * `"seed"` is the once-per-credential baseline (boot, and the moment a
   * sign-in completes) and self-skips once a reading exists; `"manual"` is the
   * user's refresh button and always attempts, subject only to the lockout.
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
    // The two rejections are distinguished because the remedies differ, and for
    // an OAuth account the likelier one is a lapsed sign-in rather than a
    // credential that was never good.
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
      // No short window on this plan — stated here rather than left to a
      // default, because `null` is what stops the pill drawing an empty `5h`.
      session: null,
      weekly: parsed.weekly,
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
 * Read xAI's billing envelope into the one window this plan has.
 *
 * Exported for its own tests: this function is the whole fail-closed contract,
 * and the rules it enforces are stated in this module's docstring. Returns
 * `null` when nothing usable was found — never a zeroed window, which would
 * report a spent plan as fresh or a fresh one as unknown.
 */
export function parseXaiBilling(body: unknown): { weekly: SubscriptionLimitsWindow } | null {
  if (!isRecord(body)) return null;
  // Tolerate an envelope one level flatter than the measured one. It costs
  // nothing — every field below still has to parse completely to count.
  const config = isRecord(body.config) ? body.config : body;

  const usedPct = readPct(config.creditUsagePercent);
  if (usedPct === null) return null;

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  if (!period) return null;
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

/**
 * A percentage that is 0–100, or `null`.
 *
 * Out of range REJECTS rather than clamps: against an undocumented endpoint,
 * a value outside the range is the evidence that the field is not the one we
 * think it is, and clamping would turn that evidence into a confident number.
 */
function readPct(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 100) return null;
  return raw;
}

/** An ISO-8601 instant normalized to a UTC ISO string, or `null`. */
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
