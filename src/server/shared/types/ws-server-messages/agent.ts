import type { AgentId, AgentEvent, AgentReasoningCapability } from "../agent-types.js";
import type { EligibleModel } from "../../agent-registry.js";
import type { PermissionMode } from "../attachment-types.js";
import type { PersistedMessage } from "../../../orchestrator/chat-history.js";
import type { ToolResultEntry } from "../../../orchestrator/session-runner.js";
import type { AgentInterfaceProvenance } from "../../agent-interface-sdk/protocol.js";
import type { SessionMessageOrigin } from "../domain-types.js";

export interface WsAgentEvent {
  type: "agent_event";
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
  /** Explains changes the server made beyond the user's selection. */
  notice?: string;
}

export interface WsMessageQueued {
  type: "message_queued";
  /** One-based. */
  position: number;
  text: string;
}

export interface WsQueueUpdated {
  type: "queue_updated";
  queue: { text: string; position: number }[];
  /** Absent on cancel or clear. */
  dequeued?: string;
}

/** Persist before emitting so attachment URLs resolve. */
export interface WsMessageSteered {
  type: "message_steered";
  text: string;
  sessionId: string;
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
}
