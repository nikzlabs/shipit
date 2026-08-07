import type { AgentId, AgentEvent, AgentReasoningCapability } from "../agent-types.js";
import type { PermissionMode } from "../attachment-types.js";
// Type-only edge into the orchestrator so the snapshot and `GET /history`
// share ONE definition of a transcript row (the client renders both through
// the same path). Erased at build time — no runtime coupling reaches the
// client bundle.
import type { PersistedMessage } from "../../../orchestrator/chat-history.js";
import type { ToolResultEntry } from "../../../orchestrator/session-runner.js";
import type { AgentInterfaceProvenance } from "../../agent-interface-sdk/protocol.js";
import type { SessionMessageOrigin } from "../domain-types.js";

export interface WsAgentEvent {
  type: "agent_event";
  event: AgentEvent;
}

/**
 * Server → Client: the complete in-progress turn, as of the instant this
 * viewer attached. Sent once per attach (WS connect / session switch back /
 * reconnect) while a turn is running.
 *
 * Why this exists: a reattaching viewer used to rebuild the running turn from
 * TWO independently-sampled sources — the `GET /history` DB snapshot plus a
 * cursor-sliced replay of the runner's turn-event buffer
 * (`lastPersistedBufferIndex`). The cursor only means "everything before this
 * is already in the DB", which is true of a history snapshot taken *after* the
 * persist that moved it. The two are sampled at different times, so a
 * tool-result boundary landing between them either erased a whole slice of the
 * turn from the transcript (history read first → the slice is in neither half)
 * or duplicated it (attach first → the slice is in both). Nothing ever repaired
 * it: the viewer sat on a wrong transcript until the next reload.
 *
 * The snapshot removes the stitching. It is built inside the same synchronous
 * block that subscribes this socket to the runner, so it covers *exactly*
 * everything up to the attach and every later event arrives live on this
 * socket — no gap and no overlap, whichever order the history fetch resolves
 * in. The client applies it by REPLACING the in-progress rows it got from
 * history, so a stale-in-either-direction baseline self-corrects.
 *
 * Not transcript content in its own right (CLAUDE.md "Chat transcript content
 * MUST be persisted"): every message here is rebuilt from the runner's live
 * accumulator, which the tool-result boundary persists as `in_progress` rows
 * and `agent_result` finalizes. It is a rehydration message, not a new card.
 */
export interface WsTurnSnapshot {
  type: "turn_snapshot";
  /** Scopes the snapshot so it can't land in another session's transcript. */
  sessionId: string;
  /**
   * The turn's assistant groups, live-steered user messages, and recorded chat
   * cards — the same shape `GET /history` returns for `in_progress` rows,
   * interleaved at their true positions.
   */
  messages: PersistedMessage[];
  /**
   * Reserved for a snapshot that describes a turn that has already finished
   * (rows persisted and finalized), which the client applies by CLEARING the
   * in-progress marking instead of setting it.
   *
   * Nothing emits this yet. A finished turn is reconciled by the next attach —
   * which reloads history from the DB, where the turn is complete — rather than
   * by pushing a final snapshot mid-flight: the client marks only rows it got
   * from history/snapshots as in-progress, so a push-based reconciliation would
   * append a second copy of every live-streamed row, steered message, and card.
   * Making that safe means tracking the running turn's start index client-side;
   * the handler is ready for it.
   */
  final?: boolean;
}

/**
 * docs/144 — transient "Asking Codex…" spinner for an IN-FLIGHT sub-agent spawn.
 * Status only (CLAUDE.md §5): emit-only, correctly disappears on reload — it is
 * live activity, not transcript content. The TERMINAL state ("Consulted Codex ·
 * 47s") is NOT this message: it is the persisted {@link WsSubAgentConsultCard},
 * which lands inline where the consult happened and survives a switch/reload.
 * When that card arrives the client clears this spinner by `spawnId`.
 */
