import { SpawnedSessionCard } from "../../SpawnedSessionCard.js";
import { ChildMergedCard } from "../../ChildMergedCard.js";
import { SelfMergeWatchCard } from "../../SelfMergeWatchCard.js";
import { SessionReportCard } from "../../SessionReportCard.js";
import { NonTurnFailureCard } from "../../NonTurnFailureCard.js";
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
import { PresentInlineCard } from "../../PresentInlineCard.js";
import { BranchUpdatedCard } from "../../BranchUpdatedCard.js";
import { SessionRenamedCard } from "../../SessionRenamedCard.js";
import { SessionSettingsChangeCard } from "../../SessionSettingsChangeCard.js";
import { BranchSyncedCard } from "../../BranchSyncedCard.js";
import { ReleaseLifecycleCard } from "../../ReleaseLifecycleCard.js";
import type { ChatMessage } from "../types.js";
import type { AgentInterfaceProvenance } from "../../../../server/shared/agent-interface-sdk/protocol.js";
import type { ReleaseMechanism } from "../../../../server/shared/types.js";
import { SubAgentConsultCardRow } from "./SubAgentCards.js";
import type { TrackerId } from "../../../../server/shared/types.js";

export interface MessageCardCallbacks {

  sessionId?: string;

  onResumeSession?: (sessionId: string) => void;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
  onDismissBugReport?: (cardId: string) => void;

  onEgressDecision?: (cardId: string, host: string, action: "allow-once" | "add" | "deny") => void;

  onResolvePermission?: (requestId: string, behavior: "allow" | "deny", remember?: boolean) => void;

  onUndoIssueWrite?: (cardId: string) => void;

  onOpenIssue?: (ref: {
    tracker: TrackerId;
    id?: string;
    identifier: string;
    title?: string;
    url?: string;

    anchorCommentId?: string;
  }) => void;

  onSendFollowUp?: (text: string) => boolean;

  onReleaseConfirm?: (version: string, mechanism: ReleaseMechanism) => void;

  onReleaseCancel?: (version: string) => void;

  onAgentInterfaceMessage?: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
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
            {...(msg.childMerged.deliveryFailure ? { deliveryFailure: msg.childMerged.deliveryFailure } : {})}
            {...(cb.onResumeSession ? { onOpen: cb.onResumeSession } : {})}
          />
        </div>
      </div>
    );
  }

  if (msg.selfMergeWatch) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SelfMergeWatchCard card={msg.selfMergeWatch} sessionId={cb.sessionId ?? ""} />
        </div>
      </div>
    );
  }

  if (msg.sessionReport) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SessionReportCard
            fromSessionId={msg.sessionReport.fromSessionId}
            fromTitle={msg.sessionReport.fromTitle}
            {...(msg.sessionReport.fromBranch ? { fromBranch: msg.sessionReport.fromBranch } : {})}
            relation={msg.sessionReport.relation}
            severity={msg.sessionReport.severity}
            {...(msg.sessionReport.subject ? { subject: msg.sessionReport.subject } : {})}
            body={msg.sessionReport.body}
            {...(cb.onResumeSession ? { onOpen: cb.onResumeSession } : {})}
          />
        </div>
      </div>
    );
  }

  // on the row (the card collapses to one muted line), never its removal, so a

  if (msg.nonTurnFailure && cb.sessionId) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <NonTurnFailureCard
            sessionId={cb.sessionId}
            cardId={msg.nonTurnFailure.cardId}
            purpose={msg.nonTurnFailure.purpose}
            {...(msg.nonTurnFailure.serviceName ? { serviceName: msg.nonTurnFailure.serviceName } : {})}
            {...(msg.nonTurnFailure.billingMode ? { billingMode: msg.nonTurnFailure.billingMode } : {})}
            {...(msg.nonTurnFailure.modelId ? { modelId: msg.nonTurnFailure.modelId } : {})}
            {...(msg.nonTurnFailure.pinned ? { pinned: true } : {})}
            fallback={msg.nonTurnFailure.fallback}
            {...(msg.nonTurnFailure.detail ? { detail: msg.nonTurnFailure.detail } : {})}
            {...(msg.nonTurnFailure.dismissedAt ? { dismissedAt: msg.nonTurnFailure.dismissedAt } : {})}
          />
        </div>
      </div>
    );
  }

  if (msg.aiReview) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <ReviewCard card={msg.aiReview} />
        </div>
      </div>
    );
  }

  if (msg.voiceNote) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <VoiceNoteCard id={msg.voiceNote.id} headline={msg.voiceNote.headline} />
        </div>
      </div>
    );
  }

  if (msg.compaction) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <CompactionCard card={msg.compaction} />
        </div>
      </div>
    );
  }

  if (msg.subAgentConsult) {
    return (
      <div className="flex justify-start">
        <SubAgentConsultCardRow card={msg.subAgentConsult} />
      </div>
    );
  }

  if (msg.bugReport) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <BugReportCard
            cardId={msg.bugReport.cardId}
            onSubmit={cb.onSubmitBugReport}
            onDismiss={cb.onDismissBugReport}
          />
        </div>
      </div>
    );
  }

  if (msg.egressPrompt) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <EgressPromptCard cardId={msg.egressPrompt.cardId} onDecide={cb.onEgressDecision} />
        </div>
      </div>
    );
  }

  if (msg.permissionPrompt) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <PermissionRequestCard requestId={msg.permissionPrompt.requestId} onResolve={cb.onResolvePermission} />
        </div>
      </div>
    );
  }

  if (msg.issueWrite) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <IssueWriteCard cardId={msg.issueWrite.cardId} onUndo={cb.onUndoIssueWrite} onOpen={cb.onOpenIssue} />
        </div>
      </div>
    );
  }

  if (msg.issueRef) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <IssueRefCard card={msg.issueRef} onOpen={cb.onOpenIssue} />
        </div>
      </div>
    );
  }

  if (msg.actionChecklist) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <ActionChecklistCard card={msg.actionChecklist} onSubmit={cb.onSendFollowUp} />
        </div>
      </div>
    );
  }

  // in place. Wider than the other cards because an artifact needs room to read.
  if (msg.presentInline) {
    return (
      <div className="flex justify-start">
        <div className="max-w-3xl w-full">
          <PresentInlineCard
            card={msg.presentInline}
            {...(cb.onAgentInterfaceMessage ? { onAgentInterfaceMessage: cb.onAgentInterfaceMessage } : {})}
          />
        </div>
      </div>
    );
  }

  if (msg.branchAutoReset) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <BranchUpdatedCard card={msg.branchAutoReset} />
        </div>
      </div>
    );
  }

  if (msg.sessionRenamed) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SessionRenamedCard card={msg.sessionRenamed} />
        </div>
      </div>
    );
  }

  if (msg.sessionSettingsChange) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <SessionSettingsChangeCard card={msg.sessionSettingsChange} />
        </div>
      </div>
    );
  }

  if (msg.branchSynced) {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl w-full">
          <BranchSyncedCard card={msg.branchSynced} />
        </div>
      </div>
    );
  }

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

  if (msg.role === "user" && msg.userReview) {
    return (
      <div className="flex justify-end">
        <div className="min-w-0">
          <UserReviewCard
            filePaths={msg.userReview.filePaths}
            commentCount={msg.userReview.commentCount}
            prompt={msg.text}
          />
        </div>
      </div>
    );
  }

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
