import { isTerminalTranscriptEntry, type VisualElement } from "../visual-elements.js";
import type { ChatMessage } from "./types.js";

export function elementMessageIndex(el: VisualElement): number {
  if (el.kind === "message") return el.index;
  if (el.kind === "tool-group") return el.messageIndices[0] ?? 0;
  return el.messageIndex;
}

export interface CompactRun {
  start: number;
  end: number;
  /** The turn's last agent reply — the one row a collapsed turn keeps (req 5). */
  lastReply: number;

  identity: ChatMessage;
}

/**
 * docs/299 — a message this turn's collapsed form keeps as "the reply".
 *
 * Widened from text-only: requirement 5 asks for the last agent message, and an
 * answer can end in a diagram or an attached file. The `isError` and
 * `rolledBack` exclusions stay, or an appended error row displaces the reply a
 * reader actually wants.
 */
function isReply(m: ChatMessage): boolean {
  if (m.isError || m.rolledBack || isTerminalTranscriptEntry(m)) return false;
  return !!m.text.trim() || !!m.images?.length || !!m.files?.length;
}

/**
 * The collapsible display turns: one run of assistant rows per user message.
 *
 * **The newest display turn is never collapsed, and that is the whole live-turn
 * rule (req 1).** No `inProgress` or `streaming` flag is read. Those flags
 * cannot identify a live execution — an ordinary live append sets `streaming`
 * and the merge rebuilds the row without `inProgress` (`agent-event.ts`), while
 * an attach snapshot marks *every* row of the execution `inProgress`
 * (`turn-snapshot.ts`) — so a classifier keyed on them shows a viewer who
 * watched the turn and a viewer who reconnected different transcripts. A
 * boundary derived from the rows agrees whenever the rows agree.
 */
export function compactRuns(messages: ChatMessage[]): CompactRun[] {
  const runs: CompactRun[] = [];
  let start = -1;
  let lastReply = -1;
  const flush = (end: number, newest: boolean) => {
    if (start >= 0 && !newest) {
      runs.push({ start, end, lastReply, identity: messages[start - 1] ?? messages[start] });
    }
    start = -1;
    lastReply = -1;
  };
  messages.forEach((m, index) => {
    if (m.role === "user") {
      flush(index, false);
      return;
    }
    if (start < 0) start = index;
    if (isReply(m)) lastReply = index;
  });
  flush(messages.length, true);
  return runs;
}

/** Whether a card on this message still needs the user, so req 12 keeps it. */
export type NeedsUser = (m: ChatMessage) => boolean;

/**
 * Whether this element is hidden when its turn is collapsed.
 *
 * Kept: the user's own row, an error row or notice (req 11), a card that still
 * needs the user (req 12), and the turn's last agent reply (req 5). Everything
 * else — every tool group, whether or not a tool failed (req 2), every subagent
 * and task panel, and every intermediate progress message — is hidden.
 *
 * **No tool is kept, not even one that looks unfinished.** A question or a plan
 * approval reaches a collapsed turn only after the user sent a later message,
 * which ends the turn it sits in — so the product is no longer waiting on it.
 * The only readable signal for the opposite reading, an absent tool result,
 * does not exist on both harnesses: the Codex worker emits the question card
 * itself and its adapter drops the matching result (`codex-event-handler.ts`,
 * the `isAskUserQuestionTool` early return), so every answered question there
 * would be pinned open for the life of the session. That is the retain-forever
 * failure the design rejected for issue-write Undo. Requirement 12's cases all
 * read a source of truth that says "pending"; absence of state is not one.
 */
export function isCompactDetail(
  el: VisualElement,
  messages: ChatMessage[],
  run: CompactRun,
  needsUser: NeedsUser,
): boolean {
  if (el.kind !== "message") return true;

  const m = messages[el.index];
  if (m.role === "user") return false;
  if (m.isError || m.notice) return false;
  if (needsUser(m)) return false;
  return el.index !== run.lastReply;
}

/**
 * Whether a kept row's own tool subtree is hidden (req 2).
 *
 * `buildVisualElements` splits *groupable* tools into their own element, but a
 * row carrying prose plus a standalone tool — a question, a plan, a presented
 * artifact — stays one element with its tools attached: hiding it would lose
 * the reply, keeping it whole would show the tool. The caller hides the subtree
 * with the `hidden` attribute rather than unmounting it, so a tool holding
 * user input keeps that input.
 */
export function shouldCollapseRowTools(el: VisualElement, m: ChatMessage | undefined): boolean {
  return el.kind === "message" && !el.hideTools && !!m?.toolUse?.length;
}
