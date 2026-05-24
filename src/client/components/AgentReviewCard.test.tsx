import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AgentReviewCard } from "./AgentReviewCard.js";

/**
 * Tests for the in-chat `AgentReviewCard` (docs/151). The card renders inline
 * in the chat at the point where the subagent finished a review. It's a thin
 * presentational component — no store reads, no fetching — so the tests focus
 * on labels and the open action.
 */

const BASE_PROPS = {
  reviewId: "rev-1",
  filePath: "docs/012-foo/plan.md",
  findingCount: 3,
  snapshotHash: "deadbeefcafef00d",
  createdAt: "2026-05-01T12:34:56Z",
};

afterEach(() => {
  cleanup();
});

describe("AgentReviewCard", () => {
  it("renders the file path, finding count, and 'Agent review' label", () => {
    render(<AgentReviewCard {...BASE_PROPS} />);
    expect(screen.getByText("docs/012-foo/plan.md")).toBeInTheDocument();
    expect(screen.getByText(/3 findings/)).toBeInTheDocument();
    expect(screen.getByText("Agent review")).toBeInTheDocument();
  });

  it("renders 'no findings' when findingCount is zero", () => {
    render(<AgentReviewCard {...BASE_PROPS} findingCount={0} />);
    expect(screen.getByText(/no findings/)).toBeInTheDocument();
  });

  it("singularizes the finding count when there is exactly one", () => {
    render(<AgentReviewCard {...BASE_PROPS} findingCount={1} />);
    expect(screen.getByText(/1 finding$/)).toBeInTheDocument();
  });

  it("renders the optional summary line when provided", () => {
    render(<AgentReviewCard {...BASE_PROPS} summary="The doc contradicts itself." />);
    expect(screen.getByText(/contradicts itself/)).toBeInTheDocument();
  });

  it("invokes onOpen with reviewId and filePath when Open is clicked", () => {
    const onOpen = vi.fn();
    render(<AgentReviewCard {...BASE_PROPS} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("rev-1", "docs/012-foo/plan.md");
  });

  it("disables the Open button when no onOpen handler is provided", () => {
    render(<AgentReviewCard {...BASE_PROPS} />);
    expect(screen.getByRole("button", { name: /open/i })).toBeDisabled();
  });
});
