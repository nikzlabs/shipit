import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap } from "../../server/shared/types.js";

/**
 * Stable ordering of pills in the header. Matches the provider
 * registration order in `app-di.ts` / `index.ts` so muscle memory
 * works — Claude first, Codex second.
 */
const PILL_ORDER: AgentId[] = ["claude", "codex"];

/**
 * Display labels for each agent. The pill format is
 * `"<Label> 5h <session>% · 7d <weekly>%"` so two side-by-side pills
 * are distinguishable even without provider-brand iconography (see
 * "Open question 4" in doc 135).
 */
const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

interface SubscriptionLimitsBadgeProps {
  limits: SubscriptionLimitsMap;
}

/**
 * Header badge group rendering one pill per fetchable provider.
 * Iterates a fixed ordering so the layout is stable across reloads
 * and across users. Empty map → empty group → header collapses to
 * its previous shape (no spacing artifacts).
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

/**
 * A single provider's pill. Renders either the numeric breakdown
 * (`"<Label> 5h 96% · 7d 22%"`) or, on failure, a neutral
 * `"<Label> —"` with the error string in the tooltip.
 *
 * Color is driven by the weekly value when it's non-trivial (≥10%),
 * otherwise by the session value. Rationale (doc 135): a 100%/20%
 * state is *not* a red situation — the 5h window resets in minutes,
 * the weekly is what actually matters for "can I keep working today?"
 */
export function SubscriptionLimitPill({ label, snapshot }: SubscriptionLimitPillProps) {
  if (snapshot.error) {
    return (
      <span
        className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-(--color-bg-hover) text-(--color-text-secondary) font-medium tabular-nums"
        title={buildErrorTooltip(label, snapshot)}
      >
        {label} —
      </span>
    );
  }

  const sessionPct = snapshot.session?.usedPct ?? null;
  const weeklyPct = snapshot.weekly?.usedPct ?? null;

  // Color-driving value: weekly when it's high enough to matter,
  // otherwise session. See doc 135's rationale.
  const colorPct =
    weeklyPct !== null && weeklyPct >= 10 ? weeklyPct : sessionPct ?? weeklyPct ?? 0;
  const colorClass = colorClassFor(colorPct);

  const pieces: string[] = [label];
  if (sessionPct !== null) pieces.push(`5h ${formatPct(sessionPct)}`);
  if (weeklyPct !== null) {
    // Use `·` separator only when both numbers are present.
    pieces.push(sessionPct !== null ? `· 7d ${formatPct(weeklyPct)}` : `7d ${formatPct(weeklyPct)}`);
  }
  // Fallback: if neither number is present (parser produced an empty
  // snapshot somehow), show a placeholder rather than just the label.
  if (sessionPct === null && weeklyPct === null) pieces.push("—");

  const text = pieces.join(" ");

  return (
    <span
      className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-(--color-bg-hover) ${colorClass} font-medium tabular-nums`}
      title={buildTooltip(label, snapshot)}
    >
      {text}
    </span>
  );
}

/**
 * Tier color thresholds match `DockerMemoryBadge`: green/secondary →
 * yellow → orange → red. Exported for unit tests.
 */
export function colorClassFor(pct: number): string {
  if (pct >= 90) return "text-red-400";
  if (pct >= 75) return "text-orange-400";
  if (pct >= 60) return "text-yellow-400";
  return "text-(--color-text-secondary)";
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
  return lines.join("\n");
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
