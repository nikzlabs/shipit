/**
 * Pure turn-prose extractor (docs/144).
 *
 * Given the chat messages that make up one assistant turn, return the
 * natural-language prose to read aloud. Only `assistant` text counts —
 * tool calls, tool results, errors, notices, and user messages are agent
 * machinery, not prose. The authoritative markdown/code stripping happens
 * server-side in `strip-for-tts.ts`; here we only need enough to (a) join
 * the turn's assistant text and (b) decide whether there is anything
 * speakable at all (an all-tool-call turn yields nothing, so the Play
 * button shouldn't render).
 */

import type { ChatMessage } from "../components/MessageList.js";

/** Join a turn's assistant prose into a single string (raw markdown). */
export function extractTurnProse(turnMessages: ChatMessage[]): string {
  return turnMessages
    .filter((m) => m.role === "assistant" && !m.isError && !m.notice && !m.rolledBack)
    .map((m) => m.text ?? "")
    .filter((t) => t.trim().length > 0)
    .join("\n\n")
    .trim();
}

/**
 * Whether a turn's prose contains anything worth reading once code and
 * markdown noise are stripped. Mirrors the *intent* of the server-side
 * `strip-for-tts` just enough to gate button rendering — the server still
 * does the real stripping and returns 204 if nothing remains.
 */
export function hasSpeakableProse(prose: string): boolean {
  const stripped = prose
    .replace(/```[\s\S]*?```/g, " ")   // fenced code blocks
    .replace(/`[^`]*`/g, " ")           // inline code
    .replace(/[#>*_~-]/g, " ")          // markdown punctuation
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0;
}
