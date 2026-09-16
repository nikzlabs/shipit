import { Fragment, useMemo, useRef, useDeferredValue, type ReactNode } from "react";
import { CompactLayout } from "./CompactLayout.js";
import { useCompactConversation } from "./hooks/useCompactConversation.js";
import { elementLastMessageIndex, elementMessageIndex } from "./compact-turns.js";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { Button } from "../ui/button.js";
import { ICON_SIZE } from "../../design-tokens.js";
import type { SearchMatch } from "../../hooks/useSearch.js";
import { buildVisualElements, type VisualElement } from "../visual-elements.js";
import { RewindPoint, type RewindGapAction } from "../RewindPoint.js";
import type { WsRewindPreview, ReleaseMechanism } from "../../../server/shared/types.js";
import { isPlanDocumentWrite } from "../../../server/shared/transcript-input-policy.js";

import { ShipitPointerSessionProvider } from "../message-markdown.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { ChatQuoteReply } from "../ChatQuoteReply.js";
import { SessionStatusCard } from "../SessionStatusCard.js";
import { extractTurnProse, hasSpeakableProse } from "../../voice/extract-turn-prose.js";

import type { ChatMessage } from "./types.js";
import { useMessageScroll } from "./hooks/useMessageScroll.js";
import type { AnswerQuestionFn } from "../AskUserQuestion.js";
import { SubAgentSpawnChipRow } from "./cards/SubAgentCards.js";
import { TranscriptRow, CodeRollbackNotice } from "./TranscriptRow.js";
import { RowHandlersProvider, type RowHandlers } from "./row-context.js";
import type { TrackerId } from "../../../server/shared/types.js";
import type { AgentInterfaceProvenance } from "../../../server/shared/agent-interface-sdk/protocol.js";

const NO_MATCHES_BY_MESSAGE = new Map<number, SearchMatch[]>();

function defaultSessionNameFor(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || "Fork from here";
}

/**
 * planning#491 — how many rows share one `content-visibility: auto` element.
 *
 * Chrome keeps an internal IntersectionObserver for every such element, and its
 * per-frame cost scales with how many there are. Measured on the REAL component
 * over 803 messages (`scripts/fixtures/transcript-highlight-probe.*` at
 * `?turns=400`), two runs each, one-per-row against one-per-20:
 *
 *   while an indicator animates   56.2 ms/s   ->  10.0 / 10.2 ms/s
 *   6 s full-transcript scroll    482/501 ms  ->  339 / 346 ms
 *   first paint                   no systematic difference
 *
 * The animating row is the big one, and it is not what the issue was filed for:
 * every scheduled frame runs the intersection pass over every element carrying
 * containment, so this pays back once per frame. (A synthetic fixture predicted
 * 7-11x on scroll; the real component gives ~30%, because a real scroll is
 * dominated by rendering rich rows rather than by intersections.)
 *
 * 50 measured slightly better again on the synthetic sweep, and 20 is the
 * conservative pick: a group is the unit that gets skipped, so a smaller one
 * wastes less layout when only part of it is off screen.
 */
const ROWS_PER_GROUP = 20;

const ROW_PLACEHOLDER_REM = 5;

const ROW_GAP_REM = 0.5;

/**
 * docs/303-session-status-card req 30 — how much of the conversation was
 * settled when a turn started.
 *
 * Trailing user rows belong to the turn that is starting, and trimming them
 * makes the anchor independent of whether the store appends the user's row
 * before or after it sets `isLoading`, so the user's own message always renders
 * below the card. A trailing STREAMING row is trimmed for a different reason: a
 * viewer joining mid-turn freezes on what it has, and a streaming row goes on
 * growing in place rather than appending, so counting it settled would leave
 * the turn's own text above the card.
 */
