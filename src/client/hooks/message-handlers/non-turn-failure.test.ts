import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleNonTurnFailureCard, handleNonTurnFailureDismissed } from "./non-turn-failure.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { WsNonTurnFailureCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const message = (over: Partial<WsNonTurnFailureCard["card"]> = {}): WsNonTurnFailureCard => ({
  type: "non_turn_failure_card",
  sessionId: "s1",
  card: {
    cardId: "ntf-1",
    purpose: "session-naming",
    serviceId: "deepseek",
    serviceName: "DeepSeek",
    billingMode: "key",
    modelId: "deepseek-v4-flash",
    fallback: "The session kept its placeholder title.",
    detail: "401 Unauthorized",
    createdAt: "2026-08-09T00:00:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleNonTurnFailureCard (docs/252 req 9)", () => {
  it("appends a card-carrying message naming the service that failed", () => {
    handleNonTurnFailureCard(ctx, message());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      nonTurnFailure: {
        cardId: "ntf-1",
        purpose: "session-naming",
        serviceName: "DeepSeek",
        fallback: "The session kept its placeholder title.",
      },
    });
  });

  // The card is BOTH persisted and buffered into the turn-event log, so a
  // reconnect delivers it twice.
  it("is idempotent by cardId", () => {
    handleNonTurnFailureCard(ctx, message());
    handleNonTurnFailureCard(ctx, message());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("omits absent optional fields rather than writing undefined", () => {
    handleNonTurnFailureCard(ctx, message({
      cardId: "ntf-2",
      serviceId: undefined,
      serviceName: undefined,
      billingMode: undefined,
      modelId: undefined,
      detail: undefined,
    }));
    const card = useSessionStore.getState().messages[0].nonTurnFailure!;
    expect("serviceName" in card).toBe(false);
    expect("detail" in card).toBe(false);
  });

  // Dismissal patches the row. Removing it would make a recurring failure look
  // like it never happened once the user acknowledged one instance.
  it("marks a card dismissed without removing it", () => {
    handleNonTurnFailureCard(ctx, message());
    handleNonTurnFailureDismissed(ctx, {
      type: "non_turn_failure_dismissed",
      sessionId: "s1",
      cardId: "ntf-1",
      dismissedAt: "2026-08-09T00:05:00.000Z",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].nonTurnFailure?.dismissedAt).toBe("2026-08-09T00:05:00.000Z");
  });

  // CLAUDE.md — the browser holds exactly ONE transcript, so a card carrying a
  // foreign `sessionId` has to be dropped by the dispatcher rather than landing
  // in whichever session happens to be active.
  it("is registered as transcript-scoped so a foreign card is dropped", () => {
    useSessionStore.setState({ sessionId: "other", messages: [] });
    dispatchMessage(ctx, message());
    expect(useSessionStore.getState().messages).toHaveLength(0);

    useSessionStore.setState({ sessionId: "s1" });
    dispatchMessage(ctx, message());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
