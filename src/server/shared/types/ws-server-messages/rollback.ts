import type { WsChatHistoryMessage } from "../domain-types.js";

// ---- Rollback messages (server → client) ----

/** Server → Client: a commit was linked to an assistant message. */
export interface WsCommitLinked {
  type: "commit_linked";
  messageIndex: number;
  commitHash: string;
  parentCommitHash: string;
}

/** Server → Client: rewind completed — remove messages after the rewind point. */
export type WsRewindComplete =
  | {
      type: "rewind_complete";
      gapPosition: number;
      action: "chat";
      droppedMessageCount: number;
      snapshotSessionId?: string;
      snapshotExpiresAt?: number;
    }
  | {
      type: "rewind_complete";
      gapPosition: number;
      action: "code";
      commitHash: string;
      snapshotSessionId?: string;
      snapshotExpiresAt?: number;
    }
  | {
      type: "rewind_complete";
      gapPosition: number;
      action: "both";
      droppedMessageCount: number;
      /** Omitted when the session had no auto-commits and "both" degraded to chat-only. */
      commitHash?: string;
      snapshotSessionId?: string;
      snapshotExpiresAt?: number;
    };

export interface WsRewindSnapshotAvailable {
  type: "rewind_snapshot_available";
  sessionId: string;
  action: "chat" | "code" | "both" | "fork";
  expiresAt: number;
}

export interface WsRewindRestored {
  type: "rewind_restored";
  sessionId: string;
  action: "chat" | "code" | "both" | "fork";
  archivedSessionId?: string;
}

export interface WsRewindPreview {
  type: "rewind_preview";
  gapPosition: number;
  action: "chat" | "code" | "both" | "fork";
  discardedTurnGroupCount?: number;
  keptTurnGroupCount?: number;
  fileCount?: number;
}

/** Server → Client: a new session was forked from a rollback point. */
export interface WsSessionForked {
  type: "session_forked";
  parentSessionId: string;
  childSessionId: string;
  title: string;
  branch: string;
  snapshotSessionId?: string;
  snapshotExpiresAt?: number;
  sessionId?: string;
  sessionName?: string;
}

export interface WsForkBreadcrumb {
  type: "fork_breadcrumb";
  parentSessionId: string;
  message: WsChatHistoryMessage;
}
