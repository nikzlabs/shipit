import type {
  IssueWriteCard,
  IssueWriteUndoState,
  IssueRefCard,
  CompactionCard,
  SubAgentConsultCard,
  AiReviewCard,
  ActionChecklistCard,
} from "../domain-types.js";
import type { ReleaseStatusSummary } from "../release-types.js";
import type { VoiceNoteSource } from "../voice-note-types.js";

/**
 * Server → Client: a plain-text AI review card was added to (or patched in) the
 * chat transcript (docs/203). Emitted via `emitChatCard` on the first
 * `submit_review`, and re-emitted (as an upsert keyed by `reviewId`) when the
 * parent's re-review patches the same card. Carries the full `AiReviewCard`
 * payload — the reviewer's markdown renders verbatim in the card; there is no
 * snapshot, no anchoring, and no lazy fetch. Idempotent by `reviewId` so the
 * turn-event buffer replay on reconnect doesn't double-render.
 */
export interface WsAiReviewAdded {
  type: "ai_review_added";
  sessionId: string;
  card: AiReviewCard;
}

/**
 * docs/163 — the Native sink of a voice note. Emitted via `runner.emitMessage`
 * so it buffers into the turn-event log and survives reconnects. Carries only
 * the ear-shaped `headline` (never the full body); the client decides whether
 * to autoplay based on `needsAttention` + hands-free mode. `id` is synthetic
 * (not a turnId) so the playback-store can cache its audio independently.
 */
export interface WsVoiceNote {
  type: "voice_note";
  sessionId: string;
  id: string;
  headline: string;
  needsAttention: boolean;
  kind: VoiceNoteSource;
  createdAt: string;
}

/**
 * docs/164 — the inline bug-report consent card. Emitted via
 * `runner.emitMessage` (so it buffers into the turn-event log and survives
 * reconnects) after the agent's `report_shipit_bug` draft is redacted
 * server-side. Carries the EXACT redacted payload the user will review: the
 * `title` and the single editable `body`. `stage2Ran: false` flags that the
 * deep semantic redaction pass didn't complete, so the card warns the user to
 * review carefully. Nothing is filed until the user confirms.
 */
export interface WsBugReportCard {
  type: "bug_report_card";
  sessionId: string;
  /** Stable id — used to update the card in place (filed / failed). */
  cardId: string;
  title: string;
  body: string;
  /** False → "deep privacy check didn't run, review carefully" flag. */
  stage2Ran: boolean;
  /** Which session produced it — shown for transparency. */
  producer: "session" | "ops";
  /** GitHub login the issue will be filed as (the user's own identity). */
  filedAs?: string;
  createdAt: string;
}

/** docs/164 — terminal success state for a bug-report card. */
export interface WsBugReportFiled {
  type: "bug_report_filed";
  sessionId: string;
  cardId: string;
  number: number;
  url: string;
}

/** docs/164 — terminal failure state for a bug-report card. */
export interface WsBugReportFailed {
  type: "bug_report_failed";
  sessionId: string;
  cardId: string;
  message: string;
  /** True when the failure is a GitHub permission/scope error → reconnect prompt. */
  scopeError?: boolean;
}

/**
 * docs/172 / SHI-90 — the inline egress allow-once card. Emitted when the Tier C
 * SNI proxy denies a non-allowlisted host and the orchestrator's decision
 * endpoint surfaces it for the user. The user's choice comes back as
 * `egress_decision`; the resolution echoes via `WsEgressPromptResolved`.
 */
export interface WsEgressPromptCard {
  type: "egress_prompt_card";
  sessionId: string;
  /** Stable id (per session+host) — used to update the card in place. */
  cardId: string;
  /** The blocked hostname (the SNI the agent tried to reach). */
  host: string;
  createdAt: string;
}

/** docs/172 / SHI-90 — terminal state for an egress allow-once card. */
export interface WsEgressPromptResolved {
  type: "egress_prompt_resolved";
  sessionId: string;
  cardId: string;
  phase: "allowed-once" | "added" | "denied";
}

/**
 * docs/193 / SHI-112 — the inline permission-request card (agent-agnostic).
 * Emitted when an agent backend raises a gated action the user must approve (a
 * sensitive-file edit, an escalated command). Carries everything the card
 * renders; the user's answer comes back as `resolve_permission`.
 */
export interface WsPermissionRequestCard {
  type: "permission_request_card";
  sessionId: string;
  /** Stable id (the broker requestId) — used to update the card in place. */
  requestId: string;
  /** The gated tool (e.g. "Write", "Edit", "Bash", "apply_patch"). */
  toolName: string;
  /** The file/resource the gate fired on, when one could be derived. */
  path?: string;
  /** One-line human summary of what is being requested. */
  summary?: string;
  /** Which agent raised it (display only). */
  agentId?: string;
  createdAt: string;
}

