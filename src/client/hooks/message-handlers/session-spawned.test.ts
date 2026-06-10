import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionSpawned } from "./session-spawned.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSessionSpawned (docs/117)", () => {
  it("appends an assistant message carrying spawnedSession metadata", () => {
    handleSessionSpawned(ctx, {
      type: "session_spawned",
      sessionId: "parent",
      childSessionId: "child-1",
      title: "Add dark mode",
      branch: "shipit/dark-mode",
      spawnedAt: "2026-06-05T00:00:00.000Z",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      spawnedSession: { childSessionId: "child-1", title: "Add dark mode", branch: "shipit/dark-mode" },
    });
  });

  it("dedupes by childSessionId so a reconnect buffer-replay + history reload don't double-render", () => {
    const event = {
      type: "session_spawned" as const,
      sessionId: "parent",
      childSessionId: "child-dup",
      title: "Child",
      spawnedAt: "2026-06-05T00:00:00.000Z",
    };
    handleSessionSpawned(ctx, event);
    handleSessionSpawned(ctx, event);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
