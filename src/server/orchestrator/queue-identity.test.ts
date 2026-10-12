import { describe, it, expect } from "vitest";
import type { QueuedMessage } from "./session-runner.js";
import { nextSendOrder, queueEntryId, queueSnapshot, requeueInSendOrder } from "./queue-identity.js";

const entry = (text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({ text, execution: "interactive", ...extra });

function queueOwner(queue: QueuedMessage[], max = 50) {
  return {
    messageQueue: queue,
    enqueue: (m: QueuedMessage): number => {
      if (queue.length >= max) throw new Error("Message queue is full");
      queue.push(m);
      return queue.length;
    },
  };
}

describe("queueEntryId", () => {
  it("is the sender's request id when there is one", () => {
    expect(queueEntryId(entry("typed", { clientRequestId: "r1" }))).toBe("r1");
  });

  it("makes an id once, and names the entry by it from then on", () => {
    const e = entry("from a page");
    const id = queueEntryId(e);
    expect(queueEntryId(e)).toBe(id);
    expect(queueSnapshot([e])).toEqual([{ id, text: "from a page", position: 1 }]);
    expect(queueEntryId(entry("from a page"))).not.toBe(id);
  });
});

describe("requeueInSendOrder (planning#691)", () => {
  it("puts a refused message in front of one the user sent after it", () => {
    const refused = entry("A", { sendOrder: nextSendOrder() });
    const queue = [entry("B", { sendOrder: nextSendOrder() })];

    expect(requeueInSendOrder(queueOwner(queue), refused)).toBe(1);
    expect(queue.map((m) => m.text)).toEqual(["A", "B"]);
  });

  it("keeps the order of the user's messages when several are refused in any order", () => {
    const a = entry("A", { sendOrder: nextSendOrder() });
    const b = entry("B", { sendOrder: nextSendOrder() });
    const queue = [entry("C", { sendOrder: nextSendOrder() })];
    const owner = queueOwner(queue);

    expect(requeueInSendOrder(owner, b)).toBe(1);
    expect(requeueInSendOrder(owner, a)).toBe(1);
    expect(queue.map((m) => m.text)).toEqual(["A", "B", "C"]);
  });

  it("stays behind what was sent before it", () => {
    const earlier = entry("/compact", { sendOrder: nextSendOrder() });
    const refused = entry("A", { sendOrder: nextSendOrder() });
    const queue = [earlier];

    expect(requeueInSendOrder(queueOwner(queue), refused)).toBe(2);
    expect(queue.map((m) => m.text)).toEqual(["/compact", "A"]);
  });

  it("does not pass an entry whose send order is not known", () => {
    const refused = entry("A", { sendOrder: nextSendOrder() });
    const queue = [entry("a wake"), entry("B", { sendOrder: nextSendOrder() })];

    expect(requeueInSendOrder(queueOwner(queue), refused)).toBe(2);
    expect(queue.map((m) => m.text)).toEqual(["a wake", "A", "B"]);
  });

  it("refuses a full queue, as an enqueue does", () => {
    const queue = [entry("B", { sendOrder: nextSendOrder() })];
    expect(() => requeueInSendOrder(queueOwner(queue, 1), entry("A", { sendOrder: 0 }))).toThrow("full");
    expect(queue.map((m) => m.text)).toEqual(["B"]);
  });
});
