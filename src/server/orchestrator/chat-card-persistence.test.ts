import { describe, it, expect } from "vitest";
import { emitChatCard, recordChatCard, emitNoticeInTurn, emitNoticePostTurn } from "./chat-card-persistence.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";
import type { WsServerMessage } from "../shared/types.js";

/**
 * The anti-footgun contract: a transcript card emitted via `emitChatCard` is
 * ALWAYS also recorded for in-band persistence, so it can't ship emit-only and
 * vanish on a session switch / reload (the recurring bug behind docs/163 +
 * docs/164). A fresh fake runner per test is one isolated "turn".
 */
function fakeRunner(groups: { text: string; toolUse: unknown[] }[] = []): {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
} {
  const emitted: WsServerMessage[] = [];
  const runner = {
    emitMessage: (m: WsServerMessage) => emitted.push(m),
    chatMessageGroups: groups,
    recordedCards: [],
  } as unknown as SessionRunnerInterface;
  return { runner, emitted };
}

describe("chat-card-persistence", () => {
  it("emitChatCard both emits the WS message AND records it for persistence", () => {
    const { runner, emitted } = fakeRunner([{ text: "did a thing", toolUse: [] }]);

    emitChatCard(
      runner,
      { type: "voice_note", sessionId: "s1", id: "v1", headline: "hi", needsAttention: false, kind: "authored", createdAt: "t" },
      { role: "assistant", text: "", voiceNote: { id: "v1", headline: "hi", needsAttention: false, kind: "authored", createdAt: "t" } },
    );

    // Emitted live for attached viewers...
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "voice_note", id: "v1" });
    // ...AND recorded for in-band persistence so a reload keeps it.
    expect(runner.recordedCards).toHaveLength(1);
    expect(runner.recordedCards[0].message).toMatchObject({ role: "assistant", voiceNote: { id: "v1" } });
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

  it("emitNoticeInTurn emits + records a notice with a shared id (docs/138)", () => {
    const { runner, emitted } = fakeRunner([{ text: "x", toolUse: [] }]);
    emitNoticeInTurn(runner, "s1", "Guarded mode unavailable.", "warn");

    expect(emitted).toHaveLength(1);
    const ws = emitted[0] as { type: string; id?: string; message?: string; level?: string };
    expect(ws).toMatchObject({ type: "system_notice", message: "Guarded mode unavailable.", level: "warn" });
    expect(ws.id).toMatch(/^notice-/);
    // Recorded in-band; the persisted row carries the SAME id for reload dedup.
    expect(runner.recordedCards).toHaveLength(1);
    const persisted = runner.recordedCards[0].message;
    expect(persisted).toMatchObject({ role: "assistant", notice: true, noticeLevel: "warn", noticeId: ws.id });
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
