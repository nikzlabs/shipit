import { describe, it, expect, vi } from "vitest";
import type { WsServerMessage } from "../shared/types.js";
import type { AnswerHoldStore, QueuedMessage } from "./session-runner.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { nextSendOrder, queueSnapshot } from "./queue-identity.js";
import {
  isUsersOwnEntry,
  returnQueueOnStop,
  returnQueueSentBeforeStop,
  returnedMessages,
  takeReturnedMessages,
} from "./queue-return.js";

function fakeRunner(queue: QueuedMessage[] = []) {
  const emitted: WsServerMessage[] = [];
  const forgotten: number[] = [];
  return {
    sessionId: "s1",
    messageQueue: queue,
    answerHoldStore: {
      forgetHeldTurn: (id: number) => { forgotten.push(id); },
    } as unknown as AnswerHoldStore,
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    getQueueSnapshot: () => queueSnapshot(queue),
    emitted,
    forgotten,
  };
}

const typed = (text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  text,
  execution: "interactive",
  sendOrder: nextSendOrder(),
  ...extra,
});

const fromShipIt = (text: string, outcomes: TurnOutcome[], extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  text,
  execution: "dispatched",
  automatic: true,
  sendOrder: nextSendOrder(),
  onTurnComplete: (outcome) => { outcomes.push(outcome); },
  ...extra,
});

describe("a Stop empties the queue (docs/330-stop-returns-queued-messages)", () => {
  it("returns the user's messages in send order and removes ShipIt's entries (req 1, 2, 3)", () => {
    const outcomes: TurnOutcome[] = [];
    const first = typed("first", { clientRequestId: "m1" });
    const notice = fromShipIt("[merge] PR merged", outcomes, { heldId: 7 });
    const second = typed("second", { clientRequestId: "m2" });
    const runner = fakeRunner([second, notice, first]);

    expect(returnQueueOnStop(runner)).toBe(true);

    expect(runner.messageQueue).toEqual([]);
    expect(returnedMessages(runner)).toEqual([
      { id: "m1", text: "first" },
      { id: "m2", text: "second" },
    ]);
    expect(outcomes).toEqual([
      { status: "dropped", errored: true, detail: "stopped by the user" },
    ]);
    expect(runner.forgotten).toEqual([7]);
    expect(runner.emitted).toEqual([{
      type: "queue_updated",
      sessionId: "s1",
      queue: [],
      returned: [{ id: "m1", text: "first" }, { id: "m2", text: "second" }],
    }]);
  });

  it("returns a message with its file references and its uploads, each path one time", () => {
    const runner = fakeRunner([
      typed("look at these", {
        clientRequestId: "m1",
        files: [{ path: "src/a.ts" }, { path: "/uploads/shot.png" }],
        uploads: [{ path: "/uploads/shot.png", type: "upload" }, { path: "/uploads/b.pdf", type: "upload" }],
        uploadPaths: ["/uploads/b.pdf", "/uploads/c.png"],
      }),
    ]);

    returnQueueOnStop(runner);

    expect(returnedMessages(runner)).toEqual([{
      id: "m1",
      text: "look at these",
      files: [
        { path: "src/a.ts" },
        { path: "/uploads/shot.png" },
        { path: "/uploads/b.pdf" },
        { path: "/uploads/c.png" },
      ],
    }]);
  });

  it("says nothing and reports false when the queue is empty", () => {
    const runner = fakeRunner();
    expect(returnQueueOnStop(runner)).toBe(false);
    expect(runner.emitted).toEqual([]);
  });

  it("keeps the messages of an earlier Stop until an input box has them", () => {
    const runner = fakeRunner([typed("first", { clientRequestId: "m1" })]);
    returnQueueOnStop(runner);
    runner.messageQueue.push(typed("second", { clientRequestId: "m2" }));
    returnQueueOnStop(runner);
    expect(returnedMessages(runner).map((m) => m.id)).toEqual(["m1", "m2"]);

    takeReturnedMessages(runner, ["m1", "unknown"]);
    expect(returnedMessages(runner).map((m) => m.id)).toEqual(["m2"]);
    takeReturnedMessages(runner, ["m2"]);
    expect(returnedMessages(runner)).toEqual([]);
  });
});

describe("which entry is a message of the user's", () => {
  it.each<[string, Partial<QueuedMessage>, boolean]>([
    ["a typed message", {}, true],
    ["a typed command", { text: "/compact" }, true],
    ["an automatic entry", { automatic: true }, false],
    ["a message from another session", { messageOrigin: { sessionId: "p", sessionTitle: "P", relation: "parent" } }, false],
    ["a dispatched entry", { execution: "dispatched" }, false],
    ["a dispatch that was steered and put back", { steeredDispatch: true }, false],
  ])("%s", (_name, extra, own) => {
    expect(isUsersOwnEntry({ text: "x", execution: "interactive", ...extra })).toBe(own);
  });
});

describe("an entry that was sent before the Stop and enters the queue after it", () => {
  it("leaves by the same rule, and an entry that was sent after the Stop stays", () => {
    const outcomes: TurnOutcome[] = [];
    const steer = typed("an earlier steer", { clientRequestId: "m1" });
    const oldNotice = fromShipIt("old notice", outcomes);
    const runner = fakeRunner();
    returnQueueOnStop(runner);
    const redirect = typed("the redirect", { clientRequestId: "m2" });
    const noOrder: QueuedMessage = { text: "restored", execution: "dispatched", automatic: true };
    runner.messageQueue.push(redirect, steer, oldNotice, noOrder);

    returnQueueSentBeforeStop(runner);

    expect(runner.messageQueue).toEqual([redirect, noOrder]);
    expect(returnedMessages(runner)).toEqual([{ id: "m1", text: "an earlier steer" }]);
    expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
    expect(runner.emitted.at(-1)).toMatchObject({ type: "queue_updated", returned: [{ id: "m1" }] });
  });

  it("does nothing on a runner that was never stopped", () => {
    const entry = typed("waits");
    const runner = fakeRunner([entry]);
    const emit = vi.spyOn(runner, "emitMessage");

    returnQueueSentBeforeStop(runner);

    expect(runner.messageQueue).toEqual([entry]);
    expect(emit).not.toHaveBeenCalled();
  });
});