/** docs/193 — terminal state for a permission-request card. */
export interface WsPermissionResolved {
  type: "permission_resolved";
  sessionId: string;
  requestId: string;
  phase: "approved" | "denied";
  /** True when the user approved with "remember this file for the session". */
  remembered?: boolean;
}

/**
 * docs/177 — the do-then-surface provenance card for an agent issue write,
 * emitted via `runner.emitMessage` (so it buffers into the turn-event log and
 * survives reconnects) right after a brokered write completes. Carries the full
 * `IssueWriteCard` (display fields + the undo snapshot). Persisted in-band via
 * `emitChatCard` so it survives a switch/reload; the undo transition patches it.
 */
export interface WsIssueWriteCard {
  type: "issue_write_card";
  sessionId: string;
  card: IssueWriteCard;
}

/**
 * docs/177 — an issue-write card's undo lifecycle transition (undoing →
 * undone | failed). Patched into the persisted card in place so the terminal
 * state survives a reload; idempotent on the client (keyed by `cardId`).
 */
export interface WsIssueWriteUpdate {
  type: "issue_write_update";
  sessionId: string;
  cardId: string;
  undoState: IssueWriteUndoState;
  /** Set when `undoState === "failed"`. */
  errorMessage?: string;
}

/**
 * docs/188 — a read-only navigation card surfaced when the agent views an issue
 * (`shipit issue view`). Emitted via `emitChatCard` so it broadcasts live AND
 * records in-band with the turn, surviving a reconnect, switch, and reload.
 * Carries the full `IssueRefCard`; the card has no lifecycle, so there is no
 * follow-up update message (unlike the write card's undo transition).
 */
export interface WsIssueRefCard {
  type: "issue_ref_card";
  sessionId: string;
  card: IssueRefCard;
}

/**
 * docs/178 — transient "Compacting…" progress indicator. Emit-only (NOT
 * persisted): it has no place in the scrollback once the matching
 * `WsCompactionCard` lands. `active:true` shows the indicator, `active:false`
 * clears it. Both CLIs may compact unsolicited mid-turn, so this can arrive
 * without the user having typed `/compact`.
 */
export interface WsCompactionStatus {
  type: "compaction_status";
  sessionId: string;
  active: boolean;
  trigger?: "manual" | "auto";
}

/**
 * docs/178 — the persisted "Context compacted" transcript card. Emitted via
 * `emitChatCard` so it both broadcasts live AND records in-band with the turn,
 * surviving a reconnect, a session switch, and a full reload (the recurring
 * ephemeral-card bug class — see CLAUDE.md). Carries the shared `CompactionCard`.
 */
export interface WsCompactionCard {
  type: "compaction_card";
  sessionId: string;
  card: CompactionCard;
}

/**
 * docs/171 — the release lifecycle card as a persisted transcript card. The
 * `ReleaseStatusPoller` emits this through `runner.emitMessage` (so it broadcasts
 * to the session's viewers and buffers into the turn-event log) on every phase
 * transition — propose, tagged, gating → released/failed, and cancelled. The
 * client upserts it into the transcript keyed by `card.cardId`, so a later
 * transition patches the SAME inline card in place rather than appending a
 * duplicate. Durability is the chat-history `release_card` column (upserted by
 * the same `cardId`), so the card survives a reconnect, switch, reload, AND an
 * orchestrator restart — unlike the previous in-memory `release_status` SSE.
 */
export interface WsReleaseCard {
  type: "release_card";
  sessionId: string;
  card: ReleaseStatusSummary;
}

/**
 * docs/144 — the persisted "Consulted Codex · 47s · $0.03" transcript card for a
 * completed sub-agent spawn. Emitted via `emitChatCard` so it both broadcasts
 * live AND records in-band with the turn, anchored at the spawn position, so it
 * lands where the consultation happened and survives a reconnect, a session
 * switch, and a full reload (the ephemeral-card bug class — see CLAUDE.md). The
 * client also uses `card.spawnId` to clear the matching in-flight spinner.
 */
export interface WsSubAgentConsultCard {
  type: "sub_agent_consult_card";
  sessionId: string;
  card: SubAgentConsultCard;
}

/**
 * docs/207 / SHI-153 — the persisted "action checklist" transcript card. Emitted
 * via `emitChatCard` so it both broadcasts live AND records in-band with the
 * turn, surviving a reconnect, a session switch, and a full reload. Carries the
 * full `ActionChecklistCard`; the card has no lifecycle (it is an immutable,
 * reusable message composer), so there is no follow-up update message — the
 * durable record of a submit is the user message the card sends, not card state.
 */
export interface WsActionChecklistCard {
  type: "action_checklist_card";
  sessionId: string;
  card: ActionChecklistCard;
}
