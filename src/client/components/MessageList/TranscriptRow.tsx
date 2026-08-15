import { memo, type RefObject } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { TodoPanel } from "../TodoPanel.js";
import { isTaskListTool } from "../../../server/shared/task-list-tools.js";
import type { SearchMatch } from "../../hooks/useSearch.js";
import type { VisualElement } from "../visual-elements.js";
import { RewindPoint, type RewindGapAction } from "../RewindPoint.js";
import type { WsRewindPreview } from "../../../server/shared/types.js";
import { ToolUseItem } from "../message-tools.js";
import { parseMessageSegments, MarkdownContent, CodeBlock } from "../message-markdown.js";
import { getSegmentMatches, HighlightedText } from "../message-highlighting.js";
import { MessageFileAttachments, MessageImages } from "../message-media.js";
import { PlayTurnButton } from "../PlayTurnButton.js";
import type { ChatMessage } from "./types.js";
import { MessageToolElement } from "./MessageToolUse.js";
import { renderMessageCard } from "./cards/MessageCards.js";
import { useRowHandlers } from "./row-context.js";

/**
 * One row of the transcript, memoized (planning#375).
 *
 * Every prop here is referentially STABLE while the row's content is unchanged
 * — that is the whole contract, and it is what lets `memo` bail out. During a
 * streaming turn only the last row's `anchor` changes, so React skips the
 * subtree of every other row instead of re-rendering ~2,000 of them at a
 * measured 92 ms per update.
 *
 * Two props carry the change signal between them:
 *
 *   - `el` — reused object-for-object by `buildVisualElements` when the element
 *     would draw the same thing (see `reuseUnchanged`);
 *   - `anchor` — `messages[elementMessageIndex(el)]`, the message this row hangs
 *     off. It is the catch-all: any edit to that message replaces the object, so
 *     the row redraws even for a change no `el` field reflects (`subagentEvents`
 *     arriving, a tool result landing, text growing).
 *
 * Everything volatile-but-meaningless — the callbacks, the `messages` array —
 * is read through `useRowHandlers()`, whose identity never changes. Do not turn
 * one of those into a prop without checking `row-context.tsx` first.
 */
export interface TranscriptRowProps {
  el: VisualElement;
  /** The message this element hangs off; the row's catch-all change signal. */
  anchor: ChatMessage | undefined;
  /** Stable while the search results are unchanged; the row does its own lookup. */
  matchesByMessage: Map<number, SearchMatch[]>;
  currentMatch?: SearchMatch;
  currentMatchRef: RefObject<HTMLElement | null>;
  /** Drives the rewind handle's "turn running" state. */
  isLoading: boolean;
  voicePlaybackEnabled: boolean;
  /** This row's Play-button prose, or undefined. A primitive, so memo-safe. */
  turnProse?: string;
  activeSessionId?: string;
  hasRewindControls: boolean;
  forkDefaultName: string;
  rewindPreviews?: Record<string, WsRewindPreview>;
  /** Precomputed by the parent — both are primitives, so they cost the memo nothing. */
  showGapBefore: boolean;
  gapPreviousRole: "user" | "assistant" | null;
}

