import { memo, type RefObject } from "react";
import { Spinner } from "../Spinner.js";
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
 * is read through `useRowHandlers()`, whose identity never changes and whose
 * callbacks are permanent wrappers forwarding to the latest ones. That is what
 * makes it safe to hand them to a child during render from a row that may never
 * render again. Do not turn one of those into a prop without reading
 * `row-context.tsx` first.
 */
export interface TranscriptRowProps {
  el: VisualElement;

  anchor: ChatMessage | undefined;

  matchesByMessage: Map<number, SearchMatch[]>;
  currentMatch?: SearchMatch;
  currentMatchRef: RefObject<HTMLElement | null>;

  isLoading: boolean;
  voicePlaybackEnabled: boolean;

  turnProse?: string;
  activeSessionId?: string;
  hasRewindControls: boolean;
  forkDefaultName: string;
  rewindPreviews?: Record<string, WsRewindPreview>;

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
    if (!hasRewindControls || !handlers.onRewindAtGap) return null;
    const align = gapPreviousRole === "user" ? "right" : gapPreviousRole === "assistant" ? "left" : "center";
    return (
      <RewindPoint
        gapPosition={gapPosition}
        currentState={false}
        align={align}
        turnRunning={isLoading}
        defaultSessionName={forkDefaultName}
        previews={getPreviewsForGap(gapPosition)}
        onRequestPreview={handlers.onRequestRewindPreview}
        onRewind={handlers.onRewindAtGap}
      />
    );
  };

  if (el.kind === "task-panel") {
    return (
      <div className="flex justify-start">
        <div className="max-w-2xl">
          <TodoPanel tasks={el.tasks} />
        </div>
      </div>
    );
  }

  if (el.kind === "tool-group" || el.kind === "subagent" || el.kind === "standalone-tool") {
    return (
      <MessageToolElement
        el={el}
        messages={handlers.messages}
        findPlanContent={handlers.findPlanContent}
        onAnswerQuestion={handlers.onAnswerQuestion}
        onSendFollowUp={handlers.onSendFollowUp}
      />
    );
  }

  const i = el.index;
  const hideTools = el.hideTools;
  const msg = anchor;
  if (!msg) return null;

  const card = renderMessageCard(msg, {
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    onResumeSession: handlers.onResumeSession,
    onSubmitBugReport: handlers.onSubmitBugReport,
    onEgressDecision: handlers.onEgressDecision,
    onResolvePermission: handlers.onResolvePermission,
    onUndoIssueWrite: handlers.onUndoIssueWrite,
    onOpenIssue: handlers.onOpenIssue,
    onSendFollowUp: handlers.onSendFollowUp,
    onReleaseConfirm: handlers.onReleaseConfirm,
    onReleaseCancel: handlers.onReleaseCancel,
    onAgentInterfaceMessage: handlers.onAgentInterfaceMessage,
  });
  if (card) return <>{card}</>;

  const msgMatches = matchesByMessage.get(i) ?? EMPTY_MATCHES;
  const segments = parseMessageSegments(msg.text);
  const hasCodeBlocks = segments.some((s) => s.type === "code");
  const useMarkdown = msg.role === "assistant" && !msg.isError && !msg.notice;

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

                // row) guarantees it never exceeds the column — so long

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
            <Spinner size={12} />
            Queued{msg.queuePosition !== undefined ? ` #${msg.queuePosition}` : ""}
          </div>
        )}
        {useMarkdown ? (

          // bodies, comments, reviews, subagent reports) and must not be

          <MarkdownContent text={msg.text} shipitLinks />
        ) : hasCodeBlocks ? (
          segments.map((seg) => {

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
              const resolvedPlanContent = tool.name === "ExitPlanMode" ? handlers.findPlanContent(i) : undefined;

              const questionDisabled = !!toolResult;
              return (
                <ToolUseItem
                  key={tool.id}
                  tool={tool}
                  result={toolResult}
                  isLast={toolIdx === msg.toolUse!.length - 1}
                  isStreaming={!!msg.streaming}
                  onAnswerQuestion={handlers.onAnswerQuestion}
                  onSendFollowUp={handlers.onSendFollowUp}
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

const EMPTY_MATCHES: SearchMatch[] = [];

export const TranscriptRow = memo(TranscriptRowInner);
TranscriptRow.displayName = "TranscriptRow";
