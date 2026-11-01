import type { PersistedMessage } from "../chat-history.js";
import { detailLines, openSpill } from "./replay-detail.js";
import type { ReplaySpillTarget } from "./replay-detail.js";

export { replaySpillDirs, INLINE_DETAIL_LIMIT } from "./replay-detail.js";
export type { ReplaySpillTarget } from "./replay-detail.js";

/**
 * The most of a replay that rides inline, measured as it is serialized into the spawn
 * request, which the session worker refuses above 1 MiB: a long session's transcript once
 * failed every spawn with 413 (docs/007 → Size). The rest is in a file the agent can read.
 */
export const REPLAY_INLINE_BUDGET_BYTES = 256 * 1024;

export interface ReplayOptions {
  /**
   * Where long tool payloads and an over-budget transcript are written. Without it they
   * degrade to excerpts and an omitted beginning, so a caller that cannot resolve a
   * directory still produces a usable replay.
   */
  spill?: ReplaySpillTarget;
  /** Tests only; production uses `REPLAY_INLINE_BUDGET_BYTES`. */
  inlineBudgetBytes?: number;
}

const DETAIL_NOTE = "Lines beginning with [tool] and [result] are work already done; a result longer than"
  + " 500 characters names a file holding the whole thing.\n";
const FOOTER = "\nContinue from here. The user's next message follows.";

// The size the text adds to the JSON request: an escape is up to six bytes for one character.
const bytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
const SEPARATOR = bytes("\n");

export function buildConversationReplay(
  messages: PersistedMessage[],
  opts: ReplayOptions = {},
): string {
  if (messages.length === 0) return "";

  const spill = openSpill(opts.spill);
  const blocks: string[] = [];
  for (const m of messages) {
    const detail = detailLines(m, spill);
    if (m.text === "" && detail.length === 0) continue;
    const label = m.role === "user" ? "User" : "Assistant";
    // No trailing space on a turn that only called tools: the detail lines are its content.
    blocks.push([m.text === "" ? `${label}:` : `${label}: ${m.text}`, ...detail].join("\n"));
  }
  if (blocks.length === 0) return "";

  const whole = [
    "You are continuing a conversation. Here is the conversation so far.",
    DETAIL_NOTE,
    ...blocks,
    FOOTER,
  ].join("\n");
  const budget = opts.inlineBudgetBytes ?? REPLAY_INLINE_BUDGET_BYTES;
  if (bytes(whole) <= budget) return whole;

  const file = spill?.writeTranscript(blocks.join("\n\n")) ?? null;
  const where = file
    ? `The whole conversation is in ${file}; read it when you need an earlier part.`
    : "Its earlier part is omitted.";
  const headerFor = (kept: number): string => (kept > 0
    ? `You are continuing a conversation. Here are the most recent ${kept} of its ${blocks.length} messages. ${where}`
    : `You are continuing a conversation that is too long to include here. ${where}`);

  // The header's own length grows with the count, so budget against the largest it can be.
  let used = bytes(headerFor(blocks.length)) + bytes(DETAIL_NOTE) + bytes(FOOTER) + 2 * SEPARATOR;
  let first = blocks.length;
  while (first > 0) {
    const cost = bytes(blocks[first - 1]) + SEPARATOR;
    if (used + cost > budget) break;
    used += cost;
    first -= 1;
  }
  const tail = blocks.slice(first);
  return [headerFor(tail.length), DETAIL_NOTE, ...tail, FOOTER].join("\n");
}

/**
 * A replay stored before the bound existed can still exceed it, and one that is never
 * retired would fail every spawn. Keeps its most recent part from a message boundary.
 */
export function boundStoredReplay(
  replay: string,
  budget: number = REPLAY_INLINE_BUDGET_BYTES,
): string {
  if (bytes(replay) <= budget) return replay;
  const header = "You are continuing a conversation. Its earlier part is omitted; here is the most recent part.\n\n";
  let tail = replay.slice(-budget);
  while (tail.length > 0 && bytes(header) + bytes(tail) > budget) {
    tail = tail.slice(Math.ceil(tail.length / 10));
  }
  const boundary = /\n(?:User|Assistant):/.exec(tail);
  return header + (boundary ? tail.slice(boundary.index + 1) : tail);
}
