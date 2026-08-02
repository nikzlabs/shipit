import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import { listSubscriptionLimits } from "../../shared/types/usage-limits-types.js";

/**
 * Rate-limit + subscription-snapshot handling, extracted from
 * `agent-listeners.ts` (Phase P6 split, docs/201): account-wide rate-limit
 * telemetry routing (docs/135) and reclassification of a generic upstream
 * "monthly usage limit" error against ShipIt's own exhausted-window snapshot.
 * No behavior change.
 */

const AGENT_LIMIT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * docs/150 req 7 — how long an account stays out of the running when the
 * provider says "you are out of quota" but does not say when that ends.
 *
 * Neither extreme works. Not stamping at all means the very next turn walks
 * into the same wall, which is the failure this detection exists to prevent.
 * Stamping indefinitely would strand a healthy subscription on one bad parse.
 * A short, self-expiring lockout gets the next turn onto another account while
 * making a false positive cost minutes, not a day — and the live quota
 * telemetry (which usually arrives with a real `resetAt`) supersedes it as soon
 * as it lands, because `exhaustedUntil` takes the *soonest* of the two signals.
 */
export const UNKNOWN_RESET_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * ISO-8601 instant embedded in a provider error ("… It resets at
 * 2026-08-01T14:30:00.000Z."). Both providers' normalized usage-limit text
 * carries one; free-form upstream text usually does not, which is what
 * {@link UNKNOWN_RESET_LOCKOUT_MS} covers.
 */
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;

/**
 * Phrases that mean *this subscription is spent*, as opposed to the many other
 * things a turn can die of.
 *
 * Deliberately narrow. A false positive benches a working subscription, so this
 * matches explicit quota language only — never a bare "429" or "rate limit",
 * which upstream also uses for short-term throttling that a retry fixes and
 * which says nothing about the subscription window.
 */
const EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /usage limit reached/i,
  /\b(?:5h|five[- ]hour|weekly|monthly|session)\s+usage limit\b/i,
  /you'?ve hit (?:your|[a-z]+'?s) (?:weekly|monthly|5h|five[- ]hour) limit/i,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:quota|credits)/i,
];

/**
 * docs/150 req 7 — does this turn error mean the account that ran it is out of
 * quota, and if so, until when?
 *
 * Returns `null` when the error is anything else, so the caller leaves the
 * account alone. `resetAt` is the instant the provider named, or `null` when it
 * named none.
 */
export function detectHardExhaustion(message: string): { resetAt: string | null } | null {
  if (!EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message))) return null;
  const match = ISO_INSTANT.exec(message);
  const parsed = match ? Date.parse(match[0]) : NaN;
  // A reset already in the past describes the window that just ended, not the
  // one blocking this turn — treat it as "unknown" rather than as an
  // already-expired stamp that would block nothing.
  return { resetAt: !Number.isNaN(parsed) && parsed > Date.now() ? match![0] : null };
}

/**
 * The epoch-ms stamp to persist for a detected exhaustion — the provider's own
 * reset instant when it gave one, else a short self-expiring lockout.
 */
export function exhaustionLockoutUntil(
  detected: { resetAt: string | null },
  now: number = Date.now(),
): number {
  if (detected.resetAt === null) return now + UNKNOWN_RESET_LOCKOUT_MS;
  const parsed = Date.parse(detected.resetAt);
  return Number.isNaN(parsed) ? now + UNKNOWN_RESET_LOCKOUT_MS : parsed;
}

/**
 * Upstream agent CLIs can report the generic "org monthly usage limit" even
 * when ShipIt's subscription badge has a fresh exhausted 5h-window snapshot.
 * Correct only that known mismatch; without an exhausted session window, keep
 * the upstream text intact.
 */
export function normalizeAgentUsageLimitError(
  agentId: AgentId,
  message: string,
  limits: SubscriptionLimitsMap | undefined,
): string {
  if (!/monthly usage limit/i.test(message)) return message;

  // docs/150 — quota is per account now, so "is the 5h window exhausted?" is
  // only true if *every* connected account for this provider is exhausted.
  // Reclassifying on the first exhausted account would tell a user with a
  // healthy second subscription that they are out of quota.
  const providerLimits = listSubscriptionLimits(limits ?? {}).filter((l) => l.agentId === agentId);
  const sessionWindows = providerLimits.map((l) => l.session).filter((w) => w !== null);
  if (sessionWindows.length === 0) return message;
  if (sessionWindows.some((w) => w.usedPct === null || w.usedPct < 100)) return message;
  // Report the window that frees up first.
  const sessionLimit = sessionWindows.reduce((soonest, w) =>
    Date.parse(w.resetAt) < Date.parse(soonest.resetAt) ? w : soonest);
  const reset = new Date(sessionLimit.resetAt);
  const resetText = Number.isNaN(reset.getTime())
    ? sessionLimit.resetAt
    : reset.toISOString();
  const label = AGENT_LIMIT_LABELS[agentId] ?? agentId;
  return `You've hit ${label}'s 5h usage limit. It resets at ${resetText}.`;
}
