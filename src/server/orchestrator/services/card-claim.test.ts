import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsProposalRow } from "../settings-proposal-store.js";
import { proposeSettingChange } from "./settings-propose.js";
import { SETTINGS_PROPOSAL_CARD } from "./settings-proposal.js";
import {
  claimDecisionCard,
  loadDecisionCard,
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