export interface WsSubAgentSpawn {
  type: "sub_agent_spawn";
  /**
   * The session whose transcript this spinner belongs to. Required so the
   * client can drop it when it arrives for a session other than the one being
   * viewed — without it the chip attached to whatever session happened to be
   * active (see `TRANSCRIPT_SCOPED_MESSAGES` in the client's handler map).
   */
  sessionId: string;
  /** Correlates the spinner with the terminal consult card that clears it. */
  spawnId: string;
  /** The agent being consulted (display: "Asking Codex…"). */
  subAgentId: AgentId;
}

/**
 * docs/109 reqs 10–11 — a subagent launched with `run_in_background` finished,
 * and the `tool_result` sitting in the transcript as its launch acknowledgement
 * has been replaced with what it reported.
 *
 * A patch rather than a card: the transcript row already exists and the
 * orchestrator has already rewritten it in place (persisted history, and the
 * runner's accumulator when the launching turn is still open), so there is
 * nothing here for `emitChatCard` to record — this only tells viewers holding
 * the pre-completion copy in memory to catch up. A viewer that misses it gets
 * the same content from history on its next load, which is exactly why the
 * persist is the source of truth and this is the optimisation.
 *
 * `result` is projected for the wire like any other served tool result
 * (docs/244), so a long report arrives clamped with the rest behind the modal's
 * fetch.
 */
export interface WsSubagentReportUpdate {
  type: "subagent_report_update";
  /** The session that owns the transcript this result belongs to. */
  sessionId: string;
  /** The `Task`/`Agent` tool_use whose result this replaces. */
  toolUseId: string;
  result: ToolResultEntry;
}

// ---- Model info ----

/** Sent once after the Claude CLI init event, and on reconnect. */
export interface WsModelInfo {
  type: "model_info";
  model: string;
  contextWindowTokens: number;
}

// ---- Prompt queuing messages ----

/** Server → Client: a message was queued because Claude is busy. */
export interface WsMessageQueued {
  type: "message_queued";
  /** 1-indexed display position in the queue. */
  position: number;
  text: string;
}

/** Server → Client: the queue changed (after a cancel, dequeue, or session switch). */
export interface WsQueueUpdated {
  type: "queue_updated";
  /** Current queue contents after the change. */
  queue: { text: string; position: number }[];
  /** Text of the message that was just dequeued for execution (absent on cancel/clear). */
  dequeued?: string;
}

/**
 * Server → Client: a user message was steered to the running agent (live
 * steering active). The message was injected mid-turn rather than queued.
 * (docs/140)
 */
export interface WsMessageSteered {
  type: "message_steered";
  text: string;
  sessionId: string;
  /**
   * Attachments the user sent with the steer. Same shapes that chat history
   * persists for user messages — so reconnecting viewers / other tabs render
   * the steered bubble identically to a reloaded one.
   *
   * docs/244 / planning#299 — that parity now includes the body bound: the echo
   * carries a content-addressed `src` rather than the base64 `data`, exactly as
   * the history path does. The steered row is persisted BEFORE this message is
   * emitted, so the image is fetchable the moment the URL is on the wire.
   */
  images?: { data?: string; mediaType: string; src?: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
}

// ---- Agent registry server messages ----

export interface WsAgentListMessage {
  type: "agent_list";
  agents: {
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
    /**
     * Whether the agent backend can run the chat-native AI review flow
     * (docs/125-chat-native-ai-review). Drives whether the "Ask agent to
     * review" button shows up in the file-preview modal.
     */
    supportsReview: boolean;
    /**
     * Whether this agent supports live steering (docs/140) — injecting user
     * messages into a running turn without queuing.
     */
    supportsSteering: boolean;
    /**
     * Permission modes this agent supports (docs/138). Drives the client's
     * agent-aware mode selector — e.g. `guarded` is only offered when this
     * array includes it. Codex reports `[]` (no permission modes).
     */
    supportedPermissionModes: PermissionMode[];
    /**
     * docs/217 — reasoning/effort options this agent exposes (or absent). Drives
     * the composer's reasoning control and the per-agent Settings tab default.
     */
    reasoning?: AgentReasoningCapability;
  }[];
}

/** Server → Client: the agent was interrupted by user. */
export interface WsAgentInterrupted {
  type: "agent_interrupted";
}
