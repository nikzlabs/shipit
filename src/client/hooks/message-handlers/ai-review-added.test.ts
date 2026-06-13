import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleAiReviewAdded } from "./ai-review-added.js";
import type { HandlerContext } from "./types.js";
import type { WsAiReviewAdded } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsAiReviewAdded["card"]> = {}): WsAiReviewAdded => ({
  type: "ai_review_added",
  sessionId: "s1",
  card: {
    reviewId: "rev-1",
    filePath: "docs/plan.md",
    markdown: "1. `plan.md:42` — unspecified migration.",
    reviewerLabel: "Reviewed by Codex",
    createdAt: "2026-06-13T14:02:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleAiReviewAdded (docs/203)", () => {
  it("appends a marker message carrying the full review card", () => {
    handleAiReviewAdded(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      aiReview: { reviewId: "rev-1", reviewerLabel: "Reviewed by Codex" },
    });
  });

  it("upserts by reviewId — the re-review patches the SAME card in place", () => {
    handleAiReviewAdded(ctx, event());
    handleAiReviewAdded(
      ctx,
      event({ markdown: "No material issues found.", reReviewed: true }),
    );
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].aiReview).toMatchObject({
      reviewId: "rev-1",
      markdown: "No material issues found.",
      reReviewed: true,
    });
  });

  it("is idempotent on a reconnect-buffer replay (same card delivered twice)", () => {
    handleAiReviewAdded(ctx, event());
    handleAiReviewAdded(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the card already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", aiReview: event().card }],
    });
    handleAiReviewAdded(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
