import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleReleaseCard } from "./release-card.js";
import type { HandlerContext } from "./types.js";
import type { WsReleaseCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (over: Partial<WsReleaseCard["card"]> = {}): WsReleaseCard => ({
  type: "release_card",
  sessionId: "s1",
  card: {
    sessionId: "s1",
    cardId: "release:s1:v0.3.0",
    phase: "proposed",
    version: "0.3.0",
    tag: "v0.3.0",
    prerelease: false,
    bumpType: "minor",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleReleaseCard (docs/171)", () => {
  it("appends a carrier message carrying the full snapshot", () => {
    handleReleaseCard(ctx, card());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      releaseCard: { cardId: "release:s1:v0.3.0", phase: "proposed" },
    });
  });

  it("upserts by cardId — a later phase patches the SAME message in place", () => {
    handleReleaseCard(ctx, card());
    handleReleaseCard(ctx, card({ phase: "gating" }));
    handleReleaseCard(ctx, card({ phase: "released" }));

    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].releaseCard?.phase).toBe("released");
  });

  it("is idempotent on a reconnect replay (same cardId, no duplicate)", () => {
    handleReleaseCard(ctx, card());
    handleReleaseCard(ctx, card()); // buffer replay re-delivers the same card
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("keeps distinct releases (different tag → different cardId) as separate cards", () => {
    handleReleaseCard(ctx, card());
    handleReleaseCard(ctx, card({ cardId: "release:s1:v0.4.0", tag: "v0.4.0", version: "0.4.0" }));
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });
});
