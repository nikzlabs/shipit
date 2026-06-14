/**
 * Chat-card persistence — the single, correct way to put a card into the chat
 * transcript so it survives a session switch AND a full reload (docs/164, docs/191).
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
 * `emitChatCard` removes the footgun. A single call does three things atomically:
 *   1. emits the WS message (live render),
 *   2. records the card on the runner anchored by `afterGroupIndex` (so
 *      `buildTurnMessages` re-interleaves it at its true transcript position on
 *      every rebuild, instead of an out-of-band `append` floating it above the
 *      whole turn), and
 *   3. **persists the in-progress turn immediately** via `persistTurnInProgress`.
 *
 * Step 3 is what makes the invariant "a card appears ⇔ it is in session history"
 * hold the instant the card fires — not at the next tool-result boundary. The
 * old design only *recorded* the card and relied on a later `buildTurnMessages`
 * rebuild to flush it; between firing and that boundary the card lived only in
 * the live client array + `recordedCards`, so a mid-turn `loadSessionHistory`
 * (any WS reconnect) replaced the transcript with a DB snapshot lacking the card
 * and it flickered out, reappearing only once the turn finalized (docs/191 — the
 * "commented on issue card disappears then reappears" bug). Persisting inside the
 * primitive means no call site can defer or forget it.
 *
 * Because `emitChatCard` requires a persist context (`chatHistoryManager` +
 * `sessionId`), a card simply cannot be emitted without also being persisted —
 * the type system enforces it.
 *
 * Transient signals (spinners, `preview_status`, queue counts) stay on plain
 * `emitMessage` — only persist what belongs in the scrollback.
 *
 * Lives in its own module (not `session-runner` / `agent-listeners`) so the
 * voice-note router can import it as a value without recreating the import cycle
 * those modules have with each other. The turn-rebuild helpers
 * (`buildTurnMessages` / `persistTurnInProgress`) live here too — co-located with
 * `recordChatCard` because they share the `recordedCards` interleaving contract —
 * and are re-exported from `agent-listeners.ts` for its existing importers.
 */

import { randomUUID } from "node:crypto";
import type { WsServerMessage, WsSystemNotice } from "../shared/types.js";
import type {
  SessionRunnerInterface,
  ChatMessageGroup,
  SteeredMessage,
  RecordedChatCard,
} from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";

/**
 * Minimal chat-history surface the card/turn persistence needs: just the
 * in-progress replace. Kept structural so non-WS callers and tests can pass a
 * stub without the full `ChatHistoryManager`.
 */
export interface InProgressPersister {
  replaceInProgress(sessionId: string, messages: PersistedMessage[]): void;
}

/**
 * The durable-write context every transcript card carries: where to write
 * (`chatHistoryManager`) and which session (`sessionId`, captured at turn
 * start). Required by `emitChatCard` so a card can't be emitted without being
 * persisted in the same call.
 */
export interface CardPersistCtx {
  chatHistoryManager: InProgressPersister;
  sessionId: string;
}

/**
 * Build the ordered list of in-progress messages for a turn, interleaving any
 * live-steered user messages (docs/140) and recorded chat cards (voice notes
 * docs/163, bug-report cards docs/164, issue cards docs/177/188, …) at their
 * true position among the assistant message groups.
 *
 * `replaceInProgress` deletes every `in_progress=1` row and re-inserts this
 * list, so the assistant rows are reborn with fresh (higher) ids on every
 * call. A steered user message — or a recorded card — persisted out-of-band
 * (via `append`) keeps its original early id and therefore collapses up next
 * to the turn's first user message on reload. Folding both into the same
 * rebuilt batch — anchored by `afterGroupIndex` (the count of persistable
 * groups when the steer / card arrived) — keeps them at the exact spot they
 * occurred. An end-of-turn card lands where the tool was issued instead of
 * floating above the whole turn.
 *
 * When `inProgress` is true the rows participate in the next delete/reinsert
 * cycle; the final (agent_result) call passes false so the rows are written
 * permanently before `finalizeInProgress`.
 */
