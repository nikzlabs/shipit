import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttentionViewToggle } from "./AttentionViewToggle.js";

afterEach(cleanup);

const control = () => screen.getByRole("button");

describe("AttentionViewToggle", () => {
  it("announces the view it switches TO, with the count", () => {
    render(<AttentionViewToggle active={false} count={4} onToggle={vi.fn()} />);
    expect(control().getAttribute("aria-label")).toBe("Show sessions that need you (4)");
    expect(control().getAttribute("aria-pressed")).toBe("false");
    expect(control().textContent).toBe("4");
  });

  it("drops the count from the label when nothing needs attention", () => {
    render(<AttentionViewToggle active={false} count={0} onToggle={vi.fn()} />);
    expect(control().getAttribute("aria-label")).toBe("Show sessions that need you");
    expect(control().textContent).toBe("");
  });

  it("reads as pressed in the second view, and still carries the count (req 5)", () => {
    render(<AttentionViewToggle active count={2} onToggle={vi.fn()} />);
    expect(control().getAttribute("aria-pressed")).toBe("true");
    // The count is on the chip for the eye and in the label for the ear.
    expect(control().getAttribute("aria-label")).toBe("Show all sessions (2 need you)");
    expect(control().textContent).toBe("2");
  });

  it("colours glyph and count from --color-attention-text, never the marker amber", () => {
    // req 16 — the marker amber fails AA as small text on light themes, and the
    // contrast guard only protects the token that is actually used here.
    const { container } = render(<AttentionViewToggle active count={9} onToggle={vi.fn()} />);
    expect(container.innerHTML).toContain("--color-attention-text");
    expect(container.innerHTML).not.toContain("(--color-attention)");
  });

  it("calls back on click", async () => {
    const onToggle = vi.fn();
    render(<AttentionViewToggle active={false} count={1} onToggle={onToggle} />);
    await userEvent.click(control());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
