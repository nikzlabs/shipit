import type { WsChatHistoryMessage } from "./domain-types.js";

// ---- Thread & checkpoint client messages ----

export interface WsCreateCheckpoint {
  type: "create_checkpoint";
  label?: string;
}

export interface WsForkThread {
  type: "fork_thread";
  checkpointId: string;
}

export interface WsSwitchThread {
  type: "switch_thread";
  threadId: string;
}

// ---- Thread & checkpoint server messages ----

export interface CheckpointInfo {
  id: string;
  sessionId: string;
  messageIndex: number;
  commitHash: string;
  createdAt: string;
  label?: string;
}

export interface ThreadInfo {
  id: string;
  sessionId: string;
  parentCheckpointId: string | null;
  agentSessionId?: string;
  name: string;
  checkpoints: CheckpointInfo[];
  isActive: boolean;
  createdAt: string;
  /** When set, contains a conversation replay to use as system prompt on the first message. */
  conversationReplay?: string;
}

export interface WsCheckpointCreated {
  type: "checkpoint_created";
  checkpoint: CheckpointInfo;
  threadId: string;
}

export interface WsThreadList {
  type: "thread_list";
  threads: ThreadInfo[];
  activeThreadId: string;
}

export interface WsThreadSwitched {
  type: "thread_switched";
  thread: ThreadInfo;
  messages: WsChatHistoryMessage[];
}

export interface WsThreadForked {
  type: "thread_forked";
  thread: ThreadInfo;
  messages: WsChatHistoryMessage[];
}
