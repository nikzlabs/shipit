import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileReviewFooter } from "./FileReviewFooter.js";

afterEach(cleanup);

const base = { commentCount: 2, history: [], onSend: vi.fn() };

describe("FileReviewFooter — send gating", () => {
  it("enables Send when there are draft comments and no open editor", () => {
    render(<FileReviewFooter {...base} canSend />);
    expect(screen.getByRole("button", { name: /Send 2 comments/ })).toBeEnabled();
    expect(screen.getByText("2 comments — draft")).toBeInTheDocument();
    expect(screen.queryByText(/Finish your comment/)).not.toBeInTheDocument();
  });

  it("disables Send and explains why while a comment is being written", () => {
    render(<FileReviewFooter {...base} canSend={false} composing />);
    const send = screen.getByRole("button", { name: /Send 2 comments/ });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", expect.stringContaining("open comment"));
    expect(screen.getByText(/Finish your comment first/)).toBeInTheDocument();
  });

  it("puts the reason in the status slot instead of adding a third element", () => {
    // The footer is already at its width budget on a phone (Cancel + Send are
    // ~220px of a ~289px content box), so the composing state has to reuse the
    // draft-count slot rather than claim new horizontal space.
    const { container } = render(<FileReviewFooter {...base} canSend={false} composing />);
    expect(screen.queryByText(/comments — draft/)).not.toBeInTheDocument();
    expect(container.querySelectorAll("span.text-xs")).toHaveLength(1);
  });
});
