import type { PersistedMessage } from "../chat-history.js";

export function buildConversationReplay(messages: PersistedMessage[]): string {
  if (messages.length === 0) return "";

  const replayLines: string[] = [
    "You are continuing a conversation. Here is the conversation so far:\n",
  ];
  for (const m of messages) {
    const label = m.role === "user" ? "User" : "Assistant";
    replayLines.push(`${label}: ${m.text}`);
  }
  replayLines.push("\nContinue from here. The user's next message follows.");
  return replayLines.join("\n");
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
  opts: { requireReply?: boolean } = {},
): boolean {
  const chatHistory = deps.chatHistoryManager;
  if (!chatHistory) return false;
  const messages = chatHistory.load(sessionId);
  if (opts.requireReply && !messages.some((m) => m.role === "assistant" && m.text !== "")) {
    return false;
  }
  const replay = buildConversationReplay(messages);
  if (!replay) return false;
  deps.sessionManager.setConversationReplay(sessionId, replay);
  return true;
}
