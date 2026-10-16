import type { AgentId } from "../../shared/types.js";
import { getAgentCapabilities, getAgentDisplayName } from "../../shared/agent-registry.js";
import type { PersistedMessage } from "../chat-history.js";

/**
 * docs/007 req 4 — the CLI message to fork the conversation at, so that it ends where the
 * kept chat ends. Rows ShipIt wrote itself (notices, cards, errors) carry no id and are
 * passed over; a user row without one is a prompt the fork would drop, so there is none.
 */
export function forkPointBefore(messages: PersistedMessage[], gapPosition: number): string | null {
  for (let i = Math.min(gapPosition, messages.length) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.agentMessageId) return message.agentMessageId;
    if (message.role === "user" && !message.notice) return null;
  }
  return null;
}

export type ChatRewindPlan = { resumeAt: string } | { refusal: string };

/** docs/007 reqs 4, 6, 9 — where an in-place chat rewind forks, or why it cannot, naming fork. */
export function planChatRewind(
  agentId: AgentId,
  messages: PersistedMessage[],
  gapPosition: number,
): ChatRewindPlan {
  if (getAgentCapabilities(agentId)?.forksAtMessage !== true) {
    return { refusal: `${getAgentDisplayName(agentId)} cannot rewind its conversation in place. Fork from here instead.` };
  }
  const resumeAt = forkPointBefore(messages, gapPosition);
  if (!resumeAt) {
    return { refusal: "The agent's conversation has no message to rewind to here. Fork from here instead." };
  }
  return { resumeAt };
}

/** docs/007 req 3 — one line, so an undo can take exactly it back out of the pending notice. */
export function codeRollbackNotice(commitHash: string): string {
  return `[System] The user rolled the code back to commit ${commitHash.slice(0, 7)}. Changes made after `
    + "that commit are no longer in the working tree; read a file again before you rely on what you remember of it.";
}
