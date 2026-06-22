import { SpawnedSessionCard } from "../../SpawnedSessionCard.js";
import { ChildMergedCard } from "../../ChildMergedCard.js";
import { SpawnFailedCard } from "../../SpawnFailedCard.js";
import { ReviewCard } from "../../ReviewCard.js";
import { UserReviewCard } from "../../UserReviewCard.js";
import { VoiceNoteCard } from "../../VoiceNoteCard.js";
import { BugReportCard } from "../../BugReportCard.js";
import { EgressPromptCard } from "../../EgressPromptCard.js";
import { PermissionRequestCard } from "../../PermissionRequestCard.js";
import { CompactionCard } from "../../CompactionCard.js";
import { IssueWriteCard } from "../../IssueWriteCard.js";
import { IssueRefCard } from "../../IssueRefCard.js";
import { ActionChecklistCard } from "../../ActionChecklistCard.js";
import { BranchUpdatedCard } from "../../BranchUpdatedCard.js";
import { ReleaseLifecycleCard } from "../../ReleaseLifecycleCard.js";
import type { ChatMessage } from "../types.js";
import type { ReleaseMechanism } from "../../../../server/shared/types.js";
import { SubAgentConsultCardRow } from "./SubAgentCards.js";

/** Callbacks the inline transcript cards may invoke. */
export interface MessageCardCallbacks {
  /** Opens a spawned/fork child session. */
  onResumeSession?: (sessionId: string) => void;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
  /** docs/172 — resolve an egress allow-once card (allow-once / add / deny). */
  onEgressDecision?: (cardId: string, host: string, action: "allow-once" | "add" | "deny") => void;
  /** docs/193 — answer a permission request (approve/deny + remember). */
  onResolvePermission?: (requestId: string, behavior: "allow" | "deny", remember?: boolean) => void;
  /** docs/177 — undo a recorded issue write (fires a reverse brokered write). */
  onUndoIssueWrite?: (cardId: string) => void;
  /** docs/189 — open an issue's inline detail view from a chat card. */
  onOpenIssue?: (ref: {
    tracker: "linear" | "github";
    id?: string;
    identifier: string;
    title?: string;
    url?: string;
    /** Comment to scroll to + highlight once the thread lands (SHI-103). */
    anchorCommentId?: string;
  }) => void;
  onSendFollowUp?: (text: string) => void;
  /** docs/171 — confirm a proposed release (sends the "yes, ship it" reply). */
  onReleaseConfirm?: (version: string, mechanism: ReleaseMechanism) => void;
  /** docs/171 — cancel a proposed release (sends the cancel reply). */
  onReleaseCancel?: (version: string) => void;
}

/**
 * Renders the inline transcript card for a card-carrying message, or `null` if
 * the message has no card field (in which case `MessageList` falls through to the
 * normal bubble path). The check order is load-bearing and preserved verbatim
 * from the old monolithic `MessageList.tsx` render switch — no behavior change.
 *
 * The caller anchors each card with `key={i}` (a wrapping `Fragment`), so these
 * branches no longer carry their own keys.
 */
