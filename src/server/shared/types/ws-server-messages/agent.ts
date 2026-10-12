import type { AgentId, AgentEvent, AgentReasoningCapability } from "../agent-types.js";
import type { EligibleModel } from "../../agent-registry.js";
import type { PermissionMode } from "../attachment-types.js";
import type { PersistedMessage } from "../../../orchestrator/chat-history.js";
import type { ToolResultEntry } from "../../../orchestrator/session-runner.js";
import type { AgentInterfaceProvenance } from "../../agent-interface-sdk/protocol.js";
import type { SessionMessageOrigin } from "../domain-types.js";

export interface WsAgentEvent {
  type: "agent_event";
  /** The session whose turn produced it: the client drops one of another session. */
  sessionId: string;
  event: AgentEvent;
}

/** Built synchronously with viewer attach; replaces history's in-progress rows. */
export interface WsTurnSnapshot {
  type: "turn_snapshot";
  sessionId: string;
  messages: PersistedMessage[];
  /** Reserved: pushing final snapshots needs client tracking to prevent duplicate live rows. */
  final?: boolean;
}

export interface WsSubAgentSpawn {
  type: "sub_agent_spawn";
  sessionId: string;
  spawnId: string;
  subAgentId: AgentId;
}

/** The persisted result is already patched; this updates attached viewers. */
export interface WsSubagentReportUpdate {
  type: "subagent_report_update";
  sessionId: string;
  toolUseId: string;
  result: ToolResultEntry;
}

export interface WsModelInfo {
  type: "model_info";
  /** The session this reading describes; the client drops a foreign one. */
  sessionId: string;
  model: string;
  contextWindowTokens: number;
}

export interface WsModelSelectionChanged {
  type: "model_selection_changed";
  sessionId: string;
  agentId: AgentId;
  selection: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | null;
  /** Can remain set when the ID cannot be resolved to a selection. */
  modelId: string | null;
  reasoningEffort: string | null;
  roleName: string | null;
  /**
   * Set when ShipIt, not the user, dropped the role — connect-time reconciliation
   * moved a parameter the role set. The browser remembers the role the user last
   * SELECTED (docs/272 req 12), so this clear must not delete that default.
   */
  roleAutoCleared?: boolean;
  /** Explains changes the server made beyond the user's selection. */
  notice?: string;
}

/**
 * One queued message. `id` is also the `clientRequestId` of the message's bubble: the
 * sender's request id, or one ShipIt made (planning#691).
 */
export interface WsQueueRow {
  id: string;
  text: string;
  /** One-based. */
  position: number;
}

export interface WsMessageQueued {
  type: "message_queued";
  sessionId: string;
  id: string;
  /** One-based. */
  position: number;
  text: string;
}

export interface WsQueueUpdated {
  type: "queue_updated";
  sessionId: string;
  queue: WsQueueRow[];
  /** A message that leaves the queue for a turn of its own; absent on cancel, clear or steer. */
  dequeued?: { id: string; text: string };
}

/** Persist before emitting so attachment URLs resolve. */
export interface WsMessageSteered {
  type: "message_steered";
  text: string;
  sessionId: string;
  /** The bubble's identity, shared with the queue row the message came from (planning#691). */
  clientRequestId: string;
  images?: { data?: string; mediaType: string; src?: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
}

export interface WsAgentListMessage {
  type: "agent_list";
  agents: {
    id: AgentId;
    name: string;
    installed: boolean;
    hasRunnableModels: boolean;
    models: string[];
    eligibleModels: EligibleModel[];
    supportsReview: boolean;
    supportsSteering: boolean;
    supportedPermissionModes: PermissionMode[];
    reasoning?: AgentReasoningCapability;
  }[];
  /** Absent means retain the client's value for older-server compatibility. */
  canRunTurns?: boolean;
  /** Absent means no update; a recorded stamp is never cleared. */
  harnessOnboardingCompletedAt?: string;
}

export interface WsAgentInterrupted {
  type: "agent_interrupted";
  /** It clears the queue strip and closes the streaming bubble, so it is session-scoped. */
  sessionId: string;
}
