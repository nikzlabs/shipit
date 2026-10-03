import { beforeEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { resumeSessionInternal } from "../../stores/actions/session-actions.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (status: string): SessionStatus => ({ status, actions: [], fresh: true, writeSeq: 1, turnSeq: 0 });
const goal = { objective: "Ship it", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 1 };

beforeEach(() => {
  useSessionStore.setState({ sessionId: "s1", sessionDetails: {} });
});

describe("session_details", () => {
  it("stores the card and the goal under the session they belong to", () => {
    dispatchMessage(ctx, { type: "session_details", sessionId: "s1", sessionStatus: card("Mine."), agentGoal: goal });
    expect(useSessionStore.getState().sessionDetails.s1).toEqual({ sessionStatus: card("Mine."), agentGoal: goal });
  });

  // A switch can deliver the incoming session's first message before the store moves to it.
  it("keeps a message for a session that is not the store's current one, under that session", () => {
    dispatchMessage(ctx, { type: "session_details", sessionId: "s2", sessionStatus: card("Next."), agentGoal: null });
    const { sessionDetails } = useSessionStore.getState();
    expect(sessionDetails.s2?.sessionStatus?.status).toBe("Next.");
    expect(sessionDetails.s1).toBeUndefined();
  });

  it("is dropped on a switch, so a session never shows a copy from an earlier visit", () => {
    dispatchMessage(ctx, { type: "session_details", sessionId: "s1", sessionStatus: card("Old."), agentGoal: null });
    resumeSessionInternal("s2");
    expect(useSessionStore.getState().sessionDetails).toEqual({});
  });
});
