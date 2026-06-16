import type { SessionInfo } from "../domain-types.js";

export interface WsSessionList {
  type: "session_list";
  sessions: SessionInfo[];
}

export interface WsSessionStarted {
  type: "session_started";
  session: SessionInfo;
}

export interface WsSessionRenamed {
  type: "session_renamed";
  session: SessionInfo;
}

/**
 * Server → Client: progress update for a Rescue session ("Restart container")
 * operation.
 *
 * Emitted as the operation moves through phases inside
 * `POST /api/sessions/:id/container/restart`. The client renders a phased
 * overlay so the user can see *which* step is in flight and, when something
 * goes wrong, *where* the operation failed (rather than an opaque spinner
 * timing out).
 *
 * See docs/124-session-rescue-and-diagnostics §3.2.
 */
export type RescuePhase =
  | "stopping_stack"
  | "destroying_container"
  | "creating_container"
  | "starting_stack"
  /**
   * `restarting_agent` is emitted by the `restartAgent` recovery flow
   * (POST /api/sessions/:id/agent/container/restart). It's a single
   * cosmetic phase wrapping destroy+recreate of the agent container while
   * leaving the compose stack running. The client renders "Restarting
   * agent…" instead of the full Rescue phase sequence. See
   * docs/127-restart-agent.
   */
  | "restarting_agent"
  | "ready"
  | "failed";

export interface WsContainerRestarting {
  type: "container_restarting";
  sessionId: string;
  /**
   * Current phase. Older clients ignore this; newer ones render a
   * step-by-step overlay. Absent on a final `ready`/`failed` re-broadcast
   * is treated as the legacy single-event payload.
   */
  phase?: RescuePhase;
  /** When `phase === "failed"`, the underlying reason (e.g. "destroy_timeout"). */
  reason?: string;
  /** Human-readable detail to render under the phase label. */
  message?: string;
}

/** Server → Client: full reset completed successfully. */
export interface WsFullResetComplete {
  type: "full_reset_complete";
}

// ---- Session runner messages (server → client) ----

/** Server → Client: current runtime state of a session. */
export interface WsSessionStatus {
  type: "session_status";
  sessionId: string;
  running: boolean;
  queueLength?: number;
  /** Present when the session encountered a fatal error (e.g. container crash). */
  error?: string;
  /**
   * Optional explanation for a notable state transition. Lets the client
   * surface a non-error inline notice ("Session paused after N minutes
   * idle. Send a message to resume.") instead of leaving the user to
   * guess why their container went away.
   *
   * - `idle-disposed` — idle enforcer reaped the container after the grace
   *   period elapsed.
   * - `memory-pressure` — pressure-aware eviction reaped the container
   *   (feature 122).
   * See docs/124-session-rescue-and-diagnostics §1.6.
   */
  reason?: "idle-disposed" | "memory-pressure";
  /** When `reason` is set, how long the session was idle before disposal (ms). */
  idleMs?: number;
  /**
   * Most recent failure from a best-effort `agent/kill` call (Interrupt or
   * Rescue session). Non-fatal — the kill is best-effort by design — but
   * useful when the worker is wedged and the user wonders why the button
   * "did nothing." Renders as a non-blocking toast on the client.
   *
   * See docs/124-session-rescue-and-diagnostics §1.4.
   */
  lastInterruptError?: string;
}

/**
 * Server → Client: the OOM circuit breaker tripped for this session.
 *
 * Fired once when the breaker flips from healthy to tripped — i.e. the
 * Nth agent-container OOM kill within the rolling window. Future
 * container creations for this session will be refused (with a clear
 * error in the SessionHealthStrip) until the user explicitly opts back
 * in via the "Rescue session" / agent-container-restart endpoint, which
 * resets the breaker.
 *
 * Note: this is the *agent* container OOM, not a compose-child OOM
 * (which still uses `service_oom`). The two events are intentionally
 * distinct — a service OOM is recoverable, an agent-container OOM kills
 * the agent and triggers the destroy/recreate loop this breaker exists
 * to short-circuit.
 */
export interface WsSessionMemoryExhausted {
  type: "session_memory_exhausted";
  sessionId: string;
  /** OOM kills counted in the rolling window when the breaker tripped. */
  countInWindow: number;
  /** Rolling-window length in ms (informational, for UI copy). */
  windowMs: number;
  /** Threshold the breaker tripped at (informational, for UI copy). */
  threshold: number;
}

/** Server → Client: agent started running in a session (broadcast to all clients). */
export interface WsSessionAgentStarted {
  type: "session_agent_started";
  sessionId: string;
  /** Optional activity label for system-initiated turns (e.g. "Auto-fixing CI..."). */
  activity?: string;
}

/** Server → Client: agent finished in a session (broadcast to all clients). */
export interface WsSessionAgentFinished {
  type: "session_agent_finished";
  sessionId: string;
}

/** Server → Client: a server-initiated user message (e.g. CI fix prompt). */
export interface WsSystemUserMessage {
  type: "system_user_message";
  text: string;
  /** Activity label for the UI (e.g. "Auto-fixing CI..."). */
  activity?: string;
}

/**
 * Server → Client: an informational system note rendered inline in the chat
 * (docs/138). Distinct from `error` — it does NOT clear the loading state, so
 * it can be emitted mid-turn (e.g. "guarded mode unavailable, continuing in
 * auto") as well as post-turn (e.g. a summary of classifier-blocked actions).
 * Broadcast via `runner.emitMessage()` so every viewer sees it and it lands in
 * the turn-event buffer for reconnecting viewers.
 */
export interface WsSystemNotice {
  type: "system_notice";
  sessionId: string;
  message: string;
  /** Visual emphasis. `warn` for blocked-action / abort notices; `info` otherwise. */
  level?: "info" | "warn";
  /**
   * Stable id shared with the persisted chat row. Notices are now persisted (so
   * they survive a full reload, not just a WS reconnect); the id lets the client
   * dedupe a notice re-delivered by the turn-event buffer replay on reconnect
   * against the copy `loadSessionHistory` rehydrated from the DB.
   */
  id?: string;
}
