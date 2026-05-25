// eslint-disable-next-line no-restricted-imports -- useEffect: DOM scroll sync (scrollIntoView), window keydown listener, xterm auto-scroll
import { Fragment, useMemo, useEffect, useRef } from "react";
import {
  TypingDots,
} from "./StreamingIndicator.js";
import { TodoPanel, type TodoItem } from "./TodoPanel.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import type { SearchMatch } from "../hooks/useSearch.js";
import { buildVisualElements } from "./visual-elements.js";
import { RewindPoint, type RewindGapAction } from "./RewindPoint.js";
import type { WsRewindPreview } from "../../server/shared/types.js";

// Sub-component imports
import { ToolCallGroup, ToolUseItem } from "./message-tools.js";
import { parseMessageSegments, MarkdownContent, MarkdownTooltip, CodeBlock } from "./message-markdown.js";
import { getSegmentMatches, HighlightedText } from "./message-highlighting.js";
import { MessageFileAttachments, MessageImages } from "./message-media.js";
import { SubagentCall } from "./SubagentCall.js";
import { SpawnedSessionCard } from "./SpawnedSessionCard.js";
import { SpawnFailedCard } from "./SpawnFailedCard.js";
import { AgentReviewCard } from "./AgentReviewCard.js";
import { UserReviewCard } from "./UserReviewCard.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";

