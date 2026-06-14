import { describe, it, expect } from "vitest";
import { emitChatCard, emitOrReplaceChatCard, recordChatCard, updateRecordedCard, persistTurnInProgress, emitNoticeInTurn, emitNoticePostTurn } from "./chat-card-persistence.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";
import type { WsServerMessage } from "../shared/types.js";

/**
 * The anti-footgun contract: a transcript card emitted via `emitChatCard` is
 * ALWAYS also recorded for in-band persistence AND persisted to chat history
 * immediately, so it can't ship emit-only or flicker out on a mid-turn reconnect
 * (the recurring bug behind docs/163 + docs/164 + docs/191). A fresh fake runner
 * per test is one isolated "turn".
 */
function fakeRunner(groups: { text: string; toolUse: unknown[] }[] = []): {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
  persisted: { sessionId: string; messages: PersistedMessage[] }[];
  chatHistoryManager: { replaceInProgress(sessionId: string, messages: PersistedMessage[]): void };
} {
  const emitted: WsServerMessage[] = [];
  const persisted: { sessionId: string; messages: PersistedMessage[] }[] = [];
  const chatHistoryManager = {
    replaceInProgress: (sessionId: string, messages: PersistedMessage[]) =>
      persisted.push({ sessionId, messages }),
  };
  const runner = {
    emitMessage: (m: WsServerMessage) => emitted.push(m),
    chatMessageGroups: groups,
    recordedCards: [],
    steeredMessages: [],
  } as unknown as SessionRunnerInterface;
  return { runner, emitted, persisted, chatHistoryManager };
}