function settledMessageCount(messages: ChatMessage[]): number {
  let count = messages.length;
  while (count > 0) {
    const message = messages[count - 1];
    if (message.role !== "user" && !message.streaming) break;
    count--;
  }
  return count;
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
  onSettingsProposalDecision,
  onUndoIssueWrite,
  onStartRepoSession,
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

  onAnswerQuestion?: AnswerQuestionFn;

  onSendFollowUp?: (
    text: string,
    options?: { actionChecklistCardId?: string; sessionStatusOfferIds?: string[] },
  ) => boolean;
  rewindPreviews?: Record<string, WsRewindPreview>;
  sessionTitle?: string;
  onRequestRewindPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewindAtGap?: (gapPosition: number, action: RewindGapAction, sessionName?: string) => void;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
  onDismissBugReport?: (cardId: string) => void;

  onResolvePermission?: (requestId: string, behavior: "allow" | "deny", remember?: boolean) => void;

  onEgressDecision?: (cardId: string, host: string, action: "allow-once" | "add" | "deny") => void;
  onSettingsProposalDecision?: (cardId: string, action: "apply" | "dismiss") => void;

  onUndoIssueWrite?: (cardId: string) => void;
  onStartRepoSession?: (cardId: string) => Promise<void>;

  onOpenIssue?: (ref: {
    tracker: TrackerId;
    id?: string;
    identifier: string;
    title?: string;
    url?: string;

    anchorCommentId?: string;
  }) => void;

  onResumeSession?: (sessionId: string) => void;

  onReleaseConfirm?: (version: string, mechanism: ReleaseMechanism) => void;

  onReleaseCancel?: (version: string) => void;

  onAgentInterfaceMessage?: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
}) {
  const hasRewindControls = !!onRewindAtGap;

  const liveSessionId = useSessionStore((s) => s.sessionId);
  const deferred = useDeferredValue(
    useMemo(
      () => ({ messages: messagesProp, sessionId: liveSessionId }),
      [messagesProp, liveSessionId],
    ),
  );
  const messages = deferred.messages;

  const { containerRef, contentRef, currentMatchRef, canRestoreReadingAnchor, canPreserveAcrossCardMove } = useMessageScroll(messages, isLoading, currentMatch);

  const sessionStatusCardEnabled = useSettingsStore((s) => s.sessionStatusCard);
  const sessionStatus = useSessionStore((s) =>
    s.sessions.find((session) => session.id === s.sessionId)?.sessionStatus,
  );

  // docs/303 req 30 — the card keeps the place it had when the turn started, so
  // the turn's output renders below it. Frozen on the first render of a turn,
  // which is also what a viewer joining mid-turn gets: it never saw the start,
  // so its anchor is the whole conversation it has.
  const turnAnchorRef = useRef<{ sessionId: string | null; anchor: number | null }>({
    sessionId: null,
    anchor: null,
  });
  if (turnAnchorRef.current.sessionId !== (deferred.sessionId ?? null)) {
    turnAnchorRef.current = { sessionId: deferred.sessionId ?? null, anchor: null };
  }
  if (!isLoading) turnAnchorRef.current.anchor = null;
  // Against `messagesProp`, not the deferred copy: `isLoading` is not deferred,
  // so pairing the two mixes generations. A successor turn starting before the
  // predecessor's last reply has caught up would see that reply still marked
  // `streaming` and freeze one row short of it, for the whole turn.
  //
  // And not while the transcript is empty: switching to a running session
  // clears the messages and sets `isLoading` before the history arrives, and
  // freezing there would anchor the card above the whole conversation.
  else if (messagesProp.length > 0) {
    turnAnchorRef.current.anchor ??= settledMessageCount(messagesProp);
  }
  const turnAnchor = turnAnchorRef.current.anchor;

  const compactConversation = useSettingsStore((s) => s.compactConversation);
  const voicePlaybackEnabled = useSettingsStore((s) => s.voicePlaybackEnabled);

  const activeSessionId = liveSessionId;

  const subAgentSpawns = useSessionStore((s) => s.subAgentSpawns);

  const turnProseByLastIndex = useMemo(() => {
    const map = new Map<number, string>();
    if (!voicePlaybackEnabled) return map;
    let runStart = -1;                                                       
    const flush = (lastAssistantIdx: number) => {
      if (lastAssistantIdx < 0 || runStart < 0) return;
      const last = messages[lastAssistantIdx];
      if (last.streaming) return;                                          
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

  const matchesByMessage = useMemo(() => {

    // us a fresh empty array cannot invalidate every row. `useSearch` no longer

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

  // input to the computation, never a reason to redo it.
  const previousElementsRef = useRef<VisualElement[]>([]);
  const visualElements = useMemo(() => {
    const next = buildVisualElements(messages, previousElementsRef.current);
    previousElementsRef.current = next;
    return next;
  }, [messages]);

  // Per-row values the row cannot derive without `messages` (which it never

  const rowHandlers: RowHandlers = {
    messages,
    findPlanContent,
    onAnswerQuestion,
    onSendFollowUp,
    onSubmitBugReport,
    onDismissBugReport,
    onResolvePermission,
    onEgressDecision,
    onSettingsProposalDecision,
    onUndoIssueWrite,
    onStartRepoSession,
    onOpenIssue,
    onResumeSession,
    onReleaseConfirm,
    onReleaseCancel,
    onAgentInterfaceMessage,
    onRequestRewindPreview,
    onRewindAtGap,
  };

  // planning#375 — every row is a memoized `TranscriptRow`. This loop must

  const compact = useCompactConversation(messages, deferred.sessionId, compactConversation, visualElements, matchesByMessage, containerRef);
  const rows = visualElements.map((el, rowIndex) => {
    const view = compact.rows[rowIndex];
    const anchorIndex = elementMessageIndex(el);
    const key =
      el.kind === "task-panel" ? "task-panel"
      : el.kind === "tool-group" ? `tg-${el.messageIndices[0]}`
      : el.kind === "subagent" ? el.tool.id
      : el.kind === "standalone-tool" ? `st-${el.tool.id}`
      : `m-${el.index}`;
    const isBubble = el.kind === "message";
    const anchorMsg = messages[anchorIndex];
    // docs/299 — the rollback pill explains the response it sits above, so it
    // lives between the rows rather than inside one a collapsed turn can hide.
    const rollbackHash = isBubble && anchorMsg?.rolledBack ? anchorMsg.codeRollbackHash : undefined;
    // docs/299-collapsed-turns — the rewind anchor closes the user's message and
    // the expand control opens the reply, so the anchor is hoisted to the head of
    // the run: it must sit ABOVE the control even when the row carrying the
    // control is not the row the gap belongs to.
    const runGap = view.run && shouldShowGapBefore(view.run.start) ? view.run.start : undefined;
    const gapAtHeader = view.first ? runGap : undefined;
    const ownGap = isBubble && shouldShowGapBefore(el.index) && el.index !== runGap;
    const showsSomething = !view.hidden || !!view.first || !!rollbackHash || ownGap;
    return {
      key,
      // planning#491 — a row that can MOVE within the list must not be allowed

      movable: el.kind === "task-panel",
      visible: showsSomething,
      node: (
        <div key={key} hidden={!showsSomething}>
          {gapAtHeader !== undefined && renderRewindPoint(gapAtHeader)}
          {view.first && view.run && (
            <div className="text-xs text-(--color-text-secondary) flex items-center gap-2 py-0.5">
              {/* req 8 — a chevron alone. The words live on `aria-label` and the
                  tooltip, so the control marks the fold without competing with
                  the turn's own text. */}
              <Button variant="ghost" size="icon"
                aria-expanded={view.open}
                aria-controls={view.controls}
                aria-label={`${view.open ? "Show compact turn" : "Show full turn"}: ${view.run.identity.text.slice(0, 80) || "Agent response"}`}
                aria-disabled={view.search || undefined}
                title={view.search ? "Revealed by the active search" : view.open ? "Show compact turn" : "Show full turn"}
                onClick={() => { if (!view.search) compact.toggle(view.run, view.open); }}>
                {view.open
                  ? <CaretUpIcon size={ICON_SIZE.SM} weight="bold" />
                  : <CaretDownIcon size={ICON_SIZE.SM} weight="bold" />}
              </Button>
              {!view.open && view.empty && <span>Turn ended without an agent reply.</span>}
            </div>
          )}
          {view.hidden && ownGap && renderRewindPoint(el.index)}
          {rollbackHash && <CodeRollbackNotice hash={rollbackHash} />}
          <div id={`compact-row-${rowIndex}`} data-compact-content data-compact-index={anchorIndex} hidden={view.hidden}>
        <TranscriptRow
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
          showGapBefore={!view.hidden && ownGap}
          gapPreviousRole={isBubble ? previousRoleBefore(el.index) : null}
          collapseTools={view.collapseTools}
        />
          </div>
        </div>
      ),
    };
  });

  const statusCard = sessionStatusCardEnabled && sessionStatus
    ? (
      <SessionStatusCard
        key="session-status-card"
        status={sessionStatus}
        onSubmit={onSendFollowUp}
      />
    )
    : null;

  // docs/303 req 30 — the row the card is rendered after while a turn runs.
  // `null` puts it at the end: the agent is idle, there is no card, or the turn
  // has produced nothing yet, which is the same place.
  const cardRowIndex = useMemo(() => {
    if (turnAnchor === null) return null;
    // The element's LAST message, so a tool-group that merged the settled
    // tools with the turn's own still falls below the card rather than taking
    // the turn's output above it with them.
    const index = visualElements.findIndex((el) => elementLastMessageIndex(el) >= turnAnchor);
    return index < 0 ? null : index;
  }, [turnAnchor, visualElements]);

  // FRONT, and that is the load-bearing detail. A row that changes group changes

  const flow: ReactNode[] = [];
  let anchorsSeen = 0;
  let openedByCard = false;
  let current: { key: string; visible: number; children: ReactNode[] } | null = null;
  const flushGroup = () => {
    if (!current) return;
    const { key, visible, children } = current;
    flow.push(
      <div

        // Keyed by the chunk it belongs to, so a group keeps its identity when
        // the row indices shift under it. docs/303 req 30 — the card's anchor
        // can split one chunk in two; the second half is named after the same
        // chunk, so removing the split re-parents only that half's rows and
        // leaves every group past it alone.
        key={`g-${key}`}
        data-compact-group
        hidden={visible === 0}
        className="space-y-3 sm:space-y-2 [content-visibility:auto]"

        style={{
          containIntrinsicSize:
            `auto ${visible * ROW_PLACEHOLDER_REM + Math.max(visible - 1, 0) * ROW_GAP_REM}rem`,
        }}
      >
        {children}
      </div>,
    );
    current = null;
  };
  rows.forEach((row, index) => {
    if (statusCard && index === cardRowIndex) {
      flushGroup();
      flow.push(statusCard);
      openedByCard = anchorsSeen % ROWS_PER_GROUP !== 0;
    }
    if (!row.movable && anchorsSeen > 0 && anchorsSeen % ROWS_PER_GROUP === 0) {
      flushGroup();
      openedByCard = false;
    }
    const group = (current ??= {
      key: `${Math.floor(anchorsSeen / ROWS_PER_GROUP)}${openedByCard ? "b" : ""}`,
      visible: 0,
      children: [],
    });
    if (row.visible) group.visible++;
    if (!row.movable) anchorsSeen++;
    group.children.push(row.node);
  });
  flushGroup();

  /*
    planning#280 — the durable pending consult card (inline, at the call site) is
    now the primary in-flight surface. The transient chip is only shown for a
    spawn that has no card in the transcript yet, so the two can never render
    two spinners for the same consult.
  */
  for (const chip of Object.values(subAgentSpawns)) {
    if (messages.some((m) => m.subAgentConsult?.spawnId === chip.spawnId)) continue;
    flow.push(<SubAgentSpawnChipRow key={chip.spawnId} chip={chip} />);
  }

  if (!isLoading && messages.length > 0) {
    // A keyed fragment, so the rewind point keeps its place in this list without
    // a wrapper element between it and the scrolling content.
    flow.push(<Fragment key="trailing-rewind">{renderRewindPoint(messages.length, true)}</Fragment>);
  }

  // docs/303 req 6 — the last element of the conversation while the agent is
  // idle. The card is one element of this keyed list in both places, so moving
  // it reorders the DOM node instead of remounting the component, and the rows
  // it knows to be sent survive the move (req 30).
  if (statusCard && cardRowIndex === null) flow.push(statusCard);

  return (
    <ShipitPointerSessionProvider value={deferred.sessionId ?? null}>
    <RowHandlersProvider value={rowHandlers}>
    {/* `tabIndex` makes the transcript the focus target for a click on message
        text, which is otherwise not focusable and leaves focus on `<body>` —
        indistinguishable from a click on any other panel. `useChatSearchHotkey`
        reads the marker to take Ctrl+F here and nowhere else; -1 keeps the
        transcript out of the tab order, so the click is the only way in. */}
    <div
      ref={containerRef}
      data-chat-transcript=""
      tabIndex={-1}
      className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 focus:outline-none"
    >
    {/* The messages live in their own element rather than directly in the
        scroll container, so that one ResizeObserver on it reports every change
        in the transcript's height — the scroll container's own box never
        changes when its content grows. `useMessageScroll` uses that to stay
        pinned to the bottom while a message paints; see the hook. The spacing
        and content-visibility utilities move with the messages, so the elements
        they apply to are unchanged.

        planning#491 — `content-visibility: auto` sits on GROUPS of rows (see
        `ROWS_PER_GROUP`), not on every row, so the spacing has to be declared in
        both places: within a group for the rows in it, and here for the gap
        between one group and the next. Both are the same value, so a group
        boundary is invisible. */}
    <div
      ref={contentRef}
      className="space-y-3 sm:space-y-2"
    >
      {/* planning#12 — floating "Reply" button shown when the user highlights text
          inside a message bubble; quotes the passage into the composer. Scoped
          to this scroll container via the ref so it never fires on the composer
          or other panels. */}
      <ChatQuoteReply containerRef={containerRef} />
      {/* One character per row, and it has to cover BOTH ways a row can change
          height: "1" hidden, "t" shown with its tools hidden, "0" shown whole.
          A turn whose reply is kept but whose tools are collapsed changes
          nothing in the hidden half, so without "t" expanding it would move the
          reading position. */}
      {/* Everything that scrolls with the conversation is one keyed list, so the
          status card can move between the rows and the end without remounting
          (docs/303 req 30). `CompactLayout` renders it as a fragment, so each
          entry stays a direct child of the scrolling content. */}
      <CompactLayout visibility={compact.rows.map((row) => row.hidden ? "1" : row.collapseTools ? "t" : "0").join("")}
        cardAnchor={statusCard ? cardRowIndex : null}
        containerRef={containerRef} canRestoreReadingAnchor={canRestoreReadingAnchor}
        canPreserveAcrossCardMove={canPreserveAcrossCardMove}>
        {flow}
      </CompactLayout>
    </div>
    </div>
    </RowHandlersProvider>
    </ShipitPointerSessionProvider>
  );
}
