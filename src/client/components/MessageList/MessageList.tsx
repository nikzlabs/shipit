import { useMemo, useRef, useDeferredValue, type ReactNode } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react";
import type { SearchMatch } from "../../hooks/useSearch.js";
import { buildVisualElements, type VisualElement } from "../visual-elements.js";
import { RewindPoint, type RewindGapAction } from "../RewindPoint.js";
import type { WsRewindPreview, ReleaseMechanism } from "../../../server/shared/types.js";
import { isPlanDocumentWrite } from "../../../server/shared/transcript-input-policy.js";

// Sub-component imports
import { ShipitPointerSessionProvider } from "../message-markdown.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { ChatQuoteReply } from "../ChatQuoteReply.js";
import { extractTurnProse, hasSpeakableProse } from "../../voice/extract-turn-prose.js";

import type { ChatMessage } from "./types.js";
import { useMessageScroll } from "./hooks/useMessageScroll.js";
import type { AnswerQuestionFn } from "../AskUserQuestion.js";
import { SubAgentSpawnChipRow } from "./cards/SubAgentCards.js";
import { TranscriptRow } from "./TranscriptRow.js";
import { RowHandlersProvider, type RowHandlers } from "./row-context.js";
import type { TrackerId } from "../../../server/shared/types.js";
import type { AgentInterfaceProvenance } from "../../../server/shared/agent-interface-sdk/protocol.js";

/** Shared, so "no active search" is the same reference on every render. */
const NO_MATCHES_BY_MESSAGE = new Map<number, SearchMatch[]>();

function defaultSessionNameFor(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || "Fork from here";
}

/** The message a visual element is anchored to (elements come out in transcript order). */
function elementMessageIndex(el: VisualElement): number {
  if (el.kind === "message") return el.index;
  if (el.kind === "tool-group") return el.messageIndices[0] ?? 0;
  return el.messageIndex;
}

/**
 * docs/178 — insert the transient "Compacting…" row at the transcript position
 * the compaction started at, rather than appending it after everything.
 *
 * The indicator used to render after the whole list, so a message the user sent
 * while the compaction was still running (steered into the live turn, or
 * optimistically shown in the window before the server queues it) appeared
 * ABOVE the spinner — reading as if the compaction had started after it. The
 * anchor is the message count captured when `compacting` went true, so every
 * later message sorts below the spinner.
 *
 * A `null` anchor (or one past the end) keeps the old end-of-list placement.
 */
