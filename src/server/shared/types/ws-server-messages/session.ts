import type { SessionInfo, SessionMessageOrigin, SessionSecretBlock } from "../domain-types.js";
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

export type RescuePhase =
  | "stopping_stack"
  | "destroying_container"
  | "creating_container"
  | "starting_stack"
  | "restarting_agent"
  | "ready"
  | "failed";

export interface WsContainerRestarting {
  type: "container_restarting";
  sessionId: string;
  phase?: RescuePhase;
  reason?: string;
  message?: string;
}

export type ContainerFreshness =
  | { state: "current"; workerBuildId: string; orchestratorBuildId: string }
  | { state: "stale"; workerBuildId: string; orchestratorBuildId: string }
  | { state: "unknown"; workerBuildId?: string; orchestratorBuildId?: string };

export interface WsSessionContainerFreshness {
  type: "session_container_freshness";
  sessionId: string;
  freshness: ContainerFreshness;
}

export interface WsSecretBlockStatus {
  type: "secret_block_status";
  sessionId: string;
  block: SessionSecretBlock | null;
}

export interface WsFullResetComplete {
  type: "full_reset_complete";
}

/** Turn transition, not a snapshot: unrelated updates must not change running. */
export interface WsSessionStatus {
  type: "session_status";
  sessionId: string;
  running: boolean;
  queueLength?: number;
  error?: string;
  /** agent-reclaimed keeps previews; memory-pressure also stops them. */
  reason?: "agent-reclaimed" | "memory-pressure";
  idleMs?: number;
  lastInterruptError?: string;
}

/** Complete task list; independent of turn state. */
export interface WsBackgroundTasks {
  type: "background_tasks";
  sessionId: string;
  count: number;
  descriptions: string[];
}

/** Agent-container OOM breaker; further creation requires explicit rescue. */
export interface WsSessionMemoryExhausted {
  type: "session_memory_exhausted";
  sessionId: string;
  countInWindow: number;
  windowMs: number;
  threshold: number;
}

export interface WsSessionAgentStarted {
  type: "session_agent_started";
  sessionId: string;
  activity?: string;
}

export interface WsSessionAgentFinished {
  type: "session_agent_finished";
  sessionId: string;
}

/** Emit after persistence so attachment URLs resolve. */
export interface WsSystemUserMessage {
  type: "system_user_message";
  sessionId: string;
  text: string;
  activity?: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  /** Deduplicates the sender's optimistic bubble; text cannot distinguish repeated sends. */
  clientRequestId?: string;
  images?: { data?: string; mediaType: string; src?: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
  userReview?: { filePaths: string[]; commentCount: number };
}

/** Does not clear the loading state. */
export interface WsSystemNotice {
  type: "system_notice";
  sessionId: string;
  message: string;
  level?: "info" | "warn";
  /** Shared with the persisted row for replay deduplication. */
  id?: string;
}
