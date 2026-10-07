import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import {
  applyScheduleNotesAccessUpdate,
  handleScheduleNotesAccessCard,
  handleScheduleNotesAccessUpdate,
} from "./schedule-notes-access-card.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { ScheduleNotesAccessCard, WsScheduleNotesAccessCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (over: Partial<ScheduleNotesAccessCard> = {}): ScheduleNotesAccessCard => ({
  cardId: "na-1",
  scheduleId: "sched-1",
  scheduleName: "Nightly triage",
  phase: "pending",
  createdAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

const event = (over: Partial<ScheduleNotesAccessCard> = {}, sessionId = "s1"): WsScheduleNotesAccessCard => ({
  type: "schedule_notes_access_card",
  sessionId,
  card: card(over),
});

beforeEach(() => {
  useSessionStore.setState({ sessionId: "s1", messages: [] });
});

describe("the schedule notes access card handlers (docs/324-scheduled-sessions)", () => {
  it("appends the card once, however often it is replayed", () => {
    handleScheduleNotesAccessCard(ctx, event());
    handleScheduleNotesAccessCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", text: "", scheduleNotesAccess: card() });
  });

  it("keeps a second card for another schedule", () => {
    handleScheduleNotesAccessCard(ctx, event());
    handleScheduleNotesAccessCard(ctx, event({ cardId: "na-2", scheduleId: "sched-2" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });

  it("replaces only the matching card on an update", () => {
    handleScheduleNotesAccessCard(ctx, event());
    handleScheduleNotesAccessCard(ctx, event({ cardId: "na-2", scheduleId: "sched-2" }));
    handleScheduleNotesAccessUpdate(ctx, {
      type: "schedule_notes_access_update",
      sessionId: "s1",
      cardId: "na-1",
      card: card({ phase: "allowed", resolvedAt: "2026-10-07T00:01:00.000Z" }),
    });
    const [first, second] = useSessionStore.getState().messages;
    expect(first?.scheduleNotesAccess).toMatchObject({ phase: "allowed" });
    expect(second?.scheduleNotesAccess).toMatchObject({ cardId: "na-2", phase: "pending" });
  });

  it("applies a decision's response the same way", () => {
    handleScheduleNotesAccessCard(ctx, event());
    applyScheduleNotesAccessUpdate("na-1", card({ phase: "denied" }));
    expect(useSessionStore.getState().messages[0]?.scheduleNotesAccess?.phase).toBe("denied");
  });

  it("drops a card or an update of another session", () => {
    dispatchMessage(ctx, event({}, "s2"));
    expect(useSessionStore.getState().messages).toEqual([]);

    handleScheduleNotesAccessCard(ctx, event());
    dispatchMessage(ctx, {
      type: "schedule_notes_access_update",
      sessionId: "s2",
      cardId: "na-1",
      card: card({ phase: "allowed" }),
    });
    expect(useSessionStore.getState().messages[0]?.scheduleNotesAccess?.phase).toBe("pending");
  });
});
