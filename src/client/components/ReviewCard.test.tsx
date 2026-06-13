import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ReviewCard } from "./ReviewCard.js";
import type { AiReviewCard } from "../../server/shared/types.js";

/**
 * Tests for the plain-text `ReviewCard` (docs/203). Renders straight from its
 * props — no store, no lifecycle. Covers the header (file + reviewer label),
 * the collapse toggle, the clean-review short-circuit, and the degraded legacy
 * render.
 */

function card(over: Partial<AiReviewCard> = {}): AiReviewCard {
  return {
    reviewId: "rev-1",
    filePath: "docs/plan.md",
    markdown: "1. `plan.md:42` — unspecified migration.\n   Fix: keep the column readable.",
    reviewerLabel: "Reviewed by Codex",
    createdAt: "2026-06-13T14:02:00.000Z",
    ...over,
  };
}

afterEach(cleanup);

describe("ReviewCard (docs/203)", () => {
  it("renders the file path and reviewer label, with markdown findings expanded by default", () => {
    render(<ReviewCard card={card()} />);
    expect(screen.getByText("docs/plan.md")).toBeInTheDocument();
    expect(screen.getByText("Reviewed by Codex")).toBeInTheDocument();
    expect(screen.getByText(/unspecified migration/)).toBeInTheDocument();
  });

  it("collapses and re-expands the findings when the header is clicked", () => {
    render(<ReviewCard card={card()} />);
    expect(screen.getByText(/unspecified migration/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/unspecified migration/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/unspecified migration/)).toBeInTheDocument();
  });

  it("shows a clean-review affordance for 'No material issues found.'", () => {
    render(<ReviewCard card={card({ markdown: "No material issues found." })} />);
    expect(screen.getByText("No material issues found.")).toBeInTheDocument();
  });

  it("renders a re-reviewed marker", () => {
    render(<ReviewCard card={card({ reReviewed: true })} />);
    expect(screen.getByText(/re-reviewed/)).toBeInTheDocument();
  });

  it("degrades a legacy card to file + finding count + 'Reviewed earlier' note", () => {
    render(
      <ReviewCard
        card={card({ legacy: true, findingCount: 3, markdown: "", reviewerLabel: "Reviewed earlier" })}
      />,
    );
    expect(screen.getByText("Reviewed earlier")).toBeInTheDocument();
    expect(screen.getByText(/3 findings/)).toBeInTheDocument();
    expect(screen.getByText(/no longer shown/)).toBeInTheDocument();
  });
});
