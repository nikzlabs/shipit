import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionForked } from "./session-forked.js";
import type { HandlerContext } from "./types.js";
import type { WsSessionForked } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const forked = (childSessionId: string): WsSessionForked => ({
  type: "session_forked",
  parentSessionId: "parent",
  childSessionId,
  title: "Forked session",
  branch: "shipit/child",
});

/**
 * docs/144-rewind-fork-ux D7 — the client auto-switches to the child. It has to
 * go through the switch path: a bare `setSessionId` moves the store id before
 * the route, so `useSessionActivation` finds the two already equal and skips
 * `resumeSessionInternal`, leaving the child wearing the parent's session state.
 */
describe("handleSessionForked — adopting the child", () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useUiStore.getState().reset();
    useSessionStore.setState({ sessionId: "parent" });
  });

  it("switches to the child and moves the route", () => {
    handleSessionForked(ctx, forked("child"));
    expect(useSessionStore.getState().sessionId).toBe("child");
    expect(window.location.pathname).toBe("/session/child");
  });

  it("does not carry the parent's dial and spend onto the child", () => {
    useUiStore.getState().setModelInfo({ model: "gpt-5.6-sol", contextWindowTokens: 272_000 });
    useUiStore.getState().setContextTokens(180_000);
    useUiStore.getState().setCumulativeTokens(9000, 900);

    handleSessionForked(ctx, forked("child"));

    const ui = useUiStore.getState();
    expect(ui.modelInfo).toBeNull();
    expect(ui.contextTokens).toBe(0);
    expect(ui.cumulativeInputTokens).toBe(0);
    expect(ui.cumulativeOutputTokens).toBe(0);
  });

  it("makes the child's transcript reload rather than inheriting the parent's", () => {
    useSessionStore.getState().setMessages([{ role: "user", text: "parent turn" }]);
    useSessionStore.getState().setHistoryLoaded(true);

    handleSessionForked(ctx, forked("child"));

    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().historyLoaded).toBe(false);
  });

  it("ignores a message that names no child", () => {
    handleSessionForked(ctx, { ...forked("child"), childSessionId: undefined as unknown as string });
    expect(useSessionStore.getState().sessionId).toBe("parent");
  });
});