export function buildTurnMessages(
  groups: ChatMessageGroup[],
  steered: SteeredMessage[],
  recordedCards: RecordedChatCard[],
  opts: { inProgress: boolean },
): PersistedMessage[] {
  const persistable = groups.filter((g) => g.text || g.toolUse.length > 0);
  const out: PersistedMessage[] = [];
  const flag = opts.inProgress ? { inProgress: true as const } : {};

  const persistedSteer = (s: SteeredMessage): PersistedMessage => ({
    role: "user",
    text: s.text,
    images: s.images,
    files: s.files,
    uploadPaths: s.uploadPaths,
    ...flag,
  });

  const persistedCard = (c: RecordedChatCard): PersistedMessage => ({
    ...c.message,
    ...flag,
  });

  // At a given anchor, emit steered user messages first, then chat cards — so a
  // card recorded after the user's last steer renders below it.
  const emitAnchoredAt = (index: number) => {
    for (const s of steered) {
      if (s.afterGroupIndex === index) out.push(persistedSteer(s));
    }
    for (const c of recordedCards) {
      if (c.afterGroupIndex === index) out.push(persistedCard(c));
    }
  };

  for (let i = 0; i < persistable.length; i++) {
    emitAnchoredAt(i);
    const g = persistable[i];
    out.push({
      role: "assistant",
      text: g.text,
      toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
      toolResults: g.toolResults?.length ? g.toolResults : undefined,
      subagentEvents: g.subagentEvents?.length ? g.subagentEvents : undefined,
      ...flag,
    });
  }
  // Steers / cards anchored at or beyond the final group count land after
  // everything. The `>=` clamp guards against an anchor that outran the
  // persistable groups (e.g. the anchoring group never produced persistable
  // content). This is the common case for an end-of-turn card.
  for (const s of steered) {
    if (s.afterGroupIndex >= persistable.length) out.push(persistedSteer(s));
  }
  for (const c of recordedCards) {
    if (c.afterGroupIndex >= persistable.length) out.push(persistedCard(c));
  }
  return out;
}

/**
 * Persist the current turn's groups + steered messages + recorded cards as the
 * in-progress set. Shared by the steer handler (so a mid-turn injection is saved
 * immediately), the tool-result boundary in `wireAgentListeners`, and
 * `emitChatCard` (so a side-channel card is durable the instant it fires).
 */
export function persistTurnInProgress(
  chatHistoryManager: InProgressPersister,
  runner: { chatMessageGroups: ChatMessageGroup[]; steeredMessages: SteeredMessage[]; recordedCards: RecordedChatCard[] },
  sessionId: string,
): void {
  chatHistoryManager.replaceInProgress(
    sessionId,
    buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages, runner.recordedCards, { inProgress: true }),
  );
}

/**
 * Record a chat card on the runner, anchored after the assistant groups that
 * have produced persistable content so far. `buildTurnMessages` reads
 * `runner.recordedCards` and re-interleaves each at `afterGroupIndex` on every
 * in-progress rebuild. Same mechanism as `recordSteeredMessage`.
 *
 * Prefer `emitChatCard` — it pairs this with the WS emit AND the durable persist
 * so the three can't drift. Use `recordChatCard` directly only when the WS emit
 * and persist are genuinely handled separately by the caller.
 */
export function recordChatCard(
  runner: Pick<SessionRunnerInterface, "chatMessageGroups" | "recordedCards">,
  message: PersistedMessage,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.recordedCards = [...runner.recordedCards, { afterGroupIndex, message }];
}

/**
 * Emit a transcript card, record it for interleaving, AND persist the
 * in-progress turn — all in one call. `wsMessage` is the live WS payload
 * (carries its own `type` + `sessionId`); `persisted` is the `PersistedMessage`
 * row to interleave into chat history (typically
 * `{ role: "assistant", text: "", <cardField>: ... }`); `persist` is the durable
 * write context (`chatHistoryManager` + `sessionId`).
 *
 * Persisting here (step 3 — see the module docstring) is what guarantees the
 * card is in session history the instant it appears, closing the reconnect
 * window that made cards flicker out and back (docs/191). Lifecycle transitions
 * on an already-persisted card (e.g. filed/failed, undone) patch the DB row in
 * place via the relevant `ChatHistoryManager` method — they are not re-recorded
 * here.
 */
export function emitChatCard(
  runner: Pick<
    SessionRunnerInterface,
    "emitMessage" | "chatMessageGroups" | "recordedCards" | "steeredMessages"
  >,
  wsMessage: WsServerMessage,
  persisted: PersistedMessage,
  persist: CardPersistCtx,
): void {
  runner.emitMessage(wsMessage);
  recordChatCard(runner, persisted);
  persistTurnInProgress(persist.chatHistoryManager, runner, persist.sessionId);
}

/**
 * Emit a transcript card, REPLACING an already-recorded card from this same turn
 * whose message matches `matches`, or recording a fresh one if none matches.
 *
 * Use this — not `emitChatCard` twice or a DB-row `updateXCard` — for a card with
 * a stable id that can be patched WITHIN the turn that created it (docs/203
 * review → re-review). Both `submit_review` calls happen mid-turn, so a DB-only
 * patch would be clobbered by the next `replaceInProgress` rebuild from
 * `recordedCards`; the `updateBugReportCard` pattern only works because that
 * card's transitions land AFTER the proposing turn is finalized. Replacing the
 * recorded card's message in place keeps it at its original transcript anchor and
 * makes every rebuild — and the live re-emit — reflect the latest state. The
 * client handler keys on the card id, so the re-emit upserts rather than
 * duplicating. Returns whether an existing card was replaced.
 */
