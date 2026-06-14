import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { EgressPromptCard } from "./EgressPromptCard.js";
import { useEgressPromptStore } from "../stores/egress-prompt-store.js";

/**
 * Tests for the in-chat `EgressPromptCard` (docs/172, SHI-90). The card reads
 * its live host + phase from the egress-prompt store keyed by cardId.
 */

const CARD_ID = "egress-sess-1-cdn.example.com";

beforeEach(() => {
  useEgressPromptStore.getState().reset();
  useEgressPromptStore.getState().upsertCard({ cardId: CARD_ID, host: "cdn.example.com" });
});

afterEach(() => {
  cleanup();
  useEgressPromptStore.getState().reset();
});

describe("EgressPromptCard", () => {
  it("renders the blocked host and the three choices while pending", () => {
    render(<EgressPromptCard cardId={CARD_ID} />);
    expect(screen.getByText("cdn.example.com")).toBeInTheDocument();
    expect(screen.getByText("Allow once")).toBeInTheDocument();
    expect(screen.getByText("Add to allowlist")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("fires onDecide with the chosen action and host", () => {
    const onDecide = vi.fn();
    render(<EgressPromptCard cardId={CARD_ID} onDecide={onDecide} />);
    fireEvent.click(screen.getByText("Add to allowlist"));
    expect(onDecide).toHaveBeenCalledWith(CARD_ID, "cdn.example.com", "add");
  });

  it("renders a terminal state (no buttons) once resolved", () => {
    useEgressPromptStore.getState().setPhase(CARD_ID, "allowed-once");
    render(<EgressPromptCard cardId={CARD_ID} />);
    expect(screen.getByText("Allowed once")).toBeInTheDocument();
    expect(screen.queryByText("Allow once")).not.toBeInTheDocument();
  });

  it("renders nothing for an unknown card id", () => {
    const { container } = render(<EgressPromptCard cardId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });
});
