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

/** The id of the answer card this element renders, or `undefined`. */
function answerToolId(el: VisualElement, messages: ChatMessage[]): string | undefined {
  if (el.kind === "standalone-tool") {
    return isAnswerTool(el.tool.name, el.tool.input) ? el.tool.id : undefined;
  }
  if (el.kind !== "message") return undefined;
  // A message that carries the agent's closing prose renders the card inline
  // rather than as an element of its own.
  return messages[el.index]?.toolUse?.find((t) => isAnswerTool(t.name, t.input))?.id;
}

function isAnswered(el: VisualElement, messages: ChatMessage[], toolId: string): boolean {
  if (el.kind === "standalone-tool") return !!el.result;
  const msg = el.kind === "message" ? messages[el.index] : undefined;
  return !!msg?.toolResults?.some((result) => result.toolUseId === toolId);
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
    const toolId = answerToolId(el, messages);
    if (toolId !== undefined) found.set(index, toolId);
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
    const toolId = answerToolId(el, messages);
    if (toolId !== undefined) return isAnswered(el, messages, toolId) ? null : i;
    if (el.kind !== "message") return null;
    const msg = messages[el.index];
    if (!msg || !isCardRow(msg)) return null;
  }
  return null;
}
