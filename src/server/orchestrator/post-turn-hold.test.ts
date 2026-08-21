import { describe, it, expect } from "vitest";
import { PostTurnHold, POST_TURN_HOLD_MAX_MS } from "./post-turn-hold.js";

function withClock(): { hold: PostTurnHold; advance: (ms: number) => void } {
  let now = 1_000_000;
  return { hold: new PostTurnHold(() => now), advance: (ms) => { now += ms; } };
}

describe("PostTurnHold", () => {
  it("is inactive until a sequence begins", () => {
    const { hold } = withClock();
    expect(hold.active).toBe(false);
    hold.begin();
    expect(hold.active).toBe(true);
    hold.end();
    expect(hold.active).toBe(false);
  });

  // A retry hand-off (a 401 heal, a quota failover) leaves two live
  // `executeAgentTurn` closures over one runner. The outgoing one releasing must
  // not drop the incoming one's hold — which is why this counts.
  it("stays active until the LAST nested sequence ends", () => {
    const { hold } = withClock();
    hold.begin();
    hold.begin();
    hold.end();
    expect(hold.active).toBe(true);
    hold.end();
    expect(hold.active).toBe(false);
  });

  it("ignores an unbalanced end rather than underflowing", () => {
    const { hold } = withClock();
    hold.end();
    hold.end();
    hold.begin();
    expect(hold.active).toBe(true);
    hold.end();
    expect(hold.active).toBe(false);
  });

  // A leaked hold is strictly worse than the reclaim window it closes: the
  // session could never be reclaimed again. A sequence that never returns (a
  // wedged PR round-trip) stops counting as live work.
  it("expires so a hung sequence cannot pin the container forever", () => {
    const { hold, advance } = withClock();
    hold.begin();
    advance(POST_TURN_HOLD_MAX_MS - 1);
    expect(hold.active).toBe(true);
    advance(2);
    expect(hold.active).toBe(false);
  });

  it("re-arms the deadline on each begin", () => {
    const { hold, advance } = withClock();
    hold.begin();
    advance(POST_TURN_HOLD_MAX_MS - 1);
    hold.begin();
    advance(2);
    // The first sequence's deadline has passed; the second one's has not.
    expect(hold.active).toBe(true);
  });

  // A leaked hold stops COUNTING at its deadline, but the leaked depth survives
  // — so without forfeiting it, the next turn's `begin()` re-arms the deadline
  // over the stale depth and its matching `end()` unwinds only back to it. The
  // hold would then read active again with nobody holding it, and every later
  // turn would extend a lease nobody owns.
  it("forfeits an expired hold instead of letting later turns resurrect it", () => {
    const { hold, advance } = withClock();
    hold.begin();          // leaked — its `end()` never comes
    advance(POST_TURN_HOLD_MAX_MS + 1);
    expect(hold.active).toBe(false);

    // A later, well-behaved turn.
    hold.begin();
    expect(hold.active).toBe(true);
    hold.end();
    // Balanced, so the hold is genuinely free again — not pinned by the corpse
    // of the leaked one.
    expect(hold.active).toBe(false);
  });

  it("reset drops every hold (runner teardown)", () => {
    const { hold } = withClock();
    hold.begin();
    hold.begin();
    hold.reset();
    expect(hold.active).toBe(false);
  });
});
