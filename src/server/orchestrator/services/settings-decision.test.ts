import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistTurnInProgress } from "../chat-card-persistence.js";
import { addMcpServer } from "./mcp.js";
import { SETTINGS_CHANGED_EVENT } from "./settings-apply.js";
import { recoverInterruptedProposals, resolveSettingsProposal } from "./settings-decision.js";
import { proposeSettingChange } from "./settings-propose.js";
import { claimSettingsProposal } from "./settings-proposal.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";

/**
 * The click (docs/299-agent-settings-access req 4, plan.md → Applying).
 *
 * The guards here are the ones the design names: one apply per card however many
 * clicks arrive, a claim that a turn snapshot cannot undo, a baseline compared
 * over stored bytes rather than the displayed value, and settlement that needs
 * no runner.
 */

let fx: ProposalFixture;

function post(over: Partial<Parameters<typeof proposeSettingChange>[2]> = {}) {
  return proposeSettingChange(fx.deps, fx.sessionId, {
    key: "advanced.enableSubAgents",
    valueText: "false",
    reason: "the review needs it off",
    ...over,
  });
}

function decide(cardId: string, action: "apply" | "dismiss" = "apply") {
  return resolveSettingsProposal(fx.deps, fx.sessionId, cardId, action);
}

function settingsBroadcasts(): unknown[] {
  return fx.broadcasts.filter((b) => b.event === SETTINGS_CHANGED_EVENT).map((b) => b.data);
}

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  fx.close();
});

describe("resolveSettingsProposal — apply", () => {
  it("writes the value through the shared layer and resolves the card as applied", async () => {
    const card = await post();

    const { card: resolved, acted } = await decide(card.cardId);

    expect(acted).toBe(true);
    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toContain("off");
    expect(fx.credentialStore.getEnableSubAgents()).toBe(false);
    // The whole act the settings route does, not just the store write.
    expect(settingsBroadcasts()).toHaveLength(1);
    // Both halves of the card's phase, and they cannot disagree.
    expect(fx.proposals.get(card.cardId)?.phase).toBe("applied");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("applied");
  });

  it("produces ONE apply when two decisions arrive for one card", async () => {
    const card = await post();

    const [first, second] = await Promise.all([decide(card.cardId), decide(card.cardId)]);

    // The claim is the test: the loser changed no rows, so it has nothing to
    // apply and says so rather than writing the setting a second time.
    expect([first.acted, second.acted].sort()).toEqual([false, true]);
    expect(settingsBroadcasts()).toHaveLength(1);
    expect(fx.proposals.get(card.cardId)?.phase).toBe("applied");
  });

  it("does not act on a card that is already resolved", async () => {
    const card = await post();
    await decide(card.cardId);
    fx.broadcasts.length = 0;

    const again = await decide(card.cardId);

    expect(again.acted).toBe(false);
    expect(settingsBroadcasts()).toHaveLength(0);
  });

  it("keeps the claim when a turn snapshot rebuilds the in-progress rows", async () => {
    const card = await post();
    claimSettingsProposal(fx.deps, fx.sessionId, card.cardId, "pending", { phase: "applying" });

    // What the next turn snapshot does: rebuild the in-progress rows from the
    // cards the runner is holding. A claim written only to the database is
    // undone here, and the card goes back in front of the user mid-apply.
    persistTurnInProgress(fx.deps.chatHistoryManager, fx.runner, fx.sessionId);

    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("applying");
    expect(fx.proposals.get(card.cardId)?.phase).toBe("applying");
  });

  it("settles with no runner at all, hours after the turn ended", async () => {
    const card = await post();
    fx.loseRunner();

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("applied");
    expect(fx.credentialStore.getEnableSubAgents()).toBe(false);
  });

  it("adds a host to the allowlist, and says what it did in ShipIt's own words", async () => {
    const card = await post({
      key: "network.egress.hosts[].host",
      operation: "add",
      item: "registry.npmjs.org",
      valueText: undefined,
    });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toContain("registry.npmjs.org");
    expect(fx.egressAllowlistStore.listHosts("global")).toContain("registry.npmjs.org");
  });
});

