/**
 * AgentAuthManager — shared interface implemented by every per-agent auth
 * manager (Claude OAuth, Codex device flow, …) so the orchestrator can
 * dispatch lifecycle operations through a `Map<AgentId, AgentAuthManager>`
 * lookup instead of branching on agent id at every call site. (docs/155)
 *
 * Scope. The interface covers the surface that's the same across providers:
 * kicking off a flow, cancelling it, signing out, killing the process at
 * shutdown, asking whether credentials are configured, and the
 * `pending`/`complete`/`failed` lifecycle events. The flow-pending payload
 * varies between providers (Claude prints a paste-code URL; Codex prints a
 * URL + user code) — captured by the discriminated {@link AgentAuthPendingDetails}
 * union in `ws-server-messages.ts` so the interface stays typed end-to-end
 * (STOP-GATE: no `unknown` events).
 *
 * Events. Concrete managers also emit their legacy/CLI-specific events
 * (`auth_url`, `codex_auth_pending`, …) for back-compat with existing
 * listeners and unit tests, but the orchestrator's SSE wiring rides the
 * normalized events on this interface so adding a backend is one entry in
 * the auth-manager map and one emit-site update in the new backend's class.
 */

import type { EventEmitter } from "node:events";
import type { AgentId } from "../shared/types.js";
import type { AgentAuthPendingDetails } from "../shared/types/ws-server-messages.js";

/** Optional payload accompanying the {@link AgentAuthManager} `failed` event. */
export interface AgentAuthFailedPayload {
  /** Coarse failure category — drives the next-step copy in the UI. */
  reason?: "timeout" | "denied" | "error" | "revoked";
  /** Human-readable detail. Surfaced in the sign-in card error toast. */
  message?: string;
}

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

  /**
   * Snapshot of the in-flight pending payload, or `null` when no flow is
   * pending. Replayed to fresh SSE clients on connect so a mid-flow page
   * reload re-renders the sign-in card instead of stranding the user on a
   * dead button. Backends without a replay cache (Claude doesn't keep one
   * today) may return `null` unconditionally.
   */
  getPendingPayload(): AgentAuthPendingDetails | null;
}

/**
 * Typed event names emitted by every `AgentAuthManager`. Concrete classes
 * still emit their legacy/CLI-specific events for back-compat; the events
 * below are the normalized surface the orchestrator's SSE wiring listens to.
 */
export interface AgentAuthManagerEvents {
  pending: [details: AgentAuthPendingDetails];
  complete: [];
  failed: [payload?: AgentAuthFailedPayload];
}
