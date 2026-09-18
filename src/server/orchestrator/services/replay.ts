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
