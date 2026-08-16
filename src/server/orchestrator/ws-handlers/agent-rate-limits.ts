import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import { limitsModeKey, subscriptionWindowIsCurrent } from "../../shared/types/usage-limits-types.js";
import { nativeServiceForHarness } from "../../shared/catalogue/index.js";

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
  opencode: "OpenCode",
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
 * Wall-clock reset the Claude CLI prints in its own limit notice ("… · resets
 * 5:10pm (UTC)"). Only accepted when the text names UTC explicitly: without a
 * zone the hour is meaningless to the orchestrator, and guessing one would
 * produce a lockout that is hours wrong in either direction.
 */
const CLOCK_RESET_UTC = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(?UTC\)?(?![+\-\d])/i;

/**
 * Phrases that mean *this subscription is spent*, as opposed to the many other
 * things a turn can die of.
 *
 * Deliberately narrow. A false positive benches a working subscription, so this
 * matches explicit quota language only — never a bare "429" or "rate limit",
 * which upstream also uses for short-term throttling that a retry fixes and
 * which says nothing about the subscription window.
 *
 * The window alternation tracks the CLI's own wording and has to be widened
 * when that wording moves: production missed a real exhaustion because the CLI
 * had started saying "You've hit your session limit" while this list still knew
 * only weekly/monthly/5h *usage* limits. `usage` is optional for the same
 * reason — "session limit" and "session usage limit" are the same event.
 */
const EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /usage limit reached/i,
  /\b(?:5h|five[- ]hour|weekly|monthly|session)\s+usage limit\b/i,
  /you'?ve hit (?:your|[a-z]+'?s) (?:weekly|monthly|session|5h|five[- ]hour) (?:usage )?limit/i,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:quota|credits)/i,
];

/**
 * The provider's own limit notice, as it appears when the CLI writes it into
 * the conversation instead of failing the turn. Separate from
 * {@link EXHAUSTION_PATTERNS} and much stricter, because the text channel
 * carries the *model's* words as well as the provider's:
 *
 *   - **Anchored.** The notice IS the message. Requiring it at the start is
 *     what tells "You've hit your session limit · resets 5:10pm (UTC)" apart
 *     from "The Vercel deploy failed because your account is out of credits" —
 *     an ordinary 85-character turn summary that the generic patterns match
 *     and that must not bench a Claude subscription.
 *   - **No generic quota phrasings.** `quota exceeded` / `out of credits` are
 *     how an *API* reports a spent balance; they reach us as errors, never as
 *     something a CLI writes into the chat. Admitting them here buys no real
 *     coverage and costs exactly the false positive above.
 *
 * The leading `[^a-z0-9]*` allows decoration (a bullet, an emoji) but not
 * words, so nothing can precede the notice and still match.
 */
const TURN_TEXT_NOTICE_PATTERNS: readonly RegExp[] = [
  /^[^a-z0-9]*(?:claude(?: ai| code)?|codex)?\s*usage limit reached\b/i,
  /^[^a-z0-9]*you'?ve hit (?:your|[a-z]+'?s) (?:weekly|monthly|session|5h|five[- ]hour) (?:usage )?limit\b/i,
];

/**
 * A limit notice is one short line. Anything longer is the agent *talking
 * about* quota — including, inevitably, an agent working on this very file —
 * and must not bench the account it is running on. A second belt behind the
 * anchoring above; see {@link detectHardExhaustionInTurnText}.
 */
export const MAX_LIMIT_NOTICE_CHARS = 240;

/**
 * Resolve the CLI's wall-clock reset ("5:10pm (UTC)") to the next instant that
 * clock time occurs. The notice never carries a date, so "already past today"
 * means tomorrow.
 */
/**
 * The instant the provider named, in whichever form it named it, or `null` when
 * it named none usable (which {@link exhaustionLockoutUntil} turns into the
 * short self-expiring lockout).
 */
