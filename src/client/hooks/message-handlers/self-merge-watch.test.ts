import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSelfMergeWatchCard } from "./self-merge-watch.js";
import type { HandlerContext } from "./types.js";
import type { WsSelfMergeWatchCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsSelfMergeWatchCard["card"]> = {}): WsSelfMergeWatchCard => ({
  type: "self_merge_watch_card",
  sessionId: "s1",
  card: {
    cardId: "arm-1",
    watchId: "w1",
    prNumber: 43,
    prUrl: "https://github.com/o/r/pull/43",
    createdAt: "2026-10-10T00:00:00.000Z",
    ...over,
  },
});

const cards = () => useSessionStore.getState().messages.map((m) => m.selfMergeWatch);

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSelfMergeWatchCard (docs/239)", () => {
  it("appends the arm card once, also when a reconnect replays it", () => {
    handleSelfMergeWatchCard(ctx, event());
    handleSelfMergeWatchCard(ctx, event());
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.ended).toBeUndefined();
  });

  it("puts the end on the card that is already in the transcript, in its place", () => {
    handleSelfMergeWatchCard(ctx, event());
    handleSelfMergeWatchCard(ctx, event({ cardId: "arm-2", watchId: "w2", prNumber: 44 }));
    handleSelfMergeWatchCard(ctx, event({ ended: "replaced" }));

    expect(cards().map((c) => [c?.cardId, c?.ended])).toEqual([["arm-1", "replaced"], ["arm-2", undefined]]);
  });

  it("a replayed arm does not undo an end that history already delivered", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", selfMergeWatch: event({ ended: "merged" }).card }],
    });
    handleSelfMergeWatchCard(ctx, event());
    expect(cards()[0]?.ended).toBe("merged");
  });

  it("the first end stays, except that a started wake can still fail", () => {
    handleSelfMergeWatchCard(ctx, event({ ended: "merged" }));
    handleSelfMergeWatchCard(ctx, event({ ended: "replaced" }));
    expect(cards()[0]?.ended).toBe("merged");

    handleSelfMergeWatchCard(ctx, event({ ended: "wake-failed" }));
    handleSelfMergeWatchCard(ctx, event({ ended: "merged" }));
    expect(cards()[0]?.ended).toBe("wake-failed");
    expect(cards()).toHaveLength(1);
  });
});
