import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StarterPrompts } from "./StarterPrompts.js";

describe("StarterPrompts", () => {
  it("shows scratch/build prompts when the session is not repo-backed", () => {
    render(<StarterPrompts repoBacked={false} onPick={() => {}} />);
    expect(screen.getByText("Landing page for a coffee shop")).toBeInTheDocument();
    expect(screen.queryByText("Explain this project")).not.toBeInTheDocument();
  });

  it("shows repo prompts when the session is repo-backed", () => {
    render(<StarterPrompts repoBacked onPick={() => {}} />);
    expect(screen.getByText("Explain this project")).toBeInTheDocument();
    expect(screen.queryByText("Landing page for a coffee shop")).not.toBeInTheDocument();
  });

  it("seeds the full prompt (not the short label) on click", () => {
    const onPick = vi.fn();
    render(<StarterPrompts repoBacked={false} onPick={onPick} />);
    fireEvent.click(screen.getByText("A to-do app I can use"));
    expect(onPick).toHaveBeenCalledWith(
      "Build a to-do app where I can add, complete, and delete tasks.",
    );
  });
});
