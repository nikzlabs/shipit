/**
 * planning#376 — what an egress allowlist ADD took effect on, computed once so
 * the route can report it instead of the browser predicting it.
 *
 * The two scopes diverge, deliberately and permanently (`plugin-egress.ts`'s
 * docstring argues why, and this module changes nothing about it):
 *
 *  - A **session** add calls `reloadEgress`, which relaunches the agent's Tier B
 *    resolver and Tier C proxy AND re-contains every running Compose service
 *    (`session-container.ts`). Nothing has to restart.
 *  - A **global** add reloads nothing. The durable entry is saved and that is
 *    all — so a container created from now on (a fresh session, and notably a
 *    plugin's per-invocation CLI/install container) is allowed at once, while
 *    the agent container and every running service keep the allowlist they
 *    started with.
 *
 * Everything else here is the *honest* qualification of that, and each branch
 * exists because the obvious shortcut states something false somewhere:
 *
 *  - **Scope is not the reload.** `reloadEgress` returns whether it actually
 *    reloaded, and declines on several real configurations. Reading "session
 *    scope" as "it reloaded" is the same confident-but-wrong claim the issue
 *    records, one layer down.
 *  - **What is RUNNING decides, not what the policy resolves to.** Containment
 *    is plumbed into the netns at container creation, so a container that
 *    started Contained holds an old allowlist even after the user flips the
 *    session to Open — and one that started Open is unrestricted even while the
 *    policy says Contained. `startedContained` is therefore the input, and the
 *    resolved-now policy is deliberately not.
 *  - **A session can be excluded from its own allowlist.** docs/211's
 *    Network-off sandbox resolves to a lifeline-only config that carries no user
 *    hosts at all, so the entry saves, the reload runs, and the session still
 *    cannot reach the host — and no restart ever changes that.
 */

import type { EgressGrantSurface, EgressHostGrantOutcome } from "../shared/types.js";

/** Every surface — the "live everywhere, nothing pending" answer. */
const ALL_SURFACES: EgressGrantSurface[] = ["new-containers", "agent", "services"];

/** The two that hold a creation-time snapshot of the allowlist. */
const SNAPSHOT_SURFACES: EgressGrantSurface[] = ["agent", "services"];

export interface EgressGrantContext {
  /** The host as the user gave it (trimmed), for the confirmation sentence. */
  host: string;
  /** Where the entry was written. */
  scope: "session" | "global";
  /**
   * Whether `reloadEgress` actually reloaded this session's live sidecars —
   * its own return value, not "a session add was made". It answers false for a
   * deployment that can't enforce, a session running Open, and a deployment
   * with the Tier B/C sidecars disabled; in that last one the agent really is
   * left holding the old list. Always false for a global add: that path
   * reloads nothing at all, by design.
   */
  reloaded: boolean;
  /**
   * The session the outcome describes. For a session-scoped add this is the
   * scope itself; for a global add it is the session the browser asked to be
   * reported against (the Plugins card knows one; the global Settings editor
   * does not, and passes null).
   */
  sessionId: string | null;
  /** Whether this deployment can enforce containment at all (docs/172). */
  enforcementActive: boolean;
  /**
   * The containment the in-scope session's LIVE container started with, or
   * `null` when no container is running (nothing to be stale, nothing to
   * restart). Same source as `EgressSessionSettings.startedContained` — what
   * the running container was plumbed with, not what the policy says today.
   */
  startedContained: boolean | null;
  /**
   * True when the session's own resolved egress config excludes the host no
   * matter what the allowlist holds — today only docs/211's Network-off
   * sandbox, whose lifeline config carries no user hosts. Read from the same
   * `resolveEgress` seam the Plugins card and the enforcement path use, so the
   * report can never contradict them. `false` when the answer isn't knowable
   * (no resolver wired): "unknown" must not render as a positive claim of
   * exclusion.
   */
  excludedBySessionPolicy: boolean;
}

export function computeEgressGrantOutcome(ctx: EgressGrantContext): EgressHostGrantOutcome {
  const base = { host: ctx.host, scope: ctx.scope };
  const live = (): EgressHostGrantOutcome => ({
    ...base,
    liveNow: [...ALL_SURFACES],
    staleUntilRestart: [],
    restartSessionId: null,
    excludedBySessionPolicy: false,
  });
  /** Saved, and reaching only what starts from here — nothing running is stale. */
  const nextStart = (): EgressHostGrantOutcome => ({
    ...base,
    liveNow: ["new-containers"],
    staleUntilRestart: [],
    restartSessionId: null,
    excludedBySessionPolicy: false,
  });
  const stale = (restartSessionId: string | null): EgressHostGrantOutcome => ({
    ...base,
    liveNow: ["new-containers"],
    staleUntilRestart: [...SNAPSHOT_SURFACES],
    restartSessionId,
    excludedBySessionPolicy: false,
  });

  // The session's own policy drops user hosts entirely, so the entry is saved
  // and this session still cannot reach it — and no restart changes that.
  if (ctx.excludedBySessionPolicy) {
    return { ...base, liveNow: [], staleUntilRestart: [], restartSessionId: null, excludedBySessionPolicy: true };
  }

  // Nothing on this deployment is contained, so no surface is running an
  // allowlist that could be stale and the host was reachable already.
  if (!ctx.enforcementActive) return live();

  if (ctx.sessionId) {
    // Nothing is running: no agent and no services to be live OR stale.
    if (ctx.startedContained === null) return nextStart();
    // The live container was plumbed WITHOUT containment — it is unrestricted
    // right now, whatever the policy resolves to today.
    if (!ctx.startedContained) return live();
    // Running contained: only the reload could have reached it.
    return ctx.reloaded ? live() : stale(ctx.sessionId);
  }

  // No session in scope (the app-wide Settings editor). Which sessions are
  // running is not this route's question, so the outcome states the general
  // truth and offers no restart — "restart" has no subject here.
  return stale(null);
}
