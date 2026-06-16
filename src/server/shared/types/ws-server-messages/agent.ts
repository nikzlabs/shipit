import type { AgentId, AgentEvent } from "../agent-types.js";
import type { PermissionMode } from "../attachment-types.js";

export interface WsAgentEvent {
  type: "agent_event";
  event: AgentEvent;
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
  /** Correlates the spinner with the terminal consult card that clears it. */
  spawnId: string;
  /** The agent being consulted (display: "Asking Codex…"). */
  subAgentId: AgentId;
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
   */
  images?: { data: string; mediaType: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
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
  }[];
}

/** Server → Client: the agent was interrupted by user. */
export interface WsAgentInterrupted {
  type: "agent_interrupted";
}