function withCompactingIndicator(
  nodes: ReactNode[],
  elements: VisualElement[],
  anchor: number | null,
  indicator: ReactNode,
): ReactNode[] {
  if (!indicator) return nodes;
  const found = anchor === null ? -1 : elements.findIndex((el) => elementMessageIndex(el) >= anchor);
  const at = found === -1 ? nodes.length : found;
  return [...nodes.slice(0, at), indicator, ...nodes.slice(at)];
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
  onDismissBugReport,
  onResolvePermission,
  onEgressDecision,
  onUndoIssueWrite,
  onOpenIssue,
  onResumeSession,
  onReleaseConfirm,
  onReleaseCancel,
  onAgentInterfaceMessage,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  searchMatches?: SearchMatch[];
  currentMatch?: SearchMatch;
  /** Returns whether the answer actually reached the wire (see `sendUserMessage`). */
  onAnswerQuestion?: AnswerQuestionFn;
  /** Returns whether the message actually reached the wire (see `sendUserMessage`). */
  onSendFollowUp?: (text: string) => boolean;
  rewindPreviews?: Record<string, WsRewindPreview>;
  sessionTitle?: string;
  onRequestRewindPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewindAtGap?: (gapPosition: number, action: RewindGapAction, sessionName?: string) => void;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
  onDismissBugReport?: (cardId: string) => void;
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
    tracker: TrackerId;
    id?: string;
    identifier: string;
    title?: string;
    url?: string;
    /** Comment to scroll to + highlight once the thread lands (planning#105). */
    anchorCommentId?: string;
  }) => void;
  /**
   * Opens a spawned/fork child session. Wraps the router-aware
   * `handleSessionResume`, so the active session switches via the same code
   * path as the sidebar — resetting per-session stores and updating the URL.
   * Without it the SpawnedSessionCard falls back to a bare `setSessionId`,
   * which leaves stale messages and a stale URL (the mobile open-card bug,
   * planning#80).
   */
  onResumeSession?: (sessionId: string) => void;
  /** docs/171 — confirm a proposed release from its inline card. */
  onReleaseConfirm?: (version: string, mechanism: ReleaseMechanism) => void;
  /** docs/171 — cancel a proposed release from its inline card. */
  onReleaseCancel?: (version: string) => void;
  /** docs/280 — dispatch a message an inline presentation composed via the SDK. */
  onAgentInterfaceMessage?: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
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
  // docs/258 — the messages and the session they belong to are deferred as ONE
  // value. Deferring the messages alone would let a click on the outgoing
  // session's still-painted transcript resolve against the incoming session's
  // services; paired, `deferred.sessionId` always describes the messages that
  // are actually on screen.
  const liveSessionId = useSessionStore((s) => s.sessionId);
  const deferred = useDeferredValue(
    useMemo(
      () => ({ messages: messagesProp, sessionId: liveSessionId }),
      [messagesProp, liveSessionId],
    ),
  );
  const messages = deferred.messages;

  const { containerRef, contentRef, currentMatchRef } = useMessageScroll(messages, isLoading, currentMatch);

  const voicePlaybackEnabled = useSettingsStore((s) => s.voicePlaybackEnabled);
  // docs/178 — transient "Compacting…" indicator (emit-only; not persisted).
  // docs/239 — the transcript's owning session; the self merge-watch card's
  // Cancel targets it.
  const activeSessionId = liveSessionId;
  const compacting = useSessionStore((s) => s.compacting);
  const compactingAnchor = useSessionStore((s) => s.compactingAnchor);
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

  // Find plan content for ExitPlanMode tools by searching backward for a Write
  // tool that wrote to a .claude/plans/ path and extracting the file content.
  //
  // This is the one place a Write's *body* is drawn inline in the transcript,
  // with no click and no fetch behind it — which is why docs/244's projection
  // has to exempt exactly these writes. `isPlanDocumentWrite` is the shared
  // predicate both ends use, so neither can quietly change what counts as a plan
  // document (planning#298).
  const findPlanContent = useMemo(() => {
    return (exitPlanMsgIndex: number): string | undefined => {
      for (let i = exitPlanMsgIndex; i >= 0; i--) {
        const tools = messages[i].toolUse;
        if (!tools) continue;
        for (let j = tools.length - 1; j >= 0; j--) {
          const t = tools[j];
          if (isPlanDocumentWrite(t.name, t.input)) {
            return t.input.content as string | undefined;
          }
        }
      }
      return undefined;
    };
  }, [messages]);

  // Group search matches by message index for efficient lookup.
  // Memoized: a fresh Map every render would be a volatile prop on every row,
  // and rows are memoized on exactly this kind of reference (planning#375).
  const matchesByMessage = useMemo(() => {
    // The no-search case returns ONE shared empty Map, so a caller that hands
    // us a fresh empty array cannot invalidate every row. `useSearch` no longer
    // does that, but this prop reaches ~2,000 memoized rows and the failure is
    // silent — a second caller getting it wrong should cost nothing.
    if (!searchMatches || searchMatches.length === 0) return NO_MATCHES_BY_MESSAGE;
    const map = new Map<number, SearchMatch[]>();
    for (const m of searchMatches) {
      const arr = map.get(m.messageIndex) ?? [];
      arr.push(m);
      map.set(m.messageIndex, arr);
    }
    return map;
  }, [searchMatches]);

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
        turnRunning={!currentState && isLoading}
        defaultSessionName={forkDefaultName}
        previews={getPreviewsForGap(gapPosition)}
        onRequestPreview={onRequestRewindPreview}
        onRewind={onRewindAtGap}
      />
    );
  };

  // planning#375 — the previous run is fed back in so unchanged elements come
  // back as the SAME objects, which is what lets `TranscriptRow`'s memo bail
  // out. Held in a ref rather than threaded through the memo's deps: it is an
  // input to the computation, never a reason to redo it.
  const previousElementsRef = useRef<VisualElement[]>([]);
  const visualElements = useMemo(() => {
    const next = buildVisualElements(messages, previousElementsRef.current);
    previousElementsRef.current = next;
    return next;
  }, [messages]);

  // Per-row values the row cannot derive without `messages` (which it never
  // takes as a prop). Both are primitives, so they cost the row's memo nothing.
  const rowHandlers: RowHandlers = {
    messages,
    findPlanContent,
    onAnswerQuestion,
    onSendFollowUp,
    onSubmitBugReport,
    onDismissBugReport,
    onResolvePermission,
    onEgressDecision,
    onUndoIssueWrite,
    onOpenIssue,
    onResumeSession,
    onReleaseConfirm,
    onReleaseCancel,
    onAgentInterfaceMessage,
    onRequestRewindPreview,
    onRewindAtGap,
  };

  // Gate on isLoading: a compaction only ever runs mid-turn, so the transient
  // "Compacting…" indicator should never outlive the turn. This backstops any
  // path that leaves the global `compacting` flag stuck true after the turn
  // ended (e.g. a reconnect that replayed a buffered `compaction_status
  // active:true` without a balancing clear).
  const compactingIndicator =
    compacting && isLoading ? (
      <div key="compacting-indicator" className="flex justify-start" data-testid="compacting-indicator">
        <div className="flex items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs text-(--color-text-secondary)">
          <CircleNotchIcon size={14} className="animate-spin text-(--color-text-tertiary)" />
          Compacting context…
        </div>
      </div>
    ) : null;

  return (
    <ShipitPointerSessionProvider value={deferred.sessionId ?? null}>
    <RowHandlersProvider value={rowHandlers}>
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4"
    >
    {/* The messages live in their own element rather than directly in the
        scroll container, so that one ResizeObserver on it reports every change
        in the transcript's height — the scroll container's own box never
        changes when its content grows. `useMessageScroll` uses that to stay
        pinned to the bottom while a message paints; see the hook. The spacing
        and content-visibility utilities move with the messages, so the elements
        they apply to are unchanged. */}
    <div
      ref={contentRef}
      className="space-y-3 sm:space-y-2 [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_5rem]"
    >
      {/* planning#12 — floating "Reply" button shown when the user highlights text
          inside a message bubble; quotes the passage into the composer. Scoped
          to this scroll container via the ref so it never fires on the composer
          or other panels. */}
      <ChatQuoteReply containerRef={containerRef} />
      {withCompactingIndicator(visualElements.map((el) => {
        // planning#375 — every row is a memoized `TranscriptRow`. This callback
        // must therefore hand it only values that stay referentially stable
        // while the row is unchanged; anything volatile goes through
        // `RowHandlersProvider` instead. Adding a prop here that is rebuilt each
        // render silently restores the 92 ms whole-transcript re-render.
        const anchorIndex = elementMessageIndex(el);
        const key =
          el.kind === "task-panel" ? "task-panel"
          : el.kind === "tool-group" ? `tg-${el.messageIndices[0]}`
          : el.kind === "subagent" ? el.tool.id
          : el.kind === "standalone-tool" ? `st-${el.tool.id}`
          : `m-${el.index}`;
        const isBubble = el.kind === "message";
        return (
          <TranscriptRow
            key={key}
            el={el}
            anchor={messages[anchorIndex]}
            matchesByMessage={matchesByMessage}
            currentMatch={currentMatch}
            currentMatchRef={currentMatchRef}
            isLoading={isLoading}
            voicePlaybackEnabled={voicePlaybackEnabled}
            turnProse={isBubble ? turnProseByLastIndex.get(el.index) : undefined}
            activeSessionId={activeSessionId}
            hasRewindControls={hasRewindControls}
            forkDefaultName={forkDefaultName}
            rewindPreviews={rewindPreviews}
            showGapBefore={isBubble && shouldShowGapBefore(el.index)}
            gapPreviousRole={isBubble ? previousRoleBefore(el.index) : null}
          />
        );
      }), visualElements, compactingAnchor, compactingIndicator)}

      {/*
        planning#280 — the durable pending consult card (inline, at the call site) is
        now the primary in-flight surface. The transient chip is only shown for a
        spawn that has no card in the transcript yet, so the two can never render
        two spinners for the same consult.
      */}
      {Object.values(subAgentSpawns)
        .filter((chip) => !messages.some((m) => m.subAgentConsult?.spawnId === chip.spawnId))
        .map((chip) => (
          <SubAgentSpawnChipRow key={chip.spawnId} chip={chip} />
        ))}

      {!isLoading && messages.length > 0 && renderRewindPoint(messages.length, true)}
    </div>
    </div>
    </RowHandlersProvider>
    </ShipitPointerSessionProvider>
  );
}
