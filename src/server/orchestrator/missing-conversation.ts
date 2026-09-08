/**
 * docs/153 Fix 2 — the one signal that says a `--resume <id>` spawn is doomed.
 *
 * When the Claude CLI cannot find the conversation we asked it to resume it says
 * so on stderr and then emits a fresh, useless session id through BOTH
 * `agent_init` and `agent_result` before exiting 1. Writing that id back is what
 * turns one failed resume into a permanent one: the good id is gone, so every
 * later turn resumes the same missing conversation.
 *
 * Shared because two spawn owners have to honour it — the turn listeners
 * (`ws-handlers/agent-listeners.ts`) and the docs/295 pre-turn compaction, which
 * wires its own narrow listener set and writes the id back itself.
 */

/**
 * The invalid session id, when this log line is the missing-conversation report.
 * `null` for every other line, including a stdout line that happens to match.
 */
export function detectMissingConversation(source: string, text: string): string | null {
  if (source !== "stderr") return null;
  return /No conversation found with session ID:\s*([^\s]+)/i.exec(text)?.[1] ?? null;
}
