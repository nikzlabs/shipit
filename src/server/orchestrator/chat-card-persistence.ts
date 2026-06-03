/**
 * Chat-card persistence — the single, correct way to put a card into the chat
 * transcript so it survives a session switch AND a full reload (docs/164).
 *
 * Background: `runner.emitMessage()` is *transport only*. It broadcasts to
 * attached viewers and buffers into the per-turn turn-event log (replayed on a
 * WS **reconnect**), but it does NOT write to persisted chat history. A session
 * switch and a full page reload rehydrate the transcript from `ChatHistoryManager`
 * (`GET /history`), so an emit-only card renders live, survives a reconnect, then
 * vanishes on switch/reload. This footgun has recurred — voice notes (docs/163)
 * and bug-report cards (docs/164) each shipped emit-only first and had to be
 * retrofitted.
 *
 * `emitChatCard` removes the footgun: a single call both emits the WS message and
 * records the card for in-band turn persistence, so you cannot emit a transcript
 * card without persisting it. The card is recorded on the runner anchored by
 * `afterGroupIndex` (how many persistable assistant groups exist so far), and
 * `buildTurnMessages` re-interleaves it at that position on every in-progress
 * rebuild — landing it where the tool fired instead of letting an out-of-band
 * `append` float it above the whole turn on reload.
 *
 * Transient signals (spinners, `preview_status`, queue counts) stay on plain
 * `emitMessage` — only persist what belongs in the scrollback.
 *
 * Lives in its own module (not `session-runner` / `agent-listeners`) so the
 * voice-note router can import it as a value without recreating the import cycle
 * those modules have with each other.
 */

import type { WsServerMessage } from "../shared/types.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";

/**
 * Record a chat card on the runner, anchored after the assistant groups that
 * have produced persistable content so far. `buildTurnMessages` reads
 * `runner.recordedCards` and re-interleaves each at `afterGroupIndex` on every
 * in-progress rebuild. Same mechanism as `recordSteeredMessage`.
 *
 * Prefer `emitChatCard` — it pairs this with the WS emit so the two can't drift.
 * Use `recordChatCard` directly only when the WS emit is genuinely separate.
 */
export function recordChatCard(
  runner: Pick<SessionRunnerInterface, "chatMessageGroups" | "recordedCards">,
  message: PersistedMessage,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.recordedCards = [...runner.recordedCards, { afterGroupIndex, message }];
}

/**
 * Emit a transcript card AND record it for persistence in one call. `wsMessage`
 * is the live WS payload (carries its own `type` + `sessionId`); `persisted` is
 * the `PersistedMessage` row to interleave into chat history (typically
 * `{ role: "assistant", text: "", <cardField>: ... }`). Lifecycle transitions on
 * an already-persisted card (e.g. filed/failed) patch the DB row in place via
 * the relevant `ChatHistoryManager` method — they are not re-recorded here.
 */
export function emitChatCard(
  runner: Pick<SessionRunnerInterface, "emitMessage" | "chatMessageGroups" | "recordedCards">,
  wsMessage: WsServerMessage,
  persisted: PersistedMessage,
): void {
  runner.emitMessage(wsMessage);
  recordChatCard(runner, persisted);
}
