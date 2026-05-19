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
 * Header badge group rendering one row per fetchable provider.
 * Each row is `<Label> [5h ▓▓░ NN%] [7d ▓░░ NN%]` — the percentages
 * sit on top of mini pills whose background fill is proportional
 * to the percentage, so urgency is conveyed by both width and color.
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
  const sessionPct = snapshot.session?.usedPct ?? null;
  const weeklyPct = snapshot.weekly?.usedPct ?? null;
  const hasData = sessionPct !== null || weeklyPct !== null;

  // No data ever (or sign-out / never-fetched) → keep the neutral
  // em-dash form. The error reason lives in the tooltip.
  if (snapshot.error && !hasData) {
    return (
      <span
        className="hidden sm:inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-(--color-bg-hover) text-(--color-text-secondary) font-medium tabular-nums"
        title={buildErrorTooltip(label, snapshot)}
      >
        {label} —
      </span>
    );
  }

  // Stale = we have data but the most recent refresh failed. We
  // keep the visual presentation identical (per user request) and
  // surface the staleness in the tooltip only.
  const isStale = !!snapshot.error && hasData;

  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-(--color-text-secondary)"
      title={buildTooltip(label, snapshot)}
      data-stale={isStale ? "true" : undefined}
    >
      <span>{label}</span>
      {sessionPct !== null && <MeterPill shortLabel="5h" pct={sessionPct} />}
      {weeklyPct !== null && <MeterPill shortLabel="7d" pct={weeklyPct} />}
      {!hasData && <span>—</span>}
    </span>
  );
}

interface MeterPillProps {
  shortLabel: string;
  pct: number;
}

/**
 * A single 5h / 7d meter pill: the percentage text sits on top of
 * a background bar that fills `pct%` of the pill's width. The bar
 * carries the urgency signal via both width and color; the text
 * itself stays at `--color-text-primary` so contrast is guaranteed
 * on both dark and light themes (colored text on a lightly-tinted
 * fill collapsed in light themes — see the earlier iteration).
 */
function MeterPill({ shortLabel, pct }: MeterPillProps) {
  const fillWidth = `${Math.max(0, Math.min(100, pct))}%`;
  const tier = tierFor(pct);
  return (
    <span
      className="relative inline-flex items-center rounded-full bg-(--color-bg-hover) px-1.5 py-0.5 overflow-hidden text-(--color-text-primary)"
      data-meter-pct={Math.round(pct)}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 ${tier.fill}`}
        style={{ width: fillWidth }}
      />
      <span className="relative">
        {shortLabel} {formatPct(pct)}
      </span>
    </span>
  );
}

interface Tier {
  fill: string;
}

/**
 * Tier thresholds: neutral → amber → orange → red at 60 / 75 / 90
 * percent. Fill colors use saturated Tailwind palette values at
 * elevated opacity so the bar reads clearly against both the dark
 * `bg-hover` (rgba white 5%) and the light `bg-hover` (rgba black
 * 4%). Text color is decoupled from the tier — see `MeterPill`.
 */
export function tierFor(pct: number): Tier {
  if (pct >= 90) return { fill: "bg-red-500/55" };
  if (pct >= 75) return { fill: "bg-orange-500/55" };
  if (pct >= 60) return { fill: "bg-amber-500/55" };
  return { fill: "bg-(--color-text-secondary)/25" };
}

/** Format 0–100 → `"96%"`, rounded to whole-number percent. */
export function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

function buildTooltip(label: string, snap: SubscriptionLimits): string {
  const lines: string[] = [];
  lines.push(snap.plan ? `${label} — ${snap.plan}` : label);
  if (snap.session) {
    lines.push(`5h window: ${formatPct(snap.session.usedPct)} used (resets ${formatReset(snap.session.resetAt)})`);
  }
  if (snap.weekly) {
    lines.push(`Weekly: ${formatPct(snap.weekly.usedPct)} used (resets ${formatReset(snap.weekly.resetAt)})`);
  }
  if (snap.weeklyOpus) {
    lines.push(`Weekly Opus: ${formatPct(snap.weeklyOpus.usedPct)} used (resets ${formatReset(snap.weeklyOpus.resetAt)})`);
  }
  if (snap.error && (snap.session || snap.weekly || snap.weeklyOpus)) {
    lines.push(`Last refresh failed (${snap.error}) — showing data from ${formatRelative(snap.fetchedAt)}.`);
  }
  return lines.join("\n");
}

function formatRelative(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function buildErrorTooltip(label: string, snap: SubscriptionLimits): string {
  const reason = snap.error ?? "limits unavailable";
  return `${label}: ${reason}`;
}

function formatReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