// ── Type exports (kept here as the canonical location for backward compat) ──

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * A single nested event emitted by a subagent (Claude's Task tool). Each entry
 * carries `parentToolUseId` linking it back to a tool_use block in the parent
 * message's `toolUse` list. Used for subagent transparency (109).
 */
export type SubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: ToolUseBlock[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: ToolResultBlock[];
    };

export interface ChatMessageImage {
  data: string;      // base64-encoded image data
  mediaType: string; // "image/png", etc.
  /** Optional pre-built src URL (e.g. blob: URL for optimistic messages). When set, used directly instead of building a data: URI from data+mediaType. */
  src?: string;
}

export interface ChatMessageFile {
  path: string;
  contentPreview: string;
  startLine?: number;
  endLine?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  images?: ChatMessageImage[];
  files?: ChatMessageFile[];
  streaming?: boolean;
  /** When true, this message represents an error (CLI crash, WS drop, etc.) */
  isError?: boolean;
  /**
   * When true, this is an informational system note (docs/138) — e.g. a
   * guarded-mode fallback or a summary of classifier-blocked actions. Rendered
   * as a muted, full-width inline note, distinct from both normal assistant
   * text and the red error style. `noticeLevel` tints warnings.
   */
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  /** When true, this message is queued and waiting for Claude to become available. */
  queued?: boolean;
  /** 1-indexed position in the queue, shown as a badge. */
  queuePosition?: number;
  /**
   * docs/150 — set on optimistic user bubbles created by the HTTP dispatch
   * helper (Create PR, Send compose error, etc.). When the matching
   * `system_user_message` echo arrives over the WS, the handler dedupes by
   * clearing this flag in place instead of appending a duplicate bubble.
   * Survives a tab reload via the normal optimistic-state lifecycle (the
   * dispatch completes before reload anyway; this flag is only meaningful
   * within the same session).
   */
  pendingDispatch?: true;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  /** When true, this message was rolled back and should appear dimmed. */
  rolledBack?: boolean;
  codeRollbackHash?: string;
  forkChild?: {
    childSessionId: string;
    title: string;
    branch: string;
  };
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The renderer groups these by `parentToolUseId` and
   * displays them as a nested tree under the parent Task call (109).
   */
  subagentEvents?: SubagentEvent[];
  /**
   * docs/117 Phase 2 — when set, this message renders a `SpawnedSessionCard`
   * inline in the parent's chat. Populated from `session_spawned` WS events
   * (and, eventually, from chat-history reload). The card surfaces the
   * child's title, branch, and an "Open" button that switches the active
   * session. We deliberately do not persist this in v1: the child is also
   * visible in the sidebar via the existing `session_list` broadcast, which
   * survives reload, so a missing card after refresh is not data-loss.
   */
  spawnedSession?: {
    childSessionId: string;
    title: string;
    branch?: string;
    spawnedAt: string;
  };
  /**
   * docs/117 cross-cutting follow-up — when set, this message renders a
   * `SpawnFailedCard` inline in the parent's chat. Populated from
   * `session_spawn_failed` WS events. Counterpart to `spawnedSession` for the
   * failure path so a quota / invalid-branch rejection is visible alongside
   * successful spawns instead of only on the shim's stderr.
   */
  spawnFailed?: {
    title?: string;
    branch?: string;
    reason:
      | "quota_per_turn"
      | "quota_per_parent"
      | "invalid_request"
      | "parent_missing"
      | "error";
    message: string;
    statusCode: number;
    promptPreview?: string;
    failedAt: string;
  };
  /**
   * docs/151 — when set, this message renders an `AgentReviewCard` inline in
   * the chat. Populated from `agent_review_added` WS events. The card opens
   * the file in snapshot-mode FilePreviewModal so pins line up with what the
   * reviewer saw. The full snapshot + comment list is fetched lazily on click.
   */
  agentReview?: {
    reviewId: string;
    filePath: string;
    fileType: "markdown" | "code";
    findingCount: number;
    snapshotHash: string;
    summary?: string;
    createdAt: string;
  };
  /**
   * User-side counterpart to `agentReview`: when the user submits comments on
   * a doc or diff, the optimistic user bubble carries this payload so the
   * chat renders a dedicated `UserReviewCard` (header + comment count +
   * collapsed prompt disclosure) instead of dumping the raw prompt as a
   * plain text bubble. Without this, the "Send comments" button looked like
   * it did nothing — the agent silently kicked off with no preceding user
   * card and no spinner.
   */
  userReview?: {
    /** Files the comments are anchored to (empty for multi-file diffs). */
    filePaths: string[];
    /** Number of comments included in the submission. */
    commentCount: number;
  };
}

export interface TextSegment {
  type: "text";
  content: string;
  offset: number;
}

export interface CodeSegment {
  type: "code";
  content: string;
  language: string;
  offset: number;
}

export type MessageSegment = TextSegment | CodeSegment;

// ── Re-exports from sub-modules (barrel for backward compatibility) ──

export { ToolCallGroup, ToolUseItem, ToolProgressBar } from "./message-tools.js";
export { parseMessageSegments, MarkdownContent, MarkdownTooltip, CodeBlock } from "./message-markdown.js";
export { getSegmentMatches, HighlightedText } from "./message-highlighting.js";
export { MessageEditor } from "./message-editor.js";
export { MessageFileAttachments, MessageImages } from "./message-media.js";

export { buildVisualElements, STANDALONE_TOOLS, SUBAGENT_TOOLS, type VisualElement } from "./visual-elements.js";

function slugifyBranchName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "fork-from-here";
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
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void;
  onSendFollowUp?: (text: string) => void;
  rewindPreviews?: Record<string, WsRewindPreview>;
  sessionTitle?: string;
  onRequestRewindPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewindAtGap?: (gapPosition: number, action: RewindGapAction, branchName?: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const currentMatchRef = useRef<HTMLElement | null>(null);
  const hasRewindControls = !!onRewindAtGap;

  const messages = messagesProp;

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

  // Track whether the user has scrolled away from the bottom
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Consider "at bottom" if within 40px of the end
      autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll to bottom only if user hasn't scrolled up.
  // Skip while the user has an active selection inside the message list —
  // otherwise streaming tokens trigger scrollIntoView on every render and
  // continuously cancel the in-progress text selection.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (
      sel &&
      !sel.isCollapsed &&
      containerRef.current &&
      sel.anchorNode &&
      containerRef.current.contains(sel.anchorNode)
    ) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, isLoading]);

  // Scroll to the current search match when it changes
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (currentMatch && currentMatchRef.current) {
      currentMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatch]);

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

  const defaultBranchNameForGap = (gapPosition: number): string => {
    for (let i = Math.min(gapPosition, messages.length) - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (!candidate.notice && candidate.role === "user" && candidate.text.trim()) {
        return slugifyBranchName(candidate.text);
      }
    }
    return slugifyBranchName(sessionTitle ?? "fork-from-here");
  };

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

  const renderRewindPoint = (gapPosition: number, currentState = false) => {
    if (!hasRewindControls || !onRewindAtGap) return null;
    return (
      <RewindPoint
        gapPosition={gapPosition}
        currentState={currentState}
        disabled={!currentState && isLoading}
        defaultBranchName={defaultBranchNameForGap(gapPosition)}
        previews={getPreviewsForGap(gapPosition)}
        onRequestPreview={onRequestRewindPreview}
        onRewind={onRewindAtGap}
      />
    );
  };

  return (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-2">
      {buildVisualElements(messages).map((el, elIdx, allElements) => {
        // ── Tool-group: grouped tool calls from consecutive assistant messages ──
        if (el.kind === "tool-group") {
          return (
            <div key={`tg-${el.messageIndices[0]}`}>
              <ToolCallGroup items={el.items} isStreaming={el.streaming} />
            </div>
          );
        }

        // ── Subagent: standalone Task/Skill/Agent element with left border ──
        if (el.kind === "subagent") {
          const tool = el.tool;
          const parentMsg = messages[el.messageIndex];
          if (tool.name === "Task") {
            // Full transparency view — prompt, work timeline, final report (109)
            return (
              <SubagentCall
                key={tool.id}
                tool={tool}
                subagentEvents={parentMsg?.subagentEvents}
                parentToolResults={parentMsg?.toolResults}
                isStreaming={el.streaming}
              />
            );
          }
          if (tool.name === "Agent") {
            const description = (tool.input.description as string) ?? "Running agent...";
            const subagentType = typeof tool.input.subagent_type === "string" ? tool.input.subagent_type : "";
            const prompt = typeof tool.input.prompt === "string" ? tool.input.prompt : "";
            const label = subagentType ? `Agent (${subagentType}):` : "Agent:";
            return (
              <div key={tool.id} data-testid="subagent-agent" className="border-l-2 border-(--color-success)/40 pl-3 space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-semibold text-(--color-success)">{label}</span>
                  <span className="text-(--color-text-primary)">{description}</span>
                </div>
                {prompt && (
                  <MarkdownTooltip content={prompt}>
                    <div className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap overflow-hidden max-h-15 leading-5">{prompt}</div>
                  </MarkdownTooltip>
                )}
              </div>
            );
          }
          // Skill
          const skillName = (tool.input.skill as string) ?? "unknown";
          const args = tool.input.args ? (tool.input.args as string) : "";
          return (
            <div key={tool.id} data-testid="subagent-skill" className="border-l-2 border-(--color-success)/40 pl-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-(--color-success)">Skill:</span>
                <span className="text-(--color-text-primary)">{skillName}</span>
                {args && <span className="text-(--color-text-secondary) truncate max-w-xs">{args}</span>}
              </div>
            </div>
          );
        }

        // ── Standalone tool: ExitPlanMode or AskUserQuestion extracted from an empty-text message ──
        if (el.kind === "standalone-tool") {
          // AskUserQuestion / ExitPlanMode block the agent waiting for user
          // input, so the surrounding message keeps `streaming`/`isLoading`
          // true while the prompt is on screen — those flags would dismiss
          // every click. We also can't gate on `isLastMessage`: when Claude
          // continues to emit more content (text or other tool_use blocks)
          // alongside the question, or when the user's answer appends a
          // user-message after the question, the question's message stops
          // being last while the prompt has not yet been answered. That
          // would silently drop the user's click.
          //
          // The right gate is whether the tool itself has been resolved —
          // `el.result` is set once the agent emits a tool_result for it.
          // The AskUserQuestion / PlanApproval components track their own
          // submitted state internally, so leaving `disabled=false` here
          // and feeding them `result` lets them render the answered state
          // correctly even after a page reload (where local state is lost).
          const questionDisabled = !!el.result;
          const resolvedPlanContent = el.tool.name === "ExitPlanMode" ? findPlanContent(el.messageIndex) : undefined;
          return (
            <div key={`st-${el.tool.id}`}>
              <ToolUseItem
                tool={el.tool}
                result={el.result}
                isLast
                isStreaming={el.streaming}
                onAnswerQuestion={onAnswerQuestion}
                onSendFollowUp={onSendFollowUp}
                isQuestionDisabled={questionDisabled}
                planContent={resolvedPlanContent}
              />
            </div>
          );
        }

        // ── Message bubble ──
        const i = el.index;
        const hideTools = el.hideTools;
        const msg = messages[i];

        if (msg.forkChild) {
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-2xl w-full">
                <SpawnedSessionCard
                  childSessionId={msg.forkChild.childSessionId}
                  title={msg.forkChild.title}
                  branch={msg.forkChild.branch}
                  spawnedAt={new Date().toISOString()}
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
            <div key={i} className="flex justify-start">
              <div className="max-w-2xl w-full">
                <SpawnedSessionCard
                  childSessionId={msg.spawnedSession.childSessionId}
                  title={msg.spawnedSession.title}
                  {...(msg.spawnedSession.branch ? { branch: msg.spawnedSession.branch } : {})}
                  spawnedAt={msg.spawnedSession.spawnedAt}
                />
              </div>
            </div>
          );
        }

        // docs/151 — agent review marker carries no chat text of its own;
        // render the inline `AgentReviewCard` and skip the bubble path. The
        // card's open action triggers a lazy fetch of the snapshot + comments
        // via the file-store, opening the modal in agent-review mode.
        if (msg.agentReview) {
          const sid = useSessionStore.getState().sessionId;
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-2xl w-full">
                <AgentReviewCard
                  reviewId={msg.agentReview.reviewId}
                  filePath={msg.agentReview.filePath}
                  findingCount={msg.agentReview.findingCount}
                  snapshotHash={msg.agentReview.snapshotHash}
                  {...(msg.agentReview.summary ? { summary: msg.agentReview.summary } : {})}
                  createdAt={msg.agentReview.createdAt}
                  onOpen={(reviewId) => {
                    if (!sid) return;
                    void useFileStore.getState().openAgentReview(sid, reviewId);
                  }}
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
            <div key={i} className="flex justify-end">
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
        // hit / invalid branch is visible alongside successful spawns.
        if (msg.spawnFailed) {
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-2xl w-full">
                <SpawnFailedCard
                  {...(msg.spawnFailed.title ? { title: msg.spawnFailed.title } : {})}
                  {...(msg.spawnFailed.branch ? { branch: msg.spawnFailed.branch } : {})}
                  reason={msg.spawnFailed.reason}
                  message={msg.spawnFailed.message}
                  statusCode={msg.spawnFailed.statusCode}
                  {...(msg.spawnFailed.promptPreview ? { promptPreview: msg.spawnFailed.promptPreview } : {})}
                  failedAt={msg.spawnFailed.failedAt}
                />
              </div>
            </div>
          );
        }

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
                segments.map((seg, segIdx) => {
                  if (seg.type === "code") {
                    return (
                      <CodeBlock
                        key={segIdx}
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
                    <span key={segIdx} className="whitespace-pre-wrap">
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

              {msg.streaming && allElements[elIdx + 1]?.kind !== "tool-group" && !latestTodoTool && (
                <span className="inline-flex items-center ml-1 align-middle">
                  <TypingDots />
                </span>
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

      {!isLoading && messages.length > 0 && renderRewindPoint(messages.length, true)}
      <div ref={bottomRef} />
    </div>
  );
}
