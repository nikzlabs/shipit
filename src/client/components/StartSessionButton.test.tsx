import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StartSessionButton } from "./StartSessionButton.js";

describe("StartSessionButton", () => {
  it("renders the default label and fires onClick", () => {
    const onClick = vi.fn();
    render(<StartSessionButton onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("supports a custom label and the disabled state", () => {
    const onClick = vi.fn();
    render(<StartSessionButton label="Start session from this issue" disabled onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /start session from this issue/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
