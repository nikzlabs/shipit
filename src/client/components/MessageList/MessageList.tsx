import { useMemo, useRef, useDeferredValue, type ReactNode } from "react";
import { CompactLayout } from "./CompactLayout.js";
import { useCompactConversation } from "./hooks/useCompactConversation.js";
import { elementMessageIndex } from "./compact-turns.js";
import { Button } from "../ui/button.js";
import { Spinner } from "../Spinner.js";
import type { SearchMatch } from "../../hooks/useSearch.js";
import { buildVisualElements, type VisualElement } from "../visual-elements.js";
import { RewindPoint, type RewindGapAction } from "../RewindPoint.js";
import type { WsRewindPreview, ReleaseMechanism } from "../../../server/shared/types.js";
import { isPlanDocumentWrite } from "../../../server/shared/transcript-input-policy.js";

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

const NO_MATCHES_BY_MESSAGE = new Map<number, SearchMatch[]>();

function defaultSessionNameFor(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || "Fork from here";
}

function compactingIndicatorIndex(
  elements: VisualElement[],
  anchor: number | null,
  indicator: ReactNode,
): number {
  if (!indicator) return -1;
  const found = anchor === null ? -1 : elements.findIndex((el) => elementMessageIndex(el) >= anchor);
  return found === -1 ? elements.length : found;
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

  onAnswerQuestion?: AnswerQuestionFn;

  onSendFollowUp?: (text: string) => boolean;
  rewindPreviews?: Record<string, WsRewindPreview>;
  sessionTitle?: string;
  onRequestRewindPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewindAtGap?: (gapPosition: number, action: RewindGapAction, sessionName?: string) => void;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
  onDismissBugReport?: (cardId: string) => void;

  onResolvePermission?: (requestId: string, behavior: "allow" | "deny", remember?: boolean) => void;

  onEgressDecision?: (cardId: string, host: string, action: "allow-once" | "add" | "deny") => void;

  onUndoIssueWrite?: (cardId: string) => void;

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

  const { containerRef, contentRef, currentMatchRef, canRestoreReadingAnchor } = useMessageScroll(messages, isLoading, currentMatch);

  const compactConversation = useSettingsStore((s) => s.compactConversation);
  const voicePlaybackEnabled = useSettingsStore((s) => s.voicePlaybackEnabled);

  const activeSessionId = liveSessionId;
  const compacting = useSessionStore((s) => s.compacting);
  const compactingAnchor = useSessionStore((s) => s.compactingAnchor);

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
    onUndoIssueWrite,
    onOpenIssue,
    onResumeSession,
    onReleaseConfirm,
    onReleaseCancel,
    onAgentInterfaceMessage,
    onRequestRewindPreview,
    onRewindAtGap,
  };

  // "Compacting…" indicator should never outlive the turn. This backstops any

  const compactingIndicator =
    compacting && isLoading ? (
      <div key="compacting-indicator" className="flex justify-start" data-testid="compacting-indicator">
        <div className="flex items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs text-(--color-text-secondary)">
          <Spinner size={14} className="text-(--color-text-tertiary)" />
          Compacting context…
        </div>
      </div>
    ) : null;

  // planning#375 — every row is a memoized `TranscriptRow`. This loop must

  const compact = useCompactConversation(messages, isLoading, deferred.sessionId, compactConversation, visualElements, matchesByMessage, containerRef);
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
    return {
      key,
      // planning#491 — a row that can MOVE within the list must not be allowed

      movable: el.kind === "task-panel",
      visible: !view.hidden || !!view.first || (isBubble && shouldShowGapBefore(el.index)),
      node: (
        <div key={key} hidden={view.hidden && !view.first && !(isBubble && shouldShowGapBefore(el.index))}>
          {view.first && view.run && (
            <div className="text-xs text-(--color-text-secondary)">
              <Button variant="ghost" size="sm"
                aria-expanded={view.open}
                aria-controls={view.controls}
                aria-label={`${view.open ? "Show compact turn" : "Show full turn"}: ${view.run.identity.text.slice(0, 80) || "Agent response"}`}
                aria-disabled={view.search || undefined}
                title={view.search ? "Revealed by the active search" : undefined}
                onClick={() => { if (!view.search) compact.toggle(view.run, view.open); }}>
                {view.open ? "Show compact turn" : "Show full turn"}
              </Button>
              {!view.open && !view.run.hasText && <span className="ml-2">Turn ended without an agent reply.</span>}
            </div>
          )}
          {view.hidden && isBubble && shouldShowGapBefore(el.index) && renderRewindPoint(el.index)}
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
          showGapBefore={!view.hidden && isBubble && shouldShowGapBefore(el.index)}
          gapPreviousRole={isBubble ? previousRoleBefore(el.index) : null}
        />
          </div>
        </div>
      ),
    };
  });

  // FRONT, and that is the load-bearing detail. A row that changes group changes

  const indicatorAt = compactingIndicatorIndex(visualElements, compactingAnchor, compactingIndicator);
  const rowGroups: ReactNode[] = [];
  let anchorsSeen = 0;
  let current: { visible: number; children: ReactNode[] } | null = null;
  const flushGroup = () => {
    if (!current) return;
    const { visible, children } = current;
    rowGroups.push(
      <div

        key={`g-${rowGroups.length}`}
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
  rows.forEach((row, i) => {
    if (!row.movable && anchorsSeen > 0 && anchorsSeen % ROWS_PER_GROUP === 0) flushGroup();
    const group = (current ??= { visible: 0, children: [] });
    if (i === indicatorAt) { group.children.push(compactingIndicator); group.visible++; }
    if (row.visible) group.visible++;
    if (!row.movable) {
      anchorsSeen++;
    }
    group.children.push(row.node);
  });
  flushGroup();

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
      <CompactLayout visibility={compact.rows.map((row) => row.hidden ? "1" : "0").join("")}
        containerRef={containerRef} canRestoreReadingAnchor={canRestoreReadingAnchor}>
        {rowGroups}
      </CompactLayout>
      {/* An indicator anchored past the last row belongs after every group, not
          inside one — the same end-of-list placement `compactingIndicatorIndex`
          returns for a null anchor. */}
      {indicatorAt >= rows.length ? compactingIndicator : null}

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
