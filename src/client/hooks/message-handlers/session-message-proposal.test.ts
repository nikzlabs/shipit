import { describe, it, expect, beforeEach } from "vitest";
import {
  handleSessionMessageProposalCard,
  handleSessionMessageProposalUpdate,
} from "./session-message-proposal.js";
import { dispatchMessage } from "./index.js";
import { useSessionStore } from "../../stores/session-store.js";
import type {
  WsSessionMessageProposalCard,
  WsSessionMessageProposalUpdate,
} from "../../../server/shared/types.js";

const ctx = {} as never;

const card = {
  cardId: "smp-1",
  targetSessionId: "ses_root",
  targetTitle: "Orchestrator",
  message: "docs/314 is implemented; the PR is open.",
  createdAt: "2026-09-22T10:00:00.000Z",
};

const cardMessage: WsSessionMessageProposalCard = {
  type: "session_message_proposal_card",
  sessionId: "ses_a",
  card,
};

const update = (over: Partial<WsSessionMessageProposalUpdate>): WsSessionMessageProposalUpdate => ({
  type: "session_message_proposal_update",
  sessionId: "ses_a",
  cardId: "smp-1",
  state: "delivering",
  ...over,
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSessionMessageProposalCard", () => {
  it("appends the card to the transcript", () => {
    handleSessionMessageProposalCard(ctx, cardMessage);
    expect(useSessionStore.getState().messages[0].sessionMessageProposal).toEqual(card);
  });

  it("does not duplicate a card already in the transcript on replay", () => {
    handleSessionMessageProposalCard(ctx, cardMessage);
    handleSessionMessageProposalCard(ctx, cardMessage);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});

describe("handleSessionMessageProposalUpdate", () => {
  beforeEach(() => handleSessionMessageProposalCard(ctx, cardMessage));

  it("marks the card delivered", () => {
    handleSessionMessageProposalUpdate(
      ctx,
      update({ state: "delivered", deliveredAt: "2026-09-22T10:01:00.000Z", queued: true }),
    );
    expect(useSessionStore.getState().messages[0].sessionMessageProposal).toMatchObject({
      state: "delivered",
      queued: true,
    });
  });

  it("clears a stale error when a retry starts", () => {
    handleSessionMessageProposalUpdate(ctx, update({ state: "failed", errorMessage: "boom" }));
    handleSessionMessageProposalUpdate(ctx, update({ state: "delivering" }));
    expect(useSessionStore.getState().messages[0].sessionMessageProposal?.errorMessage).toBeUndefined();
  });

  it("never reopens a delivered card, so a replayed 'delivering' cannot offer a second send", () => {
    handleSessionMessageProposalUpdate(ctx, update({ state: "delivered" }));
    handleSessionMessageProposalUpdate(ctx, update({ state: "delivering" }));
    expect(useSessionStore.getState().messages[0].sessionMessageProposal?.state).toBe("delivered");
  });

  it("ignores an update for a card that is not in the transcript", () => {
    handleSessionMessageProposalUpdate(ctx, update({ cardId: "smp-other", state: "delivered" }));
    expect(useSessionStore.getState().messages[0].sessionMessageProposal?.state).toBeUndefined();
  });
});

/**
 * Both messages render only in the PROPOSING session's transcript; the target's
 * id is a field on the card, never the message's owner. So a mismatch is a
 * foreign card and the client drops it.
 */
describe("transcript scoping", () => {
  it("drops a card belonging to another session, and keeps this session's", () => {
    useSessionStore.setState({ sessionId: "other", messages: [] });
    dispatchMessage(ctx, cardMessage);
    expect(useSessionStore.getState().messages).toHaveLength(0);

    useSessionStore.setState({ sessionId: "ses_a" });
    dispatchMessage(ctx, cardMessage);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("drops a foreign update, so it cannot rewrite this transcript", () => {
    useSessionStore.setState({ sessionId: "ses_a", messages: [] });
    dispatchMessage(ctx, cardMessage);

    dispatchMessage(ctx, { ...update({ state: "delivered" }), sessionId: "other" });
    expect(useSessionStore.getState().messages[0].sessionMessageProposal?.state).toBeUndefined();

    dispatchMessage(ctx, update({ state: "delivered" }));
    expect(useSessionStore.getState().messages[0].sessionMessageProposal?.state).toBe("delivered");
  });
});
