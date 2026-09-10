import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import { limitsModeKey, subscriptionWindowIsCurrent } from "../../shared/types/usage-limits-types.js";
import { nativeServiceForHarness } from "../../shared/catalogue/index.js";

const AGENT_LIMIT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok Build",
};

// Bound lockouts when the provider gives no reset time.
export const UNKNOWN_RESET_LOCKOUT_MS = 15 * 60 * 1000;

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;
// Accept only explicit UTC; the orchestrator cannot infer the CLI's local zone.
const CLOCK_RESET_UTC = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(?UTC\)?(?![+\-\d])/i;

// Grok's captured "usage balance exhausted" is not verified subscription exhaustion.
// Its TUI limit strings are not headless captures; neither justifies widening these patterns.
const EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /usage limit reached/i,
  /\b(?:5h|five[- ]hour|weekly|monthly|session)\s+usage limit\b/i,
  /you'?ve hit (?:your|[a-z]+'?s) (?:weekly|monthly|session|5h|five[- ]hour) (?:usage )?limit/i,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:quota|credits)/i,
];

// Chat also carries model prose: require a short, anchored provider notice.
const TURN_TEXT_NOTICE_PATTERNS: readonly RegExp[] = [
  /^[^a-z0-9]*(?:claude(?: ai| code)?|codex)?\s*usage limit reached\b/i,
  /^[^a-z0-9]*you'?ve hit (?:your|[a-z]+'?s) (?:weekly|monthly|session|5h|five[- ]hour) (?:usage )?limit\b/i,
];

export const MAX_LIMIT_NOTICE_CHARS = 240;

function resolveResetAt(message: string, now: number): string | null {
  const match = ISO_INSTANT.exec(message);
  const parsed = match ? Date.parse(match[0]) : NaN;
  if (!Number.isNaN(parsed) && parsed > now) return match![0];
  return parseClockResetUtc(message, now);
}

function parseClockResetUtc(message: string, now: number): string | null {
  const match = CLOCK_RESET_UTC.exec(message);
  if (!match) return null;
  const hour12 = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const pm = match[3].toLowerCase() === "pm";
  const hour = pm ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12;
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
  return new Date(at > now ? at : at + 24 * 60 * 60 * 1000).toISOString();
}

export function detectHardExhaustion(
  message: string,
  now: number = Date.now(),
): { resetAt: string | null } | null {
  if (!EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message))) return null;
  return { resetAt: resolveResetAt(message, now) };
}

export function detectHardExhaustionInTurnText(
  text: string | null | undefined,
  now: number = Date.now(),
): { resetAt: string | null } | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LIMIT_NOTICE_CHARS) return null;
  if (!TURN_TEXT_NOTICE_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;
  return { resetAt: resolveResetAt(trimmed, now) };
}

export function exhaustionLockoutUntil(
  detected: { resetAt: string | null },
  now: number = Date.now(),
): number {
  if (detected.resetAt === null) return now + UNKNOWN_RESET_LOCKOUT_MS;
  const parsed = Date.parse(detected.resetAt);
  return Number.isNaN(parsed) ? now + UNKNOWN_RESET_LOCKOUT_MS : parsed;
}

export function normalizeAgentUsageLimitError(
  agentId: AgentId,
  message: string,
  limits: SubscriptionLimitsMap | undefined,
  now: number = Date.now(),
): string {
  if (!/monthly usage limit/i.test(message)) return message;

  const modeKey = limitsModeKey({
    serviceId: nativeServiceForHarness(agentId) ?? agentId,
    billingMode: "sub",
  });
  const providerLimits = Object.values(limits?.[modeKey] ?? {});
  const sessionWindows = providerLimits.map((l) => l.session).filter((w) => w !== null);
  if (sessionWindows.length === 0) return message;
  if (sessionWindows.some((w) => w.usedPct === null || w.usedPct < 100)) return message;
  if (sessionWindows.some((w) => !subscriptionWindowIsCurrent(w, now))) return message;
  const sessionLimit = sessionWindows.reduce((soonest, w) =>
    Date.parse(w.resetAt) < Date.parse(soonest.resetAt) ? w : soonest);
  const resetText = new Date(sessionLimit.resetAt).toISOString();
  const label = AGENT_LIMIT_LABELS[agentId] ?? agentId;
  return `You've hit ${label}'s 5h usage limit. It resets at ${resetText}.`;
}
