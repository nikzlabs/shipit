import type { EgressHostGrantOutcome, EgressHostReach } from "../../server/shared/types.js";

/**
 * planning#376 — the one wording for "you allowed a host; here is what took
 * effect", shared by the two surfaces that grant one (the Plugins card's host
 * row and Settings → Network egress).
 *
 * It renders the server's answer and derives nothing of its own: which surfaces
 * are live is read out of `liveNow` / `staleUntilRestart`, never re-inferred
 * from the scope. The scope only picks the words for "for this session" vs "for
 * every session" — the two behave differently, which is the whole complaint the
 * issue records, so the difference has to be reported rather than guessed.
 *
 * Backticks are markup: both callers render the result through `RichErrorText`,
 * the same renderer the Plugins card already uses for host and plugin names.
 */

export type EgressGrantKind =
  /** Every surface has it; nothing is waiting on a restart. */
  | "live-everywhere"
  /** Only containers started from now on have it, and nothing running is stale. */
  | "next-start"
  /** Fresh containers have it; something already running does not, until it restarts. */
  | "partly-live"
  /** Saved, but nothing here can act on it — a restart won't help (`blocked-*`). */
  | "excluded";

/**
 * planning#383 — why a host cannot be granted, in the words the user needs, for
 * the surface that must say it INSTEAD of offering a button.
 *
 * Shared with {@link summarizeEgressGrant} so the Plugins card's buttonless row
 * and the after-the-click report say the same thing about the same state. Only
 * the two `blocked-*` verdicts have an answer here; the others are not a reason
 * anything failed, so asking for one is a caller bug and reads as `null`.
 */
export function egressBlockedReason(reach: EgressHostReach): { headline: string; detail: string } | null {
  if (reach === "blocked-by-deployment") {
    return {
      headline: "This ShipIt can't allow extra hosts.",
      detail:
        "Its network control is set to the built-in floor only, so an allowlist entry has nothing to act on — the same in every session. Whoever runs this ShipIt has to turn DNS-based egress control on.",
    };
  }
  if (reach === "blocked-by-session") {
    return {
      headline: "This session can't reach it whatever the allowlist says.",
      detail:
        "Its network access is off, so it is limited to ShipIt and the model API. Turn network access on for the session to use the host here.",
    };
  }
  return null;
}

export interface EgressGrantSummary {
  kind: EgressGrantKind;
  /** What happened, naming the scope it happened at. */
  headline: string;
  /** What is live now and what waits — the answer the tooltip used to guess. */
  detail: string;
  /** Session whose container restart would bring the rest in step; null = offer none. */
  restartSessionId: string | null;
}

/**
 * The clause both global outcomes open with. A plugin's companion CLI and its
 * install run in a container created per invocation, so they read the live
 * config — the one surface that is *ahead* of the agent rather than behind it
 * (`plugin-egress.ts`), and the reason "a running service may need a restart"
 * was never the whole answer.
 */
const FRESH_CONTAINERS =
  "Anything started from now on has it — including a plugin's own command or install, which runs in a container created per invocation.";

export function summarizeEgressGrant(outcome: EgressHostGrantOutcome): EgressGrantSummary {
  const host = `\`${outcome.host}\``;
  const stale = outcome.staleUntilRestart;
  const forScope =
    outcome.scope === "session"
      ? `${host} is allowed for this session.`
      : `${host} is allowed for every session on this ShipIt.`;

  // The entry saved and still reaches nothing here — this session carries no
  // user hosts (a sandbox with network access off), or this deployment installs
  // nothing that could act on the entry at all. Saying "allowed" would be the
  // flattest wrong claim of the set.
  const blocked = egressBlockedReason(outcome.reach);
  if (blocked) {
    return {
      kind: "excluded",
      headline:
        outcome.scope === "session"
          ? `${host} was added to this session's allowlist.`
          : `${host} was added for every session on this ShipIt.`,
      detail: `${blocked.headline} ${blocked.detail}`,
      restartSessionId: null,
    };
  }

  if (stale.length === 0 && outcome.liveNow.includes("agent")) {
    return {
      kind: "live-everywhere",
      headline: forScope,
      detail:
        outcome.scope === "session"
          ? "It is live now — the agent, any running service, and anything started from now on all have it. No restart needed."
          : "Egress containment is not in effect here, so nothing was blocking it.",
      restartSessionId: null,
    };
  }

  if (stale.length === 0) {
    return {
      kind: "next-start",
      headline: forScope,
      detail: `${FRESH_CONTAINERS} Nothing running here is holding an older allowlist.`,
      restartSessionId: null,
    };
  }

  return {
    kind: "partly-live",
    headline: forScope,
    detail: `${FRESH_CONTAINERS} ${
      outcome.restartSessionId
        ? "This session's agent and any running service keep the old allowlist until they restart."
        : "Sessions already running keep the old allowlist until their containers restart."
    }`,
    restartSessionId: outcome.restartSessionId,
  };
}
