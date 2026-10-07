import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsProposalRow } from "../settings-proposal-store.js";
import { proposeSettingChange } from "./settings-propose.js";
import { SETTINGS_PROPOSAL_CARD } from "./settings-proposal.js";
import {
  claimDecisionCard,
  claimDecisionCardWith,
  loadDecisionCard,
  transitionDecisionCard,
  type CardClaimDeps,
  type DecisionCardKind,
} from "./card-claim.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";

/**
 * The claim shared by every card kind (docs/324-scheduled-sessions plan.md →
 * Cards: proposals and approvals). Settings proposals are the only kind in this
 * build, so the kind under test is theirs, with real stores.
 */

let fx: ProposalFixture;

function claimDeps(): CardClaimDeps<"settingsProposal", SettingsProposalRow> {
  return {
    chatHistoryManager: fx.history,
    records: fx.proposals,
    getRunnerRegistry: fx.deps.getRunnerRegistry,
  };
}

async function post(): Promise<string> {
  const card = await proposeSettingChange(fx.deps, fx.sessionId, {
    key: "advanced.enableSubAgents",
    valueText: "false",
  });
  fx.emitted.length = 0;
  return card.cardId;
}

function dropTranscript(): void {
  fx.dbManager.db.prepare("DELETE FROM messages WHERE session_id = ?").run(fx.sessionId);
}

function dropRecord(cardId: string): void {
  fx.dbManager.db.prepare("DELETE FROM settings_proposals WHERE card_id = ?").run(cardId);
}

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  fx.close();
});

describe("loadDecisionCard", () => {
  it("names the card by its kind when it refuses", () => {
    const kind: DecisionCardKind<"settingsProposal"> = { ...SETTINGS_PROPOSAL_CARD, noun: "schedule proposal" };
    expect(() => loadDecisionCard(kind, claimDeps(), fx.sessionId, "card-missing"))
      .toThrow("That schedule proposal is not in this session.");
  });

  it("refuses a card whose record has gone, and leaves its transcript row as it was", async () => {
    const cardId = await post();
    dropRecord(cardId);

    expect(() => loadDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId))
      .toThrow(/not in this session/);
    expect(fx.history.getSettingsProposalCard(fx.sessionId, cardId)?.phase).toBe("pending");
  });

  it("refuses a card that has left the transcript, and leaves its record as it was", async () => {
    const cardId = await post();
    dropTranscript();

    expect(() => loadDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId))
      .toThrow(/not in this session/);
    expect(fx.proposals.get(cardId)?.phase).toBe("pending");
  });

  it("refuses a card named under another session", async () => {
    const cardId = await post();
    fx.sessions.track("sess-2", "Another session");

    expect(() => loadDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), "sess-2", cardId))
      .toThrow(/not in this session/);
  });
});

describe("claimDecisionCard", () => {
  it("claims nothing, and leaves the record where it was, when the card leaves the transcript after the load", async () => {
    const cardId = await post();
    loadDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId);
    dropTranscript();

    const claimed = claimDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId, "pending", {
      phase: "applying",
    });

    expect(claimed).toBeNull();
    expect(fx.proposals.get(cardId)?.phase).toBe("pending");
    expect(fx.emitted).toEqual([]);
  });

  it("tells viewers through the kind's own update message", async () => {
    const cardId = await post();
    const updated = vi.fn(SETTINGS_PROPOSAL_CARD.updated);
    const kind: DecisionCardKind<"settingsProposal"> = { ...SETTINGS_PROPOSAL_CARD, updated };

    const claimed = claimDecisionCard(kind, claimDeps(), fx.sessionId, cardId, "pending", { phase: "applying" });

    expect(updated).toHaveBeenCalledWith(fx.sessionId, cardId, claimed);
    expect(fx.emitted).toEqual([updated.mock.results[0]?.value]);
  });
});

describe("claimDecisionCardWith", () => {
  const sessionCount = () => (fx.dbManager.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

  it("commits the write with the claim, and joins what it returns to the card", async () => {
    const cardId = await post();
    const claimed = claimDecisionCardWith(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId, "pending",
      { phase: "applied" },
      () => {
        fx.sessions.track("written-with-the-claim", "W");
        return { outcome: "written" };
      });
    expect(claimed).toMatchObject({ phase: "applied", outcome: "written" });
    expect(fx.sessions.get("written-with-the-claim")).toBeDefined();
  });

  it("rolls the write back when another click claimed the card first", async () => {
    const cardId = await post();
    claimDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId, "pending", { phase: "dismissed" });
    fx.emitted.length = 0;
    const before = sessionCount();

    const claimed = claimDecisionCardWith(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId, "pending",
      { phase: "applied" },
      () => {
        fx.sessions.track("lost-the-race", "L");
        return {};
      });

    expect(claimed).toBeNull();
    expect(sessionCount()).toBe(before);
    expect(fx.emitted).toEqual([]);
  });

  it("leaves the record and the runner as they were when the write throws", async () => {
    const cardId = await post();
    const recorded = [...fx.runner.recordedCards];

    expect(() => claimDecisionCardWith(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId, "pending",
      { phase: "applied" },
      () => { throw new Error("refused"); })).toThrow("refused");

    expect(fx.proposals.get(cardId)?.phase).toBe("pending");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, cardId)?.phase).toBe("pending");
    expect(fx.runner.recordedCards).toEqual(recorded);
    expect(fx.emitted).toEqual([]);
  });
});

describe("transitionDecisionCard", () => {
  it("writes neither half when the card's record has gone", async () => {
    const cardId = await post();
    dropRecord(cardId);

    const moved = transitionDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(), fx.sessionId, cardId, {
      phase: "applied",
    });

    expect(moved).toBeNull();
    expect(fx.history.getSettingsProposalCard(fx.sessionId, cardId)?.phase).toBe("pending");
    expect(fx.emitted).toEqual([]);
  });
});
