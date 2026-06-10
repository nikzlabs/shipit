import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSystemNotice } from "./system-notice.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSystemNotice (docs/138)", () => {
  it("appends a notice bubble carrying the id for rehydration dedup", () => {
    handleSystemNotice(ctx, {
      type: "system_notice",
      sessionId: "s1",
      message: "Guarded mode unavailable — running in auto.",
      level: "warn",
      id: "notice-1",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "Guarded mode unavailable — running in auto.",
      notice: true,
      noticeLevel: "warn",
      noticeId: "notice-1",
    });
  });

  it("dedupes a persisted notice re-delivered by the buffer replay on reconnect", () => {
    const event = {
      type: "system_notice" as const,
      sessionId: "s1",
      message: "Unresolved merge conflict.",
      level: "warn" as const,
      id: "notice-dup",
    };
    handleSystemNotice(ctx, event);
    handleSystemNotice(ctx, event);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("appends transient (id-less) rewind notices unconditionally — they are emit-only", () => {
    const event = {
      type: "system_notice" as const,
      sessionId: "s1",
      message: "Cleared 2 queued messages as part of rewind.",
      level: "info" as const,
    };
    handleSystemNotice(ctx, event);
    handleSystemNotice(ctx, event);
    // No id → no dedup; both append (they live only for the rewind interaction).
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });
});
