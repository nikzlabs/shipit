import { ArrowClockwiseIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import { useApi } from "../hooks/useApi.js";
import type {
  AgentId,
  SubscriptionLimits,
  SubscriptionLimitsMap,
  SubscriptionLimitsWindow,
} from "../../server/shared/types.js";

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

interface SubscriptionLimitsBadgeProps {
  limits: SubscriptionLimitsMap;
}

/**
 * Header badge group rendering one **pill per fetchable provider** plus a
 * single account-global refresh button (Claude only — it's the one with an
 * on-demand `/api/oauth/usage` path). See docs/161 and
 * docs/135-subscription-limits-badge/plan.md.
 */
export function SubscriptionLimitsBadge({ limits }: SubscriptionLimitsBadgeProps) {
  const pills: { agentId: AgentId; snapshot: SubscriptionLimits }[] = [];
  for (const id of PILL_ORDER) {
    const snap = limits[id];
    if (snap) pills.push({ agentId: id, snapshot: snap });
  }
  if (pills.length === 0) return null;

  return (
    <>
      {pills.map(({ agentId, snapshot }) => (
        <SubscriptionLimitPill
          key={agentId}
          label={AGENT_LABEL[agentId]}
          snapshot={snapshot}
          // eslint-disable-next-line no-restricted-syntax -- Claude is the only agent with an on-demand /api/oauth/usage refresh endpoint
          showRefresh={agentId === "claude"}
        />
      ))}
    </>
  );
}

interface SubscriptionLimitPillProps {
  label: string;
  snapshot: SubscriptionLimits;
  showRefresh?: boolean;
}

export function SubscriptionLimitPill({ label, snapshot, showRefresh }: SubscriptionLimitPillProps) {
  const now = Date.now();
  const hasData = snapshot.session !== null || snapshot.weekly !== null;

  return (
    <span
      className={`inline-flex items-center gap-2 text-xs pl-2 ${showRefresh ? "pr-1" : "pr-2"} pb-0.5 rounded-full bg-(--color-bg-hover) font-medium tabular-nums text-(--color-text-secondary)`}
      title={buildTooltip(label, snapshot, now)}
    >
      <span>{label}</span>
      {snapshot.session && (
        <Meter shortLabel="5h" window={snapshot.session} fetchedAt={snapshot.fetchedAt} now={now} />
      )}
      {snapshot.weekly && (
        <Meter shortLabel="7d" window={snapshot.weekly} fetchedAt={snapshot.fetchedAt} now={now} />
      )}
      {!hasData && <span>—</span>}
      {showRefresh && <LimitsRefreshButton snapshot={snapshot} />}
    </span>
  );
}

interface MeterProps {
  shortLabel: string;
  window: SubscriptionLimitsWindow;
  fetchedAt: number;
  now: number;
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
function Meter({ shortLabel, window, fetchedAt, now }: MeterProps) {
  const display = meterDisplay(window, fetchedAt, now);

  if (display.kind === "reset") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="reset"
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
      >
        {shortLabel} · —
      </span>
    );
  }

  const pct = display.pct;
  const fillWidth = `${Math.max(0, Math.min(100, pct))}%`;
  const color = tierColor(pct);
  const countdown = pct > 90 ? formatResetCountdown(window.resetAt, now) : null;
  return (
    <span
      className={`relative inline-flex items-center whitespace-nowrap pb-0.5${display.stale ? " opacity-50" : ""}`}
      data-meter-pct={Math.round(pct)}
      style={{ color }}
    >
      {shortLabel} {formatPct(pct)}
      {countdown && <span className="ml-1 text-(--color-text-secondary)">resets in {countdown}</span>}
      <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-(--color-text-secondary)/25">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: fillWidth, backgroundColor: color }}
        />
      </span>
    </span>
  );
}

/**
 * Account-global refresh button. Fires a single on-demand `/api/oauth/usage`
 * fetch (Claude) via `POST /api/limits/refresh`; the server is single-flight
 * and 429-lockout-guarded, and the result returns over the `subscription_limits`
 * SSE broadcast. While `lockedUntil` is in the future the button is disabled
 * with a countdown so it can't re-trip the upstream rate limit (docs/161).
 */
function LimitsRefreshButton({ snapshot }: { snapshot: SubscriptionLimits }) {
  const api = useApi();
  const [refreshing, setRefreshing] = useState(false);
  const now = Date.now();
  const locked = snapshot.lockedUntil !== undefined && snapshot.lockedUntil > now;
  const lockCountdown = locked
    ? formatResetCountdown(new Date(snapshot.lockedUntil!).toISOString(), now)
    : null;

  const onClick = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.post("/api/limits/refresh", { agentId: snapshot.agentId });
    } catch {
      // Swallow — the SSE broadcast (or its absence) is the source of truth;
      // a failed refresh just leaves the last-known numbers in place.
    } finally {
      setRefreshing(false);
    }
  }, [api, snapshot.agentId]);

  const title = locked
    ? `Usage refresh rate-limited — retry in ${lockCountdown}`
    : "Refresh usage from Anthropic";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={refreshing || locked}
      className="inline-flex items-center justify-center rounded-full -ml-1 p-1 translate-y-px text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-40"
      title={title}
      aria-label="Refresh subscription usage"
    >
      {refreshing ? (
        <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
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

function buildTooltip(label: string, snap: SubscriptionLimits, now: number): string {
  const lines: string[] = [];
  lines.push(snap.plan ? `${label} — ${snap.plan}` : label);
  if (snap.session) lines.push(formatWindowLine("5h window", snap.session, now));
  if (snap.weekly) lines.push(formatWindowLine("Weekly", snap.weekly, now));
  lines.push(`Updated ${formatAge(snap.fetchedAt, now)}`);
  if (snap.lockedUntil !== undefined && snap.lockedUntil > now) {
    lines.push(
      `Usage refresh rate-limited — retry in ${formatResetCountdown(
        new Date(snap.lockedUntil).toISOString(),
        now,
      )}`,
    );
  }
  return lines.join("\n");
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
