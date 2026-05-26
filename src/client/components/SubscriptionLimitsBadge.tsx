import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap } from "../../server/shared/types.js";

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

interface SubscriptionLimitsBadgeProps {
  limits: SubscriptionLimitsMap;
}

/**
 * Header badge group rendering one **pill per fetchable provider**,
 * matching the chrome of `UptimeBadge` / `DockerMemoryBadge` (a single
 * `rounded-full bg-(--color-bg-hover)` pill). Inside each pill: the
 * provider label followed by up to two meters — `5h NN%` and `7d NN%`.
 * Each meter is a tier-colored number with a thin underline gauge whose
 * fill width is proportional to the percentage, so urgency reads from
 * both color and width without nesting pills inside the pill.
 *
 * See docs/135-subscription-limits-badge/plan.md.
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
        />
      ))}
    </>
  );
}

interface SubscriptionLimitPillProps {
  label: string;
  snapshot: SubscriptionLimits;
}

export function SubscriptionLimitPill({ label, snapshot }: SubscriptionLimitPillProps) {
  const hasData = snapshot.session !== null || snapshot.weekly !== null;

  return (
    <span
      className="inline-flex items-center gap-2 text-xs px-2 py-0.5 rounded-full bg-(--color-bg-hover) font-medium tabular-nums text-(--color-text-secondary)"
      title={buildTooltip(label, snapshot)}
    >
      <span>{label}</span>
      {snapshot.session && <Meter shortLabel="5h" pct={snapshot.session.usedPct} resetAt={snapshot.session.resetAt} />}
      {snapshot.weekly && <Meter shortLabel="7d" pct={snapshot.weekly.usedPct} resetAt={snapshot.weekly.resetAt} />}
      {!hasData && <span>—</span>}
    </span>
  );
}

interface MeterProps {
  shortLabel: string;
  pct: number | null;
  resetAt: string;
}

/**
 * A single 5h / 7d meter: tier-colored `"5h NN%"` text with a thin
 * underline gauge beneath it. The gauge's fill bar grows to `pct%` of
 * the meter's width and carries the same tier color as the text, so
 * urgency reads from both width and color. Unlike the earlier
 * full-height fill chip, the bar is a 2px underline — that keeps each
 * provider as a single pill (matching `UptimeBadge` / `DockerMemoryBadge`)
 * instead of nesting pills inside the pill. The tier colors come from
 * the per-theme `--color-context-*` tokens (shared with `ContextDial`),
 * which are tuned for contrast on both dark and light themes.
 *
 * When `pct` is `null` (Claude reported the window's existence and reset
 * time but not utilization — see anthropics/claude-code#50518) the meter
 * degrades to a countdown-only "5h · resets in 4h 12m" with no fill bar,
 * staying at the neutral secondary color. It re-upgrades to the full
 * percentage meter the moment a later event carries a number.
 */
function Meter({ shortLabel, pct, resetAt }: MeterProps) {
  // Once `resetAt` has elapsed the window has rolled over — the cached
  // pct is no longer meaningful (badge updates on the next agent turn's
  // rate_limit_event, so otherwise the pill would sit at "5h 100% resets
  // in now" until the next turn lands).
  const displayPct = effectivePct(pct, resetAt);

  if (displayPct === null) {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap text-(--color-text-secondary)"
        data-meter-pct="unknown"
      >
        {shortLabel} · resets in {formatResetCountdown(resetAt)}
      </span>
    );
  }

  const fillWidth = `${Math.max(0, Math.min(100, displayPct))}%`;
  const color = tierColor(displayPct);
  const countdown = displayPct > 90 ? formatResetCountdown(resetAt) : null;
  return (
    <span
      className="relative inline-flex items-center whitespace-nowrap pb-0.75"
      data-meter-pct={Math.round(displayPct)}
      style={{ color }}
    >
      {shortLabel} {formatPct(displayPct)}
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
 * Returns 0 when `resetAt` is a valid timestamp that has already
 * elapsed (the window has rolled over since the last poll), otherwise
 * returns the cached `pct` unchanged. Unparseable `resetAt` values
 * preserve the cached value so a bad payload doesn't silently zero out
 * the meter. A `null` input stays `null` — the provider hasn't reported
 * utilization yet and we don't fake a number to fill the gap.
 */
export function effectivePct(
  pct: number | null,
  resetAt: string,
  nowMs = Date.now(),
): number | null {
  if (pct === null) return null;
  const resetMs = Date.parse(resetAt);
  if (!Number.isNaN(resetMs) && resetMs <= nowMs) return 0;
  return pct;
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

function buildTooltip(label: string, snap: SubscriptionLimits): string {
  const lines: string[] = [];
  lines.push(snap.plan ? `${label} — ${snap.plan}` : label);
  if (snap.session) {
    lines.push(formatWindowLine("5h window", snap.session));
  }
  if (snap.weekly) {
    lines.push(formatWindowLine("Weekly", snap.weekly));
  }
  return lines.join("\n");
}

function formatWindowLine(
  label: string,
  window: { usedPct: number | null; resetAt: string },
): string {
  if (window.usedPct === null) {
    return `${label}: resets ${formatReset(window.resetAt)} (utilization not reported)`;
  }
  return `${label}: ${formatPct(window.usedPct)} used (resets ${formatReset(window.resetAt)})`;
}

function formatReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
