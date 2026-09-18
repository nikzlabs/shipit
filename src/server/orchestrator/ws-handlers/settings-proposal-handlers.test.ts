import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSettingsProposalDecision } from "./settings-proposal-handlers.js";
import { proposeSettingChange } from "../services/settings-propose.js";
import {
  proposalFixture,
  type ProposalFixture,
} from "../services/settings-proposal-test-helpers.js";
import type { WsServerMessage } from "../../shared/types.js";

/**
 * The transport half of a click (docs/299-agent-settings-access req 4).
 *
 * The handler owns two decisions and nothing else: the session is the
 * connection's rather than the message's, and a decision it cannot route reaches
 * the user as an error instead of silently doing nothing.
 */

let fx: ProposalFixture;
let sent: WsServerMessage[];

function ctxFor(activeSessionId: string | undefined) {
  sent = [];
  return {
    getActiveAppSessionId: () => activeSessionId,
    send: (m: WsServerMessage) => sent.push(m),
    sseBroadcast: vi.fn(),
    workspaceDir: fx.tmpDir,
    agentRegistry: { list: () => [], available: () => [] },
    sessionManager: fx.sessions,
    chatHistoryManager: fx.history,
    settingsProposals: fx.proposals,
    credentialStore: fx.credentialStore,
    egressAllowlistStore: fx.egressAllowlistStore,
    repoStore: fx.repoStore,
    getRunnerRegistry: () => ({ get: () => fx.runner }),
  } as unknown as Parameters<typeof handleSettingsProposalDecision>[0];
}

async function postCard(): Promise<string> {
  const card = await proposeSettingChange(fx.deps, fx.sessionId, {
    key: "advanced.autoFixCi",
    valueText: "true",
    reason: "the checks keep failing",
  });
  return card.cardId;
}

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  fx.close();
});

describe("handleSettingsProposalDecision", () => {
  it("applies the card in the connection's own session", async () => {
    const cardId = await postCard();

    await handleSettingsProposalDecision(ctxFor(fx.sessionId), {
      type: "settings_proposal_decision",
      cardId,
      action: "apply",
    });

    expect(fx.proposals.get(cardId)?.phase).toBe("applied");
    expect(fx.credentialStore.getAutoFixCi()).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("dismisses without writing anything", async () => {
    const cardId = await postCard();

    await handleSettingsProposalDecision(ctxFor(fx.sessionId), {
      type: "settings_proposal_decision",
      cardId,
      action: "dismiss",
    });

    expect(fx.proposals.get(cardId)?.phase).toBe("dismissed");
    expect(fx.credentialStore.getAutoFixCi()).toBe(false);
  });

  it("tells the user when a decision cannot be routed, rather than doing nothing", async () => {
    const cardId = await postCard();

    // A connection with no active session, and a card id that is not this
    // session's: neither may quietly resolve anything.
    await handleSettingsProposalDecision(ctxFor(undefined), {
      type: "settings_proposal_decision",
      cardId,
      action: "apply",
    });
    expect(sent[0]).toMatchObject({ type: "error" });

    fx.sessions.track("sess-2", "Another session");
    await handleSettingsProposalDecision(ctxFor("sess-2"), {
      type: "settings_proposal_decision",
      cardId,
      action: "apply",
    });
    expect(sent[0]).toMatchObject({ type: "error", message: expect.stringContaining("not in this session") });
    expect(fx.proposals.get(cardId)?.phase).toBe("pending");
  });

  it("refuses a message with no card or an action it does not have", async () => {
    await handleSettingsProposalDecision(ctxFor(fx.sessionId), {
      type: "settings_proposal_decision",
      cardId: "",
      action: "apply",
    });
    expect(sent[0]).toMatchObject({ type: "error" });

    await handleSettingsProposalDecision(ctxFor(fx.sessionId), {
      type: "settings_proposal_decision",
      cardId: "set-1",
      action: "delete" as "apply",
    });
    expect(sent[0]).toMatchObject({ type: "error" });
  });
});
