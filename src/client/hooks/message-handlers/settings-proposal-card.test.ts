import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSettingsProposalCard, handleSettingsProposalUpdate } from "./settings-proposal-card.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { SettingsProposalCard, WsSettingsProposalCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (over: Partial<SettingsProposalCard> = {}): SettingsProposalCard => ({
  cardId: "set-1",
  target: { key: "advanced.enableSubAgents" },
  label: "Multi-agent sessions",
  description: "Let the agent start child sessions and consult other agents.",
  path: "Settings › Advanced",
  from: "off",
  to: "on",
  reason: "The review you asked for runs as a separate agent.",
  phase: "pending",
  createdAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

const event = (over: Partial<SettingsProposalCard> = {}): WsSettingsProposalCard => ({
  type: "settings_proposal_card",
  sessionId: "s1",
  card: card(over),
});

beforeEach(() => {
  useSessionStore.setState({ sessionId: "s1", messages: [] });
});

describe("handleSettingsProposalCard (docs/299-agent-settings-access)", () => {
  it("appends the card as its own transcript row, carrying the whole payload", () => {
    handleSettingsProposalCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      settingsProposal: { cardId: "set-1", phase: "pending", from: "off", to: "on" },
    });
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleSettingsProposalCard(ctx, event());
    handleSettingsProposalCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  /**
   * The exact reconnect shape: a history load installs the persisted row, then
   * the turn-event buffer replays the card message over it. Two rows here would
   * show the user one proposal twice, each with its own Apply.
   */
  it("does not duplicate a card the history load already installed", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", settingsProposal: card() }],
    });
    handleSettingsProposalCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("keeps the resolved phase from history when the replay carries the pending one", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", settingsProposal: card({ phase: "applied" }) }],
    });
    handleSettingsProposalCard(ctx, event({ phase: "pending" }));
    expect(useSessionStore.getState().messages[0].settingsProposal?.phase).toBe("applied");
  });

  it("appends distinct cards with different ids", () => {
    handleSettingsProposalCard(ctx, event({ cardId: "set-1" }));
    handleSettingsProposalCard(ctx, event({ cardId: "set-2" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });

  it("is transcript-scoped: a card for another session never lands in this transcript", () => {
    useSessionStore.setState({ sessionId: "active", messages: [] });

    dispatchMessage(ctx, { ...event({ cardId: "foreign" }), sessionId: "other" });
    expect(useSessionStore.getState().messages).toHaveLength(0);

    dispatchMessage(ctx, { ...event({ cardId: "mine" }), sessionId: "active" });
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});

describe("handleSettingsProposalUpdate", () => {
  it("replaces the card in place, so the row collapses where it already sits", () => {
    handleSettingsProposalCard(ctx, event());

    handleSettingsProposalUpdate(ctx, {
      type: "settings_proposal_update",
      sessionId: "s1",
      cardId: "set-1",
      card: card({ phase: "applied", resolvedAt: "2026-09-14T00:05:00.000Z", outcome: "Multi-agent sessions is on" }),
    });

    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].settingsProposal).toMatchObject({
      phase: "applied",
      outcome: "Multi-agent sessions is on",
    });
  });

  it("leaves other cards alone, and adds nothing for a card it does not have", () => {
    handleSettingsProposalCard(ctx, event({ cardId: "set-1" }));
    handleSettingsProposalCard(ctx, event({ cardId: "set-2" }));

    handleSettingsProposalUpdate(ctx, {
      type: "settings_proposal_update",
      sessionId: "s1",
      cardId: "set-missing",
      card: card({ cardId: "set-missing", phase: "dismissed" }),
    });

    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.settingsProposal?.phase)).toEqual(["pending", "pending"]);
  });

  it("is transcript-scoped, so a foreign resolution cannot rewrite this transcript", () => {
    useSessionStore.setState({ sessionId: "active", messages: [] });
    dispatchMessage(ctx, { ...event({ cardId: "mine" }), sessionId: "active" });

    dispatchMessage(ctx, {
      type: "settings_proposal_update",
      sessionId: "other",
      cardId: "mine",
      card: card({ cardId: "mine", phase: "applied" }),
    });

    expect(useSessionStore.getState().messages[0].settingsProposal?.phase).toBe("pending");
  });
});
