import type { EgressHostGrantOutcome } from "../../server/shared/types.js";

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
  /** Saved, but this session's own network policy excludes it — a restart won't help. */
  | "excluded";

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

  // The entry saved, and this session still cannot reach the host: its own
  // network policy carries no user hosts (a sandbox with network access off).
  // Saying "allowed" here would be the flattest wrong claim of the set.
  if (outcome.excludedBySessionPolicy) {
    return {
      kind: "excluded",
      headline:
        outcome.scope === "session"
          ? `${host} was added to this session's allowlist.`
          : `${host} was added for every session on this ShipIt.`,
      detail:
        "This session still can't reach it: its network access is off, so it is limited to ShipIt and the model API whatever the allowlist says. Turn network access on for the session to use the host here.",
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
