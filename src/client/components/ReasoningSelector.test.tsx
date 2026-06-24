import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReasoningSelector } from "./ReasoningSelector.js";
import { saveReasoning } from "../utils/local-storage.js";
import type { AgentOption } from "../agent-types.js";

afterEach(() => cleanup());
beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

const claude: AgentOption = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  authConfigured: true,
  models: ["claude-opus-4-8"],
  supportsReview: true,
  reasoning: {
    label: "Reasoning",
    options: [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
    ],
  },
};

const noReasoningAgent: AgentOption = {
  id: "other",
  name: "Other",
  installed: true,
  authConfigured: true,
  models: ["m"],
  supportsReview: false,
};

describe("ReasoningSelector (docs/217)", () => {
  it("renders nothing when the agent has no reasoning capability", () => {
    const { container } = render(
      <ReasoningSelector agent={noReasoningAgent} sessionReasoning={undefined} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no agent is active", () => {
    const { container } = render(
      <ReasoningSelector agent={undefined} sessionReasoning={undefined} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows 'Default' when nothing is selected", () => {
    render(<ReasoningSelector agent={claude} sessionReasoning={undefined} onChange={() => {}} />);
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Default");
  });

  it("reflects the persisted per-session value", () => {
    render(<ReasoningSelector agent={claude} sessionReasoning="high" onChange={() => {}} />);
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("High");
  });

  it("collapses the trigger to icon plus caret in compact mode", () => {
    render(
      <ReasoningSelector
        agent={claude}
        sessionReasoning="high"
        onChange={() => {}}
        compactTrigger
      />,
    );
    const trigger = screen.getByTestId("reasoning-trigger");
    expect(trigger.textContent).not.toContain("High");
    expect(trigger).toHaveAttribute("title", "Reasoning: High");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.querySelectorAll("svg")).toHaveLength(2);
  });

  it("falls back to the per-agent localStorage seed in the new-session composer", () => {
    // seedFromHistory=true previews the level the about-to-be-created session inherits.
    saveReasoning("claude", "max");
    render(
      <ReasoningSelector agent={claude} sessionReasoning={undefined} onChange={() => {}} seedFromHistory />,
    );
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Max");
  });

  it("does NOT bleed the localStorage seed into an active session at Default", () => {
    // The leak fix: an active session (seedFromHistory=false) genuinely at Default
    // shows "Default", not whatever level was last picked in another session.
    saveReasoning("claude", "max");
    render(<ReasoningSelector agent={claude} sessionReasoning={undefined} onChange={() => {}} />);
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Default");
  });

  it("prefers the session value over the localStorage seed", () => {
    saveReasoning("claude", "max");
    render(
      <ReasoningSelector agent={claude} sessionReasoning="low" onChange={() => {}} seedFromHistory />,
    );
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Low");
  });

  it("drops the optimistic pick when the active session changes (keyed remount)", async () => {
    const user = userEvent.setup();
    // Session A at Default; user optimistically picks Max. The call site keys the
    // selector on the session id, so a switch remounts it and the pick is dropped.
    const { rerender } = render(
      <ReasoningSelector key="A" agent={claude} sessionReasoning={undefined} onChange={() => {}} />,
    );
    await user.click(screen.getByTestId("reasoning-trigger"));
    await user.click(screen.getByTestId("reasoning-option-max"));
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Max");

    // Switch to session B (its own value is Low) — the A pick must not linger.
    rerender(
      <ReasoningSelector key="B" agent={claude} sessionReasoning="low" onChange={() => {}} />,
    );
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Low");
  });
});
