import type { PersistedMessage } from "../chat-history.js";
import { detailLines, openSpill } from "./replay-detail.js";
import type { ReplaySpillTarget } from "./replay-detail.js";

export { replaySpillDirs, INLINE_DETAIL_LIMIT } from "./replay-detail.js";
export type { ReplaySpillTarget } from "./replay-detail.js";

export interface ReplayOptions {
  /**
   * Where long tool payloads are written. Without it they degrade to excerpts, so a
   * caller that cannot resolve a directory still produces a usable replay.
   */
  spill?: ReplaySpillTarget;
  /**
   * The text of the message this turn is about to submit. The turn's user row is persisted
   * before the replay is built (`turn-executor.ts`), so without this the replay ends with
   * the very message that follows it as the prompt and the agent reads it twice.
   */
  dropTrailingUserText?: string;
}

/** Whether a message says anything a continuing agent needs: text, or work it did. */
export function carriesContent(m: PersistedMessage): boolean {
  return m.text !== ""
    || (m.toolUse?.length ?? 0) > 0
    || (m.toolResults?.length ?? 0) > 0
    || (m.files?.length ?? 0) > 0
    || (m.images?.length ?? 0) > 0
    || (m.uploadPaths?.length ?? 0) > 0;
}

function withoutOwnMessage(
  messages: PersistedMessage[],
  ownText: string | undefined,
): PersistedMessage[] {
  if (ownText === undefined) return messages;
  const last = messages.at(-1);
  // Matched on text rather than position: on the new-session path the row is persisted
  // after this runs, and dropping a different message would discard real history.
  if (last?.role !== "user" || last.text !== ownText) return messages;
  return messages.slice(0, -1);
}

export function buildConversationReplay(
  messages: PersistedMessage[],
  opts: ReplayOptions = {},
): string {
  const kept = withoutOwnMessage(messages, opts.dropTrailingUserText);
  if (kept.length === 0) return "";

  const spill = openSpill(opts.spill);
  const blocks: string[] = [];
  for (const m of kept) {
    const detail = detailLines(m, spill);
    if (m.text === "" && detail.length === 0) continue;
    const label = m.role === "user" ? "User" : "Assistant";
    // No trailing space on a turn that only called tools: the detail lines are its content.
    blocks.push([m.text === "" ? `${label}:` : `${label}: ${m.text}`, ...detail].join("\n"));
  }
  if (blocks.length === 0) return "";

  return [
    "You are continuing a conversation. Here is the conversation so far.",
    "Lines beginning with [tool] and [result] are work already done; a result longer than"
      + " 500 characters names a file holding the whole thing.\n",
    ...blocks,
    "\nContinue from here. The user's next message follows.",
  ].join("\n");
}

export interface ConversationReplayDeps {
  chatHistoryManager?: { load: (sessionId: string) => PersistedMessage[] };
  sessionManager: { setConversationReplay: (id: string, replay: string) => void };
}

/**
 * Rebuild the transcript for a session that is about to start an agent with no thread of
 * its own, so the new conversation continues the chat instead of beginning empty.
 *
 * Built from history at the moment it is called rather than copied from an earlier
 * arming: a failed attempt's partial output is finalized into history before a retry
 * re-arms, so the retry's agent sees more than the attempt that gave up, not less.
 *
 * `requireReply` is for callers that re-arm mid-turn. The turn's own user row is already
 * persisted by then, so a session with nothing else would replay that one message back as
 * history and then submit it as the prompt. A transcript with no reply in it is not a
 * conversation to continue.
 */
export function armConversationReplay(
  deps: ConversationReplayDeps,
  sessionId: string,
  opts: { requireReply?: boolean } & ReplayOptions = {},
): boolean {
  const chatHistory = deps.chatHistoryManager;
  if (!chatHistory) return false;
  const messages = chatHistory.load(sessionId);
  // A turn that only called tools is a reply: it persists with `text: ""` but carries the work.
  if (opts.requireReply && !messages.some((m) => m.role === "assistant" && carriesContent(m))) {
    return false;
  }
  const replay = buildConversationReplay(messages, opts);
  if (!replay) return false;
  deps.sessionManager.setConversationReplay(sessionId, replay);
  return true;
}
