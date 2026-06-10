import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionSpawnFailed } from "./session-spawn-failed.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSessionSpawnFailed (docs/117)", () => {
  it("appends an assistant message carrying spawnFailed metadata", () => {
    handleSessionSpawnFailed(ctx, {
      type: "session_spawn_failed",
      sessionId: "parent",
      id: "spawn-failed-1",
      message: "Per-turn spawn limit reached",
      statusCode: 429,
      reason: "quota_per_turn",
      title: "Child",
      failedAt: "2026-06-05T00:00:00.000Z",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      spawnFailed: { id: "spawn-failed-1", reason: "quota_per_turn", statusCode: 429 },
    });
  });

  it("dedupes by id so a reconnect buffer-replay + history reload don't double-render", () => {
    const event = {
      type: "session_spawn_failed" as const,
      sessionId: "parent",
      id: "spawn-failed-dup",
      message: "boom",
      statusCode: 500,
      reason: "error" as const,
      failedAt: "2026-06-05T00:00:00.000Z",
    };
    handleSessionSpawnFailed(ctx, event);
    handleSessionSpawnFailed(ctx, event);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
