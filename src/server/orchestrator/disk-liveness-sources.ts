/**
 * The liveness callbacks the steady-state disk reclaim runs on (planning#439).
 *
 * They exist as named functions, rather than inline closures at the wiring site,
 * for one reason: **which session set they enumerate is a correctness property,
 * and it was silently wrong in production.** Both used `SessionManager.listAll()`,
 * which filters `warm = 0` — the right question for "whose work is this", the
 * wrong one for "what is mounted right now". A warm-pool session runs a container
 * that mounts overlay bases and plugin artifacts exactly like any other, so
 * excluding it meant the sweep deleted a live overlay `lowerdir`: on prod a warm
 * session's whole base scope went out from under a container that had been up 23
 * minutes, corrupting its dep dir with no error in that session.
 *
 * The parameter type is {@link WarmInclusiveSessions} on purpose. `SessionManager`
 * satisfies it, but the narrow type does not expose `listAll`, so the regression
 * cannot be re-introduced inside these functions without a type error — and unlike
 * the closures they replace, they are unit-testable (`disk-liveness-sources.test.ts`).
 */

import type { SessionInfo } from "../shared/types.js";
import { liveOverlayScopeHashes, depDirsForSession } from "./overlay-session.js";
import { livePluginStoreArtifacts } from "./plugin-dep-store.js";

/**
 * A session source for disk liveness: EVERY row, warm pool included. Deliberately
 * narrower than `SessionManager` — see the module docstring.
 */
export interface WarmInclusiveSessions {
  listAllIncludingWarm(): SessionInfo[];
}

/**
 * docs/183 Phase 2/3, planning#195 — the overlay-base scope hashes every resumable
 * session would re-pin for the current runtime. Resolved per sweep (not at boot)
 * so it reflects the session set at the moment the sweep runs.
 */
export function overlayLiveScopeSource(
  sessions: WarmInclusiveSessions,
): () => Set<string> {
  return () => liveOverlayScopeHashes(sessions.listAllIncludingWarm(), depDirsForSession);
}

/**
 * docs/262 req 28 — the plugin dependency-store artifacts sessions currently pin.
 * A declared plugin repository is in no repo store and its bases are in no
 * session's dep-dir scope, so without this both sweeps read every artifact
 * plugins depend on as an orphan.
 */
export function pluginLiveArtifactSource(
  sessions: WarmInclusiveSessions,
): () => Promise<{ scopeHashes: Set<string>; cacheHashes: Set<string> }> {
  return () => livePluginStoreArtifacts(sessions.listAllIncludingWarm());
}