function resolveResetAt(message: string, now: number): string | null {
  const match = ISO_INSTANT.exec(message);
  const parsed = match ? Date.parse(match[0]) : NaN;
  // A reset already in the past describes the window that just ended, not the
  // one blocking this turn — treat it as "unknown" rather than as an
  // already-expired stamp that would block nothing.
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

/**
 * docs/150 req 7 — does this turn error mean the account that ran it is out of
 * quota, and if so, until when?
 *
 * Returns `null` when the error is anything else, so the caller leaves the
 * account alone. `resetAt` is the instant the provider named, or `null` when it
 * named none.
 */
export function detectHardExhaustion(
  message: string,
  now: number = Date.now(),
): { resetAt: string | null } | null {
  if (!EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message))) return null;
  return { resetAt: resolveResetAt(message, now) };
}

/**
 * The same question as {@link detectHardExhaustion}, asked of a turn's FINAL
 * ASSISTANT TEXT instead of its error.
 *
 * This channel exists because the error channel is not the only one the
 * provider uses. Production lost a failover when the Claude CLI reported
 * "You've hit your session limit · resets 5:10pm (UTC)" as an ordinary
 * assistant message and then ended the turn `subtype: "success"`: the adapter
 * populates `agent_result.error` only for a failed turn
 * (`session/agents/claude/adapter.ts`), so every detector — the req-7 stamp,
 * the req-14 quota retry, the sub-agent fallback — was gated on a field that
 * was structurally `undefined`. The turn retired as a success and the limit
 * notice became the auto-commit subject. Matching the wording alone would have
 * fixed that one incident and left the next wording change to re-break it.
 *
 * The cost of asymmetry is that this channel carries the agent's own prose,
 * where a phrase match is no longer proof: a false positive benches a healthy
 * account AND repeats the turn's side effects (docs/150 req 14 accepts that on
 * a real failover, not on a misread). So it does NOT reuse the error channel's
 * patterns — it matches only the provider's own notice, anchored at the start
 * of a message short enough to be one ({@link TURN_TEXT_NOTICE_PATTERNS},
 * {@link MAX_LIMIT_NOTICE_CHARS}).
 *
 * Known gap, deliberate: for Codex the CLI can emit `agent_result` *before* the
 * final assistant text streams in (see `SessionRunner.pendingCommitLink`), so
 * the summary may not be populated when a detector asks. That costs nothing
 * relative to today — Codex reports a spent subscription by failing the turn,
 * which the error channel already covers — and closing it would mean carrying
 * the text on the terminal event itself, which is a bigger change than the
 * incident warrants.
 */
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
  now: number = Date.now(),
): string {
  if (!/monthly usage limit/i.test(message)) return message;

  // docs/150 — quota is per account now, so "is the 5h window exhausted?" is
  // only true if *every* connected account for this provider is exhausted.
  // Reclassifying on the first exhausted account would tell a user with a
  // healthy second subscription that they are out of quota.
  //
  // docs/252 req 10 — and it is per `(service, billing mode)`, so the group is
  // this harness's own vendor SUBSCRIPTION: the only thing that reports a
  // quota, and the only thing the message's "5h usage limit" wording describes.
  // A turn redirected to another service has no window here and falls through
  // with the upstream text intact, which is the honest outcome.
  const modeKey = limitsModeKey({
    serviceId: nativeServiceForHarness(agentId) ?? agentId,
    billingMode: "sub",
  });
  const providerLimits = Object.values(limits?.[modeKey] ?? {});
  const sessionWindows = providerLimits.map((l) => l.session).filter((w) => w !== null);
  if (sessionWindows.length === 0) return message;
  // docs/260 req 8 — and only on windows that still describe now. A rolled-over
  // or timestamp-less 100% reading would rewrite a real monthly-limit refusal
  // into a 5h one and quote a reset instant that has already passed, which is
  // the opposite of req 6's "report what the provider said".
  if (sessionWindows.some((w) => w.usedPct === null || w.usedPct < 100)) return message;
  if (sessionWindows.some((w) => !subscriptionWindowIsCurrent(w, now))) return message;
  // Report the window that frees up first. Every window is current here, so
  // each `resetAt` parses.
  const sessionLimit = sessionWindows.reduce((soonest, w) =>
    Date.parse(w.resetAt) < Date.parse(soonest.resetAt) ? w : soonest);
  const resetText = new Date(sessionLimit.resetAt).toISOString();
  const label = AGENT_LIMIT_LABELS[agentId] ?? agentId;
  return `You've hit ${label}'s 5h usage limit. It resets at ${resetText}.`;
}
