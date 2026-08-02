import { ArrowClockwiseIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot /api/oauth/usage fetch when the mobile status dropdown mounts it (external system sync)
import { useCallback, useEffect, useRef, useState } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import { useApi } from "../hooks/useApi.js";
import { Badge } from "./ui/badge.js";
import type {
  AgentId,
  LimitsRefreshOutcome,
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsMap,
  SubscriptionLimitsWindow,
} from "../../server/shared/types.js";
import { useSettingsStore } from "../stores/settings-store.js";

/**
 * Stable ordering of pills in the header. Matches the provider
 * registration order in `app-di.ts` / `index.ts` so muscle memory
 * works — Claude first, Codex second.
 */
const PILL_ORDER: AgentId[] = ["claude", "codex"];

const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * A known percentage older than this reads as "stale": the number is shown
 * dimmed and the tooltip carries its age. Claude's event numbers refresh on
 * every turn near the limit; the `/api/oauth/usage` number only refreshes on
 * the manual button, so at low usage it can legitimately age.
 */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Fixed window lengths backing the time marker. Claude's short window is 5h
 * and the weekly window is 7d (see `SubscriptionLimitsWindow`). The provider
 * only ever gives us `resetAt`, so the elapsed fraction is derived against
 * these constants — no extra data is fetched.
 */
const SESSION_WINDOW_MS = 5 * 60 * 60_000; // 5h
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000; // 7d

/**
 * Minimum gap between two **automatic** refreshes (`autoRefresh`, i.e. opening
 * the mobile status dropdown). Manual button presses are never throttled here.
 *
 * `/api/oauth/usage` allows only a handful of calls per ~30 min before a 429
 * lockout (docs/161), so the on-open fetch is rate-limited client-side: at
 * worst 6 automatic calls per 30 minutes, which stays inside the budget. A
 * reading up to 5 minutes old is also well inside `STALE_AFTER_MS`, so a
 * throttled open still shows a number the user reads as current.
 */
export const AUTO_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Last refresh attempt per **route**, module-scoped so it survives the
 * mount/unmount cycle of the popover that hosts the pill (Radix unmounts
 * `PopoverContent` on close, so component state can't carry the throttle).
 *
 * Keyed by route, not by provider: the upstream budget is per subscription, and
 * a provider-keyed throttle meant the second account's pill was silently
 * skipped on every dropdown open — it never got its own baseline reading.
 */
const lastRefreshAttemptAt = new Map<string, number>();

/** Test seam — clears the module-level auto-refresh throttle between cases. */
export function resetAutoRefreshThrottle(): void {
  lastRefreshAttemptAt.clear();
}

interface SubscriptionLimitsBadgeProps {
  limits: SubscriptionLimitsMap;
  /**
   * Fetch fresh usage once when this badge mounts (throttled by
   * `AUTO_REFRESH_MIN_INTERVAL_MS`). Set by the mobile status dropdown, whose
   * `PopoverContent` mounts on open — opening it *is* the user asking for the
   * number, so it spends a call the same way the refresh button does, without
   * requiring a second tap on a surface that has no hover tooltip.
   */
  autoRefresh?: boolean;
}

/**
 * Header badge group rendering one **pill per connected subscription** plus a
 * refresh button (Claude only — it's the one with an on-demand
 * `/api/oauth/usage` path). See docs/161 and
 * docs/135-subscription-limits-badge/plan.md.
 *
 * docs/150 req 10 — quota is per account, so a provider with two connected
 * subscriptions gets two pills, each labelled with that account's name.
 *
 * The name is shown whenever the route IS an account, unconditionally. An
 * earlier version suppressed it for the single-pill case, on the theory that a
 * name only earns its space when it disambiguates. That was wrong twice over:
 * req 10 asks for the account name outright, and — worse — the condition
 * counted *snapshots*, not accounts. Routes with no snapshot are omitted from
 * the map, so a user with two connected accounts where only one had ever
 * reported quota saw a single pill labelled "Claude", indistinguishable from
 * the one-account case and silent about which subscription it described.
 *
 * Reserved env / API-key routes are not accounts and keep the provider label.
 */
export function SubscriptionLimitsBadge({ limits, autoRefresh }: SubscriptionLimitsBadgeProps) {
  const accounts = useSettingsStore((s) => s.providerAccounts);
  const pills: {
    key: string;
    agentId: AgentId;
    routeId: string;
    label: string;
    snapshot?: SubscriptionLimits;
  }[] = [];
  for (const id of PILL_ORDER) {
    const byRoute = limits[id];
    const providerAccounts = accounts.filter((account) => account.provider === id);

    // Connected accounts define pill presence, not cached snapshots. A quiet
    // account may have no quota event yet, but its pill must remain available
    // so the user can request a refresh and see that usage is still unknown.
    for (const account of providerAccounts) {
      pills.push({
        key: `${id}:${account.id}`,
        agentId: id,
        routeId: account.id,
        label: account.label,
        snapshot: byRoute?.[account.id],
      });
    }

    // Reserved routes are not provider-account rows, so snapshots remain the
    // only evidence that they exist. Append them after the user's account order.
    for (const snapshot of Object.values(byRoute ?? {})) {
      if (providerAccounts.some((account) => account.id === snapshot.routeId)) continue;
      pills.push({
        key: `${id}:${snapshot.routeId}`,
        agentId: id,
        routeId: snapshot.routeId,
        label: AGENT_LABEL[id],
        snapshot,
      });
    }
  }
  if (pills.length === 0) return null;

  return (
    <>
      {pills.map(({ key, agentId, routeId, label, snapshot }) => (
        <SubscriptionLimitPill
          key={key}
          agentId={agentId}
          routeId={routeId}
          label={label}
          snapshot={snapshot}
          // eslint-disable-next-line no-restricted-syntax -- Claude is the only agent with an on-demand /api/oauth/usage refresh endpoint
          showRefresh={agentId === "claude"}
          autoRefresh={autoRefresh}
        />
      ))}
    </>
  );
}

interface SubscriptionLimitPillProps {
  agentId?: AgentId;
  /**
   * The subscription this pill describes — a provider-account id or a reserved
   * route id. Scopes the refresh to this account so one press costs one
   * upstream call instead of one per connected account.
   */
  routeId?: string;
  label: string;
  snapshot?: SubscriptionLimits;
  showRefresh?: boolean;
  /** See `SubscriptionLimitsBadgeProps.autoRefresh`. Only acts with `showRefresh`. */
  autoRefresh?: boolean;
}

export function SubscriptionLimitPill({ agentId, routeId, label, snapshot, showRefresh, autoRefresh }: SubscriptionLimitPillProps) {
  const now = Date.now();
  const resolvedAgentId = snapshot?.agentId ?? agentId;
  const resolvedRouteId = routeId ?? snapshot?.routeId;

  // The pill carries inline meters with underline gauges, so it overrides
  // Badge's symmetric padding with the asymmetric `pl-2 pr-* pt-0 pb-0.5` it
  // needs (tighter right edge when the refresh button is tucked in) and adds
  // the `gap-2` flex spacing between label / meters / button.
  return (
    <Badge
      numeric
      className={`gap-2 pl-2 ${showRefresh ? "pr-1" : "pr-2"} pt-0 pb-0.5 bg-(--color-bg-hover)`}
    >
      <span title={snapshot?.plan ? `${label} — ${snapshot.plan}` : label}>{label}</span>
      <Meter
        shortLabel="5h"
        longLabel="5h window"
        window={snapshot?.session ?? null}
        windowMs={SESSION_WINDOW_MS}
        fetchedAt={snapshot?.fetchedAt}
        now={now}
      />
      <Meter
        shortLabel="7d"
        longLabel="7d window"
        window={snapshot?.weekly ?? null}
        windowMs={WEEKLY_WINDOW_MS}
        fetchedAt={snapshot?.fetchedAt}
        now={now}
      />
      {showRefresh && resolvedAgentId && (
        <LimitsRefreshButton
          agentId={resolvedAgentId}
          routeId={resolvedRouteId}
          lockedUntil={snapshot?.lockedUntil}
          autoRefresh={autoRefresh}
        />
      )}
    </Badge>
  );
}

interface MeterProps {
  shortLabel: string;
  longLabel: string;
  window: SubscriptionLimitsWindow | null;
  /** Fixed length of this window in ms (5h / 7d) — drives the time marker. */
  windowMs: number;
  fetchedAt?: number;
  now: number;
}

/**
 * Fraction of the window already elapsed (0–100), derived from the fixed
 * window length: the window started at `resetAt − windowMs`, so elapsed =
 * `now − start`. Returns `null` when `resetAt` is unparseable so the marker
 * is simply omitted rather than drawn at a bogus position.
 *
 * This is the second dimension the pill was missing: "48% used" reads very
 * differently on day 1 of the week than on day 6. The marker shows where the
 * clock is, so quota-vs-time pace is legible at a glance — fill short of the
 * marker means you're under pace, fill past it means you're burning quota
 * faster than the window is elapsing.
 */
export function timeElapsedPct(
  resetAt: string,
  windowMs: number,
  now: number,
  startedAt?: string,
): number | null {
  const startMs = startedAt === undefined ? Date.parse(resetAt) - windowMs : Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const pct = ((now - startMs) / windowMs) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

type MeterDisplay =
  | { kind: "known"; pct: number; stale: boolean }
  | { kind: "reset" }
  | { kind: "unknown" };

/**
 * Classify how a window should render. The three "no live number" flavors are
 * deliberately distinct (docs/161): a window whose reset has elapsed reads as
 * **reset** (rolled over — the cached number is meaningless), a window the
 * provider never gave a number for reads as **unknown** (`—`), and a known
 * number older than `STALE_AFTER_MS` reads as **known but stale** (dimmed).
 */
export function meterDisplay(
  window: SubscriptionLimitsWindow,
  fetchedAt: number,
  now: number,
): MeterDisplay {
  const resetMs = Date.parse(window.resetAt);
  const elapsed = !Number.isNaN(resetMs) && resetMs <= now;
  if (elapsed) return { kind: "reset" };
  if (window.usedPct === null) return { kind: "unknown" };
  return { kind: "known", pct: window.usedPct, stale: now - fetchedAt > STALE_AFTER_MS };
}

/**
 * A single 5h / 7d meter. Known windows render the tier-colored `"5h NN%"`
 * with a thin underline gauge (dimmed when stale). Reset and unknown windows
 * render an explicit muted label instead of a percentage so the user can tell
 * "ShipIt doesn't know this number" from "it's 42%" at a glance — the old
 * behavior of showing a bare reset countdown looked like real data when it
 * wasn't (docs/161). The reset time itself moves to the tooltip in those
 * states.
 */
function Meter({ shortLabel, longLabel, window, windowMs, fetchedAt, now }: MeterProps) {
  const title = window
    ? `${formatWindowLine(longLabel, window, now)}${fetchedAt === undefined ? "" : `\nUpdated ${formatAge(fetchedAt, now)}`}`
    : `${longLabel}: usage not reported yet${fetchedAt === undefined ? "" : `\nUpdated ${formatAge(fetchedAt, now)}`}`;

  if (!window) {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="unreported"
        title={title}
      >
        {shortLabel} · —
      </span>
    );
  }

  const display = meterDisplay(window, fetchedAt ?? 0, now);

  if (display.kind === "reset") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="reset"
        title={title}
      >
        {shortLabel} · reset
      </span>
    );
  }

  if (display.kind === "unknown") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="unknown"
        title={title}
      >
        {shortLabel} · —
      </span>
    );
  }

  const pct = display.pct;
  const fillWidth = `${Math.max(0, Math.min(100, pct))}%`;
  const color = tierColor(pct);
  const countdown = pct > 90 ? formatResetCountdown(window.resetAt, now) : null;
  const elapsedPct = timeElapsedPct(window.resetAt, windowMs, now, window.startedAt);
  // The marker lives INSIDE this wrapper, so the `opacity-50` stale dimming
  // above cascades to it automatically — a stale meter fades the time marker
  // along with its number and fill.
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap${display.stale ? " opacity-50" : ""}`}
      data-meter-pct={Math.round(pct)}
      style={{ color }}
      title={title}
    >
      <span className="relative inline-flex pb-0.5" data-meter-value>
        {shortLabel} {formatPct(pct)}
        <span
          aria-hidden
          data-meter-track
          className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-(--color-text-secondary)/25"
        >
          <span
            aria-hidden
            data-meter-fill
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: fillWidth, backgroundColor: color }}
          />
          {elapsedPct !== null && (
            <span
              aria-hidden
              data-time-marker
              className="absolute -top-[1px] -bottom-[1px] w-0.5 -translate-x-1/2 rounded-full bg-(--color-text-primary)"
              style={{ left: `${elapsedPct}%` }}
            />
          )}
        </span>
      </span>
      {countdown && <span className="ml-1 text-(--color-text-secondary)">resets in {countdown}</span>}
    </span>
  );
}

/**
 * Explanations for the outcomes a refresh can end on without producing new
 * numbers. Shown in the button's tooltip — the whole point is that a press
 * which changes nothing on screen still says why.
 */
const OUTCOME_MESSAGE: Record<LimitsRefreshOutcome, string | null> = {
  updated: null,
  skipped: null,
  locked: "Usage refresh rate-limited by Anthropic",
  "rate-limited": "Usage refresh rate-limited by Anthropic",
  "no-credentials": "This account has no usable sign-in — reconnect it in Settings",
  "expired-token": "This account's sign-in expired — reconnect it in Settings",
  failed: "Couldn't reach Anthropic's usage endpoint",
  unavailable: "Usage refresh isn't available for this account",
};

/**
 * Per-subscription refresh button. Fires one on-demand `/api/oauth/usage` fetch
 * for **this pill's route** via `POST /api/limits/refresh`; the server is
 * single-flight and 429-lockout-guarded, and the numbers return over the
 * `subscription_limits` SSE broadcast. While `lockedUntil` is in the future the
 * button is disabled with a countdown so it can't re-trip the upstream rate
 * limit (docs/161).
 *
 * Sending `routeId` is load-bearing, not tidiness. Without it the server fans
 * the fetch out over every connected account, so with two subscriptions each
 * press spent both accounts' share of a budget that allows only a handful of
 * calls per ~30 min — pressing the pill that showed no numbers was the fastest
 * way to lock out the pill that did.
 *
 * A failed attempt is reported, not swallowed. Every non-success path in the
 * provider is a silent early return, so the previous "swallow, the SSE is the
 * source of truth" left a button that spun and did nothing with no way to tell
 * a rate-limit from a signed-out account.
 *
 * With `autoRefresh` the same fetch also fires once on mount — the mobile
 * status dropdown opens straight into fresh numbers instead of requiring a tap
 * on the glyph. The button stays for an explicit re-fetch (and so a throttled
 * open still has an override), and shows its spinner for either trigger since
 * both go through this component's state.
 */
function LimitsRefreshButton({
  agentId,
  routeId,
  lockedUntil,
  autoRefresh,
}: {
  agentId: AgentId;
  routeId?: string;
  lockedUntil?: number;
  autoRefresh?: boolean;
}) {
  const api = useApi();
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const now = Date.now();
  const locked = lockedUntil !== undefined && lockedUntil > now;
  const lockCountdown = locked
    ? formatResetCountdown(new Date(lockedUntil).toISOString(), now)
    : null;

  const throttleKey = `${agentId}:${routeId ?? "*"}`;

  const refresh = useCallback(async () => {
    lastRefreshAttemptAt.set(throttleKey, Date.now());
    setRefreshing(true);
    try {
      const res = await api.post<{ ok: boolean; results?: LimitsRefreshResult[] }>(
        "/api/limits/refresh",
        routeId ? { agentId, routeId } : { agentId },
      );
      // Report on this pill's own route when the response names it; a fan-out
      // response (no routeId sent) has no single owner, so fall back to the
      // first result rather than attributing another account's failure here.
      const mine = res.results?.find((r) => r.routeId === routeId) ?? res.results?.[0];
      setProblem(mine ? OUTCOME_MESSAGE[mine.outcome] ?? null : null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Usage refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [agentId, api, routeId, throttleKey]);

  // Fire-once-on-mount auto refresh. The ref (not the throttle map) is what
  // makes it once-per-mount: the map only bounds how often *any* mount is
  // allowed to spend a call, and a locked-out route is skipped entirely
  // rather than firing a request the server would no-op.
  const autoFired = useRef(false);
  // eslint-disable-next-line no-restricted-syntax -- mount IS the event here: Radix unmounts PopoverContent on close, so this component mounting is the dropdown opening, and the fetch is an external-system sync with no event-handler equivalent.
  useEffect(() => {
    if (!autoRefresh || autoFired.current) return;
    autoFired.current = true;
    if (locked) return;
    const last = lastRefreshAttemptAt.get(throttleKey) ?? 0;
    if (Date.now() - last < AUTO_REFRESH_MIN_INTERVAL_MS) return;
    void refresh();
  }, [autoRefresh, locked, refresh, throttleKey]);

  // The lockout countdown is the more specific message when both are present:
  // it carries a retry time, and it is broadcast state rather than the result
  // of one press, so it survives a remount.
  const title = locked
    ? `Usage refresh rate-limited — retry in ${lockCountdown}`
    : problem ?? "Refresh usage from Anthropic";

  const failed = !locked && problem !== null;

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={refreshing || locked}
      className={`inline-flex items-center justify-center rounded-full -ml-1 p-1 translate-y-px transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-40 ${
        failed ? "text-(--color-context-high)" : "text-(--color-text-secondary)"
      }`}
      title={title}
      aria-label="Refresh subscription usage"
      data-refresh-problem={problem ?? undefined}
    >
      {refreshing ? (
        <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
      ) : failed ? (
        <WarningCircleIcon size={ICON_SIZE.XS} />
      ) : (
        <ArrowClockwiseIcon size={ICON_SIZE.XS} />
      )}
    </button>
  );
}

/**
 * Tier color for a usage percentage: neutral → mid → high → full at
 * 60 / 75 / 90 percent. Returns a `var(--color-context-*)` string so
 * the same value drives both the meter text and its fill bar; below
 * 60% the meter stays at the neutral `--color-text-secondary` so it
 * reads the same as the provider label.
 */
export function tierColor(pct: number): string {
  if (pct >= 90) return "var(--color-context-full)";
  if (pct >= 75) return "var(--color-context-high)";
  if (pct >= 60) return "var(--color-context-mid)";
  return "var(--color-text-secondary)";
}

/** Format 0–100 → `"96%"`, rounded to whole-number percent. */
export function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

export function formatResetCountdown(iso: string, nowMs = Date.now()): string {
  const resetMs = Date.parse(iso);
  if (Number.isNaN(resetMs)) return iso;
  const diffMs = resetMs - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";

  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (hours === 0) return `${days}d`;
  return `${days}d ${hours}h`;
}

/** Compact "N min ago" / "just now" for a snapshot age. */
export function formatAge(fetchedAt: number, nowMs = Date.now()): string {
  const diffMs = nowMs - fetchedAt;
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatWindowLine(label: string, window: SubscriptionLimitsWindow, now: number): string {
  const resetMs = Date.parse(window.resetAt);
  const elapsed = !Number.isNaN(resetMs) && resetMs <= now;
  if (elapsed) return `${label}: just reset — refresh to update`;
  if (window.usedPct === null) {
    return `${label}: usage not reported — click refresh to fetch (resets ${formatReset(window.resetAt)})`;
  }
  const src = window.source === "usage-api" ? " · from /usage" : "";
  return `${label}: ${formatPct(window.usedPct)} used (resets ${formatReset(window.resetAt)})${src}`;
}

function formatReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
