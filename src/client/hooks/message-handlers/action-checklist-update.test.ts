import { afterEach, describe, expect, it } from "vitest";
import { handleActionChecklistUpdate } from "./action-checklist-update.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { HandlerContext } from "./types.js";

const ctx = {} as HandlerContext;
const card = {
  cardId: "a1",
  actions: [{ id: "1", label: "Open a PR", payload: "Open a PR" }],
  createdAt: "2026-09-13T00:00:00.000Z",
};

afterEach(() => useSessionStore.setState({ messages: [] }));

describe("handleActionChecklistUpdate", () => {
  it("records the submission the server accepted, so the card collapses with its turn", () => {
    useSessionStore.setState({ messages: [{ role: "assistant", text: "", actionChecklist: card }] });
    handleActionChecklistUpdate(ctx, {
      type: "action_checklist_update", sessionId: "s1", cardId: "a1", submittedAt: "2026-09-13T01:00:00.000Z",
    });
    expect(useSessionStore.getState().messages[0].actionChecklist?.submittedAt)
      .toBe("2026-09-13T01:00:00.000Z");
  });

  it("keeps the first submission and ignores an unknown card", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", actionChecklist: { ...card, submittedAt: "first" } }],
    });
    const before = useSessionStore.getState().messages;
    handleActionChecklistUpdate(ctx, {
      type: "action_checklist_update", sessionId: "s1", cardId: "a1", submittedAt: "second",
    });
    handleActionChecklistUpdate(ctx, {
      type: "action_checklist_update", sessionId: "s1", cardId: "nope", submittedAt: "third",
    });
    expect(useSessionStore.getState().messages).toBe(before);
  });
});