describe("resolveSettingsProposal — stale", () => {
  it("applies nothing when the setting moved after the card was written", async () => {
    const card = await post();
    // Somebody else — the dialog, another session's card — writes it first.
    fx.credentialStore.setEnableSubAgents(false);

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("stale");
    expect(settingsBroadcasts()).toHaveLength(0);
  });

  it("is stale when only a field the card never showed changed", async () => {
    // The projection emits an MCP server's name, transport and enabled flag and
    // nothing else, so this rewrite leaves the card's `from` reading exactly as
    // it did. Comparing that displayed value instead of the stored revision
    // makes this test pass with the defect in place — the whole reason the
    // baseline is taken over the stored object.
    addMcpServer(
      fx.credentialStore,
      { name: "notion", type: "stdio", command: "notion-mcp", args: ["--token=first"] },
      {},
    );
    const card = await post({
      key: "mcp.servers[].enabled",
      item: "notion",
      valueText: "false",
    });
    expect(card.from).toBe("on");

    fx.credentialStore.setMcpServer("notion", {
      name: "notion",
      type: "stdio",
      command: "notion-mcp",
      args: ["--token=second"],
      enabled: true,
    });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("stale");
    expect(fx.credentialStore.getMcpServer("notion")?.enabled).toBe(true);
  });
});

describe("resolveSettingsProposal — refused", () => {
  it("refuses at apply time what propose accepted, when the target has gone", async () => {
    addMcpServer(fx.credentialStore, { name: "notion", type: "stdio", command: "notion-mcp" }, {});
    const card = await post({ key: "mcp.servers[].enabled", item: "notion", valueText: "false" });

    fx.credentialStore.deleteMcpServer("notion");

    const { card: resolved } = await decide(card.cardId);

    // Stale would also be true here; what matters is that nothing was written
    // and the card says why in words the user can act on.
    expect(["refused", "stale"]).toContain(resolved.phase);
    expect(settingsBroadcasts()).toHaveLength(0);
  });
});

describe("resolveSettingsProposal — dismiss", () => {
  it("resolves without a lock, a re-read or a write", async () => {
    const card = await post();

    const { card: resolved, acted } = await decide(card.cardId, "dismiss");

    expect(acted).toBe(true);
    expect(resolved.phase).toBe("dismissed");
    expect(resolved.resolvedAt).toBeTruthy();
    // Declining cannot become stale, and it changes nothing.
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
    expect(settingsBroadcasts()).toHaveLength(0);
  });

  it("cannot be dismissed twice, and cannot be applied after being dismissed", async () => {
    const card = await post();
    await decide(card.cardId, "dismiss");

    expect((await decide(card.cardId, "dismiss")).acted).toBe(false);
    expect((await decide(card.cardId)).acted).toBe(false);
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
  });
});

describe("a decision that names another session's card", () => {
  it("is refused rather than reaching the proposal it shares an id with", async () => {
    const card = await post();
    fx.sessions.track("sess-2", "Another session");

    await expect(resolveSettingsProposal(fx.deps, "sess-2", card.cardId, "apply")).rejects.toThrow(
      /not in this session/,
    );
    expect(fx.proposals.get(card.cardId)?.phase).toBe("pending");
  });
});

describe("recoverInterruptedProposals", () => {
  it("converts a card found mid-apply, and never retries it", async () => {
    const card = await post();
    claimSettingsProposal(fx.deps, fx.sessionId, card.cardId, "pending", { phase: "applying" });

    expect(recoverInterruptedProposals(fx.deps)).toBe(1);

    // Both halves, because boot has no runner to patch either.
    expect(fx.proposals.get(card.cardId)?.phase).toBe("unknown");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("unknown");
    // The side effect may already have run, so nothing runs it again — and a
    // later click finds nothing to claim.
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
    expect((await decide(card.cardId)).acted).toBe(false);
  });

  it("leaves a pending card alone: it is the user's to decide, not a leftover", async () => {
    const card = await post();

    expect(recoverInterruptedProposals(fx.deps)).toBe(0);
    expect(fx.proposals.get(card.cardId)?.phase).toBe("pending");
  });
});
