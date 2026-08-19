import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReasoningSelector } from "./ReasoningSelector.js";
import { saveReasoning } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import type { AgentOption } from "../agent-types.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(() => cleanup());
beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

const claude: AgentOption = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  hasRunnableModels: true,
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
  hasRunnableModels: true,
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

  // docs/260 — `compactTrigger` is gone for the same reason it is gone from the
  // harness selector: below 700px of composer width this control is not in the
  // row at all, so it never has to survive a width too small for its label.
  it("always shows the current level and names the knob for a screen reader", () => {
    render(<ReasoningSelector agent={claude} sessionReasoning="high" onChange={() => {}} />);
    const trigger = screen.getByTestId("reasoning-trigger");
    expect(trigger.textContent).toContain("High");
    expect(trigger).toHaveAttribute("title", "Reasoning: High");
    expect(trigger).toHaveAttribute("aria-label", "Reasoning selector");
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

/**
 * docs/274 req 14 — the picker follows the SELECTION, not the harness.
 *
 * Grok is the harness that makes this visible: it declares four levels and its
 * CLI drops `--reasoning-effort` before the wire on a key-billed row, so a
 * picker reading `capabilities.reasoning.options` would put four controls on
 * screen that change nothing. The selection is derived from the bound session,
 * so these drive the session store rather than a prop.
 */
describe("ReasoningSelector — levels follow the selection (docs/274 req 14)", () => {
  const grok: AgentOption = {
    id: "grok",
    name: "Grok Build",
    installed: true,
    hasRunnableModels: true,
    models: ["grok-4.6"],
    supportsReview: false,
    reasoning: {
      label: "Reasoning",
      options: [
        { value: "xhigh", label: "Extra high" },
        { value: "high", label: "High" },
      ],
    },
  };

  const bindSession = (billingMode: "sub" | "key", modelId = "grok-4.6") => {
    const session = {
      id: "s1",
      title: "t",
      createdAt: "2026-08-19T00:00:00.000Z",
      lastUsedAt: "2026-08-19T00:00:00.000Z",
      serviceId: "xai",
      billingMode,
      model: modelId,
    } as unknown as SessionInfo;
    useSessionStore.setState({ sessionId: "s1", sessions: [session] });
  };

  afterEach(() => useSessionStore.setState({ sessionId: undefined, sessions: [] }));

  it("renders nothing on a key-billed row, whose CLI discards the flag", () => {
    bindSession("key");
    const { container } = render(
      <ReasoningSelector agent={grok} sessionReasoning={undefined} onChange={() => {}} />,
    );
    // The harness DOES declare levels — what hides the control is the mode gate.
    expect(grok.reasoning?.options.length).toBeGreaterThan(0);
    expect(container.firstChild).toBeNull();
  });

  it("renders the row's own levels on the subscription", async () => {
    const user = userEvent.setup();
    bindSession("sub");
    render(<ReasoningSelector agent={grok} sessionReasoning={undefined} onChange={() => {}} />);
    await user.click(screen.getByTestId("reasoning-trigger"));
    expect(screen.getByText("Extra high")).toBeTruthy();
  });

  it("drops a level the row does not offer, without dropping the control", async () => {
    const user = userEvent.setup();
    // grok-4.5 is subscription-only and has no `xhigh` — the per-ROW narrowing,
    // which the mode gate alone could not express.
    bindSession("sub", "grok-4.5");
    render(<ReasoningSelector agent={grok} sessionReasoning={undefined} onChange={() => {}} />);
    await user.click(screen.getByTestId("reasoning-trigger"));
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.queryByText("Extra high")).toBeNull();
  });
});
