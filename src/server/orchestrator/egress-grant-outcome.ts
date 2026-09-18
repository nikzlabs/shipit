import type { EgressGrantSurface, EgressHostGrantOutcome, EgressHostReach } from "../shared/types.js";

const ALL_SURFACES: EgressGrantSurface[] = ["new-containers", "agent", "services"];
const SNAPSHOT_SURFACES: EgressGrantSurface[] = ["agent", "services"];

export interface EgressGrantContext {
  host: string;
  scope: "session" | "global";
  /** Actual reload result; global additions reload nothing. */
  reloaded: boolean;
  sessionId: string | null;
  enforcementActive: boolean;
  /** Live container's creation-time policy; null when none is running. */
  startedContained: boolean | null;
  reach: EgressHostReach;
}

export function computeEgressGrantOutcome(ctx: EgressGrantContext): EgressHostGrantOutcome {
  const base = { host: ctx.host, scope: ctx.scope, reach: ctx.reach };
  const live = (): EgressHostGrantOutcome => ({
    ...base,
    liveNow: [...ALL_SURFACES],
    staleUntilRestart: [],
    restartSessionId: null,
  });
  const nextStart = (): EgressHostGrantOutcome => ({
    ...base,
    liveNow: ["new-containers"],
    staleUntilRestart: [],
    restartSessionId: null,
  });
  const stale = (restartSessionId: string | null): EgressHostGrantOutcome => ({
    ...base,
    liveNow: ["new-containers"],
    staleUntilRestart: [...SNAPSHOT_SURFACES],
    restartSessionId,
  });

  if (ctx.reach === "blocked-by-session" || ctx.reach === "blocked-by-deployment") {
    return { ...base, liveNow: [], staleUntilRestart: [], restartSessionId: null };
  }

  if (!ctx.enforcementActive) return live();

  if (ctx.sessionId) {
    if (ctx.startedContained === null) return nextStart();
    if (!ctx.startedContained) return live();
    return ctx.reloaded ? live() : stale(ctx.sessionId);
  }

  return stale(null);
}
