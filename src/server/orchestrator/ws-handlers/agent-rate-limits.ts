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