export function renderMessageCard(msg: ChatMessage, cb: MessageCardCallbacks): React.ReactNode {
  if (msg.forkChild) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SpawnedSessionCard
            childSessionId={msg.forkChild.childSessionId}
            title={msg.forkChild.title}
            branch={msg.forkChild.branch}
            spawnedAt={new Date().toISOString()}
            {...(cb.onResumeSession ? { onOpen: cb.onResumeSession } : {})}
          />
        </div>
      </div>
    );
  }

  // docs/117 Phase 2 — spawned-session marker carries no chat content
  // of its own; render the inline card and skip the bubble path. The
  // card itself reads live session state from the session store.
  if (msg.spawnedSession) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SpawnedSessionCard
            childSessionId={msg.spawnedSession.childSessionId}
            title={msg.spawnedSession.title}
            {...(msg.spawnedSession.branch ? { branch: msg.spawnedSession.branch } : {})}
            spawnedAt={msg.spawnedSession.spawnedAt}
            {...(msg.spawnedSession.shipitFix ? { shipitFix: msg.spawnedSession.shipitFix } : {})}
            {...(cb.onResumeSession ? { onOpen: cb.onResumeSession } : {})}
          />
        </div>
      </div>
    );
  }

  // docs/196 — child-merged marker carries no chat text of its own; render
  // the inline `ChildMergedCard` and skip the bubble path. Static payload,
  // no client store — renders identically live and after a reload.
  if (msg.childMerged) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <ChildMergedCard
            childSessionId={msg.childMerged.childSessionId}
            childTitle={msg.childMerged.childTitle}
            {...(msg.childMerged.branch ? { branch: msg.childMerged.branch } : {})}
            outcome={msg.childMerged.outcome}
            prNumber={msg.childMerged.prNumber}
            prUrl={msg.childMerged.prUrl}
            {...(msg.childMerged.prTitle ? { prTitle: msg.childMerged.prTitle } : {})}
            {...(msg.childMerged.mergeSha ? { mergeSha: msg.childMerged.mergeSha } : {})}
            {...(cb.onResumeSession ? { onOpen: cb.onResumeSession } : {})}
          />
        </div>
      </div>
    );
  }

  // docs/203 — plain-text AI review card carries no chat text of its own;
  // render the inline `ReviewCard` (markdown findings) and skip the bubble
  // path. Self-contained — no lazy fetch, no modal.
  if (msg.aiReview) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <ReviewCard card={msg.aiReview} />
        </div>
      </div>
    );
  }

  // docs/163 — voice note: ear-shaped headline with a play control.
  // Carries no chat text of its own; render the inline card and skip the
  // bubble path.
  if (msg.voiceNote) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <VoiceNoteCard
            id={msg.voiceNote.id}
            headline={msg.voiceNote.headline}
            needsAttention={msg.voiceNote.needsAttention}
          />
        </div>
      </div>
    );
  }

  // docs/178 — "Context compacted" card. Carries no chat text of its own;
  // render the inline `CompactionCard` and skip the bubble path.
  if (msg.compaction) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <CompactionCard card={msg.compaction} />
        </div>
      </div>
    );
  }

  // docs/144 — "Consulted Codex · 47s" card. Carries no chat text of its
  // own; render the inline terminal record and skip the bubble path. Lands
  // where the consultation happened and persists across switch/reload.
  if (msg.subAgentConsult) {
    return (
      <div className="flex justify-start">
        <SubAgentConsultCardRow card={msg.subAgentConsult} />
      </div>
    );
  }

  // docs/164 — bug-report consent card. Carries no chat text of its own;
  // render the inline `BugReportCard` (which reads its live payload +
  // lifecycle from the bug-report store) and skip the bubble path.
  if (msg.bugReport) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <BugReportCard cardId={msg.bugReport.cardId} onSubmit={cb.onSubmitBugReport} />
        </div>
      </div>
    );
  }

  // docs/172 / SHI-90 — egress allow-once card. Carries no chat text of its
  // own; render the inline `EgressPromptCard` (which reads its payload +
  // phase from the egress-prompt store) and skip the bubble path.
  if (msg.egressPrompt) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <EgressPromptCard cardId={msg.egressPrompt.cardId} onDecide={cb.onEgressDecision} />
        </div>
      </div>
    );
  }

  // docs/193 / SHI-112 — permission-request card. Carries no chat text of
  // its own; render the inline `PermissionRequestCard` (which reads its
  // payload + phase from the permission store) and skip the bubble path.
  if (msg.permissionPrompt) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <PermissionRequestCard requestId={msg.permissionPrompt.requestId} onResolve={cb.onResolvePermission} />
        </div>
      </div>
    );
  }

  // docs/177 — issue-write provenance card. Carries no chat text of its
  // own; render the inline `IssueWriteCard` (which reads its payload +
  // undo lifecycle from the issue-write store) and skip the bubble path.
  if (msg.issueWrite) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <IssueWriteCard cardId={msg.issueWrite.cardId} onUndo={cb.onUndoIssueWrite} onOpen={cb.onOpenIssue} />
        </div>
      </div>
    );
  }

  // docs/188 — issue read navigation card. Carries no chat text of its
  // own; renders the read-only `IssueRefCard` straight from the message
  // payload (no store, no lifecycle) and skips the bubble path.
  if (msg.issueRef) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <IssueRefCard card={msg.issueRef} onOpen={cb.onOpenIssue} />
        </div>
      </div>
    );
  }

  // docs/207 / SHI-153 — action checklist card. Carries no chat text of
  // its own; renders the interactive `ActionChecklistCard` straight from the
  // message payload (no store, no lifecycle). Submit reuses the same
  // follow-up sender as the rest of the chat (queue-aware, one message →
  // one turn); Add comment seeds the composer client-side.
  if (msg.actionChecklist) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <ActionChecklistCard card={msg.actionChecklist} onSubmit={cb.onSendFollowUp} />
        </div>
      </div>
    );
  }

  // docs/218 — branch-updated card. Carries no chat text of its own; renders the
  // static `BranchUpdatedCard` straight from the message payload (no store, no
  // lifecycle). Shown right after the user's message when a merged session's
  // branch was auto-reset to the latest base before the turn ran.
  if (msg.branchAutoReset) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <BranchUpdatedCard card={msg.branchAutoReset} />
        </div>
      </div>
    );
  }

  // docs/171 — release lifecycle card. Carries no chat text of its own; renders
  // the inline `ReleaseLifecycleCard` straight from the message snapshot (no
  // store — the `release_card` WS upserts this field by cardId, and reload
  // rehydrates it from history). `proposed` shows Confirm/Cancel; every later
  // phase collapses to a compact row.
  if (msg.releaseCard) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <ReleaseLifecycleCard
            card={msg.releaseCard}
            {...(cb.onReleaseConfirm ? { onConfirm: cb.onReleaseConfirm } : {})}
            {...(cb.onReleaseCancel ? { onCancel: cb.onReleaseCancel } : {})}
          />
        </div>
      </div>
    );
  }

  // User-side review submission — renders the dedicated "Sent comments"
  // card in place of a raw text bubble so the user gets a clear receipt
  // that their doc/diff comments shipped to the agent. The prompt body
  // lives on `msg.text` (kept as the source of truth so chat-history
  // reload, search, and existing text-handling still work).
  if (msg.role === "user" && msg.userReview) {
    return (
      <div className="flex justify-end">
        <div className="max-w-2xl w-full">
          <UserReviewCard
            filePaths={msg.userReview.filePaths}
            commentCount={msg.userReview.commentCount}
            prompt={msg.text}
          />
        </div>
      </div>
    );
  }

  // docs/117 cross-cutting follow-up — failure counterpart to
  // `spawnedSession`. Renders the inline `SpawnFailedCard` so a quota
  // hit / archived-parent rejection is visible alongside successful spawns.
  if (msg.spawnFailed) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SpawnFailedCard
            {...(msg.spawnFailed.title ? { title: msg.spawnFailed.title } : {})}
            reason={msg.spawnFailed.reason}
            message={msg.spawnFailed.message}
            statusCode={msg.spawnFailed.statusCode}
            {...(msg.spawnFailed.promptPreview ? { promptPreview: msg.spawnFailed.promptPreview } : {})}
            {...(msg.spawnFailed.shipitSource ? { shipitSource: true } : {})}
            failedAt={msg.spawnFailed.failedAt}
          />
        </div>
      </div>
    );
  }

  return null;
}
