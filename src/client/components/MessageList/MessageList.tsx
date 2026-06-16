import { Fragment, useMemo, useDeferredValue } from "react";
import { TodoPanel, type TodoItem } from "../TodoPanel.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import type { SearchMatch } from "../../hooks/useSearch.js";
import { buildVisualElements } from "../visual-elements.js";
import { RewindPoint, type RewindGapAction } from "../RewindPoint.js";
import type { WsRewindPreview } from "../../../server/shared/types.js";

// Sub-component imports
import { ToolUseItem } from "../message-tools.js";
import { parseMessageSegments, MarkdownContent, CodeBlock } from "../message-markdown.js";
import { getSegmentMatches, HighlightedText } from "../message-highlighting.js";
import { MessageFileAttachments, MessageImages } from "../message-media.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { PlayTurnButton } from "../PlayTurnButton.js";
import { ChatQuoteReply } from "../ChatQuoteReply.js";
import { extractTurnProse, hasSpeakableProse } from "../../voice/extract-turn-prose.js";

import type { ChatMessage } from "./types.js";
import { useMessageScroll } from "./hooks/useMessageScroll.js";
import { MessageToolElement } from "./MessageToolUse.js";
import { renderMessageCard } from "./cards/MessageCards.js";
import { SubAgentSpawnChipRow } from "./cards/SubAgentCards.js";

function defaultSessionNameFor(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || "Fork from here";
}

