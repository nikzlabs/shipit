import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
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

/** Every optional callback on `RowHandlers`. */
type CallbackKey = Exclude<keyof RowHandlers, "messages" | "findPlanContent">;

const CALLBACK_KEYS = [
  "onAnswerQuestion",
  "onSendFollowUp",
  "onSubmitBugReport",
  "onResolvePermission",
  "onEgressDecision",
  "onUndoIssueWrite",
  "onOpenIssue",
  "onResumeSession",
  "onReleaseConfirm",
  "onReleaseCancel",
  "onRequestRewindPreview",
  "onRewindAtGap",
] as const satisfies readonly CallbackKey[];

const RowHandlersContext = createContext<RowHandlers | null>(null);

/**
 * Publish the current handlers behind one object whose identity never changes.
 *
 * Each callback becomes a permanent wrapper that forwards to the latest one,
 * and the indirection is the whole point — reading the ref inline at render
 * time is NOT a substitute. A row renders its children with these functions: it
 * hands `onAnswerQuestion` to a `ToolUseItem`, `onRewind` to a `RewindPoint`. A
 * row that dereferenced a ref during render would keep handing its children the
 * callback captured at its last render, so a memoized row that never re-renders
 * would hold a stale closure — stable identity bought with a correctness bug.
 * A wrapper is stable AND current, so a row can bail out and still reach this
 * render's handler when the user eventually clicks.
 *
 * Optionality is preserved through a getter rather than flattened to
 * always-defined, because several cards branch on whether a handler EXISTS to
 * decide whether to draw a control at all (and `MessageList` derives
 * `hasRewindControls` the same way). Handing them a wrapper where the parent
 * passed nothing would draw buttons that do nothing.
 *
 * The ref write happens during render on purpose: a row rendering in the SAME
 * pass must forward to this pass's handlers, and an effect would land too late.
 */
export function RowHandlersProvider({ value, children }: { value: RowHandlers; children: ReactNode }) {
  const ref = useRef<RowHandlers>(value);
  ref.current = value;

  // Built once — every wrapper closes over `ref`, never over a render's values.
  const stable = useMemo<RowHandlers>(() => {
    const wrappers = {} as Record<CallbackKey, (...args: unknown[]) => unknown>;
    const target: Record<string, unknown> = {
      get messages() { return ref.current.messages; },
      findPlanContent: (i: number) => ref.current.findPlanContent(i),
    };
    for (const key of CALLBACK_KEYS) {
      wrappers[key] = (...args: unknown[]) => {
        const fn = ref.current[key] as ((...a: unknown[]) => unknown) | undefined;
        return fn?.(...args);
      };
      Object.defineProperty(target, key, {
        enumerable: true,
        // Same wrapper every time it exists, so a child's prop identity is
        // stable; `undefined` when the parent passed nothing, so a card that
        // gates a control on presence still sees the truth.
        get: () => (ref.current[key] ? wrappers[key] : undefined),
      });
    }
    return target as unknown as RowHandlers;
  }, []);

  return <RowHandlersContext.Provider value={stable}>{children}</RowHandlersContext.Provider>;
}

export function useRowHandlers(): RowHandlers {
  const ctx = useContext(RowHandlersContext);
  if (!ctx) throw new Error("useRowHandlers must be used inside RowHandlersProvider");
  return ctx;
}
