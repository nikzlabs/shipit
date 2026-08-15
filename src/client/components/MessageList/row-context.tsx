import { createContext, useContext, useRef, type ReactNode } from "react";
import type { ChatMessage } from "./types.js";
import type { AnswerQuestionFn } from "../AskUserQuestion.js";
import type { RewindGapAction } from "../RewindPoint.js";
import type { TrackerId, ReleaseMechanism } from "../../../server/shared/types.js";

/**
 * Everything a transcript row needs that changes IDENTITY on every render
 * without changing MEANING (planning#375).
 *
 * The callback props `MessageList` takes are re-created by its parent on every
 * render, and `messages` is a fresh array on every token. Handing either to a
 * memoized row as a prop would break the memo for all ~2,000 rows on every
 * update — which is the 92 ms render this whole change exists to remove.
 *
 * So they travel by ref instead: the context value is ONE object created once,
 * whose `.current` the parent rewrites each render. Its identity never changes,
 * so no consumer re-renders, and a row reading `handlers.current.onOpenIssue` at
 * click time always gets the live one.
 *
 * What must NOT live here: anything whose change should REDRAW a row. A row
 * that does not re-render never re-reads this object, so a value that affects
 * output (search matches, `isLoading`, the row's own message) has to be a prop.
 * Those are all referentially stable while unchanged, so they cost nothing.
 */
export interface RowHandlers {
  /** The live transcript. Rows read siblings from it; they never take it as a prop. */
  messages: ChatMessage[];
  /** Walks back for the plan body an ExitPlanMode card draws. */
  findPlanContent: (exitPlanMsgIndex: number) => string | undefined;
  onAnswerQuestion?: AnswerQuestionFn;
  onSendFollowUp?: (text: string) => boolean;
  onSubmitBugReport?: (cardId: string, title: string, body: string) => void;
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
  onRequestRewindPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewindAtGap?: (gapPosition: number, action: RewindGapAction, sessionName?: string) => void;
}

const RowHandlersContext = createContext<{ current: RowHandlers } | null>(null);

/**
 * Publish the current handlers without changing the context value's identity.
 * The write happens during render on purpose: a row rendering in the SAME pass
 * must see this pass's handlers, and an effect would land a tick too late.
 * Nothing reads the ref during render except rows, which read it at event time.
 */
export function RowHandlersProvider({ value, children }: { value: RowHandlers; children: ReactNode }) {
  const ref = useRef<RowHandlers>(value);
  ref.current = value;
  return <RowHandlersContext.Provider value={ref}>{children}</RowHandlersContext.Provider>;
}

export function useRowHandlers(): { current: RowHandlers } {
  const ctx = useContext(RowHandlersContext);
  if (!ctx) throw new Error("useRowHandlers must be used inside RowHandlersProvider");
  return ctx;
}