function TranscriptRowInner({
  el,
  anchor,
  matchesByMessage,
  currentMatch,
  currentMatchRef,
  isLoading,
  voicePlaybackEnabled,
  turnProse,
  activeSessionId,
  hasRewindControls,
  forkDefaultName,
  rewindPreviews,
  showGapBefore,
  gapPreviousRole,
}: TranscriptRowProps) {
  const handlers = useRowHandlers();

  const getPreviewsForGap = (gapPosition: number): Partial<Record<RewindGapAction, WsRewindPreview>> => ({
    chat: rewindPreviews?.[`${gapPosition}:chat`],
    code: rewindPreviews?.[`${gapPosition}:code`],
    both: rewindPreviews?.[`${gapPosition}:both`],
    fork: rewindPreviews?.[`${gapPosition}:fork`],
  });

  const renderRewindPoint = (gapPosition: number) => {
    if (!hasRewindControls || !handlers.current.onRewindAtGap) return null;
    const align = gapPreviousRole === "user" ? "right" : gapPreviousRole === "assistant" ? "left" : "center";
    return (
      <RewindPoint
        gapPosition={gapPosition}
        currentState={false}
        align={align}
        turnRunning={isLoading}
        defaultSessionName={forkDefaultName}
        previews={getPreviewsForGap(gapPosition)}
        onRequestPreview={handlers.current.onRequestRewindPreview}
        onRewind={handlers.current.onRewindAtGap}
      />
    );
  };

  // ── The agent's to-do list, folded from its task calls (task-list.ts) ──
  if (el.kind === "task-panel") {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl">
          <TodoPanel tasks={el.tasks} />
        </div>
      </div>
    );
  }

  // ── Tool-derived elements: grouped tool calls, standalone subagents,
  //    and standalone tools (ExitPlanMode / AskUserQuestion / present) ──
  if (el.kind === "tool-group" || el.kind === "subagent" || el.kind === "standalone-tool") {
    return (
      <MessageToolElement
        el={el}
        messages={handlers.current.messages}
        findPlanContent={handlers.current.findPlanContent}
        onAnswerQuestion={handlers.current.onAnswerQuestion}
        onSendFollowUp={handlers.current.onSendFollowUp}
      />
    );
  }

  // ── Message bubble ──
  const i = el.index;
  const hideTools = el.hideTools;
  const msg = anchor;
  if (!msg) return null;

  // Inline transcript cards (spawned session, review, voice note,
  // permission/egress/issue prompts, etc.) carry no chat text of their
  // own — render the card and skip the bubble path. Order is preserved
  // verbatim inside `renderMessageCard`.
  const card = renderMessageCard(msg, {
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    onResumeSession: handlers.current.onResumeSession,
    onSubmitBugReport: handlers.current.onSubmitBugReport,
    onEgressDecision: handlers.current.onEgressDecision,
    onResolvePermission: handlers.current.onResolvePermission,
    onUndoIssueWrite: handlers.current.onUndoIssueWrite,
    onOpenIssue: handlers.current.onOpenIssue,
    onSendFollowUp: handlers.current.onSendFollowUp,
    onReleaseConfirm: handlers.current.onReleaseConfirm,
    onReleaseCancel: handlers.current.onReleaseCancel,
  });
  if (card) return <>{card}</>;

  const msgMatches = matchesByMessage.get(i) ?? EMPTY_MATCHES;
  const segments = parseMessageSegments(msg.text);
  const hasCodeBlocks = segments.some((s) => s.type === "code");
  const useMarkdown = msg.role === "assistant" && !msg.isError && !msg.notice;
  // Hide the bubble when it would be empty (no text/images/files and every
  // tool is a task-list call, which renders as null inside the bubble —
  // the task panel draws those)
  const hasVisibleTools = !hideTools && msg.toolUse?.some((t) => !isTaskListTool(t.name));
  const hideBubble = !msg.text && !msg.images?.length && !msg.files?.length && !hasVisibleTools && !!msg.toolUse?.length;

  return (
    <>
      {showGapBefore && renderRewindPoint(i)}
      {msg.rolledBack && msg.codeRollbackHash && (
        <div className="flex justify-center">
          <div className="rounded-full border border-(--color-border-primary) bg-(--color-bg-secondary) px-3 py-1 text-xs text-(--color-text-secondary)">
            Code rolled back to {msg.codeRollbackHash.slice(0, 7)}. The changes from the previous response have been reverted.
          </div>
        </div>
      )}
      {!hideBubble && (
      <div className={`group flex ${msg.role === "user" ? "justify-end" : "justify-start"} ${msg.rolledBack ? "opacity-40" : ""}`}>

      <div
        className={`relative text-sm ${
          !useMarkdown && !hasCodeBlocks ? "whitespace-pre-wrap" : ""
        } ${
          msg.role === "user"
            ? `rounded-lg px-4 py-3 break-words min-w-0 ${
                // A user message with code blocks needs a reasonable
                // minimum width so the block isn't squeezed to nothing
                // (a code-only message would otherwise collapse, since
                // `CodeBlock` contributes ~0 to the bubble's intrinsic
                // width via `w-0`). `min(32rem,100%)` floors the width at
                // 32rem while the `100%` cap (relative to the full-width
                // row) guarantees it never exceeds the column — so long
                // lines scroll inside the block instead of widening the
                // whole chat into a horizontal scrollbar.
                hasCodeBlocks ? "w-[min(32rem,100%)]" : "max-w-full"
              }`
            : "w-full min-w-0"
        } ${
          msg.isError
            ? "bg-(--color-error-subtle) text-(--color-error) border border-(--color-error)/50"
            : msg.notice
            ? `rounded-lg px-3 py-2 border text-xs ${
                msg.noticeLevel === "warn"
                  ? "bg-(--color-warning)/10 text-(--color-warning) border-(--color-warning)/30"
                  : "bg-(--color-bg-secondary) text-(--color-text-tertiary) border-(--color-border-secondary)"
              }`
            : msg.queued
            ? "bg-(--color-accent)/40 text-(--color-accent-text)/70 border border-(--color-accent)/30"
            : msg.role === "user"
            ? "bg-(--color-accent) text-(--color-accent-text)"
            : "text-(--color-text-primary)"
        }`}
      >
        {msg.agentInterface && (
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--color-accent-text)/75">
            {msg.agentInterface.surface === "preview" ? "Preview" : "Present"} · Agent Interface SDK
          </div>
        )}
        {msg.messageOrigin && (
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--color-accent-text)/75">
            From {msg.messageOrigin.relation} session · {msg.messageOrigin.sessionTitle}
          </div>
        )}
        {msg.queued && (
          <div className="flex items-center gap-1.5 mb-1.5 text-xs text-(--color-accent-text)/80 font-medium">
            <CircleNotchIcon size={12} className="animate-spin" />
            Queued{msg.queuePosition !== undefined ? ` #${msg.queuePosition}` : ""}
          </div>
        )}
        {useMarkdown ? (
          // `shipitLinks` — the ONE surface where agent-authored pointers
          // into the Preview / Present tab are live (docs/258). This text
          // is the agent's own output; every other `MarkdownContent` call
          // site renders content ShipIt did not author (PR and issue
          // bodies, comments, reviews, subagent reports) and must not be
          // able to present a button that starts a Compose service.
          <MarkdownContent text={msg.text} shipitLinks />
        ) : hasCodeBlocks ? (
          segments.map((seg) => {
            // Key on the segment's character offset, not its array index.
            // While a user message with code blocks is being composed/
            // streamed, indices stay stable but a content-derived key is
            // sturdier against re-segmentation — it keeps each `CodeBlock`
            // instance mounted so its memoized `hljs.highlight` cache
            // survives instead of remounting and re-highlighting.
            if (seg.type === "code") {
              return (
                <CodeBlock
                  key={seg.offset}
                  code={seg.content}
                  language={seg.language}
                />
              );
            }
            const segMatches = getSegmentMatches(
              msgMatches,
              seg.offset,
              seg.content.length
            );
            return (
              <span key={seg.offset} className="whitespace-pre-wrap">
                <HighlightedText
                  text={seg.content}
                  matches={segMatches}
                  currentMatch={currentMatch}
                  currentMatchRef={currentMatchRef}
                />
              </span>
            );
          })
        ) : (
          <HighlightedText
            text={msg.text}
            matches={msgMatches}
            currentMatch={currentMatch}
            currentMatchRef={currentMatchRef}
          />
        )}

        {msg.images && msg.images.length > 0 && (
          <MessageImages images={msg.images} isUserMessage={msg.role === "user"} />
        )}

        {msg.files && msg.files.length > 0 && (
          <MessageFileAttachments files={msg.files} />
        )}

        {!hideTools && msg.toolUse && msg.toolUse.length > 0 && (
          <div className="mt-2 space-y-1">
            {msg.toolUse.map((tool, toolIdx) => {
              const toolResult = msg.toolResults?.find((r) => r.toolUseId === tool.id);
              const resolvedPlanContent = tool.name === "ExitPlanMode" ? handlers.current.findPlanContent(i) : undefined;
              // See note in the standalone-tool branch above — the
              // right disable signal is whether the tool has a result,
              // not whether the message is last. AskUserQuestion /
              // PlanApproval track their submitted state internally
              // and read `result` to render the answered state on
              // reload.
              const questionDisabled = !!toolResult;
              return (
                <ToolUseItem
                  key={tool.id}
                  tool={tool}
                  result={toolResult}
                  isLast={toolIdx === msg.toolUse!.length - 1}
                  isStreaming={!!msg.streaming}
                  onAnswerQuestion={handlers.current.onAnswerQuestion}
                  onSendFollowUp={handlers.current.onSendFollowUp}
                  isQuestionDisabled={questionDisabled}
                  planContent={resolvedPlanContent}
                />
              );
            })}
          </div>
        )}

        {voicePlaybackEnabled && turnProse !== undefined && (
          <div className="mt-1.5 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <PlayTurnButton turnId={msg.commitHash ?? `turn-${i}`} text={turnProse} />
          </div>
        )}
      </div>
      </div>
      )}
    </>
  );
}

/**
 * A shared empty array, so a row with no search matches gets the SAME reference
 * every render. A fresh `[]` would defeat `HighlightedText`'s own memo for every
 * row in the transcript whenever anything re-rendered.
 */
const EMPTY_MATCHES: SearchMatch[] = [];

export const TranscriptRow = memo(TranscriptRowInner);
TranscriptRow.displayName = "TranscriptRow";
