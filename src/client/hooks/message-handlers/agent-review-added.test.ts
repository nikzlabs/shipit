import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { useFileReviewStore } from "../../stores/file-review-store.js";
import { handleAgentReviewAdded } from "./agent-review-added.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleAgentReviewAdded (docs/151)", () => {
  it("appends an assistant message carrying agentReview metadata", () => {
    handleAgentReviewAdded(ctx, {
      type: "agent_review_added",
      sessionId: "s1",
      filePath: "docs/012-foo/plan.md",
      reviewId: "rev-1",
      fileType: "markdown",
      snapshotHash: "deadbeef",
      findingCount: 3,
      summary: "The doc conflates X and Y.",
      createdAt: "2026-05-01T12:00:00Z",
    });

    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      agentReview: {
        reviewId: "rev-1",
        filePath: "docs/012-foo/plan.md",
        fileType: "markdown",
        findingCount: 3,
        snapshotHash: "deadbeef",
        summary: "The doc conflates X and Y.",
        createdAt: "2026-05-01T12:00:00Z",
      },
    });
  });

  it("omits the summary field when absent in the WS payload", () => {
    handleAgentReviewAdded(ctx, {
      type: "agent_review_added",
      sessionId: "s1",
      filePath: "docs/foo.md",
      reviewId: "rev-2",
      fileType: "markdown",
      snapshotHash: "h",
      findingCount: 0,
      createdAt: "2026-05-01T12:00:00Z",
    });
    const msg = useSessionStore.getState().messages[0]!;
    expect(msg.agentReview?.summary).toBeUndefined();
  });

  it("does NOT mutate the file-review-store (AI findings live in their own bucket post-docs/151)", () => {
    const before = JSON.stringify(useFileReviewStore.getState());
    handleAgentReviewAdded(ctx, {
      type: "agent_review_added",
      sessionId: "s1",
      filePath: "docs/foo.md",
      reviewId: "rev-3",
      fileType: "markdown",
      snapshotHash: "h",
      findingCount: 1,
      createdAt: "2026-05-01T12:00:00Z",
    });
    const after = JSON.stringify(useFileReviewStore.getState());
    expect(after).toEqual(before);
  });
});
