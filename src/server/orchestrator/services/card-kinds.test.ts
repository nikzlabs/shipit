import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SessionManager } from "../sessions.js";
import { SettingsProposalStore } from "../settings-proposal-store.js";
import { prepareCardOutcomeNotices } from "./card-kinds.js";

const SESSION = "sess-1";

let dbManager: DatabaseManager;
let history: ChatHistoryManager;
let proposals: SettingsProposalStore;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  new SessionManager(dbManager).track(SESSION, "A session");
  history = new ChatHistoryManager(dbManager);
  proposals = new SettingsProposalStore(dbManager);
});

afterEach(() => {
  dbManager.close();
});

function resolveSettingsProposal(cardId: string, sessionId = SESSION): void {
  proposals.create({
    cardId,
    sessionId,
    target: { key: "advanced.enableSubAgents" },
    operation: "set",
    phase: "applied",
    from: false,
    proposed: true,
    createdAt: "2026-10-07T00:00:00.000Z",
  });
}

describe("prepareCardOutcomeNotices", () => {
  it("owes nothing for a kind whose store this install lacks", () => {
    resolveSettingsProposal("set-a");
    expect(prepareCardOutcomeNotices({ chatHistoryManager: history }, SESSION)).toEqual([]);
  });

  it("collects the settings notice, and its receipt marks only the proposal it carried", () => {
    const stores = { chatHistoryManager: history, settingsProposals: proposals };
    new SessionManager(dbManager).track("sess-2", "Another session");
    resolveSettingsProposal("set-a");
    resolveSettingsProposal("set-other", "sess-2");

    const notices = prepareCardOutcomeNotices(stores, SESSION);
    resolveSettingsProposal("set-later");

    expect(notices).toHaveLength(1);
    expect(notices[0]?.notice).toContain("resolved a settings proposal you posted");
    expect(proposals.get("set-a")?.agentNotified).toBe(false);
    notices[0]?.delivered();
    expect(proposals.get("set-a")?.agentNotified).toBe(true);
    expect(proposals.get("set-later")?.agentNotified).toBe(false);
    expect(proposals.get("set-other")?.agentNotified).toBe(false);
    expect(prepareCardOutcomeNotices(stores, SESSION).map((n) => n.cardIds)).toEqual([["set-later"]]);
  });
});
