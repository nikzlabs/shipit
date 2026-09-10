import type { ChildMergedCard, SelfMergeWatchCard, SessionReportCard } from "../domain-types.js";

export interface WsSessionSpawned {
  type: "session_spawned";
  sessionId: string;
  childSessionId: string;
  title: string;
  branch?: string;
  spawnedAt: string;
  shipitFix?: {
    sourceRef: string;
    /** True only for the exact deployed build commit. */
    sourceExact: boolean;
    refSource?: "build-id" | "checkout-head";
    targetRepo?: string;
    diagnosis?: string;
  };
}

export interface WsSessionSpawnFailed {
  type: "session_spawn_failed";
  sessionId: string;
  /** Generated replay-deduplication key; no child exists to supply one. */
  id: string;
  message: string;
  statusCode: number;
  reason:
    | "quota_per_turn"
    | "quota_per_parent"
    | "invalid_request"
    | "parent_missing"
    | "error";
  title?: string;
  promptPreview?: string;
  shipitSource?: boolean;
  failedAt: string;
}

export interface WsChildMergedCard {
  type: "child_merged_card";
  sessionId: string;
  card: ChildMergedCard;
}

export interface WsSessionReportCard {
  type: "session_report_card";
  /** Recipient session. */
  sessionId: string;
  card: SessionReportCard;
}

export interface WsSelfMergeWatchCard {
  type: "self_merge_watch_card";
  sessionId: string;
  card: SelfMergeWatchCard;
}
