import { CARD_MESSAGE_FIELDS, type VisualElement } from "../visual-elements.js";
import type { ChatMessage } from "./types.js";

/**
 * The two tools that END a turn waiting for the user to answer: the question
 * card and the plan approval. A permission or egress prompt blocks INSIDE a
 * turn, where docs/303 req 30 already holds the status card above it, so it is
 * not one of these.
 */
const ANSWER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function isAnswerTool(name: string, input: Record<string, unknown>): boolean {
  if (!ANSWER_TOOLS.has(name)) return false;
  // A malformed question is auto-answered by the CLI and never interrupts.
  return name !== "AskUserQuestion" || Array.isArray(input.questions);
}

/**
 * The answer card this element renders: the `id` that names it, and whether any
 * of the cards on it is still waiting. A row can carry more than one — a message
 * with two questions renders both — and it is pending while ANY is unanswered,
 * while its identity is the first, which does not move when a second arrives.
 */
function answerCard(
  el: VisualElement,
  messages: ChatMessage[],
): { id: string; pending: boolean } | undefined {
  if (el.kind === "standalone-tool") {
    if (!isAnswerTool(el.tool.name, el.tool.input)) return undefined;
    return { id: el.tool.id, pending: !el.result };
  }
  if (el.kind !== "message") return undefined;
  // A message that carries the agent's closing prose renders the card inline
  // rather than as an element of its own — but only when it renders its tools
  // at all. A message with a groupable tool beside the question is split into a
  // prose row with `hideTools` and a standalone element for the question, and
  // claiming the prose row too would give two siblings the same key.
  if (el.hideTools) return undefined;
  const msg = messages[el.index];
  const tools = msg?.toolUse?.filter((t) => isAnswerTool(t.name, t.input)) ?? [];
  if (tools.length === 0) return undefined;
  return {
    id: tools[0].id,
    pending: tools.some((t) => !msg?.toolResults?.some((result) => result.toolUseId === t.id)),
  };
}

/**
 * A card that IS the content of its carrier message — a voice note, an issue
 * write, a bug report. docs/303 req 32 lets these stay above the question they
 * arrived after, which is what stops the view landing on them.
 */
function isCardRow(msg: ChatMessage): boolean {
  if (msg.text.trim() || msg.images?.length || msg.files?.length || msg.toolUse?.length) return false;
  return CARD_MESSAGE_FIELDS.some((field) => msg[field] !== undefined);
}

/**
 * docs/303 req 32 — every element that renders a card the user answers, by row
 * index, with that card's tool id.
 *
 * ALL of them, answered or not: `MessageList` gives each its own container, so
 * that the pending one can be moved to the end of the conversation and back
 * without ever changing its DOM parent. `AskUserQuestion` keeps the user's
 * selections and their typed "Other" answer in component state, and an
 * interrupted question never receives a tool result to rebuild them from, so a
 * remount would silently discard an answer the user had already given.
 */
export function answerCardElements(
  elements: VisualElement[],
  messages: ChatMessage[],
): Map<number, string> {
  const found = new Map<number, string>();
  elements.forEach((el, index) => {
    const card = answerCard(el, messages);
    if (card) found.set(index, card.id);
  });
  return found;
}

/**
 * docs/303 req 32 — the element that renders a card waiting for the user's
 * answer, when that card is what the conversation ends with, or `null`.
 *
 * The scan steps over trailing card rows, so a voice note emitted after the
 * question does not hide it. It stops at anything else — a user row above all,
 * so a question the user replied past rather than answered is left where it is.
 */
export function pendingAnswerElementIndex(
  elements: VisualElement[],
  messages: ChatMessage[],
): number | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const card = answerCard(el, messages);
    if (card) return card.pending ? i : null;
    // `buildVisualElements` emits a to-do panel and a sub-agent chip AFTER the
    // element for the message they were folded out of, so the agent updating
    // its task list or spawning a sub-agent in the same message as the question
    // puts one below it. Neither is the end of the conversation any more than a
    // card row is; a reply from the user still stops the scan.
    if (el.kind === "task-panel" || el.kind === "subagent") continue;
    if (el.kind !== "message") return null;
    const msg = messages[el.index];
    if (!msg || !isCardRow(msg)) return null;
  }
  return null;
}
