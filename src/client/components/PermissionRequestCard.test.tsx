import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PermissionRequestCard } from "./PermissionRequestCard.js";
import { usePermissionStore } from "../stores/permission-store.js";

/**
 * Tests for the in-chat `PermissionRequestCard` (docs/193 / planning#114), which
 * reads its payload + phase from the permission store keyed by requestId.
 *
 * The `details` disclosure exists because the card's `summary` is a clipped
 * one-liner (the broker cuts it at ~100 chars): for a `sed -i` the target path
 * — the very thing that explains why the backend gated the call — is what gets
 * cut, and the card was a plain non-interactive div with no way to see more.
 */

const REQUEST_ID = "perm_1";
const COMMAND = "sed -i 's/teh/the/' /workspace/src/server/session/agents/claude/adapter.ts";

beforeEach(() => {
  usePermissionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  usePermissionStore.getState().reset();
});

describe("PermissionRequestCard details disclosure", () => {
  const seedPending = (extra: Record<string, unknown> = {}) => {
    usePermissionStore.getState().upsertCard({
      requestId: REQUEST_ID,
      toolName: "Bash",
      summary: `Bash: ${COMMAND.slice(0, 97)}…`,
      ...extra,
    });
  };

  it("keeps the full gated command collapsed behind a toggle, then reveals it", () => {
    seedPending({ details: COMMAND });
    render(<PermissionRequestCard requestId={REQUEST_ID} />);

    expect(screen.queryByTestId("permission-details")).not.toBeInTheDocument();
    const toggle = screen.getByTestId("permission-details-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(screen.getByTestId("permission-details")).toHaveTextContent(COMMAND);
    expect(screen.getByTestId("permission-details-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("renders no toggle when the broker had nothing beyond the summary", () => {
    seedPending();
    render(<PermissionRequestCard requestId={REQUEST_ID} />);
    expect(screen.queryByTestId("permission-details-toggle")).not.toBeInTheDocument();
  });

  it("still offers approve/deny with the disclosure present", () => {
    seedPending({ details: COMMAND });
    render(<PermissionRequestCard requestId={REQUEST_ID} />);
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
    // Path-less (Bash) gates can't be remembered — the broker's allow-set is
    // keyed by resource path.
    expect(screen.queryByText("Approve & remember")).not.toBeInTheDocument();
  });
});
