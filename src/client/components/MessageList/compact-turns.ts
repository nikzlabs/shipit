import { hasCardContent, isTerminalTranscriptEntry, SUBAGENT_TOOLS, type VisualElement } from "../visual-elements.js";
import { isTaskListTool } from "../../../server/shared/task-list-tools.js";
import type { ChatMessage } from "./types.js";

export function elementMessageIndex(el: VisualElement): number {
  if (el.kind === "message") return el.index;
  if (el.kind === "tool-group") return el.messageIndices[0] ?? 0;
  return el.messageIndex;
}

/**
 * The LAST message an element draws. A tool-group spans several, and it can
 * span a turn boundary when no user row separates them, so an element that
 * starts before a boundary may still carry rows from after it.
 */
export function elementLastMessageIndex(el: VisualElement): number {
  if (el.kind === "tool-group") return el.messageIndices[el.messageIndices.length - 1] ?? 0;
  return elementMessageIndex(el);
}

export interface CompactRun {
  start: number;
  end: number;
  /** The turn's last agent reply — the one row a collapsed turn keeps (req 5). */
  lastReply: number;

  identity: ChatMessage;
}

/**
 * A message the collapsed turn can keep as "the reply" — text, images OR files,
 * since an answer can end in a diagram. Excluding errors and rolled-back rows
 * stops an appended error row displacing the reply a reader wants (docs/299).
 */
function isReply(m: ChatMessage): boolean {
  if (m.isError || m.rolledBack || isTerminalTranscriptEntry(m)) return false;
  return !!m.text.trim() || !!m.images?.length || !!m.files?.length;
}

/**
 * The collapsible display turns: one run of assistant rows per user message.
 *
 * **The newest run is never collapsed, and that is the whole live-turn rule.**
 * Never reintroduce `inProgress` or `streaming` here: a live append sets only
 * `streaming` (`agent-event.ts`) while an attach snapshot flags *every* row of
 * the execution (`turn-snapshot.ts`), so a classifier reading them gives a
 * watching viewer and a reconnecting one different transcripts. docs/299.
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
 * Whether this element is hidden when its turn is collapsed. Kept: the user's
 * row, an error or notice, an action card, a card still needing the user, and
 * the turn's last reply. Everything else, including every tool, hidden.
 * docs/299.
 *
 * **No tool is kept, not even one with no result.** Reading an absent result as
 * "unanswered" does not work on Codex, whose adapter drops the result for a
 * question the worker itself surfaced (`codex-event-handler.ts`) — every
 * answered question there would stay open for the life of the session.
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
  // req 12 — an action card is kept whether or not it was sent. The offer is a
  // standing one the user can still take, and a sent one is the record of what
  // they took; neither reads as finished work the collapsed turn can drop.
  if (m.actionChecklist) return false;
  if (needsUser(m)) return false;
  return el.index !== run.lastReply;
}

/** What a collapsed turn is holding back, for the fold rule's label (req 8). */
export interface HiddenCounts { tools: number; messages: number; cards: number }

/**
 * The tools a message row draws itself, which is NOT every tool it carries: a
 * subagent call is always split into its own element, and a to-do write becomes
 * the task panel. Counting `toolUse.length` here would count those twice.
 */
export function rowToolCount(el: VisualElement, m: ChatMessage | undefined): number {
  if (el.kind !== "message" || el.hideTools || !m?.toolUse) return 0;
  return m.toolUse.filter((t) => !SUBAGENT_TOOLS.has(t.name) && !isTaskListTool(t.name)).length;
}

/**
 * Adds one hidden element to a run's tally. A to-do panel counts as a card: it
 * is a panel rather than prose, and a fourth noun would turn the label into a
 * list. A message carrying tools counts in both columns, because both go.
 */
export function countHidden(el: VisualElement, m: ChatMessage | undefined, into: HiddenCounts): void {
  if (el.kind === "tool-group") { into.tools += el.items.length; return; }
  if (el.kind === "subagent" || el.kind === "standalone-tool") { into.tools += 1; return; }
  if (el.kind === "task-panel") { into.cards += 1; return; }
  if (!m) return;
  into.tools += rowToolCount(el, m);
  if (hasCardContent(m)) into.cards += 1;
  else if (m.text.trim() || m.images?.length || m.files?.length) into.messages += 1;
}

/** "3 tool calls · 1 message · 2 cards", or nothing to count. */
export function describeHidden(counts: HiddenCounts): string | undefined {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(counts.tools, "tool call", "tool calls");
  add(counts.messages, "message", "messages");
  add(counts.cards, "card", "cards");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Whether a kept row's own tool subtree is hidden. `buildVisualElements` splits
 * out *groupable* tools, but a row carrying prose plus a standalone one keeps
 * them attached. The caller must hide the subtree with the `hidden` attribute,
 * never unmount it, or a tool holding typed input loses it (docs/299).
 */
export function shouldCollapseRowTools(el: VisualElement, m: ChatMessage | undefined): boolean {
  return el.kind === "message" && !el.hideTools && !!m?.toolUse?.length;
}
