import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StarterPrompts } from "./StarterPrompts.js";

describe("StarterPrompts", () => {
  it("shows build/ship prompts when the session is not repo-backed", () => {
    render(<StarterPrompts repoBacked={false} onPick={() => {}} />);
    expect(screen.getByText("Build & deploy to Vercel")).toBeInTheDocument();
    expect(screen.queryByText("Explain this project")).not.toBeInTheDocument();
  });

  it("shows repo prompts when the session is repo-backed", () => {
    render(<StarterPrompts repoBacked onPick={() => {}} />);
    expect(screen.getByText("Explain this project")).toBeInTheDocument();
    expect(screen.queryByText("Build & deploy to Vercel")).not.toBeInTheDocument();
  });

  it("surfaces the ShipIt-specific bug-report hook in both variants", () => {
    const { rerender } = render(<StarterPrompts repoBacked={false} onPick={() => {}} />);
    expect(screen.getByText("Report a ShipIt bug")).toBeInTheDocument();
    rerender(<StarterPrompts repoBacked onPick={() => {}} />);
    expect(screen.getByText("Report a ShipIt bug")).toBeInTheDocument();
  });

  it("seeds the full prompt (not the short label) on click", () => {
    const onPick = vi.fn();
    render(<StarterPrompts repoBacked={false} onPick={onPick} />);
    fireEvent.click(screen.getByText("Build & deploy to Vercel"));
    expect(onPick).toHaveBeenCalledWith(
      "Build a personal landing page and deploy it to Vercel.",
    );
  });
});
