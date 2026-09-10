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
    expect(hold.active).toBe(true);
  });

  it("forfeits an expired hold instead of letting later turns resurrect it", () => {
    const { hold, advance } = withClock();
    hold.begin();
    advance(POST_TURN_HOLD_MAX_MS + 1);
    expect(hold.active).toBe(false);

    hold.begin();
    expect(hold.active).toBe(true);
    hold.end();
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
