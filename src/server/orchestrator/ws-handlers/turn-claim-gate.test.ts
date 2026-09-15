import { describe, it, expect } from "vitest";
import { acquireTurnClaimGate, turnClaimGateKeyCount } from "./turn-claim-gate.js";

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("acquireTurnClaimGate (planning#575)", () => {
  it("admits one holder at a time, in the order the acquires were CALLED", async () => {
    const entered: string[] = [];
    const held: (() => void)[] = [];
    // Each waiter records itself when IT is admitted, so a gate that admitted
    // everyone at once would show up as all three names at the first assertion.
    const enter = async (name: string) => {
      const release = await acquireTurnClaimGate("s1");
      entered.push(name);
      held.push(release);
    };

    // One synchronous block, exactly as two WS frames reach the handler.
    const first = enter("first");
    const second = enter("second");
    const third = enter("third");

    await first;
    await settle(20);
    expect(entered).toEqual(["first"]);

    held[0]!();
    await second;
    await settle(20);
    expect(entered).toEqual(["first", "second"]);

    held[1]!();
    await third;
    expect(entered).toEqual(["first", "second", "third"]);
    held[2]!();
  });

  it("does not make one session wait for another", async () => {
    const holdA = await acquireTurnClaimGate("a");
    let enteredB = false;

    await (async () => {
      const release = await acquireTurnClaimGate("b");
      enteredB = true;
      release();
    })();

    expect(enteredB).toBe(true);
    holdA();
  });

  it("keeps no entry once the last holder has released", async () => {
    const before = turnClaimGateKeyCount();

    const release = await acquireTurnClaimGate("drops-its-key");
    expect(turnClaimGateKeyCount()).toBe(before + 1);
    release();
    await settle();

    expect(turnClaimGateKeyCount()).toBe(before);
  });

  it("treats a repeated release as a no-op rather than admitting two holders", async () => {
    const release = await acquireTurnClaimGate("s2");
    const queued = acquireTurnClaimGate("s2");
    release();
    release();

    const second = await queued;
    let thirdEntered = false;
    void (async () => {
      const r = await acquireTurnClaimGate("s2");
      thirdEntered = true;
      r();
    })();
    await settle(20);

    expect(thirdEntered).toBe(false);
    second();
  });
});
