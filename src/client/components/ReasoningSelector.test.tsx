import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

  it("collapses the trigger to the icon in compact mode", () => {
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
  });

  it("falls back to the per-agent localStorage seed when the session has none", () => {
    saveReasoning("claude", "max");
    render(<ReasoningSelector agent={claude} sessionReasoning={undefined} onChange={() => {}} />);
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Max");
  });

  it("prefers the session value over the localStorage seed", () => {
    saveReasoning("claude", "max");
    render(<ReasoningSelector agent={claude} sessionReasoning="low" onChange={() => {}} />);
    expect(screen.getByTestId("reasoning-trigger").textContent).toContain("Low");
  });
});
