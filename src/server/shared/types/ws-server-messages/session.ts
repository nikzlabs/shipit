import type { SessionInfo, SessionMessageOrigin } from "../domain-types.js";
import type { AgentInterfaceProvenance } from "../../agent-interface-sdk/protocol.js";

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

/** Runtime comparison between a session worker image and the orchestrator. */
export type ContainerFreshness =
  | { state: "current"; workerBuildId: string; orchestratorBuildId: string }
  | { state: "stale"; workerBuildId: string; orchestratorBuildId: string }
  | { state: "unknown"; workerBuildId?: string; orchestratorBuildId?: string };

/** Transient, session-scoped worker freshness signal (docs/242). */
export interface WsSessionContainerFreshness {
  type: "session_container_freshness";
  sessionId: string;
  freshness: ContainerFreshness;
}

/** Server → Client: full reset completed successfully. */
export interface WsFullResetComplete {
  type: "full_reset_complete";
}

// ---- Session runner messages (server → client) ----

/**
 * Server → Client: current runtime state of a session.
 *
 * `running` is a **turn transition**, not a poll: every emitter sends this
 * message because a turn just started or just ended. The client treats it as
 * authoritative on "is a turn in flight" — it adds/removes the session from
 * `activeRunnerSessions` and drives the chat spinner off it. Anything that
 * merely wants to report some *other* piece of session state must therefore get
 * its own message rather than piggy-backing here with a `running` snapshot: a
 * snapshot taken at an arbitrary moment reads as "the turn ended" and produces a
 * spurious idle blip (the docs/235 regression — see {@link WsBackgroundTasks}).
 */
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
 * Server → Client: the session's outstanding agent-initiated background tasks
 * (docs/235) — a `Bash(run_in_background)` job, a scheduled wake-up. Carries the
 * **complete current list** every time (`count: 0` is the explicit drained
 * signal), so one message fully re-states the truth.
 *
 * Deliberately its own message type rather than a field on
 * {@link WsSessionStatus}. The first implementation rode along on
 * `session_status` and had to fill in a `running` value; the CLI drains the task
 * list ~1ms *before* it emits the self-wake that marks the runner busy again, so
 * that message carried `running: false` and the client read a turn that was
 * about to start as a session going idle — clearing the running indicator and
 * firing the "needs attention" chime, then flipping back a frame later. Splitting
 * the level signal off means a background-task update can never assert anything
 * about turn state.
 *
 * `descriptions` feeds the chat status line so it can name the work ("Waiting
 * for: npm test") instead of showing a bare count.
 */
export interface WsBackgroundTasks {
  type: "background_tasks";
  sessionId: string;
  count: number;
  descriptions: string[];
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
  sessionId: string;
  text: string;
  /** Activity label for the UI (e.g. "Auto-fixing CI..."). */
  activity?: string;
  agentInterface?: AgentInterfaceProvenance;
  /** Another session's agent supplied this prompt, rather than the user. */
  messageOrigin?: SessionMessageOrigin;
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
