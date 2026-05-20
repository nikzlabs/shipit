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
    sectionHeadings: overrides.sectionHeadings ?? [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sentAt: overrides.sentAt,
  };
}

function section(id: string, text: string, source: "human" | "ai" = "human"): ReviewComment {
  return { id, kind: "section", sectionHeading: "## A", sectionIndex: 0, text, source };
}

describe("composeReviewMessage", () => {
  it("always instructs delegation to a subagent and one atomic tool call", () => {
    const body = composeReviewMessage("docs/plan.md", null, []);
    expect(body).toContain("Review docs/plan.md.");
    expect(body).toContain("subagent");
    expect(body).toContain("Do not review it yourself.");
    expect(body).toContain("submit_review_comments");
    expect(body).toContain("empty array");
    // No comments block when there's nothing to embed.
    expect(body).not.toContain("Existing comments");
  });

  it("embeds draft comments verbatim, newest first", () => {
    const draft = review({ comments: [section("c1", "first note"), section("c2", "second note")] });
    const body = composeReviewMessage("plan.md", draft, []);
    expect(body).toContain("Existing comments on this file");
    expect(body).toContain("first note");
    expect(body).toContain("second note");
    // Newest first: c2 appears before c1.
    expect(body.indexOf("second note")).toBeLessThan(body.indexOf("first note"));
  });

  it("embeds only human comments from the most recent sent review (no AI feedback loop)", () => {
    const sent = review({
      id: "s0",
      status: "sent",
      sentAt: "2026-02-02T00:00:00Z",
      comments: [section("h1", "human kept"), section("a1", "ai prior", "ai")],
    });
    const body = composeReviewMessage("plan.md", null, [sent]);
    expect(body).toContain("human kept");
    expect(body).not.toContain("ai prior");
  });

  it("truncates long comments and notes when the cap drops some", () => {
    const many = Array.from({ length: 25 }, (_, i) => section(`c${i}`, `note ${i}`));
    const draft = review({ comments: many });
    const body = composeReviewMessage("plan.md", draft, []);
    // 25 drafts, cap 20 → 5 omitted.
    expect(body).toContain("5 older comments omitted");
  });

  it("truncates an over-long comment to 500 chars with an ellipsis", () => {
    const draft = review({ comments: [section("c1", "x".repeat(600))] });
    const body = composeReviewMessage("plan.md", draft, []);
    expect(body).toContain("…");
    expect(body).not.toContain("x".repeat(501));
  });
});
