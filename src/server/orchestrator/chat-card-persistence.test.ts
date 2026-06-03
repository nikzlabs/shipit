import { describe, it, expect } from "vitest";
import { emitChatCard, recordChatCard } from "./chat-card-persistence.js";
import type { SessionRunnerInterface } from "./session-runner.js";
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
});