export function emitOrReplaceChatCard(
  runner: Pick<
    SessionRunnerInterface,
    "emitMessage" | "chatMessageGroups" | "recordedCards" | "steeredMessages"
  >,
  wsMessage: WsServerMessage,
  persisted: PersistedMessage,
  persist: CardPersistCtx,
  matches: (m: PersistedMessage) => boolean,
): { replaced: boolean } {
  const idx = runner.recordedCards.findIndex((c) => matches(c.message));
  if (idx < 0) {
    emitChatCard(runner, wsMessage, persisted, persist);
    return { replaced: false };
  }
  const updated = runner.recordedCards.slice();
  updated[idx] = { ...updated[idx], message: persisted };
  runner.recordedCards = updated;
  runner.emitMessage(wsMessage);
  persistTurnInProgress(persist.chatHistoryManager, runner, persist.sessionId);
  return { replaced: true };
}

/**
 * Patch an already-recorded card's persisted message IN PLACE, keyed by
 * `matches`, WITHOUT re-broadcasting the card. Returns true if a card matched.
 *
 * For a lifecycle transition that lands WITHIN the same turn that created the
 * card. The canonical case is a permission request resolved while the agent is
 * still BLOCKED mid-turn (docs/193): the proposing-turn row is still
 * `in_progress=1`, so the next `replaceInProgress` rebuild reads `recordedCards`
 * and a DB-only `updateXCard` patch would be clobbered back to the recorded
 * (pending) snapshot — the card reverts to its Approve/Deny variant on the next
 * switch/reload. Updating the recorded card here makes every rebuild — and the
 * final end-of-turn persist — carry the patched (terminal) state.
 *
 * This differs from `emitOrReplaceChatCard` on two axes: it does NOT re-emit the
 * card (the transition is communicated by a separate terminal WS message — e.g.
 * `permission_resolved` — that the client applies to its card store), and it
 * never records a fresh card when none matches (a transition for a card not in
 * this turn's recorded set means the proposing turn already finalized, so the
 * caller should fall back to the DB-row `updateXCard` patch, which is safe then).
 * Pair a successful patch with `persistTurnInProgress` to flush it to history.
 */
export function updateRecordedCard(
  runner: Pick<SessionRunnerInterface, "recordedCards">,
  matches: (m: PersistedMessage) => boolean,
  patch: (m: PersistedMessage) => PersistedMessage,
): boolean {
  const idx = runner.recordedCards.findIndex((c) => matches(c.message));
  if (idx < 0) return false;
  const updated = runner.recordedCards.slice();
  updated[idx] = { ...updated[idx], message: patch(updated[idx].message) };
  runner.recordedCards = updated;
  return true;
}

/**
 * docs/138 — build a `system_notice` WS message and its persisted chat row,
 * sharing one stable id. The id lets the client dedupe a notice re-delivered by
 * the turn-event buffer replay on reconnect against the copy already loaded from
 * history. Use the helpers below rather than constructing notices ad-hoc, so a
 * notice can never ship emit-only (the historical bug — notices survived a
 * reconnect via the buffer but vanished on a full reload).
 */
function buildSystemNotice(
  sessionId: string,
  message: string,
  level: "info" | "warn",
): { ws: WsSystemNotice; persisted: PersistedMessage } {
  const noticeId = `notice-${randomUUID()}`;
  return {
    ws: { type: "system_notice", sessionId, message, level, id: noticeId },
    persisted: { role: "assistant", text: message, notice: true, noticeLevel: level, noticeId },
  };
}

/**
 * Emit + persist a system notice that fires WITHIN a turn (e.g. a guarded-mode
 * banner on `agent_init`, a blocked-actions summary on `agent_result`). Recorded
 * in-band via `emitChatCard` so `buildTurnMessages` interleaves it at its true
 * transcript position when it flushes the turn, and persisted immediately so it
 * survives a mid-turn reconnect.
 */
export function emitNoticeInTurn(
  runner: Pick<
    SessionRunnerInterface,
    "emitMessage" | "chatMessageGroups" | "recordedCards" | "steeredMessages"
  >,
  sessionId: string,
  message: string,
  chatHistoryManager: InProgressPersister,
  level: "info" | "warn" = "info",
): void {
  const { ws, persisted } = buildSystemNotice(sessionId, message, level);
  emitChatCard(runner, ws, persisted, { chatHistoryManager, sessionId });
}

/**
 * Emit + persist a system notice that fires AFTER the turn's final persist (e.g.
 * an unresolved-merge-conflict warning during post-turn auto-commit) or outside
 * a turn entirely (a rewind queue-clear). `recordedCards` are already flushed by
 * then, so this appends the row directly — landing it at the current end of
 * history, which is the correct post-turn position. `emit` is the caller's
 * broadcast (`runner.emitMessage` or the per-connection `emit`).
 */
export function emitNoticePostTurn(
  emit: (m: WsServerMessage) => void,
  chatHistory: { append(sessionId: string, message: PersistedMessage): unknown },
  sessionId: string,
  message: string,
  level: "info" | "warn" = "info",
): void {
  const { ws, persisted } = buildSystemNotice(sessionId, message, level);
  emit(ws);
  chatHistory.append(sessionId, persisted);
}