export function MessageList({
  messages: messagesProp,
  isLoading,
  searchMatches,
  currentMatch,
  onAnswerQuestion,
  onSendFollowUp,
  rewindPreviews,
  sessionTitle,
  onRequestRewindPreview,
  onRewindAtGap,
  onSubmitBugReport,
  onResolvePermission,
  onEgressDecision,
  onUndoIssueWrite,
  onOpenIssue,
  onResumeSession,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>, text: string) => void;
  onSendFollowUp?: (text: string) => void;
  rewindPreviews?: Record<string, WsRewindPreview>;
  sessionTitle?: string;
  onRequestRewindPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewindAtGap?: (gapPosition: number, action: RewindGapAction, sessionName?: string) => void;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
  /** docs/193 — answer a permission request (approve/deny + remember). */
  onResolvePermission?: (requestId: string, behavior: "allow" | "deny", remember?: boolean) => void;
  /** docs/172 — resolve an egress allow-once card (allow-once / add / deny). */
  onEgressDecision?: (cardId: string, host: string, action: "allow-once" | "add" | "deny") => void;
  /** docs/177 — undo a recorded issue write (fires a reverse brokered write). */
  onUndoIssueWrite?: (cardId: string) => void;
  /**
   * docs/189 — open an issue's inline detail view from a chat card (read or
   * write). Switches the right panel to the Issues tab and loads the issue.
   */
  onOpenIssue?: (ref: {
    tracker: "linear" | "github";
    id?: string;
    identifier: string;
    title?: string;
    url?: string;
    /** Comment to scroll to + highlight once the thread lands (SHI-103). */
    anchorCommentId?: string;
  }) => void;
  /**
   * Opens a spawned/fork child session. Wraps the router-aware
   * `handleSessionResume`, so the active session switches via the same code
   * path as the sidebar — resetting per-session stores and updating the URL.
   * Without it the SpawnedSessionCard falls back to a bare `setSessionId`,
   * which leaves stale messages and a stale URL (the mobile open-card bug,
   * SHI-78).
   */
  onResumeSession?: (sessionId: string) => void;
}) {
  const hasRewindControls = !!onRewindAtGap;

  // Coalesce streaming re-renders. The agent appends to the streaming message
  // once per token (a separate WS macrotask each), so `messagesProp` changes
  // dozens of times a second during a turn. `useDeferredValue` lets React
  // render this heavy transcript at a lower priority: under a burst it skips
  // intermediate values and re-parses the streaming message's markdown once
  // per painted frame instead of once per token, always converging to the
  // latest text at the trailing edge. Combined with the per-message
  // `MarkdownContent` memo, this turns the old O(messages × tokens) parse
  // storm into roughly O(frames). WS delivery is untouched, so no message is
  // dropped — only the render cadence is throttled.
  const messages = useDeferredValue(messagesProp);

  const { containerRef, currentMatchRef } = useMessageScroll(messages, isLoading, currentMatch);

  const voicePlaybackEnabled = useSettingsStore((s) => s.voicePlaybackEnabled);
  // docs/178 — transient "Compacting…" indicator (emit-only; not persisted).
  const compacting = useSessionStore((s) => s.compacting);
  // docs/144 — transient sub-agent spawn chips (emit-only; not persisted).
  const subAgentSpawns = useSessionStore((s) => s.subAgentSpawns);

  // Per-completed-turn Play button (docs/144). A "turn" is the run of
  // assistant messages between one user message and the next. We mark the
  // LAST assistant message of each *complete* turn (not streaming) with the
  // concatenated, speakable prose to read aloud; the footer renders Play
  // there. Turns that are entirely tool calls (no speakable prose) are
  // skipped so the button doesn't appear on a tool-only turn.
  const turnProseByLastIndex = useMemo(() => {
    const map = new Map<number, string>();
    if (!voicePlaybackEnabled) return map;
    let runStart = -1; // index of first assistant message in the current run
    const flush = (lastAssistantIdx: number) => {
      if (lastAssistantIdx < 0 || runStart < 0) return;
      const last = messages[lastAssistantIdx];
      if (last.streaming) return; // turn still being written — no Play yet
      const prose = extractTurnProse(messages.slice(runStart, lastAssistantIdx + 1));
      if (prose && hasSpeakableProse(prose)) map.set(lastAssistantIdx, prose);
    };
    let lastAssistantIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const isProseAssistant = m.role === "assistant" && !m.isError && !m.notice;
      if (isProseAssistant) {
        if (runStart < 0) runStart = i;
        lastAssistantIdx = i;
      } else if (m.role === "user") {
        flush(lastAssistantIdx);
        runStart = -1;
        lastAssistantIdx = -1;
      }
    }
    flush(lastAssistantIdx);
    return map;
  }, [messages, voicePlaybackEnabled]);

  const lastTodoWriteId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const tools = messages[i].toolUse;
      if (tools) {
        for (let j = tools.length - 1; j >= 0; j--) {
          if (tools[j].name === "TodoWrite") return tools[j].id;
        }
      }
    }
    return null;
  }, [messages]);

  // Find plan content for ExitPlanMode tools by searching backward for a Write
  // tool that wrote to a .claude/plans/ path and extracting the file content.
  const findPlanContent = useMemo(() => {
    return (exitPlanMsgIndex: number): string | undefined => {
      for (let i = exitPlanMsgIndex; i >= 0; i--) {
        const tools = messages[i].toolUse;
        if (!tools) continue;
        for (let j = tools.length - 1; j >= 0; j--) {
          const t = tools[j];
          if (t.name === "Write" && typeof t.input.file_path === "string" && t.input.file_path.includes(".claude/plans/")) {
            return t.input.content as string | undefined;
          }
        }
      }
      return undefined;
    };
  }, [messages]);

  // Group search matches by message index for efficient lookup
  const matchesByMessage = new Map<number, SearchMatch[]>();
  if (searchMatches) {
    for (const m of searchMatches) {
      const arr = matchesByMessage.get(m.messageIndex) ?? [];
      arr.push(m);
      matchesByMessage.set(m.messageIndex, arr);
    }
  }

  const getPreview = (gapPosition: number, action: RewindGapAction): WsRewindPreview | undefined =>
    rewindPreviews?.[`${gapPosition}:${action}`];

  const getPreviewsForGap = (gapPosition: number): Partial<Record<RewindGapAction, WsRewindPreview>> => ({
    chat: getPreview(gapPosition, "chat"),
    code: getPreview(gapPosition, "code"),
    both: getPreview(gapPosition, "both"),
    fork: getPreview(gapPosition, "fork"),
  });

  const forkDefaultName = sessionTitle
    ? defaultSessionNameFor(`Forked: ${sessionTitle}`)
    : defaultSessionNameFor("Fork from here");

  const shouldShowGapBefore = (messageIndex: number): boolean => {
    if (!hasRewindControls) return false;
    const current = messages[messageIndex];
    if (!current || current.notice || current.rolledBack) return false;
    for (let i = messageIndex - 1; i >= 0; i--) {
      const previous = messages[i];
      if (previous.notice) continue;
      return previous.role !== current.role;
    }
    return false;
  };

  // Role of the turn that just finished at this gap — drives the rewind
  // handle's side: right after a user turn, left after an agent turn.
  const previousRoleBefore = (gapPosition: number): "user" | "assistant" | null => {
    for (let i = gapPosition - 1; i >= 0; i--) {
      const previous = messages[i];
      if (previous.notice) continue;
      return previous.role;
    }
    return null;
  };

  const renderRewindPoint = (gapPosition: number, currentState = false) => {
    if (!hasRewindControls || !onRewindAtGap) return null;
    const previousRole = previousRoleBefore(gapPosition);
    const align = previousRole === "user" ? "right" : previousRole === "assistant" ? "left" : "center";
    return (
      <RewindPoint
        gapPosition={gapPosition}
        currentState={currentState}
        align={align}
        disabled={!currentState && isLoading}
        defaultSessionName={forkDefaultName}
        previews={getPreviewsForGap(gapPosition)}
        onRequestPreview={onRequestRewindPreview}
        onRewind={onRewindAtGap}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-2 [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_5rem]"
    >
      {/* SHI-10 — floating "Reply" button shown when the user highlights text
          inside a message bubble; quotes the passage into the composer. Scoped
          to this scroll container via the ref so it never fires on the composer
          or other panels. */}
      <ChatQuoteReply containerRef={containerRef} />
      {buildVisualElements(messages).map((el) => {
        // ── Tool-derived elements: grouped tool calls, standalone subagents,
        //    and standalone tools (ExitPlanMode / AskUserQuestion / present) ──
        if (el.kind === "tool-group" || el.kind === "subagent" || el.kind === "standalone-tool") {
          const key =
            el.kind === "tool-group" ? `tg-${el.messageIndices[0]}`
            : el.kind === "subagent" ? el.tool.id
            : `st-${el.tool.id}`;
          return (
            <MessageToolElement
              key={key}
              el={el}
              messages={messages}
              findPlanContent={findPlanContent}
              onAnswerQuestion={onAnswerQuestion}
              onSendFollowUp={onSendFollowUp}
            />
          );
        }

        // ── Message bubble ──
        const i = el.index;
        const hideTools = el.hideTools;
        const msg = messages[i];

        // Inline transcript cards (spawned session, review, voice note,
        // permission/egress/issue prompts, etc.) carry no chat text of their
        // own — render the card and skip the bubble path. Order is preserved
        // verbatim inside `renderMessageCard`.
        const card = renderMessageCard(msg, {
          onResumeSession,
          onSubmitBugReport,
          onEgressDecision,
          onResolvePermission,
          onUndoIssueWrite,
          onOpenIssue,
          onSendFollowUp,
        });
        if (card) return <Fragment key={i}>{card}</Fragment>;

        const msgMatches = matchesByMessage.get(i) ?? [];
        const segments = parseMessageSegments(msg.text);
        const hasCodeBlocks = segments.some((s) => s.type === "code");
        const useMarkdown = msg.role === "assistant" && !msg.isError && !msg.notice;
        const latestTodoTool = msg.toolUse?.find((t) => t.name === "TodoWrite" && t.id === lastTodoWriteId);
        // Hide the bubble when it would be empty (no text/images/files
        // and every tool is a TodoWrite, which renders as null inside the bubble)
        const hasVisibleTools = !hideTools && msg.toolUse?.some((t) => t.name !== "TodoWrite");
        const hideBubble = !msg.text && !msg.images?.length && !msg.files?.length && !hasVisibleTools && !!msg.toolUse?.length;

        return (
          <Fragment key={i}>
            {shouldShowGapBefore(i) && renderRewindPoint(i)}
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
                  ? "max-w-full rounded-lg px-4 py-3 break-words min-w-0"
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
              {msg.queued && (
                <div className="flex items-center gap-1.5 mb-1.5 text-xs text-(--color-accent-text)/80 font-medium">
                  <CircleNotchIcon size={12} className="animate-spin" />
                  Queued{msg.queuePosition !== undefined ? ` #${msg.queuePosition}` : ""}
                </div>
              )}
              {useMarkdown ? (
                <MarkdownContent text={msg.text} />
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
                    const resolvedPlanContent = tool.name === "ExitPlanMode" ? findPlanContent(i) : undefined;
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
                        onAnswerQuestion={onAnswerQuestion}
                        onSendFollowUp={onSendFollowUp}
                        isQuestionDisabled={questionDisabled}
                        planContent={resolvedPlanContent}
                      />
                    );
                  })}
                </div>
              )}

              {voicePlaybackEnabled && turnProseByLastIndex.has(i) && (
                <div className="mt-1.5 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <PlayTurnButton turnId={msg.commitHash ?? `turn-${i}`} text={turnProseByLastIndex.get(i)!} />
                </div>
              )}
            </div>
            </div>
            )}
            {latestTodoTool && Array.isArray(latestTodoTool.input.todos) && (
              <div className="flex justify-start">
                <div className="max-w-2xl">
                  <TodoPanel todos={latestTodoTool.input.todos as TodoItem[]} />
                </div>
              </div>
            )}
          </Fragment>
        );
      })}

      {compacting && (
        <div className="flex justify-start" data-testid="compacting-indicator">
          <div className="flex items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs text-(--color-text-secondary)">
            <CircleNotchIcon size={14} className="animate-spin text-(--color-text-tertiary)" />
            Compacting context…
          </div>
        </div>
      )}

      {Object.values(subAgentSpawns).map((chip) => (
        <SubAgentSpawnChipRow key={chip.spawnId} chip={chip} />
      ))}

      {!isLoading && messages.length > 0 && renderRewindPoint(messages.length, true)}
    </div>
  );
}
