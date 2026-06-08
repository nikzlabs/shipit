import { describe, it, expect } from "vitest";
import { composeReviewMessage } from "./compose-review-body.js";
import type { FileReview, ReviewComment } from "../../server/shared/types.js";

function review(overrides: Partial<FileReview>): FileReview {
  return {
    id: overrides.id ?? "r1",
    sessionId: overrides.sessionId ?? "s1",
    filePath: overrides.filePath ?? "plan.md",
    fileType: overrides.fileType ?? "markdown",
    status: overrides.status ?? "draft",
    comments: overrides.comments ?? [],
    docSnapshotHash: "h",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sentAt: overrides.sentAt,
  };
}

function selection(id: string, text: string, source: "human" | "ai" = "human"): ReviewComment {
  return {
    id,
    kind: "selection",
    quotedText: "anchored phrase",
    contextBefore: "",
    contextAfter: "",
    text,
    source,
  };
}

describe("composeReviewMessage", () => {
  it("always instructs delegation to a subagent and one atomic tool call", () => {
    const body = composeReviewMessage("docs/plan.md", null);
    expect(body).toContain("Review docs/plan.md.");
    expect(body).toContain("subagent");
    expect(body).toContain("Do not review it yourself.");
    expect(body).toContain("submit_review_comments");
    expect(body).toContain("empty array");
    expect(body).toContain("Submit every material finding");
    expect(body).not.toContain("at most 5 findings");
    expect(body).toContain("Prefer no comment over a weak comment");
    // No comments block when there's nothing to embed.
    expect(body).not.toContain("Existing comments");
  });

  it("bounds re-review instead of asking for an open-ended review loop", () => {
    const body = composeReviewMessage("docs/plan.md", null);
    expect(body).toContain("one fresh subagent to re-review");
    expect(body).toContain("Do not keep looping");
    expect(body).not.toContain("Repeat the review-fix-review loop until");
  });

  it("embeds draft comments verbatim, newest first", () => {
    const draft = review({ comments: [selection("c1", "first note"), selection("c2", "second note")] });
    const body = composeReviewMessage("plan.md", draft);
    expect(body).toContain("Existing comments on this file");
    expect(body).toContain("first note");
    expect(body).toContain("second note");
    // Newest first: c2 appears before c1.
    expect(body.indexOf("second note")).toBeLessThan(body.indexOf("first note"));
  });

  it("anchors each selection comment with its quoted text", () => {
    const draft = review({ comments: [selection("c1", "tighten this")] });
    const body = composeReviewMessage("plan.md", draft);
    expect(body).toContain("«anchored phrase»");
    expect(body).toContain("(selection, draft)");
  });

  it("embeds only un-sent draft comments, not already-sent ones", () => {
    // A sent comment is a turn the agent already received; re-embedding it just
    // repeats text the model has seen. The draft comment still rides along.
    const draft = review({ comments: [selection("d1", "still a draft")] });
    const body = composeReviewMessage("plan.md", draft);
    expect(body).toContain("still a draft");
    expect(body).toContain("(selection, draft)");
    // Sent reviews are no longer an input to the composer at all.
    expect(body).not.toContain("sent ");
  });

  // docs/151 — AI submissions no longer land in the human draft bucket, so the
  // embed defensively filters out any AI-source draft rows that pre-date the
  // sweep. Without this filter a stuck pre-migration draft would still
  // re-embed agent text into the next review.
  it("drops AI-source draft comments from the embed (docs/151)", () => {
    const draft = review({
      comments: [selection("h1", "human note"), selection("a1", "ai prior", "ai")],
    });
    const body = composeReviewMessage("plan.md", draft);
    expect(body).toContain("human note");
    expect(body).not.toContain("ai prior");
  });

  it("instructs the subagent to echo the tool response verbatim (docs/151)", () => {
    const body = composeReviewMessage("plan.md", null);
    expect(body).toContain("return the tool result verbatim");
  });

  it("truncates long comments and notes when the cap drops some", () => {
    const many = Array.from({ length: 25 }, (_, i) => selection(`c${i}`, `note ${i}`));
    const draft = review({ comments: many });
    const body = composeReviewMessage("plan.md", draft);
    // 25 drafts, cap 20 → 5 omitted.
    expect(body).toContain("5 older comments omitted");
  });

  it("truncates an over-long comment to 500 chars with an ellipsis", () => {
    const draft = review({ comments: [selection("c1", "x".repeat(600))] });
    const body = composeReviewMessage("plan.md", draft);
    expect(body).toContain("…");
    expect(body).not.toContain("x".repeat(501));
  });
});
