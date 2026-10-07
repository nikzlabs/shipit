import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleScheduleProposalCard, handleScheduleProposalUpdate } from "./schedule-proposal-card.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { ScheduleProposalCard, WsScheduleProposalCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (over: Partial<ScheduleProposalCard> = {}): ScheduleProposalCard => ({
  cardId: "sch-1",
  kind: "create",
  name: "Security PRs",
  values: [{ label: "When", after: "Weekdays at 09:00" }],
  prompt: { after: "Check the PRs." },
  timing: { kind: "weekdays", hour: 9, minute: 0 },
  timeZone: null,
  enabled: true,
  phase: "pending",
  createdAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

const event = (over: Partial<ScheduleProposalCard> = {}, sessionId = "s1"): WsScheduleProposalCard => ({
  type: "schedule_proposal_card",
  sessionId,
  card: card(over),
});

beforeEach(() => {
  useSessionStore.setState({ sessionId: "s1", messages: [] });
});

describe("the schedule proposal card handlers (docs/324-scheduled-sessions)", () => {
  it("appends the card once, however often it is replayed", () => {
    handleScheduleProposalCard(ctx, event());
    handleScheduleProposalCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", text: "", scheduleProposal: card() });
  });

  it("replaces the card on an update", () => {
    handleScheduleProposalCard(ctx, event());
    handleScheduleProposalUpdate(ctx, {
      type: "schedule_proposal_update",
      sessionId: "s1",
      cardId: "sch-1",
      card: card({ phase: "confirmed", scheduleId: "sched-1", timeZone: "Europe/Berlin" }),
    });
    expect(useSessionStore.getState().messages[0]?.scheduleProposal)
      .toMatchObject({ phase: "confirmed", scheduleId: "sched-1" });
  });

  it("drops a card of another session", () => {
    dispatchMessage(ctx, event({}, "s2"));
    expect(useSessionStore.getState().messages).toEqual([]);
  });
});
