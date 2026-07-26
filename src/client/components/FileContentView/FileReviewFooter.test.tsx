import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileReviewFooter } from "./FileReviewFooter.js";

afterEach(cleanup);

const base = { commentCount: 2, history: [], onSend: vi.fn() };

describe("FileReviewFooter — send gating", () => {
  it("enables Send when there are draft comments and no open editor", () => {
    render(<FileReviewFooter {...base} canSend />);
    expect(screen.getByRole("button", { name: /Send 2 comments/ })).toBeEnabled();
    expect(screen.queryByText(/Finish the open comment/)).not.toBeInTheDocument();
  });

  it("disables Send and explains why while a comment is being written", () => {
    render(<FileReviewFooter {...base} canSend={false} composing />);
    const send = screen.getByRole("button", { name: /Send 2 comments/ });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", expect.stringContaining("open comment"));
    expect(screen.getByText(/Finish the open comment first/)).toBeInTheDocument();
  });
});
