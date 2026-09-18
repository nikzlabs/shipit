import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { handleModelInfo } from "./model-info.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { WsModelInfo, WsSessionForked } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const modelInfo = (sessionId: string, model: string, contextWindowTokens: number): WsModelInfo => ({
  type: "model_info",
  sessionId,
  model,
  contextWindowTokens,
});

/**
 * `modelInfo` is a session-less global read by the dial for the session on
 * screen, and — unlike the token count — nothing rewrites it until a turn
 * starts, so a foreign write stays visible.
 */
describe("handleModelInfo — session scoping", () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useUiStore.getState().reset();
    useSessionStore.setState({ sessionId: "s1" });
  });

  it("applies the reading for the session on screen", () => {
    handleModelInfo(ctx, modelInfo("s1", "claude-opus-4-8", 1_000_000));
    expect(useUiStore.getState().modelInfo).toEqual({
      model: "claude-opus-4-8",
      contextWindowTokens: 1_000_000,
    });
  });

  it("drops a reading naming another session", () => {
    handleModelInfo(ctx, modelInfo("s1", "claude-opus-4-8", 1_000_000));
    handleModelInfo(ctx, modelInfo("other", "gpt-5.6-sol", 272_000));
    expect(useUiStore.getState().modelInfo?.model).toBe("claude-opus-4-8");
  });

  /**
   * The hole socket teardown cannot close: `useMessageHandler` drains into a
   * local array, so a batch that moves the active session part-way through
   * still dispatches the rest of the parent's messages.
   */
  it("does not follow the parent's model onto a child adopted mid-batch", () => {
    useSessionStore.setState({ sessionId: "parent" });
    handleModelInfo(ctx, modelInfo("parent", "gpt-5.6-sol", 272_000));
    expect(useUiStore.getState().modelInfo?.model).toBe("gpt-5.6-sol");

    const batch = [
      { type: "session_forked", parentSessionId: "parent", childSessionId: "child" } as WsSessionForked,
      modelInfo("parent", "gpt-5.6-sol", 272_000),
    ];
    for (const msg of batch) dispatchMessage(ctx, msg);

    expect(useSessionStore.getState().sessionId).toBe("child");
    expect(useUiStore.getState().modelInfo).toBeNull();
  });
});
