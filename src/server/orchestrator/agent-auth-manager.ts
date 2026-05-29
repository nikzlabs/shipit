/**
 * AgentAuthManager — shared interface implemented by every per-agent auth
 * manager (Claude OAuth, Codex device flow, …) so the orchestrator can
 * dispatch lifecycle operations through a `Map<AgentId, AgentAuthManager>`
 * lookup instead of branching on agent id at every call site. (docs/155)
 *
 * Scope. The interface intentionally covers ONLY the surface that is the
 * same across providers — kicking off a flow, cancelling it, signing out,
 * killing the process at shutdown, and asking whether credentials are
 * configured. The genuinely agent-shaped parts (Claude's OAuth-URL emission
 * + paste-back code prompt; Codex's device-code event payload) stay on the
 * concrete classes and keep their existing event names. Lifting those into
 * the interface would force `unknown` payloads — explicitly the STOP-GATE in
 * docs/155 Phase 2.
 *
 * Events. The shared `complete` and `failed` events carry no payload. They
 * exist so generic orchestrator-side wiring (limits-registry rearm, agent
 * registry refresh, etc.) can iterate the auth-manager map without knowing
 * which backend it's looking at. Concrete classes still emit their
 * legacy/specific events (`auth_complete` / `codex_auth_complete`, etc.) so
 * the per-agent SSE broadcasts in `wireEventHandlers` keep working —
 * implementations call both: the legacy emit first, then the normalized
 * emit. Each event fires at most once per flow.
 */

import type { EventEmitter } from "node:events";
import type { AgentId } from "../shared/types.js";

export interface AgentAuthManager extends EventEmitter {
  /** Which agent backend this manager belongs to. */
  readonly agentId: AgentId;

  /**
   * Start the agent's auth flow. Idempotent — no-op if a flow is already
   * in-flight. Concrete classes may re-broadcast cached pending state to
   * accommodate page reloads mid-flow (Codex's device-code replay).
   */
  start(): void;

  /**
   * Cancel any in-flight flow. Idempotent. Used by explicit cancel routes
   * and as part of sign-out. Distinct from `kill()`: `kill()` is the
   * shutdown-hook tear-down; `cancel()` is the user-driven abort.
   */
  cancel(): void;

  /**
   * Remove on-disk credentials so the next agent turn falls back to env-var
   * auth (or to `auth_required` if none is set). Idempotent.
   */
  signOut(): void;

  /**
   * Whether credentials are present (file on disk OR an env var). The
   * matching `AgentRegistry.refreshAuth` consults this to flip the agent's
   * `authConfigured` flag.
   */
  isConfigured(): boolean;

  /**
   * Tear down any in-flight CLI subprocess and per-flow timers. Called from
   * the graceful-shutdown hook; safe to call when nothing is running.
   */
  kill(): void;
}