describe("chat-card-persistence", () => {
  it("emitChatCard emits the WS message, records it, AND persists the turn immediately", () => {
    const { runner, emitted, persisted, chatHistoryManager } = fakeRunner([{ text: "did a thing", toolUse: [] }]);

    emitChatCard(
      runner,
      { type: "voice_note", sessionId: "s1", id: "v1", headline: "hi", needsAttention: false, kind: "authored", createdAt: "t" },
      { role: "assistant", text: "", voiceNote: { id: "v1", headline: "hi", needsAttention: false, kind: "authored", createdAt: "t" } },
      { chatHistoryManager, sessionId: "s1" },
    );

    // Emitted live for attached viewers...
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "voice_note", id: "v1" });
    // ...recorded for in-band interleaving...
    expect(runner.recordedCards).toHaveLength(1);
    expect(runner.recordedCards[0].message).toMatchObject({ role: "assistant", voiceNote: { id: "v1" } });
    // ...AND persisted to chat history in the SAME call (docs/191), so a
    // mid-turn reconnect's loadSessionHistory snapshot already contains the
    // card — no flicker-out-then-back window.
    expect(persisted).toHaveLength(1);
    expect(persisted[0].sessionId).toBe("s1");
    expect(persisted[0].messages.find((m) => (m as { voiceNote?: unknown }).voiceNote)).toMatchObject({
      voiceNote: { id: "v1" },
    });
  });

  it("emitOrReplaceChatCard records a new card, then REPLACES it in place on a matching re-emit (docs/203)", () => {
    const { runner, emitted, persisted, chatHistoryManager } = fakeRunner([{ text: "reviewed", toolUse: [] }]);
    const ctx = { chatHistoryManager, sessionId: "s1" };
    const matches = (m: PersistedMessage) => (m as { aiReview?: { reviewId?: string } }).aiReview?.reviewId === "r1";

    const ws = (markdown: string, reReviewed: boolean): WsServerMessage =>
      ({ type: "ai_review_added", sessionId: "s1", card: { reviewId: "r1", filePath: "a.ts", markdown, reviewerLabel: "Reviewed by Codex", createdAt: "t", reReviewed } } as unknown as WsServerMessage);
    const row = (markdown: string, reReviewed: boolean): PersistedMessage =>
      ({ role: "assistant", text: "", aiReview: { reviewId: "r1", filePath: "a.ts", markdown, reviewerLabel: "Reviewed by Codex", createdAt: "t", reReviewed } } as unknown as PersistedMessage);

    // First submit → records a new card.
    expect(emitOrReplaceChatCard(runner, ws("issue A", false), row("issue A", false), ctx, matches)).toEqual({ replaced: false });
    expect(runner.recordedCards).toHaveLength(1);
    const anchor = runner.recordedCards[0].afterGroupIndex;

    // Re-review → replaces in place: still ONE card, same anchor, patched message.
    expect(emitOrReplaceChatCard(runner, ws("clean", true), row("clean", true), ctx, matches)).toEqual({ replaced: true });
    expect(runner.recordedCards).toHaveLength(1);
    expect(runner.recordedCards[0].afterGroupIndex).toBe(anchor);
    expect((runner.recordedCards[0].message as { aiReview?: { markdown?: string; reReviewed?: boolean } }).aiReview)
      .toMatchObject({ markdown: "clean", reReviewed: true });

    // Both the live emit and the durable persist happened on each call.
    expect(emitted).toHaveLength(2);
    expect(persisted).toHaveLength(2);
  });

  it("anchors the card after the persistable assistant groups produced so far", () => {
    const { runner } = fakeRunner([
      { text: "one", toolUse: [] },
      { text: "", toolUse: [] }, // non-persistable (no text, no tools) — not counted
      { text: "two", toolUse: [] },
    ]);

    recordChatCard(runner, { role: "assistant", text: "", voiceNote: { id: "v1", headline: "h", needsAttention: false, kind: "authored", createdAt: "t" } });

    // Two persistable groups → anchor 2 (lands after both).
    expect(runner.recordedCards[0].afterGroupIndex).toBe(2);
  });

  describe("updateRecordedCard — mid-turn lifecycle transition (docs/193 permission clobber)", () => {
    interface PermMsg { permissionPrompt?: { requestId?: string; phase?: string; remembered?: boolean } }
    const findCard = (messages: PersistedMessage[], requestId: string) =>
      messages.find((m) => (m as PermMsg).permissionPrompt?.requestId === requestId) as PermMsg | undefined;

    it("patches a recorded card in place so a LATER in-turn rebuild keeps the terminal state", () => {
      // One persistable assistant group (the agent says it'll edit, with a tool).
      const { runner, persisted, chatHistoryManager } = fakeRunner([{ text: "I'll edit .npmrc", toolUse: [{}] }]);

      // 1. Permission card proposed mid-turn (pending), recorded + persisted —
      //    exactly what emitChatCard does on `agent_permission_request`.
      recordChatCard(runner, {
        role: "assistant",
        text: "",
        permissionPrompt: { requestId: "p1", phase: "pending", toolName: "Write", path: ".npmrc" },
      } as unknown as PersistedMessage);
      persistTurnInProgress(chatHistoryManager, runner, "s1");
      expect(findCard(persisted[persisted.length - 1].messages, "p1")?.permissionPrompt?.phase).toBe("pending");

      // 2. User approves WHILE the agent is still blocked mid-turn. Patch the
      //    recorded card (not just the DB row), then flush.
      const patched = updateRecordedCard(
        runner,
        (m) => (m as PermMsg).permissionPrompt?.requestId === "p1",
        (m) => ({
          ...m,
          permissionPrompt: { ...(m as Required<PermMsg>).permissionPrompt, phase: "approved", remembered: true },
        }) as unknown as PersistedMessage,
      );
      expect(patched).toBe(true);
      persistTurnInProgress(chatHistoryManager, runner, "s1");

      // 3. A LATER in-turn rebuild (next tool-result boundary, then end-of-turn)
      //    must STILL carry "approved". Before the fix, this rebuild read the
      //    recorded card — still pending — and clobbered the card back to its
      //    Approve/Deny variant on the next switch/reload.
      persistTurnInProgress(chatHistoryManager, runner, "s1");
      const finalCard = findCard(persisted[persisted.length - 1].messages, "p1");
      expect(finalCard?.permissionPrompt?.phase).toBe("approved");
      expect(finalCard?.permissionPrompt?.remembered).toBe(true);
    });

    it("returns false when no recorded card matches (caller falls back to the DB-row patch)", () => {
      const { runner } = fakeRunner();
      expect(updateRecordedCard(runner, () => true, (m) => m)).toBe(false);
    });
  });

  it("emitNoticeInTurn emits + records a notice with a shared id (docs/138)", () => {
    const { runner, emitted, persisted, chatHistoryManager } = fakeRunner([{ text: "x", toolUse: [] }]);
    emitNoticeInTurn(runner, "s1", "Guarded mode unavailable.", chatHistoryManager, "warn");
    // Persisted immediately too, like every other in-turn card (docs/191).
    expect(persisted).toHaveLength(1);

    expect(emitted).toHaveLength(1);
    const ws = emitted[0] as { type: string; id?: string; message?: string; level?: string };
    expect(ws).toMatchObject({ type: "system_notice", message: "Guarded mode unavailable.", level: "warn" });
    expect(ws.id).toMatch(/^notice-/);
    // Recorded in-band; the persisted row carries the SAME id for reload dedup.
    expect(runner.recordedCards).toHaveLength(1);
    const recorded = runner.recordedCards[0].message;
    expect(recorded).toMatchObject({ role: "assistant", notice: true, noticeLevel: "warn", noticeId: ws.id });
  });

  it("emitNoticePostTurn emits AND appends to history with a shared id", () => {
    const { runner, emitted } = fakeRunner();
    const appended: { sessionId: string; message: PersistedMessage }[] = [];
    const chatHistory = { append: (sessionId: string, message: PersistedMessage) => appended.push({ sessionId, message }) };

    emitNoticePostTurn((m) => runner.emitMessage(m), chatHistory, "s1", "Unresolved merge conflict.", "warn");

    expect(emitted).toHaveLength(1);
    const ws = emitted[0] as { type: string; id?: string };
    expect(ws).toMatchObject({ type: "system_notice", id: expect.stringMatching(/^notice-/) });
    // Persisted directly (post-turn → append, not recordedCards).
    expect(runner.recordedCards).toHaveLength(0);
    expect(appended).toHaveLength(1);
    expect(appended[0].message).toMatchObject({ notice: true, noticeLevel: "warn", noticeId: ws.id, text: "Unresolved merge conflict." });
  });
});
