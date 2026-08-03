import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SubAgentConsultCardRow } from "./SubAgentCards.js";
import type { SubAgentConsultCard } from "../../../../server/shared/types.js";

/**
 * docs/220 — the consult card surfaces the brokered sub-agent's verbatim output:
 * a summary line + a stripped-down preview, opening the full markdown in a
 * read-only dialog. When there is no output, it stays the compact one-liner.
 */
function card(over: Partial<SubAgentConsultCard> = {}): SubAgentConsultCard {
  return {
    cardId: "sac-1",
    spawnId: "spawn-1",
    subAgentId: "codex",
    status: "success",
    durationMs: 47000,
    costUsd: 0.03,
    createdAt: "2026-06-13T14:02:00.000Z",
    ...over,
  };
}

afterEach(cleanup);

describe("SubAgentConsultCardRow (docs/220)", () => {
  it("shows the summary + preview and opens the full output on click", () => {
    render(<SubAgentConsultCardRow card={card({ outputMarkdown: "Found 2 bugs in foo dot ts" })} />);

    // summary line is attributed to the consulted agent
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Consulted Codex");
    // stripped-down preview is visible inline
    expect(screen.getByTestId("sub-agent-consult-preview").textContent).toContain("Found 2 bugs");
    // full output is not mounted until the card is clicked
    expect(screen.queryByTestId("sub-agent-consult-output")).toBeNull();

    fireEvent.click(screen.getByTestId("sub-agent-consult-card"));
    expect(screen.getByTestId("sub-agent-consult-output").textContent).toContain("Found 2 bugs in foo dot ts");
  });

  it("renders a plain one-liner with no preview when there is no output", () => {
    render(<SubAgentConsultCardRow card={card({ status: "error", durationMs: 0, costUsd: 0 })} />);
    expect(screen.getByTestId("sub-agent-consult-card").textContent).toContain("Asked Codex");
    expect(screen.queryByTestId("sub-agent-consult-preview")).toBeNull();
    expect(screen.queryByTestId("sub-agent-consult-output")).toBeNull();
  });

  // SHI-278 — the same card also carries the DURABLE in-flight state, so a
  // backgrounded consult still shows up after a switch/reload/restart.
  it("renders the pending state as an in-progress row", () => {
    render(<SubAgentConsultCardRow card={card({ status: "pending", durationMs: undefined, costUsd: undefined })} />);
    const row = screen.getByTestId("sub-agent-consult-card");
    expect(row.textContent).toContain("Asking Codex");
    expect(row.textContent).toContain("in progress");
    expect(row.getAttribute("data-pending")).toBe("true");
  });
});
