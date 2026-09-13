import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { AgentStatusBar } from "./AgentStatusBar.js";
import { useSessionStore } from "../stores/session-store.js";

afterEach(() => {
  cleanup();
  useSessionStore.setState({ compacting: false });
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

  it("says the compaction instead of the activity while one runs (docs/178)", () => {
    useSessionStore.setState({ compacting: true });
    render(<AgentStatusBar activity={{ label: "Thinking..." }} />);
    expect(screen.getByText("Compacting context...")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("renders a spinner", () => {
    const { container } = render(<AgentStatusBar />);
    expect(container.querySelector(".spinner")).toBeInTheDocument();
  });
});
