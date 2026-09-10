// emitMessage alone survives reconnects, but does not persist transcript history.
import { randomUUID } from "node:crypto";
import type { WsServerMessage, WsSystemNotice } from "../shared/types.js";
import type {
  SessionRunnerInterface,
  ChatMessageGroup,
  SteeredMessage,
  RecordedChatCard,
} from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";
import { markMessagesCommitted, type CommittedBodyIds } from "./transcript-projection.js";

export interface InProgressPersister {
  replaceInProgress(sessionId: string, messages: PersistedMessage[]): void;
  append(sessionId: string, message: PersistedMessage): unknown;
  hasInProgress?(sessionId: string): boolean;
}

export interface CardPersistCtx {
  chatHistoryManager: InProgressPersister;
  sessionId: string;
}

// Rebuild cards and steers with assistant groups so replacement row IDs preserve their order.
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
    agentInterface: s.agentInterface,
    messageOrigin: s.messageOrigin,
    images: s.images,
    files: s.files,
    uploadPaths: s.uploadPaths,
    ...flag,
  });

  const persistedCard = (c: RecordedChatCard): PersistedMessage => ({
    ...c.message,
    ...flag,
  });

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
  for (const s of steered) {
    if (s.afterGroupIndex >= persistable.length) out.push(persistedSteer(s));
  }
  for (const c of recordedCards) {
    if (c.afterGroupIndex >= persistable.length) out.push(persistedCard(c));
  }
  return out;
}

export function persistTurnInProgress(
  chatHistoryManager: Pick<InProgressPersister, "replaceInProgress">,
  runner: {
    chatMessageGroups: ChatMessageGroup[];
    steeredMessages: SteeredMessage[];
    recordedCards: RecordedChatCard[];
    committedBodyIds?: CommittedBodyIds;
  },
  sessionId: string,
): void {
  const messages = buildTurnMessages(
    runner.chatMessageGroups,
    runner.steeredMessages,
    runner.recordedCards,
    { inProgress: true },
  );
  chatHistoryManager.replaceInProgress(sessionId, messages);
  // Mark the written snapshot, not live groups that can keep accumulating content.
  if (runner.committedBodyIds) markMessagesCommitted(runner.committedBodyIds, messages);
}

export function recordChatCard(
  runner: Pick<SessionRunnerInterface, "chatMessageGroups" | "recordedCards">,
  message: PersistedMessage,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.recordedCards = [...runner.recordedCards, { afterGroupIndex, message }];
}

export function emitChatCard(
  runner: Pick<
    SessionRunnerInterface,
    | "emitMessage"
    | "running"
    | "chatMessageGroups"
    | "recordedCards"
    | "steeredMessages"
    | "getTurnEventBuffer"
    | "lastPersistedBufferIndex"
  >,
  wsMessage: WsServerMessage,
  persisted: PersistedMessage,
  persist: CardPersistCtx,
): void {
  runner.emitMessage(wsMessage);

  // Rebuilding a finished turn would make the next turn delete this card.
  if (!runner.running) {
    persist.chatHistoryManager.append(persist.sessionId, persisted);
    return;
  }

  recordChatCard(runner, persisted);
  persistTurnInProgress(persist.chatHistoryManager, runner, persist.sessionId);

  // Replaying events already in the snapshot can overwrite the card's carrier message.
  if (typeof runner.getTurnEventBuffer === "function") {
    runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
  }
}

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

// Patch recorded state too, or the next turn rebuild will undo a database-only update.
export function persistCardTransition(
  runner: Pick<
    SessionRunnerInterface,
    | "running"
    | "recordedCards"
    | "chatMessageGroups"
    | "steeredMessages"
    | "getTurnEventBuffer"
    | "lastPersistedBufferIndex"
  >,
  persist: CardPersistCtx,
  matches: (m: PersistedMessage) => boolean,
  patchRecorded: (m: PersistedMessage) => PersistedMessage,
  patchDb: () => void,
): boolean {
  // running becomes true before old recordedCards clear; check actual in-progress rows.
  const turnOwnsInProgressRows =
    runner.running && (persist.chatHistoryManager.hasInProgress?.(persist.sessionId) ?? true);
  const patchedInFlight =
    turnOwnsInProgressRows && updateRecordedCard(runner, matches, patchRecorded);
  if (patchedInFlight) {
    persistTurnInProgress(persist.chatHistoryManager, runner, persist.sessionId);
    if (typeof runner.getTurnEventBuffer === "function") {
      runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
    }
  } else {
    patchDb();
  }
  return patchedInFlight;
}

// A shared ID deduplicates the live notice against history on reconnect.
export function buildSystemNotice(
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

export function emitNoticeInTurn(
  runner: Pick<
    SessionRunnerInterface,
    | "emitMessage"
    | "running"
    | "chatMessageGroups"
    | "recordedCards"
    | "steeredMessages"
    | "getTurnEventBuffer"
    | "lastPersistedBufferIndex"
  >,
  sessionId: string,
  message: string,
  chatHistoryManager: InProgressPersister,
  level: "info" | "warn" = "info",
): void {
  const { ws, persisted } = buildSystemNotice(sessionId, message, level);
  emitChatCard(runner, ws, persisted, { chatHistoryManager, sessionId });
}

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

export function persistNoticeUnattached(
  chatHistory: { append(sessionId: string, message: PersistedMessage): unknown },
  sessionId: string,
  message: string,
  level: "info" | "warn" = "info",
): void {
  const { persisted } = buildSystemNotice(sessionId, message, level);
  chatHistory.append(sessionId, persisted);
}
