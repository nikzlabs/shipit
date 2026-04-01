import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { AgentStatusBar } from "./AgentStatusBar.js";

afterEach(() => {
  cleanup();
});

describe("AgentStatusBar", () => {
  it("renders default 'Working...' when no activity is provided", () => {
    render(<AgentStatusBar />);
    expect(screen.getByText("Working...")).toBeInTheDocument();
  });

  it("renders the activity label when provided", () => {
    render(<AgentStatusBar activity={{ label: "Editing src/foo.ts", tool: "Edit" }} />);
    expect(screen.getByText("Editing src/foo.ts")).toBeInTheDocument();
  });

  it("renders a spinning icon", () => {
    const { container } = render(<AgentStatusBar />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });
});
