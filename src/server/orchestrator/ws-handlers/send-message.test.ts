import { describe, it, expect, vi } from "vitest";
import { recordActionChecklistSubmission } from "./send-message.js";
import type { ActionChecklistCard } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";

const card: ActionChecklistCard = {
  cardId: "a1",
  actions: [{ id: "1", label: "Open a PR", payload: "Open a PR" }],
  createdAt: "2026-09-13T00:00:00.000Z",
};

function makeCtx(found: ActionChecklistCard | null, dbUpdates: unknown[], flushed: unknown[]) {
  return {
    getActiveAppSessionId: () => "s1",
    chatHistoryManager: {
      findActionChecklistCard: () => found,
      updateActionChecklistCard: (_s: string, _c: string, patch: unknown) => { dbUpdates.push(patch); return true; },
      replaceInProgress: (_s: string, m: unknown) => flushed.push(m),
      hasInProgress: () => true,
    },
  } as never;
}

describe("recordActionChecklistSubmission", () => {
  it("patches the running turn's recorded card, which a database-only write would lose", () => {
    const dbUpdates: unknown[] = [];
    const flushed: unknown[] = [];
    const runner = {
      running: true,
      emitMessage: vi.fn(),
      recordedCards: [{ afterGroupIndex: 0, message: { role: "assistant", text: "", actionChecklist: card } }],
      chatMessageGroups: [{ text: "here is what I would do next", toolUse: [{}] }],
      steeredMessages: [],
    } as unknown as SessionRunnerInterface;

    recordActionChecklistSubmission(makeCtx(card, dbUpdates, flushed), runner, "a1");

    const patched = runner.recordedCards[0].message as { actionChecklist?: ActionChecklistCard };
    expect(patched.actionChecklist?.submittedAt).toBeTruthy();
    expect(dbUpdates).toHaveLength(0);
    expect(flushed.length).toBeGreaterThan(0);
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "action_checklist_update", cardId: "a1", sessionId: "s1" }),
    );
  });

  it("writes the database when the proposing turn has already finished", () => {
    const dbUpdates: unknown[] = [];
    const runner = {
      running: false,
      emitMessage: vi.fn(),
      recordedCards: [],
      chatMessageGroups: [],
      steeredMessages: [],
    } as unknown as SessionRunnerInterface;

    recordActionChecklistSubmission(makeCtx(card, dbUpdates, []), runner, "a1");

    expect(dbUpdates).toHaveLength(1);
    expect((dbUpdates[0] as { submittedAt?: string }).submittedAt).toBeTruthy();
  });

  it("keeps the first submission — the field records that the user acted, not how often", () => {
    const dbUpdates: unknown[] = [];
    const runner = {
      running: false, emitMessage: vi.fn(), recordedCards: [], chatMessageGroups: [], steeredMessages: [],
    } as unknown as SessionRunnerInterface;

    recordActionChecklistSubmission(
      makeCtx({ ...card, submittedAt: "2026-09-13T01:00:00.000Z" }, dbUpdates, []), runner, "a1",
    );

    expect(dbUpdates).toHaveLength(0);
    expect(runner.emitMessage).not.toHaveBeenCalled();
  });
});
