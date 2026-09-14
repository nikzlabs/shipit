import { describe, it, expect, beforeEach } from "vitest";
import {
  handleRepoSessionProposalCard,
  handleRepoSessionProposalUpdate,
} from "./repo-session-proposal.js";
import { useSessionStore } from "../../stores/session-store.js";
import type {
  WsRepoSessionProposalCard,
  WsRepoSessionProposalUpdate,
} from "../../../server/shared/types.js";

const ctx = {} as never;

const card = {
  cardId: "rsp-1",
  repo: "acme/api",
  repoUrl: "https://github.com/acme/api.git",
  registered: true,
  title: "Add cursor pagination",
  prompt: "Add cursor pagination to GET /events.",
  createdAt: "2026-09-14T10:00:00.000Z",
};

const cardMessage: WsRepoSessionProposalCard = {
  type: "repo_session_proposal_card",
  sessionId: "ses_a",
  card,
};

const update = (over: Partial<WsRepoSessionProposalUpdate>): WsRepoSessionProposalUpdate => ({
  type: "repo_session_proposal_update",
  sessionId: "ses_a",
  cardId: "rsp-1",
  state: "starting",
  ...over,
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleRepoSessionProposalCard", () => {
  it("appends the card to the transcript", () => {
    handleRepoSessionProposalCard(ctx, cardMessage);
    expect(useSessionStore.getState().messages).toHaveLength(1);
    expect(useSessionStore.getState().messages[0].repoSessionProposal).toEqual(card);
  });

  it("does not duplicate a card already in the transcript on replay", () => {
    handleRepoSessionProposalCard(ctx, cardMessage);
    handleRepoSessionProposalCard(ctx, cardMessage);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});

describe("handleRepoSessionProposalUpdate", () => {
  beforeEach(() => handleRepoSessionProposalCard(ctx, cardMessage));

  it("carries the started session id onto the card", () => {
    handleRepoSessionProposalUpdate(
      ctx,
      update({ state: "started", startedSessionId: "ses_child", startedAt: "2026-09-14T10:01:00.000Z" }),
    );
    expect(useSessionStore.getState().messages[0].repoSessionProposal).toMatchObject({
      state: "started",
      startedSessionId: "ses_child",
    });
  });

  it("clears a stale error when a retry starts", () => {
    handleRepoSessionProposalUpdate(ctx, update({ state: "failed", errorMessage: "boom" }));
    handleRepoSessionProposalUpdate(ctx, update({ state: "starting" }));
    expect(useSessionStore.getState().messages[0].repoSessionProposal?.errorMessage).toBeUndefined();
  });

  it("never reopens a started card, so a replayed 'starting' cannot lose the session id", () => {
    handleRepoSessionProposalUpdate(ctx, update({ state: "started", startedSessionId: "ses_child" }));
    handleRepoSessionProposalUpdate(ctx, update({ state: "starting" }));
    expect(useSessionStore.getState().messages[0].repoSessionProposal).toMatchObject({
      state: "started",
      startedSessionId: "ses_child",
    });
  });

  it("ignores an update for a card that is not in the transcript", () => {
    handleRepoSessionProposalUpdate(ctx, update({ cardId: "rsp-other", state: "started" }));
    expect(useSessionStore.getState().messages[0].repoSessionProposal?.state).toBeUndefined();
  });
});
