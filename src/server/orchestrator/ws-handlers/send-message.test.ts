import { describe, it, expect, vi } from "vitest";
import { recordActionChecklistSubmission, recordSessionStatusOffersTaken } from "./send-message.js";
import type { ActionChecklistCard, SessionInfo, SessionStatus } from "../../shared/types.js";
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

/**
 * These cover the helper. WHERE it is called from — the three acceptance points
 * in `handleSendMessage`, never before a refusal — is enforced by placement and
 * by the closure's own comment, not by a test: reaching those branches needs a
 * fake of most of the handler's context, and a fake that shape-drifts from the
 * real one would assert nothing. Forgetting a call fails safe, leaving the card
 * visible.
 */
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

/**
 * docs/303 req 17. WHERE this is called from — after each dispatch has been
 * taken, never before — is covered by
 * `integration_tests/session-status-offer-acceptance.test.ts`, which fills the
 * queue and watches the refusal.
 */
describe("recordSessionStatusOffersTaken", () => {
  function makeStatusCtx(stored: SessionStatus | undefined, written: SessionStatus[]) {
    return {
      getActiveAppSessionId: () => "s1",
      sseBroadcast: vi.fn(),
      sessionManager: {
        get: (id: string) => (id === "s1" ? { id, sessionStatus: stored } as SessionInfo : undefined),
        list: () => [],
        setSessionStatus: (_id: string, card: SessionStatus) => { written.push(card); },
      },
    } as never;
  }

  const stored: SessionStatus = {
    status: "Routes done",
    fresh: true,
    writeSeq: 3, turnSeq: 0,
    actions: [
      { id: "a", offerId: "o1", label: "Wire it", payload: "Wire it", offeredAt: "2026-09-14T10:00:00.000Z" },
      { id: "b", offerId: "o2", label: "Retry", payload: "Retry", offeredAt: "2026-09-14T10:00:00.000Z" },
    ],
  };

  it("marks the offers the message was composed from, and only those", async () => {
    const written: SessionStatus[] = [];
    recordSessionStatusOffersTaken(makeStatusCtx(stored, written), ["o2"]);
    await new Promise((r) => setImmediate(r));

    expect(written).toHaveLength(1);
    expect(written[0].actions.find((o) => o.offerId === "o1")?.takenAt).toBeUndefined();
    expect(written[0].actions.find((o) => o.offerId === "o2")?.takenAt).toBeTruthy();
  });

  it("writes nothing for a message that carried no offers", async () => {
    const written: SessionStatus[] = [];
    recordSessionStatusOffersTaken(makeStatusCtx(stored, written), undefined);
    recordSessionStatusOffersTaken(makeStatusCtx(stored, written), []);
    await new Promise((r) => setImmediate(r));

    expect(written).toHaveLength(0);
  });
});
