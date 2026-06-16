import type { AgentId } from "../agent-types.js";

/**
 * docs/178 — a persisted "Context compacted" transcript card. Shared verbatim by
 * the live WS payload (`WsCompactionCard`), the persisted chat-history row
 * (`PersistedMessage.compaction`), and the client card so the three can't drift
 * (same pattern as the voice-note / bug-report / issue-write cards). Every detail
 * field is optional because Codex supplies none of them natively — the card
 * degrades to a bare "Context compacted" row when they're absent.
 */
export interface CompactionCard {
  /** Stable id — keeps the live append + history rehydration idempotent. */
  id: string;
  /** `"manual"` for an explicit `/compact`, `"auto"` when the CLI self-compacted. */
  trigger?: "manual" | "auto";
  /** Context-window occupancy (tokens) before compaction. */
  preTokens?: number;
  /** Context-window occupancy (tokens) after compaction. */
  postTokens?: number;
  /** How long the compaction took, in ms, when the backend reports it. */
  durationMs?: number;
  createdAt: string;
}

/**
 * docs/144 — the persisted "Consulted Codex · 47s · $0.03" transcript card for a
 * completed sub-agent spawn. Unlike the transient in-flight spinner (the
 * `sub_agent_spawn` WS message + `subAgentSpawns` store), this terminal record
 * IS transcript content — the user expects it to stay where the consultation
 * happened, surviving a session switch and a full reload — so it follows the
 * side-channel-card persistence contract (emitted via `emitChatCard`, anchored
 * inline at the spawn position, persisted in chat history). Renders for every
 * terminal status, not just success (a cancelled/timed-out/failed consult is
 * still a fact the transcript should keep).
 */
export interface SubAgentConsultCard {
  /** Stable id — keeps the live append + history rehydration idempotent. */
  cardId: string;
  /** The in-flight spawn this card finalizes; clears the matching running chip. */
  spawnId: string;
  /** The agent that was consulted (display: "Consulted Codex"). */
  subAgentId: AgentId;
  /** Terminal status — drives the verb ("Consulted" / "Cancelled" / …). */
  status: "success" | "error" | "timeout" | "cancelled";
  durationMs?: number;
  costUsd?: number;
  /** True when the sub-agent's output hit the wall-clock or character cap. */
  truncated?: boolean;
  createdAt: string;
}

/**
 * docs/207 / SHI-153 — one optional action the agent proposes via the
 * `propose_actions` tool. The card renders these as a button (one action) or a
 * checklist (2+); ticking declares intent and the agent does the work, so no
 * field here ever executes anything directly.
 */
export interface ActionChecklistItem {
  /** Stable id for this action within the card (used as the React key + selection key). */
  id: string;
  /** Short button / checkbox text. */
  label: string;
  /** Optional one-line explanation under the label. */
  description?: string;
  /** The agent's recommendation — pre-ticks the box. The user still decides. */
  defaultChecked?: boolean;
  /**
   * The self-contained instruction the agent receives if this action is chosen.
   * Self-contained on purpose: the card outlives the turn, the agent, even a
   * destroyed-and-re-cloned container, so the submitted message is rebuilt from
   * the ticked `payload`s — never from warm conversation context.
   */
  payload: string;
}

/**
 * docs/207 / SHI-153 — a persisted "action checklist" transcript card. The agent
 * proposes one or more INDEPENDENT optional follow-ups; the user resolves the
 * subset they want with a SINGLE batched submit (one message → one turn, never N
 * racing clicks). The card is an immutable, reusable message composer: it has no
 * terminal state, never locks, and can be re-submitted with a different subset
 * indefinitely. Shared verbatim by the live WS payload (`WsActionChecklistCard`),
 * the persisted chat-history row (`PersistedMessage.actionChecklist`), and the
 * client card so the three can't drift — same pattern as the issue-ref / sub-
 * agent-consult cards (static payload, no client store, no in-place patch path).
 *
 * Provenance (`branch`, `headSha`, `createdAt`) is captured at emit time and is
 * immutable. It travels into the message the card sends so the agent can inspect
 * current state and adapt/decline if an action is now obsolete (branch merged, PR
 * already exists, files moved) — the "honest at click-time" guarantee without a
 * stale *state* or a lock.
 */
export interface ActionChecklistCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  /** Optional heading, e.g. "Optional follow-ups". */
  title?: string;
  /** 1..N proposed actions. One → button card; two or more → checklist card. */
  actions: ActionChecklistItem[];
  /** Branch the actions were proposed against (provenance, immutable). */
  branch?: string;
  /** Short HEAD SHA the actions were proposed against (provenance, immutable). */
  headSha?: string;
  /** Emit time — doubles as the "proposed <date>" provenance stamp. */
  createdAt: string;
}

// ---- Chat history message (shared data type) ----

/**
 * A single nested event emitted by a subagent (Claude's Task tool). The
 * `parentToolUseId` links it back to a tool_use block in the parent message's
 * `toolUse` list. Used for subagent transparency (109).
 */
export type WsSubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: {
        toolUseId: string;
        content: string;
        isError?: boolean;
      }[];
    };

export interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    data: string;      // base64 image data (inlined for small images)
    mediaType: string;
  }[];
  files?: {
    path: string;
    contentPreview: string;  // first 200 chars of content
    startLine?: number;
    endLine?: number;
  }[];
  isError?: boolean;
  toolResults?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  }[];
  /** True while the agent turn that produced this message is still running. */
  inProgress?: boolean;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  rolledBack?: boolean;
  forkChild?: { childSessionId: string; title: string; branch: string };
  codeRollbackHash?: string;
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The client groups these by `parentToolUseId` and
   * renders them as a nested tree (109 — subagent transparency).
   */
  subagentEvents?: WsSubagentEvent[];
}
